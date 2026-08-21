'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const READ_KINDS = new Set([
  'project',
  'chapters',
  'chapter',
  'volumes',
  'volume',
  'prompt_context',
  'product_view',
  'stats',
  'export_snapshot',
  'character_associations',
  'revision_snapshot',
]);
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
  'ignored.preserve_move_to_unassigned',
  'ignored.detach_reference',
  'revision.create',
  'revision.update_decisions',
  'revision.reject',
  'revision.accept',
  'revision.finalize',
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
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new TypeError(`${label} must contain canonical arrays`);
      }
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')
        ) throw new TypeError(`${label} must contain dense data arrays`);
        result.push(snapshotPlain(descriptor.value, `${label}[${index}]`, active));
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string'
          || !/^(0|[1-9][0-9]*)$/u.test(key)
          || Number(key) >= length
        ) throw new TypeError(`${label} has an invalid array property`);
      }
      return Object.freeze(result);
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
  if (
    value === null
    || (typeof value !== 'object' && typeof value !== 'function')
  ) throw new TypeError(`${label} is required`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const captured = {};
  for (const method of methods) {
    const descriptor = descriptors[method];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || typeof descriptor.value !== 'function'
    ) throw new TypeError(`${label}.${method} must be an own enumerable data method`);
    const implementation = descriptor.value;
    captured[method] = (...args) => Reflect.apply(implementation, value, args);
  }
  return Object.freeze(captured);
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
    const projectName = nonEmpty(input.projectName, 'projectSelector.projectName');
    if (
      projectName === '.'
      || projectName === '..'
      || projectName.trim() !== projectName
      || path.posix.basename(projectName) !== projectName
      || path.win32.basename(projectName) !== projectName
      || path.posix.extname(projectName) !== ''
      || path.win32.extname(projectName) !== ''
    ) throw new TypeError('projectSelector.projectName must be one canonical file stem');
    return Object.freeze({ projectName });
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
  if (!Array.isArray(input.genres)) {
    throw new TypeError('projectMetadata.genres must be a non-empty array');
  }
  const genres = snapshotPlain(input.genres, 'projectMetadata.genres');
  if (genres.length === 0) {
    throw new TypeError('projectMetadata.genres must be a non-empty array');
  }
  for (let index = 0; index < genres.length; index += 1) {
    nonEmpty(genres[index], `projectMetadata.genres[${index}]`);
  }
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
  if (safe.kind === 'revision_snapshot') {
    if (
      Object.keys(safe).sort().join(',') !== 'chapterUid,kind'
      || canonicalUuid(safe.chapterUid, 'revision_snapshot.chapterUid') !== safe.chapterUid
    ) throw new TypeError('revision_snapshot requires one canonical chapterUid');
  }
  if (
    safe.kind === 'character_associations'
    && Object.keys(safe).join(',') !== 'kind'
  ) throw new TypeError('character_associations accepts no selectors');
  return safe;
}

function exactSnapshotKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length
    || actual.some((key, index) => key !== keys[index])
  ) throw new TypeError(`${label} has an invalid shape`);
  return value;
}

function positiveRevisionId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function revisionText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function revisionDecisions(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  for (const [changeId, decision] of Object.entries(value)) {
    if (!changeId || (decision !== 'accepted' && decision !== 'rejected')) {
      throw new TypeError(`${label} contains an invalid decision`);
    }
  }
  return value;
}

function normalizeRevisionCommand(command) {
  if (command.kind === 'revision.create') {
    exactSnapshotKeys(
      command,
      ['kind', 'chapterUid', 'baseContent', 'proposedContent'],
      'revision.create command',
    );
    canonicalUuid(command.chapterUid, 'revision.create chapterUid');
    revisionText(command.baseContent, 'revision.create baseContent');
    revisionText(command.proposedContent, 'revision.create proposedContent');
    return command;
  }
  if (command.kind === 'revision.update_decisions') {
    exactSnapshotKeys(
      command,
      ['kind', 'revisionId', 'decisions', 'expectedBaseContent'],
      'revision.update_decisions command',
    );
    positiveRevisionId(command.revisionId, 'revision.update_decisions revisionId');
    revisionDecisions(command.decisions, 'revision.update_decisions decisions');
    revisionText(command.expectedBaseContent, 'revision.update_decisions expectedBaseContent');
    return command;
  }
  if (command.kind === 'revision.reject' || command.kind === 'revision.accept') {
    exactSnapshotKeys(
      command,
      ['kind', 'revisionId', 'expectedBaseContent'],
      `${command.kind} command`,
    );
    positiveRevisionId(command.revisionId, `${command.kind} revisionId`);
    revisionText(command.expectedBaseContent, `${command.kind} expectedBaseContent`);
    return command;
  }
  if (command.kind === 'revision.finalize') {
    exactSnapshotKeys(
      command,
      ['kind', 'revisionId', 'content', 'expectedBaseContent', 'expectedDecisions'],
      'revision.finalize command',
    );
    positiveRevisionId(command.revisionId, 'revision.finalize revisionId');
    revisionText(command.content, 'revision.finalize content');
    revisionText(command.expectedBaseContent, 'revision.finalize expectedBaseContent');
    revisionDecisions(command.expectedDecisions, 'revision.finalize expectedDecisions');
    return command;
  }
  return command;
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
  normalizeRevisionCommand(command);
  return Object.freeze({
    requestId: nonEmpty(input.requestId, 'requestId'),
    baseWitness: input.baseWitness === null ? null : witness(input.baseWitness),
    command,
  });
}

function orphanRequest(value, label) {
  const input = exactData(value, ['kind', 'requestId', 'uid'], label);
  if (input.kind !== 'chapter' && input.kind !== 'volume') {
    throw new TypeError(`${label}.kind must be chapter or volume`);
  }
  return Object.freeze({
    requestId: nonEmpty(input.requestId, `${label}.requestId`),
    kind: input.kind,
    uid: canonicalUuid(input.uid, `${label}.uid`),
  });
}

function draftConflictCopyRequest(value) {
  const input = exactData(value, ['conflictId', 'requestId'], 'draft conflict copy request');
  return Object.freeze({
    conflictId: canonicalUuid(input.conflictId, 'draft conflict copy conflictId'),
    requestId: nonEmpty(input.requestId, 'draft conflict copy requestId'),
  });
}

function draftConflictResolutionRequest(value) {
  const input = exactData(
    value,
    ['action', 'conflictId', 'decisionEpoch', 'requestId'],
    'draft conflict resolution request',
  );
  if (input.action !== 'accept_external' && input.action !== 'apply_saved_draft') {
    throw new TypeError('draft conflict resolution action is unsupported');
  }
  return Object.freeze({
    action: input.action,
    conflictId: canonicalUuid(input.conflictId, 'draft conflict resolution conflictId'),
    decisionEpoch: generation(input.decisionEpoch, 'draft conflict resolution decisionEpoch'),
    requestId: nonEmpty(input.requestId, 'draft conflict resolution requestId'),
  });
}

function captureFilesPort(value) {
  const baseMethods = ['close', 'ignoreInPlace', 'read', 'recover', 'revokeIgnore', 'write'];
  const conflictMethods = [
    'copyDraftConflictBackup',
    'listDraftConflicts',
    'resolveDraftConflict',
  ];
  const descriptors = value === null || typeof value !== 'object'
    ? Object.create(null)
    : Object.getOwnPropertyDescriptors(value);
  const installed = conflictMethods.filter((method) => descriptors[method] !== undefined);
  if (installed.length !== 0 && installed.length !== conflictMethods.length) {
    throw new TypeError('files draft conflict port must be installed atomically');
  }
  const methods = installed.length === conflictMethods.length
    ? [...baseMethods, ...conflictMethods]
    : baseMethods;
  exactData(value, methods, 'files');
  const captured = capturePort(value, methods, 'files');
  if (installed.length === conflictMethods.length) return captured;
  const unavailable = () => {
    throw runtimeError('RECOVERY_REQUIRED', 'Draft conflict recovery is unavailable');
  };
  return Object.freeze({
    ...captured,
    copyDraftConflictBackup: unavailable,
    listDraftConflicts: unavailable,
    resolveDraftConflict: unavailable,
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
  const files = captureFilesPort(input.files);
  const creation = capturePort(input.creation, ['create'], 'creation');
  const migration = capturePort(input.migration, ['migrate', 'recover'], 'migration');
  let closed = false;
  let closePromise = null;
  let activeOperations = 0;
  let drainPromise = Promise.resolve();
  let resolveDrain = null;

  function assertOpen() {
    if (closed) throw runtimeError('RECOVERY_REQUIRED', 'Manuscript runtime is closed');
  }

  function withActiveOperation(operation) {
    assertOpen();
    activeOperations += 1;
    if (activeOperations === 1) {
      drainPromise = new Promise((resolve) => { resolveDrain = resolve; });
    }
    return (async () => {
      try {
        return await operation();
      } finally {
        activeOperations -= 1;
        if (activeOperations === 0) {
          const resolve = resolveDrain;
          resolveDrain = null;
          resolve();
        }
      }
    })();
  }

  async function admit(projectSelector) {
    const admitted = await routeResolver.admit(projectSelector);
    if (admitted?.route === 'sqlite') return Object.freeze({ route: 'sqlite' });
    verifyActivatedSchema12Admission(admitted);
    return admitted;
  }


  async function resolveOrphan(method, projectSelector, requestValue) {
    assertOpen();
    const safeSelector = selector(projectSelector);
    const request = orphanRequest(requestValue, method);
    const admission = await admit(safeSelector);
    if (admission.route === 'sqlite') {
      throw runtimeError(
        'SQLITE_RUNTIME_ROUTE_UNSUPPORTED',
        'Orphan resolution is only available for files-authority projects',
      );
    }
    return files[method](admission, request);
  }

  async function admitFilesOnly(projectSelector, feature) {
    const safeSelector = selector(projectSelector);
    const admission = await admit(safeSelector);
    if (admission.route === 'sqlite') {
      throw runtimeError(
        'SQLITE_RUNTIME_ROUTE_UNSUPPORTED',
        `${feature} is only available for files-authority projects`,
      );
    }
    return Object.freeze({ admission, safeSelector });
  }

  return Object.freeze({
    createProject(value) {
      return withActiveOperation(async () => {
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
      });
    },
    migrateProject(value) {
      return withActiveOperation(() => {
      const request = exactData(value, ['projectSelector', 'requestId'], 'migrateProject request');
      return migration.migrate(Object.freeze({
        projectSelector: selector(request.projectSelector),
        requestId: nonEmpty(request.requestId, 'requestId'),
      }));
      });
    },
    ignoreInPlace(projectSelector, requestValue) {
      return withActiveOperation(() => (
        resolveOrphan('ignoreInPlace', projectSelector, requestValue)
      ));
    },
    listDraftConflicts(projectSelector) {
      return withActiveOperation(async () => {
        const { admission } = await admitFilesOnly(projectSelector, 'Draft conflict recovery');
        return files.listDraftConflicts(admission);
      });
    },
    copyDraftConflictBackup(projectSelector, requestValue) {
      return withActiveOperation(async () => {
        const request = draftConflictCopyRequest(requestValue);
        const { admission } = await admitFilesOnly(projectSelector, 'Draft conflict backup copy');
        return files.copyDraftConflictBackup(admission, request);
      });
    },
    resolveDraftConflict(projectSelector, requestValue) {
      return withActiveOperation(async () => {
        const request = draftConflictResolutionRequest(requestValue);
        const { admission } = await admitFilesOnly(projectSelector, 'Draft conflict resolution');
        return files.resolveDraftConflict(admission, request);
      });
    },
    read(projectSelector, requestValue) {
      return withActiveOperation(async () => {
      const safeSelector = selector(projectSelector);
      const request = readRequest(requestValue);
      const admission = await admit(safeSelector);
      if (admission.route === 'sqlite') return sqlite.read(safeSelector, request);
      const result = exactData(await files.read(admission, request), [
        'baseWitness',
        'value',
      ], 'files read result');
      return Object.freeze({
        value: result.value,
        baseWitness: witness(result.baseWitness, 'server baseWitness'),
      });
      });
    },
    write(projectSelector, requestValue) {
      return withActiveOperation(async () => {
      const safeSelector = selector(projectSelector);
      const request = writeRequest(requestValue);
      const admission = await admit(safeSelector);
      if (admission.route === 'sqlite') return sqlite.write(safeSelector, request);
      const expected = witness(request.baseWitness);
      return files.write(admission, Object.freeze({
        requestId: request.requestId,
        baseWitness: expected,
        command: request.command,
        witnessCommand: request.command,
      }));
      });
    },
    recover(projectSelector) {
      return withActiveOperation(async () => {
      const safeSelector = selector(projectSelector);
      const admission = await admit(safeSelector);
      return admission.route === 'sqlite'
        ? sqlite.recover(safeSelector)
        : files.recover(admission);
      });
    },
    revokeIgnore(projectSelector, requestValue) {
      return withActiveOperation(() => (
        resolveOrphan('revokeIgnore', projectSelector, requestValue)
      ));
    },
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      closePromise = (async () => {
        await drainPromise;
        try {
          await files.close();
        } finally {
          await sqlite.close();
        }
      })();
      return closePromise;
    },
  });
}

function installManuscriptRuntime(runtime) {
  if (installedRuntime !== null) {
    throw new TypeError('manuscript runtime is already installed');
  }
  const baseMethods = [
    'close',
    'createProject',
    'ignoreInPlace',
    'migrateProject',
    'read',
    'recover',
    'revokeIgnore',
    'write',
  ];
  const conflictMethods = [
    'copyDraftConflictBackup',
    'listDraftConflicts',
    'resolveDraftConflict',
  ];
  const descriptors = runtime === null || typeof runtime !== 'object'
    ? Object.create(null)
    : Object.getOwnPropertyDescriptors(runtime);
  const conflictCount = conflictMethods.filter((method) => descriptors[method] !== undefined).length;
  if (conflictCount !== 0 && conflictCount !== conflictMethods.length) {
    throw new TypeError('manuscript runtime draft conflict methods must be installed atomically');
  }
  installedRuntime = capturePort(
    runtime,
    conflictCount === conflictMethods.length ? [...baseMethods, ...conflictMethods] : baseMethods,
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
