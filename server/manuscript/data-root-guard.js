'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { manuscriptError, ROUTES } = require('./contracts');

const ROUTE_SET = new Set(ROUTES);
const BLOCKING_ROUTES = new Set(['files', 'migrating', 'retired']);
const TERMINAL_CREATION_STATES = new Set(['activated']);

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
  const actual = Reflect.ownKeys(descriptors);
  const expected = [...keys].sort();
  if (
    actual.some((key) => typeof key !== 'string')
    || actual.length !== expected.length
    || actual.map(String).sort().some((key, index) => key !== expected[index])
  ) invalid(`${label} has an inexact key set`);
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

function snapshotDataArray(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  const result = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) invalid(`${label} must contain dense data properties`);
    result[index] = descriptor.value;
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string'
      || !/^(0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= length
    ) invalid(`${label} has an invalid array property`);
  }
  return Object.freeze(result);
}

function snapshotStringArray(value, label) {
  const result = snapshotDataArray(value, label);
  if (result.some((entry) => typeof entry !== 'string')) {
    invalid(`${label} must contain string data`);
  }
  return result;
}

function assertNativeDataRootChangeAllowed(snapshotValue) {
  const snapshot = exactData(
    snapshotValue,
    ['creationJournals', 'routes'],
    'data-root guard snapshot',
  );
  const routes = snapshotStringArray(snapshot.routes, 'data-root guard routes');
  for (const route of routes) {
    if (!ROUTE_SET.has(route)) invalid('data-root guard route is invalid');
    if (BLOCKING_ROUTES.has(route)) {
      throw manuscriptError('NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED', {
        reason: 'FILE_AUTHORITY_PROJECT_PRESENT',
        route,
      });
    }
  }
  const creationJournals = snapshotDataArray(
    snapshot.creationJournals,
    'data-root guard creationJournals',
  );
  for (let index = 0; index < creationJournals.length; index += 1) {
    const journal = exactData(
      creationJournals[index],
      ['state'],
      `data-root guard creationJournals[${index}]`,
    );
    if (typeof journal.state !== 'string' || journal.state.length === 0) {
      invalid(`data-root guard creationJournals[${index}].state must be non-empty`);
    }
    if (!TERMINAL_CREATION_STATES.has(journal.state)) {
      throw manuscriptError('NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED', {
        reason: 'NONTERMINAL_PROJECT_CREATION_PRESENT',
        state: journal.state,
      });
    }
  }
  return Object.freeze({ allowed: true });
}

function pathApiFor(candidateRoot) {
  return /^[a-zA-Z]:[\\/]/u.test(candidateRoot) || candidateRoot.startsWith('\\\\')
    ? path.win32
    : path;
}

function alternative(candidateRoot, reason) {
  return Object.freeze({
    allowed: false,
    alternative: 'LOCAL_NON_SYNCED_DIRECTORY',
    candidateRoot,
    kind: 'ALTERNATIVE_LOCATION_REQUIRED',
    reason,
  });
}

function inspectDefaultRoot(candidateRoot) {
  const segments = candidateRoot.split(/[\\/]+/u).map((segment) => segment.toLowerCase());
  let cloudProvider = null;
  if (segments.some((segment) => segment === 'onedrive' || segment.startsWith('onedrive - '))) {
    cloudProvider = 'ONEDRIVE';
  } else if (
    segments.some((segment) => (
      segment === 'iclouddrive'
      || segment === 'mobile documents'
      || segment === 'com~apple~clouddocs'
    ))
  ) {
    cloudProvider = 'ICLOUD';
  }

  const pathApi = pathApiFor(candidateRoot);
  let isSymbolicLink = false;
  for (let current = candidateRoot;; current = pathApi.dirname(current)) {
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (cause) {
      if (cause?.code !== 'ENOENT') throw cause;
    }
    if (stats?.isSymbolicLink()) {
      isSymbolicLink = true;
      break;
    }
    const parent = pathApi.dirname(current);
    if (parent === current) break;
  }
  return Object.freeze({
    cloudProvider,
    isSymbolicLink,
    reparse: isSymbolicLink,
  });
}

const DEFAULT_ROOT_OBSERVATION = Object.freeze({ inspect: inspectDefaultRoot });

function inspectCloudOrReparseRoot(candidateRoot, rootObservation = DEFAULT_ROOT_OBSERVATION) {
  if (typeof candidateRoot !== 'string' || candidateRoot.length === 0 || candidateRoot.includes('\0')) {
    invalid('candidateRoot must be a non-empty absolute path');
  }
  const pathApi = pathApiFor(candidateRoot);
  if (
    !pathApi.isAbsolute(candidateRoot)
    || pathApi.normalize(candidateRoot) !== candidateRoot
  ) invalid('candidateRoot must be an absolute normalized path');

  if (
    rootObservation === null
    || (typeof rootObservation !== 'object' && typeof rootObservation !== 'function')
    || typeof rootObservation.inspect !== 'function'
  ) invalid('rootObservation.inspect must be a function');
  const evidence = Reflect.apply(rootObservation.inspect, rootObservation, [candidateRoot]);
  const observed = exactData(
    evidence,
    ['cloudProvider', 'isSymbolicLink', 'reparse'],
    'root observation evidence',
  );
  if (!Object.isFrozen(evidence)) invalid('root observation evidence must be frozen');
  if (
    observed.cloudProvider !== null
    && (typeof observed.cloudProvider !== 'string' || observed.cloudProvider.length === 0)
  ) invalid('root observation cloudProvider must be null or a non-empty string');
  if (
    typeof observed.isSymbolicLink !== 'boolean'
    || typeof observed.reparse !== 'boolean'
  ) invalid('root observation link evidence must be boolean');
  if (observed.cloudProvider !== null) {
    return alternative(candidateRoot, observed.cloudProvider);
  }
  if (observed.reparse || observed.isSymbolicLink) return alternative(candidateRoot, 'REPARSE');
  return Object.freeze({
    allowed: true,
    candidateRoot,
    kind: 'SUPPORTED_LOCAL_ROOT',
  });
}

module.exports = {
  assertNativeDataRootChangeAllowed,
  inspectCloudOrReparseRoot,
};
