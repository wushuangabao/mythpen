import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirtyResourceRegistry,
  type DirtyResourceIdentity,
  type JsonValue,
} from '../src/lib/dirtyResourceRegistry.ts'
import { createManuscriptDirtyBinding, isManuscriptSaveProtected } from '../src/lib/manuscriptDirtyResources.ts'

const PROJECT_UID = '11111111-1111-4111-8111-111111111111'
const OTHER_PROJECT_UID = '22222222-2222-4222-8222-222222222222'
const PROJECT_INSTANCE_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_PROJECT_INSTANCE_ID = '44444444-4444-4444-8444-444444444444'
const RESOURCE_UID = '55555555-5555-4555-8555-555555555555'
const OTHER_RESOURCE_UID = '66666666-6666-4666-8666-666666666666'
const BASE_HASH = 'a'.repeat(64)

function identity(
  overrides: Partial<DirtyResourceIdentity> = {},
): DirtyResourceIdentity {
  return {
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    resourceKind: 'chapter',
    resourceUid: RESOURCE_UID,
    domain: 'body',
    windowId: 'window-a',
    ...overrides,
  }
}

function draft(
  revision: number,
  overrides: Partial<{
    baseRawSha256: string
    fieldMask: readonly string[]
    payload: JsonValue
  }> = {},
) {
  return {
    revision,
    baseRawSha256: BASE_HASH,
    fieldMask: ['content'],
    payload: { content: `draft-${revision}` },
    ...overrides,
  }
}

test('revision and request interleavings retain only current unsaved evidence', () => {
  const registry = new DirtyResourceRegistry()
  const key = identity()

  registry.markDirty(key, draft(1, { payload: { content: 'A' } }))
  registry.markSaving(key, 1, 'request-a')
  registry.markDirty(key, draft(2, { payload: { content: 'B' } }))
  registry.settle(key, 1, 'request-a', 'saved')

  assert.deepEqual(registry.snapshot(), [{
    identity: key,
    revision: 2,
    baseRawSha256: BASE_HASH,
    fieldMask: ['content'],
    payload: { content: 'B' },
    status: 'dirty',
    requestId: null,
  }])

  registry.markSaving(key, 2, 'request-b')
  registry.settle(key, 2, 'wrong-request', 'saved')
  assert.equal(registry.snapshot()[0].status, 'saving')
  assert.equal(registry.snapshot()[0].requestId, 'request-b')

  registry.settle(key, 2, 'request-b', 'failed')
  registry.settle(key, 2, 'request-b', 'saved')
  assert.equal(registry.snapshot()[0].status, 'failed')
  assert.equal(registry.snapshot()[0].requestId, 'request-b')

  registry.markSaving(key, 2, 'request-c')
  registry.settle(key, 2, 'request-c', 'stale')
  assert.equal(registry.snapshot()[0].status, 'stale')

  registry.markSaving(key, 2, 'request-d')
  registry.settle(key, 2, 'request-d', 'saved')
  assert.deepEqual(registry.snapshot(), [])
  assert.throws(() => registry.markDirty(key, draft(2)), TypeError)

  registry.markDirty(key, draft(3))
  assert.throws(() => registry.markSaving(key, 2, 'old-request'), TypeError)
  registry.settle(key, 2, 'old-request', 'failed')
  assert.equal(registry.snapshot()[0].revision, 3)
  registry.discard(key)
  assert.deepEqual(registry.snapshot(), [])
})

test('the full identity key isolates replacement instances, windows, domains, and resources', () => {
  const identities = [
    identity(),
    identity({ projectUid: OTHER_PROJECT_UID }),
    identity({ projectInstanceId: OTHER_PROJECT_INSTANCE_ID }),
    identity({ resourceKind: 'volume' }),
    identity({ resourceUid: OTHER_RESOURCE_UID }),
    identity({ domain: 'sidecar' }),
    identity({ windowId: 'window-b' }),
  ]
  const forward = new DirtyResourceRegistry()
  const reverse = new DirtyResourceRegistry()

  identities.forEach((value, index) => {
    forward.markDirty(value, draft(1, { payload: { index } }))
  })
  ;[...identities].reverse().forEach((value, reverseIndex) => {
    const index = identities.indexOf(value)
    reverse.markDirty(value, draft(1, { payload: { index, reverseIndex: 6 - index } }))
  })

  const forwardSnapshot = forward.snapshot()
  const reverseSnapshot = reverse.snapshot()
  assert.equal(forwardSnapshot.length, identities.length)
  assert.deepEqual(
    forwardSnapshot.map((state) => state.identity),
    reverseSnapshot.map((state) => state.identity),
  )
  assert.deepEqual(
    forwardSnapshot.map((state) => (state.payload as { index: number }).index),
    reverseSnapshot.map((state) => (state.payload as { index: number }).index),
  )
})

test('markDirty snapshots and recursively freezes exact JSON data before returning', () => {
  const mutableIdentity = identity() as {
    -readonly [Key in keyof DirtyResourceIdentity]: DirtyResourceIdentity[Key]
  }
  const fieldMask = ['content', 'title']
  const nested = { value: 1 }
  const payload = { nested: [nested], text: 'original' }
  const registry = new DirtyResourceRegistry()

  registry.markDirty(mutableIdentity, {
    revision: 1,
    baseRawSha256: BASE_HASH,
    fieldMask,
    payload,
  })

  mutableIdentity.windowId = 'mutated-window'
  fieldMask[0] = 'mutated-field'
  nested.value = 99
  payload.text = 'mutated'

  const snapshot = registry.snapshot()
  const state = snapshot[0]
  assert.equal(state.identity.windowId, 'window-a')
  assert.deepEqual(state.fieldMask, ['content', 'title'])
  assert.deepEqual(state.payload, { nested: [{ value: 1 }], text: 'original' })
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(state), true)
  assert.equal(Object.isFrozen(state.identity), true)
  assert.equal(Object.isFrozen(state.fieldMask), true)
  assert.equal(Object.isFrozen(state.payload), true)
  assert.equal(Object.isFrozen((state.payload as { nested: readonly object[] }).nested), true)
  assert.equal(Object.isFrozen((state.payload as { nested: readonly object[] }).nested[0]), true)
})

test('rejects inexact identities and drafts, noncanonical values, accessors, and non-JSON payloads', () => {
  const registry = new DirtyResourceRegistry()
  const validIdentity = identity()
  const validDraft = draft(1)

  assert.throws(() => registry.markDirty(
    { ...validIdentity, extra: true } as unknown as DirtyResourceIdentity,
    validDraft,
  ), TypeError)
  assert.throws(() => registry.markDirty(
    { ...validIdentity, projectUid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    validDraft,
  ), TypeError)
  assert.throws(() => registry.markDirty(
    { ...validIdentity, windowId: '' },
    validDraft,
  ), TypeError)

  let getterCalls = 0
  const accessorIdentity = { ...validIdentity }
  Object.defineProperty(accessorIdentity, 'windowId', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'window-a'
    },
  })
  assert.throws(() => registry.markDirty(accessorIdentity, validDraft), TypeError)
  assert.equal(getterCalls, 0)

  assert.throws(() => registry.markDirty(validIdentity, {
    ...validDraft,
    extra: true,
  } as unknown as typeof validDraft), TypeError)
  assert.throws(() => registry.markDirty(validIdentity, draft(0)), TypeError)
  assert.throws(() => registry.markDirty(validIdentity, draft(1, {
    baseRawSha256: BASE_HASH.toUpperCase(),
  })), TypeError)
  assert.throws(() => registry.markDirty(validIdentity, draft(1, {
    fieldMask: ['title', 'content'],
  })), TypeError)
  assert.throws(() => registry.markDirty(validIdentity, draft(1, {
    fieldMask: ['content', 'content'],
  })), TypeError)
  assert.throws(() => registry.markDirty(validIdentity, draft(1, {
    payload: Number.NaN,
  })), TypeError)
  assert.throws(() => registry.markDirty(validIdentity, draft(1, {
    payload: new Date() as unknown as JsonValue,
  })), TypeError)

  const cyclic: { self?: JsonValue } = {}
  cyclic.self = cyclic
  assert.throws(() => registry.markDirty(validIdentity, draft(1, {
    payload: cyclic,
  })), TypeError)

  const accessorPayload = {}
  Object.defineProperty(accessorPayload, 'content', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'secret'
    },
  })
  assert.throws(() => registry.markDirty(validIdentity, draft(1, {
    payload: accessorPayload,
  })), TypeError)
  assert.equal(getterCalls, 0)

  assert.throws(() => registry.markSaving(validIdentity, 1, ''), TypeError)
  assert.throws(() => registry.markSaving(validIdentity, 0, 'request'), TypeError)
  assert.throws(() => registry.settle(
    validIdentity,
    1,
    'request',
    'done' as 'saved',
  ), TypeError)
})

test('recognizes exactly the terminal manuscript save protection codes', () => {
  assert.equal(isManuscriptSaveProtected('EXTERNAL_DRAFT_CONFLICT'), true)
  assert.equal(isManuscriptSaveProtected('RECOVERY_REQUIRED'), true)
  assert.equal(isManuscriptSaveProtected('external_draft_conflict'), false)
  assert.equal(isManuscriptSaveProtected('NETWORK_ERROR'), false)
  assert.equal(isManuscriptSaveProtected(null), false)
  assert.equal(isManuscriptSaveProtected(undefined), false)
})

test('creates stable dirty bindings only for canonical files chapter authorities', () => {
  const chapter = {
    chapterUid: RESOURCE_UID,
    manuscriptProjectUid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectInstanceId: PROJECT_INSTANCE_ID,
    baseWitness: {
      expected_data_version: 7,
      generation: 3,
      raw_sha256: 'a'.repeat(64),
      sidecar_raw_sha256: 'b'.repeat(64),
    },
  }
  const body = createManuscriptDirtyBinding(chapter, 'body')
  const sidecar = createManuscriptDirtyBinding(chapter, 'sidecar')

  assert.equal(body?.baseRawSha256, 'a'.repeat(64))
  assert.equal(sidecar?.baseRawSha256, 'b'.repeat(64))
  assert.equal(body?.identity.domain, 'body')
  assert.equal(sidecar?.identity.domain, 'sidecar')
  assert.equal(body?.identity.windowId, sidecar?.identity.windowId)
  assert.equal(
    createManuscriptDirtyBinding({ ...chapter, manuscriptProjectUid: chapter.manuscriptProjectUid.toUpperCase() }, 'body'),
    undefined,
  )
  assert.equal(
    createManuscriptDirtyBinding({
      ...chapter,
      baseWitness: { ...chapter.baseWitness, sidecar_raw_sha256: null },
    }, 'sidecar'),
    undefined,
  )
  assert.equal(createManuscriptDirtyBinding({ ...chapter, baseWitness: undefined }, 'body'), undefined)
})
