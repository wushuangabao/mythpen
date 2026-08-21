'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { RESERVED_PROJECT_META_KEYS } = require('./contracts');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTEXT_KEYS = Object.freeze([
  'kind',
  'migrationId',
  'projectUid',
  'projectInstanceId',
  'sourcePath',
  'sourceIdentity',
  'sourceSha256',
  'candidatePath',
  'candidateIdentity',
  'candidateSha256',
  'journalTailDigest',
  'reservationDigest',
  'baseGeneration',
  'targetGeneration',
]);
const AUTHORITY_KEYS = Object.freeze([
  'readObservation',
  'describeObservation',
  'assertTransitionAllowed',
  'assertMigrationContext',
  'readMigrationReserved',
  'describeMigrationReserved',
]);
const routeCasRecords = new WeakMap();
const creationCasRecords = new WeakMap();
const CREATION_CONTEXT_KEYS = Object.freeze([
  'kind',
  'creationId',
  'projectUid',
  'projectInstanceId',
  'projectMetadata',
  'candidatePath',
  'candidateIdentity',
  'candidateSha256',
  'finalPath',
  'finalParentIdentity',
  'transitionProofDigest',
  'journalTailDigest',
  'reservationDigest',
  'baseGeneration',
  'targetGeneration',
  'finalCommitSeq',
]);
const CREATION_AUTHORITY_KEYS = Object.freeze([
  'readObservation',
  'describeObservation',
  'assertTransitionAllowed',
  'assertCreationContext',
]);

function routeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function assertFrozenPlainTree(value, label) {
  if (value === null || typeof value !== 'object') return;
  if (!Object.isFrozen(value)) throw routeError('RECOVERY_REQUIRED', `${label} must be recursively frozen`);
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw routeError('RECOVERY_REQUIRED', `${label} must contain only plain data`);
  }
  for (const child of Object.values(value)) assertFrozenPlainTree(child, label);
}

function canonicalInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw routeError('RECOVERY_REQUIRED', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalAbsolutePath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
    || path.resolve(value) !== value
  ) {
    throw routeError('RECOVERY_REQUIRED', `${label} must be one canonical absolute path`);
  }
  return value;
}

function canonicalPhysicalName(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function exactIdentity(value, label) {
  if (
    !exactKeys(value, ['dev', 'ino'])
    || !/^\d+$/.test(value.dev)
    || !/^\d+$/.test(value.ino)
  ) throw routeError('RECOVERY_REQUIRED', `${label} is invalid`);
  return value;
}

function validateMigrationContext(value) {
  assertFrozenPlainTree(value, 'MigrationContext');
  if (!exactKeys(value, CONTEXT_KEYS)) {
    throw routeError('RECOVERY_REQUIRED', 'MigrationContext has an inexact key set');
  }
  if (
    value.kind !== 'migration'
    || !UUID_PATTERN.test(value.migrationId)
    || !UUID_PATTERN.test(value.projectUid)
    || !UUID_PATTERN.test(value.projectInstanceId)
  ) throw routeError('RECOVERY_REQUIRED', 'MigrationContext identity is invalid');
  canonicalAbsolutePath(value.sourcePath, 'MigrationContext.sourcePath');
  canonicalAbsolutePath(value.candidatePath, 'MigrationContext.candidatePath');
  if (value.sourcePath === value.candidatePath) {
    throw routeError('RECOVERY_REQUIRED', 'MigrationContext source and candidate paths must differ');
  }
  exactIdentity(value.sourceIdentity, 'MigrationContext.sourceIdentity');
  exactIdentity(value.candidateIdentity, 'MigrationContext.candidateIdentity');
  for (const key of [
    'sourceSha256', 'candidateSha256', 'journalTailDigest', 'reservationDigest',
  ]) {
    if (!SHA256_PATTERN.test(value[key])) {
      throw routeError('RECOVERY_REQUIRED', `MigrationContext.${key} is invalid`);
    }
  }
  canonicalInteger(value.baseGeneration, 'MigrationContext.baseGeneration');
  canonicalInteger(value.targetGeneration, 'MigrationContext.targetGeneration');
  if (value.targetGeneration !== value.baseGeneration + 1) {
    throw routeError('RECOVERY_REQUIRED', 'MigrationContext generation transition is invalid');
  }
  return value;
}

function validateCreationContext(value) {
  assertFrozenPlainTree(value, 'ProjectCreationContext');
  if (!exactKeys(value, CREATION_CONTEXT_KEYS)) {
    throw routeError('RECOVERY_REQUIRED', 'ProjectCreationContext has an inexact key set');
  }
  if (
    value.kind !== 'new_creation'
    || !UUID_PATTERN.test(value.creationId)
    || !UUID_PATTERN.test(value.projectUid)
    || !UUID_PATTERN.test(value.projectInstanceId)
  ) throw routeError('RECOVERY_REQUIRED', 'ProjectCreationContext identity is invalid');
  const metadata = value.projectMetadata;
  if (
    !isPlainObject(metadata)
    || !exactKeys(metadata, ['genres', 'language', 'mode', 'name'])
    || typeof metadata.name !== 'string'
    || metadata.name.length === 0
    || typeof metadata.mode !== 'string'
    || metadata.mode.length === 0
    || typeof metadata.language !== 'string'
    || metadata.language.length === 0
    || !Array.isArray(metadata.genres)
    || metadata.genres.length === 0
    || metadata.genres.some((genre) => typeof genre !== 'string' || genre.length === 0)
  ) throw routeError('RECOVERY_REQUIRED', 'ProjectCreationContext metadata is invalid');
  canonicalAbsolutePath(value.candidatePath, 'ProjectCreationContext.candidatePath');
  canonicalAbsolutePath(value.finalPath, 'ProjectCreationContext.finalPath');
  if (
    value.candidatePath === value.finalPath
    || path.dirname(value.candidatePath) !== path.dirname(value.finalPath)
  ) throw routeError('RECOVERY_REQUIRED', 'Creation candidate must be side-by-side with final');
  exactIdentity(value.candidateIdentity, 'ProjectCreationContext.candidateIdentity');
  exactIdentity(value.finalParentIdentity, 'ProjectCreationContext.finalParentIdentity');
  for (const key of [
    'candidateSha256',
    'transitionProofDigest',
    'journalTailDigest',
    'reservationDigest',
  ]) {
    if (!SHA256_PATTERN.test(value[key])) {
      throw routeError('RECOVERY_REQUIRED', `ProjectCreationContext.${key} is invalid`);
    }
  }
  canonicalInteger(value.baseGeneration, 'ProjectCreationContext.baseGeneration');
  canonicalInteger(value.targetGeneration, 'ProjectCreationContext.targetGeneration');
  canonicalInteger(value.finalCommitSeq, 'ProjectCreationContext.finalCommitSeq');
  if (
    value.baseGeneration !== 0
    || value.targetGeneration !== 1
    || value.finalCommitSeq < 1
  ) throw routeError('RECOVERY_REQUIRED', 'ProjectCreationContext transition is invalid');
  return value;
}

function assertCreationJournalAuthority(authority) {
  if (
    !Object.isFrozen(authority)
    || !exactKeys(authority, CREATION_AUTHORITY_KEYS)
    || CREATION_AUTHORITY_KEYS.some((key) => typeof authority[key] !== 'function')
  ) throw new TypeError('journalAuthority must be the exact frozen creation authority');
  return authority;
}

function inspectCreationPath(filePath, expectedIdentity, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath, { bigint: true });
  } catch (cause) {
    if (cause?.code === 'ENOENT') return 'absent';
    throw routeError('RECOVERY_REQUIRED', `${label} cannot be inspected`, cause);
  }
  if (stats.isSymbolicLink()) {
    throw routeError('MANUSCRIPT_PATH_UNSAFE', `${label} is reparse-backed`);
  }
  if (
    !stats.isFile()
    || stats.nlink !== 1n
    || String(stats.dev) !== expectedIdentity.dev
    || String(stats.ino) !== expectedIdentity.ino
  ) throw routeError('RECOVERY_REQUIRED', `${label} identity is not journal-bound`);
  let realPath;
  try {
    realPath = fs.realpathSync.native(filePath);
  } catch (cause) {
    throw routeError('RECOVERY_REQUIRED', `${label} physical path is unprovable`, cause);
  }
  if (canonicalPhysicalName(realPath) !== canonicalPhysicalName(filePath)) {
    throw routeError('MANUSCRIPT_PATH_UNSAFE', `${label} is reparse or non-canonical`);
  }
  return 'present';
}

function verifyCreationTopology(context) {
  const parentPath = path.dirname(context.finalPath);
  if (
    path.dirname(context.candidatePath) !== parentPath
    || context.candidatePath === context.finalPath
  ) throw routeError('RECOVERY_REQUIRED', 'Creation database paths escaped their controlled parent');
  let parent;
  try {
    parent = fs.lstatSync(parentPath, { bigint: true });
  } catch (cause) {
    throw routeError('RECOVERY_REQUIRED', 'Creation final parent cannot be inspected', cause);
  }
  if (
    !parent.isDirectory()
    || parent.isSymbolicLink()
    || String(parent.dev) !== context.finalParentIdentity.dev
    || String(parent.ino) !== context.finalParentIdentity.ino
  ) throw routeError('MANUSCRIPT_PATH_UNSAFE', 'Creation final parent identity is unsafe');
  let realParent;
  try {
    realParent = fs.realpathSync.native(parentPath);
  } catch (cause) {
    throw routeError('RECOVERY_REQUIRED', 'Creation final parent physical path is unprovable', cause);
  }
  if (canonicalPhysicalName(realParent) !== canonicalPhysicalName(parentPath)) {
    throw routeError('MANUSCRIPT_PATH_UNSAFE', 'Creation final parent is reparse or non-canonical');
  }
  const candidate = inspectCreationPath(
    context.candidatePath,
    context.candidateIdentity,
    'Creation database candidate',
  );
  const final = inspectCreationPath(
    context.finalPath,
    context.candidateIdentity,
    'Creation final database',
  );
  if (candidate === 'present' && final === 'absent') return 'before';
  if (candidate === 'absent' && final === 'present') return 'after';
  if (candidate === 'present') {
    throw routeError('RECOVERY_REQUIRED', 'Creation final database path is already occupied');
  }
  throw routeError('RECOVERY_REQUIRED', 'Creation candidate and final database are both absent');
}

function assertJournalAuthority(authority) {
  if (
    !Object.isFrozen(authority)
    || !exactKeys(authority, AUTHORITY_KEYS)
    || AUTHORITY_KEYS.some((key) => typeof authority[key] !== 'function')
  ) throw new TypeError('journalAuthority must be the stable exact frozen authority');
  return authority;
}

function readMeta(projectDb) {
  if (!projectDb || typeof projectDb.prepare !== 'function') {
    throw routeError('MIGRATION_STATE_MISMATCH', 'Project database route reader is unavailable');
  }
  let rows;
  try {
    rows = projectDb.prepare(
      'SELECT key, value, typeof(value) AS storageType FROM project_meta ORDER BY key',
    ).all();
  } catch (cause) {
    throw routeError('RECOVERY_REQUIRED', 'Project route metadata cannot be read', cause);
  }
  if (!Array.isArray(rows) || rows.some((row) => (
    typeof row?.key !== 'string'
    || typeof row?.value !== 'string'
    || row.storageType !== 'text'
  ))) throw routeError('MIGRATION_STATE_MISMATCH', 'Project route metadata is malformed');
  const map = new Map();
  for (const row of rows) {
    if (map.has(row.key)) throw routeError('MIGRATION_STATE_MISMATCH', 'Project route metadata is duplicated');
    map.set(row.key, row.value);
  }
  return map;
}

function parseGeneration(raw) {
  if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw routeError('MIGRATION_STATE_MISMATCH', 'Projection generation is not canonical');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || String(value) !== raw) {
    throw routeError('MIGRATION_STATE_MISMATCH', 'Projection generation is outside the safe range');
  }
  return value;
}

function readExplicitRoute(meta) {
  const present = RESERVED_PROJECT_META_KEYS.filter((key) => meta.has(key));
  if (present.length === 0) return null;
  if (present.length !== RESERVED_PROJECT_META_KEYS.length) {
    throw routeError('MIGRATION_STATE_MISMATCH', 'Project route metadata is partial');
  }
  const route = meta.get('manuscript_route');
  if (!['migrating', 'files', 'retired'].includes(route)) {
    throw routeError('MIGRATION_STATE_MISMATCH', 'Project route metadata is invalid');
  }
  const projectUid = meta.get('manuscript_project_uid');
  const routeJournal = meta.get('manuscript_route_journal');
  if (!UUID_PATTERN.test(projectUid) || !UUID_PATTERN.test(routeJournal)) {
    throw routeError('MIGRATION_STATE_MISMATCH', 'Project route identity is invalid');
  }
  return Object.freeze({
    route,
    projectUid,
    routeJournal,
    projectionGeneration: parseGeneration(meta.get('manuscript_projection_generation')),
  });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

class ManuscriptRouteStore {
  constructor({ journalAuthority } = {}) {
    this.journalAuthority = assertJournalAuthority(journalAuthority);
    Object.freeze(this);
  }

  readRoute(projectDb) {
    const meta = readMeta(projectDb);
    const explicit = readExplicitRoute(meta);
    const observation = this.journalAuthority.readObservation();
    const journal = this.journalAuthority.describeObservation(observation);
    if (explicit === null) {
      if (journal.state !== 'none') {
        throw routeError('PROJECT_MIGRATION_BUSY', 'Project has an unpublished migration route');
      }
      return Object.freeze({
        route: 'sqlite',
        explicit: false,
        projectUid: null,
        projectInstanceId: meta.get('project_instance_id') || null,
        routeJournal: null,
        projectionGeneration: 0,
      });
    }
    if (
      journal.projectUid !== explicit.projectUid
      || journal.projectInstanceId !== meta.get('project_instance_id')
      || journal.migrationId !== explicit.routeJournal
    ) throw routeError('MIGRATION_STATE_MISMATCH', 'Project route and journal identity differ');
    if (explicit.route === 'migrating') {
      throw routeError('PROJECT_MIGRATION_BUSY', 'Project migration is in progress');
    }
    return Object.freeze({
      route: explicit.route,
      explicit: true,
      projectUid: explicit.projectUid,
      projectInstanceId: meta.get('project_instance_id'),
      routeJournal: explicit.routeJournal,
      projectionGeneration: explicit.projectionGeneration,
    });
  }

  prepareCompareAndSwap(projectDb, expected, next, binding) {
    if (expected !== 'migrating' || next !== 'files') {
      throw routeError('MIGRATION_STATE_MISMATCH', 'Rapid migration route only admits migrating to files');
    }
    const context = validateMigrationContext(binding);
    const meta = readMeta(projectDb);
    const explicit = readExplicitRoute(meta);
    if (
      explicit === null
      || !['migrating', 'files'].includes(explicit.route)
      || explicit.projectUid !== context.projectUid
      || explicit.routeJournal !== context.migrationId
      || meta.get('project_instance_id') !== context.projectInstanceId
      || (explicit.route === 'migrating'
        ? explicit.projectionGeneration !== context.baseGeneration
        : explicit.projectionGeneration !== context.targetGeneration)
      || !sameIdentity(projectDb.identity, context.candidateIdentity)
    ) throw routeError('MIGRATION_STATE_MISMATCH', 'Candidate route does not match MigrationContext');

    const observation = this.journalAuthority.readObservation();
    const described = this.journalAuthority.describeObservation(observation);
    if (
      described.state !== 'activation_intent'
      || described.projectUid !== context.projectUid
      || described.projectInstanceId !== context.projectInstanceId
      || described.migrationId !== context.migrationId
      || described.tailDigest !== context.journalTailDigest
      || described.reservationDigest !== context.reservationDigest
      || described.baseGeneration !== context.baseGeneration
      || described.targetGeneration !== context.targetGeneration
    ) throw routeError('MIGRATION_STATE_MISMATCH', 'MigrationContext differs from journal observation');
    const transitionProof = this.journalAuthority.assertTransitionAllowed(
      observation,
      Object.freeze({ expected, next }),
    );
    const assertedContext = this.journalAuthority.assertMigrationContext(context);
    if (assertedContext !== context) {
      throw routeError('RECOVERY_REQUIRED', 'journalAuthority replaced MigrationContext');
    }
    const routeCas = Object.freeze(Object.create(null));
    routeCasRecords.set(routeCas, {
      consumed: false,
      observation,
      context,
      transitionProof,
      journalAuthority: this.journalAuthority,
      disposition: explicit.route === 'files' ? 'after' : 'before',
    });
    return routeCas;
  }
}

class ProjectCreationRouteStore {
  constructor({ journalAuthority } = {}) {
    this.journalAuthority = assertCreationJournalAuthority(journalAuthority);
    Object.freeze(this);
  }

  prepareAbsentInstall(binding) {
    const context = validateCreationContext(binding);
    let assertedContext;
    try {
      assertedContext = this.journalAuthority.assertCreationContext(context);
    } catch (cause) {
      throw routeError(
        'RECOVERY_REQUIRED',
        'ProjectCreationContext is not journal-authoritative',
        cause,
      );
    }
    if (assertedContext !== context) {
      throw routeError('RECOVERY_REQUIRED', 'journalAuthority replaced ProjectCreationContext');
    }
    const observation = this.journalAuthority.readObservation();
    const described = this.journalAuthority.describeObservation(observation);
    if (
      described.state !== 'activation_intent'
      || described.creationId !== context.creationId
      || described.projectUid !== context.projectUid
      || described.projectInstanceId !== context.projectInstanceId
      || described.tailDigest !== context.journalTailDigest
      || described.reservationDigest !== context.reservationDigest
      || described.baseGeneration !== context.baseGeneration
      || described.targetGeneration !== context.targetGeneration
    ) throw routeError('RECOVERY_REQUIRED', 'ProjectCreationContext differs from journal observation');
    verifyCreationTopology(context);
    const transitionProof = this.journalAuthority.assertTransitionAllowed(
      observation,
      Object.freeze({ expected: 'absent', next: 'files' }),
    );
    const creationCas = Object.freeze(Object.create(null));
    creationCasRecords.set(creationCas, {
      consumed: false,
      context,
      observation,
      transitionProof,
      journalAuthority: this.journalAuthority,
    });
    return creationCas;
  }
}

function consumeRouteCas(routeCas, options) {
  const record = routeCasRecords.get(routeCas);
  if (!record) throw routeError('ROUTE_CAS_INVALID', 'routeCas is not module-authentic');
  if (record.consumed) throw routeError('ROUTE_CAS_CONSUMED', 'routeCas is already consumed');
  if (
    !exactKeys(options, ['purpose', 'apply'])
    || options.purpose !== 'projection_target'
    || typeof options.apply !== 'function'
  ) throw routeError('ROUTE_CAS_INVALID', 'routeCas consumer input is invalid');
  if (record.journalAuthority.assertMigrationContext(record.context) !== record.context) {
    throw routeError('RECOVERY_REQUIRED', 'routeCas MigrationContext is no longer authoritative');
  }
  record.consumed = true;
  return options.apply(Object.freeze({
    disposition: record.disposition,
    migrationContext: record.context,
    transitionProof: record.transitionProof,
  }));
}

function consumeCreationRouteCas(creationCas, options) {
  const record = creationCasRecords.get(creationCas);
  if (!record) throw routeError('ROUTE_CAS_INVALID', 'creationCas is not module-authentic');
  if (record.consumed) {
    throw routeError('ROUTE_CAS_CONSUMED', 'creationCas is already consumed');
  }
  if (
    !exactKeys(options, ['purpose', 'apply'])
    || options.purpose !== 'new_creation_install'
    || typeof options.apply !== 'function'
  ) throw routeError('ROUTE_CAS_INVALID', 'creationCas consumer input is invalid');
  let assertedContext;
  try {
    assertedContext = record.journalAuthority.assertCreationContext(record.context);
  } catch (cause) {
    throw routeError('RECOVERY_REQUIRED', 'creationCas context is no longer authoritative', cause);
  }
  if (assertedContext !== record.context) {
    throw routeError('RECOVERY_REQUIRED', 'creationCas context is no longer authoritative');
  }
  record.consumed = true;
  return options.apply(Object.freeze({
    creationContext: record.context,
    transitionProof: record.transitionProof,
  }));
}

module.exports = {
  ManuscriptRouteStore,
  ProjectCreationRouteStore,
  consumeCreationRouteCas,
  consumeRouteCas,
};
