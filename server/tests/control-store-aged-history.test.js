const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHash, randomUUID } = crypto;
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Database } = require('bun:sqlite');

const { openControlStore } = require('../control-store');
const { createDatabaseIdentityGuard } = require('../native/database-identity-guard');
const { createNativeProjectStoreCore } = require('../native/native-project-store');
const projectWriteCoordinatorModule = require('../project-write-coordinator');
const { createProjectWriteCoordinator } = projectWriteCoordinatorModule;
const { createNativeStageBFixture } = require('../testing/native-stage-b-fixture');
const { createStageBFixtureStore } = require('../testing/native-stage-b-store');
const {
  createBoundedControlStoreTestHarness,
} = require('../testing/bounded-control-store');

const NATIVE_FACADE_KEYS = [
  'connectionEpoch',
  'state',
  'readAll',
  'readGet',
  'executeTransaction',
  'recover',
  'checkpoint',
  'close',
  'fence',
];

function nativeFixture(t, name) {
  const fixture = createNativeStageBFixture({ name });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  return fixture;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function cloneData(value) {
  return JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function epochFilterPositions(basisDigest, epoch) {
  const domain = Buffer.from('mythpen-controlstore-connection-epoch-v1\0', 'utf8');
  const basis = Buffer.from(basisDigest, 'hex');
  const normalizedEpoch = Buffer.from(epoch.toLowerCase(), 'ascii');
  return Array.from({ length: 7 }, (_unused, index) => {
    const digest = createHash('sha256').update(Buffer.concat([
      domain,
      Buffer.from([index]),
      basis,
      normalizedEpoch,
    ])).digest();
    return (((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 1);
  });
}

function filterHasEpoch(filterBytes, basisDigest, epoch) {
  return epochFilterPositions(basisDigest, epoch).every(
    (bit) => (filterBytes[bit >>> 3] & (1 << (bit & 7))) !== 0,
  );
}

function findBloomNegative(filterBytes, basisDigest, excluded) {
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const candidate = randomUUID().toLowerCase();
    if (!excluded.has(candidate) && !filterHasEpoch(filterBytes, basisDigest, candidate)) {
      return candidate;
    }
  }
  throw new Error('Unable to find a Bloom-negative UUID-v4 candidate');
}

function createCheckpointAuthority(controlStore, genesis, epochObservations) {
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
    epochObservations: [...epochObservations],
  });
}

function installNativeCheckpoint(fixture, epochObservations) {
  let authority;
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDirectory,
    () => authority,
  );
  const before = harness.controlStore.readEvidence();
  const genesis = before.checkpoint?.admissionBasis.admissionEvent || before.events[0];
  authority = createCheckpointAuthority(harness.controlStore, genesis, epochObservations);
  const receipt = harness.checkpoint();
  const after = harness.controlStore.readEvidence();
  assert.equal(after.checkpoint.checkpointDigest, receipt.checkpointDigest);
  assert.equal(after.checkpoint.coveredSeq, receipt.coveredSeq);
  assert.deepEqual(after.events, []);
  return { controlStore: harness.controlStore, evidence: after, genesis, receipt };
}

function installNativeBloomCheckpoint(fixture) {
  let authority;
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDirectory,
    () => authority,
  );
  const [genesis] = harness.controlStore.read();
  const epochs = [genesis.payload.connectionEpoch.toLowerCase()];
  while (epochs.length < 128) {
    epochs.push(randomUUID().toLowerCase());
    harness.controlStore.append({
      type: 'task7.bloom.covered-fixture',
      payload: { ordinal: epochs.length },
    });
  }
  authority = createCheckpointAuthority(harness.controlStore, genesis, epochs);
  harness.checkpoint();
  const evidence = harness.controlStore.readEvidence();
  assert.equal(evidence.checkpoint.coveredSeq, 128);
  assert.deepEqual(evidence.events, []);
  const filterBytes = Buffer.from(
    evidence.checkpoint.connectionEpochFilter.bitsBase64,
    'base64',
  );
  assert.equal(filterBytes.length, 1_048_576);
  for (const epoch of epochs) {
    assert.equal(filterHasEpoch(filterBytes, genesis.digest, epoch), true);
  }
  return { controlStore: harness.controlStore, evidence, epochs, filterBytes, genesis };
}

function commonNativePayload(genesis, connectionEpoch) {
  return {
    version: 1,
    eventId: randomUUID(),
    dbKey: genesis.payload.dbKey,
    projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
    createdAt: new Date().toISOString(),
    ownershipHash: genesis.payload.ownershipHash,
    connectionEpoch,
  };
}

function appendNativeSource(controlStore, genesis, options = {}) {
  const connectionEpoch = options.connectionEpoch || randomUUID();
  const logicalRequestDigest = options.logicalRequestDigest || sha256(`logical:${randomUUID()}`);
  const payload = {
    ...commonNativePayload(genesis, connectionEpoch),
    logicalRequestDigest,
    attemptSeq: options.attemptSeq || 1,
    previousAttemptSourceDigest: options.previousAttemptSourceDigest ?? null,
    operationKind: 'chapter_body_write',
    targetKind: 'chapter',
    targetIdSha256: sha256(`chapter:${randomUUID()}`),
    expectedDataVersion: null,
  };
  const source = controlStore.append({ type: 'manuscript.source', payload });
  return { connectionEpoch, logicalRequestDigest, source };
}

function appendNativeAbandoned(controlStore, genesis, source, connectionEpoch) {
  return controlStore.append({
    type: 'manuscript.source.abandoned',
    payload: {
      ...commonNativePayload(genesis, connectionEpoch),
      sourceDigest: source.digest,
      reasonCode: 'cancelled',
    },
  });
}

function openCheckpointAwareNativeCore(fixture, controlStore, options = {}) {
  const boundedEvidence = controlStore.readEvidence();
  const admissionEvent = boundedEvidence.checkpoint?.admissionBasis.admissionEvent
    || boundedEvidence.events[0];
  const admissionEvidenceCalls = [];
  const createCore = options.createCore || createNativeProjectStoreCore;
  const store = createCore({
    databasePath: fixture.databasePath,
    controlStore,
    dbKey: admissionEvent.payload.dbKey,
    projectInstanceIdSha256: admissionEvent.payload.projectInstanceIdSha256,
    ownershipHash: admissionEvent.payload.ownershipHash,
    assertWriterLease: () => true,
    ...(options.sqliteFactory ? { sqliteFactory: options.sqliteFactory } : {}),
    admissionVerifier({ evidence }) {
      admissionEvidenceCalls.push(evidence);
      if (
        evidence.length !== 1
        || evidence[0].digest !== fixture.genesisDigest
        || evidence[0].payload?.fixtureRunId !== fixture.fixtureRunId
      ) {
        throw new Error('fixture admission event changed');
      }
      return Object.freeze({
        basisKind: 'stage_b_fixture_genesis',
        basisDigest: fixture.genesisDigest,
      });
    },
  });
  return { admissionEvidenceCalls, store };
}

function withFreshNativeRandomUuid(candidates, callback) {
  const nativeModulePath = require.resolve('../native/native-project-store');
  const cachedNativeModule = require.cache[nativeModulePath];
  const originalDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  let calls = 0;
  Object.defineProperty(crypto, 'randomUUID', {
    ...originalDescriptor,
    value() {
      const candidate = candidates[calls];
      calls += 1;
      if (candidate === undefined) throw new Error('fresh UUID candidate sequence exhausted');
      return candidate;
    },
  });
  try {
    delete require.cache[nativeModulePath];
    const freshNative = require(nativeModulePath);
    return callback({
      createCore: freshNative.createNativeProjectStoreCore,
      get calls() {
        return calls;
      },
    });
  } finally {
    Object.defineProperty(crypto, 'randomUUID', originalDescriptor);
    delete require.cache[nativeModulePath];
    if (cachedNativeModule) require.cache[nativeModulePath] = cachedNativeModule;
  }
}

function assertEveryAdmissionReauthenticatesGenesis(runtime, genesis) {
  assert.equal(runtime.admissionEvidenceCalls.length > 0, true);
  for (const evidence of runtime.admissionEvidenceCalls) {
    assert.deepEqual(evidence, [genesis]);
  }
}

function snapshotTree(root) {
  const entries = [];
  function visit(current, relative) {
    const stats = fs.lstatSync(current);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      entries.push({ kind: 'directory', path: relative });
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? path.join(relative, name) : name);
      }
      return;
    }
    if (stats.isFile()) {
      entries.push({
        digest: sha256(fs.readFileSync(current)),
        kind: 'file',
        path: relative,
      });
      return;
    }
    entries.push({
      kind: stats.isSymbolicLink() ? 'link' : 'other',
      path: relative,
    });
  }
  visit(root, '');
  return entries;
}

function snapshotAuthority(fixture) {
  return {
    control: snapshotTree(fixture.controlDirectory),
    databaseDigest: sha256(fs.readFileSync(fixture.databasePath)),
  };
}

function isWithin(root, candidate) {
  if (typeof candidate !== 'string' && !Buffer.isBuffer(candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(String(candidate)));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function withFixtureFsForbidden(fixture, callback) {
  const methodNames = [
    'accessSync',
    'appendFileSync',
    'existsSync',
    'linkSync',
    'lstatSync',
    'mkdirSync',
    'openSync',
    'readFileSync',
    'readlinkSync',
    'readdirSync',
    'renameSync',
    'rmSync',
    'statSync',
    'unlinkSync',
    'writeFileSync',
  ];
  const originals = new Map();
  function forbidFixturePath(methodName, original, receiver, args) {
    if (isWithin(fixture.root, args[0])) {
      const error = new Error(
        'filesystem ' + methodName + ' reached fixture before bounded validation',
      );
      error.code = 'TEST_PREVALIDATION_FS_TOUCHED';
      throw error;
    }
    return original.apply(receiver, args);
  }
  for (const methodName of methodNames) {
    const original = fs[methodName];
    originals.set(methodName, original);
    fs[methodName] = function guardedFixtureFs(...args) {
      return forbidFixturePath(methodName, original, this, args);
    };
  }
  const originalRealpathSync = fs.realpathSync;
  const originalRealpathNative = fs.realpathSync.native;
  function guardedRealpathSync(...args) {
    return forbidFixturePath('realpathSync', originalRealpathSync, fs, args);
  }
  guardedRealpathSync.native = function guardedRealpathNative(...args) {
    return forbidFixturePath('realpathSync.native', originalRealpathNative, fs, args);
  };
  fs.realpathSync = guardedRealpathSync;
  try {
    return callback();
  } finally {
    fs.realpathSync = originalRealpathSync;
    for (const [methodName, original] of originals) fs[methodName] = original;
  }
}

function closeV1(store) {
  if (store?.state === 'active') store.close();
}

function closeBounded(result) {
  if (result?.store?.state === 'active') {
    result.withProjectLogicalRequestSync(() => result.store.close());
  }
}

function createCheckpointRunnerCore(fixture, checkpointRunner) {
  const controlStore = openControlStore(fixture.controlDirectory, { bounded: true });
  const [genesis] = controlStore.read();
  const store = createNativeProjectStoreCore({
    databasePath: fixture.databasePath,
    controlStore,
    dbKey: genesis.payload.dbKey,
    projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
    ownershipHash: genesis.payload.ownershipHash,
    assertWriterLease: () => true,
    checkpointRunner,
    admissionVerifier({ evidence }) {
      if (evidence.length !== 1 || evidence[0].digest !== genesis.digest) {
        throw new Error('fixture genesis changed');
      }
      return {
        basisKind: 'stage_b_fixture_genesis',
        basisDigest: genesis.digest,
      };
    },
  });
  return { controlStore, genesis, store };
}

function appendCheckpointGateSource(fixture, runtime) {
  const payload = {
    version: 1,
    eventId: randomUUID(),
    dbKey: runtime.genesis.payload.dbKey,
    projectInstanceIdSha256: runtime.genesis.payload.projectInstanceIdSha256,
    createdAt: new Date().toISOString(),
    ownershipHash: runtime.genesis.payload.ownershipHash,
    connectionEpoch: runtime.store.connectionEpoch,
    logicalRequestDigest: sha256(`checkpoint-gate:${fixture.fixtureRunId}`),
    attemptSeq: 1,
    previousAttemptSourceDigest: null,
    operationKind: 'chapter_body_write',
    targetKind: 'chapter',
    targetIdSha256: sha256(`chapter:${fixture.fixtureRunId}`),
    expectedDataVersion: null,
  };
  const source = runtime.controlStore.compareAndAppend(runtime.controlStore.tail().digest, {
    type: 'manuscript.source',
    payload,
  });
  return {
    source,
    input: {
      sourceDigest: source.digest,
      operationKind: payload.operationKind,
      logicalRequestDigest: payload.logicalRequestDigest,
      attemptSeq: payload.attemptSeq,
    },
  };
}

function completeBoundedLogicalRequest(fixture, bounded, label) {
  const controlStore = openControlStore(fixture.controlDirectory, { bounded: true });
  const initialEvidence = controlStore.readEvidence();
  const genesis = initialEvidence.checkpoint?.admissionBasis.admissionEvent
    || initialEvidence.events[0];
  let source;
  const callbackResult = bounded.withProjectLogicalRequestSync(() => {
    source = appendNativeSource(controlStore, genesis, {
      connectionEpoch: bounded.store.connectionEpoch,
      logicalRequestDigest: sha256(`task7-b3-logical:${fixture.fixtureRunId}:${label}`),
    });
    return bounded.store.executeTransaction({
      sourceDigest: source.source.digest,
      operationKind: 'chapter_body_write',
      logicalRequestDigest: source.logicalRequestDigest,
      attemptSeq: 1,
    }, () => `${label}:complete`);
  });
  assert.equal(callbackResult, `${label}:complete`);
  const evidence = controlStore.readEvidence();
  assert.equal(evidence.events.at(-1).type, 'sqlite.tx.committed');
  const storedSource = evidence.events.find(({ digest }) => digest === source.source.digest);
  assert.equal(storedSource.type, 'manuscript.source');
  return { controlStore, evidence, genesis, source: storedSource };
}

function seedSoftNativeHistory(fixture) {
  const controlStore = openControlStore(fixture.controlDirectory, { bounded: true });
  const initial = controlStore.readEvidence();
  assert.equal(initial.checkpoint, null);
  assert.equal(initial.events.length, 1);
  const genesis = initial.events[0];
  let seq = initial.tail.tailSeq;
  let previousDigest = initial.tail.tailDigest;
  let activeEventBytes = initial.tail.activeEventBytes;
  const connectionEpoch = randomUUID();

  function writeEvent(type, payload) {
    seq += 1;
    const withoutDigest = { seq, type, payload, prevDigest: previousDigest };
    const digest = sha256(canonicalJson(withoutDigest));
    const event = { ...withoutDigest, digest };
    const serialized = canonicalJson(event);
    fs.writeFileSync(
      path.join(fixture.controlDirectory, `${seq}-${digest}.json`),
      serialized,
    );
    activeEventBytes += Buffer.byteLength(serialized, 'utf8');
    previousDigest = digest;
    return event;
  }

  for (let index = 0; index < 2_046; index += 1) {
    const logicalRequestDigest = sha256(`task7-b3-soft:${fixture.fixtureRunId}:${index}`);
    const source = writeEvent('manuscript.source', {
      ...commonNativePayload(genesis, connectionEpoch),
      logicalRequestDigest,
      attemptSeq: 1,
      previousAttemptSourceDigest: null,
      operationKind: 'chapter_body_write',
      targetKind: 'chapter',
      targetIdSha256: sha256(`task7-b3-soft-target:${fixture.fixtureRunId}:${index}`),
      expectedDataVersion: null,
    });
    writeEvent('manuscript.source.abandoned', {
      ...commonNativePayload(genesis, connectionEpoch),
      sourceDigest: source.digest,
      reasonCode: 'cancelled',
    });
  }

  const tailWithoutDigest = {
    version: initial.tail.version,
    controlProtocolEpoch: initial.tail.controlProtocolEpoch,
    incarnationId: initial.tail.incarnationId,
    checkpointFile: initial.tail.checkpointFile,
    checkpointDigest: initial.tail.checkpointDigest,
    coveredSeq: initial.tail.coveredSeq,
    coveredDigest: initial.tail.coveredDigest,
    tailSeq: seq,
    tailDigest: previousDigest,
    activeEventCount: initial.tail.activeEventCount + 4_092,
    activeEventBytes,
  };
  const tail = {
    ...tailWithoutDigest,
    recordDigest: sha256(canonicalJson(tailWithoutDigest)),
  };
  fs.writeFileSync(
    path.join(fixture.controlDirectory, '.controlstore-tail.json'),
    canonicalJson(tail),
  );
  assert.equal(tail.activeEventCount, 4_093);
}

function separatelyLoadedCoordinator(lockRoot) {
  const modulePath = require.resolve('../project-write-coordinator');
  const cachedModule = require.cache[modulePath];
  try {
    delete require.cache[modulePath];
    return require(modulePath).createProjectWriteCoordinator({ lockRoot });
  } finally {
    delete require.cache[modulePath];
    require.cache[modulePath] = cachedModule;
  }
}

test('Task 7 B0 control: default-v1 factory keeps its direct frozen facade and bytes', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b0-default-v1');
  const before = snapshotAuthority(fixture);
  let leaseAssertions = 0;
  let sqliteFactoryCalls = 0;
  function assertWriterLease() {
    leaseAssertions += 1;
    return true;
  }
  function sqliteFactory(databasePath) {
    sqliteFactoryCalls += 1;
    assert.equal(path.resolve(databasePath), path.resolve(fixture.databasePath));
    return new Database(databasePath, { create: false, strict: true });
  }
  const cases = [
    {
      name: 'omitted options',
      create() {
        return createStageBFixtureStore(fixture);
      },
    },
    {
      name: 'assertWriterLease only',
      create() {
        return createStageBFixtureStore(fixture, { assertWriterLease });
      },
    },
    {
      name: 'sqliteFactory only',
      create() {
        return createStageBFixtureStore(fixture, { sqliteFactory });
      },
    },
    {
      name: 'assertWriterLease plus sqliteFactory',
      create() {
        return createStageBFixtureStore(fixture, { assertWriterLease, sqliteFactory });
      },
    },
  ];

  for (const current of cases) {
    const store = current.create();
    assert.deepEqual(Object.keys(store), NATIVE_FACADE_KEYS, current.name);
    assert.ok(Object.isFrozen(store), current.name);
    assert.deepEqual(
      store.readGet("SELECT value FROM project_meta WHERE key = 'schema_version'"),
      { value: '11' },
      current.name,
    );
    closeV1(store);
    assert.equal(store.state, 'released', current.name);
    assert.deepEqual(snapshotAuthority(fixture), before, current.name);
  }
  assert.ok(leaseAssertions > 0);
  assert.equal(sqliteFactoryCalls, 2);
});

test('Task 7 B0 RED: every bounded selector routes before getter, filesystem, or lease', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b0-bounded-options');
  let leaseCalls = 0;
  let lockRootCalls = 0;
  let getterReads = 0;
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      leaseCalls += 1;
      throw new Error('invalid bounded options must not acquire a lease');
    },
    lockRoot() {
      lockRootCalls += 1;
      return path.join(fixture.root, 'locks');
    },
  });
  const foreign = separatelyLoadedCoordinator(() => {
    lockRootCalls += 1;
    return path.join(fixture.root, 'foreign-locks');
  });
  const duck = {
    assertProjectWriteLease: coordinator.assertProjectWriteLease,
    runPendingProjectMaintenanceSync() {},
    withProjectLogicalRequestSync() {},
  };
  const ownAccessor = {};
  Object.defineProperty(ownAccessor, 'bounded', {
    enumerable: true,
    get() {
      getterReads += 1;
      return true;
    },
  });
  const inheritedData = Object.create({ bounded: true });
  const inheritedAccessorPrototype = {};
  Object.defineProperty(inheritedAccessorPrototype, 'bounded', {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error('bounded selector getter must not run');
    },
  });
  const inheritedAccessor = Object.create(inheritedAccessorPrototype);
  const ownNonEnumerable = {};
  Object.defineProperty(ownNonEnumerable, 'bounded', {
    enumerable: false,
    value: true,
  });
  assert.deepEqual(Reflect.ownKeys(inheritedData), []);
  assert.deepEqual(Reflect.ownKeys(inheritedAccessor), []);
  assert.deepEqual(Object.keys(ownNonEnumerable), []);
  const nullPrototype = Object.assign(Object.create(null), {
    bounded: true,
    coordinator,
  });
  const withSymbol = { bounded: true, coordinator };
  withSymbol[Symbol('forbidden')] = true;
  const tamperedCoordinator = createProjectWriteCoordinator({
    lockRoot() {
      lockRootCalls += 1;
      return path.join(fixture.root, 'tampered-locks');
    },
  });
  const originalLogicalRequest = tamperedCoordinator.withProjectLogicalRequestSync;
  try {
    Object.defineProperty(tamperedCoordinator, 'withProjectLogicalRequestSync', {
      configurable: true,
      enumerable: true,
      value(_projectKey, callback) {
        return callback({
          assertLease() {
            return true;
          },
        });
      },
      writable: true,
    });
  } catch (error) {
    assert.ok(error instanceof TypeError);
  }
  const tamperedIdentity = tamperedCoordinator.withProjectLogicalRequestSync
    !== originalLogicalRequest;
  const cases = [
    { name: 'bounded false', options: { bounded: false, coordinator } },
    { name: 'missing coordinator', options: { bounded: true } },
    {
      name: 'assertWriterLease override',
      options: { bounded: true, coordinator, assertWriterLease() {} },
    },
    {
      name: 'non-function sqliteFactory',
      options: { bounded: true, coordinator, sqliteFactory: 'not-a-function' },
    },
    { name: 'custom null prototype', options: nullPrototype },
    { name: 'own accessor selector', options: ownAccessor },
    { name: 'inherited data selector with no own keys', options: inheritedData },
    { name: 'inherited throwing accessor with no own keys', options: inheritedAccessor },
    { name: 'own non-enumerable selector', options: ownNonEnumerable },
    { name: 'symbol key', options: withSymbol },
    { name: 'extra key', options: { bounded: true, coordinator, extra: true } },
    { name: 'duck coordinator', options: { bounded: true, coordinator: duck } },
    { name: 'cross-module coordinator', options: { bounded: true, coordinator: foreign } },
  ];
  if (tamperedIdentity) {
    cases.push({
      name: 'tampered branded coordinator',
      options: { bounded: true, coordinator: tamperedCoordinator },
    });
  }
  const before = snapshotAuthority(fixture);

  const observed = [];
  for (const current of cases) {
    let code = 'NO_THROW';
    try {
      withFixtureFsForbidden(fixture, () => {
        createStageBFixtureStore(fixture, current.options);
      });
    } catch (error) {
      code = error?.code || error?.name || typeof error;
    }
    observed.push({ name: current.name, code });
  }

  assert.deepEqual(
    observed,
    cases.map((current) => ({
      name: current.name,
      code: 'NATIVE_ACTIVATION_DISABLED',
    })),
  );

  assert.equal(getterReads, 0);
  assert.equal(lockRootCalls, 0);
  assert.equal(leaseCalls, 0);
  assert.equal(
    projectWriteCoordinatorModule.isProjectWriteCoordinator(tamperedCoordinator),
    !tamperedIdentity,
  );
  assert.deepEqual(snapshotAuthority(fixture), before);
});

test('Task 7 B0 RED: exact bounded factory constructs inside one logical lease', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b0-bounded-construction');
  let recoverCalls = 0;
  let sqliteFactoryCalls = 0;
  const trace = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      let held = true;
      return {
        isHeld() {
          return held;
        },
        release() {
          trace.push('lease:release');
          held = false;
        },
      };
    },
    lockRoot: path.join(fixture.root, 'locks'),
    recoverProject() {
      recoverCalls += 1;
    },
  });
  let bounded;
  try {
    bounded = createStageBFixtureStore(fixture, {
      bounded: true,
      coordinator,
      sqliteFactory(databasePath) {
        trace.push('construction:callback');
        sqliteFactoryCalls += 1;
        assert.equal(coordinator.assertProjectWriteLease(fixture.databasePath), true);
        assert.equal(path.resolve(databasePath), path.resolve(fixture.databasePath));
        return new Database(databasePath, { create: false, strict: true });
      },
    });
    trace.push('factory:return');

    assert.deepEqual(trace, ['construction:callback', 'lease:release', 'factory:return']);
    assert.equal(recoverCalls, 0);
    assert.equal(sqliteFactoryCalls, 1);
    assert.equal(coordinator.leaseAcquisitionCount(fixture.databasePath), 1);
    assert.deepEqual(Object.keys(bounded), ['store', 'withProjectLogicalRequestSync']);
    assert.ok(Object.isFrozen(bounded));
    assert.equal(bounded.withProjectLogicalRequestSync.length, 1);
    assert.deepEqual(Object.keys(bounded.store), NATIVE_FACADE_KEYS);
    assert.ok(Object.isFrozen(bounded.store));
    assert.equal(bounded.store.checkpoint.length, 0);
    const authorityAfterConstruction = snapshotAuthority(fixture);
    assert.throws(
      () => bounded.store.recover(),
      (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
      'the construction callback dynamic slot must be cleared before the wrapper returns',
    );
    assert.equal(bounded.store.state, 'active');
    assert.deepEqual(snapshotAuthority(fixture), authorityAfterConstruction);
    assert.throws(
      () => coordinator.assertProjectWriteLease(fixture.databasePath),
      (error) => error?.code === 'WRITER_LEASE_LOST',
    );
  } finally {
    closeBounded(bounded);
  }
});

test('Task 7 B0 RED: construction release failure never returns a bounded wrapper', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b0-construction-release');
  const releaseMarker = new Error('injected logical construction release failure');
  const trace = [];
  let rawDatabase;
  let databaseClosed = false;
  let escaped;
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      return {
        isHeld() {
          return true;
        },
        release() {
          trace.push('lease:release');
          throw releaseMarker;
        },
      };
    },
    lockRoot: path.join(fixture.root, 'locks'),
  });
  const prebootstrapped = openControlStore(fixture.controlDirectory, { bounded: true });
  const stableEvidence = prebootstrapped.readEvidence();
  assert.equal(stableEvidence.tail.tailSeq, 1);
  const before = snapshotAuthority(fixture);
  t.after(() => {
    if (!databaseClosed) {
      try {
        rawDatabase?.close(true);
      } catch {
        // Preserve the primary test result while ensuring fixture cleanup can proceed.
      }
    }
  });

  assert.throws(
    () => {
      escaped = createStageBFixtureStore(fixture, {
        bounded: true,
        coordinator,
        sqliteFactory(databasePath) {
          trace.push('construction:callback');
          rawDatabase = new Database(databasePath, { create: false, strict: true });
          return {
            get inTransaction() {
              return rawDatabase.inTransaction;
            },
            query(sql) {
              return rawDatabase.query(sql);
            },
            exec(sql) {
              return rawDatabase.exec(sql);
            },
            close() {
              trace.push('database:close');
              databaseClosed = true;
              return rawDatabase.close(true);
            },
          };
        },
      });
    },
    (error) => error?.code === 'WRITER_LEASE_LOST' && error.cause === releaseMarker,
  );

  assert.equal(escaped, undefined);
  assert.equal(databaseClosed, true);
  assert.deepEqual(trace, [
    'construction:callback',
    'lease:release',
    'database:close',
  ]);
  assert.deepEqual(snapshotAuthority(fixture), before);
});

test('Task 7 B0 RED: bounded wrapper owns the dynamic slot and direct calls are zero-write reentrancy', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b0-bounded-wrapper');
  const leaseTrace = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      let held = true;
      return {
        isHeld() {
          return held;
        },
        release() {
          leaseTrace.push('lease:release');
          held = false;
        },
      };
    },
    lockRoot: path.join(fixture.root, 'locks'),
  });
  let bounded;
  try {
    bounded = createStageBFixtureStore(fixture, { bounded: true, coordinator });
    leaseTrace.length = 0;
    const exactResult = Object.freeze({ kind: 'callback-result' });
    const returned = bounded.withProjectLogicalRequestSync(function userCallback() {
      leaseTrace.push('callback');
      assert.equal(arguments.length, 0);
      assert.equal(coordinator.assertProjectWriteLease(fixture.databasePath), true);
      assert.deepEqual(
        bounded.store.readGet("SELECT value FROM project_meta WHERE key = 'schema_version'"),
        { value: '11' },
      );
      assert.equal(bounded.store.recover().status, 'clean');
      return exactResult;
    });
    leaseTrace.push('return');
    assert.equal(returned, exactResult);
    assert.deepEqual(leaseTrace, ['callback', 'lease:release', 'return']);

    const acquisitionCountBeforeNested = coordinator.leaseAcquisitionCount(fixture.databasePath);
    bounded.withProjectLogicalRequestSync(() => {
      assert.throws(
        () => bounded.withProjectLogicalRequestSync(() => 'nested'),
        (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
      );
    });
    assert.equal(
      coordinator.leaseAcquisitionCount(fixture.databasePath),
      acquisitionCountBeforeNested + 1,
    );

    const callbackMarker = new Error('injected logical callback failure');
    leaseTrace.length = 0;
    assert.throws(
      () => bounded.withProjectLogicalRequestSync(() => {
        leaseTrace.push('callback:throw');
        throw callbackMarker;
      }),
      (error) => error === callbackMarker,
    );
    assert.deepEqual(leaseTrace, ['callback:throw', 'lease:release']);
    assert.throws(
      () => bounded.store.recover(),
      (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
    );
    assert.equal(
      bounded.withProjectLogicalRequestSync(() => 'after-throw'),
      'after-throw',
    );

    leaseTrace.length = 0;
    assert.throws(
      () => bounded.withProjectLogicalRequestSync(() => {
        leaseTrace.push('callback:thenable');
        return Promise.resolve('async-result');
      }),
      (error) => error?.code === 'PROJECT_WRITE_ASYNC_CALLBACK',
    );
    assert.deepEqual(leaseTrace, ['callback:thenable', 'lease:release']);
    assert.throws(
      () => bounded.store.recover(),
      (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
    );
    assert.equal(
      bounded.withProjectLogicalRequestSync(() => 'after-thenable'),
      'after-thenable',
    );

    const before = snapshotAuthority(fixture);
    assert.deepEqual(
      bounded.store.readGet("SELECT value FROM project_meta WHERE key = 'schema_version'"),
      { value: '11' },
    );
    assert.deepEqual(snapshotAuthority(fixture), before);
    assert.throws(
      () => bounded.store.recover(),
      (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
    );
    assert.equal(bounded.store.state, 'active');
    let transactionCallbackCalls = 0;
    assert.throws(
      () => bounded.store.executeTransaction({}, () => {
        transactionCallbackCalls += 1;
      }),
      (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
      'dynamic-slot guard must precede transaction input validation',
    );
    assert.equal(transactionCallbackCalls, 0);
    assert.equal(bounded.store.state, 'active');
    assert.throws(
      () => bounded.store.checkpoint(),
      (error) => error?.code === 'CONTROL_CHECKPOINT_BLOCKED',
    );
    assert.equal(bounded.store.state, 'active');
    assert.deepEqual(snapshotAuthority(fixture), before);
  } finally {
    closeBounded(bounded);
  }
});

test('Task 7 B0 RED: transaction reentrancy rejects checkpoint before its runner', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b0-checkpoint-transaction-gate');
  let runnerCalls = 0;
  const runtime = createCheckpointRunnerCore(fixture, () => {
    runnerCalls += 1;
    const error = new Error('checkpoint runner must not run inside a transaction');
    error.code = 'CONTROL_CHECKPOINT_BLOCKED';
    throw error;
  });
  t.after(() => {
    if (runtime.store.state === 'active') runtime.store.close();
  });
  const source = appendCheckpointGateSource(fixture, runtime);

  assert.throws(
    () => runtime.store.executeTransaction(source.input, () => runtime.store.checkpoint()),
    (error) => error?.code === 'NATIVE_OPERATION_IN_PROGRESS',
  );
  assert.equal(runnerCalls, 0);
  assert.equal(runtime.store.state, 'active');
});

test('Task 7 B0 RED: checkpoint keeps the native operation gate active across its runner', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const rows = [
    { name: 'readGet', invoke: (store) => store.readGet('SELECT 1 AS value') },
    { name: 'recover', invoke: (store) => store.recover() },
    { name: 'checkpoint', invoke: (store) => store.checkpoint() },
    { name: 'close', invoke: (store) => store.close() },
    { name: 'fence', invoke: (store) => store.fence() },
  ];
  const observed = [];

  for (const current of rows) {
    const fixture = nativeFixture(t, `task7-b0-checkpoint-runner-${current.name}`);
    let store;
    let runnerCalls = 0;
    const runtime = createCheckpointRunnerCore(fixture, () => {
      runnerCalls += 1;
      if (runnerCalls > 1) return 'nested-checkpoint-returned';
      return current.invoke(store);
    });
    store = runtime.store;
    const before = snapshotAuthority(fixture);
    let code = 'NO_THROW';
    try {
      store.checkpoint();
    } catch (error) {
      code = error?.code || error?.name || typeof error;
    }
    observed.push({
      code,
      name: current.name,
      runnerCalls,
      state: store.state,
      treeUnchanged: JSON.stringify(snapshotAuthority(fixture)) === JSON.stringify(before),
    });
    if (store.state === 'active') store.close();
  }

  assert.deepEqual(
    observed,
    rows.map(({ name }) => ({
      code: 'NATIVE_OPERATION_IN_PROGRESS',
      name,
      runnerCalls: 1,
      state: 'active',
      treeUnchanged: true,
    })),
  );
});

test('Task 7 B0 RED: released and fenced stores reject checkpoint before its runner', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const rows = [
    { name: 'released', dispose: (store) => store.close(), code: 'NATIVE_STORE_RELEASED' },
    { name: 'fenced', dispose: (store) => store.fence(), code: 'NATIVE_STORE_FENCED' },
  ];
  const observed = [];

  for (const current of rows) {
    const fixture = nativeFixture(t, `task7-b0-checkpoint-state-${current.name}`);
    let runnerCalls = 0;
    const runtime = createCheckpointRunnerCore(fixture, () => {
      runnerCalls += 1;
      const error = new Error('disposed native store reached checkpoint runner');
      error.code = 'CONTROL_CHECKPOINT_BLOCKED';
      throw error;
    });
    current.dispose(runtime.store);
    let code = 'NO_THROW';
    try {
      runtime.store.checkpoint();
    } catch (error) {
      code = error?.code || error?.name || typeof error;
    }
    observed.push({ code, runnerCalls, state: runtime.store.state });
  }

  assert.deepEqual(
    observed,
    rows.map(({ code, name }) => ({ code, runnerCalls: 0, state: name })),
  );
});

test('Task 7 B0 RED: missing-job checkpoint reaches its runner before live authority rereads', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b0-checkpoint-runner-precedence');
  const persistentControlStore = openControlStore(fixture.controlDirectory, { bounded: true });
  const [genesis] = persistentControlStore.read();
  const reads = { control: 0, identity: 0, sqlite: 0 };
  let armed = false;
  let runnerCalls = 0;
  let readsAtRunner;
  const controlStore = new Proxy(persistentControlStore, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (
          armed
          && ['assertCurrent', 'read', 'readEvidence', 'tail'].includes(String(key))
        ) {
          reads.control += 1;
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  const store = createNativeProjectStoreCore({
    databasePath: fixture.databasePath,
    controlStore,
    dbKey: genesis.payload.dbKey,
    projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
    ownershipHash: genesis.payload.ownershipHash,
    assertWriterLease: () => true,
    checkpointRunner() {
      runnerCalls += 1;
      readsAtRunner = { ...reads };
      const error = new Error('no pending checkpoint job');
      error.code = 'CONTROL_CHECKPOINT_BLOCKED';
      throw error;
    },
    admissionVerifier({ evidence }) {
      if (evidence.length !== 1 || evidence[0].digest !== genesis.digest) {
        throw new Error('fixture genesis changed');
      }
      return {
        basisKind: 'stage_b_fixture_genesis',
        basisDigest: genesis.digest,
      };
    },
    identityApi(options) {
      const guard = createDatabaseIdentityGuard(options);
      return Object.freeze({
        canonicalPath: guard.canonicalPath,
        identity: guard.identity,
        assertCurrent() {
          if (armed) reads.identity += 1;
          return guard.assertCurrent();
        },
        close: guard.close,
      });
    },
    sqliteFactory(filePath) {
      const database = new Database(filePath, { create: false, strict: true });
      return new Proxy(database, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (armed && key === 'query') reads.sqlite += 1;
            return Reflect.apply(value, target, args);
          };
        },
      });
    },
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });

  armed = true;
  openControlStore(fixture.controlDirectory, { bounded: true }).append({
    type: 'task7.external.checkpoint_drift',
    payload: { marker: fixture.fixtureRunId },
  });
  const before = snapshotAuthority(fixture);

  let code = 'NO_THROW';
  try {
    store.checkpoint();
  } catch (error) {
    code = error?.code || error?.name || typeof error;
  }
  assert.deepEqual(
    {
      code,
      reads,
      readsAtRunner,
      runnerCalls,
      state: store.state,
      treeUnchanged: JSON.stringify(snapshotAuthority(fixture)) === JSON.stringify(before),
    },
    {
      code: 'CONTROL_CHECKPOINT_BLOCKED',
      reads: { control: 0, identity: 0, sqlite: 0 },
      readsAtRunner: { control: 0, identity: 0, sqlite: 0 },
      runnerCalls: 1,
      state: 'active',
      treeUnchanged: true,
    },
  );
});

test('Task 7 B2 checkpoint frontier control: null checkpoint authenticates genesis and the full active suffix', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-null-checkpoint-frontier');
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDirectory,
    () => {
      throw new Error('checkpoint authority is not used by the parser control');
    },
  );
  const evidence = harness.controlStore.readEvidence();
  assert.equal(evidence.checkpoint, null);
  assert.equal(evidence.events.length, 1);
  assert.equal(evidence.events[0].digest, fixture.genesisDigest);
  const epoch = randomUUID();
  const source = appendNativeSource(harness.controlStore, evidence.events[0], {
    connectionEpoch: epoch,
  });
  const abandoned = appendNativeAbandoned(
    harness.controlStore,
    evidence.events[0],
    source.source,
    epoch,
  );
  const active = harness.controlStore.readEvidence();
  assert.deepEqual(active.events.map(({ seq }) => seq), [1, 2, 3]);
  assert.equal(active.events[1].prevDigest, active.events[0].digest);
  assert.equal(active.events[2].prevDigest, active.events[1].digest);
  assert.equal(active.tail.tailDigest, abandoned.digest);

  const runtime = openCheckpointAwareNativeCore(fixture, harness.controlStore);
  try {
    assert.equal(runtime.store.state, 'active');
    assert.equal(runtime.store.recover().finalSeq, 0);
    assertEveryAdmissionReauthenticatesGenesis(runtime, evidence.events[0]);
  } finally {
    if (runtime.store.state === 'active') runtime.store.close();
  }
});

test('Task 7 B2 RED: checkpoint frontier reauthenticates deleted genesis and accepts an absolute active suffix', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-checkpoint-frontier');
  const seedHarness = createBoundedControlStoreTestHarness(
    fixture.controlDirectory,
    () => {
      throw new Error('the install helper owns the checkpoint authority');
    },
  );
  const [genesis] = seedHarness.controlStore.read();
  const coveredEpoch = randomUUID();
  const coveredSource = appendNativeSource(seedHarness.controlStore, genesis, {
    connectionEpoch: coveredEpoch,
  });
  const coveredAbandoned = appendNativeAbandoned(
    seedHarness.controlStore,
    genesis,
    coveredSource.source,
    coveredEpoch,
  );
  const installed = installNativeCheckpoint(
    fixture,
    [genesis.payload.connectionEpoch, coveredEpoch, coveredEpoch],
  );
  assert.equal(installed.evidence.checkpoint.previousCheckpoint, null);
  assert.equal(installed.evidence.checkpoint.coveredSeq, 3);
  assert.equal(installed.evidence.checkpoint.coveredDigest, coveredAbandoned.digest);
  assert.equal(
    fs.readdirSync(fixture.controlDirectory)
      .some((name) => name === `1-${genesis.digest}.json`),
    false,
  );
  assert.equal(
    fs.readdirSync(fixture.controlDirectory)
      .some((name) => name === `2-${coveredSource.source.digest}.json`),
    false,
  );

  const epoch = randomUUID();
  const source = appendNativeSource(installed.controlStore, genesis, {
    connectionEpoch: epoch,
  });
  const abandoned = appendNativeAbandoned(
    installed.controlStore,
    genesis,
    source.source,
    epoch,
  );
  const activeEvidence = installed.controlStore.readEvidence();
  assert.deepEqual(activeEvidence.events.map(({ seq }) => seq), [4, 5]);
  assert.equal(
    activeEvidence.events[0].prevDigest,
    activeEvidence.checkpoint.coveredDigest,
  );
  assert.equal(activeEvidence.events[1].prevDigest, source.source.digest);
  assert.equal(activeEvidence.tail.tailSeq, abandoned.seq);

  const runtime = openCheckpointAwareNativeCore(fixture, installed.controlStore);
  try {
    assert.equal(runtime.store.state, 'active');
    assert.equal(runtime.store.recover().finalSeq, 0);
    assertEveryAdmissionReauthenticatesGenesis(runtime, genesis);
  } finally {
    if (runtime.store.state === 'active') runtime.store.close();
  }
});

test('Task 7 B2 RED: retry boundary is reset at checkpoint and continues only inside the active suffix', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-retry-boundary');
  const [genesis] = openControlStore(fixture.controlDirectory, { bounded: true }).read();
  const installed = installNativeCheckpoint(
    fixture,
    [genesis.payload.connectionEpoch],
  );
  const epoch = randomUUID();
  const logicalRequestDigest = sha256(`retry:${fixture.fixtureRunId}`);
  const first = appendNativeSource(installed.controlStore, genesis, {
    connectionEpoch: epoch,
    logicalRequestDigest,
  });
  appendNativeAbandoned(installed.controlStore, genesis, first.source, epoch);
  const second = appendNativeSource(installed.controlStore, genesis, {
    attemptSeq: 2,
    connectionEpoch: epoch,
    logicalRequestDigest,
    previousAttemptSourceDigest: first.source.digest,
  });
  appendNativeAbandoned(installed.controlStore, genesis, second.source, epoch);

  const runtime = openCheckpointAwareNativeCore(fixture, installed.controlStore);
  try {
    assert.equal(runtime.store.state, 'active');
    assert.deepEqual(
      installed.controlStore.readEvidence().events.map(({ seq }) => seq),
      [2, 3, 4, 5],
    );
  } finally {
    if (runtime.store.state === 'active') runtime.store.close();
  }
});

test('Task 7 B2 retry boundary control: a covered source cannot continue after checkpoint GC', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-covered-retry-boundary');
  const harness = createBoundedControlStoreTestHarness(
    fixture.controlDirectory,
    () => {
      throw new Error('the install helper owns the checkpoint authority');
    },
  );
  const [genesis] = harness.controlStore.read();
  const epoch = randomUUID();
  const logicalRequestDigest = sha256(`covered-retry:${fixture.fixtureRunId}`);
  const coveredSource = appendNativeSource(harness.controlStore, genesis, {
    connectionEpoch: epoch,
    logicalRequestDigest,
  });
  appendNativeAbandoned(harness.controlStore, genesis, coveredSource.source, epoch);
  const installed = installNativeCheckpoint(
    fixture,
    [genesis.payload.connectionEpoch, epoch, epoch],
  );
  assert.equal(installed.evidence.checkpoint.coveredSeq, 3);
  assert.deepEqual(installed.evidence.events, []);
  assert.equal(
    fs.readdirSync(fixture.controlDirectory)
      .some((name) => name === `2-${coveredSource.source.digest}.json`),
    false,
  );
  appendNativeSource(installed.controlStore, genesis, {
    attemptSeq: 2,
    connectionEpoch: epoch,
    logicalRequestDigest,
    previousAttemptSourceDigest: coveredSource.source.digest,
  });
  const before = snapshotAuthority(fixture);
  let sqliteFactoryCalls = 0;
  let escaped;
  assert.throws(
    () => {
      escaped = openCheckpointAwareNativeCore(fixture, installed.controlStore, {
        sqliteFactory(databasePath) {
          sqliteFactoryCalls += 1;
          return new Database(databasePath, { create: false, strict: true });
        },
      });
    },
    (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
  );
  assert.equal(escaped, undefined);
  assert.equal(sqliteFactoryCalls, 0);
  assert.deepEqual(snapshotAuthority(fixture), before);
});

test('Task 7 B2 RED: real bounded factory construction reauthenticates copied checkpoint admission', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-real-bounded-factory');
  const [genesis] = openControlStore(fixture.controlDirectory, { bounded: true }).read();
  const installed = installNativeCheckpoint(
    fixture,
    [genesis.payload.connectionEpoch],
  );
  assert.deepEqual(installed.controlStore.read(), []);
  assert.equal(
    installed.evidence.checkpoint.admissionBasis.admissionEvent.digest,
    fixture.genesisDigest,
  );
  const coordinator = createProjectWriteCoordinator({
    lockRoot: path.join(fixture.root, 'task7-b2-factory-locks'),
  });
  let bounded;
  try {
    bounded = createStageBFixtureStore(fixture, { bounded: true, coordinator });
    assert.equal(bounded.store.state, 'active');
    assert.deepEqual(
      bounded.store.readGet("SELECT value FROM project_meta WHERE key = 'schema_version'"),
      { value: '11' },
    );
  } finally {
    closeBounded(bounded);
  }
});

test('Task 7 B2 admission basis control: real bounded factory rejects a wrong fixture digest before SQLite', {
  concurrency: false,
  timeout: 30_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-real-factory-verifier');
  const [genesis] = openControlStore(fixture.controlDirectory, { bounded: true }).read();
  installNativeCheckpoint(fixture, [genesis.payload.connectionEpoch]);
  const wrongDigest = sha256(`wrong-genesis:${fixture.fixtureRunId}`);
  assert.notEqual(wrongDigest, fixture.genesisDigest);
  const wrongFixture = Object.freeze({
    ...fixture,
    genesisDigest: wrongDigest,
  });
  const coordinator = createProjectWriteCoordinator({
    lockRoot: path.join(fixture.root, 'task7-b2-verifier-locks'),
  });
  const before = snapshotAuthority(fixture);
  let sqliteFactoryCalls = 0;
  let escaped;
  assert.throws(
    () => {
      escaped = createStageBFixtureStore(wrongFixture, {
        bounded: true,
        coordinator,
        sqliteFactory(databasePath) {
          sqliteFactoryCalls += 1;
          return new Database(databasePath, { create: false, strict: true });
        },
      });
    },
    (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
  );
  assert.equal(escaped, undefined);
  assert.equal(sqliteFactoryCalls, 0);
  assert.deepEqual(snapshotAuthority(fixture), before);
});

test('Task 7 B2 RED: inherited Bloom rejects exactly 128 fresh epoch candidates before SQLite', {
  concurrency: false,
  timeout: 60_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-bloom-all-hit');
  const installed = installNativeBloomCheckpoint(fixture);
  const candidates = installed.epochs.map((epoch) => epoch.toUpperCase());
  const before = snapshotAuthority(fixture);
  let sqliteFactoryCalls = 0;
  let escaped;

  withFreshNativeRandomUuid(candidates, (freshNative) => {
    assert.throws(
      () => {
        escaped = openCheckpointAwareNativeCore(fixture, installed.controlStore, {
          createCore: freshNative.createCore,
          sqliteFactory(databasePath) {
            sqliteFactoryCalls += 1;
            return new Database(databasePath, { create: false, strict: true });
          },
        });
      },
      (error) => error?.code === 'RECOVERY_REQUIRED',
    );
    assert.equal(freshNative.calls, 128);
  });

  assert.equal(escaped, undefined);
  assert.equal(sqliteFactoryCalls, 0);
  assert.deepEqual(snapshotAuthority(fixture), before);
});

test('Task 7 B2 RED: the 128th Bloom-negative candidate succeeds lowercase after 127 hits', {
  concurrency: false,
  timeout: 60_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b2-bloom-final-negative');
  const installed = installNativeBloomCheckpoint(fixture);
  const excluded = new Set(installed.epochs);
  const negative = findBloomNegative(
    installed.filterBytes,
    installed.genesis.digest,
    excluded,
  );
  const candidates = [
    ...installed.epochs.slice(0, 127).map((epoch) => epoch.toUpperCase()),
    negative.toUpperCase(),
  ];
  let sqliteFactoryCalls = 0;

  withFreshNativeRandomUuid(candidates, (freshNative) => {
    const runtime = openCheckpointAwareNativeCore(fixture, installed.controlStore, {
      createCore: freshNative.createCore,
      sqliteFactory(databasePath) {
        sqliteFactoryCalls += 1;
        return new Database(databasePath, { create: false, strict: true });
      },
    });
    try {
      assert.equal(freshNative.calls, 128);
      assert.equal(runtime.store.state, 'active');
      assert.equal(runtime.store.connectionEpoch, negative.toLowerCase());
      assert.equal(sqliteFactoryCalls, 1);
    } finally {
      if (runtime.store.state === 'active') runtime.store.close();
    }
  });
});

test('Task 7 B3 RED: real clean logical request installs a checkpoint receipt and advances the same facade frontier', {
  concurrency: false,
  timeout: 60_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b3-checkpoint-receipt');
  seedSoftNativeHistory(fixture);
  const coordinator = createProjectWriteCoordinator({
    lockRoot: path.join(fixture.root, 'task7-b3-locks'),
  });
  const bounded = createStageBFixtureStore(fixture, { bounded: true, coordinator });
  try {
    const first = completeBoundedLogicalRequest(fixture, bounded, 'first');
    assert.equal(first.evidence.checkpoint, null);
    assert.equal(first.evidence.tail.activeEventCount, 4_096);
    const statusHarness = createBoundedControlStoreTestHarness(
      fixture.controlDirectory,
      () => { throw new Error('maintenanceStatus must not call authoritySource'); },
    );
    assert.deepEqual(statusHarness.maintenanceStatus(), {
      activeEventCount: 4_096,
      activeEventBytes: first.evidence.tail.activeEventBytes,
      level: 'soft',
    });

    const receipt = bounded.store.checkpoint();
    assert.deepEqual(Reflect.ownKeys(receipt), ['checkpointDigest', 'coveredSeq']);
    assert.equal(Object.isFrozen(receipt), true);
    const installed = first.controlStore.readEvidence();
    assert.equal(installed.checkpoint.checkpointDigest, receipt.checkpointDigest);
    assert.equal(installed.checkpoint.coveredSeq, receipt.coveredSeq);
    assert.deepEqual(installed.events, []);

    const second = completeBoundedLogicalRequest(fixture, bounded, 'second');
    assert.equal(second.source.seq, receipt.coveredSeq + 1);
    assert.equal(second.source.prevDigest, installed.checkpoint.coveredDigest);
    assert.equal(second.evidence.tail.tailSeq, receipt.coveredSeq + 3);
    assert.equal(bounded.store.state, 'active');
  } finally {
    closeBounded(bounded);
  }
});

test('Task 7 B3 RED: foreign coordinator drift makes the captured checkpoint job recovery-only and zero-write', {
  concurrency: false,
  timeout: 60_000,
}, (t) => {
  const fixture = nativeFixture(t, 'task7-b3-foreign-stale-job');
  seedSoftNativeHistory(fixture);
  const lockRoot = path.join(fixture.root, 'task7-b3-foreign-locks');
  const coordinatorA = createProjectWriteCoordinator({ lockRoot });
  const coordinatorB = createProjectWriteCoordinator({ lockRoot });
  const bounded = createStageBFixtureStore(fixture, {
    bounded: true,
    coordinator: coordinatorA,
  });
  try {
    const captured = completeBoundedLogicalRequest(fixture, bounded, 'captured');
    assert.equal(captured.evidence.tail.activeEventCount, 4_096);
    const statusHarness = createBoundedControlStoreTestHarness(
      fixture.controlDirectory,
      () => { throw new Error('maintenanceStatus must not call authoritySource'); },
    );
    assert.equal(statusHarness.maintenanceStatus().level, 'soft');
    coordinatorB.withProjectWriteSync(fixture.databasePath, () => {
      openControlStore(fixture.controlDirectory, { bounded: true }).append({
        type: 'task7.external.checkpoint_drift',
        payload: { marker: fixture.fixtureRunId },
      });
    });
    const before = snapshotAuthority(fixture);

    assert.throws(
      () => bounded.store.checkpoint(),
      (error) => error?.code === 'RECOVERY_REQUIRED',
    );
    assert.deepEqual(snapshotAuthority(fixture), before);
    assert.equal(bounded.store.state, 'active');
  } finally {
    closeBounded(bounded);
  }
});
