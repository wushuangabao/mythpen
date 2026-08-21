import assert from 'node:assert/strict'
import test from 'node:test'
import * as api from '../src/lib/api.ts'
import { forgetProjectInstance, rememberProjectInstance } from '../src/lib/projectInstanceRegistry.ts'

const PROJECT = 'stable-files-client'
const INSTANCE = 'stable-files-instance'
const CHAPTER_UID = '33333333-3333-4333-8333-333333333333'
const SECOND_CHAPTER_UID = '44444444-4444-4444-8444-444444444444'
const VOLUME_UID = '55555555-5555-4555-8555-555555555555'
const SECOND_VOLUME_UID = '66666666-6666-4666-8666-666666666666'
const HASH = 'a'.repeat(64)
const WITNESS: api.ManuscriptBaseWitness = {
  expected_data_version: 4,
  generation: 7,
  raw_sha256: HASH,
  sidecar_raw_sha256: HASH,
}

test('files client structural methods emit stable UID paths and body fields', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body })
    if (url.endsWith('/manuscript/witness')) {
      return Response.json({ base_witness: WITNESS })
    }
    return Response.json({ id: 9, data_version: 4 })
  }) as typeof fetch

  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    await api.chaptersApi.update(PROJECT, CHAPTER_UID, { summary: 'Summary' }, undefined, 4, WITNESS)
    await api.chaptersApi.move(PROJECT, CHAPTER_UID, VOLUME_UID, 0)
    await api.chaptersApi.reorder(
      PROJECT,
      VOLUME_UID,
      [CHAPTER_UID, SECOND_CHAPTER_UID],
    )
    await api.chaptersApi.create(PROJECT, {
      container_volume_uid: VOLUME_UID,
      requested_num: null,
      title: 'Created chapter',
    })
    await api.chaptersApi.delete(PROJECT, CHAPTER_UID, INSTANCE)
    await api.volumesApi.create(PROJECT, { title: 'Created volume', summary: 'Volume summary' })
    await api.volumesApi.update(PROJECT, VOLUME_UID, { title: 'Renamed' })
    await api.volumesApi.reorder(PROJECT, [VOLUME_UID, SECOND_VOLUME_UID])
    await api.volumesApi.delete(PROJECT, VOLUME_UID)

    const requestCountBeforeInvalidDelete = requests.length
    await assert.rejects(
      (api.chaptersApi.delete as any)(PROJECT, CHAPTER_UID, 17),
      /Project instance is not loaded/,
    )
    assert.equal(requests.length, requestCountBeforeInvalidDelete)

    const mutations = requests.filter((entry) => !entry.url.endsWith('/manuscript/witness'))
    assert.deepEqual(mutations, [
      {
        method: 'PUT',
        url: `/api/${PROJECT}/chapters/${CHAPTER_UID}`,
        body: { summary: 'Summary', expected_data_version: 4, base_witness: WITNESS },
      },
      {
        method: 'PUT',
        url: `/api/${PROJECT}/chapters/${CHAPTER_UID}/move`,
        body: { target_volume_uid: VOLUME_UID, target_position: 0, base_witness: WITNESS },
      },
      {
        method: 'PUT',
        url: `/api/${PROJECT}/chapters/order`,
        body: { container_volume_uid: VOLUME_UID, chapter_uids: [CHAPTER_UID, SECOND_CHAPTER_UID], base_witness: WITNESS },
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/chapters`,
        body: {
          container_volume_uid: VOLUME_UID,
          requested_num: null,
          title: 'Created chapter',
          base_witness: WITNESS,
        },
      },
      {
        method: 'DELETE',
        url: `/api/${PROJECT}/chapters/${CHAPTER_UID}`,
        body: { base_witness: WITNESS },
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/volumes`,
        body: { title: 'Created volume', summary: 'Volume summary', base_witness: WITNESS },
      },
      {
        method: 'PUT',
        url: `/api/${PROJECT}/volumes/${VOLUME_UID}`,
        body: { title: 'Renamed', base_witness: WITNESS },
      },
      {
        method: 'PUT',
        url: `/api/${PROJECT}/volumes/order`,
        body: { volume_uids: [VOLUME_UID, SECOND_VOLUME_UID], base_witness: WITNESS },
      },
      {
        method: 'DELETE',
        url: `/api/${PROJECT}/volumes/${VOLUME_UID}`,
        body: { base_witness: WITNESS },
      },
    ])
  } finally {
    forgetProjectInstance(PROJECT)
    globalThis.fetch = originalFetch
  }
})

test('orphan client methods use exact server-owned action endpoints and reject invalid UID before fetch', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  let fetches = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1
    requests.push({
      method: init?.method || 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Response.json({ disposition: 'after', generation: 8 })
  }) as typeof fetch

  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    const orphanApi = api.manuscriptOrphansApi
    assert.ok(orphanApi)
    await assert.rejects(
      orphanApi.ignoreInPlace(PROJECT, { kind: 'chapter', uid: 'not-a-uid' }),
      TypeError,
    )
    await assert.rejects(
      orphanApi.ignoreInPlace(PROJECT, { kind: 'chapter', uid: CHAPTER_UID, action: 'ignore_in_place' } as never),
      TypeError,
    )
    assert.equal(fetches, 0)
    await orphanApi.ignoreInPlace(PROJECT, { kind: 'chapter', uid: CHAPTER_UID })
    await orphanApi.revokeIgnore(PROJECT, { kind: 'chapter', uid: CHAPTER_UID })
    assert.deepEqual(requests, [
      {
        method: 'POST',
        url: `/api/${PROJECT}/manuscript/orphans/ignore-in-place`,
        body: { kind: 'chapter', uid: CHAPTER_UID },
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/manuscript/orphans/revoke-ignore`,
        body: { kind: 'chapter', uid: CHAPTER_UID },
      },
    ])
  } finally {
    forgetProjectInstance(PROJECT)
    globalThis.fetch = originalFetch
  }
})

test('ignored reference client sends only stable UID and the structural action enum', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  let fetches = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1
    requests.push({
      method: init?.method || 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Response.json({ disposition: 'after', generation: 8 })
  }) as typeof fetch

  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    const ignoredApi = api.manuscriptIgnoredApi
    assert.ok(ignoredApi)
    await assert.rejects(
      ignoredApi.updateReference(PROJECT, { action: 'ignored.detach_reference', uid: 'not-a-uid' }),
      TypeError,
    )
    await assert.rejects(
      ignoredApi.updateReference(PROJECT, {
        action: 'ignored.detach_reference',
        uid: CHAPTER_UID,
        path: 'C:\\forbidden.md',
      } as never),
      TypeError,
    )
    await assert.rejects(
      ignoredApi.updateReference(PROJECT, {
        action: 'ignored.rename_reference',
        uid: CHAPTER_UID,
      } as never),
      TypeError,
    )
    assert.equal(fetches, 0)
    await ignoredApi.updateReference(PROJECT, {
      action: 'ignored.preserve_move_to_unassigned',
      uid: CHAPTER_UID,
    })
    await ignoredApi.updateReference(PROJECT, {
      action: 'ignored.detach_reference',
      uid: CHAPTER_UID,
    })
    assert.deepEqual(requests, [
      {
        method: 'POST',
        url: `/api/${PROJECT}/manuscript/ignored/reference`,
        body: { action: 'ignored.preserve_move_to_unassigned', uid: CHAPTER_UID },
      },
      {
        method: 'POST',
        url: `/api/${PROJECT}/manuscript/ignored/reference`,
        body: { action: 'ignored.detach_reference', uid: CHAPTER_UID },
      },
    ])
  } finally {
    forgetProjectInstance(PROJECT)
    globalThis.fetch = originalFetch
  }
})

test('AI chapter streams send stable UID and a logical request ID for files chapters', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response('event: done\ndata: {"success":true}\n\n', { status: 200 })
  }) as typeof fetch

  const waitForStream = (
    start: (onEnd: () => void, onError: (error: unknown) => void) => void,
  ) => new Promise<void>((resolve, reject) => start(resolve, reject))

  try {
    rememberProjectInstance(PROJECT, INSTANCE)
    await waitForStream((onEnd, onError) => {
      api.aiApi.continueWriting(CHAPTER_UID, '', PROJECT, () => {}, onEnd, onError)
    })
    await waitForStream((onEnd, onError) => {
      api.aiApi.polishChapter(CHAPTER_UID, PROJECT, () => {}, onEnd, onError)
    })

    assert.deepEqual(requests.map((request) => ({ url: request.url, body: request.body })), [
      {
        url: '/api/ai/continue',
        body: { chapterUid: CHAPTER_UID, context: '', project: PROJECT },
      },
      {
        url: '/api/ai/polish',
        body: { chapterUid: CHAPTER_UID, project: PROJECT },
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
