'use strict';

const assert = require('node:assert/strict');
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

function retryService(journal, unexpectedCalls) {
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
    directories: unused('directories', ['cleanup', 'ensure', 'plan']),
    source: unused('source', ['capture']),
    store: unused('store', ['buildClosure', 'finalizeCandidate']),
    projection: unused('projection', ['buildTarget']),
    childJournal: unused('childJournal', ['bindTarget', 'prepare', 'publishFiles', 'stageAssets']),
    database: unused('database', ['activate', 'build']),
  });
}

function restart(seed, dispositions = {}) {
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
      return Object.freeze({
        disposition: state[name],
        ...(name === 'route' && state[name] === 'after'
          ? { directoryPlan: directoryPlan() }
          : {}),
      });
    },
    classify(evidence) { return evidence.disposition; },
  });
  return {
    controlStore,
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
  const reserved = await first.journal.reserve(reserveInput());
  const route = await first.journal.recordRouteFenced(reserved, Object.freeze({ disposition: 'after' }), directoryPlan());
  const routeFencedSeed = first.controlStore.snapshot();
  const source = await first.journal.recordSourceSnapshot(route, sourceSnapshot());
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
  assert.deepEqual(retryCalls, []);
});
