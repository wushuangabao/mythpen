const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Database } = require('bun:sqlite');

const { openControlStore } = require('../control-store');
const { runUntilCrash } = require('../testing/crash-harness');
const {
  FAULT_POINTS,
  crashOnlyFaultPoint,
  withFaults,
} = require('../testing/fault-injection');
const { createStageBFixtureStore } = require('../testing/native-stage-b-store');

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_KEYS = ['fixture', 'rowId', 'scenario', 'sourceDigest', 'version'];
const FIXTURE_KEYS = [
  'controlDirectory',
  'databasePath',
  'databaseSha256',
  'fixtureRunId',
  'genesisDigest',
  'name',
  'root',
];
const CRASH_WORKER = path.join(__dirname, 'fixtures', 'native-project-store-crash.js');

function terminalArmPath(scenario, parentPid = process.pid) {
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0);
  return path.join(
    fs.realpathSync.native(os.tmpdir()),
    `mythpen-native-task4-arm-${parentPid}-${scenario}.ready`,
  );
}

function canonicalPath(targetPath) {
  const normalized = path.normalize(path.resolve(targetPath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertExactKeys(value, expected, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}

function assertInside(root, target, label) {
  const relative = path.relative(root, path.resolve(target));
  assert.notEqual(relative, '', `${label} must not equal the fixture root`);
  assert.equal(relative.startsWith('..'), false, `${label} escapes the fixture root`);
  assert.equal(path.isAbsolute(relative), false, `${label} escapes the fixture root`);
}

function registerWorkerRootCleanup(t, rawFixture) {
  assert.ok(rawFixture !== null && typeof rawFixture === 'object' && !Array.isArray(rawFixture));
  assert.equal(typeof rawFixture.root, 'string');
  assert.notEqual(rawFixture.root.length, 0);
  const root = path.resolve(rawFixture.root);
  const tempParent = fs.realpathSync.native(os.tmpdir());
  assert.equal(canonicalPath(path.dirname(root)), canonicalPath(tempParent));
  assert.equal(path.basename(root).startsWith('mythpen-native-stage-b-'), true);
  const stats = fs.lstatSync(root);
  assert.equal(stats.isDirectory(), true);
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(canonicalPath(fs.realpathSync.native(root)), canonicalPath(root));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function rehydrateArtifacts(t, raw, expectedScenario) {
  assertExactKeys(raw, ARTIFACT_KEYS, 'crash artifacts exact keys');
  const root = registerWorkerRootCleanup(t, raw.fixture);
  assert.equal(raw.version, 1);
  assert.equal(raw.scenario, expectedScenario);
  assert.equal(raw.rowId, `task4-crash-${expectedScenario}`);
  assert.match(raw.sourceDigest, SHA256_PATTERN);

  assertExactKeys(raw.fixture, FIXTURE_KEYS, 'fixture descriptor exact keys');
  assert.equal(raw.fixture.name, `task4-crash-${expectedScenario}`);
  assert.match(raw.fixture.fixtureRunId, UUID_V4_PATTERN);
  assert.match(raw.fixture.genesisDigest, SHA256_PATTERN);
  assert.match(raw.fixture.databaseSha256, SHA256_PATTERN);
  for (const key of ['controlDirectory', 'databasePath', 'name', 'root']) {
    assert.equal(typeof raw.fixture[key], 'string', key);
    assert.notEqual(raw.fixture[key].length, 0, key);
  }
  assert.equal(canonicalPath(raw.fixture.root), canonicalPath(root));
  assertInside(root, raw.fixture.databasePath, 'databasePath');
  assertInside(root, raw.fixture.controlDirectory, 'controlDirectory');

  const databaseStats = fs.lstatSync(raw.fixture.databasePath, { bigint: true });
  assert.equal(databaseStats.isFile(), true);
  assert.equal(databaseStats.isSymbolicLink(), false);
  assert.equal(databaseStats.nlink, 1n);
  const controlStats = fs.lstatSync(raw.fixture.controlDirectory);
  assert.equal(controlStats.isDirectory(), true);
  assert.equal(controlStats.isSymbolicLink(), false);

  return Object.freeze({
    artifacts: Object.freeze({
      version: raw.version,
      scenario: raw.scenario,
      rowId: raw.rowId,
      sourceDigest: raw.sourceDigest,
    }),
    fixture: Object.freeze({ ...raw.fixture }),
    identity: Object.freeze({ dev: String(databaseStats.dev), ino: String(databaseStats.ino) }),
  });
}

function appendCallerOwnedAbandoned(controlStore, source) {
  const appended = controlStore.compareAndAppend(source.digest, {
    type: 'manuscript.source.abandoned',
    payload: {
      version: 1,
      eventId: randomUUID(),
      dbKey: source.payload.dbKey,
      projectInstanceIdSha256: source.payload.projectInstanceIdSha256,
      createdAt: new Date().toISOString(),
      ownershipHash: source.payload.ownershipHash,
      connectionEpoch: source.payload.connectionEpoch,
      sourceDigest: source.digest,
      reasonCode: 'cancelled',
    },
  });
  const tail = controlStore.tail();
  assert.equal(tail.digest, appended.digest);
  assert.equal(tail.type, 'manuscript.source.abandoned');
  assert.equal(tail.payload.sourceDigest, source.digest);
  assert.equal(tail.payload.connectionEpoch, source.payload.connectionEpoch);
  assert.equal(tail.payload.reasonCode, 'cancelled');
  return tail;
}

function closeStoreBestEffort(store) {
  if (!store) return;
  try {
    if (store.state === 'active' || store.state === 'recovery_required') store.close();
  } catch {
    // Preserve the primary test failure.
  }
}

function assertStableProjection(store, artifacts, expectedFinalSeq) {
  assert.deepEqual(
    store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"),
    { value: String(expectedFinalSeq) },
  );
  const row = store.readGet(
    'SELECT id, name, background FROM characters WHERE id = ?',
    artifacts.rowId,
  );
  if (expectedFinalSeq === 0) {
    assert.equal(row, null);
  } else {
    assert.deepEqual(row, {
      id: artifacts.rowId,
      name: `Crash ${artifacts.scenario}`,
      background: 'non-secret crash fixture row',
    });
  }
}

function assertGateEmptyAfterRecovery(fixture) {
  const inspector = new Database(fixture.databasePath, { create: false, readonly: true, strict: true });
  try {
    assert.deepEqual(
      inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get(),
      { count: 0 },
    );
  } finally {
    inspector.close();
  }
}

test('Task 4 crash-only points ignore every configured non-crash action', async () => {
  assert.equal(
    FAULT_POINTS.NATIVE_CALLER_AFTER_SOURCE_POSTCHECK,
    'native.caller.after-source-postcheck',
  );
  assert.equal(
    FAULT_POINTS.NATIVE_TX_AFTER_TERMINAL_POSTCHECK,
    'native.tx.after-terminal-postcheck',
  );
  assert.equal(typeof crashOnlyFaultPoint, 'function');

  for (const point of [
    FAULT_POINTS.NATIVE_CALLER_AFTER_SOURCE_POSTCHECK,
    FAULT_POINTS.NATIVE_TX_AFTER_TERMINAL_POSTCHECK,
  ]) {
    let callbackCount = 0;
    await withFaults({
      [point]: {
        throw: 'MUST_NOT_THROW',
        callback() {
          callbackCount += 1;
        },
        active: true,
      },
    }, async () => {
      assert.equal(crashOnlyFaultPoint(point, { sourceDigest: 'safe-context' }), false);
    });
    assert.equal(callbackCount, 0);
  }
});

const CASES = [
  {
    scenario: 'caller-source-postcheck',
    fault: 'native.caller.after-source-postcheck',
    initial: 'source',
    outcome: 'source',
    finalSeq: 0,
  },
  {
    scenario: 'after-prepared-postcheck',
    fault: 'native.tx.after-prepared-postcheck',
    initial: 'prepared',
    outcome: 'rolled_back',
    finalSeq: 0,
  },
  {
    scenario: 'after-begin-acquired',
    fault: 'native.tx.after-begin-acquired',
    initial: 'prepared',
    outcome: 'rolled_back',
    finalSeq: 0,
  },
  {
    scenario: 'after-gate-insert',
    fault: 'native.tx.after-gate-insert',
    initial: 'prepared',
    outcome: 'rolled_back',
    finalSeq: 0,
  },
  {
    scenario: 'after-business-callback',
    fault: 'native.tx.after-business-callback',
    initial: 'prepared',
    outcome: 'rolled_back',
    finalSeq: 0,
  },
  {
    scenario: 'after-seq-cas',
    fault: 'native.tx.after-seq-cas',
    initial: 'prepared',
    outcome: 'rolled_back',
    finalSeq: 0,
  },
  {
    scenario: 'after-gate-delete',
    fault: 'native.tx.after-gate-delete',
    initial: 'prepared',
    outcome: 'rolled_back',
    finalSeq: 0,
  },
  {
    scenario: 'before-commit-invoke',
    fault: 'native.tx.before-commit-invoke',
    initial: 'prepared',
    outcome: 'rolled_back',
    finalSeq: 0,
  },
  {
    scenario: 'after-commit-return',
    fault: 'native.tx.after-commit-return',
    initial: 'prepared',
    outcome: 'committed',
    finalSeq: 1,
  },
  {
    scenario: 'before-terminal-append',
    fault: 'native.tx.before-terminal-append',
    initial: 'prepared',
    outcome: 'committed',
    finalSeq: 1,
  },
  {
    scenario: 'terminal-before-publish',
    fault: 'controlstore.append.before-publish',
    initial: 'prepared',
    outcome: 'committed',
    finalSeq: 1,
    arm: true,
  },
  {
    scenario: 'terminal-before-dir-fsync',
    fault: 'controlstore.append.before-dir-fsync',
    initial: 'clean',
    outcome: 'clean',
    finalSeq: 1,
    arm: true,
  },
  {
    scenario: 'after-terminal-postcheck',
    fault: 'native.tx.after-terminal-postcheck',
    initial: 'clean',
    outcome: 'clean',
    finalSeq: 1,
  },
];

for (const current of CASES) {
  test(`Task 4 real SIGKILL converges ${current.scenario}`, { timeout: 90_000 }, async (t) => {
    let armPath = null;
    const faultAction = { crash: true };
    if (current.arm === true) {
      armPath = terminalArmPath(current.scenario);
      assert.equal(fs.existsSync(armPath), false, 'terminal arm must start absent');
      faultAction.whenFileExists = armPath;
      t.after(() => fs.rmSync(armPath, { force: true }));
    }
    const crash = await runUntilCrash({
      script: CRASH_WORKER,
      faults: { [current.fault]: faultAction },
      env: { MYTHPEN_NATIVE_PROJECT_STORE_CRASH_SCENARIO: current.scenario },
      timeoutMs: 60_000,
    });
    t.after(() => crash.cleanup());
    assert.equal(crash.crashPoint.name, current.fault);
    assert.equal(crash.signal, 'SIGKILL');
    if (armPath !== null) assert.equal(fs.readFileSync(armPath, 'utf8'), 'armed\n');

    const { artifacts, fixture, identity } = rehydrateArtifacts(t, crash.artifacts, current.scenario);
    const serializedMarker = JSON.stringify(crash.crashPoint);
    for (const forbidden of [
      fixture.databasePath,
      'INSERT INTO',
      'non-secret crash fixture row',
      'params',
    ]) {
      assert.equal(serializedMarker.includes(forbidden), false, forbidden);
    }

    // From child death through the first recover call, this parent intentionally
    // reads only ControlStore evidence and filesystem identity. Opening SQLite here
    // would consume a hot journal before NativeProjectStore can prove recovery.
    const controlStore = openControlStore(fixture.controlDirectory);
    const evidenceBeforeRecovery = controlStore.read();
    const genesis = evidenceBeforeRecovery[0];
    const sources = evidenceBeforeRecovery.filter((event) => event.type === 'manuscript.source');
    const preparedEvents = evidenceBeforeRecovery.filter((event) => event.type === 'sqlite.tx.prepared');
    assert.equal(genesis.digest, fixture.genesisDigest);
    assert.deepEqual(genesis.payload.identity, identity);
    assert.equal(sources.length, 1);
    const [source] = sources;
    assert.equal(source.digest, artifacts.sourceDigest);
    assert.equal(
      JSON.stringify(crash.artifacts).includes('non-secret crash fixture row'),
      false,
    );
    assert.equal(preparedEvents.length, current.initial === 'source' ? 0 : 1);
    const terminalsBeforeRecovery = evidenceBeforeRecovery.filter((event) => (
      ['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)
    ));
    assert.equal(terminalsBeforeRecovery.length, current.initial === 'clean' ? 1 : 0);

    let sqliteOpenCount = 0;
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        assert.equal(canonicalPath(databasePath), canonicalPath(fixture.databasePath));
        return new Database(databasePath, { create: false, strict: true });
      },
    });
    t.after(() => closeStoreBestEffort(store));
    if (current.initial === 'clean') {
      assert.equal(store.state, 'active');
      assert.match(store.connectionEpoch, UUID_V4_PATTERN);
      assert.equal(sqliteOpenCount, 1);
    } else {
      assert.equal(store.state, 'recovery_required');
      assert.equal(store.connectionEpoch, null);
      assert.equal(sqliteOpenCount, 0);
    }

    let recoveryResult;
    if (current.outcome === 'source') {
      const pendingEvidence = controlStore.read();
      assert.deepEqual(store.recover(), {
        status: 'source_pending',
        sourceDigest: source.digest,
        finalSeq: 0,
        connectionEpoch: null,
      });
      assert.equal(sqliteOpenCount, 0);
      assert.deepEqual(controlStore.read(), pendingEvidence);
      const abandoned = appendCallerOwnedAbandoned(controlStore, source);
      recoveryResult = store.recover();
      assert.deepEqual(recoveryResult, {
        status: 'clean',
        finalSeq: 0,
        connectionEpoch: store.connectionEpoch,
      });
      assert.equal(sqliteOpenCount, 1);
      const evidence = controlStore.read();
      assert.equal(evidence.at(-1).digest, abandoned.digest);
      assert.equal(evidence.filter((event) => event.type === 'manuscript.source.abandoned').length, 1);
      assert.equal(evidence.some((event) => event.type === 'sqlite.tx.prepared'), false);
      assert.equal(
        evidence.some((event) => ['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)),
        false,
      );
    } else if (current.initial === 'prepared') {
      const [prepared] = preparedEvents;
      recoveryResult = store.recover();
      const evidence = controlStore.read();
      const terminals = evidence.filter((event) => (
        ['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)
        && event.payload.preparedDigest === prepared.digest
      ));
      assert.equal(terminals.length, 1);
      const [terminal] = terminals;
      assert.deepEqual(recoveryResult, {
        status: current.outcome,
        preparedDigest: prepared.digest,
        terminalDigest: terminal.digest,
        finalSeq: current.finalSeq,
        connectionEpoch: store.connectionEpoch,
      });
      assert.equal(
        terminal.type,
        current.outcome === 'committed' ? 'sqlite.tx.committed' : 'sqlite.tx.rolled_back',
      );
      assert.equal(sqliteOpenCount, 1);
    } else {
      const cleanEvidence = controlStore.read();
      recoveryResult = store.recover();
      assert.deepEqual(recoveryResult, {
        status: 'clean',
        finalSeq: 1,
        connectionEpoch: store.connectionEpoch,
      });
      assert.equal(sqliteOpenCount, 1);
      assert.deepEqual(controlStore.read(), cleanEvidence);
    }

    assert.equal(store.state, 'active');
    assert.match(store.connectionEpoch, UUID_V4_PATTERN);
    assertStableProjection(store, artifacts, current.finalSeq);
    assertGateEmptyAfterRecovery(fixture);

    const evidenceAfterRecovery = controlStore.read();
    const transactionTerminals = evidenceAfterRecovery.filter((event) => (
      ['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)
    ));
    if (current.initial === 'source') {
      assert.equal(transactionTerminals.length, 0);
    } else {
      assert.equal(transactionTerminals.length, 1);
      assert.equal(
        transactionTerminals[0].type,
        current.finalSeq === 1 ? 'sqlite.tx.committed' : 'sqlite.tx.rolled_back',
      );
      assert.equal(transactionTerminals[0].payload.preparedDigest, preparedEvents[0].digest);
    }

    const recoveryEpoch = store.connectionEpoch;
    const convergedEvidence = controlStore.read();
    const convergedTail = controlStore.tail().digest;
    store.close();

    let cleanOpenCount = 0;
    const clean = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        cleanOpenCount += 1;
        return new Database(databasePath, { create: false, strict: true });
      },
    });
    t.after(() => closeStoreBestEffort(clean));
    assert.equal(clean.state, 'active');
    assert.equal(cleanOpenCount, 1);
    assert.notEqual(clean.connectionEpoch, recoveryEpoch);
    assert.deepEqual(clean.recover(), {
      status: 'clean',
      finalSeq: current.finalSeq,
      connectionEpoch: clean.connectionEpoch,
    });
    assertStableProjection(clean, artifacts, current.finalSeq);
    assertGateEmptyAfterRecovery(fixture);
    assert.deepEqual(controlStore.read(), convergedEvidence);
    assert.equal(controlStore.tail().digest, convergedTail);
    clean.close();
  });
}
