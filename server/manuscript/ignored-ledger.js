'use strict';

const IGNORED_MEMBER_SNAPSHOT_VERSION = 1;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const RESOURCE_KINDS = new Set(['chapter', 'volume']);
const IGNORE_STATUSES = new Set(['active', 'revoked']);
const ROW_KEYS = Object.freeze([
  'resource_kind',
  'resource_uid',
  'ignore_status',
  'opaque_container_kind',
  'opaque_container_uid',
  'is_currently_referenced',
  'member_snapshot_json',
  'projection_generation',
]);
const OBSERVATION_KEYS = Object.freeze(['kind', 'uid', 'status', 'members', 'reference']);
const REFERENCE_KEYS = Object.freeze(['state', 'containerKind', 'containerUid']);
const MEMBER_ROLES = Object.freeze({
  chapter: Object.freeze(['chapter_body', 'chapter_sidecar']),
  volume: Object.freeze(['volume_index']),
});
const canonicalRowArrays = new WeakSet();
const referenceTransitionRecords = new WeakMap();

function invalid(message) {
  throw new TypeError(message);
}

function lexicographicCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactDataDescriptors(value, expectedKeys, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid(`${label} must contain enumerable data properties only`);
    }
  }
  const actual = Object.keys(descriptors).sort(lexicographicCompare);
  const expected = [...expectedKeys].sort(lexicographicCompare);
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    invalid(`${label} has an inexact key set`);
  }
  return descriptors;
}

function descriptorValue(descriptors, key) {
  return descriptors[key].value;
}

function denseArrayValues(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    invalid(`${label} has an invalid length`);
  }
  const length = lengthDescriptor.value;
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid(`${label} must contain dense enumerable data elements`);
    }
    values.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string'
      || !/^(0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= length
    ) {
      invalid(`${label} has an invalid array property`);
    }
  }
  return values;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    invalid(`${label} must be a canonical UUIDv4`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function zeroOrOne(value, label) {
  if (Object.is(value, -0) || (value !== 0 && value !== 1)) {
    invalid(`${label} must be 0 or 1`);
  }
  return value;
}

function resourceKind(value, label) {
  if (!RESOURCE_KINDS.has(value)) invalid(`${label} is invalid`);
  return value;
}

function ignoreStatus(value, label) {
  if (!IGNORE_STATUSES.has(value)) invalid(`${label} is invalid`);
  return value;
}

function normalizeIdentity(value, label) {
  const descriptors = exactDataDescriptors(value, ['dev', 'ino'], label);
  const dev = descriptorValue(descriptors, 'dev');
  const ino = descriptorValue(descriptors, 'ino');
  if (typeof dev !== 'string' || !DECIMAL_PATTERN.test(dev)) {
    invalid(`${label}.dev must be a decimal string`);
  }
  if (typeof ino !== 'string' || !DECIMAL_PATTERN.test(ino)) {
    invalid(`${label}.ino must be a decimal string`);
  }
  return Object.freeze({ dev, ino });
}

function normalizeMembers(value, kind, label) {
  const values = denseArrayValues(value, label);
  const roles = MEMBER_ROLES[kind];
  if (values.length !== roles.length) invalid(`${label} has an invalid member count`);
  const members = values.map((member, index) => {
    const memberLabel = `${label}[${index}]`;
    if (!isPlainObject(member)) invalid(`${memberLabel} must be a plain object`);
    const shallowDescriptors = Object.getOwnPropertyDescriptors(member);
    const presentDescriptor = shallowDescriptors.present;
    if (
      presentDescriptor === undefined
      || presentDescriptor.enumerable !== true
      || !Object.hasOwn(presentDescriptor, 'value')
      || (presentDescriptor.value !== true && presentDescriptor.value !== false)
    ) {
      invalid(`${memberLabel}.present must be an enumerable boolean data property`);
    }
    const present = presentDescriptor.value;
    const expectedKeys = present
      ? ['role', 'present', 'byteSize', 'fileIdentity', 'parentIdentity']
      : ['role', 'present'];
    const descriptors = exactDataDescriptors(member, expectedKeys, memberLabel);
    const role = descriptorValue(descriptors, 'role');
    if (role !== roles[index]) invalid(`${memberLabel}.role is out of order or invalid`);
    if (!present) return Object.freeze({ role, present: false });
    return Object.freeze({
      role,
      present: true,
      byteSize: nonNegativeInteger(
        descriptorValue(descriptors, 'byteSize'),
        `${memberLabel}.byteSize`,
      ),
      fileIdentity: normalizeIdentity(
        descriptorValue(descriptors, 'fileIdentity'),
        `${memberLabel}.fileIdentity`,
      ),
      parentIdentity: normalizeIdentity(
        descriptorValue(descriptors, 'parentIdentity'),
        `${memberLabel}.parentIdentity`,
      ),
    });
  });
  return Object.freeze(members);
}

function canonicalMemberSnapshotJson(value, kind, label) {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    invalid(`${label} must be valid canonical JSON`);
  }
  const descriptors = exactDataDescriptors(parsed, ['version', 'members'], `${label} root`);
  if (descriptorValue(descriptors, 'version') !== IGNORED_MEMBER_SNAPSHOT_VERSION) {
    invalid(`${label} has an unsupported version`);
  }
  const members = normalizeMembers(
    descriptorValue(descriptors, 'members'),
    kind,
    `${label}.members`,
  );
  const canonical = JSON.stringify({ version: IGNORED_MEMBER_SNAPSHOT_VERSION, members });
  if (value !== canonical) invalid(`${label} is not the unique canonical encoding`);
  return canonical;
}

function memberSnapshotFromObservation(value, kind, label) {
  const members = normalizeMembers(value, kind, label);
  return JSON.stringify({ version: IGNORED_MEMBER_SNAPSHOT_VERSION, members });
}

function validateReferenceColumns(kind, referenced, containerKind, containerUid, label) {
  zeroOrOne(referenced, `${label}.is_currently_referenced`);
  if (referenced === 0) {
    if (containerKind !== null || containerUid !== null) {
      invalid(`${label} detached reference must have a null container`);
    }
    return;
  }
  if (kind === 'volume') {
    if (containerKind !== 'manuscript' || containerUid !== null) {
      invalid(`${label} indexed volume must reference manuscript/null`);
    }
    return;
  }
  if (containerKind === 'unassigned' && containerUid === null) return;
  if (containerKind === 'volume' && containerUid !== null) {
    canonicalUuid(containerUid, `${label}.opaque_container_uid`);
    return;
  }
  invalid(`${label} indexed chapter has an invalid container`);
}

function normalizeRow(value, label) {
  const descriptors = exactDataDescriptors(value, ROW_KEYS, label);
  const kind = resourceKind(descriptorValue(descriptors, 'resource_kind'), `${label}.resource_kind`);
  const uid = canonicalUuid(descriptorValue(descriptors, 'resource_uid'), `${label}.resource_uid`);
  const status = ignoreStatus(descriptorValue(descriptors, 'ignore_status'), `${label}.ignore_status`);
  const containerKind = descriptorValue(descriptors, 'opaque_container_kind');
  const containerUid = descriptorValue(descriptors, 'opaque_container_uid');
  const referenced = descriptorValue(descriptors, 'is_currently_referenced');
  validateReferenceColumns(kind, referenced, containerKind, containerUid, label);
  const memberSnapshotJson = canonicalMemberSnapshotJson(
    descriptorValue(descriptors, 'member_snapshot_json'),
    kind,
    `${label}.member_snapshot_json`,
  );
  const generation = nonNegativeInteger(
    descriptorValue(descriptors, 'projection_generation'),
    `${label}.projection_generation`,
  );
  return Object.freeze({
    resource_kind: kind,
    resource_uid: uid,
    ignore_status: status,
    opaque_container_kind: containerKind,
    opaque_container_uid: containerUid,
    is_currently_referenced: referenced,
    member_snapshot_json: memberSnapshotJson,
    projection_generation: generation,
  });
}

function compareRows(left, right) {
  return (
    lexicographicCompare(left.resource_kind, right.resource_kind)
    || lexicographicCompare(left.resource_uid, right.resource_uid)
  );
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function normalizeIgnoredLedgerRows(rows, label = 'ignored ledger rows') {
  if (canonicalRowArrays.has(rows)) return rows;
  const values = denseArrayValues(rows, label);
  const seen = new Set();
  const normalized = values.map((value, index) => {
    const current = normalizeRow(value, `${label}[${index}]`);
    const key = `${current.resource_kind}:${current.resource_uid}`;
    if (seen.has(key)) invalid(`${label} contains a duplicate resource identity`);
    seen.add(key);
    return current;
  });
  normalized.sort(compareRows);
  Object.freeze(normalized);
  canonicalRowArrays.add(normalized);
  return normalized;
}

function normalizeObservation(value, index) {
  const label = `observations[${index}]`;
  const descriptors = exactDataDescriptors(value, OBSERVATION_KEYS, label);
  const kind = resourceKind(descriptorValue(descriptors, 'kind'), `${label}.kind`);
  const uid = canonicalUuid(descriptorValue(descriptors, 'uid'), `${label}.uid`);
  const status = ignoreStatus(descriptorValue(descriptors, 'status'), `${label}.status`);
  const memberSnapshotJson = memberSnapshotFromObservation(
    descriptorValue(descriptors, 'members'),
    kind,
    `${label}.members`,
  );
  const referenceDescriptors = exactDataDescriptors(
    descriptorValue(descriptors, 'reference'),
    REFERENCE_KEYS,
    `${label}.reference`,
  );
  const state = descriptorValue(referenceDescriptors, 'state');
  const containerKind = descriptorValue(referenceDescriptors, 'containerKind');
  const containerUid = descriptorValue(referenceDescriptors, 'containerUid');
  let referenced;
  if (state === 'detached') {
    referenced = 0;
  } else if (state === 'indexed') {
    referenced = 1;
  } else {
    invalid(`${label}.reference.state is invalid`);
  }
  validateReferenceColumns(kind, referenced, containerKind, containerUid, `${label}.reference`);
  return Object.freeze({
    kind,
    uid,
    status,
    memberSnapshotJson,
    containerKind,
    containerUid,
    referenced,
  });
}

function normalizeContainer(value, label) {
  if (!Object.isFrozen(value)) invalid(`${label} must be frozen`);
  const descriptors = exactDataDescriptors(value, ['kind', 'uid'], label);
  const kind = descriptorValue(descriptors, 'kind');
  const uid = descriptorValue(descriptors, 'uid');
  if (kind === 'manuscript' || kind === 'unassigned') {
    if (uid !== null) invalid(`${label}.${kind} uid must be null`);
  } else if (kind === 'volume') {
    canonicalUuid(uid, `${label}.uid`);
  } else {
    invalid(`${label}.kind is invalid`);
  }
  return Object.freeze({ kind, uid });
}

function sameContainer(left, right) {
  return left !== null
    && right !== null
    && left.kind === right.kind
    && left.uid === right.uid;
}

function rowContainer(row) {
  if (row.is_currently_referenced === 0) return null;
  return Object.freeze({
    kind: row.opaque_container_kind,
    uid: row.opaque_container_uid,
  });
}

function assertObservationMatchesRow(current, before, label) {
  if (
    current.kind !== before.resource_kind
    || current.uid !== before.resource_uid
    || current.status !== before.ignore_status
    || current.memberSnapshotJson !== before.member_snapshot_json
    || current.referenced !== before.is_currently_referenced
    || current.containerKind !== before.opaque_container_kind
    || current.containerUid !== before.opaque_container_uid
  ) {
    invalid(`${label} does not exactly match the ignored ledger row`);
  }
}

class IgnoredIdentityLedger {
  constructor() {
    Object.freeze(this);
  }

  toValidationEntries(rows, baseGeneration) {
    const generation = nonNegativeInteger(baseGeneration, 'baseGeneration');
    const normalized = normalizeIgnoredLedgerRows(rows);
    const entries = normalized.map((current, index) => {
      if (current.projection_generation !== generation) {
        invalid(`ignored ledger rows[${index}] does not match baseGeneration`);
      }
      return Object.freeze({
        kind: current.resource_kind,
        status: current.ignore_status,
        uid: current.resource_uid,
      });
    });
    return deepFreeze({ entries });
  }

  compileAfter(input) {
    const descriptors = exactDataDescriptors(
      input,
      ['beforeRows', 'observations', 'targetGeneration'],
      'compileAfter input',
    );
    const beforeRows = normalizeIgnoredLedgerRows(
      descriptorValue(descriptors, 'beforeRows'),
      'beforeRows',
    );
    const targetGeneration = nonNegativeInteger(
      descriptorValue(descriptors, 'targetGeneration'),
      'targetGeneration',
    );
    if (beforeRows.length > 0) {
      const baseGeneration = beforeRows[0].projection_generation;
      if (targetGeneration <= baseGeneration) {
        invalid('targetGeneration must exceed the before generation');
      }
      for (const current of beforeRows) {
        if (current.projection_generation !== baseGeneration) {
          invalid('beforeRows must use one projection generation');
        }
      }
    }

    const observationValues = denseArrayValues(
      descriptorValue(descriptors, 'observations'),
      'observations',
    );
    const byIdentity = new Map();
    for (let index = 0; index < observationValues.length; index += 1) {
      const current = normalizeObservation(observationValues[index], index);
      const key = `${current.kind}:${current.uid}`;
      if (byIdentity.has(key)) invalid('observations contain a duplicate resource identity');
      byIdentity.set(key, current);
    }
    if (byIdentity.size !== beforeRows.length) {
      invalid('observations must cover every before row exactly once');
    }

    const compiled = beforeRows.map((before) => {
      const key = `${before.resource_kind}:${before.resource_uid}`;
      const current = byIdentity.get(key);
      if (current === undefined) invalid('observations do not match before row identities');
      if (current.status !== before.ignore_status) {
        invalid('observation status does not match the before row');
      }
      byIdentity.delete(key);
      return Object.freeze({
        resource_kind: current.kind,
        resource_uid: current.uid,
        ignore_status: current.status,
        opaque_container_kind: current.containerKind,
        opaque_container_uid: current.containerUid,
        is_currently_referenced: current.referenced,
        member_snapshot_json: current.memberSnapshotJson,
        projection_generation: targetGeneration,
      });
    });
    if (byIdentity.size !== 0) invalid('observations contain unrelated resources');
    Object.freeze(compiled);
    canonicalRowArrays.add(compiled);
    return compiled;
  }

  serializeOpaqueMembers(input) {
    const descriptors = exactDataDescriptors(
      input,
      ['container', 'knownMembers', 'rows', 'referenceTransition'],
      'serializeOpaqueMembers input',
    );
    const container = normalizeContainer(
      descriptorValue(descriptors, 'container'),
      'container',
    );
    const rows = normalizeIgnoredLedgerRows(
      descriptorValue(descriptors, 'rows'),
      'rows',
    );
    const transition = descriptorValue(descriptors, 'referenceTransition');
    if (transition !== null) {
      const record = referenceTransitionRecords.get(transition);
      if (record === undefined || record.rowsMaterial !== JSON.stringify(rows)) {
        invalid('referenceTransition must be branded for the exact canonical rows');
      }
    }

    const knownValues = denseArrayValues(
      descriptorValue(descriptors, 'knownMembers'),
      'knownMembers',
    );
    const known = [];
    const seenKnown = new Set();
    for (let index = 0; index < knownValues.length; index += 1) {
      const uid = canonicalUuid(knownValues[index], `knownMembers[${index}]`);
      if (seenKnown.has(uid)) invalid('knownMembers contains a duplicate UID');
      seenKnown.add(uid);
      known.push(uid);
    }

    const memberKind = container.kind === 'manuscript' ? 'volume' : 'chapter';
    const opaque = [];
    for (const row of rows) {
      if (row.resource_kind !== memberKind || row.ignore_status !== 'active') continue;
      let effectiveContainer = rowContainer(row);
      if (
        transition !== null
        && row.resource_kind === transition.resourceKind
        && row.resource_uid === transition.resourceUid
      ) {
        effectiveContainer = transition.toContainer;
      }
      if (!sameContainer(effectiveContainer, container)) continue;
      if (seenKnown.has(row.resource_uid)) {
        invalid('knownMembers overlaps an opaque member');
      }
      opaque.push(row.resource_uid);
    }
    opaque.sort(utf8Compare);
    return Object.freeze([...known, ...opaque]);
  }

  createReferenceTransition(input) {
    const descriptors = exactDataDescriptors(
      input,
      ['rows', 'observation', 'action'],
      'createReferenceTransition input',
    );
    const rows = normalizeIgnoredLedgerRows(
      descriptorValue(descriptors, 'rows'),
      'rows',
    );
    const actionDescriptors = exactDataDescriptors(
      descriptorValue(descriptors, 'action'),
      ['kind', 'chapterUid'],
      'action',
    );
    const kind = descriptorValue(actionDescriptors, 'kind');
    if (
      kind !== 'ignored.preserve_move_to_unassigned'
      && kind !== 'ignored.detach_reference'
    ) {
      invalid('action.kind is invalid');
    }
    const chapterUid = canonicalUuid(
      descriptorValue(actionDescriptors, 'chapterUid'),
      'action.chapterUid',
    );
    const before = rows.find((row) => (
      row.resource_kind === 'chapter' && row.resource_uid === chapterUid
    ));
    if (before === undefined || before.ignore_status !== 'active') {
      invalid('action must name an active ignored chapter');
    }
    const current = normalizeObservation(
      descriptorValue(descriptors, 'observation'),
      0,
    );
    assertObservationMatchesRow(current, before, 'observation');
    if (before.is_currently_referenced !== 1) {
      invalid('action must name an indexed ignored chapter');
    }
    const fromContainer = rowContainer(before);
    if (
      kind === 'ignored.preserve_move_to_unassigned'
      && fromContainer.kind !== 'volume'
    ) {
      invalid('preserve requires a volume-indexed ignored chapter');
    }
    const toContainer = kind === 'ignored.preserve_move_to_unassigned'
      ? Object.freeze({ kind: 'unassigned', uid: null })
      : null;
    const transition = deepFreeze({
      resourceKind: 'chapter',
      resourceUid: chapterUid,
      fromContainer,
      toContainer,
    });
    referenceTransitionRecords.set(transition, Object.freeze({
      rowsMaterial: JSON.stringify(rows),
    }));
    return transition;
  }
}

module.exports = {
  IGNORED_MEMBER_SNAPSHOT_VERSION,
  IgnoredIdentityLedger,
  normalizeIgnoredLedgerRows,
};
