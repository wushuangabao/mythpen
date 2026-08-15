const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inspectControlStoreEvidence, openControlStore } = require('../control-store');
const { acquireExclusiveLease } = require('../platform/durability');
const { runUntilCrash } = require('../testing/crash-harness');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');

const BOUNDED_TAIL_BEFORE_PUBLISH = 'controlstore.tail.before-publish';
const BOUNDED_TAIL_BEFORE_DIR_FSYNC = 'controlstore.tail.before-dir-fsync';

function createControlDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-control-store-'));
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

function digestEvent(event) {
  return crypto.createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function eventFiles(controlDir) {
  return fs.readdirSync(controlDir)
    .filter((name) => /^\d+-[0-9a-f]{64}\.json$/.test(name))
    .sort();
}

function controlTempFiles(controlDir) {
  return fs.readdirSync(controlDir).filter(
    (name) => name.startsWith('.controlstore-') && name.endsWith('.tmp'),
  );
}

function readEventFile(controlDir, name) {
  return JSON.parse(fs.readFileSync(path.join(controlDir, name), 'utf8'));
}

function writeEventFile(controlDir, event) {
  const eventWithoutDigest = { ...event };
  delete eventWithoutDigest.digest;
  const digest = digestEvent(eventWithoutDigest);
  const completeEvent = { ...eventWithoutDigest, digest };
  const name = `${completeEvent.seq}-${digest}.json`;
  fs.writeFileSync(path.join(controlDir, name), canonicalJson(completeEvent));
  return name;
}

function writeEventCandidate(controlDir, event, serialize = canonicalJson) {
  const eventWithoutDigest = { ...event };
  delete eventWithoutDigest.digest;
  const completeEvent = {
    ...eventWithoutDigest,
    digest: digestEvent(eventWithoutDigest),
  };
  const candidatePath = path.join(
    controlDir,
    `.controlstore-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(candidatePath, serialize(completeEvent));
  return { candidatePath, event: completeEvent };
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

function digestRecord(record, digestKey) {
  const withoutDigest = { ...record };
  delete withoutDigest[digestKey];
  return crypto.createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex');
}

function writeTailRecord(controlDir, input) {
  const record = { ...input };
  record.recordDigest = digestRecord(record, 'recordDigest');
  fs.writeFileSync(
    path.join(controlDir, '.controlstore-tail.json'),
    canonicalJson(record),
  );
  return record;
}

function materializeTailRecord(input) {
  const withoutDigest = { ...input };
  delete withoutDigest.recordDigest;
  return {
    ...withoutDigest,
    recordDigest: digestRecord(withoutDigest, 'recordDigest'),
  };
}

function writeTailCandidate(controlDir, input) {
  const record = materializeTailRecord(input);
  const candidatePath = path.join(
    controlDir,
    `.controlstore-tail-${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(candidatePath, canonicalJson(record));
  return { candidatePath, record };
}

function tailAfterSuccessor(tail, successor) {
  return materializeTailRecord({
    ...tail,
    tailSeq: successor.seq,
    tailDigest: successor.digest,
    activeEventCount: tail.activeEventCount + 1,
    activeEventBytes: tail.activeEventBytes
      + Buffer.byteLength(canonicalJson(successor), 'utf8'),
  });
}

function installEmptyTail(controlDir, incarnationId, overrides = {}) {
  return writeTailRecord(controlDir, {
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId,
    checkpointFile: null,
    checkpointDigest: null,
    coveredSeq: 0,
    coveredDigest: null,
    tailSeq: 0,
    tailDigest: null,
    activeEventCount: 0,
    activeEventBytes: 0,
    ...overrides,
  });
}

function readPersistentTail(controlDir) {
  return JSON.parse(
    fs.readFileSync(path.join(controlDir, '.controlstore-tail.json'), 'utf8'),
  );
}

function writeOfficialSuccessor(controlDir, tail, overrides = {}) {
  const name = writeEventFile(controlDir, {
    seq: tail.tailSeq + 1,
    type: 'bounded.reconcile.successor',
    payload: { version: 1 },
    prevDigest: tail.tailDigest,
    ...overrides,
  });
  return readEventFile(controlDir, name);
}

function epochFilterBytes(basisDigest, epoch) {
  const bytes = Buffer.alloc(1_048_576);
  const domain = Buffer.from('mythpen-controlstore-connection-epoch-v1\0', 'utf8');
  const basis = Buffer.from(basisDigest, 'hex');
  const normalizedEpoch = Buffer.from(epoch.toLowerCase(), 'ascii');
  for (let index = 0; index < 7; index += 1) {
    const digest = crypto.createHash('sha256').update(Buffer.concat([
      domain,
      Buffer.from([index]),
      basis,
      normalizedEpoch,
    ])).digest();
    const bit = (((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 1);
    bytes[bit >>> 3] |= 1 << (bit & 7);
  }
  return bytes;
}

function installCheckpointOnlyEvidence(t) {
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
  const [genesis] = legacy.read();
  const filterBytes = epochFilterBytes(genesis.digest, payload.connectionEpoch);
  const checkpointWithoutDigest = {
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId: legacy.incarnationId,
    admissionBasis: {
      basisKind: 'stage_b_fixture_genesis',
      basisDigest: genesis.digest,
      admissionEvent: genesis,
    },
    coveredSeq: 1,
    coveredDigest: genesis.digest,
    chainRoot: { seq: 1, digest: genesis.digest },
    previousCheckpoint: null,
    dbKey: payload.dbKey,
    schema: 11,
    backend: 'native-sqlite-v2',
    finalSeq: 0,
    triggerVersion: 1,
    triggerSetDigest: payload.triggerSetDigest,
    projectInstanceIdSha256: payload.projectInstanceIdSha256,
    identity: payload.identity,
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
  fs.writeFileSync(path.join(controlDir, checkpointFile), canonicalJson(checkpoint));
  const tail = writeTailRecord(controlDir, {
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId: legacy.incarnationId,
    checkpointFile,
    checkpointDigest,
    coveredSeq: 1,
    coveredDigest: genesis.digest,
    tailSeq: 1,
    tailDigest: genesis.digest,
    activeEventCount: 0,
    activeEventBytes: 0,
  });
  fs.rmSync(path.join(controlDir, eventFiles(controlDir)[0]));
  return { checkpoint, checkpointFile, controlDir, genesis, tail };
}

function rewriteCheckpointOnlyEvidence(fixture, mutate) {
  const withoutDigest = JSON.parse(canonicalJson(fixture.checkpoint));
  delete withoutDigest.checkpointDigest;
  mutate(withoutDigest);
  const checkpoint = {
    ...withoutDigest,
    checkpointDigest: digestRecord(withoutDigest, 'checkpointDigest'),
  };
  const checkpointFile = `.controlstore-checkpoint-${checkpoint.coveredSeq}-${checkpoint.checkpointDigest}.json`;
  fs.rmSync(path.join(fixture.controlDir, fixture.checkpointFile));
  fs.writeFileSync(
    path.join(fixture.controlDir, checkpointFile),
    canonicalJson(checkpoint),
  );
  const tail = writeTailRecord(fixture.controlDir, {
    ...fixture.tail,
    checkpointFile,
    checkpointDigest: checkpoint.checkpointDigest,
  });
  return { ...fixture, checkpoint, checkpointFile, tail };
}

function installRepeatedCheckpointOnlyEvidence(t, options = {}) {
  const { keepPrevious = true, mutateDescriptor = (descriptor) => descriptor } = options;
  const previous = installCheckpointOnlyEvidence(t);
  const previousBytes = fs.readFileSync(
    path.join(previous.controlDir, previous.checkpointFile),
  );
  const previousCheckpoint = mutateDescriptor({
    checkpointFile: previous.checkpointFile,
    checkpointDigest: previous.checkpoint.checkpointDigest,
    coveredSeq: previous.checkpoint.coveredSeq,
    coveredDigest: previous.checkpoint.coveredDigest,
  });
  const coveredDigest = 'e'.repeat(64);
  const checkpointWithoutDigest = {
    ...previous.checkpoint,
    coveredSeq: 2,
    coveredDigest,
    previousCheckpoint,
    finalSeq: 1,
    latestCleanBasisDigest: coveredDigest,
    eventTypeCounts: {
      'sqlite.native.stage_b.fixture_genesis': 1,
      'sqlite.tx.committed': 1,
    },
  };
  delete checkpointWithoutDigest.checkpointDigest;
  const checkpointDigest = digestRecord(checkpointWithoutDigest, 'checkpointDigest');
  const checkpoint = { ...checkpointWithoutDigest, checkpointDigest };
  const checkpointFile = `.controlstore-checkpoint-2-${checkpointDigest}.json`;
  fs.writeFileSync(
    path.join(previous.controlDir, checkpointFile),
    canonicalJson(checkpoint),
  );
  if (!keepPrevious) {
    fs.rmSync(path.join(previous.controlDir, previous.checkpointFile));
  } else {
    assert.deepEqual(
      fs.readFileSync(path.join(previous.controlDir, previous.checkpointFile)),
      previousBytes,
    );
  }
  const tail = writeTailRecord(previous.controlDir, {
    ...previous.tail,
    checkpointFile,
    checkpointDigest,
    coveredSeq: 2,
    coveredDigest,
    tailSeq: 2,
    tailDigest: coveredDigest,
    activeEventCount: 0,
    activeEventBytes: 0,
  });
  return {
    checkpoint,
    checkpointFile,
    controlDir: previous.controlDir,
    previousCheckpoint,
    previousCheckpointFile: previous.checkpointFile,
    tail,
  };
}

function withFsMutationLog(callback) {
  const methods = ['mkdirSync', 'writeFileSync', 'rmSync', 'unlinkSync', 'renameSync', 'linkSync'];
  const originals = new Map();
  const calls = [];
  for (const method of methods) {
    originals.set(method, fs[method]);
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

function installTailPostcheckReadFailure(controlDir, predicate = () => true) {
  const originalReadFileSync = fs.readFileSync;
  const failure = Object.assign(new Error('installed tail postcheck read failed'), { code: 'EIO' });
  let armed = false;
  let injected = false;
  fs.readFileSync = (target, ...args) => {
    const result = originalReadFileSync(target, ...args);
    if (
      armed
      && !injected
      && path.resolve(String(target)) === path.resolve(controlDir, '.controlstore-tail.json')
      && predicate(result)
    ) {
      injected = true;
      throw failure;
    }
    return result;
  };
  return {
    arm() { armed = true; },
    get failure() { return failure; },
    get injected() { return injected; },
    restore() { fs.readFileSync = originalReadFileSync; },
  };
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

function loadControlStoreWithLeaseReleaseHarness() {
  const controlStorePath = require.resolve('../control-store');
  const durabilityPath = require.resolve('../platform/durability');
  const cachedControlStore = require.cache[controlStorePath];
  const durability = require(durabilityPath);
  const originalAcquireExclusiveLease = durability.acquireExclusiveLease;
  const state = {
    armed: false,
    counts: { lifecycle: 0, writer: 0 },
    failures: { lifecycle: [], writer: [] },
  };

  durability.acquireExclusiveLease = (lockPath) => {
    const lease = originalAcquireExclusiveLease(lockPath);
    const kind = path.basename(String(lockPath)) === '.controlstore-writer.lock'
      ? 'writer'
      : 'lifecycle';
    return {
      isHeld: () => lease.isHeld(),
      release() {
        const result = lease.release();
        if (state.armed) {
          const index = state.counts[kind];
          state.counts[kind] += 1;
          const failure = state.failures[kind][index];
          if (failure) throw failure;
        }
        return result;
      },
    };
  };

  delete require.cache[controlStorePath];
  let fresh;
  try {
    fresh = require(controlStorePath);
  } finally {
    durability.acquireExclusiveLease = originalAcquireExclusiveLease;
    delete require.cache[controlStorePath];
    if (cachedControlStore) require.cache[controlStorePath] = cachedControlStore;
  }

  return {
    openControlStore: fresh.openControlStore,
    arm(failures) {
      state.armed = true;
      state.counts = { lifecycle: 0, writer: 0 };
      state.failures = {
        lifecycle: failures.lifecycle || [],
        writer: failures.writer || [],
      };
    },
    disarm() {
      state.armed = false;
    },
  };
}

function loadControlStoreWithDirectoryFsyncObserver(observer) {
  const controlStorePath = require.resolve('../control-store');
  const durabilityPath = require.resolve('../platform/durability');
  const cachedControlStore = require.cache[controlStorePath];
  const durability = require(durabilityPath);
  const originalFsyncDirectory = durability.fsyncDirectory;

  durability.fsyncDirectory = (directory) => {
    const result = originalFsyncDirectory(directory);
    observer(path.resolve(String(directory)));
    return result;
  };
  delete require.cache[controlStorePath];
  let fresh;
  try {
    fresh = require(controlStorePath);
  } finally {
    durability.fsyncDirectory = originalFsyncDirectory;
    delete require.cache[controlStorePath];
    if (cachedControlStore) require.cache[controlStorePath] = cachedControlStore;
  }
  return fresh.openControlStore;
}

function assertReleaseRecovery(error, primaryReleaseError, secondaryReleaseError) {
  assert.equal(error.code, 'RECOVERY_REQUIRED');
  assert.equal(error.cause, primaryReleaseError);
  if (secondaryReleaseError) {
    assert.equal(error.secondaryErrors?.length, 1);
    assert.equal(error.secondaryErrors[0], secondaryReleaseError);
  }
  return true;
}

function waitForChildLine(child, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}; output=${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Child exited before barrier: code=${code} signal=${signal} output=${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

function collectChild(child, prefix = '') {
  return new Promise((resolve, reject) => {
    let stdout = prefix;
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

test('omitted options and exact bounded false preserve the legacy facade and bytes', (t) => {
  const controlDir = createControlDir(t);
  const omitted = openControlStore(controlDir);
  omitted.append({ type: 'legacy.seed', payload: { value: 1 } });
  const expectedKeys = [
    'append',
    'assertCurrent',
    'compareAndAppend',
    'directory',
    'incarnationId',
    'lifecycleLeasePath',
    'read',
    'retire',
    'retireAndActivate',
    'tail',
  ];
  const before = snapshotTree(path.dirname(controlDir));

  const explicitFalse = openControlStore(controlDir, { bounded: false });

  assert.deepEqual(Object.keys(omitted).sort(), expectedKeys);
  assert.deepEqual(Object.keys(explicitFalse).sort(), expectedKeys);
  assert.deepEqual(explicitFalse.read(), omitted.read());
  assert.deepEqual(explicitFalse.tail(), omitted.tail());
  assert.equal(fs.existsSync(path.join(controlDir, '.controlstore-tail.json')), false);
  assert.deepEqual(snapshotTree(path.dirname(controlDir)), before);
  assert.equal(openControlStore.length, 1);
});

for (const optionCase of [
  { name: 'empty object', create: () => ({}) },
  { name: 'null', create: () => null },
  { name: 'array', create: () => [{ bounded: true }] },
  { name: 'nonboolean bounded', create: () => ({ bounded: 'true' }) },
  { name: 'extra key', create: () => ({ bounded: true, extra: false }) },
  { name: 'inherited bounded', create: () => Object.create({ bounded: true }) },
  {
    name: 'accessor bounded',
    create(onGetter) {
      const options = {};
      Object.defineProperty(options, 'bounded', {
        enumerable: true,
        get() {
          onGetter();
          return true;
        },
      });
      return options;
    },
  },
]) {
  test(`openControlStore rejects ${optionCase.name} options synchronously and zero-write`, (t) => {
    const controlDir = createControlDir(t);
    openControlStore(controlDir).append({ type: 'legacy.seed', payload: {} });
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);
    let getterCalls = 0;
    const options = optionCase.create(() => { getterCalls += 1; });

    const calls = withFsMutationLog(() => {
      assert.throws(
        () => openControlStore(controlDir, options),
        (error) => error instanceof TypeError && error.code === 'CONTROL_STORE_INVALID_OPTIONS',
      );
    });

    assert.equal(getterCalls, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(snapshotTree(root), before);
  });
}

test('exact bounded true bootstraps one persistent empty tail and exposes exact evidence APIs', (t) => {
  const controlDir = createControlDir(t);
  const bounded = openControlStore(controlDir, { bounded: true });
  const tailPath = path.join(controlDir, '.controlstore-tail.json');

  assert.deepEqual(Object.keys(bounded).sort(), [
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
  ]);
  assert.equal(fs.existsSync(tailPath), true);
  const persistentTail = JSON.parse(fs.readFileSync(tailPath, 'utf8'));
  assert.deepEqual(persistentTail, {
    version: 1,
    recordDigest: persistentTail.recordDigest,
    controlProtocolEpoch: 2,
    incarnationId: bounded.incarnationId,
    checkpointFile: null,
    checkpointDigest: null,
    coveredSeq: 0,
    coveredDigest: null,
    tailSeq: 0,
    tailDigest: null,
    activeEventCount: 0,
    activeEventBytes: 0,
  });
  assert.equal(digestRecord(persistentTail, 'recordDigest'), persistentTail.recordDigest);
  assert.equal(bounded.tail(), null);
  assert.deepEqual(bounded.read(), []);
  const evidence = bounded.readEvidence();
  assert.deepEqual(evidence, { checkpoint: null, events: [], tail: persistentTail });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.events), true);
  assert.equal(Object.isFrozen(evidence.tail), true);
  assert.deepEqual(inspectControlStoreEvidence(controlDir), {
    events: [],
    projection: {
      incarnationId: bounded.incarnationId,
      tail: null,
      checkpoint: null,
      events: [],
    },
  });
});

for (const metadataCase of [
  {
    name: 'tail final',
    prepare(t) {
      const controlDir = createControlDir(t);
      const legacy = openControlStore(controlDir);
      installEmptyTail(controlDir, legacy.incarnationId);
      return controlDir;
    },
  },
  {
    name: 'tail candidate',
    prepare(t) {
      const controlDir = createControlDir(t);
      const legacy = openControlStore(controlDir);
      installEmptyTail(controlDir, legacy.incarnationId);
      fs.renameSync(
        path.join(controlDir, '.controlstore-tail.json'),
        path.join(controlDir, `.controlstore-tail-${crypto.randomUUID()}.tmp`),
      );
      return controlDir;
    },
  },
  {
    name: 'checkpoint final',
    prepare(t) {
      const fixture = installCheckpointOnlyEvidence(t);
      fs.rmSync(path.join(fixture.controlDir, '.controlstore-tail.json'));
      return fixture.controlDir;
    },
  },
  {
    name: 'checkpoint candidate',
    prepare(t) {
      const fixture = installCheckpointOnlyEvidence(t);
      fs.rmSync(path.join(fixture.controlDir, '.controlstore-tail.json'));
      fs.renameSync(
        path.join(fixture.controlDir, fixture.checkpointFile),
        path.join(
          fixture.controlDir,
          `.controlstore-checkpoint-1-${crypto.randomUUID()}.tmp`,
        ),
      );
      return fixture.controlDir;
    },
  },
]) {
  test(`default writer classifies ${metadataCase.name} before every filesystem mutation`, (t) => {
    const controlDir = metadataCase.prepare(t);
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);

    const calls = withFsMutationLog(() => {
      assert.throws(
        () => openControlStore(controlDir),
        { code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED' },
      );
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(snapshotTree(root), before);
  });
}

for (const staleClassificationCase of [
  { name: 'omitted default', options: undefined, expectedUnsupported: true },
  { name: 'exact bounded false', options: { bounded: false }, expectedUnsupported: true },
  { name: 'bounded writer', options: { bounded: true }, expectedUnsupported: false },
]) {
  test(`${staleClassificationCase.name} reclassifies bounded metadata inside the lifecycle lease`, (t) => {
    const controlDir = createControlDir(t);
    openControlStore(controlDir);
    const root = path.dirname(controlDir);
    let afterNested = false;
    const syncCalls = [];
    const raceOpen = loadControlStoreWithDirectoryFsyncObserver((directory) => {
      if (afterNested) syncCalls.push(directory);
    });
    const originalReaddirSync = fs.readdirSync;
    let injecting = false;
    let injected = false;
    let nested = null;
    let nestedSnapshot = null;

    fs.readdirSync = (target, ...args) => {
      const staleNames = originalReaddirSync(target, ...args);
      if (
        !injected
        && !injecting
        && path.resolve(String(target)) === path.resolve(controlDir)
      ) {
        injected = true;
        injecting = true;
        try {
          nested = raceOpen(controlDir, { bounded: true });
          const activeName = originalReaddirSync(root).find(
            (name) => /^\.controlstore-[0-9a-f]{64}\.active\.json$/.test(name),
          );
          nestedSnapshot = {
            activeBytes: fs.readFileSync(path.join(root, activeName)),
            incarnationBytes: fs.readFileSync(
              path.join(controlDir, '.controlstore-incarnation.json'),
            ),
            tailBytes: fs.readFileSync(path.join(controlDir, '.controlstore-tail.json')),
            tree: snapshotTree(root),
          };
          afterNested = true;
        } finally {
          injecting = false;
        }
        return staleNames;
      }
      return staleNames;
    };

    let outer = null;
    try {
      const openOuter = () => {
        outer = staleClassificationCase.options === undefined
          ? raceOpen(controlDir)
          : raceOpen(controlDir, staleClassificationCase.options);
      };
      if (staleClassificationCase.expectedUnsupported) {
        assert.throws(openOuter, { code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED' });
      } else {
        openOuter();
      }
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    assert.equal(injected, true);
    assert.ok(nested);
    assert.deepEqual(syncCalls, []);
    assert.deepEqual(snapshotTree(root), nestedSnapshot.tree);
    assert.deepEqual(
      fs.readFileSync(path.join(controlDir, '.controlstore-incarnation.json')),
      nestedSnapshot.incarnationBytes,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(controlDir, '.controlstore-tail.json')),
      nestedSnapshot.tailBytes,
    );
    const activeName = originalReaddirSync(root).find(
      (name) => /^\.controlstore-[0-9a-f]{64}\.active\.json$/.test(name),
    );
    assert.deepEqual(fs.readFileSync(path.join(root, activeName)), nestedSnapshot.activeBytes);
    if (staleClassificationCase.expectedUnsupported) {
      assert.equal(outer, null);
    } else {
      assert.equal(outer.incarnationId, nested.incarnationId);
      assert.deepEqual(outer.readEvidence(), nested.readEvidence());
    }
  });
}

test('legacy production event temp remains pure-v1 and readable', (t) => {
  const controlDir = createControlDir(t);
  const legacy = openControlStore(controlDir);
  legacy.append({ type: 'legacy.seed', payload: {} });
  fs.writeFileSync(
    path.join(controlDir, `.controlstore-4321-${crypto.randomUUID()}.tmp`),
    '{partial',
  );
  const before = snapshotTree(path.dirname(controlDir));

  const reopened = openControlStore(controlDir);

  assert.equal(reopened.read().length, 1);
  assert.deepEqual(snapshotTree(path.dirname(controlDir)), before);
});

test('legacy read and inspector remain byte-identical and never create bounded metadata', (t) => {
  const controlDir = createControlDir(t);
  const legacy = openControlStore(controlDir, { bounded: false });
  legacy.append({ type: 'legacy.seed', payload: { value: 1 } });
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);

  const reopened = openControlStore(controlDir);
  assert.equal(reopened.read().length, 1);
  assert.equal(inspectControlStoreEvidence(controlDir).events.length, 1);

  assert.deepEqual(snapshotTree(root), before);
  assert.equal(fs.readdirSync(controlDir).some((name) => (
    name === '.controlstore-tail.json' || name.startsWith('.controlstore-checkpoint-')
  )), false);
});

test('bounded reader authenticates checkpoint-only evidence after covered event GC', (t) => {
  const fixture = installCheckpointOnlyEvidence(t);
  assert.equal(
    fixture.checkpoint.connectionEpochFilter.bitsBase64,
    epochFilterBytes(
      fixture.genesis.digest,
      fixture.genesis.payload.connectionEpoch,
    ).toString('base64'),
  );
  assert.ok(fixture.checkpoint.connectionEpochFilter.epochObservationCount >= 1);
  const bounded = openControlStore(fixture.controlDir, { bounded: true });

  assert.deepEqual(bounded.read(), []);
  assert.deepEqual(bounded.tail(), { seq: 1, digest: fixture.genesis.digest });
  assert.equal(Object.isFrozen(bounded.tail()), true);
  const evidence = bounded.readEvidence();
  assert.deepEqual(evidence, {
    checkpoint: fixture.checkpoint,
    events: [],
    tail: fixture.tail,
  });
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.checkpoint), true);
  assert.equal(Object.isFrozen(evidence.events), true);
  assert.equal(Object.isFrozen(evidence.tail), true);
  assert.deepEqual(inspectControlStoreEvidence(fixture.controlDir), {
    events: [],
    projection: {
      incarnationId: fixture.tail.incarnationId,
      tail: { seq: 1, digest: fixture.genesis.digest },
      checkpoint: {
        checkpointDigest: fixture.checkpoint.checkpointDigest,
        coveredSeq: 1,
        coveredDigest: fixture.genesis.digest,
        chainRoot: { seq: 1, digest: fixture.genesis.digest },
        latestCleanBasisDigest: fixture.genesis.digest,
      },
      events: [],
    },
  });
});

test('bounded checkpoint accepts exact null previousCheckpoint', (t) => {
  const fixture = installCheckpointOnlyEvidence(t);

  const evidence = openControlStore(fixture.controlDir, { bounded: true }).readEvidence();

  assert.equal(evidence.checkpoint.previousCheckpoint, null);
  assert.deepEqual(evidence.checkpoint, fixture.checkpoint);
  assert.deepEqual(evidence.tail, fixture.tail);
});

test('bounded checkpoint rejects a missing top-level previousCheckpoint key', (t) => {
  const fixture = rewriteCheckpointOnlyEvidence(
    installCheckpointOnlyEvidence(t),
    (checkpoint) => {
      delete checkpoint.previousCheckpoint;
    },
  );
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);

  assert.throws(
    () => openControlStore(fixture.controlDir, { bounded: true }).readEvidence(),
    { code: 'CONTROL_STORE_CORRUPT' },
  );
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded checkpoint accepts an exact previousCheckpoint descriptor', (t) => {
  const fixture = installRepeatedCheckpointOnlyEvidence(t);

  const evidence = openControlStore(fixture.controlDir, { bounded: true }).readEvidence();

  assert.deepEqual(evidence.checkpoint.previousCheckpoint, fixture.previousCheckpoint);
  assert.deepEqual(evidence.checkpoint, fixture.checkpoint);
});

test('bounded checkpoint accepts previousCheckpoint after its descriptor target is absent', (t) => {
  const fixture = installRepeatedCheckpointOnlyEvidence(t, { keepPrevious: false });
  assert.equal(
    fs.existsSync(path.join(fixture.controlDir, fixture.previousCheckpointFile)),
    false,
  );

  const evidence = openControlStore(fixture.controlDir, { bounded: true }).readEvidence();

  assert.deepEqual(evidence.checkpoint.previousCheckpoint, fixture.previousCheckpoint);
  assert.deepEqual(evidence.checkpoint, fixture.checkpoint);
});

for (const previousCheckpointCase of [
  {
    name: 'missing key',
    mutate(descriptor) {
      const { coveredDigest: _coveredDigest, ...missing } = descriptor;
      return missing;
    },
  },
  {
    name: 'extra key',
    mutate(descriptor) {
      return { ...descriptor, extra: true };
    },
  },
  {
    name: 'wrong type',
    mutate() {
      return 'not-a-checkpoint-descriptor';
    },
  },
  {
    name: 'filename sequence mismatch',
    mutate(descriptor) {
      return {
        ...descriptor,
        checkpointFile: `.controlstore-checkpoint-2-${descriptor.checkpointDigest}.json`,
      };
    },
  },
  {
    name: 'filename digest mismatch',
    mutate(descriptor) {
      return {
        ...descriptor,
        checkpointFile: `.controlstore-checkpoint-${descriptor.coveredSeq}-${'f'.repeat(64)}.json`,
      };
    },
  },
  {
    name: 'nonpositive covered sequence',
    mutate(descriptor) {
      return {
        ...descriptor,
        checkpointFile: `.controlstore-checkpoint-0-${descriptor.checkpointDigest}.json`,
        coveredSeq: 0,
      };
    },
  },
  {
    name: 'unsafe covered sequence',
    mutate(descriptor) {
      const coveredSeq = Number.MAX_SAFE_INTEGER + 1;
      return {
        ...descriptor,
        checkpointFile: `.controlstore-checkpoint-${coveredSeq}-${descriptor.checkpointDigest}.json`,
        coveredSeq,
      };
    },
  },
  {
    name: 'malformed checkpoint digest',
    mutate(descriptor) {
      return {
        ...descriptor,
        checkpointFile: `.controlstore-checkpoint-${descriptor.coveredSeq}-not-a-digest.json`,
        checkpointDigest: 'not-a-digest',
      };
    },
  },
  {
    name: 'malformed covered digest',
    mutate(descriptor) {
      return { ...descriptor, coveredDigest: 'not-a-digest' };
    },
  },
  {
    name: 'covered sequence equals current checkpoint',
    mutate(descriptor) {
      return {
        ...descriptor,
        checkpointFile: `.controlstore-checkpoint-2-${descriptor.checkpointDigest}.json`,
        coveredSeq: 2,
      };
    },
  },
  {
    name: 'covered sequence exceeds current checkpoint',
    mutate(descriptor) {
      return {
        ...descriptor,
        checkpointFile: `.controlstore-checkpoint-3-${descriptor.checkpointDigest}.json`,
        coveredSeq: 3,
      };
    },
  },
]) {
  test(`bounded checkpoint rejects previousCheckpoint ${previousCheckpointCase.name}`, (t) => {
    const fixture = installRepeatedCheckpointOnlyEvidence(t, {
      keepPrevious: false,
      mutateDescriptor: previousCheckpointCase.mutate,
    });
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);

    assert.throws(
      () => openControlStore(fixture.controlDir, { bounded: true }).readEvidence(),
      { code: 'CONTROL_STORE_CORRUPT' },
    );
    assert.deepEqual(snapshotTree(root), before);
  });
}

test('bounded checkpoint rejects every provable genesis epoch Bloom false negative', (t) => {
  for (const filterCase of [
    {
      name: 'all-zero-count-zero',
      mutate(filter) {
        return {
          ...filter,
          bitsBase64: Buffer.alloc(1_048_576).toString('base64'),
          epochObservationCount: 0,
        };
      },
    },
    {
      name: 'one-missing-bit',
      mutate(filter) {
        const bytes = Buffer.from(filter.bitsBase64, 'base64');
        const byteIndex = bytes.findIndex((byte) => byte !== 0);
        assert.notEqual(byteIndex, -1);
        const lowestSetBit = bytes[byteIndex] & -bytes[byteIndex];
        bytes[byteIndex] &= ~lowestSetBit;
        return { ...filter, bitsBase64: bytes.toString('base64') };
      },
    },
  ]) {
    const fixture = rewriteCheckpointOnlyEvidence(
      installCheckpointOnlyEvidence(t),
      (checkpoint) => {
        checkpoint.connectionEpochFilter = filterCase.mutate(
          checkpoint.connectionEpochFilter,
        );
      },
    );
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);
    assert.throws(
      () => openControlStore(fixture.controlDir, { bounded: true }).readEvidence(),
      { code: 'CONTROL_STORE_CORRUPT' },
      filterCase.name,
    );
    assert.deepEqual(snapshotTree(root), before, filterCase.name);
  }
});

for (const parserCase of [
  {
    name: 'tail extra key',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    mutate(fixture) {
      writeTailRecord(fixture.controlDir, { ...fixture.tail, unexpected: true });
    },
  },
  {
    name: 'tail digest mismatch',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    mutate(fixture) {
      fs.writeFileSync(
        path.join(fixture.controlDir, '.controlstore-tail.json'),
        canonicalJson({ ...fixture.tail, recordDigest: '0'.repeat(64) }),
      );
    },
  },
  {
    name: 'missing referenced checkpoint',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    mutate(fixture) {
      fs.rmSync(path.join(fixture.controlDir, fixture.checkpointFile));
    },
  },
  {
    name: 'lower protocol epoch',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    mutate(fixture) {
      writeTailRecord(fixture.controlDir, { ...fixture.tail, controlProtocolEpoch: 1 });
    },
  },
  {
    name: 'higher protocol epoch',
    expectedCode: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED',
    mutate(fixture) {
      writeTailRecord(fixture.controlDir, { ...fixture.tail, controlProtocolEpoch: 3 });
    },
  },
]) {
  test(`bounded exact parser rejects ${parserCase.name} with stable precedence`, (t) => {
    const fixture = installCheckpointOnlyEvidence(t);
    parserCase.mutate(fixture);

    assert.throws(
      () => openControlStore(fixture.controlDir, { bounded: true }).readEvidence(),
      { code: parserCase.expectedCode },
    );
  });
}

for (const higherCheckpointCase of [
  {
    name: 'otherwise exact higher checkpoint epoch',
    expectedCode: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED',
    mutate(checkpoint) { return checkpoint; },
  },
  {
    name: 'higher checkpoint epoch with malformed fixed nested field',
    expectedCode: 'CONTROL_STORE_CORRUPT',
    mutate(checkpoint) {
      return {
        ...checkpoint,
        connectionEpochFilter: {
          ...checkpoint.connectionEpochFilter,
          hashCount: 8,
        },
      };
    },
  },
]) {
  test(`bounded parser classifies ${higherCheckpointCase.name} after mechanical validation`, (t) => {
    const fixture = installCheckpointOnlyEvidence(t);
    const withoutDigest = higherCheckpointCase.mutate({
      ...fixture.checkpoint,
      controlProtocolEpoch: 3,
    });
    delete withoutDigest.checkpointDigest;
    const checkpoint = {
      ...withoutDigest,
      checkpointDigest: digestRecord(withoutDigest, 'checkpointDigest'),
    };
    const checkpointFile = `.controlstore-checkpoint-${checkpoint.coveredSeq}-${checkpoint.checkpointDigest}.json`;
    fs.rmSync(path.join(fixture.controlDir, fixture.checkpointFile));
    fs.writeFileSync(
      path.join(fixture.controlDir, checkpointFile),
      canonicalJson(checkpoint),
    );
    writeTailRecord(fixture.controlDir, {
      ...fixture.tail,
      checkpointFile,
      checkpointDigest: checkpoint.checkpointDigest,
    });

    assert.throws(
      () => openControlStore(fixture.controlDir, { bounded: true }).readEvidence(),
      { code: higherCheckpointCase.expectedCode },
    );
  });
}

test('bounded retirement methods reject before lease, filesystem, replay, or validator work', (t) => {
  const controlDir = createControlDir(t);
  const legacy = openControlStore(controlDir);
  installEmptyTail(controlDir, legacy.incarnationId);
  const bounded = openControlStore(controlDir, { bounded: true });
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);
  const held = acquireExclusiveLease(bounded.lifecycleLeasePath);
  let validatorCalls = 0;
  const validator = () => {
    validatorCalls += 1;
    throw new Error('validator must not run');
  };
  const destinations = [
    path.join(root, `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`),
    path.join(root, `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`),
  ];

  try {
    assert.throws(
      () => bounded.retire(destinations[0], validator),
      { code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED' },
    );
    assert.throws(
      () => bounded.retireAndActivate(destinations[1], validator),
      { code: 'CONTROL_STORE_PROTOCOL_UNSUPPORTED' },
    );
  } finally {
    held.release();
  }
  assert.equal(validatorCalls, 0);
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded append and CAS reread persistent tail across facades and count canonical UTF-8 bytes', (t) => {
  const controlDir = createControlDir(t);
  const firstFacade = openControlStore(controlDir, { bounded: true });
  const secondFacade = openControlStore(controlDir, { bounded: true });

  const first = firstFacade.append({
    type: '章节.写入',
    payload: { emoji: '🌙', title: '长夜', nested: { z: 2, a: 1 } },
  });
  const second = secondFacade.compareAndAppend(first.digest, {
    type: 'second.facade',
    payload: { value: 2 },
  });
  assert.throws(
    () => firstFacade.compareAndAppend(first.digest, {
      type: 'stale.cached.tail',
      payload: {},
    }),
    { code: 'CONTROL_STORE_CAS_FAILED' },
  );
  const third = firstFacade.append({ type: 'first.facade.again', payload: { value: 3 } });

  const events = secondFacade.read();
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.deepEqual(events.map((event) => event.digest), [first.digest, second.digest, third.digest]);
  const persistentTail = JSON.parse(
    fs.readFileSync(path.join(controlDir, '.controlstore-tail.json'), 'utf8'),
  );
  assert.equal(persistentTail.activeEventCount, 3);
  assert.equal(
    persistentTail.activeEventBytes,
    events.reduce(
      (total, event) => total + Buffer.byteLength(canonicalJson(event), 'utf8'),
      0,
    ),
  );
  assert.equal(persistentTail.tailSeq, 3);
  assert.equal(persistentTail.tailDigest, third.digest);
  assert.equal(digestRecord(persistentTail, 'recordDigest'), persistentTail.recordDigest);
});

test('bounded event prepublish failure cleans exactly, returns IO, and leaves facade usable', async (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir, { bounded: true });
  const before = store.readEvidence();

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => store.append({ type: 'prepublish.failure', payload: {} }),
      { code: 'CONTROL_STORE_IO' },
    );
  });

  assert.deepEqual(store.readEvidence(), before);
  assert.deepEqual(controlTempFiles(controlDir), []);
  assert.deepEqual(eventFiles(controlDir), []);
  assert.equal(store.append({ type: 'after-clean-failure', payload: {} }).seq, 1);
});

test('bounded event postpublish uncertainty returns recovery and fences every facade method', async (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir, { bounded: true });
  let receipt = null;

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => { receipt = store.append({ type: 'postpublish.failure', payload: {} }); },
      { code: 'RECOVERY_REQUIRED' },
    );
  });

  assert.equal(receipt, null);
  assert.equal(eventFiles(controlDir).length, 1);
  assertBoundedFacadeFenced(store);
});

test('bounded tail fault points are frozen at their exact public names', () => {
  assert.equal(FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH, BOUNDED_TAIL_BEFORE_PUBLISH);
  assert.equal(FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC, BOUNDED_TAIL_BEFORE_DIR_FSYNC);
});

for (const bootstrapCut of [
  {
    name: 'before publish with exact cleanup',
    faultPoint: BOUNDED_TAIL_BEFORE_PUBLISH,
    expectedCode: 'CONTROL_STORE_IO',
  },
  {
    name: 'after replace before directory fsync',
    faultPoint: BOUNDED_TAIL_BEFORE_DIR_FSYNC,
    expectedCode: 'RECOVERY_REQUIRED',
  },
]) {
  test(`bounded bootstrap ${bootstrapCut.name} has the exact uncertainty mapping`, async (t) => {
    const controlDir = createControlDir(t);
    let facade = null;

    await withFaults({
      [bootstrapCut.faultPoint]: { throw: 'EIO' },
    }, async () => {
      assert.throws(
        () => { facade = openControlStore(controlDir, { bounded: true }); },
        { code: bootstrapCut.expectedCode },
      );
    });

    assert.equal(facade, null);
    const reopened = openControlStore(controlDir, { bounded: true });
    assert.deepEqual(reopened.readEvidence().events, []);
    assert.equal(reopened.tail(), null);
    assert.deepEqual(controlTempFiles(controlDir), []);
    assert.equal(fs.readdirSync(controlDir).filter(
      (name) => name === '.controlstore-tail.json',
    ).length, 1);
    assert.deepEqual(
      openControlStore(controlDir, { bounded: true }).readEvidence(),
      reopened.readEvidence(),
    );
  });
}

test('bounded installed tail postcheck failures always require recovery and uniquely converge', async (t) => {
  {
    const controlDir = createControlDir(t);
    const probe = installTailPostcheckReadFailure(controlDir);
    let facade = null;
    try {
      await withFaults({
        [BOUNDED_TAIL_BEFORE_DIR_FSYNC]: { callback() { probe.arm(); } },
      }, async () => {
        assert.throws(
          () => { facade = openControlStore(controlDir, { bounded: true }); },
          { code: 'RECOVERY_REQUIRED' },
        );
      });
    } finally {
      probe.restore();
    }
    assert.equal(facade, null);
    assert.equal(probe.injected, true);
    const reopened = openControlStore(controlDir, { bounded: true });
    assert.deepEqual(reopened.readEvidence().events, []);
    assert.deepEqual(openControlStore(controlDir, { bounded: true }).readEvidence(), reopened.readEvidence());
    assert.deepEqual(controlTempFiles(controlDir), []);
  }

  {
    const controlDir = createControlDir(t);
    openControlStore(controlDir, { bounded: true });
    const oldTail = readPersistentTail(controlDir);
    const successor = writeOfficialSuccessor(controlDir, oldTail);
    const expectedTail = tailAfterSuccessor(oldTail, successor);
    writeTailCandidate(controlDir, expectedTail);
    const probe = installTailPostcheckReadFailure(controlDir, (raw) => (
      JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw).recordDigest
        === expectedTail.recordDigest
    ));
    probe.arm();
    let facade = null;
    try {
      assert.throws(
        () => { facade = openControlStore(controlDir, { bounded: true }); },
        { code: 'RECOVERY_REQUIRED' },
      );
    } finally {
      probe.restore();
    }
    assert.equal(facade, null);
    assert.equal(probe.injected, true);
    const reopened = openControlStore(controlDir, { bounded: true });
    assert.deepEqual(reopened.read().map((event) => event.digest), [successor.digest]);
    assert.deepEqual(openControlStore(controlDir, { bounded: true }).readEvidence(), reopened.readEvidence());
    assert.equal(reopened.append({ type: 'after.matching.postcheck', payload: {} }).seq, 2);
  }

  {
    const controlDir = createControlDir(t);
    openControlStore(controlDir, { bounded: true });
    const { candidatePath } = writeTailCandidate(controlDir, readPersistentTail(controlDir));
    const probe = installTailPostcheckReadFailure(controlDir);
    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, ...args) => {
      const result = originalRmSync(target, ...args);
      if (path.resolve(String(target)) === path.resolve(candidatePath)) probe.arm();
      return result;
    };
    let facade = null;
    try {
      assert.throws(
        () => { facade = openControlStore(controlDir, { bounded: true }); },
        { code: 'RECOVERY_REQUIRED' },
      );
    } finally {
      fs.rmSync = originalRmSync;
      probe.restore();
    }
    assert.equal(facade, null);
    assert.equal(probe.injected, true);
    assert.equal(fs.existsSync(candidatePath), false);
    const reopened = openControlStore(controlDir, { bounded: true });
    assert.deepEqual(reopened.readEvidence().events, []);
    assert.deepEqual(openControlStore(controlDir, { bounded: true }).readEvidence(), reopened.readEvidence());
  }

  {
    const controlDir = createControlDir(t);
    openControlStore(controlDir, { bounded: true });
    const successor = writeOfficialSuccessor(controlDir, readPersistentTail(controlDir));
    const probe = installTailPostcheckReadFailure(controlDir);
    let facade = null;
    try {
      await withFaults({
        [BOUNDED_TAIL_BEFORE_DIR_FSYNC]: { callback() { probe.arm(); } },
      }, async () => {
        assert.throws(
          () => { facade = openControlStore(controlDir, { bounded: true }); },
          { code: 'RECOVERY_REQUIRED' },
        );
      });
    } finally {
      probe.restore();
    }
    assert.equal(facade, null);
    assert.equal(probe.injected, true);
    const reopened = openControlStore(controlDir, { bounded: true });
    assert.deepEqual(reopened.read().map((event) => event.digest), [successor.digest]);
    assert.deepEqual(openControlStore(controlDir, { bounded: true }).readEvidence(), reopened.readEvidence());
    assert.equal(reopened.append({ type: 'after.successor.postcheck', payload: {} }).seq, 2);
  }
});

test('bounded append orders event and tail publication before exact double postcheck', async (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir, { bounded: true });
  const trace = [];
  let capturePostcheck = false;
  let eventTargetPath = null;
  const originalWriteFileSync = fs.writeFileSync;
  const originalReadFileSync = fs.readFileSync;

  fs.writeFileSync = (target, ...args) => {
    const name = path.basename(String(target));
    if (/^\.controlstore-\d+-[0-9a-f-]{36}\.tmp$/.test(name)) {
      trace.push('event-candidate-write');
    }
    if (/^\.controlstore-tail-[0-9a-f-]{36}\.tmp$/.test(name)) {
      trace.push('tail-candidate-write');
    }
    return originalWriteFileSync(target, ...args);
  };
  fs.readFileSync = (target, ...args) => {
    const resolved = path.resolve(String(target));
    if (capturePostcheck && resolved === path.resolve(eventTargetPath)) {
      trace.push('postcheck-event');
    }
    if (
      capturePostcheck
      && resolved === path.resolve(controlDir, '.controlstore-tail.json')
    ) {
      trace.push('postcheck-tail');
    }
    return originalReadFileSync(target, ...args);
  };

  try {
    await withFaults({
      [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: {
        callback(context) {
          eventTargetPath = context.targetPath;
          trace.push('event-before-publish');
        },
      },
      [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC]: {
        callback() { trace.push('event-before-dir-fsync'); },
      },
      [BOUNDED_TAIL_BEFORE_PUBLISH]: {
        callback() { trace.push('tail-before-publish'); },
      },
      [BOUNDED_TAIL_BEFORE_DIR_FSYNC]: {
        callback() {
          trace.push('tail-before-dir-fsync');
          capturePostcheck = true;
        },
      },
    }, async () => {
      store.append({ type: 'ordered.append', payload: { utf8: '证据' } });
    });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.readFileSync = originalReadFileSync;
  }

  assert.deepEqual(trace.slice(0, 6), [
    'event-candidate-write',
    'event-before-publish',
    'event-before-dir-fsync',
    'tail-candidate-write',
    'tail-before-publish',
    'tail-before-dir-fsync',
  ]);
  assert.ok(trace.indexOf('postcheck-event') > 5);
  assert.ok(trace.indexOf('postcheck-tail') > 5);
});

for (const uncertaintyCase of [
  {
    name: 'tail before publish',
    faultPoint: BOUNDED_TAIL_BEFORE_PUBLISH,
  },
  {
    name: 'tail before directory fsync',
    faultPoint: BOUNDED_TAIL_BEFORE_DIR_FSYNC,
  },
  {
    name: 'event or tail postcheck read',
    postcheckRead: true,
  },
]) {
  test(`bounded ${uncertaintyCase.name} uncertainty returns recovery and fences`, async (t) => {
    const controlDir = createControlDir(t);
    const store = openControlStore(controlDir, { bounded: true });
    const postcheckError = Object.assign(new Error('postcheck read failed'), { code: 'EIO' });
    const originalReadFileSync = fs.readFileSync;
    let eventTargetPath = null;
    let postcheckArmed = false;
    let injected = false;
    let receipt = null;
    const faults = uncertaintyCase.postcheckRead
      ? {
        [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: {
          callback(context) { eventTargetPath = path.resolve(context.targetPath); },
        },
        [BOUNDED_TAIL_BEFORE_DIR_FSYNC]: {
          callback() { postcheckArmed = true; },
        },
      }
      : { [uncertaintyCase.faultPoint]: { throw: 'EIO' } };

    if (uncertaintyCase.postcheckRead) {
      fs.readFileSync = (target, ...args) => {
        const resolved = path.resolve(String(target));
        if (
          postcheckArmed
          && !injected
          && (
            resolved === eventTargetPath
            || resolved === path.resolve(controlDir, '.controlstore-tail.json')
          )
        ) {
          injected = true;
          throw postcheckError;
        }
        return originalReadFileSync(target, ...args);
      };
    }

    try {
      await withFaults(faults, async () => {
        assert.throws(
          () => { receipt = store.append({ type: 'uncertain.append', payload: {} }); },
          { code: 'RECOVERY_REQUIRED' },
        );
      });
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    assert.equal(receipt, null);
    assert.equal(eventFiles(controlDir).length, 1);
    if (uncertaintyCase.postcheckRead) assert.equal(injected, true);
    assertBoundedFacadeFenced(store);
  });
}

for (const releaseCase of [
  { name: 'inner writer', kind: 'writer' },
  { name: 'outer lifecycle', kind: 'lifecycle' },
]) {
  test(`bounded bootstrap installed-but-${releaseCase.name}-release-throw recovers on fresh reopen`, (t) => {
    const controlDir = createControlDir(t);
    const harness = loadControlStoreWithLeaseReleaseHarness();
    const writerReleaseError = Object.assign(new Error('bootstrap writer release unknown'), {
      code: 'CONTROL_STORE_IO',
    });
    const lifecycleReleaseError = Object.assign(new Error('bootstrap lifecycle release unknown'), {
      code: 'CONTROL_STORE_IO',
    });
    const primaryReleaseError = releaseCase.kind === 'writer'
      ? writerReleaseError
      : lifecycleReleaseError;
    harness.arm({
      writer: releaseCase.kind === 'writer' ? [writerReleaseError] : [],
      // lifecycle #1 closes activation; lifecycle #2 closes the installed bootstrap turn.
      lifecycle: releaseCase.kind === 'lifecycle'
        ? [null, lifecycleReleaseError]
        : [],
    });
    let facade = null;

    assert.throws(
      () => { facade = harness.openControlStore(controlDir, { bounded: true }); },
      (error) => assertReleaseRecovery(error, primaryReleaseError),
    );
    harness.disarm();

    assert.equal(facade, null);
    const tailPath = path.join(controlDir, '.controlstore-tail.json');
    const installedTailBytes = fs.readFileSync(tailPath);
    const reopened = openControlStore(controlDir, { bounded: true });
    assert.deepEqual(reopened.readEvidence().events, []);
    assert.equal(reopened.tail(), null);
    assert.deepEqual(fs.readFileSync(tailPath), installedTailBytes);
    assert.equal(fs.readdirSync(controlDir).filter(
      (name) => name === '.controlstore-tail.json',
    ).length, 1);
  });
}

for (const releaseCase of [
  { name: 'inner writer', writer: true, lifecycle: false },
  { name: 'outer lifecycle', writer: false, lifecycle: true },
  { name: 'inner and outer', writer: true, lifecycle: true },
]) {
  test(`bounded append installed-but-${releaseCase.name}-release-throw has no receipt and fences`, (t) => {
    const controlDir = createControlDir(t);
    const harness = loadControlStoreWithLeaseReleaseHarness();
    const store = harness.openControlStore(controlDir, { bounded: true });
    const writerReleaseError = Object.assign(new Error('append writer release unknown'), {
      code: 'CONTROL_STORE_IO',
    });
    const lifecycleReleaseError = Object.assign(new Error('append lifecycle release unknown'), {
      code: 'CONTROL_STORE_IO',
    });
    const primaryReleaseError = releaseCase.writer
      ? writerReleaseError
      : lifecycleReleaseError;
    const secondaryReleaseError = releaseCase.writer && releaseCase.lifecycle
      ? lifecycleReleaseError
      : null;
    harness.arm({
      writer: releaseCase.writer ? [writerReleaseError] : [],
      lifecycle: releaseCase.lifecycle ? [lifecycleReleaseError] : [],
    });
    let receipt = null;

    assert.throws(
      () => { receipt = store.append({ type: `release.${releaseCase.name}`, payload: {} }); },
      (error) => assertReleaseRecovery(
        error,
        primaryReleaseError,
        secondaryReleaseError,
      ),
    );
    harness.disarm();

    assert.equal(receipt, null);
    assertBoundedFacadeFenced(store);
    const reopened = openControlStore(controlDir, { bounded: true });
    const evidence = reopened.readEvidence();
    assert.equal(evidence.events.length, 1);
    assert.equal(evidence.events[0].type, `release.${releaseCase.name}`);
    assert.equal(evidence.tail.tailSeq, 1);
    assert.equal(evidence.tail.tailDigest, evidence.events[0].digest);
    assert.equal(evidence.tail.activeEventCount, 1);
    assert.equal(eventFiles(controlDir).length, 1);
  });
}

test('bounded writer reopen advances one exact official successor and remains idempotent', (t) => {
  const controlDir = createControlDir(t);
  openControlStore(controlDir, { bounded: true });
  const oldTail = readPersistentTail(controlDir);
  const successor = writeOfficialSuccessor(controlDir, oldTail);

  const reopened = openControlStore(controlDir, { bounded: true });
  const evidence = reopened.readEvidence();
  assert.deepEqual(evidence.events, [successor]);
  assert.equal(evidence.tail.tailSeq, 1);
  assert.equal(evidence.tail.tailDigest, successor.digest);
  assert.equal(evidence.tail.activeEventCount, 1);
  assert.equal(
    evidence.tail.activeEventBytes,
    Buffer.byteLength(canonicalJson(successor), 'utf8'),
  );
  const reconciledTree = snapshotTree(path.dirname(controlDir));
  assert.deepEqual(
    openControlStore(controlDir, { bounded: true }).readEvidence(),
    evidence,
  );
  assert.deepEqual(snapshotTree(path.dirname(controlDir)), reconciledTree);
  assert.equal(reopened.append({ type: 'after.reconcile', payload: {} }).seq, 2);
});

test('bounded writer rejects a wrong-prev successor without advancing persistent tail', (t) => {
  const controlDir = createControlDir(t);
  openControlStore(controlDir, { bounded: true });
  const oldTailBytes = fs.readFileSync(path.join(controlDir, '.controlstore-tail.json'));
  writeOfficialSuccessor(controlDir, readPersistentTail(controlDir), {
    prevDigest: '0'.repeat(64),
  });
  const before = snapshotTree(path.dirname(controlDir));

  assert.throws(
    () => openControlStore(controlDir, { bounded: true }),
    { code: 'RECOVERY_REQUIRED' },
  );

  assert.deepEqual(
    fs.readFileSync(path.join(controlDir, '.controlstore-tail.json')),
    oldTailBytes,
  );
  assert.deepEqual(snapshotTree(path.dirname(controlDir)), before);
});

test('read-only inspector reports a unique successor with zero writes and no projection', (t) => {
  const controlDir = createControlDir(t);
  openControlStore(controlDir, { bounded: true });
  writeOfficialSuccessor(controlDir, readPersistentTail(controlDir));
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);

  const calls = withFsMutationLog(() => {
    assert.throws(
      () => inspectControlStoreEvidence(controlDir),
      { code: 'RECOVERY_REQUIRED' },
    );
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(snapshotTree(root), before);
  assert.equal(readPersistentTail(controlDir).tailSeq, 0);
});

test('bounded writer reopen with no successor preserves the exact persistent tree', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir, { bounded: true });
  store.append({ type: 'stable.tail', payload: { value: 1 } });
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);
  const evidence = store.readEvidence();

  assert.deepEqual(
    openControlStore(controlDir, { bounded: true }).readEvidence(),
    evidence,
  );
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded writer installs a matching tail candidate for one exact successor', (t) => {
  const controlDir = createControlDir(t);
  openControlStore(controlDir, { bounded: true });
  const successor = writeOfficialSuccessor(controlDir, readPersistentTail(controlDir));
  const expectedTail = tailAfterSuccessor(readPersistentTail(controlDir), successor);
  const { candidatePath } = writeTailCandidate(controlDir, expectedTail);
  const root = path.dirname(controlDir);
  const beforeInspector = snapshotTree(root);

  const inspectorCalls = withFsMutationLog(() => {
    assert.throws(
      () => inspectControlStoreEvidence(controlDir),
      { code: 'RECOVERY_REQUIRED' },
    );
  });
  assert.deepEqual(inspectorCalls, []);
  assert.deepEqual(snapshotTree(root), beforeInspector);

  const reopened = openControlStore(controlDir, { bounded: true });
  assert.deepEqual(reopened.readEvidence().tail, expectedTail);
  assert.deepEqual(reopened.read(), [successor]);
  assert.equal(fs.existsSync(candidatePath), false);
  const reconciledTree = snapshotTree(root);
  assert.deepEqual(
    openControlStore(controlDir, { bounded: true }).readEvidence(),
    reopened.readEvidence(),
  );
  assert.deepEqual(snapshotTree(root), reconciledTree);
  assert.equal(reopened.append({ type: 'after.candidate', payload: {} }).seq, 2);
});

test('bounded writer removes an equivalent current-tail candidate and fsyncs its directory', (t) => {
  const controlDir = createControlDir(t);
  openControlStore(controlDir, { bounded: true });
  const tailBytes = fs.readFileSync(path.join(controlDir, '.controlstore-tail.json'));
  const { candidatePath } = writeTailCandidate(controlDir, readPersistentTail(controlDir));
  const fsyncs = [];
  const observedOpen = loadControlStoreWithDirectoryFsyncObserver(
    (directory) => fsyncs.push(directory),
  );

  assert.throws(
    () => inspectControlStoreEvidence(controlDir),
    { code: 'RECOVERY_REQUIRED' },
  );
  const reopened = observedOpen(controlDir, { bounded: true });

  assert.deepEqual(reopened.readEvidence().events, []);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.deepEqual(
    fs.readFileSync(path.join(controlDir, '.controlstore-tail.json')),
    tailBytes,
  );
  assert.ok(fsyncs.includes(path.resolve(controlDir)));
});

test('bounded bootstrap publishes one exact candidate that matches the complete legacy scan', (t) => {
  const controlDir = createControlDir(t);
  const legacy = openControlStore(controlDir);
  legacy.append({ type: 'legacy.before.bounded', payload: { utf8: '旧证据' } });
  const [event] = legacy.read();
  const candidateTail = materializeTailRecord({
    version: 1,
    controlProtocolEpoch: 2,
    incarnationId: legacy.incarnationId,
    checkpointFile: null,
    checkpointDigest: null,
    coveredSeq: 0,
    coveredDigest: null,
    tailSeq: 1,
    tailDigest: event.digest,
    activeEventCount: 1,
    activeEventBytes: Buffer.byteLength(canonicalJson(event), 'utf8'),
  });
  const { candidatePath } = writeTailCandidate(controlDir, candidateTail);
  const root = path.dirname(controlDir);
  const beforeInspector = snapshotTree(root);

  const inspectorCalls = withFsMutationLog(() => {
    assert.throws(
      () => inspectControlStoreEvidence(controlDir),
      { code: 'RECOVERY_REQUIRED' },
    );
  });
  assert.deepEqual(inspectorCalls, []);
  assert.deepEqual(snapshotTree(root), beforeInspector);

  const bounded = openControlStore(controlDir, { bounded: true });
  assert.deepEqual(bounded.read(), [event]);
  assert.deepEqual(bounded.readEvidence().tail, candidateTail);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.equal(fs.existsSync(path.join(controlDir, '.controlstore-tail.json')), true);
  assert.equal(bounded.append({ type: 'after.bootstrap.candidate', payload: {} }).seq, 2);
});

for (const rejectionCase of [
  {
    name: 'multiple same-sequence successors',
    prepare(controlDir, tail) {
      writeOfficialSuccessor(controlDir, tail, { type: 'successor.one' });
      writeOfficialSuccessor(controlDir, tail, { type: 'successor.two' });
    },
  },
  {
    name: 'two unreferenced chained events',
    prepare(controlDir, tail) {
      const first = writeOfficialSuccessor(controlDir, tail);
      writeEventFile(controlDir, {
        seq: first.seq + 1,
        type: 'second.unreferenced',
        payload: {},
        prevDigest: first.digest,
      });
    },
  },
  {
    name: 'a sequence hole',
    prepare(controlDir) {
      writeEventFile(controlDir, {
        seq: 2,
        type: 'hole.after.tail',
        payload: {},
        prevDigest: null,
      });
    },
  },
  {
    name: 'a candidate that names the wrong successor digest',
    prepare(controlDir, tail) {
      const successor = writeOfficialSuccessor(controlDir, tail);
      writeTailCandidate(controlDir, {
        ...tailAfterSuccessor(tail, successor),
        tailDigest: 'f'.repeat(64),
      });
    },
  },
  {
    name: 'a candidate that advances to the wrong sequence',
    prepare(controlDir, tail) {
      const successor = writeOfficialSuccessor(controlDir, tail);
      const expected = tailAfterSuccessor(tail, successor);
      writeTailCandidate(controlDir, {
        ...expected,
        tailSeq: 2,
        activeEventCount: 2,
      });
    },
  },
  {
    name: 'a candidate with mismatching active byte authority',
    prepare(controlDir, tail) {
      const successor = writeOfficialSuccessor(controlDir, tail);
      const expected = tailAfterSuccessor(tail, successor);
      writeTailCandidate(controlDir, {
        ...expected,
        activeEventBytes: expected.activeEventBytes + 1,
      });
    },
  },
]) {
  test(`bounded writer rejects ${rejectionCase.name} without business advancement`, (t) => {
    const controlDir = createControlDir(t);
    openControlStore(controlDir, { bounded: true });
    const oldTailBytes = fs.readFileSync(path.join(controlDir, '.controlstore-tail.json'));
    rejectionCase.prepare(controlDir, readPersistentTail(controlDir));
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);

    assert.throws(
      () => openControlStore(controlDir, { bounded: true }),
      { code: 'RECOVERY_REQUIRED' },
    );

    assert.deepEqual(
      fs.readFileSync(path.join(controlDir, '.controlstore-tail.json')),
      oldTailBytes,
    );
    assert.deepEqual(snapshotTree(root), before);
  });
}

test('bounded writer and inspector classify a malformed exact-name tail candidate as corrupt', (t) => {
  const controlDir = createControlDir(t);
  openControlStore(controlDir, { bounded: true });
  const { candidatePath, record } = writeTailCandidate(
    controlDir,
    readPersistentTail(controlDir),
  );
  fs.writeFileSync(candidatePath, canonicalJson({
    ...record,
    recordDigest: '0'.repeat(64),
  }));
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);

  assert.throws(
    () => inspectControlStoreEvidence(controlDir),
    { code: 'CONTROL_STORE_CORRUPT' },
  );
  assert.deepEqual(snapshotTree(root), before);
  assert.throws(
    () => openControlStore(controlDir, { bounded: true }),
    { code: 'CONTROL_STORE_CORRUPT' },
  );
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded writer and inspector reject noncanonical tail candidate bytes as corrupt', (t) => {
  const controlDir = createControlDir(t);
  openControlStore(controlDir, { bounded: true });
  const { candidatePath, record } = writeTailCandidate(
    controlDir,
    readPersistentTail(controlDir),
  );
  fs.writeFileSync(candidatePath, JSON.stringify(record, null, 2));
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);

  assert.throws(
    () => inspectControlStoreEvidence(controlDir),
    { code: 'CONTROL_STORE_CORRUPT' },
  );
  assert.deepEqual(snapshotTree(root), before);
  assert.throws(
    () => openControlStore(controlDir, { bounded: true }),
    { code: 'CONTROL_STORE_CORRUPT' },
  );
  assert.deepEqual(snapshotTree(root), before);
});

for (const checkpointCandidateCase of [
  {
    name: 'non-plain checkpoint candidate',
    install(candidatePath) { fs.mkdirSync(candidatePath); },
  },
  {
    name: 'noncanonical checkpoint candidate bytes',
    install(candidatePath, fixture) {
      fs.writeFileSync(candidatePath, JSON.stringify(fixture.checkpoint, null, 2));
    },
  },
  {
    name: 'inexact checkpoint candidate schema',
    install(candidatePath, fixture) {
      fs.writeFileSync(candidatePath, canonicalJson({
        ...fixture.checkpoint,
        unexpected: true,
      }));
    },
  },
  {
    name: 'checkpoint candidate filename linkage mismatch',
    coveredSeqOffset: 1,
    install(candidatePath, fixture) {
      fs.writeFileSync(candidatePath, canonicalJson(fixture.checkpoint));
    },
  },
]) {
  test(`bounded writer and inspector reject ${checkpointCandidateCase.name} as corrupt`, (t) => {
    const fixture = installCheckpointOnlyEvidence(t);
    const candidatePath = path.join(
      fixture.controlDir,
      `.controlstore-checkpoint-${fixture.checkpoint.coveredSeq
        + (checkpointCandidateCase.coveredSeqOffset || 0)}-${crypto.randomUUID()}.tmp`,
    );
    checkpointCandidateCase.install(candidatePath, fixture);
    const root = path.dirname(fixture.controlDir);
    const before = snapshotTree(root);

    assert.throws(
      () => inspectControlStoreEvidence(fixture.controlDir),
      { code: 'CONTROL_STORE_CORRUPT' },
    );
    assert.deepEqual(snapshotTree(root), before);
    assert.throws(
      () => openControlStore(fixture.controlDir, { bounded: true }),
      { code: 'CONTROL_STORE_CORRUPT' },
    );
    assert.deepEqual(snapshotTree(root), before);
  });
}

test('bounded writer and inspector keep an exact checkpoint candidate unresolved and zero-write', (t) => {
  const fixture = installCheckpointOnlyEvidence(t);
  const candidatePath = path.join(
    fixture.controlDir,
    `.controlstore-checkpoint-${fixture.checkpoint.coveredSeq}-${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(candidatePath, canonicalJson(fixture.checkpoint));
  const root = path.dirname(fixture.controlDir);
  const before = snapshotTree(root);

  assert.throws(
    () => inspectControlStoreEvidence(fixture.controlDir),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.deepEqual(snapshotTree(root), before);
  assert.throws(
    () => openControlStore(fixture.controlDir, { bounded: true }),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded inspector authenticates event candidates without consuming them', (t) => {
  for (const candidateCase of [
    { name: 'exact', expectedCode: 'RECOVERY_REQUIRED', malformed: false },
    { name: 'malformed', expectedCode: 'CONTROL_STORE_CORRUPT', malformed: true },
  ]) {
    const controlDir = createControlDir(t);
    openControlStore(controlDir, { bounded: true });
    const { candidatePath, event } = writeEventCandidate(controlDir, {
      seq: 1,
      type: `bounded.inspector.${candidateCase.name}-event-candidate`,
      payload: { version: 1 },
      prevDigest: null,
    });
    if (candidateCase.malformed) {
      fs.writeFileSync(candidatePath, canonicalJson({ ...event, digest: '0'.repeat(64) }));
    }
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);
    const calls = withFsMutationLog(() => {
      assert.throws(
        () => inspectControlStoreEvidence(controlDir),
        { code: candidateCase.expectedCode },
      );
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(snapshotTree(root), before);
  }
});

test('bounded tail that references a missing active event is corrupt and never repaired', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir, { bounded: true });
  store.append({ type: 'will.be.missing', payload: {} });
  fs.rmSync(path.join(controlDir, eventFiles(controlDir)[0]));
  const root = path.dirname(controlDir);
  const before = snapshotTree(root);

  assert.throws(() => store.readEvidence(), { code: 'CONTROL_STORE_CORRUPT' });
  assert.throws(
    () => openControlStore(controlDir, { bounded: true }),
    { code: 'CONTROL_STORE_CORRUPT' },
  );
  assert.deepEqual(snapshotTree(root), before);
});

test('bounded fresh open cleans covered checkpoint event residue after inspector remains read-only', (t) => {
  const fixture = installCheckpointOnlyEvidence(t);
  const coveredName = `${fixture.genesis.seq}-${fixture.genesis.digest}.json`;
  const coveredPath = path.join(fixture.controlDir, coveredName);
  const coveredBytes = Buffer.from(canonicalJson(fixture.genesis));
  fs.writeFileSync(coveredPath, coveredBytes);
  const checkpointPath = path.join(fixture.controlDir, fixture.checkpointFile);
  const tailPath = path.join(fixture.controlDir, '.controlstore-tail.json');
  const checkpointBytes = fs.readFileSync(checkpointPath);
  const tailBytes = fs.readFileSync(tailPath);
  const root = path.dirname(fixture.controlDir);
  const beforeInspector = snapshotTree(root);

  const inspectorMutations = withFsMutationLog(() => {
    assert.throws(
      () => inspectControlStoreEvidence(fixture.controlDir),
      { code: 'RECOVERY_REQUIRED' },
    );
  });
  assert.deepEqual(inspectorMutations, []);
  assert.deepEqual(snapshotTree(root), beforeInspector);
  assert.deepEqual(fs.readFileSync(coveredPath), coveredBytes);

  const bounded = openControlStore(fixture.controlDir, { bounded: true });
  assert.deepEqual(bounded.read(), []);
  assert.equal(fs.existsSync(coveredPath), false);
  assert.deepEqual(fs.readFileSync(checkpointPath), checkpointBytes);
  assert.deepEqual(fs.readFileSync(tailPath), tailBytes);
  assert.deepEqual(bounded.readEvidence().checkpoint, fixture.checkpoint);
  assert.deepEqual(bounded.readEvidence().tail, fixture.tail);

  const receipt = bounded.append({ type: 'active.after.checkpoint', payload: {} });
  assert.equal(receipt.seq, 2);
  assert.deepEqual(bounded.read().map((event) => event.seq), [2]);
  assert.deepEqual(eventFiles(fixture.controlDir), [
    `${receipt.seq}-${receipt.digest}.json`,
  ]);
  assert.equal(fs.existsSync(coveredPath), false);
  assert.deepEqual(bounded.readEvidence().checkpoint, fixture.checkpoint);

  const beforeReopen = snapshotTree(root);
  const reopened = openControlStore(fixture.controlDir, { bounded: true });
  assert.deepEqual(reopened.read().map((event) => event.seq), [2]);
  assert.equal(fs.existsSync(coveredPath), false);
  assert.deepEqual(eventFiles(fixture.controlDir), [
    `${receipt.seq}-${receipt.digest}.json`,
  ]);
  assert.deepEqual(reopened.readEvidence().checkpoint, fixture.checkpoint);
  assert.deepEqual(snapshotTree(root), beforeReopen);
});

test('append persists an event that read returns with a stable digest chain', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);

  const appended = store.append({
    type: 'project.created',
    payload: { projectKey: 'novel-1', title: '长夜' },
  });

  assert.deepEqual(store.read(), [{
    seq: 1,
    type: 'project.created',
    payload: { projectKey: 'novel-1', title: '长夜' },
    prevDigest: null,
    digest: appended.digest,
  }]);
  assert.deepEqual(appended, { seq: 1, digest: appended.digest });
  assert.match(appended.digest, /^[0-9a-f]{64}$/);
  const [{ digest, ...eventWithoutDigest }] = store.read();
  assert.equal(digestEvent(eventWithoutDigest), digest);
});

test('tail returns null for an empty store and the last complete event otherwise', (t) => {
  const store = openControlStore(createControlDir(t));

  assert.equal(store.tail(), null);
  store.append({ type: 'first', payload: { value: 1 } });
  const second = store.append({
    type: 'second',
    payload: { value: 2 },
    afterPredicate: { type: 'chapter.accepted', chapterId: 'chapter-7' },
  });

  assert.deepEqual(store.tail(), {
    seq: 2,
    type: 'second',
    payload: { value: 2 },
    prevDigest: store.read()[0].digest,
    afterPredicate: { chapterId: 'chapter-7', type: 'chapter.accepted' },
    digest: second.digest,
  });
});

test('compareAndAppend uses null as the empty-store digest and rejects stale digests', (t) => {
  const store = openControlStore(createControlDir(t));

  assert.throws(
    () => store.compareAndAppend(undefined, { type: 'invalid-empty-cas', payload: {} }),
    { code: 'CONTROL_STORE_CAS_FAILED' },
  );
  const first = store.compareAndAppend(null, { type: 'first', payload: { value: 1 } });
  assert.equal(first.seq, 1);

  assert.throws(
    () => store.compareAndAppend('0'.repeat(64), { type: 'stale', payload: {} }),
    { code: 'CONTROL_STORE_CAS_FAILED' },
  );
  assert.equal(store.read().length, 1);

  const second = store.compareAndAppend(first.digest, { type: 'second', payload: { value: 2 } });
  assert.equal(second.seq, 2);
  assert.equal(store.tail().digest, second.digest);
});

test('append refuses a competing writer lease and succeeds after its release', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  const held = acquireExclusiveLease(path.join(controlDir, '.controlstore-writer.lock'));

  try {
    assert.throws(
      () => store.append({ type: 'blocked', payload: {} }),
      { code: 'LEASE_BUSY' },
    );
  } finally {
    held.release();
  }

  assert.equal(store.append({ type: 'after-release', payload: {} }).seq, 1);
});

test('append and CAS serialize across processes at the store-level writer barrier', async (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  const releasePath = path.join(path.dirname(controlDir), 'release-child');
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'fixtures', 'control-store-contention-worker.js'), controlDir, releasePath],
    {
      cwd: path.resolve(__dirname, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const prefix = await waitForChildLine(child, 'barrier');

  assert.throws(
    () => store.compareAndAppend(null, { type: 'parent.cas', payload: {} }),
    { code: 'LEASE_BUSY' },
  );
  const completion = collectChild(child, prefix);
  fs.writeFileSync(releasePath, 'release');
  const result = await completion;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^barrier\r?\nappended:[0-9a-f]{64}\r?\n$/);

  const childDigest = store.tail().digest;
  assert.throws(
    () => store.compareAndAppend(null, { type: 'parent.stale-cas', payload: {} }),
    { code: 'CONTROL_STORE_CAS_FAILED' },
  );
  const parent = store.compareAndAppend(childDigest, {
    type: 'parent.cas',
    payload: { process: 'parent' },
  });
  assert.equal(parent.seq, 2);
  assert.deepEqual(store.read().map((event) => event.type), ['child.append', 'parent.cas']);
});

test('retire holds the stable lifecycle lease and preserves the complete event directory', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'seed', payload: { stable: true } });
  const expectedEvents = store.read();
  const retiredDir = path.join(
    path.dirname(controlDir),
    `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`,
  );
  const held = acquireExclusiveLease(store.lifecycleLeasePath);

  try {
    assert.throws(
      () => store.retire(retiredDir, () => {}),
      { code: 'LEASE_BUSY' },
    );
  } finally {
    held.release();
  }

  let validationCalls = 0;
  assert.equal(store.retire(retiredDir, (events) => {
    validationCalls += 1;
    assert.deepEqual(events, expectedEvents);
  }), retiredDir);
  assert.equal(validationCalls, 1);
  assert.equal(fs.existsSync(controlDir), false);
  assert.equal(fs.existsSync(retiredDir), true);
  assert.deepEqual(openControlStore(retiredDir).read(), expectedEvents);
});

test('retire never rolls a renamed evidence directory back after parent fsync fails', async (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'seed', payload: { stable: true } });
  const retiredDir = path.join(
    path.dirname(controlDir),
    `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`,
  );

  await withFaults({
    [FAULT_POINTS.CONTROL_STORE_RETIRE_BEFORE_DIR_FSYNC]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => store.retire(retiredDir, () => {}),
      { code: 'CONTROL_STORE_IO' },
    );
  });

  assert.equal(fs.existsSync(controlDir), false);
  assert.equal(fs.existsSync(retiredDir), true);
  assert.equal(openControlStore(retiredDir).read().length, 1);
});

test('a retired store object never rebinds to a new directory at the same path', (t) => {
  const controlDir = createControlDir(t);
  const stale = openControlStore(controlDir);
  stale.append({ type: 'old', payload: { generation: 1 } });
  const staleIncarnationId = stale.incarnationId;
  const retiredDir = path.join(
    path.dirname(controlDir),
    `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`,
  );
  stale.retire(retiredDir, () => {});
  const replacement = openControlStore(controlDir);
  replacement.append({ type: 'new', payload: { generation: 2 } });

  assert.match(staleIncarnationId, /^[0-9a-f-]{36}$/);
  assert.notEqual(replacement.incarnationId, staleIncarnationId);
  assert.throws(() => stale.read(), { code: 'CONTROL_STORE_STALE' });
  assert.throws(
    () => stale.append({ type: 'stale-old-writer', payload: {} }),
    { code: 'CONTROL_STORE_STALE' },
  );
  assert.throws(
    () => stale.compareAndAppend(null, { type: 'stale-cas', payload: {} }),
    { code: 'CONTROL_STORE_STALE' },
  );
  assert.deepEqual(replacement.read().map((event) => event.type), ['new']);
  assert.equal(openControlStore(retiredDir).incarnationId, staleIncarnationId);
});

test('a store object rejects a copied directory with the same event bytes but new physical identity', (t) => {
  const controlDir = createControlDir(t);
  const stale = openControlStore(controlDir);
  stale.append({ type: 'old', payload: { generation: 1 } });
  const movedDir = `${controlDir}.moved`;
  fs.renameSync(controlDir, movedDir);
  fs.cpSync(movedDir, controlDir, { recursive: true });

  assert.throws(() => stale.read(), { code: 'CONTROL_STORE_STALE' });
  assert.throws(
    () => stale.append({ type: 'must-not-land', payload: {} }),
    { code: 'CONTROL_STORE_STALE' },
  );
});

test('a missing active directory cannot be replaced without exact controlled retirement evidence', (t) => {
  const controlDir = createControlDir(t);
  const old = openControlStore(controlDir);
  old.append({ type: 'unfinished-evidence', payload: { generation: 1 } });
  const activeRecordPath = old.lifecycleLeasePath.replace(/\.lifecycle\.lock$/, '.active.json');
  const activeRecordBefore = fs.readFileSync(activeRecordPath);
  const uncontrolledMove = `${controlDir}.moved-aside`;
  fs.renameSync(controlDir, uncontrolledMove);

  assert.throws(
    () => openControlStore(controlDir),
    { code: 'CONTROL_STORE_STALE' },
  );
  assert.deepEqual(fs.readFileSync(activeRecordPath), activeRecordBefore);
  assert.equal(eventFiles(uncontrolledMove).length, 1);
  assert.throws(() => old.read(), { code: 'CONTROL_STORE_STALE' });
});

test('retireAndActivate creates a replacement incarnation before releasing lifecycle ownership', (t) => {
  const controlDir = createControlDir(t);
  const old = openControlStore(controlDir);
  old.append({ type: 'old', payload: {} });
  const oldIncarnationId = old.incarnationId;
  const retiredDir = path.join(
    path.dirname(controlDir),
    `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`,
  );

  const activation = old.retireAndActivate(retiredDir, () => {});

  assert.equal(activation.retiredDirectory, retiredDir);
  assert.match(activation.incarnationId, /^[0-9a-f-]{36}$/);
  assert.notEqual(activation.incarnationId, oldIncarnationId);
  assert.equal(fs.existsSync(controlDir), true);
  assert.equal(openControlStore(controlDir).incarnationId, activation.incarnationId);
  assert.throws(() => old.read(), { code: 'CONTROL_STORE_STALE' });
});

test('physical path aliases share one lifecycle lease', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-control-alias-'));
  const physicalParent = path.join(root, 'physical');
  const aliasParent = path.join(root, 'alias');
  fs.mkdirSync(physicalParent);
  fs.symlinkSync(
    physicalParent,
    aliasParent,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const physicalStore = openControlStore(path.join(physicalParent, 'control'));
  const aliasStore = openControlStore(path.join(aliasParent, 'control'));

  assert.equal(aliasStore.lifecycleLeasePath, physicalStore.lifecycleLeasePath);
  const held = acquireExclusiveLease(aliasStore.lifecycleLeasePath);
  try {
    assert.throws(
      () => physicalStore.append({ type: 'must-block', payload: {} }),
      { code: 'LEASE_BUSY' },
    );
  } finally {
    held.release();
  }
  assert.equal(physicalStore.append({ type: 'after-release', payload: {} }).seq, 1);
});

test('activation resumes after the replacement directory exists but active-record publication fails', (t) => {
  const controlDir = createControlDir(t);
  const old = openControlStore(controlDir);
  old.append({ type: 'old', payload: {} });
  const oldIncarnationId = old.incarnationId;
  const retiredDir = path.join(
    path.dirname(controlDir),
    `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`,
  );
  const activationWriteError = Object.assign(new Error('activation write failed'), { code: 'EIO' });
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;

  fs.writeFileSync = (target, ...args) => {
    const name = path.basename(String(target));
    if (!injected && name.startsWith('.controlstore-activation-') && name.endsWith('.tmp')) {
      injected = true;
      throw activationWriteError;
    }
    return originalWriteFileSync(target, ...args);
  };
  try {
    assert.throws(
      () => old.retireAndActivate(retiredDir, () => {}),
      (error) => error.code === 'CONTROL_STORE_IO' && error.cause === activationWriteError,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(controlDir), true);
  assert.equal(fs.existsSync(retiredDir), true);
  const resumed = openControlStore(controlDir);
  assert.notEqual(resumed.incarnationId, oldIncarnationId);
  assert.equal(resumed.append({ type: 'new', payload: {} }).seq, 1);
  assert.throws(() => old.read(), { code: 'CONTROL_STORE_STALE' });
});

test('a partial incarnation write never poisons replacement activation', (t) => {
  const controlDir = createControlDir(t);
  const old = openControlStore(controlDir);
  old.append({ type: 'old', payload: {} });
  const oldIncarnationId = old.incarnationId;
  const retiredDir = path.join(
    path.dirname(controlDir),
    `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`,
  );
  const partialWriteError = Object.assign(new Error('partial incarnation write'), { code: 'EIO' });
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;

  fs.writeFileSync = (target, bytes, ...args) => {
    const targetPath = path.resolve(String(target));
    if (
      !injected
      && path.dirname(targetPath) === path.resolve(controlDir)
      && path.basename(targetPath).startsWith('.controlstore-')
    ) {
      injected = true;
      originalWriteFileSync(target, Buffer.from(String(bytes).slice(0, 12)), ...args);
      throw partialWriteError;
    }
    return originalWriteFileSync(target, bytes, ...args);
  };
  try {
    assert.throws(
      () => old.retireAndActivate(retiredDir, () => {}),
      (error) => error.code === 'CONTROL_STORE_IO' && error.cause === partialWriteError,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(injected, true);
  const resumed = openControlStore(controlDir);
  assert.notEqual(resumed.incarnationId, oldIncarnationId);
  assert.equal(resumed.append({ type: 'new', payload: {} }).seq, 1);
  assert.throws(() => old.read(), { code: 'CONTROL_STORE_STALE' });
});

for (const publicationState of ['before-link', 'after-link']) {
  test(`replacement activation recovers an exact incarnation temp left ${publicationState}`, (t) => {
    const controlDir = createControlDir(t);
    const old = openControlStore(controlDir);
    old.append({ type: 'old', payload: {} });
    const retiredDir = path.join(
      path.dirname(controlDir),
      `${path.basename(controlDir)}.retired-${crypto.randomUUID()}`,
    );
    old.retire(retiredDir, () => {});
    fs.mkdirSync(controlDir);

    const incarnationId = crypto.randomUUID();
    const incarnationPath = path.join(controlDir, '.controlstore-incarnation.json');
    const tempPath = path.join(
      controlDir,
      `.controlstore-incarnation-${crypto.randomUUID()}.tmp`,
    );
    const bytes = JSON.stringify({ version: 1, incarnationId });
    if (publicationState === 'after-link') {
      fs.writeFileSync(incarnationPath, bytes, { flag: 'wx' });
      fs.linkSync(incarnationPath, tempPath);
    } else {
      fs.writeFileSync(tempPath, bytes, { flag: 'wx' });
    }

    const resumed = openControlStore(controlDir);
    assert.equal(fs.existsSync(tempPath), false);
    if (publicationState === 'after-link') {
      assert.equal(resumed.incarnationId, incarnationId);
    } else {
      assert.notEqual(resumed.incarnationId, incarnationId);
    }
    assert.equal(resumed.append({ type: 'new', payload: {} }).seq, 1);
    assert.throws(() => old.read(), { code: 'CONTROL_STORE_STALE' });
  });
}

test('append rejects every value outside the strict JSON event domain before temp creation', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'seed', payload: { stable: true } });
  const originalTail = store.tail();
  const cycle = {};
  cycle.self = cycle;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'value', {
    enumerable: true,
    get: () => 'mutable accessor',
  });
  const invalidEvents = [
    ['missing payload', { type: 'missing-payload' }],
    ['undefined event', undefined],
    ['null event', null],
    ['missing type', { payload: {} }],
    ['undefined type', { type: undefined, payload: {} }],
    ['empty type', { type: '', payload: {} }],
    ['non-string type', { type: 7, payload: {} }],
    ['undefined payload', { type: 'invalid', payload: undefined }],
    ['nested undefined', { type: 'invalid', payload: { value: undefined } }],
    ['nested function', { type: 'invalid', payload: { value: () => {} } }],
    ['nested symbol', { type: 'invalid', payload: { value: Symbol('invalid') } }],
    ['NaN', { type: 'invalid', payload: { value: Number.NaN } }],
    ['Infinity', { type: 'invalid', payload: { value: Number.POSITIVE_INFINITY } }],
    ['BigInt', { type: 'invalid', payload: { value: 1n } }],
    ['cycle', { type: 'invalid', payload: cycle }],
    ['accessor', { type: 'invalid', payload: accessorPayload }],
    ['invalid afterPredicate', {
      type: 'invalid',
      payload: {},
      afterPredicate: { value: undefined },
    }],
  ];
  const originalWriteFileSync = fs.writeFileSync;
  let tempWriteCount = 0;
  fs.writeFileSync = (target, ...args) => {
    if (String(target).startsWith(controlDir) && String(target).endsWith('.tmp')) {
      tempWriteCount += 1;
    }
    return originalWriteFileSync(target, ...args);
  };

  try {
    for (const [label, event] of invalidEvents) {
      assert.throws(
        () => store.append(event),
        (error) => error.code === 'CONTROL_STORE_INVALID_EVENT',
        label,
      );
      assert.deepEqual(store.tail(), originalTail, label);
      assert.deepEqual(controlTempFiles(controlDir), [], label);
    }
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(tempWriteCount, 0);
});

test('append rejects a computed sequence outside the safe integer range before writing', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'seed', payload: {} });
  const originalTail = store.tail();
  const originalIsSafeInteger = Number.isSafeInteger;
  const originalWriteFileSync = fs.writeFileSync;
  let tempWriteCount = 0;

  Number.isSafeInteger = (value) => (
    value === 2 ? false : originalIsSafeInteger(value)
  );
  fs.writeFileSync = (target, ...args) => {
    if (String(target).startsWith(controlDir) && String(target).endsWith('.tmp')) {
      tempWriteCount += 1;
    }
    return originalWriteFileSync(target, ...args);
  };
  try {
    assert.throws(
      () => store.append({ type: 'overflow', payload: {} }),
      { code: 'CONTROL_STORE_INVALID_EVENT' },
    );
  } finally {
    Number.isSafeInteger = originalIsSafeInteger;
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.deepEqual(store.tail(), originalTail);
  assert.equal(tempWriteCount, 0);
  assert.deepEqual(controlTempFiles(controlDir), []);
});

test('read fails closed on a missing sequence number', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'first', payload: {} });
  store.append({ type: 'second', payload: {} });
  store.append({ type: 'third', payload: {} });
  fs.rmSync(path.join(controlDir, eventFiles(controlDir)[1]));

  assert.throws(() => store.read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /missing sequence/i.test(error.message)
  ));
});

test('read fails closed on duplicate sequence numbers', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'first', payload: { version: 1 } });
  writeEventFile(controlDir, {
    seq: 1,
    type: 'other-first',
    payload: { version: 2 },
    prevDigest: null,
  });

  assert.throws(() => store.read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /duplicate sequence/i.test(error.message)
  ));
});

test('read fails closed when filename sequence differs from content', (t) => {
  const controlDir = createControlDir(t);
  const event = {
    seq: 2,
    type: 'wrong-sequence',
    payload: {},
    prevDigest: null,
  };
  const actualName = writeEventFile(controlDir, event);
  fs.renameSync(
    path.join(controlDir, actualName),
    path.join(controlDir, actualName.replace(/^2-/, '1-')),
  );

  assert.throws(() => openControlStore(controlDir).read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /filename sequence/i.test(error.message)
  ));
});

test('read fails closed when filename digest differs from content', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'first', payload: {} });
  const originalName = eventFiles(controlDir)[0];
  fs.renameSync(
    path.join(controlDir, originalName),
    path.join(controlDir, `1-${'0'.repeat(64)}.json`),
  );

  assert.throws(() => store.read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /filename digest/i.test(error.message)
  ));
});

test('read fails closed when prevDigest does not continue the chain', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'first', payload: {} });
  store.append({ type: 'second', payload: {} });
  const secondName = eventFiles(controlDir)[1];
  const second = readEventFile(controlDir, secondName);
  fs.rmSync(path.join(controlDir, secondName));
  writeEventFile(controlDir, { ...second, prevDigest: 'f'.repeat(64) });

  assert.throws(() => store.read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /prevDigest/i.test(error.message)
  ));
});

test('read fails closed when the stored digest cannot be recomputed from content', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'first', payload: { value: 1 } });
  const name = eventFiles(controlDir)[0];
  const event = readEventFile(controlDir, name);
  event.payload.value = 99;
  fs.writeFileSync(path.join(controlDir, name), canonicalJson(event));

  assert.throws(() => store.read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /event digest/i.test(error.message)
  ));
});

test('read rejects malformed or partial official JSON but ignores an exact production temp file', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'first', payload: {} });
  fs.writeFileSync(
    path.join(controlDir, '.controlstore-4321-00000000-0000-4000-8000-000000000000.tmp'),
    '{partial',
  );

  assert.equal(store.read().length, 1);
  assert.equal(store.append({ type: 'second', payload: {} }).seq, 2);

  fs.writeFileSync(path.join(controlDir, 'partial.json'), '{partial');
  assert.throws(() => store.read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /official filename/i.test(error.message)
  ));

  fs.rmSync(path.join(controlDir, 'partial.json'));
  const officialName = eventFiles(controlDir)[0];
  fs.writeFileSync(path.join(controlDir, officialName), '{partial');
  assert.throws(() => store.read(), (error) => (
    error.code === 'CONTROL_STORE_CORRUPT' && /valid JSON/i.test(error.message)
  ));
});

test('read fails closed on every entry outside the exact lock and production-temp whitelist', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  store.append({ type: 'seed', payload: {} });
  const unknownEntries = [
    ['stray.txt', 'file'],
    ['event.JSON', 'file'],
    [`1-${'0'.repeat(64)}.json.tmp`, 'file'],
    ['.controlstore-dead-child.tmp', 'file'],
    ['.controlstore-2-00000000-0000-1000-8000-000000000000.tmp', 'file'],
    ['.CONTROLSTORE-2-00000000-0000-4000-8000-000000000000.TMP', 'file'],
    ['stray-directory', 'directory'],
  ];

  for (const [name, kind] of unknownEntries) {
    const target = path.join(controlDir, name);
    if (kind === 'directory') fs.mkdirSync(target);
    else fs.writeFileSync(target, 'unknown');

    assert.throws(
      () => store.read(),
      (error) => (
        error.code === 'CONTROL_STORE_CORRUPT'
        && /unknown control store entry/i.test(error.message)
      ),
      name,
    );
    fs.rmSync(target, { recursive: true, force: true });
  }
});

for (const classifierIoCase of [
  { method: 'lstatSync', code: 'EIO', name: 'lstat' },
  { method: 'readdirSync', code: 'EACCES', name: 'readdir' },
]) {
  test(`pure-v1 existing-directory classifier maps ${classifierIoCase.name} failure to CONTROL_STORE_IO zero-write`, (t) => {
    const controlDir = createControlDir(t);
    const root = path.dirname(controlDir);
    const before = snapshotTree(root);
    const marker = Object.assign(new Error(`classifier ${classifierIoCase.name} failed`), {
      code: classifierIoCase.code,
    });
    const original = fs[classifierIoCase.method];
    fs[classifierIoCase.method] = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(controlDir)) throw marker;
      return original(target, ...args);
    };
    let mutationCalls;
    try {
      mutationCalls = withFsMutationLog(() => {
        assert.throws(
          () => openControlStore(controlDir),
          (error) => error.code === 'CONTROL_STORE_IO' && error.cause === marker,
        );
      });
    } finally {
      fs[classifierIoCase.method] = original;
    }

    assert.deepEqual(mutationCalls, []);
    assert.deepEqual(snapshotTree(root), before);
  });
}

test('open and read map mkdir, readdir, and event-read failures to CONTROL_STORE_IO', (t) => {
  const parentDir = createControlDir(t);
  const mkdirTarget = path.join(parentDir, 'mkdir-failure');
  const mkdirError = Object.assign(new Error('mkdir denied'), { code: 'EACCES' });
  const originalMkdirSync = fs.mkdirSync;
  fs.mkdirSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(mkdirTarget)) throw mkdirError;
    return originalMkdirSync(target, ...args);
  };
  try {
    assert.throws(
      () => openControlStore(mkdirTarget),
      (error) => error.code === 'CONTROL_STORE_IO' && error.cause === mkdirError,
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }

  const controlDir = path.join(parentDir, 'read-failures');
  const store = openControlStore(controlDir);
  store.append({ type: 'seed', payload: {} });
  const readdirError = Object.assign(new Error('readdir denied'), { code: 'EACCES' });
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(controlDir)) throw readdirError;
    return originalReaddirSync(target, ...args);
  };
  try {
    assert.throws(
      () => store.read(),
      (error) => error.code === 'CONTROL_STORE_IO' && error.cause === readdirError,
    );
  } finally {
    fs.readdirSync = originalReaddirSync;
  }

  const eventPath = path.join(controlDir, eventFiles(controlDir)[0]);
  const readError = Object.assign(new Error('read denied'), { code: 'EIO' });
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (target, ...args) => {
    if (path.resolve(String(target)) === path.resolve(eventPath)) throw readError;
    return originalReadFileSync(target, ...args);
  };
  try {
    assert.throws(
      () => store.read(),
      (error) => error.code === 'CONTROL_STORE_IO' && error.cause === readError,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test('append preserves a write primary while attaching a temp cleanup failure', (t) => {
  const controlDir = createControlDir(t);
  const store = openControlStore(controlDir);
  const writeError = Object.assign(new Error('temp write failed'), { code: 'EIO' });
  const cleanupError = Object.assign(new Error('temp cleanup failed'), { code: 'EACCES' });
  const originalWriteFileSync = fs.writeFileSync;
  const originalRmSync = fs.rmSync;
  let tempPath;

  fs.writeFileSync = (target, ...args) => {
    if (String(target).startsWith(controlDir) && String(target).endsWith('.tmp')) {
      tempPath = String(target);
      throw writeError;
    }
    return originalWriteFileSync(target, ...args);
  };
  fs.rmSync = (target, ...args) => {
    if (tempPath && path.resolve(String(target)) === path.resolve(tempPath)) {
      throw cleanupError;
    }
    return originalRmSync(target, ...args);
  };

  try {
    assert.throws(
      () => store.append({ type: 'write-failure', payload: {} }),
      (error) => (
        error.code === 'CONTROL_STORE_IO'
        && error.cause === writeError
        && error.cleanupError?.code === 'CONTROL_STORE_IO'
        && error.cleanupError.cause === cleanupError
        && error.secondaryErrors?.includes(error.cleanupError)
      ),
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync = originalRmSync;
  }

  assert.equal(store.tail(), null);
  assert.deepEqual(controlTempFiles(controlDir), []);
});

for (const scenario of [
  {
    faultPoint: FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH,
    expectedLength: 2,
    expectedNextSeq: 3,
  },
  {
    faultPoint: FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC,
    expectedLength: 3,
    expectedNextSeq: 4,
  },
]) {
  test(`real crash at ${scenario.faultPoint} preserves only complete events`, async (t) => {
    const controlDir = createControlDir(t);
    const seedStore = openControlStore(controlDir);
    seedStore.append({ type: 'first', payload: { value: 1 } });
    seedStore.append({ type: 'second', payload: { value: 2 } });

    const crash = await runUntilCrash({
      script: path.join(__dirname, 'fixtures', 'control-store-crash.js'),
      faults: { [scenario.faultPoint]: { crash: true } },
      env: { MYTHPEN_CONTROL_STORE_CRASH_DIR: controlDir },
    });
    t.after(() => crash.cleanup());

    assert.equal(crash.crashPoint.name, scenario.faultPoint);
    assert.equal(crash.artifacts.controlDir, controlDir);
    const reopened = openControlStore(crash.artifacts.controlDir);
    const recovered = reopened.read();
    assert.equal(recovered.length, scenario.expectedLength);
    assert.ok(recovered.every((event, index) => (
      index === 0 ? event.prevDigest === null : event.prevDigest === recovered[index - 1].digest
    )));

    const resumed = reopened.append({ type: 'after-crash', payload: { recovered: true } });
    assert.equal(resumed.seq, scenario.expectedNextSeq);
    assert.equal(reopened.tail().digest, resumed.digest);
  });
}

for (const crashCase of [
  {
    scenario: 'bootstrap',
    faultPoint: BOUNDED_TAIL_BEFORE_PUBLISH,
    inspectorRecovery: true,
    recoveredCount: 2,
    nextSeq: 3,
  },
  {
    scenario: 'bootstrap',
    faultPoint: BOUNDED_TAIL_BEFORE_DIR_FSYNC,
    inspectorRecovery: false,
    recoveredCount: 2,
    nextSeq: 3,
  },
  {
    scenario: 'append',
    faultPoint: FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH,
    inspectorRecovery: true,
    recoveredCount: 2,
    nextSeq: 3,
  },
  {
    scenario: 'append',
    faultPoint: FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC,
    inspectorRecovery: true,
    recoveredCount: 3,
    nextSeq: 4,
  },
  {
    scenario: 'append',
    faultPoint: BOUNDED_TAIL_BEFORE_PUBLISH,
    inspectorRecovery: true,
    recoveredCount: 3,
    nextSeq: 4,
  },
  {
    scenario: 'append',
    faultPoint: BOUNDED_TAIL_BEFORE_DIR_FSYNC,
    inspectorRecovery: false,
    recoveredCount: 3,
    nextSeq: 4,
  },
]) {
  test(`bounded real SIGKILL ${crashCase.scenario} at ${crashCase.faultPoint} uniquely converges`, { timeout: 30_000 }, async (t) => {
    const controlDir = createControlDir(t);
    const seed = crashCase.scenario === 'bootstrap'
      ? openControlStore(controlDir)
      : openControlStore(controlDir, { bounded: true });
    seed.append({ type: 'bounded.seed.first', payload: { value: 1 } });
    seed.append({ type: 'bounded.seed.second', payload: { value: 2 } });

    const crash = await runUntilCrash({
      script: path.join(__dirname, 'fixtures', 'control-store-crash.js'),
      faults: { [crashCase.faultPoint]: { crash: true } },
      env: {
        MYTHPEN_CONTROL_STORE_CRASH_DIR: controlDir,
        MYTHPEN_CONTROL_STORE_CRASH_SCENARIO: crashCase.scenario,
      },
    });
    t.after(() => crash.cleanup());

    assert.deepEqual(crash.artifacts, {
      version: 1,
      scenario: crashCase.scenario,
      controlDir,
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
    const expectedContextKeys = crashCase.faultPoint === FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH
      ? ['digest', 'seq', 'targetPath', 'tempPath']
      : crashCase.faultPoint === FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC
        ? ['digest', 'seq', 'targetPath']
        : crashCase.faultPoint === BOUNDED_TAIL_BEFORE_PUBLISH
          ? ['recordDigest', 'targetPath', 'tempPath']
          : ['recordDigest', 'targetPath'];
    assert.deepEqual(Object.keys(crash.crashPoint.context).sort(), expectedContextKeys.sort());

    const root = path.dirname(controlDir);
    const beforeInspector = snapshotTree(root);
    let inspected = null;
    const inspectorCalls = withFsMutationLog(() => {
      if (crashCase.inspectorRecovery) {
        assert.throws(
          () => inspectControlStoreEvidence(controlDir),
          { code: 'RECOVERY_REQUIRED' },
        );
      } else {
        inspected = inspectControlStoreEvidence(controlDir);
      }
    });
    assert.deepEqual(inspectorCalls, []);
    assert.deepEqual(snapshotTree(root), beforeInspector);
    if (inspected) assert.equal(inspected.events.length, crashCase.recoveredCount);

    const recovered = openControlStore(controlDir, { bounded: true });
    const evidence = recovered.readEvidence();
    assert.equal(evidence.events.length, crashCase.recoveredCount);
    assert.deepEqual(evidence.events.slice(0, 2).map((event) => event.type), [
      'bounded.seed.first',
      'bounded.seed.second',
    ]);
    if (crashCase.recoveredCount === 3) {
      assert.equal(evidence.events[2].type, 'bounded.crash-candidate');
    }
    assert.ok(evidence.events.every((event, index) => (
      event.seq === index + 1
      && event.prevDigest === (index === 0 ? null : evidence.events[index - 1].digest)
    )));
    assert.equal(evidence.tail.tailSeq, crashCase.recoveredCount);
    assert.equal(evidence.tail.tailDigest, evidence.events.at(-1).digest);
    assert.equal(evidence.tail.activeEventCount, crashCase.recoveredCount);
    assert.equal(
      evidence.tail.activeEventBytes,
      evidence.events.reduce(
        (sum, event) => sum + Buffer.byteLength(canonicalJson(event), 'utf8'),
        0,
      ),
    );
    assert.equal(eventFiles(controlDir).length, crashCase.recoveredCount);
    assert.deepEqual(controlTempFiles(controlDir), []);

    const afterFirstReopen = snapshotTree(root);
    const secondReopen = openControlStore(controlDir, { bounded: true });
    assert.deepEqual(secondReopen.readEvidence(), evidence);
    assert.deepEqual(snapshotTree(root), afterFirstReopen);

    const resumed = secondReopen.append({
      type: 'bounded.after-crash',
      payload: { recovered: true },
    });
    assert.equal(resumed.seq, crashCase.nextSeq);
    const finalEvidence = secondReopen.readEvidence();
    assert.equal(finalEvidence.events.length, crashCase.recoveredCount + 1);
    assert.equal(finalEvidence.events.at(-1).prevDigest, evidence.tail.tailDigest);
    assert.equal(finalEvidence.tail.tailSeq, crashCase.nextSeq);
    assert.equal(eventFiles(controlDir).length, crashCase.recoveredCount + 1);
    assert.deepEqual(controlTempFiles(controlDir), []);
  });
}
