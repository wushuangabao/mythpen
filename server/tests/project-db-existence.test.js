const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');
const { openControlStore } = require('../control-store');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { getWasmBinary } = require('../wasm-binary');

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('ordinary project access never recreates a missing or deleted database', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'deleted-project';
  const projectPath = db.getProjectDbPath(project);
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  await db.initDatabase();
  assert.equal(fs.existsSync(projectPath), false);
  assert.throws(
    () => db.getProjectDb(project),
    (error) => error.code === 'PROJECT_NOT_FOUND' && error.status === 404,
  );
  assert.equal(fs.existsSync(projectPath), false);

  const oldProjectDb = db.createProjectDb(project);
  assert.equal(db.getProjectDb(project), oldProjectDb, 'a newly created cached project is immediately readable');
  const oldInstanceId = oldProjectDb
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get().value;
  db.closeProjectDb(projectPath);
  fs.unlinkSync(projectPath);
  assert.throws(
    () => db.projectExecute(project, "INSERT INTO project_meta (key, value) VALUES ('ghost', '1')"),
    (error) => error.code === 'PROJECT_NOT_FOUND',
  );
  assert.equal(fs.existsSync(projectPath), false);

  const replacementDb = db.createProjectDb(project);
  const canonicalProjectPath = canonicalDatabasePath(projectPath);
  const dbKey = crypto.createHash('sha256').update(canonicalProjectPath).digest('hex');
  const controlParent = path.join(dataDir, 'control', 'sqlite');
  const retiredDirectories = fs.readdirSync(controlParent).filter(
    (name) => new RegExp(`^${dbKey}\\.retired-[0-9a-f-]{36}$`).test(name),
  );
  assert.equal(retiredDirectories.length, 1, 'the old incarnation evidence is retained exactly once');
  assert.ok(
    fs.readdirSync(path.join(controlParent, retiredDirectories[0])).some((name) => name.endsWith('.json')),
    'the retired incarnation keeps its journal evidence',
  );
  assert.equal(fs.existsSync(path.join(controlParent, dbKey)), true);
  const replacementInstanceId = replacementDb
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get().value;
  assert.notEqual(replacementInstanceId, oldInstanceId);
  assert.throws(
    () =>
      db.runWithProjectInstance(project, oldInstanceId, () =>
        db.projectExecute(project, "INSERT INTO project_meta (key, value) VALUES ('stale', '1')"),
      ),
    (error) => error.code === 'PROJECT_INSTANCE_MISMATCH' && error.status === 409,
  );
  assert.equal(replacementDb.prepare("SELECT value FROM project_meta WHERE key = 'stale'").get(), null);
  await assert.rejects(
    db.runWithProjectInstance(project, oldInstanceId, async () => {
      await Promise.resolve();
      db.projectExecute(project, "INSERT INTO project_meta (key, value) VALUES ('stale_async', '1')");
    }),
    (error) => error.code === 'PROJECT_INSTANCE_MISMATCH',
  );
  assert.equal(replacementDb.prepare("SELECT value FROM project_meta WHERE key = 'stale_async'").get(), null);

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;
  const staleResponse = await fetch(`${baseUrl}/${project}/chapters`, {
    headers: { 'X-Mythpen-Project-Instance': oldInstanceId },
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error.code, 'PROJECT_INSTANCE_MISMATCH');

  const currentResponse = await fetch(`${baseUrl}/${project}/chapters`, {
    headers: { 'X-Mythpen-Project-Instance': replacementInstanceId },
  });
  assert.equal(currentResponse.status, 200);

  const staleDelete = await fetch(`${baseUrl}/projects/${project}`, {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': oldInstanceId },
  });
  assert.equal(staleDelete.status, 409);
  assert.equal(fs.existsSync(projectPath), true);

  const currentDelete = await fetch(`${baseUrl}/projects/${project}`, {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': replacementInstanceId },
  });
  assert.equal(currentDelete.status, 200);
  assert.equal(fs.existsSync(projectPath), false);

  const missingResponse = await fetch(`${baseUrl}/${project}/chapters`);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), {
    error: { code: 'PROJECT_NOT_FOUND', message: '项目不存在', recoverable: true },
  });
  assert.equal(fs.existsSync(projectPath), false);
});

test('project connection cache uses the Windows canonical physical path key', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows path aliases are case-insensitive');
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const filePath = db.getProjectDbPath('canonical-cache');
  const first = db.openProjectDb(filePath);
  first.flush();

  const second = db.openProjectDb(filePath.toUpperCase());

  assert.equal(second, first);
  db.closeProjectDb(filePath.toUpperCase());
});

function snapshotTree(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap((entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return [
          { kind: 'directory', path: entry.name },
          ...snapshotTree(entryPath).map((child) => ({
            ...child,
            path: path.join(entry.name, child.path),
          })),
        ];
      }
      const bytes = fs.readFileSync(entryPath);
      return [{
        kind: entry.isFile() ? 'file' : 'other',
        path: entry.name,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      }];
    });
}

function recoveryProjectBytes(SQL, label, instanceId) {
  const database = new SQL.Database();
  database.run('CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  database.run('CREATE TABLE volumes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
  database.run("INSERT INTO project_meta (key, value) VALUES ('schema_version', '10')");
  database.run("INSERT INTO project_meta (key, value) VALUES ('project_instance_id', ?)", [instanceId]);
  database.run('INSERT INTO volumes (id, title) VALUES (1, ?)', [label]);
  const bytes = Buffer.from(database.export());
  database.close();
  return bytes;
}

function fileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function createMissingFormalRollbackScene({ beforeBytes, candidateBytes, controlDirectory, filePath }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, beforeBytes);
  const publicationId = crypto.randomUUID();
  const canonicalPath = canonicalDatabasePath(filePath);
  const dbKey = sha256(Buffer.from(canonicalPath));
  const backupPath = path.join(
    controlDirectory,
    'sqlite-recovery',
    dbKey,
    `${publicationId}.before.db`,
  );
  const candidatePath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${publicationId}.candidate.db`,
  );
  openControlStore(controlDirectory).append({
    type: 'sqlite.publish.prepared',
    payload: {
      version: 1,
      publicationId,
      dbKey,
      before: {
        exists: true,
        sha256: sha256(beforeBytes),
        identity: fileIdentity(filePath),
        backupPath,
      },
      candidate: { path: candidatePath, sha256: sha256(candidateBytes) },
      after: { sha256: sha256(candidateBytes) },
    },
    afterPredicate: { filePath: canonicalPath, sha256: sha256(candidateBytes) },
  });
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(backupPath, beforeBytes);
  fs.unlinkSync(filePath);
}

test('ordinary sql.js create, reopen, and write remain on complete schema 10', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'sqljs-schema-ten';
  const filePath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value,
    '10',
  );
  projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('schema10_write', 'before')").run();
  projectDb.flush();
  db.closeProjectDb(filePath);

  const reopened = db.openProjectDb(filePath);
  assert.equal(
    reopened.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value,
    '10',
  );
  reopened.prepare("UPDATE project_meta SET value = 'after' WHERE key = 'schema10_write'").run();
  reopened.flush();
  assert.equal(
    reopened.prepare("SELECT value FROM project_meta WHERE key = 'schema10_write'").get().value,
    'after',
  );
});

test('startup preserves missing-formal schema-10 rollback diagnostics without mutation', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const project = 'startup-missing-formal';
  const filePath = db.getProjectDbPath(project);
  const dbKey = sha256(Buffer.from(canonicalDatabasePath(filePath)));
  const controlDirectory = path.join(dataDir, 'control', 'sqlite', dbKey);
  const instanceId = crypto.randomUUID();
  createMissingFormalRollbackScene({
    beforeBytes: recoveryProjectBytes(SQL, 'before', instanceId),
    candidateBytes: recoveryProjectBytes(SQL, 'after', instanceId),
    controlDirectory,
    filePath,
  });
  db.getConfigDb().prepare(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
  ).run(crypto.randomUUID(), project, filePath);
  db.getConfigDb().flush();
  db.configureRecoveryDiagnosticsCapabilities({
    atomicReplace: true,
    backend: process.platform === 'win32' ? 'win32' : 'posix',
    directoryFsync: true,
    exclusiveLease: true,
    verifiedAbsentInstall: true,
  });
  const before = snapshotTree(dataDir);

  db.inspectProjectDatabasesAtStartup();

  assert.deepEqual(db.getProjectOpenState(filePath), {
    openState: 'isolated',
    reasonCode: 'V1_PUBLICATION_ROLLBACK_RECOVERABLE',
    recommendedAction: 'recover_v1_publication',
  });
  assert.deepEqual(snapshotTree(dataDir), before);
});

test('ordinary off-mode open rejects partial schema 11 before sql.js mutation', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'schema11-without-native-admission';
  const filePath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  projectDb
    .prepare("UPDATE project_meta SET value = '11' WHERE key = 'schema_version'")
    .run();
  projectDb.flush();
  db.closeProjectDb(filePath);
  db.getConfigDb().prepare(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
  ).run(crypto.randomUUID(), project, filePath);
  db.getConfigDb().flush();
  const before = snapshotTree(dataDir);

  db.inspectProjectDatabasesAtStartup();
  assert.equal(db.getProjectOpenState(filePath)?.reasonCode, 'RECOVERY_REQUIRED');
  assert.deepEqual(snapshotTree(dataDir), before);
  db.removeProjectOpenState(filePath);

  assert.throws(
    () => db.captureProjectInstance(project),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.deepEqual(snapshotTree(dataDir), before);
});

test('schema above 11 is rejected before open or DML with database and ControlStore unchanged', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'schema-too-new';
  const filePath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("UPDATE project_meta SET value = '12' WHERE key = 'schema_version'").run();
  projectDb.flush();
  db.closeProjectDb(filePath);
  db.getConfigDb().prepare(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
  ).run(crypto.randomUUID(), project, filePath);
  db.getConfigDb().flush();
  const before = snapshotTree(dataDir);

  db.inspectProjectDatabasesAtStartup();
  assert.equal(db.getProjectOpenState(filePath)?.reasonCode, 'PROJECT_SCHEMA_TOO_NEW');
  assert.deepEqual(snapshotTree(dataDir), before);
  db.removeProjectOpenState(filePath);

  const diagnostics = db.inspectRegisteredProject(project);
  assert.equal(diagnostics.state, 'isolated');
  assert.equal(diagnostics.reasonCode, 'PROJECT_SCHEMA_TOO_NEW');
  assert.equal(diagnostics.canAutoRecover, false);
  assert.deepEqual(snapshotTree(dataDir), before);
  assert.throws(
    () => db.recoverRegisteredProject(project, {
      action: 'recover_v1_publication',
      snapshot: diagnostics.snapshot,
    }),
    (error) => error?.code === 'PROJECT_SCHEMA_TOO_NEW',
  );
  assert.deepEqual(snapshotTree(dataDir), before);
  db.removeProjectOpenState(filePath);

  for (const operation of [
    () => db.openProjectDb(filePath),
    () => db.captureProjectInstance(project),
    () => db.projectExecute(
      project,
      "INSERT INTO project_meta (key, value) VALUES ('must_not_write', '1')",
    ),
  ]) {
    assert.throws(operation, (error) => error?.code === 'PROJECT_SCHEMA_TOO_NEW');
    assert.deepEqual(snapshotTree(dataDir), before);
  }
});
