const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

test('v6 pending revisions receive a conservative recoverable chapter status', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const project = 'legacy-revision-status';
  const projectPath = path.join(dataDir, 'projects', `${project}.mythpen.db`);

  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const legacyDb = new SQL.Database();
  legacyDb.exec(`
    CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO project_meta (key, value) VALUES ('schema_version', '6');
    CREATE TABLE chapters (
      id INTEGER PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
    );
    INSERT INTO chapters (id, content, status) VALUES
      (1, 'Legacy draft', 'review'),
      (2, 'Already accepted', 'accepted');
    CREATE TABLE chapter_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      base_content TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      decisions_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    INSERT INTO chapter_revisions (chapter_id, base_content, proposed_content) VALUES
      (1, 'Legacy draft', 'Candidate one'),
      (2, 'Already accepted', 'Candidate two');
  `);
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, Buffer.from(legacyDb.export()));
  legacyDb.close();

  const db = require('../db');
  await db.initDatabase();
  const projectDb = db.getProjectDb(project);
  assert.equal(projectDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value, '10');
  assert.deepEqual(
    projectDb.prepare('SELECT id, previous_chapter_status FROM chapter_revisions ORDER BY id').all(),
    [
      { id: 1, previous_chapter_status: 'writing' },
      { id: 2, previous_chapter_status: 'accepted' },
    ],
  );
});
