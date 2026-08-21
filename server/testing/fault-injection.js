const FAULT_MAP_ENV = 'MYTHPEN_FAULT_MAP';
const fs = require('node:fs');
const path = require('node:path');
const { types: utilTypes } = require('node:util');
const { existsSync } = fs;
const CRASH_ARTIFACTS_PATH_ENV = 'MYTHPEN_CRASH_ARTIFACTS_PATH';
const CRASH_MARKER_PATH_ENV = 'MYTHPEN_CRASH_MARKER_PATH';
const CRASH_MARKER_TOKEN_ENV = 'MYTHPEN_CRASH_MARKER_TOKEN';
const CRASH_MARKER_VERSION = 1;
const crashMarkerToken = process.env[CRASH_MARKER_TOKEN_ENV];
const killProcess = process.kill.bind(process);
delete process.env[CRASH_MARKER_TOKEN_ENV];

const FAULT_POINTS = Object.freeze({
  ATOMIC_STORE_PUBLISH_CORRUPT_CANDIDATE: 'atomicstore.publish.corrupt-candidate',
  ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE: 'atomicstore.publish.before-candidate-write',
  ATOMIC_STORE_PUBLISH_AFTER_CANDIDATE_WRITE: 'atomicstore.publish.after-candidate-write',
  ATOMIC_STORE_PUBLISH_BEFORE_REPLACE: 'atomicstore.publish.before-replace',
  ATOMIC_STORE_PUBLISH_AFTER_REPLACE: 'atomicstore.publish.after-replace',
  ATOMIC_STORE_PUBLISH_AFTER_TERMINAL_APPEND: 'atomicstore.publish.after-terminal-append',
  ATOMIC_STORE_PUBLISH_BEFORE_EPOCH_INSTALL: 'atomicstore.publish.before-epoch-install',
  ATOMIC_STORE_RECOVER_BEFORE_TERMINAL_APPEND: 'atomicstore.recover.before-terminal-append',
  ATOMIC_STORE_RECOVER_AFTER_TERMINAL_APPEND: 'atomicstore.recover.after-terminal-append',
  ATOMIC_STORE_RECOVER_AFTER_ROLLBACK_REPLACE: 'atomicstore.recover.after-rollback-replace',
  ATOMIC_STORE_RECOVER_AFTER_ROLLBACK_DIR_FSYNC: 'atomicstore.recover.after-rollback-dir-fsync',
  ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE: 'atomicstore.close.before-database-close',
  CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC: 'controlstore.append.before-dir-fsync',
  CONTROL_STORE_APPEND_BEFORE_PUBLISH: 'controlstore.append.before-publish',
  CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC: 'controlstore.tail.before-dir-fsync',
  CONTROL_STORE_TAIL_BEFORE_PUBLISH: 'controlstore.tail.before-publish',
  CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH: 'controlstore.checkpoint.before-publish',
  CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK:
    'controlstore.checkpoint.before-candidate-unlink',
  CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC:
    'controlstore.checkpoint.before-final-dir-fsync',
  CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC:
    'controlstore.checkpoint.after-final-dir-fsync',
  CONTROL_STORE_CHECKPOINT_BEFORE_GC: 'controlstore.checkpoint.before-gc',
  CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY: 'controlstore.checkpoint.after-gc-entry',
  CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC:
    'controlstore.checkpoint.before-gc-dir-fsync',
  CONTROL_STORE_RETIRE_BEFORE_DIR_FSYNC: 'controlstore.retire.before-dir-fsync',
  FILE_PUBLICATION_AFTER_ASSETS_RESERVED:
    'file-publication.after-assets-reserved',
  FILE_PUBLICATION_AFTER_ASSET_CREATE:
    'file-publication.after-asset-create',
  FILE_PUBLICATION_AFTER_TARGET_ASSET_CREATE:
    'file-publication.after-target-asset-create',
  FILE_PUBLICATION_AFTER_TARGET_RESERVED:
    'file-publication.after-target-reserved',
  FILE_PUBLICATION_AFTER_PREPARED:
    'file-publication.after-prepared',
  FILE_PUBLICATION_AFTER_RELOCATE:
    'file-publication.after-relocate',
  FILE_PUBLICATION_AFTER_FILES_PUBLISHED:
    'file-publication.after-files-published',
  FILE_PUBLICATION_AFTER_PROJECTION_PUBLISH:
    'file-publication.after-projection-publish',
  FILE_PUBLICATION_AFTER_ASSET_DELETE:
    'file-publication.after-asset-delete',
  NATIVE_CALLER_AFTER_SOURCE_POSTCHECK: 'native.caller.after-source-postcheck',
  NATIVE_TX_AFTER_PREPARED_POSTCHECK: 'native.tx.after-prepared-postcheck',
  NATIVE_TX_AFTER_BEGIN_ACQUIRED: 'native.tx.after-begin-acquired',
  NATIVE_TX_AFTER_GATE_INSERT: 'native.tx.after-gate-insert',
  NATIVE_TX_AFTER_BUSINESS_CALLBACK: 'native.tx.after-business-callback',
  NATIVE_TX_AFTER_SEQ_CAS: 'native.tx.after-seq-cas',
  NATIVE_TX_AFTER_GATE_DELETE: 'native.tx.after-gate-delete',
  NATIVE_TX_BEFORE_COMMIT_INVOKE: 'native.tx.before-commit-invoke',
  NATIVE_TX_AFTER_COMMIT_RETURN: 'native.tx.after-commit-return',
  NATIVE_TX_BEFORE_TERMINAL_APPEND: 'native.tx.before-terminal-append',
  NATIVE_TX_AFTER_TERMINAL_POSTCHECK: 'native.tx.after-terminal-postcheck',
  NATIVE_FULL_REFRESH_BEFORE_COMMIT_INVOKE:
    'native.full-refresh.before-commit-invoke',
  NATIVE_FULL_REFRESH_AFTER_COMMIT_RETURN:
    'native.full-refresh.after-commit-return',
  NATIVE_FULL_REFRESH_AFTER_FILE_FSYNC:
    'native.full-refresh.after-file-fsync',
  NATIVE_FULL_REFRESH_AFTER_DIRECTORY_FSYNC:
    'native.full-refresh.after-directory-fsync',
  NATIVE_FULL_REFRESH_AFTER_GUARD_RECHECK:
    'native.full-refresh.after-guard-recheck',
  NATIVE_FULL_REFRESH_AFTER_TARGET_RECHECK:
    'native.full-refresh.after-target-recheck',
  NATIVE_AUXILIARY_BEFORE_COMMIT_INVOKE:
    'native.auxiliary.before-commit-invoke',
  NATIVE_AUXILIARY_AFTER_COMMIT_RETURN:
    'native.auxiliary.after-commit-return',
  NATIVE_AUXILIARY_AFTER_FILE_FSYNC:
    'native.auxiliary.after-file-fsync',
  NATIVE_AUXILIARY_AFTER_DIRECTORY_FSYNC:
    'native.auxiliary.after-directory-fsync',
  NATIVE_AUXILIARY_AFTER_GUARD_RECHECK:
    'native.auxiliary.after-guard-recheck',
  NATIVE_AUXILIARY_AFTER_RECEIPT_RECHECK:
    'native.auxiliary.after-receipt-recheck',
  NATIVE_ACTIVATION_AFTER_PREPARED_POSTCHECK: 'native.activation.after-prepared-postcheck',
  NATIVE_ACTIVATION_AFTER_V1_FENCE_CLOSE: 'native.activation.after-v1-fence-close',
  NATIVE_ACTIVATION_AFTER_SOURCE_RECHECK: 'native.activation.after-source-recheck',
  NATIVE_ACTIVATION_AFTER_SCHEMA11_INSTALL: 'native.activation.after-schema11-install',
  NATIVE_ACTIVATION_AFTER_POSTCOMMIT_INSPECT: 'native.activation.after-postcommit-inspect',
  NATIVE_ACTIVATION_AFTER_ACTIVATED_POSTCHECK: 'native.activation.after-activated-postcheck',
  NATIVE_ACTIVATION_AFTER_NATIVE_REOPEN: 'native.activation.after-native-reopen',
  DEMO_STEP: 'demo.step',
  DEMO_AFTER_TEMP_WRITE: 'demo.after-temp-write',
});

function deserializeFaults(serializedFaults) {
  if (!serializedFaults) return new Map();
  return new Map(Object.entries(JSON.parse(serializedFaults)));
}

let activeFaults = deserializeFaults(process.env[FAULT_MAP_ENV]);
const externalVmArmActions = new WeakMap();

function exactPlainDataEntries(value, isValueValid, requireNonEmpty = false) {
  if (value === null || typeof value !== 'object') return null;

  try {
    if (utilTypes.isProxy(value) || Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (requireNonEmpty && keys.length === 0) return null;
    const entries = [];
    for (const key of keys) {
      if (typeof key !== 'string') return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || !isValueValid(descriptor.value)
      ) return null;
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function hasExactExternalVmArmOptionKeys(entries) {
  const keys = entries.map(([key]) => key).sort();
  return [
    'publish',
    'publish,whenContextEquals',
    'publish,whenContextEquals,whenFileExists',
    'publish,whenFileExists',
  ].includes(keys.join(','));
}

function copyExactFaultContextSelector(selector) {
  const entries = exactPlainDataEntries(selector, isFaultSelectorScalar, true);
  if (!entries) return null;
  const copy = {};
  for (const [key, value] of entries) {
    Object.defineProperty(copy, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return Object.freeze(copy);
}

function createFixtureOnlyExternalVmArmAction(options) {
  const { getBuildInfo } = require('../build-info');
  if (getBuildInfo().nativeActivationMode !== 'fixture_only') {
    throw new Error('External VM arm actions require a fixture_only compiled probe');
  }
  const optionEntries = exactPlainDataEntries(options, () => true);
  if (!optionEntries || !hasExactExternalVmArmOptionKeys(optionEntries)) {
    throw new TypeError('External VM arm action is inexact');
  }
  const optionValues = new Map(optionEntries);
  const publish = optionValues.get('publish');
  const hasWhenFileExists = optionValues.has('whenFileExists');
  const hasWhenContextEquals = optionValues.has('whenContextEquals');
  const whenFileExists = optionValues.get('whenFileExists');
  const selector = optionValues.get('whenContextEquals');
  if (
    typeof publish !== 'function'
    || (
      hasWhenFileExists
      && (typeof whenFileExists !== 'string' || whenFileExists.length === 0)
    )
  ) throw new TypeError('External VM arm action is inexact');

  const action = {};
  if (hasWhenFileExists) action.whenFileExists = whenFileExists;
  if (hasWhenContextEquals) {
    const selectorCopy = copyExactFaultContextSelector(selector);
    if (!selectorCopy) throw new TypeError('External VM arm action is inexact');
    action.whenContextEquals = selectorCopy;
  }
  externalVmArmActions.set(action, publish);
  return Object.freeze(action);
}

function runExternalVmArmAction(action, context) {
  const publish = externalVmArmActions.get(action);
  if (!publish) return false;
  if (
    Object.prototype.hasOwnProperty.call(action, 'whenFileExists')
    && !existsSync(action.whenFileExists)
  ) return true;
  if (!matchesContextSelector(action, context)) return true;
  publish(context);
  throw new Error('External VM arm publisher returned instead of blocking');
}

function cloneCrashContext(context) {
  const seen = new WeakSet();
  try {
    const serialized = JSON.stringify(context, (_key, value) => {
      if (typeof value === 'bigint') return `${value}n`;
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    if (serialized === undefined) return '[Unserializable context]';
    return JSON.parse(serialized);
  } catch {
    return '[Unserializable context]';
  }
}

function crashAtFaultPoint(name, context) {
  const markerPath = process.env[CRASH_MARKER_PATH_ENV];
  const marker = {
    name,
    pid: process.pid,
    signal: 'SIGKILL',
    token: crashMarkerToken,
    version: CRASH_MARKER_VERSION,
  };
  if (context !== undefined) marker.context = cloneCrashContext(context);

  if (markerPath) {
    try {
      fs.writeFileSync(markerPath, JSON.stringify(marker));
      const { fsyncDirectory, fsyncFile } = require('../platform/durability');
      fsyncFile(markerPath);
      fsyncDirectory(path.dirname(markerPath));
    } catch (error) {
      try {
        fs.rmSync(markerPath, { force: true });
      } catch (cleanupError) {
        error.cleanupError = cleanupError;
        error.secondaryErrors = [...(error.secondaryErrors || []), cleanupError];
      }
      throw error;
    }
  }
  killProcess(process.pid, 'SIGKILL');
  return false;
}

function isFaultSelectorScalar(value) {
  return (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  );
}

function matchesContextSelector(action, context) {
  let actionDescriptor;
  try {
    actionDescriptor = Object.getOwnPropertyDescriptor(action, 'whenContextEquals');
  } catch {
    return false;
  }
  if (!actionDescriptor) return true;
  if (!Object.prototype.hasOwnProperty.call(actionDescriptor, 'value')) return false;
  const selector = actionDescriptor.value;
  if (selector === null || typeof selector !== 'object' || Array.isArray(selector)) {
    return false;
  }
  if (context === null || typeof context !== 'object') return false;

  let keys;
  try {
    if (Object.getPrototypeOf(selector) !== Object.prototype) return false;
    keys = Reflect.ownKeys(selector);
  } catch {
    return false;
  }
  for (const key of keys) {
    if (typeof key !== 'string') return false;
    let selectorDescriptor;
    let contextDescriptor;
    try {
      selectorDescriptor = Object.getOwnPropertyDescriptor(selector, key);
      contextDescriptor = Object.getOwnPropertyDescriptor(context, key);
    } catch {
      return false;
    }
    if (
      !selectorDescriptor
      || !selectorDescriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(selectorDescriptor, 'value')
      || !isFaultSelectorScalar(selectorDescriptor.value)
      || !contextDescriptor
      || !Object.prototype.hasOwnProperty.call(contextDescriptor, 'value')
      || contextDescriptor.value !== selectorDescriptor.value
    ) {
      return false;
    }
  }
  return true;
}

function crashOnlyFaultPoint(name, context) {
  const action = activeFaults.get(name);
  if (runExternalVmArmAction(action, context)) return false;
  if (action === null || typeof action !== 'object' || action.crash !== true) return false;
  if (!matchesContextSelector(action, context)) return false;
  return crashAtFaultPoint(name, context);
}

function faultPoint(name, context) {
  if (activeFaults.size === 0) return false;

  const action = activeFaults.get(name);
  if (!action) return false;

  if (runExternalVmArmAction(action, context)) return false;

  if (Object.prototype.hasOwnProperty.call(action, 'whenFileExists')) {
    if (
      typeof action.whenFileExists !== 'string'
      || action.whenFileExists.length === 0
      || !existsSync(action.whenFileExists)
    ) return false;
  }

  if (!matchesContextSelector(action, context)) return false;

  if (typeof action.callback === 'function') action.callback(context);

  if (action.crash === true) {
    return crashAtFaultPoint(name, context);
  }

  if (action.throw) {
    const error = new Error(`Injected fault ${action.throw} at ${name}`);
    error.code = action.throw;
    error.faultPoint = name;
    error.context = context;
    throw error;
  }

  return action.active === true;
}

async function withFaults(faults, fn) {
  const previousFaults = activeFaults;
  activeFaults = new Map(Object.entries(faults));
  try {
    return await fn();
  } finally {
    activeFaults = previousFaults;
  }
}

module.exports = {
  CRASH_ARTIFACTS_PATH_ENV,
  CRASH_MARKER_PATH_ENV,
  CRASH_MARKER_TOKEN_ENV,
  CRASH_MARKER_VERSION,
  FAULT_MAP_ENV,
  FAULT_POINTS,
  createFixtureOnlyExternalVmArmAction,
  crashOnlyFaultPoint,
  faultPoint,
  withFaults,
};
