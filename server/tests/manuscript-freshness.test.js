'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createManuscriptFreshnessLifecycle,
  ensureProjectionCurrent,
  ensureReadableProjection,
} = require('../manuscript/freshness');
const { ManuscriptFeedState } = require('../manuscript/feed-state');

const FEED_IDS = Object.freeze(['mythpen', 'volumes', 'chapters']);
const PROJECT_UID = '00000000-0000-4000-8000-000000000010';
const PROJECT_INSTANCE_ID = '00000000-0000-4000-8000-abcdefabcdef';
const BASIS_A = 'a'.repeat(64);
const BASIS_B = 'b'.repeat(64);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function registryIdentity(overrides = {}) {
  return deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    lifecyclePlatformIdentity: {
      canonicalRealControlDirectory: 'C:\\Mythpen\\control\\project-a',
      controlDirectoryIdentity: { dev: '7', ino: '101' },
      controlParentDirectoryIdentity: { dev: '7', ino: '100' },
      lifecycleLockIdentity: { dev: '7', ino: '1010' },
    },
    ...overrides,
  });
}

function changeFeedIdentity(ino = '201') {
  return deepFreeze({
    canonicalRealMythpenDirectory: 'C:\\Mythpen\\articles\\project-a\\mythpen',
    articleRootDirectoryIdentity: { dev: '7', ino: '200' },
    mythpenDirectoryIdentity: { dev: '7', ino },
    volumesDirectoryIdentity: { dev: '7', ino: '202' },
    chaptersDirectoryIdentity: { dev: '7', ino: '203' },
  });
}

function token(generation, connectionEpoch = 1, basisDigest = BASIS_A) {
  return Object.freeze({ generation, connectionEpoch, basisDigest });
}

function alreadyCurrent(generation) {
  return Object.freeze({
    disposition: 'ALREADY_CURRENT',
    generation,
    refreshKind: 'FULL',
  });
}

function committed(baseGeneration, targetGeneration) {
  return Object.freeze({
    disposition: 'COMMITTED',
    baseGeneration,
    targetGeneration,
    refreshKind: 'FULL',
  });
}

function knownNotCommitted(generation, error) {
  return Object.freeze({
    disposition: 'KNOWN_NOT_COMMITTED',
    generation,
    refreshKind: 'FULL',
    error,
  });
}

function makeDirectOwner(events) {
  const handles = Object.freeze(Object.fromEntries(
    FEED_IDS.map((feedId) => [feedId, Object.freeze({ feedId })]),
  ));
  const queued = Object.fromEntries(FEED_IDS.map((feedId) => [feedId, []]));
  const pending = Object.fromEntries(FEED_IDS.map((feedId) => [feedId, true]));
  const completions = new WeakMap();
  const cancelled = new Set();
  let state = 'ARMED';
  let decodeError = null;
  let probeError = null;
  let rearmError = null;
  let takeNull = false;

  function mintCompletion(feedId, result) {
    const completion = Object.freeze({ feedId, handleInstance: handles[feedId] });
    completions.set(completion, { feedId, result, decoded: false });
    return completion;
  }

  const owner = {
    get state() { return state; },
    feedInstance(feedId) { return handles[feedId]; },
    probeEvents() {
      events.push('probe');
      if (probeError) throw probeError;
      return Object.freeze(Object.fromEntries(
        FEED_IDS.map((feedId) => [feedId, queued[feedId].length > 0]),
      ));
    },
    takeCompletion(feedId) {
      events.push(`take:${feedId}`);
      if (takeNull && queued[feedId].length > 0) return null;
      const result = queued[feedId].shift();
      if (result === undefined) return null;
      pending[feedId] = false;
      return mintCompletion(feedId, result);
    },
    rearm(completion) {
      const record = completions.get(completion);
      events.push(`rearm:${record.feedId}`);
      if (rearmError) throw rearmError;
      pending[record.feedId] = true;
      return handles[record.feedId];
    },
    decode(completion) {
      const record = completions.get(completion);
      events.push(`decode:${record.feedId}`);
      if (decodeError) throw decodeError;
      record.decoded = true;
      return record.result;
    },
    retireCompletion(completion) {
      const record = completions.get(completion);
      events.push(`retire:${record.feedId}`);
      assert.equal(record.decoded, true);
      completions.delete(completion);
    },
    beginStopping() {
      events.push('platform:begin-stopping');
      assert.equal(state, 'ARMED');
      state = 'STOPPING';
    },
    cancelPending(feedId) {
      events.push(`cancel:${feedId}`);
      if (cancelled.has(feedId) || !pending[feedId]) return null;
      cancelled.add(feedId);
      pending[feedId] = false;
      return mintCompletion(feedId, Object.freeze({
        outcome: 'COVERAGE_LOST',
        reason: 'OPERATION_ABORTED',
      }));
    },
    close() {
      events.push('platform:close');
      state = 'CLOSED';
      return Object.freeze({ disposition: 'CLOSED' });
    },
    enqueue(feedId, result) { queued[feedId].push(result); },
    setDecodeError(error) { decodeError = error; },
    setProbeError(error) { probeError = error; },
    setRearmError(error) { rearmError = error; },
    setTakeNull(value) { takeNull = value; },
  };
  return Object.freeze(owner);
}

function harness({
  capability = true,
  fullRefresh,
  openOutcome,
  projectionRead,
  projectionToken,
  recover,
} = {}) {
  const calls = {
    assertIdentity: 0,
    fullInputs: [],
    open: 0,
    preStart: 0,
    read: 0,
    recover: 0,
    token: 0,
    writer: 0,
  };
  const events = [];
  const platformIdentity = changeFeedIdentity();
  const directOwner = makeDirectOwner(events);
  let current = token(0);
  const turnRecords = new WeakMap();

  const ports = {
    preStartVerifier: Object.freeze({
      async verifyBeforeFeedStart(identity) {
        calls.preStart += 1;
        events.push('pre-start');
        assert.equal(identity.projectUid, PROJECT_UID);
        return Object.freeze({ changeFeedPlatformIdentity: platformIdentity });
      },
    }),
    feedAdapter: Object.freeze({
      assertIdentity(identity) {
        calls.assertIdentity += 1;
        events.push('identity-assert');
        assert.equal(identity, platformIdentity);
        return identity;
      },
      tryOpen(identity) {
        calls.open += 1;
        events.push('open');
        assert.equal(identity, platformIdentity);
        return openOutcome || Object.freeze({ outcome: 'OPENED', owner: directOwner });
      },
    }),
    notificationCapability: Object.freeze({
      read() {
        events.push('capability');
        return capability;
      },
    }),
    writerTurns: Object.freeze({
      async withWriterTurn(admission, callback) {
        calls.writer += 1;
        events.push('writer:enter');
        const turn = Object.freeze({});
        turnRecords.set(turn, admission);
        try {
          return await callback(turn);
        } finally {
          events.push('writer:exit');
        }
      },
      assertTurn(admission, writerTurn) {
        if (turnRecords.get(writerTurn) !== admission) {
          throw new TypeError('writer turn does not match admission');
        }
        return writerTurn;
      },
    }),
    recovery: Object.freeze({
      async recoverBeforeRefresh(admission, writerTurn) {
        calls.recover += 1;
        events.push('recover');
        if (recover) return recover(admission, writerTurn, calls.recover);
        return undefined;
      },
    }),
    fullRefresh: Object.freeze({
      async validateAndPublish(input) {
        calls.fullInputs.push(input);
        events.push('full');
        if (fullRefresh) {
          return fullRefresh(input, calls.fullInputs.length, {
            get current() { return current; },
            set current(value) { current = value; },
          });
        }
        return alreadyCurrent(input.baseToken.generation);
      },
    }),
    projectionAccess: Object.freeze({
      async readCurrent(admission, query) {
        calls.read += 1;
        events.push('read');
        if (projectionRead) {
          return projectionRead(admission, query, calls.read, {
            get current() { return current; },
            set current(value) { current = value; },
          });
        }
        return Object.freeze({ token: current, value: Object.freeze({ query }) });
      },
      currentToken(admission) {
        calls.token += 1;
        events.push('current-token');
        if (projectionToken) return projectionToken(admission, calls.token, current);
        return current;
      },
    }),
  };
  const lifecycle = createManuscriptFreshnessLifecycle(ports);
  return {
    calls,
    directOwner,
    events,
    identity: registryIdentity(),
    lifecycle,
    platformIdentity,
    ports,
    setCurrent(value) { current = value; },
  };
}

async function started(fixture) {
  const owner = fixture.lifecycle.createOwner(fixture.identity);
  await fixture.lifecycle.start(owner, fixture.identity);
  return owner;
}

async function admitted(fixture, owner, operation) {
  return fixture.lifecycle.admit(owner, operation);
}

test('constructor, owner, and admission brands reject inexact ports and plain authorities before side effects', async () => {
  const fixture = harness({ capability: false });
  for (const invalidOptions of [
    undefined,
    {},
    { ...fixture.ports, preStartVerifier: {} },
    { ...fixture.ports, feedAdapter: { assertIdentity() {} } },
    { ...fixture.ports, notificationCapability: {} },
    { ...fixture.ports, writerTurns: { withWriterTurn() {} } },
    { ...fixture.ports, recovery: {} },
    { ...fixture.ports, fullRefresh: {} },
    { ...fixture.ports, projectionAccess: { readCurrent() {} } },
  ]) {
    assert.throws(() => createManuscriptFreshnessLifecycle(invalidOptions), TypeError);
  }

  let getterCalls = 0;
  const getterPort = {};
  Object.defineProperty(getterPort, 'verifyBeforeFeedStart', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return () => undefined;
    },
  });
  assert.throws(
    () => createManuscriptFreshnessLifecycle({
      ...fixture.ports,
      preStartVerifier: getterPort,
    }),
    TypeError,
  );
  assert.equal(getterCalls, 0);

  const inheritedRecovery = Object.create({ recoverBeforeRefresh() {} });
  assert.throws(
    () => createManuscriptFreshnessLifecycle({
      ...fixture.ports,
      recovery: inheritedRecovery,
    }),
    TypeError,
  );
  assert.throws(
    () => createManuscriptFreshnessLifecycle({
      ...fixture.ports,
      notificationCapability: {
        read() { return false; },
        callerOverride: false,
      },
    }),
    TypeError,
  );

  assert.throws(() => fixture.lifecycle.createOwner(registryIdentity({ projectUid: 'bad' })), TypeError);
  const owner = fixture.lifecycle.createOwner(fixture.identity);
  assert.equal(Object.isFrozen(owner), true);
  assert.deepEqual(Reflect.ownKeys(owner), []);
  await assert.rejects(fixture.lifecycle.admit({}, () => undefined), TypeError);
  await assert.rejects(ensureProjectionCurrent({}, Object.freeze({})), TypeError);
  await fixture.lifecycle.start(owner, fixture.identity);
  await assert.rejects(fixture.lifecycle.start(owner, fixture.identity), TypeError);
  await admitted(fixture, owner, async (admission) => {
    assert.equal(Object.isFrozen(admission), true);
    assert.deepEqual(Reflect.ownKeys(admission), []);
  });
  await fixture.lifecycle.close(owner);
  await assert.rejects(fixture.lifecycle.close(owner), TypeError);
});

test('capability disabled, no slot, and known unavailable enter startup-full degraded mode without event-clean claims', async () => {
  const knownError = new Error('known unavailable');
  const cases = [
    { capability: false, reason: 'CAPABILITY_DISABLED' },
    { openOutcome: Object.freeze({ outcome: 'NO_SLOT' }), reason: 'NO_SLOT' },
    {
      openOutcome: Object.freeze({
        outcome: 'UNAVAILABLE',
        error: knownError,
        closeDisposition: 'KNOWN_CLOSED',
      }),
      reason: 'KNOWN_UNAVAILABLE',
    },
  ];
  for (const current of cases) {
    const fixture = harness(current);
    const owner = await started(fixture);
    assert.equal(fixture.calls.fullInputs.length, 1, current.reason);
    assert.equal(fixture.calls.open, current.capability === false ? 0 : 1, current.reason);
    const input = fixture.calls.fullInputs[0];
    assert.deepEqual(Reflect.ownKeys(input).sort(), [
      'admission', 'baseToken', 'claimSnapshot', 'writerTurn',
    ]);
    assert.equal(Object.isFrozen(input), true);
    assert.deepEqual(input.claimSnapshot, { baseGeneration: 0, dirtyPaths: [] });

    const readResult = await admitted(
      fixture,
      owner,
      (admission) => ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
    );
    assert.equal(readResult.value.query.kind, 'tree');
    assert.equal(fixture.calls.fullInputs.length, 3, current.reason);
    await fixture.lifecycle.close(owner);
    assert.equal(fixture.events.includes('platform:begin-stopping'), false, current.reason);
  }
});

test('unknown startup feed disposition is sticky and never returns an owner-backed session or known close', async () => {
  const unknown = new Error('close unknown');
  Object.defineProperty(unknown, 'releaseDispositionUnknown', {
    enumerable: true,
    value: true,
  });
  const fixture = harness({
    openOutcome: Object.freeze({
      outcome: 'UNAVAILABLE',
      error: unknown,
      closeDisposition: 'UNKNOWN',
    }),
  });
  const owner = fixture.lifecycle.createOwner(fixture.identity);
  await assert.rejects(fixture.lifecycle.start(owner, fixture.identity), (error) => error === unknown);
  await assert.rejects(fixture.lifecycle.admit(owner, () => undefined), (error) => error === unknown);
  await assert.rejects(fixture.lifecycle.close(owner), (error) => error === unknown);
});

test('joiners reverify an equal original binding and reject a different project binding before another feed start', async () => {
  const fixture = harness({ capability: false });
  const owner = await started(fixture);
  const equalButDistinct = registryIdentity();
  await fixture.lifecycle.assertSameBinding(owner, equalButDistinct);
  assert.equal(fixture.calls.preStart, 2);
  assert.equal(fixture.calls.open, 0);

  const otherProject = registryIdentity({
    projectUid: '00000000-0000-4000-8000-000000000011',
  });
  await assert.rejects(fixture.lifecycle.assertSameBinding(owner, otherProject), TypeError);
  assert.equal(fixture.calls.preStart, 2);
  await fixture.lifecycle.close(owner);
});

test('opened startup drains take-observe-rearm-decode-account-retire before a stable full baseline', async () => {
  const fixture = harness();
  fixture.directOwner.enqueue('chapters', Object.freeze({
    outcome: 'RECORDS',
    records: Object.freeze([
      Object.freeze({ action: 'MODIFIED', component: 'chapter-a.md' }),
    ]),
  }));

  const owner = await started(fixture);
  assert.deepEqual(fixture.calls.fullInputs[0].claimSnapshot, {
    baseGeneration: 0,
    dirtyPaths: ['mythpen/chapters/chapter-a.md'],
  });
  const ordered = fixture.events.filter((event) => (
    event.startsWith('take:chapters')
    || event.startsWith('rearm:chapters')
    || event.startsWith('decode:chapters')
    || event.startsWith('retire:chapters')
    || event === 'full'
  ));
  assert.deepEqual(ordered.slice(0, 5), [
    'take:chapters',
    'rearm:chapters',
    'decode:chapters',
    'retire:chapters',
    'full',
  ]);
  await fixture.lifecycle.close(owner);
  assert.ok(fixture.events.indexOf('platform:begin-stopping') < fixture.events.indexOf('cancel:mythpen'));
  assert.ok(fixture.events.indexOf('retire:chapters') < fixture.events.lastIndexOf('platform:close'));
});

test('duplicate native notification records collapse to one canonical dirty key before 9B accounting', async () => {
  const fixture = harness();
  fixture.directOwner.enqueue('chapters', Object.freeze({
    outcome: 'RECORDS',
    records: Object.freeze([
      Object.freeze({ action: 'MODIFIED', component: 'same.md' }),
      Object.freeze({ action: 'MODIFIED', component: 'same.md' }),
    ]),
  }));
  const owner = await started(fixture);
  assert.deepEqual(fixture.calls.fullInputs[0].claimSnapshot.dirtyPaths, [
    'mythpen/chapters/same.md',
  ]);
  await fixture.lifecycle.close(owner);
});

test('ensureProjectionCurrent uses the caller writer turn, gives ports only claimSnapshot, and settles the original claim', async () => {
  const expected = new Error('not committed');
  const fixture = harness({
    fullRefresh(input, call) {
      if (call === 1) return alreadyCurrent(input.baseToken.generation);
      if (call === 2) return knownNotCommitted(input.baseToken.generation, expected);
      return alreadyCurrent(input.baseToken.generation);
    },
  });
  const owner = await started(fixture);
  fixture.directOwner.enqueue('volumes', Object.freeze({
    outcome: 'RECORDS',
    records: Object.freeze([
      Object.freeze({ action: 'ADDED', component: 'volume-a.json' }),
    ]),
  }));

  await admitted(fixture, owner, async (admission) => {
    const beforeWriterCalls = fixture.calls.writer;
    await assert.rejects(
      fixture.ports.writerTurns.withWriterTurn(
        admission,
        (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
      ),
      (error) => error === expected,
    );
    assert.equal(fixture.calls.writer, beforeWriterCalls + 1);
    await fixture.ports.writerTurns.withWriterTurn(
      admission,
      (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
    );
  });

  assert.deepEqual(fixture.calls.fullInputs[1].claimSnapshot.dirtyPaths, [
    'mythpen/volumes/volume-a.json',
  ]);
  assert.deepEqual(fixture.calls.fullInputs[2].claimSnapshot.dirtyPaths, [
    'mythpen/volumes/volume-a.json',
  ]);
  assert.equal(Reflect.ownKeys(fixture.calls.fullInputs[1]).includes('claim'), false);
  await fixture.lifecycle.close(owner);
});

test('a thrown full-refresh port is settled as synthetic UNKNOWN and keeps the owner fail-closed', async () => {
  const marker = new Error('publication disposition unknown');
  const fixture = harness({
    fullRefresh(input, call) {
      if (call === 1) return alreadyCurrent(input.baseToken.generation);
      if (call === 2) throw marker;
      return alreadyCurrent(input.baseToken.generation);
    },
  });
  const owner = await started(fixture);
  await admitted(fixture, owner, async (admission) => {
    await assert.rejects(
      fixture.ports.writerTurns.withWriterTurn(
        admission,
        (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
      ),
      (error) => error === marker,
    );
    await fixture.ports.writerTurns.withWriterTurn(
      admission,
      (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
    );
  });
  assert.equal(fixture.calls.fullInputs.length, 3);
  await fixture.lifecycle.close(owner);
});

test('COMMITTED and ALREADY_CURRENT settle only after an exact post-refresh token witness', async () => {
  for (const disposition of ['COMMITTED', 'ALREADY_CURRENT']) {
    const fixture = harness({
      fullRefresh(input, call, state) {
        if (call === 1) return alreadyCurrent(input.baseToken.generation);
        if (call === 2 && disposition === 'COMMITTED') {
          return committed(input.baseToken.generation, input.baseToken.generation + 1);
        }
        if (call === 2) {
          state.current = token(input.baseToken.generation, 2, BASIS_B);
          return alreadyCurrent(input.baseToken.generation);
        }
        return alreadyCurrent(input.baseToken.generation);
      },
    });
    const owner = await started(fixture);
    await admitted(fixture, owner, async (admission) => {
      await assert.rejects(
        fixture.ports.writerTurns.withWriterTurn(
          admission,
          (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
        ),
        TypeError,
      );
      await fixture.ports.writerTurns.withWriterTurn(
        admission,
        (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
      );
    });
    assert.equal(fixture.calls.fullInputs.length, 3, disposition);
    await fixture.lifecycle.close(owner);
  }
});

test('post-refresh token throw settles the live claim as UNKNOWN and preserves the original error', async () => {
  const marker = new Error('post token unavailable');
  const fixture = harness({
    projectionToken(_admission, call, current) {
      if (call === 4) throw marker;
      return current;
    },
  });
  const owner = await started(fixture);
  await admitted(fixture, owner, async (admission) => {
    await assert.rejects(
      fixture.ports.writerTurns.withWriterTurn(
        admission,
        (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
      ),
      (error) => error === marker,
    );
    await fixture.ports.writerTurns.withWriterTurn(
      admission,
      (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
    );
  });
  assert.equal(fixture.calls.fullInputs.length, 3);
  await fixture.lifecycle.close(owner);
});

test('claimSnapshot failure is synthetic UNKNOWN and never leaks an active claim', async () => {
  const marker = new Error('claim snapshot fault');
  const original = ManuscriptFeedState.prototype.claimSnapshot;
  let snapshotCalls = 0;
  ManuscriptFeedState.prototype.claimSnapshot = function claimSnapshotFault(claim) {
    snapshotCalls += 1;
    if (snapshotCalls === 2) throw marker;
    return Reflect.apply(original, this, [claim]);
  };
  const fixture = harness();
  let owner;
  try {
    owner = await started(fixture);
    await admitted(fixture, owner, async (admission) => {
      await assert.rejects(
        fixture.ports.writerTurns.withWriterTurn(
          admission,
          (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
        ),
        (error) => error === marker,
      );
      ManuscriptFeedState.prototype.claimSnapshot = original;
      await fixture.ports.writerTurns.withWriterTurn(
        admission,
        (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
      );
    });
  } finally {
    ManuscriptFeedState.prototype.claimSnapshot = original;
  }
  await fixture.lifecycle.close(owner);
});

test('direct readable gate retries once across a post-read completion and returns the stable second result', async () => {
  let fixture;
  fixture = harness({
    projectionRead(_admission, _query, call) {
      if (call === 1) {
        fixture.directOwner.enqueue('mythpen', Object.freeze({
          outcome: 'RECORDS',
          records: Object.freeze([
            Object.freeze({ action: 'MODIFIED', component: 'manuscript.json' }),
          ]),
        }));
      }
      return Object.freeze({ token: token(0), value: Object.freeze({ call }) });
    },
  });
  const owner = await started(fixture);
  const result = await admitted(
    fixture,
    owner,
    (admission) => ensureReadableProjection(admission, Object.freeze({ kind: 'outline' })),
  );
  assert.deepEqual(result, { token: token(0), value: { call: 2 } });
  assert.equal(fixture.calls.read, 2);
  assert.equal(fixture.calls.fullInputs.length, 2);
  await fixture.lifecycle.close(owner);
});

test('direct and degraded readable gates share one retry budget and report a canonical changed-tree error', async () => {
  for (const capability of [true, false]) {
    let fixture;
    fixture = harness({
      capability,
      projectionRead(_admission, _query, call) {
        if (capability) {
          fixture.directOwner.enqueue('chapters', Object.freeze({
            outcome: 'RECORDS',
            records: Object.freeze([
              Object.freeze({ action: 'MODIFIED', component: `chapter-${call}.md` }),
            ]),
          }));
          return Object.freeze({ token: token(0), value: Object.freeze({ call }) });
        }
        return Object.freeze({
          token: token(0, call + 1, BASIS_B),
          value: Object.freeze({ call }),
        });
      },
    });
    const owner = await started(fixture);
    await assert.rejects(
      admitted(
        fixture,
        owner,
        (admission) => ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
      ),
      (error) => error?.code === 'MANUSCRIPT_TREE_CHANGED_DURING_READ',
    );
    assert.equal(fixture.calls.read, 2);
    await fixture.lifecycle.close(owner);
  }
});

test('DB_CONNECTION_STALE retries the entire readable gate once while other read errors remain unchanged', async () => {
  const stale = Object.assign(new Error('stale connection'), { code: 'DB_CONNECTION_STALE' });
  const ordinary = new Error('query failed');
  for (const [firstError, shouldRetry] of [[stale, true], [ordinary, false]]) {
    const fixture = harness({
      projectionRead(_admission, _query, call) {
        if (call === 1) throw firstError;
        return Object.freeze({ token: token(0), value: Object.freeze({ call }) });
      },
      capability: false,
    });
    const owner = await started(fixture);
    if (shouldRetry) {
      const result = await admitted(
        fixture,
        owner,
        (admission) => ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
      );
      assert.equal(result.value.call, 2);
    } else {
      await assert.rejects(
        admitted(
          fixture,
          owner,
          (admission) => ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
        ),
        (error) => error === ordinary,
      );
    }
    await fixture.lifecycle.close(owner);
  }
});

test('read errors with a hostile code getter are propagated by identity without invoking the getter', async () => {
  let getterCalls = 0;
  const hostile = new Error('hostile read error');
  Object.defineProperty(hostile, 'code', {
    configurable: false,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('code getter must not execute');
    },
  });
  const fixture = harness({
    capability: false,
    projectionRead() { throw hostile; },
  });
  const owner = await started(fixture);
  await assert.rejects(
    admitted(
      fixture,
      owner,
      (admission) => ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
    ),
    (error) => error === hostile,
  );
  assert.equal(getterCalls, 0);
  await fixture.lifecycle.close(owner);
});

test('degraded reads execute FULL-before/read/FULL-after and reject a mutating full-after witness', async () => {
  const fixture = harness({
    capability: false,
    fullRefresh(input, call, state) {
      if (call === 3) {
        state.current = token(1);
        return committed(0, 1);
      }
      return alreadyCurrent(input.baseToken.generation);
    },
  });
  const owner = await started(fixture);
  const result = await admitted(
    fixture,
    owner,
    (admission) => ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
  );
  assert.equal(result.token.generation, 1);
  assert.equal(fixture.calls.read, 2);
  assert.deepEqual(
    fixture.events.filter((event) => ['full', 'read'].includes(event)),
    ['full', 'full', 'read', 'full', 'full', 'read', 'full'],
  );
  await fixture.lifecycle.close(owner);
});

test('a live feed failure latches loss, remains fatal until cleanup, and never re-enters degraded mode', async () => {
  const marker = new Error('rearm failed');
  const fixture = harness();
  const owner = await started(fixture);
  fixture.directOwner.enqueue('volumes', Object.freeze({
    outcome: 'RECORDS',
    records: Object.freeze([
      Object.freeze({ action: 'MODIFIED', component: 'volume.json' }),
    ]),
  }));
  fixture.directOwner.setRearmError(marker);
  await admitted(fixture, owner, async (admission) => {
    await assert.rejects(
      fixture.ports.writerTurns.withWriterTurn(
        admission,
        (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
      ),
      (error) => error === marker,
    );
    await assert.rejects(ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
      (error) => error === marker);
  });
  assert.equal(fixture.calls.open, 1);
  fixture.directOwner.setRearmError(null);
  await fixture.lifecycle.close(owner);
  assert.equal(fixture.calls.open, 1);
});

test('a live event-probe failure is sticky even if the platform later appears quiet', async () => {
  const marker = new Error('WaitForSingleObject failed');
  const fixture = harness();
  const owner = await started(fixture);
  fixture.directOwner.setProbeError(marker);
  await admitted(fixture, owner, async (admission) => {
    await assert.rejects(
      ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
      (error) => error === marker,
    );
    fixture.directOwner.setProbeError(null);
    await assert.rejects(
      ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
      (error) => error === marker,
    );
  });
  await fixture.lifecycle.close(owner);
});

test('a signaled feed returning no completion fails immediately instead of spinning', async () => {
  const stopper = new Error('full refresh must not be reached');
  const fixture = harness({
    fullRefresh(input, call) {
      if (call > 1) throw stopper;
      return alreadyCurrent(input.baseToken.generation);
    },
  });
  const owner = await started(fixture);
  fixture.directOwner.enqueue('mythpen', Object.freeze({
    outcome: 'RECORDS',
    records: Object.freeze([
      Object.freeze({ action: 'MODIFIED', component: 'manuscript.json' }),
    ]),
  }));
  fixture.directOwner.setTakeNull(true);
  let fatal;
  await admitted(fixture, owner, async (admission) => {
    await assert.rejects(
      fixture.ports.writerTurns.withWriterTurn(
        admission,
        (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
      ),
      (error) => {
        fatal = error;
        return error instanceof TypeError && error !== stopper;
      },
    );
    await assert.rejects(
      ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
      (error) => error === fatal,
    );
  });
  assert.equal(fixture.calls.fullInputs.length, 1);
  fixture.directOwner.setTakeNull(false);
  await fixture.lifecycle.close(owner);
});

test('completion counters that make no accounting progress become one sticky fatal error', async () => {
  const fixture = harness();
  const owner = await started(fixture);
  fixture.directOwner.enqueue('volumes', Object.freeze({
    outcome: 'RECORDS',
    records: Object.freeze([
      Object.freeze({ action: 'MODIFIED', component: 'volume.json' }),
    ]),
  }));
  const original = ManuscriptFeedState.prototype.accountCompletion;
  let skipped = false;
  ManuscriptFeedState.prototype.accountCompletion = function accountWithoutProgress(...args) {
    if (!skipped) {
      skipped = true;
      return undefined;
    }
    return Reflect.apply(original, this, args);
  };
  let fatal;
  try {
    await admitted(fixture, owner, async (admission) => {
      await assert.rejects(
        fixture.ports.writerTurns.withWriterTurn(
          admission,
          (writerTurn) => ensureProjectionCurrent(admission, writerTurn),
        ),
        (error) => {
          fatal = error;
          return error instanceof TypeError;
        },
      );
      ManuscriptFeedState.prototype.accountCompletion = original;
      await assert.rejects(
        ensureReadableProjection(admission, Object.freeze({ kind: 'tree' })),
        (error) => error === fatal,
      );
    });
  } finally {
    ManuscriptFeedState.prototype.accountCompletion = original;
  }
  assert.equal(fixture.calls.open, 1);
  await assert.rejects(fixture.lifecycle.close(owner), TypeError);
});
