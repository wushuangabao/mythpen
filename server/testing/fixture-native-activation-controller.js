const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { getBuildInfo } = require('../build-info');
const { assertDurabilitySupported, detectCapabilities } = require('../platform/durability');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function disabled(message = 'Fixture native activation is disabled') {
  const error = new Error(message);
  error.code = 'NATIVE_ACTIVATION_DISABLED';
  return error;
}

function exactObject(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function inside(root, target) {
  const relative = path.relative(root, path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertActivatedEvidence(root) {
  try {
    const sqliteRoot = path.join(root, 'control', 'sqlite');
    const stats = fs.lstatSync(sqliteRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw disabled();
    const { assertActivatedNativeEvidence } = require('../native/native-activation');
    const { inspectControlStoreEvidence } = require('../control-store');
    let activatedCount = 0;
    for (const entry of fs.readdirSync(sqliteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !HASH_PATTERN.test(entry.name)) continue;
      const controlDirectory = path.join(sqliteRoot, entry.name);
      const evidence = inspectControlStoreEvidence(controlDirectory).events;
      if (!evidence.some((event) => event.type === 'sqlite.native.activation.activated')) continue;
      assertActivatedNativeEvidence({
        controlDirectory,
        dbKey: entry.name,
      });
      activatedCount += 1;
    }
    if (activatedCount < 1) throw disabled('Fixture reopen requires activated evidence');
  } catch (error) {
    if (error?.code === 'NATIVE_ACTIVATION_DISABLED') throw error;
    throw disabled('Fixture reopen requires exact activated evidence');
  }
}

function createFixtureNativeActivationController(options) {
  if (
    getBuildInfo().nativeActivationMode !== 'fixture_only'
    || !exactObject(options, options?.receipt === null ? ['receipt', 'root'] : ['receipt', 'root'])
    || typeof options.root !== 'string'
    || (options.receipt !== null && (typeof options.receipt !== 'object' || options.receipt.root !== options.root))
  ) {
    throw disabled();
  }
  const root = path.resolve(options.root);
  if (options.receipt === null) assertActivatedEvidence(root);
  const receipt = options.receipt;
  const controller = Object.freeze({
    activate(input) {
      if (
        !exactObject(input, [
          'assertConfigLifecycleLease',
          'assertWriterLease',
          'controlDirectory',
          'controlStore',
          'databasePath',
          'dbKey',
          'sqlModule',
        ])
        || typeof input.databasePath !== 'string'
        || typeof input.controlDirectory !== 'string'
        || !HASH_PATTERN.test(input.dbKey || '')
        || !inside(root, input.databasePath)
        || !inside(root, input.controlDirectory)
        || path.resolve(input.controlDirectory) !== path.join(root, 'control', 'sqlite', input.dbKey)
        || createHash('sha256').update(canonicalDatabasePath(input.databasePath)).digest('hex') !== input.dbKey
      ) {
        throw disabled('Fixture activation path binding is invalid');
      }
      if (receipt === null) {
        const { assertActivatedNativeEvidence } = require('../native/native-activation');
        assertActivatedNativeEvidence({
          controlDirectory: input.controlDirectory,
          dbKey: input.dbKey,
        });
      }
      const { activateNativeProjectCore } = require('../native/native-activation');
      const capabilities = assertDurabilitySupported(detectCapabilities());
      return activateNativeProjectCore({
        ...input,
        activationReceipt: receipt,
        assertDurability: () => capabilities,
      });
    },
  });
  const installedInfo = Object.freeze({ activationMode: 'fixture_only', root });
  const {
    registerFixtureNativeActivationController,
  } = require('../native/native-activation-controller');
  return registerFixtureNativeActivationController(controller, installedInfo);
}

module.exports = { createFixtureNativeActivationController };
