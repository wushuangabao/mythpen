const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { openControlStore } = require('../control-store');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

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

function projectControlStore(database, projectName) {
  const filePath = database.getProjectDbPath(projectName);
  const dbKey = createHash('sha256').update(canonicalDatabasePath(filePath)).digest('hex');
  return openControlStore(path.join(database.getDataDir(), 'control', 'sqlite', dbKey));
}

test('chapter writes use stable ids and stale versions cannot overwrite accepted revisions', async (t) => {
  withIsolatedDataDir(t);

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'chapter-update-api';
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume One')").run();
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (2, 2, 'Volume Two')").run();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const first = await callApi(baseUrl, `/${project}/chapters`, {
    method: 'POST',
    body: { volume_id: 1, chapter_num: 1, title: 'Volume one chapter' },
  });
  const second = await callApi(baseUrl, `/${project}/chapters`, {
    method: 'POST',
    body: { volume_id: 2, chapter_num: 1, title: 'Volume two chapter' },
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.volume_id, 1);
  assert.equal(second.body.volume_id, 2);
  assert.notEqual(first.body.id, second.body.id);

  const updateControlStore = projectControlStore(db, project);
  const updateEventsBefore = updateControlStore.read();
  const preparedBeforeUpdate = updateEventsBefore
    .filter((event) => event.type === 'sqlite.publish.prepared').length;
  const preciseUpdate = await callApi(baseUrl, `/${project}/chapters/1`, {
    method: 'PUT',
    body: { chapter_id: first.body.id, title: 'Saved volume one chapter', content: 'Saved content' },
  });
  assert.equal(preciseUpdate.status, 200);
  assert.equal(preciseUpdate.body.id, first.body.id);
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(first.body.id),
    { title: 'Saved volume one chapter', content: 'Saved content' },
  );
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(second.body.id),
    { title: 'Volume two chapter', content: '' },
  );
  const updateEventsAfter = updateControlStore.read();
  assert.equal(
    updateEventsAfter.filter((event) => event.type === 'sqlite.publish.prepared').length,
    preparedBeforeUpdate + 1,
  );
  const restSourceEvent = updateEventsAfter
    .filter((event) => event.type === 'manuscript.body_mutation.attempt')
    .at(-1);
  assert.equal(restSourceEvent.payload.source, 'rest');
  assert.equal(updateEventsAfter[updateEventsAfter.indexOf(restSourceEvent) + 1].type, 'sqlite.publish.prepared');

  const chaptersBeforeMismatchedUpdate = projectDb
    .prepare('SELECT id, title, content FROM chapters ORDER BY id')
    .all();
  const mismatchedIdUpdate = await callApi(baseUrl, `/${project}/chapters/2`, {
    method: 'PUT',
    body: { chapter_id: first.body.id, title: 'Must not follow the id', content: 'Must not be written' },
  });
  assert.equal(mismatchedIdUpdate.status, 409);
  assert.equal(mismatchedIdUpdate.body.error.code, 'CHAPTER_IDENTITY_MISMATCH');
  assert.deepEqual(
    projectDb.prepare('SELECT id, title, content FROM chapters ORDER BY id').all(),
    chaptersBeforeMismatchedUpdate,
  );

  const ambiguousLegacyUpdate = await callApi(baseUrl, `/${project}/chapters/1`, {
    method: 'PUT',
    body: { title: 'Must not update either chapter' },
  });
  assert.equal(ambiguousLegacyUpdate.status, 409);
  assert.equal(ambiguousLegacyUpdate.body.error.code, 'AMBIGUOUS_CHAPTER');
  assert.equal(
    projectDb.prepare('SELECT title FROM chapters WHERE id = ?').get(first.body.id).title,
    'Saved volume one chapter',
  );
  assert.equal(
    projectDb.prepare('SELECT title FROM chapters WHERE id = ?').get(second.body.id).title,
    'Volume two chapter',
  );

  const ambiguousLegacyGet = await callApi(baseUrl, `/${project}/chapters/1`);
  assert.equal(ambiguousLegacyGet.status, 409);
  assert.equal(ambiguousLegacyGet.body.error.code, 'AMBIGUOUS_CHAPTER');

  const preciseVolumeGet = await callApi(baseUrl, `/${project}/chapters/1?volume_id=2`);
  assert.equal(preciseVolumeGet.status, 200);
  assert.equal(preciseVolumeGet.body.id, second.body.id);

  const preciseIdGet = await callApi(baseUrl, `/${project}/chapters/1?chapter_id=${first.body.id}`);
  assert.equal(preciseIdGet.status, 200);
  assert.equal(preciseIdGet.body.id, first.body.id);

  const insertRevision = projectDb.prepare(
    'INSERT INTO chapter_revisions (chapter_id, base_content, proposed_content) VALUES (?, ?, ?)',
  );
  insertRevision.run(first.body.id, 'first base', 'first proposal');
  insertRevision.run(second.body.id, 'second base', 'second proposal');

  const ambiguousLegacyDelete = await callApi(baseUrl, `/${project}/chapters/1`, { method: 'DELETE' });
  assert.equal(ambiguousLegacyDelete.status, 409);
  assert.equal(ambiguousLegacyDelete.body.error.code, 'AMBIGUOUS_CHAPTER');
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM chapters WHERE num = 1').get().count, 2);
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM chapter_revisions').get().count, 2);

  const preciseVolumeDelete = await callApi(baseUrl, `/${project}/chapters/1?volume_id=1`, { method: 'DELETE' });
  assert.equal(preciseVolumeDelete.status, 200);
  assert.equal(preciseVolumeDelete.body.chapter_id, first.body.id);
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(first.body.id), null);
  assert.equal(projectDb.prepare('SELECT id FROM chapter_revisions WHERE chapter_id = ?').get(first.body.id), null);
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(second.body.id).id, second.body.id);
  assert.ok(projectDb.prepare('SELECT id FROM chapter_revisions WHERE chapter_id = ?').get(second.body.id));

  const replacement = await callApi(baseUrl, `/${project}/chapters`, {
    method: 'POST',
    body: { volume_id: 1, chapter_num: 1, title: 'Replacement volume one chapter' },
  });
  assert.equal(replacement.status, 201);
  insertRevision.run(replacement.body.id, 'replacement base', 'replacement proposal');

  const preciseIdDelete = await callApi(
    baseUrl,
    `/${project}/chapters/1?chapter_id=${replacement.body.id}`,
    { method: 'DELETE' },
  );
  assert.equal(preciseIdDelete.status, 200);
  assert.equal(preciseIdDelete.body.chapter_id, replacement.body.id);
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(replacement.body.id), null);
  assert.equal(projectDb.prepare('SELECT id FROM chapter_revisions WHERE chapter_id = ?').get(replacement.body.id), null);
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(second.body.id).id, second.body.id);

  const casChapter = await callApi(baseUrl, `/${project}/chapters`, {
    method: 'POST',
    body: { volume_id: 1, chapter_num: 2, title: 'CAS chapter' },
  });
  assert.equal(casChapter.status, 201);
  const seededChapter = await callApi(baseUrl, `/${project}/chapters/2`, {
    method: 'PUT',
    body: { chapter_id: casChapter.body.id, content: 'Original chapter', status: 'writing' },
  });
  assert.equal(seededChapter.status, 200);
  const originalChapter = seededChapter.body;

  for (const invalidVersion of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = await callApi(baseUrl, `/${project}/chapters/2`, {
      method: 'PUT',
      body: {
        chapter_id: originalChapter.id,
        expected_data_version: invalidVersion,
        content: 'Must not be written',
      },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'INVALID_PARAMS');
  }
  assert.deepEqual(
    projectDb.prepare('SELECT content, data_version FROM chapters WHERE id = ?').get(originalChapter.id),
    { content: 'Original chapter', data_version: originalChapter.data_version },
  );

  const revision = await callApi(baseUrl, `/${project}/chapters/${originalChapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: 'Original chapter', proposedContent: 'Accepted revision' },
  });
  assert.equal(revision.status, 201);
  const accepted = await callApi(baseUrl, `/${project}/revisions/${revision.body.revision.id}/accept-all`, {
    method: 'POST',
    body: { expectedBaseContent: 'Original chapter' },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.content, 'Accepted revision');

  const authoritative = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(originalChapter.id);
  assert.equal(authoritative.content, 'Accepted revision');
  assert.ok(authoritative.data_version > originalChapter.data_version);

  const staleDraft = await callApi(baseUrl, `/${project}/chapters/2`, {
    method: 'PUT',
    body: {
      chapter_id: originalChapter.id,
      expected_data_version: originalChapter.data_version,
      content: 'Stale queued draft',
    },
  });
  assert.equal(staleDraft.status, 409);
  assert.equal(staleDraft.body.error.code, 'CHAPTER_VERSION_CONFLICT');
  assert.equal(staleDraft.body.error.recoverable, true);
  assert.equal(staleDraft.body.current_data_version, authoritative.data_version);
  assert.equal(staleDraft.body.chapter.id, originalChapter.id);
  assert.equal(staleDraft.body.chapter.content, 'Accepted revision');
  assert.equal(staleDraft.body.chapter.data_version, authoritative.data_version);
  assert.deepEqual(
    projectDb.prepare('SELECT content, data_version FROM chapters WHERE id = ?').get(originalChapter.id),
    { content: 'Accepted revision', data_version: authoritative.data_version },
  );

  const coordinatedSave = await callApi(baseUrl, `/${project}/chapters/2`, {
    method: 'PUT',
    body: {
      chapter_id: originalChapter.id,
      expected_data_version: authoritative.data_version,
      content: 'Coordinated draft',
    },
  });
  assert.equal(coordinatedSave.status, 200);
  assert.equal(coordinatedSave.body.content, 'Coordinated draft');
  assert.equal(coordinatedSave.body.data_version, authoritative.data_version + 1);

  const missing = await callApi(baseUrl, `/${project}/chapters/2`, {
    method: 'PUT',
    body: {
      chapter_id: originalChapter.id + 999,
      expected_data_version: originalChapter.data_version,
      content: 'Must not be written',
    },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'DB_NOT_FOUND');
});

test('chapter PUT publication failure returns the primary error and leaves formal bytes unchanged', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'chapter-update-publication-failure';
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, content, word_count) VALUES (1, 1, 'Before title', 'Before body', 10)")
    .run());
  const chapter = projectDb.prepare('SELECT * FROM chapters WHERE id = 1').get();
  const projectPath = db.getProjectDbPath(project);
  const formalBefore = fs.readFileSync(projectPath);
  const controlStore = projectControlStore(db, project);
  const preparedBefore = controlStore.read().filter((event) => event.type === 'sqlite.publish.prepared').length;
  // Drain the unrelated delayed config-db flush before enabling a process-wide
  // AtomicStore fault intended only for this project's synchronous request.
  db.flushAllDatabases();
  const { projectWriteDiagnostics } = require('../testing/database-internals');
  db.closeProjectDb(projectPath);
  const leaseCountBefore = projectWriteDiagnostics().leaseAcquisitionCount(projectPath);

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use((error, _req, res, _next) => {
    res.status(503).json({ code: error.code, faultPoint: error.faultPoint });
  });
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const response = await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
  }, async () => callApi(baseUrl, `/${project}/chapters/1`, {
    method: 'PUT',
    body: {
      chapter_id: chapter.id,
      expected_data_version: chapter.data_version,
      title: 'After title',
      content: 'After body',
    },
  }));

  assert.equal(response.status, 503);
  assert.equal(
    projectWriteDiagnostics().leaseAcquisitionCount(projectPath),
    leaseCountBefore + 1,
  );
  assert.deepEqual(response.body, {
    code: 'EIO',
    faultPoint: FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE,
  });
  assert.deepEqual(fs.readFileSync(projectPath), formalBefore);
  const events = controlStore.read();
  assert.equal(
    events.filter((event) => event.type === 'sqlite.publish.prepared').length,
    preparedBefore,
  );
  const sourceEvent = events.filter((event) => event.type === 'manuscript.body_mutation.attempt').at(-1);
  assert.equal(sourceEvent.payload.source, 'rest');
  assert.equal(JSON.stringify(sourceEvent).includes('After body'), false);
  assert.equal(JSON.stringify(sourceEvent).includes('After title'), false);

  db.projectExecute(
    project,
    'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
    ['after_failed_rest_body', 1, 1, 'model'],
  );
  assert.deepEqual(
    db.projectGet(project, 'SELECT title, content FROM chapters WHERE id = ?', [chapter.id]),
    { title: 'Before title', content: 'Before body' },
  );
});
