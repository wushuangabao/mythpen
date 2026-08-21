const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

class DurabilityError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = code;
  }
}

class LeaseBusyError extends DurabilityError {
  constructor(message, options) {
    super(message, 'LEASE_BUSY', options);
  }
}

class LeaseLostError extends DurabilityError {
  constructor(message, options) {
    super(message, 'LEASE_LOST', options);
  }
}

class TargetLockedError extends DurabilityError {
  constructor(message, options) {
    super(message, 'TARGET_LOCKED', options);
  }
}

class DurabilityUnsupportedError extends DurabilityError {
  constructor(message, options) {
    super(message, 'DURABILITY_UNSUPPORTED', options);
  }
}

class VerifiedSourceMismatchError extends DurabilityError {
  constructor(message, options) {
    super(message, 'VERIFIED_SOURCE_MISMATCH', options);
  }
}

class VerifiedSourceTopologyError extends DurabilityError {
  constructor(message, options) {
    super(message, 'VERIFIED_SOURCE_TOPOLOGY_CHANGED', options);
  }
}

class InstallTargetExistsError extends DurabilityError {
  constructor(message, options) {
    super(message, 'INSTALL_TARGET_EXISTS', options);
  }
}

class VerifiedInstallError extends DurabilityError {
  constructor(message, options) {
    super(message, 'VERIFIED_INSTALL_FAILED', options);
  }
}

const errors = {
  InstallTargetExistsError,
  LeaseBusyError,
  LeaseLostError,
  TargetLockedError,
  DurabilityUnsupportedError,
  VerifiedInstallError,
  VerifiedSourceMismatchError,
  VerifiedSourceTopologyError,
  attachCleanupError,
};

let backend;
let backendLoadError;
let cachedCapabilities;
let cachedDiagnostics;

function unsupportedOperation() {
  throw new DurabilityUnsupportedError(
    `Unable to load the ${process.platform} durability backend`,
    { cause: backendLoadError },
  );
}

function getBackend() {
  if (backend) return backend;
  try {
    backend = process.platform === 'win32'
      ? require('./durability-win32').createWin32Backend(errors)
      : require('./durability-posix').createPosixBackend(errors);
  } catch (error) {
    backendLoadError = error;
    backend = {
      backend: process.platform === 'win32' ? 'win32' : 'posix',
      acquireExistingFileRangeLease: unsupportedOperation,
      acquireExclusiveLease: unsupportedOperation,
      createAssetVerified: unsupportedOperation,
      deleteVerified: unsupportedOperation,
      enumerateDirectoryVerified: unsupportedOperation,
      fsyncFile: unsupportedOperation,
      fsyncDirectory: unsupportedOperation,
      inspectPath: unsupportedOperation,
      installAbsentFromVerifiedSource: unsupportedOperation,
      readVerified: unsupportedOperation,
      relocateVerifiedToAbsent: unsupportedOperation,
      rename: unsupportedOperation,
    };
  }
  return backend;
}

function acquireExclusiveLease(lockPath) {
  return getBackend().acquireExclusiveLease(lockPath);
}

function snapshotCanonicalIdentity(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'dev,ino'
    || typeof value.dev !== 'string'
    || !/^(0|[1-9]\d*)$/.test(value.dev)
    || typeof value.ino !== 'string'
    || !/^(0|[1-9]\d*)$/.test(value.ino)
  ) {
    throw new VerifiedSourceMismatchError(
      `${label} must contain exact canonical decimal dev and ino strings`,
    );
  }
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function acquireExistingFileRangeLease(filePath, options) {
  if (
    typeof filePath !== 'string'
    || filePath.length === 0
    || filePath.includes('\0')
    || !path.isAbsolute(filePath)
    || path.resolve(filePath) !== filePath
  ) {
    throw new DurabilityUnsupportedError(
      'Existing-file range lease path must be one absolute normalized path',
    );
  }
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).sort().join(',') !== 'exclusive,expectedIdentity'
    || typeof options.exclusive !== 'boolean'
  ) {
    throw new TypeError('Existing-file range lease options must contain exact expectedIdentity and exclusive');
  }
  const facts = Object.freeze({
    expectedIdentity: snapshotCanonicalIdentity(
      options.expectedIdentity,
      'Existing-file range lease identity',
    ),
    exclusive: options.exclusive,
  });
  const activeBackend = getBackend();
  if (typeof activeBackend.acquireExistingFileRangeLease !== 'function') {
    return unsupportedOperation();
  }
  return activeBackend.acquireExistingFileRangeLease(filePath, facts);
}

function fsyncFile(filePath) {
  return getBackend().fsyncFile(filePath);
}

function fsyncDirectory(dirPath) {
  return getBackend().fsyncDirectory(dirPath);
}

function enumerateDirectoryVerified(dirPath, expectedIdentity) {
  const identity = snapshotVerifiedIdentity(
    expectedIdentity,
    'Enumerated directory identity',
  );
  const activeBackend = getBackend();
  if (typeof activeBackend.enumerateDirectoryVerified !== 'function') return unsupportedOperation();
  const names = activeBackend.enumerateDirectoryVerified(dirPath, identity);
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new VerifiedSourceTopologyError(
      `Verified directory enumeration returned invalid names: ${dirPath}`,
    );
  }
  return Object.freeze([...names]);
}

function installAbsentFromVerifiedSource(sourcePath, targetPath, expectedIdentity, expectedSha256) {
  if (
    expectedIdentity === null
    || typeof expectedIdentity !== 'object'
    || Array.isArray(expectedIdentity)
    || Object.keys(expectedIdentity).length !== 2
    || typeof expectedIdentity.dev !== 'string'
    || !/^\d+$/.test(expectedIdentity.dev)
    || typeof expectedIdentity.ino !== 'string'
    || !/^\d+$/.test(expectedIdentity.ino)
  ) {
    throw new VerifiedSourceMismatchError('Verified source identity must contain exact dev and ino strings');
  }
  if (typeof expectedSha256 !== 'string' || !SHA256_PATTERN.test(expectedSha256)) {
    throw new VerifiedSourceMismatchError('Verified source SHA-256 must be exactly 64 lowercase hex characters');
  }
  return getBackend().installAbsentFromVerifiedSource(
    sourcePath,
    targetPath,
    expectedIdentity,
    expectedSha256,
  );
}

function createAssetVerified(filePath, expected) {
  if (
    typeof filePath !== 'string'
    || filePath.length === 0
    || filePath.includes('\0')
    || !path.isAbsolute(filePath)
    || path.resolve(filePath) !== filePath
    || expected === null
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || Object.keys(expected).sort().join(',') !== 'byteSize,bytes,parentIdentity,sha256'
    || (!Buffer.isBuffer(expected.bytes) && !(expected.bytes instanceof Uint8Array))
    || !Number.isSafeInteger(expected.byteSize)
    || expected.byteSize < 0
    || typeof expected.sha256 !== 'string'
    || !SHA256_PATTERN.test(expected.sha256)
  ) {
    throw new TypeError('createAssetVerified input is invalid');
  }
  const bytes = Buffer.from(expected.bytes);
  if (
    bytes.length !== expected.byteSize
    || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  ) {
    throw new TypeError('createAssetVerified bytes do not match the expected facts');
  }
  const facts = Object.freeze({
    byteSize: bytes.length,
    bytes,
    parentIdentity: snapshotVerifiedIdentity(
      expected.parentIdentity,
      'Verified asset parent identity',
    ),
    sha256: expected.sha256,
  });
  const activeBackend = getBackend();
  if (typeof activeBackend.createAssetVerified !== 'function') return unsupportedOperation();
  const result = activeBackend.createAssetVerified(filePath, facts);
  if (
    result?.byteSize !== facts.byteSize
    || result.fileFsync !== true
    || result.parentFsync !== true
    || result.sha256 !== facts.sha256
  ) {
    const error = new VerifiedInstallError(`Verified asset creation disposition is uncertain: ${filePath}`);
    error.created = true;
    throw error;
  }
  let identity;
  try {
    identity = snapshotVerifiedIdentity(result.identity, 'Created asset identity');
  } catch (error) {
    error.created = true;
    throw error;
  }
  let reopened;
  try {
    reopened = readVerified(filePath, {
      byteSize: facts.byteSize,
      disposition: 'present',
      identity,
      parentIdentity: facts.parentIdentity,
      sha256: facts.sha256,
    });
  } catch (error) {
    error.created = true;
    throw error;
  }
  return Object.freeze({
    byteSize: reopened.byteSize,
    fileFsync: true,
    identity: reopened.identity,
    parentFsync: true,
    parentIdentity: facts.parentIdentity,
    sha256: reopened.sha256,
  });
}

function snapshotVerifiedIdentity(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || typeof value.dev !== 'string'
    || !/^\d+$/.test(value.dev)
    || typeof value.ino !== 'string'
    || !/^\d+$/.test(value.ino)
  ) {
    throw new VerifiedSourceMismatchError(`${label} must contain exact dev and ino strings`);
  }
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function sameIdentity(left, right) {
  return (
    left !== null
    && typeof left === 'object'
    && right !== null
    && typeof right === 'object'
    && left.dev === right.dev
    && left.ino === right.ino
  );
}

function snapshotVerifiedReadFacts(expected) {
  if (
    expected !== null
    && typeof expected === 'object'
    && !Array.isArray(expected)
    && Object.keys(expected).sort().join(',') === 'disposition,parentIdentity'
    && expected.disposition === 'absent'
  ) {
    return Object.freeze({
      disposition: 'absent',
      parentIdentity: snapshotVerifiedIdentity(
        expected.parentIdentity,
        'Verified source parent identity',
      ),
    });
  }
  if (
    expected === null
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || Object.keys(expected).sort().join(',') !== 'byteSize,disposition,identity,parentIdentity,sha256'
    || expected.disposition !== 'present'
    || !Number.isSafeInteger(expected.byteSize)
    || expected.byteSize < 0
    || typeof expected.sha256 !== 'string'
    || !SHA256_PATTERN.test(expected.sha256)
  ) {
    throw new VerifiedSourceMismatchError(
      'Verified read facts must contain exact byteSize, identity, parentIdentity, and SHA-256',
    );
  }
  return Object.freeze({
    byteSize: expected.byteSize,
    disposition: 'present',
    identity: snapshotVerifiedIdentity(expected.identity, 'Verified source identity'),
    parentIdentity: snapshotVerifiedIdentity(
      expected.parentIdentity,
      'Verified source parent identity',
    ),
    sha256: expected.sha256,
  });
}

function readVerified(filePath, expected) {
  const facts = snapshotVerifiedReadFacts(expected);
  const activeBackend = getBackend();
  if (typeof activeBackend.readVerified !== 'function') return unsupportedOperation();
  const result = activeBackend.readVerified(filePath, facts);
  if (facts.disposition === 'absent') {
    if (result?.disposition !== 'ABSENT') {
      throw new VerifiedSourceMismatchError(`Unable to prove verified source absence: ${filePath}`);
    }
    return Object.freeze({ disposition: 'ABSENT' });
  }
  let resultBytes;
  try {
    if (!Buffer.isBuffer(result?.bytes) && !(result?.bytes instanceof Uint8Array)) {
      throw new TypeError('verified read bytes are invalid');
    }
    resultBytes = Buffer.from(result.bytes);
  } catch (cause) {
    throw new VerifiedSourceMismatchError(
      `Verified source read result is invalid: ${filePath}`,
      { cause },
    );
  }
  if (
    result?.byteSize !== facts.byteSize
    || resultBytes.length !== facts.byteSize
    || result.sha256 !== facts.sha256
    || crypto.createHash('sha256').update(resultBytes).digest('hex') !== facts.sha256
    || !sameIdentity(result.identity, facts.identity)
  ) {
    throw new VerifiedSourceMismatchError(
      `Verified source result no longer matches the expected facts: ${filePath}`,
    );
  }
  return Object.freeze({
    byteSize: facts.byteSize,
    bytes: resultBytes,
    disposition: 'PRESENT',
    identity: facts.identity,
    parentIdentity: facts.parentIdentity,
    sha256: facts.sha256,
  });
}

function inspectPath(targetPath) {
  const activeBackend = getBackend();
  if (typeof activeBackend.inspectPath !== 'function') return unsupportedOperation();
  return activeBackend.inspectPath(targetPath);
}

function readObserved(filePath, expected) {
  if (
    expected === null
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || Object.keys(expected).sort().join(',') !== 'byteSize,identity,parentIdentity'
    || !Number.isSafeInteger(expected.byteSize)
    || expected.byteSize < 0
  ) {
    throw new VerifiedSourceMismatchError(
      'Observed read facts must contain exact byteSize, identity, and parentIdentity',
    );
  }
  const facts = Object.freeze({
    byteSize: expected.byteSize,
    identity: snapshotVerifiedIdentity(expected.identity, 'Observed source identity'),
    parentIdentity: snapshotVerifiedIdentity(
      expected.parentIdentity,
      'Observed source parent identity',
    ),
    sha256: null,
  });
  const activeBackend = getBackend();
  if (typeof activeBackend.readVerified !== 'function') return unsupportedOperation();
  const result = activeBackend.readVerified(filePath, facts);
  if (result?.byteSize !== facts.byteSize) {
    throw new VerifiedSourceMismatchError(
      `Observed source length no longer matches the expected facts: ${filePath}`,
    );
  }
  return Object.freeze({
    byteSize: result.byteSize,
    bytes: Buffer.from(result.bytes),
    identity: Object.freeze({ ...result.identity }),
    parentIdentity: facts.parentIdentity,
    sha256: result.sha256,
  });
}

function relocateVerifiedToAbsent(sourcePath, targetPath, expected) {
  if (
    expected === null
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || Object.keys(expected).sort().join(',')
      !== 'byteSize,identity,sha256,sourceParentIdentity,targetParentIdentity'
    || !Number.isSafeInteger(expected.byteSize)
    || expected.byteSize < 0
    || typeof expected.sha256 !== 'string'
    || !SHA256_PATTERN.test(expected.sha256)
  ) {
    throw new VerifiedSourceMismatchError('Verified relocation facts are invalid');
  }
  const facts = Object.freeze({
    byteSize: expected.byteSize,
    identity: snapshotVerifiedIdentity(expected.identity, 'Verified relocation identity'),
    sha256: expected.sha256,
    sourceParentIdentity: snapshotVerifiedIdentity(
      expected.sourceParentIdentity,
      'Verified source parent identity',
    ),
    targetParentIdentity: snapshotVerifiedIdentity(
      expected.targetParentIdentity,
      'Verified target parent identity',
    ),
  });
  const sourceParent = path.dirname(sourcePath);
  const targetParent = path.dirname(targetPath);
  const sourceParentBefore = inspectPath(sourceParent);
  const targetParentBefore = inspectPath(targetParent);
  if (
    !sameIdentity(sourceParentBefore.identity, facts.sourceParentIdentity)
    || !sameIdentity(targetParentBefore.identity, facts.targetParentIdentity)
    || facts.identity.dev !== facts.sourceParentIdentity.dev
    || facts.identity.dev !== facts.targetParentIdentity.dev
  ) {
    throw new VerifiedSourceTopologyError(
      `Verified relocation parents are not one physical volume: ${sourcePath} -> ${targetPath}`,
    );
  }
  const activeBackend = getBackend();
  if (typeof activeBackend.relocateVerifiedToAbsent !== 'function') return unsupportedOperation();
  const result = retryTargetLock(
    () => activeBackend.relocateVerifiedToAbsent(sourcePath, targetPath, facts),
    'Verified relocation source',
    sourcePath,
  );
  if (
    result?.byteSize !== facts.byteSize
    || result.relocated !== true
    || result.sha256 !== facts.sha256
    || !sameIdentity(result.identity, facts.identity)
    || result.sourceParentFsync !== true
    || result.targetParentFsync !== true
  ) {
    const error = new VerifiedSourceMismatchError(
      `Relocated source no longer matches the expected durable facts: ${targetPath}`,
    );
    error.relocated = result?.relocated === true;
    throw error;
  }
  try {
    readVerified(targetPath, {
      byteSize: facts.byteSize,
      disposition: 'present',
      identity: facts.identity,
      parentIdentity: facts.targetParentIdentity,
      sha256: facts.sha256,
    });
  } catch (error) {
    error.relocated = true;
    throw error;
  }
  return Object.freeze({
    byteSize: facts.byteSize,
    identity: facts.identity,
    relocated: true,
    sha256: facts.sha256,
    sourceParentFsync: true,
    sourceParentIdentity: facts.sourceParentIdentity,
    targetParentFsync: true,
    targetParentIdentity: facts.targetParentIdentity,
  });
}

function deleteVerified(filePath, expected) {
  if (
    expected === null
    || typeof expected !== 'object'
    || Array.isArray(expected)
    || Object.keys(expected).sort().join(',') !== 'byteSize,identity,parentIdentity,sha256'
    || !Number.isSafeInteger(expected.byteSize)
    || expected.byteSize < 0
    || typeof expected.sha256 !== 'string'
    || !SHA256_PATTERN.test(expected.sha256)
  ) {
    throw new VerifiedSourceMismatchError('Verified delete facts are invalid');
  }
  const facts = Object.freeze({
    byteSize: expected.byteSize,
    identity: snapshotVerifiedIdentity(expected.identity, 'Verified delete identity'),
    parentIdentity: snapshotVerifiedIdentity(
      expected.parentIdentity,
      'Verified delete parent identity',
    ),
    sha256: expected.sha256,
  });
  const activeBackend = getBackend();
  if (typeof activeBackend.deleteVerified !== 'function') return unsupportedOperation();
  const result = retryTargetLock(
    () => activeBackend.deleteVerified(filePath, facts),
    'Verified delete source',
    filePath,
  );
  if (result?.alreadyAbsent === true && result.deleted === false) {
    return Object.freeze({
      alreadyAbsent: true,
      deleted: false,
      parentFsync: false,
      parentIdentity: facts.parentIdentity,
    });
  }
  if (
    result?.deleted !== true
    || result.parentFsync !== true
    || !sameIdentity(result.identity, facts.identity)
  ) {
    const error = new VerifiedInstallError(`Verified delete disposition is uncertain: ${filePath}`);
    error.deleted = result?.deleted === true;
    throw error;
  }
  return Object.freeze({
    alreadyAbsent: false,
    deleted: true,
    identity: facts.identity,
    parentFsync: true,
    parentIdentity: facts.parentIdentity,
  });
}

function validateAtomicReplaceOptions(options) {
  if (options === undefined) return { attempts: 5, backoffMs: 20 };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new DurabilityUnsupportedError('atomicReplace options must be an object');
  }

  const attempts = options.attempts ?? 5;
  const backoffMs = options.backoffMs ?? 20;
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new DurabilityUnsupportedError('atomicReplace attempts must be a safe positive integer');
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new DurabilityUnsupportedError('atomicReplace backoffMs must be a finite non-negative number');
  }
  return { attempts, backoffMs };
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryTargetLock(operation, label, targetPath) {
  const { attempts, backoffMs } = validateAtomicReplaceOptions();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (
        error?.code !== 'TARGET_LOCKED'
        || error.relocated === true
        || error.deleted === true
      ) {
        throw error;
      }
      if (attempt === attempts) {
        throw new TargetLockedError(
          `${label} remained locked after ${attempts} attempts: ${targetPath}`,
          { cause: error },
        );
      }
      sleepSync(backoffMs * attempt);
    }
  }
  throw new TargetLockedError(`${label} remained locked: ${targetPath}`);
}

function atomicReplace(tempPath, targetPath, options) {
  const { attempts, backoffMs } = validateAtomicReplaceOptions(options);
  const activeBackend = getBackend();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      activeBackend.rename(tempPath, targetPath);
      return;
    } catch (error) {
      if (error.code === 'DURABILITY_UNSUPPORTED') throw error;
      if (!RETRYABLE_RENAME_CODES.has(error.code)) {
        throw new DurabilityUnsupportedError(
          `Atomic replacement failed for ${targetPath}: ${error.message}`,
          { cause: error },
        );
      }
      if (attempt === attempts) {
        throw new TargetLockedError(
          `Atomic replacement target remained locked after ${attempts} attempts: ${targetPath}`,
          { cause: error },
        );
      }
      sleepSync(backoffMs * attempt);
    }
  }
}

function attachCleanupError(primaryError, cleanupError) {
  if (!cleanupError) return primaryError;
  primaryError.cleanupError = cleanupError;
  primaryError.secondaryErrors = [...(primaryError.secondaryErrors || []), cleanupError];
  return primaryError;
}

function probeExclusiveLease(probeDir) {
  const lockPath = path.join(probeDir, 'exclusive-lease.lock');
  let first;
  let unexpected;
  try {
    first = acquireExclusiveLease(lockPath);
    try {
      const contender = acquireExclusiveLease(lockPath);
      contender.release();
      return false;
    } catch (error) {
      if (error.code !== 'LEASE_BUSY') throw error;
    }
    first.release();
    first = null;
    const reacquired = acquireExclusiveLease(lockPath);
    try {
      return reacquired.isHeld();
    } finally {
      reacquired.release();
    }
  } catch (error) {
    unexpected = error;
    throw error;
  } finally {
    if (first?.isHeld()) {
      try {
        first.release();
      } catch (error) {
        if (unexpected) attachCleanupError(unexpected, error);
        else throw error;
      }
    }
  }
}

function probeDirectoryFsync(probeDir) {
  const filePath = path.join(probeDir, 'fsync-probe.bin');
  fs.writeFileSync(filePath, 'probe');
  fsyncFile(filePath);
  fsyncDirectory(probeDir);
  return true;
}

function probeAtomicReplace(probeDir) {
  const candidate = path.join(probeDir, 'atomic-candidate.bin');
  const target = path.join(probeDir, 'atomic-target.bin');
  fs.writeFileSync(candidate, 'candidate');
  fs.writeFileSync(target, 'target');
  atomicReplace(candidate, target);
  return !fs.existsSync(candidate) && fs.readFileSync(target, 'utf8') === 'candidate';
}

function probeVerifiedAbsentInstall(probeDir) {
  const source = path.join(probeDir, 'verified-install-source.bin');
  const target = path.join(probeDir, 'verified-install-target.bin');
  fs.writeFileSync(source, 'verified-install-probe');
  const sourceStats = fs.lstatSync(source, { bigint: true });
  const expectedIdentity = {
    dev: String(sourceStats.dev),
    ino: String(sourceStats.ino),
  };
  const expectedSha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const result = installAbsentFromVerifiedSource(source, target, expectedIdentity, expectedSha256);
  const targetStats = fs.lstatSync(target, { bigint: true });
  return (
    result?.installed === true
    && result.sourceDisposition === 'moved'
    && !fs.existsSync(source)
    && String(targetStats.dev) === expectedIdentity.dev
    && String(targetStats.ino) === expectedIdentity.ino
    && fs.readFileSync(target, 'utf8') === 'verified-install-probe'
  );
}

function runProbe(name, probe, diagnostics) {
  try {
    return probe();
  } catch (error) {
    diagnostics[name] = error;
    return false;
  }
}

function detectCapabilities() {
  if (cachedCapabilities) return cachedCapabilities;

  const activeBackend = getBackend();
  let dataDir;
  let probeDir;
  try {
    ({ dataDir } = require('../db').getStoragePaths());
    fs.mkdirSync(dataDir, { recursive: true });
    probeDir = fs.mkdtempSync(path.join(dataDir, '.durability-probe-'));
  } catch (error) {
    throw new DurabilityUnsupportedError(
      `Unable to create durability probe${dataDir ? ` under ${dataDir}` : ''}`,
      { cause: error },
    );
  }
  const diagnostics = {};
  let cleanupError;
  let capabilities;

  try {
    capabilities = {
      backend: activeBackend.backend,
      exclusiveLease: runProbe(
        'exclusiveLease',
        () => probeExclusiveLease(probeDir),
        diagnostics,
      ),
      directoryFsync: runProbe(
        'directoryFsync',
        () => probeDirectoryFsync(probeDir),
        diagnostics,
      ),
      atomicReplace: runProbe(
        'atomicReplace',
        () => probeAtomicReplace(probeDir),
        diagnostics,
      ),
      verifiedAbsentInstall: runProbe(
        'verifiedAbsentInstall',
        () => probeVerifiedAbsentInstall(probeDir),
        diagnostics,
      ),
    };
  } finally {
    try {
      fs.rmSync(probeDir, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }

  if (cleanupError) {
    const primaryError = Object.values(diagnostics)[0];
    const error = new DurabilityUnsupportedError(
      `Durability probe cleanup failed under ${dataDir}`,
      { cause: primaryError || cleanupError },
    );
    error.diagnostics = diagnostics;
    if (primaryError) attachCleanupError(error, cleanupError);
    throw error;
  }

  cachedDiagnostics = diagnostics;
  cachedCapabilities = Object.freeze(capabilities);
  return cachedCapabilities;
}

function assertDurabilitySupported(capabilities = detectCapabilities()) {
  const required = ['exclusiveLease', 'directoryFsync', 'atomicReplace'];
  const missing = required.filter((capability) => capabilities[capability] !== true);
  if (missing.length === 0) return capabilities;

  const diagnosticText = missing
    .map((capability) => cachedDiagnostics?.[capability]?.message)
    .filter(Boolean)
    .join('; ');
  throw new DurabilityUnsupportedError(
    `Durability backend ${capabilities.backend} is missing required capabilities: ${missing.join(', ')}`
      + (diagnosticText ? ` (${diagnosticText})` : ''),
    { cause: missing.map((capability) => cachedDiagnostics?.[capability]).find(Boolean) },
  );
}

module.exports = {
  DurabilityUnsupportedError,
  InstallTargetExistsError,
  LeaseBusyError,
  LeaseLostError,
  TargetLockedError,
  VerifiedInstallError,
  VerifiedSourceMismatchError,
  VerifiedSourceTopologyError,
  acquireExistingFileRangeLease,
  acquireExclusiveLease,
  assertDurabilitySupported,
  atomicReplace,
  createAssetVerified,
  detectCapabilities,
  deleteVerified,
  enumerateDirectoryVerified,
  fsyncDirectory,
  fsyncFile,
  inspectPath,
  installAbsentFromVerifiedSource,
  readObserved,
  readVerified,
  relocateVerifiedToAbsent,
};
