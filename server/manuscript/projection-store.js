'use strict';

const { createHash } = require('node:crypto');
const { assertControlledFileRef } = require('./paths');

const PROJECTION_BASIS_DOMAIN = 'mythpen.manuscript.projection-basis';
const PROJECTION_BASIS_VERSION = 1;
const PROJECTION_TARGET_DOMAIN = 'mythpen.manuscript.projection-target';
const PROJECTION_TARGET_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE_KINDS = new Set(['schema11', 'schema12', 'empty']);
const OBJECT_KINDS = new Set(['chapter', 'volume']);
const CHAPTER_STATUSES = new Set(['pending', 'writing', 'review', 'accepted']);
const FILE_ROLES = new Set([
  'manuscript', 'unassigned', 'volume_index', 'chapter_body', 'chapter_sidecar',
]);
const CAPACITY_MEASUREMENT_KEYS = Object.freeze([
  'chapterIdentities', 'volumeIdentities', 'markdownBytes', 'jsonBytes',
  'controlledFiles', 'chapterDirectoryEntries', 'controlledBytes',
]);
const CAPACITY_COUNTER_KEYS = Object.freeze([
  'directoryEntries', 'identityProbes', 'contentOpens', 'contentBytes',
]);

const BASIS_KEYS = Object.freeze([
  'domain',
  'version',
  'sourceKind',
  'baseGeneration',
  'volumes',
  'chapters',
  'sqliteSequence',
  'ignoredBeforeDigest',
  'pendingProposals',
  'basisDigest',
]);

const CURRENT_PROJECTION_KEYS = Object.freeze(['projectUid', 'projectInstanceId', 'basis']);
const SCHEMA11_VOLUME_KEYS = Object.freeze(['id', 'sortOrder']);
const SCHEMA12_VOLUME_KEYS = Object.freeze([
  'id', 'uid', 'sortOrder', 'isPresent', 'deletedAt',
]);
const SCHEMA11_CHAPTER_KEYS = Object.freeze([
  'id', 'volumeId', 'num', 'bodyRawSha256', 'status',
]);
const SCHEMA12_CHAPTER_KEYS = Object.freeze([
  'id', 'uid', 'volumeId', 'num', 'isPresent', 'deletedAt',
  'chapterPosition', 'manuscriptPosition', 'bodyRawSha256', 'status',
]);
const ACTIVE_VOLUME_KEYS = Object.freeze([
  'id', 'sort_order', 'title', 'summary', 'volume_uid', 'is_present', 'deleted_at',
]);
const TOMBSTONE_VOLUME_KEYS = Object.freeze([
  'id', 'volume_uid', 'is_present', 'deleted_at',
]);
const ACTIVE_CHAPTER_KEYS = Object.freeze([
  'id', 'volume_id', 'num', 'title', 'outline', 'content', 'summary',
  'word_count', 'status', 'cognitive_frame', 'emotional_anchor',
  'world_texture', 'concrete_mystery', 'interpersonal_tension',
  'chapter_uid', 'is_present', 'deleted_at', 'chapter_position',
  'manuscript_position', 'body_raw_sha256', 'sidecar_raw_sha256',
  'content_available',
]);
const TOMBSTONE_CHAPTER_KEYS = Object.freeze([
  'id', 'num', 'chapter_uid', 'is_present', 'deleted_at',
  'chapter_position', 'manuscript_position',
]);
const CONTROLLED_FILE_FACT_KEYS = Object.freeze([
  'byteSize', 'fileIdentity', 'parentIdentity', 'rawSha256',
  'resourceUid', 'role',
]);
const CANDIDATE_CONTROLLED_FILE_KEYS = Object.freeze([
  ...CONTROLLED_FILE_FACT_KEYS,
  'ref',
]);
const IGNORED_ROW_KEYS = Object.freeze([
  'resource_kind', 'resource_uid', 'ignore_status', 'opaque_container_kind',
  'opaque_container_uid', 'is_currently_referenced', 'member_snapshot_json',
  'projection_generation',
]);
const CANDIDATE_KEYS = Object.freeze([
  'capacitySnapshot', 'chapters', 'controlledFiles', 'diagnostics',
  'ignoredLedgerAfter', 'projectUid', 'volumeOrder', 'volumes', 'warnings',
]);
const CANDIDATE_VOLUME_KEYS = Object.freeze([
  'summary', 'title', 'volumePosition', 'volumeUid',
]);
const CANDIDATE_CHAPTER_KEYS = Object.freeze([
  'bodyFileIdentity', 'bodyRawSha256', 'chapterPosition', 'chapterUid',
  'cognitiveFrame', 'concreteMystery', 'content', 'contentAvailable',
  'emotionalAnchor', 'interpersonalTension', 'manuscriptPosition',
  'markdownMode', 'outline', 'sidecarFileIdentity', 'sidecarRawSha256',
  'status', 'summary', 'title', 'volumeUid', 'wordCount', 'worldTexture',
]);
const BUILD_TARGET_KEYS = Object.freeze([
  'candidate', 'currentProjection', 'targetGeneration', 'projectedAt',
  'ignoredLedger', 'localIdentityPlan',
]);
const TARGET_KEYS = Object.freeze([
  'domain', 'version', 'projectUid', 'projectInstanceId', 'basis',
  'basisDigest', 'baseGeneration', 'targetGeneration', 'projectedAt',
  'volumes', 'chapters', 'sqliteSequence', 'controlledFiles',
  'ignoredLedger', 'capacitySnapshot', 'proposalInvalidations',
  'localIdentityPlan',
]);

function invalid(message) {
  throw new TypeError(message);
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataDescriptors(value, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid(`${label} must contain enumerable data properties only`);
    }
  }
  return descriptors;
}

function assertExactKeys(value, keys, label) {
  const descriptors = dataDescriptors(value, label);
  const actual = Object.keys(descriptors).sort(utf8Compare);
  const expected = [...keys].sort(utf8Compare);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} has an inexact key set`);
  }
  return descriptors;
}

function assertDenseArray(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid(`${label} must be dense data`);
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string'
      || !/^(0|[1-9][0-9]*)$/.test(key)
      || Number(key) >= value.length
    ) {
      invalid(`${label} has an invalid array property`);
    }
  }
  return value;
}

function assertPlainTree(value, options = {}, active = new WeakSet()) {
  const { requireFrozen = false, label = 'value' } = options;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      invalid(`${label} numbers must be canonical safe integers`);
    }
    return value;
  }
  if (typeof value !== 'object' || active.has(value)) {
    invalid(`${label} must be finite acyclic plain data`);
  }
  if (requireFrozen && !Object.isFrozen(value)) invalid(`${label} must be deeply frozen`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      assertDenseArray(value, label);
      for (const item of value) assertPlainTree(item, options, active);
      return value;
    }
    const descriptors = dataDescriptors(value, label);
    for (const key of Object.keys(descriptors).sort(utf8Compare)) {
      assertPlainTree(descriptors[key].value, options, active);
    }
    return value;
  } finally {
    active.delete(value);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value <= 0) {
    invalid(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function zeroOrOne(value, label) {
  if (Object.is(value, -0) || (value !== 0 && value !== 1)) invalid(`${label} must be 0 or 1`);
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(`${label} must be a canonical UUIDv4`);
  return value;
}

function sha256(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid(`${label} must be a lowercase SHA-256`);
  return value;
}

function canonicalTime(value, label = 'projectedAt') {
  if (
    typeof value !== 'string'
    || !CANONICAL_TIME_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    invalid(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function stringValue(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function normalizeRow(row, keys, label) {
  assertExactKeys(row, keys, label);
  return row;
}

function canonicalRow(row, keys) {
  const result = {};
  for (const key of keys) result[key] = row[key];
  return result;
}

function validateFileIdentity(value, label) {
  const identity = normalizeRow(value, ['dev', 'ino'], label);
  for (const key of ['dev', 'ino']) {
    if (typeof identity[key] !== 'string' || !/^[0-9]+$/u.test(identity[key])) {
      invalid(`${label}.${key} must be a decimal string`);
    }
  }
}

function compareControlledFileFacts(left, right) {
  return (
    utf8Compare(left.role, right.role)
    || utf8Compare(left.resourceUid ?? '', right.resourceUid ?? '')
    || utf8Compare(left.rawSha256, right.rawSha256)
  );
}

function validateControlledFileFact(row, label) {
  nonNegativeInteger(row.byteSize, `${label}.byteSize`);
  validateFileIdentity(row.fileIdentity, `${label}.fileIdentity`);
  validateFileIdentity(row.parentIdentity, `${label}.parentIdentity`);
  sha256(row.rawSha256, `${label}.rawSha256`);
  if (!FILE_ROLES.has(row.role)) invalid(`${label}.role is invalid`);
  const rootRole = row.role === 'manuscript' || row.role === 'unassigned';
  if (rootRole !== (row.resourceUid === null)) invalid(`${label}.resourceUid is inconsistent`);
  if (row.resourceUid !== null) canonicalUuid(row.resourceUid, `${label}.resourceUid`);
  return rootRole;
}

function normalizeControlledFileFacts(value, label) {
  const seen = new Set();
  return assertDenseArray(value, label).map((entry, index) => {
    const rowLabel = `${label}[${index}]`;
    const row = normalizeRow(entry, CONTROLLED_FILE_FACT_KEYS, rowLabel);
    validateControlledFileFact(row, rowLabel);
    const key = `${row.role}:${row.resourceUid ?? ''}`;
    if (seen.has(key)) invalid(`${label} contains a duplicate controlled ref`);
    seen.add(key);
    return row;
  }).sort(compareControlledFileFacts);
}

function normalizeCandidateControlledFiles(value, projectUid, label) {
  const seen = new Set();
  return assertDenseArray(value, label).map((entry, index) => {
    const rowLabel = `${label}[${index}]`;
    const row = normalizeRow(entry, CANDIDATE_CONTROLLED_FILE_KEYS, rowLabel);
    const rootRole = validateControlledFileFact(row, rowLabel);
    const ref = assertControlledFileRef(row.ref);
    if (ref.role !== row.role || ref.projectUid !== projectUid) {
      invalid(`${rowLabel}.ref is inconsistent`);
    }
    if (
      (!rootRole && row.role === 'volume_index' && ref.volumeUid !== row.resourceUid)
      || (!rootRole && row.role !== 'volume_index' && ref.chapterUid !== row.resourceUid)
    ) {
      invalid(`${rowLabel}.ref is inconsistent`);
    }
    const key = `${row.role}:${row.resourceUid ?? ''}`;
    if (seen.has(key)) invalid(`${label} contains a duplicate controlled ref`);
    seen.add(key);
    return canonicalRow(row, CONTROLLED_FILE_FACT_KEYS);
  }).sort(compareControlledFileFacts);
}

function validateCapacitySnapshot(value, label) {
  const snapshot = normalizeRow(
    value,
    ['state', 'measurements', 'counters', 'warnings', 'error'],
    label,
  );
  if (snapshot.state !== 'active' || snapshot.error !== null) invalid(`${label} must be active`);
  for (const [member, keys] of [
    ['measurements', CAPACITY_MEASUREMENT_KEYS],
    ['counters', CAPACITY_COUNTER_KEYS],
  ]) {
    const counts = normalizeRow(snapshot[member], keys, `${label}.${member}`);
    for (const key of keys) nonNegativeInteger(counts[key], `${label}.${member}.${key}`);
  }
  assertDenseArray(snapshot.warnings, `${label}.warnings`).forEach((entry, index) => {
    const warningLabel = `${label}.warnings[${index}]`;
    const warning = normalizeRow(
      entry,
      ['key', 'dimension', 'observed', 'allowed', 'threshold', 'persistent'],
      warningLabel,
    );
    stringValue(warning.key, `${warningLabel}.key`);
    if (!CAPACITY_MEASUREMENT_KEYS.includes(warning.dimension)) invalid(`${warningLabel}.dimension is invalid`);
    for (const key of ['observed', 'allowed', 'threshold']) {
      nonNegativeInteger(warning[key], `${warningLabel}.${key}`);
    }
    if (warning.persistent !== true) invalid(`${warningLabel}.persistent must be true`);
  });
  return snapshot;
}

function normalizeIgnoredRows(rows, label) {
  assertDenseArray(rows, label);
  const seen = new Set();
  const normalized = rows.map((row, index) => {
    const result = normalizeRow(row, IGNORED_ROW_KEYS, `${label}[${index}]`);
    if (result.resource_kind !== 'chapter' && result.resource_kind !== 'volume') {
      invalid(`${label}[${index}].resource_kind is invalid`);
    }
    canonicalUuid(result.resource_uid, `${label}[${index}].resource_uid`);
    if (result.ignore_status !== 'active' && result.ignore_status !== 'revoked') {
      invalid(`${label}[${index}].ignore_status is invalid`);
    }
    if (result.opaque_container_kind !== null) {
      if (result.opaque_container_kind !== 'unassigned' && result.opaque_container_kind !== 'volume') {
        invalid(`${label}[${index}].opaque_container_kind is invalid`);
      }
    }
    if (result.opaque_container_uid !== null) {
      canonicalUuid(result.opaque_container_uid, `${label}[${index}].opaque_container_uid`);
    }
    zeroOrOne(result.is_currently_referenced, `${label}[${index}].is_currently_referenced`);
    stringValue(result.member_snapshot_json, `${label}[${index}].member_snapshot_json`);
    try {
      JSON.parse(result.member_snapshot_json);
    } catch {
      invalid(`${label}[${index}].member_snapshot_json is invalid JSON`);
    }
    if (result.is_currently_referenced === 0) {
      if (result.opaque_container_kind !== null || result.opaque_container_uid !== null) {
        invalid(`${label}[${index}] detached container state is inconsistent`);
      }
    } else if (
      !(
        result.opaque_container_kind === 'unassigned'
        && result.opaque_container_uid === null
      )
      && !(
        result.opaque_container_kind === 'volume'
        && result.opaque_container_uid !== null
      )
    ) {
      invalid(`${label}[${index}] referenced container state is inconsistent`);
    }
    nonNegativeInteger(result.projection_generation, `${label}[${index}].projection_generation`);
    const key = `${result.resource_kind}:${result.resource_uid}`;
    if (seen.has(key)) invalid(`${label} contains a duplicate resource`);
    seen.add(key);
    return result;
  });
  return normalized.sort((left, right) => (
    utf8Compare(left.resource_kind, right.resource_kind)
    || utf8Compare(left.resource_uid, right.resource_uid)
  ));
}

function normalizeBasis(basis) {
  const descriptors = assertExactKeys(basis, BASIS_KEYS, 'projection basis');
  const sourceKind = descriptors.sourceKind.value;
  if (!SOURCE_KINDS.has(sourceKind)) invalid('projection basis sourceKind is invalid');
  if (descriptors.domain.value !== PROJECTION_BASIS_DOMAIN) invalid('projection basis domain is invalid');
  if (descriptors.version.value !== PROJECTION_BASIS_VERSION) invalid('projection basis version is invalid');
  const baseGeneration = nonNegativeInteger(descriptors.baseGeneration.value, 'projection basis baseGeneration');
  if (sourceKind !== 'schema12' && baseGeneration !== 0) {
    invalid('schema11 and empty bases must start at generation zero');
  }
  const volumeKeys = sourceKind === 'schema12' ? SCHEMA12_VOLUME_KEYS : SCHEMA11_VOLUME_KEYS;
  const chapterKeys = sourceKind === 'schema12' ? SCHEMA12_CHAPTER_KEYS : SCHEMA11_CHAPTER_KEYS;
  const volumesInput = assertDenseArray(descriptors.volumes.value, 'projection basis volumes');
  const chaptersInput = assertDenseArray(descriptors.chapters.value, 'projection basis chapters');
  if (sourceKind === 'empty' && (volumesInput.length !== 0 || chaptersInput.length !== 0)) {
    invalid('empty projection basis cannot contain manuscript rows');
  }

  const volumeIds = new Set();
  const volumeUids = new Set();
  const volumes = volumesInput.map((row, index) => {
    const result = normalizeRow(row, volumeKeys, `projection basis volumes[${index}]`);
    positiveInteger(result.id, `projection basis volumes[${index}].id`);
    if (!Number.isSafeInteger(result.sortOrder) || Object.is(result.sortOrder, -0)) {
      invalid(`projection basis volumes[${index}].sortOrder must be a safe integer`);
    }
    if (volumeIds.has(result.id)) invalid('projection basis contains duplicate volume ids');
    volumeIds.add(result.id);
    if (sourceKind === 'schema12') {
      canonicalUuid(result.uid, `projection basis volumes[${index}].uid`);
      zeroOrOne(result.isPresent, 'projection basis volume isPresent');
      stringValue(result.deletedAt, `projection basis volumes[${index}].deletedAt`, true);
      if (result.deletedAt !== null) {
        canonicalTime(result.deletedAt, `projection basis volumes[${index}].deletedAt`);
      }
      if ((result.isPresent === 1) !== (result.deletedAt === null)) {
        invalid('projection basis volume tombstone state is inconsistent');
      }
      if (volumeUids.has(result.uid)) invalid('projection basis contains duplicate volume UIDs');
      volumeUids.add(result.uid);
    }
    return result;
  }).sort((left, right) => left.id - right.id);

  const chapterIds = new Set();
  const chapterUids = new Set();
  const chapters = chaptersInput.map((row, index) => {
    const result = normalizeRow(row, chapterKeys, `projection basis chapters[${index}]`);
    positiveInteger(result.id, `projection basis chapters[${index}].id`);
    positiveInteger(result.num, `projection basis chapters[${index}].num`);
    if (result.volumeId !== null) positiveInteger(result.volumeId, 'projection basis chapter volumeId');
    stringValue(result.status, 'projection basis chapter status');
    if (!CHAPTER_STATUSES.has(result.status)) invalid('projection basis chapter status is invalid');
    if (chapterIds.has(result.id)) invalid('projection basis contains duplicate chapter ids');
    chapterIds.add(result.id);
    if (result.volumeId !== null && !volumeIds.has(result.volumeId)) {
      invalid('projection basis chapter references an unknown volume id');
    }
    if (sourceKind === 'schema12') {
      canonicalUuid(result.uid, `projection basis chapters[${index}].uid`);
      zeroOrOne(result.isPresent, 'projection basis chapter isPresent');
      sha256(result.bodyRawSha256, 'projection basis chapter body hash', result.isPresent === 0);
      stringValue(result.deletedAt, `projection basis chapters[${index}].deletedAt`, true);
      if (result.deletedAt !== null) {
        canonicalTime(result.deletedAt, `projection basis chapters[${index}].deletedAt`);
      }
      if (result.isPresent === 1) {
        if (result.deletedAt !== null) invalid('active projection basis chapter cannot be deleted');
        positiveInteger(result.chapterPosition, 'active projection basis chapterPosition');
        positiveInteger(result.manuscriptPosition, 'active projection basis manuscriptPosition');
      } else if (
        result.deletedAt === null
        || result.chapterPosition !== null
        || result.manuscriptPosition !== null
      ) {
        invalid('projection basis chapter tombstone state is inconsistent');
      }
      if (chapterUids.has(result.uid)) invalid('projection basis contains duplicate chapter UIDs');
      chapterUids.add(result.uid);
    } else sha256(result.bodyRawSha256, 'projection basis chapter body hash');
    return result;
  }).sort((left, right) => left.id - right.id);

  const sequenceNames = new Set();
  const sqliteSequence = assertDenseArray(
    descriptors.sqliteSequence.value,
    'projection basis sqliteSequence',
  ).map((row, index) => {
    const result = normalizeRow(row, ['name', 'seq'], `projection basis sqliteSequence[${index}]`);
    stringValue(result.name, `projection basis sqliteSequence[${index}].name`);
    nonNegativeInteger(result.seq, `projection basis sqliteSequence[${index}].seq`);
    if (sequenceNames.has(result.name)) invalid('projection basis contains duplicate sqlite_sequence rows');
    sequenceNames.add(result.name);
    return result;
  }).sort((left, right) => utf8Compare(left.name, right.name));
  if (
    sqliteSequence.length !== 2
    || sqliteSequence[0].name !== 'chapters'
    || sqliteSequence[1].name !== 'volumes'
  ) {
    invalid('projection basis sqliteSequence must contain only chapters and volumes');
  }
  if (sourceKind === 'empty' && sqliteSequence.some((row) => row.seq !== 0)) {
    invalid('empty projection basis sequences must be zero');
  }
  for (const [name, rows] of [['volumes', volumes], ['chapters', chapters]]) {
    const maximumId = rows.reduce((maximum, row) => Math.max(maximum, row.id), 0);
    const sequence = sqliteSequence.find((row) => row.name === name).seq;
    if (sequence < maximumId) invalid(`projection basis ${name} sequence is behind its rows`);
  }

  const ignoredBeforeDigest = sha256(
    descriptors.ignoredBeforeDigest.value,
    'projection basis ignoredBeforeDigest',
  );
  if (sourceKind !== 'schema12' && ignoredBeforeDigest !== canonicalIgnoredLedgerDigest([])) {
    invalid('schema11 and empty bases must use the empty ignored ledger digest');
  }
  const revisionIds = new Set();
  const pendingProposals = assertDenseArray(
    descriptors.pendingProposals.value,
    'projection basis pendingProposals',
  ).map((row, index) => {
    const result = normalizeRow(row, ['revisionId', 'chapterId'], `projection basis pendingProposals[${index}]`);
    positiveInteger(result.revisionId, `projection basis pendingProposals[${index}].revisionId`);
    positiveInteger(result.chapterId, `projection basis pendingProposals[${index}].chapterId`);
    if (revisionIds.has(result.revisionId)) invalid('projection basis contains duplicate pending revision ids');
    if (!chapterIds.has(result.chapterId)) invalid('pending proposal references an unknown chapter id');
    revisionIds.add(result.revisionId);
    return result;
  }).sort((left, right) => left.revisionId - right.revisionId || left.chapterId - right.chapterId);
  if (sourceKind === 'empty' && pendingProposals.length !== 0) {
    invalid('empty projection basis cannot contain pending proposals');
  }
  const basisDigest = sha256(descriptors.basisDigest.value, 'projection basis basisDigest');
  return {
    domain: PROJECTION_BASIS_DOMAIN,
    version: PROJECTION_BASIS_VERSION,
    sourceKind,
    baseGeneration,
    volumes,
    chapters,
    sqliteSequence,
    ignoredBeforeDigest,
    pendingProposals,
    basisDigest,
  };
}

function canonicalIgnoredLedgerDigest(rows) {
  const normalized = normalizeIgnoredRows(rows, 'ignored ledger');
  const material = normalized.map((row) => canonicalRow(row, IGNORED_ROW_KEYS));
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
}

function digestNormalizedBasis(normalized) {
  const material = {
    domain: normalized.domain,
    version: normalized.version,
    sourceKind: normalized.sourceKind,
    baseGeneration: normalized.baseGeneration,
    volumes: normalized.volumes.map((row) => canonicalRow(
      row,
      normalized.sourceKind === 'schema12' ? SCHEMA12_VOLUME_KEYS : SCHEMA11_VOLUME_KEYS,
    )),
    chapters: normalized.chapters.map((row) => canonicalRow(
      row,
      normalized.sourceKind === 'schema12' ? SCHEMA12_CHAPTER_KEYS : SCHEMA11_CHAPTER_KEYS,
    )),
    sqliteSequence: normalized.sqliteSequence.map((row) => canonicalRow(row, ['name', 'seq'])),
    ignoredBeforeDigest: normalized.ignoredBeforeDigest,
    pendingProposals: normalized.pendingProposals.map((row) => canonicalRow(
      row,
      ['revisionId', 'chapterId'],
    )),
  };
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
}

function canonicalProjectionBasisDigest(basis) {
  return digestNormalizedBasis(normalizeBasis(basis));
}

function normalizeCurrentProjection(value) {
  assertPlainTree(value, { requireFrozen: true, label: 'currentProjection' });
  const descriptors = assertExactKeys(value, CURRENT_PROJECTION_KEYS, 'currentProjection');
  const projectUid = canonicalUuid(descriptors.projectUid.value, 'currentProjection.projectUid');
  const projectInstanceId = canonicalUuid(
    descriptors.projectInstanceId.value,
    'currentProjection.projectInstanceId',
  );
  const basis = normalizeBasis(descriptors.basis.value);
  if (digestNormalizedBasis(basis) !== basis.basisDigest) {
    invalid('currentProjection basisDigest does not match its canonical basis');
  }
  return { projectUid, projectInstanceId, basis };
}

function normalizeCandidate(value) {
  assertPlainTree(value, { requireFrozen: true, label: 'candidate' });
  const descriptors = assertExactKeys(value, CANDIDATE_KEYS, 'candidate');
  const projectUid = canonicalUuid(descriptors.projectUid.value, 'candidate.projectUid');
  const volumeUids = new Set();
  const volumes = assertDenseArray(descriptors.volumes.value, 'candidate.volumes').map((row, index) => {
    const result = normalizeRow(row, CANDIDATE_VOLUME_KEYS, `candidate.volumes[${index}]`);
    canonicalUuid(result.volumeUid, `candidate.volumes[${index}].volumeUid`);
    positiveInteger(result.volumePosition, `candidate.volumes[${index}].volumePosition`);
    if (volumeUids.has(result.volumeUid)) invalid('candidate contains duplicate volume UIDs');
    volumeUids.add(result.volumeUid);
    return result;
  }).sort((left, right) => left.volumePosition - right.volumePosition);
  const volumeOrder = assertDenseArray(descriptors.volumeOrder.value, 'candidate.volumeOrder')
    .map((uid, index) => canonicalUuid(uid, `candidate.volumeOrder[${index}]`));
  if (
    volumeOrder.length !== volumes.length
    || volumeOrder.some((uid, index) => uid !== volumes[index].volumeUid)
  ) {
    invalid('candidate volumeOrder must match volume positions');
  }

  const chapterUids = new Set();
  const chapters = assertDenseArray(descriptors.chapters.value, 'candidate.chapters')
    .map((row, index) => {
      const result = normalizeRow(row, CANDIDATE_CHAPTER_KEYS, `candidate.chapters[${index}]`);
      canonicalUuid(result.chapterUid, `candidate.chapters[${index}].chapterUid`);
      if (result.volumeUid !== null) {
        canonicalUuid(result.volumeUid, `candidate.chapters[${index}].volumeUid`);
        if (!volumeUids.has(result.volumeUid)) invalid('candidate chapter references an unknown volume UID');
      }
      positiveInteger(result.chapterPosition, `candidate.chapters[${index}].chapterPosition`);
      positiveInteger(result.manuscriptPosition, `candidate.chapters[${index}].manuscriptPosition`);
      sha256(result.bodyRawSha256, `candidate.chapters[${index}].bodyRawSha256`);
      if (!CHAPTER_STATUSES.has(result.status)) invalid('candidate chapter status is invalid');
      if (chapterUids.has(result.chapterUid)) invalid('candidate contains duplicate chapter UIDs');
      chapterUids.add(result.chapterUid);
      return result;
    }).sort((left, right) => left.manuscriptPosition - right.manuscriptPosition);

  const controlledFiles = normalizeCandidateControlledFiles(
    descriptors.controlledFiles.value,
    projectUid,
    'candidate.controlledFiles',
  );
  return {
    projectUid,
    volumes,
    chapters,
    volumeOrder,
    controlledFiles,
    capacitySnapshot: descriptors.capacitySnapshot.value,
  };
}

function normalizeIdentityPlan(value) {
  assertPlainTree(value, { requireFrozen: true, label: 'localIdentityPlan' });
  const input = assertDenseArray(value, 'localIdentityPlan');
  const seenUids = new Set();
  const seenIds = new Set();
  const normalized = input.map((entry, index) => {
    const baseKeys = ['assignmentKind', 'objectKind', 'uid', 'id'];
    const objectKind = entry?.objectKind;
    const assignmentKind = entry?.assignmentKind;
    const keys = [...baseKeys];
    if (objectKind === 'chapter') keys.push('num');
    if (assignmentKind === 'bind_legacy' || assignmentKind === 'reserved_new') {
      keys.push('reservationId');
    }
    const row = normalizeRow(entry, keys, `localIdentityPlan[${index}]`);
    if (!OBJECT_KINDS.has(row.objectKind)) invalid('identity assignment objectKind is invalid');
    if (!['reuse_uid', 'bind_legacy', 'reserved_new'].includes(row.assignmentKind)) {
      invalid('identity assignment assignmentKind is invalid');
    }
    canonicalUuid(row.uid, `localIdentityPlan[${index}].uid`);
    positiveInteger(row.id, `localIdentityPlan[${index}].id`);
    if (row.objectKind === 'chapter') positiveInteger(row.num, `localIdentityPlan[${index}].num`);
    if (row.reservationId !== undefined) {
      if (typeof row.reservationId !== 'string' || row.reservationId.length === 0) {
        invalid('identity assignment reservationId must be non-empty');
      }
    }
    const uidKey = `${row.objectKind}:${row.uid}`;
    const idKey = `${row.objectKind}:${row.id}`;
    if (seenUids.has(uidKey) || seenIds.has(idKey)) invalid('localIdentityPlan contains duplicate identity assignments');
    seenUids.add(uidKey);
    seenIds.add(idKey);
    return row;
  });
  const sorted = [...normalized].sort((left, right) => (
    utf8Compare(left.objectKind, right.objectKind) || utf8Compare(left.uid, right.uid)
  ));
  if (normalized.some((row, index) => row.objectKind !== sorted[index].objectKind || row.uid !== sorted[index].uid)) {
    invalid('localIdentityPlan must be sorted by objectKind and UID');
  }
  return normalized;
}

function sequenceFor(basis, table) {
  return basis.sqliteSequence.find((row) => row.name === table)?.seq ?? 0;
}

function validateIdentityCoverage(basis, candidateValue, assignments) {
  const byKindUid = new Map(assignments.map((row) => [`${row.objectKind}:${row.uid}`, row]));
  const byKindId = new Map(assignments.map((row) => [`${row.objectKind}:${row.id}`, row]));
  const candidateUids = new Set([
    ...candidateValue.volumes.map((row) => `volume:${row.volumeUid}`),
    ...candidateValue.chapters.map((row) => `chapter:${row.chapterUid}`),
  ]);

  if (basis.sourceKind === 'schema12') {
    for (const [objectKind, rows] of [
      ['volume', basis.volumes],
      ['chapter', basis.chapters],
    ]) {
      for (const row of rows) {
        const assignment = byKindUid.get(`${objectKind}:${row.uid}`);
        if (
          assignment === undefined
          || assignment.assignmentKind !== 'reuse_uid'
          || assignment.id !== row.id
          || (objectKind === 'chapter' && assignment.num !== row.num)
        ) invalid('schema12 identities must be covered by exact reuse_uid assignments');
      }
    }
    if (assignments.some((row) => row.assignmentKind === 'bind_legacy')) {
      invalid('schema12 projection cannot use bind_legacy');
    }
  } else if (basis.sourceKind === 'schema11') {
    for (const [objectKind, rows] of [['volume', basis.volumes], ['chapter', basis.chapters]]) {
      for (const row of rows) {
        const assignment = byKindId.get(`${objectKind}:${row.id}`);
        if (
          assignment === undefined
          || assignment.assignmentKind !== 'bind_legacy'
          || (objectKind === 'chapter' && assignment.num !== row.num)
        ) invalid('schema11 rows must be covered by exact bind_legacy assignments');
      }
    }
    if (assignments.some((row) => row.assignmentKind === 'reuse_uid')) {
      invalid('schema11 projection cannot use reuse_uid');
    }
  } else if (assignments.some((row) => row.assignmentKind !== 'reserved_new')) {
    invalid('empty projection can only use reserved_new assignments');
  }

  for (const assignment of assignments) {
    const key = `${assignment.objectKind}:${assignment.uid}`;
    const table = assignment.objectKind === 'chapter' ? 'chapters' : 'volumes';
    const sourceRows = assignment.objectKind === 'chapter' ? basis.chapters : basis.volumes;
    if (assignment.assignmentKind === 'reserved_new') {
      if (!candidateUids.has(key)) invalid('reserved_new must describe a candidate row');
      if (assignment.id <= sequenceFor(basis, table)) invalid('reserved_new conflicts with sqlite_sequence');
      if (
        sourceRows.some((row) => row.id === assignment.id)
        || (basis.sourceKind === 'schema12' && sourceRows.some((row) => row.uid === assignment.uid))
      ) invalid('reserved_new collides with the projection basis');
    } else if (assignment.assignmentKind === 'reuse_uid') {
      const source = basis.sourceKind === 'schema12'
        ? sourceRows.find((row) => row.uid === assignment.uid)
        : undefined;
      if (
        source === undefined
        || source.id !== assignment.id
        || (assignment.objectKind === 'chapter' && source.num !== assignment.num)
      ) invalid('reuse_uid does not match the projection basis');
    } else {
      const source = basis.sourceKind === 'schema11'
        ? sourceRows.find((row) => row.id === assignment.id)
        : undefined;
      if (
        source === undefined
        || (assignment.objectKind === 'chapter' && source.num !== assignment.num)
      ) invalid('bind_legacy does not match a source row');
    }
  }
  for (const key of candidateUids) {
    if (!byKindUid.has(key)) invalid('localIdentityPlan does not cover every candidate object');
  }
  const expectedCount = new Set([
    ...candidateUids,
    ...assignments.filter((row) => row.assignmentKind !== 'reserved_new')
      .map((row) => `${row.objectKind}:${row.uid}`),
  ]).size;
  if (assignments.length !== expectedCount) invalid('localIdentityPlan contains an unrelated assignment');
}

function tombstoneVolume(base, assignment, projectedAt) {
  return {
    id: base.id,
    volume_uid: assignment.uid,
    is_present: 0,
    deleted_at: base.isPresent === 0 ? base.deletedAt : projectedAt,
  };
}

function activeVolume(candidateRow, assignment) {
  return {
    id: assignment.id,
    sort_order: candidateRow.volumePosition,
    title: candidateRow.title,
    summary: candidateRow.summary,
    volume_uid: assignment.uid,
    is_present: 1,
    deleted_at: null,
  };
}

function tombstoneChapter(base, assignment, projectedAt) {
  return {
    id: base.id,
    num: base.num,
    chapter_uid: assignment.uid,
    is_present: 0,
    deleted_at: base.isPresent === 0 ? base.deletedAt : projectedAt,
    chapter_position: null,
    manuscript_position: null,
  };
}

function activeChapter(candidateRow, assignment, volumeId) {
  return {
    id: assignment.id,
    volume_id: volumeId,
    num: assignment.num,
    title: candidateRow.title,
    outline: candidateRow.outline,
    content: candidateRow.content,
    summary: candidateRow.summary,
    word_count: candidateRow.wordCount,
    status: candidateRow.status,
    cognitive_frame: candidateRow.cognitiveFrame,
    emotional_anchor: candidateRow.emotionalAnchor,
    world_texture: candidateRow.worldTexture,
    concrete_mystery: candidateRow.concreteMystery,
    interpersonal_tension: candidateRow.interpersonalTension,
    chapter_uid: assignment.uid,
    is_present: 1,
    deleted_at: null,
    chapter_position: candidateRow.chapterPosition,
    manuscript_position: candidateRow.manuscriptPosition,
    body_raw_sha256: candidateRow.bodyRawSha256,
    sidecar_raw_sha256: candidateRow.sidecarRawSha256,
    content_available: candidateRow.contentAvailable ? 1 : 0,
  };
}

function compileRows(basis, candidateValue, assignments, projectedAt) {
  const candidateVolumes = new Map(candidateValue.volumes.map((row) => [row.volumeUid, row]));
  const candidateChapters = new Map(candidateValue.chapters.map((row) => [row.chapterUid, row]));
  const basisVolumeByUid = new Map(
    basis.sourceKind === 'schema12' ? basis.volumes.map((row) => [row.uid, row]) : [],
  );
  const basisChapterByUid = new Map(
    basis.sourceKind === 'schema12' ? basis.chapters.map((row) => [row.uid, row]) : [],
  );
  const basisVolumeById = new Map(basis.volumes.map((row) => [row.id, row]));
  const basisChapterById = new Map(basis.chapters.map((row) => [row.id, row]));

  const volumes = assignments.filter((row) => row.objectKind === 'volume').map((assignment) => {
    const candidateRow = candidateVolumes.get(assignment.uid);
    const base = assignment.assignmentKind === 'reuse_uid'
      ? basisVolumeByUid.get(assignment.uid)
      : basisVolumeById.get(assignment.id);
    if (candidateRow !== undefined) return activeVolume(candidateRow, assignment);
    if (base === undefined) invalid('volume assignment has neither a basis nor a candidate row');
    return tombstoneVolume(base, assignment, projectedAt);
  }).sort((left, right) => left.id - right.id);
  const activeVolumeIds = new Map(
    volumes.filter((row) => row.is_present === 1).map((row) => [row.volume_uid, row.id]),
  );

  const chapters = assignments.filter((row) => row.objectKind === 'chapter').map((assignment) => {
    const candidateRow = candidateChapters.get(assignment.uid);
    const base = assignment.assignmentKind === 'reuse_uid'
      ? basisChapterByUid.get(assignment.uid)
      : basisChapterById.get(assignment.id);
    if (candidateRow !== undefined) {
      const volumeId = candidateRow.volumeUid === null
        ? null
        : activeVolumeIds.get(candidateRow.volumeUid);
      if (candidateRow.volumeUid !== null && volumeId === undefined) {
        invalid('active chapter references a non-active target volume');
      }
      return activeChapter(candidateRow, assignment, volumeId);
    }
    if (base === undefined) invalid('chapter assignment has neither a basis nor a candidate row');
    return tombstoneChapter(base, assignment, projectedAt);
  }).sort((left, right) => left.id - right.id);

  const activeNums = new Set();
  for (const row of chapters) {
    if (row.is_present !== 1) continue;
    const key = row.volume_id === null ? `unassigned:${row.num}` : `volume:${row.volume_id}:${row.num}`;
    if (activeNums.has(key)) invalid('active target chapters contain a duplicate container number');
    activeNums.add(key);
  }
  return { volumes, chapters };
}

function targetSequence(basis, rows) {
  const byName = new Map(basis.sqliteSequence.map((row) => [row.name, row.seq]));
  for (const [name, values] of [['volumes', rows.volumes], ['chapters', rows.chapters]]) {
    const maximum = values.reduce((current, row) => Math.max(current, row.id), 0);
    if (maximum > 0 || byName.has(name)) byName.set(name, Math.max(byName.get(name) ?? 0, maximum));
  }
  return [...byName.entries()]
    .map(([name, seq]) => ({ name, seq }))
    .sort((left, right) => utf8Compare(left.name, right.name));
}

function deriveProposalInvalidations(basis, candidateValue, assignments) {
  if (basis.pendingProposals.length === 0) return [];
  const assignmentById = new Map(
    assignments.filter((row) => row.objectKind === 'chapter').map((row) => [row.id, row]),
  );
  const candidateByUid = new Map(candidateValue.chapters.map((row) => [row.chapterUid, row]));
  const basisById = new Map(basis.chapters.map((row) => [row.id, row]));
  const invalidations = [];
  for (const proposal of basis.pendingProposals) {
    const oldRow = basisById.get(proposal.chapterId);
    const assignment = assignmentById.get(proposal.chapterId);
    if (oldRow === undefined || assignment === undefined) invalid('pending proposal chapter mapping is incomplete');
    const nextRow = candidateByUid.get(assignment.uid);
    const oldPresent = basis.sourceKind === 'schema12' ? oldRow.isPresent === 1 : true;
    if (
      oldPresent
      && (
        nextRow === undefined
        || nextRow.bodyRawSha256 !== oldRow.bodyRawSha256
        || nextRow.status !== oldRow.status
      )
    ) {
      invalidations.push({
        revisionId: proposal.revisionId,
        chapterId: proposal.chapterId,
        from: 'pending',
        to: 'stale',
      });
    }
  }
  return invalidations.sort((left, right) => left.revisionId - right.revisionId);
}

function validateTargetRowVariants(rows, options) {
  const { activeKeys, tombstoneKeys, kind, label } = options;
  const ids = new Set();
  const uids = new Set();
  return assertDenseArray(rows, label).map((row, index) => {
    const rowLabel = `${label}[${index}]`;
    const present = dataDescriptors(row, rowLabel).is_present?.value;
    zeroOrOne(present, `${rowLabel}.is_present`);
    const normalized = normalizeRow(row, present === 0 ? tombstoneKeys : activeKeys, rowLabel);
    positiveInteger(normalized.id, `${rowLabel}.id`);
    const uidKey = kind === 'chapter' ? 'chapter_uid' : 'volume_uid';
    canonicalUuid(normalized[uidKey], `${rowLabel}.${uidKey}`);
    if (ids.has(normalized.id) || uids.has(normalized[uidKey])) invalid(`${label} contains duplicate identities`);
    ids.add(normalized.id);
    uids.add(normalized[uidKey]);
    if (present === 1 && normalized.deleted_at !== null) invalid(`${rowLabel} active row is deleted`);
    if (present === 0) canonicalTime(normalized.deleted_at, `${rowLabel}.deleted_at`);
    if (kind === 'volume' && present === 1) {
      positiveInteger(normalized.sort_order, `${rowLabel}.sort_order`);
      stringValue(normalized.title, `${rowLabel}.title`);
      stringValue(normalized.summary, `${rowLabel}.summary`);
    }
    if (kind === 'chapter') {
      positiveInteger(normalized.num, `${rowLabel}.num`);
      if (present === 0) {
        if (normalized.chapter_position !== null || normalized.manuscript_position !== null) {
          invalid(`${rowLabel} ref positions must be null`);
        }
      } else {
        if (normalized.volume_id !== null) positiveInteger(normalized.volume_id, `${rowLabel}.volume_id`);
        positiveInteger(normalized.chapter_position, `${rowLabel}.chapter_position`);
        positiveInteger(normalized.manuscript_position, `${rowLabel}.manuscript_position`);
        for (const key of [
          'title', 'outline', 'summary', 'cognitive_frame', 'emotional_anchor',
          'world_texture', 'concrete_mystery', 'interpersonal_tension',
        ]) stringValue(normalized[key], `${rowLabel}.${key}`);
        zeroOrOne(normalized.content_available, `${rowLabel}.content_available`);
        if (normalized.content_available === 1 ? typeof normalized.content !== 'string' : normalized.content !== null) {
          invalid(`${rowLabel}.content is inconsistent`);
        }
        nonNegativeInteger(normalized.word_count, `${rowLabel}.word_count`);
        if (!CHAPTER_STATUSES.has(normalized.status)) invalid(`${rowLabel}.status is invalid`);
        sha256(normalized.body_raw_sha256, `${rowLabel}.body_raw_sha256`);
        sha256(normalized.sidecar_raw_sha256, `${rowLabel}.sidecar_raw_sha256`);
      }
    }
    return normalized;
  });
}

function candidateFromTargetRows(basis, volumes, chapters, assignments) {
  const byKindUid = new Map(assignments.map((row) => [`${row.objectKind}:${row.uid}`, row]));
  const seen = new Set();
  for (const [kind, rows, uidKey] of [
    ['volume', volumes, 'volume_uid'],
    ['chapter', chapters, 'chapter_uid'],
  ]) {
    for (const row of rows) {
      const key = `${kind}:${row[uidKey]}`;
      const assignment = byKindUid.get(key);
      if (
        assignment === undefined
        || assignment.id !== row.id
        || (kind === 'chapter' && assignment.num !== row.num)
      ) invalid('projection target rows do not match localIdentityPlan');
      seen.add(key);
    }
  }
  if (seen.size !== assignments.length) invalid('localIdentityPlan contains no matching target row');
  const candidateValue = {
    volumes: volumes.filter((row) => row.is_present === 1)
      .map((row) => ({ volumeUid: row.volume_uid })),
    chapters: chapters.filter((row) => row.is_present === 1).map((row) => ({
      chapterUid: row.chapter_uid,
      bodyRawSha256: row.body_raw_sha256,
      status: row.status,
    })),
  };
  validateIdentityCoverage(basis, candidateValue, assignments);
  return candidateValue;
}

function assertContiguousPositions(values, label) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.some((value, index) => value !== index + 1)) {
    invalid(`${label} must be the exact range 1..N`);
  }
}

function validateTargetPositions(volumes, chapters) {
  const activeVolumes = volumes.filter((row) => row.is_present === 1);
  assertContiguousPositions(
    activeVolumes.map((row) => row.sort_order),
    'active volume sort_order',
  );
  const activeChapters = chapters.filter((row) => row.is_present === 1);
  assertContiguousPositions(
    activeChapters.map((row) => row.manuscript_position),
    'active chapter manuscript_position',
  );
  const byContainer = new Map();
  for (const row of activeChapters) {
    const key = row.volume_id === null ? 'unassigned' : `volume:${row.volume_id}`;
    const positions = byContainer.get(key) ?? [];
    positions.push(row.chapter_position);
    byContainer.set(key, positions);
  }
  for (const [key, positions] of byContainer) {
    assertContiguousPositions(positions, `active chapter ${key} chapter_position`);
  }
}

function validateTargetTombstoneTimes(basis, projectedAt, volumes, chapters) {
  for (const [kind, rows, basisRows, uidKey] of [
    ['volume', volumes, basis.volumes, 'volume_uid'],
    ['chapter', chapters, basis.chapters, 'chapter_uid'],
  ]) {
    for (const row of rows) {
      if (row.is_present !== 0) continue;
      const source = basis.sourceKind === 'schema12'
        ? basisRows.find((entry) => entry.uid === row[uidKey])
        : basisRows.find((entry) => entry.id === row.id);
      if (source === undefined) invalid(`${kind} tombstone has no projection-basis source`);
      const expected = basis.sourceKind === 'schema12' && source.isPresent === 0
        ? source.deletedAt
        : projectedAt;
      if (row.deleted_at !== expected) invalid(`${kind} tombstone deleted_at is inconsistent`);
    }
  }
}

function controlledFactKey(role, resourceUid) {
  return `${role}:${resourceUid ?? ''}`;
}

function validateControlledFileCoverage(controlledFiles, volumes, chapters) {
  const facts = new Map(
    controlledFiles.map((row) => [controlledFactKey(row.role, row.resourceUid), row]),
  );
  const expected = new Map([
    [controlledFactKey('manuscript', null), null],
    [controlledFactKey('unassigned', null), null],
  ]);
  for (const row of volumes) {
    if (row.is_present === 1) expected.set(controlledFactKey('volume_index', row.volume_uid), null);
  }
  for (const row of chapters) {
    if (row.is_present !== 1) continue;
    expected.set(controlledFactKey('chapter_body', row.chapter_uid), row.body_raw_sha256);
    expected.set(controlledFactKey('chapter_sidecar', row.chapter_uid), row.sidecar_raw_sha256);
  }
  if (facts.size !== expected.size) invalid('projection target controlledFiles coverage is inexact');
  for (const [key, expectedHash] of expected) {
    const fact = facts.get(key);
    if (fact === undefined) invalid('projection target controlledFiles coverage is incomplete');
    if (expectedHash !== null && fact.rawSha256 !== expectedHash) {
      invalid('projection target controlledFiles hash does not match its active chapter');
    }
  }
}

function normalizeTarget(target) {
  assertPlainTree(target, { requireFrozen: true, label: 'projection target' });
  const descriptors = assertExactKeys(target, TARGET_KEYS, 'projection target');
  if (descriptors.domain.value !== PROJECTION_TARGET_DOMAIN) invalid('projection target domain is invalid');
  if (descriptors.version.value !== PROJECTION_TARGET_VERSION) invalid('projection target version is invalid');
  canonicalUuid(descriptors.projectUid.value, 'projection target projectUid');
  canonicalUuid(descriptors.projectInstanceId.value, 'projection target projectInstanceId');
  const basis = normalizeBasis(descriptors.basis.value);
  const basisDigest = sha256(descriptors.basisDigest.value, 'projection target basisDigest');
  if (
    basisDigest !== basis.basisDigest
    || digestNormalizedBasis(basis) !== basisDigest
  ) invalid('projection target basis is inconsistent');
  const baseGeneration = nonNegativeInteger(descriptors.baseGeneration.value, 'projection target baseGeneration');
  const targetGeneration = nonNegativeInteger(descriptors.targetGeneration.value, 'projection target targetGeneration');
  if (baseGeneration !== basis.baseGeneration || targetGeneration <= baseGeneration) {
    invalid('projection target generations are inconsistent');
  }
  const projectedAt = canonicalTime(descriptors.projectedAt.value);
  const volumes = validateTargetRowVariants(descriptors.volumes.value, {
    activeKeys: ACTIVE_VOLUME_KEYS,
    tombstoneKeys: TOMBSTONE_VOLUME_KEYS,
    kind: 'volume',
    label: 'projection target volumes',
  });
  const chapters = validateTargetRowVariants(descriptors.chapters.value, {
    activeKeys: ACTIVE_CHAPTER_KEYS,
    tombstoneKeys: TOMBSTONE_CHAPTER_KEYS,
    kind: 'chapter',
    label: 'projection target chapters',
  });
  const activeVolumeIds = new Set(
    volumes.filter((row) => row.is_present === 1).map((row) => row.id),
  );
  const activeNums = new Set();
  for (const row of chapters) {
    if (row.is_present === 0) continue;
    if (row.volume_id !== null && !activeVolumeIds.has(row.volume_id)) {
      invalid('projection target chapter references a non-active volume');
    }
    const key = row.volume_id === null ? `unassigned:${row.num}` : `volume:${row.volume_id}:${row.num}`;
    if (activeNums.has(key)) invalid('projection target contains duplicate active chapter numbers');
    activeNums.add(key);
  }
  validateTargetPositions(volumes, chapters);
  const localIdentityPlan = normalizeIdentityPlan(descriptors.localIdentityPlan.value);
  const targetCandidate = candidateFromTargetRows(basis, volumes, chapters, localIdentityPlan);
  validateTargetTombstoneTimes(basis, projectedAt, volumes, chapters);
  const sequence = assertDenseArray(
    descriptors.sqliteSequence.value,
    'projection target sqliteSequence',
  ).map((row, index) => {
    const normalized = normalizeRow(row, ['name', 'seq'], `projection target sqliteSequence[${index}]`);
    if (normalized.name !== 'chapters' && normalized.name !== 'volumes') {
      invalid('projection target sqliteSequence name is invalid');
    }
    nonNegativeInteger(normalized.seq, `projection target sqliteSequence[${index}].seq`);
    return normalized;
  });
  if (JSON.stringify(sequence) !== JSON.stringify(targetSequence(basis, { volumes, chapters }))) {
    invalid('projection target sqliteSequence is inconsistent');
  }
  const controlledFiles = normalizeControlledFileFacts(
    descriptors.controlledFiles.value,
    'projection target controlledFiles',
  );
  if (controlledFiles.some((row, index) => row !== descriptors.controlledFiles.value[index])) {
    invalid('projection target controlledFiles are not canonically ordered');
  }
  validateControlledFileCoverage(controlledFiles, volumes, chapters);
  const ignoredLedger = normalizeIgnoredRows(
    descriptors.ignoredLedger.value,
    'projection target ignoredLedger',
  );
  if (ignoredLedger.some((row, index) => row !== descriptors.ignoredLedger.value[index])) {
    invalid('projection target ignoredLedger is not canonically ordered');
  }
  for (const row of ignoredLedger) {
    if (row.projection_generation !== targetGeneration) {
      invalid('projection target ignoredLedger generation is inconsistent');
    }
  }
  validateCapacitySnapshot(descriptors.capacitySnapshot.value, 'projection target capacitySnapshot');
  const proposalInvalidations = assertDenseArray(
    descriptors.proposalInvalidations.value,
    'projection target proposalInvalidations',
  ).map((entry, index) => {
    const row = normalizeRow(
      entry,
      ['revisionId', 'chapterId', 'from', 'to'],
      `projection target proposalInvalidations[${index}]`,
    );
    positiveInteger(row.revisionId, 'proposal invalidation revisionId');
    positiveInteger(row.chapterId, 'proposal invalidation chapterId');
    if (row.from !== 'pending' || row.to !== 'stale') invalid('proposal invalidation transition is invalid');
    return row;
  });
  const expectedInvalidations = deriveProposalInvalidations(basis, targetCandidate, localIdentityPlan);
  if (JSON.stringify(proposalInvalidations) !== JSON.stringify(expectedInvalidations)) {
    invalid('projection target proposalInvalidations are inconsistent');
  }
  return target;
}

class SQLiteProjectionStore {
  buildTarget(input) {
    const descriptors = assertExactKeys(input, BUILD_TARGET_KEYS, 'buildTarget input');
    const current = normalizeCurrentProjection(descriptors.currentProjection.value);
    const candidateValue = normalizeCandidate(descriptors.candidate.value);
    if (candidateValue.projectUid !== current.projectUid) invalid('candidate project UID does not match currentProjection');
    const targetGeneration = nonNegativeInteger(
      descriptors.targetGeneration.value,
      'targetGeneration',
    );
    if (targetGeneration <= current.basis.baseGeneration) invalid('targetGeneration must exceed the base generation');
    const projectedAt = canonicalTime(descriptors.projectedAt.value);
    assertPlainTree(descriptors.ignoredLedger.value, {
      requireFrozen: true,
      label: 'ignoredLedger',
    });
    const ignoredLedger = normalizeIgnoredRows(descriptors.ignoredLedger.value, 'ignoredLedger');
    for (const row of ignoredLedger) {
      if (row.projection_generation !== targetGeneration) {
        invalid('ignoredLedger rows must use the target generation');
      }
    }
    const localIdentityPlan = normalizeIdentityPlan(descriptors.localIdentityPlan.value);
    validateIdentityCoverage(
      current.basis,
      candidateValue,
      localIdentityPlan,
    );
    const rows = compileRows(
      current.basis,
      candidateValue,
      localIdentityPlan,
      projectedAt,
    );
    const proposalInvalidations = deriveProposalInvalidations(
      current.basis,
      candidateValue,
      localIdentityPlan,
    );
    const target = {
      domain: PROJECTION_TARGET_DOMAIN,
      version: PROJECTION_TARGET_VERSION,
      projectUid: current.projectUid,
      projectInstanceId: current.projectInstanceId,
      basis: current.basis,
      basisDigest: current.basis.basisDigest,
      baseGeneration: current.basis.baseGeneration,
      targetGeneration,
      projectedAt,
      volumes: rows.volumes,
      chapters: rows.chapters,
      sqliteSequence: targetSequence(current.basis, rows),
      controlledFiles: candidateValue.controlledFiles,
      ignoredLedger,
      capacitySnapshot: candidateValue.capacitySnapshot,
      proposalInvalidations,
      localIdentityPlan,
    };
    return normalizeTarget(deepFreeze(target));
  }

  validateTarget(target) {
    return normalizeTarget(target);
  }

  publish(input) {
    const allowed = Object.hasOwn(input ?? {}, 'routeCas')
      ? ['projectStore', 'target', 'routeCas']
      : ['projectStore', 'target'];
    const descriptors = assertExactKeys(input, allowed, 'publish input');
    const projectStore = descriptors.projectStore.value;
    if (
      (projectStore === null || (typeof projectStore !== 'object' && typeof projectStore !== 'function'))
      || typeof projectStore.publishProjectionTarget !== 'function'
    ) invalid('projectStore must expose publishProjectionTarget');
    const target = this.validateTarget(descriptors.target.value);
    if (Object.hasOwn(descriptors, 'routeCas')) {
      return projectStore.publishProjectionTarget({
        target,
        routeCas: descriptors.routeCas.value,
      });
    }
    return projectStore.publishProjectionTarget({ target });
  }
}

module.exports = {
  SQLiteProjectionStore,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
};
