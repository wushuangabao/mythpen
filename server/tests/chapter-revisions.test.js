const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { openControlStore } = require('../control-store');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { getWasmBinary } = require('../wasm-binary');
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

async function readFormalRows(filePath, sql, params = []) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    const statement = database.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  } finally {
    database.close();
  }
}

test('chapter revisions enter review immediately and rebase after outside edits', {
  timeout: 15_000,
}, async (t) => {
  withIsolatedDataDir(t);

  const db = require('../db');
  const express = require('express');
  const apiRouter = require('../routes/api');
  const project = 'revision-api';
  const original = 'Original chapter';
  const polished = 'Polished chapter';
  let server;

  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  assert.equal(projectDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value, '10');
  assert.ok(projectDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_revisions'").get());

  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, content, word_count, status) VALUES (1, 1, 'Chapter', ?, ?, 'writing')")
    .run(original, original.length));
  const chapter = projectDb.prepare('SELECT * FROM chapters WHERE id = 1').get();

  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  server = await startServer(app);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  const blankCreatedCharacter = await callApi(baseUrl, `/${project}/characters`, {
    method: 'POST',
    body: { name: '   ' },
  });
  assert.equal(blankCreatedCharacter.status, 400);
  const nonStringCharacter = await callApi(baseUrl, `/${project}/characters`, {
    method: 'POST',
    body: { name: 42 },
  });
  assert.equal(nonStringCharacter.status, 400);

  const createdCharacter = await callApi(baseUrl, `/${project}/characters`, {
    method: 'POST',
    body: { name: '  Original name  ' },
  });
  assert.equal(createdCharacter.status, 201);
  assert.equal(createdCharacter.body.name, 'Original name');
  const blankCharacterName = await callApi(baseUrl, `/${project}/characters/${createdCharacter.body.id}`, {
    method: 'PUT',
    body: { name: '   ' },
  });
  assert.equal(blankCharacterName.status, 400);
  assert.equal(
    projectDb.prepare('SELECT name FROM characters WHERE id = ?').get(createdCharacter.body.id).name,
    'Original name',
  );
  const trimmedCharacterName = await callApi(baseUrl, `/${project}/characters/${createdCharacter.body.id}`, {
    method: 'PUT',
    body: { name: '  Renamed character  ' },
  });
  assert.equal(trimmedCharacterName.status, 200);
  assert.equal(
    projectDb.prepare('SELECT name FROM characters WHERE id = ?').get(createdCharacter.body.id).name,
    'Renamed character',
  );

  const created = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: original, proposedContent: polished },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.revision.baseContent, original);
  assert.equal(created.body.revision.proposedContent, polished);
  assert.deepEqual(projectDb.prepare('SELECT content, status FROM chapters WHERE id = ?').get(chapter.id), {
    content: original,
    status: 'review',
  });

  const active = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions/active`);
  assert.equal(active.status, 200);
  assert.equal(active.body.rebased, false);
  assert.equal(active.body.revision.id, created.body.revision.id);
  assert.equal(
    active.body.chapterDataVersion,
    projectDb.prepare('SELECT data_version FROM chapters WHERE id = ?').get(chapter.id).data_version,
  );

  const missingBaseDecision = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}`, {
    method: 'PATCH',
    body: { decisions: { 'change-0': 'accepted' } },
  });
  assert.equal(missingBaseDecision.status, 400);
  const invalidBaseDecision = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}`, {
    method: 'PATCH',
    body: { decisions: { 'change-0': 'accepted' }, expectedBaseContent: 42 },
  });
  assert.equal(invalidBaseDecision.status, 400);
  assert.deepEqual(
    JSON.parse(projectDb.prepare('SELECT decisions_json FROM chapter_revisions WHERE id = ?').get(created.body.revision.id).decisions_json),
    {},
  );

  for (const action of ['accept-all', 'reject-all']) {
    const missingBase = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}/${action}`, {
      method: 'POST',
      body: {},
    });
    assert.equal(missingBase.status, 400);
    const invalidBase = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}/${action}`, {
      method: 'POST',
      body: { expectedBaseContent: 42 },
    });
    assert.equal(invalidBase.status, 400);
  }

  const missingFinalizeBase = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}/finalize`, {
    method: 'POST',
    body: { content: polished, expectedDecisions: {} },
  });
  assert.equal(missingFinalizeBase.status, 400);
  const missingFinalizeDecisions = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}/finalize`, {
    method: 'POST',
    body: { content: polished, expectedBaseContent: original },
  });
  assert.equal(missingFinalizeDecisions.status, 400);
  assert.equal(projectDb.prepare('SELECT status FROM chapter_revisions WHERE id = ?').get(created.body.revision.id).status, 'pending');

  const firstClientDecision = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}`, {
    method: 'PATCH',
    body: { decisions: { 'change-0': 'accepted' }, expectedBaseContent: original },
  });
  assert.equal(firstClientDecision.status, 200);
  assert.deepEqual(firstClientDecision.body.revision.decisions, { 'change-0': 'accepted' });

  // Two clients can start from the same empty decision snapshot and then save
  // different hunks. The second PATCH must not replace the first client's hunk.
  const secondClientDecision = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}`, {
    method: 'PATCH',
    body: { decisions: { 'change-1': 'rejected' }, expectedBaseContent: original },
  });
  assert.equal(secondClientDecision.status, 200);
  assert.deepEqual(secondClientDecision.body.revision.decisions, {
    'change-0': 'accepted',
    'change-1': 'rejected',
  });

  // A later delta from the first client must not replay that client's stale
  // view of change-1. Only the explicitly changed hunk participates in LWW.
  const firstClientLaterDecision = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}`, {
    method: 'PATCH',
    body: { decisions: { 'change-2': 'accepted' }, expectedBaseContent: original },
  });
  assert.equal(firstClientLaterDecision.status, 200);
  assert.deepEqual(firstClientLaterDecision.body.revision.decisions, {
    'change-0': 'accepted',
    'change-1': 'rejected',
    'change-2': 'accepted',
  });

  const changedExistingDecision = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}`, {
    method: 'PATCH',
    body: { decisions: { 'change-1': 'accepted' }, expectedBaseContent: original },
  });
  assert.equal(changedExistingDecision.status, 200);
  assert.deepEqual(changedExistingDecision.body.revision.decisions, {
    'change-0': 'accepted',
    'change-1': 'accepted',
    'change-2': 'accepted',
  });

  const finalized = await callApi(baseUrl, `/${project}/revisions/${created.body.revision.id}/finalize`, {
    method: 'POST',
    body: {
      content: polished,
      expectedBaseContent: original,
      expectedDecisions: changedExistingDecision.body.revision.decisions,
    },
  });
  assert.equal(finalized.status, 200);
  const acceptedChapter = projectDb.prepare('SELECT content, status FROM chapters WHERE id = ?').get(chapter.id);
  assert.deepEqual(acceptedChapter, { content: polished, status: 'accepted' });

  const conflictingCandidate = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: 'A proposal decided in two windows' },
  });
  const firstWindowSnapshot = await callApi(
    baseUrl,
    `/${project}/revisions/${conflictingCandidate.body.revision.id}`,
    {
      method: 'PATCH',
      body: { decisions: { 'change-0': 'accepted' }, expectedBaseContent: polished },
    },
  );
  const secondWindowSnapshot = await callApi(
    baseUrl,
    `/${project}/revisions/${conflictingCandidate.body.revision.id}`,
    {
      method: 'PATCH',
      body: { decisions: { 'change-0': 'rejected' }, expectedBaseContent: polished },
    },
  );
  const staleFinalize = await callApi(
    baseUrl,
    `/${project}/revisions/${conflictingCandidate.body.revision.id}/finalize`,
    {
      method: 'POST',
      body: {
        content: conflictingCandidate.body.revision.proposedContent,
        expectedBaseContent: polished,
        expectedDecisions: firstWindowSnapshot.body.revision.decisions,
      },
    },
  );
  assert.equal(staleFinalize.status, 200);
  assert.equal(staleFinalize.body.conflicted, true);
  assert.deepEqual(staleFinalize.body.revision.decisions, { 'change-0': 'rejected' });
  assert.deepEqual(
    projectDb.prepare('SELECT content, status FROM chapters WHERE id = ?').get(chapter.id),
    { content: polished, status: 'review' },
  );

  const currentFinalize = await callApi(
    baseUrl,
    `/${project}/revisions/${conflictingCandidate.body.revision.id}/finalize`,
    {
      method: 'POST',
      body: {
        content: polished,
        expectedBaseContent: polished,
        expectedDecisions: secondWindowSnapshot.body.revision.decisions,
      },
    },
  );
  assert.equal(currentFinalize.status, 200);
  assert.deepEqual(
    projectDb.prepare('SELECT content, status FROM chapters WHERE id = ?').get(chapter.id),
    { content: polished, status: 'accepted' },
  );
  const activeAfterResolution = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions/active`);
  assert.equal(activeAfterResolution.status, 200);
  assert.equal(activeAfterResolution.body.revision, null);
  assert.equal(
    activeAfterResolution.body.chapterDataVersion,
    projectDb.prepare('SELECT data_version FROM chapters WHERE id = ?').get(chapter.id).data_version,
  );

  const rejected = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: 'Discarded candidate' },
  });
  const rejectResult = await callApi(baseUrl, `/${project}/revisions/${rejected.body.revision.id}/reject-all`, {
    method: 'POST',
    body: { expectedBaseContent: polished },
  });
  assert.equal(rejectResult.status, 200);
  assert.equal(rejectResult.body.content, polished);
  assert.equal(rejectResult.body.wordCount, polished.replace(/\s/g, '').length);
  assert.equal(rejectResult.body.status, 'accepted');
  assert.deepEqual(
    projectDb.prepare('SELECT content, status FROM chapters WHERE id = ?').get(chapter.id),
    { content: polished, status: 'accepted' },
  );

  const firstReplacement = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: 'First replacement candidate' },
  });
  const secondReplacement = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: 'Second replacement candidate' },
  });
  assert.equal(
    projectDb.prepare('SELECT status FROM chapter_revisions WHERE id = ?').get(firstReplacement.body.revision.id).status,
    'superseded',
  );
  assert.equal(secondReplacement.body.revision.previousChapterStatus, 'accepted');
  const rejectedReplacement = await callApi(baseUrl, `/${project}/revisions/${secondReplacement.body.revision.id}/reject-all`, {
    method: 'POST',
    body: { expectedBaseContent: polished },
  });
  assert.equal(rejectedReplacement.status, 200);
  assert.equal(projectDb.prepare('SELECT status FROM chapters WHERE id = ?').get(chapter.id).status, 'accepted');

  projectDb.prepare("UPDATE chapters SET status = 'writing' WHERE id = ?").run(chapter.id);
  const writingStatusCandidate = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: 'Candidate created while writing' },
  });
  assert.equal(writingStatusCandidate.status, 201);
  assert.equal(writingStatusCandidate.body.revision.previousChapterStatus, 'writing');
  projectDb.prepare("UPDATE chapters SET status = 'accepted' WHERE id = ?").run(chapter.id);
  const replacementAfterExternalStatus = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: 'Replacement after external acceptance' },
  });
  assert.equal(replacementAfterExternalStatus.status, 201);
  assert.equal(
    projectDb.prepare('SELECT status FROM chapter_revisions WHERE id = ?').get(writingStatusCandidate.body.revision.id).status,
    'superseded',
  );
  assert.equal(replacementAfterExternalStatus.body.revision.previousChapterStatus, 'accepted');
  const rejectedAfterExternalStatus = await callApi(
    baseUrl,
    `/${project}/revisions/${replacementAfterExternalStatus.body.revision.id}/reject-all`,
    { method: 'POST', body: { expectedBaseContent: polished } },
  );
  assert.equal(rejectedAfterExternalStatus.status, 200);
  assert.equal(rejectedAfterExternalStatus.body.status, 'accepted');
  assert.equal(projectDb.prepare('SELECT status FROM chapters WHERE id = ?').get(chapter.id).status, 'accepted');

  const externalStatusCandidate = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: `${polished}\nExternal status candidate` },
  });
  assert.equal(externalStatusCandidate.status, 201);
  projectDb.prepare("UPDATE chapters SET status = 'writing' WHERE id = ?").run(chapter.id);
  const preservedExternalStatus = await callApi(
    baseUrl,
    `/${project}/revisions/${externalStatusCandidate.body.revision.id}/reject-all`,
    { method: 'POST', body: { expectedBaseContent: polished } },
  );
  assert.equal(preservedExternalStatus.status, 200);
  assert.equal(preservedExternalStatus.body.status, 'writing');
  assert.equal(projectDb.prepare('SELECT status FROM chapters WHERE id = ?').get(chapter.id).status, 'writing');
  projectDb.prepare("UPDATE chapters SET status = 'accepted' WHERE id = ?").run(chapter.id);

  const rebasedCandidate = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: polished, proposedContent: 'AI candidate from an older draft' },
  });
  const outsideEdit = 'Author changed the chapter outside the review';
  withRawManuscriptSetup(() => projectDb.prepare('UPDATE chapters SET content = ?, word_count = ? WHERE id = ?').run(outsideEdit, outsideEdit.length, chapter.id));

  const rebasedActive = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions/active`);
  assert.equal(rebasedActive.status, 200);
  assert.equal(rebasedActive.body.rebased, true);
  assert.equal(rebasedActive.body.revision.baseContent, outsideEdit);
  assert.equal(rebasedActive.body.revision.proposedContent, 'AI candidate from an older draft');
  assert.deepEqual(rebasedActive.body.revision.decisions, {});

  const staleDecision = await callApi(baseUrl, `/${project}/revisions/${rebasedCandidate.body.revision.id}`, {
    method: 'PATCH',
    body: { decisions: { 'change-0': 'accepted' }, expectedBaseContent: polished },
  });
  assert.equal(staleDecision.status, 200);
  assert.equal(staleDecision.body.rebased, true);
  assert.deepEqual(staleDecision.body.revision.decisions, {});

  const staleAccept = await callApi(baseUrl, `/${project}/revisions/${rebasedCandidate.body.revision.id}/accept-all`, {
    method: 'POST',
    body: { expectedBaseContent: polished },
  });
  assert.equal(staleAccept.status, 200);
  assert.equal(staleAccept.body.rebased, true);
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content, outsideEdit);

  const acceptedRebased = await callApi(baseUrl, `/${project}/revisions/${rebasedCandidate.body.revision.id}/accept-all`, {
    method: 'POST',
    body: { expectedBaseContent: outsideEdit },
  });
  assert.equal(acceptedRebased.status, 200);
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content, 'AI candidate from an older draft');

  const staleRejectCandidate = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: {
      baseContent: 'AI candidate from an older draft',
      proposedContent: 'Candidate that must stay pending after a stale reject',
    },
  });
  assert.equal(staleRejectCandidate.status, 201);
  const newerOutsideEdit = 'An edit that happened before rejecting the proposal';
  withRawManuscriptSetup(() => projectDb.prepare('UPDATE chapters SET content = ?, word_count = ? WHERE id = ?').run(newerOutsideEdit, newerOutsideEdit.length, chapter.id));
  const staleReject = await callApi(baseUrl, `/${project}/revisions/${staleRejectCandidate.body.revision.id}/reject-all`, {
    method: 'POST',
    body: { expectedBaseContent: 'AI candidate from an older draft' },
  });
  assert.equal(staleReject.status, 200);
  assert.equal(staleReject.body.rebased, true);
  assert.equal(staleReject.body.revision.id, staleRejectCandidate.body.revision.id);
  assert.equal(staleReject.body.revision.baseContent, newerOutsideEdit);
  assert.equal(
    projectDb.prepare('SELECT status FROM chapter_revisions WHERE id = ?').get(staleRejectCandidate.body.revision.id).status,
    'pending',
  );
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content, newerOutsideEdit);

  const laterOutsideEdit = 'A later external edit';
  withRawManuscriptSetup(() => projectDb.prepare('UPDATE chapters SET content = ?, word_count = ? WHERE id = ?').run(laterOutsideEdit, laterOutsideEdit.length, chapter.id));
  const unchangedAtGenerationStart = await callApi(baseUrl, `/${project}/chapters/${chapter.id}/revisions`, {
    method: 'POST',
    body: { baseContent: 'Earlier snapshot', proposedContent: 'Earlier snapshot' },
  });
  assert.equal(unchangedAtGenerationStart.status, 201);
  assert.equal(unchangedAtGenerationStart.body.rebased, true);
  assert.equal(unchangedAtGenerationStart.body.revision.baseContent, laterOutsideEdit);
  assert.equal(unchangedAtGenerationStart.body.revision.proposedContent, 'Earlier snapshot');

  const deleted = await callApi(baseUrl, `/${project}/chapters/${chapter.num}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM chapter_revisions').get().count, 0);
});

test('revision acceptance records its source before one chapter-and-revision publication', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  const { applyRevision, createPendingRevision } = require('../chapter-revisions');
  const project = 'revision-source-order';
  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, content, word_count, status) VALUES (1, 1, 'Chapter', 'Original', 8, 'writing')")
    .run());
  const revision = createPendingRevision(project, 1, 'Original', 'Accepted replacement').revision;
  const controlStore = projectControlStore(db, project);
  const eventsBefore = controlStore.read();
  const preparedBefore = eventsBefore.filter((event) => event.type === 'sqlite.publish.prepared').length;

  const result = applyRevision(project, revision.id, 'accept-all', undefined, 'Original');

  assert.equal(result.accepted, true);
  assert.deepEqual(
    projectDb.prepare('SELECT content, status FROM chapters WHERE id = 1').get(),
    { content: 'Accepted replacement', status: 'accepted' },
  );
  assert.equal(
    projectDb.prepare('SELECT status FROM chapter_revisions WHERE id = ?').get(revision.id).status,
    'accepted',
  );
  const events = controlStore.read();
  assert.equal(
    events.filter((event) => event.type === 'sqlite.publish.prepared').length,
    preparedBefore + 1,
  );
  const sourceEvent = events.filter((event) => event.type === 'manuscript.body_mutation.attempt').at(-1);
  assert.equal(sourceEvent.payload.source, 'revision_accept');
  assert.equal(sourceEvent.payload.operation, 'replace');
  assert.equal(JSON.stringify(sourceEvent).includes('Accepted replacement'), false);
  assert.equal(events[events.indexOf(sourceEvent) + 1].type, 'sqlite.publish.prepared');
});

test('revision publication failure keeps formal chapter and revision atomic before retry', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  const { applyRevision, createPendingRevision } = require('../chapter-revisions');
  const project = 'revision-publication-failure';
  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, content, word_count, status) VALUES (1, 1, 'Chapter', 'Original', 8, 'writing')")
    .run());
  const revision = createPendingRevision(project, 1, 'Original', 'Accepted after retry').revision;
  const projectPath = db.getProjectDbPath(project);
  const controlStore = projectControlStore(db, project);
  const preparedBefore = controlStore.read().filter((event) => event.type === 'sqlite.publish.prepared').length;

  await assert.rejects(
    withFaults({
      [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
    }, async () => applyRevision(project, revision.id, 'accept-all', undefined, 'Original')),
    (error) => error.code === 'EIO'
      && error.faultPoint === FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE,
  );

  assert.deepEqual(
    await readFormalRows(
      projectPath,
      'SELECT content, status FROM chapters WHERE id = ?',
      [1],
    ),
    [{ content: 'Original', status: 'review' }],
  );
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      'SELECT status FROM chapter_revisions WHERE id = ?',
      [revision.id],
    ),
    [{ status: 'pending' }],
  );
  const eventsAfterFailure = controlStore.read();
  assert.equal(
    eventsAfterFailure.filter((event) => event.type === 'sqlite.publish.prepared').length,
    preparedBefore,
  );
  const sourceEvent = eventsAfterFailure
    .filter((event) => event.type === 'manuscript.body_mutation.attempt')
    .at(-1);
  assert.equal(sourceEvent.payload.source, 'revision_accept');
  assert.equal(JSON.stringify(sourceEvent).includes('Accepted after retry'), false);

  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('revision_retry', 'published')")
    .run();
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      'SELECT content, status FROM chapters WHERE id = ?',
      [1],
    ),
    [{ content: 'Original', status: 'review' }],
  );
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      'SELECT status FROM chapter_revisions WHERE id = ?',
      [revision.id],
    ),
    [{ status: 'pending' }],
  );

  const retried = applyRevision(project, revision.id, 'accept-all', undefined, 'Original');
  assert.equal(retried.accepted, true);
  assert.deepEqual(
    await readFormalRows(projectPath, 'SELECT content, status FROM chapters WHERE id = ?', [1]),
    [{ content: 'Accepted after retry', status: 'accepted' }],
  );
  assert.deepEqual(
    await readFormalRows(projectPath, 'SELECT status FROM chapter_revisions WHERE id = ?', [revision.id]),
    [{ status: 'accepted' }],
  );
});
