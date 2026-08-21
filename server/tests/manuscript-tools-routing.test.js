const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const PROJECT_NAME = 'files-tools-routing';
const PROJECT_UID = '70000000-0000-4000-8000-000000000001';
const CHAPTER_UID = '71000000-0000-4000-8000-000000000001';
const VOLUME_UID = '72000000-0000-4000-8000-000000000001';
const SECOND_CHAPTER_UID = '71000000-0000-4000-8000-000000000002';
const SECOND_VOLUME_UID = '72000000-0000-4000-8000-000000000002';
const BASE_WITNESS = Object.freeze({
  expectedDataVersion: 0,
  generation: 2,
  rawSha256: 'a'.repeat(64),
  sidecarRawSha256: null,
});

function installFilesHarness(t, { read, write = async () => Object.freeze({ state: 'completed' }) }) {
  const database = require('../db');
  const runtimeModule = require('../manuscript/runtime');
  const originalInspect = database.inspectProjectManuscriptRoute;
  const originalGetProjectDb = database.getProjectDb;
  const originalProjectQuery = database.projectQuery;
  const originalGetRuntime = runtimeModule.getManuscriptRuntime;
  const calls = { getProjectDb: 0, projectQuery: 0, reads: [], writes: [] };
  const runtime = Object.freeze({
    async read(selector, request) {
      calls.reads.push(Object.freeze({ selector, request }));
      return read(selector, request);
    },
    async write(selector, request) {
      calls.writes.push(Object.freeze({ selector, request }));
      return write(selector, request);
    },
  });
  database.inspectProjectManuscriptRoute = () => Object.freeze({
    route: 'files',
    databaseFacts: Object.freeze({ projectUid: PROJECT_UID }),
  });
  database.getProjectDb = () => {
    calls.getProjectDb += 1;
    throw new Error('files tools must not open the legacy project database');
  };
  database.projectQuery = () => {
    calls.projectQuery += 1;
    throw new Error('files tools must not execute a legacy project query');
  };
  runtimeModule.getManuscriptRuntime = () => runtime;
  t.after(() => {
    database.inspectProjectManuscriptRoute = originalInspect;
    database.getProjectDb = originalGetProjectDb;
    database.projectQuery = originalProjectQuery;
    runtimeModule.getManuscriptRuntime = originalGetRuntime;
  });
  return calls;
}

test('files list_chapters reads through the installed manuscript runtime without opening legacy DB', async (t) => {
  const chapters = Object.freeze([Object.freeze({
    chapter_uid: CHAPTER_UID,
    volume_uid: VOLUME_UID,
    title: 'Runtime chapter',
  })]);
  const calls = installFilesHarness(t, {
    read: async () => Object.freeze({
      value: chapters,
      baseWitness: BASE_WITNESS,
    }),
  });
  const { executeTool } = require('../tools');

  const result = await executeTool(PROJECT_NAME, 'list_chapters', Object.freeze({}));

  assert.strictEqual(result, chapters);
  assert.equal(calls.getProjectDb, 0);
  assert.equal(calls.reads.length, 1);
  assert.deepEqual(calls.reads[0], {
    selector: { projectUid: PROJECT_UID },
    request: { kind: 'chapters' },
  });
  assert.equal(calls.writes.length, 0);
});

test('files chapter and volume reads accept only stable UIDs and use runtime projections', async (t) => {
  const chapter = Object.freeze({
    id: 11,
    chapter_uid: CHAPTER_UID,
    volume_id: 3,
    volume_uid: VOLUME_UID,
    num: 5,
    title: 'Runtime detail',
    content: 'body',
  });
  const volumes = Object.freeze([Object.freeze({
    id: 3,
    volume_uid: VOLUME_UID,
    title: 'Runtime volume',
    chapters: Object.freeze([chapter]),
  })]);
  const calls = installFilesHarness(t, {
    read: async (_selector, request) => Object.freeze({
      value: request.kind === 'chapter' ? chapter : volumes,
      baseWitness: BASE_WITNESS,
    }),
  });
  const { executeTool } = require('../tools');

  assert.strictEqual(await executeTool(PROJECT_NAME, 'get_chapter', {
    chapter_uid: CHAPTER_UID,
  }), chapter);
  assert.strictEqual(await executeTool(PROJECT_NAME, 'list_volumes', {}), volumes);

  assert.deepEqual(calls.reads, [
    {
      selector: { projectUid: PROJECT_UID },
      request: { kind: 'chapter', chapterUid: CHAPTER_UID },
    },
    {
      selector: { projectUid: PROJECT_UID },
      request: { kind: 'volumes' },
    },
  ]);
  assert.equal(calls.getProjectDb, 0);
});

test('files stats and project metadata are derived from one admitted runtime read each', async (t) => {
  const stats = Object.freeze({
    totalWords: 321,
    chapterCount: 2,
    characterCount: 3,
    foreshadowCount: 4,
    worldCount: 5,
    sciCount: 6,
  });
  const productView = Object.freeze({
    metadata: Object.freeze({
      name: 'Files novel',
      genres: Object.freeze(['sci-fi', 'other']),
      mode: 'medium-novel',
      language: 'zh',
      workflow_phase: 'writing',
      word_count: '999',
      author_name: 'Author',
      description: 'Description',
    }),
    summary: Object.freeze({ wordCount: 321 }),
  });
  const calls = installFilesHarness(t, {
    read: async (_selector, request) => Object.freeze({
      value: request.kind === 'stats' ? stats : productView,
      baseWitness: BASE_WITNESS,
    }),
  });
  const { executeTool } = require('../tools');

  assert.strictEqual(await executeTool(PROJECT_NAME, 'get_stats', {}), stats);
  assert.deepEqual(await executeTool(PROJECT_NAME, 'get_project_meta', {}), {
    name: 'Files novel',
    genres: ['sci-fi', 'other'],
    genreLabels: ['科幻', '其他'],
    mode: 'medium-novel',
    language: 'zh',
    phase: 'writing',
    phaseLabel: '写作',
    wordCount: 321,
    authorName: 'Author',
    description: 'Description',
  });
  assert.deepEqual(calls.reads.map((entry) => entry.request), [
    { kind: 'stats' },
    { kind: 'product_view' },
  ]);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.getProjectDb, 0);
  assert.equal(calls.projectQuery, 0);
});

test('files chapter tools derive exact L2 commands from the same runtime witness', async (t) => {
  const chapter = Object.freeze({
    id: 11,
    chapter_uid: CHAPTER_UID,
    volume_id: 3,
    volume_uid: VOLUME_UID,
    num: 5,
    title: 'Before',
  });
  const calls = installFilesHarness(t, {
    read: async (_selector, request) => Object.freeze({
      value: request.kind === 'project' ? Object.freeze({ project_uid: PROJECT_UID }) : chapter,
      baseWitness: BASE_WITNESS,
    }),
    write: async (_selector, request) => {
      if (request.command.kind === 'chapter.create') {
        return Object.freeze({
          state: 'created',
          objectKind: 'chapter',
          uid: SECOND_CHAPTER_UID,
          id: 12,
          num: 6,
          targetGeneration: 3,
        });
      }
      return Object.freeze({ state: 'completed', targetGeneration: 3 });
    },
  });
  const { executeTool } = require('../tools');

  await executeTool(PROJECT_NAME, 'update_chapter', {
    chapter_uid: CHAPTER_UID,
    content: 'After body',
    title: 'After title',
    summary: 'After summary',
  });
  await executeTool(PROJECT_NAME, 'update_chapter', {
    chapter_uid: CHAPTER_UID,
    status: 'review',
  });
  await executeTool(PROJECT_NAME, 'delete_chapter', { chapter_uid: CHAPTER_UID });
  const created = await executeTool(PROJECT_NAME, 'create_chapter', {
    volume_uid: VOLUME_UID,
    chapter_num: 6,
    title: 'Created',
    outline: 'Outline',
    content: 'Created body',
    status: 'pending',
    summary: 'Created summary',
    cognitive_frame: 'Frame',
    emotional_anchor: 'Anchor',
    world_texture: 'Texture',
    concrete_mystery: 'Mystery',
    interpersonal_tension: 'Tension',
  });

  assert.equal(created.chapter_uid, SECOND_CHAPTER_UID);
  assert.equal(calls.getProjectDb, 0);
  assert.deepEqual(calls.reads.map((entry) => entry.request), [
    { kind: 'chapter', chapterUid: CHAPTER_UID },
    { kind: 'chapter', chapterUid: CHAPTER_UID },
    { kind: 'chapter', chapterUid: CHAPTER_UID },
    { kind: 'project' },
  ]);
  assert.deepEqual(calls.writes.map((entry) => entry.request.command), [
    {
      kind: 'chapter.replace_body_and_sidecar',
      chapterUid: CHAPTER_UID,
      content: 'After body',
      patch: { title: 'After title', summary: 'After summary' },
    },
    {
      kind: 'chapter.patch_sidecar',
      chapterUid: CHAPTER_UID,
      patch: { status: 'review' },
    },
    { kind: 'chapter.delete', chapterUid: CHAPTER_UID },
    {
      kind: 'chapter.create',
      containerVolumeUid: VOLUME_UID,
      requestedNum: 6,
      content: 'Created body',
      sidecar: {
        title: 'Created',
        outline: 'Outline',
        summary: 'Created summary',
        status: 'pending',
        cognitive_frame: 'Frame',
        emotional_anchor: 'Anchor',
        world_texture: 'Texture',
        concrete_mystery: 'Mystery',
        interpersonal_tension: 'Tension',
      },
    },
  ]);
  for (const entry of calls.writes) {
    assert.deepEqual(entry.selector, { projectUid: PROJECT_UID });
    assert.strictEqual(entry.request.baseWitness, BASE_WITNESS);
    assert.match(entry.request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  }
  assert.equal(new Set(calls.writes.map((entry) => entry.request.requestId)).size, 4);
});

test('files volume tools derive exact L2 commands from runtime witnesses', async (t) => {
  const volume = Object.freeze({ id: 3, volume_uid: VOLUME_UID, title: 'Before' });
  const calls = installFilesHarness(t, {
    read: async (_selector, request) => Object.freeze({
      value: request.kind === 'project' ? Object.freeze({ project_uid: PROJECT_UID }) : volume,
      baseWitness: BASE_WITNESS,
    }),
    write: async (_selector, request) => {
      if (request.command.kind === 'volume.create') {
        return Object.freeze({
          state: 'created',
          objectKind: 'volume',
          uid: SECOND_VOLUME_UID,
          id: 4,
          targetGeneration: 3,
        });
      }
      return Object.freeze({ state: 'completed', targetGeneration: 3 });
    },
  });
  const { executeTool } = require('../tools');

  const created = await executeTool(PROJECT_NAME, 'create_volume', {
    title: 'Created volume',
    summary: 'Created summary',
  });
  await executeTool(PROJECT_NAME, 'update_volume', {
    volume_uid: VOLUME_UID,
    title: 'Renamed',
    summary: 'Updated',
  });
  await executeTool(PROJECT_NAME, 'delete_volume', { volume_uid: VOLUME_UID });

  assert.equal(created.volume_uid, SECOND_VOLUME_UID);
  assert.equal(calls.getProjectDb, 0);
  assert.deepEqual(calls.reads.map((entry) => entry.request), [
    { kind: 'project' },
    { kind: 'volume', volumeUid: VOLUME_UID },
    { kind: 'volume', volumeUid: VOLUME_UID },
  ]);
  assert.deepEqual(calls.writes.map((entry) => entry.request.command), [
    { kind: 'volume.create', title: 'Created volume', summary: 'Created summary' },
    {
      kind: 'volume.patch_metadata',
      volumeUid: VOLUME_UID,
      patch: { title: 'Renamed', summary: 'Updated' },
    },
    { kind: 'volume.delete', volumeUid: VOLUME_UID },
  ]);
});

test('files tools reject accessors, inherited or extra fields, and numeric identities before authority I/O', async (t) => {
  const calls = installFilesHarness(t, {
    read: async () => {
      throw new Error('invalid files input must not reach runtime.read');
    },
  });
  const { executeTool } = require('../tools');
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'chapter_uid', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return CHAPTER_UID;
    },
  });
  const inherited = Object.create({ chapter_uid: CHAPTER_UID });

  const invalidCases = [
    ['get_chapter', accessor],
    ['get_chapter', inherited],
    ['get_chapter', { chapter_uid: CHAPTER_UID, extra: true }],
    ['get_chapter', { chapter_id: 11 }],
    ['get_chapter', { chapter_uid: 11 }],
    ['update_volume', { volume_id: 3, title: 'No' }],
    ['delete_volume', { volume_uid: VOLUME_UID, extra: true }],
  ];
  for (const [toolName, args] of invalidCases) {
    await assert.rejects(
      executeTool(PROJECT_NAME, toolName, args),
      (error) => error?.code === 'INVALID_FILES_TOOL_INPUT',
    );
  }

  assert.equal(getterCalls, 0);
  assert.equal(calls.reads.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.getProjectDb, 0);
  assert.equal(calls.projectQuery, 0);
});

test('files auxiliary writes without a domain authority fail closed before runtime or legacy DB I/O', async (t) => {
  const calls = installFilesHarness(t, {
    read: async () => {
      throw new Error('unsupported files tool must not reach manuscript runtime');
    },
  });
  const { executeTool } = require('../tools');

  for (const [toolName, args] of [
    ['create_character', {}],
    ['update_character', {}],
    ['delete_character', {}],
    ['create_world_entry', {}],
    ['update_world_entry', {}],
    ['delete_world_entry', {}],
    ['create_foreshadow', {}],
    ['update_foreshadow', {}],
    ['delete_foreshadow', {}],
    ['create_relation', {}],
    ['update_relation', {}],
    ['delete_relation', {}],
    ['create_memory', {}],
    ['update_memory', {}],
    ['delete_memory', {}],
    ['create_timeline_event', {}],
    ['update_timeline_event', {}],
    ['delete_timeline_event', {}],
    ['create_science_entry', {}],
    ['delete_science_entry', {}],
    ['set_chapter_character', { chapter_uid: CHAPTER_UID, character_name: '角色' }],
    ['remove_chapter_character', { chapter_uid: CHAPTER_UID, character_name: '角色' }],
    ['create_clue', {}],
    ['update_clue', {}],
    ['delete_clue', {}],
    ['update_project_phase', {}],
  ]) {
    await assert.rejects(
      executeTool(PROJECT_NAME, toolName, args),
      (error) => error?.code === 'FILES_TOOL_AUTHORITY_UNAVAILABLE'
        && error?.recoverable === true,
    );
  }

  assert.equal(calls.reads.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.getProjectDb, 0);
  assert.equal(calls.projectQuery, 0);
});

test('files auxiliary reads without an exact runtime view remain fail closed', async (t) => {
  const calls = installFilesHarness(t, {
    read: async () => {
      throw new Error('unsupported files read must not reach manuscript runtime');
    },
  });
  const { executeTool } = require('../tools');

  for (const [toolName, args] of [
    ['list_characters', {}],
    ['get_character', {}],
    ['list_world', {}],
    ['list_foreshadows', {}],
    ['list_relations', {}],
    ['list_memories', {}],
    ['list_timeline', {}],
    ['list_science', {}],
    ['list_chapter_characters', { chapter_uid: CHAPTER_UID }],
    ['list_clues', {}],
  ]) {
    await assert.rejects(
      executeTool(PROJECT_NAME, toolName, args),
      (error) => error?.code === 'FILES_TOOL_AUTHORITY_UNAVAILABLE'
        && error?.recoverable === true,
    );
  }

  assert.equal(calls.reads.length, 0);
  assert.equal(calls.writes.length, 0);
  assert.equal(calls.getProjectDb, 0);
  assert.equal(calls.projectQuery, 0);
});

test('tool routing isolates every legacy project database access in one exact SQLite owner family', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tools.js'), 'utf8');
  const routingOwnerStart = source.indexOf('function executeTool(');
  const legacyOwnerStart = source.indexOf('function executeLegacySqliteTool(');

  assert.ok(routingOwnerStart >= 0);
  assert.ok(legacyOwnerStart > routingOwnerStart);
  const nonLegacyOwners = source.slice(0, legacyOwnerStart);
  const routingOwner = source.slice(routingOwnerStart, legacyOwnerStart);
  const legacyOwner = source.slice(legacyOwnerStart);
  assert.doesNotMatch(nonLegacyOwners, /getProjectDb|\.prepare\(|projectQuery/u);
  assert.doesNotMatch(routingOwner, /getProjectDb|\.prepare\(|projectQuery/u);
  assert.match(legacyOwner, /db\.getProjectDb\(projectName\)/u);
  assert.match(legacyOwner, /function executeLegacySqliteResolveChapter\(/u);
  assert.match(legacyOwner, /function executeLegacySqliteUpdateById\(/u);
  assert.match(legacyOwner, /function executeLegacySqliteDeleteById\(/u);
  assert.doesNotMatch(legacyOwner, /function (?:resolveChapter|updateById|deleteById)\(/u);
});

test('published tool schemas expose files UIDs while retaining SQLite numeric alternatives', () => {
  const { TOOLS } = require('../tools');
  const schema = (name) => TOOLS.find((tool) => tool.function.name === name).function.parameters;

  assert.equal(schema('get_chapter').properties.chapter_uid.type, 'string');
  assert.equal(schema('create_chapter').properties.volume_uid.type, 'string');
  assert.equal(schema('update_chapter').properties.chapter_uid.type, 'string');
  assert.equal(schema('delete_chapter').properties.chapter_uid.type, 'string');
  assert.equal(schema('update_volume').properties.volume_uid.type, 'string');
  assert.equal(schema('delete_volume').properties.volume_uid.type, 'string');
  assert.ok(schema('get_chapter').anyOf.some((entry) => entry.required.includes('chapter_id')));
  assert.ok(schema('get_chapter').anyOf.some((entry) => entry.required.includes('chapter_uid')));
});
