import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getDialogFocusWrapIndex,
  getDialogRestoreFocusTarget,
  isDialogCloseAllowed,
} from '../src/lib/a11y.ts'

test('dialog focus wraps only when Tab would leave its focusable elements', () => {
  assert.equal(getDialogFocusWrapIndex(0, 3, true), 2)
  assert.equal(getDialogFocusWrapIndex(2, 3, false), 0)
  assert.equal(getDialogFocusWrapIndex(1, 3, false), null)
  assert.equal(getDialogFocusWrapIndex(1, 3, true), null)
})

test('dialog focus enters at the appropriate edge when focus starts outside', () => {
  assert.equal(getDialogFocusWrapIndex(-1, 3, false), 0)
  assert.equal(getDialogFocusWrapIndex(-1, 3, true), 2)
  assert.equal(getDialogFocusWrapIndex(-1, 0, false), null)
})

test('dialog close is allowed only while no submission is pending', () => {
  assert.equal(isDialogCloseAllowed(false), true)
  assert.equal(isDialogCloseAllowed(true), false)
})

test('dialog focus restoration prefers an explicit stable target and otherwise uses the opener', () => {
  const stableTarget = { id: 'create-entry' }
  const opener = { id: 'entry-card' }

  assert.equal(getDialogRestoreFocusTarget(stableTarget, opener), stableTarget)
  assert.equal(getDialogRestoreFocusTarget(null, opener), opener)
})
