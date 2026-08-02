import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isProjectRequestSuspended,
  ProjectRequestDrainTimeoutError,
  ProjectRequestSuspendedError,
  runProjectRequest,
  suspendProjectRequests,
} from '../src/lib/projectRequestGate.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test('suspension drains requests that already started and blocks later network starts', async () => {
  const project = 'project-being-deleted'
  const write = deferred<void>()
  let starts = 0
  const active = runProjectRequest(project, () => {
    starts++
    return write.promise
  })

  const suspension = suspendProjectRequests(project)
  let drained = false
  const drain = suspension.waitForInflight().then(() => {
    drained = true
  })
  await assert.rejects(
    runProjectRequest(project, async () => {
      starts++
    }),
    ProjectRequestSuspendedError,
  )
  assert.equal(starts, 1)
  assert.equal(drained, false)

  write.resolve()
  await active
  await drain
  assert.equal(drained, true)

  suspension.release()
  await runProjectRequest(project, async () => {
    starts++
  })
  assert.equal(starts, 2)
})

test('nested suspension tokens release independently and idempotently', () => {
  const project = 'nested-deletion-guard'
  const first = suspendProjectRequests(project)
  const second = suspendProjectRequests(project)
  assert.equal(isProjectRequestSuspended(project), true)

  first.release()
  first.release()
  assert.equal(isProjectRequestSuspended(project), true)

  second.release()
  assert.equal(isProjectRequestSuspended(project), false)
})

test('a drain timeout rejects deletion and finally-release restores the project gate', async () => {
  const project = 'timed-out-deletion-guard'
  const stalled = deferred<void>()
  const active = runProjectRequest(project, () => stalled.promise)
  const suspension = suspendProjectRequests(project, 10)
  let deleteStarted = false

  try {
    await suspension.waitForInflight()
    deleteStarted = true
  } catch (error) {
    assert.ok(error instanceof ProjectRequestDrainTimeoutError)
    assert.equal(error.project, project)
    assert.equal(error.timeoutMs, 10)
  } finally {
    suspension.release()
  }

  assert.equal(deleteStarted, false)
  assert.equal(isProjectRequestSuspended(project), false)
  let laterStarts = 0
  await runProjectRequest(project, async () => {
    laterStarts++
  })
  assert.equal(laterStarts, 1)

  stalled.resolve()
  await active
})
