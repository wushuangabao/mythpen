'use strict';

const VOLUME_COLUMNS = [
  'v.id',
  'v.volume_uid',
  'v.sort_order',
  'v.title',
  'v.summary',
  'v.created_at',
].join(', ');

const CHAPTER_LIST_COLUMNS = [
  'c.id',
  'c.chapter_uid',
  'c.volume_id',
  'c.num',
  'c.title',
  'c.outline',
  'c.summary',
  'c.word_count',
  'c.status',
  'c.chapter_position',
  'c.manuscript_position',
  'c.content_available',
  'c.created_at',
  'c.updated_at',
  'c.data_version',
  'v.volume_uid AS volume_uid',
  'v.title AS volume_title',
  'v.sort_order AS volume_sort_order',
].join(', ');

const CHAPTER_DETAIL_COLUMNS = [
  CHAPTER_LIST_COLUMNS,
  'c.content',
  'c.cognitive_frame',
  'c.emotional_anchor',
  'c.world_texture',
  'c.concrete_mystery',
  'c.interpersonal_tension',
  'c.body_raw_sha256',
  'c.sidecar_raw_sha256',
].join(', ');

const CHAPTER_EXPORT_COLUMNS = [
  CHAPTER_LIST_COLUMNS,
  'c.cognitive_frame',
  'c.emotional_anchor',
  'c.world_texture',
  'c.concrete_mystery',
  'c.interpersonal_tension',
  'c.body_raw_sha256',
  'c.sidecar_raw_sha256',
].join(', ');

const ACTIVE_CHAPTER_FROM = `
  FROM chapters c
  LEFT JOIN volumes v ON v.id = c.volume_id
  WHERE c.is_present = 1
    AND (c.volume_id IS NULL OR v.is_present = 1)
`;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactOptions(options, allowedKeys) {
  if (!isPlainObject(options)) throw new TypeError('options must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (
      typeof key !== 'string'
      || !allowedKeys.has(key)
      || !Object.hasOwn(descriptors[key], 'value')
    ) {
      throw new TypeError('options contain an unknown or accessor field');
    }
  }
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function snapshotAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => snapshotAndFreeze(item)));
  }
  if (value !== null && typeof value === 'object') {
    const snapshot = {};
    for (const [key, item] of Object.entries(value)) {
      snapshot[key] = snapshotAndFreeze(item);
    }
    return Object.freeze(snapshot);
  }
  return value;
}

function queryAll(database, sql, params = []) {
  return snapshotAndFreeze(database.prepare(sql).all(...params));
}

function queryGet(database, sql, params = []) {
  const row = database.prepare(sql).get(...params) ?? null;
  return row === null ? null : snapshotAndFreeze(row);
}

function ambiguousChapterError(chapterNumber) {
  const error = new Error('Chapter number is ambiguous across active containers');
  error.code = 'AMBIGUOUS_CHAPTER';
  error.chapterNumber = chapterNumber;
  return error;
}

class ActiveManuscriptProjection {
  listVolumes(database, options = {}) {
    assertExactOptions(options, new Set());
    return queryAll(
      database,
      `SELECT ${VOLUME_COLUMNS} FROM volumes v WHERE v.is_present = 1 ORDER BY v.sort_order ASC, v.id ASC`,
    );
  }

  listChapters(database, options = {}) {
    assertExactOptions(options, new Set(['volumeId']));
    if (!Object.hasOwn(options, 'volumeId')) {
      return queryAll(
        database,
        `SELECT ${CHAPTER_LIST_COLUMNS} ${ACTIVE_CHAPTER_FROM} ORDER BY c.manuscript_position ASC, c.id ASC`,
      );
    }
    if (options.volumeId === null) {
      return queryAll(
        database,
        `SELECT ${CHAPTER_LIST_COLUMNS} ${ACTIVE_CHAPTER_FROM} AND c.volume_id IS NULL ORDER BY c.chapter_position ASC, c.id ASC`,
      );
    }
    if (!isPositiveSafeInteger(options.volumeId)) {
      throw new TypeError('volumeId must be null or a positive safe integer');
    }
    return queryAll(
      database,
      `SELECT ${CHAPTER_LIST_COLUMNS} ${ACTIVE_CHAPTER_FROM} AND c.volume_id = ? ORDER BY c.chapter_position ASC, c.id ASC`,
      [options.volumeId],
    );
  }

  getChapter(database, chapterId) {
    if (!isPositiveSafeInteger(chapterId)) {
      throw new TypeError('chapterId must be a positive safe integer');
    }
    return queryGet(
      database,
      `SELECT ${CHAPTER_DETAIL_COLUMNS} ${ACTIVE_CHAPTER_FROM} AND c.id = ?`,
      [chapterId],
    );
  }

  resolveLegacyChapterNumber(database, volumeId, chapterNumber) {
    if (!isPositiveSafeInteger(chapterNumber)) {
      throw new TypeError('chapterNumber must be a positive safe integer');
    }
    if (volumeId === undefined) {
      const matches = queryAll(
        database,
        `SELECT ${CHAPTER_DETAIL_COLUMNS} ${ACTIVE_CHAPTER_FROM} AND c.num = ? ORDER BY c.id ASC LIMIT 2`,
        [chapterNumber],
      );
      if (matches.length > 1) throw ambiguousChapterError(chapterNumber);
      return matches[0] ?? null;
    }
    if (volumeId === null) {
      return queryGet(
        database,
        `SELECT ${CHAPTER_DETAIL_COLUMNS} ${ACTIVE_CHAPTER_FROM} AND c.volume_id IS NULL AND c.num = ?`,
        [chapterNumber],
      );
    }
    if (!isPositiveSafeInteger(volumeId)) {
      throw new TypeError('volumeId must be undefined, null, or a positive safe integer');
    }
    return queryGet(
      database,
      `SELECT ${CHAPTER_DETAIL_COLUMNS} ${ACTIVE_CHAPTER_FROM} AND c.volume_id = ? AND c.num = ?`,
      [volumeId, chapterNumber],
    );
  }

  exportSnapshot(database) {
    return Object.freeze({
      volumes: this.listVolumes(database),
      chapters: queryAll(
        database,
        `SELECT ${CHAPTER_EXPORT_COLUMNS} ${ACTIVE_CHAPTER_FROM} ORDER BY c.manuscript_position ASC, c.id ASC`,
      ),
    });
  }
}

module.exports = { ActiveManuscriptProjection };
