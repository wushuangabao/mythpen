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

test('project-data routes remain reachable when the project is named projects', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-project-route-collision-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const projectName of ['projects', 'chapters', 'cover', 'target-words']) {
      db.closeProjectDb(db.getProjectDbPath(projectName));
    }
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

  const projectsProject = await callApi(baseUrl, '/projects', {
    method: 'POST',
    body: { name: 'projects' },
  });
  assert.equal(projectsProject.status, 200);

  const createdChapter = await callApi(baseUrl, '/projects/chapters', {
    method: 'POST',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
    body: { title: 'Reserved-name chapter' },
  });
  assert.equal(createdChapter.status, 201);

  const chapterList = await callApi(baseUrl, '/projects/chapters', {
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(chapterList.status, 200);
  assert.equal(chapterList.body.length, 1);
  assert.equal(chapterList.body[0].title, 'Reserved-name chapter');

  const chaptersProject = await callApi(baseUrl, '/projects', {
    method: 'POST',
    body: { name: 'chapters' },
  });
  assert.equal(chaptersProject.status, 200);
  const metadata = await callApi(baseUrl, '/projects/by-name/chapters', {
    headers: { 'X-Mythpen-Project-Instance': chaptersProject.body.instanceId },
  });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.name, 'chapters');
  assert.equal(metadata.body.project_instance_id, chaptersProject.body.instanceId);

  for (const reservedResourceName of ['cover', 'target-words']) {
    const created = await callApi(baseUrl, '/projects', {
      method: 'POST',
      body: { name: reservedResourceName },
    });
    assert.equal(created.status, 200);
  }

  const uploadedCover = await callApi(baseUrl, '/projects/cover', {
    method: 'POST',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
    body: { data: Buffer.from('reserved-name-cover').toString('base64'), mime: 'image/png' },
  });
  assert.equal(uploadedCover.status, 200);

  const deletedCover = await callApi(baseUrl, '/projects/cover', {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(deletedCover.status, 200);

  const resetTargetWords = await callApi(baseUrl, '/projects/target-words', {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(resetTargetWords.status, 200);

  for (const reservedResourceName of ['cover', 'target-words']) {
    const stillPresent = await callApi(baseUrl, `/projects/by-name/${reservedResourceName}`);
    assert.equal(stillPresent.status, 200);
    assert.equal(stillPresent.body.name, reservedResourceName);
  }

  const deletedProjectsProject = await callApi(baseUrl, '/projects/by-name/projects', {
    method: 'DELETE',
    headers: { 'X-Mythpen-Project-Instance': projectsProject.body.instanceId },
  });
  assert.equal(deletedProjectsProject.status, 200);
});
