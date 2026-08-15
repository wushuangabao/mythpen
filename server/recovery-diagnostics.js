const crypto = require('node:crypto');

const { inspectControlStoreEvidence } = require('./control-store');
const { inspectSqlJsAtomicStore } = require('./sqljs-atomic-store');

function canonicalJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.keys(item).sort().map((key) => [key, item[key]]),
    );
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function registeredProjectNotFound(name) {
  const error = new Error(`Registered project not found: ${name}`);
  error.code = 'PROJECT_NOT_FOUND';
  error.status = 404;
  error.recoverable = true;
  return error;
}

function diagnosticsError(code, message, status = 409, recoverable = true) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.recoverable = recoverable;
  return error;
}

function normalizeIdentity(value) {
  if (!value) return null;
  return { dev: String(value.dev), ino: String(value.ino) };
}

function resolveRegisteredProject(name, deps) {
  if (typeof name !== 'string' || name.length === 0) throw registeredProjectNotFound(String(name));
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('Recovery diagnostics dependencies are required');
  }
  const registered = deps.lookupRegisteredProject(name);
  if (!registered || registered.name !== name || typeof registered.filePath !== 'string') {
    throw registeredProjectNotFound(name);
  }
  return { name: registered.name, filePath: registered.filePath };
}

function inspectResolvedProjectEvidence(registered, deps) {
  const controlDirectory = deps.getControlDirectory(registered.filePath);
  const controlEvidence = inspectControlStoreEvidence(controlDirectory);
  let atomic;
  try {
    atomic = inspectSqlJsAtomicStore({
      controlDirectory,
      events: controlEvidence.events,
      filePath: registered.filePath,
      sqlModule: deps.sqlModule,
      supportedSchemaVersion: deps.supportedSchemaVersion,
    });
  } catch (error) {
    atomic = {
      canAutoRecover: false,
      database: {
        schema: null,
        projectInstanceIdSha256: null,
        triggerVersion: null,
        projectMetaTriggerSetDigest: null,
        integrity: {
          integrityCheck: 'unavailable',
          foreignKeyCheck: 'unavailable',
        },
      },
      dbIdentity: null,
      expectedIdentity: null,
      reasonCode: error?.code === 'PROJECT_SCHEMA_TOO_NEW'
        ? 'PROJECT_SCHEMA_TOO_NEW'
        : 'RECOVERY_REQUIRED',
      recommendedAction: null,
      state: 'third',
    };
  }
  const absentInstallBlocked = atomic.state === 'rollback'
    && atomic.dbIdentity === null
    && deps.platformCapabilities.verifiedAbsentInstall !== true;
  if (absentInstallBlocked) {
    atomic = {
      ...atomic,
      canAutoRecover: false,
      reasonCode: 'RECOVERY_REQUIRED',
      recommendedAction: null,
    };
  }
  const database = atomic.database;
  const dtoWithoutSnapshot = {
    state: atomic.state === 'clean' ? 'ready' : 'isolated',
    reasonCode: atomic.reasonCode,
    protocol: 'sqljs-publication-v1',
    backend: 'sqljs-v1',
    schema: database.schema,
    triggerVersion: database.triggerVersion,
    expectedTriggerSetDigest: null,
    projectMetaTriggerSetDigest: database.projectMetaTriggerSetDigest,
    observedTriggerSetDigest: null,
    dbIdentity: normalizeIdentity(atomic.dbIdentity),
    expectedIdentity: normalizeIdentity(atomic.expectedIdentity),
    projectInstanceIdSha256: database.projectInstanceIdSha256,
    currentSeq: null,
    expectedSeq: null,
    controlStore: {
      tail: controlEvidence.projection.tail,
      checkpoint: controlEvidence.projection.checkpoint,
      events: controlEvidence.projection.events,
    },
    integrity: database.integrity,
    platformCapabilities: {
      backend: deps.platformCapabilities.backend,
      exclusiveLease: deps.platformCapabilities.exclusiveLease,
      directoryFsync: deps.platformCapabilities.directoryFsync,
      atomicReplace: deps.platformCapabilities.atomicReplace,
      verifiedAbsentInstall: deps.platformCapabilities.verifiedAbsentInstall,
    },
    canAutoRecover: atomic.canAutoRecover,
    canAdoptIdentity: false,
    recommendedAction: atomic.recommendedAction,
  };
  return {
    absentInstallBlocked,
    diagnostics: {
      ...dtoWithoutSnapshot,
      snapshot: sha256(Buffer.from(canonicalJson(dtoWithoutSnapshot), 'utf8')),
    },
  };
}

function inspectResolvedProject(registered, deps) {
  return inspectResolvedProjectEvidence(registered, deps).diagnostics;
}

function inspectRegisteredProject(name, deps) {
  return inspectResolvedProject(resolveRegisteredProject(name, deps), deps);
}

const RECOVERY_ACTIONS = new Set([
  'recover_transaction',
  'recover_v1_publication',
  'adopt_same_path_identity',
]);

function recoverRegisteredProject(name, request, deps) {
  if (
    request === null
    || typeof request !== 'object'
    || Array.isArray(request)
    || !RECOVERY_ACTIONS.has(request.action)
    || typeof request.snapshot !== 'string'
    || !/^[0-9a-f]{64}$/.test(request.snapshot)
  ) {
    throw diagnosticsError('INVALID_PARAMS', 'Invalid recovery request', 400, true);
  }
  const registered = resolveRegisteredProject(name, deps);
  if (request.action !== 'recover_v1_publication') {
    throw diagnosticsError(
      'NATIVE_ACTIVATION_DISABLED',
      'Native recovery and identity adoption are disabled in this build',
    );
  }

  if (deps.platformCapabilities.verifiedAbsentInstall !== true) {
    const preflight = inspectResolvedProjectEvidence(registered, deps);
    if (preflight.absentInstallBlocked) {
      throw diagnosticsError(
        'RECOVERY_REQUIRED',
        'Missing-formal rollback is unavailable on this durability backend',
      );
    }
  }
  if (typeof deps.withProjectRecoveryLease !== 'function') {
    throw new TypeError('withProjectRecoveryLease dependency is required');
  }
  if (typeof deps.canonicalizeProjectPath !== 'function') {
    throw new TypeError('canonicalizeProjectPath dependency is required');
  }
  const initialProjectKey = deps.canonicalizeProjectPath(registered.filePath);
  return deps.withProjectRecoveryLease(registered.filePath, (leaseContext) => {
    const currentRegistered = resolveRegisteredProject(name, deps);
    const currentProjectKey = deps.canonicalizeProjectPath(currentRegistered.filePath);
    if (
      currentProjectKey !== initialProjectKey
      || leaseContext?.canonicalProjectKey !== initialProjectKey
    ) {
      throw diagnosticsError(
        'RECOVERY_SNAPSHOT_STALE',
        'The registered project changed while acquiring its recovery lease',
      );
    }
    const current = inspectResolvedProject(currentRegistered, deps);
    if (current.snapshot !== request.snapshot) {
      throw diagnosticsError(
        'RECOVERY_SNAPSHOT_STALE',
        'Recovery evidence changed after diagnostics were read',
      );
    }
    if (
      current.canAutoRecover !== true
      || current.recommendedAction !== 'recover_v1_publication'
    ) {
      throw diagnosticsError(
        current.reasonCode === 'PROJECT_SCHEMA_TOO_NEW'
          ? 'PROJECT_SCHEMA_TOO_NEW'
          : 'RECOVERY_REQUIRED',
        'The project cannot be recovered automatically',
      );
    }
    if (typeof deps.recoverV1Publication !== 'function') {
      throw new TypeError('recoverV1Publication dependency is required');
    }
    deps.recoverV1Publication(currentRegistered);
    const recovered = inspectResolvedProject(currentRegistered, deps);
    if (recovered.state !== 'ready') {
      throw diagnosticsError('RECOVERY_REQUIRED', 'Recovery did not reach a clean project state');
    }
    return recovered;
  });
}

module.exports = {
  inspectRegisteredProject,
  recoverRegisteredProject,
  resolveRegisteredProject,
};
