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

test('text exports keep duplicate chapter numbers grouped in volume order', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-export-order-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'ordered-export';
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

  const createResponse = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: project }),
  });
  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  const projectDb = db.getProjectDb(project);
  projectDb.prepare("UPDATE volumes SET title = 'Volume One', sort_order = 1 WHERE id = 1").run();
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title, summary) VALUES (2, 2, 'Volume Two', '')").run();
  const insertChapter = projectDb.prepare(
    "INSERT INTO chapters (volume_id, num, title, content, status) VALUES (?, ?, ?, ?, 'accepted')",
  );
  // Deliberately insert the second volume first so row/id order cannot mask an
  // ORDER BY num regression.
  insertChapter.run(2, 1, 'V2C1', 'second volume one');
  insertChapter.run(1, 2, 'V1C2', 'first volume two');
  insertChapter.run(1, 1, 'V1C1', 'first volume one');
  insertChapter.run(2, 2, 'V2C2', 'second volume two');

  const response = await fetch(`${baseUrl}/${project}/export?format=md&download=1`, {
    headers: { 'X-Mythpen-Project-Instance': created.instanceId },
  });
  assert.equal(response.status, 200);
  const markdown = await response.text();
  const positions = ['# Volume One', 'V1C1', 'V1C2', '# Volume Two', 'V2C1', 'V2C2'].map((value) =>
    markdown.indexOf(value),
  );
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((first, second) => first - second), positions);
});
