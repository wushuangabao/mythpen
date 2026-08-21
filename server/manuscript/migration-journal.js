'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const { assertCanonicalUuid, manuscriptError } = require('./contracts');
const { faultPoint } = require('../testing/fault-injection');

const PREFIX = 'migration.';
const VERSION = 1;
const STATES = Object.freeze([
  'migration_reserved',
  'route_fenced',
  'source_snapshot_ready',
  'files_candidate_ready',
  'file_publication_started',
  'files_published',
  'database_candidate_ready',
  'activation_intent',
  'activated',
  'migration_abort_intent',
  'migration_aborted',
]);
const STATE_SET = new Set(STATES);
const TERMINAL = new Set(['activated', 'migration_aborted']);
const journalRecords = new WeakMap();
const stageAuthorities = new WeakMap();
const observationAuthorities = new WeakMap();
const reservedEventAuthorities = new WeakMap();
const transitionProofAuthorities = new WeakMap();
const migrationContextAuthorities = new WeakMap();
const gcAuthorities = new WeakMap();

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
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError(`${label} must contain data elements`);
        }
        result.push(snapshotPlain(descriptor.value, `${label}[${index}]`, seen));
      }
      return Object.freeze(result);
    }
    if (!isPlainObject(value)) throw new TypeError(`${label} must contain plain objects`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string'
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) throw new TypeError(`${label} must contain enumerable string data properties only`);
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
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function snapshotIdentity(value, label) {
  const descriptors = exactDescriptors(value, ['dev', 'ino'], label);
  const dev = descriptors.dev.value;
  const ino = descriptors.ino.value;
  if (
    typeof dev !== 'string'
    || !/^[0-9]+$/u.test(dev)
    || typeof ino !== 'string'
    || !/^[0-9]+$/u.test(ino)
  ) throw new TypeError(`${label} must contain decimal dev and ino strings`);
  return Object.freeze({ dev, ino });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function assertCanonicalAbsolutePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !path.isAbsolute(value)
    || path.resolve(value) !== value
    || path.normalize(value) !== value
  ) throw new TypeError(`${label} must be an absolute canonical path`);
  return value;
}

function snapshotProjectBinding(value) {
  const descriptors = exactDescriptors(value, [
    'controlIncarnationId',
    'dataRoot',
    'projectInstanceId',
    'projectUid',
  ], 'projectBinding');
  const dataRoot = descriptors.dataRoot.value;
  if (
    typeof dataRoot !== 'string'
    || dataRoot.length === 0
    || dataRoot.includes('\0')
    || !path.isAbsolute(dataRoot)
    || path.resolve(dataRoot) !== dataRoot
    || path.normalize(dataRoot) !== dataRoot
  ) throw new TypeError('projectBinding.dataRoot must be an absolute canonical path');
  return Object.freeze({
    dataRoot,
    projectUid: assertCanonicalUuid(descriptors.projectUid.value, 'project_uid'),
    projectInstanceId: assertCanonicalUuid(
      descriptors.projectInstanceId.value,
      'project_instance_id',
    ),
    controlIncarnationId: assertNonEmpty(
      descriptors.controlIncarnationId.value,
      'controlIncarnationId',
    ),
  });
}

function capturePort(value, methods, label) {
  const descriptors = exactDescriptors(value, methods, label);
  const captured = {};
  for (const method of methods) {
    if (typeof descriptors[method].value !== 'function') {
      throw new TypeError(`${label}.${method} is required`);
    }
    captured[method] = descriptors[method].value.bind(value);
  }
  return Object.freeze(captured);
}

function eventPayload(record, migrationId, state, priorState, data) {
  return Object.freeze({
    version: VERSION,
    projectUid: record.binding.projectUid,
    projectInstanceId: record.binding.projectInstanceId,
    migrationId,
    state,
    priorState,
    data: snapshotPlain(data, `${state}.data`),
  });
}

function append(record, migrationId, state, priorState, data) {
  const tail = record.control.tail();
  const payload = eventPayload(record, migrationId, state, priorState, data);
  let result;
  try {
    result = record.control.compareAndAppend(tail?.digest ?? null, {
      type: `${PREFIX}${state}`,
      payload,
    });
  } catch (cause) {
    throw recoveryRequired('migration event append failed', { migrationId, state }, cause);
  }
  record.parsed = null;
  faultPoint(`migration.after-${state.replaceAll('_', '-')}`, { migrationId });
  return result;
}

function parse(record) {
  const events = record.control.read();
  const tailDigest = events.at(-1)?.digest ?? null;
  if (record.parsed?.tailDigest === tailDigest) return record.parsed;
  const migrations = new Map();
  for (const event of events) {
    if (typeof event?.type !== 'string' || !event.type.startsWith(PREFIX)) continue;
    const state = event.type.slice(PREFIX.length);
    if (!STATE_SET.has(state)) throw recoveryRequired('unknown migration event', { type: event.type });
    let descriptors;
    try {
      descriptors = exactDescriptors(event.payload, [
        'data',
        'migrationId',
        'priorState',
        'projectInstanceId',
        'projectUid',
        'state',
        'version',
      ], `${state} payload`);
    } catch (cause) {
      throw recoveryRequired('migration event payload is malformed', { state }, cause);
    }
    const migrationId = assertCanonicalUuid(descriptors.migrationId.value, 'migration_id');
    if (
      descriptors.version.value !== VERSION
      || descriptors.projectUid.value !== record.binding.projectUid
      || descriptors.projectInstanceId.value !== record.binding.projectInstanceId
      || descriptors.state.value !== state
    ) throw recoveryRequired('migration event binding changed', { migrationId, state });
    const prior = migrations.get(migrationId) ?? null;
    const expectedPrior = prior?.state ?? null;
    if (descriptors.priorState.value !== expectedPrior) {
      throw recoveryRequired('migration event is not a canonical single-hop transition', {
        migrationId,
        state,
      });
    }
    if (prior === null && state !== 'migration_reserved') {
      throw recoveryRequired('migration journal does not start at reservation', { migrationId });
    }
    const allowed = prior === null ? true : (() => {
      if (state === 'migration_abort_intent') {
        return !['activation_intent', 'activated', 'migration_aborted'].includes(prior.state);
      }
      const forward = {
        migration_reserved: 'route_fenced',
        route_fenced: 'source_snapshot_ready',
        source_snapshot_ready: 'files_candidate_ready',
        files_candidate_ready: 'file_publication_started',
        file_publication_started: 'files_published',
        files_published: 'database_candidate_ready',
        database_candidate_ready: 'activation_intent',
        activation_intent: 'activated',
        migration_abort_intent: 'migration_aborted',
      };
      return forward[prior.state] === state;
    })();
    if (!allowed) throw recoveryRequired('migration journal transition is invalid', {
      migrationId,
      priorState: prior?.state,
      state,
    });
    const aggregate = Object.freeze({
      migrationId,
      state,
      eventDigest: assertDigest(event.digest, 'event.digest'),
      data: snapshotPlain(descriptors.data.value, `${state}.data`),
      history: Object.freeze([...(prior?.history ?? []), Object.freeze({
        state,
        eventDigest: event.digest,
        data: snapshotPlain(descriptors.data.value, `${state}.data`),
      })]),
    });
    migrations.set(migrationId, aggregate);
  }
  const unresolved = Array.from(migrations.values()).filter((value) => !TERMINAL.has(value.state));
  if (unresolved.length > 1) throw recoveryRequired('multiple unresolved migration journals exist');
  record.parsed = Object.freeze({ tailDigest, migrations, unresolved: Object.freeze(unresolved) });
  return record.parsed;
}

function reservationOf(aggregate) {
  return aggregate.history[0].data;
}

function requireAggregate(record, migrationId) {
  const safeId = assertCanonicalUuid(migrationId, 'migration_id');
  const aggregate = parse(record).migrations.get(safeId);
  if (!aggregate) throw recoveryRequired('migration journal does not exist', { migrationId: safeId });
  return aggregate;
}

function mintStage(record, aggregate) {
  const authority = Object.freeze(() => {});
  stageAuthorities.set(authority, Object.freeze({
    owner: record.owner,
    migrationId: aggregate.migrationId,
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
  const aggregate = requireAggregate(record, owned.migrationId);
  if (aggregate.state !== expectedState || aggregate.eventDigest !== owned.eventDigest) {
    throw recoveryRequired('migration authority is stale', {
      migrationId: owned.migrationId,
      expectedState,
      actualState: aggregate.state,
    });
  }
  return aggregate;
}

function classify(record, portName, evidence, context) {
  let disposition;
  try {
    disposition = record[portName].classify(evidence, context);
  } catch (cause) {
    throw recoveryRequired(`${portName} evidence classification failed`, {
      migrationId: context.migrationId,
    }, cause);
  }
  if (!['before', 'after', 'unknown'].includes(disposition)) {
    throw recoveryRequired(`${portName} evidence has an invalid disposition`, {
      migrationId: context.migrationId,
    });
  }
  return disposition;
}

async function inspect(record, portName, aggregate) {
  let evidence;
  try {
    evidence = await record[portName].inspect(Object.freeze({
      migrationId: aggregate.migrationId,
      state: aggregate.state,
      reservation: reservationOf(aggregate),
      aggregate,
    }));
  } catch (cause) {
    throw recoveryRequired(`${portName} inspection failed`, {
      migrationId: aggregate.migrationId,
    }, cause);
  }
  return Object.freeze({
    evidence,
    disposition: classify(record, portName, evidence, aggregate),
  });
}

function stateView(aggregate) {
  const reservation = reservationOf(aggregate);
  const filesCandidate = aggregate.history.find((event) => event.state === 'files_candidate_ready');
  const publicationPin = aggregate.history.find((event) => event.state === 'file_publication_started');
  return Object.freeze({
    migrationId: aggregate.migrationId,
    state: aggregate.state,
    projectUid: reservation.projectUid,
    projectInstanceId: reservation.projectInstanceId,
    logicalRequestId: reservation.logicalRequestId,
    baseGeneration: reservation.baseGeneration,
    targetGeneration: reservation.targetGeneration,
    sourceBasisDigest: reservation.sourceBasisDigest,
    migrationReservation: reservation.migrationReservation,
    reservationDigest: reservation.reservationDigest,
    childReservation: filesCandidate?.data.childReservation ?? null,
    manifest: publicationPin?.data.manifest ?? null,
  });
}

class MigrationJournal {
  constructor(options) {
    const descriptors = exactDescriptors(options, [
      'childDisposition',
      'cleanupDisposition',
      'clock',
      'controlStore',
      'databaseDisposition',
      'projectBinding',
      'routeDisposition',
    ], 'MigrationJournal options');
    const binding = snapshotProjectBinding(descriptors.projectBinding.value);
    const controlStore = descriptors.controlStore.value;
    if (controlStore === null || typeof controlStore !== 'object') {
      throw new TypeError('controlStore is required');
    }
    const control = {};
    for (const method of ['compareAndAppend', 'read', 'tail']) {
      if (typeof controlStore[method] !== 'function') throw new TypeError(`controlStore.${method} is required`);
      control[method] = controlStore[method].bind(controlStore);
    }
    const expectedDirectory = path.join(
      binding.dataRoot,
      'control',
      'manuscripts',
      binding.projectUid,
      binding.projectInstanceId,
    );
    if (
      controlStore.directory !== expectedDirectory
      || controlStore.incarnationId !== binding.controlIncarnationId
    ) throw recoveryRequired('MigrationJournal ControlStore binding is foreign');
    const clock = descriptors.clock.value;
    if (typeof clock !== 'function') throw new TypeError('clock is required');
    const record = {
      owner: Object.freeze({}),
      binding,
      control: Object.freeze(control),
      routeDisposition: capturePort(descriptors.routeDisposition.value, ['classify', 'inspect'], 'routeDisposition'),
      childDisposition: capturePort(descriptors.childDisposition.value, ['classify', 'inspect'], 'childDisposition'),
      databaseDisposition: capturePort(descriptors.databaseDisposition.value, ['classify', 'inspect'], 'databaseDisposition'),
      cleanupDisposition: capturePort(descriptors.cleanupDisposition.value, ['classify', 'inspect'], 'cleanupDisposition'),
      clock,
      parsed: null,
      authority: null,
      reservedEvents: new Map(),
      reservationSource: null,
    };
    journalRecords.set(this, record);
    Object.freeze(this);
  }

  authority() {
    const record = journalRecords.get(this);
    if (record.authority !== null) return record.authority;
    const readObservation = () => {
      const parsed = parse(record);
      const current = parsed.unresolved[0]
        ?? Array.from(parsed.migrations.values()).at(-1)
        ?? null;
      const observation = Object.freeze(() => {});
      observationAuthorities.set(observation, Object.freeze({
        owner: record.owner,
        tailDigest: parsed.tailDigest,
        migrationId: current?.migrationId ?? null,
        state: current?.state ?? 'none',
        eventDigest: current?.eventDigest ?? null,
      }));
      return observation;
    };
    const assertObservation = (observation) => {
      const owned = observationAuthorities.get(observation);
      if (owned?.owner !== record.owner) throw new TypeError('observation is foreign');
      return owned;
    };
    record.authority = Object.freeze({
      readObservation,
      describeObservation(observation) {
        const owned = assertObservation(observation);
        const aggregate = owned.migrationId === null
          ? null
          : requireAggregate(record, owned.migrationId);
        const reservation = aggregate === null ? null : reservationOf(aggregate);
        return Object.freeze({
          projectUid: record.binding.projectUid,
          projectInstanceId: record.binding.projectInstanceId,
          migrationId: owned.migrationId,
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
        if (current.tailDigest !== owned.tailDigest) throw recoveryRequired('journal observation is stale');
        const descriptors = exactDescriptors(transition, ['expected', 'next'], 'route transition');
        const expected = descriptors.expected.value;
        const next = descriptors.next.value;
        const allowed = (
          (owned.state === 'migration_reserved' && expected === 'sqlite' && next === 'migrating')
          || (owned.state === 'migration_abort_intent' && expected === 'migrating' && next === 'sqlite')
          || (owned.state === 'activation_intent' && expected === 'migrating' && next === 'files')
        );
        if (!allowed) throw recoveryRequired('route transition is not authorized by migration state');
        const proof = Object.freeze(() => {});
        transitionProofAuthorities.set(proof, Object.freeze({
          owner: record.owner,
          migrationId: owned.migrationId,
          eventDigest: owned.eventDigest,
          expected,
          next,
        }));
        return proof;
      },
      assertMigrationContext(context) {
        const owned = migrationContextAuthorities.get(context);
        if (owned?.owner !== record.owner) throw new TypeError('MigrationContext is foreign');
        const aggregate = requireAggregate(record, owned.migrationId);
        if (
          aggregate.state !== 'activation_intent'
          || aggregate.eventDigest !== owned.eventDigest
          || digestPlain(context) !== owned.contextDigest
        ) throw recoveryRequired('MigrationContext is stale or changed', {
          migrationId: owned.migrationId,
        });
        return context;
      },
      readMigrationReserved(migrationId) {
        const safeMigrationId = assertCanonicalUuid(migrationId, 'migration_id');
        const aggregate = parse(record).migrations.get(safeMigrationId) ?? null;
        if (aggregate === null) return null;
        const first = aggregate.history[0];
        const cached = record.reservedEvents.get(safeMigrationId);
        if (cached?.eventDigest === first.eventDigest) return cached.authority;
        const authority = Object.freeze(() => {});
        reservedEventAuthorities.set(authority, Object.freeze({
          owner: record.owner,
          migrationId: aggregate.migrationId,
          eventDigest: first.eventDigest,
        }));
        record.reservedEvents.set(safeMigrationId, Object.freeze({
          authority,
          eventDigest: first.eventDigest,
        }));
        return authority;
      },
      describeMigrationReserved(authority) {
        const owned = reservedEventAuthorities.get(authority);
        if (owned?.owner !== record.owner) throw new TypeError('migration_reserved event is foreign');
        const aggregate = requireAggregate(record, owned.migrationId);
        const first = aggregate.history[0];
        if (first.eventDigest !== owned.eventDigest) throw recoveryRequired('migration_reserved changed');
        return first.data;
      },
    });
    return record.authority;
  }

  reservationSource() {
    const record = journalRecords.get(this);
    if (record.reservationSource !== null) return record.reservationSource;
    record.reservationSource = Object.freeze({
      enumerate(scope) {
        const safeScope = snapshotPlain(scope, 'reservation scope');
        const records = [];
        for (const aggregate of parse(record).migrations.values()) {
          if (aggregate.state === 'activated') continue;
          const reservation = reservationOf(aggregate).migrationReservation;
          const candidates = [
            ...(reservation.projectReservation ? [Object.freeze({
              objectKind: 'project',
              reservationId: reservation.projectReservation.reservationId,
              uid: reservation.projectReservation.uid,
            })] : []),
            ...(Array.isArray(reservation.localIdentityPlan) ? reservation.localIdentityPlan : []),
          ];
          for (const candidate of candidates) {
            if (candidate.objectKind !== safeScope.objectKind) continue;
            records.push(Object.freeze({
              ownerKind: 'migration',
              ownerId: aggregate.migrationId,
              reservationId: candidate.reservationId,
              uid: candidate.uid,
            }));
          }
        }
        records.sort((left, right) => (
          left.ownerId.localeCompare(right.ownerId)
          || left.reservationId.localeCompare(right.reservationId)
          || left.uid.localeCompare(right.uid)
        ));
        return Object.freeze({
          complete: true,
          projectUid: safeScope.projectUid ?? null,
          projectInstanceId: safeScope.projectInstanceId ?? null,
          objectKind: safeScope.objectKind,
          records: Object.freeze(records),
        });
      },
    });
    return record.reservationSource;
  }

  async reserve(input) {
    const record = journalRecords.get(this);
    const descriptors = exactDescriptors(input, [
      'baseGeneration',
      'logicalRequestId',
      'migrationId',
      'migrationReservation',
      'sourceBasisDigest',
      'targetGeneration',
    ], 'migration reserve input');
    const migrationId = assertCanonicalUuid(descriptors.migrationId.value, 'migration_id');
    const current = parse(record).migrations.get(migrationId);
    if (current) {
      const candidate = {
        migrationId,
        logicalRequestId: assertNonEmpty(descriptors.logicalRequestId.value, 'logicalRequestId'),
        baseGeneration: assertGeneration(descriptors.baseGeneration.value, 'baseGeneration'),
        targetGeneration: assertGeneration(descriptors.targetGeneration.value, 'targetGeneration'),
        sourceBasisDigest: assertDigest(descriptors.sourceBasisDigest.value, 'sourceBasisDigest'),
        migrationReservation: snapshotPlain(descriptors.migrationReservation.value, 'migrationReservation'),
      };
      const persisted = reservationOf(current);
      if (digestPlain(candidate) !== persisted.reservationDigest) {
        throw recoveryRequired('migration ID is already bound to another reservation', { migrationId });
      }
      return mintStage(record, current);
    }
    if (parse(record).unresolved.length !== 0) {
      throw recoveryRequired('another migration is unresolved');
    }
    const baseGeneration = assertGeneration(descriptors.baseGeneration.value, 'baseGeneration');
    const targetGeneration = assertGeneration(descriptors.targetGeneration.value, 'targetGeneration');
    if (targetGeneration !== baseGeneration + 1) throw new TypeError('targetGeneration must equal baseGeneration + 1');
    const source = {
      migrationId,
      logicalRequestId: assertNonEmpty(descriptors.logicalRequestId.value, 'logicalRequestId'),
      baseGeneration,
      targetGeneration,
      sourceBasisDigest: assertDigest(descriptors.sourceBasisDigest.value, 'sourceBasisDigest'),
      migrationReservation: snapshotPlain(descriptors.migrationReservation.value, 'migrationReservation'),
    };
    const data = Object.freeze({
      version: VERSION,
      projectUid: record.binding.projectUid,
      projectInstanceId: record.binding.projectInstanceId,
      ...source,
      reservationDigest: digestPlain(source),
      createdAt: assertGeneration(record.clock(), 'createdAt'),
    });
    append(record, migrationId, 'migration_reserved', null, data);
    return mintStage(record, requireAggregate(record, migrationId));
  }

  read(migrationId) {
    return stateView(requireAggregate(journalRecords.get(this), migrationId));
  }

  async recordRouteFenced(authority, routeEvidence, directoryPlan) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'migration_reserved');
    if (classify(record, 'routeDisposition', routeEvidence, aggregate) !== 'after') {
      throw recoveryRequired('route fence is not proven after', { migrationId: aggregate.migrationId });
    }
    append(record, aggregate.migrationId, 'route_fenced', aggregate.state, {
      reservationDigest: reservationOf(aggregate).reservationDigest,
      routeEvidenceDigest: digestPlain(snapshotPlain(routeEvidence, 'routeEvidence')),
      directoryPlan: snapshotPlain(directoryPlan, 'directoryPlan'),
    });
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  async recordSourceSnapshot(authority, sourceSnapshot) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'route_fenced');
    const snapshot = snapshotPlain(sourceSnapshot, 'sourceSnapshot');
    append(record, aggregate.migrationId, 'source_snapshot_ready', aggregate.state, {
      sourceSnapshot: snapshot,
      sourceSnapshotDigest: digestPlain(snapshot),
    });
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  async recordFilesCandidate(authority, input) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'source_snapshot_ready');
    const descriptors = exactDescriptors(input, [
      'childJournalId',
      'childReservation',
      'closureDigest',
      'logicalRequestId',
      'partialManifest',
      'projectionBasisDigest',
      'targetBindingDigest',
      'targetGeneration',
    ], 'files candidate');
    const reservation = reservationOf(aggregate);
    if (
      descriptors.logicalRequestId.value !== reservation.logicalRequestId
      || descriptors.targetGeneration.value !== reservation.targetGeneration
    ) throw recoveryRequired('files candidate does not match the reservation');
    append(record, aggregate.migrationId, 'files_candidate_ready', aggregate.state, {
      childJournalId: assertCanonicalUuid(descriptors.childJournalId.value, 'child_journal_id'),
      logicalRequestId: reservation.logicalRequestId,
      projectionBasisDigest: assertDigest(descriptors.projectionBasisDigest.value, 'projectionBasisDigest'),
      closureDigest: assertDigest(descriptors.closureDigest.value, 'closureDigest'),
      targetGeneration: reservation.targetGeneration,
      targetBindingDigest: assertDigest(descriptors.targetBindingDigest.value, 'targetBindingDigest'),
      childReservation: snapshotPlain(descriptors.childReservation.value, 'childReservation'),
      partialManifest: snapshotPlain(descriptors.partialManifest.value, 'partialManifest'),
    });
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  async recordFilePublicationStarted(authority, input) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'files_candidate_ready');
    const descriptors = exactDescriptors(input, ['manifest'], 'file publication pin');
    const manifest = snapshotPlain(descriptors.manifest.value, 'manifest');
    append(record, aggregate.migrationId, 'file_publication_started', aggregate.state, {
      manifest,
      manifestDigest: digestPlain(manifest),
    });
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  async recordFilesPublished(authority, childEvidence) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'file_publication_started');
    if (classify(record, 'childDisposition', childEvidence, aggregate) !== 'after') {
      throw recoveryRequired('child publication is not proven after', { migrationId: aggregate.migrationId });
    }
    append(record, aggregate.migrationId, 'files_published', aggregate.state, {
      childEvidenceDigest: digestPlain(snapshotPlain(childEvidence, 'childEvidence')),
    });
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  async recordDatabaseCandidate(authority, candidate) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'files_published');
    const descriptors = exactDescriptors(candidate, [
      'candidatePath',
      'candidateDigest',
      'candidateIdentity',
      'sourceIdentity',
      'sourcePath',
      'sourceSha256',
      'transitionProofDigest',
    ], 'database candidate');
    const data = Object.freeze({
      sourcePath: assertCanonicalAbsolutePath(descriptors.sourcePath.value, 'sourcePath'),
      sourceIdentity: snapshotIdentity(descriptors.sourceIdentity.value, 'sourceIdentity'),
      sourceSha256: assertDigest(descriptors.sourceSha256.value, 'sourceSha256'),
      candidatePath: assertCanonicalAbsolutePath(descriptors.candidatePath.value, 'candidatePath'),
      candidateDigest: assertDigest(descriptors.candidateDigest.value, 'candidateDigest'),
      candidateIdentity: snapshotIdentity(descriptors.candidateIdentity.value, 'candidateIdentity'),
      transitionProofDigest: assertDigest(descriptors.transitionProofDigest.value, 'transitionProofDigest'),
    });
    const capturedSource = aggregate.history.find(
      (event) => event.state === 'source_snapshot_ready',
    )?.data.sourceSnapshot;
    if (
      capturedSource
      && (
        (Object.hasOwn(capturedSource, 'sourcePath')
          && capturedSource.sourcePath !== data.sourcePath)
        || (Object.hasOwn(capturedSource, 'sourceIdentity')
          && !sameIdentity(capturedSource.sourceIdentity, data.sourceIdentity))
        || (Object.hasOwn(capturedSource, 'sourceSha256')
          && capturedSource.sourceSha256 !== data.sourceSha256)
      )
    ) throw recoveryRequired('database candidate differs from the durable source snapshot', {
      migrationId: aggregate.migrationId,
    });
    append(record, aggregate.migrationId, 'database_candidate_ready', aggregate.state, data);
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  async beginActivation(authority) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'database_candidate_ready');
    append(record, aggregate.migrationId, 'activation_intent', aggregate.state, {
      databaseCandidateDigest: aggregate.data.candidateDigest,
    });
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  prepareMigrationContext(authority, input) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'activation_intent');
    const descriptors = exactDescriptors(input, [
      'candidateIdentity',
      'candidatePath',
      'candidateSha256',
      'sourceIdentity',
      'sourcePath',
      'sourceSha256',
    ], 'MigrationContext physical input');
    const reservation = reservationOf(aggregate);
    const sourcePath = assertCanonicalAbsolutePath(descriptors.sourcePath.value, 'sourcePath');
    const candidatePath = assertCanonicalAbsolutePath(descriptors.candidatePath.value, 'candidatePath');
    if (candidatePath === sourcePath) throw new TypeError('candidatePath must differ from sourcePath');
    const sourceIdentity = snapshotIdentity(descriptors.sourceIdentity.value, 'sourceIdentity');
    const sourceSha256 = assertDigest(descriptors.sourceSha256.value, 'sourceSha256');
    const candidateIdentity = snapshotIdentity(descriptors.candidateIdentity.value, 'candidateIdentity');
    const candidateSha256 = assertDigest(descriptors.candidateSha256.value, 'candidateSha256');
    const persisted = aggregate.history.find(
      (event) => event.state === 'database_candidate_ready',
    )?.data;
    if (
      persisted === undefined
      || aggregate.data.databaseCandidateDigest !== persisted.candidateDigest
      || sourcePath !== persisted.sourcePath
      || !sameIdentity(sourceIdentity, persisted.sourceIdentity)
      || sourceSha256 !== persisted.sourceSha256
      || candidatePath !== persisted.candidatePath
      || !sameIdentity(candidateIdentity, persisted.candidateIdentity)
      || candidateSha256 !== persisted.candidateDigest
    ) throw recoveryRequired('MigrationContext differs from the durable database candidate', {
      migrationId: aggregate.migrationId,
    });
    const context = Object.freeze({
      kind: 'migration',
      migrationId: aggregate.migrationId,
      projectUid: record.binding.projectUid,
      projectInstanceId: record.binding.projectInstanceId,
      sourcePath,
      sourceIdentity,
      sourceSha256,
      candidatePath,
      candidateIdentity,
      candidateSha256,
      journalTailDigest: aggregate.eventDigest,
      reservationDigest: reservation.reservationDigest,
      baseGeneration: reservation.baseGeneration,
      targetGeneration: reservation.targetGeneration,
    });
    migrationContextAuthorities.set(context, Object.freeze({
      owner: record.owner,
      migrationId: aggregate.migrationId,
      eventDigest: aggregate.eventDigest,
      contextDigest: digestPlain(context),
    }));
    return context;
  }

  async recordActivated(authority, databaseEvidence) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'activation_intent');
    if (classify(record, 'databaseDisposition', databaseEvidence, aggregate) !== 'after') {
      throw recoveryRequired('activation is not proven after', { migrationId: aggregate.migrationId });
    }
    append(record, aggregate.migrationId, 'activated', aggregate.state, {
      databaseEvidenceDigest: digestPlain(snapshotPlain(databaseEvidence, 'databaseEvidence')),
    });
    return Object.freeze({ migrationId: aggregate.migrationId, state: 'activated' });
  }

  async beginAbort(input) {
    const record = journalRecords.get(this);
    const descriptors = exactDescriptors(input, ['migrationId', 'reason'], 'migration abort input');
    const aggregate = requireAggregate(record, descriptors.migrationId.value);
    if (['activation_intent', 'activated', 'migration_aborted'].includes(aggregate.state)) {
      throw recoveryRequired('migration can no longer abort', { migrationId: aggregate.migrationId });
    }
    append(record, aggregate.migrationId, 'migration_abort_intent', aggregate.state, {
      reason: assertNonEmpty(descriptors.reason.value, 'reason'),
      priorEventDigest: aggregate.eventDigest,
    });
    return mintStage(record, requireAggregate(record, aggregate.migrationId));
  }

  async recordAborted(authority, cleanupEvidence) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'migration_abort_intent');
    if (classify(record, 'cleanupDisposition', cleanupEvidence, aggregate) !== 'after') {
      throw recoveryRequired('migration cleanup is not proven after', { migrationId: aggregate.migrationId });
    }
    append(record, aggregate.migrationId, 'migration_aborted', aggregate.state, {
      cleanupEvidenceDigest: digestPlain(snapshotPlain(cleanupEvidence, 'cleanupEvidence')),
    });
    return Object.freeze({ migrationId: aggregate.migrationId, state: 'migration_aborted' });
  }

  async recover(migrationId) {
    const record = journalRecords.get(this);
    let aggregate = requireAggregate(record, migrationId);
    if (TERMINAL.has(aggregate.state)) {
      return Object.freeze({ migrationId: aggregate.migrationId, state: aggregate.state });
    }
    if (aggregate.state === 'migration_reserved') {
      const route = await inspect(record, 'routeDisposition', aggregate);
      if (route.disposition === 'before') return stateView(aggregate);
      if (route.disposition !== 'after') throw recoveryRequired('route fence disposition is unknown');
      const directoryPlan = route.evidence?.directoryPlan;
      if (directoryPlan === undefined) {
        throw recoveryRequired('route fence recovery lacks the frozen safe directory plan', {
          migrationId: aggregate.migrationId,
        });
      }
      await this.recordRouteFenced(mintStage(record, aggregate), route.evidence, directoryPlan);
      aggregate = requireAggregate(record, migrationId);
    }
    if (aggregate.state === 'activation_intent') {
      const child = await inspect(record, 'childDisposition', aggregate);
      const route = await inspect(record, 'routeDisposition', aggregate);
      const database = await inspect(record, 'databaseDisposition', aggregate);
      if (
        child.disposition !== 'after'
        || route.disposition !== 'after'
        || database.disposition !== 'after'
      ) throw recoveryRequired('activation prerequisites are not all proven after');
      return this.recordActivated(mintStage(record, aggregate), database.evidence);
    }
    if (aggregate.state === 'migration_abort_intent') {
      const cleanup = await inspect(record, 'cleanupDisposition', aggregate);
      if (cleanup.disposition !== 'after') throw recoveryRequired('abort cleanup disposition is not after');
      return this.recordAborted(mintStage(record, aggregate), cleanup.evidence);
    }
    return stateView(aggregate);
  }

  async authorizeGc(migrationId, input) {
    const record = journalRecords.get(this);
    const aggregate = requireAggregate(record, migrationId);
    if (!TERMINAL.has(aggregate.state)) throw recoveryRequired('migration is not terminal');
    const descriptors = exactDescriptors(input, ['childState', 'noReferences'], 'migration gc input');
    const childState = descriptors.childState.value;
    const expected = aggregate.state === 'activated' ? 'files_published' : 'rolled_back';
    if (childState !== expected || descriptors.noReferences.value !== true) {
      throw recoveryRequired('migration GC remains referenced');
    }
    const authority = Object.freeze(() => {});
    const pin = aggregate.history.find((event) => event.state === 'file_publication_started');
    gcAuthorities.set(authority, Object.freeze({
      owner: record.owner,
      migrationId: aggregate.migrationId,
      eventDigest: aggregate.eventDigest,
      childState,
      manifestDigest: pin?.data.manifestDigest ?? null,
    }));
    return authority;
  }
}

class MigrationFilePublicationParentAuthority {
  constructor(journal) {
    if (!journalRecords.has(journal)) throw new TypeError('journal must be a MigrationJournal');
    journalRecords.set(this, journalRecords.get(journal));
    Object.freeze(this);
  }

  async assertReservation({ authority, parent, childReservation }) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'files_candidate_ready');
    const descriptors = exactDescriptors(parent, ['journalId', 'kind'], 'parent');
    if (descriptors.kind.value !== 'migration' || descriptors.journalId.value !== aggregate.migrationId) {
      throw new TypeError('parent does not identify this migration');
    }
    const safeChild = snapshotPlain(childReservation, 'childReservation');
    if (safeChild.record_kind === 'reservation') {
      const reservation = reservationOf(aggregate);
      if (
        safeChild.version !== 1
        || safeChild.journalId !== aggregate.data.childJournalId
        || safeChild.mode !== 'file_only'
        || safeChild.parent?.kind !== 'migration'
        || safeChild.parent?.journalId !== aggregate.migrationId
        || safeChild.logicalRequestId !== reservation.logicalRequestId
        || safeChild.baseGeneration !== reservation.baseGeneration
        || safeChild.targetGeneration !== reservation.targetGeneration
        || safeChild.basisDigest !== aggregate.data.projectionBasisDigest
        || safeChild.projectBinding?.projectUid !== record.binding.projectUid
        || safeChild.projectBinding?.projectInstanceId !== record.binding.projectInstanceId
        || digestPlain(safeChild.identityReservation) !== digestPlain(reservation.migrationReservation)
      ) throw recoveryRequired('child reservation does not match the durable migration binding');
    } else if (digestPlain(safeChild) !== digestPlain(aggregate.data.childReservation)) {
      throw recoveryRequired('child reservation changed');
    }
  }

  async assertPin({ authority, parent, manifest }) {
    const record = journalRecords.get(this);
    const aggregate = assertStage(record, authority, 'file_publication_started');
    const descriptors = exactDescriptors(parent, ['journalId', 'kind'], 'parent');
    if (descriptors.kind.value !== 'migration' || descriptors.journalId.value !== aggregate.migrationId) {
      throw new TypeError('parent does not identify this migration');
    }
    if (digestPlain(snapshotPlain(manifest, 'manifest')) !== aggregate.data.manifestDigest) {
      throw recoveryRequired('child manifest does not match the durable pin');
    }
  }

  async readRecoveryIntent({ authority, parent, assetManifest }) {
    const record = journalRecords.get(this);
    const owned = stageAuthorities.get(authority);
    if (owned?.owner !== record.owner) throw new TypeError('parent recovery authority is foreign');
    const aggregate = requireAggregate(record, owned.migrationId);
    const descriptors = exactDescriptors(parent, ['journalId', 'kind'], 'parent');
    if (descriptors.kind.value !== 'migration' || descriptors.journalId.value !== aggregate.migrationId) {
      throw new TypeError('parent does not identify this migration');
    }
    const pin = aggregate.history.find((event) => event.state === 'file_publication_started');
    const candidate = aggregate.history.find((event) => event.state === 'files_candidate_ready');
    const expected = pin?.data.manifest ?? candidate?.data.partialManifest;
    if (!expected || digestPlain(snapshotPlain(assetManifest, 'assetManifest')) !== digestPlain(expected)) {
      throw recoveryRequired('asset manifest does not match parent evidence');
    }
    return aggregate.state === 'migration_abort_intent' ? 'before' : 'after';
  }

  async assertGc({ authority, parent, assetManifest, childState }) {
    const record = journalRecords.get(this);
    const owned = gcAuthorities.get(authority);
    if (owned?.owner !== record.owner) throw new TypeError('parent GC authority is foreign');
    const aggregate = requireAggregate(record, owned.migrationId);
    const descriptors = exactDescriptors(parent, ['journalId', 'kind'], 'parent');
    if (
      descriptors.kind.value !== 'migration'
      || descriptors.journalId.value !== aggregate.migrationId
      || childState !== owned.childState
      || aggregate.eventDigest !== owned.eventDigest
      || digestPlain(snapshotPlain(assetManifest, 'assetManifest')) !== owned.manifestDigest
    ) throw recoveryRequired('parent GC authority does not match the terminal migration');
  }
}

module.exports = {
  MigrationFilePublicationParentAuthority,
  MigrationJournal,
};
