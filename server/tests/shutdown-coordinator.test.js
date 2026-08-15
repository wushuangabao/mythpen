const assert = require('node:assert/strict');
const test = require('node:test');

const { createProjectWriteCoordinator } = require('../project-write-coordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createHeldLease(onRelease = () => {}) {
  let held = true;
  return {
    isHeld() {
      return held;
    },
    release() {
      onRelease();
      held = false;
    },
  };
}

function createExactPendingCheckpointJob({ installCheckpoint, verifyCurrent }) {
  Object.freeze(installCheckpoint);
  Object.freeze(verifyCurrent);
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

function isShuttingDown(error) {
  return error?.code === 'SERVICE_SHUTTING_DOWN';
}

function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for lifecycle condition'));
        return;
      }
      setImmediate(poll);
    };
    poll();
  });
}

function createLifecycleCoordinator(drains) {
  const calls = [];
  let index = 0;
  return {
    calls,
    beginQuiesce() {
      const token = Object.freeze({ id: index });
      calls.push(['begin', token]);
      return token;
    },
    cancelQuiesce(token) {
      calls.push(['cancel', token]);
    },
    drain(token) {
      calls.push(['drain', token]);
      const selected = drains[index];
      index += 1;
      return selected.promise;
    },
  };
}

function createManualTimers() {
  const timers = [];
  return {
    clearTimer(timer) {
      if (timer) timer.active = false;
    },
    fireLatest() {
      const timer = [...timers].reverse().find((candidate) => candidate.active);
      assert.ok(timer, 'an active soft-deadline timer is required');
      timer.active = false;
      timer.callback();
    },
    setTimer(callback, delay) {
      const timer = { active: true, callback, delay };
      timers.push(timer);
      return timer;
    },
    timers,
  };
}

test('beginQuiesce rejects every new outer mutation before path, lock, recovery, or callback work', async () => {
  const calls = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      calls.push('lease');
      return createHeldLease();
    },
    canonicalizeProjectKey(projectKey) {
      calls.push('canonicalize');
      return projectKey;
    },
    lockRoot() {
      calls.push('lock-root');
      return 'unused';
    },
    recoverProject() {
      calls.push('recover');
    },
  });

  const quiesce = coordinator.beginQuiesce();
  assert.equal(coordinator.admissionState, 'quiescing');
  assert.throws(
    () => coordinator.withProjectWrite('alpha', () => calls.push('async-callback')),
    isShuttingDown,
  );
  assert.throws(
    () => coordinator.withProjectWriteSync('alpha', () => calls.push('sync-callback')),
    isShuttingDown,
  );
  assert.throws(
    () => coordinator.withProjectRecoveryLeaseSync('alpha', () => calls.push('recovery-callback')),
    isShuttingDown,
  );
  assert.throws(
    () => coordinator.withProjectLogicalRequestSync('alpha', () => calls.push('logical-callback')),
    isShuttingDown,
  );
  assert.throws(
    () => coordinator.runPendingProjectMaintenanceSync('alpha'),
    isShuttingDown,
  );
  await coordinator.drain(quiesce);
  assert.deepEqual(calls, []);
});

test('pending checkpoint alone does not hold drain open or start maintenance', async () => {
  const calls = [];
  let releaseCount = 0;
  const receipt = Object.freeze({ checkpointDigest: 'c'.repeat(64), coveredSeq: 1 });
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      calls.push('lease');
      return createHeldLease(() => {
        releaseCount += 1;
        calls.push('release');
      });
    },
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
    recoverProject() {
      calls.push('recover');
    },
  });
  const job = createExactPendingCheckpointJob({
    verifyCurrent: function verifyCurrent() {
      assert.equal(arguments.length, 0);
      calls.push('verify');
      return true;
    },
    installCheckpoint: function installCheckpoint() {
      assert.equal(arguments.length, 0);
      calls.push('install');
      return receipt;
    },
  });

  assert.equal(
    coordinator.withProjectLogicalRequestSync('alpha', ({ registerPendingCheckpoint }) => {
      assert.equal(registerPendingCheckpoint(job), undefined);
      calls.push('registered');
    }),
    undefined,
  );
  assert.deepEqual(calls, ['lease', 'registered', 'release']);
  assert.equal(releaseCount, 1);

  const quiesce = coordinator.beginQuiesce();
  const drained = coordinator.drain(quiesce);
  assert.equal(Bun.peek.status(drained), 'fulfilled');
  await drained;
  assert.deepEqual(calls, ['lease', 'registered', 'release']);
  assert.equal(coordinator.leaseAcquisitionCount('alpha'), 1);

  coordinator.cancelQuiesce(quiesce);
  assert.equal(coordinator.runPendingProjectMaintenanceSync('alpha'), receipt);
  assert.deepEqual(calls, [
    'lease',
    'registered',
    'release',
    'lease',
    'verify',
    'install',
    'release',
  ]);
  assert.equal(releaseCount, 2);
});

test('drain waits for an already-started maintenance runner to finish and release', async () => {
  const calls = [];
  const receipt = Object.freeze({ checkpointDigest: 'c'.repeat(64), coveredSeq: 1 });
  let drainPromise;
  let quiesce;
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      calls.push('lease');
      return createHeldLease(() => calls.push('release'));
    },
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
    recoverProject() {
      calls.push('recover');
    },
  });
  const job = createExactPendingCheckpointJob({
    verifyCurrent: function verifyCurrent() {
      calls.push('verify');
      return true;
    },
    installCheckpoint: function installCheckpoint() {
      calls.push('install:start');
      quiesce = coordinator.beginQuiesce();
      drainPromise = coordinator.drain(quiesce);
      assert.equal(Bun.peek.status(drainPromise), 'pending');
      calls.push('install:end');
      return receipt;
    },
  });

  coordinator.withProjectLogicalRequestSync('alpha', ({ registerPendingCheckpoint }) => {
    registerPendingCheckpoint(job);
    calls.push('registered');
  });
  assert.equal(coordinator.runPendingProjectMaintenanceSync('alpha'), receipt);
  assert.equal(Bun.peek.status(drainPromise), 'fulfilled');
  await drainPromise;
  assert.deepEqual(calls, [
    'lease',
    'registered',
    'release',
    'lease',
    'verify',
    'install:start',
    'install:end',
    'release',
  ]);
  assert.equal(calls.includes('recover'), false);
  coordinator.cancelQuiesce(quiesce);
});

test('drain waits for an already-started maintenance runner failure to release', async () => {
  const calls = [];
  const installError = new Error('injected maintenance failure');
  let drainPromise;
  let quiesce;
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      calls.push('lease');
      return createHeldLease(() => calls.push('release'));
    },
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
    recoverProject() {
      calls.push('recover');
    },
  });
  const job = createExactPendingCheckpointJob({
    verifyCurrent: function verifyCurrent() {
      calls.push('verify');
      return true;
    },
    installCheckpoint: function installCheckpoint() {
      calls.push('install');
      quiesce = coordinator.beginQuiesce();
      drainPromise = coordinator.drain(quiesce);
      assert.equal(Bun.peek.status(drainPromise), 'pending');
      throw installError;
    },
  });

  coordinator.withProjectLogicalRequestSync('alpha', ({ registerPendingCheckpoint }) => {
    registerPendingCheckpoint(job);
    calls.push('registered');
  });
  assert.throws(
    () => coordinator.runPendingProjectMaintenanceSync('alpha'),
    (error) => error === installError,
  );
  assert.equal(Bun.peek.status(drainPromise), 'fulfilled');
  await drainPromise;
  assert.deepEqual(calls, [
    'lease',
    'registered',
    'release',
    'lease',
    'verify',
    'install',
    'release',
  ]);
  assert.equal(calls.includes('recover'), false);
  coordinator.cancelQuiesce(quiesce);
});

test('drain waits for admitted current, queued, reentrant work and successful lease release', async () => {
  const entered = deferred();
  const unblock = deferred();
  const order = [];
  const reactions = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      order.push('lease:acquire');
      return createHeldLease(() => order.push('lease:release'));
    },
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
    recoverProject() {
      order.push('recover');
    },
  });

  const first = coordinator.withProjectWrite('alpha', async () => {
    order.push('first:start');
    entered.resolve();
    await unblock.promise;
    await coordinator.withProjectWrite('alpha', () => {
      order.push('reentrant');
    });
    order.push('first:end');
  });
  await entered.promise;
  const second = coordinator.withProjectWrite('alpha', () => {
    order.push('second');
  });
  const quiesce = coordinator.beginQuiesce();
  let drainSettled = false;
  const observedFirst = first.then(() => { reactions.push('first:settled'); });
  const observedSecond = second.then(() => { reactions.push('second:settled'); });
  const drained = coordinator.drain(quiesce).then(() => {
    drainSettled = true;
    reactions.push('drain:settled');
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainSettled, false);
  unblock.resolve();
  await Promise.all([observedFirst, observedSecond, drained]);

  assert.deepEqual(order, [
    'lease:acquire',
    'recover',
    'first:start',
    'reentrant',
    'first:end',
    'recover',
    'second',
    'lease:release',
  ]);
  assert.deepEqual(reactions, [
    'first:settled',
    'second:settled',
    'drain:settled',
  ]);
  assert.equal(drainSettled, true);
});

test('a normal callback rejection does not fail drain when lease disposition is known', async () => {
  const entered = deferred();
  const unblock = deferred();
  const callbackError = new Error('expected business rejection');
  const order = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease: () => createHeldLease(() => order.push('lease:release')),
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
  });
  const write = coordinator.withProjectWrite('alpha', async () => {
    entered.resolve();
    await unblock.promise;
    throw callbackError;
  });
  await entered.promise;
  const quiesce = coordinator.beginQuiesce();
  const observedWrite = write.then(
    () => { throw new Error('expected the business callback to reject'); },
    (error) => {
      order.push('write:rejected');
      return error;
    },
  );
  const drained = coordinator.drain(quiesce).then(() => order.push('drained'));

  unblock.resolve();
  assert.equal(await observedWrite, callbackError);
  await drained;
  assert.deepEqual(order, ['lease:release', 'write:rejected', 'drained']);
});

test('a release disposition error rejects both the admitted write and global drain', async () => {
  const entered = deferred();
  const unblock = deferred();
  const releaseError = new Error('injected release disposition unknown');
  const losses = [];
  const coordinator = createProjectWriteCoordinator({
    acquireLease() {
      return {
        isHeld: () => true,
        release() {
          throw releaseError;
        },
      };
    },
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
    onLeaseLost(projectKey, error) {
      losses.push({ error, projectKey });
    },
  });
  const write = coordinator.withProjectWrite('alpha', async () => {
    entered.resolve();
    await unblock.promise;
  });
  await entered.promise;
  const quiesce = coordinator.beginQuiesce();
  const drained = coordinator.drain(quiesce);

  unblock.resolve();
  await assert.rejects(
    write,
    (error) => error?.code === 'WRITER_LEASE_LOST' && error.cause === releaseError,
  );
  await assert.rejects(
    drained,
    (error) => error?.code === 'WRITER_LEASE_LOST' && error.cause === releaseError,
  );
  assert.equal(losses.length, 1);
  assert.equal(losses[0].projectKey, 'alpha');
});

test('cancelQuiesce restores outer admission without reviving an invalid disposition', async () => {
  const coordinator = createProjectWriteCoordinator({
    acquireLease: () => createHeldLease(),
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
  });
  const quiesce = coordinator.beginQuiesce();
  coordinator.cancelQuiesce(quiesce);
  assert.equal(coordinator.admissionState, 'running');
  assert.equal(coordinator.withProjectWriteSync('alpha', () => 'accepted'), 'accepted');
  assert.throws(() => coordinator.cancelQuiesce(quiesce), isShuttingDown);

  const releaseError = new Error('unknown release');
  const failed = createProjectWriteCoordinator({
    acquireLease: () => ({ isHeld: () => true, release: () => { throw releaseError; } }),
    canonicalizeProjectKey: (projectKey) => projectKey,
    lockRoot: '.',
  });
  assert.throws(
    () => failed.withProjectWriteSync('beta', () => {}),
    (error) => error?.code === 'WRITER_LEASE_LOST',
  );
  const failedQuiesce = failed.beginQuiesce();
  assert.throws(
    () => failed.cancelQuiesce(failedQuiesce),
    (error) => error?.code === 'WRITER_LEASE_LOST',
  );
  assert.equal(failed.admissionState, 'quiescing');
});

test('attempt sequence, cancel, and service epoch make an old drain continuation inert', async () => {
  const { createServiceLifecycle } = require('../service-lifecycle');
  const firstDrain = deferred();
  const secondDrain = deferred();
  const coordinator = createLifecycleCoordinator([firstDrain, secondDrain]);
  const frames = [];
  const closes = [];
  const lifecycle = createServiceLifecycle({
    childPid: 55,
    closeDatabases: () => { closes.push('databases'); },
    closeListener: async () => { closes.push('listener'); },
    coordinator,
    sendFrame: async (type, payload) => { frames.push({ type, ...payload }); },
    softDeadlineMs: 10_000,
  });

  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 1 });
  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 1 });
  assert.equal(coordinator.calls.filter(([name]) => name === 'begin').length, 1);
  await assert.rejects(
    lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 3 }),
    (error) => error?.code === 'CONTROL_ATTEMPT_INVALID',
  );

  await lifecycle.handleCommand({ type: 'shutdown.cancel', attemptSeq: 1 });
  assert.equal(lifecycle.state, 'running');
  assert.equal(lifecycle.serviceEpoch, 2);
  assert.deepEqual(frames.at(-1), {
    type: 'shutdown.cancelled',
    childPid: 55,
    attemptSeq: 1,
    outcome: 'cancelled',
    serviceEpoch: 2,
  });
  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 1 });
  assert.equal(coordinator.calls.filter(([name]) => name === 'begin').length, 1);

  firstDrain.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closes, []);

  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 2 });
  secondDrain.resolve();
  assert.deepEqual(await lifecycle.waitForAttempt(2), { outcome: 'clean' });
  assert.deepEqual(closes, ['listener', 'databases']);
  assert.equal(lifecycle.state, 'complete');
});

test('soft deadline and continue-wait only notify or rearm without changing lifecycle state', async () => {
  const { createServiceLifecycle } = require('../service-lifecycle');
  const drain = deferred();
  const coordinator = createLifecycleCoordinator([drain]);
  const manualTimers = createManualTimers();
  const frames = [];
  let closeCalls = 0;
  const lifecycle = createServiceLifecycle({
    childPid: 77,
    clearTimer: manualTimers.clearTimer,
    closeDatabases: () => { closeCalls += 1; },
    closeListener: async () => { closeCalls += 1; },
    coordinator,
    sendFrame: async (type, payload) => { frames.push({ type, ...payload }); },
    setTimer: manualTimers.setTimer,
    softDeadlineMs: 1234,
  });

  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 1 });
  assert.equal(lifecycle.state, 'draining');
  assert.equal(manualTimers.timers.at(-1).delay, 1234);
  manualTimers.fireLatest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(frames.at(-1), {
    type: 'shutdown.soft_deadline',
    childPid: 77,
    attemptSeq: 1,
    state: 'draining',
  });

  await lifecycle.handleCommand({ type: 'shutdown.continue_wait', attemptSeq: 1 });
  assert.equal(lifecycle.state, 'draining');
  assert.equal(manualTimers.timers.filter((timer) => timer.active).length, 1);
  assert.equal(closeCalls, 0);
  await lifecycle.handleCommand({ type: 'shutdown.cancel', attemptSeq: 1 });
  assert.equal(manualTimers.timers.filter((timer) => timer.active).length, 0);
  assert.equal(closeCalls, 0);
  drain.resolve();
});

test('soft deadline remains rearmable while listener close is pending', async () => {
  const { createServiceLifecycle } = require('../service-lifecycle');
  const drain = deferred();
  drain.resolve();
  const listenerEntered = deferred();
  const releaseListener = deferred();
  const manualTimers = createManualTimers();
  const frames = [];
  const lifecycle = createServiceLifecycle({
    childPid: 78,
    clearTimer: manualTimers.clearTimer,
    closeDatabases: async () => {},
    closeListener: async () => {
      listenerEntered.resolve();
      await releaseListener.promise;
    },
    coordinator: createLifecycleCoordinator([drain]),
    sendFrame: async (type, payload) => { frames.push({ type, ...payload }); },
    setTimer: manualTimers.setTimer,
    softDeadlineMs: 1234,
  });

  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 1 });
  await listenerEntered.promise;
  assert.equal(lifecycle.state, 'closing');
  manualTimers.fireLatest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(frames.at(-1), {
    type: 'shutdown.soft_deadline',
    childPid: 78,
    attemptSeq: 1,
    state: 'closing',
  });

  await lifecycle.handleCommand({ type: 'shutdown.continue_wait', attemptSeq: 1 });
  assert.equal(manualTimers.timers.filter((timer) => timer.active).length, 1);
  manualTimers.fireLatest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    frames.filter((frame) => frame.type === 'shutdown.soft_deadline').length,
    2,
  );

  releaseListener.resolve();
  assert.deepEqual(await lifecycle.waitForAttempt(1), { outcome: 'clean' });
  assert.equal(manualTimers.timers.filter((timer) => timer.active).length, 0);
});

test('complete is emitted only after listener and database close, and closing rejects cancel', async () => {
  const { createServiceLifecycle } = require('../service-lifecycle');
  const drain = deferred();
  drain.resolve();
  const listenerEntered = deferred();
  const releaseListener = deferred();
  const releaseDatabases = deferred();
  const order = [];
  const frames = [];
  const lifecycle = createServiceLifecycle({
    childPid: 88,
    closeDatabases: async () => {
      order.push('databases:start');
      await releaseDatabases.promise;
      order.push('databases:end');
    },
    closeListener: async () => {
      order.push('listener:start');
      listenerEntered.resolve();
      await releaseListener.promise;
      order.push('listener:end');
    },
    coordinator: createLifecycleCoordinator([drain]),
    sendFrame: async (type, payload) => {
      frames.push({ type, ...payload });
      order.push(`frame:${type}`);
    },
  });

  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 1 });
  await listenerEntered.promise;
  assert.equal(lifecycle.state, 'closing');
  await assert.rejects(
    lifecycle.handleCommand({ type: 'shutdown.cancel', attemptSeq: 1 }),
    (error) => error?.code === 'CONTROL_CANCEL_TOO_LATE',
  );
  assert.equal(frames.some((frame) => frame.type === 'shutdown.complete'), false);

  releaseListener.resolve();
  await waitFor(() => order.includes('databases:start'));
  assert.equal(frames.some((frame) => frame.type === 'shutdown.complete'), false);
  releaseDatabases.resolve();
  assert.deepEqual(await lifecycle.waitForAttempt(1), { outcome: 'clean' });
  assert.deepEqual(frames.at(-1), {
    type: 'shutdown.complete',
    childPid: 88,
    attemptSeq: 1,
    outcome: 'clean',
  });
  assert.deepEqual(order.slice(-5), [
    'listener:start',
    'listener:end',
    'databases:start',
    'databases:end',
    'frame:shutdown.complete',
  ]);
});

test('an unknown close disposition emits failed and never complete', async () => {
  const { createServiceLifecycle } = require('../service-lifecycle');
  const drain = deferred();
  drain.resolve();
  const closeError = new Error('injected storage close failure');
  const frames = [];
  const lifecycle = createServiceLifecycle({
    childPid: 99,
    closeDatabases() {
      throw closeError;
    },
    closeListener: async () => {},
    coordinator: createLifecycleCoordinator([drain]),
    sendFrame: async (type, payload) => { frames.push({ type, ...payload }); },
  });

  await lifecycle.handleCommand({ type: 'shutdown.request', attemptSeq: 1 });
  assert.deepEqual(await lifecycle.waitForAttempt(1), {
    outcome: 'failed',
    code: 'STORAGE_UNAVAILABLE',
  });
  assert.equal(lifecycle.state, 'failed');
  assert.deepEqual(frames.at(-1), {
    type: 'shutdown.failed',
    childPid: 99,
    attemptSeq: 1,
    outcome: 'failed',
    code: 'STORAGE_UNAVAILABLE',
  });
  assert.equal(frames.some((frame) => frame.type === 'shutdown.complete'), false);
});
