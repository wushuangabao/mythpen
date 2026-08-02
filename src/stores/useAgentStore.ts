import { create } from 'zustand'
import { chatApi } from '../lib/api.ts'
import { getProjectInstanceId } from '../lib/projectInstanceRegistry.ts'
import type { AgentTask, ChatMessage } from '../types/index.ts'

interface AgentScope {
  project: string
  instanceId: string
}

export interface ChatSession {
  id: string
  title?: string
  [key: string]: unknown
}

interface AgentState {
  project: string | null
  projectInstanceId: string | null
  task: AgentTask
  messages: ChatMessage[]
  sessions: ChatSession[]
  currentSessionId: string | null
  isRunning: boolean
  loading: boolean
  activateProject: (project: string, instanceId: string) => void
  setTask: (task: Partial<AgentTask>) => void
  addMessageToSession: (sessionId: string, msg: ChatMessage) => boolean
  loadMessages: (project: string) => Promise<void>
  loadSessions: (project: string) => Promise<void>
  createSession: (project: string, title?: string) => Promise<string | null>
  switchSession: (project: string, sessionId: string) => Promise<void>
  deleteSession: (project: string, sessionId: string) => Promise<void>
  updateSessionTitle: (project: string, sessionId: string, title: string) => Promise<void>
  cancelTask: () => void
}

interface AgentTaskAbortRegistration extends AgentScope {
  abort: () => void
}

let activeTaskAbort: AgentTaskAbortRegistration | null = null

function ownedScope(project: string): AgentScope | null {
  const state = useAgentStore.getState()
  if (
    !project ||
    state.project !== project ||
    !state.projectInstanceId ||
    getProjectInstanceId(project) !== state.projectInstanceId
  ) {
    return null
  }
  return { project, instanceId: state.projectInstanceId }
}

function isOwnedScope(scope: AgentScope): boolean {
  const state = useAgentStore.getState()
  return (
    state.project === scope.project &&
    state.projectInstanceId === scope.instanceId &&
    getProjectInstanceId(scope.project) === scope.instanceId
  )
}

function sameScope(left: AgentScope | null, project?: string, instanceId?: string): boolean {
  return !!left && (!project || left.project === project) && (!instanceId || left.instanceId === instanceId)
}

export const useAgentStore = create<AgentState>((set, get) => ({
  project: null,
  projectInstanceId: null,
  task: { taskName: '', status: 'idle' },
  messages: [],
  sessions: [],
  currentSessionId: null,
  isRunning: false,
  loading: false,

  activateProject: (project, instanceId) => activateAgentProjectState(project, instanceId),

  setTask: (task) =>
    set((state) => ({
      task: { ...state.task, ...task },
      isRunning:
        task.status === 'running'
          ? true
          : task.status === 'completed' || task.status === 'error'
            ? false
            : state.isRunning,
    })),
  addMessageToSession: (sessionId, msg) => {
    if (get().currentSessionId !== sessionId) return false
    set((state) => {
      if (state.currentSessionId !== sessionId) return state
      return { messages: [...state.messages, msg] }
    })
    return true
  },

  loadMessages: async (project) => {
    const scope = ownedScope(project)
    if (!scope) return
    const sessionId = get().currentSessionId
    if (!sessionId) return
    set({ loading: true })
    try {
      const messages = await chatApi.list(project, sessionId)
      if (!isOwnedScope(scope) || get().currentSessionId !== sessionId) return
      set({ messages, loading: false })
    } catch {
      if (!isOwnedScope(scope) || get().currentSessionId !== sessionId) return
      set({ messages: [], loading: false })
    }
  },

  loadSessions: async (project) => {
    const scope = ownedScope(project)
    if (!scope) return
    set({ loading: true })
    try {
      const sessions = (await chatApi.listSessions(project)) as ChatSession[]
      if (!isOwnedScope(scope)) return
      const selectedSessionId = sessions.some((session) => session.id === get().currentSessionId)
        ? get().currentSessionId
        : sessions[0]?.id || null
      set({ sessions, currentSessionId: selectedSessionId, messages: [], loading: false })
    } catch {
      if (!isOwnedScope(scope)) return
      set({ sessions: [], currentSessionId: null, messages: [], loading: false })
    }
  },

  createSession: async (project, title) => {
    const scope = ownedScope(project)
    if (!scope) throw new Error('Project instance is not active')
    // A running request owns the selected session until it settles. Creating
    // and selecting another session here would split persistence and UI state.
    if (get().isRunning) return null
    const session = await chatApi.createSession(project, title)
    if (!isOwnedScope(scope)) return session.id
    if (get().isRunning) {
      // The POST already succeeded, so retain the new session without stealing
      // selection from a request that started while the POST was in flight.
      set((state) => ({
        sessions: state.sessions.some((item) => item.id === session.id) ? state.sessions : [session, ...state.sessions],
      }))
      return session.id
    }
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: session.id,
      messages: [],
      loading: false,
    }))
    return session.id
  },

  switchSession: async (project, sessionId) => {
    const scope = ownedScope(project)
    if (!scope || get().isRunning) return
    set({ currentSessionId: sessionId, messages: [], loading: true })
    try {
      const messages = await chatApi.list(project, sessionId)
      if (!isOwnedScope(scope) || get().currentSessionId !== sessionId) return
      set({ messages, loading: false })
    } catch {
      if (!isOwnedScope(scope) || get().currentSessionId !== sessionId) return
      set({ messages: [], loading: false })
    }
  },

  deleteSession: async (project, sessionId) => {
    const scope = ownedScope(project)
    if (!scope || get().isRunning) return
    await chatApi.deleteSession(project, sessionId)
    if (!isOwnedScope(scope)) return
    const remaining = get().sessions.filter((session) => session.id !== sessionId)
    const newCurrentSessionId = get().currentSessionId === sessionId ? remaining[0]?.id || null : get().currentSessionId
    set({ sessions: remaining, currentSessionId: newCurrentSessionId, messages: [], loading: !!newCurrentSessionId })
    if (!newCurrentSessionId) return
    try {
      const messages = await chatApi.list(project, newCurrentSessionId)
      if (!isOwnedScope(scope) || get().currentSessionId !== newCurrentSessionId) return
      set({ messages, loading: false })
    } catch {
      if (!isOwnedScope(scope) || get().currentSessionId !== newCurrentSessionId) return
      set({ messages: [], loading: false })
    }
  },

  updateSessionTitle: async (project, sessionId, title) => {
    const scope = ownedScope(project)
    if (!scope) return
    await chatApi.updateSession(project, sessionId, title)
    if (!isOwnedScope(scope)) return
    set((state) => ({
      sessions: state.sessions.map((session) => (session.id === sessionId ? { ...session, title } : session)),
    }))
  },

  cancelTask: () => set({ isRunning: false, task: { taskName: '', status: 'idle' } }),
}))

/** Activate the sole chat UI owner. A different scope invalidates every pending commit. */
export function activateAgentProjectState(project: string, instanceId: string): void {
  const state = useAgentStore.getState()
  if (state.project === project && state.projectInstanceId === instanceId) return
  if (state.project) retireAgentProjectState(state.project, state.projectInstanceId || undefined)
  useAgentStore.setState({
    project,
    projectInstanceId: instanceId,
    task: { taskName: '', status: 'idle' },
    messages: [],
    sessions: [],
    currentSessionId: null,
    isRunning: false,
    loading: false,
  })
}

/** Register the actual streaming AbortController for synchronous retirement. */
export function registerAgentTaskAbort(project: string, instanceId: string, abort: () => void): () => void {
  if (!isOwnedScope({ project, instanceId })) return () => {}
  const registration = { project, instanceId, abort }
  activeTaskAbort = registration
  return () => {
    if (activeTaskAbort === registration) activeTaskAbort = null
  }
}

export function clearAgentTaskAbort(project?: string, instanceId?: string): void {
  if (sameScope(activeTaskAbort, project, instanceId)) activeTaskAbort = null
}

/**
 * Retire only the matching owner. A background project rotation must not hide
 * or orphan the active project's running request.
 */
export function retireAgentProjectState(project?: string, instanceId?: string): boolean {
  const state = useAgentStore.getState()
  if (project && state.project !== project) return false
  if (instanceId && state.projectInstanceId !== instanceId) return false

  if (activeTaskAbort && sameScope(activeTaskAbort, state.project || undefined, state.projectInstanceId || undefined)) {
    const registration = activeTaskAbort
    activeTaskAbort = null
    try {
      registration.abort()
    } catch {
      // State still retires if an AbortController implementation throws.
    }
  }
  useAgentStore.setState({
    project: null,
    projectInstanceId: null,
    task: { taskName: '', status: 'idle' },
    messages: [],
    sessions: [],
    currentSessionId: null,
    isRunning: false,
    loading: false,
  })
  return true
}
