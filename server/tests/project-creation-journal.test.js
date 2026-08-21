'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildSchema12Candidate } = require('../native/durability-schema');
const { SQLiteProjectionStore } = require('../manuscript/projection-store');
const { ManuscriptUidReservation } = require('../manuscript/uid-reservation');
const { createUidReservationSources } = require('../manuscript/uid-reservation-sources');
const { createNativeStageBFixture } = require('../testing/native-stage-b-fixture');
const {
  CHILD_JOURNAL_ID,
  CREATION_ID,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  PROJECT_INSTANCE_ID,
  PROJECT_UID,
  completeEmptySource,
  createEmptyProjectionTarget,
  createMemoryControlStore,
  creationJournalAuthority,
  deepFreeze,
  emptyDirectoryPlan,
  physicalIdentity,
  sha256File,
} = require('./fixtures/project-creation-crash');

function dispositionPort() {
  return Object.freeze({
    classify(evidence) { return evidence.disposition; },
    inspect() { return Object.freeze({ disposition: 'after' }); },
  });
}

function dynamicCreationSource(journals) {
  return Object.freeze({
    async enumerate(scope) {
      const records = [];
      for (const journal of journals) {
        const snapshot = await journal.reservationSource().enumerate(scope);
        records.push(...snapshot.records);
      }
      return Object.freeze({
        complete: true,
        projectUid: scope.projectUid,
        projectInstanceId: scope.projectInstanceId,
        objectKind: scope.objectKind,
        records: Object.freeze(records),
      });
    },
    async lookup(input) {
      const reservations = [];
      for (const journal of journals) {
        const snapshot = await journal.reservationSource().lookup(input);
        reservations.push(...snapshot.reservations);
      }
      return Object.freeze({
        complete: true,
        logicalRequestId: input.logicalRequestId,
        reservations: Object.freeze(reservations),
      });
    },
  });
}

function creationUidService(
  journals,
  calls,
  creationSource = dynamicCreationSource(journals),
  uuidValues = [CREATION_ID, PROJECT_UID],
) {
  const remainingUuids = [...uuidValues];
  return new ManuscriptUidReservation({
    reservationSources: createUidReservationSources({
      registrySource: completeEmptySource(),
      existingRootsSource: completeEmptySource(),
      migrationSources: Object.freeze([]),
      creationSources: Object.freeze([creationSource]),
    }),
    uuidV4() {
      calls.uuid += 1;
      return remainingUuids.shift() ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    },
  });
}

function creationRequest(calls) {
  return deepFreeze({
    logicalRequestId: 'create-request-a',
    projectInstanceId: PROJECT_INSTANCE_ID,
    childJournalId: CHILD_JOURNAL_ID,
    projectedAt: '2026-08-18T00:00:00.000Z',
    projectMetadata: {
      name: 'Novel',
      mode: 'medium-novel',
      language: 'zh',
      genres: ['fantasy'],
    },
    projectRootProbe: {
      probe() {
        calls.probe += 1;
        return Object.freeze({ disposition: 'absent' });
      },
    },
  });
}

async function reserveCreation(uidReservations, calls) {
  return uidReservations.reserveCreationIdentity(deepFreeze({
    logicalRequestId: 'create-request-a',
    logicalInputDigest: DIGEST_A,
    projectInstanceId: PROJECT_INSTANCE_ID,
    projectRootProbe: {
      probe() {
        calls.probe += 1;
        return Object.freeze({ disposition: 'absent' });
      },
    },
  }));
}

test('fresh creation and same-logical-request retry publish the exact empty two-file closure once', async () => {
  const {
    ProjectCreationFilePublicationParentAuthority,
    ProjectCreationJournal,
  } = require('../manuscript/project-creation-journal');
  const { ProjectCreationService } = require('../manuscript/project-creation-service');
  const dataRoot = path.join(os.tmpdir(), `mythpen-create-happy-${process.pid}`);
  const empty = await createEmptyProjectionTarget({ dataRoot });
  const journals = [];
  const journalById = new Map();
  const calls = {
    activate: 0,
    build: 0,
    closure: 0,
    ensure: 0,
    plan: 0,
    probe: 0,
    publish: 0,
    uuid: 0,
  };
  const uidReservations = creationUidService(journals, calls);
  const stagedClosures = [];
  let childParent;
  let childParentAuthority;
  let pinnedManifest;
  const store = Object.freeze({
    async buildClosure(...args) {
      calls.closure += 1;
      return empty.store.buildClosure(...args);
    },
    finalizeCandidate(...args) { return empty.store.finalizeCandidate(...args); },
  });
  const projectionStore = new SQLiteProjectionStore();
  const service = new ProjectCreationService({
    uidReservations,
    journals: Object.freeze({
      open(creationReservation) {
        let journal = journalById.get(creationReservation.creationId);
        if (journal === undefined) {
          journal = new ProjectCreationJournal({
            controlStore: createMemoryControlStore(
              dataRoot,
              [],
              creationReservation.creationId,
            ),
            dataRoot,
            creationId: creationReservation.creationId,
            childDisposition: dispositionPort(),
            databaseDisposition: dispositionPort(),
            clock: () => 1_723_900_000_000,
          });
          journalById.set(creationReservation.creationId, journal);
          journals.push(journal);
        }
        return journal;
      },
    }),
    directories: Object.freeze({
      plan() { calls.plan += 1; return emptyDirectoryPlan(dataRoot); },
      async ensure() { calls.ensure += 1; return empty.enumeration; },
    }),
    store,
    projection: Object.freeze({
      buildTarget(input) { return projectionStore.buildTarget(input); },
    }),
    childJournal: Object.freeze({
      async stageAssets(input) {
        stagedClosures.push(input.closure);
        childParent = input.parent;
        childParentAuthority = new ProjectCreationFilePublicationParentAuthority(
          journalById.get(input.parent.journalId),
        );
        await childParentAuthority.assertReservation({
          authority: input.parentReservationAuthority,
          parent: input.parent,
          childReservation: deepFreeze({
            version: 1,
            record_kind: 'reservation',
            journalId: input.journalId,
            mode: 'file_only',
            parent: input.parent,
            projectBinding: {
              projectUid: PROJECT_UID,
              projectInstanceId: PROJECT_INSTANCE_ID,
            },
            logicalRequestId: input.logicalRequestId,
            baseGeneration: input.baseGeneration,
            targetGeneration: input.targetGeneration,
            basisDigest: input.basisDigest,
            identityReservation: input.identityReservation,
          }),
        });
        const stagedAfterFacts = deepFreeze(input.closure.map((member, index) => ({
          ref: member.ref,
          byteSize: member.after.byteSize,
          rawSha256: member.after.rawSha256,
          fileIdentity: { dev: '1', ino: String(700 + index) },
          parentIdentity: member.parentIdentity,
        })));
        return Object.freeze({ stagedAssets: Object.freeze({}), stagedAfterFacts });
      },
      async bindTarget() {
        pinnedManifest = deepFreeze({ version: 1, members: [] });
        return deepFreeze({
          manifest: pinnedManifest,
          preparedAssets: {},
        });
      },
      async prepare({ parentPinAuthority }) {
        await childParentAuthority.assertPin({
          authority: parentPinAuthority,
          parent: childParent,
          manifest: pinnedManifest,
        });
      },
      async publishFiles() { calls.publish += 1; return Object.freeze({ state: 'files_published' }); },
    }),
    database: Object.freeze({
      async build(input) {
        calls.build += 1;
        assert.equal(input.sourceKind, 'empty');
        assert.equal(input.transitionKind, 'new_creation');
        assert.deepEqual(input.projectMetadata, {
          name: 'Novel', mode: 'medium-novel', language: 'zh', genres: ['fantasy'],
        });
        assert.equal(input.target.baseGeneration, 0);
        assert.equal(input.target.targetGeneration, 1);
        return deepFreeze({
          candidatePath: path.join(dataRoot, 'projects', 'created.schema12.candidate'),
          candidateIdentity: { dev: '1', ino: '900' },
          candidateSha256: DIGEST_B,
          finalPath: path.join(dataRoot, 'projects', 'created.mythpen.db'),
          finalParentIdentity: { dev: '1', ino: '901' },
          finalCommitSeq: 1,
          transitionProofDigest: DIGEST_C,
        });
      },
      async activate({ creationCas }) {
        calls.activate += 1;
        assert.ok(creationCas);
        return Object.freeze({ disposition: 'after', generation: 1, route: 'files' });
      },
    }),
    route: Object.freeze({
      prepareAbsentInstall(context) { return Object.freeze({ context }); },
    }),
  });

  for (const phase of ['fresh', 'same logical retry']) {
    const result = await service.create(creationRequest(calls));
    assert.deepEqual(result, {
      creationId: CREATION_ID,
      projectUid: PROJECT_UID,
      state: 'activated',
      projectMetadata: {
        name: 'Novel', mode: 'medium-novel', language: 'zh', genres: ['fantasy'],
      },
    }, phase);
  }
  assert.equal(calls.uuid, 2);
  assert.equal(calls.probe, 1);
  assert.equal(calls.plan, 1);
  assert.equal(calls.ensure, 1);
  assert.equal(calls.closure, 1);
  assert.equal(calls.publish, 1);
  assert.equal(calls.build, 1);
  assert.equal(calls.activate, 1);
  assert.equal(stagedClosures.length, 1);
  assert.deepEqual(
    stagedClosures[0].map((member) => member.ref.role).sort(),
    ['manuscript', 'unassigned'],
  );
  const contents = new Map(stagedClosures[0].map((member) => [
    member.ref.role,
    JSON.parse(member.after.bytes.toString('utf8')),
  ]));
  assert.deepEqual(contents.get('manuscript').volume_uids, []);
  assert.deepEqual(contents.get('unassigned').chapter_uids, []);
});

test('incomplete creation reservation source fails before RNG, path probe, journal, or mkdir', async () => {
  const calls = { lookup: 0, probe: 0, uuid: 0 };
  const incomplete = Object.freeze({
    enumerate() { throw new Error('enumerate must not follow incomplete lookup'); },
    lookup(input) {
      calls.lookup += 1;
      return Object.freeze({
        complete: false,
        logicalRequestId: input.logicalRequestId,
        reservations: Object.freeze([]),
      });
    },
  });
  const uidReservations = creationUidService([], calls, incomplete);
  await assert.rejects(
    reserveCreation(uidReservations, calls),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.deepEqual(calls, { lookup: 1, probe: 0, uuid: 0 });

  let emptyCreationSourcesRejected = false;
  try {
    createUidReservationSources({
      registrySource: completeEmptySource(),
      existingRootsSource: completeEmptySource(),
      migrationSources: Object.freeze([]),
      creationSources: Object.freeze([]),
    });
  } catch (error) {
    emptyCreationSourcesRejected = error instanceof TypeError;
  }

  const validCalls = { probe: 0, uuid: 0 };
  const valid = await reserveCreation(creationUidService([], validCalls), validCalls);
  const creationAdapter = (...reservations) => Object.freeze({
    async enumerate(scope) {
      return Object.freeze({ ...scope, complete: true, records: Object.freeze([]) });
    },
    async lookup(input) {
      return Object.freeze({
        complete: true,
        logicalRequestId: input.logicalRequestId,
        reservations: Object.freeze(reservations),
      });
    },
  });
  const invalidDuplicate = structuredClone(valid.creationReservation);
  invalidDuplicate.logicalInputDigest = DIGEST_B;
  deepFreeze(invalidDuplicate);
  const lookupSources = (adapters) => createUidReservationSources({
    registrySource: completeEmptySource(),
    existingRootsSource: completeEmptySource(),
    migrationSources: Object.freeze([]),
    creationSources: Object.freeze(adapters),
  });
  const duplicateCalls = { probe: 0, uuid: 0 };
  let invalidDuplicateRejected = false;
  try {
    await reserveCreation(new ManuscriptUidReservation({
      reservationSources: lookupSources([
        creationAdapter(valid.creationReservation),
        creationAdapter(invalidDuplicate),
      ]),
      uuidV4() { duplicateCalls.uuid += 1; return CREATION_ID; },
    }), duplicateCalls);
  } catch (error) {
    invalidDuplicateRejected = error?.code === 'RECOVERY_REQUIRED';
  }
  const identicalCalls = { probe: 0, uuid: 0 };
  const identical = await reserveCreation(new ManuscriptUidReservation({
    reservationSources: lookupSources([
      creationAdapter(valid.creationReservation),
      creationAdapter(valid.creationReservation),
    ]),
    uuidV4() { identicalCalls.uuid += 1; return CREATION_ID; },
  }), identicalCalls);

  const sourceWithRecords = (...records) => Object.freeze({
    async enumerate(scope) {
      return Object.freeze({ ...scope, complete: true, records: Object.freeze(records) });
    },
  });
  const catalogScope = Object.freeze({
    projectUid: null,
    projectInstanceId: PROJECT_INSTANCE_ID,
    objectKind: 'project',
  });
  const firstRecord = deepFreeze({
    ownerKind: 'creation',
    ownerId: CREATION_ID,
    reservationId: 'reservation-a',
    uid: PROJECT_UID,
  });
  const conflictingUid = deepFreeze({
    ownerKind: 'registry',
    ownerId: 'registry-b',
    reservationId: 'reservation-b',
    uid: PROJECT_UID,
  });
  const conflictingReservation = deepFreeze({
    ownerKind: 'registry',
    ownerId: 'registry-c',
    reservationId: 'reservation-a',
    uid: '66666666-6666-4666-8666-666666666666',
  });
  const catalog = (right) => createUidReservationSources({
    registrySource: sourceWithRecords(firstRecord),
    existingRootsSource: sourceWithRecords(right),
    migrationSources: Object.freeze([]),
    creationSources: Object.freeze([creationAdapter()]),
  });
  let conflictingUidRejected = false;
  let conflictingReservationRejected = false;
  try { await catalog(conflictingUid).enumerate(catalogScope); } catch (error) {
    conflictingUidRejected = error instanceof TypeError;
  }
  try { await catalog(conflictingReservation).enumerate(catalogScope); } catch (error) {
    conflictingReservationRejected = error instanceof TypeError;
  }
  assert.deepEqual({
    emptyCreationSourcesRejected,
    invalidDuplicateRejected,
    identicalLookupMerged: identical.creationReservation.reservationId
      === valid.creationReservation.reservationId,
    identicalLookupPortsStayedPure: identicalCalls.probe === 0 && identicalCalls.uuid === 0,
    conflictingUidRejected,
    conflictingReservationRejected,
  }, {
    emptyCreationSourcesRejected: true,
    invalidDuplicateRejected: true,
    identicalLookupMerged: true,
    identicalLookupPortsStayedPure: true,
    conflictingUidRejected: true,
    conflictingReservationRejected: true,
  });
});

test('new-creation candidate and absent install reject unsafe, reparse, and occupied final paths without deleting evidence', async (t) => {
  const { ProjectCreationRouteStore } = require('../manuscript/route-store');
  const { installCreatedProjectDatabase } = require('../native/native-project-store');
  const fixture = createNativeStageBFixture({ name: 'task13-path-negative' });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const projectInstanceId = (() => {
    const { Database } = require('bun:sqlite');
    const database = new Database(fixture.databasePath, { readonly: true, strict: true });
    try {
      return database.query("SELECT value FROM project_meta WHERE key = 'project_instance_id'").get().value;
    } finally {
      database.close(true);
    }
  })();
  const { target } = await createEmptyProjectionTarget({
    dataRoot: path.join(fixture.root, 'manuscripts-data'),
    projectInstanceId,
  });
  const outside = path.join(path.dirname(fixture.root), `task13-outside-${process.pid}.candidate`);
  assert.throws(() => buildSchema12Candidate(deepFreeze({
    sourcePath: fixture.databasePath,
    candidatePath: outside,
    creationId: CREATION_ID,
    sourceKind: 'empty',
    transitionKind: 'new_creation',
    target,
  })), (error) => error?.code === 'MANUSCRIPT_PATH_UNSAFE');
  assert.equal(fs.existsSync(outside), false);

  const originalRealpath = fs.realpathSync.native;
  fs.realpathSync.native = function driftSource(value) {
    if (path.resolve(value) === fixture.databasePath) return `${fixture.databasePath}.reparse`;
    return originalRealpath(value);
  };
  try {
    assert.throws(() => buildSchema12Candidate(deepFreeze({
      sourcePath: fixture.databasePath,
      candidatePath: path.join(path.dirname(fixture.databasePath), 'reparse.candidate'),
      creationId: CREATION_ID,
      sourceKind: 'empty',
      transitionKind: 'new_creation',
      target,
    })), (error) => error?.code === 'MANUSCRIPT_PATH_UNSAFE');
  } finally {
    fs.realpathSync.native = originalRealpath;
  }

  const candidatePath = path.join(path.dirname(fixture.databasePath), 'occupied.candidate');
  const built = buildSchema12Candidate(deepFreeze({
    sourcePath: fixture.databasePath,
    candidatePath,
    creationId: CREATION_ID,
    sourceKind: 'empty',
    transitionKind: 'new_creation',
    target,
  }));
  const finalPath = path.join(path.dirname(fixture.databasePath), 'occupied-final.mythpen.db');
  fs.writeFileSync(finalPath, 'external project');
  const finalBefore = fs.readFileSync(finalPath);
  const candidateBefore = fs.readFileSync(candidatePath);
  const context = deepFreeze({
    kind: 'new_creation',
    creationId: CREATION_ID,
    projectUid: PROJECT_UID,
    projectInstanceId,
    candidatePath,
    candidateIdentity: built.candidateIdentity,
    candidateSha256: built.candidateSha256,
    finalPath,
    finalParentIdentity: physicalIdentity(path.dirname(finalPath)),
    transitionProofDigest: built.transitionProofDigest,
    journalTailDigest: DIGEST_A,
    reservationDigest: DIGEST_B,
    baseGeneration: 0,
    targetGeneration: 1,
    finalCommitSeq: built.finalCommitSeq,
  });
  const route = new ProjectCreationRouteStore({
    journalAuthority: creationJournalAuthority(context),
  });
  assert.throws(
    () => route.prepareAbsentInstall(context),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.deepEqual(fs.readFileSync(finalPath), finalBefore);
  assert.deepEqual(fs.readFileSync(candidatePath), candidateBefore);
  assert.equal(typeof installCreatedProjectDatabase, 'function');
});

test('journal checksum, binding, and one-shot creation CAS reject tampering without side effects', async (t) => {
  const { ProjectCreationJournal } = require('../manuscript/project-creation-journal');
  const {
    ProjectCreationRouteStore,
    consumeCreationRouteCas,
  } = require('../manuscript/route-store');
  const dataRoot = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-create-binding-',
  ));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const calls = { probe: 0, uuid: 0 };
  const uidReservations = creationUidService([], calls);
  const reserved = await reserveCreation(uidReservations, calls);
  const controlStore = createMemoryControlStore(dataRoot);
  const journal = new ProjectCreationJournal({
    controlStore,
    dataRoot,
    creationId: CREATION_ID,
    childDisposition: dispositionPort(),
    databaseDisposition: dispositionPort(),
    clock: () => 1_723_900_000_000,
  });
  const directoryPlan = emptyDirectoryPlan(dataRoot);
  fs.mkdirSync(path.dirname(directoryPlan.finalDatabasePath), { recursive: true });
  let authority = await journal.reserve(deepFreeze({
    creationReservation: reserved.creationReservation,
    directoryPlan,
    projectMetadata: {
      name: 'Novel', mode: 'medium-novel', language: 'zh', genres: ['fantasy'],
    },
    baseGeneration: 0,
    targetGeneration: 1,
  }));
  authority = await journal.recordProjectControlReady(authority, deepFreeze({
    childJournalId: CHILD_JOURNAL_ID,
    childReservation: { version: 1, childJournalId: CHILD_JOURNAL_ID },
    closureDigest: DIGEST_A,
    logicalRequestId: 'create-request-a',
    partialManifest: { version: 1, members: [] },
    projectionBasisDigest: DIGEST_B,
    targetBindingDigest: DIGEST_C,
    targetGeneration: 1,
  }));
  authority = await journal.recordFilePublicationStarted(authority, deepFreeze({
    manifest: { version: 1, members: [] },
  }));
  authority = await journal.recordFilesPublished(authority, Object.freeze({ disposition: 'after' }));
  const candidatePath = path.join(path.dirname(directoryPlan.finalDatabasePath), 'candidate.db');
  const finalPath = directoryPlan.finalDatabasePath;
  fs.writeFileSync(candidatePath, 'candidate');
  await assert.rejects(journal.recordDatabaseCandidate(authority, deepFreeze({
    candidatePath,
    candidateIdentity: physicalIdentity(candidatePath),
    candidateSha256: sha256File(candidatePath),
    finalPath: path.join(path.dirname(finalPath), 'foreign.db'),
    finalParentIdentity: physicalIdentity(path.dirname(finalPath)),
    finalCommitSeq: 1,
    transitionProofDigest: DIGEST_C,
  })), (error) => error?.code === 'RECOVERY_REQUIRED');
  authority = await journal.recordDatabaseCandidate(authority, deepFreeze({
    candidatePath,
    candidateIdentity: physicalIdentity(candidatePath),
    candidateSha256: sha256File(candidatePath),
    finalPath,
    finalParentIdentity: physicalIdentity(path.dirname(finalPath)),
    finalCommitSeq: 1,
    transitionProofDigest: DIGEST_C,
  }));
  authority = await journal.beginActivation(authority);
  const context = journal.prepareCreationContext(authority);
  const route = new ProjectCreationRouteStore({ journalAuthority: journal.authority() });
  assert.throws(
    () => route.prepareAbsentInstall(deepFreeze(structuredClone(context))),
    (error) => ['RECOVERY_REQUIRED', 'ROUTE_CAS_INVALID'].includes(error?.code),
  );
  const cas = route.prepareAbsentInstall(context);
  assert.equal(consumeCreationRouteCas(cas, {
    purpose: 'new_creation_install',
    apply() { return 'consumed'; },
  }), 'consumed');
  assert.throws(
    () => consumeCreationRouteCas(cas, {
      purpose: 'new_creation_install',
      apply() { throw new Error('must not run'); },
    }),
    (error) => error?.code === 'ROUTE_CAS_CONSUMED',
  );

  const tampered = controlStore.snapshot();
  tampered[0].payload.data.directoryPlan.digest = DIGEST_B;
  const corrupted = new ProjectCreationJournal({
    controlStore: createMemoryControlStore(dataRoot, tampered),
    dataRoot,
    creationId: CREATION_ID,
    childDisposition: dispositionPort(),
    databaseDisposition: dispositionPort(),
    clock: () => 1_723_900_000_000,
  });
  assert.throws(() => corrupted.read(), (error) => error?.code === 'RECOVERY_REQUIRED');
  assert.equal(fs.existsSync(finalPath), false);
  assert.equal(fs.readFileSync(candidatePath, 'utf8'), 'candidate');
});
