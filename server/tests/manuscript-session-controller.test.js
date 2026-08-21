'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ManuscriptSessionController } = require('../manuscript/session-controller');

const INSTANCE_A = '00000000-0000-4000-8000-abcdefabcdef';
const INSTANCE_B = '00000000-0000-4000-8000-bcdefabcdefa';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function projectSelector(name = 'novel', expectedInstanceId = INSTANCE_A) {
  return { name, expectedInstanceId };
}

function projectIdentity({ ino = '101', canonical = 'C:\\Mythpen\\control\\project-a' } = {}) {
  return deepFreeze({
    projectUid: '00000000-0000-4000-8000-000000000010',
    projectInstanceId: INSTANCE_A,
    lifecyclePlatformIdentity: {
      canonicalRealControlDirectory: canonical,
      controlDirectoryIdentity: { dev: '7', ino },
      controlParentDirectoryIdentity: { dev: '7', ino: '100' },
      lifecycleLockIdentity: { dev: '7', ino: `${ino}0` },
    },
  });
}

function lifecycleError(message = 'lifecycle release failed') {
  const error = new Error(message, { cause: new Error('native cause') });
  error.code = 'NATIVE_RELEASE_UNKNOWN';
  return error;
}

function makeLease({ events, releaseDisposition = 'UNLOCKED_AND_CLOSED', releaseError } = {}) {
  let state = 'HELD';
  const lease = {
    get state() {
      return state;
    },
    release() {
      events?.push('release');
      if (releaseError) {
        state = 'RELEASE_DISPOSITION_UNKNOWN';
        throw releaseError;
      }
      state = 'RELEASED';
      return Object.freeze({ disposition: releaseDisposition });
    },
  };
  return Object.freeze(lease);
}

function harness({
  acquire,
  freshness,
  identities,
  identity = projectIdentity(),
  registry,
  verify,
} = {}) {
  const events = [];
  const calls = {
    acquireIdentities: [],
    acquireExclusive: 0,
    acquireShared: 0,
    assertBinding: 0,
    createOwner: 0,
    freshnessAdmit: 0,
    freshnessClose: 0,
    freshnessStart: 0,
    operation: 0,
    registry: 0,
    release: 0,
    verify: 0,
    verifiedIdentities: [],
  };
  const leases = [];
  const identityByName = identities || new Map();
  const lifecycleLeaseAdapter = {
    acquireExclusive() {
      calls.acquireExclusive += 1;
      throw new Error('Task 8B must not acquire an exclusive lease');
    },
    async acquireShared(exactIdentity) {
      calls.acquireShared += 1;
      calls.acquireIdentities.push(exactIdentity);
      events.push('shared');
      if (acquire) return acquire(exactIdentity, calls.acquireShared);
      const lease = makeLease({ events: { push: () => { calls.release += 1; events.push('release'); } } });
      leases.push(lease);
      return lease;
    },
  };
  const registryAdmission = registry || {
    async withProjectIdentity(selector, callback) {
      calls.registry += 1;
      events.push('config enter');
      try {
        events.push('identity');
        return await callback(identityByName.get(selector.name) || identity);
      } finally {
        events.push('config exit');
      }
    },
  };
  const routeAdmissionVerifier = {
    async verifyAfterLease(exactIdentity) {
      calls.verify += 1;
      calls.verifiedIdentities.push(exactIdentity);
      events.push('verify');
      return verify?.(exactIdentity, calls.verify);
    },
  };
  const defaultOwnerRecords = new WeakMap();
  const defaultAdmissionRecords = new WeakMap();
  const freshnessLifecycle = freshness || Object.freeze({
    createOwner(exactIdentity) {
      calls.createOwner += 1;
      events.push('owner');
      const owner = Object.freeze({});
      defaultOwnerRecords.set(owner, {
        drainPromise: null,
        drainResolve: null,
        gates: 0,
        identity: exactIdentity,
        state: 'inert',
      });
      return owner;
    },
    async start(owner, exactIdentity) {
      calls.freshnessStart += 1;
      events.push('start');
      const ownerRecord = defaultOwnerRecords.get(owner);
      assert.ok(ownerRecord);
      assert.equal(ownerRecord.identity, exactIdentity);
      assert.equal(ownerRecord.state, 'inert');
      ownerRecord.state = 'active';
    },
    async assertSameBinding(owner, exactIdentity) {
      calls.assertBinding += 1;
      events.push('binding');
      const ownerRecord = defaultOwnerRecords.get(owner);
      assert.ok(ownerRecord);
      assert.equal(ownerRecord.identity.lifecyclePlatformIdentity.controlDirectoryIdentity.dev,
        exactIdentity.lifecyclePlatformIdentity.controlDirectoryIdentity.dev);
      assert.equal(ownerRecord.identity.lifecyclePlatformIdentity.controlDirectoryIdentity.ino,
        exactIdentity.lifecyclePlatformIdentity.controlDirectoryIdentity.ino);
    },
    async admit(owner, operation) {
      calls.freshnessAdmit += 1;
      const ownerRecord = defaultOwnerRecords.get(owner);
      assert.equal(ownerRecord?.state, 'active');
      const admission = Object.freeze({});
      defaultAdmissionRecords.set(admission, ownerRecord);
      ownerRecord.gates += 1;
      try {
        return await operation(admission);
      } finally {
        ownerRecord.gates -= 1;
        if (ownerRecord.gates === 0 && ownerRecord.drainResolve) {
          const resolve = ownerRecord.drainResolve;
          ownerRecord.drainResolve = null;
          ownerRecord.drainPromise = null;
          resolve();
        }
      }
    },
    async close(owner) {
      calls.freshnessClose += 1;
      const ownerRecord = defaultOwnerRecords.get(owner);
      assert.ok(ownerRecord);
      ownerRecord.state = 'stopping';
      if (ownerRecord.gates !== 0) {
        ownerRecord.drainPromise ||= new Promise((resolve) => {
          ownerRecord.drainResolve = resolve;
        });
        await ownerRecord.drainPromise;
      }
      events.push('feed close');
      ownerRecord.state = 'closed';
      return Object.freeze({ disposition: 'CLOSED' });
    },
  });
  const controller = new ManuscriptSessionController({
    freshnessLifecycle,
    lifecycleLeaseAdapter,
    registryAdmission,
    routeAdmissionVerifier,
  });
  return {
    calls,
    controller,
    events,
    freshnessLifecycle,
    identity,
    leases,
    lifecycleLeaseAdapter,
    registryAdmission,
    routeAdmissionVerifier,
  };
}

async function rejectsSame(promise, expected) {
  await assert.rejects(promise, (actual) => actual === expected);
}

function isCanonicalLifecycleError(error, expectedCause) {
  assert.equal(error?.code, 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE');
  assert.equal(error.message, error.code);
  assert.equal(Object.isFrozen(error.details), true);
  assert.deepEqual(error.details, {});
  if (arguments.length > 1) assert.equal(error.cause, expectedCause);
  return true;
}

async function turn() {
  await Promise.resolve();
  await Promise.resolve();
}

test('constructor and selector validation fail before registry, lease, verifier, or operation', async () => {
  const valid = {
    freshnessLifecycle: {
      createOwner() {},
      start() {},
      assertSameBinding() {},
      admit() {},
      close() {},
    },
    lifecycleLeaseAdapter: { acquireShared() {} },
    registryAdmission: { withProjectIdentity() {} },
    routeAdmissionVerifier: { verifyAfterLease() {} },
  };
  for (const options of [
    undefined,
    {},
    { ...valid, lifecycleLeaseAdapter: null },
    { ...valid, lifecycleLeaseAdapter: {} },
    { ...valid, freshnessLifecycle: {} },
    { ...valid, registryAdmission: {} },
    { ...valid, routeAdmissionVerifier: {} },
  ]) {
    assert.throws(() => new ManuscriptSessionController(options), TypeError);
  }

  const { calls, controller } = harness();
  const invalidSelectors = [
    null,
    [],
    {},
    { name: '', expectedInstanceId: INSTANCE_A },
    { name: 'novel', expectedInstanceId: '' },
    { name: 'novel', expectedInstanceId: INSTANCE_A.toUpperCase() },
    { name: 'novel', expectedInstanceId: INSTANCE_A, path: 'C:\\escape' },
    { name: 'novel', expectedInstanceId: INSTANCE_A, controlDirectoryIdentity: { dev: '7', ino: '1' } },
  ];
  for (const selector of invalidSelectors) {
    await assert.rejects(controller.openSession(selector), TypeError);
  }
  assert.deepEqual(calls, {
    acquireIdentities: [],
    acquireExclusive: 0,
    acquireShared: 0,
    assertBinding: 0,
    createOwner: 0,
    freshnessAdmit: 0,
    freshnessClose: 0,
    freshnessStart: 0,
    operation: 0,
    registry: 0,
    release: 0,
    verify: 0,
    verifiedIdentities: [],
  });
});

test('open, admit, and close follow the fixed order and return only an opaque session', async () => {
  const { calls, controller, events, identity } = harness();

  const session = await controller.openSession(projectSelector());
  assert.deepEqual(events, [
    'config enter',
    'identity',
    'shared',
    'verify',
    'owner',
    'config exit',
    'start',
  ]);
  assert.equal(calls.acquireIdentities[0], identity.lifecyclePlatformIdentity);
  assert.equal(calls.verifiedIdentities[0], identity);
  assert.equal(Object.isFrozen(session), true);
  assert.deepEqual(Reflect.ownKeys(session), []);

  const result = await controller.admit(session, async (admission) => {
    assert.equal(Object.isFrozen(admission), true);
    assert.deepEqual(Reflect.ownKeys(admission), []);
    calls.operation += 1;
    events.push('operation');
    return 42;
  });
  assert.equal(result, 42);
  await controller.close(session);
  assert.deepEqual(events, [
    'config enter',
    'identity',
    'shared',
    'verify',
    'owner',
    'config exit',
    'start',
    'operation',
    'feed close',
    'release',
  ]);
  assert.equal(calls.acquireExclusive, 0);
  assert.equal(calls.createOwner, 1);
  assert.equal(calls.freshnessStart, 1);
  assert.equal(calls.freshnessAdmit, 1);
  assert.equal(calls.freshnessClose, 1);
  assert.equal(controller.beginRetiring, undefined);
  assert.equal(controller.drain, undefined);
});

test('invalid or non-frozen registry identity is rejected before shared acquire and verification', async () => {
  for (const identity of [
    {
      lifecyclePlatformIdentity: {
        canonicalRealControlDirectory: 'C:\\Mythpen\\control\\project-a',
        controlDirectoryIdentity: { dev: '7', ino: '101' },
        controlParentDirectoryIdentity: { dev: '7', ino: '100' },
        lifecycleLockIdentity: { dev: '7', ino: '1010' },
      },
    },
    deepFreeze({
      lifecyclePlatformIdentity: {
        canonicalRealControlDirectory: 'C:\\Mythpen\\control\\project-a',
        controlDirectoryIdentity: { dev: '07', ino: '101' },
        controlParentDirectoryIdentity: { dev: '7', ino: '100' },
        lifecycleLockIdentity: { dev: '7', ino: '1010' },
      },
    }),
    deepFreeze({
      lifecyclePlatformIdentity: {
        canonicalRealControlDirectory: 'C:\\Mythpen\\control\\project-a',
        controlDirectoryIdentity: { dev: '7', ino: '101' },
        controlParentDirectoryIdentity: { dev: '7', ino: '100' },
        lifecycleLockIdentity: { dev: '7', ino: '1010' },
        callerPath: 'C:\\not-authoritative',
      },
    }),
  ]) {
    const fixture = harness({ identity });
    await assert.rejects(fixture.controller.openSession(projectSelector()), TypeError);
    assert.equal(fixture.calls.acquireShared, 0);
    assert.equal(fixture.calls.verify, 0);
    assert.deepEqual(fixture.events, ['config enter', 'identity', 'config exit']);
  }
});

test('concurrent first-open reserves one physical-key entry and shares one bottom handle', async () => {
  const pendingAcquire = deferred();
  const events = [];
  const lease = makeLease({ events: { push: () => events.push('release') } });
  const identityA = projectIdentity();
  const identityAlias = projectIdentity();
  const fixture = harness({
    acquire: () => pendingAcquire.promise,
    identities: new Map([
      ['novel-a', identityA],
      ['renamed-alias', identityAlias],
    ]),
  });

  const first = fixture.controller.openSession(projectSelector('novel-a', INSTANCE_A));
  const second = fixture.controller.openSession(projectSelector('renamed-alias', INSTANCE_B));
  await turn();
  assert.equal(fixture.calls.acquireShared, 1);
  pendingAcquire.resolve(lease);
  const [sessionA, sessionB] = await Promise.all([first, second]);
  assert.equal(fixture.calls.verify, 2);
  assert.equal(fixture.calls.createOwner, 1);
  assert.equal(fixture.calls.freshnessStart, 1);
  assert.equal(fixture.calls.assertBinding, 1);

  await fixture.controller.close(sessionA);
  assert.deepEqual(events, []);
  assert.equal(await fixture.controller.admit(sessionB, () => 'still-open'), 'still-open');
  await fixture.controller.close(sessionB);
  assert.deepEqual(events, ['release']);
  assert.equal(fixture.calls.acquireExclusive, 0);
});

test('same dev:ino with conflicting canonical, parent, or lock binding is rejected without another acquire', async () => {
  const base = projectIdentity();
  const conflicts = [
    projectIdentity({ canonical: 'C:\\Mythpen\\control\\different' }),
    deepFreeze({
      ...base,
      lifecyclePlatformIdentity: {
        ...base.lifecyclePlatformIdentity,
        controlParentDirectoryIdentity: { dev: '7', ino: '999' },
      },
    }),
    deepFreeze({
      ...base,
      lifecyclePlatformIdentity: {
        ...base.lifecyclePlatformIdentity,
        lifecycleLockIdentity: { dev: '7', ino: '999' },
      },
    }),
  ];

  for (const [index, conflict] of conflicts.entries()) {
    let releases = 0;
    const lease = makeLease({ events: { push: () => { releases += 1; } } });
    const fixture = harness({
      acquire: () => lease,
      identities: new Map([
        ['base', base],
        ['conflict', conflict],
      ]),
    });
    const session = await fixture.controller.openSession(projectSelector('base'));
    await assert.rejects(
      fixture.controller.openSession(projectSelector('conflict', INSTANCE_B)),
      (error) => isCanonicalLifecycleError(error),
      `conflict ${index} must fail closed`,
    );
    assert.equal(fixture.calls.acquireShared, 1);
    assert.equal(fixture.calls.verify, 1);
    assert.equal(releases, 0);
    await fixture.controller.close(session);
    assert.equal(releases, 1);
  }
});

test('an acquire failure rejects every joiner by identity and a later open acquires afresh', async () => {
  const firstAcquire = deferred();
  const nestedCause = new Error('LockFileEx');
  nestedCause.releaseDispositionUnknown = true;
  const acquireError = new Error('shared busy', { cause: nestedCause });
  acquireError.code = 'PROJECT_WRITE_BUSY';
  let getterCalls = 0;
  Object.defineProperty(acquireError, 'releaseDispositionUnknown', {
    get() {
      getterCalls += 1;
      throw new Error('releaseDispositionUnknown getter must not run');
    },
  });
  let replacementReleaseCalls = 0;
  const replacementLease = makeLease({
    events: { push: () => { replacementReleaseCalls += 1; } },
  });
  const fixture = harness({
    acquire(_identity, call) {
      return call === 1 ? firstAcquire.promise : replacementLease;
    },
  });

  const first = fixture.controller.openSession(projectSelector('one'));
  const second = fixture.controller.openSession(projectSelector('two'));
  await turn();
  assert.equal(fixture.calls.acquireShared, 1);
  firstAcquire.reject(acquireError);
  await Promise.all([rejectsSame(first, acquireError), rejectsSame(second, acquireError)]);
  assert.equal(fixture.calls.verify, 0);
  assert.equal(getterCalls, 0);

  const session = await fixture.controller.openSession(projectSelector('retry'));
  assert.equal(fixture.calls.acquireShared, 2);
  await fixture.controller.close(session);
  assert.equal(replacementReleaseCalls, 1);
});

test('an acquire rejection with own unknown-release data fences without deleting its entry', async () => {
  const acquireError = new Error('acquire cleanup disposition unknown', {
    cause: new Error('CloseHandle failed'),
  });
  acquireError.code = 'MANUSCRIPT_LIFECYCLE_UNAVAILABLE';
  Object.defineProperty(acquireError, 'releaseDispositionUnknown', {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
  const fixture = harness({
    acquire() {
      throw acquireError;
    },
  });

  await rejectsSame(fixture.controller.openSession(projectSelector()), acquireError);
  assert.equal(fixture.calls.acquireShared, 1);
  assert.equal(fixture.calls.verify, 0);
  assert.equal(fixture.calls.registry, 1);

  await assert.rejects(
    fixture.controller.openSession(projectSelector('must-not-reacquire')),
    (error) => isCanonicalLifecycleError(error, acquireError),
  );
  assert.equal(fixture.calls.registry, 1);
  assert.equal(fixture.calls.acquireShared, 1);
});

test('one verifier rejection rolls back only its reservation and preserves the other session', async () => {
  const admissionError = new Error('route generation changed', { cause: new Error('route read') });
  admissionError.code = 'PROJECTION_STALE';
  let releaseCalls = 0;
  const lease = makeLease({ events: { push: () => { releaseCalls += 1; } } });
  const fixture = harness({
    acquire: () => lease,
    verify(_identity, call) {
      if (call === 1) throw admissionError;
    },
  });

  const rejected = fixture.controller.openSession(projectSelector('rejected'));
  const accepted = fixture.controller.openSession(projectSelector('accepted'));
  await rejectsSame(rejected, admissionError);
  const session = await accepted;
  assert.equal(releaseCalls, 0);
  assert.equal(await fixture.controller.admit(session, () => 'accepted'), 'accepted');
  await fixture.controller.close(session);
  assert.equal(releaseCalls, 1);
});

test('all verifier rejections release the new handle once and permit a clean later acquisition', async () => {
  const errorA = new Error('route mismatch a', { cause: new Error('a') });
  const errorB = new Error('route mismatch b', { cause: new Error('b') });
  errorA.code = 'PROJECTION_STALE';
  errorB.code = 'PROJECTION_STALE';
  const releases = [];
  const fixture = harness({
    acquire(_identity, call) {
      return makeLease({ events: { push: () => releases.push(call) } });
    },
    verify(_identity, call) {
      if (call === 1) throw errorA;
      if (call === 2) throw errorB;
    },
  });

  const first = fixture.controller.openSession(projectSelector('a'));
  const second = fixture.controller.openSession(projectSelector('b'));
  await Promise.all([rejectsSame(first, errorA), rejectsSame(second, errorB)]);
  assert.deepEqual(releases, [1]);

  const session = await fixture.controller.openSession(projectSelector('later'));
  assert.equal(fixture.calls.acquireShared, 2);
  await fixture.controller.close(session);
  assert.deepEqual(releases, [1, 2]);
});

test('unknown release while rolling back preserves the verifier error and permanently fences reopen', async () => {
  const verifyError = new Error('route rejected', { cause: new Error('journal mismatch') });
  verifyError.code = 'RECOVERY_REQUIRED';
  const releaseError = lifecycleError();
  let releaseCalls = 0;
  const lease = makeLease({
    events: { push: () => { releaseCalls += 1; } },
    releaseError,
  });
  const fixture = harness({
    acquire: () => lease,
    verify() {
      throw verifyError;
    },
  });

  await rejectsSame(fixture.controller.openSession(projectSelector()), verifyError);
  assert.equal(releaseCalls, 1);
  assert.equal(fixture.calls.registry, 1);
  await assert.rejects(
    fixture.controller.openSession(projectSelector('must-not-reopen')),
    (error) => isCanonicalLifecycleError(error, releaseError),
  );
  assert.equal(fixture.calls.registry, 1);
  assert.equal(fixture.calls.acquireShared, 1);
});

test('admit propagates operation errors and always accounts the in-flight operation', async () => {
  const operationError = new Error('operation cancelled', { cause: new Error('abort') });
  operationError.code = 'ABORT_ERR';
  const fixture = harness();
  const session = await fixture.controller.openSession(projectSelector());

  await rejectsSame(fixture.controller.admit(session, () => {
    fixture.calls.operation += 1;
    throw operationError;
  }), operationError);
  await fixture.controller.close(session);
  assert.equal(fixture.calls.operation, 1);
  assert.equal(fixture.calls.release, 1);
});

test('non-last close is immediate while the freshness owner gate protects work until last close', async () => {
  const fixture = harness();
  const [sessionA, sessionB] = await Promise.all([
    fixture.controller.openSession(projectSelector('a')),
    fixture.controller.openSession(projectSelector('b')),
  ]);
  const operationGate = deferred();
  const admitted = fixture.controller.admit(sessionA, async () => {
    fixture.calls.operation += 1;
    return operationGate.promise;
  });
  await turn();

  let closeSettled = false;
  const closing = fixture.controller.close(sessionA).then(() => { closeSettled = true; });
  await turn();
  assert.equal(closeSettled, true);
  await closing;
  await assert.rejects(
    fixture.controller.admit(sessionA, () => { fixture.calls.operation += 1; }),
    TypeError,
  );
  assert.equal(await fixture.controller.admit(sessionB, () => 'other-session'), 'other-session');

  let lastCloseSettled = false;
  const lastClosing = fixture.controller.close(sessionB).then(() => { lastCloseSettled = true; });
  await turn();
  assert.equal(lastCloseSettled, false);
  assert.equal(fixture.calls.release, 0);
  operationGate.resolve('finished');
  assert.equal(await admitted, 'finished');
  await lastClosing;
  assert.equal(fixture.calls.release, 1);
});

test('a verified open reservation prevents the last existing session from releasing the handle', async () => {
  const verifierGate = deferred();
  let releases = 0;
  const lease = makeLease({ events: { push: () => { releases += 1; } } });
  const fixture = harness({
    acquire: () => lease,
    verify(_identity, call) {
      if (call === 2) return verifierGate.promise;
    },
  });
  const existing = await fixture.controller.openSession(projectSelector('existing'));
  const opening = fixture.controller.openSession(projectSelector('opening'));
  await turn();
  assert.equal(fixture.calls.verify, 2);

  await fixture.controller.close(existing);
  assert.equal(releases, 0);
  assert.equal(fixture.calls.freshnessClose, 0);
  verifierGate.resolve();
  const replacement = await opening;
  assert.equal(fixture.calls.acquireShared, 1);
  await fixture.controller.close(replacement);
  assert.equal(fixture.calls.freshnessClose, 1);
  assert.equal(releases, 1);
});

test('an open arriving during final release waits for known closure before acquiring again', async () => {
  const releaseGate = deferred();
  let firstState = 'HELD';
  let firstReleaseCalls = 0;
  let secondReleaseCalls = 0;
  const firstLease = Object.freeze({
    get state() {
      return firstState;
    },
    async release() {
      firstReleaseCalls += 1;
      await releaseGate.promise;
      firstState = 'RELEASED';
      return Object.freeze({ disposition: 'UNLOCKED_AND_CLOSED' });
    },
  });
  const secondLease = makeLease({ events: { push: () => { secondReleaseCalls += 1; } } });
  const fixture = harness({
    acquire(_identity, call) {
      return call === 1 ? firstLease : secondLease;
    },
  });
  const existing = await fixture.controller.openSession(projectSelector('existing'));
  const closing = fixture.controller.close(existing);
  await turn();
  assert.equal(firstReleaseCalls, 1);

  const opening = fixture.controller.openSession(projectSelector('opening'));
  await turn();
  assert.equal(fixture.calls.acquireShared, 1);
  assert.equal(fixture.calls.verify, 1);

  releaseGate.resolve();
  await closing;
  const replacement = await opening;
  assert.equal(fixture.calls.acquireShared, 2);
  assert.equal(fixture.calls.verify, 2);
  await fixture.controller.close(replacement);
  assert.equal(secondReleaseCalls, 1);
});

test('plain, cloned, foreign, closing, and closed sessions never invoke the operation', async () => {
  const first = harness();
  const second = harness({ identity: projectIdentity({ ino: '202' }) });
  const session = await first.controller.openSession(projectSelector());
  const foreign = await second.controller.openSession(projectSelector('foreign', INSTANCE_B));
  let operations = 0;

  for (const invalid of [{}, Object.freeze({}), { ...session }, foreign]) {
    await assert.rejects(first.controller.admit(invalid, () => { operations += 1; }), TypeError);
  }

  const gate = deferred();
  const admitted = first.controller.admit(session, () => gate.promise);
  const closing = first.controller.close(session);
  await assert.rejects(first.controller.admit(session, () => { operations += 1; }), TypeError);
  gate.resolve();
  await admitted;
  await closing;
  await assert.rejects(first.controller.admit(session, () => { operations += 1; }), TypeError);
  await assert.rejects(first.controller.close(session), TypeError);
  assert.equal(operations, 0);

  await second.controller.close(foreign);
});

test('unknown release on final close rejects by identity and fences every future entry point', async () => {
  const releaseError = lifecycleError('close disposition unknown');
  const lease = makeLease({ releaseError });
  const fixture = harness({ acquire: () => lease });
  const session = await fixture.controller.openSession(projectSelector());

  await rejectsSame(fixture.controller.close(session), releaseError);
  assert.equal(fixture.calls.freshnessClose, 1);
  const beforeRegistry = fixture.calls.registry;
  let operations = 0;
  await assert.rejects(
    fixture.controller.admit(session, () => { operations += 1; }),
    (error) => isCanonicalLifecycleError(error, releaseError),
  );
  await assert.rejects(
    fixture.controller.openSession(projectSelector('blocked')),
    (error) => isCanonicalLifecycleError(error, releaseError),
  );
  assert.equal(operations, 0);
  assert.equal(fixture.calls.registry, beforeRegistry);
  assert.equal(fixture.calls.acquireShared, 1);
});

test('an invalid release result is called once, retains the entry, and fences the controller', async () => {
  const invalidResults = [
    { disposition: 'UNLOCKED_AND_CLOSED' },
    Object.freeze({ disposition: 'UNKNOWN' }),
    Object.freeze({ disposition: 'UNLOCKED_AND_CLOSED', extra: true }),
  ];
  for (const [index, invalidResult] of invalidResults.entries()) {
    let state = 'HELD';
    let releaseCalls = 0;
    const lease = Object.freeze({
      get state() {
        return state;
      },
      release() {
        releaseCalls += 1;
        state = 'RELEASED';
        return invalidResult;
      },
    });
    const fixture = harness({ acquire: () => lease });
    const session = await fixture.controller.openSession(projectSelector(`invalid-${index}`));

    await assert.rejects(
      fixture.controller.close(session),
      (error) => isCanonicalLifecycleError(error),
    );
    assert.equal(fixture.calls.freshnessClose, 1);
    await assert.rejects(
      fixture.controller.openSession(projectSelector(`blocked-${index}`)),
      (error) => isCanonicalLifecycleError(error),
    );
    await assert.rejects(
      fixture.controller.close(session),
      (error) => isCanonicalLifecycleError(error),
    );
    assert.equal(releaseCalls, 1);
    assert.equal(fixture.calls.acquireShared, 1);
  }
});

test('a registry/config exit failure rolls back the minted session and preserves the original error', async () => {
  const exitError = new Error('config lease close failed', { cause: new Error('config lease') });
  exitError.code = 'CONFIG_LEASE_UNKNOWN';
  let releaseCalls = 0;
  const lease = makeLease({ events: { push: () => { releaseCalls += 1; } } });
  const identity = projectIdentity();
  const registry = {
    async withProjectIdentity(_selector, callback) {
      try {
        return await callback(identity);
      } finally {
        throw exitError;
      }
    },
  };
  const fixture = harness({ acquire: () => lease, identity, registry });

  await rejectsSame(fixture.controller.openSession(projectSelector()), exitError);
  assert.equal(fixture.calls.acquireShared, 1);
  assert.equal(fixture.calls.verify, 1);
  assert.equal(fixture.calls.createOwner, 1);
  assert.equal(fixture.calls.freshnessStart, 0);
  assert.equal(fixture.calls.freshnessClose, 1);
  assert.equal(releaseCalls, 1);
});

test('both known release dispositions allow a later open to acquire a new handle', async () => {
  const releases = [];
  const fixture = harness({
    acquire(_identity, call) {
      return makeLease({
        events: { push: () => releases.push(call) },
        releaseDisposition: call === 1
          ? 'CLOSED_AFTER_UNLOCK_FAILURE'
          : 'UNLOCKED_AND_CLOSED',
      });
    },
  });

  const first = await fixture.controller.openSession(projectSelector('first'));
  await fixture.controller.close(first);
  const second = await fixture.controller.openSession(projectSelector('second'));
  await fixture.controller.close(second);
  assert.equal(fixture.calls.acquireShared, 2);
  assert.deepEqual(releases, [1, 2]);
});
