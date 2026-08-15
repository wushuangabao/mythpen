const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openControlStore } = require('../control-store');
const { canonicalDatabasePath, createAtomicStore } = require('../sqljs-atomic-store');
const { getWasmBinary } = require('../wasm-binary');
const { atomicReplace } = require('../platform/durability');
const {
  inspectRegisteredProject,
  recoverRegisteredProject,
} = require('../recovery-diagnostics');

const DTO_KEYS = [
  'backend',
  'canAdoptIdentity',
  'canAutoRecover',
  'controlStore',
  'currentSeq',
  'dbIdentity',
  'expectedIdentity',
  'expectedSeq',
  'expectedTriggerSetDigest',
  'integrity',
  'observedTriggerSetDigest',
  'platformCapabilities',
  'projectInstanceIdSha256',
  'projectMetaTriggerSetDigest',
  'protocol',
  'reasonCode',
  'recommendedAction',
  'schema',
  'snapshot',
  'state',
  'triggerVersion',
].sort();

const PLATFORM_CAPABILITIES = Object.freeze({
  atomicReplace: true,
  backend: process.platform === 'win32' ? 'win32' : 'posix',
  directoryFsync: true,
  exclusiveLease: true,
  verifiedAbsentInstall: true,
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function identity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function databaseBytes(SQL, value, instanceId = `instance-${value}`, schema = 10) {
  const database = new SQL.Database();
  database.run('CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.run('CREATE TABLE volumes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
  database.run("INSERT INTO project_meta (key, value) VALUES ('schema_version', ?)", [String(schema)]);
  database.run("INSERT INTO project_meta (key, value) VALUES ('project_instance_id', ?)", [instanceId]);
  database.run('INSERT INTO volumes (id, title) VALUES (1, ?)', [value]);
  const bytes = Buffer.from(database.export());
  database.close();
  return bytes;
}

function publicationPaths(controlDir, dbPath, publicationId) {
  const canonicalPath = canonicalDatabasePath(dbPath);
  const dbKey = sha256(Buffer.from(canonicalPath));
  return {
    backupPath: path.join(controlDir, 'sqlite-recovery', dbKey, `${publicationId}.before.db`),
    candidatePath: path.join(
      path.dirname(dbPath),
      `.${path.basename(dbPath)}.${publicationId}.candidate.db`,
    ),
    canonicalPath,
    dbKey,
    publicationId,
    rollbackPath: path.join(
      path.dirname(dbPath),
      `.${path.basename(dbPath)}.${publicationId}.rollback.db`,
    ),
  };
}

function appendPrepared(controlStore, { beforeBytes, candidateBytes, controlDir, dbPath }) {
  const publicationId = crypto.randomUUID();
  const paths = publicationPaths(controlDir, dbPath, publicationId);
  controlStore.append({
    type: 'sqlite.publish.prepared',
    payload: {
      version: 1,
      publicationId,
      dbKey: paths.dbKey,
      before: {
        exists: true,
        sha256: sha256(beforeBytes),
        identity: identity(dbPath),
        backupPath: paths.backupPath,
      },
      candidate: {
        path: paths.candidatePath,
        sha256: sha256(candidateBytes),
      },
      after: { sha256: sha256(candidateBytes) },
    },
    afterPredicate: {
      filePath: paths.canonicalPath,
      sha256: sha256(candidateBytes),
    },
  });
  fs.mkdirSync(path.dirname(paths.backupPath), { recursive: true });
  fs.writeFileSync(paths.backupPath, beforeBytes);
  return paths;
}

function snapshotTree(root) {
  const rows = [];
  function visit(current, relative) {
    const stats = fs.lstatSync(current, { bigint: true });
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    const row = {
      relative: relative || '.',
      type,
      dev: String(stats.dev),
      ino: String(stats.ino),
      length: String(stats.size),
      sha256: type === 'file' ? sha256(fs.readFileSync(current)) : null,
    };
    rows.push(row);
    if (type === 'directory') {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? path.join(relative, name) : name);
      }
    }
  }
  visit(root, '');
  return rows;
}

async function createScene(t, mode) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-recovery-diagnostics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'projects', 'novel.mythpen.db');
  const controlDir = path.join(root, 'control', 'sqlite', 'project-control');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const beforeBytes = databaseBytes(SQL, 'before', 'raw-instance-secret');
  const afterBytes = databaseBytes(SQL, 'after', 'raw-instance-secret');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  if (mode === 'forward') fs.writeFileSync(publication.candidatePath, afterBytes);
  if (mode === 'third') fs.writeFileSync(dbPath, databaseBytes(SQL, 'third', 'raw-instance-secret'));
  if (mode === 'same-bytes-new-inode') {
    const replacement = path.join(root, 'replacement.db');
    fs.writeFileSync(replacement, beforeBytes);
    atomicReplace(replacement, dbPath, { attempts: 1, backoffMs: 0 });
  }
  if (mode === 'missing-formal') fs.rmSync(dbPath);
  if (mode === 'rollback-installing') {
    fs.rmSync(dbPath);
    fs.writeFileSync(publication.rollbackPath, beforeBytes);
    const rollbackIdentity = identity(publication.rollbackPath);
    controlStore.append({
      type: 'sqlite.publish.rollback_installing',
      payload: {
        version: 1,
        publicationId: publication.publicationId,
        dbKey: publication.dbKey,
        rollback: {
          path: publication.rollbackPath,
          sha256: sha256(beforeBytes),
          identity: rollbackIdentity,
        },
      },
      afterPredicate: {
        filePath: publication.canonicalPath,
        exists: true,
        sha256: sha256(beforeBytes),
        identity: rollbackIdentity,
      },
    });
  }
  if (mode === 'schema-too-new') {
    fs.writeFileSync(dbPath, databaseBytes(SQL, 'future', 'raw-instance-secret', 11));
  }
  if (mode === 'interleaved') {
    appendPrepared(controlStore, {
      beforeBytes,
      candidateBytes: afterBytes,
      controlDir,
      dbPath,
    });
  }
  return {
    afterBytes,
    beforeBytes,
    controlDir,
    dbPath,
    deps(overrides = {}) {
      return {
        getControlDirectory: () => controlDir,
        lookupRegisteredProject: (name) => (name === 'novel' ? { name, filePath: dbPath } : null),
        canonicalizeProjectPath: canonicalDatabasePath,
        platformCapabilities: PLATFORM_CAPABILITIES,
        recoverV1Publication() {
          const store = createAtomicStore({
            filePath: dbPath,
            controlStore: openControlStore(controlDir),
            sqlModule: SQL,
          });
          try {
            return store.recover();
          } finally {
            store.close();
          }
        },
        sqlModule: SQL,
        supportedSchemaVersion: 10,
        withProjectRecoveryLease(_filePath, callback) {
          return callback({ canonicalProjectKey: canonicalDatabasePath(dbPath) });
        },
        ...overrides,
      };
    },
    inspect() {
      return inspectRegisteredProject('novel', this.deps());
    },
    publication,
    root,
    SQL,
  };
}

async function inspectCleanBytes(t, bytes) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-recovery-clean-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'projects', 'clean.mythpen.db');
  const controlDir = path.join(root, 'control', 'sqlite', 'absent-control');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (bytes !== null) fs.writeFileSync(dbPath, bytes(SQL));
  return inspectRegisteredProject('clean', {
    canonicalizeProjectPath: canonicalDatabasePath,
    getControlDirectory: () => controlDir,
    lookupRegisteredProject: () => ({ name: 'clean', filePath: dbPath }),
    platformCapabilities: PLATFORM_CAPABILITIES,
    sqlModule: SQL,
    supportedSchemaVersion: 10,
  });
}

for (const [mode, reasonCode, canAutoRecover] of [
  ['same-bytes-new-inode', 'RECOVERY_REQUIRED', false],
  ['missing-formal', 'V1_PUBLICATION_ROLLBACK_RECOVERABLE', true],
  ['rollback-installing', 'V1_PUBLICATION_ROLLBACK_RECOVERABLE', true],
  ['schema-too-new', 'PROJECT_SCHEMA_TOO_NEW', false],
  ['interleaved', 'RECOVERY_REQUIRED', false],
]) {
  test(`${mode} inspection fails closed without changing the evidence tree`, async (t) => {
    const scene = await createScene(t, mode);
    const before = snapshotTree(scene.root);
    const diagnostics = scene.inspect();
    assert.deepEqual(snapshotTree(scene.root), before);
    assert.equal(diagnostics.state, 'isolated');
    assert.equal(diagnostics.reasonCode, reasonCode);
    assert.equal(diagnostics.canAutoRecover, canAutoRecover);
  });
}

for (const [capability, label, canAutoRecover] of [
  [true, 'verified', true],
  [false, 'unsupported', false],
  [null, 'unknown', false],
]) {
  test(`missing-formal rollback is ${label} by absent-install capability`, async (t) => {
    const scene = await createScene(t, 'missing-formal');
    const before = snapshotTree(scene.root);
    const diagnostics = inspectRegisteredProject('novel', scene.deps({
      platformCapabilities: {
        ...PLATFORM_CAPABILITIES,
        verifiedAbsentInstall: capability,
      },
    }));

    assert.deepEqual(snapshotTree(scene.root), before);
    assert.equal(diagnostics.canAutoRecover, canAutoRecover);
    assert.equal(
      diagnostics.recommendedAction,
      canAutoRecover ? 'recover_v1_publication' : null,
    );
    assert.equal(
      diagnostics.reasonCode,
      canAutoRecover ? 'V1_PUBLICATION_ROLLBACK_RECOVERABLE' : 'RECOVERY_REQUIRED',
    );
  });
}

for (const [capability, label] of [
  [false, 'unsupported'],
  [null, 'unknown'],
]) {
  test(`${label} absent-install rejects missing-formal POST before lease or writes`, async (t) => {
    const scene = await createScene(t, 'missing-formal');
    let leaseCalls = 0;
    let recoveryCalls = 0;
    const deps = scene.deps({
      platformCapabilities: {
        ...PLATFORM_CAPABILITIES,
        verifiedAbsentInstall: capability,
      },
      recoverV1Publication() {
        recoveryCalls += 1;
      },
      withProjectRecoveryLease(_filePath, callback) {
        leaseCalls += 1;
        return callback({ canonicalProjectKey: canonicalDatabasePath(scene.dbPath) });
      },
    });
    const diagnostics = inspectRegisteredProject('novel', deps);
    const before = snapshotTree(scene.root);

    assert.throws(
      () => recoverRegisteredProject('novel', {
        action: 'recover_v1_publication',
        snapshot: diagnostics.snapshot,
      }, deps),
      { code: 'RECOVERY_REQUIRED' },
    );
    assert.equal(leaseCalls, 0);
    assert.equal(recoveryCalls, 0);
    assert.deepEqual(snapshotTree(scene.root), before);
  });
}

for (const [label, bytesFactory] of [
  ['missing formal with no journal', null],
  ['empty SQLite', (SQL) => {
    const database = new SQL.Database();
    const bytes = Buffer.from(database.export());
    database.close();
    return bytes;
  }],
  ['project_meta without a domain table', (SQL) => {
    const database = new SQL.Database();
    database.run('CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.run("INSERT INTO project_meta VALUES ('schema_version', '10')");
    const bytes = Buffer.from(database.export());
    database.close();
    return bytes;
  }],
  ['invalid schema text', (SQL) => {
    const bytes = databaseBytes(SQL, 'invalid-schema');
    const database = new SQL.Database(bytes);
    database.run("UPDATE project_meta SET value = 'invalid' WHERE key = 'schema_version'");
    const changed = Buffer.from(database.export());
    database.close();
    return changed;
  }],
  ['unsafe integer schema', (SQL) => {
    const bytes = databaseBytes(SQL, 'huge-schema');
    const database = new SQL.Database(bytes);
    database.run("UPDATE project_meta SET value = '9007199254740992' WHERE key = 'schema_version'");
    const changed = Buffer.from(database.export());
    database.close();
    return changed;
  }],
]) {
  test(`${label} cannot be reported ready`, async (t) => {
    const diagnostics = await inspectCleanBytes(t, bytesFactory);
    assert.equal(diagnostics.state, 'isolated');
    assert.equal(diagnostics.canAutoRecover, false);
  });
}

test('registry A to B to A changes are stale before any captured-path recovery', async (t) => {
  const sceneA = await createScene(t, 'forward');
  const sceneB = await createScene(t, 'forward');
  const byPath = new Map([
    [sceneA.dbPath, sceneA.controlDir],
    [sceneB.dbPath, sceneB.controlDir],
  ]);
  const fixedB = sceneB.deps({
    getControlDirectory: (filePath) => byPath.get(filePath),
    lookupRegisteredProject: () => ({ name: 'novel', filePath: sceneB.dbPath }),
  });
  const snapshotB = inspectRegisteredProject('novel', fixedB).snapshot;
  const beforeA = snapshotTree(sceneA.root);
  const beforeB = snapshotTree(sceneB.root);
  const sequence = [sceneA.dbPath, sceneB.dbPath, sceneA.dbPath];
  let lookupCalls = 0;
  let recoverCalls = 0;
  const deps = sceneA.deps({
    getControlDirectory: (filePath) => byPath.get(filePath),
    lookupRegisteredProject() {
      const filePath = sequence[Math.min(lookupCalls, sequence.length - 1)];
      lookupCalls += 1;
      return { name: 'novel', filePath };
    },
    recoverV1Publication() {
      recoverCalls += 1;
    },
    withProjectRecoveryLease(filePath, callback) {
      assert.equal(filePath, sceneA.dbPath);
      return callback({ canonicalProjectKey: canonicalDatabasePath(sceneA.dbPath) });
    },
  });

  assert.throws(
    () => recoverRegisteredProject('novel', {
      action: 'recover_v1_publication',
      snapshot: snapshotB,
    }, deps),
    { code: 'RECOVERY_SNAPSHOT_STALE' },
  );
  assert.equal(recoverCalls, 0);
  assert.equal(lookupCalls, 2, 'the in-lease record must be resolved exactly once');
  assert.deepEqual(snapshotTree(sceneA.root), beforeA);
  assert.deepEqual(snapshotTree(sceneB.root), beforeB);
});

for (const [mode, reasonCode, canAutoRecover] of [
  ['forward', 'V1_PUBLICATION_FORWARD_RECOVERABLE', true],
  ['rollback', 'V1_PUBLICATION_ROLLBACK_RECOVERABLE', true],
  ['third', 'RECOVERY_REQUIRED', false],
]) {
  test(`${mode} v1 publication is classified without changing any data-root entry`, async (t) => {
    const scene = await createScene(t, mode);
    const before = snapshotTree(scene.root);

    const diagnostics = scene.inspect();

    assert.deepEqual(snapshotTree(scene.root), before);
    assert.equal(diagnostics.state, 'isolated');
    assert.equal(diagnostics.reasonCode, reasonCode);
    assert.equal(diagnostics.canAutoRecover, canAutoRecover);
    assert.equal(
      diagnostics.recommendedAction,
      canAutoRecover ? 'recover_v1_publication' : null,
    );
    assert.deepEqual(Object.keys(diagnostics).sort(), DTO_KEYS);
    assert.match(diagnostics.snapshot, /^[0-9a-f]{64}$/);
    assert.equal(diagnostics.projectInstanceIdSha256, sha256(Buffer.from('raw-instance-secret')));
    assert.equal(JSON.stringify(diagnostics).includes('raw-instance-secret'), false);
    assert.equal(JSON.stringify(diagnostics).includes(scene.root), false);
    assert.deepEqual(scene.inspect(), diagnostics, 'repeat inspection must have a stable snapshot');
  });
}

test('invalid and Stage A disabled recovery actions do not acquire a writer lease', async (t) => {
  const scene = await createScene(t, 'forward');
  const diagnostics = scene.inspect();
  let leaseCalls = 0;
  const deps = scene.deps({
    withProjectRecoveryLease() {
      leaseCalls += 1;
      throw new Error('must not acquire');
    },
  });

  assert.throws(
    () => recoverRegisteredProject('novel', { action: 'unknown', snapshot: diagnostics.snapshot }, deps),
    { code: 'INVALID_PARAMS' },
  );
  for (const action of ['recover_transaction', 'adopt_same_path_identity']) {
    assert.throws(
      () => recoverRegisteredProject('novel', { action, snapshot: diagnostics.snapshot }, deps),
      { code: 'NATIVE_ACTIVATION_DISABLED' },
    );
  }
  assert.equal(leaseCalls, 0);
});

test('unregistered disabled actions resolve the project before the disabled gate without a lease', () => {
  let lookupCalls = 0;
  let leaseCalls = 0;
  let recoveryCalls = 0;
  const deps = {
    lookupRegisteredProject() {
      lookupCalls += 1;
      return null;
    },
    withProjectRecoveryLease() {
      leaseCalls += 1;
      throw new Error('must not acquire');
    },
    recoverV1Publication() {
      recoveryCalls += 1;
    },
  };

  assert.throws(
    () => recoverRegisteredProject('missing', {
      action: 'unknown',
      snapshot: '1'.repeat(64),
    }, deps),
    { code: 'INVALID_PARAMS' },
  );
  assert.equal(lookupCalls, 0, 'format validation must happen before registry lookup');

  for (const action of ['recover_transaction', 'adopt_same_path_identity']) {
    assert.throws(
      () => recoverRegisteredProject('missing', {
        action,
        snapshot: '1'.repeat(64),
      }, deps),
      { code: 'PROJECT_NOT_FOUND' },
    );
  }
  assert.equal(lookupCalls, 2);
  assert.equal(leaseCalls, 0);
  assert.equal(recoveryCalls, 0);
});

test('a stale snapshot releases the lease without invoking v1 recovery', async (t) => {
  const scene = await createScene(t, 'rollback');
  const diagnostics = scene.inspect();
  fs.writeFileSync(scene.publication.candidatePath, scene.afterBytes);
  const before = snapshotTree(scene.root);
  let recoveryCalls = 0;
  let leaseCalls = 0;

  assert.throws(
    () => recoverRegisteredProject('novel', {
      action: 'recover_v1_publication',
      snapshot: diagnostics.snapshot,
    }, scene.deps({
      recoverV1Publication() {
        recoveryCalls += 1;
      },
      withProjectRecoveryLease(_filePath, callback) {
        leaseCalls += 1;
        return callback({ canonicalProjectKey: canonicalDatabasePath(scene.dbPath) });
      },
    })),
    { code: 'RECOVERY_SNAPSHOT_STALE' },
  );
  assert.equal(leaseCalls, 1);
  assert.equal(recoveryCalls, 0);
  assert.deepEqual(snapshotTree(scene.root), before);
});

test('writer busy is reported before inspection or recovery changes protocol evidence', async (t) => {
  const scene = await createScene(t, 'forward');
  const diagnostics = scene.inspect();
  const before = snapshotTree(scene.root);
  const busy = Object.assign(new Error('busy'), { code: 'PROJECT_WRITE_BUSY' });
  assert.throws(
    () => recoverRegisteredProject('novel', {
      action: 'recover_v1_publication',
      snapshot: diagnostics.snapshot,
    }, scene.deps({
      withProjectRecoveryLease() {
        throw busy;
      },
    })),
    (error) => error === busy,
  );
  assert.deepEqual(snapshotTree(scene.root), before);
});

for (const mode of ['forward', 'rollback']) {
  test(`explicit ${mode} v1 recovery converges to ready after snapshot validation`, async (t) => {
    const scene = await createScene(t, mode);
    const before = scene.inspect();

    const after = recoverRegisteredProject('novel', {
      action: 'recover_v1_publication',
      snapshot: before.snapshot,
    }, scene.deps());

    assert.equal(after.state, 'ready');
    assert.equal(after.reasonCode, null);
    assert.equal(after.canAutoRecover, false);
    assert.equal(after.recommendedAction, null);
    assert.notEqual(after.snapshot, before.snapshot);
    assert.match(after.controlStore.tail.digest, /^[0-9a-f]{64}$/);
    assert.equal(
      after.controlStore.events.at(-1).type,
      mode === 'forward' ? 'sqlite.publish.committed' : 'sqlite.publish.rolled_back',
    );
  });
}
