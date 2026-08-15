const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

test('a v4 timeline with a custom order remains in manual mode after migration', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const project = 'v4-custom-timeline-order';
  const projectPath = path.join(dataDir, 'projects', `${project}.mythpen.db`);

  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const legacyDb = new SQL.Database();
  legacyDb.exec(`
    CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO project_meta (key, value) VALUES ('schema_version', '4');
    CREATE TABLE timeline_events (
      id TEXT PRIMARY KEY,
      year TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      importance INTEGER DEFAULT 3,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = legacyDb.prepare(
    'INSERT INTO timeline_events (id, year, title, description, importance, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run(['october', '2033.10', 'October', '', 3, 1]);
  insert.run(['september', '2033.9', 'September', '', 3, 2]);
  insert.free();
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, Buffer.from(legacyDb.export()));
  legacyDb.close();

  const db = require('../db');
  await db.initDatabase();
  const projectDb = db.getProjectDb(project);
  assert.equal(projectDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value, '10');
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'timeline_sort_mode'").get().value,
    'manual',
  );
  assert.deepEqual(
    projectDb.prepare('SELECT id FROM timeline_events ORDER BY sort_order').all().map((event) => event.id),
    ['october', 'september'],
  );
});
