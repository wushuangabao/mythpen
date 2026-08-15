const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const FIXTURE_ROOT_PREFIX = 'mythpen-native-stage-c-';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function snapshotTree(root) {
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  function visit(current, relative) {
    const stats = fs.lstatSync(current, { bigint: true });
    rows.push({
      relative,
      type: stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : 'file',
      size: String(stats.size),
      digest: stats.isFile() ? sha256(fs.readFileSync(current)) : null,
    });
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const name of fs.readdirSync(current).sort()) {
      visit(path.join(current, name), relative ? path.join(relative, name) : name);
    }
  }
  visit(root, '');
  return rows;
}

function loadFixtureOnlyModules(t, mode = 'fixture_only') {
  const buildInfoPath = require.resolve('../build-info');
  const authorityPath = require.resolve('../native/native-activation-authority');
  const fixturePath = require.resolve('../testing/native-stage-c-fixture');
  const buildInfo = require(buildInfoPath);
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: mode,
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  delete require.cache[authorityPath];
  delete require.cache[fixturePath];
  t.after(() => {
    buildInfo.getBuildInfo = originalGetBuildInfo;
    delete require.cache[authorityPath];
    delete require.cache[fixturePath];
  });
  return {
    authority: require(authorityPath),
    fixture: require(fixturePath),
  };
}

function trackFixture(t, fixture) {
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  return fixture;
}

function assertDisabled(operation) {
  assert.throws(operation, (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED');
}

function assertRejectedReadOnly(root, beforeMutation, operation) {
  const before = snapshotTree(root);
  assertDisabled(operation);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(beforeMutation.calls, 0);
}

function createWin32AttributesStub(attributesForPath) {
  const registryRows = {
    DataDir: 2,
    ExportDir: 2,
  };
  const trap = {
    calls: [],
    opened: [],
    pointerCalls: 0,
    registryCalls: [],
  };
  const { FFIType } = require('bun:ffi');
  return {
    registryRows,
    trap,
    replacements: {
      dlopen(libraryName, definitions) {
        trap.opened.push(libraryName);
        if (libraryName === 'kernel32.dll') {
          assert.deepEqual(Object.keys(definitions), ['GetFileAttributesW']);
          assert.deepEqual(definitions.GetFileAttributesW, {
            args: [FFIType.ptr],
            returns: FFIType.u32,
          });
          return {
            symbols: {
              GetFileAttributesW(pointer) {
                assert.equal(Buffer.isBuffer(pointer), true);
                const decoded = pointer.toString('utf16le').replace(/\0+$/, '');
                trap.calls.push(decoded);
                return attributesForPath(decoded);
              },
            },
          };
        }
        assert.equal(libraryName, 'advapi32.dll');
        assert.deepEqual(Object.keys(definitions), ['RegGetValueW']);
        assert.deepEqual(definitions.RegGetValueW, {
          args: [
            FFIType.u64,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.u32,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.ptr,
          ],
          returns: FFIType.i32,
        });
        return {
          symbols: {
            RegGetValueW(hkey, subKeyPointer, valueNamePointer, flags, typePointer, dataPointer, sizePointer) {
              assert.equal(hkey, 0xffffffff80000001n);
              assert.equal(subKeyPointer.toString('utf16le').replace(/\0+$/, ''), 'Software\\Mythpen');
              const valueName = valueNamePointer.toString('utf16le').replace(/\0+$/, '');
              assert.equal(['DataDir', 'ExportDir'].includes(valueName), true);
              assert.equal(flags, 0x00000002);
              assert.equal(Buffer.isBuffer(typePointer), true);
              assert.equal(Buffer.isBuffer(sizePointer), true);
              const phase = dataPointer === 0 ? 'query' : 'read';
              trap.registryCalls.push({ phase, valueName });
              const configured = registryRows[valueName];
              const result = typeof configured === 'function' ? configured(phase) : configured;
              if (typeof result === 'number') return result;
              const bytes = Buffer.from(`${result}\0`, 'utf16le');
              typePointer.writeUInt32LE(1, 0);
              if (phase === 'query') {
                sizePointer.writeUInt32LE(bytes.length, 0);
                return 0;
              }
              assert.equal(Buffer.isBuffer(dataPointer), true);
              assert.ok(sizePointer.readUInt32LE(0) >= bytes.length);
              bytes.copy(dataPointer);
              sizePointer.writeUInt32LE(bytes.length, 0);
              return 0;
            },
          },
        };
      },
      ptr(value) {
        assert.equal(Buffer.isBuffer(value), true);
        trap.pointerCalls += 1;
        return value;
      },
    },
  };
}

function patchBunFfi(t, replacements) {
  const ffi = require('bun:ffi');
  const descriptors = new Map();
  for (const name of ['dlopen', 'ptr']) {
    const descriptor = Object.getOwnPropertyDescriptor(ffi, name);
    assert.ok(descriptor, `bun:ffi.${name} descriptor is required`);
    descriptors.set(name, descriptor);
    Object.defineProperty(ffi, name, { ...descriptor, value: replacements[name] });
  }
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      Object.defineProperty(ffi, name, descriptor);
    }
  });
}

test('ordinary builds stay off and runtime environment cannot activate native authority', (t) => {
  const previousMode = process.env.MYTHPEN_NATIVE_ACTIVATION_MODE;
  process.env.MYTHPEN_NATIVE_ACTIVATION_MODE = 'fixture_only';
  t.after(() => {
    if (previousMode === undefined) delete process.env.MYTHPEN_NATIVE_ACTIVATION_MODE;
    else process.env.MYTHPEN_NATIVE_ACTIVATION_MODE = previousMode;
  });

  const { getBuildInfo } = require('../build-info');
  const { authorizeNativeActivation } = require('../native/native-activation-authority');
  assert.equal(getBuildInfo().nativeActivationMode, 'off');
  assertDisabled(() => authorizeNativeActivation({ root: os.tmpdir() }));
});

test('Stage C helper creates the canonical no-clobber marker before any project', (t) => {
  const { fixture } = loadFixtureOnlyModules(t);
  assert.deepEqual(Object.keys(fixture), ['createNativeStageCFixture']);
  assert.throws(
    () => fixture.createNativeStageCFixture({ root: os.tmpdir() }),
    /does not accept options/i,
  );

  const created = trackFixture(t, fixture.createNativeStageCFixture());
  const canonicalTemp = canonicalPath(fs.realpathSync.native(os.tmpdir()));
  assert.equal(canonicalPath(path.dirname(created.root)), canonicalTemp);
  assert.equal(path.basename(created.root).startsWith(FIXTURE_ROOT_PREFIX), true);
  assert.equal(fs.realpathSync.native(created.root), created.root);
  assert.equal(fs.lstatSync(created.root).isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(created.root), [path.basename(created.markerPath)]);

  const markerBytes = fs.readFileSync(created.markerPath);
  const marker = JSON.parse(markerBytes);
  assert.deepEqual(Object.keys(marker), ['version', 'runId', 'rootDigest', 'expiresAt']);
  assert.equal(markerBytes.toString('utf8'), JSON.stringify(marker));
  assert.equal(marker.version, 1);
  assert.match(marker.runId, UUID_V4_PATTERN);
  assert.equal(marker.rootDigest, sha256(created.root));
  assert.equal(Number.isInteger(marker.expiresAt), true);
  assert.ok(marker.expiresAt > Date.now());
  assert.ok(marker.expiresAt - Date.now() <= 5 * 60 * 1000);
  assert.equal(created.runId, marker.runId);
  assert.equal(created.expiresAt, marker.expiresAt);
  assert.equal(created.markerDigest, sha256(markerBytes));
  assert.equal(Object.isFrozen(created), true);
  assert.doesNotMatch(JSON.stringify(created), /secret|token/i);
});

test('fixture-only validation yields an exact recursively frozen one-shot authority', (t) => {
  const { authority, fixture } = loadFixtureOnlyModules(t);
  const created = trackFixture(t, fixture.createNativeStageCFixture());
  let beforeMutationCalls = 0;
  const granted = authority.authorizeNativeActivation({
    root: created.root,
    beforeMutation() { beforeMutationCalls += 1; },
  });

  assert.deepEqual(Object.keys(granted), ['root', 'runId', 'markerDigest', 'consume']);
  assert.equal(granted.root, created.root);
  assert.equal(granted.runId, created.runId);
  assert.equal(granted.markerDigest, created.markerDigest);
  assert.equal(Object.isFrozen(granted), true);
  assert.equal(Object.isFrozen(granted.consume), true);
  assert.equal(beforeMutationCalls, 0);
  assert.deepEqual(granted.consume(), {
    root: created.root,
    runId: created.runId,
    markerDigest: created.markerDigest,
  });
  assert.equal(beforeMutationCalls, 1);
  assertDisabled(() => granted.consume());
  assert.equal(beforeMutationCalls, 1);
  assertDisabled(() => authority.authorizeNativeActivation({ root: created.root }));
});

for (const item of [
  ['missing', (created) => fs.unlinkSync(created.markerPath)],
  ['malformed', (created) => fs.writeFileSync(created.markerPath, '{')],
  ['replaced with identical bytes', (created) => {
    const bytes = fs.readFileSync(created.markerPath);
    const replacement = `${created.markerPath}.replacement`;
    fs.writeFileSync(replacement, bytes, { flag: 'wx' });
    fs.renameSync(replacement, created.markerPath);
  }],
]) {
  test(`${item[0]} marker rejects read-only before mutation`, (t) => {
    const { authority, fixture } = loadFixtureOnlyModules(t);
    const created = trackFixture(t, fixture.createNativeStageCFixture());
    const beforeMutation = { calls: 0 };
    item[1](created);
    assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
      root: created.root,
      beforeMutation() { beforeMutation.calls += 1; },
    }));
  });
}

test('expired marker rejects read-only before mutation', (t) => {
  const { authority, fixture } = loadFixtureOnlyModules(t);
  const created = trackFixture(t, fixture.createNativeStageCFixture());
  const marker = JSON.parse(fs.readFileSync(created.markerPath));
  const originalNow = Date.now;
  Date.now = () => marker.expiresAt + 1;
  t.after(() => { Date.now = originalNow; });
  const beforeMutation = { calls: 0 };
  assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
    root: created.root,
    beforeMutation() { beforeMutation.calls += 1; },
  }));
});

test('copied root rejects read-only before mutation', (t) => {
  const { authority, fixture } = loadFixtureOnlyModules(t);
  const created = trackFixture(t, fixture.createNativeStageCFixture());
  const copiedRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), FIXTURE_ROOT_PREFIX));
  t.after(() => fs.rmSync(copiedRoot, { recursive: true, force: true }));
  fs.copyFileSync(created.markerPath, path.join(copiedRoot, path.basename(created.markerPath)));
  const beforeMutation = { calls: 0 };
  assertRejectedReadOnly(copiedRoot, beforeMutation, () => authority.authorizeNativeActivation({
    root: copiedRoot,
    beforeMutation() { beforeMutation.calls += 1; },
  }));
});

test('caller-chosen root and plausible marker reject read-only before mutation', (t) => {
  const { authority } = loadFixtureOnlyModules(t);
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), FIXTURE_ROOT_PREFIX));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = {
    version: 1,
    runId: randomUUID(),
    rootDigest: sha256(root),
    expiresAt: Date.now() + 60_000,
  };
  fs.writeFileSync(path.join(root, '.native-stage-c-activation.json'), JSON.stringify(marker));
  const beforeMutation = { calls: 0 };
  assertRejectedReadOnly(root, beforeMutation, () => authority.authorizeNativeActivation({
    root,
    beforeMutation() { beforeMutation.calls += 1; },
  }));
});

test('a marker cannot be validated twice before consume', (t) => {
  const { authority, fixture } = loadFixtureOnlyModules(t);
  const created = trackFixture(t, fixture.createNativeStageCFixture());
  authority.authorizeNativeActivation({ root: created.root });
  const beforeMutation = { calls: 0 };
  assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
    root: created.root,
    beforeMutation() { beforeMutation.calls += 1; },
  }));
});

test('configured user data root rejects before mutation', (t) => {
  const { authority, fixture } = loadFixtureOnlyModules(t);
  const created = trackFixture(t, fixture.createNativeStageCFixture());
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = created.root;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
  });
  const beforeMutation = { calls: 0 };
  assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
    root: created.root,
    beforeMutation() { beforeMutation.calls += 1; },
  }));
});

for (const target of ['root', 'marker']) {
  test(`Windows ${target} reparse attribute rejects read-only before mutation`, {
    skip: process.platform === 'win32' ? false : 'GetFileAttributesW is Windows-specific',
  }, (t) => {
    const rootPath = { value: null };
    const markerPath = { value: null };
    const { replacements, trap } = createWin32AttributesStub((queriedPath) => {
      if (target === 'root' && queriedPath === rootPath.value) return 0x00000400;
      if (target === 'marker' && queriedPath === markerPath.value) return 0x00000400;
      return queriedPath === markerPath.value ? 0x00000080 : 0x00000010;
    });
    patchBunFfi(t, replacements);
    const { authority, fixture } = loadFixtureOnlyModules(t);
    const created = trackFixture(t, fixture.createNativeStageCFixture());
    rootPath.value = path.win32.toNamespacedPath(created.root);
    markerPath.value = path.win32.toNamespacedPath(created.markerPath);
    const beforeMutation = { calls: 0 };

    assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
      root: created.root,
      beforeMutation() { beforeMutation.calls += 1; },
    }));
    assert.deepEqual(trap.opened, target === 'root'
      ? ['kernel32.dll']
      : ['kernel32.dll', 'advapi32.dll']);
    assert.ok(trap.pointerCalls >= trap.calls.length);
    assert.deepEqual(
      trap.calls,
      target === 'root'
        ? [rootPath.value]
        : [rootPath.value, rootPath.value, markerPath.value],
    );
  });
}

for (const persistentName of ['DataDir', 'ExportDir']) {
  test(`persistent ${persistentName} rejects even when environment overrides it`, {
    skip: process.platform === 'win32' ? 'Windows reads registry directly through RegGetValueW' : false,
  }, (t) => {
    const buildInfoPath = require.resolve('../build-info');
    const authorityPath = require.resolve('../native/native-activation-authority');
    const fixturePath = require.resolve('../testing/native-stage-c-fixture');
    const pathStorePath = require.resolve('../path-store');
    const storagePathsPath = require.resolve('../storage-paths');
    const buildInfo = require(buildInfoPath);
    const pathStore = require(pathStorePath);
    const originalGetBuildInfo = buildInfo.getBuildInfo;
    const originalCreatePathStore = pathStore.createPathStore;
    const previousDataDir = process.env.MYTHPEN_DATA_DIR;
    const previousExportDir = process.env.MYTHPEN_EXPORT_DIR;
    buildInfo.getBuildInfo = () => Object.freeze({
      nativeActivationMode: 'fixture_only',
      sourceCommit: 'a'.repeat(40),
      targetTriple: 'x86_64-pc-windows-msvc',
    });
    delete require.cache[fixturePath];
    const fixture = require(fixturePath);
    const created = trackFixture(t, fixture.createNativeStageCFixture());
    const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-stage-c-env-'));
    t.after(() => fs.rmSync(environmentRoot, { recursive: true, force: true }));
    process.env.MYTHPEN_DATA_DIR = path.join(environmentRoot, 'data');
    process.env.MYTHPEN_EXPORT_DIR = path.join(environmentRoot, 'exports');
    const gets = [];
    pathStore.createPathStore = () => ({
      get(name) {
        gets.push(name);
        return name === persistentName ? created.root : path.join(environmentRoot, name);
      },
    });
    delete require.cache[storagePathsPath];
    delete require.cache[authorityPath];
    t.after(() => {
      buildInfo.getBuildInfo = originalGetBuildInfo;
      pathStore.createPathStore = originalCreatePathStore;
      if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
      else process.env.MYTHPEN_DATA_DIR = previousDataDir;
      if (previousExportDir === undefined) delete process.env.MYTHPEN_EXPORT_DIR;
      else process.env.MYTHPEN_EXPORT_DIR = previousExportDir;
      delete require.cache[authorityPath];
      delete require.cache[fixturePath];
      delete require.cache[storagePathsPath];
    });
    const authority = require(authorityPath);
    const beforeMutation = { calls: 0 };

    assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
      root: created.root,
      beforeMutation() { beforeMutation.calls += 1; },
    }));
    assert.deepEqual(gets, ['DataDir', 'ExportDir']);
  });
}

function createWindowsRegistryFixture(t, mode = 'fixture_only') {
  const stub = createWin32AttributesStub((queriedPath) => (
    queriedPath.endsWith('.native-stage-c-activation.json') ? 0x00000080 : 0x00000010
  ));
  patchBunFfi(t, stub.replacements);
  const loaded = loadFixtureOnlyModules(t, mode);
  const created = trackFixture(t, loaded.fixture.createNativeStageCFixture());
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  const previousExportDir = process.env.MYTHPEN_EXPORT_DIR;
  const environmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-stage-c-registry-env-'));
  process.env.MYTHPEN_DATA_DIR = path.join(environmentRoot, 'data');
  process.env.MYTHPEN_EXPORT_DIR = path.join(environmentRoot, 'exports');
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
    if (previousExportDir === undefined) delete process.env.MYTHPEN_EXPORT_DIR;
    else process.env.MYTHPEN_EXPORT_DIR = previousExportDir;
    fs.rmSync(environmentRoot, { recursive: true, force: true });
  });
  return { ...loaded, created, ...stub };
}

for (const persistentName of ['DataDir', 'ExportDir']) {
  test(`Windows registry ${persistentName} overrides environment and rejects fixture root`, {
    skip: process.platform === 'win32' ? false : 'RegGetValueW is Windows-specific',
  }, (t) => {
    const { authority, created, registryRows, trap } = createWindowsRegistryFixture(t);
    registryRows[persistentName] = created.root;
    const beforeMutation = { calls: 0 };
    assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
      root: created.root,
      beforeMutation() { beforeMutation.calls += 1; },
    }));
    assert.equal(trap.opened.includes('advapi32.dll'), true);
    assert.equal(trap.registryCalls.some((entry) => (
      entry.valueName === persistentName && entry.phase === 'read'
    )), true);
  });
}

for (const failure of [
  ['access denied', 5],
  ['throw', () => { throw new Error('injected RegGetValueW failure'); }],
]) {
  test(`Windows registry ${failure[0]} fails closed before mutation`, {
    skip: process.platform === 'win32' ? false : 'RegGetValueW is Windows-specific',
  }, (t) => {
    const { authority, created, registryRows, trap } = createWindowsRegistryFixture(t);
    registryRows.DataDir = failure[1];
    const beforeMutation = { calls: 0 };
    assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
      root: created.root,
      beforeMutation() { beforeMutation.calls += 1; },
    }));
    assert.deepEqual(trap.registryCalls, [{ phase: 'query', valueName: 'DataDir' }]);
  });
}

test('Windows registry FILE_NOT_FOUND for both values preserves normal fixture consume', {
  skip: process.platform === 'win32' ? false : 'RegGetValueW is Windows-specific',
}, (t) => {
  const { authority, created, trap } = createWindowsRegistryFixture(t);
  let beforeMutationCalls = 0;
  const granted = authority.authorizeNativeActivation({
    root: created.root,
    beforeMutation() { beforeMutationCalls += 1; },
  });
  assert.equal(beforeMutationCalls, 0);
  granted.consume();
  assert.equal(beforeMutationCalls, 1);
  assert.deepEqual(trap.registryCalls, [
    { phase: 'query', valueName: 'DataDir' },
    { phase: 'query', valueName: 'ExportDir' },
    { phase: 'query', valueName: 'DataDir' },
    { phase: 'query', valueName: 'ExportDir' },
  ]);
});

test('production mode rejects a valid fixture root without mutation', (t) => {
  const { authority, fixture } = loadFixtureOnlyModules(t, 'production');
  const created = trackFixture(t, fixture.createNativeStageCFixture());
  const beforeMutation = { calls: 0 };
  assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
    root: created.root,
    beforeMutation() { beforeMutation.calls += 1; },
  }));
});

test('symlink or junction replacement rejects before mutation', {
  skip: process.platform === 'win32' ? false : 'junction behavior is Windows-specific',
}, (t) => {
  const { authority, fixture } = loadFixtureOnlyModules(t);
  const created = trackFixture(t, fixture.createNativeStageCFixture());
  const physical = `${created.root}-physical`;
  fs.renameSync(created.root, physical);
  fs.symlinkSync(physical, created.root, 'junction');
  t.after(() => fs.rmSync(physical, { recursive: true, force: true }));
  const beforeMutation = { calls: 0 };
  assertRejectedReadOnly(created.root, beforeMutation, () => authority.authorizeNativeActivation({
    root: created.root,
    beforeMutation() { beforeMutation.calls += 1; },
  }));
});

test('authority remains before project lease, ControlStore, and DB I/O', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'native', 'native-activation-authority.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /control-store|native-project-store|project lease|require\(['"]\.\.\/db['"]\)/i);
});
