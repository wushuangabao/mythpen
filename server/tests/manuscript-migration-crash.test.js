'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { MigrationJournal } = require('../manuscript/migration-journal');
const { MigrationService } = require('../manuscript/migration-service');
const {
  CHILD_JOURNAL_ID,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  MIGRATION_ID,
  PROJECT_INSTANCE_ID,
  createMemoryControlStore,
  directoryPlan,
  lifecycleLockReceipt,
  lifecycleLockPreflight,
  projectBinding,
  reserveInput,
  sourceSnapshot,
} = require('./fixtures/manuscript-migration-crash');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function retryRequest() {
  return deepFreeze({
    migrationId: MIGRATION_ID,
    childJournalId: CHILD_JOURNAL_ID,
    logicalRequestId: 'migration-request-a',
    projectInstanceId: PROJECT_INSTANCE_ID,
    sourceBasis: { basisDigest: DIGEST_A },
    projectRootProbe: { digest: DIGEST_B },
    baseGeneration: 0,
    targetGeneration: 1,
  });
}

function retryService(journal, unexpectedCalls, verifyExisting = null) {
  const unused = (name, methods) => Object.freeze(Object.fromEntries(methods.map((method) => [
    method,
    () => {
      unexpectedCalls.push(`${name}.${method}`);
      throw new Error(`${name}.${method} must not run during durable retry`);
    },
  ])));
  return new MigrationService({
    journal,
    uidReservations: unused('uidReservations', [
      'assertMigrationIdentities', 'reserveMigrationIdentities', 'resumeMigrationIdentities',
    ]),
    route: unused('route', ['abort', 'activate', 'fence']),
    directories: Object.freeze({
      ...unused('directories', ['cleanup', 'ensure', 'plan']),
      verifyExisting(receipt) {
        unexpectedCalls.push('directories.verifyExisting');
        return verifyExisting === null
          ? receipt.lifecyclePlatformIdentity
          : verifyExisting(receipt);
      },
    }),
    source: unused('source', ['capture']),
    store: unused('store', ['buildClosure', 'finalizeCandidate']),
    projection: unused('projection', ['buildTarget']),
    childJournal: unused('childJournal', ['bindTarget', 'prepare', 'publishFiles', 'stageAssets']),
    database: unused('database', ['activate', 'build', 'verifyActivationAfter']),
  });
}

function restart(seed, dispositions = {}, inspectionCalls = null) {
  const dataRoot = path.join(os.tmpdir(), `mythpen-migration-restart-${process.pid}`);
  const controlStore = createMemoryControlStore(dataRoot, seed);
  const state = {
    route: dispositions.route ?? 'after',
    child: dispositions.child ?? 'after',
    database: dispositions.database ?? 'after',
    cleanup: dispositions.cleanup ?? 'after',
  };
  const port = (name) => Object.freeze({
    inspect() {
      inspectionCalls?.push(`${name}.inspect`);
      return Object.freeze({
        disposition: state[name],
        ...(name === 'route' && state[name] === 'after'
          ? { directoryPlan: directoryPlan(dataRoot) }
          : {}),
      });
    },
    classify(evidence) { return evidence.disposition; },
  });
  return {
    controlStore,
    dataRoot,
    journal: new MigrationJournal({
      controlStore,
      projectBinding: projectBinding(dataRoot),
      routeDisposition: port('route'),
      childDisposition: port('child'),
      databaseDisposition: port('database'),
      cleanupDisposition: port('cleanup'),
      clock: () => 1_723_900_000_000,
    }),
  };
}

test('cold recovery completes activation only from exact child, database, and route after evidence', async () => {
  const first = restart([]);
  const reserved = await first.journal.reserve(reserveInput(first.dataRoot));
  assert.strictEqual(
    first.journal.read(MIGRATION_ID).migrationReservation.lifecycleLockPreflight
      .plannedLifecycleLockPath,
    lifecycleLockPreflight(first.dataRoot).plannedLifecycleLockPath,
  );
  const changedPlan = deepFreeze({
    ...directoryPlan(first.dataRoot),
    projectControlRoot: path.join(first.dataRoot, 'foreign-control'),
  });
  await assert.rejects(
    first.journal.recordRouteFenced(
      reserved,
      Object.freeze({ disposition: 'after' }),
      changedPlan,
    ),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  const route = await first.journal.recordRouteFenced(
    reserved,
    Object.freeze({ disposition: 'after' }),
    directoryPlan(first.dataRoot),
  );
  const routeFencedSeed = first.controlStore.snapshot();
  const readyReceipt = lifecycleLockReceipt(first.dataRoot);
  const adopted = structuredClone(readyReceipt);
  adopted.lifecycleLockBefore = {
    byteSize: 0,
    disposition: 'present',
    identity: adopted.lifecyclePlatformIdentity.lifecycleLockIdentity,
    parentIdentity: adopted.lifecyclePlatformIdentity.controlParentDirectoryIdentity,
    sha256: adopted.lifecycleLockAfter.sha256,
  };
  deepFreeze(adopted);
  await assert.rejects(
    first.journal.recordSourceSnapshot(route, sourceSnapshot(), adopted),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  await assert.rejects(
    first.journal.recordSourceSnapshot(
      route,
      sourceSnapshot(),
      lifecycleLockReceipt(path.join(first.dataRoot, 'foreign')),
    ),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  const source = await first.journal.recordSourceSnapshot(route, sourceSnapshot(), readyReceipt);
  const sourceView = first.journal.read(MIGRATION_ID);
  assert.equal(
    sourceView.lifecyclePlatformIdentity,
    sourceView.lifecycleLockReceipt.lifecyclePlatformIdentity,
  );
  const candidate = await first.journal.recordFilesCandidate(source, Object.freeze({
    childJournalId: CHILD_JOURNAL_ID,
    logicalRequestId: 'migration-request-a',
    projectionBasisDigest: DIGEST_A,
    closureDigest: DIGEST_B,
    targetGeneration: 1,
    targetBindingDigest: DIGEST_C,
    childReservation: Object.freeze({ version: 1, childJournalId: CHILD_JOURNAL_ID }),
    partialManifest: Object.freeze({ version: 1, members: Object.freeze([]) }),
  }));
  const pin = await first.journal.recordFilePublicationStarted(candidate, Object.freeze({
    manifest: Object.freeze({ version: 1, members: Object.freeze([]) }),
  }));
  const published = await first.journal.recordFilesPublished(pin, Object.freeze({ disposition: 'after' }));
  const database = await first.journal.recordDatabaseCandidate(published, Object.freeze({
    sourcePath: 'E:\\source.sqlite',
    sourceIdentity: Object.freeze({ dev: '1', ino: '2' }),
    sourceSha256: DIGEST_A,
    candidatePath: 'E:\\candidate.sqlite',
    candidateDigest: DIGEST_A,
    candidateIdentity: Object.freeze({ dev: '1', ino: '9' }),
    transitionProofDigest: DIGEST_B,
  }));
  const activation = await first.journal.beginActivation(database);
  const physical = deepFreeze({
    sourcePath: 'E:\\source.sqlite',
    sourceIdentity: { dev: '1', ino: '2' },
    sourceSha256: DIGEST_A,
    candidatePath: 'E:\\candidate.sqlite',
    candidateIdentity: { dev: '1', ino: '9' },
    candidateSha256: DIGEST_A,
  });
  assert.equal(first.journal.prepareMigrationContext(activation, physical).candidatePath, physical.candidatePath);
  for (const [field, replacement] of [
    ['sourcePath', 'E:\\other-source.sqlite'],
    ['sourceIdentity', deepFreeze({ dev: '1', ino: '7' })],
    ['sourceSha256', DIGEST_B],
    ['candidatePath', 'E:\\other-candidate.sqlite'],
    ['candidateIdentity', deepFreeze({ dev: '1', ino: '8' })],
    ['candidateSha256', DIGEST_C],
  ]) {
    assert.throws(
      () => first.journal.prepareMigrationContext(
        activation,
        deepFreeze({ ...physical, [field]: replacement }),
      ),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      field,
    );
  }

  const activationSeed = first.controlStore.snapshot();
  for (const dispositions of [
    { child: 'unknown' },
    { route: 'before' },
    { database: 'unknown' },
  ]) {
    const blocked = restart(activationSeed, dispositions);
    const before = blocked.controlStore.snapshot();
    await assert.rejects(
      blocked.journal.recover(MIGRATION_ID),
      (error) => error?.code === 'RECOVERY_REQUIRED',
    );
    assert.deepEqual(blocked.controlStore.snapshot(), before);
  }

  const intermediate = restart(routeFencedSeed);
  const intermediateCalls = [];
  await assert.rejects(
    retryService(intermediate.journal, intermediateCalls).migrate(retryRequest()),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.deepEqual(intermediateCalls, []);
  assert.deepEqual(intermediate.controlStore.snapshot(), routeFencedSeed);

  const explicitRecoveryCalls = [];
  const explicitRecovery = restart(activationSeed, {}, explicitRecoveryCalls);
  assert.deepEqual(
    await retryService(explicitRecovery.journal, explicitRecoveryCalls).recover(MIGRATION_ID),
    { migrationId: MIGRATION_ID, state: 'activated' },
  );
  assert.deepEqual(explicitRecoveryCalls, [
    'directories.verifyExisting',
    'child.inspect',
    'route.inspect',
    'database.inspect',
    'directories.verifyExisting',
  ]);

  const driftCalls = [];
  const drifted = restart(activationSeed, {}, driftCalls);
  let lifecycleVerifications = 0;
  await assert.rejects(
    retryService(drifted.journal, driftCalls, (receipt) => {
      lifecycleVerifications += 1;
      return lifecycleVerifications === 1
        ? receipt.lifecyclePlatformIdentity
        : Object.freeze({ ...receipt.lifecyclePlatformIdentity });
    }).recover(MIGRATION_ID),
    (error) => error?.code === 'RECOVERY_REQUIRED'
      && error.details?.reason === 'migration lifecycle lock is not proven ready',
  );
  assert.deepEqual(driftCalls, [
    'directories.verifyExisting',
    'child.inspect',
    'route.inspect',
    'database.inspect',
    'directories.verifyExisting',
  ]);
  assert.deepEqual(drifted.controlStore.snapshot(), activationSeed);

  const second = restart(activationSeed);
  const retryCalls = [];
  const service = retryService(second.journal, retryCalls);
  assert.deepEqual(await service.migrate(retryRequest()), {
    migrationId: MIGRATION_ID,
    state: 'activated',
  });
  assert.deepEqual(await service.migrate(retryRequest()), {
    migrationId: MIGRATION_ID,
    state: 'activated',
  });
  assert.deepEqual(retryCalls, [
    'directories.verifyExisting',
    'directories.verifyExisting',
    'directories.verifyExisting',
  ]);
});

test('production migration publishes the ordinary UID under its project key', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'manuscript', 'production-migration-adapter.js'),
    'utf8',
  );
  assert.match(
    source,
    /uidCatalog\.registerOrdinary\(\s*projectUid,\s*state\.childJournal\.reservationSource\(\)\s*\)/u,
  );
});

test('fresh migration re-verifies activation and lifecycle before activated append', async () => {
  const calls = [];
  const dataRoot = path.join(os.tmpdir(), `mythpen-migration-verify-after-${process.pid}`);
  const receipt = lifecycleLockReceipt(dataRoot);
  const authority = Object.freeze(() => {});
  const reservation = deepFreeze({
    projectInstanceId: PROJECT_INSTANCE_ID,
    projectReservation: { uid: '11111111-1111-4111-8111-111111111111' },
    localIdentityPlan: [],
  });
  const databaseCandidate = deepFreeze({
    sourcePath: 'E:\\source.sqlite',
    sourceIdentity: { dev: '1', ino: '2' },
    sourceSha256: DIGEST_A,
    candidatePath: 'E:\\candidate.sqlite',
    candidateDigest: DIGEST_B,
    candidateIdentity: { dev: '1', ino: '3' },
    transitionProofDigest: DIGEST_C,
  });
  let durableStarted = false;
  const journal = Object.freeze({
    authority() { return Object.freeze({ readObservation() { return Object.freeze({}); } }); },
    read() {
      if (!durableStarted) {
        const error = new Error('RECOVERY_REQUIRED');
        error.code = 'RECOVERY_REQUIRED';
        error.details = { reason: 'migration journal does not exist' };
        throw error;
      }
      return Object.freeze({
        migrationId: MIGRATION_ID,
        state: 'database_candidate_ready',
        lifecycleLockReceipt: receipt,
        lifecyclePlatformIdentity: receipt.lifecyclePlatformIdentity,
      });
    },
    reserve() { durableStarted = true; return authority; },
    recordRouteFenced() { return authority; },
    recordSourceSnapshot() { return authority; },
    recordFilesCandidate() { return authority; },
    recordFilePublicationStarted() { return authority; },
    recordFilesPublished() { return authority; },
    recordDatabaseCandidate() { return authority; },
    beginActivation() { return authority; },
    prepareMigrationContext() {
      return deepFreeze({
        migrationId: MIGRATION_ID,
        projectUid: reservation.projectReservation.uid,
        projectInstanceId: PROJECT_INSTANCE_ID,
        sourcePath: databaseCandidate.sourcePath,
        targetGeneration: 1,
      });
    },
    recordActivated(value, evidence) {
      assert.strictEqual(value, authority);
      assert.deepEqual(evidence, { disposition: 'after', generation: 1, route: 'files' });
      calls.push('journal.recordActivated');
      return Object.freeze({ migrationId: MIGRATION_ID, state: 'activated' });
    },
    recover() { throw new Error('unused'); },
  });
  const service = new MigrationService({
    journal,
    uidReservations: Object.freeze({
      reserveMigrationIdentities() {
        return Object.freeze({ migrationReservation: reservation, authority });
      },
      assertMigrationIdentities() { return reservation.localIdentityPlan; },
      resumeMigrationIdentities() { throw new Error('unused'); },
    }),
    route: Object.freeze({
      abort() { throw new Error('unused'); },
      fence() { return Object.freeze({ disposition: 'after' }); },
      activate() { return Object.freeze({ disposition: 'after' }); },
    }),
    directories: Object.freeze({
      plan() { return directoryPlan(dataRoot); },
      ensure() {
        return Object.freeze({
          enumeration: Object.freeze([]),
          lifecycleLockReceipt: receipt,
          lifecyclePlatformIdentity: receipt.lifecyclePlatformIdentity,
        });
      },
      cleanup() { throw new Error('unused'); },
      verifyExisting(value) {
        calls.push('directories.verifyExisting');
        return value.lifecyclePlatformIdentity;
      },
    }),
    source: Object.freeze({ capture() { return Object.freeze({}); } }),
    store: Object.freeze({
      buildClosure() { return Object.freeze({ closure: Object.freeze([]), closureDigest: DIGEST_A }); },
      finalizeCandidate() { return Object.freeze({}); },
    }),
    projection: Object.freeze({ buildTarget() { return Object.freeze({ targetGeneration: 1 }); } }),
    childJournal: Object.freeze({
      stageAssets() {
        return Object.freeze({ stagedAssets: Object.freeze({}), stagedAfterFacts: Object.freeze([]) });
      },
      bindTarget() {
        return Object.freeze({ manifest: Object.freeze({}), preparedAssets: Object.freeze({}) });
      },
      prepare() {},
      publishFiles() { return Object.freeze({ state: 'files_published' }); },
    }),
    database: Object.freeze({
      build() { return databaseCandidate; },
      activate() {
        calls.push('database.activate');
        return Object.freeze({ disposition: 'after', generation: 1, route: 'files' });
      },
      verifyActivationAfter() {
        calls.push('database.verifyActivationAfter');
        return Object.freeze({ disposition: 'after', generation: 1, route: 'files' });
      },
    }),
  });

  assert.deepEqual(await service.migrate(retryRequest()), {
    migrationId: MIGRATION_ID,
    state: 'activated',
  });
  assert.deepEqual(calls, [
    'directories.verifyExisting',
    'database.activate',
    'database.verifyActivationAfter',
    'directories.verifyExisting',
    'journal.recordActivated',
  ]);
});
