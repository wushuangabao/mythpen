const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path').win32;

const GENERIC_READ_WRITE = 0xc0000000;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE_ACCESS = 0x00010000;
const FILE_READ_ATTRIBUTES = 0x00000080;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_ALL = 0x00000007;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_RENAME_INFO_CLASS = 3;
const ERROR_FILE_EXISTS = 80;
const ERROR_ALREADY_EXISTS = 183;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_HANDLE_EOF = 38;
const INVALID_HANDLE = 0xffffffffffffffffn;
const BY_HANDLE_FILE_INFORMATION_SIZE = 52;
const FILE_RENAME_INFO_HEADER_SIZE = 20;
const READ_CHUNK_SIZE = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIED_INSTALL_ERROR_CODES = new Set([
  'INSTALL_TARGET_EXISTS',
  'VERIFIED_INSTALL_FAILED',
  'VERIFIED_SOURCE_MISMATCH',
  'VERIFIED_SOURCE_TOPOLOGY_CHANGED',
]);

function nativeCause(operation, win32Code) {
  const error = new Error(`${operation} failed with Win32 error ${win32Code}`);
  error.win32Code = win32Code;
  return error;
}

function createWin32Backend({
  DurabilityUnsupportedError,
  InstallTargetExistsError,
  LeaseBusyError,
  LeaseLostError,
  VerifiedInstallError,
  VerifiedSourceMismatchError,
  VerifiedSourceTopologyError,
  attachCleanupError,
}, dependencies = {}) {
  let library = dependencies.library;
  let k32 = dependencies.kernel32;
  let pointerOf = dependencies.ptr;
  if (!k32) {
    const { dlopen, FFIType, ptr } = require('bun:ffi');
    library = dlopen('kernel32.dll', {
      CreateFileW: {
        args: [
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
          FFIType.u32,
          FFIType.u32,
          FFIType.ptr,
        ],
        returns: FFIType.u64,
      },
      GetFileInformationByHandle: {
        args: [FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      ReadFile: {
        args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      SetFileInformationByHandle: {
        args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      FlushFileBuffers: { args: [FFIType.u64], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    k32 = library.symbols;
    pointerOf = ptr;
  }
  pointerOf ||= (value) => value;

  function alignedBytes(byteLength) {
    const storage = new BigUint64Array(Math.ceil(byteLength / BigUint64Array.BYTES_PER_ELEMENT));
    return {
      bytes: Buffer.from(storage.buffer, storage.byteOffset, byteLength),
      storage,
    };
  }

  function wideString(value) {
    const encoded = Buffer.from(`${value}\0`, 'utf16le');
    const allocation = alignedBytes(encoded.byteLength);
    encoded.copy(allocation.bytes);
    return allocation;
  }

  function absolutePath(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new DurabilityUnsupportedError('Verified install paths must be non-empty strings');
    }
    return path.resolve(filePath);
  }

  function verifiedSiblingPaths(sourcePath, targetPath) {
    const absoluteSource = absolutePath(sourcePath);
    const absoluteTarget = absolutePath(targetPath);
    const sourceKey = absoluteSource.toLowerCase();
    const targetKey = absoluteTarget.toLowerCase();
    if (
      sourceKey === targetKey
      || path.dirname(absoluteSource).toLowerCase() !== path.dirname(absoluteTarget).toLowerCase()
    ) {
      throw new DurabilityUnsupportedError(
        'Verified absent install requires distinct sibling source and target paths',
      );
    }
    const needsNamespace = absoluteSource.length >= 248 || absoluteTarget.length >= 248;
    const source = needsNamespace ? path.toNamespacedPath(absoluteSource) : absoluteSource;
    const target = needsNamespace ? path.toNamespacedPath(absoluteTarget) : absoluteTarget;
    return { source, target };
  }

  function isInvalid(handle) {
    return BigInt.asUintN(64, BigInt(handle)) === INVALID_HANDLE;
  }

  function openHandle(filePath, desiredAccess, shareMode, creationDisposition, flags) {
    const widePath = wideString(filePath);
    const handle = k32.CreateFileW(
      pointerOf(widePath.bytes),
      desiredAccess,
      shareMode,
      0,
      creationDisposition,
      flags,
      0,
    );
    if (!isInvalid(handle)) return { handle, widePath };
    return { handle, widePath, win32Code: k32.GetLastError() };
  }

  function closeHandle(handle) {
    if (handle === undefined) return undefined;
    try {
      if (k32.CloseHandle(handle) !== 0) return undefined;
      return nativeCause('CloseHandle', k32.GetLastError());
    } catch (error) {
      return error;
    }
  }

  function handleIdentity(handle) {
    const information = alignedBytes(BY_HANDLE_FILE_INFORMATION_SIZE);
    if (k32.GetFileInformationByHandle(handle, pointerOf(information.bytes)) === 0) {
      throw new VerifiedSourceMismatchError('Unable to verify the physical source handle', {
        cause: nativeCause('GetFileInformationByHandle', k32.GetLastError()),
      });
    }
    const fileIndex = (
      (BigInt(information.bytes.readUInt32LE(44)) << 32n)
      | BigInt(information.bytes.readUInt32LE(48))
    );
    return {
      attributes: information.bytes.readUInt32LE(0),
      dev: String(information.bytes.readUInt32LE(28)),
      ino: String(fileIndex),
      links: information.bytes.readUInt32LE(40),
    };
  }

  function verifyHandleAdmission(handle, expectedIdentity, sourcePath) {
    const actual = handleIdentity(handle);
    if (
      actual.dev !== expectedIdentity.dev
      || actual.ino !== expectedIdentity.ino
      || actual.links !== 1
      || (actual.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) !== 0
    ) {
      throw new VerifiedSourceMismatchError(
        `Verified source no longer identifies one plain file: ${sourcePath}`,
      );
    }
    return actual;
  }

  function hashHandle(handle, sourcePath) {
    const hash = crypto.createHash('sha256');
    const chunk = alignedBytes(READ_CHUNK_SIZE);
    const bytesRead = alignedBytes(Uint32Array.BYTES_PER_ELEMENT);
    while (true) {
      bytesRead.bytes.writeUInt32LE(0, 0);
      let readResult;
      try {
        readResult = k32.ReadFile(
          handle,
          pointerOf(chunk.bytes),
          chunk.bytes.byteLength,
          pointerOf(bytesRead.bytes),
          0,
        );
      } catch (cause) {
        throw new VerifiedSourceMismatchError(
          `Unable to hash the verified source handle: ${sourcePath}`,
          { cause },
        );
      }
      if (readResult === 0) {
        const win32Code = k32.GetLastError();
        if (win32Code === ERROR_HANDLE_EOF) break;
        throw new VerifiedSourceMismatchError(
          `Unable to hash the verified source handle: ${sourcePath}`,
          { cause: nativeCause('ReadFile', win32Code) },
        );
      }
      const count = bytesRead.bytes.readUInt32LE(0);
      if (count === 0) break;
      if (count > chunk.bytes.byteLength) {
        throw new VerifiedSourceMismatchError(
          `ReadFile returned an invalid byte count for the verified source: ${sourcePath}`,
        );
      }
      hash.update(chunk.bytes.subarray(0, count));
    }
    return hash.digest('hex');
  }

  function installByHandle(handle, targetPath) {
    const targetName = wideString(targetPath);
    const fileNameLength = targetName.bytes.byteLength - Uint16Array.BYTES_PER_ELEMENT;
    const information = alignedBytes(FILE_RENAME_INFO_HEADER_SIZE + targetName.bytes.byteLength);
    information.bytes.writeUInt32LE(0, 0);
    information.bytes.writeBigUInt64LE(0n, 8);
    information.bytes.writeUInt32LE(fileNameLength, 16);
    targetName.bytes.copy(information.bytes, FILE_RENAME_INFO_HEADER_SIZE);
    if (k32.SetFileInformationByHandle(
      handle,
      FILE_RENAME_INFO_CLASS,
      pointerOf(information.bytes),
      information.bytes.byteLength,
    ) !== 0) {
      return;
    }
    const win32Code = k32.GetLastError();
    const cause = nativeCause('SetFileInformationByHandle', win32Code);
    if (win32Code === ERROR_FILE_EXISTS || win32Code === ERROR_ALREADY_EXISTS) {
      throw new InstallTargetExistsError(`Verified install target already exists: ${targetPath}`, {
        cause,
      });
    }
    throw new VerifiedInstallError(`Unable to install verified source at absent target: ${targetPath}`, {
      cause,
    });
  }

  function installAbsentFromVerifiedSource(
    sourcePath,
    targetPath,
    expectedIdentity,
    expectedSha256,
  ) {
    if (typeof expectedSha256 !== 'string' || !SHA256_PATTERN.test(expectedSha256)) {
      throw new VerifiedSourceMismatchError(
        'Verified source SHA-256 must be exactly 64 lowercase hex characters',
      );
    }
    const { source, target } = verifiedSiblingPaths(sourcePath, targetPath);
    let opened;
    try {
      opened = openHandle(
        source,
        (GENERIC_READ | DELETE_ACCESS | FILE_READ_ATTRIBUTES) >>> 0,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
    } catch (cause) {
      throw new VerifiedSourceMismatchError(`Unable to open the verified source: ${source}`, {
        cause,
      });
    }
    if (isInvalid(opened.handle)) {
      throw new VerifiedSourceMismatchError(`Unable to open the verified source: ${source}`, {
        cause: nativeCause('CreateFileW', opened.win32Code),
      });
    }

    let primaryError;
    let installed = false;
    try {
      verifyHandleAdmission(opened.handle, expectedIdentity, source);
      const actualSha256 = hashHandle(opened.handle, source);
      if (actualSha256 !== expectedSha256) {
        throw new VerifiedSourceMismatchError(
          `Verified source bytes no longer match the expected SHA-256: ${source}`,
        );
      }
      verifyHandleAdmission(opened.handle, expectedIdentity, source);
      installByHandle(opened.handle, target);
      installed = true;

      try {
        verifyHandleAdmission(opened.handle, expectedIdentity, target);
      } catch (cause) {
        const topologyError = new VerifiedSourceTopologyError(
          `Verified source topology changed during installation: ${target}`,
          { cause },
        );
        try {
          installByHandle(opened.handle, source);
          installed = false;
          topologyError.installed = false;
        } catch (rollbackError) {
          topologyError.installed = true;
          topologyError.rollbackError = rollbackError;
          topologyError.secondaryErrors = [rollbackError];
        }
        throw topologyError;
      }
    } catch (error) {
      primaryError = VERIFIED_INSTALL_ERROR_CODES.has(error?.code)
        ? error
        : new VerifiedInstallError(`Unable to install verified source: ${source}`, { cause: error });
      if (installed && primaryError.installed === undefined) primaryError.installed = true;
    }

    const cleanupError = closeHandle(opened.handle);
    if (primaryError) throw attachCleanupError(primaryError, cleanupError);
    if (cleanupError) {
      const error = new VerifiedInstallError(
        `Verified source was installed but its handle could not be closed: ${target}`,
        { cause: cleanupError },
      );
      error.installed = installed;
      throw error;
    }
    return { installed: true, sourceDisposition: 'moved' };
  }

  function acquireExclusiveLease(lockPath) {
    const opened = openHandle(
      lockPath,
      GENERIC_READ_WRITE,
      0,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
    );
    if (isInvalid(opened.handle)) {
      const cause = nativeCause('CreateFileW', opened.win32Code);
      if (opened.win32Code === ERROR_SHARING_VIOLATION) {
        throw new LeaseBusyError(`Exclusive lease is already held: ${lockPath}`, { cause });
      }
      throw new DurabilityUnsupportedError(`Unable to acquire an exclusive lease: ${lockPath}`, { cause });
    }

    let held = true;
    return {
      release() {
        if (!held) throw new LeaseLostError(`Exclusive lease is no longer held: ${lockPath}`);
        held = false;
        if (k32.CloseHandle(opened.handle) === 0) {
          const win32Code = k32.GetLastError();
          throw new LeaseLostError(`Unable to release exclusive lease: ${lockPath}`, {
            cause: nativeCause('CloseHandle', win32Code),
          });
        }
      },
      isHeld() {
        return held;
      },
    };
  }

  function flushPath(filePath, flags) {
    const namespacedPath = path.toNamespacedPath(absolutePath(filePath));
    const opened = openHandle(
      namespacedPath,
      GENERIC_WRITE,
      FILE_SHARE_ALL,
      OPEN_EXISTING,
      flags,
    );
    if (isInvalid(opened.handle)) {
      throw new DurabilityUnsupportedError(`Unable to open path for durable flush: ${filePath}`, {
        cause: nativeCause('CreateFileW', opened.win32Code),
      });
    }

    let flushError;
    if (k32.FlushFileBuffers(opened.handle) === 0) {
      flushError = nativeCause('FlushFileBuffers', k32.GetLastError());
    }
    let closeError;
    if (k32.CloseHandle(opened.handle) === 0) {
      closeError = nativeCause('CloseHandle', k32.GetLastError());
    }
    if (flushError || closeError) {
      throw new DurabilityUnsupportedError(`Unable to durably flush path: ${filePath}`, {
        cause: flushError || closeError,
      });
    }
  }

  return {
    backend: 'win32',
    acquireExclusiveLease,
    fsyncFile(filePath) {
      flushPath(filePath, FILE_ATTRIBUTE_NORMAL);
    },
    fsyncDirectory(dirPath) {
      flushPath(dirPath, FILE_FLAG_BACKUP_SEMANTICS);
    },
    installAbsentFromVerifiedSource,
    rename(tempPath, targetPath) {
      fs.renameSync(tempPath, targetPath);
    },
  };
}

module.exports = { createWin32Backend };
