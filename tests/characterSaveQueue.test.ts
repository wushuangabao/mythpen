import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, charactersApi } from '../src/lib/api.ts'
import { rememberProjectInstance, replaceProjectInstances } from '../src/lib/projectInstanceRegistry.ts'

const OUTBOX_KEY = 'mythpen-character-save-outbox-v1'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value))
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(message)
}

function installStorage(storage: MemoryStorage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

function persistedChanges(storage: MemoryStorage): Record<string, string>[] {
  const raw = storage.getItem(OUTBOX_KEY)
  if (!raw) return []
  return (JSON.parse(raw) as { entries: { changes: Record<string, string> }[] }).entries.map(
    (entry) => entry.changes,
  )
}

function persistedOutbox(storage: MemoryStorage): any {
  const raw = storage.getItem(OUTBOX_KEY)
  return raw ? JSON.parse(raw) : null
}

test('discarding a deleted project clears only its durable character changes', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  replaceProjectInstances([
    { name: 'deleted-character-project', instanceId: 'deleted-instance' },
    { name: 'retained-character-project', instanceId: 'retained-instance' },
  ])
  storage.setItem(
    OUTBOX_KEY,
    JSON.stringify({
      version: 3,
      entries: [
        {
          project: 'deleted-character-project',
          characterId: 'deleted-character',
          projectInstanceId: 'deleted-instance',
          changes: { background: '不得进入同名新项目' },
          versions: { background: 1 },
          failures: { background: { version: 1, message: '旧项目保存失败' } },
        },
        {
          project: 'retained-character-project',
          characterId: 'retained-character',
          projectInstanceId: 'retained-instance',
          changes: { background: '其他项目草稿' },
          versions: { background: 2 },
          failures: {},
        },
      ],
    }),
  )

  const queue = await import('../src/lib/characterSaveQueue.ts?discard-deleted-project')
  queue.discardProjectCharacterChanges('deleted-character-project')

  assert.deepEqual(queue.getRecoverableCharacterDrafts('deleted-character-project', []), [])
  assert.deepEqual(queue.getRecoverableCharacterDrafts('retained-character-project', []), [
    {
      characterId: 'retained-character',
      changes: { background: '其他项目草稿' },
      failures: {},
    },
  ])
  assert.equal(
    queue.getCharacterSaveSnapshot().overlays[
      queue.characterSaveKey('deleted-character-project', 'deleted-character')
    ],
    undefined,
  )
  assert.deepEqual(persistedOutbox(storage).entries.map((entry: any) => entry.project), [
    'retained-character-project',
  ])

  queue.discardProjectCharacterChanges('retained-character-project')
  assert.equal(storage.getItem(OUTBOX_KEY), null)
})

test('a deleted character request cannot restore over a same-name replacement edit', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const oldWrite = createDeferred<any>()
  let updateCount = 0

  try {
    charactersApi.update = async () => {
      updateCount++
      if (updateCount === 1) return oldWrite.promise
      return { success: true }
    }
    charactersApi.list = async () => [
      { id: 'reused-character-id', background: '同名新项目草稿' },
    ]

    const queue = await import('../src/lib/characterSaveQueue.ts?discard-inflight-project')
    const project = 'recreated-character-project'
    const characterId = 'reused-character-id'
    const saveKey = queue.characterSaveKey(project, characterId)
    rememberProjectInstance(project, 'old-instance')

    queue.enqueueCharacterChange(project, characterId, 'background', '旧实例草稿')
    const oldSave = queue.flushCharacterChanges(project, characterId)
    await waitFor(() => updateCount === 1, 'old character writer did not start')

    queue.discardProjectCharacterChanges(project)
    rememberProjectInstance(project, 'replacement-instance')
    queue.enqueueCharacterChange(project, characterId, 'background', '同名新项目草稿')
    await queue.flushCharacterChanges(project, characterId)

    oldWrite.reject(new Error('旧实例迟到失败'))
    await oldSave

    assert.equal(updateCount, 2)
    assert.deepEqual(queue.getCharacterSaveSnapshot().overlays[saveKey], {
      background: '同名新项目草稿',
    })
    assert.deepEqual(queue.getRecoverableCharacterDrafts(project, []), [])
    assert.equal(storage.getItem(OUTBOX_KEY), null)
    queue.discardProjectCharacterChanges(project)
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('migrates and isolates a legacy outbox entry without auto-flushing or losing its draft', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  replaceProjectInstances([{ name: 'legacy-project', instanceId: 'current-instance' }])
  storage.setItem(
    OUTBOX_KEY,
    JSON.stringify({
      version: 1,
      entries: [
        {
          project: 'legacy-project',
          characterId: 'legacy-character',
          changes: { background: 'legacy draft' },
          versions: { background: 9 },
        },
      ],
    }),
  )

  const originalUpdate = charactersApi.update
  let writes = 0
  charactersApi.update = async () => {
    writes++
    return { success: true }
  }

  const queue = await import('../src/lib/characterSaveQueue.ts?v1-migration')
  const migrated = persistedOutbox(storage)
  assert.equal(migrated.version, 3)
  assert.deepEqual(migrated.entries[0].changes, { background: 'legacy draft' })
  assert.deepEqual(migrated.entries[0].failures, {})
  assert.equal(migrated.entries[0].projectInstanceId, undefined)
  await queue.flushProjectCharacterChanges('legacy-project')
  assert.equal(writes, 0)
  assert.deepEqual(queue.getRecoverableCharacterDrafts('legacy-project', ['legacy-character']), [
    {
      characterId: 'legacy-character',
      changes: { background: 'legacy draft' },
      failures: {},
      recoveryKey: 'legacy-project\0legacy-character\0legacy',
      isolated: true,
    },
  ])
  queue.discardCharacterDraft('legacy-project', 'legacy-character', 'legacy-project\0legacy-character\0legacy')
  charactersApi.update = originalUpdate
})

test('keeps an older project-instance draft isolated from a same-name replacement', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  replaceProjectInstances([{ name: 'same-name-project', instanceId: 'replacement-instance' }])
  storage.setItem(
    OUTBOX_KEY,
    JSON.stringify({
      version: 3,
      entries: [
        {
          project: 'same-name-project',
          characterId: 'reused-character-id',
          projectInstanceId: 'deleted-instance',
          changes: { background: 'draft from the deleted project' },
          versions: { background: 11 },
          failures: { background: { version: 11, message: 'old save failed' } },
        },
      ],
    }),
  )

  const originalUpdate = charactersApi.update
  let writes = 0
  charactersApi.update = async () => {
    writes++
    return { success: true }
  }

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?old-instance-isolation')
    const saveKey = queue.characterSaveKey('same-name-project', 'reused-character-id')

    await queue.flushProjectCharacterChanges('same-name-project')

    assert.equal(writes, 0)
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey], undefined)
    assert.deepEqual(queue.getRecoverableCharacterDrafts('same-name-project', ['reused-character-id']), [
      {
        characterId: 'reused-character-id',
        changes: { background: 'draft from the deleted project' },
        failures: { background: 'old save failed' },
        recoveryKey: 'same-name-project\0reused-character-id\0deleted-instance',
        isolated: true,
      },
    ])
    assert.equal(persistedOutbox(storage).entries[0].projectInstanceId, 'deleted-instance')
    queue.discardCharacterDraft(
      'same-name-project',
      'reused-character-id',
      'same-name-project\0reused-character-id\0deleted-instance',
    )
    assert.equal(storage.getItem(OUTBOX_KEY), null)
  } finally {
    charactersApi.update = originalUpdate
  }
})

test('an active draft is isolated instead of flushed after its project instance rotates', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const project = 'active-rotation-project'
  const characterId = 'reused-character-id'
  replaceProjectInstances([{ name: project, instanceId: 'instance-a' }])

  const originalUpdate = charactersApi.update
  let writes = 0
  charactersApi.update = async () => {
    writes++
    return { success: true }
  }

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?active-instance-rotation')
    const saveKey = queue.characterSaveKey(project, characterId)
    queue.enqueueCharacterChange(project, characterId, 'background', 'draft from instance A')
    assert.equal(persistedOutbox(storage).entries[0].projectInstanceId, 'instance-a')

    rememberProjectInstance(project, 'instance-b')
    await queue.flushCharacterChanges(project, characterId)

    assert.equal(writes, 0)
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey], undefined)
    assert.deepEqual(queue.getRecoverableCharacterDrafts(project, [characterId]), [
      {
        characterId,
        changes: { background: 'draft from instance A' },
        failures: {},
        recoveryKey: `${project}\0${characterId}\0instance-a`,
        isolated: true,
      },
    ])
    assert.equal(persistedOutbox(storage).entries[0].projectInstanceId, 'instance-a')
    queue.discardCharacterDraft(project, characterId, `${project}\0${characterId}\0instance-a`)
  } finally {
    charactersApi.update = originalUpdate
  }
})

test('a queued save rechecks its instance immediately before sending', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const project = 'queued-rotation-project'
  const characterId = 'queued-character-id'
  replaceProjectInstances([{ name: project, instanceId: 'instance-a' }])

  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const firstWrite = createDeferred<any>()
  const writes: Record<string, string>[] = []
  charactersApi.update = async (_project, _characterId, changes) => {
    writes.push({ ...changes })
    if (writes.length === 1) return firstWrite.promise
    return { success: true }
  }
  charactersApi.list = async () => []

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?queued-instance-rotation')
    queue.enqueueCharacterChange(project, characterId, 'name', 'instance A name')
    const firstSave = queue.flushCharacterChanges(project, characterId)
    await waitFor(() => writes.length === 1, 'the first instance-A save did not start')

    queue.enqueueCharacterChange(project, characterId, 'age', '24')
    const queuedSave = queue.flushCharacterChanges(project, characterId)
    rememberProjectInstance(project, 'instance-b')
    firstWrite.resolve({ success: true })
    await Promise.all([firstSave, queuedSave])

    assert.deepEqual(writes, [{ name: 'instance A name' }])
    assert.deepEqual(queue.getRecoverableCharacterDrafts(project, [characterId]), [
      {
        characterId,
        changes: { name: 'instance A name', age: '24' },
        failures: {},
        recoveryKey: `${project}\0${characterId}\0instance-a`,
        isolated: true,
      },
    ])
    queue.discardCharacterDraft(project, characterId, `${project}\0${characterId}\0instance-a`)
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('discarding a current draft does not delete an isolated draft with the same character id', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  replaceProjectInstances([{ name: 'coexisting-project', instanceId: 'current-instance' }])
  storage.setItem(
    OUTBOX_KEY,
    JSON.stringify({
      version: 3,
      entries: [
        {
          project: 'coexisting-project',
          characterId: 'shared-character-id',
          projectInstanceId: 'old-instance',
          changes: { background: 'isolated old draft' },
          versions: { background: 5 },
          failures: {},
        },
      ],
    }),
  )

  const queue = await import('../src/lib/characterSaveQueue.ts?coexisting-instance-drafts')
  queue.enqueueCharacterChange('coexisting-project', 'shared-character-id', 'age', '23')

  assert.equal(persistedOutbox(storage).entries.length, 2)
  assert.equal(queue.discardCharacterDraft('coexisting-project', 'shared-character-id'), true)
  assert.deepEqual(queue.getRecoverableCharacterDrafts('coexisting-project', ['shared-character-id']), [
    {
      characterId: 'shared-character-id',
      changes: { background: 'isolated old draft' },
      failures: {},
      recoveryKey: 'coexisting-project\0shared-character-id\0old-instance',
      isolated: true,
    },
  ])
  assert.deepEqual(
    persistedOutbox(storage).entries.map((entry: any) => entry.projectInstanceId),
    ['old-instance'],
  )
  queue.discardCharacterDraft(
    'coexisting-project',
    'shared-character-id',
    'coexisting-project\0shared-character-id\0old-instance',
  )
  assert.equal(storage.getItem(OUTBOX_KEY), null)
})

test('persists failed field identity across restart and keeps a new field in a separate request', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  replaceProjectInstances([{ name: 'restart-failure-project', instanceId: 'restart-instance' }])
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  charactersApi.list = async () => []

  try {
    charactersApi.update = async () => {
      throw new Error('name conflict')
    }
    const firstQueue = await import('../src/lib/characterSaveQueue.ts?persisted-field-failure-writer')
    const project = 'restart-failure-project'
    const characterId = 'deleted-character'
    firstQueue.enqueueCharacterChange(project, characterId, 'name', 'Conflicting name')
    await assert.rejects(firstQueue.flushCharacterChanges(project, characterId), /name conflict/)

    const failedPayload = persistedOutbox(storage)
    assert.equal(failedPayload.version, 3)
    assert.equal(failedPayload.entries[0].projectInstanceId, 'restart-instance')
    assert.deepEqual(failedPayload.entries[0].failures, {
      name: { version: failedPayload.entries[0].versions.name, message: 'name conflict' },
    })

    const writes: Record<string, string>[] = []
    charactersApi.update = async (_targetProject, _targetId, changes) => {
      writes.push({ ...changes })
      return { success: true }
    }
    const restartedQueue = await import('../src/lib/characterSaveQueue.ts?persisted-field-failure-reader')
    assert.equal(restartedQueue.getCharacterSaveSnapshot().errors[project], 'name conflict')
    assert.deepEqual(restartedQueue.getRecoverableCharacterDrafts(project, [characterId]), [])
    restartedQueue.enqueueCharacterChange(project, characterId, 'age', '19')
    await restartedQueue.flushCharacterChanges(project, characterId)

    assert.deepEqual(writes, [{ age: '19' }])
    const drafts = restartedQueue.getRecoverableCharacterDrafts(project, [])
    assert.deepEqual(drafts, [
      {
        characterId,
        changes: { name: 'Conflicting name' },
        failures: { name: 'name conflict' },
      },
    ])
    assert.equal(restartedQueue.discardCharacterDraft(project, characterId), true)
    assert.equal(storage.getItem(OUTBOX_KEY), null)
    assert.deepEqual(restartedQueue.getRecoverableCharacterDrafts(project, []), [])
    assert.equal(restartedQueue.getCharacterSaveSnapshot().errors[project], undefined)
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('replays the durable outbox, autosaves, and persists a new edit before its request starts', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  replaceProjectInstances([{ name: 'durable-project', instanceId: 'durable-instance' }])
  storage.setItem(
    OUTBOX_KEY,
    JSON.stringify({
      version: 3,
      entries: [
        {
          project: 'durable-project',
          characterId: 'character-1',
          projectInstanceId: 'durable-instance',
          changes: { background: '重启后仍在' },
          versions: { background: 7 },
        },
      ],
    }),
  )

  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const updates: { project: string; id: string; changes: Record<string, string> }[] = []
  charactersApi.update = async (project, id, changes) => {
    updates.push({ project, id, changes })
    return { success: true }
  }
  charactersApi.list = async () => [{ id: 'character-1', background: '重启后仍在', age: '42' }]

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?durable-outbox')
    const saveKey = queue.characterSaveKey('durable-project', 'character-1')
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.background, '重启后仍在')
    assert.deepEqual(persistedChanges(storage), [{ background: '重启后仍在' }])

    await waitFor(() => updates.length === 1, 'the restored edit was not autosaved')
    await waitFor(() => storage.getItem(OUTBOX_KEY) === null, 'the successful restored edit stayed in the outbox')
    assert.deepEqual(updates[0], {
      project: 'durable-project',
      id: 'character-1',
      changes: { background: '重启后仍在' },
    })

    queue.enqueueCharacterChange('durable-project', 'character-1', 'age', '42')
    assert.deepEqual(persistedChanges(storage), [{ age: '42' }], 'enqueue must persist before the debounce fires')

    await waitFor(() => updates.length === 2, 'the new edit was not debounced and autosaved')
    await waitFor(() => storage.getItem(OUTBOX_KEY) === null, 'the successful new edit stayed in the outbox')
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('a later field success does not clear another field failure or its durable retry', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const writes: Deferred<unknown>[] = []
  charactersApi.update = async () => {
    const write = createDeferred<unknown>()
    writes.push(write)
    return write.promise
  }
  charactersApi.list = async () => []
  rememberProjectInstance('failure-project', 'failure-instance')

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?field-errors')
    queue.enqueueCharacterChange('failure-project', 'character-2', 'name', '新名字')
    const nameSave = queue.flushCharacterChanges('failure-project', 'character-2')
    const expectedNameFailure = assert.rejects(nameSave, /姓名保存失败/)
    await waitFor(() => writes.length === 1, 'the name request did not start')
    assert.deepEqual(persistedChanges(storage), [{ name: '新名字' }], 'in-flight edits must stay durable')

    queue.enqueueCharacterChange('failure-project', 'character-2', 'age', '19')
    const ageSave = queue.flushCharacterChanges('failure-project', 'character-2')
    writes[0].reject(new Error('姓名保存失败'))
    await expectedNameFailure
    await waitFor(() => writes.length === 2, 'the serialized age request did not start')
    writes[1].resolve({ success: true })
    await ageSave

    assert.equal(queue.getCharacterSaveSnapshot().errors['failure-project'], '姓名保存失败')
    assert.deepEqual(persistedChanges(storage), [{ name: '新名字' }])
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('a failed field is retried separately and cannot block a later field', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const writes: Record<string, string>[] = []
  let rejectName = true
  charactersApi.update = async (_project, _id, changes) => {
    writes.push({ ...changes })
    if ('name' in changes && rejectName) throw new Error('name conflict')
    return { success: true }
  }
  charactersApi.list = async () => []

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?failed-field-isolation')
    const project = 'isolated-failure-project'
    const characterId = 'character-isolated'
    rememberProjectInstance(project, 'isolated-failure-instance')

    queue.enqueueCharacterChange(project, characterId, 'name', 'Conflicting name')
    await assert.rejects(queue.flushCharacterChanges(project, characterId), /name conflict/)

    queue.enqueueCharacterChange(project, characterId, 'age', '19')
    await queue.flushCharacterChanges(project, characterId)
    assert.deepEqual(writes, [{ name: 'Conflicting name' }, { age: '19' }])
    assert.deepEqual(persistedChanges(storage), [{ name: 'Conflicting name' }])

    rejectName = false
    await queue.flushCharacterChanges(project, characterId)
    assert.deepEqual(writes[2], { name: 'Conflicting name' })
    assert.equal(storage.getItem(OUTBOX_KEY), null)
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('a missing-character response keeps the durable draft and overlay for recovery', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  let listCalls = 0
  const refreshNotifications: { project: string; characterId: string }[] = []
  charactersApi.update = async () => {
    throw new ApiError('角色不存在', 404, 'DB_NOT_FOUND', true)
  }
  charactersApi.list = async () => {
    listCalls += 1
    return []
  }

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?missing-character')
    const project = 'deleted-character-project'
    const characterId = 'deleted-character'
    const saveKey = queue.characterSaveKey(project, characterId)
    rememberProjectInstance(project, 'missing-character-instance')
    queue.setCharacterSaveNotifier((targetProject, targetCharacterId) => {
      refreshNotifications.push({ project: targetProject, characterId: targetCharacterId })
    })

    queue.enqueueCharacterChange(project, characterId, 'background', '仍需恢复的草稿')
    await assert.rejects(queue.flushCharacterChanges(project, characterId), /角色不存在/)

    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.background, '仍需恢复的草稿')
    assert.equal(queue.getCharacterSaveSnapshot().errors[project], '角色不存在')
    assert.deepEqual(persistedChanges(storage), [{ background: '仍需恢复的草稿' }])
    assert.equal(listCalls, 0, 'a failed PUT must not start authoritative confirmation')
    assert.deepEqual(refreshNotifications, [{ project, characterId }], 'the page was not asked to reload its list')

    charactersApi.update = async () => {
      throw new ApiError('普通字段错误', 400, 'INVALID_PARAMS', true)
    }
    queue.enqueueCharacterChange(project, characterId, 'age', 'invalid')
    await assert.rejects(queue.flushCharacterChanges(project, characterId), /普通字段错误/)
    assert.equal(refreshNotifications.length, 1, 'a non-404 failure incorrectly requested a list refresh')
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.background, '仍需恢复的草稿')
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('only a matching post-save generation may retire an overlay with a different server value', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const listRequests: Deferred<unknown>[] = []
  charactersApi.update = async () => ({ success: true })
  charactersApi.list = async () => {
    const request = createDeferred<unknown>()
    listRequests.push(request)
    return request.promise
  }

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?authoritative-confirmation')
    const project = 'confirmation-project'
    const characterId = 'character-3'
    const saveKey = queue.characterSaveKey(project, characterId)
    rememberProjectInstance(project, 'confirmation-instance')

    queue.enqueueCharacterChange(project, characterId, 'age', '20')
    await queue.flushCharacterChanges(project, characterId)
    await waitFor(() => listRequests.length === 1, 'the first post-save confirmation did not start')

    queue.confirmCharacterChanges(project, [{ id: characterId, age: '19' }])
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.age, '20', 'an old GET cleared the overlay')

    queue.enqueueCharacterChange(project, characterId, 'age', '22')
    listRequests[0].resolve([{ id: characterId, age: '21' }])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(
      queue.getCharacterSaveSnapshot().overlays[saveKey]?.age,
      '22',
      'the previous post-save GET cleared a newer edit',
    )

    await queue.flushCharacterChanges(project, characterId)
    await waitFor(() => listRequests.length === 2, 'the second post-save confirmation did not start')
    queue.confirmCharacterChanges(project, [{ id: characterId, age: '20' }])
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.age, '22')

    listRequests[1].resolve([{ id: characterId, age: '23' }])
    await waitFor(
      () => queue.getCharacterSaveSnapshot().overlays[saveKey]?.age === '23',
      'the reload gap did not display the authoritative external value',
    )
    queue.confirmCharacterChanges(project, [{ id: characterId, age: '23' }])
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.age, undefined)
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('a failed post-save authority GET is retried after a later list mismatch', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const listRequests: Deferred<unknown>[] = []
  charactersApi.update = async () => ({ success: true })
  charactersApi.list = async () => {
    const request = createDeferred<unknown>()
    listRequests.push(request)
    return request.promise
  }

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?confirmation-retry')
    const project = 'retry-confirmation-project'
    const characterId = 'character-4'
    const saveKey = queue.characterSaveKey(project, characterId)
    rememberProjectInstance(project, 'retry-confirmation-instance')

    queue.enqueueCharacterChange(project, characterId, 'age', '20')
    await queue.flushCharacterChanges(project, characterId)
    await waitFor(() => listRequests.length === 1, 'the initial authority GET did not start')
    listRequests[0].reject(new Error('temporary list failure'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    queue.confirmCharacterChanges(project, [{ id: characterId, age: '21' }])
    await waitFor(() => listRequests.length === 2, 'the unresolved confirmation was not retried')
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.age, '20')

    listRequests[1].resolve([{ id: characterId, age: '21' }])
    await waitFor(() => queue.getCharacterSaveSnapshot().overlays[saveKey]?.age === '21', 'retry was not applied')
    queue.confirmCharacterChanges(project, [{ id: characterId, age: '21' }])
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.age, undefined)
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('a pre-save list exact match cannot retire confirmation before the authority GET', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const originalUpdate = charactersApi.update
  const originalList = charactersApi.list
  const authorityRequest = createDeferred<unknown>()
  charactersApi.update = async () => ({ success: true })
  charactersApi.list = async () => authorityRequest.promise

  try {
    const queue = await import('../src/lib/characterSaveQueue.ts?exact-before-authority')
    const project = 'exact-before-authority-project'
    const characterId = 'character-5'
    const saveKey = queue.characterSaveKey(project, characterId)
    rememberProjectInstance(project, 'exact-before-authority-instance')

    // The ordinary request may have started before the PUT, so its exact value
    // is not proof that it observed the completed save.
    queue.enqueueCharacterChange(project, characterId, 'age', '20')
    await queue.flushCharacterChanges(project, characterId)
    queue.confirmCharacterChanges(project, [{ id: characterId, age: '20' }])
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.age, '20')

    authorityRequest.resolve([{ id: characterId, age: '21' }])
    await waitFor(
      () => queue.getCharacterSaveSnapshot().overlays[saveKey]?.age === '21',
      'the dedicated authority response was ignored after the stale exact match',
    )
    queue.confirmCharacterChanges(project, [{ id: characterId, age: '21' }])
    assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.age, undefined)
  } finally {
    charactersApi.update = originalUpdate
    charactersApi.list = originalList
  }
})

test('same-name instance rotation isolates old drafts and clears their active overlay', async () => {
  const storage = new MemoryStorage()
  installStorage(storage)
  const queue = await import('../src/lib/characterSaveQueue.ts?instance-retirement')
  const project = 'rotated-character-project'
  const characterId = 'character-old'
  const saveKey = queue.characterSaveKey(project, characterId)

  rememberProjectInstance(project, 'instance-a')
  queue.enqueueCharacterChange(project, characterId, 'background', 'draft from A')
  assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey]?.background, 'draft from A')

  replaceProjectInstances([{ name: project, instanceId: 'instance-b' }])
  queue.retireStaleProjectCharacterInstance(project)

  assert.equal(queue.getCharacterSaveSnapshot().overlays[saveKey], undefined)
  const recoverable = queue.getRecoverableCharacterDrafts(project, [])
  assert.equal(recoverable.length, 1)
  assert.equal(recoverable[0].isolated, true)
  assert.equal(recoverable[0].changes.background, 'draft from A')
})
