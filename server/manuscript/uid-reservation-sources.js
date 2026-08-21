'use strict';

const {
  validateCreationReservationManifest,
} = require('./uid-reservation');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OWNER_KINDS = new Set([
  'creation',
  'existing_root',
  'file_publication',
  'migration',
  'registry',
]);

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) invalid(`${label} has an invalid shape`);
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

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    invalid(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${label} must be a non-empty string`);
  }
  return value;
}

function sourcePort(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.enumerate !== 'function'
  ) invalid(`${label} must provide enumerate()`);
  return value.enumerate.bind(value);
}

function denseSources(value, label, port = sourcePort) {
  if (!Array.isArray(value) || !Object.isFrozen(value)) {
    invalid(`${label} must be an explicit frozen array`);
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${label} must be dense`);
    result.push(port(value[index], `${label}[${index}]`));
  }
  return result;
}

function creationSourcePort(value, label) {
  const enumerate = sourcePort(value, label);
  if (typeof value.lookup !== 'function') invalid(`${label} must provide lookup()`);
  return Object.freeze({ enumerate, lookup: value.lookup.bind(value) });
}

function normalizeScope(value) {
  const scope = exactObject(
    value,
    ['projectUid', 'projectInstanceId', 'objectKind'],
    'reservation source scope',
  );
  canonicalUuid(scope.projectInstanceId, 'reservation source scope.projectInstanceId');
  if (!['chapter', 'project', 'volume'].includes(scope.objectKind)) {
    invalid('reservation source scope.objectKind is invalid');
  }
  if (scope.projectUid !== null) canonicalUuid(scope.projectUid, 'reservation source scope.projectUid');
  if (scope.objectKind === 'project' && scope.projectUid !== null) {
    invalid('global project scope must use projectUid null');
  }
  return Object.freeze({ ...scope });
}

function normalizeSnapshot(value, scope, label) {
  const snapshot = exactObject(
    value,
    ['complete', 'projectUid', 'projectInstanceId', 'objectKind', 'records'],
    label,
  );
  if (
    snapshot.complete !== true
    || snapshot.projectUid !== scope.projectUid
    || snapshot.projectInstanceId !== scope.projectInstanceId
    || snapshot.objectKind !== scope.objectKind
    || !Array.isArray(snapshot.records)
  ) invalid(`${label} is incomplete or has the wrong scope`);
  for (let index = 0; index < snapshot.records.length; index += 1) {
    if (!Object.hasOwn(snapshot.records, index)) invalid(`${label}.records must be dense`);
  }
  return snapshot.records.map((entry, index) => {
    const record = exactObject(
      entry,
      ['ownerKind', 'ownerId', 'reservationId', 'uid'],
      `${label}.records[${index}]`,
    );
    if (!OWNER_KINDS.has(record.ownerKind)) invalid(`${label} ownerKind is invalid`);
    nonEmptyString(record.ownerId, `${label}.records[${index}].ownerId`);
    nonEmptyString(record.reservationId, `${label}.records[${index}].reservationId`);
    canonicalUuid(record.uid, `${label}.records[${index}].uid`);
    return Object.freeze({ ...record });
  });
}

function normalizeLookupInput(value) {
  const input = exactObject(value, ['logicalRequestId'], 'creation reservation lookup');
  return Object.freeze({
    logicalRequestId: nonEmptyString(input.logicalRequestId, 'logicalRequestId'),
  });
}

function normalizeCreationLookup(value, input, label) {
  const snapshot = exactObject(
    value,
    ['complete', 'logicalRequestId', 'reservations'],
    label,
  );
  if (
    snapshot.complete !== true
    || snapshot.logicalRequestId !== input.logicalRequestId
    || !Array.isArray(snapshot.reservations)
  ) invalid(`${label} is incomplete or has the wrong logical request`);
  const reservations = [];
  for (let index = 0; index < snapshot.reservations.length; index += 1) {
    if (!Object.hasOwn(snapshot.reservations, index)) {
      invalid(`${label}.reservations must be dense`);
    }
    reservations.push(validateCreationReservationManifest(
      snapshot.reservations[index],
    ));
  }
  return reservations;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareRecords(left, right) {
  return utf8Compare(left.ownerId, right.ownerId)
    || utf8Compare(left.reservationId, right.reservationId)
    || utf8Compare(left.uid, right.uid)
    || utf8Compare(left.ownerKind, right.ownerKind);
}

function sameRecord(left, right) {
  return left.ownerKind === right.ownerKind
    && left.ownerId === right.ownerId
    && left.reservationId === right.reservationId
    && left.uid === right.uid;
}

function creationReservationKey(reservation) {
  return JSON.stringify(reservation);
}

function createUidReservationSources(options) {
  const value = exactObject(
    options,
    ['registrySource', 'existingRootsSource', 'migrationSources', 'creationSources'],
    'UID reservation source options',
  );
  const migrationEnumerators = denseSources(value.migrationSources, 'migrationSources');
  const creationPorts = denseSources(
    value.creationSources,
    'creationSources',
    creationSourcePort,
  );
  if (creationPorts.length === 0) {
    invalid('creationSources must contain at least one complete adapter');
  }
  const enumerators = [
    sourcePort(value.registrySource, 'registrySource'),
    sourcePort(value.existingRootsSource, 'existingRootsSource'),
    ...migrationEnumerators,
    ...creationPorts.map((port) => port.enumerate),
  ];

  return Object.freeze({
    async enumerate(scopeInput) {
      const scope = normalizeScope(scopeInput);
      const records = [];
      for (let index = 0; index < enumerators.length; index += 1) {
        const snapshot = await enumerators[index](scope);
        records.push(...normalizeSnapshot(snapshot, scope, `reservation source[${index}]`));
      }
      records.sort(compareRecords);
      const byUid = new Map();
      const byReservationId = new Map();
      const deduplicated = [];
      for (const record of records) {
        const uidMatch = byUid.get(record.uid);
        const reservationMatch = byReservationId.get(record.reservationId);
        if (
          (uidMatch !== undefined && !sameRecord(uidMatch, record))
          || (reservationMatch !== undefined && !sameRecord(reservationMatch, record))
        ) invalid('UID reservation sources returned conflicting duplicate bindings');
        if (uidMatch === undefined && reservationMatch === undefined) {
          deduplicated.push(record);
        }
        byUid.set(record.uid, record);
        byReservationId.set(record.reservationId, record);
      }
      return Object.freeze({
        complete: true,
        projectUid: scope.projectUid,
        projectInstanceId: scope.projectInstanceId,
        objectKind: scope.objectKind,
        records: Object.freeze(deduplicated),
      });
    },
    async lookupCreation(inputValue) {
      const input = normalizeLookupInput(inputValue);
      const reservations = [];
      for (let index = 0; index < creationPorts.length; index += 1) {
        const snapshot = await creationPorts[index].lookup(input);
        reservations.push(...normalizeCreationLookup(
          snapshot,
          input,
          `creation reservation source[${index}]`,
        ));
      }
      const unique = new Map();
      const uidBindings = new Map();
      const reservationIdBindings = new Map();
      for (const reservation of reservations) {
        const key = creationReservationKey(reservation);
        for (const uid of [reservation.creationId, reservation.projectReservation.uid]) {
          const prior = uidBindings.get(uid);
          if (prior !== undefined && prior !== key) {
            invalid('creation reservation lookup returned conflicting duplicate UIDs');
          }
          uidBindings.set(uid, key);
        }
        for (const reservationId of [
          reservation.reservationId,
          reservation.projectReservation.reservationId,
        ]) {
          const prior = reservationIdBindings.get(reservationId);
          if (prior !== undefined && prior !== key) {
            invalid('creation reservation lookup returned conflicting duplicate reservationIds');
          }
          reservationIdBindings.set(reservationId, key);
        }
        if (!unique.has(key)) unique.set(key, reservation);
      }
      if (unique.size > 1) {
        invalid('creation reservation lookup returned multiple durable reservations');
      }
      return unique.values().next().value ?? null;
    },
  });
}

module.exports = {
  createUidReservationSources,
};
