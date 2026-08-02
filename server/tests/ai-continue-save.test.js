const assert = require('node:assert/strict');
const test = require('node:test');

const { saveContinuation } = require('../ai-continue-save');

function fakeDatabase({ chapter = { id: 7, content: 'Existing' }, updateChanges = 1, dataVersion = 4 } = {}) {
  const writes = [];
  const reads = [];
  const projectDb = {
    transaction: (operation) => () => operation(),
    prepare(sql) {
      return {
        get(...params) {
          reads.push({ sql, params });
          if (sql.startsWith('SELECT id, content')) return chapter;
          if (sql.startsWith('SELECT SUM')) return { total: 24 };
          if (sql.startsWith('SELECT data_version')) return { data_version: dataVersion };
          throw new Error(`Unexpected get: ${sql}`);
        },
        run(...params) {
          writes.push({ sql, params });
          if (sql.startsWith('UPDATE chapters')) return { changes: updateChanges };
          return { changes: 1 };
        },
      };
    },
  };
  return {
    database: {
      getProjectDb: () => projectDb,
      updateProjectWordCount(targetDb) {
        const total = targetDb.prepare('SELECT SUM(word_count) AS total FROM chapters').get()?.total || 0;
        targetDb.prepare("UPDATE project_meta SET value = ? WHERE key = 'word_count'").run(String(total));
        targetDb.prepare("UPDATE project_meta SET value = ? WHERE key = 'updated_at'").run('now');
      },
    },
    reads,
    writes,
  };
}

test('continuation saving selects the exact chapter id, appends text, and updates aggregate metadata', () => {
  const { database, reads, writes } = fakeDatabase();
  const result = saveContinuation(database, 'project', 7, 'Continuation', 'stop');

  assert.match(reads[0].sql, /WHERE id = \?/);
  assert.deepEqual(reads[0].params, [7]);
  assert.equal(result.content, 'Existing\n\nContinuation');
  assert.equal(result.wordCount, 'ExistingContinuation'.length);
  assert.equal(result.dataVersion, 4);
  assert.equal(writes[0].params[0], result.content);
  assert.equal(writes[0].params[2], 7);
  assert.equal(writes.length, 3);
});

test('continuation saving fails when the chapter disappeared or the update changed no rows', () => {
  assert.throws(
    () => saveContinuation(fakeDatabase({ chapter: null }).database, 'project', 3, 'Continuation', 'stop'),
    (error) => error.code === 'chapter_missing',
  );
  assert.throws(
    () => saveContinuation(fakeDatabase({ updateChanges: 0 }).database, 'project', 3, 'Continuation', 'stop'),
    (error) => error.code === 'chapter_missing',
  );
});

test('continuation saving rejects an empty model response instead of reporting success', () => {
  assert.throws(
    () => saveContinuation(fakeDatabase().database, 'project', 3, '   ', 'stop'),
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
      () => saveContinuation(database, 'project', 7, 'Partial continuation', reason),
      (error) => error.code === code,
    );
    assert.equal(opened, false);
  }
});
