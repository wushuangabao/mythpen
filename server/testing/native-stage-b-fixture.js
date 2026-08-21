const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('bun:sqlite');

const { resolveStableApplicationControlRoot } = require('../application-control-paths');
const { inspectControlStoreEvidence, openControlStore } = require('../control-store');
const { REGISTRY_KEY } = require('../path-store');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { resolveStoragePaths } = require('../storage-paths');
const {
  inspectSchema11Contract,
  installSchema11Contract,
} = require('../native/durability-schema');

const RESULT_PREFIX = 'MYTHPEN_NATIVE_STAGE_B_FIXTURE=';
const FIXTURE_EVENT_TYPE = 'sqlite.native.stage_b.fixture_genesis';
const FIXTURE_ROOT_PREFIX = 'mythpen-native-stage-b-';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bytewiseSort(values) {
  return values.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function metadataSnapshot(targetPath) {
  const absolute = path.resolve(targetPath);
  if (!fs.existsSync(absolute)) return Object.freeze({ path: absolute, exists: false, digest: null });
  const rows = [];
  function visit(current, relative) {
    const stats = fs.lstatSync(current, { bigint: true });
    rows.push({
      path: relative,
      type: stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
      size: String(stats.size),
      mtimeNs: String(stats.mtimeNs),
      dev: String(stats.dev),
      ino: String(stats.ino),
      nlink: String(stats.nlink),
    });
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    for (const name of bytewiseSort(fs.readdirSync(current))) {
      visit(path.join(current, name), relative ? path.join(relative, name) : name);
    }
  }
  visit(absolute, '');
  return Object.freeze({ path: absolute, exists: true, digest: sha256(JSON.stringify(rows)) });
}

function pathStoreSnapshot(homeDir) {
  if (process.platform === 'win32') {
    const result = spawnSync('reg.exe', ['query', REGISTRY_KEY], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return Object.freeze({
      kind: 'registry',
      key: REGISTRY_KEY,
      status: result.status,
      digest: sha256(`${result.status}\0${result.stdout || ''}\0${result.stderr || ''}`),
    });
  }
  return Object.freeze({
    kind: 'file',
    ...metadataSnapshot(path.join(homeDir, '.mythpen-paths.json')),
  });
}

function snapshotDefaultUserRoots() {
  const homeDir = os.homedir();
  const storage = resolveStoragePaths();
  return Object.freeze({
    dataRoot: metadataSnapshot(storage.dataDir),
    controlRoot: metadataSnapshot(resolveStableApplicationControlRoot({ homeDir })),
    pathStoreRoot: pathStoreSnapshot(homeDir),
  });
}

function validateFixtureName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
    throw new TypeError('Stage B fixture name must contain only letters, digits, underscore, or hyphen');
  }
  return name;
}

function isolatedEnvironment(root) {
  return {
    ...process.env,
    USERPROFILE: root,
    HOME: root,
    LOCALAPPDATA: root,
    APPDATA: root,
    MYTHPEN_DATA_DIR: root,
    MYTHPEN_EXPORT_DIR: root,
  };
}

function canonicalPath(filePath) {
  const resolved = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createControlledFixtureRoot() {
  const tempParent = fs.realpathSync.native(os.tmpdir());
  return fs.mkdtempSync(path.join(tempParent, FIXTURE_ROOT_PREFIX));
}

function assertControlledFixtureRoot(root) {
  const resolved = path.resolve(root);
  const tempParent = fs.realpathSync.native(os.tmpdir());
  if (
    canonicalPath(path.dirname(resolved)) !== canonicalPath(tempParent)
    || !path.basename(resolved).startsWith(FIXTURE_ROOT_PREFIX)
  ) {
    throw new Error('Refusing to recursively clean an uncontrolled Stage B fixture root');
  }
  if (fs.existsSync(resolved)) {
    const stats = fs.lstatSync(resolved);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Refusing to recursively clean a non-directory Stage B fixture root');
    }
  }
  return resolved;
}

function removeControlledFixtureRoot(root) {
  fs.rmSync(assertControlledFixtureRoot(root), { recursive: true, force: true });
}

function parseChildResult(result) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Schema 10 fixture child failed with exit ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  const line = String(result.stdout || '').split(/\r?\n/)
    .find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) throw new Error('Schema 10 fixture child did not return its database path');
  return JSON.parse(line.slice(RESULT_PREFIX.length));
}

function createSchema10ProjectFixture(options = {}) {
  if (options && typeof options === 'object' && Reflect.has(options, 'root')) {
    throw new TypeError('options.root is not supported; fixture roots are helper-owned');
  }
  const name = validateFixtureName(options.name || `stage-b-${randomUUID()}`);
  const root = createControlledFixtureRoot();
  const fixtureScript = path.join(__dirname, '..', 'tests', 'fixtures', 'create-native-stage-b-fixture.js');
  let childResult;
  try {
    childResult = parseChildResult(spawnSync(
      process.execPath,
      [fixtureScript, JSON.stringify({ isolatedRoot: root, projectName: name })],
      {
        cwd: path.join(__dirname, '..', '..'),
        encoding: 'utf8',
        env: isolatedEnvironment(root),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    ));
    const databasePath = path.resolve(childResult.databasePath);
    if (path.relative(root, databasePath).startsWith('..') || !fs.existsSync(databasePath)) {
      throw new Error('Schema 10 fixture child returned a path outside its isolated root');
    }
    return Object.freeze({ root, databasePath, name });
  } catch (error) {
    removeControlledFixtureRoot(root);
    throw error;
  }
}

function physicalFileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new Error(`Stage B fixture database is not a single-link plain file: ${filePath}`);
  }
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

function postCheckGenesis({ controlDirectory, databasePath, payload, appended }) {
  const database = new Database(databasePath, { create: false, strict: true });
  let contract;
  try {
    contract = inspectSchema11Contract(database);
  } finally {
    database.clearQueryCache();
    database.close(true);
  }
  const evidence = inspectControlStoreEvidence(controlDirectory);
  if (evidence.events.length !== 1) throw new Error('Stage B fixture ControlStore must contain exactly one event');
  const [genesis] = evidence.events;
  if (
    genesis.type !== FIXTURE_EVENT_TYPE
    || genesis.digest !== appended.digest
    || canonicalJson(genesis.payload) !== canonicalJson(payload)
  ) {
    throw new Error('Stage B fixture genesis post-check failed');
  }
  if (
    contract.projectInstanceIdSha256 !== payload.projectInstanceIdSha256
    || contract.schemaVersion !== payload.schemaVersion
    || contract.backend !== payload.backend
    || contract.finalSeq !== payload.finalSeq
    || contract.gateEmpty !== payload.gateEmpty
    || contract.triggerVersion !== payload.triggerVersion
    || contract.triggerSetDigest !== payload.triggerSetDigest
    || canonicalJson(physicalFileIdentity(databasePath)) !== canonicalJson(payload.identity)
  ) {
    throw new Error('Stage B fixture database and genesis evidence differ');
  }
  return appended.digest;
}

function createNativeStageBFixture(options = {}) {
  const schema10 = createSchema10ProjectFixture(options);
  const { root, databasePath, name } = schema10;
  try {
    const database = new Database(databasePath, { create: false, strict: true });
    let contract;
    try {
      contract = installSchema11Contract(database);
    } finally {
      database.clearQueryCache();
      database.close(true);
    }

    const dbKey = sha256(canonicalDatabasePath(databasePath));
    const identity = physicalFileIdentity(databasePath);
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
    if (controlStore.read().length !== 0) throw new Error('Stage B fixture genesis requires empty evidence');
    if (typeof options.beforeGenesisAppend === 'function') {
      options.beforeGenesisAppend(Object.freeze({ root, databasePath, controlDirectory }));
    }
    const appended = controlStore.compareAndAppend(null, { type: FIXTURE_EVENT_TYPE, payload });
    const genesisDigest = postCheckGenesis({
      controlDirectory,
      databasePath,
      payload,
      appended,
    });
    if (!SHA256_PATTERN.test(genesisDigest)) throw new Error('Stage B fixture genesis digest is invalid');
    return Object.freeze({
      root,
      name,
      databasePath,
      controlDirectory,
      fixtureRunId,
      genesisDigest,
      databaseSha256: sha256(fs.readFileSync(databasePath)),
    });
  } catch (error) {
    removeControlledFixtureRoot(root);
    throw error;
  }
}

module.exports = {
  createNativeStageBFixture,
  createSchema10ProjectFixture,
  snapshotDefaultUserRoots,
};
