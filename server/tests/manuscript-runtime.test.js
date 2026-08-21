'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const { parseCanonicalJson, serializeCanonicalJson } = require('../manuscript/format');
const { deriveChapterPaths, deriveManuscriptPaths } = require('../manuscript/paths');
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
    async read(_admission, request) {
      counters.fileReads = (counters.fileReads || 0) + 1;
      if (request.kind === 'chapter') {
        return deepFreeze({ uid: CHAPTER_UID, content: 'chapter body', title: 'Chapter one' });
      }
      return deepFreeze([{ uid: VOLUME_UID, title: 'Volume one' }]);
    },
    async snapshotWitness() {
      counters.witnessReads = (counters.witnessReads || 0) + 1;
      return deepFreeze({ ...state });
    },
    async resolveCommand(_admission, command) {
      counters.commandResolutions = (counters.commandResolutions || 0) + 1;
      return deepFreeze({ ...command, resolvedByServer: true });
    },
    async write(_admission, request) {
      counters.fileWrites = (counters.fileWrites || 0) + 1;
      counters.journalWrites = (counters.journalWrites || 0) + 1;
      counters.projectionWrites = (counters.projectionWrites || 0) + 1;
      state.generation += 1;
      state.rawSha256 = hash(JSON.stringify(request.command));
      state.sidecarRawSha256 = hash(`sidecar:${JSON.stringify(request.command)}`);
      state.expectedDataVersion += 1;
      return deepFreeze({ state: 'committed', generation: state.generation });
    },
    async recover() { return deepFreeze({ state: 'ready' }); },
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

test('files happy table composes migrated and newly-created projects while sqlite stays explicit', async (t) => {
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
    runtime.close();
  }

  const counters = {};
  const sqliteRuntime = makeRuntime(deepFreeze({ route: 'sqlite' }), counters);
  assert.equal((await sqliteRuntime.read(1, { kind: 'chapter', chapterId: 1 })).sqlite, true);
  assert.equal((await sqliteRuntime.write(1, {
    requestId: 'sqlite-write', baseWitness: null, command: { kind: 'chapter.delete', chapterId: 1 },
  })).sqlite, true);
  assert.equal(counters.sqliteReads, 1);
  assert.equal(counters.sqliteWrites, 1);

  const buildInfo = require('../build-info');
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'fixture_only',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  const fixture = require('../testing/native-stage-c-fixture').createNativeStageCFixture();
  const receipt = require('../native/native-activation-authority')
    .authorizeNativeActivation({ root: fixture.root })
    .consume();
  const database = require('../db');
  const controller = require('../testing/fixture-native-activation-controller')
    .createFixtureNativeActivationController({ receipt, root: fixture.root });
  let productionRuntime = null;
  t.after(() => {
    try { productionRuntime?.close(); } catch {}
    try { database.closeAllDatabases(); } catch {}
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
  const filesStatusResponse = await fetch(
    `${baseUrl}/projects/by-name/${encodeURIComponent(sourceName)}/files-beta/status`,
  );
  assert.equal(filesStatusResponse.status, 200);
  assert.deepEqual(await filesStatusResponse.json(), {
    route: 'files',
    project_uid: productionAdmission.databaseFacts.projectUid,
    project_instance_id: productionAdmission.databaseFacts.projectInstanceId,
  });
  const filesVolumesResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(sourceName)}/volumes`,
  );
  assert.equal(filesVolumesResponse.status, 200);
  const filesVolumes = await filesVolumesResponse.json();
  assert.equal(filesVolumes[0].chapters[0].manuscript_project_uid, productionAdmission.databaseFacts.projectUid);
  assert.equal(filesVolumes[0].chapters[0].project_instance_id, productionAdmission.databaseFacts.projectInstanceId);
  assert.match(filesVolumes[0].chapters[0].chapter_uid, /^[0-9a-f-]{36}$/u);
  assert.match(filesVolumes[0].chapters[0].base_witness.raw_sha256, /^[0-9a-f]{64}$/u);
  const productionVolumes = await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'volumes' },
  );
  assert.equal(productionVolumes.value[0].title, 'Volume one');
  const productionChapter = await productionRuntime.read(
    { projectUid: productionAdmission.databaseFacts.projectUid },
    { kind: 'chapter', chapterId: 1 },
  );
  assert.match(productionChapter.baseWitness.sidecarRawSha256, /^[0-9a-f]{64}$/u);
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
          chapterId: 1,
          expected_data_version: productionChapter.baseWitness.expectedDataVersion,
          content: 'recovered body',
        },
      },
    )),
    { code: 'EIO' },
  );
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
  await assert.rejects(
    productionRuntime.write(
      { projectUid: productionAdmission.databaseFacts.projectUid },
      {
        requestId: 'task14b-sidecar-conflict',
        baseWitness: externalBase.baseWitness,
        command: {
          kind: 'chapter.patch_sidecar',
          chapterId: 1,
          expected_data_version: externalBase.baseWitness.expectedDataVersion,
          patch: { title: 'Local title' },
        },
      },
    ),
    (error) => error?.code === 'EXTERNAL_DRAFT_CONFLICT',
  );
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
  const created = await betaCreationResponse.json();
  assert.equal(betaCreationResponse.status, 201);
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

  const filesPhaseResponse = await fetch(
    `${baseUrl}/${encodeURIComponent('task14b-production-creation')}/workflow/phase`,
  );
  assert.equal(filesPhaseResponse.status, 200);
  assert.deepEqual(await filesPhaseResponse.json(), { phase: 'idea' });
  const filesSidebarResponse = await fetch(
    `${baseUrl}/${encodeURIComponent('task14b-production-creation')}/sidebar-items`,
  );
  assert.equal(filesSidebarResponse.status, 200);
  const filesSidebar = await filesSidebarResponse.json();
  assert.equal(filesSidebar.some((item) => item.route === 'page-dashboard'), true);
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
  const retriedCreation = await betaCreationRetry.json();
  assert.equal(betaCreationRetry.status, 201);
  assert.equal(retriedCreation.creationId, created.creationId);
  assert.equal(retriedCreation.projectUid, created.projectUid);

  const createdProjectName = 'task14b-production-creation';
  async function structureWitness() {
    const response = await fetch(
      `${baseUrl}/${encodeURIComponent(createdProjectName)}/manuscript/witness`,
    );
    assert.equal(response.status, 200);
    return (await response.json()).base_witness;
  }
  async function structureMutation(pathname, body, requestId) {
    const response = await fetch(`${baseUrl}/${encodeURIComponent(createdProjectName)}${pathname}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': requestId,
      },
      body: JSON.stringify({ ...body, base_witness: await structureWitness() }),
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    return response.json();
  }
  const createVolumeResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(createdProjectName)}/volumes`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-volume-create',
      },
      body: JSON.stringify({
        title: 'Beta volume',
        summary: '',
        base_witness: await structureWitness(),
      }),
    },
  );
  assert.equal(createVolumeResponse.status, 201);
  const createdVolumes = await (await fetch(
    `${baseUrl}/${encodeURIComponent(createdProjectName)}/volumes`,
  )).json();
  const createdVolumeId = createdVolumes[0].id;
  const createChapterResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(createdProjectName)}/chapters`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-chapter-create',
      },
      body: JSON.stringify({
        title: 'Beta chapter',
        volume_id: createdVolumeId,
        base_witness: await structureWitness(),
      }),
    },
  );
  assert.equal(createChapterResponse.status, 201);
  const createdChapters = await (await fetch(
    `${baseUrl}/${encodeURIComponent(createdProjectName)}/chapters`,
  )).json();
  const createdChapterId = createdChapters[0].id;
  await structureMutation(`/chapters/${createdChapterId}/move`, {
    target_volume_id: null,
    target_position: 0,
  }, 'task14b-chapter-move');
  await structureMutation('/chapters/order', {
    container_volume_id: null,
    chapter_ids: [createdChapterId],
  }, 'task14b-chapter-order');
  await structureMutation('/volumes/order', {
    volume_ids: [createdVolumeId],
  }, 'task14b-volume-order');
  const deleteChapterResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(createdProjectName)}/chapters/${createdChapters[0].num}`
      + `?chapter_id=${createdChapterId}`,
    {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-chapter-delete',
      },
      body: JSON.stringify({ base_witness: await structureWitness() }),
    },
  );
  assert.equal(
    deleteChapterResponse.status,
    200,
    await deleteChapterResponse.clone().text(),
  );
  const deleteVolumeResponse = await fetch(
    `${baseUrl}/${encodeURIComponent(createdProjectName)}/volumes/${createdVolumeId}`,
    {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Mythpen-Request-Id': 'task14b-volume-delete',
      },
      body: JSON.stringify({ base_witness: await structureWitness() }),
    },
  );
  assert.equal(
    deleteVolumeResponse.status,
    200,
    await deleteVolumeResponse.clone().text(),
  );
  assert.equal(database.getConfigDb().prepare(
    'SELECT COUNT(*) AS count FROM recent_projects WHERE name = ?',
  ).get('task14b-production-creation').count, 0);
  await new Promise((resolve) => server.close(resolve));

  productionRuntime.close();
  database.closeAllDatabases();
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
  assert.equal(counters.journalWrites || 0, 0);
  assert.equal(counters.projectionWrites || 0, 0);
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
