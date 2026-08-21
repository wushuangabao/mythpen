'use strict';

const { createHash } = require('node:crypto');

const { assertCanonicalUuid, manuscriptError } = require('./contracts');

const serviceRecords = new WeakMap();

function recoveryRequired(reason, details = {}, cause) {
  return manuscriptError('RECOVERY_REQUIRED', { reason, ...details }, cause);
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

function capturePort(value, methods, label) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new TypeError(`${label} is required`);
  }
  const captured = {};
  for (const method of methods) {
    if (typeof value[method] !== 'function') throw new TypeError(`${label}.${method} is required`);
    captured[method] = value[method].bind(value);
  }
  return Object.freeze(captured);
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

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function digestPlain(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (isPlainObject(input)) {
      const result = {};
      for (const key of Object.keys(input).sort()) result[key] = normalize(input[key]);
      return result;
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function snapshotInput(value) {
  const descriptors = exactDescriptors(value, [
    'baseGeneration',
    'childJournalId',
    'logicalRequestId',
    'migrationId',
    'projectInstanceId',
    'projectRootProbe',
    'sourceBasis',
    'targetGeneration',
  ], 'migration request');
  const baseGeneration = assertGeneration(descriptors.baseGeneration.value, 'baseGeneration');
  const targetGeneration = assertGeneration(descriptors.targetGeneration.value, 'targetGeneration');
  if (targetGeneration !== baseGeneration + 1) throw new TypeError('targetGeneration must equal baseGeneration + 1');
  const sourceBasis = descriptors.sourceBasis.value;
  if (!Object.isFrozen(sourceBasis) || !isPlainObject(sourceBasis)) {
    throw new TypeError('sourceBasis must be the original frozen source basis');
  }
  assertDigest(sourceBasis.basisDigest, 'sourceBasis.basisDigest');
  const projectRootProbe = descriptors.projectRootProbe.value;
  if (!Object.isFrozen(projectRootProbe) || !isPlainObject(projectRootProbe)) {
    throw new TypeError('projectRootProbe must be the original frozen path probe');
  }
  return Object.freeze({
    migrationId: assertCanonicalUuid(descriptors.migrationId.value, 'migration_id'),
    childJournalId: assertCanonicalUuid(descriptors.childJournalId.value, 'child_journal_id'),
    logicalRequestId: nonEmpty(descriptors.logicalRequestId.value, 'logicalRequestId'),
    projectInstanceId: assertCanonicalUuid(
      descriptors.projectInstanceId.value,
      'project_instance_id',
    ),
    sourceBasis,
    projectRootProbe,
    baseGeneration,
    targetGeneration,
  });
}

async function resumeDurableMigration(record, request) {
  let persisted;
  try {
    persisted = record.journal.read(request.migrationId);
  } catch (cause) {
    if (
      cause?.code === 'RECOVERY_REQUIRED'
      && cause.details?.reason === 'migration journal does not exist'
    ) return null;
    throw cause;
  }
  if (
    persisted.projectInstanceId !== request.projectInstanceId
    || persisted.logicalRequestId !== request.logicalRequestId
    || persisted.baseGeneration !== request.baseGeneration
    || persisted.targetGeneration !== request.targetGeneration
    || persisted.sourceBasisDigest !== request.sourceBasis.basisDigest
    || (persisted.childReservation?.childJournalId !== undefined
      && persisted.childReservation.childJournalId !== request.childJournalId)
  ) throw recoveryRequired('durable migration request binding changed', {
    migrationId: request.migrationId,
    state: persisted.state,
  });
  if (
    persisted.state === 'activation_intent'
    || persisted.state === 'activated'
    || persisted.state === 'migration_aborted'
  ) return record.journal.recover(request.migrationId);
  throw recoveryRequired('durable migration state requires explicit recovery', {
    migrationId: request.migrationId,
    state: persisted.state,
  });
}

class MigrationService {
  constructor(options) {
    const descriptors = exactDescriptors(options, [
      'childJournal',
      'database',
      'directories',
      'journal',
      'projection',
      'route',
      'source',
      'store',
      'uidReservations',
    ], 'MigrationService options');
    const journal = descriptors.journal.value;
    if (
      journal === null
      || typeof journal !== 'object'
      || !['authority', 'read', 'recordDatabaseCandidate', 'recordFilePublicationStarted',
        'recordFilesCandidate', 'recordFilesPublished', 'recordRouteFenced',
        'recordSourceSnapshot', 'recordActivated', 'reserve', 'beginActivation',
        'prepareMigrationContext', 'recover']
        .every((method) => typeof journal[method] === 'function')
    ) throw new TypeError('journal is invalid');
    serviceRecords.set(this, Object.freeze({
      journal,
      uidReservations: capturePort(descriptors.uidReservations.value, [
        'assertMigrationIdentities',
        'reserveMigrationIdentities',
        'resumeMigrationIdentities',
      ], 'uidReservations'),
      route: capturePort(descriptors.route.value, ['abort', 'activate', 'fence'], 'route'),
      directories: capturePort(descriptors.directories.value, ['cleanup', 'ensure', 'plan'], 'directories'),
      source: capturePort(descriptors.source.value, ['capture'], 'source'),
      store: capturePort(descriptors.store.value, ['buildClosure', 'finalizeCandidate'], 'store'),
      projection: capturePort(descriptors.projection.value, ['buildTarget'], 'projection'),
      childJournal: capturePort(descriptors.childJournal.value, [
        'bindTarget',
        'prepare',
        'publishFiles',
        'stageAssets',
      ], 'childJournal'),
      database: capturePort(descriptors.database.value, ['activate', 'build'], 'database'),
    }));
    Object.freeze(this);
  }

  async migrate(input) {
    const record = serviceRecords.get(this);
    if (!record) throw new TypeError('invalid MigrationService receiver');
    const request = snapshotInput(input);
    const durableResult = await resumeDurableMigration(record, request);
    if (durableResult !== null) return durableResult;
    let reserved;
    try {
      reserved = await record.uidReservations.reserveMigrationIdentities({
        migrationId: request.migrationId,
        projectInstanceId: request.projectInstanceId,
        sourceBasis: request.sourceBasis,
        projectRootProbe: request.projectRootProbe,
      });
    } catch (cause) {
      if (cause?.code === 'UID_RESERVATION_COLLISION') throw cause;
      throw recoveryRequired('migration identity reservation failed', {
        migrationId: request.migrationId,
      }, cause);
    }
    if (
      !isPlainObject(reserved)
      || !Object.isFrozen(reserved)
      || reserved.migrationReservation === undefined
      || reserved.authority === undefined
    ) throw new TypeError('uid reservation result is invalid');
    if (
      !Object.isFrozen(reserved.migrationReservation)
      || !Array.isArray(reserved.migrationReservation.localIdentityPlan)
      || !Object.isFrozen(reserved.migrationReservation.localIdentityPlan)
    ) throw new TypeError('migration reservation localIdentityPlan is invalid');

    const directoryPlan = await record.directories.plan({
      migrationId: request.migrationId,
      projectRootProbe: request.projectRootProbe,
    });
    const reservationAuthority = await record.journal.reserve(Object.freeze({
      migrationId: request.migrationId,
      logicalRequestId: request.logicalRequestId,
      baseGeneration: request.baseGeneration,
      targetGeneration: request.targetGeneration,
      sourceBasisDigest: request.sourceBasis.basisDigest,
      migrationReservation: reserved.migrationReservation,
    }));

    // Reservation is durable before this first target-side effect.
    const routeEvidence = await record.route.fence(Object.freeze({
      migrationId: request.migrationId,
      observation: record.journal.authority().readObservation(),
      directoryPlan,
    }));
    const routeAuthority = await record.journal.recordRouteFenced(
      reservationAuthority,
      routeEvidence,
      directoryPlan,
    );
    const targetEnumerationSnapshot = await record.directories.ensure(Object.freeze({
      migrationId: request.migrationId,
      directoryPlan,
    }));
    const sourceSnapshot = await record.source.capture(Object.freeze({
      migrationId: request.migrationId,
      sourceBasis: request.sourceBasis,
      migrationReservation: reserved.migrationReservation,
      readOnly: true,
    }));
    const sourceAuthority = await record.journal.recordSourceSnapshot(routeAuthority, sourceSnapshot);

    const localIdentityPlan = record.uidReservations.assertMigrationIdentities({
      authority: reserved.authority,
      migrationReservation: reserved.migrationReservation,
      localIdentityPlan: reserved.migrationReservation.localIdentityPlan,
    });
    const buildResult = await record.store.buildClosure(
      targetEnumerationSnapshot,
      Object.freeze({
        kind: 'migration.full_snapshot',
        sourceSnapshot,
        localIdentityPlan,
      }),
      Object.freeze([]),
      reserved.migrationReservation,
    );
    if (!isPlainObject(buildResult) || !Array.isArray(buildResult.closure)) {
      throw new TypeError('migration buildClosure result is invalid');
    }
    const closureDigest = assertDigest(
      buildResult.closureDigest ?? buildResult.digest,
      'buildResult.closureDigest',
    );
    const childReservation = Object.freeze({
      version: 1,
      childJournalId: request.childJournalId,
    });
    const partialManifest = Object.freeze({
      version: 1,
      childJournalId: request.childJournalId,
      closureDigest,
    });
    const candidateAuthority = await record.journal.recordFilesCandidate(
      sourceAuthority,
      Object.freeze({
        childJournalId: request.childJournalId,
        logicalRequestId: request.logicalRequestId,
        projectionBasisDigest: request.sourceBasis.basisDigest,
        closureDigest,
        targetGeneration: request.targetGeneration,
        targetBindingDigest: digestPlain(Object.freeze({
          migrationId: request.migrationId,
          projectInstanceId: request.projectInstanceId,
          targetGeneration: request.targetGeneration,
        })),
        childReservation,
        partialManifest,
      }),
    );

    const staged = await record.childJournal.stageAssets({
      journalId: request.childJournalId,
      logicalRequestId: request.logicalRequestId,
      baseGeneration: request.baseGeneration,
      targetGeneration: request.targetGeneration,
      basisDigest: request.sourceBasis.basisDigest,
      closure: buildResult.closure,
      identityReservation: reserved.migrationReservation,
      parent: Object.freeze({ kind: 'migration', journalId: request.migrationId }),
      parentReservationAuthority: candidateAuthority,
    });
    const candidate = record.store.finalizeCandidate(buildResult, staged.stagedAfterFacts);
    const target = record.projection.buildTarget({
      candidate,
      currentProjection: sourceSnapshot.currentProjection,
      ignoredLedger: sourceSnapshot.ignoredLedger,
      localIdentityPlan,
      targetGeneration: request.targetGeneration,
      projectedAt: sourceSnapshot.projectedAt,
    });
    const bound = await record.childJournal.bindTarget({
      stagedAssets: staged.stagedAssets,
      projectionTarget: target,
    });
    const pinAuthority = await record.journal.recordFilePublicationStarted(
      candidateAuthority,
      Object.freeze({ manifest: bound.manifest }),
    );
    await record.childJournal.prepare({
      preparedAssets: bound.preparedAssets,
      parentPinAuthority: pinAuthority,
    });
    const childResult = await record.childJournal.publishFiles(request.childJournalId);
    const filesAuthority = await record.journal.recordFilesPublished(
      pinAuthority,
      Object.freeze({ disposition: childResult.state === 'files_published' ? 'after' : 'unknown' }),
    );
    const databaseCandidate = await record.database.build({
      migrationId: request.migrationId,
      sourceSnapshot,
      migrationReservation: reserved.migrationReservation,
      target,
      manifest: bound.manifest,
    });
    const databaseAuthority = await record.journal.recordDatabaseCandidate(
      filesAuthority,
      databaseCandidate,
    );
    const activationAuthority = await record.journal.beginActivation(databaseAuthority);
    const migrationContext = record.journal.prepareMigrationContext(
      activationAuthority,
      Object.freeze({
        sourcePath: databaseCandidate.sourcePath,
        sourceIdentity: databaseCandidate.sourceIdentity,
        sourceSha256: databaseCandidate.sourceSha256,
        candidatePath: databaseCandidate.candidatePath,
        candidateIdentity: databaseCandidate.candidateIdentity,
        candidateSha256: databaseCandidate.candidateDigest,
      }),
    );
    const activationRouteEvidence = await record.route.activate(Object.freeze({
      migrationId: request.migrationId,
      observation: record.journal.authority().readObservation(),
      migrationContext,
      target,
      databaseCandidate,
    }));
    const databaseEvidence = await record.database.activate({
      migrationId: request.migrationId,
      target,
      databaseCandidate,
      migrationContext,
      routeEvidence: activationRouteEvidence,
    });
    return record.journal.recordActivated(activationAuthority, databaseEvidence);
  }

  async recover(migrationId) {
    const record = serviceRecords.get(this);
    return record.journal.recover(assertCanonicalUuid(migrationId, 'migration_id'));
  }
}

module.exports = {
  MigrationService,
};
