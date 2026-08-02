import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldSynchronizeEditorDom } from '../src/lib/editorAuthoritySync.ts'

test('an editor that still owns focus synchronizes while the revision gate is locked', () => {
  assert.equal(
    shouldSynchronizeEditorDom({
      targetChanged: false,
      editorLocked: true,
      isEditing: true,
      chapterDataVersionChanged: false,
    }),
    true,
  )
})
test('an authoritative chapter version change synchronizes even if React skipped the intermediate locked render', () => {
  assert.equal(
    shouldSynchronizeEditorDom({
      targetChanged: false,
      editorLocked: false,
      isEditing: true,
      chapterDataVersionChanged: true,
    }),
    true,
  )
})

test('ordinary rerenders do not replace an actively edited DOM snapshot', () => {
  assert.equal(
    shouldSynchronizeEditorDom({
      targetChanged: false,
      editorLocked: false,
      isEditing: true,
      chapterDataVersionChanged: false,
    }),
    false,
  )
})
