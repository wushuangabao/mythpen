'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const {
  LIMITS,
  MANUSCRIPT_FORMAT_VERSION,
  assertCanonicalUuid,
  manuscriptError,
} = require('./contracts');
const { createCapacityAccumulator } = require('./capacity');
const {
  inspectMarkdown,
  parseCanonicalJson,
  serializeCanonicalJson,
} = require('./format');
const {
  IgnoredIdentityLedger,
  normalizeIgnoredLedgerRows,
} = require('./ignored-ledger');
const {
  assertInstalledOrphanBaselineAuthority,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
  canonicalSchema12ReuseIdentityPlan,
} = require('./projection-store');
const {
  requireFileBoundaryCapability,
  requireJournalAuthorityCapability,
} = require('./capability-registry');
const {
  assertControlledFileRef,
  classifyTreeEntry,
  createDirectoryNameIndex,
  deriveChapterPaths,
  deriveControlledFileRef,
  deriveManuscriptPaths,
  deriveVolumePath,
  verifyManuscriptPathIdentity,
} = require('./paths');
const {
  canonicalCreateLogicalInputDigest,
  validateIdentityReservationManifest,
  validateMigrationReservationManifest,
} = require('./uid-reservation');

const DIRECTORY_ROLES = Object.freeze(['mythpen', 'volumes', 'chapters']);
const ROLE_ORDER = Object.freeze({
  chapter_body: 0,
  chapter_sidecar: 1,
  volume_index: 2,
  unassigned: 3,
  manuscript: 4,
});
const SIDECAR_PATCH_FIELDS = new Set([
  'title',
  'outline',
  'status',
  'summary',
  'cognitive_frame',
  'emotional_anchor',
  'world_texture',
  'concrete_mystery',
  'interpersonal_tension',
]);
const VOLUME_PATCH_FIELDS = new Set(['title', 'summary']);
const MUTATION_FIELDS = Object.freeze({
  'chapter.replace_body': Object.freeze(['bodyRef', 'content']),
  'chapter.patch_sidecar': Object.freeze(['sidecarRef', 'patch']),
  'chapter.replace_body_and_sidecar': Object.freeze([
    'bodyRef', 'sidecarRef', 'content', 'patch',
  ]),
  'volume.patch_metadata': Object.freeze(['volumeRef', 'patch']),
  'chapter.move': Object.freeze(['chapterUid', 'targetVolumeUid', 'targetPosition']),
  'chapter.reorder': Object.freeze(['containerVolumeUid', 'chapterUids']),
  'volume.reorder': Object.freeze(['volumeUids']),
  'chapter.delete': Object.freeze(['chapterUid']),
  'volume.delete': Object.freeze(['volumeUid']),
  'ignored.preserve_move_to_unassigned': Object.freeze(['chapterUid']),
  'ignored.detach_reference': Object.freeze(['chapterUid']),
  'volume.create': Object.freeze(['title', 'summary']),
  'chapter.create': Object.freeze([
    'containerVolumeUid', 'requestedNum', 'content', 'sidecar',
  ]),
});
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CANONICAL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const storeRecords = new WeakMap();
const treeIdentityRecords = new WeakMap();
const validatedSnapshotRecords = new WeakMap();
const projectionCandidateRecords = new WeakMap();
const buildResultRecords = new WeakMap();
const orphanBaselineRecords = new WeakMap();
const orphanPreparedRecords = new WeakMap();
const ignoredIdentityLedger = new IgnoredIdentityLedger();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataDescriptors(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label} must contain enumerable string data properties only`);
    }
  }
  return descriptors;
}

function assertExactKeys(descriptors, expectedKeys, label) {
  const actual = Object.keys(descriptors).sort();
  const expected = expectedKeys.slice().sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function descriptorValue(descriptors, key) {
  return descriptors[key]?.value;
}

function snapshotIdentity(value, label) {
  const descriptors = dataDescriptors(value, label);
  assertExactKeys(descriptors, ['dev', 'ino'], label);
  const dev = descriptorValue(descriptors, 'dev');
  const ino = descriptorValue(descriptors, 'ino');
  if (
    typeof dev !== 'string'
    || !/^[0-9]+$/u.test(dev)
    || typeof ino !== 'string'
    || !/^[0-9]+$/u.test(ino)
  ) {
    throw new TypeError(`${label} must contain decimal dev and ino strings`);
  }
  return Object.freeze({ dev, ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new TypeError('binary data must remain private');
  }
  if (seen.has(value)) throw new TypeError('snapshot data must be acyclic');
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  seen.delete(value);
  return Object.freeze(value);
}

function assertDeepFrozenPlainData(value, label, active = new WeakSet()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number'
  ) return;
  if (
    typeof value !== 'object'
    || !Object.isFrozen(value)
    || active.has(value)
  ) {
    throw new TypeError(`${label} must be recursively frozen finite plain data`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${label} must contain plain data`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')
        ) {
          throw new TypeError(`${label} must contain dense data arrays`);
        }
        assertDeepFrozenPlainData(descriptor.value, `${label}[${index}]`, active);
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string'
          || !/^(0|[1-9][0-9]*)$/u.test(key)
          || Number(key) >= value.length
        ) throw new TypeError(`${label} contains an invalid array property`);
      }
      return;
    }
    const descriptors = dataDescriptors(value, label);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      assertDeepFrozenPlainData(descriptor.value, `${label}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function assertCanonicalDataRoot(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
  ) {
    throw new TypeError('dataRoot must be an absolute canonical path');
  }
  return value;
}

function snapshotProjectBinding(value) {
  const descriptors = dataDescriptors(value, 'projectBinding');
  assertExactKeys(descriptors, ['articleRootIdentity', 'projectUid'], 'projectBinding');
  return Object.freeze({
    articleRootIdentity: snapshotIdentity(
      descriptorValue(descriptors, 'articleRootIdentity'),
      'articleRootIdentity',
    ),
    projectUid: assertCanonicalUuid(descriptorValue(descriptors, 'projectUid'), 'project_uid'),
  });
}

function logicalRefKey(ref) {
  if (ref.role === 'manuscript' || ref.role === 'unassigned') return ref.role;
  if (ref.role === 'volume_index') return `${ref.role}:${ref.volumeUid}`;
  return `${ref.role}:${ref.chapterUid}`;
}

function resourceUid(ref) {
  return ref.volumeUid ?? ref.chapterUid ?? null;
}

function directoryRoleForRef(ref) {
  if (ref.role === 'manuscript' || ref.role === 'unassigned') return 'mythpen';
  if (ref.role === 'volume_index') return 'volumes';
  return 'chapters';
}

function refFromClassification(projectUid, classified) {
  if (classified.role === 'manuscript' || classified.role === 'unassigned') {
    return deriveControlledFileRef({ role: classified.role, projectUid });
  }
  if (classified.role === 'volume_index') {
    return deriveControlledFileRef({
      role: classified.role,
      projectUid,
      volumeUid: classified.volumeUid,
    });
  }
  return deriveControlledFileRef({
    role: classified.role,
    projectUid,
    chapterUid: classified.chapterUid,
  });
}

function sortFileFacts(left, right) {
  const roleDelta = ROLE_ORDER[left.role] - ROLE_ORDER[right.role];
  if (roleDelta !== 0) return roleDelta;
  return String(left.resourceUid || '').localeCompare(String(right.resourceUid || ''), 'en');
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sortCandidateFileFacts(left, right) {
  return (
    utf8Compare(left.role, right.role)
    || utf8Compare(left.resourceUid ?? '', right.resourceUid ?? '')
    || utf8Compare(left.rawSha256, right.rawSha256)
  );
}

function manuscriptFailure(code, details = {}) {
  throw manuscriptError(code, details);
}

function preserveKnownError(error, fallbackCode, details) {
  if (typeof error?.code === 'string' && error.code.startsWith('MANUSCRIPT_')) throw error;
  throw manuscriptError(fallbackCode, details, error);
}

function snapshotDirectoryInspection(value, directoryRole) {
  const descriptors = dataDescriptors(value, `${directoryRole} directory inspection`);
  assertExactKeys(
    descriptors,
    ['identity', 'kind', 'parentIdentity', 'safe'],
    `${directoryRole} directory inspection`,
  );
  const kind = descriptorValue(descriptors, 'kind');
  const safe = descriptorValue(descriptors, 'safe');
  if (kind !== 'directory' || typeof safe !== 'boolean') {
    throw new TypeError(`${directoryRole} directory inspection is invalid`);
  }
  if (!safe) manuscriptFailure('MANUSCRIPT_PATH_UNSAFE', { role: directoryRole });
  return Object.freeze({
    identity: snapshotIdentity(descriptorValue(descriptors, 'identity'), `${directoryRole}.identity`),
    kind,
    parentIdentity: snapshotIdentity(
      descriptorValue(descriptors, 'parentIdentity'),
      `${directoryRole}.parentIdentity`,
    ),
  });
}

function snapshotFileProbe(value, ref) {
  const descriptors = dataDescriptors(value, `${ref.role} file probe`);
  assertExactKeys(descriptors, [
    'actualName',
    'byteSize',
    'identity',
    'kind',
    'linkCount',
    'parentIdentity',
    'reparse',
    'safe',
  ], `${ref.role} file probe`);
  const actualName = descriptorValue(descriptors, 'actualName');
  const byteSize = descriptorValue(descriptors, 'byteSize');
  const kind = descriptorValue(descriptors, 'kind');
  const linkCount = descriptorValue(descriptors, 'linkCount');
  const reparse = descriptorValue(descriptors, 'reparse');
  const safe = descriptorValue(descriptors, 'safe');
  if (
    typeof actualName !== 'string'
    || actualName.length === 0
    || !Number.isSafeInteger(byteSize)
    || byteSize < 0
    || typeof reparse !== 'boolean'
    || typeof safe !== 'boolean'
  ) {
    throw new TypeError(`${ref.role} file probe is invalid`);
  }
  if (!safe || kind !== 'file' || reparse || linkCount !== 1) {
    manuscriptFailure('MANUSCRIPT_PATH_UNSAFE', { role: ref.role });
  }
  return Object.freeze({
    actualName,
    byteSize,
    identity: snapshotIdentity(descriptorValue(descriptors, 'identity'), `${ref.role}.identity`),
    parentIdentity: snapshotIdentity(
      descriptorValue(descriptors, 'parentIdentity'),
      `${ref.role}.parentIdentity`,
    ),
  });
}

function snapshotCandidateProof(value) {
  if (value === null) return null;
  const descriptors = dataDescriptors(value, 'journal candidate proof');
  assertExactKeys(descriptors, ['evidenceId', 'state'], 'journal candidate proof');
  const evidenceId = descriptorValue(descriptors, 'evidenceId');
  const state = descriptorValue(descriptors, 'state');
  if (
    typeof evidenceId !== 'string'
    || evidenceId.length === 0
    || (state !== 'open' && state !== 'terminal')
  ) {
    throw new TypeError('journal candidate proof is invalid');
  }
  return Object.freeze({ evidenceId, state });
}

function snapshotStringArray(value, role) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${role} must be a plain array`);
  }
  const seen = new Set();
  const result = [];
  for (const uid of value) {
    const canonical = assertCanonicalUuid(uid, role);
    if (seen.has(canonical)) manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role });
    seen.add(canonical);
    result.push(canonical);
  }
  return Object.freeze(result);
}

function snapshotLifecycleBasis(value) {
  const descriptors = dataDescriptors(value, 'lifecycleBasis');
  assertExactKeys(descriptors, [
    'activeChapterUids',
    'activeVolumeUids',
    'chapterTombstoneUids',
    'volumeTombstoneUids',
  ], 'lifecycleBasis');
  return Object.freeze({
    activeChapterUids: snapshotStringArray(
      descriptorValue(descriptors, 'activeChapterUids'),
      'active_chapter_uid',
    ),
    activeVolumeUids: snapshotStringArray(
      descriptorValue(descriptors, 'activeVolumeUids'),
      'active_volume_uid',
    ),
    chapterTombstoneUids: snapshotStringArray(
      descriptorValue(descriptors, 'chapterTombstoneUids'),
      'chapter_tombstone_uid',
    ),
    volumeTombstoneUids: snapshotStringArray(
      descriptorValue(descriptors, 'volumeTombstoneUids'),
      'volume_tombstone_uid',
    ),
  });
}

function snapshotIgnoredLedger(value) {
  const descriptors = dataDescriptors(value, 'ignoredLedger');
  assertExactKeys(descriptors, ['entries'], 'ignoredLedger');
  const entries = descriptorValue(descriptors, 'entries');
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) {
    throw new TypeError('ignoredLedger.entries must be a plain array');
  }
  const seen = new Set();
  const snapshot = entries.map((entry) => {
    const entryDescriptors = dataDescriptors(entry, 'ignored ledger entry');
    assertExactKeys(entryDescriptors, ['kind', 'status', 'uid'], 'ignored ledger entry');
    const kind = descriptorValue(entryDescriptors, 'kind');
    const status = descriptorValue(entryDescriptors, 'status');
    if (
      (kind !== 'chapter' && kind !== 'volume')
      || (status !== 'active' && status !== 'revoked')
    ) {
      throw new TypeError('ignored ledger entry kind or status is invalid');
    }
    const uid = assertCanonicalUuid(descriptorValue(entryDescriptors, 'uid'), `${kind}_uid`);
    const key = `${kind}:${uid}`;
    if (seen.has(key)) manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'ignored_ledger' });
    seen.add(key);
    return Object.freeze({ kind, status, uid });
  });
  return Object.freeze({ entries: Object.freeze(snapshot) });
}

function identitySets(lifecycleBasis) {
  return {
    chapter: new Set([
      ...lifecycleBasis.activeChapterUids,
      ...lifecycleBasis.chapterTombstoneUids,
    ]),
    volume: new Set([
      ...lifecycleBasis.activeVolumeUids,
      ...lifecycleBasis.volumeTombstoneUids,
    ]),
  };
}

function createAccumulator(record) {
  return createCapacityAccumulator(record.limits, record.capacityObserver);
}

async function inspectDirectories(record, binding, paths, scanEpoch) {
  const result = {};
  for (const directoryRole of ['article_root', ...DIRECTORY_ROLES]) {
    try {
      result[directoryRole] = snapshotDirectoryInspection(
        await record.fileBoundary.inspectDirectory({
          directoryRole,
          identity: binding,
          paths,
          scanEpoch,
        }),
        directoryRole,
      );
    } catch (error) {
      preserveKnownError(error, 'MANUSCRIPT_PATH_UNSAFE', { role: directoryRole });
    }
  }
  if (
    !sameIdentity(result.article_root.identity, binding.articleRootIdentity)
    || !sameIdentity(result.mythpen.parentIdentity, result.article_root.identity)
    || !sameIdentity(result.volumes.parentIdentity, result.mythpen.identity)
    || !sameIdentity(result.chapters.parentIdentity, result.mythpen.identity)
  ) {
    manuscriptFailure('MANUSCRIPT_PATH_UNSAFE', { role: 'manuscript_tree' });
  }
  return Object.freeze(result);
}

async function probeCanonicalFile(record, context, ref, actualName) {
  context.accumulator.recordIdentityProbe();
  let probe;
  try {
    probe = snapshotFileProbe(
      await record.fileBoundary.probeControlledFile({
        controlledFileRef: ref,
        identity: context.binding,
        paths: context.paths,
        scanEpoch: context.scanEpoch,
      }),
      ref,
    );
  } catch (error) {
    preserveKnownError(error, 'MANUSCRIPT_PATH_UNSAFE', { role: ref.role });
  }
  if (probe.actualName !== actualName) {
    manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: ref.role });
  }
  const expectedParentIdentity = context.directories[directoryRoleForRef(ref)].identity;
  if (!sameIdentity(probe.parentIdentity, expectedParentIdentity)) {
    manuscriptFailure('MANUSCRIPT_PATH_UNSAFE', { role: ref.role });
  }
  context.accumulator.recordFileMetadata({
    byteSize: probe.byteSize,
    kind: ref.role === 'chapter_body' ? 'markdown' : 'json',
  });
  return Object.freeze({
    actualName,
    byteSize: probe.byteSize,
    identity: probe.identity,
    parentIdentity: probe.parentIdentity,
    ref,
    resourceUid: resourceUid(ref),
    role: ref.role,
  });
}

async function classifyCandidate(record, context, directoryRole, actualName, classified) {
  const targetRef = refFromClassification(context.binding.projectUid, classified);
  const proof = snapshotCandidateProof(await record.journalAuthority.resolveCandidate({
    actualName,
    journalId: classified.journalId,
    projectUid: context.binding.projectUid,
    targetRef,
  }));
  if (proof === null) {
    context.residues.push(Object.freeze({
      actualName,
      directoryRole,
      reason: 'unowned_candidate',
    }));
    return;
  }
  context.journalCandidates.push(Object.freeze({
    actualName,
    directoryRole,
    evidenceId: proof.evidenceId,
    journalId: classified.journalId,
    state: proof.state,
    targetRef,
  }));
}

async function enumerateDirectory(record, context, directoryRole) {
  let iterable;
  try {
    iterable = record.fileBoundary.enumerateDirectory({
      directoryRole,
      expectedIdentity: context.directories[directoryRole].identity,
      identity: context.binding,
      paths: context.paths,
      scanEpoch: context.scanEpoch,
    });
  } catch (error) {
    preserveKnownError(error, 'MANUSCRIPT_PATH_UNSAFE', { role: directoryRole });
  }
  if (iterable === null || typeof iterable?.[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('fileBoundary.enumerateDirectory must return an async iterable');
  }
  const actualNames = [];
  try {
    for await (const actualName of iterable) {
      context.accumulator.recordDirectoryEntry({ chapterDirectory: directoryRole === 'chapters' });
      actualNames.push(actualName);
      if (
        directoryRole === 'mythpen'
        && (actualName === 'volumes' || actualName === 'chapters')
      ) {
        continue;
      }
      const classified = classifyTreeEntry({ directoryRole, actualName });
      if (classified.classification === 'canonical_shape') {
        const ref = refFromClassification(context.binding.projectUid, classified);
        const file = await probeCanonicalFile(record, context, ref, actualName);
        context.canonicalFiles.push(file);
        context.filesByKey.set(logicalRefKey(ref), file);
      } else if (classified.classification === 'journal_candidate_shape') {
        await classifyCandidate(record, context, directoryRole, actualName, classified);
      } else {
        context.residues.push(Object.freeze({
          actualName,
          directoryRole,
          reason: 'unknown_shape',
        }));
      }
    }
  } catch (error) {
    preserveKnownError(error, 'MANUSCRIPT_PATH_UNSAFE', { role: directoryRole });
  }
  const nameIndex = createDirectoryNameIndex({
    actualNames,
    directoryRole,
    parentIdentity: context.directories[directoryRole].identity,
    paths: context.paths,
    scanEpoch: context.scanEpoch,
  });
  if (
    directoryRole === 'mythpen'
    && (!actualNames.includes('volumes') || !actualNames.includes('chapters'))
  ) {
    manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'mythpen' });
  }
  context.nameIndexes[directoryRole] = nameIndex;
}

function verifyCanonicalFiles(record, context) {
  const identityBoundary = {
    inspectPath: record.fileBoundary.inspectPath,
    listActualNames: record.fileBoundary.listActualNames,
  };
  for (const file of context.canonicalFiles) {
    verifyManuscriptPathIdentity({
      controlledFileRef: file.ref,
      directoryNameIndex: context.nameIndexes[directoryRoleForRef(file.ref)],
      expectedIdentity: file.identity,
      expectedParentIdentity: file.parentIdentity,
      identityBoundary,
      paths: context.paths,
      scanEpoch: context.scanEpoch,
      targetRole: 'controlled_file',
    });
  }
}

async function enumerateInternal(store, bindingValue, accumulator) {
  const record = storeRecords.get(store);
  const binding = snapshotProjectBinding(bindingValue);
  const paths = deriveManuscriptPaths({
    dataRoot: record.dataRoot,
    projectUid: binding.projectUid,
  });
  const scanEpoch = record.nextScanEpoch;
  record.nextScanEpoch += 1;
  const context = {
    accumulator,
    binding,
    canonicalFiles: [],
    directories: await inspectDirectories(record, binding, paths, scanEpoch),
    filesByKey: new Map(),
    journalCandidates: [],
    nameIndexes: {},
    paths,
    residues: [],
    scanEpoch,
  };
  for (const directoryRole of DIRECTORY_ROLES) {
    await enumerateDirectory(record, context, directoryRole);
  }
  verifyCanonicalFiles(record, context);

  context.canonicalFiles.sort(sortFileFacts);
  const treeIdentity = Object.freeze({
    projectUid: binding.projectUid,
    scanEpoch,
  });
  const treeRecord = { ...context, store, enumerationSnapshot: null };
  treeIdentityRecords.set(treeIdentity, treeRecord);
  const capacitySnapshot = accumulator.snapshot();
  const snapshot = deepFreeze({
    canonicalShapes: context.canonicalFiles.map((file) => ({ ...file })),
    capacitySnapshot,
    classifications: {
      journalCandidates: context.journalCandidates.map((entry) => ({ ...entry })),
      residues: context.residues.map((entry) => ({ ...entry })),
    },
    nameIndexStats: {
      chapters: { ...context.nameIndexes.chapters },
      mythpen: { ...context.nameIndexes.mythpen },
      volumes: { ...context.nameIndexes.volumes },
    },
    projectUid: binding.projectUid,
    treeIdentity,
  });
  treeRecord.enumerationSnapshot = snapshot;
  return { context, snapshot };
}

function expectedUidForRef(ref) {
  if (ref.role === 'manuscript') return ref.projectUid;
  if (ref.role === 'volume_index') return ref.volumeUid;
  if (ref.role === 'chapter_sidecar') return ref.chapterUid;
  return undefined;
}

function snapshotReadResult(value, descriptor) {
  const descriptors = dataDescriptors(value, `${descriptor.role} read result`);
  assertExactKeys(descriptors, [
    'byteSize',
    'bytes',
    'identity',
    'parentIdentity',
    'stable',
  ], `${descriptor.role} read result`);
  const bytesValue = descriptorValue(descriptors, 'bytes');
  const bytes = Buffer.isBuffer(bytesValue) || bytesValue instanceof Uint8Array
    ? Buffer.from(bytesValue)
    : null;
  const byteSize = descriptorValue(descriptors, 'byteSize');
  const stable = descriptorValue(descriptors, 'stable');
  if (
    bytes === null
    || !Number.isSafeInteger(byteSize)
    || byteSize < 0
    || typeof stable !== 'boolean'
  ) {
    throw new TypeError(`${descriptor.role} read result is invalid`);
  }
  return {
    byteSize,
    bytes,
    identity: snapshotIdentity(descriptorValue(descriptors, 'identity'), 'read identity'),
    parentIdentity: snapshotIdentity(
      descriptorValue(descriptors, 'parentIdentity'),
      'read parent identity',
    ),
    stable,
  };
}

function publicControlledFileSnapshot(descriptor, rawSha256, parsed) {
  return deepFreeze({
    byteSize: descriptor.byteSize,
    fileIdentity: { ...descriptor.identity },
    parentIdentity: { ...descriptor.parentIdentity },
    parsed,
    rawSha256,
    ref: descriptor.ref,
    resourceUid: descriptor.resourceUid,
    role: descriptor.role,
  });
}

function knownResourceOrExternal(uid, knownSet, activeIgnoredSet, kind) {
  if (!knownSet.has(uid) && !activeIgnoredSet.has(`${kind}:${uid}`)) {
    manuscriptFailure('EXTERNAL_RESOURCE_CREATION_UNSUPPORTED', { kind, uid });
  }
}

function fileMetadataFromSnapshot(snapshot) {
  return Object.freeze({
    byteSize: snapshot.byteSize,
    fileIdentity: snapshot.fileIdentity,
    parentIdentity: snapshot.parentIdentity,
    rawSha256: snapshot.rawSha256,
    ref: snapshot.ref,
    resourceUid: snapshot.resourceUid,
    role: snapshot.role,
  });
}

function ignoredReference(entry, indexedContainer) {
  if (indexedContainer === null) {
    return Object.freeze({
      containerKind: null,
      containerUid: null,
      state: 'detached',
    });
  }
  if (entry.kind === 'volume') {
    if (indexedContainer.kind !== 'manuscript' || indexedContainer.uid !== null) {
      throw new TypeError('ignored volume reference must use the manuscript container');
    }
  } else if (
    (indexedContainer.kind !== 'unassigned' || indexedContainer.uid !== null)
    && (
      indexedContainer.kind !== 'volume'
      || assertCanonicalUuid(indexedContainer.uid, 'volume_uid') !== indexedContainer.uid
    )
  ) {
    throw new TypeError('ignored chapter reference has an invalid container');
  }
  return Object.freeze({
    containerKind: indexedContainer.kind,
    containerUid: indexedContainer.uid,
    state: 'indexed',
  });
}

function ignoredObservation(entry, filesByKey, indexedContainer) {
  const roles = entry.kind === 'chapter'
    ? ['chapter_body', 'chapter_sidecar']
    : ['volume_index'];
  const members = roles.map((role) => {
    const key = `${role}:${entry.uid}`;
    const file = filesByKey.get(key);
    if (file === undefined) return Object.freeze({ present: false, role });
    return Object.freeze({
      byteSize: file.byteSize,
      fileIdentity: file.identity,
      parentIdentity: file.parentIdentity,
      present: true,
      role,
    });
  });
  return deepFreeze({
    kind: entry.kind,
    members,
    reference: ignoredReference(entry, indexedContainer),
    status: entry.status,
    uid: entry.uid,
  });
}

async function readControlledFileInternal(store, identity, controlledFileRef) {
  const context = treeIdentityRecords.get(identity);
  if (context === undefined || context.store !== store) {
    throw new TypeError('identity must be a tree identity produced by this ManuscriptStore');
  }
  const ref = assertControlledFileRef(controlledFileRef);
  if (ref.projectUid !== context.binding.projectUid) {
    throw new TypeError('controlledFileRef belongs to another project');
  }
  const descriptor = context.filesByKey.get(logicalRefKey(ref));
  if (descriptor === undefined) {
    throw new TypeError('controlledFileRef is not a canonical shape in this tree identity');
  }
  context.accumulator.recordContentOpen();
  let read;
  try {
    read = snapshotReadResult(
      await storeRecords.get(store).fileBoundary.readControlledFile({
        controlledFileRef: ref,
        expected: descriptor,
        identity: context.binding,
        paths: context.paths,
        scanEpoch: context.scanEpoch,
      }),
      descriptor,
    );
  } catch (error) {
    preserveKnownError(error, 'MANUSCRIPT_TREE_CHANGED_DURING_READ', { role: ref.role });
  }
  context.accumulator.recordContentBytes(read.bytes.length);
  if (
    !read.stable
    || read.byteSize !== descriptor.byteSize
    || read.bytes.length !== descriptor.byteSize
    || !sameIdentity(read.identity, descriptor.identity)
    || !sameIdentity(read.parentIdentity, descriptor.parentIdentity)
  ) {
    manuscriptFailure('MANUSCRIPT_TREE_CHANGED_DURING_READ', { role: ref.role });
  }
  const bytes = read.bytes;
  let parsed;
  let rawSha256;
  if (ref.role === 'chapter_body') {
    parsed = inspectMarkdown(bytes);
    rawSha256 = parsed.rawSha256;
  } else {
    rawSha256 = createHash('sha256').update(bytes).digest('hex');
    parsed = parseCanonicalJson({
      bytes,
      expectedUid: expectedUidForRef(ref),
      role: ref.role,
    });
  }
  deepFreeze(parsed);
  return Object.freeze({
    bytes,
    snapshot: publicControlledFileSnapshot(descriptor, rawSha256, parsed),
  });
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotPatch(value, allowedFields, label) {
  const descriptors = dataDescriptors(value, label);
  const patch = {};
  for (const key of Object.keys(descriptors)) {
    if (!allowedFields.has(key)) throw new TypeError(`${label} contains an unsupported field`);
    patch[key] = descriptorValue(descriptors, key);
  }
  return patch;
}

function validatedFileForRef(validated, value, expectedRole, projectUid) {
  const ref = assertControlledFileRef(value);
  if (ref.role !== expectedRole || ref.projectUid !== projectUid) {
    throw new TypeError(`mutation ref must be a ${expectedRole} in the validated project`);
  }
  let snapshot;
  if (expectedRole === 'chapter_body') snapshot = validated.bodySnapshots.get(ref.chapterUid);
  else if (expectedRole === 'chapter_sidecar') snapshot = validated.sidecarSnapshots.get(ref.chapterUid);
  else snapshot = validated.volumeSnapshots.get(ref.volumeUid);
  if (snapshot === undefined) {
    throw new TypeError('mutation ref is not an active controlled file in the validated snapshot');
  }
  return snapshot;
}

function compileBodyChange(before, content) {
  if (before.parsed.mode !== 'visual') {
    manuscriptFailure('UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE', {
      chapterUid: before.resourceUid,
    });
  }
  const compiled = compileWritableBody(content, before.resourceUid);
  if (compiled.afterParsed.rawSha256 === before.rawSha256) return null;
  return Object.freeze({
    ...compiled,
    before,
    rawSha256: compiled.afterParsed.rawSha256,
  });
}

function compileWritableBody(content, chapterUid) {
  if (typeof content !== 'string') throw new TypeError('body content must be a string');
  const afterBytes = Buffer.from(content, 'utf8');
  const afterParsed = inspectMarkdown(afterBytes);
  if (
    afterParsed.mode !== 'visual'
    || afterParsed.contentAvailable !== true
    || afterParsed.content !== content
  ) {
    manuscriptFailure('UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE', {
      chapterUid,
    });
  }
  return Object.freeze({
    afterBytes,
    afterParsed: deepFreeze(afterParsed),
  });
}

function compileJsonChange(before, patchValue, allowedFields) {
  const patch = snapshotPatch(patchValue, allowedFields, `${before.role} patch`);
  const afterParsed = { ...before.parsed, ...patch };
  const afterBytes = serializeCanonicalJson(before.role, afterParsed);
  const rawSha256 = hashBytes(afterBytes);
  if (rawSha256 === before.rawSha256) return null;
  return Object.freeze({
    afterBytes,
    afterParsed: deepFreeze(afterParsed),
    before,
    rawSha256,
  });
}

function snapshotDenseUidArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const seen = new Set();
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label} must be a dense data array`);
    }
    const uid = assertCanonicalUuid(descriptor.value, `${label}[${index}]`);
    if (seen.has(uid)) throw new TypeError(`${label} contains a duplicate UID`);
    seen.add(uid);
    result.push(uid);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string'
      || !/^(0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= value.length
    ) {
      throw new TypeError(`${label} contains an invalid array property`);
    }
  }
  return Object.freeze(result);
}

function assertPermutation(actual, expected, label) {
  if (actual.length !== expected.length) {
    throw new TypeError(`${label} must be the complete known active permutation`);
  }
  const expectedSet = new Set(expected);
  if (actual.some((uid) => !expectedSet.has(uid))) {
    throw new TypeError(`${label} must be the complete known active permutation`);
  }
}

function indexChange(before, afterParsed) {
  const afterBytes = serializeCanonicalJson(before.role, afterParsed);
  const rawSha256 = hashBytes(afterBytes);
  if (rawSha256 === before.rawSha256) return null;
  return Object.freeze({
    afterBytes,
    afterParsed: deepFreeze(afterParsed),
    before,
    rawSha256,
  });
}

function deleteChange(before) {
  return Object.freeze({
    afterBytes: null,
    afterParsed: null,
    before,
    rawSha256: null,
  });
}

function createChange(ref, parentIdentity, afterBytes, afterParsed) {
  const before = deepFreeze({
    byteSize: 0,
    fileIdentity: null,
    parentIdentity,
    parsed: null,
    rawSha256: null,
    ref,
    resourceUid: resourceUid(ref),
    role: ref.role,
  });
  return Object.freeze({
    afterBytes,
    afterParsed: deepFreeze(afterParsed),
    before,
    beforeAbsent: true,
    rawSha256: hashBytes(afterBytes),
  });
}

function validatedCreateReservation(value, kind, projectUid, descriptors, pathContext) {
  assertDeepFrozenPlainData(value, 'identityReservation');
  const reservation = validateIdentityReservationManifest(value);
  const objectKind = kind === 'volume.create' ? 'volume' : 'chapter';
  if (reservation.objectKind !== objectKind || reservation.projectUid !== projectUid) {
    throw new TypeError('identity reservation does not match the create mutation project or kind');
  }
  const command = kind === 'volume.create'
    ? {
      kind,
      title: descriptorValue(descriptors, 'title'),
      summary: descriptorValue(descriptors, 'summary'),
    }
    : {
      kind,
      containerVolumeUid: descriptorValue(descriptors, 'containerVolumeUid'),
      requestedNum: descriptorValue(descriptors, 'requestedNum'),
      content: descriptorValue(descriptors, 'content'),
      sidecar: descriptorValue(descriptors, 'sidecar'),
    };
  if (canonicalCreateLogicalInputDigest(command) !== reservation.logicalInputDigest) {
    throw new TypeError('identity reservation logical input does not match the create mutation');
  }
  const expectedPaths = reservation.objectKind === 'volume'
    ? new Map([['volume_index', deriveVolumePath(pathContext.paths, reservation.uid)]])
    : (() => {
      const paths = deriveChapterPaths(pathContext.paths, reservation.uid);
      return new Map([
        ['chapter_body', paths.bodyPath],
        ['chapter_sidecar', paths.sidecarPath],
      ]);
    })();
  const expectedParentIdentity = reservation.objectKind === 'volume'
    ? pathContext.directories.volumes.identity
    : pathContext.directories.chapters.identity;
  for (const predicate of reservation.pathPredicates) {
    if (
      predicate.canonicalPath !== expectedPaths.get(predicate.role)
      || !sameIdentity(predicate.parentIdentity, expectedParentIdentity)
    ) {
      throw new TypeError('identity reservation path predicate does not match the validated tree');
    }
  }
  if (objectKind === 'chapter') {
    const containerVolumeUid = descriptorValue(descriptors, 'containerVolumeUid');
    const requestedNum = descriptorValue(descriptors, 'requestedNum');
    if (
      reservation.containerVolumeUid !== containerVolumeUid
      || reservation.requestedNum !== requestedNum
    ) {
      throw new TypeError('identity reservation does not match the chapter allocation');
    }
  }
  return reservation;
}

function knownChapterOrders(validated) {
  const result = new Map();
  for (const volumeUid of validated.volumeOrder) {
    result.set(volumeUid, validated.volumeSnapshots.get(volumeUid).parsed.chapter_uids.filter(
      (chapterUid) => validated.chapterContainers.get(chapterUid)?.volumeUid === volumeUid,
    ));
  }
  result.set(null, validated.unassigned.parsed.chapter_uids.filter(
    (chapterUid) => validated.chapterContainers.get(chapterUid)?.kind === 'unassigned',
  ));
  return result;
}

function assertIgnoredRowsMatchSnapshot(validated, value) {
  const rows = normalizeIgnoredLedgerRows(value, 'ignoredRows');
  const baseGeneration = rows.length === 0 ? -1 : rows[0].projection_generation;
  for (const row of rows) {
    if (row.projection_generation !== baseGeneration) {
      throw new TypeError('ignoredRows must use one projection generation');
    }
  }
  const targetGeneration = baseGeneration + 1;
  const observedRows = ignoredIdentityLedger.compileAfter({
    beforeRows: rows,
    observations: validated.ignoredMemberObservations,
    targetGeneration,
  });
  for (let index = 0; index < rows.length; index += 1) {
    const before = rows[index];
    const observed = observedRows[index];
    if (
      before.resource_kind !== observed.resource_kind
      || before.resource_uid !== observed.resource_uid
      || before.ignore_status !== observed.ignore_status
      || before.opaque_container_kind !== observed.opaque_container_kind
      || before.opaque_container_uid !== observed.opaque_container_uid
      || before.is_currently_referenced !== observed.is_currently_referenced
      || before.member_snapshot_json !== observed.member_snapshot_json
    ) {
      throw new TypeError('ignoredRows do not exactly match snapshot observations');
    }
  }
  return rows;
}

function compileMutation(
  validated,
  projectUid,
  value,
  rows,
  identityReservation,
  pathContext,
) {
  const descriptors = dataDescriptors(value, 'mutation');
  const kind = descriptorValue(descriptors, 'kind');
  const fields = MUTATION_FIELDS[kind];
  if (fields === undefined) {
    throw new TypeError('mutation kind is not supported by the Task 10B1 closure compiler');
  }
  assertExactKeys(descriptors, ['kind', ...fields], 'mutation');
  const isCreate = kind === 'volume.create' || kind === 'chapter.create';
  const reservation = isCreate
    ? validatedCreateReservation(
      identityReservation,
      kind,
      projectUid,
      descriptors,
      pathContext,
    )
    : null;
  if (!isCreate && identityReservation !== null) {
    throw new TypeError('non-create mutation identityReservation must be null');
  }
  if (isCreate && validated.ignoredMemberObservations.some((observation) => (
    observation.kind === reservation.objectKind && observation.uid === reservation.uid
  ))) {
    throw new TypeError('create identity reservation overlaps an ignored identity');
  }

  const structure = {
    chapterOrders: knownChapterOrders(validated),
    created: null,
    ignoredObservations: validated.ignoredMemberObservations,
    referenceTransition: null,
    volumeOrder: [...validated.volumeOrder],
  };
  const changesByKey = new Map();
  const writeIndexes = new Set();
  const volumePatches = new Map();
  function recordChange(change) {
    if (change === null) return;
    const key = logicalRefKey(change.before.ref);
    if (changesByKey.has(key)) throw new TypeError('mutation compiled a duplicate ref');
    changesByKey.set(key, change);
  }
  function requireVolume(volumeUid, label) {
    const uid = assertCanonicalUuid(volumeUid, label);
    if (!structure.volumeOrder.includes(uid)) throw new TypeError(`${label} is not active`);
    return uid;
  }
  function locateChapter(chapterUid) {
    const uid = assertCanonicalUuid(chapterUid, 'chapter_uid');
    for (const [containerUid, members] of structure.chapterOrders) {
      const position = members.indexOf(uid);
      if (position !== -1) return { containerUid, members, position, uid };
    }
    throw new TypeError('chapter_uid is not active');
  }
  function indexKey(containerUid) {
    return containerUid === null ? 'unassigned' : `volume_index:${containerUid}`;
  }

  if (kind === 'volume.create') {
    const title = descriptorValue(descriptors, 'title');
    const summary = descriptorValue(descriptors, 'summary');
    if (structure.volumeOrder.includes(reservation.uid)) {
      throw new TypeError('volume create reservation UID is already active');
    }
    structure.volumeOrder.push(reservation.uid);
    structure.chapterOrders.set(reservation.uid, []);
    structure.created = Object.freeze({
      kind: 'volume',
      reservation,
      summary,
      title,
    });
    writeIndexes.add(`volume_index:${reservation.uid}`);
    writeIndexes.add('manuscript');
  } else if (kind === 'chapter.create') {
    const containerVolumeUid = descriptorValue(descriptors, 'containerVolumeUid');
    const content = descriptorValue(descriptors, 'content');
    if (containerVolumeUid !== null) requireVolume(containerVolumeUid, 'container_volume_uid');
    const sidecar = snapshotPatch(
      descriptorValue(descriptors, 'sidecar'),
      SIDECAR_PATCH_FIELDS,
      'chapter create sidecar',
    );
    if ([...structure.chapterOrders.values()].some((members) => (
      members.includes(reservation.uid)
    ))) {
      throw new TypeError('chapter create reservation UID is already active');
    }
    const body = compileWritableBody(content, reservation.uid);
    const sidecarParsed = {
      format_version: MANUSCRIPT_FORMAT_VERSION,
      chapter_uid: reservation.uid,
      ...sidecar,
    };
    const sidecarBytes = serializeCanonicalJson('chapter_sidecar', sidecarParsed);
    const predicateByRole = new Map(reservation.pathPredicates.map((predicate) => [
      predicate.role,
      predicate,
    ]));
    recordChange(createChange(
      deriveControlledFileRef({
        role: 'chapter_body',
        projectUid,
        chapterUid: reservation.uid,
      }),
      predicateByRole.get('chapter_body').parentIdentity,
      body.afterBytes,
      body.afterParsed,
    ));
    recordChange(createChange(
      deriveControlledFileRef({
        role: 'chapter_sidecar',
        projectUid,
        chapterUid: reservation.uid,
      }),
      predicateByRole.get('chapter_sidecar').parentIdentity,
      sidecarBytes,
      sidecarParsed,
    ));
    structure.chapterOrders.get(containerVolumeUid).push(reservation.uid);
    structure.created = Object.freeze({
      kind: 'chapter',
      reservation,
    });
    writeIndexes.add(indexKey(containerVolumeUid));
  } else if (
    kind === 'chapter.replace_body'
    || kind === 'chapter.patch_sidecar'
    || kind === 'chapter.replace_body_and_sidecar'
  ) {
    const body = fields.includes('bodyRef')
      ? validatedFileForRef(
        validated,
        descriptorValue(descriptors, 'bodyRef'),
        'chapter_body',
        projectUid,
      )
      : null;
    const sidecar = fields.includes('sidecarRef')
      ? validatedFileForRef(
        validated,
        descriptorValue(descriptors, 'sidecarRef'),
        'chapter_sidecar',
        projectUid,
      )
      : null;
    if (body !== null && sidecar !== null && body.resourceUid !== sidecar.resourceUid) {
      throw new TypeError('combined body and sidecar refs must name the same chapter');
    }
    recordChange(body === null
      ? null
      : compileBodyChange(body, descriptorValue(descriptors, 'content')));
    recordChange(sidecar === null
      ? null
      : compileJsonChange(
        sidecar,
        descriptorValue(descriptors, 'patch'),
        SIDECAR_PATCH_FIELDS,
      ));
  } else if (kind === 'volume.patch_metadata') {
    const volume = validatedFileForRef(
      validated,
      descriptorValue(descriptors, 'volumeRef'),
      'volume_index',
      projectUid,
    );
    volumePatches.set(
      volume.resourceUid,
      snapshotPatch(
        descriptorValue(descriptors, 'patch'),
        VOLUME_PATCH_FIELDS,
        'volume_index patch',
      ),
    );
    writeIndexes.add(`volume_index:${volume.resourceUid}`);
  } else if (kind === 'chapter.move') {
    const chapter = locateChapter(descriptorValue(descriptors, 'chapterUid'));
    const targetValue = descriptorValue(descriptors, 'targetVolumeUid');
    const targetVolumeUid = targetValue === null
      ? null
      : requireVolume(targetValue, 'target_volume_uid');
    if (chapter.containerUid === targetVolumeUid) {
      throw new TypeError('chapter.move source and target containers must differ');
    }
    const targetPosition = descriptorValue(descriptors, 'targetPosition');
    const targetMembers = structure.chapterOrders.get(targetVolumeUid);
    if (
      !Number.isSafeInteger(targetPosition)
      || Object.is(targetPosition, -0)
      || targetPosition < 0
      || targetPosition > targetMembers.length
    ) {
      throw new TypeError('chapter.move targetPosition is outside the target known length');
    }
    chapter.members.splice(chapter.position, 1);
    targetMembers.splice(targetPosition, 0, chapter.uid);
    writeIndexes.add(indexKey(chapter.containerUid));
    writeIndexes.add(indexKey(targetVolumeUid));
  } else if (kind === 'chapter.reorder') {
    const containerValue = descriptorValue(descriptors, 'containerVolumeUid');
    const containerUid = containerValue === null
      ? null
      : requireVolume(containerValue, 'container_volume_uid');
    const requested = snapshotDenseUidArray(
      descriptorValue(descriptors, 'chapterUids'),
      'chapterUids',
    );
    assertPermutation(requested, structure.chapterOrders.get(containerUid), 'chapterUids');
    structure.chapterOrders.set(containerUid, [...requested]);
    writeIndexes.add(indexKey(containerUid));
  } else if (kind === 'volume.reorder') {
    const requested = snapshotDenseUidArray(
      descriptorValue(descriptors, 'volumeUids'),
      'volumeUids',
    );
    assertPermutation(requested, structure.volumeOrder, 'volumeUids');
    structure.volumeOrder = [...requested];
    writeIndexes.add('manuscript');
  } else if (kind === 'chapter.delete') {
    const chapter = locateChapter(descriptorValue(descriptors, 'chapterUid'));
    chapter.members.splice(chapter.position, 1);
    writeIndexes.add(indexKey(chapter.containerUid));
    recordChange(deleteChange(validated.bodySnapshots.get(chapter.uid)));
    recordChange(deleteChange(validated.sidecarSnapshots.get(chapter.uid)));
  } else if (kind === 'volume.delete') {
    const volumeUid = requireVolume(descriptorValue(descriptors, 'volumeUid'), 'volume_uid');
    if (rows.some((row) => (
      row.resource_kind === 'chapter'
      && row.ignore_status === 'active'
      && row.is_currently_referenced === 1
      && row.opaque_container_kind === 'volume'
      && row.opaque_container_uid === volumeUid
    ))) {
      manuscriptFailure('IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE', { volumeUid });
    }
    const childUids = structure.chapterOrders.get(volumeUid);
    for (const chapterUid of childUids) {
      recordChange(deleteChange(validated.bodySnapshots.get(chapterUid)));
      recordChange(deleteChange(validated.sidecarSnapshots.get(chapterUid)));
    }
    structure.chapterOrders.delete(volumeUid);
    structure.volumeOrder.splice(structure.volumeOrder.indexOf(volumeUid), 1);
    recordChange(deleteChange(validated.volumeSnapshots.get(volumeUid)));
    writeIndexes.add('manuscript');
  } else {
    const chapterUid = assertCanonicalUuid(
      descriptorValue(descriptors, 'chapterUid'),
      'chapter_uid',
    );
    const observation = validated.ignoredMemberObservations.find((current) => (
      current.kind === 'chapter' && current.uid === chapterUid
    ));
    if (observation === undefined) throw new TypeError('ignored action chapter is not observed');
    const transition = ignoredIdentityLedger.createReferenceTransition({
      action: Object.freeze({ kind, chapterUid }),
      observation,
      rows,
    });
    structure.referenceTransition = transition;
    const fromKey = indexKey(transition.fromContainer.uid);
    writeIndexes.add(fromKey);
    if (transition.toContainer !== null) writeIndexes.add('unassigned');
    structure.ignoredObservations = validated.ignoredMemberObservations.map((current) => {
      if (current.kind !== 'chapter' || current.uid !== chapterUid) return current;
      const reference = transition.toContainer === null
        ? { state: 'detached', containerKind: null, containerUid: null }
        : {
          state: 'indexed',
          containerKind: transition.toContainer.kind,
          containerUid: transition.toContainer.uid,
        };
      return deepFreeze({ ...current, reference });
    });
  }

  function serializedMembers(container, knownMembers) {
    return ignoredIdentityLedger.serializeOpaqueMembers({
      container: Object.freeze(container),
      knownMembers: Object.freeze([...knownMembers]),
      rows,
      referenceTransition: structure.referenceTransition,
    });
  }
  for (const key of writeIndexes) {
    if (key === 'manuscript') {
      const before = validated.manuscript;
      recordChange(indexChange(before, {
        ...before.parsed,
        volume_uids: serializedMembers(
          { kind: 'manuscript', uid: null },
          structure.volumeOrder,
        ),
      }));
    } else if (key === 'unassigned') {
      const before = validated.unassigned;
      recordChange(indexChange(before, {
        ...before.parsed,
        chapter_uids: serializedMembers(
          { kind: 'unassigned', uid: null },
          structure.chapterOrders.get(null),
        ),
      }));
    } else {
      const volumeUid = key.slice('volume_index:'.length);
      if (structure.created?.kind === 'volume' && structure.created.reservation.uid === volumeUid) {
        const parsed = {
          format_version: MANUSCRIPT_FORMAT_VERSION,
          volume_uid: volumeUid,
          title: structure.created.title,
          summary: structure.created.summary,
          chapter_uids: serializedMembers(
            { kind: 'volume', uid: volumeUid },
            structure.chapterOrders.get(volumeUid),
          ),
        };
        const bytes = serializeCanonicalJson('volume_index', parsed);
        const predicate = structure.created.reservation.pathPredicates[0];
        recordChange(createChange(
          deriveControlledFileRef({ role: 'volume_index', projectUid, volumeUid }),
          predicate.parentIdentity,
          bytes,
          parsed,
        ));
        continue;
      }
      const before = validated.volumeSnapshots.get(volumeUid);
      const patch = volumePatches.get(volumeUid) ?? {};
      recordChange(indexChange(before, {
        ...before.parsed,
        ...patch,
        chapter_uids: serializedMembers(
          { kind: 'volume', uid: volumeUid },
          structure.chapterOrders.get(volumeUid),
        ),
      }));
    }
  }

  return {
    changes: [...changesByKey.values()].sort((left, right) => (
      sortFileFacts(left.before, right.before)
    )),
    structure,
  };
}

function controlledFilesAfter(baseCandidate, changesByKey) {
  const controlledFiles = baseCandidate.controlledFiles.flatMap((fact) => {
    const change = changesByKey.get(logicalRefKey(fact.ref));
    if (change === undefined) return [{ ...fact }];
    if (change.afterBytes === null) return [];
    return [{
      ...fact,
      byteSize: change.afterBytes.length,
      fileIdentity: null,
      rawSha256: change.rawSha256,
    }];
  });
  const existingKeys = new Set(baseCandidate.controlledFiles.map((fact) => logicalRefKey(fact.ref)));
  for (const [key, change] of changesByKey) {
    if (existingKeys.has(key) || change.beforeAbsent !== true) continue;
    controlledFiles.push({
      byteSize: change.afterBytes.length,
      fileIdentity: null,
      parentIdentity: change.before.parentIdentity,
      rawSha256: change.rawSha256,
      ref: change.before.ref,
      resourceUid: change.before.resourceUid,
      role: change.before.role,
    });
  }
  return controlledFiles.sort(sortCandidateFileFacts);
}

function capacityAfter(store, snapshot, controlledFiles, ignoredMemberObservations, changes) {
  const allFiles = controlledFiles.map((fact) => ({
    byteSize: fact.byteSize,
    role: fact.role,
  }));
  for (const observation of ignoredMemberObservations) {
    if (observation.status !== 'active') continue;
    for (const member of observation.members) {
      if (member.present) allFiles.push({ byteSize: member.byteSize, role: member.role });
    }
  }
  let controlledBytes = 0;
  let markdownBytes = 0;
  let jsonBytes = 0;
  for (const file of allFiles) {
    controlledBytes += file.byteSize;
    if (!Number.isSafeInteger(controlledBytes)) {
      throw new TypeError('controlled byte measurement exceeds safe integer range');
    }
    if (file.role === 'chapter_body') markdownBytes = Math.max(markdownBytes, file.byteSize);
    else jsonBytes = Math.max(jsonBytes, file.byteSize);
  }
  const createsChapter = changes.some((change) => (
    change.beforeAbsent === true && change.before.role === 'chapter_body'
  ));
  const createsVolume = changes.some((change) => (
    change.beforeAbsent === true && change.before.role === 'volume_index'
  ));
  const measurements = {
    ...snapshot.capacitySnapshot.measurements,
    chapterIdentities: snapshot.capacitySnapshot.measurements.chapterIdentities
      + (createsChapter ? 1 : 0),
    chapterDirectoryEntries: snapshot.capacitySnapshot.measurements.chapterDirectoryEntries
      - changes.filter((change) => (
        change.afterBytes === null
        && (change.before.role === 'chapter_body' || change.before.role === 'chapter_sidecar')
      )).length
      + (createsChapter ? 2 : 0),
    controlledBytes,
    controlledFiles: allFiles.length,
    jsonBytes,
    markdownBytes,
    volumeIdentities: snapshot.capacitySnapshot.measurements.volumeIdentities
      + (createsVolume ? 1 : 0),
  };
  const limits = storeRecords.get(store).limits;
  for (const dimension of Object.keys(LIMITS)) {
    if (measurements[dimension] > limits[dimension]) {
      manuscriptFailure('MANUSCRIPT_CONTENT_TOO_LARGE', {
        allowed: limits[dimension],
        dimension,
        observed: measurements[dimension],
      });
    }
  }
  const context = treeIdentityRecords.get(snapshot.treeIdentity);
  if (context === undefined || context.store !== store) {
    throw new TypeError('validated snapshot tree identity is not owned by this ManuscriptStore');
  }
  const warnings = new Map(snapshot.capacitySnapshot.warnings.map((warning) => [
    warning.key,
    warning,
  ]));
  for (const dimension of ['chapterIdentities', 'volumeIdentities']) {
    const allowed = limits[dimension];
    const threshold = Math.ceil(allowed * 0.8);
    const key = `manuscript-capacity:${dimension}:80-percent`;
    if (allowed > 0 && measurements[dimension] >= threshold && !warnings.has(key)) {
      warnings.set(key, Object.freeze({
        key,
        dimension,
        observed: measurements[dimension],
        allowed,
        threshold,
        persistent: true,
      }));
    }
  }
  return deepFreeze({
    counters: { ...context.accumulator.snapshot().counters },
    error: null,
    measurements,
    state: 'active',
    warnings: [...warnings.values()],
  });
}

function candidateAfter(
  baseCandidate,
  changesByKey,
  controlledFiles,
  capacitySnapshot,
  structure,
) {
  const chapterByUid = new Map(baseCandidate.chapters.map((chapter) => {
    const body = changesByKey.get(`chapter_body:${chapter.chapterUid}`);
    const sidecar = changesByKey.get(`chapter_sidecar:${chapter.chapterUid}`);
    const result = { ...chapter };
    if (body !== undefined && body.afterBytes !== null) {
      result.bodyFileIdentity = null;
      result.bodyRawSha256 = body.rawSha256;
      result.content = body.afterParsed.content;
      result.contentAvailable = body.afterParsed.contentAvailable;
      result.markdownMode = body.afterParsed.mode;
      result.wordCount = body.afterParsed.wordCount;
    }
    if (sidecar !== undefined && sidecar.afterBytes !== null) {
      const parsed = sidecar.afterParsed;
      result.cognitiveFrame = parsed.cognitive_frame;
      result.concreteMystery = parsed.concrete_mystery;
      result.emotionalAnchor = parsed.emotional_anchor;
      result.interpersonalTension = parsed.interpersonal_tension;
      result.outline = parsed.outline;
      result.sidecarFileIdentity = null;
      result.sidecarRawSha256 = sidecar.rawSha256;
      result.status = parsed.status;
      result.summary = parsed.summary;
      result.title = parsed.title;
      result.worldTexture = parsed.world_texture;
    }
    return [chapter.chapterUid, result];
  }));
  if (structure.created?.kind === 'chapter') {
    const uid = structure.created.reservation.uid;
    const body = changesByKey.get(`chapter_body:${uid}`);
    const sidecar = changesByKey.get(`chapter_sidecar:${uid}`);
    if (body?.beforeAbsent !== true || sidecar?.beforeAbsent !== true) {
      throw new TypeError('created chapter facts are incomplete');
    }
    const metadata = sidecar.afterParsed;
    chapterByUid.set(uid, {
      bodyFileIdentity: null,
      bodyRawSha256: body.rawSha256,
      chapterPosition: null,
      chapterUid: uid,
      cognitiveFrame: metadata.cognitive_frame,
      concreteMystery: metadata.concrete_mystery,
      content: body.afterParsed.content,
      contentAvailable: body.afterParsed.contentAvailable,
      emotionalAnchor: metadata.emotional_anchor,
      interpersonalTension: metadata.interpersonal_tension,
      manuscriptPosition: null,
      markdownMode: body.afterParsed.mode,
      outline: metadata.outline,
      sidecarFileIdentity: null,
      sidecarRawSha256: sidecar.rawSha256,
      status: metadata.status,
      summary: metadata.summary,
      title: metadata.title,
      volumeUid: structure.created.reservation.containerVolumeUid,
      wordCount: body.afterParsed.wordCount,
      worldTexture: metadata.world_texture,
    });
  }
  const chapters = [];
  let manuscriptPosition = 0;
  function appendChapters(containerUid) {
    const members = structure.chapterOrders.get(containerUid) ?? [];
    for (let index = 0; index < members.length; index += 1) {
      const chapter = chapterByUid.get(members[index]);
      if (chapter === undefined) throw new TypeError('structured after references an unknown chapter');
      manuscriptPosition += 1;
      chapters.push({
        ...chapter,
        chapterPosition: index + 1,
        manuscriptPosition,
        volumeUid: containerUid,
      });
    }
  }
  for (const volumeUid of structure.volumeOrder) appendChapters(volumeUid);
  appendChapters(null);

  const baseVolumeByUid = new Map(baseCandidate.volumes.map((volume) => [
    volume.volumeUid,
    volume,
  ]));
  if (structure.created?.kind === 'volume') {
    baseVolumeByUid.set(structure.created.reservation.uid, {
      summary: structure.created.summary,
      title: structure.created.title,
      volumeUid: structure.created.reservation.uid,
    });
  }
  const volumes = structure.volumeOrder.map((volumeUid, index) => {
    const volume = baseVolumeByUid.get(volumeUid);
    if (volume === undefined) throw new TypeError('structured after references an unknown volume');
    const change = changesByKey.get(`volume_index:${volume.volumeUid}`);
    const result = {
      ...volume,
      volumePosition: index + 1,
    };
    if (change !== undefined && change.afterBytes !== null) {
      result.summary = change.afterParsed.summary;
      result.title = change.afterParsed.title;
    }
    return result;
  });
  return deepFreeze({
    capacitySnapshot,
    chapters,
    controlledFiles,
    diagnostics: baseCandidate.diagnostics,
    ignoredLedgerAfter: structure.ignoredObservations,
    projectUid: baseCandidate.projectUid,
    volumeOrder: [...structure.volumeOrder],
    volumes,
    warnings: capacitySnapshot.warnings,
  });
}

function closureEndpoint(bytes, rawSha256, fileIdentity) {
  return Object.freeze({
    exists: true,
    bytes: Buffer.from(bytes),
    byteSize: bytes.length,
    rawSha256,
    ...(fileIdentity === undefined ? {} : { fileIdentity }),
  });
}

const ABSENT_CLOSURE_ENDPOINT = Object.freeze({
  exists: false,
  bytes: null,
  byteSize: 0,
  rawSha256: null,
});
const ABSENT_BEFORE_CLOSURE_ENDPOINT = Object.freeze({
  ...ABSENT_CLOSURE_ENDPOINT,
  fileIdentity: null,
});

function assertDenseFrozenArray(value, label) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || !Object.isFrozen(value)
  ) {
    throw new TypeError(`${label} must be a frozen plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== value.length + 1
    || !Object.hasOwn(descriptors, 'length')
    || ownKeys.some((key) => key !== 'length' && (
      typeof key !== 'string'
      || !/^(0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= value.length
    ))
  ) {
    throw new TypeError(`${label} must be dense and contain no extra properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label} must be dense and contain data properties only`);
    }
  }
  return value;
}

function assertOwnedEnumeration(store, snapshot, { requireLatest = true } = {}) {
  if (
    snapshot === null
    || typeof snapshot !== 'object'
    || !Object.isFrozen(snapshot)
  ) throw new TypeError('snapshot must be a frozen Store enumeration');
  const context = treeIdentityRecords.get(snapshot.treeIdentity);
  if (
    context === undefined
    || context.store !== store
    || context.enumerationSnapshot !== snapshot
    || snapshot.projectUid !== context.binding.projectUid
  ) {
    throw new TypeError('snapshot must be produced by this ManuscriptStore.enumerateAndClassify');
  }
  const record = storeRecords.get(store);
  if (requireLatest && record.nextScanEpoch !== context.scanEpoch + 1) {
    throw manuscriptError('RECOVERY_REQUIRED', { reason: 'uid_path_enumeration_stale' });
  }
  return context;
}

function assertCandidateMatchesProjectionBasis(candidate, currentProjection) {
  const basis = currentProjection.basis;
  const activeVolumes = basis.volumes
    .filter((row) => row.isPresent === 1)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  if (
    candidate.volumes.length !== activeVolumes.length
    || candidate.volumes.some((row, index) => (
      row.volumeUid !== activeVolumes[index].uid
      || row.volumePosition !== activeVolumes[index].sortOrder
    ))
  ) {
    throw new TypeError('orphan resolution found a non-target volume projection change');
  }
  const volumeUidById = new Map(activeVolumes.map((row) => [row.id, row.uid]));
  const activeChapters = basis.chapters
    .filter((row) => row.isPresent === 1)
    .sort((left, right) => left.manuscriptPosition - right.manuscriptPosition);
  if (
    candidate.chapters.length !== activeChapters.length
    || candidate.chapters.some((row, index) => {
      const basisRow = activeChapters[index];
      const volumeUid = basisRow.volumeId === null
        ? null
        : volumeUidById.get(basisRow.volumeId);
      return (
        volumeUid === undefined
        || row.chapterUid !== basisRow.uid
        || row.volumeUid !== volumeUid
        || row.chapterPosition !== basisRow.chapterPosition
        || row.manuscriptPosition !== basisRow.manuscriptPosition
        || row.bodyRawSha256 !== basisRow.bodyRawSha256
        || row.status !== basisRow.status
      );
    })
  ) {
    throw new TypeError('orphan resolution found a non-target chapter projection change');
  }
}

function isExactSingleInsertion(before, after, uid) {
  if (
    before.includes(uid)
    || after.length !== before.length + 1
    || after.filter((current) => current === uid).length !== 1
  ) return false;
  let beforeIndex = 0;
  for (const current of after) {
    if (current === uid) continue;
    if (current !== before[beforeIndex]) return false;
    beforeIndex += 1;
  }
  return beforeIndex === before.length;
}

function sameControlledFactsExceptRewrite(beforeFacts, afterFacts, rewrittenKey) {
  if (beforeFacts.length !== afterFacts.length) return false;
  const afterByKey = new Map(afterFacts.map((fact) => [logicalRefKey(fact.ref), fact]));
  if (afterByKey.size !== afterFacts.length) return false;
  for (const before of beforeFacts) {
    const key = logicalRefKey(before.ref);
    const after = afterByKey.get(key);
    if (after === undefined) return false;
    if (key !== rewrittenKey) {
      if (!isDeepStrictEqual(after, before)) return false;
      continue;
    }
    if (
      after.role !== before.role
      || after.resourceUid !== before.resourceUid
      || !isDeepStrictEqual(after.ref, before.ref)
      || !isDeepStrictEqual(after.parentIdentity, before.parentIdentity)
    ) return false;
  }
  return true;
}

function allowsNewActiveIndexInsertion(candidate, baselineCandidate, preparation) {
  if (preparation.transitionKind !== 'new_active') return false;
  const targetObservation = candidate.ignoredLedgerAfter.find((observation) => (
    observation.kind === preparation.kind && observation.uid === preparation.uid
  ));
  if (
    targetObservation === undefined
    || targetObservation.status !== 'active'
    || targetObservation.reference.state !== 'indexed'
  ) return false;
  const baselineRecord = projectionCandidateRecords.get(baselineCandidate);
  const candidateRecord = projectionCandidateRecords.get(candidate);
  const before = validatedSnapshotRecords.get(baselineRecord?.snapshot);
  const after = validatedSnapshotRecords.get(candidateRecord?.snapshot);
  if (before === undefined || after === undefined) return false;
  if (
    !isDeepStrictEqual(
      [...before.volumeSnapshots.keys()],
      [...after.volumeSnapshots.keys()],
    )
  ) return false;

  let rewrittenKey;
  if (preparation.kind === 'volume') {
    if (
      targetObservation.reference.containerKind !== 'manuscript'
      || targetObservation.reference.containerUid !== null
      || !isExactSingleInsertion(
        before.manuscript.parsed.volume_uids,
        after.manuscript.parsed.volume_uids,
        preparation.uid,
      )
      || !isDeepStrictEqual(
        before.unassigned.parsed.chapter_uids,
        after.unassigned.parsed.chapter_uids,
      )
    ) return false;
    rewrittenKey = 'manuscript';
  } else if (targetObservation.reference.containerKind === 'unassigned') {
    if (
      targetObservation.reference.containerUid !== null
      || !isDeepStrictEqual(
        before.manuscript.parsed.volume_uids,
        after.manuscript.parsed.volume_uids,
      )
      || !isExactSingleInsertion(
        before.unassigned.parsed.chapter_uids,
        after.unassigned.parsed.chapter_uids,
        preparation.uid,
      )
    ) return false;
    rewrittenKey = 'unassigned';
  } else if (targetObservation.reference.containerKind === 'volume') {
    const volumeUid = targetObservation.reference.containerUid;
    const beforeVolume = before.volumeSnapshots.get(volumeUid);
    const afterVolume = after.volumeSnapshots.get(volumeUid);
    if (
      beforeVolume === undefined
      || afterVolume === undefined
      || !isDeepStrictEqual(
        before.manuscript.parsed.volume_uids,
        after.manuscript.parsed.volume_uids,
      )
      || !isDeepStrictEqual(
        before.unassigned.parsed.chapter_uids,
        after.unassigned.parsed.chapter_uids,
      )
      || !isExactSingleInsertion(
        beforeVolume.parsed.chapter_uids,
        afterVolume.parsed.chapter_uids,
        preparation.uid,
      )
    ) return false;
    rewrittenKey = `volume_index:${volumeUid}`;
  } else {
    return false;
  }

  for (const [volumeUid, beforeVolume] of before.volumeSnapshots) {
    const afterVolume = after.volumeSnapshots.get(volumeUid);
    if (afterVolume === undefined) return false;
    if (
      rewrittenKey !== `volume_index:${volumeUid}`
      && !isDeepStrictEqual(
        beforeVolume.parsed.chapter_uids,
        afterVolume.parsed.chapter_uids,
      )
    ) return false;
  }
  return sameControlledFactsExceptRewrite(
    baselineCandidate.controlledFiles,
    candidate.controlledFiles,
    rewrittenKey,
  );
}

function assertResolutionCandidateMatchesBaseline(candidate, baselineCandidate, preparation) {
  if (
    candidate.projectUid !== baselineCandidate.projectUid
    || !isDeepStrictEqual(candidate.volumeOrder, baselineCandidate.volumeOrder)
    || !isDeepStrictEqual(candidate.volumes, baselineCandidate.volumes)
    || !isDeepStrictEqual(candidate.chapters, baselineCandidate.chapters)
  ) {
    throw new TypeError('orphan resolution found a non-target projection or file fact change');
  }
  if (
    !isDeepStrictEqual(candidate.controlledFiles, baselineCandidate.controlledFiles)
    && !allowsNewActiveIndexInsertion(candidate, baselineCandidate, preparation)
  ) throw new TypeError('orphan resolution found a non-target projection or file fact change');
}

function installedControlledKey(fact) {
  return `${fact.role}:${fact.resourceUid ?? ''}`;
}

function candidateControlledFacts(candidate) {
  return candidate.controlledFiles.map((fact) => ({
    byteSize: fact.byteSize,
    fileIdentity: fact.fileIdentity,
    parentIdentity: fact.parentIdentity,
    rawSha256: fact.rawSha256,
    resourceUid: fact.resourceUid,
    role: fact.role,
  }));
}

function sameInstalledControlledFacts(installedFacts, candidateFacts, rewrittenKey = null) {
  if (installedFacts.length !== candidateFacts.length) return false;
  const candidateByKey = new Map(candidateFacts.map((fact) => [installedControlledKey(fact), fact]));
  if (candidateByKey.size !== candidateFacts.length) return false;
  for (const installed of installedFacts) {
    const key = installedControlledKey(installed);
    const candidate = candidateByKey.get(key);
    if (candidate === undefined) return false;
    if (key !== rewrittenKey) {
      if (!isDeepStrictEqual(candidate, installed)) return false;
      continue;
    }
    if (
      candidate.role !== installed.role
      || candidate.resourceUid !== installed.resourceUid
      || !isDeepStrictEqual(candidate.parentIdentity, installed.parentIdentity)
    ) return false;
  }
  return true;
}

function allowsInstalledNewActiveIndexInsertion(candidate, installed, preparation) {
  if (preparation.transitionKind !== 'new_active') return false;
  const targetObservation = candidate.ignoredLedgerAfter.find((observation) => (
    observation.kind === preparation.kind && observation.uid === preparation.uid
  ));
  if (
    targetObservation === undefined
    || targetObservation.status !== 'active'
    || targetObservation.reference.state !== 'indexed'
  ) return false;
  const candidateRecord = projectionCandidateRecords.get(candidate);
  const after = validatedSnapshotRecords.get(candidateRecord?.snapshot);
  if (after === undefined) return false;

  const installedVolumeUids = installed.volumes.map((row) => row.volume_uid);
  const installedVolumeUidById = new Map(
    installed.volumes.map((row) => [row.id, row.volume_uid]),
  );
  const installedUnassigned = installed.chapters
    .filter((row) => row.volume_id === null)
    .sort((left, right) => left.chapter_position - right.chapter_position)
    .map((row) => row.chapter_uid);
  const installedByVolume = new Map(installed.volumes.map((row) => [row.volume_uid, []]));
  for (const chapter of installed.chapters) {
    if (chapter.volume_id === null) continue;
    const volumeUid = installedVolumeUidById.get(chapter.volume_id);
    if (volumeUid === undefined) return false;
    installedByVolume.get(volumeUid)?.push(chapter);
  }
  for (const [volumeUid, rows] of installedByVolume) {
    installedByVolume.set(volumeUid, rows
      .sort((left, right) => left.chapter_position - right.chapter_position)
      .map((row) => row.chapter_uid));
  }
  if (
    !isDeepStrictEqual([...after.volumeSnapshots.keys()], installedVolumeUids)
  ) return false;

  let rewrittenKey;
  if (preparation.kind === 'volume') {
    if (
      targetObservation.reference.containerKind !== 'manuscript'
      || targetObservation.reference.containerUid !== null
      || !isExactSingleInsertion(
        installedVolumeUids,
        after.manuscript.parsed.volume_uids,
        preparation.uid,
      )
      || !isDeepStrictEqual(installedUnassigned, after.unassigned.parsed.chapter_uids)
    ) return false;
    rewrittenKey = 'manuscript:';
  } else if (targetObservation.reference.containerKind === 'unassigned') {
    if (
      targetObservation.reference.containerUid !== null
      || !isDeepStrictEqual(installedVolumeUids, after.manuscript.parsed.volume_uids)
      || !isExactSingleInsertion(
        installedUnassigned,
        after.unassigned.parsed.chapter_uids,
        preparation.uid,
      )
    ) return false;
    rewrittenKey = 'unassigned:';
  } else if (targetObservation.reference.containerKind === 'volume') {
    const volumeUid = targetObservation.reference.containerUid;
    const afterVolume = after.volumeSnapshots.get(volumeUid);
    const installedMembers = installedByVolume.get(volumeUid);
    if (
      installedMembers === undefined
      || afterVolume === undefined
      || !isDeepStrictEqual(installedVolumeUids, after.manuscript.parsed.volume_uids)
      || !isDeepStrictEqual(installedUnassigned, after.unassigned.parsed.chapter_uids)
      || !isExactSingleInsertion(
        installedMembers,
        afterVolume.parsed.chapter_uids,
        preparation.uid,
      )
    ) return false;
    rewrittenKey = `volume_index:${volumeUid}`;
  } else {
    return false;
  }

  for (const [volumeUid, installedMembers] of installedByVolume) {
    const afterVolume = after.volumeSnapshots.get(volumeUid);
    if (afterVolume === undefined) return false;
    if (
      rewrittenKey !== `volume_index:${volumeUid}`
      && !isDeepStrictEqual(installedMembers, afterVolume.parsed.chapter_uids)
    ) return false;
  }
  return sameInstalledControlledFacts(
    installed.controlledFiles,
    candidateControlledFacts(candidate),
    rewrittenKey,
  );
}

function orphanInstalledCapacityMismatch() {
  throw manuscriptError('RECOVERY_REQUIRED', {
    reason: 'orphan_installed_capacity_mismatch',
  });
}

function safeCapacitySum(values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) orphanInstalledCapacityMismatch();
    total += value;
    if (!Number.isSafeInteger(total)) orphanInstalledCapacityMismatch();
  }
  return total;
}

function safeCapacityAdjustment(value, ...deltas) {
  let result = value;
  if (!Number.isSafeInteger(result) || result < 0) orphanInstalledCapacityMismatch();
  for (const delta of deltas) {
    if (!Number.isSafeInteger(delta)) orphanInstalledCapacityMismatch();
    result += delta;
    if (!Number.isSafeInteger(result) || result < 0) orphanInstalledCapacityMismatch();
  }
  return result;
}

function assertResolutionCapacityMatchesInstalled(candidate, installed, preparation) {
  const expected = {
    chapterIdentities: installed.capacity.chapter_identities,
    volumeIdentities: installed.capacity.volume_identities,
    controlledFiles: installed.capacity.controlled_files,
    chapterDirectoryEntries: installed.capacity.chapter_directory_entries,
    controlledBytes: installed.capacity.controlled_bytes,
  };
  if (preparation.transitionKind === 'new_active') {
    const targetObservation = candidate.ignoredLedgerAfter.find((observation) => (
      observation.kind === preparation.kind && observation.uid === preparation.uid
    ));
    if (targetObservation === undefined || targetObservation.status !== 'active') {
      orphanInstalledCapacityMismatch();
    }
    const presentMembers = targetObservation.members.filter((member) => member.present === true);
    const targetBytes = safeCapacitySum(presentMembers.map((member) => member.byteSize));
    const installedControlledBytes = safeCapacitySum(
      installed.controlledFiles.map((fact) => fact.byteSize),
    );
    const candidateControlledBytes = safeCapacitySum(
      candidate.controlledFiles.map((fact) => fact.byteSize),
    );
    expected[`${preparation.kind}Identities`] = safeCapacityAdjustment(
      expected[`${preparation.kind}Identities`],
      1,
    );
    expected.controlledFiles = safeCapacityAdjustment(
      expected.controlledFiles,
      presentMembers.length,
    );
    expected.controlledBytes = safeCapacityAdjustment(
      expected.controlledBytes,
      targetBytes,
      candidateControlledBytes - installedControlledBytes,
    );
    if (preparation.kind === 'chapter') {
      expected.chapterDirectoryEntries = safeCapacityAdjustment(
        expected.chapterDirectoryEntries,
        presentMembers.length,
      );
    }
  }
  const actual = candidate.capacitySnapshot.measurements;
  if (
    actual.chapterIdentities !== expected.chapterIdentities
    || actual.volumeIdentities !== expected.volumeIdentities
    || actual.controlledFiles !== expected.controlledFiles
    || actual.chapterDirectoryEntries !== expected.chapterDirectoryEntries
    || actual.controlledBytes !== expected.controlledBytes
  ) orphanInstalledCapacityMismatch();
}

function assertResolutionCandidateMatchesInstalled(candidate, installed, preparation) {
  const volumes = installed.volumes.map((row) => ({
    summary: row.summary,
    title: row.title,
    volumePosition: row.sort_order,
    volumeUid: row.volume_uid,
  }));
  const volumeUidById = new Map(installed.volumes.map((row) => [row.id, row.volume_uid]));
  const controlledByKey = new Map(
    installed.controlledFiles.map((fact) => [installedControlledKey(fact), fact]),
  );
  const chapters = installed.chapters.map((row) => ({
    bodyFileIdentity: controlledByKey.get(`chapter_body:${row.chapter_uid}`)?.fileIdentity,
    bodyRawSha256: row.body_raw_sha256,
    chapterPosition: row.chapter_position,
    chapterUid: row.chapter_uid,
    cognitiveFrame: row.cognitive_frame,
    concreteMystery: row.concrete_mystery,
    content: row.content,
    contentAvailable: row.content_available === 1,
    emotionalAnchor: row.emotional_anchor,
    interpersonalTension: row.interpersonal_tension,
    manuscriptPosition: row.manuscript_position,
    outline: row.outline,
    sidecarFileIdentity: controlledByKey.get(`chapter_sidecar:${row.chapter_uid}`)?.fileIdentity,
    sidecarRawSha256: row.sidecar_raw_sha256,
    status: row.status,
    summary: row.summary,
    title: row.title,
    volumeUid: row.volume_id === null ? null : volumeUidById.get(row.volume_id),
    wordCount: row.word_count,
    worldTexture: row.world_texture,
  }));
  const candidateChapters = candidate.chapters.map(({ markdownMode: _markdownMode, ...row }) => row);
  if (
    candidate.projectUid !== installed.projectUid
    || !isDeepStrictEqual(candidate.volumeOrder, volumes.map((row) => row.volumeUid))
    || !isDeepStrictEqual(candidate.volumes, volumes)
    || !isDeepStrictEqual(candidateChapters, chapters)
  ) throw new TypeError('orphan resolution found a non-target installed projection change');
  const candidateFacts = candidateControlledFacts(candidate);
  if (
    !sameInstalledControlledFacts(installed.controlledFiles, candidateFacts)
    && !allowsInstalledNewActiveIndexInsertion(candidate, installed, preparation)
  ) throw new TypeError('orphan resolution found a non-target installed file fact change');
  assertResolutionCapacityMatchesInstalled(candidate, installed, preparation);
}

function assertUnambiguousEnumeration(context) {
  if (context.journalCandidates.length !== 0 || context.residues.length !== 0) {
    throw manuscriptError('RECOVERY_REQUIRED', { reason: 'uid_path_enumeration_ambiguous' });
  }
}

function uidPathProbeInput(value, context) {
  const descriptors = dataDescriptors(value, 'UID path probe input');
  assertExactKeys(descriptors, [
    'projectUid',
    'projectInstanceId',
    'sourceBasisDigest',
    'objectKind',
    'uid',
  ], 'UID path probe input');
  const projectUid = assertCanonicalUuid(descriptorValue(descriptors, 'projectUid'), 'project_uid');
  assertCanonicalUuid(
    descriptorValue(descriptors, 'projectInstanceId'),
    'project_instance_id',
  );
  const sourceBasisDigest = descriptorValue(descriptors, 'sourceBasisDigest');
  if (typeof sourceBasisDigest !== 'string' || !SHA256_PATTERN.test(sourceBasisDigest)) {
    throw new TypeError('sourceBasisDigest must be a lowercase SHA-256 digest');
  }
  const objectKind = descriptorValue(descriptors, 'objectKind');
  if (objectKind !== 'chapter' && objectKind !== 'volume') {
    throw new TypeError('objectKind must be chapter or volume');
  }
  const uid = assertCanonicalUuid(descriptorValue(descriptors, 'uid'), 'uid');
  if (projectUid !== context.binding.projectUid) {
    throw new TypeError('UID path probe project does not match the enumeration');
  }
  return { objectKind, uid };
}

function migrationSourcePath(value, record, paths) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
  ) throw new TypeError('sourceSnapshot.sourcePath must be an absolute canonical path');
  const relativeToData = path.relative(record.dataRoot, value);
  if (
    relativeToData === ''
    || path.isAbsolute(relativeToData)
    || relativeToData === '..'
    || relativeToData.startsWith(`..${path.sep}`)
  ) throw new TypeError('sourceSnapshot.sourcePath must remain within dataRoot');
  const relativeToTarget = path.relative(paths.articleRoot, value);
  if (
    relativeToTarget === ''
    || (!path.isAbsolute(relativeToTarget)
      && relativeToTarget !== '..'
      && !relativeToTarget.startsWith(`..${path.sep}`))
  ) throw new TypeError('sourceSnapshot.sourcePath must be outside the target article root');
  return value;
}

function sourceString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function sourcePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function migrationSourceSnapshot(value, store, context, reservation) {
  assertDeepFrozenPlainData(value, 'sourceSnapshot');
  const descriptors = dataDescriptors(value, 'sourceSnapshot');
  assertExactKeys(descriptors, [
    'domain',
    'version',
    'projectUid',
    'projectInstanceId',
    'sourceBasisDigest',
    'sourcePath',
    'sourceIdentity',
    'sourceSha256',
    'readOnly',
    'projectedAt',
    'currentProjection',
    'ignoredLedger',
    'volumes',
    'chapters',
  ], 'sourceSnapshot');
  if (
    descriptorValue(descriptors, 'domain') !== 'mythpen.manuscript.schema11-source-snapshot'
    || descriptorValue(descriptors, 'version') !== 1
    || descriptorValue(descriptors, 'readOnly') !== true
  ) throw new TypeError('sourceSnapshot domain/version/readOnly binding is invalid');
  const projectUid = assertCanonicalUuid(
    descriptorValue(descriptors, 'projectUid'),
    'sourceSnapshot.projectUid',
  );
  const projectInstanceId = assertCanonicalUuid(
    descriptorValue(descriptors, 'projectInstanceId'),
    'sourceSnapshot.projectInstanceId',
  );
  const sourceBasisDigest = descriptorValue(descriptors, 'sourceBasisDigest');
  const sourceSha256 = descriptorValue(descriptors, 'sourceSha256');
  if (
    !SHA256_PATTERN.test(sourceBasisDigest || '')
    || !SHA256_PATTERN.test(sourceSha256 || '')
  ) throw new TypeError('sourceSnapshot digests must be lowercase SHA-256 values');
  const projectedAt = descriptorValue(descriptors, 'projectedAt');
  if (
    typeof projectedAt !== 'string'
    || !CANONICAL_TIME_PATTERN.test(projectedAt)
    || Number.isNaN(Date.parse(projectedAt))
    || new Date(projectedAt).toISOString() !== projectedAt
  ) throw new TypeError('sourceSnapshot.projectedAt must be a canonical UTC timestamp');
  const sourceIdentity = snapshotIdentity(
    descriptorValue(descriptors, 'sourceIdentity'),
    'sourceSnapshot.sourceIdentity',
  );
  const record = storeRecords.get(store);
  migrationSourcePath(
    descriptorValue(descriptors, 'sourcePath'),
    record,
    context.paths,
  );
  const currentProjection = descriptorValue(descriptors, 'currentProjection');
  const projectionDescriptors = dataDescriptors(currentProjection, 'sourceSnapshot.currentProjection');
  assertExactKeys(
    projectionDescriptors,
    ['projectUid', 'projectInstanceId', 'basis'],
    'sourceSnapshot.currentProjection',
  );
  const basis = descriptorValue(projectionDescriptors, 'basis');
  const canonicalBasisDigest = canonicalProjectionBasisDigest(basis);
  if (
    descriptorValue(projectionDescriptors, 'projectUid') !== projectUid
    || descriptorValue(projectionDescriptors, 'projectInstanceId') !== projectInstanceId
    || basis.sourceKind !== 'schema11'
    || basis.basisDigest !== canonicalBasisDigest
    || sourceBasisDigest !== canonicalBasisDigest
    || projectUid !== context.binding.projectUid
    || projectUid !== reservation.projectReservation.uid
    || projectInstanceId !== reservation.projectInstanceId
    || sourceBasisDigest !== reservation.sourceBasisDigest
  ) throw new TypeError('sourceSnapshot projection/reservation binding is invalid');
  const ignoredLedger = descriptorValue(descriptors, 'ignoredLedger');
  if (
    canonicalIgnoredLedgerDigest(ignoredLedger) !== basis.ignoredBeforeDigest
    || ignoredLedger.length !== 0
  ) throw new TypeError('schema11 sourceSnapshot ignoredLedger must be the canonical empty ledger');

  const volumeRows = assertDenseFrozenArray(
    descriptorValue(descriptors, 'volumes'),
    'sourceSnapshot.volumes',
  ).map((entry, index) => {
    const rowDescriptors = dataDescriptors(entry, `sourceSnapshot.volumes[${index}]`);
    assertExactKeys(
      rowDescriptors,
      ['id', 'sortOrder', 'title', 'summary'],
      `sourceSnapshot.volumes[${index}]`,
    );
    const id = sourcePositiveInteger(descriptorValue(rowDescriptors, 'id'), 'source volume id');
    const sortOrder = descriptorValue(rowDescriptors, 'sortOrder');
    if (!Number.isSafeInteger(sortOrder) || Object.is(sortOrder, -0)) {
      throw new TypeError('source volume sortOrder must be a safe integer');
    }
    return Object.freeze({
      id,
      sortOrder,
      title: sourceString(descriptorValue(rowDescriptors, 'title'), 'source volume title'),
      summary: sourceString(descriptorValue(rowDescriptors, 'summary'), 'source volume summary'),
    });
  });
  const chapterRows = assertDenseFrozenArray(
    descriptorValue(descriptors, 'chapters'),
    'sourceSnapshot.chapters',
  ).map((entry, index) => {
    const rowDescriptors = dataDescriptors(entry, `sourceSnapshot.chapters[${index}]`);
    assertExactKeys(rowDescriptors, [
      'id',
      'volumeId',
      'num',
      'title',
      'outline',
      'content',
      'summary',
      'status',
      'cognitiveFrame',
      'emotionalAnchor',
      'worldTexture',
      'concreteMystery',
      'interpersonalTension',
    ], `sourceSnapshot.chapters[${index}]`);
    const volumeId = descriptorValue(rowDescriptors, 'volumeId');
    if (volumeId !== null) sourcePositiveInteger(volumeId, 'source chapter volumeId');
    return Object.freeze({
      id: sourcePositiveInteger(descriptorValue(rowDescriptors, 'id'), 'source chapter id'),
      volumeId,
      num: sourcePositiveInteger(descriptorValue(rowDescriptors, 'num'), 'source chapter num'),
      title: sourceString(descriptorValue(rowDescriptors, 'title'), 'source chapter title'),
      outline: sourceString(descriptorValue(rowDescriptors, 'outline'), 'source chapter outline'),
      content: sourceString(descriptorValue(rowDescriptors, 'content'), 'source chapter content'),
      summary: sourceString(descriptorValue(rowDescriptors, 'summary'), 'source chapter summary'),
      status: sourceString(descriptorValue(rowDescriptors, 'status'), 'source chapter status'),
      cognitiveFrame: sourceString(
        descriptorValue(rowDescriptors, 'cognitiveFrame'),
        'source chapter cognitiveFrame',
      ),
      emotionalAnchor: sourceString(
        descriptorValue(rowDescriptors, 'emotionalAnchor'),
        'source chapter emotionalAnchor',
      ),
      worldTexture: sourceString(
        descriptorValue(rowDescriptors, 'worldTexture'),
        'source chapter worldTexture',
      ),
      concreteMystery: sourceString(
        descriptorValue(rowDescriptors, 'concreteMystery'),
        'source chapter concreteMystery',
      ),
      interpersonalTension: sourceString(
        descriptorValue(rowDescriptors, 'interpersonalTension'),
        'source chapter interpersonalTension',
      ),
    });
  });
  const basisVolumes = new Map(basis.volumes.map((row) => [row.id, row]));
  const basisChapters = new Map(basis.chapters.map((row) => [row.id, row]));
  if (volumeRows.length !== basisVolumes.size || chapterRows.length !== basisChapters.size) {
    throw new TypeError('sourceSnapshot rows do not exactly cover the schema11 basis');
  }
  const seenVolumeIds = new Set();
  for (const row of volumeRows) {
    const basisRow = basisVolumes.get(row.id);
    if (
      seenVolumeIds.has(row.id)
      || basisRow === undefined
      || basisRow.sortOrder !== row.sortOrder
    ) {
      throw new TypeError('sourceSnapshot volume does not match the schema11 basis');
    }
    seenVolumeIds.add(row.id);
  }
  const seenChapterIds = new Set();
  for (const row of chapterRows) {
    const basisRow = basisChapters.get(row.id);
    const bodyBytes = Buffer.from(row.content, 'utf8');
    if (
      seenChapterIds.has(row.id)
      || bodyBytes.toString('utf8') !== row.content
      || basisRow === undefined
      || basisRow.volumeId !== row.volumeId
      || basisRow.num !== row.num
      || basisRow.status !== row.status
      || basisRow.bodyRawSha256 !== hashBytes(bodyBytes)
    ) throw new TypeError('sourceSnapshot chapter does not match the schema11 basis');
    seenChapterIds.add(row.id);
  }
  return {
    basis,
    chapterRows,
    ignoredLedger,
    projectInstanceId,
    projectedAt,
    projectUid,
    sourceIdentity,
    sourceBasisDigest,
    volumeRows,
  };
}

function migrationClosureDigest(closure) {
  const material = closure.map((member) => ({
    ref: member.ref,
    parentIdentity: member.parentIdentity,
    before: {
      exists: member.before.exists,
      byteSize: member.before.byteSize,
      rawSha256: member.before.rawSha256,
      fileIdentity: member.before.fileIdentity,
    },
    after: {
      exists: member.after.exists,
      byteSize: member.after.byteSize,
      rawSha256: member.after.rawSha256,
    },
  }));
  return createHash('sha256')
    .update('mythpen.manuscript.migration-closure.v1\0', 'utf8')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex');
}

function creationProjectIdentity(value, context) {
  assertDeepFrozenPlainData(value, 'creation project identity');
  const descriptors = dataDescriptors(value, 'creation project identity');
  assertExactKeys(
    descriptors,
    ['creationId', 'projectUid', 'projectInstanceId'],
    'creation project identity',
  );
  const result = Object.freeze({
    creationId: assertCanonicalUuid(
      descriptorValue(descriptors, 'creationId'),
      'creation_id',
    ),
    projectUid: assertCanonicalUuid(
      descriptorValue(descriptors, 'projectUid'),
      'project_uid',
    ),
    projectInstanceId: assertCanonicalUuid(
      descriptorValue(descriptors, 'projectInstanceId'),
      'project_instance_id',
    ),
  });
  if (result.projectUid !== context.binding.projectUid) {
    throw new TypeError('creation project identity belongs to another Store enumeration');
  }
  return result;
}

function creationClosureDigest(closure) {
  const material = closure.map((member) => ({
    ref: member.ref,
    parentIdentity: member.parentIdentity,
    before: {
      exists: member.before.exists,
      byteSize: member.before.byteSize,
      rawSha256: member.before.rawSha256,
      fileIdentity: member.before.fileIdentity,
    },
    after: {
      exists: member.after.exists,
      byteSize: member.after.byteSize,
      rawSha256: member.after.rawSha256,
    },
  }));
  return createHash('sha256')
    .update('mythpen.manuscript.creation-empty-closure.v1\0', 'utf8')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex');
}

function compileCreationEmptyBootstrap(store, snapshot, mutation, ignoredRows, projectIdentity) {
  const context = assertOwnedEnumeration(store, snapshot);
  assertUnambiguousEnumeration(context);
  if (context.canonicalFiles.length !== 0) {
    throw manuscriptError('RECOVERY_REQUIRED', { reason: 'creation_target_not_empty' });
  }
  const rows = assertDenseFrozenArray(ignoredRows, 'ignoredRows');
  if (rows.length !== 0) {
    throw new TypeError('creation ignoredRows must be the frozen empty array');
  }
  const mutationDescriptors = dataDescriptors(mutation, 'creation mutation');
  assertExactKeys(mutationDescriptors, ['kind'], 'creation mutation');
  if (descriptorValue(mutationDescriptors, 'kind') !== 'creation.empty_bootstrap') {
    throw new TypeError('creation mutation kind is invalid');
  }
  const identity = creationProjectIdentity(projectIdentity, context);
  const changes = [
    createChange(
      deriveControlledFileRef({ role: 'manuscript', projectUid: identity.projectUid }),
      context.directories.mythpen.identity,
      serializeCanonicalJson('manuscript', {
        format_version: MANUSCRIPT_FORMAT_VERSION,
        project_uid: identity.projectUid,
        volume_uids: [],
      }),
      null,
    ),
    createChange(
      deriveControlledFileRef({ role: 'unassigned', projectUid: identity.projectUid }),
      context.directories.mythpen.identity,
      serializeCanonicalJson('unassigned', {
        format_version: MANUSCRIPT_FORMAT_VERSION,
        kind: 'unassigned',
        chapter_uids: [],
      }),
      null,
    ),
  ].sort((left, right) => sortFileFacts(left.before, right.before));
  const controlledFiles = changes.map((change) => ({
    byteSize: change.afterBytes.length,
    fileIdentity: null,
    parentIdentity: change.before.parentIdentity,
    rawSha256: change.rawSha256,
    ref: change.before.ref,
    resourceUid: null,
    role: change.before.role,
  })).sort(sortCandidateFileFacts);
  const accumulator = createAccumulator(storeRecords.get(store));
  accumulator.recordDirectoryEntry();
  accumulator.recordDirectoryEntry();
  for (const fact of controlledFiles) {
    accumulator.recordDirectoryEntry();
    accumulator.recordFileMetadata({ kind: 'json', byteSize: fact.byteSize });
  }
  const capacitySnapshot = accumulator.snapshot();
  const candidateTemplate = deepFreeze({
    capacitySnapshot,
    chapters: [],
    controlledFiles,
    diagnostics: { journalCandidates: [], residues: [] },
    ignoredLedgerAfter: [],
    projectUid: identity.projectUid,
    volumeOrder: [],
    volumes: [],
    warnings: capacitySnapshot.warnings,
  });
  const closure = Object.freeze(changes.map((change) => Object.freeze({
    after: closureEndpoint(change.afterBytes, change.rawSha256),
    before: ABSENT_BEFORE_CLOSURE_ENDPOINT,
    parentIdentity: change.before.parentIdentity,
    ref: change.before.ref,
  })));
  const buildResult = Object.freeze({
    closure,
    closureDigest: creationClosureDigest(closure),
    candidateTemplate,
  });
  buildResultRecords.set(buildResult, {
    expected: new Map(changes.map((change) => [
      logicalRefKey(change.before.ref),
      Object.freeze({
        byteSize: change.afterBytes.length,
        parentIdentity: change.before.parentIdentity,
        rawSha256: change.rawSha256,
      }),
    ])),
    store,
  });
  return buildResult;
}

function compileMigrationFullSnapshot(store, snapshot, mutation, ignoredRows, identityReservation) {
  const context = assertOwnedEnumeration(store, snapshot);
  assertUnambiguousEnumeration(context);
  if (context.canonicalFiles.length !== 0) {
    throw manuscriptError('RECOVERY_REQUIRED', { reason: 'migration_target_not_empty' });
  }
  const rows = assertDenseFrozenArray(ignoredRows, 'ignoredRows');
  if (rows.length !== 0) throw new TypeError('migration ignoredRows must be the frozen empty array');
  assertDeepFrozenPlainData(identityReservation, 'migrationReservation');
  validateMigrationReservationManifest(identityReservation);
  const mutationDescriptors = dataDescriptors(mutation, 'migration mutation');
  assertExactKeys(
    mutationDescriptors,
    ['kind', 'sourceSnapshot', 'localIdentityPlan'],
    'migration mutation',
  );
  if (descriptorValue(mutationDescriptors, 'kind') !== 'migration.full_snapshot') {
    throw new TypeError('migration mutation kind is invalid');
  }
  const localIdentityPlan = descriptorValue(mutationDescriptors, 'localIdentityPlan');
  if (
    localIdentityPlan !== identityReservation.localIdentityPlan
    || !Object.isFrozen(localIdentityPlan)
  ) throw new TypeError('migration localIdentityPlan must be the reservation original');
  const source = migrationSourceSnapshot(
    descriptorValue(mutationDescriptors, 'sourceSnapshot'),
    store,
    context,
    identityReservation,
  );
  const assignments = new Map(localIdentityPlan.map((row) => [
    `${row.objectKind}:${row.id}`,
    row,
  ]));
  if (assignments.size !== source.volumeRows.length + source.chapterRows.length) {
    throw new TypeError('migration localIdentityPlan does not exactly cover source rows');
  }
  const volumeUidById = new Map();
  for (const row of source.volumeRows) {
    const assignment = assignments.get(`volume:${row.id}`);
    if (assignment === undefined) throw new TypeError('migration plan is missing a source volume');
    volumeUidById.set(row.id, assignment.uid);
  }
  const chapterUidById = new Map();
  for (const row of source.chapterRows) {
    const assignment = assignments.get(`chapter:${row.id}`);
    if (assignment === undefined || assignment.num !== row.num) {
      throw new TypeError('migration plan does not bind the exact source chapter');
    }
    chapterUidById.set(row.id, assignment.uid);
  }
  const volumeOrderRows = [...source.volumeRows].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.id - right.id
  ));
  const volumeOrder = volumeOrderRows.map((row) => volumeUidById.get(row.id));
  const chapterGroups = new Map([[null, []]]);
  for (const row of source.volumeRows) chapterGroups.set(row.id, []);
  const activeNumbers = new Set();
  for (const row of source.chapterRows) {
    if (!chapterGroups.has(row.volumeId)) {
      throw new TypeError('source chapter references an unknown volume');
    }
    const numberKey = `${row.volumeId ?? 'unassigned'}:${row.num}`;
    if (activeNumbers.has(numberKey)) {
      throw manuscriptError('LEGACY_CHAPTER_NUMBER_INVALID', { id: row.id, num: row.num });
    }
    activeNumbers.add(numberKey);
    chapterGroups.get(row.volumeId).push(row);
  }
  for (const members of chapterGroups.values()) {
    members.sort((left, right) => left.num - right.num || left.id - right.id);
  }

  const changes = [];
  function addJson(ref, parentIdentity, parsed) {
    changes.push(createChange(
      ref,
      parentIdentity,
      serializeCanonicalJson(ref.role, parsed),
      parsed,
    ));
  }
  addJson(
    deriveControlledFileRef({ role: 'manuscript', projectUid: source.projectUid }),
    context.directories.mythpen.identity,
    {
      format_version: MANUSCRIPT_FORMAT_VERSION,
      project_uid: source.projectUid,
      volume_uids: volumeOrder,
    },
  );
  addJson(
    deriveControlledFileRef({ role: 'unassigned', projectUid: source.projectUid }),
    context.directories.mythpen.identity,
    {
      format_version: MANUSCRIPT_FORMAT_VERSION,
      kind: 'unassigned',
      chapter_uids: chapterGroups.get(null).map((row) => chapterUidById.get(row.id)),
    },
  );
  for (const volume of volumeOrderRows) {
    const volumeUid = volumeUidById.get(volume.id);
    addJson(
      deriveControlledFileRef({ role: 'volume_index', projectUid: source.projectUid, volumeUid }),
      context.directories.volumes.identity,
      {
        format_version: MANUSCRIPT_FORMAT_VERSION,
        volume_uid: volumeUid,
        title: volume.title,
        summary: volume.summary,
        chapter_uids: chapterGroups.get(volume.id).map((row) => chapterUidById.get(row.id)),
      },
    );
  }

  const chapterCandidates = new Map();
  for (const chapter of source.chapterRows) {
    const chapterUid = chapterUidById.get(chapter.id);
    const bodyBytes = Buffer.from(chapter.content, 'utf8');
    const bodyParsed = inspectMarkdown(bodyBytes);
    const sidecarParsed = {
      format_version: MANUSCRIPT_FORMAT_VERSION,
      chapter_uid: chapterUid,
      title: chapter.title,
      outline: chapter.outline,
      status: chapter.status,
      summary: chapter.summary,
      cognitive_frame: chapter.cognitiveFrame,
      emotional_anchor: chapter.emotionalAnchor,
      world_texture: chapter.worldTexture,
      concrete_mystery: chapter.concreteMystery,
      interpersonal_tension: chapter.interpersonalTension,
    };
    changes.push(createChange(
      deriveControlledFileRef({ role: 'chapter_body', projectUid: source.projectUid, chapterUid }),
      context.directories.chapters.identity,
      bodyBytes,
      bodyParsed,
    ));
    addJson(
      deriveControlledFileRef({ role: 'chapter_sidecar', projectUid: source.projectUid, chapterUid }),
      context.directories.chapters.identity,
      sidecarParsed,
    );
    chapterCandidates.set(chapter.id, {
      bodyFileIdentity: null,
      bodyRawSha256: bodyParsed.rawSha256,
      chapterUid,
      cognitiveFrame: chapter.cognitiveFrame,
      concreteMystery: chapter.concreteMystery,
      content: bodyParsed.content,
      contentAvailable: bodyParsed.contentAvailable,
      emotionalAnchor: chapter.emotionalAnchor,
      interpersonalTension: chapter.interpersonalTension,
      markdownMode: bodyParsed.mode,
      outline: chapter.outline,
      sidecarFileIdentity: null,
      sidecarRawSha256: hashBytes(serializeCanonicalJson('chapter_sidecar', sidecarParsed)),
      status: chapter.status,
      summary: chapter.summary,
      title: chapter.title,
      wordCount: bodyParsed.wordCount,
      worldTexture: chapter.worldTexture,
    });
  }
  changes.sort((left, right) => sortFileFacts(left.before, right.before));
  const controlledFiles = changes.map((change) => ({
    byteSize: change.afterBytes.length,
    fileIdentity: null,
    parentIdentity: change.before.parentIdentity,
    rawSha256: change.rawSha256,
    ref: change.before.ref,
    resourceUid: change.before.resourceUid,
    role: change.before.role,
  })).sort(sortCandidateFileFacts);
  const accumulator = createAccumulator(storeRecords.get(store));
  accumulator.recordDirectoryEntry();
  accumulator.recordDirectoryEntry();
  for (const uid of volumeOrder) accumulator.recordIdentity({ kind: 'volume', uid, source: 'active' });
  for (const uid of chapterUidById.values()) {
    accumulator.recordIdentity({ kind: 'chapter', uid, source: 'active' });
  }
  for (const fact of controlledFiles) {
    accumulator.recordDirectoryEntry({ chapterDirectory: fact.role.startsWith('chapter_') });
    accumulator.recordFileMetadata({
      kind: fact.role === 'chapter_body' ? 'markdown' : 'json',
      byteSize: fact.byteSize,
    });
  }
  const capacitySnapshot = accumulator.snapshot();
  const chapters = [];
  let manuscriptPosition = 0;
  function appendGroup(volumeId, volumeUid) {
    const members = chapterGroups.get(volumeId);
    for (let index = 0; index < members.length; index += 1) {
      const candidate = chapterCandidates.get(members[index].id);
      manuscriptPosition += 1;
      chapters.push({
        ...candidate,
        chapterPosition: index + 1,
        manuscriptPosition,
        volumeUid,
      });
    }
  }
  for (const volume of volumeOrderRows) appendGroup(volume.id, volumeUidById.get(volume.id));
  appendGroup(null, null);
  const candidateTemplate = deepFreeze({
    capacitySnapshot,
    chapters,
    controlledFiles,
    diagnostics: { journalCandidates: [], residues: [] },
    ignoredLedgerAfter: [],
    projectUid: source.projectUid,
    volumeOrder,
    volumes: volumeOrderRows.map((volume, index) => ({
      summary: volume.summary,
      title: volume.title,
      volumePosition: index + 1,
      volumeUid: volumeUidById.get(volume.id),
    })),
    warnings: capacitySnapshot.warnings,
  });
  const closure = Object.freeze(changes.map((change) => Object.freeze({
    after: closureEndpoint(change.afterBytes, change.rawSha256),
    before: ABSENT_BEFORE_CLOSURE_ENDPOINT,
    parentIdentity: change.before.parentIdentity,
    ref: change.before.ref,
  })));
  const buildResult = Object.freeze({
    closure,
    closureDigest: migrationClosureDigest(closure),
    candidateTemplate,
  });
  buildResultRecords.set(buildResult, {
    expected: new Map(changes.map((change) => [
      logicalRefKey(change.before.ref),
      Object.freeze({
        byteSize: change.afterBytes.length,
        parentIdentity: change.before.parentIdentity,
        rawSha256: change.rawSha256,
      }),
    ])),
    store,
  });
  return buildResult;
}

class ManuscriptStore {
  constructor({
    dataRoot,
    fileBoundary,
    journalAuthority,
    installedOrphanBaselineAuthority,
    limits = LIMITS,
    capacityObserver,
  } = {}) {
    const safeDataRoot = assertCanonicalDataRoot(dataRoot);
    const boundary = requireFileBoundaryCapability(fileBoundary).methods;
    const authority = requireJournalAuthorityCapability(journalAuthority).methods;
    let installedBaselineAuthority = null;
    if (installedOrphanBaselineAuthority !== undefined) {
      const installedAuthority = assertInstalledOrphanBaselineAuthority(
        installedOrphanBaselineAuthority,
      );
      const installedDescriptors = dataDescriptors(
        installedAuthority,
        'installed orphan baseline authority',
      );
      assertExactKeys(
        installedDescriptors,
        ['assert', 'describe'],
        'installed orphan baseline authority',
      );
      for (const method of ['assert', 'describe']) {
        if (typeof descriptorValue(installedDescriptors, method) !== 'function') {
          throw new TypeError(`installed orphan baseline authority.${method} must be a function`);
        }
      }
      installedBaselineAuthority = Object.freeze({
        authority: installedAuthority,
        assert: descriptorValue(installedDescriptors, 'assert'),
        describe: descriptorValue(installedDescriptors, 'describe'),
      });
    }
    if (capacityObserver !== undefined && typeof capacityObserver !== 'function') {
      throw new TypeError('capacityObserver must be a function');
    }
    createCapacityAccumulator(limits);
    storeRecords.set(this, {
      capacityObserver,
      dataRoot: safeDataRoot,
      fileBoundary: boundary,
      journalAuthority: authority,
      installedBaselineAuthority,
      limits: { ...limits },
      nextScanEpoch: 0,
    });
  }

  async enumerateAndClassify(identity) {
    const result = await enumerateInternal(this, identity, createAccumulator(storeRecords.get(this)));
    return result.snapshot;
  }

  captureOrphanBaseline(input) {
    const descriptors = dataDescriptors(input, 'orphan baseline input');
    const installedMode = Object.hasOwn(descriptors, 'installedProjectionBaseline');
    assertExactKeys(
      descriptors,
      installedMode
        ? ['projectBinding', 'currentProjection', 'ignoredLedger', 'installedProjectionBaseline']
        : ['projectBinding', 'currentProjection', 'ignoredLedger', 'projectionCandidate'],
      'orphan baseline input',
    );
    const projectBinding = snapshotProjectBinding(
      descriptorValue(descriptors, 'projectBinding'),
    );
    const currentProjection = descriptorValue(descriptors, 'currentProjection');
    canonicalSchema12ReuseIdentityPlan(currentProjection);
    let projectionCandidate = null;
    let installedProjectionFacts = null;
    if (installedMode) {
      const installedAuthority = storeRecords.get(this).installedBaselineAuthority;
      if (installedAuthority === null) {
        throw new TypeError('orphan baseline Store has no installed projection authority');
      }
      const receipt = descriptorValue(descriptors, 'installedProjectionBaseline');
      const asserted = Reflect.apply(
        installedAuthority.assert,
        installedAuthority.authority,
        [receipt],
      );
      if (asserted !== receipt) {
        throw new TypeError('installed orphan baseline authority changed the receipt');
      }
      installedProjectionFacts = Reflect.apply(
        installedAuthority.describe,
        installedAuthority.authority,
        [receipt],
      );
      assertDeepFrozenPlainData(installedProjectionFacts, 'installed orphan baseline facts');
      const installedDescriptors = dataDescriptors(
        installedProjectionFacts,
        'installed orphan baseline facts',
      );
      assertExactKeys(installedDescriptors, [
        'projectUid', 'projectInstanceId', 'baseGeneration', 'basisDigest',
        'ignoredDigest', 'volumes', 'chapters', 'controlledFiles', 'capacity',
      ], 'installed orphan baseline facts');
      if (
        installedProjectionFacts.projectUid !== currentProjection.projectUid
        || installedProjectionFacts.projectInstanceId !== currentProjection.projectInstanceId
        || installedProjectionFacts.baseGeneration !== currentProjection.basis.baseGeneration
        || installedProjectionFacts.basisDigest !== currentProjection.basis.basisDigest
        || installedProjectionFacts.ignoredDigest
          !== currentProjection.basis.ignoredBeforeDigest
      ) throw new TypeError('installed orphan baseline receipt is foreign or stale');
    } else {
      projectionCandidate = descriptorValue(descriptors, 'projectionCandidate');
      const candidateRecord = projectionCandidateRecords.get(projectionCandidate);
      if (candidateRecord === undefined || candidateRecord.store !== this) {
        throw new TypeError(
          'orphan baseline requires the original Store projection candidate authority',
        );
      }
      assertCandidateMatchesProjectionBasis(projectionCandidate, currentProjection);
    }
    if (currentProjection.projectUid !== projectBinding.projectUid) {
      throw new TypeError('orphan baseline project binding does not match currentProjection');
    }
    const baseGeneration = currentProjection.basis.baseGeneration;
    if (baseGeneration === Number.MAX_SAFE_INTEGER) {
      throw new TypeError('orphan baseline target generation exceeds the safe integer range');
    }
    const ignoredRows = normalizeIgnoredLedgerRows(
      descriptorValue(descriptors, 'ignoredLedger'),
      'orphan baseline ignoredLedger',
    );
    if (
      canonicalIgnoredLedgerDigest(ignoredRows)
      !== currentProjection.basis.ignoredBeforeDigest
    ) {
      throw new TypeError('orphan baseline ignoredLedger does not match currentProjection');
    }
    for (const row of ignoredRows) {
      if (row.projection_generation !== baseGeneration) {
        throw new TypeError('orphan baseline ignoredLedger generation is stale');
      }
    }
    const lifecycleBasis = deepFreeze({
      activeChapterUids: currentProjection.basis.chapters
        .filter((row) => row.isPresent === 1)
        .map((row) => row.uid),
      chapterTombstoneUids: currentProjection.basis.chapters
        .filter((row) => row.isPresent === 0)
        .map((row) => row.uid),
      activeVolumeUids: currentProjection.basis.volumes
        .filter((row) => row.isPresent === 1)
        .map((row) => row.uid),
      volumeTombstoneUids: currentProjection.basis.volumes
        .filter((row) => row.isPresent === 0)
        .map((row) => row.uid),
    });
    const baseline = Object.freeze({});
    orphanBaselineRecords.set(baseline, Object.freeze({
      baseGeneration,
      capturedScanEpoch: storeRecords.get(this).nextScanEpoch,
      currentProjection,
      ignoredRows,
      lifecycleBasis,
      projectionCandidate,
      installedProjectionFacts,
      projectBinding,
      store: this,
      targetGeneration: baseGeneration + 1,
    }));
    return baseline;
  }

  async preflightOrphanResolution(action, request, baseline) {
    const base = orphanBaselineRecords.get(baseline);
    if (base === undefined || base.store !== this) {
      throw new TypeError('orphan resolution requires the original branded Store baseline');
    }
    if (storeRecords.get(this).nextScanEpoch !== base.capturedScanEpoch) {
      throw manuscriptError('RECOVERY_REQUIRED', { reason: 'orphan_baseline_stale' });
    }
    const preparation = ignoredIdentityLedger.prepareResolution({
      action,
      request,
      beforeRows: base.ignoredRows,
      baseGeneration: base.baseGeneration,
    });
    const pending = ignoredIdentityLedger.describeResolutionPreparation(preparation);
    const snapshot = await this.validateFull(base.projectBinding, Object.freeze({
      ignoredLedger: pending.validationLedger,
      lifecycleBasis: base.lifecycleBasis,
    }));
    if (
      snapshot.classifications.journalCandidates.length !== 0
      || snapshot.classifications.residues.length !== 0
    ) {
      throw manuscriptError('RECOVERY_REQUIRED', {
        reason: 'orphan_resolution_enumeration_ambiguous',
      });
    }
    const candidate = await this.buildProjectionCandidate(snapshot);
    if (base.installedProjectionFacts === null) {
      assertResolutionCandidateMatchesBaseline(candidate, base.projectionCandidate, pending);
    } else {
      assertResolutionCandidateMatchesInstalled(candidate, base.installedProjectionFacts, pending);
    }
    const transition = ignoredIdentityLedger.finalizeResolution({
      preparation,
      candidate,
      targetGeneration: base.targetGeneration,
    });
    const transitionRecord = ignoredIdentityLedger.describeResolutionTransition(transition);
    const prepared = Object.freeze({});
    orphanPreparedRecords.set(prepared, Object.freeze({
      action,
      beforeRows: base.ignoredRows,
      candidate,
      currentProjection: base.currentProjection,
      noOp: transitionRecord.noOp,
      requestKind: transitionRecord.kind,
      requestUid: transitionRecord.uid,
      store: this,
      targetGeneration: base.targetGeneration,
      transition,
    }));
    return prepared;
  }

  describeOrphanResolution(prepared) {
    const record = orphanPreparedRecords.get(prepared);
    if (record === undefined || record.store !== this) {
      throw new TypeError('orphan resolution requires the original Store prepared candidate');
    }
    return record;
  }

  createUidPathProbe(snapshot) {
    const validated = validatedSnapshotRecords.get(snapshot);
    const context = validated?.store === this
      ? treeIdentityRecords.get(snapshot.treeIdentity)
      : assertOwnedEnumeration(this, snapshot);
    const record = storeRecords.get(this);
    if (
      context === undefined
      || context.store !== this
      || snapshot.projectUid !== context.binding.projectUid
      || record.nextScanEpoch !== context.scanEpoch + 1
    ) throw manuscriptError('RECOVERY_REQUIRED', { reason: 'uid_path_enumeration_stale' });
    assertUnambiguousEnumeration(context);
    const store = this;
    return Object.freeze({
      async probe(input) {
        const ownedValidation = validatedSnapshotRecords.get(snapshot);
        const current = ownedValidation?.store === store
          ? treeIdentityRecords.get(snapshot.treeIdentity)
          : assertOwnedEnumeration(store, snapshot);
        const currentRecord = storeRecords.get(store);
        if (
          current === undefined
          || current.store !== store
          || snapshot.projectUid !== current.binding.projectUid
          || currentRecord.nextScanEpoch !== current.scanEpoch + 1
        ) throw manuscriptError('RECOVERY_REQUIRED', { reason: 'uid_path_enumeration_stale' });
        assertUnambiguousEnumeration(current);
        const { objectKind, uid } = uidPathProbeInput(input, current);
        const roles = objectKind === 'chapter'
          ? ['chapter_body', 'chapter_sidecar']
          : ['volume_index'];
        if (roles.some((role) => current.filesByKey.has(`${role}:${uid}`))) {
          return Object.freeze({ disposition: 'collision' });
        }
        const parentIdentity = objectKind === 'chapter'
          ? current.directories.chapters.identity
          : current.directories.volumes.identity;
        const pathByRole = objectKind === 'chapter'
          ? (() => {
            const paths = deriveChapterPaths(current.paths, uid);
            return new Map([
              ['chapter_body', paths.bodyPath],
              ['chapter_sidecar', paths.sidecarPath],
            ]);
          })()
          : new Map([['volume_index', deriveVolumePath(current.paths, uid)]]);
        return deepFreeze({
          disposition: 'absent',
          pathPredicates: roles.map((role) => ({
            role,
            canonicalPath: pathByRole.get(role),
            parentIdentity,
            disposition: 'absent',
          })),
        });
      },
    });
  }

  async readControlledFile(identity, controlledFileRef) {
    return (await readControlledFileInternal(this, identity, controlledFileRef)).snapshot;
  }

  async validateFull(identity, options) {
    const optionDescriptors = dataDescriptors(options, 'validation options');
    assertExactKeys(optionDescriptors, ['ignoredLedger', 'lifecycleBasis'], 'validation options');
    const lifecycleBasis = snapshotLifecycleBasis(
      descriptorValue(optionDescriptors, 'lifecycleBasis'),
    );
    const ignoredLedger = snapshotIgnoredLedger(
      descriptorValue(optionDescriptors, 'ignoredLedger'),
    );
    const known = identitySets(lifecycleBasis);
    for (const entry of ignoredLedger.entries) {
      if (known[entry.kind].has(entry.uid)) {
        manuscriptFailure('MANUSCRIPT_FILESET_INVALID', {
          role: 'ignored_lifecycle_overlap',
        });
      }
    }
    const record = storeRecords.get(this);
    const accumulator = createAccumulator(record);
    for (const uid of lifecycleBasis.activeChapterUids) {
      accumulator.recordIdentity({ kind: 'chapter', source: 'active', uid });
    }
    for (const uid of lifecycleBasis.chapterTombstoneUids) {
      accumulator.recordIdentity({ kind: 'chapter', source: 'tombstone', uid });
    }
    for (const uid of lifecycleBasis.activeVolumeUids) {
      accumulator.recordIdentity({ kind: 'volume', source: 'active', uid });
    }
    for (const uid of lifecycleBasis.volumeTombstoneUids) {
      accumulator.recordIdentity({ kind: 'volume', source: 'tombstone', uid });
    }
    for (const entry of ignoredLedger.entries) {
      accumulator.recordIdentity({
        kind: entry.kind,
        source: entry.status === 'active' ? 'ignored_active' : 'ignored_revoked',
        uid: entry.uid,
      });
    }

    const { context, snapshot: enumeration } = await enumerateInternal(this, identity, accumulator);
    const activeIgnored = new Set(
      ignoredLedger.entries
        .filter((entry) => entry.status === 'active')
        .map((entry) => `${entry.kind}:${entry.uid}`),
    );
    const revokedIgnored = new Set(
      ignoredLedger.entries
        .filter((entry) => entry.status === 'revoked')
        .map((entry) => `${entry.kind}:${entry.uid}`),
    );

    const chapterResourceUids = new Set();
    for (const file of context.canonicalFiles) {
      if (file.role !== 'chapter_body' && file.role !== 'chapter_sidecar') continue;
      if (activeIgnored.has(`chapter:${file.resourceUid}`)) continue;
      chapterResourceUids.add(file.resourceUid);
    }
    for (const chapterUid of chapterResourceUids) {
      if (
        !context.filesByKey.has(`chapter_body:${chapterUid}`)
        || !context.filesByKey.has(`chapter_sidecar:${chapterUid}`)
      ) {
        manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'chapter_pair' });
      }
    }

    for (const file of context.canonicalFiles) {
      if (file.role === 'volume_index') {
        if (revokedIgnored.has(`volume:${file.resourceUid}`)) {
          manuscriptFailure('EXTERNAL_RESOURCE_CREATION_UNSUPPORTED', {
            kind: 'volume',
            uid: file.resourceUid,
          });
        }
        knownResourceOrExternal(file.resourceUid, known.volume, activeIgnored, 'volume');
      } else if (file.role === 'chapter_body' || file.role === 'chapter_sidecar') {
        if (revokedIgnored.has(`chapter:${file.resourceUid}`)) {
          manuscriptFailure('EXTERNAL_RESOURCE_CREATION_UNSUPPORTED', {
            kind: 'chapter',
            uid: file.resourceUid,
          });
        }
      }
    }

    const ignoredIndexedContainers = new Map();
    function recordIgnoredIndexedContainer(kind, uid, container) {
      const key = `${kind}:${uid}`;
      if (!activeIgnored.has(key)) return;
      if (ignoredIndexedContainers.has(key)) {
        manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'ignored_ownership' });
      }
      ignoredIndexedContainers.set(key, container);
    }
    const readSnapshots = new Map();
    async function readKey(key) {
      if (readSnapshots.has(key)) return readSnapshots.get(key);
      const file = context.filesByKey.get(key);
      if (file === undefined) return null;
      const kind = file.role === 'volume_index' ? 'volume' : 'chapter';
      if (
        file.resourceUid !== null
        && activeIgnored.has(`${kind}:${file.resourceUid}`)
      ) {
        return null;
      }
      const read = await this.readControlledFile(enumeration.treeIdentity, file.ref);
      readSnapshots.set(key, read);
      return read;
    }
    const boundReadKey = readKey.bind(this);

    const manuscript = await boundReadKey('manuscript');
    const unassigned = await boundReadKey('unassigned');
    if (manuscript === null || unassigned === null) {
      manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'structure_root' });
    }

    const volumeSnapshots = new Map();
    for (const file of context.canonicalFiles) {
      if (file.role !== 'volume_index') continue;
      const read = await boundReadKey(logicalRefKey(file.ref));
      if (read !== null) volumeSnapshots.set(file.resourceUid, read);
    }

    const referencedVolumes = new Set();
    const volumeOrder = [];
    for (const volumeUid of manuscript.parsed.volume_uids) {
      if (activeIgnored.has(`volume:${volumeUid}`)) {
        recordIgnoredIndexedContainer('volume', volumeUid, Object.freeze({
          kind: 'manuscript',
          uid: null,
        }));
        continue;
      }
      if (!known.volume.has(volumeUid)) {
        manuscriptFailure('EXTERNAL_RESOURCE_CREATION_UNSUPPORTED', {
          kind: 'volume',
          uid: volumeUid,
        });
      }
      const volume = volumeSnapshots.get(volumeUid);
      if (volume === undefined) {
        manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'volume_index' });
      }
      referencedVolumes.add(volumeUid);
      volumeOrder.push(volumeUid);
    }
    for (const volumeUid of volumeSnapshots.keys()) {
      if (!referencedVolumes.has(volumeUid)) {
        manuscriptFailure('EXTERNAL_RESOURCE_CREATION_UNSUPPORTED', {
          kind: 'volume',
          uid: volumeUid,
        });
      }
    }

    const chapterContainers = new Map();
    const referencedChapters = new Set();
    function registerChapter(chapterUid, container) {
      if (referencedChapters.has(chapterUid)) {
        manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'chapter_ownership' });
      }
      referencedChapters.add(chapterUid);
      if (activeIgnored.has(`chapter:${chapterUid}`)) {
        recordIgnoredIndexedContainer('chapter', chapterUid, Object.freeze({
          kind: container.kind,
          uid: container.volumeUid,
        }));
        return;
      }
      chapterContainers.set(chapterUid, container);
    }
    for (const volumeUid of volumeOrder) {
      const volume = volumeSnapshots.get(volumeUid);
      for (const chapterUid of volume.parsed.chapter_uids) {
        registerChapter(chapterUid, Object.freeze({ kind: 'volume', volumeUid }));
      }
    }
    for (const chapterUid of unassigned.parsed.chapter_uids) {
      registerChapter(chapterUid, Object.freeze({ kind: 'unassigned', volumeUid: null }));
    }

    for (const chapterUid of chapterContainers.keys()) {
      if (
        !context.filesByKey.has(`chapter_body:${chapterUid}`)
        || !context.filesByKey.has(`chapter_sidecar:${chapterUid}`)
      ) {
        manuscriptFailure('MANUSCRIPT_FILESET_INVALID', { role: 'chapter_pair' });
      }
    }
    for (const chapterUid of chapterResourceUids) {
      knownResourceOrExternal(chapterUid, known.chapter, activeIgnored, 'chapter');
      if (!chapterContainers.has(chapterUid)) {
        manuscriptFailure('EXTERNAL_RESOURCE_CREATION_UNSUPPORTED', {
          kind: 'chapter',
          uid: chapterUid,
        });
      }
    }

    const bodySnapshots = new Map();
    const sidecarSnapshots = new Map();
    for (const file of context.canonicalFiles) {
      if (file.role !== 'chapter_body' && file.role !== 'chapter_sidecar') continue;
      const read = await boundReadKey(logicalRefKey(file.ref));
      if (read === null) continue;
      const target = file.role === 'chapter_body' ? bodySnapshots : sidecarSnapshots;
      target.set(file.resourceUid, read);
    }

    const ignoredMemberObservations = ignoredLedger.entries.map((entry) => (
      ignoredObservation(
        entry,
        context.filesByKey,
        ignoredIndexedContainers.get(`${entry.kind}:${entry.uid}`) ?? null,
      )
    ));

    const controlledSnapshots = [manuscript, unassigned];
    for (const volumeUid of volumeOrder) controlledSnapshots.push(volumeSnapshots.get(volumeUid));
    for (const chapterUid of chapterContainers.keys()) {
      controlledSnapshots.push(bodySnapshots.get(chapterUid), sidecarSnapshots.get(chapterUid));
    }
    const controlledFiles = controlledSnapshots
      .map(fileMetadataFromSnapshot)
      .sort(sortFileFacts);
    const capacitySnapshot = accumulator.snapshot();
    const publicSnapshot = deepFreeze({
      capacitySnapshot,
      classifications: {
        controlled: controlledFiles.map((file) => file.ref),
        journalCandidates: enumeration.classifications.journalCandidates,
        orphan: [],
        residues: enumeration.classifications.residues,
      },
      controlledFiles,
      ignoredMemberObservations,
      projectUid: context.binding.projectUid,
      treeIdentity: enumeration.treeIdentity,
      warnings: capacitySnapshot.warnings,
    });
    validatedSnapshotRecords.set(publicSnapshot, {
      bodySnapshots,
      chapterContainers,
      ignoredMemberObservations,
      manuscript,
      sidecarSnapshots,
      store: this,
      unassigned,
      volumeOrder,
      volumeSnapshots,
    });
    return publicSnapshot;
  }

  async buildProjectionCandidate(snapshot) {
    const validated = validatedSnapshotRecords.get(snapshot);
    if (validated === undefined || validated.store !== this) {
      throw new TypeError('snapshot must be produced by this ManuscriptStore.validateFull');
    }
    const volumes = validated.volumeOrder.map((volumeUid, index) => {
      const parsed = validated.volumeSnapshots.get(volumeUid).parsed;
      return {
        summary: parsed.summary,
        title: parsed.title,
        volumePosition: index + 1,
        volumeUid,
      };
    });
    const chapters = [];
    let manuscriptPosition = 0;
    function appendChapter(chapterUid, volumeUid, chapterPosition) {
      manuscriptPosition += 1;
      const body = validated.bodySnapshots.get(chapterUid);
      const sidecar = validated.sidecarSnapshots.get(chapterUid);
      const metadata = sidecar.parsed;
      chapters.push({
        bodyFileIdentity: body.fileIdentity,
        bodyRawSha256: body.rawSha256,
        chapterPosition,
        chapterUid,
        cognitiveFrame: metadata.cognitive_frame,
        concreteMystery: metadata.concrete_mystery,
        content: body.parsed.content,
        contentAvailable: body.parsed.contentAvailable,
        emotionalAnchor: metadata.emotional_anchor,
        interpersonalTension: metadata.interpersonal_tension,
        manuscriptPosition,
        markdownMode: body.parsed.mode,
        outline: metadata.outline,
        sidecarFileIdentity: sidecar.fileIdentity,
        sidecarRawSha256: sidecar.rawSha256,
        status: metadata.status,
        summary: metadata.summary,
        title: metadata.title,
        volumeUid,
        wordCount: body.parsed.wordCount,
        worldTexture: metadata.world_texture,
      });
    }
    for (const volumeUid of validated.volumeOrder) {
      const volume = validated.volumeSnapshots.get(volumeUid).parsed;
      let chapterPosition = 0;
      for (const chapterUid of volume.chapter_uids) {
        if (!validated.chapterContainers.has(chapterUid)) continue;
        chapterPosition += 1;
        appendChapter(chapterUid, volumeUid, chapterPosition);
      }
    }
    let unassignedPosition = 0;
    for (const chapterUid of validated.unassigned.parsed.chapter_uids) {
      if (!validated.chapterContainers.has(chapterUid)) continue;
      unassignedPosition += 1;
      appendChapter(chapterUid, null, unassignedPosition);
    }
    const candidate = deepFreeze({
      capacitySnapshot: snapshot.capacitySnapshot,
      chapters,
      controlledFiles: snapshot.controlledFiles,
      diagnostics: {
        journalCandidates: snapshot.classifications.journalCandidates,
        residues: snapshot.classifications.residues,
      },
      ignoredLedgerAfter: snapshot.ignoredMemberObservations,
      projectUid: snapshot.projectUid,
      volumeOrder: [...validated.volumeOrder],
      volumes,
      warnings: snapshot.warnings,
    });
    projectionCandidateRecords.set(candidate, Object.freeze({ snapshot, store: this }));
    return candidate;
  }

  async buildClosure(snapshot, mutation, ignoredRows, identityReservation) {
    if (arguments.length !== 4) {
      throw new TypeError('buildClosure requires an explicit identityReservation argument');
    }
    const migrationKindDescriptor = isPlainObject(mutation)
      ? Object.getOwnPropertyDescriptor(mutation, 'kind')
      : undefined;
    if (
      migrationKindDescriptor?.enumerable === true
      && Object.hasOwn(migrationKindDescriptor, 'value')
      && migrationKindDescriptor.value === 'creation.empty_bootstrap'
    ) {
      return compileCreationEmptyBootstrap(
        this,
        snapshot,
        mutation,
        ignoredRows,
        identityReservation,
      );
    }
    if (
      migrationKindDescriptor?.enumerable === true
      && Object.hasOwn(migrationKindDescriptor, 'value')
      && migrationKindDescriptor.value === 'migration.full_snapshot'
    ) {
      return compileMigrationFullSnapshot(
        this,
        snapshot,
        mutation,
        ignoredRows,
        identityReservation,
      );
    }
    const validated = validatedSnapshotRecords.get(snapshot);
    if (validated === undefined || validated.store !== this) {
      throw new TypeError('snapshot must be produced by this ManuscriptStore.validateFull');
    }
    const pathContext = treeIdentityRecords.get(snapshot.treeIdentity);
    if (pathContext === undefined || pathContext.store !== this) {
      throw new TypeError('snapshot tree identity is not owned by this ManuscriptStore');
    }
    const rows = assertIgnoredRowsMatchSnapshot(validated, ignoredRows);
    const { changes, structure } = compileMutation(
      validated,
      snapshot.projectUid,
      mutation,
      rows,
      identityReservation,
      pathContext,
    );
    const changesByKey = new Map(changes.map((change) => [
      logicalRefKey(change.before.ref),
      change,
    ]));
    const baseCandidate = await this.buildProjectionCandidate(snapshot);
    const controlledFiles = controlledFilesAfter(baseCandidate, changesByKey);
    const capacitySnapshot = capacityAfter(
      this,
      snapshot,
      controlledFiles,
      structure.ignoredObservations,
      changes,
    );
    const closure = [];
    for (const change of changes) {
      if (change.beforeAbsent === true) {
        closure.push(Object.freeze({
          after: closureEndpoint(change.afterBytes, change.rawSha256),
          before: ABSENT_BEFORE_CLOSURE_ENDPOINT,
          parentIdentity: change.before.parentIdentity,
          ref: change.before.ref,
        }));
        continue;
      }
      let current;
      try {
        current = await readControlledFileInternal(this, snapshot.treeIdentity, change.before.ref);
      } catch (cause) {
        throw manuscriptError('EXTERNAL_CHANGE_CONFLICT', { role: change.before.role }, cause);
      }
      if (
        current.snapshot.byteSize !== change.before.byteSize
        || current.bytes.length !== change.before.byteSize
        || current.snapshot.rawSha256 !== change.before.rawSha256
        || !sameIdentity(current.snapshot.fileIdentity, change.before.fileIdentity)
        || !sameIdentity(current.snapshot.parentIdentity, change.before.parentIdentity)
      ) {
        throw manuscriptError('EXTERNAL_CHANGE_CONFLICT', { role: change.before.role });
      }
      closure.push(Object.freeze({
        after: change.afterBytes === null
          ? ABSENT_CLOSURE_ENDPOINT
          : closureEndpoint(change.afterBytes, change.rawSha256),
        before: closureEndpoint(
          current.bytes,
          change.before.rawSha256,
          change.before.fileIdentity,
        ),
        parentIdentity: change.before.parentIdentity,
        ref: change.before.ref,
      }));
    }
    const candidateTemplate = candidateAfter(
      baseCandidate,
      changesByKey,
      controlledFiles,
      capacitySnapshot,
      structure,
    );
    const buildResult = Object.freeze({
      closure: Object.freeze(closure),
      candidateTemplate,
    });
    buildResultRecords.set(buildResult, {
      expected: new Map(changes.filter((change) => change.afterBytes !== null).map((change) => [
        logicalRefKey(change.before.ref),
        Object.freeze({
          byteSize: change.afterBytes.length,
          parentIdentity: change.before.parentIdentity,
          rawSha256: change.rawSha256,
        }),
      ])),
      store: this,
    });
    return buildResult;
  }

  finalizeCandidate(buildResult, stagedAfterFacts) {
    const build = buildResultRecords.get(buildResult);
    if (build === undefined || build.store !== this) {
      throw new TypeError('buildResult must be produced by this ManuscriptStore.buildClosure');
    }
    const staged = assertDenseFrozenArray(stagedAfterFacts, 'stagedAfterFacts');
    const stagedByKey = new Map();
    for (let index = 0; index < staged.length; index += 1) {
      const input = staged[index];
      if (!Object.isFrozen(input)) {
        throw new TypeError(`stagedAfterFacts[${index}] must be frozen`);
      }
      const descriptors = dataDescriptors(input, `stagedAfterFacts[${index}]`);
      assertExactKeys(descriptors, [
        'ref',
        'byteSize',
        'rawSha256',
        'fileIdentity',
        'parentIdentity',
      ], `stagedAfterFacts[${index}]`);
      const ref = assertControlledFileRef(descriptorValue(descriptors, 'ref'));
      if (ref.projectUid !== buildResult.candidateTemplate.projectUid) {
        throw new TypeError('stagedAfterFacts ref belongs to another project');
      }
      const key = logicalRefKey(ref);
      if (stagedByKey.has(key)) throw new TypeError('stagedAfterFacts contains a duplicate ref');
      const expected = build.expected.get(key);
      if (expected === undefined) {
        throw new TypeError('stagedAfterFacts contains an unexpected ref');
      }
      const byteSize = descriptorValue(descriptors, 'byteSize');
      const rawSha256 = descriptorValue(descriptors, 'rawSha256');
      const fileIdentityValue = descriptorValue(descriptors, 'fileIdentity');
      const parentIdentityValue = descriptorValue(descriptors, 'parentIdentity');
      if (
        !Number.isSafeInteger(byteSize)
        || byteSize < 0
        || typeof rawSha256 !== 'string'
        || !SHA256_PATTERN.test(rawSha256)
        || !Object.isFrozen(fileIdentityValue)
        || !Object.isFrozen(parentIdentityValue)
      ) {
        throw new TypeError('stagedAfterFacts contains invalid file facts');
      }
      const fileIdentity = snapshotIdentity(
        fileIdentityValue,
        `stagedAfterFacts[${index}].fileIdentity`,
      );
      const parentIdentity = snapshotIdentity(
        parentIdentityValue,
        `stagedAfterFacts[${index}].parentIdentity`,
      );
      if (
        byteSize !== expected.byteSize
        || rawSha256 !== expected.rawSha256
        || !sameIdentity(parentIdentity, expected.parentIdentity)
      ) {
        throw new TypeError('stagedAfterFacts does not match the compiled after facts');
      }
      stagedByKey.set(key, fileIdentity);
    }
    if (stagedByKey.size !== build.expected.size) {
      throw new TypeError('stagedAfterFacts does not exactly cover compiled after-present refs');
    }

    const template = buildResult.candidateTemplate;
    const controlledFiles = template.controlledFiles.map((fact) => {
      if (fact.fileIdentity !== null) return { ...fact };
      const stagedIdentity = stagedByKey.get(logicalRefKey(fact.ref));
      if (stagedIdentity === undefined) {
        throw new TypeError('stagedAfterFacts is missing a changed controlled ref');
      }
      return { ...fact, fileIdentity: stagedIdentity };
    }).sort(sortCandidateFileFacts);
    const factsByKey = new Map(controlledFiles.map((fact) => [logicalRefKey(fact.ref), fact]));
    const chapters = template.chapters.map((chapter) => {
      const body = factsByKey.get(`chapter_body:${chapter.chapterUid}`);
      const sidecar = factsByKey.get(`chapter_sidecar:${chapter.chapterUid}`);
      if (body === undefined || sidecar === undefined) {
        throw new TypeError('candidate template chapter facts are incomplete');
      }
      return {
        ...chapter,
        bodyFileIdentity: body.fileIdentity,
        sidecarFileIdentity: sidecar.fileIdentity,
      };
    });
    return deepFreeze({
      capacitySnapshot: template.capacitySnapshot,
      chapters,
      controlledFiles,
      diagnostics: template.diagnostics,
      ignoredLedgerAfter: template.ignoredLedgerAfter,
      projectUid: template.projectUid,
      volumeOrder: [...template.volumeOrder],
      volumes: template.volumes.map((volume) => ({ ...volume })),
      warnings: template.warnings,
    });
  }
}

module.exports = {
  ManuscriptStore,
};
