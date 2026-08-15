const fs = require('node:fs');
const path = require('node:path');

const { openControlStore } = require('../../control-store');
const { fsyncDirectory, fsyncFile } = require('../../platform/durability');
const {
  createBoundedControlStoreTestHarness,
} = require('../../testing/bounded-control-store');
const {
  CRASH_ARTIFACTS_PATH_ENV,
  CRASH_MARKER_PATH_ENV,
  crashOnlyFaultPoint,
} = require('../../testing/fault-injection');

const CHECKPOINT_AUTHORITY_ENV = 'MYTHPEN_CONTROL_STORE_CHECKPOINT_AUTHORITY_JSON';
const CHECKPOINT_MARKER_COMPOUND_FAULT = 'controlstore.checkpoint.marker-compound-failure';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertExactDataObject(value, expectedKeys, label) {
  const actualKeys = value !== null && typeof value === 'object'
    ? Reflect.ownKeys(value)
    : [];
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || actualKeys.some((key) => typeof key !== 'string')
    || actualKeys.slice().sort().join('\0') !== expectedKeys.slice().sort().join('\0')
    || actualKeys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor
        || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value');
    })
  ) {
    throw new Error(`${CHECKPOINT_AUTHORITY_ENV} ${label} must contain exact data keys`);
  }
}

function assertExactDataArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${CHECKPOINT_AUTHORITY_ENV} ${label} must be an exact array`);
  }
}

function validateCheckpointAuthorityShape(authority) {
  assertExactDataObject(
    authority,
    ['cleanBasis', 'epochObservations', 'snapshot'],
    'authority',
  );
  assertExactDataObject(
    authority.snapshot,
    ['cleanBasisDigest', 'incarnationId', 'tail'],
    'snapshot',
  );
  assertExactDataObject(authority.snapshot.tail, ['digest', 'seq'], 'snapshot.tail');
  assertExactDataObject(
    authority.cleanBasis,
    [
      'admissionBasis',
      'backend',
      'dbKey',
      'finalSeq',
      'identity',
      'latestCleanBasisDigest',
      'projectInstanceIdSha256',
      'schema',
      'triggerSetDigest',
      'triggerVersion',
      'unresolved',
    ],
    'cleanBasis',
  );
  assertExactDataObject(
    authority.cleanBasis.admissionBasis,
    ['admissionEvent', 'basisDigest', 'basisKind'],
    'cleanBasis.admissionBasis',
  );
  assertExactDataObject(
    authority.cleanBasis.admissionBasis.admissionEvent,
    ['digest', 'payload', 'prevDigest', 'seq', 'type'],
    'cleanBasis.admissionBasis.admissionEvent',
  );
  assertExactDataObject(
    authority.cleanBasis.admissionBasis.admissionEvent.payload,
    [
      'backend',
      'connectionEpoch',
      'createdAt',
      'dbKey',
      'eventId',
      'finalSeq',
      'fixtureRunId',
      'gateEmpty',
      'identity',
      'ownershipHash',
      'projectInstanceIdSha256',
      'schemaVersion',
      'triggerSetDigest',
      'triggerVersion',
      'version',
    ],
    'cleanBasis.admissionBasis.admissionEvent.payload',
  );
  assertExactDataObject(
    authority.cleanBasis.admissionBasis.admissionEvent.payload.identity,
    ['dev', 'ino'],
    'cleanBasis.admissionBasis.admissionEvent.payload.identity',
  );
  assertExactDataObject(authority.cleanBasis.identity, ['dev', 'ino'], 'cleanBasis.identity');
  assertExactDataArray(authority.cleanBasis.unresolved, 'cleanBasis.unresolved');
  assertExactDataArray(authority.epochObservations, 'epochObservations');
}

function parseCheckpointAuthority() {
  const serialized = process.env[CHECKPOINT_AUTHORITY_ENV];
  if (typeof serialized !== 'string' || serialized.length === 0) {
    throw new Error(`${CHECKPOINT_AUTHORITY_ENV} is required for checkpoint scenario`);
  }
  let authority;
  try {
    authority = JSON.parse(serialized);
  } catch (cause) {
    throw new Error(`${CHECKPOINT_AUTHORITY_ENV} is not valid JSON`, { cause });
  }
  validateCheckpointAuthorityShape(authority);
  return deepFreeze(authority);
}

function main() {
  const artifactsPath = process.env[CRASH_ARTIFACTS_PATH_ENV];
  const controlDir = process.env.MYTHPEN_CONTROL_STORE_CRASH_DIR;
  const scenario = process.env.MYTHPEN_CONTROL_STORE_CRASH_SCENARIO || 'legacy';
  if (!artifactsPath) throw new Error(`${CRASH_ARTIFACTS_PATH_ENV} is required`);
  if (!controlDir) throw new Error('MYTHPEN_CONTROL_STORE_CRASH_DIR is required');
  if (!['legacy', 'bootstrap', 'append', 'checkpoint', 'marker-compound-failure'].includes(scenario)) {
    throw new Error(`Unknown control store crash scenario: ${scenario}`);
  }

  const checkpointAuthority = scenario === 'checkpoint'
    ? parseCheckpointAuthority()
    : null;
  const artifacts = scenario === 'legacy'
    ? { controlDir }
    : { version: 1, scenario, controlDir };
  fs.writeFileSync(artifactsPath, JSON.stringify(artifacts));
  fsyncFile(artifactsPath);
  fsyncDirectory(path.dirname(artifactsPath));

  if (scenario === 'legacy') {
    openControlStore(controlDir).append({ type: 'crash-candidate', payload: { value: 3 } });
  } else if (scenario === 'bootstrap') {
    openControlStore(controlDir, { bounded: true });
  } else if (scenario === 'append') {
    openControlStore(controlDir, { bounded: true }).append({
      type: 'bounded.crash-candidate',
      payload: { value: 3 },
    });
  } else if (scenario === 'checkpoint') {
    const harness = createBoundedControlStoreTestHarness(
      controlDir,
      () => checkpointAuthority,
    );
    harness.checkpoint();
  } else {
    const durability = require('../../platform/durability');
    const markerPath = process.env[CRASH_MARKER_PATH_ENV];
    const fsyncError = Object.assign(new Error('controlled marker fsync failure'), { code: 'EIO' });
    const cleanupError = Object.assign(new Error('controlled marker cleanup failure'), { code: 'EACCES' });
    const originalFsyncFile = durability.fsyncFile;
    const originalRmSync = fs.rmSync;
    durability.fsyncFile = () => { throw fsyncError; };
    fs.rmSync = (target, ...args) => {
      if (path.resolve(String(target)) === path.resolve(markerPath)) throw cleanupError;
      return originalRmSync(target, ...args);
    };
    try {
      crashOnlyFaultPoint(CHECKPOINT_MARKER_COMPOUND_FAULT, {
        outcome: 'ordinary-exit-two',
      });
      throw new Error('compound marker fixture did not reach the configured crash fault');
    } finally {
      durability.fsyncFile = originalFsyncFile;
      fs.rmSync = originalRmSync;
    }
  }
}

try {
  main();
} catch {
  process.exit(2);
}
