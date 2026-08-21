'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Database } = require('bun:sqlite');

const { ActiveManuscriptProjection } = require('../manuscript/active-projection');
const { SCHEMA12_CONTRACT } = require('../native/durability-schema');

const BODY_HASH = 'a'.repeat(64);
const SIDECAR_HASH = 'b'.repeat(64);

function canonicalUuid(seed) {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function queryFacade(database, observedSql = []) {
  return Object.freeze({
    prepare(sql) {
      observedSql.push(sql);
      const statement = database.query(sql);
      return Object.freeze({
        all(...params) { return statement.all(...params); },
        get(...params) { return statement.get(...params); },
      });
    },
  });
}

function fixture(t) {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(SCHEMA12_CONTRACT.tables.volumes.createSql);
  database.exec(SCHEMA12_CONTRACT.tables.chapters.createSql);
  for (const index of SCHEMA12_CONTRACT.indexes) {
    if (index.table === 'volumes' || index.table === 'chapters') database.exec(index.sql);
  }

  const insertVolume = database.query(`
    INSERT INTO volumes (
      id, sort_order, title, summary, volume_uid, is_present, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertVolume.run(1, 2, 'Active Volume Two', 'v1', canonicalUuid(1), 1, null);
  insertVolume.run(2, 1, 'Tombstoned Volume', 'v2', canonicalUuid(2), 0, '2026-08-17T00:00:00Z');
  insertVolume.run(3, 3, 'Active Volume Three', 'v3', canonicalUuid(3), 1, null);
  insertVolume.run(4, 1, 'Empty Active Volume', 'v4', canonicalUuid(4), 1, null);

  const insertChapter = database.query(`
    INSERT INTO chapters (
      id, volume_id, num, title, content, word_count, chapter_uid, is_present,
      deleted_at, chapter_position, manuscript_position, body_raw_sha256,
      sidecar_raw_sha256, content_available
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Deliberately insert in an order unrelated to either local id or manuscript position.
  insertChapter.run(107, 3, 7, 'Third Volume Chapter', 'third', 5, canonicalUuid(107), 1, null, 1, 4, BODY_HASH, SIDECAR_HASH, 1);
  insertChapter.run(105, null, 1, 'Unassigned Chapter', null, 4, canonicalUuid(105), 1, null, 1, 3, BODY_HASH, SIDECAR_HASH, 0);
  insertChapter.run(104, 2, 1, 'Child Of Tombstoned Volume', 'hidden', 6, canonicalUuid(104), 1, null, 1, 3, BODY_HASH, SIDECAR_HASH, 1);
  insertChapter.run(103, 1, 7, 'Tombstoned Chapter', 'hidden', 6, canonicalUuid(103), 0, '2026-08-17T00:00:00Z', null, null, BODY_HASH, SIDECAR_HASH, 1);
  insertChapter.run(101, 1, 20, 'Second By Position', 'second', 6, canonicalUuid(101), 1, null, 2, 2, BODY_HASH, SIDECAR_HASH, 1);
  insertChapter.run(102, 1, 7, 'First By Position', 'first', 5, canonicalUuid(102), 1, null, 1, 1, BODY_HASH, SIDECAR_HASH, 1);
  insertChapter.run(106, null, 2, 'Tombstoned Unassigned', 'hidden', 6, canonicalUuid(106), 0, '2026-08-17T00:00:00Z', null, null, BODY_HASH, SIDECAR_HASH, 1);

  const observedSql = [];
  return {
    database,
    db: queryFacade(database, observedSql),
    observedSql,
    projection: new ActiveManuscriptProjection(),
  };
}

test('exports the active manuscript projection boundary', () => {
  assert.equal(typeof ActiveManuscriptProjection, 'function');
});

test('lists only active volumes and active chapters whose parent is active', (t) => {
  const { db, projection } = fixture(t);

  assert.deepEqual(
    projection.listVolumes(db).map(({ id }) => id),
    [4, 1, 3],
  );
  assert.deepEqual(
    projection.listChapters(db).map(({ id }) => id),
    [102, 101, 105, 107],
  );
  assert.equal(
    projection.listChapters(db).some(({ id }) => [103, 104, 106].includes(id)),
    false,
  );
});

test('filters chapter lists by assigned or unassigned container and uses container positions', (t) => {
  const { db, projection } = fixture(t);

  assert.deepEqual(
    projection.listChapters(db, { volumeId: 1 }).map(({ id }) => id),
    [102, 101],
  );
  assert.deepEqual(
    projection.listChapters(db, { volumeId: null }).map(({ id }) => id),
    [105],
  );
  assert.deepEqual(projection.listChapters(db, { volumeId: 2 }), []);
});

test('rejects unsafe identifiers, unknown options, and every tombstone escape option', (t) => {
  const { db, projection } = fixture(t);
  const hiddenOption = {};
  Object.defineProperty(hiddenOption, 'includeTombstones', { value: true });
  const accessorOption = {};
  Object.defineProperty(accessorOption, 'volumeId', {
    enumerable: true,
    get() { throw new Error('option getter must not run'); },
  });

  for (const options of [
    null,
    [],
    { includeTombstones: true },
    { volumeId: 1, extra: true },
    hiddenOption,
    { [Symbol('includeTombstones')]: true },
    accessorOption,
  ]) {
    assert.throws(
      () => projection.listChapters(db, options),
      (error) => error instanceof TypeError && /options/i.test(error.message),
    );
  }
  for (const volumeId of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(
      () => projection.listChapters(db, { volumeId }),
      (error) => error instanceof TypeError && /volumeId/.test(error.message),
    );
  }
  assert.throws(
    () => projection.listVolumes(db, { includeTombstones: true }),
    (error) => error instanceof TypeError && /options/i.test(error.message),
  );
});

test('gets active assigned and unassigned chapters by stable local chapter id', (t) => {
  const { db, projection } = fixture(t);

  const assigned = projection.getChapter(db, 102);
  assert.equal(assigned.id, 102);
  assert.equal(assigned.num, 7);
  assert.equal(assigned.content, 'first');
  assert.equal(assigned.body_raw_sha256, BODY_HASH);
  assert.equal(assigned.volume_title, 'Active Volume Two');

  const unassigned = projection.getChapter(db, 105);
  assert.equal(unassigned.id, 105);
  assert.equal(unassigned.volume_id, null);
  assert.equal(unassigned.content, null);
  assert.equal(unassigned.content_available, 0);
});

test('treats tombstones, children of tombstoned parents, and missing ids as absent', (t) => {
  const { db, projection } = fixture(t);

  for (const chapterId of [103, 104, 106, 999]) {
    assert.equal(projection.getChapter(db, chapterId), null);
  }
  for (const chapterId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '102', null]) {
    assert.throws(
      () => projection.getChapter(db, chapterId),
      (error) => error instanceof TypeError && /chapterId/.test(error.message),
    );
  }
});

test('resolves legacy chapter numbers within active assigned, unassigned, or global scope', (t) => {
  const { db, projection } = fixture(t);

  assert.equal(projection.resolveLegacyChapterNumber(db, 1, 7).id, 102);
  assert.equal(projection.resolveLegacyChapterNumber(db, null, 1).id, 105);
  assert.equal(projection.resolveLegacyChapterNumber(db, undefined, 1).id, 105);
  assert.equal(projection.resolveLegacyChapterNumber(db, 2, 1), null);
  assert.equal(projection.resolveLegacyChapterNumber(db, 1, 999), null);
});

test('rejects ambiguous active global legacy numbers after at most two matches', (t) => {
  const { db, observedSql, projection } = fixture(t);

  assert.throws(
    () => projection.resolveLegacyChapterNumber(db, undefined, 7),
    (error) => error?.code === 'AMBIGUOUS_CHAPTER' && error.chapterNumber === 7,
  );
  assert.match(observedSql.at(-1), /LIMIT 2\s*$/i);
});

test('rejects invalid legacy volume and chapter numbers', (t) => {
  const { db, projection } = fixture(t);

  for (const volumeId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', false]) {
    assert.throws(
      () => projection.resolveLegacyChapterNumber(db, volumeId, 1),
      (error) => error instanceof TypeError && /^volumeId must/.test(error.message),
    );
  }
  for (const chapterNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(
      () => projection.resolveLegacyChapterNumber(db, 1, chapterNumber),
      (error) => error instanceof TypeError && /^chapterNumber must/.test(error.message),
    );
  }
});

test('exports only active ordered metadata including unassigned unavailable content facts', (t) => {
  const { db, projection } = fixture(t);

  const snapshot = projection.exportSnapshot(db);
  assert.deepEqual(snapshot.volumes.map(({ id }) => id), [4, 1, 3]);
  assert.deepEqual(snapshot.chapters.map(({ id }) => id), [102, 101, 105, 107]);
  assert.equal(snapshot.chapters.some(({ id }) => [103, 104, 106].includes(id)), false);
  assert.equal(snapshot.chapters.every((chapter) => !Object.hasOwn(chapter, 'content')), true);

  const unavailable = snapshot.chapters.find(({ id }) => id === 105);
  assert.equal(unavailable.volume_id, null);
  assert.equal(unavailable.content_available, 0);
  assert.equal(unavailable.word_count, 4);
  assert.equal(unavailable.body_raw_sha256, BODY_HASH);
  assert.equal(unavailable.sidecar_raw_sha256, SIDECAR_HASH);
});

test('defensively copies and deeply freezes every successful projection result', (t) => {
  const { db, projection } = fixture(t);
  const results = [
    projection.listVolumes(db),
    projection.listChapters(db),
    projection.getChapter(db, 102),
    projection.resolveLegacyChapterNumber(db, 1, 7),
    projection.exportSnapshot(db),
  ];

  for (const result of results) assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(results[0][0]), true);
  assert.equal(Object.isFrozen(results[1][0]), true);
  assert.equal(Object.isFrozen(results[4].volumes), true);
  assert.equal(Object.isFrozen(results[4].volumes[0]), true);
  assert.equal(Object.isFrozen(results[4].chapters), true);
  assert.equal(Object.isFrozen(results[4].chapters[0]), true);

  const source = [{ id: 1, nested: { label: 'before' } }];
  const sourceDatabase = {
    prepare() {
      return { all: () => source };
    },
  };
  const copied = projection.listVolumes(sourceDatabase);
  assert.notEqual(copied, source);
  assert.notEqual(copied[0], source[0]);
  assert.notEqual(copied[0].nested, source[0].nested);
  source[0].nested.label = 'after';
  assert.equal(copied[0].nested.label, 'before');
  assert.equal(Object.isFrozen(copied[0].nested), true);
});
