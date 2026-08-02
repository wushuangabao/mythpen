const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function foreignKeysEnabled(projectDb) {
  return projectDb.prepare('PRAGMA foreign_keys').get().foreign_keys;
}

test('database flushes preserve foreign keys and volume deletion cascades revisions', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-foreign-keys-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const { executeTool } = require('../tools');
  const project = 'foreign-keys';

  t.after(async () => {
    db.closeProjectDb(db.getProjectDbPath(project));
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
  });

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  assert.equal(foreignKeysEnabled(projectDb), 1, 'migrations must leave foreign keys enabled');

  // A normal write is persisted by the delayed flush path.
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(foreignKeysEnabled(projectDb), 1, 'scheduled export must restore foreign keys');

  // A transaction takes the immediate flush path after COMMIT.
  projectDb.transaction(() => {
    projectDb.prepare("INSERT INTO chapters (volume_id, num, title, content) VALUES (1, 1, 'Chapter', 'Body')").run();
    const chapter = projectDb.prepare('SELECT id FROM chapters WHERE volume_id = 1 AND num = 1').get();
    projectDb.prepare(
      'INSERT INTO chapter_revisions (chapter_id, base_content, proposed_content) VALUES (?, ?, ?)',
    ).run(chapter.id, 'base', 'proposal');
  })();
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
  assert.equal(foreignKeysEnabled(projectDb), 1, 'later scheduled exports must keep foreign keys enabled');

  const rawDb = projectDb._db;
  const originalExport = rawDb.export;
  const originalRun = rawDb.run;
  const exportError = new Error('export failed');
  const restoreError = new Error('foreign-key restore failed');
  rawDb.export = () => { throw exportError; };
  rawDb.run = function(sql, ...params) {
    if (sql === 'PRAGMA foreign_keys = ON') throw restoreError;
    return originalRun.call(this, sql, ...params);
  };
  try {
    assert.throws(
      () => projectDb.transaction(() => {
        projectDb.prepare("UPDATE project_meta SET value = value WHERE key = 'schema_version'").run();
      })(),
      (error) => error === exportError && error.foreignKeyRestoreError === restoreError,
      'a secondary PRAGMA failure must not hide the original export error',
    );
  } finally {
    rawDb.export = originalExport;
    rawDb.run = originalRun;
  }
  assert.equal(foreignKeysEnabled(projectDb), 1, 'the connection remains usable after the injected failure');
});
