'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';

const calls = {
  admissions: 0,
  copies: [],
  lists: [],
  resolutions: [],
};

function resetCalls() {
  calls.admissions = 0;
  calls.copies.length = 0;
  calls.lists.length = 0;
  calls.resolutions.length = 0;
}

const runtime = Object.freeze({
  async close() {},
  async createProject() {},
  async ignoreInPlace() {},
  async migrateProject() {},
  async read() {},
  async recover() {},
  async revokeIgnore() {},
  async write() {},
  async listDraftConflicts(selector) {
    calls.lists.push(selector);
    return Object.freeze([Object.freeze({
      conflictId: CONFLICT_ID,
      decisionEpoch: 4,
      state: 'decision_ready',
      backupAvailable: true,
    })]);
  },
  async copyDraftConflictBackup(selector, request) {
    calls.copies.push(Object.freeze({ selector, request }));
    return Object.freeze({ filename: 'draft-conflict-backup.bin' });
  },
  async resolveDraftConflict(selector, request) {
    calls.resolutions.push(Object.freeze({ selector, request }));
    if (request.decisionEpoch === 3) {
      const error = new Error('stale decision epoch');
      error.code = 'PROJECTION_STALE';
      throw error;
    }
    return Object.freeze({
      conflictId: request.conflictId,
      decisionEpoch: request.decisionEpoch,
      state: request.action === 'accept_external'
        ? 'resolved_accept_external'
        : 'resolved_apply_draft',
    });
  },
});

const database = require('../db');
const originals = Object.fromEntries([
  'inspectProjectManuscriptRoute',
  'runWithProjectInstance',
].map((key) => [key, database[key]]));

database.runWithProjectInstance = (_name, expectedInstanceId, operation) => {
  assert.equal(expectedInstanceId, PROJECT_INSTANCE_ID);
  return operation();
};
database.inspectProjectManuscriptRoute = () => {
  calls.admissions += 1;
  return Object.freeze({
    route: 'files',
    databaseFacts: Object.freeze({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
    }),
  });
};

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

async function request(baseUrl, path, {
  method = 'GET',
  body,
  requestId = 'recovery-api-request',
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Mythpen-Project-Instance': PROJECT_INSTANCE_ID,
      'X-Mythpen-Request-Id': requestId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return Object.freeze({ status: response.status, body: await response.json() });
}

test('draft conflict recovery routes forward only server-owned actions and stable identities', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const root = `/novel/manuscript/draft-conflicts`;

  const listed = await request(baseUrl, root);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, [{
    conflictId: CONFLICT_ID,
    decisionEpoch: 4,
    state: 'decision_ready',
    backupAvailable: true,
  }]);

  const copied = await request(baseUrl, `${root}/${CONFLICT_ID}/copy-backup`, {
    method: 'POST',
    body: {},
  });
  assert.equal(copied.status, 200);
  assert.deepEqual(copied.body, { filename: 'draft-conflict-backup.bin' });

  const accepted = await request(baseUrl, `${root}/${CONFLICT_ID}/accept-external`, {
    method: 'POST',
    body: { decision_epoch: 4 },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, {
    conflictId: CONFLICT_ID,
    decisionEpoch: 4,
    state: 'resolved_accept_external',
  });

  const applied = await request(baseUrl, `${root}/${CONFLICT_ID}/apply-saved-draft`, {
    method: 'POST',
    body: { decision_epoch: 5 },
  });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body, {
    conflictId: CONFLICT_ID,
    decisionEpoch: 5,
    state: 'resolved_apply_draft',
  });

  const selector = Object.freeze({ projectUid: PROJECT_UID });
  assert.deepEqual(calls.lists, [selector]);
  assert.deepEqual(calls.copies, [{
    selector,
    request: {
      conflictId: CONFLICT_ID,
      requestId: 'recovery-api-request',
    },
  }]);
  assert.deepEqual(calls.resolutions, [
    {
      selector,
      request: {
        action: 'accept_external',
        conflictId: CONFLICT_ID,
        decisionEpoch: 4,
        requestId: 'recovery-api-request',
      },
    },
    {
      selector,
      request: {
        action: 'apply_saved_draft',
        conflictId: CONFLICT_ID,
        decisionEpoch: 5,
        requestId: 'recovery-api-request',
      },
    },
  ]);
});

test('invalid and stale conflict requests fail without an erroneous completion', async (t) => {
  resetCalls();
  const baseUrl = await listen(t);
  const root = `/novel/manuscript/draft-conflicts/${CONFLICT_ID}`;

  const invalid = await request(baseUrl, `${root}/apply-saved-draft`, {
    method: 'POST',
    body: { decision_epoch: 4, action: 'accept_external' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'INVALID_PARAMS');
  assert.equal(calls.admissions, 0);
  assert.equal(calls.resolutions.length, 0);

  const stale = await request(baseUrl, `${root}/accept-external`, {
    method: 'POST',
    body: { decision_epoch: 3 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'RECOVERY_SNAPSHOT_STALE');
  assert.equal(calls.resolutions.length, 1);
});
