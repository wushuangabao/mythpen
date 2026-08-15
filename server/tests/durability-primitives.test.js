const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

const {
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
} = require('../platform/durability');
const { createPosixBackend } = require('../platform/durability-posix');
const { createWin32Backend } = require('../platform/durability-win32');

const durabilityErrors = {
  DurabilityUnsupportedError,
  InstallTargetExistsError,
  LeaseBusyError,
  LeaseLostError,
  TargetLockedError,
  VerifiedInstallError,
  VerifiedSourceMismatchError,
  VerifiedSourceTopologyError,
  attachCleanupError(primaryError, cleanupError) {
    if (!cleanupError) return primaryError;
    primaryError.cleanupError = cleanupError;
    primaryError.secondaryErrors = [...(primaryError.secondaryErrors || []), cleanupError];
    return primaryError;
  },
};

function fileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const VERIFIED_SOURCE_BYTES = Buffer.from('verified journal artifact');
const VERIFIED_SOURCE_SHA256 = sha256(VERIFIED_SOURCE_BYTES);

function readableKernel32(overrides, bytes = VERIFIED_SOURCE_BYTES) {
  let offset = 0;
  return {
    ReadFile(handle, output, requested, bytesRead) {
      const count = Math.min(requested, bytes.length - offset);
      bytes.copy(output, 0, offset, offset + count);
      bytesRead.writeUInt32LE(count, 0);
      offset += count;
      return 1;
    },
    ...overrides,
  };
}

function writeWin32FileInformation(buffer, {
  attributes = 0x00000020,
  dev,
  ino,
  links = 1,
}) {
  const fileId = BigInt(ino);
  buffer.writeUInt32LE(attributes, 0);
  buffer.writeUInt32LE(Number(BigInt(dev)), 28);
  buffer.writeUInt32LE(links, 40);
  buffer.writeUInt32LE(Number((fileId >> 32n) & 0xffffffffn), 44);
  buffer.writeUInt32LE(Number(fileId & 0xffffffffn), 48);
}

function decodeWideString(buffer) {
  return buffer.toString('utf16le').replace(/\0+$/, '');
}

function loadNativeKernel32ForTest() {
  const { dlopen, FFIType, ptr } = require('bun:ffi');
  const library = dlopen('kernel32.dll', {
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
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  return { library, ptr, symbols: library.symbols };
}

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function waitForLine(child, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child output ${JSON.stringify(expected)}; got ${JSON.stringify(output)}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      if (output.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Lease holder exited before acquiring: code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for lease holder to exit'));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function loadFreshDurability() {
  const modulePath = require.resolve('../platform/durability');
  delete require.cache[modulePath];
  return require(modulePath);
}

function createInjectedPosixBackend({
  attachCleanupError = durabilityErrors.attachCleanupError,
  errnoValue,
  errnoConstants = { EAGAIN: 11, EWOULDBLOCK: 35 },
  fsOverrides = {},
  flock = () => -1,
}) {
  const fsApi = {
    constants: fs.constants,
    openSync: () => 73,
    closeSync: () => {},
    fsyncSync: () => {},
    renameSync: () => {},
    ...fsOverrides,
  };
  return createPosixBackend({ ...durabilityErrors, attachCleanupError }, {
    errnoConstants,
    fsApi,
    loadLibc: () => ({ symbols: { flock } }),
    readErrno: () => errnoValue,
  });
}

test('exclusive lease rejects a second holder and can be reacquired after release', (t) => {
  const dir = createTempDir(t, 'mythpen-lease-local-');
  const lockPath = path.join(dir, 'writer.lock');
  const held = acquireExclusiveLease(lockPath);
  t.after(() => {
    if (held.isHeld()) held.release();
  });

  assert.equal(held.isHeld(), true);
  assert.throws(() => acquireExclusiveLease(lockPath), { code: 'LEASE_BUSY' });

  held.release();
  assert.equal(held.isHeld(), false);
  assert.throws(() => held.release(), { code: 'LEASE_LOST' });

  const reacquired = acquireExclusiveLease(lockPath);
  assert.equal(reacquired.isHeld(), true);
  reacquired.release();
});

test('exclusive lease crosses processes and process death releases the OS handle', async (t) => {
  const dir = createTempDir(t, 'mythpen-lease-process-');
  const lockPath = path.join(dir, 'writer.lock');
  const fixture = path.join(__dirname, 'fixtures', 'lease-holder.js');
  const child = spawn(process.execPath, [fixture, lockPath], {
    cwd: path.resolve(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForLine(child, 'acquired');
  assert.throws(() => acquireExclusiveLease(lockPath), { code: 'LEASE_BUSY' });

  assert.equal(child.kill('SIGKILL'), true);
  await waitForExit(child);
  acquireExclusiveLease(lockPath).release();
});

test('file and directory fsync complete on the active backend', (t) => {
  const dir = createTempDir(t, 'mythpen-fsync-');
  const filePath = path.join(dir, 'payload.bin');
  fs.writeFileSync(filePath, 'durable');

  fsyncFile(filePath);
  fsyncDirectory(dir);
});

test('verified absent install rejects every non-canonical expected SHA-256 before opening a path', () => {
  const identity = { dev: '1', ino: '2' };
  for (const expectedSha256 of [
    undefined,
    null,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    Buffer.alloc(32),
  ]) {
    assert.throws(
      () => installAbsentFromVerifiedSource(
        'C:\\controlled\\missing-source.db',
        'C:\\controlled\\formal.db',
        identity,
        expectedSha256,
      ),
      (error) => (
        error.code === 'VERIFIED_SOURCE_MISMATCH'
        && /64 lowercase hex/.test(error.message)
      ),
    );
  }
});

test('Win32 verified absent install uses the expected handle-bound no-clobber ABI', () => {
  const expectedIdentity = {
    dev: '305419896',
    ino: '81985529216486895',
  };
  const sourcePath = 'C:\\controlled\\source.db';
  const targetPath = 'C:\\controlled\\formal.db';
  const calls = { pointerAlignments: [] };
  let readOffset = 0;
  const kernel32 = {
    CreateFileW(source, desiredAccess, shareMode, security, disposition, flags, template) {
      calls.open = {
        source: decodeWideString(source),
        desiredAccess,
        shareMode,
        security,
        disposition,
        flags,
        template,
      };
      return 91n;
    },
    GetFileInformationByHandle(handle, information) {
      calls.informationCalls = (calls.informationCalls || 0) + 1;
      calls.information = { handle, byteLength: information.byteLength };
      writeWin32FileInformation(information, expectedIdentity);
      return 1;
    },
    ReadFile(handle, output, requested, bytesRead) {
      const count = Math.min(requested, VERIFIED_SOURCE_BYTES.length - readOffset);
      VERIFIED_SOURCE_BYTES.copy(output, 0, readOffset, readOffset + count);
      bytesRead.writeUInt32LE(count, 0);
      readOffset += count;
      calls.readCalls = (calls.readCalls || 0) + 1;
      return 1;
    },
    SetFileInformationByHandle(handle, informationClass, information, byteLength) {
      calls.install = {
        handle,
        informationClass,
        byteLength,
        replaceIfExists: information.readUInt32LE(0),
        rootDirectory: information.readBigUInt64LE(8),
        nameLength: information.readUInt32LE(16),
        target: information.subarray(20, 20 + information.readUInt32LE(16)).toString('utf16le'),
        terminator: information.readUInt16LE(20 + information.readUInt32LE(16)),
      };
      return 1;
    },
    CloseHandle(handle) {
      calls.closed = handle;
      return 1;
    },
    GetLastError() {
      return 0;
    },
  };
  const backend = createWin32Backend(durabilityErrors, {
    kernel32,
    ptr(value) {
      calls.pointerAlignments.push(value.byteOffset % BigUint64Array.BYTES_PER_ELEMENT);
      return value;
    },
  });

  assert.deepEqual(
    backend.installAbsentFromVerifiedSource(
      sourcePath,
      targetPath,
      expectedIdentity,
      VERIFIED_SOURCE_SHA256,
    ),
    { installed: true, sourceDisposition: 'moved' },
  );
  assert.deepEqual(calls.open, {
    source: sourcePath,
    desiredAccess: 0x80010080,
    shareMode: 0x00000001,
    security: 0,
    disposition: 3,
    flags: 0x00200000,
    template: 0,
  });
  assert.deepEqual(calls.information, { handle: 91n, byteLength: 52 });
  assert.equal(calls.informationCalls, 3);
  assert.equal(calls.readCalls, 2);
  assert.deepEqual(calls.install, {
    handle: 91n,
    informationClass: 3,
    byteLength: 20 + Buffer.byteLength(targetPath, 'utf16le') + 2,
    replaceIfExists: 0,
    rootDirectory: 0n,
    nameLength: Buffer.byteLength(targetPath, 'utf16le'),
    target: targetPath,
    terminator: 0,
  });
  assert.equal(calls.closed, 91n);
  assert.ok(calls.pointerAlignments.length >= 9);
  assert.ok(calls.pointerAlignments.every((alignment) => alignment === 0));
});

test('Win32 verified absent install rejects same-identity bytes that no longer match the expected hash', () => {
  const expectedIdentity = { dev: '101', ino: '103' };
  const expectedBytes = Buffer.from('expected journal artifact');
  const replacementBytes = Buffer.from('same inode, different bytes');
  let readOffset = 0;
  let installCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 97n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      ReadFile(handle, output, requested, bytesRead) {
        const count = Math.min(requested, replacementBytes.length - readOffset);
        replacementBytes.copy(output, 0, readOffset, readOffset + count);
        bytesRead.writeUInt32LE(count, 0);
        readOffset += count;
        return 1;
      },
      SetFileInformationByHandle() {
        installCalls += 1;
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      expectedIdentity,
      sha256(expectedBytes),
    ),
    { code: 'VERIFIED_SOURCE_MISMATCH' },
  );
  assert.equal(installCalls, 0);
});

test('Win32 verified absent install hashes large handles until ERROR_HANDLE_EOF', () => {
  const expectedIdentity = { dev: '127', ino: '131' };
  const bytes = Buffer.alloc((64 * 1024 * 2) + 29);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  let readOffset = 0;
  let lastError = 0;
  let installCalls = 0;
  const readCounts = [];
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 99n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      ReadFile(handle, output, requested, bytesRead) {
        if (readOffset === bytes.length) {
          lastError = 38;
          return 0;
        }
        const count = Math.min(requested, bytes.length - readOffset);
        bytes.copy(output, 0, readOffset, readOffset + count);
        bytesRead.writeUInt32LE(count, 0);
        readOffset += count;
        readCounts.push(count);
        return 1;
      },
      SetFileInformationByHandle() {
        installCalls += 1;
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
  });

  assert.deepEqual(
    backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      expectedIdentity,
      sha256(bytes),
    ),
    { installed: true, sourceDisposition: 'moved' },
  );
  assert.deepEqual(readCounts, [64 * 1024, 64 * 1024, 29]);
  assert.equal(installCalls, 1);
});

test('Win32 verified absent install preserves ReadFile as primary and close failure as secondary', () => {
  const expectedIdentity = { dev: '137', ino: '139' };
  let lastError = 0;
  let installCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 100n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      ReadFile() {
        lastError = 5;
        return 0;
      },
      SetFileInformationByHandle() {
        installCalls += 1;
        return 1;
      },
      CloseHandle() {
        lastError = 6;
        return 0;
      },
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      expectedIdentity,
      VERIFIED_SOURCE_SHA256,
    ),
    (error) => (
      error.code === 'VERIFIED_SOURCE_MISMATCH'
      && error.cause?.win32Code === 5
      && error.cleanupError?.win32Code === 6
      && error.installed !== true
    ),
  );
  assert.equal(installCalls, 0);
});

test('Win32 verified absent install restores the source when post-install topology changed', () => {
  const expectedIdentity = { dev: '107', ino: '109' };
  const bytes = Buffer.from('verified journal artifact');
  let readOffset = 0;
  let informationCalls = 0;
  const installedPaths = [];
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 98n,
      GetFileInformationByHandle(handle, information) {
        informationCalls += 1;
        writeWin32FileInformation(information, {
          ...expectedIdentity,
          links: informationCalls >= 3 ? 2 : 1,
        });
        return 1;
      },
      ReadFile(handle, output, requested, bytesRead) {
        const count = Math.min(requested, bytes.length - readOffset);
        bytes.copy(output, 0, readOffset, readOffset + count);
        bytesRead.writeUInt32LE(count, 0);
        readOffset += count;
        return 1;
      },
      SetFileInformationByHandle(handle, informationClass, information) {
        const nameLength = information.readUInt32LE(16);
        installedPaths.push(information.subarray(20, 20 + nameLength).toString('utf16le'));
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      expectedIdentity,
      sha256(bytes),
    ),
    (error) => error.code === 'VERIFIED_SOURCE_TOPOLOGY_CHANGED' && error.installed === false,
  );
  assert.deepEqual(installedPaths, [
    'C:\\controlled\\formal.db',
    'C:\\controlled\\source.db',
  ]);
});

test('Win32 verified absent install fails closed as installed when topology rollback cannot complete', () => {
  const expectedIdentity = { dev: '149', ino: '151' };
  let informationCalls = 0;
  let installCalls = 0;
  let lastError = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...readableKernel32({}),
      CreateFileW: () => 101n,
      GetFileInformationByHandle(handle, information) {
        informationCalls += 1;
        writeWin32FileInformation(information, {
          ...expectedIdentity,
          links: informationCalls >= 3 ? 2 : 1,
        });
        return 1;
      },
      SetFileInformationByHandle() {
        installCalls += 1;
        if (installCalls === 1) return 1;
        lastError = 183;
        return 0;
      },
      CloseHandle: () => 1,
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      expectedIdentity,
      VERIFIED_SOURCE_SHA256,
    ),
    (error) => (
      error.code === 'VERIFIED_SOURCE_TOPOLOGY_CHANGED'
      && error.installed === true
      && error.rollbackError?.code === 'INSTALL_TARGET_EXISTS'
      && error.secondaryErrors?.includes(error.rollbackError)
    ),
  );
  assert.equal(installCalls, 2);
});

test('Win32 verified absent install emits namespaced absolute UTF-16 paths for long UNC siblings', () => {
  const longDirectory = `\\\\server\\share\\${'n'.repeat(225)}\\`;
  const sourcePath = `${longDirectory}source.db`;
  const targetPath = `${longDirectory}f.db`;
  assert.ok(sourcePath.length >= 248);
  assert.ok(targetPath.length < 248);
  const expectedIdentity = { dev: '53', ino: '59' };
  const observed = {};
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...readableKernel32({}),
      CreateFileW(source) {
        observed.source = decodeWideString(source);
        return 96n;
      },
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      SetFileInformationByHandle(handle, informationClass, information) {
        const nameLength = information.readUInt32LE(16);
        observed.target = information.subarray(20, 20 + nameLength).toString('utf16le');
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    ptr: (value) => value,
  });

  backend.installAbsentFromVerifiedSource(
    sourcePath,
    targetPath,
    expectedIdentity,
    VERIFIED_SOURCE_SHA256,
  );

  assert.equal(observed.source, path.win32.toNamespacedPath(sourcePath));
  assert.equal(observed.target, path.win32.toNamespacedPath(targetPath));
  assert.match(observed.source, /^\\\\\?\\UNC\\server\\share\\/);
});

test('Win32 durable flush emits namespaced absolute UTF-16 paths beyond MAX_PATH', () => {
  const longDirectory = `C:\\controlled\\${'n'.repeat(260)}`;
  const longFile = `${longDirectory}\\artifact.db`;
  const observed = [];
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target) {
        observed.push(decodeWideString(target));
        return 102n;
      },
      FlushFileBuffers: () => 1,
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    ptr: (value) => value,
  });

  backend.fsyncFile(longFile);
  backend.fsyncDirectory(longDirectory);

  assert.deepEqual(observed, [
    path.win32.toNamespacedPath(longFile),
    path.win32.toNamespacedPath(longDirectory),
  ]);
});

test('Win32 verified absent install rejects inexact identity and non-plain source handles', () => {
  const expectedIdentity = { dev: '17', ino: '23' };
  for (const [name, actual] of [
    ['identity', { dev: '17', ino: '24' }],
    ['directory', { dev: '17', ino: '23', attributes: 0x00000010 }],
    ['reparse point', { dev: '17', ino: '23', attributes: 0x00000400 }],
    ['multiple links', { dev: '17', ino: '23', links: 2 }],
  ]) {
    let installCalls = 0;
    let closeCalls = 0;
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        ...readableKernel32({}),
        CreateFileW: () => 92n,
        GetFileInformationByHandle(handle, information) {
          assert.equal(handle, 92n);
          writeWin32FileInformation(information, actual);
          return 1;
        },
        SetFileInformationByHandle() {
          installCalls += 1;
          return 1;
        },
        CloseHandle() {
          closeCalls += 1;
          return 1;
        },
        GetLastError: () => 0,
      },
      ptr: (value) => value,
    });

    assert.throws(
      () => backend.installAbsentFromVerifiedSource(
        'C:\\controlled\\source.db',
        'C:\\controlled\\formal.db',
        expectedIdentity,
        VERIFIED_SOURCE_SHA256,
      ),
      (error) => error.code === 'VERIFIED_SOURCE_MISMATCH',
      name,
    );
    assert.equal(installCalls, 0, name);
    assert.equal(closeCalls, 1, name);
  }
});

test('Win32 verified absent install maps target contention without replacing it', () => {
  let lastError = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...readableKernel32({}),
      CreateFileW: () => 93n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, { dev: '29', ino: '31' });
        return 1;
      },
      SetFileInformationByHandle() {
        lastError = 183;
        return 0;
      },
      CloseHandle: () => 1,
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      { dev: '29', ino: '31' },
      VERIFIED_SOURCE_SHA256,
    ),
    (error) => (
      error.code === 'INSTALL_TARGET_EXISTS'
      && error.cause?.win32Code === 183
    ),
  );
});

test('Win32 verified absent install preserves native primary and attaches close failure', () => {
  let lastError = 0;
  const closeErrorCode = 6;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...readableKernel32({}),
      CreateFileW: () => 94n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, { dev: '37', ino: '41' });
        return 1;
      },
      SetFileInformationByHandle() {
        lastError = 5;
        return 0;
      },
      CloseHandle() {
        lastError = closeErrorCode;
        return 0;
      },
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      { dev: '37', ino: '41' },
      VERIFIED_SOURCE_SHA256,
    ),
    (error) => (
      error.code === 'VERIFIED_INSTALL_FAILED'
      && error.cause?.win32Code === 5
      && error.cleanupError?.win32Code === closeErrorCode
      && error.installed !== true
    ),
  );
});

test('Win32 verified absent install reports successful installation when handle close fails', () => {
  const closeError = Object.assign(new Error('CloseHandle FFI invocation failed'), {
    code: 'ERR_FFI_CALL',
  });
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...readableKernel32({}),
      CreateFileW: () => 95n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, { dev: '43', ino: '47' });
        return 1;
      },
      SetFileInformationByHandle: () => 1,
      CloseHandle() {
        throw closeError;
      },
      GetLastError: () => 0,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      'C:\\controlled\\source.db',
      'C:\\controlled\\formal.db',
      { dev: '43', ino: '47' },
      VERIFIED_SOURCE_SHA256,
    ),
    (error) => (
      error.code === 'VERIFIED_INSTALL_FAILED'
      && error.installed === true
      && error.cause === closeError
    ),
  );
});

test('verified absent install moves the exact source object on Windows', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-verified-install-');
  const source = path.join(dir, 'source.db');
  const target = path.join(dir, 'formal.db');
  fs.writeFileSync(source, 'verified source');
  const expectedIdentity = fileIdentity(source);
  const expectedSha256 = sha256(fs.readFileSync(source));

  assert.deepEqual(
    installAbsentFromVerifiedSource(source, target, expectedIdentity, expectedSha256),
    { installed: true, sourceDisposition: 'moved' },
  );
  assert.equal(fs.existsSync(source), false);
  assert.equal(
    fs.existsSync(target),
    true,
    `verified install target is missing; directory=${fs.existsSync(dir)} entries=${fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : '<missing>'}`,
  );
  assert.deepEqual(fileIdentity(target), expectedIdentity);
  assert.equal(fs.readFileSync(target, 'utf8'), 'verified source');
});

test('verified absent install never replaces a competing Windows target', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-verified-conflict-');
  const source = path.join(dir, 'source.db');
  const target = path.join(dir, 'formal.db');
  fs.writeFileSync(source, 'verified source');
  fs.writeFileSync(target, 'third-party formal');
  const sourceIdentity = fileIdentity(source);
  const sourceSha256 = sha256(fs.readFileSync(source));
  const targetIdentity = fileIdentity(target);

  assert.throws(
    () => installAbsentFromVerifiedSource(source, target, sourceIdentity, sourceSha256),
    { code: 'INSTALL_TARGET_EXISTS' },
  );
  assert.deepEqual(fileIdentity(source), sourceIdentity);
  assert.deepEqual(fileIdentity(target), targetIdentity);
  assert.equal(fs.readFileSync(source, 'utf8'), 'verified source');
  assert.equal(fs.readFileSync(target, 'utf8'), 'third-party formal');
});

test('a real Windows source substitution at the open boundary is rejected with evidence preserved', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-verified-source-race-');
  const source = path.join(dir, 'source.db');
  const evidence = path.join(dir, 'original-evidence.db');
  const target = path.join(dir, 'formal.db');
  fs.writeFileSync(source, 'expected source');
  const expectedIdentity = fileIdentity(source);
  const expectedSha256 = sha256(fs.readFileSync(source));
  const native = loadNativeKernel32ForTest();
  t.after(() => native.library.close?.());
  let swapped = false;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...native.symbols,
      CreateFileW(...args) {
        if (!swapped) {
          swapped = true;
          fs.renameSync(source, evidence);
          fs.writeFileSync(source, 'replacement source');
        }
        return native.symbols.CreateFileW(...args);
      },
    },
    ptr: native.ptr,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      source,
      target,
      expectedIdentity,
      expectedSha256,
    ),
    { code: 'VERIFIED_SOURCE_MISMATCH' },
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fileIdentity(evidence), expectedIdentity);
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'expected source');
  assert.equal(fs.readFileSync(source, 'utf8'), 'replacement source');
});

test('a real Windows same-inode overwrite before CreateFileW is rejected without installing formal', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-verified-content-race-');
  const source = path.join(dir, 'source.db');
  const target = path.join(dir, 'formal.db');
  fs.writeFileSync(source, 'expected source bytes');
  const expectedIdentity = fileIdentity(source);
  const expectedSha256 = sha256(fs.readFileSync(source));
  const native = loadNativeKernel32ForTest();
  t.after(() => native.library.close?.());
  let overwritten = false;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...native.symbols,
      CreateFileW(...args) {
        if (!overwritten) {
          overwritten = true;
          fs.writeFileSync(source, 'healthy but different source bytes');
          assert.deepEqual(fileIdentity(source), expectedIdentity);
        }
        return native.symbols.CreateFileW(...args);
      },
    },
    ptr: native.ptr,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      source,
      target,
      expectedIdentity,
      expectedSha256,
    ),
    { code: 'VERIFIED_SOURCE_MISMATCH' },
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fileIdentity(source), expectedIdentity);
  assert.equal(fs.readFileSync(source, 'utf8'), 'healthy but different source bytes');
});

test('a real Windows hardlink added immediately before rename is detected and source is restored', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-verified-topology-race-');
  const source = path.join(dir, 'source.db');
  const target = path.join(dir, 'formal.db');
  const evidence = path.join(dir, 'external-evidence.db');
  fs.writeFileSync(source, VERIFIED_SOURCE_BYTES);
  const expectedIdentity = fileIdentity(source);
  const native = loadNativeKernel32ForTest();
  t.after(() => native.library.close?.());
  let installCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      ...native.symbols,
      SetFileInformationByHandle(...args) {
        installCalls += 1;
        if (installCalls === 1) fs.linkSync(source, evidence);
        return native.symbols.SetFileInformationByHandle(...args);
      },
    },
    ptr: native.ptr,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      source,
      target,
      expectedIdentity,
      VERIFIED_SOURCE_SHA256,
    ),
    (error) => error.code === 'VERIFIED_SOURCE_TOPOLOGY_CHANGED' && error.installed === false,
  );
  assert.equal(installCalls, 2);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(evidence), true);
  assert.deepEqual(fileIdentity(source), expectedIdentity);
  assert.deepEqual(fileIdentity(evidence), expectedIdentity);
  assert.equal(fs.lstatSync(source).nlink, 2);
  assert.deepEqual(fs.readFileSync(source), VERIFIED_SOURCE_BYTES);
  assert.deepEqual(fs.readFileSync(evidence), VERIFIED_SOURCE_BYTES);
});

test('a real Windows writer handle blocks verified-source CreateFileW with no side effect', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-verified-writer-race-');
  const source = path.join(dir, 'source.db');
  const target = path.join(dir, 'formal.db');
  fs.writeFileSync(source, VERIFIED_SOURCE_BYTES);
  const expectedIdentity = fileIdentity(source);
  const native = loadNativeKernel32ForTest();
  t.after(() => native.library.close?.());
  const wideSource = Buffer.from(`${source}\0`, 'utf16le');
  const writerHandle = native.symbols.CreateFileW(
    native.ptr(wideSource),
    0x40000000,
    0x00000001,
    0,
    3,
    0x00000080,
    0,
  );
  assert.notEqual(BigInt.asUintN(64, BigInt(writerHandle)), 0xffffffffffffffffn);
  t.after(() => native.symbols.CloseHandle(writerHandle));
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: native.symbols,
    ptr: native.ptr,
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      source,
      target,
      expectedIdentity,
      VERIFIED_SOURCE_SHA256,
    ),
    (error) => (
      error.code === 'VERIFIED_SOURCE_MISMATCH'
      && error.cause?.win32Code === 32
    ),
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fileIdentity(source), expectedIdentity);
  assert.deepEqual(fs.readFileSync(source), VERIFIED_SOURCE_BYTES);
});

test('the POSIX verified absent install primitive fails closed before filesystem mutation', () => {
  let openCalls = 0;
  const backend = createInjectedPosixBackend({
    errnoValue: 0,
    fsOverrides: {
      openSync() {
        openCalls += 1;
        return 73;
      },
    },
  });

  assert.throws(
    () => backend.installAbsentFromVerifiedSource(
      '/controlled/source.db',
      '/controlled/formal.db',
      { dev: '1', ino: '2' },
    ),
    { code: 'DURABILITY_UNSUPPORTED' },
  );
  assert.equal(openCalls, 0);
});

test('atomic replace reports a locked target then succeeds after the handle closes', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-atomic-replace-');
  const candidate = path.join(dir, 'candidate.db');
  const target = path.join(dir, 'target.db');
  fs.writeFileSync(candidate, 'candidate');
  fs.writeFileSync(target, 'original');

  const reader = fs.openSync(target, 'r');
  try {
    assert.throws(
      () => atomicReplace(candidate, target, { attempts: 2, backoffMs: 1 }),
      { code: 'TARGET_LOCKED' },
    );
  } finally {
    fs.closeSync(reader);
  }

  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'candidate');
  atomicReplace(candidate, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'candidate');
});

test('atomic replace publishes the candidate over an existing target', (t) => {
  const dir = createTempDir(t, 'mythpen-atomic-publish-');
  const candidate = path.join(dir, 'candidate.db');
  const target = path.join(dir, 'target.db');
  fs.writeFileSync(candidate, 'candidate');
  fs.writeFileSync(target, 'original');

  atomicReplace(candidate, target);

  assert.equal(fs.existsSync(candidate), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'candidate');
});

test('atomic replace rejects every non-finite or out-of-domain retry option before renaming', (t) => {
  const dir = createTempDir(t, 'mythpen-atomic-options-');
  const invalidOptions = [
    { attempts: Number.NaN },
    { attempts: Number.POSITIVE_INFINITY },
    { attempts: Number.MAX_SAFE_INTEGER + 1 },
    { attempts: 0 },
    { attempts: -1 },
    { attempts: 1.5 },
    { backoffMs: Number.NaN },
    { backoffMs: Number.POSITIVE_INFINITY },
    { backoffMs: -1 },
  ];

  for (const [index, options] of invalidOptions.entries()) {
    const candidate = path.join(dir, `candidate-${index}.db`);
    const target = path.join(dir, `target-${index}.db`);
    fs.writeFileSync(candidate, 'candidate');
    fs.writeFileSync(target, 'original');

    assert.throws(
      () => atomicReplace(candidate, target, options),
      (error) => (
        error.code === 'DURABILITY_UNSUPPORTED'
        && /attempts|backoffMs/.test(error.message)
      ),
    );
    assert.equal(fs.readFileSync(candidate, 'utf8'), 'candidate');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  }
});

test('POSIX flock maps only EAGAIN and EWOULDBLOCK to LEASE_BUSY', (t) => {
  const dir = createTempDir(t, 'mythpen-posix-errno-');
  for (const errnoValue of [11, 35]) {
    let closeCount = 0;
    const backend = createInjectedPosixBackend({
      errnoValue,
      fsOverrides: { closeSync: () => { closeCount += 1; } },
    });
    assert.throws(
      () => backend.acquireExclusiveLease(path.join(dir, `busy-${errnoValue}.lock`)),
      (error) => error.code === 'LEASE_BUSY' && error.cause?.errno === errnoValue,
    );
    assert.equal(closeCount, 1);
  }
});

test('POSIX flock maps non-contention errno to DURABILITY_UNSUPPORTED', (t) => {
  const dir = createTempDir(t, 'mythpen-posix-unsupported-');
  let closeCount = 0;
  const backend = createInjectedPosixBackend({
    errnoValue: 5,
    fsOverrides: { closeSync: () => { closeCount += 1; } },
  });

  assert.throws(
    () => backend.acquireExclusiveLease(path.join(dir, 'unsupported.lock')),
    (error) => error.code === 'DURABILITY_UNSUPPORTED' && error.cause?.errno === 5,
  );
  assert.equal(closeCount, 1);
});

test('POSIX fsync preserves the primary failure and attaches close failure as secondary', () => {
  const fsyncError = Object.assign(new Error('fsync failed'), { code: 'EIO' });
  const closeError = Object.assign(new Error('close failed'), { code: 'EBADF' });
  const backend = createInjectedPosixBackend({
    errnoValue: 0,
    fsOverrides: {
      fsyncSync: () => { throw fsyncError; },
      closeSync: () => { throw closeError; },
    },
  });

  assert.throws(
    () => backend.fsyncFile('injected-file'),
    (error) => (
      error.code === 'DURABILITY_UNSUPPORTED'
      && error.cause === fsyncError
      && error.cleanupError === closeError
    ),
  );
});

test('POSIX cleanup paths use the injected shared error helper', () => {
  const fsyncError = Object.assign(new Error('fsync failed'), { code: 'EIO' });
  const closeError = Object.assign(new Error('close failed'), { code: 'EBADF' });
  const calls = [];
  const backend = createInjectedPosixBackend({
    attachCleanupError(primaryError, cleanupError) {
      calls.push([primaryError, cleanupError]);
      primaryError.sharedCleanupError = cleanupError;
      return primaryError;
    },
    errnoValue: 0,
    fsOverrides: {
      fsyncSync: () => { throw fsyncError; },
      closeSync: () => { throw closeError; },
    },
  });

  assert.throws(
    () => backend.fsyncFile('injected-file'),
    (error) => error.cause === fsyncError && error.sharedCleanupError === closeError,
  );
  assert.equal(calls.length, 1);
});

test('capability probe creation failures are wrapped in the stable durability error domain', (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const creationError = Object.assign(new Error('probe creation denied'), { code: 'EACCES' });
  const originalMkdtempSync = fs.mkdtempSync;
  fs.mkdtempSync = (prefix, ...args) => {
    if (String(prefix).startsWith(path.join(dataDir, '.durability-probe-'))) throw creationError;
    return originalMkdtempSync(prefix, ...args);
  };
  try {
    assert.throws(
      () => loadFreshDurability().detectCapabilities(),
      (error) => error.code === 'DURABILITY_UNSUPPORTED' && error.cause === creationError,
    );
  } finally {
    fs.mkdtempSync = originalMkdtempSync;
  }
});

test('capability probe cleanup failure stays secondary to an earlier probe failure', (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const probeError = Object.assign(new Error('probe write failed'), { code: 'EIO' });
  const cleanupError = Object.assign(new Error('probe cleanup failed'), { code: 'EACCES' });
  const originalWriteFileSync = fs.writeFileSync;
  const originalRmSync = fs.rmSync;
  const isProbePath = (value) => String(value).startsWith(path.join(dataDir, '.durability-probe-'));
  fs.writeFileSync = (filePath, ...args) => {
    if (isProbePath(filePath)) throw probeError;
    return originalWriteFileSync(filePath, ...args);
  };
  fs.rmSync = (target, ...args) => {
    if (isProbePath(target)) throw cleanupError;
    return originalRmSync(target, ...args);
  };
  try {
    assert.throws(
      () => loadFreshDurability().detectCapabilities(),
      (error) => (
        error.code === 'DURABILITY_UNSUPPORTED'
        && error.cause === probeError
        && error.cleanupError === cleanupError
      ),
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync = originalRmSync;
  }
});

test('capability detection performs and caches probes under the configured data root', (t) => {
  const { dataDir } = withIsolatedDataDir(t);

  const first = detectCapabilities();
  const second = detectCapabilities();

  assert.strictEqual(second, first);
  assert.deepEqual(first, {
    backend: process.platform === 'win32' ? 'win32' : 'posix',
    exclusiveLease: true,
    directoryFsync: true,
    atomicReplace: true,
    verifiedAbsentInstall: process.platform === 'win32',
  });
});

test('startup durability assertion reports but does not require verified absent install', () => {
  const capabilities = {
    backend: 'posix',
    exclusiveLease: true,
    directoryFsync: true,
    atomicReplace: true,
    verifiedAbsentInstall: false,
  };

  assert.strictEqual(assertDurabilitySupported(capabilities), capabilities);
});

test('startup capability assertion fails closed with a stable diagnostic error', () => {
  assert.throws(
    () => assertDurabilitySupported({
      backend: 'win32',
      exclusiveLease: true,
      directoryFsync: false,
      atomicReplace: true,
    }),
    (error) => (
      error.code === 'DURABILITY_UNSUPPORTED'
      && error.message.includes('directoryFsync')
    ),
  );
});

test('the POSIX backend can be loaded without resolving libc on Windows', () => {
  assert.doesNotThrow(() => require('../platform/durability-posix'));
});
