const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');
const {
  PUBLIC_ERROR_SPECS,
  jsonErrorMiddleware,
  jsonNotFoundMiddleware,
  sendJsonError,
  statusForErrorCode,
} = require('../json-error-middleware');

const DESIGN_STATUS_MATRIX = Object.freeze({
  CONFIG_DATABASE_BUSY: 423,
  PROJECT_WRITE_BUSY: 423,
  RECOVERY_REQUIRED: 409,
  RECOVERY_SNAPSHOT_STALE: 409,
  PROJECT_IDENTITY_REBIND_REQUIRED: 409,
  PROJECT_SCHEMA_TOO_NEW: 409,
  NATIVE_ACTIVATION_DISABLED: 409,
  NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED: 409,
  DURABILITY_UNSUPPORTED: 422,
  CONTROL_CHECKPOINT_BLOCKED: 503,
  SERVICE_SHUTTING_DOWN: 503,
  STORAGE_UNAVAILABLE: 503,
});

async function listen(app, t) {
  const server = await new Promise((resolve) => {
    const pending = app.listen(0, '127.0.0.1', () => resolve(pending));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check (${child.exitCode})\n${output.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server health check timed out\n${output.join('')}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

test('the public error specs freeze the complete durability code and status matrix', () => {
  assert.equal(Object.isFrozen(PUBLIC_ERROR_SPECS), true);
  for (const [code, status] of Object.entries(DESIGN_STATUS_MATRIX)) {
    assert.equal(statusForErrorCode(code), status, code);
    assert.equal(PUBLIC_ERROR_SPECS[code].status, status, code);
    assert.equal(Object.isFrozen(PUBLIC_ERROR_SPECS[code]), true, code);
    assert.equal(typeof PUBLIC_ERROR_SPECS[code].message, 'string', code);
    assert.equal(typeof PUBLIC_ERROR_SPECS[code].recoverable, 'boolean', code);
  }
  assert.equal(statusForErrorCode('NOT_A_PUBLIC_ERROR'), 500);
});

test('known errors use the safe JSON envelope and never echo their internal message', async (t) => {
  const app = express();
  app.get('/known/:code', (req, _res, next) => {
    const error = new Error('C:\\Users\\writer\\private-project\\secret.db');
    error.code = req.params.code;
    error.stack = 'PRIVATE STACK';
    next(error);
  });
  app.use(jsonNotFoundMiddleware);
  app.use(jsonErrorMiddleware);
  const baseUrl = await listen(app, t);

  for (const [code, status] of Object.entries(DESIGN_STATUS_MATRIX)) {
    const response = await fetch(`${baseUrl}/known/${code}`);
    assert.equal(response.status, status, code);
    assert.match(response.headers.get('content-type') || '', /^application\/json\b/i, code);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['error'], code);
    assert.deepEqual(Object.keys(body.error), ['code', 'message', 'recoverable'], code);
    assert.equal(body.error.code, code, code);
    assert.equal(body.error.message, PUBLIC_ERROR_SPECS[code].message, code);
    assert.equal(body.error.recoverable, PUBLIC_ERROR_SPECS[code].recoverable, code);
    assert.doesNotMatch(JSON.stringify(body), /private-project|secret\.db|PRIVATE STACK/i, code);
  }
});

test('malformed JSON and an unknown route have stable JSON errors without reflecting input', async (t) => {
  const app = express();
  app.use(express.json());
  app.post('/echo', (_req, res) => res.json({ ok: true }));
  app.use(jsonNotFoundMiddleware);
  app.use(jsonErrorMiddleware);
  const baseUrl = await listen(app, t);

  const malformed = await fetch(`${baseUrl}/echo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"secret":"must-not-return",',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: {
      code: 'INVALID_JSON',
      message: PUBLIC_ERROR_SPECS.INVALID_JSON.message,
      recoverable: PUBLIC_ERROR_SPECS.INVALID_JSON.recoverable,
    },
  });

  const missing = await fetch(`${baseUrl}/not-a-real-route`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type') || '', /^application\/json\b/i);
  assert.deepEqual(await missing.json(), {
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: PUBLIC_ERROR_SPECS.ROUTE_NOT_FOUND.message,
      recoverable: PUBLIC_ERROR_SPECS.ROUTE_NOT_FOUND.recoverable,
    },
  });
});

test('diagnostics exact-object endpoints classify valid non-object JSON as INVALID_PARAMS only', async (t) => {
  const app = express();
  app.use(express.json());
  app.post('/api/projects/by-name/:name/diagnostics/recover', (_req, res) => {
    sendJsonError(res, 'INVALID_PARAMS');
  });
  app.post('/api/projects/by-name/:name/diagnostics/export', (_req, res) => {
    sendJsonError(res, 'INVALID_PARAMS');
  });
  app.post('/api/not-diagnostics', (_req, res) => res.json({ ok: true }));
  app.use(jsonNotFoundMiddleware);
  app.use(jsonErrorMiddleware);
  const baseUrl = await listen(app, t);

  for (const [suffix, rawBody] of [
    ['recover', 'null'],
    ['recover', 'true'],
    ['recover', '42'],
    ['recover', '"string"'],
    ['export', '[]'],
  ]) {
    const response = await fetch(
      `${baseUrl}/api/projects/by-name/diagnostics/diagnostics/${suffix}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      },
    );
    assert.equal(response.status, 400, rawBody);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'INVALID_PARAMS',
        message: PUBLIC_ERROR_SPECS.INVALID_PARAMS.message,
        recoverable: true,
      },
    }, rawBody);
  }

  const malformedDiagnostics = await fetch(
    `${baseUrl}/api/projects/by-name/diagnostics/diagnostics/recover`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"action":',
    },
  );
  assert.equal(malformedDiagnostics.status, 400);
  assert.equal((await malformedDiagnostics.json()).error.code, 'INVALID_JSON');

  const primitiveElsewhere = await fetch(`${baseUrl}/api/not-diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'null',
  });
  assert.equal(primitiveElsewhere.status, 400);
  assert.equal((await primitiveElsewhere.json()).error.code, 'INVALID_JSON');
});

test('unknown exceptions and unknown explicit codes collapse to INTERNAL_ERROR', async (t) => {
  const app = express();
  app.get('/unknown', (_req, _res, next) => {
    const error = new Error('api-key=super-secret C:\\private\\novel.db');
    error.status = 418;
    error.stack = 'SECRET STACK';
    next(error);
  });
  app.get('/explicit-known', (_req, res) => {
    sendJsonError(res, 'INVALID_PARAMS', '公开的参数说明');
  });
  app.get('/explicit-unknown', (_req, res) => {
    sendJsonError(res, 'OS_EIO', 'C:\\private\\novel.db api-key=super-secret');
  });
  app.use(jsonNotFoundMiddleware);
  app.use(jsonErrorMiddleware);
  const baseUrl = await listen(app, t);

  const unknown = await fetch(`${baseUrl}/unknown`);
  assert.equal(unknown.status, 500);
  assert.deepEqual(await unknown.json(), {
    error: { code: 'INTERNAL_ERROR', message: '服务内部错误', recoverable: false },
  });

  const explicitKnown = await fetch(`${baseUrl}/explicit-known`);
  assert.equal(explicitKnown.status, 400);
  assert.deepEqual(await explicitKnown.json(), {
    error: { code: 'INVALID_PARAMS', message: '公开的参数说明', recoverable: true },
  });

  const explicitUnknown = await fetch(`${baseUrl}/explicit-unknown`);
  assert.equal(explicitUnknown.status, 500);
  assert.deepEqual(await explicitUnknown.json(), {
    error: { code: 'INTERNAL_ERROR', message: '服务内部错误', recoverable: false },
  });
});

test('headers-sent errors are delegated without a second response write', () => {
  const error = new Error('stream failed after headers');
  let delegated;
  let statusCalls = 0;
  let jsonCalls = 0;
  const response = {
    headersSent: true,
    status() {
      statusCalls += 1;
      return this;
    },
    json() {
      jsonCalls += 1;
    },
  };

  jsonErrorMiddleware(error, {}, response, (received) => {
    delegated = received;
  });

  assert.equal(delegated, error);
  assert.equal(statusCalls, 0);
  assert.equal(jsonCalls, 0);
});

test('the production server installs JSON parsing, 404, and final error middleware', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-json-errors-'));
  const port = await reservePort();
  const output = [];
  const child = spawn(process.execPath, [path.join('server', 'index.js')], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, MYTHPEN_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    await stopChild(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/api/health`, child, output);

  const malformed = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"messages":["secret-body",',
  });
  assert.equal(malformed.status, 400, output.join(''));
  assert.match(malformed.headers.get('content-type') || '', /^application\/json\b/i);
  assert.deepEqual(await malformed.json(), {
    error: {
      code: 'INVALID_JSON',
      message: PUBLIC_ERROR_SPECS.INVALID_JSON.message,
      recoverable: true,
    },
  });

  const missing = await fetch(`${baseUrl}/not-a-production-route`);
  assert.equal(missing.status, 404, output.join(''));
  assert.match(missing.headers.get('content-type') || '', /^application\/json\b/i);
  assert.deepEqual(await missing.json(), {
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: PUBLIC_ERROR_SPECS.ROUTE_NOT_FOUND.message,
      recoverable: false,
    },
  });
});

test('AI project instance middleware delegates database errors to the final middleware', (t) => {
  const database = require('../db');
  const { bindAiProjectInstance } = require('../project-instance-middleware');
  const originalCapture = database.captureProjectInstance;
  const expected = Object.assign(new Error('private project path'), {
    code: 'PROJECT_INSTANCE_MISMATCH',
    status: 418,
  });
  database.captureProjectInstance = () => {
    throw expected;
  };
  t.after(() => {
    database.captureProjectInstance = originalCapture;
  });

  let responseWrites = 0;
  let delegated;
  bindAiProjectInstance({
    body: { project: 'project' },
    get: () => 'stale-instance',
  }, {
    status() {
      responseWrites += 1;
      return this;
    },
    json() {
      responseWrites += 1;
    },
  }, (error) => {
    delegated = error;
  });

  assert.equal(delegated, expected);
  assert.equal(responseWrites, 0);
});

test('production routes contain no legacy or raw-message JSON error shapes', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'api.js'), 'utf8');
  assert.doesNotMatch(source, /error\s*:\s*\{\s*message\s*:/);
  assert.doesNotMatch(source, /error\s*:\s*(?:e|err|error)\.message/);
  assert.doesNotMatch(source, /\.json\(\{\s*error\s*:\s*['"`]/);
  const incompleteInlineEnvelope = source.split(/\r?\n/).find((line) => (
    /error\s*:\s*\{/.test(line)
    && /\bcode\s*:/.test(line)
    && /\bmessage\s*:/.test(line)
    && !/\brecoverable\s*:/.test(line)
  ));
  assert.equal(incompleteInlineEnvelope, undefined);
});
