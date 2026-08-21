'use strict';

const { assertCanonicalUuid } = require('./contracts');

const DURABLE_STATES = new Set([
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
const VIEW_KEYS = [
  'baseGeneration',
  'baseRawSha256',
  'childJournalId',
  'conflictId',
  'createdAt',
  'decisionEpoch',
  'draftByteSize',
  'draftRawSha256',
  'externalByteSize',
  'externalRawSha256',
  'fieldMask',
  'resource',
  'state',
  'supersedes',
];
const serviceRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDescriptors(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) invalid(`${label} has an inexact key set`);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) invalid(`${label}.${key} must be an enumerable own data property`);
  }
  return descriptors;
}

function captureExactPort(value, methods, label, requireFrozen = false) {
  if (requireFrozen && !Object.isFrozen(value)) invalid(`${label} must be frozen`);
  const descriptors = exactDescriptors(value, methods, label);
  const captured = {};
  for (const method of methods) {
    const implementation = descriptors[method].value;
    if (typeof implementation !== 'function') invalid(`${label}.${method} must be a function`);
    captured[method] = (...args) => Reflect.apply(implementation, value, args);
  }
  return Object.freeze(captured);
}

function captureJournal(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    invalid('journal is required');
  }
  const methods = [
    'archive',
    'beginAccept',
    'beginApply',
    'createConflict',
    'intentAuthority',
    'listConflicts',
    'readConflict',
    'recordAcceptResolved',
    'recordApplyResolved',
  ];
  const captured = {};
  for (const method of methods) {
    let owner = value;
    let descriptor;
    while (owner !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(owner, method);
      owner = Object.getPrototypeOf(owner);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      invalid(`journal.${method} must be a data method`);
    }
    if (typeof descriptor.value !== 'function') invalid(`journal.${method} must be a function`);
    captured[method] = (...args) => Reflect.apply(descriptor.value, value, args);
  }
  return Object.freeze(captured);
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function snapshotFieldMask(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('conflict.fieldMask must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!Object.isFrozen(value) || Reflect.ownKeys(descriptors).length !== value.length + 1) {
    invalid('conflict.fieldMask must be an exact frozen array');
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
      || descriptor.value.length === 0
    ) invalid('conflict.fieldMask contains an invalid field');
    result.push(descriptor.value);
  }
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] >= result[index]) {
      invalid('conflict.fieldMask must be unique and sorted');
    }
  }
  return Object.freeze(result);
}

function snapshotResource(value) {
  if (!Object.isFrozen(value)) invalid('conflict.resource must be frozen');
  const descriptors = exactDescriptors(value, ['domain', 'kind', 'uid'], 'conflict.resource');
  const kind = descriptors.kind.value;
  const domain = descriptors.domain.value;
  if (!['chapter', 'volume', 'manuscript'].includes(kind)) {
    invalid('conflict.resource.kind is invalid');
  }
  if (!['body', 'sidecar', 'volume_metadata', 'structure'].includes(domain)) {
    invalid('conflict.resource.domain is invalid');
  }
  return Object.freeze({
    kind,
    uid: assertCanonicalUuid(descriptors.uid.value, 'conflict.resource.uid'),
    domain,
  });
}

function snapshotConflictInput(value) {
  if (!Object.isFrozen(value)) invalid('conflict must be frozen');
  const descriptors = exactDescriptors(value, [
    'basis',
    'draftBytes',
    'externalBytes',
    'fieldMask',
    'resource',
    'supersedes',
  ], 'conflict');
  const basis = descriptors.basis.value;
  if (!Object.isFrozen(basis)) invalid('conflict.basis must be frozen');
  const basisDescriptors = exactDescriptors(
    basis,
    ['baseGeneration', 'baseRawSha256'],
    'conflict.basis',
  );
  const draftBytes = descriptors.draftBytes.value;
  const externalBytes = descriptors.externalBytes.value;
  if (!Buffer.isBuffer(draftBytes) || !Buffer.isBuffer(externalBytes)) {
    invalid('conflict bytes must be Buffer values');
  }
  const supersedes = descriptors.supersedes.value;
  return Object.freeze({
    resource: snapshotResource(descriptors.resource.value),
    basis: Object.freeze({
      baseGeneration: nonNegativeInteger(
        basisDescriptors.baseGeneration.value,
        'conflict.basis.baseGeneration',
      ),
      baseRawSha256: digest(
        basisDescriptors.baseRawSha256.value,
        'conflict.basis.baseRawSha256',
      ),
    }),
    draftBytes: Buffer.from(draftBytes),
    externalBytes: Buffer.from(externalBytes),
    fieldMask: snapshotFieldMask(descriptors.fieldMask.value),
    supersedes: supersedes === null
      ? null
      : assertCanonicalUuid(supersedes, 'conflict.supersedes'),
  });
}

function snapshotIntentDescriptor(value) {
  if (!Object.isFrozen(value)) invalid('draft conflict intent descriptor must be frozen');
  if (!isPlainObject(value)) invalid('draft conflict intent descriptor must be a plain object');
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    kindDescriptor === undefined
    || kindDescriptor.enumerable !== true
    || !Object.hasOwn(kindDescriptor, 'value')
  ) invalid('draft conflict intent kind must be an own data property');
  const kind = kindDescriptor.value;
  if (kind === 'create_backup') {
    const descriptors = exactDescriptors(value, ['conflict', 'kind'], 'create backup intent');
    return Object.freeze({ kind, conflict: snapshotConflictInput(descriptors.conflict.value) });
  }
  if (kind === 'accept_external') {
    const descriptors = exactDescriptors(
      value,
      ['conflictId', 'decisionEpoch', 'kind'],
      'accept external intent',
    );
    return Object.freeze({
      kind,
      conflictId: assertCanonicalUuid(descriptors.conflictId.value, 'conflict_id'),
      decisionEpoch: nonNegativeInteger(descriptors.decisionEpoch.value, 'decisionEpoch'),
    });
  }
  if (kind === 'apply_saved_draft') {
    const descriptors = exactDescriptors(
      value,
      ['conflictId', 'decisionEpoch', 'kind'],
      'apply saved draft intent',
    );
    return Object.freeze({
      kind,
      conflictId: assertCanonicalUuid(descriptors.conflictId.value, 'conflict_id'),
      decisionEpoch: nonNegativeInteger(descriptors.decisionEpoch.value, 'decisionEpoch'),
    });
  }
  invalid('draft conflict intent kind is unsupported');
}

function snapshotTurnDescriptor(value) {
  if (!Object.isFrozen(value)) invalid('draft conflict turn descriptor must be frozen');
  const descriptors = exactDescriptors(value, ['journalId'], 'draft conflict turn descriptor');
  return Object.freeze({
    journalId: assertCanonicalUuid(descriptors.journalId.value, 'turn journal_id'),
  });
}

function assertOriginal(record, intent, context, expectedKind) {
  if (intent === null || (typeof intent !== 'object' && typeof intent !== 'function')) {
    invalid('draft conflict intent must be opaque');
  }
  if (context === null || (typeof context !== 'object' && typeof context !== 'function')) {
    invalid('draft conflict turn context must be opaque');
  }
  if (record.contextAuthority.assert(context) !== context) {
    invalid('contextAuthority did not return the original turn context');
  }
  const turn = snapshotTurnDescriptor(record.contextAuthority.describe(context));
  if (record.intentAuthority.assert(intent) !== intent) {
    invalid('intentAuthority did not return the original intent');
  }
  const descriptor = snapshotIntentDescriptor(record.intentAuthority.describe(intent));
  if (descriptor.kind !== expectedKind) invalid(`expected ${expectedKind} intent`);
  if (record.consumed.has(intent)) invalid('draft conflict intent is already consumed');
  record.consumed.add(intent);
  return Object.freeze({ descriptor, turn });
}

function snapshotConflictView(value) {
  if (!Object.isFrozen(value)) invalid('draft conflict journal view must be frozen');
  const descriptors = exactDescriptors(value, VIEW_KEYS, 'draft conflict journal view');
  const state = descriptors.state.value;
  if (state === 'conflict_detected') return null;
  if (!DURABLE_STATES.has(state)) invalid('draft conflict journal state is not durable');
  return Object.freeze({
    conflictId: descriptors.conflictId.value,
    supersedes: descriptors.supersedes.value,
    state,
    decisionEpoch: descriptors.decisionEpoch.value,
    childJournalId: descriptors.childJournalId.value,
    resource: descriptors.resource.value,
    baseGeneration: descriptors.baseGeneration.value,
    baseRawSha256: descriptors.baseRawSha256.value,
    externalRawSha256: descriptors.externalRawSha256.value,
    draftRawSha256: descriptors.draftRawSha256.value,
    externalByteSize: descriptors.externalByteSize.value,
    draftByteSize: descriptors.draftByteSize.value,
    fieldMask: descriptors.fieldMask.value,
    createdAt: descriptors.createdAt.value,
    backupAvailable: true,
    decisionAvailable: state === 'decision_ready',
  });
}

class DraftConflictService {
  constructor(options) {
    const descriptors = exactDescriptors(options, [
      'contextAuthority',
      'intentAuthority',
      'journal',
      'resolutionPipeline',
    ], 'DraftConflictService options');
    const journal = captureJournal(descriptors.journal.value);
    const journalIntentAuthority = journal.intentAuthority();
    captureExactPort(
      journalIntentAuthority,
      ['assert', 'describe'],
      'journal intent authority',
      true,
    );
    const resolutionPipeline = captureExactPort(
      descriptors.resolutionPipeline.value,
      ['acceptExternal', 'applySavedDraft', 'intentAuthority'],
      'resolutionPipeline',
    );
    if (resolutionPipeline.intentAuthority() !== journalIntentAuthority) {
      invalid('resolutionPipeline is bound to a foreign journal intent authority');
    }
    serviceRecords.set(this, Object.freeze({
      contextAuthority: captureExactPort(
        descriptors.contextAuthority.value,
        ['assert', 'describe'],
        'contextAuthority',
        true,
      ),
      intentAuthority: captureExactPort(
        descriptors.intentAuthority.value,
        ['assert', 'describe'],
        'intentAuthority',
        true,
      ),
      journal,
      resolutionPipeline,
      consumed: new WeakSet(),
    }));
    Object.freeze(this);
  }

  listConflicts(context) {
    const record = serviceRecords.get(this);
    if (record.contextAuthority.assert(context) !== context) {
      invalid('contextAuthority did not return the original turn context');
    }
    const views = record.journal.listConflicts();
    if (!Array.isArray(views)) invalid('journal.listConflicts must return an array');
    const visible = [];
    for (const view of views) {
      const snapshot = snapshotConflictView(view);
      if (snapshot !== null) visible.push(snapshot);
    }
    return Object.freeze(visible);
  }

  async createBackup(intent, context) {
    const record = serviceRecords.get(this);
    const { descriptor } = assertOriginal(record, intent, context, 'create_backup');
    return record.journal.createConflict(descriptor.conflict);
  }

  async acceptExternal(intent, context) {
    const record = serviceRecords.get(this);
    const { descriptor } = assertOriginal(record, intent, context, 'accept_external');
    const conflict = record.journal.readConflict(descriptor.conflictId);
    const journalIntent = await record.journal.beginAccept({
      acceptedRawSha256: conflict.externalRawSha256,
      baseGeneration: conflict.baseGeneration,
      conflictId: descriptor.conflictId,
      decisionEpoch: descriptor.decisionEpoch,
      targetGeneration: conflict.baseGeneration + 1,
    });
    const evidence = await record.resolutionPipeline.acceptExternal(journalIntent, context);
    await record.journal.recordAcceptResolved(journalIntent, evidence);
    return record.journal.archive({ conflictId: descriptor.conflictId });
  }

  async applySavedDraft(intent, context) {
    const record = serviceRecords.get(this);
    const { descriptor, turn } = assertOriginal(
      record,
      intent,
      context,
      'apply_saved_draft',
    );
    const conflict = record.journal.readConflict(descriptor.conflictId);
    const journalIntent = await record.journal.beginApply({
      baseGeneration: conflict.baseGeneration,
      childJournalId: turn.journalId,
      conflictId: descriptor.conflictId,
      decisionEpoch: descriptor.decisionEpoch,
      externalRawSha256: conflict.externalRawSha256,
      targetGeneration: conflict.baseGeneration + 1,
    });
    const evidence = await record.resolutionPipeline.applySavedDraft(journalIntent, context);
    await record.journal.recordApplyResolved(journalIntent, evidence);
    return record.journal.archive({ conflictId: descriptor.conflictId });
  }
}

module.exports = {
  DraftConflictService,
};
