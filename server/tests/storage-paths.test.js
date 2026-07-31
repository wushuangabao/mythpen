const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveStoragePaths } = require('../storage-paths');

function fakeStore(values = {}) {
  return { get: (name) => values[name] || null };
}

test('defaults writing data to <home>/.mythpen', () => {
  const paths = resolveStoragePaths({
    homeDir: 'C:\\Users\\author',
    env: {},
    store: fakeStore(),
  });
  assert.equal(paths.dataDir, path.resolve('C:\\Users\\author', '.mythpen'));
  assert.equal(paths.projectsDir, path.join(paths.dataDir, 'projects'));
  assert.equal(paths.configDbPath, path.join(paths.dataDir, 'config.db'));
  assert.equal(
    paths.aiRequestParametersPath,
    path.join(paths.dataDir, 'ai-request-parameters.json'),
  );
  assert.equal(paths.exportDir, path.join(paths.dataDir, 'exports'));
});

test('registry overrides defaults and export defaults under configured data dir', () => {
  const paths = resolveStoragePaths({
    homeDir: 'C:\\Users\\author',
    env: {},
    store: fakeStore({ DataDir: 'D:\\MythpenData' }),
  });
  assert.equal(paths.dataDir, path.resolve('D:\\MythpenData'));
  assert.equal(
    paths.aiRequestParametersPath,
    path.join(paths.dataDir, 'ai-request-parameters.json'),
  );
  assert.equal(paths.exportDir, path.join(paths.dataDir, 'exports'));
});

test('explicit export directory and process environment take precedence', () => {
  const paths = resolveStoragePaths({
    homeDir: 'C:\\Users\\author',
    env: {
      MYTHPEN_DATA_DIR: 'E:\\SessionData',
      MYTHPEN_EXPORT_DIR: 'F:\\SessionExports',
    },
    store: fakeStore({
      DataDir: 'D:\\PersistentData',
      ExportDir: 'D:\\PersistentExports',
    }),
  });
  assert.equal(paths.dataDir, path.resolve('E:\\SessionData'));
  assert.equal(
    paths.aiRequestParametersPath,
    path.join(paths.dataDir, 'ai-request-parameters.json'),
  );
  assert.equal(paths.exportDir, path.resolve('F:\\SessionExports'));
});
