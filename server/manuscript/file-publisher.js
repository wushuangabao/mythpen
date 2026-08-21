'use strict';

const { createHash } = require('node:crypto');

const { manuscriptError } = require('./contracts');
const { requireFileWriterCapability } = require('./capability-registry');
const { FAULT_POINTS, faultPoint } = require('../testing/fault-injection');

const WRITER_METHODS = Object.freeze([
  'createAssetVerified',
  'deleteVerified',
  'readVerified',
  'relocateVerifiedToAbsent',
]);
const publisherRecords = new WeakMap();
const writerCapabilityStates = new WeakMap();

function recoveryRequired(reason, cause) {
  return manuscriptError('RECOVERY_REQUIRED', { reason }, cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Reflect.ownKeys(value).slice().sort();
  const expected = expectedKeys.slice().sort();
  return actual.length === expected.length
    && actual.every((key, index) => typeof key === 'string' && key === expected[index]);
}

function resolveWriterMethods(value) {
  const resolved = requireFileWriterCapability(value);
  if (
    !isPlainObject(resolved)
    || !isPlainObject(resolved.methods)
    || !WRITER_METHODS.every((method) => typeof resolved.methods[method] === 'function')
  ) {
    throw new TypeError('writerCapability resolver returned an invalid operation table');
  }
  return resolved.methods;
}

function publisherBinding(receiver) {
  const record = publisherRecords.get(receiver);
  if (record === undefined) throw new TypeError('invalid FilePublisher receiver');
  return record;
}

function writerMethods(receiver) {
  return resolveWriterMethods(publisherBinding(receiver).capability);
}

function publisherRecord(receiver) {
  return publisherBinding(receiver).state;
}

function callWriter(receiver, method, ...args) {
  return writerMethods(receiver)[method](...args);
}

function propagateDisposition(error, cause) {
  for (const flag of ['created', 'deleted', 'relocated']) {
    if (cause?.[flag] === true) {
      Object.defineProperty(error, flag, {
        configurable: false,
        enumerable: true,
        value: true,
        writable: false,
      });
    }
  }
  return error;
}

function identity(value, label) {
  if (
    !isPlainObject(value)
    || Reflect.ownKeys(value).length !== 2
    || typeof value.dev !== 'string'
    || !/^[0-9]+$/u.test(value.dev)
    || typeof value.ino !== 'string'
    || !/^[0-9]+$/u.test(value.ino)
  ) {
    throw new TypeError(`${label} must be a physical identity`);
  }
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertCanonicalPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty canonical path`);
  }
  return value;
}

function snapshotAsset(value, label = 'asset') {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const expectedKeys = [
    'assetKind',
    'byteSize',
    'fileIdentity',
    'fileSynced',
    'parentIdentity',
    'parentSynced',
    'path',
    'sha256',
  ];
  const keys = Reflect.ownKeys(value).slice().sort();
  if (keys.join('\0') !== expectedKeys.slice().sort().join('\0')) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  if (typeof value.assetKind !== 'string' || value.assetKind.length === 0) {
    throw new TypeError(`${label}.assetKind is invalid`);
  }
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 0) {
    throw new TypeError(`${label}.byteSize is invalid`);
  }
  if (value.fileSynced !== true || value.parentSynced !== true) {
    throw new TypeError(`${label} lacks durable flush evidence`);
  }
  return Object.freeze({
    assetKind: value.assetKind,
    path: assertCanonicalPath(value.path, `${label}.path`),
    parentIdentity: identity(value.parentIdentity, `${label}.parentIdentity`),
    fileIdentity: identity(value.fileIdentity, `${label}.fileIdentity`),
    byteSize: value.byteSize,
    sha256: assertDigest(value.sha256, `${label}.sha256`),
    fileSynced: true,
    parentSynced: true,
  });
}

function snapshotReservation(value) {
  if (!isPlainObject(value)) throw new TypeError('asset reservation must be a plain object');
  const expectedKeys = ['assetKind', 'byteSize', 'parentIdentity', 'path', 'sha256'];
  const keys = Reflect.ownKeys(value).slice().sort();
  if (keys.join('\0') !== expectedKeys.slice().sort().join('\0')) {
    throw new TypeError('asset reservation has an invalid shape');
  }
  if (typeof value.assetKind !== 'string' || value.assetKind.length === 0) {
    throw new TypeError('asset reservation kind is invalid');
  }
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 0) {
    throw new TypeError('asset reservation byteSize is invalid');
  }
  return Object.freeze({
    assetKind: value.assetKind,
    path: assertCanonicalPath(value.path, 'asset reservation path'),
    parentIdentity: identity(value.parentIdentity, 'asset reservation parentIdentity'),
    byteSize: value.byteSize,
    sha256: assertDigest(value.sha256, 'asset reservation sha256'),
  });
}

function assertMember(value) {
  if (!isPlainObject(value)) throw new TypeError('publication member must be a plain object');
  if (!['update', 'create', 'delete'].includes(value.operation)) {
    throw new TypeError('publication member operation is invalid');
  }
  return value;
}

function verifiedMismatch(error) {
  return error?.code === 'VERIFIED_SOURCE_MISMATCH';
}

function presentExpectation(asset) {
  return Object.freeze({
    disposition: 'present',
    byteSize: asset.byteSize,
    identity: asset.fileIdentity,
    parentIdentity: asset.parentIdentity,
    sha256: asset.sha256,
  });
}

function validatePresent(result, expected) {
  if (
    !hasExactKeys(result, [
      'byteSize',
      'bytes',
      'disposition',
      'identity',
      'parentIdentity',
      'sha256',
    ])
    || !Object.isFrozen(result)
    || result.disposition !== 'PRESENT'
    || !Buffer.isBuffer(result.bytes)
    || result.byteSize !== expected.byteSize
    || result.sha256 !== expected.sha256
    || !sameIdentity(result.identity, expected.fileIdentity)
    || !sameIdentity(result.parentIdentity, expected.parentIdentity)
    || result.bytes.length !== expected.byteSize
    || sha256(result.bytes) !== expected.sha256
  ) {
    throw recoveryRequired('writer read returned inexact PRESENT evidence');
  }
}

function topologyChanged(error) {
  return error?.code === 'VERIFIED_SOURCE_TOPOLOGY_CHANGED'
    || error?.code === 'TOPOLOGY_CHANGED';
}

async function probeKnownPath(receiver, filePath, parentIdentity, candidates) {
  try {
    const absent = await callWriter(receiver, 'readVerified', filePath, Object.freeze({
      disposition: 'absent',
      parentIdentity,
    }));
    if (!hasExactKeys(absent, ['disposition']) || !Object.isFrozen(absent) || absent.disposition !== 'ABSENT') {
      throw recoveryRequired('writer read returned inexact ABSENT evidence');
    }
    return 'absent';
  } catch (error) {
    if (topologyChanged(error)) return 'other';
    if (!verifiedMismatch(error)) throw error;
  }
  for (const candidate of candidates) {
    try {
      const present = await callWriter(
        receiver,
        'readVerified',
        filePath,
        presentExpectation(candidate.asset),
      );
      validatePresent(present, candidate.asset);
      return candidate.label;
    } catch (error) {
      if (topologyChanged(error)) return 'other';
      if (!verifiedMismatch(error)) throw error;
    }
  }
  return 'other';
}

async function inspectMember(receiver, member) {
  const finalCandidates = [];
  if (member.before.exists) {
    finalCandidates.push({ label: 'before', asset: beforeAtFinal(member) });
  }
  if (member.after.exists) {
    finalCandidates.push({ label: 'after', asset: afterAtFinal(member) });
  }
  const final = await probeKnownPath(
    receiver,
    member.final.path,
    member.final.parentIdentity,
    finalCandidates,
  );
  const displaced = await probeKnownPath(
    receiver,
    member.displaced.path,
    member.displaced.parentIdentity,
    member.before.exists
      ? [{ label: 'before', asset: beforeAtDisplaced(member) }]
      : [],
  );
  const staged = member.after.exists
    ? await probeKnownPath(
        receiver,
        member.after.asset.path,
        member.after.asset.parentIdentity,
        [{ label: 'after', asset: member.after.asset }],
      )
    : 'absent';
  if ([final, displaced, staged].includes('other')) return 'OTHER';
  if (member.operation === 'update') {
    if (final === 'before' && displaced === 'absent' && staged === 'after') return 'BEFORE';
    if (final === 'absent' && displaced === 'before' && staged === 'after') return 'GAP';
    if (final === 'after' && displaced === 'before' && staged === 'absent') return 'AFTER';
  } else if (member.operation === 'create') {
    if (final === 'absent' && displaced === 'absent' && staged === 'after') return 'BEFORE';
    if (final === 'after' && displaced === 'absent' && staged === 'absent') return 'AFTER';
  } else if (member.operation === 'delete') {
    if (final === 'before' && displaced === 'absent') return 'BEFORE';
    if (final === 'absent' && displaced === 'before') return 'AFTER';
  }
  return 'OTHER';
}

async function inspectMemberForSafeAbort(receiver, member) {
  const finalCandidates = [];
  if (member.before.exists) {
    finalCandidates.push({ label: 'before', asset: beforeAtFinal(member) });
  }
  if (member.after.exists && member.after.asset !== null) {
    finalCandidates.push({ label: 'after', asset: afterAtFinal(member) });
  }
  const final = await probeKnownPath(
    receiver,
    member.final.path,
    member.final.parentIdentity,
    finalCandidates,
  );
  const displaced = await probeKnownPath(
    receiver,
    member.displaced.path,
    member.displaced.parentIdentity,
    member.before.exists
      ? [{ label: 'before', asset: beforeAtDisplaced(member) }]
      : [],
  );
  if (member.operation === 'create') {
    return final === 'absent' && displaced === 'absent' ? 'SAFE_ABORT' : 'OTHER';
  }
  return final === 'before' && displaced === 'absent' ? 'SAFE_ABORT' : 'OTHER';
}

function relocatedAsset(result, expected, targetPath, targetParentIdentity, assetKind) {
  if (
    !hasExactKeys(result, [
      'byteSize',
      'identity',
      'relocated',
      'sha256',
      'sourceParentFsync',
      'sourceParentIdentity',
      'targetParentFsync',
      'targetParentIdentity',
    ])
    || !Object.isFrozen(result)
    || result.relocated !== true
    || result.sourceParentFsync !== true
    || result.targetParentFsync !== true
    || result.byteSize !== expected.byteSize
    || result.sha256 !== expected.sha256
    || !sameIdentity(result.identity, expected.fileIdentity)
    || !sameIdentity(result.sourceParentIdentity, expected.parentIdentity)
    || !sameIdentity(result.targetParentIdentity, targetParentIdentity)
  ) {
    throw recoveryRequired('verified relocate returned incomplete durability evidence');
  }
  return snapshotAsset(Object.freeze({
    assetKind,
    path: targetPath,
    parentIdentity: result.targetParentIdentity,
    fileIdentity: result.identity,
    byteSize: result.byteSize,
    sha256: result.sha256,
    fileSynced: true,
    parentSynced: result.targetParentFsync,
  }), 'relocated asset');
}

function relocationKey(sourcePath, targetPath, fileIdentity) {
  return `${sourcePath}\0${targetPath}\0${fileIdentity.dev}:${fileIdentity.ino}`;
}

async function relocate(receiver, {
  assetKind,
  source,
  sourceParentIdentity,
  targetPath,
  targetParentIdentity,
}) {
  const state = publisherRecord(receiver);
  const key = relocationKey(source.path, targetPath, source.fileIdentity);
  state.writerCapabilityState.mutationEpoch += 1n;
  let result;
  try {
    result = await callWriter(
      receiver,
      'relocateVerifiedToAbsent',
      source.path,
      targetPath,
      Object.freeze({
        byteSize: source.byteSize,
        identity: source.fileIdentity,
        sha256: source.sha256,
        sourceParentIdentity,
        targetParentIdentity,
      }),
    );
  } catch (cause) {
    if (cause?.relocated === true) state.uncertainRelocations.add(key);
    if (cause?.code === 'TARGET_LOCKED') {
      throw propagateDisposition(
        manuscriptError('MANUSCRIPT_TARGET_LOCKED', { targetPath }, cause),
        cause,
      );
    }
    throw propagateDisposition(
      recoveryRequired('verified no-replace relocate failed', cause),
      cause,
    );
  }
  let asset;
  try {
    asset = relocatedAsset(
      result,
      source,
      targetPath,
      targetParentIdentity,
      assetKind,
    );
  } catch (cause) {
    if (result?.relocated === true) state.uncertainRelocations.add(key);
    throw propagateDisposition(cause, result);
  }
  const receipt = Object.freeze({
    kind: 'relocate',
    sourcePath: source.path,
    targetPath,
    byteSize: result.byteSize,
    identity: asset.fileIdentity,
    relocated: true,
    sha256: result.sha256,
    sourceParentFsync: true,
    sourceParentIdentity: result.sourceParentIdentity,
    targetParentFsync: true,
    targetParentIdentity: result.targetParentIdentity,
  });
  state.relocationReceipts.set(key, receipt);
  try {
    faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_RELOCATE, {
      assetKind,
      sourcePath: source.path,
      targetPath,
    });
  } catch (cause) {
    throw propagateDisposition(cause, { relocated: true });
  }
  return Object.freeze({ asset, receipt });
}

function beforeAtFinal(member) {
  return Object.freeze({
    assetKind: 'formal_before',
    path: member.final.path,
    parentIdentity: member.final.parentIdentity,
    fileIdentity: member.before.fileIdentity,
    byteSize: member.before.byteSize,
    sha256: member.before.sha256,
    fileSynced: true,
    parentSynced: true,
  });
}

function afterAtFinal(member) {
  return Object.freeze({
    ...member.after.asset,
    assetKind: 'formal_after',
    path: member.final.path,
    parentIdentity: member.final.parentIdentity,
  });
}

function beforeAtDisplaced(member) {
  return Object.freeze({
    assetKind: 'displaced_before',
    path: member.displaced.path,
    parentIdentity: member.displaced.parentIdentity,
    fileIdentity: member.before.fileIdentity,
    byteSize: member.before.byteSize,
    sha256: member.before.sha256,
    fileSynced: true,
    parentSynced: true,
  });
}

function publicationEffectPlans(member) {
  const plans = [];
  if (member.operation === 'update' || member.operation === 'delete') {
    plans.push(Object.freeze({
      source: beforeAtFinal(member),
      sourcePath: member.final.path,
      sourceParentIdentity: member.final.parentIdentity,
      targetPath: member.displaced.path,
      targetParentIdentity: member.displaced.parentIdentity,
    }));
  }
  if (member.operation === 'update' || member.operation === 'create') {
    plans.push(Object.freeze({
      source: member.after.asset,
      sourcePath: member.after.asset.path,
      sourceParentIdentity: member.after.asset.parentIdentity,
      targetPath: member.final.path,
      targetParentIdentity: member.final.parentIdentity,
    }));
  }
  return Object.freeze(plans);
}

function rollbackEffectPlans(member) {
  const plans = [];
  if (member.operation === 'update' || member.operation === 'create') {
    plans.push(Object.freeze({
      source: afterAtFinal(member),
      sourcePath: member.final.path,
      sourceParentIdentity: member.final.parentIdentity,
      targetPath: member.after.asset.path,
      targetParentIdentity: member.after.asset.parentIdentity,
    }));
  }
  if (member.operation === 'update' || member.operation === 'delete') {
    plans.push(Object.freeze({
      source: beforeAtDisplaced(member),
      sourcePath: member.displaced.path,
      sourceParentIdentity: member.displaced.parentIdentity,
      targetPath: member.final.path,
      targetParentIdentity: member.final.parentIdentity,
    }));
  }
  return Object.freeze(plans);
}

function validateRelocationReceipt(value, plan) {
  if (
    !hasExactKeys(value, [
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
    ])
    || value.kind !== 'relocate'
    || value.relocated !== true
    || value.sourceParentFsync !== true
    || value.targetParentFsync !== true
    || value.sourcePath !== plan.sourcePath
    || value.targetPath !== plan.targetPath
    || value.byteSize !== plan.source.byteSize
    || value.sha256 !== plan.source.sha256
    || !sameIdentity(value.identity, plan.source.fileIdentity)
    || !sameIdentity(value.sourceParentIdentity, plan.sourceParentIdentity)
    || !sameIdentity(value.targetParentIdentity, plan.targetParentIdentity)
  ) throw recoveryRequired('relocation receipt does not match the publication manifest');
  return value;
}

function providedPublicationReceipts(publicationReceipt, manifest) {
  const receipts = new Map();
  if (publicationReceipt === undefined) return receipts;
  if (
    !hasExactKeys(publicationReceipt, ['disposition', 'members'])
    || publicationReceipt.disposition !== 'AFTER'
    || !Array.isArray(publicationReceipt.members)
    || publicationReceipt.members.length !== manifest.members.length
  ) throw recoveryRequired('publication receipt is malformed');
  for (let index = 0; index < manifest.members.length; index += 1) {
    const member = manifest.members[index];
    const received = publicationReceipt.members[index];
    const plans = publicationEffectPlans(member);
    if (
      !hasExactKeys(received, ['disposition', 'effects', 'refKey'])
      || received.refKey !== member.refKey
      || received.disposition !== 'AFTER'
      || !Array.isArray(received.effects)
      || received.effects.length !== plans.length
    ) throw recoveryRequired('publication member receipt is malformed');
    for (let effectIndex = 0; effectIndex < plans.length; effectIndex += 1) {
      const plan = plans[effectIndex];
      const receipt = validateRelocationReceipt(received.effects[effectIndex], plan);
      receipts.set(relocationKey(plan.sourcePath, plan.targetPath, plan.source.fileIdentity), receipt);
    }
  }
  return receipts;
}

function receiptForPlan(receiver, plan, providedReceipts) {
  const state = publisherRecord(receiver);
  const key = relocationKey(plan.sourcePath, plan.targetPath, plan.source.fileIdentity);
  if (state.uncertainRelocations.has(key)) return null;
  return state.relocationReceipts.get(key) ?? providedReceipts.get(key) ?? null;
}

function assertRollbackReceipts(receiver, plans, indexes) {
  for (const index of indexes) {
    if (receiptForPlan(receiver, plans[index], new Map()) === null) {
      throw recoveryRequired('rollback lacks a durable reverse relocation receipt');
    }
  }
}

function assertNoRollbackUncertainty(receiver, plans) {
  const state = publisherRecord(receiver);
  if (plans.some((plan) => state.uncertainRelocations.has(
    relocationKey(plan.sourcePath, plan.targetPath, plan.source.fileIdentity),
  ))) throw recoveryRequired('rollback has an unresolved reverse relocation');
}

async function inspectAuthorizedMember(receiver, member, providedReceipts = new Map()) {
  const plans = publicationEffectPlans(member);
  if (plans.some((plan) => (
    publisherRecord(receiver).uncertainRelocations.has(
      relocationKey(plan.sourcePath, plan.targetPath, plan.source.fileIdentity),
    )
  ))) return 'OTHER';
  const disposition = await inspectMember(receiver, member);
  if (disposition === 'OTHER' || disposition === 'BEFORE') return disposition;
  const required = disposition === 'GAP' ? plans.slice(0, 1) : plans;
  return required.every((plan) => receiptForPlan(receiver, plan, providedReceipts) !== null)
    ? disposition
    : 'OTHER';
}

function publicationReceipt(receiver, manifest) {
  const state = publisherRecord(receiver);
  return Object.freeze({
    disposition: 'AFTER',
    members: Object.freeze(manifest.members.map((member) => Object.freeze({
      refKey: member.refKey,
      disposition: 'AFTER',
      effects: Object.freeze(publicationEffectPlans(member).map((plan) => {
        const key = relocationKey(plan.sourcePath, plan.targetPath, plan.source.fileIdentity);
        const receipt = state.relocationReceipts.get(key);
        if (receipt === undefined || state.uncertainRelocations.has(key)) {
          throw recoveryRequired('publication lacks a durable relocation receipt');
        }
        return receipt;
      })),
    }))),
  });
}

function deleteKey(asset) {
  return `${asset.path}\0${asset.fileIdentity.dev}:${asset.fileIdentity.ino}`;
}

function hasLocalPristineProof(receiver, manifest, member) {
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) return false;
  const state = publisherRecord(receiver);
  const assetsWereCreatedLocally = manifest.assets.every((rawAsset) => {
    const asset = snapshotAsset(rawAsset);
    const proof = state.createdAssets.get(deleteKey(asset));
    return proof !== undefined
      && proof.mutationEpoch === state.writerCapabilityState.mutationEpoch
      && proof.asset.assetKind === asset.assetKind
      && proof.asset.byteSize === asset.byteSize
      && proof.asset.sha256 === asset.sha256
      && sameIdentity(proof.asset.parentIdentity, asset.parentIdentity);
  });
  if (!assetsWereCreatedLocally) return false;
  return [...publicationEffectPlans(member), ...rollbackEffectPlans(member)].every((plan) => {
    const key = relocationKey(plan.sourcePath, plan.targetPath, plan.source.fileIdentity);
    return !state.relocationReceipts.has(key) && !state.uncertainRelocations.has(key);
  });
}

function collectionPlan(manifest, terminalDisposition) {
  const plans = [];
  const seen = new Set();
  function add(asset, expectedPresent) {
    if (seen.has(asset.path)) return;
    seen.add(asset.path);
    plans.push(Object.freeze({ asset, expectedPresent }));
  }
  for (const rawAsset of manifest.assets) {
    const asset = snapshotAsset(rawAsset);
    add(asset, !(terminalDisposition === 'AFTER' && asset.assetKind === 'staged_after'));
  }
  for (const member of manifest.members) {
    if (!member.before.exists) continue;
    add(beforeAtDisplaced(member), terminalDisposition === 'AFTER');
  }
  return Object.freeze(plans);
}

function deletedReceipt(result, asset) {
  if (
    !hasExactKeys(result, [
      'alreadyAbsent',
      'deleted',
      'identity',
      'parentFsync',
      'parentIdentity',
    ])
    || !Object.isFrozen(result)
    || result.alreadyAbsent !== false
    || result.deleted !== true
    || result.parentFsync !== true
    || !sameIdentity(result.identity, asset.fileIdentity)
    || !sameIdentity(result.parentIdentity, asset.parentIdentity)
  ) throw recoveryRequired('verified delete lacks exact identity/fsync evidence');
  return Object.freeze({
    path: asset.path,
    disposition: 'DELETED',
    alreadyAbsent: false,
    deleted: true,
    identity: asset.fileIdentity,
    parentFsync: true,
    parentIdentity: asset.parentIdentity,
  });
}

class FilePublisher {
  constructor({ writerCapability }) {
    resolveWriterMethods(writerCapability);
    let writerCapabilityState = writerCapabilityStates.get(writerCapability);
    if (writerCapabilityState === undefined) {
      writerCapabilityState = Object.seal({
        uncertainRelocations: new Set(),
        uncertainDeletes: new Set(),
        mutationEpoch: 0n,
      });
      writerCapabilityStates.set(writerCapability, writerCapabilityState);
    }
    const state = Object.seal({
      createdAssets: new Map(),
      relocationReceipts: new Map(),
      uncertainRelocations: writerCapabilityState.uncertainRelocations,
      deleteReceipts: new Map(),
      uncertainDeletes: writerCapabilityState.uncertainDeletes,
      writerCapabilityState,
    });
    publisherRecords.set(this, Object.freeze({ capability: writerCapability, state }));
    Object.freeze(this);
  }

  async createAsset({ reservation, bytes }) {
    publisherRecord(this);
    const expected = snapshotReservation(reservation);
    if (!Buffer.isBuffer(bytes)) throw new TypeError('asset bytes must be a Buffer');
    const privateBytes = Buffer.from(bytes);
    if (privateBytes.length !== expected.byteSize || sha256(privateBytes) !== expected.sha256) {
      throw new TypeError('asset bytes do not match their reservation');
    }
    let result;
    try {
      result = await callWriter(this, 'createAssetVerified', expected.path, Object.freeze({
        byteSize: expected.byteSize,
        bytes: privateBytes,
        parentIdentity: expected.parentIdentity,
        sha256: expected.sha256,
      }));
    } catch (cause) {
      throw propagateDisposition(
        recoveryRequired('verified recovery asset creation failed', cause),
        cause,
      );
    }
    if (
      !hasExactKeys(result, [
        'byteSize',
        'fileFsync',
        'identity',
        'parentFsync',
        'parentIdentity',
        'sha256',
      ])
      || !Object.isFrozen(result)
      || result.byteSize !== expected.byteSize
      || result.sha256 !== expected.sha256
      || result.fileFsync !== true
      || result.parentFsync !== true
      || !sameIdentity(result.parentIdentity, expected.parentIdentity)
    ) {
      throw recoveryRequired('created recovery asset returned incomplete facts');
    }
    const asset = snapshotAsset(Object.freeze({
      assetKind: expected.assetKind,
      path: expected.path,
      parentIdentity: result.parentIdentity,
      fileIdentity: result.identity,
      byteSize: result.byteSize,
      sha256: result.sha256,
      fileSynced: result.fileFsync,
      parentSynced: result.parentFsync,
    }), 'created asset');
    if (
      asset.assetKind !== expected.assetKind
      || asset.path !== expected.path
      || asset.byteSize !== expected.byteSize
      || asset.sha256 !== expected.sha256
      || !sameIdentity(asset.parentIdentity, expected.parentIdentity)
    ) {
      throw recoveryRequired('created recovery asset does not match its reservation');
    }
    const reopened = await this.readAsset({ asset });
    if (!reopened.equals(privateBytes)) {
      throw recoveryRequired('created recovery asset failed readback');
    }
    const state = publisherRecord(this);
    state.createdAssets.set(deleteKey(asset), Object.freeze({
      asset,
      mutationEpoch: state.writerCapabilityState.mutationEpoch,
    }));
    return asset;
  }

  async readAsset({ asset }) {
    publisherRecord(this);
    const expected = snapshotAsset(asset);
    let result;
    try {
      result = await callWriter(this, 'readVerified', expected.path, presentExpectation(expected));
    } catch (cause) {
      throw recoveryRequired('recovery asset identity or bytes changed', cause);
    }
    validatePresent(result, expected);
    return Buffer.from(result.bytes);
  }

  async inspect({ manifest, publicationReceipt: persistedPublicationReceipt, scope = 'publication' }) {
    publisherRecord(this);
    if (!isPlainObject(manifest) || !Array.isArray(manifest.members)) {
      throw new TypeError('publication manifest is invalid');
    }
    if (!['publication', 'safe_abort'].includes(scope)) {
      throw new TypeError('publication inspection scope is invalid');
    }
    const providedReceipts = scope === 'publication'
      ? providedPublicationReceipts(persistedPublicationReceipt, manifest)
      : new Map();
    const members = [];
    for (const rawMember of manifest.members) {
      const member = assertMember(rawMember);
      members.push(Object.freeze({
        refKey: member.refKey,
        disposition: scope === 'safe_abort'
          ? await inspectMemberForSafeAbort(this, member)
          : await inspectAuthorizedMember(this, member, providedReceipts),
      }));
    }
    let ownedAssetsExact = true;
    if (scope === 'safe_abort') {
      if (!Array.isArray(manifest.assets)) {
        throw new TypeError('safe-abort manifest assets are invalid');
      }
      for (const rawAsset of manifest.assets) {
        const asset = snapshotAsset(rawAsset);
        const observed = await probeKnownPath(
          this,
          asset.path,
          asset.parentIdentity,
          [{ label: 'owned', asset }],
        );
        if (observed !== 'owned') ownedAssetsExact = false;
      }
    }
    const dispositions = members.map((member) => member.disposition);
    const disposition = scope === 'safe_abort'
      ? (ownedAssetsExact && dispositions.every((value) => value === 'SAFE_ABORT')
          ? 'SAFE_ABORT'
          : 'OTHER')
      : dispositions.every((value) => value === 'BEFORE')
        ? 'BEFORE'
        : dispositions.every((value) => value === 'AFTER')
          ? 'AFTER'
          : dispositions.every((value) => value !== 'OTHER')
            ? 'GAP'
            : 'OTHER';
    return Object.freeze({ disposition, members: Object.freeze(members) });
  }

  async publish({ manifest }) {
    publisherRecord(this);
    for (const rawMember of manifest.members) {
      const member = assertMember(rawMember);
      let disposition = await inspectAuthorizedMember(this, member);
      if (disposition === 'OTHER') {
        throw recoveryRequired('publication member is neither BEFORE, GAP, nor AFTER');
      }
      if (disposition === 'AFTER') continue;
      if (member.operation === 'update' && disposition === 'BEFORE') {
        await relocate(this, {
          assetKind: 'displaced_before',
          source: beforeAtFinal(member),
          sourceParentIdentity: member.final.parentIdentity,
          targetPath: member.displaced.path,
          targetParentIdentity: member.displaced.parentIdentity,
        });
        disposition = await inspectAuthorizedMember(this, member);
      }
      if (member.operation === 'update' && disposition === 'GAP') {
        await relocate(this, {
          assetKind: 'formal_after',
          source: member.after.asset,
          sourceParentIdentity: member.after.asset.parentIdentity,
          targetPath: member.final.path,
          targetParentIdentity: member.final.parentIdentity,
        });
      } else if (member.operation === 'create' && disposition === 'BEFORE') {
        await relocate(this, {
          assetKind: 'formal_after',
          source: member.after.asset,
          sourceParentIdentity: member.after.asset.parentIdentity,
          targetPath: member.final.path,
          targetParentIdentity: member.final.parentIdentity,
        });
      } else if (member.operation === 'delete' && disposition === 'BEFORE') {
        await relocate(this, {
          assetKind: 'displaced_before',
          source: beforeAtFinal(member),
          sourceParentIdentity: member.final.parentIdentity,
          targetPath: member.displaced.path,
          targetParentIdentity: member.displaced.parentIdentity,
        });
      }
      if (await inspectAuthorizedMember(this, member) !== 'AFTER') {
        throw recoveryRequired('publication member did not reach AFTER');
      }
    }
    const inspection = await this.inspect({ manifest });
    if (inspection.disposition !== 'AFTER') {
      throw recoveryRequired('publication did not reach complete AFTER');
    }
    return publicationReceipt(this, manifest);
  }

  async rollback({ manifest, publicationReceipt: persistedPublicationReceipt }) {
    publisherRecord(this);
    const providedReceipts = providedPublicationReceipts(persistedPublicationReceipt, manifest);
    const published = persistedPublicationReceipt !== undefined;
    for (const rawMember of [...manifest.members].reverse()) {
      const member = assertMember(rawMember);
      let disposition = await inspectAuthorizedMember(this, member, providedReceipts);
      if (disposition === 'OTHER') {
        throw recoveryRequired('rollback member is neither BEFORE, GAP, nor AFTER');
      }
      const initialDisposition = disposition;
      const reversePlans = rollbackEffectPlans(member);
      const localPristineProof = !published && hasLocalPristineProof(this, manifest, member);
      assertNoRollbackUncertainty(this, reversePlans);
      if (published && disposition === 'GAP') {
        assertRollbackReceipts(this, reversePlans, [0]);
      }
      if (disposition === 'BEFORE') {
        if (published) {
          assertRollbackReceipts(
            this,
            reversePlans,
            reversePlans.map((_, index) => index),
          );
        } else if (!localPristineProof) {
          assertRollbackReceipts(
            this,
            reversePlans,
            reversePlans.map((_, index) => index),
          );
        }
        continue;
      }
      if (member.operation === 'update' && disposition === 'AFTER') {
        await relocate(this, {
          assetKind: reversePlans[0].source.assetKind,
          source: reversePlans[0].source,
          sourceParentIdentity: reversePlans[0].sourceParentIdentity,
          targetPath: reversePlans[0].targetPath,
          targetParentIdentity: reversePlans[0].targetParentIdentity,
        });
        disposition = await inspectAuthorizedMember(this, member, providedReceipts);
      }
      if (member.operation === 'update' && disposition === 'GAP') {
        await relocate(this, {
          assetKind: 'formal_before',
          source: reversePlans[1].source,
          sourceParentIdentity: reversePlans[1].sourceParentIdentity,
          targetPath: reversePlans[1].targetPath,
          targetParentIdentity: reversePlans[1].targetParentIdentity,
        });
      } else if (member.operation === 'create' && disposition === 'AFTER') {
        await relocate(this, {
          assetKind: reversePlans[0].source.assetKind,
          source: reversePlans[0].source,
          sourceParentIdentity: reversePlans[0].sourceParentIdentity,
          targetPath: reversePlans[0].targetPath,
          targetParentIdentity: reversePlans[0].targetParentIdentity,
        });
      } else if (member.operation === 'delete' && disposition === 'AFTER') {
        await relocate(this, {
          assetKind: 'formal_before',
          source: reversePlans[0].source,
          sourceParentIdentity: reversePlans[0].sourceParentIdentity,
          targetPath: reversePlans[0].targetPath,
          targetParentIdentity: reversePlans[0].targetParentIdentity,
        });
      }
      if (await inspectMember(this, member) !== 'BEFORE') {
        throw recoveryRequired('rollback member did not reach BEFORE');
      }
      const requiredReverseIndexes = published || initialDisposition === 'AFTER'
        ? reversePlans.map((_, index) => index)
        : initialDisposition === 'GAP'
          ? [reversePlans.length - 1]
          : [];
      assertRollbackReceipts(this, reversePlans, requiredReverseIndexes);
    }
    const inspection = await this.inspect({ manifest });
    if (inspection.disposition !== 'BEFORE') {
      throw recoveryRequired('rollback did not reach complete BEFORE');
    }
    return inspection;
  }

  async collect({ manifest, publicationReceipt: persistedPublicationReceipt, terminalDisposition }) {
    const state = publisherRecord(this);
    if (
      !isPlainObject(manifest)
      || !Array.isArray(manifest.assets)
      || !Array.isArray(manifest.members)
      || !['BEFORE', 'AFTER'].includes(terminalDisposition)
    ) throw new TypeError('collection manifest is invalid');
    const terminalInspection = terminalDisposition === 'BEFORE'
      ? await this.inspect({ manifest, scope: 'safe_abort' })
      : await this.inspect({ manifest, publicationReceipt: persistedPublicationReceipt });
    if (
      (terminalDisposition === 'BEFORE' && terminalInspection.disposition !== 'SAFE_ABORT')
      || (terminalDisposition === 'AFTER' && terminalInspection.disposition !== 'AFTER')
    ) return Object.freeze({ disposition: 'OTHER', assets: Object.freeze([]) });

    const results = [];
    for (const plan of collectionPlan(manifest, terminalDisposition)) {
      const { asset, expectedPresent } = plan;
      if (!expectedPresent) continue;
      const key = deleteKey(asset);
      if (state.uncertainDeletes.has(key)) {
        return Object.freeze({ disposition: 'OTHER', assets: Object.freeze(results) });
      }
      let result;
      try {
        state.writerCapabilityState.mutationEpoch += 1n;
        result = await callWriter(this, 'deleteVerified', asset.path, Object.freeze({
          byteSize: asset.byteSize,
          identity: asset.fileIdentity,
          parentIdentity: asset.parentIdentity,
          sha256: asset.sha256,
        }));
      } catch (cause) {
        if (cause?.deleted === true) {
          state.uncertainDeletes.add(key);
          throw propagateDisposition(recoveryRequired('verified delete failed', cause), cause);
        }
        if (
          topologyChanged(cause)
          || (typeof cause?.code === 'string' && cause.code.startsWith('VERIFIED_'))
        ) return Object.freeze({ disposition: 'OTHER', assets: Object.freeze(results) });
        throw recoveryRequired('verified delete failed', cause);
      }
      let receipt;
      if (result?.deleted === true) {
        try {
          receipt = deletedReceipt(result, asset);
        } catch (cause) {
          state.uncertainDeletes.add(key);
          throw propagateDisposition(cause, result);
        }
        state.deleteReceipts.set(key, receipt);
      } else if (
        hasExactKeys(result, ['alreadyAbsent', 'deleted', 'parentFsync', 'parentIdentity'])
        && Object.isFrozen(result)
        && result.alreadyAbsent === true
        && result.deleted === false
        && result.parentFsync === false
        && sameIdentity(result.parentIdentity, asset.parentIdentity)
      ) {
        receipt = state.deleteReceipts.get(key) ?? null;
        if (receipt === null) {
          return Object.freeze({ disposition: 'OTHER', assets: Object.freeze(results) });
        }
      } else {
        return Object.freeze({ disposition: 'OTHER', assets: Object.freeze(results) });
      }
      results.push(receipt);
      try {
        faultPoint(FAULT_POINTS.FILE_PUBLICATION_AFTER_ASSET_DELETE, {
          disposition: receipt.disposition,
          path: asset.path,
        });
      } catch (cause) {
        throw propagateDisposition(cause, { deleted: true });
      }
    }
    return Object.freeze({ disposition: 'COLLECTED', assets: Object.freeze(results) });
  }
}

module.exports = {
  FilePublisher,
};
