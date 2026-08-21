// ─── SQL.js-based database layer (replaces better-sqlite3) ───
// Uses sql.js (pure JS/WASM SQLite) instead of better-sqlite3 (native addon)
// so that bun build --compile can produce a standalone binary without native .node files.

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash, randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');
const { resolveStoragePaths } = require('./storage-paths');
const { repairRecentProjectPaths } = require('./recent-project-paths');
const { compareTimelineEvents } = require('./timeline-order');
const { inspectControlStoreEvidence, openControlStore } = require('./control-store');
const {
  assertPublicationJournalRetirable,
  canonicalDatabasePath,
  createAtomicStore,
  inspectProjectDatabaseBytes,
} = require('./sqljs-atomic-store');
const { fsyncDirectory, fsyncFile } = require('./platform/durability');
const { acquireConfigLifecycleLease } = require('./config-lifecycle-lease');
const { createProjectWriteCoordinator } = require('./project-write-coordinator');
const {
  inspectRegisteredProject: inspectRegisteredProjectWithDependencies,
  recoverRegisteredProject: recoverRegisteredProjectWithDependencies,
} = require('./recovery-diagnostics');
const { isOfflineSeedBootstrapActive } = require('./offline-seed-capability');
const { classifyChapterBodyMutation } = require('./manuscript-sql-guard');
const { createNativeDbAdapter } = require('./native/native-db-adapter');
const {
  inspectSchema11Contract,
  inspectSchema12Contract,
} = require('./native/durability-schema');
const {
  isTestManuscriptBootstrapActive,
  registerDatabaseInternals,
  registerProjectWriteDiagnostics,
} = require('./database-internals');

let SQL;         // set by initDatabase()
let configDb;    // wrapped config database
let configLifecycleLease;
let storagePaths = null;
let storageFailure = null;
let databaseInitializationStarted = false;
let nativeActivationController = null;
const controlStoresByAtomicStore = new WeakMap();
const storesByWrapper = new WeakMap();
const projectTransactionOwners = new WeakMap();
const manuscriptClaims = new WeakMap();
const manuscriptSqlAuthorizations = new WeakMap();
const manuscriptPersistenceErrors = new WeakSet();
const projectMigrationBodyWrites = new WeakSet();

function storageUnavailableError() {
  const error = new Error('Storage is unavailable after a failed reconfiguration; retry configureStorage() or restart');
  error.code = 'STORAGE_UNAVAILABLE';
  error.cause = storageFailure?.primaryError;
  return error;
}

function assertStorageAvailable() {
  if (storageFailure) throw storageUnavailableError();
}

function discardConnections(connections) {
  const errors = [];
  const uncertainConnections = [];
  for (const connection of connections) {
    if (!connection) continue;
    try {
      connection._discard();
    } catch (error) {
      errors.push(error);
      uncertainConnections.push(connection);
    }
  }
  return { errors, uncertainConnections };
}

function enterStorageFailure(primaryError, uncertainConnections = []) {
  projectConnections.clear();
  configDb = null;
  storageFailure = { primaryError, uncertainConnections: [...new Set(uncertainConnections)] };
}

function releaseConfigLifecycleLease() {
  if (!configLifecycleLease) return;
  const lease = configLifecycleLease;
  lease.release();
  configLifecycleLease = null;
}

function retryFailedStorageCleanup() {
  if (!storageFailure) return;
  if (configLifecycleLease?.state === 'disposition_unknown') {
    throw storageUnavailableError();
  }
  const { errors, uncertainConnections } = discardConnections(storageFailure.uncertainConnections);
  if (errors.length > 0) {
    const priorErrors = storageFailure.primaryError.storageRetryCleanupErrors || [];
    attachSecondaryError(
      storageFailure.primaryError,
      'storageRetryCleanupErrors',
      [...priorErrors, ...errors],
    );
    storageFailure.uncertainConnections = uncertainConnections;
    throw storageUnavailableError();
  }
  try {
    releaseConfigLifecycleLease();
  } catch (error) {
    attachSecondaryError(storageFailure.primaryError, 'configLeaseReleaseError', error);
    throw storageUnavailableError();
  }
  storageFailure = null;
}

function assertDataRootMoveSupported(candidateStoragePaths) {
  if (
    storagePaths === null
    || canonicalDbPath(storagePaths.dataDir) === canonicalDbPath(candidateStoragePaths.dataDir)
  ) return;
  const unsupported = () => {
    const error = new Error('Data-root migration is unsupported while files authority or creation is active');
    error.code = 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED';
    throw error;
  };
  const manuscriptControlRoot = path.join(storagePaths.dataDir, 'control', 'manuscripts');
  const hasManuscriptRoutes = fs.existsSync(manuscriptControlRoot)
    && fs.readdirSync(manuscriptControlRoot, { withFileTypes: true })
      .some((entry) => entry.isDirectory());
  if (hasManuscriptRoutes && fs.existsSync(storagePaths.projectsDir)) {
    for (const entry of fs.readdirSync(storagePaths.projectsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(PROJECT_DATABASE_SUFFIX)) continue;
      if (!SQL) unsupported();
      const bytes = fs.readFileSync(path.join(storagePaths.projectsDir, entry.name));
      const inspection = inspectProjectDatabaseBytes(SQL, bytes);
      if (inspection.schema === 12) unsupported();
      const database = new SQL.Database(bytes);
      try {
        const route = sqlJsQueryFacade(database).query(
          "SELECT value FROM project_meta WHERE key = 'manuscript_route'",
        ).get()?.value;
        if (route === 'files' || route === 'migrating' || route === 'retired') unsupported();
      } finally {
        database.close();
      }
    }
  }
  const creationRoot = path.join(storagePaths.dataDir, 'control', 'project-creation');
  if (!fs.existsSync(creationRoot)) return;
  if (fs.readdirSync(creationRoot, { withFileTypes: true }).length > 0) unsupported();
}

function configureStorage(overrides = {}) {
  retryFailedStorageCleanup();
  const candidateStoragePaths = resolveStoragePaths(
    overrides.dataDir
      ? { env: { ...process.env, MYTHPEN_DATA_DIR: overrides.dataDir } }
      : {},
  );
  assertDataRootMoveSupported(candidateStoragePaths);
  fs.mkdirSync(candidateStoragePaths.dataDir, { recursive: true });
  fs.mkdirSync(candidateStoragePaths.projectsDir, { recursive: true });

  const previousConfigDb = configDb;
  const previousConfigLifecycleLease = configLifecycleLease;
  const previousProjectConnections = [...projectConnections.entries()];

  previousConfigDb?.flush();
  for (const [, projectDb] of previousProjectConnections) projectDb.flush();

  const closedConnections = new Set();
  try {
    for (const [, projectDb] of previousProjectConnections) {
      projectDb.close();
      closedConnections.add(projectDb);
    }
    if (previousConfigDb) {
      previousConfigDb.close();
      closedConnections.add(previousConfigDb);
    }
  } catch (error) {
    const previousConnections = [
      previousConfigDb,
      ...previousProjectConnections.map(([, projectDb]) => projectDb),
    ].filter((connection) => connection && !closedConnections.has(connection));
    const cleanup = discardConnections(previousConnections);
    if (cleanup.errors.length > 0) attachSecondaryError(error, 'storageCleanupErrors', cleanup.errors);
    projectConnections.clear();
    configDb = null;

    if (cleanup.uncertainConnections.length > 0) {
      enterStorageFailure(error, cleanup.uncertainConnections);
      throw error;
    }

    let recoveredConfigDb = null;
    const recoveredProjects = [];
    try {
      if (previousConfigDb) recoveredConfigDb = _openConfig(previousConfigLifecycleLease);
      for (const [filePath] of previousProjectConnections) {
        const projectDb = projectWriteCoordinator.withProjectWriteSync(
          filePath,
          () => _createProjectConnection(filePath),
        );
        recoveredProjects.push([filePath, projectDb]);
      }
    } catch (recoveryError) {
      attachSecondaryError(error, 'storageRecoveryError', recoveryError);
      const recoveryCleanup = discardConnections([
        recoveredConfigDb,
        ...recoveredProjects.map(([, projectDb]) => projectDb),
      ]);
      if (recoveryCleanup.errors.length > 0) {
        attachSecondaryError(error, 'storageRecoveryCleanupErrors', recoveryCleanup.errors);
      }
      const uncertainConnections = [...recoveryCleanup.uncertainConnections];
      if (recoveryError.storageUncertainConnection) {
        uncertainConnections.push(recoveryError.storageUncertainConnection);
      }
      enterStorageFailure(error, uncertainConnections);
      throw error;
    }

    configDb = recoveredConfigDb;
    for (const [filePath, projectDb] of recoveredProjects) projectConnections.set(filePath, projectDb);
    throw error;
  }

  projectConnections.clear();
  configDb = null;
  try {
    releaseConfigLifecycleLease();
  } catch (error) {
    enterStorageFailure(error);
    throw error;
  }
  storagePaths = candidateStoragePaths;
  projectOpenStates.clear();
  projectOpenStatesByLogicalPath.clear();
  return storagePaths;
}

function installNativeActivationController(controller) {
  if (databaseInitializationStarted || configDb || nativeActivationController) {
    const error = new Error('Native activation controller must be installed exactly once before init');
    error.code = 'NATIVE_ACTIVATION_DISABLED';
    throw error;
  }
  const {
    assertNativeActivationControllerForBuild,
  } = require('./native/native-activation-controller');
  nativeActivationController = assertNativeActivationControllerForBuild(controller);
  return true;
}

function nativeActivationAdmissionMode() {
  if (!nativeActivationController) return null;
  const buildMode = require('./build-info').getBuildInfo().nativeActivationMode;
  if (buildMode !== 'production' && buildMode !== 'fixture_only') return null;
  try {
    const {
      assertNativeActivationControllerForBuild,
    } = require('./native/native-activation-controller');
    return assertNativeActivationControllerForBuild(nativeActivationController) === nativeActivationController
      ? buildMode
      : null;
  } catch {
    return null;
  }
}

function getStoragePaths() {
  assertStorageAvailable();
  return storagePaths || configureStorage();
}

// ═══════════════════════════════════════════════════════════════
// Schema versioning — bump these when adding migrations
// ═══════════════════════════════════════════════════════════════

const CONFIG_SCHEMA_VERSION = 2;
// PROJECT_SCHEMA_VERSION is the highest project schema this build can admit.
// SQL.js remains the schema-10 authority; schema 11 is installed only by the
// native activation transaction and is never a sql.js migration target.
const PROJECT_SCHEMA_VERSION = 11;
const SQLJS_PROJECT_SCHEMA_VERSION = 10;
const NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION = 10;
const STARTUP_RECOVERY_MAX_PROJECTS = 10_000;

// ═══════════════════════════════════════════════════════════════
// sql.js wrapper — provides a better-sqlite3-compatible API
// ═══════════════════════════════════════════════════════════════

function attachSecondaryError(primaryError, property, secondaryError) {
  if ((typeof primaryError !== 'object' && typeof primaryError !== 'function') || primaryError === null) return;
  try {
    Object.defineProperty(primaryError, property, {
      value: secondaryError,
      configurable: true,
    });
  } catch {
    // A frozen/custom thrown value still keeps its original identity below.
  }
}

function canonicalDbPath(filePath) {
  return canonicalDatabasePath(filePath);
}

const RETIRED_CONTROL_DIRECTORY_PATTERN = /^([0-9a-f]{64})\.retired-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function pathExistsStrict(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function prepareControlStoreForNewIncarnation(filePath, controlDir, dbKey) {
  if (pathExistsStrict(filePath)) return;
  const controlParent = path.dirname(controlDir);
  if (!pathExistsStrict(controlDir)) {
    if (!pathExistsStrict(controlParent)) return;
    const hasRetiredEvidence = fs.readdirSync(controlParent).some((name) => {
      const match = RETIRED_CONTROL_DIRECTORY_PATTERN.exec(name);
      return match?.[1] === dbKey;
    });
    // This also completes a previous attempt that renamed successfully but
    // crashed or failed before the parent-directory fsync became observable.
    if (hasRetiredEvidence) fsyncDirectory(controlParent);
    return;
  }

  const oldControlStore = openControlStore(controlDir);
  const retiredDir = path.join(controlParent, `${dbKey}.retired-${randomUUID()}`);
  oldControlStore.retireAndActivate(retiredDir, (events) => {
    // The lifecycle lease is held here. Recheck the creation predicate inside
    // that lease so an existing database is never displaced by retirement.
    if (pathExistsStrict(filePath)) {
      const error = new Error(`Cannot start a new database incarnation because ${filePath} now exists`);
      error.code = 'NEW_INCARNATION_CONFLICT';
      throw error;
    }
    assertPublicationJournalRetirable({
      filePath,
      controlDirectory: controlDir,
      events,
    });
  });
}

function _createAtomicStore(filePath, {
  assertWriterLease = () => {},
  explicitCreate = false,
} = {}) {
  const dbKey = createHash('sha256').update(canonicalDbPath(filePath)).digest('hex');
  const controlDir = path.join(getStoragePaths().dataDir, 'control', 'sqlite', dbKey);
  if (explicitCreate && !pathExistsStrict(filePath)) {
    assertWriterLease();
    prepareControlStoreForNewIncarnation(filePath, controlDir, dbKey);
  }
  assertWriterLease();
  const controlStore = openControlStore(controlDir);
  const store = createAtomicStore({
    assertWriterLease,
    filePath,
    controlStore,
    sqlModule: SQL,
  });
  controlStoresByAtomicStore.set(store, controlStore);
  try {
    store.recover();
  } catch (error) {
    try {
      store.close();
    } catch (cleanupError) {
      attachSecondaryError(error, 'storageOpenCleanupError', cleanupError);
      attachSecondaryError(error, 'storageUncertainConnection', {
        _discard() {
          store.close();
        },
      });
    }
    throw error;
  }
  return store;
}

// ─── Named-param helper ───
// sql.js 1.13+ has a bug where binding named params via object (e.g. {id:1})
// doesn't work — values come through as NULL.
// We work around it by converting @param / :param / $param → ? at the JS level.
const NAMED_PARAM_RE = /[$@:](\w+)/g;

function isSingleReadOnlyStatement(sql) {
  if (typeof sql !== 'string') return false;
  let normalized = sql.trim();
  while (normalized.length > 0) {
    const lineComment = normalized.match(/^--[^\r\n]*(?:\r?\n|$)/);
    if (lineComment) {
      normalized = normalized.slice(lineComment[0].length).trimStart();
      continue;
    }
    const blockComment = normalized.match(/^\/\*[\s\S]*?\*\//);
    if (blockComment) {
      normalized = normalized.slice(blockComment[0].length).trimStart();
      continue;
    }
    break;
  }
  if (!/^(?:SELECT|EXPLAIN)\b/i.test(normalized)) return false;
  return !/;\s*\S/.test(normalized);
}

function isThenable(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function transactionBoundaryError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

const SQL_TRANSACTION_CONTROL = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);

function containsTransactionControlStatement(sql) {
  if (typeof sql !== 'string') return false;
  let index = 0;
  let atStatementStart = true;
  let statementPrefix = [];
  let inTriggerDefinition = false;
  let triggerBodyStarted = false;
  let atTriggerStatementStart = false;
  let triggerClosingEnd = false;

  function resetStatement() {
    atStatementStart = true;
    statementPrefix = [];
    inTriggerDefinition = false;
    triggerBodyStarted = false;
    atTriggerStatementStart = false;
    triggerClosingEnd = false;
  }

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && !/[\r\n]/.test(sql[index])) index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === ';') {
      if (inTriggerDefinition && triggerBodyStarted && !triggerClosingEnd) {
        atTriggerStatementStart = true;
        index += 1;
        continue;
      }
      resetStatement();
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (closing !== ']' && sql[index + 1] === closing) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      atStatementStart = false;
      statementPrefix = null;
      if (inTriggerDefinition && triggerBodyStarted && atTriggerStatementStart) {
        atTriggerStatementStart = false;
      }
      continue;
    }
    const word = sql.slice(index).match(/^[A-Za-z_]+/)?.[0];
    if (word) {
      const upperWord = word.toUpperCase();
      if (atStatementStart) {
        if (SQL_TRANSACTION_CONTROL.has(upperWord)) return true;
        atStatementStart = false;
        statementPrefix = [upperWord];
      } else if (statementPrefix) {
        statementPrefix.push(upperWord);
        if (
          statementPrefix[0] !== 'CREATE'
          || (
            statementPrefix.length === 2
            && !['TEMP', 'TEMPORARY', 'TRIGGER'].includes(statementPrefix[1])
          )
          || (
            statementPrefix.length === 3
            && !['TEMP', 'TEMPORARY'].includes(statementPrefix[1])
          )
        ) {
          statementPrefix = null;
        } else if (
          statementPrefix[1] === 'TRIGGER'
          || statementPrefix[2] === 'TRIGGER'
        ) {
          inTriggerDefinition = true;
          statementPrefix = null;
        }
      }

      if (inTriggerDefinition) {
        if (!triggerBodyStarted && upperWord === 'BEGIN') {
          triggerBodyStarted = true;
          atTriggerStatementStart = true;
        } else if (triggerBodyStarted && atTriggerStatementStart) {
          if (upperWord === 'END') triggerClosingEnd = true;
          else atTriggerStatementStart = false;
        }
      }
      index += word.length;
      continue;
    }
    if (atStatementStart) {
      atStatementStart = false;
      statementPrefix = null;
    }
    index += 1;
  }
  return false;
}

function assertNoTransactionControl(sql) {
  if (!containsTransactionControlStatement(sql)) return;
  throw transactionBoundaryError(
    'SQL_TRANSACTION_CONTROL_FORBIDDEN',
    'Raw SQL transaction-control statements are forbidden; use db.transaction()',
  );
}

function _normalizeParams(params) {
  if (params.length === 0) return null;
  // Single plain object = named params (e.g. {id: 1, name: 'test'})
  if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
    return { named: true, values: params[0] };
  }
  return { named: false, values: params };
}

function _buildSql(sqlText, bindMeta) {
  if (!bindMeta) return { sql: sqlText, args: null };
  if (!bindMeta.named) {
    // Positional params — convert undefined → null for sql.js compatibility
    return { sql: sqlText, args: bindMeta.values.map(v => v === undefined ? null : v) };
  }
  // Named params — convert to positional ? and collect values in SQL order
  const args = [];
  const converted = sqlText.replace(NAMED_PARAM_RE, (_, name) => {
    if (bindMeta.values[name] !== undefined) {
      args.push(bindMeta.values[name]);
      return '?';
    }
    // Keep unknown named params as-is (unbound → SQLite treats as NULL)
    return '@' + name;
  });
  return { sql: converted, args };
}

function manuscriptServiceRequired(message = 'Chapter body writes must use ManuscriptService') {
  const error = new Error(message);
  error.code = 'MANUSCRIPT_SERVICE_REQUIRED';
  return error;
}

function positionalValueForInsertColumn(classification, args, columnName) {
  if (!classification.columnNames || !classification.values || !Array.isArray(args)) return undefined;
  const columnIndex = classification.columnNames.indexOf(columnName);
  if (columnIndex < 0 || classification.values[columnIndex]?.trim() !== '?') return undefined;
  let positionalIndex = 0;
  for (let index = 0; index < columnIndex; index += 1) {
    positionalIndex += (classification.values[index].match(/\?/g) || []).length;
  }
  return args[positionalIndex];
}

const exactManuscriptCreateColumns = Object.freeze([
  'volume_id',
  'num',
  'title',
  'outline',
  'content',
  'word_count',
  'status',
  'cognitive_frame',
  'emotional_anchor',
  'world_texture',
  'concrete_mystery',
  'interpersonal_tension',
  'created_at',
  'updated_at',
]);
const exactManuscriptCreateSql = new RegExp(
  `^\\s*insert\\s+into\\s+chapters\\s*\\(\\s*`
    + exactManuscriptCreateColumns.join('\\s*,\\s*')
    + `\\s*\\)\\s*values\\s*\\(\\s*`
    + [
      '\\?', '\\?', '\\?', '\\?', '\\?', '\\?', "'pending'",
      '\\?', '\\?', '\\?', '\\?', '\\?',
      "datetime\\s*\\(\\s*'now'\\s*\\)",
      "datetime\\s*\\(\\s*'now'\\s*\\)",
    ].join('\\s*,\\s*')
    + '\\s*\\)\\s*;?\\s*$',
  'i',
);

function isExactManuscriptCreateStatement(classification, args) {
  if (
    classification.kind !== 'insert'
    || classification.command !== 'insert'
    || classification.target !== 'chapters'
    || classification.statementPrefix.trim() !== ''
    || !exactManuscriptCreateSql.test(classification.sql)
    || !Array.isArray(classification.columnNames)
    || classification.columnNames.length !== exactManuscriptCreateColumns.length
    || !classification.columnNames.every(
      (column, index) => column === exactManuscriptCreateColumns[index],
    )
    || !Array.isArray(classification.values)
    || classification.values.length !== exactManuscriptCreateColumns.length
    || !Array.isArray(args)
    || args.length !== 11
    || !/^;?$/.test(classification.valuesTail.trim())
  ) {
    return false;
  }
  const placeholderIndexes = new Set([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11]);
  for (let index = 0; index < classification.values.length; index += 1) {
    const value = classification.values[index].trim();
    if (placeholderIndexes.has(index)) {
      if (value !== '?') return false;
    } else if (index === 6) {
      if (value !== '') return false;
    } else if (!/^datetime\s*\(\s*\)$/.test(value)) {
      return false;
    }
  }
  return true;
}

function validateManuscriptSqlScope(scope, classification, args) {
  if (scope.operation === 'create') {
    return isExactManuscriptCreateStatement(classification, args)
      && positionalValueForInsertColumn(classification, args, 'volume_id') === scope.volumeId
      && positionalValueForInsertColumn(classification, args, 'num') === scope.chapterNumber;
  }
  if (classification.kind !== 'update' || !Array.isArray(args)) return false;
  const where = /\bwhere\b([\s\S]*)$/.exec(classification.masked);
  if (!where) return false;
  const exactTargetPredicate = new RegExp(
    `^\\s*(?:[a-z_$][\\w$]*\\s*\\.\\s*)?id\\s*=\\s*\\?`
      + `(?:\\s+and\\s+(?:data_version\\s*=\\s*\\?`
      + `|coalesce\\s*\\(\\s*content\\s*,\\s*\\)\\s*=\\s*\\?))*\\s*;?\\s*$`,
  );
  if (!exactTargetPredicate.test(where[1])) return false;
  const placeholderIndex = (
    classification.masked.slice(0, where.index).match(/\?/g) || []
  ).length;
  return args[placeholderIndex] === scope.chapterId;
}

function validateManuscriptSqlAuthorization(authorization, classification, args) {
  const active = projectTransactionOwners.get(authorization.active.connection);
  const store = storesByWrapper.get(authorization.active.connection);
  if (
    active !== authorization.active
    || !store
    || store.connectionEpoch !== authorization.connectionEpoch
  ) {
    return false;
  }
  return validateManuscriptSqlScope(authorization.scope, classification, args);
}

function assertManuscriptBodySqlAllowed(wrapper, sql, args) {
  const classification = classifyChapterBodyMutation(sql);
  const pendingAuthorization = manuscriptSqlAuthorizations.get(wrapper);
  if (!classification) {
    if (pendingAuthorization) {
      manuscriptSqlAuthorizations.delete(wrapper);
      throw manuscriptServiceRequired();
    }
    return;
  }
  if (isOfflineSeedBootstrapActive() || isTestManuscriptBootstrapActive()) return;
  const exactLegacyMigrationTokens = [
    'UPDATE', 'chapters', 'SET', 'content', '=', "''", 'WHERE', 'content', 'IS', 'NULL',
  ];
  const actualTokens = sql.trim().split(/\s+/);
  if (
    projectMigrationBodyWrites.has(wrapper)
    && actualTokens.length === exactLegacyMigrationTokens.length
    && actualTokens.every((token, index) => token === exactLegacyMigrationTokens[index])
  ) {
    return;
  }

  const authorization = pendingAuthorization;
  manuscriptSqlAuthorizations.delete(wrapper);
  if (!authorization || !validateManuscriptSqlAuthorization(authorization, classification, args)) {
    throw manuscriptServiceRequired();
  }
}

/**
 * Wrap a raw sql.js Database instance so it quacks like better-sqlite3.
 * Supports: .pragma(), .prepare(sql).{all,get,run}(), .exec(), .run(), .transaction(), .flush(), .close()
 *
 * IMPORTANT: Each .run()/.all()/.get() creates its own fresh prepared statement
 * because sql.js's db.export() (called by AtomicStore.publish) invalidates ALL existing statements.
 * The statement is freed before publishing so export() never hits a stale handle.
 */
const DB_FLUSH_DELAY = 250; // ms — batch writes up to this interval

function _wrapDb(store, filePath, { writeCoordinator = null } = {}) {
  let dirty = false;
  let flushTimer = null;
  let flushFailure = null;
  let mutationSavepointSequence = 0;
  let transactionDepth = 0;

  function assertWrapperAvailable() {
    if (flushFailure) throw flushFailure;
  }

  function captureFlushFailure(error) {
    if (!flushFailure) flushFailure = error;
    try {
      store.fence();
    } catch (fenceError) {
      attachSecondaryError(flushFailure, 'storageFenceError', fenceError);
    }
    return flushFailure;
  }

  function _flushSync(expectedEpoch = null, captureAsyncFailure = false) {
    assertWrapperAvailable();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty) return;
    try {
      if (expectedEpoch !== null) store.assertEpoch(expectedEpoch);
      store.publish(store.currentConnection());
      dirty = false;
    } catch (error) {
      if (captureAsyncFailure) throw captureFlushFailure(error);
      throw error;
    }
  }

  function _scheduleFlush() {
    assertWrapperAvailable();
    dirty = true;
    if (!flushTimer) {
      const scheduledEpoch = store.connectionEpoch;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        try {
          _flushSync(scheduledEpoch, true);
        } catch {
          // The first persistence error is retained on the wrapper. Timer
          // callbacks never throw outside the request that scheduled them.
        }
      }, DB_FLUSH_DELAY);
    }
  }

  function runMutationAction(action, { useSavepoint = true } = {}) {
    assertWrapperAvailable();
    if (!useSavepoint) return action();
    const db = store.currentConnection();
    const dirtyBefore = dirty;
    const savepointName = `__mythpen_mutation_${++mutationSavepointSequence}`;
    db.run(`SAVEPOINT ${savepointName}`);
    try {
      const result = action();
      db.run(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      let rollbackSucceeded = false;
      let cleanupFailed = false;
      try {
        db.run(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        rollbackSucceeded = true;
      } catch (rollbackError) {
        cleanupFailed = true;
        attachSecondaryError(error, 'mutationRollbackError', rollbackError);
      }
      if (rollbackSucceeded) {
        try {
          db.run(`RELEASE SAVEPOINT ${savepointName}`);
        } catch (releaseError) {
          cleanupFailed = true;
          attachSecondaryError(error, 'mutationSavepointReleaseError', releaseError);
        }
      }
      dirty = dirtyBefore;
      if (cleanupFailed) captureFlushFailure(error);
      throw error;
    }
  }

  function runMutation(action, { flushImmediately = false, useSavepoint = true } = {}) {
    assertWrapperAvailable();
    if (!writeCoordinator) {
      const result = runMutationAction(() => action(null), { useSavepoint });
      if (flushImmediately) {
        dirty = true;
        _flushSync();
      } else {
        _scheduleFlush();
      }
      return result;
    }

    return writeCoordinator.withProjectWriteSync(filePath, (writeContext) => {
      assertWrapperAvailable();
      const result = runMutationAction(() => action(writeContext), { useSavepoint });
      dirty = true;
      if (!writeContext.reentrant) _flushSync();
      return result;
    });
  }

  function executePrepared(sql, params, { firstOnly = false } = {}) {
    assertWrapperAvailable();
    const action = () => {
      assertWrapperAvailable();
      const db = store.currentConnection();
      const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
      assertManuscriptBodySqlAllowed(wrapper, sql2, args);
      const statement = db.prepare(sql2);
      try {
        if (args) statement.bind(args);
        if (firstOnly) return statement.step() ? statement.getAsObject() : null;
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally {
        statement.free();
      }
    };
    return isSingleReadOnlyStatement(sql) ? action() : runMutation(action);
  }

  const wrapper = {
    get _failure() {
      return flushFailure;
    },
    _path: filePath,

    pragma(sql) {
      assertWrapperAvailable();
      assertNoTransactionControl(`PRAGMA ${sql}`);
      return runMutation(() => {
        assertWrapperAvailable();
        const db = store.currentConnection();
        return db.run('PRAGMA ' + sql);
      });
    },

    prepare(sql) {
      assertWrapperAvailable();
      assertNoTransactionControl(sql);
      return {
        all(...params) {
          return executePrepared(sql, params);
        },
        get(...params) {
          return executePrepared(sql, params, { firstOnly: true });
        },
        run(...params) {
          return runMutation(() => {
            assertWrapperAvailable();
            const db = store.currentConnection();
            const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
            assertManuscriptBodySqlAllowed(wrapper, sql2, args);
            const statement = db.prepare(sql2);
            try {
              if (args) statement.bind(args);
              statement.step();
              return { changes: db.getRowsModified() };
            } finally {
              statement.free();
            }
          });
        },
      };
    },

    exec(sql) {
      assertWrapperAvailable();
      assertNoTransactionControl(sql);
      if (isSingleReadOnlyStatement(sql)) {
        assertWrapperAvailable();
        return store.currentConnection().exec(sql);
      }
      return runMutation(() => {
        assertWrapperAvailable();
        const db = store.currentConnection();
        assertManuscriptBodySqlAllowed(wrapper, sql, null);
        return db.exec(sql);
      });
    },

    run(sql, params) {
      assertWrapperAvailable();
      assertNoTransactionControl(sql);
      return runMutation(() => {
        assertWrapperAvailable();
        const db = store.currentConnection();
        assertManuscriptBodySqlAllowed(wrapper, sql, Array.isArray(params) ? params : []);
        return db.run(sql, params || []);
      });
    },

    transaction(fn) {
      assertWrapperAvailable();
      return (...args) => {
        assertWrapperAvailable();
        if (transactionDepth > 0) {
          throw transactionBoundaryError(
            'NESTED_TRANSACTION',
            'Nested transactions are not supported by this database wrapper',
          );
        }
        const dirtyBefore = dirty;
        let transactionCommitted = false;
        try {
          return runMutation((writeContext) => {
            assertWrapperAvailable();
            const db = store.currentConnection();
            db.run('BEGIN');
            transactionDepth += 1;
            const transactionOwner = writeContext
              ? Object.freeze({
                connection: wrapper,
                connectionEpoch: store.connectionEpoch,
                coordinatorOwnershipToken: writeContext.ownershipToken,
                filePath,
                writeContext,
              })
              : null;
            if (transactionOwner) projectTransactionOwners.set(wrapper, transactionOwner);
            let result;
            try {
              result = fn(...args);
              assertWrapperAvailable();
              if (isThenable(result)) {
                void Promise.resolve(result).catch(() => {});
                throw transactionBoundaryError(
                  'ASYNC_TRANSACTION_CALLBACK',
                  'Transaction callbacks must be synchronous',
                );
              }
              db.run('COMMIT');
              transactionCommitted = true;
            } catch (e) {
              try {
                db.run('ROLLBACK');
              } catch (rollbackError) {
                attachSecondaryError(e, 'rollbackError', rollbackError);
              }
              throw e;
            } finally {
              if (transactionOwner && projectTransactionOwners.get(wrapper) === transactionOwner) {
                projectTransactionOwners.delete(wrapper);
              }
              manuscriptSqlAuthorizations.delete(wrapper);
              transactionDepth -= 1;
            }
            return result;
          }, { flushImmediately: true, useSavepoint: false });
        } catch (error) {
          // A callback/COMMIT failure was rolled back and restores the prior
          // dirty state. Once COMMIT succeeds, however, a publication failure
          // must leave the live mutation dirty so the next lease owner can
          // retry it (before prepared) or recover it (after prepared).
          if (!transactionCommitted) dirty = dirtyBefore;
          throw error;
        }
      };
    },

    flush() {
      assertWrapperAvailable();
      if (!dirty) return;
      if (!writeCoordinator) {
        _flushSync();
        return;
      }
      return writeCoordinator.withProjectWriteSync(filePath, () => {
        _flushSync();
      });
    },

    close() {
      let primaryError = null;
      try {
        if (dirty && writeCoordinator) {
          writeCoordinator.withProjectWriteSync(filePath, () => _flushSync());
        } else {
          _flushSync();
        }
      } catch (error) {
        primaryError = captureFlushFailure(error);
      }
      try {
        store.close();
      } catch (error) {
        if (primaryError) {
          attachSecondaryError(primaryError, 'storageCloseError', error);
        } else {
          primaryError = captureFlushFailure(error);
        }
      }
      if (primaryError) throw primaryError;
    },

    _discard() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      dirty = false;
      flushFailure = null;
      store.close();
    },

    _fenceForLeaseLoss(error) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      return captureFlushFailure(error);
    },

    _flushInProjectWrite() {
      assertWrapperAvailable();
      if (!writeCoordinator) throw new Error('Project write flush is unavailable for the config database');
      writeCoordinator.assertProjectWriteLease(filePath);
      _flushSync();
    },

    _settleManuscriptPublicationFailureInProjectWrite(error) {
      if (!writeCoordinator) throw new Error('Manuscript failure settlement is unavailable for the config database');
      writeCoordinator.assertProjectWriteLease(filePath);
      if (store.recoveryRequired) {
        captureFlushFailure(error);
        return;
      }
      try {
        store.recover({ preserveLiveChanges: false });
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        dirty = false;
        flushFailure = null;
      } catch (discardError) {
        attachSecondaryError(error, 'manuscriptDiscardError', discardError);
        captureFlushFailure(error);
      }
    },

    _recoverForProjectWrite() {
      assertWrapperAvailable();
      const recovered = store.recover({
        preserveLiveChanges: Boolean(dirty || flushTimer),
      });
      if (recovered.status === 'live-preserved') return recovered;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      dirty = false;
      return recovered;
    },
  };
  storesByWrapper.set(wrapper, store);
  return registerDatabaseInternals(wrapper, { store });
}

// ═══════════════════════════════════════════════════════════════
// Initialisation (MUST be called before any other db function)
// ═══════════════════════════════════════════════════════════════

async function initDatabase() {
  databaseInitializationStarted = true;
  const { dataDir, configDbPath } = getStoragePaths();
  console.log('[DB] Initialising database...');
  console.log('[DB] DB_DIR:', dataDir, '| CONFIG_DB:', configDbPath);
  const t0 = Date.now();

  // ─── Load sql.js library ───
  const initSqlJs = require('sql.js');
  console.log('[DB] sql.js library loaded');

  // ─── Load sql-wasm.wasm ───
  // In bun --compile binaries there's no node_modules, so sql.js cannot
  // locate its WASM file via module resolution. We must provide the WASM
  // binary explicitly via initSqlJs({ wasmBinary }).
  //
  // Multiple strategies tried in order:
  //   1. base64-embedded module (works in both bun dev and --compile)
  //   2. fs.readFileSync relative to __dirname (dev mode)
  //   3. fs.readFileSync relative to CWD (fallback)
  let wasmBinary;

  // Strategy 1: base64-embedded WASM (prevents bun --assets bug in 1.3.14)
  try {
    const { getWasmBinary } = require('./wasm-binary');
    wasmBinary = getWasmBinary();
    console.log('[DB] WASM loaded via base64 embedded module');
  } catch (e) {
    console.log('[DB] Embedded WASM module not available:', e.message);
  }

  // Strategy 2: fs.readFileSync relative to this file (dev mode, file on disk)
  if (!wasmBinary) {
    try {
      const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
      if (fs.existsSync(wasmPath)) {
        wasmBinary = fs.readFileSync(wasmPath);
        console.log('[DB] WASM loaded from:', wasmPath);
      }
    } catch {
      // strategy 2 failed
    }
  }

  // Strategy 3: fs.readFileSync from CWD (fallback for bun compiled binary)
  if (!wasmBinary) {
    try {
      const wasmPath = path.join(process.cwd(), 'server', 'sql-wasm.wasm');
      if (fs.existsSync(wasmPath)) {
        wasmBinary = fs.readFileSync(wasmPath);
        console.log('[DB] WASM loaded from:', wasmPath);
      }
    } catch {
      // strategy 3 failed
    }
  }

  if (!wasmBinary) {
    console.log('[DB] WASM not found via any strategy — initSqlJs will use its own loader');
  }

  // ─── Init sql.js runtime ───
  console.log('[DB] Calling initSqlJs()...');
  SQL = await initSqlJs({ wasmBinary });
  console.log('[DB] initSqlJs() OK');

  // ─── Open / create config database ───
  console.log('[DB] Opening config database...');
  configLifecycleLease = acquireConfigLifecycleLease(configDbPath);
  try {
    configDb = _openConfig(configLifecycleLease);
  } catch (error) {
    if (error.storageUncertainConnection) {
      enterStorageFailure(error, [error.storageUncertainConnection]);
      throw error;
    }
    try {
      releaseConfigLifecycleLease();
    } catch (releaseError) {
      attachSecondaryError(error, 'configLeaseReleaseError', releaseError);
      enterStorageFailure(error);
    }
    throw error;
  }
  console.log('[DB] Config database ready, schema version:', CONFIG_SCHEMA_VERSION);

  const t1 = Date.now();
  console.log(`[DB] Database initialised in ${t1 - t0}ms`);
  return true;
}

function _openConfig(lease) {
  if (!lease) throw new Error('ConfigLifecycleLease is required before opening config.db');
  lease.assertHeld();
  const { configDbPath, projectsDir } = getStoragePaths();
  const store = _createAtomicStore(configDbPath, {
    assertWriterLease: () => lease.assertHeld(),
  });
  const wrapped = _wrapDb(store, configDbPath);
  try {
    const db = store.currentConnection();
    db.run('PRAGMA foreign_keys = ON');
    migrateConfig(wrapped);
    repairRecentProjectPaths(wrapped, projectsDir);
    return wrapped;
  } catch (error) {
    try {
      wrapped._discard();
    } catch (cleanupError) {
      attachSecondaryError(error, 'storageOpenCleanupError', cleanupError);
      attachSecondaryError(error, 'storageUncertainConnection', wrapped);
    }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════
// Config DB
// ═══════════════════════════════════════════════════════════════

function getConfigDb() {
  assertStorageAvailable();
  if (!configDb) throw new Error('Database not initialised – call initDatabase() first');
  return configDb;
}

// ═══════════════════════════════════════════════════════════════
// Generic migration runner
// ═══════════════════════════════════════════════════════════════

function runMigrations(db, migrations, targetVersion, getVersionFn, setVersionFn) {
  let currentVersion = getVersionFn(db);
  if (currentVersion >= targetVersion) return;
  for (let v = currentVersion; v < targetVersion; v++) {
    const migration = migrations[v];
    if (typeof migration !== 'function') {
      const error = new Error(`Schema migration step ${v} -> ${v + 1} is missing`);
      error.code = 'SCHEMA_MIGRATION_MISSING';
      throw error;
    }
    migration(db);
    setVersionFn(db, v + 1);
  }
}

// ═══════════════════════════════════════════════════════════════
// Config DB migrations
// ═══════════════════════════════════════════════════════════════

const configMigrations = [
  // v0 → v1: initial schema + defaults
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        file_path   TEXT NOT NULL UNIQUE,
        last_opened TEXT NOT NULL DEFAULT (datetime('now')),
        word_count  INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS editor_snapshots (
        project_path TEXT PRIMARY KEY,
        chapter_num  INTEGER NOT NULL,
        content      TEXT NOT NULL,
        cursor_pos   INTEGER,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Seed default settings if empty
    const count = db.prepare('SELECT COUNT(*) as c FROM app_settings').get().c;
    if (count === 0) {
      const insert = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
      const defaults = [
        ['api_key', ''],
        ['api_base_url', 'https://api.deepseek.com/v1'],
        ['api_model', 'deepseek-v4-flash'],
        ['ui_language', 'zh'],
        ['theme', 'dark'],
        ['editor_font_size', '17'],
        ['editor_font_family', "'Noto Serif SC', 'Source Han Serif SC', 'STSong', Georgia, serif"],
        ['auto_save_interval', '30'],
        ['backup_enabled', 'true'],
        ['accent_color', '#c9a96e'],
      ];
      const innerTx = db.transaction(() => {
        for (const [k, v] of defaults) insert.run(k, v);
      });
      innerTx();
    }
  },
  // v1 -> v2: product route cache. This cache is derived only from project
  // database truth and is never allowed to write route facts back to a
  // project database.
  (db) => {
    db.exec(`
      CREATE TABLE manuscript_route_cache (
        name                  TEXT PRIMARY KEY,
        file_path             TEXT NOT NULL UNIQUE,
        route                 TEXT NOT NULL,
        project_uid           TEXT,
        project_instance_id   TEXT,
        route_journal         TEXT,
        projection_generation INTEGER NOT NULL,
        last_modified         TEXT NOT NULL
      );
      CREATE TABLE manuscript_route_cache_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
];

function makeVersionGetter(tableName) {
  return (db) => {
    const exists = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    if (!exists) {
      db.exec(`CREATE TABLE ${tableName} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    }
    try {
      const row = db.prepare(`SELECT value FROM ${tableName} WHERE key = 'schema_version'`).get();
      return row ? parseInt(row.value, 10) || 0 : 0;
    } catch { return 0; }
  };
}

function makeVersionSetter(tableName) {
  return (db, version) => {
    db.prepare(`INSERT OR REPLACE INTO ${tableName} (key, value) VALUES ('schema_version', ?)`).run(String(version));
  };
}

const getConfigVersion = makeVersionGetter('app_settings');
const setConfigVersion = makeVersionSetter('app_settings');

function migrateConfig(db) {
  runMigrations(db, configMigrations, CONFIG_SCHEMA_VERSION, getConfigVersion, setConfigVersion);
}

// ═══════════════════════════════════════════════════════════════
// Project DB Management
// ═══════════════════════════════════════════════════════════════

const projectConnections = new Map();
const projectOpenStates = new Map();
const projectOpenStatesByLogicalPath = new Map();
let recoveryDiagnosticsPlatformCapabilities = Object.freeze({
  backend: process.platform === 'win32' ? 'win32' : 'posix',
  exclusiveLease: null,
  directoryFsync: null,
  atomicReplace: null,
  verifiedAbsentInstall: null,
});
const projectInstanceContext = new AsyncLocalStorage();
const projectWriteCoordinator = createProjectWriteCoordinator({
  canonicalizeProjectKey: canonicalDbPath,
  lockRoot: () => path.join(getStoragePaths().dataDir, 'locks'),
  onLeaseLost(canonicalProjectPath, error) {
    projectConnections.get(canonicalProjectPath)?._fenceForLeaseLoss(error);
  },
  recoverProject(canonicalProjectPath) {
    projectConnections.get(canonicalProjectPath)?._recoverForProjectWrite();
  },
});
const projectWriteLifecycle = Object.freeze({
  get admissionState() {
    return projectWriteCoordinator.admissionState;
  },
  beginQuiesce: () => projectWriteCoordinator.beginQuiesce(),
  cancelQuiesce: (quiesce) => projectWriteCoordinator.cancelQuiesce(quiesce),
  drain: (quiesce) => projectWriteCoordinator.drain(quiesce),
});
registerProjectWriteDiagnostics(Object.freeze({
  leaseAcquisitionCount: (projectPath) => projectWriteCoordinator.leaseAcquisitionCount(projectPath),
}));

function logicalProjectStateKey(filePath) {
  const resolved = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectStateRecord(openState, reasonCode = null, recommendedAction = null) {
  return Object.freeze({ openState, reasonCode, recommendedAction });
}

function setProjectOpenState(filePath, record) {
  const normalized = projectStateRecord(
    record.openState,
    record.reasonCode ?? null,
    record.recommendedAction ?? null,
  );
  const logicalKey = logicalProjectStateKey(filePath);
  let canonicalKey = logicalKey;
  try {
    canonicalKey = canonicalDbPath(filePath);
  } catch {
    // Unsafe/unreadable projects still need a stable no-reopen record keyed by
    // their exact registered path. The inspector remains responsible for not
    // following that path outside the controlled project leaf.
  }
  projectOpenStates.set(canonicalKey, normalized);
  projectOpenStatesByLogicalPath.set(logicalKey, normalized);
  return normalized;
}

function getProjectOpenState(filePath) {
  return projectOpenStatesByLogicalPath.get(logicalProjectStateKey(filePath)) || null;
}

function removeProjectOpenState(filePath) {
  const logicalKey = logicalProjectStateKey(filePath);
  let canonicalKey = logicalKey;
  try {
    canonicalKey = canonicalDbPath(filePath);
  } catch {
    canonicalKey = logicalKey;
  }
  projectOpenStates.delete(canonicalKey);
  projectOpenStatesByLogicalPath.delete(logicalKey);
}

function recordProjectOpenFailure(filePath, error) {
  const reasonCode = typeof error?.code === 'string' ? error.code : 'RECOVERY_REQUIRED';
  const recommendedAction = reasonCode.startsWith('V1_PUBLICATION_')
    ? 'recover_v1_publication'
    : null;
  return setProjectOpenState(filePath, {
    openState: 'isolated',
    reasonCode,
    recommendedAction,
  });
}

function isolatedProjectError(name, record) {
  const error = new Error(`Project ${name} is isolated and cannot be opened safely`);
  error.code = record.reasonCode || 'RECOVERY_REQUIRED';
  error.status = 409;
  error.recoverable = true;
  return error;
}

function projectInstanceMismatchError(name) {
  const error = new Error(`项目"${name}"已被删除并重建，请刷新后重试`);
  error.code = 'PROJECT_INSTANCE_MISMATCH';
  error.status = 409;
  error.recoverable = true;
  return error;
}

function readProjectInstanceId(projectDb) {
  return projectDb
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get()?.value || '';
}

function validateProjectInstance(projectDb, name, expectedInstanceId) {
  if (!expectedInstanceId) return;
  const actual = readProjectInstanceId(projectDb);
  if (!actual || actual !== expectedInstanceId) throw projectInstanceMismatchError(name);
}

function runWithProjectInstance(name, expectedInstanceId, callback) {
  return projectInstanceContext.run(
    { name, expectedInstanceId: typeof expectedInstanceId === 'string' ? expectedInstanceId : '' },
    callback,
  );
}

function getProjectDbPath(name) {
  return path.join(getStoragePaths().projectsDir, `${name}.mythpen.db`);
}

function _createProjectConnection(filePath, options) {
  const pathState = assertControlledProjectDatabasePath(filePath, {
    allowMissing: options?.explicitCreate === true,
  });
  const projectIdentity = pathState.exists
    ? assertMythpenProjectIdentity(pathState.filePath)
    : null;
  if (projectIdentity?.route === 'files') {
    throw projectDatabaseError(
      'RECOVERY_REQUIRED',
      `Files-authority project must be opened through the manuscript runtime: ${filePath}`,
    );
  }
  if (pathState.exists) {
    const dbKey = createHash('sha256').update(canonicalDbPath(filePath)).digest('hex');
    const controlDirectory = path.join(getStoragePaths().dataDir, 'control', 'sqlite', dbKey);
    const controlStore = openControlStore(controlDirectory);
    const evidence = inspectControlStoreEvidence(controlDirectory).events;
    const prepared = evidence.some((event) => event.type === 'sqlite.native.activation.prepared');
    const activated = evidence.some((event) => event.type === 'sqlite.native.activation.activated');
    if (activated) {
      if (!nativeActivationController) {
        const error = new Error('Native project activation is disabled in this build');
        error.code = 'NATIVE_ACTIVATION_DISABLED';
        throw error;
      }
      let nativeStore;
      try {
        nativeStore = nativeActivationController.activate({
          assertConfigLifecycleLease: () => configLifecycleLease.assertHeld(),
          assertWriterLease: () => projectWriteCoordinator.assertProjectWriteLease(filePath),
          controlDirectory,
          controlStore,
          databasePath: filePath,
          dbKey,
          sqlModule: SQL,
        });
      } catch (cause) {
        throw nativeProjectAdmissionError(filePath, cause);
      }
      return createNativeDbAdapter({
        controlStore,
        coordinator: projectWriteCoordinator,
        databasePath: filePath,
        nativeStore,
        validateManuscriptSqlScope,
      });
    }
    if (prepared) {
      const error = new Error('Project has an unfinished native activation');
      error.code = 'RECOVERY_REQUIRED';
      throw error;
    }
  }
  const store = _createAtomicStore(filePath, {
    ...options,
    assertWriterLease: () => projectWriteCoordinator.assertProjectWriteLease(filePath),
  });
  const wrapped = _wrapDb(store, filePath, { writeCoordinator: projectWriteCoordinator });
  try {
    const db = store.currentConnection();
    db.run('PRAGMA foreign_keys = ON');
    migrateProject(wrapped);
    wrapped._flushInProjectWrite();
    return wrapped;
  } catch (error) {
    try {
      wrapped._discard();
    } catch (cleanupError) {
      attachSecondaryError(error, 'storageOpenCleanupError', cleanupError);
      attachSecondaryError(error, 'storageUncertainConnection', wrapped);
    }
    throw error;
  }
}

function nativeProjectAdmissionError(filePath, cause) {
  if (cause?.code === 'RECOVERY_REQUIRED' || cause?.code === 'NATIVE_STORE_DISPOSITION_UNKNOWN') {
    return cause;
  }
  return projectDatabaseError(
    'RECOVERY_REQUIRED',
    `Native project evidence does not match the admitted schema-11 database: ${filePath}`,
    { cause },
  );
}

function assertCachedNativeProjectAdmission(filePath, cacheKey, projectDb) {
  if (typeof projectDb?.runManuscriptTransaction !== 'function') return projectDb;
  try {
    // The native store projects the complete authenticated suffix before every
    // business read. Use that same authority before a cached adapter escapes.
    projectDb.prepare('SELECT 1 AS native_admission_probe').get();
    return projectDb;
  } catch (cause) {
    projectConnections.delete(cacheKey);
    const error = nativeProjectAdmissionError(filePath, cause);
    recordProjectOpenFailure(filePath, error);
    throw error;
  }
}

function openProjectDb(filePath) {
  assertStorageAvailable();
  const existing = pathExistsStrict(filePath);
  const openState = getProjectOpenState(filePath);
  if (existing && openState?.openState === 'isolated') {
    throw isolatedProjectError(path.basename(filePath, PROJECT_DATABASE_SUFFIX), openState);
  }
  const pathState = assertControlledProjectDatabasePath(filePath, { allowMissing: !existing });
  if (pathState.exists) assertMythpenProjectIdentity(pathState.filePath);
  const cacheKey = canonicalDbPath(filePath);
  if (projectConnections.has(cacheKey)) {
    return assertCachedNativeProjectAdmission(
      filePath,
      cacheKey,
      projectConnections.get(cacheKey),
    );
  }
  return projectWriteCoordinator.withProjectWriteSync(filePath, () => {
    if (projectConnections.has(cacheKey)) {
      return assertCachedNativeProjectAdmission(
        filePath,
        cacheKey,
        projectConnections.get(cacheKey),
      );
    }
    const wrapped = _createProjectConnection(filePath, {
      explicitCreate: !pathExistsStrict(filePath),
    });
    projectConnections.set(cacheKey, wrapped);
    return wrapped;
  });
}

function closeProjectDb(filePath) {
  const cacheKey = canonicalDbPath(filePath);
  if (projectConnections.has(cacheKey)) {
    projectConnections.get(cacheKey).close();
    projectConnections.delete(cacheKey);
  }
}

async function enableNativeProject(name, expectedInstanceId) {
  if (!nativeActivationController || nativeActivationAdmissionMode() === null) {
    const error = new Error('Native project activation is disabled in this build');
    error.code = 'NATIVE_ACTIVATION_DISABLED';
    throw error;
  }
  if (typeof name !== 'string' || name.length === 0) {
    const error = new Error('Project name is required');
    error.code = 'INVALID_PARAMS';
    throw error;
  }
  if (typeof expectedInstanceId !== 'string' || expectedInstanceId.length === 0) {
    const error = new Error('Project instance is required for native activation');
    error.code = 'INVALID_PARAMS';
    throw error;
  }
  const registered = getConfigDb()
    .prepare('SELECT name, file_path FROM recent_projects WHERE name = ?')
    .get(name);
  const filePath = getProjectDbPath(name);
  if (!registered || canonicalDbPath(registered.file_path) !== canonicalDbPath(filePath)) {
    const error = new Error(`Project ${name} is not registered`);
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }

  const cacheKey = canonicalDbPath(filePath);
  configLifecycleLease.assertHeld();
  return projectWriteCoordinator.withProjectWriteSync(filePath, (writeContext) => {
    writeContext.assertLease();
    configLifecycleLease.assertHeld();
    assertControlledProjectDatabasePath(filePath, { allowMissing: false });
    const sourceInspection = assertMythpenProjectIdentity(filePath);
    if (sourceInspection.schema !== NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION) {
      const error = new Error(
        `Project ${name} is not an exact schema-${NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION} activation source`,
      );
      error.code = sourceInspection.schema > PROJECT_SCHEMA_VERSION
        ? 'PROJECT_SCHEMA_TOO_NEW'
        : 'RECOVERY_REQUIRED';
      throw error;
    }
    const expectedInstanceIdSha256 = createHash('sha256')
      .update(expectedInstanceId, 'utf8')
      .digest('hex');
    if (sourceInspection.projectInstanceIdSha256 !== expectedInstanceIdSha256) {
      throw projectInstanceMismatchError(name);
    }
    let cached = projectConnections.get(cacheKey) || null;
    if (cached) {
      const schemaVersion = getProjectVersion(cached);
      if (schemaVersion !== NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION) {
        const error = new Error(
          `Project ${name} is not an exact schema-${NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION} activation source`,
        );
        error.code = schemaVersion > PROJECT_SCHEMA_VERSION
          ? 'PROJECT_SCHEMA_TOO_NEW'
          : 'RECOVERY_REQUIRED';
        throw error;
      }

      try {
        cached._flushInProjectWrite();
        cached.close();
        projectConnections.delete(cacheKey);
      } catch (error) {
        projectConnections.delete(cacheKey);
        recordProjectOpenFailure(filePath, error);
        throw error;
      }
    }

    const dbKey = createHash('sha256').update(canonicalDbPath(filePath)).digest('hex');
    const controlDirectory = path.join(getStoragePaths().dataDir, 'control', 'sqlite', dbKey);
    let controlStore;
    try {
      controlStore = openControlStore(controlDirectory);
      const nativeStore = nativeActivationController.activate({
        assertConfigLifecycleLease: () => configLifecycleLease.assertHeld(),
        assertWriterLease: () => projectWriteCoordinator.assertProjectWriteLease(filePath),
        controlDirectory,
        controlStore,
        databasePath: filePath,
        dbKey,
        sqlModule: SQL,
      });
      const adapter = createNativeDbAdapter({
        controlStore,
        coordinator: projectWriteCoordinator,
        databasePath: filePath,
        nativeStore,
        validateManuscriptSqlScope,
      });
      projectConnections.set(cacheKey, adapter);
      setProjectOpenState(filePath, { openState: 'ready' });
      return Object.freeze({
        activated: true,
        backend: 'native',
        name,
        schemaVersion: 11,
      });
    } catch (error) {
      let nativeEvidence = true;
      try {
        nativeEvidence = inspectControlStoreEvidence(controlDirectory).events.some((event) => (
          event.type === 'sqlite.native.activation.prepared'
          || event.type === 'sqlite.native.activation.activated'
        ));
      } catch (inspectionError) {
        attachSecondaryError(error, 'nativeEvidenceInspectionError', inspectionError);
      }
      if (nativeEvidence) recordProjectOpenFailure(filePath, error);
      else {
        try {
          const restored = _createProjectConnection(filePath, { explicitCreate: false });
          projectConnections.set(cacheKey, restored);
        } catch (restoreError) {
          attachSecondaryError(error, 'nativeActivationRestoreError', restoreError);
          recordProjectOpenFailure(filePath, error);
        }
      }
      throw error;
    }
  });
}

function startupRecoveryError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

const PROJECT_DATABASE_SUFFIX = '.mythpen.db';

function projectDatabaseError(code, message, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function controlledPathCode(startup, suffix) {
  return startup ? `STARTUP_RECOVERY_${suffix}` : `PROJECT_DATABASE_${suffix}`;
}

function assertControlledProjectDatabasePath(filePath, {
  allowMissing = false,
  startup = false,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw projectDatabaseError(
      controlledPathCode(startup, 'INVALID_PATH'),
      'A project database path must be a non-empty string',
    );
  }
  const exactPath = path.resolve(filePath);
  const projectsDirectory = canonicalDbPath(getStoragePaths().projectsDir);
  const physicalParent = canonicalDbPath(path.dirname(exactPath));
  const baseName = path.basename(exactPath);
  if (
    physicalParent !== projectsDirectory
    || baseName.startsWith('.')
    || !baseName.toLowerCase().endsWith(PROJECT_DATABASE_SUFFIX)
    || baseName.length === PROJECT_DATABASE_SUFFIX.length
  ) {
    throw projectDatabaseError(
      controlledPathCode(startup, 'UNCONTROLLED_PATH'),
      `Project database is outside the controlled projects leaf: ${exactPath}`,
    );
  }

  let stats;
  try {
    stats = fs.lstatSync(exactPath, { bigint: true });
  } catch (cause) {
    if (cause?.code === 'ENOENT' && allowMissing) return { exists: false, filePath: exactPath };
    throw projectDatabaseError(
      controlledPathCode(startup, 'PATH_UNREADABLE'),
      `Cannot inspect project database ${exactPath}`,
      { cause },
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw projectDatabaseError(
      controlledPathCode(startup, 'UNSAFE_PATH'),
      `Project database is not a single-link plain file: ${exactPath}`,
    );
  }
  return { exists: true, filePath: exactPath };
}

function inspectSchema11BytesContract(bytes) {
  const database = new SQL.Database(bytes);
  const query = (sql) => {
    const all = (...params) => {
      const statement = database.prepare(sql);
      try {
        if (params.length > 0) statement.bind(params.map((value) => (
          value === undefined ? null : value
        )));
        const rows = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally {
        statement.free();
      }
    };
    return Object.freeze({
      all,
      get(...params) { return all(...params)[0] || null; },
    });
  };
  try {
    const committedSeqText = query(
      "SELECT value FROM project_meta WHERE key = 'durability_commit_seq'",
    ).get()?.value;
    if (typeof committedSeqText !== 'string' || !/^(?:0|[1-9]\d*)$/.test(committedSeqText)) {
      throw projectDatabaseError(
        'RECOVERY_REQUIRED',
        'Activated durability commit sequence is not canonical',
      );
    }
    const expectedFinalSeq = Number(committedSeqText);
    if (!Number.isSafeInteger(expectedFinalSeq) || expectedFinalSeq < 0) {
      throw projectDatabaseError(
        'RECOVERY_REQUIRED',
        'Activated durability commit sequence is outside the safe range',
      );
    }
    return inspectSchema11Contract(Object.freeze({ query }), { expectedFinalSeq });
  } finally {
    database.close();
  }
}

function sqlJsQueryFacade(database) {
  return Object.freeze({
    query(sql) {
      const all = (...params) => {
        const statement = database.prepare(sql);
        try {
          if (params.length > 0) statement.bind(params.map((value) => (
            value === undefined ? null : value
          )));
          const rows = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows;
        } finally {
          statement.free();
        }
      };
      return Object.freeze({
        all,
        get(...params) { return all(...params)[0] || null; },
      });
    },
  });
}

function inspectSchema12RouteAdmission(bytes) {
  const database = new SQL.Database(bytes);
  try {
    const facade = sqlJsQueryFacade(database);
    const metaRows = facade.query(
      "SELECT key, value FROM project_meta WHERE key IN ('durability_commit_seq', 'project_instance_id', 'manuscript_project_uid', 'manuscript_projection_generation', 'manuscript_route', 'manuscript_route_journal')",
    ).all();
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    if (meta.get('manuscript_route') !== 'files') {
      throw projectDatabaseError(
        'PROJECT_SCHEMA_TOO_NEW',
        'Schema12 is admitted only through an activated files route',
      );
    }
    const committed = meta.get('durability_commit_seq');
    if (typeof committed !== 'string' || !/^(?:0|[1-9]\d*)$/.test(committed)) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Schema12 commit sequence is not canonical');
    }
    const expectedFinalSeq = Number(committed);
    if (!Number.isSafeInteger(expectedFinalSeq) || expectedFinalSeq < 0) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Schema12 commit sequence is outside the safe range');
    }
    const { inspectSchema12Contract } = require('./native/durability-schema');
    const contract = inspectSchema12Contract(facade, { expectedFinalSeq });
    const databaseFacts = Object.freeze({
      schemaVersion: 12,
      route: contract.route,
      projectUid: contract.manuscriptProjectUid,
      projectInstanceId: contract.projectInstanceId,
      routeJournal: contract.routeJournal,
      projectionGeneration: contract.projectionGeneration,
    });
    const routeFacts = Object.freeze({
      route: meta.get('manuscript_route'),
      projectUid: meta.get('manuscript_project_uid'),
      projectInstanceId: meta.get('project_instance_id'),
      routeJournal: meta.get('manuscript_route_journal'),
      projectionGeneration: Number(meta.get('manuscript_projection_generation')),
    });
    const {
      loadDurableActivatedProof,
      verifyActivatedSchema12Admission,
    } = require('./manuscript/runtime');
    const activatedProof = loadDurableActivatedProof({
      dataRoot: getStoragePaths().dataDir,
      databaseFacts,
    });
    return verifyActivatedSchema12Admission(Object.freeze({
      route: 'files',
      databaseFacts,
      routeFacts,
      activatedProof,
    }));
  } finally {
    database.close();
  }
}

function assertMythpenProjectIdentity(filePath, { startup = false } = {}) {
  try {
    let bytes;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (cause) {
      throw projectDatabaseError(
        startup ? 'STARTUP_RECOVERY_PATH_UNREADABLE' : 'RECOVERY_REQUIRED',
        `Project database cannot be read for identity preflight: ${filePath}`,
        { cause },
      );
    }
    const inspection = inspectProjectDatabaseBytes(SQL, bytes);
    if (!inspection.isProject) {
      throw projectDatabaseError(
        startup ? 'STARTUP_RECOVERY_NOT_PROJECT' : 'PROJECT_DATABASE_NOT_PROJECT',
        `SQLite file is not an identified Mythpen project database: ${filePath}`,
      );
    }
    if (inspection.schema === 12) {
      const admission = inspectSchema12RouteAdmission(bytes);
      return Object.freeze({
        projectInstanceIdSha256: inspection.projectInstanceIdSha256,
        schema: 12,
        route: 'files',
        admission,
      });
    }
    let admittedActivatedSchema = false;
    if (inspection.schema === PROJECT_SCHEMA_VERSION && nativeActivationAdmissionMode() !== null) {
      const dbKey = createHash('sha256').update(canonicalDbPath(filePath)).digest('hex');
      const controlDirectory = path.join(getStoragePaths().dataDir, 'control', 'sqlite', dbKey);
      try {
        const { assertActivatedNativeEvidence } = require('./native/native-activation');
        const activated = assertActivatedNativeEvidence({ controlDirectory, dbKey });
        const contract = inspectSchema11BytesContract(bytes);
        admittedActivatedSchema = (
          contract.backend === activated.backend
          && contract.gateEmpty === activated.gateEmpty
          && contract.projectInstanceIdSha256 === activated.projectInstanceIdSha256
          && contract.projectInstanceIdSha256 === inspection.projectInstanceIdSha256
          && contract.schemaVersion === activated.schemaVersion
          && contract.triggerSetDigest === activated.triggerSetDigest
          && contract.triggerVersion === activated.triggerVersion
        );
      } catch {
        admittedActivatedSchema = false;
      }
    }
    if (inspection.schema > PROJECT_SCHEMA_VERSION && !admittedActivatedSchema) {
      throw projectDatabaseError(
        'PROJECT_SCHEMA_TOO_NEW',
        `Project database schema is newer than this build supports: ${filePath}`,
      );
    }
    if (inspection.schema === PROJECT_SCHEMA_VERSION && !admittedActivatedSchema) {
      throw projectDatabaseError(
        'RECOVERY_REQUIRED',
        `Project schema ${PROJECT_SCHEMA_VERSION} lacks exact native activation admission: ${filePath}`,
      );
    }
    return Object.freeze({
      projectInstanceIdSha256: inspection.projectInstanceIdSha256,
      schema: inspection.schema,
    });
  } catch (cause) {
    if (
      cause?.code === 'STARTUP_RECOVERY_NOT_PROJECT'
      || cause?.code === 'STARTUP_RECOVERY_PATH_UNREADABLE'
      || cause?.code === 'PROJECT_DATABASE_NOT_PROJECT'
      || cause?.code === 'PROJECT_SCHEMA_TOO_NEW'
      || cause?.code === 'RECOVERY_REQUIRED'
    ) {
      throw cause;
    } else {
      throw projectDatabaseError(
        startup ? 'STARTUP_RECOVERY_NOT_PROJECT' : 'PROJECT_DATABASE_NOT_PROJECT',
        `SQLite file cannot be identified as a Mythpen project database: ${filePath}`,
        { cause },
      );
    }
  }
}

function recoveryControlDirectory(filePath) {
  const dbKey = createHash('sha256').update(canonicalDbPath(filePath)).digest('hex');
  return path.join(getStoragePaths().dataDir, 'control', 'sqlite', dbKey);
}

function lookupRegisteredProject(name) {
  assertStorageAvailable();
  if (typeof name !== 'string' || name.length === 0) return null;
  const rows = getConfigDb()
    .prepare('SELECT name, file_path FROM recent_projects WHERE name = ? ORDER BY id')
    .all(name);
  if (rows.length !== 1) return null;
  const row = rows[0];
  if (row.name !== name || typeof row.file_path !== 'string' || row.file_path.length === 0) {
    return null;
  }
  const pathState = assertControlledProjectDatabasePath(row.file_path, { allowMissing: true });
  return { name, filePath: pathState.filePath };
}

function getRegisteredProjectDatabaseSha256(name) {
  const registered = lookupRegisteredProject(name);
  if (!registered) {
    const error = new Error(`Registered project not found: ${name}`);
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }
  const pathState = assertControlledProjectDatabasePath(registered.filePath);
  return createHash('sha256').update(fs.readFileSync(pathState.filePath)).digest('hex');
}

function recoverV1Publication({ filePath }) {
  const cacheKey = canonicalDbPath(filePath);
  const cached = projectConnections.get(cacheKey);
  if (cached) return cached._recoverForProjectWrite();
  const controlStore = openControlStore(recoveryControlDirectory(filePath));
  const store = createAtomicStore({
    assertWriterLease: () => projectWriteCoordinator.assertProjectWriteLease(filePath),
    filePath,
    controlStore,
    sqlModule: SQL,
  });
  try {
    return store.recover();
  } finally {
    store.close();
  }
}

function recoveryDiagnosticsDependencies() {
  return {
    canonicalizeProjectPath: canonicalDbPath,
    getControlDirectory: recoveryControlDirectory,
    lookupRegisteredProject,
    platformCapabilities: recoveryDiagnosticsPlatformCapabilities,
    recoverV1Publication,
    sqlModule: SQL,
    supportedSchemaVersion: SQLJS_PROJECT_SCHEMA_VERSION,
    withProjectRecoveryLease: (filePath, callback) => (
      projectWriteCoordinator.withProjectRecoveryLeaseSync(filePath, callback)
    ),
  };
}

function configureRecoveryDiagnosticsCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return;
  recoveryDiagnosticsPlatformCapabilities = Object.freeze({
    backend: capabilities.backend ?? recoveryDiagnosticsPlatformCapabilities.backend,
    exclusiveLease: capabilities.exclusiveLease ?? null,
    directoryFsync: capabilities.directoryFsync ?? null,
    atomicReplace: capabilities.atomicReplace ?? null,
    verifiedAbsentInstall: capabilities.verifiedAbsentInstall ?? null,
  });
}

function inspectRegisteredProject(name) {
  const diagnostics = inspectRegisteredProjectWithDependencies(
    name,
    recoveryDiagnosticsDependencies(),
  );
  const registered = lookupRegisteredProject(name);
  if (registered) {
    setProjectOpenState(registered.filePath, {
      openState: diagnostics.state === 'ready' ? 'ready' : 'isolated',
      reasonCode: diagnostics.reasonCode,
      recommendedAction: diagnostics.recommendedAction,
    });
  }
  return diagnostics;
}

function recoverRegisteredProject(name, request) {
  const diagnostics = recoverRegisteredProjectWithDependencies(
    name,
    request,
    recoveryDiagnosticsDependencies(),
  );
  const registered = lookupRegisteredProject(name);
  if (registered) {
    setProjectOpenState(registered.filePath, {
      openState: 'ready',
      reasonCode: null,
      recommendedAction: null,
    });
  }
  return diagnostics;
}

function inspectProjectDatabasesAtStartup({ maxProjects = STARTUP_RECOVERY_MAX_PROJECTS } = {}) {
  assertStorageAvailable();
  if (!Number.isSafeInteger(maxProjects) || maxProjects < 0) {
    throw new TypeError('maxProjects must be a non-negative safe integer');
  }
  const rowLimit = maxProjects === Number.MAX_SAFE_INTEGER ? -1 : maxProjects + 1;
  const rows = getConfigDb()
    .prepare('SELECT id, name, file_path FROM recent_projects ORDER BY file_path, id LIMIT ?')
    .all(rowLimit);
  if (rows.length > maxProjects) {
    throw startupRecoveryError(
      'STARTUP_RECOVERY_LIMIT',
      `Startup inspection found more than ${maxProjects} registered projects`,
    );
  }

  projectOpenStates.clear();
  projectOpenStatesByLogicalPath.clear();
  for (const row of rows) {
    if (typeof row.file_path !== 'string' || row.file_path.length === 0) {
      throw startupRecoveryError(
        'STARTUP_RECOVERY_INVALID_PATH',
        'A registered project has no exact database path',
      );
    }
    try {
      const controlDirectory = recoveryControlDirectory(row.file_path);
      const nativeEvidence = inspectControlStoreEvidence(controlDirectory).events;
      const hasPrepared = nativeEvidence.some((event) => (
        event.type === 'sqlite.native.activation.prepared'
      ));
      const hasActivated = nativeEvidence.some((event) => (
        event.type === 'sqlite.native.activation.activated'
      ));
      if (hasPrepared || hasActivated) {
        const pathState = assertControlledProjectDatabasePath(row.file_path, { startup: true });
        assertMythpenProjectIdentity(pathState.filePath, { startup: true });
        if (nativeActivationAdmissionMode() !== null && hasPrepared && hasActivated) {
          projectWriteCoordinator.withProjectRecoveryLeaseSync(pathState.filePath, () => {
            const connection = _createProjectConnection(pathState.filePath, { explicitCreate: false });
            connection.close();
          });
          setProjectOpenState(pathState.filePath, {
            openState: 'ready',
            reasonCode: null,
            recommendedAction: null,
          });
          continue;
        }
        setProjectOpenState(pathState.filePath, {
          openState: 'isolated',
          reasonCode: 'RECOVERY_REQUIRED',
          recommendedAction: null,
        });
        continue;
      }
      const diagnostics = inspectRegisteredProject(row.name);
      if (diagnostics.reasonCode === 'PROJECT_SCHEMA_TOO_NEW') {
        const pathState = assertControlledProjectDatabasePath(row.file_path, { startup: true });
        assertMythpenProjectIdentity(pathState.filePath, { startup: true });
      }
      setProjectOpenState(row.file_path, {
        openState: diagnostics.state === 'ready' ? 'ready' : 'isolated',
        reasonCode: diagnostics.reasonCode,
        recommendedAction: diagnostics.recommendedAction,
      });
    } catch (error) {
      recordProjectOpenFailure(row.file_path, error);
    }
  }
  return projectOpenStates;
}

function collectStartupRecoveryPaths({ maxProjects = STARTUP_RECOVERY_MAX_PROJECTS } = {}) {
  assertStorageAvailable();
  if (!Number.isSafeInteger(maxProjects) || maxProjects < 0) {
    throw new TypeError('maxProjects must be a non-negative safe integer');
  }
  const config = getConfigDb();
  const rowLimit = maxProjects === Number.MAX_SAFE_INTEGER ? -1 : maxProjects + 1;
  const rows = config
    .prepare('SELECT file_path FROM recent_projects ORDER BY file_path, id LIMIT ?')
    .all(rowLimit);
  if (rows.length > maxProjects) {
    throw startupRecoveryError(
      'STARTUP_RECOVERY_LIMIT',
      `Startup recovery found more than ${maxProjects} registered projects`,
    );
  }
  const paths = new Set();
  for (const row of rows) {
    if (typeof row.file_path !== 'string' || row.file_path.length === 0) {
      throw startupRecoveryError(
        'STARTUP_RECOVERY_INVALID_PATH',
        'A registered project has no exact database path',
      );
    }
    const exactPath = path.resolve(row.file_path);
    const pathState = assertControlledProjectDatabasePath(exactPath, {
      allowMissing: true,
      startup: true,
    });
    if (!pathState.exists) continue;
    assertMythpenProjectIdentity(pathState.filePath, { startup: true });
    paths.add(canonicalDbPath(pathState.filePath));
  }
  const ordered = [...paths].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  if (ordered.length > maxProjects) {
    throw startupRecoveryError(
      'STARTUP_RECOVERY_LIMIT',
      `Startup recovery found ${ordered.length} registered projects; limit is ${maxProjects}`,
    );
  }
  return ordered;
}

function recoverProjectDatabasesAtStartup(options) {
  const projectPaths = collectStartupRecoveryPaths(options);
  for (const projectPath of projectPaths) {
    const cacheKey = canonicalDbPath(projectPath);
    if (projectConnections.has(cacheKey)) {
      projectWriteCoordinator.withProjectWriteSync(projectPath, () => {});
      continue;
    }
    projectWriteCoordinator.withProjectWriteSync(projectPath, () => {
      const wrapped = _createProjectConnection(projectPath, { explicitCreate: false });
      wrapped.close();
    });
  }
  return projectPaths;
}

function createProjectDb(name) {
  const filePath = getProjectDbPath(name);
  const projectDb = openProjectDb(filePath);
  setProjectOpenState(filePath, {
    openState: 'ready',
    reasonCode: null,
    recommendedAction: null,
  });
  return projectDb;
}

function getProjectDb(name) {
  const filePath = getProjectDbPath(name);
  const openState = getProjectOpenState(filePath);
  if (openState?.openState === 'isolated') throw isolatedProjectError(name, openState);
  const cacheKey = canonicalDbPath(filePath);
  // A freshly created sql.js database is cached immediately but reaches disk
  // on its scheduled flush. That live connection is the intentional project
  // instance and must remain usable during this short window.
  if (projectConnections.has(cacheKey)) {
    const projectDb = assertCachedNativeProjectAdmission(
      filePath,
      cacheKey,
      projectConnections.get(cacheKey),
    );
    const context = projectInstanceContext.getStore();
    if (context?.name === name) validateProjectInstance(projectDb, name, context.expectedInstanceId);
    return projectDb;
  }
  if (!fs.existsSync(filePath)) {
    // Ordinary reads and writes must never create a database as a side effect.
    // A delayed request after project deletion would otherwise resurrect a
    // blank file (or later target a same-name replacement).
    const error = new Error(`项目"${name}"不存在`);
    error.code = 'PROJECT_NOT_FOUND';
    error.status = 404;
    error.recoverable = true;
    throw error;
  }
  const projectDb = openProjectDb(filePath);
  const context = projectInstanceContext.getStore();
  if (context?.name === name) validateProjectInstance(projectDb, name, context.expectedInstanceId);
  return projectDb;
}

const MIGRATION_ROUTE_FENCE_EVENT = 'manuscript.migration.route_fenced';

function inspectDurableMigrationRoute(filePath) {
  const root = path.join(getStoragePaths().dataDir, 'control', 'manuscripts');
  if (!fs.existsSync(root)) return null;
  const matches = [];
  for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectRoot = path.join(root, projectEntry.name);
    for (const instanceEntry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!instanceEntry.isDirectory()) continue;
      const controlDirectory = path.join(projectRoot, instanceEntry.name);
      const events = inspectControlStoreEvidence(controlDirectory).events;
      const stateByMigration = new Map();
      const fences = new Map();
      for (const event of events) {
        if (event?.type === MIGRATION_ROUTE_FENCE_EVENT) {
          const payload = event.payload;
          if (
            payload?.version !== 1
            || typeof payload.migrationId !== 'string'
            || typeof payload.sourcePath !== 'string'
          ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration route fence evidence is malformed');
          const prior = fences.get(payload.migrationId);
          if (prior && JSON.stringify(prior) !== JSON.stringify(payload)) {
            throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration route fence binding changed');
          }
          fences.set(payload.migrationId, payload);
        } else if (typeof event?.type === 'string' && event.type.startsWith('migration.')) {
          const migrationId = event.payload?.migrationId;
          const state = event.payload?.state;
          if (typeof migrationId !== 'string' || typeof state !== 'string') {
            throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration journal route state is malformed');
          }
          stateByMigration.set(migrationId, state);
        }
      }
      for (const [migrationId, fence] of fences) {
        const state = stateByMigration.get(migrationId);
        if (state === 'activated' || state === 'migration_aborted') continue;
        if (canonicalDbPath(fence.sourcePath) !== canonicalDbPath(filePath)) continue;
        matches.push(Object.freeze({
          route: 'migrating',
          projectUid: fence.projectUid,
          projectInstanceId: fence.projectInstanceId,
          routeJournal: migrationId,
          projectionGeneration: 0,
        }));
      }
    }
  }
  if (matches.length > 1) {
    throw projectDatabaseError('RECOVERY_REQUIRED', 'Project path has multiple unresolved migration fences');
  }
  return matches[0] ?? null;
}

function inspectProjectManuscriptRoute(name) {
  assertStorageAvailable();
  if (typeof name !== 'string' || name.length === 0) {
    throw projectDatabaseError('PROJECT_NOT_FOUND', 'Project name is required');
  }
  const filePath = getProjectDbPath(name);
  const pathState = assertControlledProjectDatabasePath(filePath, { allowMissing: true });
  if (!pathState.exists) {
    throw projectDatabaseError('PROJECT_NOT_FOUND', `Project database does not exist: ${filePath}`);
  }
  const migration = inspectDurableMigrationRoute(pathState.filePath);
  if (migration !== null) return migration;
  const identity = assertMythpenProjectIdentity(pathState.filePath);
  if (identity.route === 'files') return identity.admission;
  const database = new SQL.Database(fs.readFileSync(pathState.filePath));
  try {
    const rows = sqlJsQueryFacade(database).query(
      "SELECT key, value FROM project_meta WHERE key IN ('manuscript_route', 'manuscript_route_journal', 'manuscript_project_uid', 'manuscript_projection_generation', 'project_instance_id')",
    ).all();
    const meta = new Map(rows.map((row) => [row.key, row.value]));
    const route = meta.get('manuscript_route');
    if (route === 'migrating' || route === 'retired') {
      return Object.freeze({
        route,
        projectUid: meta.get('manuscript_project_uid') ?? null,
        projectInstanceId: meta.get('project_instance_id') ?? null,
        routeJournal: meta.get('manuscript_route_journal') ?? null,
        projectionGeneration: Number(meta.get('manuscript_projection_generation') ?? 0),
      });
    }
    return Object.freeze({ route: 'sqlite' });
  } finally {
    database.close();
  }
}

const PROJECT_ROUTE_CACHE_ROUTES = new Set(['sqlite', 'files', 'migrating', 'retired']);

function captureProjectRouteTruth() {
  assertStorageAvailable();
  const entries = fs.readdirSync(getStoragePaths().projectsDir, { withFileTypes: true });
  const records = [];
  const catalog = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(PROJECT_DATABASE_SUFFIX)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Project route catalog contains a non-file database entry');
    }
    const name = entry.name.slice(0, -PROJECT_DATABASE_SUFFIX.length);
    if (
      name.length === 0
      || path.basename(name) !== name
      || path.basename(getProjectDbPath(name)) !== entry.name
    ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Project route catalog contains a non-canonical project name');
    const filePath = getProjectDbPath(name);
    const pathState = assertControlledProjectDatabasePath(filePath);
    const stats = fs.lstatSync(pathState.filePath, { bigint: true });
    const admission = inspectProjectManuscriptRoute(name);
    const facts = admission.route === 'files'
      ? admission.databaseFacts
      : admission;
    if (!PROJECT_ROUTE_CACHE_ROUTES.has(admission.route)) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Project route truth contains an invalid route');
    }
    const record = Object.freeze({
      name,
      filePath: pathState.filePath,
      route: admission.route,
      projectUid: facts.projectUid ?? null,
      projectInstanceId: facts.projectInstanceId ?? null,
      routeJournal: facts.routeJournal ?? null,
      projectionGeneration: Number(facts.projectionGeneration ?? 0),
      lastModified: stats.mtime.toISOString(),
    });
    records.push(record);
    catalog.push(Object.freeze({
      ...record,
      dev: String(stats.dev),
      ino: String(stats.ino),
      size: String(stats.size),
      mtimeNs: String(stats.mtimeNs),
    }));
  }
  records.sort((left, right) => left.name.localeCompare(right.name));
  catalog.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    digest: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),
    records: Object.freeze(records),
  });
}

function cachedProjectRouteRecords() {
  const config = getConfigDb();
  const cacheColumns = config.prepare('PRAGMA table_info(manuscript_route_cache)').all()
    .map((row) => row.name);
  const metaColumns = config.prepare('PRAGMA table_info(manuscript_route_cache_meta)').all()
    .map((row) => row.name);
  if (
    JSON.stringify(cacheColumns) !== JSON.stringify([
      'name',
      'file_path',
      'route',
      'project_uid',
      'project_instance_id',
      'route_journal',
      'projection_generation',
      'last_modified',
    ])
    || JSON.stringify(metaColumns) !== JSON.stringify(['key', 'value'])
  ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Project route cache schema is missing or corrupt');
  const digest = config.prepare(
    "SELECT value FROM manuscript_route_cache_meta WHERE key = 'truth_digest'",
  ).get()?.value;
  const records = config.prepare(`
    SELECT name, file_path, route, project_uid, project_instance_id,
           route_journal, projection_generation, last_modified
    FROM manuscript_route_cache
    ORDER BY name
  `).all().map((row) => Object.freeze({
    name: row.name,
    filePath: row.file_path,
    route: row.route,
    projectUid: row.project_uid ?? null,
    projectInstanceId: row.project_instance_id ?? null,
    routeJournal: row.route_journal ?? null,
    projectionGeneration: Number(row.projection_generation),
    lastModified: row.last_modified,
  }));
  return Object.freeze({ digest: digest ?? null, records: Object.freeze(records) });
}

function sameProjectRouteRecords(left, right) {
  return left.length === right.length && left.every((record, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && record.name === candidate.name
      && record.filePath === candidate.filePath
      && record.route === candidate.route
      && record.projectUid === candidate.projectUid
      && record.projectInstanceId === candidate.projectInstanceId
      && record.routeJournal === candidate.routeJournal
      && record.projectionGeneration === candidate.projectionGeneration
      && record.lastModified === candidate.lastModified;
  });
}

function publishConfigCache(truth, resetSchema = false) {
  const config = getConfigDb();
  config.transaction(() => {
    if (resetSchema) {
      config.exec(`
        DROP TABLE IF EXISTS manuscript_route_cache;
        DROP TABLE IF EXISTS manuscript_route_cache_meta;
        CREATE TABLE manuscript_route_cache (
          name                  TEXT PRIMARY KEY,
          file_path             TEXT NOT NULL UNIQUE,
          route                 TEXT NOT NULL,
          project_uid           TEXT,
          project_instance_id   TEXT,
          route_journal         TEXT,
          projection_generation INTEGER NOT NULL,
          last_modified         TEXT NOT NULL
        );
        CREATE TABLE manuscript_route_cache_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }
    config.prepare('DELETE FROM manuscript_route_cache').run();
    const insert = config.prepare(`
      INSERT INTO manuscript_route_cache (
        name, file_path, route, project_uid, project_instance_id,
        route_journal, projection_generation, last_modified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const record of truth.records) {
      insert.run(
        record.name,
        record.filePath,
        record.route,
        record.projectUid,
        record.projectInstanceId,
        record.routeJournal,
        record.projectionGeneration,
        record.lastModified,
      );
    }
    config.prepare(`
      INSERT OR REPLACE INTO manuscript_route_cache_meta (key, value)
      VALUES ('truth_digest', ?)
    `).run(truth.digest);
  })();
  config.flush();
  return truth.records;
}

function rebuildConfigCache() {
  if (arguments.length !== 0) {
    throw new TypeError('rebuildConfigCache does not accept caller route facts');
  }
  const truth = captureProjectRouteTruth();
  try {
    cachedProjectRouteRecords();
  } catch {
    return publishConfigCache(truth, true);
  }
  return publishConfigCache(truth);
}

function listProjectRouteCache() {
  const truth = captureProjectRouteTruth();
  let cached;
  try {
    cached = cachedProjectRouteRecords();
  } catch {
    return publishConfigCache(truth, true);
  }
  if (
    cached.digest !== truth.digest
    || !sameProjectRouteRecords(cached.records, truth.records)
  ) return publishConfigCache(truth);
  return cached.records;
}

function createFilesManuscriptDatabasePort() {
  if (!SQL || storagePaths === null) {
    throw projectDatabaseError('RECOVERY_REQUIRED', 'Database must be initialized before files runtime construction');
  }
  const entries = new Map();
  const fullRefreshReceiptRecords = new WeakMap();
  const fullRefreshReceiptOwner = Object.freeze({});
  let closed = false;

  function assertOpen() {
    if (closed) throw projectDatabaseError('RECOVERY_REQUIRED', 'Files database port is closed');
    assertStorageAvailable();
  }

  function captureFullRefreshTarget(input) {
    if (
      input === null
      || typeof input !== 'object'
      || Array.isArray(input)
      || isProxy(input)
    ) throw new TypeError('inspectFullRefreshTarget input must be a plain data object');
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('inspectFullRefreshTarget input must be a plain data object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    const target = descriptors.target;
    if (
      keys.length !== 1
      || keys[0] !== 'target'
      || target?.enumerable !== true
      || !Object.hasOwn(target, 'value')
    ) {
      throw new TypeError(
        'inspectFullRefreshTarget input.target must be one exact enumerable data property',
      );
    }
    return target.value;
  }

  function mintFullRefreshReceipt(entry, innerReceipt, target) {
    const authority = Object.freeze(function fullRefreshDatabaseReceipt() {});
    fullRefreshReceiptRecords.set(authority, {
      activeTurn: entry.activeTurn,
      consumed: false,
      entry,
      innerReceipt,
      owner: fullRefreshReceiptOwner,
      target,
    });
    return authority;
  }

  function buildCreationCandidate(input) {
    assertOpen();
    const {
      buildSchema12Candidate,
      installSchema11Contract,
    } = require('./native/durability-schema');
    const finalPath = input.directoryPlan.finalDatabasePath;
    const parent = path.dirname(finalPath);
    const publicSourcePath = path.join(
      parent,
      `${input.creationId}.creation-source.mythpen.db`,
    );
    const sourcePath = path.join(parent, `${input.creationId}.schema11-source`);
    const candidatePath = `${finalPath}.candidate-${input.creationId}`;
    for (const target of [finalPath, publicSourcePath, sourcePath, candidatePath]) {
      if (fs.existsSync(target)) {
        throw projectDatabaseError('RECOVERY_REQUIRED', `Creation database path is occupied: ${target}`);
      }
    }
    const source = openProjectDb(publicSourcePath);
    try {
      const replaceMeta = source.prepare(
        'INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)',
      );
      replaceMeta.run('project_instance_id', input.target.projectInstanceId);
      replaceMeta.run('name', input.projectMetadata.name);
      replaceMeta.run('mode', input.projectMetadata.mode);
      replaceMeta.run('language', input.projectMetadata.language);
      source.prepare('DELETE FROM project_genres').run();
      const insertGenre = source.prepare('INSERT INTO project_genres (genre) VALUES (?)');
      for (const genre of input.projectMetadata.genres) insertGenre.run(genre);
      source.flush();
    } finally {
      closeProjectDb(publicSourcePath);
    }
    fs.renameSync(publicSourcePath, sourcePath);
    fsyncFile(sourcePath);
    fsyncDirectory(parent);
    const { Database } = require('bun:sqlite');
    const nativeSource = new Database(sourcePath, { create: false, strict: true });
    try {
      installSchema11Contract(nativeSource);
    } finally {
      nativeSource.clearQueryCache();
      Bun.gc(true);
      nativeSource.close(true);
    }
    fsyncFile(sourcePath);
    fsyncDirectory(parent);
    const built = buildSchema12Candidate(Object.freeze({
      sourcePath,
      candidatePath,
      creationId: input.creationId,
      sourceKind: input.sourceKind,
      transitionKind: input.transitionKind,
      target: input.target,
    }));
    const stats = fs.lstatSync(parent, { bigint: true });
    return Object.freeze({
      candidatePath: built.candidatePath,
      candidateIdentity: built.candidateIdentity,
      candidateSha256: built.candidateSha256,
      finalPath,
      finalParentIdentity: Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) }),
      finalCommitSeq: built.finalCommitSeq,
      transitionProofDigest: built.transitionProofDigest,
    });
  }

  function activateCreation(input) {
    assertOpen();
    const { installCreatedProjectDatabase } = require('./native/native-project-store');
    return installCreatedProjectDatabase({ creationCas: input.creationCas });
  }

  function admissionUid(admission) {
    const { verifyActivatedSchema12Admission } = require('./manuscript/runtime');
    return verifyActivatedSchema12Admission(admission).databaseFacts.projectUid;
  }

  function findFilesPath(projectUid) {
    let match = null;
    for (const item of fs.readdirSync(getStoragePaths().projectsDir, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith(PROJECT_DATABASE_SUFFIX)) continue;
      const filePath = path.join(getStoragePaths().projectsDir, item.name);
      const identity = assertMythpenProjectIdentity(filePath);
      if (identity.route !== 'files') continue;
      if (identity.admission.databaseFacts.projectUid !== projectUid) continue;
      if (match !== null) {
        throw projectDatabaseError('RECOVERY_REQUIRED', 'Project UID resolves to multiple files databases');
      }
      match = Object.freeze({ admission: identity.admission, filePath });
    }
    if (match === null) throw projectDatabaseError('PROJECT_NOT_FOUND', 'Files project UID is not registered');
    return match;
  }

  function locate(admission) {
    assertOpen();
    const projectUid = admissionUid(admission);
    const cached = entries.get(projectUid);
    if (cached !== undefined) return cached;
    const found = findFilesPath(projectUid);
    if (
      found.admission.databaseFacts.projectInstanceId
        !== admission.databaseFacts.projectInstanceId
      || found.admission.databaseFacts.routeJournal !== admission.databaseFacts.routeJournal
      || found.admission.databaseFacts.projectionGeneration
        !== admission.databaseFacts.projectionGeneration
    ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Files admission changed before database open');
    const {
      createProofBoundSchema12ProjectStore,
    } = require('./native/native-project-store');
    const nativeStore = createProofBoundSchema12ProjectStore({
      admission: found.admission,
      databasePath: found.filePath,
      assertWriterLease: () => projectWriteCoordinator.assertProjectWriteLease(found.filePath),
    });
    const queryDb = Object.freeze({
      prepare(sql) {
        return Object.freeze({
          all(...params) { return nativeStore.readAll(sql, ...params); },
          get(...params) { return nativeStore.readGet(sql, ...params); },
        });
      },
    });
    const entry = {
      activeTurn: null,
      admission: found.admission,
      filePath: found.filePath,
      nativeStore,
      queryDb,
      tail: Promise.resolve(),
      projectStore: null,
    };
    entry.projectStore = Object.freeze({
      publishProjectionTarget(input) {
        return projectWriteCoordinator.withProjectLogicalRequestSync(
          found.filePath,
          () => nativeStore.publishProjectionTarget(input),
        );
      },
    });
    entries.set(projectUid, entry);
    return entry;
  }

  function routeForName(projectName) {
    const route = inspectProjectManuscriptRoute(projectName);
    if (route.route === 'files') locate(route);
    return route;
  }

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }

  function captureProjection(admission) {
    const entry = locate(admission);
    const generation = Number(entry.nativeStore.readGet(
      "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
    )?.value);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Projection generation is invalid');
    }
    const volumes = entry.nativeStore.readAll(`
      SELECT id, volume_uid, sort_order, is_present, deleted_at
      FROM volumes ORDER BY id
    `).map((row) => Object.freeze({
      id: row.id,
      uid: row.volume_uid,
      sortOrder: row.sort_order,
      isPresent: row.is_present,
      deletedAt: row.deleted_at,
    }));
    const chapters = entry.nativeStore.readAll(`
      SELECT id, chapter_uid, volume_id, num, is_present, deleted_at,
             chapter_position, manuscript_position, body_raw_sha256, status
      FROM chapters ORDER BY id
    `).map((row) => Object.freeze({
      id: row.id,
      uid: row.chapter_uid,
      volumeId: row.volume_id,
      num: row.num,
      isPresent: row.is_present,
      deletedAt: row.deleted_at,
      chapterPosition: row.chapter_position,
      manuscriptPosition: row.manuscript_position,
      bodyRawSha256: row.body_raw_sha256,
      status: row.status,
    }));
    const sqliteSequence = entry.nativeStore.readAll(`
      SELECT name, seq FROM sqlite_sequence
      WHERE name IN ('chapters', 'volumes') ORDER BY name
    `).map((row) => Object.freeze({ name: row.name, seq: row.seq }));
    for (const name of ['chapters', 'volumes']) {
      if (!sqliteSequence.some((row) => row.name === name)) {
        sqliteSequence.push(Object.freeze({ name, seq: 0 }));
      }
    }
    sqliteSequence.sort((left, right) => Buffer.compare(
      Buffer.from(left.name, 'utf8'),
      Buffer.from(right.name, 'utf8'),
    ));
    const ignoredLedger = entry.nativeStore.readAll(`
      SELECT resource_kind, resource_uid, ignore_status, opaque_container_kind,
             opaque_container_uid, is_currently_referenced, member_snapshot_json,
             projection_generation
      FROM manuscript_ignored_resources
      ORDER BY resource_kind, resource_uid
    `).map((row) => Object.freeze({ ...row }));
    const pendingProposals = entry.nativeStore.readAll(`
      SELECT id AS revisionId, chapter_id AS chapterId
      FROM chapter_revisions WHERE status = 'pending' ORDER BY id
    `).map((row) => Object.freeze({ ...row }));
    const {
      canonicalIgnoredLedgerDigest,
      canonicalProjectionBasisDigest,
    } = require('./manuscript/projection-store');
    const basis = {
      domain: 'mythpen.manuscript.projection-basis',
      version: 1,
      sourceKind: 'schema12',
      baseGeneration: generation,
      volumes,
      chapters,
      sqliteSequence,
      ignoredBeforeDigest: canonicalIgnoredLedgerDigest(ignoredLedger),
      pendingProposals,
      basisDigest: '0'.repeat(64),
    };
    basis.basisDigest = canonicalProjectionBasisDigest(basis);
    return deepFreeze({
      currentProjection: {
        projectUid: entry.admission.databaseFacts.projectUid,
        projectInstanceId: entry.admission.databaseFacts.projectInstanceId,
        basis,
      },
      ignoredLedger,
    });
  }

  function migrationFileIdentity(filePath) {
    const stats = fs.lstatSync(filePath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration source is not one plain single-link file');
    }
    return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
  }

  function sameMigrationIdentity(left, right) {
    return left?.dev === right?.dev && left?.ino === right?.ino;
  }

  function migrationSha256(filePath) {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  function closeCachedMigrationSource(filePath) {
    const cacheKey = canonicalDbPath(filePath);
    const cached = projectConnections.get(cacheKey);
    if (!cached) return;
    cached._flushInProjectWrite();
    cached.close();
    projectConnections.delete(cacheKey);
  }

  function closeNativeDatabase(database) {
    database.clearQueryCache();
    Bun.gc(true);
    database.close(true);
  }

  function captureMigrationSource(projectName) {
    assertOpen();
    if (typeof projectName !== 'string' || projectName.length === 0) {
      throw new TypeError('Migration projectName is required');
    }
    const sourcePath = getProjectDbPath(projectName);
    return projectWriteCoordinator.withProjectWriteSync(sourcePath, () => {
      closeCachedMigrationSource(sourcePath);
      const pathState = assertControlledProjectDatabasePath(sourcePath);
      const identity = assertMythpenProjectIdentity(pathState.filePath);
      if (identity.schema !== 11 || identity.route !== undefined) {
        throw projectDatabaseError('RECOVERY_REQUIRED', 'Files migration requires an exact admitted schema11 source');
      }
      const sourceIdentity = migrationFileIdentity(pathState.filePath);
      const sourceSha256 = migrationSha256(pathState.filePath);
      const { Database } = require('bun:sqlite');
      const database = new Database(pathState.filePath, {
        create: false,
        readonly: true,
        strict: true,
      });
      let captured;
      try {
        const committedText = database.query(
          "SELECT value FROM project_meta WHERE key = 'durability_commit_seq'",
        ).get()?.value;
        if (typeof committedText !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(committedText)) {
          throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration source commit sequence is not canonical');
        }
        const committedSeq = Number(committedText);
        if (!Number.isSafeInteger(committedSeq) || committedSeq < 0) {
          throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration source commit sequence is unsafe');
        }
        inspectSchema11Contract(database, { expectedFinalSeq: committedSeq });
        const projectInstanceId = database.query(
          "SELECT value FROM project_meta WHERE key = 'project_instance_id'",
        ).get()?.value;
        const volumes = database.query(`
          SELECT id, sort_order, title, summary FROM volumes ORDER BY id
        `).all().map((row) => Object.freeze({
          id: row.id,
          sortOrder: row.sort_order,
          title: row.title ?? '',
          summary: row.summary ?? '',
        }));
        const chapters = database.query(`
          SELECT id, volume_id, num, title, outline, content, summary, status,
                 cognitive_frame, emotional_anchor, world_texture, concrete_mystery,
                 interpersonal_tension
          FROM chapters ORDER BY id
        `).all().map((row) => Object.freeze({
          id: row.id,
          volumeId: row.volume_id ?? null,
          num: row.num,
          title: row.title ?? '',
          outline: row.outline ?? '',
          content: row.content ?? '',
          summary: row.summary ?? '',
          status: row.status,
          cognitiveFrame: row.cognitive_frame ?? '',
          emotionalAnchor: row.emotional_anchor ?? '',
          worldTexture: row.world_texture ?? '',
          concreteMystery: row.concrete_mystery ?? '',
          interpersonalTension: row.interpersonal_tension ?? '',
        }));
        const basisVolumes = volumes.map((row) => Object.freeze({
          id: row.id,
          sortOrder: row.sortOrder,
        }));
        const basisChapters = chapters.map((row) => Object.freeze({
          id: row.id,
          volumeId: row.volumeId,
          num: row.num,
          bodyRawSha256: createHash('sha256').update(Buffer.from(row.content, 'utf8')).digest('hex'),
          status: row.status,
        }));
        const sqliteSequence = database.query(`
          SELECT name, seq FROM sqlite_sequence
          WHERE name IN ('chapters', 'volumes') ORDER BY name
        `).all().map((row) => ({ name: row.name, seq: row.seq }));
        for (const [name, rows] of [['chapters', basisChapters], ['volumes', basisVolumes]]) {
          if (!sqliteSequence.some((row) => row.name === name)) {
            sqliteSequence.push({
              name,
              seq: rows.reduce((maximum, row) => Math.max(maximum, row.id), 0),
            });
          }
        }
        sqliteSequence.sort((left, right) => Buffer.compare(
          Buffer.from(left.name, 'utf8'),
          Buffer.from(right.name, 'utf8'),
        ));
        const pendingProposals = database.query(`
          SELECT id AS revisionId, chapter_id AS chapterId
          FROM chapter_revisions WHERE status = 'pending' ORDER BY id
        `).all().map((row) => Object.freeze({ ...row }));
        const {
          canonicalIgnoredLedgerDigest,
          canonicalProjectionBasisDigest,
        } = require('./manuscript/projection-store');
        const sourceBasis = {
          domain: 'mythpen.manuscript.projection-basis',
          version: 1,
          sourceKind: 'schema11',
          baseGeneration: 0,
          volumes: basisVolumes,
          chapters: basisChapters,
          sqliteSequence,
          ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
          pendingProposals,
          basisDigest: '0'.repeat(64),
        };
        sourceBasis.basisDigest = canonicalProjectionBasisDigest(sourceBasis);
        captured = deepFreeze({
          projectInstanceId,
          projectName,
          sourceBasis,
          sourceIdentity,
          sourcePath: pathState.filePath,
          sourceSha256,
          volumes,
          chapters,
        });
      } finally {
        closeNativeDatabase(database);
      }
      if (
        !sameMigrationIdentity(migrationFileIdentity(pathState.filePath), sourceIdentity)
        || migrationSha256(pathState.filePath) !== sourceSha256
      ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration source changed during read-only capture');
      return captured;
    });
  }

  function assertMigrationSource(source) {
    const pathState = assertControlledProjectDatabasePath(source.sourcePath);
    const identity = assertMythpenProjectIdentity(pathState.filePath);
    if (
      identity.schema !== 11
      || !sameMigrationIdentity(migrationFileIdentity(pathState.filePath), source.sourceIdentity)
      || migrationSha256(pathState.filePath) !== source.sourceSha256
    ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration source differs from its read-only capture');
    return pathState.filePath;
  }

  function migrationControlStore(input) {
    const directory = path.join(
      getStoragePaths().dataDir,
      'control',
      'manuscripts',
      input.projectUid,
      input.projectInstanceId,
    );
    return openControlStore(directory);
  }

  function fenceMigrationSource(input) {
    assertOpen();
    const sourcePath = input.source.sourcePath;
    return projectWriteCoordinator.withProjectWriteSync(sourcePath, () => {
      closeCachedMigrationSource(sourcePath);
      assertMigrationSource(input.source);
      const controlStore = migrationControlStore(input);
      const payload = deepFreeze({
        version: 1,
        migrationId: input.migrationId,
        projectUid: input.projectUid,
        projectInstanceId: input.projectInstanceId,
        sourcePath,
        sourceIdentity: input.source.sourceIdentity,
        sourceSha256: input.source.sourceSha256,
        directoryPlan: input.directoryPlan,
      });
      const existing = controlStore.read().filter((event) => (
        event.type === MIGRATION_ROUTE_FENCE_EVENT
        && event.payload?.migrationId === input.migrationId
      ));
      let appended;
      if (existing.length === 0) {
        appended = controlStore.compareAndAppend(controlStore.tail()?.digest ?? null, {
          type: MIGRATION_ROUTE_FENCE_EVENT,
          payload,
        });
      } else if (existing.length === 1 && JSON.stringify(existing[0].payload) === JSON.stringify(payload)) {
        appended = existing[0];
      } else {
        throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration route fence is duplicated or rebound');
      }
      assertMigrationSource(input.source);
      return deepFreeze({
        disposition: 'after',
        directoryPlan: input.directoryPlan,
        eventDigest: appended.digest,
      });
    });
  }

  function inspectMigrationRouteFence(input) {
    const controlStore = migrationControlStore(input);
    const events = controlStore.read().filter((event) => (
      event.type === MIGRATION_ROUTE_FENCE_EVENT
      && event.payload?.migrationId === input.migrationId
    ));
    if (events.length === 0) return Object.freeze({ disposition: 'before' });
    if (events.length !== 1) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration route fence evidence is ambiguous');
    }
    const payload = events[0].payload;
    if (
      payload.sourcePath !== input.source.sourcePath
      || payload.sourceSha256 !== input.source.sourceSha256
      || !sameMigrationIdentity(payload.sourceIdentity, input.source.sourceIdentity)
    ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration route fence evidence changed');
    return deepFreeze({
      disposition: 'after',
      directoryPlan: payload.directoryPlan,
      eventDigest: events[0].digest,
    });
  }

  function buildMigrationCandidate(input) {
    assertOpen();
    assertMigrationSource(input.sourceSnapshot);
    const candidatePath = `${input.sourceSnapshot.sourcePath}.candidate-${input.migrationId}`;
    if (fs.existsSync(candidatePath)) {
      throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration candidate path is already occupied');
    }
    const { buildSchema12Candidate } = require('./native/durability-schema');
    const built = buildSchema12Candidate(Object.freeze({
      sourcePath: input.sourceSnapshot.sourcePath,
      candidatePath,
      migrationId: input.migrationId,
      target: input.target,
    }));
    assertMigrationSource(input.sourceSnapshot);
    const transitionProofDigest = createHash('sha256').update(JSON.stringify({
      domain: 'mythpen.manuscript.schema12-migration-candidate-proof',
      version: 1,
      migrationId: input.migrationId,
      projectUid: input.target.projectUid,
      projectInstanceId: input.target.projectInstanceId,
      baseGeneration: input.target.baseGeneration,
      targetGeneration: input.target.targetGeneration,
      sourceSha256: input.sourceSnapshot.sourceSha256,
      candidateSha256: built.candidateSha256,
    })).digest('hex');
    return deepFreeze({
      sourcePath: input.sourceSnapshot.sourcePath,
      sourceIdentity: input.sourceSnapshot.sourceIdentity,
      sourceSha256: input.sourceSnapshot.sourceSha256,
      candidatePath: built.candidatePath,
      candidateDigest: built.candidateSha256,
      candidateIdentity: built.candidateIdentity,
      transitionProofDigest,
    });
  }

  function activateMigration(input) {
    assertOpen();
    const sourcePath = input.databaseCandidate.sourcePath;
    return projectWriteCoordinator.withProjectLogicalRequestSync(sourcePath, () => {
      closeCachedMigrationSource(sourcePath);
      assertMigrationSource(input.databaseCandidate);
      if (!nativeActivationController || nativeActivationAdmissionMode() === null) {
        throw projectDatabaseError('NATIVE_ACTIVATION_DISABLED', 'Migration source native store is unavailable');
      }
      const dbKey = createHash('sha256').update(canonicalDbPath(sourcePath)).digest('hex');
      const controlDirectory = recoveryControlDirectory(sourcePath);
      const controlStore = openControlStore(controlDirectory);
      const nativeStore = nativeActivationController.activate({
        assertConfigLifecycleLease: () => configLifecycleLease.assertHeld(),
        assertWriterLease: () => projectWriteCoordinator.assertProjectWriteLease(sourcePath),
        controlDirectory,
        controlStore,
        databasePath: sourcePath,
        dbKey,
        sqlModule: SQL,
      });
      try {
        const result = nativeStore.publishProjectionTarget({
          target: input.target,
          routeCas: input.routeCas,
        });
        if (result?.disposition !== 'after') {
          throw projectDatabaseError('RECOVERY_REQUIRED', 'Migration database activation is not after');
        }
        return result;
      } finally {
        if (nativeStore.state === 'active') nativeStore.close();
      }
    });
  }

  function inspectMigrationActivation(input) {
    assertOpen();
    const sourcePath = input.sourcePath;
    assertControlledProjectDatabasePath(sourcePath);
    const { Database } = require('bun:sqlite');
    const database = new Database(sourcePath, { create: false, readonly: true, strict: true });
    try {
      const committedText = database.query(
        "SELECT value FROM project_meta WHERE key = 'durability_commit_seq'",
      ).get()?.value;
      if (typeof committedText !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(committedText)) {
        throw projectDatabaseError('RECOVERY_REQUIRED', 'Activated migration commit sequence is invalid');
      }
      const contract = inspectSchema12Contract(database, { expectedFinalSeq: Number(committedText) });
      if (
        contract.route !== 'files'
        || contract.manuscriptProjectUid !== input.projectUid
        || contract.projectInstanceId !== input.projectInstanceId
        || contract.routeJournal !== input.migrationId
        || contract.projectionGeneration !== input.targetGeneration
      ) throw projectDatabaseError('RECOVERY_REQUIRED', 'Activated migration schema12 binding differs');
      return deepFreeze({
        disposition: 'after',
        generation: contract.projectionGeneration,
        route: contract.route,
      });
    } finally {
      closeNativeDatabase(database);
    }
  }

  return Object.freeze({
    activateCreation,
    activateMigration,
    buildCreationCandidate,
    buildMigrationCandidate,
    captureMigrationSource,
    fenceMigrationSource,
    inspectMigrationActivation,
    inspectMigrationRouteFence,
    verifyMigrationSource(source) {
      assertOpen();
      assertMigrationSource(source);
      return true;
    },
    listFilesAdmissions() {
      assertOpen();
      const admissions = [];
      for (const item of fs.readdirSync(getStoragePaths().projectsDir, { withFileTypes: true })) {
        if (!item.isFile() || !item.name.endsWith(PROJECT_DATABASE_SUFFIX)) continue;
        const identity = assertMythpenProjectIdentity(
          path.join(getStoragePaths().projectsDir, item.name),
        );
        if (identity.route === 'files') admissions.push(identity.admission);
      }
      return Object.freeze(admissions);
    },
    enumerateUidRecords(scope) {
      assertOpen();
      if (
        scope === null
        || typeof scope !== 'object'
        || !['project', 'chapter', 'volume'].includes(scope.objectKind)
      ) throw new TypeError('UID source scope is invalid');
      const records = [];
      for (const item of fs.readdirSync(getStoragePaths().projectsDir, { withFileTypes: true })) {
        if (!item.isFile() || !item.name.endsWith(PROJECT_DATABASE_SUFFIX)) continue;
        const filePath = path.join(getStoragePaths().projectsDir, item.name);
        const identity = assertMythpenProjectIdentity(filePath);
        if (identity.route !== 'files') continue;
        const admission = identity.admission;
        const uid = admission.databaseFacts.projectUid;
        if (scope.objectKind === 'project') {
          records.push(Object.freeze({
            ownerKind: 'registry',
            ownerId: filePath,
            reservationId: createHash('sha256').update(`registry:project:${uid}`).digest('hex'),
            uid,
          }));
          continue;
        }
        if (scope.projectUid !== null && scope.projectUid !== uid) continue;
        const entry = locate(admission);
        const table = scope.objectKind === 'chapter' ? 'chapters' : 'volumes';
        const column = scope.objectKind === 'chapter' ? 'chapter_uid' : 'volume_uid';
        for (const row of entry.nativeStore.readAll(
          `SELECT ${column} AS uid FROM ${table} WHERE ${column} IS NOT NULL ORDER BY ${column}`,
        )) {
          records.push(Object.freeze({
            ownerKind: 'registry',
            ownerId: filePath,
            reservationId: createHash('sha256')
              .update(`registry:${scope.objectKind}:${row.uid}`)
              .digest('hex'),
            uid: row.uid,
          }));
        }
      }
      return Object.freeze({
        complete: true,
        projectUid: scope.projectUid,
        projectInstanceId: scope.projectInstanceId,
        objectKind: scope.objectKind,
        records: Object.freeze(records),
      });
    },
    admit(projectSelector) {
      assertOpen();
      if (typeof projectSelector === 'string') return routeForName(projectSelector);
      if (projectSelector?.projectName !== undefined) {
        return routeForName(projectSelector.projectName);
      }
      if (projectSelector?.projectUid !== undefined) {
        return findFilesPath(projectSelector.projectUid).admission;
      }
      return Object.freeze({ route: 'sqlite' });
    },
    read(admission, callback) {
      if (typeof callback !== 'function') throw new TypeError('files read callback is required');
      return callback(locate(admission).queryDb);
    },
    captureProjection,
    filePath(admission) { return locate(admission).filePath; },
    projectStore(admission) { return locate(admission).projectStore; },
    inspectProjectionTarget(admission, input) {
      return locate(admission).nativeStore.inspectProjectionTarget(input);
    },
    applyAuxiliaryAction(admission, input) {
      const entry = locate(admission);
      if (entry.activeTurn === null) {
        throw projectDatabaseError(
          'RECOVERY_REQUIRED',
          'Auxiliary action is outside its admitted writer turn',
        );
      }
      return projectWriteCoordinator.withProjectLogicalRequestSync(
        entry.filePath,
        () => entry.nativeStore.applyAuxiliaryAction(input),
      );
    },
    inspectFullRefreshTarget(admission, input) {
      const entry = locate(admission);
      if (entry.activeTurn === null) {
        throw projectDatabaseError(
          'RECOVERY_REQUIRED',
          'Full refresh inspection is outside its admitted writer turn',
        );
      }
      const target = captureFullRefreshTarget(input);
      return projectWriteCoordinator.withProjectLogicalRequestSync(
        entry.filePath,
        () => mintFullRefreshReceipt(
          entry,
          entry.nativeStore.inspectFullRefreshTarget(Object.freeze({ target })),
          target,
        ),
      );
    },
    describeFullRefreshDisposition(admission, authority) {
      assertOpen();
      const record = (
        (typeof authority === 'object' || typeof authority === 'function')
        && authority !== null
      ) ? fullRefreshReceiptRecords.get(authority) : undefined;
      if (record?.owner !== fullRefreshReceiptOwner) {
        throw new TypeError('full refresh disposition authority is foreign');
      }
      const entry = locate(admission);
      if (record.entry !== entry) {
        throw new TypeError('full refresh disposition authority is foreign');
      }
      if (entry.activeTurn === null || record.activeTurn !== entry.activeTurn) {
        throw new TypeError('full refresh disposition authority belongs to another writer turn');
      }
      if (record.consumed) {
        throw new TypeError('full refresh disposition authority is already consumed');
      }
      record.consumed = true;
      return entry.nativeStore.describeFullRefreshDisposition(
        record.innerReceipt,
        record.target,
      );
    },
    async withWriterTurn(admission, callback) {
      if (typeof callback !== 'function') throw new TypeError('writer callback is required');
      const entry = locate(admission);
      const previous = entry.tail;
      let release;
      entry.tail = new Promise((resolve) => { release = resolve; });
      await previous;
      const turn = Object.freeze({ projectUid: entry.admission.databaseFacts.projectUid });
      entry.activeTurn = turn;
      try {
        return await callback(turn);
      } finally {
        entry.activeTurn = null;
        release();
      }
    },
    assertWriterTurn(admission, turn) {
      const entry = locate(admission);
      if (entry.activeTurn !== turn) {
        throw projectDatabaseError('RECOVERY_REQUIRED', 'Files writer turn is not active');
      }
      return true;
    },
    recover(admission) { return locate(admission).nativeStore.recover(); },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) entry.nativeStore.close();
      entries.clear();
    },
  });
}

function manuscriptTransactionRequired(message = 'An active owned project transaction is required') {
  const error = new Error(message);
  error.code = 'MANUSCRIPT_TRANSACTION_REQUIRED';
  return error;
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function validateManuscriptSourceEvent(event) {
  const payloadKeys = [
    'bodyBytes',
    'bodySha256',
    'chapterId',
    'chapterNumber',
    'expectedBodySha256',
    'expectedDataVersion',
    'operation',
    'source',
    'version',
    'volumeId',
  ];
  const nullablePositiveInteger = (value) => value === null || (Number.isSafeInteger(value) && value > 0);
  const nullableHash = (value) => value === null || /^[0-9a-f]{64}$/.test(value);
  if (
    !hasExactKeys(event, ['payload', 'type'])
    || event.type !== 'manuscript.body_mutation.attempt'
    || !hasExactKeys(event.payload, payloadKeys)
    || event.payload.version !== 1
    || !new Set(['replace', 'append', 'create']).has(event.payload.operation)
    || !new Set(['rest', 'ai_tool', 'ai_continue', 'revision_accept']).has(event.payload.source)
    || !nullablePositiveInteger(event.payload.chapterId)
    || !nullablePositiveInteger(event.payload.chapterNumber)
    || !nullablePositiveInteger(event.payload.volumeId)
    || !(event.payload.expectedDataVersion === null
      || (Number.isSafeInteger(event.payload.expectedDataVersion) && event.payload.expectedDataVersion >= 0))
    || !nullableHash(event.payload.expectedBodySha256)
    || !/^[0-9a-f]{64}$/.test(event.payload.bodySha256)
    || !Number.isSafeInteger(event.payload.bodyBytes)
    || event.payload.bodyBytes < 0
  ) {
    const error = new TypeError('Manuscript source event must use the exact diagnostic-only schema');
    error.code = 'MANUSCRIPT_SOURCE_EVENT_INVALID';
    throw error;
  }
  return event;
}

function assertManuscriptProjectConnection(projectName, projectDb) {
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw manuscriptTransactionRequired('Project identity is required for a manuscript transaction');
  }
  const filePath = getProjectDbPath(projectName);
  const cacheKey = canonicalDbPath(filePath);
  if (projectConnections.get(cacheKey) !== projectDb) {
    throw manuscriptTransactionRequired('The manuscript transaction connection does not own this project');
  }
  return { cacheKey, filePath };
}

function activeManuscriptTransaction(projectName, projectDb) {
  const { filePath } = assertManuscriptProjectConnection(projectName, projectDb);
  const token = projectTransactionOwners.get(projectDb);
  const store = storesByWrapper.get(projectDb);
  if (
    !token
    || !store
    || token.connection !== projectDb
    || canonicalDbPath(token.filePath) !== canonicalDbPath(filePath)
    || token.connectionEpoch !== store.connectionEpoch
    || token.coordinatorOwnershipToken !== token.writeContext?.ownershipToken
  ) {
    throw manuscriptTransactionRequired();
  }
  projectWriteCoordinator.assertProjectWriteLease(filePath);
  token.writeContext.assertLease();
  return token;
}

function validateManuscriptClaimScope(scope) {
  const keys = ['chapterId', 'chapterNumber', 'operation', 'source', 'volumeId'];
  const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
  if (
    !hasExactKeys(scope, keys)
    || !new Set(['replace', 'append', 'create']).has(scope.operation)
    || !new Set(['rest', 'ai_tool', 'ai_continue', 'revision_accept']).has(scope.source)
  ) {
    throw manuscriptTransactionRequired('Manuscript authorization scope is missing or invalid');
  }
  if (scope.operation === 'create') {
    if (scope.chapterId !== null || !positiveInteger(scope.chapterNumber) || !positiveInteger(scope.volumeId)) {
      throw manuscriptTransactionRequired('Create authorization must identify one volume and chapter number');
    }
  } else if (!positiveInteger(scope.chapterId) || scope.chapterNumber !== null || scope.volumeId !== null) {
    throw manuscriptTransactionRequired('Body authorization must identify one chapter');
  }
  return Object.freeze({ ...scope });
}

function manuscriptEventMatchesScope(event, scope) {
  return event.payload.operation === scope.operation
    && event.payload.source === scope.source
    && event.payload.chapterId === scope.chapterId
    && event.payload.chapterNumber === scope.chapterNumber
    && event.payload.volumeId === scope.volumeId;
}

const manuscriptTransactionCapability = Object.freeze({
  assertActive(projectName, projectDb) {
    if (projectDb?.manuscriptTransactionCapability) {
      return projectDb.manuscriptTransactionCapability.assertActive(projectName, projectDb);
    }
    activeManuscriptTransaction(projectName, projectDb);
    return true;
  },

  claim(projectName, projectDb, scope) {
    if (projectDb?.manuscriptTransactionCapability) {
      return projectDb.manuscriptTransactionCapability.claim(projectName, projectDb, scope);
    }
    const active = activeManuscriptTransaction(projectName, projectDb);
    const store = storesByWrapper.get(projectDb);
    const claim = Object.freeze(Object.create(null));
    manuscriptClaims.set(claim, {
      active,
      connectionEpoch: store.connectionEpoch,
      projectDb,
      scope: validateManuscriptClaimScope(scope),
    });
    return claim;
  },

  appendSourceEvent(projectName, projectDb, claim, event) {
    if (projectDb?.manuscriptTransactionCapability) {
      return projectDb.manuscriptTransactionCapability.appendSourceEvent(
        projectName,
        projectDb,
        claim,
        event,
      );
    }
    const descriptor = manuscriptClaims.get(claim);
    manuscriptClaims.delete(claim);
    const active = activeManuscriptTransaction(projectName, projectDb);
    const store = storesByWrapper.get(projectDb);
    if (
      !descriptor
      || descriptor.active !== active
      || descriptor.projectDb !== projectDb
      || descriptor.connectionEpoch !== store.connectionEpoch
    ) {
      throw manuscriptTransactionRequired('Manuscript authorization is stale, consumed, or forged');
    }
    validateManuscriptSourceEvent(event);
    if (!manuscriptEventMatchesScope(event, descriptor.scope)) {
      throw manuscriptTransactionRequired('Manuscript authorization does not match the source or target');
    }
    if (manuscriptSqlAuthorizations.has(projectDb)) {
      throw manuscriptTransactionRequired('A manuscript SQL authorization is already pending');
    }
    const controlStore = controlStoresByAtomicStore.get(store);
    if (!controlStore) throw manuscriptTransactionRequired('The project transaction has no managed control store');
    active.writeContext.assertLease();
    const result = controlStore.append(event);
    active.writeContext.assertLease();
    manuscriptSqlAuthorizations.set(projectDb, Object.freeze({
      active,
      connectionEpoch: store.connectionEpoch,
      scope: descriptor.scope,
    }));
    return result;
  },
});

function runManuscriptTransaction(projectName, intent, callback) {
  if (callback === undefined && typeof intent === 'function') {
    callback = intent;
    intent = null;
  }
  if (typeof projectName !== 'string' || projectName.length === 0) {
    throw manuscriptTransactionRequired('Project identity is required for a manuscript transaction');
  }
  if (typeof callback !== 'function') throw new TypeError('Manuscript transaction callback must be a function');
  const filePath = getProjectDbPath(projectName);
  const cacheKey = canonicalDbPath(filePath);
  const cached = projectConnections.has(cacheKey)
    ? assertCachedNativeProjectAdmission(
      filePath,
      cacheKey,
      projectConnections.get(cacheKey),
    )
    : null;
  if (typeof cached?.runManuscriptTransaction === 'function') {
    return cached.runManuscriptTransaction(projectName, intent, callback);
  }
  if (!cached) {
    const evidence = inspectControlStoreEvidence(recoveryControlDirectory(filePath)).events;
    if (evidence.some((event) => event.type === 'sqlite.native.activation.activated')) {
      return getProjectDb(projectName).runManuscriptTransaction(projectName, intent, callback);
    }
  }
  return projectWriteCoordinator.withProjectWriteSync(filePath, () => {
    const projectDb = getProjectDb(projectName);
    const result = projectDb.transaction(() => callback(projectDb))();
    try {
      projectDb._flushInProjectWrite();
    } catch (error) {
      if ((typeof error === 'object' || typeof error === 'function') && error !== null) {
        manuscriptPersistenceErrors.add(error);
      }
      projectDb._settleManuscriptPublicationFailureInProjectWrite(error);
      throw error;
    }
    return result;
  });
}

function isManuscriptPersistenceError(error) {
  return (typeof error === 'object' || typeof error === 'function')
    && error !== null
    && manuscriptPersistenceErrors.has(error);
}

function assertProjectInstance(name, expectedInstanceId) {
  const projectDb = getProjectDb(name);
  validateProjectInstance(projectDb, name, expectedInstanceId);
  return projectDb;
}

// Capture the immutable incarnation at the start of a long-running request.
// Headerless legacy clients still receive the same protection: subsequent DB
// access runs under this captured token and cannot target a same-name project
// created after the request began.
function captureProjectInstance(name, expectedInstanceId = '') {
  const projectDb = getProjectDb(name);
  const actualInstanceId = readProjectInstanceId(projectDb);
  if (!actualInstanceId || (expectedInstanceId && actualInstanceId !== expectedInstanceId)) {
    throw projectInstanceMismatchError(name);
  }
  return actualInstanceId;
}

// ═══════════════════════════════════════════════════════════════
// Project DB migrations
// ═══════════════════════════════════════════════════════════════

function normalizeLegacyChapterContent(db) {
  const chapterColumns = new Set(
    db.prepare('PRAGMA table_info(chapters)').all().map((column) => column.name),
  );
  if (!chapterColumns.has('content')) return;
  projectMigrationBodyWrites.add(db);
  try {
    db.prepare("UPDATE chapters SET content = '' WHERE content IS NULL").run();
  } finally {
    projectMigrationBodyWrites.delete(db);
  }
}

const projectMigrations = [
  // v0 → v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS volumes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL,
        title     TEXT NOT NULL,
        summary   TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_id   INTEGER REFERENCES volumes(id) ON DELETE CASCADE,
        num         INTEGER NOT NULL,
        title       TEXT NOT NULL,
        outline     TEXT DEFAULT '',
        content     TEXT DEFAULT '',
        summary     TEXT DEFAULT '',
        word_count  INTEGER DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','writing','review','accepted')),
        cognitive_frame   TEXT DEFAULT '',
        emotional_anchor  TEXT DEFAULT '',
        world_texture     TEXT DEFAULT '',
        concrete_mystery  TEXT DEFAULT '',
        interpersonal_tension TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(volume_id, num)
      );
      CREATE TABLE IF NOT EXISTS characters (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        age         TEXT DEFAULT '',
        gender      TEXT DEFAULT '',
        role        TEXT NOT NULL DEFAULT 'minor' CHECK (role IN ('major','minor','extra')),
        appearance  TEXT DEFAULT '',
        personality TEXT DEFAULT '',
        background  TEXT DEFAULT '',
        motivation  TEXT DEFAULT '',
        arc         TEXT DEFAULT '',
        ext_markers TEXT DEFAULT '',
        avatar      TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chapter_characters (
        chapter_id  INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
        character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        role        TEXT DEFAULT 'appears' CHECK (role IN ('appears','speaks','pov','mentioned')),
        PRIMARY KEY (chapter_id, character_id)
      );
      CREATE TABLE IF NOT EXISTS world_entries (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags        TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS project_genres (
        genre TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS sidebar_items (
        id          TEXT PRIMARY KEY,
        label_key   TEXT NOT NULL,
        icon        TEXT NOT NULL,
        category    TEXT NOT NULL CHECK (category IN ('universal','genre','optional')),
        genres      TEXT DEFAULT '',
        sort_order  INTEGER NOT NULL,
        route       TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1
      );
      -- Seed default sidebar items
      INSERT OR IGNORE INTO sidebar_items (id, label_key, icon, category, genres, sort_order, route, enabled) VALUES
        ('dashboard',    'sidebar.dashboard',    'LayoutDashboard', 'universal', '',  1,  'page-dashboard',    1),
        ('characters',   'sidebar.characters',   'Users',           'universal', '',  2,  'page-characters',   1),
        ('world',        'sidebar.world',        'Globe',           'universal', '',  3,  'page-world',        1),
        ('science',      'sidebar.science',      'FlaskConical',    'genre', 'sci-fi',  4,  'page-science',      1),
        ('outline_page', 'sidebar.outline_page', 'ScrollText',      'universal', '',  5,  'page-outline',      1),
        ('foreshadow',   'sidebar.foreshadow',   'Link2',           'universal', '',  6,  'page-foreshadow',   1),
        ('memory',       'sidebar.memory',       'Brain',           'universal', '',  7,  'page-memory',       1),
        ('relations',    'sidebar.relations',    'HeartHandshake',  'universal', '',  8,  'page-relations',    1),
        ('timeline',     'sidebar.timeline',     'CalendarDays',    'universal', '',  9,  'page-timeline',     1),
        ('consistency',  'sidebar.consistency',  'ShieldCheck',     'universal', '',  10, 'page-consistency',  1),
        ('export',       'sidebar.export',       'Download',        'universal', '',  11, 'page-export',       1);
      CREATE TABLE IF NOT EXISTS foreshadows (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'planted' CHECK (status IN ('planted','progressing','resolved','abandoned')),
        planted_chapter_id    INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        expected_resolve_chapter INTEGER,
        resolved_chapter_id   INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        priority        TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL CHECK (category IN ('character','location','item','event','promise','other')),
        content     TEXT NOT NULL,
        source_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS character_relations (
        id              TEXT PRIMARY KEY,
        character_a_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
        character_b_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
        relation_type   TEXT NOT NULL,
        description     TEXT DEFAULT '',
        intensity       INTEGER DEFAULT 3,
        started_at      TEXT DEFAULT '',
        ended_at        TEXT DEFAULT '',
        layout_x        REAL,
        layout_y        REAL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS science_entries (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL CHECK (label IN ('known','extrapolation','hypothesis')),
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        "references"  TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS timeline_events (
        id          TEXT PRIMARY KEY,
        year        TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT DEFAULT '',
        importance  INTEGER DEFAULT 3,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS clue_board (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT DEFAULT '',
        kind            TEXT DEFAULT '' CHECK (kind IN ('clue','red-herring','deduction','question')),
        related_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        resolved        INTEGER NOT NULL DEFAULT 0,
        resolved_at     TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS token_usage (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name       TEXT NOT NULL,
        chapter_num     INTEGER,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        context_tokens  INTEGER,
        model           TEXT DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT '新对话',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('user', 'ai', 'system')),
        content     TEXT NOT NULL,
        tool_calls  TEXT DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_status ON chapters(status);
      CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id, num);
      CREATE INDEX IF NOT EXISTS idx_chapters_order ON chapters(num);
      CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);
      CREATE INDEX IF NOT EXISTS idx_foreshadows_status ON foreshadows(status);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    `);
  },
  // v1 → v2: add session_id column to chat_messages (legacy DBs) + index
  (db) => {
    try {
      db.exec("ALTER TABLE chat_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT '' REFERENCES chat_sessions(id) ON DELETE CASCADE");
    } catch (e) {
      // column already exists — ignore
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)");
    } catch (e) {
      console.warn("[DB] Migration v1→v2 (index) skipped:", e.message)
    }
  },
  // v2 → v3: persist each character's narrative role
  (db) => {
    let addedRoleColumn = false;
    try {
      db.exec("ALTER TABLE characters ADD COLUMN role TEXT NOT NULL DEFAULT 'minor' CHECK (role IN ('major','minor','extra'))");
      addedRoleColumn = true;
    } catch (e) {
      // A manually-upgraded database may already have the column. Keep its data.
      if (!/duplicate column name: role/i.test(String(e.message))) throw e;
    }

    if (!addedRoleColumn) return;

    // Preserve the previous UI's visible grouping for existing projects:
    // the first name was shown as protagonist, the next two as supporting,
    // and all remaining characters as extras.
    const characters = db.prepare('SELECT id FROM characters ORDER BY name').all();
    const updateRole = db.prepare('UPDATE characters SET role = ? WHERE id = ?');
    characters.forEach(({ id }, index) => {
      const role = index === 0 ? 'major' : index < 3 ? 'minor' : 'extra';
      updateRole.run(role, id);
    });
  },
  // v3 → v4: persist the user-controlled timeline event order
  (db) => {
    let addedSortOrderColumn = false;
    try {
      db.exec('ALTER TABLE timeline_events ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
      addedSortOrderColumn = true;
    } catch (e) {
      // A manually-upgraded database may already have the column. Keep its order.
      if (!/duplicate column name: sort_order/i.test(String(e.message))) throw e;
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_sort_order ON timeline_events(sort_order, id)');
    if (!addedSortOrderColumn) return;

    // Give existing projects a stable chronological baseline. Later migrations
    // decide whether it remains automatic or has been manually overridden.
    const events = db.prepare('SELECT id, year, title FROM timeline_events').all().sort(compareTimelineEvents);
    const updateSortOrder = db.prepare('UPDATE timeline_events SET sort_order = ? WHERE id = ?');
    db.transaction(() => {
      events.forEach(({ id }, index) => updateSortOrder.run(index + 1, id));
    })();
  },
  // v4 → v5: distinguish automatic date sorting from an author-set order
  (db) => {
    const existingMode = db.prepare("SELECT value FROM project_meta WHERE key = 'timeline_sort_mode'").get();
    if (existingMode) return;

    const currentOrder = db.prepare(
      'SELECT id, year, title FROM timeline_events ORDER BY sort_order ASC, created_at ASC, id ASC',
    ).all();
    const automaticOrder = [...currentOrder].sort(compareTimelineEvents);
    const mode = currentOrder.every((event, index) => event.id === automaticOrder[index]?.id) ? 'auto' : 'manual';
    db.prepare("INSERT INTO project_meta (key, value) VALUES ('timeline_sort_mode', ?)").run(mode);
  },
  // v5 → v6: keep AI polish proposals separate from confirmed chapter content
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chapter_revisions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id       INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        base_content     TEXT NOT NULL,
        proposed_content TEXT NOT NULL,
        decisions_json   TEXT NOT NULL DEFAULT '{}',
        status           TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chapter_revisions_active
        ON chapter_revisions(chapter_id, status, id DESC);
    `);
  },
  // v6 → v7: remember the chapter state that a pending polish temporarily replaced
  (db) => {
    try {
      db.exec(`ALTER TABLE chapter_revisions ADD COLUMN previous_chapter_status TEXT
        CHECK (previous_chapter_status IN ('pending', 'writing', 'review', 'accepted'))`);
    } catch (error) {
      if (!/duplicate column name: previous_chapter_status/i.test(String(error.message))) throw error;
    }

    const chapterColumns = new Set(
      db.prepare('PRAGMA table_info(chapters)').all().map((column) => column.name),
    );
    const canReadChapterStatus = chapterColumns.has('status');
    const pendingRevisions = db
      .prepare("SELECT id, chapter_id, base_content FROM chapter_revisions WHERE status = 'pending' AND previous_chapter_status IS NULL")
      .all();

    db.transaction(() => {
      for (const revision of pendingRevisions) {
        const currentStatus = canReadChapterStatus
          ? db.prepare('SELECT status FROM chapters WHERE id = ?').get(revision.chapter_id)?.status
          : null;
        // v6 did not retain the original value. Preserve a non-review status
        // when one is available; otherwise use a conservative editable state.
        const previousStatus = currentStatus && currentStatus !== 'review'
          ? currentStatus
          : String(revision.base_content || '').trim() ? 'writing' : 'pending';
        db.prepare('UPDATE chapter_revisions SET previous_chapter_status = ? WHERE id = ?')
          .run(previousStatus, revision.id);
      }
    })();
  },
  // v7 → v8: assign every chapter update a database-ordered revision.
  // Client request/response arrival order is not a safe proxy for commit order:
  // a delayed response from an older write can arrive after a newer window has
  // already committed. The trigger keeps the revision correct for every writer
  // (REST, AI tools, continuation, and revision resolution) without requiring
  // each call site to remember to increment it.
  (db) => {
    const chapterColumns = new Set(
      db.prepare('PRAGMA table_info(chapters)').all().map((column) => column.name),
    );
    // Some legacy/imported databases contain only a subset of project tables.
    // Keep their migration path valid when there is no chapter data to version.
    if (chapterColumns.size === 0) return;
    if (!chapterColumns.has('data_version')) {
      db.exec('ALTER TABLE chapters ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chapters_data_version_after_update
      AFTER UPDATE ON chapters
      FOR EACH ROW
      WHEN NEW.data_version = OLD.data_version
      BEGIN
        UPDATE chapters SET data_version = OLD.data_version + 1 WHERE id = OLD.id;
      END;
    `);
  },
  // v8 → v9: assign an immutable project incarnation. A project name may be
  // reused after deletion; clients and long-running AI requests use this token
  // to prove that a mutation still targets the instance they loaded.
  (db) => {
    const existing = db.prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'").get();
    if (!existing?.value) {
      db.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('project_instance_id', ?)")
        .run(randomUUID());
    }
  },
  // v9 → v10: legacy/imported chapters could contain SQL NULL despite the
  // schema default. Revisions use an empty string as the canonical blank text,
  // so normalize persisted data before optimistic compare-and-swap operations.
  normalizeLegacyChapterContent,
];

const getProjectVersion = makeVersionGetter('project_meta');
const setProjectVersion = makeVersionSetter('project_meta');

function migrateProject(db) {
  runMigrations(
    db,
    projectMigrations,
    SQLJS_PROJECT_SCHEMA_VERSION,
    getProjectVersion,
    setProjectVersion,
  );
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Config DB query wrappers
// ═══════════════════════════════════════════════════════════════

function dbQuery(sql, params = []) {
  const db = getConfigDb();
  return db.prepare(sql).all(...params);
}

function dbGet(sql, params = []) {
  const db = getConfigDb();
  return db.prepare(sql).get(...params) || null;
}

function dbExecute(sql, params = []) {
  const db = getConfigDb();
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

// ═══════════════════════════════════════════════════════════════
// Project-specific query wrappers
// ═══════════════════════════════════════════════════════════════

function projectQuery(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  return db.prepare(sql).all(...params);
}

function projectGet(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  return db.prepare(sql).get(...params) || null;
}

function projectExecute(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

function projectTransaction(projectName, fn) {
  const db = getProjectDb(projectName);
  return db.transaction(fn)();
}

// ═══════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════

function updateProjectWordCount(projectDb, updatedAt = new Date().toISOString()) {
  const total = projectDb.prepare('SELECT SUM(word_count) as total FROM chapters').get()?.total || 0;
  const wordCount = String(total);
  const wordCountUpdate = projectDb
    .prepare("UPDATE project_meta SET value = ? WHERE key = 'word_count'")
    .run(wordCount);
  if (wordCountUpdate.changes === 0) {
    projectDb
      .prepare("INSERT INTO project_meta (key, value) VALUES ('word_count', ?)")
      .run(wordCount);
  }
  const updatedAtUpdate = projectDb
    .prepare("UPDATE project_meta SET value = ? WHERE key = 'updated_at'")
    .run(updatedAt);
  if (updatedAtUpdate.changes === 0) {
    projectDb
      .prepare("INSERT INTO project_meta (key, value) VALUES ('updated_at', ?)")
      .run(updatedAt);
  }
  return total;
}

function recalculateWordCount(projectName) {
  const projectDb = getProjectDb(projectName);
  return projectDb.transaction(() => updateProjectWordCount(projectDb))();
}

function flushAllDatabases() {
  assertStorageAvailable();
  configDb?.flush();
  for (const projectDb of projectConnections.values()) projectDb.flush();
}

function closeAllDatabases() {
  assertStorageAvailable();
  const connections = [...projectConnections.values()];
  const closedConnections = new Set();
  let primaryError = null;
  try {
    for (const projectDb of connections) {
      projectDb.close();
      closedConnections.add(projectDb);
    }
    if (configDb) {
      configDb.close();
      closedConnections.add(configDb);
    }
  } catch (error) {
    primaryError = error;
  }

  if (primaryError) {
    const remaining = [
      ...connections.filter((connection) => !closedConnections.has(connection)),
      configDb && !closedConnections.has(configDb) ? configDb : null,
    ];
    const cleanup = discardConnections(remaining);
    if (cleanup.errors.length > 0) {
      attachSecondaryError(primaryError, 'storageCleanupErrors', cleanup.errors);
    }
    projectConnections.clear();
    configDb = null;
    if (cleanup.uncertainConnections.length === 0) {
      try {
        releaseConfigLifecycleLease();
      } catch (releaseError) {
        attachSecondaryError(primaryError, 'configLeaseReleaseError', releaseError);
      }
    }
    enterStorageFailure(primaryError, cleanup.uncertainConnections);
    throw primaryError;
  }

  projectConnections.clear();
  configDb = null;
  try {
    releaseConfigLifecycleLease();
  } catch (error) {
    enterStorageFailure(error);
    throw error;
  }
}

function getCoverDir(projectName) {
  return path.join(getStoragePaths().projectsDir, projectName);
}

function findCoverPath(projectName) {
  const coverDir = getCoverDir(projectName);
  const exts = ['png', 'jpg', 'webp', 'gif'];
  for (const ext of exts) {
    const p = path.join(coverDir, `cover.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const MIME_TO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

module.exports = {
  initDatabase,
  installNativeActivationController,
  installFixtureNativeActivationController: installNativeActivationController,
  getConfigDb,
  createProjectDb,
  createFilesManuscriptDatabasePort,
  enableNativeProject,
  getProjectDb,
  inspectProjectManuscriptRoute,
  listProjectRouteCache,
  rebuildConfigCache,
  getProjectDbPath,
  openProjectDb,
  closeProjectDb,
  recoverProjectDatabasesAtStartup,
  inspectProjectDatabasesAtStartup,
  inspectRegisteredProject,
  recoverRegisteredProject,
  getRegisteredProjectDatabaseSha256,
  configureRecoveryDiagnosticsCapabilities,
  getProjectOpenState,
  removeProjectOpenState,
  recordProjectOpenFailure,
  projectOpenStates,
  assertProjectInstance,
  captureProjectInstance,
  runWithProjectInstance,
  dbQuery,
  dbGet,
  dbExecute,
  projectQuery,
  projectGet,
  projectExecute,
  projectTransaction,
  runManuscriptTransaction,
  isManuscriptPersistenceError,
  manuscriptTransactionCapability,
  recalculateWordCount,
  updateProjectWordCount,
  flushAllDatabases,
  closeAllDatabases,
  getProjectWriteLifecycle: () => projectWriteLifecycle,
  configureStorage,
  getStoragePaths,
  getDataDir: () => getStoragePaths().dataDir,
  getExportDir: () => getStoragePaths().exportDir,
  getCoverDir,
  findCoverPath,
  MIME_TO_EXT,
  EXT_TO_MIME,
};
