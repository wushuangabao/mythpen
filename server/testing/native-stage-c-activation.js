const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { acquireConfigLifecycleLease } = require('../config-lifecycle-lease');
const { inspectControlStoreEvidence, openControlStore } = require('../control-store');
const {
  assertConsumedNativeActivationReceipt,
  authorizeNativeActivation,
} = require('../native/native-activation-authority');
const { activateNativeProjectCore } = require('../native/native-activation');
const { createProjectWriteCoordinator } = require('../project-write-coordinator');
const { assertDurabilitySupported } = require('../platform/durability');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { getWasmBinary } = require('../wasm-binary');
const stageCFixture = require('./native-stage-c-fixture');

const descriptors = new WeakMap();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
let sqlModulePromise = null;

function loadSqlModule() {
  if (sqlModulePromise === null) {
    sqlModulePromise = require('sql.js')({ wasmBinary: getWasmBinary() });
  }
  return sqlModulePromise;
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

function physicalIdentity(databasePath) {
  const stats = fs.lstatSync(databasePath, { bigint: true });
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function sentinelDigest(databasePath, sentinel) {
  const { Database } = require('bun:sqlite');
  const database = new Database(databasePath, { create: false, readonly: true, strict: true });
  try {
    const rows = database.query(
      'SELECT id, name, background FROM characters WHERE id = ? ORDER BY id',
    ).all(sentinel.id);
    if (rows.length !== 1) throw new Error('Stage C sentinel was not durably created');
    return sha256(canonicalJson(rows));
  } finally {
    database.close();
  }
}

function cleanV1Terminal(events) {
  const terminal = [...events].reverse().find((event) => (
    event.type === 'sqlite.publish.committed' || event.type === 'sqlite.publish.rolled_back'
  ));
  if (!terminal || !SHA256_PATTERN.test(terminal.digest || '')) {
    throw new Error('Stage C schema10 fixture has no clean v1 terminal');
  }
  return terminal.digest;
}

function createNativeStageCActivationFixture(options = {}) {
  if (
    options === null
    || typeof options !== 'object'
    || Array.isArray(options)
    || !['name,sentinel', 'name,nativeResidue,sentinel'].includes(
      Object.keys(options).sort().join(','),
    )
  ) {
    throw new TypeError('Stage C activation fixture options are inexact');
  }
  const base = stageCFixture.createNativeStageCFixture();
  let success = false;
  try {
    const authority = authorizeNativeActivation({ root: base.root });
    const receipt = authority.consume();
    assertConsumedNativeActivationReceipt(receipt);
    const project = stageCFixture.createSchema10ProjectInConsumedFixture(receipt, options);
    const databasePath = project.databasePath;
    const dbKey = sha256(canonicalDatabasePath(databasePath));
    const controlDirectory = path.join(base.root, 'control', 'sqlite', dbKey);
    const events = inspectControlStoreEvidence(controlDirectory).events;
    const descriptor = Object.freeze({
      root: base.root,
      databasePath,
      controlDirectory,
      dbKey,
      name: project.name,
      sentinel: project.sentinel,
      sentinelDigest: sentinelDigest(databasePath, project.sentinel),
      markerDigest: base.markerDigest,
      cleanV1TerminalDigest: cleanV1Terminal(events),
      v1FormalSha256: sha256(fs.readFileSync(databasePath)),
      v1Identity: physicalIdentity(databasePath),
    });
    descriptors.set(descriptor, Object.freeze({ receipt }));
    success = true;
    return descriptor;
  } finally {
    if (!success) fs.rmSync(base.root, { recursive: true, force: true });
  }
}

function validateDescriptor(fixture) {
  const keys = [
    'cleanV1TerminalDigest',
    'controlDirectory',
    'databasePath',
    'dbKey',
    'markerDigest',
    'name',
    'root',
    'sentinel',
    'sentinelDigest',
    'v1FormalSha256',
    'v1Identity',
  ];
  if (
    !Object.isFrozen(fixture)
    || Object.keys(fixture).sort().join(',') !== keys.sort().join(',')
    || ![fixture.dbKey, fixture.markerDigest, fixture.cleanV1TerminalDigest,
      fixture.sentinelDigest, fixture.v1FormalSha256].every((value) => SHA256_PATTERN.test(value || ''))
  ) {
    const error = new Error('Stage C activation fixture descriptor is inexact');
    error.code = 'NATIVE_ACTIVATION_DISABLED';
    throw error;
  }
  const root = path.resolve(fixture.root);
  for (const target of [fixture.databasePath, fixture.controlDirectory]) {
    const relative = path.relative(root, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      const error = new Error('Stage C activation fixture path escapes its helper root');
      error.code = 'NATIVE_ACTIVATION_DISABLED';
      throw error;
    }
  }
}

async function activateNativeStageCFixture(fixture) {
  validateDescriptor(fixture);
  const privateState = descriptors.get(fixture) || null;
  const evidence = inspectControlStoreEvidence(fixture.controlDirectory).events;
  const hasActivation = evidence.some((event) => (
    event.type === 'sqlite.native.activation.prepared'
    || event.type === 'sqlite.native.activation.activated'
  ));
  if (!hasActivation && privateState === null) {
    const error = new Error('Fresh Stage C activation requires the live helper authority');
    error.code = 'NATIVE_ACTIVATION_DISABLED';
    throw error;
  }
  const controlStore = openControlStore(fixture.controlDirectory);
  const configLease = acquireConfigLifecycleLease(path.join(fixture.root, 'config.db'), {
    controlRoot: path.join(fixture.root, 'application-control'),
  });
  const coordinator = createProjectWriteCoordinator({
    lockRoot: path.join(fixture.root, 'project-write-leases'),
  });
  let store;
  let primaryError;
  try {
    const sqlModule = await loadSqlModule();
    const rawStore = coordinator.withProjectRecoveryLeaseSync(fixture.databasePath, () => {
      const assertWriterLease = () => coordinator.assertProjectWriteLease(fixture.databasePath);
      return activateNativeProjectCore({
        databasePath: fixture.databasePath,
        controlDirectory: fixture.controlDirectory,
        controlStore,
        dbKey: fixture.dbKey,
        sqlModule,
        assertConfigLifecycleLease: configLease.assertHeld,
        assertWriterLease,
        assertDurability: () => assertDurabilitySupported({
          backend: process.platform === 'win32' ? 'win32' : 'posix',
          exclusiveLease: true,
          directoryFsync: true,
          atomicReplace: true,
          verifiedAbsentInstall: true,
        }),
        activationReceipt: privateState?.receipt,
      });
    });
    const invoke = (method, ...args) => coordinator.withProjectRecoveryLeaseSync(
      fixture.databasePath,
      () => rawStore[method](...args),
    );
    store = Object.freeze({
      get connectionEpoch() {
        return rawStore.connectionEpoch;
      },
      get state() {
        return rawStore.state;
      },
      readAll(sql, ...params) {
        return invoke('readAll', sql, ...params);
      },
      readGet(sql, ...params) {
        return invoke('readGet', sql, ...params);
      },
      executeTransaction(input, callback) {
        return invoke('executeTransaction', input, callback);
      },
      recover() {
        return invoke('recover');
      },
      close() {
        return invoke('close');
      },
      fence() {
        return invoke('fence');
      },
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    configLease.release();
  } catch (releaseError) {
    if (!primaryError) primaryError = releaseError;
  }
  if (primaryError) throw primaryError;
  return store;
}

module.exports = {
  activateNativeStageCFixture,
  createNativeStageCActivationFixture,
};
