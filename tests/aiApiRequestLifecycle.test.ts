import assert from 'node:assert/strict'
import test from 'node:test'
import { aiApi, ApiError, suspendProjectApiRequests } from '../src/lib/api.ts'
import { forgetProjectInstance, rememberProjectInstance } from '../src/lib/projectInstanceRegistry.ts'

type StreamOutcome = { kind: 'end' } | { kind: 'error'; error: unknown }

function waitForStreamOutcome(start: (onEnd: () => void, onError: (error: unknown) => void) => void) {
  return new Promise<StreamOutcome>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('stream callback did not settle')), 500)
    const settle = (outcome: StreamOutcome) => {
      clearTimeout(timeout)
      resolve(outcome)
    }
    start(
      () => settle({ kind: 'end' }),
      (error) => settle({ kind: 'error', error }),
    )
  })
}

test('non-streaming AI JSON parsing remains inside the project request gate', async () => {
  const originalFetch = globalThis.fetch
  const project = 'ai-json-body-gate'
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  let bodyClosed = false

  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch
  rememberProjectInstance(project, 'ai-json-instance')

  const chat = aiApi.chat([{ role: 'user', content: 'hello' }], project)
  const suspension = suspendProjectApiRequests(project)
  let drained = false
  const drain = suspension.waitForInflight().then(() => {
    drained = true
  })

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(drained, false)

    bodyController.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"done"}}]}'))
    bodyController.close()
    bodyClosed = true

    assert.equal((await chat).choices[0].message.content, 'done')
    await drain
    assert.equal(drained, true)
  } finally {
    if (!bodyClosed) bodyController.close()
    suspension.release()
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('all AI SSE helpers reject non-OK responses before reading a stream', async () => {
  const originalFetch = globalThis.fetch
  const project = 'ai-sse-http-error'
  const errorBody = {
    error: {
      code: 'PROJECT_INSTANCE_MISMATCH',
      message: 'stale project instance',
      recoverable: true,
    },
  }
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(errorBody), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch
  rememberProjectInstance(project, 'stale-instance')

  const starters = [
    (onEnd: () => void, onError: (error: unknown) => void) =>
      aiApi.chatStream([], project, () => {}, onEnd, onError),
    (onEnd: () => void, onError: (error: unknown) => void) =>
      aiApi.continueWriting(1, '', project, () => {}, onEnd, onError),
    (onEnd: () => void, onError: (error: unknown) => void) =>
      aiApi.polishChapter(1, project, () => {}, onEnd, onError),
  ]

  try {
    for (const start of starters) {
      const outcome = await waitForStreamOutcome((onEnd, onError) => {
        start(onEnd, onError)
      })
      assert.equal(outcome.kind, 'error')
      if (outcome.kind === 'error') {
        assert.ok(outcome.error instanceof ApiError)
        assert.equal(outcome.error.status, 409)
        assert.equal(outcome.error.code, 'PROJECT_INSTANCE_MISMATCH')
      }
    }
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('chatStream treats task_error as failure and never calls onEnd', async () => {
  const originalFetch = globalThis.fetch
  const project = 'ai-task-error'
  let endCalls = 0
  let errorCalls = 0
  globalThis.fetch = (async () =>
    new Response('event: task_error\ndata: {"error":"tool loop failed"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch
  rememberProjectInstance(project, 'task-error-instance')

  try {
    const outcome = await waitForStreamOutcome((onEnd, onError) => {
      aiApi.chatStream(
        [],
        project,
        () => {},
        () => {
          endCalls++
          onEnd()
        },
        (error) => {
          errorCalls++
          onError(error)
        },
      )
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    assert.equal(outcome.kind, 'error')
    if (outcome.kind === 'error') assert.deepEqual(outcome.error, { error: 'tool loop failed' })
    assert.equal(errorCalls, 1)
    assert.equal(endCalls, 0)
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('chatStream treats EOF without task_end as a truncated failure', async () => {
  const originalFetch = globalThis.fetch
  const project = 'ai-truncated-stream'
  let endCalls = 0
  globalThis.fetch = (async () =>
    new Response('event: content_chunk\ndata: {"text":"partial"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch
  rememberProjectInstance(project, 'truncated-stream-instance')

  try {
    const outcome = await waitForStreamOutcome((onEnd, onError) => {
      aiApi.chatStream(
        [],
        project,
        () => {},
        () => {
          endCalls++
          onEnd()
        },
        onError,
      )
    })

    assert.equal(outcome.kind, 'error')
    if (outcome.kind === 'error') {
      assert.ok(outcome.error instanceof Error)
      assert.match(outcome.error.message, /ended before completion/i)
    }
    assert.equal(endCalls, 0)
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('chatStream completes only after an explicit task_end event', async () => {
  const originalFetch = globalThis.fetch
  const project = 'ai-complete-stream'
  globalThis.fetch = (async () =>
    new Response('event: task_end\ndata: {"success":true}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch
  rememberProjectInstance(project, 'complete-stream-instance')

  try {
    const outcome = await waitForStreamOutcome((onEnd, onError) => {
      aiApi.chatStream([], project, () => {}, onEnd, onError)
    })
    assert.deepEqual(outcome, { kind: 'end' })
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})
