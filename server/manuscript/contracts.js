'use strict';

const MANUSCRIPT_FORMAT_VERSION = 1;
const MANUSCRIPT_SCHEMA_VERSION = 12;

const ROUTES = Object.freeze([
  'sqlite',
  'migrating',
  'files',
  'retired',
]);

const LIMITS = Object.freeze({
  chapterIdentities: 10_000,
  volumeIdentities: 2_000,
  markdownBytes: 16 * 1024 * 1024,
  jsonBytes: 256 * 1024,
  controlledFiles: 25_000,
  chapterDirectoryEntries: 20_000,
  controlledBytes: 1024 * 1024 * 1024,
});

const RESERVED_PROJECT_META_KEYS = Object.freeze([
  'manuscript_route',
  'manuscript_project_uid',
  'manuscript_route_journal',
  'manuscript_projection_generation',
]);

const OBJECT_CLASSES = Object.freeze([
  'controlled',
  'orphan',
  'journal_candidate',
  'uncontrolled_residue',
]);

const ERROR_CODES = Object.freeze([
  'MANUSCRIPT_PATH_UNSAFE',
  'MANUSCRIPT_FILESET_INVALID',
  'MANUSCRIPT_FORMAT_TOO_NEW',
  'MANUSCRIPT_CONTENT_TOO_LARGE',
  'MANUSCRIPT_TARGET_LOCKED',
  'UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE',
  'EXTERNAL_CHANGE_CONFLICT',
  'EXTERNAL_DRAFT_CONFLICT',
  'EXTERNAL_RESOURCE_CREATION_UNSUPPORTED',
  'IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE',
  'MANUSCRIPT_TREE_CHANGED_DURING_READ',
  'PROJECTION_STALE',
  'MANUSCRIPT_LIFECYCLE_UNAVAILABLE',
  'PROJECT_MIGRATION_BUSY',
  'LEGACY_CHAPTER_NUMBER_INVALID',
  'LEGACY_FORESHADOW_EXPECTED_POSITION_AMBIGUOUS',
  'LEGACY_FORESHADOW_EXPECTED_POSITION_INVALID',
  'SCHEMA_SWAP_UNSUPPORTED',
  'PROJECT_SCHEMA_TOO_NEW',
  'MIGRATION_STATE_MISMATCH',
  'UID_RESERVATION_COLLISION',
  'PROJECT_PERMANENT_DELETE_UNSUPPORTED',
  'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED',
  'RECOVERY_REQUIRED',
]);

const ERROR_CODE_SET = new Set(ERROR_CODES);
const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidDetailsError() {
  return new TypeError('details must contain finite acyclic plain data');
}

function snapshotPlainData(value, activeObjects) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidDetailsError();
    return value;
  }
  if (typeof value !== 'object') throw invalidDetailsError();
  if (activeObjects.has(value)) throw invalidDetailsError();

  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const snapshot = new Array(value.length);
    activeObjects.add(value);
    try {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')
        ) {
          throw invalidDetailsError();
        }
        snapshot[index] = snapshotPlainData(descriptor.value, activeObjects);
      }
      for (const key of keys) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string'
          || !/^(0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= value.length
        ) {
          throw invalidDetailsError();
        }
      }
      return Object.freeze(snapshot);
    } finally {
      activeObjects.delete(value);
    }
  }

  if (!isPlainObject(value)) throw invalidDetailsError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot = Object.create(Object.getPrototypeOf(value));
  activeObjects.add(value);
  try {
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string'
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) {
        throw invalidDetailsError();
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: snapshotPlainData(descriptor.value, activeObjects),
        writable: true,
      });
    }
    return Object.freeze(snapshot);
  } finally {
    activeObjects.delete(value);
  }
}

function snapshotDetails(details) {
  if (!isPlainObject(details)) {
    throw new TypeError('details must be a plain object');
  }
  return snapshotPlainData(details, new WeakSet());
}

function manuscriptError(code, details = {}, cause) {
  if (!ERROR_CODE_SET.has(code)) {
    throw new TypeError('code must be a stable manuscript error code');
  }
  const detailsSnapshot = snapshotDetails(details);

  const error = cause === undefined
    ? new Error(code)
    : new Error(code, { cause });
  Object.defineProperties(error, {
    code: {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    },
    details: {
      configurable: false,
      enumerable: true,
      value: detailsSnapshot,
      writable: false,
    },
  });
  return error;
}

function assertCanonicalUuid(value, role) {
  if (typeof role !== 'string' || role.length === 0) {
    throw new TypeError('role must be a non-empty string');
  }
  if (typeof value !== 'string' || !CANONICAL_UUID_V4_PATTERN.test(value)) {
    throw manuscriptError('MANUSCRIPT_FILESET_INVALID', { role });
  }
  return value;
}

module.exports = {
  ERROR_CODES,
  LIMITS,
  MANUSCRIPT_FORMAT_VERSION,
  MANUSCRIPT_SCHEMA_VERSION,
  OBJECT_CLASSES,
  RESERVED_PROJECT_META_KEYS,
  ROUTES,
  assertCanonicalUuid,
  manuscriptError,
};
