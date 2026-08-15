const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const { acquireExclusiveLease } = require('./platform/durability');

const projectWriteCoordinatorBrands = new WeakSet();
const projectWriteCoordinatorAuthorities = new WeakMap();
const PROJECT_WRITE_COORDINATOR_AUTHORITY_METHODS = Object.freeze([
  'withProjectLogicalRequestSync',
  'runPendingProjectMaintenanceSync',
  'assertProjectWriteLease',
]);
const checkpointJobInvalidErrors = new WeakSet();
const writerLeaseLostErrors = new WeakSet();

class ProjectWriteBusyError extends Error {
  constructor(projectKey, options) {
    super(`Project writer lease is busy: ${projectKey}`, options);
    this.name = 'ProjectWriteBusyError';
    this.code = 'PROJECT_WRITE_BUSY';
  }
}

class WriterLeaseLostError extends Error {
  constructor(projectKey, options) {
    super(`Project writer lease was lost: ${projectKey}`, options);
    this.name = 'WriterLeaseLostError';
    this.code = 'WRITER_LEASE_LOST';
    writerLeaseLostErrors.add(this);
  }
}

class ProjectWriteReentrancyError extends Error {
  constructor(activeProjectKey, requestedProjectKey) {
    super(
      `A project write for ${requestedProjectKey} cannot nest while ${activeProjectKey} is active`,
    );
    this.name = 'ProjectWriteReentrancyError';
    this.code = 'PROJECT_WRITE_REENTRANCY';
  }
}

class ProjectWriteAsyncCallbackError extends TypeError {
  constructor(message = 'Synchronous project write callbacks must not return a thenable') {
    super(message);
    this.name = 'ProjectWriteAsyncCallbackError';
    this.code = 'PROJECT_WRITE_ASYNC_CALLBACK';
  }
}

class ServiceShuttingDownError extends Error {
  constructor() {
    super('The service is not accepting new mutations');
    this.name = 'ServiceShuttingDownError';
    this.code = 'SERVICE_SHUTTING_DOWN';
    this.status = 503;
    this.recoverable = true;
  }
}

class ControlCheckpointBlockedError extends Error {
  constructor(message = 'No current project checkpoint job is available') {
    super(message);
    this.name = 'ControlCheckpointBlockedError';
    this.code = 'CONTROL_CHECKPOINT_BLOCKED';
  }
}

class ProjectCheckpointJobInvalidError extends TypeError {
  constructor(message = 'Project checkpoint job registration is invalid', options) {
    super(message, options);
    this.name = 'ProjectCheckpointJobInvalidError';
    this.code = 'PROJECT_CHECKPOINT_JOB_INVALID';
  }
}

class ProjectCheckpointRecoveryRequiredError extends Error {
  constructor(message = 'Pending checkpoint authority is no longer current', options) {
    super(message, options);
    this.name = 'ProjectCheckpointRecoveryRequiredError';
    this.code = 'RECOVERY_REQUIRED';
  }
}

function checkpointJobInvalid(message, ...causes) {
  const error = new ProjectCheckpointJobInvalidError(
    message,
    causes.length === 0 ? undefined : { cause: causes[0] },
  );
  checkpointJobInvalidErrors.add(error);
  return error;
}

function checkpointRecoveryRequired(message, ...causes) {
  return new ProjectCheckpointRecoveryRequiredError(
    message,
    causes.length === 0 ? undefined : { cause: causes[0] },
  );
}

function exactFrozenDataValues(value, expectedKeys, label) {
  if (typeof value !== 'object' || value === null) {
    throw checkpointJobInvalid(`${label} must be an exact frozen data object`);
  }
  if (isProxy(value)) {
    throw checkpointJobInvalid(`${label} must not be a Proxy`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) {
    throw checkpointJobInvalid(`${label} must be an exact frozen data object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw checkpointJobInvalid(`${label} has an inexact key set`);
  }
  const values = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw checkpointJobInvalid(`${label}.${key} must be an enumerable data property`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function exactFrozenZeroArgumentFunction(value, label) {
  if (typeof value !== 'function') {
    throw checkpointJobInvalid(`${label} must be a frozen zero-argument function`);
  }
  if (isProxy(value)) {
    throw checkpointJobInvalid(`${label} must not be a Proxy`);
  }
  if (Object.getPrototypeOf(value) !== Function.prototype || !Object.isFrozen(value)) {
    throw checkpointJobInvalid(`${label} must be a frozen zero-argument function`);
  }
  const keys = Reflect.ownKeys(value);
  const allowedKeys = ['length', 'name', 'arguments', 'caller', 'prototype'];
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw checkpointJobInvalid(`${label} has an inexact key set`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw checkpointJobInvalid(`${label}.${key} must be a data property`);
    }
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || lengthDescriptor.value !== 0
    || Object.getOwnPropertyDescriptor(value, 'then') !== undefined
  ) {
    throw checkpointJobInvalid(`${label} must be a non-thenable zero-argument function`);
  }
  return value;
}

function validatePendingCheckpointJob(job) {
  try {
    const jobValues = exactFrozenDataValues(
      job,
      ['snapshot', 'verifyCurrent', 'installCheckpoint'],
      'checkpoint job',
    );
    const snapshotValues = exactFrozenDataValues(
      jobValues.snapshot,
      ['incarnationId', 'tail', 'cleanBasisDigest'],
      'checkpoint job snapshot',
    );
    exactFrozenDataValues(
      snapshotValues.tail,
      ['seq', 'digest'],
      'checkpoint job snapshot tail',
    );
    return Object.freeze({
      identity: job,
      installCheckpoint: exactFrozenZeroArgumentFunction(
        jobValues.installCheckpoint,
        'checkpoint job installCheckpoint',
      ),
      snapshot: jobValues.snapshot,
      verifyCurrent: exactFrozenZeroArgumentFunction(
        jobValues.verifyCurrent,
        'checkpoint job verifyCurrent',
      ),
    });
  } catch (cause) {
    if (checkpointJobInvalidErrors.has(cause)) throw cause;
    throw checkpointJobInvalid('Checkpoint job validation failed', cause);
  }
}

function isProjectWriteCoordinator(value) {
  if (
    (typeof value !== 'object' && typeof value !== 'function')
    || value === null
    || !projectWriteCoordinatorBrands.has(value)
  ) {
    return false;
  }
  const authority = projectWriteCoordinatorAuthorities.get(value);
  if (!authority) return false;
  return PROJECT_WRITE_COORDINATOR_AUTHORITY_METHODS.every((method) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, method);
    return descriptor?.configurable === false
      && descriptor.enumerable === true
      && descriptor.value === authority[method]
      && descriptor.writable === false;
  });
}

function canonicalProjectKey(projectKey) {
  if (typeof projectKey !== 'string' || projectKey.length === 0) {
    throw new TypeError('projectKey must be a non-empty path string');
  }
  const missing = [];
  let existing = path.normalize(path.resolve(projectKey));
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const physical = path.join(fs.realpathSync.native(existing), ...missing);
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

function leaseFileName(projectKey) {
  return `${createHash('sha256').update(projectKey).digest('hex')}.lease`;
}

function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function absorbThenable(value) {
  // A synchronous API cannot await the result, but it still owns the duty to
  // observe a later rejection from the value it rejects at the boundary.
  void Promise.resolve(value).catch(() => {});
}

function attachSecondaryError(primaryError, property, secondaryError) {
  if ((typeof primaryError !== 'object' && typeof primaryError !== 'function') || primaryError === null) return;
  try {
    Object.defineProperty(primaryError, property, {
      configurable: true,
      value: secondaryError,
    });
  } catch {
    // Preserve the original thrown value when it cannot be extended.
  }
}

function createProjectWriteCoordinator({
  acquireLease = acquireExclusiveLease,
  canonicalizeProjectKey = canonicalProjectKey,
  lockRoot,
  onLeaseLost = () => {},
  recoverProject = () => {},
}) {
  if (!(typeof lockRoot === 'string' || typeof lockRoot === 'function')) {
    throw new TypeError('lockRoot must be a path string or function');
  }
  if (typeof recoverProject !== 'function') {
    throw new TypeError('recoverProject must be a function');
  }
  if (typeof onLeaseLost !== 'function') {
    throw new TypeError('onLeaseLost must be a function');
  }

  const coordinatorId = randomUUID();
  const ownership = new AsyncLocalStorage();
  const batches = new Map();
  const leaseAcquisitionCounts = new Map();
  const pendingCheckpointJobs = new Map();
  const drainWaiters = new Set();
  let admissionState = 'running';
  let activeQuiesce = null;
  let admittedAsyncItems = 0;
  let fatalDispositionError = null;
  let quiesceEpoch = 0;

  function settleDrainWaiters() {
    for (const waiter of [...drainWaiters]) {
      if (fatalDispositionError) {
        drainWaiters.delete(waiter);
        waiter.reject(fatalDispositionError);
      } else if (batches.size === 0 && admittedAsyncItems === 0) {
        drainWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  function admitAsyncItem(item) {
    admittedAsyncItems += 1;
    item.admitted = true;
    return item;
  }

  function settleAdmittedItem(item, error, value) {
    if (error) item.reject(error);
    else item.resolve(value);
    if (item.admitted) {
      item.admitted = false;
      admittedAsyncItems -= 1;
    }
    settleDrainWaiters();
  }

  function assertOuterAdmission() {
    if (admissionState !== 'running') throw new ServiceShuttingDownError();
  }

  function activeLockRoot() {
    const resolved = path.resolve(typeof lockRoot === 'function' ? lockRoot() : lockRoot);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  function createLostError(batch, cause) {
    if (writerLeaseLostErrors.has(cause)) return cause;
    return new WriterLeaseLostError(batch.canonicalKey, cause ? { cause } : undefined);
  }

  function rejectPendingAsLost(batch, cause) {
    if (batch.lostError) return batch.lostError;
    const lostError = createLostError(batch, cause);
    batch.lostError = lostError;
    if (!fatalDispositionError) fatalDispositionError = lostError;
    batches.delete(batch.canonicalKey);
    if (!batch.lossNotified) {
      batch.lossNotified = true;
      try {
        onLeaseLost(batch.canonicalKey, lostError);
      } catch (notificationError) {
        attachSecondaryError(lostError, 'leaseLossNotificationError', notificationError);
      }
    }
    for (const item of batch.queue.splice(0)) settleAdmittedItem(item, lostError);
    settleDrainWaiters();
    return lostError;
  }

  function validateLease(batch) {
    if (batch.lostError) throw batch.lostError;
    if (batches.get(batch.canonicalKey) !== batch) {
      throw rejectPendingAsLost(batch);
    }
    try {
      if (!batch.lease.isHeld()) {
        throw rejectPendingAsLost(batch);
      }
    } catch (cause) {
      if (cause === batch.lostError) throw cause;
      throw rejectPendingAsLost(batch, cause);
    }
    return true;
  }

  function contextFor(
    batch,
    reentrant,
    { logical = false, logicalRegistration = null } = {},
  ) {
    const context = {
      assertLease: () => validateLease(batch),
      canonicalProjectKey: batch.canonicalKey,
      coordinatorId,
      leasePath: batch.leasePath,
      ownershipToken: batch.ownershipToken,
      reentrant,
    };
    if (logical) {
      context.registerPendingCheckpoint = function registerPendingCheckpoint(job) {
        if (!logicalRegistration || !logicalRegistration.active || logicalRegistration.called) {
          throw checkpointJobInvalid('Pending checkpoint registration is not callback-active');
        }
        const active = ownership.getStore();
        if (
          !active
          || active.coordinatorId !== coordinatorId
          || active.batch !== batch
          || active.canonicalKey !== batch.canonicalKey
          || active.ownershipToken !== batch.ownershipToken
          || batches.get(batch.canonicalKey) !== batch
          || logicalRegistration.batch !== batch
          || logicalRegistration.canonicalKey !== batch.canonicalKey
          || logicalRegistration.ownershipToken !== batch.ownershipToken
        ) {
          throw checkpointJobInvalid('Pending checkpoint registration ownership is stale');
        }
        logicalRegistration.called = true;
        const validatedJob = validatePendingCheckpointJob(job);
        logicalRegistration.stagedJob = validatedJob;
        return undefined;
      };
    }
    return context;
  }

  function runOwned(batch, callback) {
    return ownership.run({
      batch,
      canonicalKey: batch.canonicalKey,
      coordinatorId,
      ownershipToken: batch.ownershipToken,
    }, callback);
  }

  function normalizeItemError(batch, error) {
    try {
      validateLease(batch);
      return error;
    } catch (lostError) {
      if (error !== lostError) attachSecondaryError(lostError, 'callbackError', error);
      return lostError;
    }
  }

  function runItem(
    batch,
    callback,
    { logical = false, recover = true, reentrant = false } = {},
  ) {
    validateLease(batch);
    const context = contextFor(batch, reentrant, { logical });

    function runCallback() {
      validateLease(batch);
      let result;
      try {
        result = runOwned(batch, () => callback(context));
      } catch (error) {
        throw normalizeItemError(batch, error);
      }
      if (isThenable(result)) {
        return Promise.resolve(result).then(
          (value) => {
            validateLease(batch);
            return value;
          },
          (error) => { throw normalizeItemError(batch, error); },
        );
      }
      validateLease(batch);
      return result;
    }

    if (!recover) return runCallback();
    let recovered;
    try {
      recovered = runOwned(batch, () => recoverProject(batch.canonicalKey, context));
    } catch (error) {
      throw normalizeItemError(batch, error);
    }
    if (isThenable(recovered)) {
      return Promise.resolve(recovered).then(
        () => runCallback(),
        (error) => { throw normalizeItemError(batch, error); },
      );
    }
    return runCallback();
  }

  function runItemSync(
    batch,
    callback,
    {
      logical = false,
      logicalRegistration = null,
      onCallbackComplete = null,
      recover = true,
      reentrant = false,
    } = {},
  ) {
    validateLease(batch);
    const context = contextFor(batch, reentrant, { logical, logicalRegistration });

    if (recover) {
      let recovered;
      try {
        recovered = runOwned(batch, () => recoverProject(batch.canonicalKey, context));
      } catch (error) {
        throw normalizeItemError(batch, error);
      }
      if (isThenable(recovered)) {
        absorbThenable(recovered);
        throw new ProjectWriteAsyncCallbackError(
          'withProjectWriteSync recovery must be synchronous',
        );
      }
    }

    validateLease(batch);
    let result;
    try {
      result = runOwned(batch, () => callback(context));
    } catch (error) {
      throw normalizeItemError(batch, error);
    } finally {
      if (onCallbackComplete) onCallbackComplete();
    }
    if (isThenable(result)) {
      absorbThenable(result);
      throw new ProjectWriteAsyncCallbackError(
        'withProjectWriteSync callback must be synchronous',
      );
    }
    validateLease(batch);
    return result;
  }

  function releaseBatch(batch) {
    try {
      validateLease(batch);
    } catch (lostError) {
      rejectPendingAsLost(batch, lostError);
      throw lostError;
    }
    try {
      batch.lease.release();
    } catch (cause) {
      throw rejectPendingAsLost(batch, cause);
    }
    batches.delete(batch.canonicalKey);
    settleDrainWaiters();
  }

  function finishQueuedItem(batch, item, error, value) {
    let finalError = error;
    try {
      validateLease(batch);
    } catch (lostError) {
      finalError = lostError;
    }

    if (finalError && finalError === batch.lostError) {
      settleAdmittedItem(item, finalError);
      rejectPendingAsLost(batch, finalError);
      return;
    }

    if (batch.queue.length === 0) {
      try {
        releaseBatch(batch);
      } catch (lostError) {
        settleAdmittedItem(item, lostError);
        return;
      }
      settleAdmittedItem(item, finalError, value);
      return;
    }

    settleAdmittedItem(item, finalError, value);
    drainQueue(batch);
  }

  function drainQueue(batch) {
    let item = batch.queue.shift();
    if (!item) {
      try {
        releaseBatch(batch);
      } catch {
        // No caller remains to observe a release failure here. In practice all
        // item completion paths release directly before reaching this branch.
      }
      return;
    }

    let result;
    try {
      validateLease(batch);
      result = runItem(batch, item.callback);
    } catch (error) {
      finishQueuedItem(batch, item, error);
      return;
    }
    if (isThenable(result)) {
      Promise.resolve(result).then(
        (value) => finishQueuedItem(batch, item, null, value),
        (error) => finishQueuedItem(batch, item, error),
      );
      return;
    }
    finishQueuedItem(batch, item, null, result);
  }

  function acquireBatch(canonicalKey) {
    const leasePath = path.join(activeLockRoot(), leaseFileName(canonicalKey));
    let lease;
    try {
      lease = acquireLease(leasePath);
    } catch (cause) {
      if (cause?.code === 'LEASE_BUSY') {
        throw new ProjectWriteBusyError(canonicalKey, { cause });
      }
      throw cause;
    }
    leaseAcquisitionCounts.set(
      canonicalKey,
      (leaseAcquisitionCounts.get(canonicalKey) || 0) + 1,
    );
    const batch = {
      canonicalKey,
      lease,
      leasePath,
      lostError: null,
      lossNotified: false,
      ownershipToken: Object.freeze({ id: randomUUID() }),
      queue: [],
    };
    batches.set(canonicalKey, batch);
    return batch;
  }

  function ownedBatchFor(canonicalKey) {
    const active = ownership.getStore();
    if (!active) return null;
    if (active.coordinatorId !== coordinatorId) return null;
    if (active.canonicalKey !== canonicalKey) {
      throw new ProjectWriteReentrancyError(active.canonicalKey, canonicalKey);
    }
    const batch = batches.get(canonicalKey);
    if (
      !batch
      || active.batch !== batch
      || active.ownershipToken !== batch.ownershipToken
    ) {
      throw new WriterLeaseLostError(canonicalKey);
    }
    validateLease(batch);
    return batch;
  }

  function withProjectWrite(projectKey, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!ownership.getStore()) assertOuterAdmission();
    const canonicalKey = canonicalizeProjectKey(projectKey);
    const ownedBatch = ownedBatchFor(canonicalKey);
    if (ownedBatch) {
      return runItem(ownedBatch, callback, { recover: false, reentrant: true });
    }

    pendingCheckpointJobs.delete(canonicalKey);
    const existingBatch = batches.get(canonicalKey);
    if (existingBatch) {
      return new Promise((resolve, reject) => {
        existingBatch.queue.push(admitAsyncItem({ callback, reject, resolve }));
      });
    }

    const batch = acquireBatch(canonicalKey);
    let result;
    try {
      result = runItem(batch, callback);
    } catch (error) {
      const normalized = normalizeItemError(batch, error);
      try {
        releaseBatch(batch);
      } catch (releaseError) {
        if (normalized !== releaseError) attachSecondaryError(releaseError, 'callbackError', normalized);
        throw releaseError;
      }
      throw normalized;
    }

    if (!isThenable(result)) {
      releaseBatch(batch);
      return result;
    }

    return new Promise((resolve, reject) => {
      const item = admitAsyncItem({ callback, reject, resolve });
      Promise.resolve(result).then(
        (value) => finishQueuedItem(batch, item, null, value),
        (error) => finishQueuedItem(batch, item, error),
      );
    });
  }

  function withProjectWriteSync(projectKey, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!ownership.getStore()) assertOuterAdmission();
    const canonicalKey = canonicalizeProjectKey(projectKey);
    const ownedBatch = ownedBatchFor(canonicalKey);
    if (ownedBatch) {
      return runItemSync(ownedBatch, callback, { recover: false, reentrant: true });
    }
    pendingCheckpointJobs.delete(canonicalKey);
    if (batches.has(canonicalKey)) throw new ProjectWriteBusyError(canonicalKey);

    const batch = acquireBatch(canonicalKey);
    let result;
    let primaryError;
    try {
      result = runItemSync(batch, callback);
      validateLease(batch);
    } catch (error) {
      primaryError = normalizeItemError(batch, error);
    }
    try {
      releaseBatch(batch);
    } catch (releaseError) {
      if (primaryError && primaryError !== releaseError) {
        attachSecondaryError(releaseError, 'callbackError', primaryError);
      }
      throw releaseError;
    }
    if (primaryError) throw primaryError;
    return result;
  }

  function withProjectRecoveryLeaseSync(projectKey, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!ownership.getStore()) assertOuterAdmission();
    const canonicalKey = canonicalizeProjectKey(projectKey);
    const ownedBatch = ownedBatchFor(canonicalKey);
    if (ownedBatch) {
      return runItemSync(ownedBatch, callback, { recover: false, reentrant: true });
    }
    pendingCheckpointJobs.delete(canonicalKey);
    if (batches.has(canonicalKey)) throw new ProjectWriteBusyError(canonicalKey);

    const batch = acquireBatch(canonicalKey);
    let result;
    let primaryError;
    try {
      result = runItemSync(batch, callback, { recover: false });
      validateLease(batch);
    } catch (error) {
      primaryError = normalizeItemError(batch, error);
    }
    try {
      releaseBatch(batch);
    } catch (releaseError) {
      if (primaryError && primaryError !== releaseError) {
        attachSecondaryError(releaseError, 'callbackError', primaryError);
      }
      throw releaseError;
    }
    if (primaryError) throw primaryError;
    return result;
  }

  function withProjectLogicalRequestSync(projectKey, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!ownership.getStore()) assertOuterAdmission();
    const canonicalKey = canonicalizeProjectKey(projectKey);
    const active = ownership.getStore();
    if (active) {
      const activeCanonicalKey = active.canonicalKey;
      throw new ProjectWriteReentrancyError(activeCanonicalKey, canonicalKey);
    }
    pendingCheckpointJobs.delete(canonicalKey);
    if (batches.has(canonicalKey)) throw new ProjectWriteBusyError(canonicalKey);

    const batch = acquireBatch(canonicalKey);
    const logicalRegistration = {
      active: true,
      batch,
      called: false,
      canonicalKey,
      ownershipToken: batch.ownershipToken,
      stagedJob: null,
    };
    let result;
    let primaryError;
    try {
      result = runItemSync(batch, callback, {
        logical: true,
        logicalRegistration,
        onCallbackComplete() {
          logicalRegistration.active = false;
        },
        recover: false,
      });
      validateLease(batch);
    } catch (error) {
      logicalRegistration.active = false;
      primaryError = normalizeItemError(batch, error);
    }
    try {
      releaseBatch(batch);
    } catch (releaseError) {
      if (primaryError && primaryError !== releaseError) {
        attachSecondaryError(releaseError, 'callbackError', primaryError);
      }
      throw releaseError;
    }
    if (primaryError) throw primaryError;
    if (logicalRegistration.stagedJob !== null) {
      pendingCheckpointJobs.set(canonicalKey, logicalRegistration.stagedJob);
    }
    return result;
  }

  function removePendingCheckpointIfCurrent(canonicalKey, capturedJob) {
    if (pendingCheckpointJobs.get(canonicalKey) !== capturedJob) return false;
    pendingCheckpointJobs.delete(canonicalKey);
    return true;
  }

  function executePendingCheckpoint(canonicalKey, capturedJob) {
    let verified;
    try {
      verified = capturedJob.verifyCurrent();
    } catch (cause) {
      removePendingCheckpointIfCurrent(canonicalKey, capturedJob);
      throw checkpointRecoveryRequired('Pending checkpoint verification failed', cause);
    }

    let verifyThenable;
    try {
      verifyThenable = isThenable(verified);
    } catch (cause) {
      removePendingCheckpointIfCurrent(canonicalKey, capturedJob);
      throw checkpointRecoveryRequired('Pending checkpoint verification failed', cause);
    }
    if (verifyThenable) {
      absorbThenable(verified);
      removePendingCheckpointIfCurrent(canonicalKey, capturedJob);
      throw new ProjectWriteAsyncCallbackError(
        'Pending checkpoint verification must be synchronous',
      );
    }
    if (verified !== true) {
      removePendingCheckpointIfCurrent(canonicalKey, capturedJob);
      throw checkpointRecoveryRequired('Pending checkpoint verification rejected current state');
    }
    if (pendingCheckpointJobs.get(canonicalKey) !== capturedJob) {
      throw checkpointRecoveryRequired('Pending checkpoint identity changed during verification');
    }

    pendingCheckpointJobs.delete(canonicalKey);
    const receipt = capturedJob.installCheckpoint();
    if (isThenable(receipt)) {
      absorbThenable(receipt);
      throw new ProjectWriteAsyncCallbackError(
        'Pending checkpoint installer must be synchronous',
      );
    }
    return receipt;
  }

  function runPendingProjectMaintenanceSync(projectKey) {
    const active = ownership.getStore();
    if (active) {
      throw new ProjectWriteReentrancyError(active.canonicalKey, projectKey);
    }
    assertOuterAdmission();
    const canonicalKey = canonicalizeProjectKey(projectKey);
    if (!pendingCheckpointJobs.has(canonicalKey)) {
      throw new ControlCheckpointBlockedError();
    }
    if (batches.has(canonicalKey)) throw new ProjectWriteBusyError(canonicalKey);

    const batch = acquireBatch(canonicalKey);
    const capturedJob = pendingCheckpointJobs.get(canonicalKey);
    let result;
    let primaryError;
    try {
      if (!capturedJob) throw new ControlCheckpointBlockedError();
      result = runItemSync(
        batch,
        () => executePendingCheckpoint(canonicalKey, capturedJob),
        { recover: false },
      );
      validateLease(batch);
    } catch (error) {
      primaryError = normalizeItemError(batch, error);
      if (primaryError === batch.lostError && capturedJob) {
        removePendingCheckpointIfCurrent(canonicalKey, capturedJob);
      }
    }
    try {
      releaseBatch(batch);
    } catch (releaseError) {
      if (capturedJob) removePendingCheckpointIfCurrent(canonicalKey, capturedJob);
      if (primaryError && primaryError !== releaseError) {
        attachSecondaryError(releaseError, 'callbackError', primaryError);
      }
      throw releaseError;
    }
    if (primaryError) throw primaryError;
    return result;
  }

  function assertProjectWriteLease(projectKey) {
    const active = ownership.getStore();
    if (!active || active.coordinatorId !== coordinatorId) {
      throw new WriterLeaseLostError(
        projectKey === undefined ? 'unknown project' : canonicalizeProjectKey(projectKey),
      );
    }
    const canonicalKey = projectKey === undefined
      ? active.canonicalKey
      : canonicalizeProjectKey(projectKey);
    const batch = ownedBatchFor(canonicalKey);
    validateLease(batch);
    return true;
  }

  function leaseAcquisitionCount(projectKey) {
    return leaseAcquisitionCounts.get(canonicalizeProjectKey(projectKey)) || 0;
  }

  function beginQuiesce() {
    if (admissionState !== 'running') throw new ServiceShuttingDownError();
    admissionState = 'quiescing';
    activeQuiesce = Object.freeze({ epoch: ++quiesceEpoch });
    return activeQuiesce;
  }

  function drain(quiesce) {
    if (!activeQuiesce || quiesce !== activeQuiesce) {
      return Promise.reject(new ServiceShuttingDownError());
    }
    if (fatalDispositionError) return Promise.reject(fatalDispositionError);
    if (batches.size === 0 && admittedAsyncItems === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      drainWaiters.add({ reject, resolve });
    });
  }

  function cancelQuiesce(quiesce) {
    if (!activeQuiesce || quiesce !== activeQuiesce || admissionState !== 'quiescing') {
      throw new ServiceShuttingDownError();
    }
    if (fatalDispositionError) throw fatalDispositionError;
    activeQuiesce = null;
    admissionState = 'running';
  }

  const coordinator = {
    get admissionState() {
      return admissionState;
    },
    assertProjectWriteLease,
    beginQuiesce,
    cancelQuiesce,
    drain,
    leaseAcquisitionCount,
    runPendingProjectMaintenanceSync,
    withProjectLogicalRequestSync,
    withProjectWrite,
    withProjectRecoveryLeaseSync,
    withProjectWriteSync,
  };
  const authority = {};
  for (const method of PROJECT_WRITE_COORDINATOR_AUTHORITY_METHODS) {
    authority[method] = coordinator[method];
    Object.defineProperty(coordinator, method, {
      configurable: false,
      enumerable: true,
      value: coordinator[method],
      writable: false,
    });
  }
  projectWriteCoordinatorAuthorities.set(coordinator, Object.freeze(authority));
  projectWriteCoordinatorBrands.add(coordinator);
  return coordinator;
}

module.exports = {
  ProjectWriteAsyncCallbackError,
  ProjectWriteBusyError,
  ProjectWriteReentrancyError,
  ServiceShuttingDownError,
  WriterLeaseLostError,
  canonicalProjectKey,
  createProjectWriteCoordinator,
};

Object.defineProperty(module.exports, 'isProjectWriteCoordinator', {
  value: isProjectWriteCoordinator,
  enumerable: false,
  writable: false,
  configurable: false,
});
