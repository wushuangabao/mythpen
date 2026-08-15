const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  acquireConfigLifecycleLease,
  acquireConfigLifecycleLeaseSet,
} = require('../config-lifecycle-lease');
const { resolveStableApplicationControlRoot } = require('../application-control-paths');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-config-lease-${name}-`));
}

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`holder exited before ${expected}: code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('stable application control root does not follow the data root', () => {
  const homeDir = path.join(tempDir('home'), 'profile');
  assert.equal(
    resolveStableApplicationControlRoot({ homeDir }),
    path.join(path.resolve(homeDir), '.mythpen-control'),
  );
});

test('lease key binds the canonical config path digest and independent roots coexist', (t) => {
  const controlRoot = tempDir('control');
  const firstDataRoot = tempDir('data-a');
  const secondDataRoot = tempDir('data-b');
  t.after(() => {
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(firstDataRoot, { recursive: true, force: true });
    fs.rmSync(secondDataRoot, { recursive: true, force: true });
  });

  const firstPath = path.join(firstDataRoot, 'config.db');
  const secondPath = path.join(secondDataRoot, 'config.db');
  const first = acquireConfigLifecycleLease(firstPath, { controlRoot });
  const second = acquireConfigLifecycleLease(secondPath, { controlRoot });
  try {
    const canonical = canonicalDatabasePath(firstPath);
    const digest = createHash('sha256').update(canonical).digest('hex');
    assert.equal(first.configDbPath, canonical);
    assert.equal(first.leasePath, path.join(controlRoot, 'config-leases', `${digest}.lease`));
    assert.equal(first.state, 'active');
    assert.doesNotThrow(() => first.assertHeld());
    assert.equal(second.state, 'active');
  } finally {
    second.release();
    first.release();
  }
  assert.equal(first.state, 'released');
  assert.equal(second.state, 'released');
});

test('same config database is busy across processes and can be reacquired after forced termination', async (t) => {
  const controlRoot = tempDir('cross-process-control');
  const dataRoot = tempDir('cross-process-data');
  const configDbPath = path.join(dataRoot, 'config.db');
  const fixture = path.join(__dirname, 'fixtures', 'config-lifecycle-holder.js');
  const child = spawn(process.execPath, [fixture, configDbPath, controlRoot], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  await waitForLine(child, 'acquired');
  assert.throws(
    () => acquireConfigLifecycleLease(configDbPath, { controlRoot }),
    (error) => error.code === 'CONFIG_DATABASE_BUSY' && error.status === 423,
  );

  const exited = waitForExit(child);
  child.kill('SIGKILL');
  await exited;

  const reacquired = acquireConfigLifecycleLease(configDbPath, { controlRoot });
  reacquired.release();
});

test('lease sets deduplicate and acquire canonical config paths in stable UTF-8 order', (t) => {
  const controlRoot = tempDir('set-order-control');
  const roots = [tempDir('set-z'), tempDir('set-a')];
  t.after(() => {
    fs.rmSync(controlRoot, { recursive: true, force: true });
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });
  const paths = roots.map((root) => path.join(root, 'config.db'));
  const acquired = [];
  const fakeAcquire = (leasePath) => {
    acquired.push(leasePath);
    let held = true;
    return {
      isHeld: () => held,
      release() { held = false; },
    };
  };

  const leaseSet = acquireConfigLifecycleLeaseSet(
    [paths[0], paths[1], paths[0]],
    { controlRoot, acquireLease: fakeAcquire },
  );
  const expected = [...new Set(paths.map(canonicalDatabasePath))]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((canonical) => {
      const digest = createHash('sha256').update(canonical).digest('hex');
      return path.join(controlRoot, 'config-leases', `${digest}.lease`);
    });
  assert.deepEqual(acquired, expected);
  leaseSet.release();
});

test('release failure becomes disposition_unknown and blocks in-process reacquisition', (t) => {
  const controlRoot = tempDir('unknown-control');
  const dataRoot = tempDir('unknown-data');
  t.after(() => {
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  const configDbPath = path.join(dataRoot, 'config.db');
  const releaseError = new Error('injected release failure');
  const lease = acquireConfigLifecycleLease(configDbPath, {
    controlRoot,
    acquireLease: () => ({
      isHeld: () => true,
      release() { throw releaseError; },
    }),
  });

  assert.throws(
    () => lease.release(),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.cause === releaseError,
  );
  assert.equal(lease.state, 'disposition_unknown');
  assert.throws(
    () => acquireConfigLifecycleLease(configDbPath, { controlRoot }),
    (error) => error.code === 'STORAGE_UNAVAILABLE',
  );
});

test('held-state probe failure becomes disposition_unknown before it is reported', (t) => {
  const controlRoot = tempDir('probe-unknown-control');
  const dataRoot = tempDir('probe-unknown-data');
  t.after(() => {
    fs.rmSync(controlRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  const configDbPath = path.join(dataRoot, 'config.db');
  const probeError = new Error('injected held-state probe failure');
  const lease = acquireConfigLifecycleLease(configDbPath, {
    controlRoot,
    acquireLease: () => ({
      isHeld() { throw probeError; },
      release() {},
    }),
  });

  assert.throws(
    () => lease.assertHeld(),
    (error) => error.code === 'STORAGE_UNAVAILABLE' && error.cause === probeError,
  );
  assert.equal(lease.state, 'disposition_unknown');
  assert.throws(
    () => acquireConfigLifecycleLease(configDbPath, { controlRoot }),
    (error) => error.code === 'STORAGE_UNAVAILABLE',
  );
});
