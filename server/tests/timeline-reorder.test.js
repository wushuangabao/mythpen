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

test('automatic and manual timeline order are persisted and used by AI list queries', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-timeline-reorder-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const { executeTool } = require('../tools');
  const project = 'manual-timeline-order';
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    db.closeProjectDb(db.getProjectDbPath(project));
    // The config DB batches its initial schema flush for 250 ms.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
  });

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  const columns = projectDb.prepare('PRAGMA table_info(timeline_events)').all();
  assert.ok(columns.some((column) => column.name === 'sort_order'));

  const insert = projectDb.prepare(
    'INSERT INTO timeline_events (id, year, title, description, importance, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('first', '2033.10', 'First event', '', 3, 1);
  insert.run('second', '2033.9', 'Second event', '', 3, 2);
  insert.run('third', 'Dynasty Era Three', 'Third event', '', 3, 3);

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const initialMode = await callApi(baseUrl, `/${project}/timeline/order-mode`);
  assert.deepEqual(initialMode.body, { mode: 'auto' });
  const automaticList = await callApi(baseUrl, `/${project}/timeline`);
  assert.deepEqual(automaticList.body.map((event) => event.id), ['second', 'first', 'third']);

  const reordered = await callApi(baseUrl, `/${project}/timeline/order`, {
    method: 'PUT',
    body: { ids: ['third', 'first', 'second'] },
  });
  assert.equal(reordered.status, 200);

  const manualMode = await callApi(baseUrl, `/${project}/timeline/order-mode`);
  assert.deepEqual(manualMode.body, { mode: 'manual' });

  const list = await callApi(baseUrl, `/${project}/timeline`);
  assert.deepEqual(list.body.map((event) => event.id), ['third', 'first', 'second']);
  assert.deepEqual(
    executeTool(project, 'list_timeline', {}).map((event) => event.id),
    ['third', 'first', 'second'],
  );

  const invalid = await callApi(baseUrl, `/${project}/timeline/order`, {
    method: 'PUT',
    body: { ids: ['third', 'third', 'second'] },
  });
  assert.equal(invalid.status, 400);
  const unchanged = await callApi(baseUrl, `/${project}/timeline`);
  assert.deepEqual(unchanged.body.map((event) => event.id), ['third', 'first', 'second']);

  const updated = await callApi(baseUrl, `/${project}/timeline/first`, {
    method: 'PUT',
    body: { year: '2032' },
  });
  assert.equal(updated.status, 200);
  const stillManual = await callApi(baseUrl, `/${project}/timeline`);
  assert.deepEqual(stillManual.body.map((event) => event.id), ['third', 'first', 'second']);

  const restored = await callApi(baseUrl, `/${project}/timeline/order-mode`, {
    method: 'PUT',
    body: { mode: 'auto' },
  });
  assert.deepEqual(restored.body, { success: true, mode: 'auto' });
  const restoredList = await callApi(baseUrl, `/${project}/timeline`);
  assert.deepEqual(restoredList.body.map((event) => event.id), ['first', 'second', 'third']);
  assert.deepEqual(
    executeTool(project, 'list_timeline', {}).map((event) => event.id),
    ['first', 'second', 'third'],
  );

  const created = await callApi(baseUrl, `/${project}/timeline`, {
    method: 'POST',
    body: { year: 'New Era One', title: 'Fourth event', importance: 3 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.sort_order, 4);
  const withNewEvent = await callApi(baseUrl, `/${project}/timeline`);
  assert.deepEqual(withNewEvent.body.map((event) => event.id), ['first', 'second', 'third', created.body.id]);
});
