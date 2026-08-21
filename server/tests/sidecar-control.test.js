const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const VALID_NONCE = `${'00'.repeat(31)}01`;
const OTHER_NONCE = `${'00'.repeat(31)}02`;

function assertControlError(action, code) {
  assert.throws(action, (error) => error?.code === code);
}

function createControlFrameCollector(stream) {
  let buffered = '';
  const frames = [];
  const waiters = [];
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.type !== frame.type) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(frame);
      }
    }
  });
  return {
    frames,
    waitFor(type, timeoutMs = 2_000) {
      const existing = frames.find((frame) => frame.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, type, timeout: null };
        waiter.timeout = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createAuthenticatedHealthApp(instanceNonceMiddleware, onListen = () => {}) {
  return {
    listen(port, host, callback) {
      onListen();
      const server = http.createServer((req, res) => {
        req.get = (name) => req.headers[String(name).toLowerCase()];
        res.status = (status) => {
          res.statusCode = status;
          return res;
        };
        res.json = (body) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
          return res;
        };
        instanceNonceMiddleware(req, res, () => {
          if (req.method === 'GET' && req.url === '/api/health') {
            res.statusCode = 200;
            res.json({ status: 'ok' });
            return;
          }
          res.statusCode = 404;
          res.end();
        });
      });
      return server.listen(port, host, callback);
    },
  };
}

test('build info is compile-time shaped and runtime activation env cannot change off mode', (t) => {
  const modulePath = require.resolve('../build-info');
  const previousMode = process.env.MYTHPEN_NATIVE_ACTIVATION_MODE;
  process.env.MYTHPEN_NATIVE_ACTIVATION_MODE = 'production';
  delete require.cache[modulePath];
  t.after(() => {
    delete require.cache[modulePath];
    if (previousMode === undefined) delete process.env.MYTHPEN_NATIVE_ACTIVATION_MODE;
    else process.env.MYTHPEN_NATIVE_ACTIVATION_MODE = previousMode;
  });

  const { getBuildInfo } = require('../build-info');
  const info = getBuildInfo();

  assert.deepEqual(Object.keys(info), [
    'nativeActivationMode',
    'sourceCommit',
    'targetTriple',
    'manuscriptLifecycleLease',
    'manuscriptChangeNotification',
  ]);
  assert.equal(info.nativeActivationMode, 'off');
  assert.match(info.sourceCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.match(info.targetTriple, /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/);
  assert.equal(Object.isFrozen(info), true);
});

test('manuscript capability build-info source contract', () => {
  const { getBuildInfo } = require('../build-info');
  const { encodeControlFrame } = require('../sidecar-control');
  const base = {
    childPid: 123,
    nonceDigest: 'b'.repeat(64),
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  };
  const payloadFor = (nativeActivationMode, capability) => ({
    ...base,
    nativeActivationMode,
    manuscriptLifecycleLease: capability,
    manuscriptChangeNotification: capability,
  });

  assert.deepEqual(getBuildInfo(), {
    nativeActivationMode: 'off',
    sourceCommit: '0'.repeat(40),
    targetTriple: 'unknown-unknown-unknown',
    manuscriptLifecycleLease: false,
    manuscriptChangeNotification: false,
  });
  assert.doesNotThrow(() => encodeControlFrame('build.info', payloadFor('off', false)));
  assert.doesNotThrow(() => encodeControlFrame('build.info', payloadFor('fixture_only', false)));
  assert.doesNotThrow(() => encodeControlFrame('build.info', payloadFor('production', true)));

  for (const invalid of [
    { ...payloadFor('off', false), manuscriptLifecycleLease: true },
    { ...payloadFor('fixture_only', false), manuscriptChangeNotification: true },
    { ...payloadFor('production', true), manuscriptLifecycleLease: false },
    { ...payloadFor('production', true), manuscriptChangeNotification: 'true' },
  ]) {
    assertControlError(
      () => encodeControlFrame('build.info', invalid),
      'CONTROL_INVALID_FRAME',
    );
  }
  const missing = payloadFor('production', true);
  delete missing.manuscriptChangeNotification;
  assertControlError(
    () => encodeControlFrame('build.info', missing),
    'CONTROL_INVALID_FRAME',
  );
});

test('direct dev port accepts only canonical decimal loopback ports', () => {
  const { parseDirectPort } = require('../server-runtime');
  assert.equal(parseDirectPort(undefined), 3001);
  assert.equal(parseDirectPort('0'), 0);
  assert.equal(parseDirectPort('65535'), 65535);
  for (const invalid of ['', ' 3001', '+3001', '03', '1.5', '65536', '3001x']) {
    assert.throws(() => parseDirectPort(invalid), /canonical decimal integer/);
  }
});

test('bootstrap parser enforces exact UTF-8 NDJSON shape and retains only nonce proof', () => {
  const {
    MAX_CONTROL_FRAME_BYTES,
    parseBootstrapFrame,
  } = require('../sidecar-control');
  const line = Buffer.from(JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'bootstrap',
    nonce: VALID_NONCE,
  }));

  const authenticator = parseBootstrapFrame(line);
  assert.equal(
    authenticator.nonceDigest,
    createHash('sha256').update(Buffer.from(VALID_NONCE, 'hex')).digest('hex'),
  );
  assert.equal(authenticator.authenticate(VALID_NONCE), true);
  assert.equal(authenticator.authenticate(OTHER_NONCE), false);
  assert.doesNotMatch(JSON.stringify(authenticator), new RegExp(VALID_NONCE));

  assertControlError(
    () => parseBootstrapFrame(Buffer.from(
      `{"channel":"mythpen.sidecar.v1","type":"bootstrap","nonce":"${VALID_NONCE}","nonce":"${OTHER_NONCE}"}`,
    )),
    'CONTROL_INVALID_FRAME',
  );
  assertControlError(
    () => parseBootstrapFrame(Buffer.from(JSON.stringify({
      channel: 'mythpen.sidecar.v1',
      type: 'bootstrap',
      nonce: VALID_NONCE,
      extra: true,
    }))),
    'CONTROL_INVALID_FRAME',
  );
  assertControlError(
    () => parseBootstrapFrame(Buffer.from('[null]')),
    'CONTROL_INVALID_FRAME',
  );
  assertControlError(
    () => parseBootstrapFrame(Buffer.from([0xc3, 0x28])),
    'CONTROL_INVALID_FRAME',
  );
  assertControlError(
    () => parseBootstrapFrame(Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 1, 0x20)),
    'CONTROL_INVALID_FRAME',
  );
});

test('authenticated commands strip nonce and reject cross-instance, extra, and unsafe attempts', () => {
  const {
    parseAuthenticatedCommandFrame,
    parseBootstrapFrame,
  } = require('../sidecar-control');
  const authenticator = parseBootstrapFrame(Buffer.from(JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'bootstrap',
    nonce: VALID_NONCE,
  })));
  const parse = (frame) => parseAuthenticatedCommandFrame(
    Buffer.from(JSON.stringify(frame)),
    authenticator,
  );

  assert.deepEqual(parse({
    channel: 'mythpen.sidecar.v1',
    type: 'build.info.request',
    nonce: VALID_NONCE,
  }), { type: 'build.info.request' });
  assert.deepEqual(parse({
    channel: 'mythpen.sidecar.v1',
    type: 'shutdown.request',
    nonce: VALID_NONCE,
    attemptSeq: 1,
  }), { type: 'shutdown.request', attemptSeq: 1 });

  assertControlError(() => parse({
    channel: 'mythpen.sidecar.v1',
    type: 'shutdown.request',
    nonce: OTHER_NONCE,
    attemptSeq: 1,
  }), 'CONTROL_AUTH_FAILED');
  assertControlError(() => parse({
    channel: 'mythpen.sidecar.v1',
    type: 'shutdown.cancel',
    nonce: VALID_NONCE,
    attemptSeq: 0,
  }), 'CONTROL_ATTEMPT_INVALID');
  assertControlError(() => parse({
    channel: 'mythpen.sidecar.v1',
    type: 'shutdown.continue_wait',
    nonce: VALID_NONCE,
    attemptSeq: Number.MAX_SAFE_INTEGER + 1,
  }), 'CONTROL_ATTEMPT_INVALID');
  assertControlError(() => parse({
    channel: 'mythpen.sidecar.v1',
    type: 'build.info.request',
    nonce: VALID_NONCE,
    attemptSeq: 1,
  }), 'CONTROL_INVALID_FRAME');
});

test('outbound frames are exact NDJSON and never accept unlisted payload fields', () => {
  const { encodeControlFrame } = require('../sidecar-control');
  const payload = {
    childPid: 123,
    host: '127.0.0.1',
    port: 54321,
    nonceDigest: 'b'.repeat(64),
    nativeActivationMode: 'off',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
    manuscriptLifecycleLease: false,
    manuscriptChangeNotification: false,
  };

  assert.equal(
    encodeControlFrame('ready', payload),
    `${JSON.stringify({ channel: 'mythpen.sidecar.v1', type: 'ready', ...payload })}\n`,
  );
  assertControlError(
    () => encodeControlFrame('ready', { ...payload, nonce: VALID_NONCE }),
    'CONTROL_INVALID_FRAME',
  );
  assert.equal(
    encodeControlFrame('control.error', { code: 'CONTROL_AUTH_FAILED' }),
    '{"channel":"mythpen.sidecar.v1","type":"control.error","code":"CONTROL_AUTH_FAILED"}\n',
  );
});

test('sidecar build metadata accepts exactly the compile-time native activation mode table', () => {
  const { encodeControlFrame } = require('../sidecar-control');
  const ready = {
    childPid: 123,
    host: '127.0.0.1',
    port: 54321,
    nonceDigest: 'b'.repeat(64),
    nativeActivationMode: 'off',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
    manuscriptLifecycleLease: false,
    manuscriptChangeNotification: false,
  };
  const buildInfo = { ...ready };
  delete buildInfo.host;
  delete buildInfo.port;

  for (const nativeActivationMode of ['off', 'fixture_only', 'production']) {
    const capability = nativeActivationMode === 'production';
    assert.doesNotThrow(() => encodeControlFrame('ready', {
      ...ready,
      nativeActivationMode,
      manuscriptLifecycleLease: capability,
      manuscriptChangeNotification: capability,
    }));
    assert.doesNotThrow(() => encodeControlFrame('build.info', {
      ...buildInfo,
      nativeActivationMode,
      manuscriptLifecycleLease: capability,
      manuscriptChangeNotification: capability,
    }));
  }
  for (const payload of [ready, buildInfo]) {
    const type = Object.hasOwn(payload, 'host') ? 'ready' : 'build.info';
    assertControlError(() => encodeControlFrame(type, {
      ...payload,
      nativeActivationMode: 'fixture',
    }), 'CONTROL_INVALID_FRAME');
  }
});

test('desktop HTTP nonce middleware is constant-shape, while CORS preflight passes through', () => {
  const {
    createInstanceNonceMiddleware,
    parseBootstrapFrame,
  } = require('../sidecar-control');
  const authenticator = parseBootstrapFrame(Buffer.from(JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'bootstrap',
    nonce: VALID_NONCE,
  })));
  const middleware = createInstanceNonceMiddleware(authenticator);

  const invoke = (method, nonce) => {
    let nextCalls = 0;
    const observation = { body: null, status: null };
    const response = {
      json(body) {
        observation.body = body;
        return this;
      },
      status(status) {
        observation.status = status;
        return this;
      },
    };
    middleware({ method, get: () => nonce }, response, () => { nextCalls += 1; });
    return { ...observation, nextCalls };
  };

  assert.deepEqual(invoke('GET', VALID_NONCE), {
    body: null,
    status: null,
    nextCalls: 1,
  });
  assert.deepEqual(invoke('GET', OTHER_NONCE), {
    body: {
      error: {
        code: 'INSTANCE_NONCE_INVALID',
        message: '实例认证失败',
        recoverable: false,
      },
    },
    status: 401,
    nextCalls: 0,
  });
  assert.deepEqual(invoke('OPTIONS', undefined), {
    body: null,
    status: null,
    nextCalls: 1,
  });
});

test('desktop runtime has zero startup side effects before bootstrap and then reports actual loopback ready', async (t) => {
  const { startServerRuntime } = require('../server-runtime');
  const input = new PassThrough();
  const output = new PassThrough();
  const collector = createControlFrameCollector(output);
  const order = [];
  const calls = {
    capabilities: 0,
    init: 0,
    inspection: 0,
    listen: 0,
  };
  let runtime;
  t.after(async () => {
    if (runtime?.server?.listening) await closeServer(runtime.server);
    input.destroy();
    output.destroy();
  });

  const runtimePromise = startServerRuntime({
    childPid: 321,
    createApp({ instanceNonceMiddleware }) {
      return createAuthenticatedHealthApp(instanceNonceMiddleware, () => {
        calls.listen += 1;
        order.push('listen');
      });
    },
    detectCapabilities() {
      calls.capabilities += 1;
      order.push('capabilities');
      return { supported: true };
    },
    assertDurabilitySupported(capabilities) {
      return capabilities;
    },
    configureRecoveryDiagnosticsCapabilities() {
      order.push('configure');
    },
    env: {
      MYTHPEN_DESKTOP_OWNED: '1',
      PORT: '0',
    },
    initDatabase: async () => {
      calls.init += 1;
      order.push('init');
    },
    input,
    inspectProjectDatabasesAtStartup() {
      calls.inspection += 1;
      order.push('inspection');
      return new Map();
    },
    output,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, {
    capabilities: 0,
    init: 0,
    inspection: 0,
    listen: 0,
  });
  assert.deepEqual(collector.frames, []);

  input.write(`${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'bootstrap',
    nonce: VALID_NONCE,
  })}\n`);
  runtime = await runtimePromise;
  const ready = await collector.waitFor('ready');

  assert.deepEqual(order, [
    'capabilities',
    'configure',
    'init',
    'inspection',
    'listen',
  ]);
  assert.equal(ready.childPid, 321);
  assert.equal(ready.host, '127.0.0.1');
  assert.equal(ready.port, runtime.server.address().port);
  assert.ok(ready.port > 0);
  assert.equal(ready.nativeActivationMode, 'off');
  assert.doesNotMatch(output.readableBuffer?.toString?.() || JSON.stringify(collector.frames), new RegExp(VALID_NONCE));

  const baseUrl = `http://127.0.0.1:${ready.port}`;
  const denied = await fetch(`${baseUrl}/api/health`, {
    headers: { 'X-Mythpen-Instance-Nonce': OTHER_NONCE },
  });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'INSTANCE_NONCE_INVALID');
  const accepted = await fetch(`${baseUrl}/api/health`, {
    headers: { 'X-Mythpen-Instance-Nonce': VALID_NONCE },
  });
  assert.equal(accepted.status, 200);

  input.write(`${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'build.info.request',
    nonce: VALID_NONCE,
  })}\n`);
  const buildInfo = await collector.waitFor('build.info');
  assert.deepEqual(
    {
      childPid: buildInfo.childPid,
      nativeActivationMode: buildInfo.nativeActivationMode,
      nonceDigest: buildInfo.nonceDigest,
      sourceCommit: buildInfo.sourceCommit,
      targetTriple: buildInfo.targetTriple,
      manuscriptLifecycleLease: buildInfo.manuscriptLifecycleLease,
      manuscriptChangeNotification: buildInfo.manuscriptChangeNotification,
    },
    {
      childPid: ready.childPid,
      nativeActivationMode: ready.nativeActivationMode,
      nonceDigest: ready.nonceDigest,
      sourceCommit: ready.sourceCommit,
      targetTriple: ready.targetTriple,
      manuscriptLifecycleLease: ready.manuscriptLifecycleLease,
      manuscriptChangeNotification: ready.manuscriptChangeNotification,
    },
  );

  input.write(`${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'shutdown.request',
    nonce: VALID_NONCE,
    attemptSeq: 1,
  })}\n`);
  const complete = await collector.waitFor('shutdown.complete');
  assert.equal(complete.attemptSeq, 1);
  assert.equal(complete.outcome, 'clean');
  assert.equal(runtime.server.listening, false);
});

test('a non-bootstrap first control frame fails closed without capability, storage, inspection, or listen', async () => {
  const { startServerRuntime } = require('../server-runtime');
  const input = new PassThrough();
  const output = new PassThrough();
  const collector = createControlFrameCollector(output);
  const calls = [];
  const runtimePromise = startServerRuntime({
    createApp() {
      calls.push('app');
      return createAuthenticatedHealthApp((_req, _res, next) => next());
    },
    detectCapabilities() {
      calls.push('capabilities');
      return {};
    },
    assertDurabilitySupported(value) {
      return value;
    },
    configureRecoveryDiagnosticsCapabilities() {
      calls.push('configure');
    },
    env: { MYTHPEN_DESKTOP_OWNED: '1', PORT: '0' },
    initDatabase: async () => { calls.push('init'); },
    input,
    inspectProjectDatabasesAtStartup() {
      calls.push('inspection');
      return new Map();
    },
    output,
  });

  input.end(`${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'build.info.request',
    nonce: VALID_NONCE,
  })}\n`);
  await assert.rejects(
    runtimePromise,
    (error) => error?.code === 'CONTROL_BOOTSTRAP_REQUIRED',
  );
  assert.equal((await collector.waitFor('control.error')).code, 'CONTROL_BOOTSTRAP_REQUIRED');
  assert.deepEqual(calls, []);
  assert.doesNotMatch(JSON.stringify(collector.frames), new RegExp(VALID_NONCE));
  output.destroy();
});

test('an oversized split command is discarded through its physical LF and reports only once', async () => {
  const {
    MAX_CONTROL_FRAME_BYTES,
    createSidecarControlChannel,
  } = require('../sidecar-control');
  const input = new PassThrough();
  const output = new PassThrough();
  const collector = createControlFrameCollector(output);
  const commands = [];
  const channel = createSidecarControlChannel({ input, output });
  input.write(`${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'bootstrap',
    nonce: VALID_NONCE,
  })}\n`);
  await channel.waitForBootstrap();
  channel.setCommandHandler((command) => { commands.push(command); });

  const validCommand = `${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'build.info.request',
    nonce: VALID_NONCE,
  })}\n`;
  input.write(Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 2, 0x20));
  input.write(validCommand);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, []);
  assert.equal(
    collector.frames.filter((frame) => frame.type === 'control.error').length,
    1,
  );

  input.write(validCommand);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, [{ type: 'build.info.request' }]);

  const oversizedCompleteCommand = `${validCommand.trimEnd().padEnd(
    MAX_CONTROL_FRAME_BYTES + 1,
    ' ',
  )}\n`;
  input.write(`${oversizedCompleteCommand}${validCommand}`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands, [
    { type: 'build.info.request' },
    { type: 'build.info.request' },
  ]);
  assert.equal(
    collector.frames.filter((frame) => frame.type === 'control.error').length,
    2,
  );
  channel.close();
  input.destroy();
  output.destroy();
});

test('a ready write failure rolls back listener, databases, and control input in order', async () => {
  const { startServerRuntime } = require('../server-runtime');
  const input = new PassThrough();
  const outputError = new Error('injected ready stdout failure');
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(outputError);
    },
  });
  output.on('error', () => {});
  const order = [];
  let listeningServer = null;
  const app = createAuthenticatedHealthApp((_req, _res, next) => next());
  const originalListen = app.listen.bind(app);
  app.listen = (...args) => {
    listeningServer = originalListen(...args);
    listeningServer.once('close', () => order.push('listener:closed'));
    return listeningServer;
  };
  const runtimePromise = startServerRuntime({
    closeDatabases() {
      order.push('databases:closed');
    },
    createApp: () => app,
    detectCapabilities: () => ({ supported: true }),
    assertDurabilitySupported: (capabilities) => capabilities,
    configureRecoveryDiagnosticsCapabilities: () => {},
    env: { MYTHPEN_DESKTOP_OWNED: '1', PORT: '0' },
    initDatabase: async () => {},
    input,
    inspectProjectDatabasesAtStartup: () => new Map(),
    output,
  });
  input.write(`${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'bootstrap',
    nonce: VALID_NONCE,
  })}\n`);

  await assert.rejects(runtimePromise, (error) => error === outputError);
  assert.ok(listeningServer);
  assert.equal(listeningServer.listening, false);
  assert.deepEqual(order, ['listener:closed', 'databases:closed']);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(input.isPaused(), true);
  input.destroy();
  output.destroy();
});

test('a partial database init failure always attempts storage rollback without replacing the primary error', async () => {
  const { startServerRuntime } = require('../server-runtime');
  const input = new PassThrough();
  const output = new PassThrough();
  const primaryError = new Error('partial init failed');
  const rollbackError = new Error('partial init cleanup failed');
  let closeCalls = 0;
  const runtimePromise = startServerRuntime({
    assertDurabilitySupported: (capabilities) => capabilities,
    closeDatabases() {
      closeCalls += 1;
      throw rollbackError;
    },
    configureRecoveryDiagnosticsCapabilities: () => {},
    createApp() {
      throw new Error('app must not be created after init failure');
    },
    detectCapabilities: () => ({ supported: true }),
    env: { MYTHPEN_DESKTOP_OWNED: '1', PORT: '0' },
    initDatabase: async () => {
      throw primaryError;
    },
    input,
    inspectProjectDatabasesAtStartup() {
      throw new Error('inspection must not run after init failure');
    },
    output,
  });
  input.write(`${JSON.stringify({
    channel: 'mythpen.sidecar.v1',
    type: 'bootstrap',
    nonce: VALID_NONCE,
  })}\n`);

  await assert.rejects(runtimePromise, (error) => {
    assert.equal(error, primaryError);
    assert.deepEqual(error.startupRollbackErrors, [rollbackError]);
    return true;
  });
  assert.equal(closeCalls, 1);
  assert.equal(input.listenerCount('data'), 0);
  input.destroy();
  output.destroy();
});

test('index is import-safe and ordinary HTTP shutdown is a JSON 404', async (t) => {
  const indexPath = path.join(__dirname, '..', 'index.js');
  const source = fs.readFileSync(indexPath, 'utf8');
  assert.doesNotMatch(source, /app\.post\(['"]\/api\/shutdown/);
  assert.doesNotMatch(source, /process\.exit\s*\(/);
  assert.match(source, /require\.main\s*===\s*module/);

  const { createApp } = require('../index');
  assert.equal(typeof createApp, 'function');
  const app = createApp();
  const server = await new Promise((resolve, reject) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
    listeningServer.once('error', reject);
  });
  t.after(() => closeServer(server));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/shutdown`, {
    method: 'POST',
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: '请求的接口不存在',
      recoverable: false,
    },
  });
});
