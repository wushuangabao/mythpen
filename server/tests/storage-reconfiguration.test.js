const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { databaseInternals } = require('../testing/database-internals');
const { acquireConfigLifecycleLease } = require('../config-lifecycle-lease');
const { fileManifest } = require('../storage-migration');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');

const db = require('../db');

test('disposition_unknown admission leaves candidate parent bytes and entries unchanged', () => {
  const fixture = path.join(__dirname, 'fixtures', 'storage-disposition-unknown.js');
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const observation = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(observation.code, 'STORAGE_UNAVAILABLE');
  assert.deepEqual(observation.after, observation.before);
});

test('config lifecycle lease stays held until all databases close', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  await db.initDatabase();
  const configDbPath = path.join(dataDir, 'config.db');

  assert.throws(
    () => acquireConfigLifecycleLease(configDbPath),
    (error) => error.code === 'CONFIG_DATABASE_BUSY' && error.status === 423,
  );

  db.closeAllDatabases();
  const reacquired = acquireConfigLifecycleLease(configDbPath);
  reacquired.release();
});

test('storage root can be reconfigured within one process', async (t) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-b-'));

  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  withIsolatedDataDir(t);

  db.configureStorage({ dataDir: first });
  await db.initDatabase();
  db.createProjectDb('alpha');
  assert.equal(db.getDataDir(), first);
  assert.ok(fs.existsSync(path.join(first, 'projects', 'alpha.mythpen.db')));

  db.configureStorage({ dataDir: second });
  await db.initDatabase();
  assert.equal(db.getDataDir(), second);
  assert.equal(fs.existsSync(path.join(second, 'projects', 'alpha.mythpen.db')), false);
  assert.deepEqual(db.getConfigDb().prepare('SELECT * FROM recent_projects').all(), []);
});

test('default AI request parameters follow storage reconfiguration', (t) => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-ai-storage-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-ai-storage-b-'));

  t.after(() => {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  });
  withIsolatedDataDir(t);

  db.configureStorage({ dataDir: first });
  const { createAIAdapter } = require('../ai-adapter');
  createAIAdapter('test-model', { apiKey: '', apiBaseUrl: 'http://localhost' }, 'openai');
  assert.equal(fs.existsSync(path.join(first, 'ai-request-parameters.json')), true);

  db.configureStorage({ dataDir: second });
  createAIAdapter('test-model', { apiKey: '', apiBaseUrl: 'http://localhost' }, 'openai');
  assert.equal(fs.existsSync(path.join(second, 'ai-request-parameters.json')), true);
});

test('an unpreparable candidate leaves the old storage and connection untouched', async (t) => {
  const candidateParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-blocked-'));
  const candidate = path.join(candidateParent, 'occupied');
  fs.writeFileSync(candidate, 'not a directory');

  t.after(() => fs.rmSync(candidateParent, { recursive: true, force: true }));
  const { dataDir } = withIsolatedDataDir(t);

  await db.initDatabase();
  const project = 'candidate-preparation';
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Before failure')").run();

  assert.throws(() => db.configureStorage({ dataDir: candidate }));
  assert.equal(db.getDataDir(), dataDir);
  assert.equal(db.getProjectDb(project), projectDb);

  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (2, 2, 'After failure')").run();
  assert.deepEqual(
    projectDb.prepare('SELECT id, title FROM volumes ORDER BY id').all(),
    [
      { id: 1, title: 'Before failure' },
      { id: 2, title: 'After failure' },
    ],
  );
});

test('a project flush failure keeps dirty data retryable on the old connection', async (t) => {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-retry-'));
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }));
  const { dataDir } = withIsolatedDataDir(t);

  await db.initDatabase();
  const project = 'flush-retry';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);

  const writeError = new Error('injected project flush failure');
  const originalOpenSync = fs.openSync;
  fs.openSync = (filePath, ...args) => {
    const resolved = path.resolve(String(filePath));
    const candidatePrefix = `.${path.basename(projectPath)}.`;
    if (
      path.dirname(resolved) === path.dirname(path.resolve(projectPath))
      && path.basename(resolved).startsWith(candidatePrefix)
      && path.basename(resolved).endsWith('.candidate.db')
    ) {
      throw writeError;
    }
    return originalOpenSync(filePath, ...args);
  };
  try {
    assert.throws(
      () => projectDb
        .prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Durable after retry')")
        .run(),
      (error) => error === writeError,
    );
    assert.throws(
      () => db.configureStorage({ dataDir: candidate }),
      (error) => error === writeError,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }

  assert.equal(db.getDataDir(), dataDir);
  assert.equal(db.getProjectDb(project), projectDb);
  assert.equal(projectDb.prepare('SELECT title FROM volumes WHERE id = 1').get().title, 'Durable after retry');

  db.configureStorage({ dataDir: candidate });
  db.configureStorage({ dataDir });
  await db.initDatabase();
  assert.equal(
    db.getProjectDb(project).prepare('SELECT title FROM volumes WHERE id = 1').get().title,
    'Durable after retry',
  );
});

test('a project close failure restores usable old-root connections without committing', async (t) => {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-close-retry-'));
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }));
  const { dataDir } = withIsolatedDataDir(t);

  await db.initDatabase();
  const project = 'close-retry';
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Recovered connection')").run();
  projectDb.flush();

  const closeError = new Error('injected project close failure');
  const originalClose = projectDb.close;
  projectDb.close = () => { throw closeError; };
  try {
    assert.throws(
      () => db.configureStorage({ dataDir: candidate }),
      (error) => error === closeError,
    );
  } finally {
    projectDb.close = originalClose;
  }

  assert.equal(db.getDataDir(), dataDir);
  assert.equal(
    db.getProjectDb(project).prepare('SELECT title FROM volumes WHERE id = 1').get().title,
    'Recovered connection',
  );

  db.configureStorage({ dataDir: candidate });
  assert.equal(db.getDataDir(), candidate);
});

test('a raw cleanup failure enters fail-closed instead of reopening beside an uncertain handle', async (t) => {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-uncertain-'));
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }));
  withIsolatedDataDir(t);

  await db.initDatabase();
  const project = 'uncertain-cleanup';
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Only one handle')").run();
  projectDb.flush();
  db.getConfigDb().flush();

  const closeError = new Error('injected wrapper close failure');
  const originalClose = projectDb.close;
  const originalReadFileSync = fs.readFileSync;
  let reopenReadCount = 0;
  let uncertainCloseObserved = false;
  const formalDatabasePaths = new Set([
    path.resolve(db.getStoragePaths().configDbPath),
    path.resolve(db.getProjectDbPath(project)),
  ]);
  projectDb.close = () => {
    uncertainCloseObserved = true;
    throw closeError;
  };
  fs.readFileSync = (filePath, ...args) => {
    if (
      uncertainCloseObserved
      && formalDatabasePaths.has(path.resolve(String(filePath)))
    ) {
      reopenReadCount += 1;
    }
    return originalReadFileSync(filePath, ...args);
  };
  try {
    await withFaults({
      [FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE]: { throw: 'CLEANUP_EIO' },
    }, async () => {
      assert.throws(
        () => db.configureStorage({ dataDir: candidate }),
        (error) => (
          error === closeError
          && error.storageCleanupErrors?.some((cleanupError) => cleanupError.code === 'CLEANUP_EIO')
        ),
      );

      const retryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-admission-'));
      const retryCandidate = path.join(retryParent, 'candidate');
      fs.writeFileSync(path.join(retryParent, 'sentinel.txt'), 'unchanged');
      const retryParentBefore = fileManifest(retryParent);
      assert.throws(
        () => db.configureStorage({ dataDir: retryCandidate }),
        (error) => error.code === 'STORAGE_UNAVAILABLE' && error.cause === closeError,
      );
      assert.deepEqual(
        fileManifest(retryParent),
        retryParentBefore,
        'failed storage admission must precede every candidate filesystem mutation',
      );
    });
  } finally {
    projectDb.close = originalClose;
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(reopenReadCount, 0, 'an uncertain raw handle must prevent every recovery reopen');

  for (const operation of [
    () => db.getConfigDb(),
    () => db.getProjectDb(project),
    () => db.getDataDir(),
  ]) {
    assert.throws(
      operation,
      (error) => error.code === 'STORAGE_UNAVAILABLE' && error.cause === closeError,
    );
  }

  db.configureStorage({ dataDir: candidate });
  assert.equal(db.getDataDir(), candidate);
});

test('a partial multi-connection recovery is discarded and leaves global state fail-closed', async (t) => {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-recovery-failure-'));
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }));
  withIsolatedDataDir(t);

  await db.initDatabase();
  const firstProject = 'recovery-first';
  const secondProject = 'recovery-second';
  const firstDb = db.createProjectDb(firstProject);
  const secondDb = db.createProjectDb(secondProject);
  firstDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'First')").run();
  secondDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Second')").run();
  firstDb.flush();
  secondDb.flush();

  const closeError = new Error('injected close before recovery');
  const reopenError = new Error('injected second reopen failure');
  const secondPath = db.getProjectDbPath(secondProject);
  const originalClose = firstDb.close;
  const originalReadFileSync = fs.readFileSync;
  firstDb.close = () => { throw closeError; };
  fs.readFileSync = (filePath, ...args) => {
    if (canonicalDatabasePath(String(filePath)) === canonicalDatabasePath(secondPath)) throw reopenError;
    return originalReadFileSync(filePath, ...args);
  };
  try {
    assert.throws(
      () => db.configureStorage({ dataDir: candidate }),
      (error) => (
        error === closeError
        && error.storageRecoveryError?.code === 'RECOVERY_REQUIRED'
        && error.storageRecoveryError.cause === reopenError
      ),
    );
  } finally {
    firstDb.close = originalClose;
    fs.readFileSync = originalReadFileSync;
  }

  for (const operation of [
    () => db.getConfigDb(),
    () => db.getProjectDb(firstProject),
    () => db.getProjectDb(secondProject),
  ]) {
    assert.throws(
      operation,
      (error) => error.code === 'STORAGE_UNAVAILABLE' && error.cause === closeError,
    );
  }

  db.configureStorage({ dataDir: candidate });
  assert.equal(db.getDataDir(), candidate);
});

test('a scheduled config TARGET_LOCKED failure is captured and leaves the wrapper queryably fail-closed', async (t) => {
  withIsolatedDataDir(t);
  await db.initDatabase();
  const configDb = db.getConfigDb();
  const targetLocked = new Error('injected scheduled target lock');
  targetLocked.code = 'TARGET_LOCKED';
  const configStore = databaseInternals(configDb).store;
  const originalPublish = configStore.publish;
  configStore.publish = () => { throw targetLocked; };
  try {
    db.dbExecute(
      "INSERT INTO app_settings (key, value) VALUES ('scheduled_target_locked', 'dirty')",
    );
    await new Promise((resolve) => setTimeout(resolve, 350));

    assert.equal(configDb._failure, targetLocked);
    assert.throws(
      () => configDb.prepare("SELECT value FROM app_settings WHERE key = 'scheduled_target_locked'").get(),
      (error) => error === targetLocked,
    );
    assert.throws(() => configDb.flush(), (error) => error === targetLocked);
  } finally {
    configStore.publish = originalPublish;
    configDb._discard();
  }
});

test('a stale scheduled config epoch is captured instead of escaping the timer callback', async (t) => {
  withIsolatedDataDir(t);
  await db.initDatabase();
  const configDb = db.getConfigDb();
  db.dbExecute(
    "INSERT INTO app_settings (key, value) VALUES ('scheduled_stale_epoch', 'durable')",
  );
  const configStore = databaseInternals(configDb).store;
  configStore.publish(configStore.currentConnection());

  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(configDb._failure?.code, 'DB_CONNECTION_STALE');
  const capturedFailure = configDb._failure;
  assert.throws(() => configDb.flush(), (error) => error === capturedFailure);
  configDb._discard();
});
