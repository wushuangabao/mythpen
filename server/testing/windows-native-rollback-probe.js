const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('bun:sqlite');

const { getBuildInfo } = require('../build-info');
const {
  WINDOWS_ROLLBACK_CRASH_CASES,
} = require('../platform/windows-native-rollback-capability');

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT_PREFIX = 'mythpen-native-rollback-vm-';
const CONTROL_PREFIX = 'mythpen-native-rollback-control-';
const FIXTURE_EVENT_TYPE = 'sqlite.native.stage_b.fixture_genesis';
const RUN_DESCRIPTOR_TYPE = 'windows.native.rollback.run.v2';
const ARM_TYPE = 'windows.native.rollback.arm.v2';
const INSPECTION_TYPE = 'windows.native.rollback.cold-inspection.v2';
const TERMINAL_TYPES = Object.freeze(['sqlite.tx.committed', 'sqlite.tx.rolled_back']);
const BEFORE_COMMIT_CUTS = new Set([
  'native.tx.after-prepared-postcheck',
  'native.tx.after-begin-acquired',
  'native.tx.after-gate-insert',
  'native.tx.after-business-callback',
  'native.tx.after-seq-cas',
  'native.tx.after-gate-delete',
  'native.tx.before-commit-invoke',
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function assertNoWin32ReparsePoint(targetPath) {
  const { dlopen, FFIType, ptr } = require('bun:ffi');
  const library = dlopen('kernel32.dll', {
    GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
  });
  const attributes = Number(library.symbols.GetFileAttributesW(
    ptr(Buffer.from(`${path.toNamespacedPath(targetPath)}\0`, 'utf16le')),
  )) >>> 0;
  if (attributes === 0xffffffff || (attributes & 0x400) !== 0) {
    throw new Error('Probe root must not be a Windows reparse point');
  }
}

function allowedRootParent(root) {
  const parent = canonicalPath(path.dirname(root));
  const temp = canonicalPath(fs.realpathSync.native(os.tmpdir()));
  const guestRuns = canonicalPath('C:\\Mythpen-L1-TestData\\runs');
  return parent === temp || parent === guestRuns;
}

function exactRoot(value, { requireEmpty = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('Probe root must be absolute');
  const requested = path.resolve(value);
  const canonical = fs.realpathSync.native(requested);
  const stats = fs.lstatSync(canonical);
  if (
    canonicalPath(requested) !== canonicalPath(canonical)
    || !path.basename(canonical).startsWith(ROOT_PREFIX)
    || !allowedRootParent(canonical)
    || stats.isSymbolicLink()
    || !stats.isDirectory()
  ) {
    fail('Probe root must be a controlled canonical plain directory');
  }
  assertNoWin32ReparsePoint(canonical);
  if (requireEmpty && fs.readdirSync(canonical).length !== 0) {
    fail('Probe root must start empty');
  }
  return canonical;
}

function exactControlDirectory(value, root) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    fail('Probe control directory must be absolute');
  }
  const requested = path.resolve(value);
  const canonical = fs.realpathSync.native(requested);
  const stats = fs.lstatSync(canonical);
  const relative = path.relative(root, canonical);
  if (
    canonicalPath(requested) !== canonicalPath(canonical)
    || stats.isSymbolicLink()
    || !stats.isDirectory()
    || relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
    || (
      !path.basename(canonical).startsWith(CONTROL_PREFIX)
      && !canonical.toLowerCase().startsWith('\\\\vboxsvr\\')
    )
  ) {
    fail('Probe control directory must be an external canonical directory');
  }
  return canonical;
}

function volumeBinding(root) {
  const { dlopen, FFIType, ptr } = require('bun:ffi');
  const library = dlopen('kernel32.dll', {
    GetDiskFreeSpaceW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
    GetVolumeInformationW: {
      args: [
        FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr,
        FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32,
      ],
      returns: FFIType.i32,
    },
  });
  const kernel32 = library.symbols;
  const volumeRoot = Buffer.from(`${path.parse(root).root}\0`, 'utf16le');
  const filesystemName = Buffer.alloc(64 * Uint16Array.BYTES_PER_ELEMENT);
  if (kernel32.GetVolumeInformationW(
    ptr(volumeRoot), 0, 0, 0, 0, 0, ptr(filesystemName), 64,
  ) === 0) {
    fail(`GetVolumeInformationW failed: ${kernel32.GetLastError()}`);
  }
  const sectorsPerCluster = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  const bytesPerSector = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  const freeClusters = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  const totalClusters = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  if (kernel32.GetDiskFreeSpaceW(
    ptr(volumeRoot), ptr(sectorsPerCluster), ptr(bytesPerSector),
    ptr(freeClusters), ptr(totalClusters),
  ) === 0) {
    fail(`GetDiskFreeSpaceW failed: ${kernel32.GetLastError()}`);
  }
  let end = filesystemName.length;
  for (let offset = 0; offset < filesystemName.length; offset += 2) {
    if (filesystemName.readUInt16LE(offset) === 0) {
      end = offset;
      break;
    }
  }
  return Object.freeze({
    name: filesystemName.subarray(0, end).toString('utf16le').toUpperCase(),
    bytesPerSector: bytesPerSector.readUInt32LE(0),
    rootKind: 'plain-directory',
  });
}

function sqliteBinding(databasePath) {
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    const journalMode = String(
      database.query('PRAGMA journal_mode = DELETE').get().journal_mode,
    ).toLowerCase();
    database.exec('PRAGMA synchronous = EXTRA');
    const synchronous = Number(database.query('PRAGMA synchronous').get().synchronous);
    const sqlite = database.query(
      'SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId',
    ).get();
    return Object.freeze({ journalMode, synchronous, sqlite });
  } finally {
    database.close();
  }
}

function binding(root, databasePath) {
  const sqlite = sqliteBinding(databasePath);
  return Object.freeze({
    binarySha256: sha256(fs.readFileSync(process.execPath)),
    sourceCommit: getBuildInfo().sourceCommit,
    targetTriple: getBuildInfo().targetTriple,
    bunVersion: Bun.version,
    sqliteVersion: sqlite.sqlite.version,
    sqliteSourceId: sqlite.sqlite.sourceId,
    filesystem: volumeBinding(root),
    pragmas: Object.freeze({ journalMode: sqlite.journalMode, synchronous: sqlite.synchronous }),
  });
}

function physicalFileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error('Probe database must be a single-link plain file');
  }
  assertNoWin32ReparsePoint(filePath);
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function writeDurableJson(targetPath, value) {
  const { fsyncDirectory } = require('../platform/durability');
  const bytes = JSON.stringify(value);
  const descriptor = fs.openSync(targetPath, 'wx');
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(targetPath));
  if (fs.readFileSync(targetPath, 'utf8') !== bytes) {
    throw new Error('Probe descriptor post-check failed');
  }
}

function writeControlFrame(targetPath, value) {
  const bytes = JSON.stringify(value);
  const descriptor = fs.openSync(targetPath, 'wx');
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (fs.readFileSync(targetPath, 'utf8') !== bytes) {
    throw new Error('External arm frame post-check failed');
  }
}

function isolateEnvironment(root) {
  for (const key of [
    'USERPROFILE',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'MYTHPEN_DATA_DIR',
    'MYTHPEN_EXPORT_DIR',
  ]) process.env[key] = root;
  for (const key of [
    'MYTHPEN_FAULT_MAP',
    'MYTHPEN_CRASH_ARTIFACTS_PATH',
    'MYTHPEN_CRASH_MARKER_PATH',
    'MYTHPEN_CRASH_MARKER_TOKEN',
  ]) delete process.env[key];
}

async function createSchema10Project(root, armId) {
  isolateEnvironment(root);
  const database = require('../db');
  let closed = false;
  try {
    await database.initDatabase();
    const name = `rollback-${armId.slice(0, 8)}`;
    database.createProjectDb(name);
    const databasePath = path.resolve(database.getProjectDbPath(name));
    database.closeAllDatabases();
    closed = true;
    const relative = path.relative(root, databasePath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(databasePath)) {
      throw new Error('Probe project escaped its controlled root');
    }
    return Object.freeze({ name, databasePath });
  } finally {
    if (!closed) {
      try { database.closeAllDatabases(); } catch { /* Preserve the primary failure. */ }
    }
  }
}

function createFixture(root, project) {
  const { inspectControlStoreEvidence, openControlStore } = require('../control-store');
  const { installSchema11Contract, inspectSchema11Contract } = require('../native/durability-schema');
  const { canonicalDatabasePath } = require('../sqljs-atomic-store');
  const database = new Database(project.databasePath, { create: false, strict: true });
  let contract;
  try {
    contract = installSchema11Contract(database);
  } finally {
    database.close();
  }

  const dbKey = sha256(canonicalDatabasePath(project.databasePath));
  const identity = physicalFileIdentity(project.databasePath);
  const fixtureRunId = randomUUID();
  const ownershipHash = sha256(canonicalJson({
    dbKey,
    identity,
    projectInstanceIdSha256: contract.projectInstanceIdSha256,
  }));
  const payload = Object.freeze({
    version: 1,
    eventId: randomUUID(),
    dbKey,
    projectInstanceIdSha256: contract.projectInstanceIdSha256,
    createdAt: new Date().toISOString(),
    ownershipHash,
    connectionEpoch: randomUUID(),
    fixtureRunId,
    schemaVersion: contract.schemaVersion,
    backend: contract.backend,
    finalSeq: contract.finalSeq,
    gateEmpty: contract.gateEmpty,
    triggerVersion: contract.triggerVersion,
    triggerSetDigest: contract.triggerSetDigest,
    identity,
  });
  const controlDirectory = path.join(root, 'native-control', dbKey);
  const controlStore = openControlStore(controlDirectory);
  if (controlStore.read().length !== 0) throw new Error('Probe genesis requires empty evidence');
  const appended = controlStore.compareAndAppend(null, { type: FIXTURE_EVENT_TYPE, payload });
  const evidence = inspectControlStoreEvidence(controlDirectory);
  const check = new Database(project.databasePath, { create: false, readonly: true, strict: true });
  try {
    const inspected = inspectSchema11Contract(check);
    if (
      evidence.events.length !== 1
      || evidence.events[0].digest !== appended.digest
      || inspected.projectInstanceIdSha256 !== payload.projectInstanceIdSha256
      || inspected.triggerSetDigest !== payload.triggerSetDigest
    ) throw new Error('Probe genesis post-check failed');
  } finally {
    check.close();
  }
  return Object.freeze({
    root,
    name: project.name,
    databasePath: project.databasePath,
    controlDirectory,
    fixtureRunId,
    genesisDigest: appended.digest,
    databaseSha256: sha256(fs.readFileSync(project.databasePath)),
  });
}

function appendSource(fixture, store, cut, rowId) {
  const { openControlStore } = require('../control-store');
  const controlStore = openControlStore(fixture.controlDirectory);
  const [genesis] = controlStore.read();
  controlStore.compareAndAppend(genesis.digest, {
    type: 'manuscript.source',
    payload: {
      version: 1,
      eventId: randomUUID(),
      dbKey: genesis.payload.dbKey,
      projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
      createdAt: new Date().toISOString(),
      ownershipHash: genesis.payload.ownershipHash,
      connectionEpoch: store.connectionEpoch,
      logicalRequestDigest: sha256(`windows-vm-reset:${cut}:${rowId}`),
      attemptSeq: 1,
      previousAttemptSourceDigest: null,
      operationKind: 'chapter_body_write',
      targetKind: 'character',
      targetIdSha256: sha256(rowId),
      expectedDataVersion: null,
    },
  });
  const source = controlStore.tail();
  if (source.type !== 'manuscript.source' || source.payload.connectionEpoch !== store.connectionEpoch) {
    throw new Error('Probe source post-check failed');
  }
  return source;
}

function appendAbandoned(fixture, source) {
  const { openControlStore } = require('../control-store');
  const controlStore = openControlStore(fixture.controlDirectory);
  const abandoned = controlStore.compareAndAppend(source.digest, {
    type: 'manuscript.source.abandoned',
    payload: {
      version: 1,
      eventId: randomUUID(),
      dbKey: source.payload.dbKey,
      projectInstanceIdSha256: source.payload.projectInstanceIdSha256,
      createdAt: new Date().toISOString(),
      ownershipHash: source.payload.ownershipHash,
      connectionEpoch: source.payload.connectionEpoch,
      sourceDigest: source.digest,
      reasonCode: 'cancelled',
    },
  });
  if (controlStore.tail().digest !== abandoned.digest) {
    throw new Error('Probe abandoned source post-check failed');
  }
}

function blockForever() {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (;;) Atomics.wait(state, 0, 0);
}

function createPublisher({ armId, bindingValue, controlDirectory, cut }) {
  const armPath = path.join(controlDirectory, `${armId}.arm.json`);
  return () => {
    const frame = Object.freeze({
      version: 2,
      type: ARM_TYPE,
      armId,
      cut,
      binding: bindingValue,
    });
    writeControlFrame(armPath, frame);
    process.stdout.write(`${JSON.stringify(frame)}\n`);
    blockForever();
  };
}

async function runTransaction(root, cut, armId, controlDirectory) {
  if (!WINDOWS_ROLLBACK_CRASH_CASES.includes(cut) || !UUID_V4_PATTERN.test(armId)) {
    fail('Invalid probe transaction request');
  }
  const project = await createSchema10Project(root, armId);
  const fixture = createFixture(root, project);
  const bindingValue = binding(root, project.databasePath);
  const { createStageBFixtureStore } = require('./native-stage-b-store');
  const {
    FAULT_POINTS,
    createFixtureOnlyExternalVmArmAction,
    crashOnlyFaultPoint,
    withFaults,
  } = require('./fault-injection');
  const store = createStageBFixtureStore(fixture);
  const rowId = `rollback-${armId}`;
  const publish = createPublisher({ armId, bindingValue, controlDirectory, cut });
  const terminalSelector = path.join(controlDirectory, `${armId}.terminal.ready`);
  const action = createFixtureOnlyExternalVmArmAction({
    publish,
    ...(
      cut === FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH
      || cut === FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC
        ? { whenFileExists: terminalSelector }
        : {}
    ),
  });

  await withFaults({ [cut]: action }, async () => {
    const source = appendSource(fixture, store, cut, rowId);
    const descriptor = Object.freeze({
      version: 2,
      type: RUN_DESCRIPTOR_TYPE,
      armId,
      cut,
      rowId,
      sourceDigest: source.digest,
      binding: bindingValue,
      fixture,
    });
    writeDurableJson(path.join(root, `${armId}.run.json`), descriptor);
    if (cut === FAULT_POINTS.NATIVE_CALLER_AFTER_SOURCE_POSTCHECK) {
      crashOnlyFaultPoint(cut, { sourceDigest: source.digest });
    } else {
      store.executeTransaction({
        sourceDigest: source.digest,
        operationKind: source.payload.operationKind,
        logicalRequestDigest: source.payload.logicalRequestDigest,
        attemptSeq: source.payload.attemptSeq,
      }, (transaction) => {
        transaction.run(
          'INSERT INTO characters (id, name, background) VALUES (?, ?, ?)',
          rowId,
          `VM reset ${cut}`,
          'non-secret rollback evidence row',
        );
        if (
          cut === FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH
          || cut === FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC
        ) {
          writeControlFrame(terminalSelector, Object.freeze({ armId, cut }));
        }
      });
    }
  });
  throw new Error(`Configured external VM arm point was not reached: ${cut}`);
}

function parseRunDescriptor(root, armId) {
  const raw = JSON.parse(fs.readFileSync(path.join(root, `${armId}.run.json`), 'utf8'));
  if (
    raw?.version !== 2
    || raw?.type !== RUN_DESCRIPTOR_TYPE
    || raw.armId !== armId
    || !WINDOWS_ROLLBACK_CRASH_CASES.includes(raw.cut)
    || raw.fixture?.root !== root
    || !UUID_V4_PATTERN.test(raw.fixture?.fixtureRunId || '')
    || typeof raw.sourceDigest !== 'string'
    || raw.sourceDigest.length !== 64
  ) throw new Error('Cold inspection run descriptor is invalid');
  for (const target of [raw.fixture.databasePath, raw.fixture.controlDirectory]) {
    const relative = path.relative(root, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Cold inspection fixture path escaped the controlled root');
    }
  }
  return Object.freeze({
    ...raw,
    binding: Object.freeze(raw.binding),
    fixture: Object.freeze(raw.fixture),
  });
}

function assertStableProjection(store, descriptor, expectedFinalSeq) {
  const sequence = store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'");
  if (sequence?.value !== String(expectedFinalSeq)) {
    throw new Error('Cold inspection durability sequence is not canonical');
  }
  const row = store.readGet(
    'SELECT id, name, background FROM characters WHERE id = ?',
    descriptor.rowId,
  );
  if (expectedFinalSeq === 0 && row !== null) {
    throw new Error('Cold inspection observed a partial before-state row');
  }
  if (expectedFinalSeq === 1 && (
    row?.id !== descriptor.rowId
    || row?.name !== `VM reset ${descriptor.cut}`
    || row?.background !== 'non-secret rollback evidence row'
  )) throw new Error('Cold inspection observed a partial after-state row');
}

function expectedFinalSeq(cut) {
  if (cut === 'native.caller.after-source-postcheck' || BEFORE_COMMIT_CUTS.has(cut)) return 0;
  return 1;
}

function coldInspect(root, armId) {
  const { inspectControlStoreEvidence, openControlStore } = require('../control-store');
  const { inspectSchema11Contract } = require('../native/durability-schema');
  const { createStageBFixtureStore } = require('./native-stage-b-store');
  const descriptor = parseRunDescriptor(root, armId);
  const controlStore = openControlStore(descriptor.fixture.controlDirectory);
  const beforeRecovery = inspectControlStoreEvidence(descriptor.fixture.controlDirectory).events;
  const source = beforeRecovery.find((event) => event.digest === descriptor.sourceDigest);
  if (!source || source.type !== 'manuscript.source') {
    throw new Error('Cold inspection source evidence is missing');
  }

  const store = createStageBFixtureStore(descriptor.fixture);
  const finalSeq = expectedFinalSeq(descriptor.cut);
  if (descriptor.cut === 'native.caller.after-source-postcheck') {
    const pending = store.recover();
    if (pending.status !== 'source_pending' || pending.sourceDigest !== source.digest) {
      throw new Error('Cold inspection did not recover the pending source exactly');
    }
    appendAbandoned(descriptor.fixture, source);
    const clean = store.recover();
    if (clean.status !== 'clean' || clean.finalSeq !== 0) {
      throw new Error('Cold inspection did not converge the abandoned source');
    }
  } else {
    const recovered = store.recover();
    if (
      finalSeq === 0
        ? recovered.status !== 'rolled_back' || recovered.finalSeq !== 0
        : !['committed', 'clean'].includes(recovered.status) || recovered.finalSeq !== 1
    ) throw new Error('Cold inspection transaction recovery is not canonical');
  }
  assertStableProjection(store, descriptor, finalSeq);

  const evidence = controlStore.read();
  const sources = evidence.filter((event) => event.type === 'manuscript.source');
  const prepared = evidence.filter((event) => event.type === 'sqlite.tx.prepared');
  const terminals = evidence.filter((event) => TERMINAL_TYPES.includes(event.type));
  if (
    sources.length !== 1
    || sources[0].digest !== descriptor.sourceDigest
    || prepared.length !== (descriptor.cut === 'native.caller.after-source-postcheck' ? 0 : 1)
    || terminals.length !== (descriptor.cut === 'native.caller.after-source-postcheck' ? 0 : 1)
    || (
      terminals.length === 1
      && (
        terminals[0].payload.preparedDigest !== prepared[0].digest
        || terminals[0].type !== (finalSeq === 1 ? 'sqlite.tx.committed' : 'sqlite.tx.rolled_back')
      )
    )
  ) throw new Error('Cold inspection transaction evidence is not unique');

  const convergedDigests = evidence.map((event) => event.digest);
  const convergedTail = controlStore.tail().digest;
  store.close();
  const inspector = new Database(descriptor.fixture.databasePath, {
    create: false,
    readonly: true,
    strict: true,
  });
  try {
    inspectSchema11Contract(inspector, { expectedFinalSeq: finalSeq });
    const gate = inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get();
    if (gate?.count !== 0) throw new Error('Cold inspection found a non-empty write gate');
  } finally {
    inspector.close();
  }
  const currentBinding = binding(root, descriptor.fixture.databasePath);
  if (canonicalJson(currentBinding) !== canonicalJson(descriptor.binding)) {
    throw new Error('Cold inspection binding differs from the armed binary and volume');
  }

  const reopened = createStageBFixtureStore(descriptor.fixture);
  const clean = reopened.recover();
  if (clean.status !== 'clean' || clean.finalSeq !== finalSeq) {
    throw new Error('Second cold inspection did not reopen cleanly');
  }
  assertStableProjection(reopened, descriptor, finalSeq);
  reopened.close();
  const secondEvidence = controlStore.read();
  if (
    canonicalJson(secondEvidence.map((event) => event.digest)) !== canonicalJson(convergedDigests)
    || controlStore.tail().digest !== convergedTail
  ) throw new Error('Second cold inspection changed converged evidence');

  const frame = Object.freeze({
    version: 2,
    type: INSPECTION_TYPE,
    armId,
    cut: descriptor.cut,
    binding: descriptor.binding,
    convergence: Object.freeze({
      outcome: finalSeq === 1 ? 'after' : 'before',
      finalSeq,
      gateEmpty: true,
      sourceCount: sources.length,
      preparedCount: prepared.length,
      terminalCount: terminals.length,
      terminalType: terminals[0]?.type || null,
    }),
    externalVmResetVerified: false,
    capability: false,
  });
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function main() {
  if (process.platform !== 'win32' || getBuildInfo().nativeActivationMode !== 'fixture_only') {
    fail('Probe build is disabled');
  }
  const [command, rootValue, third, fourth, fifth] = process.argv.slice(2);
  if (command === 'run-transaction') {
    const root = exactRoot(rootValue, { requireEmpty: true });
    const controlDirectory = exactControlDirectory(fifth, root);
    await runTransaction(root, third, fourth, controlDirectory);
    return;
  }
  if (command === 'cold-inspect') {
    const root = exactRoot(rootValue);
    if (!UUID_V4_PATTERN.test(third || '')) fail('Invalid cold inspection arm id');
    coldInspect(root, third);
    return;
  }
  fail('Unknown probe command');
}

main().catch((error) => fail(error?.stack || error?.message || String(error)));
