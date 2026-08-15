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
      acquireExclusiveLease: unsupportedOperation,
      fsyncFile: unsupportedOperation,
      fsyncDirectory: unsupportedOperation,
      installAbsentFromVerifiedSource: unsupportedOperation,
      rename: unsupportedOperation,
    };
  }
  return backend;
}

function acquireExclusiveLease(lockPath) {
  return getBackend().acquireExclusiveLease(lockPath);
}

function fsyncFile(filePath) {
  return getBackend().fsyncFile(filePath);
}

function fsyncDirectory(dirPath) {
  return getBackend().fsyncDirectory(dirPath);
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
  acquireExclusiveLease,
  assertDurabilitySupported,
  atomicReplace,
  detectCapabilities,
  fsyncDirectory,
  fsyncFile,
  installAbsentFromVerifiedSource,
};
