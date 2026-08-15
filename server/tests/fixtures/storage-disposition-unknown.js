const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const leaseModule = require('../../config-lifecycle-lease');
const { fileManifest } = require('../../storage-migration');

const originalAcquire = leaseModule.acquireConfigLifecycleLease;
const underlyingLeases = [];
const controlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-disposition-control-'));
leaseModule.acquireConfigLifecycleLease = (configDbPath) => {
  const underlying = originalAcquire(configDbPath, { controlRoot });
  underlyingLeases.push(underlying);
  let state = 'active';
  return {
    configDbPath: underlying.configDbPath,
    leasePath: underlying.leasePath,
    get state() { return state; },
    assertHeld: () => underlying.assertHeld(),
    release() {
      state = 'disposition_unknown';
      const error = new Error('injected unknown config lease disposition');
      error.code = 'STORAGE_UNAVAILABLE';
      error.status = 503;
      throw error;
    },
  };
};

const db = require('../../db');

(async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-disposition-data-'));
  const firstCandidate = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-disposition-first-')),
    'candidate',
  );
  const retryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-disposition-retry-'));
  const retryCandidate = path.join(retryParent, 'candidate');
  fs.writeFileSync(path.join(retryParent, 'sentinel.txt'), 'unchanged');
  process.env.MYTHPEN_DATA_DIR = dataRoot;
  db.configureStorage();
  await db.initDatabase();
  try {
    db.configureStorage({ dataDir: firstCandidate });
  } catch {
    // The injected release failure intentionally enters storageFailure.
  }
  const before = fileManifest(retryParent);
  let code;
  try {
    db.configureStorage({ dataDir: retryCandidate });
  } catch (error) {
    code = error.code;
  }
  const after = fileManifest(retryParent);
  process.stdout.write(`${JSON.stringify({ before, after, code })}\n`);
  for (const lease of underlyingLeases) {
    if (lease.state === 'active') lease.release();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
