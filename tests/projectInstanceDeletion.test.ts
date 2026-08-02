import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deleteCapturedProjectInstance,
  finalizeCapturedProjectDeletion,
  ProjectInstanceChangedDuringDeletionError,
} from '../src/lib/projectInstanceDeletion.ts'
import {
  forgetProjectInstance,
  getProjectInstanceId,
  rememberProjectInstance,
} from '../src/lib/projectInstanceRegistry.ts'

test('instance rotation while deletion drains cancels before DELETE and preserves the replacement token', async () => {
  const project = 'rotation-during-delete-drain'
  let releaseDrain!: () => void
  const drain = new Promise<void>((resolve) => {
    releaseDrain = resolve
  })
  let deleteRequests = 0

  rememberProjectInstance(project, 'old-instance')
  try {
    const deletion = deleteCapturedProjectInstance(
      project,
      'old-instance',
      () => drain,
      async () => {
        deleteRequests++
      },
    )
    rememberProjectInstance(project, 'new-instance')
    releaseDrain()

    await assert.rejects(deletion, ProjectInstanceChangedDuringDeletionError)
    assert.equal(deleteRequests, 0)
    assert.equal(getProjectInstanceId(project), 'new-instance')
  } finally {
    forgetProjectInstance(project)
  }
})

test('the destructive callback receives the token captured before draining', async () => {
  const project = 'captured-delete-token'
  const receivedTokens: string[] = []
  rememberProjectInstance(project, 'captured-instance')
  try {
    await deleteCapturedProjectInstance(project, 'captured-instance', async () => {}, async (instanceId) => {
      receivedTokens.push(instanceId)
    })
    assert.deepEqual(receivedTokens, ['captured-instance'])
  } finally {
    forgetProjectInstance(project)
  }
})

test('a replacement observed before the DELETE response cannot be forgotten or locally cleaned up', () => {
  const project = 'replacement-before-delete-response'
  rememberProjectInstance(project, 'old-instance')
  try {
    // Simulate an authoritative list/create response winning while DELETE is
    // awaiting its HTTP response.
    rememberProjectInstance(project, 'replacement-instance')
    assert.equal(finalizeCapturedProjectDeletion(project, 'old-instance'), false)
    assert.equal(getProjectInstanceId(project), 'replacement-instance')
  } finally {
    forgetProjectInstance(project)
  }
})
