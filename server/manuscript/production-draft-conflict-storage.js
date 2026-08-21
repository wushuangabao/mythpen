'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createAssetVerified,
  deleteVerified,
  enumerateDirectoryVerified,
  fsyncDirectory,
  inspectPath,
  readObserved,
  readVerified,
} = require('../platform/durability');
const { assertCanonicalUuid } = require('./contracts');

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RESOURCE_KINDS = new Set(['chapter', 'volume', 'manuscript']);
const RESOURCE_DOMAINS = new Set(['body', 'sidecar', 'volume_metadata', 'structure']);
const BACKUP_FILE_NAMES = Object.freeze(['draft.bin', 'external.bin', 'manifest.json']);

function recoveryRequired(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'RECOVERY_REQUIRED';
  return error;
}

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactData(value, keys, label, frozen = false) {
  if (!isPlainObject(value)) invalid(`${label} must be a plain object`);
  if (frozen && !Object.isFrozen(value)) invalid(`${label} must be frozen`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length
    || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) invalid(`${label} has an inexact key set`);
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) invalid(`${label}.${key} must be an enumerable own data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function captureAuthority(value) {
  const input = exactData(value, ['assert', 'describe'], 'journal intent authority', true);
  if (typeof input.assert !== 'function' || typeof input.describe !== 'function') {
    invalid('journal intent authority methods are required');
  }
  return Object.freeze({
    assert(intent) {
      return Reflect.apply(input.assert, value, [intent]);
    },
    describe(intent) {
      return Reflect.apply(input.describe, value, [intent]);
    },
  });
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function identity(value, label) {
  const input = exactData(value, ['dev', 'ino'], label);
  if (
    typeof input.dev !== 'string'
    || !/^(0|[1-9][0-9]*)$/u.test(input.dev)
    || typeof input.ino !== 'string'
    || !/^(0|[1-9][0-9]*)$/u.test(input.ino)
  ) invalid(`${label} is invalid`);
  return Object.freeze({ dev: input.dev, ino: input.ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function digest(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalid(`${label} is invalid`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function fieldMask(value) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || !Object.isFrozen(value)
  ) invalid('backup manifest fieldMask must be a frozen plain array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    invalid('backup manifest fieldMask must be exact and dense');
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'string'
      || descriptor.value.length === 0
    ) invalid('backup manifest fieldMask is invalid');
    result.push(descriptor.value);
  }
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] >= result[index]) invalid('backup manifest fieldMask is not canonical');
  }
  return Object.freeze(result);
}

function snapshotResource(value) {
  const input = exactData(value, ['domain', 'kind', 'uid'], 'backup manifest resource', true);
  if (!RESOURCE_KINDS.has(input.kind) || !RESOURCE_DOMAINS.has(input.domain)) {
    invalid('backup manifest resource is invalid');
  }
  return Object.freeze({
    kind: input.kind,
    uid: assertCanonicalUuid(input.uid, 'backup resource UID'),
    domain: input.domain,
  });
}

function snapshotFile(value, expectedName, label) {
  const input = exactData(value, ['byteSize', 'name', 'rawSha256'], label, true);
  if (input.name !== expectedName) invalid(`${label}.name is invalid`);
  return Object.freeze({
    name: expectedName,
    byteSize: nonNegativeInteger(input.byteSize, `${label}.byteSize`),
    rawSha256: digest(input.rawSha256, `${label}.rawSha256`),
  });
}

function snapshotManifest(value, binding) {
  const input = exactData(value, [
    'domain',
    'version',
    'projectUid',
    'projectInstanceId',
    'conflictId',
    'backupRootPath',
    'conflictDirectoryPath',
    'resource',
    'basis',
    'fieldMask',
    'draft',
    'external',
    'manifestFileName',
    'layoutDigest',
  ], 'backup manifest', true);
  const conflictId = assertCanonicalUuid(input.conflictId, 'conflict ID');
  const expectedRoot = path.join(binding.controlDirectory, 'draft-conflict');
  const expectedDirectory = path.join(expectedRoot, conflictId);
  if (
    input.domain !== 'mythpen.draft-conflict.backup'
    || input.version !== 1
    || input.projectUid !== binding.projectUid
    || input.projectInstanceId !== binding.projectInstanceId
    || input.backupRootPath !== expectedRoot
    || input.conflictDirectoryPath !== expectedDirectory
    || input.manifestFileName !== 'manifest.json'
  ) throw recoveryRequired('Draft conflict backup manifest binding is invalid');
  const basis = exactData(input.basis, ['baseGeneration', 'baseRawSha256'], 'backup manifest basis', true);
  const manifest = Object.freeze({
    domain: input.domain,
    version: 1,
    projectUid: binding.projectUid,
    projectInstanceId: binding.projectInstanceId,
    conflictId,
    backupRootPath: expectedRoot,
    conflictDirectoryPath: expectedDirectory,
    resource: snapshotResource(input.resource),
    basis: Object.freeze({
      baseGeneration: nonNegativeInteger(basis.baseGeneration, 'backup baseGeneration'),
      baseRawSha256: digest(basis.baseRawSha256, 'backup baseRawSha256'),
    }),
    fieldMask: fieldMask(input.fieldMask),
    draft: snapshotFile(input.draft, 'draft.bin', 'backup draft'),
    external: snapshotFile(input.external, 'external.bin', 'backup external'),
    manifestFileName: 'manifest.json',
    layoutDigest: digest(input.layoutDigest, 'backup layoutDigest'),
  });
  const layout = Object.freeze({
    domain: 'mythpen.draft-conflict.backup-layout',
    version: 1,
    projectUid: manifest.projectUid,
    projectInstanceId: manifest.projectInstanceId,
    conflictId: manifest.conflictId,
    backupRootPath: manifest.backupRootPath,
    conflictDirectoryPath: manifest.conflictDirectoryPath,
    resource: manifest.resource,
    baseGeneration: manifest.basis.baseGeneration,
    baseRawSha256: manifest.basis.baseRawSha256,
    fieldMask: manifest.fieldMask,
    files: Object.freeze([
      manifest.draft,
      manifest.external,
      Object.freeze({ name: 'manifest.json' }),
    ]),
  });
  if (sha256(Buffer.from(canonicalJson(layout), 'utf8')) !== manifest.layoutDigest) {
    throw recoveryRequired('Draft conflict backup layout digest is invalid');
  }
  return manifest;
}

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath, { bigint: true });
    return true;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return false;
    throw cause;
  }
}

function inspectPlainDirectory(directoryPath, expectedParentIdentity, label) {
  const stats = fs.lstatSync(directoryPath, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw recoveryRequired(`${label} is not one plain directory`);
  }
  const expectedRealPath = fs.realpathSync.native(directoryPath);
  const observation = inspectPath(directoryPath);
  const directoryIdentity = identity(observation.identity, `${label} identity`);
  const parentIdentity = identity(observation.parentIdentity, `${label} parent identity`);
  if (
    observation.kind !== 'directory'
    || observation.reparse !== false
    || observation.actualName !== path.basename(directoryPath)
    || canonicalPath(observation.realPath) !== canonicalPath(expectedRealPath)
    || (expectedParentIdentity !== null && !sameIdentity(parentIdentity, expectedParentIdentity))
  ) throw recoveryRequired(`${label} physical identity is invalid`);
  return Object.freeze({ directoryIdentity, parentIdentity });
}

function expectedFiles(manifest) {
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  return Object.freeze([
    Object.freeze({ ...manifest.draft, bytes: null }),
    Object.freeze({ ...manifest.external, bytes: null }),
    Object.freeze({
      name: 'manifest.json',
      byteSize: manifestBytes.length,
      rawSha256: sha256(manifestBytes),
      bytes: manifestBytes,
    }),
  ]);
}

function fileReceipt(expected, observed, directoryIdentity) {
  return Object.freeze({
    name: expected.name,
    byteSize: expected.byteSize,
    rawSha256: expected.rawSha256,
    fileIdentity: observed.identity,
    parentIdentity: directoryIdentity,
    flushed: true,
    readback: true,
  });
}

function inspectBackup(manifest, binding) {
  if (!pathExists(manifest.backupRootPath)) {
    return Object.freeze({ status: 'incomplete', externalContents: false, observations: [] });
  }
  const root = inspectPlainDirectory(
    manifest.backupRootPath,
    binding.controlIdentity,
    'Draft conflict backup root',
  );
  if (!pathExists(manifest.conflictDirectoryPath)) {
    return Object.freeze({ status: 'incomplete', externalContents: false, observations: [] });
  }
  const directory = inspectPlainDirectory(
    manifest.conflictDirectoryPath,
    root.directoryIdentity,
    'Draft conflict directory',
  );
  const names = enumerateDirectoryVerified(
    manifest.conflictDirectoryPath,
    directory.directoryIdentity,
  );
  const expected = expectedFiles(manifest);
  if (names.some((name) => !BACKUP_FILE_NAMES.includes(name))) {
    return Object.freeze({ status: 'incomplete', externalContents: true, observations: [] });
  }
  const observations = [];
  for (const file of expected) {
    const filePath = path.join(manifest.conflictDirectoryPath, file.name);
    if (!names.includes(file.name)) continue;
    let observation;
    try {
      observation = inspectPath(filePath);
      if (
        observation.kind !== 'file'
        || observation.reparse !== false
        || observation.linkCount !== 1
        || observation.actualName !== file.name
        || observation.byteSize !== file.byteSize
        || !sameIdentity(identity(observation.parentIdentity, 'backup file parent'), directory.directoryIdentity)
      ) throw new Error('unexpected file topology');
      const verified = readVerified(filePath, {
        disposition: 'present',
        byteSize: file.byteSize,
        identity: observation.identity,
        parentIdentity: directory.directoryIdentity,
        sha256: file.rawSha256,
      });
      observations.push(Object.freeze({
        expected: file,
        identity: verified.identity,
        parentIdentity: directory.directoryIdentity,
      }));
    } catch {
      return Object.freeze({ status: 'incomplete', externalContents: true, observations: [] });
    }
  }
  if (observations.length !== expected.length) {
    return Object.freeze({ status: 'incomplete', externalContents: false, observations });
  }
  return Object.freeze({
    status: 'complete',
    root,
    directory,
    observations: Object.freeze(observations),
  });
}

function completeReceipt(manifest, inspection) {
  return Object.freeze({
    status: 'complete',
    projectUid: manifest.projectUid,
    projectInstanceId: manifest.projectInstanceId,
    conflictId: manifest.conflictId,
    layoutDigest: manifest.layoutDigest,
    directoryPath: manifest.conflictDirectoryPath,
    directoryIdentity: inspection.directory.directoryIdentity,
    parentPath: manifest.backupRootPath,
    parentIdentity: inspection.root.directoryIdentity,
    directoryFlushed: true,
    parentFlushed: true,
    files: Object.freeze(inspection.observations.map((observation) => fileReceipt(
      observation.expected,
      observation,
      inspection.directory.directoryIdentity,
    ))),
  });
}

function snapshotApplyDescriptor(value) {
  const input = exactData(value, [
    'kind',
    'conflictId',
    'decisionEpoch',
    'childJournalId',
    'externalRawSha256',
    'baseGeneration',
    'targetGeneration',
    'resource',
  ], 'draft conflict apply intent', true);
  if (input.kind !== 'apply') invalid('draft conflict intent is not apply');
  const baseGeneration = nonNegativeInteger(input.baseGeneration, 'apply baseGeneration');
  const targetGeneration = nonNegativeInteger(input.targetGeneration, 'apply targetGeneration');
  if (targetGeneration !== baseGeneration + 1) invalid('apply targetGeneration is invalid');
  return Object.freeze({
    kind: 'apply',
    conflictId: assertCanonicalUuid(input.conflictId, 'apply conflict ID'),
    decisionEpoch: nonNegativeInteger(input.decisionEpoch, 'apply decisionEpoch'),
    childJournalId: assertCanonicalUuid(input.childJournalId, 'apply child journal ID'),
    externalRawSha256: digest(input.externalRawSha256, 'apply externalRawSha256'),
    baseGeneration,
    targetGeneration,
    resource: snapshotResource(input.resource),
  });
}

function readManifestForConflict(binding, conflictIdValue) {
  const conflictId = assertCanonicalUuid(conflictIdValue, 'conflict ID');
  const manifestPath = path.join(
    binding.controlDirectory,
    'draft-conflict',
    conflictId,
    'manifest.json',
  );
  let observation;
  let observed;
  try {
    observation = inspectPath(manifestPath);
    if (
      observation.kind !== 'file'
      || observation.reparse !== false
      || observation.linkCount !== 1
      || observation.actualName !== 'manifest.json'
    ) throw new Error('manifest topology is invalid');
    observed = readObserved(manifestPath, {
      byteSize: observation.byteSize,
      identity: observation.identity,
      parentIdentity: observation.parentIdentity,
    });
  } catch (cause) {
    throw recoveryRequired('Draft conflict manifest cannot be verified', cause);
  }
  let parsed;
  try {
    parsed = JSON.parse(observed.bytes.toString('utf8'));
  } catch (cause) {
    throw recoveryRequired('Draft conflict manifest is invalid', cause);
  }
  function freeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) freeze(nested);
    return Object.freeze(value);
  }
  const manifest = snapshotManifest(freeze(parsed), binding);
  if (
    manifest.conflictId !== conflictId
    || !observed.bytes.equals(Buffer.from(canonicalJson(manifest), 'utf8'))
  ) throw recoveryRequired('Draft conflict manifest differs from its conflict binding');
  return manifest;
}

function readManifestForIntent(binding, descriptor) {
  const manifest = readManifestForConflict(binding, descriptor.conflictId);
  if (
    manifest.basis.baseGeneration !== descriptor.baseGeneration
    || manifest.external.rawSha256 !== descriptor.externalRawSha256
    || canonicalJson(manifest.resource) !== canonicalJson(descriptor.resource)
  ) throw recoveryRequired('Draft conflict manifest differs from its apply intent');
  return manifest;
}

function readDraftBytes(binding, manifest) {
  const inspection = inspectBackup(manifest, binding);
  if (inspection.status !== 'complete') {
    throw recoveryRequired('Draft conflict backup is not complete');
  }
  const draft = inspection.observations.find(
    (observation) => observation.expected.name === 'draft.bin',
  );
  if (draft === undefined) throw recoveryRequired('Draft conflict backup has no draft');
  const verified = readVerified(
    path.join(manifest.conflictDirectoryPath, 'draft.bin'),
    {
      disposition: 'present',
      byteSize: draft.expected.byteSize,
      identity: draft.identity,
      parentIdentity: draft.parentIdentity,
      sha256: draft.expected.rawSha256,
    },
  );
  return Buffer.from(verified.bytes);
}

function createProductionDraftConflictStorage(options) {
  const input = exactData(
    options,
    ['controlDirectory', 'projectUid', 'projectInstanceId'],
    'production draft conflict storage options',
  );
  if (
    typeof input.controlDirectory !== 'string'
    || !path.isAbsolute(input.controlDirectory)
    || path.resolve(input.controlDirectory) !== input.controlDirectory
  ) invalid('controlDirectory must be one canonical absolute path');
  const projectUid = assertCanonicalUuid(input.projectUid, 'project UID');
  const projectInstanceId = assertCanonicalUuid(input.projectInstanceId, 'project instance ID');
  if (
    path.basename(input.controlDirectory) !== projectInstanceId
    || path.basename(path.dirname(input.controlDirectory)) !== projectUid
  ) invalid('controlDirectory does not match the project binding');
  const control = inspectPlainDirectory(input.controlDirectory, null, 'Project ControlStore');
  const binding = Object.freeze({
    controlDirectory: input.controlDirectory,
    controlIdentity: control.directoryIdentity,
    projectUid,
    projectInstanceId,
  });

  const journalStorage = Object.freeze({
    async create(value) {
      let manifest;
      let draftBytes;
      let externalBytes;
      try {
        const createInput = exactData(
          value,
          ['manifest', 'draftBytes', 'externalBytes'],
          'backup create input',
          true,
        );
        manifest = snapshotManifest(createInput.manifest, binding);
        if (!Buffer.isBuffer(createInput.draftBytes) || !Buffer.isBuffer(createInput.externalBytes)) {
          invalid('backup create bytes must be Buffer values');
        }
        draftBytes = Buffer.from(createInput.draftBytes);
        externalBytes = Buffer.from(createInput.externalBytes);
        if (
          draftBytes.length !== manifest.draft.byteSize
          || sha256(draftBytes) !== manifest.draft.rawSha256
          || externalBytes.length !== manifest.external.byteSize
          || sha256(externalBytes) !== manifest.external.rawSha256
        ) invalid('backup create bytes differ from the manifest');
      } catch (cause) {
        if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
        throw recoveryRequired('Draft conflict backup input is invalid', cause);
      }
      try {
        if (!pathExists(manifest.backupRootPath)) {
          fs.mkdirSync(manifest.backupRootPath);
          fsyncDirectory(binding.controlDirectory);
        }
        const root = inspectPlainDirectory(
          manifest.backupRootPath,
          binding.controlIdentity,
          'Draft conflict backup root',
        );
        if (pathExists(manifest.conflictDirectoryPath)) {
          throw recoveryRequired('Draft conflict backup target is occupied');
        }
        fs.mkdirSync(manifest.conflictDirectoryPath);
        fsyncDirectory(manifest.backupRootPath);
        const directory = inspectPlainDirectory(
          manifest.conflictDirectoryPath,
          root.directoryIdentity,
          'Draft conflict directory',
        );
        const assets = [
          { ...manifest.draft, bytes: draftBytes },
          { ...manifest.external, bytes: externalBytes },
          {
            name: 'manifest.json',
            bytes: Buffer.from(canonicalJson(manifest), 'utf8'),
          },
        ];
        for (const asset of assets) {
          const bytes = Buffer.from(asset.bytes);
          createAssetVerified(path.join(manifest.conflictDirectoryPath, asset.name), {
            bytes,
            byteSize: bytes.length,
            parentIdentity: directory.directoryIdentity,
            sha256: sha256(bytes),
          });
        }
        fsyncDirectory(manifest.conflictDirectoryPath);
        fsyncDirectory(manifest.backupRootPath);
        const inspection = inspectBackup(manifest, binding);
        if (inspection.status !== 'complete') {
          throw recoveryRequired('Draft conflict backup completeness is unproven');
        }
        return completeReceipt(manifest, inspection);
      } catch (cause) {
        if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
        throw recoveryRequired('Draft conflict backup creation failed', cause);
      }
    },

    async inspect(value) {
      const inspectInput = exactData(value, ['manifest'], 'backup inspect input', true);
      const manifest = snapshotManifest(inspectInput.manifest, binding);
      try {
        const inspection = inspectBackup(manifest, binding);
        if (inspection.status === 'complete') return completeReceipt(manifest, inspection);
        return Object.freeze({
          status: 'incomplete',
          conflictId: manifest.conflictId,
          owned: true,
          externalContents: inspection.externalContents,
        });
      } catch (cause) {
        if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
        throw recoveryRequired('Draft conflict backup inspection failed', cause);
      }
    },

    async discardIncomplete(value) {
      const discardInput = exactData(value, ['manifest'], 'backup discard input', true);
      const manifest = snapshotManifest(discardInput.manifest, binding);
      try {
        const inspection = inspectBackup(manifest, binding);
        if (inspection.status === 'complete' || inspection.externalContents) {
          throw recoveryRequired('Draft conflict backup is not safely removable');
        }
        for (const observation of inspection.observations) {
          deleteVerified(
            path.join(manifest.conflictDirectoryPath, observation.expected.name),
            {
              byteSize: observation.expected.byteSize,
              identity: observation.identity,
              parentIdentity: observation.parentIdentity,
              sha256: observation.expected.rawSha256,
            },
          );
        }
        if (pathExists(manifest.conflictDirectoryPath)) {
          fs.rmdirSync(manifest.conflictDirectoryPath);
          fsyncDirectory(manifest.backupRootPath);
        }
        return Object.freeze({ conflictId: manifest.conflictId, removed: true });
      } catch (cause) {
        if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
        throw recoveryRequired('Draft conflict incomplete backup removal failed', cause);
      }
    },
  });

  const owner = Object.freeze({
    bindDraftReader(authorityValue) {
      const authority = captureAuthority(authorityValue);
      const consumed = new WeakSet();
      return Object.freeze({
        async readDraft(intent) {
          if (intent === null || (typeof intent !== 'object' && typeof intent !== 'function')) {
            invalid('draft conflict intent must be opaque');
          }
          if (authority.assert(intent) !== intent) {
            invalid('journal intent authority did not return the original intent');
          }
          const descriptor = snapshotApplyDescriptor(authority.describe(intent));
          if (consumed.has(intent)) invalid('draft conflict intent is already consumed');
          consumed.add(intent);
          const manifest = readManifestForIntent(binding, descriptor);
          return readDraftBytes(binding, manifest);
        },
      });
    },
    journalStorage() {
      return journalStorage;
    },
    async readDraftCopy(conflictId) {
      const manifest = readManifestForConflict(binding, conflictId);
      return readDraftBytes(binding, manifest);
    },
  });
  return owner;
}

module.exports = {
  createProductionDraftConflictStorage,
};
