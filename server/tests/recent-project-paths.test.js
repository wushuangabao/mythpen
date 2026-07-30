const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { repairRecentProjectPaths } = require('../recent-project-paths');

test('rewrites stale recent project paths when the database exists under the new root', () => {
  const updates = [];
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        return { all: () => [{ name: '暗影纪', file_path: 'C:\\Old\\暗影纪.mythpen.db' }] };
      }
      return { run: (...args) => updates.push(args) };
    },
  };
  const projectsDir = path.resolve('D:\\MythpenData', 'projects');
  const expected = path.join(projectsDir, '暗影纪.mythpen.db');
  const changed = repairRecentProjectPaths(db, projectsDir, {
    existsSync: (candidate) => candidate === expected,
  });
  assert.equal(changed, 1);
  assert.deepEqual(updates, [[expected, '暗影纪']]);
});

test('leaves a stale recent project path untouched when its new-root database is absent', () => {
  const updates = [];
  const stalePath = 'C:\\Old\\暗影纪.mythpen.db';
  const row = { name: '暗影纪', file_path: stalePath };
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        return { all: () => [row] };
      }
      return { run: (...args) => updates.push(args) };
    },
  };

  const changed = repairRecentProjectPaths(db, path.resolve('D:\\MythpenData', 'projects'), {
    existsSync: () => false,
  });

  assert.equal(changed, 0);
  assert.deepEqual(updates, []);
  assert.equal(row.file_path, stalePath);
});
