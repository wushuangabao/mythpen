const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('headerless AI requests retain the project incarnation captured at request start', async (t) => {
  withIsolatedDataDir(t);

  const db = require('../db');
  const express = require('express');
  const { bindAiProjectInstance } = require('../project-instance-middleware');
  const project = 'replace-during-ai';
  const projectPath = db.getProjectDbPath(project);
  let server;
  let releaseWrite;
  let markEntered;
  const writeReleased = new Promise((resolve) => { releaseWrite = resolve; });
  const handlerEntered = new Promise((resolve) => { markEntered = resolve; });

  t.after(async () => {
    releaseWrite();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  await db.initDatabase();
  const originalDb = db.createProjectDb(project);
  const originalInstanceId = db.captureProjectInstance(project);
  originalDb.flush();

  const app = express();
  app.use(express.json());
  app.use('/api/ai', bindAiProjectInstance);
  app.post('/api/ai/delayed-write', async (req, res) => {
    markEntered();
    await writeReleased;
    db.projectExecute(req.body.project,
      "INSERT INTO project_meta (key, value) VALUES ('stale_ai_write', '1')");
    res.json({ success: true });
  });
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ error: { code: error.code || 'INTERNAL_ERROR' } });
  });
  server = await startServer(app);
  const address = server.address();

  const pendingResponse = fetch(`http://127.0.0.1:${address.port}/api/ai/delayed-write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project }),
  });
  await handlerEntered;

  db.closeProjectDb(projectPath);
  fs.unlinkSync(projectPath);
  const replacementDb = db.createProjectDb(project);
  const replacementInstanceId = db.captureProjectInstance(project);
  assert.notEqual(replacementInstanceId, originalInstanceId);

  releaseWrite();
  const response = await pendingResponse;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'PROJECT_INSTANCE_MISMATCH');
  assert.equal(
    replacementDb.prepare("SELECT value FROM project_meta WHERE key = 'stale_ai_write'").get(),
    null,
  );
});
