import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { HostMigrationPreflightCoordinator } from '../src/lib/manuscriptWindowCoordinator.ts'

const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222'
const CHAPTER_UID = '33333333-3333-4333-8333-333333333333'
const VOLUME_UID = '44444444-4444-4444-8444-444444444444'
const MANUSCRIPT_UID = '11111111-1111-4111-8111-111111111111'
const SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555'

type DirtyDomain = 'body' | 'sidecar' | 'volume_metadata' | 'structure'

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function dirty(
  domain: DirtyDomain,
  resourceUid: string,
  windowId: string,
  loaded = true,
) {
  return {
    domain,
    loaded,
    resourceKind: domain === 'volume_metadata' ? 'volume' : domain === 'structure' ? 'manuscript' : 'chapter',
    resourceUid,
    revision: 1,
    windowId,
  }
}

function queue(domain: DirtyDomain, windowId: string, loaded = true) {
  return {
    domain,
    loaded,
    queueId: `${windowId}:${domain}`,
    revision: 1,
    state: 'active',
    windowId,
  }
}

function createHostScene() {
  const calls = { cancelAndDrain: 0, freeze: 0, inspect: 0, release: 0 }
  const freezeRecords = new WeakMap<object, Readonly<Record<string, unknown>>>()
  const drainRecords = new WeakMap<object, Readonly<Record<string, unknown>>>()
  const released = new WeakSet<object>()
  const scene = {
    binding: {
      projectName: 'coordinated-project',
      projectInstanceId: PROJECT_INSTANCE_ID,
    },
    windowSetEpoch: 7,
    windows: [
      { windowId: 'window-a', revision: 1, responded: true },
      { windowId: 'window-b', revision: 1, responded: true },
    ],
    dirtyResources: [
      dirty('body', CHAPTER_UID, 'window-a'),
      dirty('sidecar', CHAPTER_UID, 'window-a'),
      dirty('volume_metadata', VOLUME_UID, 'window-b'),
      dirty('structure', MANUSCRIPT_UID, 'window-b'),
      dirty('body', CHAPTER_UID, 'window-b', false),
    ],
    saveQueues: [
      queue('body', 'window-a'),
      queue('sidecar', 'window-a'),
      queue('volume_metadata', 'window-b'),
      queue('structure', 'window-b'),
      { ...queue('body', 'window-b', false), queueId: 'window-b:unloaded-body' },
    ],
    drainDispositions: new Map<string, 'persisted' | 'unresolved'>(),
    keepQueueActive: new Set<string>(),
  }

  function snapshotDirty(entry: (typeof scene.dirtyResources)[number]) {
    return {
      domain: entry.domain,
      loaded: entry.loaded,
      resourceKind: entry.resourceKind,
      resourceUid: entry.resourceUid,
      revision: entry.revision,
      windowId: entry.windowId,
    }
  }

  function frozenDescription() {
    return deepFreeze({
      ...scene.binding,
      windowSetEpoch: scene.windowSetEpoch,
      windows: scene.windows.map((entry) => ({ ...entry })),
      dirtyResources: scene.dirtyResources.map(snapshotDirty),
      saveQueues: scene.saveQueues.map((entry) => ({ ...entry })),
    })
  }

  const hostState = {
    async freeze(projectInstanceId: string) {
      calls.freeze += 1
      assert.equal(projectInstanceId, PROJECT_INSTANCE_ID)
      const token = Object.freeze({})
      freezeRecords.set(token, frozenDescription())
      return token
    },
    describe(token: object) {
      if (released.has(token)) throw new TypeError('released freeze token')
      const description = freezeRecords.get(token)
      if (description === undefined) throw new TypeError('foreign freeze token')
      return description
    },
    async cancelAndDrain(token: object) {
      calls.cancelAndDrain += 1
      const frozen = freezeRecords.get(token)
      if (frozen === undefined || released.has(token)) throw new TypeError('foreign freeze token')
      const frozenDirty = frozen.dirtyResources as ReadonlyArray<ReturnType<typeof snapshotDirty>>
      const frozenQueues = frozen.saveQueues as ReadonlyArray<(typeof scene.saveQueues)[number]>
      const drainedQueues = frozenQueues.map((entry) => ({
        ...entry,
        state: scene.keepQueueActive.has(entry.queueId) ? 'active' : 'cancelled_and_drained',
      }))
      scene.saveQueues = drainedQueues.map((entry) => ({ ...entry }))
      const drainToken = Object.freeze({})
      drainRecords.set(drainToken, deepFreeze({
        windowSetEpoch: frozen.windowSetEpoch,
        dirtyResources: frozenDirty.map((entry) => ({
          ...entry,
          disposition: scene.drainDispositions.get(resourceKey(entry)) ?? 'unresolved',
        })),
        saveQueues: drainedQueues,
      }))
      return drainToken
    },
    describeDrain(token: object) {
      const description = drainRecords.get(token)
      if (description === undefined) throw new TypeError('foreign drain token')
      return description
    },
    inspect(token: object) {
      calls.inspect += 1
      if (!freezeRecords.has(token) || released.has(token)) throw new TypeError('foreign freeze token')
      return deepFreeze({
        windowSetEpoch: scene.windowSetEpoch,
        windows: scene.windows.map((entry) => ({ ...entry })),
        dirtyResources: scene.dirtyResources.map(snapshotDirty),
        saveQueues: scene.saveQueues.map((entry) => ({ ...entry })),
      })
    },
    async release(token: object) {
      calls.release += 1
      if (!freezeRecords.has(token) || released.has(token)) throw new TypeError('foreign freeze token')
      released.add(token)
    },
  }
  return { calls, hostState, scene }
}

function resourceKey(entry: {
  domain: string
  resourceKind: string
  resourceUid: string
  windowId: string
}) {
  return JSON.stringify([entry.resourceKind, entry.resourceUid, entry.domain, entry.windowId])
}

function createCoordinator() {
  const host = createHostScene()
  const migrationRequests: object[] = []
  let migrationError: Error | undefined
  const coordinator = new HostMigrationPreflightCoordinator({
    hostState: host.hostState,
    migrationApi: {
      async beginMigration(request: object) {
        migrationRequests.push(request)
        if (migrationError) throw migrationError
        return Object.freeze({ state: 'migration_started' })
      },
    },
    uuidV4() {
      return SNAPSHOT_ID
    },
  })
  return {
    coordinator,
    host,
    migrationRequests,
    setMigrationError(error: Error) { migrationError = error },
  }
}

test('constructor rejects getter/prototype ports before invoking them', () => {
  const host = createHostScene()
  let getterCalls = 0
  const getterPort = Object.defineProperty({}, 'freeze', {
    enumerable: true,
    get() {
      getterCalls += 1
      return host.hostState.freeze
    },
  })
  assert.throws(
    () => new HostMigrationPreflightCoordinator({
      hostState: getterPort as never,
      migrationApi: { async beginMigration() {} },
      uuidV4: () => SNAPSHOT_ID,
    }),
    TypeError,
  )
  assert.throws(
    () => new HostMigrationPreflightCoordinator({
      hostState: Object.create(host.hostState),
      migrationApi: { async beginMigration() {} },
      uuidV4: () => SNAPSHOT_ID,
    }),
    TypeError,
  )
  assert.equal(getterCalls, 0)
})

test('window timeout freezes a visible blocked snapshot and migration API remains untouched', async () => {
  const fixture = createCoordinator()
  fixture.host.scene.windows[1].responded = false
  for (const entry of fixture.host.scene.dirtyResources) {
    fixture.host.scene.drainDispositions.set(resourceKey(entry), 'persisted')
  }
  const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
  await fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
  assert.equal(fixture.coordinator.canConfirm(snapshot.snapshotId), false)
  await assert.rejects(
    fixture.coordinator.confirmAndBeginMigration(snapshot.snapshotId, { projectName: 'coordinated-project' }),
    /preflight/u,
  )
  assert.equal(fixture.migrationRequests.length, 0)
})

test('each unresolved dirty domain including unloaded drafts blocks migration before Task5 admission', async () => {
  const cases = [
    { domain: 'body', loaded: true },
    { domain: 'sidecar', loaded: true },
    { domain: 'volume_metadata', loaded: true },
    { domain: 'structure', loaded: true },
    { domain: 'body', loaded: false },
  ] as const
  for (const blocked of cases) {
    const fixture = createCoordinator()
    const target = fixture.host.scene.dirtyResources.find(
      (entry) => entry.domain === blocked.domain && entry.loaded === blocked.loaded,
    )
    assert.ok(target)
    for (const entry of fixture.host.scene.dirtyResources) {
      fixture.host.scene.drainDispositions.set(
        resourceKey(entry),
        entry === target ? 'unresolved' : 'persisted',
      )
    }
    const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
    await fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
    assert.equal(fixture.coordinator.canConfirm(snapshot.snapshotId), false)
    await assert.rejects(
      fixture.coordinator.confirmAndBeginMigration(snapshot.snapshotId, { projectName: 'coordinated-project' }),
      /preflight/u,
    )
    assert.equal(fixture.migrationRequests.length, 0)
  }
})

test('a queue that is not cancelled_and_drained blocks migration even when every draft persisted', async () => {
  const fixture = createCoordinator()
  for (const entry of fixture.host.scene.dirtyResources) {
    fixture.host.scene.drainDispositions.set(resourceKey(entry), 'persisted')
  }
  fixture.host.scene.keepQueueActive.add(fixture.host.scene.saveQueues[0].queueId)
  const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
  await fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
  assert.equal(fixture.coordinator.canConfirm(snapshot.snapshotId), false)
  await assert.rejects(
    fixture.coordinator.confirmAndBeginMigration(snapshot.snapshotId, { projectName: 'coordinated-project' }),
    /preflight/u,
  )
  assert.equal(fixture.migrationRequests.length, 0)
})

test('late dirty write, window set/revision, queue revision, and window epoch drift each invalidate the freeze', async () => {
  const mutations: Array<(fixture: ReturnType<typeof createCoordinator>) => void> = [
    (fixture) => { fixture.host.scene.dirtyResources[0].revision += 1 },
    (fixture) => { fixture.host.scene.windows.push({ windowId: 'window-c', revision: 1, responded: true }) },
    (fixture) => { fixture.host.scene.windows[0].revision += 1 },
    (fixture) => { fixture.host.scene.saveQueues[0].revision += 1 },
    (fixture) => { fixture.host.scene.windowSetEpoch += 1 },
  ]
  for (const mutate of mutations) {
    const fixture = createCoordinator()
    for (const entry of fixture.host.scene.dirtyResources) {
      fixture.host.scene.drainDispositions.set(resourceKey(entry), 'persisted')
    }
    const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
    await fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
    mutate(fixture)
    assert.equal(fixture.coordinator.canConfirm(snapshot.snapshotId), false)
    await assert.rejects(
      fixture.coordinator.confirmAndBeginMigration(snapshot.snapshotId, { projectName: 'coordinated-project' }),
      /stale|preflight/u,
    )
    assert.equal(fixture.migrationRequests.length, 0)
    await fixture.coordinator.cancel(snapshot.snapshotId)
    assert.equal(fixture.host.calls.release, 1)
  }
})

test('cancel releases freeze, invalidates original snapshot, and never calls migration API', async () => {
  const fixture = createCoordinator()
  const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
  await assert.rejects(
    fixture.coordinator.cancelAndDrainSaveQueues({ ...snapshot }),
    /foreign/u,
  )
  await fixture.coordinator.cancel(snapshot.snapshotId)
  assert.equal(fixture.host.calls.release, 1)
  assert.equal(fixture.migrationRequests.length, 0)
  await assert.rejects(fixture.coordinator.cancelAndDrainSaveQueues(snapshot), /foreign|inactive/u)
  await assert.rejects(
    fixture.coordinator.confirmAndBeginMigration(snapshot.snapshotId, { projectName: 'coordinated-project' }),
    /inactive|cancelled/u,
  )
})

test('only drain authority may mark a resource persisted', async () => {
  const fixture = createCoordinator()
  const target = fixture.host.scene.dirtyResources[0]
  const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
  await fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
  assert.throws(
    () => fixture.coordinator.recordDraftResolution(
      snapshot.snapshotId,
      resourceKey(target),
      'persisted' as never,
    ),
    /explicit/u,
  )
  assert.equal(fixture.coordinator.canConfirm(snapshot.snapshotId), false)
})

test('concurrent drain attempts consume the public snapshot operation exactly once', async () => {
  const fixture = createCoordinator()
  const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
  const first = fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
  const second = fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
  await first
  await assert.rejects(second, /already|inactive/u)
  assert.equal(fixture.host.calls.cancelAndDrain, 1)
})

test('all persisted or explicitly resolved resources call Task5 admission exactly once with authentic request', async () => {
  const fixture = createCoordinator()
  const [explicit, ...persisted] = fixture.host.scene.dirtyResources
  for (const entry of persisted) {
    fixture.host.scene.drainDispositions.set(resourceKey(entry), 'persisted')
  }
  const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
  await fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
  fixture.coordinator.recordDraftResolution(
    snapshot.snapshotId,
    resourceKey(explicit),
    'explicitly_resolved',
  )
  assert.equal(fixture.coordinator.canConfirm(snapshot.snapshotId), true)
  const result = await fixture.coordinator.confirmAndBeginMigration(
    snapshot.snapshotId,
    { projectName: 'coordinated-project' },
  )
  assert.deepEqual(result, { state: 'migration_started' })
  assert.equal(fixture.migrationRequests.length, 1)
  assert.deepEqual(fixture.migrationRequests[0], {
    projectName: 'coordinated-project',
    projectInstanceId: PROJECT_INSTANCE_ID,
    requestId: SNAPSHOT_ID,
  })
  assert.equal(Object.isFrozen(fixture.migrationRequests[0]), true)
  await assert.rejects(
    fixture.coordinator.confirmAndBeginMigration(
      snapshot.snapshotId,
      { projectName: 'coordinated-project' },
    ),
    /consumed|inactive/u,
  )
  assert.equal(fixture.migrationRequests.length, 1)
  assert.equal(fixture.host.calls.release, 1)
})

test('migration API failure consumes and releases the old snapshot before rejecting', async () => {
  const fixture = createCoordinator()
  for (const entry of fixture.host.scene.dirtyResources) {
    fixture.host.scene.drainDispositions.set(resourceKey(entry), 'persisted')
  }
  const snapshot = await fixture.coordinator.freezeAllWindows(PROJECT_INSTANCE_ID)
  await fixture.coordinator.cancelAndDrainSaveQueues(snapshot)
  fixture.setMigrationError(new Error('offline'))
  await assert.rejects(
    fixture.coordinator.confirmAndBeginMigration(
      snapshot.snapshotId,
      { projectName: 'coordinated-project' },
    ),
    /offline/u,
  )
  assert.equal(fixture.migrationRequests.length, 1)
  assert.equal(fixture.host.calls.release, 1)
  await assert.rejects(
    fixture.coordinator.confirmAndBeginMigration(
      snapshot.snapshotId,
      { projectName: 'coordinated-project' },
    ),
    /consumed|inactive/u,
  )
  assert.equal(fixture.migrationRequests.length, 1)
})

test('coordinator does not import or delegate to legacy beginFilesBetaMigration', () => {
  const source = readFileSync(new URL('../src/lib/manuscriptWindowCoordinator.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /beginFilesBetaMigration|manuscriptMigrationPreflight/u)
})
