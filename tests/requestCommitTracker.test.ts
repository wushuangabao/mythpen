import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestCommitTracker } from '../src/lib/requestCommitTracker.ts'

test('an older current-key success remains usable when a newer refresh fails', () => {
  const tracker = createRequestCommitTracker('project-a')
  const oldProjectRequest = tracker.start('project-a')
  assert.ok(oldProjectRequest)
  assert.equal(tracker.claimSuccess(oldProjectRequest), true)

  tracker.activate('project-b')
  const initialRequest = tracker.start('project-b')
  const failedReload = tracker.start('project-b')
  assert.ok(initialRequest)
  assert.ok(failedReload)
  assert.equal(tracker.isLatest(failedReload), true)

  // The later request failed, so the still-valid initial B response may commit.
  assert.equal(tracker.claimSuccess(initialRequest), true)
})

test('a newer successful response prevents an older response from rolling data back', () => {
  const tracker = createRequestCommitTracker('project')
  const older = tracker.start('project')
  const newer = tracker.start('project')
  assert.ok(older)
  assert.ok(newer)

  assert.equal(tracker.claimSuccess(newer), true)
  assert.equal(tracker.claimSuccess(older), false)
})

test('responses from a previously active project can never commit', () => {
  const tracker = createRequestCommitTracker('project-a')
  const stale = tracker.start('project-a')
  assert.ok(stale)
  tracker.activate('project-b')

  assert.equal(tracker.isActive(stale), false)
  assert.equal(tracker.claimSuccess(stale), false)
})

test('returning to the same key does not revive a request from its older activation', () => {
  const tracker = createRequestCommitTracker('project-a')
  const stale = tracker.start('project-a')
  assert.ok(stale)

  tracker.activate('project-b')
  tracker.activate('project-a')
  const current = tracker.start('project-a')
  assert.ok(current)

  assert.equal(tracker.claimSuccess(stale), false)
  assert.equal(tracker.claimSuccess(current), true)
})

test('a failed project B phase request never makes an old project A response current again', () => {
  const tracker = createRequestCommitTracker('project-a')
  const staleProjectA = tracker.start('project-a')
  assert.ok(staleProjectA)

  tracker.activate('project-b')
  const failedProjectB = tracker.start('project-b')
  assert.ok(failedProjectB)
  // A rejected request does not claim success, but the active-key epoch remains B.
  assert.equal(tracker.isLatest(failedProjectB), true)
  assert.equal(tracker.claimSuccess(staleProjectA), false)

  const retriedProjectB = tracker.start('project-b')
  assert.ok(retriedProjectB)
  assert.equal(tracker.claimSuccess(retriedProjectB), true)
})

test('an external mutation invalidates an older same-project fallback snapshot', () => {
  const tracker = createRequestCommitTracker('project-a')
  const beforeMutation = tracker.start('project-a')
  assert.ok(beforeMutation)

  tracker.invalidate('project-a')
  const failedPostMutationRefresh = tracker.start('project-a')
  assert.ok(failedPostMutationRefresh)
  assert.equal(tracker.isLatest(failedPostMutationRefresh), true)

  // The post-mutation refresh fails and therefore never claims success. The
  // pre-mutation snapshot must still remain permanently ineligible.
  assert.equal(tracker.claimSuccess(beforeMutation), false)
})

test('a pre-delete project-list response cannot revive the deleted project', () => {
  const tracker = createRequestCommitTracker('projects')
  const beforeDelete = tracker.start('projects')
  assert.ok(beforeDelete)

  tracker.invalidate('projects')
  const afterDelete = tracker.start('projects')
  assert.ok(afterDelete)

  assert.equal(tracker.claimSuccess(beforeDelete), false)
  assert.equal(tracker.claimSuccess(afterDelete), true)
})
