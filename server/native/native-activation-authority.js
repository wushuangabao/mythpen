const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBuildInfo } = require('../build-info');
const { createPathStore } = require('../path-store');
const {
  DATA_DIR_VALUE,
  EXPORT_DIR_VALUE,
  resolveStoragePaths,
} = require('../storage-paths');

const FIXTURE_ROOT_PREFIX = 'mythpen-native-stage-c-';
const MARKER_NAME = '.native-stage-c-activation.json';
const MARKER_TTL_MS = 2 * 60 * 1000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STATE_KEY = Symbol.for('mythpen.native-stage-c-fixture-state.v1');
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const INVALID_FILE_ATTRIBUTES = 0xffffffff;
const HKEY_CURRENT_USER = 0xffffffff80000001n;
const REGISTRY_SUBKEY = 'Software\\Mythpen';
const REG_SZ = 1;
const RRF_RT_REG_SZ = 0x00000002;
const ERROR_FILE_NOT_FOUND = 2;
const MAX_REGISTRY_PATH_BYTES = 64 * 1024;
const consumedReceipts = new WeakSet();

let win32AttributesLibrary = null;
let readWin32Attributes = null;
let win32RegistryLibrary = null;
let readWin32RegistryValue = null;

class NativeActivationError extends Error {
  constructor() {
    super('NATIVE_ACTIVATION_DISABLED');
    this.name = 'NativeActivationError';
    this.code = 'NATIVE_ACTIVATION_DISABLED';
  }
}

function disabled() {
  return new NativeActivationError();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size;
}

function assertNoWin32ReparsePoint(targetPath) {
  if (process.platform !== 'win32') return;
  if (!readWin32Attributes) {
    const { dlopen, FFIType, ptr } = require('bun:ffi');
    win32AttributesLibrary = dlopen('kernel32.dll', {
      GetFileAttributesW: {
        args: [FFIType.ptr],
        returns: FFIType.u32,
      },
    });
    const getFileAttributes = win32AttributesLibrary?.symbols?.GetFileAttributesW;
    if (typeof getFileAttributes !== 'function' || typeof ptr !== 'function') throw disabled();
    readWin32Attributes = (filePath) => {
      const widePath = Buffer.from(`${path.toNamespacedPath(filePath)}\0`, 'utf16le');
      return Number(getFileAttributes(ptr(widePath))) >>> 0;
    };
  }
  const attributes = readWin32Attributes(targetPath);
  if (
    attributes === INVALID_FILE_ATTRIBUTES
    || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
  ) {
    throw disabled();
  }
}

function fileIdentity(targetPath, expectedType) {
  const stats = fs.lstatSync(targetPath, { bigint: true });
  if (stats.isSymbolicLink()) throw disabled();
  assertNoWin32ReparsePoint(targetPath);
  if (expectedType === 'directory' && !stats.isDirectory()) throw disabled();
  if (expectedType === 'file' && (!stats.isFile() || stats.nlink !== 1n)) throw disabled();
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: String(stats.mode),
    nlink: String(stats.nlink),
    size: String(stats.size),
  };
}

function parseExactMarker(bytes) {
  let marker;
  try {
    marker = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw disabled();
  }
  if (
    marker === null
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || Object.getPrototypeOf(marker) !== Object.prototype
    || JSON.stringify(marker) !== bytes.toString('utf8')
    || JSON.stringify(Object.keys(marker)) !== JSON.stringify([
      'version',
      'runId',
      'rootDigest',
      'expiresAt',
    ])
    || marker.version !== 1
    || !UUID_V4_PATTERN.test(marker.runId)
    || !SHA256_PATTERN.test(marker.rootDigest)
    || !Number.isSafeInteger(marker.expiresAt)
  ) {
    throw disabled();
  }
  return marker;
}

function readPersistentWindowsRoots() {
  if (!readWin32RegistryValue) {
    const { dlopen, FFIType, ptr } = require('bun:ffi');
    win32RegistryLibrary = dlopen('advapi32.dll', {
      RegGetValueW: {
        args: [
          FFIType.u64,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
    });
    const regGetValue = win32RegistryLibrary?.symbols?.RegGetValueW;
    if (typeof regGetValue !== 'function' || typeof ptr !== 'function') throw disabled();
    const subKey = Buffer.from(`${REGISTRY_SUBKEY}\0`, 'utf16le');
    readWin32RegistryValue = (name) => {
      const valueName = Buffer.from(`${name}\0`, 'utf16le');
      const type = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
      const byteLength = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
      const queryStatus = regGetValue(
        HKEY_CURRENT_USER,
        ptr(subKey),
        ptr(valueName),
        RRF_RT_REG_SZ,
        ptr(type),
        0,
        ptr(byteLength),
      );
      if (!Number.isInteger(queryStatus)) throw disabled();
      if (queryStatus === ERROR_FILE_NOT_FOUND) return null;
      if (queryStatus !== 0) throw disabled();
      const queriedLength = byteLength.readUInt32LE(0);
      if (
        type.readUInt32LE(0) !== REG_SZ
        || queriedLength < Uint16Array.BYTES_PER_ELEMENT
        || queriedLength > MAX_REGISTRY_PATH_BYTES
        || queriedLength % Uint16Array.BYTES_PER_ELEMENT !== 0
      ) {
        throw disabled();
      }

      const valueBytes = Buffer.alloc(queriedLength);
      type.writeUInt32LE(0, 0);
      byteLength.writeUInt32LE(queriedLength, 0);
      const readStatus = regGetValue(
        HKEY_CURRENT_USER,
        ptr(subKey),
        ptr(valueName),
        RRF_RT_REG_SZ,
        ptr(type),
        ptr(valueBytes),
        ptr(byteLength),
      );
      if (!Number.isInteger(readStatus) || readStatus !== 0) throw disabled();
      const returnedLength = byteLength.readUInt32LE(0);
      if (
        type.readUInt32LE(0) !== REG_SZ
        || returnedLength < Uint16Array.BYTES_PER_ELEMENT
        || returnedLength > queriedLength
        || returnedLength % Uint16Array.BYTES_PER_ELEMENT !== 0
        || valueBytes.readUInt16LE(returnedLength - Uint16Array.BYTES_PER_ELEMENT) !== 0
      ) {
        throw disabled();
      }
      const value = valueBytes.subarray(
        0,
        returnedLength - Uint16Array.BYTES_PER_ELEMENT,
      ).toString('utf16le');
      if (value.includes('\0') || !path.isAbsolute(value)) throw disabled();
      return value;
    };
  }
  return {
    dataDir: readWin32RegistryValue(DATA_DIR_VALUE),
    exportDir: readWin32RegistryValue(EXPORT_DIR_VALUE),
  };
}

function readPersistentPortableRoots() {
  const store = createPathStore();
  if (!store || typeof store.get !== 'function') throw disabled();
  const values = [DATA_DIR_VALUE, EXPORT_DIR_VALUE].map((name) => {
    const value = store.get(name);
    if (value === null) return null;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw disabled();
    return value;
  });
  return { dataDir: values[0], exportDir: values[1] };
}

function assertNotUserRoot(root) {
  const persistent = process.platform === 'win32'
    ? readPersistentWindowsRoots()
    : readPersistentPortableRoots();
  const storage = process.platform === 'win32'
    ? {
      dataDir: path.resolve(
        process.env.MYTHPEN_DATA_DIR
          || persistent.dataDir
          || path.join(os.homedir(), '.mythpen'),
      ),
      exportDir: null,
    }
    : resolveStoragePaths();
  if (process.platform === 'win32') {
    storage.exportDir = path.resolve(
      process.env.MYTHPEN_EXPORT_DIR
        || persistent.exportDir
        || path.join(storage.dataDir, 'exports'),
    );
  }
  const forbidden = [
    os.homedir(),
    path.join(os.homedir(), '.mythpen'),
    path.join(os.homedir(), '.mythpen', 'exports'),
    process.env.MYTHPEN_DATA_DIR,
    process.env.MYTHPEN_EXPORT_DIR,
    storage.dataDir,
    storage.exportDir,
    persistent.dataDir,
    persistent.exportDir,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  if (forbidden.some((value) => canonicalPath(value) === canonicalPath(root))) throw disabled();
}

function fixtureState() {
  const state = globalThis[STATE_KEY];
  if (!(state instanceof Map)) throw disabled();
  return state;
}

function inspectFreshRecord(root, requiredState) {
  const record = fixtureState().get(root);
  if (!record || record.state !== requiredState) throw disabled();

  const tempParent = fs.realpathSync.native(os.tmpdir());
  if (
    canonicalPath(path.dirname(root)) !== canonicalPath(tempParent)
    || !path.basename(root).startsWith(FIXTURE_ROOT_PREFIX)
    || canonicalPath(fs.realpathSync.native(root)) !== canonicalPath(root)
    || !sameIdentity(fileIdentity(root, 'directory'), record.rootIdentity)
    || JSON.stringify(fs.readdirSync(root)) !== JSON.stringify([MARKER_NAME])
  ) {
    throw disabled();
  }
  assertNotUserRoot(root);

  const markerPath = path.join(root, MARKER_NAME);
  if (canonicalPath(markerPath) !== canonicalPath(record.markerPath)) throw disabled();
  if (!sameIdentity(fileIdentity(markerPath, 'file'), record.markerIdentity)) throw disabled();
  const markerBytes = fs.readFileSync(markerPath);
  const marker = parseExactMarker(markerBytes);
  const now = Date.now();
  if (
    marker.runId !== record.runId
    || marker.rootDigest !== sha256(root)
    || marker.rootDigest !== record.rootDigest
    || marker.expiresAt !== record.expiresAt
    || marker.expiresAt <= now
    || marker.expiresAt > now + MARKER_TTL_MS
    || sha256(markerBytes) !== record.markerDigest
  ) {
    throw disabled();
  }
  return record;
}

function inspectRecordOrDisable(root, requiredState) {
  try {
    return inspectFreshRecord(root, requiredState);
  } catch (error) {
    if (error?.code === 'NATIVE_ACTIVATION_DISABLED') throw error;
    throw disabled();
  }
}

function authorizeNativeActivation(options = {}) {
  if (getBuildInfo().nativeActivationMode !== 'fixture_only') throw disabled();
  if (options === null || typeof options !== 'object' || typeof options.root !== 'string') {
    throw disabled();
  }
  if (options.beforeMutation !== undefined && typeof options.beforeMutation !== 'function') {
    throw disabled();
  }

  let root;
  try {
    const requestedRoot = path.resolve(options.root);
    fileIdentity(requestedRoot, 'directory');
    root = fs.realpathSync.native(requestedRoot);
    if (canonicalPath(requestedRoot) !== canonicalPath(root)) throw disabled();
  } catch {
    throw disabled();
  }
  const record = inspectRecordOrDisable(root, 'fresh');
  record.state = 'validated';
  const consume = Object.freeze(function consume() {
    const current = inspectRecordOrDisable(root, 'validated');
    current.state = 'consuming';
    if (options.beforeMutation) options.beforeMutation();
    try {
      fs.unlinkSync(current.markerPath);
      current.state = 'consumed';
    } catch (error) {
      current.state = 'disabled';
      throw disabled();
    }
    const receipt = Object.freeze({
      root,
      runId: current.runId,
      markerDigest: current.markerDigest,
    });
    consumedReceipts.add(receipt);
    return receipt;
  });
  return Object.freeze({
    root,
    runId: record.runId,
    markerDigest: record.markerDigest,
    consume,
  });
}

module.exports = {
  authorizeNativeActivation,
};

Object.defineProperty(module.exports, 'assertNativeStageCFixtureReopenRoot', {
  value(root) {
    if (getBuildInfo().nativeActivationMode !== 'fixture_only' || typeof root !== 'string') {
      throw disabled();
    }
    let canonicalRoot;
    try {
      const requestedRoot = path.resolve(root);
      fileIdentity(requestedRoot, 'directory');
      canonicalRoot = fs.realpathSync.native(requestedRoot);
      if (
        canonicalPath(requestedRoot) !== canonicalPath(canonicalRoot)
        || canonicalPath(path.dirname(canonicalRoot)) !== canonicalPath(fs.realpathSync.native(os.tmpdir()))
        || !path.basename(canonicalRoot).startsWith(FIXTURE_ROOT_PREFIX)
        || fs.existsSync(path.join(canonicalRoot, MARKER_NAME))
      ) {
        throw disabled();
      }
      assertNotUserRoot(canonicalRoot);
      return canonicalRoot;
    } catch (error) {
      if (error?.code === 'NATIVE_ACTIVATION_DISABLED') throw error;
      throw disabled();
    }
  },
  enumerable: false,
  writable: false,
  configurable: false,
});

Object.defineProperty(module.exports, 'assertConsumedNativeActivationReceipt', {
  value(receipt) {
    if (!consumedReceipts.has(receipt)) throw disabled();
    return receipt;
  },
  enumerable: false,
  writable: false,
  configurable: false,
});
