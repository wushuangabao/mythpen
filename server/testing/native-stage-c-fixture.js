const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FIXTURE_ROOT_PREFIX = 'mythpen-native-stage-c-';
const MARKER_NAME = '.native-stage-c-activation.json';
const MARKER_TTL_MS = 2 * 60 * 1000;
const STATE_KEY = Symbol.for('mythpen.native-stage-c-fixture-state.v1');

function fixtureState() {
  if (!globalThis[STATE_KEY]) {
    Object.defineProperty(globalThis, STATE_KEY, {
      configurable: false,
      enumerable: false,
      value: new Map(),
      writable: false,
    });
  }
  return globalThis[STATE_KEY];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileIdentity(targetPath) {
  const stats = fs.lstatSync(targetPath, { bigint: true });
  return Object.freeze({
    dev: String(stats.dev),
    ino: String(stats.ino),
    mode: String(stats.mode),
    nlink: String(stats.nlink),
    size: String(stats.size),
  });
}

function createNativeStageCFixture(...args) {
  if (args.length !== 0) throw new TypeError('Stage C fixture helper does not accept options');
  const tempParent = fs.realpathSync.native(os.tmpdir());
  const createdRoot = fs.mkdtempSync(path.join(tempParent, FIXTURE_ROOT_PREFIX));
  let root = createdRoot;
  try {
    root = fs.realpathSync.native(createdRoot);
    const runId = randomUUID().toLowerCase();
    const rootDigest = sha256(root);
    const expiresAt = Date.now() + MARKER_TTL_MS;
    const marker = { version: 1, runId, rootDigest, expiresAt };
    const markerBytes = Buffer.from(JSON.stringify(marker), 'utf8');
    const markerPath = path.join(root, MARKER_NAME);
    fs.writeFileSync(markerPath, markerBytes, { flag: 'wx' });
    const markerDigest = sha256(markerBytes);
    fixtureState().set(root, {
      expiresAt,
      markerDigest,
      markerIdentity: fileIdentity(markerPath),
      markerPath,
      rootDigest,
      rootIdentity: fileIdentity(root),
      runId,
      state: 'fresh',
    });
    return Object.freeze({ root, markerPath, runId, rootDigest, expiresAt, markerDigest });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function validateProjectName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(name)) {
    throw new TypeError('Stage C fixture name must contain only letters, digits, underscore, or hyphen');
  }
  return name;
}

function validateSentinel(sentinel) {
  if (
    sentinel === null
    || typeof sentinel !== 'object'
    || Array.isArray(sentinel)
    || Object.keys(sentinel).sort().join(',') !== 'background,id,name'
    || !['background', 'id', 'name'].every((key) => (
      typeof sentinel[key] === 'string' && sentinel[key].length > 0
    ))
  ) {
    throw new TypeError('Stage C sentinel must have exact non-empty id, name, and background strings');
  }
  return Object.freeze({ id: sentinel.id, name: sentinel.name, background: sentinel.background });
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

function createSchema10ProjectInConsumedFixture(receipt, options) {
  const state = fixtureState().get(receipt?.root);
  if (
    !state
    || state.state !== 'consumed'
    || receipt.runId !== state.runId
    || receipt.markerDigest !== state.markerDigest
    || fs.readdirSync(receipt.root).length !== 0
  ) {
    throw new Error('Stage C schema10 project requires the exact consumed helper fixture');
  }
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || !['name,sentinel', 'name,nativeResidue,sentinel'].includes(
      Object.keys(options).sort().join(','),
    )
  ) {
    throw new TypeError('Stage C schema10 project options are inexact');
  }
  const name = validateProjectName(options.name);
  const sentinel = validateSentinel(options.sentinel);
  if (
    options.nativeResidue !== undefined
    && !['gate', 'trigger-prefix'].includes(options.nativeResidue)
  ) {
    throw new TypeError('Stage C native residue must be gate or trigger-prefix');
  }
  const fixtureScript = path.join(__dirname, '..', 'tests', 'fixtures', 'create-native-stage-b-fixture.js');
  const result = spawnSync(
    process.execPath,
    [fixtureScript, JSON.stringify({
      isolatedRoot: receipt.root,
      projectName: name,
      sentinel,
      ...(options.nativeResidue === undefined ? {} : { nativeResidue: options.nativeResidue }),
    })],
    {
      cwd: path.join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: isolatedEnvironment(receipt.root),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Stage C schema10 child failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  const prefix = 'MYTHPEN_NATIVE_STAGE_B_FIXTURE=';
  const line = String(result.stdout || '').split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error('Stage C schema10 child did not return its database path');
  const child = JSON.parse(line.slice(prefix.length));
  const databasePath = path.resolve(child.databasePath);
  const relative = path.relative(receipt.root, databasePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(databasePath)) {
    throw new Error('Stage C schema10 child returned a path outside its helper root');
  }
  state.state = 'project-created';
  return Object.freeze({ databasePath, name, sentinel });
}

module.exports = {
  createNativeStageCFixture,
};

Object.defineProperty(module.exports, 'createSchema10ProjectInConsumedFixture', {
  value: createSchema10ProjectInConsumedFixture,
  enumerable: false,
  writable: false,
  configurable: false,
});
