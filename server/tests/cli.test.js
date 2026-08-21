const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile: realExecFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli');
const { createJsonStore } = require('../path-store');
const {
  assertDataRootMigrationSupported,
  copyAndVerifyDirectory,
  fileManifest,
} = require('../storage-migration');
const { acquireConfigLifecycleLease } = require('../config-lifecycle-lease');

function memoryStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get: (name) => values[name] || null,
    set: (name, value) => { values[name] = value; },
    delete: (name) => { delete values[name]; },
  };
}

function output() {
  const lines = [];
  return { lines, write: (line) => lines.push(String(line)) };
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-cli-${name}-`));
}

function writeDatabase(SQL, filePath, statements) {
  const database = new SQL.Database();
  for (const [sql, params] of statements) database.run(sql, params);
  fs.writeFileSync(filePath, Buffer.from(database.export()));
  database.close();
}

function writeProjectFixture(SQL, filePath, markerRows = [['schema_version', '10']]) {
  writeDatabase(SQL, filePath, [
    ['CREATE TABLE project_meta (key TEXT, value TEXT NOT NULL)'],
    ['CREATE TABLE chapters (id TEXT PRIMARY KEY, content TEXT)'],
    ...markerRows.map(([key, value]) => [
      'INSERT INTO project_meta (key, value) VALUES (?, ?)',
      [key, value],
    ]),
  ]);
}

function writeConfigFixture(SQL, source, registeredPaths, { includeRegistry = true } = {}) {
  const statements = [['CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)']];
  if (includeRegistry) {
    statements.push(['CREATE TABLE recent_projects (id TEXT, file_path TEXT)']);
    registeredPaths.forEach((filePath, index) => statements.push([
      'INSERT INTO recent_projects (id, file_path) VALUES (?, ?)',
      [String(index), filePath],
    ]));
  }
  writeDatabase(SQL, path.join(source, 'config.db'), statements);
}

function runStorageCli(argv, dependencies = {}) {
  return runCli(argv, {
    assertDataRootMigrationSupported: async () => {},
    acquireConfigLifecycleLeaseSet: () => ({ release() {} }),
    ...dependencies,
  });
}

async function inTemporaryWorkingDirectory(callback) {
  const previous = process.cwd();
  const directory = tempDir('cwd');
  process.chdir(directory);
  try {
    return await callback(directory);
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('data-dir get prints the effective data directory', async () => {
  const stdout = output();
  const code = await runStorageCli(['data-dir', 'get'], {
    store: memoryStore({ DataDir: 'D:\\MythpenData' }),
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout,
    stderr: output(),
  });

  assert.equal(code, 0);
  assert.deepEqual(stdout.lines, [path.resolve('D:\\MythpenData')]);
});

test('get rejects every extra argument without output or configuration changes', async () => {
  for (const argv of [
    ['data-dir', 'get', 'unexpected'],
    ['export-dir', 'get', '--migrate'],
  ]) {
    const store = memoryStore({ DataDir: 'C:\\OldData', ExportDir: 'C:\\OldExports' });
    const stdout = output();
    const stderr = output();

    const code = await runStorageCli(argv, {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      stdout,
      stderr,
    });

    assert.equal(code, 2, argv.join(' '));
    assert.deepEqual(stdout.lines, [], argv.join(' '));
    assert.deepEqual(store.values, { DataDir: 'C:\\OldData', ExportDir: 'C:\\OldExports' });
    assert.match(stderr.lines.join('\n'), /mythpen-cli data-dir get/);
  }
});

test('set rejects malformed argument shapes without creating directories or changing configuration', async () => {
  await inTemporaryWorkingDirectory(async (workingDirectory) => {
    const target = path.join(workingDirectory, 'target');
    const malformedArgv = [
      ['data-dir', 'set', '--migrate'],
      ['data-dir', 'set', target, '--migrate', '--migrate'],
      ['data-dir', 'set', target, '--force'],
      ['data-dir', 'set', '--migrate', target],
      ['data-dir', 'set', target, 'extra'],
    ];

    for (const argv of malformedArgv) {
      const store = memoryStore({ DataDir: 'C:\\OldData' });
      const stderr = output();
      const code = await runStorageCli(argv, {
        store,
        env: {},
        homeDir: 'C:\\Users\\author',
        stdout: output(),
        stderr,
      });

      assert.equal(code, 2, argv.join(' '));
      assert.deepEqual(store.values, { DataDir: 'C:\\OldData' }, argv.join(' '));
      assert.match(stderr.lines.join('\n'), /mythpen-cli data-dir get/);
    }

    assert.equal(fs.existsSync(path.join(workingDirectory, '--migrate')), false);
    assert.equal(fs.existsSync(target), false);
  });
});

test('data-dir set --migrate switches only after a successful verified copy', async () => {
  const source = tempDir('data-source');
  const target = path.join(tempDir('data-target'), 'data');
  fs.writeFileSync(path.join(source, 'config.db'), 'database');
  const store = memoryStore({ DataDir: source });

  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    stdout: output(),
    stderr: output(),
  });

  assert.equal(code, 0);
  assert.equal(store.values.DataDir, path.resolve(target));
  assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'database');
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'database');
});

test('data-dir busy rejection happens before target, migration, and path-store side effects', async () => {
  const source = tempDir('busy-source');
  const targetParent = tempDir('busy-target-parent');
  const target = path.join(targetParent, 'target');
  const controlRoot = tempDir('busy-control');
  fs.writeFileSync(path.join(source, 'config.db'), 'unchanged source');
  const store = memoryStore({ DataDir: source });
  const stderr = output();
  let migrationCalls = 0;
  let storeSetCalls = 0;
  store.set = () => { storeSetCalls += 1; };
  const sourceBefore = fileManifest(source);
  const targetParentBefore = fileManifest(targetParent);
  const storeBefore = JSON.stringify(store.values);
  const held = acquireConfigLifecycleLease(path.join(source, 'config.db'), { controlRoot });

  let code;
  try {
    code = await runCli(['data-dir', 'set', target, '--migrate'], {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      applicationControlRoot: controlRoot,
      assertDataRootMigrationSupported: async () => {},
      copyAndVerifyDirectory: async () => { migrationCalls += 1; },
      stdout: output(),
      stderr,
    });
  } finally {
    held.release();
  }

  assert.equal(code, 1);
  assert.equal(storeSetCalls, 0);
  assert.equal(migrationCalls, 0);
  assert.deepEqual(fileManifest(source), sourceBefore);
  assert.deepEqual(fileManifest(targetParent), targetParentBefore);
  assert.equal(JSON.stringify(store.values), storeBefore);
  assert.equal(fs.existsSync(target), false);
  assert.match(stderr.lines.join('\n'), /already in use/);
});

test('native data-root rejection happens before target, migration, and path-store side effects', async () => {
  const source = tempDir('native-source');
  const target = path.join(tempDir('native-target-parent'), 'target');
  fs.writeFileSync(path.join(source, 'config.db'), 'unchanged source');
  const store = memoryStore({ DataDir: source });
  let leaseCalls = 0;
  let migrationCalls = 0;
  let storeSetCalls = 0;
  store.set = () => { storeSetCalls += 1; };
  const unsupported = new Error('native projects cannot move data roots');
  unsupported.code = 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED';

  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    assertDataRootMigrationSupported: async () => { throw unsupported; },
    acquireConfigLifecycleLeaseSet: () => { leaseCalls += 1; },
    copyAndVerifyDirectory: async () => { migrationCalls += 1; },
    stdout: output(),
    stderr: output(),
  });

  assert.equal(code, 1);
  assert.equal(store.values.DataDir, source);
  assert.equal(leaseCalls, 0);
  assert.equal(migrationCalls, 0);
  assert.equal(storeSetCalls, 0);
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'unchanged source');
  assert.equal(fs.existsSync(target), false);
});

test('default Task14 authority rejects a schema12 files root before leases or copy', async () => {
  const SQL = await require('sql.js')();
  const source = tempDir('files-policy-source');
  const projects = path.join(source, 'projects');
  const targetParent = tempDir('files-policy-target-parent');
  const target = path.join(targetParent, 'target');
  fs.mkdirSync(projects);
  const projectPath = path.join(projects, 'files.mythpen.db');
  writeProjectFixture(SQL, projectPath, [
    ['schema_version', '12'],
    ['manuscript_route', 'files'],
  ]);
  writeConfigFixture(SQL, source, [projectPath]);
  const store = memoryStore({ DataDir: source });
  const sourceBefore = fileManifest(source);
  const targetBefore = fileManifest(targetParent);
  let leaseCalls = 0;
  let migrationCalls = 0;
  let storeSetCalls = 0;
  store.set = () => { storeSetCalls += 1; };
  const stderr = output();

  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    acquireConfigLifecycleLeaseSet: () => {
      leaseCalls += 1;
      return { release() {} };
    },
    copyAndVerifyDirectory: async () => { migrationCalls += 1; },
    stdout: output(),
    stderr,
  });

  assert.equal(code, 1);
  assert.equal(leaseCalls, 0);
  assert.equal(migrationCalls, 0);
  assert.equal(storeSetCalls, 0);
  assert.deepEqual(fileManifest(source), sourceBefore);
  assert.deepEqual(fileManifest(targetParent), targetBefore);
  assert.equal(fs.existsSync(target), false);
  assert.match(stderr.lines.join('\n'), /NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED/);
});

test('data-dir migration forwards one frozen intent to the Task14 policy on every guard pass', async () => {
  const source = tempDir('policy-intent-source');
  const target = path.resolve(tempDir('policy-intent-target-parent'), 'target');
  const store = memoryStore({ DataDir: source });
  const policyAuthority = Object.freeze({
    assertChangeAllowed() {
      throw new Error('the storage guard, not CLI, owns policy invocation');
    },
  });
  const observed = [];

  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    dataRootPolicyAuthority: policyAuthority,
    assertDataRootMigrationSupported: async (sourceRoot, options) => {
      observed.push({ sourceRoot, options });
    },
    acquireConfigLifecycleLeaseSet: () => ({ release() {} }),
    copyAndVerifyDirectory: async () => ({
      source,
      target,
      fileCount: 0,
      totalBytes: 0,
      cleanupWarnings: [],
    }),
    stdout: output(),
    stderr: output(),
  });

  assert.equal(code, 0);
  assert.equal(observed.length, 2);
  for (const call of observed) {
    assert.equal(call.sourceRoot, path.resolve(source));
    assert.equal(Object.isFrozen(call.options), true);
    assert.deepEqual(call.options, {
      migrate: true,
      policyAuthority,
      requirePolicyAuthority: true,
      targetRoot: target,
    });
  }
});

test('an explicitly missing production data-root policy fails closed before leases or target effects', async () => {
  const source = tempDir('missing-policy-source');
  const target = path.resolve(tempDir('missing-policy-target-parent'), 'target');
  const store = memoryStore({ DataDir: source });
  let leaseCalls = 0;
  let migrationCalls = 0;
  let storeSetCalls = 0;
  store.set = () => { storeSetCalls += 1; };
  const stderr = output();

  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    dataRootPolicyAuthority: null,
    acquireConfigLifecycleLeaseSet: () => {
      leaseCalls += 1;
      return { release() {} };
    },
    copyAndVerifyDirectory: async () => { migrationCalls += 1; },
    stdout: output(),
    stderr,
  });

  assert.equal(code, 1);
  assert.equal(leaseCalls, 0);
  assert.equal(migrationCalls, 0);
  assert.equal(storeSetCalls, 0);
  assert.equal(fs.existsSync(target), false);
  assert.match(stderr.lines.join('\n'), /policy authority is unavailable/);
});

test('data-dir set uses the production policy authority when no test authority is injected', async () => {
  const source = tempDir('default-policy-source');
  const target = path.resolve(tempDir('default-policy-target-parent'), 'target');
  const store = memoryStore({ DataDir: source });

  const code = await runCli(['data-dir', 'set', target], {
    store,
    env: {},
    acquireConfigLifecycleLeaseSet: () => ({ release() {} }),
    stdout: output(),
    stderr: output(),
  });

  assert.equal(code, 0);
  assert.equal(store.values.DataDir, target);
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test('a fixed port-3001 probe is not used as migration correctness mutex', async () => {
  const source = tempDir('port-source');
  const target = path.join(tempDir('port-target-parent'), 'target');
  const store = memoryStore({ DataDir: source });
  let released = false;
  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => { throw new Error('fixed port probe must not run'); },
    assertDataRootMigrationSupported: async () => {},
    acquireConfigLifecycleLeaseSet: () => ({
      release() { released = true; },
    }),
    copyAndVerifyDirectory: async () => ({
      source,
      target,
      fileCount: 0,
      totalBytes: 0,
      cleanupWarnings: [],
    }),
    stdout: output(),
    stderr: output(),
  });

  assert.equal(code, 0);
  assert.equal(released, true);
  assert.equal(store.values.DataDir, path.resolve(target));
});

test('read-only native root preflight detects schema 11 and native backend markers', async () => {
  const SQL = await require('sql.js')();
  for (const marker of ['schema', 'backend']) {
    const source = tempDir(`native-preflight-${marker}`);
    const projectsDir = path.join(source, 'projects');
    fs.mkdirSync(projectsDir);
    const projectPath = path.join(projectsDir, `${marker}.mythpen.db`);
    const config = new SQL.Database();
    config.run('CREATE TABLE recent_projects (id TEXT, file_path TEXT)');
    config.run('INSERT INTO recent_projects (id, file_path) VALUES (?, ?)', [marker, projectPath]);
    fs.writeFileSync(path.join(source, 'config.db'), Buffer.from(config.export()));
    config.close();
    writeProjectFixture(SQL, projectPath, [
      ['schema_version', marker === 'schema' ? '11' : '10'],
      ['durability_backend', marker === 'backend' ? 'native-sqlite-v2' : 'sqljs-v1'],
    ]);

    await assert.rejects(
      assertDataRootMigrationSupported(source, { sqlModule: SQL }),
      (error) => error.code === 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED' && error.status === 409,
      marker,
    );
  }
});

test('real scanner fails closed for unregistered, malformed, escaped, and unsafe project state', async () => {
  const SQL = await require('sql.js')();
  const scenarios = [
    {
      name: 'native-without-config',
      setup(source, projects) {
        writeProjectFixture(SQL, path.join(projects, 'native.mythpen.db'), [
          ['schema_version', '11'],
          ['durability_backend', 'native-sqlite-v2'],
        ]);
      },
      code: 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED',
    },
    {
      name: 'unregistered-native',
      setup(source, projects) {
        writeConfigFixture(SQL, source, []);
        writeProjectFixture(SQL, path.join(projects, 'native.mythpen.db'), [['schema_version', '11']]);
      },
      code: 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED',
    },
    {
      name: 'relative-registration',
      setup(source, projects) {
        const projectPath = path.join(projects, 'relative.mythpen.db');
        writeProjectFixture(SQL, projectPath);
        writeConfigFixture(SQL, source, [path.join('projects', path.basename(projectPath))]);
      },
    },
    {
      name: 'escaped-registration',
      setup(source) {
        const external = path.join(tempDir('external-project'), 'escaped.mythpen.db');
        writeProjectFixture(SQL, external);
        writeConfigFixture(SQL, source, [external]);
      },
    },
    {
      name: 'missing-registration',
      setup(source, projects) {
        writeConfigFixture(SQL, source, [path.join(projects, 'missing.mythpen.db')]);
      },
    },
    {
      name: 'duplicate-marker',
      setup(source, projects) {
        const projectPath = path.join(projects, 'duplicate.mythpen.db');
        writeProjectFixture(SQL, projectPath, [['schema_version', '10'], ['schema_version', '10']]);
        writeConfigFixture(SQL, source, [projectPath]);
      },
    },
    {
      name: 'malformed-marker',
      setup(source, projects) {
        const projectPath = path.join(projects, 'malformed.mythpen.db');
        writeProjectFixture(SQL, projectPath, [['schema_version', '11junk']]);
        writeConfigFixture(SQL, source, [projectPath]);
      },
    },
    {
      name: 'unknown-backend',
      setup(source, projects) {
        const projectPath = path.join(projects, 'backend.mythpen.db');
        writeProjectFixture(SQL, projectPath, [
          ['schema_version', '10'],
          ['durability_backend', 'mystery-store'],
        ]);
        writeConfigFixture(SQL, source, [projectPath]);
      },
    },
    {
      name: 'unreadable-database',
      setup(source, projects) {
        const projectPath = path.join(projects, 'broken.mythpen.db');
        fs.writeFileSync(projectPath, 'not sqlite');
        writeConfigFixture(SQL, source, [projectPath]);
      },
    },
    {
      name: 'extra-hardlink',
      setup(source, projects) {
        const projectPath = path.join(projects, 'linked.mythpen.db');
        writeProjectFixture(SQL, projectPath);
        fs.linkSync(projectPath, path.join(source, 'linked-copy.db'));
        writeConfigFixture(SQL, source, [projectPath]);
      },
    },
    {
      name: 'missing-registry-table',
      setup(source, projects) {
        writeProjectFixture(SQL, path.join(projects, 'v1.mythpen.db'));
        writeConfigFixture(SQL, source, [], { includeRegistry: false });
      },
    },
  ];

  for (const scenario of scenarios) {
    const source = tempDir(`preflight-${scenario.name}`);
    const projects = path.join(source, 'projects');
    fs.mkdirSync(projects);
    scenario.setup(source, projects);
    await assert.rejects(
      assertDataRootMigrationSupported(source, { sqlModule: SQL }),
      (error) => scenario.code ? error.code === scenario.code : Boolean(error),
      scenario.name,
    );
  }
});

test('real scanner and CLI allow a truly empty root and a complete ordinary v1 root', async () => {
  const SQL = await require('sql.js')();
  const missing = path.join(tempDir('preflight-missing-parent'), 'new-data-root');
  await assert.doesNotReject(assertDataRootMigrationSupported(missing, { sqlModule: SQL }));

  const empty = tempDir('preflight-empty');
  await assert.doesNotReject(assertDataRootMigrationSupported(empty, { sqlModule: SQL }));

  const source = tempDir('preflight-v1');
  const projects = path.join(source, 'projects');
  fs.mkdirSync(projects);
  const projectPath = path.join(projects, 'v1.mythpen.db');
  writeProjectFixture(SQL, projectPath, [['schema_version', '10']]);
  writeConfigFixture(SQL, source, [projectPath]);
  await assert.doesNotReject(assertDataRootMigrationSupported(source, { sqlModule: SQL }));

  const target = path.join(tempDir('preflight-v1-target'), 'data');
  const store = memoryStore({ DataDir: source });
  const code = await runCli(['data-dir', 'set', target], {
    store,
    env: {},
    applicationControlRoot: tempDir('preflight-v1-control'),
    stdout: output(),
    stderr: output(),
  });
  assert.equal(code, 0);
  assert.equal(store.values.DataDir, path.resolve(target));
});

test('unmocked CLI rejects native-without-config before target or path-store changes', async () => {
  const SQL = await require('sql.js')();
  const source = tempDir('cli-native-without-config');
  const projects = path.join(source, 'projects');
  fs.mkdirSync(projects);
  writeProjectFixture(SQL, path.join(projects, 'native.mythpen.db'), [['schema_version', '11']]);
  const targetParent = tempDir('cli-native-without-config-target');
  const target = path.join(targetParent, 'data');
  const store = memoryStore({ DataDir: source });
  const sourceBefore = fileManifest(source);
  const targetBefore = fileManifest(targetParent);
  const storeBefore = JSON.stringify(store.values);

  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    applicationControlRoot: tempDir('cli-native-without-config-control'),
    stdout: output(),
    stderr: output(),
  });
  assert.equal(code, 1);
  assert.deepEqual(fileManifest(source), sourceBefore);
  assert.deepEqual(fileManifest(targetParent), targetBefore);
  assert.equal(JSON.stringify(store.values), storeBefore);
});

function createWindowsJunctionPreflightScenario(SQL, name) {
  if (name.endsWith('registered-parent-alias')) {
    const source = tempDir('junction-registered-source');
    const projects = path.join(source, 'projects');
    fs.mkdirSync(projects);
    const projectPath = path.join(projects, 'v1.mythpen.db');
    writeProjectFixture(SQL, projectPath);
    const alias = path.join(tempDir('junction-registered-alias-parent'), 'projects-alias');
    fs.symlinkSync(projects, alias, 'junction');
    writeConfigFixture(SQL, source, [path.join(alias, path.basename(projectPath))]);
    return { source };
  }

  const physicalParent = tempDir('junction-source-physical-parent');
  const physicalSource = path.join(physicalParent, 'source');
  const projects = path.join(physicalSource, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  writeProjectFixture(SQL, path.join(projects, 'v1.mythpen.db'));
  const aliasParent = path.join(tempDir('junction-source-alias-parent'), 'data-parent-alias');
  fs.symlinkSync(physicalParent, aliasParent, 'junction');
  const source = path.join(aliasParent, 'source');
  writeConfigFixture(SQL, physicalSource, [path.join(source, 'projects', 'v1.mythpen.db')]);
  return { source };
}

test('Windows real scanner rejects junction aliases in registered and source path chains', {
  skip: process.platform !== 'win32',
}, async () => {
  const SQL = await require('sql.js')();
  for (const name of ['registered-parent-alias', 'source-ancestor-alias']) {
    const { source } = createWindowsJunctionPreflightScenario(SQL, name);
    await assert.rejects(
      assertDataRootMigrationSupported(source, { sqlModule: SQL }),
      (error) => error.code === 'STORAGE_UNAVAILABLE',
      name,
    );
  }
});

test('Windows unmocked CLI rejects junction aliases without source, target, or path-store changes', {
  skip: process.platform !== 'win32',
}, async () => {
  const SQL = await require('sql.js')();
  for (const name of ['registered-parent-alias', 'source-ancestor-alias']) {
    const { source } = createWindowsJunctionPreflightScenario(SQL, `cli-${name}`);
    const targetParent = tempDir(`cli-${name}-target-parent`);
    const target = path.join(targetParent, 'data');
    const pathStoreRoot = tempDir(`cli-${name}-path-store`);
    const pathStoreFile = path.join(pathStoreRoot, 'paths.json');
    fs.writeFileSync(pathStoreFile, JSON.stringify({ DataDir: source }, null, 2));
    const store = createJsonStore(pathStoreFile);
    const sourceBefore = fileManifest(source);
    const targetBefore = fileManifest(targetParent);
    const pathStoreBefore = fileManifest(pathStoreRoot);

    const code = await runCli(['data-dir', 'set', target], {
      store,
      env: {},
      applicationControlRoot: tempDir(`cli-${name}-control`),
      stdout: output(),
      stderr: output(),
    });

    assert.equal(code, 1, name);
    assert.deepEqual(fileManifest(source), sourceBefore, name);
    assert.deepEqual(fileManifest(targetParent), targetBefore, name);
    assert.deepEqual(fileManifest(pathStoreRoot), pathStoreBefore, name);
    assert.equal(fs.existsSync(target), false, name);
  }
});

function fsApiWithDeniedDataRootChildren(source) {
  const denied = new Set([
    path.resolve(source, 'config.db').toLowerCase(),
    path.resolve(source, 'projects').toLowerCase(),
  ]);
  return new Proxy(fs, {
    get(realFs, property) {
      if (property !== 'lstatSync') return Reflect.get(realFs, property);
      return (filePath, ...arguments_) => {
        if (denied.has(path.resolve(filePath).toLowerCase())) {
          const error = new Error(`access denied: ${filePath}`);
          error.code = 'EACCES';
          throw error;
        }
        return realFs.lstatSync(filePath, ...arguments_);
      };
    },
  });
}

test('real scanner fails closed when data-root child probes return EACCES', async () => {
  const source = tempDir('preflight-access-denied');
  const fsApi = fsApiWithDeniedDataRootChildren(source);

  await assert.rejects(
    assertDataRootMigrationSupported(source, { fsApi }),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.cause?.code === 'EACCES',
  );
});

test('CLI with real scanner preserves manifests when data-root child probes return EACCES', async () => {
  const source = tempDir('cli-access-denied-source');
  const fsApi = fsApiWithDeniedDataRootChildren(source);
  const targetParent = tempDir('cli-access-denied-target-parent');
  const target = path.join(targetParent, 'data');
  const pathStoreRoot = tempDir('cli-access-denied-path-store');
  const pathStoreFile = path.join(pathStoreRoot, 'paths.json');
  fs.writeFileSync(pathStoreFile, JSON.stringify({ DataDir: source }, null, 2));
  const store = createJsonStore(pathStoreFile);
  const sourceBefore = fileManifest(source);
  const targetBefore = fileManifest(targetParent);
  const pathStoreBefore = fileManifest(pathStoreRoot);

  const code = await runCli(['data-dir', 'set', target], {
    store,
    env: {},
    applicationControlRoot: tempDir('cli-access-denied-control'),
    assertDataRootMigrationSupported: (dataDir) => (
      assertDataRootMigrationSupported(dataDir, { fsApi })
    ),
    stdout: output(),
    stderr: output(),
  });

  assert.equal(code, 1);
  assert.deepEqual(fileManifest(source), sourceBefore);
  assert.deepEqual(fileManifest(targetParent), targetBefore);
  assert.deepEqual(fileManifest(pathStoreRoot), pathStoreBefore);
  assert.equal(fs.existsSync(target), false);
});

test('a failed verified copy leaves the existing data-dir configuration unchanged', async () => {
  const source = tempDir('failed-copy-source');
  const target = path.join(tempDir('failed-copy-target'), 'occupied-target');
  fs.writeFileSync(path.join(source, 'config.db'), 'database');
  fs.writeFileSync(target, 'not a directory');
  const store = memoryStore({ DataDir: source });
  const stderr = output();

  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    stdout: output(),
    stderr,
  });

  assert.equal(code, 1);
  assert.equal(store.values.DataDir, source);
  assert.match(stderr.lines.join('\n'), /目标路径不是目录/);
});

test('copy and manifest failures leave configuration unchanged and the same target retryable', async () => {
  for (const failure of ['copy', 'manifest']) {
    const source = tempDir(`${failure}-fault-source`);
    const parent = tempDir(`${failure}-fault-target-parent`);
    const target = path.join(parent, 'data');
    fs.writeFileSync(path.join(source, 'config.db'), 'source database');
    const store = memoryStore({ DataDir: source });
    const fsApi = new Proxy(fs, {
      get(realFs, property) {
        if (failure === 'copy' && property === 'cpSync') {
          return (...arguments_) => {
            realFs.cpSync(...arguments_);
            throw new Error('injected copy failure');
          };
        }
        if (failure === 'manifest' && property === 'readFileSync') {
          return (filePath, ...arguments_) => {
            const bytes = realFs.readFileSync(filePath, ...arguments_);
            return String(filePath).includes('.mythpen-staging-')
              ? Buffer.concat([bytes, Buffer.from('corrupted')])
              : bytes;
          };
        }
        return realFs[property];
      },
    });

    const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, { fsApi }),
      stdout: output(),
      stderr: output(),
    });

    assert.equal(code, 1, failure);
    assert.equal(store.values.DataDir, source, failure);
    assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'source database', failure);
    assert.equal(fs.existsSync(target), false, failure);
    assert.deepEqual(
      fs.readdirSync(parent).filter((entry) => entry.includes('.mythpen-staging-')),
      [],
      failure,
    );
  }
});

test('cleanup warnings are printed after the verified path is persisted', { timeout: 30_000 }, async () => {
  for (const cleanupFailure of ['child', 'container']) {
    const source = tempDir(`${cleanupFailure}-cleanup-cli-source`);
    const parent = tempDir(`${cleanupFailure}-cleanup-cli-target-parent`);
    const target = path.join(parent, 'data');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'config.db'), 'complete new data');
    const events = [];
    const store = memoryStore({ DataDir: source });
    const storeSet = store.set;
    store.set = (name, value) => {
      events.push('store.set');
      storeSet(name, value);
    };
    let failedPath;
    const fsApi = new Proxy(fs, {
      get(realFs, property) {
        if (property !== 'rmdirSync') return realFs[property];
        return (directory) => {
          const isChild = path.basename(directory) === 'original-target';
          const shouldFail = cleanupFailure === 'child'
            ? isChild
            : !isChild && path.basename(directory).startsWith('.data.mythpen-backup-');
          if (shouldFail) {
            failedPath = directory;
            throw new Error(`injected ${cleanupFailure} cleanup failure`);
          }
          return realFs.rmdirSync(directory);
        };
      },
    });
    const stdout = {
      write(line) {
        events.push(String(line));
      },
    };

    const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, { fsApi }),
      stdout,
      stderr: output(),
    });

    const warningIndex = events.findIndex((event) => (
      event.includes('迁移已完成，但临时备份清理失败')
    ));
    assert.equal(code, 0, cleanupFailure);
    assert.equal(store.values.DataDir, path.resolve(target), cleanupFailure);
    assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'complete new data');
    assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'complete new data');
    assert.ok(warningIndex > events.indexOf('store.set'), cleanupFailure);
    assert.match(events[warningIndex], new RegExp(
      failedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
    assert.match(events[warningIndex], new RegExp(`injected ${cleanupFailure} cleanup failure`));
  }
});

test('stdout failures after a committed migration cannot prevent configuration persistence', { timeout: 30_000 }, async () => {
  for (const throwOnWrite of [1, 2, 3]) {
    const source = tempDir(`stdout-${throwOnWrite}-source`);
    const target = path.join(tempDir(`stdout-${throwOnWrite}-target-parent`), 'data');
    fs.writeFileSync(path.join(source, 'config.db'), 'committed data');
    const store = memoryStore({ DataDir: source });
    const stderr = output();
    let writes = 0;

    const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      stdout: {
        write() {
          writes += 1;
          if (writes === throwOnWrite) {
            throw new Error(`injected stdout failure ${throwOnWrite}`);
          }
        },
      },
      stderr,
    });

    assert.equal(code, 1, throwOnWrite);
    assert.equal(store.values.DataDir, path.resolve(target), throwOnWrite);
    assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'committed data');
    assert.match(stderr.lines.join('\n'), new RegExp(`injected stdout failure ${throwOnWrite}`));
  }
});

test('migration publishes through the Windows atomic helper boundary', { timeout: 30_000 }, async () => {
  for (const externalType of ['file', 'directory', 'junction']) {
    const source = tempDir(`${externalType}-atomic-boundary-source`);
    const parent = tempDir(`${externalType}-atomic-boundary-parent`);
    const target = path.join(parent, 'data');
    const external = tempDir(`${externalType}-atomic-boundary-external`);
    fs.writeFileSync(path.join(source, 'story.md'), 'source story');
    fs.writeFileSync(path.join(external, 'external.txt'), 'external');
    const externalIdentity = fs.statSync(external).ino;
    const store = memoryStore({ DataDir: source });
    let helperCalls = 0;
    let targetIdentity;
    const execFile = (file, arguments_, options, callback) => {
      helperCalls += 1;
      if (externalType === 'file') {
        fs.writeFileSync(target, 'external file');
      } else if (externalType === 'directory') {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'external.txt'), 'external directory');
      } else {
        fs.symlinkSync(external, target, 'junction');
      }
      targetIdentity = fs.lstatSync(target).ino;
      return realExecFile(file, arguments_, options, callback);
    };
    const stderr = output();

    const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
      store, env: {}, homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, {
        execFile,
        platform: 'win32',
      }),
      stdout: output(), stderr,
    });

    assert.equal(helperCalls, 1, externalType);
    assert.equal(code, 1, externalType);
    assert.equal(store.values.DataDir, source, externalType);
    assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'source story');
    assert.equal(fs.lstatSync(target).ino, targetIdentity, externalType);
    assert.equal(fs.statSync(external).ino, externalIdentity, externalType);
    assert.equal(fs.readFileSync(path.join(external, 'external.txt'), 'utf8'), 'external');
    if (externalType === 'file') {
      assert.equal(fs.readFileSync(target, 'utf8'), 'external file');
    } else if (externalType === 'directory') {
      assert.equal(fs.readFileSync(path.join(target, 'external.txt'), 'utf8'), 'external directory');
    }
    assert.match(stderr.lines.join('\n'), /原子发布失败|发布时已被占用/);
  }
});

test('persists a corroborated commit when execFile reports an error after moving', async () => {
  const source = tempDir('callback-error-source');
  const target = path.join(tempDir('callback-error-parent'), 'new data');
  fs.writeFileSync(path.join(source, 'story.md'), 'committed story');
  const store = memoryStore({ DataDir: source });
  let syntheticErrors = 0;
  const execFile = (file, arguments_, options, callback) => (
    realExecFile(file, arguments_, options, (error, stdout, stderr) => {
      if (error) {
        callback(error, stdout, stderr);
        return;
      }
      syntheticErrors += 1;
      callback(
        Object.assign(new Error('synthetic signal after committed move'), {
          signal: 'SIGTERM',
        }),
        stdout,
        'synthetic transport failure',
      );
    })
  );

  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store, env: {}, homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, {
      execFile,
      platform: 'win32',
    }),
    stdout: output(), stderr: output(),
  });

  assert.equal(syntheticErrors, 1);
  assert.equal(code, 0);
  assert.equal(store.values.DataDir, path.resolve(target));
  assert.equal(fs.readFileSync(path.join(target, 'story.md'), 'utf8'), 'committed story');
  assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'committed story');
});

test('committed migration reports an actionable recovery command when store.set fails', async () => {
  const source = tempDir('store-failure-source');
  const target = path.join(tempDir('store-failure-target-parent'), 'new data');
  fs.writeFileSync(path.join(source, 'config.db'), 'complete data');
  const store = memoryStore({ DataDir: source });
  store.set = () => { throw new Error('registry access denied'); };
  const stderr = output();
  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store, env: {}, homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false, stdout: output(), stderr,
  });
  const message = stderr.lines.join('\n');
  assert.equal(code, 1);
  assert.equal(store.values.DataDir, source);
  assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'complete data');
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'complete data');
  assert.match(message, /迁移数据已提交/);
  assert.match(message, new RegExp(path.resolve(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(message, /配置保存失败/);
  assert.match(message, /源目录仍保留/);
  assert.match(message, /mythpen-cli data-dir set ".*new data"/);
  assert.match(message, /registry access denied/);
});

test('store failure diagnostic includes every committed cleanup residual', async () => {
  const target = path.resolve(tempDir('warning-store-target'));
  const store = memoryStore({ DataDir: 'C:\\Old' });
  store.set = () => { throw new Error('registry denied'); };
  const stderr = output();
  const warnings = [
    { path: 'C:\\residual\\marker-a', error: 'marker locked' },
    { path: 'C:\\residual\\backup-b', error: 'backup locked' },
  ];
  const code = await runStorageCli(['data-dir', 'set', target, '--migrate'], {
    store, env: {}, homeDir: 'C:\\Users\\author', isServerRunning: async () => false,
    copyAndVerifyDirectory: () => ({
      source: 'C:\\Old', target, fileCount: 1, totalBytes: 1, cleanupWarnings: warnings,
    }),
    stdout: output(), stderr,
  });
  assert.equal(code, 1);
  for (const warning of warnings) {
    assert.match(stderr.lines[0], new RegExp(warning.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(stderr.lines[0], new RegExp(warning.error));
  }
});

test('export-dir get and set --migrate mirror data-dir behavior', async () => {
  const source = tempDir('export-source');
  const target = path.join(tempDir('export-target'), 'exports');
  fs.writeFileSync(path.join(source, 'chapter.docx'), 'document');
  const store = memoryStore({ ExportDir: source });
  const stdout = output();

  const getCode = await runStorageCli(['export-dir', 'get'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout,
    stderr: output(),
  });
  const setCode = await runStorageCli(['export-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    stdout,
    stderr: output(),
  });

  assert.equal(getCode, 0);
  assert.equal(stdout.lines[0], path.resolve(source));
  assert.equal(setCode, 0);
  assert.equal(store.values.ExportDir, path.resolve(target));
  assert.equal(fs.readFileSync(path.join(target, 'chapter.docx'), 'utf8'), 'document');
  assert.equal(fs.readFileSync(path.join(source, 'chapter.docx'), 'utf8'), 'document');
});

test('set records persistent paths but reports environment overrides for both storage scopes', async () => {
  for (const scenario of [
    { scope: 'data-dir', key: 'DataDir', envName: 'MYTHPEN_DATA_DIR' },
    { scope: 'export-dir', key: 'ExportDir', envName: 'MYTHPEN_EXPORT_DIR' },
  ]) {
    const target = path.join(tempDir(`${scenario.scope}-persistent`), 'configured');
    const effective = path.join(tempDir(`${scenario.scope}-environment`), 'effective');
    const store = memoryStore();
    const stdout = output();

    const code = await runStorageCli([scenario.scope, 'set', target], {
      store,
      env: { [scenario.envName]: effective },
      homeDir: 'C:\\Users\\author',
      stdout,
      stderr: output(),
    });

    const text = stdout.lines.join('\n');
    assert.equal(code, 0, scenario.scope);
    assert.equal(store.values[scenario.key], path.resolve(target), scenario.scope);
    assert.match(text, /持久设置已保存/, scenario.scope);
    assert.match(text, new RegExp(scenario.envName), scenario.scope);
    assert.match(text, new RegExp(path.resolve(effective).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), scenario.scope);
    assert.doesNotMatch(text, /重新启动 Mythpen 使设置生效/, scenario.scope);
  }
});

test('invalid commands and flags return usage exit code without changing configuration', async () => {
  const store = memoryStore({ DataDir: 'C:\\OldData' });
  const stderr = output();

  const unknownCode = await runStorageCli(['unknown', 'get'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout: output(),
    stderr,
  });
  const invalidFlagCode = await runStorageCli(['data-dir', 'set', 'D:\\NewData', '--force'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout: output(),
    stderr,
  });

  assert.equal(unknownCode, 2);
  assert.equal(invalidFlagCode, 2);
  assert.equal(store.values.DataDir, 'C:\\OldData');
  assert.match(stderr.lines.join('\n'), /mythpen-cli data-dir get/);
});
