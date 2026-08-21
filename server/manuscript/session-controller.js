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

const controllerRecords = new WeakMap();
const sessionRecords = new WeakMap();
const retirementEpochRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataObject(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.length !== expectedKeys.length
    || actualKeys.map(String).sort().some((key, index) => key !== expectedKeys[index])
  ) {
    invalid(`${label} has an inexact key set`);
  }
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

function assertDeepFrozenPlainData(value, label, active = new WeakSet()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))
  ) {
    return;
  }
  if (
    value === null
    || typeof value !== 'object'
    || !Object.isFrozen(value)
    || active.has(value)
  ) {
    invalid(`${label} must be deeply frozen finite plain data`);
  }
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')
        ) {
          invalid(`${label} must contain dense enumerable data`);
        }
        assertDeepFrozenPlainData(descriptor.value, `${label}[${index}]`, active);
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string'
          || !/^(0|[1-9][0-9]*)$/u.test(key)
          || Number(key) >= value.length
        ) {
          invalid(`${label} has an invalid array property`);
        }
      }
      return;
    }
    if (!isPlainObject(value)) invalid(`${label} must contain plain data`);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string'
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) {
        invalid(`${label} must contain enumerable data properties only`);
      }
      assertDeepFrozenPlainData(descriptor.value, `${label}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function requiredMethod(receiver, methodName, label) {
  if (
    receiver === null
    || (typeof receiver !== 'object' && typeof receiver !== 'function')
  ) {
    invalid(`${label} must be an object`);
  }
  const method = receiver[methodName];
  if (typeof method !== 'function') invalid(`${label}.${methodName} must be a function`);
  return Object.freeze({ method, receiver });
}

function snapshotSelector(value) {
  const selector = exactDataObject(value, ['name', 'expectedInstanceId'], 'projectSelector');
  if (typeof selector.name !== 'string' || selector.name.length === 0) {
    invalid('projectSelector.name must be a non-empty registered project name');
  }
  if (
    typeof selector.expectedInstanceId !== 'string'
    || !UUID_V4_PATTERN.test(selector.expectedInstanceId)
  ) {
    invalid('projectSelector.expectedInstanceId must be a canonical lowercase UUIDv4');
  }
  return Object.freeze({
    expectedInstanceId: selector.expectedInstanceId,
    name: selector.name,
  });
}

function exactPhysicalIdentity(value, label) {
  const identity = exactDataObject(value, ['dev', 'ino'], label);
  if (!Object.isFrozen(value)) invalid(`${label} must be frozen`);
  for (const field of ['dev', 'ino']) {
    if (typeof identity[field] !== 'string' || !DECIMAL_ID_PATTERN.test(identity[field])) {
      invalid(`${label}.${field} must be a canonical decimal string`);
    }
  }
  return value;
}

function validateRegistryIdentity(value) {
  assertDeepFrozenPlainData(value, 'exactFrozenIdentity');
  if (!isPlainObject(value)) invalid('exactFrozenIdentity must be a plain object');
  const projectUidDescriptor = Object.getOwnPropertyDescriptor(value, 'projectUid');
  const projectInstanceIdDescriptor = Object.getOwnPropertyDescriptor(value, 'projectInstanceId');
  for (const [descriptor, label] of [
    [projectUidDescriptor, 'projectUid'],
    [projectInstanceIdDescriptor, 'projectInstanceId'],
  ]) {
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
      || !UUID_V4_PATTERN.test(descriptor.value)
    ) {
      invalid(`exactFrozenIdentity.${label} must be a canonical lowercase UUIDv4 data property`);
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'lifecyclePlatformIdentity');
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || !Object.hasOwn(descriptor, 'value')
  ) {
    invalid('exactFrozenIdentity must contain lifecyclePlatformIdentity as data');
  }
  const lifecycle = exactDataObject(
    descriptor.value,
    LIFECYCLE_IDENTITY_KEYS,
    'lifecyclePlatformIdentity',
  );
  if (!Object.isFrozen(descriptor.value)) invalid('lifecyclePlatformIdentity must be frozen');
  if (
    typeof lifecycle.canonicalRealControlDirectory !== 'string'
    || lifecycle.canonicalRealControlDirectory.length === 0
  ) {
    invalid('lifecyclePlatformIdentity canonical directory must be a non-empty string');
  }
  exactPhysicalIdentity(
    lifecycle.controlDirectoryIdentity,
    'lifecyclePlatformIdentity.controlDirectoryIdentity',
  );
  exactPhysicalIdentity(
    lifecycle.controlParentDirectoryIdentity,
    'lifecyclePlatformIdentity.controlParentDirectoryIdentity',
  );
  exactPhysicalIdentity(
    lifecycle.lifecycleLockIdentity,
    'lifecyclePlatformIdentity.lifecycleLockIdentity',
  );
  return Object.freeze({
    exactIdentity: value,
    lifecycleIdentity: descriptor.value,
    projectInstanceId: projectInstanceIdDescriptor.value,
    projectUid: projectUidDescriptor.value,
  });
}

function lifecycleKey(lifecycleIdentity) {
  const { dev, ino } = lifecycleIdentity.controlDirectoryIdentity;
  return `${dev}:${ino}`;
}

function projectKey(identity) {
  return `${identity.projectUid}:${identity.projectInstanceId}`;
}

function samePhysicalIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLifecycleBinding(left, right) {
  return (
    left.canonicalRealControlDirectory === right.canonicalRealControlDirectory
    && samePhysicalIdentity(left.controlDirectoryIdentity, right.controlDirectoryIdentity)
    && samePhysicalIdentity(left.controlParentDirectoryIdentity, right.controlParentDirectoryIdentity)
    && samePhysicalIdentity(left.lifecycleLockIdentity, right.lifecycleLockIdentity)
  );
}

function lifecycleUnavailable(_message, cause) {
  return manuscriptError('MANUSCRIPT_LIFECYCLE_UNAVAILABLE', {}, cause);
}

function retirementUnavailable() {
  return lifecycleUnavailable('Project manuscript sessions are retiring');
}

function controllerRecord(controller) {
  const record = controllerRecords.get(controller);
  if (!record) invalid('ManuscriptSessionController receiver is invalid');
  return record;
}

function assertControllerUsable(record) {
  if (record.fencedError) throw record.fencedError;
}

function sameProjectIdentity(left, right) {
  return (
    left.projectUid === right.projectUid
    && left.projectInstanceId === right.projectInstanceId
    && sameLifecycleBinding(left.lifecycleIdentity, right.lifecycleIdentity)
  );
}

function ensureProjectState(record, identity) {
  const key = projectKey(identity);
  const existing = record.projects.get(key);
  if (existing) {
    if (!sameProjectIdentity(existing.identity, identity)) {
      throw lifecycleUnavailable('Project lifecycle identity changed within this controller');
    }
    return existing;
  }
  const state = {
    drainPromise: null,
    drainResolve: null,
    identity,
    inFlight: 0,
    key,
    pendingOpens: 0,
    retirement: null,
    sessions: new Set(),
  };
  record.projects.set(key, state);
  return state;
}

function assertProjectAccepting(project) {
  if (project.retirement !== null) throw retirementUnavailable();
}

function resolveProjectDrain(project) {
  if (
    project.inFlight !== 0
    || project.pendingOpens !== 0
    || project.drainResolve === null
  ) return;
  const resolve = project.drainResolve;
  project.drainPromise = null;
  project.drainResolve = null;
  resolve();
}

function finishPendingOpen(record, project) {
  project.pendingOpens -= 1;
  if (project.pendingOpens < 0) {
    const error = lifecycleUnavailable('Project pending-open accounting underflow');
    fenceController(record, null, error);
    throw error;
  }
  resolveProjectDrain(project);
}

function retirementEpochRecord(record, epoch, phases) {
  const epochRecord = (
    epoch !== null
    && typeof epoch === 'object'
    && retirementEpochRecords.get(epoch)
  );
  if (
    !epochRecord
    || epochRecord.controller !== record
    || epochRecord.project === null
    || epochRecord.project.retirement !== epochRecord
    || !phases.includes(epochRecord.phase)
  ) invalid('retirementEpoch must be an active opaque authority minted by this controller');
  return epochRecord;
}

function ownedRetirementEpochRecord(record, epoch) {
  const epochRecord = (
    epoch !== null
    && typeof epoch === 'object'
    && retirementEpochRecords.get(epoch)
  );
  if (!epochRecord || epochRecord.controller !== record) {
    invalid('retirementEpoch must be an opaque authority minted by this controller');
  }
  return epochRecord;
}

function fenceController(record, entry, cause) {
  if (!record.fencedError) {
    record.fencedError = lifecycleUnavailable(
      'Manuscript lifecycle release disposition is unknown; controller is fenced',
      cause,
    );
  }
  if (entry) entry.state = 'fenced';
  return record.fencedError;
}

function validateAcquiredLease(lease) {
  if (
    lease === null
    || typeof lease !== 'object'
    || lease.state !== 'HELD'
    || typeof lease.release !== 'function'
  ) {
    invalid('lifecycleLeaseAdapter.acquireShared returned an invalid held lease');
  }
  return lease;
}

function hasOwnUnknownReleaseDisposition(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'releaseDispositionUnknown');
  } catch {
    return false;
  }
  return descriptor !== undefined
    && Object.hasOwn(descriptor, 'value')
    && descriptor.value === true;
}

function installPendingEntry(record, key, lifecycleIdentity) {
  const entry = {
    acquirePromise: null,
    freshnessOwner: null,
    freshnessOwnerIdentity: null,
    key,
    lease: null,
    lifecycleIdentity,
    releasePromise: null,
    reservations: 1,
    sessionRefs: 0,
    startPromise: null,
    state: 'pending',
  };
  record.entries.set(key, entry);
  entry.acquirePromise = Promise.resolve()
    .then(() => Reflect.apply(
      record.acquireShared.method,
      record.acquireShared.receiver,
      [lifecycleIdentity],
    ))
    .then(
      (lease) => {
        try {
          entry.lease = validateAcquiredLease(lease);
        } catch (cause) {
          const error = lifecycleUnavailable('Shared manuscript lifecycle lease is invalid', cause);
          fenceController(record, entry, cause);
          throw error;
        }
        entry.state = 'held';
        return entry.lease;
      },
      (error) => {
        if (hasOwnUnknownReleaseDisposition(error)) {
          fenceController(record, entry, error);
          throw error;
        }
        entry.state = 'failed';
        if (record.entries.get(key) === entry) record.entries.delete(key);
        throw error;
      },
    );
  return entry;
}

function reserveEntry(record, lifecycleIdentity) {
  const key = lifecycleKey(lifecycleIdentity);
  const existing = record.entries.get(key);
  if (!existing) {
    return Object.freeze({ entry: installPendingEntry(record, key, lifecycleIdentity) });
  }
  if (!sameLifecycleBinding(existing.lifecycleIdentity, lifecycleIdentity)) {
    throw lifecycleUnavailable(
      'Conflicting lifecycle identity binding for the same physical control directory',
    );
  }
  if (existing.state === 'releasing') {
    return Object.freeze({ waitForRelease: existing.releasePromise });
  }
  if (existing.state === 'fenced') throw record.fencedError;
  if (existing.state !== 'pending' && existing.state !== 'held') {
    invalid(`Shared lifecycle entry cannot be reserved from state ${existing.state}`);
  }
  existing.reservations += 1;
  return Object.freeze({ entry: existing });
}

async function reserveAfterAnyRelease(record, lifecycleIdentity) {
  for (;;) {
    assertControllerUsable(record);
    const reservation = reserveEntry(record, lifecycleIdentity);
    if (reservation.entry) return reservation.entry;
    try {
      await reservation.waitForRelease;
    } catch {
      assertControllerUsable(record);
      throw lifecycleUnavailable('Shared manuscript lifecycle release failed');
    }
  }
}

function validateKnownRelease(entry, result) {
  const disposition = exactDataObject(result, ['disposition'], 'lease release result').disposition;
  if (
    !Object.isFrozen(result)
    || !KNOWN_RELEASE_DISPOSITIONS.has(disposition)
    || entry.lease.state !== 'RELEASED'
  ) {
    invalid('lease release result has an unknown disposition');
  }
  return result;
}

function validateFreshnessClosed(result) {
  const disposition = exactDataObject(
    result,
    ['disposition'],
    'freshness close result',
  ).disposition;
  if (!Object.isFrozen(result) || disposition !== 'CLOSED') {
    invalid('freshness close result has an unknown disposition');
  }
  return result;
}

function decrementSessionRef(record, entry, sessionRecord) {
  entry.sessionRefs -= 1;
  if (entry.sessionRefs < 0) {
    const error = lifecycleUnavailable('Shared lifecycle session accounting underflow');
    fenceController(record, entry, error);
    throw error;
  }
  if (sessionRecord) {
    sessionRecord.state = 'closed';
    sessionRecord.project.sessions.delete(sessionRecord);
  }
}

function startEntryCleanup(record, entry, finalSessionRecord = null) {
  entry.state = 'releasing';
  entry.releasePromise = (async () => {
    if (entry.freshnessOwner !== null) {
      let closed;
      try {
        closed = await Reflect.apply(
          record.closeFreshness.method,
          record.closeFreshness.receiver,
          [entry.freshnessOwner],
        );
        validateFreshnessClosed(closed);
      } catch (error) {
        fenceController(record, entry, error);
        throw error;
      }
    }
    let result;
    try {
      result = await Reflect.apply(entry.lease.release, entry.lease, []);
    } catch (error) {
      fenceController(record, entry, error);
      throw error;
    }
    try {
      validateKnownRelease(entry, result);
    } catch (cause) {
      const error = lifecycleUnavailable('Shared manuscript lifecycle release was not proven', cause);
      fenceController(record, entry, cause);
      throw error;
    }
    if (finalSessionRecord !== null) {
      decrementSessionRef(record, entry, finalSessionRecord);
    }
    entry.state = 'released';
    if (record.entries.get(entry.key) === entry) record.entries.delete(entry.key);
    return result;
  })();
  return entry.releasePromise;
}

// This is the sole zero-ref transition. It always closes the freshness owner
// before releasing the bottom shared lifecycle lease.
function cleanupUnusedEntry(record, entry, finalSessionRecord = null) {
  const finalClose = finalSessionRecord !== null;
  if (
    entry.reservations !== 0
    || entry.sessionRefs !== (finalClose ? 1 : 0)
  ) return Promise.resolve(null);
  if (entry.state === 'releasing') return entry.releasePromise;
  if (entry.state === 'fenced') return Promise.reject(record.fencedError);
  if (entry.state !== 'held') {
    return Promise.reject(lifecycleUnavailable(
      `Cannot release shared lifecycle entry from state ${entry.state}`,
    ));
  }
  return startEntryCleanup(record, entry, finalSessionRecord);
}

async function rollbackReservation(record, entry) {
  entry.reservations -= 1;
  if (entry.reservations < 0) {
    const error = lifecycleUnavailable('Shared lifecycle reservation accounting underflow');
    fenceController(record, entry, error);
    throw error;
  }
  await cleanupUnusedEntry(record, entry);
}

function mintSession(record, entry, project) {
  entry.reservations -= 1;
  entry.sessionRefs += 1;
  const session = Object.freeze({});
  const sessionRecord = {
    closePromise: null,
    controller: record,
    entry,
    project,
    state: 'open',
  };
  sessionRecords.set(session, sessionRecord);
  project.sessions.add(sessionRecord);
  return session;
}

function openSessionRecord(record, session) {
  const sessionRecord = (
    session !== null
    && typeof session === 'object'
    && sessionRecords.get(session)
  );
  if (!sessionRecord || sessionRecord.controller !== record) {
    invalid('session must be an opaque authority minted by this controller');
  }
  if (sessionRecord.state !== 'open') invalid('session is closing or closed');
  return sessionRecord;
}

async function finishSessionClose(record, sessionRecord) {
  const entry = sessionRecord.entry;
  if (entry.sessionRefs === 1 && entry.reservations === 0) {
    await cleanupUnusedEntry(record, entry, sessionRecord);
    return;
  }
  decrementSessionRef(record, entry, sessionRecord);
  await cleanupUnusedEntry(record, entry);
}

async function rollbackMintedSession(record, session) {
  const sessionRecord = sessionRecords.get(session);
  if (
    !sessionRecord
    || sessionRecord.controller !== record
    || sessionRecord.state !== 'open'
  ) return;
  sessionRecord.state = 'closing';
  try {
    sessionRecord.closePromise = finishSessionClose(record, sessionRecord);
    await sessionRecord.closePromise;
  } catch {
    // The caller's registry/verifier error is authoritative. Unknown cleanup
    // disposition is retained by the controller fence instead of replacing it.
  }
}

function installFreshnessOwner(record, entry, identity) {
  if (entry.freshnessOwner !== null) return false;
  const owner = Reflect.apply(
    record.createFreshnessOwner.method,
    record.createFreshnessOwner.receiver,
    [identity.exactIdentity],
  );
  if (owner === null || typeof owner !== 'object' || !Object.isFrozen(owner)) {
    invalid('freshnessLifecycle.createOwner must return a frozen opaque owner');
  }
  entry.freshnessOwner = owner;
  entry.freshnessOwnerIdentity = identity.exactIdentity;
  entry.startPromise = null;
  return true;
}

function ensureFreshnessStarted(record, entry) {
  if (entry.freshnessOwner === null || entry.freshnessOwnerIdentity === null) {
    invalid('freshness owner was not installed under registry admission');
  }
  if (entry.startPromise === null) {
    let started;
    try {
      // Calling the async start method here executes its synchronous admission
      // prefix immediately, after registry/config has exited.
      started = Reflect.apply(
        record.startFreshness.method,
        record.startFreshness.receiver,
        [entry.freshnessOwner, entry.freshnessOwnerIdentity],
      );
    } catch (error) {
      started = Promise.reject(error);
    }
    entry.startPromise = Promise.resolve(started);
  }
  return entry.startPromise;
}

class ManuscriptSessionController {
  constructor(options) {
    const values = exactDataObject(
      options,
      [
        'freshnessLifecycle',
        'lifecycleLeaseAdapter',
        'registryAdmission',
        'routeAdmissionVerifier',
      ],
      'ManuscriptSessionController options',
    );
    const record = {
      acquireShared: requiredMethod(
        values.lifecycleLeaseAdapter,
        'acquireShared',
        'lifecycleLeaseAdapter',
      ),
      assertSameBinding: requiredMethod(
        values.freshnessLifecycle,
        'assertSameBinding',
        'freshnessLifecycle',
      ),
      closeFreshness: requiredMethod(
        values.freshnessLifecycle,
        'close',
        'freshnessLifecycle',
      ),
      createFreshnessOwner: requiredMethod(
        values.freshnessLifecycle,
        'createOwner',
        'freshnessLifecycle',
      ),
      entries: new Map(),
      fencedError: null,
      freshnessAdmit: requiredMethod(
        values.freshnessLifecycle,
        'admit',
        'freshnessLifecycle',
      ),
      startFreshness: requiredMethod(
        values.freshnessLifecycle,
        'start',
        'freshnessLifecycle',
      ),
      projects: new Map(),
      verifyAfterLease: requiredMethod(
        values.routeAdmissionVerifier,
        'verifyAfterLease',
        'routeAdmissionVerifier',
      ),
      withProjectIdentity: requiredMethod(
        values.registryAdmission,
        'withProjectIdentity',
        'registryAdmission',
      ),
    };
    controllerRecords.set(this, record);
    Object.freeze(this);
  }

  async openSession(projectSelector) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const selector = snapshotSelector(projectSelector);
    let callbackCalls = 0;
    let reservationTicket = null;
    let mintedSession = null;
    let pendingOpen = false;
    let pendingProject = null;
    try {
      const returned = await Reflect.apply(
        record.withProjectIdentity.method,
        record.withProjectIdentity.receiver,
        [selector, async (exactFrozenIdentity) => {
          callbackCalls += 1;
          if (callbackCalls !== 1) invalid('registryAdmission invoked its callback more than once');
          assertControllerUsable(record);
          const identity = validateRegistryIdentity(exactFrozenIdentity);
          const project = ensureProjectState(record, identity);
          assertProjectAccepting(project);
          project.pendingOpens += 1;
          pendingOpen = true;
          pendingProject = project;
          const entry = await reserveAfterAnyRelease(record, identity.lifecycleIdentity);
          try {
            await entry.acquirePromise;
          } catch (error) {
            entry.reservations -= 1;
            throw error;
          }
          let ownerCreator;
          try {
            assertControllerUsable(record);
            await Reflect.apply(
              record.verifyAfterLease.method,
              record.verifyAfterLease.receiver,
              [identity.exactIdentity],
            );
            assertControllerUsable(record);
            ownerCreator = installFreshnessOwner(record, entry, identity);
          } catch (error) {
            try {
              await rollbackReservation(record, entry);
            } catch {
              // Preserve the original verifier/fence error. The cleanup helper
              // has already made any unknown disposition sticky.
            }
            throw error;
          }
          reservationTicket = Object.freeze({ entry, identity, ownerCreator, project });
          return reservationTicket;
        }],
      );
      if (callbackCalls !== 1 || returned !== reservationTicket || reservationTicket === null) {
        invalid('registryAdmission must return its single callback result');
      }
      await ensureFreshnessStarted(record, reservationTicket.entry);
      assertControllerUsable(record);
      if (!reservationTicket.ownerCreator) {
        await Reflect.apply(
          record.assertSameBinding.method,
          record.assertSameBinding.receiver,
          [reservationTicket.entry.freshnessOwner, reservationTicket.identity.exactIdentity],
        );
        assertControllerUsable(record);
      }
      mintedSession = mintSession(
        record,
        reservationTicket.entry,
        reservationTicket.project,
      );
      finishPendingOpen(record, pendingProject);
      pendingOpen = false;
      return mintedSession;
    } catch (error) {
      if (mintedSession) {
        await rollbackMintedSession(record, mintedSession);
      } else if (reservationTicket) {
        try {
          await rollbackReservation(record, reservationTicket.entry);
        } catch {
          // The original registry/start/binding error remains authoritative;
          // cleanup uncertainty has already fenced the controller.
        }
      }
      if (pendingOpen) {
        finishPendingOpen(record, pendingProject);
        pendingOpen = false;
      }
      throw error;
    }
  }

  async admit(session, operation) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const sessionRecord = openSessionRecord(record, session);
    if (typeof operation !== 'function') invalid('operation must be a function');
    assertProjectAccepting(sessionRecord.project);
    sessionRecord.project.inFlight += 1;
    try {
      return await Reflect.apply(
        record.freshnessAdmit.method,
        record.freshnessAdmit.receiver,
        [sessionRecord.entry.freshnessOwner, operation],
      );
    } finally {
      sessionRecord.project.inFlight -= 1;
      if (sessionRecord.project.inFlight < 0) {
        const error = lifecycleUnavailable('Project admission accounting underflow');
        fenceController(record, sessionRecord.entry, error);
        throw error;
      }
      resolveProjectDrain(sessionRecord.project);
    }
  }

  async close(session) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const sessionRecord = openSessionRecord(record, session);
    sessionRecord.state = 'closing';
    assertControllerUsable(record);
    sessionRecord.closePromise = finishSessionClose(record, sessionRecord);
    await sessionRecord.closePromise;
  }

  beginRetiring(projectSelector) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const selector = snapshotSelector(projectSelector);
    let callbackCalls = 0;
    const mintedEpoch = Object.freeze({});
    const epochRecord = {
      beginError: null,
      beginPromise: null,
      controller: record,
      phase: 'pending',
      project: null,
      selector,
    };
    retirementEpochRecords.set(mintedEpoch, epochRecord);
    let returnedPromise;
    try {
      returnedPromise = Reflect.apply(
        record.withProjectIdentity.method,
        record.withProjectIdentity.receiver,
        [selector, (exactFrozenIdentity) => {
          callbackCalls += 1;
          if (callbackCalls !== 1) invalid('registryAdmission invoked its callback more than once');
          assertControllerUsable(record);
          const identity = validateRegistryIdentity(exactFrozenIdentity);
          const project = ensureProjectState(record, identity);
          assertProjectAccepting(project);
          epochRecord.phase = 'retiring';
          epochRecord.project = project;
          project.retirement = epochRecord;
          return mintedEpoch;
        }],
      );
    } catch (error) {
      epochRecord.beginError = error;
      epochRecord.phase = epochRecord.project === null ? 'failed' : 'failed-retiring';
      epochRecord.beginPromise = Promise.resolve();
      return mintedEpoch;
    }
    epochRecord.beginPromise = Promise.resolve(returnedPromise).then(
      (returned) => {
        if (callbackCalls !== 1 || returned !== mintedEpoch) {
          invalid('registryAdmission must return its single callback result');
        }
      },
      (error) => {
        epochRecord.beginError = error;
        epochRecord.phase = epochRecord.project === null ? 'failed' : 'failed-retiring';
      },
    ).catch((error) => {
      epochRecord.beginError = error;
      epochRecord.phase = epochRecord.project === null ? 'failed' : 'failed-retiring';
    });
    return mintedEpoch;
  }

  async drain(retirementEpoch) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const ownedEpoch = ownedRetirementEpochRecord(record, retirementEpoch);
    await ownedEpoch.beginPromise;
    if (ownedEpoch.beginError !== null) throw ownedEpoch.beginError;
    const epochRecord = retirementEpochRecord(
      record,
      retirementEpoch,
      ['retiring', 'draining', 'drained'],
    );
    epochRecord.phase = 'draining';
    const { project } = epochRecord;
    if (project.inFlight !== 0 || project.pendingOpens !== 0) {
      project.drainPromise ||= new Promise((resolve) => {
        project.drainResolve = resolve;
      });
      await project.drainPromise;
    }
    assertControllerUsable(record);
    epochRecord.phase = 'drained';
  }

  async closeForRetirement(retirementEpoch, currentIdentity) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const epochRecord = retirementEpochRecord(record, retirementEpoch, ['drained']);
    const identity = validateRegistryIdentity(currentIdentity);
    if (!sameProjectIdentity(epochRecord.project.identity, identity)) {
      invalid('currentIdentity does not match the retirement project');
    }
    if (epochRecord.project.inFlight !== 0) {
      invalid('retirement project was not drained');
    }
    if (epochRecord.project.pendingOpens !== 0) {
      invalid('retirement project still has pending opens');
    }
    epochRecord.phase = 'closing';
    for (const sessionRecord of [...epochRecord.project.sessions]) {
      if (sessionRecord.state === 'open') {
        sessionRecord.state = 'closing';
        sessionRecord.closePromise = finishSessionClose(record, sessionRecord);
      }
      if (sessionRecord.closePromise !== null) await sessionRecord.closePromise;
    }
    if (epochRecord.project.sessions.size !== 0) {
      throw lifecycleUnavailable('Retirement did not close every project session');
    }
    epochRecord.phase = 'sealed';
  }

  completeRetirement(retirementEpoch) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const epochRecord = retirementEpochRecord(record, retirementEpoch, ['sealed']);
    epochRecord.phase = 'completed';
    epochRecord.project.retirement = null;
  }

  async resumeAfterRetirementFailure(retirementEpoch, currentIdentity) {
    const record = controllerRecord(this);
    assertControllerUsable(record);
    const epochRecord = retirementEpochRecord(
      record,
      retirementEpoch,
      ['drained', 'failed-retiring', 'sealed'],
    );
    const identity = validateRegistryIdentity(currentIdentity);
    if (!sameProjectIdentity(epochRecord.project.identity, identity)) {
      invalid('currentIdentity does not match the retirement project');
    }
    epochRecord.phase = 'resumed';
    epochRecord.project.retirement = null;
  }
}

module.exports = {
  ManuscriptSessionController,
};
