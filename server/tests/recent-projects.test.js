const test = require('node:test');
const assert = require('node:assert/strict');
const { readRecentProject } = require('../recent-projects');

test('isolated recent project returns its stable state without stat or database open', async () => {
  const row = {
    id: '待恢复项目',
    name: '待恢复项目',
    file_path: 'D:\\projects\\待恢复项目.mythpen.db',
    word_count: 321,
    last_opened: '2026-08-10T00:00:00.000Z',
  };
  let statCalls = 0;
  let openCalls = 0;
  const project = await readRecentProject(row, {
    fsApi: {
      statSync() {
        statCalls += 1;
        throw new Error('isolated rows must not stat');
      },
    },
    getProjectOpenState() {
      return {
        openState: 'isolated',
        reasonCode: 'RECOVERY_REQUIRED',
        recommendedAction: null,
      };
    },
    openProjectDb() {
      openCalls += 1;
      throw new Error('isolated rows must not open');
    },
  });

  assert.equal(statCalls, 0);
  assert.equal(openCalls, 0);
  assert.equal(project.openState, 'isolated');
  assert.equal(project.reasonCode, 'RECOVERY_REQUIRED');
  assert.equal(project.recommendedAction, null);
  assert.equal(project.status, '未知');
});

test('a missing startup state fails closed without stat or database open', async () => {
  const row = {
    id: '未检查项目',
    name: '未检查项目',
    file_path: 'D:\\projects\\未检查项目.mythpen.db',
    word_count: 0,
    last_opened: '2026-08-10T00:00:00.000Z',
  };
  let touched = false;
  const project = await readRecentProject(row, {
    fsApi: { statSync() { touched = true; } },
    getProjectOpenState: () => null,
    openProjectDb() { touched = true; },
  });
  assert.equal(touched, false);
  assert.equal(project.openState, 'isolated');
  assert.equal(project.reasonCode, 'RECOVERY_REQUIRED');
});

test('files recent summary comes only from the product authority without legacy path or database reads', async () => {
  const row = {
    id: 'files-cache-row',
    name: '文件权威项目',
    file_path: 'D:\\projects\\legacy-name-must-not-be-opened.mythpen.db',
    word_count: 1,
    last_opened: '2026-08-20T00:00:00.000Z',
  };
  const expected = Object.freeze({
    id: '2f1e0476-65d1-49d3-9b19-f962e1346833',
    name: '文件权威项目',
    iconName: 'Rocket',
    genres: Object.freeze(['科幻']),
    wordCount: 42000,
    chapterCount: 7,
    lastOpened: row.last_opened,
    mode: 'long-novel',
    instanceId: '5f6ad956-b66f-4193-b73d-748a702fc1ce',
    status: '写作中',
    openState: 'ready',
    reasonCode: null,
    recommendedAction: null,
  });
  const calls = [];

  const project = await readRecentProject(row, {
    async readFilesRecentSummary(receivedRow) {
      calls.push(['files-authority', receivedRow]);
      return expected;
    },
    getProjectOpenState() {
      calls.push(['legacy-open-state']);
      throw new Error('files recent summary must not use legacy startup state');
    },
    fsApi: {
      statSync() {
        calls.push(['legacy-stat']);
        throw new Error('files recent summary must not stat the legacy path');
      },
    },
    openProjectDb() {
      calls.push(['legacy-open']);
      throw new Error('files recent summary must not open the project database');
    },
  });

  assert.equal(project, expected);
  assert.deepEqual(calls, [['files-authority', row]]);
});

test('files recent authority failure is fail-closed and never falls back to the legacy database', async () => {
  const row = {
    id: 'files-stale-cache-row',
    name: '缓存需重建项目',
    file_path: 'D:\\projects\\must-not-open.mythpen.db',
    word_count: 0,
    last_opened: '2026-08-20T00:00:00.000Z',
  };
  const recovery = Object.assign(new Error('route cache rebuild required'), {
    code: 'RECOVERY_REQUIRED',
  });
  let legacyTouches = 0;

  await assert.rejects(
    readRecentProject(row, {
      async readFilesRecentSummary() { throw recovery; },
      getProjectOpenState() { legacyTouches += 1; },
      fsApi: { statSync() { legacyTouches += 1; } },
      openProjectDb() { legacyTouches += 1; },
      recordProjectOpenFailure() { legacyTouches += 1; },
    }),
    (error) => error === recovery,
  );
  assert.equal(legacyTouches, 0);
});

test('only an explicit null files-authority result selects the legacy SQLite reader', async () => {
  const row = {
    id: '旧项目',
    name: '旧项目',
    file_path: 'D:\\projects\\legacy.mythpen.db',
    word_count: 0,
    last_opened: '2026-08-20T00:00:00.000Z',
  };
  const calls = [];
  const queries = {
    'SELECT key, value FROM project_meta': { all: () => [] },
    'SELECT COUNT(*) as c FROM chapters': { get: () => ({ c: 0 }) },
    'SELECT genre FROM project_genres': { all: () => [] },
  };

  const project = await readRecentProject(row, {
    async readFilesRecentSummary() {
      calls.push('files-authority');
      return null;
    },
    getProjectOpenState() {
      calls.push('legacy-open-state');
      return { openState: 'ready' };
    },
    fsApi: { statSync: () => ({ isFile: () => true }) },
    openProjectDb() {
      calls.push('legacy-open');
      return { prepare: (sql) => queries[sql] };
    },
  });

  assert.deepEqual(calls, ['files-authority', 'legacy-open-state', 'legacy-open']);
  assert.equal(project.openState, 'ready');
});

test('an invalid files-authority result fails closed instead of selecting legacy SQLite', async () => {
  let legacyTouches = 0;
  await assert.rejects(
    readRecentProject({ file_path: 'D:\\projects\\must-not-open.mythpen.db' }, {
      async readFilesRecentSummary() { return undefined; },
      getProjectOpenState() { legacyTouches += 1; },
      fsApi: { statSync() { legacyTouches += 1; } },
      openProjectDb() { legacyTouches += 1; },
    }),
    TypeError,
  );
  assert.equal(legacyTouches, 0);
});

test('a ready project open failure is recorded and returned as isolated', async () => {
  const row = {
    id: '现场变化',
    name: '现场变化',
    file_path: 'D:\\projects\\现场变化.mythpen.db',
    word_count: 0,
    last_opened: '2026-08-10T00:00:00.000Z',
  };
  const openError = Object.assign(new Error('changed after startup'), {
    code: 'RECOVERY_REQUIRED',
  });
  let recorded;
  const project = await readRecentProject(row, {
    fsApi: { statSync: () => ({ isFile: () => true }) },
    getProjectOpenState: () => ({ openState: 'ready', reasonCode: null, recommendedAction: null }),
    openProjectDb() { throw openError; },
    recordProjectOpenFailure(filePath, error) {
      recorded = { error, filePath };
      return {
        openState: 'isolated',
        reasonCode: 'RECOVERY_REQUIRED',
        recommendedAction: null,
      };
    },
  });
  assert.deepEqual(recorded, { error: openError, filePath: row.file_path });
  assert.equal(project.openState, 'isolated');
  assert.equal(project.reasonCode, 'RECOVERY_REQUIRED');
});

test('falls back without opening a missing stale recent-project database', async () => {
  const row = {
    id: '暗影纪',
    name: '暗影纪',
    file_path: 'C:\\Old\\暗影纪.mythpen.db',
    word_count: 1200,
    last_opened: '2026-07-30T00:00:00.000Z',
  };
  let openCalls = 0;
  let createdFile = false;

  const project = await readRecentProject(row, {
    fsApi: {
      statSync() {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
    },
    openProjectDb() {
      openCalls += 1;
      createdFile = true;
    },
  });

  assert.equal(openCalls, 0);
  assert.equal(createdFile, false);
  assert.deepEqual(project, {
    id: row.id,
    name: row.name,
    iconName: 'BookOpen',
    genres: [],
    wordCount: row.word_count,
    chapterCount: 0,
    lastOpened: row.last_opened,
    mode: 'medium-novel',
    instanceId: '',
    status: '未知',
    openState: 'isolated',
    reasonCode: 'RECOVERY_REQUIRED',
    recommendedAction: null,
  });
});

test('falls back without opening a stale recent-project path that is not a file', async () => {
  const row = {
    id: '目录项目',
    name: '目录项目',
    file_path: 'C:\\Old\\目录项目.mythpen.db',
    word_count: 0,
    last_opened: '2026-07-30T00:00:00.000Z',
  };
  let openCalls = 0;

  const project = await readRecentProject(row, {
    getProjectOpenState: () => ({ openState: 'ready' }),
    fsApi: { statSync: () => ({ isFile: () => false }) },
    openProjectDb() {
      openCalls += 1;
      throw new Error('opening a directory would create a database');
    },
  });

  assert.equal(openCalls, 0);
  assert.equal(project.status, '未知');
});

test('opens an existing legacy database once and maps metadata, chapters, and genres', async () => {
  const row = {
    id: '星海纪元',
    name: '星海纪元',
    file_path: 'D:\\小说 资料\\星海纪元.mythpen.db',
    word_count: 1,
    last_opened: '2026-07-30T08:00:00.000Z',
  };
  let openCalls = 0;
  const queries = {
    'SELECT key, value FROM project_meta': {
      all: () => [
        { key: 'word_count', value: '42000' },
        { key: 'mode', value: 'long-novel' },
        { key: 'project_instance_id', value: 'instance-123' },
      ],
    },
    'SELECT COUNT(*) as c FROM chapters': { get: () => ({ c: 18 }) },
    'SELECT genre FROM project_genres': {
      all: () => [{ genre: 'sci-fi' }, { genre: 'other' }],
    },
  };

  const project = await readRecentProject(row, {
    getProjectOpenState: () => ({ openState: 'ready' }),
    fsApi: { statSync: () => ({ isFile: () => true }) },
    openProjectDb(filePath) {
      openCalls += 1;
      assert.equal(filePath, row.file_path);
      return { prepare: (sql) => queries[sql] };
    },
  });

  assert.equal(openCalls, 1);
  assert.deepEqual(project, {
    id: row.id,
    name: row.name,
    iconName: 'Rocket Scroll',
    genres: ['科幻', '其他'],
    wordCount: 42000,
    chapterCount: 18,
    lastOpened: row.last_opened,
    mode: 'long-novel',
    instanceId: 'instance-123',
    status: '写作中',
    openState: 'ready',
    reasonCode: null,
    recommendedAction: null,
  });
});
