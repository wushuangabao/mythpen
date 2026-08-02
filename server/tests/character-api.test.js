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

test('updating a character deleted by another writer returns a recoverable 404', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-character-api-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'character-api';
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
  db.createProjectDb(project);
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const created = await callApi(baseUrl, `/${project}/characters`, {
    method: 'POST',
    body: { name: 'Temporary character' },
  });
  assert.equal(created.status, 201);

  const removed = await callApi(baseUrl, `/${project}/characters/${created.body.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);

  const staleUpdate = await callApi(baseUrl, `/${project}/characters/${created.body.id}`, {
    method: 'PUT',
    body: { background: 'This draft must remain recoverable' },
  });
  assert.equal(staleUpdate.status, 404);
  assert.deepEqual(staleUpdate.body, {
    error: { code: 'DB_NOT_FOUND', message: '角色不存在', recoverable: true },
  });

  const appearanceCharacter = await callApi(baseUrl, `/${project}/characters`, {
    method: 'POST',
    body: { name: 'Cross-volume character' },
  });
  assert.equal(appearanceCharacter.status, 201);

  const projectDb = db.getProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume One')").run();
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (2, 2, 'Volume Two')").run();
  projectDb.prepare("INSERT INTO chapters (volume_id, num, title) VALUES (1, 1, 'First volume chapter')").run();
  projectDb.prepare("INSERT INTO chapters (volume_id, num, title) VALUES (2, 1, 'Second volume chapter')").run();
  projectDb.prepare("INSERT INTO chapters (volume_id, num, title) VALUES (NULL, 7, 'Unassigned chapter')").run();
  const firstChapter = projectDb.prepare('SELECT id FROM chapters WHERE volume_id = 1 AND num = 1').get();
  const secondChapter = projectDb.prepare('SELECT id FROM chapters WHERE volume_id = 2 AND num = 1').get();
  const unassignedChapter = projectDb.prepare('SELECT id FROM chapters WHERE volume_id IS NULL AND num = 7').get();
  const insertAppearance = projectDb.prepare(
    'INSERT INTO chapter_characters (chapter_id, character_id, role) VALUES (?, ?, ?)',
  );
  insertAppearance.run(firstChapter.id, appearanceCharacter.body.id, 'appears');
  insertAppearance.run(secondChapter.id, appearanceCharacter.body.id, 'appears');
  // The schema permits both an unassigned chapter and an explicit NULL role.
  // The API keeps the appearance and applies the column's semantic default.
  insertAppearance.run(unassignedChapter.id, appearanceCharacter.body.id, null);

  const listed = await callApi(baseUrl, `/${project}/characters`);
  assert.equal(listed.status, 200);
  const listedCharacter = listed.body.find((character) => character.id === appearanceCharacter.body.id);
  assert.deepEqual(listedCharacter.appearances, [
    {
      chapter_id: firstChapter.id,
      volume_id: 1,
      num: 1,
      title: 'First volume chapter',
      role: 'appears',
    },
    {
      chapter_id: secondChapter.id,
      volume_id: 2,
      num: 1,
      title: 'Second volume chapter',
      role: 'appears',
    },
    {
      chapter_id: unassignedChapter.id,
      volume_id: null,
      num: 7,
      title: 'Unassigned chapter',
      role: 'appears',
    },
  ]);
  assert.equal(listedCharacter.chapterCount, 3);
});
