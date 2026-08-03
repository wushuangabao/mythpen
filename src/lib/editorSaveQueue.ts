import { isolateProjectDraft } from './projectDraftRecovery.ts'

export interface EditorSaveEntry {
  project: string
  chapterId: number
  chapterNum: number
  content: string
  baseDataVersion: number
  version: number
  tombstoneGeneration: number
}

export interface EditorSaveQueueSnapshot {
  drafts: Readonly<Record<string, string>>
  errors: Readonly<Record<string, string>>
}

type EditorSaveWriter = (entry: EditorSaveEntry) => Promise<unknown>

const pendingSaves = new Map<string, EditorSaveEntry>()
const visibleDrafts = new Map<string, EditorSaveEntry>()
const saveQueues = new Map<string, Promise<void>>()
const failedSaves = new Map<string, string>()
const confirmedDataVersions = new Map<string, number>()
const tombstoneGenerations = new Map<string, number>()
const projectEpochs = new Map<string, number>()
const listeners = new Set<() => void>()
let nextSaveVersion = 0
let snapshot: EditorSaveQueueSnapshot = { drafts: {}, errors: {} }

export function editorSaveKey(project: string, chapterId: number): string {
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
  for (const [saveKey, entry] of visibleDrafts) drafts[saveKey] = entry.content
  const errors: Record<string, string> = {}
  for (const [saveKey, message] of failedSaves) errors[saveKey] = message
  snapshot = { drafts, errors }
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A stale component subscription must not break the process-wide queue.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '保存失败')
}

export function subscribeEditorSaveQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getEditorSaveQueueSnapshot(): EditorSaveQueueSnapshot {
  return snapshot
}

export function getEditorSaveDraft(project: string, chapterId: number): EditorSaveEntry | null {
  return visibleDrafts.get(editorSaveKey(project, chapterId)) || null
}

function clearProjectEditorSaves(project: string): void {
  projectEpochs.set(project, projectEpoch(project) + 1)
  for (const saveKey of [...pendingSaves.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) pendingSaves.delete(saveKey)
  }
  for (const saveKey of [...visibleDrafts.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) visibleDrafts.delete(saveKey)
  }
  for (const saveKey of [...failedSaves.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) failedSaves.delete(saveKey)
  }
  for (const saveKey of [...confirmedDataVersions.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) confirmedDataVersions.delete(saveKey)
  }
  for (const saveKey of [...tombstoneGenerations.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) tombstoneGenerations.delete(saveKey)
  }
  for (const saveKey of [...saveQueues.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) saveQueues.delete(saveKey)
  }
  publishSnapshot()
}

/** Drop every recoverable editor snapshot after its project was permanently deleted. */
export function discardProjectEditorSaves(project: string): void {
  clearProjectEditorSaves(project)
}

/**
 * Isolate old-instance drafts before clearing their active overlays. They stay
 * durable and copyable, but are never replayed into a same-name replacement.
 */
export function retireStaleProjectEditorSaves(project: string, sourceInstanceId: string): number {
  let isolated = 0
  for (const [saveKey, entry] of visibleDrafts) {
    if (!saveKeyBelongsToProject(saveKey, project)) continue
    const recovery = isolateProjectDraft({
      project,
      sourceInstanceId,
      chapterId: entry.chapterId,
      chapterNum: entry.chapterNum,
      content: entry.content,
      contentError: failedSaves.get(saveKey),
    })
    if (recovery) isolated++
  }
  clearProjectEditorSaves(project)
  return isolated
}

/**
 * Discard one chapter's local editor draft after the chapter was permanently
 * deleted. A late failure from an already-started request must not restore it.
 */
export function discardEditorSave(project: string, chapterId: number): void {
  const saveKey = editorSaveKey(project, chapterId)
  tombstoneGenerations.set(saveKey, (tombstoneGenerations.get(saveKey) ?? 0) + 1)
  pendingSaves.delete(saveKey)
  visibleDrafts.delete(saveKey)
  failedSaves.delete(saveKey)
  confirmedDataVersions.delete(saveKey)
  publishSnapshot()
}

export function enqueueEditorSave(
  project: string,
  chapterId: number,
  chapterNum: number,
  content: string,
  baseDataVersion: number,
): void {
  const saveKey = editorSaveKey(project, chapterId)
  const existingDraft = visibleDrafts.get(saveKey)
  const entry = {
    project,
    chapterId,
    chapterNum,
    content,
    // New input belongs to the same recoverable draft until that draft is
    // committed. Do not silently rebase it onto an authoritative refresh that
    // may contain another window's accepted revision.
    baseDataVersion: existingDraft?.baseDataVersion ?? baseDataVersion,
    version: ++nextSaveVersion,
    tombstoneGeneration: tombstoneGenerations.get(saveKey) ?? 0,
  }
  pendingSaves.set(saveKey, entry)
  visibleDrafts.set(saveKey, entry)
  // A new edit remains unsaved, but the previous request's error no longer
  // describes the snapshot that will be retried.
  failedSaves.delete(saveKey)
  publishSnapshot()
}

/**
 * Serialize writes for one chapter. Failed entries are restored to this
 * module-level queue, so switching pages/components cannot discard the draft.
 */
export function flushEditorSave(project: string, chapterId: number, writer: EditorSaveWriter): Promise<void> {
  const saveKey = editorSaveKey(project, chapterId)
  const pending = pendingSaves.get(saveKey)
  if (!pending) return saveQueues.get(saveKey) ?? Promise.resolve()
  pendingSaves.delete(saveKey)
  const requestEpoch = projectEpoch(project)

  const previousSave = saveQueues.get(saveKey) ?? Promise.resolve()
  const currentSave = previousSave
    .catch(() => {})
    .then(() => {
      if (projectEpoch(project) !== requestEpoch) return
      if ((tombstoneGenerations.get(saveKey) ?? 0) !== pending.tombstoneGeneration) return
      // A newer snapshot may already have left pendingSaves and be waiting in
      // this serialized promise chain. Advance it immediately before its write,
      // using only a version confirmed by an earlier local CAS success.
      const confirmedDataVersion = confirmedDataVersions.get(saveKey)
      if (confirmedDataVersion !== undefined && confirmedDataVersion > pending.baseDataVersion) {
        pending.baseDataVersion = confirmedDataVersion
      }
      return writer(pending)
    })
    .then(
      (persistedDataVersion) => {
        if (projectEpoch(project) !== requestEpoch) return
        if ((tombstoneGenerations.get(saveKey) ?? 0) !== pending.tombstoneGeneration) return
        if (
          Number.isSafeInteger(persistedDataVersion) &&
          (persistedDataVersion as number) >= 0 &&
          (confirmedDataVersions.get(saveKey) ?? -1) < (persistedDataVersion as number)
        ) {
          confirmedDataVersions.set(saveKey, persistedDataVersion as number)
        }
        const visible = visibleDrafts.get(saveKey)
        if (visible?.version === pending.version) visibleDrafts.delete(saveKey)
        failedSaves.delete(saveKey)
        publishSnapshot()
      },
      (error) => {
        if (projectEpoch(project) !== requestEpoch) return
        if ((tombstoneGenerations.get(saveKey) ?? 0) !== pending.tombstoneGeneration) throw error
        const newerPending = pendingSaves.get(saveKey)
        const visible = visibleDrafts.get(saveKey)
        if (!newerPending && visible?.version === pending.version) {
          pendingSaves.set(saveKey, pending)
          failedSaves.set(saveKey, errorMessage(error))
        } else if (visible?.version !== pending.version) {
          // This request belongs to an older snapshot. Do not label the newer
          // draft as failed before its own serialized write has even run.
          failedSaves.delete(saveKey)
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
