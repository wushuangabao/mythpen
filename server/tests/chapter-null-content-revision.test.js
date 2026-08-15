const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

test('NULL chapter content migrates and participates in revision CAS as canonical blank text', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const legacyProject = 'legacy-null-content';
  const runtimeProject = 'runtime-null-content';
  const legacyPath = path.join(dataDir, 'projects', `${legacyProject}.mythpen.db`);

  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const legacyDb = new SQL.Database();
  legacyDb.exec(`
    CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO project_meta (key, value) VALUES ('schema_version', '9');
    CREATE TABLE chapters (id INTEGER PRIMARY KEY, content TEXT DEFAULT '');
    INSERT INTO chapters (id, content) VALUES (1, NULL);
  `);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, Buffer.from(legacyDb.export()));
  legacyDb.close();

  const db = require('../db');
  const { applyRevision, createPendingRevision, getActiveRevision } = require('../chapter-revisions');
  await db.initDatabase();
  const migratedDb = db.getProjectDb(legacyProject);
  assert.equal(
    migratedDb.prepare("SELECT value FROM project_meta WHERE key = 'schema_version'").get().value,
    '10',
  );
  assert.equal(migratedDb.prepare('SELECT content FROM chapters WHERE id = 1').get().content, '');

  const projectDb = db.createProjectDb(runtimeProject);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  withRawManuscriptSetup(() => projectDb.prepare(`INSERT INTO chapters
    (id, volume_id, num, title, content, word_count, status)
    VALUES (1, 1, 1, 'Blank chapter', NULL, 0, 'writing')`).run());

  const created = createPendingRevision(runtimeProject, 1, '', 'Polished blank chapter');
  assert.equal(created.rebased, false);
  assert.equal(created.revision.baseContent, '');

  const active = getActiveRevision(runtimeProject, 1);
  assert.equal(active.rebased, false);
  assert.equal(active.revision.baseContent, '');

  const accepted = applyRevision(
    runtimeProject,
    created.revision.id,
    'accept-all',
    undefined,
    '',
  );
  assert.equal(accepted.accepted, true);
  assert.equal(
    projectDb.prepare('SELECT content FROM chapters WHERE id = 1').get().content,
    'Polished blank chapter',
  );
});
