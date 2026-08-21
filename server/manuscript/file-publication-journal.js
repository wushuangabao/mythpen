'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const { assertCanonicalUuid, manuscriptError } = require('./contracts');
const {
  assertControlledFileRef,
  deriveControlledFileRef,
  deriveManuscriptPaths,
  resolveControlledFileRef,
} = require('./paths');
const { mintJournalAuthorityCapability } = require('./capability-registry');
const { FAULT_POINTS, faultPoint } = require('../testing/fault-injection');

const EVENT_PREFIX = 'manuscript.file_publication.';
const EVENT_SUFFIXES = new Set([
  'assets_reserved',
  'target_reserved',
  'prepared',
  'files_published',
  'projection_committed',
  'completed',
  'rolled_back',
  'assets_collected',
]);
const ROLE_ORDER = Object.freeze({
  chapter_body: 0,
  chapter_sidecar: 1,
  volume_index: 2,
  unassigned: 3,
  manuscript: 4,
});
const journalRecords = new WeakMap();
const stagedAssetRecords = new WeakMap();
const preparedAssetRecords = new WeakMap();
const JOURNAL_AUTHORITY_BACKEND = Object.freeze({ kind: 'file_publication_journal' });
const JOURNAL_AUTHORITY_OPTIONS = Object.freeze({
  backendToken: JOURNAL_AUTHORITY_BACKEND,
  mode: 'production',
});

function recoveryRequired(reason, cause) {
  return manuscriptError('RECOVERY_REQUIRED', { reason }, cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  const expected = expectedKeys.slice().sort();
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.slice().sort().join('\0') !== expected.join('\0')
    || actualKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value');
    })
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return descriptors;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new TypeError('binary data cannot be part of a serializable manifest');
  }
  if (seen.has(value)) throw new TypeError('plain data must be acyclic');
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function snapshotPlainData(value, label, requireFrozen = false, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} is invalid`);
    return value;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new TypeError(`${label} must contain serializable plain data`);
  }
  if (requireFrozen && !Object.isFrozen(value)) throw new TypeError(`${label} must be frozen`);
  if (seen.has(value)) throw new TypeError(`${label} must be acyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const snapshot = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${label} must be a dense array`);
        }
        snapshot.push(snapshotPlainData(descriptor.value, `${label}[${index}]`, requireFrozen, seen));
      }
      if (keys.some((key) => key !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
        throw new TypeError(`${label} must be an exact array`);
      }
      return Object.freeze(snapshot);
    }
    if (!isPlainObject(value)) throw new TypeError(`${label} must contain plain objects`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string'
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError(`${label} must contain enumerable string data properties only`);
      }
      snapshot[key] = snapshotPlainData(descriptor.value, `${label}.${key}`, requireFrozen, seen);
    }
    return Object.freeze(snapshot);
  } finally {
    seen.delete(value);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestPlain(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function snapshotIdentity(value, label) {
  const descriptors = assertExactKeys(value, ['dev', 'ino'], label);
  const dev = descriptors.dev.value;
  const ino = descriptors.ino.value;
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
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function snapshotProjectBinding(value) {
  const descriptors = assertExactKeys(value, [
    'articleRootIdentity',
    'controlIncarnationId',
    'dataRoot',
    'projectInstanceId',
    'projectUid',
    'recoveryRootIdentity',
  ], 'projectBinding');
  const dataRoot = descriptors.dataRoot.value;
  if (
    typeof dataRoot !== 'string'
    || dataRoot.length === 0
    || dataRoot.includes('\0')
    || !path.isAbsolute(dataRoot)
    || path.normalize(dataRoot) !== dataRoot
    || path.resolve(dataRoot) !== dataRoot
  ) {
    throw new TypeError('projectBinding.dataRoot must be an absolute canonical path');
  }
  const controlIncarnationId = descriptors.controlIncarnationId.value;
  if (typeof controlIncarnationId !== 'string' || controlIncarnationId.length === 0) {
    throw new TypeError('projectBinding.controlIncarnationId is required');
  }
  const binding = Object.freeze({
    dataRoot,
    projectUid: assertCanonicalUuid(descriptors.projectUid.value, 'project_uid'),
    projectInstanceId: assertCanonicalUuid(
      descriptors.projectInstanceId.value,
      'project_instance_id',
    ),
    controlIncarnationId,
    articleRootIdentity: snapshotIdentity(
      descriptors.articleRootIdentity.value,
      'projectBinding.articleRootIdentity',
    ),
    recoveryRootIdentity: snapshotIdentity(
      descriptors.recoveryRootIdentity.value,
      'projectBinding.recoveryRootIdentity',
    ),
  });
  if (binding.articleRootIdentity.dev !== binding.recoveryRootIdentity.dev) {
    throw recoveryRequired('article root and recovery root are on different physical volumes');
  }
  return binding;
}

function snapshotParent(value) {
  if (value === null) return Object.freeze({ kind: 'ordinary', journalId: null });
  const descriptors = assertExactKeys(value, ['journalId', 'kind'], 'parent');
  const kind = descriptors.kind.value;
  if (!['draft_conflict', 'migration', 'creation'].includes(kind)) {
    throw new TypeError('parent.kind is invalid');
  }
  return Object.freeze({
    kind,
    journalId: assertCanonicalUuid(descriptors.journalId.value, 'parent_journal_id'),
  });
}

function modeForParent(parent) {
  return parent.kind === 'migration' || parent.kind === 'creation' ? 'file_only' : 'full';
}

function refData(ref) {
  assertControlledFileRef(ref);
  const result = { role: ref.role, projectUid: ref.projectUid };
  if (ref.role === 'volume_index') result.volumeUid = ref.volumeUid;
  if (ref.role === 'chapter_body' || ref.role === 'chapter_sidecar') result.chapterUid = ref.chapterUid;
  return Object.freeze(result);
}

function refFromData(value) {
  return deriveControlledFileRef(value);
}

function refKey(ref) {
  if (ref.role === 'manuscript' || ref.role === 'unassigned') return ref.role;
  return `${ref.role}:${ref.volumeUid ?? ref.chapterUid}`;
}

function resourceUid(ref) {
  return ref.volumeUid ?? ref.chapterUid ?? null;
}

function finalPath(binding, ref) {
  return resolveControlledFileRef(
    deriveManuscriptPaths({ dataRoot: binding.dataRoot, projectUid: binding.projectUid }),
    ref,
  );
}

function recoveryPath(binding, journalId, name) {
  return path.join(
    binding.dataRoot,
    'control',
    'manuscripts',
    binding.projectUid,
    binding.projectInstanceId,
    'file-assets',
    `${journalId}.${name}`,
  );
}

function snapshotEndpoint(value, label, before) {
  const keys = before
    ? ['byteSize', 'bytes', 'exists', 'fileIdentity', 'rawSha256']
    : ['byteSize', 'bytes', 'exists', 'rawSha256'];
  const descriptors = assertExactKeys(value, keys, label);
  const exists = descriptors.exists.value;
  if (typeof exists !== 'boolean') throw new TypeError(`${label}.exists must be boolean`);
  const bytes = descriptors.bytes.value;
  const byteSize = descriptors.byteSize.value;
  const rawSha256 = descriptors.rawSha256.value;
  const fileIdentity = before ? descriptors.fileIdentity.value : undefined;
  if (!exists) {
    if (
      bytes !== null
      || byteSize !== 0
      || rawSha256 !== null
      || (before && fileIdentity !== null)
    ) {
      throw new TypeError(`${label} absent facts are inconsistent`);
    }
    return Object.freeze({
      exists: false,
      bytes: null,
      byteSize: 0,
      rawSha256: null,
      ...(before ? { fileIdentity: null } : {}),
    });
  }
  if (
    !Buffer.isBuffer(bytes)
    || !Number.isSafeInteger(byteSize)
    || byteSize < 0
    || bytes.length !== byteSize
    || assertDigest(rawSha256, `${label}.rawSha256`) !== sha256(bytes)
  ) {
    throw new TypeError(`${label} bytes do not match length/hash facts`);
  }
  return Object.freeze({
    exists: true,
    bytes: Buffer.from(bytes),
    byteSize,
    rawSha256,
    ...(before ? { fileIdentity: snapshotIdentity(fileIdentity, `${label}.fileIdentity`) } : {}),
  });
}

function snapshotClosure(closure, binding) {
  if (!Array.isArray(closure) || !Object.isFrozen(closure) || closure.length === 0) {
    throw new TypeError('closure must be a non-empty frozen array');
  }
  const members = [];
  const keys = new Set();
  let previousRank = -1;
  let previousKey = '';
  for (let index = 0; index < closure.length; index += 1) {
    const input = closure[index];
    if (!Object.isFrozen(input)) throw new TypeError('closure members must be frozen');
    const descriptors = assertExactKeys(
      input,
      ['after', 'before', 'parentIdentity', 'ref'],
      `closure[${index}]`,
    );
    const ref = assertControlledFileRef(descriptors.ref.value);
    if (ref.projectUid !== binding.projectUid) throw new TypeError('closure ref belongs to another project');
    const key = refKey(ref);
    if (keys.has(key)) throw new TypeError('closure contains a duplicate controlled ref');
    keys.add(key);
    const rank = ROLE_ORDER[ref.role];
    if (rank < previousRank || (rank === previousRank && key.localeCompare(previousKey, 'en') < 0)) {
      throw new TypeError('closure publication order is not canonical');
    }
    previousRank = rank;
    previousKey = key;
    const before = snapshotEndpoint(descriptors.before.value, `closure[${index}].before`, true);
    const after = snapshotEndpoint(descriptors.after.value, `closure[${index}].after`, false);
    if (!Object.isFrozen(descriptors.before.value) || !Object.isFrozen(descriptors.after.value)) {
      throw new TypeError('closure endpoint facts must be frozen');
    }
    if (before.exists === after.exists && before.exists && before.rawSha256 === after.rawSha256) {
      throw new TypeError('closure contains an unchanged member');
    }
    if (!before.exists && !after.exists) throw new TypeError('closure member is absent before and after');
    const operation = before.exists ? (after.exists ? 'update' : 'delete') : 'create';
    const parentIdentity = snapshotIdentity(
      descriptors.parentIdentity.value,
      `closure[${index}].parentIdentity`,
    );
    if (parentIdentity.dev !== binding.articleRootIdentity.dev) {
      throw recoveryRequired('controlled file parent is on a different physical volume');
    }
    members.push(Object.freeze({
      ref,
      refKey: key,
      parentIdentity,
      before,
      after,
      operation,
    }));
  }
  return Object.freeze(members);
}

function assetReservation(assetKind, assetPath, parentIdentity, bytes) {
  return Object.freeze({
    assetKind,
    path: assetPath,
    parentIdentity,
    byteSize: bytes.length,
    sha256: sha256(bytes),
  });
}

function buildReservationMembers(members, binding, journalId) {
  return Object.freeze(members.map((member, index) => {
    const suffix = String(index).padStart(5, '0');
    const beforeAsset = member.before.exists
      ? assetReservation(
          'before_copy',
          recoveryPath(binding, journalId, `before-${suffix}.bin`),
          binding.recoveryRootIdentity,
          member.before.bytes,
        )
      : null;
    const afterAsset = member.after.exists
      ? assetReservation(
          'staged_after',
          recoveryPath(binding, journalId, `after-${suffix}.bin`),
          binding.recoveryRootIdentity,
          member.after.bytes,
        )
      : null;
    return Object.freeze({
      ref: refData(member.ref),
      refKey: member.refKey,
      operation: member.operation,
      final: Object.freeze({
        path: finalPath(binding, member.ref),
        parentIdentity: member.parentIdentity,
      }),
      before: Object.freeze({
        exists: member.before.exists,
        byteSize: member.before.byteSize,
        sha256: member.before.rawSha256,
        fileIdentity: member.before.fileIdentity,
        assetReservation: beforeAsset,
      }),
      after: Object.freeze({
        exists: member.after.exists,
        byteSize: member.after.byteSize,
        sha256: member.after.rawSha256,
        assetReservation: afterAsset,
      }),
      displaced: Object.freeze({
        path: recoveryPath(binding, journalId, `displaced-${suffix}.bin`),
        parentIdentity: binding.recoveryRootIdentity,
        expectedAbsent: true,
        expectedFileIdentity: member.before.fileIdentity,
        expectedByteSize: member.before.byteSize,
        expectedSha256: member.before.rawSha256,
      }),
    });
  }));
}

function snapshotAsset(value, label = 'asset') {
  const descriptors = assertExactKeys(value, [
    'assetKind',
    'byteSize',
    'fileIdentity',
    'fileSynced',
    'parentIdentity',
    'parentSynced',
    'path',
    'sha256',
  ], label);
  const assetKind = descriptors.assetKind.value;
  const assetPath = descriptors.path.value;
  const byteSize = descriptors.byteSize.value;
  if (
    typeof assetKind !== 'string'
    || assetKind.length === 0
    || typeof assetPath !== 'string'
    || assetPath.length === 0
    || !Number.isSafeInteger(byteSize)
    || byteSize < 0
    || descriptors.fileSynced.value !== true
    || descriptors.parentSynced.value !== true
  ) {
    throw new TypeError(`${label} has invalid facts`);
  }
  return Object.freeze({
    assetKind,
    path: assetPath,
    parentIdentity: snapshotIdentity(descriptors.parentIdentity.value, `${label}.parentIdentity`),
    fileIdentity: snapshotIdentity(descriptors.fileIdentity.value, `${label}.fileIdentity`),
    byteSize,
    sha256: assertDigest(descriptors.sha256.value, `${label}.sha256`),
    fileSynced: true,
    parentSynced: true,
  });
}

function snapshotTargetAssetReservation(value, record, journalId) {
  const descriptors = assertExactKeys(value, [
    'assetKind',
    'byteSize',
    'parentIdentity',
    'path',
    'sha256',
  ], 'target asset reservation');
  const byteSize = descriptors.byteSize.value;
  const parentIdentity = snapshotIdentity(
    descriptors.parentIdentity.value,
    'target asset reservation.parentIdentity',
  );
  const targetPath = descriptors.path.value;
  if (
    descriptors.assetKind.value !== 'projection_target'
    || !Number.isSafeInteger(byteSize)
    || byteSize < 0
    || targetPath !== recoveryPath(record.projectBinding, journalId, 'projection-target.json')
    || !sameIdentity(parentIdentity, record.projectBinding.recoveryRootIdentity)
  ) throw new TypeError('target asset reservation is not deterministic');
  return Object.freeze({
    assetKind: 'projection_target',
    path: targetPath,
    parentIdentity,
    byteSize,
    sha256: assertDigest(descriptors.sha256.value, 'target asset reservation.sha256'),
  });
}

function assertDenseArray(value, label) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    throw new TypeError(`${label} must be a dense exact array`);
  }
  return value;
}

function snapshotPersistedParent(value) {
  const descriptors = assertExactKeys(value, ['journalId', 'kind'], 'persisted parent');
  if (descriptors.kind.value === 'ordinary') {
    if (descriptors.journalId.value !== null) {
      throw new TypeError('ordinary parent must have a null journalId');
    }
    return Object.freeze({ kind: 'ordinary', journalId: null });
  }
  return snapshotParent(value);
}

function snapshotReservedAsset(value, {
  assetKind,
  byteSize,
  journalId,
  label,
  name,
  record,
  sha256: expectedSha256,
}) {
  const descriptors = assertExactKeys(value, [
    'assetKind',
    'byteSize',
    'parentIdentity',
    'path',
    'sha256',
  ], label);
  const parentIdentity = snapshotIdentity(descriptors.parentIdentity.value, `${label}.parentIdentity`);
  const expectedPath = recoveryPath(record.projectBinding, journalId, name);
  if (
    descriptors.assetKind.value !== assetKind
    || descriptors.path.value !== expectedPath
    || descriptors.byteSize.value !== byteSize
    || descriptors.sha256.value !== expectedSha256
    || !sameIdentity(parentIdentity, record.projectBinding.recoveryRootIdentity)
  ) throw new TypeError(`${label} does not match its deterministic reservation`);
  return Object.freeze({
    assetKind,
    path: expectedPath,
    parentIdentity,
    byteSize,
    sha256: expectedSha256,
  });
}

function snapshotPersistedEndpoint(value, {
  before,
  index,
  journalId,
  label,
  record,
}) {
  const descriptors = assertExactKeys(
    value,
    before
      ? ['assetReservation', 'byteSize', 'exists', 'fileIdentity', 'sha256']
      : ['assetReservation', 'byteSize', 'exists', 'sha256'],
    label,
  );
  const exists = descriptors.exists.value;
  const byteSize = descriptors.byteSize.value;
  const endpointSha256 = descriptors.sha256.value;
  const fileIdentity = before ? descriptors.fileIdentity.value : undefined;
  if (typeof exists !== 'boolean' || !Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new TypeError(`${label} has invalid existence/length facts`);
  }
  if (!exists) {
    if (
      byteSize !== 0
      || endpointSha256 !== null
      || descriptors.assetReservation.value !== null
      || (before && fileIdentity !== null)
    ) throw new TypeError(`${label} absent facts are inconsistent`);
    return Object.freeze({
      exists: false,
      byteSize: 0,
      sha256: null,
      ...(before ? { fileIdentity: null } : {}),
      assetReservation: null,
    });
  }
  assertDigest(endpointSha256, `${label}.sha256`);
  const suffix = String(index).padStart(5, '0');
  const assetReservation = snapshotReservedAsset(descriptors.assetReservation.value, {
    assetKind: before ? 'before_copy' : 'staged_after',
    byteSize,
    journalId,
    label: `${label}.assetReservation`,
    name: before ? `before-${suffix}.bin` : `after-${suffix}.bin`,
    record,
    sha256: endpointSha256,
  });
  return Object.freeze({
    exists: true,
    byteSize,
    sha256: endpointSha256,
    ...(before ? { fileIdentity: snapshotIdentity(fileIdentity, `${label}.fileIdentity`) } : {}),
    assetReservation,
  });
}

function snapshotPersistedMembers(value, record, journalId) {
  assertDenseArray(value, 'assets reservation members');
  if (value.length === 0) throw new TypeError('assets reservation members are empty');
  const members = [];
  const keys = new Set();
  let previousRank = -1;
  let previousKey = '';
  for (let index = 0; index < value.length; index += 1) {
    const descriptors = assertExactKeys(value[index], [
      'after',
      'before',
      'displaced',
      'final',
      'operation',
      'ref',
      'refKey',
    ], `assets reservation members[${index}]`);
    const ref = refFromData(descriptors.ref.value);
    if (ref.projectUid !== record.projectBinding.projectUid) {
      throw new TypeError('persisted member belongs to another project');
    }
    const canonicalRef = refData(ref);
    if (canonicalJson(canonicalRef) !== canonicalJson(descriptors.ref.value)) {
      throw new TypeError('persisted member ref is not canonical');
    }
    const key = refKey(ref);
    const rank = ROLE_ORDER[ref.role];
    if (
      descriptors.refKey.value !== key
      || keys.has(key)
      || rank < previousRank
      || (rank === previousRank && key.localeCompare(previousKey, 'en') < 0)
    ) throw new TypeError('persisted member order/refKey is invalid');
    keys.add(key);
    previousRank = rank;
    previousKey = key;
    const finalDescriptors = assertExactKeys(
      descriptors.final.value,
      ['parentIdentity', 'path'],
      `assets reservation members[${index}].final`,
    );
    const finalParentIdentity = snapshotIdentity(
      finalDescriptors.parentIdentity.value,
      `assets reservation members[${index}].final.parentIdentity`,
    );
    if (
      finalDescriptors.path.value !== finalPath(record.projectBinding, ref)
      || finalParentIdentity.dev !== record.projectBinding.articleRootIdentity.dev
    ) throw new TypeError('persisted member final path/topology is invalid');
    const before = snapshotPersistedEndpoint(descriptors.before.value, {
      before: true,
      index,
      journalId,
      label: `assets reservation members[${index}].before`,
      record,
    });
    const after = snapshotPersistedEndpoint(descriptors.after.value, {
      before: false,
      index,
      journalId,
      label: `assets reservation members[${index}].after`,
      record,
    });
    if ((!before.exists && !after.exists) || (
      before.exists && after.exists && before.sha256 === after.sha256
    )) throw new TypeError('persisted member endpoints do not describe a change');
    const operation = before.exists ? (after.exists ? 'update' : 'delete') : 'create';
    if (descriptors.operation.value !== operation) {
      throw new TypeError('persisted member operation is not derived from endpoints');
    }
    const displacedDescriptors = assertExactKeys(descriptors.displaced.value, [
      'expectedAbsent',
      'expectedByteSize',
      'expectedFileIdentity',
      'expectedSha256',
      'parentIdentity',
      'path',
    ], `assets reservation members[${index}].displaced`);
    const displacedParentIdentity = snapshotIdentity(
      displacedDescriptors.parentIdentity.value,
      `assets reservation members[${index}].displaced.parentIdentity`,
    );
    const displacedFileIdentity = before.exists
      ? snapshotIdentity(
          displacedDescriptors.expectedFileIdentity.value,
          `assets reservation members[${index}].displaced.expectedFileIdentity`,
        )
      : null;
    const expectedDisplacedPath = recoveryPath(
      record.projectBinding,
      journalId,
      `displaced-${String(index).padStart(5, '0')}.bin`,
    );
    if (
      displacedDescriptors.path.value !== expectedDisplacedPath
      || displacedDescriptors.expectedAbsent.value !== true
      || displacedDescriptors.expectedByteSize.value !== before.byteSize
      || displacedDescriptors.expectedSha256.value !== before.sha256
      || !sameIdentity(displacedParentIdentity, record.projectBinding.recoveryRootIdentity)
      || (before.exists
        ? !sameIdentity(displacedFileIdentity, before.fileIdentity)
        : displacedDescriptors.expectedFileIdentity.value !== null)
    ) throw new TypeError('persisted displaced reservation is invalid');
    members.push(Object.freeze({
      ref: canonicalRef,
      refKey: key,
      operation,
      final: Object.freeze({
        path: finalDescriptors.path.value,
        parentIdentity: finalParentIdentity,
      }),
      before,
      after,
      displaced: Object.freeze({
        path: expectedDisplacedPath,
        parentIdentity: displacedParentIdentity,
        expectedAbsent: true,
        expectedFileIdentity: before.fileIdentity,
        expectedByteSize: before.byteSize,
        expectedSha256: before.sha256,
      }),
    }));
  }
  return Object.freeze(members);
}

function snapshotAssetsReservation(record, payload, journalId) {
  const parent = snapshotPersistedParent(payload.parent);
  const projectBinding = snapshotProjectBinding(payload.projectBinding);
  if (canonicalJson(projectBinding) !== canonicalJson(record.projectBinding)) {
    throw new TypeError('assets reservation project binding changed');
  }
  const members = snapshotPersistedMembers(payload.members, record, journalId);
  const identityReservation = payload.identityReservation === null
    ? null
    : snapshotPlainData(payload.identityReservation, 'persisted identityReservation');
  const reservation = Object.freeze({
    version: 1,
    record_kind: 'reservation',
    journalId,
    mode: modeForParent(parent),
    parent,
    projectBinding,
    logicalRequestId: payload.logicalRequestId,
    baseGeneration: payload.baseGeneration,
    targetGeneration: payload.targetGeneration,
    basisDigest: payload.basisDigest,
    identityReservation,
    inputDigest: payload.inputDigest,
    members,
  });
  const inputBinding = Object.freeze({
    journalId,
    logicalRequestId: reservation.logicalRequestId,
    baseGeneration: reservation.baseGeneration,
    targetGeneration: reservation.targetGeneration,
    basisDigest: reservation.basisDigest,
    identityReservation,
    parent,
    projectBinding,
    members,
  });
  if (
    payload.mode !== reservation.mode
    || typeof reservation.logicalRequestId !== 'string'
    || reservation.logicalRequestId.length === 0
    || !Number.isSafeInteger(reservation.baseGeneration)
    || reservation.baseGeneration < 0
    || !Number.isSafeInteger(reservation.targetGeneration)
    || reservation.targetGeneration <= reservation.baseGeneration
    || assertDigest(reservation.basisDigest, 'event basisDigest') !== reservation.basisDigest
    || assertDigest(reservation.inputDigest, 'event inputDigest') !== reservation.inputDigest
    || reservation.inputDigest !== digestPlain(inputBinding)
  ) throw new TypeError('assets reservation binding is invalid');
  return reservation;
}

function expectedStageReservations(reservation) {
  const expected = new Map();
  for (const member of reservation.members) {
    for (const asset of [member.before.assetReservation, member.after.assetReservation]) {
      if (asset !== null) expected.set(asset.path, asset);
    }
  }
  return expected;
}

function appendEvent(record, type, payload) {
  const tail = record.controlStore.tail();
  return record.controlStore.compareAndAppend(tail?.digest ?? null, { type, payload });
}

function assertEventShape(payload, keys, label) {
  assertExactKeys(payload, keys, label);
  if (payload.version !== 1) throw new TypeError(`${label}.version is invalid`);
}

function parseJournal(record, journalId) {
  const result = {
    state: null,
    reservation: null,
    reservationDigest: null,
    ready: new Map(),
    targetReservation: null,
    targetReady: null,
    manifestDigest: null,
    filesPublished: null,
  };
  try {
    const events = record.controlStore.read();
    for (const event of events) {
    if (typeof event.type !== 'string' || !event.type.startsWith(EVENT_PREFIX)) continue;
    const payload = event.payload;
    if (!isPlainObject(payload)) throw recoveryRequired('file publication event payload is malformed');
    assertCanonicalUuid(payload.journalId, 'journal_id');
    if (payload.journalId !== journalId) continue;
    const suffix = event.type.slice(EVENT_PREFIX.length);
    if (!EVENT_SUFFIXES.has(suffix)) throw recoveryRequired('file publication event suffix is unknown');
    if (suffix === 'assets_reserved') {
      if (payload.record_kind === 'reservation') {
        assertEventShape(payload, [
          'basisDigest',
          'baseGeneration',
          'identityReservation',
          'inputDigest',
          'journalId',
          'logicalRequestId',
          'members',
          'mode',
          'parent',
          'projectBinding',
          'record_kind',
          'targetGeneration',
          'version',
        ], 'assets reservation event');
        if (result.state !== null || result.reservation !== null) {
          throw recoveryRequired('duplicate or out-of-order assets reservation');
        }
        result.reservation = snapshotAssetsReservation(record, payload, journalId);
        result.reservationDigest = digestPlain(result.reservation);
        result.state = 'assets_reserved';
      } else if (payload.record_kind === 'asset_ready') {
        assertEventShape(payload, [
          'asset',
          'journalId',
          'record_kind',
          'reservationDigest',
          'version',
        ], 'assets ready event');
        if (result.state !== 'assets_reserved' || result.reservation === null) {
          throw recoveryRequired('out-of-order assets ready fact');
        }
        if (payload.reservationDigest !== result.reservationDigest) {
          throw recoveryRequired('asset ready fact has the wrong reservation digest');
        }
        const asset = snapshotAsset(payload.asset, 'asset ready fact');
        const expected = expectedStageReservations(result.reservation).get(asset.path);
        if (
          expected === undefined
          || expected.assetKind !== asset.assetKind
          || expected.byteSize !== asset.byteSize
          || expected.sha256 !== asset.sha256
          || !sameIdentity(expected.parentIdentity, asset.parentIdentity)
        ) {
          throw recoveryRequired('asset ready fact conflicts with the reservation');
        }
        const prior = result.ready.get(asset.path);
        if (prior && canonicalJson(prior) !== canonicalJson(asset)) {
          throw recoveryRequired('conflicting asset ready enrichment');
        }
        result.ready.set(asset.path, asset);
      } else {
        throw recoveryRequired('assets_reserved record kind is invalid');
      }
      continue;
    }
    if (suffix === 'target_reserved') {
      if (payload.record_kind === 'reservation') {
        assertEventShape(payload, [
          'journalId',
          'record_kind',
          'reservationDigest',
          'targetAssetReservation',
          'targetDigest',
          'version',
        ], 'target reservation event');
        if (result.state !== 'assets_reserved') {
          throw recoveryRequired('out-of-order target reservation');
        }
        const expectedStage = expectedStageReservations(result.reservation);
        if ([...expectedStage.keys()].some((assetPath) => !result.ready.has(assetPath))) {
          throw recoveryRequired('target was reserved before staged assets were ready');
        }
        if (payload.reservationDigest !== result.reservationDigest) {
          throw recoveryRequired('target reservation has the wrong parent digest');
        }
        const targetAssetReservation = snapshotTargetAssetReservation(
          payload.targetAssetReservation,
          record,
          journalId,
        );
        if (
          assertDigest(payload.targetDigest, 'targetDigest') !== payload.targetDigest
          || targetAssetReservation.sha256 !== payload.targetDigest
        ) throw new TypeError('target reservation digest is invalid');
        result.targetReservation = Object.freeze({ ...payload, targetAssetReservation });
        result.state = 'target_reserved';
      } else if (payload.record_kind === 'asset_ready') {
        assertEventShape(payload, [
          'asset',
          'journalId',
          'record_kind',
          'targetReservationDigest',
          'version',
        ], 'target ready event');
        if (result.state !== 'target_reserved' || result.targetReservation === null) {
          throw recoveryRequired('out-of-order target ready fact');
        }
        const asset = snapshotAsset(payload.asset, 'target ready fact');
        const expected = result.targetReservation.targetAssetReservation;
        if (
          payload.targetReservationDigest !== digestPlain(result.targetReservation)
          || asset.path !== expected.path
          || asset.assetKind !== expected.assetKind
          || asset.byteSize !== expected.byteSize
          || asset.sha256 !== expected.sha256
          || !sameIdentity(asset.parentIdentity, expected.parentIdentity)
        ) {
          throw recoveryRequired('target ready fact conflicts with target reservation');
        }
        if (result.targetReady && canonicalJson(result.targetReady) !== canonicalJson(asset)) {
          throw recoveryRequired('conflicting target ready enrichment');
        }
        result.targetReady = asset;
      } else {
        throw recoveryRequired('target_reserved record kind is invalid');
      }
      continue;
    }
    if (suffix === 'prepared') {
      assertEventShape(payload, [
        'journalId',
        'manifestDigest',
        'recovery',
        'version',
      ], 'prepared event');
      if (result.state !== 'target_reserved' || result.targetReady === null) {
        throw recoveryRequired('prepared is out of order');
      }
      const expectedManifestDigest = digestPlain(buildManifest(result));
      if (payload.manifestDigest !== expectedManifestDigest) {
        throw recoveryRequired('prepared manifest digest changed');
      }
      const allowedRecovery = result.reservation.mode === 'full'
        ? ['none', 'full']
        : ['none', 'parent_after'];
      if (!allowedRecovery.includes(payload.recovery)) {
        throw new TypeError('prepared recovery source is invalid');
      }
      result.manifestDigest = payload.manifestDigest;
      result.state = 'prepared';
      continue;
    }
    if (suffix === 'files_published') {
      assertEventShape(payload, [
        'journalId',
        'manifestDigest',
        'publication',
        'version',
      ], 'files_published event');
      if (result.state !== 'prepared') throw recoveryRequired('files_published is out of order');
      const manifest = buildManifest(result);
      if (payload.manifestDigest !== result.manifestDigest) {
        throw recoveryRequired('files_published evidence conflicts with prepared');
      }
      assertPublicationReceipt(payload.publication, manifest);
      result.filesPublished = payload;
      result.state = 'files_published';
      continue;
    }
    if (suffix === 'projection_committed') {
      assertEventShape(payload, [
        'journalId',
        'manifestDigest',
        'version',
      ], 'projection_committed event');
      if (result.state !== 'files_published' || result.reservation.mode !== 'full') {
        throw recoveryRequired('projection_committed is out of order');
      }
      if (payload.manifestDigest !== result.manifestDigest) {
        throw recoveryRequired('projection_committed manifest digest changed');
      }
      result.state = 'projection_committed';
      continue;
    }
    if (suffix === 'completed') {
      assertEventShape(payload, [
        'journalId',
        'manifestDigest',
        'version',
      ], 'completed event');
      if (result.state !== 'projection_committed') throw recoveryRequired('completed is out of order');
      if (payload.manifestDigest !== result.manifestDigest) {
        throw recoveryRequired('completed manifest digest changed');
      }
      result.state = 'completed';
      continue;
    }
    if (suffix === 'rolled_back') {
      assertEventShape(payload, [
        'journalId',
        'manifestDigest',
        'version',
      ], 'rolled_back event');
      const fileOnlyPublished = result.state === 'files_published'
        && result.reservation.mode === 'file_only';
      if (!['assets_reserved', 'target_reserved', 'prepared'].includes(result.state) && !fileOnlyPublished) {
        throw recoveryRequired('rolled_back is out of order');
      }
      const expectedManifestDigest = digestPlain(buildManifest(result));
      if (payload.manifestDigest !== expectedManifestDigest) {
        throw recoveryRequired('rolled_back manifest digest changed');
      }
      result.state = 'rolled_back';
      continue;
    }
    if (suffix === 'assets_collected') {
      assertEventShape(payload, [
        'assets',
        'journalId',
        'manifestDigest',
        'version',
      ], 'assets_collected event');
      const fileOnlyPublished = result.state === 'files_published' && result.reservation.mode === 'file_only';
      if (!['completed', 'rolled_back'].includes(result.state) && !fileOnlyPublished) {
        throw recoveryRequired('assets_collected is out of order');
      }
      const manifest = buildManifest(result);
      if (payload.manifestDigest !== digestPlain(manifest)) {
        throw recoveryRequired('assets_collected manifest digest changed');
      }
      assertCollectionReceipts(
        payload.assets,
        manifest,
        result.state === 'rolled_back' ? 'BEFORE' : 'AFTER',
      );
      result.state = 'assets_collected';
    }
  }
    return result;
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired('file publication event chain is malformed', cause);
  }
}

function readyForReservation(parsed, reservation) {
  return parsed.ready.get(reservation.path) ?? null;
}

function buildManifest(parsed) {
  if (parsed.reservation === null) throw recoveryRequired('journal has no asset reservation');
  const assets = [];
  const members = parsed.reservation.members.map((member) => {
    const beforeAsset = member.before.assetReservation === null
      ? null
      : readyForReservation(parsed, member.before.assetReservation);
    const afterAsset = member.after.assetReservation === null
      ? null
      : readyForReservation(parsed, member.after.assetReservation);
    if (beforeAsset) assets.push(beforeAsset);
    if (afterAsset) assets.push(afterAsset);
    return Object.freeze({
      ref: member.ref,
      refKey: member.refKey,
      operation: member.operation,
      final: member.final,
      before: Object.freeze({
        exists: member.before.exists,
        byteSize: member.before.byteSize,
        sha256: member.before.sha256,
        fileIdentity: member.before.fileIdentity,
        asset: beforeAsset,
      }),
      after: Object.freeze({
        exists: member.after.exists,
        byteSize: member.after.byteSize,
        sha256: member.after.sha256,
        fileIdentity: afterAsset?.fileIdentity ?? null,
        parentIdentity: member.final.parentIdentity,
        asset: afterAsset,
      }),
      displaced: member.displaced,
    });
  });
  if (parsed.targetReady) assets.push(parsed.targetReady);
  return deepFreeze({
    version: 1,
    journalId: parsed.reservation.journalId,
    mode: parsed.reservation.mode,
    parent: parsed.reservation.parent,
    projectBinding: parsed.reservation.projectBinding,
    logicalRequestId: parsed.reservation.logicalRequestId,
    baseGeneration: parsed.reservation.baseGeneration,
    targetGeneration: parsed.reservation.targetGeneration,
    basisDigest: parsed.reservation.basisDigest,
    inputDigest: parsed.reservation.inputDigest,
    identityReservation: parsed.reservation.identityReservation,
    members: Object.freeze(members),
    assets: Object.freeze(assets),
    targetDigest: parsed.targetReservation?.targetDigest ?? null,
    targetAsset: parsed.targetReady,
  });
}

function collectionReceiptAssets(manifest, terminalDisposition) {
  const assets = [];
  const seen = new Set();
  for (const asset of manifest.assets) {
    if (terminalDisposition === 'AFTER' && asset.assetKind === 'staged_after') continue;
    if (!seen.has(asset.path)) {
      seen.add(asset.path);
      assets.push(asset);
    }
  }
  if (terminalDisposition === 'AFTER') for (const member of manifest.members) {
    if (!member.before.exists || seen.has(member.displaced.path)) continue;
    seen.add(member.displaced.path);
    assets.push(Object.freeze({
      path: member.displaced.path,
      parentIdentity: member.displaced.parentIdentity,
      fileIdentity: member.before.fileIdentity,
    }));
  }
  return assets;
}

function assertCollectionReceipts(value, manifest, terminalDisposition) {
  if (!Array.isArray(value)) throw new TypeError('assets_collected assets are invalid');
  const expectedAssets = collectionReceiptAssets(manifest, terminalDisposition);
  if (value.length !== expectedAssets.length) {
    throw recoveryRequired('assets_collected receipt set is incomplete');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptors = assertExactKeys(
      value[index],
      [
        'alreadyAbsent',
        'deleted',
        'disposition',
        'identity',
        'parentFsync',
        'parentIdentity',
        'path',
      ],
      `assets_collected.assets[${index}]`,
    );
    const expected = expectedAssets[index];
    if (
      descriptors.path.value !== expected.path
      || descriptors.disposition.value !== 'DELETED'
      || descriptors.alreadyAbsent.value !== false
      || descriptors.deleted.value !== true
      || descriptors.parentFsync.value !== true
      || !sameIdentity(
        snapshotIdentity(descriptors.identity.value, `assets_collected.assets[${index}].identity`),
        expected.fileIdentity,
      )
      || !sameIdentity(
        snapshotIdentity(
          descriptors.parentIdentity.value,
          `assets_collected.assets[${index}].parentIdentity`,
        ),
        expected.parentIdentity,
      )
    ) throw recoveryRequired('assets_collected receipt does not match the manifest');
  }
}

function publicationEffectPlans(member) {
  const plans = [];
  if (member.operation === 'update' || member.operation === 'delete') {
    plans.push(Object.freeze({
      sourcePath: member.final.path,
      targetPath: member.displaced.path,
      byteSize: member.before.byteSize,
      sha256: member.before.sha256,
      identity: member.before.fileIdentity,
      sourceParentIdentity: member.final.parentIdentity,
      targetParentIdentity: member.displaced.parentIdentity,
    }));
  }
  if (member.operation === 'update' || member.operation === 'create') {
    plans.push(Object.freeze({
      sourcePath: member.after.asset.path,
      targetPath: member.final.path,
      byteSize: member.after.byteSize,
      sha256: member.after.sha256,
      identity: member.after.fileIdentity,
      sourceParentIdentity: member.after.asset.parentIdentity,
      targetParentIdentity: member.final.parentIdentity,
    }));
  }
  return plans;
}

function assertRelocationReceipt(value, plan, label) {
  const descriptors = assertExactKeys(value, [
    'byteSize',
    'identity',
    'kind',
    'relocated',
    'sha256',
    'sourceParentFsync',
    'sourceParentIdentity',
    'sourcePath',
    'targetParentFsync',
    'targetParentIdentity',
    'targetPath',
  ], label);
  if (
    descriptors.kind.value !== 'relocate'
    || descriptors.relocated.value !== true
    || descriptors.sourceParentFsync.value !== true
    || descriptors.targetParentFsync.value !== true
    || descriptors.sourcePath.value !== plan.sourcePath
    || descriptors.targetPath.value !== plan.targetPath
    || descriptors.byteSize.value !== plan.byteSize
    || descriptors.sha256.value !== plan.sha256
    || !sameIdentity(snapshotIdentity(descriptors.identity.value, `${label}.identity`), plan.identity)
    || !sameIdentity(
      snapshotIdentity(descriptors.sourceParentIdentity.value, `${label}.sourceParentIdentity`),
      plan.sourceParentIdentity,
    )
    || !sameIdentity(
      snapshotIdentity(descriptors.targetParentIdentity.value, `${label}.targetParentIdentity`),
      plan.targetParentIdentity,
    )
  ) throw new TypeError(`${label} does not match its manifest effect`);
}

function assertPublicationReceipt(value, manifest) {
  try {
    const descriptors = assertExactKeys(value, ['disposition', 'members'], 'publication receipt');
    const members = descriptors.members.value;
    if (descriptors.disposition.value !== 'AFTER' || !Array.isArray(members)) {
      throw new TypeError('publication receipt is not AFTER');
    }
    if (members.length !== manifest.members.length) {
      throw new TypeError('publication receipt member set is incomplete');
    }
    for (let index = 0; index < members.length; index += 1) {
      const memberDescriptors = assertExactKeys(
        members[index],
        ['disposition', 'effects', 'refKey'],
        `publication receipt.members[${index}]`,
      );
      const expectedMember = manifest.members[index];
      const effects = memberDescriptors.effects.value;
      const plans = publicationEffectPlans(expectedMember);
      if (
        memberDescriptors.refKey.value !== expectedMember.refKey
        || memberDescriptors.disposition.value !== 'AFTER'
        || !Array.isArray(effects)
        || effects.length !== plans.length
      ) throw new TypeError('publication receipt member does not match the manifest');
      for (let effectIndex = 0; effectIndex < plans.length; effectIndex += 1) {
        assertRelocationReceipt(
          effects[effectIndex],
          plans[effectIndex],
          `publication receipt.members[${index}].effects[${effectIndex}]`,
        );
      }
    }
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired('files_published receipt is malformed', cause);
  }
}

function assertCompleteStage(parsed) {
  const expected = expectedStageReservations(parsed.reservation);
  if ([...expected.keys()].some((assetPath) => !parsed.ready.has(assetPath))) {
    throw recoveryRequired('staged recovery assets are incomplete');
  }
}

function stagedFacts(parsed) {
  return Object.freeze(parsed.reservation.members
    .filter((member) => member.after.exists)
    .map((member) => {
      const asset = readyForReservation(parsed, member.after.assetReservation);
      if (asset === null) throw recoveryRequired('staged-after asset is not ready');
      return Object.freeze({
        ref: refFromData(member.ref),
        byteSize: member.after.byteSize,
        rawSha256: member.after.sha256,
        fileIdentity: asset.fileIdentity,
        parentIdentity: member.final.parentIdentity,
      });
    }));
}

function controlledFactKey(row) {
  return `${row.role}:${row.resourceUid ?? ''}`;
}

function assertTargetBinding(target, parsed) {
  if (
    target.projectUid !== parsed.reservation.projectBinding.projectUid
    || target.projectInstanceId !== parsed.reservation.projectBinding.projectInstanceId
    || target.basisDigest !== parsed.reservation.basisDigest
    || target.baseGeneration !== parsed.reservation.baseGeneration
    || target.targetGeneration !== parsed.reservation.targetGeneration
    || !Array.isArray(target.controlledFiles)
  ) {
    throw new TypeError('projection target does not match the journal binding');
  }
  const facts = new Map(target.controlledFiles.map((row) => [controlledFactKey(row), row]));
  for (const member of parsed.reservation.members) {
    const key = `${member.ref.role}:${resourceUid(member.ref) ?? ''}`;
    const row = facts.get(key);
    if (!member.after.exists) {
      if (row !== undefined) throw new TypeError('deleted closure member remains in target facts');
      continue;
    }
    const asset = parsed.ready.get(member.after.assetReservation.path);
    if (
      row === undefined
      || row.byteSize !== member.after.byteSize
      || row.rawSha256 !== member.after.sha256
      || !sameIdentity(row.fileIdentity, asset.fileIdentity)
      || !sameIdentity(row.parentIdentity, member.final.parentIdentity)
    ) {
      throw new TypeError('target controlled-file identity is not the staged-after entity');
    }
  }
}

async function assertWrite(record, journalId, state) {
  await record.assertWriteAuthority(Object.freeze({
    journalId,
    projectBinding: record.projectBinding,
    state,
  }));
}

async function rehydrateTarget(record, parsed, manifest) {
  if (manifest.targetAsset === null) throw recoveryRequired('projection target asset is absent');
  const bytes = await record.filePublisher.readAsset({ asset: manifest.targetAsset });
  let target;
  try {
    target = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw recoveryRequired('projection target asset is not valid JSON', cause);
  }
  deepFreeze(target);
  let validated;
  try {
    validated = record.projectionStore.validateTarget(target);
    if (validated !== target) throw new TypeError('projection target validator replaced the target');
    assertTargetBinding(target, parsed);
  } catch (cause) {
    throw recoveryRequired('projection target no longer matches the journal binding', cause);
  }
  return target;
}

async function appendSimple(record, journalId, suffix, payload = {}) {
  await assertWrite(record, journalId, suffix);
  return appendEvent(record, `${EVENT_PREFIX}${suffix}`, deepFreeze({
    version: 1,
    journalId,
    ...payload,
  }));
}

async function inspectProjection(record, journalId, parsed, manifest) {
  const target = await rehydrateTarget(record, parsed, manifest);
  const journalEvidence = deepFreeze({
    journalId,
    manifestDigest: digestPlain(manifest),
    filesPublishedDigest: parsed.filesPublished?.manifestDigest ?? null,
  });
  const disposition = await record.projectionDisposition.inspectTarget({
    target,
    journalEvidence,
  });
  if (!['base', 'target', 'other'].includes(disposition)) {
    throw recoveryRequired('projection disposition is unknown');
  }
  return Object.freeze({ disposition, journalEvidence, target });
}

async function verifyFilesAfter(record, parsed) {
  if (parsed.state !== 'files_published' || parsed.filesPublished === null) {
    throw recoveryRequired('files_published evidence is absent');
  }
  const manifest = buildManifest(parsed);
  const inspection = await record.filePublisher.inspect({
    manifest,
    publicationReceipt: parsed.filesPublished.publication,
  });
  if (
    inspection?.disposition !== 'AFTER'
    || !Array.isArray(inspection.members)
    || inspection.members.length !== manifest.members.length
    || inspection.members.some((member, index) => (
      member?.refKey !== manifest.members[index].refKey || member.disposition !== 'AFTER'
    ))
  ) throw recoveryRequired('files no longer match the published AFTER scene');
  return manifest;
}

async function recoverProjection(record, journalId, parsed) {
  const manifest = await verifyFilesAfter(record, parsed);
  const inspected = await inspectProjection(record, journalId, parsed, manifest);
  const { journalEvidence, target } = inspected;
  let { disposition } = inspected;
  if (disposition === 'target') {
    await appendSimple(record, journalId, 'projection_committed', {
      manifestDigest: digestPlain(manifest),
    });
    return 'projection_committed';
  }
  if (disposition !== 'base') throw recoveryRequired('projection disposition is other or unknown');
  await assertWrite(record, journalId, 'projection_publish');
  await record.projectionStore.publish({ projectStore: record.projectStore, target });
  faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_PROJECTION_PUBLISH, {
    journalId,
    manifestDigest: digestPlain(manifest),
  });
  disposition = await record.projectionDisposition.inspectTarget({ target, journalEvidence });
  if (disposition !== 'target') throw recoveryRequired('projection did not reach exact target');
  await appendSimple(record, journalId, 'projection_committed', {
    manifestDigest: digestPlain(manifest),
  });
  return 'projection_committed';
}

class FilePublicationJournal {
  constructor({
    controlStore,
    filePublisher,
    projectionStore,
    projectStore,
    projectionDisposition,
    parentAuthority,
    projectBinding,
    assertWriteAuthority,
  }) {
    if (
      controlStore === null
      || typeof controlStore !== 'object'
      || typeof controlStore.compareAndAppend !== 'function'
      || typeof controlStore.read !== 'function'
      || typeof controlStore.tail !== 'function'
    ) throw new TypeError('controlStore is invalid');
    const safeProjectBinding = snapshotProjectBinding(projectBinding);
    const expectedControlDirectory = path.join(
      safeProjectBinding.dataRoot,
      'control',
      'manuscripts',
      safeProjectBinding.projectUid,
      safeProjectBinding.projectInstanceId,
    );
    if (
      controlStore.directory !== expectedControlDirectory
      || controlStore.incarnationId !== safeProjectBinding.controlIncarnationId
    ) throw recoveryRequired('ControlStore does not match the project binding');
    if (
      filePublisher === null
      || typeof filePublisher !== 'object'
      || !['createAsset', 'readAsset', 'inspect', 'publish', 'rollback', 'collect']
        .every((method) => typeof filePublisher[method] === 'function')
    ) throw new TypeError('filePublisher is invalid');
    if (
      projectionStore === null
      || typeof projectionStore !== 'object'
      || typeof projectionStore.validateTarget !== 'function'
      || typeof projectionStore.publish !== 'function'
    ) throw new TypeError('projectionStore is invalid');
    if (
      projectionDisposition === null
      || typeof projectionDisposition !== 'object'
      || typeof projectionDisposition.inspectTarget !== 'function'
    ) throw new TypeError('projectionDisposition is invalid');
    if (
      parentAuthority === null
      || typeof parentAuthority !== 'object'
      || !['assertReservation', 'assertPin', 'readRecoveryIntent', 'assertGc']
        .every((method) => typeof parentAuthority[method] === 'function')
    ) throw new TypeError('parentAuthority is invalid');
    if (typeof assertWriteAuthority !== 'function') {
      throw new TypeError('assertWriteAuthority is required');
    }
    journalRecords.set(this, Object.seal({
      controlStore,
      filePublisher,
      projectionStore,
      projectStore,
      projectionDisposition,
      parentAuthority,
      projectBinding: safeProjectBinding,
      assertWriteAuthority,
      authority: null,
    }));
    Object.freeze(this);
  }

  async stageAssets({
    journalId,
    logicalRequestId,
    baseGeneration,
    targetGeneration,
    basisDigest,
    closure,
    identityReservation,
    parent,
    parentReservationAuthority,
  }) {
    const record = journalRecords.get(this);
    if (record === undefined) throw new TypeError('invalid FilePublicationJournal receiver');
    const safeJournalId = assertCanonicalUuid(journalId, 'journal_id');
    if (typeof logicalRequestId !== 'string' || logicalRequestId.length === 0) {
      throw new TypeError('logicalRequestId is required');
    }
    if (
      !Number.isSafeInteger(baseGeneration)
      || baseGeneration < 0
      || !Number.isSafeInteger(targetGeneration)
      || targetGeneration <= baseGeneration
    ) throw new TypeError('publication generations are invalid');
    const safeBasisDigest = assertDigest(basisDigest, 'basisDigest');
    const safeParent = snapshotParent(parent);
    const mode = modeForParent(safeParent);
    const safeReservation = identityReservation === null
      ? null
      : snapshotPlainData(identityReservation, 'identityReservation', true);

    // Copies all caller buffers before the first await.
    const privateClosure = snapshotClosure(closure, record.projectBinding);
    const members = buildReservationMembers(privateClosure, record.projectBinding, safeJournalId);
    const inputBinding = deepFreeze({
      journalId: safeJournalId,
      logicalRequestId,
      baseGeneration,
      targetGeneration,
      basisDigest: safeBasisDigest,
      identityReservation: safeReservation,
      parent: safeParent,
      projectBinding: record.projectBinding,
      members,
    });
    const reservationPayload = deepFreeze({
      version: 1,
      record_kind: 'reservation',
      journalId: safeJournalId,
      mode,
      parent: safeParent,
      projectBinding: record.projectBinding,
      logicalRequestId,
      baseGeneration,
      targetGeneration,
      basisDigest: safeBasisDigest,
      identityReservation: safeReservation,
      inputDigest: digestPlain(inputBinding),
      members,
    });

    if (mode === 'file_only') {
      await record.parentAuthority.assertReservation({
        authority: parentReservationAuthority,
        parent: safeParent,
        childReservation: reservationPayload,
      });
    }
    await assertWrite(record, safeJournalId, 'assets_reservation');
    let parsed = parseJournal(record, safeJournalId);
    if (parsed.reservation === null) {
      appendEvent(record, `${EVENT_PREFIX}assets_reserved`, reservationPayload);
      faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_ASSETS_RESERVED, {
        journalId: safeJournalId,
      });
    } else if (canonicalJson(parsed.reservation) !== canonicalJson(reservationPayload)) {
      throw recoveryRequired('journalId is already bound to another logical publication');
    }
    parsed = parseJournal(record, safeJournalId);
    if (!['assets_reserved', 'target_reserved'].includes(parsed.state)) {
      throw recoveryRequired('stageAssets cannot resume after the journal advanced');
    }
    const privateMembers = new Map(privateClosure.map((member) => [member.refKey, member]));
    for (const member of parsed.reservation.members) {
      const privateMember = privateMembers.get(member.refKey);
      const pending = [
        [member.before.assetReservation, privateMember.before.bytes],
        [member.after.assetReservation, privateMember.after.bytes],
      ];
      for (const [asset, bytes] of pending) {
        if (asset === null || parsed.ready.has(asset.path)) continue;
        if (parsed.state !== 'assets_reserved') {
          throw recoveryRequired('advanced journal is missing a reserved staged asset');
        }
        await assertWrite(record, safeJournalId, `create_${asset.assetKind}`);
        const ready = await record.filePublisher.createAsset({ reservation: asset, bytes });
        faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_ASSET_CREATE, {
          assetKind: asset.assetKind,
          journalId: safeJournalId,
          path: asset.path,
        });
        await assertWrite(record, safeJournalId, `ready_${asset.assetKind}`);
        appendEvent(record, `${EVENT_PREFIX}assets_reserved`, deepFreeze({
          version: 1,
          record_kind: 'asset_ready',
          journalId: safeJournalId,
          reservationDigest: parsed.reservationDigest,
          asset: ready,
        }));
        parsed = parseJournal(record, safeJournalId);
      }
    }
    assertCompleteStage(parsed);
    const reservationManifest = buildManifest(parsed);
    const stagedAssets = Object.freeze({ capability: 'file_publication_staged_assets' });
    stagedAssetRecords.set(stagedAssets, Object.freeze({
      owner: this,
      journalId: safeJournalId,
      reservationDigest: parsed.reservationDigest,
    }));
    return Object.freeze({
      stagedAssets,
      stagedAfterFacts: stagedFacts(parsed),
      reservationManifest,
    });
  }

  async bindTarget({ stagedAssets, projectionTarget }) {
    const record = journalRecords.get(this);
    const capability = stagedAssetRecords.get(stagedAssets);
    if (record === undefined || capability?.owner !== this) {
      throw new TypeError('stagedAssets is not an opaque capability from this journal');
    }
    let parsed = parseJournal(record, capability.journalId);
    if (
      !['assets_reserved', 'target_reserved'].includes(parsed.state)
      || parsed.reservationDigest !== capability.reservationDigest
    ) {
      throw recoveryRequired('stagedAssets no longer matches journal state');
    }
    assertCompleteStage(parsed);
    const target = record.projectionStore.validateTarget(projectionTarget);
    if (target !== projectionTarget || !Object.isFrozen(target)) {
      throw new TypeError('projection target must be the recursively frozen validated target');
    }
    assertTargetBinding(target, parsed);
    const targetBytes = Buffer.from(JSON.stringify(target), 'utf8');
    const targetAssetReservation = assetReservation(
      'projection_target',
      recoveryPath(record.projectBinding, capability.journalId, 'projection-target.json'),
      record.projectBinding.recoveryRootIdentity,
      targetBytes,
    );
    const targetPayload = deepFreeze({
      version: 1,
      record_kind: 'reservation',
      journalId: capability.journalId,
      reservationDigest: parsed.reservationDigest,
      targetDigest: sha256(targetBytes),
      targetAssetReservation,
    });
    if (parsed.state === 'assets_reserved') {
      await assertWrite(record, capability.journalId, 'target_reservation');
      appendEvent(record, `${EVENT_PREFIX}target_reserved`, targetPayload);
      faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_TARGET_RESERVED, {
        journalId: capability.journalId,
      });
      parsed = parseJournal(record, capability.journalId);
    } else if (canonicalJson(parsed.targetReservation) !== canonicalJson(targetPayload)) {
      throw recoveryRequired('target_reserved is bound to another projection target');
    }
    if (parsed.targetReady === null) {
      await assertWrite(record, capability.journalId, 'create_projection_target');
      const targetReady = await record.filePublisher.createAsset({
        reservation: targetAssetReservation,
        bytes: targetBytes,
      });
      faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_TARGET_ASSET_CREATE, {
        journalId: capability.journalId,
        path: targetAssetReservation.path,
      });
      faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_ASSET_CREATE, {
        assetKind: 'projection_target',
        journalId: capability.journalId,
        path: targetAssetReservation.path,
      });
      await assertWrite(record, capability.journalId, 'ready_projection_target');
      appendEvent(record, `${EVENT_PREFIX}target_reserved`, deepFreeze({
        version: 1,
        record_kind: 'asset_ready',
        journalId: capability.journalId,
        targetReservationDigest: digestPlain(targetPayload),
        asset: targetReady,
      }));
    } else {
      const persisted = await record.filePublisher.readAsset({ asset: parsed.targetReady });
      if (!persisted.equals(targetBytes)) {
        throw recoveryRequired('ready projection target bytes changed');
      }
    }
    parsed = parseJournal(record, capability.journalId);
    const manifest = buildManifest(parsed);
    const preparedAssets = Object.freeze({ capability: 'file_publication_prepared_assets' });
    preparedAssetRecords.set(preparedAssets, Object.freeze({
      owner: this,
      journalId: capability.journalId,
      manifestDigest: digestPlain(manifest),
    }));
    return Object.freeze({ preparedAssets, manifest });
  }

  async prepare({ preparedAssets, parentPinAuthority }) {
    const record = journalRecords.get(this);
    const capability = preparedAssetRecords.get(preparedAssets);
    if (record === undefined || capability?.owner !== this) {
      throw new TypeError('preparedAssets is not an opaque capability from this journal');
    }
    const parsed = parseJournal(record, capability.journalId);
    if (parsed.state !== 'target_reserved' || parsed.targetReady === null) {
      throw recoveryRequired('preparedAssets no longer matches journal state');
    }
    const manifest = buildManifest(parsed);
    if (digestPlain(manifest) !== capability.manifestDigest) {
      throw recoveryRequired('preparedAssets manifest digest changed');
    }
    if (parsed.reservation.mode === 'file_only') {
      await record.parentAuthority.assertPin({
        authority: parentPinAuthority,
        parent: parsed.reservation.parent,
        manifest,
      });
    }
    await appendSimple(record, capability.journalId, 'prepared', {
      manifestDigest: capability.manifestDigest,
      recovery: 'none',
    });
    faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_PREPARED, {
      journalId: capability.journalId,
    });
    return Object.freeze({ state: 'prepared' });
  }

  async publishFiles(journalId) {
    const record = journalRecords.get(this);
    const safeJournalId = assertCanonicalUuid(journalId, 'journal_id');
    const parsed = parseJournal(record, safeJournalId);
    if (parsed.state === 'files_published') {
      await verifyFilesAfter(record, parsed);
      return Object.freeze({ state: 'files_published' });
    }
    if (parsed.state !== 'prepared') throw recoveryRequired('publishFiles requires prepared state');
    const manifest = buildManifest(parsed);
    const manifestDigest = digestPlain(manifest);
    if (parsed.manifestDigest !== manifestDigest) throw recoveryRequired('prepared manifest digest changed');
    if (parsed.reservation.mode === 'full') {
      const projection = await inspectProjection(record, safeJournalId, parsed, manifest);
      if (projection.disposition !== 'base') {
        throw recoveryRequired('full publication requires the exact base projection');
      }
    }
    await assertWrite(record, safeJournalId, 'publish_files');
    const publication = await record.filePublisher.publish({ manifest });
    assertPublicationReceipt(publication, manifest);
    await appendSimple(record, safeJournalId, 'files_published', {
      manifestDigest,
      publication,
    });
    faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_FILES_PUBLISHED, {
      journalId: safeJournalId,
    });
    await verifyFilesAfter(record, parseJournal(record, safeJournalId));
    return Object.freeze({ state: 'files_published' });
  }

  async commitProjection(journalId) {
    const record = journalRecords.get(this);
    const safeJournalId = assertCanonicalUuid(journalId, 'journal_id');
    const parsed = parseJournal(record, safeJournalId);
    if (parsed.reservation?.mode !== 'full') {
      throw new TypeError('file_only journal cannot commit projection');
    }
    if (parsed.state === 'projection_committed') return Object.freeze({ state: parsed.state });
    if (parsed.state !== 'files_published') {
      throw recoveryRequired('commitProjection requires files_published state');
    }
    const state = await recoverProjection(record, safeJournalId, parsed);
    return Object.freeze({ state });
  }

  async complete(journalId) {
    const record = journalRecords.get(this);
    const safeJournalId = assertCanonicalUuid(journalId, 'journal_id');
    const parsed = parseJournal(record, safeJournalId);
    if (parsed.state === 'completed') return Object.freeze({ state: 'completed' });
    if (parsed.reservation?.mode !== 'full' || parsed.state !== 'projection_committed') {
      throw recoveryRequired('complete requires full projection_committed state');
    }
    await appendSimple(record, safeJournalId, 'completed', {
      manifestDigest: parsed.manifestDigest,
    });
    return Object.freeze({ state: 'completed' });
  }

  async recover(journalId, { parentRecoveryIntent } = {}) {
    const record = journalRecords.get(this);
    const safeJournalId = assertCanonicalUuid(journalId, 'journal_id');
    let parsed = parseJournal(record, safeJournalId);
    if (parsed.state === null) throw recoveryRequired('journal does not exist');
    if (['completed', 'rolled_back', 'assets_collected'].includes(parsed.state)) {
      return Object.freeze({ state: parsed.state });
    }
    if (parsed.reservation.mode === 'file_only') {
      const assetManifest = buildManifest(parsed);
      const disposition = await record.parentAuthority.readRecoveryIntent({
        authority: parentRecoveryIntent,
        parent: parsed.reservation.parent,
        assetManifest,
      });
      if (!['before', 'after'].includes(disposition)) {
        throw recoveryRequired('parent recovery authority returned an invalid disposition');
      }
      if (disposition === 'before') {
        if (['prepared', 'files_published'].includes(parsed.state)) {
          await assertWrite(record, safeJournalId, 'rollback_files');
          const result = await record.filePublisher.rollback({
            manifest: assetManifest,
            publicationReceipt: parsed.filesPublished?.publication,
          });
          if (result?.disposition !== 'BEFORE') throw recoveryRequired('rollback did not prove BEFORE');
        } else {
          const inspection = await record.filePublisher.inspect({
            manifest: assetManifest,
            scope: 'safe_abort',
          });
          if (inspection?.disposition !== 'SAFE_ABORT') {
            throw recoveryRequired('safe abort did not prove the article tree unchanged');
          }
        }
        await appendSimple(record, safeJournalId, 'rolled_back', {
          manifestDigest: digestPlain(assetManifest),
        });
        return Object.freeze({ state: 'rolled_back' });
      }
      if (parsed.targetReady === null) {
        throw recoveryRequired('parent requested AFTER before a complete pinned manifest exists');
      }
      if (parsed.state === 'target_reserved') {
        await appendSimple(record, safeJournalId, 'prepared', {
          manifestDigest: digestPlain(assetManifest),
          recovery: 'parent_after',
        });
        parsed = parseJournal(record, safeJournalId);
      }
      if (parsed.state === 'prepared') await this.publishFiles(safeJournalId);
      parsed = parseJournal(record, safeJournalId);
      await verifyFilesAfter(record, parsed);
      return Object.freeze({ state: 'files_published' });
    }
    if (parsed.state === 'assets_reserved') {
      const manifest = buildManifest(parsed);
      const inspection = await record.filePublisher.inspect({
        manifest,
        scope: 'safe_abort',
      });
      if (inspection?.disposition !== 'SAFE_ABORT') {
        throw recoveryRequired('safe abort did not prove the article tree unchanged');
      }
      await appendSimple(record, safeJournalId, 'rolled_back', {
        manifestDigest: digestPlain(manifest),
      });
      return Object.freeze({ state: 'rolled_back' });
    }
    if (parsed.state === 'target_reserved') {
      if (parsed.targetReady === null) {
        const manifest = buildManifest(parsed);
        const inspection = await record.filePublisher.inspect({
          manifest,
          scope: 'safe_abort',
        });
        if (inspection?.disposition !== 'SAFE_ABORT') {
          throw recoveryRequired('safe abort did not prove the article tree unchanged');
        }
        await appendSimple(record, safeJournalId, 'rolled_back', {
          manifestDigest: digestPlain(manifest),
        });
        return Object.freeze({ state: 'rolled_back' });
      }
      const manifest = buildManifest(parsed);
      await appendSimple(record, safeJournalId, 'prepared', {
        manifestDigest: digestPlain(manifest),
        recovery: 'full',
      });
      parsed = parseJournal(record, safeJournalId);
    }
    if (parsed.state === 'prepared') {
      await this.publishFiles(safeJournalId);
      parsed = parseJournal(record, safeJournalId);
    }
    if (parsed.state === 'files_published') {
      await recoverProjection(record, safeJournalId, parsed);
      parsed = parseJournal(record, safeJournalId);
    }
    if (parsed.state === 'projection_committed') {
      await this.complete(safeJournalId);
      return Object.freeze({ state: 'completed' });
    }
    return Object.freeze({ state: parsed.state });
  }

  async collectAssets(journalId, { parentGcAuthority } = {}) {
    const record = journalRecords.get(this);
    const safeJournalId = assertCanonicalUuid(journalId, 'journal_id');
    const parsed = parseJournal(record, safeJournalId);
    if (parsed.state === 'assets_collected') return Object.freeze({ state: 'assets_collected' });
    const fileOnlyPublished = parsed.reservation?.mode === 'file_only' && parsed.state === 'files_published';
    if (!['completed', 'rolled_back'].includes(parsed.state) && !fileOnlyPublished) {
      throw recoveryRequired('journal is not eligible for asset collection');
    }
    const assetManifest = buildManifest(parsed);
    if (parsed.reservation.mode === 'file_only') {
      await record.parentAuthority.assertGc({
        authority: parentGcAuthority,
        parent: parsed.reservation.parent,
        assetManifest,
        childState: parsed.state,
      });
    }
    await assertWrite(record, safeJournalId, 'collect_assets');
    const terminalDisposition = parsed.state === 'rolled_back' ? 'BEFORE' : 'AFTER';
    const collected = await record.filePublisher.collect({
      manifest: assetManifest,
      publicationReceipt: parsed.filesPublished?.publication,
      terminalDisposition,
    });
    if (collected?.disposition !== 'COLLECTED') {
      throw recoveryRequired('recovery assets are not exact owned entities');
    }
    await appendSimple(record, safeJournalId, 'assets_collected', {
      manifestDigest: digestPlain(assetManifest),
      assets: collected.assets,
    });
    return Object.freeze({ state: 'assets_collected' });
  }

  journalAuthority() {
    const record = journalRecords.get(this);
    if (record === undefined) throw new TypeError('invalid FilePublicationJournal receiver');
    if (record.authority !== null) return record.authority;
    record.authority = mintJournalAuthorityCapability({
      resolveCandidate: async () => null,
    }, JOURNAL_AUTHORITY_OPTIONS);
    return record.authority;
  }
}

module.exports = {
  FilePublicationJournal,
};
