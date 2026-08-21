'use strict';

const FEED_IDS = Object.freeze(['mythpen', 'volumes', 'chapters']);
const FEED_ID_SET = new Set(FEED_IDS);
const DEGRADED_REASONS = new Set([
  'CAPABILITY_DISABLED',
  'NO_SLOT',
  'KNOWN_UNAVAILABLE',
]);
const REFRESH_KINDS = new Set(['FULL', 'INCREMENTAL']);
const SUCCESS_DISPOSITIONS = new Set(['COMMITTED', 'ALREADY_CURRENT']);

const stateRecords = new WeakMap();
const completionRecords = new WeakMap();
const claimRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFrozenDataObject(value, keys, label) {
  if (!isPlainObject(value) || !Object.isFrozen(value)) {
    invalid(`${label} must be a frozen plain object`);
  }
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

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertFeedId(feedId) {
  if (!FEED_ID_SET.has(feedId)) invalid('feedId must identify one manuscript feed');
  return feedId;
}

function assertHandleInstance(handleInstance) {
  if (
    handleInstance === null
    || (typeof handleInstance !== 'object' && typeof handleInstance !== 'function')
    || !Object.isFrozen(handleInstance)
  ) {
    invalid('handleInstance must be a frozen opaque authority');
  }
  return handleInstance;
}

function stateRecord(receiver) {
  const record = stateRecords.get(receiver);
  if (!record) invalid('ManuscriptFeedState receiver is invalid');
  return record;
}

function withWriter(receiver, operation) {
  const record = stateRecord(receiver);
  if (record.writerActive) invalid('ManuscriptFeedState writer is not reentrant');
  record.writerActive = true;
  try {
    return operation(record);
  } finally {
    record.writerActive = false;
  }
}

function latchCoverageLoss(record) {
  record.coverageLost = true;
  record.coverageLossEpoch += 1n;
}

function assertGateLifecycle(record) {
  if (!['STARTING', 'ACTIVE', 'DEGRADED'].includes(record.lifecycleState)) {
    invalid('feed state no longer accepts readable gates');
  }
}

function assertRefreshLifecycle(record) {
  if (record.lifecycleState !== 'ACTIVE' && record.lifecycleState !== 'DEGRADED') {
    invalid('feed state cannot claim a refresh in its current lifecycle');
  }
}

function validateProbeEvents(value) {
  const events = exactFrozenDataObject(
    value,
    FEED_IDS,
    'probeEvents result',
  );
  for (const feedId of FEED_IDS) {
    if (typeof events[feedId] !== 'boolean') {
      invalid(`probeEvents result.${feedId} must be boolean`);
    }
  }
  return value;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isCanonicalComponent(component) {
  return (
    component.length > 0
    && component !== '.'
    && component !== '..'
    && !/[\u0000-\u001f\u007f\\/:*?"<>|]/u.test(component)
    && !/[. ]$/u.test(component)
    && !hasUnpairedSurrogate(component)
    && component.normalize('NFC') === component
  );
}

function validateDirtyPath(path) {
  if (typeof path !== 'string') invalid('dirty path keys must be strings');
  let component;
  if (path.startsWith('mythpen/volumes/')) {
    component = path.slice('mythpen/volumes/'.length);
  } else if (path.startsWith('mythpen/chapters/')) {
    component = path.slice('mythpen/chapters/'.length);
  } else if (path.startsWith('mythpen/')) {
    component = path.slice('mythpen/'.length);
    if (component === 'volumes' || component === 'chapters') {
      invalid('dirty path must identify a component, not a watched directory');
    }
  } else {
    invalid('dirty path must use a canonical manuscript relative prefix');
  }
  if (!isCanonicalComponent(component)) {
    invalid('dirty path must end in one canonical component');
  }
  return path;
}

function validateDirtyPaths(value) {
  if (!Array.isArray(value) || !Object.isFrozen(value)) {
    invalid('dirtyPaths must be a frozen dense array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    invalid('dirtyPaths must have a canonical array length');
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== length + 1
  ) {
    invalid('dirtyPaths must be dense and have no extra properties');
  }
  const paths = [];
  const unique = new Set();
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid('dirtyPaths must contain enumerable data elements only');
    }
    const path = validateDirtyPath(descriptor.value);
    if (unique.has(path)) invalid('dirtyPaths must be unique');
    unique.add(path);
    paths.push(path);
  }
  return Object.freeze(paths.sort());
}

function completionRecord(record, completion) {
  const completionRecordValue = completionRecords.get(completion);
  if (
    !completionRecordValue
    || completionRecordValue.owner !== record
    || completionRecordValue.active !== true
  ) {
    invalid('completion is not an active authority of this feed state');
  }
  const feed = record.feeds[completionRecordValue.feedId];
  if (
    feed.pendingCompletion !== completion
    || feed.handleInstance !== completionRecordValue.handleInstance
    || feed.observed !== completionRecordValue.sequence
  ) {
    invalid('completion authority is stale');
  }
  return completionRecordValue;
}

function claimRecord(record, claim) {
  const claimRecordValue = claimRecords.get(claim);
  if (
    !claimRecordValue
    || claimRecordValue.owner !== record
    || claimRecordValue.active !== true
    || record.activeClaim !== claim
  ) {
    invalid('claim is not an active authority of this feed state');
  }
  return claimRecordValue;
}

function validateRefreshResult(result, baseGeneration) {
  if (!isPlainObject(result) || !Object.isFrozen(result)) {
    invalid('refresh result must be a frozen plain object');
  }
  const preliminaryDescriptors = Object.getOwnPropertyDescriptors(result);
  const dispositionDescriptor = preliminaryDescriptors.disposition;
  if (
    dispositionDescriptor === undefined
    || dispositionDescriptor.enumerable !== true
    || !Object.hasOwn(dispositionDescriptor, 'value')
  ) {
    invalid('refresh result disposition must be an enumerable data property');
  }
  const disposition = dispositionDescriptor.value;
  let values;
  if (disposition === 'COMMITTED') {
    values = exactFrozenDataObject(
      result,
      ['disposition', 'baseGeneration', 'targetGeneration', 'refreshKind'],
      'COMMITTED refresh result',
    );
    nonNegativeSafeInteger(values.baseGeneration, 'refresh result baseGeneration');
    nonNegativeSafeInteger(values.targetGeneration, 'refresh result targetGeneration');
    if (
      values.baseGeneration !== baseGeneration
      || values.targetGeneration <= baseGeneration
    ) {
      invalid('COMMITTED refresh result generation does not match its claim');
    }
  } else if (disposition === 'ALREADY_CURRENT') {
    values = exactFrozenDataObject(
      result,
      ['disposition', 'generation', 'refreshKind'],
      'ALREADY_CURRENT refresh result',
    );
    nonNegativeSafeInteger(values.generation, 'refresh result generation');
    if (values.generation !== baseGeneration) {
      invalid('ALREADY_CURRENT refresh result generation does not match its claim');
    }
  } else if (disposition === 'KNOWN_NOT_COMMITTED' || disposition === 'UNKNOWN') {
    values = exactFrozenDataObject(
      result,
      ['disposition', 'generation', 'refreshKind', 'error'],
      `${disposition} refresh result`,
    );
    nonNegativeSafeInteger(values.generation, 'refresh result generation');
    if (values.generation !== baseGeneration) {
      invalid(`${disposition} refresh result generation does not match its claim`);
    }
  } else {
    invalid('refresh result has an unknown disposition');
  }
  if (!REFRESH_KINDS.has(values.refreshKind)) {
    invalid('refresh result refreshKind must be FULL or INCREMENTAL');
  }
  return Object.freeze({
    disposition,
    error: Object.hasOwn(values, 'error') ? values.error : undefined,
    refreshKind: values.refreshKind,
  });
}

function sortedDirty(record) {
  return Object.freeze([...record.dirtyPaths].sort());
}

function makeSnapshot(record, events) {
  const feeds = {};
  for (const feedId of FEED_IDS) {
    const feed = record.feeds[feedId];
    feeds[feedId] = Object.freeze({
      handleInstance: feed.handleInstance,
      armed: feed.armed,
      observed: feed.observed.toString(10),
      accounted: feed.accounted.toString(10),
    });
  }
  Object.freeze(feeds);
  const dirtyPaths = sortedDirty(record);
  const allEventsQuiet = FEED_IDS.every((feedId) => events[feedId] === false);
  const allFeedsCurrent = FEED_IDS.every((feedId) => {
    const feed = record.feeds[feedId];
    return (
      feed.handleInstance !== null
      && feed.armed
      && feed.pendingCompletion === null
      && feed.observed === feed.accounted
    );
  });
  return Object.freeze({
    lifecycleState: record.lifecycleState,
    degradedReason: record.degradedReason,
    events,
    feeds,
    dirtyPaths,
    refresh: record.activeClaim === null
      ? null
      : claimRecords.get(record.activeClaim).snapshot,
    coverageLost: record.coverageLost,
    coverageLossEpoch: record.coverageLossEpoch.toString(10),
    clean: (
      record.lifecycleState === 'ACTIVE'
      && allEventsQuiet
      && allFeedsCurrent
      && dirtyPaths.length === 0
      && record.activeClaim === null
      && !record.coverageLost
    ),
  });
}

function canClearCoverageLoss(record, claimRecordValue, resultInfo) {
  if (
    resultInfo.refreshKind !== 'FULL'
    || !SUCCESS_DISPOSITIONS.has(resultInfo.disposition)
    || record.lifecycleState !== 'ACTIVE'
    || record.coverageLossEpoch !== claimRecordValue.coverageLossEpoch
  ) {
    return false;
  }
  return FEED_IDS.every((feedId) => {
    const feed = record.feeds[feedId];
    const counters = claimRecordValue.counterWitnesses[feedId];
    return (
      feed.handleInstance === claimRecordValue.handleInstances[feedId]
      && feed.handleInstance !== null
      && feed.armed
      && feed.pendingCompletion === null
      && feed.observed === feed.accounted
      && feed.observed === counters.observed
      && feed.accounted === counters.accounted
    );
  });
}

class ManuscriptFeedState {
  constructor() {
    const feeds = Object.create(null);
    for (const feedId of FEED_IDS) {
      feeds[feedId] = {
        accounted: 0n,
        armed: false,
        closed: false,
        handleInstance: null,
        observed: 0n,
        pendingCompletion: null,
      };
    }
    stateRecords.set(this, {
      activeClaim: null,
      coverageLost: true,
      coverageLossEpoch: 1n,
      degradedReason: null,
      dirtyPaths: new Set(),
      feeds,
      lifecycleState: 'STARTING',
      writerActive: false,
    });
    Object.freeze(this);
  }

  arm(feedId, handleInstance) {
    return withWriter(this, (record) => {
      assertFeedId(feedId);
      assertHandleInstance(handleInstance);
      if (record.lifecycleState !== 'STARTING') {
        invalid('feed state no longer accepts new handle instances');
      }
      const feed = record.feeds[feedId];
      if (feed.handleInstance !== null || feed.closed) {
        invalid('a feed handle instance is immutable for one feed-state lifetime');
      }
      feed.handleInstance = handleInstance;
      feed.armed = true;
      if (FEED_IDS.every((id) => record.feeds[id].handleInstance !== null)) {
        record.lifecycleState = 'ACTIVE';
      }
      return undefined;
    });
  }

  enterDegraded(reason) {
    return withWriter(this, (record) => {
      if (!DEGRADED_REASONS.has(reason)) {
        invalid('degraded reason is not recognized');
      }
      if (
        record.lifecycleState !== 'STARTING'
        || record.activeClaim !== null
        || FEED_IDS.some((feedId) => record.feeds[feedId].handleInstance !== null)
      ) {
        invalid('degraded mode can only replace an unopened feed set');
      }
      record.lifecycleState = 'DEGRADED';
      record.degradedReason = reason;
      for (const feedId of FEED_IDS) record.feeds[feedId].closed = true;
      return undefined;
    });
  }

  gateSnapshot(probeEvents) {
    return withWriter(this, (record) => {
      assertGateLifecycle(record);
      if (typeof probeEvents !== 'function') invalid('probeEvents must be a function');
      let events;
      try {
        events = validateProbeEvents(Reflect.apply(probeEvents, undefined, []));
      } catch (error) {
        latchCoverageLoss(record);
        throw error;
      }
      return makeSnapshot(record, events);
    });
  }

  observeCompletion(feedId, handleInstance) {
    return withWriter(this, (record) => {
      assertFeedId(feedId);
      assertHandleInstance(handleInstance);
      if (record.lifecycleState !== 'ACTIVE' && record.lifecycleState !== 'STOPPING') {
        invalid('feed state cannot observe a completion in its current lifecycle');
      }
      const feed = record.feeds[feedId];
      if (
        feed.closed
        || feed.handleInstance !== handleInstance
        || !feed.armed
        || feed.pendingCompletion !== null
        || feed.observed !== feed.accounted
      ) {
        invalid('feed completion does not match one armed handle instance');
      }
      feed.armed = false;
      feed.observed += 1n;
      const completion = Object.freeze({});
      completionRecords.set(completion, {
        active: true,
        feedId,
        handleInstance,
        owner: record,
        rearmed: false,
        sequence: feed.observed,
      });
      feed.pendingCompletion = completion;
      return completion;
    });
  }

  recordRearm(completion, handleInstance) {
    return withWriter(this, (record) => {
      assertHandleInstance(handleInstance);
      if (record.lifecycleState !== 'ACTIVE') {
        invalid('feed state cannot record a rearm after stopping begins');
      }
      const completionRecordValue = completionRecord(record, completion);
      const feed = record.feeds[completionRecordValue.feedId];
      if (
        completionRecordValue.handleInstance !== handleInstance
        || completionRecordValue.rearmed
        || feed.armed
      ) {
        invalid('completion cannot authorize this rearm');
      }
      completionRecordValue.rearmed = true;
      feed.armed = true;
      return undefined;
    });
  }

  accountCompletion(completion, dirtyPaths, coverageLost) {
    return withWriter(this, (record) => {
      const completionRecordValue = completionRecord(record, completion);
      if (typeof coverageLost !== 'boolean') invalid('coverageLost must be boolean');
      const canonicalDirtyPaths = validateDirtyPaths(dirtyPaths);
      if (!completionRecordValue.rearmed && !coverageLost) {
        invalid('an unrearmed completion must account coverage loss');
      }
      if (record.lifecycleState !== 'ACTIVE' && record.lifecycleState !== 'STOPPING') {
        invalid('feed state cannot account a completion in its current lifecycle');
      }
      const feed = record.feeds[completionRecordValue.feedId];
      for (const path of canonicalDirtyPaths) record.dirtyPaths.add(path);
      if (coverageLost) latchCoverageLoss(record);
      feed.accounted += 1n;
      completionRecordValue.active = false;
      feed.pendingCompletion = null;
      return undefined;
    });
  }

  claimRefresh(baseGeneration) {
    return withWriter(this, (record) => {
      assertRefreshLifecycle(record);
      nonNegativeSafeInteger(baseGeneration, 'baseGeneration');
      if (record.activeClaim !== null) invalid('one refresh claim is already active');
      const dirtyPaths = sortedDirty(record);
      record.dirtyPaths.clear();
      const snapshot = Object.freeze({ baseGeneration, dirtyPaths });
      const claim = Object.freeze({});
      const handleInstances = Object.freeze(Object.fromEntries(
        FEED_IDS.map((feedId) => [feedId, record.feeds[feedId].handleInstance]),
      ));
      const counterWitnesses = Object.freeze(Object.fromEntries(
        FEED_IDS.map((feedId) => {
          const feed = record.feeds[feedId];
          return [feedId, Object.freeze({
            observed: feed.observed,
            accounted: feed.accounted,
          })];
        }),
      ));
      claimRecords.set(claim, {
        active: true,
        baseGeneration,
        counterWitnesses,
        coverageLossEpoch: record.coverageLossEpoch,
        dirtyPaths,
        handleInstances,
        owner: record,
        snapshot,
      });
      record.activeClaim = claim;
      return claim;
    });
  }

  claimSnapshot(claim) {
    return withWriter(this, (record) => claimRecord(record, claim).snapshot);
  }

  settleRefresh(claim, result) {
    return withWriter(this, (record) => {
      const claimRecordValue = claimRecord(record, claim);
      const resultInfo = validateRefreshResult(result, claimRecordValue.baseGeneration);

      if (SUCCESS_DISPOSITIONS.has(resultInfo.disposition)) {
        if (canClearCoverageLoss(record, claimRecordValue, resultInfo)) {
          record.coverageLost = false;
        }
        claimRecordValue.active = false;
        record.activeClaim = null;
        return result;
      }

      for (const path of claimRecordValue.dirtyPaths) record.dirtyPaths.add(path);
      if (resultInfo.disposition === 'UNKNOWN') latchCoverageLoss(record);
      claimRecordValue.active = false;
      record.activeClaim = null;
      throw resultInfo.error;
    });
  }

  beginStopping() {
    return withWriter(this, (record) => {
      if (
        record.lifecycleState !== 'STARTING'
        && record.lifecycleState !== 'ACTIVE'
        && record.lifecycleState !== 'DEGRADED'
      ) {
        invalid('feed state cannot begin stopping in its current lifecycle');
      }
      record.lifecycleState = 'STOPPING';
      for (const feedId of FEED_IDS) {
        const feed = record.feeds[feedId];
        if (feed.handleInstance === null) {
          feed.armed = false;
          feed.closed = true;
        }
      }
      return undefined;
    });
  }

  closeFeed(feedId, handleInstance) {
    return withWriter(this, (record) => {
      assertFeedId(feedId);
      assertHandleInstance(handleInstance);
      if (record.lifecycleState !== 'STOPPING') {
        invalid('feeds can only close while the feed state is stopping');
      }
      const feed = record.feeds[feedId];
      if (
        feed.closed
        || feed.handleInstance !== handleInstance
        || feed.armed
        || feed.pendingCompletion !== null
        || feed.observed !== feed.accounted
      ) {
        invalid('feed closure is not fully accounted for this handle instance');
      }
      feed.closed = true;
      return undefined;
    });
  }

  finishClosed() {
    return withWriter(this, (record) => {
      if (
        record.lifecycleState !== 'STOPPING'
        || record.activeClaim !== null
        || FEED_IDS.some((feedId) => {
          const feed = record.feeds[feedId];
          return (
            !feed.closed
            || feed.pendingCompletion !== null
            || feed.observed !== feed.accounted
          );
        })
      ) {
        invalid('feed state cannot finish before every feed and claim is closed');
      }
      record.lifecycleState = 'CLOSED';
      return undefined;
    });
  }
}

module.exports = { ManuscriptFeedState };
