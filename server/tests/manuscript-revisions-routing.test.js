'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_UID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const BASE_WITNESS = Object.freeze({
  expected_data_version: 0,
  generation: 9,
  raw_sha256: HASH,
  sidecar_raw_sha256: null,
});

const calls = {
  legacyDatabase: 0,
  reads: [],
  writes: [],
};

const database = require('../db');
const originals = Object.fromEntries([
  'getProjectDb',
  'inspectProjectManuscriptRoute',
  'projectGet',
  'runWithProjectInstance',
].map((key) => [key, database[key]]));

database.runWithProjectInstance = (_name, _expectedInstanceId, operation) => operation();
database.inspectProjectManuscriptRoute = () => Object.freeze({
  route: 'files',
  databaseFacts: Object.freeze({
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
  }),
});
for (const method of ['getProjectDb', 'projectGet']) {
  database[method] = () => {
    calls.legacyDatabase += 1;
    throw new Error(`files revision route must not call db.${method}`);
  };
}

const runtime = Object.freeze({
  async close() {},
  async createProject() {},
  async ignoreInPlace() {},
  async migrateProject() {},
  async read(selector, request) {
    calls.reads.push({ selector, request });
    return Object.freeze({
      baseWitness: Object.freeze({
        expectedDataVersion: 3,
        generation: 9,
        rawSha256: HASH,
        sidecarRawSha256: HASH,
      }),
      value: Object.freeze({
        revision: null,
        rebased: false,
        chapterDataVersion: 3,
      }),
    });
  },
  async recover() {},
  async revokeIgnore() {},
  async write(selector, request) {
    calls.writes.push({ selector, request });
    if (request.command.kind === 'revision.create') {
      return Object.freeze({
        state: 'created',
        revision: Object.freeze({
          id: 41,
          chapterId: 7,
          baseContent: 'base',
          proposedContent: 'proposal',
          decisions: Object.freeze({}),
          status: 'pending',
          previousChapterStatus: 'writing',
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
          resolvedAt: null,
        }),
      });
    }
    if (request.command.kind === 'revision.update_decisions') {
      return Object.freeze({
        state: 'updated',
        revision: Object.freeze({
          id: 41,
          chapterId: 7,
          baseContent: 'base',
          proposedContent: 'proposal',
          decisions: Object.freeze({ 'change-0': 'accepted' }),
          status: 'pending',
          previousChapterStatus: 'writing',
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:01.000Z',
          resolvedAt: null,
        }),
      });
    }
    if (request.command.kind === 'revision.reject') {
      return Object.freeze({
        state: 'rejected',
        chapterId: 7,
        content: 'base',
        wordCount: 4,
        status: 'writing',
        dataVersion: 3,
      });
    }
    if (
      request.command.kind === 'revision.accept'
      || request.command.kind === 'revision.finalize'
    ) {
      return Object.freeze({
        state: 'accepted',
        revision: Object.freeze({ id: 41, status: 'accepted' }),
        chapter: Object.freeze({
          id: 7,
          chapterUid: CHAPTER_UID,
          content: request.command.kind === 'revision.accept'
            ? 'proposal'
            : request.command.content,
          wordCount: 8,
          status: 'accepted',
          dataVersion: 3,
        }),
      });
    }
    throw new Error(`unexpected revision command ${request.command.kind}`);
  },
});

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

test('files active revision reads through the admitted ActiveProjection authority', async (t) => {
  calls.legacyDatabase = 0;
  calls.reads.length = 0;
  const baseUrl = await listen(t);

  const response = await fetch(`${baseUrl}/novel/chapters/${CHAPTER_UID}/revisions/active`);
  const body = await response.json();

  assert.equal(calls.legacyDatabase, 0, 'files revision reads must not open the legacy project database');
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    revision: null,
    rebased: false,
    chapterDataVersion: 3,
  });
  assert.equal(calls.reads.length, 1);
  assert.deepEqual(calls.reads[0].selector, { projectUid: PROJECT_UID });
});

test('files create, decision, and reject revisions use one runtime write authority', async (t) => {
  calls.legacyDatabase = 0;
  calls.writes.length = 0;
  const baseUrl = await listen(t);
  const headers = {
    'Content-Type': 'application/json',
    'X-Mythpen-Request-Id': 'revision-request',
  };
  const requests = [
    {
      path: `/novel/chapters/${CHAPTER_UID}/revisions`,
      method: 'POST',
      body: { baseContent: 'base', proposedContent: 'proposal', base_witness: BASE_WITNESS },
      kind: 'revision.create',
    },
    {
      path: '/novel/revisions/41',
      method: 'PATCH',
      body: {
        decisions: { 'change-0': 'accepted' },
        expectedBaseContent: 'base',
        base_witness: BASE_WITNESS,
      },
      kind: 'revision.update_decisions',
    },
    {
      path: '/novel/revisions/41/reject-all',
      method: 'POST',
      body: { expectedBaseContent: 'base', base_witness: BASE_WITNESS },
      kind: 'revision.reject',
    },
    {
      path: '/novel/revisions/41/accept-all',
      method: 'POST',
      body: { expectedBaseContent: 'base', base_witness: BASE_WITNESS },
      kind: 'revision.accept',
    },
    {
      path: '/novel/revisions/41/finalize',
      method: 'POST',
      body: {
        content: 'materialized',
        expectedBaseContent: 'base',
        expectedDecisions: { 'change-0': 'accepted' },
        base_witness: BASE_WITNESS,
      },
      kind: 'revision.finalize',
    },
  ];

  const responses = [];
  for (const request of requests) {
    const response = await fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers,
      body: JSON.stringify(request.body),
    });
    responses.push({ status: response.status, body: await response.json() });
  }

  assert.equal(calls.legacyDatabase, 0, 'files revision writes must not open the legacy project database');
  assert.deepEqual(responses.map((response) => response.status), [201, 200, 200, 200, 200]);
  assert.deepEqual(calls.writes.map((entry) => entry.request.command.kind), requests.map((entry) => entry.kind));
  assert.equal(calls.reads[0]?.request.chapterUid, CHAPTER_UID);
  assert.equal(calls.writes[0]?.request.command.chapterUid, CHAPTER_UID);
  assert.deepEqual(calls.writes.map((entry) => entry.selector), requests.map(() => ({ projectUid: PROJECT_UID })));
  assert.deepEqual(calls.writes.map((entry) => entry.request.baseWitness), requests.map(() => ({
    expectedDataVersion: 0,
    generation: 9,
    rawSha256: HASH,
    sidecarRawSha256: null,
  })));
});
