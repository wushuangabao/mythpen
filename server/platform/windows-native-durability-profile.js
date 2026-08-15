const { createHash } = require('node:crypto');

const { getBuildInfo } = require('../build-info');

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EMBEDDED_PROFILE_JSON = typeof __MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE_JSON__ === 'string'
  ? __MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE_JSON__
  : '';
const EMBEDDED_AUTHORIZATION_DIGEST = (
  typeof __MYTHPEN_WINDOWS_NATIVE_DURABILITY_AUTHORIZATION_DIGEST__ === 'string'
    ? __MYTHPEN_WINDOWS_NATIVE_DURABILITY_AUTHORIZATION_DIGEST__
    : ''
);

function unsupported(message = 'Windows native durability has no exact reviewed build profile') {
  const error = new Error(message);
  error.code = 'DURABILITY_UNSUPPORTED';
  return error;
}

function exactPlainDataObject(value, keys) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  ) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function freezeCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCopy));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.keys(value).map((key) => [key, freezeCopy(value[key])]),
    ));
  }
  return value;
}

function validRuntime(value) {
  return exactPlainDataObject(value, ['bunVersion', 'sqliteSourceId', 'sqliteVersion', 'sqliteVfs'])
    && value.bunVersion === '1.3.14'
    && /^3\.[0-9]+\.[0-9]+$/.test(value.sqliteVersion)
    && typeof value.sqliteSourceId === 'string'
    && value.sqliteSourceId.length > 0
    && value.sqliteVfs === 'win32';
}

function validFilesystem(value) {
  return exactPlainDataObject(value, ['bytesPerSector', 'name', 'rootKind'])
    && value.name === 'NTFS'
    && Number.isSafeInteger(value.bytesPerSector)
    && value.bytesPerSector > 0
    && value.rootKind === 'plain-directory';
}

function validVirtualBox(value) {
  return exactPlainDataObject(value, ['controller', 'hostIoCache', 'storageController', 'version'])
    && value.version === '7.2.14'
    && value.storageController === 'SATA'
    && value.controller === 'IntelAhci'
    && value.hostIoCache === false;
}

function validPlatform(value) {
  return exactPlainDataObject(value, ['filesystem', 'virtualBox', 'windowsVersion'])
    && value.windowsVersion === 'windows-10-enterprise-ltsc-2021-eval-x64'
    && validFilesystem(value.filesystem)
    && validVirtualBox(value.virtualBox);
}

function validPragmas(value) {
  return exactPlainDataObject(value, ['journalMode', 'synchronous'])
    && value.journalMode === 'delete'
    && value.synchronous === 3;
}

function validRollbackResult(value) {
  return exactPlainDataObject(value, [
    'caseCount', 'complete', 'pragmas', 'probeSha256', 'rawRunSha256', 'result',
  ])
    && value.caseCount === 13
    && value.complete === true
    && value.result === 'all-cold-converged'
    && HASH_PATTERN.test(value.probeSha256)
    && HASH_PATTERN.test(value.rawRunSha256)
    && validPragmas(value.pragmas);
}

function validDirectoryResult(value) {
  return exactPlainDataObject(value, [
    'caseCount', 'complete', 'probeSha256', 'rawRunSha256', 'result',
  ])
    && value.caseCount === 19
    && value.complete === true
    && value.result === 'all-cold-converged'
    && HASH_PATTERN.test(value.probeSha256)
    && HASH_PATTERN.test(value.rawRunSha256);
}

function validateExpectedBuild(expectedBuild) {
  if (
    !exactPlainDataObject(expectedBuild, ['sourceCommit', 'targetTriple'])
    || !COMMIT_PATTERN.test(expectedBuild.sourceCommit || '')
    || expectedBuild.targetTriple !== 'x86_64-pc-windows-msvc'
  ) throw unsupported('Reviewed manifest build binding is invalid');
}

function validateReviewedManifest(manifest, expectedBuild) {
  validateExpectedBuild(expectedBuild);
  if (
    !exactPlainDataObject(manifest, [
      'directoryEntries', 'platform', 'rollbackJournal', 'runtime', 'sourceCommit',
      'targetTriple', 'type', 'version',
    ])
    || manifest.version !== 1
    || manifest.type !== 'mythpen.windows-l1-reviewed-manifest.v1'
    || manifest.sourceCommit !== expectedBuild.sourceCommit
    || manifest.targetTriple !== expectedBuild.targetTriple
    || !validRuntime(manifest.runtime)
    || !validPlatform(manifest.platform)
    || !validRollbackResult(manifest.rollbackJournal)
    || !validDirectoryResult(manifest.directoryEntries)
  ) throw unsupported('Reviewed Windows native durability manifest is inexact or incomplete');
}

function createWindowsNativeDurabilityBuildAuthorization(manifest, expectedBuild) {
  validateReviewedManifest(manifest, expectedBuild);
  const authorizationDigest = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  const profile = freezeCopy({
    version: 1,
    authorizationDigest,
    sourceCommit: manifest.sourceCommit,
    targetTriple: manifest.targetTriple,
    runtime: manifest.runtime,
    platform: manifest.platform,
    rollbackJournal: {
      caseCount: manifest.rollbackJournal.caseCount,
      pragmas: manifest.rollbackJournal.pragmas,
    },
    directoryEntries: { caseCount: manifest.directoryEntries.caseCount },
  });
  return Object.freeze({
    authorizationDigest,
    profile,
    profileJson: canonicalJson(profile),
  });
}

function validEmbeddedProfile(value) {
  return exactPlainDataObject(value, [
    'authorizationDigest', 'directoryEntries', 'platform', 'rollbackJournal',
    'runtime', 'sourceCommit', 'targetTriple', 'version',
  ])
    && value.version === 1
    && HASH_PATTERN.test(value.authorizationDigest || '')
    && COMMIT_PATTERN.test(value.sourceCommit || '')
    && value.targetTriple === 'x86_64-pc-windows-msvc'
    && validRuntime(value.runtime)
    && validPlatform(value.platform)
    && exactPlainDataObject(value.rollbackJournal, ['caseCount', 'pragmas'])
    && value.rollbackJournal.caseCount === 13
    && validPragmas(value.rollbackJournal.pragmas)
    && exactPlainDataObject(value.directoryEntries, ['caseCount'])
    && value.directoryEntries.caseCount === 19;
}

let cachedEmbeddedProfile;

function requireEmbeddedWindowsNativeDurabilityProfile() {
  if (arguments.length !== 0) throw unsupported('Runtime callers cannot supply durability evidence');
  if (cachedEmbeddedProfile) return cachedEmbeddedProfile;
  const build = getBuildInfo();
  if (
    build.nativeActivationMode !== 'production'
    || !HASH_PATTERN.test(EMBEDDED_AUTHORIZATION_DIGEST)
    || EMBEDDED_PROFILE_JSON.length === 0
  ) throw unsupported();
  let parsed;
  try {
    parsed = JSON.parse(EMBEDDED_PROFILE_JSON);
  } catch {
    throw unsupported('Embedded Windows native durability profile is not exact JSON');
  }
  if (
    !validEmbeddedProfile(parsed)
    || parsed.authorizationDigest !== EMBEDDED_AUTHORIZATION_DIGEST
    || parsed.sourceCommit !== build.sourceCommit
    || parsed.targetTriple !== build.targetTriple
    || canonicalJson(parsed) !== EMBEDDED_PROFILE_JSON
  ) throw unsupported('Embedded Windows native durability profile does not match this build');
  cachedEmbeddedProfile = freezeCopy(parsed);
  return cachedEmbeddedProfile;
}

module.exports = {
  createWindowsNativeDurabilityBuildAuthorization,
  requireEmbeddedWindowsNativeDurabilityProfile,
};
