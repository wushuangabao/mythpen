const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openControlStore } = require('../control-store');
const { createNativeProjectStoreCore } = require('../native/native-project-store');
const { isProjectWriteCoordinator } = require('../project-write-coordinator');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FIXTURE_KEYS = [
  'controlDirectory',
  'databasePath',
  'databaseSha256',
  'fixtureRunId',
  'genesisDigest',
  'name',
  'root',
];
const PAYLOAD_KEYS = [
  'backend',
  'connectionEpoch',
  'createdAt',
  'dbKey',
  'eventId',
  'finalSeq',
  'fixtureRunId',
  'gateEmpty',
  'identity',
  'ownershipHash',
  'projectInstanceIdSha256',
  'schemaVersion',
  'triggerSetDigest',
  'triggerVersion',
  'version',
];

function rejection(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateFixtureDescriptor(fixture) {
  if (!Object.isFrozen(fixture) || !exactKeys(fixture, FIXTURE_KEYS)) {
    throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B requires the exact helper-owned fixture descriptor');
  }
  if (
    !UUID_V4_PATTERN.test(fixture.fixtureRunId)
    || !SHA256_PATTERN.test(fixture.genesisDigest)
    || !SHA256_PATTERN.test(fixture.databaseSha256)
    || typeof fixture.databasePath !== 'string'
    || typeof fixture.controlDirectory !== 'string'
    || typeof fixture.root !== 'string'
  ) {
    throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B fixture descriptor is invalid');
  }
  const root = path.resolve(fixture.root);
  for (const target of [fixture.databasePath, fixture.controlDirectory]) {
    const relative = path.relative(root, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B fixture path escapes its helper root');
    }
  }
}

function validateGenesis(fixture, event, { verifyDatabaseHash }) {
  const payload = event?.payload;
  const identity = payload?.identity;
  const stats = fs.lstatSync(fixture.databasePath, { bigint: true });
  const observedIdentity = { dev: String(stats.dev), ino: String(stats.ino) };
  const expectedDbKey = sha256(canonicalDatabasePath(fixture.databasePath));
  const expectedOwnershipHash = sha256(canonicalJson({
    dbKey: expectedDbKey,
    identity: observedIdentity,
    projectInstanceIdSha256: payload?.projectInstanceIdSha256,
  }));
  if (
    !exactKeys(event, ['digest', 'payload', 'prevDigest', 'seq', 'type'])
    || event.seq !== 1
    || event?.type !== 'sqlite.native.stage_b.fixture_genesis'
    || event?.prevDigest !== null
    || event?.digest !== fixture.genesisDigest
    || !exactKeys(payload, PAYLOAD_KEYS)
    || payload.version !== 1
    || !UUID_V4_PATTERN.test(payload.eventId)
    || !UUID_V4_PATTERN.test(payload.connectionEpoch)
    || payload.fixtureRunId !== fixture.fixtureRunId
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(payload.createdAt)
    || Number.isNaN(Date.parse(payload.createdAt))
    || new Date(payload.createdAt).toISOString() !== payload.createdAt
    || payload.dbKey !== expectedDbKey
    || !SHA256_PATTERN.test(payload.projectInstanceIdSha256)
    || payload.ownershipHash !== expectedOwnershipHash
    || payload.schemaVersion !== 11
    || payload.backend !== 'native-sqlite-v2'
    || payload.finalSeq !== 0
    || payload.gateEmpty !== true
    || payload.triggerVersion !== 1
    || !SHA256_PATTERN.test(payload.triggerSetDigest)
    || !exactKeys(identity, ['dev', 'ino'])
    || canonicalJson(identity) !== canonicalJson(observedIdentity)
    || (verifyDatabaseHash && sha256(fs.readFileSync(fixture.databasePath)) !== fixture.databaseSha256)
  ) {
    throw rejection('NATIVE_ADMISSION_REJECTED', 'Stage B fixture genesis is not exact');
  }
  return payload;
}

function hasBoundedSelector(options) {
  let current = options;
  while (current !== null) {
    if (Object.prototype.hasOwnProperty.call(current, 'bounded')) return true;
    current = Object.getPrototypeOf(current);
  }
  return false;
}

function exactBoundedDependencies(options) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B bounded options are invalid');
  }
  const ownKeys = Reflect.ownKeys(options);
  const allowed = ownKeys.length === 2
    ? ['bounded', 'coordinator']
    : ownKeys.length === 3
      ? ['bounded', 'coordinator', 'sqliteFactory']
      : null;
  if (!allowed || ownKeys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B bounded options are inexact');
  }
  const values = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B bounded options must be data properties');
    }
    values[key] = descriptor.value;
  }
  if (
    values.bounded !== true
    || !isProjectWriteCoordinator(values.coordinator)
    || (allowed.length === 3 && typeof values.sqliteFactory !== 'function')
  ) {
    throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B bounded options are invalid');
  }
  const coordinator = values.coordinator;
  if (
    typeof coordinator.withProjectLogicalRequestSync !== 'function'
    || typeof coordinator.runPendingProjectMaintenanceSync !== 'function'
    || typeof coordinator.assertProjectWriteLease !== 'function'
  ) {
    throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B coordinator capabilities are incomplete');
  }
  return Object.freeze({
    coordinator,
    sqliteFactory: values.sqliteFactory,
    assertProjectWriteLease: coordinator.assertProjectWriteLease,
    runPendingProjectMaintenanceSync: coordinator.runPendingProjectMaintenanceSync,
    withProjectLogicalRequestSync: coordinator.withProjectLogicalRequestSync,
  });
}

function createStageBFixtureStore(fixture, dependencies = {}) {
  validateFixtureDescriptor(fixture);
  const boundedSelected = dependencies !== null
    && (typeof dependencies === 'object' || typeof dependencies === 'function')
    && hasBoundedSelector(dependencies);
  if (boundedSelected) {
    const boundedDependencies = exactBoundedDependencies(dependencies);
    let activeContext = null;
    let coreStore;
    let finalizeLogicalRequest = null;

    function assertDynamicWriterLease() {
      if (!activeContext) {
        const error = new Error('Bounded native operation requires an active logical request');
        error.code = 'PROJECT_WRITE_REENTRANCY';
        throw error;
      }
      return activeContext.assertLease();
    }

    function assertNativeAuthorityLease() {
      if (activeContext) return activeContext.assertLease();
      return true;
    }

    function assertCheckpointMaintenanceLease() {
      if (activeContext) return activeContext.assertLease();
      return boundedDependencies.assertProjectWriteLease(fixture.databasePath);
    }

    function bindLogicalRequestFinalizer(finalizer) {
      if (finalizeLogicalRequest !== null || typeof finalizer !== 'function') {
        throw rejection(
          'NATIVE_ACTIVATION_DISABLED',
          'Bounded native logical finalizer binding is invalid',
        );
      }
      finalizeLogicalRequest = finalizer;
    }

    function runLogicalRequest(callback, finalize = true) {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      return boundedDependencies.withProjectLogicalRequestSync(
        fixture.databasePath,
        (context) => {
          if (activeContext) {
            const error = new Error('A bounded logical request cannot nest');
            error.code = 'PROJECT_WRITE_REENTRANCY';
            throw error;
          }
          activeContext = context;
          try {
            const callbackResult = callback();
            if (finalize && finalizeLogicalRequest !== null) {
              const job = finalizeLogicalRequest();
              if (job !== null) context.registerPendingCheckpoint(job);
            }
            return callbackResult;
          } finally {
            activeContext = null;
          }
        },
      );
    }

    let result;
    try {
      result = runLogicalRequest(() => {
        const controlStore = openControlStore(fixture.controlDirectory, { bounded: true });
        const evidence = controlStore.readEvidence();
        const admissionEvent = evidence.checkpoint?.admissionBasis.admissionEvent
          || evidence.events[0];
        if (!admissionEvent) {
          throw rejection(
            'NATIVE_ADMISSION_REJECTED',
            'Stage B fixture requires one immutable genesis event',
          );
        }
        const payload = validateGenesis(fixture, admissionEvent, {
          verifyDatabaseHash: evidence.checkpoint === null && evidence.events.length === 1,
        });
        const exactFixtureRunId = fixture.fixtureRunId;
        const exactGenesisDigest = fixture.genesisDigest;
        const admissionVerifier = ({ evidence }) => {
          if (
            evidence.length !== 1
            || evidence[0].digest !== exactGenesisDigest
            || evidence[0].payload?.fixtureRunId !== exactFixtureRunId
          ) {
            throw rejection(
              'NATIVE_ADMISSION_REJECTED',
              'Stage B testing authority rejected the genesis',
            );
          }
          return Object.freeze({
            basisKind: 'stage_b_fixture_genesis',
            basisDigest: exactGenesisDigest,
          });
        };
        coreStore = createNativeProjectStoreCore({
          databasePath: fixture.databasePath,
          controlStore,
          dbKey: payload.dbKey,
          projectInstanceIdSha256: payload.projectInstanceIdSha256,
          ownershipHash: payload.ownershipHash,
          assertWriterLease: assertNativeAuthorityLease,
          projectLogicalRequestGuard: assertDynamicWriterLease,
          checkpointRunner: () => boundedDependencies.runPendingProjectMaintenanceSync(
            fixture.databasePath,
          ),
          bindLogicalRequestFinalizer,
          assertCheckpointMaintenanceLease,
          admissionVerifier,
          sqliteFactory: boundedDependencies.sqliteFactory,
        });
        return Object.freeze({
          store: coreStore,
          withProjectLogicalRequestSync: runLogicalRequest,
        });
      }, false);
    } catch (error) {
      if (coreStore?.state === 'active') {
        try {
          coreStore.close();
        } catch (cleanupError) {
          try {
            Object.defineProperty(error, 'cleanupError', {
              configurable: true,
              value: cleanupError,
            });
          } catch {
            // Preserve the project-lease failure when cleanup metadata cannot attach.
          }
        }
      }
      throw error;
    }
    return result;
  }
  if (
    dependencies === null
    || typeof dependencies !== 'object'
    || Array.isArray(dependencies)
    || Object.keys(dependencies).some((key) => !['assertWriterLease', 'sqliteFactory'].includes(key))
    || (
      dependencies.assertWriterLease !== undefined
      && typeof dependencies.assertWriterLease !== 'function'
    )
  ) {
    throw rejection('NATIVE_ACTIVATION_DISABLED', 'Stage B testing dependencies are invalid');
  }
  const controlStore = openControlStore(fixture.controlDirectory);
  const events = controlStore.read();
  if (events.length === 0) {
    throw rejection('NATIVE_ADMISSION_REJECTED', 'Stage B fixture requires one immutable genesis event');
  }
  const payload = validateGenesis(fixture, events[0], { verifyDatabaseHash: events.length === 1 });
  const testingAuthority = () => true;
  const exactFixtureRunId = fixture.fixtureRunId;
  const exactGenesisDigest = fixture.genesisDigest;
  const admissionVerifier = ({ evidence }) => {
    if (
      testingAuthority() !== true
      || evidence.length !== 1
      || evidence[0].digest !== exactGenesisDigest
      || evidence[0].payload?.fixtureRunId !== exactFixtureRunId
    ) {
      throw rejection('NATIVE_ADMISSION_REJECTED', 'Stage B testing authority rejected the genesis');
    }
    return Object.freeze({
      basisKind: 'stage_b_fixture_genesis',
      basisDigest: exactGenesisDigest,
    });
  };
  return createNativeProjectStoreCore({
    databasePath: fixture.databasePath,
    controlStore,
    dbKey: payload.dbKey,
    projectInstanceIdSha256: payload.projectInstanceIdSha256,
    ownershipHash: payload.ownershipHash,
    assertWriterLease: dependencies.assertWriterLease || (() => true),
    admissionVerifier,
    sqliteFactory: dependencies.sqliteFactory,
  });
}

module.exports = { createStageBFixtureStore };
