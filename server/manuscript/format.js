'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const {
  MANUSCRIPT_FORMAT_VERSION,
  assertCanonicalUuid,
  manuscriptError,
} = require('./contracts');

const STATUS_VALUES = new Set(['pending', 'writing', 'review', 'accepted']);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const ROLE_SCHEMAS = Object.freeze({
  manuscript: Object.freeze({
    fields: Object.freeze(['format_version', 'project_uid', 'volume_uids']),
    identityField: 'project_uid',
  }),
  unassigned: Object.freeze({
    fields: Object.freeze(['format_version', 'kind', 'chapter_uids']),
    identityField: null,
  }),
  volume_index: Object.freeze({
    fields: Object.freeze([
      'format_version',
      'volume_uid',
      'title',
      'summary',
      'chapter_uids',
    ]),
    identityField: 'volume_uid',
  }),
  chapter_sidecar: Object.freeze({
    fields: Object.freeze([
      'format_version',
      'chapter_uid',
      'title',
      'outline',
      'status',
      'summary',
      'cognitive_frame',
      'emotional_anchor',
      'world_texture',
      'concrete_mystery',
      'interpersonal_tension',
    ]),
    identityField: 'chapter_uid',
  }),
});

function invalid(role, details = {}, cause) {
  throw manuscriptError('MANUSCRIPT_FILESET_INVALID', { role, ...details }, cause);
}

function schemaFor(role) {
  if (typeof role !== 'string' || !Object.hasOwn(ROLE_SCHEMAS, role)) {
    throw new TypeError('role must be a canonical manuscript JSON role');
  }
  return ROLE_SCHEMAS[role];
}

function asBuffer(bytes, role) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  invalid(role);
}

function decodeUtf8(bytes, role, details = {}) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (cause) {
    invalid(role, details, cause);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainDataObject(value, role) {
  if (!isPlainObject(value)) invalid(role);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid(role);
    }
  }
  return descriptors;
}

function assertDenseStringArray(value, role, memberRole) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid(role);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) invalid(role);

  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid(role);
    }
    const member = assertCanonicalUuid(descriptor.value, memberRole);
    if (seen.has(member)) invalid(role);
    seen.add(member);
  }

  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      invalid(role);
    }
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertString(value, role) {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) invalid(role);
}

function assertSupportedVersion(value, role) {
  const descriptor = isPlainObject(value)
    ? Object.getOwnPropertyDescriptor(value, 'format_version')
    : undefined;
  const version = descriptor && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;

  if (Number.isSafeInteger(version) && version > MANUSCRIPT_FORMAT_VERSION) {
    throw manuscriptError('MANUSCRIPT_FORMAT_TOO_NEW', { role });
  }
  if (version !== MANUSCRIPT_FORMAT_VERSION) invalid(role);
}

function assertExactFields(value, role, schema) {
  const descriptors = assertPlainDataObject(value, role);
  const keys = Object.keys(descriptors);
  if (keys.length !== schema.fields.length) invalid(role);
  const expected = new Set(schema.fields);
  if (keys.some((key) => !expected.has(key))) invalid(role);
}

function validateValue(role, value) {
  const schema = schemaFor(role);
  assertSupportedVersion(value, role);
  assertExactFields(value, role, schema);

  if (role === 'manuscript') {
    assertCanonicalUuid(value.project_uid, 'project_uid');
    assertDenseStringArray(value.volume_uids, role, 'volume_uid');
  } else if (role === 'unassigned') {
    if (value.kind !== 'unassigned') invalid(role);
    assertDenseStringArray(value.chapter_uids, role, 'chapter_uid');
  } else if (role === 'volume_index') {
    assertCanonicalUuid(value.volume_uid, 'volume_uid');
    assertString(value.title, role);
    assertString(value.summary, role);
    assertDenseStringArray(value.chapter_uids, role, 'chapter_uid');
  } else {
    assertCanonicalUuid(value.chapter_uid, 'chapter_uid');
    for (const field of [
      'title',
      'outline',
      'summary',
      'cognitive_frame',
      'emotional_anchor',
      'world_texture',
      'concrete_mystery',
      'interpersonal_tension',
    ]) {
      assertString(value[field], role);
    }
    if (!STATUS_VALUES.has(value.status)) invalid(role);
  }

  return schema;
}

function encodeCanonical(role, value, schema) {
  const ordered = {};
  for (const field of schema.fields) {
    ordered[field] = Array.isArray(value[field]) ? [...value[field]] : value[field];
  }
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

function serializeCanonicalJson(role, value) {
  const schema = validateValue(role, value);
  return encodeCanonical(role, value, schema);
}

function parseCanonicalJson({ role, bytes, expectedUid } = {}) {
  const schema = schemaFor(role);
  const source = asBuffer(bytes, role);
  if (
    source.length >= 3
    && source[0] === 0xef
    && source[1] === 0xbb
    && source[2] === 0xbf
  ) {
    invalid(role);
  }

  const text = decodeUtf8(source, role);
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    invalid(role, {}, cause);
  }

  const validatedSchema = validateValue(role, value);
  if (!source.equals(encodeCanonical(role, value, validatedSchema))) invalid(role);

  if (schema.identityField !== null) {
    const canonicalExpectedUid = assertCanonicalUuid(expectedUid, `expected_${schema.identityField}`);
    if (value[schema.identityField] !== canonicalExpectedUid) invalid(role);
  }
  return value;
}

function hasUnsupportedInlineMarkdown(line) {
  if (/ {2,}$/.test(line) || /\\$/.test(line)) return true;

  let outsideCode = '';
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      outsideCode += line[index];
      index += 1;
      continue;
    }
    if (line[index + 1] === '`') return true;
    const close = line.indexOf('`', index + 1);
    if (close === -1) {
      outsideCode += '`';
      index += 1;
    } else {
      index = close + 1;
    }
  }

  if (/!\[[^\]\r\n]*\]\([^\r\n)]*\)/.test(outsideCode)) return true;
  if (/\[[^\]\r\n]+\]\([^\r\n)]*\)/.test(outsideCode)) return true;
  if (/\[[^\]\r\n]+\]\[[^\]\r\n]*\]/.test(outsideCode)) return true;
  if (/~~[^~\r\n]+~~/.test(outsideCode)) return true;
  if (hasUnsupportedUnderscoreEmphasis(outsideCode)) return true;
  if (/<!--|<\?|<![A-Z]|<\/?[A-Za-z][^>\r\n]*>/.test(outsideCode)) return true;
  if (/<(?:https?:\/\/|mailto:)[^>\r\n]+>/.test(outsideCode)) return true;
  if (/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(outsideCode)) return true;
  if (/\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(outsideCode)) return true;
  return false;
}

function hasUnsupportedUnderscoreEmphasis(text) {
  const isBoundary = (character) => character === undefined
    || /\s/u.test(character)
    || /[\p{P}\p{S}]/u.test(character);

  for (let open = 0; open < text.length; open += 1) {
    if (
      text[open] !== '_'
      || text[open - 1] === '_'
      || text[open + 1] === '_'
      || !isBoundary(text[open - 1])
      || text[open + 1] === undefined
      || /\s/u.test(text[open + 1])
    ) {
      continue;
    }
    for (let close = open + 1; close < text.length; close += 1) {
      if (
        text[close] === '_'
        && text[close - 1] !== '_'
        && text[close + 1] !== '_'
        && !/\s/u.test(text[close - 1])
        && isBoundary(text[close + 1])
      ) {
        return true;
      }
    }
  }
  return false;
}

function isUnsupportedBlock(line) {
  if (/^(?: {4}|\t)/.test(line)) return true;
  if (/^ {1,3}#{1,6}(?:[ \t]+|$)/.test(line)) return true;
  if (/^ {0,3}#{3,6}(?:[ \t]+|$)/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  if (/^ {0,3}(?:[-+*](?:[ \t]+|$)|[0-9]{1,9}[.)](?:[ \t]+|$))/.test(line)) return true;
  if (/^ {0,3}~{3,}/.test(line)) return true;
  if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(line)) return true;
  if (/^ {0,3}={3,}[ \t]*$/.test(line)) return true;
  if (/^ {0,3}\[[^\]]+\]:/.test(line)) return true;
  if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) return true;
  return false;
}

function isVisualDialect(content) {
  const lines = content.split(/\r\n|\n|\r/);
  let inFence = false;

  for (const line of lines) {
    if (inFence) {
      if (line === '```') inFence = false;
      continue;
    }
    if (line === '```') {
      inFence = true;
      continue;
    }
    if (/^ {0,3}`{3,}/.test(line)) return false;
    if (/^[ \t]*$/.test(line) || line === '---') continue;

    let inline = line;
    if (line.startsWith('# ')) inline = line.slice(2);
    else if (line.startsWith('## ')) inline = line.slice(3);
    else if (isUnsupportedBlock(line)) return false;

    if (hasUnsupportedInlineMarkdown(inline)) return false;
  }
  return !inFence;
}

function inspectMarkdown(bytes) {
  const source = asBuffer(bytes, 'chapter_body');
  const rawSha256 = createHash('sha256').update(source).digest('hex');
  const decoded = decodeUtf8(source, 'chapter_body', { rawSha256 });
  const wordCount = decoded.replace(/\s/g, '').length;
  const containsNull = decoded.includes('\u0000');

  return {
    rawSha256,
    wordCount,
    mode: containsNull || !isVisualDialect(decoded)
      ? 'read_only_passthrough'
      : 'visual',
    contentAvailable: !containsNull,
    content: containsNull ? null : decoded,
  };
}

module.exports = {
  inspectMarkdown,
  parseCanonicalJson,
  serializeCanonicalJson,
};
