import { create } from 'zustand'
import { t } from '@/i18n'
import { chaptersApi, projectsApi, suspendProjectApiRequests } from '@/lib/api'
import { discardProjectCharacterChanges, retireStaleProjectCharacterInstance } from '@/lib/characterSaveQueue'
import { discardProjectEditorSaves, retireStaleProjectEditorSaves } from '@/lib/editorSaveQueue'
import {
  createProjectFallbackSummary,
  type ProjectSummaryRecord,
  upsertProjectFallback,
} from '@/lib/projectCreationFallback'
import { removeDeletedProject } from '@/lib/projectDeletion'
import { discardProjectDraftRecoveries } from '@/lib/projectDraftRecovery'
import { deleteCapturedProjectInstance, finalizeCapturedProjectDeletion } from '@/lib/projectInstanceDeletion'
import {
  getProjectInstanceId,
  type ProjectInstanceChange,
  rememberProjectInstance,
  replaceProjectInstances,
} from '@/lib/projectInstanceRegistry'
import { createRequestCommitTracker } from '@/lib/requestCommitTracker'
import { retireProjectRevisionMutations } from '@/lib/revisionMutationReconciliation'
import { discardProjectTitleSaves, retireStaleProjectTitleSaves } from '@/lib/titleSaveQueue'
import { retireAgentProjectState } from '@/stores/useAgentStore'
import { useChapterStore } from '@/stores/useChapterStore'
import { useSidebarStore } from '@/stores/useSidebarStore'
import type { WorkflowPhase } from '@/types'

type ProjectSummary = ProjectSummaryRecord

interface ProjectState {
  currentProject: string | null
  projects: ProjectSummary[]
  showProjectList: boolean
  loading: boolean
  error: string | null
  workflowPhase: WorkflowPhase
  setCurrentProject: (name: string | null) => void
  toggleProjectList: () => void
  showProjectListFn: () => void
  hideProjectList: () => void
  loadProjects: () => Promise<void>
  loadPhase: (project: string) => Promise<void>
  setPhase: (project: string, phase: WorkflowPhase) => Promise<void>
  createProject: (name: string, opts?: { mode?: string; language?: string; genres?: string[] }) => Promise<void>
  deleteProject: (name: string) => Promise<void>
}

const projectListRequests = createRequestCommitTracker('projects')
const phaseRequests = createRequestCommitTracker('')

function retireProjectInstanceState(change: ProjectInstanceChange): void {
  const { project, previousInstanceId } = change
  // Project names are reusable. Retire every name/id-keyed snapshot as soon
  // as a different immutable instance is observed, before its workspace can
  // render or create the deterministic first chapter ID.
  retireStaleProjectEditorSaves(project, previousInstanceId)
  retireStaleProjectTitleSaves(project, previousInstanceId)
  useChapterStore.getState().discardProjectState(project)
  retireStaleProjectCharacterInstance(project)
  retireProjectRevisionMutations(project, previousInstanceId)
  retireAgentProjectState(project, previousInstanceId)
  phaseRequests.invalidate(project)
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  projects: [],
  showProjectList: false,
  loading: false,
  error: null,
  workflowPhase: 'idea',

  setCurrentProject: (name) => {
    const previousProject = get().currentProject
    if (previousProject !== name && previousProject) retireAgentProjectState(previousProject)
    localStorage.setItem('mythpen-current-project', name || '')
    // A key change advances the request epoch. In particular, A -> B -> A
    // cannot revive a phase response from the previous A activation.
    phaseRequests.activate(name || '')
    set({ currentProject: name, showProjectList: false })
    useChapterStore.getState().activateProject(name)
  },

  toggleProjectList: () => set((s) => ({ showProjectList: !s.showProjectList })),
  showProjectListFn: () => set({ showProjectList: true }),
  hideProjectList: () => set({ showProjectList: false }),

  loadProjects: async () => {
    const projectListRequest = projectListRequests.start('projects')
    if (!projectListRequest) return
    set({ loading: true, error: null })
    try {
      const listedProjects = await projectsApi.list()
      if (!projectListRequests.claimSuccess(projectListRequest)) return
      const instanceChanges = replaceProjectInstances(listedProjects)
      for (const change of instanceChanges) {
        retireProjectInstanceState(change)
      }
      const projects = listedProjects.map((project: ProjectSummary) => ({
        ...project,
        // A temporarily unreadable fallback row can omit the token. Mirror the
        // registry's fail-closed last-known value into reactive UI state.
        instanceId: project.instanceId || getProjectInstanceId(project.name),
      }))
      // Restore last selected project
      const saved = localStorage.getItem('mythpen-current-project')
      const currentProject = projects.find((p: any) => p.name === saved) ? saved : projects[0]?.name || null
      const previousProject = get().currentProject
      if (previousProject !== currentProject && previousProject) retireAgentProjectState(previousProject)
      // No projects → show the project list (new user / all deleted)
      const showProjectList = projects.length === 0
      phaseRequests.activate(currentProject || '')
      set({ projects, currentProject, showProjectList, loading: false })
      useChapterStore.getState().activateProject(currentProject)
      // Load phase for the current project
      if (currentProject) {
        const phaseRequest = phaseRequests.start(currentProject)
        if (!phaseRequest) return
        try {
          const { phase } = await projectsApi.getPhase(currentProject)
          if (get().currentProject === currentProject && phaseRequests.claimSuccess(phaseRequest)) {
            set({ workflowPhase: phase as WorkflowPhase })
          }
        } catch (err) {
          if (get().currentProject === currentProject && phaseRequests.isLatest(phaseRequest)) {
            set({ error: (err as any).message, loading: false, showProjectList: true })
          }
        }
      }
    } catch (err) {
      if (projectListRequests.isLatest(projectListRequest)) {
        set({ error: (err as any).message, loading: false, showProjectList: true })
      }
    }
  },

  loadPhase: async (project) => {
    if (get().currentProject !== project) return
    phaseRequests.activate(project)
    const request = phaseRequests.start(project)
    if (!request) return
    try {
      const { phase } = await projectsApi.getPhase(project)
      if (get().currentProject === project && phaseRequests.claimSuccess(request)) {
        set({ workflowPhase: phase as WorkflowPhase })
      }
    } catch {
      /* ignore */
    }
  },

  setPhase: async (project, phase) => {
    const isActiveProject = get().currentProject === project
    if (isActiveProject) phaseRequests.activate(project)
    const request = isActiveProject ? phaseRequests.start(project) : null
    try {
      await projectsApi.setPhase(project, phase)
      if (request && get().currentProject === project && phaseRequests.claimSuccess(request)) {
        set({ workflowPhase: phase })
      }
    } catch {
      /* ignore */
    }
  },

  createProject: async (name, opts = {}) => {
    const { mode = 'medium-novel', language = 'zh', genres = ['sci-fi', 'romance'] } = opts
    set({ loading: true, error: null })
    try {
      // 1. Create the project
      const createdProject = await projectsApi.create({ name, mode, language, genres })
      // A list read that started before creation must not erase the new token
      // or hide the new project if the follow-up authority read fails.
      projectListRequests.invalidate('projects')
      const instanceChange = rememberProjectInstance(name, createdProject.instanceId)
      // An externally removed project can be recreated from this client before
      // any intervening list refresh. In that path rememberProjectInstance is
      // the first observer of the new incarnation, so it must trigger the same
      // retirement as an authoritative list rotation.
      if (instanceChange) retireProjectInstanceState(instanceChange)

      // Make the create response reactive before the follow-up list read. If
      // that read fails, the selected project still has a matching list row
      // and immutable instance token instead of a half-initialized workspace.
      const provisionalProject = createProjectFallbackSummary(name, createdProject, { mode, genres })
      set((state) => ({
        projects: upsertProjectFallback(state.projects, provisionalProject),
      }))

      // 2. Auto-create Chapter 1 so user can start writing immediately
      await chaptersApi.create(name, { title: t('chapter.firstChapterTitle') })

      // 3. Reload project list & set current
      await useProjectStore.getState().loadProjects()
      phaseRequests.activate(name)
      set({ currentProject: name, showProjectList: false, loading: false, error: null, workflowPhase: 'idea' })
      useChapterStore.getState().activateProject(name)

      // 4. Load chapters into sidebar & navigate to Writing page
      await useChapterStore.getState().loadChapters(name)
      useSidebarStore.getState().setActivePage('page-writing')
    } catch (err) {
      set({ error: (err as any).message || t('project.createFailed'), loading: false })
      throw err
    }
  },

  deleteProject: async (name) => {
    const expectedInstanceId = getProjectInstanceId(name)
    if (!expectedInstanceId) {
      set({ error: '项目实例尚未加载，已取消删除', loading: false })
      return
    }
    set({ loading: true, error: null })
    // Stop any new request for this project name, then let already-started
    // writes finish before DELETE. This closes the window in which an old
    // autosave could arrive after deletion and target a same-name replacement.
    const requestSuspension = suspendProjectApiRequests(name)
    try {
      await deleteCapturedProjectInstance(
        name,
        expectedInstanceId,
        requestSuspension.waitForInflight,
        (capturedInstanceId) => projectsApi.delete(name, capturedInstanceId),
      )
      if (!finalizeCapturedProjectDeletion(name, expectedInstanceId)) {
        // DELETE was scoped to the captured old instance. A replacement that
        // appeared while it was in flight is authoritative and must stay.
        set({ loading: false })
        return
      }
      // A project-list response that started before the DELETE may still
      // contain this name. Retire it before changing local state or starting
      // the post-delete refresh.
      projectListRequests.invalidate('projects')
      // A project name can be reused. Once deletion succeeds, retire every
      // process-wide/durable draft keyed by that name before a replacement can
      // load and accidentally inherit it.
      discardProjectEditorSaves(name)
      discardProjectTitleSaves(name)
      discardProjectDraftRecoveries(name)
      discardProjectCharacterChanges(name)
      retireProjectRevisionMutations(name, expectedInstanceId)
      useChapterStore.getState().discardProjectState(name)

      // Do not depend on the follow-up GET succeeding to leave the deleted
      // project. Its cached list is still the safest fallback for every other
      // project, but the deleted entry itself must disappear synchronously.
      const transition = removeDeletedProject(get().projects, get().currentProject, name)
      if (transition.deletedCurrentProject) {
        retireAgentProjectState(name, expectedInstanceId)
        localStorage.setItem('mythpen-current-project', transition.currentProject || '')
        phaseRequests.activate(transition.currentProject || '')
      }
      set((state) => ({
        projects: transition.projects,
        currentProject: transition.currentProject,
        showProjectList: transition.projects.length === 0 ? true : state.showProjectList,
        workflowPhase: transition.deletedCurrentProject ? 'idea' : state.workflowPhase,
      }))
      if (transition.deletedCurrentProject) {
        useChapterStore.getState().activateProject(transition.currentProject)
      }

      await useProjectStore.getState().loadProjects()
    } catch (err) {
      set({ error: (err as any).message || t('project.deleteFailed'), loading: false })
    } finally {
      requestSuspension.release()
    }
  },
}))

export type { ProjectState, ProjectSummary }
