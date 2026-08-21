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
import {
  createProjectForStorage,
  DEFAULT_PROJECT_STORAGE,
  initialChapterForStorage,
  type ProjectStorage,
} from '@/lib/projectCreationStorage'
import { removeDeletedProject } from '@/lib/projectDeletion'
import { discardProjectDraftRecoveries } from '@/lib/projectDraftRecovery'
import { deleteCapturedProjectInstance, finalizeCapturedProjectDeletion } from '@/lib/projectInstanceDeletion'
import {
  getProjectInstanceId,
  type ProjectInstanceChange,
  rememberProjectInstance,
  replaceProjectInstances,
} from '@/lib/projectInstanceRegistry'
import {
  chooseProjectAfterList,
  normalizeProjectOpenFields,
  projectSelectionTransition,
  selectReadyFallback,
} from '@/lib/projectRecovery'
import { createRequestCommitTracker } from '@/lib/requestCommitTracker'
import { retireProjectRevisionMutations } from '@/lib/revisionMutationReconciliation'
import { discardProjectTitleSaves, retireStaleProjectTitleSaves } from '@/lib/titleSaveQueue'
import { retireAgentProjectState } from '@/stores/useAgentStore'
import { useChapterStore } from '@/stores/useChapterStore'
import { useSidebarStore } from '@/stores/useSidebarStore'
import type { WorkflowPhase } from '@/types'

type ProjectSummary = ProjectSummaryRecord

interface ProjectListLoadOptions {
  shouldCommit?: () => boolean
}

interface ProjectState {
  currentProject: string | null
  recoveryTarget: string | null
  projects: ProjectSummary[]
  showProjectList: boolean
  loading: boolean
  error: string | null
  workflowPhase: WorkflowPhase
  setCurrentProject: (name: string | null) => void
  completeRecoveredProject: (name: string) => void
  toggleProjectList: () => void
  showProjectListFn: () => void
  hideProjectList: () => void
  loadProjects: (options?: ProjectListLoadOptions) => Promise<void>
  loadPhase: (project: string) => Promise<void>
  setPhase: (project: string, phase: WorkflowPhase) => Promise<void>
  createProject: (
    name: string,
    opts?: { mode?: string; language?: string; genres?: string[]; storage?: ProjectStorage },
  ) => Promise<void>
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
  recoveryTarget: null,
  projects: [],
  showProjectList: false,
  loading: false,
  error: null,
  workflowPhase: 'idea',

  setCurrentProject: (name) => {
    if (name === null) {
      const previousProject = get().currentProject
      if (previousProject) retireAgentProjectState(previousProject)
      localStorage.setItem('mythpen-current-project', '')
      phaseRequests.activate('')
      set({ currentProject: null, recoveryTarget: null, showProjectList: false })
      useChapterStore.getState().activateProject(null)
      return
    }

    const project = get().projects.find((candidate) => candidate.name === name) ?? { name }
    const transition = projectSelectionTransition(project, get().currentProject)
    if (!transition.activateWorkspace) {
      set({ recoveryTarget: transition.recoveryTarget, showProjectList: false })
      return
    }

    const previousProject = get().currentProject
    if (previousProject !== name && previousProject) retireAgentProjectState(previousProject)
    localStorage.setItem('mythpen-current-project', name)
    // A key change advances the request epoch. In particular, A -> B -> A
    // cannot revive a phase response from the previous A activation.
    phaseRequests.activate(name || '')
    set({ currentProject: name, recoveryTarget: null, showProjectList: false })
    useChapterStore.getState().activateProject(name)
  },

  completeRecoveredProject: (name) => {
    if (get().recoveryTarget !== name) return
    const project = get().projects.find((candidate) => candidate.name === name)
    if (!project || normalizeProjectOpenFields(project).openState !== 'ready') return
    get().setCurrentProject(name)
  },

  toggleProjectList: () =>
    set((state) =>
      state.showProjectList ? { showProjectList: false } : { showProjectList: true, recoveryTarget: null },
    ),
  showProjectListFn: () => set({ showProjectList: true, recoveryTarget: null }),
  hideProjectList: () => set({ showProjectList: false }),

  loadProjects: async (options = {}) => {
    const projectListRequest = projectListRequests.start('projects')
    if (!projectListRequest) return
    set({ loading: true, error: null })
    try {
      const listedProjects = (await projectsApi.list()) as ProjectSummary[]
      if (options.shouldCommit && !options.shouldCommit()) {
        if (projectListRequests.isLatest(projectListRequest)) set({ loading: false })
        return
      }
      if (!projectListRequests.claimSuccess(projectListRequest)) return
      const normalizedProjects = listedProjects.map((project) => ({
        ...project,
        ...normalizeProjectOpenFields(project),
      }))
      const readyProjects = normalizedProjects.filter((project) => project.openState === 'ready')
      const instanceChanges = replaceProjectInstances(readyProjects)
      for (const change of instanceChanges) {
        retireProjectInstanceState(change)
      }
      const projects = normalizedProjects.map((project) => ({
        ...project,
        instanceId:
          project.openState === 'ready' ? project.instanceId || getProjectInstanceId(project.name) : undefined,
      }))
      const saved = localStorage.getItem('mythpen-current-project')
      const previousState = get()
      const currentProject = chooseProjectAfterList(projects, {
        savedProject: saved,
        currentProject: previousState.currentProject,
        recoveryTarget: previousState.recoveryTarget,
      })
      const previousProject = previousState.currentProject
      if (previousProject !== currentProject && previousProject) retireAgentProjectState(previousProject)
      if (previousProject !== currentProject) {
        phaseRequests.activate(currentProject || '')
        useChapterStore.getState().activateProject(currentProject)
      }
      const showProjectList = previousState.recoveryTarget ? false : currentProject === null
      set({ projects, currentProject, showProjectList, loading: false })

      if (currentProject && !previousState.recoveryTarget) {
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
      if (options.shouldCommit && !options.shouldCommit()) {
        if (projectListRequests.isLatest(projectListRequest)) set({ loading: false })
        return
      }
      if (projectListRequests.isLatest(projectListRequest)) {
        set({
          error: (err as any).message,
          loading: false,
          showProjectList: get().recoveryTarget ? false : true,
        })
      }
    }
  },

  loadPhase: async (project) => {
    const state = get()
    if (
      state.currentProject !== project ||
      state.recoveryTarget ||
      normalizeProjectOpenFields(state.projects.find((candidate) => candidate.name === project) ?? {}).openState !==
        'ready'
    )
      return
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
    const state = get()
    const isActiveProject =
      state.currentProject === project &&
      !state.recoveryTarget &&
      normalizeProjectOpenFields(state.projects.find((candidate) => candidate.name === project) ?? {}).openState ===
        'ready'
    if (!isActiveProject) return
    phaseRequests.activate(project)
    const request = phaseRequests.start(project)
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
    const {
      mode = 'medium-novel',
      language = 'zh',
      genres = ['sci-fi', 'romance'],
      storage = DEFAULT_PROJECT_STORAGE,
    } = opts
    set({ loading: true, error: null })
    try {
      // 1. Create the project
      const createdProject = await createProjectForStorage(projectsApi, storage, { name, mode, language, genres })
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
      await chaptersApi.create(name, initialChapterForStorage(storage, t('chapter.firstChapterTitle')))

      // 3. Reload project list & set current
      await useProjectStore.getState().loadProjects()
      useProjectStore.getState().setCurrentProject(name)
      if (get().currentProject !== name || get().recoveryTarget) {
        set({ loading: false })
        return
      }
      set({ loading: false, error: null, workflowPhase: 'idea' })

      // 4. Load chapters into sidebar & navigate to Writing page
      await useChapterStore.getState().loadChapters(name)
      useSidebarStore.getState().setActivePage('page-writing')
    } catch (err) {
      set({ error: (err as any).message || t('project.createFailed'), loading: false })
      throw err
    }
  },

  deleteProject: async (name) => {
    const project = get().projects.find((candidate) => candidate.name === name)
    if (!project || normalizeProjectOpenFields(project).openState !== 'ready') {
      set({ error: t('recovery.deleteBlocked'), loading: false })
      return
    }
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
      const fallbackProject = transition.deletedCurrentProject
        ? selectReadyFallback(transition.projects)
        : transition.currentProject
      if (transition.deletedCurrentProject) {
        retireAgentProjectState(name, expectedInstanceId)
        localStorage.setItem('mythpen-current-project', fallbackProject || '')
        phaseRequests.activate(fallbackProject || '')
      }
      set((state) => ({
        projects: transition.projects,
        currentProject: fallbackProject,
        showProjectList:
          transition.deletedCurrentProject && !fallbackProject && !state.recoveryTarget ? true : state.showProjectList,
        workflowPhase: transition.deletedCurrentProject ? 'idea' : state.workflowPhase,
      }))
      if (transition.deletedCurrentProject) {
        useChapterStore.getState().activateProject(fallbackProject)
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
