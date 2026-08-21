'use strict';

const { assertCanonicalUuid, manuscriptError } = require('./contracts');
const { normalizeIgnoredLedgerRows } = require('./ignored-ledger');
const { assertControlledFileRef } = require('./paths');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
  canonicalSchema12ReuseIdentityPlan,
} = require('./projection-store');
const {
  canonicalCreateLogicalInputDigest,
  validateIdentityReservationManifest,
} = require('./uid-reservation');

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
const CHAPTER_STATUSES = new Set(['pending', 'writing', 'review', 'accepted']);
const CHAPTER_SIDECAR_KEYS = Object.freeze([
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
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
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
  if (kind === 'volume.create') {
    const title = descriptorValue(exact, 'title');
    const summary = descriptorValue(exact, 'summary');
    if (typeof title !== 'string' || typeof summary !== 'string') {
      invalid('volume create text fields must be strings');
    }
    return Object.freeze({ kind, title, summary });
  }
  if (kind === 'chapter.create') {
    const containerValue = descriptorValue(exact, 'containerVolumeUid');
    const containerVolumeUid = containerValue === null
      ? null
      : assertCanonicalUuid(containerValue, 'command.containerVolumeUid');
    const requestedNum = descriptorValue(exact, 'requestedNum');
    if (
      requestedNum !== null
      && (!Number.isSafeInteger(requestedNum) || requestedNum <= 0)
    ) invalid('command.requestedNum must be null or a positive safe integer');
    const content = descriptorValue(exact, 'content');
    if (typeof content !== 'string') invalid('command.content must be a string');
    const sidecarDescriptors = exactDescriptors(
      descriptorValue(exact, 'sidecar'),
      CHAPTER_SIDECAR_KEYS,
      'command.sidecar',
    );
    const sidecar = {};
    for (const key of CHAPTER_SIDECAR_KEYS) {
      const value = descriptorValue(sidecarDescriptors, key);
      if (typeof value !== 'string') invalid(`command.sidecar.${key} must be a string`);
      sidecar[key] = value;
    }
    if (!CHAPTER_STATUSES.has(sidecar.status)) {
      invalid('command.sidecar.status is invalid');
    }
    return Object.freeze({
      kind,
      containerVolumeUid,
      requestedNum,
      content,
      sidecar: Object.freeze(sidecar),
    });
  }
  const snapshot = { kind };
  for (const field of fields) {
    const value = descriptorValue(exact, field);
    if (field.endsWith('Ref')) {
      snapshot[field] = assertControlledFileRef(value);
    } else if (field === 'targetVolumeUid' || field === 'containerVolumeUid') {
      snapshot[field] = value === null
        ? null
        : assertCanonicalUuid(value, field);
    } else if (field.endsWith('Uid')) {
      snapshot[field] = assertCanonicalUuid(value, field);
    } else if (field === 'chapterUids' || field === 'volumeUids') {
      const values = snapshotPlainData(value, `command.${field}`);
      const seen = new Set();
      snapshot[field] = Object.freeze(values.map((uid, index) => {
        const canonical = assertCanonicalUuid(uid, `command.${field}[${index}]`);
        if (seen.has(canonical)) invalid(`command.${field} contains a duplicate UID`);
        seen.add(canonical);
        return canonical;
      }));
    } else if (field === 'targetPosition') {
      if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
        invalid('command.targetPosition must be a non-negative safe integer');
      }
      snapshot[field] = value;
    } else if (field === 'patch') {
      snapshot.patch = snapshotPlainData(value, 'command.patch');
    } else {
      if (typeof value !== 'string') invalid('command content must be a string');
      snapshot.content = value;
    }
  }
  return Object.freeze(snapshot);
}

function assertExactPermutation(actual, expected, label) {
  const expectedSet = new Set(expected);
  if (
    actual.length !== expected.length
    || actual.some((uid) => !expectedSet.has(uid))
  ) {
    invalid(`${label} must be the complete known active permutation`);
  }
}

function validateStructuralCommandAgainstBasis(command, turn) {
  const basis = turn.currentProjection.basis;
  const activeVolumes = basis.volumes.filter((row) => row.isPresent === 1);
  const volumeUidById = new Map(activeVolumes.map((row) => [row.id, row.uid]));
  const activeChapters = basis.chapters.filter((row) => row.isPresent === 1);
  function chapterContainerUid(row) {
    if (row.volumeId === null) return null;
    const uid = volumeUidById.get(row.volumeId);
    if (uid === undefined) invalid('active chapter refers to a non-active volume');
    return uid;
  }
  function requireContainer(volumeUid) {
    if (volumeUid !== null && !activeVolumes.some((row) => row.uid === volumeUid)) {
      invalid('command names a non-active target volume');
    }
  }
  function requireChapter(chapterUid) {
    const row = activeChapters.find((current) => current.uid === chapterUid);
    if (row === undefined) invalid('command names a non-active chapter');
    return row;
  }

  if (command.kind === 'chapter.move') {
    const source = requireChapter(command.chapterUid);
    requireContainer(command.targetVolumeUid);
    const sourceContainerUid = chapterContainerUid(source);
    if (sourceContainerUid === command.targetVolumeUid) {
      invalid('chapter.move source and target containers must differ');
    }
    const targetRows = activeChapters.filter((row) => (
      chapterContainerUid(row) === command.targetVolumeUid
    ));
    if (command.targetPosition > targetRows.length) {
      invalid('chapter.move targetPosition exceeds target known active length');
    }
    if (targetRows.some((row) => row.uid !== source.uid && row.num === source.num)) {
      invalid('chapter.move target contains the same active chapter number');
    }
  } else if (command.kind === 'chapter.reorder') {
    requireContainer(command.containerVolumeUid);
    assertExactPermutation(
      command.chapterUids,
      activeChapters
        .filter((row) => chapterContainerUid(row) === command.containerVolumeUid)
        .map((row) => row.uid),
      'chapter.reorder.chapterUids',
    );
  } else if (command.kind === 'volume.reorder') {
    assertExactPermutation(
      command.volumeUids,
      activeVolumes.map((row) => row.uid),
      'volume.reorder.volumeUids',
    );
  } else if (command.kind === 'chapter.delete') {
    requireChapter(command.chapterUid);
  } else if (command.kind === 'volume.delete') {
    if (!activeVolumes.some((row) => row.uid === command.volumeUid)) {
      invalid('volume.delete names a non-active volume');
    }
  }
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
  const ignoredLedgerSnapshot = snapshotPlainData(
    descriptorValue(descriptors, 'ignoredLedger'),
    'ignoredLedger',
  );
  const ignoredLedgerBefore = normalizeIgnoredLedgerRows(
    ignoredLedgerSnapshot,
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
  const localIdentityPlan = canonicalSchema12ReuseIdentityPlan(currentProjection);

  return Object.freeze({
    journalId,
    logicalRequestId,
    projectedAt,
    currentProjection,
    fileSnapshot,
    ignoredLedger: ignoredLedgerBefore,
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

function recoveryRequired(reason) {
  throw manuscriptError('RECOVERY_REQUIRED', { reason });
}

function canonicalDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function snapshotReservationBinding(value) {
  const descriptors = exactDescriptors(value, [
    'projectUid',
    'projectInstanceId',
    'journalId',
    'logicalRequestId',
    'baseGeneration',
    'targetGeneration',
    'basisDigest',
    'logicalInputDigest',
    'inputDigest',
    'reservationDigest',
  ], 'reservationBinding');
  const logicalRequestId = descriptorValue(descriptors, 'logicalRequestId');
  const baseGeneration = descriptorValue(descriptors, 'baseGeneration');
  const targetGeneration = descriptorValue(descriptors, 'targetGeneration');
  if (typeof logicalRequestId !== 'string' || logicalRequestId.length === 0) {
    invalid('reservationBinding.logicalRequestId must be a non-empty string');
  }
  if (
    !Number.isSafeInteger(baseGeneration)
    || baseGeneration < 0
    || !Number.isSafeInteger(targetGeneration)
    || targetGeneration !== baseGeneration + 1
  ) invalid('reservationBinding generations are invalid');
  return Object.freeze({
    projectUid: assertCanonicalUuid(
      descriptorValue(descriptors, 'projectUid'),
      'reservationBinding.projectUid',
    ),
    projectInstanceId: assertCanonicalUuid(
      descriptorValue(descriptors, 'projectInstanceId'),
      'reservationBinding.projectInstanceId',
    ),
    journalId: assertCanonicalUuid(
      descriptorValue(descriptors, 'journalId'),
      'reservationBinding.journalId',
    ),
    logicalRequestId,
    baseGeneration,
    targetGeneration,
    basisDigest: canonicalDigest(
      descriptorValue(descriptors, 'basisDigest'),
      'reservationBinding.basisDigest',
    ),
    logicalInputDigest: canonicalDigest(
      descriptorValue(descriptors, 'logicalInputDigest'),
      'reservationBinding.logicalInputDigest',
    ),
    inputDigest: canonicalDigest(
      descriptorValue(descriptors, 'inputDigest'),
      'reservationBinding.inputDigest',
    ),
    reservationDigest: canonicalDigest(
      descriptorValue(descriptors, 'reservationDigest'),
      'reservationBinding.reservationDigest',
    ),
  });
}

function snapshotOrdinaryLookup(value, logicalRequestId) {
  if (value === null) return null;
  const descriptors = exactDescriptors(value, [
    'state', 'outcome', 'identityReservation', 'reservationBinding',
  ], 'ordinary request lookup');
  const state = descriptorValue(descriptors, 'state');
  const outcome = descriptorValue(descriptors, 'outcome');
  if (typeof state !== 'string' || state.length === 0) invalid('lookup.state must be non-empty');
  if (!['early', 'advanced', 'after', 'before'].includes(outcome)) {
    invalid('lookup.outcome is invalid');
  }
  const identityReservation = validateIdentityReservationManifest(
    descriptorValue(descriptors, 'identityReservation'),
  );
  const reservationBinding = snapshotReservationBinding(
    descriptorValue(descriptors, 'reservationBinding'),
  );
  if (
    reservationBinding.logicalRequestId !== logicalRequestId
    || identityReservation.logicalRequestId !== logicalRequestId
    || reservationBinding.projectUid !== identityReservation.projectUid
    || reservationBinding.projectInstanceId !== identityReservation.projectInstanceId
    || reservationBinding.logicalInputDigest !== identityReservation.logicalInputDigest
    || reservationBinding.basisDigest !== identityReservation.sourceBasisDigest
  ) recoveryRequired('persisted create reservation binding is inconsistent');
  return Object.freeze({
    state,
    outcome,
    identityReservation,
    reservationBinding,
  });
}

function objectKindFor(command) {
  return command.kind === 'volume.create' ? 'volume' : 'chapter';
}

function expectedCreateAllocation(command, turn) {
  const objectKind = objectKindFor(command);
  const table = objectKind === 'volume' ? 'volumes' : 'chapters';
  const sequence = turn.currentProjection.basis.sqliteSequence.find(
    (row) => row.name === table,
  )?.seq ?? 0;
  if (sequence === Number.MAX_SAFE_INTEGER) invalid(`${table} cannot allocate another id`);
  if (objectKind === 'volume') {
    return Object.freeze({ objectKind, id: sequence + 1 });
  }
  let containerVolumeId = null;
  if (command.containerVolumeUid !== null) {
    const volume = turn.currentProjection.basis.volumes.find((row) => (
      row.uid === command.containerVolumeUid && row.isPresent === 1
    ));
    if (volume === undefined) invalid('chapter create target volume is not active');
    containerVolumeId = volume.id;
  }
  const activeNumbers = turn.currentProjection.basis.chapters
    .filter((row) => row.isPresent === 1 && row.volumeId === containerVolumeId)
    .map((row) => row.num);
  let num = command.requestedNum;
  if (num === null) {
    const maximum = activeNumbers.reduce((current, value) => Math.max(current, value), 0);
    if (maximum === Number.MAX_SAFE_INTEGER) invalid('automatic chapter number is exhausted');
    num = maximum + 1;
  } else if (activeNumbers.includes(num)) {
    invalid('requested chapter number is already active in the target container');
  }
  return Object.freeze({
    objectKind,
    id: sequence + 1,
    num,
    containerVolumeUid: command.containerVolumeUid,
    requestedNum: command.requestedNum,
  });
}

function assertCurrentCreateManifest(identityReservation, command, descriptor, turn) {
  const manifest = validateIdentityReservationManifest(identityReservation);
  const allocation = expectedCreateAllocation(command, turn);
  const lifecycleRows = manifest.objectKind === 'volume'
    ? turn.currentProjection.basis.volumes
    : turn.currentProjection.basis.chapters;
  const reusesKnownIdentity = (
    manifest.uid === turn.currentProjection.projectUid
    || lifecycleRows.some((row) => row.uid === manifest.uid)
    || turn.ignoredLedger.some((row) => (
      row.resource_kind === manifest.objectKind && row.resource_uid === manifest.uid
    ))
  );
  if (
    manifest.objectKind !== allocation.objectKind
    || manifest.projectUid !== turn.currentProjection.projectUid
    || manifest.projectInstanceId !== turn.currentProjection.projectInstanceId
    || manifest.logicalRequestId !== turn.logicalRequestId
    || manifest.logicalInputDigest !== descriptor.logicalInputDigest
    || manifest.sourceBasisDigest !== turn.basisDigest
    || reusesKnownIdentity
    || manifest.id !== allocation.id
    || (allocation.objectKind === 'chapter' && (
      manifest.num !== allocation.num
      || manifest.containerVolumeUid !== allocation.containerVolumeUid
      || manifest.requestedNum !== allocation.requestedNum
    ))
  ) invalid('identity reservation does not match the current create allocation');
  return manifest;
}

function assertPersistedIntent(lookup, command, descriptor, turn, { early = false } = {}) {
  const manifest = lookup.identityReservation;
  const binding = lookup.reservationBinding;
  if (
    manifest.objectKind !== objectKindFor(command)
    || manifest.projectUid !== turn.currentProjection.projectUid
    || manifest.projectInstanceId !== turn.currentProjection.projectInstanceId
    || manifest.logicalRequestId !== turn.logicalRequestId
    || manifest.logicalInputDigest !== descriptor.logicalInputDigest
    || binding.projectUid !== turn.currentProjection.projectUid
    || binding.projectInstanceId !== turn.currentProjection.projectInstanceId
    || binding.logicalRequestId !== turn.logicalRequestId
    || binding.logicalInputDigest !== descriptor.logicalInputDigest
  ) recoveryRequired('persisted logical request belongs to another create intent');
  if (early) {
    assertCurrentCreateManifest(manifest, command, descriptor, turn);
    if (
      binding.baseGeneration !== turn.baseGeneration
      || binding.targetGeneration !== turn.targetGeneration
      || binding.basisDigest !== turn.basisDigest
    ) recoveryRequired('early reservation does not match the current projection basis');
  }
  return lookup;
}

function samePlain(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSamePersistedWitness(before, after) {
  if (
    !samePlain(before.identityReservation, after.identityReservation)
    || !samePlain(before.reservationBinding, after.reservationBinding)
  ) recoveryRequired('persisted create witness changed during recovery');
}

function createResult(lookup) {
  const manifest = lookup.identityReservation;
  return Object.freeze({
    state: 'created',
    objectKind: manifest.objectKind,
    uid: manifest.uid,
    id: manifest.id,
    ...(manifest.objectKind === 'chapter' ? { num: manifest.num } : {}),
    targetGeneration: lookup.reservationBinding.targetGeneration,
  });
}

function reservedIdentityPlan(turn, identityReservation) {
  return Object.freeze([
    ...turn.localIdentityPlan,
    Object.freeze({
      assignmentKind: 'reserved_new',
      objectKind: identityReservation.objectKind,
      uid: identityReservation.uid,
      id: identityReservation.id,
      ...(identityReservation.objectKind === 'chapter'
        ? { num: identityReservation.num }
        : {}),
      reservationId: identityReservation.reservationId,
    }),
  ].sort((left, right) => (
    Buffer.compare(Buffer.from(left.objectKind, 'utf8'), Buffer.from(right.objectKind, 'utf8'))
    || Buffer.compare(Buffer.from(left.uid, 'utf8'), Buffer.from(right.uid, 'utf8'))
  )));
}

function createL2ManuscriptService(options) {
  const optionDescriptors = exactDescriptors(options, [
    'manuscriptStore',
    'fileJournal',
    'projectionStore',
    'uidReservation',
    'uidPathProbe',
  ], 'L2 service options');
  const store = requirePort(
    descriptorValue(optionDescriptors, 'manuscriptStore'),
    ['buildClosure', 'finalizeCandidate'],
    'manuscriptStore',
  );
  const journal = requirePort(descriptorValue(optionDescriptors, 'fileJournal'), [
    'lookupOrdinaryRequest',
    'readReservation',
    'assertReservation',
    'stageAssets',
    'bindTarget',
    'prepare',
    'publishFiles',
    'commitProjection',
    'complete',
    'recover',
  ], 'fileJournal');
  const projection = requirePort(
    descriptorValue(optionDescriptors, 'projectionStore'),
    ['buildTarget'],
    'projectionStore',
  );
  const uid = requirePort(
    descriptorValue(optionDescriptors, 'uidReservation'),
    ['reserveNewIdentity', 'assertReservation'],
    'uidReservation',
  );
  const pathProbe = requirePort(
    descriptorValue(optionDescriptors, 'uidPathProbe'),
    ['probe'],
    'uidPathProbe',
  );
  const intentRecords = new WeakMap();
  let intentAuthority;
  function ownedIntent(writeIntent) {
    if (this !== intentAuthority) invalid('write intent authority receiver is invalid');
    const record = (
      writeIntent !== null
      && typeof writeIntent === 'object'
    ) ? intentRecords.get(writeIntent) : undefined;
    if (record === undefined) invalid('write intent is not owned by this service');
    return record;
  }
  intentAuthority = Object.freeze({
    assert(writeIntent) {
      ownedIntent.call(this, writeIntent);
      return writeIntent;
    },
    describe(writeIntent) {
      return ownedIntent.call(this, writeIntent).descriptor;
    },
  });

  async function executeCreate(command, descriptor, turn) {
    let lookup = snapshotOrdinaryLookup(
      journal.lookupOrdinaryRequest(turn.logicalRequestId),
      turn.logicalRequestId,
    );
    if (lookup !== null) {
      assertPersistedIntent(lookup, command, descriptor, turn);
      if (lookup.outcome === 'after') return createResult(lookup);
      if (lookup.outcome === 'before') {
        recoveryRequired('logical request already reached durable BEFORE; use a new logicalRequestId');
      }
      if (lookup.outcome === 'advanced') {
        const beforeRecovery = lookup;
        await journal.recover(beforeRecovery.reservationBinding.journalId);
        lookup = snapshotOrdinaryLookup(
          journal.lookupOrdinaryRequest(turn.logicalRequestId),
          turn.logicalRequestId,
        );
        if (lookup === null) recoveryRequired('advanced recovery lost its logical request');
        assertPersistedIntent(lookup, command, descriptor, turn);
        assertSamePersistedWitness(beforeRecovery, lookup);
        if (lookup.outcome === 'after') return createResult(lookup);
        if (lookup.outcome === 'before') {
          recoveryRequired('advanced recovery proved durable BEFORE; use a new logicalRequestId');
        }
        recoveryRequired('advanced recovery did not prove a terminal disposition');
      }
    }

    let identityReservation;
    let publicationJournalId;
    let earlyWitness = null;
    if (lookup === null) {
      const allocation = Object.freeze({
        containerVolumeUid: command.kind === 'chapter.create'
          ? command.containerVolumeUid
          : null,
        requestedNum: command.kind === 'chapter.create' ? command.requestedNum : null,
      });
      const minted = await uid.reserveNewIdentity({
        kind: objectKindFor(command),
        logicalRequestId: turn.logicalRequestId,
        currentProjection: turn.currentProjection,
        ignoredLedgerBefore: turn.ignoredLedger,
        allocation,
        pathProbe,
        logicalInputDigest: descriptor.logicalInputDigest,
      });
      const mintedDescriptors = exactDescriptors(
        minted,
        ['identityReservation', 'authority'],
        'UID reservation result',
      );
      identityReservation = descriptorValue(mintedDescriptors, 'identityReservation');
      const asserted = uid.assertReservation({
        authority: descriptorValue(mintedDescriptors, 'authority'),
        identityReservation,
      });
      if (asserted !== identityReservation) {
        invalid('UID reservation assertion must return the original manifest');
      }
      assertCurrentCreateManifest(identityReservation, command, descriptor, turn);
      publicationJournalId = turn.journalId;
    } else {
      const read = journal.readReservation({
        journalId: lookup.reservationBinding.journalId,
        logicalRequestId: turn.logicalRequestId,
      });
      if (read === null) recoveryRequired('early reservation disappeared before resume');
      const readDescriptors = exactDescriptors(
        read,
        ['identityReservation', 'authority'],
        'reservation read result',
      );
      identityReservation = descriptorValue(readDescriptors, 'identityReservation');
      const assertedBinding = snapshotReservationBinding(journal.assertReservation({
        authority: descriptorValue(readDescriptors, 'authority'),
        identityReservation,
        journalId: lookup.reservationBinding.journalId,
        logicalRequestId: turn.logicalRequestId,
      }));
      const resumedManifest = assertCurrentCreateManifest(
        identityReservation,
        command,
        descriptor,
        turn,
      );
      assertPersistedIntent(lookup, command, descriptor, turn, { early: true });
      if (
        !samePlain(resumedManifest, lookup.identityReservation)
        || !samePlain(assertedBinding, lookup.reservationBinding)
      ) recoveryRequired('early reservation authority changed its persisted witness');
      publicationJournalId = lookup.reservationBinding.journalId;
      earlyWitness = lookup;
    }

    const buildResult = await store.buildClosure(
      turn.fileSnapshot,
      command,
      turn.ignoredLedger,
      identityReservation,
    );
    if (
      buildResult === null
      || typeof buildResult !== 'object'
      || !Array.isArray(buildResult.closure)
      || !Object.isFrozen(buildResult.closure)
      || buildResult.closure.length === 0
    ) invalid('create buildClosure returned an invalid or empty closure result');
    if (buildResult.candidateTemplate?.projectUid !== turn.currentProjection.projectUid) {
      invalid('file snapshot project does not match currentProjection');
    }

    const staged = await journal.stageAssets({
      journalId: publicationJournalId,
      logicalRequestId: turn.logicalRequestId,
      baseGeneration: turn.baseGeneration,
      targetGeneration: turn.targetGeneration,
      basisDigest: turn.basisDigest,
      closure: buildResult.closure,
      identityReservation,
      parent: null,
    });
    const candidate = store.finalizeCandidate(buildResult, staged.stagedAfterFacts);
    const projectionTarget = projection.buildTarget({
      candidate,
      currentProjection: turn.currentProjection,
      targetGeneration: turn.targetGeneration,
      projectedAt: turn.projectedAt,
      ignoredLedger: turn.ignoredLedger,
      localIdentityPlan: reservedIdentityPlan(turn, validateIdentityReservationManifest(
        identityReservation,
      )),
    });
    const bound = await journal.bindTarget({
      stagedAssets: staged.stagedAssets,
      projectionTarget,
    });
    await journal.prepare({ preparedAssets: bound.preparedAssets });
    await journal.publishFiles(publicationJournalId);
    await journal.commitProjection(publicationJournalId);
    await journal.complete(publicationJournalId);

    const finalLookup = snapshotOrdinaryLookup(
      journal.lookupOrdinaryRequest(turn.logicalRequestId),
      turn.logicalRequestId,
    );
    if (finalLookup === null) recoveryRequired('completed create has no durable logical request');
    assertPersistedIntent(finalLookup, command, descriptor, turn);
    const usedManifest = validateIdentityReservationManifest(identityReservation);
    if (
      finalLookup.outcome !== 'after'
      || finalLookup.reservationBinding.journalId !== publicationJournalId
      || !samePlain(finalLookup.identityReservation, usedManifest)
    ) recoveryRequired('completed create did not prove its durable AFTER assignment');
    if (earlyWitness !== null) {
      assertSamePersistedWitness(earlyWitness, finalLookup);
    } else if (
      finalLookup.reservationBinding.baseGeneration !== turn.baseGeneration
      || finalLookup.reservationBinding.targetGeneration !== turn.targetGeneration
      || finalLookup.reservationBinding.basisDigest !== turn.basisDigest
    ) recoveryRequired('fresh create durable binding changed its projection basis');
    return createResult(finalLookup);
  }

  const service = Object.freeze({
    bindWriteIntent(command) {
      const safeCommand = snapshotMutation(command);
      const descriptor = safeCommand.kind === 'volume.create'
        || safeCommand.kind === 'chapter.create'
        ? Object.freeze({
          family: 'ordinary_create',
          logicalInputDigest: canonicalCreateLogicalInputDigest(safeCommand),
        })
        : Object.freeze({ family: 'non_create', logicalInputDigest: null });
      const writeIntent = Object.freeze({});
      intentRecords.set(writeIntent, Object.freeze({ command: safeCommand, descriptor }));
      return writeIntent;
    },
    writeIntentAuthority() {
      return intentAuthority;
    },
    async execute(writeIntent, turnContext) {
      const intent = ownedIntent.call(intentAuthority, writeIntent);
      const safeCommand = intent.command;
      const turn = snapshotTurn(turnContext);
      validateStructuralCommandAgainstBasis(safeCommand, turn);

      if (intent.descriptor.family === 'ordinary_create') {
        return executeCreate(safeCommand, intent.descriptor, turn);
      }

      const buildResult = await store.buildClosure(
        turn.fileSnapshot,
        safeCommand,
        turn.ignoredLedger,
        null,
      );
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
  return service;
}

module.exports = {
  createL2ManuscriptService,
};
