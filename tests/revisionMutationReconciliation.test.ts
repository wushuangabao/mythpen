import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginPendingRevisionMutation,
  hasInFlightRevisionMutation,
  hasPendingRevisionMutation,
  resolveSettledRevisionMutations,
  retireProjectRevisionMutations,
  settlePendingRevisionMutation,
} from '../src/lib/revisionMutationReconciliation.ts'

test('pending revision mutations are isolated by immutable project instance and chapter', () => {
  const project = 'marker-instance-isolation'
  const marker = beginPendingRevisionMutation(project, 'old-instance', 7)

  assert.equal(hasPendingRevisionMutation(project, 'old-instance', 7), true)
  assert.equal(hasPendingRevisionMutation(project, 'new-instance', 7), false)
  assert.equal(hasPendingRevisionMutation(project, 'old-instance', 8), false)
  assert.equal(retireProjectRevisionMutations(project, 'new-instance'), 0)
  assert.equal(hasPendingRevisionMutation(project, 'old-instance', 7), true)
  assert.equal(retireProjectRevisionMutations(project, marker.projectInstanceId), 1)
  assert.equal(hasPendingRevisionMutation(project, 'old-instance', 7), false)
})

test('an active-revision read may resolve settled markers but not an in-flight mutation', () => {
  const project = 'marker-inflight-guard'
  const inFlight = beginPendingRevisionMutation(project, 'instance', 7)
  const settled = beginPendingRevisionMutation(project, 'instance', 7)
  settlePendingRevisionMutation(settled)

  assert.equal(resolveSettledRevisionMutations(project, 'instance', 7), 1)
  assert.equal(hasInFlightRevisionMutation(project, 'instance', 7), true)
  assert.equal(hasPendingRevisionMutation(project, 'instance', 7), true)

  settlePendingRevisionMutation(inFlight)
  assert.equal(resolveSettledRevisionMutations(project, 'instance', 7), 1)
  assert.equal(hasPendingRevisionMutation(project, 'instance', 7), false)
})
