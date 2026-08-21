'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_UID = '33333333-3333-4333-8333-333333333333';
const SECOND_CHAPTER_UID = '44444444-4444-4444-8444-444444444444';
const VOLUME_UID = '55555555-5555-4555-8555-555555555555';
const SECOND_VOLUME_UID = '66666666-6666-4666-8666-666666666666';
const HASH = 'a'.repeat(64);
const BASE_WITNESS = Object.freeze({
  expected_data_version: 4,
  generation: 7,
  raw_sha256: HASH,
  sidecar_raw_sha256: HASH,
});

const calls = {
  database: 0,
  ignore: [],
  reads: [],
  revoke: [],
  routeAdmissions: 0,
  writes: [],
};

function resetCalls() {
  calls.database = 0;
  calls.ignore.length = 0;
  calls.reads.length = 0;
  calls.revoke.length = 0;
  calls.routeAdmissions = 0;
  calls.writes.length = 0;
}

function runtimeBaseWitness() {
  return Object.freeze({
    expectedDataVersion: BASE_WITNESS.expected_data_version,
    generation: BASE_WITNESS.generation,
    rawSha256: BASE_WITNESS.raw_sha256,
    sidecarRawSha256: BASE_WITNESS.sidecar_raw_sha256,
  });
}

const runtime = Object.freeze({
  async close() {},
  async createProject() {},
  async ignoreInPlace(selector, request) {
    calls.ignore.push({ selector, request });
    return Object.freeze({ disposition: 'after', generation: 8 });
  },
  async migrateProject() {},
  async read(selector, request) {
    calls.reads.push({ selector, request });
    if (request.kind === 'product_view') {
      return Object.freeze({
        baseWitness: runtimeBaseWitness(),
        value: Object.freeze({
          metadata: Object.freeze({
            name: 'novel',
            mode: 'medium-novel',
            workflow_phase: 'writing',
            genres: Object.freeze(['fantasy']),
          }),
          sidebarItems: Object.freeze([Object.freeze({ route: 'page-dashboard' })]),
          summary: Object.freeze({
            chapterCount: 1,
            volumeCount: 1,
            wordCount: 4,
            currentManuscriptPosition: 1,
          }),
        }),
      });
    }
    if (request.kind === 'stats') {
      return Object.freeze({
        baseWitness: runtimeBaseWitness(),
        value: Object.freeze({ chapterCount: 1, totalWords: 4, overdueForeshadow: 0 }),
      });
    }
    if (request.kind === 'character_associations') {
      return Object.freeze({
        baseWitness: runtimeBaseWitness(),
        value: Object.freeze([Object.freeze({
          id: 'character-1',
          name: 'Active only',
          appearances: Object.freeze([Object.freeze({
            chapter_id: 9,
            volume_id: 3,
            num: 4,
            title: 'Stable chapter',
            role: 'appears',
          })]),
          chapterCount: 1,
        })]),
      });
    }
    return Object.freeze({
      baseWitness: runtimeBaseWitness(),
      value: Object.freeze({
        id: 9,
        volume_id: 3,
        num: 4,
        data_version: 4,
        chapter_uid: CHAPTER_UID,
        title: 'Stable chapter',
        outline: '',
        content: 'body',
        summary: 'summary',
        word_count: 4,
        status: 'pending',
        body_raw_sha256: HASH,
        sidecar_raw_sha256: HASH,
      }),
    });
  },
  async recover() {},
  async revokeIgnore(selector, request) {
    calls.revoke.push({ selector, request });
    return Object.freeze({ disposition: 'after', generation: 9 });
  },
  async write(selector, request) {
    calls.writes.push({ selector, request });
    return Object.freeze({ disposition: 'after', generation: 8, uid: CHAPTER_UID });
  },
});

const database = require('../db');
const originals = Object.fromEntries([
  'getProjectDb',
  'inspectProjectManuscriptRoute',
  'projectExecute',
  'projectGet',
  'projectQuery',
  'runWithProjectInstance',
].map((key) => [key, database[key]]));

database.runWithProjectInstance = (_name, _expectedInstanceId, operation) => operation();
database.inspectProjectManuscriptRoute = () => {
  calls.routeAdmissions += 1;
  return Object.freeze({
    route: 'files',
    databaseFacts: Object.freeze({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
    }),
  });
};
for (const method of ['getProjectDb', 'projectExecute', 'projectGet', 'projectQuery']) {
  database[method] = () => {
    calls.database += 1;
    throw new Error(`files API must not call db.${method}`);
  };
}

require('../manuscript/runtime').installManuscriptRuntime(runtime);
const apiRouter = require('../routes/api');
const { jsonErrorMiddleware, jsonNotFoundMiddleware } = require('../json-error-middleware');

test.after(() => {
  Object.assign(database, originals);
});

async function listen(t) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(jsonNotFoundMiddleware);
  app.use(jsonErrorMiddleware);
  const server = await new Promise((resolve) => {
    const pending = app.listen(0, '127.0.0.1', () => resolve(pending));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api`;
}

async function request(baseUrl, path, { method = 'GET', body, requestId = 'task4-api' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Mythpen-Request-Id': requestId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

test('files chapter and volume routes forward only stable UID commands to runtime', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const cases = [
    {
      path: `/novel/chapters/${CHAPTER_UID}`,
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, expected_data_version: 4, content: 'next', summary: 'new summary' },
      command: {
        kind: 'chapter.replace_body_and_sidecar',
        chapterUid: CHAPTER_UID,
        expected_data_version: 4,
        content: 'next',
        patch: { summary: 'new summary' },
      },
    },
    {
      path: `/novel/chapters/${CHAPTER_UID}/move`,
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, target_volume_uid: VOLUME_UID, target_position: 0 },
      command: {
        kind: 'chapter.move',
        chapterUid: CHAPTER_UID,
        targetVolumeUid: VOLUME_UID,
        targetPosition: 0,
      },
    },
    {
      path: '/novel/chapters/order',
      method: 'PUT',
      body: {
        base_witness: BASE_WITNESS,
        container_volume_uid: VOLUME_UID,
        chapter_uids: [CHAPTER_UID, SECOND_CHAPTER_UID],
      },
      command: {
        kind: 'chapter.reorder',
        containerVolumeUid: VOLUME_UID,
        chapterUids: [CHAPTER_UID, SECOND_CHAPTER_UID],
      },
    },
    {
      path: '/novel/chapters',
      method: 'POST',
      body: {
        base_witness: BASE_WITNESS,
        container_volume_uid: VOLUME_UID,
        requested_num: null,
        title: 'Created',
        outline: '',
        summary: '',
        status: 'pending',
      },
      command: {
        kind: 'chapter.create',
        containerVolumeUid: VOLUME_UID,
        requestedNum: null,
        content: '',
        sidecar: {
          title: 'Created',
          outline: '',
          summary: '',
          status: 'pending',
          cognitive_frame: '',
          emotional_anchor: '',
          world_texture: '',
          concrete_mystery: '',
          interpersonal_tension: '',
        },
      },
    },
    {
      path: `/novel/chapters/${CHAPTER_UID}`,
      method: 'DELETE',
      body: { base_witness: BASE_WITNESS },
      command: { kind: 'chapter.delete', chapterUid: CHAPTER_UID },
    },
    {
      path: '/novel/volumes',
      method: 'POST',
      body: { base_witness: BASE_WITNESS, title: 'Created volume', summary: 'Volume summary' },
      command: { kind: 'volume.create', title: 'Created volume', summary: 'Volume summary' },
    },
    {
      path: `/novel/volumes/${VOLUME_UID}`,
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, title: 'Renamed', summary: 'Updated' },
      command: { kind: 'volume.patch_metadata', volumeUid: VOLUME_UID, patch: { title: 'Renamed', summary: 'Updated' } },
    },
    {
      path: '/novel/volumes/order',
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, volume_uids: [VOLUME_UID, SECOND_VOLUME_UID] },
      command: { kind: 'volume.reorder', volumeUids: [VOLUME_UID, SECOND_VOLUME_UID] },
    },
    {
      path: `/novel/volumes/${VOLUME_UID}`,
      method: 'DELETE',
      body: { base_witness: BASE_WITNESS },
      command: { kind: 'volume.delete', volumeUid: VOLUME_UID },
    },
  ];

  const responses = [];
  for (const entry of cases) responses.push(await request(baseUrl, entry.path, entry));
  assert.deepEqual(responses.map((response) => response.status), cases.map((entry) => (
    entry.method === 'POST' ? 201 : 200
  )));
  assert.deepEqual(calls.writes.map((entry) => entry.request.command), cases.map((entry) => entry.command));
  assert.deepEqual(calls.writes.map((entry) => entry.selector), cases.map(() => ({ projectUid: PROJECT_UID })));
  assert.equal(calls.database, 0);

  const detail = await request(baseUrl, `/novel/chapters/${CHAPTER_UID}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(calls.reads.at(-1).request, { kind: 'chapter', chapterUid: CHAPTER_UID });
});

test('files structural routes reject the legacy numeric identity vocabulary', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const legacyRequests = [
    {
      path: `/novel/chapters/${CHAPTER_UID}`,
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, chapter_id: 7, title: 'legacy' },
    },
    {
      path: `/novel/chapters/${CHAPTER_UID}/move`,
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, target_volume_id: 3, target_position: 0 },
    },
    {
      path: '/novel/chapters/order',
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, container_volume_id: 3, chapter_ids: [7] },
    },
    {
      path: '/novel/chapters',
      method: 'POST',
      body: { base_witness: BASE_WITNESS, volume_id: 3, title: 'legacy' },
    },
    {
      path: '/novel/volumes/order',
      method: 'PUT',
      body: { base_witness: BASE_WITNESS, volume_ids: [3] },
    },
    {
      path: '/novel/chapters/7',
      method: 'DELETE',
      body: { base_witness: BASE_WITNESS },
    },
    {
      path: '/novel/volumes/3',
      method: 'DELETE',
      body: { base_witness: BASE_WITNESS },
    },
  ];

  for (const entry of legacyRequests) {
    const response = await request(baseUrl, entry.path, entry);
    assert.equal(response.status, 400, entry.path);
  }
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.database, 0);
});

test('files orphan endpoints own their actions and reject inexact bodies before route I/O', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const invalid = [
    { kind: 'chapter', uid: 7 },
    { kind: 'chapter', uid: CHAPTER_UID, action: 'revoke_ignore' },
    { kind: 'chapter', uid: CHAPTER_UID, path: 'C:\\forbidden.md' },
    { kind: 'unknown', uid: CHAPTER_UID },
  ];
  for (const body of invalid) {
    const beforeAdmissions = calls.routeAdmissions;
    const response = await request(baseUrl, '/novel/manuscript/orphans/ignore-in-place', {
      method: 'POST',
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(calls.routeAdmissions, beforeAdmissions);
  }
  const queryBeforeAdmissions = calls.routeAdmissions;
  const query = await request(
    baseUrl,
    '/novel/manuscript/orphans/ignore-in-place?action=ignore_in_place',
    { method: 'POST', body: { kind: 'chapter', uid: CHAPTER_UID } },
  );
  assert.equal(query.status, 400);
  assert.equal(calls.routeAdmissions, queryBeforeAdmissions);
  assert.equal(calls.ignore.length, 0);
  assert.equal(calls.revoke.length, 0);

  const ignored = await request(baseUrl, '/novel/manuscript/orphans/ignore-in-place', {
    method: 'POST',
    body: { kind: 'chapter', uid: CHAPTER_UID },
    requestId: 'task4-ignore',
  });
  const revoked = await request(baseUrl, '/novel/manuscript/orphans/revoke-ignore', {
    method: 'POST',
    body: { kind: 'chapter', uid: CHAPTER_UID },
    requestId: 'task4-revoke',
  });
  assert.equal(ignored.status, 200);
  assert.equal(revoked.status, 200);
  assert.deepEqual(calls.ignore, [{
    selector: { projectUid: PROJECT_UID },
    request: { requestId: 'task4-ignore', kind: 'chapter', uid: CHAPTER_UID },
  }]);
  assert.deepEqual(calls.revoke, [{
    selector: { projectUid: PROJECT_UID },
    request: { requestId: 'task4-revoke', kind: 'chapter', uid: CHAPTER_UID },
  }]);
  assert.equal(calls.database, 0);
});

test('files ignored reference endpoint accepts only the two structural UID actions', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const invalid = [
    { action: 'ignored.preserve_move_to_unassigned', uid: 7 },
    { action: 'ignored.detach_reference', uid: CHAPTER_UID, path: 'C:\\forbidden.md' },
    { action: 'ignored.rename_reference', uid: CHAPTER_UID },
    { action: 'ignored.detach_reference', uid: CHAPTER_UID, kind: 'chapter' },
  ];
  for (const body of invalid) {
    const beforeAdmissions = calls.routeAdmissions;
    const response = await request(baseUrl, '/novel/manuscript/ignored/reference', {
      method: 'POST',
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(calls.routeAdmissions, beforeAdmissions);
  }
  const queryBeforeAdmissions = calls.routeAdmissions;
  const query = await request(
    baseUrl,
    '/novel/manuscript/ignored/reference?path=C%3A%5Cforbidden.md',
    { method: 'POST', body: { action: 'ignored.detach_reference', uid: CHAPTER_UID } },
  );
  assert.equal(query.status, 400);
  assert.equal(calls.routeAdmissions, queryBeforeAdmissions);
  assert.equal(calls.reads.length, 0);
  assert.equal(calls.writes.length, 0);

  const preserved = await request(baseUrl, '/novel/manuscript/ignored/reference', {
    method: 'POST',
    body: { action: 'ignored.preserve_move_to_unassigned', uid: CHAPTER_UID },
    requestId: 'task4-preserve-ignored',
  });
  const detached = await request(baseUrl, '/novel/manuscript/ignored/reference', {
    method: 'POST',
    body: { action: 'ignored.detach_reference', uid: CHAPTER_UID },
    requestId: 'task4-detach-ignored',
  });
  assert.equal(preserved.status, 200);
  assert.equal(detached.status, 200);
  assert.deepEqual(calls.reads.map((entry) => entry.request), [
    { kind: 'project' },
    { kind: 'project' },
  ]);
  assert.deepEqual(calls.writes, [
    {
      selector: { projectUid: PROJECT_UID },
      request: {
        requestId: 'task4-preserve-ignored',
        baseWitness: runtimeBaseWitness(),
        command: {
          kind: 'ignored.preserve_move_to_unassigned',
          chapterUid: CHAPTER_UID,
        },
      },
    },
    {
      selector: { projectUid: PROJECT_UID },
      request: {
        requestId: 'task4-detach-ignored',
        baseWitness: runtimeBaseWitness(),
        command: {
          kind: 'ignored.detach_reference',
          chapterUid: CHAPTER_UID,
        },
      },
    },
  ]);
  assert.equal(calls.database, 0);
});

test('files metadata sidebar workflow and stats read one admitted runtime snapshot each', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const metadata = await request(baseUrl, '/novel/meta');
  const sidebar = await request(baseUrl, '/novel/sidebar-items');
  const workflow = await request(baseUrl, '/novel/workflow/phase');
  const stats = await request(baseUrl, '/novel/stats');

  assert.equal(metadata.status, 200);
  assert.deepEqual(metadata.body.genres, ['fantasy']);
  assert.deepEqual(sidebar.body, [{ route: 'page-dashboard' }]);
  assert.deepEqual(workflow.body, { phase: 'writing' });
  assert.deepEqual(stats.body, { chapterCount: 1, totalWords: 4, overdueForeshadow: 0 });
  assert.deepEqual(calls.reads.map((entry) => entry.request.kind), [
    'product_view',
    'product_view',
    'product_view',
    'stats',
  ]);
  assert.equal(calls.database, 0);
});

test('files character associations come from one admitted ActiveProjection snapshot', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const response = await request(baseUrl, '/novel/characters');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, [{
    id: 'character-1',
    name: 'Active only',
    appearances: [{
      chapter_id: 9,
      volume_id: 3,
      num: 4,
      title: 'Stable chapter',
      role: 'appears',
    }],
    chapterCount: 1,
  }]);
  assert.deepEqual(calls.reads.map((entry) => entry.request), [
    { kind: 'character_associations' },
  ]);
  assert.equal(calls.database, 0);
});

test('files routes without a domain authority fail closed before legacy project database I/O', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const requests = [
    { path: '/novel/world', method: 'POST', body: { name: 'unsafe' } },
    { path: '/novel/science' },
    { path: '/novel/foreshadows' },
    { path: '/novel/relations' },
    { path: '/novel/memories' },
    { path: '/novel/timeline' },
    { path: '/novel/workflow/phase', method: 'PUT', body: { phase: 'writing' } },
    { path: '/novel/target-words', method: 'PUT', body: { targetWords: 100000 } },
    { path: '/novel/tokens' },
    { path: '/novel/chat/sessions' },
  ];

  for (const entry of requests) {
    const response = await request(baseUrl, entry.path, entry);
    assert.equal(response.status, 409, entry.path);
    assert.equal(response.body.error.code, 'RECOVERY_REQUIRED', entry.path);
  }
  assert.equal(calls.database, 0);
});
