const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const SOURCE_COMMIT = 'a'.repeat(40);
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

function reviewedManifest() {
  return {
    version: 1, type: 'mythpen.windows-l1-reviewed-manifest.v1',
    sourceCommit: SOURCE_COMMIT, targetTriple: TARGET_TRIPLE,
    runtime: { bunVersion: '1.3.14', sqliteVersion: '3.53.0', sqliteSourceId: 'source-id', sqliteVfs: 'win32' },
    platform: {
      windowsVersion: 'windows-10-enterprise-ltsc-2021-eval-x64',
      filesystem: { name: 'NTFS', bytesPerSector: 4096, rootKind: 'plain-directory' },
      virtualBox: {
        version: '7.2.14', storageController: 'SATA', controller: 'IntelAhci', hostIoCache: false,
      },
    },
    rollbackJournal: { rawRunSha256: 'b'.repeat(64), probeSha256: 'c'.repeat(64), caseCount: 13, complete: true, result: 'all-cold-converged', pragmas: { journalMode: 'delete', synchronous: 3 } },
    directoryEntries: { rawRunSha256: 'd'.repeat(64), probeSha256: 'e'.repeat(64), caseCount: 19, complete: true, result: 'all-cold-converged' },
  };
}

function withBuildMode(t, mode) {
  const buildInfo = require('../build-info');
  const original = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: mode,
    sourceCommit: SOURCE_COMMIT,
    targetTriple: TARGET_TRIPLE,
  });
  t.after(() => { buildInfo.getBuildInfo = original; });
}

test('runtime JSON, environment, CLI, and duck objects cannot mint production authority', (t) => {
  withBuildMode(t, 'production');
  process.env.MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE = JSON.stringify(reviewedManifest());
  const originalArgv = process.argv;
  process.argv = [...process.argv, '--reviewed-manifest', JSON.stringify(reviewedManifest())];
  t.after(() => {
    delete process.env.MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE;
    process.argv = originalArgv;
  });

  const observed = [];
  const callerEvidence = new Proxy({}, {
    get(_target, key) { observed.push(String(key)); return reviewedManifest(); },
  });
  const { requireWindowsNativeRollbackJournalDurability } = require('../platform/windows-native-rollback-capability');
  const { requireWindowsNativeDirectoryEntryDurability } = require('../platform/windows-native-directory-capability');
  const { createProductionNativeActivationController } = require('../native/production-native-activation-controller');

  for (const operation of [
    () => requireWindowsNativeRollbackJournalDurability(callerEvidence),
    () => requireWindowsNativeDirectoryEntryDurability(callerEvidence),
    () => createProductionNativeActivationController(callerEvidence),
  ]) {
    assert.throws(operation, (error) => error?.code === 'DURABILITY_UNSUPPORTED');
  }
  assert.deepEqual(observed, []);
});

test('controller registry rejects fixture/production/off mode confusion and duck typing', (t) => {
  const buildInfo = require('../build-info');
  const original = buildInfo.getBuildInfo;
  t.after(() => { buildInfo.getBuildInfo = original; });
  const registry = require('../native/native-activation-controller');
  const duck = Object.freeze({ activate() {} });

  buildInfo.getBuildInfo = () => Object.freeze({ nativeActivationMode: 'fixture_only', sourceCommit: SOURCE_COMMIT, targetTriple: TARGET_TRIPLE });
  assert.throws(() => registry.assertNativeActivationControllerForBuild(duck), (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED');
  const fixture = registry.registerFixtureNativeActivationController(Object.freeze({ activate() {} }));
  assert.equal(registry.assertNativeActivationControllerForBuild(fixture), fixture);

  buildInfo.getBuildInfo = () => Object.freeze({ nativeActivationMode: 'production', sourceCommit: SOURCE_COMMIT, targetTriple: TARGET_TRIPLE });
  assert.throws(() => registry.assertNativeActivationControllerForBuild(fixture), (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED');
  buildInfo.getBuildInfo = () => Object.freeze({ nativeActivationMode: 'off', sourceCommit: SOURCE_COMMIT, targetTriple: TARGET_TRIPLE });
  assert.throws(() => registry.assertNativeActivationControllerForBuild(fixture), (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED');
});

test('an exactly embedded production controller installs only in production mode', () => {
  const manifest = JSON.stringify(reviewedManifest());
  const script = `
    const assert = require('node:assert/strict');
    const profilePath = require.resolve('./server/platform/windows-native-durability-profile');
    const builder = require(profilePath);
    const sourceCommit = '${SOURCE_COMMIT}';
    const targetTriple = '${TARGET_TRIPLE}';
    const authorization = builder.createWindowsNativeDurabilityBuildAuthorization(
      ${manifest}, { sourceCommit, targetTriple },
    );
    global.__MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE_JSON__ = authorization.profileJson;
    global.__MYTHPEN_WINDOWS_NATIVE_DURABILITY_AUTHORIZATION_DIGEST__ = authorization.authorizationDigest;
    delete require.cache[profilePath];
    const buildInfo = require('./server/build-info');
    buildInfo.getBuildInfo = () => Object.freeze({ nativeActivationMode: 'production', sourceCommit, targetTriple });
    const production = require('./server/native/production-native-activation-controller');
    const registry = require('./server/native/native-activation-controller');
    const controller = production.createProductionNativeActivationController();
    assert.equal(registry.assertNativeActivationControllerForBuild(controller), controller);
    for (const mode of ['fixture_only', 'off']) {
      buildInfo.getBuildInfo = () => Object.freeze({ nativeActivationMode: mode, sourceCommit, targetTriple });
      assert.throws(() => registry.assertNativeActivationControllerForBuild(controller), (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED');
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('missing compile-time profile rejects before filesystem, db, lease, ControlStore, SQLite, or activation mutation', (t) => {
  withBuildMode(t, 'production');
  const productionPath = require.resolve('../native/production-native-activation-controller');
  delete require.cache[productionPath];
  t.after(() => { delete require.cache[productionPath]; });

  const originalExists = fs.existsSync;
  let filesystemCalls = 0;
  fs.existsSync = (...args) => { filesystemCalls += 1; return originalExists(...args); };
  t.after(() => { fs.existsSync = originalExists; });

  const { createProductionNativeActivationController } = require(productionPath);
  assert.throws(
    () => createProductionNativeActivationController(),
    (error) => error?.code === 'DURABILITY_UNSUPPORTED',
  );
  assert.equal(filesystemCalls, 0);
  assert.equal(require.cache[require.resolve('../db')], undefined);
  assert.equal(require.cache[require.resolve('../control-store')], undefined);
  assert.equal(require.cache[require.resolve('../config-lifecycle-lease')], undefined);
  assert.equal(require.cache[require.resolve('../native/native-activation')], undefined);
});

test('production graph owns its entry and db validation has no fixture-controller dependency', () => {
  const root = path.join(__dirname, '..');
  const dbSource = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
  const entrySource = fs.readFileSync(path.join(root, 'production-sidecar.js'), 'utf8');
  const productionSource = fs.readFileSync(
    path.join(root, 'native', 'production-native-activation-controller.js'),
    'utf8',
  );

  assert.doesNotMatch(dbSource, /fixture-native-activation-controller/);
  assert.doesNotMatch(dbSource, /require\(['"]\.\/testing\//);
  assert.doesNotMatch(productionSource, /server[\\/]testing|\.\.\/[\\]?testing|\.\.\/testing/);
  assert.ok(entrySource.indexOf('createProductionNativeActivationController') < entrySource.indexOf("require('./db')"));
  assert.ok(entrySource.indexOf('installNativeActivationController') < entrySource.indexOf("require('./index')"));
});
