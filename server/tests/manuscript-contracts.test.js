'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ERROR_CODES,
  LIMITS,
  MANUSCRIPT_FORMAT_VERSION,
  MANUSCRIPT_SCHEMA_VERSION,
  OBJECT_CLASSES,
  RESERVED_PROJECT_META_KEYS,
  ROUTES,
  assertCanonicalUuid,
  manuscriptError,
} = require('../manuscript/contracts');

const EXPECTED_ERROR_CODES = [
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
];

test('L2 manuscript contracts freeze exact versions routes limits keys classes and error codes', () => {
  assert.equal(MANUSCRIPT_FORMAT_VERSION, 1);
  assert.equal(MANUSCRIPT_SCHEMA_VERSION, 12);
  assert.deepEqual(ROUTES, ['sqlite', 'migrating', 'files', 'retired']);
  assert.deepEqual(LIMITS, {
    chapterIdentities: 10_000,
    volumeIdentities: 2_000,
    markdownBytes: 16 * 1024 * 1024,
    jsonBytes: 256 * 1024,
    controlledFiles: 25_000,
    chapterDirectoryEntries: 20_000,
    controlledBytes: 1024 * 1024 * 1024,
  });
  assert.deepEqual(RESERVED_PROJECT_META_KEYS, [
    'manuscript_route',
    'manuscript_project_uid',
    'manuscript_route_journal',
    'manuscript_projection_generation',
  ]);
  assert.deepEqual(OBJECT_CLASSES, [
    'controlled',
    'orphan',
    'journal_candidate',
    'uncontrolled_residue',
  ]);
  assert.deepEqual(ERROR_CODES, EXPECTED_ERROR_CODES);
  for (const value of [ROUTES, LIMITS, RESERVED_PROJECT_META_KEYS, OBJECT_CLASSES, ERROR_CODES]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test('manuscriptError accepts only stable codes and preserves frozen details and cause', () => {
  const cause = new Error('filesystem identity changed');
  const inputDetails = { dimension: 'controlledFiles', measured: 25_001, allowed: 25_000 };
  const error = manuscriptError('MANUSCRIPT_CONTENT_TOO_LARGE', inputDetails, cause);

  assert.equal(error instanceof Error, true);
  assert.equal(error.message, 'MANUSCRIPT_CONTENT_TOO_LARGE');
  assert.equal(error.code, 'MANUSCRIPT_CONTENT_TOO_LARGE');
  assert.deepEqual(error.details, inputDetails);
  assert.notEqual(error.details, inputDetails);
  assert.equal(Object.isFrozen(error.details), true);
  assert.equal(error.cause, cause);
  assert.throws(() => { error.code = 'RECOVERY_REQUIRED'; }, TypeError);
  assert.equal(error.code, 'MANUSCRIPT_CONTENT_TOO_LARGE');

  assert.throws(() => manuscriptError('NOT_STABLE'), TypeError);
  assert.throws(() => manuscriptError('RECOVERY_REQUIRED', []), TypeError);
});

test('manuscriptError snapshots and deeply freezes nested details without traversing cause', () => {
  const cause = new Error('native publication failed');
  cause.self = cause;
  let causeAccessorReads = 0;
  Object.defineProperty(cause, 'privateContext', {
    enumerable: true,
    get() {
      causeAccessorReads += 1;
      return { secret: 'must-not-be-read' };
    },
  });
  const inputDetails = {
    capacity: { dimension: 'controlledFiles', allowed: 25_000 },
    observations: [{ measured: 25_001 }],
  };

  const error = manuscriptError('MANUSCRIPT_CONTENT_TOO_LARGE', inputDetails, cause);

  assert.equal(error.cause, cause);
  assert.equal(causeAccessorReads, 0);
  assert.notEqual(error.details.capacity, inputDetails.capacity);
  assert.notEqual(error.details.observations, inputDetails.observations);
  assert.notEqual(error.details.observations[0], inputDetails.observations[0]);

  inputDetails.capacity.allowed = 0;
  inputDetails.observations[0].measured = 0;
  inputDetails.observations.push({ measured: 0 });
  assert.deepEqual(error.details, {
    capacity: { dimension: 'controlledFiles', allowed: 25_000 },
    observations: [{ measured: 25_001 }],
  });

  for (const value of [
    error.details,
    error.details.capacity,
    error.details.observations,
    error.details.observations[0],
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { error.details.capacity.allowed = 1; }, TypeError);
  assert.throws(() => { error.details.observations[0].measured = 1; }, TypeError);
  assert.throws(() => { error.details.observations.push({ measured: 1 }); }, TypeError);

  cause.afterCreation = 'still caller-owned';
  assert.equal(cause.afterCreation, 'still caller-owned');
  assert.equal(Object.isFrozen(cause), false);
});

test('manuscriptError rejects cyclic accessor-bearing non-plain and non-finite details', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => manuscriptError('RECOVERY_REQUIRED', cyclic),
    TypeError,
  );

  let accessorReads = 0;
  const accessorValue = {};
  Object.defineProperty(accessorValue, 'secret', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'must-not-be-read';
    },
  });
  assert.throws(
    () => manuscriptError('RECOVERY_REQUIRED', { nested: accessorValue }),
    TypeError,
  );
  assert.equal(accessorReads, 0);

  for (const value of [
    new Date(0),
    new Map(),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.throws(
      () => manuscriptError('RECOVERY_REQUIRED', { value }),
      TypeError,
    );
  }
});

test('manuscriptError snapshots an own __proto__ data key without changing prototypes', () => {
  const inputDetails = JSON.parse('{"__proto__":{"marker":"source"},"safe":true}');
  const error = manuscriptError('RECOVERY_REQUIRED', inputDetails);

  assert.equal(Object.getPrototypeOf(error.details), Object.prototype);
  assert.equal(Object.hasOwn(error.details, '__proto__'), true);
  assert.deepEqual(error.details.__proto__, { marker: 'source' });
  assert.equal(Object.isFrozen(error.details.__proto__), true);
  assert.equal({}.marker, undefined);

  inputDetails.__proto__.marker = 'input-mutated';
  assert.equal(error.details.__proto__.marker, 'source');
  assert.throws(() => { error.details.__proto__.marker = 'output-mutated'; }, TypeError);
  assert.equal({}.marker, undefined);
});

test('assertCanonicalUuid accepts only exact lowercase UUIDv4 and never echoes rejected values', () => {
  const canonical = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(assertCanonicalUuid(canonical, 'chapter_uid'), canonical);

  for (const value of [
    canonical.toUpperCase(),
    '00000000-0000-1000-8000-000000000000',
    '00000000-0000-4000-7000-000000000000',
    `{${canonical}}`,
    ` ${canonical}`,
    `${canonical} `,
    '',
    null,
  ]) {
    assert.throws(
      () => assertCanonicalUuid(value, 'chapter_uid'),
      (error) => (
        error?.code === 'MANUSCRIPT_FILESET_INVALID'
        && error.message === 'MANUSCRIPT_FILESET_INVALID'
        && JSON.stringify(error.details) === JSON.stringify({ role: 'chapter_uid' })
      ),
    );
  }
  assert.throws(() => assertCanonicalUuid(canonical, ''), TypeError);
});
