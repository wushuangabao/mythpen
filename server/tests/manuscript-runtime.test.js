'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseCanonicalJson, serializeCanonicalJson } = require('../manuscript/format');
const { deriveManuscriptLifecycleLockPath } = require('../manuscript/lifecycle-lock');
const {
  deriveChapterPaths,
  deriveManuscriptPaths,
  deriveVolumePath,
} = require('../manuscript/paths');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');

let createManuscriptRuntime;
let createProductionManuscriptRuntime;
try {
  ({ createManuscriptRuntime } = require('../manuscript/runtime'));
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !error.message.includes('manuscript/runtime')) throw error;
}
try {
  ({ createProductionManuscriptRuntime } = require('../manuscript/production-runtime'));
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !error.message.includes('production-runtime')) throw error;
}

const PROJECT_UID = '10000000-0000-4000-8000-000000000001';
const PROJECT_INSTANCE_ID = '20000000-0000-4000-8000-000000000002';
const MIGRATION_ID = '30000000-0000-4000-8000-000000000003';
const CREATION_ID = '40000000-0000-4000-8000-000000000004';
const VOLUME_UID = '50000000-0000-4000-8000-000000000005';
const CHAPTER_UID = '60000000-0000-4000-8000-000000000006';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function filesAdmission(proofKind, overrides = {}) {
  const journalId = proofKind === 'migration' ? MIGRATION_ID : CREATION_ID;
  const common = {
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    route: 'files',
    routeJournal: journalId,
    projectionGeneration: 1,
  };
  return deepFreeze({
    route: 'files',
    databaseFacts: { schemaVersion: 12, ...common },
    routeFacts: { ...common },
    activatedProof: {
      kind: proofKind,
      state: 'activated',
      journalId,
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      targetGeneration: 1,
    },
    ...overrides,
  });
}

function makeRuntime(admission, counters = {}) {
  const state = {
    generation: 1,
    rawSha256: hash('chapter body'),
    sidecarRawSha256: hash('chapter sidecar'),
    expectedDataVersion: 7,
  };
  const files = {
    async ignoreInPlace(_admission, request) {
      counters.orphanIgnores = (counters.orphanIgnores || 0) + 1;
      return deepFreeze({ state: 'ignored', request });
    },
    async read(_admission, request) {
      counters.fileReads = (counters.fileReads || 0) + 1;
      let value;
      if (request.kind === 'chapter') {
        value = deepFreeze({ uid: CHAPTER_UID, content: 'chapter body', title: 'Chapter one' });
      } else {
        value = deepFreeze([{ uid: VOLUME_UID, title: 'Volume one' }]);
      }
      return deepFreeze({ value, baseWitness: { ...state } });
    },
    async write(_admission, request) {
      if (!sameWitnessForTest(request.baseWitness, state)) {
        const error = new Error('The durable manuscript resource changed');
        error.code = 'EXTERNAL_DRAFT_CONFLICT';
        throw error;
      }
      counters.fileWrites = (counters.fileWrites || 0) + 1;
      if (
        request.command.expected_data_version !== undefined
        && request.command.expected_data_version !== state.expectedDataVersion
      ) {
        const error = new Error('The durable manuscript resource changed');
        error.code = 'EXTERNAL_DRAFT_CONFLICT';
        throw error;
      }
      counters.journalWrites = (counters.journalWrites || 0) + 1;
      counters.projectionWrites = (counters.projectionWrites || 0) + 1;
      state.generation += 1;
      state.rawSha256 = hash(JSON.stringify(request.command));
      state.sidecarRawSha256 = hash(`sidecar:${JSON.stringify(request.command)}`);
      state.expectedDataVersion += 1;
      return deepFreeze({ state: 'committed', generation: state.generation });
    },
    async recover() { return deepFreeze({ state: 'ready' }); },
    async revokeIgnore(_admission, request) {
      counters.orphanRevokes = (counters.orphanRevokes || 0) + 1;
      return deepFreeze({ state: 'revoked', request });
    },
    close() {},
  };
  const sqlite = {
    async read(_selector, request) {
      counters.sqliteReads = (counters.sqliteReads || 0) + 1;
      return deepFreeze({ sqlite: true, request });
    },
    async write(_selector, request) {
      counters.sqliteWrites = (counters.sqliteWrites || 0) + 1;
      return deepFreeze({ sqlite: true, requestId: request.requestId });
    },
    async recover() { return deepFreeze({ state: 'ready' }); },
    close() {},
  };
  const creation = {
    async create(input) {
      counters.creationInput = input;
      return deepFreeze({
        creationId: CREATION_ID,
        projectUid: PROJECT_UID,
        state: 'activated',
        projectMetadata: input.projectMetadata,
      });
    },
  };
  const migration = {
    async migrate(input) {
      counters.migrationInput = input;
      return deepFreeze({ migrationId: MIGRATION_ID, state: 'activated' });
    },
    async recover() { return deepFreeze({ state: 'ready' }); },
  };
  return createManuscriptRuntime({
    routeResolver: { async admit() { return admission; } },
    sqlite,
    files,
    creation,
    migration,
  });
}

function sameWitnessForTest(left, right) {
  return left.expectedDataVersion === right.expectedDataVersion
    && left.generation === right.generation
    && left.rawSha256 === right.rawSha256
    && left.sidecarRawSha256 === right.sidecarRawSha256;
}

test('files happy table composes migrated and newly-created projects while sqlite stays explicit', {
  timeout: 30_000,
}, async (t) => {
  assert.equal(typeof createManuscriptRuntime, 'function');
  assert.equal(typeof createProductionManuscriptRuntime, 'function');
  for (const scenario of ['migrated', 'newly_created']) {
    const proofKind = scenario === 'migrated' ? 'migration' : 'creation';
    const counters = {};
    const runtime = makeRuntime(filesAdmission(proofKind), counters);
    if (scenario === 'migrated') {
      assert.deepEqual(await runtime.migrateProject({
        projectSelector: { projectName: 'Novel' },
        requestId: `request-${scenario}`,
      }), { migrationId: MIGRATION_ID, state: 'activated' });
      assert.deepEqual(counters.migrationInput.projectSelector, { projectName: 'Novel' });
    } else {
      assert.deepEqual(await runtime.createProject({
        requestId: `request-${scenario}`,
        name: 'Novel',
        mode: 'medium-novel',
        language: 'zh',
        genres: ['fantasy'],
      }), {
        creationId: CREATION_ID,
        projectUid: PROJECT_UID,
        state: 'activated',
        projectMetadata: {
          name: 'Novel', mode: 'medium-novel', language: 'zh', genres: ['fantasy'],
        },
      });
      assert.equal(counters.creationInput.logicalInputDigest, undefined);
      assert.ok(Object.isFrozen(counters.creationInput.projectMetadata));
    }

    const chapter = await runtime.read({ projectUid: PROJECT_UID }, {
      kind: 'chapter', chapterUid: CHAPTER_UID,
    });
    const volumes = await runtime.read({ projectUid: PROJECT_UID }, { kind: 'volumes' });
    assert.equal(chapter.value.content, 'chapter body');
    assert.equal(volumes.value[0].title, 'Volume one');
    assert.ok(Object.isFrozen(chapter.baseWitness));

    const replaced = await runtime.write({ projectUid: PROJECT_UID }, {
      requestId: `replace-${scenario}`,
      baseWitness: chapter.baseWitness,
      command: {
        kind: 'chapter.replace_body_and_sidecar',
        chapterUid: CHAPTER_UID,
        expected_data_version: 7,
        content: 'new body',
        patch: { title: 'New title' },
      },
    });
    assert.equal(replaced.state, 'committed');
    const refreshed = await runtime.read({ projectUid: PROJECT_UID }, {
      kind: 'chapter', chapterUid: CHAPTER_UID,
    });
    const structured = await runtime.write({ projectUid: PROJECT_UID }, {
      requestId: `structure-${scenario}`,
      baseWitness: refreshed.baseWitness,
      command: {
        kind: 'volume.patch_metadata',
        volumeUid: VOLUME_UID,
        patch: { title: 'Renamed volume' },
      },
    });
    assert.equal(structured.state, 'committed');
    assert.equal(counters.fileWrites, 2);
    await runtime.close();
  }

  const counters = {};
  const sqliteRuntime = makeRuntime(deepFreeze({ route: 'sqlite' }), counters);
  assert.equal((await sqliteRuntime.read(1, { kind: 'chapter', chapterId: 1 })).sqlite, true);
  assert.equal((await sqliteRuntime.write(1, {
    requestId: 'sqlite-write', baseWitness: null, command: { kind: 'chapter.delete', chapterId: 1 },
  })).sqlite, true);
  assert.equal(counters.sqliteReads, 1);
  assert.equal(counters.sqliteWrites, 1);

  const { ManuscriptStore } = require('../manuscript/store');
  const { ManuscriptSessionController } = require('../manuscript/session-controller');
  const originalValidateFull = ManuscriptStore.prototype.validateFull;
  const originalPreflightOrphanResolution = ManuscriptStore.prototype.preflightOrphanResolution;
  const originalOpenSession = ManuscriptSessionController.prototype.openSession;
  const originalAdmitSession = ManuscriptSessionController.prototype.admit;
  const originalCloseSession = ManuscriptSessionController.prototype.close;
  let fullScans = 0;
  let resolutionScans = 0;
  let blockedFull = null;
  const sessionCalls = { admit: 0, close: 0, open: 0 };
  ManuscriptStore.prototype.validateFull = async function countedValidateFull(...args) {
    fullScans += 1;
    if (blockedFull !== null) {
      const barrier = blockedFull;
      blockedFull = null;
      barrier.entered.resolve();
      await barrier.release.promise;
    }
    return originalValidateFull.apply(this, args);
  };
  ManuscriptStore.prototype.preflightOrphanResolution = async function countedOrphanScan(...args) {
    resolutionScans += 1;
    return originalPreflightOrphanResolution.apply(this, args);
  };
  ManuscriptSessionController.prototype.openSession = async function countedOpen(...args) {
    sessionCalls.open += 1;
    return originalOpenSession.apply(this, args);
  };
  ManuscriptSessionController.prototype.admit = async function countedAdmit(...args) {
    sessionCalls.admit += 1;
    return originalAdmitSession.apply(this, args);
  };
  ManuscriptSessionController.prototype.close = async function countedClose(...args) {
    sessionCalls.close += 1;
    return originalCloseSession.apply(this, args);
  };

  const buildInfo = require('../build-info');
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'fixture_only',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  delete require.cache[require.resolve('../native/native-activation-authority')];
  delete require.cache[require.resolve('../testing/native-stage-c-fixture')];
  const fixture = require('../testing/native-stage-c-fixture').createNativeStageCFixture();
  const receipt = require('../native/native-activation-authority')
    .authorizeNativeActivation({ root: fixture.root })
    .consume();
  const database = require('../db');
  const originalCreateFilesManuscriptDatabasePort = database.createFilesManuscriptDatabasePort;
  let projectionCaptureCalls = 0;
  const postPublishProjectionCaptures = [];
  database.createFilesManuscriptDatabasePort = function observedFilesDatabasePort() {
    const databasePort = originalCreateFilesManuscriptDatabasePort();
    return Object.freeze({
      ...databasePort,
      captureProjection(...args) {
        projectionCaptureCalls += 1;
        return databasePort.captureProjection(...args);
      },
      projectStore(admission) {
        const projectStore = databasePort.projectStore(admission);
        return Object.freeze({
          publishProjectionTarget(input) {
            const capturesBeforePublish = projectionCaptureCalls;
            const result = projectStore.publishProjectionTarget(input);
            queueMicrotask(() => {
              postPublishProjectionCaptures.push(
                projectionCaptureCalls - capturesBeforePublish,
              );
            });
            return result;
          },
        });
      },
    });
  };
  const controller = require('../testing/fixture-native-activation-controller')
    .createFixtureNativeActivationController({ receipt, root: fixture.root });
  let productionRuntime = null;
  async function restartProductionRuntime() {
    await productionRuntime?.close();
    await database.closeAllDatabases();
    database.configureStorage({ dataDir: fixture.root });
    await database.initDatabase();
    productionRuntime = createProductionManuscriptRuntime();
    delete require.cache[require.resolve('../manuscript/runtime')];
    require('../manuscript/runtime').installManuscriptRuntime(productionRuntime);
  }
  t.after(async () => {
    ManuscriptStore.prototype.validateFull = originalValidateFull;
    ManuscriptStore.prototype.preflightOrphanResolution = originalPreflightOrphanResolution;
    ManuscriptSessionController.prototype.openSession = originalOpenSession;
    ManuscriptSessionController.prototype.admit = originalAdmitSession;
    ManuscriptSessionController.prototype.close = originalCloseSession;
    database.createFilesManuscriptDatabasePort = originalCreateFilesManuscriptDatabasePort;
    try { await productionRuntime?.close(); } catch {}
    try { await database.closeAllDatabases(); } catch {}
    buildInfo.getBuildInfo = originalGetBuildInfo;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  database.installFixtureNativeActivationController(controller);
  database.configureStorage({ dataDir: fixture.root });
  await database.initDatabase();
  const sourceName = 'task14b-production-migration';
  const sourcePath = database.getProjectDbPath(sourceName);
  const source = database.createProjectDb(sourceName);
  source.prepare("INSERT INTO volumes (id, sort_order, title, summary) VALUES (1, 1, 'Volume one', '')").run();
  source.prepare(`
    INSERT INTO chapters (id, volume_id, num, title, status)
    VALUES (1, 1, 1, 'Chapter one', 'pending')
  `).run();
  require('../manuscript-service').writeChapterBody({
    projectName: sourceName,
    chapterId: 1,
    content: 'production body',
    source: 'rest',
  });
  const sourceInstanceId = source.prepare(
    "SELECT value FROM project_meta WHERE key = 'project_instance_id'",
  ).get().value;
  source.flush();
  database.getConfigDb().prepare(`
    INSERT INTO recent_projects (id, name, file_path, last_opened, word_count)
    VALUES (?, ?, ?, datetime('now'), 0)
  `).run(sourceName, sourceName, sourcePath);
  database.getConfigDb().flush();
  await database.enableNativeProject(sourceName, sourceInstanceId);
  productionRuntime = createProductionManuscriptRuntime();
  require('../manuscript/runtime').installManuscriptRuntime(productionRuntime);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/api'));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const sqliteStatusResponse = await fetch(
    `${baseUrl}/projects/by-name/${encodeURIComponent(sourceName)}/files-beta/status`,
  );
  assert.equal(sqliteStatusResponse.status, 200);
  assert.deepEqual(await sqliteStatusResponse.json(), {
    route: 'sqlite',
    project_uid: null,
    project_instance_id: null,
  });
  const betaMigrationResponse = await fetch(
    `${baseUrl}/projects/by-name/${encodeURIComponent(sourceName)}/files-beta/migrate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-production-request',
      },
      body: '{}',
    },
  );
  const migrated = await betaMigrationResponse.json();
  assert.equal(betaMigrationResponse.status, 200);
  assert.equal(migrated.state, 'activated');
  const productionAdmission = database.inspectProjectManuscriptRoute(sourceName);
  assert.equal(productionAdmission.route, 'files');
  const opensBeforeRejectedNumericWrite = sessionCalls.open;
  const capturesBeforeRejectedNumericWrite = projectionCaptureCalls;
  await assert.rejects(
    productionRuntime.write(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      Object.freeze({
        requestId: 'task14b-numeric-command-forbidden',
        baseWitness: Object.freeze({
          expectedDataVersion: 0,
          generation: 0,
          rawSha256: '0'.repeat(64),
          sidecarRawSha256: null,
        }),
        command: Object.freeze({ kind: 'chapter.delete', chapterId: 1 }),
      }),
    ),
    TypeError,
  );
  assert.equal(sessionCalls.open - opensBeforeRejectedNumericWrite, 0);
  assert.equal(projectionCaptureCalls - capturesBeforeRejectedNumericWrite, 0);
  const migrationControlDirectory = path.join(
    fixture.root,
    'control',
    'manuscripts',
    productionAdmission.databaseFacts.projectUid,
    productionAdmission.databaseFacts.projectInstanceId,
  );
  const migrationControlParent = path.dirname(migrationControlDirectory);
  const lifecycleLockPath = deriveManuscriptLifecycleLockPath(
    fs.realpathSync.native(migrationControlDirectory),
  );
  let catalogProbe = 0;
  async function assertCatalogRejects(label) {
    catalogProbe += 1;
    await assert.rejects(
      productionRuntime.createProject(Object.freeze({
        requestId: `task14b-catalog-${catalogProbe}`,
        name: `task14b-catalog-${catalogProbe}`,
        mode: 'medium-novel',
        language: 'zh',
        genres: Object.freeze(['fantasy']),
      })),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      label,
    );
  }

  const creationCatalogRoot = path.join(fixture.root, 'control', 'project-creation');
  fs.mkdirSync(creationCatalogRoot, { recursive: true });
  const unknownCreationCatalogFile = path.join(creationCatalogRoot, 'unexpected.catalog');
  fs.writeFileSync(unknownCreationCatalogFile, '');
  try {
    await assertCatalogRejects('creation catalog must reject unrelated sibling files');
  } finally {
    fs.rmSync(unknownCreationCatalogFile, { force: true });
  }

  const creationReparseTarget = path.join(fixture.root, 'creation-catalog-reparse-target');
  const creationReparseEntry = path.join(
    creationCatalogRoot,
    '71000000-0000-4000-8000-000000000007',
  );
  fs.mkdirSync(creationReparseTarget);
  fs.symlinkSync(
    creationReparseTarget,
    creationReparseEntry,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  try {
    await assertCatalogRejects('creation catalog must reject a reparse sibling');
  } finally {
    fs.unlinkSync(creationReparseEntry);
    fs.rmSync(creationReparseTarget, { recursive: true, force: true });
  }

  const manuscriptsCatalogRoot = path.join(fixture.root, 'manuscripts');
  const unknownManuscriptsCatalogFile = path.join(manuscriptsCatalogRoot, 'unexpected.catalog');
  fs.writeFileSync(unknownManuscriptsCatalogFile, '');
  try {
    await assertCatalogRejects('manuscripts catalog must reject unrelated sibling files');
  } finally {
    fs.rmSync(unknownManuscriptsCatalogFile, { force: true });
  }

  const manuscriptsReparseTarget = path.join(fixture.root, 'manuscripts-catalog-reparse-target');
  const manuscriptsReparseEntry = path.join(
    manuscriptsCatalogRoot,
    '72000000-0000-4000-8000-000000000007',
  );
  fs.mkdirSync(manuscriptsReparseTarget);
  fs.symlinkSync(
    manuscriptsReparseTarget,
    manuscriptsReparseEntry,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  try {
    await assertCatalogRejects('manuscripts catalog must reject a reparse sibling');
  } finally {
    fs.unlinkSync(manuscriptsReparseEntry);
    fs.rmSync(manuscriptsReparseTarget, { recursive: true, force: true });
  }

  const unknownCatalogFile = path.join(migrationControlParent, 'unexpected.catalog');
  fs.writeFileSync(unknownCatalogFile, '');
  try {
    await assertCatalogRejects('migration catalog must reject unrelated sibling files');
  } finally {
    fs.rmSync(unknownCatalogFile, { force: true });
  }

  const displacedLifecycleLock = path.join(fixture.root, 'displaced-lifecycle-lock');
  fs.renameSync(lifecycleLockPath, displacedLifecycleLock);
  try {
    await assertCatalogRejects('migration catalog must reject a missing canonical lifecycle lock');
  } finally {
    fs.renameSync(displacedLifecycleLock, lifecycleLockPath);
  }

  fs.renameSync(lifecycleLockPath, displacedLifecycleLock);
  fs.writeFileSync(lifecycleLockPath, '');
  try {
    await assertCatalogRejects('migration catalog must verify lifecycle lock receipt identity');
  } finally {
    fs.rmSync(lifecycleLockPath, { force: true });
    fs.renameSync(displacedLifecycleLock, lifecycleLockPath);
  }

  const extraLifecycleLock = path.join(
    migrationControlParent,
    `.manuscript-${'f'.repeat(64)}.lifecycle.lock`,
  );
  fs.writeFileSync(extraLifecycleLock, '');
  try {
    await assertCatalogRejects('migration catalog must reject an extra lifecycle lock');
  } finally {
    fs.rmSync(extraLifecycleLock, { force: true });
  }

  const reparseTarget = path.join(fixture.root, 'catalog-reparse-target');
  const reparseEntry = path.join(
    migrationControlParent,
    '70000000-0000-4000-8000-000000000007',
  );
  fs.mkdirSync(reparseTarget);
  fs.symlinkSync(reparseTarget, reparseEntry, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assertCatalogRejects('migration catalog must reject a reparse sibling');
  } finally {
    fs.unlinkSync(reparseEntry);
    fs.rmSync(reparseTarget, { recursive: true, force: true });
  }

  const exactCatalogEntries = fs.readdirSync(migrationControlParent).sort();
  assert.equal(exactCatalogEntries.length, 4);
  assert.equal(exactCatalogEntries.includes(path.basename(migrationControlDirectory)), true);
  assert.equal(exactCatalogEntries.includes(path.basename(lifecycleLockPath)), true);
  assert.equal(exactCatalogEntries.filter((name) => (
    name.startsWith('.controlstore-') && name.endsWith('.active.json')
  )).length, 1);
  assert.equal(exactCatalogEntries.filter((name) => (
    name.startsWith('.controlstore-') && name.endsWith('.lifecycle.lock')
  )).length, 1);

  const knownRollbackPaths = deriveManuscriptPaths({
    dataRoot: fixture.root,
    projectUid: productionAdmission.databaseFacts.projectUid,
  });
  const knownRollbackSidecarName = fs.readdirSync(knownRollbackPaths.chaptersRoot)
    .find((name) => name.endsWith('.json'));
  assert.equal(typeof knownRollbackSidecarName, 'string');
  const knownRollbackChapterUid = knownRollbackSidecarName.slice(3, -5);
  const knownRollbackSidecarPath = deriveChapterPaths(
    knownRollbackPaths,
    knownRollbackChapterUid,
  ).sidecarPath;
  const knownRollbackSidecar = parseCanonicalJson({
    role: 'chapter_sidecar',
    bytes: fs.readFileSync(knownRollbackSidecarPath),
    expectedUid: knownRollbackChapterUid,
  });
  fs.writeFileSync(knownRollbackSidecarPath, serializeCanonicalJson('chapter_sidecar', {
    ...knownRollbackSidecar,
    title: 'Known rollback startup title',
  }));
  const opensBeforeKnownRollback = sessionCalls.open;
  await assert.rejects(
    withFaults({
      [FAULT_POINTS.NATIVE_FULL_REFRESH_BEFORE_COMMIT_INVOKE]: { throw: 'EIO' },
    }, () => productionRuntime.read(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      { kind: 'volumes' },
    )),
    { code: 'EIO' },
  );
  assert.equal(sessionCalls.open - opensBeforeKnownRollback, 1);
  const retryAfterKnownRollback = await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'volumes' },
  );
  assert.equal(retryAfterKnownRollback.value[0].title, 'Volume one');
  assert.equal(sessionCalls.open - opensBeforeKnownRollback, 2);

  const filesStatusResponse = await fetch(
    `${baseUrl}/projects/by-name/${encodeURIComponent(sourceName)}/files-beta/status`,
  );
  assert.equal(filesStatusResponse.status, 200);
  assert.deepEqual(await filesStatusResponse.json(), {
    route: 'files',
    project_uid: productionAdmission.databaseFacts.projectUid,
    project_instance_id: productionAdmission.databaseFacts.projectInstanceId,
  });
  const fullScansBeforeFirstRead = fullScans;
  const opensBeforeFirstRead = sessionCalls.open;
  const admissionsBeforeFirstRead = sessionCalls.admit;
  const filesVolumesResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(sourceName)}/volumes`,
  );
  assert.equal(
    filesVolumesResponse.status,
    200,
    await filesVolumesResponse.clone().text(),
  );
  const filesVolumes = await filesVolumesResponse.json();
  assert.equal(filesVolumes[0].chapters[0].manuscript_project_uid, productionAdmission.databaseFacts.projectUid);
  assert.equal(filesVolumes[0].chapters[0].project_instance_id, productionAdmission.databaseFacts.projectInstanceId);
  assert.match(filesVolumes[0].chapters[0].chapter_uid, /^[0-9a-f-]{36}$/u);
  assert.match(filesVolumes[0].chapters[0].base_witness.raw_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(sessionCalls.open - opensBeforeFirstRead, 0);
  assert.equal(sessionCalls.admit - admissionsBeforeFirstRead, 1);
  assert.equal(fullScans - fullScansBeforeFirstRead, 2);
  const fullScansBeforeSecondRead = fullScans;
  const productionVolumes = await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'volumes' },
  );
  assert.equal(sessionCalls.open - opensBeforeFirstRead, 0);
  assert.equal(sessionCalls.admit - admissionsBeforeFirstRead, 2);
  assert.equal(fullScans - fullScansBeforeSecondRead, 2);
  assert.equal(productionVolumes.value[0].title, 'Volume one');
  const fullScansBeforeThirdRead = fullScans;
  const productionChapter = await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterId: 1 },
  );
  assert.equal(sessionCalls.open - opensBeforeFirstRead, 0);
  assert.equal(sessionCalls.admit - admissionsBeforeFirstRead, 3);
  assert.equal(fullScans - fullScansBeforeThirdRead, 2);
  assert.match(productionChapter.baseWitness.sidecarRawSha256, /^[0-9a-f]{64}$/u);
  const fullScansBeforeOrdinaryWrite = fullScans;
  await assert.rejects(
    withFaults({
      [FAULT_POINTS.FILE_PUBLICATION_AFTER_FILES_PUBLISHED]: { throw: 'EIO' },
    }, () => productionRuntime.write(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      {
        requestId: 'task14b-production-recovery',
        baseWitness: productionChapter.baseWitness,
        command: {
          kind: 'chapter.replace_body',
          chapterUid: productionChapter.value.chapter_uid,
          expected_data_version: productionChapter.baseWitness.expectedDataVersion,
          content: 'recovered body',
        },
      },
    )),
    { code: 'EIO' },
  );
  assert.equal(fullScans - fullScansBeforeOrdinaryWrite, 1);
  assert.equal(
    (await productionRuntime.recover({
      projectUid: productionAdmission.databaseFacts.projectUid,
    })).status,
    'clean',
  );
  assert.equal((await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterId: 1 },
  )).value.content, 'recovered body');

  const externalBase = await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterId: 1 },
  );
  const manuscriptPaths = deriveManuscriptPaths({
    dataRoot: fixture.root,
    projectUid: productionAdmission.databaseFacts.projectUid,
  });
  const sidecarPath = deriveChapterPaths(
    manuscriptPaths,
    externalBase.value.chapter_uid,
  ).sidecarPath;
  const externalSidecar = parseCanonicalJson({
    role: 'chapter_sidecar',
    bytes: fs.readFileSync(sidecarPath),
    expectedUid: externalBase.value.chapter_uid,
  });
  fs.writeFileSync(sidecarPath, serializeCanonicalJson('chapter_sidecar', {
    ...externalSidecar,
    title: 'External title',
  }));
  const publicationsBeforeExternalRefresh = postPublishProjectionCaptures.length;
  await assert.rejects(
    productionRuntime.write(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      {
        requestId: 'task14b-sidecar-conflict',
        baseWitness: externalBase.baseWitness,
        command: {
          kind: 'chapter.patch_sidecar',
          chapterUid: externalBase.value.chapter_uid,
          expected_data_version: externalBase.baseWitness.expectedDataVersion,
          patch: { title: 'Local title' },
        },
      },
    ),
    (error) => error?.code === 'EXTERNAL_DRAFT_CONFLICT',
  );
  await Promise.resolve();
  assert.deepEqual(
    postPublishProjectionCaptures.slice(publicationsBeforeExternalRefresh),
    [0],
    'a committed FULL must derive its installed projection from the published target without recapture',
  );
  const firstConflicts = await productionRuntime.listDraftConflicts({
    projectUid: productionAdmission.databaseFacts.projectUid,
  });
  const firstReady = firstConflicts.find((conflict) => conflict.state === 'decision_ready');
  assert.equal(firstReady?.backupAvailable, true);
  assert.equal(firstReady?.resource.uid, externalBase.value.chapter_uid);
  assert.equal(firstReady?.resource.domain, 'sidecar');
  const copiedConflict = await productionRuntime.copyDraftConflictBackup(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    {
      conflictId: firstReady.conflictId,
      requestId: 'task14b-copy-conflict',
    },
  );
  const copiedConflictPath = path.join(database.getExportDir(), copiedConflict.filename);
  assert.equal(fs.existsSync(copiedConflictPath), true);
  assert.equal(
    JSON.parse(fs.readFileSync(copiedConflictPath, 'utf8')).command.patch.title,
    'Local title',
  );
  assert.deepEqual(await productionRuntime.resolveDraftConflict(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    {
      action: 'accept_external',
      conflictId: firstReady.conflictId,
      decisionEpoch: firstReady.decisionEpoch,
      requestId: 'task14b-accept-external',
    },
  ), {
    conflictId: firstReady.conflictId,
    decisionEpoch: firstReady.decisionEpoch,
    state: 'resolved_accept_external',
  });
  const acceptedExternal = await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterId: 1 },
  );
  assert.equal(acceptedExternal.value.title, 'External title');

  const acceptedSidecar = parseCanonicalJson({
    role: 'chapter_sidecar',
    bytes: fs.readFileSync(sidecarPath),
    expectedUid: externalBase.value.chapter_uid,
  });
  fs.writeFileSync(sidecarPath, serializeCanonicalJson('chapter_sidecar', {
    ...acceptedSidecar,
    title: 'External title two',
  }));
  await assert.rejects(
    productionRuntime.write(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      {
        requestId: 'task14b-second-sidecar-conflict',
        baseWitness: acceptedExternal.baseWitness,
        command: {
          kind: 'chapter.patch_sidecar',
          chapterUid: externalBase.value.chapter_uid,
          expected_data_version: acceptedExternal.baseWitness.expectedDataVersion,
          patch: { title: 'Local title two' },
        },
      },
    ),
    (error) => error?.code === 'EXTERNAL_DRAFT_CONFLICT',
  );
  const secondConflicts = await productionRuntime.listDraftConflicts({
    projectUid: productionAdmission.databaseFacts.projectUid,
  });
  const secondReady = secondConflicts.find((conflict) => conflict.state === 'decision_ready');
  assert.equal(secondReady?.backupAvailable, true);
  assert.deepEqual(await productionRuntime.resolveDraftConflict(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    {
      action: 'apply_saved_draft',
      conflictId: secondReady.conflictId,
      decisionEpoch: secondReady.decisionEpoch,
      requestId: 'task14b-apply-saved-draft',
    },
  ), {
    conflictId: secondReady.conflictId,
    decisionEpoch: secondReady.decisionEpoch,
    state: 'resolved_apply_draft',
  });
  assert.equal((await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterId: 1 },
  )).value.title, 'Local title two');

  const betaCreationResponse = await fetch(`${baseUrl}/projects/files-beta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mythpen-Request-Id': 'task14b-production-create',
    },
    body: JSON.stringify({
      name: 'task14b-production-creation',
      mode: 'medium-novel',
      language: 'zh',
      genres: ['fantasy'],
    }),
  });
  const createdText = await betaCreationResponse.text();
  assert.equal(betaCreationResponse.status, 201, createdText);
  const created = JSON.parse(createdText);
  assert.equal(created.state, 'activated');
  const createdAdmission = database.inspectProjectManuscriptRoute('task14b-production-creation');
  assert.equal(createdAdmission.route, 'files');

  const listedProjectsResponse = await fetch(`${baseUrl}/projects`);
  assert.equal(
    listedProjectsResponse.status,
    200,
    await listedProjectsResponse.clone().text(),
  );
  const listedProjects = await listedProjectsResponse.json();
  const migratedProject = listedProjects.find((project) => project.name === sourceName);
  const createdProject = listedProjects.find(
    (project) => project.name === 'task14b-production-creation',
  );
  assert.equal(migratedProject?.openState, 'ready');
  assert.equal(migratedProject?.instanceId, productionAdmission.databaseFacts.projectInstanceId);
  assert.equal(createdProject?.openState, 'ready');
  assert.equal(createdProject?.instanceId, createdAdmission.databaseFacts.projectInstanceId);
  assert.equal(createdProject?.mode, 'medium-novel');
  assert.deepEqual(createdProject?.genres, ['玄幻']);

  database.getConfigDb().prepare(`
    UPDATE manuscript_route_cache
    SET project_uid = ?
    WHERE name = ?
  `).run('99999999-9999-4999-8999-999999999999', 'task14b-production-creation');
  database.getConfigDb().flush();
  const rebuiltProjectsResponse = await fetch(`${baseUrl}/projects`);
  assert.equal(rebuiltProjectsResponse.status, 200);
  const rebuiltProjects = await rebuiltProjectsResponse.json();
  assert.equal(
    rebuiltProjects.find((entry) => entry.name === 'task14b-production-creation')?.instanceId,
    createdAdmission.databaseFacts.projectInstanceId,
  );
  assert.equal(database.getConfigDb().prepare(`
    SELECT project_uid FROM manuscript_route_cache WHERE name = ?
  `).get('task14b-production-creation').project_uid, createdAdmission.databaseFacts.projectUid);

  const filesPhaseResponse = await fetch(
    `${baseUrl}/${encodeURIComponent('task14b-production-creation')}/workflow/phase`,
  );
  assert.equal(filesPhaseResponse.status, 200, await filesPhaseResponse.clone().text());
  assert.deepEqual(await filesPhaseResponse.json(), { phase: 'idea' });
  const filesSidebarResponse = await fetch(
    `${baseUrl}/${encodeURIComponent('task14b-production-creation')}/sidebar-items`,
  );
  assert.equal(filesSidebarResponse.status, 200);
  const filesSidebar = await filesSidebarResponse.json();
  assert.equal(filesSidebar.some((item) => item.route === 'page-dashboard'), true);
  const filesExportResponse = await fetch(
    `${baseUrl}/${encodeURIComponent('task14b-production-creation')}/export?format=md`,
  );
  const filesExport = await filesExportResponse.json();
  assert.equal(filesExportResponse.status, 200, JSON.stringify(filesExport));
  assert.equal(filesExport.format, 'md');
  assert.equal(filesExport.chapterCount, 0);
  assert.equal(
    path.dirname(filesExport.filePath),
    path.join(database.getExportDir(), 'task14b-production-creation'),
  );
  const betaCreationRetry = await fetch(`${baseUrl}/projects/files-beta`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mythpen-Request-Id': 'task14b-production-create',
    },
    body: JSON.stringify({
      name: 'task14b-production-creation',
      mode: 'medium-novel',
      language: 'zh',
      genres: ['fantasy'],
    }),
  });
  const betaCreationRetryText = await betaCreationRetry.text();
  assert.equal(betaCreationRetry.status, 201, betaCreationRetryText);
  const retriedCreation = JSON.parse(betaCreationRetryText);
  assert.equal(retriedCreation.creationId, created.creationId);
  assert.equal(retriedCreation.projectUid, created.projectUid);

  const createdProjectName = 'task14b-production-creation';
  async function stableStructureWrite(requestId, command) {
    const current = await productionRuntime.read(
      { projectUid: createdAdmission.databaseFacts.projectUid },
      { kind: 'project' },
    );
    return productionRuntime.write(
      { projectUid: createdAdmission.databaseFacts.projectUid },
      Object.freeze({ requestId, baseWitness: current.baseWitness, command }),
    );
  }
  const createdVolume = await stableStructureWrite(
    'task14b-volume-create',
    Object.freeze({ kind: 'volume.create', title: 'Beta volume', summary: '' }),
  );
  const createdVolumeUid = createdVolume.uid;
  const createdChapter = await stableStructureWrite(
    'task14b-chapter-create',
    Object.freeze({
      kind: 'chapter.create',
      containerVolumeUid: createdVolumeUid,
      requestedNum: null,
      content: '',
      sidecar: Object.freeze({
        title: 'Beta chapter',
        outline: '',
        status: 'pending',
        summary: '',
        cognitive_frame: '',
        emotional_anchor: '',
        world_texture: '',
        concrete_mystery: '',
        interpersonal_tension: '',
      }),
    }),
  );
  const createdChapterUid = createdChapter.uid;
  const polishGenerationStart = await productionRuntime.read(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterUid: createdChapterUid },
  );
  const createdPolishRevision = await productionRuntime.write(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    Object.freeze({
      requestId: 'task14b-polish-revision-create',
      baseWitness: polishGenerationStart.baseWitness,
      command: Object.freeze({
        kind: 'revision.create',
        chapterUid: createdChapterUid,
        baseContent: '',
        proposedContent: 'Polished chapter',
      }),
    }),
  );
  assert.equal(createdPolishRevision.state, 'created');
  assert.equal(createdPolishRevision.revision.chapterUid, createdChapterUid);
  await stableStructureWrite('task14b-polish-revision-reject', Object.freeze({
    kind: 'revision.reject',
    revisionId: createdPolishRevision.revision.id,
    expectedBaseContent: '',
  }));
  const acceptedRevisionStart = await productionRuntime.read(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterUid: createdChapterUid },
  );
  const acceptedRevision = await productionRuntime.write(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    Object.freeze({
      requestId: 'task14b-accepted-revision-create',
      baseWitness: acceptedRevisionStart.baseWitness,
      command: Object.freeze({
        kind: 'revision.create',
        chapterUid: createdChapterUid,
        baseContent: '',
        proposedContent: 'Accepted polished chapter',
      }),
    }),
  );
  assert.equal(acceptedRevision.state, 'created');
  const acceptedRevisionWitness = await productionRuntime.read(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    { kind: 'project' },
  );
  const acceptRevisionRequest = Object.freeze({
    requestId: 'task14b-accepted-revision-publish',
    baseWitness: acceptedRevisionWitness.baseWitness,
    command: Object.freeze({
      kind: 'revision.accept',
      revisionId: acceptedRevision.revision.id,
      expectedBaseContent: '',
    }),
  });
  const acceptedRevisionResult = await productionRuntime.write(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    acceptRevisionRequest,
  );
  assert.equal(acceptedRevisionResult.state, 'accepted');
  assert.equal(acceptedRevisionResult.chapter.content, 'Accepted polished chapter');
  const acceptedRevisionAfter = await productionRuntime.read(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterUid: createdChapterUid },
  );
  assert.equal(
    acceptedRevisionResult.chapter.dataVersion,
    acceptedRevisionAfter.value.data_version,
  );
  assert.ok(acceptedRevisionResult.chapter.dataVersion > acceptedRevisionStart.value.data_version);
  assert.deepEqual(
    await productionRuntime.write(
      { projectUid: createdAdmission.databaseFacts.projectUid },
      acceptRevisionRequest,
    ),
    acceptedRevisionResult,
  );
  await assert.rejects(
    productionRuntime.write(
      { projectUid: createdAdmission.databaseFacts.projectUid },
      Object.freeze({
        requestId: acceptRevisionRequest.requestId,
        baseWitness: acceptRevisionRequest.baseWitness,
        command: Object.freeze({
          kind: 'revision.finalize',
          revisionId: acceptedRevision.revision.id,
          content: 'Accepted polished chapter',
          expectedBaseContent: '',
          expectedDecisions: Object.freeze({}),
        }),
      }),
    ),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  const reboundRevisionStart = await productionRuntime.read(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterUid: createdChapterUid },
  );
  const reboundRequestId = 'task14b-revision-cross-family';
  const reboundRevision = await productionRuntime.write(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    Object.freeze({
      requestId: reboundRequestId,
      baseWitness: reboundRevisionStart.baseWitness,
      command: Object.freeze({
        kind: 'revision.create',
        chapterUid: createdChapterUid,
        baseContent: reboundRevisionStart.value.content,
        proposedContent: 'This rebound must never publish',
      }),
    }),
  );
  const reboundResolutionWitness = await productionRuntime.read(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    { kind: 'project' },
  );
  await assert.rejects(
    productionRuntime.write(
      { projectUid: createdAdmission.databaseFacts.projectUid },
      Object.freeze({
        requestId: reboundRequestId,
        baseWitness: reboundResolutionWitness.baseWitness,
        command: Object.freeze({
          kind: 'revision.accept',
          revisionId: reboundRevision.revision.id,
          expectedBaseContent: reboundRevisionStart.value.content,
        }),
      }),
    ),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  const reboundAfter = await productionRuntime.read(
    { projectUid: createdAdmission.databaseFacts.projectUid },
    { kind: 'revision_snapshot', chapterUid: createdChapterUid },
  );
  assert.equal(reboundAfter.value.revision.status, 'pending');
  assert.equal(
    reboundAfter.value.revision.proposedContent,
    'This rebound must never publish',
  );
  await stableStructureWrite('task14b-chapter-move', Object.freeze({
    kind: 'chapter.move',
    chapterUid: createdChapterUid,
    targetVolumeUid: null,
    targetPosition: 0,
  }));
  await stableStructureWrite('task14b-chapter-order', Object.freeze({
    kind: 'chapter.reorder',
    containerVolumeUid: null,
    chapterUids: Object.freeze([createdChapterUid]),
  }));
  await stableStructureWrite('task14b-volume-order', Object.freeze({
    kind: 'volume.reorder',
    volumeUids: Object.freeze([createdVolumeUid]),
  }));
  await stableStructureWrite('task14b-chapter-delete', Object.freeze({
    kind: 'chapter.delete',
    chapterUid: createdChapterUid,
  }));
  await stableStructureWrite('task14b-volume-delete', Object.freeze({
    kind: 'volume.delete',
    volumeUid: createdVolumeUid,
  }));

  const indexedOrphanChapterUid = '73000000-0000-4000-8000-000000000008';
  const indexedOrphanPaths = deriveChapterPaths(manuscriptPaths, indexedOrphanChapterUid);
  const indexedOrphanBody = Buffer.from('opaque indexed external body', 'utf8');
  const indexedOrphanSidecar = serializeCanonicalJson('chapter_sidecar', {
    ...externalSidecar,
    chapter_uid: indexedOrphanChapterUid,
    title: 'Opaque indexed orphan',
  });
  const indexedVolumeUid = productionVolumes.value[0].volume_uid;
  const indexedVolumePath = deriveVolumePath(manuscriptPaths, indexedVolumeUid);
  const indexedVolume = parseCanonicalJson({
    role: 'volume_index',
    bytes: fs.readFileSync(indexedVolumePath),
    expectedUid: indexedVolumeUid,
  });
  fs.writeFileSync(indexedOrphanPaths.bodyPath, indexedOrphanBody);
  fs.writeFileSync(indexedOrphanPaths.sidecarPath, indexedOrphanSidecar);
  fs.writeFileSync(indexedVolumePath, serializeCanonicalJson('volume_index', {
    ...indexedVolume,
    chapter_uids: [...indexedVolume.chapter_uids, indexedOrphanChapterUid],
  }));
  function indexedOrphanFileFacts() {
    return [indexedOrphanPaths.bodyPath, indexedOrphanPaths.sidecarPath].map((filePath) => {
      const stats = fs.statSync(filePath, { bigint: true });
      return Object.freeze({
        bytes: fs.readFileSync(filePath).toString('hex'),
        dev: stats.dev,
        ino: stats.ino,
        mtimeNs: stats.mtimeNs,
        size: stats.size,
      });
    });
  }
  const indexedFactsBeforeIgnore = indexedOrphanFileFacts();
  const indexedIgnoreResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(sourceName)}/manuscript/orphans/ignore-in-place`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-ignore-indexed-orphan',
      },
      body: JSON.stringify({ kind: 'chapter', uid: indexedOrphanChapterUid }),
    },
  );
  assert.equal(indexedIgnoreResponse.status, 200, await indexedIgnoreResponse.clone().text());
  assert.deepEqual(indexedOrphanFileFacts(), indexedFactsBeforeIgnore);
  const resolutionAfterIndexedIgnore = resolutionScans;

  const preserveIndexedResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(sourceName)}/manuscript/ignored/reference`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-preserve-indexed-orphan',
      },
      body: JSON.stringify({
        action: 'ignored.preserve_move_to_unassigned',
        uid: indexedOrphanChapterUid,
      }),
    },
  );
  assert.equal(
    preserveIndexedResponse.status,
    200,
    await preserveIndexedResponse.clone().text(),
  );
  assert.deepEqual(indexedOrphanFileFacts(), indexedFactsBeforeIgnore);
  assert.equal(resolutionScans, resolutionAfterIndexedIgnore);
  const volumeAfterPreserve = parseCanonicalJson({
    role: 'volume_index',
    bytes: fs.readFileSync(indexedVolumePath),
    expectedUid: indexedVolumeUid,
  });
  const unassignedAfterPreserve = parseCanonicalJson({
    role: 'unassigned',
    bytes: fs.readFileSync(manuscriptPaths.unassignedPath),
  });
  assert.equal(volumeAfterPreserve.chapter_uids.includes(indexedOrphanChapterUid), false);
  assert.equal(unassignedAfterPreserve.chapter_uids.includes(indexedOrphanChapterUid), true);

  const detachIndexedResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(sourceName)}/manuscript/ignored/reference`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-detach-indexed-orphan',
      },
      body: JSON.stringify({
        action: 'ignored.detach_reference',
        uid: indexedOrphanChapterUid,
      }),
    },
  );
  assert.equal(detachIndexedResponse.status, 200, await detachIndexedResponse.clone().text());
  assert.deepEqual(indexedOrphanFileFacts(), indexedFactsBeforeIgnore);
  assert.equal(resolutionScans, resolutionAfterIndexedIgnore);
  const unassignedAfterDetach = parseCanonicalJson({
    role: 'unassigned',
    bytes: fs.readFileSync(manuscriptPaths.unassignedPath),
  });
  assert.equal(unassignedAfterDetach.chapter_uids.includes(indexedOrphanChapterUid), false);

  const orphanChapterUid = '73000000-0000-4000-8000-000000000007';
  const orphanPaths = deriveChapterPaths(manuscriptPaths, orphanChapterUid);
  const orphanBody = Buffer.from('opaque external orphan body', 'utf8');
  const orphanSidecar = serializeCanonicalJson('chapter_sidecar', {
    ...externalSidecar,
    chapter_uid: orphanChapterUid,
    title: 'Opaque orphan',
  });
  fs.writeFileSync(orphanPaths.bodyPath, orphanBody);
  fs.writeFileSync(orphanPaths.sidecarPath, orphanSidecar);
  function orphanFileFacts() {
    return [orphanPaths.bodyPath, orphanPaths.sidecarPath].map((filePath) => {
      const stats = fs.statSync(filePath, { bigint: true });
      return Object.freeze({
        bytes: fs.readFileSync(filePath).toString('hex'),
        dev: stats.dev,
        ino: stats.ino,
        mtimeNs: stats.mtimeNs,
        size: stats.size,
      });
    });
  }
  const factsBeforeIgnore = orphanFileFacts();
  await restartProductionRuntime();
  const fullBeforeIgnore = fullScans;
  const resolutionBeforeIgnore = resolutionScans;
  const opensBeforeIgnore = sessionCalls.open;
  assert.equal((await productionRuntime.ignoreInPlace(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    Object.freeze({
      requestId: 'task14b-production-ignore-orphan',
      kind: 'chapter',
      uid: orphanChapterUid,
    }),
  )).disposition, 'after');
  assert.equal(resolutionScans - resolutionBeforeIgnore, 1);
  assert.equal(
    (fullScans - fullBeforeIgnore) - (resolutionScans - resolutionBeforeIgnore),
    0,
  );
  assert.equal(sessionCalls.open - opensBeforeIgnore, 1);
  assert.deepEqual(orphanFileFacts(), factsBeforeIgnore);

  await restartProductionRuntime();
  const factsBeforeRevoke = orphanFileFacts();
  const fullBeforeRevoke = fullScans;
  const resolutionBeforeRevoke = resolutionScans;
  const opensBeforeRevoke = sessionCalls.open;
  assert.equal((await productionRuntime.revokeIgnore(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    Object.freeze({
      requestId: 'task14b-production-revoke-orphan',
      kind: 'chapter',
      uid: orphanChapterUid,
    }),
  )).disposition, 'after');
  assert.equal(resolutionScans - resolutionBeforeRevoke, 1);
  assert.equal(
    (fullScans - fullBeforeRevoke) - (resolutionScans - resolutionBeforeRevoke),
    0,
  );
  assert.equal(sessionCalls.open - opensBeforeRevoke, 1);
  assert.deepEqual(orphanFileFacts(), factsBeforeRevoke);
  await restartProductionRuntime();
  const fullBeforeRevokedOrdinaryRead = fullScans;
  const resolutionBeforeConcurrentRetry = resolutionScans;
  const opensBeforeConcurrentRetry = sessionCalls.open;
  const barrier = { entered: deferred(), release: deferred() };
  blockedFull = barrier;
  const ordinaryRead = productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'volumes' },
  );
  await barrier.entered.promise;
  const concurrentIgnore = productionRuntime.ignoreInPlace(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    Object.freeze({
      requestId: 'task14b-concurrent-retry-ignore',
      kind: 'chapter',
      uid: orphanChapterUid,
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sessionCalls.open - opensBeforeConcurrentRetry, 1);
  assert.equal(resolutionScans - resolutionBeforeConcurrentRetry, 0);
  barrier.release.resolve();
  await assert.rejects(
    ordinaryRead,
    (error) => error?.code === 'EXTERNAL_RESOURCE_CREATION_UNSUPPORTED',
  );
  assert.equal((await concurrentIgnore).disposition, 'after');
  assert.equal(resolutionScans - resolutionBeforeConcurrentRetry, 1);
  assert.equal(
    (fullScans - fullBeforeRevokedOrdinaryRead)
      - (resolutionScans - resolutionBeforeConcurrentRetry),
    1,
  );
  assert.equal(sessionCalls.open - opensBeforeConcurrentRetry, 2);
  fs.rmSync(orphanPaths.bodyPath, { force: true });
  fs.rmSync(orphanPaths.sidecarPath, { force: true });
  fs.rmSync(indexedOrphanPaths.bodyPath, { force: true });
  fs.rmSync(indexedOrphanPaths.sidecarPath, { force: true });
  assert.equal(database.getConfigDb().prepare(
    'SELECT COUNT(*) AS count FROM recent_projects WHERE name = ?',
  ).get('task14b-production-creation').count, 0);
  await new Promise((resolve) => server.close(resolve));

  await productionRuntime.close();
  assert.equal(sessionCalls.close, sessionCalls.open - 2);
  await database.closeAllDatabases();
  database.configureStorage({ dataDir: fixture.root });
  await database.initDatabase();
  productionRuntime = createProductionManuscriptRuntime();
  delete require.cache[require.resolve('../routes/api')];
  delete require.cache[require.resolve('../manuscript/runtime')];
  require('../manuscript/runtime').installManuscriptRuntime(productionRuntime);
  const reopenedApp = express();
  reopenedApp.use(express.json());
  reopenedApp.use('/api', require('../routes/api'));
  const reopenedServer = await new Promise((resolve) => {
    const listening = reopenedApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const reopenedBaseUrl = `http://127.0.0.1:${reopenedServer.address().port}/api`;
  const reopenedProjects = await (await fetch(`${reopenedBaseUrl}/projects`)).json();
  const reopenedMigrated = reopenedProjects.find((project) => project.name === sourceName);
  const reopenedCreated = reopenedProjects.find((project) => project.name === createdProjectName);
  assert.equal(reopenedMigrated?.instanceId, productionAdmission.databaseFacts.projectInstanceId);
  assert.equal(reopenedCreated?.instanceId, createdAdmission.databaseFacts.projectInstanceId);
  assert.equal(database.getConfigDb().prepare(
    'SELECT COUNT(*) AS count FROM recent_projects WHERE name = ?',
  ).get(createdProjectName).count, 0);
  const reopenedMetadata = await (await fetch(
    `${reopenedBaseUrl}/projects/by-name/${encodeURIComponent(createdProjectName)}`,
  )).json();
  assert.equal(reopenedMetadata.project_instance_id, createdAdmission.databaseFacts.projectInstanceId);
  const reopenedSidebar = await (await fetch(
    `${reopenedBaseUrl}/${encodeURIComponent(createdProjectName)}/sidebar-items`,
  )).json();
  assert.equal(reopenedSidebar.some((item) => item.route === 'page-dashboard'), true);
  assert.deepEqual(await (await fetch(
    `${reopenedBaseUrl}/${encodeURIComponent(createdProjectName)}/workflow/phase`,
  )).json(), { phase: 'idea' });
  assert.equal((await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterId: 1 },
  )).value.content, 'recovered body');
  const postCommitSidecar = parseCanonicalJson({
    role: 'chapter_sidecar',
    bytes: fs.readFileSync(knownRollbackSidecarPath),
    expectedUid: knownRollbackChapterUid,
  });
  fs.writeFileSync(knownRollbackSidecarPath, serializeCanonicalJson('chapter_sidecar', {
    ...postCommitSidecar,
    title: 'Post-commit unknown title',
  }));
  await assert.rejects(
    withFaults({
      [FAULT_POINTS.NATIVE_FULL_REFRESH_AFTER_COMMIT_RETURN]: { throw: 'EIO' },
    }, () => productionRuntime.read(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      { kind: 'volumes' },
    )),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error?.cause?.code === 'EIO',
  );
  await assert.rejects(
    productionRuntime.read(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      { kind: 'volumes' },
    ),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  await new Promise((resolve) => reopenedServer.close(resolve));
});

test('stale baseWitness returns EXTERNAL_DRAFT_CONFLICT before every L2 publication write', async () => {
  assert.equal(typeof createManuscriptRuntime, 'function');
  const counters = {};
  const runtime = makeRuntime(filesAdmission('migration'), counters);
  await assert.rejects(
    runtime.write({ projectUid: PROJECT_UID }, {
      requestId: 'stale-write',
      baseWitness: {
        generation: 0,
        rawSha256: hash('stale body'),
        sidecarRawSha256: hash('stale sidecar'),
        expectedDataVersion: 6,
      },
      command: {
        kind: 'chapter.replace_body_and_sidecar',
        chapterUid: CHAPTER_UID,
        expected_data_version: 6,
        content: 'local draft',
        patch: { title: 'Local title' },
      },
    }),
    (error) => error?.code === 'EXTERNAL_DRAFT_CONFLICT',
  );
  assert.equal(counters.fileWrites || 0, 0);
  assert.equal(counters.witnessReads || 0, 0);
  assert.equal(counters.journalWrites || 0, 0);
  assert.equal(counters.projectionWrites || 0, 0);
});

test('schema11 ordinary read and numeric-ID write remain on the sqlite backend unchanged', async () => {
  const counters = {};
  const runtime = makeRuntime(deepFreeze({
    route: 'sqlite',
    databaseFacts: deepFreeze({ schemaVersion: 11 }),
  }), counters);
  const read = await runtime.read(7, Object.freeze({ kind: 'chapter', chapterId: 3 }));
  assert.deepEqual(read, {
    sqlite: true,
    request: { kind: 'chapter', chapterId: 3 },
  });
  const write = await runtime.write(7, Object.freeze({
    requestId: 'schema11-numeric-write',
    baseWitness: null,
    command: Object.freeze({ kind: 'chapter.delete', chapterId: 3 }),
  }));
  assert.deepEqual(write, { sqlite: true, requestId: 'schema11-numeric-write' });
  assert.equal(counters.sqliteReads, 1);
  assert.equal(counters.sqliteWrites, 1);
  assert.equal(counters.fileReads || 0, 0);
  assert.equal(counters.fileWrites || 0, 0);
});

test('files aggregate product reads use one admission while sqlite keeps its legacy owner', async () => {
  const filesCounters = {};
  const filesRuntime = makeRuntime(filesAdmission('migration'), filesCounters);
  for (const kind of [
    'prompt_context',
    'product_view',
    'stats',
    'export_snapshot',
    'character_associations',
  ]) {
    const filesResult = await filesRuntime.read(
      { projectUid: PROJECT_UID },
      Object.freeze({ kind }),
    );
    assert.deepEqual(filesResult.value, [{ uid: VOLUME_UID, title: 'Volume one' }]);
  }
  assert.equal(filesCounters.fileReads, 5);
  assert.equal(filesCounters.sqliteReads || 0, 0);

  const sqliteCounters = {};
  const sqliteRuntime = makeRuntime(deepFreeze({
    route: 'sqlite',
    databaseFacts: deepFreeze({ schemaVersion: 11 }),
  }), sqliteCounters);
  for (const kind of [
    'prompt_context',
    'product_view',
    'stats',
    'export_snapshot',
    'character_associations',
  ]) {
    const sqliteResult = await sqliteRuntime.read(7, Object.freeze({ kind }));
    assert.equal(sqliteResult.sqlite, true);
  }
  assert.equal(sqliteCounters.sqliteReads, 5);
  assert.equal(sqliteCounters.fileReads || 0, 0);
});

test('runtime close awaits files teardown before closing the sqlite backend', async () => {
  const order = [];
  let releaseFiles;
  const filesReleased = new Promise((resolve) => { releaseFiles = resolve; });
  const runtime = createManuscriptRuntime({
    routeResolver: { async admit() { return deepFreeze({ route: 'sqlite' }); } },
    sqlite: {
      async read() {}, async write() {}, async recover() {},
      close() { order.push('sqlite'); },
    },
    files: {
      async ignoreInPlace() {}, async read() {}, async write() {}, async recover() {},
      async revokeIgnore() {},
      async close() {
        order.push('files:start');
        await filesReleased;
        order.push('files:done');
      },
    },
    creation: { async create() {} },
    migration: { async migrate() {}, async recover() {} },
  });
  const closing = runtime.close();
  assert.strictEqual(runtime.close(), closing);
  await Promise.resolve();
  assert.deepEqual(order, ['files:start']);
  releaseFiles();
  await closing;
  assert.deepEqual(order, ['files:start', 'files:done', 'sqlite']);
});

test('runtime close drains already-started creation and migration before backend teardown', async () => {
  for (const operation of ['create', 'migrate']) {
    const order = [];
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const runtime = createManuscriptRuntime({
      routeResolver: { async admit() { return deepFreeze({ route: 'sqlite' }); } },
      sqlite: {
        async read() {}, async write() {}, async recover() {},
        close() { order.push('sqlite:close'); },
      },
      files: {
        async ignoreInPlace() {}, async read() {}, async write() {}, async recover() {},
        async revokeIgnore() {},
        close() { order.push('files:close'); },
      },
      creation: {
        async create() {
          order.push('create:start');
          await blocked;
          order.push('create:done');
          return deepFreeze({
            creationId: CREATION_ID,
            projectUid: PROJECT_UID,
            state: 'activated',
          });
        },
      },
      migration: {
        async migrate() {
          order.push('migrate:start');
          await blocked;
          order.push('migrate:done');
          return deepFreeze({ state: 'activated' });
        },
        async recover() {},
      },
    });
    const active = operation === 'create'
      ? runtime.createProject({
        requestId: 'drain-create',
        name: 'Novel',
        mode: 'medium-novel',
        language: 'zh',
        genres: ['fantasy'],
      })
      : runtime.migrateProject({
        requestId: 'drain-migrate',
        projectSelector: { projectName: 'Novel' },
      });
    const closing = runtime.close();
    await Promise.resolve();
    assert.deepEqual(order, [`${operation}:start`]);
    release();
    await active;
    await closing;
    assert.deepEqual(order, [
      `${operation}:start`,
      `${operation}:done`,
      'files:close',
      'sqlite:close',
    ]);
  }
});

test('runtime owns exact orphan action entrypoints and never accepts caller action or family', async () => {
  const calls = [];
  const admission = filesAdmission('migration');
  const files = {
    async read() {},
    async write() {},
    async recover() {},
    close() {},
    async ignoreInPlace(receivedAdmission, request) {
      calls.push(Object.freeze({ method: 'ignoreInPlace', receivedAdmission, request }));
      return Object.freeze({ state: 'ignored' });
    },
    async revokeIgnore(receivedAdmission, request) {
      calls.push(Object.freeze({ method: 'revokeIgnore', receivedAdmission, request }));
      return Object.freeze({ state: 'revoked' });
    },
  };
  let admissions = 0;
  const runtime = createManuscriptRuntime({
    routeResolver: { async admit() { admissions += 1; return admission; } },
    sqlite: { async read() {}, async write() {}, async recover() {}, close() {} },
    files,
    creation: { async create() {} },
    migration: { async migrate() {}, async recover() {} },
  });
  const request = Object.freeze({
    requestId: 'orphan-ignore',
    kind: 'chapter',
    uid: '70000000-0000-4000-8000-000000000007',
  });
  assert.deepEqual(await runtime.ignoreInPlace({ projectUid: PROJECT_UID }, request), {
    state: 'ignored',
  });
  assert.deepEqual(await runtime.revokeIgnore({ projectUid: PROJECT_UID }, {
    ...request,
    requestId: 'orphan-revoke',
  }), { state: 'revoked' });
  assert.equal(admissions, 2);
  assert.deepEqual(calls.map((call) => call.method), ['ignoreInPlace', 'revokeIgnore']);
  assert.deepEqual(calls.map((call) => call.request), [
    request,
    Object.freeze({ ...request, requestId: 'orphan-revoke' }),
  ]);
  await assert.rejects(
    runtime.ignoreInPlace({ projectUid: PROJECT_UID }, { ...request, action: 'revoke_ignore' }),
    TypeError,
  );
  await assert.rejects(
    runtime.revokeIgnore({ projectUid: PROJECT_UID }, { ...request, family: 'orphan_resolution' }),
    TypeError,
  );
  assert.equal(admissions, 2);
});

test('runtime captures only own data port methods without invoking getters or prototypes', () => {
  let getterCalls = 0;
  const poisonFiles = {
    async read() {},
    async write() {},
    async recover() {},
    close() {},
    async ignoreInPlace() {},
    async revokeIgnore() {},
  };
  Object.defineProperty(poisonFiles, 'write', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('poisoned files.write getter');
    },
  });
  assert.throws(() => createManuscriptRuntime({
    routeResolver: { async admit() {} },
    sqlite: { async read() {}, async write() {}, async recover() {}, close() {} },
    files: poisonFiles,
    creation: { async create() {} },
    migration: { async migrate() {}, async recover() {} },
  }), TypeError);
  assert.equal(getterCalls, 0);

  const inheritedRouteResolver = Object.create({ async admit() {} });
  assert.throws(() => createManuscriptRuntime({
    routeResolver: inheritedRouteResolver,
    sqlite: { async read() {}, async write() {}, async recover() {}, close() {} },
    files: {
      async read() {}, async write() {}, async recover() {}, close() {},
      async ignoreInPlace() {}, async revokeIgnore() {},
    },
    creation: { async create() {} },
    migration: { async migrate() {}, async recover() {} },
  }), TypeError);
});

test('runtime rejects projectName path aliases before route admission', async () => {
  let admissions = 0;
  const routeRuntime = createManuscriptRuntime({
    routeResolver: {
      async admit() { admissions += 1; return deepFreeze({ route: 'sqlite' }); },
    },
    sqlite: { async read() {}, async write() {}, async recover() {}, close() {} },
    files: {
      async ignoreInPlace() {}, async read() {}, async write() {}, async recover() {},
      async revokeIgnore() {}, close() {},
    },
    creation: { async create() {} },
    migration: { async migrate() {}, async recover() {} },
  });
  for (const projectName of [
    '.', '..', '../Novel', 'folder/Novel', 'folder\\Novel', 'Novel.', 'Novel.db',
  ]) {
    await assert.rejects(
      routeRuntime.read({ projectName }, { kind: 'project' }),
      TypeError,
      projectName,
    );
  }
  assert.equal(admissions, 0);
});

test('runtime rejects sparse or accessor arrays without invoking array getters', async () => {
  const runtime = makeRuntime(filesAdmission('creation'));
  const sparseGenres = [];
  sparseGenres.length = 1;
  await assert.rejects(runtime.createProject({
    requestId: 'sparse-genres',
    name: 'Novel',
    mode: 'medium-novel',
    language: 'zh',
    genres: sparseGenres,
  }), TypeError);

  let elementReads = 0;
  const accessorGenres = [];
  Object.defineProperty(accessorGenres, '0', {
    enumerable: true,
    get() {
      elementReads += 1;
      return 'fantasy';
    },
  });
  accessorGenres.length = 1;
  await assert.rejects(runtime.createProject({
    requestId: 'accessor-genres',
    name: 'Novel',
    mode: 'medium-novel',
    language: 'zh',
    genres: accessorGenres,
  }), TypeError);
  assert.equal(elementReads, 0);

  let mapReads = 0;
  const poisonedMapGenres = ['fantasy'];
  Object.defineProperty(poisonedMapGenres, 'map', {
    enumerable: true,
    get() {
      mapReads += 1;
      throw new Error('poisoned array map');
    },
  });
  await assert.rejects(runtime.createProject({
    requestId: 'poisoned-map-genres',
    name: 'Novel',
    mode: 'medium-novel',
    language: 'zh',
    genres: poisonedMapGenres,
  }), TypeError);
  assert.equal(mapReads, 0);
});

test('runtime rejects parallel files witness and command-resolution seams', () => {
  const files = {
    async ignoreInPlace() {}, async read() {}, async write() {}, async recover() {},
    async revokeIgnore() {}, close() {},
    async snapshotWitness() {},
  };
  assert.throws(() => createManuscriptRuntime({
    routeResolver: { async admit() { return deepFreeze({ route: 'sqlite' }); } },
    sqlite: { async read() {}, async write() {}, async recover() {}, close() {} },
    files,
    creation: { async create() {} },
    migration: { async migrate() {}, async recover() {} },
  }), TypeError);
});

test('schema-12 proof table rejects missing or mismatched migration and creation activation before files open', async () => {
  assert.equal(typeof createManuscriptRuntime, 'function');
  const variants = [
    ['missing migration proof', filesAdmission('migration', { activatedProof: null })],
    ['mismatched migration proof', filesAdmission('migration', {
      activatedProof: deepFreeze({
        ...filesAdmission('migration').activatedProof,
        journalId: CREATION_ID,
      }),
    })],
    ['missing creation proof', filesAdmission('creation', { activatedProof: null })],
    ['mismatched creation generation', filesAdmission('creation', {
      activatedProof: deepFreeze({
        ...filesAdmission('creation').activatedProof,
        targetGeneration: 2,
      }),
    })],
  ];
  for (const [label, admission] of variants) {
    const counters = {};
    const runtime = makeRuntime(admission, counters);
    await assert.rejects(
      runtime.read({ projectUid: PROJECT_UID }, { kind: 'chapter', chapterUid: CHAPTER_UID }),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      label,
    );
    assert.equal(counters.fileReads || 0, 0, label);
    assert.equal(counters.witnessReads || 0, 0, label);
  }
});
