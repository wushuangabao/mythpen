'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { inspectControlStoreEvidence } = require('../control-store');
const { inspectProjectDatabaseBytes } = require('../sqljs-atomic-store');
const { ProjectCreationJournal } = require('./project-creation-journal');
const {
  assertNativeDataRootChangeAllowed,
  inspectCloudOrReparseRoot,
} = require('./data-root-guard');
const { manuscriptError, ROUTES } = require('./contracts');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROJECT_DATABASE_SUFFIX = '.mythpen.db';
const ROUTE_SET = new Set(ROUTES);

let sqlModulePromise;

function loadSqlModule() {
  if (sqlModulePromise === undefined) {
    const initSqlJs = require('sql.js');
    let wasmBinary;
    try {
      wasmBinary = require('../wasm-binary').getWasmBinary();
    } catch {
      // Development installs can let sql.js resolve its own WASM file.
    }
    sqlModulePromise = initSqlJs(wasmBinary ? { wasmBinary } : undefined);
  }
  return sqlModulePromise;
}

function recovery(reason, cause) {
  return manuscriptError(
    'RECOVERY_REQUIRED',
    { reason },
    cause,
  );
}

function exactRequest(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError('data-root policy request must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const expected = ['migrate', 'sourceRoot', 'targetRoot'];
  if (
    keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string')
    || keys.map(String).sort().some((key, index) => key !== expected[index])
  ) throw new TypeError('data-root policy request has an inexact key set');
  const result = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('data-root policy request must contain own enumerable data');
    }
    result[key] = descriptor.value;
  }
  if (typeof result.migrate !== 'boolean') {
    throw new TypeError('data-root policy migrate intent must be boolean');
  }
  for (const key of ['sourceRoot', 'targetRoot']) {
    const candidate = result[key];
    if (
      typeof candidate !== 'string'
      || candidate.length === 0
      || !path.isAbsolute(candidate)
      || path.resolve(candidate) !== candidate
    ) throw new TypeError(`${key} must be an absolute normalized path`);
  }
  return Object.freeze(result);
}

function alternativeLocationError(diagnosis) {
  const error = new Error(`Data root requires an alternative location: ${diagnosis.reason}`);
  error.code = 'ALTERNATIVE_LOCATION_REQUIRED';
  error.status = 409;
  error.recoverable = true;
  error.details = Object.freeze({
    alternative: diagnosis.alternative,
    candidateRoot: diagnosis.candidateRoot,
    reason: diagnosis.reason,
  });
  return error;
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function fileIdentity(stats) {
  return Object.freeze({
    ctimeNs: String(stats.ctimeNs),
    dev: String(stats.dev),
    ino: String(stats.ino),
    mtimeNs: String(stats.mtimeNs),
    size: String(stats.size),
  });
}

function sameIdentity(left, right) {
  return left.ctimeNs === right.ctimeNs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.size === right.size;
}

function pathKind(filePath, label) {
  try {
    const stats = fs.lstatSync(filePath, { bigint: true });
    if (stats.isSymbolicLink()) throw recovery(`${label} is a reparse point`);
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    throw recovery(`${label} has an unsupported filesystem kind`);
  } catch (cause) {
    if (cause?.code === 'ENOENT') return 'missing';
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw recovery(`${label} cannot be inspected`, cause);
  }
}

function assertPlainDirectory(directory, label) {
  let stats;
  let realPath;
  try {
    stats = fs.lstatSync(directory, { bigint: true });
    realPath = fs.realpathSync.native(directory);
  } catch (cause) {
    throw recovery(`${label} cannot be inspected`, cause);
  }
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
  ) throw recovery(`${label} is not one canonical plain directory`);
  return Object.freeze({
    identity: fileIdentity(stats),
    realPath,
  });
}

function directoryEntries(directory, label) {
  const before = assertPlainDirectory(directory, label);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    throw recovery(`${label} cannot be enumerated`, cause);
  }
  const result = entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    const kind = pathKind(entryPath, `${label} entry`);
    if (entry.isSymbolicLink()) throw recovery(`${label} contains a reparse entry`);
    return Object.freeze({ kind, name: entry.name, path: entryPath });
  }).sort((left, right) => left.name.localeCompare(right.name));
  const after = assertPlainDirectory(directory, label);
  if (!sameIdentity(before.identity, after.identity) || !samePath(before.realPath, after.realPath)) {
    throw recovery(`${label} identity changed while enumerating`);
  }
  return Object.freeze(result);
}

function readStableFile(filePath, label) {
  let beforeStats;
  try {
    beforeStats = fs.lstatSync(filePath, { bigint: true });
  } catch (cause) {
    throw recovery(`${label} cannot be inspected`, cause);
  }
  if (
    !beforeStats.isFile()
    || beforeStats.isSymbolicLink()
    || beforeStats.nlink !== 1n
  ) throw recovery(`${label} is not one canonical single-link file`);
  const before = fileIdentity(beforeStats);
  let bytes;
  let afterStats;
  try {
    bytes = fs.readFileSync(filePath);
    afterStats = fs.lstatSync(filePath, { bigint: true });
  } catch (cause) {
    throw recovery(`${label} changed while reading`, cause);
  }
  if (!sameIdentity(before, fileIdentity(afterStats))) {
    throw recovery(`${label} changed while reading`);
  }
  return bytes;
}

function sqlRows(database, sql) {
  const statement = database.prepare(sql);
  try {
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function withReadOnlyDatabase(SQL, bytes, label, read) {
  let database;
  let primaryError;
  try {
    database = new SQL.Database(bytes);
    return read(database);
  } catch (cause) {
    primaryError = cause?.code === 'RECOVERY_REQUIRED'
      ? cause
      : recovery(`${label} is not readable`, cause);
    throw primaryError;
  } finally {
    try {
      database?.close();
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
    }
  }
}

function inspectProjectRoute(SQL, projectPath) {
  const bytes = readStableFile(projectPath, 'Project database');
  let inspection;
  try {
    inspection = inspectProjectDatabaseBytes(SQL, bytes);
  } catch (cause) {
    throw recovery('Project database integrity cannot be proven', cause);
  }
  if (!inspection.isProject || !Number.isSafeInteger(inspection.schema)) {
    throw recovery('Project database identity cannot be proven');
  }
  return withReadOnlyDatabase(SQL, bytes, 'Project database metadata', (database) => {
    const rows = sqlRows(
      database,
      "SELECT key, value FROM project_meta WHERE key IN ('schema_version', 'manuscript_route', 'durability_backend') ORDER BY key, value",
    ).map((row) => ({ key: String(row.key), value: String(row.value) }));
    const schemaRows = rows.filter((row) => row.key === 'schema_version');
    const routeRows = rows.filter((row) => row.key === 'manuscript_route');
    const backendRows = rows.filter((row) => row.key === 'durability_backend');
    if (
      schemaRows.length !== 1
      || schemaRows[0].value !== String(inspection.schema)
      || routeRows.length > 1
      || backendRows.length > 1
    ) throw recovery('Project database route metadata is inexact');
    const route = routeRows.length === 0 ? 'sqlite' : routeRows[0].value;
    if (!ROUTE_SET.has(route)) throw recovery('Project database route is invalid');
    if (inspection.schema >= 12 && route === 'sqlite') {
      throw recovery('Schema 12 project has no file-authority route');
    }
    const backend = backendRows[0]?.value ?? null;
    if (backend !== null && !['native-sqlite-v2', 'sqljs-v1'].includes(backend)) {
      throw recovery('Project durability backend is invalid');
    }
    return Object.freeze({
      native: inspection.schema >= 11 || backend === 'native-sqlite-v2',
      route,
    });
  });
}

function configRegisteredPaths(SQL, sourceRoot, projectsDirectory) {
  const configPath = path.join(sourceRoot, 'config.db');
  const kind = pathKind(configPath, 'Configuration database');
  if (kind === 'missing') return Object.freeze([]);
  if (kind !== 'file') throw recovery('Configuration database is not a file');
  const bytes = readStableFile(configPath, 'Configuration database');
  return withReadOnlyDatabase(SQL, bytes, 'Configuration database', (database) => {
    const tables = sqlRows(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_projects'",
    );
    if (tables.length !== 1) throw recovery('Configuration route registry is unavailable');
    return Object.freeze(sqlRows(
      database,
      'SELECT file_path FROM recent_projects ORDER BY file_path, id',
    ).map((row) => {
      const filePath = row.file_path;
      if (
        typeof filePath !== 'string'
        || !path.isAbsolute(filePath)
        || path.resolve(filePath) !== filePath
        || !samePath(path.dirname(filePath), projectsDirectory)
        || !filePath.toLowerCase().endsWith(PROJECT_DATABASE_SUFFIX)
      ) throw recovery('Configuration route registry contains an unsafe project path');
      return filePath;
    }));
  });
}

async function routeSnapshot(sourceRoot) {
  const sourceKind = pathKind(sourceRoot, 'Data root');
  if (sourceKind === 'missing') return Object.freeze({ nativePresent: false, routes: [] });
  if (sourceKind !== 'directory') throw recovery('Data root is not a directory');
  assertPlainDirectory(sourceRoot, 'Data root');
  const projectsDirectory = path.join(sourceRoot, 'projects');
  const projectsKind = pathKind(projectsDirectory, 'Projects directory');
  let entries = Object.freeze([]);
  if (projectsKind === 'directory') {
    entries = directoryEntries(projectsDirectory, 'Projects directory');
  } else if (projectsKind !== 'missing') {
    throw recovery('Projects directory is not a directory');
  }
  const projectFiles = entries.filter((entry) => (
    entry.kind === 'file' && entry.name.toLowerCase().endsWith(PROJECT_DATABASE_SUFFIX)
  ));
  const needsSql = projectFiles.length > 0
    || pathKind(path.join(sourceRoot, 'config.db'), 'Configuration database') !== 'missing';
  if (!needsSql) return Object.freeze({ nativePresent: false, routes: [] });
  const SQL = await loadSqlModule();
  const registered = configRegisteredPaths(SQL, sourceRoot, projectsDirectory);
  const paths = new Map(projectFiles.map((entry) => [
    process.platform === 'win32' ? entry.path.toLowerCase() : entry.path,
    entry.path,
  ]));
  for (const registeredPath of registered) {
    const key = process.platform === 'win32' ? registeredPath.toLowerCase() : registeredPath;
    paths.set(key, registeredPath);
  }
  const routes = [];
  let nativePresent = false;
  for (const projectPath of [...paths.values()].sort()) {
    const inspected = inspectProjectRoute(SQL, projectPath);
    routes.push(inspected.route);
    nativePresent ||= inspected.native;
  }
  return Object.freeze({ nativePresent, routes: Object.freeze(routes) });
}

function dispositionPort() {
  const deny = () => { throw recovery('Data-root policy may not classify journal disposition'); };
  return Object.freeze({ classify: deny, inspect: deny });
}

function controlStoreIdentity(directory) {
  const realPath = fs.realpathSync.native(directory);
  const canonical = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  return Object.freeze({ canonical, digest: createHash('sha256').update(canonical).digest('hex') });
}

function assertEmptySingleLinkFile(filePath, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath, { bigint: true });
  } catch (cause) {
    throw recovery(`${label} cannot be inspected`, cause);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n || stats.size !== 0n) {
    throw recovery(`${label} is not one empty single-link file`);
  }
}

function creationJournalSnapshot(sourceRoot) {
  const creationRoot = path.join(sourceRoot, 'control', 'project-creation');
  const kind = pathKind(creationRoot, 'Project creation control root');
  if (kind === 'missing') return Object.freeze([]);
  if (kind !== 'directory') throw recovery('Project creation control root is not a directory');
  const entries = directoryEntries(creationRoot, 'Project creation control root');
  const directories = entries.filter((entry) => entry.kind === 'directory');
  if (directories.some((entry) => !UUID_PATTERN.test(entry.name))) {
    throw recovery('Project creation control root has a non-canonical journal identity');
  }
  const expectedFiles = new Set();
  const result = directories.map((entry) => {
    const identity = controlStoreIdentity(entry.path);
    const activeName = `.controlstore-${identity.digest}.active.json`;
    const lockName = `.controlstore-${identity.digest}.lifecycle.lock`;
    expectedFiles.add(activeName);
    expectedFiles.add(lockName);
    assertEmptySingleLinkFile(path.join(creationRoot, lockName), 'Creation ControlStore lock');
    const evidence = inspectControlStoreEvidence(entry.path);
    if (evidence.projection.incarnationId === null) {
      throw recovery('Project creation ControlStore has no incarnation');
    }
    const events = Object.freeze(evidence.events);
    const readOnlyStore = Object.freeze({
      directory: entry.path,
      incarnationId: evidence.projection.incarnationId,
      compareAndAppend() { throw recovery('Data-root policy cannot append creation events'); },
      read() { return events; },
      tail() { return events.at(-1) ?? null; },
    });
    const journal = new ProjectCreationJournal({
      childDisposition: dispositionPort(),
      clock: Date.now,
      controlStore: readOnlyStore,
      creationId: entry.name,
      dataRoot: sourceRoot,
      databaseDisposition: dispositionPort(),
    });
    return Object.freeze({ state: journal.read()?.state ?? 'none' });
  });
  const files = entries.filter((entry) => entry.kind === 'file');
  if (
    entries.some((entry) => !['directory', 'file'].includes(entry.kind))
    || files.length !== expectedFiles.size
    || files.some((entry) => !expectedFiles.has(entry.name))
  ) throw recovery('Project creation control root topology is inexact');
  return Object.freeze(result);
}

async function collectPolicyFacts(sourceRoot) {
  const routeFacts = await routeSnapshot(sourceRoot);
  return Object.freeze({
    creationJournals: creationJournalSnapshot(sourceRoot),
    nativePresent: routeFacts.nativePresent,
    routes: routeFacts.routes,
  });
}

function samePolicyFacts(left, right) {
  return left.nativePresent === right.nativePresent
    && left.routes.length === right.routes.length
    && left.routes.every((route, index) => route === right.routes[index])
    && left.creationJournals.length === right.creationJournals.length
    && left.creationJournals.every((journal, index) => (
      journal.state === right.creationJournals[index].state
    ));
}

function createProductionDataRootPolicyAuthority() {
  if (arguments.length !== 0) {
    throw new TypeError('createProductionDataRootPolicyAuthority accepts no arguments');
  }
  return Object.freeze({
    async assertChangeAllowed(requestValue) {
      const request = exactRequest(requestValue);
      const targetDiagnosis = inspectCloudOrReparseRoot(request.targetRoot);
      if (targetDiagnosis.allowed !== true) throw alternativeLocationError(targetDiagnosis);
      const sourceDiagnosis = inspectCloudOrReparseRoot(request.sourceRoot);
      if (sourceDiagnosis.allowed !== true) throw alternativeLocationError(sourceDiagnosis);
      const before = await collectPolicyFacts(request.sourceRoot);
      const after = await collectPolicyFacts(request.sourceRoot);
      if (!samePolicyFacts(before, after)) {
        throw recovery('Data-root policy facts changed while being inspected');
      }
      const allowed = assertNativeDataRootChangeAllowed(Object.freeze({
        creationJournals: after.creationJournals,
        routes: after.routes,
      }));
      if (after.nativePresent) {
        throw manuscriptError('NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED', {
          reason: 'NATIVE_SQLITE_PROJECT_PRESENT',
        });
      }
      return allowed;
    },
  });
}

module.exports = { createProductionDataRootPolicyAuthority };
