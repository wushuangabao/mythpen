const { createHash } = require('node:crypto');

const {
  requireEmbeddedWindowsNativeDurabilityProfile,
} = require('../platform/windows-native-durability-profile');

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const receipts = new WeakMap();

function unsupported(message = 'Production native activation authority is unavailable') {
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

function authorizeProductionNativeActivation(input) {
  const profile = requireEmbeddedWindowsNativeDurabilityProfile();
  if (
    !exactObject(input, ['canonicalDatabasePath', 'dbKey'])
    || typeof input.canonicalDatabasePath !== 'string'
    || !HASH_PATTERN.test(input.dbKey || '')
    || createHash('sha256').update(input.canonicalDatabasePath).digest('hex') !== input.dbKey
  ) throw unsupported('Production native activation path binding is invalid');
  const receipt = Object.freeze({});
  receipts.set(receipt, Object.freeze({
    authorizationDigest: profile.authorizationDigest,
    canonicalDatabasePath: input.canonicalDatabasePath,
    dbKey: input.dbKey,
  }));
  return receipt;
}

function assertProductionNativeActivationReceipt(receipt, expected) {
  const profile = requireEmbeddedWindowsNativeDurabilityProfile();
  const record = receipts.get(receipt);
  if (
    !exactObject(expected, ['canonicalDatabasePath', 'dbKey'])
    || !record
    || record.authorizationDigest !== profile.authorizationDigest
    || record.canonicalDatabasePath !== expected.canonicalDatabasePath
    || record.dbKey !== expected.dbKey
  ) throw unsupported('Production native activation receipt is invalid');
  receipts.delete(receipt);
  return record;
}

module.exports = {
  assertProductionNativeActivationReceipt,
  authorizeProductionNativeActivation,
};
