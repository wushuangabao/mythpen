'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLATFORM_IDENTITY_KEYS = Object.freeze([
  'canonicalRealMythpenDirectory',
  'articleRootDirectoryIdentity',
  'mythpenDirectoryIdentity',
  'volumesDirectoryIdentity',
  'chaptersDirectoryIdentity',
]);
const PHYSICAL_IDENTITY_KEYS = Object.freeze(['dev', 'ino']);
const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9]\d*)$/;

function exactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    Object.getPrototypeOf(value) !== Object.prototype
    || keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    return undefined;
  }
  const values = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      return undefined;
    }
    values[key] = descriptor.value;
  }
  return values;
}

function requirePhysicalIdentity(value) {
  const values = exactObject(value, PHYSICAL_IDENTITY_KEYS);
  if (
    values === undefined
    || typeof values.dev !== 'string'
    || !CANONICAL_DECIMAL_PATTERN.test(values.dev)
    || typeof values.ino !== 'string'
    || !CANONICAL_DECIMAL_PATTERN.test(values.ino)
  ) {
    throw new TypeError('worker physical identity must be exact canonical dev/ino');
  }
  return Object.freeze({ dev: values.dev, ino: values.ino });
}

function requireIdentitySnapshot(serialized) {
  if (typeof serialized !== 'string' || serialized.length === 0 || process.argv.length !== 3) {
    throw new TypeError('worker requires one serialized five-key identity snapshot');
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (cause) {
    throw new TypeError('worker identity snapshot is not valid JSON', { cause });
  }
  const values = exactObject(parsed, PLATFORM_IDENTITY_KEYS);
  if (values === undefined) throw new TypeError('worker identity snapshot must have exact keys');
  const canonical = values.canonicalRealMythpenDirectory;
  if (
    typeof canonical !== 'string'
    || canonical.length === 0
    || canonical.includes('\0')
    || !path.isAbsolute(canonical)
    || path.resolve(canonical) !== canonical
    || path.normalize(canonical) !== canonical
    || path.basename(canonical) !== 'mythpen'
  ) {
    throw new TypeError('worker mythpen directory path is not canonical');
  }
  return Object.freeze({
    canonicalRealMythpenDirectory: canonical,
    articleRootDirectoryIdentity: requirePhysicalIdentity(values.articleRootDirectoryIdentity),
    mythpenDirectoryIdentity: requirePhysicalIdentity(values.mythpenDirectoryIdentity),
    volumesDirectoryIdentity: requirePhysicalIdentity(values.volumesDirectoryIdentity),
    chaptersDirectoryIdentity: requirePhysicalIdentity(values.chaptersDirectoryIdentity),
  });
}

function verifyLiveDirectory(targetPath, expectedIdentity, label) {
  const stats = fs.lstatSync(targetPath, { bigint: true });
  const realPath = fs.realpathSync.native(targetPath);
  if (
    stats.isDirectory() !== true
    || stats.isSymbolicLink() !== false
    || realPath !== targetPath
    || String(stats.dev) !== expectedIdentity.dev
    || String(stats.ino) !== expectedIdentity.ino
  ) {
    throw new TypeError(`worker ${label} directory identity changed`);
  }
}

const identity = requireIdentitySnapshot(process.argv[2]);
const mythpenDirectory = identity.canonicalRealMythpenDirectory;
verifyLiveDirectory(
  path.dirname(mythpenDirectory),
  identity.articleRootDirectoryIdentity,
  'article root',
);
verifyLiveDirectory(mythpenDirectory, identity.mythpenDirectoryIdentity, 'mythpen');
verifyLiveDirectory(
  path.join(mythpenDirectory, 'volumes'),
  identity.volumesDirectoryIdentity,
  'volumes',
);
verifyLiveDirectory(
  path.join(mythpenDirectory, 'chapters'),
  identity.chaptersDirectoryIdentity,
  'chapters',
);
fs.writeFileSync(path.join(mythpenDirectory, 'manuscript.json'), '{}');
fs.writeFileSync(path.join(mythpenDirectory, 'volumes', 'volume.json'), '{}');
fs.writeFileSync(path.join(mythpenDirectory, 'chapters', 'chapter.md'), '# chapter');
process.stdout.write('written\n');
