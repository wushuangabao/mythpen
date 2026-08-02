import assert from 'node:assert/strict'
import test from 'node:test'
import {
  consumeProjectExport,
  ProjectExportSupersededError,
} from '../src/lib/projectExport.ts'
import {
  forgetProjectInstance,
  rememberProjectInstance,
} from '../src/lib/projectInstanceRegistry.ts'
import { suspendProjectRequests } from '../src/lib/projectRequestGate.ts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test('project export keeps its instance header and gate through blob consumption and the download callback', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await t.test('deletion drain waits for the consumer callback', async () => {
    const project = 'export-being-deleted'
    const instanceId = 'instance-before-delete'
    rememberProjectInstance(project, instanceId)
    t.after(() => forgetProjectInstance(project))

    const fetchStarted = deferred<void>()
    const blobRead = deferred<Blob>()
    const consumerStarted = deferred<void>()
    const finishConsumer = deferred<void>()
    globalThis.fetch = async (input, init) => {
      assert.match(String(input), /export-being-deleted\/export\?format=epub&download=1$/)
      assert.equal(new Headers(init?.headers).get('X-Mythpen-Project-Instance'), instanceId)
      fetchStarted.resolve(undefined)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'Content-Disposition': 'attachment; filename="export-being-deleted.epub"',
          'Content-Type': 'application/epub+zip',
        }),
        blob: () => blobRead.promise,
      } as Response
    }

    let consumerFinished = false
    const exportTask = consumeProjectExport(project, 'epub', async (download) => {
      assert.equal(await download.blob.text(), 'epub-data')
      assert.equal(download.fileName, 'export-being-deleted.epub')
      assert.equal(download.isCurrent(), true)
      consumerStarted.resolve(undefined)
      await finishConsumer.promise
      consumerFinished = true
      return 'downloaded'
    })
    await fetchStarted.promise

    const suspension = suspendProjectRequests(project)
    let drained = false
    const drain = suspension.waitForInflight().then(() => {
      drained = true
    })
    await Promise.resolve()
    assert.equal(drained, false)

    blobRead.resolve(new Blob(['epub-data'], { type: 'application/epub+zip' }))
    await consumerStarted.promise
    assert.equal(drained, false)

    finishConsumer.resolve(undefined)
    assert.equal(await exportTask, 'downloaded')
    await drain
    assert.equal(consumerFinished, true)
    assert.equal(drained, true)
    suspension.release()
  })

  await t.test('an instance rotation after fetch suppresses the old consumer', async () => {
    const project = 'recreated-export-project'
    const oldInstanceId = 'old-instance'
    rememberProjectInstance(project, oldInstanceId)
    t.after(() => forgetProjectInstance(project))

    const fetchStarted = deferred<void>()
    const blobRead = deferred<Blob>()
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('X-Mythpen-Project-Instance'), oldInstanceId)
      fetchStarted.resolve(undefined)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'Content-Type': 'application/epub+zip' }),
        blob: () => blobRead.promise,
      } as Response
    }

    let consumerCalled = false
    const staleTask = consumeProjectExport(project, 'epub', () => {
      consumerCalled = true
    })
    await fetchStarted.promise
    rememberProjectInstance(project, 'replacement-instance')
    blobRead.resolve(new Blob(['stale-epub']))

    await assert.rejects(staleTask, ProjectExportSupersededError)
    assert.equal(consumerCalled, false)
  })
})
