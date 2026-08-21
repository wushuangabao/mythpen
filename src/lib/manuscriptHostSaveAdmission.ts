const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const frozenProjects = new Map<string, string>()

function validate(project: string, projectInstanceId: string): void {
  if (!project) throw new TypeError('manuscript save admission project is required')
  if (!UUID_V4_PATTERN.test(projectInstanceId)) {
    throw new TypeError('manuscript save admission project instance must be a canonical UUIDv4')
  }
}

export function freezeManuscriptSaveAdmission(project: string, projectInstanceId: string): void {
  validate(project, projectInstanceId)
  const current = frozenProjects.get(project)
  if (current !== undefined) throw new TypeError('manuscript save admission is already frozen')
  frozenProjects.set(project, projectInstanceId)
}

export function assertManuscriptSaveAdmission(project: string): true {
  if (!project) throw new TypeError('manuscript save admission project is required')
  if (frozenProjects.has(project)) throw new TypeError('manuscript save admission is frozen')
  return true
}

export function releaseManuscriptSaveAdmission(project: string, projectInstanceId: string): void {
  validate(project, projectInstanceId)
  const current = frozenProjects.get(project)
  if (current === undefined) return
  if (current !== projectInstanceId) throw new TypeError('manuscript save admission instance changed')
  frozenProjects.delete(project)
}
