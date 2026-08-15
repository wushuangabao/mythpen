const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openControlStore } = require('../control-store');
const {
  assertPublicationJournalRetirable,
  createAtomicStore: createAtomicStoreWithProductionDurability,
} = require('../sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { runUntilCrash } = require('../testing/crash-harness');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');
const {
  DurabilityUnsupportedError,
  InstallTargetExistsError,
  LeaseBusyError,
  LeaseLostError,
  TargetLockedError,
  VerifiedInstallError,
  VerifiedSourceMismatchError,
  VerifiedSourceTopologyError,
  atomicReplace,
  installAbsentFromVerifiedSource: installAbsentFromVerifiedSourceDurably,
} = require('../platform/durability');
const { createWin32Backend } = require('../platform/durability-win32');

const durabilityErrors = {
  DurabilityUnsupportedError,
  InstallTargetExistsError,
  LeaseBusyError,
  LeaseLostError,
  TargetLockedError,
  VerifiedInstallError,
  VerifiedSourceMismatchError,
  VerifiedSourceTopologyError,
  attachCleanupError(primaryError, cleanupError) {
    if (!cleanupError) return primaryError;
    primaryError.cleanupError = cleanupError;
    primaryError.secondaryErrors = [...(primaryError.secondaryErrors || []), cleanupError];
    return primaryError;
  },
};

function createScene(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-sqljs-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    controlDir: path.join(root, 'control'),
    dbPath: path.join(root, 'project.mythpen.db'),
    root,
  };
}

function runOpenWorker(filePath, controlDirectory) {
  const fixture = path.join(__dirname, 'fixtures', 'atomic-store-open-worker.js');
  const child = spawn(process.execPath, [fixture, filePath, controlDirectory], {
    cwd: path.resolve(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function findArtifacts(root, suffix) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...findArtifacts(entryPath, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(entryPath);
  }
  return found;
}

async function loadSqlModule() {
  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  return initSqlJs({ wasmBinary: getWasmBinary() });
}

function readScalar(database, sql) {
  const statement = database.prepare(sql);
  try {
    assert.equal(statement.step(), true);
    return statement.get()[0];
  } finally {
    statement.free();
  }
}

function assertHealthyDatabaseBytes(SQL, bytes) {
  const database = new SQL.Database(bytes);
  try {
    assert.equal(readScalar(database, 'PRAGMA integrity_check'), 'ok');
    const foreignKeyCheck = database.exec('PRAGMA foreign_key_check');
    assert.deepEqual(foreignKeyCheck, []);
  } finally {
    database.close();
  }
}

function readRows(database, sql) {
  const statement = database.prepare(sql);
  try {
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function loadNativeKernel32ForTest() {
  const { dlopen, FFIType, ptr } = require('bun:ffi');
  const library = dlopen('kernel32.dll', {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.u64,
    },
    GetFileInformationByHandle: {
      args: [FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    ReadFile: {
      args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    SetFileInformationByHandle: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  return { library, ptr, symbols: library.symbols };
}

function installVerifiedSourceForTest(
  sourcePath,
  targetPath,
  expectedIdentity,
  expectedSha256,
) {
  assert.deepEqual(fileIdentity(sourcePath), expectedIdentity);
  assert.equal(sha256(fs.readFileSync(sourcePath)), expectedSha256);
  fs.linkSync(sourcePath, targetPath);
  fs.unlinkSync(sourcePath);
  return { installed: true, sourceDisposition: 'moved' };
}

function createAtomicStore(options) {
  return createAtomicStoreWithProductionDurability({
    installAbsentFromVerifiedSource: installVerifiedSourceForTest,
    ...options,
  });
}

function recordedIdentity(filePath, expectedBytes) {
  try {
    if (sha256(fs.readFileSync(filePath)) === sha256(expectedBytes)) return fileIdentity(filePath);
  } catch {
    // Historical tests may describe a before/after file that is no longer formal.
  }
  return { dev: '0', ino: '0' };
}

function canonicalFilePath(filePath) {
  const missing = [];
  let existing = path.normalize(path.resolve(filePath));
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const physical = path.join(fs.realpathSync.native(existing), ...missing);
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

function exportWithForeignKeys(database) {
  const bytes = Buffer.from(database.export());
  database.run('PRAGMA foreign_keys = ON');
  return bytes;
}

function databaseBytes(SQL, value) {
  const database = new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  database.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  database.run('INSERT INTO entries (id, value) VALUES (1, ?)', [value]);
  const bytes = exportWithForeignKeys(database);
  database.close();
  return bytes;
}

function replaceWithSameBytes(filePath, replacementPath) {
  const bytes = fs.readFileSync(filePath);
  const beforeIdentity = fileIdentity(filePath);
  fs.writeFileSync(replacementPath, bytes);
  atomicReplace(replacementPath, filePath, { attempts: 1, backoffMs: 0 });
  const afterIdentity = fileIdentity(filePath);
  assert.notDeepEqual(afterIdentity, beforeIdentity);
  assert.deepEqual(fs.readFileSync(filePath), bytes);
  return { afterIdentity, beforeIdentity };
}

function publicationPaths({ controlDir, dbPath, publicationId }) {
  const canonicalPath = canonicalFilePath(dbPath);
  const dbKey = sha256(Buffer.from(canonicalPath));
  return {
    backupPath: path.join(
      path.resolve(controlDir),
      'sqlite-recovery',
      dbKey,
      `${publicationId}.before.db`,
    ),
    candidatePath: path.join(
      path.dirname(path.resolve(dbPath)),
      `.${path.basename(dbPath)}.${publicationId}.candidate.db`,
    ),
    rollbackPath: path.join(
      path.dirname(path.resolve(dbPath)),
      `.${path.basename(dbPath)}.${publicationId}.rollback.db`,
    ),
    canonicalPath,
    dbKey,
  };
}

function appendPrepared(controlStore, {
  beforeBytes,
  candidateBytes,
  controlDir,
  dbPath,
  mutateEvent,
  publicationId = crypto.randomUUID(),
}) {
  const {
    backupPath,
    candidatePath,
    canonicalPath,
    dbKey,
    rollbackPath,
  } = publicationPaths({
    controlDir,
    dbPath,
    publicationId,
  });
  const beforeExists = beforeBytes !== null;
  const afterSha256 = sha256(candidateBytes);
  const event = {
    type: 'sqlite.publish.prepared',
    payload: {
      version: 1,
      publicationId,
      dbKey,
      before: {
        exists: beforeExists,
        sha256: beforeExists ? sha256(beforeBytes) : null,
        identity: beforeExists ? recordedIdentity(dbPath, beforeBytes) : null,
        backupPath: beforeExists ? backupPath : null,
      },
      candidate: { path: candidatePath, sha256: afterSha256 },
      after: { sha256: afterSha256 },
    },
    afterPredicate: { filePath: canonicalPath, sha256: afterSha256 },
  };
  mutateEvent?.(event);
  controlStore.append(event);
  return {
    backupPath,
    candidatePath,
    canonicalPath,
    dbKey,
    dbPath,
    publicationId,
    rollbackPath,
  };
}

function appendCommitted(controlStore, publication, afterBytes) {
  controlStore.append({
    type: 'sqlite.publish.committed',
    payload: {
      version: 1,
      publicationId: publication.publicationId,
      dbKey: publication.dbKey,
    },
    afterPredicate: {
      filePath: publication.canonicalPath,
      exists: true,
      sha256: sha256(afterBytes),
      identity: recordedIdentity(publication.dbPath, afterBytes),
    },
  });
}

function appendRollbackInstalling(controlStore, publication, rollbackBytes, mutateEvent) {
  const rollbackIdentity = fileIdentity(publication.rollbackPath);
  const rollbackSha256 = sha256(rollbackBytes);
  const event = {
    type: 'sqlite.publish.rollback_installing',
    payload: {
      version: 1,
      publicationId: publication.publicationId,
      dbKey: publication.dbKey,
      rollback: {
        path: publication.rollbackPath,
        sha256: rollbackSha256,
        identity: rollbackIdentity,
      },
    },
    afterPredicate: {
      filePath: publication.canonicalPath,
      exists: true,
      sha256: rollbackSha256,
      identity: rollbackIdentity,
    },
  };
  mutateEvent?.(event);
  controlStore.append(event);
  return event;
}

function createRecoveryBranch(t, SQL, mode) {
  const scene = createScene(t);
  const beforeBytes = databaseBytes(SQL, `${mode} before`);
  const afterBytes = databaseBytes(SQL, `${mode} after`);
  fs.writeFileSync(scene.dbPath, beforeBytes);
  const controlStore = openControlStore(scene.controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir: scene.controlDir,
    dbPath: scene.dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);

  if (mode === 'existing-after') {
    const replacementPath = path.join(scene.root, 'existing-after.db');
    fs.writeFileSync(replacementPath, afterBytes);
    atomicReplace(replacementPath, scene.dbPath, { attempts: 1, backoffMs: 0 });
  } else if (mode === 'candidate-forward') {
    fs.writeFileSync(publication.candidatePath, afterBytes);
  } else if (mode === 'missing-before' || mode === 'rollback-resume') {
    fs.rmSync(scene.dbPath);
    if (mode === 'rollback-resume') {
      fs.writeFileSync(publication.rollbackPath, beforeBytes);
      appendRollbackInstalling(controlStore, publication, beforeBytes);
    }
  }

  return {
    ...scene,
    afterBytes,
    beforeBytes,
    controlStore,
    publication,
  };
}

test('an unfinished publication cannot be retired into a new database incarnation', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const controlStore = openControlStore(controlDir);
  appendPrepared(controlStore, {
    beforeBytes: null,
    candidateBytes: databaseBytes(SQL, 'candidate'),
    controlDir,
    dbPath,
  });
  const retiredDir = `${controlDir}.retired-${crypto.randomUUID()}`;

  assert.throws(
    () => controlStore.retire(retiredDir, (events) => {
      assertPublicationJournalRetirable({
        filePath: dbPath,
        controlDirectory: controlDir,
        events,
      });
    }),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(fs.existsSync(controlDir), true);
  assert.equal(fs.existsSync(retiredDir), false);
});

test('a malformed publication journal rejects retirement with the stable recovery error', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const controlStore = openControlStore(controlDir);
  appendPrepared(controlStore, {
    beforeBytes: databaseBytes(SQL, 'before'),
    candidateBytes: databaseBytes(SQL, 'candidate'),
    controlDir,
    dbPath,
    mutateEvent(event) {
      event.payload.before.backupPath = null;
    },
  });
  const retiredDir = `${controlDir}.retired-${crypto.randomUUID()}`;

  assert.throws(
    () => controlStore.retire(retiredDir, (events) => {
      assertPublicationJournalRetirable({
        filePath: dbPath,
        controlDirectory: controlDir,
        events,
      });
    }),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(fs.existsSync(controlDir), true);
  assert.equal(fs.existsSync(retiredDir), false);
});

test('publish atomically installs a verified sql.js candidate', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const database = store.currentConnection();
  database.run('PRAGMA foreign_keys = ON');
  database.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  database.run("INSERT INTO entries (id, value) VALUES (1, 'after')");

  store.publish(database);

  const reopened = new SQL.Database(fs.readFileSync(dbPath));
  try {
    assert.equal(readScalar(reopened, 'PRAGMA integrity_check'), 'ok');
    assert.equal(readScalar(reopened, 'SELECT value FROM entries WHERE id = 1'), 'after');
  } finally {
    reopened.close();
  }
});

test('publish journals versioned before and after evidence with controlled paths', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeDatabase = new SQL.Database();
  beforeDatabase.run('PRAGMA foreign_keys = ON');
  beforeDatabase.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  beforeDatabase.run("INSERT INTO entries (id, value) VALUES (1, 'before')");
  const beforeBytes = exportWithForeignKeys(beforeDatabase);
  beforeDatabase.close();
  fs.writeFileSync(dbPath, beforeBytes);
  const beforeIdentity = fileIdentity(dbPath);

  const controlStore = openControlStore(controlDir);
  assert.equal(controlStore.directory, path.resolve(controlDir));
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const database = store.currentConnection();
  database.run("UPDATE entries SET value = 'after' WHERE id = 1");

  store.publish(database);

  const afterBytes = fs.readFileSync(dbPath);
  const afterIdentity = fileIdentity(dbPath);
  const dbKey = sha256(Buffer.from(canonicalFilePath(dbPath)));
  const [prepared, committed] = controlStore.read();
  assert.equal(prepared.type, 'sqlite.publish.prepared');
  assert.equal(prepared.payload.version, 1);
  assert.match(prepared.payload.publicationId, /^[0-9a-f-]{36}$/);
  assert.equal(prepared.payload.dbKey, dbKey);
  assert.deepEqual(prepared.payload.before, {
    exists: true,
    sha256: sha256(beforeBytes),
    identity: beforeIdentity,
    backupPath: path.join(
      path.resolve(controlDir),
      'sqlite-recovery',
      dbKey,
      `${prepared.payload.publicationId}.before.db`,
    ),
  });
  assert.deepEqual(prepared.payload.candidate, {
    path: path.join(
      path.dirname(path.resolve(dbPath)),
      `.${path.basename(dbPath)}.${prepared.payload.publicationId}.candidate.db`,
    ),
    sha256: sha256(afterBytes),
  });
  assert.deepEqual(prepared.payload.after, { sha256: sha256(afterBytes) });
  assert.deepEqual(prepared.afterPredicate, {
    filePath: canonicalFilePath(dbPath),
    sha256: sha256(afterBytes),
  });

  assert.equal(committed.type, 'sqlite.publish.committed');
  assert.deepEqual(committed.payload, {
    version: 1,
    publicationId: prepared.payload.publicationId,
    dbKey,
  });
  assert.deepEqual(committed.afterPredicate, {
    filePath: canonicalFilePath(dbPath),
    exists: true,
    sha256: sha256(afterBytes),
    identity: afterIdentity,
  });
  assert.equal(fs.existsSync(prepared.payload.before.backupPath), false);
  assert.equal(fs.existsSync(prepared.payload.candidate.path), false);
});

test('a corrupt candidate is rejected before journal or formal publication', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeDatabase = new SQL.Database();
  beforeDatabase.run('PRAGMA foreign_keys = ON');
  beforeDatabase.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  beforeDatabase.run("INSERT INTO entries (id, value) VALUES (1, 'before')");
  const beforeBytes = exportWithForeignKeys(beforeDatabase);
  beforeDatabase.close();
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const database = store.currentConnection();
  database.run("UPDATE entries SET value = 'after' WHERE id = 1");

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_CORRUPT_CANDIDATE]: { active: true },
  }, async () => {
    assert.throws(
      () => store.publish(database),
      { code: 'CANDIDATE_VERIFICATION_FAILED' },
    );
  });

  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.deepEqual(controlStore.read(), []);
  assert.equal(readScalar(database, 'PRAGMA foreign_keys'), 1);
  assert.equal(readScalar(database, 'SELECT value FROM entries WHERE id = 1'), 'after');
});

test('verifier cleanup failure never replaces the candidate verification primary error', async (t) => {
  const SQL = await loadSqlModule();
  const sqlModule = { ...SQL, Database: SQL.Database };
  const { controlDir, dbPath } = createScene(t);
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule,
  });
  const database = store.currentConnection();
  database.run('CREATE TABLE parents (id INTEGER PRIMARY KEY)');
  database.run(`CREATE TABLE children (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER NOT NULL REFERENCES parents(id)
  )`);
  database.run('PRAGMA foreign_keys = OFF');
  database.run('INSERT INTO children (id, parent_id) VALUES (1, 999)');
  database.run('PRAGMA foreign_keys = ON');
  const cleanupError = new Error('injected verifier close cleanup failure');
  sqlModule.Database = new Proxy(SQL.Database, {
    construct(Target, args) {
      const verifier = Reflect.construct(Target, args);
      verifier.close = () => { throw cleanupError; };
      return verifier;
    },
  });

  assert.throws(
    () => store.publish(database),
    (error) => (
      error.code === 'CANDIDATE_VERIFICATION_FAILED'
      && error.cause?.message.includes('foreign_key_check')
      && error.verifierCleanupError === cleanupError
      && error.secondaryErrors?.includes(cleanupError)
    ),
  );
  assert.equal(fs.existsSync(dbPath), false);
});

test('publishing fences old epoch connections and prepared statements', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const staleEpoch = store.connectionEpoch;
  const stale = store.currentConnection();
  stale.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  stale.run("INSERT INTO entries (id, value) VALUES (1, 'published')");
  const staleStatement = stale.prepare('SELECT value FROM entries WHERE id = 1');

  store.publish(stale);

  assert.equal(store.connectionEpoch, staleEpoch + 1);
  assert.throws(() => store.assertEpoch(staleEpoch), { code: 'DB_CONNECTION_STALE' });
  assert.throws(
    () => stale.run("INSERT INTO entries (id, value) VALUES (2, 'stale')"),
    { code: 'DB_CONNECTION_STALE' },
  );
  assert.throws(() => staleStatement.step(), { code: 'DB_CONNECTION_STALE' });
  assert.equal(
    readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
    'published',
  );
});

test('recover commits an exact formal after state without requiring the obsolete before backup', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, afterBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });

  assert.deepEqual(store.recover(), {
    status: 'committed',
    publicationId: publication.publicationId,
  });

  assert.equal(controlStore.tail().type, 'sqlite.publish.committed');
  assert.equal(
    readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
    'after',
  );
  assert.equal(fs.existsSync(publication.backupPath), false);
});

test('a prepared append rejected before publication keeps the live candidate retryable and cleans artifacts', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const live = store.currentConnection();
  live.run("UPDATE entries SET value = 'after' WHERE id = 1");

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: { throw: 'EIO' },
  }, async () => {
    assert.throws(() => store.publish(live), { code: 'EIO' });
  });

  assert.deepEqual(controlStore.read(), []);
  assert.equal(store.currentConnection(), live);
  assert.equal(readScalar(live, 'SELECT value FROM entries WHERE id = 1'), 'after');
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.deepEqual(
    fs.readdirSync(path.dirname(dbPath)).filter((name) => name.endsWith('.candidate.db')),
    [],
  );
  store.publish(live);
  assert.equal(readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'), 'after');
});

test('an uncertain prepared append fences the live epoch until journal recovery completes', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'before'));
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const stale = store.currentConnection();
  const staleEpoch = store.connectionEpoch;
  stale.run("UPDATE entries SET value = 'after' WHERE id = 1");

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC]: { throw: 'EIO' },
  }, async () => {
    assert.throws(() => store.publish(stale), { code: 'EIO' });
  });

  assert.equal(controlStore.tail().type, 'sqlite.publish.prepared');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(store.recover(), {
    status: 'committed',
    publicationId: controlStore.read()[0].payload.publicationId,
  });
  assert.equal(store.connectionEpoch, staleEpoch + 1);
  assert.throws(() => stale.run('SELECT 1'), { code: 'DB_CONNECTION_STALE' });
  assert.equal(readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'), 'after');
});

test('recover forwards an exact candidate when the formal database is still the exact before state', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.writeFileSync(publication.candidatePath, afterBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.deepEqual(store.recover(), {
    status: 'committed',
    publicationId: publication.publicationId,
  });

  assert.deepEqual(fs.readFileSync(dbPath), afterBytes);
  assert.equal(
    readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
    'after',
  );
  assert.equal(controlStore.tail().type, 'sqlite.publish.committed');
  assert.equal(fs.existsSync(publication.candidatePath), false);
  assert.equal(fs.existsSync(publication.backupPath), false);
});

test('recover rolls back when the formal before is exact and the candidate is missing or mismatched', async (t) => {
  const SQL = await loadSqlModule();
  for (const candidateState of ['missing', 'mismatched']) {
    const { controlDir, dbPath } = createScene(t);
    const beforeBytes = databaseBytes(SQL, `before-${candidateState}`);
    const afterBytes = databaseBytes(SQL, `after-${candidateState}`);
    fs.writeFileSync(dbPath, beforeBytes);
    const controlStore = openControlStore(controlDir);
    const publication = appendPrepared(controlStore, {
      beforeBytes,
      candidateBytes: afterBytes,
      controlDir,
      dbPath,
    });
    if (candidateState === 'mismatched') {
      fs.writeFileSync(publication.candidatePath, databaseBytes(SQL, 'not-the-after-state'));
    }
    const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

    assert.deepEqual(store.recover(), {
      status: 'rolled_back',
      publicationId: publication.publicationId,
    }, candidateState);

    assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, candidateState);
    assert.deepEqual(controlStore.tail(), {
      seq: 2,
      type: 'sqlite.publish.rolled_back',
      payload: {
        version: 1,
        publicationId: publication.publicationId,
        dbKey: publication.dbKey,
      },
      prevDigest: controlStore.read()[0].digest,
      afterPredicate: {
        filePath: publication.canonicalPath,
        exists: true,
        sha256: sha256(beforeBytes),
        identity: fileIdentity(dbPath),
      },
      digest: controlStore.tail().digest,
    }, candidateState);
    assert.equal(
      readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
      `before-${candidateState}`,
      candidateState,
    );
    assert.equal(fs.existsSync(publication.candidatePath), false, candidateState);
    assert.equal(fs.existsSync(publication.backupPath), false, candidateState);
  }
});

test('recover restores a missing formal database from the exact before backup even if the candidate remains', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'restored-before');
  const afterBytes = databaseBytes(SQL, 'lost-after');
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.writeFileSync(publication.candidatePath, afterBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.deepEqual(store.recover(), {
    status: 'rolled_back',
    publicationId: publication.publicationId,
  });

  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  const events = controlStore.read();
  assert.deepEqual(events.map((event) => event.type), [
    'sqlite.publish.prepared',
    'sqlite.publish.rollback_installing',
    'sqlite.publish.rolled_back',
  ]);
  const [prepared, rollbackIntent, terminal] = events;
  assert.equal(prepared.type, 'sqlite.publish.prepared');
  assert.deepEqual(rollbackIntent, {
    seq: 2,
    type: 'sqlite.publish.rollback_installing',
    payload: {
      version: 1,
      publicationId: publication.publicationId,
      dbKey: publication.dbKey,
      rollback: {
        path: publication.rollbackPath,
        sha256: sha256(beforeBytes),
        identity: terminal.afterPredicate.identity,
      },
    },
    prevDigest: prepared.digest,
    afterPredicate: terminal.afterPredicate,
    digest: rollbackIntent.digest,
  });
  assert.equal(terminal.type, 'sqlite.publish.rolled_back');
  assert.equal(terminal.seq, 3);
  assert.equal(terminal.prevDigest, rollbackIntent.digest);
  assert.equal(
    readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
    'restored-before',
  );
});

for (const point of ['after-rollback-replace', 'after-rollback-dir-fsync']) {
  test(`a successor converges after injected interruption at atomicstore.recover.${point}`, async (t) => {
    const SQL = await loadSqlModule();
    const { controlDir, dbPath } = createScene(t);
    const beforeBytes = databaseBytes(SQL, `before ${point}`);
    const afterBytes = databaseBytes(SQL, `after ${point}`);
    fs.writeFileSync(dbPath, beforeBytes);
    const controlStore = openControlStore(controlDir);
    const publication = appendPrepared(controlStore, {
      beforeBytes,
      candidateBytes: afterBytes,
      controlDir,
      dbPath,
    });
    fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
    fs.writeFileSync(publication.backupPath, beforeBytes);
    fs.writeFileSync(publication.candidatePath, afterBytes);
    fs.rmSync(dbPath);
    const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
    const faultName = `atomicstore.recover.${point}`;

    await withFaults({ [faultName]: { throw: 'EIO' } }, async () => {
      assert.throws(
        () => store.recover(),
        (error) => error.code === 'EIO' && error.faultPoint === faultName,
      );
    });
    assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
    assert.equal(fs.existsSync(publication.rollbackPath), false);
    assert.equal(fs.existsSync(publication.backupPath), true);
    assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
    assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
    store.close();

    const successor = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
    assert.deepEqual(successor.recover(), {
      publicationId: publication.publicationId,
      status: 'rolled_back',
    });
    assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
    assert.equal(controlStore.tail().type, 'sqlite.publish.rolled_back');
    assert.equal(fs.existsSync(publication.backupPath), false);
    assert.equal(fs.existsSync(publication.candidatePath), false);
    assert.equal(readScalar(successor.currentConnection(), 'SELECT value FROM entries'), `before ${point}`);
    successor.close();
  });
}

test('recover rolls back an unpublished first database without creating the formal file', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const afterBytes = databaseBytes(SQL, 'never-published');
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes: null,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.deepEqual(store.recover(), {
    status: 'rolled_back',
    publicationId: publication.publicationId,
  });

  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(controlStore.tail().afterPredicate, {
    filePath: publication.canonicalPath,
    exists: false,
    sha256: null,
    identity: null,
  });
  assert.equal(readScalar(store.currentConnection(), 'PRAGMA integrity_check'), 'ok');
});

test('a SQLite journal for the wrong dbKey fences recovery instead of being ignored', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
    mutateEvent(event) {
      event.payload.dbKey = '0'.repeat(64);
    },
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.writeFileSync(publication.candidatePath, afterBytes);

  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(controlStore.read().length, 1);
  assert.equal(fs.existsSync(publication.backupPath), true);
  assert.equal(fs.existsSync(publication.candidatePath), true);
});

test('an inexact version-1 prepared event is fenced without touching artifacts', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
    mutateEvent(event) {
      event.payload.unexpected = 'not part of version 1';
    },
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.writeFileSync(publication.candidatePath, afterBytes);

  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(fs.existsSync(publication.backupPath), true);
  assert.equal(fs.existsSync(publication.candidatePath), true);
  assert.equal(controlStore.read().length, 1);
});

test('a third formal byte state is preserved and fenced as RECOVERY_REQUIRED', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  const thirdBytes = databaseBytes(SQL, 'third');
  fs.writeFileSync(dbPath, thirdBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.writeFileSync(publication.candidatePath, afterBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(fs.readFileSync(dbPath), thirdBytes);
  assert.equal(fs.existsSync(publication.backupPath), true);
  assert.equal(fs.existsSync(publication.candidatePath), true);
  assert.equal(controlStore.read().length, 1);
});

test('multiple unfinished prepared publications are preserved and fenced', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const first = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  const second = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  for (const publication of [first, second]) {
    fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
    fs.writeFileSync(publication.backupPath, beforeBytes);
    fs.writeFileSync(publication.candidatePath, afterBytes);
  }
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(controlStore.read().length, 2);
  assert.ok([first, second].every((publication) => (
    fs.existsSync(publication.backupPath) && fs.existsSync(publication.candidatePath)
  )));
});

for (const point of [
  'before-candidate-write',
  'after-candidate-write',
  'before-replace',
  'after-replace',
  'before-epoch-install',
]) {
  test(`real crash at atomicstore.publish.${point} leaves only exact before or after bytes`, async (t) => {
    const SQL = await loadSqlModule();
    const { root } = createScene(t);
    const faultName = `atomicstore.publish.${point}`;
    const crash = await runUntilCrash({
      script: path.join(__dirname, 'fixtures', 'sqljs-atomic-store-crash.js'),
      faults: { [faultName]: { crash: true } },
      env: { MYTHPEN_ATOMIC_STORE_CRASH_ROOT: root },
    });
    t.after(() => crash.cleanup());

    assert.equal(crash.crashPoint.name, faultName);
    const formalBytes = fs.readFileSync(crash.artifacts.dbPath);
    const beforeBytes = fs.readFileSync(crash.artifacts.beforePath);
    const afterBytes = fs.readFileSync(crash.artifacts.afterPath);
    assert.equal(
      formalBytes.equals(beforeBytes) || formalBytes.equals(afterBytes),
      true,
      `${point} produced a third formal byte state`,
    );
    assertHealthyDatabaseBytes(SQL, formalBytes);

    const controlStore = openControlStore(crash.artifacts.controlDir);
    const store = createAtomicStore({
      filePath: crash.artifacts.dbPath,
      controlStore,
      sqlModule: SQL,
    });
    store.recover();
    const recoveredBytes = fs.readFileSync(crash.artifacts.dbPath);
    assert.equal(
      recoveredBytes.equals(beforeBytes) || recoveredBytes.equals(afterBytes),
      true,
      `${point} recovery produced a third formal byte state`,
    );
    assertHealthyDatabaseBytes(SQL, recoveredBytes);
    assert.equal(readScalar(store.currentConnection(), 'PRAGMA foreign_keys'), 1);
  });
}

test('db.js transactions publish every project table without directly overwriting the formal file', async (t) => {
  withIsolatedDataDir(t);
  const SQL = await loadSqlModule();
  const db = require('../db');
  await db.initDatabase();
  const projectName = 'atomic-all-tables';
  const dbPath = db.getProjectDbPath(projectName);
  const projectDb = db.createProjectDb(projectName);
  const originalWriteFileSync = fs.writeFileSync;
  let directFormalWrites = 0;
  fs.writeFileSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(dbPath)) directFormalWrites += 1;
    return originalWriteFileSync(target, ...args);
  };
  try {
    withRawManuscriptSetup(() => projectDb.transaction(() => {
      projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('atomic_sentinel', 'meta')").run();
      projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
      projectDb.prepare(`INSERT INTO chapters
        (id, volume_id, num, title, content, word_count, status)
        VALUES (1, 1, 1, 'Chapter', 'Body', 4, 'writing')`).run();
      projectDb.prepare(`INSERT INTO characters
        (id, name, role, personality) VALUES ('character-1', 'Alice', 'major', 'steady')`).run();
      projectDb.prepare(`INSERT INTO chapter_characters
        (chapter_id, character_id, role) VALUES (1, 'character-1', 'pov')`).run();
      projectDb.prepare(`INSERT INTO world_entries
        (id, category, name, description) VALUES ('world-1', 'place', 'Harbor', 'fog')`).run();
      projectDb.prepare("INSERT INTO project_genres (genre) VALUES ('sci-fi')").run();
      projectDb.prepare(`INSERT INTO sidebar_items
        (id, label_key, icon, category, genres, sort_order, route, enabled)
        VALUES ('sidebar-sentinel', 'sidebar.sentinel', 'Circle', 'optional', '', 99, 'page-sentinel', 1)`).run();
      projectDb.prepare(`INSERT INTO foreshadows
        (id, title, status, planted_chapter_id, priority)
        VALUES ('foreshadow-1', 'Promise', 'planted', 1, 'normal')`).run();
      projectDb.prepare(`INSERT INTO memories
        (id, category, content, source_chapter_id)
        VALUES ('memory-1', 'event', 'Remember', 1)`).run();
      projectDb.prepare(`INSERT INTO character_relations
        (id, character_a_id, character_b_id, relation_type, description)
        VALUES ('relation-1', 'character-1', 'character-1', 'ally', 'bond')`).run();
      projectDb.prepare(`INSERT INTO science_entries
        (id, label, name, description)
        VALUES ('science-1', 'known', 'Law', 'stable')`).run();
      projectDb.prepare(`INSERT INTO timeline_events
        (id, year, title, sort_order) VALUES ('timeline-1', '1', 'Arrival', 1)`).run();
      projectDb.prepare(`INSERT INTO clue_board
        (id, title, kind, related_chapter_id, resolved)
        VALUES ('clue-1', 'Clue', 'clue', 1, 0)`).run();
      projectDb.prepare(`INSERT INTO token_usage
        (task_name, chapter_num, input_tokens, output_tokens, model)
        VALUES ('writing', 1, 10, 20, 'test-model')`).run();
      projectDb.prepare(`INSERT INTO chat_sessions
        (id, title) VALUES ('session-1', 'Session')`).run();
      projectDb.prepare(`INSERT INTO chat_messages
        (id, session_id, role, content) VALUES ('message-1', 'session-1', 'user', 'hello')`).run();
      projectDb.prepare(`INSERT INTO chapter_revisions
        (chapter_id, base_content, proposed_content, status, previous_chapter_status)
        VALUES (1, 'Body', 'Revised body', 'pending', 'writing')`).run();
    })());
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(directFormalWrites, 0);
  const disk = new SQL.Database(fs.readFileSync(dbPath));
  try {
    assertHealthyDatabaseBytes(SQL, fs.readFileSync(dbPath));
    assert.deepEqual(
      readRows(disk, `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(({ name }) => name),
      [
        'chapter_characters',
        'chapter_revisions',
        'chapters',
        'character_relations',
        'characters',
        'chat_messages',
        'chat_sessions',
        'clue_board',
        'foreshadows',
        'memories',
        'project_genres',
        'project_meta',
        'science_entries',
        'sidebar_items',
        'timeline_events',
        'token_usage',
        'volumes',
        'world_entries',
      ],
    );
    const sentinelQueries = {
      project_meta: "SELECT value FROM project_meta WHERE key = 'atomic_sentinel'",
      volumes: 'SELECT title AS value FROM volumes WHERE id = 1',
      chapters: 'SELECT content AS value FROM chapters WHERE id = 1',
      characters: "SELECT name AS value FROM characters WHERE id = 'character-1'",
      chapter_characters: "SELECT role AS value FROM chapter_characters WHERE chapter_id = 1 AND character_id = 'character-1'",
      world_entries: "SELECT description AS value FROM world_entries WHERE id = 'world-1'",
      project_genres: "SELECT genre AS value FROM project_genres WHERE genre = 'sci-fi'",
      sidebar_items: "SELECT route AS value FROM sidebar_items WHERE id = 'sidebar-sentinel'",
      foreshadows: "SELECT title AS value FROM foreshadows WHERE id = 'foreshadow-1'",
      memories: "SELECT content AS value FROM memories WHERE id = 'memory-1'",
      character_relations: "SELECT description AS value FROM character_relations WHERE id = 'relation-1'",
      science_entries: "SELECT description AS value FROM science_entries WHERE id = 'science-1'",
      timeline_events: "SELECT title AS value FROM timeline_events WHERE id = 'timeline-1'",
      clue_board: "SELECT title AS value FROM clue_board WHERE id = 'clue-1'",
      token_usage: "SELECT model AS value FROM token_usage WHERE task_name = 'writing'",
      chat_sessions: "SELECT title AS value FROM chat_sessions WHERE id = 'session-1'",
      chat_messages: "SELECT content AS value FROM chat_messages WHERE id = 'message-1'",
      chapter_revisions: "SELECT proposed_content AS value FROM chapter_revisions WHERE chapter_id = 1",
    };
    for (const [table, sql] of Object.entries(sentinelQueries)) {
      assert.notEqual(readRows(disk, sql)[0]?.value, undefined, `${table} sentinel must reopen`);
    }
    assert.deepEqual(readRows(disk, 'SELECT id, title, content FROM chapters'), [
      { id: 1, title: 'Chapter', content: 'Body' },
    ]);
    assert.deepEqual(readRows(disk, 'SELECT id, name, role FROM characters'), [
      { id: 'character-1', name: 'Alice', role: 'major' },
    ]);
    assert.deepEqual(readRows(disk, 'SELECT id, name, description FROM world_entries'), [
      { id: 'world-1', name: 'Harbor', description: 'fog' },
    ]);
    assert.deepEqual(readRows(disk, 'SELECT id, session_id, role, content FROM chat_messages'), [
      { id: 'message-1', session_id: 'session-1', role: 'user', content: 'hello' },
    ]);
    assert.deepEqual(readRows(disk, 'SELECT task_name, input_tokens, output_tokens FROM token_usage'), [
      { task_name: 'writing', input_tokens: 10, output_tokens: 20 },
    ]);
  } finally {
    disk.close();
  }
});

test('a failed control-directory retirement never starts the replacement incarnation', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const projectName = 'retirement-fsync-failure';
  const dbPath = db.getProjectDbPath(projectName);
  const original = db.createProjectDb(projectName);
  const originalInstanceId = original
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get().value;
  original.flush();
  db.closeProjectDb(dbPath);
  fs.unlinkSync(dbPath);

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_RETIRE_BEFORE_DIR_FSYNC]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => db.createProjectDb(projectName),
      { code: 'CONTROL_STORE_IO' },
    );
  });

  assert.equal(fs.existsSync(dbPath), false);
  const dbKey = sha256(Buffer.from(canonicalFilePath(dbPath)));
  const controlParent = path.join(dataDir, 'control', 'sqlite');
  assert.equal(fs.existsSync(path.join(controlParent, dbKey)), false);
  assert.equal(
    fs.readdirSync(controlParent).filter((name) => name.startsWith(`${dbKey}.retired-`)).length,
    1,
  );

  const replacement = db.createProjectDb(projectName);
  const replacementInstanceId = replacement
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get().value;
  assert.notEqual(replacementInstanceId, originalInstanceId);
});

test('an active AtomicStore holds no long-lived handle on the formal database file', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'stable');
  fs.writeFileSync(dbPath, beforeBytes);
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  assert.equal(readScalar(store.currentConnection(), 'PRAGMA integrity_check'), 'ok');
  const replacementPath = path.join(root, 'same-bytes.db');
  fs.writeFileSync(replacementPath, beforeBytes);

  assert.doesNotThrow(() => atomicReplace(replacementPath, dbPath, {
    attempts: 1,
    backoffMs: 0,
  }));

  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(readScalar(store.currentConnection(), 'PRAGMA integrity_check'), 'ok');
});

test('a failure after committed evidence stays fenced until recover installs a new epoch', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'before'));
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const stale = store.currentConnection();
  const staleEpoch = store.connectionEpoch;
  stale.run("UPDATE entries SET value = 'after' WHERE id = 1");

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_EPOCH_INSTALL]: { throw: 'EIO' },
  }, async () => {
    assert.throws(() => store.publish(stale), { code: 'EIO' });
  });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  const prepared = controlStore.read().find((event) => event.type === 'sqlite.publish.prepared');
  assert.ok(prepared);

  assert.deepEqual(store.recover(), { status: 'clean' });

  assert.equal(store.connectionEpoch, staleEpoch + 1);
  assert.throws(() => stale.run('SELECT 1'), { code: 'DB_CONNECTION_STALE' });
  assert.equal(
    readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
    'after',
  );
  assert.equal(fs.existsSync(prepared.payload.before.backupPath), false);
  assert.equal(fs.existsSync(prepared.payload.candidate.path), false);
});

test('publish keeps committed evidence but fences a same-byte identity replacement after terminal append', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'before terminal replacement'));
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const connection = store.currentConnection();
  connection.run("UPDATE entries SET value = 'after terminal replacement' WHERE id = 1");
  let replacement;

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_AFTER_TERMINAL_APPEND]: {
      callback() {
        replacement = replaceWithSameBytes(
          dbPath,
          path.join(root, 'publish-after-terminal-replacement.db'),
        );
      },
    },
  }, async () => {
    assert.throws(() => store.publish(connection), { code: 'RECOVERY_REQUIRED' });
  });

  const terminal = controlStore.tail();
  assert.equal(terminal.type, 'sqlite.publish.committed');
  assert.ok(replacement);
  assert.deepEqual(terminal.afterPredicate.identity, replacement.beforeIdentity);
  assert.deepEqual(fileIdentity(dbPath), replacement.afterIdentity);
  assert.throws(() => connection.exec('SELECT 1'), { code: 'RECOVERY_REQUIRED' });
  assert.throws(
    () => connection.run("UPDATE entries SET value = 'must stay fenced' WHERE id = 1"),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
});

test('publish freezes candidate identity and rejects replacement after rename before terminal', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'publish pre-terminal before'));
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const connection = store.currentConnection();
  const epochBefore = store.connectionEpoch;
  connection.run("UPDATE entries SET value = 'publish pre-terminal after' WHERE id = 1");
  let replacement;

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_AFTER_REPLACE]: {
      callback() {
        replacement = replaceWithSameBytes(
          dbPath,
          path.join(root, 'publish-after-replace-race.db'),
        );
      },
    },
  }, async () => {
    assert.throws(() => store.publish(connection), { code: 'RECOVERY_REQUIRED' });
  });

  assert.ok(replacement);
  assert.deepEqual(controlStore.read().map((event) => event.type), ['sqlite.publish.prepared']);
  assert.equal(store.connectionEpoch, epochBefore);
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  const prepared = controlStore.tail();
  assert.equal(fs.existsSync(prepared.payload.before.backupPath), true);
});

test('a previous in-memory handle close failure keeps committed bytes fenced until cleanup can retry', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'before'));
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const stale = store.currentConnection();
  const staleEpoch = store.connectionEpoch;
  stale.run("UPDATE entries SET value = 'after' WHERE id = 1");
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE]: { throw: 'CLOSE_EIO' },
  }, async () => {
    assert.throws(() => store.publish(stale), { code: 'CLOSE_EIO' });
  });
  assert.equal(controlStore.tail().type, 'sqlite.publish.committed');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(store.connectionEpoch, staleEpoch);

  assert.deepEqual(store.recover(), { status: 'clean' });
  assert.equal(store.connectionEpoch, staleEpoch + 1);
  assert.throws(() => stale.run('SELECT 1'), { code: 'DB_CONNECTION_STALE' });
  assert.equal(
    readScalar(store.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
    'after',
  );
});

test('publish rejects a connection whose formal baseline was replaced by another store', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'base'));
  const first = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const second = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const firstConnection = first.currentConnection();
  const staleSecondConnection = second.currentConnection();
  firstConnection.run("UPDATE entries SET value = 'from-first' WHERE id = 1");
  first.publish(firstConnection);
  staleSecondConnection.run("UPDATE entries SET value = 'from-second' WHERE id = 1");

  assert.throws(
    () => second.publish(staleSecondConnection),
    { code: 'DB_CONNECTION_STALE' },
  );
  assert.throws(() => second.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  const disk = new SQL.Database(fs.readFileSync(dbPath));
  try {
    assert.equal(readScalar(disk, 'SELECT value FROM entries WHERE id = 1'), 'from-first');
  } finally {
    disk.close();
  }
});

test('publish rejects a same-byte formal replacement with a different physical identity', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'base');
  fs.writeFileSync(dbPath, beforeBytes);
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const connection = store.currentConnection();
  const replacementPath = path.join(root, 'same-byte-replacement.db');
  fs.writeFileSync(replacementPath, beforeBytes);
  atomicReplace(replacementPath, dbPath, { attempts: 1, backoffMs: 0 });
  connection.run("UPDATE entries SET value = 'stale-write' WHERE id = 1");

  assert.throws(() => store.publish(connection), { code: 'DB_CONNECTION_STALE' });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
});

test('clean recover reloads formal bytes, increments epoch, and permanently stales the old handle', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'base'));
  const first = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const second = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const staleSecondConnection = second.currentConnection();
  const secondEpoch = second.connectionEpoch;
  const firstConnection = first.currentConnection();
  firstConnection.run("UPDATE entries SET value = 'from-first' WHERE id = 1");
  first.publish(firstConnection);

  assert.deepEqual(second.recover(), { status: 'clean' });

  assert.equal(second.connectionEpoch, secondEpoch + 1);
  assert.throws(() => staleSecondConnection.run('SELECT 1'), { code: 'DB_CONNECTION_STALE' });
  assert.equal(
    readScalar(second.currentConnection(), 'SELECT value FROM entries WHERE id = 1'),
    'from-first',
  );
});

test('recover fences its live epoch before an uncertain terminal append', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  const stale = store.currentConnection();
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.writeFileSync(publication.candidatePath, afterBytes);

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: { throw: 'EIO' },
  }, async () => {
    assert.throws(() => store.recover(), { code: 'EIO' });
  });

  assert.throws(() => stale.run('SELECT 1'), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
});

test('recover freezes every branch predicate before terminal and preserves only post-terminal evidence', async (t) => {
  const SQL = await loadSqlModule();
  for (const recoveryMode of [
    'existing-after',
    'candidate-forward',
    'exact-before',
    'missing-before',
    'rollback-resume',
  ]) {
    for (const faultPoint of [
      FAULT_POINTS.ATOMIC_STORE_RECOVER_BEFORE_TERMINAL_APPEND,
      FAULT_POINTS.ATOMIC_STORE_RECOVER_AFTER_TERMINAL_APPEND,
    ]) {
      const {
        controlStore,
        dbPath,
        publication,
        root,
      } = createRecoveryBranch(t, SQL, recoveryMode);
      const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
      let replacement;

      await withFaults({
        [faultPoint]: {
          callback() {
            replacement = replaceWithSameBytes(
              dbPath,
              path.join(root, `${recoveryMode}-${path.basename(faultPoint)}.db`),
            );
          },
        },
      }, async () => {
        assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
      });

      assert.ok(replacement, `${recoveryMode}:${faultPoint}`);
      assert.deepEqual(fileIdentity(dbPath), replacement.afterIdentity, `${recoveryMode}:${faultPoint}`);
      assert.equal(store.connectionEpoch, 0, `${recoveryMode}:${faultPoint}`);
      assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
      assert.equal(fs.existsSync(publication.backupPath), true, `${recoveryMode}:${faultPoint}`);

      const afterTerminal = faultPoint === FAULT_POINTS.ATOMIC_STORE_RECOVER_AFTER_TERMINAL_APPEND;
      const terminal = controlStore.read().find((event) => (
        event.type === 'sqlite.publish.committed' || event.type === 'sqlite.publish.rolled_back'
      ));
      if (!afterTerminal) {
        assert.equal(terminal, undefined, `${recoveryMode}:${faultPoint}`);
        assert.equal(
          controlStore.tail().type,
          ['missing-before', 'rollback-resume'].includes(recoveryMode)
            ? 'sqlite.publish.rollback_installing'
            : 'sqlite.publish.prepared',
          `${recoveryMode}:${faultPoint}`,
        );
      } else {
        assert.ok(terminal, `${recoveryMode}:${faultPoint}`);
        assert.deepEqual(
          terminal.afterPredicate.identity,
          replacement.beforeIdentity,
          `${recoveryMode}:${faultPoint}`,
        );
        assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
        const successor = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
        assert.throws(() => successor.currentConnection(), { code: 'RECOVERY_REQUIRED' });
        assert.throws(() => successor.recover(), { code: 'RECOVERY_REQUIRED' });
      }
    }
  }
});

test('managed close cannot become a fenced raw SQL capability and cleanup failure is retryable', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'immutable cleanup'));
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const connection = store.currentConnection();
  let bypassExecuted = false;
  connection.close = function maliciousClose() {
    bypassExecuted = true;
    this.run("UPDATE entries SET value = 'raw bypass' WHERE id = 1");
  };
  const cachedClose = connection.close;
  store.fence();

  assert.throws(
    () => { connection.close = () => {}; },
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.throws(
    () => Object.defineProperty(connection, 'close', { value() {} }),
    { code: 'RECOVERY_REQUIRED' },
  );
  cachedClose();
  assert.equal(bypassExecuted, false);
  assert.deepEqual(fs.readFileSync(dbPath), databaseBytes(SQL, 'immutable cleanup'));

  const retryStore = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE]: { throw: 'EIO' },
  }, async () => {
    assert.throws(() => retryStore.close(), (error) => (
      error.code === 'EIO'
      && error.faultPoint === FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE
    ));
  });
  assert.throws(() => retryStore.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.doesNotThrow(() => retryStore.close());
});

test('AtomicStore close failure fences the live connection before reporting the error', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'close failure'));
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const connection = store.currentConnection();
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE]: { throw: 'CLOSE_EIO' },
  }, async () => {
    assert.throws(() => store.close(), { code: 'CLOSE_EIO' });
    assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
    assert.throws(() => connection.exec('SELECT 1'), { code: 'RECOVERY_REQUIRED' });
    assert.throws(
      () => connection.run("UPDATE entries SET value = 'must stay fenced' WHERE id = 1"),
      { code: 'RECOVERY_REQUIRED' },
    );
  });
  store.close();
});

test('an AtomicStore bound to a retired ControlStore cannot publish into its replacement', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  fs.writeFileSync(dbPath, databaseBytes(SQL, 'before'));
  const oldControlStore = openControlStore(controlDir);
  const staleStore = createAtomicStore({
    filePath: dbPath,
    controlStore: oldControlStore,
    sqlModule: SQL,
  });
  const staleConnection = staleStore.currentConnection();
  staleConnection.run("UPDATE entries SET value = 'stale' WHERE id = 1");
  const retiredDir = `${controlDir}.retired-${crypto.randomUUID()}`;
  oldControlStore.retire(retiredDir, () => {});
  const replacementControlStore = openControlStore(controlDir);
  replacementControlStore.append({ type: 'replacement.created', payload: {} });

  assert.throws(() => staleStore.publish(staleConnection), { code: 'CONTROL_STORE_STALE' });
  assert.deepEqual(replacementControlStore.read().map((event) => event.type), [
    'replacement.created',
  ]);
  const disk = new SQL.Database(fs.readFileSync(dbPath));
  try {
    assert.equal(readScalar(disk, 'SELECT value FROM entries WHERE id = 1'), 'before');
  } finally {
    disk.close();
  }
});

test('journal rejects interleaved publications even when every id has a terminal event', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, afterBytes);
  const controlStore = openControlStore(controlDir);
  const first = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  const second = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  appendCommitted(controlStore, second, afterBytes);
  appendCommitted(controlStore, first, afterBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
});

test('journal rejects a completed publication whose before does not continue the prior terminal', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const baseBytes = databaseBytes(SQL, 'base');
  const firstBytes = databaseBytes(SQL, 'first');
  const secondBytes = databaseBytes(SQL, 'second');
  fs.writeFileSync(dbPath, secondBytes);
  const controlStore = openControlStore(controlDir);
  const first = appendPrepared(controlStore, {
    beforeBytes: baseBytes,
    candidateBytes: firstBytes,
    controlDir,
    dbPath,
  });
  appendCommitted(controlStore, first, firstBytes);
  const discontinuous = appendPrepared(controlStore, {
    beforeBytes: baseBytes,
    candidateBytes: secondBytes,
    controlDir,
    dbPath,
  });
  appendCommitted(controlStore, discontinuous, secondBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
});

test('Windows journal path comparison accepts canonical case differences', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows canonical-path behavior');
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
    mutateEvent(event) {
      event.payload.before.backupPath = event.payload.before.backupPath.toUpperCase();
      event.payload.candidate.path = event.payload.candidate.path.toUpperCase();
      event.afterPredicate.filePath = event.afterPredicate.filePath.toUpperCase();
    },
  });
  fs.writeFileSync(publication.candidatePath, afterBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.deepEqual(store.recover(), {
    status: 'committed',
    publicationId: publication.publicationId,
  });
  assert.equal(readScalar(store.currentConnection(), 'SELECT value FROM entries'), 'after');
});

test('publish rejects a database whose parent path traverses a symlink or junction', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, root } = createScene(t);
  const physicalParent = path.join(root, 'physical-projects');
  const linkedParent = path.join(root, 'linked-projects');
  fs.mkdirSync(physicalParent);
  fs.symlinkSync(physicalParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
  const dbPath = path.join(linkedParent, 'project.mythpen.db');
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const connection = store.currentConnection();
  connection.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  connection.run("INSERT INTO entries (id, value) VALUES (1, 'unsafe')");

  assert.throws(() => store.publish(connection), { code: 'UNSAFE_STORAGE_PATH' });
  assert.equal(fs.existsSync(path.join(physicalParent, 'project.mythpen.db')), false);
});

test('recover rejects a controlled candidate name that is not a plain file', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(publication.candidatePath);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.statSync(publication.candidatePath).isDirectory(), true);
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
});

test('two processes reject both hardlink aliases before opening one inode under split writer keys', async (t) => {
  const { dbPath, root } = createScene(t);
  const SQL = await loadSqlModule();
  const aliasPath = path.join(root, 'alias.mythpen.db');
  const beforeBytes = databaseBytes(SQL, 'single physical database');
  fs.writeFileSync(dbPath, beforeBytes);
  try {
    fs.linkSync(dbPath, aliasPath);
  } catch (error) {
    if (['EPERM', 'ENOSYS', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`hardlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.equal(fs.lstatSync(dbPath).nlink, 2);
  assert.equal(fs.lstatSync(aliasPath).nlink, 2);

  const [first, second] = await Promise.all([
    runOpenWorker(dbPath, path.join(root, 'control-a')),
    runOpenWorker(aliasPath, path.join(root, 'control-b')),
  ]);
  for (const result of [first, second]) {
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      code: 'UNSAFE_STORAGE_PATH',
      status: 'rejected',
    });
  }
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(aliasPath), beforeBytes);
});

test('writer lease loss after candidate creation prevents every later publish side effect', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  let armed = false;
  let lossDetected = false;
  let candidateLeaseChecks = 0;
  const store = createAtomicStore({
    assertWriterLease() {
      if (!armed) return;
      const candidateExists = findArtifacts(root, '.candidate.db').length > 0;
      if (!candidateExists) return;
      candidateLeaseChecks += 1;
      if (candidateLeaseChecks < 3) return;
      lossDetected = true;
      const error = new Error('writer lease lost during publication');
      error.code = 'WRITER_LEASE_LOST';
      throw error;
    },
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
  });
  const connection = store.currentConnection();
  connection.run("UPDATE entries SET value = 'after' WHERE id = 1");
  armed = true;

  assert.throws(() => store.publish(connection), { code: 'WRITER_LEASE_LOST' });
  assert.equal(lossDetected, true);
  assert.deepEqual(controlStore.read(), [], 'no prepared or terminal event may start after loss');
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes, 'the formal database must remain unchanged');
  assert.equal(
    findArtifacts(root, '.candidate.db').length,
    1,
    'AtomicStore must not unlink a candidate after the writer lease is lost',
  );
  assert.equal(
    fs.existsSync(path.join(controlDir, 'sqlite-recovery')),
    false,
    'no backup directory may be created after lease loss is detected',
  );
});

test('writer lease loss after backup creation preserves candidate and backup without cleanup', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  let armed = false;
  let backupLeaseChecks = 0;
  const store = createAtomicStore({
    assertWriterLease() {
      if (!armed || findArtifacts(controlDir, '.before.db').length === 0) return;
      backupLeaseChecks += 1;
      if (backupLeaseChecks < 3) return;
      const error = new Error('writer lease lost after backup creation');
      error.code = 'WRITER_LEASE_LOST';
      throw error;
    },
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
  });
  const connection = store.currentConnection();
  connection.run("UPDATE entries SET value = 'after' WHERE id = 1");
  armed = true;

  assert.throws(() => store.publish(connection), { code: 'WRITER_LEASE_LOST' });
  assert.deepEqual(controlStore.read(), []);
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(findArtifacts(root, '.candidate.db').length, 1);
  assert.equal(
    findArtifacts(controlDir, '.before.db').length,
    1,
    'AtomicStore must not unlink a backup after the writer lease is lost',
  );
});

test('an exact rollback-installing intent resumes its controlled artifact and terminalizes', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'rollback intent before');
  const afterBytes = databaseBytes(SQL, 'rollback intent after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.deepEqual(store.recover(), {
    publicationId: publication.publicationId,
    status: 'rolled_back',
  });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.deepEqual(controlStore.read().map((event) => event.type), [
    'sqlite.publish.prepared',
    'sqlite.publish.rollback_installing',
    'sqlite.publish.rolled_back',
  ]);
  assert.equal(fs.existsSync(publication.rollbackPath), false);
  assert.equal(fs.existsSync(publication.backupPath), false);
  assert.equal(readScalar(store.currentConnection(), 'SELECT value FROM entries'), 'rollback intent before');
  store.close();
});

test('rollback intent installation is delegated with the exact journaled physical identity', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'delegated rollback before');
  const afterBytes = databaseBytes(SQL, 'delegated rollback after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  const intent = appendRollbackInstalling(controlStore, publication, beforeBytes);
  const calls = [];
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource(
      sourcePath,
      targetPath,
      expectedIdentity,
      expectedSha256,
    ) {
      calls.push({ sourcePath, targetPath, expectedIdentity, expectedSha256 });
      return installVerifiedSourceForTest(
        sourcePath,
        targetPath,
        expectedIdentity,
        expectedSha256,
      );
    },
  });

  assert.deepEqual(store.recover(), {
    publicationId: publication.publicationId,
    status: 'rolled_back',
  });
  assert.deepEqual(calls, [{
    sourcePath: publication.rollbackPath,
    targetPath: path.resolve(dbPath),
    expectedIdentity: intent.payload.rollback.identity,
    expectedSha256: intent.payload.rollback.sha256,
  }]);
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  store.close();
});

test('fresh Windows rollback installation rejects a healthy same-inode overwrite and retains intent evidence', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'same inode rollback before');
  const afterBytes = databaseBytes(SQL, 'same inode rollback after');
  const replacementBytes = databaseBytes(SQL, 'same inode healthy replacement');
  assertHealthyDatabaseBytes(SQL, replacementBytes);
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  let identityBeforeOverwrite;
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource(
      sourcePath,
      targetPath,
      expectedIdentity,
      expectedSha256,
    ) {
      assert.equal(sourcePath, publication.rollbackPath);
      assert.equal(targetPath, path.resolve(dbPath));
      assert.equal(expectedSha256, sha256(beforeBytes));
      identityBeforeOverwrite = fileIdentity(sourcePath);
      assert.deepEqual(identityBeforeOverwrite, expectedIdentity);
      fs.writeFileSync(sourcePath, replacementBytes);
      assert.deepEqual(fileIdentity(sourcePath), identityBeforeOverwrite);
      return installAbsentFromVerifiedSourceDurably(
        sourcePath,
        targetPath,
        expectedIdentity,
        expectedSha256,
      );
    },
  });

  assert.throws(
    () => store.recover(),
    (error) => (
      error.code === 'RECOVERY_REQUIRED'
      && error.cause?.code === 'VERIFIED_SOURCE_MISMATCH'
    ),
  );
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fileIdentity(publication.rollbackPath), identityBeforeOverwrite);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), replacementBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  store.close();
});

test('resumed Windows rollback installation does not terminalize after a pre-rename hardlink race', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'topology rollback before');
  const afterBytes = databaseBytes(SQL, 'topology rollback after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  const evidencePath = path.join(root, 'external-hardlink-evidence.db');
  const native = loadNativeKernel32ForTest();
  t.after(() => native.library.close?.());
  let installCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...native.symbols,
      SetFileInformationByHandle(...args) {
        installCalls += 1;
        if (installCalls === 1) fs.linkSync(publication.rollbackPath, evidencePath);
        return native.symbols.SetFileInformationByHandle(...args);
      },
    },
    ptr: native.ptr,
  });
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource: backend.installAbsentFromVerifiedSource,
  });

  assert.throws(
    () => store.recover(),
    (error) => (
      error.code === 'RECOVERY_REQUIRED'
      && error.cause?.code === 'VERIFIED_SOURCE_TOPOLOGY_CHANGED'
      && error.cause.installed === false
    ),
  );
  assert.equal(installCalls, 2);
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(publication.rollbackPath), true);
  assert.equal(fs.existsSync(evidencePath), true);
  assert.equal(fs.lstatSync(publication.rollbackPath).nlink, 2);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(evidencePath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  assert.equal(
    controlStore.read().some((event) => event.type === 'sqlite.publish.rolled_back'),
    false,
  );
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  store.close();
});

test('rollback intent source substitution is fenced with both physical objects preserved', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'source race before');
  const afterBytes = databaseBytes(SQL, 'source race after');
  const replacementBytes = databaseBytes(SQL, 'source race replacement');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  const intent = appendRollbackInstalling(controlStore, publication, beforeBytes);
  const originalEvidencePath = path.join(path.dirname(dbPath), 'source-race-original.db');
  const installCause = new Error('verified source was substituted before install');
  installCause.code = 'VERIFIED_SOURCE_MISMATCH';
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource(
      sourcePath,
      targetPath,
      expectedIdentity,
      expectedSha256,
    ) {
      assert.equal(sourcePath, publication.rollbackPath);
      assert.equal(targetPath, path.resolve(dbPath));
      assert.deepEqual(expectedIdentity, intent.payload.rollback.identity);
      assert.equal(expectedSha256, intent.payload.rollback.sha256);
      fs.renameSync(sourcePath, originalEvidencePath);
      fs.writeFileSync(sourcePath, replacementBytes);
      throw installCause;
    },
  });

  let recoveryError;
  try {
    store.recover();
  } catch (error) {
    recoveryError = error;
  }
  assert.equal(recoveryError?.code, 'RECOVERY_REQUIRED');
  assert.equal(recoveryError?.cause, installCause);
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(originalEvidencePath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), replacementBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  store.close();
});

test('rollback intent target contention is fenced without clobbering either side', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'target race before');
  const afterBytes = databaseBytes(SQL, 'target race after');
  const competingBytes = databaseBytes(SQL, 'target race competing formal');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  const installCause = new Error('target appeared during verified install');
  installCause.code = 'INSTALL_TARGET_EXISTS';
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource() {
      fs.writeFileSync(dbPath, competingBytes);
      throw installCause;
    },
  });
  const rollbackIdentity = fileIdentity(publication.rollbackPath);

  let recoveryError;
  try {
    store.recover();
  } catch (error) {
    recoveryError = error;
  }
  assert.equal(recoveryError?.code, 'RECOVERY_REQUIRED');
  assert.equal(recoveryError?.cause, installCause);
  assert.deepEqual(fs.readFileSync(dbPath), competingBytes);
  assert.deepEqual(fileIdentity(publication.rollbackPath), rollbackIdentity);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();
});

test('a fresh missing-formal rollback records intent before unsupported installation and preserves evidence', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'unsupported rollback before');
  const afterBytes = databaseBytes(SQL, 'unsupported rollback after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.writeFileSync(publication.candidatePath, afterBytes);
  fs.rmSync(dbPath);
  const installCause = new Error('verified absent install is unavailable');
  installCause.code = 'DURABILITY_UNSUPPORTED';
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource() {
      throw installCause;
    },
  });

  let recoveryError;
  try {
    store.recover();
  } catch (error) {
    recoveryError = error;
  }
  assert.equal(recoveryError?.code, 'RECOVERY_REQUIRED');
  assert.equal(recoveryError?.cause, installCause);
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.candidatePath), afterBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  store.close();
});

test('a successor terminalizes an installed rollback after close reporting fails', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'installed despite close failure before');
  const afterBytes = databaseBytes(SQL, 'installed despite close failure after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  const installCause = new Error('installed object handle could not close');
  installCause.code = 'VERIFIED_INSTALL_FAILED';
  installCause.installed = true;
  const store = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource(
      sourcePath,
      targetPath,
      expectedIdentity,
      expectedSha256,
    ) {
      installVerifiedSourceForTest(
        sourcePath,
        targetPath,
        expectedIdentity,
        expectedSha256,
      );
      throw installCause;
    },
  });

  assert.throws(
    () => store.recover(),
    (error) => error.code === 'RECOVERY_REQUIRED' && error.cause === installCause,
  );
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(fs.existsSync(publication.rollbackPath), false);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();

  const successor = createAtomicStore({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
    installAbsentFromVerifiedSource() {
      throw new Error('successor must observe the installed formal state');
    },
  });
  assert.deepEqual(successor.recover(), {
    publicationId: publication.publicationId,
    status: 'rolled_back',
  });
  assert.equal(controlStore.tail().type, 'sqlite.publish.rolled_back');
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  successor.close();
});

test('production AtomicStore fails closed on unsupported POSIX missing-formal rollback installation', {
  skip: process.platform === 'win32',
}, async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'POSIX unsupported before');
  const afterBytes = databaseBytes(SQL, 'POSIX unsupported after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  const store = createAtomicStoreWithProductionDurability({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
  });

  assert.throws(
    () => store.recover(),
    (error) => error.code === 'RECOVERY_REQUIRED' && error.cause?.code === 'DURABILITY_UNSUPPORTED',
  );
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();
});

test('production AtomicStore completes verified missing-formal rollback installation on Windows', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'Windows verified rollback before');
  const afterBytes = databaseBytes(SQL, 'Windows verified rollback after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  const store = createAtomicStoreWithProductionDurability({
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
  });

  assert.deepEqual(store.recover(), {
    publicationId: publication.publicationId,
    status: 'rolled_back',
  });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rolled_back');
  assert.equal(fs.existsSync(publication.rollbackPath), false);
  store.close();
});

test('an installed rollback intent with no artifact appends only its rolled-back terminal', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'installed rollback before');
  const afterBytes = databaseBytes(SQL, 'installed rollback after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  atomicReplace(publication.rollbackPath, dbPath);
  const installedIdentity = fileIdentity(dbPath);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.deepEqual(store.recover(), {
    publicationId: publication.publicationId,
    status: 'rolled_back',
  });
  assert.deepEqual(fileIdentity(dbPath), installedIdentity);
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rolled_back');
  assert.equal(fs.existsSync(publication.backupPath), false);
  assert.equal(readScalar(store.currentConnection(), 'SELECT value FROM entries'), 'installed rollback before');
  store.close();
});

test('a rollback-install intent with an inexact versioned schema is preserved and fenced', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'strict schema before');
  const afterBytes = databaseBytes(SQL, 'strict schema after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes, (event) => {
    event.payload.unexpected = 'not part of version 1';
  });
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  store.close();
});

test('a rollback-install intent requires an exact expected identity schema', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'identity schema before');
  const afterBytes = databaseBytes(SQL, 'identity schema after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes, (event) => {
    event.afterPredicate.identity = {
      ...event.afterPredicate.identity,
      unexpected: 'not part of file identity',
    };
  });
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  let recoveryError;
  try {
    store.recover();
  } catch (error) {
    recoveryError = error;
  }
  assert.equal(recoveryError?.code, 'RECOVERY_REQUIRED');
  assert.equal(recoveryError.message, 'SQLite rollback-install intent schema is not exact');
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();
});

test('a rollback-install intent cannot redirect recovery to an uncontrolled artifact path', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'controlled path before');
  const afterBytes = databaseBytes(SQL, 'controlled path after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  const uncontrolledPath = path.join(root, 'uncontrolled-rollback.db');
  fs.writeFileSync(uncontrolledPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes, (event) => {
    const uncontrolledIdentity = fileIdentity(uncontrolledPath);
    event.payload.rollback.path = uncontrolledPath;
    event.payload.rollback.identity = uncontrolledIdentity;
    event.afterPredicate.identity = uncontrolledIdentity;
  });
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(uncontrolledPath), beforeBytes);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();
});

test('a rollback-install intent hash must remain the exact prepared before hash', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'recorded before');
  const afterBytes = databaseBytes(SQL, 'recorded after');
  const wrongBytes = databaseBytes(SQL, 'healthy but not before');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, wrongBytes);
  appendRollbackInstalling(controlStore, publication, wrongBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), wrongBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();
});

test('a rollback-install intent rejects a replaced artifact identity without overwriting formal', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'identity before');
  const afterBytes = databaseBytes(SQL, 'identity after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  fs.rmSync(publication.rollbackPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  const replacementIdentity = fileIdentity(publication.rollbackPath);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fileIdentity(publication.rollbackPath), replacementIdentity);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();
});

test('an artifact replaced while its rollback-install intent is appended is fenced before formal replace', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'append race before');
  const afterBytes = databaseBytes(SQL, 'append race after');
  const replacementBytes = databaseBytes(SQL, 'append race replacement');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  const originalAppend = controlStore.append.bind(controlStore);
  controlStore.append = (event) => {
    const appended = originalAppend(event);
    if (event.type === 'sqlite.publish.rollback_installing') {
      fs.rmSync(publication.rollbackPath);
      fs.writeFileSync(publication.rollbackPath, replacementBytes);
    }
    return appended;
  };
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), replacementBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  store.close();
});

test('a rollback-install intent preserves and fences a third formal state', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'intent before');
  const afterBytes = databaseBytes(SQL, 'intent after');
  const thirdBytes = databaseBytes(SQL, 'third formal state');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  fs.rmSync(publication.rollbackPath);
  fs.writeFileSync(dbPath, thirdBytes);
  const thirdIdentity = fileIdentity(dbPath);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.deepEqual(fileIdentity(dbPath), thirdIdentity);
  assert.deepEqual(fs.readFileSync(dbPath), thirdBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rollback_installing');
  store.close();
});

test('a second rollback-install intent is rejected by the single-active journal state', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'single intent before');
  const afterBytes = databaseBytes(SQL, 'single intent after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  appendRollbackInstalling(controlStore, publication, beforeBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), beforeBytes);
  assert.deepEqual(controlStore.read().map((event) => event.type), [
    'sqlite.publish.prepared',
    'sqlite.publish.rollback_installing',
    'sqlite.publish.rollback_installing',
  ]);
  store.close();
});

test('a successor reuses the exact rollback artifact preserved after writer lease loss', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath, root } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  let rollbackLeaseChecks = 0;
  const store = createAtomicStore({
    assertWriterLease() {
      if (findArtifacts(root, '.rollback.db').length === 0) return;
      rollbackLeaseChecks += 1;
      if (rollbackLeaseChecks < 3) return;
      const error = new Error('writer lease lost after rollback creation');
      error.code = 'WRITER_LEASE_LOST';
      throw error;
    },
    filePath: dbPath,
    controlStore,
    sqlModule: SQL,
  });

  assert.throws(() => store.recover(), { code: 'WRITER_LEASE_LOST' });
  assert.equal(fs.existsSync(dbPath), false, 'formal replacement must not begin after loss');
  assert.equal(findArtifacts(controlDir, '.before.db').length, 1);
  assert.equal(
    findArtifacts(root, '.rollback.db').length,
    1,
    'AtomicStore must not unlink a rollback artifact after the writer lease is lost',
  );
  assert.equal(controlStore.tail().type, 'sqlite.publish.prepared');

  store.close();
  const successor = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });
  assert.deepEqual(successor.recover(), {
    publicationId: publication.publicationId,
    status: 'rolled_back',
  });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.rolled_back');
  assert.equal(findArtifacts(root, '.rollback.db').length, 0);
  assert.equal(findArtifacts(controlDir, '.before.db').length, 0);
  assert.equal(readScalar(successor.currentConnection(), 'SELECT value FROM entries'), 'before');
  successor.close();
});

test('a mismatched residual rollback artifact is preserved and fences successor recovery', async (t) => {
  const SQL = await loadSqlModule();
  const { controlDir, dbPath } = createScene(t);
  const beforeBytes = databaseBytes(SQL, 'before');
  const afterBytes = databaseBytes(SQL, 'after');
  const mismatchedBytes = databaseBytes(SQL, 'unrelated residual');
  fs.writeFileSync(dbPath, beforeBytes);
  const controlStore = openControlStore(controlDir);
  const publication = appendPrepared(controlStore, {
    beforeBytes,
    candidateBytes: afterBytes,
    controlDir,
    dbPath,
  });
  fs.mkdirSync(path.dirname(publication.backupPath), { recursive: true });
  fs.writeFileSync(publication.backupPath, beforeBytes);
  fs.rmSync(dbPath);
  fs.writeFileSync(publication.rollbackPath, mismatchedBytes);
  const store = createAtomicStore({ filePath: dbPath, controlStore, sqlModule: SQL });

  assert.throws(() => store.recover(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(fs.existsSync(dbPath), false);
  assert.deepEqual(fs.readFileSync(publication.rollbackPath), mismatchedBytes);
  assert.deepEqual(fs.readFileSync(publication.backupPath), beforeBytes);
  assert.equal(controlStore.tail().type, 'sqlite.publish.prepared');
  assert.throws(() => store.currentConnection(), { code: 'RECOVERY_REQUIRED' });
  store.close();
});
