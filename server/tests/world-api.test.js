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

test('world REST API validates categories and preserves the complete CRUD contract', async (t) => {
  const { parseWorldTags, serializeWorldTags } = require('../world-tags');
  assert.deepEqual(parseWorldTags('priority， city, priority'), ['priority', 'city']);
  assert.equal(serializeWorldTags(['city', 'city', 'future']), '["city","future"]');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-world-api-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const { executeTool } = require('../tools');
  const project = 'world-api';
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

  const invalidCreate = await callApi(baseUrl, `/${project}/world`, {
    method: 'POST',
    body: { category: 'alien', name: 'Must not persist', description: 'invalid' },
  });

  const created = await callApi(baseUrl, `/${project}/world`, {
    method: 'POST',
    body: {
      category: 'location',
      name: 'City archive',
      description: 'A living archive beneath the city.',
      tags: 'priority， city, priority',
    },
  });
  assert.equal(created.status, 201);

  const invalidUpdate = await callApi(baseUrl, `/${project}/world/${created.body.id}`, {
    method: 'PUT',
    body: {
      category: 'alien',
      name: 'Must not replace the valid name',
      description: 'Must not replace the valid description',
      tags: ['must-not-persist'],
    },
  });

  const afterRejectedMutations = await callApi(baseUrl, `/${project}/world`);
  assert.deepEqual(
    [invalidCreate.status, invalidUpdate.status],
    [400, 400],
    'REST create and update must both reject categories outside the shared enum',
  );
  assert.equal(invalidCreate.body.error.code, 'INVALID_PARAMS');
  assert.equal(invalidUpdate.body.error.code, 'INVALID_PARAMS');
  assert.deepEqual(afterRejectedMutations.body, [{
    id: created.body.id,
    category: 'location',
    name: 'City archive',
    description: 'A living archive beneath the city.',
    tags: '["priority","city"]',
    created_at: afterRejectedMutations.body[0].created_at,
    updated_at: afterRejectedMutations.body[0].updated_at,
  }]);

  const updated = await callApi(baseUrl, `/${project}/world/${created.body.id}`, {
    method: 'PUT',
    body: {
      category: 'technology',
      name: 'Living city archive',
      description: 'An archive that rewrites itself every night.',
      tags: ['city', 'city', 'future'],
    },
  });
  assert.equal(updated.status, 200);

  const afterUpdate = await callApi(baseUrl, `/${project}/world`);
  assert.deepEqual(afterUpdate.body.map(({ created_at, updated_at, ...entry }) => entry), [{
    id: created.body.id,
    category: 'technology',
    name: 'Living city archive',
    description: 'An archive that rewrites itself every night.',
    tags: '["city","future"]',
  }]);

  const crossEntryUpdate = executeTool(project, 'update_world_entry', {
    id: created.body.id,
    name: 'Archive visible through both entry points',
  });
  assert.equal(crossEntryUpdate.updated, true);
  const afterToolUpdate = await callApi(baseUrl, `/${project}/world`);
  assert.equal(afterToolUpdate.body[0].name, 'Archive visible through both entry points');

  const deleted = await callApi(baseUrl, `/${project}/world/${created.body.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const afterDelete = await callApi(baseUrl, `/${project}/world`);
  assert.deepEqual(afterDelete.body, []);
});
