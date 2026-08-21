import assert from 'node:assert/strict'
import test from 'node:test'
import * as api from '../src/lib/api.ts'
import { forgetProjectInstance, rememberProjectInstance } from '../src/lib/projectInstanceRegistry.ts'

const PROJECT = 'revision-files-client'
const INSTANCE = 'revision-files-instance'
const CHAPTER_UID = '44444444-4444-4444-8444-444444444444'
const HASH = 'a'.repeat(64)
const WITNESS: api.ManuscriptBaseWitness = {
  expected_data_version: 0,
  generation: 9,
  raw_sha256: HASH,
  sidecar_raw_sha256: null,
}

test('revision mutation clients bind one fresh manuscript witness and request id', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; headers: Headers; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/manuscript/witness')) {
      return Response.json({ base_witness: WITNESS })
    }
    requests.push({
      method: init?.method || 'GET',
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Response.json({ success: true })
  }) as typeof fetch

  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    await api.chapterRevisionsApi.updateDecisions(
      PROJECT,
      41,
      { 'change-0': 'accepted' },
      'base',
    )
    await api.chapterRevisionsApi.rejectAll(PROJECT, 41, 'base')
    await api.chapterRevisionsApi.acceptAll(PROJECT, 41, 'base')
    await api.chapterRevisionsApi.finalize(
      PROJECT,
      41,
      'materialized',
      'base',
      { 'change-0': 'accepted' },
    )

    assert.deepEqual(requests.map(({ method, url, body }) => ({ method, url, body })), [
      {
        method: 'PATCH',
        url: `/api/${PROJECT}/revisions/41`,
        body: {
          decisions: { 'change-0': 'accepted' },
          expectedBaseContent: 'base',
          base_witness: WITNESS,
        },
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/revisions/41/reject-all`,
        body: { expectedBaseContent: 'base', base_witness: WITNESS },
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/revisions/41/accept-all`,
        body: { expectedBaseContent: 'base', base_witness: WITNESS },
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/revisions/41/finalize`,
        body: {
          content: 'materialized',
          expectedBaseContent: 'base',
          expectedDecisions: { 'change-0': 'accepted' },
          base_witness: WITNESS,
        },
      },
    ])
    for (const request of requests) {
      assert.equal(request.headers.get('X-Mythpen-Project-Instance'), INSTANCE)
      assert.match(
        request.headers.get('X-Mythpen-Request-Id') || '',
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    }
  } finally {
    forgetProjectInstance(PROJECT)
    globalThis.fetch = originalFetch
  }
})

test('active revision client accepts and preserves a stable chapter UID', async () => {
  const originalFetch = globalThis.fetch
  let observedUrl = ''
  globalThis.fetch = (async (input: string | URL | Request) => {
    observedUrl = String(input)
    return Response.json({ revision: null, rebased: false })
  }) as typeof fetch
  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    await api.chapterRevisionsApi.getActive(PROJECT, CHAPTER_UID)
    assert.equal(observedUrl, `/api/${PROJECT}/chapters/${CHAPTER_UID}/revisions/active`)
  } finally {
    forgetProjectInstance(PROJECT)
    globalThis.fetch = originalFetch
  }
})

test('files revision create obtains the chapter-scoped witness from the generation-start read', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({
      method: init?.method || 'GET',
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    if (url === `/api/${PROJECT}/chapters/${CHAPTER_UID}`) {
      return Response.json({ base_witness: WITNESS })
    }
    return Response.json({ revision: { id: 41 }, rebased: false })
  }) as typeof fetch
  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    await api.chapterRevisionsApi.create(PROJECT, CHAPTER_UID, 'base', 'proposal')
    assert.deepEqual(requests, [
      {
        method: 'GET',
        url: `/api/${PROJECT}/chapters/${CHAPTER_UID}`,
        body: undefined,
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/chapters/${CHAPTER_UID}/revisions`,
        body: {
          baseContent: 'base',
          proposedContent: 'proposal',
          base_witness: WITNESS,
        },
      },
    ])
  } finally {
    forgetProjectInstance(PROJECT)
    globalThis.fetch = originalFetch
  }
})

test('files revision create binds its witness read and mutation to one project instance', async () => {
  const originalFetch = globalThis.fetch
  const replacementInstance = '73000000-0000-4000-8000-000000000099'
  const instanceHeaders: Array<string | null> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    instanceHeaders.push(new Headers(init?.headers).get('X-Mythpen-Project-Instance'))
    if (String(input) === `/api/${PROJECT}/chapters/${CHAPTER_UID}`) {
      rememberProjectInstance(PROJECT, replacementInstance)
      return Response.json({ base_witness: WITNESS })
    }
    return Response.json({ revision: { id: 41 }, rebased: false })
  }) as typeof fetch
  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    await api.chapterRevisionsApi.create(PROJECT, CHAPTER_UID, 'base', 'proposal')
    assert.deepEqual(instanceHeaders, [INSTANCE, INSTANCE])
  } finally {
    forgetProjectInstance(PROJECT)
    globalThis.fetch = originalFetch
  }
})
