'use strict';

const { manuscriptError } = require('./contracts');

const IDENTITY_SOURCES = new Set([
  'active',
  'tombstone',
  'ignored_active',
  'ignored_revoked',
]);
const FILE_SOURCES = new Set(['controlled', 'ignored_active']);
const LIMIT_DIMENSIONS = Object.freeze([
  'chapterIdentities',
  'volumeIdentities',
  'markdownBytes',
  'jsonBytes',
  'controlledFiles',
  'chapterDirectoryEntries',
  'controlledBytes',
]);

function createCapacityAccumulator(limits, observer) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('limits must provide all capacity dimensions');
  }
  const capacityLimits = {};
  for (const dimension of LIMIT_DIMENSIONS) {
    const value = limits[dimension];
    if (
      !Object.hasOwn(limits, dimension)
      || !Number.isSafeInteger(value)
      || value < 0
    ) {
      throw new TypeError(`${dimension} limit must be a non-negative safe integer`);
    }
    capacityLimits[dimension] = value;
  }
  Object.freeze(capacityLimits);
  if (observer !== undefined && typeof observer !== 'function') {
    throw new TypeError('observer must be a function');
  }
  const identitySets = {
    chapter: new Set(),
    volume: new Set(),
  };
  const measurements = {
    chapterIdentities: 0,
    volumeIdentities: 0,
    markdownBytes: 0,
    jsonBytes: 0,
    controlledFiles: 0,
    chapterDirectoryEntries: 0,
    controlledBytes: 0,
  };
  const counters = {
    directoryEntries: 0,
    identityProbes: 0,
    contentOpens: 0,
    contentBytes: 0,
  };
  const warnings = new Map();
  let terminalError = null;

  function snapshot() {
    return Object.freeze({
      state: terminalError === null ? 'active' : 'exceeded',
      measurements: Object.freeze({ ...measurements }),
      counters: Object.freeze({ ...counters }),
      warnings: Object.freeze([...warnings.values()]),
      error: terminalError,
    });
  }

  function publish() {
    const nextSnapshot = snapshot();
    if (observer !== undefined) observer(nextSnapshot);
    return nextSnapshot;
  }

  function assertActive() {
    if (terminalError !== null) throw terminalError;
  }

  function latchOverflow(dimension, observed) {
    terminalError = manuscriptError('MANUSCRIPT_CONTENT_TOO_LARGE', {
      dimension,
      observed,
      allowed: capacityLimits[dimension],
    });
    publish();
    throw terminalError;
  }

  function maybeWarnIdentity(dimension) {
    const allowed = capacityLimits[dimension];
    const threshold = Math.ceil(allowed * 0.8);
    const key = `manuscript-capacity:${dimension}:80-percent`;
    if (
      allowed > 0
      && measurements[dimension] >= threshold
      && !warnings.has(key)
    ) {
      warnings.set(key, Object.freeze({
        key,
        dimension,
        observed: measurements[dimension],
        allowed,
        threshold,
        persistent: true,
      }));
    }
  }

  function recordIdentity({ kind, uid, source }) {
    assertActive();
    if (kind !== 'chapter' && kind !== 'volume') {
      throw new TypeError('kind must be chapter or volume');
    }
    if (typeof uid !== 'string' || uid.length === 0) {
      throw new TypeError('uid must be a non-empty string');
    }
    if (!IDENTITY_SOURCES.has(source)) {
      throw new TypeError('source must be one lifecycle identity source');
    }
    const identities = identitySets[kind];
    if (identities.has(uid)) return snapshot();
    identities.add(uid);
    const dimension = `${kind}Identities`;
    measurements[dimension] = identities.size;
    if (measurements[dimension] > capacityLimits[dimension]) {
      latchOverflow(dimension, measurements[dimension]);
    }
    maybeWarnIdentity(dimension);
    return publish();
  }

  function recordDirectoryEntry({ chapterDirectory = false } = {}) {
    assertActive();
    if (typeof chapterDirectory !== 'boolean') {
      throw new TypeError('chapterDirectory must be boolean');
    }
    counters.directoryEntries += 1;
    if (chapterDirectory) {
      measurements.chapterDirectoryEntries += 1;
      if (measurements.chapterDirectoryEntries > capacityLimits.chapterDirectoryEntries) {
        latchOverflow('chapterDirectoryEntries', measurements.chapterDirectoryEntries);
      }
    }
    return publish();
  }

  function recordIdentityProbe() {
    assertActive();
    counters.identityProbes += 1;
    return publish();
  }

  function recordContentOpen() {
    assertActive();
    counters.contentOpens += 1;
    return publish();
  }

  function recordContentBytes(byteCount) {
    assertActive();
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      throw new TypeError('byteCount must be a non-negative safe integer');
    }
    const next = counters.contentBytes + byteCount;
    if (!Number.isSafeInteger(next)) {
      throw new TypeError('content byte counter exceeds safe integer range');
    }
    counters.contentBytes = next;
    return publish();
  }

  function recordFileMetadata({ kind, byteSize, source = 'controlled' }) {
    assertActive();
    if (kind !== 'markdown' && kind !== 'json') {
      throw new TypeError('kind must be markdown or json');
    }
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new TypeError('byteSize must be a non-negative safe integer');
    }
    if (!FILE_SOURCES.has(source)) {
      throw new TypeError('source must be controlled or ignored_active');
    }

    const singleFileDimension = `${kind}Bytes`;
    measurements[singleFileDimension] = Math.max(
      measurements[singleFileDimension],
      byteSize,
    );
    if (byteSize > capacityLimits[singleFileDimension]) {
      latchOverflow(singleFileDimension, byteSize);
    }

    measurements.controlledFiles += 1;
    if (measurements.controlledFiles > capacityLimits.controlledFiles) {
      latchOverflow('controlledFiles', measurements.controlledFiles);
    }

    const controlledBytes = measurements.controlledBytes + byteSize;
    if (!Number.isSafeInteger(controlledBytes)) {
      throw new TypeError('controlled byte measurement exceeds safe integer range');
    }
    measurements.controlledBytes = controlledBytes;
    if (measurements.controlledBytes > capacityLimits.controlledBytes) {
      latchOverflow('controlledBytes', measurements.controlledBytes);
    }
    return publish();
  }

  return Object.freeze({
    recordContentBytes,
    recordContentOpen,
    recordDirectoryEntry,
    recordFileMetadata,
    recordIdentity,
    recordIdentityProbe,
    snapshot,
  });
}

module.exports = { createCapacityAccumulator };
