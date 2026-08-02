const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('legacy timeline events receive a stable initial automatic order during migration', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-timeline-migration-'));
  const project = 'legacy-timeline-order';
  const projectPath = path.join(dataDir, 'projects', `${project}.mythpen.db`);
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const legacyDb = new SQL.Database();
  legacyDb.exec(`
    CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO project_meta (key, value) VALUES ('schema_version', '3');
    CREATE TABLE timeline_events (
      id TEXT PRIMARY KEY,
      year TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      importance INTEGER DEFAULT 3,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = legacyDb.prepare(
    'INSERT INTO timeline_events (id, year, title, description, importance) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(['late', '群星历九年', '后段', '', 3]);
  insert.run(['october', '2033.10', '十月', '', 3]);
  insert.run(['september', '2033.9', '九月', '', 3]);
  insert.free();
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, Buffer.from(legacyDb.export()));
  legacyDb.close();

  const db = require('../db');
  t.after(async () => {
    db.closeProjectDb(db.getProjectDbPath(project));
    // The config DB batches its initial schema flush for 250 ms.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
  });

  await db.initDatabase();
  const projectDb = db.getProjectDb(project);
  assert.equal(projectDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value, '10');
  assert.ok(projectDb.prepare('PRAGMA table_info(timeline_events)').all().some((column) => column.name === 'sort_order'));
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'timeline_sort_mode'").get().value,
    'auto',
  );
  assert.deepEqual(
    projectDb.prepare('SELECT id FROM timeline_events ORDER BY sort_order').all().map((event) => event.id),
    ['september', 'october', 'late'],
  );
});
