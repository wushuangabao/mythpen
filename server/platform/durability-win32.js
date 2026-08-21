const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path').win32;

const GENERIC_READ_WRITE = 0xc0000000;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const DELETE_ACCESS = 0x00010000;
const FILE_READ_ATTRIBUTES = 0x00000080;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_READ_WRITE = 0x00000003;
const FILE_SHARE_ALL = 0x00000007;
const OPEN_EXISTING = 3;
const OPEN_ALWAYS = 4;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_RENAME_INFO_CLASS = 3;
const FILE_DISPOSITION_INFO_CLASS = 4;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
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
  'TARGET_LOCKED',
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
  TargetLockedError,
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
  const realpathSync = dependencies.realpathSync || fs.realpathSync.native;

  function targetLockedError(operation, targetPath, win32Code) {
    if (win32Code !== ERROR_SHARING_VIOLATION) return undefined;
    return new TargetLockedError(`${operation} is locked: ${targetPath}`, {
      cause: nativeCause(operation, win32Code),
    });
  }

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

  function verifiedRealPath(targetPath, label, ErrorType) {
    let actualPath;
    try {
      actualPath = realpathSync(targetPath);
    } catch (cause) {
      throw new ErrorType(`Unable to verify the real name of ${label}: ${targetPath}`, { cause });
    }
    if (path.basename(actualPath) !== path.basename(targetPath)) {
      throw new ErrorType(`Verified real name changed for ${label}: ${targetPath}`);
    }
    return actualPath;
  }

  function verifyFileRealName(filePath, parentPath) {
    const parentRealPath = verifiedRealPath(
      parentPath,
      'source parent',
      VerifiedSourceTopologyError,
    );
    const fileRealPath = verifiedRealPath(filePath, 'source file', VerifiedSourceMismatchError);
    if (path.dirname(fileRealPath).toLowerCase() !== parentRealPath.toLowerCase()) {
      throw new VerifiedSourceTopologyError(
        `Verified source no longer belongs to the expected parent: ${filePath}`,
      );
    }
    return fileRealPath;
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
    if (handle === undefined || isInvalid(handle)) return undefined;
    try {
      if (k32.CloseHandle(handle) !== 0) return undefined;
      return nativeCause('CloseHandle', k32.GetLastError());
    } catch (error) {
      return error;
    }
  }

  function flushPinnedParent(handle, parentPath) {
    let flushed;
    try {
      flushed = k32.FlushFileBuffers(handle);
    } catch (cause) {
      throw new VerifiedInstallError(`Unable to flush the pinned parent: ${parentPath}`, { cause });
    }
    if (flushed === 0) {
      throw new VerifiedInstallError(`Unable to flush the pinned parent: ${parentPath}`, {
        cause: nativeCause('FlushFileBuffers', k32.GetLastError()),
      });
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
    const byteSize = (
      (BigInt(information.bytes.readUInt32LE(32)) << 32n)
      | BigInt(information.bytes.readUInt32LE(36))
    );
    return {
      attributes: information.bytes.readUInt32LE(0),
      byteSize,
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

  function verifyDirectoryHandle(handle, expectedIdentity, directoryPath) {
    const actual = handleIdentity(handle);
    if (
      actual.dev !== expectedIdentity.dev
      || actual.ino !== expectedIdentity.ino
      || (actual.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0
      || (actual.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
    ) {
      throw new VerifiedSourceTopologyError(
        `Verified destination parent no longer identifies one plain directory: ${directoryPath}`,
      );
    }
    return actual;
  }

  function verifyDirectoryPathStillNamesHandle(directoryPath, expectedIdentity, pinnedHandle) {
    const pinnedIdentity = verifyDirectoryHandle(
      pinnedHandle,
      expectedIdentity,
      directoryPath,
    );
    const reopened = openHandle(
      directoryPath,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ_WRITE,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    );
    if (isInvalid(reopened.handle)) {
      throw new VerifiedSourceTopologyError(
        `Verified directory path no longer names the pinned directory: ${directoryPath}`,
        { cause: nativeCause('CreateFileW', reopened.win32Code) },
      );
    }
    let primaryError;
    try {
      const pathIdentity = verifyDirectoryHandle(
        reopened.handle,
        expectedIdentity,
        directoryPath,
      );
      if (
        pathIdentity.dev !== pinnedIdentity.dev
        || pathIdentity.ino !== pinnedIdentity.ino
      ) {
        throw new VerifiedSourceTopologyError(
          `Verified directory path changed during enumeration: ${directoryPath}`,
        );
      }
      verifiedRealPath(
        directoryPath,
        'enumerated directory',
        VerifiedSourceTopologyError,
      );
    } catch (error) {
      primaryError = error?.code === 'VERIFIED_SOURCE_TOPOLOGY_CHANGED'
        ? error
        : new VerifiedSourceTopologyError(
          `Unable to bind the verified directory path to its pinned handle: ${directoryPath}`,
          { cause: error },
        );
    }
    const cleanupError = closeHandle(reopened.handle);
    if (primaryError) throw attachCleanupError(primaryError, cleanupError);
    if (cleanupError) {
      throw new VerifiedSourceTopologyError(
        `Verified directory path handle could not be closed: ${directoryPath}`,
        { cause: cleanupError },
      );
    }
  }

  function inspectDirectoryHandle(handle, directoryPath) {
    const actual = handleIdentity(handle);
    if (
      (actual.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0
      || (actual.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
    ) {
      throw new VerifiedSourceTopologyError(
        `Pinned parent no longer identifies one plain directory: ${directoryPath}`,
      );
    }
    return actual;
  }

  function inspectPath(targetPath) {
    const absoluteTarget = absolutePath(targetPath);
    const namespacedTarget = path.toNamespacedPath(absoluteTarget);
    const absoluteParent = path.dirname(absoluteTarget);
    const namespacedParent = path.toNamespacedPath(absoluteParent);
    let openedParent;
    let openedTarget;
    let primaryError;
    let result;
    try {
      openedParent = openHandle(
        namespacedParent,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedParent.handle)) {
        throw new VerifiedSourceTopologyError(`Unable to open the pinned parent: ${absoluteParent}`, {
          cause: nativeCause('CreateFileW', openedParent.win32Code),
        });
      }
      const parentBefore = inspectDirectoryHandle(openedParent.handle, absoluteParent);
      openedTarget = openHandle(
        namespacedTarget,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedTarget.handle)) {
        throw new VerifiedSourceMismatchError(`Unable to open the pinned path: ${absoluteTarget}`, {
          cause: nativeCause('CreateFileW', openedTarget.win32Code),
        });
      }
      const targetBefore = handleIdentity(openedTarget.handle);
      const realPath = fs.realpathSync.native(absoluteTarget);
      const parentRealPath = fs.realpathSync.native(absoluteParent);
      const targetAfter = handleIdentity(openedTarget.handle);
      const parentAfter = inspectDirectoryHandle(openedParent.handle, absoluteParent);
      if (
        targetAfter.dev !== targetBefore.dev
        || targetAfter.ino !== targetBefore.ino
        || targetAfter.attributes !== targetBefore.attributes
        || targetAfter.links !== targetBefore.links
        || targetAfter.byteSize !== targetBefore.byteSize
        || parentAfter.dev !== parentBefore.dev
        || parentAfter.ino !== parentBefore.ino
      ) {
        throw new VerifiedSourceTopologyError(`Pinned path changed during inspection: ${absoluteTarget}`);
      }
      if (targetAfter.byteSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new VerifiedSourceMismatchError(`Pinned path is too large to inspect: ${absoluteTarget}`);
      }
      const directory = (targetAfter.attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0;
      result = {
        actualName: path.basename(realPath),
        byteSize: Number(targetAfter.byteSize),
        identity: { dev: targetAfter.dev, ino: targetAfter.ino },
        kind: directory ? 'directory' : 'file',
        linkCount: directory ? null : targetAfter.links,
        parentIdentity: { dev: parentAfter.dev, ino: parentAfter.ino },
        parentRealPath,
        realPath,
        reparse: (targetAfter.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
      };
    } catch (error) {
      primaryError = ['VERIFIED_SOURCE_MISMATCH', 'VERIFIED_SOURCE_TOPOLOGY_CHANGED']
        .includes(error?.code)
        ? error
        : new VerifiedSourceMismatchError(`Unable to inspect pinned path: ${absoluteTarget}`, {
          cause: error,
        });
    }
    const targetCleanup = openedTarget === undefined || isInvalid(openedTarget.handle)
      ? undefined
      : closeHandle(openedTarget.handle);
    const parentCleanup = openedParent === undefined || isInvalid(openedParent.handle)
      ? undefined
      : closeHandle(openedParent.handle);
    if (primaryError) {
      throw attachCleanupError(attachCleanupError(primaryError, targetCleanup), parentCleanup);
    }
    if (targetCleanup || parentCleanup) {
      throw new VerifiedSourceTopologyError(
        `Pinned inspection handles could not be closed: ${absoluteTarget}`,
        { cause: targetCleanup || parentCleanup },
      );
    }
    return result;
  }

  function enumerateDirectoryVerified(directoryPath, expectedIdentity) {
    const absoluteDirectory = absolutePath(directoryPath);
    const namespacedDirectory = path.toNamespacedPath(absoluteDirectory);
    let opened;
    let primaryError;
    let names;
    try {
      opened = openHandle(
        namespacedDirectory,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(opened.handle)) {
        throw new VerifiedSourceTopologyError(
          `Unable to open the verified directory for enumeration: ${absoluteDirectory}`,
          { cause: nativeCause('CreateFileW', opened.win32Code) },
        );
      }
      verifyDirectoryHandle(opened.handle, expectedIdentity, absoluteDirectory);
      verifiedRealPath(
        namespacedDirectory,
        'enumerated directory',
        VerifiedSourceTopologyError,
      );
      names = fs.readdirSync(absoluteDirectory, { encoding: 'utf8' });
      verifyDirectoryPathStillNamesHandle(
        namespacedDirectory,
        expectedIdentity,
        opened.handle,
      );
    } catch (error) {
      primaryError = error?.code === 'VERIFIED_SOURCE_TOPOLOGY_CHANGED'
        ? error
        : new VerifiedSourceTopologyError(
          `Unable to enumerate the verified directory: ${absoluteDirectory}`,
          { cause: error },
        );
    }
    const cleanupError = closeHandle(opened?.handle);
    if (primaryError) throw attachCleanupError(primaryError, cleanupError);
    if (cleanupError) {
      throw new VerifiedSourceTopologyError(
        `Verified enumeration handle could not be closed: ${absoluteDirectory}`,
        { cause: cleanupError },
      );
    }
    return names;
  }

  function readHandle(handle, sourcePath) {
    const hash = crypto.createHash('sha256');
    const chunk = alignedBytes(READ_CHUNK_SIZE);
    const bytesRead = alignedBytes(Uint32Array.BYTES_PER_ELEMENT);
    const chunks = [];
    let byteSize = 0;
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
      const bytes = Buffer.from(chunk.bytes.subarray(0, count));
      chunks.push(bytes);
      byteSize += count;
      hash.update(bytes);
    }
    return {
      bytes: Buffer.concat(chunks, byteSize),
      sha256: hash.digest('hex'),
    };
  }

  function hashHandle(handle, sourcePath) {
    return readHandle(handle, sourcePath).sha256;
  }

  function readAbsentVerified(sourcePath, expected) {
    if (
      expected.parentIdentity === null
      || typeof expected.parentIdentity !== 'object'
      || typeof expected.parentIdentity.dev !== 'string'
      || !/^\d+$/.test(expected.parentIdentity.dev)
      || typeof expected.parentIdentity.ino !== 'string'
      || !/^\d+$/.test(expected.parentIdentity.ino)
    ) {
      throw new VerifiedSourceMismatchError('Verified absence requires exact parent identity facts');
    }
    const source = path.toNamespacedPath(absolutePath(sourcePath));
    const parent = path.dirname(source);
    let openedParent;
    let openedSource;
    let primaryError;
    let absent = false;
    try {
      openedParent = openHandle(
        parent,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedParent.handle)) {
        const locked = targetLockedError('CreateFileW', parent, openedParent.win32Code);
        if (locked) throw locked;
        throw new VerifiedSourceTopologyError(`Unable to open the verified source parent: ${parent}`, {
          cause: nativeCause('CreateFileW', openedParent.win32Code),
        });
      }
      verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
      verifiedRealPath(parent, 'source parent', VerifiedSourceTopologyError);
      openedSource = openHandle(
        source,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (!isInvalid(openedSource.handle)) {
        throw new VerifiedSourceMismatchError(`Verified absent source is present: ${source}`);
      }
      if (![ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND].includes(openedSource.win32Code)) {
        const locked = targetLockedError('CreateFileW', source, openedSource.win32Code);
        if (locked) throw locked;
        throw new VerifiedSourceMismatchError(`Unable to prove verified source absence: ${source}`, {
          cause: nativeCause('CreateFileW', openedSource.win32Code),
        });
      }
      verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
      absent = true;
    } catch (error) {
      primaryError = ['TARGET_LOCKED', 'VERIFIED_SOURCE_MISMATCH', 'VERIFIED_SOURCE_TOPOLOGY_CHANGED']
        .includes(error?.code)
        ? error
        : new VerifiedSourceMismatchError(`Unable to prove verified source absence: ${source}`, {
          cause: error,
        });
    }
    const sourceCleanup = openedSource === undefined || isInvalid(openedSource.handle)
      ? undefined
      : closeHandle(openedSource.handle);
    const parentCleanup = closeHandle(openedParent?.handle);
    if (primaryError) {
      throw attachCleanupError(attachCleanupError(primaryError, sourceCleanup), parentCleanup);
    }
    if (sourceCleanup || parentCleanup) {
      throw new VerifiedSourceTopologyError(
        `Verified absence handles could not be closed: ${source}`,
        { cause: sourceCleanup || parentCleanup },
      );
    }
    if (!absent) throw new VerifiedSourceMismatchError(`Unable to prove absence: ${source}`);
    return { disposition: 'ABSENT' };
  }

  function readVerified(sourcePath, expected) {
    if (expected?.disposition === 'absent') return readAbsentVerified(sourcePath, expected);
    if (
      expected === null
      || typeof expected !== 'object'
      || Array.isArray(expected)
      || expected.identity === null
      || typeof expected.identity !== 'object'
      || typeof expected.identity.dev !== 'string'
      || !/^\d+$/.test(expected.identity.dev)
      || typeof expected.identity.ino !== 'string'
      || !/^\d+$/.test(expected.identity.ino)
      || (
        expected.byteSize !== undefined
        && (!Number.isSafeInteger(expected.byteSize) || expected.byteSize < 0)
      )
      || (
        expected.parentIdentity !== undefined
        && (
          expected.parentIdentity === null
          || typeof expected.parentIdentity !== 'object'
          || typeof expected.parentIdentity.dev !== 'string'
          || !/^\d+$/.test(expected.parentIdentity.dev)
          || typeof expected.parentIdentity.ino !== 'string'
          || !/^\d+$/.test(expected.parentIdentity.ino)
        )
      )
      || (
        expected.sha256 !== null
        && (typeof expected.sha256 !== 'string' || !SHA256_PATTERN.test(expected.sha256))
      )
    ) {
      throw new VerifiedSourceMismatchError('Verified read requires exact identity and SHA-256 facts');
    }
    const source = path.toNamespacedPath(absolutePath(sourcePath));
    const parent = path.dirname(source);
    let openedParent;
    let opened;
    try {
      if (expected.parentIdentity !== undefined) {
        openedParent = openHandle(
          parent,
          FILE_READ_ATTRIBUTES,
          FILE_SHARE_READ_WRITE,
          OPEN_EXISTING,
          FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        );
        if (isInvalid(openedParent.handle)) {
          const locked = targetLockedError('CreateFileW', parent, openedParent.win32Code);
          if (locked) throw locked;
          throw new VerifiedSourceTopologyError(
            `Unable to open the verified source parent: ${parent}`,
            { cause: nativeCause('CreateFileW', openedParent.win32Code) },
          );
        }
        verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
      }
      opened = openHandle(
        source,
        (GENERIC_READ | FILE_READ_ATTRIBUTES) >>> 0,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
    } catch (error) {
      const sourceCleanup = closeHandle(opened?.handle);
      const parentCleanup = closeHandle(openedParent?.handle);
      let stableError = ['TARGET_LOCKED', 'VERIFIED_SOURCE_MISMATCH', 'VERIFIED_SOURCE_TOPOLOGY_CHANGED']
        .includes(error?.code)
        ? error
        : new VerifiedSourceMismatchError(`Unable to open the verified source: ${source}`, {
          cause: error,
        });
      stableError = attachCleanupError(stableError, sourceCleanup);
      throw attachCleanupError(stableError, parentCleanup);
    }
    if (isInvalid(opened.handle)) {
      const error = targetLockedError('CreateFileW', source, opened.win32Code)
        || new VerifiedSourceMismatchError(`Unable to open the verified source: ${source}`, {
          cause: nativeCause('CreateFileW', opened.win32Code),
        });
      throw attachCleanupError(error, closeHandle(openedParent?.handle));
    }

    let primaryError;
    let result;
    try {
      const before = verifyHandleAdmission(opened.handle, expected.identity, source);
      verifyFileRealName(source, parent);
      const read = readHandle(opened.handle, source);
      const after = verifyHandleAdmission(opened.handle, expected.identity, source);
      verifyFileRealName(source, parent);
      if (expected.parentIdentity !== undefined) {
        verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
      }
      if (
        (expected.sha256 !== null && read.sha256 !== expected.sha256)
        || BigInt(read.bytes.length) !== before.byteSize
        || after.byteSize !== before.byteSize
      ) {
        throw new VerifiedSourceMismatchError(
          `Verified source bytes no longer match the expected facts: ${source}`,
        );
      }
      result = {
        byteSize: read.bytes.length,
        bytes: read.bytes,
        identity: { dev: after.dev, ino: after.ino },
        sha256: read.sha256,
      };
    } catch (error) {
      primaryError = ['VERIFIED_SOURCE_MISMATCH', 'VERIFIED_SOURCE_TOPOLOGY_CHANGED']
        .includes(error?.code)
        ? error
        : new VerifiedSourceMismatchError(`Unable to read verified source: ${source}`, {
          cause: error,
        });
    }
    const sourceCleanup = closeHandle(opened.handle);
    const parentCleanup = closeHandle(openedParent?.handle);
    if (primaryError) {
      throw attachCleanupError(attachCleanupError(primaryError, sourceCleanup), parentCleanup);
    }
    if (sourceCleanup || parentCleanup) {
      throw new VerifiedSourceMismatchError(`Verified source handle could not be closed: ${source}`, {
        cause: sourceCleanup || parentCleanup,
      });
    }
    return result;
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
    const locked = targetLockedError('SetFileInformationByHandle', targetPath, win32Code);
    if (locked) throw locked;
    throw new VerifiedInstallError(`Unable to install verified source at absent target: ${targetPath}`, {
      cause,
    });
  }

  function createAssetVerified(assetPath, expected) {
    if (
      expected === null
      || typeof expected !== 'object'
      || Array.isArray(expected)
      || !Number.isSafeInteger(expected.byteSize)
      || expected.byteSize < 0
      || (!Buffer.isBuffer(expected.bytes) && !(expected.bytes instanceof Uint8Array))
      || expected.parentIdentity === null
      || typeof expected.parentIdentity !== 'object'
      || typeof expected.parentIdentity.dev !== 'string'
      || !/^\d+$/.test(expected.parentIdentity.dev)
      || typeof expected.parentIdentity.ino !== 'string'
      || !/^\d+$/.test(expected.parentIdentity.ino)
      || typeof expected.sha256 !== 'string'
      || !SHA256_PATTERN.test(expected.sha256)
    ) {
      throw new VerifiedSourceMismatchError('Verified asset creation facts are invalid');
    }
    const bytes = Buffer.from(expected.bytes);
    if (
      bytes.length !== expected.byteSize
      || crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256
    ) {
      throw new VerifiedSourceMismatchError('Verified asset bytes do not match their expected facts');
    }
    const asset = path.toNamespacedPath(absolutePath(assetPath));
    const parent = path.dirname(asset);
    let openedParent;
    let fd;
    let created = false;
    let primaryError;
    let identity;
    try {
      openedParent = openHandle(
        parent,
        GENERIC_READ_WRITE,
        FILE_SHARE_READ_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedParent.handle)) {
        throw new VerifiedSourceTopologyError(`Unable to open the verified asset parent: ${parent}`, {
          cause: nativeCause('CreateFileW', openedParent.win32Code),
        });
      }
      verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
      verifiedRealPath(parent, 'asset parent', VerifiedSourceTopologyError);
      try {
        fd = fs.openSync(
          asset,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
          0o600,
        );
        created = true;
      } catch (cause) {
        if (cause?.code === 'EEXIST') {
          throw new InstallTargetExistsError(`Verified asset target already exists: ${asset}`, {
            cause,
          });
        }
        throw cause;
      }
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(fd, bytes, written, bytes.length - written, null);
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw new Error('verified asset write made no progress');
        }
        written += count;
      }
      fs.fsyncSync(fd);
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(bytes.length)) {
        throw new Error('verified asset is not one plain exact-length file');
      }
      const readback = Buffer.alloc(bytes.length);
      let read = 0;
      while (read < readback.length) {
        const count = fs.readSync(fd, readback, read, readback.length - read, read);
        if (!Number.isSafeInteger(count) || count <= 0) {
          throw new Error('verified asset readback ended early');
        }
        read += count;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (
        after.dev !== before.dev
        || after.ino !== before.ino
        || after.nlink !== 1n
        || after.size !== before.size
        || !readback.equals(bytes)
        || crypto.createHash('sha256').update(readback).digest('hex') !== expected.sha256
      ) {
        throw new Error('verified asset readback facts changed');
      }
      identity = { dev: String(after.dev), ino: String(after.ino) };
      verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
      verifiedRealPath(parent, 'asset parent', VerifiedSourceTopologyError);
      flushPinnedParent(openedParent.handle, parent);
      verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
    } catch (error) {
      primaryError = VERIFIED_INSTALL_ERROR_CODES.has(error?.code)
        ? error
        : new VerifiedInstallError(`Unable to create verified asset: ${asset}`, { cause: error });
      if (created) primaryError.created = true;
    }
    let fileCleanup;
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        fileCleanup = error;
      }
    }
    const parentCleanup = closeHandle(openedParent?.handle);
    if (primaryError) {
      throw attachCleanupError(attachCleanupError(primaryError, fileCleanup), parentCleanup);
    }
    if (fileCleanup || parentCleanup) {
      const error = new VerifiedInstallError(
        `Verified asset was created but a pinned handle could not be closed: ${asset}`,
        { cause: fileCleanup || parentCleanup },
      );
      error.created = true;
      if (fileCleanup && parentCleanup) attachCleanupError(error, parentCleanup);
      throw error;
    }
    return {
      byteSize: bytes.length,
      fileFsync: true,
      identity,
      parentFsync: true,
      sha256: expected.sha256,
    };
  }

  function relocateVerifiedToAbsent(sourcePath, targetPath, expected) {
    if (
      expected === null
      || typeof expected !== 'object'
      || Array.isArray(expected)
      || expected.identity === null
      || typeof expected.identity !== 'object'
      || typeof expected.identity.dev !== 'string'
      || !/^\d+$/.test(expected.identity.dev)
      || typeof expected.identity.ino !== 'string'
      || !/^\d+$/.test(expected.identity.ino)
      || !Number.isSafeInteger(expected.byteSize)
      || expected.byteSize < 0
      || expected.sourceParentIdentity === null
      || typeof expected.sourceParentIdentity !== 'object'
      || typeof expected.sourceParentIdentity.dev !== 'string'
      || !/^\d+$/.test(expected.sourceParentIdentity.dev)
      || typeof expected.sourceParentIdentity.ino !== 'string'
      || !/^\d+$/.test(expected.sourceParentIdentity.ino)
      || expected.targetParentIdentity === null
      || typeof expected.targetParentIdentity !== 'object'
      || typeof expected.targetParentIdentity.dev !== 'string'
      || !/^\d+$/.test(expected.targetParentIdentity.dev)
      || typeof expected.targetParentIdentity.ino !== 'string'
      || !/^\d+$/.test(expected.targetParentIdentity.ino)
      || typeof expected.sha256 !== 'string'
      || !SHA256_PATTERN.test(expected.sha256)
    ) {
      throw new VerifiedSourceMismatchError(
        'Verified relocation requires exact source, hash, and destination-parent facts',
      );
    }
    const source = path.toNamespacedPath(absolutePath(sourcePath));
    const target = path.toNamespacedPath(absolutePath(targetPath));
    if (source.toLowerCase() === target.toLowerCase()) {
      throw new DurabilityUnsupportedError('Verified relocation requires distinct paths');
    }
    const sourceParent = path.dirname(source);
    const targetParent = path.dirname(target);
    let openedParent;
    let openedSourceParent;
    let openedSource;
    try {
      openedParent = openHandle(
        targetParent,
        GENERIC_READ_WRITE,
        FILE_SHARE_READ_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedParent.handle)) {
        const locked = targetLockedError('CreateFileW', targetParent, openedParent.win32Code);
        if (locked) throw locked;
        throw new VerifiedSourceTopologyError(
          `Unable to open the verified destination parent: ${targetParent}`,
          { cause: nativeCause('CreateFileW', openedParent.win32Code) },
        );
      }
      openedSourceParent = openHandle(
        sourceParent,
        GENERIC_READ_WRITE,
        FILE_SHARE_READ_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedSourceParent.handle)) {
        const locked = targetLockedError(
          'CreateFileW',
          sourceParent,
          openedSourceParent.win32Code,
        );
        if (locked) throw locked;
        throw new VerifiedSourceTopologyError(
          `Unable to open the verified source parent: ${sourceParent}`,
          { cause: nativeCause('CreateFileW', openedSourceParent.win32Code) },
        );
      }
      openedSource = openHandle(
        source,
        (GENERIC_READ | DELETE_ACCESS | FILE_READ_ATTRIBUTES) >>> 0,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedSource.handle)) {
        const locked = targetLockedError('CreateFileW', source, openedSource.win32Code);
        if (locked) throw locked;
        throw new VerifiedSourceMismatchError(`Unable to open the verified source: ${source}`, {
          cause: nativeCause('CreateFileW', openedSource.win32Code),
        });
      }
    } catch (error) {
      const sourceCleanup = closeHandle(openedSource?.handle);
      const sourceParentCleanup = closeHandle(openedSourceParent?.handle);
      const parentCleanup = closeHandle(openedParent?.handle);
      let stableError = ['TARGET_LOCKED', 'VERIFIED_SOURCE_MISMATCH', 'VERIFIED_SOURCE_TOPOLOGY_CHANGED']
        .includes(error?.code)
        ? error
        : new VerifiedInstallError(`Unable to open verified relocation: ${source}`, { cause: error });
      stableError = attachCleanupError(stableError, sourceCleanup);
      stableError = attachCleanupError(stableError, sourceParentCleanup);
      throw attachCleanupError(stableError, parentCleanup);
    }

    let primaryError;
    let relocated = false;
    let result;
    try {
      const parentBefore = verifyDirectoryHandle(
        openedParent.handle,
        expected.targetParentIdentity,
        targetParent,
      );
      const sourceBefore = verifyHandleAdmission(openedSource.handle, expected.identity, source);
      const sourceParentBefore = verifyDirectoryHandle(
        openedSourceParent.handle,
        expected.sourceParentIdentity,
        sourceParent,
      );
      if (parentBefore.dev !== sourceBefore.dev) {
        throw new VerifiedSourceTopologyError(
          `Verified relocation crosses physical volumes: ${source} -> ${target}`,
        );
      }
      if (sourceParentBefore.dev !== sourceBefore.dev) {
        throw new VerifiedSourceTopologyError(
          `Verified source parent is on another physical volume: ${source}`,
        );
      }
      verifyFileRealName(source, sourceParent);
      const read = readHandle(openedSource.handle, source);
      if (
        read.sha256 !== expected.sha256
        || BigInt(read.bytes.length) !== sourceBefore.byteSize
        || read.bytes.length !== expected.byteSize
      ) {
        throw new VerifiedSourceMismatchError(
          `Verified source bytes no longer match the expected facts: ${source}`,
        );
      }
      verifyHandleAdmission(openedSource.handle, expected.identity, source);
      verifyDirectoryHandle(openedParent.handle, expected.targetParentIdentity, targetParent);
      verifyDirectoryHandle(
        openedSourceParent.handle,
        expected.sourceParentIdentity,
        sourceParent,
      );
      verifyFileRealName(source, sourceParent);
      installByHandle(openedSource.handle, target);
      relocated = true;
      const sourceAfter = verifyHandleAdmission(openedSource.handle, expected.identity, target);
      verifyFileRealName(target, targetParent);
      verifyDirectoryHandle(openedParent.handle, expected.targetParentIdentity, targetParent);
      verifyDirectoryHandle(
        openedSourceParent.handle,
        expected.sourceParentIdentity,
        sourceParent,
      );
      flushPinnedParent(openedSourceParent.handle, sourceParent);
      flushPinnedParent(openedParent.handle, targetParent);
      verifyDirectoryHandle(
        openedSourceParent.handle,
        expected.sourceParentIdentity,
        sourceParent,
      );
      verifyDirectoryHandle(openedParent.handle, expected.targetParentIdentity, targetParent);
      result = {
        byteSize: read.bytes.length,
        identity: { dev: sourceAfter.dev, ino: sourceAfter.ino },
        relocated: true,
        sha256: read.sha256,
        sourceParentFsync: true,
        targetParentFsync: true,
      };
    } catch (error) {
      primaryError = VERIFIED_INSTALL_ERROR_CODES.has(error?.code)
        ? error
        : new VerifiedInstallError(`Unable to relocate verified source: ${source}`, { cause: error });
      if (relocated) primaryError.relocated = true;
    }
    const sourceCleanup = closeHandle(openedSource.handle);
    const sourceParentCleanup = closeHandle(openedSourceParent?.handle);
    const parentCleanup = closeHandle(openedParent.handle);
    if (primaryError) {
      throw attachCleanupError(
        attachCleanupError(
          attachCleanupError(primaryError, sourceCleanup),
          sourceParentCleanup,
        ),
        parentCleanup,
      );
    }
    if (sourceCleanup || sourceParentCleanup || parentCleanup) {
      const error = new VerifiedInstallError(
        `Verified source was relocated but a pinned handle could not be closed: ${target}`,
        { cause: sourceCleanup || sourceParentCleanup || parentCleanup },
      );
      error.relocated = true;
      if (sourceCleanup && sourceParentCleanup) attachCleanupError(error, sourceParentCleanup);
      if ((sourceCleanup || sourceParentCleanup) && parentCleanup) {
        attachCleanupError(error, parentCleanup);
      }
      throw error;
    }
    return result;
  }

  function deleteVerified(sourcePath, expected) {
    if (
      expected === null
      || typeof expected !== 'object'
      || Array.isArray(expected)
      || expected.identity === null
      || typeof expected.identity !== 'object'
      || typeof expected.identity.dev !== 'string'
      || !/^\d+$/.test(expected.identity.dev)
      || typeof expected.identity.ino !== 'string'
      || !/^\d+$/.test(expected.identity.ino)
      || expected.parentIdentity === null
      || typeof expected.parentIdentity !== 'object'
      || typeof expected.parentIdentity.dev !== 'string'
      || !/^\d+$/.test(expected.parentIdentity.dev)
      || typeof expected.parentIdentity.ino !== 'string'
      || !/^\d+$/.test(expected.parentIdentity.ino)
      || !Number.isSafeInteger(expected.byteSize)
      || expected.byteSize < 0
      || typeof expected.sha256 !== 'string'
      || !SHA256_PATTERN.test(expected.sha256)
    ) {
      throw new VerifiedSourceMismatchError(
        'Verified delete requires exact source, hash, and parent facts',
      );
    }
    const source = path.toNamespacedPath(absolutePath(sourcePath));
    const parent = path.dirname(source);
    let openedParent;
    let openedSource;
    let parentBefore;
    try {
      openedParent = openHandle(
        parent,
        GENERIC_READ_WRITE,
        FILE_SHARE_READ_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedParent.handle)) {
        const locked = targetLockedError('CreateFileW', parent, openedParent.win32Code);
        if (locked) throw locked;
        throw new VerifiedSourceTopologyError(`Unable to open the verified source parent: ${parent}`, {
          cause: nativeCause('CreateFileW', openedParent.win32Code),
        });
      }
      parentBefore = verifyDirectoryHandle(
        openedParent.handle,
        expected.parentIdentity,
        parent,
      );
      openedSource = openHandle(
        source,
        (GENERIC_READ | DELETE_ACCESS | FILE_READ_ATTRIBUTES) >>> 0,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
      if (isInvalid(openedSource.handle)) {
        if ([ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND].includes(openedSource.win32Code)) {
          const parentAfter = verifyDirectoryHandle(
            openedParent.handle,
            expected.parentIdentity,
            parent,
          );
          if (parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) {
            throw new VerifiedSourceTopologyError(
              `Verified source parent changed while proving absence: ${parent}`,
            );
          }
          const cleanupError = closeHandle(openedParent.handle);
          openedParent = undefined;
          if (cleanupError) {
            throw new VerifiedSourceTopologyError(
              `Unable to close the parent handle after proving absence: ${parent}`,
              { cause: cleanupError },
            );
          }
          return { alreadyAbsent: true, deleted: false };
        }
        const locked = targetLockedError('CreateFileW', source, openedSource.win32Code);
        if (locked) throw locked;
        throw new VerifiedSourceMismatchError(`Unable to open the verified source: ${source}`, {
          cause: nativeCause('CreateFileW', openedSource.win32Code),
        });
      }
    } catch (error) {
      const sourceCleanup = closeHandle(openedSource?.handle);
      const parentCleanup = closeHandle(openedParent?.handle);
      let stableError = ['TARGET_LOCKED', 'VERIFIED_SOURCE_MISMATCH', 'VERIFIED_SOURCE_TOPOLOGY_CHANGED']
        .includes(error?.code)
        ? error
        : new VerifiedInstallError(`Unable to open verified delete: ${source}`, { cause: error });
      stableError = attachCleanupError(stableError, sourceCleanup);
      throw attachCleanupError(stableError, parentCleanup);
    }

    let primaryError;
    let deleted = false;
    try {
      const sourceBefore = verifyHandleAdmission(openedSource.handle, expected.identity, source);
      if (parentBefore.dev !== sourceBefore.dev) {
        throw new VerifiedSourceTopologyError(
          `Verified source parent is on another physical volume: ${source}`,
        );
      }
      verifyFileRealName(source, parent);
      const read = readHandle(openedSource.handle, source);
      if (
        read.sha256 !== expected.sha256
        || BigInt(read.bytes.length) !== sourceBefore.byteSize
        || read.bytes.length !== expected.byteSize
      ) {
        throw new VerifiedSourceMismatchError(
          `Verified source bytes no longer match the expected facts: ${source}`,
        );
      }
      verifyHandleAdmission(openedSource.handle, expected.identity, source);
      verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
      verifyFileRealName(source, parent);
      const disposition = alignedBytes(1);
      disposition.bytes.writeUInt8(1, 0);
      if (k32.SetFileInformationByHandle(
        openedSource.handle,
        FILE_DISPOSITION_INFO_CLASS,
        pointerOf(disposition.bytes),
        disposition.bytes.byteLength,
      ) === 0) {
        const win32Code = k32.GetLastError();
        const locked = targetLockedError('SetFileInformationByHandle', source, win32Code);
        if (locked) throw locked;
        throw new VerifiedInstallError(`Unable to delete verified source: ${source}`, {
          cause: nativeCause('SetFileInformationByHandle', win32Code),
        });
      }
      deleted = true;
    } catch (error) {
      primaryError = VERIFIED_INSTALL_ERROR_CODES.has(error?.code)
        ? error
        : new VerifiedInstallError(`Unable to delete verified source: ${source}`, { cause: error });
      if (deleted) primaryError.deleted = true;
    }
    const sourceCleanup = closeHandle(openedSource.handle);
    if (primaryError) {
      const parentCleanup = closeHandle(openedParent.handle);
      throw attachCleanupError(attachCleanupError(primaryError, sourceCleanup), parentCleanup);
    }
    if (sourceCleanup) {
      const error = new VerifiedInstallError(
        `Verified source was deleted but its handle could not be closed: ${source}`,
        { cause: sourceCleanup },
      );
      error.deleted = true;
      throw attachCleanupError(error, closeHandle(openedParent.handle));
    }
    try {
      flushPinnedParent(openedParent.handle, parent);
      verifyDirectoryHandle(openedParent.handle, expected.parentIdentity, parent);
    } catch (error) {
      primaryError = VERIFIED_INSTALL_ERROR_CODES.has(error?.code)
        ? error
        : new VerifiedInstallError(`Unable to flush verified delete parent: ${parent}`, {
          cause: error,
        });
      primaryError.deleted = true;
    }
    const parentCleanup = closeHandle(openedParent.handle);
    if (primaryError) throw attachCleanupError(primaryError, parentCleanup);
    if (parentCleanup) {
      const error = new VerifiedInstallError(
        `Verified source was deleted but its parent handle could not be closed: ${parent}`,
        { cause: parentCleanup },
      );
      error.deleted = true;
      throw error;
    }
    return {
      alreadyAbsent: false,
      deleted: true,
      identity: { ...expected.identity },
      parentFsync: true,
    };
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
    createAssetVerified,
    fsyncFile(filePath) {
      flushPath(filePath, FILE_ATTRIBUTE_NORMAL);
    },
    fsyncDirectory(dirPath) {
      flushPath(dirPath, FILE_FLAG_BACKUP_SEMANTICS);
    },
    enumerateDirectoryVerified,
    inspectPath,
    installAbsentFromVerifiedSource,
    deleteVerified,
    readVerified,
    relocateVerifiedToAbsent,
    rename(tempPath, targetPath) {
      fs.renameSync(tempPath, targetPath);
    },
  };
}

module.exports = { createWin32Backend };
