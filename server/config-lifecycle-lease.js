const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { resolveStableApplicationControlRoot } = require('./application-control-paths');
const { acquireExclusiveLease } = require('./platform/durability');
const { canonicalDatabasePath } = require('./sqljs-atomic-store');

const leasesByCanonicalConfigPath = new Map();

function configDatabaseBusy(configDbPath, cause) {
  const error = new Error(`Configuration database is already in use: ${configDbPath}`, { cause });
  error.code = 'CONFIG_DATABASE_BUSY';
  error.status = 423;
  error.recoverable = true;
  return error;
}

function storageUnavailable(configDbPath, cause) {
  const error = new Error(`Configuration database lease disposition is unknown: ${configDbPath}`, {
    cause,
  });
  error.code = 'STORAGE_UNAVAILABLE';
  error.status = 503;
  error.recoverable = false;
  return error;
}

function acquireConfigLifecycleLease(configDbPath, options = {}) {
  const canonicalConfigDbPath = canonicalDatabasePath(configDbPath);
  const existing = leasesByCanonicalConfigPath.get(canonicalConfigDbPath);
  if (existing?.state === 'disposition_unknown') {
    throw storageUnavailable(canonicalConfigDbPath, existing.failure);
  }
  if (existing) throw configDatabaseBusy(canonicalConfigDbPath);

  const controlRoot = path.resolve(
    options.controlRoot || resolveStableApplicationControlRoot(options),
  );
  const leaseDirectory = path.join(controlRoot, 'config-leases');
  fs.mkdirSync(leaseDirectory, { recursive: true });
  const digest = createHash('sha256').update(canonicalConfigDbPath).digest('hex');
  const leasePath = path.join(leaseDirectory, `${digest}.lease`);
  const acquireLease = options.acquireLease || acquireExclusiveLease;

  let underlyingLease;
  try {
    underlyingLease = acquireLease(leasePath);
  } catch (error) {
    if (error?.code === 'LEASE_BUSY') throw configDatabaseBusy(canonicalConfigDbPath, error);
    throw error;
  }

  const record = {
    state: 'active',
    failure: null,
  };
  leasesByCanonicalConfigPath.set(canonicalConfigDbPath, record);
  const lease = {
    configDbPath: canonicalConfigDbPath,
    leasePath,
    get state() {
      return record.state;
    },
    assertHeld() {
      if (record.state !== 'active') {
        throw storageUnavailable(canonicalConfigDbPath, record.failure);
      }
      let held;
      try {
        held = underlyingLease.isHeld();
      } catch (error) {
        record.state = 'disposition_unknown';
        record.failure = error;
        throw storageUnavailable(canonicalConfigDbPath, record.failure);
      }
      if (!held) {
        record.state = 'disposition_unknown';
        record.failure = new Error('The underlying configuration database lease is no longer held');
        throw storageUnavailable(canonicalConfigDbPath, record.failure);
      }
    },
    release() {
      if (record.state === 'released') {
        throw storageUnavailable(
          canonicalConfigDbPath,
          new Error('The configuration database lease was already released'),
        );
      }
      if (record.state === 'disposition_unknown') {
        throw storageUnavailable(canonicalConfigDbPath, record.failure);
      }
      try {
        underlyingLease.release();
      } catch (error) {
        record.state = 'disposition_unknown';
        record.failure = error;
        throw storageUnavailable(canonicalConfigDbPath, error);
      }
      record.state = 'released';
      leasesByCanonicalConfigPath.delete(canonicalConfigDbPath);
    },
  };
  return lease;
}

function attachReleaseErrors(primaryError, releaseErrors) {
  if (releaseErrors.length === 0) return;
  try {
    Object.defineProperty(primaryError, 'configLeaseReleaseErrors', {
      value: releaseErrors,
      configurable: true,
    });
  } catch {
    // Preserve the primary acquisition error if it cannot be extended.
  }
}

function releaseLeasesInReverse(leases) {
  const releaseErrors = [];
  for (const lease of [...leases].reverse()) {
    try {
      lease.release();
    } catch (error) {
      releaseErrors.push(error);
    }
  }
  return releaseErrors;
}

function acquireConfigLifecycleLeaseSet(configDbPaths, options = {}) {
  const canonicalPaths = [...new Set(configDbPaths.map(canonicalDatabasePath))]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const leases = [];
  try {
    for (const configDbPath of canonicalPaths) {
      leases.push(acquireConfigLifecycleLease(configDbPath, options));
    }
  } catch (error) {
    attachReleaseErrors(error, releaseLeasesInReverse(leases));
    throw error;
  }

  let state = 'active';
  return {
    leases: Object.freeze([...leases]),
    get state() {
      return state;
    },
    assertHeld() {
      if (state !== 'active') {
        throw storageUnavailable(canonicalPaths.join(', '), new Error('Lease set is not active'));
      }
      for (const lease of leases) lease.assertHeld();
    },
    release() {
      if (state !== 'active') {
        throw storageUnavailable(canonicalPaths.join(', '), new Error('Lease set is not active'));
      }
      const releaseErrors = releaseLeasesInReverse(leases);
      if (releaseErrors.length > 0) {
        state = 'disposition_unknown';
        const [primary, ...secondary] = releaseErrors;
        attachReleaseErrors(primary, secondary);
        throw primary;
      }
      state = 'released';
    },
  };
}

module.exports = {
  acquireConfigLifecycleLease,
  acquireConfigLifecycleLeaseSet,
};
