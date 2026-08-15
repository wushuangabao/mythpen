const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

test('v5 projects gain persistent chapter revision storage and prior-status tracking', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const project = 'legacy-chapter-revisions';
  const projectPath = path.join(dataDir, 'projects', `${project}.mythpen.db`);

  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const legacyDb = new SQL.Database();
  legacyDb.exec(`
    CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO project_meta (key, value) VALUES ('schema_version', '5');
    CREATE TABLE chapters (id INTEGER PRIMARY KEY, content TEXT NOT NULL DEFAULT '');
  `);
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, Buffer.from(legacyDb.export()));
  legacyDb.close();

  const db = require('../db');
  await db.initDatabase();
  const projectDb = db.getProjectDb(project);
  assert.equal(projectDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value, '10');
  const columns = projectDb.prepare('PRAGMA table_info(chapter_revisions)').all().map((column) => column.name);
  assert.deepEqual(
    columns,
    ['id', 'chapter_id', 'base_content', 'proposed_content', 'decisions_json', 'status', 'created_at', 'updated_at', 'resolved_at', 'previous_chapter_status'],
  );
  assert.ok(projectDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chapter_revisions_active'").get());
});
