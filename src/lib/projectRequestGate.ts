export class ProjectRequestSuspendedError extends Error {
  readonly project: string

  constructor(project: string) {
    super(`Project "${project}" is being deleted`)
    this.name = 'ProjectRequestSuspendedError'
    this.project = project
  }
}

export const PROJECT_REQUEST_DRAIN_TIMEOUT_MS = 10_000

export class ProjectRequestDrainTimeoutError extends Error {
  readonly project: string
  readonly timeoutMs: number
  readonly code = 'PROJECT_REQUEST_DRAIN_TIMEOUT'

  constructor(project: string, timeoutMs: number) {
    super(`Timed out waiting ${timeoutMs}ms for requests from project "${project}" to finish`)
    this.name = 'ProjectRequestDrainTimeoutError'
    this.project = project
    this.timeoutMs = timeoutMs
  }
}

interface ProjectRequestSuspension {
  waitForInflight: () => Promise<void>
  release: () => void
}

const activeRequests = new Map<string, Set<Promise<unknown>>>()
const suspensionCounts = new Map<string, number>()

export function isProjectRequestSuspended(project: string): boolean {
  return (suspensionCounts.get(project) || 0) > 0
}

/**
 * Start and track one project-scoped HTTP request. Suspending a project closes
 * the race between draining existing writes and issuing DELETE: after the
 * suspension begins, no new request for that name can reach the server.
 */
export function runProjectRequest<T>(project: string, start: () => Promise<T>): Promise<T> {
  if (isProjectRequestSuspended(project)) {
    return Promise.reject(new ProjectRequestSuspendedError(project))
  }

  let request: Promise<T>
  try {
    request = Promise.resolve(start())
  } catch (error) {
    return Promise.reject(error)
  }

  const requests = activeRequests.get(project) ?? new Set<Promise<unknown>>()
  requests.add(request)
  activeRequests.set(project, requests)
  const retire = () => {
    const current = activeRequests.get(project)
    current?.delete(request)
    if (current?.size === 0) activeRequests.delete(project)
  }
  void request.then(retire, retire)
  return request
}

export function suspendProjectRequests(
  project: string,
  timeoutMs = PROJECT_REQUEST_DRAIN_TIMEOUT_MS,
): ProjectRequestSuspension {
  suspensionCounts.set(project, (suspensionCounts.get(project) || 0) + 1)
  const inflight = [...(activeRequests.get(project) ?? [])]
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : PROJECT_REQUEST_DRAIN_TIMEOUT_MS
  let released = false
  let waitPromise: Promise<void> | null = null

  return {
    waitForInflight: () => {
      if (waitPromise) return waitPromise
      if (inflight.length === 0) {
        waitPromise = Promise.resolve()
        return waitPromise
      }
      waitPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new ProjectRequestDrainTimeoutError(project, boundedTimeoutMs))
        }, boundedTimeoutMs)
        void Promise.allSettled(inflight).then(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
      return waitPromise
    },
    release: () => {
      if (released) return
      released = true
      const remaining = (suspensionCounts.get(project) || 1) - 1
      if (remaining > 0) suspensionCounts.set(project, remaining)
      else suspensionCounts.delete(project)
    },
  }
}
