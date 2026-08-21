// API client for Mythpen backend. All local transport goes through backendFetch.

import type { ProjectDiagnostics, RecoveryAction, WorldEntry, WorldEntryInput } from '../types'
import { backendFetch } from './backendRuntime.ts'
import { getProjectInstanceHeaders, PROJECT_INSTANCE_HEADER } from './projectInstanceRegistry.ts'
import { runProjectRequest, suspendProjectRequests } from './projectRequestGate.ts'
import { parseWorldTags } from './worldTags.ts'

const MANUSCRIPT_REQUEST_ID_HEADER = 'X-Mythpen-Request-Id'

export interface ManuscriptBaseWitness {
  expected_data_version: number
  generation: number
  raw_sha256: string
  sidecar_raw_sha256: string | null
}

export interface FilesBetaProjectStatus {
  route: 'sqlite' | 'files' | 'migrating' | 'retired'
  project_uid: string | null
  project_instance_id: string | null
}

function manuscriptRequestId(): string {
  return globalThis.crypto.randomUUID()
}

async function projectManuscriptBaseWitness(project: string): Promise<ManuscriptBaseWitness | undefined> {
  const result = (await projectRequest(project, `/${encodeURIComponent(project)}/manuscript/witness`)) as {
    base_witness?: ManuscriptBaseWitness | null
  }
  return result.base_witness ?? undefined
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly recoverable: boolean
  readonly details?: Readonly<Record<string, unknown>>

  constructor(message: string, status: number, code?: string, recoverable = false, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.recoverable = recoverable
    this.details = details ? { ...details } : undefined
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function ensureResponseOk(res: Response): Promise<void> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
    const detail = err.error ?? err
    throw new ApiError(
      (typeof detail === 'string' ? detail : detail?.message) || `HTTP ${res.status}`,
      res.status,
      typeof detail?.code === 'string' ? detail.code : undefined,
      detail?.recoverable === true,
      isPlainJsonObject(detail?.details) ? detail.details : undefined,
    )
  }
}

async function parseJsonResponse(res: Response) {
  await ensureResponseOk(res)
  return res.json()
}

async function performRequest(path: string, options: any = {}) {
  const config: any = {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  }
  if (config.body && typeof config.body === 'object') {
    config.body = JSON.stringify(config.body)
  }
  return parseJsonResponse(await backendFetch(path, config))
}

function request(path: string, options: any = {}) {
  return performRequest(path, options)
}

/** Project scope is explicit; project names may equal global route names. */
function projectRequest(project: string, path: string, options: any = {}) {
  const projectOptions = {
    ...options,
    headers: { ...options.headers, ...getProjectInstanceHeaders(project) },
  }
  return runProjectRequest(project, () => performRequest(path, projectOptions))
}

/** Registered-project diagnostics are name-scoped but deliberately carry no instance header. */
function projectDiagnosticsRequest(project: string, path: string, options: any = {}) {
  return runProjectRequest(project, () => performRequest(path, options))
}

/** Only project deletion bypasses its own suspension after in-flight work drains. */
function projectDeleteRequest(project: string, expectedInstanceId: string) {
  if (!expectedInstanceId) return Promise.reject(new Error('Project instance is not loaded'))
  return performRequest(`/projects/by-name/${encodeURIComponent(project)}`, {
    method: 'DELETE',
    // The caller captures this token before suspending/draining requests. Never
    // consult the mutable registry here: the same name may already be a new DB.
    headers: { [PROJECT_INSTANCE_HEADER]: expectedInstanceId },
  })
}

/**
 * Chapter deletion is bound to the instance visible when its confirmation was
 * opened. Do not route this through projectRequest: that helper resolves the
 * header from the mutable registry when the request starts.
 */
function chapterDeleteRequest(
  project: string,
  num: number,
  chapterId: number,
  volumeId: number,
  expectedInstanceId: string,
) {
  if (typeof expectedInstanceId !== 'string' || !expectedInstanceId.trim()) {
    return Promise.reject(new Error('Project instance is not loaded'))
  }
  return runProjectRequest(project, async () => {
    const headers = { [PROJECT_INSTANCE_HEADER]: expectedInstanceId }
    const witnessResult = (await performRequest(`/${encodeURIComponent(project)}/manuscript/witness`, { headers })) as {
      base_witness?: ManuscriptBaseWitness | null
    }
    return performRequest(
      `/${encodeURIComponent(project)}/chapters/${num}?chapter_id=${chapterId}&volume_id=${volumeId}`,
      {
        method: 'DELETE',
        headers: { ...headers, [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
        body: witnessResult.base_witness ? { base_witness: witnessResult.base_witness } : {},
      },
    )
  })
}

export const suspendProjectApiRequests = suspendProjectRequests

// ─── Projects ───

export const projectsApi = {
  list: () => request('/projects'),
  get: (name: string) => projectRequest(name, `/projects/by-name/${encodeURIComponent(name)}`),
  create: (data: any) => {
    const project = typeof data?.name === 'string' && data.name ? data.name : null
    const options = { method: 'POST', body: data }
    return project ? projectRequest(project, '/projects', options) : request('/projects', options)
  },
  createFilesBeta: (data: { name: string; mode: string; language: string; genres: string[] }) =>
    request('/projects/files-beta', {
      method: 'POST',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: data,
    }),
  migrateFilesBeta: (name: string) =>
    request(`/projects/by-name/${encodeURIComponent(name)}/files-beta/migrate`, {
      method: 'POST',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: {},
    }),
  getFilesBetaStatus: (name: string) =>
    projectRequest(
      name,
      `/projects/by-name/${encodeURIComponent(name)}/files-beta/status`,
    ) as Promise<FilesBetaProjectStatus>,
  delete: (name: string, expectedInstanceId: string) => projectDeleteRequest(name, expectedInstanceId),
  getDiagnostics: (name: string) =>
    projectDiagnosticsRequest(
      name,
      `/projects/by-name/${encodeURIComponent(name)}/diagnostics`,
    ) as Promise<ProjectDiagnostics>,
  recoverDiagnostics: (name: string, action: RecoveryAction, snapshot: string) =>
    projectDiagnosticsRequest(name, `/projects/by-name/${encodeURIComponent(name)}/diagnostics/recover`, {
      method: 'POST',
      body: { action, snapshot },
    }) as Promise<ProjectDiagnostics>,
  exportDiagnostics: (name: string) =>
    projectDiagnosticsRequest(name, `/projects/by-name/${encodeURIComponent(name)}/diagnostics/export`, {
      method: 'POST',
      body: {},
    }) as Promise<{ filename: string }>,
  getPhase: (name: string) => projectRequest(name, `/${encodeURIComponent(name)}/workflow/phase`),
  setPhase: (name: string, phase: string) =>
    projectRequest(name, `/${encodeURIComponent(name)}/workflow/phase`, { method: 'PUT', body: { phase } }),
  getSidebarItems: async (name: string) => {
    const items: any[] = await projectRequest(name, `/${encodeURIComponent(name)}/sidebar-items`)
    return items.map((item: any) => ({
      id: item.id,
      labelKey: item.label_key,
      icon: item.icon,
      category: item.category,
      genres: item.genres,
      sortOrder: item.sort_order,
      route: item.route,
      enabled: !!item.enabled,
    }))
  },
  uploadCover: (name: string, data: string, mime: string) =>
    projectRequest(name, `/${encodeURIComponent(name)}/cover`, { method: 'POST', body: { data, mime } }),
  deleteCover: (name: string) => projectRequest(name, `/${encodeURIComponent(name)}/cover`, { method: 'DELETE' }),
}

// ─── Chapters ───

export const chaptersApi = {
  list: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/chapters`),
  get: (project: string, num: number, volumeId?: number) =>
    projectRequest(
      project,
      `/${encodeURIComponent(project)}/chapters/${num}${volumeId ? `?volume_id=${volumeId}` : ''}`,
    ),
  update: (
    project: string,
    num: number,
    data: any,
    chapterId?: number,
    expectedDataVersion?: number,
    baseWitness?: ManuscriptBaseWitness,
  ) =>
    projectRequest(project, `/${encodeURIComponent(project)}/chapters/${num}`, {
      method: 'PUT',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: {
        ...data,
        ...(chapterId === undefined ? {} : { chapter_id: chapterId }),
        ...(expectedDataVersion === undefined ? {} : { expected_data_version: expectedDataVersion }),
        ...(baseWitness === undefined ? {} : { base_witness: baseWitness }),
      },
    }),
  create: async (project: string, data: any) => {
    const baseWitness = await projectManuscriptBaseWitness(project)
    return projectRequest(project, `/${encodeURIComponent(project)}/chapters`, {
      method: 'POST',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: { ...data, ...(baseWitness ? { base_witness: baseWitness } : {}) },
    })
  },
  move: async (project: string, chapterId: number, targetVolumeId: number | null, targetPosition: number) => {
    const baseWitness = await projectManuscriptBaseWitness(project)
    return projectRequest(project, `/${encodeURIComponent(project)}/chapters/${chapterId}/move`, {
      method: 'PUT',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: {
        target_volume_id: targetVolumeId,
        target_position: targetPosition,
        ...(baseWitness ? { base_witness: baseWitness } : {}),
      },
    })
  },
  reorder: async (project: string, containerVolumeId: number | null, chapterIds: number[]) => {
    const baseWitness = await projectManuscriptBaseWitness(project)
    return projectRequest(project, `/${encodeURIComponent(project)}/chapters/order`, {
      method: 'PUT',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: {
        container_volume_id: containerVolumeId,
        chapter_ids: chapterIds,
        ...(baseWitness ? { base_witness: baseWitness } : {}),
      },
    })
  },
  delete: (project: string, num: number, chapterId: number, volumeId: number, expectedInstanceId: string) =>
    chapterDeleteRequest(project, num, chapterId, volumeId, expectedInstanceId),
}

export type RevisionDecision = 'accepted' | 'rejected'

export interface ChapterRevision {
  id: number
  chapterId: number
  baseContent: string
  proposedContent: string
  decisions: Record<string, RevisionDecision>
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  previousChapterStatus?: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface ChapterRevisionResponse {
  revision: ChapterRevision | null
  rebased?: boolean
  chapterDataVersion?: number
}

export interface ChapterRevisionApplyResponse {
  success?: boolean
  chapterId?: number
  content?: string
  wordCount?: number
  status?: string
  dataVersion?: number
  revision?: ChapterRevision
  rebased?: boolean
  conflicted?: boolean
}

export interface ContinuationDoneResponse {
  success: true
  content: string
  chapterId: number
  chapterContent: string
  wordCount: number
  dataVersion?: number
}

export const chapterRevisionsApi = {
  getActive: (project: string, chapterId: number) =>
    projectRequest(
      project,
      `/${encodeURIComponent(project)}/chapters/${chapterId}/revisions/active`,
    ) as Promise<ChapterRevisionResponse>,
  updateDecisions: (
    project: string,
    revisionId: number,
    decisions: Record<string, RevisionDecision>,
    expectedBaseContent: string,
  ) =>
    projectRequest(project, `/${encodeURIComponent(project)}/revisions/${revisionId}`, {
      method: 'PATCH',
      body: { decisions, expectedBaseContent },
    }) as Promise<ChapterRevisionResponse>,
  acceptAll: (project: string, revisionId: number, expectedBaseContent: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/revisions/${revisionId}/accept-all`, {
      method: 'POST',
      body: { expectedBaseContent },
    }) as Promise<ChapterRevisionApplyResponse>,
  rejectAll: (project: string, revisionId: number, expectedBaseContent: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/revisions/${revisionId}/reject-all`, {
      method: 'POST',
      body: { expectedBaseContent },
    }) as Promise<ChapterRevisionApplyResponse>,
  finalize: (
    project: string,
    revisionId: number,
    content: string,
    expectedBaseContent: string,
    expectedDecisions: Record<string, RevisionDecision>,
  ) =>
    projectRequest(project, `/${encodeURIComponent(project)}/revisions/${revisionId}/finalize`, {
      method: 'POST',
      body: { content, expectedBaseContent, expectedDecisions },
    }) as Promise<ChapterRevisionApplyResponse>,
}

// ─── Volumes ───

export const volumesApi = {
  list: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/volumes`),
  create: async (project: string, data: { title: string; summary?: string }) => {
    const baseWitness = await projectManuscriptBaseWitness(project)
    return projectRequest(project, `/${encodeURIComponent(project)}/volumes`, {
      method: 'POST',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: { ...data, ...(baseWitness ? { base_witness: baseWitness } : {}) },
    })
  },
  update: async (project: string, volumeId: number, data: { title?: string; summary?: string }) => {
    const baseWitness = await projectManuscriptBaseWitness(project)
    return projectRequest(project, `/${encodeURIComponent(project)}/volumes/${volumeId}`, {
      method: 'PUT',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: { ...data, ...(baseWitness ? { base_witness: baseWitness } : {}) },
    })
  },
  reorder: async (project: string, volumeIds: number[]) => {
    const baseWitness = await projectManuscriptBaseWitness(project)
    return projectRequest(project, `/${encodeURIComponent(project)}/volumes/order`, {
      method: 'PUT',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: { volume_ids: volumeIds, ...(baseWitness ? { base_witness: baseWitness } : {}) },
    })
  },
  delete: async (project: string, volumeId: number) => {
    const baseWitness = await projectManuscriptBaseWitness(project)
    return projectRequest(project, `/${encodeURIComponent(project)}/volumes/${volumeId}`, {
      method: 'DELETE',
      headers: { [MANUSCRIPT_REQUEST_ID_HEADER]: manuscriptRequestId() },
      body: baseWitness ? { base_witness: baseWitness } : {},
    })
  },
}

// ─── Characters ───

export const charactersApi = {
  list: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/characters`),
  create: (project: string, data: any) =>
    projectRequest(project, `/${encodeURIComponent(project)}/characters`, { method: 'POST', body: data }),
  update: (project: string, id: string, data: any) =>
    projectRequest(project, `/${encodeURIComponent(project)}/characters/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: data,
    }),
}

// ─── World ───

export const worldApi = {
  list: async (project: string): Promise<WorldEntry[]> => {
    const entries: Array<Omit<WorldEntry, 'tags'> & { tags: unknown }> = await projectRequest(
      project,
      `/${encodeURIComponent(project)}/world`,
    )
    return entries.map((entry) => ({ ...entry, tags: parseWorldTags(entry.tags) }))
  },
  create: (project: string, data: WorldEntryInput) =>
    projectRequest(project, `/${encodeURIComponent(project)}/world`, { method: 'POST', body: data }),
  update: (project: string, id: string, data: Partial<WorldEntryInput>) =>
    projectRequest(project, `/${encodeURIComponent(project)}/world/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: data,
    }),
  delete: (project: string, id: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/world/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

// ─── Science ───

export const scienceApi = {
  list: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/science`),
  create: (project: string, data: any) =>
    projectRequest(project, `/${encodeURIComponent(project)}/science`, { method: 'POST', body: data }),
}

// ─── Foreshadows ───

export const foreshadowsApi = {
  list: (project: string, status?: string) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : ''
    return projectRequest(project, `/${encodeURIComponent(project)}/foreshadows${qs}`)
  },
  create: (project: string, data: any) =>
    projectRequest(project, `/${encodeURIComponent(project)}/foreshadows`, { method: 'POST', body: data }),
}

// ─── Relations ───

export const relationsApi = {
  list: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/relations`),
  create: (project: string, data: any) =>
    projectRequest(project, `/${encodeURIComponent(project)}/relations`, { method: 'POST', body: data }),
}

// ─── Memories ───

export const memoriesApi = {
  list: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/memories`),
  create: (project: string, data: any) =>
    projectRequest(project, `/${encodeURIComponent(project)}/memories`, { method: 'POST', body: data }),
  search: (project: string, query: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/memories/search`, {
      method: 'POST',
      body: { query },
    }),
}

// ─── Timeline ───

type TimelineEventInput = {
  year: string
  title: string
  description?: string
  importance?: number
}

export const timelineApi = {
  list: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/timeline`),
  getOrderMode: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/timeline/order-mode`),
  create: (project: string, data: TimelineEventInput) =>
    projectRequest(project, `/${encodeURIComponent(project)}/timeline`, { method: 'POST', body: data }),
  update: (project: string, id: string, data: Partial<TimelineEventInput>) =>
    projectRequest(project, `/${encodeURIComponent(project)}/timeline/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: data,
    }),
  reorder: (project: string, ids: string[]) =>
    projectRequest(project, `/${encodeURIComponent(project)}/timeline/order`, { method: 'PUT', body: { ids } }),
  restoreAutoOrder: (project: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/timeline/order-mode`, {
      method: 'PUT',
      body: { mode: 'auto' },
    }),
  delete: (project: string, id: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/timeline/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}

// ─── Stats ───

export const statsApi = {
  get: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/stats`),
  updateTargetWords: (project: string, targetWords: number) =>
    projectRequest(project, `/${encodeURIComponent(project)}/target-words`, {
      method: 'PUT',
      body: { targetWords },
    }),
  resetTargetWords: (project: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/target-words`, { method: 'DELETE' }),
}

// ─── Settings ───

export const settingsApi = {
  get: () => request('/settings'),
  update: (key: string, value: string) => request('/settings', { method: 'PUT', body: { key, value } }),
}

// ─── Chat / AI (always uses HTTP) ───

function aiRequest(path: string, options: any = {}) {
  const project = typeof options.body?.project === 'string' ? options.body.project : null
  const config: any = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      ...(project ? getProjectInstanceHeaders(project) : {}),
    },
  }
  if (config.body && typeof config.body === 'object') {
    config.body = JSON.stringify(config.body)
  }
  const perform = async () => parseJsonResponse(await backendFetch(path, config))
  return project ? runProjectRequest(project, perform) : perform()
}

// Shared SSE stream reader — handles buffering, line splitting, event dispatch
async function readSSEStream(response: Response, handlers: Record<string, (payload: any) => void>): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Cannot read an empty SSE response body')
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''
  let dataLines: string[] = []

  const dispatch = () => {
    if (dataLines.length === 0) {
      currentEvent = ''
      return
    }

    const event = currentEvent
    const payload = dataLines.join('\n')
    currentEvent = ''
    dataLines = []
    if (payload === '[DONE]') return

    const handler = handlers[event]
    if (!handler) return

    let data: any
    try {
      data = JSON.parse(payload)
    } catch {
      throw new Error(`Invalid ${event || 'message'} SSE payload`)
    }
    handler(data)
  }

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      dispatch()
      return
    }
    if (line.startsWith(':')) return

    const separator = line.indexOf(':')
    if (separator < 0) return
    const field = line.slice(0, separator)
    let value = line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') currentEvent = value
    if (field === 'data') dataLines.push(value)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) processLine(line)
  }
  buffer += decoder.decode()
  if (buffer) processLine(buffer)
  dispatch()
}

export const aiApi = {
  chat: (messages: any[], project: string) => aiRequest('/ai/chat', { method: 'POST', body: { messages, project } }),

  chatStream: (
    messages: any[],
    project: string,
    onChunk: (t: string) => void,
    onEnd: () => void,
    onError: (e: any) => void,
    mode = 'writing',
    onToolCall?: (tc: any) => void,
    onToolResult?: (tr: any) => void,
  ) => {
    const controller = new AbortController()
    runProjectRequest(project, () =>
      backendFetch('/ai/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getProjectInstanceHeaders(project) },
        body: JSON.stringify({ messages, project, mode }),
        signal: controller.signal,
      }).then(async (response) => {
        await ensureResponseOk(response)
        let gotError = false
        let finished = false
        const handleStreamError = (data: any) => {
          if (gotError) return
          gotError = true
          onError(data)
        }
        await readSSEStream(response, {
          content_chunk: (data) => onChunk(data.text || ''),
          tool_call: (data) => onToolCall?.(data),
          tool_result: (data) => onToolResult?.(data),
          error: handleStreamError,
          task_error: handleStreamError,
          task_end: () => {
            finished = true
          },
        })
        if (gotError) return
        if (finished) onEnd()
        else onError(new Error('AI stream ended before completion'))
      }),
    ).catch((e) => onError(e))
    return controller
  },

  continueWriting: (
    chapterId: number,
    context: string,
    project: string,
    onChunk: (t: string) => void,
    onEnd: (data?: ContinuationDoneResponse) => void,
    onError: (e: any) => void,
  ) => {
    const controller = new AbortController()
    let finished = false
    runProjectRequest(project, () =>
      backendFetch('/ai/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getProjectInstanceHeaders(project) },
        body: JSON.stringify({ chapterId, context, project }),
        signal: controller.signal,
      }).then(async (response) => {
        await ensureResponseOk(response)
        let _gotError = false
        await readSSEStream(response, {
          content_chunk: (data) => onChunk(data.text || ''),
          done: (data) => {
            finished = true
            onEnd(data)
          },
          error: (data) => {
            _gotError = true
            finished = true
            onError(data)
          },
        })
        if (!finished && !_gotError) onError(new Error('AI stream ended before completion'))
      }),
    ).catch((e) => onError(e))
    return controller
  },

  polishChapter: (
    chapterId: number,
    project: string,
    onChunk: (t: string) => void,
    onEnd: (data?: { revision?: ChapterRevision; unchanged?: boolean; rebased?: boolean }) => void,
    onError: (e: any) => void,
  ) => {
    const controller = new AbortController()
    let finished = false
    runProjectRequest(project, () =>
      backendFetch('/ai/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getProjectInstanceHeaders(project) },
        body: JSON.stringify({ chapterId, project }),
        signal: controller.signal,
      }).then(async (response) => {
        await ensureResponseOk(response)
        let gotError = false
        await readSSEStream(response, {
          content_chunk: (data) => onChunk(data.text || ''),
          done: (data) => {
            finished = true
            onEnd(data)
          },
          error: (data) => {
            gotError = true
            finished = true
            onError(data)
          },
        })
        if (!finished && !gotError) onError(new Error('AI stream ended before completion'))
      }),
    ).catch((e) => onError(e))
    return controller
  },
}

// ─── Chat sessions ───

export const chatApi = {
  listSessions: (project: string) => projectRequest(project, `/${encodeURIComponent(project)}/chat/sessions`),
  createSession: (project: string, title?: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/chat/sessions`, { method: 'POST', body: { title } }),
  deleteSession: (project: string, sessionId: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/chat/sessions/${sessionId}`, { method: 'DELETE' }),
  updateSession: (project: string, sessionId: string, title: string) =>
    projectRequest(project, `/${encodeURIComponent(project)}/chat/sessions/${sessionId}`, {
      method: 'PUT',
      body: { title },
    }),
  list: (project: string, sessionId?: string) => {
    const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''
    return projectRequest(project, `/${encodeURIComponent(project)}/chat/messages${qs}`)
  },
  save: (project: string, data: any) =>
    projectRequest(project, `/${encodeURIComponent(project)}/chat/messages`, { method: 'POST', body: data }),
}

// ─── AI Response JSON extraction utilities ───
// Common pattern across pages: extract JSON array/object from AI chat response text
export function extractAIJsonArray(text: string | null | undefined): any[] | null {
  if (!text) return null
  const m = text.match(/\[[\s\S]*\]/)
  return m ? tryParseJSON(m[0]) : null
}

export function extractAIJsonObject(text: string | null | undefined): Record<string, any> | null {
  if (!text) return null
  const m = text.match(/\{[\s\S]*\}/)
  return m ? tryParseJSON(m[0]) : null
}

function tryParseJSON(s: string): any | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function getAIResponseText(res: any): string {
  return res?.choices?.[0]?.message?.content?.trim() || ''
}
