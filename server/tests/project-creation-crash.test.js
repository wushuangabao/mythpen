'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ManuscriptUidReservation } = require('../manuscript/uid-reservation');
const { createUidReservationSources } = require('../manuscript/uid-reservation-sources');
const { buildSchema12Candidate } = require('../native/durability-schema');
const { createNativeStageBFixture } = require('../testing/native-stage-b-fixture');
const {
  CREATION_ID,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  PROJECT_UID,
  completeEmptySource,
  createEmptyProjectionTarget,
  createMemoryControlStore,
  deepFreeze,
  emptyDirectoryPlan,
  physicalIdentity,
} = require('./fixtures/project-creation-crash');

function dispositionPort() {
  return Object.freeze({
    classify(evidence) { return evidence.disposition; },
    inspect() { return Object.freeze({ disposition: 'after' }); },
  });
}

test('restart after durable candidate and before absent install reuses evidence and activates once', async (t) => {
  const { ProjectCreationJournal } = require('../manuscript/project-creation-journal');
  const { ProjectCreationRouteStore } = require('../manuscript/route-store');
  const {
    createProofBoundSchema12ProjectStore,
    installCreatedProjectDatabase,
  } = require('../native/native-project-store');
  const fixture = createNativeStageBFixture({ name: 'task13-candidate-crash' });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const { Database } = require('bun:sqlite');
  const source = new Database(fixture.databasePath, { readonly: true, strict: true });
  const projectInstanceId = source.query(
    "SELECT value FROM project_meta WHERE key = 'project_instance_id'",
  ).get().value;
  source.close(true);
  const { target } = await createEmptyProjectionTarget({
    dataRoot: path.join(fixture.root, 'manuscripts-data'),
    projectInstanceId,
  });
  const candidatePath = path.join(path.dirname(fixture.databasePath), 'creation.schema12.candidate');
  const built = buildSchema12Candidate(deepFreeze({
    sourcePath: fixture.databasePath,
    candidatePath,
    creationId: CREATION_ID,
    sourceKind: 'empty',
    transitionKind: 'new_creation',
    target,
  }));
  const finalPath = path.join(path.dirname(fixture.databasePath), 'created.mythpen.db');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-create-crash-journal-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const control = createMemoryControlStore(dataRoot);
  const first = new ProjectCreationJournal({
    controlStore: control,
    dataRoot,
    creationId: CREATION_ID,
    childDisposition: dispositionPort(),
    databaseDisposition: dispositionPort(),
    clock: () => 1_723_900_000_000,
  });
  const uuidValues = [CREATION_ID, PROJECT_UID];
  const uidReservations = new ManuscriptUidReservation({
    reservationSources: createUidReservationSources({
      registrySource: completeEmptySource(),
      existingRootsSource: completeEmptySource(),
      migrationSources: Object.freeze([]),
      creationSources: Object.freeze([Object.freeze({
        async enumerate(scope) {
          return Object.freeze({ ...scope, complete: true, records: Object.freeze([]) });
        },
        async lookup(input) {
          return Object.freeze({
            complete: true,
            logicalRequestId: input.logicalRequestId,
            reservations: Object.freeze([]),
          });
        },
      })]),
    }),
    uuidV4() { return uuidValues.shift(); },
  });
  const { creationReservation } = await uidReservations.reserveCreationIdentity(deepFreeze({
    projectInstanceId,
    logicalRequestId: 'create-request-crash',
    logicalInputDigest: DIGEST_A,
    projectRootProbe: Object.freeze({
      probe() { return Object.freeze({ disposition: 'absent' }); },
    }),
  }));
  let authority = await first.reserve(deepFreeze({
    creationReservation,
    directoryPlan: emptyDirectoryPlan(
      dataRoot,
      PROJECT_UID,
      projectInstanceId,
      finalPath,
    ),
    projectMetadata: {
      name: 'Novel', mode: 'medium-novel', language: 'zh', genres: ['fantasy'],
    },
    baseGeneration: 0,
    targetGeneration: 1,
  }));
  authority = await first.recordProjectControlReady(authority, deepFreeze({
    childJournalId: '99999999-9999-4999-8999-999999999999',
    childReservation: { version: 1 },
    closureDigest: DIGEST_A,
    logicalRequestId: 'create-request-crash',
    partialManifest: { version: 1, members: [] },
    projectionBasisDigest: target.basis.basisDigest,
    targetBindingDigest: DIGEST_C,
    targetGeneration: 1,
  }));
  authority = await first.recordFilePublicationStarted(authority, deepFreeze({
    manifest: { version: 1, members: [] },
  }));
  authority = await first.recordFilesPublished(authority, Object.freeze({ disposition: 'after' }));
  await first.recordDatabaseCandidate(authority, deepFreeze({
    candidatePath,
    candidateIdentity: built.candidateIdentity,
    candidateSha256: built.candidateSha256,
    finalPath,
    finalParentIdentity: physicalIdentity(path.dirname(finalPath)),
    finalCommitSeq: built.finalCommitSeq,
    transitionProofDigest: built.transitionProofDigest,
  }));
  assert.equal(first.read().state, 'database_candidate_ready');
  assert.equal(fs.existsSync(candidatePath), true);
  assert.equal(fs.existsSync(finalPath), false);

  const restartedControl = createMemoryControlStore(dataRoot, control.snapshot());
  const restarted = new ProjectCreationJournal({
    controlStore: restartedControl,
    dataRoot,
    creationId: CREATION_ID,
    childDisposition: dispositionPort(),
    databaseDisposition: dispositionPort(),
    clock: () => 1_723_900_000_000,
  });
  const activation = await restarted.resumeActivation();
  const context = restarted.prepareCreationContext(activation);
  const route = new ProjectCreationRouteStore({ journalAuthority: restarted.authority() });
  const creationCas = route.prepareAbsentInstall(context);
  const installed = installCreatedProjectDatabase({ creationCas });
  assert.deepEqual(installed, { disposition: 'after', generation: 1, route: 'files' });
  assert.equal(fs.existsSync(candidatePath), false);
  assert.equal(fs.existsSync(finalPath), true);
  const installedBytes = fs.readFileSync(finalPath);
  fs.appendFileSync(finalPath, 'mismatch');
  const mismatchedBytes = fs.readFileSync(finalPath);
  const activationSnapshot = restartedControl.snapshot();
  const mismatched = new ProjectCreationJournal({
    controlStore: createMemoryControlStore(dataRoot, activationSnapshot),
    dataRoot,
    creationId: CREATION_ID,
    childDisposition: dispositionPort(),
    databaseDisposition: dispositionPort(),
    clock: () => 1_723_900_000_000,
  });
  const mismatchedActivation = await mismatched.resumeActivation();
  const mismatchedContext = mismatched.prepareCreationContext(mismatchedActivation);
  const mismatchedCas = new ProjectCreationRouteStore({
    journalAuthority: mismatched.authority(),
  }).prepareAbsentInstall(mismatchedContext);
  assert.throws(
    () => installCreatedProjectDatabase({ creationCas: mismatchedCas }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.deepEqual(fs.readFileSync(finalPath), mismatchedBytes);
  assert.equal(fs.existsSync(candidatePath), false);

  fs.writeFileSync(finalPath, installedBytes);
  const afterInstall = new ProjectCreationJournal({
    controlStore: createMemoryControlStore(dataRoot, activationSnapshot),
    dataRoot,
    creationId: CREATION_ID,
    childDisposition: dispositionPort(),
    databaseDisposition: dispositionPort(),
    clock: () => 1_723_900_000_000,
  });
  const afterActivation = await afterInstall.resumeActivation();
  const afterContext = afterInstall.prepareCreationContext(afterActivation);
  const afterCas = new ProjectCreationRouteStore({
    journalAuthority: afterInstall.authority(),
  }).prepareAbsentInstall(afterContext);
  const afterEvidence = installCreatedProjectDatabase({ creationCas: afterCas });
  assert.deepEqual(afterEvidence, { disposition: 'after', generation: 1, route: 'files' });
  const result = await afterInstall.recordActivated(afterActivation, afterEvidence);
  assert.deepEqual(result, {
    creationId: CREATION_ID,
    projectUid: PROJECT_UID,
    state: 'activated',
    projectMetadata: {
      name: 'Novel', mode: 'medium-novel', language: 'zh', genres: ['fantasy'],
    },
  });
  assert.deepEqual(await afterInstall.resumeActivation(), result);
  const commonFacts = deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId,
    route: 'files',
    routeJournal: CREATION_ID,
    projectionGeneration: 1,
  });
  const reopened = createProofBoundSchema12ProjectStore({
    admission: deepFreeze({
      route: 'files',
      databaseFacts: { schemaVersion: 12, ...commonFacts },
      routeFacts: { ...commonFacts },
      activatedProof: {
        kind: 'creation',
        state: 'activated',
        journalId: CREATION_ID,
        projectUid: PROJECT_UID,
        projectInstanceId,
        targetGeneration: 1,
      },
    }),
    databasePath: finalPath,
    assertWriterLease() { throw new Error('read-only reopen must not request a writer lease'); },
  });
  t.after(() => { if (reopened.state === 'active') reopened.close(); });
  assert.deepEqual(reopened.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_route'",
  ), { value: 'files' });
});
