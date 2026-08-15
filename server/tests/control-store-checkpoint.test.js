const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const controlStoreModule = require('../control-store');
const { openControlStore } = controlStoreModule;
const { acquireExclusiveLease } = require('../platform/durability');
const { runUntilCrash } = require('../testing/crash-harness');
const {
  CRASH_MARKER_PATH_ENV,
  CRASH_MARKER_TOKEN_ENV,
  FAULT_MAP_ENV,
  FAULT_POINTS,
  crashOnlyFaultPoint,
  faultPoint,
  withFaults,
} = require('../testing/fault-injection');
const boundedControlStoreTesting = require('../testing/bounded-control-store');
const {
  createBoundedControlStoreTestHarness,
} = boundedControlStoreTesting;

const BOUNDED_FACADE_KEYS = [
  'append',
  'assertCurrent',
  'compareAndAppend',
  'directory',
  'incarnationId',
  'lifecycleLeasePath',
  'read',
  'readEvidence',
  'retire',
  'retireAndActivate',
  'tail',
];
const CONTROLLER_KEYS = ['installCheckpoint', 'maintenanceStatus'];
const CHECKPOINT_CRASH_AUTHORITY_ENV = 'MYTHPEN_CONTROL_STORE_CHECKPOINT_AUTHORITY_JSON';
const CHECKPOINT_MARKER_COMPOUND_FAULT = 'controlstore.checkpoint.marker-compound-failure';
const MODULE_ENUMERABLE_KEYS = [
  'inspectControlStore',
  'inspectControlStoreEvidence',
  'openControlStore',
];
const CHECKPOINT_KEYS = [
  'version',
  'checkpointDigest',
  'controlProtocolEpoch',
  'incarnationId',
  'admissionBasis',
  'coveredSeq',
  'coveredDigest',
  'chainRoot',
  'previousCheckpoint',
  'dbKey',
  'schema',
  'backend',
  'finalSeq',
  'triggerVersion',
  'triggerSetDigest',
  'projectInstanceIdSha256',
  'identity',
  'latestCleanBasisDigest',
  'eventTypeCounts',
  'unresolved',
  'retryContinuationOpen',
  'connectionEpochFilter',
];
const CHECKPOINT_FAULT_POINTS = Object.freeze({
  CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH: 'controlstore.checkpoint.before-publish',
  CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK:
    'controlstore.checkpoint.before-candidate-unlink',
  CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC:
    'controlstore.checkpoint.before-final-dir-fsync',
  CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC:
    'controlstore.checkpoint.after-final-dir-fsync',
  CONTROL_STORE_CHECKPOINT_BEFORE_GC: 'controlstore.checkpoint.before-gc',
  CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY: 'controlstore.checkpoint.after-gc-entry',
  CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC:
    'controlstore.checkpoint.before-gc-dir-fsync',
});
const CHECKPOINT_CANDIDATE_PATTERN = /^\.controlstore-checkpoint-[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const CHECKPOINT_FINAL_PATTERN = /^\.controlstore-checkpoint-[1-9]\d*-[0-9a-f]{64}\.json$/;
const EVENT_FILE_PATTERN = /^[1-9]\d*-[0-9a-f]{64}\.json$/;
const TAIL_CANDIDATE_PATTERN = /^\.controlstore-tail-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;

function createControlDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-control-checkpoint-'));
  const controlDir = path.join(root, 'control');
  fs.mkdirSync(controlDir);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return controlDir;
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function snapshotTree(root) {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.join(prefix, name).replaceAll('\\', '/');
      const stats = fs.lstatSync(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        entries.push({ kind: 'directory', path: relative });
        visit(absolute, relative);
      } else if (stats.isFile() && !stats.isSymbolicLink()) {
        entries.push({
          bytes: fs.readFileSync(absolute).toString('base64'),
          kind: 'file',
          path: relative,
        });
      } else {
        entries.push({ kind: 'other', path: relative });
      }
    }
  };
  visit(root);
  return entries;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function cloneData(value) {
  return JSON.parse(canonicalJson(value));
}

function digestRecord(record, digestKey) {
  const withoutDigest = { ...record };
  delete withoutDigest[digestKey];
  return crypto.createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex');
}

function writeTailRecord(controlDir, input) {
  const withoutDigest = { ...input };
  delete withoutDigest.recordDigest;
  const tail = {
    ...withoutDigest,
    recordDigest: digestRecord(withoutDigest, 'recordDigest'),
  };
  fs.writeFileSync(
    path.join(controlDir, '.controlstore-tail.json'),
    canonicalJson(tail),
  );
  return tail;
}

function writeNoCheckpointTail(
  controlDir,
  incarnationId,
  tailEvent,
  activeEventCount,
  activeEventBytes,
) {
  return writeTailRecord(controlDir, {
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId,
    checkpointFile: null,
    checkpointDigest: null,
    coveredSeq: 0,
    coveredDigest: null,
    tailSeq: tailEvent.seq,
    tailDigest: tailEvent.digest,
    activeEventCount,
    activeEventBytes,
  });
}

function epochFilterPositions(basisDigest, epoch) {
  const domain = Buffer.from('mythpen-controlstore-connection-epoch-v1\0', 'utf8');
  const basis = Buffer.from(basisDigest, 'hex');
  const normalizedEpoch = Buffer.from(epoch.toLowerCase(), 'ascii');
  return Array.from({ length: 7 }, (_unused, index) => {
    const digest = crypto.createHash('sha256').update(Buffer.concat([
      domain,
      Buffer.from([index]),
      basis,
      normalizedEpoch,
    ])).digest();
    return (((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 1);
  });
}

function setFilterBit(bytes, bit) {
  bytes[bit >>> 3] |= 1 << (bit & 7);
}

function clearFilterBit(bytes, bit) {
  bytes[bit >>> 3] &= ~(1 << (bit & 7));
}

function filterHasBit(bytes, bit) {
  return (bytes[bit >>> 3] & (1 << (bit & 7))) !== 0;
}

function createGenesisEpochFilter(basisDigest, epoch) {
  const bytes = Buffer.alloc(1_048_576);
  for (const bit of epochFilterPositions(basisDigest, epoch)) setFilterBit(bytes, bit);
  return bytes;
}

function createHalfFullEpochFilter(basisDigest, epoch) {
  const bytes = Buffer.alloc(1_048_576);
  bytes.fill(0xff, 0, 524_288);
  const requiredBits = new Set(epochFilterPositions(basisDigest, epoch));
  let clearCursor = 0;
  for (const bit of requiredBits) {
    if (filterHasBit(bytes, bit)) continue;
    setFilterBit(bytes, bit);
    while (requiredBits.has(clearCursor) || !filterHasBit(bytes, clearCursor)) {
      clearCursor += 1;
    }
    clearFilterBit(bytes, clearCursor);
    clearCursor += 1;
  }
  return bytes;
}

function findEpochWithClearFilterBit(filterBytes, basisDigest) {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const epoch = crypto.randomUUID();
    if (epochFilterPositions(basisDigest, epoch).some(
      (bit) => !filterHasBit(filterBytes, bit),
    )) {
      return epoch;
    }
  }
  throw new Error('Unable to find an epoch with a clear Bloom bit');
}

function countFilterBits(bytes) {
  let count = 0;
  for (const byte of bytes) {
    let remaining = byte;
    while (remaining !== 0) {
      remaining &= remaining - 1;
      count += 1;
    }
  }
  return count;
}

function createFixtureGenesisStore(t) {
  const controlDir = createControlDir(t);
  const legacy = openControlStore(controlDir);
  const payload = {
    version: 1,
    eventId: crypto.randomUUID(),
    dbKey: 'a'.repeat(64),
    projectInstanceIdSha256: 'b'.repeat(64),
    createdAt: '2026-08-12T00:00:00.000Z',
    ownershipHash: 'c'.repeat(64),
    connectionEpoch: crypto.randomUUID(),
    fixtureRunId: crypto.randomUUID(),
    schemaVersion: 11,
    backend: 'native-sqlite-v2',
    finalSeq: 0,
    gateEmpty: true,
    triggerVersion: 1,
    triggerSetDigest: 'd'.repeat(64),
    identity: { dev: '1', ino: '2' },
  };
  legacy.append({ type: 'sqlite.native.stage_b.fixture_genesis', payload });
  return { controlDir, genesis: legacy.read()[0], legacy, payload };
}

function installCheckpointEvidence(t, options = {}) {
  const { withActiveSuffix = false, halfFullFilter = false } = options;
  const { controlDir, genesis, legacy, payload } = createFixtureGenesisStore(t);
  const filterBytes = halfFullFilter
    ? createHalfFullEpochFilter(genesis.digest, payload.connectionEpoch)
    : createGenesisEpochFilter(genesis.digest, payload.connectionEpoch);
  let activeEvent = null;
  if (withActiveSuffix) {
    legacy.append({
      type: 'bounded.checkpoint.active-suffix',
      payload: { version: 1 },
    });
    activeEvent = legacy.read().at(-1);
  }
  const checkpointWithoutDigest = {
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId: legacy.incarnationId,
    admissionBasis: {
      basisKind: 'stage_b_fixture_genesis',
      basisDigest: genesis.digest,
      admissionEvent: cloneData(genesis),
    },
    coveredSeq: 1,
    coveredDigest: genesis.digest,
    chainRoot: { seq: 1, digest: genesis.digest },
    previousCheckpoint: null,
    dbKey: payload.dbKey,
    schema: payload.schemaVersion,
    backend: payload.backend,
    finalSeq: payload.finalSeq,
    triggerVersion: payload.triggerVersion,
    triggerSetDigest: payload.triggerSetDigest,
    projectInstanceIdSha256: payload.projectInstanceIdSha256,
    identity: cloneData(payload.identity),
    latestCleanBasisDigest: genesis.digest,
    eventTypeCounts: { 'sqlite.native.stage_b.fixture_genesis': 1 },
    unresolved: [],
    retryContinuationOpen: false,
    connectionEpochFilter: {
      algorithm: 'sha256-domain-separated-v1',
      bitCount: 8_388_608,
      hashCount: 7,
      bitsBase64: filterBytes.toString('base64'),
      epochObservationCount: 1,
    },
  };
  const checkpointDigest = digestRecord(checkpointWithoutDigest, 'checkpointDigest');
  const checkpoint = { ...checkpointWithoutDigest, checkpointDigest };
  const checkpointFile = `.controlstore-checkpoint-1-${checkpointDigest}.json`;
  fs.writeFileSync(
    path.join(controlDir, checkpointFile),
    canonicalJson(checkpoint),
  );
  const tailEvent = activeEvent || genesis;
  const tail = writeTailRecord(controlDir, {
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId: legacy.incarnationId,
    checkpointFile,
    checkpointDigest,
    coveredSeq: 1,
    coveredDigest: genesis.digest,
    tailSeq: tailEvent.seq,
    tailDigest: tailEvent.digest,
    activeEventCount: activeEvent ? 1 : 0,
    activeEventBytes: activeEvent
      ? Buffer.byteLength(canonicalJson(activeEvent), 'utf8')
      : 0,
  });
  const genesisFile = fs.readdirSync(controlDir).find(
    (name) => name.startsWith(`1-${genesis.digest}`),
  );
  assert.equal(typeof genesisFile, 'string');
  fs.rmSync(path.join(controlDir, genesisFile));
  return {
    activeEvent,
    checkpoint,
    checkpointFile,
    controlDir,
    filterBytes,
    genesis,
    tail,
  };
}

function materializeTailRecord(input) {
  const withoutDigest = { ...input };
  delete withoutDigest.recordDigest;
  return {
    ...withoutDigest,
    recordDigest: digestRecord(withoutDigest, 'recordDigest'),
  };
}

function checkpointActivationTail(evidence, checkpoint, checkpointFile) {
  return materializeTailRecord({
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId: checkpoint.incarnationId,
    checkpointFile,
    checkpointDigest: checkpoint.checkpointDigest,
    coveredSeq: checkpoint.coveredSeq,
    coveredDigest: checkpoint.coveredDigest,
    tailSeq: checkpoint.coveredSeq,
    tailDigest: checkpoint.coveredDigest,
    activeEventCount: 0,
    activeEventBytes: 0,
  });
}

function writeCheckpointCandidate(controlDir, checkpoint, serialized = canonicalJson(checkpoint)) {
  const candidatePath = path.join(
    controlDir,
    `.controlstore-checkpoint-${checkpoint.coveredSeq}-${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(candidatePath, serialized);
  return candidatePath;
}

function writeCheckpointFinal(
  controlDir,
  checkpoint,
  checkpointFile = `.controlstore-checkpoint-${checkpoint.coveredSeq}-${checkpoint.checkpointDigest}.json`,
  serialized = canonicalJson(checkpoint),
) {
  const finalPath = path.join(controlDir, checkpointFile);
  fs.writeFileSync(finalPath, serialized);
  return finalPath;
}

function writeCheckpointTailCandidate(controlDir, tail, serialized = canonicalJson(tail)) {
  const candidatePath = path.join(
    controlDir,
    `.controlstore-tail-${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(candidatePath, serialized);
  return candidatePath;
}

function createCheckpointProposalFixture(t) {
  const base = installCheckpointEvidence(t, { withActiveSuffix: true });
  let unusedProviderCalls = 0;
  const seedHarness = createBoundedControlStoreTestHarness(base.controlDir, () => {
    unusedProviderCalls += 1;
    throw new Error('proposal fixture provider must remain unused');
  });
  const evidence = seedHarness.controlStore.readEvidence();
  const authority = createCheckpointProjectionAuthority(
    seedHarness.controlStore,
    base.checkpoint,
    [crypto.randomUUID()],
  );
  const alternateAuthority = createCheckpointProjectionAuthority(
    seedHarness.controlStore,
    base.checkpoint,
    [crypto.randomUUID()],
  );
  const checkpoint = buildExpectedCheckpoint(evidence, authority);
  const alternateCheckpoint = buildExpectedCheckpoint(evidence, alternateAuthority);
  assert.notEqual(checkpoint.checkpointDigest, alternateCheckpoint.checkpointDigest);
  const checkpointFile = `.controlstore-checkpoint-${checkpoint.coveredSeq}-${checkpoint.checkpointDigest}.json`;
  const alternateCheckpointFile = `.controlstore-checkpoint-${alternateCheckpoint.coveredSeq}-${alternateCheckpoint.checkpointDigest}.json`;
  const activationTail = checkpointActivationTail(evidence, checkpoint, checkpointFile);
  const alternateActivationTail = checkpointActivationTail(
    evidence,
    alternateCheckpoint,
    alternateCheckpointFile,
  );
  assert.equal(unusedProviderCalls, 0);
  return {
    ...base,
    activationTail,
    alternateActivationTail,
    alternateCheckpoint,
    alternateCheckpointFile,
    checkpoint,
    checkpointFile,
    evidence,
    previousCheckpoint: base.checkpoint,
    previousCheckpointFile: base.checkpointFile,
  };
}

function createNoTailValidCheckpointFinalFixture(t) {
  const legacy = createFixtureGenesisStore(t);
  let authority;
  let seedProviderCalls = 0;
  const seedHarness = createBoundedControlStoreTestHarness(
    legacy.controlDir,
    () => {
      seedProviderCalls += 1;
      return authority;
    },
  );
  authority = createAuthority(seedHarness.controlStore, legacy.genesis);
  const checkpoint = buildExpectedCheckpoint(
    seedHarness.controlStore.readEvidence(),
    authority,
  );
  const checkpointFile = `.controlstore-checkpoint-${checkpoint.coveredSeq}-${checkpoint.checkpointDigest}.json`;
  const checkpointPath = writeCheckpointFinal(
    legacy.controlDir,
    checkpoint,
    checkpointFile,
  );
  const tailPath = path.join(legacy.controlDir, '.controlstore-tail.json');
  fs.unlinkSync(tailPath);
  assert.equal(seedProviderCalls, 0);
  assert.equal(fs.existsSync(tailPath), false);
  return {
    ...legacy,
    checkpoint,
    checkpointFile,
    checkpointPath,
    tailPath,
  };
}

function rematerializeCheckpoint(checkpoint, mutate) {
  const withoutDigest = cloneData(checkpoint);
  delete withoutDigest.checkpointDigest;
  mutate(withoutDigest);
  const rematerialized = {
    ...withoutDigest,
    checkpointDigest: digestRecord(withoutDigest, 'checkpointDigest'),
  };
  return {
    checkpoint: rematerialized,
    checkpointFile: `.controlstore-checkpoint-${rematerialized.coveredSeq}-${rematerialized.checkpointDigest}.json`,
  };
}

function writeActivatedCheckpointAuthority(
  fixture,
  checkpoint = fixture.checkpoint,
  checkpointFile = fixture.checkpointFile,
) {
  writeCheckpointFinal(fixture.controlDir, checkpoint, checkpointFile);
  const tail = checkpointActivationTail(fixture.evidence, checkpoint, checkpointFile);
  fs.writeFileSync(
    path.join(fixture.controlDir, '.controlstore-tail.json'),
    canonicalJson(tail),
  );
  return tail;
}

function writeOfficialSuccessorForEvidence(controlDir, tail) {
  const materialized = materializeStoredEvent(
    tail.tailSeq + 1,
    tail.tailDigest,
    'bounded.checkpoint.startup-successor',
    { version: 1 },
  );
  writeStoredEvent(controlDir, materialized);
  return materialized.event;
}

function tailAfterOfficialSuccessor(tail, successor) {
  const withoutDigest = { ...tail };
  delete withoutDigest.recordDigest;
  return materializeTailRecord({
    ...withoutDigest,
    tailSeq: successor.seq,
    tailDigest: successor.digest,
    activeEventCount: tail.activeEventCount + 1,
    activeEventBytes: tail.activeEventBytes
      + Buffer.byteLength(canonicalJson(successor), 'utf8'),
  });
}

function activateCheckpointProposal(fixture, options = {}) {
  const {
    keepCoveredEvent = true,
    keepPredecessor = true,
  } = options;
  const currentFinalPath = writeCheckpointFinal(
    fixture.controlDir,
    fixture.checkpoint,
    fixture.checkpointFile,
  );
  fs.writeFileSync(
    path.join(fixture.controlDir, '.controlstore-tail.json'),
    canonicalJson(fixture.activationTail),
  );
  if (!keepCoveredEvent) {
    for (const name of eventFileNames(fixture.controlDir)) {
      fs.unlinkSync(path.join(fixture.controlDir, name));
    }
  }
  if (!keepPredecessor) {
    fs.unlinkSync(path.join(fixture.controlDir, fixture.previousCheckpointFile));
  }
  return currentFinalPath;
}

function loadCheckpointRuntimeWithHooks(hooks = {}) {
  const controlStorePath = require.resolve('../control-store');
  const testingHarnessPath = require.resolve('../testing/bounded-control-store');
  const durabilityPath = require.resolve('../platform/durability');
  const cachedControlStore = require.cache[controlStorePath];
  const cachedTestingHarness = require.cache[testingHarnessPath];
  const durability = require(durabilityPath);
  const originals = {
    acquireExclusiveLease: durability.acquireExclusiveLease,
    atomicReplace: durability.atomicReplace,
    fsyncDirectory: durability.fsyncDirectory,
    fsyncFile: durability.fsyncFile,
  };

  durability.acquireExclusiveLease = (lockPath) => {
    const lease = originals.acquireExclusiveLease(lockPath);
    const kind = path.basename(String(lockPath)) === '.controlstore-writer.lock'
      ? 'writer'
      : 'lifecycle';
    hooks.onAcquire?.(kind, String(lockPath));
    return {
      isHeld: () => lease.isHeld(),
      release() {
        const result = lease.release();
        hooks.onRelease?.(kind, String(lockPath));
        return result;
      },
    };
  };
  durability.atomicReplace = (sourcePath, targetPath, options) => {
    hooks.beforeAtomicReplace?.(String(sourcePath), String(targetPath));
    const result = originals.atomicReplace(sourcePath, targetPath, options);
    hooks.afterAtomicReplace?.(String(sourcePath), String(targetPath));
    return result;
  };
  durability.fsyncDirectory = (directory) => {
    const result = originals.fsyncDirectory(directory);
    hooks.onFsyncDirectory?.(path.resolve(String(directory)));
    return result;
  };
  durability.fsyncFile = (filePath) => {
    const result = originals.fsyncFile(filePath);
    hooks.onFsyncFile?.(path.resolve(String(filePath)));
    return result;
  };

  delete require.cache[testingHarnessPath];
  delete require.cache[controlStorePath];
  let freshControlStore;
  let freshTestingHarness;
  try {
    freshControlStore = require(controlStorePath);
    freshTestingHarness = require(testingHarnessPath);
  } finally {
    Object.assign(durability, originals);
    delete require.cache[testingHarnessPath];
    delete require.cache[controlStorePath];
    if (cachedTestingHarness) require.cache[testingHarnessPath] = cachedTestingHarness;
    if (cachedControlStore) require.cache[controlStorePath] = cachedControlStore;
  }
  return {
    controlStoreModule: freshControlStore,
    createHarnessAt(controlDir, authoritySource) {
      return freshTestingHarness.createBoundedControlStoreTestHarness(
        controlDir,
        authoritySource,
      );
    },
  };
}

function loadCheckpointRuntimeWithReleaseHarness(hooks = {}) {
  const state = {
    armed: false,
    counts: { lifecycle: 0, writer: 0 },
    failures: { lifecycle: [], writer: [] },
  };
  const runtime = loadCheckpointRuntimeWithHooks({
    ...hooks,
    onRelease(kind) {
      if (!state.armed) return;
      const index = state.counts[kind];
      state.counts[kind] += 1;
      const failure = state.failures[kind][index];
      if (failure) throw failure;
    },
  });
  return {
    ...runtime,
    arm(failures) {
      state.armed = true;
      state.counts = { lifecycle: 0, writer: 0 };
      state.failures = {
        lifecycle: failures.lifecycle || [],
        writer: failures.writer || [],
      };
    },
    disarm() { state.armed = false; },
  };
}

function withFsMutationLog(callback) {
  const methods = ['mkdirSync', 'writeFileSync', 'rmSync', 'unlinkSync', 'renameSync', 'linkSync'];
  const originals = new Map(methods.map((method) => [method, fs[method]]));
  const calls = [];
  for (const method of methods) {
    fs[method] = (...args) => {
      calls.push({ method, target: String(args[0]) });
      return originals.get(method)(...args);
    };
  }
  try {
    callback();
  } finally {
    for (const [method, original] of originals) fs[method] = original;
  }
  return calls;
}

function withFsMutationTrace(trace, callback) {
  const methods = ['linkSync', 'rmSync', 'unlinkSync', 'writeFileSync'];
  const originals = new Map(methods.map((method) => [method, fs[method]]));
  for (const method of methods) {
    fs[method] = (...args) => {
      const entry = {
        operation: method,
        target: path.resolve(String(args[0])),
      };
      if (method === 'linkSync') {
        entry.destination = path.resolve(String(args[1]));
      }
      if (method === 'rmSync') entry.options = args[1];
      trace.push(entry);
      return originals.get(method)(...args);
    };
  }
  try {
    return callback();
  } finally {
    for (const [method, original] of originals) fs[method] = original;
  }
}

function mutationTraceHooks(trace) {
  return {
    beforeAtomicReplace(sourcePath, targetPath) {
      trace.push({
        operation: 'atomicReplace',
        source: path.resolve(sourcePath),
        target: path.resolve(targetPath),
      });
    },
    onFsyncDirectory(directory) {
      trace.push({ operation: 'fsyncDirectory', target: path.resolve(directory) });
    },
    onFsyncFile(filePath) {
      trace.push({ operation: 'fsyncFile', target: path.resolve(filePath) });
    },
  };
}

function assertExactDeleteThenDirectoryFsync(trace, expectedTargets, directory) {
  assert.equal(trace.length, expectedTargets.length + 1);
  const fsyncEntries = trace.filter(
    (entry) => entry.operation === 'fsyncDirectory',
  );
  assert.deepEqual(fsyncEntries, [{
    operation: 'fsyncDirectory',
    target: path.resolve(directory),
  }]);
  assert.deepEqual(trace.at(-1), fsyncEntries[0]);
  const deletes = trace.slice(0, -1);
  for (const entry of deletes) {
    assert.equal(
      entry.operation === 'unlinkSync' || entry.operation === 'rmSync',
      true,
    );
  }
  assert.deepEqual(
    deletes.map((entry) => entry.target).sort(),
    expectedTargets.map((target) => path.resolve(target)).sort(),
  );
  assert.equal(new Set(deletes.map((entry) => entry.target)).size, deletes.length);
}

function assertBoundedFacadeFenced(store) {
  const retired = path.join(
    path.dirname(store.directory),
    `${path.basename(store.directory)}.retired-${crypto.randomUUID()}`,
  );
  for (const [label, operation] of [
    ['assertCurrent', () => store.assertCurrent()],
    ['append', () => store.append({ type: 'must-fence', payload: {} })],
    ['compareAndAppend', () => store.compareAndAppend(null, { type: 'must-fence', payload: {} })],
    ['read', () => store.read()],
    ['readEvidence', () => store.readEvidence()],
    ['tail', () => store.tail()],
    ['retire', () => store.retire(retired, () => {})],
    ['retireAndActivate', () => store.retireAndActivate(retired, () => {})],
  ]) {
    assert.throws(operation, { code: 'CONTROL_STORE_FENCED' }, label);
  }
}

function loadFaultInjectionWithKillSpy(faults) {
  const modulePath = require.resolve('../testing/fault-injection');
  const cached = require.cache[modulePath];
  const previousFaultMap = process.env[FAULT_MAP_ENV];
  const previousMarkerPath = process.env.MYTHPEN_CRASH_MARKER_PATH;
  const previousToken = process.env.MYTHPEN_CRASH_MARKER_TOKEN;
  const previousKill = process.kill;
  const killCalls = [];
  process.env[FAULT_MAP_ENV] = JSON.stringify(faults);
  delete process.env.MYTHPEN_CRASH_MARKER_PATH;
  process.env.MYTHPEN_CRASH_MARKER_TOKEN = 'selector-kill-spy';
  process.kill = (pid, signal) => {
    killCalls.push({ pid, signal });
    return true;
  };
  delete require.cache[modulePath];
  let fresh;
  try {
    fresh = require(modulePath);
  } finally {
    process.kill = previousKill;
    if (previousFaultMap === undefined) delete process.env[FAULT_MAP_ENV];
    else process.env[FAULT_MAP_ENV] = previousFaultMap;
    if (previousMarkerPath === undefined) delete process.env.MYTHPEN_CRASH_MARKER_PATH;
    else process.env.MYTHPEN_CRASH_MARKER_PATH = previousMarkerPath;
    if (previousToken === undefined) delete process.env.MYTHPEN_CRASH_MARKER_TOKEN;
    else process.env.MYTHPEN_CRASH_MARKER_TOKEN = previousToken;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
  return { faultInjection: fresh, killCalls };
}

function assertCheckpointCrashMarkerDurabilityFailure(t, failureOperation, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-checkpoint-marker-failure-'));
  const markerPath = path.join(root, 'crash-marker.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const faultName = `batch5.checkpoint.marker-${failureOperation}-failure`;
  const failure = Object.assign(new Error(`${failureOperation} failed`), { code: 'EIO' });
  const modulePath = require.resolve('../testing/fault-injection');
  const cached = require.cache[modulePath];
  const durability = require('../platform/durability');
  const originalFsyncFile = durability.fsyncFile;
  const originalFsyncDirectory = durability.fsyncDirectory;
  const originalRmSync = fs.rmSync;
  const previousFaultMap = process.env[FAULT_MAP_ENV];
  const previousMarkerPath = process.env[CRASH_MARKER_PATH_ENV];
  const previousToken = process.env[CRASH_MARKER_TOKEN_ENV];
  const previousKill = process.kill;
  const trace = [];
  let observed;

  process.env[FAULT_MAP_ENV] = JSON.stringify({ [faultName]: { crash: true } });
  process.env[CRASH_MARKER_PATH_ENV] = markerPath;
  process.env[CRASH_MARKER_TOKEN_ENV] = crypto.randomUUID();
  durability.fsyncFile = (target) => {
    trace.push({ operation: 'fsyncFile', target: path.resolve(String(target)) });
    if (failureOperation === 'fsyncFile') throw failure;
    return originalFsyncFile(target);
  };
  durability.fsyncDirectory = (target) => {
    trace.push({ operation: 'fsyncDirectory', target: path.resolve(String(target)) });
    if (failureOperation === 'fsyncDirectory') throw failure;
    return originalFsyncDirectory(target);
  };
  fs.rmSync = (target, ...args) => {
    if (
      options.cleanupFailure
      && path.resolve(String(target)) === path.resolve(markerPath)
    ) {
      trace.push({ operation: 'rmSync', target: path.resolve(String(target)) });
      throw options.cleanupFailure;
    }
    return originalRmSync(target, ...args);
  };
  process.kill = (pid, signal) => {
    trace.push({ operation: 'kill', pid, signal });
    return true;
  };

  delete require.cache[modulePath];
  try {
    const fresh = require(modulePath);
    assert.throws(
      () => fresh.crashOnlyFaultPoint(faultName, { entryKind: 'event' }),
      (error) => {
        observed = error;
        return error === failure;
      },
    );
  } finally {
    process.kill = previousKill;
    durability.fsyncFile = originalFsyncFile;
    durability.fsyncDirectory = originalFsyncDirectory;
    fs.rmSync = originalRmSync;
    if (previousFaultMap === undefined) delete process.env[FAULT_MAP_ENV];
    else process.env[FAULT_MAP_ENV] = previousFaultMap;
    if (previousMarkerPath === undefined) delete process.env[CRASH_MARKER_PATH_ENV];
    else process.env[CRASH_MARKER_PATH_ENV] = previousMarkerPath;
    if (previousToken === undefined) delete process.env[CRASH_MARKER_TOKEN_ENV];
    else process.env[CRASH_MARKER_TOKEN_ENV] = previousToken;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }

  const expectedTrace = [{ operation: 'fsyncFile', target: path.resolve(markerPath) }];
  if (failureOperation === 'fsyncDirectory') {
    expectedTrace.push({ operation: 'fsyncDirectory', target: path.resolve(root) });
  }
  if (options.cleanupFailure) {
    expectedTrace.push({ operation: 'rmSync', target: path.resolve(markerPath) });
  }
  assert.deepEqual(trace, expectedTrace);
  if (options.cleanupFailure) {
    assert.equal(observed, failure);
    assert.equal(observed.cleanupError, options.cleanupFailure);
    assert.deepEqual(observed.secondaryErrors, [options.cleanupFailure]);
    assert.equal(fs.existsSync(markerPath), true);
  } else {
    assert.equal(fs.existsSync(markerPath), false);
  }
}

function createAuthority(controlStore, genesis) {
  const tail = controlStore.tail();
  assert.notEqual(tail, null);
  return deepFreeze({
    snapshot: {
      incarnationId: controlStore.incarnationId,
      tail: { seq: tail.seq, digest: tail.digest },
      cleanBasisDigest: tail.digest,
    },
    cleanBasis: {
      admissionBasis: {
        basisKind: 'stage_b_fixture_genesis',
        basisDigest: genesis.digest,
        admissionEvent: cloneData(genesis),
      },
      dbKey: genesis.payload.dbKey,
      schema: genesis.payload.schemaVersion,
      backend: genesis.payload.backend,
      finalSeq: genesis.payload.finalSeq,
      triggerVersion: genesis.payload.triggerVersion,
      triggerSetDigest: genesis.payload.triggerSetDigest,
      projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
      identity: cloneData(genesis.payload.identity),
      latestCleanBasisDigest: tail.digest,
      unresolved: [],
    },
    epochObservations: [genesis.payload.connectionEpoch],
  });
}

function createCheckpointProjectionAuthority(
  controlStore,
  checkpoint,
  epochObservations = [],
  mutate = () => {},
) {
  const tail = controlStore.tail();
  assert.notEqual(tail, null);
  const authority = {
    snapshot: {
      incarnationId: controlStore.incarnationId,
      tail: { seq: tail.seq, digest: tail.digest },
      cleanBasisDigest: tail.digest,
    },
    cleanBasis: {
      admissionBasis: cloneData(checkpoint.admissionBasis),
      dbKey: checkpoint.dbKey,
      schema: checkpoint.schema,
      backend: checkpoint.backend,
      finalSeq: checkpoint.finalSeq,
      triggerVersion: checkpoint.triggerVersion,
      triggerSetDigest: checkpoint.triggerSetDigest,
      projectInstanceIdSha256: checkpoint.projectInstanceIdSha256,
      identity: cloneData(checkpoint.identity),
      latestCleanBasisDigest: tail.digest,
      unresolved: [],
    },
    epochObservations: [...epochObservations],
  };
  mutate(authority);
  return deepFreeze(authority);
}

function mixedCaseUuid(uuid) {
  const index = uuid.search(/[a-f]/);
  assert.notEqual(index, -1);
  return `${uuid.slice(0, index)}${uuid[index].toUpperCase()}${uuid.slice(index + 1)}`;
}

function findEpochWithAllFilterBits(filterBytes, basisDigest) {
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const epoch = crypto.randomUUID();
    if (epochFilterPositions(basisDigest, epoch).every(
      (bit) => filterHasBit(filterBytes, bit),
    )) {
      return epoch;
    }
  }
  throw new Error('Unable to find an epoch whose seven Bloom bits are already set');
}

function materializeStoredEvent(seq, previousDigest, type, payload) {
  const withoutDigest = {
    seq,
    type,
    payload,
    prevDigest: previousDigest,
  };
  const digest = crypto.createHash('sha256')
    .update(canonicalJson(withoutDigest))
    .digest('hex');
  const event = { ...withoutDigest, digest };
  const serialized = canonicalJson(event);
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    event,
    serialized,
  };
}

function writeStoredEvent(controlDir, materialized) {
  const name = `${materialized.event.seq}-${materialized.event.digest}.json`;
  fs.writeFileSync(path.join(controlDir, name), materialized.serialized);
  return name;
}

function materializeExactByteEvent(targetBytes) {
  const baseline = materializeStoredEvent(
    1,
    null,
    'bounded.checkpoint.maintenance-bytes',
    { text: '' },
  );
  const paddingBytes = targetBytes - baseline.bytes;
  assert.ok(paddingBytes >= 3);
  const text = `界${'x'.repeat(paddingBytes - 3)}`;
  const materialized = materializeStoredEvent(
    1,
    null,
    'bounded.checkpoint.maintenance-bytes',
    { text },
  );
  assert.equal(materialized.bytes, targetBytes);
  assert.ok(materialized.serialized.length < targetBytes);
  return materialized;
}

function eventFileNames(controlDir) {
  return fs.readdirSync(controlDir).filter((name) => EVENT_FILE_PATTERN.test(name)).sort();
}

function snapshotTreeDigest(root) {
  const hash = crypto.createHash('sha256');
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.join(prefix, name).replaceAll('\\', '/');
      const stats = fs.lstatSync(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        hash.update(`directory\0${relative}\0`);
        visit(absolute, relative);
      } else if (stats.isFile() && !stats.isSymbolicLink()) {
        const bytes = fs.readFileSync(absolute);
        hash.update(`file\0${relative}\0${bytes.length}\0`);
        hash.update(bytes);
      } else {
        hash.update(`other\0${relative}\0`);
      }
    }
  };
  visit(root);
  return hash.digest('hex');
}

function buildExpectedCheckpoint(evidence, authority) {
  const previous = evidence.checkpoint;
  const eventTypeCountMap = new Map(
    Object.entries(previous?.eventTypeCounts || {}),
  );
  for (const event of evidence.events) {
    eventTypeCountMap.set(
      event.type,
      (eventTypeCountMap.get(event.type) || 0) + 1,
    );
  }
  const eventTypeCounts = Object.fromEntries(
    [...eventTypeCountMap.entries()].sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
  const filterBytes = previous
    ? Buffer.from(previous.connectionEpochFilter.bitsBase64, 'base64')
    : Buffer.alloc(1_048_576);
  for (const epoch of authority.epochObservations) {
    for (const bit of epochFilterPositions(
      authority.cleanBasis.admissionBasis.basisDigest,
      epoch,
    )) {
      setFilterBit(filterBytes, bit);
    }
  }
  const withoutDigest = {
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId: evidence.tail.incarnationId,
    admissionBasis: cloneData(
      previous?.admissionBasis || authority.cleanBasis.admissionBasis,
    ),
    coveredSeq: evidence.tail.tailSeq,
    coveredDigest: evidence.tail.tailDigest,
    chainRoot: cloneData(previous?.chainRoot || {
      seq: 1,
      digest: authority.cleanBasis.admissionBasis.basisDigest,
    }),
    previousCheckpoint: previous
      ? {
          checkpointFile: evidence.tail.checkpointFile,
          checkpointDigest: evidence.tail.checkpointDigest,
          coveredSeq: evidence.tail.coveredSeq,
          coveredDigest: evidence.tail.coveredDigest,
        }
      : null,
    dbKey: authority.cleanBasis.dbKey,
    schema: authority.cleanBasis.schema,
    backend: authority.cleanBasis.backend,
    finalSeq: authority.cleanBasis.finalSeq,
    triggerVersion: authority.cleanBasis.triggerVersion,
    triggerSetDigest: authority.cleanBasis.triggerSetDigest,
    projectInstanceIdSha256: authority.cleanBasis.projectInstanceIdSha256,
    identity: cloneData(authority.cleanBasis.identity),
    latestCleanBasisDigest: authority.cleanBasis.latestCleanBasisDigest,
    eventTypeCounts,
    unresolved: [],
    retryContinuationOpen: false,
    connectionEpochFilter: {
      algorithm: 'sha256-domain-separated-v1',
      bitCount: 8_388_608,
      hashCount: 7,
      bitsBase64: filterBytes.toString('base64'),
      epochObservationCount:
        (previous?.connectionEpochFilter.epochObservationCount || 0)
        + authority.epochObservations.length,
    },
  };
  return {
    ...withoutDigest,
    checkpointDigest: digestRecord(withoutDigest, 'checkpointDigest'),
  };
}

function assertExactFrozenStatus(status, expected) {
  assert.equal(Object.isFrozen(status), true);
  assert.deepEqual(Reflect.ownKeys(status).sort(), [
    'activeEventBytes',
    'activeEventCount',
    'level',
  ]);
  assert.deepEqual(status, expected);
}

function captureMaintenanceStatus(harness) {
  try {
    return { status: harness.maintenanceStatus() };
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    return { errorCode: error?.code };
  }
}

function loadControlStoreWithCheckpointObserver(controlDir, trace, options = {}) {
  const resolvedControlDir = path.resolve(controlDir);
  const controlStorePath = require.resolve('../control-store');
  const durabilityPath = require.resolve('../platform/durability');
  const cachedControlStore = require.cache[controlStorePath];
  const durability = require(durabilityPath);
  const originals = {
    acquireExclusiveLease: durability.acquireExclusiveLease,
    atomicReplace: durability.atomicReplace,
    fsyncDirectory: durability.fsyncDirectory,
    fsyncFile: durability.fsyncFile,
  };
  let armed = false;

  durability.acquireExclusiveLease = (lockPath) => {
    const lease = originals.acquireExclusiveLease(lockPath);
    const kind = path.basename(String(lockPath)) === '.controlstore-writer.lock'
      ? 'writer'
      : 'lifecycle';
    if (armed) trace.push(`acquire:${kind}`);
    return {
      isHeld: () => lease.isHeld(),
      release() {
        const result = lease.release();
        if (armed) trace.push(`release:${kind}`);
        return result;
      },
    };
  };
  durability.atomicReplace = (sourcePath, targetPath, replaceOptions) => {
    if (armed) {
      if (options.failOnMutation) assert.fail('checkpoint gate must not call atomicReplace');
      assert.equal(path.dirname(path.resolve(String(sourcePath))), resolvedControlDir);
      assert.equal(path.dirname(path.resolve(String(targetPath))), resolvedControlDir);
      assert.equal(path.resolve(String(targetPath)), path.join(resolvedControlDir, '.controlstore-tail.json'));
      assert.equal(TAIL_CANDIDATE_PATTERN.test(path.basename(String(sourcePath))), true);
      trace.push('atomic-replace:tail:before');
    }
    const result = originals.atomicReplace(sourcePath, targetPath, replaceOptions);
    if (armed && path.basename(String(targetPath)) === '.controlstore-tail.json') {
      trace.push('atomic-replace:tail:after');
    }
    return result;
  };
  durability.fsyncDirectory = (directory) => {
    if (armed) {
      if (options.failOnMutation) assert.fail('checkpoint gate must not fsync a directory');
      assert.equal(path.resolve(String(directory)), resolvedControlDir);
    }
    const result = originals.fsyncDirectory(directory);
    if (armed) trace.push('fsync:directory');
    return result;
  };
  durability.fsyncFile = (filePath) => {
    if (armed) {
      if (options.failOnMutation) assert.fail('checkpoint gate must not fsync a file');
      const name = path.basename(String(filePath));
      assert.equal(
        CHECKPOINT_CANDIDATE_PATTERN.test(name) || TAIL_CANDIDATE_PATTERN.test(name),
        true,
      );
      assert.equal(path.dirname(path.resolve(String(filePath))), resolvedControlDir);
    }
    const result = originals.fsyncFile(filePath);
    if (armed) {
      const name = path.basename(String(filePath));
      if (CHECKPOINT_CANDIDATE_PATTERN.test(name)) {
        trace.push('fsync:checkpoint-candidate');
      }
      if (TAIL_CANDIDATE_PATTERN.test(name)) {
        trace.push('fsync:tail-candidate');
      }
    }
    return result;
  };

  delete require.cache[controlStorePath];
  let fresh;
  try {
    fresh = require(controlStorePath);
  } finally {
    Object.assign(durability, originals);
    delete require.cache[controlStorePath];
    if (cachedControlStore) require.cache[controlStorePath] = cachedControlStore;
  }
  return {
    module: fresh,
    arm() { armed = true; },
    disarm() { armed = false; },
  };
}

function loadBoundedHarnessWithMaintenanceObserver(controlDir, trace) {
  const controlStorePath = require.resolve('../control-store');
  const testingHarnessPath = require.resolve('../testing/bounded-control-store');
  const durabilityPath = require.resolve('../platform/durability');
  const cachedControlStore = require.cache[controlStorePath];
  const cachedTestingHarness = require.cache[testingHarnessPath];
  const durability = require(durabilityPath);
  const originals = {
    acquireExclusiveLease: durability.acquireExclusiveLease,
    atomicReplace: durability.atomicReplace,
    fsyncDirectory: durability.fsyncDirectory,
    fsyncFile: durability.fsyncFile,
  };
  let armed = false;

  durability.acquireExclusiveLease = (lockPath) => {
    const kind = path.basename(String(lockPath)) === '.controlstore-writer.lock'
      ? 'writer'
      : 'lifecycle';
    if (armed) {
      assert.equal(kind, 'lifecycle', 'maintenanceStatus must not acquire the writer lease');
      trace.push('maintenance:acquire:lifecycle');
    }
    const lease = originals.acquireExclusiveLease(lockPath);
    return {
      isHeld: () => lease.isHeld(),
      release() {
        const result = lease.release();
        if (armed) trace.push(`maintenance:release:${kind}`);
        return result;
      },
    };
  };
  durability.atomicReplace = (...args) => {
    if (armed) assert.fail('maintenanceStatus must not call atomicReplace');
    return originals.atomicReplace(...args);
  };
  durability.fsyncDirectory = (...args) => {
    if (armed) assert.fail('maintenanceStatus must not fsync a directory');
    return originals.fsyncDirectory(...args);
  };
  durability.fsyncFile = (...args) => {
    if (armed) assert.fail('maintenanceStatus must not fsync a file');
    return originals.fsyncFile(...args);
  };

  delete require.cache[testingHarnessPath];
  delete require.cache[controlStorePath];
  let freshTestingHarness;
  try {
    require(controlStorePath);
    freshTestingHarness = require(testingHarnessPath);
  } finally {
    Object.assign(durability, originals);
    delete require.cache[testingHarnessPath];
    delete require.cache[controlStorePath];
    if (cachedTestingHarness) require.cache[testingHarnessPath] = cachedTestingHarness;
    if (cachedControlStore) require.cache[controlStorePath] = cachedControlStore;
  }
  return {
    createHarness(authoritySource) {
      return freshTestingHarness.createBoundedControlStoreTestHarness(
        controlDir,
        authoritySource,
      );
    },
    arm() { armed = true; },
    disarm() { armed = false; },
  };
}

function installMaintenanceMutationGuard() {
  const methods = [
    'linkSync',
    'mkdirSync',
    'renameSync',
    'rmSync',
    'unlinkSync',
    'writeFileSync',
  ];
  const originals = new Map(methods.map((method) => [method, fs[method]]));
  for (const method of methods) {
    fs[method] = () => {
      assert.fail(`maintenanceStatus must not call fs.${method}`);
    };
  }
  return {
    restore() {
      for (const [method, original] of originals) fs[method] = original;
    },
  };
}

function installCheckpointFsObserver(controlDir, trace, options = {}) {
  const resolvedControlDir = path.resolve(controlDir);
  const assertControlDirTarget = (target) => {
    assert.equal(path.dirname(path.resolve(String(target))), resolvedControlDir);
  };
  const originals = {
    linkSync: fs.linkSync,
    readFileSync: fs.readFileSync,
    unlinkSync: fs.unlinkSync,
    writeFileSync: fs.writeFileSync,
  };
  let silenced = false;
  fs.writeFileSync = (target, bytes, ...args) => {
    const name = path.basename(String(target));
    if (!silenced) {
      if (options.failOnMutation) assert.fail('checkpoint gate must not write a file');
      assert.equal(
        CHECKPOINT_CANDIDATE_PATTERN.test(name) || TAIL_CANDIDATE_PATTERN.test(name),
        true,
      );
      assertControlDirTarget(target);
    }
    const result = originals.writeFileSync(target, bytes, ...args);
    if (!silenced) {
      if (CHECKPOINT_CANDIDATE_PATTERN.test(name)) {
        const flag = args[0]?.flag;
        trace.push(`write:checkpoint-candidate:${flag}`);
      }
      if (TAIL_CANDIDATE_PATTERN.test(name)) {
        trace.push('write:tail-candidate');
      }
    }
    return result;
  };
  fs.linkSync = (sourcePath, targetPath) => {
    const targetName = path.basename(String(targetPath));
    if (!silenced) {
      if (options.failOnMutation) assert.fail('checkpoint gate must not link a file');
      assertControlDirTarget(sourcePath);
      assertControlDirTarget(targetPath);
      assert.equal(CHECKPOINT_CANDIDATE_PATTERN.test(path.basename(String(sourcePath))), true);
      assert.equal(CHECKPOINT_FINAL_PATTERN.test(targetName), true);
      trace.push('link:checkpoint-final:before');
      options.beforeCheckpointLink?.({
        originals,
        sourcePath: String(sourcePath),
        targetPath: String(targetPath),
      });
    }
    const result = originals.linkSync(sourcePath, targetPath);
    if (!silenced && CHECKPOINT_FINAL_PATTERN.test(targetName)) {
      trace.push('link:checkpoint-final:after');
    }
    return result;
  };
  fs.unlinkSync = (target) => {
    const name = path.basename(String(target));
    if (!silenced) {
      if (options.failOnMutation) assert.fail('checkpoint gate must not unlink a file');
      assertControlDirTarget(target);
      assert.equal(
        CHECKPOINT_CANDIDATE_PATTERN.test(name)
          || EVENT_FILE_PATTERN.test(name)
          || CHECKPOINT_FINAL_PATTERN.test(name),
        true,
      );
    }
    const result = originals.unlinkSync(target);
    if (!silenced) {
      if (CHECKPOINT_CANDIDATE_PATTERN.test(name)) {
        trace.push('unlink:checkpoint-candidate');
      }
      if (EVENT_FILE_PATTERN.test(name)) {
        trace.push(`unlink:event:${name}`);
      }
      if (CHECKPOINT_FINAL_PATTERN.test(name)) {
        trace.push(`unlink:checkpoint-final:${name}`);
      }
    }
    return result;
  };
  fs.readFileSync = (target, ...args) => {
    const result = originals.readFileSync(target, ...args);
    if (!silenced) {
      const name = path.basename(String(target));
      if (CHECKPOINT_FINAL_PATTERN.test(name)) {
        assertControlDirTarget(target);
        trace.push(`read:checkpoint-final:${name}`);
      }
      if (name === '.controlstore-tail.json') {
        assertControlDirTarget(target);
        try {
          const tail = JSON.parse(Buffer.isBuffer(result) ? result.toString('utf8') : result);
          trace.push(tail.checkpointFile === null ? 'read:old-tail' : 'read:new-tail');
        } catch {
          trace.push('read:tail-unparseable');
        }
      }
    }
    return result;
  };
  return {
    restore() {
      Object.assign(fs, originals);
    },
    silence(action) {
      const previous = silenced;
      silenced = true;
      try {
        return action();
      } finally {
        silenced = previous;
      }
    },
  };
}

function createAuthorityFixture(t) {
  const { controlDir, genesis } = createFixtureGenesisStore(t);
  let sourceCalls = 0;
  let sourceImplementation = () => {
    throw new Error('authority source was not configured');
  };
  function authoritySource() {
    sourceCalls += 1;
    return sourceImplementation();
  }
  const harness = createBoundedControlStoreTestHarness(controlDir, authoritySource);
  const authority = createAuthority(harness.controlStore, genesis);
  const initialEvidence = harness.controlStore.readEvidence();
  return {
    authority,
    controlDir,
    get sourceCalls() {
      return sourceCalls;
    },
    harness,
    initialEvidence,
    setSource(implementation) {
      sourceImplementation = implementation;
    },
  };
}

function frozenAuthorityMutation(authority, mutate) {
  const value = cloneData(authority);
  mutate(value);
  return deepFreeze(value);
}

function probeLeaseBusy(leasePath) {
  let competingLease;
  try {
    competingLease = acquireExclusiveLease(leasePath);
    return false;
  } catch (error) {
    assert.equal(error?.code, 'LEASE_BUSY');
    return true;
  } finally {
    competingLease?.release();
  }
}

function loadSeparateControlStoreModule() {
  const modulePath = require.resolve('../control-store');
  const originalModule = require.cache[modulePath];
  delete require.cache[modulePath];
  const separatelyLoaded = require(modulePath);
  delete require.cache[modulePath];
  require.cache[modulePath] = originalModule;
  return separatelyLoaded;
}

test('bounded checkpoint getter has the exact hidden descriptor and stable controller identity', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    controlStoreModule,
    'getBoundedControlStoreCheckpointController',
  );
  assert.deepEqual(Object.keys(controlStoreModule).sort(), MODULE_ENUMERABLE_KEYS);
  assert.equal(typeof descriptor?.value, 'function');
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);

  const controlDir = createControlDir(t);
  const facade = openControlStore(controlDir, { bounded: true });
  assert.deepEqual(Reflect.ownKeys(facade).sort(), BOUNDED_FACADE_KEYS);

  const first = descriptor.value(facade);
  const second = descriptor.value(facade);
  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(Reflect.ownKeys(first).sort(), CONTROLLER_KEYS);
  assert.equal(first.installCheckpoint.length, 1);
  assert.equal(first.maintenanceStatus.length, 0);
});

test('bounded checkpoint getter rejects default and duck facades before lease or writes', (t) => {
  const getter = controlStoreModule.getBoundedControlStoreCheckpointController;
  const controlDir = createControlDir(t);
  const defaultFacade = openControlStore(controlDir);
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);
  const held = acquireExclusiveLease(defaultFacade.lifecycleLeasePath);
  try {
    assert.throws(() => getter(defaultFacade), {
      code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED',
    });
    const duck = Object.fromEntries(
      Reflect.ownKeys(defaultFacade).map((key) => [key, defaultFacade[key]]),
    );
    assert.throws(() => getter(duck), {
      code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED',
    });
  } finally {
    held.release();
  }
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded checkpoint getter rejects a facade minted by a separate module instance zero-write', (t) => {
  const separateControlStoreModule = loadSeparateControlStoreModule();
  const controlDir = createControlDir(t);
  const foreignFacade = separateControlStoreModule.openControlStore(
    controlDir,
    { bounded: true },
  );
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);
  const held = acquireExclusiveLease(foreignFacade.lifecycleLeasePath);
  try {
    assert.throws(
      () => controlStoreModule.getBoundedControlStoreCheckpointController(foreignFacade),
      { code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED' },
    );
  } finally {
    held.release();
  }
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded checkpoint testing harness exposes only the frozen zero-argument wrapper', (t) => {
  assert.deepEqual(Object.keys(boundedControlStoreTesting), [
    'createBoundedControlStoreTestHarness',
  ]);
  const fixture = createAuthorityFixture(t);
  const { harness } = fixture;

  assert.equal(Object.isFrozen(harness), true);
  assert.deepEqual(Reflect.ownKeys(harness).sort(), [
    'checkpoint',
    'controlStore',
    'maintenanceStatus',
  ]);
  assert.equal(harness.checkpoint.length, 0);
  assert.equal(harness.maintenanceStatus.length, 0);
  assert.deepEqual(Reflect.ownKeys(harness.controlStore).sort(), BOUNDED_FACADE_KEYS);
  assert.equal(
    Reflect.ownKeys(harness).includes('controller')
      || Reflect.ownKeys(harness).includes('provider')
      || Reflect.ownKeys(harness.controlStore).includes('controller')
      || Reflect.ownKeys(harness.controlStore).includes('provider'),
    false,
  );
  assert.equal(fixture.sourceCalls, 0);
});

for (const invalidSource of [
  { name: 'missing source', value: undefined },
  { name: 'non-function source', value: Object.freeze({}) },
  { name: 'nonzero-argument source', value: function sourceWithArgument(_value) {} },
]) {
  test(`bounded checkpoint harness rejects ${invalidSource.name} at construction zero-write`, (t) => {
    const controlDir = createControlDir(t);
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);

    assert.throws(
      () => createBoundedControlStoreTestHarness(controlDir, invalidSource.value),
      TypeError,
    );
    assert.deepEqual(snapshotTree(root), before);
  });
}

test('bounded checkpoint invokes its source exactly once after both leases are held', (t) => {
  const fixture = createAuthorityFixture(t);
  const providerError = new Error('provider stopped after lease probe');
  let lifecycleBusy = false;
  let writerBusy = false;
  fixture.setSource(() => {
    lifecycleBusy = probeLeaseBusy(fixture.harness.controlStore.lifecycleLeasePath);
    writerBusy = probeLeaseBusy(
      path.join(fixture.controlDir, '.controlstore-writer.lock'),
    );
    throw providerError;
  });
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);

  assert.throws(() => fixture.harness.checkpoint(), {
    code: 'RECOVERY_REQUIRED',
  });

  assert.equal(fixture.sourceCalls, 1);
  assert.equal(lifecycleBusy, true);
  assert.equal(writerBusy, true);
  assert.deepEqual(snapshotTree(root), before);
  assert.deepEqual(fixture.harness.controlStore.readEvidence(), fixture.initialEvidence);
});

test('bounded checkpoint controller gives an existing fence priority over invalid provider shape', async (t) => {
  const fixture = createAuthorityFixture(t);
  const controller = controlStoreModule.getBoundedControlStoreCheckpointController(
    fixture.harness.controlStore,
  );
  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => fixture.harness.controlStore.append({
        type: 'bounded.checkpoint.fence-seed',
        payload: { version: 1 },
      }),
      { code: 'RECOVERY_REQUIRED' },
    );
  });
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  let providerCalls = 0;
  function invalidProvider(_unexpectedArgument) {
    providerCalls += 1;
  }

  assert.throws(
    () => controller.installCheckpoint(invalidProvider),
    { code: 'CONTROL_STORE_FENCED' },
  );

  assert.equal(providerCalls, 0);
  assert.deepEqual(snapshotTree(root), before);
});

for (const proxyCase of [
  {
    name: 'revoked Proxy',
    create(authority) {
      const revocable = Proxy.revocable(authority, {});
      revocable.revoke();
      return revocable.proxy;
    },
  },
  {
    name: 'throwing getPrototypeOf Proxy',
    create(authority) {
      return new Proxy(authority, {
        getPrototypeOf() {
          throw new Error('getPrototypeOf trap failed');
        },
      });
    },
  },
  {
    name: 'throwing ownKeys Proxy',
    create(authority) {
      return new Proxy(authority, {
        ownKeys() {
          throw new Error('ownKeys trap failed');
        },
      });
    },
  },
]) {
  test(`bounded checkpoint maps provider ${proxyCase.name} to recovery without fencing`, (t) => {
    const fixture = createAuthorityFixture(t);
    const hostile = proxyCase.create(fixture.authority);
    fixture.setSource(() => hostile);
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);

    assert.throws(
      () => fixture.harness.checkpoint(),
      { code: 'RECOVERY_REQUIRED' },
    );

    assert.equal(fixture.sourceCalls, 1);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fixture.harness.controlStore.readEvidence(), fixture.initialEvidence);
  });
}

for (const thrownCase of [
  {
    name: 'plain forged recovery object',
    create() {
      return Object.freeze({ code: 'RECOVERY_REQUIRED' });
    },
  },
  {
    name: 'object with a throwing code getter',
    create() {
      const thrown = {};
      Object.defineProperty(thrown, 'code', {
        enumerable: true,
        get() {
          throw new Error('code getter failed');
        },
      });
      return Object.freeze(thrown);
    },
  },
  {
    name: 'revoked Proxy',
    create() {
      const revocable = Proxy.revocable(Object.freeze({}), {});
      revocable.revoke();
      return revocable.proxy;
    },
  },
]) {
  test(`bounded checkpoint wraps provider thrown ${thrownCase.name} as minted recovery`, (t) => {
    const fixture = createAuthorityFixture(t);
    const thrown = thrownCase.create();
    fixture.setSource(() => { throw thrown; });
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    let observed;

    assert.throws(
      () => fixture.harness.checkpoint(),
      (error) => {
        observed = error;
        return (
          error !== thrown
          && error?.code === 'RECOVERY_REQUIRED'
          && error?.cause === thrown
        );
      },
    );

    assert.equal(fixture.sourceCalls, 1);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fixture.harness.controlStore.readEvidence(), fixture.initialEvidence);
    assert.equal(observed.cause, thrown);
  });
}

test('bounded checkpoint valid exact authority installs one exact checkpoint receipt', (t) => {
  const fixture = createAuthorityFixture(t);
  fixture.setSource(() => fixture.authority);
  const expectedCheckpoint = buildExpectedCheckpoint(
    fixture.initialEvidence,
    fixture.authority,
  );
  const coveredEventNames = eventFileNames(fixture.controlDir);

  const receipt = fixture.harness.checkpoint();
  const evidence = fixture.harness.controlStore.readEvidence();

  assert.equal(fixture.sourceCalls, 1);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Reflect.ownKeys(receipt).sort(), ['checkpointDigest', 'coveredSeq']);
  assert.deepEqual(receipt, {
    checkpointDigest: expectedCheckpoint.checkpointDigest,
    coveredSeq: expectedCheckpoint.coveredSeq,
  });
  assert.deepEqual(evidence.checkpoint, expectedCheckpoint);
  assert.equal(evidence.checkpoint.checkpointDigest, receipt.checkpointDigest);
  assert.equal(evidence.checkpoint.coveredSeq, receipt.coveredSeq);
  assert.deepEqual(evidence.events, []);
  assert.deepEqual(eventFileNames(fixture.controlDir), []);
  for (const name of coveredEventNames) {
    assert.equal(fs.existsSync(path.join(fixture.controlDir, name)), false);
  }
  assert.equal(fixture.harness.controlStore.assertCurrent(), true);
});

for (const invalidDerivedAuthority of [
  {
    name: 'missing first observation',
    mutate(value) { value.epochObservations = []; },
  },
  {
    name: 'observation count beyond covered sequence',
    mutate(value) {
      value.epochObservations = [
        ...value.epochObservations,
        crypto.randomUUID(),
      ];
    },
  },
]) {
  test(`bounded checkpoint maps ${invalidDerivedAuthority.name} to zero-write recovery`, (t) => {
    const fixture = createAuthorityFixture(t);
    const authority = frozenAuthorityMutation(
      fixture.authority,
      invalidDerivedAuthority.mutate,
    );
    fixture.setSource(() => authority);
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);

    assert.throws(
      () => fixture.harness.checkpoint(),
      { code: 'RECOVERY_REQUIRED' },
    );

    assert.equal(fixture.sourceCalls, 1);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fixture.harness.controlStore.readEvidence(), fixture.initialEvidence);
    assert.equal(fixture.harness.controlStore.assertCurrent(), true);
  });
}

test('bounded checkpoint activation before-publish failure proves rollback and stays retryable', { concurrency: false }, async (t) => {
  const { controlDir, genesis } = createFixtureGenesisStore(t);
  const trace = [];
  const observed = loadControlStoreWithCheckpointObserver(controlDir, trace);
  const facade = observed.module.openControlStore(controlDir, { bounded: true });
  const controller = observed.module.getBoundedControlStoreCheckpointController(facade);
  const authority = createAuthority(facade, genesis);
  const beforeEvidence = facade.readEvidence();
  const expectedCheckpoint = buildExpectedCheckpoint(beforeEvidence, authority);
  const checkpointFile = `.controlstore-checkpoint-${expectedCheckpoint.coveredSeq}-${expectedCheckpoint.checkpointDigest}.json`;
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);
  const marker = new Error('checkpoint activation before-publish marker');
  let sourceCalls = 0;
  let receipt;
  function authorityProvider() {
    sourceCalls += 1;
    return authority;
  }

  const fsObserver = installCheckpointFsObserver(controlDir, trace);
  observed.arm();
  try {
    await withFaults({
      [FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH]: {
        callback(context) {
          assert.equal(context.operation, 'checkpoint-activation');
          trace.push('fault:tail-before-publish:throw');
          throw marker;
        },
      },
    }, async () => {
      assert.throws(
        () => { receipt = controller.installCheckpoint(authorityProvider); },
        (error) => error?.code === 'CONTROL_STORE_IO' && error.cause === marker,
      );
    });
  } finally {
    observed.disarm();
    fsObserver.restore();
  }

  assert.equal(receipt, undefined);
  assert.equal(sourceCalls, 1);
  assert.deepEqual(trace, [
    'acquire:lifecycle',
    'acquire:writer',
    'read:old-tail',
    'read:old-tail',
    'write:checkpoint-candidate:wx',
    'fsync:checkpoint-candidate',
    'link:checkpoint-final:before',
    'link:checkpoint-final:after',
    'unlink:checkpoint-candidate',
    'fsync:directory',
    `read:checkpoint-final:${checkpointFile}`,
    'write:tail-candidate',
    'fsync:tail-candidate',
    'fault:tail-before-publish:throw',
    `unlink:checkpoint-final:${checkpointFile}`,
    'fsync:directory',
    'release:writer',
    'release:lifecycle',
  ]);
  assert.deepEqual(snapshotTree(root), before);
  assert.deepEqual(facade.readEvidence(), beforeEvidence);
  assert.equal(
    fs.readdirSync(controlDir).some((name) => (
      CHECKPOINT_CANDIDATE_PATTERN.test(name) || TAIL_CANDIDATE_PATTERN.test(name)
    )),
    false,
  );
  assert.equal(facade.assertCurrent(), true);

  const retryReceipt = controller.installCheckpoint(authorityProvider);
  assert.equal(sourceCalls, 2);
  assert.equal(Object.isFrozen(retryReceipt), true);
  assert.deepEqual(retryReceipt, {
    checkpointDigest: expectedCheckpoint.checkpointDigest,
    coveredSeq: expectedCheckpoint.coveredSeq,
  });
  assert.equal(facade.assertCurrent(), true);
});

const providerFailureCases = [
  {
    name: 'throw',
    createSource() {
      const failure = new Error('provider throw');
      return () => { throw failure; };
    },
  },
  {
    name: 'Promise result',
    createSource(authority) {
      return () => Promise.resolve(authority);
    },
  },
  {
    name: 'thenable result',
    createSource() {
      const thenable = Object.freeze({ then() {} });
      return () => thenable;
    },
  },
  {
    name: 'top-level accessor',
    createSource(authority) {
      const invalid = {
        cleanBasis: authority.cleanBasis,
        epochObservations: authority.epochObservations,
      };
      Object.defineProperty(invalid, 'snapshot', {
        enumerable: true,
        get() { return authority.snapshot; },
      });
      Object.freeze(invalid);
      return () => invalid;
    },
  },
  {
    name: 'symbol key',
    createSource(authority) {
      const invalid = {
        snapshot: authority.snapshot,
        cleanBasis: authority.cleanBasis,
        epochObservations: authority.epochObservations,
      };
      invalid[Symbol('extra')] = true;
      Object.freeze(invalid);
      return () => invalid;
    },
  },
  {
    name: 'custom prototype',
    createSource(authority) {
      const invalid = Object.create({ inherited: true });
      Object.assign(invalid, {
        snapshot: authority.snapshot,
        cleanBasis: authority.cleanBasis,
        epochObservations: authority.epochObservations,
      });
      Object.freeze(invalid);
      return () => invalid;
    },
  },
  {
    name: 'missing key',
    createSource(authority) {
      return () => Object.freeze({
        snapshot: authority.snapshot,
        cleanBasis: authority.cleanBasis,
      });
    },
  },
  {
    name: 'extra key',
    createSource(authority) {
      return () => Object.freeze({ ...authority, extra: true });
    },
  },
  {
    name: 'mutable nested value',
    createSource(authority) {
      const mutableTail = { ...authority.snapshot.tail };
      const snapshot = Object.freeze({ ...authority.snapshot, tail: mutableTail });
      return () => Object.freeze({
        snapshot,
        cleanBasis: authority.cleanBasis,
        epochObservations: authority.epochObservations,
      });
    },
  },
  {
    name: 'invalid observation UUID',
    createSource(authority) {
      const invalid = frozenAuthorityMutation(authority, (value) => {
        value.epochObservations = ['not-a-uuid'];
      });
      return () => invalid;
    },
  },
  {
    name: 'snapshot incarnation mismatch',
    createSource(authority) {
      const invalid = frozenAuthorityMutation(authority, (value) => {
        value.snapshot.incarnationId = crypto.randomUUID();
      });
      return () => invalid;
    },
  },
  {
    name: 'snapshot tail mismatch',
    createSource(authority) {
      const invalid = frozenAuthorityMutation(authority, (value) => {
        value.snapshot.tail.seq += 1;
      });
      return () => invalid;
    },
  },
  {
    name: 'snapshot clean digest mismatch',
    createSource(authority) {
      const invalid = frozenAuthorityMutation(authority, (value) => {
        value.snapshot.cleanBasisDigest = 'f'.repeat(64);
      });
      return () => invalid;
    },
  },
  {
    name: 'clean basis latest digest mismatch',
    createSource(authority) {
      const invalid = frozenAuthorityMutation(authority, (value) => {
        value.cleanBasis.latestCleanBasisDigest = 'f'.repeat(64);
      });
      return () => invalid;
    },
  },
];

for (const providerCase of providerFailureCases) {
  test(`bounded checkpoint maps provider ${providerCase.name} to zero-write recovery without fencing`, (t) => {
    const fixture = createAuthorityFixture(t);
    fixture.setSource(providerCase.createSource(fixture.authority));
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);

    assert.throws(() => fixture.harness.checkpoint(), {
      code: 'RECOVERY_REQUIRED',
    });

    assert.equal(fixture.sourceCalls, 1);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fixture.harness.controlStore.readEvidence(), fixture.initialEvidence);
  });
}

test('bounded checkpoint empty store blocks before provider and stays unfenced', (t) => {
  const controlDir = createControlDir(t);
  let sourceCalls = 0;
  function authoritySource() {
    sourceCalls += 1;
    throw new Error('empty store must not invoke its authority provider');
  }
  const harness = createBoundedControlStoreTestHarness(controlDir, authoritySource);
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);
  const initialEvidence = harness.controlStore.readEvidence();

  assert.equal(harness.controlStore.tail(), null);
  assert.equal(
    fs.readdirSync(controlDir).some((name) => name.startsWith('.controlstore-checkpoint-')),
    false,
  );
  assert.throws(
    () => harness.checkpoint(),
    { code: 'CONTROL_CHECKPOINT_BLOCKED' },
  );

  assert.equal(sourceCalls, 0);
  assert.deepEqual(snapshotTree(root), before);
  assert.deepEqual(harness.controlStore.readEvidence(), initialEvidence);
  assert.equal(harness.controlStore.assertCurrent(), true);
});

test('bounded checkpoint no-op returns the existing exact frozen receipt without writes or faults', async (t) => {
  const fixture = installCheckpointEvidence(t);
  let sourceCalls = 0;
  let authority;
  function authoritySource() {
    sourceCalls += 1;
    return authority;
  }
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDir,
    authoritySource,
  );
  authority = createCheckpointProjectionAuthority(
    harness.controlStore,
    fixture.checkpoint,
    [],
  );
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const initialEvidence = harness.controlStore.readEvidence();
  const checkpointBytes = fs.readFileSync(
    path.join(fixture.controlDir, fixture.checkpointFile),
  );
  const tailBytes = fs.readFileSync(
    path.join(fixture.controlDir, '.controlstore-tail.json'),
  );
  let faultCalls = 0;

  assert.equal(fixture.tail.activeEventCount, 0);
  assert.equal(fixture.tail.tailSeq, fixture.checkpoint.coveredSeq);
  assert.deepEqual(authority.epochObservations, []);
  assert.deepEqual(authority.snapshot, {
    incarnationId: harness.controlStore.incarnationId,
    tail: {
      seq: fixture.checkpoint.coveredSeq,
      digest: fixture.checkpoint.coveredDigest,
    },
    cleanBasisDigest: fixture.checkpoint.coveredDigest,
  });
  assert.deepEqual(authority.cleanBasis, {
    admissionBasis: fixture.checkpoint.admissionBasis,
    dbKey: fixture.checkpoint.dbKey,
    schema: fixture.checkpoint.schema,
    backend: fixture.checkpoint.backend,
    finalSeq: fixture.checkpoint.finalSeq,
    triggerVersion: fixture.checkpoint.triggerVersion,
    triggerSetDigest: fixture.checkpoint.triggerSetDigest,
    projectInstanceIdSha256: fixture.checkpoint.projectInstanceIdSha256,
    identity: fixture.checkpoint.identity,
    latestCleanBasisDigest: fixture.checkpoint.coveredDigest,
    unresolved: [],
  });

  const receipt = await withFaults({
    [FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH]: {
      callback() { faultCalls += 1; },
    },
    [FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC]: {
      callback() { faultCalls += 1; },
    },
  }, async () => harness.checkpoint());

  assert.equal(sourceCalls, 1);
  assert.equal(faultCalls, 0);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Reflect.ownKeys(receipt).sort(), [
    'checkpointDigest',
    'coveredSeq',
  ]);
  assert.deepEqual(receipt, {
    checkpointDigest: fixture.checkpoint.checkpointDigest,
    coveredSeq: fixture.checkpoint.coveredSeq,
  });
  assert.deepEqual(snapshotTree(root), before);
  assert.deepEqual(harness.controlStore.readEvidence(), initialEvidence);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.controlDir, fixture.checkpointFile)),
    checkpointBytes,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.controlDir, '.controlstore-tail.json')),
    tailBytes,
  );

  const lifecycleLease = acquireExclusiveLease(harness.controlStore.lifecycleLeasePath);
  lifecycleLease.release();
  const writerLease = acquireExclusiveLease(
    path.join(fixture.controlDir, '.controlstore-writer.lock'),
  );
  writerLease.release();
});

for (const noOpMismatch of [
  {
    name: 'nonempty observations',
    createAuthority(controlStore, checkpoint) {
      return createCheckpointProjectionAuthority(
        controlStore,
        checkpoint,
        [checkpoint.admissionBasis.admissionEvent.payload.connectionEpoch],
      );
    },
  },
  {
    name: 'clean-basis projection drift',
    createAuthority(controlStore, checkpoint) {
      return createCheckpointProjectionAuthority(
        controlStore,
        checkpoint,
        [],
        (value) => { value.cleanBasis.finalSeq += 1; },
      );
    },
  },
]) {
  test(`bounded checkpoint no-op rejects ${noOpMismatch.name} as zero-write recovery`, (t) => {
    const fixture = installCheckpointEvidence(t);
    let sourceCalls = 0;
    let authority;
    function authoritySource() {
      sourceCalls += 1;
      return authority;
    }
    const harness = createBoundedControlStoreTestHarness(
      fixture.controlDir,
      authoritySource,
    );
    authority = noOpMismatch.createAuthority(
      harness.controlStore,
      fixture.checkpoint,
    );
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    const initialEvidence = harness.controlStore.readEvidence();

    assert.throws(
      () => harness.checkpoint(),
      { code: 'RECOVERY_REQUIRED' },
    );

    assert.equal(sourceCalls, 1);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(harness.controlStore.readEvidence(), initialEvidence);
    assert.equal(harness.controlStore.assertCurrent(), true);
  });
}

for (const providerObservationCase of [
  {
    name: 'uppercase',
    transform(uuid) { return uuid.toUpperCase(); },
  },
  {
    name: 'mixed-case',
    transform: mixedCaseUuid,
  },
]) {
  test(`bounded checkpoint ${providerObservationCase.name} provider observation is stable zero-write recovery`, (t) => {
    const fixture = createAuthorityFixture(t);
    const invalidAuthority = frozenAuthorityMutation(fixture.authority, (value) => {
      value.epochObservations = value.epochObservations.map(
        providerObservationCase.transform,
      );
    });
    fixture.setSource(() => invalidAuthority);
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);

    assert.throws(
      () => fixture.harness.checkpoint(),
      { code: 'RECOVERY_REQUIRED' },
    );

    assert.equal(fixture.sourceCalls, 1);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fixture.harness.controlStore.readEvidence(), fixture.initialEvidence);
    assert.equal(fixture.harness.controlStore.assertCurrent(), true);
  });
}

test('bounded checkpoint lowercase provider observation installs its exact Bloom evidence', (t) => {
  const fixture = createAuthorityFixture(t);
  fixture.setSource(() => fixture.authority);

  const receipt = fixture.harness.checkpoint();
  const evidence = fixture.harness.controlStore.readEvidence();
  const filter = evidence.checkpoint.connectionEpochFilter;
  const filterBytes = Buffer.from(filter.bitsBase64, 'base64');

  assert.equal(fixture.sourceCalls, 1);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(receipt, {
    checkpointDigest: evidence.checkpoint.checkpointDigest,
    coveredSeq: evidence.checkpoint.coveredSeq,
  });
  assert.equal(filter.epochObservationCount, fixture.authority.epochObservations.length);
  for (const epoch of fixture.authority.epochObservations) {
    assert.equal(epoch, epoch.toLowerCase());
    for (const bit of epochFilterPositions(
      fixture.authority.cleanBasis.admissionBasis.basisDigest,
      epoch,
    )) {
      assert.equal(filterHasBit(filterBytes, bit), true);
    }
  }
  assert.equal(
    fs.readdirSync(fixture.controlDir).some((name) => (
      CHECKPOINT_CANDIDATE_PATTERN.test(name) || TAIL_CANDIDATE_PATTERN.test(name)
    )),
    false,
  );
  assert.equal(fixture.harness.controlStore.assertCurrent(), true);
});

test('bounded checkpoint over-cap first new Bloom bit is blocked before every mutation or fault', { concurrency: false }, async (t) => {
  const fixture = installCheckpointEvidence(t, {
    halfFullFilter: true,
    withActiveSuffix: true,
  });
  assert.equal(countFilterBits(fixture.filterBytes), 4_194_304);
  const newEpoch = findEpochWithClearFilterBit(
    fixture.filterBytes,
    fixture.checkpoint.admissionBasis.basisDigest,
  );
  assert.equal(newEpoch, newEpoch.toLowerCase());
  assert.equal(
    epochFilterPositions(
      fixture.checkpoint.admissionBasis.basisDigest,
      newEpoch,
    ).some((bit) => !filterHasBit(fixture.filterBytes, bit)),
    true,
  );
  const trace = [];
  const observed = loadControlStoreWithCheckpointObserver(
    fixture.controlDir,
    trace,
    { failOnMutation: true },
  );
  const facade = observed.module.openControlStore(
    fixture.controlDir,
    { bounded: true },
  );
  const controller = observed.module.getBoundedControlStoreCheckpointController(facade);
  const authority = createCheckpointProjectionAuthority(
    facade,
    fixture.checkpoint,
    [newEpoch],
  );
  let sourceCalls = 0;
  function authorityProvider() {
    sourceCalls += 1;
    return authority;
  }
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const initialEvidence = facade.readEvidence();
  let faultCalls = 0;
  const faultActions = Object.fromEntries([
    ...Object.values(CHECKPOINT_FAULT_POINTS),
    FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH,
    FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC,
  ].map((faultName) => [
    faultName,
    { callback() { faultCalls += 1; } },
  ]));

  const fsObserver = installCheckpointFsObserver(
    fixture.controlDir,
    trace,
    { failOnMutation: true },
  );
  observed.arm();
  try {
    await withFaults(faultActions, async () => {
      assert.throws(
        () => controller.installCheckpoint(authorityProvider),
        { code: 'CONTROL_CHECKPOINT_BLOCKED' },
      );
    });
  } finally {
    observed.disarm();
    fsObserver.restore();
  }

  assert.equal(sourceCalls, 1);
  assert.equal(faultCalls, 0);
  assert.deepEqual(trace.slice(0, 2), [
    'acquire:lifecycle',
    'acquire:writer',
  ]);
  assert.deepEqual(trace.slice(-2), [
    'release:writer',
    'release:lifecycle',
  ]);
  const evidenceReads = trace.slice(2, -2);
  const tailRead = 'read:new-tail';
  const checkpointRead = `read:checkpoint-final:${fixture.checkpointFile}`;
  assert.equal(
    evidenceReads.every((entry) => entry === tailRead || entry === checkpointRead),
    true,
  );
  const tailReadIndexes = evidenceReads.flatMap((entry, index) => (
    entry === tailRead ? [index] : []
  ));
  assert.equal(tailReadIndexes.length >= 2, true);
  assert.equal(
    evidenceReads.slice(tailReadIndexes[1] + 1).includes(checkpointRead),
    true,
  );
  assert.deepEqual(snapshotTree(root), before);
  assert.deepEqual(facade.readEvidence(), initialEvidence);
  assert.equal(facade.assertCurrent(), true);
});

test('bounded checkpoint active suffix rejects a self-consistent foreign provider admission basis', (t) => {
  const fixture = installCheckpointEvidence(t, { withActiveSuffix: true });
  const foreign = createFixtureGenesisStore(t);
  let sourceCalls = 0;
  let authority;
  function authoritySource() {
    sourceCalls += 1;
    return authority;
  }
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDir,
    authoritySource,
  );
  authority = createAuthority(harness.controlStore, foreign.genesis);
  assert.notDeepEqual(
    authority.cleanBasis.admissionBasis,
    fixture.checkpoint.admissionBasis,
  );
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const initialEvidence = harness.controlStore.readEvidence();

  assert.throws(
    () => harness.checkpoint(),
    { code: 'RECOVERY_REQUIRED' },
  );

  assert.equal(sourceCalls, 1);
  assert.deepEqual(snapshotTree(root), before);
  assert.deepEqual(harness.controlStore.readEvidence(), initialEvidence);
  assert.equal(harness.controlStore.assertCurrent(), true);
});

test('bounded checkpoint active suffix copies and ORs a canonical provider observation into the installed checkpoint', (t) => {
  const fixture = installCheckpointEvidence(t, { withActiveSuffix: true });
  const newEpoch = findEpochWithClearFilterBit(
    fixture.filterBytes,
    fixture.checkpoint.admissionBasis.basisDigest,
  );
  const positions = epochFilterPositions(
    fixture.checkpoint.admissionBasis.basisDigest,
    newEpoch,
  );
  assert.equal(positions.some((bit) => !filterHasBit(fixture.filterBytes, bit)), true);
  const expectedCandidate = Buffer.from(fixture.filterBytes);
  for (const bit of positions) setFilterBit(expectedCandidate, bit);
  assert.ok(countFilterBits(expectedCandidate) <= 4_194_304);
  let sourceCalls = 0;
  let authority;
  function authoritySource() {
    sourceCalls += 1;
    return authority;
  }
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDir,
    authoritySource,
  );
  authority = createCheckpointProjectionAuthority(
    harness.controlStore,
    fixture.checkpoint,
    [newEpoch],
  );
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const initialEvidence = harness.controlStore.readEvidence();
  const expectedCheckpoint = buildExpectedCheckpoint(initialEvidence, authority);
  const oldCheckpointPath = path.join(fixture.controlDir, fixture.checkpointFile);
  const coveredEventNames = eventFileNames(fixture.controlDir);

  const receipt = harness.checkpoint();
  const evidence = harness.controlStore.readEvidence();
  const installedFilter = Buffer.from(
    evidence.checkpoint.connectionEpochFilter.bitsBase64,
    'base64',
  );

  assert.equal(sourceCalls, 1);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(receipt, {
    checkpointDigest: expectedCheckpoint.checkpointDigest,
    coveredSeq: expectedCheckpoint.coveredSeq,
  });
  assert.deepEqual(evidence.checkpoint, expectedCheckpoint);
  assert.deepEqual(evidence.checkpoint.previousCheckpoint, {
    checkpointFile: initialEvidence.tail.checkpointFile,
    checkpointDigest: initialEvidence.tail.checkpointDigest,
    coveredSeq: initialEvidence.tail.coveredSeq,
    coveredDigest: initialEvidence.tail.coveredDigest,
  });
  assert.equal(installedFilter.equals(expectedCandidate), true);
  assert.equal(
    evidence.checkpoint.connectionEpochFilter.epochObservationCount,
    fixture.checkpoint.connectionEpochFilter.epochObservationCount + 1,
  );
  assert.equal(fs.existsSync(oldCheckpointPath), false);
  for (const name of coveredEventNames) {
    assert.equal(fs.existsSync(path.join(fixture.controlDir, name)), false);
  }
  assert.deepEqual(eventFileNames(fixture.controlDir), []);
  assert.notEqual(snapshotTree(root), before);
  assert.equal(harness.controlStore.assertCurrent(), true);
});

test('bounded checkpoint install order exposes all frozen checkpoint fault names', () => {
  for (const [key, name] of Object.entries(CHECKPOINT_FAULT_POINTS)) {
    assert.equal(FAULT_POINTS[key], name);
  }
  assert.equal(Object.isFrozen(FAULT_POINTS), true);
});

test('bounded checkpoint schema install order activation and receipt use one complete authority turn', { concurrency: false }, async (t) => {
  const { controlDir, genesis, legacy, payload } = createFixtureGenesisStore(t);
  const forbidden = {
    body: 'CHECKPOINT_MUST_NOT_COPY_BODY',
    sql: 'CHECKPOINT_MUST_NOT_COPY_SQL',
    params: 'CHECKPOINT_MUST_NOT_COPY_PARAMS',
    dbBytes: 'CHECKPOINT_MUST_NOT_COPY_DB_BYTES',
    formalSha256: 'e'.repeat(64),
  };
  legacy.append({
    type: 'bounded.checkpoint.cumulative-event',
    payload: forbidden,
  });
  legacy.append({
    type: 'bounded.checkpoint.cumulative-event',
    payload: { duplicateType: true },
  });
  legacy.append({
    type: '__proto__',
    payload: { dangerousType: 'prototype' },
  });
  legacy.append({
    type: 'constructor',
    payload: { dangerousType: 'constructor' },
  });

  const trace = [];
  const observed = loadControlStoreWithCheckpointObserver(controlDir, trace);
  const facade = observed.module.openControlStore(controlDir, { bounded: true });
  const controller = observed.module.getBoundedControlStoreCheckpointController(facade);
  const duplicateEpoch = crypto.randomUUID();
  const authority = frozenAuthorityMutation(
    createAuthority(facade, genesis),
    (value) => {
      value.cleanBasis.finalSeq = 41;
      value.epochObservations = [
        payload.connectionEpoch,
        duplicateEpoch,
        duplicateEpoch,
      ];
    },
  );
  const beforeEvidence = facade.readEvidence();
  const expectedCheckpoint = buildExpectedCheckpoint(beforeEvidence, authority);
  const checkpointFile = `.controlstore-checkpoint-${expectedCheckpoint.coveredSeq}-${expectedCheckpoint.checkpointDigest}.json`;
  const coveredEventNames = eventFileNames(controlDir);
  assert.equal(coveredEventNames.length, 5);
  let sourceCalls = 0;
  let gcEntryIndex = 0;
  function authorityProvider() {
    sourceCalls += 1;
    return authority;
  }

  const fsObserver = installCheckpointFsObserver(controlDir, trace);
  observed.arm();
  let receipt;
  try {
    receipt = await withFaults({
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH]: {
        callback() { trace.push('fault:checkpoint-before-publish'); },
      },
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK]: {
        callback() {
          trace.push('fault:checkpoint-before-candidate-unlink');
          fsObserver.silence(() => {
            const candidateName = fs.readdirSync(controlDir).find(
              (name) => CHECKPOINT_CANDIDATE_PATTERN.test(name),
            );
            assert.equal(typeof candidateName, 'string');
            const candidateStats = fs.statSync(path.join(controlDir, candidateName));
            const finalStats = fs.statSync(path.join(controlDir, checkpointFile));
            assert.equal(candidateStats.dev, finalStats.dev);
            assert.equal(candidateStats.ino, finalStats.ino);
          });
        },
      },
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC]: {
        callback() { trace.push('fault:checkpoint-before-final-dir-fsync'); },
      },
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC]: {
        callback() { trace.push('fault:checkpoint-after-final-dir-fsync'); },
      },
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC]: {
        callback() {
          trace.push('fault:checkpoint-before-gc');
          assert.ok(trace.includes('read:new-tail'));
          assert.ok(trace.includes(`read:checkpoint-final:${checkpointFile}`));
          for (const name of coveredEventNames) {
            assert.equal(fs.existsSync(path.join(controlDir, name)), true);
          }
        },
      },
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY]: {
        callback(context) {
          const entryName = coveredEventNames[gcEntryIndex];
          assert.deepEqual(context, {
            entryKind: 'event',
            entryName,
          });
          assert.equal(trace.at(-1), `unlink:event:${entryName}`);
          gcEntryIndex += 1;
          trace.push('fault:checkpoint-after-gc-entry');
        },
      },
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC]: {
        callback() { trace.push('fault:checkpoint-before-gc-dir-fsync'); },
      },
      [FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH]: {
        callback(context) {
          assert.equal(context.operation, 'checkpoint-activation');
          trace.push('fault:tail-before-publish');
          for (const name of coveredEventNames) {
            assert.equal(fs.existsSync(path.join(controlDir, name)), true);
          }
        },
      },
      [FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC]: {
        callback(context) {
          assert.equal(context.operation, 'checkpoint-activation');
          trace.push('fault:tail-before-dir-fsync');
          for (const name of coveredEventNames) {
            assert.equal(fs.existsSync(path.join(controlDir, name)), true);
          }
        },
      },
    }, async () => controller.installCheckpoint(authorityProvider));
    trace.push('receipt:return');
  } finally {
    observed.disarm();
    fsObserver.restore();
  }

  assert.equal(sourceCalls, 1);
  assert.equal(gcEntryIndex, coveredEventNames.length);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Reflect.ownKeys(receipt).sort(), ['checkpointDigest', 'coveredSeq']);
  assert.deepEqual(receipt, {
    checkpointDigest: expectedCheckpoint.checkpointDigest,
    coveredSeq: expectedCheckpoint.coveredSeq,
  });
  const checkpointPath = path.join(controlDir, checkpointFile);
  const checkpointBytes = fs.readFileSync(checkpointPath, 'utf8');
  assert.equal(checkpointBytes, canonicalJson(expectedCheckpoint));
  const afterEvidence = facade.readEvidence();
  assert.deepEqual(afterEvidence.checkpoint, expectedCheckpoint);
  assert.deepEqual(
    Reflect.ownKeys(afterEvidence.checkpoint).sort(),
    [...CHECKPOINT_KEYS].sort(),
  );
  assert.equal(afterEvidence.checkpoint.previousCheckpoint, null);
  assert.deepEqual(
    afterEvidence.checkpoint.admissionBasis,
    authority.cleanBasis.admissionBasis,
  );
  assert.notEqual(
    afterEvidence.checkpoint.admissionBasis,
    authority.cleanBasis.admissionBasis,
  );
  assert.equal(afterEvidence.checkpoint.coveredSeq, beforeEvidence.tail.tailSeq);
  assert.equal(afterEvidence.checkpoint.coveredDigest, beforeEvidence.tail.tailDigest);
  assert.deepEqual(afterEvidence.checkpoint.chainRoot, {
    seq: 1,
    digest: genesis.digest,
  });
  const expectedEventTypeCounts = Object.fromEntries([
    ['__proto__', 1],
    ['bounded.checkpoint.cumulative-event', 2],
    ['constructor', 1],
    ['sqlite.native.stage_b.fixture_genesis', 1],
  ]);
  assert.deepEqual(afterEvidence.checkpoint.eventTypeCounts, expectedEventTypeCounts);
  assert.deepEqual(
    Reflect.ownKeys(afterEvidence.checkpoint.eventTypeCounts).sort(),
    Reflect.ownKeys(expectedEventTypeCounts).sort(),
  );
  for (const key of ['__proto__', 'constructor']) {
    const descriptor = Object.getOwnPropertyDescriptor(
      afterEvidence.checkpoint.eventTypeCounts,
      key,
    );
    assert.equal(descriptor?.enumerable, true);
    assert.equal(Object.prototype.hasOwnProperty.call(descriptor, 'value'), true);
    assert.equal(descriptor.value, 1);
  }
  assert.equal(
    Object.values(afterEvidence.checkpoint.eventTypeCounts)
      .reduce((sum, count) => sum + count, 0),
    afterEvidence.checkpoint.coveredSeq,
  );
  for (const key of [
    'dbKey',
    'schema',
    'backend',
    'finalSeq',
    'triggerVersion',
    'triggerSetDigest',
    'projectInstanceIdSha256',
    'identity',
    'latestCleanBasisDigest',
    'unresolved',
  ]) {
    assert.deepEqual(afterEvidence.checkpoint[key], authority.cleanBasis[key]);
  }
  assert.deepEqual(afterEvidence.checkpoint.unresolved, []);
  assert.equal(afterEvidence.checkpoint.retryContinuationOpen, false);
  const filter = afterEvidence.checkpoint.connectionEpochFilter;
  const filterBytes = Buffer.from(filter.bitsBase64, 'base64');
  assert.equal(filterBytes.length, 1_048_576);
  assert.equal(filterBytes.toString('base64'), filter.bitsBase64);
  assert.equal(filter.algorithm, 'sha256-domain-separated-v1');
  assert.equal(filter.bitCount, 8_388_608);
  assert.equal(filter.hashCount, 7);
  assert.equal(filter.epochObservationCount, 3);
  for (const epoch of authority.epochObservations) {
    for (const bit of epochFilterPositions(genesis.digest, epoch)) {
      assert.equal(filterHasBit(filterBytes, bit), true);
    }
  }
  for (const value of Object.values(forbidden)) {
    assert.equal(checkpointBytes.includes(value), false);
  }
  assert.equal(checkpointBytes.includes('formalSha256'), false);
  assert.deepEqual(afterEvidence.events, []);
  assert.equal(afterEvidence.tail.checkpointFile, checkpointFile);
  assert.equal(afterEvidence.tail.checkpointDigest, expectedCheckpoint.checkpointDigest);
  assert.equal(afterEvidence.tail.coveredSeq, expectedCheckpoint.coveredSeq);
  assert.equal(afterEvidence.tail.coveredDigest, expectedCheckpoint.coveredDigest);
  assert.equal(afterEvidence.tail.activeEventCount, 0);
  assert.equal(afterEvidence.tail.activeEventBytes, 0);
  assert.deepEqual(eventFileNames(controlDir), []);
  assert.equal(
    fs.readdirSync(controlDir).some((name) => (
      CHECKPOINT_CANDIDATE_PATTERN.test(name) || TAIL_CANDIDATE_PATTERN.test(name)
    )),
    false,
  );
  assert.deepEqual(trace, [
    'acquire:lifecycle',
    'acquire:writer',
    'read:old-tail',
    'read:old-tail',
    'write:checkpoint-candidate:wx',
    'fsync:checkpoint-candidate',
    'fault:checkpoint-before-publish',
    'link:checkpoint-final:before',
    'link:checkpoint-final:after',
    'fault:checkpoint-before-candidate-unlink',
    'unlink:checkpoint-candidate',
    'fault:checkpoint-before-final-dir-fsync',
    'fsync:directory',
    'fault:checkpoint-after-final-dir-fsync',
    `read:checkpoint-final:${checkpointFile}`,
    'write:tail-candidate',
    'fsync:tail-candidate',
    'fault:tail-before-publish',
    'atomic-replace:tail:before',
    'atomic-replace:tail:after',
    'fault:tail-before-dir-fsync',
    'fsync:directory',
    'read:new-tail',
    `read:checkpoint-final:${checkpointFile}`,
    'fault:checkpoint-before-gc',
    ...coveredEventNames.flatMap((name) => [
      `unlink:event:${name}`,
      'fault:checkpoint-after-gc-entry',
    ]),
    'fault:checkpoint-before-gc-dir-fsync',
    'fsync:directory',
    'read:new-tail',
    `read:checkpoint-final:${checkpointFile}`,
    'release:writer',
    'release:lifecycle',
    'receipt:return',
  ]);
});

test('bounded checkpoint previous checkpoint activation inherits cumulative counts and Bloom without broad GC', { concurrency: false }, async (t) => {
  const { controlDir, genesis, legacy } = createFixtureGenesisStore(t);
  legacy.append({
    type: '__proto__',
    payload: { generation: 'previous', dangerousType: 'prototype' },
  });
  legacy.append({
    type: 'constructor',
    payload: { generation: 'previous', dangerousType: 'constructor' },
  });
  let sourceCalls = 0;
  let authority;
  function authoritySource() {
    sourceCalls += 1;
    return authority;
  }
  const harness = createBoundedControlStoreTestHarness(controlDir, authoritySource);
  authority = createAuthority(harness.controlStore, genesis);
  const firstBefore = harness.controlStore.readEvidence();
  const expectedFirst = buildExpectedCheckpoint(firstBefore, authority);
  const firstReceipt = harness.checkpoint();
  assert.deepEqual(firstReceipt, {
    checkpointDigest: expectedFirst.checkpointDigest,
    coveredSeq: expectedFirst.coveredSeq,
  });

  const previousEvidence = harness.controlStore.readEvidence();
  const previousCheckpoint = previousEvidence.checkpoint;
  const previousTail = cloneData(previousEvidence.tail);
  const previousFile = previousTail.checkpointFile;
  const previousBytes = fs.readFileSync(path.join(controlDir, previousFile));
  const recoveryDir = path.join(controlDir, 'sqlite-recovery');
  fs.mkdirSync(recoveryDir, { recursive: true });
  const similarNestedPath = path.join(recoveryDir, previousFile);
  fs.writeFileSync(similarNestedPath, previousBytes);

  const firstSuffix = harness.controlStore.append({
    type: 'bounded.checkpoint.repeated-event',
    payload: { ordinal: 1 },
  });
  const secondSuffix = harness.controlStore.compareAndAppend(firstSuffix.digest, {
    type: 'bounded.checkpoint.repeated-event',
    payload: { ordinal: 2 },
  });
  const prototypeSuffix = harness.controlStore.compareAndAppend(secondSuffix.digest, {
    type: '__proto__',
    payload: { dangerousType: 'prototype' },
  });
  const finalSuffix = harness.controlStore.compareAndAppend(prototypeSuffix.digest, {
    type: 'constructor',
    payload: { dangerousType: 'constructor' },
  });
  const repeatedEpoch = crypto.randomUUID();
  authority = createCheckpointProjectionAuthority(
    harness.controlStore,
    previousCheckpoint,
    [repeatedEpoch, repeatedEpoch],
    (value) => { value.cleanBasis.finalSeq += 7; },
  );
  const secondBefore = harness.controlStore.readEvidence();
  const expectedSecond = buildExpectedCheckpoint(secondBefore, authority);
  const suffixNames = eventFileNames(controlDir);
  assert.equal(suffixNames.length, 4);

  const gcTrace = [];
  const expectedGcEntries = [
    ...suffixNames.map((entryName) => ({ entryKind: 'event', entryName })),
    { entryKind: 'old-checkpoint', entryName: previousFile },
  ];
  let gcEntryIndex = 0;
  let secondReceipt;
  const fsObserver = installCheckpointFsObserver(controlDir, gcTrace);
  try {
    secondReceipt = await withFaults({
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY]: {
        callback(context) {
          const expected = expectedGcEntries[gcEntryIndex];
          assert.deepEqual(context, expected);
          assert.equal(
            gcTrace.at(-1),
            expected.entryKind === 'event'
              ? `unlink:event:${expected.entryName}`
              : `unlink:checkpoint-final:${expected.entryName}`,
          );
          gcEntryIndex += 1;
          gcTrace.push('fault:checkpoint-after-gc-entry');
        },
      },
    }, async () => harness.checkpoint());
  } finally {
    fsObserver.restore();
  }
  const currentEvidence = harness.controlStore.readEvidence();
  assert.equal(sourceCalls, 2);
  assert.equal(gcEntryIndex, expectedGcEntries.length);
  assert.equal(Object.isFrozen(secondReceipt), true);
  assert.deepEqual(secondReceipt, {
    checkpointDigest: expectedSecond.checkpointDigest,
    coveredSeq: expectedSecond.coveredSeq,
  });
  assert.deepEqual(currentEvidence.checkpoint, expectedSecond);
  assert.ok(currentEvidence.checkpoint.coveredSeq > previousCheckpoint.coveredSeq);
  assert.deepEqual(currentEvidence.checkpoint.previousCheckpoint, {
    checkpointFile: previousTail.checkpointFile,
    checkpointDigest: previousTail.checkpointDigest,
    coveredSeq: previousTail.coveredSeq,
    coveredDigest: previousTail.coveredDigest,
  });
  for (const key of [
    'checkpointFile',
    'checkpointDigest',
    'coveredSeq',
    'coveredDigest',
  ]) {
    const mutated = cloneData(currentEvidence.checkpoint);
    delete mutated.checkpointDigest;
    if (key === 'coveredSeq') {
      mutated.previousCheckpoint[key] += 1;
    } else {
      mutated.previousCheckpoint[key] = `${mutated.previousCheckpoint[key]}-changed`;
    }
    assert.notEqual(
      digestRecord(mutated, 'checkpointDigest'),
      currentEvidence.checkpoint.checkpointDigest,
    );
  }
  assert.equal(
    canonicalJson(currentEvidence.checkpoint.admissionBasis),
    canonicalJson(previousCheckpoint.admissionBasis),
  );
  assert.deepEqual(currentEvidence.checkpoint.chainRoot, previousCheckpoint.chainRoot);
  for (const key of ['__proto__', 'constructor']) {
    assert.equal(
      Object.getOwnPropertyDescriptor(previousCheckpoint.eventTypeCounts, key)?.value,
      1,
    );
  }
  const expectedRepeatedCountMap = new Map(
    Object.entries(previousCheckpoint.eventTypeCounts),
  );
  for (const [type, increment] of [
    ['__proto__', 1],
    ['bounded.checkpoint.repeated-event', 2],
    ['constructor', 1],
  ]) {
    expectedRepeatedCountMap.set(
      type,
      (expectedRepeatedCountMap.get(type) || 0) + increment,
    );
  }
  const expectedRepeatedCounts = Object.fromEntries(
    [...expectedRepeatedCountMap.entries()].sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
  assert.deepEqual(currentEvidence.checkpoint.eventTypeCounts, expectedRepeatedCounts);
  for (const key of ['__proto__', 'constructor']) {
    const descriptor = Object.getOwnPropertyDescriptor(
      currentEvidence.checkpoint.eventTypeCounts,
      key,
    );
    assert.equal(descriptor?.enumerable, true);
    assert.equal(Object.prototype.hasOwnProperty.call(descriptor, 'value'), true);
    assert.equal(descriptor.value, 2);
  }
  assert.equal(
    Object.values(currentEvidence.checkpoint.eventTypeCounts)
      .reduce((sum, count) => sum + count, 0),
    currentEvidence.checkpoint.coveredSeq,
  );
  const previousFilter = Buffer.from(
    previousCheckpoint.connectionEpochFilter.bitsBase64,
    'base64',
  );
  const expectedFilter = Buffer.from(previousFilter);
  for (const bit of epochFilterPositions(
    previousCheckpoint.admissionBasis.basisDigest,
    repeatedEpoch,
  )) {
    setFilterBit(expectedFilter, bit);
  }
  const currentFilter = Buffer.from(
    currentEvidence.checkpoint.connectionEpochFilter.bitsBase64,
    'base64',
  );
  assert.deepEqual(currentFilter, expectedFilter);
  assert.equal(
    currentEvidence.checkpoint.connectionEpochFilter.epochObservationCount,
    previousCheckpoint.connectionEpochFilter.epochObservationCount + 2,
  );
  assert.equal(fs.existsSync(path.join(controlDir, previousFile)), false);
  for (const name of suffixNames) {
    assert.equal(fs.existsSync(path.join(controlDir, name)), false);
  }
  assert.deepEqual(fs.readFileSync(similarNestedPath), previousBytes);
  assert.deepEqual(currentEvidence.events, []);
  assert.equal(currentEvidence.tail.tailSeq, finalSuffix.seq);
});

test('bounded checkpoint Bloom actual 50% succeeds when all seven observation bits already exist', { concurrency: false }, (t) => {
  const fixture = installCheckpointEvidence(t, {
    halfFullFilter: true,
    withActiveSuffix: true,
  });
  assert.equal(countFilterBits(fixture.filterBytes), 4_194_304);
  const epoch = findEpochWithAllFilterBits(
    fixture.filterBytes,
    fixture.checkpoint.admissionBasis.basisDigest,
  );
  assert.equal(
    epochFilterPositions(
      fixture.checkpoint.admissionBasis.basisDigest,
      epoch,
    ).every((bit) => filterHasBit(fixture.filterBytes, bit)),
    true,
  );
  let sourceCalls = 0;
  let authority;
  function authoritySource() {
    sourceCalls += 1;
    return authority;
  }
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDir,
    authoritySource,
  );
  authority = createCheckpointProjectionAuthority(
    harness.controlStore,
    fixture.checkpoint,
    [epoch],
  );
  const before = harness.controlStore.readEvidence();
  const expected = buildExpectedCheckpoint(before, authority);
  const receipt = harness.checkpoint();
  const after = harness.controlStore.readEvidence();

  assert.equal(sourceCalls, 1);
  assert.deepEqual(receipt, {
    checkpointDigest: expected.checkpointDigest,
    coveredSeq: expected.coveredSeq,
  });
  assert.deepEqual(after.checkpoint, expected);
  const actualFilter = Buffer.from(
    after.checkpoint.connectionEpochFilter.bitsBase64,
    'base64',
  );
  assert.deepEqual(actualFilter, fixture.filterBytes);
  assert.equal(countFilterBits(actualFilter), 4_194_304);
  assert.equal(
    after.checkpoint.connectionEpochFilter.epochObservationCount,
    fixture.checkpoint.connectionEpochFilter.epochObservationCount + 1,
  );
  assert.equal(fs.existsSync(path.join(fixture.controlDir, fixture.checkpointFile)), false);
  assert.deepEqual(eventFileNames(fixture.controlDir), []);
  assert.deepEqual(after.events, []);
});

test('bounded checkpoint no-clobber activation preserves a raced preexisting final and old authority', { concurrency: false }, (t) => {
  const { controlDir, genesis } = createFixtureGenesisStore(t);
  const trace = [];
  const observed = loadControlStoreWithCheckpointObserver(controlDir, trace);
  const facade = observed.module.openControlStore(controlDir, { bounded: true });
  const controller = observed.module.getBoundedControlStoreCheckpointController(facade);
  const authority = createAuthority(facade, genesis);
  const beforeEvidence = facade.readEvidence();
  const expected = buildExpectedCheckpoint(beforeEvidence, authority);
  const expectedFile = `.controlstore-checkpoint-${expected.coveredSeq}-${expected.checkpointDigest}.json`;
  const expectedPath = path.join(controlDir, expectedFile);
  const sentinel = Buffer.from('raced-preexisting-checkpoint-final-must-not-be-clobbered');
  const tailBefore = fs.readFileSync(path.join(controlDir, '.controlstore-tail.json'));
  const eventBytesBefore = new Map(eventFileNames(controlDir).map((name) => [
    name,
    fs.readFileSync(path.join(controlDir, name)),
  ]));
  let injectedTarget = null;
  const fsObserver = installCheckpointFsObserver(controlDir, trace, {
    beforeCheckpointLink({ originals, targetPath }) {
      assert.equal(path.resolve(targetPath), path.resolve(expectedPath));
      originals.writeFileSync(targetPath, sentinel, { flag: 'wx' });
      injectedTarget = targetPath;
    },
  });
  let sourceCalls = 0;
  let receipt;
  let observedError;
  observed.arm();
  try {
    try {
      receipt = controller.installCheckpoint(() => {
        sourceCalls += 1;
        return authority;
      });
    } catch (error) {
      observedError = error;
    }
  } finally {
    observed.disarm();
    fsObserver.restore();
  }

  assert.equal(observedError?.code, 'RECOVERY_REQUIRED');
  assert.equal(receipt, undefined);
  assert.equal(sourceCalls, 1);
  assert.equal(path.resolve(injectedTarget), path.resolve(expectedPath));
  assert.deepEqual(fs.readFileSync(expectedPath), sentinel);
  assert.deepEqual(
    fs.readFileSync(path.join(controlDir, '.controlstore-tail.json')),
    tailBefore,
  );
  for (const [name, bytes] of eventBytesBefore) {
    assert.deepEqual(fs.readFileSync(path.join(controlDir, name)), bytes);
  }
  assert.equal(trace.includes('atomic-replace:tail:before'), false);
  assert.equal(trace.some((entry) => entry.startsWith('unlink:event:')), false);
  assert.equal(
    fs.readdirSync(controlDir).some((name) => CHECKPOINT_CANDIDATE_PATTERN.test(name)),
    false,
  );
  assert.throws(() => facade.assertCurrent(), { code: 'CONTROL_STORE_FENCED' });
});

test('bounded checkpoint maintenance status count high-water is inclusive OR and never blocks generic writes', { concurrency: false, timeout: 120_000 }, (t) => {
  const controlDir = createControlDir(t);
  const legacy = openControlStore(controlDir);
  let last = null;
  let activeEventBytes = 0;
  const extendTo = (targetCount) => {
    for (let seq = (last?.event.seq || 0) + 1; seq <= targetCount; seq += 1) {
      const materialized = materializeStoredEvent(
        seq,
        last?.event.digest || null,
        'bounded.checkpoint.maintenance-count',
        { ordinal: seq },
      );
      writeStoredEvent(controlDir, materialized);
      activeEventBytes += materialized.bytes;
      last = materialized;
    }
    writeNoCheckpointTail(
      controlDir,
      legacy.incarnationId,
      last.event,
      targetCount,
      activeEventBytes,
    );
  };
  extendTo(4095);
  let sourceCalls = 0;
  const maintenanceTrace = [];
  const observedMaintenance = loadBoundedHarnessWithMaintenanceObserver(
    controlDir,
    maintenanceTrace,
  );
  const harness = observedMaintenance.createHarness(() => {
    sourceCalls += 1;
    throw new Error('maintenance status must not call the authority source');
  });
  const outcomes = [];
  const observeStatus = (count, bytes, level) => {
    const root = path.dirname(controlDir);
    const before = snapshotTreeDigest(root);
    const traceStart = maintenanceTrace.length;
    const mutationGuard = installMaintenanceMutationGuard();
    observedMaintenance.arm();
    let outcome;
    try {
      outcome = captureMaintenanceStatus(harness);
    } finally {
      observedMaintenance.disarm();
      mutationGuard.restore();
    }
    const after = snapshotTreeDigest(root);
    assert.equal(after, before);
    outcomes.push({
      bytes,
      count,
      level,
      leaseTrace: maintenanceTrace.slice(traceStart),
      outcome,
    });
  };

  observeStatus(4095, activeEventBytes, 'none');
  extendTo(4096);
  observeStatus(4096, activeEventBytes, 'soft');
  extendTo(8191);
  observeStatus(8191, activeEventBytes, 'soft');
  assert.ok(activeEventBytes < 16 * 1024 * 1024);

  const appendReceipt = harness.controlStore.append({
    type: 'bounded.checkpoint.maintenance-count',
    payload: { ordinal: 8192 },
  });
  activeEventBytes = harness.controlStore.readEvidence().tail.activeEventBytes;
  assert.equal(appendReceipt.seq, 8192);
  observeStatus(8192, activeEventBytes, 'hard');
  const compareReceipt = harness.controlStore.compareAndAppend(appendReceipt.digest, {
    type: 'bounded.checkpoint.maintenance-count',
    payload: { ordinal: 8193 },
  });
  activeEventBytes = harness.controlStore.readEvidence().tail.activeEventBytes;
  assert.equal(compareReceipt.seq, 8193);
  observeStatus(8193, activeEventBytes, 'hard');

  assert.equal(sourceCalls, 0);
  assert.deepEqual(
    outcomes.map(({ bytes, count, level, outcome }) => (
      outcome.status
        ? { status: outcome.status }
        : { errorCode: outcome.errorCode, expected: { activeEventBytes: bytes, activeEventCount: count, level } }
    )),
    outcomes.map(({ bytes, count, level }) => ({
      status: {
        activeEventCount: count,
        activeEventBytes: bytes,
        level,
      },
    })),
  );
  for (const { bytes, count, level, leaseTrace, outcome } of outcomes) {
    assertExactFrozenStatus(outcome.status, {
      activeEventCount: count,
      activeEventBytes: bytes,
      level,
    });
    assert.deepEqual(leaseTrace, [
      'maintenance:acquire:lifecycle',
      'maintenance:release:lifecycle',
    ]);
  }
});

test('bounded checkpoint maintenance status UTF8 byte high-water is exact at 16MiB and 32MiB', { concurrency: false, timeout: 180_000 }, (t) => {
  const controlDir = createControlDir(t);
  const legacy = openControlStore(controlDir);
  const rows = [
    { bytes: 16 * 1024 * 1024 - 1, level: 'none' },
    { bytes: 16 * 1024 * 1024, level: 'soft' },
    { bytes: 32 * 1024 * 1024 - 1, level: 'soft' },
    { bytes: 32 * 1024 * 1024, level: 'hard' },
  ];
  let currentName = null;
  let sourceCalls = 0;
  let harness = null;
  const maintenanceTrace = [];
  const observedMaintenance = loadBoundedHarnessWithMaintenanceObserver(
    controlDir,
    maintenanceTrace,
  );
  const outcomes = [];
  const observeStatus = (bytes, level, count = 1) => {
    const root = path.dirname(controlDir);
    const before = snapshotTreeDigest(root);
    const traceStart = maintenanceTrace.length;
    const mutationGuard = installMaintenanceMutationGuard();
    observedMaintenance.arm();
    let outcome;
    try {
      outcome = captureMaintenanceStatus(harness);
    } finally {
      observedMaintenance.disarm();
      mutationGuard.restore();
    }
    const after = snapshotTreeDigest(root);
    assert.equal(after, before);
    outcomes.push({
      bytes,
      count,
      leaseTrace: maintenanceTrace.slice(traceStart),
      level,
      outcome,
    });
  };

  for (const row of rows) {
    if (currentName) fs.rmSync(path.join(controlDir, currentName));
    const materialized = materializeExactByteEvent(row.bytes);
    currentName = writeStoredEvent(controlDir, materialized);
    writeNoCheckpointTail(
      controlDir,
      legacy.incarnationId,
      materialized.event,
      1,
      row.bytes,
    );
    if (!harness) {
      harness = observedMaintenance.createHarness(() => {
        sourceCalls += 1;
        throw new Error('maintenance status must not call the authority source');
      });
    }
    observeStatus(row.bytes, row.level);
  }

  const appendReceipt = harness.controlStore.append({
    type: 'bounded.checkpoint.maintenance-bytes-crossing',
    payload: { terminal: 'append' },
  });
  const afterAppend = harness.controlStore.readEvidence().tail;
  assert.equal(appendReceipt.seq, 2);
  assert.equal(afterAppend.activeEventCount, 2);
  assert.ok(afterAppend.activeEventBytes > 32 * 1024 * 1024);
  observeStatus(afterAppend.activeEventBytes, 'hard', 2);
  const compareReceipt = harness.controlStore.compareAndAppend(appendReceipt.digest, {
    type: 'bounded.checkpoint.maintenance-bytes-crossing',
    payload: { terminal: 'compareAndAppend' },
  });
  const afterCompare = harness.controlStore.readEvidence().tail;
  assert.equal(compareReceipt.seq, 3);
  assert.equal(afterCompare.activeEventCount, 3);
  assert.ok(afterCompare.activeEventBytes > afterAppend.activeEventBytes);
  observeStatus(afterCompare.activeEventBytes, 'hard', 3);

  assert.equal(sourceCalls, 0);
  assert.deepEqual(
    outcomes.map(({ bytes, count, level, outcome }) => (
      outcome.status
        ? { status: outcome.status }
        : { errorCode: outcome.errorCode, expected: { activeEventBytes: bytes, activeEventCount: count, level } }
    )),
    outcomes.map(({ bytes, count, level }) => ({
      status: {
        activeEventCount: count,
        activeEventBytes: bytes,
        level,
      },
    })),
  );
  for (const { bytes, count, leaseTrace, level, outcome } of outcomes) {
    assertExactFrozenStatus(outcome.status, {
      activeEventCount: count,
      activeEventBytes: bytes,
      level,
    });
    assert.deepEqual(leaseTrace, [
      'maintenance:acquire:lifecycle',
      'maintenance:release:lifecycle',
    ]);
  }
});

const legalOldTailProposalCases = [
  {
    name: 'candidate only',
    setup(fixture) {
      return [writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint)];
    },
  },
  {
    name: 'candidate and hard-linked final',
    setup(fixture) {
      const candidatePath = writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint);
      const finalPath = path.join(fixture.controlDir, fixture.checkpointFile);
      fs.linkSync(candidatePath, finalPath);
      const candidateStats = fs.statSync(candidatePath, { bigint: true });
      const finalStats = fs.statSync(finalPath, { bigint: true });
      assert.equal(candidateStats.dev, finalStats.dev);
      assert.equal(candidateStats.ino, finalStats.ino);
      assert.deepEqual(fs.readFileSync(candidatePath), fs.readFileSync(finalPath));
      return [candidatePath, finalPath];
    },
  },
  {
    name: 'orphan final only',
    setup(fixture) {
      return [writeCheckpointFinal(
        fixture.controlDir,
        fixture.checkpoint,
        fixture.checkpointFile,
      )];
    },
  },
  {
    name: 'orphan final and exact tail candidate',
    setup(fixture) {
      return [
        writeCheckpointFinal(
          fixture.controlDir,
          fixture.checkpoint,
          fixture.checkpointFile,
        ),
        writeCheckpointTailCandidate(fixture.controlDir, fixture.activationTail),
      ];
    },
  },
  {
    name: 'candidate with mechanically valid absent previous descriptor target',
    setup(fixture) {
      const absentDigest = crypto.createHash('sha256')
        .update('batch4-absent-proposal-predecessor')
        .digest('hex');
      const absentCoveredDigest = crypto.createHash('sha256')
        .update('batch4-absent-proposal-covered-event')
        .digest('hex');
      const proposal = rematerializeCheckpoint(fixture.checkpoint, (record) => {
        record.previousCheckpoint = {
          checkpointFile: `.controlstore-checkpoint-1-${absentDigest}.json`,
          checkpointDigest: absentDigest,
          coveredSeq: 1,
          coveredDigest: absentCoveredDigest,
        };
      });
      const absentTarget = path.join(
        fixture.controlDir,
        proposal.checkpoint.previousCheckpoint.checkpointFile,
      );
      assert.equal(fs.existsSync(absentTarget), false);
      return [writeCheckpointCandidate(
        fixture.controlDir,
        proposal.checkpoint,
      )];
    },
  },
];

for (const proposalCase of legalOldTailProposalCases) {
  test(`bounded checkpoint proposal old-tail legal ${proposalCase.name} cleans exactly once without following predecessor`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    const proposalPaths = proposalCase.setup(fixture);
    const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
    const predecessorPath = path.join(fixture.controlDir, fixture.previousCheckpointFile);
    const tailBytes = fs.readFileSync(tailPath);
    const predecessorBytes = fs.readFileSync(predecessorPath);
    const eventBytes = new Map(eventFileNames(fixture.controlDir).map((name) => [
      name,
      fs.readFileSync(path.join(fixture.controlDir, name)),
    ]));
    const mutationTrace = [];
    const runtime = loadCheckpointRuntimeWithHooks(
      mutationTraceHooks(mutationTrace),
    );
    let providerCalls = 0;
    const harness = withFsMutationTrace(mutationTrace, () => (
      runtime.createHarnessAt(fixture.controlDir, () => {
        providerCalls += 1;
        throw new Error('startup proposal cleanup must not call provider');
      })
    ));

    assert.equal(providerCalls, 0);
    assertExactDeleteThenDirectoryFsync(
      mutationTrace,
      proposalPaths,
      fixture.controlDir,
    );
    for (const proposalPath of proposalPaths) assert.equal(fs.existsSync(proposalPath), false);
    assert.deepEqual(fs.readFileSync(tailPath), tailBytes);
    assert.deepEqual(fs.readFileSync(predecessorPath), predecessorBytes);
    for (const [name, bytes] of eventBytes) {
      assert.deepEqual(fs.readFileSync(path.join(fixture.controlDir, name)), bytes);
    }
    assert.deepEqual(harness.controlStore.readEvidence(), fixture.evidence);
    const after = snapshotTree(path.dirname(fixture.controlDir));

    const traceLength = mutationTrace.length;
    const reopened = withFsMutationTrace(mutationTrace, () => (
      runtime.createHarnessAt(fixture.controlDir, () => {
        providerCalls += 1;
        throw new Error('idempotent proposal reopen must not call provider');
      })
    ));
    assert.equal(providerCalls, 0);
    assert.equal(mutationTrace.length, traceLength);
    assert.deepEqual(snapshotTree(path.dirname(fixture.controlDir)), after);
    assert.deepEqual(reopened.controlStore.readEvidence(), fixture.evidence);
  });
}

test('bounded checkpoint proposal final and activation tail keeps a restartable prefix after the first delete', { concurrency: false }, (t) => {
  const fixture = createCheckpointProposalFixture(t);
  const finalPath = writeCheckpointFinal(
    fixture.controlDir,
    fixture.checkpoint,
    fixture.checkpointFile,
  );
  const tailCandidatePath = writeCheckpointTailCandidate(
    fixture.controlDir,
    fixture.activationTail,
  );
  const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
  const tailBytes = fs.readFileSync(tailPath);
  const eventBytes = new Map(eventFileNames(fixture.controlDir).map((name) => [
    name,
    fs.readFileSync(path.join(fixture.controlDir, name)),
  ]));
  const marker = Object.assign(
    new Error('checkpoint proposal first-delete crash marker'),
    { code: 'CONTROL_STORE_IO' },
  );
  let directoryFsyncs = 0;
  const runtime = loadCheckpointRuntimeWithHooks({
    onFsyncDirectory() { directoryFsyncs += 1; },
  });
  const originalUnlinkSync = fs.unlinkSync;
  const proposalDeletes = [];
  let providerCalls = 0;
  let harness;
  let observed;

  fs.unlinkSync = (target, ...args) => {
    const resolved = path.resolve(String(target));
    const result = originalUnlinkSync.call(fs, target, ...args);
    if (resolved === path.resolve(finalPath) || resolved === path.resolve(tailCandidatePath)) {
      proposalDeletes.push(resolved);
      if (proposalDeletes.length === 1) throw marker;
    }
    return result;
  };
  try {
    assert.throws(
      () => {
        harness = runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('proposal crash recovery must not call provider');
        });
      },
      (error) => {
        observed = error;
        return error?.code === 'RECOVERY_REQUIRED' && error.cause === marker;
      },
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(harness, undefined);
  assert.equal(providerCalls, 0);
  assert.equal(observed.cause, marker);
  assert.deepEqual(proposalDeletes, [path.resolve(tailCandidatePath)]);
  assert.equal(directoryFsyncs, 0);
  assert.equal(fs.existsSync(tailCandidatePath), false);
  assert.equal(fs.existsSync(finalPath), true);
  assert.deepEqual(fs.readFileSync(tailPath), tailBytes);
  for (const [name, bytes] of eventBytes) {
    assert.deepEqual(fs.readFileSync(path.join(fixture.controlDir, name)), bytes);
  }

  const reopened = runtime.createHarnessAt(fixture.controlDir, () => {
    providerCalls += 1;
    throw new Error('proposal crash fresh reopen must not call provider');
  });
  assert.equal(providerCalls, 0);
  assert.equal(directoryFsyncs, 1);
  assert.equal(fs.existsSync(finalPath), false);
  assert.equal(fs.existsSync(tailCandidatePath), false);
  assert.deepEqual(reopened.controlStore.readEvidence(), fixture.evidence);

  const after = snapshotTree(path.dirname(fixture.controlDir));
  const stable = runtime.createHarnessAt(fixture.controlDir, () => {
    providerCalls += 1;
    throw new Error('proposal crash stable reopen must not call provider');
  });
  assert.equal(providerCalls, 0);
  assert.equal(directoryFsyncs, 1);
  assert.deepEqual(snapshotTree(path.dirname(fixture.controlDir)), after);
  assert.deepEqual(stable.controlStore.readEvidence(), fixture.evidence);
});

test('bounded checkpoint proposal cleanup precedes ordinary successor reconciliation', { concurrency: false }, (t) => {
  const fixture = createCheckpointProposalFixture(t);
  const finalPath = writeCheckpointFinal(
    fixture.controlDir,
    fixture.checkpoint,
    fixture.checkpointFile,
  );
  const successor = writeOfficialSuccessorForEvidence(
    fixture.controlDir,
    fixture.evidence.tail,
  );
  const mutationTrace = [];
  let successorReplaceObserved = false;
  const baseHooks = mutationTraceHooks(mutationTrace);
  const runtime = loadCheckpointRuntimeWithHooks({
    ...baseHooks,
    beforeAtomicReplace(sourcePath, targetPath) {
      baseHooks.beforeAtomicReplace(sourcePath, targetPath);
      if (path.basename(targetPath) !== '.controlstore-tail.json') return;
      assert.equal(fs.existsSync(finalPath), false);
      assertExactDeleteThenDirectoryFsync(
        mutationTrace.slice(0, 2),
        [finalPath],
        fixture.controlDir,
      );
      successorReplaceObserved = true;
    },
  });
  let providerCalls = 0;
  const harness = withFsMutationTrace(mutationTrace, () => (
    runtime.createHarnessAt(fixture.controlDir, () => {
      providerCalls += 1;
      throw new Error('startup successor reconcile must not call provider');
    })
  ));

  assert.equal(providerCalls, 0);
  assert.equal(successorReplaceObserved, true);
  assert.equal(mutationTrace.length, 7);
  assertExactDeleteThenDirectoryFsync(
    mutationTrace.slice(0, 2),
    [finalPath],
    fixture.controlDir,
  );
  assert.equal(mutationTrace[2].operation, 'writeFileSync');
  assert.equal(TAIL_CANDIDATE_PATTERN.test(path.basename(mutationTrace[2].target)), true);
  assert.deepEqual(mutationTrace[3], {
    operation: 'fsyncFile',
    target: mutationTrace[2].target,
  });
  assert.deepEqual(mutationTrace[4], {
    operation: 'atomicReplace',
    source: mutationTrace[2].target,
    target: path.resolve(path.join(fixture.controlDir, '.controlstore-tail.json')),
  });
  assert.deepEqual(mutationTrace[5], {
    operation: 'fsyncDirectory',
    target: path.resolve(fixture.controlDir),
  });
  assert.deepEqual(mutationTrace[6], {
    operation: 'rmSync',
    options: { force: true },
    target: mutationTrace[2].target,
  });
  assert.equal(fs.existsSync(finalPath), false);
  const evidence = harness.controlStore.readEvidence();
  assert.deepEqual(evidence.events, [...fixture.evidence.events, successor]);
  assert.equal(evidence.tail.tailSeq, successor.seq);
  assert.equal(evidence.tail.tailDigest, successor.digest);
});

test('bounded checkpoint proposal cleanup precedes matching ordinary tail candidate reconciliation', { concurrency: false }, (t) => {
  const fixture = createCheckpointProposalFixture(t);
  const finalPath = writeCheckpointFinal(
    fixture.controlDir,
    fixture.checkpoint,
    fixture.checkpointFile,
  );
  const successor = writeOfficialSuccessorForEvidence(
    fixture.controlDir,
    fixture.evidence.tail,
  );
  const ordinaryTail = tailAfterOfficialSuccessor(fixture.evidence.tail, successor);
  const ordinaryTailCandidatePath = writeCheckpointTailCandidate(
    fixture.controlDir,
    ordinaryTail,
  );
  const mutationTrace = [];
  let successorReplaceObserved = false;
  const baseHooks = mutationTraceHooks(mutationTrace);
  const runtime = loadCheckpointRuntimeWithHooks({
    ...baseHooks,
    beforeAtomicReplace(sourcePath, targetPath) {
      baseHooks.beforeAtomicReplace(sourcePath, targetPath);
      if (path.basename(targetPath) !== '.controlstore-tail.json') return;
      assert.equal(path.resolve(sourcePath), path.resolve(ordinaryTailCandidatePath));
      assert.equal(fs.existsSync(finalPath), false);
      assertExactDeleteThenDirectoryFsync(
        mutationTrace.slice(0, 2),
        [finalPath],
        fixture.controlDir,
      );
      successorReplaceObserved = true;
    },
  });
  let providerCalls = 0;
  const harness = withFsMutationTrace(mutationTrace, () => (
    runtime.createHarnessAt(fixture.controlDir, () => {
      providerCalls += 1;
      throw new Error('ordinary tail candidate reconcile must not call provider');
    })
  ));

  assert.equal(providerCalls, 0);
  assert.equal(successorReplaceObserved, true);
  assertExactDeleteThenDirectoryFsync(
    mutationTrace.slice(0, 2),
    [finalPath],
    fixture.controlDir,
  );
  assert.deepEqual(mutationTrace.slice(2), [
    {
      operation: 'fsyncFile',
      target: path.resolve(ordinaryTailCandidatePath),
    },
    {
      operation: 'atomicReplace',
      source: path.resolve(ordinaryTailCandidatePath),
      target: path.resolve(path.join(fixture.controlDir, '.controlstore-tail.json')),
    },
    {
      operation: 'fsyncDirectory',
      target: path.resolve(fixture.controlDir),
    },
  ]);
  assert.equal(fs.existsSync(finalPath), false);
  assert.equal(fs.existsSync(ordinaryTailCandidatePath), false);
  const evidence = harness.controlStore.readEvidence();
  assert.deepEqual(evidence.events, [...fixture.evidence.events, successor]);
  assert.deepEqual(evidence.tail, ordinaryTail);

  const traceLength = mutationTrace.length;
  const before = snapshotTree(path.dirname(fixture.controlDir));
  const reopened = withFsMutationTrace(mutationTrace, () => (
    runtime.createHarnessAt(fixture.controlDir, () => {
      providerCalls += 1;
      throw new Error('ordinary tail candidate stable reopen must not call provider');
    })
  ));
  assert.equal(providerCalls, 0);
  assert.equal(mutationTrace.length, traceLength);
  assert.deepEqual(snapshotTree(path.dirname(fixture.controlDir)), before);
  assert.deepEqual(reopened.controlStore.readEvidence(), evidence);
});

const reservedMalformedCheckpointNamespaceCases = [
  {
    name: 'candidate filename',
    fileName(fixture) {
      return `.controlstore-checkpoint-0-${crypto.randomUUID()}.tmp`;
    },
  },
  {
    name: 'final filename',
    fileName() {
      return `.controlstore-checkpoint-0-${'a'.repeat(64)}.json`;
    },
  },
  {
    name: 'case-variant candidate filename',
    fileName() {
      return `.CONTROLSTORE-CHECKPOINT-0-${crypto.randomUUID().toUpperCase()}.TMP`;
    },
  },
];

for (const reservedCase of reservedMalformedCheckpointNamespaceCases) {
  test(`bounded checkpoint proposal rejects reserved malformed ${reservedCase.name} before cleanup or successor reconcile`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    const proposalPath = writeCheckpointCandidate(
      fixture.controlDir,
      fixture.checkpoint,
    );
    const malformedPath = path.join(
      fixture.controlDir,
      reservedCase.fileName(fixture),
    );
    fs.writeFileSync(malformedPath, canonicalJson(fixture.checkpoint));
    const successor = writeOfficialSuccessorForEvidence(
      fixture.controlDir,
      fixture.evidence.tail,
    );
    const successorPath = path.join(
      fixture.controlDir,
      `${successor.seq}-${successor.digest}.json`,
    );
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
    const tailBytes = fs.readFileSync(tailPath);
    const proposalBytes = fs.readFileSync(proposalPath);
    const successorBytes = fs.readFileSync(successorPath);
    const malformedBytes = fs.readFileSync(malformedPath);
    const mutationTrace = [];
    const runtime = loadCheckpointRuntimeWithHooks(
      mutationTraceHooks(mutationTrace),
    );
    let providerCalls = 0;
    let harness;

    assert.throws(
      () => {
        harness = withFsMutationTrace(mutationTrace, () => (
          runtime.createHarnessAt(fixture.controlDir, () => {
            providerCalls += 1;
            throw new Error('reserved malformed checkpoint must not call provider');
          })
        ));
      },
      { code: 'CONTROL_STORE_CORRUPT' },
    );

    assert.equal(harness, undefined);
    assert.equal(providerCalls, 0);
    assert.deepEqual(mutationTrace, []);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fs.readFileSync(tailPath), tailBytes);
    assert.deepEqual(fs.readFileSync(proposalPath), proposalBytes);
    assert.deepEqual(fs.readFileSync(successorPath), successorBytes);
    assert.deepEqual(fs.readFileSync(malformedPath), malformedBytes);
  });
}

test('bounded checkpoint no-tail store rejects a reserved malformed final without activation writes', { concurrency: false }, (t) => {
  const fixture = createFixtureGenesisStore(t);
  const malformedPath = path.join(
    fixture.controlDir,
    `.controlstore-checkpoint-0-${'b'.repeat(64)}.json`,
  );
  fs.writeFileSync(malformedPath, canonicalJson({ reserved: 'checkpoint-final' }));
  const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
  assert.equal(fs.existsSync(tailPath), false);
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const malformedBytes = fs.readFileSync(malformedPath);
  const mutationTrace = [];
  const runtime = loadCheckpointRuntimeWithHooks(
    mutationTraceHooks(mutationTrace),
  );
  let providerCalls = 0;
  let harness;

  assert.throws(
    () => {
      harness = withFsMutationTrace(mutationTrace, () => (
        runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('no-tail reserved checkpoint must not call provider');
        })
      ));
    },
    { code: 'CONTROL_STORE_CORRUPT' },
  );

  assert.equal(harness, undefined);
  assert.equal(providerCalls, 0);
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.existsSync(tailPath), false);
  assert.deepEqual(fs.readFileSync(malformedPath), malformedBytes);
});

test('bounded checkpoint no-tail store treats a case-variant reserved final as unsupported by default and corrupt when bounded', { concurrency: false }, (t) => {
  const fixture = createFixtureGenesisStore(t);
  const malformedPath = path.join(
    fixture.controlDir,
    `.CONTROLSTORE-CHECKPOINT-0-${'B'.repeat(64)}.JSON`,
  );
  fs.writeFileSync(malformedPath, canonicalJson({ reserved: 'case-variant-checkpoint-final' }));
  const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
  assert.equal(fs.existsSync(tailPath), false);
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const malformedBytes = fs.readFileSync(malformedPath);
  const mutationTrace = [];
  const runtime = loadCheckpointRuntimeWithHooks(
    mutationTraceHooks(mutationTrace),
  );

  assert.throws(
    () => withFsMutationTrace(mutationTrace, () => (
      runtime.controlStoreModule.openControlStore(fixture.controlDir)
    )),
    { code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED' },
  );
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);

  let providerCalls = 0;
  let harness;
  assert.throws(
    () => {
      harness = withFsMutationTrace(mutationTrace, () => (
        runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('case-variant reserved checkpoint must not call provider');
        })
      ));
    },
    { code: 'CONTROL_STORE_CORRUPT' },
  );

  assert.equal(harness, undefined);
  assert.equal(providerCalls, 0);
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.existsSync(tailPath), false);
  assert.deepEqual(fs.readFileSync(malformedPath), malformedBytes);
});

test('bounded checkpoint no-tail store rejects a malformed exact final before orphan recovery', { concurrency: false }, (t) => {
  const fixture = createFixtureGenesisStore(t);
  const malformedPath = path.join(
    fixture.controlDir,
    `.controlstore-checkpoint-1-${'c'.repeat(64)}.json`,
  );
  fs.writeFileSync(malformedPath, '{');
  const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
  assert.equal(fs.existsSync(tailPath), false);
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const malformedBytes = fs.readFileSync(malformedPath);
  const mutationTrace = [];
  const runtime = loadCheckpointRuntimeWithHooks(
    mutationTraceHooks(mutationTrace),
  );

  assert.throws(
    () => runtime.controlStoreModule.openControlStore(fixture.controlDir),
    { code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED' },
  );
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);

  let providerCalls = 0;
  let harness;
  assert.throws(
    () => {
      harness = withFsMutationTrace(mutationTrace, () => (
        runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('no-tail malformed exact final must not call provider');
        })
      ));
    },
    { code: 'CONTROL_STORE_CORRUPT' },
  );

  assert.equal(harness, undefined);
  assert.equal(providerCalls, 0);
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.existsSync(tailPath), false);
  assert.deepEqual(fs.readFileSync(malformedPath), malformedBytes);
});

test('bounded checkpoint inspector authenticates a no-tail exact final without mutation or projection', { concurrency: false }, (t) => {
  const fixture = createFixtureGenesisStore(t);
  const malformedPath = path.join(
    fixture.controlDir,
    `.controlstore-checkpoint-1-${'d'.repeat(64)}.json`,
  );
  fs.writeFileSync(malformedPath, '{');
  const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
  assert.equal(fs.existsSync(tailPath), false);
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const malformedBytes = fs.readFileSync(malformedPath);
  const mutationTrace = [];
  const runtime = loadCheckpointRuntimeWithHooks(
    mutationTraceHooks(mutationTrace),
  );
  let projection;

  assert.throws(
    () => withFsMutationTrace(mutationTrace, () => {
      projection = runtime.controlStoreModule.inspectControlStoreEvidence(
        fixture.controlDir,
      );
    }),
    { code: 'CONTROL_STORE_CORRUPT' },
  );

  assert.equal(projection, undefined);
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.existsSync(tailPath), false);
  assert.deepEqual(fs.readFileSync(malformedPath), malformedBytes);
});

test('bounded checkpoint no-tail valid orphan final returns recovery without mutation or facade', { concurrency: false }, (t) => {
  const fixture = createNoTailValidCheckpointFinalFixture(t);
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const finalBytes = fs.readFileSync(fixture.checkpointPath);
  const mutationTrace = [];
  const runtime = loadCheckpointRuntimeWithHooks(
    mutationTraceHooks(mutationTrace),
  );
  let providerCalls = 0;
  let harness;

  assert.throws(
    () => {
      harness = withFsMutationTrace(mutationTrace, () => (
        runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('valid no-tail orphan must not call provider');
        })
      ));
    },
    { code: 'RECOVERY_REQUIRED' },
  );

  assert.equal(harness, undefined);
  assert.equal(providerCalls, 0);
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.existsSync(fixture.tailPath), false);
  assert.deepEqual(fs.readFileSync(fixture.checkpointPath), finalBytes);
});

test('bounded checkpoint inspector reports a no-tail valid orphan without mutation or projection', { concurrency: false }, (t) => {
  const fixture = createNoTailValidCheckpointFinalFixture(t);
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  const finalBytes = fs.readFileSync(fixture.checkpointPath);
  const mutationTrace = [];
  const runtime = loadCheckpointRuntimeWithHooks(
    mutationTraceHooks(mutationTrace),
  );
  let projection;

  assert.throws(
    () => withFsMutationTrace(mutationTrace, () => {
      projection = runtime.controlStoreModule.inspectControlStoreEvidence(
        fixture.controlDir,
      );
    }),
    { code: 'RECOVERY_REQUIRED' },
  );

  assert.equal(projection, undefined);
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.existsSync(fixture.tailPath), false);
  assert.deepEqual(fs.readFileSync(fixture.checkpointPath), finalBytes);
});

const invalidOldTailProposalCases = [
  {
    name: 'tail candidate alone',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeCheckpointTailCandidate(fixture.controlDir, fixture.activationTail);
    },
  },
  {
    name: 'candidate and separately-created byte-identical final',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      const candidatePath = writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint);
      const finalPath = writeCheckpointFinal(
        fixture.controlDir,
        fixture.checkpoint,
        fixture.checkpointFile,
      );
      const candidateStats = fs.statSync(candidatePath, { bigint: true });
      const finalStats = fs.statSync(finalPath, { bigint: true });
      assert.notEqual(candidateStats.ino, finalStats.ino);
    },
  },
  {
    name: 'candidate and final bytes mismatch',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeCheckpointCandidate(fixture.controlDir, fixture.alternateCheckpoint);
      writeCheckpointFinal(
        fixture.controlDir,
        fixture.checkpoint,
        fixture.checkpointFile,
      );
    },
  },
  {
    name: 'final and tail-candidate linkage mismatch',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeCheckpointFinal(
        fixture.controlDir,
        fixture.checkpoint,
        fixture.checkpointFile,
      );
      writeCheckpointTailCandidate(
        fixture.controlDir,
        fixture.alternateActivationTail,
      );
    },
  },
  {
    name: 'two checkpoint candidates',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint);
      writeCheckpointCandidate(fixture.controlDir, fixture.alternateCheckpoint);
    },
  },
  {
    name: 'same-covered sequence different final digests',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeCheckpointFinal(
        fixture.controlDir,
        fixture.checkpoint,
        fixture.checkpointFile,
      );
      writeCheckpointFinal(
        fixture.controlDir,
        fixture.alternateCheckpoint,
        fixture.alternateCheckpointFile,
      );
    },
  },
  {
    name: 'malformed checkpoint candidate',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(fixture) {
      writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint, '{');
    },
  },
  {
    name: 'malformed orphan final',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(fixture) {
      const malformedFile = `.controlstore-checkpoint-${fixture.checkpoint.coveredSeq}-${'a'.repeat(64)}.json`;
      fs.writeFileSync(path.join(fixture.controlDir, malformedFile), '{');
    },
  },
];

for (const proposalCase of invalidOldTailProposalCases) {
  test(`bounded checkpoint proposal old-tail invalid ${proposalCase.name} wins before successor reconcile`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    proposalCase.setup(fixture);
    const successor = writeOfficialSuccessorForEvidence(
      fixture.controlDir,
      fixture.evidence.tail,
    );
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
    const tailBytes = fs.readFileSync(tailPath);
    const mutationTrace = [];
    const runtime = loadCheckpointRuntimeWithHooks(
      mutationTraceHooks(mutationTrace),
    );
    let providerCalls = 0;
    let harness;

    assert.throws(
      () => {
        harness = withFsMutationTrace(mutationTrace, () => (
          runtime.createHarnessAt(fixture.controlDir, () => {
            providerCalls += 1;
            throw new Error('invalid startup proposal must not call provider');
          })
        ));
      },
      { code: proposalCase.expectedCode },
    );

    assert.equal(harness, undefined);
    assert.equal(providerCalls, 0);
    assert.deepEqual(mutationTrace, []);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(fs.readFileSync(tailPath), tailBytes);
    assert.equal(JSON.parse(tailBytes).tailSeq, successor.seq - 1);
  });
}

const newTailPartialGcCases = [
  { name: 'covered event and exact predecessor', keepCoveredEvent: true, keepPredecessor: true },
  { name: 'covered event with descriptor target already absent', keepCoveredEvent: true, keepPredecessor: false },
  { name: 'exact predecessor with covered event already absent', keepCoveredEvent: false, keepPredecessor: true },
  { name: 'already-complete residue', keepCoveredEvent: false, keepPredecessor: false },
];

for (const partialCase of newTailPartialGcCases) {
  test(`bounded checkpoint partial GC new-tail ${partialCase.name} converges idempotently`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    activateCheckpointProposal(fixture, partialCase);
    const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
    const currentFinalPath = path.join(fixture.controlDir, fixture.checkpointFile);
    const predecessorPath = path.join(fixture.controlDir, fixture.previousCheckpointFile);
    const tailBytes = fs.readFileSync(tailPath);
    const currentFinalBytes = fs.readFileSync(currentFinalPath);
    const residuePaths = [
      ...(partialCase.keepCoveredEvent
        ? eventFileNames(fixture.controlDir).map((name) => (
          path.join(fixture.controlDir, name)
        ))
        : []),
      ...(partialCase.keepPredecessor ? [predecessorPath] : []),
    ];
    const mutationTrace = [];
    const runtime = loadCheckpointRuntimeWithHooks(
      mutationTraceHooks(mutationTrace),
    );
    let providerCalls = 0;
    const harness = withFsMutationTrace(mutationTrace, () => (
      runtime.createHarnessAt(fixture.controlDir, () => {
        providerCalls += 1;
        throw new Error('partial GC startup must not call provider');
      })
    ));

    assert.equal(providerCalls, 0);
    if (residuePaths.length === 0) {
      assert.deepEqual(mutationTrace, []);
    } else {
      assertExactDeleteThenDirectoryFsync(
        mutationTrace,
        residuePaths,
        fixture.controlDir,
      );
    }
    assert.deepEqual(fs.readFileSync(tailPath), tailBytes);
    assert.deepEqual(fs.readFileSync(currentFinalPath), currentFinalBytes);
    assert.deepEqual(eventFileNames(fixture.controlDir), []);
    assert.equal(fs.existsSync(predecessorPath), false);
    const evidence = harness.controlStore.readEvidence();
    assert.deepEqual(evidence.checkpoint, fixture.checkpoint);
    assert.deepEqual(evidence.tail, fixture.activationTail);
    assert.deepEqual(evidence.events, []);
    const after = snapshotTree(path.dirname(fixture.controlDir));

    const traceLength = mutationTrace.length;
    const reopened = withFsMutationTrace(mutationTrace, () => (
      runtime.createHarnessAt(fixture.controlDir, () => {
        providerCalls += 1;
        throw new Error('idempotent partial GC reopen must not call provider');
      })
    ));
    assert.equal(providerCalls, 0);
    assert.equal(mutationTrace.length, traceLength);
    assert.deepEqual(snapshotTree(path.dirname(fixture.controlDir)), after);
    assert.deepEqual(reopened.controlStore.readEvidence(), evidence);
  });
}

const invalidNewTailGcCases = [
  {
    name: 'null descriptor with an extra valid final',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      const current = rematerializeCheckpoint(
        fixture.checkpoint,
        (record) => { record.previousCheckpoint = null; },
      );
      writeActivatedCheckpointAuthority(
        fixture,
        current.checkpoint,
        current.checkpointFile,
      );
      return { current };
    },
  },
  {
    name: 'non-null descriptor with an extra valid final',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeActivatedCheckpointAuthority(fixture);
      const extraPath = writeCheckpointFinal(
        fixture.controlDir,
        fixture.alternateCheckpoint,
        fixture.alternateCheckpointFile,
      );
      return { extraPath };
    },
  },
  {
    name: 'descriptor target absent with an unrelated valid final',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeActivatedCheckpointAuthority(fixture);
      fs.unlinkSync(path.join(fixture.controlDir, fixture.previousCheckpointFile));
      const extraPath = writeCheckpointFinal(
        fixture.controlDir,
        fixture.alternateCheckpoint,
        fixture.alternateCheckpointFile,
      );
      assert.equal(
        fs.existsSync(path.join(fixture.controlDir, fixture.previousCheckpointFile)),
        false,
      );
      return { extraPath };
    },
  },
  {
    name: 'descriptor checkpoint file linkage differs while target is present',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(fixture) {
      const current = rematerializeCheckpoint(fixture.checkpoint, (record) => {
        record.previousCheckpoint.checkpointFile = `.controlstore-checkpoint-${record.previousCheckpoint.coveredSeq}-${'f'.repeat(64)}.json`;
        assert.notEqual(
          record.previousCheckpoint.checkpointFile,
          fixture.previousCheckpointFile,
        );
      });
      writeActivatedCheckpointAuthority(
        fixture,
        current.checkpoint,
        current.checkpointFile,
      );
      assert.equal(
        fs.existsSync(path.join(fixture.controlDir, fixture.previousCheckpointFile)),
        true,
      );
      return { current };
    },
  },
  {
    name: 'descriptor checkpoint digest linkage differs while target is present',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(fixture) {
      const current = rematerializeCheckpoint(fixture.checkpoint, (record) => {
        record.previousCheckpoint.checkpointDigest = 'f'.repeat(64);
        if (
          record.previousCheckpoint.checkpointDigest
            === fixture.previousCheckpoint.checkpointDigest
        ) {
          record.previousCheckpoint.checkpointDigest = 'e'.repeat(64);
        }
      });
      writeActivatedCheckpointAuthority(
        fixture,
        current.checkpoint,
        current.checkpointFile,
      );
      assert.equal(
        fs.existsSync(path.join(fixture.controlDir, fixture.previousCheckpointFile)),
        true,
      );
      return { current };
    },
  },
  {
    name: 'descriptor covered sequence linkage differs while target is present',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(fixture) {
      const current = rematerializeCheckpoint(fixture.checkpoint, (record) => {
        record.previousCheckpoint.coveredSeq += 1;
      });
      writeActivatedCheckpointAuthority(
        fixture,
        current.checkpoint,
        current.checkpointFile,
      );
      assert.equal(
        fs.existsSync(path.join(fixture.controlDir, fixture.previousCheckpointFile)),
        true,
      );
      return { current };
    },
  },
  {
    name: 'descriptor covered digest differs from its target',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      const current = rematerializeCheckpoint(fixture.checkpoint, (record) => {
        record.previousCheckpoint.coveredDigest = 'f'.repeat(64);
        if (record.previousCheckpoint.coveredDigest === fixture.previousCheckpoint.coveredDigest) {
          record.previousCheckpoint.coveredDigest = 'e'.repeat(64);
        }
      });
      writeActivatedCheckpointAuthority(
        fixture,
        current.checkpoint,
        current.checkpointFile,
      );
      return { current };
    },
  },
  {
    name: 'malformed descriptor target',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(fixture) {
      writeActivatedCheckpointAuthority(fixture);
      fs.writeFileSync(
        path.join(fixture.controlDir, fixture.previousCheckpointFile),
        '{',
      );
      return {};
    },
  },
  {
    name: 'malformed extra final',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(fixture) {
      writeActivatedCheckpointAuthority(fixture);
      const extraPath = path.join(
        fixture.controlDir,
        `.controlstore-checkpoint-${fixture.checkpoint.coveredSeq + 1}-${'a'.repeat(64)}.json`,
      );
      fs.writeFileSync(extraPath, '{');
      return { extraPath };
    },
  },
  {
    name: 'byte-identical checkpoint candidate',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(fixture) {
      writeActivatedCheckpointAuthority(fixture);
      const candidatePath = writeCheckpointCandidate(
        fixture.controlDir,
        fixture.checkpoint,
      );
      return { candidatePath };
    },
  },
];

for (const gcCase of invalidNewTailGcCases) {
  test(`bounded checkpoint partial GC new-tail rejects ${gcCase.name} without cleanup`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    gcCase.setup(fixture);
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    const tailBytes = fs.readFileSync(
      path.join(fixture.controlDir, '.controlstore-tail.json'),
    );
    const mutationTrace = [];
    const runtime = loadCheckpointRuntimeWithHooks(
      mutationTraceHooks(mutationTrace),
    );
    let providerCalls = 0;
    let harness;

    assert.throws(
      () => {
        harness = withFsMutationTrace(mutationTrace, () => (
          runtime.createHarnessAt(fixture.controlDir, () => {
            providerCalls += 1;
            throw new Error('invalid partial GC startup must not call provider');
          })
        ));
      },
      { code: gcCase.expectedCode },
    );

    assert.equal(harness, undefined);
    assert.equal(providerCalls, 0);
    assert.deepEqual(mutationTrace, []);
    assert.deepEqual(snapshotTree(root), before);
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.controlDir, '.controlstore-tail.json')),
      tailBytes,
    );
  });
}

const checkpointInspectorFailureCases = [
  {
    name: 'exact old-tail checkpoint candidate',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint);
      return fixture.controlDir;
    },
  },
  {
    name: 'exact old-tail orphan final',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      writeCheckpointFinal(
        fixture.controlDir,
        fixture.checkpoint,
        fixture.checkpointFile,
      );
      return fixture.controlDir;
    },
  },
  {
    name: 'exact old-tail orphan final and tail candidate',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      writeCheckpointFinal(
        fixture.controlDir,
        fixture.checkpoint,
        fixture.checkpointFile,
      );
      writeCheckpointTailCandidate(fixture.controlDir, fixture.activationTail);
      return fixture.controlDir;
    },
  },
  {
    name: 'new-tail predecessor and covered-event partial GC',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      activateCheckpointProposal(fixture);
      return fixture.controlDir;
    },
  },
  {
    name: 'new-tail byte-identical checkpoint candidate',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      activateCheckpointProposal(fixture);
      writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint);
      return fixture.controlDir;
    },
  },
  {
    name: 'ordinary exact event successor',
    expectedCode: 'RECOVERY_REQUIRED',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      writeOfficialSuccessorForEvidence(fixture.controlDir, fixture.evidence.tail);
      return fixture.controlDir;
    },
  },
  {
    name: 'malformed checkpoint candidate',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint, '{');
      return fixture.controlDir;
    },
  },
  {
    name: 'malformed unreferenced final',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      fs.writeFileSync(
        path.join(
          fixture.controlDir,
          `.controlstore-checkpoint-${fixture.checkpoint.coveredSeq}-${'a'.repeat(64)}.json`,
        ),
        '{',
      );
      return fixture.controlDir;
    },
  },
  {
    name: 'malformed referenced current final',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      activateCheckpointProposal(fixture, {
        keepCoveredEvent: false,
        keepPredecessor: false,
      });
      fs.writeFileSync(
        path.join(fixture.controlDir, fixture.checkpointFile),
        '{',
      );
      return fixture.controlDir;
    },
  },
  {
    name: 'malformed tail candidate',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    setup(t) {
      const fixture = createCheckpointProposalFixture(t);
      writeCheckpointTailCandidate(fixture.controlDir, fixture.activationTail, '{');
      return fixture.controlDir;
    },
  },
];

for (const inspectorCase of checkpointInspectorFailureCases) {
  test(`bounded checkpoint inspector rejects ${inspectorCase.name} without projection or mutation`, { concurrency: false }, (t) => {
    const controlDir = inspectorCase.setup(t);
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);
    let projection;
    let observed;
    const mutationTrace = [];
    const runtime = loadCheckpointRuntimeWithHooks({
      beforeAtomicReplace() {
        assert.fail('checkpoint inspector must not call atomicReplace');
      },
      onFsyncDirectory() {
        assert.fail('checkpoint inspector must not fsync a directory');
      },
      onFsyncFile() {
        assert.fail('checkpoint inspector must not fsync a file');
      },
    });

    withFsMutationTrace(mutationTrace, () => {
      assert.throws(
        () => {
          projection = runtime.controlStoreModule.inspectControlStoreEvidence(controlDir);
        },
        (error) => {
          observed = error;
          return error?.code === inspectorCase.expectedCode;
        },
      );
    });

    assert.equal(projection, undefined);
    assert.equal(observed.code, inspectorCase.expectedCode);
    assert.deepEqual(mutationTrace, []);
    assert.deepEqual(snapshotTree(root), before);
  });
}

const staleControllerStateCases = [
  {
    name: 'ordinary successor',
    inject(fixture) {
      const successor = writeOfficialSuccessorForEvidence(
        fixture.controlDir,
        fixture.evidence.tail,
      );
      return {
        assertConverged(evidence) {
          assert.deepEqual(evidence.events, [...fixture.evidence.events, successor]);
          assert.equal(evidence.tail.tailSeq, successor.seq);
          assert.equal(evidence.tail.tailDigest, successor.digest);
        },
      };
    },
  },
  {
    name: 'old-tail checkpoint proposal',
    inject(fixture) {
      const candidatePath = writeCheckpointCandidate(
        fixture.controlDir,
        fixture.checkpoint,
      );
      return {
        assertConverged(evidence) {
          assert.equal(fs.existsSync(candidatePath), false);
          assert.deepEqual(evidence, fixture.evidence);
        },
      };
    },
  },
  {
    name: 'new-tail predecessor and covered-event partial GC',
    inject(fixture) {
      activateCheckpointProposal(fixture);
      return {
        assertConverged(evidence) {
          assert.deepEqual(evidence.checkpoint, fixture.checkpoint);
          assert.deepEqual(evidence.tail, fixture.activationTail);
          assert.deepEqual(evidence.events, []);
          assert.deepEqual(eventFileNames(fixture.controlDir), []);
          assert.equal(
            fs.existsSync(path.join(
              fixture.controlDir,
              fixture.previousCheckpointFile,
            )),
            false,
          );
        },
      };
    },
  },
];

for (const stateCase of staleControllerStateCases) {
  test(`bounded checkpoint fenced stale controller observes ${stateCase.name} before provider`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    const mutationTrace = [];
    const leaseTrace = [];
    const runtime = loadCheckpointRuntimeWithHooks({
      ...mutationTraceHooks(mutationTrace),
      onAcquire(kind) { leaseTrace.push(`acquire:${kind}`); },
      onRelease(kind) { leaseTrace.push(`release:${kind}`); },
    });
    let providerCalls = 0;
    let authority;
    const harness = runtime.createHarnessAt(fixture.controlDir, () => {
      providerCalls += 1;
      return authority;
    });
    authority = createCheckpointProjectionAuthority(
      harness.controlStore,
      fixture.previousCheckpoint,
      [crypto.randomUUID()],
    );
    const controller = runtime.controlStoreModule.getBoundedControlStoreCheckpointController(
      harness.controlStore,
    );
    const injected = stateCase.inject(fixture);
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    mutationTrace.length = 0;
    leaseTrace.length = 0;

    assert.throws(
      () => withFsMutationTrace(
        mutationTrace,
        () => controller.maintenanceStatus(),
      ),
      { code: 'RECOVERY_REQUIRED' },
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual(mutationTrace, []);
    assert.deepEqual(leaseTrace, [
      'acquire:lifecycle',
      'release:lifecycle',
    ]);
    assert.deepEqual(snapshotTree(root), before);
    assert.equal(harness.controlStore.assertCurrent(), true);

    let receipt;
    leaseTrace.length = 0;
    assert.throws(
      () => withFsMutationTrace(mutationTrace, () => {
        receipt = harness.checkpoint();
      }),
      { code: 'RECOVERY_REQUIRED' },
    );
    assert.equal(receipt, undefined);
    assert.equal(providerCalls, 0);
    assert.deepEqual(mutationTrace, []);
    assert.deepEqual(leaseTrace, [
      'acquire:lifecycle',
      'acquire:writer',
      'release:writer',
      'release:lifecycle',
    ]);
    assert.deepEqual(snapshotTree(root), before);
    assert.throws(
      () => controller.installCheckpoint(() => {
        providerCalls += 1;
        return authority;
      }),
      { code: 'CONTROL_STORE_FENCED' },
    );
    assert.throws(
      () => controller.maintenanceStatus(),
      { code: 'CONTROL_STORE_FENCED' },
    );
    assert.equal(providerCalls, 0);
    assertBoundedFacadeFenced(harness.controlStore);

    let replacementProviderCalls = 0;
    const replacement = runtime.createHarnessAt(
      fixture.controlDir,
      () => {
        replacementProviderCalls += 1;
        throw new Error('replacement startup/status must not call provider');
      },
    );
    const replacementController = runtime.controlStoreModule
      .getBoundedControlStoreCheckpointController(replacement.controlStore);
    assert.notEqual(replacementController, controller);
    assert.equal(replacementProviderCalls, 0);
    injected.assertConverged(replacement.controlStore.readEvidence());
    assertExactFrozenStatus(
      replacement.maintenanceStatus(),
      {
        activeEventBytes: replacement.controlStore.readEvidence().tail.activeEventBytes,
        activeEventCount: replacement.controlStore.readEvidence().tail.activeEventCount,
        level: 'none',
      },
    );
    assert.equal(replacementProviderCalls, 0);
    assert.throws(
      () => controller.maintenanceStatus(),
      { code: 'CONTROL_STORE_FENCED' },
    );
    const converged = snapshotTree(root);

    const secondReplacement = runtime.createHarnessAt(
      fixture.controlDir,
      () => {
        replacementProviderCalls += 1;
        throw new Error('idempotent replacement reopen must not call provider');
      },
    );
    assert.deepEqual(snapshotTree(root), converged);
    assert.deepEqual(
      secondReplacement.controlStore.readEvidence(),
      replacement.controlStore.readEvidence(),
    );
    assert.equal(replacementProviderCalls, 0);
  });
}

test('bounded checkpoint maintenance status reports external corruption read-only without becoming fenced', { concurrency: false }, (t) => {
  const fixture = createCheckpointProposalFixture(t);
  const mutationTrace = [];
  const leaseTrace = [];
  const runtime = loadCheckpointRuntimeWithHooks({
    ...mutationTraceHooks(mutationTrace),
    onAcquire(kind) { leaseTrace.push(`acquire:${kind}`); },
    onRelease(kind) { leaseTrace.push(`release:${kind}`); },
  });
  let providerCalls = 0;
  const harness = runtime.createHarnessAt(fixture.controlDir, () => {
    providerCalls += 1;
    throw new Error('maintenance status corruption must not call provider');
  });
  writeCheckpointCandidate(fixture.controlDir, fixture.checkpoint, '{');
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);
  mutationTrace.length = 0;
  leaseTrace.length = 0;

  assert.throws(
    () => withFsMutationTrace(
      mutationTrace,
      () => harness.maintenanceStatus(),
    ),
    { code: 'CONTROL_STORE_CORRUPT' },
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(mutationTrace, []);
  assert.deepEqual(leaseTrace, [
    'acquire:lifecycle',
    'release:lifecycle',
  ]);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(harness.controlStore.assertCurrent(), true);
});

let accessorSelectorReads = 0;
const accessorSelector = {};
Object.defineProperty(accessorSelector, 'entryKind', {
  enumerable: true,
  get() {
    accessorSelectorReads += 1;
    return 'event';
  },
});
const symbolSelector = { entryKind: 'event' };
symbolSelector[Symbol('selector')] = 'invalid';
const nonEnumerableSelector = {};
Object.defineProperty(nonEnumerableSelector, 'entryKind', {
  enumerable: false,
  value: 'event',
});

const invalidFaultSelectors = [
  { name: 'null', selector: null },
  { name: 'array', selector: [] },
  { name: 'null prototype', selector: Object.assign(Object.create(null), { entryKind: 'event' }) },
  { name: 'custom prototype', selector: Object.assign(Object.create({ inherited: true }), { entryKind: 'event' }) },
  { name: 'accessor', selector: accessorSelector },
  { name: 'symbol key', selector: symbolSelector },
  { name: 'non-enumerable key', selector: nonEnumerableSelector },
  { name: 'positive infinity', selector: { count: Number.POSITIVE_INFINITY } },
  { name: 'negative infinity', selector: { count: Number.NEGATIVE_INFINITY } },
  { name: 'NaN', selector: { count: Number.NaN } },
  { name: 'object value', selector: { entryKind: { nested: true } } },
  { name: 'array value', selector: { entryKind: ['event'] } },
  { name: 'undefined value', selector: { entryKind: undefined } },
  { name: 'bigint value', selector: { entryKind: 1n } },
  { name: 'symbol value', selector: { entryKind: Symbol('event') } },
  { name: 'function value', selector: { entryKind() {} } },
];

for (const selectorCase of invalidFaultSelectors) {
  test(`bounded checkpoint fault selector rejects ${selectorCase.name} without callback or activation`, { concurrency: false }, async () => {
    const faultName = `batch4.selector.invalid.${selectorCase.name}`;
    let callbackCalls = 0;
    let result;
    if (selectorCase.selector === accessorSelector) accessorSelectorReads = 0;

    await withFaults({
      [faultName]: {
        active: true,
        callback() { callbackCalls += 1; },
        whenContextEquals: selectorCase.selector,
      },
    }, async () => {
      result = faultPoint(faultName, { entryKind: 'event', count: 1 });
    });

    assert.equal(result, false);
    assert.equal(callbackCalls, 0);
    if (selectorCase.selector === accessorSelector) {
      assert.equal(accessorSelectorReads, 0);
    }
  });
}

for (const contextCase of [
  { name: 'missing own key', context: {} },
  { name: 'inherited key', context: Object.create({ entryKind: 'event' }) },
  { name: 'mismatched scalar', context: { entryKind: 'old-checkpoint' } },
  { name: 'null context', context: null },
  { name: 'primitive context', context: 'event' },
]) {
  test(`bounded checkpoint fault selector rejects ${contextCase.name} before callback throw or activation`, { concurrency: false }, async () => {
    const faultName = `batch4.selector.context.${contextCase.name}`;
    let callbackCalls = 0;
    let result;

    await withFaults({
      [faultName]: {
        active: true,
        callback() { callbackCalls += 1; },
        throw: 'EIO',
        whenContextEquals: { entryKind: 'event' },
      },
    }, async () => {
      result = faultPoint(faultName, contextCase.context);
    });

    assert.equal(result, false);
    assert.equal(callbackCalls, 0);
  });
}

test('bounded checkpoint fault selector exact scalar match triggers and mismatched selector stays inactive', { concurrency: false }, async () => {
  const faultName = 'batch4.selector.exact-scalars';
  let callbackCalls = 0;
  const action = {
    active: true,
    callback() { callbackCalls += 1; },
    whenContextEquals: {
      booleanValue: true,
      nullValue: null,
      numberValue: 42.5,
      stringValue: 'event',
    },
  };

  await withFaults({ [faultName]: action }, async () => {
    assert.equal(faultPoint(faultName, {
      booleanValue: true,
      extra: 'allowed',
      nullValue: null,
      numberValue: 42.5,
      stringValue: 'event',
    }), true);
    assert.equal(faultPoint(faultName, {
      booleanValue: true,
      nullValue: null,
      numberValue: 42.5,
      stringValue: 'old-checkpoint',
    }), false);
  });

  assert.equal(callbackCalls, 1);
});

test('bounded checkpoint fault selector invalid crash action never reaches the kill path', { concurrency: false }, () => {
  const faultName = 'batch4.selector.invalid-crash';
  const loaded = loadFaultInjectionWithKillSpy({
    [faultName]: {
      crash: true,
      whenContextEquals: { entryKind: { nested: true } },
    },
  });

  assert.equal(
    loaded.faultInjection.crashOnlyFaultPoint(faultName, { entryKind: 'event' }),
    false,
  );
  assert.equal(
    loaded.faultInjection.faultPoint(faultName, { entryKind: 'event' }),
    false,
  );
  assert.deepEqual(loaded.killCalls, []);
});

test('bounded checkpoint fault selector crash-only exact match kills once and mismatch or missing stays inactive', { concurrency: false }, () => {
  const matchingName = 'batch4.selector.crash-only.match';
  const mismatchedName = 'batch4.selector.crash-only.mismatch';
  const missingName = 'batch4.selector.crash-only.missing';
  const loaded = loadFaultInjectionWithKillSpy({
    [matchingName]: {
      crash: true,
      whenContextEquals: { entryKind: 'old-checkpoint' },
    },
    [mismatchedName]: {
      crash: true,
      whenContextEquals: { entryKind: 'old-checkpoint' },
    },
    [missingName]: {
      crash: true,
      whenContextEquals: { entryKind: 'old-checkpoint' },
    },
  });

  assert.equal(
    loaded.faultInjection.crashOnlyFaultPoint(matchingName, {
      entryKind: 'old-checkpoint',
      entryName: 'covered.json',
    }),
    false,
  );
  assert.deepEqual(loaded.killCalls, [{ pid: process.pid, signal: 'SIGKILL' }]);

  assert.equal(
    loaded.faultInjection.crashOnlyFaultPoint(mismatchedName, {
      entryKind: 'event',
    }),
    false,
  );
  assert.equal(
    loaded.faultInjection.crashOnlyFaultPoint(missingName, {
      entryName: 'covered.json',
    }),
    false,
  );
  assert.deepEqual(loaded.killCalls, [{ pid: process.pid, signal: 'SIGKILL' }]);
});

test('bounded checkpoint crash marker is file-and-directory durable before SIGKILL', { concurrency: false }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-checkpoint-marker-'));
  const markerPath = path.join(root, 'crash-marker.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const faultName = 'batch5.checkpoint.marker-durability';
  const token = crypto.randomUUID();
  const modulePath = require.resolve('../testing/fault-injection');
  const cached = require.cache[modulePath];
  const durability = require('../platform/durability');
  const originalFsyncFile = durability.fsyncFile;
  const originalFsyncDirectory = durability.fsyncDirectory;
  const previousFaultMap = process.env[FAULT_MAP_ENV];
  const previousMarkerPath = process.env[CRASH_MARKER_PATH_ENV];
  const previousToken = process.env[CRASH_MARKER_TOKEN_ENV];
  const previousKill = process.kill;
  const trace = [];

  process.env[FAULT_MAP_ENV] = JSON.stringify({ [faultName]: { crash: true } });
  process.env[CRASH_MARKER_PATH_ENV] = markerPath;
  process.env[CRASH_MARKER_TOKEN_ENV] = token;
  durability.fsyncFile = (target) => {
    const result = originalFsyncFile(target);
    trace.push({ operation: 'fsyncFile', target: path.resolve(String(target)) });
    return result;
  };
  durability.fsyncDirectory = (target) => {
    const result = originalFsyncDirectory(target);
    trace.push({ operation: 'fsyncDirectory', target: path.resolve(String(target)) });
    return result;
  };
  process.kill = (pid, signal) => {
    trace.push({ operation: 'kill', pid, signal });
    return true;
  };

  delete require.cache[modulePath];
  try {
    const fresh = require(modulePath);
    assert.equal(fresh.crashOnlyFaultPoint(faultName, { entryKind: 'event' }), false);
  } finally {
    process.kill = previousKill;
    durability.fsyncFile = originalFsyncFile;
    durability.fsyncDirectory = originalFsyncDirectory;
    if (previousFaultMap === undefined) delete process.env[FAULT_MAP_ENV];
    else process.env[FAULT_MAP_ENV] = previousFaultMap;
    if (previousMarkerPath === undefined) delete process.env[CRASH_MARKER_PATH_ENV];
    else process.env[CRASH_MARKER_PATH_ENV] = previousMarkerPath;
    if (previousToken === undefined) delete process.env[CRASH_MARKER_TOKEN_ENV];
    else process.env[CRASH_MARKER_TOKEN_ENV] = previousToken;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }

  assert.deepEqual(trace, [
    { operation: 'fsyncFile', target: path.resolve(markerPath) },
    { operation: 'fsyncDirectory', target: path.resolve(root) },
    { operation: 'kill', pid: process.pid, signal: 'SIGKILL' },
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), {
    name: faultName,
    pid: process.pid,
    signal: 'SIGKILL',
    token,
    version: 1,
    context: { entryKind: 'event' },
  });
});

for (const failureOperation of ['fsyncFile', 'fsyncDirectory']) {
  test(`bounded checkpoint crash marker ${failureOperation} failure never authenticates SIGKILL`, { concurrency: false }, (t) => {
    assertCheckpointCrashMarkerDurabilityFailure(t, failureOperation);
  });
}

test('bounded checkpoint crash marker preserves fsync primary and cleanup identity without killing on compound failure', { concurrency: false }, (t) => {
  const cleanupFailure = Object.assign(
    new Error('marker cleanup failed'),
    { code: 'EACCES' },
  );
  assertCheckpointCrashMarkerDurabilityFailure(
    t,
    'fsyncFile',
    { cleanupFailure },
  );
});

test('runUntilCrash rejects an authenticated-looking marker followed by ordinary Windows exit two', { concurrency: false, skip: process.platform !== 'win32' }, async (t) => {
  const controlDir = createControlDir(t);
  await assert.rejects(
    runUntilCrash({
      script: path.join(__dirname, 'fixtures', 'control-store-crash.js'),
      faults: { [CHECKPOINT_MARKER_COMPOUND_FAULT]: { crash: true } },
      env: {
        MYTHPEN_CONTROL_STORE_CRASH_DIR: controlDir,
        MYTHPEN_CONTROL_STORE_CRASH_SCENARIO: 'marker-compound-failure',
      },
      timeoutMs: 20_000,
    }),
    (error) => (
      error?.message
      === 'Crash marker raw exit does not match win32 SIGKILL: status=2 signal=null'
    ),
  );
});

test('bounded checkpoint fault selector preserves whenFileExists and no-selector actions', { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-selector-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markerPath = path.join(root, 'exists');
  fs.writeFileSync(markerPath, 'marker');
  let callbackCalls = 0;

  await withFaults({
    'batch4.selector.file-present': {
      active: true,
      callback() { callbackCalls += 1; },
      whenFileExists: markerPath,
    },
    'batch4.selector.file-missing': {
      active: true,
      callback() { callbackCalls += 1; },
      whenFileExists: path.join(root, 'missing'),
    },
    'batch4.selector.none': {
      active: true,
      callback() { callbackCalls += 1; },
    },
  }, async () => {
    assert.equal(faultPoint('batch4.selector.file-present', {}), true);
    assert.equal(faultPoint('batch4.selector.file-missing', {}), false);
    assert.equal(faultPoint('batch4.selector.none', {}), true);
  });

  assert.equal(callbackCalls, 2);
});

test('bounded checkpoint fault selector combines whenFileExists and whenContextEquals with exact AND semantics', { concurrency: false }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-selector-and-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const markerPath = path.join(root, 'exists');
  fs.writeFileSync(markerPath, 'marker');
  let callbackCalls = 0;

  await withFaults({
    'batch4.selector.and-match': {
      active: true,
      callback() { callbackCalls += 1; },
      whenContextEquals: { entryKind: 'event' },
      whenFileExists: markerPath,
    },
    'batch4.selector.and-context-mismatch': {
      active: true,
      callback() { callbackCalls += 1; },
      whenContextEquals: { entryKind: 'event' },
      whenFileExists: markerPath,
    },
    'batch4.selector.and-file-missing': {
      active: true,
      callback() { callbackCalls += 1; },
      whenContextEquals: { entryKind: 'event' },
      whenFileExists: path.join(root, 'missing'),
    },
  }, async () => {
    assert.equal(faultPoint('batch4.selector.and-match', {
      entryKind: 'event',
    }), true);
    assert.equal(faultPoint('batch4.selector.and-context-mismatch', {
      entryKind: 'old-checkpoint',
    }), false);
    assert.equal(faultPoint('batch4.selector.and-file-missing', {
      entryKind: 'event',
    }), false);
  });

  assert.equal(callbackCalls, 1);
});

const checkpointInstallFaultCases = [
  {
    name: 'checkpoint before publish',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH,
    phase: 'pre-tail',
  },
  {
    name: 'checkpoint before candidate unlink',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK,
    phase: 'pre-tail',
  },
  {
    name: 'checkpoint before final directory fsync',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC,
    phase: 'pre-tail',
  },
  {
    name: 'checkpoint after final directory fsync',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC,
    phase: 'pre-tail',
  },
  {
    name: 'tail before publish',
    faultPoint: FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH,
    phase: 'pre-tail',
  },
  {
    name: 'tail after replace before directory fsync',
    faultPoint: FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC,
    phase: 'installed',
  },
  {
    name: 'checkpoint before GC',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC,
    phase: 'installed',
  },
  {
    name: 'checkpoint after one GC entry',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY,
    phase: 'installed',
  },
  {
    name: 'checkpoint before GC directory fsync',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC,
    phase: 'installed',
  },
];

for (const faultCase of checkpointInstallFaultCases) {
  test(`bounded checkpoint fault uncertainty matrix ${faultCase.name}`, { concurrency: false }, async (t) => {
    const { controlDir, genesis, legacy } = createFixtureGenesisStore(t);
    legacy.append({
      type: 'bounded.checkpoint.fault-second-event',
      payload: { version: 1 },
    });
    let sourceCalls = 0;
    let authority;
    const harness = createBoundedControlStoreTestHarness(controlDir, () => {
      sourceCalls += 1;
      return authority;
    });
    const controller = controlStoreModule.getBoundedControlStoreCheckpointController(
      harness.controlStore,
    );
    authority = createAuthority(harness.controlStore, genesis);
    const beforeEvidence = harness.controlStore.readEvidence();
    const expectedCheckpoint = buildExpectedCheckpoint(beforeEvidence, authority);
    const expectedCheckpointFile = `.controlstore-checkpoint-${expectedCheckpoint.coveredSeq}-${expectedCheckpoint.checkpointDigest}.json`;
    const coveredEventNames = eventFileNames(controlDir);
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);
    const marker = Object.assign(
      new Error(`fault marker ${faultCase.name}`),
      { code: 'CONTROL_STORE_IO' },
    );
    let callbackCalls = 0;
    let receipt;
    let observed;

    await withFaults({
      [faultCase.faultPoint]: {
        callback(context) {
          callbackCalls += 1;
          if (
            faultCase.faultPoint === FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH
            || faultCase.faultPoint === FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC
          ) {
            assert.equal(context.operation, 'checkpoint-activation');
          }
          if (
            faultCase.faultPoint
              === CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY
          ) {
            assert.deepEqual(context, {
              entryKind: 'event',
              entryName: coveredEventNames[0],
            });
          }
          throw marker;
        },
      },
    }, async () => {
      assert.throws(
        () => { receipt = controller.installCheckpoint(() => {
          sourceCalls += 1;
          return authority;
        }); },
        (error) => {
          observed = error;
          if (faultCase.phase === 'pre-tail') return error === marker;
          return error?.code === 'RECOVERY_REQUIRED' && error.cause === marker;
        },
      );
    });

    assert.equal(receipt, undefined);
    assert.equal(sourceCalls, 1);
    assert.equal(callbackCalls, 1);
    assert.equal(observed.secondaryErrors, undefined);
    assert.equal(observed.cleanupError, undefined);

    if (faultCase.phase === 'pre-tail') {
      assert.deepEqual(snapshotTree(root), before);
      assert.deepEqual(harness.controlStore.readEvidence(), beforeEvidence);
      assert.equal(harness.controlStore.assertCurrent(), true);
      assert.equal(
        fs.readdirSync(controlDir).some((name) => (
          CHECKPOINT_CANDIDATE_PATTERN.test(name)
          || TAIL_CANDIDATE_PATTERN.test(name)
          || name === expectedCheckpointFile
        )),
        false,
      );
      const retryReceipt = controller.installCheckpoint(() => {
        sourceCalls += 1;
        return authority;
      });
      assert.equal(sourceCalls, 2);
      assert.equal(Object.isFrozen(retryReceipt), true);
      assert.deepEqual(retryReceipt, {
        checkpointDigest: expectedCheckpoint.checkpointDigest,
        coveredSeq: expectedCheckpoint.coveredSeq,
      });
      return;
    }

    assert.throws(
      () => controller.maintenanceStatus(),
      { code: 'CONTROL_STORE_FENCED' },
    );
    assertBoundedFacadeFenced(harness.controlStore);
    let reopenedProviderCalls = 0;
    const reopened = createBoundedControlStoreTestHarness(controlDir, () => {
      reopenedProviderCalls += 1;
      throw new Error('fault recovery reopen must not call provider');
    });
    assert.equal(reopenedProviderCalls, 0);
    const evidence = reopened.controlStore.readEvidence();
    assert.deepEqual(evidence.checkpoint, expectedCheckpoint);
    assert.equal(evidence.tail.checkpointFile, expectedCheckpointFile);
    assert.deepEqual(evidence.events, []);
    assert.deepEqual(eventFileNames(controlDir), []);
    assert.equal(
      fs.readdirSync(controlDir).some((name) => (
        CHECKPOINT_CANDIDATE_PATTERN.test(name)
        || TAIL_CANDIDATE_PATTERN.test(name)
      )),
      false,
    );
  });
}

test('bounded checkpoint fault uncertainty after tail callback but before atomic replace recovers and fences', { concurrency: false }, async (t) => {
  const { controlDir, genesis } = createFixtureGenesisStore(t);
  const marker = Object.assign(
    new Error('checkpoint activation atomic replace seam'),
    { code: 'CONTROL_STORE_IO' },
  );
  let armed = false;
  let atomicReplaceAttempts = 0;
  const runtime = loadCheckpointRuntimeWithHooks({
    beforeAtomicReplace(sourcePath, targetPath) {
      if (!armed || path.basename(targetPath) !== '.controlstore-tail.json') return;
      atomicReplaceAttempts += 1;
      assert.equal(TAIL_CANDIDATE_PATTERN.test(path.basename(sourcePath)), true);
      throw marker;
    },
  });
  let sourceCalls = 0;
  let authority;
  const harness = runtime.createHarnessAt(controlDir, () => {
    sourceCalls += 1;
    return authority;
  });
  const controller = runtime.controlStoreModule
    .getBoundedControlStoreCheckpointController(harness.controlStore);
  authority = createAuthority(harness.controlStore, genesis);
  const beforeEvidence = harness.controlStore.readEvidence();
  const expectedCheckpoint = buildExpectedCheckpoint(beforeEvidence, authority);
  const expectedCheckpointFile = `.controlstore-checkpoint-${expectedCheckpoint.coveredSeq}-${expectedCheckpoint.checkpointDigest}.json`;
  const oldTailBytes = fs.readFileSync(
    path.join(controlDir, '.controlstore-tail.json'),
  );
  const oldEventNames = eventFileNames(controlDir);
  let tailCallbackCalls = 0;
  let receipt;
  let observed;

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH]: {
      callback(context) {
        tailCallbackCalls += 1;
        assert.equal(context.operation, 'checkpoint-activation');
      },
    },
  }, async () => {
    armed = true;
    assert.throws(
      () => {
        receipt = controller.installCheckpoint(() => {
          sourceCalls += 1;
          return authority;
        });
      },
      (error) => {
        observed = error;
        return error?.code === 'RECOVERY_REQUIRED' && error.cause === marker;
      },
    );
    armed = false;
  });

  assert.equal(receipt, undefined);
  assert.equal(sourceCalls, 1);
  assert.equal(tailCallbackCalls, 1);
  assert.equal(atomicReplaceAttempts, 1);
  assert.equal(observed.secondaryErrors, undefined);
  assert.equal(observed.cleanupError, undefined);
  assert.deepEqual(
    fs.readFileSync(path.join(controlDir, '.controlstore-tail.json')),
    oldTailBytes,
  );
  assert.deepEqual(eventFileNames(controlDir), oldEventNames);
  assert.equal(
    fs.existsSync(path.join(controlDir, expectedCheckpointFile)),
    true,
  );
  assert.equal(
    fs.readdirSync(controlDir).some((name) => TAIL_CANDIDATE_PATTERN.test(name)),
    false,
  );
  assert.throws(
    () => controller.maintenanceStatus(),
    { code: 'CONTROL_STORE_FENCED' },
  );
  assertBoundedFacadeFenced(harness.controlStore);

  let reopenProviderCalls = 0;
  const reopened = runtime.createHarnessAt(controlDir, () => {
    reopenProviderCalls += 1;
    throw new Error('activation seam recovery reopen must not call provider');
  });
  assert.equal(reopenProviderCalls, 0);
  assert.equal(
    fs.existsSync(path.join(controlDir, expectedCheckpointFile)),
    false,
  );
  assert.deepEqual(reopened.controlStore.readEvidence(), beforeEvidence);
});

test('bounded checkpoint fault selector targets synchronous old-checkpoint GC failure exactly', { concurrency: false }, async (t) => {
  const fixture = createCheckpointProposalFixture(t);
  let sourceCalls = 0;
  let authority;
  const harness = createBoundedControlStoreTestHarness(fixture.controlDir, () => {
    sourceCalls += 1;
    return authority;
  });
  const controller = controlStoreModule.getBoundedControlStoreCheckpointController(
    harness.controlStore,
  );
  authority = createCheckpointProjectionAuthority(
    harness.controlStore,
    fixture.previousCheckpoint,
    [crypto.randomUUID()],
  );
  const beforeEvidence = harness.controlStore.readEvidence();
  const expectedCheckpoint = buildExpectedCheckpoint(beforeEvidence, authority);
  const expectedCheckpointFile = `.controlstore-checkpoint-${expectedCheckpoint.coveredSeq}-${expectedCheckpoint.checkpointDigest}.json`;
  const marker = Object.assign(
    new Error('old-checkpoint GC selector failure'),
    { code: 'CONTROL_STORE_IO' },
  );
  const contexts = [];
  let receipt;
  let observed;

  await withFaults({
    [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY]: {
      callback(context) {
        contexts.push(cloneData(context));
        if (context.entryKind === 'old-checkpoint') throw marker;
      },
      whenContextEquals: { entryKind: 'old-checkpoint' },
    },
  }, async () => {
    assert.throws(
      () => {
        receipt = controller.installCheckpoint(() => {
          sourceCalls += 1;
          return authority;
        });
      },
      (error) => {
        observed = error;
        return error?.code === 'RECOVERY_REQUIRED' && error.cause === marker;
      },
    );
  });

  assert.equal(receipt, undefined);
  assert.equal(sourceCalls, 1);
  assert.deepEqual(contexts, [{
    entryKind: 'old-checkpoint',
    entryName: fixture.previousCheckpointFile,
  }]);
  assert.equal(observed.secondaryErrors, undefined);
  assert.equal(observed.cleanupError, undefined);
  assert.throws(
    () => controller.maintenanceStatus(),
    { code: 'CONTROL_STORE_FENCED' },
  );
  assertBoundedFacadeFenced(harness.controlStore);

  let reopenProviderCalls = 0;
  const reopened = createBoundedControlStoreTestHarness(fixture.controlDir, () => {
    reopenProviderCalls += 1;
    throw new Error('old-checkpoint fault recovery reopen must not call provider');
  });
  assert.equal(reopenProviderCalls, 0);
  assert.deepEqual(reopened.controlStore.readEvidence().checkpoint, expectedCheckpoint);
  assert.equal(
    reopened.controlStore.readEvidence().tail.checkpointFile,
    expectedCheckpointFile,
  );
  assert.deepEqual(reopened.controlStore.readEvidence().events, []);
  assert.equal(
    fs.existsSync(path.join(fixture.controlDir, fixture.previousCheckpointFile)),
    false,
  );
});

const checkpointReleaseShapes = [
  { name: 'writer', writer: true, lifecycle: false },
  { name: 'lifecycle', writer: false, lifecycle: true },
  { name: 'writer and lifecycle', writer: true, lifecycle: true },
];

function checkpointReleaseFixture(label, shape, options = {}) {
  const writerError = Object.assign(
    new Error(`${label} writer release`),
    { code: 'CONTROL_STORE_IO' },
  );
  const lifecycleError = Object.assign(
    new Error(`${label} lifecycle release`),
    { code: 'CONTROL_STORE_IO' },
  );
  const ordered = [
    ...(shape.writer ? [writerError] : []),
    ...(shape.lifecycle ? [lifecycleError] : []),
  ];
  return {
    lifecycleError,
    ordered,
    failures: {
      writer: shape.writer ? [writerError] : [],
      lifecycle: shape.lifecycle
        ? [...(options.skipFirstLifecycle ? [null] : []), lifecycleError]
        : [],
    },
    writerError,
  };
}

function assertCleanupAttachments(error, cleanupErrors) {
  assert.deepEqual(error.secondaryErrors, cleanupErrors);
  assert.equal(error.cleanupError, cleanupErrors.at(-1));
}

function assertCheckpointControllerMaintenanceAvailable(harness) {
  const { activeEventBytes, activeEventCount } = harness.controlStore.readEvidence().tail;
  const level = activeEventCount >= 8192 || activeEventBytes >= 32 * 1024 * 1024
    ? 'hard'
    : activeEventCount >= 4096 || activeEventBytes >= 16 * 1024 * 1024
      ? 'soft'
      : 'none';
  assertExactFrozenStatus(harness.maintenanceStatus(), {
    activeEventBytes,
    activeEventCount,
    level,
  });
}

for (const releaseShape of checkpointReleaseShapes) {
  test(`bounded checkpoint release provider recovery preserves primary with ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const { controlDir } = createFixtureGenesisStore(t);
    const runtime = loadCheckpointRuntimeWithReleaseHarness();
    const providerFailure = new Error('release provider primary');
    let sourceCalls = 0;
    const harness = runtime.createHarnessAt(controlDir, () => {
      sourceCalls += 1;
      throw providerFailure;
    });
    const releases = checkpointReleaseFixture('provider recovery', releaseShape);
    runtime.arm(releases.failures);
    let receipt;
    let observed;

    assert.throws(
      () => { receipt = harness.checkpoint(); },
      (error) => {
        observed = error;
        return error?.code === 'RECOVERY_REQUIRED' && error.cause === providerFailure;
      },
    );
    runtime.disarm();

    assert.equal(receipt, undefined);
    assert.equal(sourceCalls, 1);
    assert.deepEqual(observed.secondaryErrors, releases.ordered);
    assert.equal(observed.cleanupError, undefined);
    assert.equal(harness.controlStore.assertCurrent(), true);
    assertCheckpointControllerMaintenanceAvailable(harness);
  });

  test(`bounded checkpoint release empty blocked preserves primary with ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const controlDir = createControlDir(t);
    const runtime = loadCheckpointRuntimeWithReleaseHarness();
    let sourceCalls = 0;
    const harness = runtime.createHarnessAt(controlDir, () => {
      sourceCalls += 1;
      throw new Error('empty checkpoint must not call provider');
    });
    const releases = checkpointReleaseFixture('empty blocked', releaseShape);
    runtime.arm(releases.failures);
    let receipt;
    let observed;

    assert.throws(
      () => { receipt = harness.checkpoint(); },
      (error) => {
        observed = error;
        return error?.code === 'CONTROL_CHECKPOINT_BLOCKED';
      },
    );
    runtime.disarm();

    assert.equal(receipt, undefined);
    assert.equal(sourceCalls, 0);
    assertCleanupAttachments(observed, releases.ordered);
    assert.equal(harness.controlStore.assertCurrent(), true);
    assertCheckpointControllerMaintenanceAvailable(harness);
  });

  test(`bounded checkpoint release Bloom-cap blocked preserves primary with ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const fixture = installCheckpointEvidence(t, {
      halfFullFilter: true,
      withActiveSuffix: true,
    });
    const newEpoch = findEpochWithClearFilterBit(
      fixture.filterBytes,
      fixture.checkpoint.admissionBasis.basisDigest,
    );
    const runtime = loadCheckpointRuntimeWithReleaseHarness();
    let authority;
    let sourceCalls = 0;
    const harness = runtime.createHarnessAt(fixture.controlDir, () => {
      sourceCalls += 1;
      return authority;
    });
    authority = createCheckpointProjectionAuthority(
      harness.controlStore,
      fixture.checkpoint,
      [newEpoch],
    );
    const releases = checkpointReleaseFixture('Bloom cap blocked', releaseShape);
    const before = snapshotTree(path.dirname(fixture.controlDir));
    runtime.arm(releases.failures);
    let receipt;
    let observed;

    assert.throws(
      () => { receipt = harness.checkpoint(); },
      (error) => {
        observed = error;
        return error?.code === 'CONTROL_CHECKPOINT_BLOCKED';
      },
    );
    runtime.disarm();

    assert.equal(receipt, undefined);
    assert.equal(sourceCalls, 1);
    assertCleanupAttachments(observed, releases.ordered);
    assert.deepEqual(snapshotTree(path.dirname(fixture.controlDir)), before);
    assert.equal(harness.controlStore.assertCurrent(), true);
    assertCheckpointControllerMaintenanceAvailable(harness);
  });

  test(`bounded checkpoint release pending no-op receipt stays absent on ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const fixture = installCheckpointEvidence(t);
    const runtime = loadCheckpointRuntimeWithReleaseHarness();
    let authority;
    let sourceCalls = 0;
    const harness = runtime.createHarnessAt(fixture.controlDir, () => {
      sourceCalls += 1;
      return authority;
    });
    authority = createCheckpointProjectionAuthority(
      harness.controlStore,
      fixture.checkpoint,
      [],
    );
    const before = snapshotTree(path.dirname(fixture.controlDir));
    const releases = checkpointReleaseFixture('no-op', releaseShape);
    runtime.arm(releases.failures);
    let receipt;
    let observed;

    assert.throws(
      () => { receipt = harness.checkpoint(); },
      (error) => {
        observed = error;
        return error === releases.ordered[0];
      },
    );
    runtime.disarm();

    assert.equal(receipt, undefined);
    assert.equal(sourceCalls, 1);
    if (releases.ordered.length === 2) {
      assert.deepEqual(observed.secondaryErrors, [releases.ordered[1]]);
      assert.equal(observed.cleanupError, releases.ordered[1]);
    } else {
      assert.equal(observed.secondaryErrors, undefined);
      assert.equal(observed.cleanupError, undefined);
    }
    assert.deepEqual(snapshotTree(path.dirname(fixture.controlDir)), before);
    assert.equal(harness.controlStore.assertCurrent(), true);
    assertCheckpointControllerMaintenanceAvailable(harness);
  });

  test(`bounded checkpoint release pre-tail primary stays IO on ${releaseShape.name} failure`, { concurrency: false }, async (t) => {
    const { controlDir, genesis } = createFixtureGenesisStore(t);
    const runtime = loadCheckpointRuntimeWithReleaseHarness();
    let authority;
    let sourceCalls = 0;
    const harness = runtime.createHarnessAt(controlDir, () => {
      sourceCalls += 1;
      return authority;
    });
    authority = createAuthority(harness.controlStore, genesis);
    const before = snapshotTree(path.dirname(controlDir));
    const primary = Object.assign(
      new Error('pre-tail release primary'),
      { code: 'CONTROL_STORE_IO' },
    );
    const releases = checkpointReleaseFixture('pre-tail', releaseShape);
    runtime.arm(releases.failures);
    let receipt;
    let observed;

    await withFaults({
      [CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH]: {
        callback() { throw primary; },
      },
    }, async () => {
      assert.throws(
        () => { receipt = harness.checkpoint(); },
        (error) => {
          observed = error;
          return error === primary;
        },
      );
    });
    runtime.disarm();

    assert.equal(receipt, undefined);
    assert.equal(sourceCalls, 1);
    assertCleanupAttachments(observed, releases.ordered);
    assert.deepEqual(snapshotTree(path.dirname(controlDir)), before);
    assert.equal(harness.controlStore.assertCurrent(), true);
    assertCheckpointControllerMaintenanceAvailable(harness);
  });

  test(`bounded checkpoint release installed evidence recovers and fences on ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const { controlDir, genesis } = createFixtureGenesisStore(t);
    const runtime = loadCheckpointRuntimeWithReleaseHarness();
    let authority;
    let sourceCalls = 0;
    const harness = runtime.createHarnessAt(controlDir, () => {
      sourceCalls += 1;
      return authority;
    });
    authority = createAuthority(harness.controlStore, genesis);
    const expectedCheckpoint = buildExpectedCheckpoint(
      harness.controlStore.readEvidence(),
      authority,
    );
    const releases = checkpointReleaseFixture('installed', releaseShape);
    runtime.arm(releases.failures);
    let receipt;
    let observed;

    assert.throws(
      () => { receipt = harness.checkpoint(); },
      (error) => {
        observed = error;
        return (
          error?.code === 'RECOVERY_REQUIRED'
          && error.cause === releases.ordered[0]
        );
      },
    );
    runtime.disarm();

    assert.equal(receipt, undefined);
    assert.equal(sourceCalls, 1);
    if (releases.ordered.length === 2) {
      assert.deepEqual(observed.secondaryErrors, [releases.ordered[1]]);
    } else {
      assert.equal(observed.secondaryErrors, undefined);
    }
    assert.equal(observed.cleanupError, undefined);
    assert.throws(
      () => harness.maintenanceStatus(),
      { code: 'CONTROL_STORE_FENCED' },
    );
    assertBoundedFacadeFenced(harness.controlStore);

    let reopenProviderCalls = 0;
    const reopened = runtime.createHarnessAt(controlDir, () => {
      reopenProviderCalls += 1;
      throw new Error('installed release recovery reopen must not call provider');
    });
    assert.equal(reopenProviderCalls, 0);
    assert.deepEqual(reopened.controlStore.readEvidence().checkpoint, expectedCheckpoint);
    assert.deepEqual(reopened.controlStore.readEvidence().events, []);
    assert.deepEqual(eventFileNames(controlDir), []);
  });
}

function createRepeatedCheckpointCrashFixture(t) {
  const base = installCheckpointEvidence(t, { withActiveSuffix: true });
  const seedStore = openControlStore(base.controlDir, { bounded: true });
  const oldEvidence = seedStore.readEvidence();
  assert.equal(oldEvidence.events.length, 1);
  const authority = createCheckpointProjectionAuthority(
    seedStore,
    base.checkpoint,
    [crypto.randomUUID()],
  );
  const authorityPayload = cloneData(authority);
  assert.deepEqual(Object.keys(authorityPayload).sort(), [
    'cleanBasis',
    'epochObservations',
    'snapshot',
  ]);
  const expectedCheckpoint = buildExpectedCheckpoint(oldEvidence, authority);
  const expectedCheckpointFile = `.controlstore-checkpoint-${expectedCheckpoint.coveredSeq}-${expectedCheckpoint.checkpointDigest}.json`;
  const expectedTail = checkpointActivationTail(
    oldEvidence,
    expectedCheckpoint,
    expectedCheckpointFile,
  );
  const oldCheckpointPath = path.join(
    base.controlDir,
    oldEvidence.tail.checkpointFile,
  );
  const expectedCheckpointPath = path.join(
    base.controlDir,
    expectedCheckpointFile,
  );
  return {
    ...base,
    authorityPayload,
    expectedCheckpoint,
    expectedCheckpointFile,
    expectedCheckpointPath,
    expectedTail,
    fixtureKind: 'repeated',
    oldCheckpointPath,
    oldEvidence,
  };
}

function createFirstCheckpointCrashFixture(t) {
  const { controlDir, genesis, legacy } = createFixtureGenesisStore(t);
  legacy.append({
    type: 'bounded.checkpoint.crash-first-suffix',
    payload: { version: 1 },
  });
  const seedStore = openControlStore(controlDir, { bounded: true });
  const oldEvidence = seedStore.readEvidence();
  assert.equal(oldEvidence.checkpoint, null);
  assert.deepEqual(oldEvidence.events.map((event) => event.seq), [1, 2]);
  const authority = createAuthority(seedStore, genesis);
  const authorityPayload = cloneData(authority);
  assert.deepEqual(Object.keys(authorityPayload).sort(), [
    'cleanBasis',
    'epochObservations',
    'snapshot',
  ]);
  const expectedCheckpoint = buildExpectedCheckpoint(oldEvidence, authority);
  assert.equal(expectedCheckpoint.previousCheckpoint, null);
  const expectedCheckpointFile = `.controlstore-checkpoint-${expectedCheckpoint.coveredSeq}-${expectedCheckpoint.checkpointDigest}.json`;
  const expectedCheckpointPath = path.join(controlDir, expectedCheckpointFile);
  const expectedTail = checkpointActivationTail(
    oldEvidence,
    expectedCheckpoint,
    expectedCheckpointFile,
  );
  return {
    authorityPayload,
    controlDir,
    expectedCheckpoint,
    expectedCheckpointFile,
    expectedCheckpointPath,
    expectedTail,
    fixtureKind: 'first',
    oldCheckpointPath: null,
    oldEvidence,
  };
}

function assertCheckpointCrashEvidence(evidence) {
  assert.deepEqual(Reflect.ownKeys(evidence).sort(), ['checkpoint', 'events', 'tail']);
  if (evidence.checkpoint === null) {
    assert.equal(evidence.tail.checkpointFile, null);
    assert.equal(evidence.tail.checkpointDigest, null);
    assert.equal(evidence.tail.coveredSeq, 0);
    assert.equal(evidence.tail.coveredDigest, null);
  } else {
    assert.equal(evidence.tail.checkpointFile, `.controlstore-checkpoint-${evidence.checkpoint.coveredSeq}-${evidence.checkpoint.checkpointDigest}.json`);
    assert.equal(evidence.tail.checkpointDigest, evidence.checkpoint.checkpointDigest);
    assert.equal(evidence.tail.coveredSeq, evidence.checkpoint.coveredSeq);
    assert.equal(evidence.tail.coveredDigest, evidence.checkpoint.coveredDigest);
  }
  assert.equal(new Set(evidence.events.map((event) => event.seq)).size, evidence.events.length);
  for (const [index, event] of evidence.events.entries()) {
    assert.equal(event.seq, evidence.tail.coveredSeq + index + 1);
    assert.equal(
      event.prevDigest,
      index === 0 ? evidence.tail.coveredDigest : evidence.events[index - 1].digest,
    );
  }
  const activeTail = evidence.events.at(-1) || null;
  assert.equal(
    evidence.tail.tailSeq,
    activeTail?.seq ?? evidence.tail.coveredSeq,
  );
  assert.equal(
    evidence.tail.tailDigest,
    activeTail?.digest ?? evidence.tail.coveredDigest,
  );
  assert.equal(evidence.tail.activeEventCount, evidence.events.length);
  assert.equal(
    evidence.tail.activeEventBytes,
    evidence.events.reduce(
      (sum, event) => sum + Buffer.byteLength(canonicalJson(event), 'utf8'),
      0,
    ),
  );
}

function assertCheckpointCrashMarker(crash, crashCase, fixture) {
  assert.deepEqual(crash.artifacts, {
    version: 1,
    scenario: 'checkpoint',
    controlDir: fixture.controlDir,
  });
  assert.deepEqual(Object.keys(crash.crashPoint).sort(), [
    'context',
    'name',
    'pid',
    'signal',
    'token',
    'version',
  ]);
  assert.equal(crash.crashPoint.name, crashCase.faultPoint);
  assert.equal(crash.crashPoint.signal, 'SIGKILL');
  assert.equal(crash.crashPoint.version, 1);
  assert.match(crash.crashPoint.token, /^[0-9a-f-]{36}$/);
  if (process.platform === 'win32') {
    assert.equal(crash.status, 1);
    assert.equal(crash.observedSignal, null);
  } else {
    assert.equal(crash.status, null);
    assert.equal(crash.observedSignal, 'SIGKILL');
  }

  const context = crash.crashPoint.context;
  if (
    crashCase.faultPoint === CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH
    || crashCase.faultPoint
      === CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK
  ) {
    assert.deepEqual(Object.keys(context).sort(), [
      'candidatePath',
      'checkpointFile',
      'finalPath',
    ]);
    assert.equal(context.checkpointFile, fixture.expectedCheckpointFile);
    assert.equal(path.dirname(path.resolve(context.candidatePath)), path.resolve(fixture.controlDir));
    assert.equal(CHECKPOINT_CANDIDATE_PATTERN.test(path.basename(context.candidatePath)), true);
    assert.equal(path.resolve(context.finalPath), path.resolve(fixture.expectedCheckpointPath));
  } else if (
    crashCase.faultPoint
      === CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC
    || crashCase.faultPoint
      === CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC
  ) {
    assert.deepEqual(Object.keys(context).sort(), ['checkpointFile', 'finalPath']);
    assert.equal(context.checkpointFile, fixture.expectedCheckpointFile);
    assert.equal(path.resolve(context.finalPath), path.resolve(fixture.expectedCheckpointPath));
  } else if (crashCase.faultPoint === FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH) {
    assert.deepEqual(Object.keys(context).sort(), [
      'operation',
      'recordDigest',
      'targetPath',
      'tempPath',
    ]);
    assert.equal(context.operation, 'checkpoint-activation');
    assert.equal(context.recordDigest, fixture.expectedTail.recordDigest);
    assert.equal(path.resolve(context.targetPath), path.resolve(path.join(fixture.controlDir, '.controlstore-tail.json')));
    assert.equal(TAIL_CANDIDATE_PATTERN.test(path.basename(context.tempPath)), true);
  } else if (crashCase.faultPoint === FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC) {
    assert.deepEqual(Object.keys(context).sort(), [
      'operation',
      'recordDigest',
      'targetPath',
    ]);
    assert.equal(context.operation, 'checkpoint-activation');
    assert.equal(context.recordDigest, fixture.expectedTail.recordDigest);
    assert.equal(path.resolve(context.targetPath), path.resolve(path.join(fixture.controlDir, '.controlstore-tail.json')));
  } else if (
    crashCase.faultPoint === CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC
    || crashCase.faultPoint
      === CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC
  ) {
    assert.deepEqual(Object.keys(context).sort(), ['checkpointFile', 'coveredSeq']);
    assert.equal(context.checkpointFile, fixture.expectedCheckpointFile);
    assert.equal(context.coveredSeq, fixture.expectedCheckpoint.coveredSeq);
  } else {
    assert.deepEqual(Object.keys(context).sort(), ['entryKind', 'entryName']);
    assert.equal(context.entryKind, crashCase.entryKind);
    const expectedEntryName = crashCase.entryKind === 'event'
      ? `${fixture.oldEvidence.events[0].seq}-${fixture.oldEvidence.events[0].digest}.json`
      : fixture.expectedCheckpoint.previousCheckpoint.checkpointFile;
    assert.equal(context.entryName, expectedEntryName);
    assert.equal(fs.existsSync(path.join(fixture.controlDir, expectedEntryName)), false);
  }
}

function assertCheckpointCrashTopologyBeforeReopen(crashCase, fixture, crash) {
  const names = fs.readdirSync(fixture.controlDir).sort();
  const checkpointCandidates = names.filter((name) => CHECKPOINT_CANDIDATE_PATTERN.test(name));
  const checkpointFinals = names.filter((name) => CHECKPOINT_FINAL_PATTERN.test(name));
  const tailCandidates = names.filter((name) => TAIL_CANDIDATE_PATTERN.test(name));
  const expectedCandidateNames = (
    crashCase.topology === 'candidate-only'
    || crashCase.topology === 'candidate-final-hardlink'
  )
    ? [path.basename(crash.crashPoint.context.candidatePath)]
    : [];
  const expectedFinalNames = [];
  if (crashCase.topology !== 'candidate-only') {
    expectedFinalNames.push(fixture.expectedCheckpointFile);
  }
  if (
    fixture.oldCheckpointPath !== null
    && crashCase.topology !== 'new-tail-after-old-checkpoint'
  ) {
    expectedFinalNames.push(path.basename(fixture.oldCheckpointPath));
  }
  const expectedTailCandidateNames = crashCase.topology === 'final-tail-candidate'
    ? [path.basename(crash.crashPoint.context.tempPath)]
    : [];

  assert.deepEqual(checkpointCandidates, expectedCandidateNames.sort());
  assert.deepEqual(checkpointFinals, expectedFinalNames.sort());
  assert.deepEqual(tailCandidates, expectedTailCandidateNames.sort());

  const persistentTailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
  const expectedPersistentTail = crashCase.outcome === 'old'
    ? fixture.oldEvidence.tail
    : fixture.expectedTail;
  assert.equal(
    fs.readFileSync(persistentTailPath, 'utf8'),
    canonicalJson(expectedPersistentTail),
  );

  for (const candidateName of checkpointCandidates) {
    assert.equal(
      fs.readFileSync(path.join(fixture.controlDir, candidateName), 'utf8'),
      canonicalJson(fixture.expectedCheckpoint),
    );
  }
  if (checkpointFinals.includes(fixture.expectedCheckpointFile)) {
    assert.equal(
      fs.readFileSync(fixture.expectedCheckpointPath, 'utf8'),
      canonicalJson(fixture.expectedCheckpoint),
    );
  }
  for (const tailCandidateName of tailCandidates) {
    const tailCandidatePath = path.join(fixture.controlDir, tailCandidateName);
    assert.equal(fs.readFileSync(tailCandidatePath, 'utf8'), canonicalJson(fixture.expectedTail));
    const tailCandidate = JSON.parse(fs.readFileSync(tailCandidatePath, 'utf8'));
    assert.equal(tailCandidate.checkpointFile, fixture.expectedCheckpointFile);
    assert.equal(tailCandidate.checkpointDigest, fixture.expectedCheckpoint.checkpointDigest);
  }

  if (crashCase.topology === 'candidate-final-hardlink') {
    const candidatePath = path.join(fixture.controlDir, checkpointCandidates[0]);
    const candidateStats = fs.statSync(candidatePath, { bigint: true });
    const finalStats = fs.statSync(fixture.expectedCheckpointPath, { bigint: true });
    assert.equal(candidateStats.dev, finalStats.dev);
    assert.equal(candidateStats.ino, finalStats.ino);
  }

  let survivorEvents = fixture.oldEvidence.events;
  if (crashCase.topology === 'new-tail-after-event') {
    survivorEvents = survivorEvents.slice(1);
  } else if (
    crashCase.topology === 'new-tail-after-old-checkpoint'
    || crashCase.topology === 'new-tail-clean'
  ) {
    survivorEvents = [];
  }
  assert.deepEqual(
    eventFileNames(fixture.controlDir),
    survivorEvents.map((event) => `${event.seq}-${event.digest}.json`),
  );
}

const checkpointCrashCases = [
  {
    name: 'checkpoint before publish',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH,
    topology: 'candidate-only',
    outcome: 'old',
    inspectorRecovery: true,
  },
  {
    name: 'checkpoint before candidate unlink',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK,
    topology: 'candidate-final-hardlink',
    outcome: 'old',
    inspectorRecovery: true,
  },
  {
    name: 'checkpoint before final directory fsync',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC,
    topology: 'final-old-tail',
    outcome: 'old',
    inspectorRecovery: true,
  },
  {
    name: 'checkpoint after final directory fsync',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC,
    topology: 'final-old-tail',
    outcome: 'old',
    inspectorRecovery: true,
  },
  {
    name: 'activation tail before publish',
    faultPoint: FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH,
    selectorKind: 'tail',
    topology: 'final-tail-candidate',
    outcome: 'old',
    inspectorRecovery: true,
  },
  {
    name: 'activation tail before directory fsync',
    faultPoint: FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC,
    selectorKind: 'tail',
    topology: 'new-tail-residue',
    outcome: 'new',
    inspectorRecovery: true,
  },
  {
    name: 'checkpoint before GC',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC,
    topology: 'new-tail-residue',
    outcome: 'new',
    inspectorRecovery: true,
  },
  {
    name: 'checkpoint after event GC entry',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY,
    selectorKind: 'event',
    entryKind: 'event',
    topology: 'new-tail-after-event',
    outcome: 'new',
    inspectorRecovery: true,
  },
  {
    name: 'checkpoint after old-checkpoint GC entry',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY,
    selectorKind: 'old-checkpoint',
    entryKind: 'old-checkpoint',
    fixtureKind: 'repeated',
    topology: 'new-tail-after-old-checkpoint',
    outcome: 'new',
    inspectorRecovery: false,
  },
  {
    name: 'checkpoint before GC directory fsync',
    faultPoint: CHECKPOINT_FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC,
    topology: 'new-tail-clean',
    outcome: 'new',
    inspectorRecovery: false,
  },
];

for (const crashCase of checkpointCrashCases) {
  test(`bounded checkpoint real SIGKILL ${crashCase.name} uniquely converges`, { concurrency: false, timeout: 30_000 }, async (t) => {
    const fixture = crashCase.fixtureKind === 'repeated'
      ? createRepeatedCheckpointCrashFixture(t)
      : createFirstCheckpointCrashFixture(t);
    const faultAction = { crash: true };
    if (crashCase.selectorKind === 'tail') {
      faultAction.whenContextEquals = { operation: 'checkpoint-activation' };
    } else if (crashCase.selectorKind === 'event') {
      const event = fixture.oldEvidence.events[0];
      faultAction.whenContextEquals = {
        entryKind: 'event',
        entryName: `${event.seq}-${event.digest}.json`,
      };
    } else if (crashCase.selectorKind === 'old-checkpoint') {
      faultAction.whenContextEquals = {
        entryKind: 'old-checkpoint',
        entryName: fixture.expectedCheckpoint.previousCheckpoint.checkpointFile,
      };
    }
    const crash = await runUntilCrash({
      script: path.join(__dirname, 'fixtures', 'control-store-crash.js'),
      faults: { [crashCase.faultPoint]: faultAction },
      env: {
        MYTHPEN_CONTROL_STORE_CRASH_DIR: fixture.controlDir,
        MYTHPEN_CONTROL_STORE_CRASH_SCENARIO: 'checkpoint',
        [CHECKPOINT_CRASH_AUTHORITY_ENV]: canonicalJson(fixture.authorityPayload),
      },
      timeoutMs: 20_000,
    });
    t.after(() => crash.cleanup());

    assertCheckpointCrashMarker(crash, crashCase, fixture);
    assertCheckpointCrashTopologyBeforeReopen(crashCase, fixture, crash);
    const root = path.dirname(fixture.controlDir);
    const beforeInspector = snapshotTree(root);
    let inspected;
    const inspectorMutations = withFsMutationLog(() => {
      if (crashCase.inspectorRecovery) {
        assert.throws(
          () => { inspected = controlStoreModule.inspectControlStoreEvidence(fixture.controlDir); },
          { code: 'RECOVERY_REQUIRED' },
        );
      } else {
        inspected = controlStoreModule.inspectControlStoreEvidence(fixture.controlDir);
      }
    });
    assert.deepEqual(inspectorMutations, []);
    assert.deepEqual(snapshotTree(root), beforeInspector);
    if (crashCase.inspectorRecovery) {
      assert.equal(inspected, undefined);
    } else {
      assert.deepEqual(inspected.events, []);
      assert.equal(
        inspected.projection.checkpoint.checkpointDigest,
        fixture.expectedCheckpoint.checkpointDigest,
      );
    }

    const recovered = openControlStore(fixture.controlDir, { bounded: true });
    const evidence = recovered.readEvidence();
    const expectedEvidence = crashCase.outcome === 'old'
      ? fixture.oldEvidence
      : {
          checkpoint: fixture.expectedCheckpoint,
          events: [],
          tail: fixture.expectedTail,
        };
    assert.deepEqual(evidence, expectedEvidence);
    assertCheckpointCrashEvidence(evidence);
    if (crashCase.outcome === 'old') {
      if (fixture.oldCheckpointPath !== null) {
        assert.equal(fs.existsSync(fixture.oldCheckpointPath), true);
      }
      assert.equal(fs.existsSync(fixture.expectedCheckpointPath), false);
      assert.deepEqual(evidence.checkpoint, fixture.oldEvidence.checkpoint);
    } else {
      if (fixture.oldCheckpointPath !== null) {
        assert.equal(fs.existsSync(fixture.oldCheckpointPath), false);
      }
      assert.equal(fs.existsSync(fixture.expectedCheckpointPath), true);
      assert.deepEqual(
        evidence.checkpoint.previousCheckpoint,
        fixture.expectedCheckpoint.previousCheckpoint,
      );
    }
    assert.deepEqual(
      eventFileNames(fixture.controlDir),
      evidence.events.map((event) => `${event.seq}-${event.digest}.json`),
    );
    assert.equal(
      fs.readdirSync(fixture.controlDir).some((name) => (
        CHECKPOINT_CANDIDATE_PATTERN.test(name) || TAIL_CANDIDATE_PATTERN.test(name)
      )),
      false,
    );

    const afterFirstReopen = snapshotTree(root);
    const secondReopen = openControlStore(fixture.controlDir, { bounded: true });
    assert.deepEqual(secondReopen.readEvidence(), evidence);
    assert.deepEqual(snapshotTree(root), afterFirstReopen);

    const receipt = secondReopen.append({
      type: `bounded.checkpoint.after-crash.${crashCase.name.replaceAll(' ', '-')}`,
      payload: { recovered: true, text: '界' },
    });
    assert.equal(receipt.seq, 3);
    assert.equal(receipt.seq, evidence.tail.tailSeq + 1);
    assert.equal(receipt.digest, secondReopen.tail().digest);
    const finalEvidence = secondReopen.readEvidence();
    assertCheckpointCrashEvidence(finalEvidence);
    assert.equal(finalEvidence.events.length, evidence.events.length + 1);
    assert.equal(finalEvidence.events.at(-1).seq, receipt.seq);
    assert.equal(finalEvidence.events.at(-1).digest, receipt.digest);
    assert.equal(finalEvidence.events.at(-1).prevDigest, evidence.tail.tailDigest);
    assert.equal(finalEvidence.tail.checkpointFile, evidence.tail.checkpointFile);
    assert.equal(finalEvidence.tail.checkpointDigest, evidence.tail.checkpointDigest);
    assert.equal(finalEvidence.tail.coveredSeq, evidence.tail.coveredSeq);
    assert.equal(finalEvidence.tail.coveredDigest, evidence.tail.coveredDigest);
  });
}

for (const releaseShape of checkpointReleaseShapes) {
  test(`bounded checkpoint bootstrap release after legal proposal cleanup recovers on ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    const candidatePath = writeCheckpointCandidate(
      fixture.controlDir,
      fixture.checkpoint,
    );
    let directoryFsyncs = 0;
    const runtime = loadCheckpointRuntimeWithReleaseHarness({
      onFsyncDirectory() { directoryFsyncs += 1; },
    });
    const releases = checkpointReleaseFixture(
      'bootstrap proposal cleanup',
      releaseShape,
      { skipFirstLifecycle: true },
    );
    let providerCalls = 0;
    let harness;
    let observed;
    const tailBytes = fs.readFileSync(
      path.join(fixture.controlDir, '.controlstore-tail.json'),
    );
    runtime.arm(releases.failures);
    assert.throws(
      () => {
        harness = runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('bootstrap proposal cleanup must not call provider');
        });
      },
      (error) => {
        observed = error;
        return (
          error?.code === 'RECOVERY_REQUIRED'
          && error.cause === releases.ordered[0]
        );
      },
    );
    runtime.disarm();

    assert.equal(harness, undefined);
    assert.equal(providerCalls, 0);
    assert.equal(directoryFsyncs, 1);
    assert.equal(fs.existsSync(candidatePath), false);
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.controlDir, '.controlstore-tail.json')),
      tailBytes,
    );
    if (releases.ordered.length === 2) {
      assert.deepEqual(observed.secondaryErrors, [releases.ordered[1]]);
    } else {
      assert.equal(observed.secondaryErrors, undefined);
    }
    assert.equal(observed.cleanupError, undefined);

    const reopened = runtime.createHarnessAt(fixture.controlDir, () => {
      providerCalls += 1;
      throw new Error('bootstrap proposal recovery reopen must not call provider');
    });
    assert.equal(providerCalls, 0);
    assert.deepEqual(reopened.controlStore.readEvidence(), fixture.evidence);
  });

  test(`bounded checkpoint bootstrap release after partial GC recovers on ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const fixture = createCheckpointProposalFixture(t);
    activateCheckpointProposal(fixture);
    const coveredEventPaths = fixture.evidence.events.map((event) => (
      path.join(fixture.controlDir, `${event.seq}-${event.digest}.json`)
    ));
    const predecessorPath = path.join(
      fixture.controlDir,
      fixture.previousCheckpointFile,
    );
    const currentFinalPath = path.join(
      fixture.controlDir,
      fixture.checkpointFile,
    );
    const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
    const tailBytes = fs.readFileSync(tailPath);
    const finalBytes = fs.readFileSync(currentFinalPath);
    let directoryFsyncs = 0;
    const runtime = loadCheckpointRuntimeWithReleaseHarness({
      onFsyncDirectory() { directoryFsyncs += 1; },
    });
    const releases = checkpointReleaseFixture(
      'bootstrap partial GC',
      releaseShape,
      { skipFirstLifecycle: true },
    );
    let providerCalls = 0;
    let harness;
    let observed;

    for (const coveredEventPath of coveredEventPaths) {
      assert.equal(fs.existsSync(coveredEventPath), true);
    }
    assert.equal(fs.existsSync(predecessorPath), true);
    runtime.arm(releases.failures);
    assert.throws(
      () => {
        harness = runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('bootstrap partial GC must not call provider');
        });
      },
      (error) => {
        observed = error;
        return (
          error?.code === 'RECOVERY_REQUIRED'
          && error.cause === releases.ordered[0]
        );
      },
    );
    runtime.disarm();

    assert.equal(harness, undefined);
    assert.equal(providerCalls, 0);
    assert.equal(directoryFsyncs, 1);
    for (const coveredEventPath of coveredEventPaths) {
      assert.equal(fs.existsSync(coveredEventPath), false);
    }
    assert.equal(fs.existsSync(predecessorPath), false);
    assert.deepEqual(fs.readFileSync(tailPath), tailBytes);
    assert.deepEqual(fs.readFileSync(currentFinalPath), finalBytes);
    if (releases.ordered.length === 2) {
      assert.deepEqual(observed.secondaryErrors, [releases.ordered[1]]);
    } else {
      assert.equal(observed.secondaryErrors, undefined);
    }
    assert.equal(observed.cleanupError, undefined);

    const reopened = runtime.createHarnessAt(fixture.controlDir, () => {
      providerCalls += 1;
      throw new Error('bootstrap partial GC recovery reopen must not call provider');
    });
    assert.equal(providerCalls, 0);
    assert.deepEqual(reopened.controlStore.readEvidence().checkpoint, fixture.checkpoint);
    assert.deepEqual(reopened.controlStore.readEvidence().events, []);
    assert.deepEqual(eventFileNames(fixture.controlDir), []);
  });

  test(`bounded checkpoint bootstrap release with zero mutation stays IO on ${releaseShape.name} failure`, { concurrency: false }, (t) => {
    const fixture = installCheckpointEvidence(t);
    const runtime = loadCheckpointRuntimeWithReleaseHarness();
    const releases = checkpointReleaseFixture(
      'bootstrap zero mutation',
      releaseShape,
      { skipFirstLifecycle: true },
    );
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    let providerCalls = 0;
    let harness;
    let observed;
    runtime.arm(releases.failures);

    assert.throws(
      () => {
        harness = runtime.createHarnessAt(fixture.controlDir, () => {
          providerCalls += 1;
          throw new Error('zero-mutation bootstrap must not call provider');
        });
      },
      (error) => {
        observed = error;
        return error === releases.ordered[0];
      },
    );
    runtime.disarm();

    assert.equal(harness, undefined);
    assert.equal(providerCalls, 0);
    if (releases.ordered.length === 2) {
      assert.deepEqual(observed.secondaryErrors, [releases.ordered[1]]);
      assert.equal(observed.cleanupError, releases.ordered[1]);
    } else {
      assert.equal(observed.secondaryErrors, undefined);
      assert.equal(observed.cleanupError, undefined);
    }
    assert.deepEqual(snapshotTree(root), before);

    const reopened = runtime.createHarnessAt(fixture.controlDir, () => {
      providerCalls += 1;
      throw new Error('zero-mutation bootstrap reopen must not call provider');
    });
    assert.equal(providerCalls, 0);
    assert.deepEqual(reopened.controlStore.readEvidence().checkpoint, fixture.checkpoint);
  });
}
