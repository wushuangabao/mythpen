#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform, release, version } from 'node:os';
import path from 'node:path';
import { dlopen, FFIType, ptr } from 'bun:ffi';

const PROBE_VERSION = 3;
const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OVERLAPPED = 0x40000000;
const NOTIFY_FILTER = 0x0000005f;
const ERROR_IO_PENDING = 997;
const ERROR_OPERATION_ABORTED = 995;
const ERROR_NOTIFY_ENUM_DIR = 1022;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xffffffff;
const INVALID_HANDLE = 0xffffffffffffffffn;
const OVERLAPPED_SIZE_X64 = 32;
const EVENT_SAMPLE_LIMIT = 160;

const ACTION_NAMES = new Map([
  [1, 'added'],
  [2, 'removed'],
  [3, 'modified'],
  [4, 'renamed_old_name'],
  [5, 'renamed_new_name'],
]);

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseNonNegativeInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be non-negative`);
  return parsed;
}

function parseArguments(argv) {
  const options = {
    fastCount: 5_000,
    overflowCount: 20_000,
    pacedCount: 1_000,
    pacedDelayMilliseconds: 2,
    samePathWrites: 2_000,
    atomicIterations: 20,
    output: null,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fast-count') {
      options.fastCount = parsePositiveInteger(argv[++index], options.fastCount, argument);
    } else if (argument === '--overflow-count') {
      options.overflowCount = parsePositiveInteger(argv[++index], options.overflowCount, argument);
    } else if (argument === '--paced-count') {
      options.pacedCount = parsePositiveInteger(argv[++index], options.pacedCount, argument);
    } else if (argument === '--paced-delay-ms') {
      options.pacedDelayMilliseconds = parseNonNegativeInteger(
        argv[++index],
        options.pacedDelayMilliseconds,
        argument,
      );
    } else if (argument === '--same-path-writes') {
      options.samePathWrites = parsePositiveInteger(argv[++index], options.samePathWrites, argument);
    } else if (argument === '--atomic-iterations') {
      options.atomicIterations = parsePositiveInteger(argv[++index], options.atomicIterations, argument);
    } else if (argument === '--output') {
      const output = argv[++index];
      if (!output) throw new Error('--output requires a path');
      options.output = path.resolve(output);
    } else if (argument === '--keep') {
      options.keep = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function sleepSynchronously(milliseconds) {
  if (milliseconds <= 0) return;
  const storage = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(storage), 0, 0, milliseconds);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function uuidFor(index) {
  return `00000000-0000-4000-8000-${BigInt(index + 1).toString(16).padStart(12, '0')}`;
}

function chapterBasename(index) {
  return `ch_${uuidFor(index)}.md`;
}

function runInternalWriter(argv) {
  if (argv[0] !== '--internal-canonical-writer') return false;
  if (argv.length !== 4) throw new Error('Internal writer arguments are invalid');
  const directory = path.resolve(argv[1]);
  const count = parsePositiveInteger(argv[2], null, 'internal writer count');
  const delayMilliseconds = parseNonNegativeInteger(argv[3], null, 'internal writer delay');
  if (!existsSync(directory)) throw new Error('Internal writer target is missing');
  const startedAt = performance.now();
  for (let index = 0; index < count; index += 1) {
    writeFileSync(path.join(directory, chapterBasename(index)), 'x');
    sleepSynchronously(delayMilliseconds);
  }
  process.stdout.write(`${JSON.stringify({
    count,
    delayMilliseconds,
    milliseconds: Number((performance.now() - startedAt).toFixed(2)),
  })}\n`);
  return true;
}

if (runInternalWriter(process.argv.slice(2))) process.exit(0);

function runExternalWriter(directory, count, delayMilliseconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--internal-canonical-writer', directory, String(count), String(delayMilliseconds)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error(`External writer failed: code=${code}, signal=${signal}, stderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`External writer returned invalid JSON: ${error.message}`));
      }
    });
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

function isInvalidHandle(handle) {
  return BigInt.asUintN(64, BigInt(handle)) === INVALID_HANDLE;
}

function win32Error(operation, code) {
  const error = new Error(`${operation} failed with Win32 error ${code}`);
  error.win32Code = code;
  return error;
}

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
  CreateEventW: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.u64,
  },
  ResetEvent: { args: [FFIType.u64], returns: FFIType.i32 },
  ReadDirectoryChangesW: {
    args: [
      FFIType.u64,
      FFIType.ptr,
      FFIType.u32,
      FFIType.i32,
      FFIType.u32,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.ptr,
    ],
    returns: FFIType.i32,
  },
  WaitForSingleObject: {
    args: [FFIType.u64, FFIType.u32],
    returns: FFIType.u32,
  },
  GetOverlappedResult: {
    args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  CancelIoEx: {
    args: [FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
});

const k32 = library.symbols;

class NativeDirectoryFeed {
  constructor(specifications, bufferByteLength) {
    this.bufferByteLength = bufferByteLength;
    this.streams = [];
    this.events = [];
    this.dirtyPaths = new Set();
    this.lossSignals = [];
    this.coverageLost = false;
    this.coverageLossEpoch = 0;
    this.sequence = 0;
    this.closed = false;
    this.lastPumpResult = null;
    try {
      for (const specification of specifications) this.streams.push(this.#openStream(specification));
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #openStream(specification) {
    const namespacedPath = path.toNamespacedPath(path.resolve(specification.directory));
    const widePath = wideString(namespacedPath);
    const handle = k32.CreateFileW(
      ptr(widePath.bytes),
      FILE_LIST_DIRECTORY,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      0,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
      0,
    );
    if (isInvalidHandle(handle)) throw win32Error('CreateFileW(directory)', k32.GetLastError());
    const eventHandle = k32.CreateEventW(0, 1, 0, 0);
    if (!eventHandle || isInvalidHandle(eventHandle)) {
      const code = k32.GetLastError();
      k32.CloseHandle(handle);
      throw win32Error('CreateEventW', code);
    }
    const stream = {
      name: specification.name,
      directory: specification.directory,
      prefix: specification.prefix,
      widePath,
      handle,
      eventHandle,
      buffers: [alignedBytes(this.bufferByteLength), alignedBytes(this.bufferByteLength)],
      bufferIndex: 0,
      overlapped: alignedBytes(OVERLAPPED_SIZE_X64),
      bytesTransferred: alignedBytes(4),
      armed: false,
      completions: 0,
      records: 0,
      zeroByteCompletions: 0,
      completionErrors: [],
      rearmErrors: [],
    };
    this.#issue(stream, 'initial_arm');
    return stream;
  }

  #recordLoss(stream, kind, win32Code = null, detail = null) {
    this.coverageLost = true;
    this.coverageLossEpoch += 1;
    this.lossSignals.push({
      sequence: this.sequence++,
      stream: stream?.name || null,
      kind,
      win32Code,
      detail,
      milliseconds: Number(performance.now().toFixed(3)),
    });
  }

  #issue(stream, operation) {
    stream.overlapped.bytes.fill(0);
    stream.overlapped.bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(stream.eventHandle)), 24);
    stream.bytesTransferred.bytes.writeUInt32LE(0, 0);
    if (k32.ResetEvent(stream.eventHandle) === 0) {
      const code = k32.GetLastError();
      stream.rearmErrors.push({ operation: 'ResetEvent', win32Code: code });
      stream.armed = false;
      this.#recordLoss(stream, 'rearm_failed', code, operation);
      return false;
    }
    const result = k32.ReadDirectoryChangesW(
      stream.handle,
      ptr(stream.buffers[stream.bufferIndex].bytes),
      this.bufferByteLength,
      0,
      NOTIFY_FILTER,
      0,
      ptr(stream.overlapped.bytes),
      0,
    );
    if (result === 0) {
      const code = k32.GetLastError();
      if (code !== ERROR_IO_PENDING) {
        stream.rearmErrors.push({ operation: 'ReadDirectoryChangesW', win32Code: code });
        stream.armed = false;
        this.#recordLoss(stream, 'rearm_failed', code, operation);
        return false;
      }
    }
    stream.armed = true;
    return true;
  }

  #parse(stream, buffer, byteCount) {
    if (byteCount > buffer.byteLength) {
      this.#recordLoss(stream, 'invalid_completion_length', null, `${byteCount}>${buffer.byteLength}`);
      return;
    }
    let offset = 0;
    while (offset < byteCount) {
      if (byteCount - offset < 12) {
        this.#recordLoss(stream, 'malformed_notification', null, 'header_truncated');
        return;
      }
      const nextOffset = buffer.readUInt32LE(offset);
      const action = buffer.readUInt32LE(offset + 4);
      const filenameByteLength = buffer.readUInt32LE(offset + 8);
      const minimumRecordLength = 12 + filenameByteLength;
      const recordBoundary = nextOffset === 0 ? byteCount - offset : nextOffset;
      if (
        !ACTION_NAMES.has(action)
        || filenameByteLength === 0
        || filenameByteLength % 2 !== 0
        || recordBoundary < minimumRecordLength
        || offset + recordBoundary > byteCount
        || (nextOffset !== 0 && nextOffset % 4 !== 0)
      ) {
        this.#recordLoss(stream, 'malformed_notification', null, 'record_boundary');
        return;
      }
      const basename = buffer.toString('utf16le', offset + 12, offset + minimumRecordLength);
      if (!basename || basename.includes('\0') || basename.includes('/') || basename.includes('\\')) {
        this.#recordLoss(stream, 'malformed_notification', null, 'invalid_filename');
        return;
      }
      const relativePath = stream.prefix ? `${stream.prefix}/${basename}` : basename;
      stream.records += 1;
      this.dirtyPaths.add(relativePath);
      if (this.events.length < EVENT_SAMPLE_LIMIT) {
        this.events.push({
          sequence: this.sequence,
          stream: stream.name,
          action: ACTION_NAMES.get(action),
          relativePath,
          milliseconds: Number(performance.now().toFixed(3)),
        });
      }
      this.sequence += 1;
      if (nextOffset === 0) break;
      offset += nextOffset;
    }
  }

  #complete(stream, rearm) {
    const waitResult = k32.WaitForSingleObject(stream.eventHandle, 0);
    if (waitResult === WAIT_TIMEOUT) return false;
    if (waitResult === WAIT_FAILED) {
      const code = k32.GetLastError();
      stream.armed = false;
      this.#recordLoss(stream, 'wait_failed', code);
      return false;
    }
    if (waitResult !== WAIT_OBJECT_0) {
      stream.armed = false;
      this.#recordLoss(stream, 'unexpected_wait_result', null, String(waitResult));
      return false;
    }
    stream.bytesTransferred.bytes.writeUInt32LE(0, 0);
    const completedIndex = stream.bufferIndex;
    const completionResult = k32.GetOverlappedResult(
      stream.handle,
      ptr(stream.overlapped.bytes),
      ptr(stream.bytesTransferred.bytes),
      0,
    );
    const byteCount = stream.bytesTransferred.bytes.readUInt32LE(0);
    stream.armed = false;
    stream.completions += 1;
    let completionCode = null;
    if (completionResult === 0) {
      completionCode = k32.GetLastError();
      stream.completionErrors.push(completionCode);
      this.#recordLoss(
        stream,
        completionCode === ERROR_NOTIFY_ENUM_DIR ? 'error_notify_enum_dir' : 'completion_failed',
        completionCode,
      );
    } else if (byteCount === 0) {
      stream.zeroByteCompletions += 1;
      this.#recordLoss(stream, 'zero_byte_completion');
    }
    if (rearm) {
      stream.bufferIndex = 1 - completedIndex;
      this.#issue(stream, 'completion_rearm');
    }
    if (completionResult !== 0 && byteCount > 0) {
      this.#parse(stream, stream.buffers[completedIndex].bytes, byteCount);
    }
    return true;
  }

  pumpAll(maximumCompletions = 10_000) {
    let total = 0;
    let progress = true;
    let finalNoProgressPass = null;
    while (progress && total < maximumCompletions) {
      progress = false;
      const nonsignaledStreams = [];
      let firstNonsignaledSampleMilliseconds = null;
      for (const stream of this.streams) {
        if (stream.armed && this.#complete(stream, true)) {
          total += 1;
          progress = true;
        } else if (stream.armed) {
          if (firstNonsignaledSampleMilliseconds === null) {
            firstNonsignaledSampleMilliseconds = Number(performance.now().toFixed(3));
          }
          nonsignaledStreams.push(stream.name);
        }
      }
      if (!progress) {
        const allStreamsArmed = this.streams.every((stream) => stream.armed);
        finalNoProgressPass = Object.freeze({
          establishedAtMilliseconds: firstNonsignaledSampleMilliseconds,
          allStreamsArmed,
          nonsignaledStreams: Object.freeze([...nonsignaledStreams]),
          allEventsNonsignaledAtLinearization: allStreamsArmed
            && nonsignaledStreams.length === this.streams.length,
          coverageLost: this.coverageLost,
          coverageLossEpoch: this.coverageLossEpoch,
          dirtyPathCount: this.dirtyPaths.size,
        });
      }
    }
    const completionLimitReached = total >= maximumCompletions;
    if (completionLimitReached) {
      this.#recordLoss(null, 'pump_completion_limit');
      finalNoProgressPass = null;
    }
    const result = Object.freeze({
      completionsProcessed: total,
      completionLimitReached,
      linearizationSnapshot: finalNoProgressPass,
    });
    this.lastPumpResult = result;
    return result;
  }

  isSignaled(name) {
    const stream = this.streams.find((item) => item.name === name);
    if (!stream || !stream.armed) return false;
    return k32.WaitForSingleObject(stream.eventHandle, 0) === WAIT_OBJECT_0;
  }

  completeWithoutRearmForTest(name) {
    const stream = this.streams.find((item) => item.name === name);
    if (!stream) throw new Error(`Unknown stream: ${name}`);
    if (!this.#complete(stream, false)) throw new Error(`${name} did not have a completion`);
  }

  rearmForTest(name) {
    const stream = this.streams.find((item) => item.name === name);
    if (!stream || stream.armed) throw new Error(`${name} is not waiting for a test rearm`);
    stream.bufferIndex = 1 - stream.bufferIndex;
    return this.#issue(stream, 'test_gap_rearm');
  }

  #synchronizationProvesContinuousCoverage(pumpResult) {
    const snapshot = pumpResult.linearizationSnapshot;
    return snapshot !== null
      && snapshot.allStreamsArmed
      && snapshot.allEventsNonsignaledAtLinearization
      && !snapshot.coverageLost;
  }

  synchronizeCoverage() {
    const pumpResult = this.pumpAll();
    return Object.freeze({
      ...pumpResult,
      canReportContinuousCoverage: this.#synchronizationProvesContinuousCoverage(pumpResult),
    });
  }

  snapshot() {
    return {
      bufferByteLength: this.bufferByteLength,
      coverageLost: this.coverageLost,
      coverageLossEpoch: this.coverageLossEpoch,
      lastPumpResult: this.lastPumpResult,
      dirtyPathCount: this.dirtyPaths.size,
      lossSignals: this.lossSignals,
      streams: this.streams.map((stream) => ({
        name: stream.name,
        armed: stream.armed,
        completions: stream.completions,
        records: stream.records,
        zeroByteCompletions: stream.zeroByteCompletions,
        completionErrors: stream.completionErrors,
        rearmErrors: stream.rearmErrors,
      })),
      eventSample: this.events,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams) {
      if (stream.armed) {
        const result = k32.CancelIoEx(stream.handle, ptr(stream.overlapped.bytes));
        if (result === 0) {
          const code = k32.GetLastError();
          if (code !== ERROR_OPERATION_ABORTED) {
            stream.completionErrors.push(code);
          }
        }
      }
      k32.CloseHandle(stream.eventHandle);
      k32.CloseHandle(stream.handle);
      stream.armed = false;
    }
  }
}

function createTree(baseDirectory, name) {
  const root = path.join(baseDirectory, name);
  const mythpen = path.join(root, 'mythpen');
  const volumes = path.join(mythpen, 'volumes');
  const chapters = path.join(mythpen, 'chapters');
  mkdirSync(volumes, { recursive: true });
  mkdirSync(chapters, { recursive: true });
  return { root, mythpen, volumes, chapters };
}

function feedSpecifications(tree) {
  return [
    { name: 'mythpen', directory: tree.mythpen, prefix: '' },
    { name: 'volumes', directory: tree.volumes, prefix: 'volumes' },
    { name: 'chapters', directory: tree.chapters, prefix: 'chapters' },
  ];
}

async function drainUntilQuiet(feed, quietMilliseconds = 350, maximumMilliseconds = 15_000) {
  const startedAt = performance.now();
  let lastMetric = -1;
  let lastChangeAt = performance.now();
  while (performance.now() - startedAt < maximumMilliseconds) {
    feed.pumpAll();
    const snapshot = feed.snapshot();
    const metric = snapshot.dirtyPathCount
      + snapshot.coverageLossEpoch
      + snapshot.streams.reduce((total, stream) => total + stream.completions, 0);
    if (metric !== lastMetric) {
      lastMetric = metric;
      lastChangeAt = performance.now();
    }
    if (performance.now() - lastChangeAt >= quietMilliseconds) break;
    await sleep(5);
  }
  return Number((performance.now() - startedAt).toFixed(2));
}

async function waitUntilSignaled(feed, streamName, maximumMilliseconds = 5_000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < maximumMilliseconds) {
    if (feed.isSignaled(streamName)) return Number((performance.now() - startedAt).toFixed(2));
    await sleep(2);
  }
  throw new Error(`${streamName} did not signal within ${maximumMilliseconds} ms`);
}

async function runWithLivePump(feed, operation) {
  let pumpError = null;
  const timer = setInterval(() => {
    try {
      feed.pumpAll();
    } catch (error) {
      pumpError = error;
    }
  }, 1);
  try {
    const result = await operation;
    if (pumpError) throw pumpError;
    return result;
  } finally {
    clearInterval(timer);
  }
}

function expectedChapterPaths(count) {
  return Array.from({ length: count }, (_, index) => `chapters/${chapterBasename(index)}`);
}

function hasCompleteLinearizationSnapshot(synchronization) {
  return synchronization.linearizationSnapshot !== null
    && synchronization.linearizationSnapshot.allStreamsArmed
    && synchronization.linearizationSnapshot.allEventsNonsignaledAtLinearization;
}

function coverageAssessment(feed, expectedPaths) {
  const synchronization = feed.synchronizeCoverage();
  const continuousCoverageAfterSynchronization = synchronization.canReportContinuousCoverage;
  const linearizationSnapshotEstablished = hasCompleteLinearizationSnapshot(synchronization);
  const missing = expectedPaths.filter((item) => !feed.dirtyPaths.has(item));
  const falseClean = missing.length > 0 && continuousCoverageAfterSynchronization;
  return {
    expectedPathCount: expectedPaths.length,
    observedExpectedPathCount: expectedPaths.length - missing.length,
    missingPathCount: missing.length,
    missingPathSample: missing.slice(0, 20),
    explicitCoverageLost: feed.coverageLost,
    continuousCoverageAfterSynchronization,
    linearizationSnapshotEstablished,
    synchronization,
    falseClean,
    pass: linearizationSnapshotEstablished
      && !falseClean
      && (missing.length === 0 || feed.coverageLost),
  };
}

async function runReachability(baseDirectory) {
  const tree = createTree(baseDirectory, 'reachability');
  const feed = new NativeDirectoryFeed(feedSpecifications(tree), 1024 * 1024);
  try {
    const rootPath = 'manuscript.json';
    const volumePath = `volumes/vol_${uuidFor(0)}.json`;
    const chapterPath = `chapters/${chapterBasename(0)}`;
    writeFileSync(path.join(tree.mythpen, rootPath), '{}');
    writeFileSync(path.join(tree.volumes, path.basename(volumePath)), '{}');
    writeFileSync(path.join(tree.chapters, path.basename(chapterPath)), 'x');
    const drainMilliseconds = await drainUntilQuiet(feed);
    const expected = [rootPath, volumePath, chapterPath];
    const assessment = coverageAssessment(feed, expected);
    return { name: 'three_directory_reachability', drainMilliseconds, ...assessment, feed: feed.snapshot() };
  } finally {
    feed.close();
  }
}

async function runDistinctPressure(baseDirectory, options, paced) {
  const tree = createTree(baseDirectory, paced ? 'paced-distinct' : 'fast-distinct');
  const feed = new NativeDirectoryFeed(feedSpecifications(tree), 1024 * 1024);
  const count = paced ? options.pacedCount : options.fastCount;
  const delay = paced ? options.pacedDelayMilliseconds : 0;
  try {
    const writer = await runWithLivePump(feed, runExternalWriter(tree.chapters, count, delay));
    const drainMilliseconds = await drainUntilQuiet(feed);
    const assessment = coverageAssessment(feed, expectedChapterPaths(count));
    return {
      name: paced ? 'paced_distinct_paths' : 'fast_distinct_paths',
      configuredCount: count,
      configuredDelayMilliseconds: delay,
      writer,
      drainMilliseconds,
      ...assessment,
      feed: feed.snapshot(),
    };
  } finally {
    feed.close();
  }
}

async function runForcedOverflow(baseDirectory, options) {
  const tree = createTree(baseDirectory, 'forced-overflow');
  const feed = new NativeDirectoryFeed(feedSpecifications(tree), 512);
  try {
    const writer = await runExternalWriter(tree.chapters, options.overflowCount, 0);
    const coverageLostBeforeSynchronization = feed.coverageLost;
    const continuousCoverageAtFirstSynchronization = feed
      .synchronizeCoverage()
      .canReportContinuousCoverage;
    const drainMilliseconds = await drainUntilQuiet(feed, 500, 30_000);
    const assessment = coverageAssessment(feed, expectedChapterPaths(options.overflowCount));
    const explicitNativeLoss = feed.lossSignals.some((signal) => (
      signal.kind === 'zero_byte_completion'
      || signal.kind === 'error_notify_enum_dir'
      || signal.kind === 'completion_failed'
    ));
    return {
      name: 'forced_small_buffer_overflow',
      configuredCount: options.overflowCount,
      configuredBufferByteLength: 512,
      writer,
      coverageLostBeforeSynchronization,
      continuousCoverageAtFirstSynchronization,
      drainMilliseconds,
      explicitNativeLoss,
      latchRemainsSet: feed.coverageLost
        && !feed.synchronizeCoverage().canReportContinuousCoverage,
      ...assessment,
      pass: assessment.pass
        && explicitNativeLoss
        && feed.coverageLost
        && !continuousCoverageAtFirstSynchronization
        && !feed.synchronizeCoverage().canReportContinuousCoverage,
      feed: feed.snapshot(),
    };
  } finally {
    feed.close();
  }
}

async function runSamePathCoalescing(baseDirectory, options) {
  const tree = createTree(baseDirectory, 'same-path');
  const feed = new NativeDirectoryFeed(feedSpecifications(tree), 1024 * 1024);
  const relativePath = `chapters/${chapterBasename(0)}`;
  const absolutePath = path.join(tree.chapters, chapterBasename(0));
  try {
    for (let index = 0; index < options.samePathWrites; index += 1) {
      writeFileSync(absolutePath, String(index));
    }
    const drainMilliseconds = await drainUntilQuiet(feed);
    const assessment = coverageAssessment(feed, [relativePath]);
    const matchingSampleCount = feed.events.filter((event) => event.relativePath === relativePath).length;
    return {
      name: 'same_path_coalescing',
      configuredWrites: options.samePathWrites,
      drainMilliseconds,
      matchingEventSampleCount: matchingSampleCount,
      ...assessment,
      feed: feed.snapshot(),
    };
  } finally {
    feed.close();
  }
}

async function runRearmGap(baseDirectory) {
  const tree = createTree(baseDirectory, 'rearm-gap');
  const feed = new NativeDirectoryFeed(feedSpecifications(tree), 64 * 1024);
  const beforePath = `chapters/${chapterBasename(0)}`;
  const gapPath = `chapters/${chapterBasename(1)}`;
  try {
    writeFileSync(path.join(tree.chapters, chapterBasename(0)), 'before');
    const firstSignalMilliseconds = await waitUntilSignaled(feed, 'chapters');
    feed.completeWithoutRearmForTest('chapters');
    const continuousCoverageWhileUnarmed = feed
      .synchronizeCoverage()
      .canReportContinuousCoverage;
    writeFileSync(path.join(tree.chapters, chapterBasename(1)), 'gap');
    await sleep(50);
    const rearmed = feed.rearmForTest('chapters');
    const drainMilliseconds = await drainUntilQuiet(feed);
    const assessment = coverageAssessment(feed, [beforePath, gapPath]);
    return {
      name: 'completion_to_rearm_gap',
      firstSignalMilliseconds,
      continuousCoverageWhileUnarmed,
      rearmed,
      drainMilliseconds,
      ...assessment,
      pass: assessment.pass && !continuousCoverageWhileUnarmed && rearmed,
      feed: feed.snapshot(),
    };
  } finally {
    feed.close();
  }
}

async function runAtomicReplace(baseDirectory, options) {
  const tree = createTree(baseDirectory, 'atomic-replace');
  const feed = new NativeDirectoryFeed(feedSpecifications(tree), 1024 * 1024);
  const targetBasename = chapterBasename(0);
  const targetRelativePath = `chapters/${targetBasename}`;
  const journalId = '11111111-1111-4111-8111-111111111111';
  const candidateBasename = `${targetBasename}.${journalId}.tmp`;
  try {
    for (let index = 0; index < options.atomicIterations; index += 1) {
      const candidatePath = path.join(tree.chapters, candidateBasename);
      const descriptor = openSync(candidatePath, 'w');
      try {
        writeFileSync(descriptor, `value-${index}`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(candidatePath, path.join(tree.chapters, targetBasename));
      feed.pumpAll();
    }
    const drainMilliseconds = await drainUntilQuiet(feed);
    const assessment = coverageAssessment(feed, [targetRelativePath]);
    const targetActions = feed.events
      .filter((event) => event.relativePath === targetRelativePath)
      .map((event) => event.action);
    return {
      name: 'candidate_fsync_atomic_replace',
      configuredIterations: options.atomicIterations,
      drainMilliseconds,
      targetActions,
      ...assessment,
      feed: feed.snapshot(),
    };
  } finally {
    feed.close();
  }
}

async function runDirectoryIdentity(baseDirectory) {
  const tree = createTree(baseDirectory, 'directory-identity');
  const feed = new NativeDirectoryFeed(feedSpecifications(tree), 64 * 1024);
  try {
    const attempts = [];
    for (const [name, directory] of [
      ['chapters', tree.chapters],
      ['volumes', tree.volumes],
      ['mythpen', tree.mythpen],
    ]) {
      const movedPath = `${directory}-moved`;
      let renameBlocked = false;
      let renameError = null;
      try {
        renameSync(directory, movedPath);
      } catch (error) {
        renameBlocked = true;
        renameError = { code: error?.code || null, message: error?.message || String(error) };
      }
      if (!renameBlocked && existsSync(movedPath)) renameSync(movedPath, directory);
      attempts.push({ name, renameBlocked, renameError });
    }
    const synchronization = feed.synchronizeCoverage();
    const linearizationSnapshotEstablished = hasCompleteLinearizationSnapshot(synchronization);
    return {
      name: 'directory_identity_lock',
      attempts,
      linearizationSnapshotEstablished,
      synchronization,
      pass: attempts.every((attempt) => attempt.renameBlocked)
        && linearizationSnapshotEstablished
        && synchronization.canReportContinuousCoverage,
      feed: feed.snapshot(),
    };
  } finally {
    feed.close();
  }
}

async function main() {
  if (platform() !== 'win32' || process.arch !== 'x64') {
    throw new Error(`This probe requires Windows x64, got ${platform()} ${process.arch}`);
  }
  const options = parseArguments(process.argv.slice(2));
  const tempParent = path.resolve('.codex-tmp');
  mkdirSync(tempParent, { recursive: true });
  const baseDirectory = mkdtempSync(path.join(tempParent, 'l2-rdcw-'));
  const startedAt = new Date().toISOString();
  const cases = [];
  let primaryError = null;
  try {
    cases.push(await runReachability(baseDirectory));
    cases.push(await runDistinctPressure(baseDirectory, options, true));
    cases.push(await runDistinctPressure(baseDirectory, options, false));
    cases.push(await runForcedOverflow(baseDirectory, options));
    cases.push(await runSamePathCoalescing(baseDirectory, options));
    cases.push(await runRearmGap(baseDirectory));
    cases.push(await runAtomicReplace(baseDirectory, options));
    cases.push(await runDirectoryIdentity(baseDirectory));
  } catch (error) {
    primaryError = {
      name: error?.name || null,
      message: error?.message || String(error),
      stack: error?.stack || null,
      win32Code: error?.win32Code || null,
    };
  }
  const result = {
    probeVersion: PROBE_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      arch: process.arch,
      osRelease: release(),
      osVersion: version(),
      bunVersion: process.versions.bun || Bun.version,
      execPath: process.execPath,
      cwd: process.cwd(),
    },
    options,
    baseDirectory,
    primaryError,
    cases,
    passed: primaryError === null && cases.length === 8 && cases.every((item) => item.pass),
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, serialized);
  process.stdout.write(serialized);
  if (!options.keep) {
    const resolvedParent = path.resolve(tempParent);
    const resolvedBase = path.resolve(baseDirectory);
    if (!resolvedBase.startsWith(`${resolvedParent}${path.sep}`)) {
      throw new Error(`Unsafe probe cleanup target: ${resolvedBase}`);
    }
    rmSync(resolvedBase, { recursive: true, force: true });
  }
  library.close();
  if (!result.passed) process.exitCode = 1;
}

await main();
