'use strict';

const { createHash } = require('node:crypto');

const { assertCanonicalUuid } = require('./contracts');
const {
  assertControlledFileRef,
  deriveControlledFileRef,
} = require('./paths');

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const SIDECAR_FIELDS = new Set([
  'cognitive_frame',
  'concrete_mystery',
  'emotional_anchor',
  'interpersonal_tension',
  'outline',
  'status',
  'summary',
  'title',
  'world_texture',
]);
const VOLUME_FIELDS = new Set(['summary', 'title']);

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactData(value, keys, label) {
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
    if (
      descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) invalid(`${label}.${key} must be an own enumerable data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    invalid(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nullableUuid(value, label) {
  return value === null ? null : assertCanonicalUuid(value, label);
}

function uuidArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(`${label} must be a plain UID array`);
  }
  const result = value.map((uid, index) => assertCanonicalUuid(uid, `${label}[${index}]`));
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicate UIDs`);
  return Object.freeze(result);
}

function text(value, label) {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function patch(value, allowed, label) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length === 0) invalid(`${label} must not be empty`);
  const result = {};
  for (const key of keys.sort()) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || !allowed.has(key)
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) invalid(`${label} has an invalid shape`);
    result[key] = text(descriptor.value, `${label}.${key}`);
  }
  return Object.freeze(result);
}

function refIdentity(value, expectedRole, projectUid, label) {
  const ref = assertControlledFileRef(value);
  if (ref.role !== expectedRole || ref.projectUid !== projectUid) {
    invalid(`${label} belongs to another role or project`);
  }
  if (expectedRole === 'volume_index') return assertCanonicalUuid(ref.volumeUid, `${label}.volumeUid`);
  return assertCanonicalUuid(ref.chapterUid, `${label}.chapterUid`);
}

function portableCommand(command, projectUid) {
  if (!isPlainObject(command)) invalid('draft conflict command must be a plain object');
  const kindDescriptor = Object.getOwnPropertyDescriptor(command, 'kind');
  const kind = kindDescriptor?.enumerable === true && Object.hasOwn(kindDescriptor, 'value')
    ? kindDescriptor.value
    : null;
  if (kind === 'chapter.replace_body') {
    const input = exactData(command, ['kind', 'bodyRef', 'content'], kind);
    return Object.freeze({
      portable: Object.freeze({
        kind,
        chapterUid: refIdentity(input.bodyRef, 'chapter_body', projectUid, 'bodyRef'),
        content: text(input.content, 'content'),
      }),
      resource: Object.freeze({ kind: 'chapter', uid: input.bodyRef.chapterUid, domain: 'body' }),
      fieldMask: Object.freeze(['content']),
    });
  }
  if (kind === 'chapter.patch_sidecar') {
    const input = exactData(command, ['kind', 'sidecarRef', 'patch'], kind);
    const safePatch = patch(input.patch, SIDECAR_FIELDS, 'sidecar patch');
    const chapterUid = refIdentity(input.sidecarRef, 'chapter_sidecar', projectUid, 'sidecarRef');
    return Object.freeze({
      portable: Object.freeze({ kind, chapterUid, patch: safePatch }),
      resource: Object.freeze({ kind: 'chapter', uid: chapterUid, domain: 'sidecar' }),
      fieldMask: Object.freeze(Object.keys(safePatch)),
    });
  }
  if (kind === 'chapter.replace_body_and_sidecar') {
    const input = exactData(command, ['kind', 'bodyRef', 'sidecarRef', 'content', 'patch'], kind);
    const bodyUid = refIdentity(input.bodyRef, 'chapter_body', projectUid, 'bodyRef');
    const sidecarUid = refIdentity(input.sidecarRef, 'chapter_sidecar', projectUid, 'sidecarRef');
    if (bodyUid !== sidecarUid) invalid('combined draft conflict command names two chapters');
    const safePatch = patch(input.patch, SIDECAR_FIELDS, 'sidecar patch');
    return Object.freeze({
      portable: Object.freeze({
        kind,
        chapterUid: bodyUid,
        content: text(input.content, 'content'),
        patch: safePatch,
      }),
      resource: Object.freeze({ kind: 'chapter', uid: bodyUid, domain: 'body' }),
      fieldMask: Object.freeze(['content', ...Object.keys(safePatch)].sort()),
    });
  }
  if (kind === 'volume.patch_metadata') {
    const input = exactData(command, ['kind', 'volumeRef', 'patch'], kind);
    const safePatch = patch(input.patch, VOLUME_FIELDS, 'volume patch');
    const volumeUid = refIdentity(input.volumeRef, 'volume_index', projectUid, 'volumeRef');
    return Object.freeze({
      portable: Object.freeze({ kind, volumeUid, patch: safePatch }),
      resource: Object.freeze({ kind: 'volume', uid: volumeUid, domain: 'volume_metadata' }),
      fieldMask: Object.freeze(Object.keys(safePatch)),
    });
  }
  if (kind === 'chapter.move') {
    const input = exactData(
      command,
      ['kind', 'chapterUid', 'targetVolumeUid', 'targetPosition'],
      kind,
    );
    const chapterUid = assertCanonicalUuid(input.chapterUid, 'chapterUid');
    return Object.freeze({
      portable: Object.freeze({
        kind,
        chapterUid,
        targetVolumeUid: nullableUuid(input.targetVolumeUid, 'targetVolumeUid'),
        targetPosition: nonNegativeInteger(input.targetPosition, 'targetPosition'),
      }),
      resource: Object.freeze({ kind: 'chapter', uid: chapterUid, domain: 'structure' }),
      fieldMask: Object.freeze(['structure']),
    });
  }
  if (kind === 'chapter.reorder') {
    const input = exactData(command, ['kind', 'containerVolumeUid', 'chapterUids'], kind);
    return Object.freeze({
      portable: Object.freeze({
        kind,
        containerVolumeUid: nullableUuid(input.containerVolumeUid, 'containerVolumeUid'),
        chapterUids: uuidArray(input.chapterUids, 'chapterUids'),
      }),
      resource: Object.freeze({ kind: 'manuscript', uid: projectUid, domain: 'structure' }),
      fieldMask: Object.freeze(['structure']),
    });
  }
  if (kind === 'volume.reorder') {
    const input = exactData(command, ['kind', 'volumeUids'], kind);
    return Object.freeze({
      portable: Object.freeze({ kind, volumeUids: uuidArray(input.volumeUids, 'volumeUids') }),
      resource: Object.freeze({ kind: 'manuscript', uid: projectUid, domain: 'structure' }),
      fieldMask: Object.freeze(['structure']),
    });
  }
  if (kind === 'chapter.delete') {
    const input = exactData(command, ['kind', 'chapterUid'], kind);
    const chapterUid = assertCanonicalUuid(input.chapterUid, 'chapterUid');
    return Object.freeze({
      portable: Object.freeze({ kind, chapterUid }),
      resource: Object.freeze({ kind: 'chapter', uid: chapterUid, domain: 'structure' }),
      fieldMask: Object.freeze(['structure']),
    });
  }
  if (kind === 'volume.delete') {
    const input = exactData(command, ['kind', 'volumeUid'], kind);
    const volumeUid = assertCanonicalUuid(input.volumeUid, 'volumeUid');
    return Object.freeze({
      portable: Object.freeze({ kind, volumeUid }),
      resource: Object.freeze({ kind: 'volume', uid: volumeUid, domain: 'structure' }),
      fieldMask: Object.freeze(['structure']),
    });
  }
  invalid('draft conflict command is unsupported');
}

function safeWitness(value) {
  const input = exactData(
    value,
    ['expectedDataVersion', 'generation', 'rawSha256', 'sidecarRawSha256'],
    'draft conflict witness',
  );
  return Object.freeze({
    expectedDataVersion: nonNegativeInteger(input.expectedDataVersion, 'expectedDataVersion'),
    generation: nonNegativeInteger(input.generation, 'generation'),
    rawSha256: digest(input.rawSha256, 'rawSha256'),
    sidecarRawSha256: input.sidecarRawSha256 === null
      ? null
      : digest(input.sidecarRawSha256, 'sidecarRawSha256'),
  });
}

function encodeDraftConflictBackup(command, currentWitness, projectUidValue) {
  if (arguments.length !== 3) invalid('encodeDraftConflictBackup requires three arguments');
  const projectUid = assertCanonicalUuid(projectUidValue, 'projectUid');
  const encoded = portableCommand(command, projectUid);
  const witness = safeWitness(currentWitness);
  const draftBytes = Buffer.from(canonicalJson(Object.freeze({
    command: encoded.portable,
    domain: 'mythpen.draft-conflict.command',
    projectUid,
    version: 1,
  })), 'utf8');
  const externalBytes = Buffer.from(canonicalJson(Object.freeze({
    domain: 'mythpen.draft-conflict.external-witness',
    expectedDataVersion: witness.expectedDataVersion,
    projectUid,
    rawSha256: witness.rawSha256,
    sidecarRawSha256: witness.sidecarRawSha256,
    version: 1,
  })), 'utf8');
  return Object.freeze({
    basis: Object.freeze({
      baseGeneration: witness.generation,
      baseRawSha256: sha256(externalBytes),
    }),
    draftBytes,
    externalBytes,
    fieldMask: encoded.fieldMask,
    resource: encoded.resource,
  });
}

function decodedPortableCommand(value, projectUid) {
  if (!isPlainObject(value)) invalid('draft conflict portable command must be a plain object');
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'chapter.replace_body') {
    const input = exactData(value, ['kind', 'chapterUid', 'content'], 'portable command');
    const chapterUid = assertCanonicalUuid(input.chapterUid, 'chapterUid');
    return Object.freeze({
      kind,
      bodyRef: deriveControlledFileRef({ role: 'chapter_body', projectUid, chapterUid }),
      content: text(input.content, 'content'),
    });
  }
  if (kind === 'chapter.patch_sidecar') {
    const input = exactData(value, ['kind', 'chapterUid', 'patch'], 'portable command');
    const chapterUid = assertCanonicalUuid(input.chapterUid, 'chapterUid');
    return Object.freeze({
      kind,
      sidecarRef: deriveControlledFileRef({ role: 'chapter_sidecar', projectUid, chapterUid }),
      patch: patch(input.patch, SIDECAR_FIELDS, 'sidecar patch'),
    });
  }
  if (kind === 'chapter.replace_body_and_sidecar') {
    const input = exactData(
      value,
      ['kind', 'chapterUid', 'content', 'patch'],
      'portable command',
    );
    const chapterUid = assertCanonicalUuid(input.chapterUid, 'chapterUid');
    return Object.freeze({
      kind,
      bodyRef: deriveControlledFileRef({ role: 'chapter_body', projectUid, chapterUid }),
      sidecarRef: deriveControlledFileRef({ role: 'chapter_sidecar', projectUid, chapterUid }),
      content: text(input.content, 'content'),
      patch: patch(input.patch, SIDECAR_FIELDS, 'sidecar patch'),
    });
  }
  if (kind === 'volume.patch_metadata') {
    const input = exactData(value, ['kind', 'volumeUid', 'patch'], 'portable command');
    const volumeUid = assertCanonicalUuid(input.volumeUid, 'volumeUid');
    return Object.freeze({
      kind,
      volumeRef: deriveControlledFileRef({ role: 'volume_index', projectUid, volumeUid }),
      patch: patch(input.patch, VOLUME_FIELDS, 'volume patch'),
    });
  }
  if (kind === 'chapter.move') {
    const input = exactData(
      value,
      ['kind', 'chapterUid', 'targetVolumeUid', 'targetPosition'],
      'portable command',
    );
    return Object.freeze({
      kind,
      chapterUid: assertCanonicalUuid(input.chapterUid, 'chapterUid'),
      targetVolumeUid: nullableUuid(input.targetVolumeUid, 'targetVolumeUid'),
      targetPosition: nonNegativeInteger(input.targetPosition, 'targetPosition'),
    });
  }
  if (kind === 'chapter.reorder') {
    const input = exactData(value, ['kind', 'containerVolumeUid', 'chapterUids'], 'portable command');
    return Object.freeze({
      kind,
      containerVolumeUid: nullableUuid(input.containerVolumeUid, 'containerVolumeUid'),
      chapterUids: uuidArray(input.chapterUids, 'chapterUids'),
    });
  }
  if (kind === 'volume.reorder') {
    const input = exactData(value, ['kind', 'volumeUids'], 'portable command');
    return Object.freeze({ kind, volumeUids: uuidArray(input.volumeUids, 'volumeUids') });
  }
  if (kind === 'chapter.delete') {
    const input = exactData(value, ['kind', 'chapterUid'], 'portable command');
    return Object.freeze({ kind, chapterUid: assertCanonicalUuid(input.chapterUid, 'chapterUid') });
  }
  if (kind === 'volume.delete') {
    const input = exactData(value, ['kind', 'volumeUid'], 'portable command');
    return Object.freeze({ kind, volumeUid: assertCanonicalUuid(input.volumeUid, 'volumeUid') });
  }
  invalid('draft conflict portable command is unsupported');
}

function decodeDraftConflictCommand(bytes, projectUidValue) {
  if (arguments.length !== 2 || !Buffer.isBuffer(bytes)) {
    invalid('decodeDraftConflictCommand requires Buffer bytes and projectUid');
  }
  const projectUid = assertCanonicalUuid(projectUidValue, 'projectUid');
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes)) invalid('draft conflict command is not canonical UTF-8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    invalid(`draft conflict command JSON is invalid: ${cause.message}`);
  }
  const input = exactData(
    parsed,
    ['command', 'domain', 'projectUid', 'version'],
    'draft conflict command envelope',
  );
  if (
    input.domain !== 'mythpen.draft-conflict.command'
    || input.version !== 1
    || input.projectUid !== projectUid
  ) invalid('draft conflict command envelope binding is invalid');
  const command = decodedPortableCommand(input.command, projectUid);
  if (canonicalJson(parsed) !== source) invalid('draft conflict command JSON is not canonical');
  return command;
}

module.exports = {
  decodeDraftConflictCommand,
  encodeDraftConflictBackup,
};
