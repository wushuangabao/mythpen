const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
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

function projectInstanceId(projectDb) {
  return projectDb
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get().value;
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

test('db activation admission requires an exact schema-10 source and rejects repeat or off-mode activation', {
  timeout: 120_000,
}, async (t) => {
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const buildInfoPath = require.resolve('../build-info');
  const dbPath = require.resolve('../db');
  const buildInfo = require(buildInfoPath);
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  const previousExportDir = process.env.MYTHPEN_EXPORT_DIR;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'fixture_only',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });

  const base = require('../testing/native-stage-c-fixture').createNativeStageCFixture();
  const root = base.root;
  const receipt = require('../native/native-activation-authority')
    .authorizeNativeActivation({ root })
    .consume();
  process.env.MYTHPEN_DATA_DIR = root;
  process.env.MYTHPEN_EXPORT_DIR = path.join(root, 'exports');
  const controller = require('../testing/fixture-native-activation-controller')
    .createFixtureNativeActivationController({ receipt, root });
  let activeDb = null;
  t.after(() => {
    try {
      activeDb?.closeAllDatabases();
    } catch {
      // Preserve the primary assertion failure.
    }
    delete require.cache[dbPath];
    buildInfo.getBuildInfo = originalGetBuildInfo;
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
    if (previousExportDir === undefined) delete process.env.MYTHPEN_EXPORT_DIR;
    else process.env.MYTHPEN_EXPORT_DIR = previousExportDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const loadFixtureDb = async () => {
    delete require.cache[dbPath];
    const database = require(dbPath);
    database.installFixtureNativeActivationController(controller);
    database.configureStorage({ dataDir: root });
    await database.initDatabase();
    activeDb = database;
    return database;
  };

  const database = await loadFixtureDb();
  const registerProject = (name, filePath) => {
    database.getConfigDb().prepare(
      'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
    ).run(randomUUID(), name, filePath);
    database.getConfigDb().flush();
  };

  const driftName = 'controller-mode-drift';
  const driftPath = database.getProjectDbPath(driftName);
  const drift = database.createProjectDb(driftName);
  const driftInstanceId = projectInstanceId(drift);
  registerProject(driftName, driftPath);
  database.closeProjectDb(driftPath);
  const activationCore = require('../native/native-activation');
  const originalActivateNativeProjectCore = activationCore.activateNativeProjectCore;
  let driftCoreCalls = 0;
  activationCore.activateNativeProjectCore = (...args) => {
    driftCoreCalls += 1;
    return originalActivateNativeProjectCore(...args);
  };
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'off',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  const driftBefore = exactTreeSnapshot(root);
  try {
    await assert.rejects(
      database.enableNativeProject(driftName, driftInstanceId),
      (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED',
    );
    assert.equal(driftCoreCalls, 0);
    assert.equal(exactTreeSnapshot(root), driftBefore);
  } finally {
    activationCore.activateNativeProjectCore = originalActivateNativeProjectCore;
    buildInfo.getBuildInfo = () => Object.freeze({
      nativeActivationMode: 'fixture_only',
      sourceCommit: 'a'.repeat(40),
      targetTriple: 'x86_64-pc-windows-msvc',
    });
    database.closeProjectDb(driftPath);
  }

  const futureName = 'controller-schema-twelve';
  const futurePath = database.getProjectDbPath(futureName);
  const future = database.createProjectDb(futureName);
  const futureInstanceId = projectInstanceId(future);
  registerProject(futureName, futurePath);
  future.prepare("UPDATE project_meta SET value = '12' WHERE key = 'schema_version'").run();
  future.flush();
  database.closeProjectDb(futurePath);
  const futureBefore = exactTreeSnapshot(root);
  await assert.rejects(
    database.enableNativeProject(futureName, futureInstanceId),
    (error) => error?.code === 'PROJECT_SCHEMA_TOO_NEW',
  );
  assert.equal(exactTreeSnapshot(root), futureBefore);

  const legacyName = 'schema-nine-source';
  const legacyPath = database.getProjectDbPath(legacyName);
  const legacy = database.createProjectDb(legacyName);
  const legacyInstanceId = projectInstanceId(legacy);
  registerProject(legacyName, legacyPath);
  legacy.prepare("UPDATE project_meta SET value = '9' WHERE key = 'schema_version'").run();
  legacy.flush();
  database.closeProjectDb(legacyPath);
  const legacyBefore = exactTreeSnapshot(root);
  await assert.rejects(
    database.enableNativeProject(legacyName, legacyInstanceId),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(exactTreeSnapshot(root), legacyBefore);
  const legacyInspection = new Database(legacyPath, { create: false, readonly: true, strict: true });
  assert.equal(
    legacyInspection.query("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value,
    '9',
  );
  legacyInspection.close();

  const nativeName = 'fixture-brand-admission';
  const nativePath = database.getProjectDbPath(nativeName);
  const native = database.createProjectDb(nativeName);
  const nativeInstanceId = projectInstanceId(native);
  registerProject(nativeName, nativePath);
  const wrongInstanceBefore = exactTreeSnapshot(root);
  await assert.rejects(
    database.enableNativeProject(nativeName, randomUUID()),
    (error) => error?.code === 'PROJECT_INSTANCE_MISMATCH',
  );
  assert.equal(exactTreeSnapshot(root), wrongInstanceBefore);
  await assert.rejects(
    database.enableNativeProject(nativeName, ''),
    (error) => error?.code === 'INVALID_PARAMS',
  );
  assert.equal(exactTreeSnapshot(root), wrongInstanceBefore);
  const enabled = await database.enableNativeProject(nativeName, nativeInstanceId);
  assert.equal(enabled.activated, true);
  const cachedBefore = exactTreeSnapshot(root);
  await assert.rejects(
    database.enableNativeProject(nativeName, nativeInstanceId),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(exactTreeSnapshot(root), cachedBefore);

  database.closeProjectDb(nativePath);
  const fixtureReopen = database.openProjectDb(nativePath);
  assert.equal(typeof fixtureReopen.runManuscriptTransaction, 'function');
  database.closeProjectDb(nativePath);
  const reopenedBefore = exactTreeSnapshot(root);
  await assert.rejects(
    database.enableNativeProject(nativeName, nativeInstanceId),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(exactTreeSnapshot(root), reopenedBefore);
  database.closeProjectDb(nativePath);
  database.closeAllDatabases();
  activeDb = null;

  const offBefore = exactTreeSnapshot(root);
  const offScript = [
    "const path = require('node:path')",
    "const db = require('./server/db')",
    'db.configureStorage({ dataDir: process.argv[1] })',
    'await db.initDatabase()',
    'let code = null',
    'try { db.openProjectDb(path.join(process.argv[1], \'projects\', `${process.argv[2]}.mythpen.db`)) } catch (error) { code = error.code }',
    'db.closeAllDatabases()',
    "process.stdout.write(`OFF_ADMISSION=${code}\\n`)",
  ].join(';');
  const offResult = require('node:child_process').spawnSync(
    process.execPath,
    ['-e', offScript, root, nativeName],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MYTHPEN_DATA_DIR: root,
        MYTHPEN_EXPORT_DIR: path.join(root, 'exports'),
      },
      windowsHide: true,
    },
  );
  assert.equal(offResult.status, 0, offResult.stderr || offResult.stdout);
  assert.match(offResult.stdout, /OFF_ADMISSION=RECOVERY_REQUIRED/);
  assert.equal(exactTreeSnapshot(root), offBefore);

  const corrupted = new Database(nativePath, { create: false, strict: true });
  try {
    corrupted.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
    corrupted.query("UPDATE project_meta SET value = 'tampered' WHERE key = 'durability_backend'").run();
    corrupted.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
  } finally {
    corrupted.close();
  }
  const corruptBefore = exactTreeSnapshot(root);
  const reopenedDatabase = await loadFixtureDb();
  assert.throws(
    () => reopenedDatabase.openProjectDb(nativePath),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(exactTreeSnapshot(root), corruptBefore);
});

test('db startup and open jointly reject each incomplete schema-11 contract without mutation', {
  timeout: 180_000,
}, async (t) => {
  const buildInfoPath = require.resolve('../build-info');
  const dbPath = require.resolve('../db');
  const buildInfo = require(buildInfoPath);
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  const previousExportDir = process.env.MYTHPEN_EXPORT_DIR;
  const roots = [];
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'fixture_only',
    sourceCommit: 'b'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  let activeDb = null;
  t.after(() => {
    try {
      activeDb?.closeAllDatabases();
    } catch {
      // Preserve the primary assertion failure.
    }
    delete require.cache[dbPath];
    buildInfo.getBuildInfo = originalGetBuildInfo;
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
    if (previousExportDir === undefined) delete process.env.MYTHPEN_EXPORT_DIR;
    else process.env.MYTHPEN_EXPORT_DIR = previousExportDir;
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  for (const fault of ['backend', 'gate', 'trigger', 'digest', 'sequence']) {
    const base = require('../testing/native-stage-c-fixture').createNativeStageCFixture();
    const root = base.root;
    roots.push(root);
    const receipt = require('../native/native-activation-authority')
      .authorizeNativeActivation({ root })
      .consume();
    process.env.MYTHPEN_DATA_DIR = root;
    process.env.MYTHPEN_EXPORT_DIR = path.join(root, 'exports');
    const controller = require('../testing/fixture-native-activation-controller')
      .createFixtureNativeActivationController({ receipt, root });

    delete require.cache[dbPath];
    const database = require(dbPath);
    activeDb = database;
    database.installFixtureNativeActivationController(controller);
    database.configureStorage({ dataDir: root });
    await database.initDatabase();
    const name = `schema11-${fault}`;
    const databasePath = database.getProjectDbPath(name);
    const project = database.createProjectDb(name);
    const instanceId = projectInstanceId(project);
    database.getConfigDb().prepare(
      'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
    ).run(randomUUID(), name, databasePath);
    database.getConfigDb().flush();
    assert.equal((await database.enableNativeProject(name, instanceId)).activated, true);

    const nativeDatabase = new Database(databasePath, { create: false, strict: true });
    try {
      if (fault === 'gate') {
        nativeDatabase.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
      } else if (fault === 'trigger') {
        const trigger = nativeDatabase.query(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE '_mythpen_downgrade_guard__%' ORDER BY name LIMIT 1",
        ).get();
        assert.ok(trigger?.name);
        nativeDatabase.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      } else {
        nativeDatabase.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
        const key = fault === 'backend'
          ? 'durability_backend'
          : fault === 'digest'
            ? 'durability_trigger_set_digest'
            : 'durability_commit_seq';
        const value = fault === 'sequence' ? '7' : 'tampered';
        nativeDatabase.query('UPDATE project_meta SET value = ? WHERE key = ?').run(value, key);
        nativeDatabase.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
      }
    } finally {
      nativeDatabase.close();
    }
    const before = exactTreeSnapshot(root);
    assert.throws(
      () => database.openProjectDb(databasePath),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      `${fault}: cached admission`,
    );
    assert.equal(exactTreeSnapshot(root), before, `${fault}: cached admission bytes`);
    database.closeAllDatabases();
    activeDb = null;

    delete require.cache[dbPath];
    const reopened = require(dbPath);
    activeDb = reopened;
    reopened.installFixtureNativeActivationController(controller);
    reopened.configureStorage({ dataDir: root });
    await reopened.initDatabase();
    reopened.inspectProjectDatabasesAtStartup();
    assert.equal(reopened.getProjectOpenState(databasePath)?.reasonCode, 'RECOVERY_REQUIRED', fault);
    assert.equal(exactTreeSnapshot(root), before, `${fault}: startup bytes`);
    reopened.removeProjectOpenState(databasePath);
    assert.throws(
      () => reopened.openProjectDb(databasePath),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      fault,
    );
    assert.equal(exactTreeSnapshot(root), before, `${fault}: open bytes`);
    reopened.closeAllDatabases();
    activeDb = null;
  }
});

test('db startup and open reject a valid prepared-only schema-11 admission without mutation', {
  timeout: 120_000,
}, async (t) => {
  const crash = await runUntilCrash({
    script: CRASH_WORKER,
    faults: { [FAULT_POINTS.NATIVE_ACTIVATION_AFTER_PREPARED_POSTCHECK]: { crash: true } },
    env: { MYTHPEN_NATIVE_ACTIVATION_CRASH_SCENARIO: 'db-prepared-only-admission' },
    timeoutMs: 60_000,
  });
  t.after(() => crash.cleanup());
  const fixture = crash.artifacts.fixture;
  const databasePath = fixture.databasePath;
  const preparedEvents = openControlStore(fixture.controlDirectory).read()
    .filter((event) => event.type.startsWith('sqlite.native.activation.'));
  assert.deepEqual(preparedEvents.map((event) => event.type), [
    'sqlite.native.activation.prepared',
  ]);
  const partial = new Database(databasePath, { create: false, strict: true });
  partial.query("UPDATE project_meta SET value = '11' WHERE key = 'schema_version'").run();
  partial.close();

  const buildInfoPath = require.resolve('../build-info');
  const dbPath = require.resolve('../db');
  const buildInfo = require(buildInfoPath);
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  const previousExportDir = process.env.MYTHPEN_EXPORT_DIR;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'fixture_only',
    sourceCommit: 'c'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  const authorityBase = require('../testing/native-stage-c-fixture').createNativeStageCFixture();
  const authorityRoot = authorityBase.root;
  const authorityReceipt = require('../native/native-activation-authority')
    .authorizeNativeActivation({ root: authorityRoot })
    .consume();
  const controller = require('../testing/fixture-native-activation-controller')
    .createFixtureNativeActivationController({ receipt: authorityReceipt, root: authorityRoot });
  process.env.MYTHPEN_DATA_DIR = fixture.root;
  process.env.MYTHPEN_EXPORT_DIR = path.join(fixture.root, 'exports');
  let activeDb = null;
  t.after(() => {
    try {
      activeDb?.closeAllDatabases();
    } catch {
      // Preserve the primary assertion failure.
    }
    delete require.cache[dbPath];
    buildInfo.getBuildInfo = originalGetBuildInfo;
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
    if (previousExportDir === undefined) delete process.env.MYTHPEN_EXPORT_DIR;
    else process.env.MYTHPEN_EXPORT_DIR = previousExportDir;
    fs.rmSync(authorityRoot, { recursive: true, force: true });
  });

  delete require.cache[dbPath];
  const registrationDb = require(dbPath);
  activeDb = registrationDb;
  registrationDb.installFixtureNativeActivationController(controller);
  registrationDb.configureStorage({ dataDir: fixture.root });
  await registrationDb.initDatabase();
  registrationDb.getConfigDb().prepare(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
  ).run(randomUUID(), fixture.name, databasePath);
  registrationDb.getConfigDb().flush();
  registrationDb.closeAllDatabases();
  activeDb = null;
  const before = exactTreeSnapshot(fixture.root);

  delete require.cache[dbPath];
  const reopened = require(dbPath);
  activeDb = reopened;
  reopened.installFixtureNativeActivationController(controller);
  reopened.configureStorage({ dataDir: fixture.root });
  await reopened.initDatabase();
  reopened.inspectProjectDatabasesAtStartup();
  assert.equal(reopened.getProjectOpenState(databasePath)?.reasonCode, 'RECOVERY_REQUIRED');
  assert.equal(exactTreeSnapshot(fixture.root), before);
  reopened.removeProjectOpenState(databasePath);
  assert.throws(
    () => reopened.openProjectDb(databasePath),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(exactTreeSnapshot(fixture.root), before);
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
