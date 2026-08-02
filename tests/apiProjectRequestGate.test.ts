import assert from 'node:assert/strict'
import test from 'node:test'
import { chaptersApi, projectsApi, suspendProjectApiRequests } from '../src/lib/api.ts'
import { ProjectRequestSuspendedError } from '../src/lib/projectRequestGate.ts'
import {
  forgetProjectInstance,
  getProjectInstanceHeaders,
  PROJECT_INSTANCE_HEADER,
  rememberProjectInstance,
} from '../src/lib/projectInstanceRegistry.ts'

test('chapter content updates carry the draft base data version for server-side CAS', async () => {
  const originalFetch = globalThis.fetch
  const project = 'chapter-content-cas-project'
  let requestBody: Record<string, unknown> | null = null

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ id: 7, data_version: 13 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    rememberProjectInstance(project, 'cas-instance')
    await chaptersApi.update(project, 1, { content: 'local draft' }, 7, 12)
    assert.deepEqual(requestBody, {
      content: 'local draft',
      chapter_id: 7,
      expected_data_version: 12,
    })
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('project API requests drain behind deletion while the DELETE endpoint remains reachable', async () => {
  const originalFetch = globalThis.fetch
  let resolveActive!: (response: Response) => void
  const activeResponse = new Promise<Response>((resolve) => {
    resolveActive = resolve
  })
  const requestedUrls: string[] = []
  const requestedInstanceIds: Array<string | null> = []

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrls.push(String(input))
    requestedInstanceIds.push(new Headers(init?.headers).get(PROJECT_INSTANCE_HEADER))
    if (requestedUrls.length === 1) return activeResponse
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const project = 'request-gated-project'
    rememberProjectInstance(project, 'loaded-instance')
    const activeWrite = chaptersApi.update(project, 1, { title: '旧实例请求' }, 1)
    const suspension = suspendProjectApiRequests(project)

    await assert.rejects(
      chaptersApi.update(project, 1, { title: '删除期间不得发送' }, 1),
      ProjectRequestSuspendedError,
    )
    await assert.rejects(
      projectsApi.create({ name: project }),
      ProjectRequestSuspendedError,
    )
    assert.equal(requestedUrls.length, 1)
    assert.equal(requestedInstanceIds[0], 'loaded-instance')

    resolveActive(
      new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await activeWrite
    await suspension.waitForInflight()

    // The project DELETE is deliberately outside the per-project gate; it must
    // be able to run while all ordinary requests for that name remain blocked.
    await projectsApi.delete(project, 'loaded-instance')
    assert.equal(requestedUrls.length, 2)
    assert.match(requestedUrls[1], /\/projects\/by-name\/request-gated-project$/)
    assert.equal(requestedInstanceIds[1], 'loaded-instance')
    suspension.release()
  } finally {
    forgetProjectInstance('request-gated-project')
    globalThis.fetch = originalFetch
  }
})

test('project DELETE always uses its captured instance after the registry rotates', async () => {
  const originalFetch = globalThis.fetch
  const project = 'captured-delete-project'
  let resolveDelete!: (response: Response) => void
  const deleteResponse = new Promise<Response>((resolve) => {
    resolveDelete = resolve
  })
  let requestedInstanceId: string | null = null

  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestedInstanceId = new Headers(init?.headers).get(PROJECT_INSTANCE_HEADER)
    return deleteResponse
  }) as typeof fetch

  try {
    rememberProjectInstance(project, 'old-instance')
    const deletion = projectsApi.delete(project, 'old-instance')
    rememberProjectInstance(project, 'replacement-instance')
    resolveDelete(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await deletion

    assert.equal(requestedInstanceId, 'old-instance')
    assert.equal(forgetProjectInstance(project, 'old-instance'), false)
    assert.deepEqual(getProjectInstanceHeaders(project), {
      [PROJECT_INSTANCE_HEADER]: 'replacement-instance',
    })
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('reserved route names still use their explicit project gate and instance header', async () => {
  const originalFetch = globalThis.fetch
  const projects = ['ai', 'settings', 'health', 'projects']
  const requests: Array<{ url: string; instanceId: string | null }> = []

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      instanceId: new Headers(init?.headers).get(PROJECT_INSTANCE_HEADER),
    })
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    for (const project of projects) {
      rememberProjectInstance(project, `${project}-instance`)
      await chaptersApi.update(project, 1, { title: project }, 1)
      const request = requests.at(-1)
      assert.ok(request)
      assert.equal(request.instanceId, `${project}-instance`)

      const suspension = suspendProjectApiRequests(project)
      try {
        const requestCount = requests.length
        await assert.rejects(chaptersApi.update(project, 1, { title: 'blocked' }, 1), ProjectRequestSuspendedError)
        assert.equal(requests.length, requestCount)
      } finally {
        suspension.release()
      }
    }
  } finally {
    for (const project of projects) forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})
