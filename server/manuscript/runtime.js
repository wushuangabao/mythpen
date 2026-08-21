'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const READ_KINDS = new Set(['project', 'chapters', 'chapter', 'volumes', 'volume']);
const WRITE_KINDS = new Set([
  'chapter.replace_body',
  'chapter.patch_sidecar',
  'chapter.replace_body_and_sidecar',
  'chapter.create',
  'chapter.delete',
  'chapter.move',
  'chapter.reorder',
  'volume.patch_metadata',
  'volume.create',
  'volume.delete',
  'volume.reorder',
]);
let installedRuntime = null;

function runtimeError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'ManuscriptRuntimeError';
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactData(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || actual.some((key) => {
      const descriptor = descriptors[key];
      return descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value');
    })
  ) throw new TypeError(`${label} has an invalid shape`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function snapshotPlain(value, label, active = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError(`${label} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== 'object' || active.has(value)) {
    throw new TypeError(`${label} must contain finite plain data`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${label} must contain plain arrays`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
        throw new TypeError(`${label} must contain dense arrays`);
      }
      return Object.freeze(value.map((entry, index) => (
        snapshotPlain(entry, `${label}[${index}]`, active)
      )));
    }
    if (!isPlainObject(value)) throw new TypeError(`${label} must contain plain objects`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (
        typeof key !== 'string'
        || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')
      ) throw new TypeError(`${label} must contain enumerable string data properties only`);
      if (/(?:^|_)(?:path|ref)$/iu.test(key) || /(?:Path|Ref)$/u.test(key)) {
        throw new TypeError(`${label} may not contain caller-supplied paths or branded refs`);
      }
      result[key] = snapshotPlain(descriptor.value, `${label}.${key}`, active);
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

function capturePort(value, methods, label) {
  if (value === null || typeof value !== 'object') throw new TypeError(`${label} is required`);
  return Object.freeze(Object.fromEntries(methods.map((method) => {
    if (typeof value[method] !== 'function') throw new TypeError(`${label}.${method} is required`);
    return [method, value[method].bind(value)];
  })));
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function generation(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function selector(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (isPlainObject(value) && Object.hasOwn(value, 'projectName')) {
    const input = exactData(value, ['projectName'], 'projectSelector');
    return Object.freeze({ projectName: nonEmpty(input.projectName, 'projectSelector.projectName') });
  }
  const input = exactData(value, ['projectUid'], 'projectSelector');
  return Object.freeze({ projectUid: canonicalUuid(input.projectUid, 'projectSelector.projectUid') });
}

function witness(value, label = 'baseWitness') {
  const input = exactData(
    value,
    ['expectedDataVersion', 'generation', 'rawSha256', 'sidecarRawSha256'],
    label,
  );
  if (!HASH_PATTERN.test(input.rawSha256)) {
    throw new TypeError(`${label}.rawSha256 must be a lowercase SHA-256 digest`);
  }
  if (input.sidecarRawSha256 !== null && !HASH_PATTERN.test(input.sidecarRawSha256)) {
    throw new TypeError(`${label}.sidecarRawSha256 must be null or a lowercase SHA-256 digest`);
  }
  return Object.freeze({
    expectedDataVersion: generation(input.expectedDataVersion, `${label}.expectedDataVersion`),
    generation: generation(input.generation, `${label}.generation`),
    rawSha256: input.rawSha256,
    sidecarRawSha256: input.sidecarRawSha256,
  });
}

function sameWitness(left, right) {
  return left.expectedDataVersion === right.expectedDataVersion
    && left.generation === right.generation
    && left.rawSha256 === right.rawSha256
    && left.sidecarRawSha256 === right.sidecarRawSha256;
}

function verifyActivatedSchema12Admission(value) {
  let admission;
  try {
    admission = exactData(
      value,
      ['activatedProof', 'databaseFacts', 'route', 'routeFacts'],
      'schema12 admission',
    );
    if (admission.route !== 'files') throw new TypeError('schema12 admission route must be files');
    const database = exactData(admission.databaseFacts, [
      'projectInstanceId',
      'projectUid',
      'projectionGeneration',
      'route',
      'routeJournal',
      'schemaVersion',
    ], 'schema12 database facts');
    const route = exactData(admission.routeFacts, [
      'projectInstanceId',
      'projectUid',
      'projectionGeneration',
      'route',
      'routeJournal',
    ], 'schema12 route facts');
    const proof = exactData(admission.activatedProof, [
      'journalId',
      'kind',
      'projectInstanceId',
      'projectUid',
      'state',
      'targetGeneration',
    ], 'schema12 activated proof');
    if (!['migration', 'creation'].includes(proof.kind) || proof.state !== 'activated') {
      throw new TypeError('schema12 durable proof is not activated');
    }
    canonicalUuid(database.projectUid, 'databaseFacts.projectUid');
    canonicalUuid(database.projectInstanceId, 'databaseFacts.projectInstanceId');
    canonicalUuid(database.routeJournal, 'databaseFacts.routeJournal');
    canonicalUuid(route.projectUid, 'routeFacts.projectUid');
    canonicalUuid(route.projectInstanceId, 'routeFacts.projectInstanceId');
    canonicalUuid(route.routeJournal, 'routeFacts.routeJournal');
    canonicalUuid(proof.projectUid, 'activatedProof.projectUid');
    canonicalUuid(proof.projectInstanceId, 'activatedProof.projectInstanceId');
    canonicalUuid(proof.journalId, 'activatedProof.journalId');
    generation(database.projectionGeneration, 'databaseFacts.projectionGeneration');
    generation(route.projectionGeneration, 'routeFacts.projectionGeneration');
    generation(proof.targetGeneration, 'activatedProof.targetGeneration');
    if (
      database.schemaVersion !== 12
      || database.route !== 'files'
      || route.route !== 'files'
      || database.projectUid !== route.projectUid
      || database.projectUid !== proof.projectUid
      || database.projectInstanceId !== route.projectInstanceId
      || database.projectInstanceId !== proof.projectInstanceId
      || database.routeJournal !== route.routeJournal
      || database.routeJournal !== proof.journalId
      || database.projectionGeneration !== route.projectionGeneration
      || database.projectionGeneration < proof.targetGeneration
    ) throw new TypeError('schema12 database, route, and durable proof differ');
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw runtimeError(
      'RECOVERY_REQUIRED',
      'Schema 12 project lacks one matching activated migration or creation proof',
      cause,
    );
  }
  return value;
}

function readOnlyControlStore(directory) {
  const { inspectControlStoreEvidence } = require('../control-store');
  const evidence = inspectControlStoreEvidence(directory);
  const events = Object.freeze(evidence.events);
  return Object.freeze({
    directory,
    incarnationId: evidence.projection.incarnationId,
    compareAndAppend() {
      throw runtimeError('RECOVERY_REQUIRED', 'Read-only admission may not append journal events');
    },
    read() { return events; },
    tail() { return events.at(-1) ?? null; },
  });
}

function dispositionPort() {
  return Object.freeze({
    classify() { throw runtimeError('RECOVERY_REQUIRED', 'Admission proof may not classify new evidence'); },
    inspect() { throw runtimeError('RECOVERY_REQUIRED', 'Admission proof may not inspect mutable disposition'); },
  });
}

function loadDurableActivatedProof({ dataRoot, databaseFacts }) {
  if (
    typeof dataRoot !== 'string'
    || !path.isAbsolute(dataRoot)
    || path.resolve(dataRoot) !== dataRoot
  ) throw new TypeError('dataRoot must be one canonical absolute path');
  const database = exactData(databaseFacts, [
    'projectInstanceId',
    'projectUid',
    'projectionGeneration',
    'route',
    'routeJournal',
    'schemaVersion',
  ], 'schema12 database facts');
  const proofs = [];
  const creationDirectory = path.join(
    dataRoot,
    'control',
    'project-creation',
    database.routeJournal,
  );
  if (fs.existsSync(creationDirectory)) {
    const { ProjectCreationJournal } = require('./project-creation-journal');
    const journal = new ProjectCreationJournal({
      childDisposition: dispositionPort(),
      clock: Date.now,
      controlStore: readOnlyControlStore(creationDirectory),
      creationId: database.routeJournal,
      dataRoot,
      databaseDisposition: dispositionPort(),
    });
    const view = journal.read();
    if (view?.state === 'activated') proofs.push(Object.freeze({
      kind: 'creation',
      state: 'activated',
      journalId: view.creationId,
      projectUid: view.projectUid,
      projectInstanceId: view.projectInstanceId,
      targetGeneration: view.targetGeneration,
    }));
  }
  const migrationDirectory = path.join(
    dataRoot,
    'control',
    'manuscripts',
    database.projectUid,
    database.projectInstanceId,
  );
  if (fs.existsSync(migrationDirectory)) {
    const { MigrationJournal } = require('./migration-journal');
    const controlStore = readOnlyControlStore(migrationDirectory);
    const journal = new MigrationJournal({
      childDisposition: dispositionPort(),
      cleanupDisposition: dispositionPort(),
      clock: Date.now,
      controlStore,
      databaseDisposition: dispositionPort(),
      projectBinding: Object.freeze({
        controlIncarnationId: controlStore.incarnationId,
        dataRoot,
        projectUid: database.projectUid,
        projectInstanceId: database.projectInstanceId,
      }),
      routeDisposition: dispositionPort(),
    });
    try {
      const view = journal.read(database.routeJournal);
      if (view.state === 'activated') proofs.push(Object.freeze({
        kind: 'migration',
        state: 'activated',
        journalId: view.migrationId,
        projectUid: view.projectUid,
        projectInstanceId: view.projectInstanceId,
        targetGeneration: view.targetGeneration,
      }));
    } catch (cause) {
      if (
        cause?.code !== 'RECOVERY_REQUIRED'
        || cause?.details?.reason !== 'migration journal does not exist'
      ) throw cause;
    }
  }
  if (proofs.length !== 1) {
    throw runtimeError(
      'RECOVERY_REQUIRED',
      'Schema 12 project must have exactly one activated migration or creation proof',
    );
  }
  return proofs[0];
}

function projectMetadata(value) {
  const input = exactData(value, ['genres', 'language', 'mode', 'name'], 'projectMetadata');
  nonEmpty(input.name, 'projectMetadata.name');
  nonEmpty(input.mode, 'projectMetadata.mode');
  nonEmpty(input.language, 'projectMetadata.language');
  if (!Array.isArray(input.genres) || input.genres.length === 0) {
    throw new TypeError('projectMetadata.genres must be a non-empty array');
  }
  const genres = input.genres.map((entry, index) => (
    nonEmpty(entry, `projectMetadata.genres[${index}]`)
  ));
  return Object.freeze({
    name: input.name,
    mode: input.mode,
    language: input.language,
    genres: Object.freeze(genres),
  });
}

function readRequest(value) {
  const safe = snapshotPlain(value, 'read request');
  if (!READ_KINDS.has(safe.kind)) throw new TypeError('read request kind is unsupported');
  return safe;
}

function writeRequest(value) {
  const input = exactData(value, ['baseWitness', 'command', 'requestId'], 'write request');
  const command = snapshotPlain(input.command, 'command');
  if (!WRITE_KINDS.has(command.kind)) {
    if (command.kind === 'project.delete') {
      throw runtimeError(
        'PROJECT_PERMANENT_DELETE_UNSUPPORTED',
        'Files-authority projects cannot be permanently deleted',
      );
    }
    throw new TypeError('command kind is unsupported');
  }
  return Object.freeze({
    requestId: nonEmpty(input.requestId, 'requestId'),
    baseWitness: input.baseWitness === null ? null : witness(input.baseWitness),
    command,
  });
}

function createManuscriptRuntime(options) {
  const input = exactData(
    options,
    ['creation', 'files', 'migration', 'routeResolver', 'sqlite'],
    'manuscript runtime options',
  );
  const routeResolver = capturePort(input.routeResolver, ['admit'], 'routeResolver');
  const sqlite = capturePort(input.sqlite, ['close', 'read', 'recover', 'write'], 'sqlite');
  const files = capturePort(
    input.files,
    ['close', 'read', 'recover', 'resolveCommand', 'snapshotWitness', 'write'],
    'files',
  );
  const creation = capturePort(input.creation, ['create'], 'creation');
  const migration = capturePort(input.migration, ['migrate', 'recover'], 'migration');
  let closed = false;

  function assertOpen() {
    if (closed) throw runtimeError('RECOVERY_REQUIRED', 'Manuscript runtime is closed');
  }

  async function admit(projectSelector) {
    const admitted = await routeResolver.admit(projectSelector);
    if (admitted?.route === 'sqlite') return Object.freeze({ route: 'sqlite' });
    verifyActivatedSchema12Admission(admitted);
    return admitted;
  }

  return Object.freeze({
    async createProject(value) {
      assertOpen();
      const request = exactData(
        value,
        ['genres', 'language', 'mode', 'name', 'requestId'],
        'createProject request',
      );
      const metadata = projectMetadata({
        name: request.name,
        mode: request.mode,
        language: request.language,
        genres: request.genres,
      });
      const result = await creation.create(Object.freeze({
        requestId: nonEmpty(request.requestId, 'requestId'),
        projectMetadata: metadata,
      }));
      if (result?.state !== 'activated') {
        throw runtimeError('RECOVERY_REQUIRED', 'Project creation did not reach activated');
      }
      canonicalUuid(result.projectUid, 'creation result.projectUid');
      return result;
    },
    async migrateProject(value) {
      assertOpen();
      const request = exactData(value, ['projectSelector', 'requestId'], 'migrateProject request');
      return migration.migrate(Object.freeze({
        projectSelector: selector(request.projectSelector),
        requestId: nonEmpty(request.requestId, 'requestId'),
      }));
    },
    async read(projectSelector, requestValue) {
      assertOpen();
      const safeSelector = selector(projectSelector);
      const request = readRequest(requestValue);
      const admission = await admit(safeSelector);
      if (admission.route === 'sqlite') return sqlite.read(safeSelector, request);
      const value = await files.read(admission, request);
      const baseWitness = witness(
        await files.snapshotWitness(admission, request),
        'server baseWitness',
      );
      return Object.freeze({ value, baseWitness });
    },
    async write(projectSelector, requestValue) {
      assertOpen();
      const safeSelector = selector(projectSelector);
      const request = writeRequest(requestValue);
      const admission = await admit(safeSelector);
      if (admission.route === 'sqlite') return sqlite.write(safeSelector, request);
      const expected = witness(request.baseWitness);
      const current = witness(
        await files.snapshotWitness(admission, request.command),
        'server currentWitness',
      );
      const commandDataVersion = request.command.expected_data_version;
      if (
        !sameWitness(expected, current)
        || (commandDataVersion !== undefined
          && commandDataVersion !== current.expectedDataVersion)
      ) throw runtimeError(
        'EXTERNAL_DRAFT_CONFLICT',
        'The durable manuscript resource changed after this draft was based on it',
      );
      const command = await files.resolveCommand(admission, request.command);
      return files.write(admission, Object.freeze({
        requestId: request.requestId,
        baseWitness: expected,
        command,
        witnessCommand: request.command,
      }));
    },
    async recover(projectSelector) {
      assertOpen();
      const safeSelector = selector(projectSelector);
      const admission = await admit(safeSelector);
      return admission.route === 'sqlite'
        ? sqlite.recover(safeSelector)
        : files.recover(admission);
    },
    close() {
      if (closed) return;
      closed = true;
      files.close();
      sqlite.close();
    },
  });
}

function installManuscriptRuntime(runtime) {
  if (installedRuntime !== null) {
    throw new TypeError('manuscript runtime is already installed');
  }
  installedRuntime = capturePort(
    runtime,
    ['close', 'createProject', 'migrateProject', 'read', 'recover', 'write'],
    'manuscript runtime',
  );
  return installedRuntime;
}

function getManuscriptRuntime() {
  if (installedRuntime === null) {
    throw runtimeError('RECOVERY_REQUIRED', 'Manuscript runtime is not installed');
  }
  return installedRuntime;
}

module.exports = {
  createManuscriptRuntime,
  getManuscriptRuntime,
  installManuscriptRuntime,
  loadDurableActivatedProof,
  verifyActivatedSchema12Admission,
};
