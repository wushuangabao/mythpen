const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

test('v7 projects gain a monotonically increasing chapter data version', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const project = 'legacy-chapter-data-version';
  const projectPath = path.join(dataDir, 'projects', `${project}.mythpen.db`);

  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const legacyDb = new SQL.Database();
  legacyDb.exec(`
    CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO project_meta (key, value) VALUES ('schema_version', '7');
    CREATE TABLE chapters (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO chapters (id, title, content) VALUES (1, 'Original', 'Draft');
  `);
  fs.mkdirSync(path.dirname(projectPath), { recursive: true });
  fs.writeFileSync(projectPath, Buffer.from(legacyDb.export()));
  legacyDb.close();

  const db = require('../db');
  await db.initDatabase();
  const projectDb = db.getProjectDb(project);
  assert.equal(projectDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value, '10');
  assert.equal(projectDb.prepare('SELECT data_version FROM chapters WHERE id = 1').get().data_version, 0);

  projectDb.prepare("UPDATE chapters SET title = 'First update' WHERE id = 1").run();
  assert.equal(projectDb.prepare('SELECT data_version FROM chapters WHERE id = 1').get().data_version, 1);

  withRawManuscriptSetup(() => projectDb.prepare("UPDATE chapters SET content = 'Second update' WHERE id = 1").run());
  assert.equal(projectDb.prepare('SELECT data_version FROM chapters WHERE id = 1').get().data_version, 2);
});
