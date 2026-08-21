'use strict';

const FILE_BOUNDARY_METHODS = Object.freeze([
  'enumerateDirectory',
  'inspectDirectory',
  'inspectPath',
  'listActualNames',
  'probeControlledFile',
  'readControlledFile',
]);
const FILE_WRITER_METHODS = Object.freeze([
  'createAssetVerified',
  'deleteVerified',
  'readVerified',
  'relocateVerifiedToAbsent',
]);
const JOURNAL_AUTHORITY_METHODS = Object.freeze(['resolveCandidate']);

const fileBoundaryRecords = new WeakMap();
const fileWriterRecords = new WeakMap();
const journalAuthorityRecords = new WeakMap();

function dataDescriptors(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label} must contain enumerable string data properties only`);
    }
  }
  return descriptors;
}

function snapshotMethods(implementation, methodNames, label) {
  const descriptors = dataDescriptors(implementation, label);
  const actual = Object.keys(descriptors).sort();
  const expected = [...methodNames].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const methods = {};
  for (const methodName of methodNames) {
    const method = descriptors[methodName].value;
    if (typeof method !== 'function') throw new TypeError(`${label}.${methodName} is required`);
    methods[methodName] = method;
  }
  return Object.freeze(methods);
}

function snapshotMintOptions(options) {
  const descriptors = dataDescriptors(options, 'capability mint options');
  const keys = Object.keys(descriptors).sort();
  if (keys.join(',') !== 'backendToken,mode') {
    throw new TypeError('capability mint options have an invalid shape');
  }
  const backendToken = descriptors.backendToken.value;
  const mode = descriptors.mode.value;
  if (
    (backendToken === null || (typeof backendToken !== 'object' && typeof backendToken !== 'function'))
    || (mode !== 'production' && mode !== 'test')
  ) {
    throw new TypeError('capability mint options are invalid');
  }
  return { backendToken, mode };
}

function mintCapability(records, capabilityName, implementation, methodNames, label, options) {
  const { backendToken, mode } = snapshotMintOptions(options);
  const capability = Object.freeze({ capability: capabilityName });
  records.set(capability, Object.freeze({
    backendToken,
    methods: snapshotMethods(implementation, methodNames, label),
    mode,
  }));
  return capability;
}

function requireCapability(records, capability, label) {
  const record = (
    capability !== null
    && typeof capability === 'object'
  ) ? records.get(capability) : undefined;
  if (record === undefined) throw new TypeError(`${label} must be an opaque manuscript capability`);
  return record;
}

function mintFileBoundaryCapability(implementation, options) {
  return mintCapability(
    fileBoundaryRecords,
    'manuscript_file_boundary',
    implementation,
    FILE_BOUNDARY_METHODS,
    'fileBoundary implementation',
    options,
  );
}

function mintFileWriterCapability(implementation, options) {
  return mintCapability(
    fileWriterRecords,
    'manuscript_file_writer',
    implementation,
    FILE_WRITER_METHODS,
    'fileWriter implementation',
    options,
  );
}

function mintJournalAuthorityCapability(implementation, options) {
  return mintCapability(
    journalAuthorityRecords,
    'manuscript_journal_authority',
    implementation,
    JOURNAL_AUTHORITY_METHODS,
    'journalAuthority implementation',
    options,
  );
}

function requireFileBoundaryCapability(capability) {
  return requireCapability(fileBoundaryRecords, capability, 'fileBoundary');
}

function requireFileWriterCapability(capability) {
  return requireCapability(fileWriterRecords, capability, 'fileWriter');
}

function requireJournalAuthorityCapability(capability) {
  return requireCapability(journalAuthorityRecords, capability, 'journalAuthority');
}

module.exports = {
  mintFileBoundaryCapability,
  mintFileWriterCapability,
  mintJournalAuthorityCapability,
  requireFileBoundaryCapability,
  requireFileWriterCapability,
  requireJournalAuthorityCapability,
};
