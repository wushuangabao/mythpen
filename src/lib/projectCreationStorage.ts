export type ProjectStorage = 'sqlite' | 'files-beta'
export const DEFAULT_PROJECT_STORAGE: ProjectStorage = 'sqlite'

export interface ProjectCreationInput {
  name: string
  mode: string
  language: string
  genres: string[]
}

export function initialChapterForStorage(storage: ProjectStorage, title: string) {
  return storage === 'files-beta' ? { title, volume_id: null } : { title }
}

interface ProjectCreationGateway {
  create: (input: ProjectCreationInput) => Promise<Record<string, unknown>>
  createFilesBeta: (input: ProjectCreationInput) => Promise<Record<string, unknown>>
  getFilesBetaStatus: (name: string) => Promise<{
    route: string
    project_uid: string | null
    project_instance_id: string | null
  }>
}

export async function createProjectForStorage(
  gateway: ProjectCreationGateway,
  storage: ProjectStorage,
  input: ProjectCreationInput,
): Promise<Record<string, unknown>> {
  if (storage === 'sqlite') return gateway.create(input)

  const created = await gateway.createFilesBeta(input)
  const status = await gateway.getFilesBetaStatus(input.name)
  if (status.route !== 'files' || !status.project_instance_id || !status.project_uid) {
    throw new Error('files Beta project did not reach one reopenable activated instance')
  }
  return {
    ...created,
    name: input.name,
    mode: input.mode,
    genres: [...input.genres],
    instanceId: status.project_instance_id,
    projectUid: status.project_uid,
  }
}
