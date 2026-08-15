const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');

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

test('ordinary off-mode open still rejects schema11 without activated admission', async (t) => {
  withIsolatedDataDir(t);
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

  assert.throws(
    () => db.captureProjectInstance(project),
    (error) => error?.code === 'PROJECT_SCHEMA_TOO_NEW',
  );
});
