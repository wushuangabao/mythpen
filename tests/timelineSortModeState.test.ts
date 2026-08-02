import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTimelineSortModeRequestGuard,
  getTimelineKeyboardMove,
  getTimelineSortModeForProject,
  isTimelineOrderInteractionDisabled,
  type TimelineSortModeSnapshot,
} from '../src/lib/timelineSortModeState.ts'

test('keyboard reorder maps adjacent arrow moves to pointer drop semantics', () => {
  const ids = ['first', 'second', 'third']

  assert.deepEqual(getTimelineKeyboardMove(ids, 'second', 'ArrowUp'), {
    targetId: 'first',
    insertAfter: false,
  })
  assert.deepEqual(getTimelineKeyboardMove(ids, 'second', 'ArrowDown'), {
    targetId: 'third',
    insertAfter: true,
  })
})

test('keyboard reorder ignores boundaries, unknown events, and unrelated keys', () => {
  const ids = ['first', 'second', 'third']

  assert.equal(getTimelineKeyboardMove(ids, 'first', 'ArrowUp'), null)
  assert.equal(getTimelineKeyboardMove(ids, 'third', 'ArrowDown'), null)
  assert.equal(getTimelineKeyboardMove(ids, 'missing', 'ArrowDown'), null)
  assert.equal(getTimelineKeyboardMove(ids, 'second', 'Enter'), null)
})

test('a previous project mode is unavailable while the next project mode is loading', () => {
  const projectA: TimelineSortModeSnapshot = { project: 'project-a', mode: 'manual' }

  assert.equal(getTimelineSortModeForProject(projectA, 'project-b'), null)
  assert.equal(isTimelineOrderInteractionDisabled(projectA, 'project-b', false), true)

  const projectB: TimelineSortModeSnapshot = { project: 'project-b', mode: 'auto' }
  assert.equal(getTimelineSortModeForProject(projectB, 'project-b'), 'auto')
  assert.equal(isTimelineOrderInteractionDisabled(projectB, 'project-b', false), false)
  assert.equal(isTimelineOrderInteractionDisabled(projectB, 'project-b', true), true)
})

test('a late sort-mode response cannot cross a project activation', () => {
  const guard = createTimelineSortModeRequestGuard('project-a')
  const staleProjectA = guard.beginRead('project-a')
  assert.ok(staleProjectA)

  guard.activate('project-b')
  assert.equal(guard.commitRead(staleProjectA, 'manual'), null)

  const projectB = guard.beginRead('project-b')
  assert.ok(projectB)
  assert.equal(guard.commitRead(projectB, 'auto'), 'auto')
})

test('returning to a project does not revive its earlier response or let it invalidate the active project', () => {
  const guard = createTimelineSortModeRequestGuard('project-a')
  const staleProjectA = guard.beginRead('project-a')
  assert.ok(staleProjectA)

  guard.activate('project-b')
  const projectB = guard.beginRead('project-b')
  assert.ok(projectB)
  assert.equal(guard.beginMutation('project-a'), null)
  assert.equal(guard.commitRead(projectB, 'manual'), 'manual')

  guard.activate('project-a')
  assert.equal(guard.commitRead(staleProjectA, 'auto'), null)
  const currentProjectA = guard.beginRead('project-a')
  assert.ok(currentProjectA)
  assert.equal(guard.commitRead(currentProjectA, 'auto'), 'auto')
})

test('a mutation from an older A activation cannot write UI after A to B to A', () => {
  const guard = createTimelineSortModeRequestGuard('project-a')
  const staleMutation = guard.beginMutation('project-a')
  assert.ok(staleMutation)

  guard.activate('project-b')
  guard.activate('project-a')

  assert.equal(guard.isCurrentMutation(staleMutation), false)
  assert.equal(guard.commitMutation(staleMutation, 'manual'), null)
  assert.equal(guard.finishMutation(staleMutation), false)
})

test('unmounting a project invalidates its in-flight mutation before async handlers settle', () => {
  const guard = createTimelineSortModeRequestGuard('project-a')
  const unmountedMutation = guard.beginMutation('project-a')
  assert.ok(unmountedMutation)

  guard.deactivate('project-a')

  assert.equal(guard.isCurrentMutation(unmountedMutation), false)
  assert.equal(guard.commitMutation(unmountedMutation, 'manual'), null)
  assert.equal(guard.finishMutation(unmountedMutation), false)

  guard.activate('project-a')
  const remountedMutation = guard.beginMutation('project-a')
  assert.ok(remountedMutation)
  assert.equal(guard.isCurrentMutation(remountedMutation), true)
})

test('only the current mutation may settle UI and its success rejects an overlapping stale read', () => {
  const guard = createTimelineSortModeRequestGuard('project-a')
  const olderMutation = guard.beginMutation('project-a')
  const currentMutation = guard.beginMutation('project-a')
  assert.ok(olderMutation)
  assert.ok(currentMutation)

  assert.equal(guard.isCurrentMutation(olderMutation), false)
  assert.equal(guard.commitMutation(olderMutation, 'auto'), null)
  assert.equal(guard.finishMutation(olderMutation), false)

  const readDuringMutation = guard.beginRead('project-a')
  assert.ok(readDuringMutation)
  assert.equal(guard.commitMutation(currentMutation, 'manual'), 'manual')
  assert.equal(guard.commitRead(readDuringMutation, 'auto'), null)
  assert.equal(guard.finishMutation(currentMutation), true)
  assert.equal(guard.isCurrentMutation(currentMutation), false)
})
