const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openControlStore } = require('../../control-store');
const { fsyncDirectory } = require('../../platform/durability');
const { createNativeStageBFixture } = require('../../testing/native-stage-b-fixture');
const { createStageBFixtureStore } = require('../../testing/native-stage-b-store');
const {
  CRASH_ARTIFACTS_PATH_ENV,
  FAULT_POINTS,
  crashOnlyFaultPoint,
} = require('../../testing/fault-injection');

const SCENARIOS = Object.freeze({
  'caller-source-postcheck': 'native.caller.after-source-postcheck',
  'after-prepared-postcheck': 'native.tx.after-prepared-postcheck',
  'after-begin-acquired': 'native.tx.after-begin-acquired',
  'after-gate-insert': 'native.tx.after-gate-insert',
  'after-business-callback': 'native.tx.after-business-callback',
  'after-seq-cas': 'native.tx.after-seq-cas',
  'after-gate-delete': 'native.tx.after-gate-delete',
  'before-commit-invoke': 'native.tx.before-commit-invoke',
  'after-commit-return': 'native.tx.after-commit-return',
  'before-terminal-append': 'native.tx.before-terminal-append',
  'terminal-before-publish': 'controlstore.append.before-publish',
  'terminal-before-dir-fsync': 'controlstore.append.before-dir-fsync',
  'after-terminal-postcheck': 'native.tx.after-terminal-postcheck',
});
const scenario = process.env.MYTHPEN_NATIVE_PROJECT_STORE_CRASH_SCENARIO;
const artifactsPath = process.env[CRASH_ARTIFACTS_PATH_ENV];
if (!Object.prototype.hasOwnProperty.call(SCENARIOS, scenario)) {
  throw new Error('native project store crash scenario is not exact');
}
if (typeof artifactsPath !== 'string' || artifactsPath.length === 0) {
  throw new Error(`${CRASH_ARTIFACTS_PATH_ENV} is required`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function appendSource(fixture, store, rowId) {
  const controlStore = openControlStore(fixture.controlDirectory);
  const [genesis] = controlStore.read();
  const previous = controlStore.tail();
  controlStore.compareAndAppend(previous.digest, {
    type: 'manuscript.source',
    payload: {
      version: 1,
      eventId: randomUUID(),
      dbKey: genesis.payload.dbKey,
      projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
      createdAt: new Date().toISOString(),
      ownershipHash: genesis.payload.ownershipHash,
      connectionEpoch: store.connectionEpoch,
      logicalRequestDigest: sha256(`native-crash:${scenario}`),
      attemptSeq: 1,
      previousAttemptSourceDigest: null,
      operationKind: 'chapter_body_write',
      targetKind: 'character',
      targetIdSha256: sha256(rowId),
      expectedDataVersion: null,
    },
  });
  const source = controlStore.tail();
  if (
    source.type !== 'manuscript.source'
    || source.payload.connectionEpoch !== store.connectionEpoch
    || source.payload.targetIdSha256 !== sha256(rowId)
  ) {
    throw new Error('native crash source post-check failed');
  }
  return source;
}

function publishArtifacts(artifacts) {
  const bytes = JSON.stringify(artifacts);
  const descriptor = fs.openSync(artifactsPath, 'w');
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(artifactsPath));
  if (fs.readFileSync(artifactsPath, 'utf8') !== bytes) {
    throw new Error('native crash artifacts post-check failed');
  }
}

let workerFixtureRoot = null;
let workerArmPath = null;

function terminalArmPath(parentPid = process.ppid) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('native crash arm requires an exact parent pid');
  }
  return path.join(
    fs.realpathSync.native(os.tmpdir()),
    `mythpen-native-task4-arm-${parentPid}-${scenario}.ready`,
  );
}

function armCommittedTerminalFault() {
  if (!['terminal-before-publish', 'terminal-before-dir-fsync'].includes(scenario)) return;
  workerArmPath = terminalArmPath();
  const descriptor = fs.openSync(workerArmPath, 'wx');
  try {
    fs.writeFileSync(descriptor, 'armed\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(workerArmPath));
  if (fs.readFileSync(workerArmPath, 'utf8') !== 'armed\n') {
    throw new Error('native crash terminal arm post-check failed');
  }
}

function cleanFailedWorkerFixture() {
  if (workerArmPath !== null) fs.rmSync(workerArmPath, { force: true });
  if (workerFixtureRoot === null) return;
  const resolved = path.resolve(workerFixtureRoot);
  const tempParent = fs.realpathSync.native(os.tmpdir());
  const canonical = (value) => (
    process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value)
  );
  const stats = fs.lstatSync(resolved);
  if (
    canonical(path.dirname(resolved)) !== canonical(tempParent)
    || !path.basename(resolved).startsWith('mythpen-native-stage-b-')
    || !stats.isDirectory()
    || stats.isSymbolicLink()
  ) {
    throw new Error('refusing to clean an uncontrolled failed crash fixture');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function main() {
  const fixture = createNativeStageBFixture({ name: `task4-crash-${scenario}` });
  workerFixtureRoot = fixture.root;
  const store = createStageBFixtureStore(fixture);
  const rowId = `task4-crash-${scenario}`;
  const source = appendSource(fixture, store, rowId);
  publishArtifacts({
    version: 1,
    scenario,
    rowId,
    sourceDigest: source.digest,
    fixture: {
      controlDirectory: fixture.controlDirectory,
      databasePath: fixture.databasePath,
      databaseSha256: fixture.databaseSha256,
      fixtureRunId: fixture.fixtureRunId,
      genesisDigest: fixture.genesisDigest,
      name: fixture.name,
      root: fixture.root,
    },
  });

  if (scenario === 'caller-source-postcheck') {
    crashOnlyFaultPoint(FAULT_POINTS.NATIVE_CALLER_AFTER_SOURCE_POSTCHECK, {
      sourceDigest: source.digest,
    });
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
        `Crash ${scenario}`,
        'non-secret crash fixture row',
      );
      armCommittedTerminalFault();
    });
  }
  throw new Error(`configured native crash point was not reached: ${SCENARIOS[scenario]}`);
}

try {
  main();
} catch (error) {
  try {
    cleanFailedWorkerFixture();
  } catch (cleanupError) {
    error.cleanupError = cleanupError;
  }
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
