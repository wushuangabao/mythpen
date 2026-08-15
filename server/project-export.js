const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fsyncDirectory } = require('./platform/durability');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function attachCleanupError(primaryError, cleanupError) {
  if ((typeof primaryError !== 'object' && typeof primaryError !== 'function') || primaryError === null) return;
  try {
    Object.defineProperty(primaryError, 'cleanupError', {
      value: cleanupError,
      configurable: true,
    });
  } catch {
    // Preserve the original generation/CAS error for custom frozen values.
  }
}

function projectIdentityForDiagnosticsExport(identity) {
  if (identity === null) return null;
  return {
    dev: identity.dev,
    ino: identity.ino,
  };
}

function projectControlPointForDiagnosticsExport(point) {
  if (point === null) return null;
  return {
    seq: point.seq,
    digest: point.digest,
  };
}

function projectControlEventForDiagnosticsExport(event) {
  return {
    seq: event.seq,
    type: event.type,
    digest: event.digest,
    prevDigest: event.prevDigest,
  };
}

function projectRecoveryDiagnosticsForExport(diagnostics) {
  return {
    state: diagnostics.state,
    reasonCode: diagnostics.reasonCode,
    protocol: diagnostics.protocol,
    backend: diagnostics.backend,
    schema: diagnostics.schema,
    triggerVersion: diagnostics.triggerVersion,
    expectedTriggerSetDigest: diagnostics.expectedTriggerSetDigest,
    projectMetaTriggerSetDigest: diagnostics.projectMetaTriggerSetDigest,
    observedTriggerSetDigest: diagnostics.observedTriggerSetDigest,
    dbIdentity: projectIdentityForDiagnosticsExport(diagnostics.dbIdentity),
    expectedIdentity: projectIdentityForDiagnosticsExport(diagnostics.expectedIdentity),
    projectInstanceIdSha256: diagnostics.projectInstanceIdSha256,
    currentSeq: diagnostics.currentSeq,
    expectedSeq: diagnostics.expectedSeq,
    controlStore: {
      tail: projectControlPointForDiagnosticsExport(diagnostics.controlStore.tail),
      checkpoint: projectControlPointForDiagnosticsExport(
        diagnostics.controlStore.checkpoint,
      ),
      events: diagnostics.controlStore.events.map(projectControlEventForDiagnosticsExport),
    },
    integrity: {
      integrityCheck: diagnostics.integrity.integrityCheck,
      foreignKeyCheck: diagnostics.integrity.foreignKeyCheck,
    },
    platformCapabilities: {
      backend: diagnostics.platformCapabilities.backend,
      exclusiveLease: diagnostics.platformCapabilities.exclusiveLease,
      directoryFsync: diagnostics.platformCapabilities.directoryFsync,
      atomicReplace: diagnostics.platformCapabilities.atomicReplace,
      verifiedAbsentInstall: diagnostics.platformCapabilities.verifiedAbsentInstall,
    },
    canAutoRecover: diagnostics.canAutoRecover,
    canAdoptIdentity: diagnostics.canAdoptIdentity,
    recommendedAction: diagnostics.recommendedAction,
    snapshot: diagnostics.snapshot,
  };
}

/**
 * Generate a project artifact away from its public filename, then publish it
 * only after the caller proves that the project incarnation is still current.
 */
async function publishGeneratedProjectFile({
  finalPath,
  generate,
  assertCurrent,
  capturePublished,
  fsApi = fs,
  createId = randomUUID,
}) {
  const tempPath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${createId()}.tmp`,
  );
  try {
    await generate(tempPath);
    assertCurrent();
    fsApi.renameSync(tempPath, finalPath);
    // Capture the caller's response synchronously in the rename critical
    // section. Another concurrent export may reuse finalPath immediately after
    // this stack returns, but it cannot change the bytes already captured here.
    return typeof capturePublished === 'function' ? capturePublished(finalPath) : finalPath;
  } catch (error) {
    try {
      fsApi.unlinkSync(tempPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') attachCleanupError(error, cleanupError);
    }
    throw error;
  }
}

function publishOpaqueDiagnosticsExport({
  exportDir,
  diagnostics,
  currentDatabaseSha256,
  fsApi = fs,
  createId = randomUUID,
  fsyncDirectoryApi = fsyncDirectory,
}) {
  if (typeof exportDir !== 'string' || exportDir.length === 0) {
    throw new TypeError('Diagnostics export directory is required');
  }
  if (
    diagnostics === null
    || typeof diagnostics !== 'object'
    || Array.isArray(diagnostics)
  ) {
    throw new TypeError('Diagnostics export payload is required');
  }
  if (!SHA256_PATTERN.test(currentDatabaseSha256)) {
    throw new TypeError('Current database SHA-256 is invalid');
  }

  const finalId = createId();
  const tempId = createId();
  if (!UUID_V4_PATTERN.test(finalId) || !UUID_V4_PATTERN.test(tempId)) {
    throw new TypeError('Diagnostics export UUID is invalid');
  }
  const filename = `${finalId}.mythpen-diagnostics.json`;
  const finalPath = path.join(exportDir, filename);
  const tempPath = path.join(exportDir, `.${filename}.${tempId}.tmp`);
  const manifest = {
    format: 'mythpen-diagnostics',
    formatVersion: 1,
    diagnostics: projectRecoveryDiagnosticsForExport(diagnostics),
    currentDatabaseSha256,
  };
  const serialized = JSON.stringify(manifest);

  let descriptor = null;
  let tempExists = false;
  try {
    fsApi.mkdirSync(exportDir, { recursive: true });
    descriptor = fsApi.openSync(tempPath, 'wx', 0o600);
    tempExists = true;
    fsApi.writeFileSync(descriptor, serialized, 'utf8');
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = null;
    fsApi.linkSync(tempPath, finalPath);
    fsApi.unlinkSync(tempPath);
    tempExists = false;
    fsyncDirectoryApi(exportDir);
    return { filename };
  } catch (error) {
    if (descriptor !== null) {
      try {
        fsApi.closeSync(descriptor);
      } catch (cleanupError) {
        attachCleanupError(error, cleanupError);
      }
    }
    if (tempExists) {
      try {
        fsApi.unlinkSync(tempPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') attachCleanupError(error, cleanupError);
      }
    }
    throw error;
  }
}

module.exports = {
  publishGeneratedProjectFile,
  publishOpaqueDiagnosticsExport,
};
