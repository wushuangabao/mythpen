import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, worldApi } from '../src/lib/api.ts'
import {
  forgetProjectInstance,
  rememberProjectInstance,
  PROJECT_INSTANCE_HEADER,
} from '../src/lib/projectInstanceRegistry.ts'

type Call = { url: string; method: string; body?: string; projectInstanceId: string | null }

test('worldApi converts persisted tag text and sends project-scoped typed mutation requests', async () => {
  const originalFetch = globalThis.fetch
  const calls: Call[] = []
  const project = 'Project / A'

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body?.toString(),
      projectInstanceId: new Headers(init?.headers).get(PROJECT_INSTANCE_HEADER),
    }
    calls.push(call)

    if (call.method === 'GET') {
      return new Response(JSON.stringify([
        { id: 'entry-1', category: 'location', name: 'City', description: '', tags: '["critical", "city"]' },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    rememberProjectInstance(project, 'world-api-instance')
    const entries = await worldApi.list(project)
    assert.deepEqual(entries[0].tags, ['critical', 'city'])

    await worldApi.create(project, {
      category: 'location',
      name: 'City',
      description: '',
      tags: ['critical'],
    })
    assert.equal(calls[1].url, '/api/Project%20%2F%20A/world')
    assert.equal(calls[1].method, 'POST')
    assert.equal(calls[1].body, '{"category":"location","name":"City","description":"","tags":["critical"]}')

    await worldApi.update(project, 'entry / 1', { name: 'Updated' })
    assert.equal(calls[2].url, '/api/Project%20%2F%20A/world/entry%20%2F%201')
    assert.equal(calls[2].method, 'PUT')
    assert.equal(calls[2].body, '{"name":"Updated"}')
    assert.equal(calls[2].projectInstanceId, 'world-api-instance')
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})

test('worldApi.delete preserves API errors for missing entries', async () => {
  const originalFetch = globalThis.fetch
  const project = 'Project / A'
  const id = 'missing / entry'

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const isExpectedDelete = String(input) === '/api/Project%20%2F%20A/world/missing%20%2F%20entry'
      && init?.method === 'DELETE'
      && new Headers(init?.headers).get(PROJECT_INSTANCE_HEADER) === 'world-api-instance'

    if (!isExpectedDelete) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: { message: '条目不存在' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    rememberProjectInstance(project, 'world-api-instance')
    await assert.rejects(() => worldApi.delete(project, id), ApiError)
  } finally {
    forgetProjectInstance(project)
    globalThis.fetch = originalFetch
  }
})
