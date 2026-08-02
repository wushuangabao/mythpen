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

function readDiskSnapshot(SQL, projectPath) {
  const diskDb = new SQL.Database(fs.readFileSync(projectPath));
  try {
    const chapters = [];
    const statement = diskDb.prepare('SELECT id, content, word_count FROM chapters ORDER BY id');
    while (statement.step()) chapters.push(statement.getAsObject());
    statement.free();
    const result = diskDb.exec("SELECT value FROM project_meta WHERE key = 'word_count'");
    return {
      chapters,
      wordCount: result[0]?.values[0]?.[0] ?? null,
    };
  } finally {
    diskDb.close();
  }
}

async function callJson(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

test('every chapter-count mutation commits aggregate metadata to disk atomically', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-word-count-durability-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const { executeTool } = require('../tools');
  const project = 'durable-word-count';
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
  const projectDb = db.createProjectDb(project);
  projectDb.transaction(() => {
    projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'REST volume')").run();
    projectDb.prepare(`INSERT INTO chapters
      (id, volume_id, num, title, content, word_count, status)
      VALUES (1, 1, 1, 'REST chapter', 'old', 3, 'writing')`).run();
    db.updateProjectWordCount(projectDb);
  })();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const updated = await callJson(baseUrl, `/${project}/chapters/1`, {
    method: 'PUT',
    body: { chapter_id: 1, content: 'new words' },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(readDiskSnapshot(SQL, projectPath), {
    chapters: [{ id: 1, content: 'new words', word_count: 8 }],
    wordCount: '8',
  });

  const deleted = await callJson(baseUrl, `/${project}/chapters/1?chapter_id=1&volume_id=1`, {
    method: 'DELETE',
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(readDiskSnapshot(SQL, projectPath), { chapters: [], wordCount: '0' });

  projectDb.transaction(() => {
    projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (2, 2, 'Deleted REST volume')").run();
    projectDb.prepare(`INSERT INTO chapters
      (id, volume_id, num, title, content, word_count, status)
      VALUES (2, 2, 1, 'Deleted with volume', 'four', 4, 'writing')`).run();
    db.updateProjectWordCount(projectDb);
  })();
  const deletedVolume = await callJson(baseUrl, `/${project}/volumes/2`, { method: 'DELETE' });
  assert.equal(deletedVolume.status, 200);
  assert.deepEqual(readDiskSnapshot(SQL, projectPath), { chapters: [], wordCount: '0' });

  projectDb.transaction(() => {
    projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (3, 3, 'Tool volume')").run();
  })();
  const toolCreated = executeTool(project, 'create_chapter', {
    volume_id: 3,
    chapter_num: 1,
    title: 'Tool chapter',
    content: 'tool create',
  });
  assert.equal(toolCreated.created, true);
  assert.equal(readDiskSnapshot(SQL, projectPath).wordCount, '10');

  const toolUpdated = executeTool(project, 'update_chapter', {
    chapter_id: toolCreated.chapter_id,
    content: 'updated tool',
  });
  assert.equal(toolUpdated.updated, true);
  assert.deepEqual(readDiskSnapshot(SQL, projectPath), {
    chapters: [{ id: toolCreated.chapter_id, content: 'updated tool', word_count: 11 }],
    wordCount: '11',
  });

  const toolDeleted = executeTool(project, 'delete_chapter', {
    chapter_id: toolCreated.chapter_id,
  });
  assert.equal(toolDeleted.deleted, true);
  assert.deepEqual(readDiskSnapshot(SQL, projectPath), { chapters: [], wordCount: '0' });

  projectDb.transaction(() => {
    projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (4, 4, 'Tool-deleted volume')").run();
  })();
  executeTool(project, 'create_chapter', {
    volume_id: 4,
    chapter_num: 1,
    title: 'Deleted by tool volume',
    content: 'volume words',
  });
  const toolDeletedVolume = executeTool(project, 'delete_volume', { volume_id: 4 });
  assert.equal(toolDeletedVolume.deleted, true);
  assert.deepEqual(readDiskSnapshot(SQL, projectPath), { chapters: [], wordCount: '0' });
});
