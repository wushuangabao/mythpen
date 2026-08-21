'use strict';

const { types: { isProxy } } = require('node:util');

const { manuscriptError } = require('./contracts');
const { ManuscriptFeedState } = require('./feed-state');

const FEED_IDS = Object.freeze(['mythpen', 'volumes', 'chapters']);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ACTIONS = new Set([
  'ADDED',
  'REMOVED',
  'MODIFIED',
  'RENAMED_OLD_NAME',
  'RENAMED_NEW_NAME',
]);
const SUCCESS_DISPOSITIONS = new Set(['COMMITTED', 'ALREADY_CURRENT']);
const CLOSED = Object.freeze({ disposition: 'CLOSED' });

const lifecycleRecords = new WeakMap();
const ownerRecords = new WeakMap();
const admissionRecords = new WeakMap();
const productFreshnessRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataObject(value, keys, label, frozen = false) {
  if (!isPlainObject(value) || (frozen && !Object.isFrozen(value))) {
    invalid(`${label} must be ${frozen ? 'a frozen ' : ''}plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const expected = [...keys].sort();
  if (
    actual.some((key) => typeof key !== 'string')
    || actual.length !== expected.length
    || actual.map(String).sort().some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} has an inexact key set`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label} must contain enumerable data properties only`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function ownData(value, key, label) {
  if (!isPlainObject(value) || !Object.isFrozen(value)) {
    invalid(`${label} must be a frozen plain object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || !Object.hasOwn(descriptor, 'value')
  ) {
    invalid(`${label}.${key} must be an enumerable data property`);
  }
  return descriptor.value;
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
        ) invalid(`${label} must contain dense enumerable data`);
        assertDeepFrozenPlainData(descriptor.value, `${label}[${index}]`, active);
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string'
          || !/^(0|[1-9][0-9]*)$/u.test(key)
          || Number(key) >= value.length
        ) invalid(`${label} has an invalid array property`);
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
      ) invalid(`${label} must contain enumerable data properties only`);
      assertDeepFrozenPlainData(descriptor.value, `${label}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function exactMethodSurface(receiver, methodNames, label) {
  if (isProxy(receiver) || !isPlainObject(receiver)) {
    invalid(`${label} must be one exact plain method surface`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(receiver);
  const actual = Reflect.ownKeys(descriptors);
  const expected = [...methodNames].sort();
  if (
    actual.some((key) => typeof key !== 'string')
    || actual.length !== expected.length
    || actual.map(String).sort().some((key, index) => key !== expected[index])
  ) invalid(`${label} has an inexact method surface`);
  const methods = Object.create(null);
  for (const methodName of methodNames) {
    const descriptor = descriptors[methodName];
    if (
      descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function'
    ) invalid(`${label}.${methodName} must be an own enumerable data function`);
    methods[methodName] = Object.freeze({ receiver, method: descriptor.value });
  }
  return Object.freeze(methods);
}

function invoke(boundMethod, args) {
  return Reflect.apply(boundMethod.method, boundMethod.receiver, args);
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    invalid(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function physicalIdentity(value, label) {
  const values = exactDataObject(value, ['dev', 'ino'], label, true);
  for (const key of ['dev', 'ino']) {
    if (typeof values[key] !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(values[key])) {
      invalid(`${label}.${key} must be a canonical decimal string`);
    }
  }
  return value;
}

function lifecycleIdentity(value) {
  const values = exactDataObject(value, [
    'canonicalRealControlDirectory',
    'controlDirectoryIdentity',
    'controlParentDirectoryIdentity',
    'lifecycleLockIdentity',
  ], 'lifecyclePlatformIdentity', true);
  if (
    typeof values.canonicalRealControlDirectory !== 'string'
    || values.canonicalRealControlDirectory.length === 0
  ) invalid('lifecyclePlatformIdentity canonical directory must be non-empty');
  physicalIdentity(values.controlDirectoryIdentity, 'controlDirectoryIdentity');
  physicalIdentity(values.controlParentDirectoryIdentity, 'controlParentDirectoryIdentity');
  physicalIdentity(values.lifecycleLockIdentity, 'lifecycleLockIdentity');
  return value;
}

function registryIdentity(value) {
  assertDeepFrozenPlainData(value, 'registryIdentity');
  const projectUid = ownData(value, 'projectUid', 'registryIdentity');
  const projectInstanceId = ownData(value, 'projectInstanceId', 'registryIdentity');
  const lifecycle = ownData(value, 'lifecyclePlatformIdentity', 'registryIdentity');
  assertUuid(projectUid, 'registryIdentity.projectUid');
  assertUuid(projectInstanceId, 'registryIdentity.projectInstanceId');
  lifecycleIdentity(lifecycle);
  return Object.freeze({
    exactIdentity: value,
    projectUid,
    projectInstanceId,
    lifecycle,
  });
}

function samePhysical(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLifecycle(left, right) {
  return (
    left.canonicalRealControlDirectory === right.canonicalRealControlDirectory
    && samePhysical(left.controlDirectoryIdentity, right.controlDirectoryIdentity)
    && samePhysical(left.controlParentDirectoryIdentity, right.controlParentDirectoryIdentity)
    && samePhysical(left.lifecycleLockIdentity, right.lifecycleLockIdentity)
  );
}

function feedIdentityValues(value, label = 'changeFeedPlatformIdentity') {
  const values = exactDataObject(value, [
    'canonicalRealMythpenDirectory',
    'articleRootDirectoryIdentity',
    'mythpenDirectoryIdentity',
    'volumesDirectoryIdentity',
    'chaptersDirectoryIdentity',
  ], label, true);
  if (
    typeof values.canonicalRealMythpenDirectory !== 'string'
    || values.canonicalRealMythpenDirectory.length === 0
  ) invalid(`${label}.canonicalRealMythpenDirectory must be non-empty`);
  for (const key of [
    'articleRootDirectoryIdentity',
    'mythpenDirectoryIdentity',
    'volumesDirectoryIdentity',
    'chaptersDirectoryIdentity',
  ]) physicalIdentity(values[key], `${label}.${key}`);
  return values;
}

function sameFeedIdentity(left, right) {
  const a = feedIdentityValues(left, 'owner changeFeedPlatformIdentity');
  const b = feedIdentityValues(right, 'joining changeFeedPlatformIdentity');
  return (
    a.canonicalRealMythpenDirectory === b.canonicalRealMythpenDirectory
    && samePhysical(a.articleRootDirectoryIdentity, b.articleRootDirectoryIdentity)
    && samePhysical(a.mythpenDirectoryIdentity, b.mythpenDirectoryIdentity)
    && samePhysical(a.volumesDirectoryIdentity, b.volumesDirectoryIdentity)
    && samePhysical(a.chaptersDirectoryIdentity, b.chaptersDirectoryIdentity)
  );
}

function startBasis(value) {
  const values = exactDataObject(
    value,
    ['changeFeedPlatformIdentity'],
    'preStartVerifier result',
    true,
  );
  feedIdentityValues(values.changeFeedPlatformIdentity);
  return values.changeFeedPlatformIdentity;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function projectionToken(value, label = 'projection token') {
  const values = exactDataObject(
    value,
    ['generation', 'connectionEpoch', 'basisDigest'],
    label,
    true,
  );
  nonNegativeSafeInteger(values.generation, `${label}.generation`);
  nonNegativeSafeInteger(values.connectionEpoch, `${label}.connectionEpoch`);
  if (typeof values.basisDigest !== 'string' || !SHA256_PATTERN.test(values.basisDigest)) {
    invalid(`${label}.basisDigest must be a lowercase SHA-256 digest`);
  }
  return value;
}

function sameToken(left, right) {
  return (
    left.generation === right.generation
    && left.connectionEpoch === right.connectionEpoch
    && left.basisDigest === right.basisDigest
  );
}

function readResult(value) {
  const values = exactDataObject(value, ['token', 'value'], 'readCurrent result', true);
  projectionToken(values.token, 'readCurrent result.token');
  return value;
}

function fullRefreshResult(value, baseGeneration) {
  if (!isPlainObject(value) || !Object.isFrozen(value)) {
    invalid('fullRefresh result must be a frozen plain object');
  }
  const disposition = ownData(value, 'disposition', 'fullRefresh result');
  let values;
  if (disposition === 'COMMITTED') {
    values = exactDataObject(value, [
      'disposition', 'baseGeneration', 'targetGeneration', 'refreshKind',
    ], 'COMMITTED fullRefresh result', true);
    nonNegativeSafeInteger(values.baseGeneration, 'fullRefresh baseGeneration');
    nonNegativeSafeInteger(values.targetGeneration, 'fullRefresh targetGeneration');
    if (
      values.baseGeneration !== baseGeneration
      || values.targetGeneration <= baseGeneration
    ) invalid('COMMITTED fullRefresh generations do not match the claim');
  } else if (disposition === 'ALREADY_CURRENT') {
    values = exactDataObject(value, [
      'disposition', 'generation', 'refreshKind',
    ], 'ALREADY_CURRENT fullRefresh result', true);
    nonNegativeSafeInteger(values.generation, 'fullRefresh generation');
    if (values.generation !== baseGeneration) {
      invalid('ALREADY_CURRENT generation does not match the claim');
    }
  } else if (disposition === 'KNOWN_NOT_COMMITTED' || disposition === 'UNKNOWN') {
    values = exactDataObject(value, [
      'disposition', 'generation', 'refreshKind', 'error',
    ], `${disposition} fullRefresh result`, true);
    nonNegativeSafeInteger(values.generation, 'fullRefresh generation');
    if (values.generation !== baseGeneration) {
      invalid(`${disposition} generation does not match the claim`);
    }
  } else {
    invalid('fullRefresh result disposition is invalid');
  }
  if (values.refreshKind !== 'FULL') invalid('Task 9C accepts only FULL refresh results');
  return Object.freeze({
    disposition,
    error: Object.hasOwn(values, 'error') ? values.error : undefined,
    targetGeneration: Object.hasOwn(values, 'targetGeneration')
      ? values.targetGeneration
      : undefined,
  });
}

function ownUnknownDisposition(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'releaseDispositionUnknown');
  } catch {
    return true;
  }
  return descriptor !== undefined
    && Object.hasOwn(descriptor, 'value')
    && descriptor.value === true;
}

function lifecycleRecord(lifecycle) {
  const record = lifecycleRecords.get(lifecycle);
  if (!record) invalid('freshness lifecycle receiver is invalid');
  return record;
}

function ownerRecord(lifecycleRecordValue, owner) {
  const record = ownerRecords.get(owner);
  if (!record || record.lifecycle !== lifecycleRecordValue) {
    invalid('owner must be an opaque authority minted by this freshness lifecycle');
  }
  return record;
}

function activeAdmission(admission) {
  const record = admissionRecords.get(admission);
  if (!record || !record.active) invalid('freshnessAdmission is invalid or stale');
  if (record.owner.fencedError) throw record.owner.fencedError;
  return record;
}

function mintAdmission(record, startup = false) {
  if (!startup && (record.state !== 'active' || !record.accepting)) {
    if (record.fencedError) throw record.fencedError;
    invalid('freshness owner is not accepting admission');
  }
  record.gates += 1;
  const admission = Object.freeze({});
  admissionRecords.set(admission, { active: true, owner: record, startup });
  return admission;
}

function releaseAdmission(admission) {
  const admissionRecord = admissionRecords.get(admission);
  if (!admissionRecord || !admissionRecord.active) invalid('freshness admission underflow');
  admissionRecord.active = false;
  const record = admissionRecord.owner;
  record.gates -= 1;
  if (record.gates < 0) invalid('freshness owner gate underflow');
  if (record.gates === 0 && record.gateResolve) {
    const resolve = record.gateResolve;
    record.gateResolve = null;
    record.gatePromise = null;
    resolve();
  }
}

function waitForGates(record) {
  if (record.gates === 0) return Promise.resolve();
  if (!record.gatePromise) {
    record.gatePromise = new Promise((resolve) => {
      record.gateResolve = resolve;
    });
  }
  return record.gatePromise;
}

function latchLoss(record, error) {
  try {
    record.feedState.gateSnapshot(() => { throw error; });
  } catch {
    // gateSnapshot synchronously latches loss before preserving the primary error.
  }
}

function markFatal(record, error) {
  latchLoss(record, error);
  if (!record.fatalError) record.fatalError = error;
  return error;
}

function validateFeedOwner(owner) {
  if (owner === null || typeof owner !== 'object' || !Object.isFrozen(owner)) {
    invalid('OPENED feed owner must be frozen');
  }
  for (const method of [
    'feedInstance',
    'probeEvents',
    'takeCompletion',
    'rearm',
    'decode',
    'retireCompletion',
    'beginStopping',
    'cancelPending',
    'close',
  ]) {
    if (typeof owner[method] !== 'function') invalid(`feed owner.${method} must be a function`);
  }
  return owner;
}

function validateOpenResult(result) {
  if (!isPlainObject(result) || !Object.isFrozen(result)) {
    invalid('feedAdapter.tryOpen result must be a frozen plain object');
  }
  const outcome = ownData(result, 'outcome', 'feedAdapter.tryOpen result');
  if (outcome === 'OPENED') {
    const values = exactDataObject(result, ['outcome', 'owner'], 'OPENED result', true);
    return Object.freeze({ outcome, owner: validateFeedOwner(values.owner) });
  }
  if (outcome === 'NO_SLOT') {
    exactDataObject(result, ['outcome'], 'NO_SLOT result', true);
    return Object.freeze({ outcome });
  }
  if (outcome === 'UNAVAILABLE') {
    const values = exactDataObject(
      result,
      ['outcome', 'error', 'closeDisposition'],
      'UNAVAILABLE result',
      true,
    );
    if (values.closeDisposition !== 'KNOWN_CLOSED' && values.closeDisposition !== 'UNKNOWN') {
      invalid('UNAVAILABLE closeDisposition must be known or unknown');
    }
    return Object.freeze({
      outcome,
      error: values.error,
      closeDisposition: values.closeDisposition,
    });
  }
  invalid('feedAdapter.tryOpen result outcome is invalid');
}

function armDirectOwner(record, platformOwner) {
  record.feedOwner = platformOwner;
  record.mode = 'platform-only';
  const handles = Object.create(null);
  for (const feedId of FEED_IDS) {
    const handleInstance = platformOwner.feedInstance(feedId);
    if (
      handleInstance === null
      || (typeof handleInstance !== 'object' && typeof handleInstance !== 'function')
      || !Object.isFrozen(handleInstance)
    ) invalid('feed owner returned an invalid handle instance');
    handles[feedId] = handleInstance;
  }
  record.feedHandles = Object.freeze(handles);
  for (const feedId of FEED_IDS) {
    record.feedState.arm(feedId, record.feedHandles[feedId]);
  }
  record.mode = 'direct';
}

function canonicalDirtyPaths(feedId, decoded) {
  if (!isPlainObject(decoded) || !Object.isFrozen(decoded)) {
    invalid('feed decode result must be a frozen plain object');
  }
  const outcome = ownData(decoded, 'outcome', 'feed decode result');
  if (outcome === 'COVERAGE_LOST') {
    const values = exactDataObject(
      decoded,
      ['outcome', 'reason'],
      'COVERAGE_LOST decode result',
      true,
    );
    if (typeof values.reason !== 'string' || values.reason.length === 0) {
      invalid('coverage-loss reason must be non-empty');
    }
    return Object.freeze({ dirtyPaths: Object.freeze([]), coverageLost: true });
  }
  if (outcome !== 'RECORDS') invalid('feed decode result outcome is invalid');
  const values = exactDataObject(decoded, ['outcome', 'records'], 'RECORDS result', true);
  if (!Array.isArray(values.records) || !Object.isFrozen(values.records)) {
    invalid('decode records must be a frozen array');
  }
  const dirtyPaths = new Set();
  let coverageLost = false;
  for (const record of values.records) {
    const notification = exactDataObject(
      record,
      ['action', 'component'],
      'notification record',
      true,
    );
    if (!ACTIONS.has(notification.action)) invalid('notification action is invalid');
    if (typeof notification.component !== 'string') invalid('notification component is invalid');
    if (
      feedId === 'mythpen'
      && (notification.component === 'volumes' || notification.component === 'chapters')
    ) {
      coverageLost = true;
      continue;
    }
    const prefix = feedId === 'mythpen' ? 'mythpen' : `mythpen/${feedId}`;
    dirtyPaths.add(`${prefix}/${notification.component}`);
  }
  return Object.freeze({ dirtyPaths: Object.freeze([...dirtyPaths]), coverageLost });
}

function validatePlatformCompletion(value, feedId, expectedHandle) {
  const values = exactDataObject(
    value,
    ['feedId', 'handleInstance'],
    'platform completion',
    true,
  );
  if (values.feedId !== feedId || values.handleInstance !== expectedHandle) {
    invalid('platform completion does not match the requested feed handle');
  }
  return value;
}

function finishOutstanding(record, outstanding, teardown = false) {
  const owner = record.feedOwner;
  if (!outstanding.decoded) {
    const decoded = owner.decode(outstanding.platformCompletion);
    outstanding.decoded = true;
    outstanding.decodedResult = canonicalDirtyPaths(outstanding.feedId, decoded);
  }
  if (!outstanding.accounted) {
    const decodedResult = outstanding.decodedResult;
    record.feedState.accountCompletion(
      outstanding.stateCompletion,
      decodedResult.dirtyPaths,
      teardown || decodedResult.coverageLost || !outstanding.rearmed,
    );
    outstanding.accounted = true;
  }
  if (!outstanding.retired) {
    owner.retireCompletion(outstanding.platformCompletion);
    outstanding.retired = true;
  }
  record.outstanding.delete(outstanding.feedId);
}

function failOutstanding(record, outstanding, primaryError) {
  if (!outstanding.accounted) {
    try {
      record.feedState.accountCompletion(
        outstanding.stateCompletion,
        Object.freeze([]),
        true,
      );
      outstanding.accounted = true;
    } catch {
      latchLoss(record, primaryError);
    }
  }
  throw markFatal(record, primaryError);
}

function processSignaledCompletion(record, feedId) {
  const owner = record.feedOwner;
  let platformCompletion;
  try {
    platformCompletion = owner.takeCompletion(feedId);
  } catch (error) {
    throw markFatal(record, error);
  }
  if (platformCompletion === null) {
    throw markFatal(
      record,
      new TypeError('signaled feed did not provide a terminal completion'),
    );
  }
  try {
    validatePlatformCompletion(platformCompletion, feedId, record.feedHandles[feedId]);
  } catch (error) {
    throw markFatal(record, error);
  }
  let stateCompletion;
  try {
    stateCompletion = record.feedState.observeCompletion(
      feedId,
      platformCompletion.handleInstance,
    );
  } catch (error) {
    throw markFatal(record, error);
  }
  const outstanding = {
    accounted: false,
    decoded: false,
    decodedResult: null,
    feedId,
    platformCompletion,
    rearmed: false,
    retired: false,
    stateCompletion,
  };
  record.outstanding.set(feedId, outstanding);
  try {
    const handleInstance = owner.rearm(platformCompletion);
    record.feedState.recordRearm(stateCompletion, handleInstance);
    outstanding.rearmed = true;
    finishOutstanding(record, outstanding, false);
    return true;
  } catch (error) {
    return failOutstanding(record, outstanding, error);
  }
}

function gateSnapshot(record) {
  if (record.fatalError) throw record.fatalError;
  try {
    return record.feedState.gateSnapshot(() => (
      record.mode === 'direct'
        ? record.feedOwner.probeEvents()
        : Object.freeze({ mythpen: false, volumes: false, chapters: false })
    ));
  } catch (error) {
    if (record.mode === 'direct' && !record.fatalError) record.fatalError = error;
    throw error;
  }
}

function drainToQuiet(record) {
  if (record.mode !== 'direct') return gateSnapshot(record);
  for (;;) {
    const snapshot = gateSnapshot(record);
    let processed = false;
    for (const feedId of FEED_IDS) {
      if (snapshot.events[feedId]) {
        processed = processSignaledCompletion(record, feedId) || processed;
      }
    }
    if (processed) continue;
    const countersCurrent = FEED_IDS.every((feedId) => (
      snapshot.feeds[feedId].observed === snapshot.feeds[feedId].accounted
    ));
    if (countersCurrent) return snapshot;
    throw markFatal(record, new TypeError('feed completion counters made no progress'));
  }
}

function snapshotStable(left, right) {
  return (
    left.clean
    && right.clean
    && left.coverageLossEpoch === right.coverageLossEpoch
    && FEED_IDS.every((feedId) => {
      const a = left.feeds[feedId];
      const b = right.feeds[feedId];
      return (
        a.handleInstance === b.handleInstance
        && a.armed === b.armed
        && a.observed === b.observed
        && a.accounted === b.accounted
      );
    })
  );
}

async function callCurrentToken(record, admission) {
  try {
    return projectionToken(
      await invoke(record.lifecycle.currentToken, [admission]),
      'projectionAccess.currentToken result',
    );
  } catch (error) {
    latchLoss(record, error);
    throw error;
  }
}

async function settleUnknown(record, claim, baseGeneration, error) {
  const result = Object.freeze({
    disposition: 'UNKNOWN',
    generation: baseGeneration,
    refreshKind: 'FULL',
    error,
  });
  try {
    record.feedState.settleRefresh(claim, result);
  } catch (settledError) {
    throw settledError;
  }
  throw error;
}

async function performFullRefresh(admissionRecordValue, writerTurn) {
  const record = admissionRecordValue.owner;
  const admission = admissionRecordValue.authority;
  const baseToken = await callCurrentToken(record, admission);
  let claim;
  try {
    claim = record.feedState.claimRefresh(baseToken.generation);
  } catch (error) {
    throw markFatal(record, error);
  }
  let claimSnapshot;
  try {
    claimSnapshot = record.feedState.claimSnapshot(claim);
  } catch (error) {
    return settleUnknown(record, claim, baseToken.generation, error);
  }
  const input = Object.freeze({ admission, writerTurn, claimSnapshot, baseToken });
  let result;
  try {
    result = await invoke(record.lifecycle.fullRefresh, [input]);
  } catch (error) {
    return settleUnknown(record, claim, baseToken.generation, error);
  }
  let info;
  try {
    info = fullRefreshResult(result, baseToken.generation);
  } catch (error) {
    return settleUnknown(record, claim, baseToken.generation, error);
  }
  if (SUCCESS_DISPOSITIONS.has(info.disposition)) {
    let postToken;
    try {
      postToken = await callCurrentToken(record, admission);
    } catch (error) {
      return settleUnknown(record, claim, baseToken.generation, error);
    }
    let witnessError;
    if (
      info.disposition === 'COMMITTED'
      && postToken.generation !== info.targetGeneration
    ) {
      witnessError = new TypeError('COMMITTED refresh did not publish its target generation');
    } else if (
      info.disposition === 'ALREADY_CURRENT'
      && !sameToken(postToken, baseToken)
    ) {
      witnessError = new TypeError('ALREADY_CURRENT refresh changed its projection token');
    }
    if (witnessError) {
      return settleUnknown(record, claim, baseToken.generation, witnessError);
    }
  }
  try {
    record.feedState.settleRefresh(claim, result);
  } catch (error) {
    throw error;
  }
  return info;
}

async function ensureProjectionCurrentInternal(admissionRecordValue, writerTurn) {
  const record = admissionRecordValue.owner;
  const admission = admissionRecordValue.authority;
  if (record.fatalError) throw record.fatalError;
  invoke(record.lifecycle.assertTurn, [admission, writerTurn]);
  try {
    await invoke(record.lifecycle.recoverBeforeRefresh, [admission, writerTurn]);
  } catch (error) {
    latchLoss(record, error);
    throw error;
  }

  if (record.mode === 'degraded') {
    return performFullRefresh(admissionRecordValue, writerTurn);
  }

  for (;;) {
    drainToQuiet(record);
    const info = await performFullRefresh(admissionRecordValue, writerTurn);
    const after = drainToQuiet(record);
    if (after.clean) return info;
  }
}

async function ensureProjectionCurrent(freshnessAdmission, writerTurn) {
  const admissionRecordValue = activeAdmission(freshnessAdmission);
  admissionRecordValue.authority = freshnessAdmission;
  await ensureProjectionCurrentInternal(admissionRecordValue, writerTurn);
  return undefined;
}

function changedDuringRead() {
  return manuscriptError('MANUSCRIPT_TREE_CHANGED_DURING_READ');
}

function isConnectionStale(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  let descriptor;
  try {
    if (isProxy(error)) return false;
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return false;
  }
  return descriptor !== undefined
    && Object.hasOwn(descriptor, 'value')
    && descriptor.value === 'DB_CONNECTION_STALE';
}

async function withInternalWriter(admissionRecordValue) {
  const admission = admissionRecordValue.authority;
  const lifecycle = admissionRecordValue.owner.lifecycle;
  return invoke(lifecycle.withWriterTurn, [
    admission,
    (writerTurn) => ensureProjectionCurrentInternal(admissionRecordValue, writerTurn),
  ]);
}

async function readDirect(admissionRecordValue, query) {
  const record = admissionRecordValue.owner;
  const admission = admissionRecordValue.authority;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before;
    try {
      before = drainToQuiet(record);
      if (!before.clean) {
        await withInternalWriter(admissionRecordValue);
        before = drainToQuiet(record);
      }
      const result = readResult(await invoke(record.lifecycle.readCurrent, [admission, query]));
      const after = drainToQuiet(record);
      const current = await callCurrentToken(record, admission);
      if (
        snapshotStable(before, after)
        && sameToken(result.token, current)
      ) return result;
    } catch (error) {
      if (!isConnectionStale(error)) throw error;
    }
  }
  throw changedDuringRead();
}

async function readDegraded(admissionRecordValue, query) {
  const record = admissionRecordValue.owner;
  const admission = admissionRecordValue.authority;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await withInternalWriter(admissionRecordValue);
      const result = readResult(await invoke(record.lifecycle.readCurrent, [admission, query]));
      const afterInfo = await withInternalWriter(admissionRecordValue);
      const current = await callCurrentToken(record, admission);
      if (afterInfo.disposition === 'ALREADY_CURRENT' && sameToken(result.token, current)) {
        return result;
      }
    } catch (error) {
      if (!isConnectionStale(error)) throw error;
    }
  }
  throw changedDuringRead();
}

async function ensureReadableProjection(freshnessAdmission, query) {
  const admissionRecordValue = activeAdmission(freshnessAdmission);
  admissionRecordValue.authority = freshnessAdmission;
  const record = admissionRecordValue.owner;
  if (record.fatalError) throw record.fatalError;
  return record.mode === 'direct'
    ? readDirect(admissionRecordValue, query)
    : readDegraded(admissionRecordValue, query);
}

function productIntentDescriptor(value) {
  const values = exactDataObject(
    value,
    ['family', 'logicalInputDigest'],
    'product write intent descriptor',
    true,
  );
  if (values.family === 'ordinary_create') {
    if (typeof values.logicalInputDigest !== 'string' || !SHA256_PATTERN.test(values.logicalInputDigest)) {
      invalid('ordinary_create intent requires a lowercase SHA-256 logical digest');
    }
  } else if (values.family === 'non_create' || values.family === 'orphan_resolution') {
    if (values.logicalInputDigest !== null) {
      invalid(`${values.family} intent must not provide a logical digest`);
    }
  } else {
    invalid('product write intent family is invalid');
  }
  return Object.freeze({
    family: values.family,
    logicalInputDigest: values.logicalInputDigest,
  });
}

function productWriteInput(value) {
  const values = exactDataObject(
    value,
    ['logicalRequestId', 'writeIntent'],
    'product freshness write input',
    true,
  );
  if (typeof values.logicalRequestId !== 'string' || values.logicalRequestId.length === 0) {
    invalid('product freshness logicalRequestId must be non-empty');
  }
  return values;
}

function productRecoveryRequired(message) {
  return manuscriptError('RECOVERY_REQUIRED', { reason: message });
}

function assertMatchingLogicalChain(descriptor, logicalRequestId, lookup) {
  if (lookup === null) return null;
  if (descriptor.family !== 'ordinary_create') {
    throw productRecoveryRequired('logical_request_collides_with_ordinary_create');
  }
  try {
    const chain = exactDataObject(lookup, [
      'state',
      'outcome',
      'identityReservation',
      'reservationBinding',
    ], 'ordinary logical request lookup', true);
    if (
      typeof chain.state !== 'string'
      || chain.state.length === 0
      || !['early', 'advanced', 'after', 'before'].includes(chain.outcome)
      || chain.identityReservation === null
      || typeof chain.identityReservation !== 'object'
      || !Object.isFrozen(chain.identityReservation)
    ) invalid('ordinary logical request lookup is not one classified create chain');
    const binding = exactDataObject(chain.reservationBinding, [
      'projectUid',
      'projectInstanceId',
      'journalId',
      'logicalRequestId',
      'baseGeneration',
      'targetGeneration',
      'basisDigest',
      'logicalInputDigest',
      'inputDigest',
      'reservationDigest',
    ], 'ordinary reservation binding', true);
    assertUuid(binding.projectUid, 'ordinary reservation binding.projectUid');
    assertUuid(binding.projectInstanceId, 'ordinary reservation binding.projectInstanceId');
    assertUuid(binding.journalId, 'ordinary reservation binding.journalId');
    nonNegativeSafeInteger(binding.baseGeneration, 'ordinary reservation binding.baseGeneration');
    nonNegativeSafeInteger(binding.targetGeneration, 'ordinary reservation binding.targetGeneration');
    if (
      binding.targetGeneration !== binding.baseGeneration + 1
      || binding.logicalRequestId !== logicalRequestId
      || binding.logicalInputDigest !== descriptor.logicalInputDigest
      || !SHA256_PATTERN.test(binding.basisDigest)
      || !SHA256_PATTERN.test(binding.inputDigest)
      || !SHA256_PATTERN.test(binding.reservationDigest)
    ) invalid('ordinary reservation binding differs from this create intent');
    return Object.freeze({
      binding: Object.freeze({ ...binding }),
      outcome: chain.outcome,
      state: chain.state,
    });
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw productRecoveryRequired('ordinary_create_logical_binding_mismatch');
  }
}

function sameOrdinaryBinding(left, right) {
  return [
    'projectUid',
    'projectInstanceId',
    'journalId',
    'logicalRequestId',
    'baseGeneration',
    'targetGeneration',
    'basisDigest',
    'logicalInputDigest',
    'inputDigest',
    'reservationDigest',
  ].every((key) => left[key] === right[key]);
}

function createProductWriteFreshness(options) {
  const values = exactDataObject(options, [
    'productWriteIntentAuthority',
    'journalRecovery',
    'projectionFreshness',
  ], 'product write freshness options');
  const productWriteIntentAuthority = exactMethodSurface(
    values.productWriteIntentAuthority,
    ['assert', 'describe'],
    'productWriteIntentAuthority',
  );
  const journalRecovery = exactMethodSurface(
    values.journalRecovery,
    ['lookupCommittedRequest', 'lookupOrdinaryRequest', 'recoverPendingOrdinary'],
    'journalRecovery',
  );
  const projectionFreshness = exactMethodSurface(
    values.projectionFreshness,
    ['ensureProjectionCurrent', 'ensureReadableProjection'],
    'projectionFreshness',
  );
  const freshness = Object.freeze({
    async ensureProjectionCurrentForWrite(admission, writerTurn, input) {
      const record = productFreshnessRecords.get(this);
      if (record === undefined) invalid('product write freshness receiver is invalid');
      const write = productWriteInput(input);
      const asserted = invoke(record.productWriteIntentAuthority.assert, [write.writeIntent]);
      if (asserted !== write.writeIntent) {
        invalid('product write intent authority must return the original intent');
      }
      const descriptor = productIntentDescriptor(invoke(
        record.productWriteIntentAuthority.describe,
        [write.writeIntent],
      ));
      const committed = await invoke(record.journalRecovery.lookupCommittedRequest, [
        write.writeIntent,
        write.logicalRequestId,
      ]);
      if (committed !== null) {
        let replay;
        try {
          replay = exactDataObject(
            committed,
            ['disposition'],
            'committed product request replay',
            true,
          );
        } catch (cause) {
          throw productRecoveryRequired('committed_product_request_is_malformed');
        }
        if (descriptor.family !== 'non_create' || replay.disposition !== 'after') {
          throw productRecoveryRequired('committed_product_request_binding_mismatch');
        }
        return invoke(record.projectionFreshness.ensureProjectionCurrent, [
          admission,
          writerTurn,
        ]);
      }
      const beforeLookup = await invoke(record.journalRecovery.lookupOrdinaryRequest, [
        write.logicalRequestId,
      ]);
      const before = assertMatchingLogicalChain(
        descriptor,
        write.logicalRequestId,
        beforeLookup,
      );
      if (descriptor.family === 'orphan_resolution') return undefined;
      if (before?.outcome === 'before') {
        throw productRecoveryRequired('ordinary_create_is_known_before');
      }
      await invoke(record.journalRecovery.recoverPendingOrdinary, []);
      const afterLookup = await invoke(record.journalRecovery.lookupOrdinaryRequest, [
        write.logicalRequestId,
      ]);
      const after = assertMatchingLogicalChain(
        descriptor,
        write.logicalRequestId,
        afterLookup,
      );
      if (before === null && after !== null) {
        throw productRecoveryRequired('logical_request_appeared_during_recovery');
      }
      if (before !== null) {
        if (after === null || !sameOrdinaryBinding(before.binding, after.binding)) {
          throw productRecoveryRequired('ordinary_create_binding_changed_during_recovery');
        }
        if (
          (before.outcome === 'early' && after.outcome !== 'after')
          || (before.outcome === 'advanced' && after.outcome !== 'after')
          || after.outcome === 'before'
        ) throw productRecoveryRequired('ordinary_create_recovery_disposition_is_invalid');
      }
      return invoke(record.projectionFreshness.ensureProjectionCurrent, [admission, writerTurn]);
    },
    async ensureReadableProjection(admission, query) {
      const record = productFreshnessRecords.get(this);
      if (record === undefined) invalid('product write freshness receiver is invalid');
      return invoke(record.projectionFreshness.ensureReadableProjection, [admission, query]);
    },
  });
  productFreshnessRecords.set(freshness, Object.freeze({
    journalRecovery,
    productWriteIntentAuthority,
    projectionFreshness,
  }));
  return freshness;
}

function fenceOwner(record, error) {
  if (!record.fencedError) record.fencedError = error;
  record.accepting = false;
  record.state = 'fenced';
  return record.fencedError;
}

function cleanupOutstanding(record, teardown) {
  for (const outstanding of [...record.outstanding.values()]) {
    finishOutstanding(record, outstanding, teardown);
  }
}

function teardownDirect(record) {
  const owner = record.feedOwner;
  record.feedState.beginStopping();
  owner.beginStopping();
  cleanupOutstanding(record, true);
  for (const feedId of FEED_IDS) {
    const platformCompletion = owner.cancelPending(feedId);
    if (platformCompletion !== null) {
      validatePlatformCompletion(platformCompletion, feedId, record.feedHandles[feedId]);
      const stateCompletion = record.feedState.observeCompletion(
        feedId,
        platformCompletion.handleInstance,
      );
      const outstanding = {
        accounted: false,
        decoded: false,
        decodedResult: null,
        feedId,
        platformCompletion,
        rearmed: false,
        retired: false,
        stateCompletion,
      };
      record.outstanding.set(feedId, outstanding);
      finishOutstanding(record, outstanding, true);
    }
  }
  const closed = exactDataObject(owner.close(), ['disposition'], 'feed close result', true);
  if (closed.disposition !== 'CLOSED') invalid('feed close disposition is not known closed');
  for (const feedId of FEED_IDS) {
    record.feedState.closeFeed(feedId, record.feedHandles[feedId]);
  }
  record.feedState.finishClosed();
}

function teardownPlatformOnly(record) {
  const owner = record.feedOwner;
  owner.beginStopping();
  for (const feedId of FEED_IDS) {
    const completion = owner.cancelPending(feedId);
    if (completion === null) continue;
    const handle = owner.feedInstance(feedId);
    validatePlatformCompletion(completion, feedId, handle);
    owner.decode(completion);
    owner.retireCompletion(completion);
  }
  const closed = exactDataObject(owner.close(), ['disposition'], 'feed close result', true);
  if (closed.disposition !== 'CLOSED') invalid('feed close disposition is not known closed');
  teardownWithoutFeed(record);
}

function teardownWithoutFeed(record) {
  record.feedState.beginStopping();
  record.feedState.finishClosed();
}

function createManuscriptFreshnessLifecycle(options) {
  const values = exactDataObject(options, [
    'preStartVerifier',
    'feedAdapter',
    'notificationCapability',
    'writerTurns',
    'recovery',
    'fullRefresh',
    'projectionAccess',
  ], 'freshness lifecycle options');
  const preStartVerifier = exactMethodSurface(
    values.preStartVerifier,
    ['verifyBeforeFeedStart'],
    'preStartVerifier',
  );
  const feedAdapter = exactMethodSurface(
    values.feedAdapter,
    ['assertIdentity', 'tryOpen'],
    'feedAdapter',
  );
  const notificationCapability = exactMethodSurface(
    values.notificationCapability,
    ['read'],
    'notificationCapability',
  );
  const writerTurns = exactMethodSurface(
    values.writerTurns,
    ['withWriterTurn', 'assertTurn'],
    'writerTurns',
  );
  const recovery = exactMethodSurface(
    values.recovery,
    ['recoverBeforeRefresh'],
    'recovery',
  );
  const fullRefresh = exactMethodSurface(
    values.fullRefresh,
    ['validateAndPublish'],
    'fullRefresh',
  );
  const projectionAccess = exactMethodSurface(
    values.projectionAccess,
    ['readCurrent', 'currentToken'],
    'projectionAccess',
  );
  const record = Object.freeze({
    assertFeedIdentity: feedAdapter.assertIdentity,
    assertTurn: writerTurns.assertTurn,
    currentToken: projectionAccess.currentToken,
    fullRefresh: fullRefresh.validateAndPublish,
    notificationRead: notificationCapability.read,
    readCurrent: projectionAccess.readCurrent,
    recoverBeforeRefresh: recovery.recoverBeforeRefresh,
    tryOpen: feedAdapter.tryOpen,
    verifyBeforeFeedStart: preStartVerifier.verifyBeforeFeedStart,
    withWriterTurn: writerTurns.withWriterTurn,
  });

  async function startOwner(ownerRecordValue, exactIdentity, performStartupRefresh) {
    if (ownerRecordValue.startCalled) invalid('freshness owner start is exact-once');
    if (ownerRecordValue.state !== 'inert') invalid('freshness owner is not inert');
    if (ownerRecordValue.identity.exactIdentity !== exactIdentity) {
      invalid('first start must consume the original registry identity reference');
    }
    ownerRecordValue.startCalled = true;
    ownerRecordValue.state = 'starting';
    const startupAdmission = mintAdmission(ownerRecordValue, true);
    const startupAdmissionRecord = admissionRecords.get(startupAdmission);
    startupAdmissionRecord.authority = startupAdmission;
    try {
      const verifiedBasis = await invoke(
        record.verifyBeforeFeedStart,
        [exactIdentity],
      );
      const exactFeedIdentity = startBasis(verifiedBasis);
      const assertedIdentity = invoke(
        record.assertFeedIdentity,
        [exactFeedIdentity],
      );
      if (assertedIdentity !== exactFeedIdentity) {
        invalid('feedAdapter.assertIdentity must return the same identity reference');
      }
      ownerRecordValue.feedIdentity = exactFeedIdentity;

      const capability = invoke(record.notificationRead, []);
      if (typeof capability !== 'boolean') {
        invalid('notificationCapability.read must synchronously return boolean');
      }
      if (!capability) {
        ownerRecordValue.feedState.enterDegraded('CAPABILITY_DISABLED');
        ownerRecordValue.mode = 'degraded';
      } else {
        let opened;
        try {
          opened = validateOpenResult(invoke(
            record.tryOpen,
            [exactFeedIdentity],
          ));
        } catch (error) {
          throw fenceOwner(ownerRecordValue, error);
        }
        if (opened.outcome === 'OPENED') {
          armDirectOwner(ownerRecordValue, opened.owner);
        } else if (opened.outcome === 'NO_SLOT') {
          ownerRecordValue.feedState.enterDegraded('NO_SLOT');
          ownerRecordValue.mode = 'degraded';
        } else if (
          opened.closeDisposition === 'KNOWN_CLOSED'
          && !ownUnknownDisposition(opened.error)
        ) {
          ownerRecordValue.feedState.enterDegraded('KNOWN_UNAVAILABLE');
          ownerRecordValue.mode = 'degraded';
        } else {
          throw fenceOwner(ownerRecordValue, opened.error);
        }
      }

      if (performStartupRefresh) {
        await invoke(record.withWriterTurn, [
          startupAdmission,
          (writerTurn) => ensureProjectionCurrentInternal(startupAdmissionRecord, writerTurn),
        ]);
      }
      ownerRecordValue.state = 'active';
      ownerRecordValue.accepting = true;
    } catch (error) {
      if (!ownerRecordValue.fencedError) {
        ownerRecordValue.fatalError = ownerRecordValue.fatalError || error;
        ownerRecordValue.state = 'failed';
      }
      throw error;
    } finally {
      releaseAdmission(startupAdmission);
    }
  }

  const lifecycle = {
    createOwner(exactIdentity) {
      const lifecycleRecordValue = lifecycleRecord(this);
      const identity = registryIdentity(exactIdentity);
      const owner = Object.freeze({});
      ownerRecords.set(owner, {
        accepting: false,
        closeCalled: false,
        fatalError: null,
        feedHandles: null,
        feedIdentity: null,
        feedOwner: null,
        feedState: new ManuscriptFeedState(),
        fencedError: null,
        gatePromise: null,
        gateResolve: null,
        gates: 0,
        identity,
        lifecycle: lifecycleRecordValue,
        mode: null,
        outstanding: new Map(),
        startCalled: false,
        state: 'inert',
      });
      return owner;
    },

    async start(owner, exactIdentity) {
      const lifecycleRecordValue = lifecycleRecord(this);
      const ownerRecordValue = ownerRecord(lifecycleRecordValue, owner);
      return startOwner(ownerRecordValue, exactIdentity, true);
    },

    async startOrphan(owner, exactIdentity) {
      const lifecycleRecordValue = lifecycleRecord(this);
      const ownerRecordValue = ownerRecord(lifecycleRecordValue, owner);
      return startOwner(ownerRecordValue, exactIdentity, false);
    },

    async assertSameBinding(owner, exactIdentity) {
      const lifecycleRecordValue = lifecycleRecord(this);
      const ownerRecordValue = ownerRecord(lifecycleRecordValue, owner);
      if (ownerRecordValue.fencedError) throw ownerRecordValue.fencedError;
      if (ownerRecordValue.state !== 'active') invalid('freshness owner is not active');
      const joining = registryIdentity(exactIdentity);
      if (
        joining.projectUid !== ownerRecordValue.identity.projectUid
        || joining.projectInstanceId !== ownerRecordValue.identity.projectInstanceId
        || !sameLifecycle(joining.lifecycle, ownerRecordValue.identity.lifecycle)
      ) invalid('joining registry identity does not match the freshness owner');
      const verifiedBasis = await invoke(
        lifecycleRecordValue.verifyBeforeFeedStart,
        [joining.exactIdentity],
      );
      const exactFeedIdentity = startBasis(verifiedBasis);
      const assertedIdentity = invoke(
        lifecycleRecordValue.assertFeedIdentity,
        [exactFeedIdentity],
      );
      if (
        assertedIdentity !== exactFeedIdentity
        || !sameFeedIdentity(ownerRecordValue.feedIdentity, exactFeedIdentity)
      ) invalid('joining feed identity does not match the freshness owner');
    },

    async admit(owner, operation) {
      const lifecycleRecordValue = lifecycleRecord(this);
      const ownerRecordValue = ownerRecord(lifecycleRecordValue, owner);
      if (typeof operation !== 'function') invalid('freshness operation must be a function');
      const admission = mintAdmission(ownerRecordValue, false);
      const admissionRecordValue = admissionRecords.get(admission);
      admissionRecordValue.authority = admission;
      try {
        return await operation(admission);
      } finally {
        releaseAdmission(admission);
      }
    },

    async close(owner) {
      const lifecycleRecordValue = lifecycleRecord(this);
      const ownerRecordValue = ownerRecord(lifecycleRecordValue, owner);
      if (ownerRecordValue.closeCalled) invalid('freshness owner close is exact-once');
      ownerRecordValue.closeCalled = true;
      ownerRecordValue.accepting = false;
      if (ownerRecordValue.fencedError) throw ownerRecordValue.fencedError;
      ownerRecordValue.state = 'stopping';
      await waitForGates(ownerRecordValue);
      try {
        if (ownerRecordValue.mode === 'direct') teardownDirect(ownerRecordValue);
        else if (ownerRecordValue.mode === 'platform-only') teardownPlatformOnly(ownerRecordValue);
        else teardownWithoutFeed(ownerRecordValue);
      } catch (error) {
        throw fenceOwner(ownerRecordValue, error);
      }
      ownerRecordValue.state = 'closed';
      return CLOSED;
    },
  };
  Object.freeze(lifecycle);
  lifecycleRecords.set(lifecycle, record);
  return lifecycle;
}

module.exports = {
  createManuscriptFreshnessLifecycle,
  createProductWriteFreshness,
  ensureProjectionCurrent,
  ensureReadableProjection,
};
