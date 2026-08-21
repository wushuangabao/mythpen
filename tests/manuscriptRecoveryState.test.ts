import assert from 'node:assert/strict'
import test from 'node:test'

import { ManuscriptRecoveryState } from '../src/lib/manuscriptRecoveryState.ts'

const CONFLICT_ID = '33333333-3333-4333-8333-333333333333'

test('stale conflict epoch cannot unlock read-only protection', () => {
  const state = new ManuscriptRecoveryState()
  state.observeConflict(Object.freeze({
    conflictId: CONFLICT_ID,
    decisionEpoch: 1,
    state: 'decision_ready',
    backupAvailable: true,
  }))
  const stale = state.beginConflictResolution('accept_external')
  state.observeConflict(Object.freeze({
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
    state: 'decision_ready',
    backupAvailable: true,
  }))
  assert.throws(
    () => state.completeConflictResolution(stale, Object.freeze({
      conflictId: CONFLICT_ID,
      decisionEpoch: 1,
      state: 'resolved_accept_external',
    })),
    /stale/u,
  )
  assert.equal(state.snapshot().readOnly, true)

  const current = state.beginConflictResolution('apply_saved_draft')
  state.completeConflictResolution(current, Object.freeze({
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
    state: 'resolved_apply_draft',
  }))
  assert.equal(state.snapshot().readOnly, false)
  assert.throws(
    () => state.completeConflictResolution(current, Object.freeze({
      conflictId: CONFLICT_ID,
      decisionEpoch: 2,
      state: 'resolved_apply_draft',
    })),
    /consumed|stale/u,
  )
})

test('plain or widened conflict intent/result cannot clear protection', () => {
  const state = new ManuscriptRecoveryState()
  state.observeConflict(Object.freeze({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    state: 'decision_ready',
    backupAvailable: true,
  }))
  assert.throws(
    () => state.completeConflictResolution(Object.freeze({}), Object.freeze({
      conflictId: CONFLICT_ID,
      decisionEpoch: 0,
      state: 'resolved_accept_external',
    })),
    TypeError,
  )
  const intent = state.beginConflictResolution('accept_external')
  assert.throws(
    () => state.completeConflictResolution(intent, Object.freeze({
      conflictId: CONFLICT_ID,
      decisionEpoch: 0,
      state: 'resolved_accept_external',
      path: 'C:\\private\\draft.md',
    }) as never),
    TypeError,
  )
  assert.equal(state.snapshot().readOnly, true)
})

test('capacity warning begins at 80 percent and contains facts but no manuscript content', () => {
  const state = new ManuscriptRecoveryState()
  state.observeCapacity(Object.freeze({
    dimension: 'controlledBytes',
    observed: 79,
    allowed: 100,
  }))
  assert.deepEqual(state.snapshot().capacityWarnings, [])
  state.observeCapacity(Object.freeze({
    dimension: 'controlledBytes',
    observed: 80,
    allowed: 100,
  }))
  assert.deepEqual(state.snapshot().capacityWarnings, [{
    dimension: 'controlledBytes',
    observed: 80,
    allowed: 100,
    ratio: 0.8,
  }])
  const diagnostics = state.diagnostics()
  const serialized = JSON.stringify(diagnostics)
  assert.doesNotMatch(serialized, /content|title|outline|[A-Z]:\\/u)
  assert.equal(Object.isFrozen(diagnostics), true)
})

test('feed degraded status remains visible until an explicit direct observation', () => {
  const state = new ManuscriptRecoveryState()
  state.observeFeed(Object.freeze({ mode: 'degraded', reason: 'NO_SLOT' }))
  assert.deepEqual(state.snapshot().feed, { mode: 'degraded', reason: 'NO_SLOT' })
  state.observeFeed(Object.freeze({ mode: 'direct', reason: null }))
  assert.deepEqual(state.snapshot().feed, { mode: 'direct', reason: null })
})

test('refresh cancellation is module-authentic and cannot cancel a newer refresh', () => {
  const state = new ManuscriptRecoveryState()
  const first = state.beginRefresh()
  assert.equal(state.cancelRefresh(first), true)
  assert.equal(state.isRefreshCancelled(first), true)
  state.completeRefresh(first)
  const second = state.beginRefresh()
  assert.throws(() => state.cancelRefresh({ ...first }), TypeError)
  assert.equal(state.isRefreshCancelled(second), false)
  assert.equal(state.snapshot().refresh.state, 'running')
})

test('starting a newer refresh permanently invalidates an unfinished old token', () => {
  const state = new ManuscriptRecoveryState()
  const first = state.beginRefresh()
  const second = state.beginRefresh()
  assert.throws(() => state.cancelRefresh(first), /consumed|stale/u)
  assert.equal(state.cancelRefresh(second), true)
})

test('apply saved draft is unavailable without an authority-observed backup', () => {
  const state = new ManuscriptRecoveryState()
  state.observeConflict(Object.freeze({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    state: 'decision_ready',
    backupAvailable: false,
  }))
  assert.throws(() => state.beginConflictResolution('apply_saved_draft'), /unavailable/u)
  assert.equal(state.snapshot().readOnly, true)
})

test('RECOVERY_REQUIRED protection only clears through its original explicit recovery intent', () => {
  const state = new ManuscriptRecoveryState()
  state.protect(Object.freeze({ code: 'RECOVERY_REQUIRED' }))
  assert.equal(state.snapshot().readOnly, true)
  const intent = state.beginRecoveryResolution()
  assert.throws(() => state.completeRecoveryResolution(Object.freeze({})), TypeError)
  assert.equal(state.snapshot().readOnly, true)
  state.completeRecoveryResolution(intent)
  assert.equal(state.snapshot().readOnly, false)
})
