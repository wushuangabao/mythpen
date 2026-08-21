const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { openControlStore } = require('../control-store');
const { saveContinuation, saveFilesContinuation } = require('../ai-continue-save');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

function bodyHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function projectControlStore(database, projectName) {
  const filePath = database.getProjectDbPath(projectName);
  const dbKey = createHash('sha256').update(canonicalDatabasePath(filePath)).digest('hex');
  return openControlStore(path.join(database.getDataDir(), 'control', 'sqlite', dbKey));
}

function preparedCount(controlStore) {
  return controlStore.read().filter((event) => event.type === 'sqlite.publish.prepared').length;
}

async function createChapter(t, projectName, content = 'Existing') {
  withIsolatedDataDir(t);
  const database = require('../db');
  await database.initDatabase();
  const projectDb = database.createProjectDb(projectName);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  withRawManuscriptSetup(() => projectDb
    .prepare('INSERT INTO chapters (volume_id, num, title, content, word_count) VALUES (1, 1, ?, ?, ?)')
    .run('Chapter', content, content.replace(/\s/g, '').length));
  const chapter = projectDb.prepare('SELECT * FROM chapters WHERE volume_id = 1 AND num = 1').get();
  return { chapter, database, projectDb };
}

test('continuation saving appends exact bytes through ManuscriptService using the generation-start body hash', async (t) => {
  const { chapter, database, projectDb } = await createChapter(t, 'continue-exact');
  const controlStore = projectControlStore(database, 'continue-exact');
  const preparedBefore = preparedCount(controlStore);
  const result = saveContinuation(
    database,
    'continue-exact',
    chapter.id,
    'Continuation',
    'stop',
    bodyHash('Existing'),
    { inputTokens: 11, outputTokens: 7, model: 'continuation-model' },
  );

  assert.equal(result.content, 'Existing\n\nContinuation');
  assert.equal(result.wordCount, 'ExistingContinuation'.length);
  assert.equal(result.dataVersion, chapter.data_version + 1);
  assert.deepEqual(
    projectDb.prepare('SELECT content, word_count, status FROM chapters WHERE id = ?').get(chapter.id),
    { content: result.content, word_count: result.wordCount, status: 'writing' },
  );
  assert.deepEqual(
    projectDb.prepare('SELECT task_name, chapter_num, input_tokens, output_tokens, model FROM token_usage').all(),
    [{
      task_name: 'continue',
      chapter_num: chapter.num,
      input_tokens: 11,
      output_tokens: 7,
      model: 'continuation-model',
    }],
  );

  const events = controlStore.read();
  assert.equal(preparedCount(controlStore), preparedBefore + 1);
  const sourceEvent = events.filter((event) => event.type === 'manuscript.body_mutation.attempt').at(-1);
  assert.equal(sourceEvent.payload.source, 'ai_continue');
  assert.equal(sourceEvent.payload.expectedBodySha256, bodyHash('Existing'));
  assert.equal(events[events.indexOf(sourceEvent) + 1].type, 'sqlite.publish.prepared');
});

test('continuation persistence failure is marked and later usage cannot publish its dirty body', async (t) => {
  const { isManuscriptPersistenceError } = require('../manuscript-service');
  const { chapter, database, projectDb } = await createChapter(
    t,
    'continue-publication-failure',
    'Before body',
  );
  let persistenceError;
  try {
    await withFaults({
      [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
    }, async () => saveContinuation(
      database,
      'continue-publication-failure',
      chapter.id,
      'Failed continuation',
      'stop',
      bodyHash('Before body'),
      { inputTokens: 13, outputTokens: 8, model: 'continuation-model' },
    ));
  } catch (error) {
    persistenceError = error;
  }

  const marked = typeof isManuscriptPersistenceError === 'function'
    && isManuscriptPersistenceError(persistenceError);
  assert.equal(persistenceError?.code, 'EIO');
  assert.equal(marked, true);
  // This is the old caller behavior that exposed the bug. A marked persistence
  // error must prevent this branch from running at all.
  if (!marked) {
    database.projectExecute(
      'continue-publication-failure',
      'INSERT INTO token_usage (task_name, chapter_num, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?, ?)',
      ['continue', chapter.num, 13, 8, 'continuation-model'],
    );
  }
  assert.equal(
    projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content,
    'Before body',
  );
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count, 0);
});

test('a concurrent body change rejects the append without a source event or database publication', async (t) => {
  const { chapter, database, projectDb } = await createChapter(t, 'continue-conflict', 'Generation base');
  const { writeChapterBody } = require('../manuscript-service');
  writeChapterBody({
    projectName: 'continue-conflict',
    chapterId: chapter.id,
    content: 'Concurrent author edit',
    source: 'rest',
  });
  const controlStore = projectControlStore(database, 'continue-conflict');
  const publicationsBefore = preparedCount(controlStore);
  const sourceEventsBefore = controlStore.read().filter((event) => event.type === 'manuscript.body_mutation.attempt').length;

  assert.throws(
    () => saveContinuation(
      database,
      'continue-conflict',
      chapter.id,
      'Generated continuation',
      'stop',
      bodyHash('Generation base'),
    ),
    (error) => error.code === 'continuation_conflict',
  );

  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content, 'Concurrent author edit');
  assert.equal(preparedCount(controlStore), publicationsBefore);
  assert.equal(
    controlStore.read().filter((event) => event.type === 'manuscript.body_mutation.attempt').length,
    sourceEventsBefore,
  );
});

test('retrying the same continuation cannot duplicate the appended bytes or publish again', async (t) => {
  const { chapter, database, projectDb } = await createChapter(t, 'continue-retry', 'Existing');
  const expectedBodyHash = bodyHash('Existing');
  const first = saveContinuation(
    database,
    'continue-retry',
    chapter.id,
    'Continuation',
    'stop',
    expectedBodyHash,
  );
  const controlStore = projectControlStore(database, 'continue-retry');
  const publicationsAfterFirst = preparedCount(controlStore);

  assert.throws(
    () => saveContinuation(
      database,
      'continue-retry',
      chapter.id,
      'Continuation',
      'stop',
      expectedBodyHash,
    ),
    (error) => error.code === 'continuation_conflict',
  );
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content, first.content);
  assert.equal(first.content, 'Existing\n\nContinuation');
  assert.equal(preparedCount(controlStore), publicationsAfterFirst);
});

test('continuation saving preserves missing and invalid chapter errors', async (t) => {
  const { database } = await createChapter(t, 'continue-errors');
  assert.throws(
    () => saveContinuation(database, 'continue-errors', 999, 'Continuation', 'stop', bodyHash('')),
    (error) => error.code === 'chapter_missing',
  );
  assert.throws(
    () => saveContinuation(database, 'continue-errors', 0, 'Continuation', 'stop', bodyHash('')),
    (error) => error.code === 'chapter_invalid',
  );
});

test('continuation saving rejects an empty model response instead of reporting success', () => {
  assert.throws(
    () => saveContinuation({}, 'project', 3, '   ', 'stop', bodyHash('Existing')),
    (error) => error.code === 'continuation_empty',
  );
});

test('continuation saving rejects missing and abnormal model completion reasons before touching the database', () => {
  for (const [reason, code] of [
    [null, 'continuation_incomplete_response'],
    ['content_filter', 'continuation_incomplete_response'],
    ['done', 'continuation_incomplete_response'],
    ['length', 'continuation_output_limit'],
    ['max_tokens', 'continuation_output_limit'],
  ]) {
    let opened = false;
    const database = {
      getProjectDb() {
        opened = true;
        throw new Error('database must not be opened');
      },
    };
    assert.throws(
      () => saveContinuation(
        database,
        'project',
        7,
        'Partial continuation',
        reason,
        bodyHash('Existing'),
      ),
      (error) => error.code === code,
    );
    assert.equal(opened, false);
  }
});

test('files continuation replaces the generation-start body through one stable-UID runtime write', async () => {
  const projectUid = '11111111-1111-4111-8111-111111111111';
  const chapterUid = '22222222-2222-4222-8222-222222222222';
  const baseWitness = Object.freeze({
    expectedDataVersion: 7,
    generation: 19,
    rawSha256: bodyHash('Existing'),
    sidecarRawSha256: bodyHash('{}'),
  });
  const writes = [];
  const runtime = Object.freeze({
    async write(selector, request) {
      writes.push({ selector, request });
      return Object.freeze({ state: 'committed', generation: 20 });
    },
  });

  const result = await saveFilesContinuation({
    runtime,
    projectUid,
    chapter: Object.freeze({
      chapter_uid: chapterUid,
      content: 'Existing',
      data_version: 7,
    }),
    baseWitness,
    continuation: 'Continuation',
    finishReason: 'stop',
    requestId: 'ai-continue-request-1',
  });

  assert.deepEqual(writes, [{
    selector: { projectUid },
    request: {
      requestId: 'ai-continue-request-1',
      baseWitness,
      command: {
        kind: 'chapter.replace_body',
        chapterUid,
        expected_data_version: 7,
        content: 'Existing\n\nContinuation',
      },
    },
  }]);
  assert.deepEqual(result, {
    chapterUid,
    content: 'Existing\n\nContinuation',
    wordCount: 'ExistingContinuation'.length,
    dataVersion: 8,
  });
});

test('files continuation validates completion before invoking runtime write', async () => {
  let writes = 0;
  await assert.rejects(
    saveFilesContinuation({
      runtime: { async write() { writes += 1; } },
      projectUid: '11111111-1111-4111-8111-111111111111',
      chapter: {
        chapter_uid: '22222222-2222-4222-8222-222222222222',
        content: 'Existing',
        data_version: 7,
      },
      baseWitness: {
        expectedDataVersion: 7,
        generation: 19,
        rawSha256: bodyHash('Existing'),
        sidecarRawSha256: bodyHash('{}'),
      },
      continuation: 'Partial',
      finishReason: 'max_tokens',
      requestId: 'ai-continue-request-2',
    }),
    (error) => error.code === 'continuation_output_limit',
  );
  assert.equal(writes, 0);
});
