import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createChapterDataJournal,
  shouldApplyChapterDataVersion,
} from '../src/lib/chapterDataJournal.ts'

interface ChapterSnapshot {
  id: number
  volumeId: number
  num: number
  dataVersion: number
  title: string
  content: string
  wordCount: number
}

const IDENTITY_FIELDS = ['id', 'volumeId', 'num'] as const

function chapter(overrides: Partial<ChapterSnapshot> = {}): ChapterSnapshot {
  return {
    id: 101,
    volumeId: 1,
    num: 1,
    dataVersion: 1,
    title: '旧标题',
    content: '旧正文',
    wordCount: 3,
    ...overrides,
  }
}

test('a successful content write survives an A -> B -> A return with an empty active store', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()

  // The save completes while the returning A store has not loaded any chapter,
  // so there is deliberately no current in-memory chapter to merge from.
  journal.recordPatch('project-a', 101, { content: '已保存正文', wordCount: 5, dataVersion: 2 }, 2)

  const merged = journal.mergeSnapshot(
    'project-a',
    101,
    chapter(),
    1,
    IDENTITY_FIELDS,
  )

  assert.equal(merged.content, '已保存正文')
  assert.equal(merged.wordCount, 5)
})

test('a successful title write is retained by stable chapter id without an in-memory chapter', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()

  journal.recordPatch('project-a', 101, { title: '已保存标题', dataVersion: 2 }, 2)

  const merged = journal.mergeSnapshot(
    'project-a',
    101,
    chapter(),
    1,
    IDENTITY_FIELDS,
  )
  assert.equal(merged.title, '已保存标题')
})

test('journal entries are project scoped and do not override an equally new server snapshot', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()
  journal.recordPatch('project-a', 101, { title: 'A 的新标题', dataVersion: 2 }, 2)

  const projectB = journal.mergeSnapshot(
    'project-b',
    101,
    chapter({ title: 'B 的标题' }),
    1,
    IDENTITY_FIELDS,
  )
  assert.equal(projectB.title, 'B 的标题')

  const freshProjectA = journal.mergeSnapshot(
    'project-a',
    101,
    chapter({ title: '服务器更新的标题', dataVersion: 2 }),
    2,
    IDENTITY_FIELDS,
  )
  assert.equal(freshProjectA.title, '服务器更新的标题')
})

test('a saved chapter never spills into another volume chapter with the same number', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()
  const target = chapter({ id: 101, volumeId: 1, num: 1, content: '卷一旧正文' })
  const otherVolume = chapter({ id: 202, volumeId: 2, num: 1, content: '卷二正文' })

  journal.recordPatch(
    'project-a',
    target.id,
    { content: '卷一已保存正文', wordCount: 7, dataVersion: 2 },
    2,
  )

  const mergedTarget = journal.mergeSnapshot(
    'project-a',
    target.id,
    target,
    1,
    IDENTITY_FIELDS,
  )
  const mergedOther = journal.mergeSnapshot(
    'project-a',
    otherVolume.id,
    otherVolume,
    1,
    IDENTITY_FIELDS,
  )

  assert.equal(mergedTarget.content, '卷一已保存正文')
  assert.equal(mergedOther.content, '卷二正文')
})

test('a delayed older write response cannot override a newer committed server snapshot', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()

  // T1 committed first but its response arrived after another window committed
  // T2. Database versions, unlike response arrival order, preserve that fact.
  journal.recordPatch('project-a', 101, { title: 'T1', dataVersion: 2 }, 2)
  const merged = journal.mergeSnapshot(
    'project-a',
    101,
    chapter({ title: 'T2', dataVersion: 3 }),
    3,
    IDENTITY_FIELDS,
  )

  assert.equal(merged.title, 'T2')
  assert.equal(merged.dataVersion, 3)
})

test('an older response recorded after a newer response cannot roll the journal back', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()
  journal.recordPatch('project-a', 101, { title: 'T2', dataVersion: 3 }, 3)
  journal.recordPatch('project-a', 101, { title: 'T1', dataVersion: 2 }, 2)

  const merged = journal.mergeSnapshot(
    'project-a',
    101,
    chapter({ title: 'old', dataVersion: 1 }),
    1,
    IDENTITY_FIELDS,
  )
  assert.equal(merged.title, 'T2')
  assert.equal(merged.dataVersion, 3)
})

test('a newer full PUT response preserves a different field committed by an earlier request', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()

  // The content request commits after the title request, so its full response
  // contains both writes. The delayed title response must not replace it.
  journal.recordFull(
    'project-a',
    101,
    chapter({ title: 'new title', content: 'new content', wordCount: 10, dataVersion: 3 }),
    3,
  )
  journal.recordFull(
    'project-a',
    101,
    chapter({ title: 'new title', content: 'old content', wordCount: 10, dataVersion: 2 }),
    2,
  )

  const merged = journal.mergeSnapshot('project-a', 101, chapter(), 1, IDENTITY_FIELDS)
  assert.equal(merged.title, 'new title')
  assert.equal(merged.content, 'new content')
  assert.equal(merged.dataVersion, 3)
})

test('a detail response read at v1 cannot replace a list snapshot already committed at v2', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()
  const listSnapshot = chapter({ title: 'list v2', content: 'new content', dataVersion: 2 })
  const delayedDetail = chapter({ title: 'detail v1', content: 'old content', dataVersion: 1 })

  journal.recordFull('project-a', 101, listSnapshot, listSnapshot.dataVersion)
  journal.recordFull('project-a', 101, delayedDetail, delayedDetail.dataVersion)

  const merged = journal.mergeSnapshot(
    'project-a',
    101,
    delayedDetail,
    delayedDetail.dataVersion,
    IDENTITY_FIELDS,
  )
  assert.equal(merged.title, 'list v2')
  assert.equal(merged.content, 'new content')
  assert.equal(merged.dataVersion, 2)
  assert.equal(shouldApplyChapterDataVersion(delayedDetail.dataVersion, listSnapshot.dataVersion), false)
})

test('immediate state updates reject an older database version', () => {
  assert.equal(shouldApplyChapterDataVersion(8, 9), false)
  assert.equal(shouldApplyChapterDataVersion(9, 9), true)
  assert.equal(shouldApplyChapterDataVersion(10, 9), true)
  assert.equal(shouldApplyChapterDataVersion(undefined, 9), true)
})

test('clearing a deleted project prevents a same-name replacement from inheriting journal data', () => {
  const journal = createChapterDataJournal<ChapterSnapshot>()
  journal.recordPatch('deleted-project', 101, { title: '旧项目标题', dataVersion: 2 }, 2)
  journal.recordPatch('retained-project', 101, { title: '其他项目标题', dataVersion: 2 }, 2)

  assert.equal(journal.clearProject('deleted-project'), true)

  const replacement = journal.mergeSnapshot(
    'deleted-project',
    101,
    chapter({ title: '同名新项目标题' }),
    1,
    IDENTITY_FIELDS,
  )
  const retained = journal.mergeSnapshot(
    'retained-project',
    101,
    chapter({ title: '其他项目旧标题' }),
    1,
    IDENTITY_FIELDS,
  )
  assert.equal(replacement.title, '同名新项目标题')
  assert.equal(retained.title, '其他项目标题')
})
