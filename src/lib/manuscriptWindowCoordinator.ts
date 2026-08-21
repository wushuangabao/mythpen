import {
  createManuscriptMigrationAdmission,
  type FrozenHostDirtySnapshot,
  type FrozenMigrationRequest,
} from './manuscriptMigrationAdmission.ts'

type DirtyDomain = 'body' | 'sidecar' | 'volume_metadata' | 'structure'
type DirtyDisposition = 'persisted' | 'explicitly_resolved' | 'unresolved'
type QueueState = 'active' | 'cancelling' | 'cancelled_and_drained'

type HostStatePort = Readonly<{
  freeze(projectInstanceId: string): Promise<object> | object
  describe(token: object): unknown
  cancelAndDrain(token: object): Promise<object> | object
  describeDrain(token: object): unknown
  inspect(token: object): unknown
  release(token: object): Promise<void> | void
}>

type MigrationApi<Result> = Readonly<{
  beginMigration(request: FrozenMigrationRequest): Promise<Result> | Result
}>

type WindowEntry = Readonly<{ windowId: string; revision: number; responded: boolean }>
type DirtyIdentity = Readonly<{
  domain: DirtyDomain
  loaded: boolean
  resourceKind: 'chapter' | 'volume' | 'manuscript'
  resourceUid: string
  revision: number
  windowId: string
  resourceKey: string
}>
type QueueEntry = Readonly<{
  domain: DirtyDomain
  loaded: boolean
  queueId: string
  revision: number
  state: QueueState
  windowId: string
}>

type FreezeDescription = Readonly<{
  projectName: string
  projectInstanceId: string
  windowSetEpoch: number
  windows: readonly WindowEntry[]
  dirtyResources: readonly DirtyIdentity[]
  saveQueues: readonly QueueEntry[]
}>

type DrainDescription = Readonly<{
  windowSetEpoch: number
  dirtyResources: readonly (DirtyIdentity & Readonly<{ disposition: DirtyDisposition }>)[]
  saveQueues: readonly QueueEntry[]
}>

type SnapshotState = 'active' | 'cancelled' | 'consumed' | 'stale'

type SnapshotRecord = {
  readonly freezeToken: object
  readonly frozen: FreezeDescription
  readonly publicSnapshot: HostWindowSnapshot
  drain?: DrainDescription
  drainOperation?: Promise<void>
  drainStarted: boolean
  resolutions: Map<string, DirtyDisposition>
  state: SnapshotState
}

export type HostWindowSnapshot = Readonly<{
  snapshotId: string
  projectName: string
  projectInstanceId: string
  resources: readonly Readonly<{
    resourceKey: string
    domain: DirtyDomain
    loaded: boolean
    revision: number
  }>[]
}>

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/iu
const DIRTY_DOMAINS = new Set<DirtyDomain>(['body', 'sidecar', 'volume_metadata', 'structure'])
const RESOURCE_KINDS = new Set(['chapter', 'volume', 'manuscript'])
const DIRTY_DISPOSITIONS = new Set<DirtyDisposition>(['persisted', 'explicitly_resolved', 'unresolved'])
const QUEUE_STATES = new Set<QueueState>(['active', 'cancelling', 'cancelled_and_drained'])

function invalid(message: string): never {
  throw new TypeError(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactData<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
  frozen = false,
): Record<Key, unknown> {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`)
  if (frozen && !Object.isFrozen(value)) invalid(`${label} must be frozen`)
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

function captureMethodPort<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
  label: string,
): Readonly<Record<Key, (...args: never[]) => unknown>> {
  const input = exactData(value, keys, label)
  const result = {} as Record<Key, (...args: never[]) => unknown>
  for (const key of keys) {
    if (typeof input[key] !== 'function') invalid(`${label}.${key} must be a function`)
    const method = input[key] as (...args: never[]) => unknown
    result[key] = (...args: never[]) => Reflect.apply(method, value, args) as unknown
  }
  return Object.freeze(result)
}

function denseFrozenArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value)) {
    invalid(`${label} must be a frozen plain array`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid(`${label} must be exact and dense`)
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || descriptor.enumerable !== true || !Reflect.has(descriptor, 'value')) {
      invalid(`${label} must contain data elements only`)
    }
    result.push(descriptor.value)
  }
  return result
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) invalid(`${label} must be a canonical UUIDv4`)
  return value
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) invalid(`${label} is invalid`)
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

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`)
  return value
}

function resourceKey(entry: Pick<DirtyIdentity, 'resourceKind' | 'resourceUid' | 'domain' | 'windowId'>): string {
  return JSON.stringify([entry.resourceKind, entry.resourceUid, entry.domain, entry.windowId])
}

function windowEntries(value: unknown, label: string): readonly WindowEntry[] {
  const entries = denseFrozenArray(value, label).map((entry, index) => {
    const input = exactData(entry, ['windowId', 'revision', 'responded'], `${label}[${index}]`, true)
    return Object.freeze({
      windowId: safeId(input.windowId, `${label}[${index}].windowId`),
      revision: revision(input.revision, `${label}[${index}].revision`),
      responded: booleanValue(input.responded, `${label}[${index}].responded`),
    })
  })
  entries.sort((left, right) => left.windowId.localeCompare(right.windowId))
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].windowId === entries[index].windowId) invalid(`${label} contains duplicate windows`)
  }
  return Object.freeze(entries)
}

function dirtyEntries(value: unknown, label: string, withDisposition: false): readonly DirtyIdentity[]
function dirtyEntries(
  value: unknown,
  label: string,
  withDisposition: true,
): readonly (DirtyIdentity & Readonly<{ disposition: DirtyDisposition }>)[]
function dirtyEntries(value: unknown, label: string, withDisposition: boolean) {
  const keys = withDisposition
    ? (['domain', 'loaded', 'resourceKind', 'resourceUid', 'revision', 'windowId', 'disposition'] as const)
    : (['domain', 'loaded', 'resourceKind', 'resourceUid', 'revision', 'windowId'] as const)
  const entries = denseFrozenArray(value, label).map((entry, index) => {
    const input = exactData(entry, keys, `${label}[${index}]`, true)
    if (typeof input.domain !== 'string' || !DIRTY_DOMAINS.has(input.domain as DirtyDomain)) {
      invalid(`${label}[${index}].domain is invalid`)
    }
    if (typeof input.resourceKind !== 'string' || !RESOURCE_KINDS.has(input.resourceKind)) {
      invalid(`${label}[${index}].resourceKind is invalid`)
    }
    const base = {
      domain: input.domain as DirtyDomain,
      loaded: booleanValue(input.loaded, `${label}[${index}].loaded`),
      resourceKind: input.resourceKind as DirtyIdentity['resourceKind'],
      resourceUid: safeId(input.resourceUid, `${label}[${index}].resourceUid`),
      revision: revision(input.revision, `${label}[${index}].revision`),
      windowId: safeId(input.windowId, `${label}[${index}].windowId`),
    }
    const key = resourceKey(base)
    if (!withDisposition) return Object.freeze({ ...base, resourceKey: key })
    if (typeof input.disposition !== 'string' || !DIRTY_DISPOSITIONS.has(input.disposition as DirtyDisposition)) {
      invalid(`${label}[${index}].disposition is invalid`)
    }
    return Object.freeze({ ...base, resourceKey: key, disposition: input.disposition as DirtyDisposition })
  })
  entries.sort((left, right) => left.resourceKey.localeCompare(right.resourceKey))
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].resourceKey === entries[index].resourceKey) invalid(`${label} contains duplicate resources`)
  }
  return Object.freeze(entries)
}

function queueEntries(value: unknown, label: string): readonly QueueEntry[] {
  const entries = denseFrozenArray(value, label).map((entry, index) => {
    const input = exactData(
      entry,
      ['domain', 'loaded', 'queueId', 'revision', 'state', 'windowId'],
      `${label}[${index}]`,
      true,
    )
    if (typeof input.domain !== 'string' || !DIRTY_DOMAINS.has(input.domain as DirtyDomain)) {
      invalid(`${label}[${index}].domain is invalid`)
    }
    if (typeof input.state !== 'string' || !QUEUE_STATES.has(input.state as QueueState)) {
      invalid(`${label}[${index}].state is invalid`)
    }
    return Object.freeze({
      domain: input.domain as DirtyDomain,
      loaded: booleanValue(input.loaded, `${label}[${index}].loaded`),
      queueId: safeId(input.queueId, `${label}[${index}].queueId`),
      revision: revision(input.revision, `${label}[${index}].revision`),
      state: input.state as QueueState,
      windowId: safeId(input.windowId, `${label}[${index}].windowId`),
    })
  })
  entries.sort((left, right) => left.queueId.localeCompare(right.queueId))
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].queueId === entries[index].queueId) invalid(`${label} contains duplicate queues`)
  }
  return Object.freeze(entries)
}

function freezeDescription(value: unknown): FreezeDescription {
  const input = exactData(
    value,
    ['projectName', 'projectInstanceId', 'windowSetEpoch', 'windows', 'dirtyResources', 'saveQueues'],
    'host freeze description',
    true,
  )
  return Object.freeze({
    projectName: nonEmptyString(input.projectName, 'host freeze description.projectName'),
    projectInstanceId: canonicalUuid(input.projectInstanceId, 'host freeze description.projectInstanceId'),
    windowSetEpoch: revision(input.windowSetEpoch, 'host freeze description.windowSetEpoch'),
    windows: windowEntries(input.windows, 'host freeze description.windows'),
    dirtyResources: dirtyEntries(input.dirtyResources, 'host freeze description.dirtyResources', false),
    saveQueues: queueEntries(input.saveQueues, 'host freeze description.saveQueues'),
  })
}

function drainDescription(value: unknown): DrainDescription {
  const input = exactData(value, ['windowSetEpoch', 'dirtyResources', 'saveQueues'], 'host drain description', true)
  return Object.freeze({
    windowSetEpoch: revision(input.windowSetEpoch, 'host drain description.windowSetEpoch'),
    dirtyResources: dirtyEntries(input.dirtyResources, 'host drain description.dirtyResources', true),
    saveQueues: queueEntries(input.saveQueues, 'host drain description.saveQueues'),
  })
}

function inspectionDescription(value: unknown) {
  const input = exactData(value, ['windowSetEpoch', 'windows', 'dirtyResources', 'saveQueues'], 'host inspection', true)
  return Object.freeze({
    windowSetEpoch: revision(input.windowSetEpoch, 'host inspection.windowSetEpoch'),
    windows: windowEntries(input.windows, 'host inspection.windows'),
    dirtyResources: dirtyEntries(input.dirtyResources, 'host inspection.dirtyResources', false),
    saveQueues: queueEntries(input.saveQueues, 'host inspection.saveQueues'),
  })
}

function sameEntries(left: readonly object[], right: readonly object[], omittedKeys: readonly string[] = []): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index] as Record<string, unknown>
    const rightEntry = right[index] as Record<string, unknown>
    const keys = Object.keys(leftEntry).filter((key) => !omittedKeys.includes(key))
    const rightKeys = Object.keys(rightEntry).filter((key) => !omittedKeys.includes(key))
    if (keys.length !== rightKeys.length || keys.some((key) => leftEntry[key] !== rightEntry[key])) return false
  }
  return true
}

function task5WindowEntries(entries: readonly WindowEntry[]) {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })))
}

function task5DirtyEntries(entries: readonly DirtyIdentity[], dispositions: ReadonlyMap<string, DirtyDisposition>) {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        resourceKey: entry.resourceKey,
        revision: entry.revision,
        disposition: dispositions.get(entry.resourceKey) ?? 'unresolved',
      }),
    ),
  )
}

function task5QueueEntries(entries: readonly QueueEntry[]) {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        queueId: entry.queueId,
        revision: entry.revision,
        state: entry.state,
      }),
    ),
  )
}

export class HostMigrationPreflightCoordinator<Result = unknown> {
  readonly #hostState: HostStatePort
  readonly #uuidV4: () => string
  readonly #recordsById = new Map<string, SnapshotRecord>()
  readonly #publicSnapshots = new WeakMap<object, SnapshotRecord>()
  readonly #admission
  readonly #hostFacts = new WeakMap<object, object>()
  readonly #requestFacts = new WeakMap<object, object>()

  constructor(options: {
    hostState: HostStatePort
    migrationApi: MigrationApi<Result>
    uuidV4(): string
  }) {
    const input = exactData(options, ['hostState', 'migrationApi', 'uuidV4'], 'coordinator options')
    this.#hostState = captureMethodPort(
      input.hostState,
      ['freeze', 'describe', 'cancelAndDrain', 'describeDrain', 'inspect', 'release'],
      'hostState',
    ) as HostStatePort
    const migrationApi = captureMethodPort(
      input.migrationApi,
      ['beginMigration'],
      'migrationApi',
    ) as MigrationApi<Result>
    if (typeof input.uuidV4 !== 'function') invalid('coordinator options.uuidV4 must be a function')
    const uuidV4 = input.uuidV4
    this.#uuidV4 = () => Reflect.apply(uuidV4, options, []) as string

    const hostPreflightAuthority = Object.freeze({
      assert: (value: object) => {
        if (!this.#hostFacts.has(value)) invalid('foreign host preflight snapshot')
        return value
      },
      describe: (value: object) => {
        const facts = this.#hostFacts.get(value)
        if (facts === undefined) invalid('foreign host preflight snapshot')
        return facts
      },
    })
    const migrationRequestAuthority = Object.freeze({
      assert: (value: object) => {
        if (!this.#requestFacts.has(value)) invalid('foreign migration request')
        return value
      },
      describe: (value: object) => {
        const facts = this.#requestFacts.get(value)
        if (facts === undefined) invalid('foreign migration request')
        return facts
      },
    })
    this.#admission = createManuscriptMigrationAdmission({
      hostPreflightAuthority,
      migrationRequestAuthority,
      migrationApi,
    })
  }

  async freezeAllWindows(projectInstanceId: string): Promise<HostWindowSnapshot> {
    canonicalUuid(projectInstanceId, 'projectInstanceId')
    const freezeToken = await this.#hostState.freeze(projectInstanceId)
    if (freezeToken === null || typeof freezeToken !== 'object') invalid('host freeze token must be opaque')
    let frozen: FreezeDescription
    try {
      frozen = freezeDescription(this.#hostState.describe(freezeToken))
      if (frozen.projectInstanceId !== projectInstanceId) invalid('host freeze project instance changed')
      const snapshotId = canonicalUuid(this.#uuidV4(), 'snapshotId')
      if (this.#recordsById.has(snapshotId)) invalid('snapshotId is already active')
      const publicSnapshot = Object.freeze({
        snapshotId,
        projectName: frozen.projectName,
        projectInstanceId: frozen.projectInstanceId,
        resources: Object.freeze(
          frozen.dirtyResources.map((entry) =>
            Object.freeze({
              resourceKey: entry.resourceKey,
              domain: entry.domain,
              loaded: entry.loaded,
              revision: entry.revision,
            }),
          ),
        ),
      })
      const record: SnapshotRecord = {
        freezeToken,
        frozen,
        publicSnapshot,
        drainStarted: false,
        resolutions: new Map(),
        state: 'active',
      }
      this.#recordsById.set(snapshotId, record)
      this.#publicSnapshots.set(publicSnapshot, record)
      return publicSnapshot
    } catch (error) {
      await this.#hostState.release(freezeToken)
      throw error
    }
  }

  async cancelAndDrainSaveQueues(snapshot: HostWindowSnapshot): Promise<void> {
    const record = this.#publicSnapshots.get(snapshot)
    if (record === undefined || record.publicSnapshot !== snapshot) invalid('foreign migration preflight snapshot')
    if (record.state !== 'active') invalid('migration preflight snapshot is inactive')
    if (record.drainStarted) invalid('save queues were already drained')
    record.drainStarted = true
    const operation = this.#performDrain(record)
    record.drainOperation = operation
    await operation
  }

  async #performDrain(record: SnapshotRecord): Promise<void> {
    const drainToken = await this.#hostState.cancelAndDrain(record.freezeToken)
    if (drainToken === null || typeof drainToken !== 'object') invalid('host drain token must be opaque')
    const drain = drainDescription(this.#hostState.describeDrain(drainToken))
    if (record.state !== 'active') invalid('migration preflight snapshot is inactive')
    if (
      drain.windowSetEpoch !== record.frozen.windowSetEpoch ||
      !sameEntries(record.frozen.dirtyResources, drain.dirtyResources, ['disposition']) ||
      !sameEntries(record.frozen.saveQueues, drain.saveQueues, ['state'])
    ) {
      record.state = 'stale'
      invalid('host preflight became stale while draining')
    }
    record.drain = drain
    for (const entry of drain.dirtyResources) {
      record.resolutions.set(entry.resourceKey, entry.disposition)
    }
  }

  recordDraftResolution(snapshotId: string, resourceKeyValue: string, disposition: 'explicitly_resolved'): void {
    const record = this.#activeRecord(snapshotId)
    if (record.drain === undefined) invalid('migration preflight save queues are not drained')
    if (disposition !== 'explicitly_resolved') invalid('draft resolution must be explicit')
    if (!record.frozen.dirtyResources.some((entry) => entry.resourceKey === resourceKeyValue)) {
      invalid('draft resolution resource is outside the frozen set')
    }
    if (!this.#isFresh(record)) invalid('migration preflight is stale')
    record.resolutions.set(resourceKeyValue, disposition)
  }

  canConfirm(snapshotId: string): boolean {
    const record = this.#recordsById.get(snapshotId)
    if (record === undefined || record.state !== 'active' || record.drain === undefined) return false
    if (!this.#isFresh(record)) return false
    if (record.frozen.windows.some((entry) => !entry.responded)) return false
    if (record.drain.saveQueues.some((entry) => entry.state !== 'cancelled_and_drained')) return false
    return record.frozen.dirtyResources.every((entry) => {
      const disposition = record.resolutions.get(entry.resourceKey)
      return disposition === 'persisted' || disposition === 'explicitly_resolved'
    })
  }

  async confirmAndBeginMigration(snapshotId: string, request: { projectName: string }): Promise<Result> {
    const record = this.#activeRecord(snapshotId)
    const requestInput = exactData(request, ['projectName'], 'migration request')
    const projectName = nonEmptyString(requestInput.projectName, 'migration request.projectName')
    if (projectName !== record.frozen.projectName) invalid('migration request project name changed')
    if (!this.canConfirm(snapshotId)) invalid('migration preflight is stale or incomplete')

    const inspection = inspectionDescription(this.#hostState.inspect(record.freezeToken))
    if (!this.#matchesFrozenState(record, inspection)) {
      record.state = 'stale'
      invalid('migration preflight is stale')
    }

    const finalDispositions = new Map(record.resolutions)
    const hostSnapshot = Object.freeze({}) as FrozenHostDirtySnapshot
    const windows = task5WindowEntries(record.frozen.windows)
    const dirtyResources = task5DirtyEntries(record.frozen.dirtyResources, finalDispositions)
    const saveQueues = task5QueueEntries(record.drain?.saveQueues ?? [])
    this.#hostFacts.set(
      hostSnapshot,
      Object.freeze({
        projectName: record.frozen.projectName,
        projectInstanceId: record.frozen.projectInstanceId,
        requestId: snapshotId,
        frozenWindows: windows,
        currentWindows: windows,
        frozenDirtyResources: dirtyResources,
        currentDirtyResources: dirtyResources,
        frozenSaveQueues: saveQueues,
        currentSaveQueues: saveQueues,
      }),
    )
    const migrationRequest = Object.freeze({
      projectName,
      projectInstanceId: record.frozen.projectInstanceId,
      requestId: snapshotId,
    }) as FrozenMigrationRequest
    this.#requestFacts.set(
      migrationRequest,
      Object.freeze({
        projectName,
        projectInstanceId: record.frozen.projectInstanceId,
        requestId: snapshotId,
      }),
    )

    record.state = 'consumed'
    this.#publicSnapshots.delete(record.publicSnapshot)
    try {
      return await this.#admission.beginMigrationAfterHostPreflight(hostSnapshot, migrationRequest)
    } finally {
      this.#hostFacts.delete(hostSnapshot)
      this.#requestFacts.delete(migrationRequest)
      await this.#hostState.release(record.freezeToken)
    }
  }

  async cancel(snapshotId: string): Promise<void> {
    const record = this.#recordsById.get(snapshotId)
    if (record === undefined || (record.state !== 'active' && record.state !== 'stale')) {
      invalid(`migration preflight snapshot is ${record?.state ?? 'inactive'}`)
    }
    record.state = 'cancelled'
    this.#publicSnapshots.delete(record.publicSnapshot)
    if (record.drainOperation !== undefined) {
      try {
        await record.drainOperation
      } catch {
        // Cancellation owns release after an in-flight drain settles.
      }
    }
    await this.#hostState.release(record.freezeToken)
  }

  #activeRecord(snapshotId: string): SnapshotRecord {
    const record = this.#recordsById.get(snapshotId)
    if (record === undefined || record.state !== 'active') {
      invalid(`migration preflight snapshot is ${record?.state ?? 'inactive'}`)
    }
    return record
  }

  #matchesFrozenState(record: SnapshotRecord, inspection: ReturnType<typeof inspectionDescription>): boolean {
    if (inspection.windowSetEpoch !== record.frozen.windowSetEpoch) return false
    if (!sameEntries(record.frozen.windows, inspection.windows)) return false
    if (!sameEntries(record.frozen.dirtyResources, inspection.dirtyResources)) return false
    if (record.drain === undefined || !sameEntries(record.drain.saveQueues, inspection.saveQueues)) return false
    return true
  }

  #isFresh(record: SnapshotRecord): boolean {
    try {
      const inspection = inspectionDescription(this.#hostState.inspect(record.freezeToken))
      if (this.#matchesFrozenState(record, inspection)) return true
    } catch {
      // Authority failures are stale, never a reason to reuse an older snapshot.
    }
    record.state = 'stale'
    this.#publicSnapshots.delete(record.publicSnapshot)
    return false
  }
}
