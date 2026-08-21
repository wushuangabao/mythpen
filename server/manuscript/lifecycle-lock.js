'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createAssetVerified,
  fsyncDirectory,
  fsyncFile,
  inspectPath,
  readVerified,
} = require('../platform/durability');

const EMPTY_BYTES = Buffer.alloc(0);
const EMPTY_SHA256 = crypto.createHash('sha256').update(EMPTY_BYTES).digest('hex');
const MANUSCRIPT_LIFECYCLE_LOCK_DERIVATION =
  'canonical-real-control-directory-sibling-sha256-v1';

function recoveryRequired(message, cause, details = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'RECOVERY_REQUIRED';
  Object.assign(error, details);
  return error;
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function snapshotIdentity(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 2
    || typeof value.dev !== 'string'
    || !/^(?:0|[1-9]\d*)$/.test(value.dev)
    || typeof value.ino !== 'string'
    || !/^(?:0|[1-9]\d*)$/.test(value.ino)
  ) throw recoveryRequired(`${label} is not one exact physical identity`);
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function exactFrozenData(value, keys, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Object.isFrozen(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError(`${label} must be one frozen plain-data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || actual.some((key) => {
      const descriptor = descriptors[key];
      return descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value');
    })
  ) throw new TypeError(`${label} has an invalid shape`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function requireFrozenIdentity(value, label) {
  const identity = exactFrozenData(value, ['dev', 'ino'], label);
  if (
    typeof identity.dev !== 'string'
    || !/^(?:0|[1-9]\d*)$/.test(identity.dev)
    || typeof identity.ino !== 'string'
    || !/^(?:0|[1-9]\d*)$/.test(identity.ino)
  ) throw new TypeError(`${label} must be one frozen canonical physical identity`);
  return value;
}

function assertManuscriptLifecycleLockReceipt(value) {
  const receipt = exactFrozenData(value, [
    'version',
    'lifecycleLockBefore',
    'lifecycleLockAfter',
    'lifecyclePlatformIdentity',
  ], 'lifecycle lock receipt');
  if (receipt.version !== 1) throw new TypeError('lifecycle lock receipt version is unsupported');
  const beforeShape = exactFrozenData(
    receipt.lifecycleLockBefore,
    receipt.lifecycleLockBefore?.disposition === 'present'
      ? ['byteSize', 'disposition', 'identity', 'parentIdentity', 'sha256']
      : ['disposition', 'parentIdentity'],
    'lifecycle lock before receipt',
  );
  const after = exactFrozenData(receipt.lifecycleLockAfter, [
    'byteSize',
    'fileFsync',
    'identity',
    'parentFsync',
    'parentIdentity',
    'sha256',
  ], 'lifecycle lock after receipt');
  const platform = exactFrozenData(receipt.lifecyclePlatformIdentity, [
    'canonicalRealControlDirectory',
    'controlDirectoryIdentity',
    'controlParentDirectoryIdentity',
    'lifecycleLockIdentity',
  ], 'lifecycle platform identity');
  deriveManuscriptLifecycleLockPath(platform.canonicalRealControlDirectory);
  requireFrozenIdentity(platform.controlDirectoryIdentity, 'controlDirectoryIdentity');
  requireFrozenIdentity(platform.controlParentDirectoryIdentity, 'controlParentDirectoryIdentity');
  requireFrozenIdentity(platform.lifecycleLockIdentity, 'lifecycleLockIdentity');
  requireFrozenIdentity(beforeShape.parentIdentity, 'lifecycleLockBefore.parentIdentity');
  if (beforeShape.disposition === 'present') {
    requireFrozenIdentity(beforeShape.identity, 'lifecycleLockBefore.identity');
  }
  requireFrozenIdentity(after.identity, 'lifecycleLockAfter.identity');
  requireFrozenIdentity(after.parentIdentity, 'lifecycleLockAfter.parentIdentity');
  if (
    !['absent', 'present'].includes(beforeShape.disposition)
    || after.byteSize !== 0
    || after.fileFsync !== true
    || after.parentFsync !== true
    || after.sha256 !== EMPTY_SHA256
    || !sameIdentity(
      beforeShape.parentIdentity,
      receipt.lifecyclePlatformIdentity.controlParentDirectoryIdentity,
    )
    || !sameIdentity(
      after.parentIdentity,
      receipt.lifecyclePlatformIdentity.controlParentDirectoryIdentity,
    )
    || !sameIdentity(after.identity, receipt.lifecyclePlatformIdentity.lifecycleLockIdentity)
    || (
      beforeShape.disposition === 'present'
      && (
        beforeShape.byteSize !== 0
        || beforeShape.sha256 !== EMPTY_SHA256
        || !sameIdentity(beforeShape.identity, platform.lifecycleLockIdentity)
      )
    )
  ) throw new TypeError('lifecycle lock receipt does not bind one durable empty lock');
  return value;
}

function assertManuscriptLifecycleLockPreflight(value) {
  const disposition = value?.disposition;
  if (disposition === 'absent') {
    const preflight = exactFrozenData(value, [
      'version',
      'disposition',
      'plannedControlDirectory',
      'plannedLifecycleLockPath',
    ], 'lifecycle lock absent preflight');
    if (
      preflight.version !== 1
      || preflight.plannedLifecycleLockPath
        !== deriveManuscriptLifecycleLockPath(preflight.plannedControlDirectory)
    ) throw new TypeError('lifecycle lock absent preflight does not bind one planned lock path');
    return value;
  }
  const preflight = exactFrozenData(value, [
    'version',
    'disposition',
    'byteSize',
    'canonicalRealControlDirectory',
    'controlDirectoryIdentity',
    'controlParentDirectoryIdentity',
    'lifecycleLockIdentity',
    'linkCount',
    'reparse',
    'sha256',
  ], 'lifecycle lock present preflight');
  if (
    preflight.version !== 1
    || preflight.disposition !== 'present'
    || preflight.byteSize !== 0
    || preflight.linkCount !== 1
    || preflight.reparse !== false
    || preflight.sha256 !== EMPTY_SHA256
  ) throw new TypeError('lifecycle lock present preflight does not describe one plain empty file');
  deriveManuscriptLifecycleLockPath(preflight.canonicalRealControlDirectory);
  requireFrozenIdentity(preflight.controlDirectoryIdentity, 'preflight controlDirectoryIdentity');
  requireFrozenIdentity(
    preflight.controlParentDirectoryIdentity,
    'preflight controlParentDirectoryIdentity',
  );
  requireFrozenIdentity(preflight.lifecycleLockIdentity, 'preflight lifecycleLockIdentity');
  return value;
}

function inspectControlDirectory(canonicalRealControlDirectory) {
  let observation;
  try {
    observation = inspectPath(canonicalRealControlDirectory);
  } catch (cause) {
    throw recoveryRequired('Lifecycle ControlStore directory is unavailable', cause);
  }
  if (
    observation?.actualName !== path.basename(canonicalRealControlDirectory)
    || observation.kind !== 'directory'
    || observation.linkCount !== null
    || observation.reparse !== false
    || observation.realPath !== canonicalRealControlDirectory
    || observation.parentRealPath !== path.dirname(canonicalRealControlDirectory)
  ) throw recoveryRequired('Lifecycle ControlStore directory is not one canonical plain directory');
  return Object.freeze({
    identity: snapshotIdentity(observation.identity, 'Lifecycle ControlStore identity'),
    parentIdentity: snapshotIdentity(
      observation.parentIdentity,
      'Lifecycle ControlStore parent identity',
    ),
  });
}

function deriveManuscriptLifecycleLockPath(canonicalRealControlDirectory) {
  if (
    typeof canonicalRealControlDirectory !== 'string'
    || canonicalRealControlDirectory.length === 0
    || canonicalRealControlDirectory.includes('\0')
    || !path.isAbsolute(canonicalRealControlDirectory)
    || path.resolve(canonicalRealControlDirectory) !== canonicalRealControlDirectory
  ) throw new TypeError('canonicalRealControlDirectory must be one canonical absolute path');
  const digest = crypto.createHash('sha256')
    .update(Buffer.from(canonicalRealControlDirectory, 'utf8'))
    .digest('hex');
  return path.join(
    path.dirname(canonicalRealControlDirectory),
    `.manuscript-${digest}.lifecycle.lock`,
  );
}

function inspectExistingLifecycleLock(canonicalRealControlDirectory) {
  const control = inspectControlDirectory(canonicalRealControlDirectory);
  const lockPath = deriveManuscriptLifecycleLockPath(canonicalRealControlDirectory);
  let observation;
  try {
    observation = inspectPath(lockPath);
  } catch (cause) {
    throw recoveryRequired('Preexisting lifecycle lock is unavailable', cause, { created: false });
  }
  if (
    observation?.actualName !== path.basename(lockPath)
    || observation.byteSize !== 0
    || observation.kind !== 'file'
    || observation.linkCount !== 1
    || observation.reparse !== false
    || observation.realPath !== lockPath
    || observation.parentRealPath !== path.dirname(lockPath)
    || !sameIdentity(observation.parentIdentity, control.parentIdentity)
  ) throw recoveryRequired('Preexisting lifecycle lock is not one canonical plain empty file', undefined, {
    created: false,
  });
  const lifecycleLockIdentity = snapshotIdentity(
    observation.identity,
    'Preexisting lifecycle lock identity',
  );
  try {
    readVerified(lockPath, Object.freeze({
      byteSize: 0,
      disposition: 'present',
      identity: lifecycleLockIdentity,
      parentIdentity: control.parentIdentity,
      sha256: EMPTY_SHA256,
    }));
  } catch (cause) {
    throw recoveryRequired('Preexisting lifecycle lock content is not stable and empty', cause, {
      created: false,
    });
  }
  const afterControl = inspectControlDirectory(canonicalRealControlDirectory);
  if (
    !sameIdentity(control.identity, afterControl.identity)
    || !sameIdentity(control.parentIdentity, afterControl.parentIdentity)
  ) throw recoveryRequired('Lifecycle ControlStore identity changed during preflight', undefined, {
    created: false,
  });
  return Object.freeze({
    controlDirectoryIdentity: control.identity,
    controlParentDirectoryIdentity: control.parentIdentity,
    lifecycleLockIdentity,
    lockPath,
  });
}

function samePresentPreflight(left, right) {
  return (
    left.canonicalRealControlDirectory === right.canonicalRealControlDirectory
    && left.byteSize === right.byteSize
    && left.linkCount === right.linkCount
    && left.reparse === right.reparse
    && left.sha256 === right.sha256
    && sameIdentity(left.controlDirectoryIdentity, right.controlDirectoryIdentity)
    && sameIdentity(left.controlParentDirectoryIdentity, right.controlParentDirectoryIdentity)
    && sameIdentity(left.lifecycleLockIdentity, right.lifecycleLockIdentity)
  );
}

function createProductionManuscriptLifecycleLockOwner() {
  if (arguments.length !== 0) {
    throw new TypeError('createProductionManuscriptLifecycleLockOwner accepts no arguments');
  }
  return Object.freeze({
    createFresh(canonicalRealControlDirectory) {
      const beforeControl = inspectControlDirectory(canonicalRealControlDirectory);
      const lockPath = deriveManuscriptLifecycleLockPath(canonicalRealControlDirectory);
      try {
        fs.lstatSync(lockPath, { bigint: true });
        throw recoveryRequired('Fresh lifecycle lock target is already occupied', undefined, {
          created: false,
        });
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
      }
      let created;
      try {
        created = createAssetVerified(lockPath, Object.freeze({
          byteSize: 0,
          bytes: EMPTY_BYTES,
          parentIdentity: beforeControl.parentIdentity,
          sha256: EMPTY_SHA256,
        }));
      } catch (cause) {
        throw recoveryRequired('Fresh lifecycle lock creation was not proven durable', cause, {
          created: cause?.created === true,
        });
      }
      const afterControl = inspectControlDirectory(canonicalRealControlDirectory);
      if (
        !sameIdentity(afterControl.identity, beforeControl.identity)
        || !sameIdentity(afterControl.parentIdentity, beforeControl.parentIdentity)
        || !sameIdentity(created.parentIdentity, beforeControl.parentIdentity)
      ) {
        throw recoveryRequired('Lifecycle ControlStore identity changed during lock creation', undefined, {
          created: true,
        });
      }
      const controlDirectoryIdentity = beforeControl.identity;
      const controlParentDirectoryIdentity = beforeControl.parentIdentity;
      const lifecycleLockIdentity = snapshotIdentity(
        created.identity,
        'Created lifecycle lock identity',
      );
      const lifecyclePlatformIdentity = Object.freeze({
        canonicalRealControlDirectory,
        controlDirectoryIdentity,
        controlParentDirectoryIdentity,
        lifecycleLockIdentity,
      });
      return Object.freeze({
        version: 1,
        lifecycleLockBefore: Object.freeze({
          disposition: 'absent',
          parentIdentity: controlParentDirectoryIdentity,
        }),
        lifecycleLockAfter: Object.freeze({
          byteSize: 0,
          fileFsync: true,
          identity: lifecycleLockIdentity,
          parentFsync: true,
          parentIdentity: controlParentDirectoryIdentity,
          sha256: EMPTY_SHA256,
        }),
        lifecyclePlatformIdentity,
      });
    },
    inspectExistingPreflight(canonicalRealControlDirectory) {
      const inspected = inspectExistingLifecycleLock(canonicalRealControlDirectory);
      return Object.freeze({
        version: 1,
        disposition: 'present',
        byteSize: 0,
        canonicalRealControlDirectory,
        controlDirectoryIdentity: inspected.controlDirectoryIdentity,
        controlParentDirectoryIdentity: inspected.controlParentDirectoryIdentity,
        lifecycleLockIdentity: inspected.lifecycleLockIdentity,
        linkCount: 1,
        reparse: false,
        sha256: EMPTY_SHA256,
      });
    },
    durabilizePreexisting(preflightValue) {
      const preflight = assertManuscriptLifecycleLockPreflight(preflightValue);
      if (preflight.disposition !== 'present') {
        throw new TypeError('Only a present lifecycle preflight can be made durable');
      }
      const before = this.inspectExistingPreflight(preflight.canonicalRealControlDirectory);
      if (!samePresentPreflight(before, preflight)) {
        throw recoveryRequired('Preexisting lifecycle lock changed after reservation', undefined, {
          created: false,
        });
      }
      const lockPath = deriveManuscriptLifecycleLockPath(preflight.canonicalRealControlDirectory);
      try {
        fsyncFile(lockPath);
        fsyncDirectory(path.dirname(lockPath));
      } catch (cause) {
        throw recoveryRequired('Preexisting lifecycle lock durability is unknown', cause, {
          created: false,
        });
      }
      const after = this.inspectExistingPreflight(preflight.canonicalRealControlDirectory);
      if (!samePresentPreflight(after, preflight)) {
        throw recoveryRequired('Preexisting lifecycle lock changed while making it durable', undefined, {
          created: false,
        });
      }
      const lifecyclePlatformIdentity = Object.freeze({
        canonicalRealControlDirectory: preflight.canonicalRealControlDirectory,
        controlDirectoryIdentity: preflight.controlDirectoryIdentity,
        controlParentDirectoryIdentity: preflight.controlParentDirectoryIdentity,
        lifecycleLockIdentity: preflight.lifecycleLockIdentity,
      });
      return Object.freeze({
        version: 1,
        lifecycleLockBefore: Object.freeze({
          byteSize: 0,
          disposition: 'present',
          identity: preflight.lifecycleLockIdentity,
          parentIdentity: preflight.controlParentDirectoryIdentity,
          sha256: EMPTY_SHA256,
        }),
        lifecycleLockAfter: Object.freeze({
          byteSize: 0,
          fileFsync: true,
          identity: preflight.lifecycleLockIdentity,
          parentFsync: true,
          parentIdentity: preflight.controlParentDirectoryIdentity,
          sha256: EMPTY_SHA256,
        }),
        lifecyclePlatformIdentity,
      });
    },
    verifyExisting(receiptValue) {
      const receipt = assertManuscriptLifecycleLockReceipt(receiptValue);
      const identity = receipt.lifecyclePlatformIdentity;
      const beforeControl = inspectControlDirectory(identity.canonicalRealControlDirectory);
      if (
        !sameIdentity(beforeControl.identity, identity.controlDirectoryIdentity)
        || !sameIdentity(beforeControl.parentIdentity, identity.controlParentDirectoryIdentity)
      ) throw recoveryRequired('Lifecycle ControlStore identity differs from its durable receipt');
      const lockPath = deriveManuscriptLifecycleLockPath(identity.canonicalRealControlDirectory);
      try {
        readVerified(lockPath, Object.freeze({
          byteSize: 0,
          disposition: 'present',
          identity: identity.lifecycleLockIdentity,
          parentIdentity: identity.controlParentDirectoryIdentity,
          sha256: EMPTY_SHA256,
        }));
      } catch (cause) {
        throw recoveryRequired('Existing lifecycle lock differs from its durable receipt', cause, {
          created: false,
        });
      }
      const afterControl = inspectControlDirectory(identity.canonicalRealControlDirectory);
      if (
        !sameIdentity(afterControl.identity, identity.controlDirectoryIdentity)
        || !sameIdentity(afterControl.parentIdentity, identity.controlParentDirectoryIdentity)
      ) throw recoveryRequired('Lifecycle ControlStore identity changed during lock verification');
      return identity;
    },
  });
}

module.exports = {
  MANUSCRIPT_LIFECYCLE_LOCK_DERIVATION,
  assertManuscriptLifecycleLockPreflight,
  assertManuscriptLifecycleLockReceipt,
  createProductionManuscriptLifecycleLockOwner,
  deriveManuscriptLifecycleLockPath,
};
