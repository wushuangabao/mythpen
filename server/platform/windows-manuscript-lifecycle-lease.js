'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const { manuscriptError } = require('../manuscript/contracts');
const { acquireExistingFileRangeLease, inspectPath } = require('./durability');

const PLATFORM_IDENTITY_KEYS = Object.freeze([
  'canonicalRealControlDirectory',
  'controlDirectoryIdentity',
  'controlParentDirectoryIdentity',
  'lifecycleLockIdentity',
]);
const PHYSICAL_IDENTITY_KEYS = Object.freeze(['dev', 'ino']);
const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9]\d*)$/;
const adapterLeaseRecords = new WeakMap();

class ProjectWriteBusyError extends Error {
  constructor(options) {
    super('Project manuscript lifecycle lease is busy', options);
    this.name = 'ProjectWriteBusyError';
    this.code = 'PROJECT_WRITE_BUSY';
  }
}

function defineImmutable(object, name, value) {
  Object.defineProperty(object, name, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}

function unavailable(cause, options = {}) {
  const dispositionUnknown = (
    options.releaseDispositionUnknown === true
    || cause?.releaseDispositionUnknown === true
  );
  const error = manuscriptError(
    'MANUSCRIPT_LIFECYCLE_UNAVAILABLE',
    dispositionUnknown ? { releaseDispositionUnknown: true } : {},
    cause,
  );
  if (dispositionUnknown) defineImmutable(error, 'releaseDispositionUnknown', true);

  let secondaryName = options.secondaryName;
  let secondaryError = options.secondaryError;
  if (secondaryError === undefined && cause !== null && typeof cause === 'object') {
    for (const name of ['acquireError', 'admissionError', 'unlockError']) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, name);
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
        secondaryName = name;
        secondaryError = descriptor.value;
        break;
      }
    }
  }
  if (secondaryError !== undefined) {
    defineImmutable(error, secondaryName, secondaryError);
    defineImmutable(error, 'secondaryErrors', Object.freeze([secondaryError]));
  }
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFrozenDataValues(value, expectedKeys) {
  if (!isPlainObject(value) || !Object.isFrozen(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    return undefined;
  }
  const values = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      return undefined;
    }
    values[key] = descriptor.value;
  }
  return values;
}

function requirePhysicalIdentity(value) {
  const values = exactFrozenDataValues(value, PHYSICAL_IDENTITY_KEYS);
  if (
    values === undefined
    || typeof values.dev !== 'string'
    || !CANONICAL_DECIMAL_PATTERN.test(values.dev)
    || typeof values.ino !== 'string'
    || !CANONICAL_DECIMAL_PATTERN.test(values.ino)
  ) {
    throw new TypeError('Physical identity must be an exact frozen canonical dev/ino object');
  }
  return value;
}

function requirePlatformIdentity(value) {
  const values = exactFrozenDataValues(value, PLATFORM_IDENTITY_KEYS);
  if (values === undefined) {
    throw new TypeError('Lifecycle platform identity must be one exact frozen four-key object');
  }
  const canonical = values.canonicalRealControlDirectory;
  if (
    typeof canonical !== 'string'
    || canonical.length === 0
    || canonical.includes('\0')
    || !path.isAbsolute(canonical)
    || path.resolve(canonical) !== canonical
    || path.normalize(canonical) !== canonical
  ) {
    throw new TypeError('Control directory must be one absolute normalized canonical-real path');
  }
  let actualRealPath;
  try {
    actualRealPath = fs.realpathSync.native(canonical);
  } catch (cause) {
    throw new TypeError('Control directory canonical-real path is unavailable', { cause });
  }
  if (actualRealPath !== canonical) {
    throw new TypeError('Control directory path is not its exact canonical real path');
  }
  requirePhysicalIdentity(values.controlDirectoryIdentity);
  requirePhysicalIdentity(values.controlParentDirectoryIdentity);
  requirePhysicalIdentity(values.lifecycleLockIdentity);
  return value;
}

function samePhysicalIdentity(stats, expected) {
  return String(stats.dev) === expected.dev && String(stats.ino) === expected.ino;
}

function requirePlainEmptyLock(targetPath, expectedIdentity) {
  let stats;
  let realPath;
  try {
    stats = fs.lstatSync(targetPath, { bigint: true });
    realPath = fs.realpathSync.native(targetPath);
  } catch (cause) {
    throw new TypeError('Lifecycle lock file is unavailable', { cause });
  }
  if (
    stats.isFile() !== true
    || stats.isSymbolicLink() !== false
    || stats.size !== 0n
    || stats.nlink !== 1n
    || !samePhysicalIdentity(stats, expectedIdentity)
    || realPath !== targetPath
  ) {
    throw new TypeError('Lifecycle lock is not the expected canonical plain empty single-link file');
  }
}

function deriveLifecycleLockPath(canonicalRealControlDirectory) {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(canonicalRealControlDirectory, 'utf8'))
    .digest('hex');
  return path.join(
    path.dirname(canonicalRealControlDirectory),
    `.manuscript-${digest}.lifecycle.lock`,
  );
}

function verifyPlatformFacts(identity, lockPath) {
  const controlDirectory = identity.canonicalRealControlDirectory;
  const controlParent = path.dirname(controlDirectory);
  const observation = inspectPath(controlDirectory);
  if (
    observation === null
    || typeof observation !== 'object'
    || observation.actualName !== path.basename(controlDirectory)
    || observation.kind !== 'directory'
    || observation.linkCount !== null
    || observation.reparse !== false
    || observation.realPath !== controlDirectory
    || observation.parentRealPath !== controlParent
    || observation.identity?.dev !== identity.controlDirectoryIdentity.dev
    || observation.identity?.ino !== identity.controlDirectoryIdentity.ino
    || observation.parentIdentity?.dev !== identity.controlParentDirectoryIdentity.dev
    || observation.parentIdentity?.ino !== identity.controlParentDirectoryIdentity.ino
  ) {
    throw new TypeError('Pinned ControlStore directory or parent facts changed');
  }
  requirePlainEmptyLock(lockPath, identity.lifecycleLockIdentity);
}

function knownReleaseResult(result) {
  return (
    result !== null
    && typeof result === 'object'
    && Object.isFrozen(result)
    && Reflect.ownKeys(result).length === 1
    && Object.hasOwn(result, 'disposition')
    && (
      result.disposition === 'UNLOCKED_AND_CLOSED'
      || result.disposition === 'CLOSED_AFTER_UNLOCK_FAILURE'
    )
  );
}

function mintAdapterLease(primitiveLease) {
  const lease = {};
  const record = { primitiveLease, state: 'HELD' };
  Object.defineProperties(lease, {
    state: {
      enumerable: true,
      get() {
        const active = adapterLeaseRecords.get(this);
        if (active === undefined) throw unavailable(new TypeError('Lifecycle lease authority is invalid'));
        return active.state;
      },
    },
    release: {
      enumerable: true,
      value() {
        const active = adapterLeaseRecords.get(this);
        if (active === undefined) throw unavailable(new TypeError('Lifecycle lease authority is invalid'));
        if (active.state !== 'HELD') {
          throw unavailable(
            new TypeError('Lifecycle lease is no longer held'),
            { releaseDispositionUnknown: active.state === 'RELEASE_DISPOSITION_UNKNOWN' },
          );
        }
        let result;
        try {
          result = active.primitiveLease.release();
        } catch (cause) {
          active.state = 'RELEASE_DISPOSITION_UNKNOWN';
          throw unavailable(cause, { releaseDispositionUnknown: true });
        }
        if (!knownReleaseResult(result) || active.primitiveLease.state !== 'RELEASED') {
          active.state = 'RELEASE_DISPOSITION_UNKNOWN';
          throw unavailable(
            new TypeError('Lifecycle lease returned an invalid release disposition'),
            { releaseDispositionUnknown: true },
          );
        }
        active.state = 'RELEASED';
        return result;
      },
    },
  });
  adapterLeaseRecords.set(lease, record);
  return Object.freeze(lease);
}

function acquire(identityInput, exclusive) {
  let identity;
  let primitiveLease;
  try {
    identity = requirePlatformIdentity(identityInput);
    const lockPath = deriveLifecycleLockPath(identity.canonicalRealControlDirectory);
    verifyPlatformFacts(identity, lockPath);
    primitiveLease = acquireExistingFileRangeLease(lockPath, {
      expectedIdentity: identity.lifecycleLockIdentity,
      exclusive,
    });
    verifyPlatformFacts(identity, lockPath);
    return mintAdapterLease(primitiveLease);
  } catch (cause) {
    if (primitiveLease?.state === 'HELD') {
      try {
        primitiveLease.release();
      } catch (cleanupError) {
        throw unavailable(cleanupError, {
          releaseDispositionUnknown: true,
          secondaryError: cause,
          secondaryName: 'admissionError',
        });
      }
    }
    if (cause?.releaseDispositionUnknown === true) throw unavailable(cause);
    if (cause?.code === 'LEASE_BUSY') throw new ProjectWriteBusyError({ cause });
    if (cause?.code === 'PROJECT_WRITE_BUSY') throw cause;
    if (cause?.code === 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE') throw cause;
    throw unavailable(cause);
  }
}

function createWindowsManuscriptLifecycleLeaseAdapter() {
  if (arguments.length !== 0) {
    throw new TypeError('createWindowsManuscriptLifecycleLeaseAdapter accepts no arguments');
  }
  return Object.freeze({
    acquireShared(identity) {
      return acquire(identity, false);
    },
    acquireExclusive(identity) {
      return acquire(identity, true);
    },
  });
}

module.exports = { createWindowsManuscriptLifecycleLeaseAdapter };
