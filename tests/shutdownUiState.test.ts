import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  initialShutdownUiState,
  reduceShutdownUi,
  type HostShutdownSnapshot,
} from '../src/lib/shutdownUiState.ts'

function snapshot(
  attemptSeq: number | null,
  phase: HostShutdownSnapshot['phase'],
  overrides: Partial<HostShutdownSnapshot> = {},
): HostShutdownSnapshot {
  return {
    attemptSeq,
    phase,
    canContinueWaiting: phase === 'soft_deadline',
    canCancel: ['requesting', 'quiescing', 'draining', 'soft_deadline', 'failed'].includes(phase),
    canEmergencyExit: ['soft_deadline', 'failed'].includes(phase),
    code: null,
    ...overrides,
  }
}

test('a newer attempt fences all stale snapshots from the previous attempt', () => {
  let state = reduceShutdownUi(initialShutdownUiState, { type: 'host_snapshot', snapshot: snapshot(1, 'draining') })
  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: snapshot(2, 'requesting') })
  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: snapshot(1, 'complete_waiting_for_child') })

  assert.equal(state.snapshot.attemptSeq, 2)
  assert.equal(state.snapshot.phase, 'requesting')
})

test('cancelled attempt remains retired after attemptSeq becomes null and late frames cannot reopen it', () => {
  let state = reduceShutdownUi(initialShutdownUiState, { type: 'host_snapshot', snapshot: snapshot(2, 'draining') })
  state = reduceShutdownUi(state, { type: 'cancel_requested' })
  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: snapshot(null, 'idle') })
  assert.equal(state.visible, false)

  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: snapshot(2, 'closing') })
  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: snapshot(2, 'complete_waiting_for_child') })
  assert.equal(state.snapshot.phase, 'idle')
  assert.equal(state.visible, false)

  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: snapshot(3, 'requesting') })
  assert.equal(state.snapshot.attemptSeq, 3)
  assert.equal(state.visible, true)
})

test('closing never permits a renderer cancel action', () => {
  const closing = reduceShutdownUi(initialShutdownUiState, {
    type: 'host_snapshot',
    snapshot: snapshot(1, 'closing', { canCancel: false }),
  })
  const afterCancel = reduceShutdownUi(closing, { type: 'cancel_requested' })

  assert.equal(afterCancel.pendingAction, null)
  assert.equal(afterCancel.snapshot.phase, 'closing')
})

test('duplicate soft deadline preserves pending and emergency confirmation state', () => {
  const soft = snapshot(1, 'soft_deadline')
  let state = reduceShutdownUi(initialShutdownUiState, { type: 'host_snapshot', snapshot: soft })
  state = reduceShutdownUi(state, { type: 'emergency_requested' })
  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: soft })
  assert.equal(state.emergencyConfirmation, true)

  state = reduceShutdownUi(state, { type: 'continue_requested' })
  state = reduceShutdownUi(state, { type: 'host_snapshot', snapshot: soft })
  assert.equal(state.pendingAction, 'continue')
})

test('complete waits for the child and failed or emergency snapshots never masquerade as clean', () => {
  const waiting = reduceShutdownUi(initialShutdownUiState, {
    type: 'host_snapshot',
    snapshot: snapshot(1, 'complete_waiting_for_child', {
      canCancel: false,
      canEmergencyExit: false,
    }),
  })
  assert.equal(waiting.visible, true)
  assert.equal(waiting.snapshot.phase, 'complete_waiting_for_child')

  const failed = reduceShutdownUi(waiting, {
    type: 'host_snapshot',
    snapshot: snapshot(1, 'failed', { code: 'STORAGE_UNAVAILABLE' }),
  })
  const staleComplete = reduceShutdownUi(failed, {
    type: 'host_snapshot',
    snapshot: snapshot(1, 'complete_waiting_for_child'),
  })
  assert.equal(staleComplete.snapshot.phase, 'failed')
  assert.equal(staleComplete.snapshot.code, 'STORAGE_UNAVAILABLE')
})

test('emergency exit requires a separate confirmation before becoming pending', () => {
  let state = reduceShutdownUi(initialShutdownUiState, {
    type: 'host_snapshot',
    snapshot: snapshot(1, 'soft_deadline'),
  })
  state = reduceShutdownUi(state, { type: 'emergency_requested' })
  assert.equal(state.emergencyConfirmation, true)
  assert.equal(state.pendingAction, null)

  state = reduceShutdownUi(state, { type: 'emergency_confirmed' })
  assert.equal(state.emergencyConfirmation, false)
  assert.equal(state.pendingAction, 'emergency')
})

test('desktop dev has one sidecar owner and renderer has no spawn authority', () => {
  const tauri = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  const capability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  )
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.equal(tauri.build.beforeDevCommand, 'pnpm dev')
  assert.equal(capability.permissions.includes('shell:allow-open'), true)
  assert.equal(
    capability.permissions.some((permission: unknown) =>
      typeof permission === 'object' && permission !== null && 'identifier' in permission
        ? permission.identifier === 'shell:allow-spawn'
        : false,
    ),
    false,
  )
  assert.doesNotMatch(main, /ServerStatusGate/)
  assert.match(app, /function WorkspaceApp\(/)
  assert.match(app, /<ServerStatusGate>/)
  assert.match(app, /<ShutdownDialog\s*\/>/)
})
