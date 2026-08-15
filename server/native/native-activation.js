const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('bun:sqlite');

const { getBuildInfo } = require('../build-info');
const { inspectControlStoreEvidence } = require('../control-store');
const {
  canonicalDatabasePath,
  createAtomicStore,
  inspectSqlJsAtomicStore,
} = require('../sqljs-atomic-store');
const {
  FAULT_POINTS,
  crashOnlyFaultPoint,
} = require('../testing/fault-injection');
const { createDatabaseIdentityGuard } = require('./database-identity-guard');
const { assertConsumedNativeActivationReceipt } = require('./native-activation-authority');
const {
  assertProductionNativeActivationReceipt,
} = require('./production-native-activation-authority');
const {
  canonicalTriggerDefinitions,
  canonicalTriggerSetDigest,
  installSchema11Contract,
  inspectSchema11Contract,
} = require('./durability-schema');
const { createNativeProjectStoreCore } = require('./native-project-store');
const {
  requireWindowsNativeDirectoryEntryDurability,
} = require('../platform/windows-native-directory-capability');
const {
  requireWindowsNativeRollbackJournalDurability,
} = require('../platform/windows-native-rollback-capability');

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_GATE_TABLE = '_durability_write_gate';
const NATIVE_TRIGGER_PREFIX = '_mythpen_downgrade_guard__';
const NATIVE_META_KEYS = Object.freeze([
  'durability_backend',
  'durability_commit_seq',
  'durability_trigger_set_digest',
  'durability_trigger_version',
]);
const EVENT_KEYS = ['digest', 'payload', 'prevDigest', 'seq', 'type'];
const PREPARED_KEYS = [
  'activationId',
  'activationMode',
  'backend',
  'cleanV1TerminalDigest',
  'createdAt',
  'dbKey',
  'eventId',
  'formalSha256',
  'markerDigest',
  'ownershipHash',
  'projectInstanceIdSha256',
  'targetSchema',
  'triggerSetDigest',
  'triggerVersion',
  'v1Identity',
  'version',
];
const ACTIVATED_KEYS = [
  'activationId',
  'backend',
  'createdAt',
  'dbKey',
  'eventId',
  'finalIdentity',
  'finalSeq',
  'gateEmpty',
  'ownershipHash',
  'preparedDigest',
  'projectInstanceIdSha256',
  'schemaVersion',
  'triggerSetDigest',
  'triggerVersion',
  'version',
];
const ABORTED_KEYS = [
  'activationId',
  'backend',
  'cleanV1TerminalDigest',
  'createdAt',
  'dbKey',
  'eventId',
  'formalSha256',
  'nativeStateAbsent',
  'ownershipHash',
  'preparedDigest',
  'projectInstanceIdSha256',
  'schemaVersion',
  'v1Identity',
  'version',
];

function activationError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function recoveryRequired(message, cause) {
  return activationError('RECOVERY_REQUIRED', message, cause);
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

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function physicalFileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw activationError('NATIVE_DATABASE_IDENTITY_STALE', 'Activation database is not a single-link plain file');
  }
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function fileAnchor(filePath) {
  const guard = createDatabaseIdentityGuard({ databasePath: filePath });
  try {
    guard.assertCurrent();
    const bytes = fs.readFileSync(filePath);
    guard.assertCurrent();
    return Object.freeze({
      identity: guard.identity,
      sha256: sha256(bytes),
    });
  } finally {
    guard.close();
  }
}

function assertEventShape(event, keys, type) {
  if (
    !exactKeys(event, EVENT_KEYS)
    || event.type !== type
    || !Number.isSafeInteger(event.seq)
    || event.seq < 1
    || !HASH_PATTERN.test(event.digest || '')
    || (event.prevDigest !== null && !HASH_PATTERN.test(event.prevDigest || ''))
    || !exactKeys(event.payload, keys)
  ) {
    throw recoveryRequired(`${type} evidence is inexact`);
  }
  return event.payload;
}

function validatePrepared(event, expected) {
  const payload = assertEventShape(
    event,
    PREPARED_KEYS,
    'sqlite.native.activation.prepared',
  );
  if (
    payload.version !== 1
    || !UUID_V4_PATTERN.test(payload.eventId || '')
    || !UUID_V4_PATTERN.test(payload.activationId || '')
    || !HASH_PATTERN.test(payload.cleanV1TerminalDigest || '')
    || !HASH_PATTERN.test(payload.formalSha256 || '')
    || !HASH_PATTERN.test(payload.markerDigest || '')
    || !HASH_PATTERN.test(payload.dbKey || '')
    || !HASH_PATTERN.test(payload.projectInstanceIdSha256 || '')
    || !HASH_PATTERN.test(payload.ownershipHash || '')
    || payload.targetSchema !== 11
    || payload.backend !== 'native-sqlite-v2'
    || payload.triggerVersion !== 1
    || payload.triggerSetDigest !== canonicalTriggerSetDigest()
    || !exactKeys(payload.v1Identity, ['dev', 'ino'])
    || payload.activationMode !== expected.activationMode
    || payload.dbKey !== expected.dbKey
    || (typeof expected.markerDigest === 'string' && payload.markerDigest !== expected.markerDigest)
  ) {
    throw recoveryRequired('activation.prepared payload does not match the activation contract');
  }
  return payload;
}

function validateActivated(event, prepared, expected) {
  const payload = assertEventShape(
    event,
    ACTIVATED_KEYS,
    'sqlite.native.activation.activated',
  );
  if (
    event.prevDigest !== prepared.event.digest
    || payload.version !== 1
    || !UUID_V4_PATTERN.test(payload.eventId || '')
    || payload.activationId !== prepared.payload.activationId
    || payload.preparedDigest !== prepared.event.digest
    || payload.dbKey !== expected.dbKey
    || payload.projectInstanceIdSha256 !== prepared.payload.projectInstanceIdSha256
    || payload.ownershipHash !== prepared.payload.ownershipHash
    || payload.schemaVersion !== 11
    || payload.backend !== 'native-sqlite-v2'
    || payload.finalSeq !== 0
    || payload.gateEmpty !== true
    || payload.triggerVersion !== 1
    || payload.triggerSetDigest !== prepared.payload.triggerSetDigest
    || !sameIdentity(payload.finalIdentity, prepared.payload.v1Identity)
  ) {
    throw recoveryRequired('activation.activated payload does not match its prepared basis');
  }
  return payload;
}

function validateAborted(event, prepared, expected) {
  const payload = assertEventShape(
    event,
    ABORTED_KEYS,
    'sqlite.native.activation.aborted',
  );
  if (
    event.prevDigest !== payload.cleanV1TerminalDigest
    || payload.version !== 1
    || !UUID_V4_PATTERN.test(payload.eventId || '')
    || payload.activationId !== prepared.payload.activationId
    || payload.preparedDigest !== prepared.event.digest
    || payload.dbKey !== expected.dbKey
    || payload.projectInstanceIdSha256 !== prepared.payload.projectInstanceIdSha256
    || payload.ownershipHash !== prepared.payload.ownershipHash
    || payload.schemaVersion !== 10
    || payload.backend !== 'native-sqlite-v2'
    || !HASH_PATTERN.test(payload.cleanV1TerminalDigest || '')
    || !HASH_PATTERN.test(payload.formalSha256 || '')
    || !exactKeys(payload.v1Identity, ['dev', 'ino'])
    || typeof payload.v1Identity.dev !== 'string'
    || typeof payload.v1Identity.ino !== 'string'
    || payload.nativeStateAbsent !== true
  ) {
    throw recoveryRequired('activation.aborted payload does not match its prepared basis');
  }
  return payload;
}

function activationProjection(events, expected) {
  let openPrepared = null;
  let activatedPrepared = null;
  let aborted = null;
  let activated = null;
  let previous = null;
  for (const event of events) {
    if (event.type === 'sqlite.native.activation.prepared') {
      if (openPrepared || activated) throw recoveryRequired('Activation evidence has an ambiguous state');
      openPrepared = Object.freeze({ event, payload: validatePrepared(event, expected) });
      previous = event;
      continue;
    }
    if (event.type === 'sqlite.native.activation.activated') {
      if (!openPrepared || activated) throw recoveryRequired('Activated evidence has no unique prepared basis');
      activated = Object.freeze({ event, payload: validateActivated(event, openPrepared, expected) });
      activatedPrepared = openPrepared;
      openPrepared = null;
      previous = event;
      continue;
    }
    if (event.type === 'sqlite.native.activation.aborted') {
      if (!openPrepared || activated) throw recoveryRequired('Aborted evidence has no unique prepared basis');
      aborted = Object.freeze({
        event,
        payload: validateAborted(event, openPrepared, expected),
        prepared: openPrepared,
      });
      if (
        previous?.digest !== aborted.payload.cleanV1TerminalDigest
        || !['sqlite.publish.committed', 'sqlite.publish.rolled_back'].includes(previous.type)
      ) {
        throw recoveryRequired('Aborted evidence does not follow an exact clean v1 terminal');
      }
      openPrepared = null;
    }
    previous = event;
  }
  return Object.freeze({
    prepared: activated ? activatedPrepared : openPrepared,
    aborted,
    activated,
  });
}

function assertConfigAndWriterLeases(options) {
  if (
    typeof options.assertConfigLifecycleLease !== 'function'
    || typeof options.assertWriterLease !== 'function'
  ) {
    throw activationError('NATIVE_ACTIVATION_DISABLED', 'Activation lease capabilities are incomplete');
  }
  options.assertConfigLifecycleLease();
  options.assertWriterLease();
}

function assertSchema10Preflight(inspection, expectedInstance) {
  if (inspection.reasonCode === 'PROJECT_SCHEMA_TOO_NEW') {
    throw activationError('PROJECT_SCHEMA_TOO_NEW', 'Project schema is newer than the activation source contract');
  }
  if (
    inspection.state !== 'clean'
    || inspection.database?.isProject !== true
    || inspection.database.schema !== 10
    || inspection.database.integrity?.integrityCheck !== 'ok'
    || inspection.database.integrity?.foreignKeyCheck !== 'ok'
    || inspection.database.triggerVersion !== null
    || inspection.database.projectMetaTriggerSetDigest !== null
    || inspection.database.projectInstanceIdSha256 !== expectedInstance
  ) {
    throw recoveryRequired('Schema10 activation source preflight is not exact');
  }
}

function assertNoNativeSchemaResidue(databasePath) {
  const guard = createDatabaseIdentityGuard({ databasePath });
  let database;
  try {
    guard.assertCurrent();
    database = new Database(guard.canonicalPath, { create: false, readonly: true, strict: true });
    guard.assertCurrent();
    const gateRows = database.query(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
    ).all(NATIVE_GATE_TABLE);
    const metaPlaceholders = NATIVE_META_KEYS.map(() => '?').join(', ');
    const reservedRows = database.query(
      `SELECT key FROM project_meta WHERE key IN (${metaPlaceholders}) ORDER BY key`,
    ).all(...NATIVE_META_KEYS);
    const canonicalTriggerNames = canonicalTriggerDefinitions().map(({ name }) => name);
    const triggerPlaceholders = canonicalTriggerNames.map(() => '?').join(', ');
    const triggerRows = database.query(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (`
      + `name IN (${triggerPlaceholders}) OR substr(name, 1, ?) = ?) ORDER BY name`,
    ).all(
      ...canonicalTriggerNames,
      NATIVE_TRIGGER_PREFIX.length,
      NATIVE_TRIGGER_PREFIX,
    );
    guard.assertCurrent();
    if (gateRows.length !== 0 || reservedRows.length !== 0 || triggerRows.length !== 0) {
      throw recoveryRequired('Schema10 activation source contains partial native schema residue');
    }
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired('Schema10 native residue preflight cannot be proven exact', cause);
  } finally {
    database?.close();
    guard.close();
  }
}

function latestCleanV1Terminal(events) {
  const terminal = [...events].reverse().find((event) => (
    event.type === 'sqlite.publish.committed' || event.type === 'sqlite.publish.rolled_back'
  ));
  if (!terminal || !HASH_PATTERN.test(terminal.digest || '')) {
    throw recoveryRequired('Activation source has no clean v1 terminal');
  }
  return terminal;
}

function postCheckExact(controlDirectory, type, digest) {
  const evidence = inspectControlStoreEvidence(controlDirectory).events;
  const exact = evidence.filter((event) => event.type === type && event.digest === digest);
  if (exact.length !== 1) {
    throw recoveryRequired(`${type} post-check is not exact`);
  }
  return evidence;
}

function inspectExactSchema11(databasePath, expected, { readCommittedFinalSeq = false } = {}) {
  const guard = createDatabaseIdentityGuard({ databasePath });
  let database;
  try {
    guard.assertCurrent();
    database = new Database(guard.canonicalPath, { create: false, readonly: true, strict: true });
    guard.assertCurrent();
    let expectedFinalSeq = 0;
    if (readCommittedFinalSeq) {
      const value = database.query(
        "SELECT value FROM project_meta WHERE key = 'durability_commit_seq'",
      ).get()?.value;
      if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
        throw recoveryRequired('Activated durability commit sequence is not canonical');
      }
      expectedFinalSeq = Number(value);
      if (!Number.isSafeInteger(expectedFinalSeq) || expectedFinalSeq < 0) {
        throw recoveryRequired('Activated durability commit sequence is outside the safe range');
      }
    }
    const contract = inspectSchema11Contract(database, { expectedFinalSeq });
    guard.assertCurrent();
    if (
      contract.projectInstanceIdSha256 !== expected.projectInstanceIdSha256
      || contract.triggerSetDigest !== expected.triggerSetDigest
    ) {
      throw recoveryRequired('Schema11 predicate differs from activation evidence');
    }
    return contract;
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired('Schema11 predicate cannot be proven exact', cause);
  } finally {
    database?.close();
    guard.close();
  }
}

function mintAdmissionVerifier(validated) {
  const exactDigest = validated.activated.event.digest;
  const activationEventDigests = validated.activationEventDigests;
  return ({ evidence, activationPrefix }) => {
    if (
      !Array.isArray(evidence)
      || evidence.length !== 1
      || evidence[0].digest !== exactDigest
      || !Array.isArray(activationPrefix)
      || canonicalJson(activationPrefix
        .filter((event) => event.type.startsWith('sqlite.native.activation.'))
        .map((event) => event.digest)) !== canonicalJson(activationEventDigests)
      || activationPrefix.at(-1)?.digest !== exactDigest
    ) {
      throw recoveryRequired('Native activation admission prefix changed');
    }
    return Object.freeze({ basisKind: 'native_activation', basisDigest: exactDigest });
  };
}

function openActivatedNativeStore(options, evidence, projection, contract) {
  const activatedIndex = evidence.findIndex((event) => event.digest === projection.activated.event.digest);
  if (activatedIndex < 0) throw recoveryRequired('Activated basis disappeared from ControlStore');
  const ownershipHash = projection.activated.payload.ownershipHash;
  const admissionVerifier = mintAdmissionVerifier(Object.freeze({
    prepared: projection.prepared,
    activated: projection.activated,
    activationEventDigests: evidence
      .filter((event) => event.type.startsWith('sqlite.native.activation.'))
      .map((event) => event.digest),
  }));
  return createNativeProjectStoreCore({
    databasePath: options.databasePath,
    controlStore: options.controlStore,
    dbKey: options.dbKey,
    projectInstanceIdSha256: contract.projectInstanceIdSha256,
    ownershipHash,
    assertWriterLease: options.assertWriterLease,
    admissionVerifier,
    admissionEventDigest: projection.activated.event.digest,
  });
}

function activateNativeProjectCore(options = {}) {
  const build = getBuildInfo();
  let productionProfile = null;
  let productionReceipt = null;
  if (build.nativeActivationMode === 'production') {
    productionProfile = requireWindowsNativeRollbackJournalDurability();
    requireWindowsNativeDirectoryEntryDurability();
    if (
      typeof options.databasePath !== 'string'
      || !HASH_PATTERN.test(options.dbKey || '')
    ) {
      throw activationError('DURABILITY_UNSUPPORTED', 'Production activation path binding is incomplete');
    }
    const productionCanonicalPath = canonicalDatabasePath(path.resolve(options.databasePath));
    productionReceipt = assertProductionNativeActivationReceipt(options.activationReceipt, {
      canonicalDatabasePath: productionCanonicalPath,
      dbKey: options.dbKey,
    });
  }
  assertConfigAndWriterLeases(options);
  if (
    typeof options.databasePath !== 'string'
    || typeof options.controlDirectory !== 'string'
    || !options.controlStore
    || typeof options.sqlModule?.Database !== 'function'
    || typeof options.assertDurability !== 'function'
  ) {
    throw activationError('NATIVE_ACTIVATION_DISABLED', 'Activation dependencies are incomplete');
  }
  options.assertDurability();
  assertConfigAndWriterLeases(options);
  const databasePath = path.resolve(options.databasePath);
  const dbKey = sha256(canonicalDatabasePath(databasePath));
  if (options.dbKey !== dbKey || path.resolve(options.controlStore.directory) !== path.resolve(options.controlDirectory)) {
    throw activationError('NATIVE_ACTIVATION_DISABLED', 'Activation path binding is inexact');
  }
  const expected = Object.freeze({
    activationMode: build.nativeActivationMode,
    dbKey,
    markerDigest: productionProfile?.authorizationDigest || null,
  });
  let evidence = inspectControlStoreEvidence(options.controlDirectory).events;
  let projection = activationProjection(evidence, expected);
  let v1Store = null;

  if (projection.activated) {
    const contract = inspectExactSchema11(
      databasePath,
      projection.activated.payload,
      { readCommittedFinalSeq: true },
    );
    if (!sameIdentity(physicalFileIdentity(databasePath), projection.activated.payload.finalIdentity)) {
      throw recoveryRequired('Activated database identity changed');
    }
    return openActivatedNativeStore(options, evidence, projection, contract);
  }

  let sourceAnchor = null;
  if (projection.prepared) {
    sourceAnchor = Object.freeze({
      identity: projection.prepared.payload.v1Identity,
      sha256: projection.prepared.payload.formalSha256,
    });
  } else if (!projection.aborted && build.nativeActivationMode !== 'production') {
    assertConsumedNativeActivationReceipt(options.activationReceipt);
  }

  let schema11Contract = null;
  if (projection.prepared) {
    try {
      schema11Contract = inspectExactSchema11(databasePath, projection.prepared.payload);
    } catch {
      // The exact v1 recovery path below decides whether this is the original
      // clean anchor, a valid replacement anchor, or a fail-closed residue.
    }
  }

  if (!schema11Contract) {
    v1Store = createAtomicStore({
      assertWriterLease: options.assertWriterLease,
      filePath: databasePath,
      controlStore: options.controlStore,
      sqlModule: options.sqlModule,
    });
    try {
      v1Store.recover();
      assertConfigAndWriterLeases(options);
      evidence = inspectControlStoreEvidence(options.controlDirectory).events;
      projection = activationProjection(evidence, expected);
      const terminal = latestCleanV1Terminal(evidence);
      const inspection = inspectSqlJsAtomicStore({
        controlDirectory: options.controlDirectory,
        events: evidence,
        filePath: databasePath,
        sqlModule: options.sqlModule,
        supportedSchemaVersion: 10,
      });
      const anchor = fileAnchor(databasePath);
      const projectInstanceIdSha256 = inspection.database?.projectInstanceIdSha256;
      assertSchema10Preflight(inspection, projectInstanceIdSha256);

      if (projection.prepared) {
        if (
          inspection.database.projectInstanceIdSha256
          !== projection.prepared.payload.projectInstanceIdSha256
        ) {
          throw recoveryRequired('Prepared activation project instance changed during v1 recovery');
        }
        const anchorChanged = (
          anchor.sha256 !== sourceAnchor.sha256
          || !sameIdentity(anchor.identity, sourceAnchor.identity)
        );
        if (anchorChanged) {
          if (terminal.digest === projection.prepared.payload.cleanV1TerminalDigest) {
            throw recoveryRequired('Prepared activation changed formal anchor without new clean v1 terminal');
          }
          if (terminal.digest !== evidence.at(-1)?.digest) {
            throw recoveryRequired('Prepared activation v1 terminal is not the durable ControlStore tail');
          }
          assertNoNativeSchemaResidue(databasePath);
          const prepared = projection.prepared;
          const payload = Object.freeze({
            version: 1,
            eventId: randomUUID(),
            activationId: prepared.payload.activationId,
            createdAt: new Date().toISOString(),
            preparedDigest: prepared.event.digest,
            cleanV1TerminalDigest: terminal.digest,
            formalSha256: anchor.sha256,
            v1Identity: anchor.identity,
            projectInstanceIdSha256,
            schemaVersion: 10,
            backend: 'native-sqlite-v2',
            nativeStateAbsent: true,
            dbKey,
            ownershipHash: prepared.payload.ownershipHash,
          });
          const appended = options.controlStore.compareAndAppend(terminal.digest, {
            type: 'sqlite.native.activation.aborted',
            payload,
          });
          evidence = postCheckExact(
            options.controlDirectory,
            'sqlite.native.activation.aborted',
            appended.digest,
          );
          projection = activationProjection(evidence, expected);
        }
      }

      if (!projection.prepared) {
        assertNoNativeSchemaResidue(databasePath);
        const priorPrepared = projection.aborted?.prepared || null;
        if (
          projection.aborted
          && (
            terminal.digest !== projection.aborted.payload.cleanV1TerminalDigest
            || anchor.sha256 !== projection.aborted.payload.formalSha256
            || !sameIdentity(anchor.identity, projection.aborted.payload.v1Identity)
          )
        ) {
          throw recoveryRequired('Aborted activation recovery anchor no longer matches durable evidence');
        }
        if (
          priorPrepared
          && projectInstanceIdSha256 !== priorPrepared.payload.projectInstanceIdSha256
        ) {
          throw recoveryRequired('Aborted activation project instance changed before retry');
        }
        const markerDigest = priorPrepared
          ? priorPrepared.payload.markerDigest
          : build.nativeActivationMode === 'production'
            ? productionReceipt.authorizationDigest
            : assertConsumedNativeActivationReceipt(options.activationReceipt).markerDigest;
        const ownershipHash = sha256(canonicalJson({
          dbKey,
          identity: anchor.identity,
          projectInstanceIdSha256,
        }));
        const payload = Object.freeze({
          version: 1,
          eventId: randomUUID(),
          activationId: randomUUID(),
          createdAt: new Date().toISOString(),
          cleanV1TerminalDigest: terminal.digest,
          formalSha256: anchor.sha256,
          v1Identity: anchor.identity,
          projectInstanceIdSha256,
          targetSchema: 11,
          triggerVersion: 1,
          triggerSetDigest: canonicalTriggerSetDigest(),
          backend: 'native-sqlite-v2',
          activationMode: build.nativeActivationMode,
          markerDigest,
          dbKey,
          ownershipHash,
        });
        const appended = options.controlStore.compareAndAppend(evidence.at(-1)?.digest ?? null, {
          type: 'sqlite.native.activation.prepared',
          payload,
        });
        evidence = postCheckExact(
          options.controlDirectory,
          'sqlite.native.activation.prepared',
          appended.digest,
        );
        projection = activationProjection(evidence, expected);
        sourceAnchor = anchor;
      }
      crashOnlyFaultPoint(FAULT_POINTS.NATIVE_ACTIVATION_AFTER_PREPARED_POSTCHECK, {
        activationId: projection.prepared.payload.activationId,
      });
      v1Store.fence();
      v1Store.close();
      v1Store = null;
      crashOnlyFaultPoint(FAULT_POINTS.NATIVE_ACTIVATION_AFTER_V1_FENCE_CLOSE, {
        activationId: projection.prepared.payload.activationId,
      });
      const rechecked = fileAnchor(databasePath);
      if (
        rechecked.sha256 !== sourceAnchor.sha256
        || !sameIdentity(rechecked.identity, sourceAnchor.identity)
      ) {
        throw recoveryRequired('Activation source changed after the v1 logical fence');
      }
      crashOnlyFaultPoint(FAULT_POINTS.NATIVE_ACTIVATION_AFTER_SOURCE_RECHECK, {
        activationId: projection.prepared.payload.activationId,
      });
      const installGuard = createDatabaseIdentityGuard({ databasePath });
      let database;
      try {
        installGuard.assertCurrent();
        if (!sameIdentity(installGuard.identity, sourceAnchor.identity)) {
          throw recoveryRequired('Activation source identity changed before schema11 install');
        }
        database = new Database(installGuard.canonicalPath, { create: false, strict: true });
        installGuard.assertCurrent();
        schema11Contract = installSchema11Contract(database);
        installGuard.assertCurrent();
      } finally {
        database?.close();
        installGuard.close();
      }
      crashOnlyFaultPoint(FAULT_POINTS.NATIVE_ACTIVATION_AFTER_SCHEMA11_INSTALL, {
        activationId: projection.prepared.payload.activationId,
      });
    } finally {
      try {
        v1Store?.close();
      } catch {
        // Preserve the activation/recovery error; no native facade escaped.
      }
    }
  }

  assertConfigAndWriterLeases(options);
  schema11Contract = inspectExactSchema11(databasePath, projection.prepared.payload);
  crashOnlyFaultPoint(FAULT_POINTS.NATIVE_ACTIVATION_AFTER_POSTCOMMIT_INSPECT, {
    activationId: projection.prepared.payload.activationId,
  });
  const finalIdentity = physicalFileIdentity(databasePath);
  if (!sameIdentity(finalIdentity, projection.prepared.payload.v1Identity)) {
    throw recoveryRequired('Schema11 final identity differs from the prepared source');
  }
  evidence = inspectControlStoreEvidence(options.controlDirectory).events;
  projection = activationProjection(evidence, expected);
  if (!projection.activated) {
    const prepared = projection.prepared;
    const payload = Object.freeze({
      version: 1,
      eventId: randomUUID(),
      activationId: prepared.payload.activationId,
      createdAt: new Date().toISOString(),
      preparedDigest: prepared.event.digest,
      schemaVersion: 11,
      backend: 'native-sqlite-v2',
      finalSeq: 0,
      gateEmpty: true,
      triggerVersion: 1,
      triggerSetDigest: schema11Contract.triggerSetDigest,
      finalIdentity,
      dbKey,
      projectInstanceIdSha256: schema11Contract.projectInstanceIdSha256,
      ownershipHash: prepared.payload.ownershipHash,
    });
    const appended = options.controlStore.compareAndAppend(evidence.at(-1)?.digest ?? null, {
      type: 'sqlite.native.activation.activated',
      payload,
    });
    evidence = postCheckExact(
      options.controlDirectory,
      'sqlite.native.activation.activated',
      appended.digest,
    );
    projection = activationProjection(evidence, expected);
  }
  crashOnlyFaultPoint(FAULT_POINTS.NATIVE_ACTIVATION_AFTER_ACTIVATED_POSTCHECK, {
    activationId: projection.prepared.payload.activationId,
  });
  const nativeStore = openActivatedNativeStore(options, evidence, projection, schema11Contract);
  crashOnlyFaultPoint(FAULT_POINTS.NATIVE_ACTIVATION_AFTER_NATIVE_REOPEN, {
    activationId: projection.prepared.payload.activationId,
  });
  return nativeStore;
}

module.exports = { activateNativeProjectCore };

Object.defineProperty(module.exports, 'assertActivatedNativeEvidence', {
  value({ controlDirectory, dbKey }) {
    if (typeof controlDirectory !== 'string' || !HASH_PATTERN.test(dbKey || '')) {
      throw recoveryRequired('Activated evidence path binding is invalid');
    }
    const build = getBuildInfo();
    const markerDigest = build.nativeActivationMode === 'production'
      ? requireWindowsNativeRollbackJournalDurability().authorizationDigest
      : undefined;
    if (build.nativeActivationMode === 'production') {
      requireWindowsNativeDirectoryEntryDurability();
    }
    const projection = activationProjection(
      inspectControlStoreEvidence(controlDirectory).events,
      { activationMode: build.nativeActivationMode, dbKey, markerDigest },
    );
    if (!projection.activated) throw recoveryRequired('Activated native evidence is missing');
    return projection.activated.payload;
  },
  enumerable: false,
  writable: false,
  configurable: false,
});
