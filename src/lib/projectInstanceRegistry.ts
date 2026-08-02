export const PROJECT_INSTANCE_HEADER = 'X-Mythpen-Project-Instance'

interface ProjectInstanceSummary {
  name: string
  instanceId?: string
}

export interface ProjectInstanceChange {
  project: string
  previousInstanceId: string
  currentInstanceId?: string
}

const instances = new Map<string, string>()

export function replaceProjectInstances(projects: readonly ProjectInstanceSummary[]): ProjectInstanceChange[] {
  const changes: ProjectInstanceChange[] = []
  const listedProjects = new Set(projects.map((project) => project.name).filter(Boolean))
  for (const project of [...instances.keys()]) {
    if (!listedProjects.has(project)) {
      const previousInstanceId = instances.get(project)
      if (previousInstanceId) changes.push({ project, previousInstanceId })
      instances.delete(project)
    }
  }
  for (const project of projects) {
    // A per-project fallback row can lack instanceId when that database was
    // temporarily unreadable. Preserve an already-known token in that case:
    // an old token fails closed with 409 after same-name replacement, whereas
    // dropping it would silently downgrade subsequent requests to no CAS.
    if (project.name && project.instanceId) {
      const previousInstanceId = instances.get(project.name)
      if (previousInstanceId && previousInstanceId !== project.instanceId) {
        changes.push({ project: project.name, previousInstanceId, currentInstanceId: project.instanceId })
      }
      instances.set(project.name, project.instanceId)
    }
  }
  return changes
}

export function rememberProjectInstance(project: string, instanceId: unknown): ProjectInstanceChange | undefined {
  if (!project || typeof instanceId !== 'string' || !instanceId) return undefined
  const previousInstanceId = instances.get(project)
  instances.set(project, instanceId)
  if (previousInstanceId && previousInstanceId !== instanceId) {
    return { project, previousInstanceId, currentInstanceId: instanceId }
  }
  return undefined
}

export function forgetProjectInstance(project: string, expectedInstanceId?: string): boolean {
  if (expectedInstanceId && instances.get(project) !== expectedInstanceId) return false
  const existed = instances.delete(project)
  return existed
}

export function getProjectInstanceId(project: string): string | undefined {
  return instances.get(project)
}

export function isCurrentProjectInstance(project: string, instanceId: string | undefined): boolean {
  return instances.get(project) === instanceId
}

export function getProjectInstanceHeaders(project: string): Record<string, string> {
  const instanceId = getProjectInstanceId(project)
  return instanceId ? { [PROJECT_INSTANCE_HEADER]: instanceId } : {}
}
