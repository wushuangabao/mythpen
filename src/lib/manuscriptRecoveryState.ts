type ConflictAction = 'accept_external' | 'apply_saved_draft'
type ConflictResolvedState = 'resolved_accept_external' | 'resolved_apply_draft'
type CapacityDimension =
  | 'chapterIdentities'
  | 'volumeIdentities'
  | 'markdownBytes'
  | 'jsonBytes'
  | 'controlledFiles'
  | 'chapterDirectoryEntries'
  | 'controlledBytes'

type ConflictIntent = Readonly<object>
type RefreshIntent = Readonly<object>
type RecoveryIntent = Readonly<object>

type ConflictDescription = Readonly<{
  conflictId: string
  decisionEpoch: number
  state: 'decision_ready'
  backupAvailable: boolean
}>

type CapacityWarning = Readonly<{
  dimension: CapacityDimension
  observed: number
  allowed: number
  ratio: number
}>

type FeedState = Readonly<{ mode: 'direct'; reason: null } | { mode: 'degraded'; reason: string }>

type IntentRecord = {
  readonly owner: ManuscriptRecoveryState
  readonly generation: number
  consumed: boolean
}

type ConflictIntentRecord = IntentRecord &
  Readonly<{
    action: ConflictAction
    conflictId: string
    decisionEpoch: number
  }>

type RefreshIntentRecord = IntentRecord & {
  cancelled: boolean
}

const conflictIntents = new WeakMap<object, ConflictIntentRecord>()
const refreshIntents = new WeakMap<object, RefreshIntentRecord>()
const recoveryIntents = new WeakMap<object, IntentRecord>()

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CAPACITY_DIMENSIONS = new Set<CapacityDimension>([
  'chapterIdentities',
  'volumeIdentities',
  'markdownBytes',
  'jsonBytes',
  'controlledFiles',
  'chapterDirectoryEntries',
  'controlledBytes',
])
const SAFE_REASON_PATTERN = /^[A-Z][A-Z0-9_]*$/u

function invalid(message: string): never {
  throw new TypeError(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactFrozenData<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, unknown> {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`)
  if (!Object.isFrozen(value)) invalid(`${label} must be frozen`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key as Key))) {
    invalid(`${label} has an inexact key set`)
  }
  const result = {} as Record<Key, unknown>
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || descriptor.enumerable !== true || !Reflect.has(descriptor, 'value')) {
      invalid(`${label}.${key} must be an enumerable own data property`)
    }
    result[key] = descriptor.value
  }
  return result
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) invalid(`${label} must be a canonical UUIDv4`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label)
  if (result === 0) invalid(`${label} must be positive`)
  return result
}

function assertIntent<T extends IntentRecord>(
  value: unknown,
  authority: WeakMap<object, T>,
  owner: ManuscriptRecoveryState,
  label: string,
): T {
  if (value === null || typeof value !== 'object') invalid(`${label} must be opaque`)
  const record = authority.get(value)
  if (record === undefined || record.owner !== owner) invalid(`${label} is foreign`)
  if (record.consumed) invalid(`${label} is consumed`)
  return record
}

function mintIntent<T extends IntentRecord>(authority: WeakMap<object, T>, record: T): Readonly<object> {
  const intent = Object.freeze({})
  authority.set(intent, record)
  return intent
}

function conflictDescription(value: unknown): ConflictDescription {
  const input = exactFrozenData(
    value,
    ['conflictId', 'decisionEpoch', 'state', 'backupAvailable'],
    'conflict description',
  )
  if (input.state !== 'decision_ready') invalid('conflict description.state is invalid')
  if (typeof input.backupAvailable !== 'boolean') invalid('conflict description.backupAvailable must be boolean')
  return Object.freeze({
    conflictId: canonicalUuid(input.conflictId, 'conflict description.conflictId'),
    decisionEpoch: nonNegativeInteger(input.decisionEpoch, 'conflict description.decisionEpoch'),
    state: 'decision_ready' as const,
    backupAvailable: input.backupAvailable,
  })
}

export class ManuscriptRecoveryState {
  #conflict: ConflictDescription | null = null
  #conflictGeneration = 0
  #recoveryGeneration = 0
  #recoveryRequired = false
  #refreshGeneration = 0
  #refreshCurrent: RefreshIntentRecord | null = null
  readonly #capacityWarnings = new Map<CapacityDimension, CapacityWarning>()
  #feed: FeedState = Object.freeze({ mode: 'direct', reason: null })

  observeConflict(value: unknown): void {
    this.#conflict = conflictDescription(value)
    this.#conflictGeneration += 1
  }

  beginConflictResolution(action: ConflictAction): ConflictIntent {
    if (action !== 'accept_external' && action !== 'apply_saved_draft') {
      invalid('conflict resolution action is invalid')
    }
    const conflict = this.#conflict
    if (conflict === null) invalid('no conflict is ready for resolution')
    if (action === 'apply_saved_draft' && !conflict.backupAvailable) {
      invalid('saved draft backup is unavailable')
    }
    return mintIntent(conflictIntents, {
      owner: this,
      generation: this.#conflictGeneration,
      consumed: false,
      action,
      conflictId: conflict.conflictId,
      decisionEpoch: conflict.decisionEpoch,
    })
  }

  completeConflictResolution(intent: ConflictIntent, value: unknown): void {
    const intentRecord = assertIntent(intent, conflictIntents, this, 'conflict resolution intent')
    const input = exactFrozenData(value, ['conflictId', 'decisionEpoch', 'state'], 'conflict resolution result')
    const conflictId = canonicalUuid(input.conflictId, 'conflict resolution result.conflictId')
    const decisionEpoch = nonNegativeInteger(input.decisionEpoch, 'conflict resolution result.decisionEpoch')
    const expectedState: ConflictResolvedState =
      intentRecord.action === 'accept_external' ? 'resolved_accept_external' : 'resolved_apply_draft'
    if (input.state !== expectedState) invalid('conflict resolution result does not match its intent')

    const conflict = this.#conflict
    if (
      conflict === null ||
      intentRecord.generation !== this.#conflictGeneration ||
      intentRecord.conflictId !== conflict.conflictId ||
      intentRecord.decisionEpoch !== conflict.decisionEpoch ||
      conflictId !== conflict.conflictId ||
      decisionEpoch !== conflict.decisionEpoch
    ) {
      intentRecord.consumed = true
      invalid('conflict resolution intent is stale')
    }
    intentRecord.consumed = true
    this.#conflict = null
  }

  observeCapacity(value: unknown): void {
    const input = exactFrozenData(value, ['dimension', 'observed', 'allowed'], 'capacity observation')
    if (typeof input.dimension !== 'string' || !CAPACITY_DIMENSIONS.has(input.dimension as CapacityDimension)) {
      invalid('capacity observation.dimension is invalid')
    }
    const dimension = input.dimension as CapacityDimension
    const observed = nonNegativeInteger(input.observed, 'capacity observation.observed')
    const allowed = positiveInteger(input.allowed, 'capacity observation.allowed')
    const ratio = observed / allowed
    if (ratio < 0.8) {
      this.#capacityWarnings.delete(dimension)
      return
    }
    this.#capacityWarnings.set(dimension, Object.freeze({ dimension, observed, allowed, ratio }))
  }

  observeFeed(value: unknown): void {
    const input = exactFrozenData(value, ['mode', 'reason'], 'feed observation')
    if (input.mode === 'direct') {
      if (input.reason !== null) invalid('direct feed reason must be null')
      this.#feed = Object.freeze({ mode: 'direct', reason: null })
      return
    }
    if (input.mode !== 'degraded') invalid('feed observation.mode is invalid')
    if (typeof input.reason !== 'string' || !SAFE_REASON_PATTERN.test(input.reason)) {
      invalid('degraded feed reason is invalid')
    }
    this.#feed = Object.freeze({ mode: 'degraded', reason: input.reason })
  }

  beginRefresh(): RefreshIntent {
    if (this.#refreshCurrent !== null) this.#refreshCurrent.consumed = true
    this.#refreshGeneration += 1
    const record: RefreshIntentRecord = {
      owner: this,
      generation: this.#refreshGeneration,
      consumed: false,
      cancelled: false,
    }
    this.#refreshCurrent = record
    return mintIntent(refreshIntents, record)
  }

  cancelRefresh(intent: RefreshIntent): true {
    const record = assertIntent(intent, refreshIntents, this, 'refresh intent')
    if (record !== this.#refreshCurrent || record.generation !== this.#refreshGeneration) {
      record.consumed = true
      invalid('refresh intent is stale')
    }
    record.cancelled = true
    return true
  }

  isRefreshCancelled(intent: RefreshIntent): boolean {
    const record = assertIntent(intent, refreshIntents, this, 'refresh intent')
    return record.cancelled
  }

  completeRefresh(intent: RefreshIntent): void {
    const record = assertIntent(intent, refreshIntents, this, 'refresh intent')
    if (record !== this.#refreshCurrent || record.generation !== this.#refreshGeneration) {
      record.consumed = true
      invalid('refresh intent is stale')
    }
    record.consumed = true
    this.#refreshCurrent = null
  }

  protect(value: unknown): void {
    const input = exactFrozenData(value, ['code'], 'recovery protection')
    if (input.code !== 'RECOVERY_REQUIRED') invalid('recovery protection.code is invalid')
    this.#recoveryRequired = true
    this.#recoveryGeneration += 1
  }

  beginRecoveryResolution(): RecoveryIntent {
    if (!this.#recoveryRequired) invalid('recovery protection is not active')
    return mintIntent(recoveryIntents, {
      owner: this,
      generation: this.#recoveryGeneration,
      consumed: false,
    })
  }

  completeRecoveryResolution(intent: RecoveryIntent): void {
    const record = assertIntent(intent, recoveryIntents, this, 'recovery resolution intent')
    if (!this.#recoveryRequired || record.generation !== this.#recoveryGeneration) {
      record.consumed = true
      invalid('recovery resolution intent is stale')
    }
    record.consumed = true
    this.#recoveryRequired = false
  }

  snapshot() {
    const capacityWarnings = Object.freeze(
      [...this.#capacityWarnings.values()].sort((left, right) => left.dimension.localeCompare(right.dimension)),
    )
    const refresh = Object.freeze({
      state:
        this.#refreshCurrent === null
          ? ('idle' as const)
          : this.#refreshCurrent.cancelled
            ? ('cancelled' as const)
            : ('running' as const),
    })
    return Object.freeze({
      readOnly: this.#conflict !== null || this.#recoveryRequired,
      capacityWarnings,
      feed: this.#feed,
      refresh,
    })
  }

  diagnostics() {
    return this.snapshot()
  }
}
