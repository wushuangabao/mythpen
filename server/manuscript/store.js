'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const {
  LIMITS,
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
  requireFileBoundaryCapability,
  requireJournalAuthorityCapability,
} = require('./capability-registry');
const {
  assertControlledFileRef,
  classifyTreeEntry,
  createDirectoryNameIndex,
  deriveControlledFileRef,
  deriveManuscriptPaths,
  verifyManuscriptPathIdentity,
} = require('./paths');

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
});
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const storeRecords = new WeakMap();
const treeIdentityRecords = new WeakMap();
const validatedSnapshotRecords = new WeakMap();
const buildResultRecords = new WeakMap();

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
  treeIdentityRecords.set(treeIdentity, { ...context, store });
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

function ignoredObservation(entry, filesByKey) {
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
  if (typeof content !== 'string') throw new TypeError('body content must be a string');
  if (before.parsed.mode !== 'visual') {
    manuscriptFailure('UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE', {
      chapterUid: before.resourceUid,
    });
  }
  const afterBytes = Buffer.from(content, 'utf8');
  const afterParsed = inspectMarkdown(afterBytes);
  if (
    afterParsed.mode !== 'visual'
    || afterParsed.contentAvailable !== true
    || afterParsed.content !== content
  ) {
    manuscriptFailure('UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE', {
      chapterUid: before.resourceUid,
    });
  }
  if (afterParsed.rawSha256 === before.rawSha256) return null;
  return Object.freeze({
    afterBytes,
    afterParsed: deepFreeze(afterParsed),
    before,
    rawSha256: afterParsed.rawSha256,
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

function compileMutation(validated, projectUid, value) {
  const descriptors = dataDescriptors(value, 'mutation');
  const kind = descriptorValue(descriptors, 'kind');
  const fields = MUTATION_FIELDS[kind];
  if (fields === undefined) {
    throw new TypeError('mutation kind is not supported by the Task 7A closure compiler');
  }
  assertExactKeys(descriptors, ['kind', ...fields], 'mutation');
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
  const volume = fields.includes('volumeRef')
    ? validatedFileForRef(
      validated,
      descriptorValue(descriptors, 'volumeRef'),
      'volume_index',
      projectUid,
    )
    : null;
  if (body !== null && sidecar !== null && body.resourceUid !== sidecar.resourceUid) {
    throw new TypeError('combined body and sidecar refs must name the same chapter');
  }
  return [
    body === null ? null : compileBodyChange(body, descriptorValue(descriptors, 'content')),
    sidecar === null ? null : compileJsonChange(
      sidecar,
      descriptorValue(descriptors, 'patch'),
      SIDECAR_PATCH_FIELDS,
    ),
    volume === null ? null : compileJsonChange(
      volume,
      descriptorValue(descriptors, 'patch'),
      VOLUME_PATCH_FIELDS,
    ),
  ].filter((change) => change !== null)
    .sort((left, right) => sortFileFacts(left.before, right.before));
}

function controlledFilesAfter(baseCandidate, changesByKey) {
  return baseCandidate.controlledFiles.map((fact) => {
    const change = changesByKey.get(logicalRefKey(fact.ref));
    if (change === undefined) return { ...fact };
    return {
      ...fact,
      byteSize: change.afterBytes.length,
      fileIdentity: null,
      rawSha256: change.rawSha256,
    };
  }).sort(sortCandidateFileFacts);
}

function capacityAfter(store, snapshot, controlledFiles, ignoredMemberObservations) {
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
  const measurements = {
    ...snapshot.capacitySnapshot.measurements,
    controlledBytes,
    controlledFiles: allFiles.length,
    jsonBytes,
    markdownBytes,
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
  return deepFreeze({
    counters: { ...context.accumulator.snapshot().counters },
    error: null,
    measurements,
    state: 'active',
    warnings: [...snapshot.capacitySnapshot.warnings],
  });
}

function candidateAfter(baseCandidate, changesByKey, controlledFiles, capacitySnapshot) {
  const chapters = baseCandidate.chapters.map((chapter) => {
    const body = changesByKey.get(`chapter_body:${chapter.chapterUid}`);
    const sidecar = changesByKey.get(`chapter_sidecar:${chapter.chapterUid}`);
    const result = { ...chapter };
    if (body !== undefined) {
      result.bodyFileIdentity = null;
      result.bodyRawSha256 = body.rawSha256;
      result.content = body.afterParsed.content;
      result.contentAvailable = body.afterParsed.contentAvailable;
      result.markdownMode = body.afterParsed.mode;
      result.wordCount = body.afterParsed.wordCount;
    }
    if (sidecar !== undefined) {
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
    return result;
  });
  const volumes = baseCandidate.volumes.map((volume) => {
    const change = changesByKey.get(`volume_index:${volume.volumeUid}`);
    if (change === undefined) return { ...volume };
    return {
      ...volume,
      summary: change.afterParsed.summary,
      title: change.afterParsed.title,
    };
  });
  return deepFreeze({
    capacitySnapshot,
    chapters,
    controlledFiles,
    diagnostics: baseCandidate.diagnostics,
    ignoredLedgerAfter: baseCandidate.ignoredLedgerAfter,
    projectUid: baseCandidate.projectUid,
    volumeOrder: [...baseCandidate.volumeOrder],
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

class ManuscriptStore {
  constructor({
    dataRoot,
    fileBoundary,
    journalAuthority,
    limits = LIMITS,
    capacityObserver,
  } = {}) {
    const safeDataRoot = assertCanonicalDataRoot(dataRoot);
    const boundary = requireFileBoundaryCapability(fileBoundary).methods;
    const authority = requireJournalAuthorityCapability(journalAuthority).methods;
    if (capacityObserver !== undefined && typeof capacityObserver !== 'function') {
      throw new TypeError('capacityObserver must be a function');
    }
    createCapacityAccumulator(limits);
    storeRecords.set(this, {
      capacityObserver,
      dataRoot: safeDataRoot,
      fileBoundary: boundary,
      journalAuthority: authority,
      limits: { ...limits },
      nextScanEpoch: 0,
    });
  }

  async enumerateAndClassify(identity) {
    const result = await enumerateInternal(this, identity, createAccumulator(storeRecords.get(this)));
    return result.snapshot;
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
    const known = identitySets(lifecycleBasis);
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

    const ignoredMemberObservations = ignoredLedger.entries.map((entry) => (
      ignoredObservation(entry, context.filesByKey)
    ));
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
      if (activeIgnored.has(`volume:${volumeUid}`)) continue;
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
      if (activeIgnored.has(`chapter:${chapterUid}`)) return;
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
    return deepFreeze({
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
  }

  async buildClosure(snapshot, mutation) {
    const validated = validatedSnapshotRecords.get(snapshot);
    if (validated === undefined || validated.store !== this) {
      throw new TypeError('snapshot must be produced by this ManuscriptStore.validateFull');
    }
    const changes = compileMutation(validated, snapshot.projectUid, mutation);
    const changesByKey = new Map(changes.map((change) => [
      logicalRefKey(change.before.ref),
      change,
    ]));
    const baseCandidate = await this.buildProjectionCandidate(snapshot);
    const controlledFiles = controlledFilesAfter(baseCandidate, changesByKey);
    let capacitySnapshot = capacityAfter(
      this,
      snapshot,
      controlledFiles,
      validated.ignoredMemberObservations,
    );
    const closure = [];
    for (const change of changes) {
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
        after: closureEndpoint(change.afterBytes, change.rawSha256),
        before: closureEndpoint(
          current.bytes,
          change.before.rawSha256,
          change.before.fileIdentity,
        ),
        parentIdentity: change.before.parentIdentity,
        ref: change.before.ref,
      }));
    }
    if (changes.length > 0) {
      capacitySnapshot = capacityAfter(
        this,
        snapshot,
        controlledFiles,
        validated.ignoredMemberObservations,
      );
    }
    const candidateTemplate = candidateAfter(
      baseCandidate,
      changesByKey,
      controlledFiles,
      capacitySnapshot,
    );
    const buildResult = Object.freeze({
      closure: Object.freeze(closure),
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
