'use strict';

const { createHash } = require('node:crypto');

const { assertCanonicalUuid, manuscriptError } = require('./contracts');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('./projection-store');

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
  const result = {};
  for (const method of methods) {
    if (typeof value[method] !== 'function') throw new TypeError(`${label}.${method} is required`);
    result[method] = value[method].bind(value);
  }
  return Object.freeze(result);
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

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function snapshotProjectMetadata(value) {
  const descriptors = exactDescriptors(
    value,
    ['genres', 'language', 'mode', 'name'],
    'projectMetadata',
  );
  const name = nonEmpty(descriptors.name.value, 'projectMetadata.name');
  const mode = nonEmpty(descriptors.mode.value, 'projectMetadata.mode');
  const language = nonEmpty(descriptors.language.value, 'projectMetadata.language');
  const genres = descriptors.genres.value;
  if (!Array.isArray(genres) || genres.length === 0) {
    throw new TypeError('projectMetadata.genres must be a non-empty array');
  }
  return Object.freeze({
    name,
    mode,
    language,
    genres: Object.freeze(genres.map((genre, index) => (
      nonEmpty(genre, `projectMetadata.genres[${index}]`)
    ))),
  });
}

function canonicalProjectedAt(value) {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError('projectedAt must be a canonical UTC timestamp');
  return value;
}

function snapshotRequest(value) {
  const descriptors = exactDescriptors(value, [
    'childJournalId',
    'logicalRequestId',
    'projectInstanceId',
    'projectMetadata',
    'projectRootProbe',
    'projectedAt',
  ], 'project creation request');
  const projectRootProbe = descriptors.projectRootProbe.value;
  if (
    projectRootProbe === null
    || typeof projectRootProbe !== 'object'
    || typeof projectRootProbe.probe !== 'function'
  ) throw new TypeError('projectRootProbe must provide probe()');
  const projectMetadata = snapshotProjectMetadata(descriptors.projectMetadata.value);
  return Object.freeze({
    childJournalId: assertCanonicalUuid(
      descriptors.childJournalId.value,
      'child_journal_id',
    ),
    logicalInputDigest: digestPlain(Object.freeze({
      domain: 'mythpen.project-creation.logical-input',
      version: 1,
      projectMetadata,
    })),
    logicalRequestId: nonEmpty(
      descriptors.logicalRequestId.value,
      'logicalRequestId',
    ),
    projectInstanceId: assertCanonicalUuid(
      descriptors.projectInstanceId.value,
      'project_instance_id',
    ),
    projectMetadata,
    projectRootProbe,
    projectedAt: canonicalProjectedAt(descriptors.projectedAt.value),
  });
}

function emptyProjection(creationReservation) {
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'empty',
    baseGeneration: 0,
    volumes: [],
    chapters: [],
    sqliteSequence: [
      { name: 'chapters', seq: 0 },
      { name: 'volumes', seq: 0 },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  Object.freeze(basis.volumes);
  Object.freeze(basis.chapters);
  for (const row of basis.sqliteSequence) Object.freeze(row);
  Object.freeze(basis.sqliteSequence);
  Object.freeze(basis.pendingProposals);
  Object.freeze(basis);
  return Object.freeze({
    projectUid: creationReservation.projectReservation.uid,
    projectInstanceId: creationReservation.projectInstanceId,
    basis,
  });
}

function assertJournal(value) {
  if (
    value === null
    || typeof value !== 'object'
    || ![
      'beginActivation',
      'prepareCreationContext',
      'read',
      'recordActivated',
      'recordDatabaseCandidate',
      'recordFilePublicationStarted',
      'recordFilesPublished',
      'recordProjectControlReady',
      'reserve',
      'resumeActivation',
    ].every((method) => typeof value[method] === 'function')
  ) throw new TypeError('journals.open() returned an invalid ProjectCreationJournal');
  return value;
}

function assertDurableBinding(view, reservation, request) {
  if (
    view.creationId !== reservation.creationId
    || view.projectUid !== reservation.projectReservation.uid
    || view.projectInstanceId !== reservation.projectInstanceId
    || view.logicalRequestId !== request.logicalRequestId
    || view.logicalInputDigest !== request.logicalInputDigest
    || digestPlain(view.projectMetadata) !== digestPlain(request.projectMetadata)
    || view.baseGeneration !== 0
    || view.targetGeneration !== 1
  ) throw recoveryRequired('durable project creation request binding changed', {
    creationId: reservation.creationId,
  });
}

function verifyLifecycleReady(record, journal) {
  const durable = journal.read();
  if (
    durable?.lifecycleLockReceipt === null
    || durable?.lifecycleLockReceipt === undefined
    || record.directories.verifyExisting(durable.lifecycleLockReceipt)
      !== durable.lifecyclePlatformIdentity
  ) throw recoveryRequired('project creation lifecycle lock is not proven ready');
}

function assertActivationAfter(value, targetGeneration) {
  const descriptors = exactDescriptors(
    value,
    ['disposition', 'generation', 'route'],
    'verified creation activation after evidence',
  );
  if (
    descriptors.disposition.value !== 'after'
    || descriptors.generation.value !== targetGeneration
    || descriptors.route.value !== 'files'
  ) throw recoveryRequired('created project activation is not completely proven after');
  return value;
}

async function activateDurable(record, journal, activationAuthority) {
  if (
    activationAuthority?.state === 'activated'
    && activationAuthority.creationId !== undefined
  ) return activationAuthority;
  verifyLifecycleReady(record, journal);
  const context = journal.prepareCreationContext(activationAuthority);
  const creationCas = await record.route.prepareAbsentInstall(context);
  const databaseEvidence = await record.database.activate(Object.freeze({
    creationCas,
    creationContext: context,
  }));
  const verifiedAfter = assertActivationAfter(
    await record.database.verifyActivationAfter(Object.freeze({
      activationEvidence: databaseEvidence,
      creationContext: context,
    })),
    context.targetGeneration,
  );
  verifyLifecycleReady(record, journal);
  return journal.recordActivated(activationAuthority, verifiedAfter);
}

class ProjectCreationService {
  constructor(options) {
    const descriptors = exactDescriptors(options, [
      'childJournal',
      'database',
      'directories',
      'journals',
      'projection',
      'route',
      'store',
      'uidReservations',
    ], 'ProjectCreationService options');
    serviceRecords.set(this, Object.freeze({
      uidReservations: capturePort(descriptors.uidReservations.value, [
        'assertCreationIdentity',
        'reserveCreationIdentity',
      ], 'uidReservations'),
      journals: capturePort(descriptors.journals.value, ['open'], 'journals'),
      directories: capturePort(
        descriptors.directories.value,
        ['ensure', 'plan', 'verifyExisting'],
        'directories',
      ),
      store: capturePort(descriptors.store.value, ['buildClosure', 'finalizeCandidate'], 'store'),
      projection: capturePort(descriptors.projection.value, ['buildTarget'], 'projection'),
      childJournal: capturePort(descriptors.childJournal.value, [
        'bindTarget',
        'prepare',
        'publishFiles',
        'stageAssets',
      ], 'childJournal'),
      database: capturePort(
        descriptors.database.value,
        ['activate', 'build', 'verifyActivationAfter'],
        'database',
      ),
      route: capturePort(descriptors.route.value, ['prepareAbsentInstall'], 'route'),
    }));
    Object.freeze(this);
  }

  async create(input) {
    const record = serviceRecords.get(this);
    if (!record) throw new TypeError('invalid ProjectCreationService receiver');
    const request = snapshotRequest(input);

    let reserved;
    try {
      reserved = await record.uidReservations.reserveCreationIdentity(Object.freeze({
        logicalRequestId: request.logicalRequestId,
        logicalInputDigest: request.logicalInputDigest,
        projectInstanceId: request.projectInstanceId,
        projectRootProbe: request.projectRootProbe,
      }));
    } catch (cause) {
      if (cause?.code === 'UID_RESERVATION_COLLISION' || cause?.code === 'RECOVERY_REQUIRED') {
        throw cause;
      }
      throw recoveryRequired('project creation identity reservation failed', {}, cause);
    }
    if (
      !isPlainObject(reserved)
      || !Object.isFrozen(reserved)
      || reserved.creationReservation === undefined
      || reserved.authority === undefined
    ) throw new TypeError('creation UID reservation result is invalid');
    const creationReservation = record.uidReservations.assertCreationIdentity({
      authority: reserved.authority,
      creationReservation: reserved.creationReservation,
    });
    const journal = assertJournal(await record.journals.open(creationReservation));
    const durable = journal.read();
    if (durable !== null) {
      assertDurableBinding(durable, creationReservation, request);
      if (durable.state === 'activated') {
        verifyLifecycleReady(record, journal);
        return Object.freeze({
          creationId: durable.creationId,
          projectUid: durable.projectUid,
          state: 'activated',
          projectMetadata: durable.projectMetadata,
        });
      }
      if (
        durable.state !== 'database_candidate_ready'
        && durable.state !== 'activation_intent'
      ) throw recoveryRequired('durable project creation state requires manual recovery', {
        creationId: durable.creationId,
        state: durable.state,
      });
      if (durable.state === 'database_candidate_ready') {
        verifyLifecycleReady(record, journal);
      }
      return activateDurable(record, journal, await journal.resumeActivation());
    }

    const directoryPlan = await record.directories.plan(Object.freeze({
      creationReservation,
    }));
    let authority = await journal.reserve(Object.freeze({
      creationReservation,
      directoryPlan,
      projectMetadata: request.projectMetadata,
      baseGeneration: 0,
      targetGeneration: 1,
    }));
    const ready = await record.directories.ensure(Object.freeze({
      creationReservation,
      directoryPlan,
    }));
    const readyDescriptors = exactDescriptors(ready, [
      'enumeration',
      'lifecycleLockReceipt',
      'lifecyclePlatformIdentity',
    ], 'project control readiness');
    if (
      !Object.isFrozen(ready)
      || readyDescriptors.lifecyclePlatformIdentity.value
        !== readyDescriptors.lifecycleLockReceipt.value?.lifecyclePlatformIdentity
    ) throw recoveryRequired('project control readiness lost its original lifecycle identity');
    const emptyEnumeration = readyDescriptors.enumeration.value;
    const lifecycleLockReceipt = readyDescriptors.lifecycleLockReceipt.value;
    const projectIdentity = Object.freeze({
      creationId: creationReservation.creationId,
      projectUid: creationReservation.projectReservation.uid,
      projectInstanceId: creationReservation.projectInstanceId,
    });
    const buildResult = await record.store.buildClosure(
      emptyEnumeration,
      Object.freeze({ kind: 'creation.empty_bootstrap' }),
      Object.freeze([]),
      projectIdentity,
    );
    if (
      !isPlainObject(buildResult)
      || !Array.isArray(buildResult.closure)
      || buildResult.closure.length !== 2
    ) throw new TypeError('empty bootstrap buildClosure result is invalid');
    const closureDigest = digest(
      buildResult.closureDigest,
      'buildResult.closureDigest',
    );
    const currentProjection = emptyProjection(creationReservation);
    const childReservation = Object.freeze({
      version: 1,
      childJournalId: request.childJournalId,
    });
    const partialManifest = Object.freeze({
      version: 1,
      childJournalId: request.childJournalId,
      closureDigest,
    });
    authority = await journal.recordProjectControlReady(authority, Object.freeze({
      childJournalId: request.childJournalId,
      childReservation,
      closureDigest,
      lifecycleLockReceipt,
      logicalRequestId: request.logicalRequestId,
      partialManifest,
      projectionBasisDigest: currentProjection.basis.basisDigest,
      targetBindingDigest: digestPlain(Object.freeze({
        creationId: creationReservation.creationId,
        projectUid: creationReservation.projectReservation.uid,
        projectInstanceId: creationReservation.projectInstanceId,
        targetGeneration: 1,
      })),
      targetGeneration: 1,
    }));

    const staged = await record.childJournal.stageAssets({
      journalId: request.childJournalId,
      logicalRequestId: request.logicalRequestId,
      baseGeneration: 0,
      targetGeneration: 1,
      basisDigest: currentProjection.basis.basisDigest,
      closure: buildResult.closure,
      identityReservation: creationReservation,
      parent: Object.freeze({
        kind: 'creation',
        journalId: creationReservation.creationId,
      }),
      parentReservationAuthority: authority,
    });
    const candidate = record.store.finalizeCandidate(
      buildResult,
      staged.stagedAfterFacts,
    );
    const target = record.projection.buildTarget({
      candidate,
      currentProjection,
      targetGeneration: 1,
      projectedAt: request.projectedAt,
      ignoredLedger: Object.freeze([]),
      localIdentityPlan: Object.freeze([]),
    });
    const bound = await record.childJournal.bindTarget({
      stagedAssets: staged.stagedAssets,
      projectionTarget: target,
    });
    authority = await journal.recordFilePublicationStarted(authority, Object.freeze({
      manifest: bound.manifest,
    }));
    await record.childJournal.prepare({
      preparedAssets: bound.preparedAssets,
      parentPinAuthority: authority,
    });
    const childResult = await record.childJournal.publishFiles(request.childJournalId);
    authority = await journal.recordFilesPublished(
      authority,
      Object.freeze({
        disposition: childResult.state === 'files_published' ? 'after' : 'unknown',
      }),
    );
    const databaseCandidate = await record.database.build(Object.freeze({
      creationId: creationReservation.creationId,
      sourceKind: 'empty',
      transitionKind: 'new_creation',
      target,
      directoryPlan,
      projectMetadata: request.projectMetadata,
    }));
    authority = await journal.recordDatabaseCandidate(authority, Object.freeze({
      candidatePath: databaseCandidate.candidatePath,
      candidateIdentity: databaseCandidate.candidateIdentity,
      candidateSha256: databaseCandidate.candidateSha256,
      finalPath: databaseCandidate.finalPath,
      finalParentIdentity: databaseCandidate.finalParentIdentity,
      finalCommitSeq: databaseCandidate.finalCommitSeq,
      transitionProofDigest: databaseCandidate.transitionProofDigest,
    }));
    verifyLifecycleReady(record, journal);
    authority = await journal.beginActivation(authority);
    return activateDurable(record, journal, authority);
  }
}

module.exports = { ProjectCreationService };
