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

async function callApi(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('cover replacement rolls back as a unit and deletion removes every recognised format', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-cover-api-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'cover-project';
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.closeProjectDb(db.getProjectDbPath(project));
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
  });

  await db.initDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const created = await callApi(baseUrl, '/projects', { method: 'POST', body: { name: project } });
  assert.equal(created.status, 200);
  const headers = { 'X-Mythpen-Project-Instance': created.body.instanceId };
  const pngBytes = Buffer.from('authoritative-png');
  const jpgBytes = Buffer.from('legacy-jpg');
  const webpBytes = Buffer.from('replacement-webp');
  const coverDir = db.getCoverDir(project);
  const pngPath = path.join(coverDir, 'cover.png');
  const jpgPath = path.join(coverDir, 'cover.jpg');
  const webpPath = path.join(coverDir, 'cover.webp');
  const tombstones = () => fs.readdirSync(coverDir).filter((name) => name.includes('.cover-delete-'));

  const pngUpload = await callApi(baseUrl, `/${project}/cover`, {
    method: 'POST',
    headers,
    body: { data: pngBytes.toString('base64'), mime: 'image/png' },
  });
  assert.equal(pngUpload.status, 200);
  fs.writeFileSync(jpgPath, jpgBytes);

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(String(source)) === path.resolve(jpgPath)) {
      const error = new Error('legacy cover is busy');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRenameSync(source, destination);
  };

  let failedReplacement;
  try {
    failedReplacement = await callApi(baseUrl, `/${project}/cover`, {
      method: 'POST',
      headers,
      body: { data: webpBytes.toString('base64'), mime: 'image/webp' },
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(failedReplacement.status, 500);
  assert.equal(failedReplacement.body.error.code, 'COVER_UPDATE_FAILED');
  assert.deepEqual(fs.readFileSync(pngPath), pngBytes);
  assert.deepEqual(fs.readFileSync(jpgPath), jpgBytes);
  assert.equal(fs.existsSync(webpPath), false);
  assert.deepEqual(tombstones(), []);

  const replacement = await callApi(baseUrl, `/${project}/cover`, {
    method: 'POST',
    headers,
    body: { data: webpBytes.toString('base64'), mime: 'image/webp' },
  });
  assert.equal(replacement.status, 200);
  assert.equal(fs.existsSync(pngPath), false);
  assert.equal(fs.existsSync(jpgPath), false);
  assert.deepEqual(fs.readFileSync(webpPath), webpBytes);

  // Simulate a legacy multi-format directory. One DELETE must not expose the
  // next extension after reporting success.
  fs.writeFileSync(pngPath, pngBytes);
  fs.writeFileSync(jpgPath, jpgBytes);
  const deleted = await callApi(baseUrl, `/${project}/cover`, { method: 'DELETE', headers });
  assert.equal(deleted.status, 200);
  assert.equal(fs.existsSync(pngPath), false);
  assert.equal(fs.existsSync(jpgPath), false);
  assert.equal(fs.existsSync(webpPath), false);
  assert.deepEqual(tombstones(), []);
});
