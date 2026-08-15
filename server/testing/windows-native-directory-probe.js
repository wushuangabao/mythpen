const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Database } = require('bun:sqlite');
const { getBuildInfo } = require('../build-info');
const { WINDOWS_DIRECTORY_ENTRY_CRASH_CASES } = require('../platform/windows-native-directory-capability');

const ROOT_PREFIX = 'mythpen-native-directory-vm-';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETIRED_CONTROL_DIRECTORY = /^retire-control\.retired-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCHEMA10_FRAME_PREFIX = 'MYTHPEN_NATIVE_DIRECTORY_SCHEMA10=';
const PREPARED_CRASH_DESCRIPTOR_TYPE = 'windows.native.directory.activation-prepared-crash.v1';
const ARM_TYPE = 'windows.native.directory.arm.v1';
const INSPECT_TYPE = 'windows.native.directory.cold-inspection.v1';
const NATIVE_GATE_TABLE = '_durability_write_gate';
const NATIVE_TRIGGER_PREFIX = '_mythpen_downgrade_guard__';
const NATIVE_META_KEYS = ['durability_backend', 'durability_commit_seq', 'durability_trigger_set_digest', 'durability_trigger_version'];

function fail(message) { process.stderr.write(`${message}\n`); process.exit(2); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value) { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item); }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function block() { const wait = new Int32Array(new SharedArrayBuffer(4)); for (;;) Atomics.wait(wait, 0, 0); }
function scenario(name) { return WINDOWS_DIRECTORY_ENTRY_CRASH_CASES.find((value) => value.scenario === name) || null; }
function write(target, value) { fs.writeFileSync(target, `${json(value)}\n`, { encoding: 'utf8', flag: 'wx' }); }

function writeDurableControlDescriptor(target, value) {
  const { fsyncDirectory } = require('../platform/durability'); const bytes = json(value); const descriptor = fs.openSync(target, 'wx');
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fsyncDirectory(path.dirname(target)); const readback = fs.readFileSync(target, 'utf8');
  if (readback !== bytes || json(JSON.parse(readback)) !== bytes) throw new Error('Directory control descriptor post-check failed');
}

function parseDirectoryProbeArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 7) return null;
  const [, , command, rootValue, name, armId, controlDirectory] = argv;
  if (command !== 'run-case' || typeof rootValue !== 'string' || !scenario(name) || !UUID.test(armId) || typeof controlDirectory !== 'string' || controlDirectory.length === 0) return null;
  return { command, rootValue, scenario: name, armId, controlDirectory };
}

function parseDirectoryColdInspectionArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 7) return null;
  const [, , command, rootValue, name, armId, controlDirectory] = argv;
  if (command !== 'cold-inspect' || typeof rootValue !== 'string' || !scenario(name) || !UUID.test(armId) || typeof controlDirectory !== 'string' || controlDirectory.length === 0) return null;
  return { command, rootValue, scenario: name, armId, controlDirectory };
}

function exactRoot(value, empty = false) {
  const root = fs.realpathSync.native(path.resolve(value));
  if (!path.isAbsolute(value) || path.resolve(value).toLowerCase() !== root.toLowerCase() || !root.toLowerCase().startsWith('c:\\mythpenprobe\\') || !path.basename(root).startsWith(ROOT_PREFIX) || !fs.lstatSync(root).isDirectory() || (empty && fs.readdirSync(root).length !== 0)) fail('Directory probe root is not an empty guest-local MythpenProbe directory');
  return root;
}

function queryWindowsVolume(volumeRootValue) {
  const { dlopen, FFIType, ptr } = require('bun:ffi');
  const kernel32 = dlopen('kernel32.dll', {
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
  }).symbols;
  const volumeRoot = Buffer.from(`${volumeRootValue}\0`, 'utf16le');
  const filesystemName = Buffer.alloc(64 * Uint16Array.BYTES_PER_ELEMENT);
  if (kernel32.GetVolumeInformationW(
    ptr(volumeRoot), 0, 0, 0, 0, 0, ptr(filesystemName), 64,
  ) === 0) throw new Error(`GetVolumeInformationW failed: ${kernel32.GetLastError()}`);
  const sectorsPerCluster = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  const bytesPerSector = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  const freeClusters = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  const totalClusters = Buffer.alloc(Uint32Array.BYTES_PER_ELEMENT);
  if (kernel32.GetDiskFreeSpaceW(
    ptr(volumeRoot), ptr(sectorsPerCluster), ptr(bytesPerSector),
    ptr(freeClusters), ptr(totalClusters),
  ) === 0) throw new Error(`GetDiskFreeSpaceW failed: ${kernel32.GetLastError()}`);
  let end = filesystemName.length;
  for (let offset = 0; offset < filesystemName.length; offset += 2) {
    if (filesystemName.readUInt16LE(offset) === 0) { end = offset; break; }
  }
  return { name: filesystemName.subarray(0, end).toString('utf16le'), bytesPerSector: bytesPerSector.readUInt32LE(0) };
}

function volumeBinding(root, { queryVolume = queryWindowsVolume } = {}) {
  const volumeRoot = path.parse(path.resolve(root)).root;
  const result = queryVolume(volumeRoot);
  if (result === null || result === undefined) throw new Error('Windows volume sector query is unavailable');
  if (typeof result.name !== 'string' || result.name.length === 0 || !Number.isSafeInteger(result.bytesPerSector) || result.bytesPerSector <= 0) throw new Error('Invalid volume sector query result');
  return freeze({ name: result.name.toUpperCase(), bytesPerSector: result.bytesPerSector, rootKind: 'plain-directory' });
}

function bind(root) {
  const database = new Database(':memory:');
  try {
    const sqlite = database.query('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get();
    return freeze({ binarySha256: hash(fs.readFileSync(process.execPath)), sourceCommit: getBuildInfo().sourceCommit, targetTriple: getBuildInfo().targetTriple, bunVersion: Bun.version, sqliteVersion: sqlite.version, sqliteSourceId: sqlite.sourceId, filesystem: volumeBinding(root) });
  } finally { database.close(); }
}

function arm(root, armId, controlDirectory, entry, binding) {
  const frame = freeze({ version: 1, type: ARM_TYPE, root, armId, scenario: entry.scenario, cut: entry.cut, binding, externalVmResetVerified: false, capability: false });
  writeDurableControlDescriptor(path.join(controlDirectory, `${armId}.arm.json`), frame); process.stdout.write(`${JSON.stringify(frame)}\n`); block();
}

function readDirectoryControlDescriptor(root, name, armId, controlDirectory) {
  const entry = scenario(name); let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(path.join(controlDirectory, `${armId}.arm.json`), 'utf8')); } catch { throw new Error('Directory cold control descriptor is unreadable'); }
  if (descriptor?.version !== 1 || descriptor.type !== ARM_TYPE || descriptor.root !== root || descriptor.armId !== armId || descriptor.scenario !== name || descriptor.cut !== entry?.cut || !descriptor.binding || descriptor.externalVmResetVerified !== false || descriptor.capability !== false) throw new Error('Directory cold control descriptor is invalid');
  return freeze(descriptor);
}

function authority(store, genesis, evidence) {
  const tail = evidence.tail; const checkpoint = evidence.checkpoint; const admissionBasis = checkpoint?.admissionBasis || { basisKind: 'stage_b_fixture_genesis', basisDigest: genesis.digest, admissionEvent: genesis };
  return freeze({ snapshot: { incarnationId: store.incarnationId, tail: { seq: tail.tailSeq, digest: tail.tailDigest }, cleanBasisDigest: tail.tailDigest }, cleanBasis: { admissionBasis, dbKey: genesis.payload.dbKey, schema: genesis.payload.schemaVersion, backend: genesis.payload.backend, finalSeq: genesis.payload.finalSeq, triggerVersion: genesis.payload.triggerVersion, triggerSetDigest: genesis.payload.triggerSetDigest, projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256, identity: genesis.payload.identity, latestCleanBasisDigest: tail.tailDigest, unresolved: [] }, epochObservations: checkpoint ? [] : [genesis.payload.connectionEpoch] });
}

function runCheckpoint(root, entry, armId, controlDirectory, binding, { publish = null } = {}) {
  const { openControlStore, getBoundedControlStoreCheckpointController } = require('../control-store');
  const { createFixtureOnlyExternalVmArmAction, withFaults } = require('./fault-injection');
  const directory = path.join(root, 'checkpoint-control'); const legacy = openControlStore(directory);
  const payload = freeze({ version: 1, eventId: randomUUID(), dbKey: 'a'.repeat(64), projectInstanceIdSha256: 'b'.repeat(64), createdAt: new Date().toISOString(), ownershipHash: 'c'.repeat(64), connectionEpoch: randomUUID(), fixtureRunId: randomUUID(), schemaVersion: 11, backend: 'native-sqlite-v2', finalSeq: 0, gateEmpty: true, triggerVersion: 1, triggerSetDigest: 'd'.repeat(64), identity: { dev: '1', ino: '2' } });
  const receipt = legacy.append({ type: 'sqlite.native.stage_b.fixture_genesis', payload }); const events = legacy.read(); const genesis = events.length === 1 ? events[0] : null;
  if (!genesis || genesis.type !== 'sqlite.native.stage_b.fixture_genesis' || genesis.seq !== receipt.seq || genesis.digest !== receipt.digest) throw new Error('Directory checkpoint genesis post-check failed');
  const bounded = openControlStore(directory, { bounded: true }); const controller = getBoundedControlStoreCheckpointController(bounded); const checkpointAuthority = () => authority(bounded, genesis, bounded.readEvidence());
  if (entry.scenario === 'checkpoint-after-gc-old-checkpoint') { const initialAuthority = checkpointAuthority(); controller.installCheckpoint(() => initialAuthority); bounded.append({ type: 'directory.checkpoint.successor', payload: { version: 1 } }); }
  const authorityForInstall = checkpointAuthority(); const action = createFixtureOnlyExternalVmArmAction({ publish: publish || (() => arm(root, armId, controlDirectory, entry, binding)), ...(entry.whenContextEquals ? { whenContextEquals: entry.whenContextEquals } : {}) });
  return withFaults({ [entry.cut]: action }, () => controller.installCheckpoint(() => authorityForInstall));
}

function isolate(root) { for (const key of ['USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'MYTHPEN_DATA_DIR', 'MYTHPEN_EXPORT_DIR']) process.env[key] = root; }
async function seedSchema10(root, name) {
  isolate(root); const database = require('../db');
  try { await database.initDatabase(); database.createProjectDb(name); const databasePath = database.getProjectDbPath(name); process.stdout.write(`${SCHEMA10_FRAME_PREFIX}${json({ databasePath })}\n`); } finally { database.closeAllDatabases(); }
}

function parseSchema10SeedOutput(stdout, fixtureRoot) {
  const frames = String(stdout || '').split(/\r?\n/).filter((line) => line.startsWith(SCHEMA10_FRAME_PREFIX));
  if (frames.length !== 1) throw new Error('Schema10 child must return exactly one prefixed frame');
  const encoded = frames[0].slice(SCHEMA10_FRAME_PREFIX.length); let frame;
  try { frame = JSON.parse(encoded); } catch { throw new Error('Schema10 child returned malformed frame JSON'); }
  if (json(frame) !== encoded || frame === null || typeof frame !== 'object' || Array.isArray(frame) || Object.keys(frame).join(',') !== 'databasePath' || typeof frame.databasePath !== 'string' || frame.databasePath.length === 0) throw new Error('Schema10 child frame is not canonical with exact keys');
  const configuredRoot = path.resolve(fixtureRoot); const configuredDatabase = path.resolve(frame.databasePath); const configuredRelative = path.relative(configuredRoot, configuredDatabase);
  if (!configuredRelative || configuredRelative.startsWith(`..${path.sep}`) || path.isAbsolute(configuredRelative)) throw new Error('Schema10 child returned a path outside fixture root');
  let stat;
  try { stat = fs.lstatSync(configuredDatabase); } catch { throw new Error('Schema10 child returned an unreadable database path'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Schema10 child returned a non-plain database path');
  const canonicalRoot = fs.realpathSync.native(configuredRoot); const canonicalDatabase = fs.realpathSync.native(configuredDatabase); const canonicalRelative = path.relative(canonicalRoot, canonicalDatabase);
  if (!canonicalRelative || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) throw new Error('Schema10 child returned a path outside fixture root');
  return canonicalDatabase;
}

function activationFixture(root, armId) {
  process.env.TEMP = path.dirname(root); process.env.TMP = path.dirname(root);
  const { createNativeStageCFixture } = require('./native-stage-c-fixture'); const { authorizeNativeActivation } = require('../native/native-activation-authority'); const fixture = createNativeStageCFixture(); const receipt = authorizeNativeActivation({ root: fixture.root }).consume();
  const child = spawnSync(process.execPath, ['seed-schema10', fixture.root, `directory-${armId.slice(0, 8)}`], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TEMP: path.dirname(root), TMP: path.dirname(root) }, windowsHide: true });
  if (child.error || child.status !== 0) throw new Error(`Schema10 seed failed: ${child.error?.message || child.stderr || child.stdout}`);
  const databasePath = parseSchema10SeedOutput(child.stdout, fixture.root); const dbKey = hash(require('../sqljs-atomic-store').canonicalDatabasePath(databasePath));
  return freeze({ root: fixture.root, databasePath, dbKey, controlDirectory: path.join(fixture.root, 'control', 'sqlite', dbKey), receipt });
}

function confinedPath(root, value, kind) {
  const resolvedRoot = fs.realpathSync.native(root); const resolved = fs.realpathSync.native(value); const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Directory activation crash descriptor ${kind} escapes fixture root`);
  return resolved;
}

function activationPreparedCrash(root, controlDirectory, armId) {
  const { withFaults, FAULT_POINTS } = require('./fault-injection'); const fixture = activationFixture(root, armId); fs.mkdirSync(controlDirectory, { recursive: true });
  const descriptor = freeze({ version: 1, type: PREPARED_CRASH_DESCRIPTOR_TYPE, root: fixture.root, databasePath: fixture.databasePath, controlDirectory: fixture.controlDirectory, dbKey: fixture.dbKey });
  writeDurableControlDescriptor(path.join(controlDirectory, `${armId}.prepared-crash.json`), descriptor);
  return withFaults({ [FAULT_POINTS.NATIVE_ACTIVATION_AFTER_PREPARED_POSTCHECK]: { crash: true } }, () => activate(fixture, fixture.receipt));
}

function preparedCrashFixture(root, controlDirectory, armId) {
  const child = spawnSync(process.execPath, ['activation-prepared-crash', root, controlDirectory, armId], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, TEMP: path.dirname(root), TMP: path.dirname(root) }, windowsHide: true });
  if (child.error || child.status === 0) throw new Error(`Directory activation prepared child did not terminate abnormally: ${child.error?.message || child.stderr || child.stdout}`);
  const descriptorPath = path.join(controlDirectory, `${armId}.prepared-crash.json`); let descriptor;
  try { descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')); } catch { throw new Error('Directory activation prepared crash descriptor is unreadable'); }
  if (descriptor?.version !== 1 || descriptor.type !== PREPARED_CRASH_DESCRIPTOR_TYPE || descriptor.root !== fs.realpathSync.native(descriptor.root) || descriptor.databasePath !== confinedPath(descriptor.root, descriptor.databasePath, 'database') || descriptor.controlDirectory !== confinedPath(descriptor.root, descriptor.controlDirectory, 'control') || descriptor.dbKey !== hash(require('../sqljs-atomic-store').canonicalDatabasePath(descriptor.databasePath))) throw new Error('Directory activation prepared crash descriptor is invalid');
  const events = require('../control-store').inspectControlStoreEvidence(descriptor.controlDirectory).events; const activation = events.filter((event) => event.type.startsWith('sqlite.native.activation.'));
  if (activation.length !== 1 || activation[0].type !== 'sqlite.native.activation.prepared' || activation[0].seq !== 3) throw new Error('Directory activation prepared crash evidence is not exact');
  return freeze({ root: descriptor.root, databasePath: descriptor.databasePath, controlDirectory: descriptor.controlDirectory, dbKey: descriptor.dbKey, receipt: null });
}

async function activate(fixture, receipt = null) {
  const SQL = await require('sql.js')({ wasmBinary: require('../wasm-binary').getWasmBinary() }); const { acquireConfigLifecycleLease } = require('../config-lifecycle-lease'); const { createProjectWriteCoordinator } = require('../project-write-coordinator'); const { openControlStore } = require('../control-store'); const { activateNativeProjectCore } = require('../native/native-activation'); const { assertDurabilitySupported } = require('../platform/durability');
  const config = acquireConfigLifecycleLease(path.join(fixture.root, 'config.db'), { controlRoot: path.join(fixture.root, 'application-control') }); const coordinator = createProjectWriteCoordinator({ lockRoot: path.join(fixture.root, 'project-write-leases') });
  try { return coordinator.withProjectRecoveryLeaseSync(fixture.databasePath, () => activateNativeProjectCore({ databasePath: fixture.databasePath, controlDirectory: fixture.controlDirectory, controlStore: openControlStore(fixture.controlDirectory), dbKey: fixture.dbKey, sqlModule: SQL, assertConfigLifecycleLease: config.assertHeld, assertWriterLease: () => coordinator.assertProjectWriteLease(fixture.databasePath), assertDurability: () => assertDurabilitySupported({ backend: 'win32', exclusiveLease: true, directoryFsync: true, atomicReplace: true, verifiedAbsentInstall: true }), activationReceipt: receipt })); } finally { config.release(); }
}

async function publishProgress(fixture) {
  const SQL = await require('sql.js')({ wasmBinary: require('../wasm-binary').getWasmBinary() }); const { createAtomicStore } = require('../sqljs-atomic-store'); const { createProjectWriteCoordinator } = require('../project-write-coordinator'); const { openControlStore } = require('../control-store'); const coordinator = createProjectWriteCoordinator({ lockRoot: path.join(fixture.root, 'project-write-leases') });
  return coordinator.withProjectRecoveryLeaseSync(fixture.databasePath, () => { const store = createAtomicStore({ filePath: fixture.databasePath, controlStore: openControlStore(fixture.controlDirectory), sqlModule: SQL, assertWriterLease: () => coordinator.assertProjectWriteLease(fixture.databasePath) }); try { store.recover(); const connection = store.currentConnection(); connection.run('INSERT INTO characters (id, name, background) VALUES (?, ?, ?)', [`directory-aborted-${randomUUID()}`, 'Directory Aborted Progress', 'directory-aborted-progress']); store.publish(connection); } finally { store.close(); } });
}

async function runActivation(root, entry, armId, controlDirectory, binding, { publish = null } = {}) {
  const { createFixtureOnlyExternalVmArmAction, withFaults } = require('./fault-injection'); const fixture = entry.scenario.startsWith('activation-aborted') ? preparedCrashFixture(root, controlDirectory, armId) : activationFixture(root, armId);
  if (entry.scenario.startsWith('activation-aborted')) await publishProgress(fixture);
  const action = createFixtureOnlyExternalVmArmAction({ publish: publish || (() => arm(root, armId, controlDirectory, entry, binding)), whenContextEquals: entry.whenContextEquals });
  return withFaults({ [entry.cut]: action }, async () => activate(fixture, fixture.receipt));
}

async function runCase(root, name, armId, controlDirectory) {
  const entry = scenario(name); if (!entry || !UUID.test(armId) || typeof controlDirectory !== 'string') fail('Invalid directory probe request'); const binding = bind(root);
  if (name.startsWith('checkpoint-')) return runCheckpoint(root, entry, armId, controlDirectory, binding);
  if (name.startsWith('activation-')) return runActivation(root, entry, armId, controlDirectory, binding);
  const { openControlStore } = require('../control-store'); const { createFixtureOnlyExternalVmArmAction, withFaults } = require('./fault-injection'); const directory = path.join(root, name === 'retire-before-dir-fsync' ? 'retire-control' : 'generic-control'); const store = openControlStore(directory); store.append({ type: 'directory.seed', payload: { armId } }); const action = createFixtureOnlyExternalVmArmAction({ publish: () => arm(root, armId, controlDirectory, entry, binding) });
  return withFaults({ [entry.cut]: action }, () => name === 'retire-before-dir-fsync' ? store.retire(`${directory}.retired-${randomUUID()}`, () => {}) : store.append({ type: 'directory.generic', payload: { armId } }));
}

function isPlainDirectory(candidate) {
  try { const stat = fs.lstatSync(candidate); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
}

function selectRetireColdDirectory(root) {
  const original = path.join(root, 'retire-control');
  const candidates = [];
  if (isPlainDirectory(original)) candidates.push(original);
  for (const name of fs.readdirSync(root)) {
    if (!RETIRED_CONTROL_DIRECTORY.test(name)) continue;
    const candidate = path.join(root, name);
    if (isPlainDirectory(candidate)) candidates.push(candidate);
  }
  if (candidates.length !== 1) throw new Error('Directory retire cold recovery requires exactly one plain directory candidate');
  return candidates[0];
}

function recoverDirectoryRetireColdState(root, armId) {
  const { inspectControlStoreEvidence, openControlStore } = require('../control-store'); const directory = selectRetireColdDirectory(root);
  const firstOpened = openControlStore(directory).read(); const firstInspected = inspectControlStoreEvidence(directory).events; const bytes = json(firstOpened);
  if (json(firstInspected) !== bytes) throw new Error('Directory retire official reopen and inspection disagree');
  if (firstOpened.length !== 1 || firstOpened[0]?.type !== 'directory.seed' || firstOpened[0]?.payload?.armId !== armId) throw new Error('Directory retire cold recovery lost its exact seed event');
  const secondOpened = openControlStore(directory).read(); const secondInspected = inspectControlStoreEvidence(directory).events;
  if (json(secondOpened) !== bytes || json(secondInspected) !== bytes) throw new Error('Second retire ControlStore reopen mutated evidence');
  return freeze({ directory, events: firstOpened, secondReopenStable: true });
}

function hasCause(error, expected) {
  for (let current = error; current; current = current.cause) if (current === expected) return true;
  return false;
}

function stableTree(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const candidate = path.join(directory, name); const stat = fs.lstatSync(candidate); const relative = path.relative(root, candidate);
      if (stat.isSymbolicLink()) throw new Error('Directory activation cold tree contains a symlink');
      if (stat.isDirectory()) { entries.push(`d:${relative}`); visit(candidate); continue; }
      if (!stat.isFile()) throw new Error('Directory activation cold tree contains a non-plain file');
      entries.push(`f:${relative}:${hash(fs.readFileSync(candidate))}`);
    }
  };
  visit(root); return entries;
}

async function coldStopAbortedActivation(fixture) {
  const { createFixtureOnlyExternalVmArmAction, withFaults, FAULT_POINTS } = require('./fault-injection'); const sentinel = Object.assign(new Error('Directory activation cold stop reached prepared candidate'), { code: 'DIRECTORY_ACTIVATION_COLD_STOP' }); let context = null; let candidateType = null;
  const action = createFixtureOnlyExternalVmArmAction({
    whenContextEquals: { seq: 7 },
    publish(value) {
      context = value; const candidate = JSON.parse(fs.readFileSync(value.tempPath, 'utf8'));
      if (candidate?.seq !== 7 || candidate.type !== 'sqlite.native.activation.prepared') throw new Error('Directory activation cold stop reached an inexact candidate');
      candidateType = candidate.type; throw sentinel;
    },
  });
  try { await withFaults({ [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: action }, () => activate(fixture)); } catch (error) {
    if (!hasCause(error, sentinel)) throw error;
  }
  if (!context || context.seq !== 7 || candidateType !== 'sqlite.native.activation.prepared' || typeof context.tempPath !== 'string' || typeof context.targetPath !== 'string') throw new Error('Directory activation cold stop did not reach exact prepared candidate 7');
  return freeze({ candidateSeq: context.seq, candidateType });
}

async function assertExactAbortedSchema10State(fixture) {
  const { inspectControlStoreEvidence } = require('../control-store'); const { inspectSqlJsAtomicStore } = require('../sqljs-atomic-store'); const events = inspectControlStoreEvidence(fixture.controlDirectory).events; const activation = events.filter((event) => event.type.startsWith('sqlite.native.activation.'));
  if (activation.length !== 2 || activation[0]?.seq !== 3 || activation[0]?.type !== 'sqlite.native.activation.prepared' || activation[1]?.seq !== 6 || activation[1]?.type !== 'sqlite.native.activation.aborted') throw new Error('Directory activation cold recovery did not retain exactly prepared 3 and aborted 6');
  const [prepared, aborted] = activation; const terminal = events.at(-2);
  if (!terminal || !['sqlite.publish.committed', 'sqlite.publish.rolled_back'].includes(terminal.type) || terminal.seq !== 5 || aborted.prevDigest !== terminal.digest || aborted.payload?.activationId !== prepared.payload?.activationId || aborted.payload?.preparedDigest !== prepared.digest || aborted.payload?.cleanV1TerminalDigest !== terminal.digest || aborted.payload?.formalSha256 !== hash(fs.readFileSync(fixture.databasePath)) || aborted.payload?.schemaVersion !== 10 || aborted.payload?.nativeStateAbsent !== true) throw new Error('Directory activation aborted evidence does not bind the current schema10 anchor');
  const stat = fs.lstatSync(fixture.databasePath, { bigint: true }); if (aborted.payload?.v1Identity?.dev !== String(stat.dev) || aborted.payload?.v1Identity?.ino !== String(stat.ino)) throw new Error('Directory activation aborted evidence identity differs from the current schema10 database');
  const SQL = await require('sql.js')({ wasmBinary: require('../wasm-binary').getWasmBinary() }); const inspection = inspectSqlJsAtomicStore({ controlDirectory: fixture.controlDirectory, events, filePath: fixture.databasePath, sqlModule: SQL, supportedSchemaVersion: 10 });
  if (inspection.state !== 'clean' || inspection.database?.isProject !== true || inspection.database?.schema !== 10 || inspection.database?.integrity?.integrityCheck !== 'ok' || inspection.database?.integrity?.foreignKeyCheck !== 'ok' || inspection.database?.triggerVersion !== null || inspection.database?.projectMetaTriggerSetDigest !== null) throw new Error('Directory activation cold database is not an exact clean schema10 source');
  const database = new Database(fixture.databasePath, { create: false, readonly: true, strict: true });
  try {
    const integrity = database.query('PRAGMA integrity_check').get(); const foreignKeys = database.query('PRAGMA foreign_key_check').all(); const gate = database.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").all(NATIVE_GATE_TABLE); const reserved = database.query(`SELECT key FROM project_meta WHERE key IN (${NATIVE_META_KEYS.map(() => '?').join(', ')}) ORDER BY key`).all(...NATIVE_META_KEYS); const { canonicalTriggerDefinitions } = require('../native/durability-schema'); const names = canonicalTriggerDefinitions().map(({ name }) => name); const triggers = database.query(`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND (name IN (${names.map(() => '?').join(', ')}) OR substr(name, 1, ?) = ?) ORDER BY name`).all(...names, NATIVE_TRIGGER_PREFIX.length, NATIVE_TRIGGER_PREFIX);
    if (Object.values(integrity || {})[0] !== 'ok' || foreignKeys.length !== 0 || gate.length !== 0 || reserved.length !== 0 || triggers.length !== 0) throw new Error('Directory activation cold schema10 source has native residue');
  } finally { database.close(); }
  return freeze({ events, activationTypes: activation.map((event) => `${event.seq}:${event.type}`), schemaVersion: 10, nativeStateAbsent: true, abortedCount: 1, activatedCount: 0, activationEvents: 2 });
}

function activationFixtureFromColdRoot(root) {
  const parent = path.dirname(root); const fixtureRoot = fs.readdirSync(parent).map((name) => path.join(parent, name)).find((candidate) => path.basename(candidate).startsWith('mythpen-native-stage-c-'));
  if (!fixtureRoot) throw new Error('Activation fixture root is missing'); const projectDir = path.join(fixtureRoot, 'projects'); const databasePath = path.join(projectDir, fs.readdirSync(projectDir)[0]); const dbKey = hash(require('../sqljs-atomic-store').canonicalDatabasePath(databasePath));
  return { root: fixtureRoot, databasePath, dbKey, controlDirectory: path.join(fixtureRoot, 'control', 'sqlite', dbKey) };
}

async function coldInspect(root, name, armId, controlDirectory) {
  const run = readDirectoryControlDescriptor(root, name, armId, controlDirectory); const entry = scenario(name); let convergence;
  if (run.scenario.startsWith('checkpoint-')) { const { openControlStore } = require('../control-store'); const directory = path.join(root, 'checkpoint-control'); const first = openControlStore(directory, { bounded: true }).readEvidence(); const bytes = json(first); if (json(openControlStore(directory, { bounded: true }).readEvidence()) !== bytes) throw new Error('Second checkpoint reopen mutated evidence'); convergence = { canonical: true, kind: 'checkpoint', checkpointDigest: first.checkpoint?.checkpointDigest || null, secondReopenStable: true }; }
  else if (run.scenario.startsWith('activation-')) { const fixture = activationFixtureFromColdRoot(root); const before = require('../control-store').inspectControlStoreEvidence(fixture.controlDirectory).events; const beforeActivation = before.filter((event) => event.type.startsWith('sqlite.native.activation.')); if (run.scenario.startsWith('activation-aborted-')) { const firstStop = await coldStopAbortedActivation(fixture); const first = await assertExactAbortedSchema10State(fixture); const databaseBytes = fs.readFileSync(fixture.databasePath); const evidenceBytes = json(first.events); const tree = json(stableTree(fixture.root)); const secondStop = await coldStopAbortedActivation(fixture); const second = await assertExactAbortedSchema10State(fixture); if (firstStop.candidateSeq !== 7 || firstStop.candidateType !== 'sqlite.native.activation.prepared' || secondStop.candidateSeq !== 7 || secondStop.candidateType !== 'sqlite.native.activation.prepared' || !databaseBytes.equals(fs.readFileSync(fixture.databasePath)) || evidenceBytes !== json(second.events) || tree !== json(stableTree(fixture.root))) throw new Error('Second activation aborted cold stop mutated durable database, evidence, or tree'); convergence = { canonical: true, kind: 'activation-schema10', schemaVersion: first.schemaVersion, nativeStateAbsent: first.nativeStateAbsent, abortedCount: first.abortedCount, activatedCount: first.activatedCount, activationEvents: first.activationEvents, secondReopenStable: true }; } else if (beforeActivation.length === 0) { if (!run.scenario.startsWith('activation-prepared-')) throw new Error('Activation terminal arm lost its prepared basis'); convergence = { canonical: true, kind: 'activation-schema10', activationEvents: 0, secondReopenStable: true }; } else { if (before.some((event) => event.type === 'sqlite.native.activation.prepared')) { const store = await activate(fixture); store.close(); } const events = require('../control-store').inspectControlStoreEvidence(fixture.controlDirectory).events; const activated = events.filter((event) => event.type === 'sqlite.native.activation.activated'); if (activated.length !== 1) throw new Error('Official activation recovery did not converge exactly once'); const bytes = json(events); const reopened = await activate(fixture); reopened.close(); if (json(require('../control-store').inspectControlStoreEvidence(fixture.controlDirectory).events) !== bytes) throw new Error('Second activation reopen mutated evidence'); convergence = { canonical: true, kind: 'activation', activationEvents: events.filter((event) => event.type.startsWith('sqlite.native.activation.')).length, secondReopenStable: true }; } }
  else if (run.scenario === 'retire-before-dir-fsync') { const recovered = recoverDirectoryRetireColdState(root, armId); convergence = { canonical: true, kind: 'retire', eventCount: recovered.events.length, secondReopenStable: recovered.secondReopenStable }; }
  else { const { inspectControlStoreEvidence, openControlStore } = require('../control-store'); const original = path.join(root, run.scenario === 'retire-before-dir-fsync' ? 'retire-control' : 'generic-control'); const directory = fs.existsSync(original) ? original : fs.readdirSync(root).map((name) => path.join(root, name)).find((candidate) => path.basename(candidate).startsWith('retire-control.retired-')); const first = inspectControlStoreEvidence(directory).events; const bytes = json(first); if (json(openControlStore(directory).read()) !== bytes) throw new Error('Second ControlStore reopen mutated evidence'); convergence = { canonical: true, kind: run.scenario === 'retire-before-dir-fsync' ? 'retire' : 'event', eventCount: first.length, secondReopenStable: true }; }
  process.stdout.write(`${JSON.stringify(freeze({ version: 1, type: INSPECT_TYPE, armId, scenario: run.scenario, cut: entry.cut, binding: run.binding, convergence, externalVmResetVerified: false, capability: false }))}\n`);
}

async function checkpointSelfTest(rootValue, name, armId) {
  const entry = scenario(name); if (!entry?.scenario.startsWith('checkpoint-') || !UUID.test(armId)) fail('Invalid directory checkpoint self-test request');
  const root = path.resolve(rootValue); fs.mkdirSync(root, { recursive: true }); const sentinel = Object.assign(new Error('Directory checkpoint self-test reached exact arm'), { code: 'DIRECTORY_CHECKPOINT_SELF_TEST_SENTINEL' }); let reached = false;
  try { await runCheckpoint(root, entry, armId, path.join(root, 'control'), bind(root), { publish() { reached = true; throw sentinel; } }); } catch (error) { for (let current = error; current; current = current.cause) { if (current === sentinel && reached) { process.stdout.write(`${JSON.stringify({ type: 'windows.native.directory.checkpoint-self-test.v1', scenario: name, armId, reached: true })}\n`); return; } } throw error; }
  throw new Error('Directory checkpoint self-test did not reach exact arm');
}

async function activationSelfTest(rootValue, name, armId) {
  const entry = scenario(name); if (!entry?.scenario.startsWith('activation-') || !UUID.test(armId) || !Number.isSafeInteger(entry.whenContextEquals?.seq)) fail('Invalid directory activation self-test request');
  const root = path.resolve(rootValue); fs.mkdirSync(root, { recursive: true }); const sentinel = Object.assign(new Error('Directory activation self-test reached exact arm'), { code: 'DIRECTORY_ACTIVATION_SELF_TEST_SENTINEL' }); let reached = false; let context = null; let candidateType = null;
  try { await runActivation(root, entry, armId, path.join(root, 'control'), bind(root), { publish(value) { context = value; const candidate = JSON.parse(fs.readFileSync(value.tempPath, 'utf8')); if (candidate?.seq !== value.seq || typeof candidate.type !== 'string') throw new Error('Directory activation self-test candidate is inexact'); candidateType = candidate.type; reached = true; throw sentinel; } }); } catch (error) {
    for (let current = error; current; current = current.cause) {
      if (current !== sentinel || !reached) continue;
      if (!context || context.seq !== entry.whenContextEquals.seq || typeof context.targetPath !== 'string') throw new Error('Directory activation self-test did not reach its exact selector');
      const { inspectControlStoreEvidence } = require('../control-store'); const events = inspectControlStoreEvidence(path.dirname(context.targetPath)).events; const tail = events.at(-1);
      if (!tail || tail.seq !== context.seq - 1) throw new Error('Directory activation self-test evidence has the wrong sequence basis');
      const activationTypes = events.filter((event) => event.type.startsWith('sqlite.native.activation.')).map((event) => `${event.seq}:${event.type}`);
      const progressTerminalSeq = name.startsWith('activation-aborted-') ? tail.seq : null;
      if (name.startsWith('activation-aborted-') && tail.type !== 'sqlite.publish.committed') throw new Error('Directory activation self-test did not establish its exact progress terminal');
      process.stdout.write(`${JSON.stringify({ type: 'windows.native.directory.activation-self-test.v1', scenario: name, armId, reached: true, candidateType, selectorSeq: context.seq, evidenceTailSeq: tail.seq, progressTerminalSeq, activationTypes })}\n`); return;
    }
    throw error;
  }
  throw new Error('Directory activation self-test did not reach exact arm');
}

async function activationColdSelfTest(rootValue, name, armId) {
  const entry = scenario(name); if (!entry?.scenario.startsWith('activation-aborted-') || !UUID.test(armId)) fail('Invalid directory activation cold self-test request');
  const root = path.resolve(rootValue); fs.mkdirSync(root, { recursive: true }); const fixture = preparedCrashFixture(root, path.join(root, 'control'), armId); await publishProgress(fixture); const firstStop = await coldStopAbortedActivation(fixture); const first = await assertExactAbortedSchema10State(fixture); const databaseBytes = fs.readFileSync(fixture.databasePath); const evidenceBytes = json(first.events); const tree = json(stableTree(fixture.root)); const secondStop = await coldStopAbortedActivation(fixture); const second = await assertExactAbortedSchema10State(fixture);
  if (firstStop.candidateSeq !== 7 || firstStop.candidateType !== 'sqlite.native.activation.prepared' || secondStop.candidateSeq !== 7 || secondStop.candidateType !== 'sqlite.native.activation.prepared' || !databaseBytes.equals(fs.readFileSync(fixture.databasePath)) || evidenceBytes !== json(second.events) || tree !== json(stableTree(fixture.root))) throw new Error('Directory activation cold self-test did not remain byte stable');
  process.stdout.write(`${JSON.stringify({ type: 'windows.native.directory.activation-cold-self-test.v1', scenario: name, armId, candidateType: firstStop.candidateType, candidateSeq: firstStop.candidateSeq, activationTypes: first.activationTypes, schemaVersion: first.schemaVersion, nativeStateAbsent: first.nativeStateAbsent, abortedCount: first.abortedCount, activatedCount: first.activatedCount, activationEvents: first.activationEvents, secondReopenStable: true })}\n`);
}

async function main() { if (process.platform !== 'win32' || getBuildInfo().nativeActivationMode !== 'fixture_only') fail('Probe build is disabled'); const [command, rootValue, third, fourth] = process.argv.slice(2); if (command === 'seed-schema10') return seedSchema10(path.resolve(rootValue), third); if (command === 'activation-prepared-crash') return activationPreparedCrash(path.resolve(rootValue), third, fourth); if (command === 'checkpoint-self-test') return checkpointSelfTest(rootValue, third, fourth); if (command === 'activation-self-test') return activationSelfTest(rootValue, third, fourth); if (command === 'activation-cold-self-test') return activationColdSelfTest(rootValue, third, fourth); const request = parseDirectoryProbeArguments(process.argv); if (request) return runCase(exactRoot(request.rootValue, true), request.scenario, request.armId, request.controlDirectory); const cold = parseDirectoryColdInspectionArguments(process.argv); if (cold) return coldInspect(exactRoot(cold.rootValue), cold.scenario, cold.armId, cold.controlDirectory); fail('Unknown directory probe command'); }

if (require.main === module) main().catch((error) => fail(error?.stack || error?.message || String(error)));

module.exports = { parseDirectoryProbeArguments, parseDirectoryColdInspectionArguments, readDirectoryControlDescriptor };
Object.defineProperty(module.exports, 'recoverDirectoryRetireColdState', { value: recoverDirectoryRetireColdState, enumerable: false });
Object.defineProperty(module.exports, 'parseSchema10SeedOutput', { value: parseSchema10SeedOutput, enumerable: false });
Object.defineProperty(module.exports, 'volumeBinding', { value: volumeBinding, enumerable: false });
