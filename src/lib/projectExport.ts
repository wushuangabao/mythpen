import { ApiError, apiUrl } from './api.ts'
import { getProjectInstanceHeaders, getProjectInstanceId, isCurrentProjectInstance } from './projectInstanceRegistry.ts'
import { runProjectRequest } from './projectRequestGate.ts'

export type ProjectExportFormat = 'epub' | 'html' | 'md' | 'txt'

interface ProjectFileScope {
  project: string
  instanceId: string | undefined
  isCurrent: () => boolean
}

export interface ProjectExportDownload extends ProjectFileScope {
  blob: Blob
  fileName: string
  format: ProjectExportFormat
}

export interface ProjectCoverDownload extends ProjectFileScope {
  blob: Blob
  mime: string
}

export class ProjectExportSupersededError extends Error {
  readonly project: string

  constructor(project: string) {
    super(`Project "${project}" changed while its file was being downloaded`)
    this.name = 'ProjectExportSupersededError'
    this.project = project
  }
}

function createProjectFileScope(project: string): ProjectFileScope {
  const instanceId = getProjectInstanceId(project)
  return {
    project,
    instanceId,
    isCurrent: () => isCurrentProjectInstance(project, instanceId),
  }
}

async function responseError(response: Response): Promise<ApiError> {
  const payload = await response.json().catch(() => ({ error: { message: response.statusText } }))
  const detail = payload?.error ?? payload
  return new ApiError(
    (typeof detail === 'string' ? detail : detail?.message) || `HTTP ${response.status}`,
    response.status,
    typeof detail?.code === 'string' ? detail.code : undefined,
    detail?.recoverable === true,
  )
}

async function fetchProjectFile(
  project: string,
  path: string,
): Promise<{ response: Response; scope: ProjectFileScope }> {
  const scope = createProjectFileScope(project)
  const response = await fetch(apiUrl(path), {
    cache: 'no-store',
    headers: getProjectInstanceHeaders(project),
  })
  if (!response.ok) throw await responseError(response)
  return { response, scope }
}

function assertCurrent(scope: ProjectFileScope): void {
  if (!scope.isCurrent()) throw new ProjectExportSupersededError(scope.project)
}

function responseFileName(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1]
  if (!encoded) return fallback
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/**
 * Fetch, consume, and act on an export as one project-scoped task. Keeping the
 * consumer inside runProjectRequest means project deletion drains the blob and
 * the caller's download callback before DELETE can begin.
 */
export function consumeProjectExport<T>(
  project: string,
  format: ProjectExportFormat,
  consume: (download: ProjectExportDownload) => T | Promise<T>,
): Promise<T> {
  return runProjectRequest(project, async () => {
    const { response, scope } = await fetchProjectFile(
      project,
      `/${encodeURIComponent(project)}/export?format=${encodeURIComponent(format)}&download=1`,
    )
    const blob = await response.blob()
    assertCurrent(scope)
    const result = await consume({
      ...scope,
      blob,
      fileName: responseFileName(response, `${project}.${format}`),
      format,
    })
    assertCurrent(scope)
    return result
  })
}

/** Read a cover through the same instance header/gate used by project writes. */
export function readProjectCover(project: string): Promise<ProjectCoverDownload> {
  return runProjectRequest(project, async () => {
    const { response, scope } = await fetchProjectFile(project, `/${encodeURIComponent(project)}/cover?t=${Date.now()}`)
    const blob = await response.blob()
    assertCurrent(scope)
    return {
      ...scope,
      blob,
      mime: response.headers.get('content-type') || blob.type || 'image/png',
    }
  })
}
