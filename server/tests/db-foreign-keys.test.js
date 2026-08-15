const assert = require('node:assert/strict');
const test = require('node:test');
const { databaseInternals } = require('../testing/database-internals');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

function foreignKeysEnabled(projectDb) {
  return projectDb.prepare('PRAGMA foreign_keys').get().foreign_keys;
}

test('database flushes preserve foreign keys and volume deletion cascades revisions', async (t) => {
  withIsolatedDataDir(t);

  const db = require('../db');
  const { executeTool } = require('../tools');
  const project = 'foreign-keys';

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  assert.equal(foreignKeysEnabled(projectDb), 1, 'migrations must leave foreign keys enabled');

  // Project writes now publish synchronously. Waiting beyond the retired
  // debounce window also proves that no late publication changes the pragma.
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(foreignKeysEnabled(projectDb), 1, 'project publication must restore foreign keys');

  // A transaction takes the immediate flush path after COMMIT.
  withRawManuscriptSetup(() => projectDb.transaction(() => {
    projectDb.prepare("INSERT INTO chapters (volume_id, num, title, content) VALUES (1, 1, 'Chapter', 'Body')").run();
    const chapter = projectDb.prepare('SELECT id FROM chapters WHERE volume_id = 1 AND num = 1').get();
    projectDb.prepare(
      'INSERT INTO chapter_revisions (chapter_id, base_content, proposed_content) VALUES (?, ?, ?)',
    ).run(chapter.id, 'base', 'proposal');
  })());
  assert.equal(foreignKeysEnabled(projectDb), 1, 'transaction export must restore foreign keys');
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM chapter_revisions').get().count, 1);

  const deleted = executeTool(project, 'delete_volume', { volume_id: 1 });
  assert.equal(deleted.deleted, true);
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM chapters').get().count, 0);
  assert.equal(
    projectDb.prepare('SELECT COUNT(*) AS count FROM chapter_revisions').get().count,
    0,
    'deleting a volume must cascade through chapters to chapter revisions',
  );

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(foreignKeysEnabled(projectDb), 1, 'later project publications must keep foreign keys enabled');

  const exportError = new Error('export failed');
  const restoreError = new Error('foreign-key restore failed');
  let rawDb;
  let originalExport;
  let originalRun;
  try {
    assert.throws(
      () => projectDb.transaction(() => {
        // The writer coordinator recovers before entering this callback and
        // deliberately advances the epoch. Inject against the lease-owned
        // connection, not a raw handle captured before recovery.
        rawDb = databaseInternals(projectDb).store.currentConnection();
        originalExport = rawDb.export;
        originalRun = rawDb.run;
        rawDb.export = () => { throw exportError; };
        rawDb.run = function(sql, ...params) {
          if (sql === 'PRAGMA foreign_keys = ON') throw restoreError;
          return originalRun.call(this, sql, ...params);
        };
        projectDb.prepare("UPDATE project_meta SET value = value WHERE key = 'schema_version'").run();
      })(),
      (error) => error === exportError && error.foreignKeyRestoreError === restoreError,
      'a secondary PRAGMA failure must not hide the original export error',
    );
  } finally {
    if (rawDb) {
      rawDb.export = originalExport;
      rawDb.run = originalRun;
    }
  }
  assert.equal(foreignKeysEnabled(projectDb), 1, 'the connection remains usable after the injected failure');
});
