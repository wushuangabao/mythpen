const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { types: { isProxy } } = require('node:util');

const projectWriteCoordinatorModule = require('../project-write-coordinator');
const {
  WriterLeaseLostError,
  createProjectWriteCoordinator,
} = projectWriteCoordinatorModule;
const { acquireExclusiveLease } = require('../platform/durability');
const { openControlStore } = require('../control-store');
const { canonicalDatabasePath, createAtomicStore } = require('../sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { runUntilCrash } = require('../testing/crash-harness');
const { databaseInternals } = require('../testing/database-internals');
const { getWasmBinary } = require('../wasm-binary');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

function createScene(t, prefix = 'mythpen-project-writer-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, 'data');
  const projectsDir = path.join(dataDir, 'projects');
  const locksDir = path.join(dataDir, 'locks');
  fs.mkdirSync(projectsDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    dataDir,
    locksDir,
    projectPath: path.join(projectsDir, 'alpha.mythpen.db'),
    root,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function waitForLine(child, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${JSON.stringify(expected)}; output=${JSON.stringify(output)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Child exited before ${expected}: code=${code} signal=${signal} output=${output}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for child exit'));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

function runWorker(scene, mode) {
  const fixture = path.join(__dirname, 'fixtures', 'project-write-worker.js');
  return spawn(process.execPath, [fixture, mode, scene.locksDir, scene.projectPath], {
    cwd: path.resolve(__dirname, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function collectWorker(scene, mode) {
  const child = runWorker(scene, mode);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function projectLeasePath(dataDir, projectPath) {
  const key = canonicalDatabasePath(projectPath);
  const digest = createHash('sha256').update(key).digest('hex');
  const locksDir = path.join(dataDir, 'locks');
  fs.mkdirSync(locksDir, { recursive: true });
  return path.join(locksDir, `${digest}.lease`);
}

function exactB0CheckpointJob() {
  const verifyCurrent = Object.freeze(function verifyCurrent() {
    return true;
  });
  const installCheckpoint = Object.freeze(function installCheckpoint() {
    return Object.freeze({ checkpointDigest: 'c'.repeat(64), coveredSeq: 1 });
  });
  return Object.freeze({
    snapshot: Object.freeze({
      incarnationId: '11111111-1111-4111-8111-111111111111',
      tail: Object.freeze({ seq: 1, digest: 'a'.repeat(64) }),
      cleanBasisDigest: 'b'.repeat(64),
    }),
    verifyCurrent,
    installCheckpoint,
  });
}

function b1Digest(label) {
  return createHash('sha256').update(`task7-b1:${label}`).digest('hex');
}

function createB1CheckpointJob({
  id = randomUUID(),
  install = () => receipt,
  receipt = Object.freeze({ checkpointDigest: b1Digest(`receipt:${id}`), coveredSeq: 7 }),
  trace = [],
  verify = () => true,
} = {}) {
  const state = { installCalls: 0, verifyCalls: 0 };
  const verifyCurrent = Object.freeze(function verifyCurrent() {
    state.verifyCalls += 1;
    trace.push(`verify:${id}`);
    return verify();
  });
  const installCheckpoint = Object.freeze(function installCheckpoint() {
    state.installCalls += 1;
    trace.push(`install:${id}`);
    return install();
  });
  const job = Object.freeze({
    snapshot: Object.freeze({
      incarnationId: id,
      tail: Object.freeze({ seq: 7, digest: b1Digest(`tail:${id}`) }),
      cleanBasisDigest: b1Digest(`clean:${id}`),
    }),
    verifyCurrent,
    installCheckpoint,
  });
  return { id, installCheckpoint, job, receipt, state, verifyCurrent };
}

function stableTestLease({ onIsHeld = () => {}, onRelease = () => {} } = {}) {
  let held = true;
  return {
    isHeld() {
      onIsHeld();
      return held;
    },
    release() {
      onRelease();
      held = false;
    },
  };
}

function stageB1Checkpoint(coordinator, projectKey, record) {
  return coordinator.withProjectLogicalRequestSync(projectKey, (context) => (
    context.registerPendingCheckpoint(record.job)
  ));
}

function assertCheckpointBlocked(coordinator, projectKey) {
  assert.throws(
    () => coordinator.runPendingProjectMaintenanceSync(projectKey),
    (error) => error?.code === 'CONTROL_CHECKPOINT_BLOCKED',
  );
}

function assertCheckpointReentrant(coordinator, projectKey) {
  assert.throws(
    () => coordinator.runPendingProjectMaintenanceSync(projectKey),
    (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
  );
}

function assertExactFrozenCheckpointJob(record) {
  assert.deepEqual(Reflect.ownKeys(record.job), [
    'snapshot',
    'verifyCurrent',
    'installCheckpoint',
  ]);
  assert.deepEqual(Reflect.ownKeys(record.job.snapshot), [
    'incarnationId',
    'tail',
    'cleanBasisDigest',
  ]);
  assert.deepEqual(Reflect.ownKeys(record.job.snapshot.tail), ['seq', 'digest']);
  assert.equal(Object.getPrototypeOf(record.job), Object.prototype);
  assert.equal(Object.getPrototypeOf(record.job.snapshot), Object.prototype);
  assert.equal(Object.getPrototypeOf(record.job.snapshot.tail), Object.prototype);
  assert.equal(Object.isFrozen(record.job), true);
  assert.equal(Object.isFrozen(record.job.snapshot), true);
  assert.equal(Object.isFrozen(record.job.snapshot.tail), true);
  assert.equal(Object.isFrozen(record.verifyCurrent), true);
  assert.equal(Object.isFrozen(record.installCheckpoint), true);
  assert.equal(record.verifyCurrent.length, 0);
  assert.equal(record.installCheckpoint.length, 0);
  for (const value of [record.job, record.job.snapshot, record.job.snapshot.tail]) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      assert.equal(Object.prototype.hasOwnProperty.call(descriptor, 'value'), true);
      assert.equal(descriptor.enumerable, true);
    }
  }
}

test('Task 7 B0 RED: coordinator brand is hidden and rejects duck or cross-module identities', (t) => {
  const scene = createScene(t, 'mythpen-project-coordinator-brand-');
  const local = createProjectWriteCoordinator({ lockRoot: scene.locksDir });
  const validator = projectWriteCoordinatorModule.isProjectWriteCoordinator;

  assert.deepEqual(Object.keys(projectWriteCoordinatorModule), [
    'ProjectWriteAsyncCallbackError',
    'ProjectWriteBusyError',
    'ProjectWriteReentrancyError',
    'ServiceShuttingDownError',
    'WriterLeaseLostError',
    'canonicalProjectKey',
    'createProjectWriteCoordinator',
  ]);
  assert.equal(typeof validator, 'function');
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(
      projectWriteCoordinatorModule,
      'isProjectWriteCoordinator',
    ),
    {
      configurable: false,
      enumerable: false,
      value: validator,
      writable: false,
    },
  );
  assert.equal(validator(local), true);
  assert.equal(validator({
    assertProjectWriteLease: local.assertProjectWriteLease,
    runPendingProjectMaintenanceSync: local.runPendingProjectMaintenanceSync,
    withProjectLogicalRequestSync: local.withProjectLogicalRequestSync,
  }), false);

  const modulePath = require.resolve('../project-write-coordinator');
  const cachedModule = require.cache[modulePath];
  let foreign;
  try {
    delete require.cache[modulePath];
    const separatelyLoadedModule = require(modulePath);
    foreign = separatelyLoadedModule.createProjectWriteCoordinator({
      lockRoot: path.join(scene.root, 'foreign-locks'),
    });
  } finally {
    delete require.cache[modulePath];
    require.cache[modulePath] = cachedModule;
  }
  assert.equal(validator(foreign), false);
});

test('Task 7 B0 RED: minted authority method identities cannot be reassigned, redefined, or deleted', (t) => {
  const scene = createScene(t, 'mythpen-project-coordinator-authority-identity-');
  const validator = projectWriteCoordinatorModule.isProjectWriteCoordinator;
  const methods = [
    'withProjectLogicalRequestSync',
    'runPendingProjectMaintenanceSync',
    'assertProjectWriteLease',
  ];
  const actions = [
    {
      name: 'assignment',
      run(target, key, replacement) {
        (function strictAssignment() {
          'use strict';
          target[key] = replacement;
        }());
      },
    },
    {
      name: 'defineProperty',
      run(target, key, replacement) {
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          value: replacement,
          writable: true,
        });
      },
    },
    {
      name: 'delete',
      run(target, key) {
        Reflect.deleteProperty(target, key);
      },
    },
  ];
  const observed = [];

  for (const method of methods) {
    for (const action of actions) {
      const coordinator = createProjectWriteCoordinator({
        lockRoot: path.join(scene.locksDir, `${method}-${action.name}`),
      });
      const original = coordinator[method];
      const replacement = function forgedCoordinatorAuthority() {};
      let threw = false;
      try {
        action.run(coordinator, method, replacement);
      } catch (error) {
        threw = error instanceof TypeError;
      }
      const descriptor = Object.getOwnPropertyDescriptor(coordinator, method);
      const identityIntact = descriptor?.value === original && coordinator[method] === original;
      observed.push({
        action: action.name,
        configurable: descriptor?.configurable,
        enumerable: descriptor?.enumerable,
        identityIntact,
        method,
        validator: validator(coordinator),
        writable: descriptor?.writable,
        threw,
      });
    }
  }

  assert.deepEqual(
    observed,
    methods.flatMap((method) => actions.map((action) => ({
      action: action.name,
      configurable: false,
      enumerable: true,
      identityIntact: true,
      method,
      validator: true,
      writable: false,
      threw: action.name !== 'delete',
    }))),
  );
});

test('Task 7 B0 RED: logical requests expose stable APIs and reject nested same-key turns', (t) => {
  const scene = createScene(t, 'mythpen-project-logical-request-');
  const aliasParent = path.join(scene.root, 'projects-alias');
  fs.symlinkSync(
    path.dirname(scene.projectPath),
    aliasParent,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const aliasProjectPath = path.join(aliasParent, path.basename(scene.projectPath));
  let acquireCalls = 0;
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      acquireCalls += 1;
      let held = true;
      return {
        isHeld() {
          return held;
        },
        release() {
          held = false;
        },
      };
    },
    lockRoot: scene.locksDir,
    recoverProject() {
      assert.fail('logical request must not run automatic recovery');
    },
  });
  const logicalRequest = coordinator.withProjectLogicalRequestSync;
  const maintenance = coordinator.runPendingProjectMaintenanceSync;

  assert.equal(typeof logicalRequest, 'function');
  assert.equal(logicalRequest.length, 2);
  assert.equal(coordinator.withProjectLogicalRequestSync, logicalRequest);
  assert.equal(typeof maintenance, 'function');
  assert.equal(maintenance.length, 1);
  assert.equal(coordinator.runPendingProjectMaintenanceSync, maintenance);
  assert.deepEqual(Object.keys(coordinator).sort(), [
    'admissionState',
    'assertProjectWriteLease',
    'beginQuiesce',
    'cancelQuiesce',
    'drain',
    'leaseAcquisitionCount',
    'runPendingProjectMaintenanceSync',
    'withProjectLogicalRequestSync',
    'withProjectRecoveryLeaseSync',
    'withProjectWrite',
    'withProjectWriteSync',
  ]);

  let leakedRegister;
  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');
  assert.equal(
    logicalRequest(scene.projectPath, (context) => {
      assert.equal(context.assertLease(), true);
      assert.equal(typeof context.registerPendingCheckpoint, 'function');
      assert.equal(context.registerPendingCheckpoint.length, 1);
      leakedRegister = context.registerPendingCheckpoint;
      assert.throws(
        () => logicalRequest(aliasProjectPath, () => 'nested-canonical-alias'),
        (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
      );
      assert.equal(acquireCalls, 1, 'canonical alias must fail before a second lease acquire');
      assert.throws(
        () => logicalRequest(betaPath, () => 'nested-cross-key'),
        (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
      );
      assert.equal(acquireCalls, 1, 'cross-key nesting must fail before a second lease acquire');
      return 'outer-result';
    }),
    'outer-result',
  );
  assert.throws(
    () => leakedRegister(exactB0CheckpointJob()),
    (error) => error?.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
  );
  assert.equal(acquireCalls, 1);
  assert.equal(coordinator.leaseAcquisitionCount(scene.projectPath), 1);
  assert.throws(
    () => maintenance(scene.projectPath),
    (error) => error?.code === 'CONTROL_CHECKPOINT_BLOCKED',
  );
});

test('Task 7 B0 control: only logical callback contexts expose checkpoint registration', async (t) => {
  const scene = createScene(t, 'mythpen-project-logical-context-boundary-');
  const ordinaryKeys = [
    'assertLease',
    'canonicalProjectKey',
    'coordinatorId',
    'leasePath',
    'ownershipToken',
    'reentrant',
  ].sort();
  const observed = [];
  const coordinator = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject(_canonicalKey, context) {
      observed.push({ kind: 'recovery', context });
    },
  });
  function capture(kind) {
    return (context) => {
      observed.push({ kind, context });
      return kind;
    };
  }

  assert.equal(await coordinator.withProjectWrite(scene.projectPath, capture('async-write')), 'async-write');
  assert.equal(coordinator.withProjectWriteSync(scene.projectPath, capture('sync-write')), 'sync-write');
  assert.equal(
    coordinator.withProjectRecoveryLeaseSync(scene.projectPath, capture('recovery-lease')),
    'recovery-lease',
  );
  assert.equal(
    coordinator.withProjectLogicalRequestSync(scene.projectPath, capture('logical')),
    'logical',
  );

  for (const current of observed) {
    const hasRegister = Object.prototype.hasOwnProperty.call(
      current.context,
      'registerPendingCheckpoint',
    );
    if (current.kind === 'logical') {
      assert.equal(hasRegister, true);
      assert.equal(typeof current.context.registerPendingCheckpoint, 'function');
      assert.deepEqual(
        Object.keys(current.context).sort(),
        [...ordinaryKeys, 'registerPendingCheckpoint'].sort(),
      );
    } else {
      assert.equal(hasRegister, false, current.kind);
      assert.equal(current.context.registerPendingCheckpoint, undefined, current.kind);
      assert.deepEqual(Object.keys(current.context).sort(), ordinaryKeys, current.kind);
    }
  }
  assert.deepEqual(
    observed.map(({ kind }) => kind),
    ['recovery', 'async-write', 'recovery', 'sync-write', 'recovery-lease', 'logical'],
  );
});

test('Task 7 B1 control: pending checkpoint jobs reject every inexact descriptor without staging', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-job-shape-');
  const valid = createB1CheckpointJob();
  let accessorReads = 0;
  const accessorJob = {};
  Object.defineProperty(accessorJob, 'snapshot', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('job accessor must not run');
    },
  });
  Object.defineProperty(accessorJob, 'verifyCurrent', {
    enumerable: true,
    value: valid.verifyCurrent,
  });
  Object.defineProperty(accessorJob, 'installCheckpoint', {
    enumerable: true,
    value: valid.installCheckpoint,
  });
  Object.freeze(accessorJob);
  const symbolJob = Object.freeze({ ...valid.job, [Symbol('forbidden')]: true });
  const customPrototypeJob = Object.freeze(Object.assign(
    Object.create({ inherited: true }),
    valid.job,
  ));
  const mutableSnapshot = Object.freeze({
    ...valid.job,
    snapshot: { ...valid.job.snapshot },
  });
  const mutableTail = Object.freeze({
    ...valid.job,
    snapshot: Object.freeze({
      ...valid.job.snapshot,
      tail: { ...valid.job.snapshot.tail },
    }),
  });
  const nonZeroVerify = Object.freeze({
    ...valid.job,
    verifyCurrent: Object.freeze(function verifyCurrent(_forbidden) { return true; }),
  });
  const thenableJob = Object.freeze({
    ...valid.job,
    then: Object.freeze(function then() {}),
  });
  const throwingPrototypeProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error('job prototype trap');
    },
  });
  const throwingOwnKeysProxy = new Proxy({}, {
    getPrototypeOf() {
      return Object.prototype;
    },
    ownKeys() {
      throw new Error('job ownKeys trap');
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const omit = (value, key) => Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  ));
  const withSnapshot = (snapshot) => Object.freeze({ ...valid.job, snapshot });
  const withTail = (tail) => withSnapshot(Object.freeze({
    ...valid.job.snapshot,
    tail,
  }));
  const snapshotAccessor = {};
  Object.defineProperties(snapshotAccessor, {
    incarnationId: {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('snapshot accessor must not run');
      },
    },
    tail: { enumerable: true, value: valid.job.snapshot.tail },
    cleanBasisDigest: { enumerable: true, value: valid.job.snapshot.cleanBasisDigest },
  });
  Object.freeze(snapshotAccessor);
  const tailAccessor = {};
  Object.defineProperties(tailAccessor, {
    seq: { enumerable: true, value: valid.job.snapshot.tail.seq },
    digest: {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('tail accessor must not run');
      },
    },
  });
  Object.freeze(tailAccessor);
  const verifyAccessorJob = {
    snapshot: valid.job.snapshot,
    installCheckpoint: valid.installCheckpoint,
  };
  Object.defineProperty(verifyAccessorJob, 'verifyCurrent', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('verify accessor must not run');
    },
  });
  Object.freeze(verifyAccessorJob);
  const installAccessorJob = {
    snapshot: valid.job.snapshot,
    verifyCurrent: valid.verifyCurrent,
  };
  Object.defineProperty(installAccessorJob, 'installCheckpoint', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('install accessor must not run');
    },
  });
  Object.freeze(installAccessorJob);
  const verifyThenable = function verifyCurrent() { return true; };
  Object.defineProperty(verifyThenable, 'then', {
    enumerable: true,
    value: Object.freeze(function then() {}),
  });
  Object.freeze(verifyThenable);
  const installThenable = function installCheckpoint() { return valid.receipt; };
  Object.defineProperty(installThenable, 'then', {
    enumerable: true,
    value: Object.freeze(function then() {}),
  });
  Object.freeze(installThenable);
  const verifyThenAccessor = function verifyCurrent() { return true; };
  Object.defineProperty(verifyThenAccessor, 'then', {
    enumerable: true,
    get() {
      accessorReads += 1;
      throw new Error('function then accessor must not run');
    },
  });
  Object.freeze(verifyThenAccessor);
  const nonEnumerableJob = {};
  Object.defineProperties(nonEnumerableJob, {
    snapshot: { enumerable: false, value: valid.job.snapshot },
    verifyCurrent: { enumerable: true, value: valid.verifyCurrent },
    installCheckpoint: { enumerable: true, value: valid.installCheckpoint },
  });
  Object.freeze(nonEnumerableJob);
  const cases = [
    ['null', null],
    ...Reflect.ownKeys(valid.job).map((key) => [
      `job missing ${String(key)}`,
      omit(valid.job, key),
    ]),
    ...Reflect.ownKeys(valid.job.snapshot).map((key) => [
      `snapshot missing ${String(key)}`,
      withSnapshot(omit(valid.job.snapshot, key)),
    ]),
    ...Reflect.ownKeys(valid.job.snapshot.tail).map((key) => [
      `tail missing ${String(key)}`,
      withTail(omit(valid.job.snapshot.tail, key)),
    ]),
    ['job extra key', Object.freeze({ ...valid.job, extra: true })],
    ['snapshot extra key', withSnapshot(Object.freeze({ ...valid.job.snapshot, extra: true }))],
    ['tail extra key', withTail(Object.freeze({ ...valid.job.snapshot.tail, extra: true }))],
    ['job accessor', accessorJob],
    ['snapshot accessor', withSnapshot(snapshotAccessor)],
    ['tail accessor', withTail(tailAccessor)],
    ['verify accessor', verifyAccessorJob],
    ['install accessor', installAccessorJob],
    ['job symbol', symbolJob],
    ['snapshot symbol', withSnapshot(Object.freeze({
      ...valid.job.snapshot,
      [Symbol('forbidden')]: true,
    }))],
    ['tail symbol', withTail(Object.freeze({
      ...valid.job.snapshot.tail,
      [Symbol('forbidden')]: true,
    }))],
    ['job custom prototype', customPrototypeJob],
    ['snapshot custom prototype', withSnapshot(Object.freeze(Object.assign(
      Object.create({ inherited: true }),
      valid.job.snapshot,
    )))],
    ['tail custom prototype', withTail(Object.freeze(Object.assign(
      Object.create({ inherited: true }),
      valid.job.snapshot.tail,
    )))],
    ['job non-enumerable key', nonEnumerableJob],
    ['mutable job', { ...valid.job }],
    ['mutable snapshot', mutableSnapshot],
    ['mutable tail', mutableTail],
    ['mutable verify function', Object.freeze({
      ...valid.job,
      verifyCurrent() { return true; },
    })],
    ['mutable install function', Object.freeze({
      ...valid.job,
      installCheckpoint() { return valid.receipt; },
    })],
    ['non-zero verify', nonZeroVerify],
    ['non-zero install', Object.freeze({
      ...valid.job,
      installCheckpoint: Object.freeze(function installCheckpoint(_forbidden) {
        return valid.receipt;
      }),
    })],
    ['thenable-shaped job', thenableJob],
    ['thenable-shaped verify', Object.freeze({ ...valid.job, verifyCurrent: verifyThenable })],
    ['thenable-shaped install', Object.freeze({
      ...valid.job,
      installCheckpoint: installThenable,
    })],
    ['then accessor on verify', Object.freeze({
      ...valid.job,
      verifyCurrent: verifyThenAccessor,
    })],
    ['throwing prototype proxy', throwingPrototypeProxy],
    ['throwing ownKeys proxy', throwingOwnKeysProxy],
    ['revoked proxy', revoked.proxy],
  ];

  for (const [name, job] of cases) {
    const coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, name.replaceAll(' ', '-')),
    });
    assert.equal(
      coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
        assert.throws(
          () => context.registerPendingCheckpoint(job),
          (error) => error instanceof TypeError && error.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
          name,
        );
        return name;
      }),
      name,
    );
    assertCheckpointBlocked(coordinator, scene.projectPath);
  }
  assert.equal(accessorReads, 0);
  assert.deepEqual(valid.state, { installCalls: 0, verifyCalls: 0 });
});

test('Task 7 B1 RED: verify and install functions reject extra string, symbol, or accessor keys', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-function-shape-');
  const valid = createB1CheckpointJob();
  let accessorReads = 0;
  function functionWithExtra(kind, propertyKind) {
    const candidate = kind === 'verify'
      ? function verifyCurrent() { return true; }
      : function installCheckpoint() { return valid.receipt; };
    if (propertyKind === 'string') {
      Object.defineProperty(candidate, 'extra', {
        enumerable: true,
        value: true,
      });
    } else if (propertyKind === 'symbol') {
      Object.defineProperty(candidate, Symbol('forbidden'), {
        enumerable: true,
        value: true,
      });
    } else {
      Object.defineProperty(candidate, 'extra', {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error('function extra accessor must not run');
        },
      });
    }
    return Object.freeze(candidate);
  }
  const rows = ['string', 'symbol', 'accessor'].flatMap((propertyKind) => [
    [
      `verify-${propertyKind}`,
      Object.freeze({
        ...valid.job,
        verifyCurrent: functionWithExtra('verify', propertyKind),
      }),
    ],
    [
      `install-${propertyKind}`,
      Object.freeze({
        ...valid.job,
        installCheckpoint: functionWithExtra('install', propertyKind),
      }),
    ],
  ]);

  for (const [name, job] of rows) {
    const coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, name),
    });
    coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
      assert.throws(
        () => context.registerPendingCheckpoint(job),
        (error) => error instanceof TypeError && error.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
        name,
      );
    });
    assertCheckpointBlocked(coordinator, scene.projectPath);
  }
  assert.equal(accessorReads, 0);
  assert.deepEqual(valid.state, { installCalls: 0, verifyCalls: 0 });
});

test('Task 7 B1 RED: transparent Proxy jobs and functions are detectably rejected', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-transparent-proxy-');
  const valid = createB1CheckpointJob();
  const proxiedJob = new Proxy(valid.job, {});
  const proxiedSnapshot = new Proxy(valid.job.snapshot, {});
  const proxiedTail = new Proxy(valid.job.snapshot.tail, {});
  const proxiedVerify = new Proxy(valid.verifyCurrent, {});
  const proxiedInstall = new Proxy(valid.installCheckpoint, {});
  const rows = [
    ['job', proxiedJob],
    ['snapshot', Object.freeze({ ...valid.job, snapshot: proxiedSnapshot })],
    ['tail', Object.freeze({
      ...valid.job,
      snapshot: Object.freeze({ ...valid.job.snapshot, tail: proxiedTail }),
    })],
    ['verify', Object.freeze({ ...valid.job, verifyCurrent: proxiedVerify })],
    ['install', Object.freeze({ ...valid.job, installCheckpoint: proxiedInstall })],
  ];
  assert.equal(isProxy(proxiedJob), true);
  assert.equal(isProxy(proxiedSnapshot), true);
  assert.equal(isProxy(proxiedTail), true);
  assert.equal(isProxy(proxiedVerify), true);
  assert.equal(isProxy(proxiedInstall), true);

  for (const [name, job] of rows) {
    const coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, name),
    });
    coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
      assert.throws(
        () => context.registerPendingCheckpoint(job),
        (error) => error instanceof TypeError && error.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
        name,
      );
    });
    assertCheckpointBlocked(coordinator, scene.projectPath);
  }
  assert.deepEqual(valid.state, { installCalls: 0, verifyCalls: 0 });
});

test('Task 7 B1 RED: hostile function Proxy traps are never invoked during validation', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-function-proxy-trap-');
  const valid = createB1CheckpointJob();
  let trapReads = 0;
  function hostileProxy(target) {
    return new Proxy(target, {
      getPrototypeOf() {
        trapReads += 1;
        throw new Error('function Proxy prototype trap must not run');
      },
    });
  }
  const rows = [
    ['verify', Object.freeze({
      ...valid.job,
      verifyCurrent: hostileProxy(valid.verifyCurrent),
    })],
    ['install', Object.freeze({
      ...valid.job,
      installCheckpoint: hostileProxy(valid.installCheckpoint),
    })],
  ];

  for (const [name, job] of rows) {
    const coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, name),
    });
    coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
      assert.throws(
        () => context.registerPendingCheckpoint(job),
        (error) => error instanceof TypeError && error.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
        name,
      );
    });
    assertCheckpointBlocked(coordinator, scene.projectPath);
  }
  assert.equal(trapReads, 0);
  assert.deepEqual(valid.state, { installCalls: 0, verifyCalls: 0 });
});

test('Task 7 B1 RED: register is at-most-once, callback-active, and project-bound', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-register-');
  const coordinator = createProjectWriteCoordinator({ lockRoot: scene.locksDir });
  const first = createB1CheckpointJob({ id: '11111111-1111-4111-8111-111111111111' });
  const duplicate = createB1CheckpointJob({ id: '22222222-2222-4222-8222-222222222222' });
  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');
  let leakedRegister;

  assertExactFrozenCheckpointJob(first);

  assert.equal(
    coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
      leakedRegister = context.registerPendingCheckpoint;
      assert.equal(context.registerPendingCheckpoint(first.job), undefined);
      assert.throws(
        () => context.registerPendingCheckpoint(duplicate.job),
        (error) => error?.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
      );
      return 'logical-complete';
    }),
    'logical-complete',
  );
  assert.throws(
    () => leakedRegister(duplicate.job),
    (error) => error?.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
  );
  assert.equal(
    coordinator.withProjectLogicalRequestSync(betaPath, () => {
      assert.throws(
        () => leakedRegister(duplicate.job),
        (error) => error?.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
      );
      return 'foreign-project-complete';
    }),
    'foreign-project-complete',
  );
  assert.equal(
    coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
    first.receipt,
  );
  assert.deepEqual(first.state, { installCalls: 1, verifyCalls: 1 });
  assert.deepEqual(duplicate.state, { installCalls: 0, verifyCalls: 0 });
  assertCheckpointBlocked(coordinator, scene.projectPath);
});

test('Task 7 B1 RED: an invalid registration attempt consumes the callback at-most-once right', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-invalid-attempt-');
  const coordinator = createProjectWriteCoordinator({ lockRoot: scene.locksDir });
  const valid = createB1CheckpointJob();

  coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
    assert.throws(
      () => context.registerPendingCheckpoint(null),
      (error) => error instanceof TypeError && error.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
    );
    assert.throws(
      () => context.registerPendingCheckpoint(valid.job),
      (error) => error instanceof TypeError && error.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
    );
  });
  assertCheckpointBlocked(coordinator, scene.projectPath);
  assert.deepEqual(valid.state, { installCalls: 0, verifyCalls: 0 });
});

test('Task 7 B1 RED: stale register ownership and nested logical reentrancy cannot alter pending identity', async (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-register-stale-');
  const coordinator = createProjectWriteCoordinator({ lockRoot: scene.locksDir });
  const alpha = createB1CheckpointJob({ id: '55555555-5555-4555-8555-555555555555' });
  const forbidden = createB1CheckpointJob({ id: '66666666-6666-4666-8666-666666666666' });
  const beta = createB1CheckpointJob({ id: '77777777-7777-4777-8777-777777777777' });
  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');
  let staleCall;

  coordinator.withProjectLogicalRequestSync(betaPath, (context) => {
    context.registerPendingCheckpoint(beta.job);
  });
  coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
    context.registerPendingCheckpoint(alpha.job);
    staleCall = Promise.resolve().then(() => {
      assert.throws(
        () => context.registerPendingCheckpoint(forbidden.job),
        (error) => error?.code === 'PROJECT_CHECKPOINT_JOB_INVALID',
      );
    });
    assert.throws(
      () => coordinator.withProjectLogicalRequestSync(scene.projectPath, () => {
        assert.fail('same-key nested logical callback must not run');
      }),
      (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
    );
    assert.throws(
      () => coordinator.withProjectLogicalRequestSync(betaPath, () => {
        assert.fail('cross-key nested logical callback must not run');
      }),
      (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
    );
  });

  await staleCall;
  assert.equal(coordinator.runPendingProjectMaintenanceSync(scene.projectPath), alpha.receipt);
  assert.equal(coordinator.runPendingProjectMaintenanceSync(betaPath), beta.receipt);
  assert.deepEqual(alpha.state, { installCalls: 1, verifyCalls: 1 });
  assert.deepEqual(beta.state, { installCalls: 1, verifyCalls: 1 });
  assert.deepEqual(forbidden.state, { installCalls: 0, verifyCalls: 0 });
});

test('Task 7 B1 RED: pending publication follows final validation and known-success release', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-publication-order-');
  const trace = [];
  const record = createB1CheckpointJob({ trace });
  let acquisition = 0;
  let callbackReturned = false;
  let coordinator;
  coordinator = createProjectWriteCoordinator({
    acquireLease() {
      acquisition += 1;
      const current = acquisition;
      return stableTestLease({
        onIsHeld() {
          if (current === 1 && callbackReturned) trace.push('final-validation');
        },
        onRelease() {
          trace.push(`release:${current}:start`);
          if (current === 1) {
            assertCheckpointBlocked(coordinator, scene.projectPath);
            trace.push('release:1:pending-not-visible');
          }
          trace.push(`release:${current}:end`);
        },
      });
    },
    lockRoot: scene.locksDir,
    recoverProject() {
      assert.fail('logical request and maintenance runner must both use recover:false');
    },
  });

  assert.equal(
    coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
      trace.push('callback');
      assert.equal(context.registerPendingCheckpoint(record.job), undefined);
      assertCheckpointReentrant(coordinator, scene.projectPath);
      trace.push('callback:pending-not-visible');
      callbackReturned = true;
      return 'logical-result';
    }),
    'logical-result',
  );
  trace.push('logical:return');
  assert.equal(coordinator.runPendingProjectMaintenanceSync(scene.projectPath), record.receipt);
  assert.deepEqual(record.state, { installCalls: 1, verifyCalls: 1 });
  assert.ok(trace.indexOf('callback') < trace.indexOf('final-validation'));
  assert.ok(trace.indexOf('final-validation') < trace.indexOf('release:1:start'));
  assert.ok(trace.indexOf('release:1:end') < trace.indexOf('logical:return'));
  assert.ok(trace.indexOf('logical:return') < trace.indexOf(`verify:${record.id}`));
});

test('Task 7 B1 RED: callback and singular-release failures publish no pending job', async (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-publication-failure-');
  const callbackMarker = new Error('logical callback failure');
  const releaseMarker = new Error('logical release failure');
  const rows = [
    {
      name: 'callback throw',
      invoke(context) {
        context.registerPendingCheckpoint(this.record.job);
        throw callbackMarker;
      },
      expected(error) { return error === callbackMarker; },
    },
    {
      name: 'callback thenable',
      invoke(context) {
        context.registerPendingCheckpoint(this.record.job);
        return Promise.resolve('forbidden');
      },
      expected(error) { return error?.code === 'PROJECT_WRITE_ASYNC_CALLBACK'; },
    },
    {
      name: 'release failure',
      failRelease: true,
      invoke(context) {
        context.registerPendingCheckpoint(this.record.job);
        return 'must-not-escape';
      },
      expected(error) {
        return error?.code === 'WRITER_LEASE_LOST' && error.cause === releaseMarker;
      },
    },
    {
      name: 'callback plus release failure',
      failRelease: true,
      invoke(context) {
        context.registerPendingCheckpoint(this.record.job);
        throw callbackMarker;
      },
      expected(error) {
        return error?.code === 'WRITER_LEASE_LOST'
          && error.cause === releaseMarker
          && error.callbackError === callbackMarker;
      },
    },
    {
      name: 'lease loss before publication',
      loseBeforeReturn: true,
      invoke(context) {
        context.registerPendingCheckpoint(this.record.job);
        this.held = false;
        return 'must-not-escape';
      },
      expected(error) { return error?.code === 'WRITER_LEASE_LOST'; },
    },
  ];

  for (const row of rows) {
    row.record = createB1CheckpointJob();
    row.held = true;
    let releaseCalls = 0;
    let acquisitions = 0;
    const coordinator = createProjectWriteCoordinator({
      acquireLease() {
        acquisitions += 1;
        if (acquisitions > 1) return stableTestLease();
        return {
          isHeld() { return row.held; },
          release() {
            releaseCalls += 1;
            if (row.failRelease) throw releaseMarker;
            row.held = false;
          },
        };
      },
      lockRoot: path.join(scene.locksDir, row.name.replaceAll(' ', '-')),
    });
    assert.throws(
      () => coordinator.withProjectLogicalRequestSync(
        scene.projectPath,
        (context) => row.invoke(context),
      ),
      row.expected,
      row.name,
    );
    assertCheckpointBlocked(coordinator, scene.projectPath);
    assert.deepEqual(row.record.state, { installCalls: 0, verifyCalls: 0 }, row.name);
    if (!row.loseBeforeReturn) assert.equal(releaseCalls, 1, row.name);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('Task 7 B1 RED: every later same-key outer turn invalidates before failing work', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-invalidation-');
  const marker = new Error('later same-key turn failed');
  const rows = [
    {
      name: 'async write',
      needsRecovery: true,
      invoke(coordinator) {
        return coordinator.withProjectWrite(scene.projectPath, () => {
          assert.fail('recoverProject must fail before callback');
        });
      },
    },
    {
      name: 'sync write',
      needsRecovery: true,
      invoke(coordinator) {
        return coordinator.withProjectWriteSync(scene.projectPath, () => {
          assert.fail('recoverProject must fail before callback');
        });
      },
    },
    {
      name: 'recovery lease',
      invoke(coordinator) {
        return coordinator.withProjectRecoveryLeaseSync(scene.projectPath, () => {
          assertCheckpointReentrant(coordinator, scene.projectPath);
          throw marker;
        });
      },
    },
    {
      name: 'logical request',
      invoke(coordinator) {
        return coordinator.withProjectLogicalRequestSync(scene.projectPath, () => {
          assertCheckpointReentrant(coordinator, scene.projectPath);
          throw marker;
        });
      },
    },
  ];

  for (const row of rows) {
    const record = createB1CheckpointJob();
    let checkingLaterTurn = false;
    let coordinator;
    coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, row.name.replaceAll(' ', '-')),
      recoverProject() {
        if (!checkingLaterTurn) return;
        assertCheckpointReentrant(coordinator, scene.projectPath);
        throw marker;
      },
    });
    stageB1Checkpoint(coordinator, scene.projectPath, record);
    checkingLaterTurn = true;
    assert.throws(() => row.invoke(coordinator), (error) => error === marker, row.name);
    assertCheckpointBlocked(coordinator, scene.projectPath);
    assert.deepEqual(record.state, { installCalls: 0, verifyCalls: 0 }, row.name);
  }
});

test('Task 7 B1 RED: canonical aliases invalidate while different keys preserve pending identity', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-key-isolation-');
  const aliasParent = path.join(scene.root, 'projects-alias');
  fs.symlinkSync(
    path.dirname(scene.projectPath),
    aliasParent,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const aliasProjectPath = path.join(aliasParent, path.basename(scene.projectPath));
  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');

  const aliasRecord = createB1CheckpointJob();
  const aliasCoordinator = createProjectWriteCoordinator({
    lockRoot: path.join(scene.locksDir, 'alias'),
  });
  stageB1Checkpoint(aliasCoordinator, scene.projectPath, aliasRecord);
  assert.throws(
    () => aliasCoordinator.withProjectLogicalRequestSync(aliasProjectPath, () => {
      assertCheckpointReentrant(aliasCoordinator, scene.projectPath);
      throw new Error('alias failure');
    }),
    /alias failure/,
  );
  assertCheckpointBlocked(aliasCoordinator, scene.projectPath);
  assert.deepEqual(aliasRecord.state, { installCalls: 0, verifyCalls: 0 });

  const isolatedRecord = createB1CheckpointJob();
  const isolatedCoordinator = createProjectWriteCoordinator({
    lockRoot: path.join(scene.locksDir, 'different-key'),
  });
  stageB1Checkpoint(isolatedCoordinator, scene.projectPath, isolatedRecord);
  assert.equal(
    isolatedCoordinator.withProjectLogicalRequestSync(betaPath, () => 'beta-complete'),
    'beta-complete',
  );
  assert.equal(
    isolatedCoordinator.runPendingProjectMaintenanceSync(scene.projectPath),
    isolatedRecord.receipt,
  );
  assert.deepEqual(isolatedRecord.state, { installCalls: 1, verifyCalls: 1 });
});

test('Task 7 B1 RED: a successful same-key logical turn replaces the prior pending checkpoint job', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-replacement-');
  const coordinator = createProjectWriteCoordinator({ lockRoot: scene.locksDir });
  const first = createB1CheckpointJob({ id: '33333333-3333-4333-8333-333333333333' });
  const replacement = createB1CheckpointJob({ id: '44444444-4444-4444-8444-444444444444' });
  stageB1Checkpoint(coordinator, scene.projectPath, first);
  stageB1Checkpoint(coordinator, scene.projectPath, replacement);

  assert.equal(
    coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
    replacement.receipt,
  );
  assert.deepEqual(first.state, { installCalls: 0, verifyCalls: 0 });
  assert.deepEqual(replacement.state, { installCalls: 1, verifyCalls: 1 });
  assertCheckpointBlocked(coordinator, scene.projectPath);
});

test('Task 7 B1 RED: admission and lease acquisition failures retain pending checkpoint work', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-acquire-retention-');
  const rows = [
    {
      name: 'lease busy',
      marker: Object.assign(new Error('maintenance lease busy'), { code: 'LEASE_BUSY' }),
      expected(error, marker) {
        return error?.code === 'PROJECT_WRITE_BUSY' && error.cause === marker;
      },
    },
    {
      name: 'lease acquisition failure',
      marker: new Error('maintenance lease acquisition failed'),
      expected(error, marker) { return error === marker; },
    },
  ];

  for (const row of rows) {
    let acquisitions = 0;
    let recoveries = 0;
    const record = createB1CheckpointJob();
    const coordinator = createProjectWriteCoordinator({
      acquireLease() {
        acquisitions += 1;
        if (acquisitions === 2) throw row.marker;
        return stableTestLease();
      },
      lockRoot: path.join(scene.locksDir, row.name.replaceAll(' ', '-')),
      recoverProject() { recoveries += 1; },
    });
    stageB1Checkpoint(coordinator, scene.projectPath, record);
    assert.throws(
      () => coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
      (error) => row.expected(error, row.marker),
      row.name,
    );
    assert.deepEqual(record.state, { installCalls: 0, verifyCalls: 0 }, row.name);
    assert.equal(
      coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
      record.receipt,
      row.name,
    );
    assert.deepEqual(record.state, { installCalls: 1, verifyCalls: 1 }, row.name);
    assert.equal(recoveries, 0, row.name);
    assert.equal(acquisitions, 3, row.name);
  }

  const quiesceRecord = createB1CheckpointJob();
  const quiesceCoordinator = createProjectWriteCoordinator({
    lockRoot: path.join(scene.locksDir, 'quiesce'),
  });
  stageB1Checkpoint(quiesceCoordinator, scene.projectPath, quiesceRecord);
  const quiesce = quiesceCoordinator.beginQuiesce();
  assert.throws(
    () => quiesceCoordinator.runPendingProjectMaintenanceSync(scene.projectPath),
    (error) => error?.code === 'SERVICE_SHUTTING_DOWN',
  );
  quiesceCoordinator.cancelQuiesce(quiesce);
  assert.equal(
    quiesceCoordinator.runPendingProjectMaintenanceSync(scene.projectPath),
    quiesceRecord.receipt,
  );
  assert.deepEqual(quiesceRecord.state, { installCalls: 1, verifyCalls: 1 });
});

test('Task 7 B1 RED: maintenance uses a new recover-free ownership lease', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-new-lease-');
  const leaseIds = [];
  let activeLeaseId = null;
  let recoveries = 0;
  let stagedLeaseId;
  let verifiedLeaseId;
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      const id = leaseIds.length + 1;
      leaseIds.push(id);
      activeLeaseId = id;
      return stableTestLease({
        onRelease() {
          activeLeaseId = null;
        },
      });
    },
    lockRoot: scene.locksDir,
    recoverProject() { recoveries += 1; },
  });
  let record;
  coordinator.withProjectLogicalRequestSync(scene.projectPath, (context) => {
    stagedLeaseId = activeLeaseId;
    record = createB1CheckpointJob({
      verify() {
        verifiedLeaseId = activeLeaseId;
        assert.equal(coordinator.assertProjectWriteLease(scene.projectPath), true);
        return true;
      },
    });
    context.registerPendingCheckpoint(record.job);
  });
  assert.equal(activeLeaseId, null);
  assert.equal(coordinator.runPendingProjectMaintenanceSync(scene.projectPath), record.receipt);
  assert.deepEqual(leaseIds, [1, 2]);
  assert.equal(stagedLeaseId, 1);
  assert.equal(verifiedLeaseId, 2);
  assert.notEqual(verifiedLeaseId, stagedLeaseId);
  assert.equal(recoveries, 0);
  assert.deepEqual(record.state, { installCalls: 1, verifyCalls: 1 });
});

test('Task 7 B1 RED: verify false, throw, spoof, proxy, and thenable consume once', async (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-verify-matrix-');
  const marker = new Error('verify threw');
  const spoof = {};
  let spoofCodeReads = 0;
  Object.defineProperty(spoof, 'code', {
    get() {
      spoofCodeReads += 1;
      throw new Error('verify cause code getter must not run');
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const rows = [
    {
      name: 'false',
      verify: () => false,
      expected(error) { return error?.code === 'RECOVERY_REQUIRED'; },
    },
    {
      name: 'throw',
      verify() { throw marker; },
      expected(error) {
        return error?.code === 'RECOVERY_REQUIRED' && error.cause === marker;
      },
    },
    {
      name: 'spoof error',
      verify() { throw spoof; },
      expected(error) {
        return error !== spoof
          && error?.code === 'RECOVERY_REQUIRED'
          && error.cause === spoof;
      },
    },
    {
      name: 'revoked proxy error',
      verify() { throw revoked.proxy; },
      expected(error) {
        return error?.code === 'RECOVERY_REQUIRED' && error.cause === revoked.proxy;
      },
    },
    {
      name: 'thenable',
      verify: () => Promise.resolve(true),
      expected(error) { return error?.code === 'PROJECT_WRITE_ASYNC_CALLBACK'; },
    },
  ];

  for (const row of rows) {
    const coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, row.name.replaceAll(' ', '-')),
    });
    const record = createB1CheckpointJob({ verify: row.verify });
    stageB1Checkpoint(coordinator, scene.projectPath, record);
    assert.throws(
      () => coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
      row.expected,
      row.name,
    );
    assert.deepEqual(record.state, { installCalls: 0, verifyCalls: 1 }, row.name);
    assertCheckpointBlocked(coordinator, scene.projectPath);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spoofCodeReads, 0);
});

test('Task 7 B1 RED: missing maintenance avoids acquisition and real lease busy preserves pending checkpoint identity', async (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-real-busy-');
  const held = deferred();
  const pending = createB1CheckpointJob();
  const coordinatorA = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject() {
      assert.fail('maintenance must not recover the project');
    },
  });
  const coordinatorB = createProjectWriteCoordinator({ lockRoot: scene.locksDir });

  assertCheckpointBlocked(coordinatorA, scene.projectPath);
  assert.equal(coordinatorA.leaseAcquisitionCount(scene.projectPath), 0);
  stageB1Checkpoint(coordinatorA, scene.projectPath, pending);
  const foreignWrite = coordinatorB.withProjectWrite(scene.projectPath, () => held.promise);
  try {
    assert.throws(
      () => coordinatorA.runPendingProjectMaintenanceSync(scene.projectPath),
      (error) => error?.code === 'PROJECT_WRITE_BUSY',
    );
  } finally {
    held.resolve('foreign-complete');
    assert.equal(await foreignWrite, 'foreign-complete');
  }
  assert.deepEqual(pending.state, { installCalls: 0, verifyCalls: 0 });
  assert.equal(
    coordinatorA.runPendingProjectMaintenanceSync(scene.projectPath),
    pending.receipt,
  );
  assert.deepEqual(pending.state, { installCalls: 1, verifyCalls: 1 });
});

test('Task 7 B1 RED: an owned write cannot nest cross-key maintenance or bypass quiesce admission', async (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-runner-nesting-');
  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');
  for (const quiesceInsideOuter of [false, true]) {
    const record = createB1CheckpointJob();
    const coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, quiesceInsideOuter ? 'quiesce' : 'running'),
    });
    stageB1Checkpoint(coordinator, betaPath, record);
    let drainPromise;
    let quiesce;

    assert.equal(
      coordinator.withProjectWriteSync(scene.projectPath, () => {
        if (quiesceInsideOuter) {
          quiesce = coordinator.beginQuiesce();
          drainPromise = coordinator.drain(quiesce);
          assert.equal(Bun.peek.status(drainPromise), 'pending');
        }
        assert.throws(
          () => coordinator.runPendingProjectMaintenanceSync(betaPath),
          (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
        );
        assert.deepEqual(record.state, { installCalls: 0, verifyCalls: 0 });
        return 'outer-complete';
      }),
      'outer-complete',
    );
    if (quiesceInsideOuter) {
      assert.equal(Bun.peek.status(drainPromise), 'fulfilled');
      await drainPromise;
      coordinator.cancelQuiesce(quiesce);
    }
    assert.equal(
      coordinator.runPendingProjectMaintenanceSync(betaPath),
      record.receipt,
    );
    assert.deepEqual(record.state, { installCalls: 1, verifyCalls: 1 });
  }
});

test('Task 7 B1 RED: owned verify rejects same-key and cross-key logical reentrancy before pending mutation', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-owned-verify-');
  let coordinator;
  let nestedCallbacks = 0;
  let nestedRegisters = 0;
  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');
  const beta = createB1CheckpointJob({ id: '88888888-8888-4888-8888-888888888888' });
  const captured = createB1CheckpointJob({
    verify() {
      assert.equal(coordinator.assertProjectWriteLease(scene.projectPath), true);
      for (const nestedKey of [scene.projectPath, betaPath]) {
        assert.throws(
          () => coordinator.withProjectLogicalRequestSync(nestedKey, (context) => {
            nestedCallbacks += 1;
            context.registerPendingCheckpoint(createB1CheckpointJob().job);
            nestedRegisters += 1;
          }),
          (error) => error?.code === 'PROJECT_WRITE_REENTRANCY',
        );
      }
      return true;
    },
  });
  coordinator = createProjectWriteCoordinator({ lockRoot: scene.locksDir });
  stageB1Checkpoint(coordinator, betaPath, beta);
  stageB1Checkpoint(coordinator, scene.projectPath, captured);

  assert.equal(
    coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
    captured.receipt,
  );
  assert.equal(nestedCallbacks, 0);
  assert.equal(nestedRegisters, 0);
  assert.deepEqual(captured.state, { installCalls: 1, verifyCalls: 1 });
  assertCheckpointBlocked(coordinator, scene.projectPath);
  assert.equal(coordinator.runPendingProjectMaintenanceSync(betaPath), beta.receipt);
  assert.deepEqual(beta.state, { installCalls: 1, verifyCalls: 1 });
});

test('Task 7 B1 RED: installer return, throw, and thenable consume one-shot identity', async (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-installer-one-shot-');
  const installMarker = new Error('checkpoint installer failed');
  const rows = [
    {
      name: 'receipt',
      install(coordinator, projectKey, receipt) {
        assertCheckpointReentrant(coordinator, projectKey);
        return receipt;
      },
      expected(coordinator, projectKey, record) {
        assert.equal(coordinator.runPendingProjectMaintenanceSync(projectKey), record.receipt);
      },
    },
    {
      name: 'throw',
      install() { throw installMarker; },
      expected(coordinator, projectKey) {
        assert.throws(
          () => coordinator.runPendingProjectMaintenanceSync(projectKey),
          (error) => error === installMarker,
        );
      },
    },
    {
      name: 'thenable',
      install() { return Promise.resolve('forbidden'); },
      expected(coordinator, projectKey) {
        assert.throws(
          () => coordinator.runPendingProjectMaintenanceSync(projectKey),
          (error) => error?.code === 'PROJECT_WRITE_ASYNC_CALLBACK',
        );
      },
    },
  ];

  for (const row of rows) {
    let coordinator;
    let record;
    coordinator = createProjectWriteCoordinator({
      lockRoot: path.join(scene.locksDir, row.name),
      recoverProject() {
        assert.fail('maintenance must not run recovery');
      },
    });
    record = createB1CheckpointJob({
      install() {
        assert.equal(arguments.length, 0);
        return row.install(coordinator, scene.projectPath, record.receipt);
      },
      verify() {
        assert.equal(arguments.length, 0);
        return true;
      },
    });
    stageB1Checkpoint(coordinator, scene.projectPath, record);
    row.expected(coordinator, scene.projectPath, record);
    assert.deepEqual(record.state, { installCalls: 1, verifyCalls: 1 }, row.name);
    const countAfterConsume = coordinator.leaseAcquisitionCount(scene.projectPath);
    assertCheckpointBlocked(coordinator, scene.projectPath);
    assert.equal(coordinator.leaseAcquisitionCount(scene.projectPath), countAfterConsume, row.name);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test('Task 7 B1 RED: maintenance release uncertainty never restores consumed work', (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-release-one-shot-');
  const installerMarker = new Error('installer primary before release uncertainty');
  const releaseMarker = new Error('maintenance release uncertainty');
  const rows = [
    {
      name: 'receipt plus release failure',
      install() { return this.record.receipt; },
      expected(error) {
        return error?.code === 'WRITER_LEASE_LOST' && error.cause === releaseMarker;
      },
    },
    {
      name: 'installer plus release failure',
      install() { throw installerMarker; },
      expected(error) {
        return error?.code === 'WRITER_LEASE_LOST'
          && error.cause === releaseMarker
          && error.callbackError === installerMarker;
      },
    },
    {
      name: 'lease loss after installer',
      loseLease: true,
      install() {
        this.held = false;
        return this.record.receipt;
      },
      expected(error) { return error?.code === 'WRITER_LEASE_LOST'; },
    },
  ];

  for (const row of rows) {
    let acquisition = 0;
    row.held = true;
    const coordinator = createProjectWriteCoordinator({
      acquireLease() {
        acquisition += 1;
        if (acquisition === 1) return stableTestLease();
        return {
          isHeld() { return row.held; },
          release() {
            if (row.loseLease) assert.fail('a lost maintenance lease must not be released');
            throw releaseMarker;
          },
        };
      },
      lockRoot: path.join(scene.locksDir, row.name.replaceAll(' ', '-')),
    });
    row.record = createB1CheckpointJob({
      install() { return row.install(); },
    });
    stageB1Checkpoint(coordinator, scene.projectPath, row.record);
    assert.throws(
      () => coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
      row.expected,
      row.name,
    );
    assert.deepEqual(row.record.state, { installCalls: 1, verifyCalls: 1 }, row.name);
    assertCheckpointBlocked(coordinator, scene.projectPath);
  }
});

test('Task 7 B1 RED: hostile maintenance release causes still settle lost state and drain', async (t) => {
  const scene = createScene(t, 'mythpen-project-checkpoint-hostile-release-');
  let codeGetterReads = 0;
  const throwingCode = {};
  Object.defineProperty(throwingCode, 'code', {
    get() {
      codeGetterReads += 1;
      throw new Error('release cause code getter must not run');
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const spoof = Object.freeze({ code: 'WRITER_LEASE_LOST' });
  const rows = [
    ['throwing code getter', throwingCode],
    ['revoked proxy', revoked.proxy],
    ['spoofed lost code', spoof],
  ];

  for (const [name, cause] of rows) {
    let acquisitions = 0;
    const lostErrors = [];
    const coordinator = createProjectWriteCoordinator({
      acquireLease() {
        acquisitions += 1;
        if (acquisitions !== 2) return stableTestLease();
        return {
          isHeld() { return true; },
          release() { throw cause; },
        };
      },
      lockRoot: path.join(scene.locksDir, name.replaceAll(' ', '-')),
      onLeaseLost(_canonicalKey, error) {
        lostErrors.push(error);
      },
    });
    const record = createB1CheckpointJob();
    stageB1Checkpoint(coordinator, scene.projectPath, record);
    let observed;
    assert.throws(
      () => coordinator.runPendingProjectMaintenanceSync(scene.projectPath),
      (error) => {
        observed = error;
        return error !== cause
          && error?.code === 'WRITER_LEASE_LOST'
          && error.cause === cause;
      },
      name,
    );
    assert.deepEqual(record.state, { installCalls: 1, verifyCalls: 1 }, name);
    assert.deepEqual(lostErrors, [observed], name);
    assert.equal(
      coordinator.withProjectRecoveryLeaseSync(scene.projectPath, () => 'lease-reacquired'),
      'lease-reacquired',
      name,
    );
    const quiesce = coordinator.beginQuiesce();
    const drained = coordinator.drain(quiesce);
    assert.equal(Bun.peek.status(drained), 'rejected', name);
    await assert.rejects(drained, (error) => error === observed, name);
  }
  assert.equal(codeGetterReads, 0);
});

async function readFormalRows(filePath, sql) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    const statement = database.prepare(sql);
    try {
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  } finally {
    database.close();
  }
}

test('a competing coordinator gets PROJECT_WRITE_BUSY before recovery or callback', async (t) => {
  const scene = createScene(t);
  const entered = deferred();
  const unblock = deferred();
  let contenderRecovered = false;
  let contenderCalled = false;
  const holder = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject: () => {},
  });
  const contender = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject: () => { contenderRecovered = true; },
  });

  const held = holder.withProjectWrite(scene.projectPath, async () => {
    entered.resolve();
    await unblock.promise;
  });
  await entered.promise;

  await assert.rejects(
    async () => contender.withProjectWrite(scene.projectPath, () => {
      contenderCalled = true;
    }),
    (error) => error.code === 'PROJECT_WRITE_BUSY',
  );
  assert.equal(contenderRecovered, false);
  assert.equal(contenderCalled, false);

  unblock.resolve();
  await held;
});

test('a recovery lease validates ownership without running automatic recovery first', (t) => {
  const scene = createScene(t, 'mythpen-project-recovery-lease-');
  let recoverCalls = 0;
  const coordinator = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject() {
      recoverCalls += 1;
    },
  });

  const result = coordinator.withProjectRecoveryLeaseSync(scene.projectPath, (context) => {
    assert.equal(context.assertLease(), true);
    assert.equal(recoverCalls, 0);
    return 'inspected-before-recovery';
  });

  assert.equal(result, 'inspected-before-recovery');
  assert.equal(recoverCalls, 0);
  assert.equal(
    coordinator.withProjectWriteSync(scene.projectPath, () => 'successor'),
    'successor',
    'the dedicated recovery lease must be released before a successor write',
  );
  assert.equal(recoverCalls, 1);
});

test('physical project path aliases contend on one canonical writer lease', async (t) => {
  const scene = createScene(t, 'mythpen-project-writer-alias-');
  const physicalParent = path.join(scene.root, 'physical');
  const aliasParent = path.join(scene.root, 'alias');
  fs.mkdirSync(physicalParent);
  fs.symlinkSync(
    physicalParent,
    aliasParent,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const physicalProject = path.join(physicalParent, 'aliased.mythpen.db');
  const aliasProject = path.join(aliasParent, 'aliased.mythpen.db');
  const entered = deferred();
  const unblock = deferred();
  const holder = createProjectWriteCoordinator({ lockRoot: scene.locksDir });
  const contender = createProjectWriteCoordinator({ lockRoot: scene.locksDir });

  const held = holder.withProjectWrite(physicalProject, async () => {
    entered.resolve();
    await unblock.promise;
  });
  await entered.promise;

  assert.throws(
    () => contender.withProjectWriteSync(aliasProject, () => {}),
    (error) => error.code === 'PROJECT_WRITE_BUSY',
  );

  unblock.resolve();
  await held;
});

test('two real processes contend and SIGKILL releases the lease before successor recovery', async (t) => {
  const scene = createScene(t, 'mythpen-project-writer-process-');
  const holder = runWorker(scene, 'hold');
  t.after(() => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
  });

  await waitForLine(holder, 'callback');
  const contender = await collectWorker(scene, 'once');
  assert.equal(contender.code, 0, contender.stderr);
  assert.deepEqual(
    contender.stdout.trim().split(/\r?\n/),
    ['error:PROJECT_WRITE_BUSY'],
    'the losing process must not recover or enter its callback',
  );

  assert.equal(holder.kill('SIGKILL'), true);
  await waitForExit(holder);

  const successor = await collectWorker(scene, 'once');
  assert.equal(successor.code, 0, successor.stderr);
  assert.deepEqual(successor.stdout.trim().split(/\r?\n/), [
    'recover',
    'callback',
    'completed',
  ]);
});

test('a real publish crash releases the writer lease and successor recovers before callback', async (t) => {
  const scene = createScene(t, 'mythpen-project-writer-crash-');
  const controlDir = path.join(scene.dataDir, 'control', 'project');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const initial = new SQL.Database();
  initial.run('PRAGMA foreign_keys = ON');
  initial.run('CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  initial.run("INSERT INTO entries (id, value) VALUES (1, 'before')");
  fs.writeFileSync(scene.projectPath, Buffer.from(initial.export()));
  initial.close();

  const crash = await runUntilCrash({
    script: path.join(__dirname, 'fixtures', 'project-write-atomic-crash.js'),
    faults: {
      [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { crash: true },
    },
    env: {
      MYTHPEN_PROJECT_WRITE_CONTROL_DIR: controlDir,
      MYTHPEN_PROJECT_WRITE_DB_PATH: scene.projectPath,
      MYTHPEN_PROJECT_WRITE_LOCK_ROOT: scene.locksDir,
    },
    timeoutMs: 20_000,
  });
  t.after(() => crash.cleanup());

  assert.equal(crash.signal, 'SIGKILL');
  assert.equal(
    crash.crashPoint.name,
    FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE,
  );
  assert.deepEqual(
    await readFormalRows(scene.projectPath, 'SELECT value FROM entries WHERE id = 1'),
    [{ value: 'before' }],
  );
  assert.equal(openControlStore(controlDir).tail().type, 'sqlite.publish.prepared');

  const order = [];
  let successor;
  let enforceLease = false;
  const store = createAtomicStore({
    assertWriterLease() {
      if (enforceLease) successor.assertProjectWriteLease(scene.projectPath);
    },
    filePath: scene.projectPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  successor = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject: () => {
      store.recover();
      order.push('recover');
    },
  });
  enforceLease = true;
  successor.withProjectWriteSync(scene.projectPath, () => {
    order.push('callback');
    assert.equal(
      store.currentConnection().exec('SELECT value FROM entries WHERE id = 1')[0].values[0][0],
      'after',
    );
  });

  assert.deepEqual(order, ['recover', 'callback']);
  assert.equal(openControlStore(controlDir).tail().type, 'sqlite.publish.committed');
});

test('same-process writes run in strict FIFO and a rejected callback does not poison the queue', async (t) => {
  const scene = createScene(t);
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const order = [];
  const firstError = new Error('first callback rejected');
  const coordinator = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject: () => { order.push('recover'); },
  });

  const first = coordinator.withProjectWrite(scene.projectPath, async () => {
    order.push('first:start');
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push('first:end');
    throw firstError;
  });
  await firstEntered.promise;
  const second = coordinator.withProjectWrite(scene.projectPath, () => {
    order.push('second');
    return 'second-result';
  });
  const third = coordinator.withProjectWrite(scene.projectPath, () => {
    order.push('third');
    return 'third-result';
  });

  assert.deepEqual(order, ['recover', 'first:start']);
  releaseFirst.resolve();
  await assert.rejects(first, (error) => error === firstError);
  assert.equal(await second, 'second-result');
  assert.equal(await third, 'third-result');
  assert.deepEqual(order, [
    'recover',
    'first:start',
    'first:end',
    'recover',
    'second',
    'recover',
    'third',
  ]);
});

test('different project keys can execute concurrently', async (t) => {
  const scene = createScene(t);
  const alphaEntered = deferred();
  const releaseAlpha = deferred();
  const order = [];
  const coordinator = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject: () => {},
  });

  const alpha = coordinator.withProjectWrite(scene.projectPath, async () => {
    order.push('alpha:start');
    alphaEntered.resolve();
    await releaseAlpha.promise;
    order.push('alpha:end');
  });
  await alphaEntered.promise;
  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');
  const beta = coordinator.withProjectWrite(betaPath, () => {
    order.push('beta');
  });

  await beta;
  assert.deepEqual(order, ['alpha:start', 'beta']);
  releaseAlpha.resolve();
  await alpha;
  assert.deepEqual(order, ['alpha:start', 'beta', 'alpha:end']);
});

test('same-key reentrancy needs the exact ownership context and cross-key nesting is rejected', async (t) => {
  const scene = createScene(t);
  const recoveries = [];
  const order = [];
  const coordinator = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject: (projectKey) => { recoveries.push(projectKey); },
  });

  const value = await coordinator.withProjectWrite(scene.projectPath, async () => {
    order.push('outer:start');
    const inner = await coordinator.withProjectWrite(scene.projectPath, () => {
      order.push('inner');
      return 42;
    });
    order.push('outer:end');
    return inner;
  });

  assert.equal(value, 42);
  assert.deepEqual(order, ['outer:start', 'inner', 'outer:end']);
  assert.equal(recoveries.length, 1, 'same-key reentrancy reuses the outer recovery and lease');

  const betaPath = path.join(path.dirname(scene.projectPath), 'beta.mythpen.db');
  await assert.rejects(
    async () => coordinator.withProjectWrite(scene.projectPath, () => (
      coordinator.withProjectWrite(betaPath, () => {})
    )),
    (error) => error.code === 'PROJECT_WRITE_REENTRANCY',
  );
});

test('lease loss rejects the current and queued items before any later recovery or callback', async (t) => {
  const scene = createScene(t);
  const firstEntered = deferred();
  const invalidate = deferred();
  const order = [];
  let activeLease;
  const losses = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      let held = true;
      activeLease = {
        invalidate() { held = false; },
        isHeld() { return held; },
        release() {
          if (!held) {
            const error = new Error('lease already lost');
            error.code = 'LEASE_LOST';
            throw error;
          }
          held = false;
        },
      };
      return activeLease;
    },
    lockRoot: scene.locksDir,
    onLeaseLost(canonicalKey, error) {
      losses.push({ canonicalKey, error, order: [...order] });
    },
    recoverProject: () => { order.push('recover'); },
  });

  const first = coordinator.withProjectWrite(scene.projectPath, async () => {
    order.push('first:start');
    firstEntered.resolve();
    await invalidate.promise;
    activeLease.invalidate();
    order.push('first:return');
  });
  await firstEntered.promise;
  const second = coordinator.withProjectWrite(scene.projectPath, () => {
    order.push('second');
  });
  invalidate.resolve();

  await assert.rejects(first, (error) => error.code === 'WRITER_LEASE_LOST');
  await assert.rejects(second, (error) => error.code === 'WRITER_LEASE_LOST');
  assert.deepEqual(order, ['recover', 'first:start', 'first:return']);
  assert.equal(losses.length, 1);
  assert.equal(losses[0].canonicalKey, canonicalDatabasePath(scene.projectPath));
  assert.equal(losses[0].error.code, 'WRITER_LEASE_LOST');
  assert.deepEqual(losses[0].order, ['recover', 'first:start', 'first:return']);
});

test('release failure fences and notifies once before the current result is reported', (t) => {
  const scene = createScene(t);
  const releaseError = new Error('injected project lease release failure');
  const losses = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      return {
        isHeld: () => true,
        release() { throw releaseError; },
      };
    },
    lockRoot: scene.locksDir,
    onLeaseLost(canonicalKey, error) {
      losses.push({ canonicalKey, error });
    },
  });

  assert.throws(
    () => coordinator.withProjectWriteSync(scene.projectPath, () => 'must not escape'),
    (error) => error.code === 'WRITER_LEASE_LOST' && error.cause === releaseError,
  );
  assert.equal(losses.length, 1);
  assert.equal(losses[0].canonicalKey, canonicalDatabasePath(scene.projectPath));
  assert.equal(losses[0].error.code, 'WRITER_LEASE_LOST');
  assert.equal(losses[0].error.cause, releaseError);
});

test('a callback error that only mimics WRITER_LEASE_LOST does not poison the valid FIFO batch', async (t) => {
  const scene = createScene(t);
  const entered = deferred();
  const unblock = deferred();
  const order = [];
  const losses = [];
  const fakeLeaseLoss = new Error('application error with a reserved-looking code');
  fakeLeaseLoss.code = 'WRITER_LEASE_LOST';
  const coordinator = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    onLeaseLost(canonicalKey, error) { losses.push({ canonicalKey, error }); },
    recoverProject: () => { order.push('recover'); },
  });

  const first = coordinator.withProjectWrite(scene.projectPath, async () => {
    order.push('first:start');
    entered.resolve();
    await unblock.promise;
    throw fakeLeaseLoss;
  });
  await entered.promise;
  const second = coordinator.withProjectWrite(scene.projectPath, () => {
    order.push('second');
    return 'second-result';
  });
  unblock.resolve();

  await assert.rejects(first, (error) => error === fakeLeaseLoss);
  assert.equal(await second, 'second-result');
  assert.equal(
    coordinator.withProjectWriteSync(scene.projectPath, () => 'third-result'),
    'third-result',
  );
  assert.deepEqual(order, [
    'recover',
    'first:start',
    'recover',
    'second',
    'recover',
  ]);
  assert.deepEqual(losses, []);
});

test('synchronous writes preserve return and error identity while an external sync contender fails busy', async (t) => {
  const scene = createScene(t);
  const coordinator = createProjectWriteCoordinator({
    lockRoot: scene.locksDir,
    recoverProject: () => {},
  });
  const marker = new Error('sync marker');

  assert.equal(coordinator.withProjectWriteSync(scene.projectPath, () => 17), 17);
  assert.throws(
    () => coordinator.withProjectWriteSync(scene.projectPath, () => { throw marker; }),
    (error) => error === marker,
  );

  const entered = deferred();
  const unblock = deferred();
  const active = coordinator.withProjectWrite(scene.projectPath, async () => {
    entered.resolve();
    await unblock.promise;
  });
  await entered.promise;
  assert.throws(
    () => coordinator.withProjectWriteSync(scene.projectPath, () => {}),
    (error) => error.code === 'PROJECT_WRITE_BUSY',
  );
  unblock.resolve();
  await active;
});

test('the synchronous coordinator rejects thenables without validating a released batch later', async (t) => {
  const scene = createScene(t);
  const pending = deferred();
  const unhandled = [];
  let released = false;
  let validationsAfterRelease = 0;
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      let held = true;
      return {
        isHeld() {
          if (released) validationsAfterRelease += 1;
          return held;
        },
        release() {
          held = false;
          released = true;
        },
      };
    },
    lockRoot: scene.locksDir,
  });

  assert.throws(
    () => coordinator.withProjectWriteSync(scene.projectPath, () => pending.promise),
    (error) => error.code === 'PROJECT_WRITE_ASYNC_CALLBACK',
  );
  const validationsAtReturn = validationsAfterRelease;
  pending.reject(new Error('late callback rejection'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(validationsAfterRelease, validationsAtReturn);
  assert.deepEqual(unhandled, []);
  assert.equal(
    coordinator.withProjectWriteSync(scene.projectPath, () => 'still usable'),
    'still usable',
  );
});

test('a lost synchronous lease is fenced and does not leave a poisoned local batch', (t) => {
  const scene = createScene(t);
  let activeLease;
  let acquisitions = 0;
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      acquisitions += 1;
      let held = true;
      activeLease = {
        invalidate() { held = false; },
        isHeld() { return held; },
        release() {
          if (!held) {
            const error = new Error('lease already lost');
            error.code = 'LEASE_LOST';
            throw error;
          }
          held = false;
        },
      };
      return activeLease;
    },
    lockRoot: scene.locksDir,
  });

  assert.throws(
    () => coordinator.withProjectWriteSync(scene.projectPath, () => {
      activeLease.invalidate();
    }),
    (error) => error.code === 'WRITER_LEASE_LOST',
  );
  assert.equal(coordinator.withProjectWriteSync(scene.projectPath, () => 'recovered'), 'recovered');
  assert.equal(acquisitions, 2);
});

test('raw project mutations cannot bypass the project lease', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'raw-write-lease';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  projectDb.flush();
  const lease = acquireExclusiveLease(projectLeasePath(dataDir, projectPath));
  t.after(() => {
    if (lease.isHeld()) lease.release();
  });

  assert.throws(
    () => projectDb
      .prepare("INSERT INTO project_meta (key, value) VALUES ('raw_bypass', '1')")
      .run(),
    (error) => error.code === 'PROJECT_WRITE_BUSY',
  );
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'raw_bypass'").get(),
    null,
  );
});

test('project reads remain lease-free while another writer holds the OS lease', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'lease-free-reads';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('readable', 'yes')")
    .run();
  const lease = acquireExclusiveLease(projectLeasePath(dataDir, projectPath));
  t.after(() => {
    if (lease.isHeld()) lease.release();
  });

  assert.deepEqual(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'readable'").get(),
    { value: 'yes' },
  );
  assert.deepEqual(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'readable'").all(),
    [{ value: 'yes' }],
  );
  assert.equal(projectDb.exec('SELECT value FROM project_meta').length, 1);
});

test('a raw project mutation is durably published before its synchronous call returns', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'raw-write-terminal';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  projectDb.flush();

  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('sync_terminal', 'yes')")
    .run();

  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT value FROM project_meta WHERE key = 'sync_terminal'",
    ),
    [{ value: 'yes' }],
  );
  const epochAfterReturn = databaseInternals(projectDb).store.connectionEpoch;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    databaseInternals(projectDb).store.connectionEpoch,
    epochAfterReturn,
    'no old scheduled project flush may publish after the lease-owning call returned',
  );
});

test('a failed multi-statement exec rolls its successful prefix out of the live project state', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'failed-exec-live-rollback';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  let sqlError;

  try {
    projectDb.exec(`
      INSERT INTO project_meta (key, value) VALUES ('failed_exec_prefix', 'must roll back');
      INSERT INTO table_that_does_not_exist (value) VALUES ('boom');
    `);
  } catch (error) {
    sqlError = error;
  }

  assert.ok(sqlError, 'the real SQLite error must be returned');
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'failed_exec_prefix'").get(),
    null,
    'the successful prefix must be absent from the live connection before another write',
  );
  assert.deepEqual(
    await readFormalRows(projectPath, "SELECT value FROM project_meta WHERE key = 'failed_exec_prefix'"),
    [],
  );
  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('failed_exec_successor', 'durable')")
    .run();
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT key FROM project_meta WHERE key LIKE 'failed_exec_%' ORDER BY key",
    ),
    [{ key: 'failed_exec_successor' }],
  );
});

test('a failed exec preserves prior dirty work but never publishes its own successful prefix', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'failed-exec-prior-dirty';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => projectDb
        .prepare("INSERT INTO project_meta (key, value) VALUES ('prior_dirty', 'keep me')")
        .run(),
      (error) => error.code === 'EIO',
    );
  });
  assert.deepEqual(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'prior_dirty'").get(),
    { value: 'keep me' },
  );

  assert.throws(
    () => projectDb.exec(`
      INSERT INTO project_meta (key, value) VALUES ('failed_dirty_prefix', 'never publish');
      INSERT INTO table_that_does_not_exist (value) VALUES ('boom');
    `),
    (error) => /table_that_does_not_exist/.test(error.message),
  );
  assert.deepEqual(
    projectDb.prepare(
      "SELECT key FROM project_meta WHERE key IN ('prior_dirty', 'failed_dirty_prefix') ORDER BY key",
    ).all(),
    [{ key: 'prior_dirty' }],
  );

  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('dirty_successor', 'publish together')")
    .run();
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT key FROM project_meta WHERE key IN ('prior_dirty', 'failed_dirty_prefix', 'dirty_successor') ORDER BY key",
    ),
    [{ key: 'dirty_successor' }, { key: 'prior_dirty' }],
  );
});

test('raw SQL transaction control is rejected with one stable boundary error', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'raw-transaction-control';
  const projectDb = db.createProjectDb(project);

  for (const attempt of [
    () => projectDb.exec('COMMIT'),
    () => projectDb.run('ROLLBACK'),
    () => projectDb.prepare('SAVEPOINT user_boundary').run(),
    () => projectDb.prepare('RELEASE user_boundary').get(),
    () => projectDb.exec('SELECT 1; BEGIN'),
    () => projectDb.exec('SELECT 1; END TRANSACTION'),
  ]) {
    assert.throws(attempt, (error) => error.code === 'SQL_TRANSACTION_CONTROL_FORBIDDEN');
  }
  assert.deepEqual(
    projectDb.prepare("SELECT 'BEGIN; COMMIT; ROLLBACK; SAVEPOINT; RELEASE' AS value").get(),
    { value: 'BEGIN; COMMIT; ROLLBACK; SAVEPOINT; RELEASE' },
  );
  assert.equal(
    projectDb.transaction(() => 'wrapper transaction remains available')(),
    'wrapper transaction remains available',
  );
});

test('trigger scanning treats an unquoted end identifier as data and still rejects later control', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const projectDb = db.createProjectDb('trigger-end-identifier');
  projectDb.exec(`
    CREATE TABLE trigger_end_probe (
      id INTEGER PRIMARY KEY,
      end TEXT NOT NULL,
      observed TEXT
    );
  `);

  projectDb.exec(`
    CREATE TRIGGER trigger_end_identifier_after_update
    AFTER UPDATE OF end ON trigger_end_probe
    FOR EACH ROW
    BEGIN
      UPDATE trigger_end_probe SET observed = NEW.end WHERE id = NEW.id;
    END;
  `);
  projectDb.prepare(
    "INSERT INTO trigger_end_probe (id, end, observed) VALUES (1, 'before', NULL)",
  ).run();
  projectDb.prepare("UPDATE trigger_end_probe SET end = 'after' WHERE id = 1").run();
  assert.deepEqual(
    projectDb.prepare('SELECT end, observed FROM trigger_end_probe WHERE id = 1').get(),
    { end: 'after', observed: 'after' },
  );

  assert.throws(
    () => projectDb.exec(`
      CREATE TRIGGER trigger_followed_by_control
      AFTER UPDATE OF end ON trigger_end_probe
      FOR EACH ROW
      BEGIN
        UPDATE trigger_end_probe SET observed = NEW.end WHERE id = NEW.id;
      END;
      COMMIT;
    `),
    (error) => error.code === 'SQL_TRANSACTION_CONTROL_FORBIDDEN',
  );
  assert.equal(
    projectDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trigger_followed_by_control'",
    ).get(),
    null,
  );
});

test('a mutation savepoint rollback failure preserves the SQL error and fences the wrapper', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const configDb = db.getConfigDb();
  t.after(() => {
    try { configDb._discard(); } catch { /* already closed */ }
  });
  const rawDatabase = databaseInternals(configDb).store.currentConnection();
  const rawPrototype = Object.getPrototypeOf(rawDatabase);
  const originalRun = rawPrototype.run;
  const rollbackError = new Error('injected mutation savepoint rollback failure');
  const preparedRun = configDb.prepare(
    "INSERT INTO app_settings (key, value) VALUES ('fenced_prepared_run', 'never')",
  );
  const preparedAll = configDb.prepare('SELECT key FROM app_settings ORDER BY key');
  const preparedGet = configDb.prepare('SELECT key FROM app_settings LIMIT 1');
  const preparedTransaction = configDb.transaction(() => 'never');
  rawPrototype.run = function injectedRollbackFailure(sql, ...args) {
    if (/^ROLLBACK TO SAVEPOINT __mythpen_mutation_/.test(String(sql))) throw rollbackError;
    return originalRun.call(this, sql, ...args);
  };
  let sqlError;
  try {
    configDb.exec(`
      INSERT INTO app_settings (key, value) VALUES ('failed_savepoint_prefix', 'never publish');
      INSERT INTO table_that_does_not_exist (value) VALUES ('boom');
    `);
  } catch (error) {
    sqlError = error;
  } finally {
    rawPrototype.run = originalRun;
  }

  assert.ok(sqlError);
  assert.equal(sqlError.mutationRollbackError, rollbackError);
  assert.equal(configDb._failure, sqlError);
  for (const [entrypoint, attempt] of [
    ['exec control', () => configDb.exec('COMMIT')],
    ['exec', () => configDb.exec(
      "INSERT INTO app_settings (key, value) VALUES ('fenced_exec', 'never')",
    )],
    ['run control', () => configDb.run('ROLLBACK')],
    ['run', () => configDb.run(
      "INSERT INTO app_settings (key, value) VALUES ('fenced_run', 'never')",
    )],
    ['prepare', () => configDb.prepare('SELECT 1')],
    ['prepare control', () => configDb.prepare('SAVEPOINT fenced_boundary')],
    ['prepare.run', () => preparedRun.run()],
    ['prepare.all', () => preparedAll.all()],
    ['prepare.get', () => preparedGet.get()],
    ['pragma', () => configDb.pragma('user_version = 91')],
    ['transaction', () => configDb.transaction(() => 'never')()],
    ['prepared transaction', () => preparedTransaction()],
    ['flush', () => configDb.flush()],
    ['flushAllDatabases', () => db.flushAllDatabases()],
    ['dbQuery', () => db.dbQuery('SELECT key FROM app_settings')],
    ['dbGet', () => db.dbGet('SELECT key FROM app_settings LIMIT 1')],
    ['dbExecute', () => db.dbExecute(
      "INSERT INTO app_settings (key, value) VALUES ('fenced_facade', 'never')",
    )],
    ['close', () => configDb.close()],
  ]) {
    assert.throws(attempt, (error) => error === sqlError, entrypoint);
  }
});

test('a fenced project wrapper retains its primary error across reentrant entrypoints', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'reentrant-retained-primary';
  const projectDb = db.createProjectDb(project);
  t.after(() => {
    try { projectDb._discard(); } catch { /* already closed */ }
  });
  const rawDatabase = databaseInternals(projectDb).store.currentConnection();
  const rawPrototype = Object.getPrototypeOf(rawDatabase);
  const originalRun = rawPrototype.run;
  const rollbackError = new Error('injected reentrant savepoint rollback failure');
  const preparedRun = projectDb.prepare(
    "INSERT INTO project_meta (key, value) VALUES ('fenced_prepared_run', 'never')",
  );
  const preparedAll = projectDb.prepare('SELECT key FROM project_meta ORDER BY key');
  const preparedGet = projectDb.prepare('SELECT key FROM project_meta LIMIT 1');
  const preparedTransaction = projectDb.transaction(() => 'never');
  const entrypointErrors = [];
  let primaryError;

  try {
    assert.throws(
      () => db.projectTransaction(project, () => {
        rawPrototype.run = function injectedRollbackFailure(sql, ...args) {
          const statement = String(sql);
          if (/^ROLLBACK TO SAVEPOINT __mythpen_mutation_/.test(statement)) throw rollbackError;
          return originalRun.call(this, sql, ...args);
        };
        try {
          projectDb.exec(`
            INSERT INTO project_meta (key, value) VALUES ('reentrant_failed_prefix', 'never');
            INSERT INTO table_that_does_not_exist (value) VALUES ('boom');
          `);
        } catch (error) {
          primaryError = error;
        }

        assert.ok(primaryError);
        assert.equal(primaryError.mutationRollbackError, rollbackError);
        assert.equal(projectDb._failure, primaryError);
        for (const [entrypoint, attempt] of [
          ['exec control', () => projectDb.exec('COMMIT')],
          ['exec', () => projectDb.exec(
            "INSERT INTO project_meta (key, value) VALUES ('fenced_exec', 'never')",
          )],
          ['run control', () => projectDb.run('ROLLBACK')],
          ['run', () => projectDb.run(
            "INSERT INTO project_meta (key, value) VALUES ('fenced_run', 'never')",
          )],
          ['prepare', () => projectDb.prepare('SELECT key FROM project_meta')],
          ['prepare control', () => projectDb.prepare('SAVEPOINT fenced_boundary')],
          ['prepare.run', () => preparedRun.run()],
          ['prepare.all', () => preparedAll.all()],
          ['prepare.get', () => preparedGet.get()],
          ['pragma', () => projectDb.pragma('user_version = 92')],
          ['transaction', () => projectDb.transaction(() => 'never')()],
          ['prepared transaction', () => preparedTransaction()],
          ['flush', () => projectDb.flush()],
          ['flushAllDatabases', () => db.flushAllDatabases()],
          ['projectQuery', () => db.projectQuery(project, 'SELECT key FROM project_meta')],
          ['projectGet', () => db.projectGet(project, 'SELECT key FROM project_meta LIMIT 1')],
          ['projectExecute', () => db.projectExecute(
            project,
            "INSERT INTO project_meta (key, value) VALUES ('fenced_facade', 'never')",
          )],
          ['projectTransaction', () => db.projectTransaction(project, () => 'never')],
          ['close', () => projectDb.close()],
        ]) {
          let observedError;
          try {
            attempt();
          } catch (error) {
            observedError = error;
          }
          entrypointErrors.push([entrypoint, observedError]);
        }

        return 'callback swallowed the retained primary';
      }),
      (error) => error === primaryError,
    );
  } finally {
    rawPrototype.run = originalRun;
  }

  assert.equal(primaryError.rollbackError?.code, 'RECOVERY_REQUIRED');
  for (const [entrypoint, error] of entrypointErrors) {
    assert.equal(error, primaryError, entrypoint);
  }
  assert.equal(projectDb._failure, primaryError);
});

test('project wrapper close and lease-loss fences invalidate current and next cached access', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();

  const closeProject = 'wrapper-close-fence';
  const closeDb = db.createProjectDb(closeProject);
  let closeError;
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE]: { throw: 'CLOSE_EIO' },
  }, async () => {
    try {
      closeDb.close();
    } catch (error) {
      closeError = error;
    }
    assert.equal(closeError?.code, 'CLOSE_EIO');
    assert.equal(closeDb._failure, closeError);
    assert.throws(() => closeDb.prepare('SELECT 1'), (error) => error === closeError);
    assert.throws(
      () => db.getProjectDb(closeProject).prepare('SELECT 1'),
      (error) => error === closeError,
    );
  });
  closeDb._discard();

  const leaseProject = 'wrapper-lease-loss-fence';
  const leaseDb = db.createProjectDb(leaseProject);
  const leaseLoss = new WriterLeaseLostError(canonicalDatabasePath(db.getProjectDbPath(leaseProject)));
  leaseDb._fenceForLeaseLoss(leaseLoss);
  assert.equal(leaseDb._failure, leaseLoss);
  assert.throws(() => leaseDb.prepare('SELECT 1'), (error) => error === leaseLoss);
  assert.throws(
    () => leaseDb.run("INSERT INTO project_meta (key, value) VALUES ('never', 'written')"),
    (error) => error === leaseLoss,
  );
  assert.throws(
    () => db.getProjectDb(leaseProject).prepare('SELECT 1'),
    (error) => error === leaseLoss,
  );
  leaseDb._discard();
});

test('dirty project and config close failures fence the first error and retry cleanup', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();

  const project = 'dirty-close-fence';
  const projectDb = db.createProjectDb(project);
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'INITIAL_EIO' },
  }, async () => {
    assert.throws(
      () => projectDb.transaction(() => {
        projectDb
          .prepare("INSERT INTO project_meta (key, value) VALUES ('dirty_close', 'project')")
          .run();
      })(),
      (error) => error.code === 'INITIAL_EIO',
    );
  });

  let projectCloseError;
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { throw: 'PROJECT_FLUSH_EIO' },
    [FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE]: { throw: 'PROJECT_CLOSE_EIO' },
  }, async () => {
    try {
      projectDb.close();
    } catch (error) {
      projectCloseError = error;
    }
  });
  assert.equal(projectCloseError?.code, 'PROJECT_FLUSH_EIO');
  assert.equal(projectDb._failure, projectCloseError);
  assert.equal(projectCloseError.storageCloseError?.code, 'PROJECT_CLOSE_EIO');
  assert.throws(() => projectDb.prepare('SELECT 1'), (error) => error === projectCloseError);
  assert.throws(
    () => db.getProjectDb(project).prepare('SELECT 1'),
    (error) => error === projectCloseError,
  );
  assert.doesNotThrow(() => projectDb._discard());

  const configDb = db.getConfigDb();
  configDb.run(
    "INSERT INTO app_settings (key, value) VALUES ('dirty_close_config', 'config')",
  );
  let configCloseError;
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'CONFIG_FLUSH_EIO' },
    [FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE]: { throw: 'CONFIG_CLOSE_EIO' },
  }, async () => {
    try {
      configDb.close();
    } catch (error) {
      configCloseError = error;
    }
  });
  assert.equal(configCloseError?.code, 'CONFIG_FLUSH_EIO');
  assert.equal(configDb._failure, configCloseError);
  assert.equal(configCloseError.storageCloseError?.code, 'CONFIG_CLOSE_EIO');
  assert.throws(() => configDb.prepare('SELECT 1'), (error) => error === configCloseError);
  assert.doesNotThrow(() => configDb._discard());
});

test('the next project mutation recovers an unfinished publish before applying new work', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'recover-before-next-write';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => projectDb
        .prepare("INSERT INTO project_meta (key, value) VALUES ('interrupted', 'prepared')")
        .run(),
      (error) => (
        error.code === 'EIO'
        && error.faultPoint === FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE
      ),
    );
  });

  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT value FROM project_meta WHERE key = 'interrupted'",
    ),
    [],
    'the formal database is still the before image at the injected boundary',
  );
  assert.equal(databaseInternals(projectDb).store.recoveryRequired, true);

  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('successor', 'after recovery')")
    .run();

  assert.equal(databaseInternals(projectDb).store.recoveryRequired, false);
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT key, value FROM project_meta WHERE key IN ('interrupted', 'successor') ORDER BY key",
    ),
    [
      { key: 'interrupted', value: 'prepared' },
      { key: 'successor', value: 'after recovery' },
    ],
  );
});

test('a local retryable mutation never skips an unfinished publication from another writer', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'external-journal-before-local-retry';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => projectDb
        .prepare("INSERT INTO project_meta (key, value) VALUES ('local_retry', 'must not overwrite')")
        .run(),
      (error) => error.code === 'EIO',
    );
  });
  assert.equal(databaseInternals(projectDb).store.recoveryRequired, false);

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const canonicalPath = canonicalDatabasePath(projectPath);
  const dbKey = createHash('sha256').update(canonicalPath).digest('hex');
  const controlDir = path.join(dataDir, 'control', 'sqlite', dbKey);
  const externalStore = createAtomicStore({
    filePath: projectPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  const externalConnection = externalStore.currentConnection();
  externalConnection.run(
    "INSERT INTO project_meta (key, value) VALUES ('external_pending', 'recover first')",
  );
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => externalStore.publish(externalConnection),
      (error) => error.code === 'EIO',
    );
  });
  externalStore.close();
  assert.equal(openControlStore(controlDir).tail().type, 'sqlite.publish.prepared');

  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('successor', 'after external recovery')")
    .run();

  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT key, value FROM project_meta WHERE key IN ('external_pending', 'local_retry', 'successor') ORDER BY key",
    ),
    [
      { key: 'external_pending', value: 'recover first' },
      { key: 'successor', value: 'after external recovery' },
    ],
  );
  const verificationStore = createAtomicStore({
    filePath: projectPath,
    controlStore: openControlStore(controlDir),
    sqlModule: SQL,
  });
  assert.equal(verificationStore.recoveryRequired, false);
  verificationStore.close();
});

test('every public and raw project mutation entrypoint is fenced by the same lease', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'all-write-entrypoints';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  const lease = acquireExclusiveLease(projectLeasePath(dataDir, projectPath));
  t.after(() => {
    if (lease.isHeld()) lease.release();
  });
  let rawTransactionEntered = false;
  let facadeTransactionEntered = false;

  for (const write of [
    () => projectDb.exec("INSERT INTO project_meta (key, value) VALUES ('raw_exec', '1')"),
    () => projectDb.transaction(() => {
      rawTransactionEntered = true;
      projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('raw_tx', '1')").run();
    })(),
    () => db.projectExecute(
      project,
      "INSERT INTO project_meta (key, value) VALUES ('facade_execute', '1')",
    ),
    () => db.projectTransaction(project, () => {
      facadeTransactionEntered = true;
      projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('facade_tx', '1')").run();
    }),
  ]) {
    assert.throws(write, (error) => error.code === 'PROJECT_WRITE_BUSY');
  }

  assert.equal(rawTransactionEntered, false);
  assert.equal(facadeTransactionEntered, false);
  assert.equal(
    projectDb.prepare("SELECT COUNT(*) AS count FROM project_meta WHERE key LIKE '%_tx' OR key LIKE '%_execute'").get().count,
    0,
  );
});

test('RETURNING, facade reads, WITH, and PRAGMA share the conservative write boundary', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'classified-write-entrypoints';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('returning_target', 'before')")
    .run();
  const lease = acquireExclusiveLease(projectLeasePath(dataDir, projectPath));
  t.after(() => {
    if (lease.isHeld()) lease.release();
  });

  for (const bypassAttempt of [
    () => projectDb
      .prepare("INSERT INTO project_meta (key, value) VALUES ('get_returning', 'no') RETURNING value")
      .get(),
    () => projectDb
      .prepare("INSERT INTO project_meta (key, value) VALUES ('all_returning', 'no') RETURNING value")
      .all(),
    () => db.projectGet(
      project,
      "INSERT INTO project_meta (key, value) VALUES ('facade_get_returning', 'no') RETURNING value",
    ),
    () => db.projectQuery(
      project,
      "UPDATE project_meta SET value = 'after' WHERE key = 'returning_target' RETURNING value",
    ),
    () => projectDb
      .prepare('WITH one(value) AS (SELECT 1) SELECT value FROM one')
      .all(),
    () => projectDb.pragma('user_version = 73'),
  ]) {
    assert.throws(bypassAttempt, (error) => error.code === 'PROJECT_WRITE_BUSY');
  }

  assert.equal('_db' in projectDb, false);
  assert.equal('_store' in projectDb, false);
  const { store } = databaseInternals(projectDb);
  assert.throws(() => store.recover(), (error) => error.code === 'WRITER_LEASE_LOST');
  assert.throws(
    () => store.publish(store.currentConnection()),
    (error) => error.code === 'WRITER_LEASE_LOST',
  );

  lease.release();
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'returning_target'").get().value,
    'before',
  );
  assert.equal(
    projectDb.prepare("SELECT COUNT(*) AS count FROM project_meta WHERE key LIKE '%_returning'").get().count,
    0,
  );
  assert.equal(projectDb.prepare('PRAGMA user_version').get().user_version, 0);

  assert.deepEqual(
    projectDb
      .prepare("INSERT INTO project_meta (key, value) VALUES ('successful_returning', 'durable') RETURNING value")
      .get(),
    { value: 'durable' },
  );
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT value FROM project_meta WHERE key = 'successful_returning'",
    ),
    [{ value: 'durable' }],
  );
});

test('project transactions preserve synchronous durability, rollback, and thrown identity', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'transaction-terminal';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);

  const transactionResult = db.projectTransaction(project, () => {
    projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('tx_a', 'a')").run();
    projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('tx_b', 'b')").run();
    return 'committed';
  });
  assert.equal(transactionResult, 'committed');
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT key, value FROM project_meta WHERE key IN ('tx_a', 'tx_b') ORDER BY key",
    ),
    [{ key: 'tx_a', value: 'a' }, { key: 'tx_b', value: 'b' }],
  );

  const marker = new Error('transaction marker');
  assert.throws(
    () => db.projectTransaction(project, () => {
      projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('rolled_back', 'no')").run();
      throw marker;
    }),
    (error) => error === marker,
  );
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'rolled_back'").get(),
    null,
  );
  assert.deepEqual(
    await readFormalRows(projectPath, "SELECT value FROM project_meta WHERE key = 'rolled_back'"),
    [],
  );
  assert.equal(
    db.projectTransaction(project, () => 'later transaction'),
    'later transaction',
  );
});

test('a transaction callback thenable is rejected synchronously, rolled back, and absorbed', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'transaction-thenable';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  const rejection = new Error('late transaction rejection');
  const unhandled = [];
  const onUnhandled = (error) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  assert.throws(
    () => projectDb.transaction(() => {
      projectDb
        .prepare("INSERT INTO project_meta (key, value) VALUES ('async_tx', 'must roll back')")
        .run();
      return Promise.reject(rejection);
    })(),
    (error) => error.code === 'ASYNC_TRANSACTION_CALLBACK',
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(unhandled, []);
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'async_tx'").get(),
    null,
  );
  assert.deepEqual(
    await readFormalRows(projectPath, "SELECT value FROM project_meta WHERE key = 'async_tx'"),
    [],
  );
  assert.equal(db.projectTransaction(project, () => 'later transaction'), 'later transaction');
});

test('nested project transactions fail with a stable wrapper error and leave the outer transaction usable', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'transaction-nesting';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);

  assert.throws(
    () => projectDb.transaction(() => {
      projectDb
        .prepare("INSERT INTO project_meta (key, value) VALUES ('outer_before_nested', 'rollback')")
        .run();
      projectDb.transaction(() => 'inner')();
    })(),
    (error) => error.code === 'NESTED_TRANSACTION',
  );
  assert.equal(
    projectDb.prepare("SELECT value FROM project_meta WHERE key = 'outer_before_nested'").get(),
    null,
  );
  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT value FROM project_meta WHERE key = 'outer_before_nested'",
    ),
    [],
  );
  assert.equal(db.projectTransaction(project, () => 'later transaction'), 'later transaction');
});

test('a pre-prepared transaction publish failure keeps the committed mutation retryable', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'transaction-publish-retry';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);

  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => projectDb.transaction(() => {
        projectDb
          .prepare("INSERT INTO project_meta (key, value) VALUES ('committed_in_memory', 'retry me')")
          .run();
      })(),
      (error) => (
        error.code === 'EIO'
        && error.faultPoint === FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE
      ),
    );
  });

  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT value FROM project_meta WHERE key = 'committed_in_memory'",
    ),
    [],
  );

  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('successor', 'published together')")
    .run();

  assert.deepEqual(
    await readFormalRows(
      projectPath,
      "SELECT key, value FROM project_meta WHERE key IN ('committed_in_memory', 'successor') ORDER BY key",
    ),
    [
      { key: 'committed_in_memory', value: 'retry me' },
      { key: 'successor', value: 'published together' },
    ],
  );
});

test('project open-creation and schema migration cannot start without the project lease', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();

  const freshProject = 'blocked-create';
  const freshPath = db.getProjectDbPath(freshProject);
  const createLease = acquireExclusiveLease(projectLeasePath(dataDir, freshPath));
  assert.throws(
    () => db.createProjectDb(freshProject),
    (error) => error.code === 'PROJECT_WRITE_BUSY',
  );
  assert.equal(fs.existsSync(freshPath), false);
  createLease.release();

  const legacyPath = db.getProjectDbPath('blocked-migration');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const legacy = new SQL.Database();
  legacy.run('CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacy.run("INSERT INTO project_meta (key, value) VALUES ('schema_version', '8')");
  legacy.run('CREATE TABLE volumes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)');
  fs.writeFileSync(legacyPath, Buffer.from(legacy.export()));
  legacy.close();
  const beforeBytes = fs.readFileSync(legacyPath);
  const migrationLease = acquireExclusiveLease(projectLeasePath(dataDir, legacyPath));
  t.after(() => {
    if (migrationLease.isHeld()) migrationLease.release();
  });

  assert.throws(
    () => db.openProjectDb(legacyPath),
    (error) => error.code === 'PROJECT_WRITE_BUSY',
  );
  assert.deepEqual(fs.readFileSync(legacyPath), beforeBytes);
});

test('startup recovery rejects uncontrolled paths and arbitrary SQLite before control or migration writes', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });

  const arbitraryPath = db.getProjectDbPath('registered-arbitrary');
  const arbitrary = new SQL.Database();
  arbitrary.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  arbitrary.run("INSERT INTO notes (body) VALUES ('not a Mythpen project')");
  fs.writeFileSync(arbitraryPath, Buffer.from(arbitrary.export()));
  arbitrary.close();
  const arbitraryBefore = fs.readFileSync(arbitraryPath);
  const arbitraryKey = createHash('sha256')
    .update(canonicalDatabasePath(arbitraryPath))
    .digest('hex');
  const arbitraryControl = path.join(dataDir, 'control', 'sqlite', arbitraryKey);
  db.dbExecute(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
    ['registered-arbitrary', 'registered-arbitrary', arbitraryPath],
  );

  assert.throws(
    () => db.recoverProjectDatabasesAtStartup(),
    (error) => error.code === 'STARTUP_RECOVERY_NOT_PROJECT',
  );
  assert.deepEqual(fs.readFileSync(arbitraryPath), arbitraryBefore);
  assert.equal(fs.existsSync(arbitraryControl), false);

  db.dbExecute('DELETE FROM recent_projects WHERE id = ?', ['registered-arbitrary']);
  const outsidePath = path.join(path.dirname(dataDir), 'outside.mythpen.db');
  fs.copyFileSync(arbitraryPath, outsidePath);
  t.after(() => fs.rmSync(outsidePath, { force: true }));
  db.dbExecute(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
    ['registered-outside', 'registered-outside', outsidePath],
  );
  const outsideBefore = fs.readFileSync(outsidePath);

  assert.throws(
    () => db.recoverProjectDatabasesAtStartup(),
    (error) => error.code === 'STARTUP_RECOVERY_UNCONTROLLED_PATH',
  );
  assert.deepEqual(fs.readFileSync(outsidePath), outsideBefore);
  assert.throws(
    () => db.openProjectDb(outsidePath),
    (error) => error.code === 'PROJECT_DATABASE_UNCONTROLLED_PATH',
  );

  const excludedRolePaths = [
    db.getStoragePaths().configDbPath,
    path.join(dataDir, 'locks', 'lock.mythpen.db'),
    path.join(dataDir, 'control', 'sqlite', 'control.mythpen.db'),
    path.join(dataDir, 'control', 'sqlite-recovery', 'before.mythpen.db'),
    path.join(dataDir, 'projects', '.project.uuid.candidate.db'),
    path.join(dataDir, 'projects', '.project.uuid.rollback.db'),
  ];
  for (const excludedPath of excludedRolePaths) {
    assert.throws(
      () => db.openProjectDb(excludedPath),
      (error) => error.code === 'PROJECT_DATABASE_UNCONTROLLED_PATH',
      excludedPath,
    );
  }
});

test('startup recovery deterministically repairs known projects and ignores unknown artifacts', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const project = 'startup-recovery';
  const projectPath = db.getProjectDbPath(project);
  const projectDb = db.createProjectDb(project);
  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('startup_state', 'before')")
    .run();
  db.dbExecute(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
    [project, project, projectPath],
  );
  db.closeProjectDb(projectPath);

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const canonicalPath = canonicalDatabasePath(projectPath);
  const dbKey = createHash('sha256').update(canonicalPath).digest('hex');
  const controlDir = path.join(dataDir, 'control', 'sqlite', dbKey);
  const controlStore = openControlStore(controlDir);
  const interrupted = createAtomicStore({ filePath: projectPath, controlStore, sqlModule: SQL });
  const interruptedConnection = interrupted.currentConnection();
  interruptedConnection.run(
    "UPDATE project_meta SET value = 'after' WHERE key = 'startup_state'",
  );
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { throw: 'EIO' },
  }, () => {
    assert.throws(() => interrupted.publish(interruptedConnection), { code: 'EIO' });
  });
  interrupted.close();
  assert.deepEqual(
    await readFormalRows(projectPath, "SELECT value FROM project_meta WHERE key = 'startup_state'"),
    [{ value: 'before' }],
  );

  const unknownDir = path.join(dataDir, 'projects', 'unknown-nested');
  const unknownArtifact = path.join(unknownDir, 'do-not-touch.mythpen.db');
  fs.mkdirSync(unknownDir);
  fs.writeFileSync(unknownArtifact, 'unknown artifact');
  const recovered = db.recoverProjectDatabasesAtStartup();

  assert.deepEqual(recovered, [canonicalPath]);
  assert.deepEqual(
    await readFormalRows(projectPath, "SELECT value FROM project_meta WHERE key = 'startup_state'"),
    [{ value: 'after' }],
  );
  assert.equal(fs.readFileSync(unknownArtifact, 'utf8'), 'unknown artifact');
  assert.equal(controlStore.tail().type, 'sqlite.publish.committed');

  const parkedPath = `${projectPath}.parked`;
  fs.renameSync(projectPath, parkedPath);
  try {
    assert.throws(
      () => db.getProjectDb(project),
      (error) => error.code === 'PROJECT_NOT_FOUND',
      'a recovery-only connection must be closed and omitted from the resident cache',
    );
  } finally {
    fs.renameSync(parkedPath, projectPath);
  }
});

test('startup inspection isolates an unfinished project while leaving a healthy project ready', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const healthyName = 'startup-inspect-healthy';
  const isolatedName = 'startup-inspect-isolated';
  const healthyPath = db.getProjectDbPath(healthyName);
  const isolatedPath = db.getProjectDbPath(isolatedName);
  for (const [name, projectPath] of [
    [healthyName, healthyPath],
    [isolatedName, isolatedPath],
  ]) {
    const projectDb = db.createProjectDb(name);
    projectDb.prepare("INSERT INTO project_meta (key, value) VALUES ('startup_marker', 'before')").run();
    projectDb.flush();
    db.dbExecute(
      'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
      [name, name, projectPath],
    );
    db.closeProjectDb(projectPath);
  }

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const canonicalPath = canonicalDatabasePath(isolatedPath);
  const dbKey = createHash('sha256').update(canonicalPath).digest('hex');
  const controlDir = path.join(dataDir, 'control', 'sqlite', dbKey);
  const interruptedControl = openControlStore(controlDir);
  const interrupted = createAtomicStore({
    filePath: isolatedPath,
    controlStore: interruptedControl,
    sqlModule: SQL,
  });
  const interruptedConnection = interrupted.currentConnection();
  interruptedConnection.run(
    "UPDATE project_meta SET value = 'after' WHERE key = 'startup_marker'",
  );
  await withFaults({
    [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { throw: 'EIO' },
  }, () => {
    assert.throws(() => interrupted.publish(interruptedConnection), { code: 'EIO' });
  });
  interrupted.close();
  const evidenceBefore = interruptedControl.read();
  assert.equal(evidenceBefore.at(-1).type, 'sqlite.publish.prepared');

  const states = db.inspectProjectDatabasesAtStartup();

  assert.deepEqual(states.get(canonicalDatabasePath(healthyPath)), {
    openState: 'ready',
    reasonCode: null,
    recommendedAction: null,
  });
  assert.deepEqual(states.get(canonicalDatabasePath(isolatedPath)), {
    openState: 'isolated',
    reasonCode: 'V1_PUBLICATION_FORWARD_RECOVERABLE',
    recommendedAction: 'recover_v1_publication',
  });
  assert.equal(interruptedControl.tail().type, 'sqlite.publish.prepared');

  const originalLstatSync = fs.lstatSync;
  let repeatedReads = 0;
  fs.lstatSync = (...args) => {
    repeatedReads += 1;
    return originalLstatSync(...args);
  };
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => db.getProjectDb(isolatedName),
        (error) => error.code === 'V1_PUBLICATION_FORWARD_RECOVERABLE',
      );
    }
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(repeatedReads, 0, 'isolated access must rethrow its recorded state without reopening');

  db.removeProjectOpenState(isolatedPath);
  assert.equal(db.getProjectOpenState(isolatedPath), null);
});

test('startup recovery enforces its bound before opening any project', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  await db.initDatabase();
  const paths = ['startup-bound-a', 'startup-bound-b'].map((project) => {
    const projectPath = db.getProjectDbPath(project);
    db.createProjectDb(project);
    db.dbExecute(
      'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
      [project, project, projectPath],
    );
    db.closeProjectDb(projectPath);
    return projectPath;
  });
  const before = paths.map((projectPath) => fs.readFileSync(projectPath));
  const originalLstatSync = fs.lstatSync;
  let inspectedPaths = 0;
  fs.lstatSync = (...args) => {
    inspectedPaths += 1;
    return originalLstatSync(...args);
  };

  try {
    assert.throws(
      () => db.recoverProjectDatabasesAtStartup({ maxProjects: 1 }),
      (error) => error.code === 'STARTUP_RECOVERY_LIMIT',
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(inspectedPaths, 0, 'the raw row bound must fail before any path inspection');
  paths.forEach((projectPath, index) => {
    assert.deepEqual(fs.readFileSync(projectPath), before[index]);
  });
});
