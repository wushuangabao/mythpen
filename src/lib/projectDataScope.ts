import { isCurrentProjectInstance } from './projectInstanceRegistry.ts'

export class ProjectDataSupersededError extends Error {
  constructor(project: string) {
    super(`Project "${project}" changed while its data was loading`)
    this.name = 'ProjectDataSupersededError'
  }
}

/** Bind a request only when a real project is active. */
export function createProjectDataFetcher<T>(
  project: string,
  fetcher: (activeProject: string) => Promise<T>,
  instanceId?: string,
): (() => Promise<T>) | null {
  if (!project || instanceId === '') return null
  return async () => {
    const result = await fetcher(project)
    if (instanceId !== undefined && !isCurrentProjectInstance(project, instanceId)) {
      throw new ProjectDataSupersededError(project)
    }
    return result
  }
}

/** A project name is reusable, so async UI reads must also bind its instance. */
export function projectDataDependencyKey(project: string, instanceId: string, suffix?: unknown): string {
  return JSON.stringify(suffix === undefined ? [project, instanceId] : [project, instanceId, suffix])
}
