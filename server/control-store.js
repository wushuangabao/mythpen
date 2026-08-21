const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  acquireExclusiveLease,
  atomicReplace,
  fsyncDirectory,
  fsyncFile,
} = require('./platform/durability');
const { FAULT_POINTS, faultPoint } = require('./testing/fault-injection');

const EVENT_FILE_PATTERN = /^(\d+)-([0-9a-f]{64})\.json$/;
const EVENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const INCARNATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INCARNATION_FILE_NAME = '.controlstore-incarnation.json';
const INCARNATION_TEMP_PATTERN = /^\.controlstore-incarnation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const INCARNATION_VERSION = 1;
const WRITER_LOCK_NAME = '.controlstore-writer.lock';
const SQLITE_RECOVERY_DIR_NAME = 'sqlite-recovery';
const MANUSCRIPT_FILE_ASSETS_DIR_NAME = 'file-assets';
const MANUSCRIPT_DRAFT_CONFLICT_DIR_NAME = 'draft-conflict';
const BOUNDED_CONTROL_PROTOCOL_EPOCH = 2;
const BOUNDED_TAIL_FILE_NAME = '.controlstore-tail.json';
const BOUNDED_TAIL_CANDIDATE_PATTERN = /^\.controlstore-tail-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const BOUNDED_CHECKPOINT_FILE_PATTERN = /^\.controlstore-checkpoint-([1-9]\d*)-([0-9a-f]{64})\.json$/;
const BOUNDED_CHECKPOINT_CANDIDATE_PATTERN = /^\.controlstore-checkpoint-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const BOUNDED_TAIL_KEYS = [
  'version',
  'recordDigest',
  'controlProtocolEpoch',
  'incarnationId',
  'checkpointFile',
  'checkpointDigest',
  'coveredSeq',
  'coveredDigest',
  'tailSeq',
  'tailDigest',
  'activeEventCount',
  'activeEventBytes',
];
const BOUNDED_CHECKPOINT_KEYS = [
  'version',
  'checkpointDigest',
  'controlProtocolEpoch',
  'incarnationId',
  'admissionBasis',
  'coveredSeq',
  'coveredDigest',
  'chainRoot',
  'previousCheckpoint',
  'dbKey',
  'schema',
  'backend',
  'finalSeq',
  'triggerVersion',
  'triggerSetDigest',
  'projectInstanceIdSha256',
  'identity',
  'latestCleanBasisDigest',
  'eventTypeCounts',
  'unresolved',
  'retryContinuationOpen',
  'connectionEpochFilter',
];
const RETIRED_DIRECTORY_SUFFIX_PATTERN = /^\.retired-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMP_FILE_PATTERN = /^\.controlstore-[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const STORED_EVENT_KEYS = new Set([
  'afterPredicate',
  'digest',
  'payload',
  'prevDigest',
  'seq',
  'type',
]);
const boundedCheckpointControllers = new WeakMap();
const mintedRecoveryRequiredErrors = new WeakSet();

class ControlStoreCorruptError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ControlStoreCorruptError';
    this.code = 'CONTROL_STORE_CORRUPT';
  }
}

class ControlStoreInvalidOptionsError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'ControlStoreInvalidOptionsError';
    this.code = 'CONTROL_STORE_INVALID_OPTIONS';
  }
}

class ControlStoreProtocolUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ControlStoreProtocolUnsupportedError';
    this.code = 'CONTROL_STORE_PROTOCOL_UNSUPPORTED';
  }
}

class ControlStoreRecoveryRequiredError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ControlStoreRecoveryRequiredError';
    this.code = 'RECOVERY_REQUIRED';
  }
}

class ControlCheckpointBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ControlCheckpointBlockedError';
    this.code = 'CONTROL_CHECKPOINT_BLOCKED';
  }
}

class ControlStoreFencedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ControlStoreFencedError';
    this.code = 'CONTROL_STORE_FENCED';
  }
}

class ControlStoreInvalidEventError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ControlStoreInvalidEventError';
    this.code = 'CONTROL_STORE_INVALID_EVENT';
  }
}

class ControlStoreIoError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ControlStoreIoError';
    this.code = 'CONTROL_STORE_IO';
  }
}

class ControlStoreStaleError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ControlStoreStaleError';
    this.code = 'CONTROL_STORE_STALE';
  }
}

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.keys(item).sort().map((key) => [key, item[key]]),
    );
  });
}

function eventDigest(event) {
  return crypto.createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function invalidOpenOptions() {
  return new ControlStoreInvalidOptionsError(
    'Control store options must be exact { bounded: false } or { bounded: true }',
  );
}

function parseOpenOptions(argumentCount, options) {
  if (argumentCount === 1) return false;
  if (argumentCount !== 2 || options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw invalidOpenOptions();
  }
  if (Object.getPrototypeOf(options) !== Object.prototype) throw invalidOpenOptions();
  const keys = Reflect.ownKeys(options);
  if (keys.length !== 1 || keys[0] !== 'bounded') throw invalidOpenOptions();
  const descriptor = Object.getOwnPropertyDescriptor(options, 'bounded');
  if (
    !descriptor
    || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    || typeof descriptor.value !== 'boolean'
  ) {
    throw invalidOpenOptions();
  }
  return descriptor.value;
}

function protocolUnsupported(message) {
  return new ControlStoreProtocolUnsupportedError(message);
}

function checkpointBlocked(message) {
  return new ControlCheckpointBlockedError(message);
}

function recoveryRequired(message, cause) {
  const error = new ControlStoreRecoveryRequiredError(
    message,
    cause ? { cause } : undefined,
  );
  mintedRecoveryRequiredErrors.add(error);
  return error;
}

function isExactObject(value, keys) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function recordDigest(value, digestKey) {
  const withoutDigest = { ...value };
  delete withoutDigest[digestKey];
  return crypto.createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex');
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function checkpointAuthorityFailure(message, cause) {
  throw recoveryRequired(
    `Control store checkpoint authority ${message}`,
    cause,
  );
}

function validateExactFrozenRecord(value, expectedKeys, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || !Object.isFrozen(value)
  ) {
    checkpointAuthorityFailure(`${label} must be an exact frozen data object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    checkpointAuthorityFailure(`${label} has an inexact key set`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      checkpointAuthorityFailure(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
}

function validateExactFrozenArray(value, label) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || !Object.isFrozen(value)
  ) {
    checkpointAuthorityFailure(`${label} must be an exact frozen array`);
  }
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
    'length',
  ];
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    checkpointAuthorityFailure(`${label} has an inexact key set`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      checkpointAuthorityFailure(`${label}[${index}] must be an enumerable data property`);
    }
  }
  return value;
}

function validateCheckpointAuthority(authority, evidence, incarnationId) {
  validateExactFrozenRecord(
    authority,
    ['snapshot', 'cleanBasis', 'epochObservations'],
    'result',
  );
  const snapshot = validateExactFrozenRecord(
    authority.snapshot,
    ['incarnationId', 'tail', 'cleanBasisDigest'],
    'snapshot',
  );
  const snapshotTail = validateExactFrozenRecord(
    snapshot.tail,
    ['seq', 'digest'],
    'snapshot.tail',
  );
  const cleanBasis = validateExactFrozenRecord(
    authority.cleanBasis,
    [
      'admissionBasis',
      'dbKey',
      'schema',
      'backend',
      'finalSeq',
      'triggerVersion',
      'triggerSetDigest',
      'projectInstanceIdSha256',
      'identity',
      'latestCleanBasisDigest',
      'unresolved',
    ],
    'cleanBasis',
  );
  const admissionBasis = validateExactFrozenRecord(
    cleanBasis.admissionBasis,
    ['basisKind', 'basisDigest', 'admissionEvent'],
    'cleanBasis.admissionBasis',
  );
  const admissionEvent = validateExactFrozenRecord(
    admissionBasis.admissionEvent,
    ['seq', 'type', 'payload', 'prevDigest', 'digest'],
    'cleanBasis.admissionBasis.admissionEvent',
  );
  validateExactFrozenRecord(
    admissionEvent.payload,
    [
      'version',
      'eventId',
      'dbKey',
      'projectInstanceIdSha256',
      'createdAt',
      'ownershipHash',
      'connectionEpoch',
      'fixtureRunId',
      'schemaVersion',
      'backend',
      'finalSeq',
      'gateEmpty',
      'triggerVersion',
      'triggerSetDigest',
      'identity',
    ],
    'cleanBasis.admissionBasis.admissionEvent.payload',
  );
  validateExactFrozenRecord(
    admissionEvent.payload.identity,
    ['dev', 'ino'],
    'cleanBasis.admissionBasis.admissionEvent.payload.identity',
  );
  validateExactFrozenRecord(cleanBasis.identity, ['dev', 'ino'], 'cleanBasis.identity');
  const unresolved = validateExactFrozenArray(cleanBasis.unresolved, 'cleanBasis.unresolved');
  const epochObservations = validateExactFrozenArray(
    authority.epochObservations,
    'epochObservations',
  );

  let admissionPayload;
  try {
    admissionPayload = validateFixtureGenesisEvent(admissionEvent);
  } catch (cause) {
    checkpointAuthorityFailure('contains an invalid fixture admission event', cause);
  }
  if (
    admissionBasis.basisKind !== 'stage_b_fixture_genesis'
    || admissionBasis.basisDigest !== admissionEvent.digest
    || cleanBasis.dbKey !== admissionPayload.dbKey
    || cleanBasis.schema !== admissionPayload.schemaVersion
    || cleanBasis.backend !== admissionPayload.backend
    || !Number.isSafeInteger(cleanBasis.finalSeq)
    || cleanBasis.finalSeq < 0
    || cleanBasis.triggerVersion !== admissionPayload.triggerVersion
    || cleanBasis.triggerSetDigest !== admissionPayload.triggerSetDigest
    || cleanBasis.projectInstanceIdSha256 !== admissionPayload.projectInstanceIdSha256
    || canonicalJson(cleanBasis.identity) !== canonicalJson(admissionPayload.identity)
    || !EVENT_DIGEST_PATTERN.test(cleanBasis.latestCleanBasisDigest)
    || unresolved.length !== 0
  ) {
    checkpointAuthorityFailure('clean basis does not match its admission authority');
  }
  for (const epoch of epochObservations) {
    if (
      typeof epoch !== 'string'
      || epoch !== epoch.toLowerCase()
      || !INCARNATION_ID_PATTERN.test(epoch)
    ) {
      checkpointAuthorityFailure('contains an invalid connection epoch observation');
    }
  }
  if (
    snapshot.incarnationId !== incarnationId
    || !INCARNATION_ID_PATTERN.test(snapshot.incarnationId)
    || !Number.isSafeInteger(snapshotTail.seq)
    || snapshotTail.seq <= 0
    || !EVENT_DIGEST_PATTERN.test(snapshotTail.digest)
    || snapshotTail.seq !== evidence.tail.tailSeq
    || snapshotTail.digest !== evidence.tail.tailDigest
    || snapshot.cleanBasisDigest !== evidence.tail.tailDigest
    || cleanBasis.latestCleanBasisDigest !== evidence.tail.tailDigest
  ) {
    checkpointAuthorityFailure('snapshot does not match persistent evidence');
  }
  return authority;
}

function getBoundedControlStoreCheckpointController(facade) {
  const controller = boundedCheckpointControllers.get(facade);
  if (!controller) {
    throw protocolUnsupported(
      'Checkpoint controller requires a bounded facade minted by this module instance',
    );
  }
  return controller;
}

function classifyBoundedMetadata(controlDir) {
  let stats;
  try {
    stats = fs.lstatSync(controlDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        bounded: false,
        checkpointCandidates: [],
        checkpointFinals: [],
        malformedBoundedNames: [],
        tailCandidates: [],
        tailFinal: false,
      };
    }
    throw ioFailure(`inspecting bounded metadata directory ${controlDir}`, error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return {
      bounded: false,
      checkpointCandidates: [],
      checkpointFinals: [],
      malformedBoundedNames: [],
      tailCandidates: [],
      tailFinal: false,
    };
  }

  const names = runIo(
    `listing bounded metadata directory ${controlDir}`,
    () => fs.readdirSync(controlDir),
  );
  const checkpointCandidates = names.filter(
    (name) => BOUNDED_CHECKPOINT_CANDIDATE_PATTERN.test(name),
  );
  const checkpointFinals = names.filter(
    (name) => BOUNDED_CHECKPOINT_FILE_PATTERN.test(name),
  );
  const tailCandidates = names.filter(
    (name) => BOUNDED_TAIL_CANDIDATE_PATTERN.test(name),
  );
  const tailFinal = names.includes(BOUNDED_TAIL_FILE_NAME);
  const malformedBoundedNames = names.filter((name) => {
    const foldedName = name.toLowerCase();
    return (
      (
        foldedName.startsWith('.controlstore-checkpoint-')
        && (foldedName.endsWith('.tmp') || foldedName.endsWith('.json'))
        && !BOUNDED_CHECKPOINT_CANDIDATE_PATTERN.test(name)
        && !BOUNDED_CHECKPOINT_FILE_PATTERN.test(name)
      )
      || (
        foldedName.startsWith('.controlstore-tail-')
        && foldedName.endsWith('.tmp')
        && !BOUNDED_TAIL_CANDIDATE_PATTERN.test(name)
      )
      || (
        foldedName === BOUNDED_TAIL_FILE_NAME
        && name !== BOUNDED_TAIL_FILE_NAME
      )
    );
  });
  return {
    bounded: tailFinal
      || tailCandidates.length > 0
      || checkpointFinals.length > 0
      || checkpointCandidates.length > 0
      || malformedBoundedNames.length > 0,
    checkpointCandidates,
    checkpointFinals,
    malformedBoundedNames,
    tailCandidates,
    tailFinal,
  };
}

function rejectMalformedBoundedMetadata(metadata) {
  if (metadata.malformedBoundedNames.length > 0) {
    throw corrupt(
      `Control store bounded metadata filename is malformed: ${metadata.malformedBoundedNames[0]}`,
    );
  }
}

function invalidEvent(message, cause) {
  return new ControlStoreInvalidEventError(message, cause ? { cause } : undefined);
}

function ioFailure(operation, cause) {
  if (cause?.code === 'CONTROL_STORE_IO') return cause;
  return new ControlStoreIoError(`Control store I/O failed while ${operation}`, { cause });
}

function runIo(operation, action) {
  try {
    return action();
  } catch (cause) {
    throw ioFailure(operation, cause);
  }
}

function attachCleanupError(primaryError, cleanupError) {
  primaryError.cleanupError = cleanupError;
  primaryError.secondaryErrors = [
    ...(primaryError.secondaryErrors || []),
    cleanupError,
  ];
}

function canonicalPath(filePath) {
  const missing = [];
  let existing = path.normalize(path.resolve(filePath));
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const physical = path.join(fs.realpathSync.native(existing), ...missing);
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

function canonicalName(name) {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

function physicalDirectoryIdentity(directory) {
  const stats = fs.lstatSync(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new ControlStoreStaleError(`Control store is not a plain directory: ${directory}`);
  }
  return {
    dev: String(stats.dev),
    ino: String(stats.ino),
    realpath: canonicalPath(fs.realpathSync.native(directory)),
  };
}

function directoryIdentitiesEqual(left, right) {
  return (
    left?.dev === right?.dev
    && left?.ino === right?.ino
    && left?.realpath === right?.realpath
  );
}

function directoryObjectsEqual(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function parseExactJsonFile(filePath, expectedKeys, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw corrupt(`Control store ${label} cannot be read`, cause);
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw corrupt(`Control store ${label} has an inexact schema`);
  }
  return value;
}

function authenticateBoundedCandidate({
  candidatePath,
  expectedKeys,
  label,
  validate,
}) {
  const stats = runIo(
    `inspecting ${label} ${candidatePath}`,
    () => fs.lstatSync(candidatePath),
  );
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw corrupt(`Control store ${label} is not a plain file`);
  }
  const bytes = runIo(
    `reading ${label} ${candidatePath}`,
    () => fs.readFileSync(candidatePath),
  );
  const serialized = bytes.toString('utf8');
  if (!Buffer.from(serialized, 'utf8').equals(bytes)) {
    throw corrupt(`Control store ${label} is not canonical UTF-8`);
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (cause) {
    throw corrupt(`Control store ${label} is not valid JSON`, cause);
  }
  if (
    !isExactObject(value, expectedKeys)
    || serialized !== canonicalJson(value)
  ) {
    throw corrupt(`Control store ${label} does not contain exact canonical bytes`);
  }
  return validate(value);
}

function writeDurableJson(targetPath, value) {
  const parent = path.dirname(targetPath);
  const tempPath = path.join(parent, `.controlstore-activation-${process.pid}-${crypto.randomUUID()}.tmp`);
  let primaryError;
  try {
    fs.writeFileSync(tempPath, canonicalJson(value), { flag: 'wx' });
    fsyncFile(tempPath);
    atomicReplace(tempPath, targetPath);
    fsyncDirectory(parent);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      attachCleanupError(primaryError, cleanupError);
    }
  }
}

function writeDurableJsonIfAbsent(targetPath, value) {
  const parent = path.dirname(targetPath);
  const tempPath = path.join(parent, `.controlstore-incarnation-${crypto.randomUUID()}.tmp`);
  let primaryError;
  try {
    fs.writeFileSync(tempPath, canonicalJson(value), { flag: 'wx' });
    fsyncFile(tempPath);
    // A hard-link publication is atomic and no-clobber on the same filesystem:
    // the immutable incarnation final either remains absent or names the fully
    // synced temp inode. A concurrent/existing final fails with EEXIST.
    fs.linkSync(tempPath, targetPath);
    fs.unlinkSync(tempPath);
    fsyncDirectory(parent);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      attachCleanupError(primaryError, cleanupError);
    }
  }
}

function cleanIncarnationTemps(directory) {
  let removed = false;
  for (const name of fs.readdirSync(directory)) {
    if (!INCARNATION_TEMP_PATTERN.test(name)) continue;
    const tempPath = path.join(directory, name);
    const stats = fs.lstatSync(tempPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ControlStoreStaleError(
        `Control store incarnation temp is not a plain file: ${tempPath}`,
      );
    }
    fs.unlinkSync(tempPath);
    removed = true;
  }
  if (removed) fsyncDirectory(directory);
}

function snapshotJsonValue(value, ancestors, location) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidEvent(`${location} must not contain a non-finite number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw invalidEvent(`${location} contains a non-JSON ${typeof value} value`);
  }
  if (ancestors.has(value)) {
    throw invalidEvent(`${location} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
        throw invalidEvent(`${location} contains a symbol-keyed array property`);
      }
      const snapshot = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw invalidEvent(`${location}[${index}] must be an explicit JSON value`);
        }
        snapshot.push(snapshotJsonValue(
          descriptor.value,
          ancestors,
          `${location}[${index}]`,
        ));
      }
      const extraKey = Object.keys(value).find((key) => {
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key;
      });
      if (extraKey !== undefined) {
        throw invalidEvent(`${location} contains unsupported array property ${extraKey}`);
      }
      return snapshot;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidEvent(`${location} must contain only plain JSON objects`);
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
      throw invalidEvent(`${location} contains a symbol-keyed object property`);
    }

    const snapshot = Object.create(null);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw invalidEvent(`${location}.${key} must be a data property`);
      }
      snapshot[key] = snapshotJsonValue(
        descriptor.value,
        ancestors,
        `${location}.${key}`,
      );
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotInputEvent(inputEvent) {
  try {
    if (
      inputEvent === null
      || typeof inputEvent !== 'object'
      || Array.isArray(inputEvent)
    ) {
      throw invalidEvent('Control store event must be an object');
    }
    const typeDescriptor = Object.getOwnPropertyDescriptor(inputEvent, 'type');
    if (
      !typeDescriptor
      || !Object.prototype.hasOwnProperty.call(typeDescriptor, 'value')
      || typeof typeDescriptor.value !== 'string'
      || typeDescriptor.value.length === 0
    ) {
      throw invalidEvent('Control store event type must be a non-empty string data property');
    }
    const payloadDescriptor = Object.getOwnPropertyDescriptor(inputEvent, 'payload');
    if (!payloadDescriptor || !Object.prototype.hasOwnProperty.call(payloadDescriptor, 'value')) {
      throw invalidEvent('Control store event payload must be an explicit data property');
    }

    const snapshot = {
      type: typeDescriptor.value,
      payload: snapshotJsonValue(payloadDescriptor.value, new Set(), 'event.payload'),
    };
    const afterPredicateDescriptor = Object.getOwnPropertyDescriptor(inputEvent, 'afterPredicate');
    if (afterPredicateDescriptor) {
      if (!Object.prototype.hasOwnProperty.call(afterPredicateDescriptor, 'value')) {
        throw invalidEvent('Control store afterPredicate must be a data property');
      }
      snapshot.afterPredicate = snapshotJsonValue(
        afterPredicateDescriptor.value,
        new Set(),
        'event.afterPredicate',
      );
    }
    return snapshot;
  } catch (error) {
    if (error?.code === 'CONTROL_STORE_INVALID_EVENT') throw error;
    throw invalidEvent('Unable to inspect control store event as strict JSON', error);
  }
}

function canonicalObjectBytes(fieldBytes) {
  return `{${fieldBytes
    .slice()
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, bytes]) => `${JSON.stringify(key)}:${bytes}`)
    .join(',')}}`;
}

function materializeEvent(eventWithoutDigest) {
  const fieldBytes = Object.keys(eventWithoutDigest).map(
    (key) => [key, canonicalJson(eventWithoutDigest[key])],
  );
  const digestSource = canonicalObjectBytes(fieldBytes);
  const digest = crypto.createHash('sha256').update(digestSource).digest('hex');
  const bytes = canonicalObjectBytes([
    ...fieldBytes,
    ['digest', JSON.stringify(digest)],
  ]);
  return { bytes, digest };
}

function casFailed(expectedDigest, actualDigest) {
  const error = new Error(
    `Control store digest mismatch: expected ${String(expectedDigest)}, actual ${String(actualDigest)}`,
  );
  error.code = 'CONTROL_STORE_CAS_FAILED';
  return error;
}

function corrupt(message, cause) {
  return new ControlStoreCorruptError(message, cause ? { cause } : undefined);
}

function validateStoredEventShape(event, name) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw corrupt(`Control store event ${name} must contain a JSON object`);
  }
  const keys = Object.keys(event);
  const requiredKeys = ['digest', 'payload', 'prevDigest', 'seq', 'type'];
  if (
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(event, key))
    || keys.some((key) => !STORED_EVENT_KEYS.has(key))
    || !Number.isSafeInteger(event.seq)
    || event.seq <= 0
    || typeof event.type !== 'string'
    || event.type.length === 0
    || !(event.prevDigest === null || EVENT_DIGEST_PATTERN.test(event.prevDigest))
    || !EVENT_DIGEST_PATTERN.test(event.digest)
  ) {
    throw corrupt(`Control store event ${name} has a malformed event schema`);
  }
}

function validateBoundedProtocolEpoch(value, label) {
  if (!Number.isSafeInteger(value)) {
    throw corrupt(`Control store ${label} protocol epoch is invalid`);
  }
  if (value > BOUNDED_CONTROL_PROTOCOL_EPOCH) {
    throw protocolUnsupported(
      `Control store ${label} protocol epoch ${value} is not supported`,
    );
  }
  if (value !== BOUNDED_CONTROL_PROTOCOL_EPOCH) {
    throw corrupt(`Control store ${label} protocol epoch is invalid`);
  }
}

function validateExactIdentity(identity, label) {
  if (
    !isExactObject(identity, ['dev', 'ino'])
    || typeof identity.dev !== 'string'
    || !/^\d+$/.test(identity.dev)
    || typeof identity.ino !== 'string'
    || !/^\d+$/.test(identity.ino)
  ) {
    throw corrupt(`Control store ${label} identity is invalid`);
  }
}

function validateBoundedTailRecord(tail, expectedIncarnationId) {
  if (
    !EVENT_DIGEST_PATTERN.test(tail.recordDigest)
    || recordDigest(tail, 'recordDigest') !== tail.recordDigest
  ) {
    throw corrupt('Control store bounded tail digest is invalid');
  }
  if (
    tail.version !== 1
    || typeof tail.incarnationId !== 'string'
    || !INCARNATION_ID_PATTERN.test(tail.incarnationId)
    || tail.incarnationId !== expectedIncarnationId
    || !Number.isSafeInteger(tail.coveredSeq)
    || tail.coveredSeq < 0
    || !Number.isSafeInteger(tail.tailSeq)
    || tail.tailSeq < tail.coveredSeq
    || !Number.isSafeInteger(tail.activeEventCount)
    || tail.activeEventCount < 0
    || !Number.isSafeInteger(tail.activeEventBytes)
    || tail.activeEventBytes < 0
    || tail.activeEventCount !== tail.tailSeq - tail.coveredSeq
    || !(tail.coveredDigest === null || EVENT_DIGEST_PATTERN.test(tail.coveredDigest))
    || !(tail.tailDigest === null || EVENT_DIGEST_PATTERN.test(tail.tailDigest))
  ) {
    throw corrupt('Control store bounded tail record is invalid');
  }

  const hasCheckpointFile = tail.checkpointFile !== null;
  const hasCheckpointDigest = tail.checkpointDigest !== null;
  if (hasCheckpointFile !== hasCheckpointDigest) {
    throw corrupt('Control store bounded tail checkpoint reference is incomplete');
  }
  if (!hasCheckpointFile) {
    if (
      tail.coveredSeq !== 0
      || tail.coveredDigest !== null
      || tail.checkpointFile !== null
      || tail.checkpointDigest !== null
    ) {
      throw corrupt('Control store bounded tail has invalid no-checkpoint coverage');
    }
  } else {
    const checkpointMatch = BOUNDED_CHECKPOINT_FILE_PATTERN.exec(tail.checkpointFile);
    if (
      !checkpointMatch
      || Number(checkpointMatch[1]) !== tail.coveredSeq
      || checkpointMatch[2] !== tail.checkpointDigest
      || !EVENT_DIGEST_PATTERN.test(tail.checkpointDigest)
      || tail.coveredSeq <= 0
      || !EVENT_DIGEST_PATTERN.test(tail.coveredDigest)
    ) {
      throw corrupt('Control store bounded tail checkpoint reference is invalid');
    }
  }
  if (
    (tail.tailSeq === 0 && tail.tailDigest !== null)
    || (tail.tailSeq > 0 && !EVENT_DIGEST_PATTERN.test(tail.tailDigest))
    || (tail.tailSeq === tail.coveredSeq && tail.tailDigest !== tail.coveredDigest)
  ) {
    throw corrupt('Control store bounded tail event reference is invalid');
  }
  validateBoundedProtocolEpoch(tail.controlProtocolEpoch, 'bounded tail');
  return tail;
}

function parseBoundedTailFile(tailPath, expectedIncarnationId, label) {
  return validateBoundedTailRecord(
    parseExactJsonFile(tailPath, BOUNDED_TAIL_KEYS, label),
    expectedIncarnationId,
  );
}

function parseBoundedTail(controlDir, expectedIncarnationId) {
  return parseBoundedTailFile(
    path.join(controlDir, BOUNDED_TAIL_FILE_NAME),
    expectedIncarnationId,
    'bounded tail record',
  );
}

function validateFixtureGenesisEvent(event) {
  const keys = ['seq', 'type', 'payload', 'prevDigest', 'digest'];
  if (!isExactObject(event, keys)) {
    throw corrupt('Control store checkpoint admission event has an inexact schema');
  }
  validateStoredEventShape(event, 'checkpoint admission event');
  if (
    event.seq !== 1
    || event.type !== 'sqlite.native.stage_b.fixture_genesis'
    || event.prevDigest !== null
  ) {
    throw corrupt('Control store checkpoint admission event is invalid');
  }
  const { digest, ...withoutDigest } = event;
  if (eventDigest(withoutDigest) !== digest) {
    throw corrupt('Control store checkpoint admission event digest is invalid');
  }

  const payloadKeys = [
    'version',
    'eventId',
    'dbKey',
    'projectInstanceIdSha256',
    'createdAt',
    'ownershipHash',
    'connectionEpoch',
    'fixtureRunId',
    'schemaVersion',
    'backend',
    'finalSeq',
    'gateEmpty',
    'triggerVersion',
    'triggerSetDigest',
    'identity',
  ];
  const payload = event.payload;
  let canonicalTimestamp = false;
  if (typeof payload?.createdAt === 'string') {
    try {
      canonicalTimestamp = new Date(payload.createdAt).toISOString() === payload.createdAt;
    } catch {
      canonicalTimestamp = false;
    }
  }
  if (
    !isExactObject(payload, payloadKeys)
    || payload.version !== 1
    || !INCARNATION_ID_PATTERN.test(payload.eventId)
    || !EVENT_DIGEST_PATTERN.test(payload.dbKey)
    || !EVENT_DIGEST_PATTERN.test(payload.projectInstanceIdSha256)
    || !canonicalTimestamp
    || !EVENT_DIGEST_PATTERN.test(payload.ownershipHash)
    || !INCARNATION_ID_PATTERN.test(payload.connectionEpoch)
    || !INCARNATION_ID_PATTERN.test(payload.fixtureRunId)
    || payload.schemaVersion !== 11
    || payload.backend !== 'native-sqlite-v2'
    || !Number.isSafeInteger(payload.finalSeq)
    || payload.finalSeq < 0
    || payload.gateEmpty !== true
    || payload.triggerVersion !== 1
    || !EVENT_DIGEST_PATTERN.test(payload.triggerSetDigest)
  ) {
    throw corrupt('Control store checkpoint admission payload is invalid');
  }
  validateExactIdentity(payload.identity, 'checkpoint admission');
  return payload;
}

function popcount(bytes) {
  let count = 0;
  for (const byte of bytes) {
    let value = byte;
    while (value !== 0) {
      value &= value - 1;
      count += 1;
    }
  }
  return count;
}

function connectionEpochFilterPositions(basisDigest, connectionEpoch) {
  const domain = Buffer.from('mythpen-controlstore-connection-epoch-v1\0', 'utf8');
  const basis = Buffer.from(basisDigest, 'hex');
  const epoch = Buffer.from(connectionEpoch, 'ascii');
  return Array.from({ length: 7 }, (_unused, index) => {
    const digest = crypto.createHash('sha256').update(Buffer.concat([
      domain,
      Buffer.from([index]),
      basis,
      epoch,
    ])).digest();
    return (((digest[0] << 16) | (digest[1] << 8) | digest[2]) >>> 1);
  });
}

function applyConnectionEpochObservations(checkpoint, epochObservations) {
  const candidate = Buffer.from(
    checkpoint.connectionEpochFilter.bitsBase64,
    'base64',
  );
  for (const epoch of epochObservations) {
    for (const bit of connectionEpochFilterPositions(
      checkpoint.admissionBasis.basisDigest,
      epoch,
    )) {
      candidate[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return candidate;
}

function validateConnectionEpochFilter(filter, coveredSeq, basisDigest, connectionEpoch) {
  const filterKeys = [
    'algorithm',
    'bitCount',
    'hashCount',
    'bitsBase64',
    'epochObservationCount',
  ];
  if (
    !isExactObject(filter, filterKeys)
    || filter.algorithm !== 'sha256-domain-separated-v1'
    || filter.bitCount !== 8_388_608
    || filter.hashCount !== 7
    || typeof filter.bitsBase64 !== 'string'
    || !Number.isSafeInteger(filter.epochObservationCount)
    || filter.epochObservationCount < 1
    || filter.epochObservationCount > coveredSeq
  ) {
    throw corrupt('Control store checkpoint connection epoch filter is invalid');
  }
  const bytes = Buffer.from(filter.bitsBase64, 'base64');
  if (
    bytes.length !== 1_048_576
    || bytes.toString('base64') !== filter.bitsBase64
    || popcount(bytes) > 4_194_304
  ) {
    throw corrupt('Control store checkpoint connection epoch filter encoding is invalid');
  }
  for (const bit of connectionEpochFilterPositions(basisDigest, connectionEpoch)) {
    if ((bytes[bit >>> 3] & (1 << (bit & 7))) === 0) {
      throw corrupt('Control store checkpoint connection epoch filter has a false negative');
    }
  }
}

function checkpointCleanBasisProjection(checkpoint) {
  return {
    admissionBasis: checkpoint.admissionBasis,
    dbKey: checkpoint.dbKey,
    schema: checkpoint.schema,
    backend: checkpoint.backend,
    finalSeq: checkpoint.finalSeq,
    triggerVersion: checkpoint.triggerVersion,
    triggerSetDigest: checkpoint.triggerSetDigest,
    projectInstanceIdSha256: checkpoint.projectInstanceIdSha256,
    identity: checkpoint.identity,
    latestCleanBasisDigest: checkpoint.latestCleanBasisDigest,
    unresolved: checkpoint.unresolved,
  };
}

function cloneCanonicalValue(value) {
  return JSON.parse(canonicalJson(value));
}

function buildBoundedCheckpoint(evidence, authority) {
  const previous = evidence.checkpoint;
  if (previous === null) {
    const firstEvent = evidence.events[0];
    if (
      !firstEvent
      || firstEvent.seq !== 1
      || canonicalJson(firstEvent)
        !== canonicalJson(authority.cleanBasis.admissionBasis.admissionEvent)
    ) {
      checkpointAuthorityFailure(
        'first admission basis does not exactly match persistent sequence one',
      );
    }
  }

  const eventTypeCountMap = new Map(
    Object.entries(previous?.eventTypeCounts || {}),
  );
  for (const event of evidence.events) {
    eventTypeCountMap.set(
      event.type,
      (eventTypeCountMap.get(event.type) || 0) + 1,
    );
  }
  const eventTypeCounts = Object.fromEntries(
    [...eventTypeCountMap.entries()].sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );

  const filterBytes = previous
    ? Buffer.from(previous.connectionEpochFilter.bitsBase64, 'base64')
    : Buffer.alloc(1_048_576);
  for (const epoch of authority.epochObservations) {
    for (const bit of connectionEpochFilterPositions(
      authority.cleanBasis.admissionBasis.basisDigest,
      epoch,
    )) {
      filterBytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  if (popcount(filterBytes) > 4_194_304) {
    throw checkpointBlocked(
      'Control store checkpoint connection epoch filter is over capacity',
    );
  }

  const checkpointWithoutDigest = {
    version: 1,
    controlProtocolEpoch: BOUNDED_CONTROL_PROTOCOL_EPOCH,
    incarnationId: evidence.tail.incarnationId,
    admissionBasis: cloneCanonicalValue(
      previous?.admissionBasis || authority.cleanBasis.admissionBasis,
    ),
    coveredSeq: evidence.tail.tailSeq,
    coveredDigest: evidence.tail.tailDigest,
    chainRoot: cloneCanonicalValue(previous?.chainRoot || {
      seq: 1,
      digest: authority.cleanBasis.admissionBasis.basisDigest,
    }),
    previousCheckpoint: previous
      ? {
          checkpointFile: evidence.tail.checkpointFile,
          checkpointDigest: evidence.tail.checkpointDigest,
          coveredSeq: evidence.tail.coveredSeq,
          coveredDigest: evidence.tail.coveredDigest,
        }
      : null,
    dbKey: authority.cleanBasis.dbKey,
    schema: authority.cleanBasis.schema,
    backend: authority.cleanBasis.backend,
    finalSeq: authority.cleanBasis.finalSeq,
    triggerVersion: authority.cleanBasis.triggerVersion,
    triggerSetDigest: authority.cleanBasis.triggerSetDigest,
    projectInstanceIdSha256: authority.cleanBasis.projectInstanceIdSha256,
    identity: cloneCanonicalValue(authority.cleanBasis.identity),
    latestCleanBasisDigest: authority.cleanBasis.latestCleanBasisDigest,
    eventTypeCounts,
    unresolved: [],
    retryContinuationOpen: false,
    connectionEpochFilter: {
      algorithm: 'sha256-domain-separated-v1',
      bitCount: 8_388_608,
      hashCount: 7,
      bitsBase64: filterBytes.toString('base64'),
      epochObservationCount:
        (previous?.connectionEpochFilter.epochObservationCount || 0)
        + authority.epochObservations.length,
    },
  };
  const checkpoint = {
    ...checkpointWithoutDigest,
    checkpointDigest: recordDigest(checkpointWithoutDigest, 'checkpointDigest'),
  };
  const checkpointFile = `.controlstore-checkpoint-${checkpoint.coveredSeq}-${checkpoint.checkpointDigest}.json`;
  validateBoundedCheckpointRecord(checkpoint, {
    checkpointFile,
    checkpointDigest: checkpoint.checkpointDigest,
    coveredSeq: checkpoint.coveredSeq,
    coveredDigest: checkpoint.coveredDigest,
    incarnationId: checkpoint.incarnationId,
  });
  return { checkpoint, checkpointFile };
}

function validatePreviousCheckpoint(previousCheckpoint, coveredSeq) {
  if (previousCheckpoint === null) return;
  if (
    !isExactObject(previousCheckpoint, [
      'checkpointFile',
      'checkpointDigest',
      'coveredSeq',
      'coveredDigest',
    ])
    || typeof previousCheckpoint.checkpointFile !== 'string'
    || typeof previousCheckpoint.checkpointDigest !== 'string'
    || !EVENT_DIGEST_PATTERN.test(previousCheckpoint.checkpointDigest)
    || !Number.isSafeInteger(previousCheckpoint.coveredSeq)
    || previousCheckpoint.coveredSeq <= 0
    || previousCheckpoint.coveredSeq >= coveredSeq
    || typeof previousCheckpoint.coveredDigest !== 'string'
    || !EVENT_DIGEST_PATTERN.test(previousCheckpoint.coveredDigest)
  ) {
    throw corrupt('Control store checkpoint previous checkpoint descriptor is invalid');
  }
  const filenameMatch = BOUNDED_CHECKPOINT_FILE_PATTERN.exec(
    previousCheckpoint.checkpointFile,
  );
  if (
    !filenameMatch
    || Number(filenameMatch[1]) !== previousCheckpoint.coveredSeq
    || filenameMatch[2] !== previousCheckpoint.checkpointDigest
  ) {
    throw corrupt('Control store checkpoint previous checkpoint filename linkage is invalid');
  }
}

function validateBoundedCheckpointRecord(checkpoint, tail) {
  if (
    !EVENT_DIGEST_PATTERN.test(checkpoint.checkpointDigest)
    || recordDigest(checkpoint, 'checkpointDigest') !== checkpoint.checkpointDigest
    || checkpoint.checkpointDigest !== tail.checkpointDigest
  ) {
    throw corrupt('Control store checkpoint digest is invalid');
  }
  const filenameMatch = BOUNDED_CHECKPOINT_FILE_PATTERN.exec(tail.checkpointFile);
  if (
    !filenameMatch
    || Number(filenameMatch[1]) !== checkpoint.coveredSeq
    || filenameMatch[2] !== checkpoint.checkpointDigest
    || checkpoint.version !== 1
    || checkpoint.incarnationId !== tail.incarnationId
    || !INCARNATION_ID_PATTERN.test(checkpoint.incarnationId)
    || !Number.isSafeInteger(checkpoint.coveredSeq)
    || checkpoint.coveredSeq <= 0
    || checkpoint.coveredSeq !== tail.coveredSeq
    || checkpoint.coveredDigest !== tail.coveredDigest
    || !EVENT_DIGEST_PATTERN.test(checkpoint.coveredDigest)
    || !EVENT_DIGEST_PATTERN.test(checkpoint.dbKey)
    || checkpoint.schema !== 11
    || checkpoint.backend !== 'native-sqlite-v2'
    || !Number.isSafeInteger(checkpoint.finalSeq)
    || checkpoint.finalSeq < 0
    || checkpoint.triggerVersion !== 1
    || !EVENT_DIGEST_PATTERN.test(checkpoint.triggerSetDigest)
    || !EVENT_DIGEST_PATTERN.test(checkpoint.projectInstanceIdSha256)
    || !EVENT_DIGEST_PATTERN.test(checkpoint.latestCleanBasisDigest)
    || !Array.isArray(checkpoint.unresolved)
    || checkpoint.unresolved.length !== 0
    || checkpoint.retryContinuationOpen !== false
  ) {
    throw corrupt('Control store checkpoint record is invalid');
  }
  validatePreviousCheckpoint(checkpoint.previousCheckpoint, checkpoint.coveredSeq);
  validateExactIdentity(checkpoint.identity, 'checkpoint');

  if (
    !isExactObject(checkpoint.chainRoot, ['seq', 'digest'])
    || checkpoint.chainRoot.seq !== 1
    || !EVENT_DIGEST_PATTERN.test(checkpoint.chainRoot.digest)
    || !isExactObject(
      checkpoint.admissionBasis,
      ['basisKind', 'basisDigest', 'admissionEvent'],
    )
    || checkpoint.admissionBasis.basisKind !== 'stage_b_fixture_genesis'
    || !EVENT_DIGEST_PATTERN.test(checkpoint.admissionBasis.basisDigest)
  ) {
    throw corrupt('Control store checkpoint admission basis is invalid');
  }
  const admissionEvent = checkpoint.admissionBasis.admissionEvent;
  const admissionPayload = validateFixtureGenesisEvent(admissionEvent);
  if (
    checkpoint.admissionBasis.basisDigest !== admissionEvent.digest
    || checkpoint.chainRoot.digest !== admissionEvent.digest
    || checkpoint.dbKey !== admissionPayload.dbKey
    || checkpoint.schema !== admissionPayload.schemaVersion
    || checkpoint.backend !== admissionPayload.backend
    || checkpoint.triggerVersion !== admissionPayload.triggerVersion
    || checkpoint.triggerSetDigest !== admissionPayload.triggerSetDigest
    || checkpoint.projectInstanceIdSha256 !== admissionPayload.projectInstanceIdSha256
    || checkpoint.identity.dev !== admissionPayload.identity.dev
    || checkpoint.identity.ino !== admissionPayload.identity.ino
  ) {
    throw corrupt('Control store checkpoint admission basis does not match its summary');
  }

  if (
    checkpoint.eventTypeCounts === null
    || typeof checkpoint.eventTypeCounts !== 'object'
    || Array.isArray(checkpoint.eventTypeCounts)
    || Object.keys(checkpoint.eventTypeCounts).length === 0
    || !Number.isSafeInteger(
      checkpoint.eventTypeCounts['sqlite.native.stage_b.fixture_genesis'],
    )
    || checkpoint.eventTypeCounts['sqlite.native.stage_b.fixture_genesis'] < 1
    || Object.values(checkpoint.eventTypeCounts).some(
      (count) => !Number.isSafeInteger(count) || count <= 0,
    )
    || Object.values(checkpoint.eventTypeCounts).reduce((sum, count) => sum + count, 0)
      !== checkpoint.coveredSeq
  ) {
    throw corrupt('Control store checkpoint event type counts are invalid');
  }
  validateConnectionEpochFilter(
    checkpoint.connectionEpochFilter,
    checkpoint.coveredSeq,
    checkpoint.admissionBasis.basisDigest,
    admissionPayload.connectionEpoch,
  );
  validateBoundedProtocolEpoch(checkpoint.controlProtocolEpoch, 'checkpoint');
  return checkpoint;
}

function parseBoundedCheckpoint(controlDir, tail) {
  if (tail.checkpointFile === null) return null;
  return validateBoundedCheckpointRecord(
    parseExactJsonFile(
      path.join(controlDir, tail.checkpointFile),
      BOUNDED_CHECKPOINT_KEYS,
      'bounded checkpoint',
    ),
    tail,
  );
}

function readBoundedActiveEvents(controlDir, tail, options = {}) {
  const allowSuccessors = options.allowSuccessors === true;
  const allowTailCandidates = options.allowTailCandidates === true;
  const files = [];
  const names = runIo(`listing bounded control store ${controlDir}`, () => fs.readdirSync(controlDir));
  for (const name of names) {
    if (
      name === INCARNATION_FILE_NAME
      || name === WRITER_LOCK_NAME
      || name === BOUNDED_TAIL_FILE_NAME
      || TEMP_FILE_PATTERN.test(name)
      || BOUNDED_CHECKPOINT_FILE_PATTERN.test(name)
    ) {
      continue;
    }
    if (
      BOUNDED_TAIL_CANDIDATE_PATTERN.test(name)
      || BOUNDED_CHECKPOINT_CANDIDATE_PATTERN.test(name)
    ) {
      if (allowTailCandidates && BOUNDED_TAIL_CANDIDATE_PATTERN.test(name)) continue;
      throw recoveryRequired(`Control store has an unresolved bounded candidate: ${name}`);
    }
    if (
      name === SQLITE_RECOVERY_DIR_NAME
      || name === MANUSCRIPT_FILE_ASSETS_DIR_NAME
      || name === MANUSCRIPT_DRAFT_CONFLICT_DIR_NAME
    ) {
      const reservedDirectory = path.join(controlDir, name);
      const label = name === SQLITE_RECOVERY_DIR_NAME
        ? 'recovery'
        : `manuscript ${name}`;
      const stats = runIo(
        `inspecting ${label} directory ${reservedDirectory}`,
        () => fs.lstatSync(reservedDirectory),
      );
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw corrupt(`Control store ${label} entry is not a plain directory: ${name}`);
      }
      continue;
    }
    const match = EVENT_FILE_PATTERN.exec(name);
    if (!match) {
      if (name.endsWith('.json')) {
        throw corrupt(`Control store official filename is malformed: ${name}`);
      }
      throw corrupt(`Unknown control store entry: ${name}`);
    }
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq) || seq <= 0 || String(seq) !== match[1]) {
      throw corrupt(`Control store official filename has an invalid sequence: ${name}`);
    }
    if (seq > tail.coveredSeq) files.push({ digest: match[2], name, seq });
  }
  files.sort((left, right) => left.seq - right.seq);
  const successorFiles = files.filter((file) => file.seq > tail.tailSeq);
  if (successorFiles.length > 0 && !allowSuccessors) {
    throw recoveryRequired('Control store has an unreferenced bounded successor');
  }
  const activeFiles = files.filter((file) => file.seq <= tail.tailSeq);

  const events = [];
  let activeEventBytes = 0;
  for (const [index, file] of activeFiles.entries()) {
    const expectedSeq = tail.coveredSeq + index + 1;
    if (index > 0 && file.seq === files[index - 1].seq) {
      throw corrupt(`Control store has duplicate sequence ${file.seq}`);
    }
    if (file.seq !== expectedSeq) {
      throw corrupt(`Control store bounded suffix has missing sequence ${expectedSeq}`);
    }
    const serialized = runIo(
      `reading event ${file.name}`,
      () => fs.readFileSync(path.join(controlDir, file.name), 'utf8'),
    );
    let event;
    try {
      event = JSON.parse(serialized);
    } catch (cause) {
      throw corrupt(`Control store event ${file.name} is not valid JSON`, cause);
    }
    validateStoredEventShape(event, file.name);
    if (event.seq !== file.seq || event.digest !== file.digest) {
      throw corrupt(`Control store bounded suffix filename differs from event content: ${file.name}`);
    }
    const { digest, ...withoutDigest } = event;
    if (eventDigest(withoutDigest) !== digest) {
      throw corrupt(`Control store event digest cannot be recomputed: ${file.name}`);
    }
    const expectedPrevDigest = events.at(-1)?.digest ?? tail.coveredDigest;
    if (event.prevDigest !== expectedPrevDigest) {
      throw corrupt(`Control store prevDigest chain is broken at sequence ${event.seq}`);
    }
    activeEventBytes += Buffer.byteLength(canonicalJson(event), 'utf8');
    events.push(event);
  }
  if (
    events.length !== tail.activeEventCount
    || activeEventBytes !== tail.activeEventBytes
    || (events.at(-1)?.digest ?? tail.coveredDigest) !== tail.tailDigest
  ) {
    throw corrupt('Control store bounded suffix does not match its persistent tail');
  }
  return events;
}

function parseBoundedTailCandidates(controlDir, metadata, incarnationId) {
  return metadata.tailCandidates.map((name) => ({
    name,
    path: path.join(controlDir, name),
    record: authenticateBoundedCandidate({
      candidatePath: path.join(controlDir, name),
      expectedKeys: BOUNDED_TAIL_KEYS,
      label: `bounded tail candidate ${name}`,
      validate: (record) => validateBoundedTailRecord(record, incarnationId),
    }),
  }));
}

function parseBoundedCheckpointCandidates(controlDir, metadata, incarnationId) {
  return metadata.checkpointCandidates.map((name) => {
    const candidatePath = path.join(controlDir, name);
    const match = BOUNDED_CHECKPOINT_CANDIDATE_PATTERN.exec(name);
    const coveredSeq = Number(match?.[1]);
    return {
      name,
      path: candidatePath,
      record: authenticateBoundedCandidate({
        candidatePath,
        expectedKeys: BOUNDED_CHECKPOINT_KEYS,
        label: `bounded checkpoint candidate ${name}`,
        validate: (checkpoint) => {
          if (!Number.isSafeInteger(coveredSeq) || checkpoint.coveredSeq !== coveredSeq) {
            throw corrupt('Control store checkpoint candidate filename linkage is invalid');
          }
          return validateBoundedCheckpointRecord(checkpoint, {
            checkpointFile: `.controlstore-checkpoint-${checkpoint.coveredSeq}-${checkpoint.checkpointDigest}.json`,
            checkpointDigest: checkpoint.checkpointDigest,
            coveredSeq: checkpoint.coveredSeq,
            coveredDigest: checkpoint.coveredDigest,
            incarnationId,
          });
        },
      }),
    };
  });
}

function boundedArtifactIdentityAndBytes(filePath, label) {
  const stats = runIo(
    `inspecting ${label} ${filePath}`,
    () => fs.lstatSync(filePath, { bigint: true }),
  );
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw corrupt(`Control store ${label} is not a plain file`);
  }
  const bytes = runIo(
    `reading ${label} ${filePath}`,
    () => fs.readFileSync(filePath),
  );
  return { bytes, dev: stats.dev, ino: stats.ino };
}

function parseBoundedCheckpointFinals(controlDir, metadata, incarnationId) {
  return metadata.checkpointFinals.map((name) => {
    const finalPath = path.join(controlDir, name);
    const filenameMatch = BOUNDED_CHECKPOINT_FILE_PATTERN.exec(name);
    const coveredSeq = Number(filenameMatch?.[1]);
    const checkpointDigest = filenameMatch?.[2];
    const record = authenticateBoundedCandidate({
      candidatePath: finalPath,
      expectedKeys: BOUNDED_CHECKPOINT_KEYS,
      label: `bounded checkpoint final ${name}`,
      validate: (checkpoint) => validateBoundedCheckpointRecord(checkpoint, {
        checkpointFile: name,
        checkpointDigest,
        coveredSeq,
        coveredDigest: checkpoint.coveredDigest,
        incarnationId,
      }),
    });
    return {
      name,
      path: finalPath,
      record,
      ...boundedArtifactIdentityAndBytes(
        finalPath,
        `bounded checkpoint final ${name}`,
      ),
    };
  });
}

function parseBoundedCheckpointCandidateEntries(controlDir, metadata, incarnationId) {
  return parseBoundedCheckpointCandidates(controlDir, metadata, incarnationId)
    .map((candidate) => ({
      ...candidate,
      ...boundedArtifactIdentityAndBytes(
        candidate.path,
        `bounded checkpoint candidate ${candidate.name}`,
      ),
    }));
}

function parseBoundedCoveredEventResidues(controlDir, tail, checkpoint) {
  if (tail.coveredSeq === 0) return [];
  const names = runIo(
    `listing covered bounded event residue in ${controlDir}`,
    () => fs.readdirSync(controlDir),
  );
  const entries = [];
  for (const name of names) {
    const match = EVENT_FILE_PATTERN.exec(name);
    if (!match) continue;
    const seq = Number(match[1]);
    if (seq > tail.coveredSeq) continue;
    const eventPath = path.join(controlDir, name);
    const artifact = boundedArtifactIdentityAndBytes(
      eventPath,
      `covered bounded event residue ${name}`,
    );
    const serialized = artifact.bytes.toString('utf8');
    if (!Buffer.from(serialized, 'utf8').equals(artifact.bytes)) {
      throw corrupt(`Control store covered event residue is not canonical UTF-8: ${name}`);
    }
    let event;
    try {
      event = JSON.parse(serialized);
    } catch (cause) {
      throw corrupt(`Control store covered event residue is not valid JSON: ${name}`, cause);
    }
    validateStoredEventShape(event, name);
    const { digest, ...withoutDigest } = event;
    if (
      serialized !== canonicalJson(event)
      || event.seq !== seq
      || event.digest !== match[2]
      || eventDigest(withoutDigest) !== event.digest
    ) {
      throw corrupt(`Control store covered event residue is not exact: ${name}`);
    }
    entries.push({ name, path: eventPath, record: event });
  }
  entries.sort((left, right) => left.record.seq - right.record.seq);
  if (entries.length === 0) return entries;
  for (const [index, entry] of entries.entries()) {
    if (
      index > 0
      && (
        entry.record.seq !== entries[index - 1].record.seq + 1
        || entry.record.prevDigest !== entries[index - 1].record.digest
      )
    ) {
      throw recoveryRequired('Control store covered event residue is not one exact suffix');
    }
  }
  const first = entries[0].record;
  const last = entries.at(-1).record;
  if (
    last.seq !== tail.coveredSeq
    || last.digest !== tail.coveredDigest
    || (first.seq === 1 && first.prevDigest !== null)
    || (
      checkpoint?.previousCheckpoint
      && first.seq === checkpoint.previousCheckpoint.coveredSeq + 1
      && first.prevDigest !== checkpoint.previousCheckpoint.coveredDigest
    )
  ) {
    throw recoveryRequired('Control store covered event residue does not match checkpoint authority');
  }
  return entries;
}

function isCheckpointProposalRecord(record, tail) {
  return (
    record.coveredSeq === tail.tailSeq
    && record.coveredDigest === tail.tailDigest
    && record.coveredSeq > tail.coveredSeq
  );
}

function tailCandidateIntroducesCheckpoint(record, tail) {
  return (
    record.checkpointFile !== tail.checkpointFile
    || record.checkpointDigest !== tail.checkpointDigest
    || record.coveredSeq !== tail.coveredSeq
    || record.coveredDigest !== tail.coveredDigest
  );
}

function tailCandidateActivatesCheckpoint(candidate, final, tail) {
  const record = candidate.record;
  return (
    isCheckpointProposalRecord(final.record, tail)
    && record.checkpointFile === final.name
    && record.checkpointDigest === final.record.checkpointDigest
    && record.coveredSeq === final.record.coveredSeq
    && record.coveredDigest === final.record.coveredDigest
    && record.tailSeq === final.record.coveredSeq
    && record.tailDigest === final.record.coveredDigest
    && record.activeEventCount === 0
    && record.activeEventBytes === 0
  );
}

function checkpointArtifactsShareIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function classifyBoundedCheckpointTopology(controlDir, incarnationId) {
  const metadata = classifyBoundedMetadata(controlDir);
  rejectMalformedBoundedMetadata(metadata);
  if (!metadata.tailFinal) {
    parseBoundedCheckpointFinals(controlDir, metadata, incarnationId);
    return { kind: 'clean', cleanupPaths: [], metadata };
  }

  const tail = parseBoundedTail(controlDir, incarnationId);
  const checkpoint = parseBoundedCheckpoint(controlDir, tail);
  const checkpointCandidates = parseBoundedCheckpointCandidateEntries(
    controlDir,
    metadata,
    incarnationId,
  );
  const checkpointFinals = parseBoundedCheckpointFinals(
    controlDir,
    metadata,
    incarnationId,
  );
  const tailCandidates = parseBoundedTailCandidates(
    controlDir,
    metadata,
    incarnationId,
  );
  const unreferencedFinals = checkpointFinals.filter(
    (entry) => entry.name !== tail.checkpointFile,
  );
  const proposalCandidates = checkpointCandidates.filter(
    (entry) => isCheckpointProposalRecord(entry.record, tail),
  );
  const proposalFinals = unreferencedFinals.filter(
    (entry) => isCheckpointProposalRecord(entry.record, tail),
  );
  const introducedTailCandidates = tailCandidates.filter(
    (entry) => tailCandidateIntroducesCheckpoint(entry.record, tail),
  );
  const coveredEventResidues = parseBoundedCoveredEventResidues(
    controlDir,
    tail,
    checkpoint,
  );
  const hasProposalArtifacts = (
    proposalCandidates.length > 0
    || proposalFinals.length > 0
    || introducedTailCandidates.length > 0
  );

  if (hasProposalArtifacts) {
    if (
      proposalCandidates.length !== checkpointCandidates.length
      || proposalFinals.length !== unreferencedFinals.length
      || coveredEventResidues.length > 0
      || proposalCandidates.length > 1
      || proposalFinals.length > 1
      || introducedTailCandidates.length > 1
    ) {
      throw recoveryRequired('Control store checkpoint proposal topology is ambiguous');
    }
    const candidate = proposalCandidates[0] || null;
    const final = proposalFinals[0] || null;
    const tailCandidate = introducedTailCandidates[0] || null;
    const cleanupPaths = [];
    if (candidate && !final && !tailCandidate) {
      cleanupPaths.push(candidate.path);
    } else if (candidate && final && !tailCandidate) {
      const expectedFinalName = `.controlstore-checkpoint-${candidate.record.coveredSeq}-${candidate.record.checkpointDigest}.json`;
      if (
        final.name !== expectedFinalName
        || canonicalJson(candidate.record) !== canonicalJson(final.record)
        || !candidate.bytes.equals(final.bytes)
        || !checkpointArtifactsShareIdentity(candidate, final)
      ) {
        throw recoveryRequired('Control store checkpoint proposal candidate/final identity is ambiguous');
      }
      cleanupPaths.push(candidate.path, final.path);
    } else if (!candidate && final && !tailCandidate) {
      cleanupPaths.push(final.path);
    } else if (!candidate && final && tailCandidate) {
      if (!tailCandidateActivatesCheckpoint(tailCandidate, final, tail)) {
        throw recoveryRequired('Control store checkpoint proposal tail linkage is ambiguous');
      }
      cleanupPaths.push(tailCandidate.path, final.path);
    } else {
      throw recoveryRequired('Control store checkpoint proposal members are incomplete');
    }
    return {
      kind: 'old-proposal',
      cleanupPaths,
      metadata,
      tail,
    };
  }

  if (checkpointCandidates.length > 0 || introducedTailCandidates.length > 0) {
    throw recoveryRequired('Control store has unresolved checkpoint activation evidence');
  }
  if (tail.checkpointFile === null) {
    if (unreferencedFinals.length > 0 || coveredEventResidues.length > 0) {
      throw recoveryRequired('Control store has unreferenced checkpoint evidence');
    }
    return { kind: 'clean', cleanupPaths: [], metadata, tail };
  }

  const cleanupPaths = coveredEventResidues.map((entry) => entry.path);
  const descriptor = checkpoint.previousCheckpoint;
  if (descriptor === null) {
    if (unreferencedFinals.length > 0) {
      throw recoveryRequired('Control store checkpoint has unexpected predecessor evidence');
    }
  } else {
    const predecessor = unreferencedFinals.find(
      (entry) => entry.name === descriptor.checkpointFile,
    ) || null;
    if (predecessor === null) {
      if (unreferencedFinals.length > 0) {
        throw recoveryRequired('Control store checkpoint predecessor is absent but extra finals exist');
      }
    } else {
      if (
        unreferencedFinals.length !== 1
        || predecessor.record.checkpointDigest !== descriptor.checkpointDigest
        || predecessor.record.coveredSeq !== descriptor.coveredSeq
        || predecessor.record.coveredDigest !== descriptor.coveredDigest
      ) {
        throw recoveryRequired('Control store checkpoint predecessor does not match its descriptor');
      }
      cleanupPaths.push(predecessor.path);
    }
  }
  return {
    kind: cleanupPaths.length > 0 ? 'new-tail-gc' : 'clean',
    cleanupPaths,
    metadata,
    tail,
  };
}

function requireCleanBoundedCheckpointTopology(controlDir, incarnationId) {
  const topology = classifyBoundedCheckpointTopology(controlDir, incarnationId);
  if (topology.cleanupPaths.length > 0) {
    throw recoveryRequired('Control store checkpoint cleanup requires a fresh bounded reopen');
  }
  return topology;
}

function parseBoundedEventCandidates(controlDir, tail) {
  const names = runIo(
    `listing bounded event candidates in ${controlDir}`,
    () => fs.readdirSync(controlDir),
  ).filter((name) => TEMP_FILE_PATTERN.test(name));
  return names.map((name) => {
    const candidatePath = path.join(controlDir, name);
    const stats = runIo(
      `inspecting bounded event candidate ${candidatePath}`,
      () => fs.lstatSync(candidatePath),
    );
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw corrupt(`Control store bounded event candidate is not a plain file: ${name}`);
    }
    const bytes = runIo(
      `reading bounded event candidate ${candidatePath}`,
      () => fs.readFileSync(candidatePath),
    );
    const serialized = bytes.toString('utf8');
    if (!Buffer.from(serialized, 'utf8').equals(bytes)) {
      throw corrupt(`Control store bounded event candidate is not canonical UTF-8: ${name}`);
    }
    let event;
    try {
      event = JSON.parse(serialized);
    } catch (cause) {
      throw corrupt(`Control store bounded event candidate is not valid JSON: ${name}`, cause);
    }
    validateStoredEventShape(event, name);
    const { digest, ...withoutDigest } = event;
    if (
      serialized !== canonicalJson(event)
      || eventDigest(withoutDigest) !== digest
      || event.seq !== tail.tailSeq + 1
      || event.prevDigest !== tail.tailDigest
    ) {
      throw corrupt(`Control store bounded event candidate is not exact for its tail: ${name}`);
    }
    return { name, path: candidatePath, record: event };
  });
}

function readUnreferencedBoundedSuccessors(controlDir, tail) {
  const files = [];
  const names = runIo(
    `listing unreferenced bounded successors in ${controlDir}`,
    () => fs.readdirSync(controlDir),
  );
  for (const name of names) {
    const match = EVENT_FILE_PATTERN.exec(name);
    if (!match) continue;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq) || seq <= tail.tailSeq) continue;
    files.push({ digest: match[2], name, seq });
  }
  files.sort((left, right) => left.seq - right.seq);

  const successors = [];
  try {
    for (const [index, file] of files.entries()) {
      const expectedSeq = tail.tailSeq + index + 1;
      if (file.seq !== expectedSeq) {
        throw corrupt(`Control store unreferenced successor sequence is ambiguous at ${file.name}`);
      }
      const serialized = runIo(
        `reading unreferenced successor ${file.name}`,
        () => fs.readFileSync(path.join(controlDir, file.name), 'utf8'),
      );
      let event;
      try {
        event = JSON.parse(serialized);
      } catch (cause) {
        throw corrupt(`Control store successor ${file.name} is not valid JSON`, cause);
      }
      validateStoredEventShape(event, file.name);
      if (event.seq !== file.seq || event.digest !== file.digest) {
        throw corrupt(`Control store successor filename differs from its event: ${file.name}`);
      }
      const { digest, ...withoutDigest } = event;
      if (eventDigest(withoutDigest) !== digest) {
        throw corrupt(`Control store successor digest cannot be recomputed: ${file.name}`);
      }
      const expectedPrevDigest = successors.at(-1)?.digest ?? tail.tailDigest;
      if (event.prevDigest !== expectedPrevDigest) {
        throw corrupt(`Control store successor prevDigest is ambiguous at ${file.name}`);
      }
      successors.push(event);
    }
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recoveryRequired('Control store unreferenced successor cannot be uniquely proven', cause);
  }
  return successors;
}

function boundedTailAfterSuccessor(tail, successor) {
  const value = {
    version: 1,
    controlProtocolEpoch: BOUNDED_CONTROL_PROTOCOL_EPOCH,
    incarnationId: tail.incarnationId,
    checkpointFile: tail.checkpointFile,
    checkpointDigest: tail.checkpointDigest,
    coveredSeq: tail.coveredSeq,
    coveredDigest: tail.coveredDigest,
    tailSeq: successor.seq,
    tailDigest: successor.digest,
    activeEventCount: tail.activeEventCount + 1,
    activeEventBytes: tail.activeEventBytes
      + Buffer.byteLength(canonicalJson(successor), 'utf8'),
  };
  return {
    ...value,
    recordDigest: recordDigest(value, 'recordDigest'),
  };
}

function readBoundedEvidence(controlDir, incarnationId) {
  const metadata = classifyBoundedMetadata(controlDir);
  parseBoundedTailCandidates(controlDir, metadata, incarnationId);
  parseBoundedCheckpointCandidates(controlDir, metadata, incarnationId);
  if (metadata.tailCandidates.length > 0 || metadata.checkpointCandidates.length > 0) {
    throw recoveryRequired('Control store has unresolved bounded candidate evidence');
  }
  if (!metadata.tailFinal) {
    throw recoveryRequired('Control store bounded tail commit record is missing');
  }
  const tail = parseBoundedTail(controlDir, incarnationId);
  const checkpoint = parseBoundedCheckpoint(controlDir, tail);
  const eventCandidates = parseBoundedEventCandidates(controlDir, tail);
  if (eventCandidates.length > 0) {
    throw recoveryRequired('Control store has unresolved bounded event candidate evidence');
  }
  const events = readBoundedActiveEvents(controlDir, tail);
  return deepFreeze({ checkpoint, events, tail });
}

function writeBoundedTail(controlDir, value, writeState = null, options = null) {
  if (writeState) {
    writeState.cleanupProven = false;
    writeState.publishAttempted = false;
  }
  const record = {
    ...value,
    recordDigest: recordDigest(value, 'recordDigest'),
  };
  const tempPath = path.join(
    controlDir,
    `.controlstore-tail-${crypto.randomUUID()}.tmp`,
  );
  const targetPath = path.join(controlDir, BOUNDED_TAIL_FILE_NAME);
  let primaryError;
  try {
    fs.writeFileSync(tempPath, canonicalJson(record), { flag: 'wx' });
    fsyncFile(tempPath);
    const beforePublishContext = {
      recordDigest: record.recordDigest,
      targetPath,
      tempPath,
    };
    if (options?.operation) beforePublishContext.operation = options.operation;
    faultPoint(FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_PUBLISH, beforePublishContext);
    if (options?.beforeReplace) {
      options.beforeReplace();
    } else if (writeState) {
      writeState.publishAttempted = true;
    }
    atomicReplace(tempPath, targetPath);
    const beforeDirectoryFsyncContext = {
      recordDigest: record.recordDigest,
      targetPath,
    };
    if (options?.operation) beforeDirectoryFsyncContext.operation = options.operation;
    faultPoint(
      FAULT_POINTS.CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC,
      beforeDirectoryFsyncContext,
    );
    fsyncDirectory(controlDir);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
      if (writeState) writeState.cleanupProven = true;
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      attachCleanupError(primaryError, cleanupError);
    }
  }
  return record;
}

function readEvents(controlDir) {
  const files = [];
  const names = runIo(
    `listing ${controlDir}`,
    () => fs.readdirSync(controlDir),
  );
  for (const name of names) {
    if (name === INCARNATION_FILE_NAME) continue;
    if (
      name === SQLITE_RECOVERY_DIR_NAME
      || name === MANUSCRIPT_FILE_ASSETS_DIR_NAME
      || name === MANUSCRIPT_DRAFT_CONFLICT_DIR_NAME
    ) {
      const reservedDirectory = path.join(controlDir, name);
      const label = name === SQLITE_RECOVERY_DIR_NAME
        ? 'recovery'
        : `manuscript ${name}`;
      const stats = runIo(
        `inspecting ${label} directory ${reservedDirectory}`,
        () => fs.lstatSync(reservedDirectory),
      );
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw corrupt(`Control store ${label} entry is not a plain directory: ${name}`);
      }
      continue;
    }
    const match = EVENT_FILE_PATTERN.exec(name);
    if (!match) {
      if (name === WRITER_LOCK_NAME || TEMP_FILE_PATTERN.test(name)) continue;
      if (name.endsWith('.json')) {
        throw corrupt(`Control store official filename is malformed: ${name}`);
      }
      throw corrupt(`Unknown control store entry: ${name}`);
    }

    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq) || seq <= 0 || String(seq) !== match[1]) {
      throw corrupt(`Control store official filename has an invalid sequence: ${name}`);
    }
    files.push({ digest: match[2], name, seq });
  }
  files.sort((left, right) => left.seq - right.seq);

  const events = [];
  for (const [index, file] of files.entries()) {
    const expectedSeq = index + 1;
    if (index > 0 && file.seq === files[index - 1].seq) {
      throw corrupt(`Control store has duplicate sequence ${file.seq}`);
    }
    if (file.seq !== expectedSeq) {
      throw corrupt(`Control store has missing sequence ${expectedSeq}`);
    }

    const serialized = runIo(
      `reading event ${file.name}`,
      () => fs.readFileSync(path.join(controlDir, file.name), 'utf8'),
    );
    let event;
    try {
      event = JSON.parse(serialized);
    } catch (cause) {
      throw corrupt(`Control store event ${file.name} is not valid JSON`, cause);
    }
    validateStoredEventShape(event, file.name);
    if (event.seq !== file.seq) {
      throw corrupt(`Control store filename sequence differs from event content: ${file.name}`);
    }
    if (event.digest !== file.digest) {
      throw corrupt(`Control store filename digest differs from event content: ${file.name}`);
    }

    const { digest, ...eventWithoutDigest } = event;
    if (eventDigest(eventWithoutDigest) !== digest) {
      throw corrupt(`Control store event digest cannot be recomputed: ${file.name}`);
    }

    const expectedPrevDigest = events.at(-1)?.digest ?? null;
    if (event.prevDigest !== expectedPrevDigest) {
      throw corrupt(`Control store prevDigest chain is broken at sequence ${event.seq}`);
    }
    events.push(event);
  }

  return events;
}

function inspectControlStoreEvidence(controlDir) {
  const resolvedDirectory = path.resolve(controlDir);
  let beforeIdentity;
  try {
    beforeIdentity = physicalDirectoryIdentity(resolvedDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        events: [],
        projection: {
          incarnationId: null,
          tail: null,
          checkpoint: null,
          events: [],
        },
      };
    }
    throw error;
  }
  const metadata = classifyBoundedMetadata(resolvedDirectory);

  const incarnation = parseExactJsonFile(
    path.join(resolvedDirectory, INCARNATION_FILE_NAME),
    ['version', 'incarnationId'],
    'incarnation record',
  );
  if (
    incarnation.version !== INCARNATION_VERSION
    || typeof incarnation.incarnationId !== 'string'
    || !INCARNATION_ID_PATTERN.test(incarnation.incarnationId)
  ) {
    throw corrupt('Control store incarnation record is invalid');
  }

  const lifecycleIdentity = canonicalPath(resolvedDirectory);
  const lifecycleParent = path.dirname(lifecycleIdentity);
  const lifecycleHash = crypto.createHash('sha256').update(lifecycleIdentity).digest('hex');
  const activeRecord = parseExactJsonFile(
    path.join(lifecycleParent, `.controlstore-${lifecycleHash}.active.json`),
    ['version', 'path', 'incarnationId', 'identity'],
    'active incarnation record',
  );
  if (
    activeRecord.version !== INCARNATION_VERSION
    || activeRecord.path !== lifecycleIdentity
    || activeRecord.incarnationId !== incarnation.incarnationId
    || !directoryIdentitiesEqual(activeRecord.identity, beforeIdentity)
  ) {
    throw new ControlStoreStaleError(
      `Control store incarnation cannot be proven current: ${resolvedDirectory}`,
    );
  }

  if (metadata.bounded) {
    requireCleanBoundedCheckpointTopology(
      resolvedDirectory,
      incarnation.incarnationId,
    );
  }
  const boundedEvidence = metadata.bounded
    ? readBoundedEvidence(resolvedDirectory, incarnation.incarnationId)
    : null;
  const events = boundedEvidence?.events ?? readEvents(resolvedDirectory);
  const afterIdentity = physicalDirectoryIdentity(resolvedDirectory);
  if (!directoryIdentitiesEqual(beforeIdentity, afterIdentity)) {
    throw new ControlStoreStaleError(
      `Control store identity changed while inspecting: ${resolvedDirectory}`,
    );
  }

  const projectedEvents = events.map(({ seq, type, digest, prevDigest }) => ({
    seq,
    type,
    digest,
    prevDigest,
  }));
  const tail = boundedEvidence
    ? (
      boundedEvidence.tail.tailSeq === 0
        ? null
        : {
          seq: boundedEvidence.tail.tailSeq,
          digest: boundedEvidence.tail.tailDigest,
        }
    )
    : (projectedEvents.at(-1) || null);
  const checkpoint = boundedEvidence?.checkpoint
    ? {
      checkpointDigest: boundedEvidence.checkpoint.checkpointDigest,
      coveredSeq: boundedEvidence.checkpoint.coveredSeq,
      coveredDigest: boundedEvidence.checkpoint.coveredDigest,
      chainRoot: boundedEvidence.checkpoint.chainRoot,
      latestCleanBasisDigest: boundedEvidence.checkpoint.latestCleanBasisDigest,
    }
    : null;
  return {
    events,
    projection: {
      incarnationId: incarnation.incarnationId,
      tail: tail ? { seq: tail.seq, digest: tail.digest } : null,
      checkpoint,
      events: projectedEvents,
    },
  };
}

function inspectControlStore(controlDir) {
  return inspectControlStoreEvidence(controlDir).projection;
}

function openControlStore(controlDir) {
  const bounded = parseOpenOptions(arguments.length, arguments[1]);
  controlDir = path.resolve(controlDir);
  const initialMetadata = classifyBoundedMetadata(controlDir);
  if (!bounded && initialMetadata.bounded) {
    throw protocolUnsupported(
      'Default ControlStore cannot open bounded tail or checkpoint metadata',
    );
  }
  const sourceParent = path.dirname(controlDir);
  const lifecycleIdentity = canonicalPath(controlDir);
  const lifecycleParent = path.dirname(lifecycleIdentity);
  const lifecycleHash = crypto.createHash('sha256').update(lifecycleIdentity).digest('hex');
  const lifecycleLeasePath = path.join(
    lifecycleParent,
    `.controlstore-${lifecycleHash}.lifecycle.lock`,
  );
  const activeRecordPath = path.join(
    lifecycleParent,
    `.controlstore-${lifecycleHash}.active.json`,
  );
  runIo(
    `creating control parent ${sourceParent}`,
    () => fs.mkdirSync(sourceParent, { recursive: true }),
  );

  function withLease(lockPath, label, action) {
    let lease;
    try {
      lease = acquireExclusiveLease(lockPath);
    } catch (error) {
      if (error?.code === 'LEASE_BUSY') throw error;
      throw ioFailure(`acquiring the ${label} lease`, error);
    }
    let primaryError;
    try {
      return action();
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        runIo(`releasing the ${label} lease`, () => lease.release());
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        attachCleanupError(primaryError, cleanupError);
      }
    }
  }

  function withLifecycleLease(action) {
    return withLease(lifecycleLeasePath, 'lifecycle', action);
  }

  function readIncarnationId(directory = controlDir) {
    const record = parseExactJsonFile(
      path.join(directory, INCARNATION_FILE_NAME),
      ['version', 'incarnationId'],
      'incarnation record',
    );
    if (
      record.version !== INCARNATION_VERSION
      || typeof record.incarnationId !== 'string'
      || !INCARNATION_ID_PATTERN.test(record.incarnationId)
    ) {
      throw corrupt('Control store incarnation record is invalid');
    }
    return record.incarnationId;
  }

  function readActiveRecord() {
    const record = parseExactJsonFile(
      activeRecordPath,
      ['version', 'path', 'incarnationId', 'identity'],
      'active incarnation record',
    );
    if (
      record.version !== INCARNATION_VERSION
      || record.path !== lifecycleIdentity
      || typeof record.incarnationId !== 'string'
      || !INCARNATION_ID_PATTERN.test(record.incarnationId)
      || record.identity === null
      || typeof record.identity !== 'object'
      || Array.isArray(record.identity)
      || Object.keys(record.identity).length !== 3
      || !['dev', 'ino', 'realpath'].every(
        (key) => typeof record.identity[key] === 'string',
      )
    ) {
      throw corrupt('Control store active incarnation record is invalid');
    }
    return record;
  }

  function isPristineReplacementDirectory() {
    const names = runIo(
      `listing replacement control directory ${controlDir}`,
      () => fs.readdirSync(controlDir),
    );
    return names.length === 1 && names[0] === INCARNATION_FILE_NAME;
  }

  function activeIncarnationWasRetired(activeRecord) {
    const controlName = path.basename(controlDir);
    const names = runIo(
      `listing control parent ${sourceParent}`,
      () => fs.readdirSync(sourceParent),
    );
    for (const name of names) {
      if (!canonicalName(name).startsWith(canonicalName(controlName))) continue;
      const suffix = name.slice(controlName.length);
      if (!RETIRED_DIRECTORY_SUFFIX_PATTERN.test(suffix)) continue;
      const retiredDirectory = path.join(sourceParent, name);
      let identity;
      try {
        identity = physicalDirectoryIdentity(retiredDirectory);
      } catch {
        continue;
      }
      // A successful retirement preserves the directory object while changing
      // its real path, so dev/ino are the exact continuity proof here.
      if (!directoryObjectsEqual(identity, activeRecord.identity)) continue;
      return readIncarnationId(retiredDirectory) === activeRecord.incarnationId;
    }
    return false;
  }

  function activateControlDirectory() {
    try {
      const existing = fs.lstatSync(controlDir);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new ControlStoreStaleError(`Control store path is not a plain directory: ${controlDir}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      runIo(`creating directory ${controlDir}`, () => fs.mkdirSync(controlDir));
      fsyncDirectory(sourceParent);
    }

    runIo(
      `cleaning incarnation publication temps in ${controlDir}`,
      () => cleanIncarnationTemps(controlDir),
    );
    const incarnationPath = path.join(controlDir, INCARNATION_FILE_NAME);
    let incarnationId;
    if (fs.existsSync(incarnationPath)) {
      incarnationId = readIncarnationId();
    } else {
      incarnationId = crypto.randomUUID();
      runIo(
        `creating incarnation record ${incarnationPath}`,
        () => writeDurableJsonIfAbsent(incarnationPath, {
          version: INCARNATION_VERSION,
          incarnationId,
        }),
      );
    }

    const identity = physicalDirectoryIdentity(controlDir);
    let activeRecord = null;
    if (fs.existsSync(activeRecordPath)) activeRecord = readActiveRecord();
    const exactActive = (
      activeRecord?.incarnationId === incarnationId
      && directoryIdentitiesEqual(activeRecord.identity, identity)
    );
    const resumableActivation = (
      activeRecord
      && !exactActive
      && isPristineReplacementDirectory()
      && activeIncarnationWasRetired(activeRecord)
    );
    if (activeRecord && !exactActive && !resumableActivation) {
      throw new ControlStoreStaleError(
        `Control store active incarnation differs from ${incarnationId}`,
      );
    }
    if (!exactActive) {
      runIo(`activating control store ${controlDir}`, () => writeDurableJson(activeRecordPath, {
        version: INCARNATION_VERSION,
        path: lifecycleIdentity,
        incarnationId,
        identity,
      }));
    } else {
      runIo(
        `syncing active control store ${controlDir}`,
        () => fsyncDirectory(lifecycleParent),
      );
    }
    return { incarnationId, identity };
  }

  function captureExistingControlDirectory() {
    const beforeIdentity = physicalDirectoryIdentity(controlDir);
    const incarnationId = readIncarnationId();
    const activeRecord = readActiveRecord();
    const afterIdentity = physicalDirectoryIdentity(controlDir);
    if (
      activeRecord.incarnationId !== incarnationId
      || !directoryIdentitiesEqual(beforeIdentity, afterIdentity)
      || !directoryIdentitiesEqual(activeRecord.identity, beforeIdentity)
    ) {
      throw new ControlStoreStaleError(
        `Control store incarnation cannot be captured exactly: ${controlDir}`,
      );
    }
    return { incarnationId, identity: beforeIdentity };
  }

  const captured = withLifecycleLease(() => {
    const leaseMetadata = classifyBoundedMetadata(controlDir);
    if (!bounded && leaseMetadata.bounded) {
      throw protocolUnsupported(
        'Default ControlStore cannot open bounded tail or checkpoint metadata',
      );
    }
    if (bounded && leaseMetadata.bounded) {
      return captureExistingControlDirectory();
    }
    return activateControlDirectory();
  });
  let boundedFenced = false;

  function assertBoundedNotFenced() {
    if (boundedFenced) {
      throw new ControlStoreFencedError('Bounded ControlStore facade is fenced');
    }
  }

  function addSecondaryError(primaryError, secondaryError) {
    primaryError.secondaryErrors = [
      ...(primaryError.secondaryErrors || []),
      secondaryError,
    ];
  }

  function failBoundedUncertain(message, primaryError, secondaryErrors = []) {
    boundedFenced = true;
    const error = recoveryRequired(message, primaryError);
    if (secondaryErrors.length > 0) error.secondaryErrors = [...secondaryErrors];
    throw error;
  }

  function postcheckInstalledBoundedEvidence(turn, message, action) {
    turn.installed = true;
    try {
      return action();
    } catch (cause) {
      return failBoundedUncertain(message, cause);
    }
  }

  function assertCurrentUnlocked() {
    let actualIdentity;
    try {
      actualIdentity = physicalDirectoryIdentity(controlDir);
    } catch (cause) {
      if (cause?.code === 'CONTROL_STORE_STALE') throw cause;
      throw new ControlStoreStaleError(`Control store incarnation is no longer active: ${controlDir}`, { cause });
    }
    let incarnationId;
    let activeRecord;
    try {
      incarnationId = readIncarnationId();
      activeRecord = readActiveRecord();
    } catch (cause) {
      throw new ControlStoreStaleError(`Control store incarnation cannot be proven current: ${controlDir}`, { cause });
    }
    if (
      incarnationId !== captured.incarnationId
      || activeRecord.incarnationId !== captured.incarnationId
      || !directoryIdentitiesEqual(actualIdentity, captured.identity)
      || !directoryIdentitiesEqual(activeRecord.identity, captured.identity)
    ) {
      throw new ControlStoreStaleError(`Control store incarnation is stale: ${controlDir}`);
    }
  }

  function withWriterLease(action) {
    return withLifecycleLease(() => {
      assertCurrentUnlocked();
      return withLease(
        path.join(controlDir, WRITER_LOCK_NAME),
        'writer',
        action,
      );
    });
  }

  function acquireBoundedLease(lockPath, label) {
    try {
      return acquireExclusiveLease(lockPath);
    } catch (error) {
      if (error?.code === 'LEASE_BUSY') throw error;
      throw ioFailure(`acquiring the ${label} lease`, error);
    }
  }

  function releaseBoundedLease(lease, label) {
    if (!lease) return null;
    try {
      runIo(`releasing the ${label} lease`, () => lease.release());
      return null;
    } catch (error) {
      return error;
    }
  }

  function withBoundedWriterTurn(action) {
    assertBoundedNotFenced();
    let lifecycleLease;
    let writerLease;
    let primaryError;
    let result;
    const turn = { installed: false };

    try {
      lifecycleLease = acquireBoundedLease(lifecycleLeasePath, 'lifecycle');
      assertCurrentUnlocked();
      writerLease = acquireBoundedLease(
        path.join(controlDir, WRITER_LOCK_NAME),
        'writer',
      );
      result = action(turn);
    } catch (error) {
      primaryError = error;
    }

    const releaseErrors = [];
    const writerReleaseError = releaseBoundedLease(writerLease, 'writer');
    if (writerReleaseError) releaseErrors.push(writerReleaseError);
    const lifecycleReleaseError = releaseBoundedLease(lifecycleLease, 'lifecycle');
    if (lifecycleReleaseError) releaseErrors.push(lifecycleReleaseError);

    if (primaryError) {
      for (const releaseError of releaseErrors) {
        if (primaryError.code === 'RECOVERY_REQUIRED') {
          addSecondaryError(primaryError, releaseError);
        } else {
          attachCleanupError(primaryError, releaseError);
        }
      }
      throw primaryError;
    }
    if (releaseErrors.length > 0) {
      if (turn.installed) {
        failBoundedUncertain(
          'Bounded ControlStore evidence was installed but lease release is uncertain',
          releaseErrors[0],
          releaseErrors.slice(1),
        );
      }
      const [releaseError, ...additionalReleaseErrors] = releaseErrors;
      for (const additionalReleaseError of additionalReleaseErrors) {
        attachCleanupError(releaseError, additionalReleaseError);
      }
      throw releaseError;
    }
    return result;
  }

  function withCheckpointWriterTurn(action) {
    assertBoundedNotFenced();
    let lifecycleLease;
    let writerLease;
    let primaryError;
    let result;
    const turn = {
      authorityMutationAttempted: false,
      externalRecoveryObserved: false,
      installed: false,
      mutationDispositionUnknown: false,
    };

    try {
      lifecycleLease = acquireBoundedLease(lifecycleLeasePath, 'lifecycle');
      assertCurrentUnlocked();
      writerLease = acquireBoundedLease(
        path.join(controlDir, WRITER_LOCK_NAME),
        'writer',
      );
      result = action(turn);
    } catch (error) {
      primaryError = error;
    }

    const releaseErrors = [];
    const writerReleaseError = releaseBoundedLease(writerLease, 'writer');
    if (writerReleaseError) releaseErrors.push(writerReleaseError);
    const lifecycleReleaseError = releaseBoundedLease(lifecycleLease, 'lifecycle');
    if (lifecycleReleaseError) releaseErrors.push(lifecycleReleaseError);
    const uncertain = (
      turn.authorityMutationAttempted
      || turn.externalRecoveryObserved
      || turn.installed
      || turn.mutationDispositionUnknown
    );

    if (primaryError) {
      let reportedError = primaryError;
      if (uncertain) {
        boundedFenced = true;
        if (
          !turn.externalRecoveryObserved
          && !mintedRecoveryRequiredErrors.has(primaryError)
        ) {
          reportedError = recoveryRequired(
            'Control store checkpoint installation disposition is uncertain',
            primaryError,
          );
        }
      }
      for (const releaseError of releaseErrors) {
        if (reportedError.code === 'RECOVERY_REQUIRED') {
          addSecondaryError(reportedError, releaseError);
        } else {
          attachCleanupError(reportedError, releaseError);
        }
      }
      throw reportedError;
    }

    if (releaseErrors.length > 0) {
      if (uncertain) {
        boundedFenced = true;
        const [firstReleaseError, ...additionalReleaseErrors] = releaseErrors;
        const error = recoveryRequired(
          'Control store checkpoint evidence was installed but lease release is uncertain',
          firstReleaseError,
        );
        for (const additionalReleaseError of additionalReleaseErrors) {
          addSecondaryError(error, additionalReleaseError);
        }
        throw error;
      }
      const [releaseError, ...additionalReleaseErrors] = releaseErrors;
      for (const additionalReleaseError of additionalReleaseErrors) {
        attachCleanupError(releaseError, additionalReleaseError);
      }
      throw releaseError;
    }
    return result;
  }

  function appendAfter(events, inputEvent) {
    const inputSnapshot = snapshotInputEvent(inputEvent);
    const previous = events.at(-1) || null;
    const seq = previous ? previous.seq + 1 : 1;
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw invalidEvent('Control store sequence exceeds the safe integer range');
    }
    const eventWithoutDigest = {
      seq,
      type: inputSnapshot.type,
      payload: inputSnapshot.payload,
      prevDigest: previous ? previous.digest : null,
    };
    if (Object.prototype.hasOwnProperty.call(inputSnapshot, 'afterPredicate')) {
      eventWithoutDigest.afterPredicate = inputSnapshot.afterPredicate;
    }
    const { bytes, digest } = materializeEvent(eventWithoutDigest);
    const targetPath = path.join(controlDir, `${seq}-${digest}.json`);
    const tempPath = path.join(
      controlDir,
      `.controlstore-${process.pid}-${crypto.randomUUID()}.tmp`,
    );

    let primaryError;
    try {
      runIo(`writing temp event ${tempPath}`, () => fs.writeFileSync(tempPath, bytes));
      runIo(`syncing temp event ${tempPath}`, () => fsyncFile(tempPath));
      faultPoint(FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH, {
        digest,
        seq,
        targetPath,
        tempPath,
      });
      runIo(
        `publishing event ${targetPath}`,
        () => atomicReplace(tempPath, targetPath),
      );
      faultPoint(FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC, {
        digest,
        seq,
        targetPath,
      });
      runIo(`syncing directory ${controlDir}`, () => fsyncDirectory(controlDir));
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        runIo(
          `cleaning temp event ${tempPath}`,
          () => fs.rmSync(tempPath, { force: true }),
        );
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        attachCleanupError(primaryError, cleanupError);
      }
    }

    return { seq, digest };
  }

  function cleanupBoundedTemp(tempPath, label) {
    try {
      runIo(`cleaning ${label} ${tempPath}`, () => fs.rmSync(tempPath, { force: true }));
      return null;
    } catch (error) {
      return error;
    }
  }

  function checkpointValidationTail(checkpointFile, checkpoint) {
    return {
      checkpointFile,
      checkpointDigest: checkpoint.checkpointDigest,
      coveredSeq: checkpoint.coveredSeq,
      coveredDigest: checkpoint.coveredDigest,
      incarnationId: checkpoint.incarnationId,
    };
  }

  function authenticateInstalledCheckpoint(checkpointFile, expectedCheckpoint) {
    const finalPath = path.join(controlDir, checkpointFile);
    const parsed = authenticateBoundedCandidate({
      candidatePath: finalPath,
      expectedKeys: BOUNDED_CHECKPOINT_KEYS,
      label: `installed checkpoint final ${checkpointFile}`,
      validate: (checkpoint) => validateBoundedCheckpointRecord(
        checkpoint,
        checkpointValidationTail(checkpointFile, expectedCheckpoint),
      ),
    });
    if (canonicalJson(parsed) !== canonicalJson(expectedCheckpoint)) {
      throw corrupt('Installed checkpoint final differs from its synthetic authority');
    }
    return parsed;
  }

  function cleanupCheckpointPublication(
    candidatePath,
    finalPath,
    removeFinal,
    primaryError,
    turn,
  ) {
    const cleanupErrors = [];
    for (const targetPath of [candidatePath, ...(removeFinal ? [finalPath] : [])]) {
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } catch (cleanupError) {
        cleanupErrors.push(ioFailure(`cleaning checkpoint publication ${targetPath}`, cleanupError));
      }
    }
    try {
      fsyncDirectory(controlDir);
    } catch (cleanupError) {
      cleanupErrors.push(ioFailure('syncing checkpoint publication cleanup', cleanupError));
    }
    if (cleanupErrors.length > 0) turn.mutationDispositionUnknown = true;
    const mapped = ioFailure('publishing checkpoint final', primaryError);
    for (const cleanupError of cleanupErrors) attachCleanupError(mapped, cleanupError);
    throw mapped;
  }

  function publishCheckpointFinal(build, turn) {
    const candidatePath = path.join(
      controlDir,
      `.controlstore-checkpoint-${build.checkpoint.coveredSeq}-${crypto.randomUUID()}.tmp`,
    );
    const finalPath = path.join(controlDir, build.checkpointFile);
    let finalLinked = false;
    try {
      fs.writeFileSync(candidatePath, canonicalJson(build.checkpoint), { flag: 'wx' });
      fsyncFile(candidatePath);
      faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH, {
        candidatePath,
        checkpointFile: build.checkpointFile,
        finalPath,
      });
      try {
        fs.linkSync(candidatePath, finalPath);
        finalLinked = true;
      } catch (cause) {
        if (cause?.code === 'EEXIST') turn.mutationDispositionUnknown = true;
        throw cause;
      }
      faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK, {
        candidatePath,
        checkpointFile: build.checkpointFile,
        finalPath,
      });
      fs.unlinkSync(candidatePath);
      faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC, {
        checkpointFile: build.checkpointFile,
        finalPath,
      });
      fsyncDirectory(controlDir);
      faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC, {
        checkpointFile: build.checkpointFile,
        finalPath,
      });
      return authenticateInstalledCheckpoint(build.checkpointFile, build.checkpoint);
    } catch (cause) {
      cleanupCheckpointPublication(
        candidatePath,
        finalPath,
        finalLinked,
        cause,
        turn,
      );
    }
  }

  function activateCheckpointTail(build, turn) {
    const tailValue = {
      version: 1,
      controlProtocolEpoch: BOUNDED_CONTROL_PROTOCOL_EPOCH,
      incarnationId: build.checkpoint.incarnationId,
      checkpointFile: build.checkpointFile,
      checkpointDigest: build.checkpoint.checkpointDigest,
      coveredSeq: build.checkpoint.coveredSeq,
      coveredDigest: build.checkpoint.coveredDigest,
      tailSeq: build.checkpoint.coveredSeq,
      tailDigest: build.checkpoint.coveredDigest,
      activeEventCount: 0,
      activeEventBytes: 0,
    };
    let installedTail;
    try {
      installedTail = writeBoundedTail(controlDir, tailValue, null, {
        operation: 'checkpoint-activation',
        beforeReplace() {
          turn.authorityMutationAttempted = true;
        },
      });
    } catch (cause) {
      throw ioFailure('publishing checkpoint activation tail', cause);
    }
    const postcheck = readBoundedEvidence(controlDir, captured.incarnationId);
    if (
      canonicalJson(postcheck.tail) !== canonicalJson(installedTail)
      || canonicalJson(postcheck.checkpoint) !== canonicalJson(build.checkpoint)
      || postcheck.events.length !== 0
    ) {
      throw corrupt('Installed checkpoint tail failed exact activation postcheck');
    }
    turn.installed = true;
    return installedTail;
  }

  function cleanupUnactivatedCheckpointFinal(build, primaryError, turn) {
    const finalPath = path.join(controlDir, build.checkpointFile);
    const cleanupErrors = [];
    try {
      fs.unlinkSync(finalPath);
    } catch (cleanupError) {
      cleanupErrors.push(ioFailure(`cleaning unactivated checkpoint final ${finalPath}`, cleanupError));
    }
    try {
      fsyncDirectory(controlDir);
    } catch (cleanupError) {
      cleanupErrors.push(ioFailure('syncing unactivated checkpoint cleanup', cleanupError));
    }
    if (cleanupErrors.length > 0) {
      turn.mutationDispositionUnknown = true;
      for (const cleanupError of cleanupErrors) attachCleanupError(primaryError, cleanupError);
    }
    throw primaryError;
  }

  function validateCheckpointPredecessor(build, evidence) {
    const descriptor = build.checkpoint.previousCheckpoint;
    if (descriptor === null) return null;
    const predecessorPath = path.join(controlDir, descriptor.checkpointFile);
    const predecessor = authenticateBoundedCandidate({
      candidatePath: predecessorPath,
      expectedKeys: BOUNDED_CHECKPOINT_KEYS,
      label: `checkpoint predecessor ${descriptor.checkpointFile}`,
      validate: (checkpoint) => validateBoundedCheckpointRecord(checkpoint, {
        checkpointFile: descriptor.checkpointFile,
        checkpointDigest: descriptor.checkpointDigest,
        coveredSeq: descriptor.coveredSeq,
        coveredDigest: descriptor.coveredDigest,
        incarnationId: build.checkpoint.incarnationId,
      }),
    });
    if (canonicalJson(predecessor) !== canonicalJson(evidence.checkpoint)) {
      throw recoveryRequired('Checkpoint predecessor differs from installation-time authority');
    }
    return predecessorPath;
  }

  function garbageCollectInstalledCheckpoint(build, evidence, installedTail) {
    const predecessorPath = validateCheckpointPredecessor(build, evidence);
    faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC, {
      checkpointFile: build.checkpointFile,
      coveredSeq: build.checkpoint.coveredSeq,
    });
    for (const event of evidence.events) {
      const entryName = `${event.seq}-${event.digest}.json`;
      const eventPath = path.join(controlDir, entryName);
      if (
        path.dirname(eventPath) !== controlDir
        || !EVENT_FILE_PATTERN.test(entryName)
      ) {
        throw corrupt('Checkpoint GC event target is not an exact official basename');
      }
      runIo(`deleting covered checkpoint event ${entryName}`, () => fs.unlinkSync(eventPath));
      faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY, {
        entryKind: 'event',
        entryName,
      });
    }
    if (predecessorPath) {
      const entryName = path.basename(predecessorPath);
      if (
        path.dirname(predecessorPath) !== controlDir
        || entryName !== build.checkpoint.previousCheckpoint.checkpointFile
      ) {
        throw corrupt('Checkpoint GC predecessor target is not its exact descriptor basename');
      }
      runIo(`deleting checkpoint predecessor ${entryName}`, () => fs.unlinkSync(predecessorPath));
      faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY, {
        entryKind: 'old-checkpoint',
        entryName,
      });
    }
    faultPoint(FAULT_POINTS.CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC, {
      checkpointFile: build.checkpointFile,
      coveredSeq: build.checkpoint.coveredSeq,
    });
    runIo('syncing installed checkpoint GC', () => fsyncDirectory(controlDir));

    const finalEvidence = readBoundedEvidence(controlDir, captured.incarnationId);
    if (
      canonicalJson(finalEvidence.tail) !== canonicalJson(installedTail)
      || canonicalJson(finalEvidence.checkpoint) !== canonicalJson(build.checkpoint)
      || finalEvidence.events.length !== 0
    ) {
      throw corrupt('Installed checkpoint failed final evidence verification');
    }
  }

  function appendBounded(inputEvent, expectedDigest, compare, turn) {
    const evidence = readBoundedEvidence(controlDir, captured.incarnationId);
    const persistentDigest = evidence.tail.tailDigest;
    if (compare && expectedDigest !== persistentDigest) {
      throw casFailed(expectedDigest, persistentDigest);
    }

    const inputSnapshot = snapshotInputEvent(inputEvent);
    const seq = evidence.tail.tailSeq + 1;
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw invalidEvent('Control store sequence exceeds the safe integer range');
    }
    const eventWithoutDigest = {
      seq,
      type: inputSnapshot.type,
      payload: inputSnapshot.payload,
      prevDigest: persistentDigest,
    };
    if (Object.prototype.hasOwnProperty.call(inputSnapshot, 'afterPredicate')) {
      eventWithoutDigest.afterPredicate = inputSnapshot.afterPredicate;
    }
    const { bytes, digest } = materializeEvent(eventWithoutDigest);
    const eventByteLength = Buffer.byteLength(bytes, 'utf8');
    const nextActiveEventBytes = evidence.tail.activeEventBytes + eventByteLength;
    if (!Number.isSafeInteger(nextActiveEventBytes)) {
      throw invalidEvent('Control store active event bytes exceed the safe integer range');
    }
    const targetPath = path.join(controlDir, `${seq}-${digest}.json`);
    const tempPath = path.join(
      controlDir,
      `.controlstore-${process.pid}-${crypto.randomUUID()}.tmp`,
    );

    let eventMayBePublished = false;
    let eventPublishError = null;
    try {
      runIo(`writing bounded temp event ${tempPath}`, () => fs.writeFileSync(tempPath, bytes));
      runIo(`syncing bounded temp event ${tempPath}`, () => fsyncFile(tempPath));
      faultPoint(FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH, {
        digest,
        seq,
        targetPath,
        tempPath,
      });
      eventMayBePublished = true;
      runIo(`publishing bounded event ${targetPath}`, () => atomicReplace(tempPath, targetPath));
      faultPoint(FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC, {
        digest,
        seq,
        targetPath,
      });
      runIo(`syncing bounded event directory ${controlDir}`, () => fsyncDirectory(controlDir));
    } catch (error) {
      eventPublishError = ioFailure('publishing a bounded event', error);
    }
    const eventCleanupError = cleanupBoundedTemp(tempPath, 'bounded event temp');
    if (eventPublishError) {
      if (!eventMayBePublished && !eventCleanupError) throw eventPublishError;
      failBoundedUncertain(
        'Bounded event publication may have installed an uncommitted successor',
        eventPublishError,
        eventCleanupError ? [eventCleanupError] : [],
      );
    }
    if (eventCleanupError) {
      failBoundedUncertain(
        'Bounded event was published but temp cleanup is uncertain',
        eventCleanupError,
      );
    }

    const nextTailValue = {
      version: 1,
      controlProtocolEpoch: BOUNDED_CONTROL_PROTOCOL_EPOCH,
      incarnationId: evidence.tail.incarnationId,
      checkpointFile: evidence.tail.checkpointFile,
      checkpointDigest: evidence.tail.checkpointDigest,
      coveredSeq: evidence.tail.coveredSeq,
      coveredDigest: evidence.tail.coveredDigest,
      tailSeq: seq,
      tailDigest: digest,
      activeEventCount: evidence.tail.activeEventCount + 1,
      activeEventBytes: nextActiveEventBytes,
    };
    let installedTail;
    try {
      installedTail = writeBoundedTail(controlDir, nextTailValue);
    } catch (error) {
      failBoundedUncertain(
        'Bounded event was published but persistent tail installation is uncertain',
        ioFailure('publishing the bounded persistent tail', error),
      );
    }

    let postcheck;
    try {
      postcheck = readBoundedEvidence(controlDir, captured.incarnationId);
      const appendedEvent = postcheck.events.at(-1);
      if (
        canonicalJson(postcheck.tail) !== canonicalJson(installedTail)
        || appendedEvent?.seq !== seq
        || appendedEvent?.digest !== digest
        || appendedEvent?.prevDigest !== persistentDigest
      ) {
        throw corrupt('Bounded append postcheck does not match the installed event and tail');
      }
    } catch (error) {
      failBoundedUncertain(
        'Bounded append postcheck could not prove the installed event and tail',
        error,
      );
    }

    turn.installed = true;
    return { seq, digest };
  }

  function publishExistingTailCandidate(candidate, turn) {
    try {
      runIo(`syncing bounded tail candidate ${candidate.path}`, () => fsyncFile(candidate.path));
      runIo(
        `publishing bounded tail candidate ${candidate.path}`,
        () => atomicReplace(
          candidate.path,
          path.join(controlDir, BOUNDED_TAIL_FILE_NAME),
        ),
      );
      runIo(`syncing reconciled bounded directory ${controlDir}`, () => fsyncDirectory(controlDir));
    } catch (cause) {
      throw recoveryRequired('Control store tail candidate publication is uncertain', cause);
    }
    return postcheckInstalledBoundedEvidence(
      turn,
      'Control store published tail candidate failed exact postcheck',
      () => {
        const evidence = readBoundedEvidence(controlDir, captured.incarnationId);
        if (canonicalJson(evidence.tail) !== canonicalJson(candidate.record)) {
          throw corrupt('Control store published tail candidate differs from its exact record');
        }
        return evidence;
      },
    );
  }

  function cleanupExactBoundedEventCandidate(tail) {
    const names = runIo(
      `listing bounded event candidates in ${controlDir}`,
      () => fs.readdirSync(controlDir),
    );
    const candidates = names.filter((name) => TEMP_FILE_PATTERN.test(name));
    if (candidates.length === 0) return;
    if (candidates.length !== 1) {
      throw recoveryRequired('Control store has ambiguous bounded event candidates');
    }

    const [name] = candidates;
    const candidatePath = path.join(controlDir, name);
    const stats = runIo(
      `inspecting bounded event candidate ${candidatePath}`,
      () => fs.lstatSync(candidatePath),
    );
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw corrupt(`Control store bounded event candidate is not a plain file: ${name}`);
    }
    const serialized = runIo(
      `reading bounded event candidate ${candidatePath}`,
      () => fs.readFileSync(candidatePath, 'utf8'),
    );
    let event;
    try {
      event = JSON.parse(serialized);
    } catch (cause) {
      throw corrupt(`Control store bounded event candidate is not valid JSON: ${name}`, cause);
    }
    validateStoredEventShape(event, name);
    const { digest, ...withoutDigest } = event;
    if (
      serialized !== canonicalJson(event)
      || eventDigest(withoutDigest) !== digest
      || event.seq !== tail.tailSeq + 1
      || event.prevDigest !== tail.tailDigest
      || fs.existsSync(path.join(controlDir, `${event.seq}-${event.digest}.json`))
    ) {
      throw recoveryRequired('Control store bounded event candidate does not uniquely match its tail');
    }

    runIo(`removing bounded event candidate ${candidatePath}`, () => fs.unlinkSync(candidatePath));
    runIo(`syncing bounded event candidate cleanup ${controlDir}`, () => fsyncDirectory(controlDir));
  }

  function reconcileExistingBoundedTail(metadata, candidates, turn) {
    const tail = parseBoundedTail(controlDir, captured.incarnationId);
    parseBoundedCheckpoint(controlDir, tail);
    cleanupExactBoundedEventCandidate(tail);
    readBoundedActiveEvents(controlDir, tail, {
      allowSuccessors: true,
      allowTailCandidates: true,
    });
    const successors = readUnreferencedBoundedSuccessors(controlDir, tail);
    if (successors.length > 1 || candidates.length > 1) {
      throw recoveryRequired('Control store has ambiguous bounded successor evidence');
    }

    const candidate = candidates[0] || null;
    if (successors.length === 0) {
      if (!candidate) return readBoundedEvidence(controlDir, captured.incarnationId);
      if (canonicalJson(candidate.record) !== canonicalJson(tail)) {
        throw recoveryRequired('Control store tail candidate does not match current authority');
      }
      runIo(`removing equivalent bounded tail candidate ${candidate.path}`, () => {
        fs.rmSync(candidate.path);
      });
      runIo(`syncing bounded candidate cleanup ${controlDir}`, () => fsyncDirectory(controlDir));
      return postcheckInstalledBoundedEvidence(
        turn,
        'Control store current tail candidate cleanup failed exact postcheck',
        () => readBoundedEvidence(controlDir, captured.incarnationId),
      );
    }

    const successor = successors[0];
    const expectedTail = boundedTailAfterSuccessor(tail, successor);
    let evidence;
    if (candidate) {
      if (canonicalJson(candidate.record) !== canonicalJson(expectedTail)) {
        throw recoveryRequired('Control store tail candidate does not match its unique successor');
      }
      evidence = publishExistingTailCandidate(candidate, turn);
    } else {
      try {
        writeBoundedTail(controlDir, expectedTail);
      } catch (cause) {
        throw recoveryRequired('Control store unique successor tail advance is uncertain', cause);
      }
      evidence = postcheckInstalledBoundedEvidence(
        turn,
        'Control store unique successor tail advance failed exact postcheck',
        () => {
          const postcheck = readBoundedEvidence(controlDir, captured.incarnationId);
          if (canonicalJson(postcheck.tail) !== canonicalJson(expectedTail)) {
            throw corrupt('Control store unique successor tail differs from expected authority');
          }
          return postcheck;
        },
      );
    }
    return evidence;
  }

  function applyBoundedCheckpointCleanup(topology, turn) {
    if (topology.cleanupPaths.length === 0) return topology;
    turn.installed = true;
    try {
      for (const cleanupPath of topology.cleanupPaths) {
        if (path.dirname(path.resolve(cleanupPath)) !== controlDir) {
          throw corrupt('Control store checkpoint cleanup escaped its control directory');
        }
        runIo(
          `removing checkpoint cleanup entry ${cleanupPath}`,
          () => fs.unlinkSync(cleanupPath),
        );
      }
      runIo(
        `syncing checkpoint cleanup ${controlDir}`,
        () => fsyncDirectory(controlDir),
      );
    } catch (cause) {
      throw recoveryRequired('Control store checkpoint cleanup is uncertain', cause);
    }
    return postcheckInstalledBoundedEvidence(
      turn,
      'Control store checkpoint cleanup failed its stable postcheck',
      () => {
        const stable = classifyBoundedCheckpointTopology(
          controlDir,
          captured.incarnationId,
        );
        if (stable.cleanupPaths.length !== 0) {
          throw recoveryRequired('Control store checkpoint cleanup remains incomplete');
        }
        return stable;
      },
    );
  }

  function bootstrapBoundedTail(turn) {
    const metadata = classifyBoundedMetadata(controlDir);
    rejectMalformedBoundedMetadata(metadata);
    if (metadata.tailFinal) {
      const topology = classifyBoundedCheckpointTopology(
        controlDir,
        captured.incarnationId,
      );
      applyBoundedCheckpointCleanup(topology, turn);
      const stableMetadata = classifyBoundedMetadata(controlDir);
      const stableCandidates = parseBoundedTailCandidates(
        controlDir,
        stableMetadata,
        captured.incarnationId,
      );
      return reconcileExistingBoundedTail(
        stableMetadata,
        stableCandidates,
        turn,
      );
    }
    classifyBoundedCheckpointTopology(
      controlDir,
      captured.incarnationId,
    );
    const candidates = parseBoundedTailCandidates(
      controlDir,
      metadata,
      captured.incarnationId,
    );
    const checkpointCandidates = parseBoundedCheckpointCandidates(
      controlDir,
      metadata,
      captured.incarnationId,
    );
    if (
      metadata.checkpointFinals.length > 0
      || checkpointCandidates.length > 0
      || candidates.length > 1
    ) {
      throw recoveryRequired('Control store checkpoint or tail candidate is not uniquely activated');
    }
    if (candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate.record.checkpointFile !== null) {
        throw recoveryRequired('Control store bootstrap candidate cannot introduce a checkpoint');
      }
      readBoundedActiveEvents(controlDir, candidate.record, {
        allowTailCandidates: true,
      });
      return publishExistingTailCandidate(candidate, turn);
    }

    const events = readEvents(controlDir);
    const tailEvent = events.at(-1) || null;
    const value = {
      version: 1,
      controlProtocolEpoch: BOUNDED_CONTROL_PROTOCOL_EPOCH,
      incarnationId: captured.incarnationId,
      checkpointFile: null,
      checkpointDigest: null,
      coveredSeq: 0,
      coveredDigest: null,
      tailSeq: tailEvent?.seq ?? 0,
      tailDigest: tailEvent?.digest ?? null,
      activeEventCount: events.length,
      activeEventBytes: events.reduce(
        (sum, event) => sum + Buffer.byteLength(canonicalJson(event), 'utf8'),
        0,
      ),
    };
    const writeState = {};
    try {
      writeBoundedTail(controlDir, value, writeState);
    } catch (cause) {
      const mapped = ioFailure(
        `bootstrapping bounded tail ${path.join(controlDir, BOUNDED_TAIL_FILE_NAME)}`,
        cause,
      );
      if (writeState.publishAttempted || !writeState.cleanupProven) {
        throw recoveryRequired(
          'Control store bounded bootstrap tail installation is uncertain',
          mapped,
        );
      }
      throw mapped;
    }
    return postcheckInstalledBoundedEvidence(
      turn,
      'Control store bounded bootstrap tail failed exact postcheck',
      () => readBoundedEvidence(controlDir, captured.incarnationId),
    );
  }

  if (bounded) {
    withBoundedWriterTurn((turn) => bootstrapBoundedTail(turn));

    function currentBoundedEvidence() {
      assertBoundedNotFenced();
      return withLifecycleLease(() => {
        assertCurrentUnlocked();
        requireCleanBoundedCheckpointTopology(
          controlDir,
          captured.incarnationId,
        );
        return readBoundedEvidence(controlDir, captured.incarnationId);
      });
    }

    function installCheckpoint(authorityProvider) {
      assertBoundedNotFenced();
      if (typeof authorityProvider !== 'function' || authorityProvider.length !== 0) {
        checkpointAuthorityFailure('provider must be a zero-argument function');
      }
      let receiptCheckpointDigest;
      let receiptCoveredSeq;
      withCheckpointWriterTurn((turn) => {
        let evidence;
        try {
          requireCleanBoundedCheckpointTopology(
            controlDir,
            captured.incarnationId,
          );
          evidence = readBoundedEvidence(controlDir, captured.incarnationId);
        } catch (cause) {
          if (cause?.code === 'RECOVERY_REQUIRED') {
            turn.externalRecoveryObserved = true;
          }
          throw cause;
        }
        if (
          evidence.checkpoint === null
          && evidence.tail.tailSeq === 0
          && evidence.tail.activeEventCount === 0
        ) {
          throw checkpointBlocked(
            'Control store has no evidence to checkpoint',
          );
        }
        let authority;
        try {
          authority = authorityProvider();
          validateCheckpointAuthority(authority, evidence, captured.incarnationId);
        } catch (cause) {
          if (mintedRecoveryRequiredErrors.has(cause)) throw cause;
          checkpointAuthorityFailure('provider or validator failed', cause);
        }
        if (
          evidence.checkpoint !== null
          && canonicalJson(authority.cleanBasis.admissionBasis)
            !== canonicalJson(evidence.checkpoint.admissionBasis)
        ) {
          checkpointAuthorityFailure(
            'admission basis does not match the current checkpoint',
          );
        }
        if (
          evidence.checkpoint !== null
          && evidence.tail.tailSeq === evidence.checkpoint.coveredSeq
          && evidence.tail.activeEventCount === 0
        ) {
          if (
            authority.epochObservations.length !== 0
            || canonicalJson(authority.cleanBasis)
              !== canonicalJson(checkpointCleanBasisProjection(evidence.checkpoint))
          ) {
            checkpointAuthorityFailure(
              'does not exactly match the current checkpoint no-op',
            );
          }
          receiptCheckpointDigest = evidence.checkpoint.checkpointDigest;
          receiptCoveredSeq = evidence.checkpoint.coveredSeq;
          return;
        }

        let build;
        try {
          build = buildBoundedCheckpoint(evidence, authority);
        } catch (cause) {
          if (
            cause instanceof ControlCheckpointBlockedError
            || mintedRecoveryRequiredErrors.has(cause)
          ) {
            throw cause;
          }
          checkpointAuthorityFailure(
            'derived checkpoint failed mechanical validation',
            cause,
          );
        }
        publishCheckpointFinal(build, turn);
        let installedTail;
        try {
          installedTail = activateCheckpointTail(build, turn);
        } catch (cause) {
          if (!turn.authorityMutationAttempted) {
            cleanupUnactivatedCheckpointFinal(build, cause, turn);
          }
          throw cause;
        }
        garbageCollectInstalledCheckpoint(build, evidence, installedTail);
        receiptCheckpointDigest = build.checkpoint.checkpointDigest;
        receiptCoveredSeq = build.checkpoint.coveredSeq;
      });
      return Object.freeze({
        checkpointDigest: receiptCheckpointDigest,
        coveredSeq: receiptCoveredSeq,
      });
    }

    function maintenanceStatus() {
      const evidence = currentBoundedEvidence();
      const { activeEventBytes, activeEventCount } = evidence.tail;
      const level = (
        activeEventCount >= 8192
        || activeEventBytes >= 32 * 1024 * 1024
      )
        ? 'hard'
        : (
            activeEventCount >= 4096
            || activeEventBytes >= 16 * 1024 * 1024
          )
            ? 'soft'
            : 'none';
      return Object.freeze({ activeEventCount, activeEventBytes, level });
    }

    const facade = {
      get directory() {
        return controlDir;
      },

      get lifecycleLeasePath() {
        return lifecycleLeasePath;
      },

      get incarnationId() {
        return captured.incarnationId;
      },

      assertCurrent() {
        assertBoundedNotFenced();
        return withLifecycleLease(() => {
          assertCurrentUnlocked();
          return true;
        });
      },

      append(inputEvent) {
        return withBoundedWriterTurn(
          (turn) => appendBounded(inputEvent, undefined, false, turn),
        );
      },

      compareAndAppend(expectedDigest, inputEvent) {
        return withBoundedWriterTurn(
          (turn) => appendBounded(inputEvent, expectedDigest, true, turn),
        );
      },

      read() {
        return currentBoundedEvidence().events;
      },

      readEvidence() {
        return currentBoundedEvidence();
      },

      tail() {
        const tailRecord = currentBoundedEvidence().tail;
        if (tailRecord.tailSeq === 0) return null;
        return Object.freeze({ seq: tailRecord.tailSeq, digest: tailRecord.tailDigest });
      },

      retire() {
        assertBoundedNotFenced();
        throw protocolUnsupported('Bounded ControlStore retirement is not supported');
      },

      retireAndActivate() {
        assertBoundedNotFenced();
        throw protocolUnsupported('Bounded ControlStore retirement is not supported');
      },
    };
    const controller = Object.freeze({ installCheckpoint, maintenanceStatus });
    boundedCheckpointControllers.set(facade, controller);
    return facade;
  }

  return {
    get directory() {
      return controlDir;
    },

    get lifecycleLeasePath() {
      return lifecycleLeasePath;
    },

    get incarnationId() {
      return captured.incarnationId;
    },

    assertCurrent() {
      return withLifecycleLease(() => {
        assertCurrentUnlocked();
        return true;
      });
    },

    append(inputEvent) {
      return withWriterLease(() => appendAfter(readEvents(controlDir), inputEvent));
    },

    compareAndAppend(expectedDigest, inputEvent) {
      return withWriterLease(() => {
        const events = readEvents(controlDir);
        const actualDigest = events.at(-1)?.digest ?? null;
        if (expectedDigest !== actualDigest) throw casFailed(expectedDigest, actualDigest);
        return appendAfter(events, inputEvent);
      });
    },

    read() {
      return withLifecycleLease(() => {
        assertCurrentUnlocked();
        return readEvents(controlDir);
      });
    },

    tail() {
      return withLifecycleLease(() => {
        assertCurrentUnlocked();
        return readEvents(controlDir).at(-1) || null;
      });
    },

    retire(destination, validate) {
      const retiredDirectory = path.resolve(destination);
      const suffix = path.basename(retiredDirectory).slice(path.basename(controlDir).length);
      if (
        canonicalPath(path.dirname(retiredDirectory)) !== canonicalPath(sourceParent)
        || !canonicalName(path.basename(retiredDirectory)).startsWith(canonicalName(path.basename(controlDir)))
        || !RETIRED_DIRECTORY_SUFFIX_PATTERN.test(suffix)
        || typeof validate !== 'function'
      ) {
        throw invalidEvent('Control store retirement requires a same-parent UUID destination and validator');
      }

      return withLifecycleLease(() => {
        assertCurrentUnlocked();
        const events = readEvents(controlDir);
        validate(events);
        if (fs.existsSync(retiredDirectory)) {
          throw invalidEvent(`Control store retirement destination already exists: ${retiredDirectory}`);
        }
        runIo(
          `retiring directory ${controlDir}`,
          () => fs.renameSync(controlDir, retiredDirectory),
        );
        runIo(`syncing retirement parent ${sourceParent}`, () => {
          faultPoint(FAULT_POINTS.CONTROL_STORE_RETIRE_BEFORE_DIR_FSYNC, {
            controlDir,
            retiredDirectory,
          });
          fsyncDirectory(sourceParent);
        });
        return retiredDirectory;
      });
    },

    retireAndActivate(destination, validate) {
      const retiredDirectory = path.resolve(destination);
      const suffix = path.basename(retiredDirectory).slice(path.basename(controlDir).length);
      if (
        canonicalPath(path.dirname(retiredDirectory)) !== canonicalPath(sourceParent)
        || !canonicalName(path.basename(retiredDirectory)).startsWith(canonicalName(path.basename(controlDir)))
        || !RETIRED_DIRECTORY_SUFFIX_PATTERN.test(suffix)
        || typeof validate !== 'function'
      ) {
        throw invalidEvent('Control store retirement requires a same-parent UUID destination and validator');
      }

      return withLifecycleLease(() => {
        assertCurrentUnlocked();
        const events = readEvents(controlDir);
        validate(events);
        if (fs.existsSync(retiredDirectory)) {
          throw invalidEvent(`Control store retirement destination already exists: ${retiredDirectory}`);
        }
        runIo(
          `retiring directory ${controlDir}`,
          () => fs.renameSync(controlDir, retiredDirectory),
        );
        runIo(`syncing retirement parent ${sourceParent}`, () => {
          faultPoint(FAULT_POINTS.CONTROL_STORE_RETIRE_BEFORE_DIR_FSYNC, {
            controlDir,
            retiredDirectory,
          });
          fsyncDirectory(sourceParent);
        });
        const replacement = activateControlDirectory();
        return {
          retiredDirectory,
          incarnationId: replacement.incarnationId,
        };
      });
    },
  };
}

module.exports = {
  inspectControlStore,
  inspectControlStoreEvidence,
  openControlStore,
};

Object.defineProperty(module.exports, 'getBoundedControlStoreCheckpointController', {
  value: getBoundedControlStoreCheckpointController,
  enumerable: false,
  writable: false,
  configurable: false,
});
