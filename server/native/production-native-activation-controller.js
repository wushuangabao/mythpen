const { createHash } = require('node:crypto');
const path = require('node:path');

const {
  requireEmbeddedWindowsNativeDurabilityProfile,
} = require('../platform/windows-native-durability-profile');
const {
  requireWindowsNativeDirectoryEntryDurability,
} = require('../platform/windows-native-directory-capability');
const {
  requireWindowsNativeRollbackJournalDurability,
} = require('../platform/windows-native-rollback-capability');

const HASH_PATTERN = /^[0-9a-f]{64}$/;
let registrar = null;
let controller = null;

function unsupported(message = 'Production native activation controller is unavailable') {
  const error = new Error(message);
  error.code = 'DURABILITY_UNSUPPORTED';
  return error;
}

function exactObject(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function initializeProductionNativeActivationControllerFactory(register) {
  if (registrar !== null || typeof register !== 'function' || register.length !== 1) {
    throw unsupported('Production controller registry initialization is invalid');
  }
  registrar = register;
}

function createProductionNativeActivationController() {
  if (arguments.length !== 0) throw unsupported('Runtime callers cannot supply production authority');
  requireEmbeddedWindowsNativeDurabilityProfile();
  requireWindowsNativeRollbackJournalDurability();
  requireWindowsNativeDirectoryEntryDurability();
  if (controller) return controller;
  if (registrar === null) require('./native-activation-controller');
  if (registrar === null) throw unsupported();

  const candidate = Object.freeze({
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
      ) throw unsupported('Production activation dependencies are inexact');

      const { canonicalDatabasePath } = require('../sqljs-atomic-store');
      const canonicalPath = canonicalDatabasePath(path.resolve(input.databasePath));
      if (createHash('sha256').update(canonicalPath).digest('hex') !== input.dbKey) {
        throw unsupported('Production activation database binding is invalid');
      }
      const {
        authorizeProductionNativeActivation,
      } = require('./production-native-activation-authority');
      const activationReceipt = authorizeProductionNativeActivation({
        canonicalDatabasePath: canonicalPath,
        dbKey: input.dbKey,
      });
      const { assertDurabilitySupported, detectCapabilities } = require('../platform/durability');
      const { activateNativeProjectCore } = require('./native-activation');
      const capabilities = assertDurabilitySupported(detectCapabilities());
      return activateNativeProjectCore({
        ...input,
        activationReceipt,
        assertDurability: () => capabilities,
      });
    },
  });
  controller = registrar(candidate);
  return controller;
}

module.exports = { createProductionNativeActivationController };
Object.defineProperty(module.exports, 'initializeProductionNativeActivationControllerFactory', {
  value: initializeProductionNativeActivationControllerFactory,
  enumerable: false,
});
