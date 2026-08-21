'use strict';

const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const { manuscriptError } = require('../manuscript/contracts');
const { inspectPath } = require('./durability');

const PLATFORM_IDENTITY_KEYS = Object.freeze([
  'canonicalRealMythpenDirectory',
  'articleRootDirectoryIdentity',
  'mythpenDirectoryIdentity',
  'volumesDirectoryIdentity',
  'chaptersDirectoryIdentity',
]);
const PHYSICAL_IDENTITY_KEYS = Object.freeze(['dev', 'ino']);
const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9]\d*)$/;
const FEED_IDS = Object.freeze(['mythpen', 'volumes', 'chapters']);
const MAX_ARMED_FILE_PROJECTS_PER_PROCESS = 1;
const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_SHARE_READ_WRITE = 0x00000003;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const WATCH_FLAGS = FILE_FLAG_BACKUP_SEMANTICS
  | FILE_FLAG_OPEN_REPARSE_POINT
  | FILE_FLAG_OVERLAPPED;
const NOTIFY_FILTER = 0x0000005f;
const ERROR_OPERATION_ABORTED = 995;
const ERROR_IO_INCOMPLETE = 996;
const ERROR_IO_PENDING = 997;
const ERROR_NOTIFY_ENUM_DIR = 1022;
const ERROR_NOT_FOUND = 1168;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xffffffff;
const INVALID_HANDLE = 0xffffffffffffffffn;
const BY_HANDLE_FILE_INFORMATION_SIZE = 52;
const OVERLAPPED_SIZE_X64 = 32;
const BUFFER_BYTE_LENGTH = 1024 * 1024;
const ACTION_NAMES = Object.freeze(new Map([
  [1, 'ADDED'],
  [2, 'REMOVED'],
  [3, 'MODIFIED'],
  [4, 'RENAMED_OLD_NAME'],
  [5, 'RENAMED_NEW_NAME'],
]));
const NO_SLOT = Object.freeze({ outcome: 'NO_SLOT' });
const CLOSED = Object.freeze({ disposition: 'CLOSED' });
const ownerRecords = new WeakMap();
const handleInstanceRecords = new WeakMap();
const completionRecords = new WeakMap();
const resultBrands = new WeakSet();

let nativeRuntime;
let nativeLoadError;
let activeSlot = null;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFrozenDataValues(value, expectedKeys) {
  if (!isPlainObject(value) || !Object.isFrozen(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    return undefined;
  }
  const values = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      return undefined;
    }
    values[key] = descriptor.value;
  }
  return values;
}

function requirePhysicalIdentity(value) {
  const values = exactFrozenDataValues(value, PHYSICAL_IDENTITY_KEYS);
  if (
    values === undefined
    || typeof values.dev !== 'string'
    || !CANONICAL_DECIMAL_PATTERN.test(values.dev)
    || typeof values.ino !== 'string'
    || !CANONICAL_DECIMAL_PATTERN.test(values.ino)
  ) {
    throw new TypeError('Physical identity must be an exact frozen canonical dev/ino object');
  }
}

function requirePlatformIdentity(value) {
  const values = exactFrozenDataValues(value, PLATFORM_IDENTITY_KEYS);
  if (values === undefined) {
    throw new TypeError('Change-feed platform identity must be one exact frozen five-key object');
  }
  const canonical = values.canonicalRealMythpenDirectory;
  if (
    typeof canonical !== 'string'
    || canonical.length === 0
    || canonical.includes('\0')
    || !path.isAbsolute(canonical)
    || path.resolve(canonical) !== canonical
    || path.normalize(canonical) !== canonical
    || path.basename(canonical) !== 'mythpen'
  ) {
    throw new TypeError('Mythpen directory must be one absolute normalized canonical-real path');
  }
  requirePhysicalIdentity(values.articleRootDirectoryIdentity);
  requirePhysicalIdentity(values.mythpenDirectoryIdentity);
  requirePhysicalIdentity(values.volumesDirectoryIdentity);
  requirePhysicalIdentity(values.chaptersDirectoryIdentity);
  return value;
}

function defineImmutable(object, name, value) {
  Object.defineProperty(object, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}

function changeFeedError(cause, dispositionUnknown = false) {
  const error = manuscriptError(
    'MANUSCRIPT_LIFECYCLE_UNAVAILABLE',
    dispositionUnknown
      ? { releaseDispositionUnknown: true, subsystem: 'CHANGE_FEED' }
      : { subsystem: 'CHANGE_FEED' },
    cause,
  );
  if (dispositionUnknown) defineImmutable(error, 'releaseDispositionUnknown', true);
  return error;
}

function nativeCause(operation, win32Code) {
  const error = new Error(`${operation} failed with Win32 error ${win32Code}`);
  defineImmutable(error, 'win32Code', win32Code);
  return error;
}

function unavailableResult(cause, closeDisposition = 'KNOWN_CLOSED') {
  const dispositionUnknown = closeDisposition === 'UNKNOWN';
  const error = cause?.code === 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE'
    && (cause?.releaseDispositionUnknown === true) === dispositionUnknown
    ? cause
    : changeFeedError(cause, dispositionUnknown);
  const result = Object.freeze({ outcome: 'UNAVAILABLE', error, closeDisposition });
  resultBrands.add(result);
  return result;
}

function openedResult(owner) {
  const result = Object.freeze({ outcome: 'OPENED', owner });
  resultBrands.add(result);
  return result;
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

function frozenAbi(FFIType) {
  const entry = (args, returns) => Object.freeze({ args: Object.freeze(args), returns });
  return Object.freeze({
    CreateFileW: entry([
      FFIType.ptr,
      FFIType.u32,
      FFIType.u32,
      FFIType.ptr,
      FFIType.u32,
      FFIType.u32,
      FFIType.ptr,
    ], FFIType.u64),
    CreateEventW: entry([FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr], FFIType.u64),
    ResetEvent: entry([FFIType.u64], FFIType.i32),
    ReadDirectoryChangesW: entry([
      FFIType.u64,
      FFIType.ptr,
      FFIType.u32,
      FFIType.i32,
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ], FFIType.i32),
    WaitForSingleObject: entry([FFIType.u64, FFIType.u32], FFIType.u32),
    GetOverlappedResult: entry([
      FFIType.u64,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.i32,
    ], FFIType.i32),
    CancelIoEx: entry([FFIType.u64, FFIType.ptr], FFIType.i32),
    GetFileInformationByHandle: entry([FFIType.u64, FFIType.ptr], FFIType.i32),
    CloseHandle: entry([FFIType.u64], FFIType.i32),
    GetLastError: entry([], FFIType.u32),
  });
}

function loadNativeRuntime() {
  if (nativeRuntime !== undefined) return nativeRuntime;
  if (nativeLoadError !== undefined) throw nativeLoadError;
  try {
    const { dlopen, FFIType, ptr } = require('bun:ffi');
    if (typeof dlopen !== 'function' || typeof ptr !== 'function') {
      throw new TypeError('bun:ffi does not expose dlopen and ptr');
    }
    const library = dlopen('kernel32.dll', frozenAbi(FFIType));
    const k32 = library?.symbols;
    for (const name of [
      'CreateFileW',
      'CreateEventW',
      'ResetEvent',
      'ReadDirectoryChangesW',
      'WaitForSingleObject',
      'GetOverlappedResult',
      'CancelIoEx',
      'GetFileInformationByHandle',
      'CloseHandle',
      'GetLastError',
    ]) {
      if (typeof k32?.[name] !== 'function') throw new TypeError(`Missing Win32 symbol: ${name}`);
    }
    nativeRuntime = Object.freeze({ library, k32, ptr });
    return nativeRuntime;
  } catch (cause) {
    nativeLoadError = cause;
    throw cause;
  }
}

function requireI32(value, operation) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new TypeError(`${operation} returned an invalid 32-bit result`);
  }
  return value;
}

function requireU32(value, operation) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError(`${operation} returned an invalid u32 result`);
  }
  return value;
}

function requireBool(value, operation) {
  const result = requireI32(value, operation);
  if (result !== 0 && result !== 1) throw new TypeError(`${operation} returned an invalid BOOL`);
  return result;
}

function lastError(runtime) {
  const value = runtime.k32.GetLastError();
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError('GetLastError returned an invalid u32 result');
  }
  return value;
}

function normalizedHandle(value, operation, { allowNull = false } = {}) {
  let handle;
  if (typeof value === 'bigint') {
    handle = BigInt.asUintN(64, value);
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    handle = BigInt(value);
  } else {
    throw new TypeError(`${operation} returned an invalid u64 handle`);
  }
  if ((!allowNull && handle === 0n) || handle === INVALID_HANDLE) {
    return null;
  }
  return handle;
}

function identityForFeed(identity, feedId) {
  return identity[`${feedId}DirectoryIdentity`];
}

function pathForFeed(identity, feedId) {
  if (feedId === 'mythpen') return identity.canonicalRealMythpenDirectory;
  return path.join(identity.canonicalRealMythpenDirectory, feedId);
}

function verifyPathFact(identity, feedId) {
  const targetPath = pathForFeed(identity, feedId);
  const expectedParentPath = feedId === 'mythpen'
    ? path.dirname(identity.canonicalRealMythpenDirectory)
    : identity.canonicalRealMythpenDirectory;
  const expectedParentIdentity = feedId === 'mythpen'
    ? identity.articleRootDirectoryIdentity
    : identity.mythpenDirectoryIdentity;
  const expectedIdentity = identityForFeed(identity, feedId);
  const observation = inspectPath(targetPath);
  if (
    observation === null
    || typeof observation !== 'object'
    || observation.actualName !== path.basename(targetPath)
    || observation.kind !== 'directory'
    || observation.linkCount !== null
    || observation.reparse !== false
    || observation.realPath !== targetPath
    || observation.parentRealPath !== expectedParentPath
    || observation.identity?.dev !== expectedIdentity.dev
    || observation.identity?.ino !== expectedIdentity.ino
    || observation.parentIdentity?.dev !== expectedParentIdentity.dev
    || observation.parentIdentity?.ino !== expectedParentIdentity.ino
  ) {
    throw new TypeError(`Pinned ${feedId} directory or parent facts changed`);
  }
}

function verifyAllPathFacts(identity) {
  for (const feedId of FEED_IDS) verifyPathFact(identity, feedId);
}

function handleInformation(runtime, handle) {
  const allocation = alignedBytes(BY_HANDLE_FILE_INFORMATION_SIZE);
  const result = requireBool(
    runtime.k32.GetFileInformationByHandle(handle, runtime.ptr(allocation.bytes)),
    'GetFileInformationByHandle',
  );
  if (result === 0) {
    throw nativeCause('GetFileInformationByHandle', lastError(runtime));
  }
  const fileIndex = (
    (BigInt(allocation.bytes.readUInt32LE(44)) << 32n)
    | BigInt(allocation.bytes.readUInt32LE(48))
  );
  return Object.freeze({
    attributes: allocation.bytes.readUInt32LE(0),
    dev: String(allocation.bytes.readUInt32LE(28)),
    ino: String(fileIndex),
  });
}

function verifyWatchedHandle(runtime, handle, expectedIdentity, feedId) {
  const actual = handleInformation(runtime, handle);
  if (
    actual.dev !== expectedIdentity.dev
    || actual.ino !== expectedIdentity.ino
    || (actual.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0
    || (actual.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
  ) {
    throw new TypeError(`Watched ${feedId} handle no longer identifies the expected plain directory`);
  }
}

function issueRead(runtime, stream, bufferIndex) {
  stream.overlapped.bytes.fill(0);
  stream.overlapped.bytes.writeBigUInt64LE(stream.eventHandle, 24);
  stream.transferred.bytes.fill(0);
  const reset = requireBool(runtime.k32.ResetEvent(stream.eventHandle), 'ResetEvent');
  if (reset === 0) throw nativeCause('ResetEvent', lastError(runtime));
  const result = requireBool(runtime.k32.ReadDirectoryChangesW(
    stream.handle,
    runtime.ptr(stream.buffers[bufferIndex].bytes),
    BUFFER_BYTE_LENGTH,
    0,
    NOTIFY_FILTER,
    0,
    runtime.ptr(stream.overlapped.bytes),
    0,
  ), 'ReadDirectoryChangesW');
  if (result === 0) {
    const code = lastError(runtime);
    if (code !== ERROR_IO_PENDING) throw nativeCause('ReadDirectoryChangesW', code);
  }
  stream.bufferIndex = bufferIndex;
  stream.pending = true;
}

function closeHandleOnce(runtime, handle) {
  try {
    const result = requireBool(runtime.k32.CloseHandle(handle), 'CloseHandle');
    return result === 0 ? nativeCause('CloseHandle', lastError(runtime)) : undefined;
  } catch (cause) {
    return cause;
  }
}

function terminalResult(runtime, stream, wait) {
  stream.transferred.bytes.fill(0);
  const result = requireBool(runtime.k32.GetOverlappedResult(
    stream.handle,
    runtime.ptr(stream.overlapped.bytes),
    runtime.ptr(stream.transferred.bytes),
    wait ? 1 : 0,
  ), 'GetOverlappedResult');
  const byteCount = stream.transferred.bytes.readUInt32LE(0);
  if (result !== 0) return Object.freeze({ success: true, error: null, byteCount });
  const error = lastError(runtime);
  if (error === ERROR_IO_INCOMPLETE) {
    throw new TypeError('Overlapped directory read has not reached a terminal state');
  }
  return Object.freeze({ success: false, error, byteCount: 0 });
}

function cancelToTerminal(runtime, stream) {
  let cancelError;
  try {
    const result = requireBool(runtime.k32.CancelIoEx(
      stream.handle,
      runtime.ptr(stream.overlapped.bytes),
    ), 'CancelIoEx');
    if (result === 0) cancelError = lastError(runtime);
  } catch (cause) {
    cancelError = cause;
  }
  try {
    return terminalResult(runtime, stream, true);
  } catch (cause) {
    if (cancelError === undefined || cancelError === ERROR_NOT_FOUND) throw cause;
    const error = new Error('Cancellation did not reach a known terminal state', { cause });
    defineImmutable(error, 'cancelError', cancelError);
    throw error;
  }
}

function cleanupStreams(runtime, streams) {
  const failures = [];
  const terminalStreams = new Set();
  for (const stream of streams) {
    if (stream.pending) {
      try {
        cancelToTerminal(runtime, stream);
        stream.pending = false;
        terminalStreams.add(stream);
      } catch (cause) {
        failures.push(cause);
      }
    } else {
      terminalStreams.add(stream);
    }
  }
  for (const stream of streams) {
    if (!terminalStreams.has(stream)) continue;
    if (stream.handle !== null) {
      const failure = closeHandleOnce(runtime, stream.handle);
      if (failure !== undefined) failures.push(failure);
    }
    if (stream.eventHandle !== null) {
      const failure = closeHandleOnce(runtime, stream.eventHandle);
      if (failure !== undefined) failures.push(failure);
    }
  }
  if (failures.length === 0) {
    for (const stream of streams) {
      stream.buffers.length = 0;
      stream.overlapped = null;
      stream.transferred = null;
    }
  }
  return failures;
}

function openStream(runtime, identity, feedId, streams) {
  const targetPath = pathForFeed(identity, feedId);
  const widePath = wideString(path.toNamespacedPath(targetPath));
  const rawHandle = runtime.k32.CreateFileW(
    runtime.ptr(widePath.bytes),
    FILE_LIST_DIRECTORY,
    FILE_SHARE_READ_WRITE,
    0,
    OPEN_EXISTING,
    WATCH_FLAGS,
    0,
  );
  const handle = normalizedHandle(rawHandle, 'CreateFileW');
  if (handle === null) throw nativeCause('CreateFileW', lastError(runtime));
  const stream = {
    feedId,
    handle,
    eventHandle: null,
    buffers: [],
    bufferIndex: 0,
    overlapped: null,
    transferred: null,
    pending: false,
    completion: null,
    instance: null,
  };
  streams.push(stream);
  verifyWatchedHandle(runtime, handle, identityForFeed(identity, feedId), feedId);
  const rawEvent = runtime.k32.CreateEventW(0, 1, 0, 0);
  const eventHandle = normalizedHandle(rawEvent, 'CreateEventW');
  if (eventHandle === null) throw nativeCause('CreateEventW', lastError(runtime));
  stream.eventHandle = eventHandle;
  stream.buffers = [alignedBytes(BUFFER_BYTE_LENGTH), alignedBytes(BUFFER_BYTE_LENGTH)];
  stream.overlapped = alignedBytes(OVERLAPPED_SIZE_X64);
  stream.transferred = alignedBytes(4);
  issueRead(runtime, stream, 0);
  return stream;
}

function feedId(value) {
  if (typeof value !== 'string' || !FEED_IDS.includes(value)) {
    throw new TypeError('feedId must be mythpen, volumes, or chapters');
  }
  return value;
}

function requireOwner(owner) {
  const record = ownerRecords.get(owner);
  if (record === undefined) throw new TypeError('Change-feed owner authority is invalid');
  return record;
}

function requireCompletion(ownerRecord, completion) {
  const record = completionRecords.get(completion);
  if (
    record === undefined
    || record.owner !== ownerRecord
    || record.stream.completion !== completion
    || record.retired
  ) {
    throw new TypeError('Change-feed completion authority is invalid or stale');
  }
  return record;
}

function mintInstance(ownerRecord, stream) {
  const instance = Object.freeze({});
  handleInstanceRecords.set(instance, Object.freeze({ owner: ownerRecord, stream }));
  return instance;
}

function mintCompletion(ownerRecord, stream, terminal) {
  const completion = Object.freeze({ feedId: stream.feedId, handleInstance: stream.instance });
  const record = {
    owner: ownerRecord,
    stream,
    terminal,
    bufferIndex: stream.bufferIndex,
    rearmAttempted: false,
    rearmed: false,
    decoded: false,
    retired: false,
  };
  completionRecords.set(completion, record);
  stream.completion = completion;
  stream.pending = false;
  return completion;
}

function validComponent(buffer, offset, byteLength) {
  let output = '';
  for (let index = 0; index < byteLength; index += 2) {
    const unit = buffer.readUInt16LE(offset + index);
    if (unit === 0) return undefined;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 2 >= byteLength) return undefined;
      const low = buffer.readUInt16LE(offset + index + 2);
      if (low < 0xdc00 || low > 0xdfff) return undefined;
      output += String.fromCharCode(unit, low);
      index += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return undefined;
    } else {
      output += String.fromCharCode(unit);
    }
  }
  if (
    output.length === 0
    || output === '.'
    || output === '..'
    || output.includes('/')
    || output.includes('\\')
  ) {
    return undefined;
  }
  return output;
}

function coverageLost(reason) {
  const result = Object.freeze({ outcome: 'COVERAGE_LOST', reason });
  resultBrands.add(result);
  return result;
}

function decodeBuffer(buffer, byteCount) {
  if (!Number.isInteger(byteCount) || byteCount <= 0 || byteCount > buffer.byteLength) {
    return coverageLost(byteCount === 0 ? 'ZERO_BYTE_COMPLETION' : 'MALFORMED_NOTIFICATION');
  }
  const records = [];
  let offset = 0;
  while (offset < byteCount) {
    if (byteCount - offset < 12) return coverageLost('MALFORMED_NOTIFICATION');
    const nextOffset = buffer.readUInt32LE(offset);
    const actionCode = buffer.readUInt32LE(offset + 4);
    const nameByteLength = buffer.readUInt32LE(offset + 8);
    const action = ACTION_NAMES.get(actionCode);
    const boundary = nextOffset === 0 ? byteCount - offset : nextOffset;
    if (
      action === undefined
      || nameByteLength === 0
      || nameByteLength % 2 !== 0
      || boundary < 12 + nameByteLength
      || (nextOffset !== 0 && (
        nextOffset % 4 !== 0
        || nextOffset >= byteCount - offset
      ))
    ) {
      return coverageLost('MALFORMED_NOTIFICATION');
    }
    const component = validComponent(buffer, offset + 12, nameByteLength);
    if (component === undefined) return coverageLost('MALFORMED_NOTIFICATION');
    records.push(Object.freeze({ action, component }));
    if (nextOffset === 0) {
      const result = Object.freeze({ outcome: 'RECORDS', records: Object.freeze(records) });
      resultBrands.add(result);
      return result;
    }
    offset += nextOffset;
  }
  return coverageLost('MALFORMED_NOTIFICATION');
}

function decodeTerminal(completionRecord) {
  const { terminal, stream, bufferIndex } = completionRecord;
  if (!terminal.success) {
    if (terminal.error === ERROR_NOTIFY_ENUM_DIR) return coverageLost('NOTIFY_ENUM_DIR');
    if (terminal.error === ERROR_OPERATION_ABORTED) return coverageLost('OPERATION_ABORTED');
    return coverageLost('COMPLETION_FAILED');
  }
  return decodeBuffer(stream.buffers[bufferIndex].bytes, terminal.byteCount);
}

function closeOwner(ownerRecord) {
  if (ownerRecord.state !== 'STOPPING') {
    throw new TypeError('Change-feed owner must be stopping before close');
  }
  if (ownerRecord.streams.some((stream) => stream.pending || stream.completion !== null)) {
    throw new TypeError('Every terminal completion must be retired before close');
  }
  const failures = [];
  for (const stream of ownerRecord.streams) {
    const directoryFailure = closeHandleOnce(ownerRecord.runtime, stream.handle);
    if (directoryFailure !== undefined) failures.push(directoryFailure);
    const eventFailure = closeHandleOnce(ownerRecord.runtime, stream.eventHandle);
    if (eventFailure !== undefined) failures.push(eventFailure);
  }
  if (failures.length !== 0) {
    const error = changeFeedError(failures[0], true);
    if (failures.length > 1) defineImmutable(error, 'secondaryErrors', Object.freeze(failures.slice(1)));
    ownerRecord.state = 'CLOSE_DISPOSITION_UNKNOWN';
    activeSlot = Object.freeze({ state: 'UNKNOWN', key: ownerRecord.key, error, ownerRecord });
    throw error;
  }
  for (const stream of ownerRecord.streams) {
    stream.buffers.length = 0;
    stream.overlapped = null;
    stream.transferred = null;
  }
  ownerRecord.state = 'CLOSED';
  if (activeSlot?.ownerRecord === ownerRecord) activeSlot = null;
  return CLOSED;
}

function mintOwner(runtime, key, streams) {
  const owner = {};
  const ownerRecord = { owner, runtime, key, streams, state: 'ARMED' };
  for (const stream of streams) stream.instance = mintInstance(ownerRecord, stream);
  Object.defineProperties(owner, {
    state: {
      enumerable: true,
      get() { return requireOwner(this).state; },
    },
    feedInstance: {
      enumerable: true,
      value(requestedFeedId) {
        const record = requireOwner(this);
        return record.streams.find((stream) => stream.feedId === feedId(requestedFeedId)).instance;
      },
    },
    probeEvents: {
      enumerable: true,
      value() {
        const record = requireOwner(this);
        if (record.state !== 'ARMED') throw new TypeError('Change-feed owner is not armed');
        const values = {};
        for (const stream of record.streams) {
          if (!stream.pending || stream.completion !== null) {
            values[stream.feedId] = false;
            continue;
          }
          const result = requireU32(
            record.runtime.k32.WaitForSingleObject(stream.eventHandle, 0),
            'WaitForSingleObject',
          );
          if (result === WAIT_OBJECT_0) values[stream.feedId] = true;
          else if (result === WAIT_TIMEOUT) values[stream.feedId] = false;
          else if (result === WAIT_FAILED) {
            throw changeFeedError(nativeCause('WaitForSingleObject', lastError(record.runtime)));
          } else throw changeFeedError(new TypeError('WaitForSingleObject returned an unexpected value'));
        }
        return Object.freeze(values);
      },
    },
    takeCompletion: {
      enumerable: true,
      value(requestedFeedId) {
        const record = requireOwner(this);
        if (!['ARMED', 'STOPPING'].includes(record.state)) {
          throw new TypeError('Change-feed owner cannot take completions');
        }
        const stream = record.streams.find((item) => item.feedId === feedId(requestedFeedId));
        if (stream.completion !== null) {
          throw new TypeError('Previous completion must be retired before taking another');
        }
        if (!stream.pending) return null;
        const wait = requireU32(
          record.runtime.k32.WaitForSingleObject(stream.eventHandle, 0),
          'WaitForSingleObject',
        );
        if (wait === WAIT_TIMEOUT) return null;
        if (wait === WAIT_FAILED) {
          throw changeFeedError(nativeCause('WaitForSingleObject', lastError(record.runtime)));
        }
        if (wait !== WAIT_OBJECT_0) {
          throw changeFeedError(new TypeError('WaitForSingleObject returned an unexpected value'));
        }
        try {
          return mintCompletion(record, stream, terminalResult(record.runtime, stream, false));
        } catch (cause) {
          throw changeFeedError(cause);
        }
      },
    },
    rearm: {
      enumerable: true,
      value(completion) {
        const record = requireOwner(this);
        if (record.state !== 'ARMED') throw new TypeError('Change-feed owner is stopping');
        const completed = requireCompletion(record, completion);
        if (completed.rearmed || completed.rearmAttempted) {
          throw new TypeError('Completion was already used for a rearm attempt');
        }
        completed.rearmAttempted = true;
        try {
          issueRead(record.runtime, completed.stream, 1 - completed.bufferIndex);
        } catch (cause) {
          throw changeFeedError(cause);
        }
        completed.rearmed = true;
        return completed.stream.instance;
      },
    },
    decode: {
      enumerable: true,
      value(completion) {
        const record = requireOwner(this);
        const completed = requireCompletion(record, completion);
        if (completed.decoded) throw new TypeError('Completion was already decoded');
        if (record.state === 'ARMED' && !completed.rearmAttempted) {
          throw new TypeError('Armed completion must be rearmed before decode');
        }
        const result = decodeTerminal(completed);
        completed.decoded = true;
        return result;
      },
    },
    retireCompletion: {
      enumerable: true,
      value(completion) {
        const record = requireOwner(this);
        const completed = requireCompletion(record, completion);
        if (!completed.decoded) throw new TypeError('Completion must be decoded before retirement');
        completed.retired = true;
        completed.stream.completion = null;
      },
    },
    beginStopping: {
      enumerable: true,
      value() {
        const record = requireOwner(this);
        if (record.state !== 'ARMED') throw new TypeError('Change-feed owner cannot begin stopping');
        record.state = 'STOPPING';
      },
    },
    cancelPending: {
      enumerable: true,
      value(requestedFeedId) {
        const record = requireOwner(this);
        if (record.state !== 'STOPPING') throw new TypeError('Change-feed owner is not stopping');
        const stream = record.streams.find((item) => item.feedId === feedId(requestedFeedId));
        if (stream.completion !== null) {
          if (stream.pending) {
            throw new TypeError('Outstanding completion must be retired before cancelling rearmed IO');
          }
          return null;
        }
        if (!stream.pending) return null;
        try {
          return mintCompletion(record, stream, cancelToTerminal(record.runtime, stream));
        } catch (cause) {
          const error = changeFeedError(cause, true);
          record.state = 'CLOSE_DISPOSITION_UNKNOWN';
          activeSlot = Object.freeze({
            state: 'UNKNOWN',
            key: record.key,
            error,
            ownerRecord: record,
          });
          throw error;
        }
      },
    },
    close: {
      enumerable: true,
      value() { return closeOwner(requireOwner(this)); },
    },
  });
  ownerRecords.set(owner, ownerRecord);
  return Object.freeze(owner);
}

function openOwner(identity) {
  const key = `${identity.mythpenDirectoryIdentity.dev}:${identity.mythpenDirectoryIdentity.ino}`;
  if (MAX_ARMED_FILE_PROJECTS_PER_PROCESS !== 1) {
    return unavailableResult(new TypeError('Invalid module slot configuration'));
  }
  if (activeSlot !== null) {
    if (activeSlot.state === 'UNKNOWN') return unavailableResult(activeSlot.error, 'UNKNOWN');
    return NO_SLOT;
  }
  activeSlot = Object.freeze({ state: 'OPENING', key });
  let runtime;
  const streams = [];
  let primaryError;
  try {
    verifyAllPathFacts(identity);
    runtime = loadNativeRuntime();
    for (const requestedFeedId of FEED_IDS) {
      openStream(runtime, identity, requestedFeedId, streams);
    }
    verifyAllPathFacts(identity);
    const owner = mintOwner(runtime, key, streams);
    const ownerRecord = ownerRecords.get(owner);
    activeSlot = Object.freeze({ state: 'LIVE', key, ownerRecord });
    return openedResult(owner);
  } catch (cause) {
    primaryError = cause;
  }
  if (runtime === undefined) {
    activeSlot = null;
    return unavailableResult(primaryError);
  }
  const cleanupFailures = cleanupStreams(runtime, streams);
  if (cleanupFailures.length !== 0) {
    const error = changeFeedError(cleanupFailures[0], true);
    defineImmutable(error, 'admissionError', primaryError);
    if (cleanupFailures.length > 1) {
      defineImmutable(error, 'secondaryErrors', Object.freeze(cleanupFailures.slice(1)));
    }
    activeSlot = Object.freeze({ state: 'UNKNOWN', key, error, streams });
    return unavailableResult(error, 'UNKNOWN');
  }
  activeSlot = null;
  return unavailableResult(primaryError);
}

function createWindowsManuscriptChangeFeedAdapter() {
  if (arguments.length !== 0) {
    throw new TypeError('createWindowsManuscriptChangeFeedAdapter accepts no arguments');
  }
  return Object.freeze({
    assertIdentity: requirePlatformIdentity,
    tryOpen(identity) { return openOwner(requirePlatformIdentity(identity)); },
  });
}

module.exports = { createWindowsManuscriptChangeFeedAdapter };
