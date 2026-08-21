import type { ManuscriptBaseWitness } from './api.ts'
import {
  discardManuscriptDirtyResource,
  isManuscriptSaveProtected,
  type ManuscriptDirtyBinding,
  markManuscriptResourceDirty,
  markManuscriptResourceSaving,
  settleManuscriptResource,
} from './manuscriptDirtyResources.ts'
import { isolateProjectDraft } from './projectDraftRecovery.ts'

export interface TitleSaveEntry {
  project: string
  chapterId: number
  chapterNum: number
  title: string
  version: number
  dirtyBinding?: ManuscriptDirtyBinding
  baseWitness?: ManuscriptBaseWitness
}

export interface TitleSaveQueueSnapshot {
  drafts: Readonly<Record<string, string>>
  errors: Readonly<Record<string, string>>
}

type TitleSaveWriter = (entry: TitleSaveEntry) => Promise<void>

const pendingSaves = new Map<string, TitleSaveEntry>()
const visibleDrafts = new Map<string, TitleSaveEntry>()
const saveQueues = new Map<string, Promise<void>>()
const failedSaves = new Map<string, string>()
const failedSaveCodes = new Map<string, string>()
const latestVersionByTarget = new Map<string, number>()
const projectEpochs = new Map<string, number>()
const listeners = new Set<() => void>()
let nextSaveVersion = 0
let snapshot: TitleSaveQueueSnapshot = { drafts: {}, errors: {} }

export function titleSaveKey(project: string, chapterId: number): string {
  return JSON.stringify([project, chapterId])
}

function projectEpoch(project: string): number {
  return projectEpochs.get(project) ?? 0
}

function saveKeyBelongsToProject(saveKey: string, project: string): boolean {
  try {
    const parsed = JSON.parse(saveKey)
    return Array.isArray(parsed) && parsed[0] === project
  } catch {
    return false
  }
}

function publishSnapshot() {
  const drafts: Record<string, string> = {}
  for (const [saveKey, entry] of visibleDrafts) drafts[saveKey] = entry.title
  const errors: Record<string, string> = {}
  for (const [saveKey, message] of failedSaves) errors[saveKey] = message
  snapshot = { drafts, errors }
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One unmounted subscriber must not break the process-wide queue.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '保存失败')
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value
    : null
}

function snapshotBaseWitness(value: ManuscriptBaseWitness | undefined): ManuscriptBaseWitness | undefined {
  if (value === undefined) return undefined
  return Object.freeze({
    expected_data_version: value.expected_data_version,
    generation: value.generation,
    raw_sha256: value.raw_sha256,
    sidecar_raw_sha256: value.sidecar_raw_sha256,
  })
}

export function subscribeTitleSaveQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTitleSaveQueueSnapshot(): TitleSaveQueueSnapshot {
  return snapshot
}

export function getTitleSaveDraft(project: string, chapterId: number): TitleSaveEntry | null {
  return visibleDrafts.get(titleSaveKey(project, chapterId)) || null
}

export function getTitleSaveFailure(
  project: string,
  chapterId: number,
): Readonly<{ message: string; code: string | null }> | null {
  const saveKey = titleSaveKey(project, chapterId)
  const message = failedSaves.get(saveKey)
  if (message === undefined) return null
  return Object.freeze({ message, code: failedSaveCodes.get(saveKey) ?? null })
}

function clearProjectTitleSaves(project: string): void {
  projectEpochs.set(project, projectEpoch(project) + 1)
  for (const [saveKey, entry] of visibleDrafts) {
    if (saveKeyBelongsToProject(saveKey, project) && entry.dirtyBinding) {
      discardManuscriptDirtyResource(entry.dirtyBinding)
    }
  }
  for (const saveKey of [...pendingSaves.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) pendingSaves.delete(saveKey)
  }
  for (const saveKey of [...visibleDrafts.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) visibleDrafts.delete(saveKey)
  }
  for (const saveKey of [...failedSaves.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) failedSaves.delete(saveKey)
  }
  for (const saveKey of [...failedSaveCodes.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) failedSaveCodes.delete(saveKey)
  }
  for (const saveKey of [...latestVersionByTarget.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) latestVersionByTarget.delete(saveKey)
  }
  for (const saveKey of [...saveQueues.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) saveQueues.delete(saveKey)
  }
  publishSnapshot()
}

/** Drop every recoverable title snapshot after its project was permanently deleted. */
export function discardProjectTitleSaves(project: string): void {
  clearProjectTitleSaves(project)
}

/** Preserve title drafts from a retired immutable project instance. */
export function retireStaleProjectTitleSaves(project: string, sourceInstanceId: string): number {
  let isolated = 0
  for (const [saveKey, entry] of visibleDrafts) {
    if (!saveKeyBelongsToProject(saveKey, project)) continue
    const recovery = isolateProjectDraft({
      project,
      sourceInstanceId,
      chapterId: entry.chapterId,
      chapterNum: entry.chapterNum,
      title: entry.title,
      titleError: failedSaves.get(saveKey),
    })
    if (recovery) isolated++
  }
  clearProjectTitleSaves(project)
  return isolated
}

/**
 * Keep the newest title draft outside React so it survives navigation and can
 * supersede an older in-flight save without being cleared by that save.
 */
export function stageTitleSave(
  project: string,
  chapterId: number,
  chapterNum: number,
  title: string,
  dirtyBinding?: ManuscriptDirtyBinding,
  baseWitness?: ManuscriptBaseWitness,
): TitleSaveEntry {
  const saveKey = titleSaveKey(project, chapterId)
  const existingDraft = visibleDrafts.get(saveKey)
  const entry = {
    project,
    chapterId,
    chapterNum,
    title,
    version: ++nextSaveVersion,
    dirtyBinding: existingDraft ? existingDraft.dirtyBinding : dirtyBinding,
    baseWitness: existingDraft ? existingDraft.baseWitness : snapshotBaseWitness(baseWitness),
  }
  latestVersionByTarget.set(saveKey, entry.version)
  pendingSaves.set(saveKey, entry)
  visibleDrafts.set(saveKey, entry)
  failedSaves.delete(saveKey)
  failedSaveCodes.delete(saveKey)
  if (entry.dirtyBinding) markManuscriptResourceDirty(entry.dirtyBinding, entry.version, { title })
  publishSnapshot()
  return entry
}

/** Record a client-side validation error without losing the recoverable draft. */
export function setTitleSaveError(project: string, chapterId: number, version: number, error: unknown): void {
  const saveKey = titleSaveKey(project, chapterId)
  if (latestVersionByTarget.get(saveKey) !== version || visibleDrafts.get(saveKey)?.version !== version) return
  failedSaves.set(saveKey, errorMessage(error))
  publishSnapshot()
}

/**
 * Explicitly discard the visible draft and invalidate an in-flight callback.
 * The network request cannot be undone, but a late failure must not resurrect
 * an edit the user already dismissed.
 */
export function discardTitleSave(project: string, chapterId: number): void {
  const saveKey = titleSaveKey(project, chapterId)
  const dirtyBinding = visibleDrafts.get(saveKey)?.dirtyBinding
  latestVersionByTarget.set(saveKey, ++nextSaveVersion)
  pendingSaves.delete(saveKey)
  visibleDrafts.delete(saveKey)
  failedSaves.delete(saveKey)
  failedSaveCodes.delete(saveKey)
  if (dirtyBinding) discardManuscriptDirtyResource(dirtyBinding)
  publishSnapshot()
}

/**
 * Serialize writes per project/chapter. A newer draft is never cleared or
 * labelled failed by an older request, while the latest failed draft is put
 * back into the module-level pending queue for retry after remounting.
 */
export function flushTitleSave(project: string, chapterId: number, writer: TitleSaveWriter): Promise<void> {
  const saveKey = titleSaveKey(project, chapterId)
  const pending = pendingSaves.get(saveKey)
  if (!pending) return saveQueues.get(saveKey) ?? Promise.resolve()
  pendingSaves.delete(saveKey)
  const requestEpoch = projectEpoch(project)
  const requestId = `title-save-${pending.version}`

  const previousSave = saveQueues.get(saveKey) ?? Promise.resolve()
  const currentSave = previousSave
    .catch(() => {})
    .then(async () => {
      if (projectEpoch(project) !== requestEpoch) return
      // If the request has not started yet and the user already replaced the
      // draft, only the newer queued write is relevant.
      if (latestVersionByTarget.get(saveKey) !== pending.version) return
      if (pending.dirtyBinding) {
        markManuscriptResourceSaving(pending.dirtyBinding, pending.version, requestId)
      }
      await writer(pending)
    })
    .then(
      () => {
        if (projectEpoch(project) !== requestEpoch) return
        if (latestVersionByTarget.get(saveKey) === pending.version) {
          if (visibleDrafts.get(saveKey)?.version === pending.version) visibleDrafts.delete(saveKey)
          failedSaves.delete(saveKey)
          failedSaveCodes.delete(saveKey)
          if (pending.dirtyBinding) {
            settleManuscriptResource(pending.dirtyBinding, pending.version, requestId, 'saved')
          }
        }
        publishSnapshot()
      },
      (error) => {
        if (projectEpoch(project) !== requestEpoch) return
        if (
          latestVersionByTarget.get(saveKey) === pending.version &&
          visibleDrafts.get(saveKey)?.version === pending.version
        ) {
          pendingSaves.set(saveKey, pending)
          failedSaves.set(saveKey, errorMessage(error))
          const code = errorCode(error)
          if (code) failedSaveCodes.set(saveKey, code)
          else failedSaveCodes.delete(saveKey)
          if (pending.dirtyBinding) {
            settleManuscriptResource(
              pending.dirtyBinding,
              pending.version,
              requestId,
              isManuscriptSaveProtected(code) ? 'stale' : 'failed',
            )
          }
        }
        publishSnapshot()
        throw error
      },
    )

  saveQueues.set(saveKey, currentSave)
  const clearCompletedSave = () => {
    if (saveQueues.get(saveKey) === currentSave) saveQueues.delete(saveKey)
  }
  void currentSave.then(clearCompletedSave, clearCompletedSave)
  return currentSave
}
