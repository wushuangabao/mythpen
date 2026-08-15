const fs = require('node:fs');
const os = require('node:os');

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let libc;

function loadLibc() {
  if (libc) return libc;
  const { dlopen, FFIType, read } = require('bun:ffi');
  const libraryName = process.platform === 'darwin'
    ? '/usr/lib/libSystem.B.dylib'
    : process.platform === 'freebsd'
      ? 'libc.so.7'
      : 'libc.so.6';
  const errnoAccessor = process.platform === 'darwin' || process.platform === 'freebsd'
    ? '__error'
    : '__errno_location';
  const library = dlopen(libraryName, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    [errnoAccessor]: { args: [], returns: FFIType.ptr },
  });
  libc = {
    library,
    symbols: library.symbols,
    readErrno: () => read.i32(library.symbols[errnoAccessor]()),
  };
  return libc;
}

function errnoCause(operation, errnoValue, errnoConstants) {
  const errnoName = Object.entries(errnoConstants)
    .find(([, value]) => value === errnoValue)?.[0];
  const error = new Error(
    `${operation} failed with errno ${errnoValue}${errnoName ? ` (${errnoName})` : ''}`,
  );
  error.errno = errnoValue;
  if (errnoName) error.code = errnoName;
  error.syscall = operation;
  return error;
}

function createPosixBackend({
  DurabilityUnsupportedError,
  LeaseBusyError,
  LeaseLostError,
  attachCleanupError,
}, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  const getLibc = dependencies.loadLibc || loadLibc;
  const readErrno = dependencies.readErrno || ((loadedLibc) => loadedLibc.readErrno());
  const errnoConstants = dependencies.errnoConstants || os.constants.errno;
  const busyErrnos = new Set([
    errnoConstants.EAGAIN,
    errnoConstants.EWOULDBLOCK,
  ].filter(Number.isInteger));

  function closeFd(fd) {
    if (fd === undefined) return undefined;
    try {
      fsApi.closeSync(fd);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  function flockFailure(operation, loadedLibc) {
    const errnoValue = Number(readErrno(loadedLibc));
    return errnoCause(operation, errnoValue, errnoConstants);
  }

  function acquireExclusiveLease(lockPath) {
    let fd;
    try {
      fd = fsApi.openSync(lockPath, fsApi.constants.O_CREAT | fsApi.constants.O_RDWR, 0o600);
      const loadedLibc = getLibc();
      const result = loadedLibc.symbols.flock(fd, LOCK_EX | LOCK_NB);
      if (result !== 0) {
        const cause = flockFailure('flock', loadedLibc);
        if (busyErrnos.has(cause.errno)) {
          throw new LeaseBusyError(`Exclusive lease is already held: ${lockPath}`, { cause });
        }
        throw new DurabilityUnsupportedError(`Exclusive lease is unsupported: ${lockPath}`, { cause });
      }
    } catch (error) {
      const cleanupError = closeFd(fd);
      const stableError = ['LEASE_BUSY', 'DURABILITY_UNSUPPORTED'].includes(error.code)
        ? error
        : new DurabilityUnsupportedError(`Unable to acquire an exclusive lease: ${lockPath}`, {
          cause: error,
        });
      throw attachCleanupError(stableError, cleanupError);
    }

    let held = true;
    return {
      release() {
        if (!held) throw new LeaseLostError(`Exclusive lease is no longer held: ${lockPath}`);
        held = false;
        let primaryError;
        try {
          const loadedLibc = getLibc();
          const unlockResult = loadedLibc.symbols.flock(fd, LOCK_UN);
          if (unlockResult !== 0) {
            primaryError = new LeaseLostError(`Unable to unlock exclusive lease: ${lockPath}`, {
              cause: flockFailure('flock', loadedLibc),
            });
          }
        } catch (error) {
          primaryError = error.code === 'LEASE_LOST'
            ? error
            : new LeaseLostError(`Unable to unlock exclusive lease: ${lockPath}`, { cause: error });
        }
        const cleanupError = closeFd(fd);
        if (primaryError) throw attachCleanupError(primaryError, cleanupError);
        if (cleanupError) {
          throw new LeaseLostError(`Unable to close exclusive lease: ${lockPath}`, {
            cause: cleanupError,
          });
        }
      },
      isHeld() {
        return held;
      },
    };
  }

  function fsyncOpenedPath(filePath, flags) {
    let fd;
    let primaryError;
    try {
      fd = fsApi.openSync(filePath, flags);
      fsApi.fsyncSync(fd);
    } catch (error) {
      primaryError = error;
    }
    const cleanupError = closeFd(fd);
    if (primaryError || cleanupError) {
      const stableError = new DurabilityUnsupportedError(`Unable to durably flush path: ${filePath}`, {
        cause: primaryError || cleanupError,
      });
      if (primaryError && cleanupError) {
        attachCleanupError(stableError, cleanupError);
      }
      throw stableError;
    }
  }

  return {
    backend: 'posix',
    acquireExclusiveLease,
    fsyncFile(filePath) {
      fsyncOpenedPath(filePath, fsApi.constants.O_RDONLY);
    },
    fsyncDirectory(dirPath) {
      fsyncOpenedPath(dirPath, fsApi.constants.O_RDONLY);
    },
    installAbsentFromVerifiedSource(sourcePath, targetPath) {
      throw new DurabilityUnsupportedError(
        `Verified absent installation is unsupported on ${process.platform}: ${sourcePath} -> ${targetPath}`,
      );
    },
    rename(tempPath, targetPath) {
      fsApi.renameSync(tempPath, targetPath);
    },
  };
}

module.exports = { createPosixBackend };
