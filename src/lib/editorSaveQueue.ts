import type { ManuscriptBaseWitness } from './api.ts'
import {
  discardManuscriptDirtyResource,
  isManuscriptSaveProtected,
  type ManuscriptDirtyBinding,
  markManuscriptResourceDirty,
  markManuscriptResourceSaving,
  settleManuscriptResource,
} from './manuscriptDirtyResources.ts'
import { assertManuscriptSaveAdmission } from './manuscriptHostSaveAdmission.ts'
import { isolateProjectDraft } from './projectDraftRecovery.ts'

export interface EditorSaveEntry {
  project: string
  chapterId: number
  chapterNum: number
  content: string
  baseDataVersion: number
  version: number
  tombstoneGeneration: number
  dirtyBinding?: ManuscriptDirtyBinding
  baseWitness?: ManuscriptBaseWitness
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
const failedSaveCodes = new Map<string, string>()
const confirmedDataVersions = new Map<string, number>()
const tombstoneGenerations = new Map<string, number>()
const projectEpochs = new Map<string, number>()
const listeners = new Set<() => void>()
type EditorHostDrainEntry = Readonly<{
  chapterId: number
  disposition: 'persisted' | 'unresolved'
  resourceUid: string
  revision: number
}>

const hostDrainEntries = new Map<string, EditorHostDrainEntry>()
const frozenHostEntries = new Map<string, ReadonlyMap<string, Omit<EditorHostDrainEntry, 'disposition'>>>()
const persistedVersions = new Map<string, number>()
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

export function getEditorSaveFailure(
  project: string,
  chapterId: number,
): Readonly<{ message: string; code: string | null }> | null {
  const saveKey = editorSaveKey(project, chapterId)
  const message = failedSaves.get(saveKey)
  if (message === undefined) return null
  return Object.freeze({ message, code: failedSaveCodes.get(saveKey) ?? null })
}

export function getEditorHostMigrationState(project: string) {
  const resources: Array<
    Readonly<{
      domain: 'body'
      loaded: false
      resourceKind: 'chapter'
      resourceUid: string
      revision: number
    }>
  > = []
  const queues: Array<
    Readonly<{
      domain: 'body'
      loaded: false
      queueId: string
      revision: number
      state: 'active' | 'cancelled_and_drained'
    }>
  > = []
  const entries = new Map<
    string,
    Readonly<{
      chapterId: number
      resourceUid: string
      revision: number
      state: 'active' | 'cancelled_and_drained'
    }>
  >()
  const frozen = frozenHostEntries.get(project)
  if (frozen) {
    for (const [saveKey, entry] of frozen) {
      entries.set(
        saveKey,
        Object.freeze({
          ...entry,
          state:
            hostDrainEntries.get(saveKey)?.revision === entry.revision
              ? ('cancelled_and_drained' as const)
              : ('active' as const),
        }),
      )
    }
  } else {
    for (const [saveKey, entry] of hostDrainEntries) {
      if (!saveKeyBelongsToProject(saveKey, project)) continue
      entries.set(saveKey, Object.freeze({ ...entry, state: 'cancelled_and_drained' as const }))
    }
  }
  for (const [saveKey, entry] of visibleDrafts) {
    if (!saveKeyBelongsToProject(saveKey, project)) continue
    const drained = hostDrainEntries.get(saveKey)
    if (drained?.revision === entry.version) continue
    entries.set(
      saveKey,
      Object.freeze({
        chapterId: entry.chapterId,
        resourceUid: entry.dirtyBinding?.identity.resourceUid ?? `sqlite-chapter-${entry.chapterId}`,
        revision: entry.version,
        state: 'active' as const,
      }),
    )
  }
  for (const entry of entries.values()) {
    resources.push(
      Object.freeze({
        domain: 'body',
        loaded: false,
        resourceKind: 'chapter',
        resourceUid: entry.resourceUid,
        revision: entry.revision,
      }),
    )
    queues.push(
      Object.freeze({
        domain: 'body',
        loaded: false,
        queueId: `editor:${entry.chapterId}`,
        revision: entry.revision,
        state: entry.state,
      }),
    )
  }
  resources.sort((left, right) => left.resourceUid.localeCompare(right.resourceUid))
  queues.sort((left, right) => left.queueId.localeCompare(right.queueId))
  return Object.freeze({ resources: Object.freeze(resources), queues: Object.freeze(queues) })
}

export function freezeEditorHostMigrationState(project: string): void {
  if (frozenHostEntries.has(project)) throw new TypeError('editor host migration state is already frozen')
  const captured = new Map<string, Omit<EditorHostDrainEntry, 'disposition'>>()
  for (const [saveKey, entry] of visibleDrafts) {
    if (!saveKeyBelongsToProject(saveKey, project)) continue
    captured.set(
      saveKey,
      Object.freeze({
        chapterId: entry.chapterId,
        resourceUid: entry.dirtyBinding?.identity.resourceUid ?? `sqlite-chapter-${entry.chapterId}`,
        revision: entry.version,
      }),
    )
  }
  frozenHostEntries.set(project, captured)
}

export async function cancelAndDrainEditorHostQueues(project: string) {
  if (!frozenHostEntries.has(project)) freezeEditorHostMigrationState(project)
  const captured = frozenHostEntries.get(project) as ReadonlyMap<string, Omit<EditorHostDrainEntry, 'disposition'>>
  const operations = [...saveQueues.entries()]
    .filter(([saveKey]) => saveKeyBelongsToProject(saveKey, project))
    .map(([, operation]) => operation)
  await Promise.allSettled(operations)
  const resolutions: Array<
    Readonly<{
      resourceUid: string
      domain: 'body'
      disposition: 'persisted' | 'unresolved'
    }>
  > = []
  for (const [saveKey, entry] of captured) {
    const resourceUid = entry.resourceUid
    const disposition = persistedVersions.get(saveKey) === entry.revision ? 'persisted' : 'unresolved'
    hostDrainEntries.set(
      saveKey,
      Object.freeze({
        chapterId: entry.chapterId,
        disposition,
        resourceUid,
        revision: entry.revision,
      }),
    )
    resolutions.push(
      Object.freeze({
        resourceUid,
        domain: 'body',
        disposition,
      }),
    )
  }
  return Object.freeze(resolutions)
}

export function releaseEditorHostQueueDrain(project: string): void {
  for (const saveKey of [...hostDrainEntries.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) hostDrainEntries.delete(saveKey)
  }
  frozenHostEntries.delete(project)
}

function clearProjectEditorSaves(project: string): void {
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
  for (const saveKey of [...confirmedDataVersions.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) confirmedDataVersions.delete(saveKey)
  }
  for (const saveKey of [...tombstoneGenerations.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) tombstoneGenerations.delete(saveKey)
  }
  for (const saveKey of [...saveQueues.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) saveQueues.delete(saveKey)
  }
  for (const saveKey of [...hostDrainEntries.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) hostDrainEntries.delete(saveKey)
  }
  for (const saveKey of [...persistedVersions.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) persistedVersions.delete(saveKey)
  }
  frozenHostEntries.delete(project)
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
  const dirtyBinding = visibleDrafts.get(saveKey)?.dirtyBinding
  tombstoneGenerations.set(saveKey, (tombstoneGenerations.get(saveKey) ?? 0) + 1)
  pendingSaves.delete(saveKey)
  visibleDrafts.delete(saveKey)
  failedSaves.delete(saveKey)
  failedSaveCodes.delete(saveKey)
  confirmedDataVersions.delete(saveKey)
  if (dirtyBinding) discardManuscriptDirtyResource(dirtyBinding)
  publishSnapshot()
}

export function enqueueEditorSave(
  project: string,
  chapterId: number,
  chapterNum: number,
  content: string,
  baseDataVersion: number,
  dirtyBinding?: ManuscriptDirtyBinding,
  baseWitness?: ManuscriptBaseWitness,
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
    dirtyBinding: existingDraft ? existingDraft.dirtyBinding : dirtyBinding,
    baseWitness: existingDraft ? existingDraft.baseWitness : snapshotBaseWitness(baseWitness),
  }
  pendingSaves.set(saveKey, entry)
  visibleDrafts.set(saveKey, entry)
  // A new edit remains unsaved, but the previous request's error no longer
  // describes the snapshot that will be retried.
  failedSaves.delete(saveKey)
  failedSaveCodes.delete(saveKey)
  if (entry.dirtyBinding) markManuscriptResourceDirty(entry.dirtyBinding, entry.version, { content })
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
  assertManuscriptSaveAdmission(project)
  hostDrainEntries.delete(saveKey)
  pendingSaves.delete(saveKey)
  const requestEpoch = projectEpoch(project)
  const requestId = `editor-save-${pending.version}`

  const previousSave = saveQueues.get(saveKey) ?? Promise.resolve()
  const currentSave = previousSave
    .catch(() => {})
    .then(() => {
      if (projectEpoch(project) !== requestEpoch) return
      if ((tombstoneGenerations.get(saveKey) ?? 0) !== pending.tombstoneGeneration) return
      if (pending.dirtyBinding) {
        markManuscriptResourceSaving(pending.dirtyBinding, pending.version, requestId)
      }
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
        persistedVersions.set(saveKey, pending.version)
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
        failedSaveCodes.delete(saveKey)
        if (pending.dirtyBinding) {
          settleManuscriptResource(pending.dirtyBinding, pending.version, requestId, 'saved')
        }
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
        } else if (visible?.version !== pending.version) {
          // This request belongs to an older snapshot. Do not label the newer
          // draft as failed before its own serialized write has even run.
          failedSaves.delete(saveKey)
          failedSaveCodes.delete(saveKey)
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
