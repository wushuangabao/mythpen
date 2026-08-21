import assert from 'node:assert/strict'
import test from 'node:test'
import { runEditorSaveWithProtection } from '../src/lib/editorSaveProtection.ts'

test('a protected explicit flush rejects with its public failure before the save callback runs', async () => {
  let saves = 0

  await assert.rejects(
    runEditorSaveWithProtection(
      { message: '正文已在其他窗口更新，请处理冲突', code: 'EXTERNAL_DRAFT_CONFLICT' },
      'explicit',
      async () => {
        saves++
      },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === '正文已在其他窗口更新，请处理冲突' &&
      (error as Error & { code?: unknown }).code === 'EXTERNAL_DRAFT_CONFLICT',
  )
  assert.equal(saves, 0)
})

test('a protected automatic save skips its callback and remains silently catchable', async () => {
  let saves = 0
  let rejected = false

  await runEditorSaveWithProtection(
    { message: '需要先恢复', code: 'RECOVERY_REQUIRED' },
    'automatic',
    async () => {
      saves++
    },
  ).catch(() => {
    rejected = true
  })

  assert.equal(saves, 0)
  assert.equal(rejected, false)
})
