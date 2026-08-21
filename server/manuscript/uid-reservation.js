'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');

const { LIMITS, manuscriptError } = require('./contracts');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('./projection-store');

const RESERVATION_DOMAIN = 'mythpen.manuscript.uid-reservation';
const RESERVATION_VERSION = 1;
const CREATE_LOGICAL_INPUT_DOMAIN = 'mythpen.manuscript.create-logical-input';
const CREATE_LOGICAL_INPUT_VERSION = 1;
const MAX_UID_ATTEMPTS = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_OWNER_KINDS = new Set(['file_publication', 'migration']);
const CHAPTER_STATUSES = new Set(['pending', 'writing', 'review', 'accepted']);
const CHAPTER_SIDECAR_KEYS = Object.freeze([
  'title',
  'outline',
  'status',
  'summary',
  'cognitive_frame',
  'emotional_anchor',
  'world_texture',
  'concrete_mystery',
  'interpersonal_tension',
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
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== 'string')) invalid(`${label} has an inexact key set`);
  const sortedActual = actual.sort();
  const sortedExpected = [...keys].sort();
  if (
    sortedActual.length !== sortedExpected.length
    || sortedActual.some((key, index) => key !== sortedExpected[index])
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
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid(`${label} contains a non-canonical number`);
    return;
  }
  if (typeof value !== 'object' || active.has(value) || !Object.isFrozen(value)) {
    invalid(`${label} must be deeply frozen finite plain data`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      for (const [index, child] of denseArray(value, label).entries()) {
        assertDeepFrozenPlainData(child, `${label}[${index}]`, active);
      }
      return;
    }
    if (!isPlainObject(value)) invalid(`${label} must contain plain data`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
        invalid(`${label} must contain enumerable data properties only`);
      }
      assertDeepFrozenPlainData(descriptor.value, `${label}.${key}`, active);
    }
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) {
      invalid(`${label} must not contain symbol properties`);
    }
  } finally {
    active.delete(value);
  }
}

function denseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      invalid(`${label} must be dense data`);
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      invalid(`${label} has an invalid array property`);
    }
  }
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    invalid(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalid(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${label} must be a positive safe integer`);
  return value;
}

function canonicalDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function recoveryRequired(reason, cause) {
  return manuscriptError('RECOVERY_REQUIRED', { reason }, cause);
}

function canonicalCreateLogicalInputDigest(command) {
  if (!isPlainObject(command)) invalid('create command must be a plain object');
  const kindDescriptor = Object.getOwnPropertyDescriptor(command, 'kind');
  if (
    kindDescriptor === undefined
    || kindDescriptor.enumerable !== true
    || !Object.hasOwn(kindDescriptor, 'value')
  ) invalid('create command.kind must be an enumerable data property');

  let material;
  if (kindDescriptor.value === 'volume.create') {
    const value = exactObject(command, ['kind', 'title', 'summary'], 'volume create command');
    if (typeof value.title !== 'string' || typeof value.summary !== 'string') {
      invalid('volume create text fields must be strings');
    }
    material = {
      domain: CREATE_LOGICAL_INPUT_DOMAIN,
      version: CREATE_LOGICAL_INPUT_VERSION,
      kind: 'volume.create',
      title: value.title,
      summary: value.summary,
    };
  } else if (kindDescriptor.value === 'chapter.create') {
    const value = exactObject(command, [
      'kind',
      'containerVolumeUid',
      'requestedNum',
      'content',
      'sidecar',
    ], 'chapter create command');
    if (value.containerVolumeUid !== null) {
      canonicalUuid(value.containerVolumeUid, 'chapter create containerVolumeUid');
    }
    if (value.requestedNum !== null) {
      positiveInteger(value.requestedNum, 'chapter create requestedNum');
    }
    if (typeof value.content !== 'string') invalid('chapter create content must be a string');
    const sidecar = exactObject(value.sidecar, CHAPTER_SIDECAR_KEYS, 'chapter create sidecar');
    for (const key of CHAPTER_SIDECAR_KEYS) {
      if (typeof sidecar[key] !== 'string') invalid(`chapter create sidecar.${key} must be a string`);
    }
    if (!CHAPTER_STATUSES.has(sidecar.status)) invalid('chapter create sidecar.status is invalid');
    material = {
      domain: CREATE_LOGICAL_INPUT_DOMAIN,
      version: CREATE_LOGICAL_INPUT_VERSION,
      kind: 'chapter.create',
      containerVolumeUid: value.containerVolumeUid,
      requestedNum: value.requestedNum,
      content: value.content,
      sidecar: {
        title: sidecar.title,
        outline: sidecar.outline,
        status: sidecar.status,
        summary: sidecar.summary,
        cognitive_frame: sidecar.cognitive_frame,
        emotional_anchor: sidecar.emotional_anchor,
        world_texture: sidecar.world_texture,
        concrete_mystery: sidecar.concrete_mystery,
        interpersonal_tension: sidecar.interpersonal_tension,
      },
    };
  } else {
    invalid('create command.kind is invalid');
  }
  return createHash('sha256').update(Buffer.from(JSON.stringify(material), 'utf8')).digest('hex');
}

function normalizeCurrentInput(input) {
  const request = exactObject(input, [
    'allocation',
    'currentProjection',
    'ignoredLedgerBefore',
    'kind',
    'logicalInputDigest',
    'logicalRequestId',
    'pathProbe',
  ], 'UID reservation request');
  if (request.kind !== 'chapter' && request.kind !== 'volume') invalid('kind must be chapter or volume');
  nonEmptyString(request.logicalRequestId, 'logicalRequestId');
  canonicalDigest(request.logicalInputDigest, 'logicalInputDigest');
  assertDeepFrozenPlainData(request.currentProjection, 'currentProjection');
  assertDeepFrozenPlainData(request.ignoredLedgerBefore, 'ignoredLedgerBefore');
  const projection = exactObject(
    request.currentProjection,
    ['projectUid', 'projectInstanceId', 'basis'],
    'currentProjection',
  );
  canonicalUuid(projection.projectUid, 'currentProjection.projectUid');
  canonicalUuid(projection.projectInstanceId, 'currentProjection.projectInstanceId');
  const sourceBasisDigest = canonicalProjectionBasisDigest(projection.basis);
  if (projection.basis.sourceKind !== 'schema12') invalid('ordinary UID reservation requires a schema12 basis');
  if (sourceBasisDigest !== projection.basis.basisDigest) invalid('currentProjection basisDigest is stale');
  const ignoredBeforeDigest = canonicalIgnoredLedgerDigest(request.ignoredLedgerBefore);
  if (ignoredBeforeDigest !== projection.basis.ignoredBeforeDigest) {
    invalid('ignoredLedgerBefore does not match the projection basis');
  }
  if (request.ignoredLedgerBefore.some((row) => (
    row.projection_generation !== projection.basis.baseGeneration
  ))) {
    invalid('ignoredLedgerBefore generation does not match the projection basis');
  }
  if (
    request.pathProbe === null
    || typeof request.pathProbe !== 'object'
    || typeof request.pathProbe.probe !== 'function'
  ) {
    invalid('pathProbe must provide probe()');
  }
  return {
    ...request,
    probePath: request.pathProbe.probe.bind(request.pathProbe),
    projection,
    sourceBasisDigest,
  };
}

function normalizeAllocation(kind, allocation, basis) {
  const value = exactObject(
    allocation,
    ['containerVolumeUid', 'requestedNum'],
    'allocation',
  );
  if (kind === 'volume') {
    if (value.containerVolumeUid !== null || value.requestedNum !== null) {
      invalid('volume allocation members must both be null');
    }
    return { id: nextSequenceId(basis, 'volumes') };
  }

  let containerVolumeId = null;
  if (value.containerVolumeUid !== null) {
    canonicalUuid(value.containerVolumeUid, 'allocation.containerVolumeUid');
    const volumeRow = basis.volumes.find((row) => row.uid === value.containerVolumeUid);
    if (volumeRow === undefined || volumeRow.isPresent !== 1) {
      invalid('allocation.containerVolumeUid must identify an active volume');
    }
    containerVolumeId = volumeRow.id;
  }
  if (value.requestedNum !== null) positiveInteger(value.requestedNum, 'allocation.requestedNum');
  const activeNumbers = basis.chapters
    .filter((row) => row.isPresent === 1 && row.volumeId === containerVolumeId)
    .map((row) => row.num);
  let num = value.requestedNum;
  if (num === null) {
    const maximum = activeNumbers.reduce((result, current) => Math.max(result, current), 0);
    if (maximum === Number.MAX_SAFE_INTEGER) invalid('automatic chapter number exceeds the safe integer range');
    num = maximum + 1;
  } else if (activeNumbers.includes(num)) invalid('allocation.requestedNum is already active in the target container');
  return {
    containerVolumeUid: value.containerVolumeUid,
    id: nextSequenceId(basis, 'chapters'),
    num,
    requestedNum: value.requestedNum,
  };
}

function nextSequenceId(basis, name) {
  const sequence = basis.sqliteSequence.find((row) => row.name === name).seq;
  if (sequence === Number.MAX_SAFE_INTEGER) invalid(`${name} sqlite_sequence cannot allocate another id`);
  return sequence + 1;
}

function existingIdentityUids(kind, basis, ignoredLedgerBefore) {
  const result = new Set();
  const rows = kind === 'chapter' ? basis.chapters : basis.volumes;
  for (const row of rows) result.add(row.uid);
  for (const row of ignoredLedgerBefore) {
    if (row.resource_kind === kind) result.add(row.resource_uid);
  }
  return result;
}

function assertIdentityCapacity(kind, identities) {
  const dimension = `${kind}Identities`;
  const observed = identities.size + 1;
  if (observed > LIMITS[dimension]) {
    throw manuscriptError('MANUSCRIPT_CONTENT_TOO_LARGE', {
      dimension,
      observed,
      allowed: LIMITS[dimension],
    });
  }
}

function normalizeSourceSnapshot(value, scope) {
  const snapshot = exactObject(
    value,
    ['complete', 'objectKind', 'projectInstanceId', 'projectUid', 'records'],
    'reservation source snapshot',
  );
  if (
    snapshot.complete !== true
    || snapshot.projectUid !== scope.projectUid
    || snapshot.projectInstanceId !== scope.projectInstanceId
    || snapshot.objectKind !== scope.objectKind
  ) {
    invalid('reservation source snapshot is incomplete or has the wrong scope');
  }
  const uids = new Set();
  const owners = new Set();
  for (const [index, entry] of denseArray(snapshot.records, 'reservation source records').entries()) {
    const record = exactObject(
      entry,
      ['ownerId', 'ownerKind', 'reservationId', 'uid'],
      `reservation source records[${index}]`,
    );
    if (!SOURCE_OWNER_KINDS.has(record.ownerKind)) invalid('reservation source ownerKind is invalid');
    nonEmptyString(record.ownerId, `reservation source records[${index}].ownerId`);
    nonEmptyString(record.reservationId, `reservation source records[${index}].reservationId`);
    canonicalUuid(record.uid, `reservation source records[${index}].uid`);
    const ownerKey = `${record.ownerKind}\0${record.ownerId}\0${record.reservationId}`;
    if (owners.has(ownerKey) || uids.has(record.uid)) invalid('reservation source snapshot contains duplicates');
    owners.add(ownerKey);
    uids.add(record.uid);
  }
  return uids;
}

function portablePathParts(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    invalid('path predicate canonicalPath must be a non-empty path');
  }
  const windows = path.win32.isAbsolute(value);
  const posix = path.posix.isAbsolute(value);
  if (!windows && !posix) invalid('path predicate canonicalPath must be absolute');
  const implementation = windows ? path.win32 : path.posix;
  if (implementation.normalize(value) !== value) invalid('path predicate canonicalPath must be normalized');
  return {
    basename: implementation.basename(value),
    dirname: implementation.dirname(value),
  };
}

function normalizeParentIdentity(value, label) {
  const identity = exactObject(value, ['dev', 'ino'], label);
  for (const key of ['dev', 'ino']) {
    if (typeof identity[key] !== 'string' || !/^[0-9]+$/u.test(identity[key])) {
      invalid(`${label}.${key} must be a decimal string`);
    }
  }
  return { dev: identity.dev, ino: identity.ino };
}

function normalizePathPredicates(value, objectKind, uid) {
  const expectedRoles = objectKind === 'chapter'
    ? ['chapter_body', 'chapter_sidecar']
    : ['volume_index'];
  const predicates = denseArray(value, 'pathPredicates');
  if (predicates.length !== expectedRoles.length) invalid('pathPredicates has the wrong member count');
  let expectedDirectory = null;
  let expectedParent = null;
  return predicates.map((entry, index) => {
    const predicate = exactObject(
      entry,
      ['canonicalPath', 'disposition', 'parentIdentity', 'role'],
      `pathPredicates[${index}]`,
    );
    if (predicate.role !== expectedRoles[index] || predicate.disposition !== 'absent') {
      invalid('pathPredicates has the wrong role or disposition');
    }
    const extension = predicate.role === 'chapter_body' ? 'md' : 'json';
    const prefix = predicate.role === 'volume_index' ? 'vol_' : 'ch_';
    const parts = portablePathParts(predicate.canonicalPath);
    if (parts.basename !== `${prefix}${uid}.${extension}`) {
      invalid('path predicate does not use the canonical reserved UID name');
    }
    const parentIdentity = normalizeParentIdentity(
      predicate.parentIdentity,
      `pathPredicates[${index}].parentIdentity`,
    );
    const parentKey = `${parentIdentity.dev}:${parentIdentity.ino}`;
    if (expectedDirectory === null) {
      expectedDirectory = parts.dirname;
      expectedParent = parentKey;
    } else if (parts.dirname !== expectedDirectory || parentKey !== expectedParent) {
      invalid('pathPredicates must share one verified parent');
    }
    return {
      role: predicate.role,
      canonicalPath: predicate.canonicalPath,
      parentIdentity,
      disposition: 'absent',
    };
  });
}

function normalizePathObservation(value, objectKind, uid) {
  if (!isPlainObject(value)) invalid('path probe result must be a plain object');
  const disposition = Object.getOwnPropertyDescriptor(value, 'disposition');
  if (disposition === undefined || !Object.hasOwn(disposition, 'value')) {
    invalid('path probe result must contain a data disposition');
  }
  const observation = exactObject(
    value,
    ['disposition', ...(disposition.value === 'absent' ? ['pathPredicates'] : [])],
    'path probe result',
  );
  if (observation.disposition === 'collision') return null;
  if (observation.disposition !== 'absent') invalid('path probe did not prove absence');
  return normalizePathPredicates(observation.pathPredicates, objectKind, uid);
}

function reservationIdFor(manifestWithoutId) {
  return createHash('sha256')
    .update('mythpen.manuscript.uid-reservation-id.v1\0', 'utf8')
    .update(JSON.stringify(manifestWithoutId), 'utf8')
    .digest('hex');
}

function canonicalIdentityReservationMaterial(value) {
  if (!isPlainObject(value)) invalid('identity reservation manifest must be a plain object');
  const objectKindDescriptor = Object.getOwnPropertyDescriptor(value, 'objectKind');
  if (
    objectKindDescriptor === undefined
    || objectKindDescriptor.enumerable !== true
    || !Object.hasOwn(objectKindDescriptor, 'value')
  ) invalid('identity reservation objectKind must be an enumerable data property');
  const objectKind = objectKindDescriptor.value;
  if (objectKind !== 'chapter' && objectKind !== 'volume') {
    invalid('identity reservation objectKind is invalid');
  }
  const manifest = exactObject(value, [
    'domain',
    'version',
    'assignmentKind',
    'objectKind',
    'projectUid',
    'projectInstanceId',
    'logicalRequestId',
    'logicalInputDigest',
    'sourceBasisDigest',
    'uid',
    'id',
    ...(objectKind === 'chapter' ? ['num', 'containerVolumeUid', 'requestedNum'] : []),
    'pathPredicates',
    'reservationId',
  ], 'identity reservation manifest');
  if (
    manifest.domain !== RESERVATION_DOMAIN
    || manifest.version !== RESERVATION_VERSION
    || manifest.assignmentKind !== 'reserved_new'
  ) invalid('identity reservation domain/version/assignment kind is invalid');
  canonicalUuid(manifest.projectUid, 'identity reservation projectUid');
  canonicalUuid(manifest.projectInstanceId, 'identity reservation projectInstanceId');
  nonEmptyString(manifest.logicalRequestId, 'identity reservation logicalRequestId');
  canonicalDigest(manifest.logicalInputDigest, 'identity reservation logicalInputDigest');
  canonicalDigest(manifest.sourceBasisDigest, 'identity reservation sourceBasisDigest');
  canonicalUuid(manifest.uid, 'identity reservation uid');
  positiveInteger(manifest.id, 'identity reservation id');
  if (objectKind === 'chapter') {
    positiveInteger(manifest.num, 'identity reservation num');
    if (manifest.containerVolumeUid !== null) {
      canonicalUuid(manifest.containerVolumeUid, 'identity reservation containerVolumeUid');
    }
    if (manifest.requestedNum !== null) {
      positiveInteger(manifest.requestedNum, 'identity reservation requestedNum');
      if (manifest.requestedNum !== manifest.num) {
        invalid('identity reservation requestedNum must equal the final num');
      }
    }
  }
  canonicalDigest(manifest.reservationId, 'identity reservation reservationId');
  const material = {
    domain: RESERVATION_DOMAIN,
    version: RESERVATION_VERSION,
    assignmentKind: 'reserved_new',
    objectKind,
    projectUid: manifest.projectUid,
    projectInstanceId: manifest.projectInstanceId,
    logicalRequestId: manifest.logicalRequestId,
    logicalInputDigest: manifest.logicalInputDigest,
    sourceBasisDigest: manifest.sourceBasisDigest,
    uid: manifest.uid,
    id: manifest.id,
    ...(objectKind === 'chapter' ? {
      num: manifest.num,
      containerVolumeUid: manifest.containerVolumeUid,
      requestedNum: manifest.requestedNum,
    } : {}),
    pathPredicates: normalizePathPredicates(manifest.pathPredicates, objectKind, manifest.uid),
  };
  return { material, reservationId: manifest.reservationId };
}

function validateIdentityReservationManifest(value) {
  const { material, reservationId } = canonicalIdentityReservationMaterial(value);
  const expected = reservationIdFor(material);
  if (reservationId !== expected) invalid('identity reservation checksum is invalid');
  return deepFreeze({ ...material, reservationId: expected });
}

function mintIdentityReservationManifest(material) {
  return validateIdentityReservationManifest({
    ...material,
    reservationId: reservationIdFor(material),
  });
}

class ManuscriptUidReservation {
  #authorities = new WeakMap();

  #enumerateSources;

  #uuidV4;

  constructor(options) {
    const value = exactObject(options, ['reservationSources', 'uuidV4'], 'options');
    if (typeof value.uuidV4 !== 'function') invalid('uuidV4 must be a function');
    if (
      value.reservationSources === null
      || typeof value.reservationSources !== 'object'
      || Array.isArray(value.reservationSources)
      || typeof value.reservationSources.enumerate !== 'function'
    ) {
      invalid('reservationSources must provide enumerate()');
    }
    this.#uuidV4 = value.uuidV4;
    this.#enumerateSources = value.reservationSources.enumerate.bind(value.reservationSources);
  }

  async reserveNewIdentity(input) {
    const request = normalizeCurrentInput(input);
    const allocation = normalizeAllocation(request.kind, request.allocation, request.projection.basis);
    const existingUids = existingIdentityUids(
      request.kind,
      request.projection.basis,
      request.ignoredLedgerBefore,
    );
    assertIdentityCapacity(request.kind, existingUids);

    const scope = Object.freeze({
      projectUid: request.projection.projectUid,
      projectInstanceId: request.projection.projectInstanceId,
      objectKind: request.kind,
    });
    let reservedUids;
    try {
      reservedUids = normalizeSourceSnapshot(await this.#enumerateSources(scope), scope);
    } catch (cause) {
      throw recoveryRequired('uid_reservation_source_incomplete', cause);
    }

    for (let attempt = 0; attempt < MAX_UID_ATTEMPTS; attempt += 1) {
      const uid = this.#uuidV4();
      canonicalUuid(uid, 'uuidV4 result');
      if (
        uid === request.projection.projectUid
        || existingUids.has(uid)
        || reservedUids.has(uid)
      ) {
        continue;
      }

      let pathPredicates;
      try {
        const observation = await request.probePath(Object.freeze({
          projectUid: request.projection.projectUid,
          projectInstanceId: request.projection.projectInstanceId,
          sourceBasisDigest: request.sourceBasisDigest,
          objectKind: request.kind,
          uid,
        }));
        pathPredicates = normalizePathObservation(observation, request.kind, uid);
      } catch (cause) {
        throw recoveryRequired('uid_reservation_path_unproven', cause);
      }
      if (pathPredicates === null) continue;

      const manifestWithoutId = {
        domain: RESERVATION_DOMAIN,
        version: RESERVATION_VERSION,
        assignmentKind: 'reserved_new',
        objectKind: request.kind,
        projectUid: request.projection.projectUid,
        projectInstanceId: request.projection.projectInstanceId,
        logicalRequestId: request.logicalRequestId,
        logicalInputDigest: request.logicalInputDigest,
        sourceBasisDigest: request.sourceBasisDigest,
        uid,
        id: allocation.id,
        ...(request.kind === 'chapter' ? {
          num: allocation.num,
          containerVolumeUid: allocation.containerVolumeUid,
          requestedNum: allocation.requestedNum,
        } : {}),
        pathPredicates,
      };
      const identityReservation = mintIdentityReservationManifest(manifestWithoutId);
      const authority = Object.freeze(() => {});
      this.#authorities.set(authority, identityReservation);
      return Object.freeze({ identityReservation, authority });
    }

    throw manuscriptError('UID_RESERVATION_COLLISION', {
      attempts: MAX_UID_ATTEMPTS,
      objectKind: request.kind,
    });
  }

  assertReservation(input) {
    const value = exactObject(input, ['authority', 'identityReservation'], 'reservation assertion');
    validateIdentityReservationManifest(value.identityReservation);
    if (
      (typeof value.authority !== 'object' && typeof value.authority !== 'function')
      || value.authority === null
      || this.#authorities.get(value.authority) !== value.identityReservation
    ) {
      invalid('reservation authority and manifest must be the original matching pair');
    }
    return value.identityReservation;
  }
}

module.exports = {
  ManuscriptUidReservation,
  canonicalCreateLogicalInputDigest,
  validateIdentityReservationManifest,
};
