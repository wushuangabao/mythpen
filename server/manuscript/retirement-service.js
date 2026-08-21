'use strict';

const { manuscriptError } = require('./contracts');

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL_ID_PATTERN = /^(0|[1-9][0-9]*)$/u;
const LIFECYCLE_IDENTITY_KEYS = Object.freeze([
  'canonicalRealControlDirectory',
  'controlDirectoryIdentity',
  'controlParentDirectoryIdentity',
  'lifecycleLockIdentity',
]);
const KNOWN_RELEASE_DISPOSITIONS = new Set([
  'UNLOCKED_AND_CLOSED',
  'CLOSED_AFTER_UNLOCK_FAILURE',
]);
const serviceRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactData(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const expected = [...keys].sort();
  if (
    actual.some((key) => typeof key !== 'string')
    || actual.map(String).sort().some((key, index) => key !== expected[index])
    || actual.length !== expected.length
  ) invalid(`${label} has an inexact key set`);
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label} must contain enumerable data properties only`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function capturePort(value, methods, label) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    invalid(`${label} must be an object`);
  }
  const result = {};
  for (const method of methods) {
    if (typeof value[method] !== 'function') invalid(`${label}.${method} must be a function`);
    result[method] = value[method].bind(value);
  }
  return Object.freeze(result);
}

function snapshotSelector(value) {
  const selector = exactData(value, ['name', 'expectedInstanceId'], 'projectSelector');
  if (typeof selector.name !== 'string' || selector.name.length === 0) {
    invalid('projectSelector.name must be a non-empty string');
  }
  if (
    typeof selector.expectedInstanceId !== 'string'
    || !UUID_V4_PATTERN.test(selector.expectedInstanceId)
  ) invalid('projectSelector.expectedInstanceId must be a canonical lowercase UUIDv4');
  return Object.freeze({
    expectedInstanceId: selector.expectedInstanceId,
    name: selector.name,
  });
}

function snapshotRequest(value, label) {
  const request = exactData(value, ['projectSelector'], label);
  return Object.freeze({
    projectSelector: snapshotSelector(request.projectSelector),
  });
}

function snapshotPhysicalIdentity(value, label) {
  const identity = exactData(value, ['dev', 'ino'], label);
  if (!Object.isFrozen(value)) invalid(`${label} must be frozen`);
  for (const key of ['dev', 'ino']) {
    if (
      typeof identity[key] !== 'string'
      || !DECIMAL_ID_PATTERN.test(identity[key])
    ) invalid(`${label}.${key} must be a canonical decimal string`);
  }
  return Object.freeze({ dev: identity.dev, ino: identity.ino });
}

function snapshotLifecycleIdentity(value) {
  const lifecycle = exactData(
    value,
    LIFECYCLE_IDENTITY_KEYS,
    'registry lifecycle platform identity',
  );
  if (!Object.isFrozen(value)) invalid('registry lifecycle platform identity must be frozen');
  if (
    typeof lifecycle.canonicalRealControlDirectory !== 'string'
    || lifecycle.canonicalRealControlDirectory.length === 0
  ) invalid('registry lifecycle platform identity path must be a non-empty string');
  return Object.freeze({
    canonicalRealControlDirectory: lifecycle.canonicalRealControlDirectory,
    controlDirectoryIdentity: snapshotPhysicalIdentity(
      lifecycle.controlDirectoryIdentity,
      'registry lifecycle control directory identity',
    ),
    controlParentDirectoryIdentity: snapshotPhysicalIdentity(
      lifecycle.controlParentDirectoryIdentity,
      'registry lifecycle control parent identity',
    ),
    lifecycleLockIdentity: snapshotPhysicalIdentity(
      lifecycle.lifecycleLockIdentity,
      'registry lifecycle lock identity',
    ),
  });
}

function snapshotIdentity(value) {
  const identity = exactData(
    value,
    ['projectUid', 'projectInstanceId', 'lifecyclePlatformIdentity'],
    'registry identity',
  );
  if (!Object.isFrozen(value)) invalid('registry identity must be frozen');
  for (const key of ['projectUid', 'projectInstanceId']) {
    if (
      typeof identity[key] !== 'string'
      || !UUID_V4_PATTERN.test(identity[key])
    ) invalid(`registry identity.${key} must be a canonical lowercase UUIDv4`);
  }
  return Object.freeze({
    lifecyclePlatformIdentity: snapshotLifecycleIdentity(identity.lifecyclePlatformIdentity),
    projectInstanceId: identity.projectInstanceId,
    projectUid: identity.projectUid,
  });
}

function validateRouteSnapshot(value, exactIdentity, expectedRoute) {
  const snapshot = exactData(
    value,
    ['projectUid', 'projectInstanceId', 'projectionGeneration', 'route'],
    'route snapshot',
  );
  if (!Object.isFrozen(value)) invalid('route snapshot must be frozen');
  if (
    snapshot.projectUid !== exactIdentity.projectUid
    || snapshot.projectInstanceId !== exactIdentity.projectInstanceId
    || snapshot.route !== expectedRoute
    || !Number.isSafeInteger(snapshot.projectionGeneration)
    || snapshot.projectionGeneration < 0
    || Object.is(snapshot.projectionGeneration, -0)
  ) {
    throw manuscriptError('MIGRATION_STATE_MISMATCH', {
      expectedRoute,
    });
  }
  return value;
}

function validateTransitionResult(value, nextRoute, expectedGeneration) {
  const result = exactData(
    value,
    ['cacheRoute', 'projectionGeneration', 'route'],
    'route transition result',
  );
  if (
    !Object.isFrozen(value)
    || result.route !== nextRoute
    || result.cacheRoute !== nextRoute
    || result.projectionGeneration !== expectedGeneration
  ) invalid('route transition result does not prove the atomic route/cache CAS');
  return value;
}

function validateExclusiveLease(value) {
  if (
    value === null
    || typeof value !== 'object'
    || value.state !== 'HELD'
    || typeof value.release !== 'function'
  ) invalid('lifecycleLeaseAdapter.acquireExclusive returned an invalid held lease');
  return value;
}

function releaseExclusive(lease) {
  const result = lease.release();
  const disposition = exactData(result, ['disposition'], 'exclusive release result').disposition;
  if (
    !Object.isFrozen(result)
    || !KNOWN_RELEASE_DISPOSITIONS.has(disposition)
    || lease.state !== 'RELEASED'
  ) invalid('exclusive lifecycle release disposition is unknown');
}

function hasUnknownReleaseDisposition(error) {
  const seen = new Set();
  let current = error;
  while (
    current !== null
    && (typeof current === 'object' || typeof current === 'function')
    && !seen.has(current)
  ) {
    seen.add(current);
    const unknown = Object.getOwnPropertyDescriptor(current, 'releaseDispositionUnknown');
    if (unknown !== undefined && Object.hasOwn(unknown, 'value') && unknown.value === true) {
      return true;
    }
    const cause = Object.getOwnPropertyDescriptor(current, 'cause');
    current = cause !== undefined && Object.hasOwn(cause, 'value') ? cause.value : null;
  }
  return false;
}

function hasKnownUnchangedRouteDisposition(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'routeDisposition');
  return descriptor !== undefined
    && Object.hasOwn(descriptor, 'value')
    && descriptor.value === 'UNCHANGED';
}

async function withIdentity(record, selector, callback) {
  let callbackCalls = 0;
  let callbackResult;
  const returned = await record.registry.withProjectIdentity(selector, async (value) => {
    callbackCalls += 1;
    if (callbackCalls !== 1) invalid('registryAdmission invoked its callback more than once');
    callbackResult = await callback(snapshotIdentity(value));
    return callbackResult;
  });
  if (callbackCalls !== 1 || returned !== callbackResult) {
    invalid('registryAdmission must return its single callback result');
  }
  return returned;
}

async function transition(record, request, expectedRoute, nextRoute, hooks = {}) {
  return withIdentity(record, request.projectSelector, async (exactIdentity) => {
    const snapshot = validateRouteSnapshot(
      await record.routes.readCurrent(exactIdentity),
      exactIdentity,
      expectedRoute,
    );
    return record.writer.withWriterTurn(exactIdentity, async (writerTurn) => {
      if (writerTurn === null || typeof writerTurn !== 'object' || !Object.isFrozen(writerTurn)) {
        invalid('writerTurns.withWriterTurn must provide a frozen authority');
      }
      await hooks.beforeExclusive?.(exactIdentity);
      let exclusiveLease;
      try {
        exclusiveLease = await record.lifecycle.acquireExclusive(
          exactIdentity.lifecyclePlatformIdentity,
        );
        hooks.onExclusive?.();
        validateExclusiveLease(exclusiveLease);
        hooks.onTransitionAttempt?.();
        const result = await record.routes.compareAndSwap(Object.freeze({
          exactIdentity,
          exclusiveLease,
          expectedRoute,
          nextRoute,
          projectionGeneration: snapshot.projectionGeneration,
          writerTurn,
        }));
        hooks.onCommitted?.();
        return validateTransitionResult(
          result,
          nextRoute,
          snapshot.projectionGeneration,
        );
      } finally {
        if (exclusiveLease !== undefined) {
          releaseExclusive(exclusiveLease);
          hooks.onReleaseKnown?.();
        }
      }
    });
  });
}

class RetirementService {
  constructor(options) {
    const values = exactData(
      options,
      ['controller', 'lifecycleLeaseAdapter', 'registryAdmission', 'routes', 'writerTurns'],
      'RetirementService options',
    );
    serviceRecords.set(this, Object.freeze({
      controller: capturePort(values.controller, [
        'beginRetiring',
        'closeForRetirement',
        'completeRetirement',
        'drain',
        'resumeAfterRetirementFailure',
      ], 'controller'),
      lifecycle: capturePort(
        values.lifecycleLeaseAdapter,
        ['acquireExclusive'],
        'lifecycleLeaseAdapter',
      ),
      registry: capturePort(
        values.registryAdmission,
        ['withProjectIdentity'],
        'registryAdmission',
      ),
      routes: capturePort(values.routes, ['compareAndSwap', 'readCurrent'], 'routes'),
      writer: capturePort(values.writerTurns, ['withWriterTurn'], 'writerTurns'),
    }));
    Object.freeze(this);
  }

  async retire(input) {
    const record = serviceRecords.get(this);
    if (!record) invalid('RetirementService receiver is invalid');
    const request = snapshotRequest(input, 'retirement request');
    const epoch = await record.controller.beginRetiring(request.projectSelector);
    let transitionCommitted = false;
    let transitionAttempted = false;
    let exclusiveAcquired = false;
    let exclusiveReleaseKnown = false;
    try {
      await record.controller.drain(epoch);
      const result = await transition(record, request, 'files', 'retired', {
        onCommitted() { transitionCommitted = true; },
        onExclusive() { exclusiveAcquired = true; },
        onReleaseKnown() { exclusiveReleaseKnown = true; },
        onTransitionAttempt() { transitionAttempted = true; },
        beforeExclusive(value) {
          return record.controller.closeForRetirement(epoch, value);
        },
      });
      record.controller.completeRetirement(epoch);
      return result;
    } catch (error) {
      const dispositionUnknown = hasUnknownReleaseDisposition(error);
      const routeKnownUnchanged = (
        !dispositionUnknown
        && !transitionCommitted
        && !exclusiveAcquired
      );
      const exclusiveKnownReleasedBeforeCas = (
        !dispositionUnknown
        &&
        !transitionCommitted
        && exclusiveAcquired
        && exclusiveReleaseKnown
        && (
          !transitionAttempted
          || hasKnownUnchangedRouteDisposition(error)
        )
      );
      if (routeKnownUnchanged || exclusiveKnownReleasedBeforeCas) {
        try {
          const recheckedIdentity = await withIdentity(
            record,
            request.projectSelector,
            async (exactIdentity) => {
              validateRouteSnapshot(
                await record.routes.readCurrent(exactIdentity),
                exactIdentity,
                'files',
              );
              return exactIdentity;
            },
          );
          await record.controller.resumeAfterRetirementFailure(epoch, recheckedIdentity);
        } catch {
          // Preserve the lifecycle/CAS failure. A controller cleanup failure is
          // already sticky in that controller and must not disguise the cause.
        }
      }
      throw error;
    }
  }

  async reactivate(input) {
    const record = serviceRecords.get(this);
    if (!record) invalid('RetirementService receiver is invalid');
    const request = snapshotRequest(input, 'reactivation request');
    return transition(record, request, 'retired', 'files');
  }
}

module.exports = { RetirementService };
