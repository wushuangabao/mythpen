const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

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

module.exports = { publishGeneratedProjectFile };
