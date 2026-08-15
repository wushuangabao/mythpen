import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, projectsApi, suspendProjectApiRequests } from '../src/lib/api.ts'
import { ProjectRequestSuspendedError } from '../src/lib/projectRequestGate.ts'
import {
  forgetProjectInstance,
  PROJECT_INSTANCE_HEADER,
  rememberProjectInstance,
} from '../src/lib/projectInstanceRegistry.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('diagnostics helpers use encoded by-name routes, exact bodies, and no instance header', async () => {
  const originalFetch = globalThis.fetch
  const project = 'novel / 项目?'
  const requests: Array<{ url: string; method: string; body: unknown; instanceId: string | null }> = []

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method || 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      instanceId: new Headers(init?.headers).get(PROJECT_INSTANCE_HEADER),
    })
    if (requests.length === 3) return jsonResponse({ filename: '92ecf7ea.mythpen-diagnostics.json' })
    return jsonResponse({ state: 'isolated', snapshot: 'a'.repeat(64) })
  }) as typeof fetch

  try {
    rememberProjectInstance(project, 'must-not-be-sent')
    await projectsApi.getDiagnostics(project)
    await projectsApi.recoverDiagnostics(project, 'recover_v1_publication', 'a'.repeat(64))
    await projectsApi.exportDiagnostics(project)

    const encoded = 'novel%20%2F%20%E9%A1%B9%E7%9B%AE%3F'
    assert.deepEqual(requests, [
      {
        url: `/api/projects/by-name/${encoded}/diagnostics`,
        method: 'GET',
        body: undefined,
        instanceId: null,
      },
      {
        url: `/api/projects/by-name/${encoded}/diagnostics/recover`,
        method: 'POST',
        body: { action: 'recover_v1_publication', snapshot: 'a'.repeat(64) },
        instanceId: null,
      },
      {
        url: `/api/projects/by-name/${encoded}/diagnostics/export`,
        method: 'POST',
        body: {},
        instanceId: null,
      },
    ])
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('reserved project names stay on the fixed diagnostics route', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestedUrl = String(input)
    return jsonResponse({ state: 'isolated', snapshot: 'b'.repeat(64) })
  }) as typeof fetch

  try {
    await projectsApi.getDiagnostics('settings')
    assert.equal(requestedUrl, '/api/projects/by-name/settings/diagnostics')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('all diagnostics helpers share the project-name request suspension gate', async () => {
  const originalFetch = globalThis.fetch
  const project = 'suspended-diagnostics'
  let fetchStarts = 0
  globalThis.fetch = (async () => {
    fetchStarts++
    return jsonResponse({})
  }) as typeof fetch
  const suspension = suspendProjectApiRequests(project)

  try {
    await assert.rejects(projectsApi.getDiagnostics(project), ProjectRequestSuspendedError)
    await assert.rejects(
      projectsApi.recoverDiagnostics(project, 'recover_v1_publication', 'c'.repeat(64)),
      ProjectRequestSuspendedError,
    )
    await assert.rejects(projectsApi.exportDiagnostics(project), ProjectRequestSuspendedError)
    assert.equal(fetchStarts, 0)
  } finally {
    suspension.release()
    globalThis.fetch = originalFetch
  }
})

test('ApiError keeps only the public envelope and safe plain-object details', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    jsonResponse(
      {
        error: {
          code: 'RECOVERY_SNAPSHOT_STALE',
          message: 'Refresh diagnostics before retrying',
          recoverable: true,
          details: { next: 'refresh', attempt: 2 },
          path: 'C:\\Users\\secret\\novel.db',
          stack: 'private stack',
        },
        rawDatabase: 'private bytes',
      },
      409,
    )) as typeof fetch

  try {
    await assert.rejects(projectsApi.getDiagnostics('error-project'), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'RECOVERY_SNAPSHOT_STALE')
      assert.equal(error.message, 'Refresh diagnostics before retrying')
      assert.equal(error.recoverable, true)
      assert.deepEqual(error.details, { next: 'refresh', attempt: 2 })
      for (const forbidden of ['body', 'response', 'headers', 'path', 'rawDatabase']) {
        assert.equal(forbidden in error, false)
      }
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ApiError discards non-object details instead of retaining raw payloads', async () => {
  const originalFetch = globalThis.fetch
  const invalidDetails: unknown[] = [null, 'private text', ['private', 'array']]
  let call = 0
  globalThis.fetch = (async () =>
    jsonResponse(
      {
        error: {
          code: 'RECOVERY_REQUIRED',
          message: 'Recovery required',
          recoverable: false,
          details: invalidDetails[call++],
        },
      },
      409,
    )) as typeof fetch

  try {
    for (let index = 0; index < invalidDetails.length; index++) {
      await assert.rejects(projectsApi.getDiagnostics(`invalid-details-${index}`), (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.details, undefined)
        return true
      })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})
