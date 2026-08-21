type DirtyDomain = 'body' | 'sidecar' | 'volume_metadata' | 'structure'
type DirtyDisposition = 'persisted' | 'explicitly_resolved' | 'unresolved'
type QueueState = 'active' | 'cancelling' | 'cancelled_and_drained'

type ParticipantDirtyResource = Readonly<{
  domain: DirtyDomain
  loaded: boolean
  resourceKind: 'chapter' | 'volume' | 'manuscript'
  resourceUid: string
  revision: number
}>

type ParticipantSaveQueue = Readonly<{
  domain: DirtyDomain
  loaded: boolean
  queueId: string
  revision: number
  state: QueueState
}>

type ParticipantDescription = Readonly<{
  projectName: string
  projectInstanceId: string
  windowRevision: number
  dirtyResources: readonly ParticipantDirtyResource[]
  saveQueues: readonly ParticipantSaveQueue[]
}>

type ParticipantResolution = Readonly<{
  resourceUid: string
  domain: DirtyDomain
  disposition: DirtyDisposition
}>

export type ManuscriptHostWindowParticipant = Readonly<{
  windowId: string
  freeze(projectInstanceId: string): Promise<boolean> | boolean
  describe(projectInstanceId: string): ParticipantDescription
  cancelAndDrain(
    projectInstanceId: string,
  ): Promise<readonly ParticipantResolution[]> | readonly ParticipantResolution[]
  release(projectInstanceId: string): Promise<void> | void
}>

type ParticipantPort = ManuscriptHostWindowParticipant

type FreezeWindow = Readonly<{
  readonly participant: ParticipantPort
  readonly responded: boolean
  readonly description: ParticipantDescription
}>

type FreezeRecord = {
  readonly token: object
  readonly projectInstanceId: string
  readonly projectName: string
  readonly windowSetEpoch: number
  readonly windows: readonly FreezeWindow[]
  frozenDescription: object
  drainDescription: object | null
  released: boolean
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/iu
const DIRTY_DOMAINS = new Set<DirtyDomain>(['body', 'sidecar', 'volume_metadata', 'structure'])
const RESOURCE_KINDS = new Set(['chapter', 'volume', 'manuscript'])
const QUEUE_STATES = new Set<QueueState>(['active', 'cancelling', 'cancelled_and_drained'])
const DISPOSITIONS = new Set<DirtyDisposition>(['persisted', 'explicitly_resolved', 'unresolved'])

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
): Record<Key, unknown> {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`)
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

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID_PATTERN.test(value)) invalid(`${label} is invalid`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be non-empty`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function denseArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid(`${label} must be a plain array`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) invalid(`${label} must be dense`)
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (descriptor === undefined || descriptor.enumerable !== true || !Reflect.has(descriptor, 'value')) {
      invalid(`${label} must contain own data elements`)
    }
    result.push(descriptor.value)
  }
  return result
}

function captureDescription(value: unknown, windowId: string): ParticipantDescription {
  const input = exactData(
    value,
    ['projectName', 'projectInstanceId', 'windowRevision', 'dirtyResources', 'saveQueues'],
    `${windowId} description`,
  )
  const dirtyResources = denseArray(input.dirtyResources, `${windowId} dirtyResources`).map((entry, index) => {
    const resource = exactData(
      entry,
      ['domain', 'loaded', 'resourceKind', 'resourceUid', 'revision'],
      `${windowId} dirtyResources[${index}]`,
    )
    if (typeof resource.domain !== 'string' || !DIRTY_DOMAINS.has(resource.domain as DirtyDomain)) {
      invalid(`${windowId} dirty resource domain is invalid`)
    }
    if (typeof resource.resourceKind !== 'string' || !RESOURCE_KINDS.has(resource.resourceKind)) {
      invalid(`${windowId} dirty resource kind is invalid`)
    }
    if (typeof resource.loaded !== 'boolean') invalid(`${windowId} dirty resource loaded is invalid`)
    return Object.freeze({
      domain: resource.domain as DirtyDomain,
      loaded: resource.loaded,
      resourceKind: resource.resourceKind as ParticipantDirtyResource['resourceKind'],
      resourceUid: safeId(resource.resourceUid, `${windowId} dirty resource UID`),
      revision: nonNegativeInteger(resource.revision, `${windowId} dirty resource revision`),
    })
  })
  const saveQueues = denseArray(input.saveQueues, `${windowId} saveQueues`).map((entry, index) => {
    const queue = exactData(
      entry,
      ['domain', 'loaded', 'queueId', 'revision', 'state'],
      `${windowId} saveQueues[${index}]`,
    )
    if (typeof queue.domain !== 'string' || !DIRTY_DOMAINS.has(queue.domain as DirtyDomain)) {
      invalid(`${windowId} queue domain is invalid`)
    }
    if (typeof queue.state !== 'string' || !QUEUE_STATES.has(queue.state as QueueState)) {
      invalid(`${windowId} queue state is invalid`)
    }
    if (typeof queue.loaded !== 'boolean') invalid(`${windowId} queue loaded is invalid`)
    return Object.freeze({
      domain: queue.domain as DirtyDomain,
      loaded: queue.loaded,
      queueId: safeId(queue.queueId, `${windowId} queue ID`),
      revision: nonNegativeInteger(queue.revision, `${windowId} queue revision`),
      state: queue.state as QueueState,
    })
  })
  return Object.freeze({
    projectName: nonEmptyString(input.projectName, `${windowId} projectName`),
    projectInstanceId: canonicalUuid(input.projectInstanceId, `${windowId} projectInstanceId`),
    windowRevision: nonNegativeInteger(input.windowRevision, `${windowId} windowRevision`),
    dirtyResources: Object.freeze(dirtyResources),
    saveQueues: Object.freeze(saveQueues),
  })
}

function captureParticipant(value: unknown): ParticipantPort {
  const input = exactData(value, ['windowId', 'freeze', 'describe', 'cancelAndDrain', 'release'], 'window participant')
  const windowId = safeId(input.windowId, 'window participant.windowId')
  const methods = {} as Record<'freeze' | 'describe' | 'cancelAndDrain' | 'release', (...args: never[]) => unknown>
  for (const key of ['freeze', 'describe', 'cancelAndDrain', 'release'] as const) {
    if (typeof input[key] !== 'function') invalid(`window participant.${key} must be a function`)
    const method = input[key] as (...args: never[]) => unknown
    methods[key] = (...args: never[]) => Reflect.apply(method, value, args) as unknown
  }
  return Object.freeze({
    windowId,
    freeze: methods.freeze as ParticipantPort['freeze'],
    describe: methods.describe as ParticipantPort['describe'],
    cancelAndDrain: methods.cancelAndDrain as ParticipantPort['cancelAndDrain'],
    release: methods.release as ParticipantPort['release'],
  })
}

function freezeDescription(record: FreezeRecord, windows = record.windows) {
  const dirtyResources = windows.flatMap((window) =>
    window.description.dirtyResources.map((entry) =>
      Object.freeze({ ...entry, windowId: window.participant.windowId }),
    ),
  )
  const saveQueues = windows.flatMap((window) =>
    window.description.saveQueues.map((entry) => Object.freeze({ ...entry, windowId: window.participant.windowId })),
  )
  dirtyResources.sort((left, right) =>
    JSON.stringify([left.resourceKind, left.resourceUid, left.domain, left.windowId]).localeCompare(
      JSON.stringify([right.resourceKind, right.resourceUid, right.domain, right.windowId]),
    ),
  )
  saveQueues.sort((left, right) => left.queueId.localeCompare(right.queueId))
  return Object.freeze({
    projectName: record.projectName,
    projectInstanceId: record.projectInstanceId,
    windowSetEpoch: record.windowSetEpoch,
    windows: Object.freeze(
      windows
        .map((window) =>
          Object.freeze({
            windowId: window.participant.windowId,
            revision: window.description.windowRevision,
            responded: window.responded,
          }),
        )
        .sort((left, right) => left.windowId.localeCompare(right.windowId)),
    ),
    dirtyResources: Object.freeze(dirtyResources),
    saveQueues: Object.freeze(saveQueues),
  })
}

export function createManuscriptProductionHostState() {
  const participants = new Map<string, ParticipantPort>()
  const records = new WeakMap<object, FreezeRecord>()
  const frozenInstances = new Set<string>()
  let windowSetEpoch = 0

  function activeRecord(token: object): FreezeRecord {
    const record = records.get(token)
    if (record === undefined || record.released) invalid('host freeze token is inactive')
    return record
  }

  const hostState = Object.freeze({
    async freeze(projectInstanceId: string) {
      const instanceId = canonicalUuid(projectInstanceId, 'projectInstanceId')
      if (frozenInstances.has(instanceId)) invalid('project instance is already frozen')
      const capturedParticipants = [...participants.values()].sort((left, right) =>
        left.windowId.localeCompare(right.windowId),
      )
      if (capturedParticipants.length === 0) invalid('no manuscript windows are registered')
      frozenInstances.add(instanceId)
      const windows: FreezeWindow[] = []
      try {
        for (const participant of capturedParticipants) {
          let responded = false
          try {
            responded = (await participant.freeze(instanceId)) === true
          } catch {
            responded = false
          }
          windows.push(
            Object.freeze({
              participant,
              responded,
              description: captureDescription(participant.describe(instanceId), participant.windowId),
            }),
          )
        }
        const projectName = windows[0].description.projectName
        if (
          windows.some(
            (window) =>
              window.description.projectName !== projectName || window.description.projectInstanceId !== instanceId,
          )
        )
          invalid('window project binding changed')
        const token = Object.freeze({})
        const record: FreezeRecord = {
          token,
          projectInstanceId: instanceId,
          projectName,
          windowSetEpoch,
          windows: Object.freeze(windows),
          frozenDescription: Object.freeze({}),
          drainDescription: null,
          released: false,
        }
        record.frozenDescription = freezeDescription(record)
        records.set(token, record)
        return token
      } catch (error) {
        frozenInstances.delete(instanceId)
        for (const participant of capturedParticipants) {
          try {
            await participant.release(instanceId)
          } catch {
            // The original failure remains authoritative.
          }
        }
        throw error
      }
    },
    describe(token: object) {
      return activeRecord(token).frozenDescription
    },
    async cancelAndDrain(token: object) {
      const record = activeRecord(token)
      const resolutions = new Map<string, DirtyDisposition>()
      for (const window of record.windows) {
        const values = denseArray(
          await window.participant.cancelAndDrain(record.projectInstanceId),
          `${window.participant.windowId} drain resolutions`,
        )
        for (let index = 0; index < values.length; index += 1) {
          const input = exactData(
            values[index],
            ['resourceUid', 'domain', 'disposition'],
            `${window.participant.windowId} drain resolutions[${index}]`,
          )
          if (typeof input.domain !== 'string' || !DIRTY_DOMAINS.has(input.domain as DirtyDomain)) {
            invalid('drain resolution domain is invalid')
          }
          if (typeof input.disposition !== 'string' || !DISPOSITIONS.has(input.disposition as DirtyDisposition)) {
            invalid('drain resolution disposition is invalid')
          }
          const uid = safeId(input.resourceUid, 'drain resolution resource UID')
          resolutions.set(
            JSON.stringify([window.participant.windowId, input.domain, uid]),
            input.disposition as DirtyDisposition,
          )
        }
      }
      const currentWindows = record.windows.map((window) =>
        Object.freeze({
          participant: window.participant,
          responded: window.responded,
          description: captureDescription(
            window.participant.describe(record.projectInstanceId),
            window.participant.windowId,
          ),
        }),
      )
      const current = freezeDescription(record, Object.freeze(currentWindows))
      const frozen = record.frozenDescription as {
        dirtyResources: readonly (ParticipantDirtyResource & { windowId: string })[]
      }
      record.drainDescription = Object.freeze({
        windowSetEpoch: record.windowSetEpoch,
        dirtyResources: Object.freeze(
          frozen.dirtyResources.map((entry) =>
            Object.freeze({
              ...entry,
              disposition:
                resolutions.get(JSON.stringify([entry.windowId, entry.domain, entry.resourceUid])) ?? 'unresolved',
            }),
          ),
        ),
        saveQueues: (current as { saveQueues: readonly ParticipantSaveQueue[] }).saveQueues,
      })
      return Object.freeze({ record })
    },
    describeDrain(drainToken: object) {
      const input = exactData(drainToken, ['record'], 'host drain token')
      const record = input.record as FreezeRecord
      if (record === null || typeof record !== 'object' || records.get(record.token) !== record || record.released) {
        invalid('host drain token is inactive')
      }
      if (record.drainDescription === null) invalid('host drain is incomplete')
      return record.drainDescription
    },
    inspect(token: object) {
      const record = activeRecord(token)
      const windows = [...participants.values()]
        .sort((left, right) => left.windowId.localeCompare(right.windowId))
        .map((participant) => {
          const frozenWindow = record.windows.find((entry) => entry.participant.windowId === participant.windowId)
          return Object.freeze({
            participant,
            responded: frozenWindow?.responded === true,
            description: captureDescription(participant.describe(record.projectInstanceId), participant.windowId),
          })
        })
      const description = freezeDescription({ ...record, windowSetEpoch }, Object.freeze(windows)) as {
        windowSetEpoch: number
        windows: readonly object[]
        dirtyResources: readonly object[]
        saveQueues: readonly object[]
      }
      return Object.freeze({
        windowSetEpoch: description.windowSetEpoch,
        windows: description.windows,
        dirtyResources: description.dirtyResources,
        saveQueues: description.saveQueues,
      })
    },
    async release(token: object) {
      const record = activeRecord(token)
      record.released = true
      frozenInstances.delete(record.projectInstanceId)
      const results = await Promise.allSettled(
        record.windows.map((window) => window.participant.release(record.projectInstanceId)),
      )
      if (results.some((result) => result.status === 'rejected')) invalid('window freeze release failed')
    },
  })

  return Object.freeze({
    hostState,
    registerWindow(value: ManuscriptHostWindowParticipant) {
      const participant = captureParticipant(value)
      if (participants.has(participant.windowId)) invalid('window is already registered')
      participants.set(participant.windowId, participant)
      windowSetEpoch += 1
      let registered = true
      return Object.freeze({
        unregister() {
          if (!registered) invalid('window registration is inactive')
          registered = false
          participants.delete(participant.windowId)
          windowSetEpoch += 1
        },
      })
    },
    assertSaveAdmission(projectInstanceId: string) {
      const instanceId = canonicalUuid(projectInstanceId, 'projectInstanceId')
      if (frozenInstances.has(instanceId)) invalid('project save admission is frozen')
      return true as const
    },
  })
}
