import assert from 'node:assert/strict'
import test from 'node:test'

import { createManuscriptMigrationAdmission } from '../src/lib/manuscriptMigrationAdmission.ts'

const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_NAME = 'sqlite-project-before-files-migration'
const REQUEST_ID = 'migration-request-1'

type Descriptor = Readonly<Record<string, unknown>>

function opaqueAuthority<T extends object, D extends Descriptor>() {
  const records = new WeakMap<T, D>()
  const authority = Object.freeze({
    assert(value: T) {
      if (!records.has(value)) throw new TypeError('foreign authority')
      return value
    },
    describe(value: T) {
      const descriptor = records.get(value)
      if (descriptor === undefined) throw new TypeError('foreign authority')
      return descriptor
    },
  })
  return {
    authority,
    mint(descriptor: D): T {
      const value = Object.freeze({}) as T
      records.set(value, descriptor)
      return value
    },
  }
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  return value
}

function hostDescriptor(overrides: Record<string, unknown> = {}) {
  const windows = [
    { windowId: 'window-a', revision: 4, responded: true },
    { windowId: 'window-b', revision: 9, responded: true },
  ]
  const dirty = [
    { resourceKey: 'chapter:one:body', revision: 7, disposition: 'persisted' },
    { resourceKey: 'chapter:two:title', revision: 3, disposition: 'explicitly_resolved' },
  ]
  const queues = [
    { queueId: 'body', revision: 8, state: 'cancelled_and_drained' },
    { queueId: 'title', revision: 5, state: 'cancelled_and_drained' },
  ]
  return freeze({
    projectName: PROJECT_NAME,
    projectInstanceId: PROJECT_INSTANCE_ID,
    requestId: REQUEST_ID,
    frozenWindows: windows,
    currentWindows: windows.map((entry) => ({ ...entry })),
    frozenDirtyResources: dirty,
    currentDirtyResources: dirty.map((entry) => ({ ...entry })),
    frozenSaveQueues: queues,
    currentSaveQueues: queues.map((entry) => ({ ...entry })),
    ...overrides,
  })
}

function fixture(descriptor = hostDescriptor(), requestBinding = {
  projectName: PROJECT_NAME,
  projectInstanceId: PROJECT_INSTANCE_ID,
  requestId: REQUEST_ID,
}) {
  const snapshots = opaqueAuthority<object, Descriptor>()
  const requests = opaqueAuthority<object, Descriptor>()
  const snapshot = snapshots.mint(descriptor)
  const request = requests.mint(freeze(requestBinding))
  const calls: object[] = []
  let migrationError: Error | undefined
  const migrationApi = {
    async beginMigration(value: object) {
      calls.push(value)
      if (migrationError) throw migrationError
      return Object.freeze({ state: 'migration_started' })
    },
  }
  const admission = createManuscriptMigrationAdmission({
    hostPreflightAuthority: snapshots.authority,
    migrationRequestAuthority: requests.authority,
    migrationApi,
  })
  return {
    admission,
    calls,
    request,
    requests,
    setMigrationError(error: Error) { migrationError = error },
    snapshot,
    snapshots,
  }
}

test('SQLite preflight with no project UID starts exactly one migration from name and instance truth', async () => {
  const scene = fixture()
  const result = await scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, scene.request)
  assert.deepEqual(result, { state: 'migration_started' })
  assert.deepEqual(scene.calls, [scene.request])
  await assert.rejects(
    scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, scene.request),
    /consumed/u,
  )
  assert.equal(scene.calls.length, 1)
})

test('plain snapshot/request are rejected before migration API', async () => {
  const scene = fixture()
  await assert.rejects(
    scene.admission.beginMigrationAfterHostPreflight(Object.freeze({}), scene.request),
    TypeError,
  )
  await assert.rejects(
    scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, Object.freeze({})),
    TypeError,
  )
  assert.equal(scene.calls.length, 0)
})

test('window set/revision drift and a nonresponsive window fail closed', async () => {
  const cases = [
    hostDescriptor({ currentWindows: freeze([
      { windowId: 'window-a', revision: 4, responded: true },
    ]) }),
    hostDescriptor({ currentWindows: freeze([
      { windowId: 'window-a', revision: 5, responded: true },
      { windowId: 'window-b', revision: 9, responded: true },
    ]) }),
    hostDescriptor({ frozenWindows: freeze([
      { windowId: 'window-a', revision: 4, responded: false },
      { windowId: 'window-b', revision: 9, responded: true },
    ]) }),
  ]
  for (const descriptor of cases) {
    const scene = fixture(descriptor)
    await assert.rejects(
      scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, scene.request),
      /host preflight/u,
    )
    assert.equal(scene.calls.length, 0)
  }
})

test('unresolved or changed dirty resources and undrained or changed queues fail closed', async () => {
  const unresolved = hostDescriptor({ frozenDirtyResources: freeze([
    { resourceKey: 'chapter:one:body', revision: 7, disposition: 'unresolved' },
  ]), currentDirtyResources: freeze([
    { resourceKey: 'chapter:one:body', revision: 7, disposition: 'unresolved' },
  ]) })
  const dirtyChanged = hostDescriptor({ currentDirtyResources: freeze([
    { resourceKey: 'chapter:one:body', revision: 8, disposition: 'persisted' },
    { resourceKey: 'chapter:two:title', revision: 3, disposition: 'explicitly_resolved' },
  ]) })
  const activeQueue = hostDescriptor({ frozenSaveQueues: freeze([
    { queueId: 'body', revision: 8, state: 'active' },
  ]), currentSaveQueues: freeze([
    { queueId: 'body', revision: 8, state: 'active' },
  ]) })
  const queueChanged = hostDescriptor({ currentSaveQueues: freeze([
    { queueId: 'body', revision: 9, state: 'cancelled_and_drained' },
    { queueId: 'title', revision: 5, state: 'cancelled_and_drained' },
  ]) })
  for (const descriptor of [unresolved, dirtyChanged, activeQueue, queueChanged]) {
    const scene = fixture(descriptor)
    await assert.rejects(
      scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, scene.request),
      /host preflight/u,
    )
    assert.equal(scene.calls.length, 0)
  }
})

test('snapshot and migration request must bind the same project instance', async () => {
  const scene = fixture(hostDescriptor(), {
    projectName: PROJECT_NAME,
    projectInstanceId: '99999999-9999-4999-8999-999999999999',
    requestId: REQUEST_ID,
  })
  await assert.rejects(
    scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, scene.request),
    /project binding/u,
  )
  assert.equal(scene.calls.length, 0)
})

test('snapshot and request are consumed before migration I/O, including failure', async () => {
  const scene = fixture()
  scene.setMigrationError(new Error('offline'))
  await assert.rejects(
    scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, scene.request),
    /offline/u,
  )
  assert.equal(scene.calls.length, 1)
  await assert.rejects(
    scene.admission.beginMigrationAfterHostPreflight(scene.snapshot, scene.request),
    /consumed/u,
  )
  assert.equal(scene.calls.length, 1)
})

test('authority getters/prototypes and mutable descriptions fail before migration I/O', async () => {
  const scene = fixture()
  assert.throws(
    () => createManuscriptMigrationAdmission({
      hostPreflightAuthority: Object.create(scene.snapshots.authority),
      migrationRequestAuthority: scene.requests.authority,
      migrationApi: { async beginMigration() {} },
    }),
    TypeError,
  )

  const snapshots = opaqueAuthority<object, Descriptor>()
  const mutable = { ...hostDescriptor() }
  const snapshot = snapshots.mint(mutable)
  const requests = opaqueAuthority<object, Descriptor>()
  const request = requests.mint(freeze({
    projectName: PROJECT_NAME,
    projectInstanceId: PROJECT_INSTANCE_ID,
    requestId: REQUEST_ID,
  }))
  let calls = 0
  const admission = createManuscriptMigrationAdmission({
    hostPreflightAuthority: snapshots.authority,
    migrationRequestAuthority: requests.authority,
    migrationApi: { async beginMigration() { calls += 1 } },
  })
  await assert.rejects(admission.beginMigrationAfterHostPreflight(snapshot, request), /frozen/u)
  assert.equal(calls, 0)
})

test('construction captures ports without freezing or otherwise mutating caller options', () => {
  const scene = fixture()
  const options = {
    hostPreflightAuthority: scene.snapshots.authority,
    migrationRequestAuthority: scene.requests.authority,
    migrationApi: { async beginMigration() {} },
  }
  createManuscriptMigrationAdmission(options)
  assert.equal(Object.isFrozen(options), false)
  options.migrationApi = { async beginMigration() {} }
})
