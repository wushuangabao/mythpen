const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('v5 projects gain persistent chapter revision storage and prior-status tracking', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-chapter-revisions-migration-'));
  const project = 'legacy-chapter-revisions';
  const projectPath = path.join(dataDir, 'projects', `${project}.mythpen.db`);
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

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
  t.after(async () => {
    db.closeProjectDb(db.getProjectDbPath(project));
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
  });

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
