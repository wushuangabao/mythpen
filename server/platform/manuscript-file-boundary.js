'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  mintFileBoundaryCapability,
  mintFileWriterCapability,
  requireFileBoundaryCapability,
  requireFileWriterCapability,
} = require('../manuscript/capability-registry');
const {
  resolveControlledFileRef,
} = require('../manuscript/paths');
const {
  createAssetVerified: createVerifiedAsset,
  deleteVerified,
  enumerateDirectoryVerified,
  inspectPath: inspectVerifiedPath,
  readObserved,
  readVerified,
  relocateVerifiedToAbsent,
} = require('./durability');

const PRODUCTION_BACKEND_TOKEN = Object.freeze({ kind: 'manuscript_file_backend' });
const PRODUCTION_OPTIONS = Object.freeze({
  backendToken: PRODUCTION_BACKEND_TOKEN,
  mode: 'production',
});
const productionPairRecords = new WeakMap();
let productionPair;

function createAssetVerified(assetPath, expected) {
  return createVerifiedAsset(assetPath, expected);
}

function directoryPath(paths, directoryRole) {
  if (directoryRole === 'article_root') return paths.articleRoot;
  if (directoryRole === 'mythpen') return paths.mythpenRoot;
  if (directoryRole === 'volumes') return paths.volumesRoot;
  if (directoryRole === 'chapters') return paths.chaptersRoot;
  throw new TypeError('directoryRole is invalid');
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectDirectory({ directoryRole, paths }) {
  const observation = inspectVerifiedPath(directoryPath(paths, directoryRole));
  return Object.freeze({
    identity: observation.identity,
    kind: observation.kind,
    parentIdentity: observation.parentIdentity,
    safe: observation.kind === 'directory' && observation.reparse === false,
  });
}

function enumerateDirectory({ directoryRole, expectedIdentity, paths }) {
  const targetPath = directoryPath(paths, directoryRole);
  const names = enumerateDirectoryVerified(targetPath, expectedIdentity);
  return Object.freeze({
    async *[Symbol.asyncIterator]() {
      for (const name of names) yield name;
    },
  });
}

function inspectPath(targetPath) {
  const observation = inspectVerifiedPath(targetPath);
  return Object.freeze({
    actualName: observation.actualName,
    identity: observation.identity,
    kind: observation.kind,
    linkCount: observation.linkCount,
    parentIdentity: observation.parentIdentity,
    parentRealPath: observation.parentRealPath,
    realPath: observation.realPath,
    reparse: observation.reparse,
  });
}

function listActualNames(targetPath) {
  return fs.readdirSync(targetPath, { encoding: 'utf8' });
}

function probeControlledFile({ controlledFileRef, paths }) {
  const observation = inspectVerifiedPath(resolveControlledFileRef(paths, controlledFileRef));
  return Object.freeze({
    actualName: observation.actualName,
    byteSize: observation.byteSize,
    identity: observation.identity,
    kind: observation.kind,
    linkCount: observation.linkCount,
    parentIdentity: observation.parentIdentity,
    reparse: observation.reparse,
    safe: observation.kind === 'file'
      && observation.reparse === false
      && observation.linkCount === 1,
  });
}

function readControlledFile({ controlledFileRef, expected, paths }) {
  const result = readObserved(resolveControlledFileRef(paths, controlledFileRef), {
    byteSize: expected.byteSize,
    identity: expected.identity,
    parentIdentity: expected.parentIdentity,
  });
  return Object.freeze({
    byteSize: result.byteSize,
    bytes: result.bytes,
    identity: result.identity,
    parentIdentity: result.parentIdentity,
    stable: true,
  });
}

const READ_IMPLEMENTATION = Object.freeze({
  enumerateDirectory,
  inspectDirectory,
  inspectPath,
  listActualNames,
  probeControlledFile,
  readControlledFile,
});

const WRITER_IMPLEMENTATION = Object.freeze({
  createAssetVerified,
  deleteVerified,
  readVerified,
  relocateVerifiedToAbsent,
});

function createProductionManuscriptFileBoundary() {
  if (arguments.length !== 0) {
    throw new TypeError('createProductionManuscriptFileBoundary accepts no arguments');
  }
  if (productionPair !== undefined) return productionPair;
  const readCapability = mintFileBoundaryCapability(READ_IMPLEMENTATION, PRODUCTION_OPTIONS);
  const writerCapability = mintFileWriterCapability(WRITER_IMPLEMENTATION, PRODUCTION_OPTIONS);
  productionPair = Object.freeze({ readCapability, writerCapability });
  productionPairRecords.set(productionPair, Object.freeze({
    backendToken: PRODUCTION_BACKEND_TOKEN,
    readCapability,
    writerCapability,
  }));
  return productionPair;
}

function assertProductionManuscriptFileBoundaryPair(pair) {
  if (arguments.length !== 1) {
    throw new TypeError('production manuscript file boundary pair is required');
  }
  const pairRecord = (
    pair !== null && typeof pair === 'object'
  ) ? productionPairRecords.get(pair) : undefined;
  if (pairRecord === undefined) {
    throw new TypeError('manuscript file boundary pair was not minted by the production factory');
  }
  const readRecord = requireFileBoundaryCapability(pair.readCapability);
  const writerRecord = requireFileWriterCapability(pair.writerCapability);
  if (
    pair.readCapability !== pairRecord.readCapability
    || pair.writerCapability !== pairRecord.writerCapability
    || readRecord.mode !== 'production'
    || writerRecord.mode !== 'production'
    || readRecord.backendToken !== pairRecord.backendToken
    || writerRecord.backendToken !== pairRecord.backendToken
  ) {
    throw new TypeError('manuscript file boundary pair is not one production backend pair');
  }
  return pair;
}

module.exports = {
  assertProductionManuscriptFileBoundaryPair,
  createProductionManuscriptFileBoundary,
};
