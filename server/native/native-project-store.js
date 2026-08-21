const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { Database } = require('bun:sqlite');

const controlStoreModule = require('../control-store');
const { createDatabaseIdentityGuard } = require('./database-identity-guard');
const {
  auditWritableTableManifest,
  canonicalTriggerDefinitions,
  canonicalTriggerSetDigest,
  inspectSchema12Contract,
} = require('./durability-schema');
const {
  SQLiteProjectionStore,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('../manuscript/projection-store');
const {
  consumeCreationRouteCas,
  consumeRouteCas,
} = require('../manuscript/route-store');
const {
  atomicReplace,
  fsyncDirectory,
  fsyncFile,
  installAbsentFromVerifiedSource,
} = require('../platform/durability');
const {
  classifyNativeSql,
  classifyNativeTransactionSql,
} = require('./native-sql-authorization');
const {
  FAULT_POINTS,
  crashOnlyFaultPoint,
  faultPoint,
} = require('../testing/fault-injection');

// Deliberately module-private. Business statement facades never receive this capability.
const DURABILITY_SQL_CAPABILITY = Symbol('native durability SQL capability');
const fullRefreshDispositionRecords = new WeakMap();
const knownRolledBackTargetInstallErrors = new WeakSet();
const knownRolledBackAuxiliaryActionErrors = new WeakSet();

function markKnownRolledBackTargetInstall(error) {
  if (
    (typeof error === 'object' || typeof error === 'function')
    && error !== null
  ) knownRolledBackTargetInstallErrors.add(error);
}

function markKnownRolledBackAuxiliaryAction(error) {
  if (
    (typeof error === 'object' || typeof error === 'function')
    && error !== null
  ) knownRolledBackAuxiliaryActionErrors.add(error);
}
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONNECTION_EPOCH_FILTER_DOMAIN = Buffer.from(
  'mythpen-controlstore-connection-epoch-v1\0',
  'utf8',
);
const CONNECTION_EPOCH_FILTER_BYTES = 1_048_576;
const NATIVE_EVENT_KEYS = ['digest', 'payload', 'prevDigest', 'seq', 'type'];
const COMMON_PAYLOAD_KEYS = [
  'version',
  'eventId',
  'dbKey',
  'projectInstanceIdSha256',
  'createdAt',
  'ownershipHash',
  'connectionEpoch',
];
const OPERATION_KINDS = new Set([
  'chapter_body_write',
  'project_metadata_write',
  'project_structure_write',
  'ai_usage_write',
  'chat_write',
  'project_seed',
]);
const TARGET_KINDS = new Set([
  'project',
  'volume',
  'chapter',
  'character',
  'world_entry',
  'timeline',
  'auxiliary',
  'token_usage',
  'chat',
  'seed',
]);
const ABANDON_REASONS = new Set([
  'validation_failed',
  'cas_failed',
  'cancelled',
  'superseded',
]);

function nativeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function creationRecoveryRequired(message, cause) {
  return nativeError('RECOVERY_REQUIRED', message, cause);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function exactDataValue(value, expected, key, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expected.length
    || actualKeys.some((current) => (
      typeof current !== 'string' || !expected.includes(current)
    ))
  ) throw new TypeError(`${label} has an inexact key set`);
  for (const current of expected) {
    const descriptor = descriptors[current];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) throw new TypeError(`${label}.${current} must be an enumerable data property`);
  }
  return descriptors[key].value;
}

function exactDataValues(value, expected, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expected.length
    || actualKeys.some((current) => (
      typeof current !== 'string' || !expected.includes(current)
    ))
  ) throw new TypeError(`${label} has an inexact key set`);
  const result = {};
  for (const current of expected) {
    const descriptor = descriptors[current];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) throw new TypeError(`${label}.${current} must be an enumerable data property`);
    result[current] = descriptor.value;
  }
  return result;
}

function evidenceError(message, cause) {
  return nativeError('NATIVE_ADMISSION_REJECTED', message, cause);
}

function requireExactKeys(value, expected, label) {
  if (!exactKeys(value, expected)) throw evidenceError(`${label} has an inexact key set`);
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw evidenceError(`${label} must be one lowercase SHA-256 digest`);
  }
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw evidenceError(`${label} must be one UUID v4`);
  }
}

function requireIsoTimestamp(value, label) {
  if (
    typeof value !== 'string'
    || !ISO_MILLISECOND_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw evidenceError(`${label} must be one exact millisecond UTC timestamp`);
  }
}

function requireSafeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw evidenceError(`${label} must be a safe integer >= ${minimum}`);
  }
}

function requireIdentity(value, label) {
  requireExactKeys(value, ['dev', 'ino'], label);
  if (!/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino)) {
    throw evidenceError(`${label} must contain decimal dev and ino strings`);
  }
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function requireCommonPayload(payload, expected, label) {
  if (payload.version !== 1) throw evidenceError(`${label}.version must equal 1`);
  requireUuid(payload.eventId, `${label}.eventId`);
  requireUuid(payload.connectionEpoch, `${label}.connectionEpoch`);
  requireIsoTimestamp(payload.createdAt, `${label}.createdAt`);
  for (const key of ['dbKey', 'projectInstanceIdSha256', 'ownershipHash']) {
    requireHash(payload[key], `${label}.${key}`);
    if (payload[key] !== expected[key]) {
      throw evidenceError(`${label}.${key} differs from the immutable genesis basis`);
    }
  }
}

function validateSourcePayload(payload, expected) {
  const ownKeys = [
    'logicalRequestDigest',
    'attemptSeq',
    'previousAttemptSourceDigest',
    'operationKind',
    'targetKind',
    'targetIdSha256',
    'expectedDataVersion',
  ];
  requireExactKeys(payload, [...COMMON_PAYLOAD_KEYS, ...ownKeys], 'manuscript.source payload');
  requireCommonPayload(payload, expected, 'manuscript.source payload');
  requireHash(payload.logicalRequestDigest, 'manuscript.source logicalRequestDigest');
  requireSafeInteger(payload.attemptSeq, 'manuscript.source attemptSeq', 1);
  if (payload.previousAttemptSourceDigest !== null) {
    requireHash(payload.previousAttemptSourceDigest, 'manuscript.source previousAttemptSourceDigest');
  }
  if (!OPERATION_KINDS.has(payload.operationKind)) {
    throw evidenceError('manuscript.source operationKind is unknown');
  }
  if (!TARGET_KINDS.has(payload.targetKind)) {
    throw evidenceError('manuscript.source targetKind is unknown');
  }
  if (payload.targetIdSha256 !== null) {
    requireHash(payload.targetIdSha256, 'manuscript.source targetIdSha256');
  }
  if (payload.expectedDataVersion !== null) {
    requireSafeInteger(payload.expectedDataVersion, 'manuscript.source expectedDataVersion');
  }
}

function validateAbandonedPayload(payload, expected) {
  requireExactKeys(
    payload,
    [...COMMON_PAYLOAD_KEYS, 'sourceDigest', 'reasonCode'],
    'manuscript.source.abandoned payload',
  );
  requireCommonPayload(payload, expected, 'manuscript.source.abandoned payload');
  requireHash(payload.sourceDigest, 'manuscript.source.abandoned sourceDigest');
  if (!ABANDON_REASONS.has(payload.reasonCode)) {
    throw evidenceError('manuscript.source.abandoned reasonCode is unknown');
  }
}

function validatePreparedPayload(payload, expected) {
  const ownKeys = [
    'transactionId',
    'sourceDigest',
    'beforeSeq',
    'expectedFinalSeq',
    'schemaVersion',
    'backend',
    'expectedGateEmpty',
    'expectedTriggerVersion',
    'expectedTriggerSetDigest',
    'expectedIdentity',
    'operationKind',
  ];
  requireExactKeys(payload, [...COMMON_PAYLOAD_KEYS, ...ownKeys], 'sqlite.tx.prepared payload');
  requireCommonPayload(payload, expected, 'sqlite.tx.prepared payload');
  requireUuid(payload.transactionId, 'sqlite.tx.prepared transactionId');
  requireHash(payload.sourceDigest, 'sqlite.tx.prepared sourceDigest');
  requireSafeInteger(payload.beforeSeq, 'sqlite.tx.prepared beforeSeq');
  requireSafeInteger(payload.expectedFinalSeq, 'sqlite.tx.prepared expectedFinalSeq', 1);
  if (
    payload.beforeSeq === Number.MAX_SAFE_INTEGER
    || payload.expectedFinalSeq !== payload.beforeSeq + 1
  ) {
    throw evidenceError('sqlite.tx.prepared expectedFinalSeq must equal beforeSeq + 1');
  }
  if (
    payload.schemaVersion !== 11
    || payload.backend !== 'native-sqlite-v2'
    || payload.expectedGateEmpty !== true
    || payload.expectedTriggerVersion !== 1
  ) {
    throw evidenceError('sqlite.tx.prepared freezes an invalid database contract');
  }
  requireHash(payload.expectedTriggerSetDigest, 'sqlite.tx.prepared expectedTriggerSetDigest');
  requireIdentity(payload.expectedIdentity, 'sqlite.tx.prepared expectedIdentity');
  if (!OPERATION_KINDS.has(payload.operationKind)) {
    throw evidenceError('sqlite.tx.prepared operationKind is unknown');
  }
}

function validateCommittedPayload(payload, expected) {
  const ownKeys = [
    'preparedDigest',
    'finalSeq',
    'schemaVersion',
    'backend',
    'gateEmpty',
    'triggerVersion',
    'triggerSetDigest',
    'postCommitIdentity',
  ];
  requireExactKeys(payload, [...COMMON_PAYLOAD_KEYS, ...ownKeys], 'sqlite.tx.committed payload');
  requireCommonPayload(payload, expected, 'sqlite.tx.committed payload');
  requireHash(payload.preparedDigest, 'sqlite.tx.committed preparedDigest');
  requireSafeInteger(payload.finalSeq, 'sqlite.tx.committed finalSeq', 1);
  if (
    payload.schemaVersion !== 11
    || payload.backend !== 'native-sqlite-v2'
    || payload.gateEmpty !== true
    || payload.triggerVersion !== 1
  ) {
    throw evidenceError('sqlite.tx.committed records an invalid database contract');
  }
  requireHash(payload.triggerSetDigest, 'sqlite.tx.committed triggerSetDigest');
  requireIdentity(payload.postCommitIdentity, 'sqlite.tx.committed postCommitIdentity');
}

function validateRollbackPredicate(payload) {
  const common = [
    'schemaVersion',
    'backend',
    'finalSeq',
    'gateEmpty',
    'triggerVersion',
    'triggerSetDigest',
    'identity',
  ];
  const shapes = {
    begin_not_acquired: {
      reasonCode: 'sqlite_busy',
      keys: [
        'autocommit',
        'writeLockAcquired',
        'gateSqlExecuted',
        'businessSqlExecuted',
        'seqSqlExecuted',
        ...common,
      ],
      booleans: {
        autocommit: true,
        writeLockAcquired: false,
        gateSqlExecuted: false,
        businessSqlExecuted: false,
        seqSqlExecuted: false,
      },
    },
    transaction_rolled_back: {
      reasonCode: 'transaction_failed',
      keys: ['autocommit', 'rollbackCompleted', ...common],
      booleans: { autocommit: true, rollbackCompleted: true },
    },
    recovery_before_commit: {
      reasonCode: 'crash_recovery',
      keys: ['autocommit', 'hotJournalRecovered', ...common],
      booleans: { autocommit: true, hotJournalRecovered: true },
    },
  };
  const shape = shapes[payload.rollbackKind];
  if (!shape || payload.reasonCode !== shape.reasonCode) {
    throw evidenceError('sqlite.tx.rolled_back reasonCode/rollbackKind pair is invalid');
  }
  requireExactKeys(payload.predicate, shape.keys, `${payload.rollbackKind} predicate`);
  for (const [key, value] of Object.entries(shape.booleans)) {
    if (payload.predicate[key] !== value) {
      throw evidenceError(`${payload.rollbackKind} predicate.${key} is invalid`);
    }
  }
  if (
    payload.predicate.schemaVersion !== 11
    || payload.predicate.backend !== 'native-sqlite-v2'
    || payload.predicate.finalSeq !== payload.beforeSeq
    || payload.predicate.gateEmpty !== true
    || payload.predicate.triggerVersion !== 1
  ) {
    throw evidenceError(`${payload.rollbackKind} predicate records an invalid database contract`);
  }
  requireHash(payload.predicate.triggerSetDigest, `${payload.rollbackKind} predicate triggerSetDigest`);
  requireIdentity(payload.predicate.identity, `${payload.rollbackKind} predicate identity`);
}

function validateRolledBackPayload(payload, expected) {
  const ownKeys = ['preparedDigest', 'beforeSeq', 'reasonCode', 'rollbackKind', 'predicate'];
  requireExactKeys(payload, [...COMMON_PAYLOAD_KEYS, ...ownKeys], 'sqlite.tx.rolled_back payload');
  requireCommonPayload(payload, expected, 'sqlite.tx.rolled_back payload');
  requireHash(payload.preparedDigest, 'sqlite.tx.rolled_back preparedDigest');
  requireSafeInteger(payload.beforeSeq, 'sqlite.tx.rolled_back beforeSeq');
  validateRollbackPredicate(payload);
}

function validateNativeEvent(event, previous, expected) {
  requireExactKeys(event, NATIVE_EVENT_KEYS, `${event?.type || 'native'} event`);
  requireSafeInteger(event.seq, 'native event seq', 1);
  requireHash(event.digest, 'native event digest');
  requireHash(event.prevDigest, 'native event prevDigest');
  if (event.seq !== previous.seq + 1 || event.prevDigest !== previous.digest) {
    throw evidenceError('Native suffix chain is not contiguous');
  }
  if (event.type === 'manuscript.source') validateSourcePayload(event.payload, expected);
  else if (event.type === 'manuscript.source.abandoned') validateAbandonedPayload(event.payload, expected);
  else if (event.type === 'sqlite.tx.prepared') validatePreparedPayload(event.payload, expected);
  else if (event.type === 'sqlite.tx.committed') validateCommittedPayload(event.payload, expected);
  else if (event.type === 'sqlite.tx.rolled_back') validateRolledBackPayload(event.payload, expected);
  else throw evidenceError(`Unknown native suffix event type: ${String(event.type)}`);
}

function evidenceAdmissionEvent(events, admissionEventDigest = null) {
  if (events.admissionEvent) return events.admissionEvent;
  if (admissionEventDigest !== null) {
    return events.find((event) => event.digest === admissionEventDigest) || null;
  }
  return events[0];
}

function checkpointFrontier(checkpoint) {
  if (checkpoint === null) return null;
  return Object.freeze({
    checkpointDigest: checkpoint.checkpointDigest,
    coveredSeq: checkpoint.coveredSeq,
    coveredDigest: checkpoint.coveredDigest,
    finalSeq: checkpoint.finalSeq,
    latestCleanBasisDigest: checkpoint.latestCleanBasisDigest,
  });
}

function sameCheckpointFrontier(left, right) {
  if (left === null || right === null) return left === right;
  return left.checkpointDigest === right.checkpointDigest
    && left.coveredSeq === right.coveredSeq
    && left.coveredDigest === right.coveredDigest
    && left.finalSeq === right.finalSeq
    && left.latestCleanBasisDigest === right.latestCleanBasisDigest;
}

function connectionEpochFilterPositions(basisDigest, connectionEpoch) {
  const basis = Buffer.from(basisDigest, 'hex');
  const epoch = Buffer.from(connectionEpoch.toLowerCase(), 'ascii');
  return Array.from({ length: 7 }, (_unused, index) => {
    const digest = createHash('sha256').update(Buffer.concat([
      CONNECTION_EPOCH_FILTER_DOMAIN,
      Buffer.from([index]),
      basis,
      epoch,
    ])).digest();
    return (((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 1);
  });
}

function inheritedConnectionEpochFilter(checkpoint) {
  if (checkpoint === null) return null;
  const filter = checkpoint.connectionEpochFilter;
  if (
    filter?.algorithm !== 'sha256-domain-separated-v1'
    || filter?.bitCount !== 8_388_608
    || filter?.hashCount !== 7
    || typeof filter?.bitsBase64 !== 'string'
  ) {
    throw evidenceError('Native checkpoint connection epoch filter is inexact');
  }
  const bytes = Buffer.from(filter.bitsBase64, 'base64');
  if (
    bytes.length !== CONNECTION_EPOCH_FILTER_BYTES
    || bytes.toString('base64') !== filter.bitsBase64
  ) {
    throw evidenceError('Native checkpoint connection epoch filter encoding is inexact');
  }
  return Object.freeze({
    basisDigest: checkpoint.admissionBasis.basisDigest,
    bitsBase64: filter.bitsBase64,
  });
}

function filterMayContainConnectionEpoch(filter, connectionEpoch) {
  if (filter === null) return false;
  const bytes = Buffer.from(filter.bitsBase64, 'base64');
  return connectionEpochFilterPositions(filter.basisDigest, connectionEpoch).every(
    (bit) => (bytes[bit >>> 3] & (1 << (bit & 7))) !== 0,
  );
}

function parseNativeEvidence(events, expected, admittedBasis = null) {
  const checkpoint = events.checkpoint || null;
  const activationBasis = admittedBasis?.basisKind === 'native_activation';
  const genesis = evidenceAdmissionEvent(events, admittedBasis?.basisDigest || null);
  const genesisPayload = genesis?.payload;
  if (activationBasis) {
    if (
      checkpoint !== null
      || genesis?.type !== 'sqlite.native.activation.activated'
      || !Number.isSafeInteger(genesis?.seq)
      || genesis.seq < 2
      || !HASH_PATTERN.test(genesis?.prevDigest || '')
      || !HASH_PATTERN.test(genesis?.digest || '')
      || genesisPayload?.schemaVersion !== 11
      || genesisPayload?.backend !== 'native-sqlite-v2'
      || genesisPayload?.finalSeq !== 0
      || genesisPayload?.gateEmpty !== true
      || genesisPayload?.triggerVersion !== 1
      || genesisPayload?.finalIdentity === undefined
    ) {
      throw evidenceError('Native activation admission basis is inexact');
    }
  } else if (
    genesis?.type !== 'sqlite.native.stage_b.fixture_genesis'
    || genesis?.seq !== 1
    || genesis?.prevDigest !== null
    || !HASH_PATTERN.test(genesis?.digest || '')
  ) {
    throw evidenceError('Native evidence does not begin with one exact fixture genesis');
  }
  const immutable = {
    dbKey: expected.dbKey,
    projectInstanceIdSha256: expected.projectInstanceIdSha256,
    ownershipHash: expected.ownershipHash,
  };
  for (const key of Object.keys(immutable)) {
    if (genesisPayload?.[key] !== undefined && genesisPayload[key] !== immutable[key]) {
      throw evidenceError(`Fixture genesis ${key} differs from the admitted basis`);
    }
  }

  if (
    checkpoint !== null
    && (
      checkpoint.admissionBasis?.basisKind !== 'stage_b_fixture_genesis'
      || checkpoint.admissionBasis?.basisDigest !== genesis.digest
      || checkpoint.admissionBasis?.admissionEvent?.digest !== genesis.digest
      || checkpoint.chainRoot?.seq !== 1
      || checkpoint.chainRoot?.digest !== genesis.digest
      || !Number.isSafeInteger(checkpoint.coveredSeq)
      || checkpoint.coveredSeq < 1
      || !HASH_PATTERN.test(checkpoint.coveredDigest || '')
      || !Number.isSafeInteger(checkpoint.finalSeq)
      || checkpoint.finalSeq < 0
      || checkpoint.dbKey !== expected.dbKey
      || checkpoint.schema !== genesisPayload.schemaVersion
      || checkpoint.backend !== genesisPayload.backend
      || checkpoint.triggerVersion !== genesisPayload.triggerVersion
      || checkpoint.triggerSetDigest !== genesisPayload.triggerSetDigest
      || checkpoint.projectInstanceIdSha256 !== expected.projectInstanceIdSha256
      || !sameIdentity(checkpoint.identity, expected.identity)
      || checkpoint.retryContinuationOpen !== false
      || !Array.isArray(checkpoint.unresolved)
      || checkpoint.unresolved.length !== 0
    )
  ) {
    throw evidenceError('Native checkpoint summary differs from its admitted genesis basis');
  }

  let mode = 'clean';
  let projectedSeq = checkpoint?.finalSeq || 0;
  let source = null;
  let prepared = null;
  const sourceHistory = new Map();
  const usedConnectionEpochs = new Set();
  const activeEpochObservations = [];
  if (
    checkpoint === null
    && !activationBasis
    && UUID_V4_PATTERN.test(genesisPayload?.connectionEpoch || '')
  ) {
    const normalizedGenesisEpoch = genesisPayload.connectionEpoch.toLowerCase();
    usedConnectionEpochs.add(normalizedGenesisEpoch);
    activeEpochObservations.push(normalizedGenesisEpoch);
  }
  let previous = checkpoint === null
    ? genesis
    : Object.freeze({ seq: checkpoint.coveredSeq, digest: checkpoint.coveredDigest });
  const startIndex = checkpoint === null
    ? activationBasis
      ? events.findIndex((event) => event.digest === genesis.digest) + 1
      : 1
    : 0;
  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    validateNativeEvent(event, previous, immutable);
    previous = event;
    const normalizedEpoch = event.payload.connectionEpoch.toLowerCase();
    activeEpochObservations.push(normalizedEpoch);
    if (event.type === 'manuscript.source') {
      if (mode !== 'clean') throw evidenceError('manuscript.source is not a legal successor');
      if (event.payload.attemptSeq === 1) {
        if (event.payload.previousAttemptSourceDigest !== null) {
          throw evidenceError('First source attempt must not name a previous source');
        }
      } else {
        const previousSource = sourceHistory.get(event.payload.previousAttemptSourceDigest);
        if (
          !previousSource
          || previousSource.payload.logicalRequestDigest !== event.payload.logicalRequestDigest
          || previousSource.payload.attemptSeq + 1 !== event.payload.attemptSeq
        ) {
          throw evidenceError('Retry source does not continue the preceding logical request attempt');
        }
      }
      sourceHistory.set(event.digest, event);
      source = event;
      prepared = null;
      mode = 'source';
      usedConnectionEpochs.add(normalizedEpoch);
      continue;
    }
    if (event.type === 'manuscript.source.abandoned') {
      if (
        mode !== 'source'
        || event.payload.sourceDigest !== source.digest
        || event.payload.connectionEpoch !== source.payload.connectionEpoch
      ) {
        throw evidenceError('manuscript.source.abandoned does not consume the current source');
      }
      source = null;
      mode = 'clean';
      usedConnectionEpochs.add(normalizedEpoch);
      continue;
    }
    if (event.type === 'sqlite.tx.prepared') {
      if (
        mode !== 'source'
        || event.payload.sourceDigest !== source.digest
        || event.payload.connectionEpoch !== source.payload.connectionEpoch
        || event.payload.beforeSeq !== projectedSeq
        || event.payload.operationKind !== source.payload.operationKind
        || event.payload.expectedTriggerSetDigest !== expected.triggerSetDigest
        || !sameIdentity(event.payload.expectedIdentity, expected.identity)
      ) {
        throw evidenceError('sqlite.tx.prepared does not consume the current source and clean state');
      }
      prepared = event;
      mode = 'prepared';
      usedConnectionEpochs.add(normalizedEpoch);
      continue;
    }
    if (event.type === 'sqlite.tx.committed') {
      const sameEpoch = event.payload.connectionEpoch === prepared?.payload.connectionEpoch;
      if (
        mode !== 'prepared'
        || event.payload.preparedDigest !== prepared.digest
        || event.payload.finalSeq !== prepared.payload.expectedFinalSeq
        || event.payload.triggerSetDigest !== expected.triggerSetDigest
        || !sameIdentity(event.payload.postCommitIdentity, expected.identity)
        || (!sameEpoch && usedConnectionEpochs.has(normalizedEpoch))
      ) {
        throw evidenceError('sqlite.tx.committed does not terminate the current prepared event');
      }
      projectedSeq = event.payload.finalSeq;
      source = null;
      prepared = null;
      mode = 'clean';
      usedConnectionEpochs.add(normalizedEpoch);
      continue;
    }
    if (
      mode !== 'prepared'
      || event.payload.preparedDigest !== prepared.digest
      || event.payload.beforeSeq !== prepared.payload.beforeSeq
      || event.payload.predicate.triggerSetDigest !== expected.triggerSetDigest
      || !sameIdentity(event.payload.predicate.identity, expected.identity)
    ) {
      throw evidenceError('sqlite.tx.rolled_back does not terminate the current prepared event');
    }
    const sameEpoch = event.payload.connectionEpoch === prepared.payload.connectionEpoch;
    if (
      event.payload.rollbackKind === 'recovery_before_commit'
        ? sameEpoch || usedConnectionEpochs.has(normalizedEpoch)
        : !sameEpoch
    ) {
      throw evidenceError('sqlite.tx.rolled_back uses an unauthorized connection epoch');
    }
    source = null;
    prepared = null;
    mode = 'clean';
    usedConnectionEpochs.add(normalizedEpoch);
  }
  const tail = events.at(-1) || Object.freeze({
    seq: checkpoint.coveredSeq,
    digest: checkpoint.coveredDigest,
  });
  return Object.freeze({
    admissionEvent: genesis,
    frontier: checkpointFrontier(checkpoint),
    inheritedConnectionEpochFilter: inheritedConnectionEpochFilter(checkpoint),
    events,
    tail,
    mode,
    projectedSeq,
    source,
    prepared,
    usedConnectionEpochs: Object.freeze([...usedConnectionEpochs]),
    activeEpochObservations: Object.freeze(activeEpochObservations),
  });
}

function evidenceSnapshot(controlStore) {
  if (!controlStore || typeof controlStore.read !== 'function') {
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'ControlStore evidence is required');
  }
  let events;
  let bounded = false;
  try {
    if (typeof controlStore.readEvidence === 'function') {
      bounded = true;
      const evidence = structuredClone(controlStore.readEvidence());
      const admissionEvent = evidence.checkpoint?.admissionBasis?.admissionEvent
        || evidence.events?.[0];
      if (
        !Array.isArray(evidence.events)
        || (!admissionEvent && evidence.events.length === 0)
      ) {
        throw nativeError(
          'NATIVE_ADMISSION_REJECTED',
          'Empty ControlStore evidence is never admissible',
        );
      }
      const checkpoint = deepFreeze(evidence.checkpoint);
      const boundedTail = deepFreeze(evidence.tail);
      const copiedAdmissionEvent = deepFreeze(admissionEvent);
      events = evidence.events;
      Object.defineProperties(events, {
        admissionEvent: { value: copiedAdmissionEvent },
        boundedTail: { value: boundedTail },
        checkpoint: { value: checkpoint },
      });
    } else {
      events = controlStore.read();
    }
  } catch (cause) {
    if (cause?.code === 'NATIVE_ADMISSION_REJECTED') throw cause;
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'ControlStore evidence cannot be read', cause);
  }
  if (
    !Array.isArray(events)
    || (events.length === 0 && (!bounded || events.checkpoint === null))
  ) {
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'Empty ControlStore evidence is never admissible');
  }
  try {
    return bounded ? deepFreeze(events) : deepFreeze(structuredClone(events));
  } catch (cause) {
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'ControlStore evidence is not serializable', cause);
  }
}

function verifyAdmission(admissionVerifier, events, context, admissionEventDigest = null) {
  if (typeof admissionVerifier !== 'function') {
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'admissionVerifier must be a function capability');
  }
  let basis;
  try {
    // The capability authenticates only the immutable genesis basis. Suffix
    // authorization belongs to the core policy below and is never delegated
    // back into the Stage B testing factory.
    const admissionEvent = evidenceAdmissionEvent(events, admissionEventDigest);
    const activationPrefix = admissionEvent?.type === 'sqlite.native.activation.activated'
      ? events.slice(0, events.findIndex((event) => event.digest === admissionEvent.digest) + 1)
      : null;
    basis = admissionVerifier(Object.freeze({
      ...context,
      evidence: Object.freeze([admissionEvent]),
      activationPrefix: activationPrefix === null ? null : deepFreeze(activationPrefix),
    }));
  } catch (cause) {
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'Native admission verifier rejected the evidence', cause);
  }
  if (
    basis === null
    || typeof basis !== 'object'
    || Array.isArray(basis)
    || Object.keys(basis).sort().join(',') !== 'basisDigest,basisKind'
    || !['stage_b_fixture_genesis', 'native_activation'].includes(basis.basisKind)
    || typeof basis.basisDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(basis.basisDigest)
    || (
      basis.basisKind === 'stage_b_fixture_genesis'
        ? evidenceAdmissionEvent(events)?.type !== 'sqlite.native.stage_b.fixture_genesis'
        : evidenceAdmissionEvent(events, admissionEventDigest)?.type
          !== 'sqlite.native.activation.activated'
    )
    || basis.basisDigest !== evidenceAdmissionEvent(events, admissionEventDigest)?.digest
  ) {
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'Native admission basis is not exact');
  }
  return Object.freeze({ basisKind: basis.basisKind, basisDigest: basis.basisDigest });
}

function evidenceExpectations(context, events, admittedBasis = null) {
  const admissionEvent = evidenceAdmissionEvent(events, admittedBasis?.basisDigest || null);
  return Object.freeze({
    dbKey: context.dbKey,
    projectInstanceIdSha256: context.projectInstanceIdSha256,
    ownershipHash: context.ownershipHash,
    triggerSetDigest: admissionEvent?.payload?.triggerSetDigest,
    identity: admissionEvent?.payload?.identity || admissionEvent?.payload?.finalIdentity,
  });
}

function assertEvidenceCurrent(controlStore, admissionVerifier, context, admittedBasis) {
  const current = evidenceSnapshot(controlStore);
  const currentBasis = verifyAdmission(
    admissionVerifier,
    current,
    context,
    admittedBasis.basisDigest,
  );
  if (
    currentBasis.basisKind !== admittedBasis.basisKind
    || currentBasis.basisDigest !== admittedBasis.basisDigest
  ) {
    throw nativeError('NATIVE_ADMISSION_REJECTED', 'ControlStore admission basis changed');
  }
  return parseNativeEvidence(
    current,
    evidenceExpectations(context, current, admittedBasis),
    admittedBasis,
  );
}

function pragmaScalar(database, sql) {
  const row = database.query(sql).get();
  return row && Object.values(row)[0];
}

function configureConnection(database, capability) {
  if (capability !== DURABILITY_SQL_CAPABILITY) {
    throw nativeError('NATIVE_SQL_FORBIDDEN', 'Durability SQL requires the private capability');
  }
  const journalMode = String(pragmaScalar(database, 'PRAGMA journal_mode = DELETE')).toLowerCase();
  database.exec('PRAGMA synchronous = EXTRA');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 100');
  const values = {
    journalMode,
    synchronous: Number(pragmaScalar(database, 'PRAGMA synchronous')),
    foreignKeys: Number(pragmaScalar(database, 'PRAGMA foreign_keys')),
    busyTimeout: Number(pragmaScalar(database, 'PRAGMA busy_timeout')),
  };
  if (
    values.journalMode !== 'delete'
    || values.synchronous !== 3
    || values.foreignKeys !== 1
    || values.busyTimeout !== 100
    || database.inTransaction !== false
  ) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native SQLite PRAGMA readback is not exact');
  }
}

function parseCanonicalSequence(raw) {
  if (
    typeof raw !== 'string'
    || !/^(0|[1-9][0-9]*)$/.test(raw)
  ) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'durability_commit_seq is not canonical decimal TEXT');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'durability_commit_seq exceeds the safe integer contract');
  }
  return value;
}

function liveStateSnapshot(database, expectedGateRows = 0) {
  try {
    auditWritableTableManifest(database);
    const reservedRows = database.query(
      "SELECT key, value, typeof(value) AS storageType FROM project_meta WHERE key IN ('schema_version', 'project_instance_id', 'durability_backend', 'durability_commit_seq', 'durability_trigger_version', 'durability_trigger_set_digest') ORDER BY key",
    ).all();
    if (reservedRows.length !== 6 || new Set(reservedRows.map(({ key }) => key)).size !== 6) {
      throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native reserved project_meta rows are not exact');
    }
    const reserved = new Map(reservedRows.map((row) => [row.key, row]));
    if (reservedRows.some(({ storageType }) => storageType !== 'text')) {
      throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native reserved project_meta values must be TEXT');
    }
    const schemaVersion = reserved.get('schema_version')?.value;
    const projectInstanceId = reserved.get('project_instance_id')?.value;
    const backend = reserved.get('durability_backend')?.value;
    const triggerVersionRaw = reserved.get('durability_trigger_version')?.value;
    const triggerSetDigest = reserved.get('durability_trigger_set_digest')?.value;
    if (
      schemaVersion !== '11'
      || !UUID_V4_PATTERN.test(projectInstanceId || '')
      || backend !== 'native-sqlite-v2'
      || triggerVersionRaw !== '1'
      || !HASH_PATTERN.test(triggerSetDigest || '')
    ) {
      throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native reserved metadata values are invalid');
    }
    const finalSeq = parseCanonicalSequence(reserved.get('durability_commit_seq')?.value);
    const gateCount = database.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get()?.count;
    if (gateCount !== expectedGateRows) {
      throw nativeError('NATIVE_GATE_NOT_EMPTY', 'Durability write gate row count is not exact');
    }

    const expectedDefinitions = canonicalTriggerDefinitions();
    const expectedByName = new Map(expectedDefinitions.map((definition) => [definition.name, definition]));
    const observedRows = database.query(
      "SELECT name, tbl_name AS tableName, sql FROM sqlite_schema WHERE type = 'trigger' AND substr(name, 1, ?) = ? ORDER BY name",
    ).all('_mythpen_downgrade_guard__'.length, '_mythpen_downgrade_guard__');
    if (observedRows.length !== expectedDefinitions.length) {
      throw nativeError('NATIVE_CONNECTION_REJECTED', 'Canonical trigger count is not exact');
    }
    const observedDefinitions = observedRows.map((row, index) => {
      const expectedDefinition = expectedByName.get(row.name);
      if (
        !expectedDefinition
        || row.name !== expectedDefinitions[index].name
        || row.tableName !== expectedDefinition.table
      ) {
        throw nativeError('NATIVE_CONNECTION_REJECTED', 'Canonical trigger identity is not exact');
      }
      return {
        name: row.name,
        table: row.tableName,
        operation: expectedDefinition.operation,
        sql: row.sql,
      };
    });
    const expectedTriggerSetDigest = canonicalTriggerSetDigest(expectedDefinitions);
    const observedTriggerSetDigest = canonicalTriggerSetDigest(observedDefinitions);
    if (
      triggerSetDigest !== expectedTriggerSetDigest
      || observedTriggerSetDigest !== expectedTriggerSetDigest
    ) {
      throw nativeError('NATIVE_CONNECTION_REJECTED', 'Canonical trigger digest three-way comparison failed');
    }
    return Object.freeze({
      schemaVersion: 11,
      projectInstanceId,
      projectInstanceIdSha256: createHash('sha256').update(projectInstanceId).digest('hex'),
      backend,
      finalSeq,
      gateEmpty: gateCount === 0,
      triggerVersion: 1,
      triggerSetDigest,
    });
  } catch (cause) {
    if (cause?.code?.startsWith('NATIVE_')) throw cause;
    if (cause?.code === 'SQLITE_BUSY' || cause?.code === 'SQLITE_LOCKED' || cause?.code === 'SQLITE_IOERR') {
      throw nativeError('NATIVE_STORE_DISPOSITION_UNKNOWN', 'Native live-state read is operationally uncertain', cause);
    }
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native live-state inspection failed', cause);
  }
}

function assertLiveStateBasis(snapshot, history, expected) {
  const genesis = history.admissionEvent?.payload;
  if (
    snapshot.schemaVersion !== 11
    || snapshot.backend !== 'native-sqlite-v2'
    || snapshot.projectInstanceIdSha256 !== expected.projectInstanceIdSha256
    || genesis?.dbKey !== expected.dbKey
    || genesis?.ownershipHash !== expected.ownershipHash
    || genesis?.projectInstanceIdSha256 !== expected.projectInstanceIdSha256
    || genesis?.schemaVersion !== snapshot.schemaVersion
    || genesis?.backend !== snapshot.backend
    || genesis?.finalSeq !== 0
    || genesis?.gateEmpty !== true
    || genesis?.triggerVersion !== snapshot.triggerVersion
    || genesis?.triggerSetDigest !== snapshot.triggerSetDigest
    || !sameIdentity(genesis?.identity || genesis?.finalIdentity, expected.identity)
  ) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'SQLite live state differs from admitted evidence');
  }
}

function assertLiveStateMatches(snapshot, history, expected, connectionEpoch, options = {}) {
  assertLiveStateBasis(snapshot, history, expected);
  if (history.mode === 'prepared' && options.allowPrepared !== true) {
    throw nativeError('RECOVERY_REQUIRED', 'Native evidence ends with an unresolved prepared transaction');
  }
  const expectedSeq = options.expectedSeq ?? history.projectedSeq;
  if (snapshot.finalSeq !== expectedSeq) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'SQLite sequence differs from projected evidence');
  }
  if (
    history.mode === 'source'
    && history.source.payload.connectionEpoch !== connectionEpoch
  ) {
    throw nativeError('NATIVE_SOURCE_NOT_CURRENT', 'Pending source belongs to another connection epoch');
  }
}

function createNativeProjectStore() {
  throw nativeError(
    'NATIVE_ACTIVATION_DISABLED',
    'Native project activation is disabled outside the Stage B testing factory',
  );
}

function validateExecuteInput(input, callback) {
  if (
    !exactKeys(input, ['sourceDigest', 'operationKind', 'logicalRequestDigest', 'attemptSeq'])
    || !HASH_PATTERN.test(input.sourceDigest || '')
    || !HASH_PATTERN.test(input.logicalRequestDigest || '')
    || !Number.isSafeInteger(input.attemptSeq)
    || input.attemptSeq < 1
    || !OPERATION_KINDS.has(input.operationKind)
    || typeof callback !== 'function'
  ) {
    throw nativeError('NATIVE_TRANSACTION_INPUT_INVALID', 'executeTransaction input is not exact');
  }
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function canonicalPhysicalName(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function closeSqliteExactly(database) {
  database.clearQueryCache();
  Bun.gc(true);
  database.close(true);
}

function fileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw nativeError('RECOVERY_REQUIRED', 'Migration file is not one single-link plain file');
  }
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function assertMigrationFile(filePath, expectedIdentity, expectedParent) {
  if (
    typeof filePath !== 'string'
    || path.resolve(filePath) !== filePath
    || path.dirname(filePath) !== expectedParent
    || fs.realpathSync.native(filePath) !== filePath
    || !sameIdentity(fileIdentity(filePath), expectedIdentity)
  ) {
    throw nativeError('RECOVERY_REQUIRED', 'Migration file path or physical identity changed');
  }
}

function assertCreationParent(context) {
  const parentPath = path.dirname(context.finalPath);
  if (
    typeof context.candidatePath !== 'string'
    || typeof context.finalPath !== 'string'
    || path.resolve(context.candidatePath) !== context.candidatePath
    || path.resolve(context.finalPath) !== context.finalPath
    || path.dirname(context.candidatePath) !== parentPath
    || context.candidatePath === context.finalPath
  ) throw creationRecoveryRequired('Creation database paths escaped their controlled parent');
  let stats;
  let realParent;
  try {
    stats = fs.lstatSync(parentPath, { bigint: true });
    realParent = fs.realpathSync.native(parentPath);
  } catch (cause) {
    throw creationRecoveryRequired('Creation database parent cannot be inspected', cause);
  }
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || String(stats.dev) !== context.finalParentIdentity.dev
    || String(stats.ino) !== context.finalParentIdentity.ino
    || canonicalPhysicalName(realParent) !== canonicalPhysicalName(parentPath)
  ) throw nativeError('MANUSCRIPT_PATH_UNSAFE', 'Creation database parent is unsafe');
  return parentPath;
}

function assertCreationFile(filePath, expectedIdentity, expectedParent) {
  let actualIdentity;
  let realPath;
  try {
    actualIdentity = fileIdentity(filePath);
    realPath = fs.realpathSync.native(filePath);
  } catch (cause) {
    throw creationRecoveryRequired('Creation database file cannot be inspected', cause);
  }
  if (
    typeof filePath !== 'string'
    || path.resolve(filePath) !== filePath
    || path.dirname(filePath) !== expectedParent
    || canonicalPhysicalName(realPath) !== canonicalPhysicalName(filePath)
    || !sameIdentity(actualIdentity, expectedIdentity)
  ) throw creationRecoveryRequired('Creation database file path or physical identity changed');
}

function verifyCreatedDatabase(filePath, context) {
  const parentPath = assertCreationParent(context);
  let database;
  try {
    assertCreationFile(filePath, context.candidateIdentity, parentPath);
    if (sha256File(filePath) !== context.candidateSha256) {
      throw creationRecoveryRequired('Creation database checksum differs from journal binding');
    }
    database = new Database(filePath, { create: false, readonly: true, strict: true });
    const inspected = inspectSchema12Contract(database, {
      expectedFinalSeq: context.finalCommitSeq,
    });
    if (
      inspected.projectInstanceId !== context.projectInstanceId
      || inspected.route !== 'files'
      || inspected.manuscriptProjectUid !== context.projectUid
      || inspected.routeJournal !== context.creationId
      || inspected.projectionGeneration !== context.targetGeneration
    ) throw creationRecoveryRequired('Created schema12 database binding differs from its journal');
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED' || cause?.code === 'MANUSCRIPT_PATH_UNSAFE') throw cause;
    throw creationRecoveryRequired('Created schema12 database cannot be verified', cause);
  } finally {
    if (database !== undefined) {
      try {
        closeSqliteExactly(database);
      } catch (cause) {
        throw creationRecoveryRequired('Created schema12 database close is ambiguous', cause);
      }
    }
  }
}

function pathDisposition(filePath) {
  try {
    fs.lstatSync(filePath);
    return 'present';
  } catch (cause) {
    if (cause?.code === 'ENOENT') return 'absent';
    throw creationRecoveryRequired('Creation database path disposition is unprovable', cause);
  }
}

function installCreatedProjectDatabase(input) {
  if (!exactKeys(input, ['creationCas'])) {
    throw new TypeError('installCreatedProjectDatabase input must contain exact creationCas');
  }
  return consumeCreationRouteCas(input.creationCas, {
    purpose: 'new_creation_install',
    apply({ creationContext: context }) {
      const parentPath = assertCreationParent(context);
      const candidateDisposition = pathDisposition(context.candidatePath);
      const finalDisposition = pathDisposition(context.finalPath);
      if (candidateDisposition === 'present' && finalDisposition === 'absent') {
        verifyCreatedDatabase(context.candidatePath, context);
        try {
          installAbsentFromVerifiedSource(
            context.candidatePath,
            context.finalPath,
            context.candidateIdentity,
            context.candidateSha256,
          );
          fsyncDirectory(parentPath);
        } catch (cause) {
          throw creationRecoveryRequired('Final project database absent-install is ambiguous', cause);
        }
        if (
          pathDisposition(context.candidatePath) !== 'absent'
          || pathDisposition(context.finalPath) !== 'present'
        ) throw creationRecoveryRequired('Final project database install disposition is ambiguous');
        verifyCreatedDatabase(context.finalPath, context);
        return Object.freeze({ disposition: 'after', generation: 1, route: 'files' });
      }
      if (candidateDisposition === 'absent' && finalDisposition === 'present') {
        verifyCreatedDatabase(context.finalPath, context);
        return Object.freeze({ disposition: 'after', generation: 1, route: 'files' });
      }
      throw creationRecoveryRequired('Creation candidate/final disposition is ambiguous');
    },
  });
}

function candidateMeta(database) {
  const rows = database.query(
    "SELECT key, value, typeof(value) AS storageType FROM project_meta WHERE key IN ('durability_commit_seq', 'project_instance_id', 'manuscript_route', 'manuscript_project_uid', 'manuscript_route_journal', 'manuscript_projection_generation') ORDER BY key",
  ).all();
  if (rows.length !== 6 || rows.some((row) => row.storageType !== 'text')) {
    throw nativeError('RECOVERY_REQUIRED', 'Schema12 candidate metadata is incomplete');
  }
  return new Map(rows.map(({ key, value }) => [key, value]));
}

function canonicalCandidateSequence(meta) {
  const raw = meta.get('durability_commit_seq');
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw nativeError('RECOVERY_REQUIRED', 'Schema12 candidate sequence is not canonical');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw nativeError('RECOVERY_REQUIRED', 'Schema12 candidate sequence exceeds the safe range');
  }
  return value;
}

function assertCandidateMeta(meta, context, route, generation) {
  if (
    meta.get('project_instance_id') !== context.projectInstanceId
    || meta.get('manuscript_route') !== route
    || meta.get('manuscript_project_uid') !== context.projectUid
    || meta.get('manuscript_route_journal') !== context.migrationId
    || meta.get('manuscript_projection_generation') !== String(generation)
  ) {
    throw nativeError('RECOVERY_REQUIRED', 'Schema12 candidate route binding is stale or ambiguous');
  }
}

function runCandidate(database, sql, ...params) {
  return database.query(sql).run(...params);
}

function assertCandidateChange(result, label) {
  if (result?.changes !== 1) {
    throw nativeError('RECOVERY_REQUIRED', `${label} did not affect exactly one row`);
  }
}

function controlledIdentityJson(row) {
  return JSON.stringify({
    fileIdentity: row.fileIdentity,
    parentIdentity: row.parentIdentity,
  });
}

function canonicalRevisionDecisionsDigest(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw nativeError('RECOVERY_REQUIRED', 'Revision resolution decisions are malformed', cause);
  }
  const decisions = auxiliaryDecisionMap(parsed, 'revision resolution decisions');
  return createHash('sha256').update(JSON.stringify(decisions), 'utf8').digest('hex');
}

function revisionRequestKey(logicalRequestId) {
  return `_mythpen_revision_request:${createHash('sha256')
    .update(logicalRequestId, 'utf8')
    .digest('hex')}`;
}

function revisionResolutionReceiptValue(resolution) {
  return JSON.stringify({
    version: 1,
    revisionResolution: {
      revisionId: resolution.revisionId,
      chapterId: resolution.chapterId,
      chapterUid: resolution.chapterUid,
      from: resolution.from,
      to: resolution.to,
      baseContentSha256: resolution.baseContentSha256,
      proposedContentSha256: resolution.proposedContentSha256,
      acceptedContentSha256: resolution.acceptedContentSha256,
      decisionsSha256: resolution.decisionsSha256,
      logicalRequestId: resolution.logicalRequestId,
      commandKind: resolution.commandKind,
      commandDigest: resolution.commandDigest,
    },
  });
}

function assertRevisionResolutionBase(database, target) {
  const resolution = target.revisionResolution;
  if (resolution === undefined) return;
  if (database.query('SELECT value FROM project_meta WHERE key = ?').get(
    revisionRequestKey(resolution.logicalRequestId),
  ) !== null) {
    throw nativeError('RECOVERY_REQUIRED', 'Revision logical request is already bound');
  }
  const row = database.query(`
    SELECT r.id, r.chapter_id, r.base_content, r.proposed_content,
           r.decisions_json, r.status, c.chapter_uid, c.content
    FROM chapter_revisions AS r
    JOIN chapters AS c ON c.id = r.chapter_id
    WHERE r.id = ? AND r.chapter_id = ?
  `).get(resolution.revisionId, resolution.chapterId);
  if (
    row === null
    || row === undefined
    || row.status !== 'pending'
    || row.chapter_uid !== resolution.chapterUid
    || createHash('sha256').update(row.base_content, 'utf8').digest('hex')
      !== resolution.baseContentSha256
    || createHash('sha256').update(row.proposed_content, 'utf8').digest('hex')
      !== resolution.proposedContentSha256
    || createHash('sha256').update(row.content ?? '', 'utf8').digest('hex')
      !== resolution.baseContentSha256
    || canonicalRevisionDecisionsDigest(row.decisions_json) !== resolution.decisionsSha256
  ) throw nativeError('RECOVERY_REQUIRED', 'Revision resolution base changed before target DML');
}

function installTargetRows(
  database,
  target,
  context,
  beforeSeq,
  expectedRoute = 'migrating',
  transactionHooks = null,
) {
  let began = false;
  let commitAttempted = false;
  let commitReturned = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    began = true;
    if (expectedRoute === 'files') {
      assertExactSchema12ProjectionBase(database, target, context, beforeSeq);
    }
    assertRevisionResolutionBase(database, target);
    assertCandidateChange(
      runCandidate(database, 'INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)'),
      'Opening schema12 publication gate',
    );

    database.exec('UPDATE volumes SET is_present = 0');
    database.exec('UPDATE chapters SET is_present = 0, volume_id = NULL, chapter_position = NULL, manuscript_position = NULL');

    const activeVolume = database.query(`
      INSERT INTO volumes (
        id, sort_order, title, summary, volume_uid, is_present, deleted_at
      ) VALUES (?, ?, ?, ?, ?, 1, NULL)
      ON CONFLICT(id) DO UPDATE SET
        sort_order = excluded.sort_order,
        title = excluded.title,
        summary = excluded.summary,
        volume_uid = excluded.volume_uid,
        is_present = 1,
        deleted_at = NULL
    `);
    const tombstoneVolume = database.query(`
      UPDATE volumes
      SET volume_uid = ?, is_present = 0, deleted_at = ?
      WHERE id = ?
    `);
    try {
      for (const row of target.volumes) {
        if (row.is_present === 1) {
          activeVolume.run(
            row.id,
            row.sort_order,
            row.title,
            row.summary,
            row.volume_uid,
          );
        } else {
          assertCandidateChange(
            tombstoneVolume.run(row.volume_uid, row.deleted_at, row.id),
            `Tombstoning volume ${row.id}`,
          );
        }
      }
    } finally {
      activeVolume.finalize();
      tombstoneVolume.finalize();
    }

    const activeChapter = database.query(`
      INSERT INTO chapters (
        id, volume_id, num, title, outline, content, summary, word_count, status,
        cognitive_frame, emotional_anchor, world_texture, concrete_mystery,
        interpersonal_tension, chapter_uid, is_present, deleted_at,
        chapter_position, manuscript_position, body_raw_sha256,
        sidecar_raw_sha256, content_available
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        volume_id = excluded.volume_id,
        num = excluded.num,
        title = excluded.title,
        outline = excluded.outline,
        content = excluded.content,
        summary = excluded.summary,
        word_count = excluded.word_count,
        status = excluded.status,
        cognitive_frame = excluded.cognitive_frame,
        emotional_anchor = excluded.emotional_anchor,
        world_texture = excluded.world_texture,
        concrete_mystery = excluded.concrete_mystery,
        interpersonal_tension = excluded.interpersonal_tension,
        chapter_uid = excluded.chapter_uid,
        is_present = 1,
        deleted_at = NULL,
        chapter_position = excluded.chapter_position,
        manuscript_position = excluded.manuscript_position,
        body_raw_sha256 = excluded.body_raw_sha256,
        sidecar_raw_sha256 = excluded.sidecar_raw_sha256,
        content_available = excluded.content_available
    `);
    const tombstoneChapter = database.query(`
      UPDATE chapters
      SET volume_id = NULL,
          num = ?,
          chapter_uid = ?,
          is_present = 0,
          deleted_at = ?,
          data_version = data_version + 1,
          chapter_position = NULL,
          manuscript_position = NULL
      WHERE id = ?
    `);
    try {
      for (const row of target.chapters) {
        if (row.is_present === 1) {
          activeChapter.run(
            row.id,
            row.volume_id,
            row.num,
            row.title,
            row.outline,
            row.content,
            row.summary,
            row.word_count,
            row.status,
            row.cognitive_frame,
            row.emotional_anchor,
            row.world_texture,
            row.concrete_mystery,
            row.interpersonal_tension,
            row.chapter_uid,
            row.chapter_position,
            row.manuscript_position,
            row.body_raw_sha256,
            row.sidecar_raw_sha256,
            row.content_available,
          );
        } else {
          assertCandidateChange(
            tombstoneChapter.run(row.num, row.chapter_uid, row.deleted_at, row.id),
            `Tombstoning chapter ${row.id}`,
          );
        }
      }
    } finally {
      activeChapter.finalize();
      tombstoneChapter.finalize();
    }

    database.exec('DELETE FROM manuscript_controlled_files');
    const insertControlled = database.query(`
      INSERT INTO manuscript_controlled_files (
        file_role, resource_uid, raw_sha256, byte_size,
        file_identity_json, projection_generation
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    try {
      for (const row of target.controlledFiles) {
        insertControlled.run(
          row.role,
          row.resourceUid,
          row.rawSha256,
          row.byteSize,
          controlledIdentityJson(row),
          target.targetGeneration,
        );
      }
    } finally {
      insertControlled.finalize();
    }

    const insertIgnored = database.query(`
      INSERT INTO manuscript_ignored_resources (
        resource_kind, resource_uid, ignore_status, opaque_container_kind,
        opaque_container_uid, is_currently_referenced, member_snapshot_json,
        projection_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_kind, resource_uid) DO UPDATE SET
        ignore_status = excluded.ignore_status,
        opaque_container_kind = excluded.opaque_container_kind,
        opaque_container_uid = excluded.opaque_container_uid,
        is_currently_referenced = excluded.is_currently_referenced,
        member_snapshot_json = excluded.member_snapshot_json,
        projection_generation = excluded.projection_generation
    `);
    try {
      for (const row of target.ignoredLedger) {
        insertIgnored.run(
          row.resource_kind,
          row.resource_uid,
          row.ignore_status,
          row.opaque_container_kind,
          row.opaque_container_uid,
          row.is_currently_referenced,
          row.member_snapshot_json,
          row.projection_generation,
        );
      }
    } finally {
      insertIgnored.finalize();
    }

    database.exec('DELETE FROM manuscript_capacity_snapshot');
    const measurements = target.capacitySnapshot.measurements;
    assertCandidateChange(runCandidate(database, `
      INSERT INTO manuscript_capacity_snapshot (
        singleton_id, chapter_identities, volume_identities, controlled_files,
        chapter_directory_entries, controlled_bytes, projection_generation
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
    `,
    measurements.chapterIdentities,
    measurements.volumeIdentities,
    measurements.controlledFiles,
    measurements.chapterDirectoryEntries,
    measurements.controlledBytes,
    target.targetGeneration), 'Installing schema12 capacity snapshot');

    if (target.revisionResolution !== undefined) {
      const resolution = target.revisionResolution;
      assertCandidateChange(runCandidate(
        database,
        `UPDATE chapter_revisions
         SET status = 'accepted', updated_at = ?, resolved_at = ?
         WHERE id = ? AND chapter_id = ? AND status = 'pending'`,
        target.projectedAt,
        target.projectedAt,
        resolution.revisionId,
        resolution.chapterId,
      ), `Accepting revision ${resolution.revisionId}`);
      assertCandidateChange(runCandidate(
        database,
        'INSERT INTO project_meta (key, value) VALUES (?, ?)',
        revisionRequestKey(resolution.logicalRequestId),
        revisionResolutionReceiptValue(resolution),
      ), `Recording revision resolution ${resolution.revisionId}`);
    }

    for (const invalidation of target.proposalInvalidations) {
      assertCandidateChange(runCandidate(
        database,
        "UPDATE chapter_revisions SET status = 'stale', updated_at = ?, resolved_at = ? WHERE id = ? AND chapter_id = ? AND status = 'pending'",
        target.projectedAt,
        target.projectedAt,
        invalidation.revisionId,
        invalidation.chapterId,
      ), `Invalidating proposal ${invalidation.revisionId}`);
    }

    for (const sequence of target.sqliteSequence) {
      const updated = runCandidate(
        database,
        'UPDATE sqlite_sequence SET seq = ? WHERE name = ?',
        sequence.seq,
        sequence.name,
      );
      if (updated?.changes === 0) {
        assertCandidateChange(
          runCandidate(database, 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', sequence.name, sequence.seq),
          `Installing ${sequence.name} sequence`,
        );
      } else if (updated?.changes !== 1) {
        throw nativeError('RECOVERY_REQUIRED', `${sequence.name} sequence is ambiguous`);
      }
    }

    assertCandidateChange(runCandidate(
      database,
      "UPDATE project_meta SET value = ? WHERE key = 'manuscript_projection_generation' AND value = ?",
      String(context.targetGeneration),
      String(context.baseGeneration),
    ), 'Advancing manuscript projection generation');
    assertCandidateChange(runCandidate(
      database,
      "UPDATE project_meta SET value = 'files' WHERE key = 'manuscript_route' AND value = ?",
      expectedRoute,
    ), 'Switching candidate route');
    assertCandidateChange(runCandidate(
      database,
      "UPDATE project_meta SET value = ? WHERE key = 'durability_commit_seq' AND value = ?",
      String(beforeSeq + 1),
      String(beforeSeq),
    ), 'Advancing schema12 durability sequence');
    assertCandidateChange(
      runCandidate(database, 'DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1'),
      'Closing schema12 publication gate',
    );
    assertCandidateProjection(database, target, context, beforeSeq + 1);
    transactionHooks?.beforeCommit?.();
    commitAttempted = true;
    database.exec('COMMIT');
    commitReturned = true;
    began = false;
    transactionHooks?.afterCommit?.();
  } catch (error) {
    if (!commitReturned && (began || database.inTransaction)) {
      try { database.exec('ROLLBACK'); } catch (rollbackError) {
        throw nativeError('RECOVERY_REQUIRED', 'Schema12 candidate rollback is uncertain', rollbackError);
      }
      markKnownRolledBackTargetInstall(error);
    } else if (!commitAttempted) {
      markKnownRolledBackTargetInstall(error);
    }
    throw error;
  }
}

const AUXILIARY_ACTION_KINDS = new Set([
  'revision.create',
  'revision.update_decisions',
  'revision.reject',
  'revision.mark_stale',
  'revision.finalize_noop',
]);
const REVISION_DECISIONS = new Set(['accepted', 'rejected']);
const REVISION_STATUSES = new Set([
  'pending',
  'accepted',
  'rejected',
  'superseded',
  'stale',
]);
const AUXILIARY_RESULT_STATES = new Set([
  'accepted',
  'conflict',
  'created',
  'rejected',
  'stale',
  'unchanged',
  'updated',
]);

function positiveAuxiliaryInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function auxiliaryText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function auxiliaryStableUid(value, label) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function auxiliaryTimestamp(value) {
  if (
    typeof value !== 'string'
    || !ISO_MILLISECOND_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError('auxiliary projectedAt must be a canonical UTC millisecond timestamp');
  return value;
}

function auxiliaryLogicalRequestId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError('auxiliary logicalRequestId must be a non-empty bounded string');
  }
  return value;
}

function auxiliaryDecisionMap(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || key.length === 0)) {
    throw new TypeError(`${label} keys must be non-empty strings`);
  }
  const result = {};
  for (const key of keys.sort((left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  ))) {
    const descriptor = descriptors[key];
    if (
      descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || !REVISION_DECISIONS.has(descriptor.value)
    ) throw new TypeError(`${label} must contain own enumerable revision decisions`);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function snapshotAuxiliaryAction(value) {
  if (!isPlainObject(value)) throw new TypeError('auxiliary action must be a plain object');
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    kindDescriptor === undefined
    || kindDescriptor.enumerable !== true
    || !Object.hasOwn(kindDescriptor, 'value')
    || !AUXILIARY_ACTION_KINDS.has(kindDescriptor.value)
  ) throw new TypeError('auxiliary action kind is unsupported');
  const kind = kindDescriptor.value;
  if (kind === 'revision.create') {
    const input = exactDataValues(
      value,
      ['kind', 'chapterUid', 'baseContent', 'proposedContent'],
      'revision.create auxiliary action',
    );
    return Object.freeze({
      kind,
      chapterUid: auxiliaryStableUid(input.chapterUid, 'revision.create chapterUid'),
      baseContent: auxiliaryText(input.baseContent, 'revision.create baseContent'),
      proposedContent: auxiliaryText(input.proposedContent, 'revision.create proposedContent'),
    });
  }
  if (kind === 'revision.update_decisions') {
    const input = exactDataValues(
      value,
      ['kind', 'revisionId', 'expectedBaseContent', 'decisions'],
      'revision.update_decisions auxiliary action',
    );
    return Object.freeze({
      kind,
      revisionId: positiveAuxiliaryInteger(input.revisionId, 'revision.update_decisions revisionId'),
      expectedBaseContent: auxiliaryText(
        input.expectedBaseContent,
        'revision.update_decisions expectedBaseContent',
      ),
      decisions: auxiliaryDecisionMap(input.decisions, 'revision.update_decisions decisions'),
    });
  }
  if (kind === 'revision.mark_stale') {
    const input = exactDataValues(
      value,
      ['kind', 'revisionId'],
      'revision.mark_stale auxiliary action',
    );
    return Object.freeze({
      kind,
      revisionId: positiveAuxiliaryInteger(input.revisionId, 'revision.mark_stale revisionId'),
    });
  }
  if (kind === 'revision.finalize_noop') {
    const input = exactDataValues(
      value,
      ['kind', 'revisionId', 'content', 'expectedBaseContent', 'expectedDecisions'],
      'revision.finalize_noop auxiliary action',
    );
    return Object.freeze({
      kind,
      revisionId: positiveAuxiliaryInteger(input.revisionId, 'revision.finalize_noop revisionId'),
      content: auxiliaryText(input.content, 'revision.finalize_noop content'),
      expectedBaseContent: auxiliaryText(
        input.expectedBaseContent,
        'revision.finalize_noop expectedBaseContent',
      ),
      expectedDecisions: auxiliaryDecisionMap(
        input.expectedDecisions,
        'revision.finalize_noop expectedDecisions',
      ),
    });
  }
  const input = exactDataValues(
    value,
    ['kind', 'revisionId', 'expectedBaseContent'],
    'revision.reject auxiliary action',
  );
  return Object.freeze({
    kind,
    revisionId: positiveAuxiliaryInteger(input.revisionId, 'revision.reject revisionId'),
    expectedBaseContent: auxiliaryText(
      input.expectedBaseContent,
      'revision.reject expectedBaseContent',
    ),
  });
}

function snapshotAuxiliaryInput(value) {
  const input = exactDataValues(
    value,
    ['action', 'currentProjection', 'logicalRequestId', 'projectedAt'],
    'applyAuxiliaryAction input',
  );
  const projectionStore = new SQLiteProjectionStore();
  projectionStore.validateCurrentProjection(input.currentProjection);
  return Object.freeze({
    action: snapshotAuxiliaryAction(input.action),
    currentProjection: input.currentProjection,
    logicalRequestId: auxiliaryLogicalRequestId(input.logicalRequestId),
    projectedAt: auxiliaryTimestamp(input.projectedAt),
  });
}

function parseRevisionDecisionJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw nativeError('RECOVERY_REQUIRED', 'Revision decisions JSON is malformed', cause);
  }
  try {
    return auxiliaryDecisionMap(parsed, 'stored revision decisions');
  } catch (cause) {
    throw nativeError('RECOVERY_REQUIRED', 'Stored revision decisions are invalid', cause);
  }
}

function serializeAuxiliaryRevision(row) {
  if (row === null || row === undefined) return null;
  if (
    !positiveAuxiliaryInteger(row.id, 'stored revision id')
    || !positiveAuxiliaryInteger(row.chapter_id, 'stored revision chapter id')
    || typeof row.base_content !== 'string'
    || typeof row.proposed_content !== 'string'
    || !REVISION_STATUSES.has(row.status)
    || typeof row.created_at !== 'string'
    || typeof row.updated_at !== 'string'
    || !(row.resolved_at === null || typeof row.resolved_at === 'string')
    || !(row.previous_chapter_status === null || typeof row.previous_chapter_status === 'string')
  ) throw nativeError('RECOVERY_REQUIRED', 'Stored revision row is invalid');
  return Object.freeze({
    id: row.id,
    chapterId: row.chapter_id,
    chapterUid: auxiliaryStableUid(row.chapter_uid, 'stored revision chapter uid'),
    baseContent: row.base_content,
    proposedContent: row.proposed_content,
    decisions: parseRevisionDecisionJson(row.decisions_json),
    status: row.status,
    previousChapterStatus: row.previous_chapter_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  });
}

function auxiliaryRevisionRow(database, revisionId) {
  return database.query(`
    SELECT r.id, r.chapter_id, c.chapter_uid, r.base_content, r.proposed_content,
           r.decisions_json, r.status, r.previous_chapter_status, r.created_at,
           r.updated_at, r.resolved_at
    FROM chapter_revisions AS r
    JOIN chapters AS c ON c.id = r.chapter_id
    WHERE r.id = ?
  `).get(revisionId) ?? null;
}

function auxiliaryActionDigest(projectUid, projectInstanceId, action) {
  return createHash('sha256').update(JSON.stringify({
    domain: 'mythpen.native.auxiliary-action',
    version: 1,
    projectUid,
    projectInstanceId,
    action,
  }), 'utf8').digest('hex');
}

function validateStoredAuxiliaryResult(value) {
  if (!isPlainObject(value)) throw nativeError('RECOVERY_REQUIRED', 'Auxiliary result is malformed');
  if (
    (value.disposition !== 'after' && value.disposition !== 'before')
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || !AUXILIARY_RESULT_STATES.has(value.state)
  ) throw nativeError('RECOVERY_REQUIRED', 'Auxiliary result disposition is invalid');
  return deepFreeze(value);
}

function readAuxiliaryReceipt(database, requestKey, expectedDigest) {
  const row = database.query('SELECT value FROM project_meta WHERE key = ?').get(requestKey);
  if (row === null || row === undefined) return null;
  let receipt;
  try {
    receipt = JSON.parse(row.value);
  } catch (cause) {
    throw nativeError('RECOVERY_REQUIRED', 'Auxiliary request receipt is malformed', cause);
  }
  if (!exactKeys(receipt, ['version', 'inputDigest', 'result']) || receipt.version !== 1) {
    throw nativeError('RECOVERY_REQUIRED', 'Auxiliary request receipt shape is invalid');
  }
  if (receipt.inputDigest !== expectedDigest) {
    throw nativeError('RECOVERY_REQUIRED', 'Auxiliary logical request was rebound');
  }
  return validateStoredAuxiliaryResult(receipt.result);
}

function auxiliaryConflict(generation, reason, revision = null) {
  return Object.freeze({
    disposition: 'before',
    generation,
    state: 'conflict',
    reason,
    revision,
  });
}

function auxiliaryAfter(generation, state, revision = null) {
  return Object.freeze({
    disposition: 'after',
    generation,
    state,
    revision,
  });
}

function auxiliaryBasisChapter(currentProjection, chapterIdentity) {
  return currentProjection.basis.chapters.find((row) => (
    (typeof chapterIdentity === 'string'
      ? row.uid === chapterIdentity
      : row.id === chapterIdentity)
    && row.isPresent === 1
  )) ?? null;
}

function currentAuxiliaryChapter(database, currentProjection, chapterIdentity) {
  const basis = auxiliaryBasisChapter(currentProjection, chapterIdentity);
  if (basis === null) return null;
  const row = database.query(`
    SELECT id, content, status, word_count, data_version, body_raw_sha256
    FROM chapters WHERE id = ? AND is_present = 1
  `).get(basis.id);
  if (
    row === null
    || row === undefined
    || row.status !== basis.status
    || row.body_raw_sha256 !== basis.bodyRawSha256
    || createHash('sha256').update(row.content ?? '', 'utf8').digest('hex') !== basis.bodyRawSha256
  ) throw nativeError('RECOVERY_REQUIRED', 'Auxiliary chapter differs from the exact projection basis');
  return row;
}

function applyRevisionCreateAction(database, action, input) {
  const generation = input.currentProjection.basis.baseGeneration;
  const chapter = currentAuxiliaryChapter(database, input.currentProjection, action.chapterUid);
  if (chapter === null) return auxiliaryConflict(generation, 'chapter_missing');
  if ((chapter.content ?? '') === action.proposedContent) {
    return auxiliaryAfter(generation, 'unchanged');
  }
  const baseMatches = (chapter.content ?? '') === action.baseContent;
  if (baseMatches) {
    database.query(`
      UPDATE chapter_revisions
      SET status = 'superseded', updated_at = ?, resolved_at = ?
      WHERE chapter_id = ? AND status = 'pending'
    `).run(input.projectedAt, input.projectedAt, chapter.id);
  }
  const status = baseMatches ? 'pending' : 'stale';
  const inserted = database.query(`
    INSERT INTO chapter_revisions (
      chapter_id, base_content, proposed_content, decisions_json, status,
      previous_chapter_status, created_at, updated_at, resolved_at
    ) VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?)
  `).run(
    chapter.id,
    action.baseContent,
    action.proposedContent,
    status,
    chapter.status,
    input.projectedAt,
    input.projectedAt,
    status === 'stale' ? input.projectedAt : null,
  );
  const revisionId = Number(inserted.lastInsertRowid);
  positiveAuxiliaryInteger(revisionId, 'inserted revision id');
  return auxiliaryAfter(
    generation,
    status === 'stale' ? 'stale' : 'created',
    serializeAuxiliaryRevision(auxiliaryRevisionRow(database, revisionId)),
  );
}

function requirePendingAuxiliaryRevision(database, currentProjection, action) {
  const row = auxiliaryRevisionRow(database, action.revisionId);
  const revision = serializeAuxiliaryRevision(row);
  if (row === null) return { outcome: auxiliaryConflict(
    currentProjection.basis.baseGeneration,
    'revision_missing',
  ) };
  if (row.status !== 'pending') return { outcome: auxiliaryConflict(
    currentProjection.basis.baseGeneration,
    `revision_${row.status}`,
    revision,
  ) };
  if (!currentProjection.basis.pendingProposals.some((proposal) => (
    proposal.revisionId === row.id && proposal.chapterId === row.chapter_id
  ))) throw nativeError('RECOVERY_REQUIRED', 'Pending revision is absent from the exact projection basis');
  const chapter = currentAuxiliaryChapter(database, currentProjection, row.chapter_id);
  if (chapter === null) throw nativeError('RECOVERY_REQUIRED', 'Pending revision chapter is not active');
  const currentContent = chapter.content ?? '';
  if (row.base_content !== currentContent) {
    return { chapter, revision, row, stale: true };
  }
  if (action.expectedBaseContent !== row.base_content) {
    return { outcome: auxiliaryConflict(
      currentProjection.basis.baseGeneration,
      'expected_base_mismatch',
      revision,
    ) };
  }
  return { chapter, revision, row, stale: false };
}

function markAuxiliaryRevisionStale(database, row, input) {
  assertCandidateChange(runCandidate(
    database,
    `UPDATE chapter_revisions
     SET status = 'stale', updated_at = ?, resolved_at = ?
     WHERE id = ? AND chapter_id = ? AND status = 'pending'`,
    input.projectedAt,
    input.projectedAt,
    row.id,
    row.chapter_id,
  ), `Marking revision ${row.id} stale`);
  return auxiliaryAfter(
    input.currentProjection.basis.baseGeneration,
    'stale',
    serializeAuxiliaryRevision(auxiliaryRevisionRow(database, row.id)),
  );
}

function applyRevisionUpdateAction(database, action, input) {
  const pending = requirePendingAuxiliaryRevision(database, input.currentProjection, action);
  if (pending.outcome !== undefined) return pending.outcome;
  if (pending.stale) return markAuxiliaryRevisionStale(database, pending.row, input);
  const merged = auxiliaryDecisionMap({
    ...pending.revision.decisions,
    ...action.decisions,
  }, 'merged revision decisions');
  assertCandidateChange(runCandidate(
    database,
    `UPDATE chapter_revisions SET decisions_json = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
    JSON.stringify(merged),
    input.projectedAt,
    pending.row.id,
  ), `Updating revision ${pending.row.id} decisions`);
  return auxiliaryAfter(
    input.currentProjection.basis.baseGeneration,
    'updated',
    serializeAuxiliaryRevision(auxiliaryRevisionRow(database, pending.row.id)),
  );
}

function applyRevisionRejectAction(database, action, input) {
  const pending = requirePendingAuxiliaryRevision(database, input.currentProjection, action);
  if (pending.outcome !== undefined) return pending.outcome;
  if (pending.stale) return markAuxiliaryRevisionStale(database, pending.row, input);
  assertCandidateChange(runCandidate(
    database,
    `UPDATE chapter_revisions
     SET status = 'rejected', updated_at = ?, resolved_at = ?
     WHERE id = ? AND status = 'pending'`,
    input.projectedAt,
    input.projectedAt,
    pending.row.id,
  ), `Rejecting revision ${pending.row.id}`);
  return Object.freeze({
    disposition: 'after',
    generation: input.currentProjection.basis.baseGeneration,
    state: 'rejected',
    revision: serializeAuxiliaryRevision(auxiliaryRevisionRow(database, pending.row.id)),
    chapter: Object.freeze({
      id: pending.chapter.id,
      content: pending.chapter.content ?? '',
      wordCount: Number.isSafeInteger(pending.chapter.word_count)
        ? pending.chapter.word_count
        : 0,
      status: pending.chapter.status,
      dataVersion: Number.isSafeInteger(pending.chapter.data_version)
        ? pending.chapter.data_version
        : 0,
    }),
  });
}

function applyRevisionMarkStaleAction(database, action, input) {
  const row = auxiliaryRevisionRow(database, action.revisionId);
  if (row === null) return auxiliaryConflict(
    input.currentProjection.basis.baseGeneration,
    'revision_missing',
  );
  const revision = serializeAuxiliaryRevision(row);
  if (row.status !== 'pending') return auxiliaryConflict(
    input.currentProjection.basis.baseGeneration,
    `revision_${row.status}`,
    revision,
  );
  if (!input.currentProjection.basis.pendingProposals.some((proposal) => (
    proposal.revisionId === row.id && proposal.chapterId === row.chapter_id
  ))) throw nativeError('RECOVERY_REQUIRED', 'Pending stale revision is absent from the exact basis');
  const chapter = currentAuxiliaryChapter(database, input.currentProjection, row.chapter_id);
  if (chapter === null) throw nativeError('RECOVERY_REQUIRED', 'Pending stale revision chapter is inactive');
  if (row.base_content === (chapter.content ?? '')) return auxiliaryConflict(
    input.currentProjection.basis.baseGeneration,
    'revision_not_stale',
    revision,
  );
  return markAuxiliaryRevisionStale(database, row, input);
}

function applyRevisionFinalizeNoopAction(database, action, input) {
  const pending = requirePendingAuxiliaryRevision(database, input.currentProjection, action);
  if (pending.outcome !== undefined) return pending.outcome;
  if (pending.stale) return markAuxiliaryRevisionStale(database, pending.row, input);
  if (!isDeepStrictEqual(action.expectedDecisions, pending.revision.decisions)) {
    return auxiliaryConflict(
      input.currentProjection.basis.baseGeneration,
      'expected_decisions_mismatch',
      pending.revision,
    );
  }
  const currentContent = pending.chapter.content ?? '';
  const basisChapter = auxiliaryBasisChapter(
    input.currentProjection,
    pending.row.chapter_id,
  );
  if (
    basisChapter === null
    || pending.chapter.status !== 'accepted'
    || action.content !== currentContent
    || action.content !== pending.row.base_content
    || basisChapter.status !== 'accepted'
    || basisChapter.bodyRawSha256
      !== createHash('sha256').update(action.content, 'utf8').digest('hex')
  ) return auxiliaryConflict(
    input.currentProjection.basis.baseGeneration,
    'revision_finalize_not_noop',
    pending.revision,
  );
  assertCandidateChange(runCandidate(
    database,
    `UPDATE chapter_revisions
     SET status = 'accepted', updated_at = ?, resolved_at = ?
     WHERE id = ? AND chapter_id = ? AND status = 'pending'`,
    input.projectedAt,
    input.projectedAt,
    pending.row.id,
    pending.row.chapter_id,
  ), `Accepting no-op revision ${pending.row.id}`);
  return Object.freeze({
    disposition: 'after',
    generation: input.currentProjection.basis.baseGeneration,
    state: 'accepted',
    revision: serializeAuxiliaryRevision(auxiliaryRevisionRow(database, pending.row.id)),
    chapter: Object.freeze({
      id: pending.chapter.id,
      chapterUid: pending.revision.chapterUid,
      content: currentContent,
      wordCount: Number.isSafeInteger(pending.chapter.word_count)
        ? pending.chapter.word_count
        : 0,
      status: pending.chapter.status,
      dataVersion: Number.isSafeInteger(pending.chapter.data_version)
        ? pending.chapter.data_version
        : 0,
    }),
  });
}

function applyAuxiliaryActionRows(database, input) {
  if (input.action.kind === 'revision.create') {
    return applyRevisionCreateAction(database, input.action, input);
  }
  if (input.action.kind === 'revision.update_decisions') {
    return applyRevisionUpdateAction(database, input.action, input);
  }
  if (input.action.kind === 'revision.reject') {
    return applyRevisionRejectAction(database, input.action, input);
  }
  if (input.action.kind === 'revision.mark_stale') {
    return applyRevisionMarkStaleAction(database, input.action, input);
  }
  if (input.action.kind === 'revision.finalize_noop') {
    return applyRevisionFinalizeNoopAction(database, input.action, input);
  }
  throw new TypeError('auxiliary action kind is unsupported');
}

function installAuxiliaryAction(
  database,
  input,
  context,
  beforeSeq,
  requestKey,
  inputDigest,
  transactionHooks = null,
) {
  let began = false;
  let commitAttempted = false;
  let commitReturned = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    began = true;
    const live = captureSchema12ProjectionBase(database, context.baseGeneration);
    const meta = candidateMeta(database);
    if (
      canonicalCandidateSequence(meta) !== beforeSeq
      || meta.get('manuscript_route') !== 'files'
      || meta.get('manuscript_project_uid') !== context.projectUid
      || meta.get('project_instance_id') !== context.projectInstanceId
      || meta.get('manuscript_projection_generation') !== String(context.baseGeneration)
      || live.ignoredLedger.some((row) => row.projection_generation !== context.baseGeneration)
      || !isDeepStrictEqual(live.basis, input.currentProjection.basis)
    ) throw nativeError('RECOVERY_REQUIRED', 'Auxiliary projection base changed before action DML');
    assertCandidateChange(
      runCandidate(database, 'INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)'),
      'Opening auxiliary write gate',
    );
    const result = applyAuxiliaryActionRows(database, input);
    const receipt = JSON.stringify({ version: 1, inputDigest, result });
    assertCandidateChange(runCandidate(
      database,
      'INSERT INTO project_meta (key, value) VALUES (?, ?)',
      requestKey,
      receipt,
    ), 'Recording auxiliary request receipt');
    assertCandidateChange(runCandidate(
      database,
      "UPDATE project_meta SET value = ? WHERE key = 'durability_commit_seq' AND value = ?",
      String(beforeSeq + 1),
      String(beforeSeq),
    ), 'Advancing auxiliary durability sequence');
    assertCandidateChange(
      runCandidate(database, 'DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1'),
      'Closing auxiliary write gate',
    );
    const stored = readAuxiliaryReceipt(database, requestKey, inputDigest);
    if (!isDeepStrictEqual(stored, result)) {
      throw nativeError('RECOVERY_REQUIRED', 'Auxiliary request receipt changed before commit');
    }
    transactionHooks?.beforeCommit?.();
    commitAttempted = true;
    database.exec('COMMIT');
    commitReturned = true;
    began = false;
    transactionHooks?.afterCommit?.();
    return result;
  } catch (error) {
    if (!commitReturned && (began || database.inTransaction)) {
      try { database.exec('ROLLBACK'); } catch (rollbackError) {
        throw nativeError('RECOVERY_REQUIRED', 'Auxiliary action rollback is uncertain', rollbackError);
      }
      markKnownRolledBackAuxiliaryAction(error);
    } else if (!commitAttempted) {
      markKnownRolledBackAuxiliaryAction(error);
    }
    throw error;
  }
}

function comparableVolume(row) {
  return row.is_present === 1
    ? {
      id: row.id,
      sort_order: row.sort_order,
      title: row.title,
      summary: row.summary,
      volume_uid: row.volume_uid,
      is_present: row.is_present,
      deleted_at: row.deleted_at,
    }
    : {
      id: row.id,
      volume_uid: row.volume_uid,
      is_present: row.is_present,
      deleted_at: row.deleted_at,
    };
}

function comparableChapter(row) {
  return row.is_present === 1
    ? {
      id: row.id,
      volume_id: row.volume_id,
      num: row.num,
      title: row.title,
      outline: row.outline,
      content: row.content,
      summary: row.summary,
      word_count: row.word_count,
      status: row.status,
      cognitive_frame: row.cognitive_frame,
      emotional_anchor: row.emotional_anchor,
      world_texture: row.world_texture,
      concrete_mystery: row.concrete_mystery,
      interpersonal_tension: row.interpersonal_tension,
      chapter_uid: row.chapter_uid,
      is_present: row.is_present,
      deleted_at: row.deleted_at,
      chapter_position: row.chapter_position,
      manuscript_position: row.manuscript_position,
      body_raw_sha256: row.body_raw_sha256,
      sidecar_raw_sha256: row.sidecar_raw_sha256,
      content_available: row.content_available,
    }
    : {
      id: row.id,
      num: row.num,
      chapter_uid: row.chapter_uid,
      is_present: row.is_present,
      deleted_at: row.deleted_at,
      chapter_position: row.chapter_position,
      manuscript_position: row.manuscript_position,
    };
}

function assertJsonEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw nativeError('RECOVERY_REQUIRED', `${label} differs from the projection target`);
  }
}

function captureSchema12ProjectionBase(database, generation) {
  const volumes = database.query(`
    SELECT id, volume_uid, sort_order, is_present, deleted_at
    FROM volumes ORDER BY id
  `).all().map((row) => ({
    id: row.id,
    uid: row.volume_uid,
    sortOrder: row.sort_order,
    isPresent: row.is_present,
    deletedAt: row.deleted_at,
  }));
  const chapters = database.query(`
    SELECT id, chapter_uid, volume_id, num, is_present, deleted_at,
           chapter_position, manuscript_position, body_raw_sha256, status
    FROM chapters ORDER BY id
  `).all().map((row) => ({
    id: row.id,
    uid: row.chapter_uid,
    volumeId: row.volume_id,
    num: row.num,
    isPresent: row.is_present,
    deletedAt: row.deleted_at,
    chapterPosition: row.chapter_position,
    manuscriptPosition: row.manuscript_position,
    bodyRawSha256: row.body_raw_sha256,
    status: row.status,
  }));
  const sqliteSequence = database.query(`
    SELECT name, seq FROM sqlite_sequence
    WHERE name IN ('chapters', 'volumes') ORDER BY name
  `).all().map((row) => ({ name: row.name, seq: row.seq }));
  for (const name of ['chapters', 'volumes']) {
    if (!sqliteSequence.some((row) => row.name === name)) {
      sqliteSequence.push({ name, seq: 0 });
    }
  }
  sqliteSequence.sort((left, right) => Buffer.compare(
    Buffer.from(left.name, 'utf8'),
    Buffer.from(right.name, 'utf8'),
  ));
  const ignoredLedger = database.query(`
    SELECT resource_kind, resource_uid, ignore_status, opaque_container_kind,
           opaque_container_uid, is_currently_referenced, member_snapshot_json,
           projection_generation
    FROM manuscript_ignored_resources ORDER BY resource_kind, resource_uid
  `).all();
  const pendingProposals = database.query(`
    SELECT id AS revisionId, chapter_id AS chapterId
    FROM chapter_revisions WHERE status = 'pending' ORDER BY id
  `).all();
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: generation,
    volumes,
    chapters,
    sqliteSequence,
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(ignoredLedger),
    pendingProposals,
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return { basis, ignoredLedger };
}

function exactSchema12ProjectionBase(database, target, context, expectedFinalSeq) {
  const meta = candidateMeta(database);
  const finalSeq = canonicalCandidateSequence(meta);
  if (finalSeq !== expectedFinalSeq) return null;
  inspectSchema12Contract(database, { expectedFinalSeq: finalSeq });
  assertCandidateMeta(meta, context, 'files', context.baseGeneration);
  const live = captureSchema12ProjectionBase(database, context.baseGeneration);
  if (
    live.ignoredLedger.some((row) => row.projection_generation !== context.baseGeneration)
    || !isDeepStrictEqual(live.basis.volumes, target.basis.volumes)
    || !isDeepStrictEqual(live.basis.chapters, target.basis.chapters)
    || !isDeepStrictEqual(live.basis.sqliteSequence, target.basis.sqliteSequence)
    || !isDeepStrictEqual(live.basis.pendingProposals, target.basis.pendingProposals)
    || live.basis.ignoredBeforeDigest !== target.basis.ignoredBeforeDigest
    || live.basis.basisDigest !== target.basisDigest
  ) return null;
  return live;
}

function assertExactSchema12ProjectionBase(database, target, context, expectedFinalSeq) {
  const live = exactSchema12ProjectionBase(
    database,
    target,
    context,
    expectedFinalSeq,
  );
  if (live === null) {
    throw nativeError('RECOVERY_REQUIRED', 'Schema12 projection base changed before publication');
  }
  return live;
}

function schema12DesiredProjectionMatches(database, target, generation) {
  const volumes = database.query(`
    SELECT id, sort_order, title, summary, volume_uid, is_present, deleted_at
    FROM volumes ORDER BY id
  `).all().map(comparableVolume);
  const chapters = database.query(`
    SELECT id, volume_id, num, title, outline, content, summary, word_count,
           status, cognitive_frame, emotional_anchor, world_texture,
           concrete_mystery, interpersonal_tension, chapter_uid, is_present,
           deleted_at, chapter_position, manuscript_position, body_raw_sha256,
           sidecar_raw_sha256, content_available
    FROM chapters ORDER BY id
  `).all().map(comparableChapter);
  const controlled = database.query(`
    SELECT file_role, resource_uid, raw_sha256, byte_size,
           file_identity_json, projection_generation
    FROM manuscript_controlled_files
    ORDER BY file_role, COALESCE(resource_uid, '')
  `).all();
  const expectedControlled = target.controlledFiles.map((row) => ({
    file_role: row.role,
    resource_uid: row.resourceUid,
    raw_sha256: row.rawSha256,
    byte_size: row.byteSize,
    file_identity_json: controlledIdentityJson(row),
    projection_generation: generation,
  })).sort((left, right) => (
    left.file_role.localeCompare(right.file_role, 'en')
    || String(left.resource_uid ?? '').localeCompare(String(right.resource_uid ?? ''), 'en')
  ));
  const ignored = database.query(`
    SELECT resource_kind, resource_uid, ignore_status, opaque_container_kind,
           opaque_container_uid, is_currently_referenced, member_snapshot_json,
           projection_generation
    FROM manuscript_ignored_resources ORDER BY resource_kind, resource_uid
  `).all();
  const expectedIgnored = target.ignoredLedger.map((row) => ({
    ...row,
    projection_generation: generation,
  }));
  const measurements = target.capacitySnapshot.measurements;
  const capacity = database.query(`
    SELECT singleton_id, chapter_identities, volume_identities, controlled_files,
           chapter_directory_entries, controlled_bytes, projection_generation
    FROM manuscript_capacity_snapshot
  `).get();
  const sequences = database.query(
    "SELECT name, seq FROM sqlite_sequence WHERE name IN ('chapters', 'volumes') ORDER BY name",
  ).all();
  return target.proposalInvalidations.length === 0
    && isDeepStrictEqual(volumes, target.volumes.map(comparableVolume))
    && isDeepStrictEqual(chapters, target.chapters.map(comparableChapter))
    && isDeepStrictEqual(controlled, expectedControlled)
    && isDeepStrictEqual(ignored, expectedIgnored)
    && isDeepStrictEqual(capacity, {
      singleton_id: 1,
      chapter_identities: measurements.chapterIdentities,
      volume_identities: measurements.volumeIdentities,
      controlled_files: measurements.controlledFiles,
      chapter_directory_entries: measurements.chapterDirectoryEntries,
      controlled_bytes: measurements.controlledBytes,
      projection_generation: generation,
    })
    && isDeepStrictEqual(sequences, target.sqliteSequence);
}

function assertCandidateProjection(database, target, context, expectedFinalSeq) {
  inspectSchema12Contract(database, { expectedFinalSeq });
  const meta = candidateMeta(database);
  assertCandidateMeta(meta, context, 'files', context.targetGeneration);
  const volumes = database.query(`
    SELECT id, sort_order, title, summary, volume_uid, is_present, deleted_at
    FROM volumes ORDER BY id
  `).all().map(comparableVolume);
  const chapters = database.query(`
    SELECT id, volume_id, num, title, outline, content, summary, word_count,
           status, cognitive_frame, emotional_anchor, world_texture,
           concrete_mystery, interpersonal_tension, chapter_uid, is_present,
           deleted_at, chapter_position, manuscript_position, body_raw_sha256,
           sidecar_raw_sha256, content_available
    FROM chapters ORDER BY id
  `).all().map(comparableChapter);
  assertJsonEqual(volumes, target.volumes.map(comparableVolume), 'Schema12 volumes');
  assertJsonEqual(chapters, target.chapters.map(comparableChapter), 'Schema12 chapters');

  const controlled = database.query(`
    SELECT file_role, resource_uid, raw_sha256, byte_size,
           file_identity_json, projection_generation
    FROM manuscript_controlled_files
    ORDER BY file_role, COALESCE(resource_uid, '')
  `).all();
  const expectedControlled = target.controlledFiles.map((row) => ({
    file_role: row.role,
    resource_uid: row.resourceUid,
    raw_sha256: row.rawSha256,
    byte_size: row.byteSize,
    file_identity_json: controlledIdentityJson(row),
    projection_generation: target.targetGeneration,
  })).sort((left, right) => (
    left.file_role.localeCompare(right.file_role, 'en')
    || String(left.resource_uid ?? '').localeCompare(String(right.resource_uid ?? ''), 'en')
  ));
  assertJsonEqual(controlled, expectedControlled, 'Schema12 controlled files');

  const ignored = database.query(`
    SELECT resource_kind, resource_uid, ignore_status, opaque_container_kind,
           opaque_container_uid, is_currently_referenced, member_snapshot_json,
           projection_generation
    FROM manuscript_ignored_resources ORDER BY resource_kind, resource_uid
  `).all();
  assertJsonEqual(ignored, target.ignoredLedger, 'Schema12 ignored ledger');

  const measurements = target.capacitySnapshot.measurements;
  const capacity = database.query(`
    SELECT singleton_id, chapter_identities, volume_identities, controlled_files,
           chapter_directory_entries, controlled_bytes, projection_generation
    FROM manuscript_capacity_snapshot
  `).get();
  assertJsonEqual(capacity, {
    singleton_id: 1,
    chapter_identities: measurements.chapterIdentities,
    volume_identities: measurements.volumeIdentities,
    controlled_files: measurements.controlledFiles,
    chapter_directory_entries: measurements.chapterDirectoryEntries,
    controlled_bytes: measurements.controlledBytes,
    projection_generation: target.targetGeneration,
  }, 'Schema12 capacity snapshot');
  for (const invalidation of target.proposalInvalidations) {
    const status = database.query(
      'SELECT status FROM chapter_revisions WHERE id = ? AND chapter_id = ?',
    ).get(invalidation.revisionId, invalidation.chapterId)?.status;
    if (status !== 'stale') {
      throw nativeError('RECOVERY_REQUIRED', 'Schema12 proposal invalidation is missing');
    }
  }
  if (target.revisionResolution !== undefined) {
    const resolution = target.revisionResolution;
    const status = database.query(
      'SELECT status FROM chapter_revisions WHERE id = ? AND chapter_id = ?',
    ).get(resolution.revisionId, resolution.chapterId)?.status;
    if (status !== 'accepted') {
      throw nativeError('RECOVERY_REQUIRED', 'Schema12 revision resolution is missing');
    }
    const receipt = database.query(
      'SELECT value FROM project_meta WHERE key = ?',
    ).get(revisionRequestKey(resolution.logicalRequestId))?.value;
    if (receipt !== revisionResolutionReceiptValue(resolution)) {
      throw nativeError('RECOVERY_REQUIRED', 'Schema12 revision resolution receipt is missing');
    }
  }
  const sequences = database.query(
    "SELECT name, seq FROM sqlite_sequence WHERE name IN ('chapters', 'volumes') ORDER BY name",
  ).all();
  assertJsonEqual(sequences, target.sqliteSequence, 'Schema12 sqlite_sequence');
  return meta;
}

function createNativeProjectStoreCore(options = {}) {
  const {
    databasePath,
    controlStore,
    dbKey,
    projectInstanceIdSha256,
    ownershipHash,
    assertWriterLease,
    admissionVerifier,
    identityApi = createDatabaseIdentityGuard,
    sqliteFactory = (filePath) => new Database(filePath, { create: false, strict: true }),
    projectLogicalRequestGuard = null,
    checkpointRunner = null,
    bindLogicalRequestFinalizer = null,
    assertCheckpointMaintenanceLease = null,
    admissionEventDigest = null,
  } = options;
  const evidence = evidenceSnapshot(controlStore);
  const admissionContext = Object.freeze({
    databasePath,
    dbKey,
    projectInstanceIdSha256,
    ownershipHash,
  });
  const admittedBasis = verifyAdmission(
    admissionVerifier,
    evidence,
    admissionContext,
    admissionEventDigest,
  );
  const initialHistory = parseNativeEvidence(
    evidence,
    evidenceExpectations(admissionContext, evidence, admittedBasis),
    admittedBasis,
  );
  let frozenFrontier = initialHistory.frontier;
  let frozenEventDigests = Object.freeze(initialHistory.events.map((event) => event.digest));
  const frozenSource = initialHistory.mode === 'source' ? initialHistory.source : null;
  const frozenPrepared = initialHistory.mode === 'prepared' ? initialHistory.prepared : null;
  let connectionEpoch = null;
  if (typeof identityApi !== 'function') {
    throw nativeError('NATIVE_DATABASE_IDENTITY_STALE', 'identityApi must be a function');
  }
  if (typeof sqliteFactory !== 'function' || typeof assertWriterLease !== 'function') {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native connection dependencies are incomplete');
  }
  if (
    projectLogicalRequestGuard !== null
    && typeof projectLogicalRequestGuard !== 'function'
  ) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native logical request guard is invalid');
  }
  if (checkpointRunner !== null && typeof checkpointRunner !== 'function') {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native checkpoint runner is invalid');
  }
  if (
    bindLogicalRequestFinalizer !== null
    && typeof bindLogicalRequestFinalizer !== 'function'
  ) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native logical finalizer binder is invalid');
  }
  if (
    assertCheckpointMaintenanceLease !== null
    && typeof assertCheckpointMaintenanceLease !== 'function'
  ) {
    throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native checkpoint lease assertion is invalid');
  }
  const checkpointController = bindLogicalRequestFinalizer === null
    ? null
    : controlStoreModule.getBoundedControlStoreCheckpointController(controlStore);

  function assertProjectLogicalRequest() {
    if (projectLogicalRequestGuard !== null) projectLogicalRequestGuard();
  }

  let guard;
  let database;
  let state = 'recovery_required';
  let activeOperation = null;
  let expectedBasis;
  try {
    guard = identityApi({ databasePath });
    if (!guard || typeof guard.assertCurrent !== 'function' || typeof guard.close !== 'function') {
      throw nativeError('NATIVE_DATABASE_IDENTITY_STALE', 'identityApi returned an invalid guard');
    }
    const admissionIdentity = evidenceAdmissionEvent(
      evidence,
      admittedBasis.basisDigest,
    )?.payload;
    if (!sameIdentity(guard.identity, admissionIdentity?.identity || admissionIdentity?.finalIdentity)) {
      throw nativeError('NATIVE_DATABASE_IDENTITY_STALE', 'Database identity differs from admission evidence');
    }
    expectedBasis = Object.freeze({
      dbKey,
      ownershipHash,
      projectInstanceIdSha256,
      identity: guard.identity,
    });
    if (initialHistory.mode === 'clean') {
      controlledOpen(assertExactInitialHistory);
    } else {
      readControlledHistory(assertExactInitialHistory);
    }
  } catch (error) {
    try {
      database?.close();
    } catch {
      // No facade escaped; preserve the admission/open failure.
    }
    try {
      guard?.close();
    } catch {
      // No facade escaped; preserve the admission/open failure.
    }
    if (
      initialHistory.mode === 'prepared'
      && error?.code === 'NATIVE_DATABASE_IDENTITY_STALE'
    ) {
      throw recoveryRequired(
        'Prepared recovery database identity changed before construction completed',
        error,
      );
    }
    throw error;
  }

  function assertFrozenPrefix(history) {
    if (
      !sameCheckpointFrontier(history.frontier, frozenFrontier)
      || history.events.length < frozenEventDigests.length
      || frozenEventDigests.some((digest, index) => history.events[index]?.digest !== digest)
    ) {
      throw evidenceError('Native evidence no longer has the frozen admitted prefix');
    }
  }

  function assertExactInitialHistory(history) {
    assertFrozenPrefix(history);
    if (
      history.events.length !== frozenEventDigests.length
      || history.tail.digest !== initialHistory.tail.digest
      || history.mode !== initialHistory.mode
    ) {
      throw evidenceError('Native evidence changed during cold classification');
    }
    return history;
  }

  function assertExactPreparedRecoveryHistory(history) {
    assertFrozenPrefix(history);
    if (
      history.events.length !== frozenEventDigests.length
      || history.tail.digest !== initialHistory.tail.digest
      || history.mode !== 'prepared'
      || history.prepared?.digest !== frozenPrepared?.digest
    ) {
      throw recoveryRequired('Frozen prepared tail changed before recovery completed');
    }
    return history;
  }

  function classifyFrozenSourceHistory(history) {
    if (!frozenSource) throw evidenceError('Cold source classification has no frozen source');
    assertFrozenPrefix(history);
    if (
      history.events.length === frozenEventDigests.length
      && history.mode === 'source'
      && history.source?.digest === frozenSource.digest
      && history.tail.digest === frozenSource.digest
    ) {
      return Object.freeze({ kind: 'pending', source: history.source });
    }
    const abandoned = history.events[frozenEventDigests.length];
    if (
      history.events.length === frozenEventDigests.length + 1
      && history.mode === 'clean'
      && history.tail.digest === abandoned?.digest
      && abandoned?.type === 'manuscript.source.abandoned'
      && abandoned.payload.sourceDigest === frozenSource.digest
      && abandoned.payload.connectionEpoch === frozenSource.payload.connectionEpoch
      && ['cancelled', 'superseded'].includes(abandoned.payload.reasonCode)
    ) {
      return Object.freeze({ kind: 'abandoned', abandoned });
    }
    throw evidenceError('Cold source has no unique exact caller-owned abandoned successor');
  }

  function readControlledHistory(validateHistory) {
    const preflightHistory = assertEvidenceCurrent(
      controlStore,
      admissionVerifier,
      admissionContext,
      admittedBasis,
    );
    validateHistory(preflightHistory);
    guard.assertCurrent();
    controlStore.assertCurrent();
    const history = assertEvidenceCurrent(
      controlStore,
      admissionVerifier,
      admissionContext,
      admittedBasis,
    );
    validateHistory(history);
    assertWriterLease();
    return history;
  }

  function mintFreshConnectionEpoch(history) {
    const used = new Set(history.usedConnectionEpochs);
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const observed = randomUUID();
      if (!UUID_V4_PATTERN.test(observed)) continue;
      const candidate = observed.toLowerCase();
      if (
        used.has(candidate)
        || filterMayContainConnectionEpoch(
          history.inheritedConnectionEpochFilter,
          candidate,
        )
      ) {
        continue;
      }
      return candidate;
    }
    throw recoveryRequired(
      'No fresh native connection epoch remains after 128 authenticated candidates',
    );
  }

  function controlledOpen(validateHistory, options = {}) {
    let openedDatabase;
    let candidateEpoch;
    let firstStatementStarted = false;
    try {
      const preOpenHistory = readControlledHistory(validateHistory);
      if (options.mintAfterLiveValidation !== true) {
        candidateEpoch = mintFreshConnectionEpoch(preOpenHistory);
      }
      openedDatabase = sqliteFactory(guard.canonicalPath);
      guard.assertCurrent();
      controlStore.assertCurrent();
      const postOpenHistory = assertEvidenceCurrent(
        controlStore,
        admissionVerifier,
        admissionContext,
        admittedBasis,
      );
      validateHistory(postOpenHistory);
      assertWriterLease();
      firstStatementStarted = true;
      configureConnection(openedDatabase, DURABILITY_SQL_CAPABILITY);
      const snapshot = liveStateSnapshot(openedDatabase);
      if (typeof options.validateSnapshot === 'function') {
        options.validateSnapshot(snapshot, postOpenHistory);
      } else {
        assertLiveStateMatches(snapshot, postOpenHistory, expectedBasis, null);
      }
      if (options.mintAfterLiveValidation === true) {
        candidateEpoch = mintFreshConnectionEpoch(postOpenHistory);
      }
      if (options.activate !== false) {
        database = openedDatabase;
        connectionEpoch = candidateEpoch;
        state = 'active';
      }
      return Object.freeze({
        history: postOpenHistory,
        snapshot,
        database: openedDatabase,
        connectionEpoch: candidateEpoch,
      });
    } catch (cause) {
      if (
        openedDatabase
        && firstStatementStarted
        && options.fenceAfterStatementFailure === true
      ) {
        return fencePreparedRecoveryUncertainty(cause, { database: openedDatabase });
      }
      if (openedDatabase) {
        const closeErrors = closeResourcesBestEffort([openedDatabase]);
        if (closeErrors.length > 0) {
          closeErrors.push(...closeResourcesBestEffort([guard]));
          throw dispositionUnknownError(
            cause,
            'Rejected controlled SQLite open could not be closed exactly',
            closeErrors,
          );
        }
      }
      throw cause;
    }
  }

  function stateError() {
    const code = state === 'recovery_required'
      ? 'RECOVERY_REQUIRED'
      : state === 'released'
      ? 'NATIVE_STORE_RELEASED'
      : state === 'fenced'
        ? 'NATIVE_STORE_FENCED'
        : 'NATIVE_STORE_DISPOSITION_UNKNOWN';
    return nativeError(code, `Native store connection is ${state}`);
  }

  function fenceOnUncertainty(error) {
    if (state === 'active') {
      state = 'fenced';
      try {
        database.close();
        guard.close();
      } catch (closeError) {
        state = 'disposition_unknown';
        try {
          Object.defineProperty(error, 'closeError', { value: closeError });
        } catch {
          // Preserve the primary uncertainty.
        }
      }
    }
    throw error;
  }

  function operationInProgressError() {
    return nativeError(
      'NATIVE_OPERATION_IN_PROGRESS',
      'Another synchronous native store operation is already in progress',
    );
  }

  function assertOperationIdle() {
    if (activeOperation !== null) throw operationInProgressError();
  }

  function withOperation(description, callback) {
    assertOperationIdle();
    const operationToken = Symbol(description);
    activeOperation = operationToken;
    try {
      return callback(operationToken);
    } finally {
      if (activeOperation === operationToken) activeOperation = null;
    }
  }

  function closeResourcesBestEffort(resources) {
    const closeErrors = [];
    for (const resource of resources) {
      try {
        resource?.close();
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    return closeErrors;
  }

  function dispositionUnknownError(primary, message, closeErrors) {
    state = 'disposition_unknown';
    const error = nativeError('NATIVE_STORE_DISPOSITION_UNKNOWN', message, primary);
    try {
      Object.defineProperty(error, 'closeError', {
        value: closeErrors[0],
        enumerable: false,
      });
      if (closeErrors.length > 1) {
        Object.defineProperty(error, 'additionalCloseErrors', {
          value: Object.freeze(closeErrors.slice(1)),
          enumerable: false,
        });
      }
    } catch {
      // Preserve the primary disposition error even if metadata attachment fails.
    }
    return error;
  }

  function inspectAuthorities({
    expectedGateRows = 0,
    expectedInTransaction = false,
    expectedSeq,
    allowPrepared = false,
    expectedPreparedDigest,
  } = {}) {
    if (state !== 'active') throw stateError();
    guard.assertCurrent();
    controlStore.assertCurrent();
    const history = assertEvidenceCurrent(
      controlStore,
      admissionVerifier,
      admissionContext,
      admittedBasis,
    );
    assertWriterLease();
    const snapshot = liveStateSnapshot(database, expectedGateRows);
    assertLiveStateMatches(
      snapshot,
      history,
      expectedBasis,
      connectionEpoch,
      { expectedSeq, allowPrepared },
    );
    if (
      expectedPreparedDigest !== undefined
      && (
        history.mode !== 'prepared'
        || history.prepared?.digest !== expectedPreparedDigest
        || history.tail?.digest !== expectedPreparedDigest
      )
    ) {
      throw nativeError('NATIVE_ADMISSION_REJECTED', 'Prepared evidence is no longer the exact tail');
    }
    if (database.inTransaction !== expectedInTransaction) {
      throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native SQLite autocommit state is not exact');
    }
    return Object.freeze({ history, snapshot });
  }

  let finalizedLogicalTailDigest = initialHistory.tail.digest;

  function currentCheckpointSnapshot(history) {
    const tail = controlStore.tail();
    if (
      tail === null
      || tail.seq !== history.tail.seq
      || tail.digest !== history.tail.digest
    ) {
      throw nativeError('NATIVE_ADMISSION_REJECTED', 'Checkpoint snapshot tail is not exact');
    }
    return deepFreeze({
      incarnationId: controlStore.incarnationId,
      tail: { seq: tail.seq, digest: tail.digest },
      cleanBasisDigest: tail.digest,
    });
  }

  function checkpointAuthority(history, snapshot, checkpointSnapshot) {
    return deepFreeze({
      snapshot: checkpointSnapshot,
      cleanBasis: {
        admissionBasis: {
          basisKind: admittedBasis.basisKind,
          basisDigest: admittedBasis.basisDigest,
          admissionEvent: structuredClone(history.admissionEvent),
        },
        dbKey,
        schema: snapshot.schemaVersion,
        backend: snapshot.backend,
        finalSeq: snapshot.finalSeq,
        triggerVersion: snapshot.triggerVersion,
        triggerSetDigest: snapshot.triggerSetDigest,
        projectInstanceIdSha256: snapshot.projectInstanceIdSha256,
        identity: structuredClone(guard.identity),
        latestCleanBasisDigest: checkpointSnapshot.cleanBasisDigest,
        unresolved: [],
      },
      epochObservations: history.activeEpochObservations,
    });
  }

  function finalizeLogicalRequest() {
    if (state !== 'active') return null;
    const { history, snapshot } = inspectAuthorities();
    if (
      history.mode !== 'clean'
      || history.tail.digest === finalizedLogicalTailDigest
    ) {
      return null;
    }
    finalizedLogicalTailDigest = history.tail.digest;
    const status = checkpointController.maintenanceStatus();
    if (status.level === 'none') return null;

    const capturedSnapshot = currentCheckpointSnapshot(history);
    const authority = checkpointAuthority(history, snapshot, capturedSnapshot);
    const verifyCurrent = Object.freeze(function verifyCurrent() {
      try {
        assertCheckpointMaintenanceLease();
        const current = inspectAuthorities();
        const currentSnapshot = currentCheckpointSnapshot(current.history);
        return current.history.mode === 'clean'
          && currentSnapshot.incarnationId === capturedSnapshot.incarnationId
          && currentSnapshot.tail.seq === capturedSnapshot.tail.seq
          && currentSnapshot.tail.digest === capturedSnapshot.tail.digest
          && currentSnapshot.cleanBasisDigest === capturedSnapshot.cleanBasisDigest
          && current.snapshot.finalSeq === snapshot.finalSeq
          && current.snapshot.schemaVersion === snapshot.schemaVersion
          && current.snapshot.backend === snapshot.backend
          && current.snapshot.triggerVersion === snapshot.triggerVersion
          && current.snapshot.triggerSetDigest === snapshot.triggerSetDigest
          && current.snapshot.projectInstanceIdSha256 === snapshot.projectInstanceIdSha256;
      } catch {
        return false;
      }
    });
    const installCheckpoint = Object.freeze(function installCheckpoint() {
      assertCheckpointMaintenanceLease();
      const receipt = checkpointController.installCheckpoint(
        Object.freeze(function authorityProvider() { return authority; }),
      );
      const installed = inspectAuthorities();
      if (
        installed.history.frontier?.checkpointDigest !== receipt.checkpointDigest
        || installed.history.frontier?.coveredSeq !== receipt.coveredSeq
        || installed.history.events.length !== 0
        || installed.history.mode !== 'clean'
      ) {
        throw recoveryRequired('Installed checkpoint did not advance the native frontier exactly');
      }
      frozenFrontier = installed.history.frontier;
      frozenEventDigests = Object.freeze([]);
      return receipt;
    });
    return deepFreeze({
      snapshot: capturedSnapshot,
      verifyCurrent,
      installCheckpoint,
    });
  }

  function normalizedAuthorityError(cause, message) {
    return cause?.code?.startsWith('NATIVE_') || cause?.code === 'RECOVERY_REQUIRED'
      ? cause
      : nativeError('NATIVE_DATABASE_IDENTITY_STALE', message, cause);
  }

  function assertActive(options = {}) {
    try {
      return inspectAuthorities();
    } catch (cause) {
      if (options.transactionAdmission === true && cause?.code === 'NATIVE_GATE_NOT_EMPTY') {
        return fenceOnUncertainty(recoveryRequired(
          'Transaction admission found a pre-existing durability gate',
          cause,
        ));
      }
      return fenceOnUncertainty(normalizedAuthorityError(
        cause,
        'Native connection identity is uncertain',
      ));
    }
  }

  function readStatement(sql, params, mode) {
    assertOperationIdle();
    assertActive();
    const classification = classifyNativeSql(sql);
    if (classification.kind !== 'business_read') {
      throw nativeError('NATIVE_SQL_FORBIDDEN', 'Only business reads are allowed outside a transaction');
    }
    try {
      return database.query(sql)[mode](...params);
    } catch (error) {
      if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_IOERR') {
        return fenceOnUncertainty(nativeError(
          'NATIVE_STORE_DISPOSITION_UNKNOWN',
          'SQLite read ended with operational uncertainty',
          error,
        ));
      }
      throw error;
    }
  }

  function unsupported(code, message) {
    assertOperationIdle();
    assertActive();
    throw nativeError(code, message);
  }

  function closeWithState(finalState) {
    if (state !== 'active' && state !== 'recovery_required') throw stateError();
    try {
      if (database) database.close();
      guard.close();
      state = finalState;
    } catch (cause) {
      state = 'disposition_unknown';
      throw nativeError('NATIVE_STORE_DISPOSITION_UNKNOWN', 'Native connection close disposition is unknown', cause);
    }
  }

  function commonPayloadForEpoch(payloadConnectionEpoch) {
    return {
      version: 1,
      eventId: randomUUID(),
      dbKey,
      projectInstanceIdSha256,
      createdAt: new Date().toISOString(),
      ownershipHash,
      connectionEpoch: payloadConnectionEpoch,
    };
  }

  function commonTransactionPayload() {
    return commonPayloadForEpoch(connectionEpoch);
  }

  function recoveryRequired(message, cause) {
    return nativeError('RECOVERY_REQUIRED', message, cause);
  }

  function readHistoryForAppendPostcheck() {
    controlStore.assertCurrent();
    const history = assertEvidenceCurrent(
      controlStore,
      admissionVerifier,
      admissionContext,
      admittedBasis,
    );
    assertWriterLease();
    return history;
  }

  function isLegalSourceConsumer(history, sourceDigest) {
    const sourceIndex = history.events.findIndex((event) => event.digest === sourceDigest);
    const successor = sourceIndex < 0 ? null : history.events[sourceIndex + 1];
    return (
      successor?.type === 'sqlite.tx.prepared'
      && successor.payload.sourceDigest === sourceDigest
    ) || (
      successor?.type === 'manuscript.source.abandoned'
      && successor.payload.sourceDigest === sourceDigest
    );
  }

  function appendPrepared(source, payload) {
    let appended;
    try {
      appended = controlStore.compareAndAppend(source.digest, {
        type: 'sqlite.tx.prepared',
        payload,
      });
    } catch (cause) {
      if (cause?.code === 'CONTROL_STORE_CAS_FAILED') {
        try {
          const history = readHistoryForAppendPostcheck();
          if (isLegalSourceConsumer(history, source.digest)) {
            throw nativeError('NATIVE_SOURCE_NOT_CURRENT', 'Transaction source was already consumed');
          }
        } catch (inspectionError) {
          if (inspectionError?.code === 'NATIVE_SOURCE_NOT_CURRENT') throw inspectionError;
        }
      }
      return fenceOnUncertainty(recoveryRequired(
        'Prepared evidence publication is uncertain',
        cause,
      ));
    }
    try {
      const history = readHistoryForAppendPostcheck();
      if (
        history.mode !== 'prepared'
        || history.tail.digest !== appended.digest
        || history.prepared.digest !== appended.digest
        || history.prepared.payload.sourceDigest !== source.digest
      ) {
        throw evidenceError('Prepared evidence post-check is not exact');
      }
      return history;
    } catch (cause) {
      return fenceOnUncertainty(recoveryRequired(
        'Prepared evidence post-check is uncertain',
        cause,
      ));
    }
  }

  function transactionFaultContext(transactionState) {
    return Object.freeze({
      transactionId: transactionState.transactionId,
      sourceDigest: transactionState.sourceDigest,
      preparedDigest: transactionState.preparedDigest,
      beforeSeq: transactionState.beforeSeq,
      expectedFinalSeq: transactionState.expectedFinalSeq,
      writeLockAcquired: transactionState.writeLockAcquired,
      gateSqlExecuted: transactionState.gateSqlExecuted,
      businessSqlExecuted: transactionState.businessSqlExecuted,
      seqSqlExecuted: transactionState.seqSqlExecuted,
      gateDeleteSqlExecuted: transactionState.gateDeleteSqlExecuted,
      commitInvoked: transactionState.commitInvoked,
    });
  }

  function appendTerminal(prepared, type, payload, transactionState) {
    let appended;
    try {
      faultPoint(
        FAULT_POINTS.NATIVE_TX_BEFORE_TERMINAL_APPEND,
        transactionFaultContext(transactionState),
      );
      appended = controlStore.compareAndAppend(prepared.digest, { type, payload });
      const history = readHistoryForAppendPostcheck();
      if (
        history.mode !== 'clean'
        || history.tail.digest !== appended.digest
        || history.tail.type !== type
        || history.tail.payload.preparedDigest !== prepared.digest
      ) {
        throw evidenceError('Transaction terminal evidence post-check is not exact');
      }
      return history;
    } catch (cause) {
      return fenceOnUncertainty(recoveryRequired(
        'Transaction terminal publication is uncertain',
        cause,
      ));
    }
  }

  function transactionFacade(operationToken, transactionState) {
    function assertTransactionActive() {
      if (
        transactionState.live !== true
        || activeOperation !== operationToken
        || state !== 'active'
        || database.inTransaction !== true
      ) {
        throw nativeError(
          'NATIVE_TRANSACTION_FACADE_STALE',
          'Transaction statement facade is outside its synchronous epoch',
        );
      }
    }

    function statement(sql, params, mode) {
      assertTransactionActive();
      const classification = classifyNativeTransactionSql(sql);
      const requiredKind = mode === 'run' ? 'business_dml' : 'business_read';
      if (classification.kind !== requiredKind) {
        throw nativeError('NATIVE_SQL_FORBIDDEN', 'SQL is not authorized for this transaction method');
      }
      const result = database.query(sql)[mode](...params);
      if (mode === 'run') transactionState.businessSqlExecuted = true;
      return result;
    }

    return Object.freeze({
      all(sql, ...params) {
        return statement(sql, params, 'all');
      },
      get(sql, ...params) {
        return statement(sql, params, 'get');
      },
      run(sql, ...params) {
        return statement(sql, params, 'run');
      },
    });
  }

  function rollbackStartedTransaction(primaryError, transactionState, prepared, beforeSeq) {
    transactionState.live = false;
    try {
      database.exec('ROLLBACK');
      if (database.inTransaction !== false) {
        throw nativeError('NATIVE_CONNECTION_REJECTED', 'ROLLBACK did not restore autocommit');
      }
      const { snapshot } = inspectAuthorities({
        expectedGateRows: 0,
        expectedInTransaction: false,
        expectedSeq: beforeSeq,
        allowPrepared: true,
        expectedPreparedDigest: prepared.digest,
      });
      appendTerminal(prepared, 'sqlite.tx.rolled_back', {
        ...commonTransactionPayload(),
        preparedDigest: prepared.digest,
        beforeSeq,
        reasonCode: 'transaction_failed',
        rollbackKind: 'transaction_rolled_back',
        predicate: {
          autocommit: true,
          rollbackCompleted: true,
          schemaVersion: snapshot.schemaVersion,
          backend: snapshot.backend,
          finalSeq: snapshot.finalSeq,
          gateEmpty: snapshot.gateEmpty,
          triggerVersion: snapshot.triggerVersion,
          triggerSetDigest: snapshot.triggerSetDigest,
          identity: guard.identity,
        },
      }, transactionState);
    } catch (cause) {
      if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
      return fenceOnUncertainty(recoveryRequired(
        'Transaction rollback disposition is uncertain',
        cause,
      ));
    }
    throw primaryError;
  }

  function handleBeginNotAcquired(beginError, transactionState, prepared, beforeSeq) {
    try {
      if (database.inTransaction !== false) {
        throw nativeError('NATIVE_CONNECTION_REJECTED', 'Busy BEGIN did not remain in autocommit');
      }
      const { snapshot } = inspectAuthorities({
        expectedGateRows: 0,
        expectedInTransaction: false,
        expectedSeq: beforeSeq,
        allowPrepared: true,
        expectedPreparedDigest: prepared.digest,
      });
      appendTerminal(prepared, 'sqlite.tx.rolled_back', {
        ...commonTransactionPayload(),
        preparedDigest: prepared.digest,
        beforeSeq,
        reasonCode: 'sqlite_busy',
        rollbackKind: 'begin_not_acquired',
        predicate: {
          autocommit: true,
          writeLockAcquired: false,
          gateSqlExecuted: false,
          businessSqlExecuted: false,
          seqSqlExecuted: false,
          schemaVersion: snapshot.schemaVersion,
          backend: snapshot.backend,
          finalSeq: snapshot.finalSeq,
          gateEmpty: snapshot.gateEmpty,
          triggerVersion: snapshot.triggerVersion,
          triggerSetDigest: snapshot.triggerSetDigest,
          identity: guard.identity,
        },
      }, transactionState);
    } catch (cause) {
      if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
      return fenceOnUncertainty(recoveryRequired(
        'Busy BEGIN predicate cannot be proven',
        cause,
      ));
    }
    throw nativeError('PROJECT_WRITE_BUSY', 'Native project writer is busy', beginError);
  }

  function executeOneTransaction(input, callback, operationToken) {
    const { history, snapshot } = assertActive({ transactionAdmission: true });
    const source = history.mode === 'source' ? history.source : null;
    if (
      !source
      || source.digest !== input.sourceDigest
      || source !== history.tail
      || source.payload.connectionEpoch !== connectionEpoch
      || source.payload.operationKind !== input.operationKind
      || source.payload.logicalRequestDigest !== input.logicalRequestDigest
      || source.payload.attemptSeq !== input.attemptSeq
    ) {
      throw nativeError('NATIVE_SOURCE_NOT_CURRENT', 'Transaction source is not the current owned tail');
    }
    if (snapshot.finalSeq === Number.MAX_SAFE_INTEGER) {
      throw nativeError('NATIVE_CONNECTION_REJECTED', 'Native commit sequence cannot advance safely');
    }
    const beforeSeq = snapshot.finalSeq;
    const expectedFinalSeq = beforeSeq + 1;
    const transactionId = randomUUID();
    const preparedHistory = appendPrepared(source, {
      ...commonTransactionPayload(),
      transactionId,
      sourceDigest: source.digest,
      beforeSeq,
      expectedFinalSeq,
      schemaVersion: snapshot.schemaVersion,
      backend: snapshot.backend,
      expectedGateEmpty: true,
      expectedTriggerVersion: snapshot.triggerVersion,
      expectedTriggerSetDigest: snapshot.triggerSetDigest,
      expectedIdentity: guard.identity,
      operationKind: input.operationKind,
    });
    const prepared = preparedHistory.prepared;
    const transactionState = {
      live: false,
      transactionId,
      sourceDigest: source.digest,
      preparedDigest: prepared.digest,
      beforeSeq,
      expectedFinalSeq,
      writeLockAcquired: false,
      gateSqlExecuted: false,
      businessSqlExecuted: false,
      seqSqlExecuted: false,
      gateDeleteSqlExecuted: false,
      commitInvoked: false,
    };
    try {
      faultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_PREPARED_POSTCHECK,
        transactionFaultContext(transactionState),
      );
    } catch (cause) {
      return fenceOnUncertainty(recoveryRequired(
        'Prepared transaction was interrupted before BEGIN',
        cause,
      ));
    }
    try {
      database.exec('BEGIN IMMEDIATE');
      if (database.inTransaction !== true) {
        throw recoveryRequired('BEGIN IMMEDIATE did not prove an acquired transaction');
      }
    } catch (cause) {
      if (cause?.code === 'SQLITE_BUSY' || cause?.code === 'SQLITE_LOCKED') {
        return handleBeginNotAcquired(cause, transactionState, prepared, beforeSeq);
      }
      return fenceOnUncertainty(cause?.code === 'RECOVERY_REQUIRED'
        ? cause
        : recoveryRequired('BEGIN IMMEDIATE disposition is uncertain', cause));
    }

    transactionState.writeLockAcquired = true;
    transactionState.live = true;
    try {
      faultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_BEGIN_ACQUIRED,
        transactionFaultContext(transactionState),
      );
      inspectAuthorities({
        expectedGateRows: 0,
        expectedInTransaction: true,
        expectedSeq: beforeSeq,
        allowPrepared: true,
        expectedPreparedDigest: prepared.digest,
      });
      const gateInsert = database.query(
        'INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)',
      ).run();
      if (gateInsert?.changes !== 1) {
        throw nativeError('NATIVE_CONNECTION_REJECTED', 'Opening the durability gate changed an inexact row count');
      }
      transactionState.gateSqlExecuted = true;
      faultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_GATE_INSERT,
        transactionFaultContext(transactionState),
      );
      const statements = transactionFacade(operationToken, transactionState);
      let callbackResult;
      let callbackFailed = false;
      let callbackError;
      try {
        callbackResult = callback(statements);
      } catch (cause) {
        callbackFailed = true;
        callbackError = cause;
      }
      transactionState.live = false;
      faultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_BUSINESS_CALLBACK,
        transactionFaultContext(transactionState),
      );
      if (!callbackFailed && callbackResult !== null && (
        typeof callbackResult === 'object' || typeof callbackResult === 'function'
      )) {
        try {
          if (typeof callbackResult.then === 'function') {
            callbackFailed = true;
            callbackError = nativeError(
              'NATIVE_TRANSACTION_ASYNC_FORBIDDEN',
              'Native transaction callbacks must be synchronous',
            );
          }
        } catch (cause) {
          callbackFailed = true;
          callbackError = cause;
        }
      }
      if (callbackFailed) throw callbackError;

      const sequenceUpdate = database.query(
        "UPDATE project_meta SET value = ? WHERE key = 'durability_commit_seq' AND value = ?",
      ).run(String(expectedFinalSeq), String(beforeSeq));
      if (sequenceUpdate?.changes !== 1) {
        throw nativeError('NATIVE_CONNECTION_REJECTED', 'durability_commit_seq CAS changed an inexact row count');
      }
      transactionState.seqSqlExecuted = true;
      faultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_SEQ_CAS,
        transactionFaultContext(transactionState),
      );
      const gateDelete = database.query(
        'DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1',
      ).run();
      if (gateDelete?.changes !== 1) {
        throw nativeError('NATIVE_CONNECTION_REJECTED', 'Closing the durability gate changed an inexact row count');
      }
      transactionState.gateDeleteSqlExecuted = true;
      faultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_GATE_DELETE,
        transactionFaultContext(transactionState),
      );
      inspectAuthorities({
        expectedGateRows: 0,
        expectedInTransaction: true,
        expectedSeq: expectedFinalSeq,
        allowPrepared: true,
        expectedPreparedDigest: prepared.digest,
      });
      faultPoint(
        FAULT_POINTS.NATIVE_TX_BEFORE_COMMIT_INVOKE,
        transactionFaultContext(transactionState),
      );
      transactionState.commitInvoked = true;
      database.exec('COMMIT');
      faultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_COMMIT_RETURN,
        transactionFaultContext(transactionState),
      );
      if (database.inTransaction !== false) {
        return fenceOnUncertainty(recoveryRequired('COMMIT did not restore autocommit'));
      }
      const { snapshot: committedSnapshot } = inspectAuthorities({
        expectedGateRows: 0,
        expectedInTransaction: false,
        expectedSeq: expectedFinalSeq,
        allowPrepared: true,
        expectedPreparedDigest: prepared.digest,
      });
      const terminalHistory = appendTerminal(prepared, 'sqlite.tx.committed', {
        ...commonTransactionPayload(),
        preparedDigest: prepared.digest,
        finalSeq: expectedFinalSeq,
        schemaVersion: committedSnapshot.schemaVersion,
        backend: committedSnapshot.backend,
        gateEmpty: committedSnapshot.gateEmpty,
        triggerVersion: committedSnapshot.triggerVersion,
        triggerSetDigest: committedSnapshot.triggerSetDigest,
        postCommitIdentity: guard.identity,
      }, transactionState);
      crashOnlyFaultPoint(
        FAULT_POINTS.NATIVE_TX_AFTER_TERMINAL_POSTCHECK,
        Object.freeze({
          ...transactionFaultContext(transactionState),
          terminalDigest: terminalHistory.tail.digest,
        }),
      );
      return callbackResult;
    } catch (cause) {
      transactionState.live = false;
      if (state !== 'active') throw cause;
      if (transactionState.commitInvoked) {
        return fenceOnUncertainty(recoveryRequired(
          'COMMIT or post-COMMIT disposition is uncertain',
          cause,
        ));
      }
      let transactionOpen;
      try {
        transactionOpen = database.inTransaction === true;
      } catch (stateCause) {
        return fenceOnUncertainty(recoveryRequired(
          'Pre-COMMIT transaction state cannot be read',
          stateCause,
        ));
      }
      if (!transactionOpen) {
        return fenceOnUncertainty(recoveryRequired(
          'Pre-COMMIT transaction disposition is uncertain',
          cause,
        ));
      }
      return rollbackStartedTransaction(cause, transactionState, prepared, beforeSeq);
    }
  }

  function validatePreparedRecoverySnapshot(snapshot, history) {
    if (!frozenPrepared) throw evidenceError('Prepared recovery has no frozen prepared event');
    assertLiveStateBasis(snapshot, history, expectedBasis);
    if (
      history.mode !== 'prepared'
      || history.prepared?.digest !== frozenPrepared.digest
      || history.tail.digest !== frozenPrepared.digest
      || snapshot.schemaVersion !== frozenPrepared.payload.schemaVersion
      || snapshot.backend !== frozenPrepared.payload.backend
      || snapshot.gateEmpty !== frozenPrepared.payload.expectedGateEmpty
      || snapshot.triggerVersion !== frozenPrepared.payload.expectedTriggerVersion
      || snapshot.triggerSetDigest !== frozenPrepared.payload.expectedTriggerSetDigest
      || !sameIdentity(guard.identity, frozenPrepared.payload.expectedIdentity)
      || ![
        frozenPrepared.payload.beforeSeq,
        frozenPrepared.payload.expectedFinalSeq,
      ].includes(snapshot.finalSeq)
    ) {
      throw recoveryRequired('Prepared live state is not one exact recoverable predicate');
    }
  }

  function appendRecoveryTerminal(type, payload, recoveryEpoch, expectedFinalSeq) {
    const appended = controlStore.compareAndAppend(frozenPrepared.digest, { type, payload });
    guard.assertCurrent();
    controlStore.assertCurrent();
    const history = assertEvidenceCurrent(
      controlStore,
      admissionVerifier,
      admissionContext,
      admittedBasis,
    );
    assertWriterLease();
    assertFrozenPrefix(history);
    if (
      history.events.length !== frozenEventDigests.length + 1
      || history.mode !== 'clean'
      || history.projectedSeq !== expectedFinalSeq
      || history.tail.digest !== appended.digest
      || history.tail.type !== type
      || history.tail.payload.preparedDigest !== frozenPrepared.digest
      || history.tail.payload.connectionEpoch !== recoveryEpoch
    ) {
      throw evidenceError('Prepared recovery terminal post-check is not exact');
    }
    return Object.freeze({ history, terminal: history.tail });
  }

  function fencePreparedRecoveryUncertainty(cause, recoveryResource) {
    const primary = cause?.code === 'RECOVERY_REQUIRED'
      ? cause
      : recoveryRequired('Prepared recovery terminal disposition is uncertain', cause);
    const closeErrors = closeResourcesBestEffort([recoveryResource.database, guard]);
    if (closeErrors.length === 0) {
      state = 'fenced';
      throw primary;
    }
    throw dispositionUnknownError(
      primary,
      'Prepared recovery resources could not be closed exactly',
      closeErrors,
    );
  }

  function recoverPrepared() {
    let recoveryResource;
    try {
      controlStore.assertCurrent();
      const preflightHistory = assertEvidenceCurrent(
        controlStore,
        admissionVerifier,
        admissionContext,
        admittedBasis,
      );
      assertExactPreparedRecoveryHistory(preflightHistory);
      recoveryResource = controlledOpen(assertExactPreparedRecoveryHistory, {
        activate: false,
        fenceAfterStatementFailure: true,
        mintAfterLiveValidation: true,
        validateSnapshot: validatePreparedRecoverySnapshot,
      });
      const {
        snapshot,
        database: recoveryDatabase,
        connectionEpoch: recoveryEpoch,
      } = recoveryResource;
      const committed = snapshot.finalSeq === frozenPrepared.payload.expectedFinalSeq;
      const type = committed ? 'sqlite.tx.committed' : 'sqlite.tx.rolled_back';
      const payload = committed
        ? {
          ...commonPayloadForEpoch(recoveryEpoch),
          preparedDigest: frozenPrepared.digest,
          finalSeq: snapshot.finalSeq,
          schemaVersion: snapshot.schemaVersion,
          backend: snapshot.backend,
          gateEmpty: snapshot.gateEmpty,
          triggerVersion: snapshot.triggerVersion,
          triggerSetDigest: snapshot.triggerSetDigest,
          postCommitIdentity: guard.identity,
        }
        : {
          ...commonPayloadForEpoch(recoveryEpoch),
          preparedDigest: frozenPrepared.digest,
          beforeSeq: frozenPrepared.payload.beforeSeq,
          reasonCode: 'crash_recovery',
          rollbackKind: 'recovery_before_commit',
          predicate: {
            autocommit: true,
            hotJournalRecovered: true,
            schemaVersion: snapshot.schemaVersion,
            backend: snapshot.backend,
            finalSeq: snapshot.finalSeq,
            gateEmpty: snapshot.gateEmpty,
            triggerVersion: snapshot.triggerVersion,
            triggerSetDigest: snapshot.triggerSetDigest,
            identity: guard.identity,
          },
        };
      const terminalResult = appendRecoveryTerminal(
        type,
        payload,
        recoveryEpoch,
        snapshot.finalSeq,
      );
      assertLiveStateMatches(
        snapshot,
        terminalResult.history,
        expectedBasis,
        recoveryEpoch,
      );
      database = recoveryDatabase;
      connectionEpoch = recoveryEpoch;
      state = 'active';
      return Object.freeze({
        status: committed ? 'committed' : 'rolled_back',
        preparedDigest: frozenPrepared.digest,
        terminalDigest: terminalResult.terminal.digest,
        finalSeq: snapshot.finalSeq,
        connectionEpoch: recoveryEpoch,
      });
    } catch (cause) {
      if (recoveryResource?.database) {
        return fencePreparedRecoveryUncertainty(cause, recoveryResource);
      }
      if (
        cause?.code === 'NATIVE_ADMISSION_REJECTED'
        || cause?.code === 'NATIVE_STORE_DISPOSITION_UNKNOWN'
        || cause?.code === 'RECOVERY_REQUIRED'
      ) {
        throw cause;
      }
      throw recoveryRequired('Prepared recovery could not be proven exactly', cause);
    }
  }

  function recoverStore() {
    if (state === 'active') {
      const { history, snapshot } = assertActive();
      if (history.mode !== 'clean') {
        throw recoveryRequired('Native recovery requires a cold source or prepared facade');
      }
      return Object.freeze({
        status: 'clean',
        finalSeq: snapshot.finalSeq,
        connectionEpoch,
      });
    }
    if (state !== 'recovery_required') throw stateError();
    if (initialHistory.mode === 'prepared') return recoverPrepared();
    if (initialHistory.mode !== 'source') throw stateError();

    let classification;
    const history = readControlledHistory((currentHistory) => {
      classification = classifyFrozenSourceHistory(currentHistory);
    });
    if (classification.kind === 'pending') {
      return Object.freeze({
        status: 'source_pending',
        sourceDigest: frozenSource.digest,
        finalSeq: history.projectedSeq,
        connectionEpoch: null,
      });
    }

    const abandonedDigest = classification.abandoned.digest;
    const { snapshot } = controlledOpen((currentHistory) => {
      const current = classifyFrozenSourceHistory(currentHistory);
      if (current.kind !== 'abandoned' || current.abandoned.digest !== abandonedDigest) {
        throw evidenceError('Caller-owned abandoned proof changed during controlled open');
      }
    });
    return Object.freeze({
      status: 'clean',
      finalSeq: snapshot.finalSeq,
      connectionEpoch,
    });
  }

  function publishSchema12ProjectionTarget(input) {
    if (!exactKeys(input, ['target', 'routeCas'])) {
      throw new TypeError('publishProjectionTarget input must contain exact target and routeCas');
    }
    if (state !== 'active') throw stateError();
    const target = new SQLiteProjectionStore().validateTarget(input.target);
    if (target !== input.target) {
      throw new TypeError('Projection target validation changed object identity');
    }
    assertProjectLogicalRequest();
    assertActive();
    return consumeRouteCas(input.routeCas, {
      purpose: 'projection_target',
      apply({ migrationContext: context }) {
        if (
          target.projectUid !== context.projectUid
          || target.projectInstanceId !== context.projectInstanceId
          || target.baseGeneration !== context.baseGeneration
          || target.targetGeneration !== context.targetGeneration
        ) {
          throw recoveryRequired('Projection target differs from MigrationContext');
        }
        const sourceParent = path.dirname(context.sourcePath);
        if (path.dirname(context.candidatePath) !== sourceParent) {
          throw recoveryRequired('Migration candidate is not side-by-side with its source');
        }
        let candidateDatabase;
        let candidateCommitted = false;
        try {
          guard.assertCurrent();
          assertMigrationFile(context.sourcePath, context.sourceIdentity, sourceParent);
          if (
            context.sourcePath !== guard.canonicalPath
            || sha256File(context.sourcePath) !== context.sourceSha256
          ) throw recoveryRequired('Migration source differs from its journal checksum binding');
          assertMigrationFile(context.candidatePath, context.candidateIdentity, sourceParent);
          const observedCandidateSha256 = sha256File(context.candidatePath);
          candidateDatabase = new Database(context.candidatePath, {
            create: false,
            strict: true,
          });
          configureConnection(candidateDatabase, DURABILITY_SQL_CAPABILITY);
          const beforeMeta = candidateMeta(candidateDatabase);
          const beforeSeq = canonicalCandidateSequence(beforeMeta);
          if (observedCandidateSha256 === context.candidateSha256) {
            inspectSchema12Contract(candidateDatabase, { expectedFinalSeq: beforeSeq });
            assertCandidateMeta(
              beforeMeta,
              context,
              'migrating',
              context.baseGeneration,
            );
            installTargetRows(candidateDatabase, target, context, beforeSeq);
            candidateCommitted = true;
          } else {
            assertCandidateProjection(candidateDatabase, target, context, beforeSeq);
          }
          closeSqliteExactly(candidateDatabase);
          candidateDatabase = null;
          fsyncFile(context.candidatePath);
          fsyncDirectory(sourceParent);
          assertMigrationFile(context.candidatePath, context.candidateIdentity, sourceParent);
          assertMigrationFile(context.sourcePath, context.sourceIdentity, sourceParent);
          if (sha256File(context.sourcePath) !== context.sourceSha256) {
            throw recoveryRequired('Migration source changed before final route publication');
          }
          if (candidateCommitted) {
            faultPoint(
              FAULT_POINTS.NATIVE_TX_AFTER_COMMIT_RETURN,
              Object.freeze({
                operationKind: 'schema12_projection_activation',
                migrationId: context.migrationId,
                targetGeneration: context.targetGeneration,
              }),
            );
          }
        } catch (cause) {
          try { if (candidateDatabase) closeSqliteExactly(candidateDatabase); } catch (closeError) {
            throw recoveryRequired('Schema12 candidate close disposition is uncertain', closeError);
          }
          if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
          throw recoveryRequired('Schema12 candidate publication requires recovery', cause);
        }

        try {
          closeSqliteExactly(database);
          database = null;
          guard.close();
          state = 'fenced';
        } catch (cause) {
          state = 'disposition_unknown';
          throw recoveryRequired('Source handles could not close before route publication', cause);
        }
        try {
          atomicReplace(context.candidatePath, context.sourcePath);
          fsyncDirectory(sourceParent);
          state = 'released';
          return Object.freeze({
            disposition: 'after',
            generation: context.targetGeneration,
            route: 'files',
          });
        } catch (cause) {
          state = 'disposition_unknown';
          throw recoveryRequired('Final schema12 route publication is ambiguous', cause);
        }
      },
    });
  }

  const facade = {
    get connectionEpoch() {
      return connectionEpoch;
    },
    get state() {
      return state;
    },
    readAll(sql, ...params) {
      return readStatement(sql, params, 'all');
    },
    readGet(sql, ...params) {
      return readStatement(sql, params, 'get');
    },
    executeTransaction(input, callback) {
      return withOperation('native transaction operation', (operationToken) => {
        assertProjectLogicalRequest();
        if (state !== 'active') throw stateError();
        validateExecuteInput(input, callback);
        return executeOneTransaction(input, callback, operationToken);
      });
    },
    recover() {
      return withOperation('native recovery operation', () => {
        assertProjectLogicalRequest();
        return recoverStore();
      });
    },
    checkpoint() {
      if (checkpointRunner !== null) {
        return withOperation('native checkpoint operation', () => {
          if (state !== 'active') throw stateError();
          return checkpointRunner();
        });
      }
      return unsupported('NATIVE_OPERATION_NOT_IMPLEMENTED', 'Native checkpoint is not implemented in Task 2');
    },
    publishProjectionTarget(input) {
      return withOperation(
        'native projection publication',
        () => publishSchema12ProjectionTarget(input),
      );
    },
    close() {
      return withOperation('native close operation', () => closeWithState('released'));
    },
    fence() {
      return withOperation('native fence operation', () => closeWithState('fenced'));
    },
  };
  if (bindLogicalRequestFinalizer !== null) {
    bindLogicalRequestFinalizer(finalizeLogicalRequest);
  }
  return Object.freeze(facade);
}

function createProofBoundSchema12ProjectStore(options) {
  if (!exactKeys(options, ['admission', 'assertWriterLease', 'databasePath'])) {
    throw new TypeError('schema12 project store options are inexact');
  }
  if (
    typeof options.databasePath !== 'string'
    || !path.isAbsolute(options.databasePath)
    || path.resolve(options.databasePath) !== options.databasePath
    || typeof options.assertWriterLease !== 'function'
  ) throw new TypeError('schema12 project store dependencies are invalid');
  const { verifyActivatedSchema12Admission } = require('../manuscript/runtime');
  const admission = verifyActivatedSchema12Admission(options.admission);
  const databasePath = options.databasePath;
  const parentPath = path.dirname(databasePath);
  const identity = fileIdentity(databasePath);
  assertMigrationFile(databasePath, identity, parentPath);
  const guard = createDatabaseIdentityGuard({ databasePath });
  let database;
  let state = 'active';
  let activeOperation = false;
  const fullRefreshDispositionOwner = Object.freeze({});

  function recoveryRequiredHere(message, cause) {
    return nativeError('RECOVERY_REQUIRED', message, cause);
  }

  function closeResources(nextState) {
    if (state !== 'active') return;
    let primary = null;
    try {
      if (database !== undefined) closeSqliteExactly(database);
    } catch (cause) {
      primary = recoveryRequiredHere('Schema12 database close is ambiguous', cause);
    } finally {
      database = undefined;
    }
    try {
      guard.close();
    } catch (cause) {
      if (primary === null) primary = recoveryRequiredHere('Schema12 identity guard close is ambiguous', cause);
    }
    state = primary === null ? nextState : 'disposition_unknown';
    if (primary !== null) throw primary;
  }

  function requireActive() {
    if (state !== 'active' || database === undefined) {
      throw recoveryRequiredHere('Schema12 project store is not active');
    }
    guard.assertCurrent();
  }

  function withOperation(label, operation) {
    if (activeOperation) throw recoveryRequiredHere(`${label} cannot overlap another operation`);
    activeOperation = true;
    try {
      requireActive();
      return operation();
    } finally {
      activeOperation = false;
    }
  }

  function inspectContract() {
    const meta = candidateMeta(database);
    const finalSeq = canonicalCandidateSequence(meta);
    const contract = inspectSchema12Contract(database, { expectedFinalSeq: finalSeq });
    const facts = admission.databaseFacts;
    if (
      contract.route !== 'files'
      || contract.manuscriptProjectUid !== facts.projectUid
      || contract.projectInstanceId !== facts.projectInstanceId
      || contract.routeJournal !== facts.routeJournal
    ) throw recoveryRequiredHere('Schema12 live database differs from activated admission');
    return Object.freeze({ contract, finalSeq, meta });
  }

  function targetContext(target) {
    return Object.freeze({
      migrationId: admission.databaseFacts.routeJournal,
      projectUid: admission.databaseFacts.projectUid,
      projectInstanceId: admission.databaseFacts.projectInstanceId,
      baseGeneration: target.baseGeneration,
      targetGeneration: target.targetGeneration,
    });
  }

  function validateOwnedProjectionTarget(target) {
    const validated = new SQLiteProjectionStore().validateTarget(target);
    if (validated !== target) throw new TypeError('Projection target validation changed object identity');
    const facts = admission.databaseFacts;
    if (
      target.projectUid !== facts.projectUid
      || target.projectInstanceId !== facts.projectInstanceId
    ) throw new TypeError('Projection target project instance is foreign');
    return validated;
  }

  function disposition(target) {
    validateOwnedProjectionTarget(target);
    const current = inspectContract();
    if (current.contract.projectionGeneration === target.baseGeneration) return 'base';
    if (current.contract.projectionGeneration !== target.targetGeneration) return 'unknown';
    assertCandidateProjection(
      database,
      target,
      targetContext(target),
      current.finalSeq,
    );
    return 'target';
  }

  function mintFullRefreshDisposition(disposition, generation, target) {
    const authority = Object.freeze(function fullRefreshDispositionAuthority() {});
    fullRefreshDispositionRecords.set(authority, Object.freeze({
      owner: fullRefreshDispositionOwner,
      description: Object.freeze({ disposition, generation }),
      target,
    }));
    return authority;
  }

  function inspectFullRefreshDisposition(target) {
    validateOwnedProjectionTarget(target);
    const current = inspectContract();
    if (current.contract.projectionGeneration !== target.baseGeneration) {
      return mintFullRefreshDisposition('other', current.contract.projectionGeneration, target);
    }
    const live = exactSchema12ProjectionBase(
      database,
      target,
      targetContext(target),
      current.finalSeq,
    );
    if (live === null) {
      return mintFullRefreshDisposition(
        'base_changed',
        current.contract.projectionGeneration,
        target,
      );
    }
    return mintFullRefreshDisposition(
      schema12DesiredProjectionMatches(database, target, target.baseGeneration)
        ? 'already_current'
        : 'target',
      current.contract.projectionGeneration,
      target,
    );
  }

  try {
    database = new Database(databasePath, { create: false, strict: true });
    configureConnection(database, DURABILITY_SQL_CAPABILITY);
    const current = inspectContract();
    if (current.contract.projectionGeneration !== admission.databaseFacts.projectionGeneration) {
      throw recoveryRequiredHere('Schema12 generation differs from activated admission');
    }
  } catch (cause) {
    try { if (database !== undefined) closeSqliteExactly(database); } catch {}
    try { guard.close(); } catch {}
    state = 'disposition_unknown';
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequiredHere('Schema12 project store open failed', cause);
  }

  return Object.freeze({
    get state() { return state; },
    readAll(sql, ...params) {
      return withOperation('schema12 read', () => database.query(sql).all(...params));
    },
    readGet(sql, ...params) {
      return withOperation('schema12 read', () => database.query(sql).get(...params) ?? null);
    },
    inspectProjectionTarget(input) {
      if (!exactKeys(input, ['target'])) {
        throw new TypeError('inspectProjectionTarget input must contain exact target');
      }
      return withOperation('schema12 projection inspection', () => disposition(input.target));
    },
    inspectFullRefreshTarget(input) {
      const target = exactDataValue(
        input,
        ['target'],
        'target',
        'inspectFullRefreshTarget input',
      );
      return withOperation('schema12 full refresh inspection', () => {
        options.assertWriterLease();
        return inspectFullRefreshDisposition(target);
      });
    },
    describeFullRefreshDisposition(authority, expectedTarget) {
      const record = (
        (typeof authority === 'object' || typeof authority === 'function')
        && authority !== null
      ) ? fullRefreshDispositionRecords.get(authority) : undefined;
      if (record?.owner !== fullRefreshDispositionOwner) {
        throw new TypeError('full refresh disposition authority is foreign');
      }
      if (arguments.length > 1 && record.target !== expectedTarget) {
        throw new TypeError('full refresh disposition authority target is foreign');
      }
      return record.description;
    },
    applyAuxiliaryAction(inputValue) {
      const input = snapshotAuxiliaryInput(inputValue);
      return withOperation('schema12 auxiliary action', () => {
        options.assertWriterLease();
        const facts = admission.databaseFacts;
        if (
          input.currentProjection.projectUid !== facts.projectUid
          || input.currentProjection.projectInstanceId !== facts.projectInstanceId
        ) throw new TypeError('Auxiliary action project instance is foreign');
        const inputDigest = auxiliaryActionDigest(
          facts.projectUid,
          facts.projectInstanceId,
          input.action,
        );
        const requestKey = revisionRequestKey(input.logicalRequestId);
        const prior = readAuxiliaryReceipt(database, requestKey, inputDigest);
        if (prior !== null) return prior;
        const before = inspectContract();
        if (before.contract.projectionGeneration !== input.currentProjection.basis.baseGeneration) {
          throw recoveryRequiredHere('Auxiliary action generation differs from the admitted projection');
        }
        const context = Object.freeze({
          migrationId: facts.routeJournal,
          projectUid: facts.projectUid,
          projectInstanceId: facts.projectInstanceId,
          baseGeneration: input.currentProjection.basis.baseGeneration,
        });
        let result;
        try {
          result = installAuxiliaryAction(
            database,
            input,
            context,
            before.finalSeq,
            requestKey,
            inputDigest,
            Object.freeze({
              beforeCommit() {
                faultPoint(FAULT_POINTS.NATIVE_AUXILIARY_BEFORE_COMMIT_INVOKE, {
                  actionKind: input.action.kind,
                  databasePath,
                });
              },
              afterCommit() {
                faultPoint(FAULT_POINTS.NATIVE_AUXILIARY_AFTER_COMMIT_RETURN, {
                  actionKind: input.action.kind,
                  databasePath,
                });
              },
            }),
          );
          fsyncFile(databasePath);
          faultPoint(FAULT_POINTS.NATIVE_AUXILIARY_AFTER_FILE_FSYNC, {
            actionKind: input.action.kind,
            databasePath,
          });
          fsyncDirectory(parentPath);
          faultPoint(FAULT_POINTS.NATIVE_AUXILIARY_AFTER_DIRECTORY_FSYNC, {
            actionKind: input.action.kind,
            databasePath,
          });
          guard.assertCurrent();
          faultPoint(FAULT_POINTS.NATIVE_AUXILIARY_AFTER_GUARD_RECHECK, {
            actionKind: input.action.kind,
            databasePath,
          });
          const observed = readAuxiliaryReceipt(database, requestKey, inputDigest);
          if (observed === null || !isDeepStrictEqual(observed, result)) {
            throw recoveryRequiredHere('Auxiliary action is not durably observable');
          }
          faultPoint(FAULT_POINTS.NATIVE_AUXILIARY_AFTER_RECEIPT_RECHECK, {
            actionKind: input.action.kind,
            databasePath,
          });
        } catch (cause) {
          if (knownRolledBackAuxiliaryActionErrors.has(cause)) throw cause;
          let closeError = null;
          try {
            closeResources('disposition_unknown');
          } catch (error) {
            closeError = error;
          }
          const error = recoveryRequiredHere(
            'Schema12 auxiliary action disposition is unknown',
            cause,
          );
          if (closeError !== null) {
            Object.defineProperty(error, 'closeError', {
              configurable: true,
              value: closeError,
            });
          }
          throw error;
        }
        return result;
      });
    },
    publishProjectionTarget(input) {
      const inputTarget = exactDataValue(
        input,
        ['target'],
        'target',
        'publishProjectionTarget input',
      );
      return withOperation('schema12 projection publication', () => {
        options.assertWriterLease();
        const target = validateOwnedProjectionTarget(inputTarget);
        const before = inspectContract();
        const beforeDisposition = disposition(target);
        if (beforeDisposition === 'target') {
          return Object.freeze({
            disposition: 'after',
            generation: target.targetGeneration,
            route: 'files',
          });
        }
        if (beforeDisposition !== 'base') {
          throw recoveryRequiredHere('Schema12 projection disposition is not the exact base');
        }
        try {
          installTargetRows(
            database,
            target,
            targetContext(target),
            before.finalSeq,
            'files',
            Object.freeze({
              beforeCommit() {
                faultPoint(FAULT_POINTS.NATIVE_FULL_REFRESH_BEFORE_COMMIT_INVOKE, {
                  databasePath,
                  targetGeneration: target.targetGeneration,
                });
              },
              afterCommit() {
                faultPoint(FAULT_POINTS.NATIVE_FULL_REFRESH_AFTER_COMMIT_RETURN, {
                  databasePath,
                  targetGeneration: target.targetGeneration,
                });
              },
            }),
          );
          fsyncFile(databasePath);
          faultPoint(FAULT_POINTS.NATIVE_FULL_REFRESH_AFTER_FILE_FSYNC, {
            databasePath,
            targetGeneration: target.targetGeneration,
          });
          fsyncDirectory(parentPath);
          faultPoint(FAULT_POINTS.NATIVE_FULL_REFRESH_AFTER_DIRECTORY_FSYNC, {
            databasePath,
            targetGeneration: target.targetGeneration,
          });
          guard.assertCurrent();
          faultPoint(FAULT_POINTS.NATIVE_FULL_REFRESH_AFTER_GUARD_RECHECK, {
            databasePath,
            targetGeneration: target.targetGeneration,
          });
          if (disposition(target) !== 'target') {
            throw recoveryRequiredHere('Schema12 projection publication is not durably observable');
          }
          faultPoint(FAULT_POINTS.NATIVE_FULL_REFRESH_AFTER_TARGET_RECHECK, {
            databasePath,
            targetGeneration: target.targetGeneration,
          });
        } catch (cause) {
          if (knownRolledBackTargetInstallErrors.has(cause)) throw cause;
          let closeError = null;
          try {
            closeResources('disposition_unknown');
          } catch (error) {
            closeError = error;
          }
          const error = recoveryRequiredHere(
            'Schema12 projection publication disposition is unknown',
            cause,
          );
          if (closeError !== null) {
            Object.defineProperty(error, 'closeError', {
              configurable: true,
              value: closeError,
            });
          }
          throw error;
        }
        return Object.freeze({
          disposition: 'after',
          generation: target.targetGeneration,
          route: 'files',
        });
      });
    },
    recover() {
      return withOperation('schema12 recovery', () => {
        const current = inspectContract();
        return Object.freeze({
          status: 'clean',
          generation: current.contract.projectionGeneration,
        });
      });
    },
    close() { closeResources('released'); },
  });
}

module.exports = {
  createNativeProjectStore,
  createNativeProjectStoreCore,
  createProofBoundSchema12ProjectStore,
  installCreatedProjectDatabase,
};
