const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('ordinary project access never recreates a missing or deleted database', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-project-existence-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'deleted-project';
  const projectPath = db.getProjectDbPath(project);
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.closeProjectDb(projectPath);
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
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
    error: { code: 'PROJECT_NOT_FOUND', message: `项目"${project}"不存在`, recoverable: true },
  });
  assert.equal(fs.existsSync(projectPath), false);
});
