export type JsonValue = null | boolean | number | string | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>

export type DirtyResourceIdentity = Readonly<{
  projectUid: string
  projectInstanceId: string
  resourceKind: 'chapter' | 'volume' | 'manuscript'
  resourceUid: string
  domain: 'body' | 'sidecar' | 'volume_metadata' | 'structure'
  windowId: string
}>

export type DirtyResourceState = Readonly<{
  identity: DirtyResourceIdentity
  revision: number
  baseRawSha256: string
  fieldMask: readonly string[]
  payload: JsonValue
  status: 'dirty' | 'saving' | 'stale' | 'failed'
  requestId: string | null
}>

type DirtyResourceDraft = Readonly<{
  revision: number
  baseRawSha256: string
  fieldMask: readonly string[]
  payload: JsonValue
}>

type SettleResult = 'saved' | 'stale' | 'failed'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const RESOURCE_KINDS = new Set(['chapter', 'volume', 'manuscript'])
const DOMAINS = new Set(['body', 'sidecar', 'volume_metadata', 'structure'])
const SETTLE_RESULTS = new Set(['saved', 'stale', 'failed'])
const IDENTITY_KEYS = ['projectUid', 'projectInstanceId', 'resourceKind', 'resourceUid', 'domain', 'windowId'] as const
const DRAFT_KEYS = ['revision', 'baseRawSha256', 'fieldMask', 'payload'] as const

function invalid(message: string): never {
  throw new TypeError(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.prototype.hasOwnProperty.call(descriptor, 'value')
  )
}

function exactDataDescriptors<const Key extends string>(
  value: unknown,
  expectedKeys: readonly Key[],
  label: string,
): Record<Key, PropertyDescriptor & { value: unknown }> {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key as Key))
  ) {
    invalid(`${label} has an inexact key set`)
  }
  for (const key of expectedKeys) {
    if (!isEnumerableDataDescriptor(descriptors[key])) {
      invalid(`${label} must contain enumerable own data properties only`)
    }
  }
  return descriptors as Record<Key, PropertyDescriptor & { value: unknown }>
}

function denseArrayValues(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${label} must be a plain array`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  const lengthDescriptor = descriptors.length
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable !== false ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
    lengthDescriptor.value !== value.length
  ) {
    invalid(`${label} has an invalid length`)
  }
  const ownKeys = Reflect.ownKeys(descriptors)
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length),
    )
  ) {
    invalid(`${label} must be dense and contain no extra properties`)
  }
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!isEnumerableDataDescriptor(descriptor)) {
      invalid(`${label} must contain enumerable data elements only`)
    }
    result.push(descriptor.value)
  }
  return result
}

function canonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    invalid(`${label} must be a canonical UUIDv4`)
  }
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${label} must be a non-empty string`)
  }
  return value
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    invalid(`${label} must be a positive safe integer`)
  }
  return value as number
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function cloneFieldMask(value: unknown): readonly string[] {
  const values = denseArrayValues(value, 'draft.fieldMask')
  const result = values.map((entry, index) => nonEmptyString(entry, `draft.fieldMask[${index}]`))
  for (let index = 1; index < result.length; index += 1) {
    if (compareStrings(result[index - 1], result[index]) >= 0) {
      invalid('draft.fieldMask must be unique and canonically sorted')
    }
  }
  return Object.freeze(result)
}

function cloneJsonValue(value: unknown, active = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('draft.payload numbers must be finite')
    return value
  }
  if (typeof value !== 'object') invalid('draft.payload must contain JSON data only')
  if (active.has(value)) invalid('draft.payload must not contain cycles')

  active.add(value)
  try {
    if (Array.isArray(value)) {
      const values = denseArrayValues(value, 'draft.payload array')
      return Object.freeze(values.map((entry) => cloneJsonValue(entry, active)))
    }
    if (!isPlainObject(value)) invalid('draft.payload objects must be plain')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const clone = Object.create(Object.getPrototypeOf(value)) as Record<string, JsonValue>
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !isEnumerableDataDescriptor(descriptors[key])) {
        invalid('draft.payload objects must contain enumerable own data properties only')
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(descriptors[key].value, active),
        writable: true,
      })
    }
    return Object.freeze(clone)
  } finally {
    active.delete(value)
  }
}

function snapshotIdentity(value: unknown): DirtyResourceIdentity {
  const descriptors = exactDataDescriptors(value, IDENTITY_KEYS, 'identity')
  const resourceKind = descriptors.resourceKind.value
  const domain = descriptors.domain.value
  if (typeof resourceKind !== 'string' || !RESOURCE_KINDS.has(resourceKind)) {
    invalid('identity.resourceKind is invalid')
  }
  if (typeof domain !== 'string' || !DOMAINS.has(domain)) {
    invalid('identity.domain is invalid')
  }
  return Object.freeze({
    projectUid: canonicalUuid(descriptors.projectUid.value, 'identity.projectUid'),
    projectInstanceId: canonicalUuid(descriptors.projectInstanceId.value, 'identity.projectInstanceId'),
    resourceKind: resourceKind as DirtyResourceIdentity['resourceKind'],
    resourceUid: canonicalUuid(descriptors.resourceUid.value, 'identity.resourceUid'),
    domain: domain as DirtyResourceIdentity['domain'],
    windowId: nonEmptyString(descriptors.windowId.value, 'identity.windowId'),
  })
}

function snapshotDraft(value: unknown): Omit<DirtyResourceState, 'identity' | 'status' | 'requestId'> {
  const descriptors = exactDataDescriptors(value, DRAFT_KEYS, 'draft')
  const baseRawSha256 = descriptors.baseRawSha256.value
  if (typeof baseRawSha256 !== 'string' || !SHA256_PATTERN.test(baseRawSha256)) {
    invalid('draft.baseRawSha256 must be a lowercase SHA-256')
  }
  return Object.freeze({
    revision: positiveSafeInteger(descriptors.revision.value, 'draft.revision'),
    baseRawSha256,
    fieldMask: cloneFieldMask(descriptors.fieldMask.value),
    payload: cloneJsonValue(descriptors.payload.value),
  })
}

function identityParts(identity: DirtyResourceIdentity): readonly string[] {
  return [
    identity.projectUid,
    identity.projectInstanceId,
    identity.resourceKind,
    identity.resourceUid,
    identity.domain,
    identity.windowId,
  ]
}

function identityKey(identity: DirtyResourceIdentity): string {
  return JSON.stringify(identityParts(identity))
}

function compareIdentities(left: DirtyResourceIdentity, right: DirtyResourceIdentity): number {
  const leftParts = identityParts(left)
  const rightParts = identityParts(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    const compared = compareStrings(leftParts[index], rightParts[index])
    if (compared !== 0) return compared
  }
  return 0
}

export class DirtyResourceRegistry {
  private readonly states = new Map<string, DirtyResourceState>()
  private readonly latestRevisions = new Map<string, number>()

  markDirty(identity: DirtyResourceIdentity, draft: DirtyResourceDraft): void {
    const frozenIdentity = snapshotIdentity(identity)
    const frozenDraft = snapshotDraft(draft)
    const key = identityKey(frozenIdentity)
    const latestRevision = this.latestRevisions.get(key) ?? 0
    if (frozenDraft.revision <= latestRevision) {
      invalid('draft.revision must increase for this identity')
    }
    const state = Object.freeze({
      identity: frozenIdentity,
      ...frozenDraft,
      status: 'dirty' as const,
      requestId: null,
    })
    this.latestRevisions.set(key, frozenDraft.revision)
    this.states.set(key, state)
  }

  markSaving(identity: DirtyResourceIdentity, revision: number, requestId: string): void {
    const key = identityKey(snapshotIdentity(identity))
    const expectedRevision = positiveSafeInteger(revision, 'revision')
    const frozenRequestId = nonEmptyString(requestId, 'requestId')
    const current = this.states.get(key)
    if (current === undefined || current.revision !== expectedRevision) {
      invalid('markSaving must name the current dirty revision')
    }
    this.states.set(
      key,
      Object.freeze({
        ...current,
        status: 'saving' as const,
        requestId: frozenRequestId,
      }),
    )
  }

  settle(identity: DirtyResourceIdentity, revision: number, requestId: string, result: SettleResult): void {
    const key = identityKey(snapshotIdentity(identity))
    const settledRevision = positiveSafeInteger(revision, 'revision')
    const settledRequestId = nonEmptyString(requestId, 'requestId')
    if (!SETTLE_RESULTS.has(result)) invalid('settle result is invalid')
    const current = this.states.get(key)
    if (
      current === undefined ||
      current.revision !== settledRevision ||
      current.status !== 'saving' ||
      current.requestId !== settledRequestId
    ) {
      return
    }
    if (result === 'saved') {
      this.states.delete(key)
      return
    }
    this.states.set(
      key,
      Object.freeze({
        ...current,
        status: result,
      }),
    )
  }

  discard(identity: DirtyResourceIdentity): void {
    this.states.delete(identityKey(snapshotIdentity(identity)))
  }

  snapshot(): ReadonlyArray<DirtyResourceState> {
    return Object.freeze(
      [...this.states.values()].sort((left, right) => compareIdentities(left.identity, right.identity)),
    )
  }
}
