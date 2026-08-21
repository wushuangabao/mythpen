'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const { assertCanonicalUuid, manuscriptError } = require('./contracts');
const { validateCreationReservationManifest } = require('./uid-reservation');
const { faultPoint } = require('../testing/fault-injection');

const PREFIX = 'creation.';
const VERSION = 1;
const STATES = Object.freeze([
  'creation_reserved',
  'project_control_ready',
  'file_publication_started',
  'files_published',
  'database_candidate_ready',
  'activation_intent',
  'activated',
]);
const STATE_SET = new Set(STATES);
const FORWARD = Object.freeze({
  creation_reserved: 'project_control_ready',
  project_control_ready: 'file_publication_started',
  file_publication_started: 'files_published',
  files_published: 'database_candidate_ready',
  database_candidate_ready: 'activation_intent',
  activation_intent: 'activated',
});
const journalRecords = new WeakMap();
const stageAuthorities = new WeakMap();
const observationAuthorities = new WeakMap();
const transitionAuthorities = new WeakMap();
const creationContextAuthorities = new WeakMap();

function recoveryRequired(reason, details = {}, cause) {
  return manuscriptError('RECOVERY_REQUIRED', { reason, ...details }, cause);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDescriptors(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const expected = keys.slice().sort();
  if (
    actual.some((key) => typeof key !== 'string')
    || actual.slice().sort().join('\0') !== expected.join('\0')
    || actual.some((key) => {
      const descriptor = descriptors[key];
      return descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value');
    })
  ) throw new TypeError(`${label} has an invalid shape`);
  return descriptors;
}

function snapshotPlain(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError(`${label} is invalid`);
    return value;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new TypeError(`${label} must contain serializable plain data`);
  }
  if (seen.has(value)) throw new TypeError(`${label} must be acyclic`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
        throw new TypeError(`${label} must be a dense exact array`);
      }
      return Object.freeze(value.map((entry, index) => (
        snapshotPlain(entry, `${label}[${index}]`, seen)
      )));
    }
    if (!isPlainObject(value)) throw new TypeError(`${label} must contain plain objects`);
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError(`${label} must contain enumerable data properties only`);
      }
      result[key] = snapshotPlain(descriptor.value, `${label}.${key}`, seen);
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
    return result;
  }
  return value;
}

function digestPlain(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertGeneration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function snapshotProjectMetadata(value) {
  const descriptors = exactDescriptors(
    value,
    ['genres', 'language', 'mode', 'name'],
    'projectMetadata',
  );
  const name = nonEmpty(descriptors.name.value, 'projectMetadata.name');
  const mode = nonEmpty(descriptors.mode.value, 'projectMetadata.mode');
  const language = nonEmpty(descriptors.language.value, 'projectMetadata.language');
  const genres = descriptors.genres.value;
  if (!Array.isArray(genres) || genres.length === 0) {
    throw new TypeError('projectMetadata.genres must be a non-empty array');
  }
  return Object.freeze({
    name,
    mode,
    language,
    genres: Object.freeze(genres.map((genre, index) => (
      nonEmpty(genre, `projectMetadata.genres[${index}]`)
    ))),
  });
}

function canonicalPath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
  ) throw new TypeError(`${label} must be one canonical absolute path`);
  return value;
}

function snapshotDirectoryPlan(value, record, creationReservation) {
  const descriptors = exactDescriptors(value, [
    'articleRoot',
    'digest',
    'fileAssetsRoot',
    'finalDatabasePath',
    'lifecycleLockPath',
    'projectControlRoot',
  ], 'directoryPlan');
  const finalDatabasePath = canonicalPath(
    descriptors.finalDatabasePath.value,
    'directoryPlan.finalDatabasePath',
  );
  const projectControlRoot = canonicalPath(
    descriptors.projectControlRoot.value,
    'directoryPlan.projectControlRoot',
  );
  const articleRoot = canonicalPath(
    descriptors.articleRoot.value,
    'directoryPlan.articleRoot',
  );
  const fileAssetsRoot = canonicalPath(
    descriptors.fileAssetsRoot.value,
    'directoryPlan.fileAssetsRoot',
  );
  const lifecycleLockPath = canonicalPath(
    descriptors.lifecycleLockPath.value,
    'directoryPlan.lifecycleLockPath',
  );
  const expectedControlRoot = path.join(
    record.dataRoot,
    'control',
    'manuscripts',
    creationReservation.projectReservation.uid,
    creationReservation.projectInstanceId,
  );
  if (
    projectControlRoot !== expectedControlRoot
    || articleRoot !== path.join(
      record.dataRoot,
      'manuscripts',
      creationReservation.projectReservation.uid,
    )
    || fileAssetsRoot !== path.join(expectedControlRoot, 'file-assets')
    || lifecycleLockPath !== `${finalDatabasePath}.lifecycle.lock`
  ) throw recoveryRequired('project creation directory plan is not controlled');
  return Object.freeze({
    digest: assertDigest(descriptors.digest.value, 'directoryPlan.digest'),
    finalDatabasePath,
    lifecycleLockPath,
    projectControlRoot,
    articleRoot,
    fileAssetsRoot,
  });
}

function snapshotIdentity(value, label) {
  const descriptors = exactDescriptors(value, ['dev', 'ino'], label);
  const dev = descriptors.dev.value;
  const ino = descriptors.ino.value;
  if (
    typeof dev !== 'string'
    || !/^\d+$/u.test(dev)
    || typeof ino !== 'string'
    || !/^\d+$/u.test(ino)
  ) throw new TypeError(`${label} must contain decimal dev and ino strings`);
  return Object.freeze({ dev, ino });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function capturePort(value, methods, label) {
  if (value === null || typeof value !== 'object') throw new TypeError(`${label} is required`);
  const result = {};
  for (const method of methods) {
    if (typeof value[method] !== 'function') throw new TypeError(`${label}.${method} is required`);
    result[method] = value[method].bind(value);
  }
  return Object.freeze(result);
}

function append(record, state, priorState, data) {
  const safeData = snapshotPlain(data, `${state}.data`);
  const payload = Object.freeze({
    version: VERSION,
    creationId: record.creationId,
    state,
    priorState,
    data: safeData,
    dataDigest: digestPlain(safeData),
  });
  const tail = record.control.tail();
  try {
    record.control.compareAndAppend(tail?.digest ?? null, {
      type: `${PREFIX}${state}`,
      payload,
    });
  } catch (cause) {
    throw recoveryRequired('project creation event append failed', {
      creationId: record.creationId,
      state,
    }, cause);
  }
  record.parsed = null;
  faultPoint(`creation.after-${state.replaceAll('_', '-')}`, {
    creationId: record.creationId,
  });
}

function parse(record) {
  let events;
  try {
    events = record.control.read();
  } catch (cause) {
    throw recoveryRequired('project creation journal read failed', {
      creationId: record.creationId,
    }, cause);
  }
  if (!Array.isArray(events)) {
    throw recoveryRequired('project creation journal read is not an event array');
  }
  const tailDigest = events.at(-1)?.digest ?? null;
  if (record.parsed?.tailDigest === tailDigest) return record.parsed;
  let aggregate = null;
  let priorRawDigest = null;
  for (let index = 0; index < events.length; index += 1) {
    try {
      const event = events[index];
      if (typeof event?.type !== 'string' || !event.type.startsWith(PREFIX)) {
        throw recoveryRequired('unknown project creation journal event', { index });
      }
      const state = event.type.slice(PREFIX.length);
      if (!STATE_SET.has(state)) {
        throw recoveryRequired('unknown project creation state', { state });
      }
      if (
        event.seq !== index + 1
        || event.prevDigest !== priorRawDigest
        || typeof event.digest !== 'string'
        || !/^[0-9a-f]{64}$/u.test(event.digest)
      ) throw recoveryRequired('project creation journal chain is malformed', { index });
      const descriptors = exactDescriptors(event.payload, [
        'creationId',
        'data',
        'dataDigest',
        'priorState',
        'state',
        'version',
      ], `${state} payload`);
      if (
        descriptors.version.value !== VERSION
        || descriptors.creationId.value !== record.creationId
        || descriptors.state.value !== state
        || descriptors.priorState.value !== (aggregate?.state ?? null)
      ) throw recoveryRequired('project creation event binding changed', { state });
      const safeData = snapshotPlain(descriptors.data.value, `${state}.data`);
      const dataDigest = assertDigest(descriptors.dataDigest.value, 'dataDigest');
      if (digestPlain(safeData) !== dataDigest) {
        throw recoveryRequired('project creation event checksum mismatch', { state });
      }
      if (
        (aggregate === null && state !== 'creation_reserved')
        || (aggregate !== null && FORWARD[aggregate.state] !== state)
      ) throw recoveryRequired('project creation transition is invalid', {
        priorState: aggregate?.state ?? null,
        state,
      });
      aggregate = Object.freeze({
        state,
        eventDigest: event.digest,
        data: safeData,
        history: Object.freeze([...(aggregate?.history ?? []), Object.freeze({
          state,
          eventDigest: event.digest,
          data: safeData,
        })]),
      });
      priorRawDigest = event.digest;
    } catch (cause) {
      if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
      throw recoveryRequired('project creation journal event is malformed', { index }, cause);
    }
  }
  record.parsed = Object.freeze({ tailDigest, aggregate });
  return record.parsed;
}

function requireAggregate(record) {
  const aggregate = parse(record).aggregate;
  if (aggregate === null) {
    throw recoveryRequired('project creation journal does not exist', {
      creationId: record.creationId,
    });
  }
  return aggregate;
}

function reservationOf(aggregate) {
  return aggregate.history[0].data;
}

function mintStage(record, aggregate) {
  const authority = Object.freeze(() => {});
  stageAuthorities.set(authority, Object.freeze({
    owner: record.owner,
    state: aggregate.state,
    eventDigest: aggregate.eventDigest,
  }));
  return authority;
}

function assertStage(record, authority, expectedState) {
  const owned = stageAuthorities.get(authority);
  if (owned?.owner !== record.owner || owned.state !== expectedState) {
    throw new TypeError(`authority is not this journal's ${expectedState} authority`);
  }
  const aggregate = requireAggregate(record);
  if (aggregate.state !== expectedState || aggregate.eventDigest !== owned.eventDigest) {
    throw recoveryRequired('project creation authority is stale', {
      creationId: record.creationId,
      expectedState,
      actualState: aggregate.state,
    });
  }
  return aggregate;
}

function classify(record, portName, evidence, aggregate) {
  let disposition;
  try {
    disposition = record[portName].classify(evidence, aggregate);
  } catch (cause) {
    throw recoveryRequired(`${portName} evidence classification failed`, {}, cause);
  }
  if (!['before', 'after', 'unknown'].includes(disposition)) {
    throw recoveryRequired(`${portName} evidence disposition is invalid`);
  }
  return disposition;
}

function stateView(record, aggregate) {
  const reservation = reservationOf(aggregate);
  const control = aggregate.history.find((event) => event.state === 'project_control_ready');
  const pin = aggregate.history.find((event) => event.state === 'file_publication_started');
  const database = aggregate.history.find((event) => event.state === 'database_candidate_ready');
  return Object.freeze({
    creationId: record.creationId,
    projectUid: reservation.projectUid,
    projectInstanceId: reservation.projectInstanceId,
    logicalRequestId: reservation.logicalRequestId,
    logicalInputDigest: reservation.logicalInputDigest,
    projectMetadata: reservation.projectMetadata,
    state: aggregate.state,
    baseGeneration: reservation.baseGeneration,
    targetGeneration: reservation.targetGeneration,
    reservationDigest: reservation.reservationDigest,
    creationReservation: reservation.creationReservation,
    directoryPlan: reservation.directoryPlan,
    childReservation: control?.data.childReservation ?? null,
    manifest: pin?.data.manifest ?? null,
    databaseCandidate: database?.data ?? null,
  });
}

class ProjectCreationJournal {
  constructor(options) {
    const descriptors = exactDescriptors(options, [
      'childDisposition',
      'clock',
      'controlStore',
      'creationId',
      'dataRoot',
      'databaseDisposition',
    ], 'ProjectCreationJournal options');
    const creationId = assertCanonicalUuid(descriptors.creationId.value, 'creation_id');
    const dataRoot = canonicalPath(descriptors.dataRoot.value, 'dataRoot');
    const controlStore = descriptors.controlStore.value;
    if (controlStore === null || typeof controlStore !== 'object') {
      throw new TypeError('controlStore is required');
    }
    const expectedDirectory = path.join(dataRoot, 'control', 'project-creation', creationId);
    if (
      controlStore.directory !== expectedDirectory
      || typeof controlStore.incarnationId !== 'string'
      || controlStore.incarnationId.length === 0
    ) throw recoveryRequired('ProjectCreationJournal ControlStore binding is foreign');
    const control = {};
    for (const method of ['compareAndAppend', 'read', 'tail']) {
      if (typeof controlStore[method] !== 'function') {
        throw new TypeError(`controlStore.${method} is required`);
      }
      control[method] = controlStore[method].bind(controlStore);
    }
    const clock = descriptors.clock.value;
    if (typeof clock !== 'function') throw new TypeError('clock is required');
    journalRecords.set(this, {
      owner: Object.freeze({}),
      creationId,
      dataRoot,
      control: Object.freeze(control),
      controlIncarnationId: controlStore.incarnationId,
      childDisposition: capturePort(
        descriptors.childDisposition.value,
        ['classify', 'inspect'],
        'childDisposition',
      ),
      databaseDisposition: capturePort(
        descriptors.databaseDisposition.value,
        ['classify', 'inspect'],
        'databaseDisposition',
      ),
      clock,
      parsed: null,
      authority: null,
      reservationSource: null,
    });
    Object.freeze(this);
  }

  authority() {
    const record = journalRecords.get(this);
    if (record.authority !== null) return record.authority;
    const readObservation = () => {
      const parsed = parse(record);
      const observation = Object.freeze(() => {});
      observationAuthorities.set(observation, Object.freeze({
        owner: record.owner,
        tailDigest: parsed.tailDigest,
        state: parsed.aggregate?.state ?? 'none',
        eventDigest: parsed.aggregate?.eventDigest ?? null,
      }));
      return observation;
    };
    const assertObservation = (observation) => {
      const owned = observationAuthorities.get(observation);
      if (owned?.owner !== record.owner) throw new TypeError('creation observation is foreign');
      return owned;
    };
    record.authority = Object.freeze({
      readObservation,
      describeObservation(observation) {
        const owned = assertObservation(observation);
        const aggregate = owned.state === 'none' ? null : requireAggregate(record);
        const reservation = aggregate === null ? null : reservationOf(aggregate);
        return Object.freeze({
          creationId: record.creationId,
          projectUid: reservation?.projectUid ?? null,
          projectInstanceId: reservation?.projectInstanceId ?? null,
          state: owned.state,
          tailDigest: owned.tailDigest,
          reservationDigest: reservation?.reservationDigest ?? null,
          baseGeneration: reservation?.baseGeneration ?? null,
          targetGeneration: reservation?.targetGeneration ?? null,
        });
      },
      assertTransitionAllowed(observation, transition) {
        const owned = assertObservation(observation);
        const current = parse(record);
        if (current.tailDigest !== owned.tailDigest) {
          throw recoveryRequired('project creation observation is stale');
        }
        const descriptors = exactDescriptors(
          transition,
          ['expected', 'next'],
          'project creation transition',
        );
        if (
          owned.state !== 'activation_intent'
          || descriptors.expected.value !== 'absent'
          || descriptors.next.value !== 'files'
        ) throw recoveryRequired('project creation transition is not authorized');
        const proof = Object.freeze(() => {});
        transitionAuthorities.set(proof, Object.freeze({
          owner: record.owner,
          eventDigest: owned.eventDigest,
        }));
        return proof;
      },
      assertCreationContext(context) {
        const owned = creationContextAuthorities.get(context);
        if (owned?.owner !== record.owner) throw new TypeError('ProjectCreationContext is foreign');
        const aggregate = requireAggregate(record);
        if (
          aggregate.state !== 'activation_intent'
          || aggregate.eventDigest !== owned.eventDigest
          || digestPlain(context) !== owned.contextDigest
        ) throw recoveryRequired('ProjectCreationContext is stale or changed');
        return context;
      },
    });
    return record.authority;
  }

  reservationSource() {
    const record = journalRecords.get(this);
    if (record.reservationSource !== null) return record.reservationSource;
    record.reservationSource = Object.freeze({
      enumerate(scopeValue) {
        const scope = snapshotPlain(scopeValue, 'creation reservation source scope');
        const aggregate = parse(record).aggregate;
        const records = [];
        if (aggregate !== null && scope.objectKind === 'project') {
          const reservation = reservationOf(aggregate).creationReservation;
          records.push(Object.freeze({
            ownerKind: 'creation',
            ownerId: reservation.creationId,
            reservationId: reservation.reservationId,
            uid: reservation.projectReservation.uid,
          }));
        }
        return Object.freeze({
          complete: true,
          projectUid: scope.projectUid ?? null,
          projectInstanceId: scope.projectInstanceId ?? null,
          objectKind: scope.objectKind,
          records: Object.freeze(records),
        });
      },
      lookup(inputValue) {
        const descriptors = exactDescriptors(
          inputValue,
          ['logicalRequestId'],
          'creation reservation lookup',
        );
        const logicalRequestId = nonEmpty(
          descriptors.logicalRequestId.value,
          'logicalRequestId',
        );
        const aggregate = parse(record).aggregate;
        const reservation = aggregate === null ? null : reservationOf(aggregate).creationReservation;
        return Object.freeze({
          complete: true,
          logicalRequestId,
          reservations: Object.freeze(
            reservation?.logicalRequestId === logicalRequestId ? [reservation] : [],
          ),
        });
      },
    });
    return record.reservationSource;
  }

  read() {
    const record = journalRecords.get(this);
    const aggregate = parse(record).aggregate;
    return aggregate === null ? null : stateView(record, aggregate);
  }

  async reserve(input) {
    const record = journalRecords.get(this);
    const descriptors = exactDescriptors(input, [
      'baseGeneration',
      'creationReservation',
      'directoryPlan',
      'projectMetadata',
      'targetGeneration',
    ], 'project creation reserve input');
    const creationReservation = validateCreationReservationManifest(
      descriptors.creationReservation.value,
    );
    if (creationReservation.creationId !== record.creationId) {
      throw new TypeError('creation reservation belongs to another journal');
    }
    const baseGeneration = assertGeneration(descriptors.baseGeneration.value, 'baseGeneration');
    const targetGeneration = assertGeneration(
      descriptors.targetGeneration.value,
      'targetGeneration',
    );
    if (baseGeneration !== 0 || targetGeneration !== 1) {
      throw new TypeError('new project generation must be exactly 0 to 1');
    }
    const directoryPlan = snapshotDirectoryPlan(
      descriptors.directoryPlan.value,
      record,
      creationReservation,
    );
    const existing = parse(record).aggregate;
    const source = Object.freeze({
      creationReservation,
      directoryPlan,
      projectMetadata: snapshotProjectMetadata(descriptors.projectMetadata.value),
      baseGeneration,
      targetGeneration,
    });
    const reservationDigest = digestPlain(source);
    if (existing !== null) {
      const durable = reservationOf(existing);
      if (
        existing.state !== 'creation_reserved'
        || durable.reservationDigest !== reservationDigest
      ) throw recoveryRequired('durable project creation reservation differs or advanced');
      return mintStage(record, existing);
    }
    append(record, 'creation_reserved', null, {
      version: VERSION,
      creationId: record.creationId,
      projectUid: creationReservation.projectReservation.uid,
      projectInstanceId: creationReservation.projectInstanceId,
      logicalRequestId: creationReservation.logicalRequestId,
      logicalInputDigest: creationReservation.logicalInputDigest,
      projectMetadata: source.projectMetadata,
      creationReservation,
      directoryPlan,
      baseGeneration,
      targetGeneration,
      reservationDigest,
      createdAt: assertGeneration(record.clock(), 'createdAt'),
    });
    return mintStage(record, requireAggregate(record));
  }

  async recordProjectControlReady(authority, input) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'creation_reserved');
    const descriptors = exactDescriptors(input, [
      'childJournalId',
      'childReservation',
      'closureDigest',
      'logicalRequestId',
      'partialManifest',
      'projectionBasisDigest',
      'targetBindingDigest',
      'targetGeneration',
    ], 'project control ready input');
    const reservation = reservationOf(aggregate);
    if (
      descriptors.logicalRequestId.value !== reservation.logicalRequestId
      || descriptors.targetGeneration.value !== reservation.targetGeneration
    ) throw recoveryRequired('project control binding differs from reservation');
    append(record, 'project_control_ready', aggregate.state, {
      childJournalId: assertCanonicalUuid(
        descriptors.childJournalId.value,
        'child_journal_id',
      ),
      childReservation: snapshotPlain(
        descriptors.childReservation.value,
        'childReservation',
      ),
      closureDigest: assertDigest(descriptors.closureDigest.value, 'closureDigest'),
      logicalRequestId: reservation.logicalRequestId,
      partialManifest: snapshotPlain(
        descriptors.partialManifest.value,
        'partialManifest',
      ),
      projectionBasisDigest: assertDigest(
        descriptors.projectionBasisDigest.value,
        'projectionBasisDigest',
      ),
      targetBindingDigest: assertDigest(
        descriptors.targetBindingDigest.value,
        'targetBindingDigest',
      ),
      targetGeneration: reservation.targetGeneration,
    });
    return mintStage(record, requireAggregate(record));
  }

  async recordFilePublicationStarted(authority, input) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'project_control_ready');
    const descriptors = exactDescriptors(input, ['manifest'], 'file publication pin');
    const manifest = snapshotPlain(descriptors.manifest.value, 'manifest');
    append(record, 'file_publication_started', aggregate.state, {
      manifest,
      manifestDigest: digestPlain(manifest),
    });
    return mintStage(record, requireAggregate(record));
  }

  async recordFilesPublished(authority, childEvidence) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'file_publication_started');
    if (classify(record, 'childDisposition', childEvidence, aggregate) !== 'after') {
      throw recoveryRequired('initial files are not proven after');
    }
    append(record, 'files_published', aggregate.state, {
      childEvidenceDigest: digestPlain(snapshotPlain(childEvidence, 'childEvidence')),
    });
    return mintStage(record, requireAggregate(record));
  }

  async recordDatabaseCandidate(authority, input) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'files_published');
    const descriptors = exactDescriptors(input, [
      'candidateIdentity',
      'candidatePath',
      'candidateSha256',
      'finalCommitSeq',
      'finalParentIdentity',
      'finalPath',
      'transitionProofDigest',
    ], 'project creation database candidate');
    const candidatePath = canonicalPath(descriptors.candidatePath.value, 'candidatePath');
    const finalPath = canonicalPath(descriptors.finalPath.value, 'finalPath');
    const directoryPlan = reservationOf(aggregate).directoryPlan;
    if (
      candidatePath === finalPath
      || path.dirname(candidatePath) !== path.dirname(finalPath)
    ) throw new TypeError('creation candidate must be side-by-side with its absent final path');
    if (
      finalPath !== directoryPlan.finalDatabasePath
      || candidatePath === directoryPlan.lifecycleLockPath
    ) throw recoveryRequired('project creation database candidate differs from directory plan');
    append(record, 'database_candidate_ready', aggregate.state, {
      candidatePath,
      candidateIdentity: snapshotIdentity(
        descriptors.candidateIdentity.value,
        'candidateIdentity',
      ),
      candidateSha256: assertDigest(
        descriptors.candidateSha256.value,
        'candidateSha256',
      ),
      finalPath,
      finalParentIdentity: snapshotIdentity(
        descriptors.finalParentIdentity.value,
        'finalParentIdentity',
      ),
      finalCommitSeq: assertGeneration(descriptors.finalCommitSeq.value, 'finalCommitSeq'),
      transitionProofDigest: assertDigest(
        descriptors.transitionProofDigest.value,
        'transitionProofDigest',
      ),
    });
    return mintStage(record, requireAggregate(record));
  }

  async beginActivation(authority) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'database_candidate_ready');
    append(record, 'activation_intent', aggregate.state, {
      candidateSha256: aggregate.data.candidateSha256,
      transitionProofDigest: aggregate.data.transitionProofDigest,
    });
    return mintStage(record, requireAggregate(record));
  }

  async resumeActivation() {
    const record = journalRecords.get(this);
    const aggregate = requireAggregate(record);
    if (aggregate.state === 'activated') {
      const reservation = reservationOf(aggregate);
      return Object.freeze({
        creationId: record.creationId,
        projectUid: reservation.projectUid,
        state: 'activated',
        projectMetadata: reservation.projectMetadata,
      });
    }
    if (aggregate.state === 'database_candidate_ready') {
      return this.beginActivation(mintStage(record, aggregate));
    }
    if (aggregate.state === 'activation_intent') return mintStage(record, aggregate);
    throw recoveryRequired('project creation state cannot resume activation', {
      state: aggregate.state,
    });
  }

  prepareCreationContext(authority) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'activation_intent');
    const reservation = reservationOf(aggregate);
    const candidate = aggregate.history.find(
      (event) => event.state === 'database_candidate_ready',
    )?.data;
    if (candidate === undefined) {
      throw recoveryRequired('activation intent lacks its database candidate');
    }
    const context = Object.freeze({
      kind: 'new_creation',
      creationId: record.creationId,
      projectUid: reservation.projectUid,
      projectInstanceId: reservation.projectInstanceId,
      projectMetadata: reservation.projectMetadata,
      candidatePath: candidate.candidatePath,
      candidateIdentity: candidate.candidateIdentity,
      candidateSha256: candidate.candidateSha256,
      finalPath: candidate.finalPath,
      finalParentIdentity: candidate.finalParentIdentity,
      transitionProofDigest: candidate.transitionProofDigest,
      journalTailDigest: aggregate.eventDigest,
      reservationDigest: reservation.reservationDigest,
      baseGeneration: reservation.baseGeneration,
      targetGeneration: reservation.targetGeneration,
      finalCommitSeq: candidate.finalCommitSeq,
    });
    creationContextAuthorities.set(context, Object.freeze({
      owner: record.owner,
      eventDigest: aggregate.eventDigest,
      contextDigest: digestPlain(context),
    }));
    return context;
  }

  async recordActivated(authority, databaseEvidence) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'activation_intent');
    if (classify(record, 'databaseDisposition', databaseEvidence, aggregate) !== 'after') {
      throw recoveryRequired('created project database is not proven after');
    }
    append(record, 'activated', aggregate.state, {
      databaseEvidenceDigest: digestPlain(snapshotPlain(databaseEvidence, 'databaseEvidence')),
    });
    const reservation = reservationOf(requireAggregate(record));
    return Object.freeze({
      creationId: record.creationId,
      projectUid: reservation.projectUid,
      state: 'activated',
      projectMetadata: reservation.projectMetadata,
    });
  }
}

class ProjectCreationFilePublicationParentAuthority {
  constructor(journal) {
    if (!journalRecords.has(journal)) {
      throw new TypeError('journal must be a ProjectCreationJournal');
    }
    journalRecords.set(this, journalRecords.get(journal));
    Object.freeze(this);
  }

  async assertReservation({ authority, parent, childReservation }) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'project_control_ready');
    const descriptors = exactDescriptors(parent, ['journalId', 'kind'], 'parent');
    if (
      descriptors.kind.value !== 'creation'
      || descriptors.journalId.value !== record.creationId
    ) throw new TypeError('parent does not identify this project creation');
    const safeChild = snapshotPlain(childReservation, 'childReservation');
    if (safeChild.record_kind === 'reservation') {
      const reservation = reservationOf(aggregate);
      if (
        safeChild.version !== 1
        || safeChild.journalId !== aggregate.data.childJournalId
        || safeChild.mode !== 'file_only'
        || safeChild.parent?.kind !== 'creation'
        || safeChild.parent?.journalId !== record.creationId
        || safeChild.logicalRequestId !== reservation.logicalRequestId
        || safeChild.baseGeneration !== reservation.baseGeneration
        || safeChild.targetGeneration !== reservation.targetGeneration
        || safeChild.basisDigest !== aggregate.data.projectionBasisDigest
        || safeChild.projectBinding?.projectUid !== reservation.projectUid
        || safeChild.projectBinding?.projectInstanceId !== reservation.projectInstanceId
        || digestPlain(safeChild.identityReservation)
          !== digestPlain(reservation.creationReservation)
      ) throw recoveryRequired('child reservation differs from project creation binding');
    } else if (
      digestPlain(safeChild) !== digestPlain(aggregate.data.childReservation)
    ) throw recoveryRequired('child reservation differs from project creation parent');
  }

  async assertPin({ authority, parent, manifest }) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'file_publication_started');
    const descriptors = exactDescriptors(parent, ['journalId', 'kind'], 'parent');
    if (
      descriptors.kind.value !== 'creation'
      || descriptors.journalId.value !== record.creationId
      || digestPlain(snapshotPlain(manifest, 'manifest')) !== aggregate.data.manifestDigest
    ) throw recoveryRequired('child manifest differs from project creation pin');
  }

  async readRecoveryIntent({ authority, parent, assetManifest }) {
    const record = journalRecords.get(this);
    const owned = stageAuthorities.get(authority);
    if (owned?.owner !== record.owner) throw new TypeError('parent recovery authority is foreign');
    const aggregate = requireAggregate(record);
    const descriptors = exactDescriptors(parent, ['journalId', 'kind'], 'parent');
    const pin = aggregate.history.find((event) => event.state === 'file_publication_started');
    const expected = pin?.data.manifest;
    if (
      descriptors.kind.value !== 'creation'
      || descriptors.journalId.value !== record.creationId
      || expected === undefined
      || digestPlain(snapshotPlain(assetManifest, 'assetManifest')) !== digestPlain(expected)
    ) throw recoveryRequired('asset manifest differs from project creation evidence');
    return 'after';
  }

  async assertGc() {
    throw recoveryRequired('project creation never authorizes child journal garbage collection');
  }
}

module.exports = {
  ProjectCreationFilePublicationParentAuthority,
  ProjectCreationJournal,
};
