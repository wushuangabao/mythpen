import assert from 'node:assert/strict'
import test from 'node:test'
import {
  discardProjectTitleSaves,
  discardTitleSave,
  flushTitleSave,
  getTitleSaveDraft,
  getTitleSaveFailure,
  getTitleSaveQueueSnapshot,
  stageTitleSave,
  titleSaveKey,
  type TitleSaveEntry,
} from '../src/lib/titleSaveQueue.ts'
import {
  discardManuscriptDirtyResource,
  getManuscriptDirtySnapshot,
  type ManuscriptDirtyBinding,
} from '../src/lib/manuscriptDirtyResources.ts'

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
  assert.fail('Timed out waiting for title writer')
}

test('serializes title writes and an older success cannot clear a newer draft', async () => {
  const project = 'title-serialized-project'
  const chapterId = 101
  const key = titleSaveKey(project, chapterId)
  const entries: TitleSaveEntry[] = []
  const writes: Deferred[] = []
  let activeWrites = 0
  let maximumActiveWrites = 0

  const writer = (entry: TitleSaveEntry) => {
    entries.push(entry)
    activeWrites++
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites)
    const write = createDeferred()
    writes.push(write)
    return write.promise.finally(() => {
      activeWrites--
    })
  }

  stageTitleSave(project, chapterId, 1, '旧标题')
  const olderSave = flushTitleSave(project, chapterId, writer)
  await waitFor(() => writes.length === 1)

  stageTitleSave(project, chapterId, 1, '新标题')
  const newerSave = flushTitleSave(project, chapterId, writer)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(writes.length, 1)

  writes[0].resolve()
  await olderSave
  await waitFor(() => writes.length === 2)
  assert.equal(getTitleSaveQueueSnapshot().drafts[key], '新标题')
  assert.equal(getTitleSaveQueueSnapshot().errors[key], undefined)

  writes[1].resolve()
  await newerSave
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ['旧标题', '新标题'],
  )
  assert.equal(getTitleSaveDraft(project, chapterId), null)
  assert.equal(maximumActiveWrites, 1)
})

test('queues a return to the original title behind an in-flight different title', async () => {
  const project = 'title-revert-project'
  const chapterId = 202
  const serverTitles: string[] = []
  const writes: Deferred[] = []

  const writer = (entry: TitleSaveEntry) => {
    serverTitles.push(entry.title)
    const write = createDeferred()
    writes.push(write)
    return write.promise
  }

  stageTitleSave(project, chapterId, 2, '临时标题')
  const temporarySave = flushTitleSave(project, chapterId, writer)
  await waitFor(() => writes.length === 1)

  // The store still exposes the original title while the first PUT is pending.
  // Reverting must enqueue a compensating PUT instead of discarding this draft.
  stageTitleSave(project, chapterId, 2, '原标题')
  const revertSave = flushTitleSave(project, chapterId, writer)
  writes[0].resolve()
  await temporarySave
  await waitFor(() => writes.length === 2)
  writes[1].resolve()
  await revertSave

  assert.deepEqual(serverTitles, ['临时标题', '原标题'])
  assert.equal(getTitleSaveDraft(project, chapterId), null)
})

test('an older failure cannot replace or label the newer title draft', async () => {
  const project = 'title-old-failure-project'
  const chapterId = 303
  const key = titleSaveKey(project, chapterId)
  const writes: Deferred[] = []

  const writer = () => {
    const write = createDeferred()
    writes.push(write)
    return write.promise
  }

  stageTitleSave(project, chapterId, 3, '会失败的标题')
  const olderSave = flushTitleSave(project, chapterId, writer)
  const expectedFailure = assert.rejects(olderSave, /旧请求失败/)
  await waitFor(() => writes.length === 1)

  stageTitleSave(project, chapterId, 3, '失败期间的新标题')
  const newerSave = flushTitleSave(project, chapterId, writer)
  writes[0].reject(new Error('旧请求失败'))
  await expectedFailure
  await waitFor(() => writes.length === 2)

  assert.equal(getTitleSaveQueueSnapshot().drafts[key], '失败期间的新标题')
  assert.equal(getTitleSaveQueueSnapshot().errors[key], undefined)
  writes[1].resolve()
  await newerSave
})

test('retains the latest failed title for retry and discard blocks late resurrection', async () => {
  const retryProject = 'title-retry-project'
  const retryChapter = 404
  const retryKey = titleSaveKey(retryProject, retryChapter)

  stageTitleSave(retryProject, retryChapter, 4, '可恢复标题')
  await assert.rejects(
    flushTitleSave(retryProject, retryChapter, async () => {
      throw new Error('暂时保存失败')
    }),
    /暂时保存失败/,
  )
  assert.equal(getTitleSaveQueueSnapshot().drafts[retryKey], '可恢复标题')
  assert.equal(getTitleSaveQueueSnapshot().errors[retryKey], '暂时保存失败')

  await flushTitleSave(retryProject, retryChapter, async () => {})
  assert.equal(getTitleSaveDraft(retryProject, retryChapter), null)
  assert.equal(getTitleSaveQueueSnapshot().errors[retryKey], undefined)

  const discardProject = 'title-discard-project'
  const discardChapter = 505
  const write = createDeferred()
  stageTitleSave(discardProject, discardChapter, 5, '已放弃标题')
  const save = flushTitleSave(discardProject, discardChapter, () => write.promise)
  const expectedDiscardFailure = assert.rejects(save, /迟到失败/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  discardTitleSave(discardProject, discardChapter)
  write.reject(new Error('迟到失败'))
  await expectedDiscardFailure
  assert.equal(getTitleSaveDraft(discardProject, discardChapter), null)
  assert.equal(getTitleSaveQueueSnapshot().errors[titleSaveKey(discardProject, discardChapter)], undefined)
})

test('discarding a deleted project removes its titles and invalidates queued writers', async () => {
  const deletedProject = 'deleted-title-project'
  const retainedProject = 'retained-title-project'
  const deletedKey = titleSaveKey(deletedProject, 606)
  const retainedKey = titleSaveKey(retainedProject, 707)
  let deletedWrites = 0

  stageTitleSave(deletedProject, 606, 6, '不得进入同名新项目')
  const queuedSave = flushTitleSave(deletedProject, 606, async () => {
    deletedWrites++
  })
  stageTitleSave(retainedProject, 707, 7, '其他项目标题')

  discardProjectTitleSaves(deletedProject)
  await queuedSave

  assert.equal(deletedWrites, 0)
  assert.equal(getTitleSaveDraft(deletedProject, 606), null)
  assert.equal(getTitleSaveQueueSnapshot().drafts[deletedKey], undefined)
  assert.equal(getTitleSaveQueueSnapshot().drafts[retainedKey], '其他项目标题')

  await flushTitleSave(retainedProject, 707, async () => {})
})

test('a deleted instance callback cannot overwrite a same-name replacement title', async () => {
  const project = 'recreated-title-project'
  const chapterId = 808
  const oldWrite = createDeferred()
  let oldWrites = 0
  let replacementWrites = 0

  stageTitleSave(project, chapterId, 8, '旧实例标题')
  const oldSave = flushTitleSave(project, chapterId, () => {
    oldWrites++
    return oldWrite.promise
  })
  await waitFor(() => oldWrites === 1)

  discardProjectTitleSaves(project)
  stageTitleSave(project, chapterId, 1, '同名新项目标题')
  const replacementSave = flushTitleSave(project, chapterId, async () => {
    replacementWrites++
  })
  await replacementSave

  oldWrite.reject(new Error('旧实例迟到失败'))
  await oldSave

  assert.equal(replacementWrites, 1)
  assert.equal(getTitleSaveDraft(project, chapterId), null)
  assert.equal(getTitleSaveQueueSnapshot().errors[titleSaveKey(project, chapterId)], undefined)
})

test('a recovery-required title failure stays recoverable and settles its dirty resource as stale', async () => {
  const project = 'title-recovery-required-project'
  const chapterId = 909
  const dirtyBinding: ManuscriptDirtyBinding = {
    identity: {
      projectUid: '11111111-1111-4111-8111-111111111111',
      projectInstanceId: '22222222-2222-4222-8222-222222222222',
      resourceKind: 'chapter',
      resourceUid: '33333333-3333-4333-8333-333333333333',
      domain: 'sidecar',
      windowId: 'title-recovery-window',
    },
    baseRawSha256: 'a'.repeat(64),
  }

  try {
    stageTitleSave(project, chapterId, 9, '保留标题', dirtyBinding)
    await assert.rejects(
      flushTitleSave(project, chapterId, async () => {
        throw Object.assign(new Error('需要先恢复'), { code: 'RECOVERY_REQUIRED' })
      }),
      /需要先恢复/,
    )

    assert.equal(getTitleSaveDraft(project, chapterId)?.title, '保留标题')
    assert.equal(getTitleSaveFailure(project, chapterId)?.code, 'RECOVERY_REQUIRED')
    assert.equal(getManuscriptDirtySnapshot()[0]?.status, 'stale')
  } finally {
    discardTitleSave(project, chapterId)
    discardManuscriptDirtyResource(dirtyBinding)
  }
})
