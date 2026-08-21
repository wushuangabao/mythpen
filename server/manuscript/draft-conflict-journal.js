'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const { assertCanonicalUuid, manuscriptError } = require('./contracts');
const { faultPoint } = require('../testing/fault-injection');

const EVENT_PREFIX = 'draft_conflict.';
const EVENT_VERSION = 1;
const EVENT_SUFFIXES = new Set([
  'conflict_detected',
  'backup_durable',
  'decision_ready',
  'resolve_accept_intent',
  'resolve_apply_intent',
  'resolved_accept_external',
  'resolved_apply_draft',
  'resolve_apply_aborted',
  'superseded',
  'archived',
]);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const journalRecords = new WeakMap();
const intentRecords = new WeakMap();

function recoveryRequired(reason, details = {}, cause) {
  return manuscriptError('RECOVERY_REQUIRED', { reason, ...details }, cause);
}

function projectionStale(conflictId, decisionEpoch, state) {
  return manuscriptError('PROJECTION_STALE', { conflictId, decisionEpoch, state });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDescriptors(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const expected = keys.slice().sort();
  if (
    actual.some((key) => typeof key !== 'string')
    || actual.slice().sort().join('\0') !== expected.join('\0')
    || actual.some((key) => {
      const descriptor = descriptors[key];
      return descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value');
    })
  ) throw new TypeError(`${label} has an invalid shape`);
  return descriptors;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new TypeError('serializable journal data cannot contain bytes');
  }
  if (seen.has(value)) throw new TypeError('serializable journal data must be acyclic');
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function snapshotPlain(value, label, requireFrozen = false, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} is invalid`);
    return value;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new TypeError(`${label} must contain serializable plain data`);
  }
  if (requireFrozen && !Object.isFrozen(value)) throw new TypeError(`${label} must be recursively frozen`);
  if (seen.has(value)) throw new TypeError(`${label} must be acyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${label} must be a dense array`);
        }
        result.push(snapshotPlain(descriptor.value, `${label}[${index}]`, requireFrozen, seen));
      }
      if (keys.some((key) => (
        key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)
      ))) throw new TypeError(`${label} must be an exact array`);
      return Object.freeze(result);
    }
    if (!isPlainObject(value)) throw new TypeError(`${label} must contain plain objects`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string'
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) throw new TypeError(`${label} must contain enumerable string data properties only`);
      result[key] = snapshotPlain(descriptor.value, `${label}.${key}`, requireFrozen, seen);
    }
    return Object.freeze(result);
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

function assertGeneration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative millisecond timestamp`);
  }
  return value;
}

function snapshotIdentity(value, label) {
  const descriptors = exactDescriptors(value, ['dev', 'ino'], label);
  const dev = descriptors.dev.value;
  const ino = descriptors.ino.value;
  if (
    typeof dev !== 'string'
    || !/^[0-9]+$/u.test(dev)
    || typeof ino !== 'string'
    || !/^[0-9]+$/u.test(ino)
  ) throw new TypeError(`${label} must contain decimal dev and ino strings`);
  return Object.freeze({ dev, ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function snapshotResource(value, label = 'resource') {
  const descriptors = exactDescriptors(value, ['domain', 'kind', 'uid'], label);
  const kind = descriptors.kind.value;
  const domain = descriptors.domain.value;
  if (!['chapter', 'volume', 'manuscript'].includes(kind)) {
    throw new TypeError(`${label}.kind is invalid`);
  }
  const allowedDomains = {
    chapter: new Set(['body', 'sidecar', 'structure']),
    volume: new Set(['volume_metadata', 'structure']),
    manuscript: new Set(['structure']),
  };
  if (!allowedDomains[kind].has(domain)) throw new TypeError(`${label}.domain is invalid for kind`);
  return Object.freeze({
    kind,
    uid: assertCanonicalUuid(descriptors.uid.value, `${kind}_uid`),
    domain,
  });
}

function snapshotFieldMask(value, label = 'fieldMask') {
  const snapshot = snapshotPlain(value, label);
  if (
    !Array.isArray(snapshot)
    || snapshot.length === 0
    || snapshot.some((field) => typeof field !== 'string' || field.length === 0)
  ) throw new TypeError(`${label} must be a non-empty string array`);
  const canonical = snapshot.slice().sort();
  if (new Set(canonical).size !== canonical.length || canonical.join('\0') !== snapshot.join('\0')) {
    throw new TypeError(`${label} must be sorted and unique`);
  }
  return snapshot;
}

function samePlain(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function snapshotProjectBinding(value) {
  const descriptors = exactDescriptors(value, [
    'controlIncarnationId',
    'dataRoot',
    'projectInstanceId',
    'projectUid',
  ], 'projectBinding');
  const dataRoot = descriptors.dataRoot.value;
  if (
    typeof dataRoot !== 'string'
    || dataRoot.length === 0
    || dataRoot.includes('\0')
    || !path.isAbsolute(dataRoot)
    || path.resolve(dataRoot) !== dataRoot
    || path.normalize(dataRoot) !== dataRoot
  ) throw new TypeError('projectBinding.dataRoot must be an absolute canonical path');
  const controlIncarnationId = descriptors.controlIncarnationId.value;
  if (typeof controlIncarnationId !== 'string' || controlIncarnationId.length === 0) {
    throw new TypeError('projectBinding.controlIncarnationId is required');
  }
  return Object.freeze({
    dataRoot,
    projectUid: assertCanonicalUuid(descriptors.projectUid.value, 'project_uid'),
    projectInstanceId: assertCanonicalUuid(
      descriptors.projectInstanceId.value,
      'project_instance_id',
    ),
    controlIncarnationId,
  });
}

function capturePort(port, methodNames, label, exact = false) {
  if (port === null || (typeof port !== 'object' && typeof port !== 'function')) {
    throw new TypeError(`${label} is required`);
  }
  const descriptors = exact ? exactDescriptors(port, methodNames, label) : null;
  const captured = {};
  for (const methodName of methodNames) {
    const method = descriptors ? descriptors[methodName].value : port[methodName];
    if (typeof method !== 'function') throw new TypeError(`${label}.${methodName} is required`);
    captured[methodName] = method.bind(port);
  }
  return Object.freeze(captured);
}

function snapshotCreateInput(value) {
  const descriptors = exactDescriptors(value, [
    'basis',
    'draftBytes',
    'externalBytes',
    'fieldMask',
    'resource',
    'supersedes',
  ], 'createConflict input');
  const basisDescriptors = exactDescriptors(
    descriptors.basis.value,
    ['baseGeneration', 'baseRawSha256'],
    'basis',
  );
  const draftBytes = descriptors.draftBytes.value;
  const externalBytes = descriptors.externalBytes.value;
  if (!Buffer.isBuffer(draftBytes) || !Buffer.isBuffer(externalBytes)) {
    throw new TypeError('draftBytes and externalBytes must be Buffer values');
  }
  const supersedes = descriptors.supersedes.value;
  return Object.freeze({
    resource: snapshotResource(descriptors.resource.value),
    basis: Object.freeze({
      baseGeneration: assertGeneration(basisDescriptors.baseGeneration.value, 'baseGeneration'),
      baseRawSha256: assertDigest(basisDescriptors.baseRawSha256.value, 'baseRawSha256'),
    }),
    draftBytes: Buffer.from(draftBytes),
    externalBytes: Buffer.from(externalBytes),
    fieldMask: snapshotFieldMask(descriptors.fieldMask.value),
    supersedes: supersedes === null
      ? null
      : assertCanonicalUuid(supersedes, 'supersedes'),
  });
}

function layoutSource(input) {
  return Object.freeze({
    domain: 'mythpen.draft-conflict.backup-layout',
    version: 1,
    projectUid: input.projectUid,
    projectInstanceId: input.projectInstanceId,
    conflictId: input.conflictId,
    backupRootPath: input.backupRootPath,
    conflictDirectoryPath: input.conflictDirectoryPath,
    resource: input.resource,
    baseGeneration: input.baseGeneration,
    baseRawSha256: input.baseRawSha256,
    fieldMask: input.fieldMask,
    files: Object.freeze([
      Object.freeze({
        name: 'draft.bin',
        byteSize: input.draftByteSize,
        rawSha256: input.draftRawSha256,
      }),
      Object.freeze({
        name: 'external.bin',
        byteSize: input.externalByteSize,
        rawSha256: input.externalRawSha256,
      }),
      Object.freeze({ name: 'manifest.json' }),
    ]),
  });
}

function backupPaths(record, conflictId) {
  const backupRootPath = path.join(record.controlDirectory, 'draft-conflict');
  return Object.freeze({
    backupRootPath,
    conflictDirectoryPath: path.join(backupRootPath, conflictId),
  });
}

function manifestFromDetected(detected, record) {
  const paths = backupPaths(record, detected.conflictId);
  return deepFreeze({
    domain: 'mythpen.draft-conflict.backup',
    version: 1,
    projectUid: detected.projectUid,
    projectInstanceId: detected.projectInstanceId,
    conflictId: detected.conflictId,
    backupRootPath: paths.backupRootPath,
    conflictDirectoryPath: paths.conflictDirectoryPath,
    resource: detected.resource,
    basis: Object.freeze({
      baseGeneration: detected.baseGeneration,
      baseRawSha256: detected.baseRawSha256,
    }),
    fieldMask: detected.fieldMask,
    draft: Object.freeze({
      name: 'draft.bin',
      byteSize: detected.draftByteSize,
      rawSha256: detected.draftRawSha256,
    }),
    external: Object.freeze({
      name: 'external.bin',
      byteSize: detected.externalByteSize,
      rawSha256: detected.externalRawSha256,
    }),
    manifestFileName: 'manifest.json',
    layoutDigest: detected.backupLayoutDigest,
  });
}

function expectedReceiptFiles(manifest) {
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  return [
    { name: 'draft.bin', byteSize: manifest.draft.byteSize, rawSha256: manifest.draft.rawSha256 },
    {
      name: 'external.bin',
      byteSize: manifest.external.byteSize,
      rawSha256: manifest.external.rawSha256,
    },
    { name: 'manifest.json', byteSize: manifestBytes.length, rawSha256: sha256(manifestBytes) },
  ];
}

function validateCompleteReceipt(value, manifest) {
  let receipt;
  try {
    receipt = snapshotPlain(value, 'backup receipt', true);
    exactDescriptors(receipt, [
      'conflictId',
      'directoryFlushed',
      'directoryIdentity',
      'directoryPath',
      'files',
      'layoutDigest',
      'parentFlushed',
      'parentIdentity',
      'parentPath',
      'projectInstanceId',
      'projectUid',
      'status',
    ], 'backup receipt');
    if (
      receipt.status !== 'complete'
      || receipt.projectUid !== manifest.projectUid
      || receipt.projectInstanceId !== manifest.projectInstanceId
      || receipt.conflictId !== manifest.conflictId
      || receipt.layoutDigest !== manifest.layoutDigest
      || receipt.directoryPath !== manifest.conflictDirectoryPath
      || receipt.parentPath !== manifest.backupRootPath
      || receipt.directoryFlushed !== true
      || receipt.parentFlushed !== true
    ) throw new TypeError('backup receipt binding is incomplete');
    const directoryIdentity = snapshotIdentity(receipt.directoryIdentity, 'directoryIdentity');
    snapshotIdentity(receipt.parentIdentity, 'parentIdentity');
    if (!Array.isArray(receipt.files) || receipt.files.length !== 3) {
      throw new TypeError('backup receipt files are incomplete');
    }
    const expected = expectedReceiptFiles(manifest);
    const identities = new Set();
    for (let index = 0; index < expected.length; index += 1) {
      const file = receipt.files[index];
      exactDescriptors(file, [
        'byteSize',
        'fileIdentity',
        'flushed',
        'name',
        'parentIdentity',
        'rawSha256',
        'readback',
      ], `backup receipt file ${index}`);
      const fileIdentity = snapshotIdentity(file.fileIdentity, `fileIdentity ${index}`);
      const parentIdentity = snapshotIdentity(file.parentIdentity, `file parentIdentity ${index}`);
      const expectedFile = expected[index];
      if (
        file.name !== expectedFile.name
        || file.byteSize !== expectedFile.byteSize
        || file.rawSha256 !== expectedFile.rawSha256
        || file.flushed !== true
        || file.readback !== true
        || !sameIdentity(parentIdentity, directoryIdentity)
      ) throw new TypeError(`backup receipt file ${expectedFile.name} does not match`);
      const identityKey = `${fileIdentity.dev}:${fileIdentity.ino}`;
      if (identities.has(identityKey)) throw new TypeError('backup file identities overlap');
      identities.add(identityKey);
    }
    return receipt;
  } catch (cause) {
    throw recoveryRequired('draft conflict backup completeness is unproven', {
      conflictId: manifest.conflictId,
    }, cause);
  }
}

function validateIncompleteInspection(value, manifest) {
  try {
    const inspection = snapshotPlain(value, 'backup inspection', true);
    exactDescriptors(
      inspection,
      ['conflictId', 'externalContents', 'owned', 'status'],
      'backup inspection',
    );
    if (
      inspection.status !== 'incomplete'
      || inspection.conflictId !== manifest.conflictId
      || inspection.owned !== true
      || inspection.externalContents !== false
    ) throw new TypeError('incomplete backup is not exclusively owned');
    return inspection;
  } catch (cause) {
    throw recoveryRequired('incomplete draft conflict backup cannot be safely removed', {
      conflictId: manifest.conflictId,
    }, cause);
  }
}

function validateDiscardReceipt(value, manifest) {
  try {
    const receipt = snapshotPlain(value, 'discard receipt', true);
    exactDescriptors(receipt, ['conflictId', 'removed'], 'discard receipt');
    if (receipt.conflictId !== manifest.conflictId || receipt.removed !== true) {
      throw new TypeError('discard receipt does not prove removal');
    }
    return receipt;
  } catch (cause) {
    throw recoveryRequired('incomplete draft conflict backup removal is unproven', {
      conflictId: manifest.conflictId,
    }, cause);
  }
}

function commonPayload(record, detected, decisionEpoch) {
  return {
    version: EVENT_VERSION,
    projectUid: record.binding.projectUid,
    projectInstanceId: record.binding.projectInstanceId,
    conflictId: detected.conflictId,
    resource: detected.resource,
    decisionEpoch,
  };
}

const COMMON_KEYS = [
  'conflictId',
  'decisionEpoch',
  'projectInstanceId',
  'projectUid',
  'resource',
  'version',
];

function validateCommonPayload(payload, record, suffix) {
  if (!isPlainObject(payload)) throw recoveryRequired(`draft conflict ${suffix} payload is invalid`);
  if (
    payload.version !== EVENT_VERSION
    || payload.projectUid !== record.binding.projectUid
    || payload.projectInstanceId !== record.binding.projectInstanceId
  ) throw recoveryRequired(`draft conflict ${suffix} project binding drifted`);
  try {
    assertCanonicalUuid(payload.conflictId, 'conflict_id');
    const resource = snapshotResource(payload.resource);
    if (resource.kind === 'manuscript' && resource.uid !== record.binding.projectUid) {
      throw new TypeError('manuscript resource belongs to another project');
    }
    assertGeneration(payload.decisionEpoch, 'decisionEpoch');
  } catch (cause) {
    throw recoveryRequired(`draft conflict ${suffix} common payload is invalid`, {}, cause);
  }
}

function assertPayloadKeys(payload, extras, suffix) {
  try {
    exactDescriptors(payload, COMMON_KEYS.concat(extras), `${suffix} payload`);
  } catch (cause) {
    throw recoveryRequired(`draft conflict ${suffix} payload shape is invalid`, {}, cause);
  }
}

function parseDetected(payload, record) {
  validateCommonPayload(payload, record, 'conflict_detected');
  assertPayloadKeys(payload, [
    'backupLayoutDigest',
    'baseGeneration',
    'baseRawSha256',
    'createdAt',
    'draftByteSize',
    'draftRawSha256',
    'externalByteSize',
    'externalRawSha256',
    'fieldMask',
    'supersedes',
  ], 'conflict_detected');
  try {
    if (payload.decisionEpoch !== 0) {
      throw new TypeError('conflict_detected decisionEpoch must be zero');
    }
    const detected = deepFreeze({
      ...commonPayload(record, payload, 0),
      supersedes: payload.supersedes === null
        ? null
        : assertCanonicalUuid(payload.supersedes, 'supersedes'),
      baseGeneration: assertGeneration(payload.baseGeneration, 'baseGeneration'),
      baseRawSha256: assertDigest(payload.baseRawSha256, 'baseRawSha256'),
      externalRawSha256: assertDigest(payload.externalRawSha256, 'externalRawSha256'),
      draftRawSha256: assertDigest(payload.draftRawSha256, 'draftRawSha256'),
      externalByteSize: assertGeneration(payload.externalByteSize, 'externalByteSize'),
      draftByteSize: assertGeneration(payload.draftByteSize, 'draftByteSize'),
      fieldMask: snapshotFieldMask(payload.fieldMask),
      backupLayoutDigest: assertDigest(payload.backupLayoutDigest, 'backupLayoutDigest'),
      createdAt: assertTimestamp(payload.createdAt, 'createdAt'),
    });
    const expectedLayout = digestPlain(layoutSource({
      ...detected,
      projectUid: detected.projectUid,
      projectInstanceId: detected.projectInstanceId,
      ...backupPaths(record, detected.conflictId),
    }));
    if (detected.backupLayoutDigest !== expectedLayout) {
      throw new TypeError('backup layout digest is invalid');
    }
    return detected;
  } catch (cause) {
    throw recoveryRequired('conflict_detected payload is invalid', {
      conflictId: payload.conflictId,
    }, cause);
  }
}

function validateStableCommon(payload, detected, record, suffix, extras) {
  validateCommonPayload(payload, record, suffix);
  assertPayloadKeys(payload, extras, suffix);
  if (
    payload.conflictId !== detected.conflictId
    || payload.decisionEpoch < 0
    || !samePlain(payload.resource, detected.resource)
  ) throw recoveryRequired(`draft conflict ${suffix} identity drifted`, {
    conflictId: detected.conflictId,
  });
}

function parseJournalsUnchecked(record, suppliedEvents) {
  let events = suppliedEvents;
  if (events === undefined) events = record.control.read();
  if (!Array.isArray(events)) throw recoveryRequired('draft conflict event feed is invalid');
  const conflicts = new Map();
  const childJournalIds = new Set();
  for (const event of events) {
    if (!isPlainObject(event) || typeof event.type !== 'string') {
      throw recoveryRequired('draft conflict event envelope is invalid');
    }
    if (!event.type.startsWith(EVENT_PREFIX)) continue;
    const suffix = event.type.slice(EVENT_PREFIX.length);
    if (!EVENT_SUFFIXES.has(suffix)) throw recoveryRequired('unknown draft conflict event type');
    const payload = event.payload;
    validateCommonPayload(payload, record, suffix);
    const conflictId = payload.conflictId;
    let aggregate = conflicts.get(conflictId);
    if (suffix === 'conflict_detected') {
      if (aggregate) throw recoveryRequired('duplicate conflict_detected event', { conflictId });
      const detected = parseDetected(payload, record);
      if (detected.supersedes !== null) {
        const prior = conflicts.get(detected.supersedes);
        const duplicateSuccessor = Array.from(conflicts.values()).some((candidate) => (
          candidate.detected.supersedes === detected.supersedes
        ));
        if (
          !prior
          || duplicateSuccessor
          || !['backup_durable', 'decision_ready', 'resolve_accept_intent'].includes(prior.state)
          || !samePlain(prior.detected.resource, detected.resource)
          || prior.detected.externalRawSha256 === detected.externalRawSha256
        ) throw recoveryRequired('invalid draft conflict supersedes chain', { conflictId });
      }
      aggregate = {
        detected,
        state: 'conflict_detected',
        decisionEpoch: 0,
        intent: null,
        childJournalId: null,
        tailDigest: event.digest,
      };
      conflicts.set(conflictId, aggregate);
      continue;
    }
    if (!aggregate) throw recoveryRequired('draft conflict event has no owner', { conflictId });
    const { detected } = aggregate;
    validateStableCommon(payload, detected, record, suffix, (() => {
      if (suffix === 'backup_durable') return ['backupLayoutDigest'];
      if (suffix === 'decision_ready') return [];
      if (suffix === 'resolve_accept_intent') {
        return ['acceptedRawSha256', 'baseGeneration', 'targetGeneration'];
      }
      if (suffix === 'resolve_apply_intent') {
        return ['baseGeneration', 'childJournalId', 'externalRawSha256', 'targetGeneration'];
      }
      if (suffix === 'resolved_accept_external') {
        return ['acceptedRawSha256', 'targetGeneration'];
      }
      if (suffix === 'resolved_apply_draft') return ['childJournalId', 'targetGeneration'];
      if (suffix === 'resolve_apply_aborted') return ['childJournalId'];
      if (suffix === 'superseded') return ['successorConflictId'];
      return [];
    })());
    const epoch = payload.decisionEpoch;
    if (suffix === 'backup_durable') {
      if (
        aggregate.state !== 'conflict_detected'
        || epoch !== 0
        || payload.backupLayoutDigest !== detected.backupLayoutDigest
      ) throw recoveryRequired('invalid backup_durable transition', { conflictId });
      aggregate.state = suffix;
    } else if (suffix === 'decision_ready') {
      const expectedEpoch = aggregate.state === 'backup_durable'
        ? 0
        : aggregate.decisionEpoch + 1;
      if (
        !['backup_durable', 'resolve_apply_aborted'].includes(aggregate.state)
        || epoch !== expectedEpoch
      ) throw recoveryRequired('invalid decision_ready transition', { conflictId });
      aggregate.state = suffix;
      aggregate.decisionEpoch = epoch;
      aggregate.intent = null;
      aggregate.childJournalId = null;
    } else if (suffix === 'resolve_accept_intent') {
      if (
        aggregate.state !== 'decision_ready'
        || epoch !== aggregate.decisionEpoch
        || assertDigest(payload.acceptedRawSha256, 'acceptedRawSha256') !== detected.externalRawSha256
        || assertGeneration(payload.baseGeneration, 'baseGeneration') !== detected.baseGeneration
        || assertGeneration(payload.targetGeneration, 'targetGeneration') !== detected.baseGeneration + 1
      ) throw recoveryRequired('invalid resolve_accept_intent transition', { conflictId });
      aggregate.state = suffix;
      aggregate.intent = deepFreeze({
        kind: 'accept',
        conflictId,
        decisionEpoch: epoch,
        acceptedRawSha256: payload.acceptedRawSha256,
        baseGeneration: payload.baseGeneration,
        targetGeneration: payload.targetGeneration,
        resource: detected.resource,
      });
    } else if (suffix === 'resolve_apply_intent') {
      const childJournalId = assertCanonicalUuid(payload.childJournalId, 'child_journal_id');
      if (
        aggregate.state !== 'decision_ready'
        || epoch !== aggregate.decisionEpoch
        || childJournalIds.has(childJournalId)
        || assertDigest(payload.externalRawSha256, 'externalRawSha256') !== detected.externalRawSha256
        || assertGeneration(payload.baseGeneration, 'baseGeneration') !== detected.baseGeneration
        || assertGeneration(payload.targetGeneration, 'targetGeneration') !== detected.baseGeneration + 1
      ) throw recoveryRequired('invalid resolve_apply_intent transition', { conflictId });
      childJournalIds.add(childJournalId);
      aggregate.state = suffix;
      aggregate.childJournalId = childJournalId;
      aggregate.intent = deepFreeze({
        kind: 'apply',
        conflictId,
        decisionEpoch: epoch,
        childJournalId,
        externalRawSha256: payload.externalRawSha256,
        baseGeneration: payload.baseGeneration,
        targetGeneration: payload.targetGeneration,
        resource: detected.resource,
      });
    } else if (suffix === 'resolved_accept_external') {
      if (
        aggregate.state !== 'resolve_accept_intent'
        || epoch !== aggregate.decisionEpoch
        || payload.acceptedRawSha256 !== aggregate.intent.acceptedRawSha256
        || payload.targetGeneration !== aggregate.intent.targetGeneration
      ) throw recoveryRequired('invalid resolved_accept_external transition', { conflictId });
      aggregate.state = suffix;
    } else if (suffix === 'resolved_apply_draft') {
      if (
        aggregate.state !== 'resolve_apply_intent'
        || epoch !== aggregate.decisionEpoch
        || payload.childJournalId !== aggregate.intent.childJournalId
        || payload.targetGeneration !== aggregate.intent.targetGeneration
      ) throw recoveryRequired('invalid resolved_apply_draft transition', { conflictId });
      aggregate.state = suffix;
    } else if (suffix === 'resolve_apply_aborted') {
      if (
        aggregate.state !== 'resolve_apply_intent'
        || epoch !== aggregate.decisionEpoch
        || payload.childJournalId !== aggregate.intent.childJournalId
      ) throw recoveryRequired('invalid resolve_apply_aborted transition', { conflictId });
      aggregate.state = suffix;
    } else if (suffix === 'superseded') {
      assertCanonicalUuid(payload.successorConflictId, 'successor_conflict_id');
      const successor = conflicts.get(payload.successorConflictId);
      if (
        !['backup_durable', 'decision_ready', 'resolve_accept_intent'].includes(aggregate.state)
        || epoch !== aggregate.decisionEpoch
        || payload.successorConflictId === conflictId
        || !successor
        || successor.detected.supersedes !== conflictId
        || successor.state === 'conflict_detected'
        || !samePlain(successor.detected.resource, detected.resource)
      ) throw recoveryRequired('invalid superseded transition', { conflictId });
      aggregate.state = suffix;
      aggregate.successorConflictId = payload.successorConflictId;
    } else if (suffix === 'archived') {
      if (
        !['resolved_accept_external', 'resolved_apply_draft'].includes(aggregate.state)
        || epoch !== aggregate.decisionEpoch
      ) throw recoveryRequired('invalid archived transition', { conflictId });
      aggregate.state = suffix;
    }
    aggregate.tailDigest = event.digest;
  }
  return Object.freeze({
    conflicts,
    childJournalIds,
    events,
    tailDigest: events.at(-1)?.digest ?? null,
  });
}

function parseJournals(record, suppliedEvents) {
  try {
    return parseJournalsUnchecked(record, suppliedEvents);
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired('draft conflict event history is invalid', {}, cause);
  }
}

function appendEvent(record, suffix, payload) {
  const frozenPayload = deepFreeze(payload);
  try {
    const current = parseJournals(record);
    parseJournals(record, current.events.concat(Object.freeze({
      seq: current.events.length + 1,
      type: `${EVENT_PREFIX}${suffix}`,
      payload: frozenPayload,
      prevDigest: current.tailDigest,
      digest: '0'.repeat(64),
    })));
    return record.control.compareAndAppend(current.tailDigest, {
      type: `${EVENT_PREFIX}${suffix}`,
      payload: frozenPayload,
    });
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired('draft conflict event append failed', {
      conflictId: payload.conflictId,
      state: suffix,
    }, cause);
  }
}

function viewOf(aggregate) {
  const { detected } = aggregate;
  return deepFreeze({
    conflictId: detected.conflictId,
    supersedes: detected.supersedes,
    state: aggregate.state,
    decisionEpoch: aggregate.decisionEpoch,
    childJournalId: aggregate.childJournalId,
    resource: detected.resource,
    baseGeneration: detected.baseGeneration,
    baseRawSha256: detected.baseRawSha256,
    externalRawSha256: detected.externalRawSha256,
    draftRawSha256: detected.draftRawSha256,
    externalByteSize: detected.externalByteSize,
    draftByteSize: detected.draftByteSize,
    fieldMask: detected.fieldMask,
    createdAt: detected.createdAt,
  });
}

function resultOf(aggregate, extras = {}) {
  return deepFreeze({
    conflictId: aggregate.detected.conflictId,
    state: aggregate.state,
    decisionEpoch: aggregate.decisionEpoch,
    ...extras,
  });
}

function requireAggregate(record, conflictId) {
  assertCanonicalUuid(conflictId, 'conflict_id');
  const aggregate = parseJournals(record).conflicts.get(conflictId);
  if (!aggregate) throw recoveryRequired('draft conflict does not exist', { conflictId });
  return aggregate;
}

function requireReady(aggregate, requestedEpoch) {
  if (
    aggregate.state !== 'decision_ready'
    || aggregate.decisionEpoch !== requestedEpoch
  ) throw projectionStale(
    aggregate.detected.conflictId,
    requestedEpoch,
    aggregate.state,
  );
}

function mintIntent(record, aggregate) {
  const intent = Object.freeze({});
  intentRecords.set(intent, Object.freeze({
    owner: record.owner,
    kind: aggregate.intent.kind,
    conflictId: aggregate.detected.conflictId,
    decisionEpoch: aggregate.decisionEpoch,
    data: aggregate.intent,
  }));
  return intent;
}

function assertIntent(record, intent, kind) {
  const intentRecord = intentRecords.get(intent);
  if (!intentRecord || intentRecord.owner !== record.owner || intentRecord.kind !== kind) {
    throw recoveryRequired('draft conflict intent authority is foreign');
  }
  return intentRecord;
}

function internalIntent(record, aggregate) {
  return mintIntent(record, aggregate);
}

function classifyEvidence(record, portKind, evidence, intent, descriptor) {
  const port = portKind === 'child' ? record.childDisposition : record.projectionDisposition;
  let disposition;
  try {
    disposition = port.classify(evidence, intent, descriptor);
  } catch (cause) {
    throw recoveryRequired(`${portKind} disposition evidence cannot be classified`, {}, cause);
  }
  if (typeof disposition !== 'string') {
    throw recoveryRequired(`${portKind} disposition evidence is invalid`);
  }
  return disposition;
}

async function inspectDisposition(record, portKind, intent, descriptor) {
  const port = portKind === 'child' ? record.childDisposition : record.projectionDisposition;
  try {
    return await port.inspect(intent, descriptor);
  } catch (cause) {
    throw recoveryRequired(`${portKind} disposition cannot be inspected`, {
      conflictId: descriptor.conflictId,
      decisionEpoch: descriptor.decisionEpoch,
    }, cause);
  }
}

async function callBackupStorage(record, method, input, conflictId) {
  try {
    return await record.backupStorage[method](input);
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired(`draft conflict backup ${method} failed`, { conflictId }, cause);
  }
}

class DraftConflictJournal {
  constructor(options) {
    const descriptors = exactDescriptors(options, [
      'backupStorage',
      'childDisposition',
      'clock',
      'controlStore',
      'projectBinding',
      'projectionDisposition',
      'uuidV4',
    ], 'DraftConflictJournal options');
    const binding = snapshotProjectBinding(descriptors.projectBinding.value);
    const controlStore = descriptors.controlStore.value;
    const control = capturePort(controlStore, ['compareAndAppend', 'read', 'tail'], 'controlStore');
    const controlDirectory = controlStore.directory;
    const controlIncarnationId = controlStore.incarnationId;
    const expectedDirectory = path.join(
      binding.dataRoot,
      'control',
      'manuscripts',
      binding.projectUid,
      binding.projectInstanceId,
    );
    if (
      typeof controlDirectory !== 'string'
      || path.resolve(controlDirectory) !== controlDirectory
      || path.normalize(controlDirectory) !== controlDirectory
      || controlDirectory !== expectedDirectory
      || controlIncarnationId !== binding.controlIncarnationId
    ) throw recoveryRequired('DraftConflictJournal ControlStore binding is foreign');
    const backupStorage = capturePort(
      descriptors.backupStorage.value,
      ['create', 'discardIncomplete', 'inspect'],
      'backupStorage',
      true,
    );
    const childDisposition = capturePort(
      descriptors.childDisposition.value,
      ['classify', 'inspect'],
      'childDisposition',
      true,
    );
    const projectionDisposition = capturePort(
      descriptors.projectionDisposition.value,
      ['classify', 'inspect'],
      'projectionDisposition',
      true,
    );
    const uuidV4 = descriptors.uuidV4.value;
    const clock = descriptors.clock.value;
    if (typeof uuidV4 !== 'function' || typeof clock !== 'function') {
      throw new TypeError('uuidV4 and clock are required functions');
    }
    journalRecords.set(this, Object.freeze({
      owner: Object.freeze({}),
      binding,
      controlDirectory,
      control,
      backupStorage,
      childDisposition,
      projectionDisposition,
      uuidV4,
      clock,
    }));
  }

  async createConflict(input) {
    const record = journalRecords.get(this);
    const safeInput = snapshotCreateInput(input);
    if (
      safeInput.resource.kind === 'manuscript'
      && safeInput.resource.uid !== record.binding.projectUid
    ) throw new TypeError('manuscript resource belongs to another project');
    const externalRawSha256 = sha256(safeInput.externalBytes);
    const current = parseJournals(record);
    if (safeInput.supersedes !== null) {
      const prior = current.conflicts.get(safeInput.supersedes);
      if (
        !prior
        || !['backup_durable', 'decision_ready', 'resolve_accept_intent'].includes(prior.state)
        || !samePlain(prior.detected.resource, safeInput.resource)
        || prior.detected.externalRawSha256 === externalRawSha256
      ) {
        throw recoveryRequired('supersedes does not identify the same durable resource', {
          supersedes: safeInput.supersedes,
        });
      }
    }
    const conflictId = assertCanonicalUuid(record.uuidV4(), 'conflict_id');
    if (current.conflicts.has(conflictId)) {
      throw recoveryRequired('conflict UUID is already owned', { conflictId });
    }
    const createdAt = assertTimestamp(record.clock(), 'createdAt');
    const facts = {
      projectUid: record.binding.projectUid,
      projectInstanceId: record.binding.projectInstanceId,
      conflictId,
      resource: safeInput.resource,
      baseGeneration: safeInput.basis.baseGeneration,
      baseRawSha256: safeInput.basis.baseRawSha256,
      externalRawSha256,
      draftRawSha256: sha256(safeInput.draftBytes),
      externalByteSize: safeInput.externalBytes.length,
      draftByteSize: safeInput.draftBytes.length,
      fieldMask: safeInput.fieldMask,
      ...backupPaths(record, conflictId),
    };
    const backupLayoutDigest = digestPlain(layoutSource(facts));
    const detected = deepFreeze({
      ...commonPayload(record, { conflictId, resource: safeInput.resource }, 0),
      supersedes: safeInput.supersedes,
      baseGeneration: facts.baseGeneration,
      baseRawSha256: facts.baseRawSha256,
      externalRawSha256: facts.externalRawSha256,
      draftRawSha256: facts.draftRawSha256,
      externalByteSize: facts.externalByteSize,
      draftByteSize: facts.draftByteSize,
      fieldMask: facts.fieldMask,
      backupLayoutDigest,
      createdAt,
    });
    appendEvent(record, 'conflict_detected', detected);
    const manifest = manifestFromDetected(detected, record);
    const receipt = await callBackupStorage(record, 'create', Object.freeze({
      manifest,
      draftBytes: safeInput.draftBytes,
      externalBytes: safeInput.externalBytes,
    }), conflictId);
    validateCompleteReceipt(receipt, manifest);
    appendEvent(record, 'backup_durable', {
      ...commonPayload(record, detected, 0),
      backupLayoutDigest,
    });
    faultPoint('draft-conflict.after-backup-durable', { conflictId });
    appendEvent(record, 'decision_ready', commonPayload(record, detected, 0));
    return resultOf(requireAggregate(record, conflictId));
  }

  readConflict(conflictId) {
    const record = journalRecords.get(this);
    const aggregate = requireAggregate(record, conflictId);
    return viewOf(aggregate);
  }

  listConflicts() {
    const record = journalRecords.get(this);
    return Object.freeze(Array.from(parseJournals(record).conflicts.values())
      .sort((left, right) => (
        left.detected.createdAt - right.detected.createdAt
        || left.detected.conflictId.localeCompare(right.detected.conflictId)
      ))
      .map(viewOf));
  }

  async beginAccept(input) {
    const record = journalRecords.get(this);
    const descriptors = exactDescriptors(input, [
      'acceptedRawSha256',
      'baseGeneration',
      'conflictId',
      'decisionEpoch',
      'targetGeneration',
    ], 'beginAccept input');
    const conflictId = assertCanonicalUuid(descriptors.conflictId.value, 'conflict_id');
    const decisionEpoch = assertGeneration(descriptors.decisionEpoch.value, 'decisionEpoch');
    const aggregate = requireAggregate(record, conflictId);
    requireReady(aggregate, decisionEpoch);
    const acceptedRawSha256 = assertDigest(
      descriptors.acceptedRawSha256.value,
      'acceptedRawSha256',
    );
    const baseGeneration = assertGeneration(descriptors.baseGeneration.value, 'baseGeneration');
    const targetGeneration = assertGeneration(descriptors.targetGeneration.value, 'targetGeneration');
    if (
      acceptedRawSha256 !== aggregate.detected.externalRawSha256
      || baseGeneration !== aggregate.detected.baseGeneration
      || targetGeneration !== baseGeneration + 1
    ) throw projectionStale(conflictId, decisionEpoch, aggregate.state);
    appendEvent(record, 'resolve_accept_intent', {
      ...commonPayload(record, aggregate.detected, decisionEpoch),
      acceptedRawSha256,
      baseGeneration,
      targetGeneration,
    });
    return mintIntent(record, requireAggregate(record, conflictId));
  }

  async beginApply(input) {
    const record = journalRecords.get(this);
    const descriptors = exactDescriptors(input, [
      'baseGeneration',
      'childJournalId',
      'conflictId',
      'decisionEpoch',
      'externalRawSha256',
      'targetGeneration',
    ], 'beginApply input');
    const conflictId = assertCanonicalUuid(descriptors.conflictId.value, 'conflict_id');
    const decisionEpoch = assertGeneration(descriptors.decisionEpoch.value, 'decisionEpoch');
    const aggregate = requireAggregate(record, conflictId);
    requireReady(aggregate, decisionEpoch);
    const childJournalId = assertCanonicalUuid(
      descriptors.childJournalId.value,
      'child_journal_id',
    );
    const externalRawSha256 = assertDigest(
      descriptors.externalRawSha256.value,
      'externalRawSha256',
    );
    const baseGeneration = assertGeneration(descriptors.baseGeneration.value, 'baseGeneration');
    const targetGeneration = assertGeneration(descriptors.targetGeneration.value, 'targetGeneration');
    if (
      externalRawSha256 !== aggregate.detected.externalRawSha256
      || baseGeneration !== aggregate.detected.baseGeneration
      || targetGeneration !== baseGeneration + 1
    ) throw projectionStale(conflictId, decisionEpoch, aggregate.state);
    if (parseJournals(record).childJournalIds.has(childJournalId)) {
      throw projectionStale(conflictId, decisionEpoch, aggregate.state);
    }
    appendEvent(record, 'resolve_apply_intent', {
      ...commonPayload(record, aggregate.detected, decisionEpoch),
      childJournalId,
      externalRawSha256,
      baseGeneration,
      targetGeneration,
    });
    return mintIntent(record, requireAggregate(record, conflictId));
  }

  async recordAcceptResolved(intent, projectionAfterEvidence) {
    const record = journalRecords.get(this);
    const intentRecord = assertIntent(record, intent, 'accept');
    const aggregate = requireAggregate(record, intentRecord.conflictId);
    if (
      aggregate.state !== 'resolve_accept_intent'
      || aggregate.decisionEpoch !== intentRecord.decisionEpoch
      || !samePlain(aggregate.intent, intentRecord.data)
    ) throw projectionStale(
      intentRecord.conflictId,
      intentRecord.decisionEpoch,
      aggregate.state,
    );
    if (
      classifyEvidence(
        record,
        'projection',
        projectionAfterEvidence,
        intent,
        aggregate.intent,
      ) !== 'after'
    ) {
      throw recoveryRequired('accept projection after evidence is unproven', {
        conflictId: intentRecord.conflictId,
        decisionEpoch: intentRecord.decisionEpoch,
      });
    }
    appendEvent(record, 'resolved_accept_external', {
      ...commonPayload(record, aggregate.detected, aggregate.decisionEpoch),
      acceptedRawSha256: aggregate.intent.acceptedRawSha256,
      targetGeneration: aggregate.intent.targetGeneration,
    });
    return resultOf(requireAggregate(record, intentRecord.conflictId));
  }

  async recordApplyResolved(intent, childAfterEvidence) {
    return this.#recordApply(intent, childAfterEvidence, 'after');
  }

  async recordApplyAborted(intent, childBeforeEvidence) {
    return this.#recordApply(intent, childBeforeEvidence, 'before');
  }

  async #recordApply(intent, evidence, expectedDisposition) {
    const record = journalRecords.get(this);
    const intentRecord = assertIntent(record, intent, 'apply');
    const aggregate = requireAggregate(record, intentRecord.conflictId);
    if (
      aggregate.state !== 'resolve_apply_intent'
      || aggregate.decisionEpoch !== intentRecord.decisionEpoch
      || !samePlain(aggregate.intent, intentRecord.data)
    ) throw projectionStale(
      intentRecord.conflictId,
      intentRecord.decisionEpoch,
      aggregate.state,
    );
    if (
      classifyEvidence(record, 'child', evidence, intent, aggregate.intent)
      !== expectedDisposition
    ) {
      throw recoveryRequired(`apply child ${expectedDisposition} evidence is unproven`, {
        conflictId: intentRecord.conflictId,
        decisionEpoch: intentRecord.decisionEpoch,
        childJournalId: aggregate.intent.childJournalId,
      });
    }
    if (expectedDisposition === 'after') {
      appendEvent(record, 'resolved_apply_draft', {
        ...commonPayload(record, aggregate.detected, aggregate.decisionEpoch),
        childJournalId: aggregate.intent.childJournalId,
        targetGeneration: aggregate.intent.targetGeneration,
      });
    } else {
      appendEvent(record, 'resolve_apply_aborted', {
        ...commonPayload(record, aggregate.detected, aggregate.decisionEpoch),
        childJournalId: aggregate.intent.childJournalId,
      });
      appendEvent(record, 'decision_ready', commonPayload(
        record,
        aggregate.detected,
        aggregate.decisionEpoch + 1,
      ));
    }
    return resultOf(requireAggregate(record, intentRecord.conflictId));
  }

  async supersede(input) {
    const record = journalRecords.get(this);
    const descriptors = exactDescriptors(input, [
      'conflictId',
      'decisionEpoch',
      'projectionBeforeEvidence',
      'successorConflictId',
    ], 'supersede input');
    const conflictId = assertCanonicalUuid(descriptors.conflictId.value, 'conflict_id');
    const decisionEpoch = assertGeneration(descriptors.decisionEpoch.value, 'decisionEpoch');
    const successorConflictId = assertCanonicalUuid(
      descriptors.successorConflictId.value,
      'successor_conflict_id',
    );
    const current = parseJournals(record);
    const aggregate = current.conflicts.get(conflictId);
    if (!aggregate) throw recoveryRequired('draft conflict does not exist', { conflictId });
    if (
      !['backup_durable', 'decision_ready', 'resolve_accept_intent'].includes(aggregate.state)
      || aggregate.decisionEpoch !== decisionEpoch
    ) throw projectionStale(conflictId, decisionEpoch, aggregate.state);
    const successor = current.conflicts.get(successorConflictId);
    if (
      !successor
      || successor.detected.supersedes !== conflictId
      || successor.state === 'conflict_detected'
      || !samePlain(successor.detected.resource, aggregate.detected.resource)
    ) throw recoveryRequired('superseded chain successor is unproven', {
      conflictId,
      successorConflictId,
    });
    const evidence = descriptors.projectionBeforeEvidence.value;
    if (aggregate.state === 'resolve_accept_intent') {
      const opaqueIntent = internalIntent(record, aggregate);
      const disposition = classifyEvidence(
        record,
        'projection',
        evidence,
        opaqueIntent,
        aggregate.intent,
      );
      if (!['before', 'before_changed'].includes(disposition)) {
        throw recoveryRequired('accept projection before evidence is unproven', {
          conflictId,
          decisionEpoch,
        });
      }
    } else if (evidence !== null) {
      throw new TypeError('projectionBeforeEvidence must be null before a resolve intent');
    }
    appendEvent(record, 'superseded', {
      ...commonPayload(record, aggregate.detected, decisionEpoch),
      successorConflictId,
    });
    return resultOf(requireAggregate(record, conflictId));
  }

  async archive(input) {
    const record = journalRecords.get(this);
    const descriptors = exactDescriptors(input, ['conflictId'], 'archive input');
    const conflictId = assertCanonicalUuid(descriptors.conflictId.value, 'conflict_id');
    const aggregate = requireAggregate(record, conflictId);
    if (!['resolved_accept_external', 'resolved_apply_draft'].includes(aggregate.state)) {
      throw projectionStale(conflictId, aggregate.decisionEpoch, aggregate.state);
    }
    appendEvent(record, 'archived', commonPayload(
      record,
      aggregate.detected,
      aggregate.decisionEpoch,
    ));
    return resultOf(requireAggregate(record, conflictId));
  }

  async recover(conflictId) {
    const record = journalRecords.get(this);
    let aggregate = requireAggregate(record, conflictId);
    const manifest = manifestFromDetected(aggregate.detected, record);
    if (aggregate.state === 'conflict_detected') {
      const inspection = await callBackupStorage(
        record,
        'inspect',
        Object.freeze({ manifest }),
        conflictId,
      );
      if (inspection?.status === 'incomplete') {
        validateIncompleteInspection(inspection, manifest);
        const discarded = await callBackupStorage(
          record,
          'discardIncomplete',
          Object.freeze({ manifest }),
          conflictId,
        );
        validateDiscardReceipt(discarded, manifest);
        return deepFreeze({ conflictId, state: 'conflict_detected', cleanup: 'removed' });
      }
      validateCompleteReceipt(inspection, manifest);
      appendEvent(record, 'backup_durable', {
        ...commonPayload(record, aggregate.detected, 0),
        backupLayoutDigest: aggregate.detected.backupLayoutDigest,
      });
      faultPoint('draft-conflict.after-backup-durable', { conflictId });
      aggregate = requireAggregate(record, conflictId);
    }
    if (aggregate.state === 'backup_durable') {
      const inspection = await callBackupStorage(
        record,
        'inspect',
        Object.freeze({ manifest }),
        conflictId,
      );
      validateCompleteReceipt(inspection, manifest);
      appendEvent(record, 'decision_ready', commonPayload(record, aggregate.detected, 0));
      aggregate = requireAggregate(record, conflictId);
    }
    if (aggregate.state === 'resolve_apply_aborted') {
      appendEvent(record, 'decision_ready', commonPayload(
        record,
        aggregate.detected,
        aggregate.decisionEpoch + 1,
      ));
      aggregate = requireAggregate(record, conflictId);
    }
    if (aggregate.state === 'resolve_apply_intent') {
      const intent = internalIntent(record, aggregate);
      const evidence = await inspectDisposition(record, 'child', intent, aggregate.intent);
      const disposition = classifyEvidence(record, 'child', evidence, intent, aggregate.intent);
      if (disposition === 'after') return this.recordApplyResolved(intent, evidence);
      if (disposition === 'before') return this.recordApplyAborted(intent, evidence);
      throw recoveryRequired('apply child disposition is unproven', {
        conflictId,
        decisionEpoch: aggregate.decisionEpoch,
        childJournalId: aggregate.childJournalId,
      });
    }
    if (aggregate.state === 'resolve_accept_intent') {
      const intent = internalIntent(record, aggregate);
      const evidence = await inspectDisposition(record, 'projection', intent, aggregate.intent);
      const disposition = classifyEvidence(
        record,
        'projection',
        evidence,
        intent,
        aggregate.intent,
      );
      if (disposition === 'after') return this.recordAcceptResolved(intent, evidence);
      if (disposition === 'before_changed') {
        const successors = Array.from(parseJournals(record).conflicts.values())
          .filter((candidate) => (
            candidate.detected.supersedes === conflictId
            && candidate.state !== 'conflict_detected'
            && samePlain(candidate.detected.resource, aggregate.detected.resource)
          ));
        if (successors.length !== 1) {
          throw recoveryRequired('accept superseding conflict is unproven', {
            conflictId,
            decisionEpoch: aggregate.decisionEpoch,
          });
        }
        return this.supersede({
          conflictId,
          decisionEpoch: aggregate.decisionEpoch,
          successorConflictId: successors[0].detected.conflictId,
          projectionBeforeEvidence: evidence,
        });
      }
      throw recoveryRequired('accept projection disposition is unproven', {
        conflictId,
        decisionEpoch: aggregate.decisionEpoch,
      });
    }
    return resultOf(aggregate);
  }

  listGcDebt() {
    const record = journalRecords.get(this);
    const now = assertTimestamp(record.clock(), 'gc clock');
    const terminal = Array.from(parseJournals(record).conflicts.values())
      .filter((aggregate) => ['archived', 'superseded'].includes(aggregate.state))
      .sort((left, right) => (
        right.detected.createdAt - left.detected.createdAt
        || right.detected.conflictId.localeCompare(left.detected.conflictId)
      ));
    return Object.freeze(terminal
      .filter((aggregate, index) => (
        index >= 20 && now - aggregate.detected.createdAt >= THIRTY_DAYS_MS
      ))
      .sort((left, right) => (
        left.detected.createdAt - right.detected.createdAt
        || left.detected.conflictId.localeCompare(right.detected.conflictId)
      ))
      .map((aggregate) => deepFreeze({
        conflictId: aggregate.detected.conflictId,
        state: aggregate.state,
        createdAt: aggregate.detected.createdAt,
        backupLayoutDigest: aggregate.detected.backupLayoutDigest,
      })));
  }
}

module.exports = {
  DraftConflictJournal,
};
