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
  deleteVerified,
  detectCapabilities,
  fsyncDirectory,
  fsyncFile,
  installAbsentFromVerifiedSource,
  readVerified,
  relocateVerifiedToAbsent,
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
  byteSize = 0,
  dev,
  ino,
  links = 1,
}) {
  const size = BigInt(byteSize);
  const fileId = BigInt(ino);
  buffer.writeUInt32LE(attributes, 0);
  buffer.writeUInt32LE(Number(BigInt(dev)), 28);
  buffer.writeUInt32LE(Number((size >> 32n) & 0xffffffffn), 32);
  buffer.writeUInt32LE(Number(size & 0xffffffffn), 36);
  buffer.writeUInt32LE(links, 40);
  buffer.writeUInt32LE(Number((fileId >> 32n) & 0xffffffffn), 44);
  buffer.writeUInt32LE(Number(fileId & 0xffffffffn), 48);
}

function fakeWin32Lstat({
  dev = '501',
  ino = '503',
  kind = 'file',
  links = 1,
  reparse = false,
  size = 0,
} = {}) {
  return {
    dev: BigInt(dev),
    ino: BigInt(ino),
    nlink: BigInt(links),
    size: BigInt(size),
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => reparse,
  };
}

function assertImmutableDispositionUnknown(error) {
  assert.deepEqual(Object.getOwnPropertyDescriptor(error, 'releaseDispositionUnknown'), {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
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

function withIsolatedWin32Durability(createBackend, run) {
  const durabilityPath = require.resolve('../platform/durability');
  const win32Path = require.resolve('../platform/durability-win32');
  const cachedDurability = require.cache[durabilityPath];
  const win32Module = require(win32Path);
  const originalFactory = win32Module.createWin32Backend;
  win32Module.createWin32Backend = createBackend;
  delete require.cache[durabilityPath];
  try {
    return run(require(durabilityPath));
  } finally {
    delete require.cache[durabilityPath];
    win32Module.createWin32Backend = originalFactory;
    if (cachedDurability !== undefined) require.cache[durabilityPath] = cachedDurability;
  }
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

test('manuscript verified read pins one no-delete-share handle and returns its exact bytes', () => {
  const sourcePath = 'C:\\controlled\\chapter.md';
  const expectedIdentity = { dev: '211', ino: '223' };
  const bytes = Buffer.from('handle-bound manuscript bytes');
  const calls = {};
  let readOffset = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
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
        return 201n;
      },
      GetFileInformationByHandle(handle, information) {
        calls.informationCalls = (calls.informationCalls || 0) + 1;
        writeWin32FileInformation(information, {
          ...expectedIdentity,
          byteSize: bytes.length,
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
      CloseHandle(handle) {
        calls.closed = handle;
        return 1;
      },
      GetLastError: () => 0,
    },
    ptr: (value) => value,
    realpathSync: (value) => value,
  });

  const result = backend.readVerified(sourcePath, {
    identity: expectedIdentity,
    sha256: sha256(bytes),
  });

  assert.deepEqual(result, {
    byteSize: bytes.length,
    bytes,
    identity: expectedIdentity,
    sha256: sha256(bytes),
  });
  assert.notStrictEqual(result.bytes, bytes);
  assert.deepEqual(calls.open, {
    source: path.win32.toNamespacedPath(sourcePath),
    desiredAccess: 0x80000080,
    shareMode: 0x00000001,
    security: 0,
    disposition: 3,
    flags: 0x00200000,
    template: 0,
  });
  assert.equal(calls.informationCalls, 2);
  assert.equal(calls.closed, 201n);
});

test('manuscript verified read rejects a changed parent before reading the file', () => {
  const sourcePath = 'C:\\controlled\\chapter.md';
  const expectedIdentity = { dev: '211', ino: '223' };
  const expectedParentIdentity = { dev: '211', ino: '227' };
  const bytes = Buffer.from('must remain unread');
  let readOffset = 0;
  let readCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target) {
        return decodeWideString(target) === path.win32.toNamespacedPath(path.win32.dirname(sourcePath))
          ? 211n
          : 212n;
      },
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, handle === 211n
          ? { dev: '211', ino: '229', attributes: 0x00000010 }
          : { ...expectedIdentity, byteSize: bytes.length });
        return 1;
      },
      ReadFile(handle, output, requested, bytesRead) {
        readCalls += 1;
        const count = Math.min(requested, bytes.length - readOffset);
        bytes.copy(output, 0, readOffset, readOffset + count);
        bytesRead.writeUInt32LE(count, 0);
        readOffset += count;
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    ptr: (value) => value,
    realpathSync: (value) => value,
  });

  assert.throws(
    () => backend.readVerified(sourcePath, {
      identity: expectedIdentity,
      parentIdentity: expectedParentIdentity,
      sha256: sha256(bytes),
    }),
    { code: 'VERIFIED_SOURCE_TOPOLOGY_CHANGED' },
  );
  assert.equal(readCalls, 0);
});

test('manuscript verified create flushes its already pinned parent handle before close', (t) => {
  const parentPath = createTempDir(t, 'mythpen-create-pinned-parent-');
  const assetPath = path.join(parentPath, 'staged-after.bin');
  const parentIdentity = fileIdentity(parentPath);
  const bytes = Buffer.from('create with pinned parent');
  const events = [];
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW() {
        events.push('open-parent:231');
        return 231n;
      },
      GetFileInformationByHandle(handle, information) {
        assert.equal(handle, 231n);
        writeWin32FileInformation(information, {
          ...parentIdentity,
          attributes: 0x00000010,
        });
        return 1;
      },
      FlushFileBuffers(handle) {
        events.push(`flush:${handle}`);
        return 1;
      },
      CloseHandle(handle) {
        events.push(`close:${handle}`);
        return 1;
      },
      GetLastError: () => 0,
    },
    ptr: (value) => value,
  });

  const result = backend.createAssetVerified(assetPath, {
    byteSize: bytes.length,
    bytes,
    parentIdentity,
    sha256: sha256(bytes),
  });

  assert.deepEqual(result, {
    byteSize: bytes.length,
    fileFsync: true,
    identity: fileIdentity(assetPath),
    parentFsync: true,
    sha256: sha256(bytes),
  });
  assert.deepEqual(events, ['open-parent:231', 'flush:231', 'close:231']);
});

test('manuscript verified create marks every pinned flush or close fault as created', (t) => {
  const parentPath = createTempDir(t, 'mythpen-create-disposition-');
  const parentIdentity = fileIdentity(parentPath);
  const bytes = Buffer.from('created despite postcheck fault');
  for (const fault of ['flush', 'close']) {
    const assetPath = path.join(parentPath, `${fault}.bin`);
    let lastError = 0;
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        CreateFileW: () => 232n,
        GetFileInformationByHandle(handle, information) {
          writeWin32FileInformation(information, {
            ...parentIdentity,
            attributes: 0x00000010,
          });
          return 1;
        },
        FlushFileBuffers() {
          if (fault !== 'flush') return 1;
          lastError = 5;
          return 0;
        },
        CloseHandle() {
          if (fault !== 'close') return 1;
          lastError = 6;
          return 0;
        },
        GetLastError: () => lastError,
      },
      ptr: (value) => value,
    });

    assert.throws(
      () => backend.createAssetVerified(assetPath, {
        byteSize: bytes.length,
        bytes,
        parentIdentity,
        sha256: sha256(bytes),
      }),
      (error) => error.created === true,
    );
    assert.equal(fs.existsSync(assetPath), true);
  }
});

test('manuscript verified relocate pins the destination parent and never enables replacement', () => {
  const sourcePath = 'C:\\articles\\chapter.md';
  const targetPath = 'C:\\recovery\\displaced-before.bin';
  const sourceParentPath = path.win32.dirname(sourcePath);
  const targetParentPath = path.win32.dirname(targetPath);
  const expectedIdentity = { dev: '211', ino: '223' };
  const expectedSourceParentIdentity = { dev: '211', ino: '225' };
  const expectedTargetParentIdentity = { dev: '211', ino: '227' };
  const bytes = Buffer.from('relocated manuscript bytes');
  const calls = { closes: [], events: [], opens: [] };
  let readOffset = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target, desiredAccess, shareMode, security, disposition, flags, template) {
        const decoded = decodeWideString(target);
        calls.opens.push({ decoded, desiredAccess, shareMode, security, disposition, flags, template });
        if (decoded === path.win32.toNamespacedPath(targetParentPath)) return 203n;
        if (decoded === path.win32.toNamespacedPath(sourceParentPath)) return 204n;
        return 202n;
      },
      GetFileInformationByHandle(handle, information) {
        if (handle === 203n) {
          writeWin32FileInformation(information, {
            ...expectedTargetParentIdentity,
            attributes: 0x00000010,
          });
        } else if (handle === 204n) {
          writeWin32FileInformation(information, {
            ...expectedSourceParentIdentity,
            attributes: 0x00000010,
          });
        } else {
          writeWin32FileInformation(information, {
            ...expectedIdentity,
            byteSize: bytes.length,
          });
        }
        return 1;
      },
      ReadFile(handle, output, requested, bytesRead) {
        assert.equal(handle, 202n);
        const count = Math.min(requested, bytes.length - readOffset);
        bytes.copy(output, 0, readOffset, readOffset + count);
        bytesRead.writeUInt32LE(count, 0);
        readOffset += count;
        return 1;
      },
      SetFileInformationByHandle(handle, informationClass, information, byteLength) {
        calls.events.push(`relocate:${handle}`);
        calls.relocate = {
          handle,
          informationClass,
          byteLength,
          replaceIfExists: information.readUInt32LE(0),
          rootDirectory: information.readBigUInt64LE(8),
          target: information.subarray(20, 20 + information.readUInt32LE(16)).toString('utf16le'),
        };
        return 1;
      },
      FlushFileBuffers(handle) {
        calls.events.push(`flush:${handle}`);
        return 1;
      },
      CloseHandle(handle) {
        calls.closes.push(handle);
        calls.events.push(`close:${handle}`);
        return 1;
      },
      GetLastError: () => 0,
    },
    ptr: (value) => value,
    realpathSync: (value) => value,
  });

  assert.deepEqual(
    backend.relocateVerifiedToAbsent(sourcePath, targetPath, {
      byteSize: bytes.length,
      identity: expectedIdentity,
      sha256: sha256(bytes),
      sourceParentIdentity: expectedSourceParentIdentity,
      targetParentIdentity: expectedTargetParentIdentity,
    }),
    {
      byteSize: bytes.length,
      identity: expectedIdentity,
      relocated: true,
      sha256: sha256(bytes),
      sourceParentFsync: true,
      targetParentFsync: true,
    },
  );
  assert.deepEqual(calls.opens, [
    {
      decoded: path.win32.toNamespacedPath(targetParentPath),
      desiredAccess: 0xc0000000,
      shareMode: 0x00000003,
      security: 0,
      disposition: 3,
      flags: 0x02200000,
      template: 0,
    },
    {
      decoded: path.win32.toNamespacedPath(sourceParentPath),
      desiredAccess: 0xc0000000,
      shareMode: 0x00000003,
      security: 0,
      disposition: 3,
      flags: 0x02200000,
      template: 0,
    },
    {
      decoded: path.win32.toNamespacedPath(sourcePath),
      desiredAccess: 0x80010080,
      shareMode: 0x00000001,
      security: 0,
      disposition: 3,
      flags: 0x00200000,
      template: 0,
    },
  ]);
  assert.deepEqual(calls.relocate, {
    handle: 202n,
    informationClass: 3,
    byteLength: 20 + Buffer.byteLength(path.win32.toNamespacedPath(targetPath), 'utf16le') + 2,
    replaceIfExists: 0,
    rootDirectory: 0n,
    target: path.win32.toNamespacedPath(targetPath),
  });
  assert.deepEqual(calls.closes, [202n, 204n, 203n]);
  assert.deepEqual(calls.events, [
    'relocate:202',
    'flush:204',
    'flush:203',
    'close:202',
    'close:204',
    'close:203',
  ]);
});

test('manuscript verified relocate marks every pinned flush or close fault as relocated', () => {
  const sourcePath = 'C:\\articles\\faulted.md';
  const targetPath = 'C:\\recovery\\faulted.bin';
  const sourceParent = path.win32.dirname(sourcePath);
  const targetParent = path.win32.dirname(targetPath);
  const identity = { dev: '271', ino: '277' };
  const sourceParentIdentity = { dev: '271', ino: '281' };
  const targetParentIdentity = { dev: '271', ino: '283' };
  const bytes = Buffer.from('relocated before postcheck fault');
  for (const fault of ['flush', 'close']) {
    let lastError = 0;
    let readOffset = 0;
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        CreateFileW(target) {
          const decoded = decodeWideString(target);
          if (decoded === path.win32.toNamespacedPath(targetParent)) return 233n;
          if (decoded === path.win32.toNamespacedPath(sourceParent)) return 234n;
          return 235n;
        },
        GetFileInformationByHandle(handle, information) {
          if (handle === 233n) {
            writeWin32FileInformation(information, {
              ...targetParentIdentity,
              attributes: 0x00000010,
            });
          } else if (handle === 234n) {
            writeWin32FileInformation(information, {
              ...sourceParentIdentity,
              attributes: 0x00000010,
            });
          } else {
            writeWin32FileInformation(information, { ...identity, byteSize: bytes.length });
          }
          return 1;
        },
        ReadFile(handle, output, requested, bytesRead) {
          const count = Math.min(requested, bytes.length - readOffset);
          bytes.copy(output, 0, readOffset, readOffset + count);
          bytesRead.writeUInt32LE(count, 0);
          readOffset += count;
          return 1;
        },
        SetFileInformationByHandle: () => 1,
        FlushFileBuffers() {
          if (fault !== 'flush') return 1;
          lastError = 5;
          return 0;
        },
        CloseHandle(handle) {
          if (fault !== 'close' || handle !== 235n) return 1;
          lastError = 6;
          return 0;
        },
        GetLastError: () => lastError,
      },
      ptr: (value) => value,
      realpathSync: (value) => value,
    });

    assert.throws(
      () => backend.relocateVerifiedToAbsent(sourcePath, targetPath, {
        byteSize: bytes.length,
        identity,
        sha256: sha256(bytes),
        sourceParentIdentity,
        targetParentIdentity,
      }),
      (error) => error.relocated === true,
    );
  }
});

test('manuscript verified relocate rejects a cross-volume destination before rename', () => {
  const sourceIdentity = { dev: '301', ino: '307' };
  const sourceParentIdentity = { dev: '301', ino: '311' };
  const targetParentIdentity = { dev: '401', ino: '409' };
  const bytes = Buffer.from('same-volume gate');
  let readOffset = 0;
  let relocateCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target) {
        const decoded = decodeWideString(target);
        if (decoded.endsWith('recovery')) return 205n;
        if (decoded.endsWith('articles')) return 206n;
        return 204n;
      },
      GetFileInformationByHandle(handle, information) {
        if (handle === 205n) {
          writeWin32FileInformation(information, {
            ...targetParentIdentity,
            attributes: 0x00000010,
          });
        } else if (handle === 206n) {
          writeWin32FileInformation(information, {
            ...sourceParentIdentity,
            attributes: 0x00000010,
          });
        } else {
          writeWin32FileInformation(information, {
            ...sourceIdentity,
            byteSize: bytes.length,
          });
        }
        return 1;
      },
      ReadFile(handle, output, requested, bytesRead) {
        const count = Math.min(requested, bytes.length - readOffset);
        bytes.copy(output, 0, readOffset, readOffset + count);
        bytesRead.writeUInt32LE(count, 0);
        readOffset += count;
        return 1;
      },
      SetFileInformationByHandle() {
        relocateCalls += 1;
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.relocateVerifiedToAbsent(
      'C:\\articles\\chapter.md',
      'C:\\recovery\\displaced-before.bin',
      {
        byteSize: bytes.length,
        identity: sourceIdentity,
        sha256: sha256(bytes),
        sourceParentIdentity,
        targetParentIdentity,
      },
    ),
    { code: 'VERIFIED_SOURCE_TOPOLOGY_CHANGED' },
  );
  assert.equal(relocateCalls, 0);
});

test('manuscript verified relocate maps a Windows sharing violation to TARGET_LOCKED', () => {
  const sourcePath = 'C:\\articles\\locked.md';
  const targetPath = 'C:\\recovery\\displaced-before.bin';
  const sourceParent = path.win32.dirname(sourcePath);
  const targetParent = path.win32.dirname(targetPath);
  const sourceParentIdentity = { dev: '431', ino: '433' };
  const targetParentIdentity = { dev: '431', ino: '439' };
  const closes = [];
  let lastError = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target) {
        const decoded = decodeWideString(target);
        if (decoded === path.win32.toNamespacedPath(targetParent)) return 221n;
        if (decoded === path.win32.toNamespacedPath(sourceParent)) return 222n;
        lastError = 32;
        return 0xffffffffffffffffn;
      },
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, {
          ...(handle === 221n ? targetParentIdentity : sourceParentIdentity),
          attributes: 0x00000010,
        });
        return 1;
      },
      ReadFile: () => assert.fail('a locked source must not be read'),
      SetFileInformationByHandle: () => assert.fail('a locked source must not be relocated'),
      CloseHandle(handle) {
        closes.push(handle);
        return 1;
      },
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
    realpathSync: (value) => value,
  });

  assert.throws(
    () => backend.relocateVerifiedToAbsent(sourcePath, targetPath, {
      byteSize: 12,
      identity: { dev: '431', ino: '443' },
      sha256: 'b'.repeat(64),
      sourceParentIdentity,
      targetParentIdentity,
    }),
    { code: 'TARGET_LOCKED' },
  );
  assert.deepEqual(closes, [222n, 221n]);
});

test('manuscript verified relocate never maps Windows access denied to a retryable lock', () => {
  const sourcePath = 'C:\\articles\\denied.md';
  const targetPath = 'C:\\recovery\\displaced-before.bin';
  const sourceParent = path.win32.dirname(sourcePath);
  const targetParent = path.win32.dirname(targetPath);
  const sourceParentIdentity = { dev: '451', ino: '457' };
  const targetParentIdentity = { dev: '451', ino: '461' };
  let sourceOpenCalls = 0;
  let lastError = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target) {
        const decoded = decodeWideString(target);
        if (decoded === path.win32.toNamespacedPath(targetParent)) return 223n;
        if (decoded === path.win32.toNamespacedPath(sourceParent)) return 224n;
        sourceOpenCalls += 1;
        lastError = 5;
        return 0xffffffffffffffffn;
      },
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, {
          ...(handle === 223n ? targetParentIdentity : sourceParentIdentity),
          attributes: 0x00000010,
        });
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.relocateVerifiedToAbsent(sourcePath, targetPath, {
      byteSize: 12,
      identity: { dev: '451', ino: '463' },
      sha256: 'd'.repeat(64),
      sourceParentIdentity,
      targetParentIdentity,
    }),
    (error) => (
      error.code === 'VERIFIED_SOURCE_MISMATCH'
      && error.cause?.win32Code === 5
    ),
  );
  assert.equal(sourceOpenCalls, 1);
});

test('manuscript verified delete pins the parent and deletes only the verified handle', () => {
  const sourcePath = 'C:\\recovery\\owned-asset.bin';
  const parentPath = path.win32.dirname(sourcePath);
  const expectedIdentity = { dev: '503', ino: '509' };
  const expectedParentIdentity = { dev: '503', ino: '521' };
  const bytes = Buffer.from('owned recovery asset');
  const calls = { closes: [], events: [], opens: [] };
  let readOffset = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target, desiredAccess, shareMode, security, disposition, flags, template) {
        const decoded = decodeWideString(target);
        calls.opens.push({ decoded, desiredAccess, shareMode, security, disposition, flags, template });
        return decoded === path.win32.toNamespacedPath(parentPath) ? 207n : 206n;
      },
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, handle === 207n
          ? { ...expectedParentIdentity, attributes: 0x00000010 }
          : { ...expectedIdentity, byteSize: bytes.length });
        return 1;
      },
      ReadFile(handle, output, requested, bytesRead) {
        assert.equal(handle, 206n);
        const count = Math.min(requested, bytes.length - readOffset);
        bytes.copy(output, 0, readOffset, readOffset + count);
        bytesRead.writeUInt32LE(count, 0);
        readOffset += count;
        return 1;
      },
      SetFileInformationByHandle(handle, informationClass, information, byteLength) {
        calls.events.push(`delete:${handle}`);
        calls.disposition = {
          deleteFile: information.readUInt8(0),
          handle,
          informationClass,
          byteLength,
        };
        return 1;
      },
      FlushFileBuffers(handle) {
        calls.events.push(`flush:${handle}`);
        return 1;
      },
      CloseHandle(handle) {
        calls.closes.push(handle);
        calls.events.push(`close:${handle}`);
        return 1;
      },
      GetLastError: () => 0,
    },
    ptr: (value) => value,
    realpathSync: (value) => value,
  });

  assert.deepEqual(
    backend.deleteVerified(sourcePath, {
      byteSize: bytes.length,
      identity: expectedIdentity,
      parentIdentity: expectedParentIdentity,
      sha256: sha256(bytes),
    }),
    {
      alreadyAbsent: false,
      deleted: true,
      identity: expectedIdentity,
      parentFsync: true,
    },
  );
  assert.deepEqual(calls.opens, [
    {
      decoded: path.win32.toNamespacedPath(parentPath),
      desiredAccess: 0xc0000000,
      shareMode: 0x00000003,
      security: 0,
      disposition: 3,
      flags: 0x02200000,
      template: 0,
    },
    {
      decoded: path.win32.toNamespacedPath(sourcePath),
      desiredAccess: 0x80010080,
      shareMode: 0x00000001,
      security: 0,
      disposition: 3,
      flags: 0x00200000,
      template: 0,
    },
  ]);
  assert.deepEqual(calls.disposition, {
    deleteFile: 1,
    handle: 206n,
    informationClass: 4,
    byteLength: 1,
  });
  assert.deepEqual(calls.closes, [206n, 207n]);
  assert.deepEqual(calls.events, [
    'delete:206',
    'close:206',
    'flush:207',
    'close:207',
  ]);
});

test('manuscript verified delete marks every pinned flush or close fault as deleted', () => {
  const sourcePath = 'C:\\recovery\\delete-fault.bin';
  const parentPath = path.win32.dirname(sourcePath);
  const identity = { dev: '541', ino: '547' };
  const parentIdentity = { dev: '541', ino: '557' };
  const bytes = Buffer.from('deleted before postcheck fault');
  for (const fault of ['flush', 'close']) {
    let lastError = 0;
    let readOffset = 0;
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        CreateFileW(target) {
          return decodeWideString(target) === path.win32.toNamespacedPath(parentPath) ? 236n : 237n;
        },
        GetFileInformationByHandle(handle, information) {
          writeWin32FileInformation(information, handle === 236n
            ? { ...parentIdentity, attributes: 0x00000010 }
            : { ...identity, byteSize: bytes.length });
          return 1;
        },
        ReadFile(handle, output, requested, bytesRead) {
          const count = Math.min(requested, bytes.length - readOffset);
          bytes.copy(output, 0, readOffset, readOffset + count);
          bytesRead.writeUInt32LE(count, 0);
          readOffset += count;
          return 1;
        },
        SetFileInformationByHandle: () => 1,
        FlushFileBuffers() {
          if (fault !== 'flush') return 1;
          lastError = 5;
          return 0;
        },
        CloseHandle(handle) {
          if (fault !== 'close' || handle !== 237n) return 1;
          lastError = 6;
          return 0;
        },
        GetLastError: () => lastError,
      },
      ptr: (value) => value,
      realpathSync: (value) => value,
    });

    assert.throws(
      () => backend.deleteVerified(sourcePath, {
        byteSize: bytes.length,
        identity,
        parentIdentity,
        sha256: sha256(bytes),
      }),
      (error) => error.deleted === true,
    );
  }
});

test('manuscript verified delete treats absence as idempotent only under the verified parent', () => {
  const sourcePath = 'C:\\recovery\\already-collected.bin';
  const parentPath = path.win32.dirname(sourcePath);
  const expectedParentIdentity = { dev: '601', ino: '607' };
  const closes = [];
  let lastError = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW(target) {
        if (decodeWideString(target) === path.win32.toNamespacedPath(parentPath)) return 209n;
        lastError = 2;
        return 0xffffffffffffffffn;
      },
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, {
          ...expectedParentIdentity,
          attributes: 0x00000010,
        });
        return 1;
      },
      ReadFile: () => assert.fail('an absent file must not be read'),
      SetFileInformationByHandle: () => assert.fail('an absent file must not be deleted'),
      CloseHandle(handle) {
        closes.push(handle);
        return 1;
      },
      GetLastError: () => lastError,
    },
    ptr: (value) => value,
    realpathSync: (value) => value,
  });

  assert.deepEqual(
    backend.deleteVerified(sourcePath, {
      byteSize: 0,
      identity: { dev: '601', ino: '613' },
      parentIdentity: expectedParentIdentity,
      sha256: 'a'.repeat(64),
    }),
    { alreadyAbsent: true, deleted: false },
  );
  assert.deepEqual(closes, [209n]);
});

test('manuscript verified create wrapper never reopens its parent after pinned flush', () => {
  const parentIdentity = { dev: '801', ino: '809' };
  const identity = { dev: '801', ino: '811' };
  const bytes = Buffer.from('wrapper create');
  let pathFsyncCalls = 0;
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    createAssetVerified() {
      return {
        byteSize: bytes.length,
        fileFsync: true,
        identity,
        parentFsync: true,
        sha256: sha256(bytes),
      };
    },
    fsyncDirectory() {
      pathFsyncCalls += 1;
    },
    readVerified() {
      return { byteSize: bytes.length, bytes, identity, sha256: sha256(bytes) };
    },
  }), (isolatedDurability) => {
    assert.deepEqual(isolatedDurability.createAssetVerified('C:\\recovery\\asset.bin', {
      byteSize: bytes.length,
      bytes,
      parentIdentity,
      sha256: sha256(bytes),
    }), {
      byteSize: bytes.length,
      fileFsync: true,
      identity,
      parentFsync: true,
      parentIdentity,
      sha256: sha256(bytes),
    });
  });
  assert.equal(pathFsyncCalls, 0);
});

test('manuscript verified relocate wrapper never reopens either parent after pinned flush', () => {
  const identity = { dev: '821', ino: '823' };
  const sourceParentIdentity = { dev: '821', ino: '827' };
  const targetParentIdentity = { dev: '821', ino: '829' };
  const bytes = Buffer.from('wrapper relocate');
  let pathFsyncCalls = 0;
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    fsyncDirectory() {
      pathFsyncCalls += 1;
    },
    inspectPath(targetPath) {
      return {
        identity: targetPath.endsWith('articles')
          ? sourceParentIdentity
          : targetParentIdentity,
      };
    },
    readVerified() {
      return { byteSize: bytes.length, bytes, identity, sha256: sha256(bytes) };
    },
    relocateVerifiedToAbsent() {
      return {
        byteSize: bytes.length,
        identity,
        relocated: true,
        sha256: sha256(bytes),
        sourceParentFsync: true,
        targetParentFsync: true,
      };
    },
  }), (isolatedDurability) => {
    assert.equal(isolatedDurability.relocateVerifiedToAbsent(
      'C:\\articles\\chapter.md',
      'C:\\recovery\\displaced.bin',
      {
        byteSize: bytes.length,
        identity,
        sha256: sha256(bytes),
        sourceParentIdentity,
        targetParentIdentity,
      },
    ).relocated, true);
  });
  assert.equal(pathFsyncCalls, 0);
});

test('manuscript verified delete wrapper never reopens its parent after pinned flush', () => {
  const identity = { dev: '831', ino: '839' };
  const parentIdentity = { dev: '831', ino: '841' };
  let pathFsyncCalls = 0;
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    deleteVerified() {
      return {
        alreadyAbsent: false,
        deleted: true,
        identity,
        parentFsync: true,
      };
    },
    fsyncDirectory() {
      pathFsyncCalls += 1;
    },
  }), (isolatedDurability) => {
    assert.equal(isolatedDurability.deleteVerified('C:\\recovery\\asset.bin', {
      byteSize: 4,
      identity,
      parentIdentity,
      sha256: 'c'.repeat(64),
    }).deleted, true);
  });
  assert.equal(pathFsyncCalls, 0);
});

test('manuscript verified create postcheck or reopen failure always carries created disposition', () => {
  const parentIdentity = { dev: '851', ino: '853' };
  const bytes = Buffer.from('created before malformed result');
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    createAssetVerified() {
      return {
        byteSize: bytes.length,
        fileFsync: true,
        identity: null,
        parentFsync: true,
        sha256: sha256(bytes),
      };
    },
  }), (isolatedDurability) => {
    assert.throws(
      () => isolatedDurability.createAssetVerified('C:\\recovery\\asset.bin', {
        byteSize: bytes.length,
        bytes,
        parentIdentity,
        sha256: sha256(bytes),
      }),
      (error) => error.created === true,
    );
  });
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    createAssetVerified() {
      return {
        byteSize: bytes.length,
        fileFsync: true,
        identity: { dev: '851', ino: '857' },
        parentFsync: true,
        sha256: sha256(bytes),
      };
    },
    readVerified() {
      return {
        byteSize: bytes.length,
        bytes,
        identity: { dev: '999', ino: '999' },
        sha256: sha256(bytes),
      };
    },
  }), (isolatedDurability) => {
    assert.throws(
      () => isolatedDurability.createAssetVerified('C:\\recovery\\reopen.bin', {
        byteSize: bytes.length,
        bytes,
        parentIdentity,
        sha256: sha256(bytes),
      }),
      (error) => error.created === true,
    );
  });
});

test('manuscript verified relocate postcheck or reopen failure carries relocated without retry', () => {
  const identity = { dev: '857', ino: '859' };
  const sourceParentIdentity = { dev: '857', ino: '863' };
  const targetParentIdentity = { dev: '857', ino: '877' };
  let calls = 0;
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    inspectPath(targetPath) {
      return {
        identity: targetPath.endsWith('articles')
          ? sourceParentIdentity
          : targetParentIdentity,
      };
    },
    relocateVerifiedToAbsent() {
      calls += 1;
      return {
        byteSize: 5,
        identity: null,
        relocated: true,
        sha256: 'e'.repeat(64),
        sourceParentFsync: true,
        targetParentFsync: true,
      };
    },
  }), (isolatedDurability) => {
    assert.throws(
      () => isolatedDurability.relocateVerifiedToAbsent(
        'C:\\articles\\chapter.md',
        'C:\\recovery\\asset.bin',
        {
          byteSize: 5,
          identity,
          sha256: 'e'.repeat(64),
          sourceParentIdentity,
          targetParentIdentity,
        },
      ),
      (error) => error.relocated === true,
    );
  });
  assert.equal(calls, 1);
  let reopenCalls = 0;
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    inspectPath(targetPath) {
      return {
        identity: targetPath.endsWith('articles')
          ? sourceParentIdentity
          : targetParentIdentity,
      };
    },
    readVerified() {
      return {
        byteSize: 5,
        bytes: Buffer.alloc(5),
        identity: { dev: '999', ino: '999' },
        sha256: 'e'.repeat(64),
      };
    },
    relocateVerifiedToAbsent() {
      reopenCalls += 1;
      return {
        byteSize: 5,
        identity,
        relocated: true,
        sha256: 'e'.repeat(64),
        sourceParentFsync: true,
        targetParentFsync: true,
      };
    },
  }), (isolatedDurability) => {
    assert.throws(
      () => isolatedDurability.relocateVerifiedToAbsent(
        'C:\\articles\\chapter.md',
        'C:\\recovery\\reopen.bin',
        {
          byteSize: 5,
          identity,
          sha256: 'e'.repeat(64),
          sourceParentIdentity,
          targetParentIdentity,
        },
      ),
      (error) => error.relocated === true,
    );
  });
  assert.equal(reopenCalls, 1);
});

test('manuscript verified delete postcheck failure always carries deleted disposition', () => {
  const identity = { dev: '881', ino: '883' };
  const parentIdentity = { dev: '881', ino: '887' };
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    deleteVerified() {
      return {
        alreadyAbsent: false,
        deleted: true,
        identity: null,
        parentFsync: true,
      };
    },
  }), (isolatedDurability) => {
    assert.throws(
      () => isolatedDurability.deleteVerified('C:\\recovery\\asset.bin', {
        byteSize: 5,
        identity,
        parentIdentity,
        sha256: 'f'.repeat(64),
      }),
      (error) => error.deleted === true,
    );
  });
});

test('manuscript verified read wrapper returns exact real Windows facts', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-manuscript-read-');
  const filePath = path.join(dir, 'chapter.md');
  const bytes = Buffer.from('real handle-bound bytes');
  fs.writeFileSync(filePath, bytes);

  const result = readVerified(filePath, {
    byteSize: bytes.length,
    disposition: 'present',
    identity: fileIdentity(filePath),
    parentIdentity: fileIdentity(dir),
    sha256: sha256(bytes),
  });

  assert.deepEqual(result, {
    byteSize: bytes.length,
    bytes,
    disposition: 'PRESENT',
    identity: fileIdentity(filePath),
    parentIdentity: fileIdentity(dir),
    sha256: sha256(bytes),
  });
  assert.equal(Object.isFrozen(result), true);
});

test('manuscript verified read wrapper proves absence under one pinned Windows parent', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-manuscript-absent-');
  const filePath = path.join(dir, 'missing.bin');
  const expected = {
    disposition: 'absent',
    parentIdentity: fileIdentity(dir),
  };

  const result = readVerified(filePath, expected);
  assert.deepEqual(result, { disposition: 'ABSENT' });
  assert.equal(Object.isFrozen(result), true);

  fs.writeFileSync(filePath, 'third-party');
  assert.throws(() => readVerified(filePath, expected), { code: 'VERIFIED_SOURCE_MISMATCH' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'third-party');
});

test('manuscript verified read rejects a case-only alias of the expected real name', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = createTempDir(t, 'mythpen-manuscript-real-name-');
  const actualPath = path.join(dir, 'ActualCase.md');
  const aliasPath = path.join(dir, 'actualcase.md');
  const bytes = Buffer.from('same entity through wrong name');
  fs.writeFileSync(actualPath, bytes);

  assert.throws(
    () => readVerified(aliasPath, {
      byteSize: bytes.length,
      disposition: 'present',
      identity: fileIdentity(actualPath),
      parentIdentity: fileIdentity(dir),
      sha256: sha256(bytes),
    }),
    { code: 'VERIFIED_SOURCE_MISMATCH' },
  );
});

test('manuscript verified relocate retries a locked source with the shared durability policy', {
  skip: process.platform !== 'win32',
}, () => {
  const durabilityPath = require.resolve('../platform/durability');
  const win32Path = require.resolve('../platform/durability-win32');
  const cachedDurability = require.cache[durabilityPath];
  const win32Module = require(win32Path);
  const originalFactory = win32Module.createWin32Backend;
  const sourcePath = 'C:\\article\\chapter.md';
  const targetPath = 'C:\\recovery\\displaced-before.bin';
  const sourceParentIdentity = { dev: '701', ino: '709' };
  const targetParentIdentity = { dev: '701', ino: '719' };
  const identity = { dev: '701', ino: '727' };
  const bytes = Buffer.from('retry verified relocation');
  const expected = {
    byteSize: bytes.length,
    identity,
    sha256: sha256(bytes),
    sourceParentIdentity,
    targetParentIdentity,
  };
  let attempts = 0;

  win32Module.createWin32Backend = (backendErrors) => ({
    backend: 'win32',
    fsyncDirectory() {},
    inspectPath(target) {
      return {
        identity: target === path.dirname(sourcePath)
          ? sourceParentIdentity
          : targetParentIdentity,
      };
    },
    readVerified() {
      return { byteSize: bytes.length, bytes, identity, sha256: expected.sha256 };
    },
    relocateVerifiedToAbsent() {
      attempts += 1;
      if (attempts < 3) throw new backendErrors.TargetLockedError('injected lock');
      return {
        byteSize: bytes.length,
        identity,
        relocated: true,
        sha256: expected.sha256,
        sourceParentFsync: true,
        targetParentFsync: true,
      };
    },
  });
  delete require.cache[durabilityPath];
  try {
    const isolatedDurability = require(durabilityPath);
    assert.equal(
      isolatedDurability.relocateVerifiedToAbsent(sourcePath, targetPath, expected).relocated,
      true,
    );
    assert.equal(attempts, 3);
  } finally {
    delete require.cache[durabilityPath];
    win32Module.createWin32Backend = originalFactory;
    if (cachedDurability !== undefined) require.cache[durabilityPath] = cachedDurability;
  }
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

test('existing-file range lease uses the exact OPEN_EXISTING one-byte Win32 ABI', () => {
  const filePath = 'C:\\control\\.manuscript-range.lifecycle.lock';
  const expectedIdentity = { dev: '501', ino: '503' };
  const calls = { lstat: [], order: [], pointerAlignments: [] };
  let loadCalls = 0;
  let overlapped;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
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
        return 151n;
      },
      GetFileInformationByHandle(handle, information) {
        calls.informationHandle = handle;
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      CloseHandle(handle) {
        calls.order.push(`close:${handle}`);
        return 1;
      },
      GetLastError: () => 0,
    },
    lstatSync(target, options) {
      calls.lstat.push({ target, options });
      return fakeWin32Lstat(expectedIdentity);
    },
    loadRangeLockApi() {
      loadCalls += 1;
      return {
        ptr(value) {
          calls.pointerAlignments.push(value.byteOffset % BigUint64Array.BYTES_PER_ELEMENT);
          return value;
        },
        symbols: {
          LockFileEx(handle, flags, reserved, low, high, value) {
            calls.order.push(`lock:${handle}`);
            overlapped = value;
            calls.lock = { handle, flags, reserved, low, high, value };
            return 1;
          },
          UnlockFileEx(handle, reserved, low, high, value) {
            calls.order.push(`unlock:${handle}`);
            calls.unlock = { handle, reserved, low, high, value };
            return 1;
          },
        },
      };
    },
    ptr: (value) => value,
  });

  assert.equal(loadCalls, 0);
  const lease = backend.acquireExistingFileRangeLease(filePath, {
    expectedIdentity,
    exclusive: false,
  });
  assert.equal(loadCalls, 1);
  assert.deepEqual(calls.open, {
    source: filePath,
    desiredAccess: 0xc0000000,
    shareMode: 0x00000003,
    security: 0,
    disposition: 3,
    flags: 0x00200080,
    template: 0,
  });
  assert.equal(calls.informationHandle, 151n);
  assert.equal(calls.lstat.length, 2);
  assert.ok(calls.lstat.every(({ target }) => target === filePath));
  assert.ok(calls.lstat.every(({ options }) => options.bigint === true));
  assert.deepEqual(calls.lock, {
    handle: 151n,
    flags: 0x00000001,
    reserved: 0,
    low: 1,
    high: 0,
    value: overlapped,
  });
  assert.equal(overlapped.byteLength, 32);
  assert.equal(overlapped.every((byte) => byte === 0), true);
  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(Object.keys(lease).sort(), ['release', 'state']);
  assert.equal(lease.state, 'HELD');
  assert.throws(() => ({ ...lease }).release(), { code: 'LEASE_LOST' });
  assert.equal(lease.state, 'HELD');

  const released = lease.release();
  assert.equal(Object.isFrozen(released), true);
  assert.deepEqual(released, { disposition: 'UNLOCKED_AND_CLOSED' });
  assert.equal(lease.state, 'RELEASED');
  assert.deepEqual(calls.unlock, {
    handle: 151n,
    reserved: 0,
    low: 1,
    high: 0,
    value: overlapped,
  });
  assert.deepEqual(calls.order, ['lock:151', 'unlock:151', 'close:151']);
  assert.ok(calls.pointerAlignments.every((alignment) => alignment === 0));
  assert.throws(() => lease.release(), { code: 'LEASE_LOST' });
});

test('existing-file range lease adds exclusive locking without broadening its fixed range', () => {
  const calls = {};
  const expectedIdentity = { dev: '521', ino: '523' };
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 153n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    lstatSync: () => fakeWin32Lstat(expectedIdentity),
    loadRangeLockApi: () => ({
      ptr: (value) => value,
      symbols: {
        LockFileEx(handle, flags, reserved, low, high) {
          calls.lock = { handle, flags, reserved, low, high };
          return 1;
        },
        UnlockFileEx: () => 1,
      },
    }),
    ptr: (value) => value,
  });

  backend.acquireExistingFileRangeLease('C:\\control\\exclusive.lock', {
    expectedIdentity,
    exclusive: true,
  }).release();
  assert.deepEqual(calls.lock, {
    handle: 153n,
    flags: 0x00000003,
    reserved: 0,
    low: 1,
    high: 0,
  });
});

test('existing-file range lease lazy symbols cannot break the legacy L1 lease backend', () => {
  const loadFailure = new Error('LockFileEx symbols unavailable');
  let loadCalls = 0;
  let createCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW() {
        createCalls += 1;
        return 155n;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    lstatSync: () => fakeWin32Lstat(),
    loadRangeLockApi() {
      loadCalls += 1;
      throw loadFailure;
    },
    ptr: (value) => value,
  });

  assert.equal(loadCalls, 0);
  backend.acquireExclusiveLease('C:\\control\\legacy.lock').release();
  assert.equal(loadCalls, 0);
  assert.equal(createCalls, 1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
        expectedIdentity: { dev: '501', ino: '503' },
        exclusive: false,
      }),
      (error) => error?.code === 'DURABILITY_UNSUPPORTED' && error.cause === loadFailure,
    );
  }
  assert.equal(loadCalls, 1);
  assert.equal(createCalls, 1);
});

test('existing-file range lease rejects missing lazy symbols without opening the lock file', () => {
  let createCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW() {
        createCalls += 1;
        return 157n;
      },
      CloseHandle: () => 1,
      GetLastError: () => 0,
    },
    lstatSync: () => fakeWin32Lstat(),
    loadRangeLockApi: () => ({ symbols: { LockFileEx: () => 1 } }),
    ptr: (value) => value,
  });

  assert.throws(
    () => backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
      expectedIdentity: { dev: '501', ino: '503' },
      exclusive: false,
    }),
    { code: 'DURABILITY_UNSUPPORTED' },
  );
  assert.equal(createCalls, 0);
});

test('existing-file range lease maps Win32 open and range conflicts to LEASE_BUSY', () => {
  const expectedIdentity = { dev: '541', ino: '547' };
  for (const conflict of [
    { operation: 'open', win32Code: 32 },
    { operation: 'lock', win32Code: 33 },
    { closeUnknown: true, operation: 'lock', win32Code: 33 },
  ]) {
    let closed = 0;
    let lastError = conflict.win32Code;
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        CreateFileW: () => conflict.operation === 'open' ? 0xffffffffffffffffn : 159n,
        GetFileInformationByHandle(handle, information) {
          writeWin32FileInformation(information, expectedIdentity);
          return 1;
        },
        CloseHandle() {
          closed += 1;
          if (conflict.closeUnknown) {
            lastError = 6;
            return 0;
          }
          return 1;
        },
        GetLastError: () => lastError,
      },
      lstatSync: () => fakeWin32Lstat(expectedIdentity),
      loadRangeLockApi: () => ({
        ptr: (value) => value,
        symbols: {
          LockFileEx: () => conflict.operation === 'lock' ? 0 : 1,
          UnlockFileEx: () => 1,
        },
      }),
      ptr: (value) => value,
    });

    const acquire = () => backend.acquireExistingFileRangeLease(
      'C:\\control\\lifecycle.lock',
      { expectedIdentity, exclusive: false },
    );
    if (conflict.closeUnknown) {
      assert.throws(
        acquire,
        (error) => {
          assertImmutableDispositionUnknown(error);
          return (
            error?.code === 'LEASE_LOST'
            && error.cause?.win32Code === 6
            && error.acquireError?.code === 'LEASE_BUSY'
            && error.secondaryErrors?.[0] === error.acquireError
          );
        },
      );
    } else {
      assert.throws(
        acquire,
        (error) => error?.code === 'LEASE_BUSY' && error.cause?.win32Code === conflict.win32Code,
      );
    }
    assert.equal(closed, conflict.operation === 'lock' ? 1 : 0);
  }
});

test('existing-file range lease validates pre-open and post-open lstat facts before LockFileEx', () => {
  const expectedIdentity = { dev: '557', ino: '563' };
  for (const invalidStats of [
    fakeWin32Lstat({ ...expectedIdentity, kind: 'directory' }),
    fakeWin32Lstat({ ...expectedIdentity, reparse: true }),
    fakeWin32Lstat({ ...expectedIdentity, links: 2 }),
    fakeWin32Lstat({ ...expectedIdentity, size: 1 }),
    fakeWin32Lstat({ dev: expectedIdentity.dev, ino: '569' }),
  ]) {
    let openCalls = 0;
    let lockCalls = 0;
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        CreateFileW() {
          openCalls += 1;
          return 161n;
        },
        CloseHandle: () => 1,
        GetLastError: () => 0,
      },
      lstatSync: () => invalidStats,
      loadRangeLockApi: () => ({
        ptr: (value) => value,
        symbols: {
          LockFileEx() {
            lockCalls += 1;
            return 1;
          },
          UnlockFileEx: () => 1,
        },
      }),
      ptr: (value) => value,
    });
    assert.throws(
      () => backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
        expectedIdentity,
        exclusive: false,
      }),
      { code: 'VERIFIED_SOURCE_MISMATCH' },
    );
    assert.equal(openCalls, 0);
    assert.equal(lockCalls, 0);
  }

  let lstatCalls = 0;
  let lockCalls = 0;
  let closeCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 163n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      CloseHandle() {
        closeCalls += 1;
        return 1;
      },
      GetLastError: () => 0,
    },
    lstatSync() {
      lstatCalls += 1;
      return lstatCalls === 1
        ? fakeWin32Lstat(expectedIdentity)
        : fakeWin32Lstat({ dev: expectedIdentity.dev, ino: '571' });
    },
    loadRangeLockApi: () => ({
      ptr: (value) => value,
      symbols: {
        LockFileEx() {
          lockCalls += 1;
          return 1;
        },
        UnlockFileEx: () => 1,
      },
    }),
    ptr: (value) => value,
  });
  assert.throws(
    () => backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
      expectedIdentity,
      exclusive: false,
    }),
    { code: 'VERIFIED_SOURCE_MISMATCH' },
  );
  assert.equal(lstatCalls, 2);
  assert.equal(lockCalls, 0);
  assert.equal(closeCalls, 1);
});

test('existing-file range lease rejects unsafe handle facts before LockFileEx', () => {
  const expectedIdentity = { dev: '577', ino: '587' };
  const cases = [
    { attributes: 0x00000010 },
    { attributes: 0x00000400 },
    { byteSize: 1 },
    { links: 2 },
    { ino: '593' },
  ];
  for (const facts of cases) {
    let lockCalls = 0;
    let closeCalls = 0;
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        CreateFileW: () => 165n,
        GetFileInformationByHandle(handle, information) {
          writeWin32FileInformation(information, { ...expectedIdentity, ...facts });
          return 1;
        },
        CloseHandle() {
          closeCalls += 1;
          return 1;
        },
        GetLastError: () => 0,
      },
      lstatSync: () => fakeWin32Lstat(expectedIdentity),
      loadRangeLockApi: () => ({
        ptr: (value) => value,
        symbols: {
          LockFileEx() {
            lockCalls += 1;
            return 1;
          },
          UnlockFileEx: () => 1,
        },
      }),
      ptr: (value) => value,
    });
    assert.throws(
      () => backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
        expectedIdentity,
        exclusive: false,
      }),
      { code: 'VERIFIED_SOURCE_MISMATCH' },
    );
    assert.equal(lockCalls, 0);
    assert.equal(closeCalls, 1);
  }

  let lockCalls = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 166n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, { ...expectedIdentity, attributes: 0x00000400 });
        return 1;
      },
      CloseHandle: () => 0,
      GetLastError: () => 6,
    },
    lstatSync: () => fakeWin32Lstat(expectedIdentity),
    loadRangeLockApi: () => ({
      ptr: (value) => value,
      symbols: {
        LockFileEx() {
          lockCalls += 1;
          return 1;
        },
        UnlockFileEx: () => 1,
      },
    }),
    ptr: (value) => value,
  });
  assert.throws(
    () => backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
      expectedIdentity,
      exclusive: false,
    }),
    (error) => {
      assertImmutableDispositionUnknown(error);
      return (
        error?.code === 'LEASE_LOST'
        && error.cause?.win32Code === 6
        && error.admissionError?.code === 'VERIFIED_SOURCE_MISMATCH'
        && error.secondaryErrors?.[0] === error.admissionError
      );
    },
  );
  assert.equal(lockCalls, 0);

  let openCalls = 0;
  const inspectBackend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW() {
        openCalls += 1;
        return openCalls === 1 ? 171n : 172n;
      },
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, {
          attributes: 0x00000010,
          dev: '631',
          ino: handle === 171n ? '641' : '643',
        });
        return 1;
      },
      CloseHandle(handle) {
        return handle === 172n ? 0 : 1;
      },
      GetLastError: () => 6,
    },
    ptr: (value) => value,
    realpathSync: (value) => value,
  });
  assert.throws(
    () => inspectBackend.inspectPath('C:\\control-store'),
    (error) => {
      assertImmutableDispositionUnknown(error);
      return error?.code === 'LEASE_LOST' && error.cause?.win32Code === 6;
    },
  );
});

test('existing-file range lease reports known unlock failure only after a known close', () => {
  const expectedIdentity = { dev: '599', ino: '601' };
  let lastError = 0;
  const backend = createWin32Backend(durabilityErrors, {
    kernel32: {
      CreateFileW: () => 167n,
      GetFileInformationByHandle(handle, information) {
        writeWin32FileInformation(information, expectedIdentity);
        return 1;
      },
      CloseHandle: () => 1,
      GetLastError: () => lastError,
    },
    lstatSync: () => fakeWin32Lstat(expectedIdentity),
    loadRangeLockApi: () => ({
      ptr: (value) => value,
      symbols: {
        LockFileEx: () => 1,
        UnlockFileEx() {
          lastError = 158;
          return 0;
        },
      },
    }),
    ptr: (value) => value,
  });
  const lease = backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
    expectedIdentity,
    exclusive: false,
  });

  assert.deepEqual(lease.release(), { disposition: 'CLOSED_AFTER_UNLOCK_FAILURE' });
  assert.equal(lease.state, 'RELEASED');
});

test('existing-file range lease makes close failure a sticky unknown disposition', () => {
  const expectedIdentity = { dev: '607', ino: '613' };
  for (const closeMode of ['returned_failure', 'thrown_failure']) {
    let closeCalls = 0;
    const closeFailure = new Error(`close ${closeMode}`);
    const backend = createWin32Backend(durabilityErrors, {
      kernel32: {
        CreateFileW: () => 169n,
        GetFileInformationByHandle(handle, information) {
          writeWin32FileInformation(information, expectedIdentity);
          return 1;
        },
        CloseHandle() {
          closeCalls += 1;
          if (closeMode === 'thrown_failure') throw closeFailure;
          return 0;
        },
        GetLastError: () => 6,
      },
      lstatSync: () => fakeWin32Lstat(expectedIdentity),
      loadRangeLockApi: () => ({
        ptr: (value) => value,
        symbols: {
          LockFileEx: () => 1,
          UnlockFileEx: () => 1,
        },
      }),
      ptr: (value) => value,
    });
    const lease = backend.acquireExistingFileRangeLease('C:\\control\\lifecycle.lock', {
      expectedIdentity,
      exclusive: true,
    });

    assert.throws(
      () => lease.release(),
      (error) => {
        assertImmutableDispositionUnknown(error);
        return (
          error?.code === 'LEASE_LOST'
          && (closeMode === 'returned_failure'
            ? error.cause?.win32Code === 6
            : error.cause === closeFailure)
        );
      },
    );
    assert.equal(lease.state, 'RELEASE_DISPOSITION_UNKNOWN');
    assert.throws(() => lease.release(), { code: 'LEASE_LOST' });
    assert.equal(closeCalls, 1);
  }
});

test('existing-file range lease public wrapper validates exact options before delegation', {
  skip: process.platform !== 'win32',
}, () => {
  const sentinel = Object.freeze({ kind: 'range-lease' });
  let received;
  withIsolatedWin32Durability(() => ({
    backend: 'win32',
    acquireExistingFileRangeLease(filePath, options) {
      received = { filePath, options };
      return sentinel;
    },
  }), (isolatedDurability) => {
    const result = isolatedDurability.acquireExistingFileRangeLease(
      'C:\\control\\lifecycle.lock',
      { expectedIdentity: { dev: '617', ino: '619' }, exclusive: false },
    );
    assert.strictEqual(result, sentinel);
    assert.deepEqual(received, {
      filePath: 'C:\\control\\lifecycle.lock',
      options: {
        expectedIdentity: { dev: '617', ino: '619' },
        exclusive: false,
      },
    });
    assert.equal(Object.isFrozen(received.options), true);
    assert.equal(Object.isFrozen(received.options.expectedIdentity), true);
    assert.throws(
      () => isolatedDurability.acquireExistingFileRangeLease(
        'C:\\control\\lifecycle.lock',
        { expectedIdentity: { dev: '0617', ino: '619' }, exclusive: false },
      ),
      { code: 'VERIFIED_SOURCE_MISMATCH' },
    );
    assert.throws(
      () => isolatedDurability.acquireExistingFileRangeLease(
        'C:\\control\\lifecycle.lock',
        { expectedIdentity: { dev: '617', ino: '619' }, exclusive: false, range: 2 },
      ),
      TypeError,
    );
  });
});
