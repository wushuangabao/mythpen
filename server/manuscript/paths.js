'use strict';

const path = require('node:path');

const {
  assertCanonicalUuid,
  manuscriptError,
} = require('./contracts');

const UUID_V4_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const VOLUME_NAME_PATTERN = new RegExp(`^vol_(${UUID_V4_SOURCE})\\.json$`);
const CHAPTER_BODY_NAME_PATTERN = new RegExp(`^ch_(${UUID_V4_SOURCE})\\.md$`);
const CHAPTER_SIDECAR_NAME_PATTERN = new RegExp(`^ch_(${UUID_V4_SOURCE})\\.json$`);

const DIRECTORY_ROLES = new Set(['mythpen', 'volumes', 'chapters']);
const CONTROLLED_FILE_ROLES = new Set([
  'manuscript',
  'unassigned',
  'volume_index',
  'chapter_body',
  'chapter_sidecar',
]);
const TARGET_ROLES = new Set([
  'article_root',
  'mythpen_root',
  'volumes_directory',
  'chapters_directory',
  'controlled_file',
]);

const pathSetBrands = new WeakSet();
const controlledFileRefBrands = new WeakSet();
const directoryNameIndexRecords = new WeakMap();
const UNCONTROLLED_RESIDUE = Object.freeze({ classification: 'uncontrolled_residue' });

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

function assertExactDescriptorKeys(descriptors, expectedKeys, label) {
  const actualKeys = Object.keys(descriptors).sort();
  const sortedExpected = expectedKeys.slice().sort();
  if (
    actualKeys.length !== sortedExpected.length
    || actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function descriptorValue(descriptors, key) {
  return descriptors[key]?.value;
}

function assertCanonicalAbsolutePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
  ) {
    throw new TypeError(`${label} must be an absolute canonical path`);
  }
  return value;
}

function assertBrandedPaths(paths) {
  if (paths === null || typeof paths !== 'object' || !pathSetBrands.has(paths)) {
    throw new TypeError('paths must be derived by deriveManuscriptPaths');
  }
  return paths;
}

function deriveManuscriptPaths(input) {
  const descriptors = dataDescriptors(input, 'manuscript path input');
  assertExactDescriptorKeys(descriptors, ['dataRoot', 'projectUid'], 'manuscript path input');
  const dataRoot = assertCanonicalAbsolutePath(
    descriptorValue(descriptors, 'dataRoot'),
    'dataRoot',
  );
  const projectUid = assertCanonicalUuid(
    descriptorValue(descriptors, 'projectUid'),
    'project_uid',
  );
  const manuscriptsRoot = path.join(dataRoot, 'manuscripts');
  const articleRoot = path.join(manuscriptsRoot, projectUid);
  const mythpenRoot = path.join(articleRoot, 'mythpen');
  const paths = {
    articleRoot,
    chaptersRoot: path.join(mythpenRoot, 'chapters'),
    dataRoot,
    manuscriptPath: path.join(mythpenRoot, 'manuscript.json'),
    manuscriptsRoot,
    mythpenRoot,
    projectUid,
    unassignedPath: path.join(mythpenRoot, 'unassigned.json'),
    volumesRoot: path.join(mythpenRoot, 'volumes'),
  };
  pathSetBrands.add(paths);
  return Object.freeze(paths);
}

function deriveVolumePath(paths, volumeUid) {
  const safePaths = assertBrandedPaths(paths);
  const safeVolumeUid = assertCanonicalUuid(volumeUid, 'volume_uid');
  return path.join(safePaths.volumesRoot, `vol_${safeVolumeUid}.json`);
}

function deriveChapterPaths(paths, chapterUid) {
  const safePaths = assertBrandedPaths(paths);
  const safeChapterUid = assertCanonicalUuid(chapterUid, 'chapter_uid');
  return Object.freeze({
    bodyPath: path.join(safePaths.chaptersRoot, `ch_${safeChapterUid}.md`),
    sidecarPath: path.join(safePaths.chaptersRoot, `ch_${safeChapterUid}.json`),
  });
}

function expectedRefKeys(role) {
  if (role === 'manuscript' || role === 'unassigned') {
    return ['role', 'projectUid'];
  }
  if (role === 'volume_index') {
    return ['role', 'projectUid', 'volumeUid'];
  }
  if (role === 'chapter_body' || role === 'chapter_sidecar') {
    return ['role', 'projectUid', 'chapterUid'];
  }
  throw new TypeError('controlled file role is invalid');
}

function deriveControlledFileRef(input) {
  const descriptors = dataDescriptors(input, 'controlled file reference input');
  const role = descriptorValue(descriptors, 'role');
  if (typeof role !== 'string' || !CONTROLLED_FILE_ROLES.has(role)) {
    throw new TypeError('controlled file role is invalid');
  }
  const keys = expectedRefKeys(role);
  assertExactDescriptorKeys(descriptors, keys, 'controlled file reference input');
  const projectUid = assertCanonicalUuid(
    descriptorValue(descriptors, 'projectUid'),
    'project_uid',
  );
  const ref = { role, projectUid };
  if (role === 'volume_index') {
    ref.volumeUid = assertCanonicalUuid(
      descriptorValue(descriptors, 'volumeUid'),
      'volume_uid',
    );
  }
  if (role === 'chapter_body' || role === 'chapter_sidecar') {
    ref.chapterUid = assertCanonicalUuid(
      descriptorValue(descriptors, 'chapterUid'),
      'chapter_uid',
    );
  }
  controlledFileRefBrands.add(ref);
  return Object.freeze(ref);
}

function assertControlledFileRef(ref) {
  if (ref === null || typeof ref !== 'object' || !controlledFileRefBrands.has(ref)) {
    throw new TypeError('controlledFileRef must be created by deriveControlledFileRef');
  }
  return ref;
}

function resolveControlledFileRef(paths, controlledFileRef) {
  const safePaths = assertBrandedPaths(paths);
  const ref = assertControlledFileRef(controlledFileRef);
  if (ref.projectUid !== safePaths.projectUid) {
    throw new TypeError('controlledFileRef belongs to a different project');
  }
  if (ref.role === 'manuscript') return safePaths.manuscriptPath;
  if (ref.role === 'unassigned') return safePaths.unassignedPath;
  if (ref.role === 'volume_index') return deriveVolumePath(safePaths, ref.volumeUid);
  const chapterPaths = deriveChapterPaths(safePaths, ref.chapterUid);
  return ref.role === 'chapter_body' ? chapterPaths.bodyPath : chapterPaths.sidecarPath;
}

function canonicalShape(directoryRole, actualName) {
  if (directoryRole === 'mythpen') {
    if (actualName === 'manuscript.json') {
      return Object.freeze({ classification: 'canonical_shape', role: 'manuscript' });
    }
    if (actualName === 'unassigned.json') {
      return Object.freeze({ classification: 'canonical_shape', role: 'unassigned' });
    }
    return null;
  }
  if (directoryRole === 'volumes') {
    const match = VOLUME_NAME_PATTERN.exec(actualName);
    return match === null
      ? null
      : Object.freeze({
        classification: 'canonical_shape',
        role: 'volume_index',
        volumeUid: match[1],
      });
  }
  const bodyMatch = CHAPTER_BODY_NAME_PATTERN.exec(actualName);
  if (bodyMatch !== null) {
    return Object.freeze({
      chapterUid: bodyMatch[1],
      classification: 'canonical_shape',
      role: 'chapter_body',
    });
  }
  const sidecarMatch = CHAPTER_SIDECAR_NAME_PATTERN.exec(actualName);
  return sidecarMatch === null
    ? null
    : Object.freeze({
      chapterUid: sidecarMatch[1],
      classification: 'canonical_shape',
      role: 'chapter_sidecar',
    });
}

function isSafeJournalAtom(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/[.\\/]/u.test(value);
}

function exactEntryShape(directoryRole, actualName) {
  const direct = canonicalShape(directoryRole, actualName);
  if (direct !== null) return direct;
  if (!actualName.endsWith('.tmp')) return null;
  const withoutSuffix = actualName.slice(0, -4);
  const separator = withoutSuffix.lastIndexOf('.');
  if (separator < 0) return null;
  const canonicalName = withoutSuffix.slice(0, separator);
  const journalId = withoutSuffix.slice(separator + 1);
  if (!isSafeJournalAtom(journalId)) return null;
  const target = canonicalShape(directoryRole, canonicalName);
  if (target === null) return null;
  const { classification: _classification, ...targetFields } = target;
  return Object.freeze({
    ...targetFields,
    classification: 'journal_candidate_shape',
    journalId,
    requiresJournalEvidence: true,
  });
}

function foldedEntryName(actualName) {
  return actualName
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ .]+$/u, '');
}

function classifyTreeEntry(input) {
  const descriptors = dataDescriptors(input, 'tree entry input');
  assertExactDescriptorKeys(descriptors, ['directoryRole', 'actualName'], 'tree entry input');
  const directoryRole = descriptorValue(descriptors, 'directoryRole');
  const actualName = descriptorValue(descriptors, 'actualName');
  if (typeof directoryRole !== 'string' || !DIRECTORY_ROLES.has(directoryRole)) {
    throw new TypeError('directoryRole is invalid');
  }
  if (
    typeof actualName !== 'string'
    || actualName.length === 0
    || actualName.includes('\0')
    || /[\\/]/u.test(actualName)
  ) {
    throw new TypeError('actualName must be one directory entry name');
  }
  const exact = exactEntryShape(directoryRole, actualName);
  if (exact !== null) return exact;
  const folded = foldedEntryName(actualName);
  if (folded !== actualName && exactEntryShape(directoryRole, folded) !== null) {
    throw manuscriptError('MANUSCRIPT_FILESET_INVALID', { role: directoryRole });
  }
  return UNCONTROLLED_RESIDUE;
}

function snapshotIdentity(value, label) {
  const descriptors = dataDescriptors(value, label);
  assertExactDescriptorKeys(descriptors, ['dev', 'ino'], label);
  const dev = descriptorValue(descriptors, 'dev');
  const ino = descriptorValue(descriptors, 'ino');
  if (
    typeof dev !== 'string'
    || !/^[0-9]+$/.test(dev)
    || typeof ino !== 'string'
    || !/^[0-9]+$/.test(ino)
  ) {
    throw new TypeError(`${label} must contain decimal dev and ino strings`);
  }
  return Object.freeze({ dev, ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathError(code, role, cause) {
  return manuscriptError(code, { role }, cause);
}

function identityTarget(paths, targetRole, controlledFileRef) {
  if (targetRole === 'article_root') {
    return { expectedKind: 'directory', path: paths.articleRoot };
  }
  if (targetRole === 'mythpen_root') {
    return { expectedKind: 'directory', path: paths.mythpenRoot };
  }
  if (targetRole === 'volumes_directory') {
    return { expectedKind: 'directory', path: paths.volumesRoot };
  }
  if (targetRole === 'chapters_directory') {
    return { expectedKind: 'directory', path: paths.chaptersRoot };
  }
  return {
    expectedKind: 'file',
    path: resolveControlledFileRef(paths, controlledFileRef),
  };
}

function snapshotObservation(value, label) {
  const descriptors = dataDescriptors(value, label);
  assertExactDescriptorKeys(descriptors, [
    'actualName',
    'identity',
    'kind',
    'linkCount',
    'parentIdentity',
    'parentRealPath',
    'realPath',
    'reparse',
  ], label);
  const actualName = descriptorValue(descriptors, 'actualName');
  const kind = descriptorValue(descriptors, 'kind');
  const linkCount = descriptorValue(descriptors, 'linkCount');
  const parentRealPath = descriptorValue(descriptors, 'parentRealPath');
  const realPath = descriptorValue(descriptors, 'realPath');
  const reparse = descriptorValue(descriptors, 'reparse');
  if (
    typeof actualName !== 'string'
    || actualName.length === 0
    || /[\\/]/u.test(actualName)
    || (kind !== 'file' && kind !== 'directory')
    || (linkCount !== null && (!Number.isSafeInteger(linkCount) || linkCount < 1))
    || typeof parentRealPath !== 'string'
    || typeof realPath !== 'string'
    || typeof reparse !== 'boolean'
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze({
    actualName,
    identity: snapshotIdentity(descriptorValue(descriptors, 'identity'), `${label}.identity`),
    kind,
    linkCount,
    parentIdentity: snapshotIdentity(
      descriptorValue(descriptors, 'parentIdentity'),
      `${label}.parentIdentity`,
    ),
    parentRealPath,
    realPath,
    reparse,
  });
}

function assertIdentityBoundary(value) {
  const descriptors = dataDescriptors(value, 'identityBoundary');
  const inspectPath = descriptorValue(descriptors, 'inspectPath');
  if (typeof inspectPath !== 'function') {
    throw new TypeError('identityBoundary.inspectPath is required');
  }
  return Object.freeze({ inspectPath });
}

function snapshotActualNames(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError('actualNames must be a plain dense array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
    throw new TypeError('actualNames must be a plain dense array');
  }

  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError('actualNames must contain data properties only');
    }
    const name = descriptor.value;
    if (
      typeof name !== 'string'
      || name.length === 0
      || name.includes('\0')
      || /[\\/]/u.test(name)
    ) {
      throw new TypeError('actualNames contains an invalid entry name');
    }
    snapshot.push(name);
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      throw new TypeError('actualNames must be a plain dense array');
    }
  }
  return snapshot;
}

function isCanonicalDirectoryEntryName(directoryRole, actualName) {
  return (
    directoryRole === 'mythpen'
    && (actualName === 'volumes' || actualName === 'chapters')
  ) || exactEntryShape(directoryRole, actualName) !== null;
}

function createDirectoryNameIndex(input) {
  const descriptors = dataDescriptors(input, 'directory name index input');
  assertExactDescriptorKeys(descriptors, [
    'actualNames',
    'directoryRole',
    'parentIdentity',
    'paths',
    'scanEpoch',
  ], 'directory name index input');
  const paths = assertBrandedPaths(descriptorValue(descriptors, 'paths'));
  const directoryRole = descriptorValue(descriptors, 'directoryRole');
  if (typeof directoryRole !== 'string' || !DIRECTORY_ROLES.has(directoryRole)) {
    throw new TypeError('directoryRole is invalid');
  }
  const parentIdentity = snapshotIdentity(
    descriptorValue(descriptors, 'parentIdentity'),
    'parentIdentity',
  );
  const scanEpoch = descriptorValue(descriptors, 'scanEpoch');
  if (!Number.isSafeInteger(scanEpoch) || scanEpoch < 0) {
    throw new TypeError('scanEpoch must be a non-negative safe integer');
  }
  const actualNames = snapshotActualNames(descriptorValue(descriptors, 'actualNames'));
  const exactNames = new Set();
  const foldedNames = new Set();
  let foldEvaluations = 0;
  for (const actualName of actualNames) {
    const folded = foldedEntryName(actualName);
    foldEvaluations += 1;
    if (foldedNames.has(folded)) {
      throw pathError('MANUSCRIPT_FILESET_INVALID', directoryRole);
    }
    foldedNames.add(folded);
    if (
      folded !== actualName
      && !isCanonicalDirectoryEntryName(directoryRole, actualName)
      && isCanonicalDirectoryEntryName(directoryRole, folded)
    ) {
      throw pathError('MANUSCRIPT_FILESET_INVALID', directoryRole);
    }
    exactNames.add(actualName);
  }

  const index = Object.freeze({
    entryCount: actualNames.length,
    foldEvaluations,
  });
  directoryNameIndexRecords.set(index, Object.freeze({
    directoryRole,
    exactNames,
    parentIdentity,
    paths,
    scanEpoch,
  }));
  return index;
}

function requiredDirectoryRole(targetRole, controlledFileRef) {
  if (targetRole === 'controlled_file') {
    if (controlledFileRef.role === 'manuscript' || controlledFileRef.role === 'unassigned') {
      return 'mythpen';
    }
    if (controlledFileRef.role === 'volume_index') return 'volumes';
    return 'chapters';
  }
  if (targetRole === 'volumes_directory' || targetRole === 'chapters_directory') {
    return 'mythpen';
  }
  return null;
}

function assertDirectoryNameIndex(value) {
  if (value === null || typeof value !== 'object' || !directoryNameIndexRecords.has(value)) {
    throw new TypeError('directoryNameIndex must be created by createDirectoryNameIndex');
  }
  return directoryNameIndexRecords.get(value);
}

function verifyManuscriptPathIdentity(input) {
  const descriptors = dataDescriptors(input, 'path identity input');
  const targetRole = descriptorValue(descriptors, 'targetRole');
  if (typeof targetRole !== 'string' || !TARGET_ROLES.has(targetRole)) {
    throw new TypeError('targetRole is invalid');
  }
  const expectedKeys = [
    'expectedIdentity',
    'expectedParentIdentity',
    'identityBoundary',
    'paths',
    'targetRole',
  ];
  if (targetRole === 'controlled_file') expectedKeys.push('controlledFileRef');
  if (
    targetRole === 'controlled_file'
    || targetRole === 'volumes_directory'
    || targetRole === 'chapters_directory'
  ) {
    expectedKeys.push('directoryNameIndex', 'scanEpoch');
  }
  assertExactDescriptorKeys(descriptors, expectedKeys, 'path identity input');
  const paths = assertBrandedPaths(descriptorValue(descriptors, 'paths'));
  const controlledFileRef = targetRole === 'controlled_file'
    ? assertControlledFileRef(descriptorValue(descriptors, 'controlledFileRef'))
    : undefined;
  const target = identityTarget(paths, targetRole, controlledFileRef);
  const expectedIdentity = snapshotIdentity(
    descriptorValue(descriptors, 'expectedIdentity'),
    'expectedIdentity',
  );
  const expectedParentIdentity = snapshotIdentity(
    descriptorValue(descriptors, 'expectedParentIdentity'),
    'expectedParentIdentity',
  );
  const boundary = assertIdentityBoundary(descriptorValue(descriptors, 'identityBoundary'));
  const expectedName = path.basename(target.path);
  const expectedParentPath = path.dirname(target.path);
  const directoryRole = requiredDirectoryRole(targetRole, controlledFileRef);
  if (directoryRole !== null) {
    const nameIndex = assertDirectoryNameIndex(
      descriptorValue(descriptors, 'directoryNameIndex'),
    );
    const scanEpoch = descriptorValue(descriptors, 'scanEpoch');
    if (
      !Number.isSafeInteger(scanEpoch)
      || scanEpoch < 0
      || nameIndex.paths !== paths
      || nameIndex.directoryRole !== directoryRole
      || !sameIdentity(nameIndex.parentIdentity, expectedParentIdentity)
      || nameIndex.scanEpoch !== scanEpoch
    ) {
      throw new TypeError('directoryNameIndex does not match this scan context');
    }
    if (!nameIndex.exactNames.has(expectedName)) {
      throw pathError('MANUSCRIPT_FILESET_INVALID', targetRole);
    }
  }

  let before;
  let after;
  try {
    before = snapshotObservation(boundary.inspectPath(target.path), 'path identity before');
    after = snapshotObservation(boundary.inspectPath(target.path), 'path identity after');
  } catch (cause) {
    if (cause?.code === 'MANUSCRIPT_FILESET_INVALID' || cause?.code === 'MANUSCRIPT_PATH_UNSAFE') {
      throw cause;
    }
    throw pathError('MANUSCRIPT_PATH_UNSAFE', targetRole, cause);
  }

  if (before.actualName !== expectedName || after.actualName !== expectedName) {
    throw pathError('MANUSCRIPT_FILESET_INVALID', targetRole);
  }

  if (
    before.kind !== target.expectedKind
    || after.kind !== target.expectedKind
    || before.reparse
    || after.reparse
    || before.realPath !== target.path
    || after.realPath !== target.path
    || before.parentRealPath !== expectedParentPath
    || after.parentRealPath !== expectedParentPath
    || !sameIdentity(before.identity, expectedIdentity)
    || !sameIdentity(after.identity, expectedIdentity)
    || !sameIdentity(before.identity, after.identity)
    || !sameIdentity(before.parentIdentity, expectedParentIdentity)
    || !sameIdentity(after.parentIdentity, expectedParentIdentity)
    || !sameIdentity(before.parentIdentity, after.parentIdentity)
    || (target.expectedKind === 'file' && (before.linkCount !== 1 || after.linkCount !== 1))
  ) {
    throw pathError('MANUSCRIPT_PATH_UNSAFE', targetRole);
  }

  return Object.freeze({
    identity: expectedIdentity,
    kind: target.expectedKind,
    parentIdentity: expectedParentIdentity,
    path: target.path,
    realPath: target.path,
    targetRole,
  });
}

module.exports = {
  assertControlledFileRef,
  classifyTreeEntry,
  createDirectoryNameIndex,
  deriveChapterPaths,
  deriveControlledFileRef,
  deriveManuscriptPaths,
  deriveVolumePath,
  resolveControlledFileRef,
  verifyManuscriptPathIdentity,
};
