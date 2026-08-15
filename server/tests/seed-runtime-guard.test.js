const assert = require('node:assert/strict');
const test = require('node:test');

const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

test('offline seed bootstrap writes sample bodies but its authority expires synchronously', { timeout: 20_000 }, async (t) => {
  withIsolatedDataDir(t);
  const database = require('../db');
  const { seedProject } = require('../seed');
  const projectName = 'offline-seed-runtime-guard';
  await database.initDatabase();

  seedProject(projectName);

  const projectDb = database.getProjectDb(projectName);
  const seeded = projectDb
    .prepare('SELECT id, content FROM chapters WHERE num = 1')
    .get();
  assert.match(seeded.content, /第一章 开端/);
  assert.throws(
    () => projectDb
      .prepare('UPDATE chapters SET content = ? WHERE id = ?')
      .run('Authority must have expired', seeded.id),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.match(
    projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(seeded.id).content,
    /第一章 开端/,
  );
});

test('offline seed authority rejects thenables and cannot escape into their continuation', async (t) => {
  withIsolatedDataDir(t);
  const database = require('../db');
  const { withOfflineSeedBootstrap } = require('../offline-seed-capability');
  await database.initDatabase();
  const projectName = 'offline-seed-async-expiry';
  const projectDb = database.createProjectDb(projectName);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  const { createChapter } = require('../manuscript-service');
  const chapter = createChapter({
    projectName,
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Chapter', content: 'Before' },
  }).chapter;
  let escapedWrite;
  assert.throws(
    () => withOfflineSeedBootstrap(() => {
      escapedWrite = Promise.resolve().then(() => projectDb
        .prepare('UPDATE chapters SET content = ? WHERE id = ?')
        .run('Escaped', chapter.id));
      return escapedWrite;
    }),
    (error) => error.code === 'OFFLINE_SEED_ASYNC_CALLBACK',
  );
  await assert.rejects(
    escapedWrite,
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content, 'Before');
});
