const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const CONTROL_CHANNEL = 'mythpen.sidecar.v1';

function projectDurabilitySnapshot(root, databasePath) {
  const paths = [databasePath];
  const controlRoot = path.join(root, 'control', 'sqlite');
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) paths.push(entryPath);
    }
  };
  visit(controlRoot);
  return paths
    .filter((filePath) => fs.existsSync(filePath))
    .sort()
    .map((filePath) => {
      const bytes = fs.readFileSync(filePath);
      return `${path.relative(root, filePath)}:${bytes.length}:${createHash('sha256').update(bytes).digest('hex')}`;
    })
    .join('\n');
}

function waitForFrame(child, type, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    const finish = (error, frame) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(frame);
    };
    const onExit = (code) => finish(new Error(`Fixture sidecar exited ${code} before ${type}`));
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const frame = JSON.parse(line);
        if (frame.channel === CONTROL_CHANNEL && frame.type === type) return finish(null, frame);
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

async function startFixtureSidecar(
  executable,
  reopenRoot = null,
  expectedBuild = null,
  readyTimeoutMs = 30_000,
) {
  const nonce = randomBytes(32).toString('hex');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-fixture-sidecar-profile-'));
  const child = spawn(executable, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      APPDATA: path.join(profile, 'AppData', 'Roaming'),
      HOME: profile,
      LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
      MYTHPEN_DESKTOP_OWNED: '1',
      PORT: '0',
      USERPROFILE: profile,
      XDG_CONFIG_HOME: path.join(profile, '.config'),
      XDG_DATA_HOME: path.join(profile, '.local', 'share'),
      ...(reopenRoot === null ? {} : { MYTHPEN_FIXTURE_REOPEN_ROOT: reopenRoot }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdin.write(`${JSON.stringify({ channel: CONTROL_CHANNEL, type: 'bootstrap', nonce })}\n`);
  try {
    const ready = await waitForFrame(child, 'ready', readyTimeoutMs);
    assert.equal(ready.nativeActivationMode, 'fixture_only');
    assert.match(ready.sourceCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    assert.match(ready.targetTriple, /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/);
    if (expectedBuild) {
      assert.equal(ready.sourceCommit, expectedBuild.sourceCommit);
      assert.equal(ready.targetTriple, expectedBuild.triple);
    }
    const buildInfoPromise = waitForFrame(child, 'build.info');
    child.stdin.write(`${JSON.stringify({
      channel: CONTROL_CHANNEL,
      type: 'build.info.request',
      nonce,
    })}\n`);
    const buildInfo = await buildInfoPromise;
    assert.equal(buildInfo.nativeActivationMode, ready.nativeActivationMode);
    assert.equal(buildInfo.sourceCommit, ready.sourceCommit);
    assert.equal(buildInfo.targetTriple, ready.targetTriple);
    return { child, nonce, port: ready.port, profile, stderr: () => stderr };
  } catch (error) {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    fs.rmSync(profile, { force: true, recursive: true });
    throw new Error(`${error.message}: ${stderr}`);
  }
}

async function request(session, method, route, body, projectInstance = null) {
  const response = await fetch(`http://127.0.0.1:${session.port}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Mythpen-Instance-Nonce': session.nonce,
      ...(projectInstance === null ? {} : { 'X-Mythpen-Project-Instance': projectInstance }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { payload, status: response.status };
}

async function shutdown(session, attemptSeq) {
  const completePromise = waitForFrame(session.child, 'shutdown.complete');
  session.child.stdin.write(`${JSON.stringify({
    channel: CONTROL_CHANNEL,
    type: 'shutdown.request',
    nonce: session.nonce,
    attemptSeq,
  })}\n`);
  const complete = await completePromise;
  assert.equal(complete.outcome, 'clean');
  await new Promise((resolve) => session.child.once('exit', resolve));
  assert.equal(session.child.exitCode, 0, session.stderr());
  fs.rmSync(session.profile, { force: true, recursive: true });
}

function diagnosticStderr(session) {
  return session.stderr().replaceAll(session.nonce, '[REDACTED_NONCE]');
}

function inspectSchema(databasePath) {
  const script = [
    "const { Database } = require('bun:sqlite')",
    'const database = new Database(process.argv[1], { create: false, readonly: true, strict: true })',
    "const rows = database.query(\"SELECT key, value FROM project_meta WHERE key IN ('durability_backend','schema_version') ORDER BY key\").all()",
    'database.close()',
    'process.stdout.write(JSON.stringify(rows))',
  ].join(';');
  const result = spawnSync('bun', ['-e', script, databasePath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('compiled fixture-only sidecar provides authenticated REST activation and native restart', { timeout: 120_000 }, async (t) => {
  const build = await import('../../scripts/build-sidecars.mjs');
  assert.equal(typeof build.buildFixtureOnlySidecar, 'function');
  assert.equal(
    path.basename(build.fixtureOnlySidecarOutputPath(repositoryRoot, 'x86_64-pc-windows-msvc')),
    'mythpen-server-fixture-only-x86_64-pc-windows-msvc.exe',
  );
  const built = build.buildFixtureOnlySidecar(repositoryRoot);
  const executable = built.server;
  let fixtureRoot = null;
  const sessions = [];
  t.after(() => {
    for (const session of sessions) {
      if (session.child.exitCode === null) session.child.kill();
      fs.rmSync(session.profile, { force: true, recursive: true });
    }
    if (fixtureRoot) fs.rmSync(fixtureRoot, { force: true, recursive: true });
    fs.rmSync(executable, { force: true });
  });

  await assert.rejects(
    startFixtureSidecar(executable, repositoryRoot, null, 5_000),
    /NATIVE_ACTIVATION_DISABLED/,
  );
  const evidenceMissingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-native-stage-c-'));
  try {
    await assert.rejects(
      startFixtureSidecar(executable, evidenceMissingRoot, null, 5_000),
      /NATIVE_ACTIVATION_DISABLED/,
    );
  } finally {
    fs.rmSync(evidenceMissingRoot, { force: true, recursive: true });
  }

  const first = await startFixtureSidecar(executable, null, built);
  sessions.push(first);
  const fixtureInfo = await request(first, 'GET', '/api/testing/native-fixture');
  assert.equal(fixtureInfo.status, 200);
  assert.equal(fixtureInfo.payload.activationMode, 'fixture_only');
  fixtureRoot = fixtureInfo.payload.root;
  assert.equal(path.dirname(fixtureRoot), fs.realpathSync.native(os.tmpdir()));
  assert.match(path.basename(fixtureRoot), /^mythpen-native-stage-c-/);

  const wrongNonce = await fetch(`http://127.0.0.1:${first.port}/api/testing/native-fixture`);
  assert.equal(wrongNonce.status, 401);

  const created = await request(first, 'POST', '/api/projects', {
    name: 'fixture-e2e',
    mode: 'medium-novel',
    language: 'zh',
    genres: ['other'],
  });
  assert.equal(created.status, 200, JSON.stringify(created.payload));
  const instanceId = created.payload.instanceId;
  assert.match(instanceId, /^[0-9a-f-]{36}$/);

  const chapter = await request(first, 'POST', '/api/fixture-e2e/chapters', {
    title: '第一章',
  }, instanceId);
  assert.equal(chapter.status, 201, JSON.stringify(chapter.payload));
  const v1Write = await request(first, 'PUT', '/api/fixture-e2e/chapters/1', {
    chapter_id: chapter.payload.id,
    content: 'schema10-before-activation',
    expected_data_version: chapter.payload.data_version,
  }, instanceId);
  assert.equal(v1Write.status, 200, JSON.stringify(v1Write.payload));

  const databasePath = path.join(fixtureRoot, 'projects', 'fixture-e2e.mythpen.db');
  const rejectedActivationBefore = projectDurabilitySnapshot(fixtureRoot, databasePath);
  const missingInstance = await request(
    first,
    'POST',
    '/api/projects/by-name/fixture-e2e/durability/native',
    {},
  );
  assert.equal(missingInstance.status, 400, JSON.stringify(missingInstance.payload));
  assert.equal(missingInstance.payload.error.code, 'INVALID_PARAMS');
  const wrongInstance = await request(
    first,
    'POST',
    '/api/projects/by-name/fixture-e2e/durability/native',
    {},
    randomUUID(),
  );
  assert.equal(wrongInstance.status, 409, JSON.stringify(wrongInstance.payload));
  assert.equal(wrongInstance.payload.error.code, 'PROJECT_INSTANCE_MISMATCH');
  assert.equal(projectDurabilitySnapshot(fixtureRoot, databasePath), rejectedActivationBefore);

  const enabled = await request(
    first,
    'POST',
    '/api/projects/by-name/fixture-e2e/durability/native',
    {},
    instanceId,
  );
  assert.equal(enabled.status, 200, JSON.stringify(enabled.payload));
  assert.deepEqual(enabled.payload, {
    activated: true,
    backend: 'native',
    name: 'fixture-e2e',
    schemaVersion: 11,
  });

  const repeatedBefore = projectDurabilitySnapshot(fixtureRoot, databasePath);
  const repeated = await request(
    first,
    'POST',
    '/api/projects/by-name/fixture-e2e/durability/native',
    {},
    instanceId,
  );
  assert.equal(repeated.status, 409, JSON.stringify(repeated.payload));
  assert.equal(repeated.payload.error.code, 'RECOVERY_REQUIRED');
  assert.equal(projectDurabilitySnapshot(fixtureRoot, databasePath), repeatedBefore);

  const nativeRead = await request(first, 'GET', `/api/fixture-e2e/chapters/1?chapter_id=${chapter.payload.id}`, undefined, instanceId);
  assert.equal(nativeRead.status, 200, JSON.stringify(nativeRead.payload));
  assert.equal(nativeRead.payload.content, 'schema10-before-activation');
  const nativeWrite = await request(first, 'PUT', '/api/fixture-e2e/chapters/1', {
    chapter_id: chapter.payload.id,
    content: 'native-before-restart',
    expected_data_version: nativeRead.payload.data_version,
  }, instanceId);
  assert.equal(
    nativeWrite.status,
    200,
    `${JSON.stringify(nativeWrite.payload)}\nSTDERR:\n${diagnosticStderr(first)}`,
  );
  await shutdown(first, 1);

  assert.deepEqual(inspectSchema(databasePath), [
    { key: 'durability_backend', value: 'native-sqlite-v2' },
    { key: 'schema_version', value: '11' },
  ]);
  const evidenceDirectories = fs.readdirSync(path.join(fixtureRoot, 'control', 'sqlite'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(fixtureRoot, 'control', 'sqlite', entry.name));
  const { inspectControlStoreEvidence } = require('../control-store');
  const activationEvents = evidenceDirectories.flatMap((directory) => (
    inspectControlStoreEvidence(directory).events.filter((event) => event.type.startsWith('sqlite.native.activation.'))
  ));
  assert.deepEqual(activationEvents.map((event) => event.type), [
    'sqlite.native.activation.prepared',
    'sqlite.native.activation.activated',
  ]);

  const second = await startFixtureSidecar(executable, fixtureRoot, built);
  sessions.push(second);
  const coldRepeatBefore = projectDurabilitySnapshot(fixtureRoot, databasePath);
  const coldRepeat = await request(
    second,
    'POST',
    '/api/projects/by-name/fixture-e2e/durability/native',
    {},
    instanceId,
  );
  assert.equal(coldRepeat.status, 409, JSON.stringify(coldRepeat.payload));
  assert.equal(coldRepeat.payload.error.code, 'RECOVERY_REQUIRED');
  assert.equal(projectDurabilitySnapshot(fixtureRoot, databasePath), coldRepeatBefore);
  const reopened = await request(second, 'GET', `/api/fixture-e2e/chapters/1?chapter_id=${chapter.payload.id}`, undefined, instanceId);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.payload));
  assert.equal(reopened.payload.content, 'native-before-restart');
  const postRestartWrite = await request(second, 'PUT', '/api/fixture-e2e/chapters/1', {
    chapter_id: chapter.payload.id,
    content: 'native-after-restart',
    expected_data_version: reopened.payload.data_version,
  }, instanceId);
  assert.equal(postRestartWrite.status, 200, JSON.stringify(postRestartWrite.payload));
  await shutdown(second, 1);
});
