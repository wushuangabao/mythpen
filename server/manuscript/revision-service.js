'use strict';

const REVISION_KINDS = new Set([
  'revision.create',
  'revision.update_decisions',
  'revision.reject',
  'revision.accept',
  'revision.finalize',
]);
const AUXILIARY_KINDS = new Set([
  'revision.create',
  'revision.update_decisions',
  'revision.reject',
]);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactData(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) invalid(`${label} has an inexact key set`);
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) invalid(`${label}.${key} must be an enumerable own data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function capturePort(value, methods, label) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    invalid(`${label} is required`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured = {};
  for (const method of methods) {
    const descriptor = descriptors[method];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function'
    ) invalid(`${label}.${method} must be an own enumerable data method`);
    captured[method] = (...args) => Reflect.apply(descriptor.value, value, args);
  }
  return Object.freeze(captured);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    invalid(`${label} must be a positive safe integer`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function stableUid(value, label) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    invalid(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function decisionMap(value, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of Reflect.ownKeys(descriptors).sort((left, right) => (
    Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'))
  ))) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || key.length === 0
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || (descriptor.value !== 'accepted' && descriptor.value !== 'rejected')
    ) invalid(`${label} contains an invalid decision`);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotRevisionCommand(command) {
  if (!isPlainObject(command)) invalid('revision command must be a plain object');
  const kindDescriptor = Object.getOwnPropertyDescriptor(command, 'kind');
  if (
    kindDescriptor === undefined
    || kindDescriptor.enumerable !== true
    || !Object.hasOwn(kindDescriptor, 'value')
    || !REVISION_KINDS.has(kindDescriptor.value)
  ) invalid('revision command kind is unsupported');
  const kind = kindDescriptor.value;
  if (kind === 'revision.create') {
    const input = exactData(
      command,
      ['kind', 'chapterUid', 'baseContent', 'proposedContent'],
      'revision.create command',
    );
    return Object.freeze({
      kind,
      chapterUid: stableUid(input.chapterUid, 'revision.create chapterUid'),
      baseContent: text(input.baseContent, 'revision.create baseContent'),
      proposedContent: text(input.proposedContent, 'revision.create proposedContent'),
    });
  }
  if (kind === 'revision.update_decisions') {
    const input = exactData(
      command,
      ['kind', 'revisionId', 'decisions', 'expectedBaseContent'],
      'revision.update_decisions command',
    );
    return Object.freeze({
      kind,
      revisionId: positiveInteger(input.revisionId, 'revision.update_decisions revisionId'),
      decisions: decisionMap(input.decisions, 'revision.update_decisions decisions'),
      expectedBaseContent: text(
        input.expectedBaseContent,
        'revision.update_decisions expectedBaseContent',
      ),
    });
  }
  if (kind === 'revision.reject' || kind === 'revision.accept') {
    const input = exactData(
      command,
      ['kind', 'revisionId', 'expectedBaseContent'],
      `${kind} command`,
    );
    return Object.freeze({
      kind,
      revisionId: positiveInteger(input.revisionId, `${kind} revisionId`),
      expectedBaseContent: text(input.expectedBaseContent, `${kind} expectedBaseContent`),
    });
  }
  const input = exactData(
    command,
    ['kind', 'revisionId', 'content', 'expectedBaseContent', 'expectedDecisions'],
    'revision.finalize command',
  );
  return Object.freeze({
    kind,
    revisionId: positiveInteger(input.revisionId, 'revision.finalize revisionId'),
    content: text(input.content, 'revision.finalize content'),
    expectedBaseContent: text(input.expectedBaseContent, 'revision.finalize expectedBaseContent'),
    expectedDecisions: decisionMap(input.expectedDecisions, 'revision.finalize expectedDecisions'),
  });
}

function snapshotTurn(turnContext) {
  const turn = exactData(turnContext, [
    'journalId',
    'logicalRequestId',
    'projectedAt',
    'currentProjection',
    'fileSnapshot',
    'ignoredLedger',
  ], 'revision turnContext');
  if (typeof turn.logicalRequestId !== 'string' || turn.logicalRequestId.length === 0) {
    invalid('revision turn logicalRequestId is required');
  }
  if (typeof turn.projectedAt !== 'string') invalid('revision turn projectedAt is required');
  if (!isPlainObject(turn.currentProjection) || !Object.isFrozen(turn.currentProjection)) {
    invalid('revision turn currentProjection must be frozen plain data');
  }
  return Object.freeze(turn);
}

function createRevisionService(options) {
  const optionKeys = isPlainObject(options)
    && Object.hasOwn(Object.getOwnPropertyDescriptors(options), 'resolutionPublisher')
    ? ['auxiliaryStore', 'resolutionPublisher']
    : ['auxiliaryStore'];
  const input = exactData(options, optionKeys, 'revision service options');
  const auxiliaryStore = capturePort(input.auxiliaryStore, ['apply'], 'auxiliaryStore');
  const resolutionPublisher = Object.hasOwn(input, 'resolutionPublisher')
    ? capturePort(input.resolutionPublisher, ['publish'], 'resolutionPublisher')
    : null;
  const intents = new WeakMap();
  let authority;

  function recordFor(receiver, intent) {
    if (receiver !== authority) invalid('revision intent authority receiver is invalid');
    const record = (
      intent !== null
      && (typeof intent === 'object' || typeof intent === 'function')
    ) ? intents.get(intent) : undefined;
    if (record === undefined) invalid('revision intent is foreign or stale');
    return record;
  }

  authority = Object.freeze({
    assert(intent) {
      recordFor(this, intent);
      return intent;
    },
    describe(intent) {
      return recordFor(this, intent).descriptor;
    },
  });

  const service = Object.freeze({
    bindWriteIntent(command) {
      if (this !== service) invalid('revision service receiver is invalid');
      const safeCommand = snapshotRevisionCommand(command);
      const intent = Object.freeze({});
      intents.set(intent, Object.freeze({
        command: safeCommand,
        descriptor: Object.freeze({ family: 'non_create', logicalInputDigest: null }),
      }));
      return intent;
    },
    writeIntentAuthority() {
      if (this !== service) invalid('revision service receiver is invalid');
      return authority;
    },
    execute(intent, turnContext) {
      if (this !== service) invalid('revision service receiver is invalid');
      const record = recordFor(authority, intent);
      const turn = snapshotTurn(turnContext);
      if (!AUXILIARY_KINDS.has(record.command.kind)) {
        if (resolutionPublisher === null) {
          const error = new Error('Revision article publication seam is not installed');
          error.code = 'RECOVERY_REQUIRED';
          throw error;
        }
        return resolutionPublisher.publish(record.command, turnContext);
      }
      return auxiliaryStore.apply(Object.freeze({
        action: record.command,
        currentProjection: turn.currentProjection,
        logicalRequestId: turn.logicalRequestId,
        projectedAt: turn.projectedAt,
      }));
    },
  });
  return service;
}

module.exports = { createRevisionService };
