const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');
const db = require('../db');
const {
  jsonErrorMiddleware,
  jsonNotFoundMiddleware,
} = require('../json-error-middleware');
const apiRouter = require('../routes/api');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

const SNAPSHOT = '1'.repeat(64);

function diagnosticsFixture(overrides = {}) {
  return {
    state: 'isolated',
    reasonCode: 'V1_PUBLICATION_FORWARD_RECOVERABLE',
    protocol: 'sqljs-publication-v1',
    backend: 'sqljs-v1',
    schema: 10,
    triggerVersion: null,
    expectedTriggerSetDigest: null,
    projectMetaTriggerSetDigest: null,
    observedTriggerSetDigest: null,
    dbIdentity: { dev: '1', ino: '2' },
    expectedIdentity: { dev: '1', ino: '2' },
    projectInstanceIdSha256: '2'.repeat(64),
    currentSeq: null,
    expectedSeq: null,
    controlStore: {
      tail: { seq: 3, digest: '3'.repeat(64) },
      checkpoint: null,
      events: [{
        seq: 3,
        type: 'sqlite.publish.prepared',
        digest: '3'.repeat(64),
        prevDigest: '4'.repeat(64),
      }],
    },
    integrity: { integrityCheck: 'ok', foreignKeyCheck: 'ok' },
    platformCapabilities: {
      backend: 'win32',
      exclusiveLease: true,
      directoryFsync: true,
      atomicReplace: true,
      verifiedAbsentInstall: true,
    },
    canAutoRecover: true,
    canAdoptIdentity: false,
    recommendedAction: 'recover_v1_publication',
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

function replaceProperty(t, object, key, value) {
  const hadProperty = Object.prototype.hasOwnProperty.call(object, key);
  const previous = object[key];
  object[key] = value;
  t.after(() => {
    if (hadProperty) object[key] = previous;
    else delete object[key];
  });
}

async function listen(t) {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(jsonNotFoundMiddleware);
  app.use(jsonErrorMiddleware);
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}/api`;
}

async function callApi(baseUrl, pathName, options = {}) {
  const request = { method: options.method || 'GET', headers: { ...options.headers } };
  if (Object.prototype.hasOwnProperty.call(options, 'body')) {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${pathName}`, request);
  return {
    status: response.status,
    body: await response.json(),
  };
}

function snapshotTree(root) {
  const rows = [];
  function visit(current, relative) {
    const stats = fs.lstatSync(current, { bigint: true });
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    rows.push({
      relative,
      type,
      dev: String(stats.dev),
      ino: String(stats.ino),
      length: String(stats.size),
      sha256: type === 'file'
        ? crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex')
        : null,
    });
    if (type === 'directory') {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? path.join(relative, name) : name);
      }
    }
  }
  visit(root, '');
  return rows;
}

function codedError(code, secret) {
  const error = new Error(secret);
  error.code = code;
  return error;
}

test('GET diagnostics returns the exact stable DTO without changing the evidence tree', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-diagnostics-api-get-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'control'));
  fs.writeFileSync(path.join(root, 'project.mythpen.db'), 'private manuscript bytes');
  fs.writeFileSync(path.join(root, 'control', 'event.json'), '{"private":"event"}');

  const diagnostics = diagnosticsFixture();
  let inspectCalls = 0;
  let hashCalls = 0;
  replaceProperty(t, db, 'inspectRegisteredProject', (name) => {
    inspectCalls += 1;
    assert.equal(name, 'diagnostics');
    return diagnostics;
  });
  replaceProperty(t, db, 'recoverRegisteredProject', () => {
    throw new Error('GET must not recover');
  });
  replaceProperty(t, db, 'getRegisteredProjectDatabaseSha256', () => {
    hashCalls += 1;
    return 'a'.repeat(64);
  });

  const baseUrl = await listen(t);
  const before = snapshotTree(root);
  const first = await callApi(baseUrl, '/projects/by-name/diagnostics/diagnostics');
  const second = await callApi(baseUrl, '/projects/by-name/diagnostics/diagnostics');

  assert.equal(first.status, 200);
  assert.deepEqual(first.body, diagnostics);
  assert.deepEqual(second, first);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(inspectCalls, 2);
  assert.equal(hashCalls, 0);

  const unexpectedQuery = await callApi(
    baseUrl,
    '/projects/by-name/diagnostics/diagnostics?path=C%3A%5Cprivate%5Cnovel.db',
  );
  assert.equal(unexpectedQuery.status, 400);
  assert.equal(unexpectedQuery.body.error.code, 'INVALID_PARAMS');
  assert.equal(inspectCalls, 2);
});

test('recover route rejects non-exact requests before db and preserves stable recovery errors', async (t) => {
  const ready = diagnosticsFixture({
    state: 'ready',
    reasonCode: null,
    canAutoRecover: false,
    recommendedAction: null,
    snapshot: '9'.repeat(64),
  });
  let recoveryCalls = 0;
  let recoverySideEffects = 0;
  replaceProperty(t, db, 'recoverRegisteredProject', (_name, request) => {
    recoveryCalls += 1;
    if (request.action !== 'recover_v1_publication') {
      throw codedError('NATIVE_ACTIVATION_DISABLED', 'C:\\private\\disabled secret');
    }
    if (request.snapshot === '2'.repeat(64)) {
      throw codedError('RECOVERY_SNAPSHOT_STALE', 'C:\\private\\stale secret');
    }
    if (request.snapshot === '3'.repeat(64)) {
      throw codedError('PROJECT_WRITE_BUSY', 'C:\\private\\busy secret');
    }
    recoverySideEffects += 1;
    return ready;
  });
  const baseUrl = await listen(t);
  const endpoint = '/projects/by-name/recover/diagnostics/recover';

  const invalidRequests = [
    {},
    { action: 'recover_v1_publication' },
    { action: 'unknown', snapshot: SNAPSHOT },
    { action: 'recover_v1_publication', snapshot: 'A'.repeat(64) },
    { action: 'recover_v1_publication', snapshot: [SNAPSHOT] },
    { action: 'recover_v1_publication', snapshot: SNAPSHOT, path: 'C:\\private\\novel.db' },
    null,
    [],
  ];
  for (const body of invalidRequests) {
    const response = await callApi(baseUrl, endpoint, { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'INVALID_PARAMS');
  }
  const missingBody = await callApi(baseUrl, endpoint, { method: 'POST' });
  assert.equal(missingBody.status, 400);
  assert.equal(missingBody.body.error.code, 'INVALID_PARAMS');
  const unexpectedQuery = await callApi(`${baseUrl}`, `${endpoint}?importId=private`, {
    method: 'POST',
    body: { action: 'recover_v1_publication', snapshot: SNAPSHOT },
  });
  assert.equal(unexpectedQuery.status, 400);
  assert.equal(recoveryCalls, 0);

  for (const action of ['recover_transaction', 'adopt_same_path_identity']) {
    const disabled = await callApi(baseUrl, endpoint, {
      method: 'POST',
      body: { action, snapshot: SNAPSHOT },
    });
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.error.code, 'NATIVE_ACTIVATION_DISABLED');
    assert.doesNotMatch(JSON.stringify(disabled.body), /private|secret/i);
  }
  for (const [snapshot, code, status] of [
    ['2'.repeat(64), 'RECOVERY_SNAPSHOT_STALE', 409],
    ['3'.repeat(64), 'PROJECT_WRITE_BUSY', 423],
  ]) {
    const failure = await callApi(baseUrl, endpoint, {
      method: 'POST',
      body: { action: 'recover_v1_publication', snapshot },
    });
    assert.equal(failure.status, status);
    assert.equal(failure.body.error.code, code);
    assert.doesNotMatch(JSON.stringify(failure.body), /private|secret/i);
  }
  assert.equal(recoverySideEffects, 0);

  const success = await callApi(baseUrl, endpoint, {
    method: 'POST',
    body: { action: 'recover_v1_publication', snapshot: SNAPSHOT },
  });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, ready);
  assert.equal(recoveryCalls, 5);
  assert.equal(recoverySideEffects, 1);
});

test('unregistered projects win over Stage A disabled recovery actions', async (t) => {
  withIsolatedDataDir(t);
  await db.initDatabase();
  const baseUrl = await listen(t);
  const endpoint = '/projects/by-name/not-registered/diagnostics/recover';

  for (const action of ['recover_transaction', 'adopt_same_path_identity']) {
    const response = await callApi(baseUrl, endpoint, {
      method: 'POST',
      body: { action, snapshot: SNAPSHOT },
    });
    assert.equal(response.status, 404, action);
    assert.deepEqual(response.body, {
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: '项目不存在',
        recoverable: true,
      },
    });
  }
});

test('export is the only route that hashes the database and publishes an opaque exact manifest', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-diagnostics-api-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exportDir = path.join(root, 'fixed-exports');
  const expectedDiagnostics = diagnosticsFixture();
  const diagnostics = {
    ...expectedDiagnostics,
    path: path.join(root, 'private-project.mythpen.db'),
    chapterBody: 'private manuscript bytes',
    originalInstanceId: 'raw-instance-secret',
    futureField: 'future-secret',
    controlStore: {
      ...expectedDiagnostics.controlStore,
      rawPayload: { chapterBody: 'private control payload' },
      events: expectedDiagnostics.controlStore.events.map((event) => ({
        ...event,
        path: path.join(root, 'private-event.json'),
        rawPayload: 'raw-event-secret',
      })),
    },
  };
  const ready = diagnosticsFixture({
    state: 'ready',
    reasonCode: null,
    canAutoRecover: false,
    recommendedAction: null,
    snapshot: '8'.repeat(64),
  });
  let inspectCalls = 0;
  let recoveryCalls = 0;
  let hashCalls = 0;
  replaceProperty(t, db, 'inspectRegisteredProject', (name) => {
    inspectCalls += 1;
    assert.equal(name, 'private-project-name');
    return diagnostics;
  });
  replaceProperty(t, db, 'recoverRegisteredProject', () => {
    recoveryCalls += 1;
    return ready;
  });
  replaceProperty(t, db, 'getRegisteredProjectDatabaseSha256', (name) => {
    hashCalls += 1;
    assert.equal(name, 'private-project-name');
    return 'a'.repeat(64);
  });
  replaceProperty(t, db, 'getExportDir', () => exportDir);
  const baseUrl = await listen(t);

  const getResponse = await callApi(
    baseUrl,
    '/projects/by-name/private-project-name/diagnostics',
  );
  assert.equal(getResponse.status, 200);
  const recoverResponse = await callApi(
    baseUrl,
    '/projects/by-name/private-project-name/diagnostics/recover',
    { method: 'POST', body: { action: 'recover_v1_publication', snapshot: SNAPSHOT } },
  );
  assert.equal(recoverResponse.status, 200);
  assert.equal(hashCalls, 0);

  const response = await callApi(
    baseUrl,
    '/projects/by-name/private-project-name/diagnostics/export',
    { method: 'POST', body: {} },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body), ['filename']);
  assert.match(
    response.body.filename,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mythpen-diagnostics\.json$/,
  );
  assert.equal(inspectCalls, 2);
  assert.equal(recoveryCalls, 1);
  assert.equal(hashCalls, 1);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(exportDir, response.body.filename), 'utf8'),
  );
  assert.deepEqual(Object.keys(manifest).sort(), [
    'currentDatabaseSha256',
    'diagnostics',
    'format',
    'formatVersion',
  ]);
  assert.equal(manifest.format, 'mythpen-diagnostics');
  assert.equal(manifest.formatVersion, 1);
  assert.deepEqual(manifest.diagnostics, expectedDiagnostics);
  assert.equal(manifest.currentDatabaseSha256, 'a'.repeat(64));
  const serialized = JSON.stringify({ response: response.body, manifest });
  assert.doesNotMatch(serialized, /private-project-name|manuscript bytes|api.?key/i);
  assert.equal(serialized.includes(root), false);

  for (const body of [undefined, null, [], { fileName: 'chosen.json' }]) {
    const options = { method: 'POST' };
    if (body !== undefined) options.body = body;
    const invalid = await callApi(
      baseUrl,
      '/projects/by-name/private-project-name/diagnostics/export',
      options,
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_PARAMS');
  }
  const queryInjection = await callApi(
    baseUrl,
    '/projects/by-name/private-project-name/diagnostics/export?bundleLocator=private',
    { method: 'POST', body: {} },
  );
  assert.equal(queryInjection.status, 400);
  assert.equal(hashCalls, 1);
});

test('unknown diagnostics export failures use the final INTERNAL_ERROR JSON envelope', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-diagnostics-api-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notDirectory = path.join(root, 'C-private-secret-export-target');
  fs.writeFileSync(notDirectory, 'not a directory');
  replaceProperty(t, db, 'inspectRegisteredProject', () => diagnosticsFixture());
  replaceProperty(t, db, 'getRegisteredProjectDatabaseSha256', () => 'b'.repeat(64));
  replaceProperty(t, db, 'getExportDir', () => notDirectory);
  const baseUrl = await listen(t);

  const response = await callApi(
    baseUrl,
    '/projects/by-name/export/diagnostics/export',
    { method: 'POST', body: {} },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: { code: 'INTERNAL_ERROR', message: '服务内部错误', recoverable: false },
  });
  assert.doesNotMatch(JSON.stringify(response.body), /private|secret|ENOTDIR|EEXIST/i);
});
