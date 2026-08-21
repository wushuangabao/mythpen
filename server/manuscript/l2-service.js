'use strict';

const { assertCanonicalUuid } = require('./contracts');
const { assertControlledFileRef } = require('./paths');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('./projection-store');

const TURN_KEYS = Object.freeze([
  'journalId',
  'logicalRequestId',
  'projectedAt',
  'currentProjection',
  'fileSnapshot',
  'ignoredLedger',
]);
const MUTATION_FIELDS = Object.freeze({
  'chapter.replace_body': Object.freeze(['bodyRef', 'content']),
  'chapter.patch_sidecar': Object.freeze(['sidecarRef', 'patch']),
  'chapter.replace_body_and_sidecar': Object.freeze([
    'bodyRef', 'sidecarRef', 'content', 'patch',
  ]),
  'volume.patch_metadata': Object.freeze(['volumeRef', 'patch']),
});
const CANONICAL_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NOOP_RESULT = Object.freeze({ state: 'noop' });

function invalid(message) {
  throw new TypeError(message);
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
      invalid(`${label} must contain enumerable string data properties only`);
    }
  }
  return descriptors;
}

function exactDescriptors(value, keys, label) {
  const descriptors = dataDescriptors(value, label);
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} has an inexact key set`);
  }
  return descriptors;
}

function descriptorValue(descriptors, key) {
  return descriptors[key].value;
}

function snapshotPlainData(value, label, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      invalid(`${label} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== 'object' || active.has(value)) {
    invalid(`${label} must be finite plain data`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalid(`${label} must be a plain array`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')
        ) {
          invalid(`${label} must be a dense data array`);
        }
        result.push(snapshotPlainData(descriptor.value, `${label}[${index}]`, active));
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string'
          || !/^(0|[1-9][0-9]*)$/u.test(key)
          || Number(key) >= value.length
        ) {
          invalid(`${label} has an invalid array property`);
        }
      }
      return Object.freeze(result);
    }
    const descriptors = dataDescriptors(value, label);
    const result = {};
    for (const key of Object.keys(descriptors)) {
      result[key] = snapshotPlainData(descriptors[key].value, `${label}.${key}`, active);
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

function snapshotMutation(command) {
  const descriptors = dataDescriptors(command, 'command');
  const kindDescriptor = descriptors.kind;
  if (kindDescriptor === undefined) invalid('command.kind is required');
  const kind = descriptorValue(descriptors, 'kind');
  if (typeof kind !== 'string' || !Object.hasOwn(MUTATION_FIELDS, kind)) {
    invalid('command kind is not supported by ordinary L2 writes');
  }
  const fields = MUTATION_FIELDS[kind];
  const exact = exactDescriptors(command, ['kind', ...fields], 'command');
  const snapshot = { kind };
  for (const field of fields) {
    const value = descriptorValue(exact, field);
    if (field.endsWith('Ref')) {
      snapshot[field] = assertControlledFileRef(value);
    } else if (field === 'patch') {
      snapshot.patch = snapshotPlainData(value, 'command.patch');
    } else {
      if (typeof value !== 'string') invalid('command content must be a string');
      snapshot.content = value;
    }
  }
  return Object.freeze(snapshot);
}

function snapshotTurn(turnContext) {
  const descriptors = exactDescriptors(turnContext, TURN_KEYS, 'turnContext');
  const journalId = assertCanonicalUuid(
    descriptorValue(descriptors, 'journalId'),
    'journal_id',
  );
  const logicalRequestId = descriptorValue(descriptors, 'logicalRequestId');
  if (typeof logicalRequestId !== 'string' || logicalRequestId.length === 0) {
    invalid('logicalRequestId must be a non-empty string');
  }
  const projectedAt = descriptorValue(descriptors, 'projectedAt');
  if (
    typeof projectedAt !== 'string'
    || !CANONICAL_TIME_PATTERN.test(projectedAt)
    || Number.isNaN(Date.parse(projectedAt))
    || new Date(projectedAt).toISOString() !== projectedAt
  ) {
    invalid('projectedAt must be a canonical UTC ISO timestamp');
  }
  const fileSnapshot = descriptorValue(descriptors, 'fileSnapshot');
  if (fileSnapshot === null || typeof fileSnapshot !== 'object') {
    invalid('fileSnapshot must be an opaque Store snapshot');
  }

  const currentProjection = snapshotPlainData(
    descriptorValue(descriptors, 'currentProjection'),
    'currentProjection',
  );
  const ignoredLedgerBefore = snapshotPlainData(
    descriptorValue(descriptors, 'ignoredLedger'),
    'ignoredLedger',
  );
  const projectionDescriptors = exactDescriptors(
    currentProjection,
    ['projectUid', 'projectInstanceId', 'basis'],
    'currentProjection',
  );
  assertCanonicalUuid(descriptorValue(projectionDescriptors, 'projectUid'), 'project_uid');
  assertCanonicalUuid(
    descriptorValue(projectionDescriptors, 'projectInstanceId'),
    'project_instance_id',
  );
  const basis = descriptorValue(projectionDescriptors, 'basis');
  if (basis.sourceKind !== 'schema12') {
    invalid('ordinary L2 writes require a schema12 projection basis');
  }
  const canonicalBasisDigest = canonicalProjectionBasisDigest(basis);
  if (basis.basisDigest !== canonicalBasisDigest) {
    invalid('currentProjection basisDigest does not match its canonical basis');
  }
  const baseGeneration = basis.baseGeneration;
  if (!Number.isSafeInteger(baseGeneration) || baseGeneration < 0) {
    invalid('baseGeneration must be a non-negative safe integer');
  }
  if (baseGeneration === Number.MAX_SAFE_INTEGER) {
    invalid('targetGeneration exceeds the safe integer range');
  }
  const targetGeneration = baseGeneration + 1;
  if (canonicalIgnoredLedgerDigest(ignoredLedgerBefore) !== basis.ignoredBeforeDigest) {
    invalid('ignoredLedger does not match the projection basis');
  }
  for (const row of ignoredLedgerBefore) {
    if (row.projection_generation !== baseGeneration) {
      invalid('ignoredLedger generation does not match the projection basis');
    }
  }
  const ignoredLedger = Object.freeze(ignoredLedgerBefore.map((row) => Object.freeze({
    ...row,
    projection_generation: targetGeneration,
  })));
  const localIdentityPlan = Object.freeze([
    ...basis.chapters.map((row) => Object.freeze({
      assignmentKind: 'reuse_uid',
      objectKind: 'chapter',
      uid: row.uid,
      id: row.id,
      num: row.num,
    })),
    ...basis.volumes.map((row) => Object.freeze({
      assignmentKind: 'reuse_uid',
      objectKind: 'volume',
      uid: row.uid,
      id: row.id,
    })),
  ].sort((left, right) => (
    Buffer.compare(Buffer.from(left.objectKind, 'utf8'), Buffer.from(right.objectKind, 'utf8'))
    || Buffer.compare(Buffer.from(left.uid, 'utf8'), Buffer.from(right.uid, 'utf8'))
  )));

  return Object.freeze({
    journalId,
    logicalRequestId,
    projectedAt,
    currentProjection,
    fileSnapshot,
    ignoredLedger,
    baseGeneration,
    targetGeneration,
    basisDigest: canonicalBasisDigest,
    localIdentityPlan,
  });
}

function requirePort(value, methods, label) {
  if (
    value === null
    || (typeof value !== 'object' && typeof value !== 'function')
    || methods.some((method) => typeof value[method] !== 'function')
  ) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function createL2ManuscriptService({ manuscriptStore, fileJournal, projectionStore }) {
  const store = requirePort(
    manuscriptStore,
    ['buildClosure', 'finalizeCandidate'],
    'manuscriptStore',
  );
  const journal = requirePort(fileJournal, [
    'stageAssets',
    'bindTarget',
    'prepare',
    'publishFiles',
    'commitProjection',
    'complete',
  ], 'fileJournal');
  const projection = requirePort(projectionStore, ['buildTarget'], 'projectionStore');

  return Object.freeze({
    async execute(command, turnContext) {
      const safeCommand = snapshotMutation(command);
      const turn = snapshotTurn(turnContext);

      const buildResult = await store.buildClosure(turn.fileSnapshot, safeCommand);
      if (
        buildResult === null
        || typeof buildResult !== 'object'
        || !Array.isArray(buildResult.closure)
        || !Object.isFrozen(buildResult.closure)
      ) {
        invalid('buildClosure returned an invalid closure result');
      }
      if (buildResult.candidateTemplate?.projectUid !== turn.currentProjection.projectUid) {
        invalid('file snapshot project does not match currentProjection');
      }
      if (buildResult.closure.length === 0) return NOOP_RESULT;

      const staged = await journal.stageAssets({
        journalId: turn.journalId,
        logicalRequestId: turn.logicalRequestId,
        baseGeneration: turn.baseGeneration,
        targetGeneration: turn.targetGeneration,
        basisDigest: turn.basisDigest,
        closure: buildResult.closure,
        identityReservation: null,
        parent: null,
      });
      const candidate = store.finalizeCandidate(buildResult, staged.stagedAfterFacts);
      const projectionTarget = projection.buildTarget({
        candidate,
        currentProjection: turn.currentProjection,
        targetGeneration: turn.targetGeneration,
        projectedAt: turn.projectedAt,
        ignoredLedger: turn.ignoredLedger,
        localIdentityPlan: turn.localIdentityPlan,
      });
      const bound = await journal.bindTarget({
        stagedAssets: staged.stagedAssets,
        projectionTarget,
      });
      await journal.prepare({ preparedAssets: bound.preparedAssets });
      await journal.publishFiles(turn.journalId);
      await journal.commitProjection(turn.journalId);
      return journal.complete(turn.journalId);
    },
  });
}

module.exports = {
  createL2ManuscriptService,
};
