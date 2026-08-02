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

test('a filesystem deletion failure is not reported as project deletion success', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-project-delete-api-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'undeletable-project';
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

  const created = await callApi(baseUrl, '/projects', {
    method: 'POST',
    body: { name: project },
  });
  assert.equal(created.status, 200);
  assert.match(created.body.instanceId, /^[0-9a-f-]{36}$/i);

  const projectPath = db.getProjectDbPath(project);
  assert.equal(fs.existsSync(projectPath), true);
  const immediateList = await callApi(baseUrl, '/projects');
  assert.equal(immediateList.status, 200);
  assert.equal(
    immediateList.body.find((candidate) => candidate.name === project)?.instanceId,
    created.body.instanceId,
  );
  const immediateGet = await callApi(baseUrl, `/projects/${project}`);
  assert.equal(immediateGet.status, 200);
  const duplicate = await callApi(baseUrl, '/projects', {
    method: 'POST',
    body: { name: project },
  });
  assert.equal(duplicate.status, 409);

  const coverDir = db.getCoverDir(project);
  const coverPath = path.join(coverDir, 'cover.png');
  const webpCoverPath = path.join(coverDir, 'cover.webp');
  const jpgCoverPath = path.join(coverDir, 'cover.jpg');
  const exportPath = path.join(coverDir, 'exported-cover-notes.txt');
  const coverBytes = Buffer.from('old-project-cover');
  const webpCoverBytes = Buffer.from('replacement-webp-cover');
  const jpgCoverBytes = Buffer.from('secondary-jpg-cover');
  const exportBytes = Buffer.from('must not be deleted');
  const listCoverTombstones = () => fs.readdirSync(coverDir).filter((name) => name.includes('.cover-delete-'));

  const uploadedPngCover = await callApi(baseUrl, `/${project}/cover`, {
    method: 'POST',
    body: { data: coverBytes.toString('base64'), mime: 'image/png' },
  });
  assert.equal(uploadedPngCover.status, 200);
  assert.deepEqual(fs.readFileSync(coverPath), coverBytes);

  const uploadedWebpCover = await callApi(baseUrl, `/${project}/cover`, {
    method: 'POST',
    body: { data: webpCoverBytes.toString('base64'), mime: 'image/webp' },
  });
  assert.equal(uploadedWebpCover.status, 200);
  assert.equal(fs.existsSync(coverPath), false);
  assert.deepEqual(fs.readFileSync(webpCoverPath), webpCoverBytes);
  const servedWebpCover = await fetch(`${baseUrl}/${project}/cover`, {
    headers: { 'X-Mythpen-Project-Instance': created.body.instanceId },
  });
  assert.equal(servedWebpCover.status, 200);
  assert.equal(servedWebpCover.headers.get('content-type'), 'image/webp');
  assert.deepEqual(Buffer.from(await servedWebpCover.arrayBuffer()), webpCoverBytes);

  const restoredPngCover = await callApi(baseUrl, `/${project}/cover`, {
    method: 'POST',
    body: { data: coverBytes.toString('base64'), mime: 'image/png' },
  });
  assert.equal(restoredPngCover.status, 200);
  assert.deepEqual(fs.readFileSync(coverPath), coverBytes);
  assert.equal(fs.existsSync(webpCoverPath), false);

  // Simulate legacy/malformed state with more than one recognised cover and an
  // unrelated export artifact. Project deletion must stage only known covers.
  fs.writeFileSync(jpgCoverPath, jpgCoverBytes);
  fs.writeFileSync(exportPath, exportBytes);

  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (path.resolve(String(source)) === path.resolve(jpgCoverPath)) {
      const error = new Error('cover is busy');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRenameSync(source, destination);
  };

  let failedCoverDelete;
  try {
    failedCoverDelete = await callApi(baseUrl, `/projects/${project}`, { method: 'DELETE' });
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(failedCoverDelete.status, 500);
  assert.equal(failedCoverDelete.body.error.code, 'PROJECT_DELETE_FAILED');
  assert.equal(failedCoverDelete.body.error.recoverable, true);
  assert.equal(fs.existsSync(projectPath), true);
  assert.deepEqual(fs.readFileSync(coverPath), coverBytes);
  assert.deepEqual(fs.readFileSync(jpgCoverPath), jpgCoverBytes);
  assert.deepEqual(fs.readFileSync(exportPath), exportBytes);
  assert.deepEqual(listCoverTombstones(), []);
  assert.equal(db.dbGet('SELECT name FROM recent_projects WHERE name = ?', [project]).name, project);

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (path.resolve(String(target)) === path.resolve(projectPath)) {
      const error = new Error('file is busy');
      error.code = 'EBUSY';
      throw error;
    }
    return originalUnlinkSync(target);
  };

  let failedDelete;
  try {
    failedDelete = await callApi(baseUrl, `/projects/${project}`, { method: 'DELETE' });
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(failedDelete.status, 500);
  assert.deepEqual(failedDelete.body, {
    error: {
      code: 'PROJECT_DELETE_FAILED',
      message: `无法删除项目"${project}"，请稍后重试`,
      recoverable: true,
    },
  });
  assert.equal(fs.existsSync(projectPath), true);
  assert.deepEqual(fs.readFileSync(coverPath), coverBytes);
  assert.deepEqual(fs.readFileSync(jpgCoverPath), jpgCoverBytes);
  assert.deepEqual(fs.readFileSync(exportPath), exportBytes);
  assert.deepEqual(listCoverTombstones(), []);
  assert.equal(db.dbGet('SELECT name FROM recent_projects WHERE name = ?', [project]).name, project);

  const retry = await callApi(baseUrl, `/projects/${project}`, { method: 'DELETE' });
  assert.equal(retry.status, 200);
  assert.equal(fs.existsSync(projectPath), false);
  assert.equal(fs.existsSync(coverPath), false);
  assert.equal(fs.existsSync(jpgCoverPath), false);
  assert.deepEqual(fs.readFileSync(exportPath), exportBytes);
  assert.deepEqual(listCoverTombstones(), []);
  assert.equal(db.dbGet('SELECT name FROM recent_projects WHERE name = ?', [project]), null);

  const replacement = await callApi(baseUrl, '/projects', {
    method: 'POST',
    body: { name: project },
  });
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.body.instanceId, created.body.instanceId);
  const replacementCover = await fetch(`${baseUrl}/${project}/cover`, {
    headers: { 'X-Mythpen-Project-Instance': replacement.body.instanceId },
  });
  assert.equal(replacementCover.status, 404);
});
