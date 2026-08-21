'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { RetirementService } = require('../manuscript/retirement-service');

const INSTANCE = '00000000-0000-4000-8000-abcdefabcdef';
const PROJECT_UID = '00000000-0000-4000-8000-000000000010';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function selector() {
  return { name: 'novel', expectedInstanceId: INSTANCE };
}

function identity() {
  return deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId: INSTANCE,
    lifecyclePlatformIdentity: {
      canonicalRealControlDirectory: 'C:\\Mythpen\\control\\project-a',
      controlDirectoryIdentity: { dev: '7', ino: '101' },
      controlParentDirectoryIdentity: { dev: '7', ino: '100' },
      lifecycleLockIdentity: { dev: '7', ino: '1010' },
    },
  });
}

function makeExclusive(events, { releaseError } = {}) {
  let state = 'HELD';
  return Object.freeze({
    get state() { return state; },
    release() {
      events.push('exclusive release');
      if (releaseError) {
        state = 'RELEASE_DISPOSITION_UNKNOWN';
        throw releaseError;
      }
      state = 'RELEASED';
      return Object.freeze({ disposition: 'UNLOCKED_AND_CLOSED' });
    },
  });
}

function harness({
  acquireError = null,
  busy = false,
  drainError = null,
  exclusiveLeaseFactory = null,
  generationAfterDrain = null,
  initialRoute = 'files',
  registryIdentityFactory = null,
  releaseError = null,
} = {}) {
  const exactIdentity = registryIdentityFactory?.() ?? identity();
  const epoch = Object.freeze({});
  const events = [];
  const observedIdentities = [];
  const state = {
    assets: ['database', 'control', 'article-root', 'cover', 'backup'],
    cacheRoute: initialRoute,
    projectionGeneration: 7,
    route: initialRoute,
  };
  let registryDepth = 0;
  let writerDepth = 0;
  const calls = { complete: 0, resume: 0 };
  const controller = {
    async beginRetiring(projectSelector) {
      assert.deepEqual(projectSelector, selector());
      events.push('begin');
      return epoch;
    },
    async drain(received) {
      assert.equal(received, epoch);
      assert.equal(registryDepth, 0);
      assert.equal(writerDepth, 0);
      events.push('drain');
      if (drainError) throw drainError;
      if (generationAfterDrain !== null) state.projectionGeneration = generationAfterDrain;
    },
    async closeForRetirement(received, currentIdentity) {
      assert.equal(received, epoch);
      assert.deepEqual(currentIdentity, exactIdentity);
      observedIdentities.push(currentIdentity);
      assert.equal(registryDepth, 1);
      assert.equal(writerDepth, 1);
      events.push('session close');
    },
    completeRetirement(received) {
      assert.equal(received, epoch);
      calls.complete += 1;
      events.push('complete');
    },
    async resumeAfterRetirementFailure(received, currentIdentity) {
      assert.equal(received, epoch);
      assert.deepEqual(currentIdentity, exactIdentity);
      observedIdentities.push(currentIdentity);
      assert.equal(registryDepth, 0);
      assert.equal(writerDepth, 0);
      calls.resume += 1;
      events.push('resume');
    },
  };
  const registryAdmission = {
    async withProjectIdentity(projectSelector, callback) {
      assert.deepEqual(projectSelector, selector());
      registryDepth += 1;
      events.push('config enter');
      try {
        return await callback(exactIdentity);
      } finally {
        events.push('config exit');
        registryDepth -= 1;
      }
    },
  };
  const writerTurns = {
    async withWriterTurn(currentIdentity, callback) {
      assert.deepEqual(currentIdentity, exactIdentity);
      observedIdentities.push(currentIdentity);
      writerDepth += 1;
      events.push('writer enter');
      try {
        return await callback(Object.freeze({}));
      } finally {
        events.push('writer exit');
        writerDepth -= 1;
      }
    },
  };
  const lifecycleLeaseAdapter = {
    acquireExclusive(lifecycleIdentity) {
      assert.deepEqual(lifecycleIdentity, exactIdentity.lifecyclePlatformIdentity);
      events.push('exclusive');
      if (acquireError) throw acquireError;
      if (busy) {
        const error = new Error('busy');
        error.code = 'PROJECT_WRITE_BUSY';
        throw error;
      }
      if (exclusiveLeaseFactory) return exclusiveLeaseFactory(events);
      return makeExclusive(events, { releaseError });
    },
  };
  const routes = {
    readCurrent(currentIdentity) {
      assert.deepEqual(currentIdentity, exactIdentity);
      observedIdentities.push(currentIdentity);
      events.push('route read');
      return Object.freeze({
        projectUid: PROJECT_UID,
        projectInstanceId: INSTANCE,
        projectionGeneration: state.projectionGeneration,
        route: state.route,
      });
    },
    compareAndSwap(input) {
      events.push(`cas ${input.expectedRoute}->${input.nextRoute}`);
      assert.deepEqual(input.exactIdentity, exactIdentity);
      observedIdentities.push(input.exactIdentity);
      assert.equal(input.projectionGeneration, state.projectionGeneration);
      assert.equal(input.writerTurn !== null, true);
      assert.equal(input.exclusiveLease.state, 'HELD');
      assert.equal(state.route, input.expectedRoute);
      assert.equal(state.cacheRoute, input.expectedRoute);
      state.route = input.nextRoute;
      state.cacheRoute = input.nextRoute;
      return Object.freeze({
        cacheRoute: state.cacheRoute,
        projectionGeneration: state.projectionGeneration,
        route: state.route,
      });
    },
  };
  return {
    calls,
    controller,
    events,
    exactIdentity,
    observedIdentities,
    service: new RetirementService({
      controller,
      lifecycleLeaseAdapter,
      registryAdmission,
      routes,
      writerTurns,
    }),
    state,
  };
}

test('retire drains unlocked then closes sessions before exclusive route/cache CAS without deleting assets', async () => {
  const fixture = harness();
  const beforeAssets = [...fixture.state.assets];
  const result = await fixture.service.retire({
    projectSelector: selector(),
  });
  assert.deepEqual(result, Object.freeze({
    cacheRoute: 'retired',
    projectionGeneration: 7,
    route: 'retired',
  }));
  assert.deepEqual(fixture.events, [
    'begin',
    'drain',
    'config enter',
    'route read',
    'writer enter',
    'session close',
    'exclusive',
    'cas files->retired',
    'exclusive release',
    'writer exit',
    'config exit',
    'complete',
  ]);
  assert.deepEqual(fixture.state.assets, beforeAssets);
  assert.equal(fixture.calls.complete, 1);
  assert.equal(fixture.calls.resume, 0);
});

test('retire rebuilds its files baseline after admitted work advances generation during drain', async () => {
  const fixture = harness({ generationAfterDrain: 8 });
  const result = await fixture.service.retire({ projectSelector: selector() });
  assert.deepEqual(result, Object.freeze({
    cacheRoute: 'retired',
    projectionGeneration: 8,
    route: 'retired',
  }));
  assert.equal(fixture.events.includes('cas files->retired'), true);
  assert.equal(fixture.calls.complete, 1);
  assert.equal(fixture.calls.resume, 0);
});

test('retire rechecks and resumes its epoch when initial registry exit makes drain fail', async () => {
  const drainError = new Error('initial retirement registry exit failed');
  drainError.code = 'CONFIG_LEASE_UNKNOWN';
  const fixture = harness({ drainError });
  await assert.rejects(
    fixture.service.retire({ projectSelector: selector() }),
    (error) => error === drainError,
  );
  assert.equal(fixture.calls.resume, 1);
  assert.equal(fixture.calls.complete, 0);
  assert.deepEqual(fixture.events, [
    'begin',
    'drain',
    'config enter',
    'route read',
    'config exit',
    'resume',
  ]);
});

test('cross-process shared busy preserves files route/cache and resumes only after all leases exit', async () => {
  const fixture = harness({ busy: true });
  const before = { ...fixture.state };
  await assert.rejects(
    fixture.service.retire({ projectSelector: selector() }),
    (error) => error?.code === 'PROJECT_WRITE_BUSY',
  );
  assert.equal(fixture.state.route, before.route);
  assert.equal(fixture.state.cacheRoute, before.cacheRoute);
  assert.deepEqual(fixture.state.assets, before.assets);
  assert.equal(fixture.events.includes('cas files->retired'), false);
  assert.equal(fixture.events.filter((event) => event === 'route read').length, 2);
  assert.deepEqual(fixture.events.slice(-4), [
    'config enter',
    'route read',
    'config exit',
    'resume',
  ]);
  assert.equal(fixture.calls.complete, 0);
  assert.equal(fixture.calls.resume, 1);
});

test('unknown exclusive acquire or release disposition never resumes or completes the controller', async () => {
  const unknown = new Error('native exclusive cleanup is unknown');
  Object.defineProperty(unknown, 'releaseDispositionUnknown', {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
  const wrapped = new Error('exclusive acquire wrapper', { cause: unknown });
  const acquireFixture = harness({ acquireError: wrapped });
  await assert.rejects(
    acquireFixture.service.retire({ projectSelector: selector() }),
    (error) => error === wrapped,
  );
  assert.equal(acquireFixture.calls.resume, 0);
  assert.equal(acquireFixture.calls.complete, 0);
  assert.equal(acquireFixture.state.route, 'files');
  assert.equal(acquireFixture.state.cacheRoute, 'files');

  const releaseFixture = harness({ releaseError: unknown });
  await assert.rejects(
    releaseFixture.service.retire({ projectSelector: selector() }),
    (error) => error === unknown,
  );
  assert.equal(releaseFixture.calls.resume, 0);
  assert.equal(releaseFixture.calls.complete, 0);
  assert.equal(releaseFixture.state.route, 'retired');
  assert.equal(releaseFixture.state.cacheRoute, 'retired');
});

test('exclusive validation faults release the raw acquired lease before deciding whether to resume', async () => {
  const getterError = new Error('lease state getter failed');
  let getterReleaseCalls = 0;
  let getterLeaseState = 'HELD';
  const getterFixture = harness({
    exclusiveLeaseFactory() {
      return Object.freeze({
        get state() {
          if (getterLeaseState === 'HELD') throw getterError;
          return getterLeaseState;
        },
        release() {
          getterReleaseCalls += 1;
          getterLeaseState = 'RELEASED';
          return Object.freeze({ disposition: 'UNLOCKED_AND_CLOSED' });
        },
      });
    },
  });
  await assert.rejects(
    getterFixture.service.retire({ projectSelector: selector() }),
    (error) => error === getterError,
  );
  assert.equal(getterReleaseCalls, 1);
  assert.equal(getterFixture.calls.resume, 1);
  assert.equal(getterFixture.state.route, 'files');

  const unknownRelease = new Error('invalid lease cleanup unknown');
  Object.defineProperty(unknownRelease, 'releaseDispositionUnknown', {
    configurable: false,
    enumerable: true,
    value: true,
    writable: false,
  });
  let invalidReleaseCalls = 0;
  const invalidFixture = harness({
    exclusiveLeaseFactory() {
      return Object.freeze({
        state: 'INVALID',
        release() {
          invalidReleaseCalls += 1;
          throw unknownRelease;
        },
      });
    },
  });
  await assert.rejects(
    invalidFixture.service.retire({ projectSelector: selector() }),
    (error) => error === unknownRelease,
  );
  assert.equal(invalidReleaseCalls, 1);
  assert.equal(invalidFixture.calls.resume, 0);
  assert.equal(invalidFixture.state.route, 'files');
});

test('registry identity is snapshotted from exact data descriptors without invoking accessors', async () => {
  const getterError = new Error('registry projectUid getter must not run');
  let getterCalls = 0;
  const maliciousFixture = harness({
    registryIdentityFactory() {
      const valid = identity();
      const result = {};
      Object.defineProperties(result, {
        lifecyclePlatformIdentity: {
          enumerable: true,
          value: valid.lifecyclePlatformIdentity,
        },
        projectInstanceId: {
          enumerable: true,
          value: valid.projectInstanceId,
        },
        projectUid: {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw getterError;
          },
        },
      });
      return Object.freeze(result);
    },
  });
  await assert.rejects(
    maliciousFixture.service.reactivate({ projectSelector: selector() }),
    (error) => error instanceof TypeError && error !== getterError,
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(maliciousFixture.events, ['config enter', 'config exit']);

  const fixture = harness({ initialRoute: 'retired' });
  await fixture.service.reactivate({ projectSelector: selector() });
  assert.equal(fixture.observedIdentities.length > 0, true);
  for (const observed of fixture.observedIdentities) {
    assert.notEqual(observed, fixture.exactIdentity);
    assert.notEqual(
      observed.lifecyclePlatformIdentity,
      fixture.exactIdentity.lifecyclePlatformIdentity,
    );
    assert.equal(Object.isFrozen(observed), true);
    assert.equal(Object.isFrozen(observed.lifecyclePlatformIdentity), true);
  }
});

test('reactivation performs retired-to-files CAS under writer and exclusive without reusing controller state', async () => {
  const fixture = harness({ initialRoute: 'retired' });
  const result = await fixture.service.reactivate({
    projectSelector: selector(),
  });
  assert.equal(result.route, 'files');
  assert.equal(result.cacheRoute, 'files');
  assert.equal(fixture.events.includes('begin'), false);
  assert.equal(fixture.events.includes('session close'), false);
  assert.deepEqual(fixture.events, [
    'config enter',
    'route read',
    'writer enter',
    'exclusive',
    'cas retired->files',
    'exclusive release',
    'writer exit',
    'config exit',
  ]);
});
