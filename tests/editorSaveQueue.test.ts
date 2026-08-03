import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type EditorSaveEntry,
  discardEditorSave,
  discardProjectEditorSaves,
  editorSaveKey,
  enqueueEditorSave,
  flushEditorSave,
  getEditorSaveDraft,
  getEditorSaveQueueSnapshot,
} from '../src/lib/editorSaveQueue.ts'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

function createDeferred(): Deferred {
  let resolvePromise!: () => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('Timed out waiting for queued writer')
}

test('retains a failed draft and error until a successful retry clears both', async () => {
  const project = 'retry-project'
  const chapterId = 101
  const saveKey = editorSaveKey(project, chapterId)
  const writtenEntries: EditorSaveEntry[] = []

  enqueueEditorSave(project, chapterId, 1, '未保存正文', 4)
  await assert.rejects(
    flushEditorSave(project, chapterId, async (entry) => {
      writtenEntries.push(entry)
      throw new Error('磁盘暂时不可用')
    }),
    /磁盘暂时不可用/,
  )

  let queueSnapshot = getEditorSaveQueueSnapshot()
  assert.equal(queueSnapshot.drafts[saveKey], '未保存正文')
  assert.equal(queueSnapshot.errors[saveKey], '磁盘暂时不可用')
  assert.equal(getEditorSaveDraft(project, chapterId)?.content, '未保存正文')

  await flushEditorSave(project, chapterId, async (entry) => {
    writtenEntries.push(entry)
  })

  queueSnapshot = getEditorSaveQueueSnapshot()
  assert.equal(queueSnapshot.drafts[saveKey], undefined)
  assert.equal(queueSnapshot.errors[saveKey], undefined)
  assert.equal(getEditorSaveDraft(project, chapterId), null)
  assert.equal(writtenEntries.length, 2)
  assert.equal(writtenEntries[1].version, writtenEntries[0].version)
  assert.equal(writtenEntries[1].content, '未保存正文')
  assert.equal(writtenEntries[1].baseDataVersion, 4)
})

test('an older successful write cannot clear a newer snapshot and writes stay serialized', async () => {
  const project = 'old-success-project'
  const chapterId = 202
  const saveKey = editorSaveKey(project, chapterId)
  const writtenEntries: EditorSaveEntry[] = []
  const writes: Deferred[] = []
  let activeWrites = 0
  let maximumActiveWrites = 0

  const writer = (entry: EditorSaveEntry) => {
    writtenEntries.push(entry)
    activeWrites++
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites)
    const write = createDeferred()
    writes.push(write)
    return write.promise.finally(() => {
      activeWrites--
    })
  }

  enqueueEditorSave(project, chapterId, 2, '旧快照', 6)
  const olderSave = flushEditorSave(project, chapterId, writer)
  await waitFor(() => writes.length === 1)

  enqueueEditorSave(project, chapterId, 2, '新快照', 99)
  const newerSave = flushEditorSave(project, chapterId, writer)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(writes.length, 1, 'the newer writer must wait for the older writer')

  writes[0].resolve()
  await olderSave
  await waitFor(() => writes.length === 2)

  assert.equal(getEditorSaveQueueSnapshot().drafts[saveKey], '新快照')
  assert.equal(getEditorSaveDraft(project, chapterId)?.content, '新快照')
  assert.equal(getEditorSaveDraft(project, chapterId)?.baseDataVersion, 6)
  assert.ok(writtenEntries[1].version > writtenEntries[0].version)

  writes[1].resolve()
  await newerSave
  assert.equal(getEditorSaveQueueSnapshot().drafts[saveKey], undefined)
  assert.equal(maximumActiveWrites, 1)
})

test('new input keeps the draft base version and serialized successes advance already-waiting entries', async () => {
  const project = 'cas-chain-project'
  const chapterId = 212
  const writes: Deferred[] = []
  const writtenEntries: EditorSaveEntry[] = []

  const writer = async (entry: EditorSaveEntry) => {
    writtenEntries.push({ ...entry })
    const write = createDeferred()
    writes.push(write)
    await write.promise
    return entry.baseDataVersion + 1
  }

  enqueueEditorSave(project, chapterId, 2, 'first local snapshot', 10)
  const firstSave = flushEditorSave(project, chapterId, writer)
  await waitFor(() => writes.length === 1)

  // Both successors are taken out of pendingSaves before the first request
  // completes. Their supplied versions must not rebase the still-unsaved draft.
  enqueueEditorSave(project, chapterId, 2, 'second local snapshot', 99)
  const secondSave = flushEditorSave(project, chapterId, writer)
  enqueueEditorSave(project, chapterId, 2, 'third local snapshot', 100)
  const thirdSave = flushEditorSave(project, chapterId, writer)
  assert.equal(getEditorSaveDraft(project, chapterId)?.baseDataVersion, 10)

  writes[0].resolve()
  await firstSave
  await waitFor(() => writes.length === 2)
  assert.equal(writtenEntries[1].baseDataVersion, 11)

  writes[1].resolve()
  await secondSave
  await waitFor(() => writes.length === 3)
  assert.equal(writtenEntries[2].baseDataVersion, 12)

  writes[2].resolve()
  await thirdSave
  assert.equal(getEditorSaveDraft(project, chapterId), null)
  assert.deepEqual(
    writtenEntries.map((entry) => entry.baseDataVersion),
    [10, 11, 12],
  )
})

test('a CAS conflict retains the original draft version and exposes the server error', async () => {
  const project = 'cas-conflict-project'
  const chapterId = 222
  const saveKey = editorSaveKey(project, chapterId)

  enqueueEditorSave(project, chapterId, 2, 'stale queued draft', 3)
  await assert.rejects(
    flushEditorSave(project, chapterId, async () => {
      throw new Error('正文已在其他窗口更新，请处理冲突')
    }),
    /正文已在其他窗口更新/,
  )

  const retainedDraft = getEditorSaveDraft(project, chapterId)
  assert.equal(retainedDraft?.content, 'stale queued draft')
  assert.equal(retainedDraft?.baseDataVersion, 3)
  assert.match(getEditorSaveQueueSnapshot().errors[saveKey] || '', /正文已在其他窗口更新/)

  // Even if the chapter store has since loaded a newer authoritative version,
  // editing the retained draft must not silently grant it permission to
  // overwrite that version.
  enqueueEditorSave(project, chapterId, 2, 'edited after conflict', 99)
  assert.equal(getEditorSaveDraft(project, chapterId)?.baseDataVersion, 3)
  await flushEditorSave(project, chapterId, async (entry) => {
    assert.equal(entry.baseDataVersion, 3)
    return 4
  })
})

test('an older failed write cannot restore over a newer queued snapshot', async () => {
  const project = 'old-failure-project'
  const chapterId = 303
  const saveKey = editorSaveKey(project, chapterId)
  const writtenEntries: EditorSaveEntry[] = []
  const writes: Deferred[] = []
  let activeWrites = 0
  let maximumActiveWrites = 0

  const writer = (entry: EditorSaveEntry) => {
    writtenEntries.push(entry)
    activeWrites++
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites)
    const write = createDeferred()
    writes.push(write)
    return write.promise.finally(() => {
      activeWrites--
    })
  }

  enqueueEditorSave(project, chapterId, 3, '会失败的旧快照', 8)
  const olderSave = flushEditorSave(project, chapterId, writer)
  const expectedFailure = assert.rejects(olderSave, /旧请求失败/)
  await waitFor(() => writes.length === 1)

  enqueueEditorSave(project, chapterId, 3, '失败期间的新快照', 9)
  const newerSave = flushEditorSave(project, chapterId, writer)
  writes[0].reject(new Error('旧请求失败'))
  await expectedFailure
  await waitFor(() => writes.length === 2)

  let queueSnapshot = getEditorSaveQueueSnapshot()
  assert.equal(queueSnapshot.drafts[saveKey], '失败期间的新快照')
  assert.equal(queueSnapshot.errors[saveKey], undefined)
  assert.equal(getEditorSaveDraft(project, chapterId)?.version, writtenEntries[1].version)

  writes[1].resolve()
  await newerSave
  queueSnapshot = getEditorSaveQueueSnapshot()
  assert.equal(queueSnapshot.drafts[saveKey], undefined)
  assert.equal(queueSnapshot.errors[saveKey], undefined)
  assert.equal(maximumActiveWrites, 1)
})

test('discarding a deleted project removes its drafts and invalidates queued writers', async () => {
  const deletedProject = 'deleted-editor-project'
  const retainedProject = 'retained-editor-project'
  const deletedKey = editorSaveKey(deletedProject, 404)
  const retainedKey = editorSaveKey(retainedProject, 505)
  let deletedWrites = 0

  enqueueEditorSave(deletedProject, 404, 4, '不得进入同名新项目', 2)
  const queuedSave = flushEditorSave(deletedProject, 404, async () => {
    deletedWrites++
  })
  enqueueEditorSave(retainedProject, 505, 5, '其他项目草稿', 3)

  discardProjectEditorSaves(deletedProject)
  await queuedSave

  assert.equal(deletedWrites, 0)
  assert.equal(getEditorSaveDraft(deletedProject, 404), null)
  assert.equal(getEditorSaveQueueSnapshot().drafts[deletedKey], undefined)
  assert.equal(getEditorSaveQueueSnapshot().drafts[retainedKey], '其他项目草稿')

  await flushEditorSave(retainedProject, 505, async () => {})
})

test('a deleted instance callback cannot overwrite a same-name replacement draft', async () => {
  const project = 'recreated-editor-project'
  const chapterId = 808
  const oldWrite = createDeferred()
  let oldWrites = 0
  let replacementWrites = 0

  enqueueEditorSave(project, chapterId, 8, '旧实例正文', 5)
  const oldSave = flushEditorSave(project, chapterId, () => {
    oldWrites++
    return oldWrite.promise
  })
  await waitFor(() => oldWrites === 1)

  discardProjectEditorSaves(project)
  enqueueEditorSave(project, chapterId, 1, '同名新项目正文', 0)
  const replacementSave = flushEditorSave(project, chapterId, async () => {
    replacementWrites++
  })
  await replacementSave

  oldWrite.reject(new Error('旧实例迟到失败'))
  await oldSave

  assert.equal(replacementWrites, 1)
  assert.equal(getEditorSaveDraft(project, chapterId), null)
  assert.equal(getEditorSaveQueueSnapshot().errors[editorSaveKey(project, chapterId)], undefined)
})

test('a deleted chapter rejects a late failed write without restoring its draft', async () => {
  const project = 'deleted-chapter-late-failure'
  const chapterId = 909
  const lateWrite = createDeferred()
  let writes = 0

  enqueueEditorSave(project, chapterId, 9, 'deleted chapter draft', 5)
  const save = flushEditorSave(project, chapterId, () => {
    writes++
    return lateWrite.promise
  })
  await waitFor(() => writes === 1)

  discardEditorSave(project, chapterId)
  lateWrite.reject(new Error('late write failed'))

  try {
    await assert.rejects(save, /late write failed/)
    assert.equal(getEditorSaveDraft(project, chapterId), null)
    assert.equal(getEditorSaveQueueSnapshot().errors[editorSaveKey(project, chapterId)], undefined)
  } finally {
    discardProjectEditorSaves(project)
  }
})
