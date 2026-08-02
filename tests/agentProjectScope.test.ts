import assert from 'node:assert/strict'
import test from 'node:test'
import {
  registerAgentTaskAbort,
  retireAgentProjectState,
  useAgentStore,
} from '../src/stores/useAgentStore.ts'
import { forgetProjectInstance, rememberProjectInstance } from '../src/lib/projectInstanceRegistry.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

test('out-of-order session lists cannot commit across project instance owners', async () => {
  const originalFetch = globalThis.fetch
  const responseA = deferred<Response>()
  const responseB = deferred<Response>()

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/project-a/chat/sessions')) return responseA.promise
    if (url.includes('/project-b/chat/sessions')) return responseB.promise
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

  rememberProjectInstance('project-a', 'instance-a')
  rememberProjectInstance('project-b', 'instance-b')
  try {
    retireAgentProjectState()
    const store = useAgentStore.getState()
    store.activateProject('project-a', 'instance-a')
    const loadA = useAgentStore.getState().loadSessions('project-a')

    useAgentStore.getState().activateProject('project-b', 'instance-b')
    const loadB = useAgentStore.getState().loadSessions('project-b')
    responseB.resolve(
      new Response(JSON.stringify([{ id: 'session-b', title: 'B' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await loadB
    responseA.resolve(
      new Response(JSON.stringify([{ id: 'session-a', title: 'A' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await loadA

    const state = useAgentStore.getState()
    assert.equal(state.project, 'project-b')
    assert.equal(state.projectInstanceId, 'instance-b')
    assert.deepEqual(state.sessions, [{ id: 'session-b', title: 'B' }])
    assert.equal(state.currentSessionId, 'session-b')
  } finally {
    retireAgentProjectState()
    forgetProjectInstance('project-a')
    forgetProjectInstance('project-b')
    globalThis.fetch = originalFetch
  }
})

test('retiring background B leaves running A intact, while exact A retirement aborts it', () => {
  rememberProjectInstance('agent-a', 'instance-a')
  rememberProjectInstance('agent-b', 'instance-b')
  let aborts = 0
  try {
    retireAgentProjectState()
    useAgentStore.getState().activateProject('agent-a', 'instance-a')
    useAgentStore.getState().setTask({ status: 'running' })
    registerAgentTaskAbort('agent-a', 'instance-a', () => {
      aborts++
    })

    assert.equal(retireAgentProjectState('agent-b', 'instance-b'), false)
    assert.equal(retireAgentProjectState('agent-a', 'wrong-instance'), false)
    assert.equal(aborts, 0)
    assert.equal(useAgentStore.getState().project, 'agent-a')
    assert.equal(useAgentStore.getState().isRunning, true)

    assert.equal(retireAgentProjectState('agent-a', 'instance-a'), true)
    assert.equal(aborts, 1)
    assert.equal(useAgentStore.getState().project, null)
    assert.equal(useAgentStore.getState().isRunning, false)
  } finally {
    retireAgentProjectState()
    forgetProjectInstance('agent-a')
    forgetProjectInstance('agent-b')
  }
})

test('a running request blocks switch, create, and delete session mutations', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async () => {
    requests++
    throw new Error('Session mutation must not reach the server while AI is running')
  }) as typeof fetch

  rememberProjectInstance('agent-session-lock', 'instance-session-lock')
  try {
    retireAgentProjectState()
    useAgentStore.getState().activateProject('agent-session-lock', 'instance-session-lock')
    useAgentStore.setState({
      sessions: [
        { id: 'session-1', title: 'One' },
        { id: 'session-2', title: 'Two' },
      ],
      currentSessionId: 'session-1',
      messages: [{ id: 'existing', role: 'user', content: 'keep me' }],
    })
    useAgentStore.getState().setTask({ status: 'running' })

    await useAgentStore.getState().switchSession('agent-session-lock', 'session-2')
    const created = await useAgentStore.getState().createSession('agent-session-lock', 'Three')
    await useAgentStore.getState().deleteSession('agent-session-lock', 'session-1')

    const state = useAgentStore.getState()
    assert.equal(requests, 0)
    assert.equal(created, null)
    assert.equal(state.currentSessionId, 'session-1')
    assert.deepEqual(
      state.sessions.map((session) => session.id),
      ['session-1', 'session-2'],
    )
    assert.deepEqual(state.messages, [{ id: 'existing', role: 'user', content: 'keep me' }])
  } finally {
    retireAgentProjectState()
    forgetProjectInstance('agent-session-lock')
    globalThis.fetch = originalFetch
  }
})

test('a message callback can append only to its immutable request session', () => {
  rememberProjectInstance('agent-message-scope', 'instance-message-scope')
  try {
    retireAgentProjectState()
    useAgentStore.getState().activateProject('agent-message-scope', 'instance-message-scope')
    useAgentStore.setState({ currentSessionId: 'session-2', messages: [] })

    const staleAdded = useAgentStore
      .getState()
      .addMessageToSession('session-1', { id: 'stale', role: 'ai', content: 'wrong session' })
    const currentAdded = useAgentStore
      .getState()
      .addMessageToSession('session-2', { id: 'current', role: 'ai', content: 'right session' })

    assert.equal(staleAdded, false)
    assert.equal(currentAdded, true)
    assert.deepEqual(useAgentStore.getState().messages, [
      { id: 'current', role: 'ai', content: 'right session' },
    ])
  } finally {
    retireAgentProjectState()
    forgetProjectInstance('agent-message-scope')
  }
})

test('an in-flight create response cannot steal selection from a newly running request', async () => {
  const originalFetch = globalThis.fetch
  const createResponse = deferred<Response>()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/agent-create-race/chat/sessions')) return createResponse.promise
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch

  rememberProjectInstance('agent-create-race', 'instance-create-race')
  try {
    retireAgentProjectState()
    useAgentStore.getState().activateProject('agent-create-race', 'instance-create-race')
    useAgentStore.setState({
      sessions: [{ id: 'session-1', title: 'One' }],
      currentSessionId: 'session-1',
      messages: [{ id: 'existing', role: 'user', content: 'request history' }],
    })

    const create = useAgentStore.getState().createSession('agent-create-race', 'Two')
    useAgentStore.getState().setTask({ status: 'running' })
    createResponse.resolve(
      new Response(JSON.stringify({ id: 'session-2', title: 'Two' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    assert.equal(await create, 'session-2')

    const state = useAgentStore.getState()
    assert.equal(state.currentSessionId, 'session-1')
    assert.deepEqual(
      state.sessions.map((session) => session.id),
      ['session-2', 'session-1'],
    )
    assert.deepEqual(state.messages, [{ id: 'existing', role: 'user', content: 'request history' }])
  } finally {
    retireAgentProjectState()
    forgetProjectInstance('agent-create-race')
    globalThis.fetch = originalFetch
  }
})
