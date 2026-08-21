'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Database } = require('bun:sqlite');

const {
  buildSchema12Candidate,
  inspectSchema12Contract,
} = require('../native/durability-schema');
const { SQLiteProjectionStore, canonicalIgnoredLedgerDigest, canonicalProjectionBasisDigest } = require('../manuscript/projection-store');
const { deriveControlledFileRef } = require('../manuscript/paths');
const { ManuscriptRouteStore } = require('../manuscript/route-store');
const { createNativeStageBFixture } = require('../testing/native-stage-b-fixture');
const { createStageBFixtureStore } = require('../testing/native-stage-b-store');

const PROJECT_UID = '10000000-0000-4000-8000-000000000001';
const VOLUME_UID = '20000000-0000-4000-8000-000000000002';
const CHAPTER_UID = '30000000-0000-4000-8000-000000000003';
const MIGRATION_ID = '40000000-0000-4000-8000-000000000004';
const BODY_SHA = createHash('sha256').update('chapter body').digest('hex');
const SIDECAR_SHA = createHash('sha256').update('chapter sidecar').digest('hex');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fileIdentity(seed) {
  return { dev: '1', ino: String(seed) };
}

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function physicalIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function closeDatabase(database) {
  database.clearQueryCache();
  Bun.gc(true);
  database.close(true);
}

function projectInstanceId(databasePath) {
  const database = new Database(databasePath, { create: false, readonly: true, strict: true });
  try {
    return database.query("SELECT value FROM project_meta WHERE key = 'project_instance_id'").get().value;
  } finally {
    closeDatabase(database);
  }
}

function projectionTarget(databasePath) {
  const instanceId = projectInstanceId(databasePath);
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema11',
    baseGeneration: 0,
    volumes: [],
    chapters: [],
    sqliteSequence: [{ name: 'chapters', seq: 0 }, { name: 'volumes', seq: 0 }],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  const controlled = (role, resourceUid, seed, rawSha256) => {
    const refInput = { role, projectUid: PROJECT_UID };
    if (role === 'volume_index') refInput.volumeUid = resourceUid;
    if (role === 'chapter_body' || role === 'chapter_sidecar') refInput.chapterUid = resourceUid;
    return {
      byteSize: 10 + seed,
      fileIdentity: fileIdentity(seed),
      parentIdentity: fileIdentity(seed + 100),
      rawSha256,
      ref: deriveControlledFileRef(refInput),
      resourceUid,
      role,
    };
  };
  const controlledFiles = [
    controlled('manuscript', null, 1, '1'.repeat(64)),
    controlled('unassigned', null, 2, '2'.repeat(64)),
    controlled('volume_index', VOLUME_UID, 3, '3'.repeat(64)),
    controlled('chapter_body', CHAPTER_UID, 4, BODY_SHA),
    controlled('chapter_sidecar', CHAPTER_UID, 5, SIDECAR_SHA),
  ];
  controlledFiles.sort((left, right) => (
    left.role.localeCompare(right.role, 'en')
    || String(left.resourceUid ?? '').localeCompare(String(right.resourceUid ?? ''), 'en')
    || left.rawSha256.localeCompare(right.rawSha256, 'en')
  ));
  const candidate = deepFreeze({
    capacitySnapshot: {
      state: 'active',
      measurements: {
        chapterIdentities: 1,
        volumeIdentities: 1,
        markdownBytes: 12,
        jsonBytes: 16,
        controlledFiles: 5,
        chapterDirectoryEntries: 2,
        controlledBytes: 128,
      },
      counters: {
        directoryEntries: 5,
        identityProbes: 5,
        contentOpens: 5,
        contentBytes: 128,
      },
      warnings: [],
      error: null,
    },
    chapters: [{
      bodyFileIdentity: fileIdentity(4),
      bodyRawSha256: BODY_SHA,
      chapterPosition: 1,
      chapterUid: CHAPTER_UID,
      cognitiveFrame: '',
      concreteMystery: '',
      content: 'chapter body',
      contentAvailable: true,
      emotionalAnchor: '',
      interpersonalTension: '',
      manuscriptPosition: 1,
      markdownMode: 'visual',
      outline: '',
      sidecarFileIdentity: fileIdentity(5),
      sidecarRawSha256: SIDECAR_SHA,
      status: 'writing',
      summary: '',
      title: 'Chapter one',
      volumeUid: VOLUME_UID,
      wordCount: 2,
      worldTexture: '',
    }],
    controlledFiles,
    diagnostics: { journalCandidates: [], residues: [] },
    ignoredLedgerAfter: [],
    projectUid: PROJECT_UID,
    volumeOrder: [VOLUME_UID],
    volumes: [{
      summary: '',
      title: 'Volume one',
      volumePosition: 1,
      volumeUid: VOLUME_UID,
    }],
    warnings: [],
  });
  const localIdentityPlan = deepFreeze([
    {
      assignmentKind: 'reserved_new',
      objectKind: 'chapter',
      uid: CHAPTER_UID,
      id: 1,
      num: 1,
      reservationId: 'migration-chapter-one',
    },
    {
      assignmentKind: 'reserved_new',
      objectKind: 'volume',
      uid: VOLUME_UID,
      id: 1,
      reservationId: 'migration-volume-one',
    },
  ]);
  return new SQLiteProjectionStore().buildTarget({
    candidate,
    currentProjection: deepFreeze({
      projectUid: PROJECT_UID,
      projectInstanceId: instanceId,
      basis,
    }),
    targetGeneration: 1,
    projectedAt: '2026-08-18T00:00:00.000Z',
    ignoredLedger: deepFreeze([]),
    localIdentityPlan,
  });
}

function journalAuthority(context) {
  const contexts = new WeakSet([context]);
  const observation = Object.freeze(Object.create(null));
  const transitionProof = Object.freeze(Object.create(null));
  return Object.freeze({
    readObservation() { return observation; },
    describeObservation(original) {
      if (original !== observation) throw Object.assign(new Error('foreign observation'), { code: 'RECOVERY_REQUIRED' });
      return deepFreeze({
        projectUid: context.projectUid,
        projectInstanceId: context.projectInstanceId,
        migrationId: context.migrationId,
        state: 'activation_intent',
        tailDigest: context.journalTailDigest,
        reservationDigest: context.reservationDigest,
        baseGeneration: context.baseGeneration,
        targetGeneration: context.targetGeneration,
      });
    },
    assertTransitionAllowed(original, transition) {
      if (
        original !== observation
        || Object.keys(transition).join(',') !== 'expected,next'
        || transition.expected !== 'migrating'
        || transition.next !== 'files'
      ) throw Object.assign(new Error('transition denied'), { code: 'RECOVERY_REQUIRED' });
      return transitionProof;
    },
    assertMigrationContext(original) {
      if (!contexts.has(original) || original !== context) {
        throw Object.assign(new Error('foreign migration context'), { code: 'RECOVERY_REQUIRED' });
      }
      return original;
    },
    readMigrationReserved() { throw new Error('unused'); },
    describeMigrationReserved() { throw new Error('unused'); },
  });
}

function migrationContext(build) {
  return deepFreeze({
    kind: 'migration',
    migrationId: MIGRATION_ID,
    projectUid: PROJECT_UID,
    projectInstanceId: build.projectInstanceId,
    sourcePath: build.sourcePath,
    sourceIdentity: build.sourceIdentity,
    sourceSha256: build.sourceSha256,
    candidatePath: build.candidatePath,
    candidateIdentity: build.candidateIdentity,
    candidateSha256: build.candidateSha256,
    journalTailDigest: 'a'.repeat(64),
    reservationDigest: 'b'.repeat(64),
    baseGeneration: 0,
    targetGeneration: 1,
  });
}

function openCandidateProjectDb(candidatePath) {
  const database = new Database(candidatePath, { create: false, readonly: true, strict: true });
  return {
    database,
    projectDb: Object.freeze({
      identity: deepFreeze(physicalIdentity(candidatePath)),
      prepare(sql) { return database.query(sql); },
    }),
  };
}

function prepareScene(t, name) {
  const fixture = createNativeStageBFixture({ name });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = projectionTarget(fixture.databasePath);
  const candidatePath = path.join(path.dirname(fixture.databasePath), `${name}.schema12.candidate`);
  const sourceBefore = fs.readFileSync(fixture.databasePath);
  const sourceIdentityBefore = physicalIdentity(fixture.databasePath);
  const sourceSha256Before = hashFile(fixture.databasePath);
  const build = buildSchema12Candidate(deepFreeze({
    sourcePath: fixture.databasePath,
    candidatePath,
    migrationId: MIGRATION_ID,
    target,
  }));
  assert.deepEqual(fs.readFileSync(fixture.databasePath), sourceBefore);
  assert.deepEqual(physicalIdentity(fixture.databasePath), sourceIdentityBefore);
  assert.equal(hashFile(fixture.databasePath), sourceSha256Before);
  const context = migrationContext(build);
  const authority = journalAuthority(context);
  const routeStore = new ManuscriptRouteStore({ journalAuthority: authority });
  const opened = openCandidateProjectDb(candidatePath);
  const routeCas = routeStore.prepareCompareAndSwap(
    opened.projectDb,
    'migrating',
    'files',
    context,
  );
  closeDatabase(opened.database);
  return {
    fixture,
    target,
    sourceBefore,
    sourceIdentityBefore,
    sourceSha256Before,
    build,
    context,
    routeCas,
  };
}

test('schema12 side-by-side candidate publishes one generation and route atomically', (t) => {
  const scene = prepareScene(t, 'task12-direct');
  assert.deepEqual(fs.readFileSync(scene.fixture.databasePath), scene.sourceBefore);
  assert.deepEqual(physicalIdentity(scene.fixture.databasePath), scene.sourceIdentityBefore);
  assert.equal(hashFile(scene.fixture.databasePath), scene.sourceSha256Before);
  const store = createStageBFixtureStore(scene.fixture);
  t.after(() => { if (store.state === 'active') store.close(); });
  store.publishProjectionTarget({ target: scene.target, routeCas: scene.routeCas });

  assert.equal(store.state, 'released');
  assert.equal(fs.existsSync(scene.build.candidatePath), false);
  const database = new Database(scene.fixture.databasePath, { create: false, readonly: true, strict: true });
  try {
    const contract = inspectSchema12Contract(database, { expectedFinalSeq: 1 });
    assert.equal(contract.route, 'files');
    assert.equal(contract.projectionGeneration, 1);
    assert.equal(contract.manuscriptProjectUid, PROJECT_UID);
    assert.deepEqual(
      database.query('SELECT volume_uid, title, is_present FROM volumes').all(),
      [{ volume_uid: VOLUME_UID, title: 'Volume one', is_present: 1 }],
    );
    assert.deepEqual(
      database.query('SELECT chapter_uid, content, is_present FROM chapters').all(),
      [{ chapter_uid: CHAPTER_UID, content: 'chapter body', is_present: 1 }],
    );
  } finally {
    closeDatabase(database);
  }
});

test('candidate builder rejects uncontrolled paths and reparse sources before creating candidate bytes', (t) => {
  const fixture = createNativeStageBFixture({ name: 'task12-path-negative' });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const target = projectionTarget(fixture.databasePath);
  const outside = path.join(path.dirname(fixture.root), `outside-${process.pid}.candidate`);
  assert.throws(
    () => buildSchema12Candidate(deepFreeze({
      sourcePath: fixture.databasePath,
      candidatePath: outside,
      migrationId: MIGRATION_ID,
      target,
    })),
    (error) => error?.code === 'MANUSCRIPT_PATH_UNSAFE',
  );
  assert.equal(fs.existsSync(outside), false);
  assert.equal(hashFile(fixture.databasePath), fixture.databaseSha256);

  const driftCandidatePath = path.join(
    path.dirname(fixture.databasePath),
    'task12-source-drift.schema12.candidate',
  );
  const originalReadFileSync = fs.readFileSync;
  let sourceReads = 0;
  fs.readFileSync = function readFileWithSourceDrift(filePath, ...args) {
    const bytes = originalReadFileSync.call(fs, filePath, ...args);
    if (path.resolve(filePath) === fixture.databasePath && ++sourceReads === 2) {
      const drifted = Buffer.from(bytes);
      drifted[0] ^= 1;
      return drifted;
    }
    return bytes;
  };
  try {
    assert.throws(
      () => buildSchema12Candidate(deepFreeze({
        sourcePath: fixture.databasePath,
        candidatePath: driftCandidatePath,
        migrationId: MIGRATION_ID,
        target,
      })),
      (error) => error?.code === 'RECOVERY_REQUIRED',
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(fs.existsSync(driftCandidatePath), true);
  assert.equal(hashFile(fixture.databasePath), fixture.databaseSha256);
});

test('stale generation or ambiguous candidate bytes return RECOVERY_REQUIRED and preserve both drafts', (t) => {
  const scene = prepareScene(t, 'task12-ambiguous-negative');
  const cloneStore = new ManuscriptRouteStore({
    journalAuthority: journalAuthority(scene.context),
  });
  const opened = openCandidateProjectDb(scene.build.candidatePath);
  assert.throws(
    () => cloneStore.prepareCompareAndSwap(
      opened.projectDb,
      'migrating',
      'files',
      deepFreeze(structuredClone(scene.context)),
    ),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  closeDatabase(opened.database);
  const database = new Database(scene.build.candidatePath, { create: false, strict: true });
  try {
    database.exec('BEGIN IMMEDIATE');
    database.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
    database.query("UPDATE project_meta SET value = '9' WHERE key = 'manuscript_projection_generation'").run();
    database.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
    database.exec('COMMIT');
  } finally {
    if (database.inTransaction) database.exec('ROLLBACK');
    closeDatabase(database);
  }
  const ambiguousBytes = fs.readFileSync(scene.build.candidatePath);
  const store = createStageBFixtureStore(scene.fixture);
  t.after(() => { if (store.state === 'active') store.close(); });

  assert.throws(
    () => store.publishProjectionTarget({ target: scene.target, routeCas: scene.routeCas }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.deepEqual(fs.readFileSync(scene.fixture.databasePath), scene.sourceBefore);
  assert.deepEqual(fs.readFileSync(scene.build.candidatePath), ambiguousBytes);
});
