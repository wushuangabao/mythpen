'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openControlStore } = require('../control-store');
const {
  createProductionDataRootPolicyAuthority,
} = require('../manuscript/production-data-root-policy');
const { fileManifest } = require('../storage-migration');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-data-root-policy-${name}-`));
}

function writeDatabase(SQL, filePath, statements) {
  const database = new SQL.Database();
  try {
    for (const [sql, params] of statements) database.run(sql, params);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(database.export()));
  } finally {
    database.close();
  }
}

function writeProject(SQL, filePath, { route = null, schema = 10 } = {}) {
  const statements = [
    ['CREATE TABLE project_meta (key TEXT, value TEXT NOT NULL)'],
    ['CREATE TABLE chapters (id TEXT PRIMARY KEY, content TEXT)'],
    ['INSERT INTO project_meta (key, value) VALUES (?, ?)', ['schema_version', String(schema)]],
  ];
  if (route !== null) {
    statements.push([
      'INSERT INTO project_meta (key, value) VALUES (?, ?)',
      ['manuscript_route', route],
    ]);
  }
  writeDatabase(SQL, filePath, statements);
}

function writeConfig(SQL, sourceRoot, projectPaths) {
  writeDatabase(SQL, path.join(sourceRoot, 'config.db'), [
    ['CREATE TABLE recent_projects (id TEXT, file_path TEXT)'],
    ...projectPaths.map((filePath, index) => [
      'INSERT INTO recent_projects (id, file_path) VALUES (?, ?)',
      [String(index), filePath],
    ]),
  ]);
}

test('production policy rejects a files route from project truth without changing either root', async (t) => {
  const SQL = await require('sql.js')();
  const sourceRoot = tempDir('files-source');
  const targetParent = tempDir('files-target-parent');
  const targetRoot = path.join(targetParent, 'target');
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }));
  t.after(() => fs.rmSync(targetParent, { force: true, recursive: true }));
  const projectPath = path.join(sourceRoot, 'projects', 'files.mythpen.db');
  writeProject(SQL, projectPath, { route: 'files', schema: 12 });
  writeConfig(SQL, sourceRoot, [projectPath]);
  const sourceBefore = fileManifest(sourceRoot);
  const targetBefore = fileManifest(targetParent);

  await assert.rejects(
    createProductionDataRootPolicyAuthority().assertChangeAllowed(Object.freeze({
      sourceRoot: path.resolve(sourceRoot),
      targetRoot: path.resolve(targetRoot),
      migrate: true,
    })),
    (error) => (
      error?.code === 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED'
      && error?.details?.reason === 'FILE_AUTHORITY_PROJECT_PRESENT'
      && error?.details?.route === 'files'
    ),
  );
  assert.deepEqual(fileManifest(sourceRoot), sourceBefore);
  assert.deepEqual(fileManifest(targetParent), targetBefore);
  assert.equal(fs.existsSync(targetRoot), false);
});

test('production policy allows a complete SQLite root and does not create control state', async (t) => {
  const SQL = await require('sql.js')();
  const sourceRoot = tempDir('sqlite-source');
  const targetParent = tempDir('sqlite-target-parent');
  const targetRoot = path.join(targetParent, 'target');
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }));
  t.after(() => fs.rmSync(targetParent, { force: true, recursive: true }));
  const projectPath = path.join(sourceRoot, 'projects', 'legacy.mythpen.db');
  writeProject(SQL, projectPath);
  writeConfig(SQL, sourceRoot, [projectPath]);

  const result = await createProductionDataRootPolicyAuthority().assertChangeAllowed(
    Object.freeze({
      sourceRoot: path.resolve(sourceRoot),
      targetRoot: path.resolve(targetRoot),
      migrate: true,
    }),
  );

  assert.deepEqual(result, Object.freeze({ allowed: true }));
  assert.equal(fs.existsSync(path.join(sourceRoot, 'control')), false);
  assert.equal(fs.existsSync(targetRoot), false);
});

test('production policy reads creation state through the journal and never backfills it', async (t) => {
  const sourceRoot = tempDir('creation-source');
  const targetParent = tempDir('creation-target-parent');
  const targetRoot = path.join(targetParent, 'target');
  t.after(() => fs.rmSync(sourceRoot, { force: true, recursive: true }));
  t.after(() => fs.rmSync(targetParent, { force: true, recursive: true }));
  const creationId = randomUUID();
  const creationDirectory = path.join(
    sourceRoot,
    'control',
    'project-creation',
    creationId,
  );
  openControlStore(creationDirectory);
  const before = fileManifest(sourceRoot);

  await assert.rejects(
    createProductionDataRootPolicyAuthority().assertChangeAllowed(Object.freeze({
      sourceRoot: path.resolve(sourceRoot),
      targetRoot: path.resolve(targetRoot),
      migrate: false,
    })),
    (error) => (
      error?.code === 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED'
      && error?.details?.reason === 'NONTERMINAL_PROJECT_CREATION_PRESENT'
      && error?.details?.state === 'none'
    ),
  );
  assert.deepEqual(fileManifest(sourceRoot), before);
  assert.equal(fs.existsSync(targetRoot), false);
});

test('target cloud policy rejects before a missing source or target is created', async () => {
  const parent = tempDir('cloud-first');
  const sourceRoot = path.join(parent, 'missing-source');
  const targetRoot = 'C:\\Users\\writer\\OneDrive\\Mythpen';

  await assert.rejects(
    createProductionDataRootPolicyAuthority().assertChangeAllowed(Object.freeze({
      sourceRoot: path.resolve(sourceRoot),
      targetRoot,
      migrate: true,
    })),
    (error) => (
      error?.code === 'ALTERNATIVE_LOCATION_REQUIRED'
      && error?.details?.reason === 'ONEDRIVE'
    ),
  );
  assert.equal(fs.existsSync(sourceRoot), false);
  assert.equal(fs.existsSync(targetRoot), false);
  fs.rmSync(parent, { force: true, recursive: true });
});
