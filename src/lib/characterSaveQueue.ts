import { ApiError, charactersApi } from './api.ts'
import { getProjectInstanceId } from './projectInstanceRegistry.ts'

export type EditableCharacterField =
  | 'name'
  | 'age'
  | 'gender'
  | 'role'
  | 'appearance'
  | 'personality'
  | 'background'
  | 'motivation'
  | 'arc'

export type CharacterChangeSet = Partial<Record<EditableCharacterField, string>>

type ConfirmableCharacter = { id: string } & Partial<Record<EditableCharacterField, unknown>>

interface PendingCharacterChanges {
  project: string
  characterId: string
  projectInstanceId?: string
  changes: CharacterChangeSet
  versions: Partial<Record<EditableCharacterField, number>>
}

interface FailedFieldSave {
  version: number
  message: string
}

interface FailedCharacterSave {
  project: string
  fields: Partial<Record<EditableCharacterField, FailedFieldSave>>
}

interface PersistedCharacterOutboxEntry extends PendingCharacterChanges {
  projectInstanceId?: string
  failures?: Partial<Record<EditableCharacterField, FailedFieldSave>>
}

interface PersistedCharacterOutbox {
  version: 1 | 2 | 3
  entries: PersistedCharacterOutboxEntry[]
}

export interface RecoverableCharacterDraft {
  characterId: string
  changes: CharacterChangeSet
  failures: Partial<Record<EditableCharacterField, string>>
  recoveryKey?: string
  isolated?: true
}

export interface CharacterSaveSnapshot {
  overlays: Readonly<Record<string, CharacterChangeSet>>
  errors: Readonly<Record<string, string>>
}

export const CHARACTER_SAVE_OUTBOX_STORAGE_KEY = 'mythpen-character-save-outbox-v1'

const AUTO_SAVE_DELAY_MS = 500
const editableFields = new Set<EditableCharacterField>([
  'name',
  'age',
  'gender',
  'role',
  'appearance',
  'personality',
  'background',
  'motivation',
  'arc',
])

const pendingChanges = new Map<string, PendingCharacterChanges>()
const durableOutbox = new Map<string, PersistedCharacterOutboxEntry>()
const isolatedOutbox = new Map<string, PersistedCharacterOutboxEntry>()
const saveQueues = new Map<string, Promise<void>>()
const fieldVersions = new Map<string, Partial<Record<EditableCharacterField, number>>>()
const confirmationVersions = new Map<string, Partial<Record<EditableCharacterField, number>>>()
const authoritativeVersions = new Map<string, Partial<Record<EditableCharacterField, number>>>()
const confirmationRequests = new Map<string, Promise<void>>()
const overlayChanges = new Map<string, CharacterChangeSet>()
const failedSaves = new Map<string, FailedCharacterSave>()
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const projectEpochs = new Map<string, number>()
const listeners = new Set<() => void>()
let saveNotifier: ((project: string, characterId: string) => void) | null = null
let nextEditVersion = 0
let snapshot: CharacterSaveSnapshot = { overlays: {}, errors: {} }

export function characterSaveKey(project: string, characterId: string): string {
  return `${project}\u0000${characterId}`
}

function isolatedCharacterSaveKey(entry: PersistedCharacterOutboxEntry): string {
  return `${characterSaveKey(entry.project, entry.characterId)}\u0000${entry.projectInstanceId ?? 'legacy'}`
}

function projectEpoch(project: string): number {
  return projectEpochs.get(project) ?? 0
}

function saveKeyBelongsToProject(saveKey: string, project: string): boolean {
  return saveKey.startsWith(`${project}\u0000`)
}

function changedCharacterFields(
  changes: Readonly<Partial<Record<EditableCharacterField, unknown>>>,
): EditableCharacterField[] {
  return Object.keys(changes) as EditableCharacterField[]
}

function publishSnapshot() {
  const overlays: Record<string, CharacterChangeSet> = {}
  for (const [saveKey, changes] of overlayChanges) overlays[saveKey] = { ...changes }

  const messagesByProject = new Map<string, Set<string>>()
  for (const failure of failedSaves.values()) {
    const messages = messagesByProject.get(failure.project) ?? new Set<string>()
    for (const fieldFailure of Object.values(failure.fields)) {
      if (fieldFailure) messages.add(fieldFailure.message)
    }
    messagesByProject.set(failure.project, messages)
  }

  const errors: Record<string, string> = {}
  for (const [project, messages] of messagesByProject) errors[project] = [...messages].join('；')

  snapshot = { overlays, errors }
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A stale UI subscriber must not break the persistent save queue.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecoverableMissingCharacter(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'DB_NOT_FOUND' && error.recoverable
}

function comparableFieldValue(field: EditableCharacterField, value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return field === 'name' ? text.trim() : text
}

function getOutboxStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function persistOutbox(): void {
  const storage = getOutboxStorage()
  if (!storage) return

  try {
    if (durableOutbox.size === 0 && isolatedOutbox.size === 0) {
      storage.removeItem(CHARACTER_SAVE_OUTBOX_STORAGE_KEY)
      return
    }

    const persisted: PersistedCharacterOutbox = {
      version: 3,
      entries: [
        ...[...durableOutbox.entries()].map(([saveKey, entry]) => {
          const failures: Partial<Record<EditableCharacterField, FailedFieldSave>> = {}
          const failedFields = failedSaves.get(saveKey)?.fields
          for (const field of changedCharacterFields(entry.changes)) {
            const failure = failedFields?.[field]
            if (failure && failure.version === entry.versions[field]) {
              failures[field] = { version: failure.version, message: failure.message }
            }
          }
          return {
            ...entry,
            changes: { ...entry.changes },
            versions: { ...entry.versions },
            failures,
          }
        }),
        ...[...isolatedOutbox.values()].map((entry) => ({
          ...entry,
          changes: { ...entry.changes },
          versions: { ...entry.versions },
          failures: { ...entry.failures },
        })),
      ],
    }
    storage.setItem(CHARACTER_SAVE_OUTBOX_STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // localStorage can be disabled or full. The in-memory queue still remains usable.
  }
}

function readPersistedOutbox(): PersistedCharacterOutboxEntry[] {
  const storage = getOutboxStorage()
  if (!storage) return []

  try {
    const raw = storage.getItem(CHARACTER_SAVE_OUTBOX_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<PersistedCharacterOutbox>
    if ((parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) || !Array.isArray(parsed.entries)) {
      return []
    }

    const entries: PersistedCharacterOutboxEntry[] = []
    for (const candidate of parsed.entries) {
      if (
        !candidate ||
        typeof candidate.project !== 'string' ||
        !candidate.project ||
        typeof candidate.characterId !== 'string' ||
        !candidate.characterId ||
        !candidate.changes ||
        !candidate.versions
      ) {
        continue
      }

      const changes: CharacterChangeSet = {}
      const versions: Partial<Record<EditableCharacterField, number>> = {}
      const failures: Partial<Record<EditableCharacterField, FailedFieldSave>> = {}
      for (const [unvalidatedField, value] of Object.entries(candidate.changes)) {
        const field = unvalidatedField as EditableCharacterField
        const version = candidate.versions[field]
        if (
          !editableFields.has(field) ||
          typeof value !== 'string' ||
          typeof version !== 'number' ||
          !Number.isSafeInteger(version) ||
          version < 1
        ) {
          continue
        }
        changes[field] = value
        versions[field] = version
        const failure = candidate.failures?.[field]
        if (
          (parsed.version === 2 || parsed.version === 3) &&
          failure &&
          failure.version === version &&
          typeof failure.message === 'string' &&
          failure.message
        ) {
          failures[field] = { version, message: failure.message }
        }
      }
      if (Object.keys(changes).length > 0) {
        const projectInstanceId =
          parsed.version === 3 && typeof candidate.projectInstanceId === 'string' && candidate.projectInstanceId
            ? candidate.projectInstanceId
            : undefined
        entries.push({
          project: candidate.project,
          characterId: candidate.characterId,
          changes,
          versions,
          projectInstanceId,
          failures,
        })
      }
    }
    return entries
  } catch {
    return []
  }
}

function mergeIsolatedOutboxEntry(entry: PersistedCharacterOutboxEntry): string {
  const recoveryKey = isolatedCharacterSaveKey(entry)
  const current = isolatedOutbox.get(recoveryKey)
  const changes: CharacterChangeSet = { ...current?.changes }
  const versions = { ...current?.versions }
  const failures = { ...current?.failures }

  for (const field of changedCharacterFields(entry.changes)) {
    const version = entry.versions[field]
    const currentVersion = versions[field] ?? 0
    if (version === undefined || version < currentVersion) continue
    changes[field] = entry.changes[field]
    versions[field] = version
    const failure = entry.failures?.[field]
    if (failure?.version === version) failures[field] = { ...failure }
    else if (version > currentVersion) delete failures[field]
  }

  isolatedOutbox.set(recoveryKey, {
    project: entry.project,
    characterId: entry.characterId,
    projectInstanceId: entry.projectInstanceId,
    changes,
    versions,
    failures,
  })
  return recoveryKey
}

function clearAutoSave(saveKey: string): void {
  const timer = autoSaveTimers.get(saveKey)
  if (timer !== undefined) clearTimeout(timer)
  autoSaveTimers.delete(saveKey)
}

function isolateActiveCharacterDraft(saveKey: string, expectedInstanceId?: string): boolean {
  const entry = durableOutbox.get(saveKey)
  if (!entry || entry.projectInstanceId !== expectedInstanceId) return false

  const failures: Partial<Record<EditableCharacterField, FailedFieldSave>> = {}
  const activeFailures = failedSaves.get(saveKey)?.fields
  for (const field of changedCharacterFields(entry.changes)) {
    const failure = activeFailures?.[field]
    if (failure && failure.version === entry.versions[field]) {
      failures[field] = { version: failure.version, message: failure.message }
    }
  }
  mergeIsolatedOutboxEntry({ ...entry, failures })

  clearAutoSave(saveKey)
  pendingChanges.delete(saveKey)
  durableOutbox.delete(saveKey)
  fieldVersions.delete(saveKey)
  confirmationVersions.delete(saveKey)
  authoritativeVersions.delete(saveKey)
  confirmationRequests.delete(saveKey)
  overlayChanges.delete(saveKey)
  failedSaves.delete(saveKey)
  persistOutbox()
  publishSnapshot()
  return true
}

function isolateStalePendingChanges(saveKey: string, pending: PendingCharacterChanges): void {
  if (isolateActiveCharacterDraft(saveKey, pending.projectInstanceId)) return
  mergeIsolatedOutboxEntry({ ...pending, failures: {} })
  persistOutbox()
  publishSnapshot()
}

function scheduleAutoSave(project: string, characterId: string): void {
  const saveKey = characterSaveKey(project, characterId)
  clearAutoSave(saveKey)
  const timer = setTimeout(() => {
    autoSaveTimers.delete(saveKey)
    void flushCharacterChanges(project, characterId).catch(() => {
      // The durable outbox and the visible retry action retain a failed write.
    })
  }, AUTO_SAVE_DELAY_MS)
  autoSaveTimers.set(saveKey, timer)
}

function mergePersistedEntry(entry: PersistedCharacterOutboxEntry): boolean {
  const saveKey = characterSaveKey(entry.project, entry.characterId)
  const currentVersions = fieldVersions.get(saveKey) ?? {}
  const currentPending = pendingChanges.get(saveKey)
  const currentOutbox = durableOutbox.get(saveKey)
  const currentOverlay = overlayChanges.get(saveKey) ?? {}
  const currentFailure = failedSaves.get(saveKey)
  let changed = false
  const pendingFields: CharacterChangeSet = { ...currentPending?.changes }
  const pendingVersions = { ...currentPending?.versions }
  const outboxFields: CharacterChangeSet = { ...currentOutbox?.changes }
  const outboxVersions = { ...currentOutbox?.versions }
  const nextVersions = { ...currentVersions }
  const nextOverlay = { ...currentOverlay }
  const nextFailureFields = { ...currentFailure?.fields }

  for (const field of changedCharacterFields(entry.changes)) {
    const persistedVersion = entry.versions[field]
    if (persistedVersion === undefined || (currentVersions[field] ?? 0) >= persistedVersion) continue
    const value = entry.changes[field]
    pendingFields[field] = value
    pendingVersions[field] = persistedVersion
    outboxFields[field] = value
    outboxVersions[field] = persistedVersion
    nextVersions[field] = persistedVersion
    nextOverlay[field] = value
    const persistedFailure = entry.failures?.[field]
    if (persistedFailure?.version === persistedVersion) nextFailureFields[field] = { ...persistedFailure }
    else delete nextFailureFields[field]
    nextEditVersion = Math.max(nextEditVersion, persistedVersion)
    changed = true
  }

  if (!changed) return false
  pendingChanges.set(saveKey, {
    project: entry.project,
    characterId: entry.characterId,
    projectInstanceId: entry.projectInstanceId,
    changes: pendingFields,
    versions: pendingVersions,
  })
  durableOutbox.set(saveKey, {
    project: entry.project,
    characterId: entry.characterId,
    changes: outboxFields,
    versions: outboxVersions,
    projectInstanceId: entry.projectInstanceId,
  })
  fieldVersions.set(saveKey, nextVersions)
  overlayChanges.set(saveKey, nextOverlay)
  if (Object.keys(nextFailureFields).length === 0) failedSaves.delete(saveKey)
  else failedSaves.set(saveKey, { project: entry.project, fields: nextFailureFields })
  scheduleAutoSave(entry.project, entry.characterId)
  return true
}

/**
 * Rehydrate durable edits on application startup or when entering a project.
 * Replaying is idempotent and never overwrites a newer edit already in memory.
 */
export function replayPersistedCharacterChanges(project?: string): void {
  let changed = false
  let accepted = false
  for (const [recoveryKey, entry] of [...isolatedOutbox]) {
    if (project !== undefined && entry.project !== project) continue
    const currentInstanceId = getProjectInstanceId(entry.project)
    if (!currentInstanceId || entry.projectInstanceId !== currentInstanceId) continue
    isolatedOutbox.delete(recoveryKey)
    accepted = true
    changed = mergePersistedEntry(entry) || changed
  }
  if (accepted) persistOutbox()
  if (changed) {
    publishSnapshot()
  }
}

/** Return durable drafts whose original character is absent from the latest list. */
export function getRecoverableCharacterDrafts(
  project: string,
  existingCharacterIds: readonly string[],
): RecoverableCharacterDraft[] {
  const existingIds = new Set(existingCharacterIds)
  const drafts: RecoverableCharacterDraft[] = []
  for (const [saveKey, entry] of durableOutbox) {
    if (entry.project !== project || existingIds.has(entry.characterId)) continue
    const failures: Partial<Record<EditableCharacterField, string>> = {}
    for (const [field, failure] of Object.entries(failedSaves.get(saveKey)?.fields ?? {})) {
      if (failure) failures[field as EditableCharacterField] = failure.message
    }
    drafts.push({ characterId: entry.characterId, changes: { ...entry.changes }, failures })
  }
  for (const [recoveryKey, entry] of isolatedOutbox) {
    if (entry.project !== project) continue
    const failures: Partial<Record<EditableCharacterField, string>> = {}
    for (const [field, failure] of Object.entries(entry.failures ?? {})) {
      if (failure) failures[field as EditableCharacterField] = failure.message
    }
    drafts.push({
      characterId: entry.characterId,
      changes: { ...entry.changes },
      failures,
      recoveryKey,
      isolated: true,
    })
  }
  return drafts
}

/** Explicitly discard a durable draft after the user confirms it is no longer needed. */
export function discardCharacterDraft(project: string, characterId: string, recoveryKey?: string): boolean {
  if (recoveryKey) {
    const entry = isolatedOutbox.get(recoveryKey)
    if (!entry || entry.project !== project || entry.characterId !== characterId) return false
    isolatedOutbox.delete(recoveryKey)
    persistOutbox()
    publishSnapshot()
    return true
  }

  const saveKey = characterSaveKey(project, characterId)
  const existed = durableOutbox.has(saveKey) || overlayChanges.has(saveKey)
  clearAutoSave(saveKey)
  pendingChanges.delete(saveKey)
  durableOutbox.delete(saveKey)
  fieldVersions.delete(saveKey)
  confirmationVersions.delete(saveKey)
  authoritativeVersions.delete(saveKey)
  overlayChanges.delete(saveKey)
  failedSaves.delete(saveKey)
  persistOutbox()
  if (existed) publishSnapshot()
  return existed
}

/** Permanently remove every queued, durable, and visible edit for a deleted project. */
export function discardProjectCharacterChanges(project: string): void {
  projectEpochs.set(project, projectEpoch(project) + 1)
  const maps: Array<Pick<Map<string, unknown>, 'keys' | 'delete'>> = [
    pendingChanges,
    durableOutbox,
    saveQueues,
    fieldVersions,
    confirmationVersions,
    authoritativeVersions,
    confirmationRequests,
    overlayChanges,
    failedSaves,
  ]
  for (const saveKey of [...autoSaveTimers.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) clearAutoSave(saveKey)
  }
  for (const map of maps) {
    for (const saveKey of [...map.keys()]) {
      if (saveKeyBelongsToProject(saveKey, project)) map.delete(saveKey)
    }
  }
  for (const [recoveryKey, entry] of isolatedOutbox) {
    if (entry.project === project) isolatedOutbox.delete(recoveryKey)
  }
  persistOutbox()
  publishSnapshot()
}

/**
 * Retire active UI state when an authoritative project list proves that a
 * name now identifies a different database. Unsaved fields stay recoverable in
 * the isolated outbox, but overlays and callbacks from the deleted instance
 * must not be shown or committed in the replacement project.
 */
export function retireStaleProjectCharacterInstance(project: string): void {
  projectEpochs.set(project, projectEpoch(project) + 1)
  const currentInstanceId = getProjectInstanceId(project)
  for (const [saveKey, entry] of [...durableOutbox]) {
    if (entry.project === project && entry.projectInstanceId !== currentInstanceId) {
      isolateActiveCharacterDraft(saveKey, entry.projectInstanceId)
    }
  }

  const maps: Array<Pick<Map<string, unknown>, 'keys' | 'delete'>> = [
    pendingChanges,
    durableOutbox,
    saveQueues,
    fieldVersions,
    confirmationVersions,
    authoritativeVersions,
    confirmationRequests,
    overlayChanges,
    failedSaves,
  ]
  for (const saveKey of [...autoSaveTimers.keys()]) {
    if (saveKeyBelongsToProject(saveKey, project)) clearAutoSave(saveKey)
  }
  for (const map of maps) {
    for (const saveKey of [...map.keys()]) {
      if (saveKeyBelongsToProject(saveKey, project)) map.delete(saveKey)
    }
  }
  persistOutbox()
  publishSnapshot()
}

export function setCharacterSaveNotifier(notifier: ((project: string, characterId: string) => void) | null): void {
  saveNotifier = notifier
}

export function subscribeCharacterSaveQueue(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCharacterSaveSnapshot(): CharacterSaveSnapshot {
  return snapshot
}

function removeOverlayFields(saveKey: string, fields: readonly EditableCharacterField[]): boolean {
  const overlay = overlayChanges.get(saveKey)
  if (!overlay) return false
  const nextOverlay = { ...overlay }
  for (const field of fields) delete nextOverlay[field]
  if (Object.keys(nextOverlay).length === 0) overlayChanges.delete(saveKey)
  else overlayChanges.set(saveKey, nextOverlay)
  return true
}

/**
 * A normal list response can acknowledge an overlay when it contains the exact
 * saved value. Mismatches remain masked until the dedicated post-save list
 * request resolves, because this response may have started before the PUT.
 */
export function confirmCharacterChanges(project: string, characters: readonly ConfirmableCharacter[]): void {
  let changed = false
  const seenCharacterIds = new Set<string>()

  for (const character of characters) {
    seenCharacterIds.add(character.id)
    const saveKey = characterSaveKey(project, character.id)
    const overlay = overlayChanges.get(saveKey)
    if (!overlay) continue

    const versions = fieldVersions.get(saveKey) ?? {}
    const confirmations = confirmationVersions.get(saveKey) ?? {}
    const authorities = authoritativeVersions.get(saveKey) ?? {}
    const confirmedFields: EditableCharacterField[] = []
    let needsAuthoritativeRetry = false
    for (const field of changedCharacterFields(overlay)) {
      if (versions[field] !== undefined) continue
      const confirmationVersion = confirmations[field]
      if (
        confirmationVersion !== undefined &&
        authorities[field] === confirmationVersion &&
        comparableFieldValue(field, character[field]) === comparableFieldValue(field, overlay[field])
      ) {
        confirmedFields.push(field)
        delete confirmations[field]
        delete authorities[field]
      } else if (confirmationVersion !== undefined) {
        needsAuthoritativeRetry = true
      }
    }

    if (confirmedFields.length > 0) changed = removeOverlayFields(saveKey, confirmedFields) || changed
    if (Object.keys(confirmations).length === 0) confirmationVersions.delete(saveKey)
    else confirmationVersions.set(saveKey, confirmations)
    if (Object.keys(authorities).length === 0) authoritativeVersions.delete(saveKey)
    else authoritativeVersions.set(saveKey, authorities)
    if (needsAuthoritativeRetry) requestPostSaveConfirmation(project, character.id, { ...confirmations })
  }

  const projectPrefix = `${project}\u0000`
  for (const [saveKey, confirmations] of confirmationVersions) {
    if (!saveKey.startsWith(projectPrefix)) continue
    const characterId = saveKey.slice(projectPrefix.length)
    if (!seenCharacterIds.has(characterId)) {
      requestPostSaveConfirmation(project, characterId, { ...confirmations })
    }
  }

  if (changed) publishSnapshot()
}

function reconcilePostSaveResponse(
  project: string,
  characters: readonly ConfirmableCharacter[],
  expectedVersions: Readonly<Partial<Record<EditableCharacterField, number>>>,
  characterId: string,
): void {
  const saveKey = characterSaveKey(project, characterId)
  const currentVersions = fieldVersions.get(saveKey) ?? {}
  const confirmations = confirmationVersions.get(saveKey) ?? {}
  const authorities = authoritativeVersions.get(saveKey) ?? {}
  const authoritativeCharacter = characters.find((character) => character.id === characterId)
  const currentOverlay = overlayChanges.get(saveKey) ?? {}
  const nextOverlay = { ...currentOverlay }
  let matchedGeneration = false
  let changed = false

  for (const field of changedCharacterFields(expectedVersions)) {
    const expectedVersion = expectedVersions[field]
    if (
      expectedVersion !== undefined &&
      confirmations[field] === expectedVersion &&
      currentVersions[field] === undefined
    ) {
      matchedGeneration = true
      if (authoritativeCharacter) {
        const authoritativeValue =
          authoritativeCharacter[field] === null || authoritativeCharacter[field] === undefined
            ? ''
            : String(authoritativeCharacter[field])
        if (nextOverlay[field] !== authoritativeValue) changed = true
        nextOverlay[field] = authoritativeValue
        authorities[field] = expectedVersion
      } else {
        if (field in nextOverlay) changed = true
        delete nextOverlay[field]
        delete confirmations[field]
        delete authorities[field]
      }
    }
  }

  if (!matchedGeneration) return
  if (Object.keys(nextOverlay).length === 0) overlayChanges.delete(saveKey)
  else overlayChanges.set(saveKey, nextOverlay)
  if (Object.keys(confirmations).length === 0) confirmationVersions.delete(saveKey)
  else confirmationVersions.set(saveKey, confirmations)
  if (Object.keys(authorities).length === 0) authoritativeVersions.delete(saveKey)
  else authoritativeVersions.set(saveKey, authorities)
  if (changed) publishSnapshot()
  saveNotifier?.(project, characterId)
}

function requestPostSaveConfirmation(
  project: string,
  characterId: string,
  versions: Readonly<Partial<Record<EditableCharacterField, number>>>,
): void {
  const saveKey = characterSaveKey(project, characterId)
  if (confirmationRequests.has(saveKey)) return
  const requestEpoch = projectEpoch(project)
  const requestInstanceId = getProjectInstanceId(project)
  if (!requestInstanceId) return

  let trackedRequest!: Promise<void>
  trackedRequest = (charactersApi.list(project) as Promise<ConfirmableCharacter[]>)
    .then(
      (characters) => {
        if (projectEpoch(project) !== requestEpoch || getProjectInstanceId(project) !== requestInstanceId) return
        reconcilePostSaveResponse(project, characters, versions, characterId)
      },
      () => {
        if (projectEpoch(project) !== requestEpoch || getProjectInstanceId(project) !== requestInstanceId) return
        // Trigger a fresh ordinary list request. If it differs from the overlay,
        // confirmCharacterChanges will start another deduplicated authority GET.
        saveNotifier?.(project, characterId)
      },
    )
    .finally(() => {
      if (projectEpoch(project) !== requestEpoch || getProjectInstanceId(project) !== requestInstanceId) return
      if (confirmationRequests.get(saveKey) === trackedRequest) confirmationRequests.delete(saveKey)
      const latestConfirmations = confirmationVersions.get(saveKey)
      const newerGenerationIsWaiting =
        latestConfirmations &&
        changedCharacterFields(latestConfirmations).some((field) => latestConfirmations[field] !== versions[field])
      if (newerGenerationIsWaiting) {
        requestPostSaveConfirmation(project, characterId, { ...latestConfirmations })
      }
    })
  confirmationRequests.set(saveKey, trackedRequest)
}

export function enqueueCharacterChange(
  project: string,
  characterId: string,
  field: EditableCharacterField,
  value: string,
) {
  const saveKey = characterSaveKey(project, characterId)
  const projectInstanceId = getProjectInstanceId(project)
  const existingOutbox = durableOutbox.get(saveKey)
  if (existingOutbox && existingOutbox.projectInstanceId !== projectInstanceId) {
    isolateActiveCharacterDraft(saveKey, existingOutbox.projectInstanceId)
  }
  const version = ++nextEditVersion
  const currentVersions = fieldVersions.get(saveKey) ?? {}
  const currentPending = pendingChanges.get(saveKey)
  const currentOutbox = durableOutbox.get(saveKey)
  const currentFailure = failedSaves.get(saveKey)
  const currentAuthorities = authoritativeVersions.get(saveKey)

  fieldVersions.set(saveKey, { ...currentVersions, [field]: version })
  pendingChanges.set(saveKey, {
    project,
    characterId,
    projectInstanceId,
    changes: { ...currentPending?.changes, [field]: value },
    versions: { ...currentPending?.versions, [field]: version },
  })
  durableOutbox.set(saveKey, {
    project,
    characterId,
    changes: { ...currentOutbox?.changes, [field]: value },
    versions: { ...currentOutbox?.versions, [field]: version },
    projectInstanceId,
  })
  overlayChanges.set(saveKey, { ...overlayChanges.get(saveKey), [field]: value })
  if (currentAuthorities?.[field] !== undefined) {
    const nextAuthorities = { ...currentAuthorities }
    delete nextAuthorities[field]
    if (Object.keys(nextAuthorities).length === 0) authoritativeVersions.delete(saveKey)
    else authoritativeVersions.set(saveKey, nextAuthorities)
  }

  if (currentFailure?.fields[field]) {
    const nextFailureFields = { ...currentFailure.fields }
    delete nextFailureFields[field]
    if (Object.keys(nextFailureFields).length === 0) failedSaves.delete(saveKey)
    else failedSaves.set(saveKey, { ...currentFailure, fields: nextFailureFields })
  }

  persistOutbox()
  scheduleAutoSave(project, characterId)
  publishSnapshot()
}

function removeSavedOutboxFields(saveKey: string, savedFields: readonly EditableCharacterField[]): void {
  const outbox = durableOutbox.get(saveKey)
  if (!outbox) return
  const nextChanges = { ...outbox.changes }
  const nextVersions = { ...outbox.versions }
  for (const field of savedFields) {
    delete nextChanges[field]
    delete nextVersions[field]
  }
  if (Object.keys(nextChanges).length === 0) durableOutbox.delete(saveKey)
  else durableOutbox.set(saveKey, { ...outbox, changes: nextChanges, versions: nextVersions })
}

function clearSavedFieldFailures(
  saveKey: string,
  savedVersions: Readonly<Partial<Record<EditableCharacterField, number>>>,
): void {
  const failure = failedSaves.get(saveKey)
  if (!failure) return
  const nextFields = { ...failure.fields }
  for (const field of changedCharacterFields(savedVersions)) {
    if (nextFields[field]?.version === savedVersions[field]) delete nextFields[field]
  }
  if (Object.keys(nextFields).length === 0) failedSaves.delete(saveKey)
  else failedSaves.set(saveKey, { ...failure, fields: nextFields })
}

/**
 * Prefer fields that have not already failed at their current edit version.
 * A known-bad field remains independently retryable instead of being merged
 * into every later edit for the same character.
 */
function takePendingCharacterChanges(saveKey: string): PendingCharacterChanges | undefined {
  const queued = pendingChanges.get(saveKey)
  if (!queued) return undefined

  const queuedFields = changedCharacterFields(queued.changes)
  const failedFields = failedSaves.get(saveKey)?.fields
  const freshFields = queuedFields.filter((field) => failedFields?.[field]?.version !== queued.versions[field])
  const fieldsToSave = freshFields.length > 0 ? freshFields : queuedFields
  const changes: CharacterChangeSet = {}
  const versions: Partial<Record<EditableCharacterField, number>> = {}
  const remainingChanges: CharacterChangeSet = {}
  const remainingVersions: Partial<Record<EditableCharacterField, number>> = {}
  const selectedFields = new Set(fieldsToSave)

  for (const field of queuedFields) {
    const targetChanges = selectedFields.has(field) ? changes : remainingChanges
    const targetVersions = selectedFields.has(field) ? versions : remainingVersions
    targetChanges[field] = queued.changes[field]
    targetVersions[field] = queued.versions[field]
  }

  if (Object.keys(remainingChanges).length === 0) pendingChanges.delete(saveKey)
  else {
    pendingChanges.set(saveKey, {
      project: queued.project,
      characterId: queued.characterId,
      projectInstanceId: queued.projectInstanceId,
      changes: remainingChanges,
      versions: remainingVersions,
    })
  }

  return {
    project: queued.project,
    characterId: queued.characterId,
    projectInstanceId: queued.projectInstanceId,
    changes,
    versions,
  }
}

export function flushCharacterChanges(project: string, characterId: string): Promise<void> {
  const saveKey = characterSaveKey(project, characterId)
  const activeOutboxEntry = durableOutbox.get(saveKey)
  const currentInstanceId = getProjectInstanceId(project)
  if (activeOutboxEntry && (!currentInstanceId || activeOutboxEntry.projectInstanceId !== currentInstanceId)) {
    isolateActiveCharacterDraft(saveKey, activeOutboxEntry.projectInstanceId)
    return Promise.resolve()
  }
  const pending = takePendingCharacterChanges(saveKey)
  if (!pending) return saveQueues.get(saveKey) ?? Promise.resolve()
  clearAutoSave(saveKey)
  const requestEpoch = projectEpoch(project)

  const previousSave = saveQueues.get(saveKey) ?? Promise.resolve()
  const currentSave = previousSave
    .catch(() => {})
    .then(async () => {
      if (projectEpoch(project) !== requestEpoch) return false
      const latestInstanceId = getProjectInstanceId(pending.project)
      if (!latestInstanceId || pending.projectInstanceId !== latestInstanceId) {
        isolateStalePendingChanges(saveKey, pending)
        return false
      }
      await charactersApi.update(pending.project, pending.characterId, pending.changes)
      return true
    })
    .then(
      (wasWritten) => {
        if (!wasWritten || projectEpoch(project) !== requestEpoch) return
        if (getProjectInstanceId(pending.project) !== pending.projectInstanceId) {
          isolateStalePendingChanges(saveKey, pending)
          return
        }
        const currentVersions = fieldVersions.get(saveKey) ?? {}
        const savedFields = changedCharacterFields(pending.changes).filter(
          (field) => currentVersions[field] === pending.versions[field],
        )

        if (savedFields.length > 0) {
          const nextVersions = { ...currentVersions }
          const nextConfirmations = { ...confirmationVersions.get(saveKey) }
          const savedVersions: Partial<Record<EditableCharacterField, number>> = {}
          for (const field of savedFields) {
            const version = pending.versions[field]
            delete nextVersions[field]
            nextConfirmations[field] = version
            const currentAuthorities = authoritativeVersions.get(saveKey)
            if (currentAuthorities?.[field] !== undefined) {
              const nextAuthorities = { ...currentAuthorities }
              delete nextAuthorities[field]
              if (Object.keys(nextAuthorities).length === 0) authoritativeVersions.delete(saveKey)
              else authoritativeVersions.set(saveKey, nextAuthorities)
            }
            savedVersions[field] = version
          }

          if (Object.keys(nextVersions).length === 0) fieldVersions.delete(saveKey)
          else fieldVersions.set(saveKey, nextVersions)
          confirmationVersions.set(saveKey, nextConfirmations)
          removeSavedOutboxFields(saveKey, savedFields)
          clearSavedFieldFailures(saveKey, savedVersions)
          persistOutbox()
          publishSnapshot()
          requestPostSaveConfirmation(pending.project, pending.characterId, savedVersions)
        }

        saveNotifier?.(pending.project, pending.characterId)
      },
      (error) => {
        if (projectEpoch(project) !== requestEpoch) return
        if (getProjectInstanceId(pending.project) !== pending.projectInstanceId) {
          isolateStalePendingChanges(saveKey, pending)
          return
        }
        const currentVersions = fieldVersions.get(saveKey) ?? {}
        const failedFields = changedCharacterFields(pending.changes).filter(
          (field) => currentVersions[field] === pending.versions[field],
        )
        if (failedFields.length === 0) return

        const restoredChanges: CharacterChangeSet = {}
        const restoredVersions: Partial<Record<EditableCharacterField, number>> = {}
        const nextFailureFields = { ...failedSaves.get(saveKey)?.fields }
        for (const field of failedFields) {
          const version = pending.versions[field]
          restoredChanges[field] = pending.changes[field]
          restoredVersions[field] = version
          if (version !== undefined) nextFailureFields[field] = { version, message: errorMessage(error) }
        }
        const newerPending = pendingChanges.get(saveKey)
        pendingChanges.set(saveKey, {
          project: pending.project,
          characterId: pending.characterId,
          projectInstanceId: pending.projectInstanceId,
          changes: { ...restoredChanges, ...newerPending?.changes },
          versions: { ...restoredVersions, ...newerPending?.versions },
        })
        failedSaves.set(saveKey, { project: pending.project, fields: nextFailureFields })
        persistOutbox()
        publishSnapshot()
        if (isRecoverableMissingCharacter(error)) saveNotifier?.(pending.project, pending.characterId)
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

export function flushProjectCharacterChanges(project: string): Promise<void> {
  const saves = [...pendingChanges.values()]
    .filter((pending) => pending.project === project)
    .map((pending) => flushCharacterChanges(pending.project, pending.characterId))
  return Promise.all(saves).then(() => {})
}

export function flushAllCharacterChanges(): Promise<void> {
  const saves = [...pendingChanges.values()].map((pending) =>
    flushCharacterChanges(pending.project, pending.characterId),
  )
  return Promise.all(saves).then(() => {})
}

function hydratePersistedCharacterChanges(): void {
  const entries = readPersistedOutbox()
  for (const entry of entries) mergeIsolatedOutboxEntry(entry)
  // Normalize accepted legacy payloads to v3 while deliberately leaving their
  // missing instance token intact. They remain recoverable but cannot replay.
  if (entries.length > 0) persistOutbox()
}

hydratePersistedCharacterChanges()
replayPersistedCharacterChanges()
