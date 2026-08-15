const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Database } = require('bun:sqlite');

const { openControlStore } = require('../control-store');
const { inspectSchema11Contract } = require('../native/durability-schema');
const { runUntilCrash } = require('../testing/crash-harness');
const { FAULT_POINTS } = require('../testing/fault-injection');
const { createProjectWriteCoordinator } = require('../project-write-coordinator');
const { createAtomicStore } = require('../sqljs-atomic-store');
const { getWasmBinary } = require('../wasm-binary');

const CRASH_WORKER = path.join(__dirname, 'fixtures', 'native-activation-crash.js');
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREPARED_KEYS = [
  'activationId',
  'activationMode',
  'backend',
  'cleanV1TerminalDigest',
  'createdAt',
  'dbKey',
  'eventId',
  'formalSha256',
  'markerDigest',
  'ownershipHash',
  'projectInstanceIdSha256',
  'targetSchema',
  'triggerSetDigest',
  'triggerVersion',
  'v1Identity',
  'version',
];
const ACTIVATED_KEYS = [
  'activationId',
  'backend',
  'createdAt',
  'dbKey',
  'eventId',
  'finalIdentity',
  'finalSeq',
  'gateEmpty',
  'ownershipHash',
  'preparedDigest',
  'projectInstanceIdSha256',
  'schemaVersion',
  'triggerSetDigest',
  'triggerVersion',
  'version',
];
const ABORTED_KEYS = [
  'activationId',
  'backend',
  'cleanV1TerminalDigest',
  'createdAt',
  'dbKey',
  'eventId',
  'formalSha256',
  'nativeStateAbsent',
  'ownershipHash',
  'preparedDigest',
  'projectInstanceIdSha256',
  'schemaVersion',
  'v1Identity',
  'version',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function canonicalPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function exactKeys(value, expected, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

function loadFixtureActivation(t) {
  const buildInfoPath = require.resolve('../build-info');
  const authorityPath = require.resolve('../native/native-activation-authority');
  const corePath = require.resolve('../native/native-activation');
  const helperPath = require.resolve('../testing/native-stage-c-activation');
  const buildInfo = require(buildInfoPath);
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'fixture_only',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  delete require.cache[authorityPath];
  delete require.cache[corePath];
  delete require.cache[helperPath];
  t.after(() => {
    buildInfo.getBuildInfo = originalGetBuildInfo;
    delete require.cache[authorityPath];
    delete require.cache[corePath];
    delete require.cache[helperPath];
  });
  return require(helperPath);
}

function trackFixture(t, fixture) {
  const root = path.resolve(fixture.root);
  assert.equal(canonicalPath(path.dirname(root)), canonicalPath(fs.realpathSync.native(os.tmpdir())));
  assert.equal(path.basename(root).startsWith('mythpen-native-stage-c-'), true);
  assert.equal(canonicalPath(fs.realpathSync.native(root)), canonicalPath(root));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fixture;
}

function sentinelSnapshot(fixture) {
  const database = new Database(fixture.databasePath, { create: false, readonly: true, strict: true });
  try {
    const rows = database.query(
      'SELECT id, name, background FROM characters WHERE id = ? ORDER BY id',
    ).all(fixture.sentinel.id);
    return Object.freeze({ count: rows.length, digest: sha256(canonicalJson(rows)) });
  } finally {
    database.close();
  }
}

function schema11Snapshot(fixture) {
  const database = new Database(fixture.databasePath, { create: false, readonly: true, strict: true });
  try {
    return inspectSchema11Contract(database);
  } finally {
    database.close();
  }
}

function activationEvents(fixture) {
  return openControlStore(fixture.controlDirectory).read();
}

function exactTreeSnapshot(root) {
  const entries = [];
  const visit = (directory, relativeDirectory = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory' });
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        entries.push({
          path: relativePath,
          type: 'file',
          bytes: fs.readFileSync(absolutePath).toString('base64'),
        });
      } else {
        entries.push({ path: relativePath, type: 'other' });
      }
    }
  };
  visit(root);
  return canonicalJson(entries);
}

function assertConvergedActivation(fixture, initial, expectedSentinel) {
  const events = activationEvents(fixture);
  const preparedEvents = events.filter((event) => event.type === 'sqlite.native.activation.prepared');
  const activatedEvents = events.filter((event) => event.type === 'sqlite.native.activation.activated');
  assert.equal(preparedEvents.length, 1);
  assert.equal(activatedEvents.length, 1);
  assert.equal(events.some((event) => event.type === 'sqlite.native.activation.aborted'), false);
  assert.equal(events.some((event) => event.type === 'sqlite.native.stage_b.fixture_genesis'), false);

  const [prepared] = preparedEvents;
  const [activated] = activatedEvents;
  exactKeys(prepared, ['digest', 'payload', 'prevDigest', 'seq', 'type'], 'prepared event');
  exactKeys(activated, ['digest', 'payload', 'prevDigest', 'seq', 'type'], 'activated event');
  exactKeys(prepared.payload, PREPARED_KEYS, 'prepared payload');
  exactKeys(activated.payload, ACTIVATED_KEYS, 'activated payload');
  assert.match(prepared.payload.activationId, UUID_V4_PATTERN);
  assert.equal(activated.payload.activationId, prepared.payload.activationId);
  assert.equal(activated.payload.preparedDigest, prepared.digest);
  assert.equal(prepared.payload.cleanV1TerminalDigest, initial.cleanTerminalDigest);
  assert.equal(prepared.payload.formalSha256, initial.formalSha256);
  assert.deepEqual(prepared.payload.v1Identity, initial.identity);
  assert.equal(prepared.payload.markerDigest, fixture.markerDigest);
  assert.equal(prepared.payload.activationMode, 'fixture_only');
  assert.equal(prepared.payload.targetSchema, 11);
  assert.equal(prepared.payload.backend, 'native-sqlite-v2');
  assert.equal(prepared.payload.triggerVersion, 1);
  assert.match(prepared.payload.triggerSetDigest, SHA256_PATTERN);
  assert.equal(activated.payload.schemaVersion, 11);
  assert.equal(activated.payload.backend, 'native-sqlite-v2');
  assert.equal(activated.payload.finalSeq, 0);
  assert.equal(activated.payload.gateEmpty, true);
  assert.equal(activated.payload.triggerVersion, 1);
  assert.equal(activated.payload.triggerSetDigest, prepared.payload.triggerSetDigest);
  assert.deepEqual(activated.payload.finalIdentity, initial.identity);
  assert.equal(activated.payload.dbKey, prepared.payload.dbKey);
  assert.equal(activated.payload.projectInstanceIdSha256, prepared.payload.projectInstanceIdSha256);
  assert.equal(activated.payload.ownershipHash, prepared.payload.ownershipHash);
  assert.deepEqual(sentinelSnapshot(fixture), expectedSentinel);

  const contract = schema11Snapshot(fixture);
  assert.equal(contract.schemaVersion, 11);
  assert.equal(contract.backend, 'native-sqlite-v2');
  assert.equal(contract.finalSeq, 0);
  assert.equal(contract.gateEmpty, true);
  assert.equal(contract.triggerVersion, 1);
  assert.equal(contract.triggerSetDigest, prepared.payload.triggerSetDigest);
  assert.equal(contract.projectInstanceIdSha256, prepared.payload.projectInstanceIdSha256);
  return { events, prepared, activated, contract };
}

function initialAnchor(fixture) {
  const events = activationEvents(fixture);
  const cleanTerminal = [...events].reverse().find((event) => (
    event.type === 'sqlite.publish.committed' || event.type === 'sqlite.publish.rolled_back'
  ));
  assert.ok(cleanTerminal, 'schema10 fixture must have a clean v1 terminal');
  const stats = fs.lstatSync(fixture.databasePath, { bigint: true });
  return Object.freeze({
    cleanTerminalDigest: cleanTerminal.digest,
    formalSha256: sha256(fs.readFileSync(fixture.databasePath)),
    identity: Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) }),
  });
}

async function publishSchema10Progress(fixture, background) {
  const SQL = await require('sql.js')({ wasmBinary: getWasmBinary() });
  const coordinator = createProjectWriteCoordinator({
    lockRoot: path.join(fixture.root, 'project-write-leases'),
  });
  coordinator.withProjectRecoveryLeaseSync(fixture.databasePath, () => {
    const store = createAtomicStore({
      assertWriterLease: () => coordinator.assertProjectWriteLease(fixture.databasePath),
      filePath: fixture.databasePath,
      controlStore: openControlStore(fixture.controlDirectory),
      sqlModule: SQL,
    });
    try {
      assert.equal(store.recover().status, 'clean');
      const connection = store.currentConnection();
      connection.run('UPDATE characters SET background = ? WHERE id = ?', [
        background,
        fixture.sentinel.id,
      ]);
      store.publish(connection);
    } finally {
      store.close();
    }
  });
}

function closeBestEffort(store) {
  try {
    if (store?.state === 'active' || store?.state === 'recovery_required') store.close();
  } catch {
    // Preserve the primary test failure.
  }
}

test('Stage C-B happy activation binds v1 evidence and reopens without mutation', { timeout: 90_000 }, async (t) => {
  const helper = loadFixtureActivation(t);
  const fixture = trackFixture(t, helper.createNativeStageCActivationFixture({
    name: 'stage-c-b-happy',
    sentinel: {
      id: 'activation-happy',
      name: 'Activation Happy',
      background: 'stage-c-b-sentinel',
    },
  }));
  const initial = initialAnchor(fixture);
  const expectedSentinel = sentinelSnapshot(fixture);
  assert.equal(expectedSentinel.count, 1);

  const store = await helper.activateNativeStageCFixture(fixture);
  t.after(() => closeBestEffort(store));
  assert.equal(store.state, 'active');
  assert.match(store.connectionEpoch, UUID_V4_PATTERN);
  assert.deepEqual(
    store.readGet('SELECT id, name, background FROM characters WHERE id = ?', fixture.sentinel.id),
    fixture.sentinel,
  );
  const converged = assertConvergedActivation(fixture, initial, expectedSentinel);
  const firstEpoch = store.connectionEpoch;
  store.close();

  const databaseBytes = fs.readFileSync(fixture.databasePath);
  const evidenceBytes = canonicalJson(converged.events);
  const reopened = await helper.activateNativeStageCFixture(fixture);
  t.after(() => closeBestEffort(reopened));
  assert.equal(reopened.state, 'active');
  assert.match(reopened.connectionEpoch, UUID_V4_PATTERN);
  assert.notEqual(reopened.connectionEpoch, firstEpoch);
  assert.deepEqual(fs.readFileSync(fixture.databasePath), databaseBytes);
  assert.equal(canonicalJson(activationEvents(fixture)), evidenceBytes);
  assert.deepEqual(sentinelSnapshot(fixture), expectedSentinel);
  reopened.close();
});

test('Stage C-B aborts a prepared attempt after clean v1 progress and activates from its new anchor', {
  timeout: 90_000,
}, async (t) => {
  const helper = loadFixtureActivation(t);
  const crash = await runUntilCrash({
    script: CRASH_WORKER,
    faults: { [FAULT_POINTS.NATIVE_ACTIVATION_AFTER_PREPARED_POSTCHECK]: { crash: true } },
    env: { MYTHPEN_NATIVE_ACTIVATION_CRASH_SCENARIO: 'aborted-v1-progress' },
    timeoutMs: 60_000,
  });
  t.after(() => crash.cleanup());
  assert.equal(crash.crashPoint.name, FAULT_POINTS.NATIVE_ACTIVATION_AFTER_PREPARED_POSTCHECK);
  const fixture = trackFixture(t, Object.freeze({ ...crash.artifacts.fixture }));
  const beforeProgress = initialAnchor(fixture);
  const beforeSentinel = sentinelSnapshot(fixture);

  await publishSchema10Progress(fixture, 'stage-c-b-v1-progress');
  const progressed = initialAnchor(fixture);
  const expectedSentinel = sentinelSnapshot(fixture);
  assert.notEqual(progressed.cleanTerminalDigest, beforeProgress.cleanTerminalDigest);
  assert.notEqual(progressed.formalSha256, beforeProgress.formalSha256);
  assert.notDeepEqual(progressed.identity, beforeProgress.identity);
  assert.equal(expectedSentinel.count, 1);
  assert.notEqual(expectedSentinel.digest, beforeSentinel.digest);

  const store = await helper.activateNativeStageCFixture(fixture);
  t.after(() => closeBestEffort(store));
  assert.equal(store.state, 'active');
  assert.deepEqual(
    store.readGet('SELECT id, name, background FROM characters WHERE id = ?', fixture.sentinel.id),
    { ...fixture.sentinel, background: 'stage-c-b-v1-progress' },
  );
  store.close();

  const events = activationEvents(fixture);
  const activation = events.filter((event) => event.type.startsWith('sqlite.native.activation.'));
  assert.deepEqual(activation.map((event) => event.type), [
    'sqlite.native.activation.prepared',
    'sqlite.native.activation.aborted',
    'sqlite.native.activation.prepared',
    'sqlite.native.activation.activated',
  ]);
  const [firstPrepared, aborted, secondPrepared, activated] = activation;
  exactKeys(aborted, ['digest', 'payload', 'prevDigest', 'seq', 'type'], 'aborted event');
  exactKeys(aborted.payload, ABORTED_KEYS, 'aborted payload');
  assert.equal(aborted.payload.activationId, firstPrepared.payload.activationId);
  assert.equal(aborted.payload.preparedDigest, firstPrepared.digest);
  assert.equal(aborted.payload.dbKey, firstPrepared.payload.dbKey);
  assert.equal(aborted.payload.projectInstanceIdSha256, firstPrepared.payload.projectInstanceIdSha256);
  assert.equal(aborted.payload.ownershipHash, firstPrepared.payload.ownershipHash);
  assert.equal(aborted.payload.cleanV1TerminalDigest, progressed.cleanTerminalDigest);
  assert.equal(aborted.payload.formalSha256, progressed.formalSha256);
  assert.deepEqual(aborted.payload.v1Identity, progressed.identity);
  assert.equal(aborted.payload.schemaVersion, 10);
  assert.equal(aborted.payload.backend, 'native-sqlite-v2');
  assert.equal(aborted.payload.nativeStateAbsent, true);
  assert.equal(aborted.prevDigest, progressed.cleanTerminalDigest);
  assert.equal(secondPrepared.payload.cleanV1TerminalDigest, progressed.cleanTerminalDigest);
  assert.equal(secondPrepared.payload.formalSha256, progressed.formalSha256);
  assert.deepEqual(secondPrepared.payload.v1Identity, progressed.identity);
  assert.equal(secondPrepared.payload.markerDigest, firstPrepared.payload.markerDigest);
  assert.notEqual(secondPrepared.payload.activationId, firstPrepared.payload.activationId);
  assert.equal(activated.payload.activationId, secondPrepared.payload.activationId);
  assert.equal(activated.payload.preparedDigest, secondPrepared.digest);

  const databaseBytes = fs.readFileSync(fixture.databasePath);
  const evidenceBytes = canonicalJson(events);
  const reopened = await helper.activateNativeStageCFixture(fixture);
  t.after(() => closeBestEffort(reopened));
  assert.equal(reopened.state, 'active');
  reopened.close();
  assert.deepEqual(fs.readFileSync(fixture.databasePath), databaseBytes);
  assert.equal(canonicalJson(activationEvents(fixture)), evidenceBytes);
  assert.deepEqual(sentinelSnapshot(fixture), expectedSentinel);
});

test('Stage C-B fresh activation rejects forged or cloned descriptors before mutation', (t) => {
  const helper = loadFixtureActivation(t);
  const fixture = trackFixture(t, helper.createNativeStageCActivationFixture({
    name: 'stage-c-b-authority-negative',
    sentinel: {
      id: 'activation-authority-negative',
      name: 'Activation Authority Negative',
      background: 'stage-c-b-sentinel',
    },
  }));
  const beforeDatabase = fs.readFileSync(fixture.databasePath);
  const beforeEvents = canonicalJson(activationEvents(fixture));
  const forged = Object.freeze({ ...fixture });
  assert.rejects(
    helper.activateNativeStageCFixture(forged),
    (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED',
  );
  assert.deepEqual(fs.readFileSync(fixture.databasePath), beforeDatabase);
  assert.equal(canonicalJson(activationEvents(fixture)), beforeEvents);
});

test('Stage C-B fresh activation rejects partial native schema residue before prepared', { timeout: 90_000 }, async (t) => {
  const helper = loadFixtureActivation(t);
  const rows = [
    ['gate', 'stage-c-b-residual-gate'],
    ['trigger-prefix', 'stage-c-b-residual-trigger'],
  ];
  const observations = [];
  for (const [nativeResidue, name] of rows) {
    const fixture = trackFixture(t, helper.createNativeStageCActivationFixture({
      name,
      nativeResidue,
      sentinel: {
        id: `activation-${nativeResidue}`,
        name: `Activation ${nativeResidue}`,
        background: 'stage-c-b-residue-sentinel',
      },
    }));
    const beforeDatabase = fs.readFileSync(fixture.databasePath);
    const beforeControlTree = exactTreeSnapshot(fixture.controlDirectory);
    const beforeEvents = canonicalJson(activationEvents(fixture));
    let error = null;
    let store = null;
    try {
      store = await helper.activateNativeStageCFixture(fixture);
    } catch (cause) {
      error = cause;
    } finally {
      closeBestEffort(store);
    }
    const afterEvents = activationEvents(fixture);
    observations.push({
      nativeResidue,
      error,
      preparedCount: afterEvents.filter(
        (event) => event.type === 'sqlite.native.activation.prepared',
      ).length,
      activatedCount: afterEvents.filter(
        (event) => event.type === 'sqlite.native.activation.activated',
      ).length,
      databaseUnchanged: fs.readFileSync(fixture.databasePath).equals(beforeDatabase),
      controlTreeUnchanged: exactTreeSnapshot(fixture.controlDirectory) === beforeControlTree,
      eventsUnchanged: canonicalJson(afterEvents) === beforeEvents,
    });
  }

  for (const observation of observations) {
    assert.equal(observation.preparedCount, 0, `${observation.nativeResidue}: prepared count`);
    assert.equal(observation.activatedCount, 0, `${observation.nativeResidue}: activated count`);
    assert.equal(observation.error?.code, 'RECOVERY_REQUIRED', `${observation.nativeResidue}: error code`);
    assert.equal(observation.databaseUnchanged, true, `${observation.nativeResidue}: database bytes`);
    assert.equal(observation.controlTreeUnchanged, true, `${observation.nativeResidue}: control tree`);
    assert.equal(observation.eventsUnchanged, true, `${observation.nativeResidue}: events`);
  }
});

const CRASH_CASES = [
  ['prepared-postcheck', 'native.activation.after-prepared-postcheck'],
  ['v1-fence-close', 'native.activation.after-v1-fence-close'],
  ['source-recheck', 'native.activation.after-source-recheck'],
  ['schema11-install', 'native.activation.after-schema11-install'],
  ['postcommit-inspect', 'native.activation.after-postcommit-inspect'],
  ['activated-postcheck', 'native.activation.after-activated-postcheck'],
  ['native-reopen', 'native.activation.after-native-reopen'],
];

for (const [scenario, faultPoint] of CRASH_CASES) {
  test(`Stage C-B real SIGKILL converges ${scenario}`, { timeout: 90_000 }, async (t) => {
    const helper = loadFixtureActivation(t);
    const crash = await runUntilCrash({
      script: CRASH_WORKER,
      faults: { [faultPoint]: { crash: true } },
      env: { MYTHPEN_NATIVE_ACTIVATION_CRASH_SCENARIO: scenario },
      timeoutMs: 60_000,
    });
    t.after(() => crash.cleanup());
    assert.equal(crash.crashPoint.name, faultPoint);
    exactKeys(crash.artifacts, ['fixture', 'scenario', 'version'], 'activation crash artifacts');
    assert.equal(crash.artifacts.version, 1);
    assert.equal(crash.artifacts.scenario, scenario);
    const fixture = trackFixture(t, Object.freeze({ ...crash.artifacts.fixture }));
    const initial = Object.freeze({
      cleanTerminalDigest: fixture.cleanV1TerminalDigest,
      formalSha256: fixture.v1FormalSha256,
      identity: fixture.v1Identity,
    });
    const expectedSentinel = Object.freeze({
      count: 1,
      digest: fixture.sentinelDigest,
    });

    const recovered = await helper.activateNativeStageCFixture(fixture);
    t.after(() => closeBestEffort(recovered));
    assert.equal(recovered.state, 'active');
    assert.match(recovered.connectionEpoch, UUID_V4_PATTERN);
    const converged = assertConvergedActivation(fixture, initial, expectedSentinel);
    const recoveredEpoch = recovered.connectionEpoch;
    recovered.close();

    const databaseBytes = fs.readFileSync(fixture.databasePath);
    const evidenceBytes = canonicalJson(converged.events);
    const reopened = await helper.activateNativeStageCFixture(fixture);
    t.after(() => closeBestEffort(reopened));
    assert.equal(reopened.state, 'active');
    assert.notEqual(reopened.connectionEpoch, recoveredEpoch);
    assert.deepEqual(fs.readFileSync(fixture.databasePath), databaseBytes);
    assert.equal(canonicalJson(activationEvents(fixture)), evidenceBytes);
    assert.deepEqual(sentinelSnapshot(fixture), expectedSentinel);
    reopened.close();
  });
}
