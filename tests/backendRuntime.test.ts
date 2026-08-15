import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BackendRuntimeUnavailableError,
  backendFetch,
  configureBackendRuntimeForTests,
  resetBackendRuntimeForTests,
  resetBackendSession,
  type SidecarSession,
} from '../src/lib/backendRuntime.ts'

const SESSION_A: SidecarSession = {
  port: 54321,
  nonce: 'a'.repeat(64),
  childPid: 101,
  buildInfo: {
    nativeActivationMode: 'off',
    sourceCommit: '1'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  },
}

const SESSION_B: SidecarSession = {
  ...SESSION_A,
  port: 54322,
  nonce: 'b'.repeat(64),
  childPid: 202,
}

function okResponse() {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test('browser transport uses /api without invoking Tauri or adding a nonce', async (t) => {
  t.after(resetBackendRuntimeForTests)
  let invokeCalls = 0
  let captured: { input: string; init?: RequestInit } | null = null
  const signal = new AbortController().signal
  configureBackendRuntimeForTests({
    mode: 'browser',
    invoke: async () => {
      invokeCalls++
      return SESSION_A
    },
    fetch: async (input, init) => {
      captured = { input: String(input), init }
      return okResponse()
    },
  })

  await backendFetch('/health', {
    method: 'POST',
    body: 'body',
    cache: 'no-store',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Mythpen-Project-Instance': 'project-instance',
    },
  })

  assert.equal(invokeCalls, 0)
  assert.equal(captured?.input, '/api/health')
  assert.equal(captured?.init?.signal, signal)
  assert.equal(captured?.init?.body, 'body')
  assert.equal(captured?.init?.cache, 'no-store')
  const headers = new Headers(captured?.init?.headers)
  assert.equal(headers.get('X-Mythpen-Instance-Nonce'), null)
  assert.equal(headers.get('X-Mythpen-Project-Instance'), 'project-instance')
})

test('Tauri transport fails closed before fetch while session is unavailable', async (t) => {
  t.after(resetBackendRuntimeForTests)
  for (const invoke of [async () => null, async () => Promise.reject(new Error('raw ipc secret'))]) {
    let fetchCalls = 0
    configureBackendRuntimeForTests({
      mode: 'tauri',
      invoke,
      fetch: async () => {
        fetchCalls++
        return okResponse()
      },
    })

    await assert.rejects(backendFetch('/health'), (error: unknown) => {
      assert.ok(error instanceof BackendRuntimeUnavailableError)
      assert.equal(error.code, 'BACKEND_RUNTIME_UNAVAILABLE')
      assert.doesNotMatch(error.message, /3001|raw ipc secret|nonce/i)
      return true
    })
    assert.equal(fetchCalls, 0)
    resetBackendSession()
  }
})

test('Tauri transport uses the dynamic port and overwrites a caller nonce exactly once', async (t) => {
  t.after(resetBackendRuntimeForTests)
  let captured: { input: string; headers: Headers } | null = null
  const callerHeaders = new Headers({
    'X-Mythpen-Instance-Nonce': 'wrong',
    'X-Mythpen-Project-Instance': 'project-instance',
  })
  callerHeaders.append('X-Mythpen-Instance-Nonce', 'also-wrong')
  configureBackendRuntimeForTests({
    mode: 'tauri',
    invoke: async () => SESSION_A,
    fetch: async (input, init) => {
      captured = { input: String(input), headers: new Headers(init?.headers) }
      return okResponse()
    },
  })

  await backendFetch('/projects?recent=1', { headers: callerHeaders })

  assert.equal(captured?.input, 'http://127.0.0.1:54321/api/projects?recent=1')
  assert.equal(captured?.headers.get('X-Mythpen-Instance-Nonce'), SESSION_A.nonce)
  assert.equal(captured?.headers.get('X-Mythpen-Project-Instance'), 'project-instance')
})

test('absolute and protocol-relative paths are rejected before invoke or fetch', async (t) => {
  t.after(resetBackendRuntimeForTests)
  let invokeCalls = 0
  let fetchCalls = 0
  configureBackendRuntimeForTests({
    mode: 'tauri',
    invoke: async () => {
      invokeCalls++
      return SESSION_A
    },
    fetch: async () => {
      fetchCalls++
      return okResponse()
    },
  })

  for (const path of ['https://example.com/api', 'http://127.0.0.1/api', '//example.com/api', '\\evil']) {
    await assert.rejects(backendFetch(path), TypeError)
  }
  assert.equal(invokeCalls, 0)
  assert.equal(fetchCalls, 0)
})

test('session reset fences a late old invoke result and subsequent requests use only the replacement', async (t) => {
  t.after(resetBackendRuntimeForTests)
  const first = deferred<SidecarSession | null>()
  let invokeCalls = 0
  const urls: string[] = []
  configureBackendRuntimeForTests({
    mode: 'tauri',
    invoke: async () => {
      invokeCalls++
      return invokeCalls === 1 ? first.promise : SESSION_B
    },
    fetch: async (input) => {
      urls.push(String(input))
      return okResponse()
    },
  })

  const oldRequest = backendFetch('/health')
  await Promise.resolve()
  resetBackendSession()
  await backendFetch('/health')
  first.resolve(SESSION_A)
  await oldRequest
  await backendFetch('/health')

  assert.deepEqual(urls, [
    'http://127.0.0.1:54322/api/health',
    'http://127.0.0.1:54321/api/health',
    'http://127.0.0.1:54322/api/health',
  ])
})
