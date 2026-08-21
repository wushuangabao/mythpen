import { getEditorSaveQueueSnapshot } from './editorSaveQueue.ts'
import { getTitleSaveQueueSnapshot } from './titleSaveQueue.ts'

export type FilesBetaMigrationPreflight = Readonly<{
  canMigrate: boolean
  bodyDrafts: number
  titleDrafts: number
}>

function countProjectDrafts(drafts: Readonly<Record<string, string>>, project: string): number {
  let count = 0
  for (const key of Object.keys(drafts)) {
    try {
      const parsed = JSON.parse(key)
      if (Array.isArray(parsed) && parsed[0] === project) count += 1
    } catch {
      // Internal queue keys from other projects do not control this migration.
    }
  }
  return count
}

export function inspectFilesBetaMigrationPreflight(project: string): FilesBetaMigrationPreflight {
  const bodyDrafts = countProjectDrafts(getEditorSaveQueueSnapshot().drafts, project)
  const titleDrafts = countProjectDrafts(getTitleSaveQueueSnapshot().drafts, project)
  return Object.freeze({
    canMigrate: bodyDrafts === 0 && titleDrafts === 0,
    bodyDrafts,
    titleDrafts,
  })
}

export class FilesBetaMigrationBlockedError extends Error {
  readonly code = 'FILES_BETA_MIGRATION_BLOCKED_BY_DRAFTS'
  readonly preflight: FilesBetaMigrationPreflight

  constructor(preflight: FilesBetaMigrationPreflight) {
    super('请先保存或处理当前项目的本地草稿，再迁移到 files Beta。')
    this.name = 'FilesBetaMigrationBlockedError'
    this.preflight = preflight
  }
}

export async function beginFilesBetaMigration<Result>(
  project: string,
  migrate: () => Promise<Result>,
): Promise<Result> {
  const preflight = inspectFilesBetaMigrationPreflight(project)
  if (!preflight.canMigrate) throw new FilesBetaMigrationBlockedError(preflight)
  return migrate()
}
