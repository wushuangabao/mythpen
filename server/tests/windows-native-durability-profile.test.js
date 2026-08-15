const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const {
  createWindowsNativeDurabilityBuildAuthorization,
  requireEmbeddedWindowsNativeDurabilityProfile,
} = require('../platform/windows-native-durability-profile');

const SOURCE_COMMIT = 'a'.repeat(40);
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc';

function reviewedManifest(overrides = {}) {
  return {
    version: 1,
    type: 'mythpen.windows-l1-reviewed-manifest.v1',
    sourceCommit: SOURCE_COMMIT,
    targetTriple: TARGET_TRIPLE,
    runtime: {
      bunVersion: '1.3.14',
      sqliteVersion: '3.53.0',
      sqliteSourceId: '2026-04-09 11:41:38 source-id',
      sqliteVfs: 'win32',
    },
    platform: {
      windowsVersion: 'windows-10-enterprise-ltsc-2021-eval-x64',
      filesystem: { name: 'NTFS', bytesPerSector: 4096, rootKind: 'plain-directory' },
      virtualBox: {
        version: '7.2.14', storageController: 'SATA', controller: 'IntelAhci', hostIoCache: false,
      },
    },
    rollbackJournal: {
      rawRunSha256: 'b'.repeat(64),
      probeSha256: 'c'.repeat(64),
      caseCount: 13,
      complete: true,
      result: 'all-cold-converged',
      pragmas: { journalMode: 'delete', synchronous: 3 },
    },
    directoryEntries: {
      rawRunSha256: 'd'.repeat(64),
      probeSha256: 'e'.repeat(64),
      caseCount: 19,
      complete: true,
      result: 'all-cold-converged',
    },
    ...overrides,
  };
}

test('reviewed manifest deterministically yields only an authorization digest and stable profile', () => {
  const first = createWindowsNativeDurabilityBuildAuthorization(reviewedManifest(), {
    sourceCommit: SOURCE_COMMIT,
    targetTriple: TARGET_TRIPLE,
  });
  const second = createWindowsNativeDurabilityBuildAuthorization(
    JSON.parse(JSON.stringify(reviewedManifest())),
    { sourceCommit: SOURCE_COMMIT, targetTriple: TARGET_TRIPLE },
  );

  assert.deepEqual(first, second);
  assert.match(first.authorizationDigest, /^[0-9a-f]{64}$/);
  assert.equal(first.profile.authorizationDigest, first.authorizationDigest);
  assert.equal(first.profile.sourceCommit, SOURCE_COMMIT);
  assert.deepEqual(first.profile.platform.virtualBox, {
    version: '7.2.14', storageController: 'SATA', controller: 'IntelAhci', hostIoCache: false,
  });
  assert.equal(first.profile.rollbackJournal.caseCount, 13);
  assert.equal(first.profile.directoryEntries.caseCount, 19);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.profile.platform.filesystem), true);
  assert.doesNotMatch(JSON.stringify(first), /productionExe|finalExe|candidateExe/i);
});

test('reviewed manifest validation rejects partial, mismatched, or self-hashing production inputs', () => {
  const expected = { sourceCommit: SOURCE_COMMIT, targetTriple: TARGET_TRIPLE };
  const platform = reviewedManifest().platform;
  for (const manifest of [
    reviewedManifest({ sourceCommit: 'f'.repeat(40) }),
    reviewedManifest({ directoryEntries: { ...reviewedManifest().directoryEntries, caseCount: 18 } }),
    reviewedManifest({ rollbackJournal: { ...reviewedManifest().rollbackJournal, complete: false } }),
    reviewedManifest({
      platform: {
        ...platform,
        virtualBox: { ...platform.virtualBox, storageController: 'NVMe' },
      },
    }),
    reviewedManifest({
      platform: {
        ...platform,
        virtualBox: { ...platform.virtualBox, controller: 'PIIX3' },
      },
    }),
    reviewedManifest({ productionExeSha256: 'f'.repeat(64) }),
  ]) {
    assert.throws(
      () => createWindowsNativeDurabilityBuildAuthorization(manifest, expected),
      (error) => error?.code === 'DURABILITY_UNSUPPORTED',
    );
  }
});

test('ordinary runtime has no embedded reviewed profile and caller arguments cannot supply one', () => {
  const fake = Object.freeze(reviewedManifest());
  assert.equal(requireEmbeddedWindowsNativeDurabilityProfile.length, 0);
  assert.throws(
    () => requireEmbeddedWindowsNativeDurabilityProfile(fake),
    (error) => error?.code === 'DURABILITY_UNSUPPORTED',
  );
});

test('mismatched compile-time authorization digest remains fail-closed', () => {
  const authorization = createWindowsNativeDurabilityBuildAuthorization(reviewedManifest(), {
    sourceCommit: SOURCE_COMMIT,
    targetTriple: TARGET_TRIPLE,
  });
  const script = `
    global.__MYTHPEN_SOURCE_COMMIT__ = '${SOURCE_COMMIT}';
    global.__MYTHPEN_TARGET_TRIPLE__ = '${TARGET_TRIPLE}';
    global.__MYTHPEN_NATIVE_ACTIVATION_MODE__ = 'production';
    global.__MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE_JSON__ = ${JSON.stringify(authorization.profileJson)};
    global.__MYTHPEN_WINDOWS_NATIVE_DURABILITY_AUTHORIZATION_DIGEST__ = '${'f'.repeat(64)}';
    const profile = require('./server/platform/windows-native-durability-profile');
    try { profile.requireEmbeddedWindowsNativeDurabilityProfile(); process.exit(2); }
    catch (error) { process.exit(error?.code === 'DURABILITY_UNSUPPORTED' ? 0 : 3); }
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
