import assert from 'node:assert/strict'
import test from 'node:test'

class MemoryStorage implements Storage {
  protected readonly values = new Map<string, string>()

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

class FailingStorage extends MemoryStorage {
  override setItem(): void {
    throw new Error('quota exhausted')
  }
}

function installStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
}

test('instance retirement durably isolates editor and title drafts without replaying them', async () => {
  const durableStorage = new MemoryStorage()
  installStorage(durableStorage)
  const editorQueue = await import('../src/lib/editorSaveQueue.ts?project-draft-recovery')
  const titleQueue = await import('../src/lib/titleSaveQueue.ts?project-draft-recovery')
  const recovery = await import('../src/lib/projectDraftRecovery.ts')
  const project = 'same-name-replacement'

  editorQueue.enqueueEditorSave(project, 71, 7, 'old instance content', 5)
  titleQueue.stageTitleSave(project, 71, 7, 'old instance title')
  editorQueue.retireStaleProjectEditorSaves(project, 'old-instance-id')
  titleQueue.retireStaleProjectTitleSaves(project, 'old-instance-id')

  assert.equal(editorQueue.getEditorSaveDraft(project, 71), null)
  assert.equal(titleQueue.getTitleSaveDraft(project, 71), null)
  const [draft] = recovery.getRecoverableProjectDrafts(project)
  assert.ok(draft)
  assert.equal(draft.sourceInstanceId, 'old-instance-id')
  assert.equal(draft.chapterId, 71)
  assert.equal(draft.chapterNum, 7)
  assert.equal(draft.content, 'old instance content')
  assert.equal(draft.title, 'old instance title')
  assert.ok(Number.isFinite(Date.parse(draft.retiredAt)))
  assert.equal(recovery.isMatchingProjectDraftTarget(draft, { id: 71, num: 7 }), true)
  assert.equal(recovery.isMatchingProjectDraftTarget(draft, { id: 71, num: 1 }), false)
  assert.equal(recovery.isMatchingProjectDraftTarget(draft, { id: 7, num: 7 }), false)

  const persisted = JSON.parse(durableStorage.getItem(recovery.PROJECT_DRAFT_RECOVERY_STORAGE_KEY) || '{}')
  assert.equal(persisted.version, 1)
  assert.equal(persisted.entries.length, 1)
  assert.equal(persisted.entries[0].sourceInstanceId, 'old-instance-id')

  // Recovery is explicit: only a user action stages these values in the new
  // instance queue. Isolation itself left both active queues empty.
  editorQueue.enqueueEditorSave(project, draft.chapterId, draft.chapterNum, draft.content || '', 0)
  titleQueue.stageTitleSave(project, draft.chapterId, draft.chapterNum, draft.title || '')
  assert.equal(editorQueue.getEditorSaveDraft(project, 71)?.content, 'old instance content')
  assert.equal(titleQueue.getTitleSaveDraft(project, 71)?.title, 'old instance title')
  assert.equal(
    recovery.getRecoverableProjectDrafts(project)[0]?.recoveryId,
    draft.recoveryId,
    'staging a restore must not consume the only durable backup',
  )

  recovery.discardRecoverableProjectDraft(draft.recoveryId)

  editorQueue.discardProjectEditorSaves(project)
  titleQueue.discardProjectTitleSaves(project)
})

test('storage quota failure keeps an in-memory warning and still clears the active old-instance queue', async () => {
  installStorage(new FailingStorage())
  const editorQueue = await import('../src/lib/editorSaveQueue.ts?project-draft-quota')
  const recovery = await import('../src/lib/projectDraftRecovery.ts')
  const project = 'quota-failure-project'

  editorQueue.enqueueEditorSave(project, 81, 8, 'copy this immediately', 3)
  assert.doesNotThrow(() => editorQueue.retireStaleProjectEditorSaves(project, 'quota-old-instance'))

  assert.equal(editorQueue.getEditorSaveDraft(project, 81), null)
  assert.equal(recovery.getRecoverableProjectDrafts(project)[0]?.content, 'copy this immediately')
  assert.match(recovery.getProjectDraftRecoverySnapshot().persistenceError || '', /quota exhausted/)
})
