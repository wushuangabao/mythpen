export const PROJECT_DRAFT_RECOVERY_STORAGE_KEY = 'mythpen-project-draft-recovery-v1'
export const PROJECT_DRAFT_RECOVERY_EVENT = 'mythpen:project-drafts-isolated'

export interface RecoverableProjectDraft {
  recoveryId: string
  project: string
  sourceInstanceId: string
  retiredAt: string
  chapterId: number
  chapterNum: number
  content?: string
  title?: string
  contentError?: string
  titleError?: string
}

interface PersistedProjectDraftRecoveries {
  version: 1
  entries: RecoverableProjectDraft[]
}

export interface ProjectDraftRecoverySnapshot {
  entries: readonly RecoverableProjectDraft[]
  persistenceError: string | null
}

type RecoverableProjectDraftPatch = Omit<
  RecoverableProjectDraft,
  'recoveryId' | 'retiredAt' | 'content' | 'title' | 'contentError' | 'titleError'
> &
  Partial<Pick<RecoverableProjectDraft, 'content' | 'title' | 'contentError' | 'titleError'>>

const recoveries = new Map<string, RecoverableProjectDraft>()
const listeners = new Set<() => void>()
let persistenceError: string | null = null
let snapshot: ProjectDraftRecoverySnapshot = { entries: [], persistenceError: null }

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function recoveryId(project: string, sourceInstanceId: string, chapterId: number): string {
  return JSON.stringify([project, sourceInstanceId, chapterId])
}

function isRecovery(value: unknown): value is RecoverableProjectDraft {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<RecoverableProjectDraft>
  return (
    typeof entry.recoveryId === 'string' &&
    typeof entry.project === 'string' &&
    typeof entry.sourceInstanceId === 'string' &&
    typeof entry.retiredAt === 'string' &&
    typeof entry.chapterId === 'number' &&
    Number.isFinite(entry.chapterId) &&
    typeof entry.chapterNum === 'number' &&
    Number.isFinite(entry.chapterNum) &&
    (entry.content === undefined || typeof entry.content === 'string') &&
    (entry.title === undefined || typeof entry.title === 'string')
  )
}

function readPersistedRecoveries(): RecoverableProjectDraft[] {
  try {
    const raw = storage()?.getItem(PROJECT_DRAFT_RECOVERY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<PersistedProjectDraftRecoveries>
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return []
    return parsed.entries.filter(isRecovery)
  } catch {
    return []
  }
}

function publish(): void {
  snapshot = {
    entries: [...recoveries.values()].sort((left, right) => right.retiredAt.localeCompare(left.retiredAt)),
    persistenceError,
  }
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A stale view must not prevent the durable recovery snapshot from updating.
    }
  }
}

function persist(project?: string): void {
  try {
    const target = storage()
    if (target) {
      if (recoveries.size === 0) target.removeItem(PROJECT_DRAFT_RECOVERY_STORAGE_KEY)
      else {
        const payload: PersistedProjectDraftRecoveries = { version: 1, entries: [...recoveries.values()] }
        target.setItem(PROJECT_DRAFT_RECOVERY_STORAGE_KEY, JSON.stringify(payload))
      }
      persistenceError = null
    } else {
      persistenceError = 'Local storage is unavailable; copy the isolated draft before closing the app.'
    }
  } catch (error) {
    persistenceError = `The isolated draft could not be saved locally: ${
      error instanceof Error ? error.message : String(error)
    }`
  } finally {
    publish()
    if (project && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PROJECT_DRAFT_RECOVERY_EVENT, { detail: { project } }))
    }
  }
}

/**
 * Merge one editor/title snapshot into the durable record for the retired
 * immutable project instance. This never stages a save for the replacement.
 */
export function isolateProjectDraft(patch: RecoverableProjectDraftPatch): RecoverableProjectDraft | null {
  if (!patch.project || !patch.sourceInstanceId || !Number.isFinite(patch.chapterId)) return null
  if (patch.content === undefined && patch.title === undefined) return null

  const id = recoveryId(patch.project, patch.sourceInstanceId, patch.chapterId)
  const previous = recoveries.get(id)
  const entry: RecoverableProjectDraft = {
    ...previous,
    recoveryId: id,
    project: patch.project,
    sourceInstanceId: patch.sourceInstanceId,
    retiredAt: previous?.retiredAt ?? new Date().toISOString(),
    chapterId: patch.chapterId,
    chapterNum: patch.chapterNum,
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.contentError !== undefined ? { contentError: patch.contentError } : {}),
    ...(patch.titleError !== undefined ? { titleError: patch.titleError } : {}),
  }
  recoveries.set(id, entry)
  persist(patch.project)
  return entry
}

export function subscribeProjectDraftRecovery(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProjectDraftRecoverySnapshot(): ProjectDraftRecoverySnapshot {
  return snapshot
}

export function getRecoverableProjectDrafts(project?: string): RecoverableProjectDraft[] {
  return snapshot.entries.filter((entry) => !project || entry.project === project).map((entry) => ({ ...entry }))
}

export function discardRecoverableProjectDraft(recoveryIdToDiscard: string): boolean {
  const entry = recoveries.get(recoveryIdToDiscard)
  if (!entry) return false
  recoveries.delete(recoveryIdToDiscard)
  persist()
  return true
}

/** Permanent project deletion is the only automatic path that removes recoveries. */
export function discardProjectDraftRecoveries(project: string): void {
  let changed = false
  for (const [id, entry] of recoveries) {
    if (entry.project !== project) continue
    recoveries.delete(id)
    changed = true
  }
  if (changed) persist()
}

export function formatRecoverableProjectDraft(entry: RecoverableProjectDraft): string {
  const lines = [
    `Project: ${entry.project}`,
    `Source instance: ${entry.sourceInstanceId}`,
    `Isolated at: ${entry.retiredAt}`,
    `Chapter: ${entry.chapterNum} (ID ${entry.chapterId})`,
  ]
  if (entry.title !== undefined) lines.push('', 'Title draft:', entry.title)
  if (entry.content !== undefined) lines.push('', 'Content draft:', entry.content)
  return lines.join('\n')
}

export function isMatchingProjectDraftTarget(
  draft: Pick<RecoverableProjectDraft, 'chapterId' | 'chapterNum'>,
  chapter: { id: number; num: number },
): boolean {
  return chapter.id === draft.chapterId && chapter.num === draft.chapterNum
}

for (const entry of readPersistedRecoveries()) recoveries.set(entry.recoveryId, entry)
publish()
