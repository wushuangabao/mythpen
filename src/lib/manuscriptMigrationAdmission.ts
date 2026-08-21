export type FrozenHostDirtySnapshot = Readonly<object>
export type FrozenMigrationRequest = Readonly<object>

type OpaqueAuthority = Readonly<{
  assert(value: object): object
  describe(value: object): unknown
}>

type MigrationApi<MigrationResult> = Readonly<{
  beginMigration(request: FrozenMigrationRequest): Promise<MigrationResult> | MigrationResult
}>

export type ManuscriptMigrationAdmission<MigrationResult> = Readonly<{
  beginMigrationAfterHostPreflight(
    snapshot: FrozenHostDirtySnapshot,
    request: FrozenMigrationRequest,
  ): Promise<MigrationResult>
}>

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const RESOLVED_DISPOSITIONS = new Set(['persisted', 'explicitly_resolved'])
const DIRTY_DISPOSITIONS = new Set(['persisted', 'explicitly_resolved', 'unresolved'])
const QUEUE_STATES = new Set(['active', 'cancelling', 'cancelled_and_drained'])

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
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key as Key)))
    invalid(`${label} has an inexact key set`)
  const result = {} as Record<Key, unknown>
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || descriptor.enumerable !== true || !Reflect.has(descriptor, 'value'))
      invalid(`${label}.${key} must be an enumerable own data property`)
    result[key] = descriptor.value
  }
  return result
}

function exactData<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Record<Key, unknown> {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key as Key)))
    invalid(`${label} has an inexact key set`)
  const result = {} as Record<Key, unknown>
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (descriptor === undefined || descriptor.enumerable !== true || !Reflect.has(descriptor, 'value'))
      invalid(`${label}.${key} must be an enumerable own data property`)
    result[key] = descriptor.value
  }
  return result
}

function captureAuthority(value: unknown, label: string): OpaqueAuthority {
  const input = exactFrozenData(value, ['assert', 'describe'], label)
  if (typeof input.assert !== 'function' || typeof input.describe !== 'function') {
    invalid(`${label} methods are required`)
  }
  const assert = input.assert
  const describe = input.describe
  return Object.freeze({
    assert(subject: object) {
      return Reflect.apply(assert, value, [subject]) as object
    },
    describe(subject: object) {
      return Reflect.apply(describe, value, [subject])
    },
  })
}

function captureMigrationApi<MigrationResult>(value: unknown): MigrationApi<MigrationResult> {
  if (!isPlainObject(value)) invalid('migrationApi must be a plain object')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Reflect.ownKeys(descriptors)
  if (actual.length !== 1 || actual[0] !== 'beginMigration') {
    invalid('migrationApi has an inexact key set')
  }
  const descriptor = descriptors.beginMigration
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Reflect.has(descriptor, 'value') ||
    typeof descriptor.value !== 'function'
  )
    invalid('migrationApi.beginMigration must be an enumerable own data method')
  const beginMigration = descriptor.value
  return Object.freeze({
    beginMigration(request: FrozenMigrationRequest) {
      return Reflect.apply(beginMigration, value, [request]) as Promise<MigrationResult> | MigrationResult
    },
  })
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    invalid(`${label} must be a canonical UUIDv4`)
  }
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be non-empty`)
  return value
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function denseFrozenArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${label} must be a plain array`)
  }
  if (!Object.isFrozen(value)) invalid(`${label} must be frozen`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    invalid(`${label} must be exact and dense`)
  }
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || descriptor.enumerable !== true || !Reflect.has(descriptor, 'value'))
      invalid(`${label} must contain data elements only`)
    result.push(descriptor.value)
  }
  return result
}

type WindowEntry = Readonly<{ windowId: string; revision: number; responded: boolean }>
type DirtyEntry = Readonly<{
  resourceKey: string
  revision: number
  disposition: 'persisted' | 'explicitly_resolved' | 'unresolved'
}>
type QueueEntry = Readonly<{
  queueId: string
  revision: number
  state: 'active' | 'cancelling' | 'cancelled_and_drained'
}>

function canonicalEntries<T extends { revision: number }>(
  value: unknown,
  label: string,
  idKey: 'windowId' | 'resourceKey' | 'queueId',
  snapshot: (entry: unknown, entryLabel: string) => T,
): readonly T[] {
  const values = denseFrozenArray(value, label)
  const result = values.map((entry, index) => snapshot(entry, `${label}[${index}]`))
  for (let index = 1; index < result.length; index += 1) {
    const previous = (result[index - 1] as unknown as Record<string, string>)[idKey]
    const current = (result[index] as unknown as Record<string, string>)[idKey]
    if (previous >= current) invalid(`${label} must have unique canonical ordering`)
  }
  return Object.freeze(result)
}

function windowEntries(value: unknown, label: string): readonly WindowEntry[] {
  return canonicalEntries(value, label, 'windowId', (entry, entryLabel) => {
    const input = exactFrozenData(entry, ['windowId', 'revision', 'responded'], entryLabel)
    if (typeof input.responded !== 'boolean') invalid(`${entryLabel}.responded must be boolean`)
    return Object.freeze({
      windowId: nonEmptyString(input.windowId, `${entryLabel}.windowId`),
      revision: revision(input.revision, `${entryLabel}.revision`),
      responded: input.responded,
    })
  })
}

function dirtyEntries(value: unknown, label: string): readonly DirtyEntry[] {
  return canonicalEntries(value, label, 'resourceKey', (entry, entryLabel) => {
    const input = exactFrozenData(entry, ['resourceKey', 'revision', 'disposition'], entryLabel)
    if (typeof input.disposition !== 'string' || !DIRTY_DISPOSITIONS.has(input.disposition)) {
      invalid(`${entryLabel}.disposition is invalid`)
    }
    return Object.freeze({
      resourceKey: nonEmptyString(input.resourceKey, `${entryLabel}.resourceKey`),
      revision: revision(input.revision, `${entryLabel}.revision`),
      disposition: input.disposition as DirtyEntry['disposition'],
    })
  })
}

function queueEntries(value: unknown, label: string): readonly QueueEntry[] {
  return canonicalEntries(value, label, 'queueId', (entry, entryLabel) => {
    const input = exactFrozenData(entry, ['queueId', 'revision', 'state'], entryLabel)
    if (typeof input.state !== 'string' || !QUEUE_STATES.has(input.state)) {
      invalid(`${entryLabel}.state is invalid`)
    }
    return Object.freeze({
      queueId: nonEmptyString(input.queueId, `${entryLabel}.queueId`),
      revision: revision(input.revision, `${entryLabel}.revision`),
      state: input.state as QueueEntry['state'],
    })
  })
}

function sameEntries(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index] as Record<string, unknown>
    const rightEntry = right[index] as Record<string, unknown>
    const keys = Object.keys(leftEntry)
    if (keys.length !== Object.keys(rightEntry).length || keys.some((key) => leftEntry[key] !== rightEntry[key]))
      return false
  }
  return true
}

function validateHostPreflight(value: unknown) {
  const input = exactFrozenData(
    value,
    [
      'projectName',
      'projectInstanceId',
      'requestId',
      'frozenWindows',
      'currentWindows',
      'frozenDirtyResources',
      'currentDirtyResources',
      'frozenSaveQueues',
      'currentSaveQueues',
    ],
    'host preflight description',
  )
  const frozenWindows = windowEntries(input.frozenWindows, 'host preflight frozenWindows')
  const currentWindows = windowEntries(input.currentWindows, 'host preflight currentWindows')
  const frozenDirty = dirtyEntries(input.frozenDirtyResources, 'host preflight frozenDirtyResources')
  const currentDirty = dirtyEntries(input.currentDirtyResources, 'host preflight currentDirtyResources')
  const frozenQueues = queueEntries(input.frozenSaveQueues, 'host preflight frozenSaveQueues')
  const currentQueues = queueEntries(input.currentSaveQueues, 'host preflight currentSaveQueues')
  if (!sameEntries(frozenWindows, currentWindows)) {
    invalid('host preflight window set or revision changed')
  }
  if (frozenWindows.some((entry) => !entry.responded)) {
    invalid('host preflight has a nonresponsive window')
  }
  if (!sameEntries(frozenDirty, currentDirty)) {
    invalid('host preflight dirty resource set or revision changed')
  }
  if (frozenDirty.some((entry) => !RESOLVED_DISPOSITIONS.has(entry.disposition))) {
    invalid('host preflight has an unresolved dirty resource')
  }
  if (!sameEntries(frozenQueues, currentQueues)) {
    invalid('host preflight save queue set or revision changed')
  }
  if (frozenQueues.some((entry) => entry.state !== 'cancelled_and_drained')) {
    invalid('host preflight has an undrained save queue')
  }
  return Object.freeze({
    projectName: nonEmptyString(input.projectName, 'host preflight projectName'),
    projectInstanceId: canonicalUuid(input.projectInstanceId, 'host preflight projectInstanceId'),
    requestId: nonEmptyString(input.requestId, 'host preflight requestId'),
  })
}

function validateRequestBinding(value: unknown) {
  const input = exactFrozenData(
    value,
    ['projectName', 'projectInstanceId', 'requestId'],
    'migration request description',
  )
  return Object.freeze({
    projectName: nonEmptyString(input.projectName, 'migration request projectName'),
    projectInstanceId: canonicalUuid(input.projectInstanceId, 'migration request projectInstanceId'),
    requestId: nonEmptyString(input.requestId, 'migration request requestId'),
  })
}

export function createManuscriptMigrationAdmission<MigrationResult>(options: {
  hostPreflightAuthority: OpaqueAuthority
  migrationRequestAuthority: OpaqueAuthority
  migrationApi: MigrationApi<MigrationResult>
}): ManuscriptMigrationAdmission<MigrationResult> {
  const input = exactData(
    options,
    ['hostPreflightAuthority', 'migrationRequestAuthority', 'migrationApi'],
    'manuscript migration admission options',
  )
  const hostPreflightAuthority = captureAuthority(input.hostPreflightAuthority, 'hostPreflightAuthority')
  const migrationRequestAuthority = captureAuthority(input.migrationRequestAuthority, 'migrationRequestAuthority')
  const migrationApi = captureMigrationApi<MigrationResult>(input.migrationApi)
  const consumedSnapshots = new WeakSet<object>()
  const consumedRequests = new WeakSet<object>()

  const admission: ManuscriptMigrationAdmission<MigrationResult> = Object.freeze({
    async beginMigrationAfterHostPreflight(snapshot, request) {
      if (snapshot === null || typeof snapshot !== 'object') {
        invalid('host preflight snapshot must be opaque')
      }
      if (request === null || typeof request !== 'object') {
        invalid('migration request must be opaque')
      }
      if (hostPreflightAuthority.assert(snapshot) !== snapshot) {
        invalid('host preflight authority did not return the original snapshot')
      }
      if (migrationRequestAuthority.assert(request) !== request) {
        invalid('migration request authority did not return the original request')
      }
      const hostBinding = validateHostPreflight(hostPreflightAuthority.describe(snapshot))
      const requestBinding = validateRequestBinding(migrationRequestAuthority.describe(request))
      if (
        hostBinding.projectName !== requestBinding.projectName ||
        hostBinding.projectInstanceId !== requestBinding.projectInstanceId ||
        hostBinding.requestId !== requestBinding.requestId
      )
        invalid('host preflight and migration request project binding differ')
      if (consumedSnapshots.has(snapshot) || consumedRequests.has(request)) {
        invalid('host preflight snapshot or migration request is already consumed')
      }
      consumedSnapshots.add(snapshot)
      consumedRequests.add(request)
      return await migrationApi.beginMigration(request)
    },
  })
  return admission
}
