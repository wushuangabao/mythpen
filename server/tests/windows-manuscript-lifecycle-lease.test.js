'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createWindowsManuscriptLifecycleLeaseAdapter,
} = require('../platform/windows-manuscript-lifecycle-lease');

function identityFromStats(stats) {
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function physicalIdentity(targetPath, { follow = false } = {}) {
  const stats = (follow ? fs.statSync : fs.lstatSync)(targetPath, { bigint: true });
  return identityFromStats(stats);
}

function lifecycleLockPath(canonicalRealControlDirectory) {
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(canonicalRealControlDirectory, 'utf8'))
    .digest('hex');
  return path.join(
    path.dirname(canonicalRealControlDirectory),
    `.manuscript-${digest}.lifecycle.lock`,
  );
}

function createFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-lifecycle-',
  )));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controlDirectory = path.join(root, 'control-store');
  fs.mkdirSync(controlDirectory);
  const canonicalRealControlDirectory = fs.realpathSync.native(controlDirectory);
  const lockPath = lifecycleLockPath(canonicalRealControlDirectory);
  fs.writeFileSync(lockPath, Buffer.alloc(0), { flag: 'wx' });
  return {
    canonicalRealControlDirectory,
    controlDirectory,
    lockPath,
    root,
  };
}

function platformIdentityForControlPath(controlEntry, overrides = {}) {
  const canonicalRealControlDirectory = fs.realpathSync.native(controlEntry);
  const lockPath = lifecycleLockPath(canonicalRealControlDirectory);
  return Object.freeze({
    canonicalRealControlDirectory,
    controlDirectoryIdentity: physicalIdentity(canonicalRealControlDirectory),
    controlParentDirectoryIdentity: physicalIdentity(
      path.dirname(canonicalRealControlDirectory),
    ),
    lifecycleLockIdentity: physicalIdentity(lockPath),
    ...overrides,
  });
}

function platformIdentity(fixture, overrides = {}) {
  return platformIdentityForControlPath(fixture.controlDirectory, overrides);
}

function inspectedControlDirectory(identity, overrides = {}) {
  return {
    actualName: path.basename(identity.canonicalRealControlDirectory),
    identity: identity.controlDirectoryIdentity,
    kind: 'directory',
    linkCount: null,
    parentIdentity: identity.controlParentDirectoryIdentity,
    parentRealPath: path.dirname(identity.canonicalRealControlDirectory),
    realPath: identity.canonicalRealControlDirectory,
    reparse: false,
    ...overrides,
  };
}

function fakePrimitiveLease({ releaseError } = {}) {
  let state = 'HELD';
  let releaseCalls = 0;
  const lease = {};
  Object.defineProperties(lease, {
    state: {
      enumerable: true,
      get() { return state; },
    },
    release: {
      enumerable: true,
      value() {
        releaseCalls += 1;
        if (releaseError !== undefined) {
          state = 'RELEASE_DISPOSITION_UNKNOWN';
          throw releaseError;
        }
        state = 'RELEASED';
        return Object.freeze({ disposition: 'UNLOCKED_AND_CLOSED' });
      },
    },
  });
  return {
    lease: Object.freeze(lease),
    releaseCalls: () => releaseCalls,
  };
}

function dispositionUnknownError(message) {
  const error = Object.assign(new Error(message), { code: 'LEASE_LOST' });
  Object.defineProperty(error, 'releaseDispositionUnknown', {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
  return error;
}

function assertTopLevelDispositionUnknown(error) {
  const descriptor = Object.getOwnPropertyDescriptor(error, 'releaseDispositionUnknown');
  assert.deepEqual(descriptor, {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
  assert.equal(Object.isFrozen(error.details), true);
  assert.equal(error.details.releaseDispositionUnknown, true);
}

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to throw');
}

function withIsolatedLifecycleDurability(overrides, run) {
  const adapterPath = require.resolve('../platform/windows-manuscript-lifecycle-lease');
  const durabilityPath = require.resolve('../platform/durability');
  const cachedAdapter = require.cache[adapterPath];
  const durabilityModule = require(durabilityPath);
  const originals = {};
  for (const [name, implementation] of Object.entries(overrides)) {
    originals[name] = durabilityModule[name];
    durabilityModule[name] = implementation;
  }
  delete require.cache[adapterPath];
  try {
    return run(require(adapterPath));
  } finally {
    delete require.cache[adapterPath];
    for (const [name, implementation] of Object.entries(originals)) {
      durabilityModule[name] = implementation;
    }
    if (cachedAdapter !== undefined) require.cache[adapterPath] = cachedAdapter;
  }
}

function waitForLine(child, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Timed out waiting for ${JSON.stringify(expected)}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      ));
    }, timeoutMs);
    const onStdout = (chunk) => {
      stdout += chunk.toString();
      if (!stdout.split(/\r?\n/).includes(expected)) return;
      cleanup();
      resolve();
    };
    const onStderr = (chunk) => { stderr += chunk.toString(); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(
        `Lifecycle worker exited before ${expected}: code=${code} signal=${signal} stderr=${stderr}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for lifecycle worker exit'));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function startWorker(t, identity, mode) {
  const workerPath = path.join(__dirname, 'fixtures', 'manuscript-lifecycle-worker.js');
  const encodedIdentity = Buffer.from(JSON.stringify(identity), 'utf8').toString('base64url');
  const child = spawn(process.execPath, [
    workerPath,
    encodedIdentity,
    mode,
  ], {
    cwd: path.resolve(__dirname, '..', '..'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return child;
}

async function releaseWorker(child) {
  child.stdin.write('release\n');
  child.stdin.end();
  await waitForExit(child);
  assert.equal(child.exitCode, 0);
}

test('Windows manuscript lifecycle adapter requires exact deeply frozen canonical identity', {
  skip: process.platform !== 'win32',
}, (t) => {
  const fixture = createFixture(t);
  const adapter = createWindowsManuscriptLifecycleLeaseAdapter();
  const valid = platformIdentity(fixture);
  assert.equal(Object.isFrozen(adapter), true);
  assert.throws(() => createWindowsManuscriptLifecycleLeaseAdapter({}), TypeError);

  const invalidInputs = [
    null,
    { ...valid },
    Object.freeze({ ...valid, extra: true }),
    Object.freeze({
      ...valid,
      controlDirectoryIdentity: { ...valid.controlDirectoryIdentity },
    }),
    Object.freeze({
      ...valid,
      lifecycleLockIdentity: Object.freeze({
        dev: Number(valid.lifecycleLockIdentity.dev),
        ino: valid.lifecycleLockIdentity.ino,
      }),
    }),
    Object.freeze({
      ...valid,
      lifecycleLockIdentity: Object.freeze({
        dev: `0${valid.lifecycleLockIdentity.dev}`,
        ino: valid.lifecycleLockIdentity.ino,
      }),
    }),
    Object.freeze({
      ...valid,
      canonicalRealControlDirectory: `${valid.canonicalRealControlDirectory}${path.sep}`,
    }),
  ];
  for (const invalid of invalidInputs) {
    assert.throws(
      () => adapter.acquireShared(invalid),
      { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
    );
  }
});

test('Windows manuscript lifecycle adapter returns an opaque frozen stateful lease', {
  skip: process.platform !== 'win32',
}, (t) => {
  const fixture = createFixture(t);
  const adapter = createWindowsManuscriptLifecycleLeaseAdapter();
  const lease = adapter.acquireShared(platformIdentity(fixture));

  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(Object.keys(lease).sort(), ['release', 'state']);
  assert.equal(lease.state, 'HELD');
  const clone = { ...lease };
  assert.throws(
    () => clone.release(),
    { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
  );
  assert.equal(lease.state, 'HELD');

  const result = lease.release();
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, { disposition: 'UNLOCKED_AND_CLOSED' });
  assert.equal(lease.state, 'RELEASED');
  assert.throws(
    () => lease.release(),
    { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
  );
});

test('Windows manuscript lifecycle adapter never creates a missing lock and rejects changed facts', {
  skip: process.platform !== 'win32',
}, (t) => {
  const adapter = createWindowsManuscriptLifecycleLeaseAdapter();

  const missingFixture = createFixture(t);
  const missingIdentity = platformIdentity(missingFixture);
  fs.unlinkSync(missingFixture.lockPath);
  assert.throws(
    () => adapter.acquireShared(missingIdentity),
    { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
  );
  assert.equal(fs.existsSync(missingFixture.lockPath), false);

  const nonemptyFixture = createFixture(t);
  const nonemptyIdentity = platformIdentity(nonemptyFixture);
  fs.writeFileSync(nonemptyFixture.lockPath, 'not empty');
  assert.throws(
    () => adapter.acquireShared(nonemptyIdentity),
    { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
  );

  const hardlinkFixture = createFixture(t);
  const hardlinkIdentity = platformIdentity(hardlinkFixture);
  fs.linkSync(hardlinkFixture.lockPath, path.join(hardlinkFixture.root, 'second-link'));
  assert.throws(
    () => adapter.acquireExclusive(hardlinkIdentity),
    { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
  );

  const identityFixture = createFixture(t);
  const expected = platformIdentity(identityFixture);
  for (const key of [
    'controlDirectoryIdentity',
    'controlParentDirectoryIdentity',
    'lifecycleLockIdentity',
  ]) {
    const changed = Object.freeze({
      ...expected,
      [key]: Object.freeze({ dev: expected[key].dev, ino: `${BigInt(expected[key].ino) + 1n}` }),
    });
    assert.throws(
      () => adapter.acquireShared(changed),
      { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
    );
  }
});

test('Windows manuscript lifecycle adapter rejects a reparse lock as both link and target identity', {
  skip: process.platform !== 'win32',
}, (t) => {
  const fixture = createFixture(t);
  fs.unlinkSync(fixture.lockPath);
  const target = path.join(fixture.root, 'reparse-target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, fixture.lockPath, 'junction');
  const adapter = createWindowsManuscriptLifecycleLeaseAdapter();

  for (const lifecycleLockIdentity of [
    physicalIdentity(fixture.lockPath),
    physicalIdentity(fixture.lockPath, { follow: true }),
  ]) {
    assert.throws(
      () => adapter.acquireShared(platformIdentity(fixture, { lifecycleLockIdentity })),
      { code: 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE' },
    );
  }
});

test('Windows manuscript lifecycle adapter uses pinned control and parent facts before and after lock', {
  skip: process.platform !== 'win32',
}, (t) => {
  const fixture = createFixture(t);
  const identity = platformIdentity(fixture);
  const parentReparse = Object.assign(new Error('parent became a reparse point'), {
    code: 'VERIFIED_SOURCE_TOPOLOGY_CHANGED',
  });
  const cases = [
    {
      inspect(call) {
        return inspectedControlDirectory(identity, { reparse: call === 1 });
      },
      name: 'control reparse before lock',
      releaseCalls: 0,
    },
    {
      inspect() { throw parentReparse; },
      name: 'parent reparse before lock',
      releaseCalls: 0,
    },
    {
      inspect(call) {
        return inspectedControlDirectory(identity, call === 2
          ? { identity: Object.freeze({
            dev: identity.controlDirectoryIdentity.dev,
            ino: `${BigInt(identity.controlDirectoryIdentity.ino) + 1n}`,
          }) }
          : {});
      },
      name: 'control identity changed after lock',
      releaseCalls: 1,
    },
    {
      inspect(call) {
        return inspectedControlDirectory(identity, call === 2
          ? { parentIdentity: Object.freeze({
            dev: identity.controlParentDirectoryIdentity.dev,
            ino: `${BigInt(identity.controlParentDirectoryIdentity.ino) + 1n}`,
          }) }
          : {});
      },
      name: 'parent identity changed after lock',
      releaseCalls: 1,
    },
  ];

  for (const fault of cases) {
    let inspectCalls = 0;
    let acquireCalls = 0;
    const primitive = fakePrimitiveLease();
    withIsolatedLifecycleDurability({
      acquireExistingFileRangeLease() {
        acquireCalls += 1;
        return primitive.lease;
      },
      inspectPath() {
        inspectCalls += 1;
        return fault.inspect(inspectCalls);
      },
    }, ({ createWindowsManuscriptLifecycleLeaseAdapter: createAdapter }) => {
      const error = captureError(() => createAdapter().acquireShared(identity));
      assert.equal(error.code, 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE', fault.name);
    });
    assert.equal(acquireCalls, fault.releaseCalls === 0 ? 0 : 1, fault.name);
    assert.equal(primitive.releaseCalls(), fault.releaseCalls, fault.name);
  }
});

test('Windows manuscript lifecycle adapter preserves top-level unknown release disposition', {
  skip: process.platform !== 'win32',
}, (t) => {
  const fixture = createFixture(t);
  const identity = platformIdentity(fixture);
  const safeInspect = () => inspectedControlDirectory(identity);

  const acquireUnknown = dispositionUnknownError('acquire cleanup close unknown');
  withIsolatedLifecycleDurability({
    acquireExistingFileRangeLease() { throw acquireUnknown; },
    inspectPath: safeInspect,
  }, ({ createWindowsManuscriptLifecycleLeaseAdapter: createAdapter }) => {
    const error = captureError(() => createAdapter().acquireShared(identity));
    assert.equal(error.code, 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE');
    assert.strictEqual(error.cause, acquireUnknown);
    assertTopLevelDispositionUnknown(error);
  });

  const rollbackUnknown = dispositionUnknownError('rollback close unknown');
  const rollbackPrimitive = fakePrimitiveLease({ releaseError: rollbackUnknown });
  let inspectCalls = 0;
  withIsolatedLifecycleDurability({
    acquireExistingFileRangeLease: () => rollbackPrimitive.lease,
    inspectPath() {
      inspectCalls += 1;
      return inspectedControlDirectory(identity, inspectCalls === 2
        ? { reparse: true }
        : {});
    },
  }, ({ createWindowsManuscriptLifecycleLeaseAdapter: createAdapter }) => {
    const error = captureError(() => createAdapter().acquireShared(identity));
    assert.equal(error.code, 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE');
    assert.strictEqual(error.cause, rollbackUnknown);
    assert.equal(error.secondaryErrors.length, 1);
    assertTopLevelDispositionUnknown(error);
  });

  const releaseUnknown = dispositionUnknownError('held lease close unknown');
  const releasePrimitive = fakePrimitiveLease({ releaseError: releaseUnknown });
  withIsolatedLifecycleDurability({
    acquireExistingFileRangeLease: () => releasePrimitive.lease,
    inspectPath: safeInspect,
  }, ({ createWindowsManuscriptLifecycleLeaseAdapter: createAdapter }) => {
    const lease = createAdapter().acquireShared(identity);
    const error = captureError(() => lease.release());
    assert.equal(error.code, 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE');
    assert.equal(lease.state, 'RELEASE_DISPOSITION_UNKNOWN');
    assertTopLevelDispositionUnknown(error);
  });
});

test('Windows manuscript lifecycle shared leases coexist across processes', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const fixture = createFixture(t);
  const identity = platformIdentity(fixture);
  const child = startWorker(t, identity, 'shared');
  await waitForLine(child, 'acquired');

  const lease = createWindowsManuscriptLifecycleLeaseAdapter()
    .acquireShared(identity);
  lease.release();
  await releaseWorker(child);
});

test('Windows manuscript lifecycle alias canonicalizes before contending on the real lock', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const fixture = createFixture(t);
  const alias = path.join(fixture.root, 'control-alias');
  fs.symlinkSync(fixture.controlDirectory, alias, 'junction');
  const aliasIdentity = platformIdentityForControlPath(alias);
  const realIdentity = platformIdentity(fixture);
  assert.deepEqual(aliasIdentity, realIdentity);

  const child = startWorker(t, aliasIdentity, 'exclusive');
  await waitForLine(child, 'acquired');
  assert.throws(
    () => createWindowsManuscriptLifecycleLeaseAdapter().acquireExclusive(realIdentity),
    { code: 'PROJECT_WRITE_BUSY' },
  );
  await releaseWorker(child);
});

test('Windows manuscript lifecycle contention maps all exclusive combinations to PROJECT_WRITE_BUSY', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const combinations = [
    ['shared', 'exclusive'],
    ['exclusive', 'shared'],
    ['exclusive', 'exclusive'],
  ];
  for (const [ownerMode, contenderMode] of combinations) {
    const fixture = createFixture(t);
    const identity = platformIdentity(fixture);
    const child = startWorker(t, identity, ownerMode);
    await waitForLine(child, 'acquired');
    const adapter = createWindowsManuscriptLifecycleLeaseAdapter();
    assert.throws(
      () => contenderMode === 'exclusive'
        ? adapter.acquireExclusive(identity)
        : adapter.acquireShared(identity),
      (error) => error?.code === 'PROJECT_WRITE_BUSY' && error.cause?.code === 'LEASE_BUSY',
    );
    await releaseWorker(child);
  }
});

test('Windows manuscript lifecycle owner death releases the kernel range lock', {
  skip: process.platform !== 'win32',
  timeout: 30_000,
}, async (t) => {
  const fixture = createFixture(t);
  const identity = platformIdentity(fixture);
  const child = startWorker(t, identity, 'exclusive');
  await waitForLine(child, 'acquired');
  assert.equal(child.kill('SIGKILL'), true);
  await waitForExit(child);

  const lease = createWindowsManuscriptLifecycleLeaseAdapter()
    .acquireExclusive(identity);
  lease.release();
});
