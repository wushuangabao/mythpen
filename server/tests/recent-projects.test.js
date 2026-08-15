const test = require('node:test');
const assert = require('node:assert/strict');
const { readRecentProject } = require('../recent-projects');

test('isolated recent project returns its stable state without stat or database open', () => {
  const row = {
    id: '待恢复项目',
    name: '待恢复项目',
    file_path: 'D:\\projects\\待恢复项目.mythpen.db',
    word_count: 321,
    last_opened: '2026-08-10T00:00:00.000Z',
  };
  let statCalls = 0;
  let openCalls = 0;
  const project = readRecentProject(row, {
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

test('a missing startup state fails closed without stat or database open', () => {
  const row = {
    id: '未检查项目',
    name: '未检查项目',
    file_path: 'D:\\projects\\未检查项目.mythpen.db',
    word_count: 0,
    last_opened: '2026-08-10T00:00:00.000Z',
  };
  let touched = false;
  const project = readRecentProject(row, {
    fsApi: { statSync() { touched = true; } },
    getProjectOpenState: () => null,
    openProjectDb() { touched = true; },
  });
  assert.equal(touched, false);
  assert.equal(project.openState, 'isolated');
  assert.equal(project.reasonCode, 'RECOVERY_REQUIRED');
});

test('a ready project open failure is recorded and returned as isolated', () => {
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
  const project = readRecentProject(row, {
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

test('falls back without opening a missing stale recent-project database', () => {
  const row = {
    id: '暗影纪',
    name: '暗影纪',
    file_path: 'C:\\Old\\暗影纪.mythpen.db',
    word_count: 1200,
    last_opened: '2026-07-30T00:00:00.000Z',
  };
  let openCalls = 0;
  let createdFile = false;

  const project = readRecentProject(row, {
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

test('falls back without opening a stale recent-project path that is not a file', () => {
  const row = {
    id: '目录项目',
    name: '目录项目',
    file_path: 'C:\\Old\\目录项目.mythpen.db',
    word_count: 0,
    last_opened: '2026-07-30T00:00:00.000Z',
  };
  let openCalls = 0;

  const project = readRecentProject(row, {
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

test('opens an existing legacy database once and maps metadata, chapters, and genres', () => {
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

  const project = readRecentProject(row, {
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
