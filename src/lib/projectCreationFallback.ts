import type { ProjectOpenState, RecoveryAction } from '../types/index.ts'

export interface ProjectSummaryRecord {
  id: string
  name: string
  iconName: string
  genres: string[]
  wordCount: number
  chapterCount: number
  lastOpened: string
  status: string
  mode?: string
  instanceId?: string
  openState: ProjectOpenState
  reasonCode: string | null
  recommendedAction: RecoveryAction | null
}

interface ProjectCreationOptions {
  mode: string
  genres: string[]
}

/** Build the authoritative minimum row supplied by a successful POST /projects. */
export function createProjectFallbackSummary(
  name: string,
  createdProject: Record<string, unknown>,
  options: ProjectCreationOptions,
  now = new Date().toISOString(),
): ProjectSummaryRecord {
  const createdGenres = Array.isArray(createdProject.genres)
    ? createdProject.genres.filter((genre): genre is string => typeof genre === 'string')
    : options.genres
  return {
    id: typeof createdProject.id === 'string' && createdProject.id ? createdProject.id : name,
    name,
    iconName:
      typeof createdProject.iconName === 'string' && createdProject.iconName ? createdProject.iconName : 'BookOpen',
    genres: createdGenres,
    wordCount: Number(createdProject.wordCount) || 0,
    chapterCount: Number(createdProject.chapterCount) || 0,
    lastOpened:
      typeof createdProject.lastOpened === 'string' && createdProject.lastOpened ? createdProject.lastOpened : now,
    status: typeof createdProject.status === 'string' && createdProject.status ? createdProject.status : '刚起步',
    mode: typeof createdProject.mode === 'string' && createdProject.mode ? createdProject.mode : options.mode,
    instanceId:
      typeof createdProject.instanceId === 'string' && createdProject.instanceId
        ? createdProject.instanceId
        : undefined,
    openState: 'ready',
    reasonCode: null,
    recommendedAction: null,
  }
}

export function upsertProjectFallback(
  projects: readonly ProjectSummaryRecord[],
  fallback: ProjectSummaryRecord,
): ProjectSummaryRecord[] {
  return [...projects.filter((project) => project.name !== fallback.name), fallback]
}
