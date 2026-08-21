'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ManuscriptFeedState } = require('../manuscript/feed-state');

const FEED_IDS = Object.freeze(['mythpen', 'volumes', 'chapters']);
const NO_EVENTS = Object.freeze({
  mythpen: false,
  volumes: false,
  chapters: false,
});

function handle(label) {
  return Object.freeze({ label });
}

function directState() {
  const state = new ManuscriptFeedState();
  const handles = Object.freeze({
    mythpen: handle('mythpen'),
    volumes: handle('volumes'),
    chapters: handle('chapters'),
  });
  for (const feedId of FEED_IDS) state.arm(feedId, handles[feedId]);
  return { state, handles };
}

function gate(state, events = NO_EVENTS) {
  return state.gateSnapshot(() => events);
}

function alreadyCurrent(generation, refreshKind = 'FULL') {
  return Object.freeze({
    disposition: 'ALREADY_CURRENT',
    generation,
    refreshKind,
  });
}

function committed(baseGeneration, targetGeneration, refreshKind = 'FULL') {
  return Object.freeze({
    disposition: 'COMMITTED',
    baseGeneration,
    targetGeneration,
    refreshKind,
  });
}

function settleStartup(state, generation = 0) {
  const claim = state.claimRefresh(generation);
  state.settleRefresh(claim, alreadyCurrent(generation));
}

function record(
  state,
  handles,
  feedId,
  dirtyPaths = Object.freeze([]),
  coverageLost = false,
) {
  const completion = state.observeCompletion(feedId, handles[feedId]);
  state.recordRearm(completion, handles[feedId]);
  state.accountCompletion(completion, dirtyPaths, coverageLost);
  return completion;
}

function assertDeepFrozenSnapshot(snapshot) {
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.events), true);
  assert.equal(Object.isFrozen(snapshot.feeds), true);
  assert.equal(Object.isFrozen(snapshot.dirtyPaths), true);
  for (const feedId of FEED_IDS) assert.equal(Object.isFrozen(snapshot.feeds[feedId]), true);
  if (snapshot.refresh !== null) {
    assert.equal(Object.isFrozen(snapshot.refresh), true);
    assert.equal(Object.isFrozen(snapshot.refresh.dirtyPaths), true);
  }
}

test('startup is loss-latched until three exact feeds are armed and a stable full refresh settles', () => {
  const state = new ManuscriptFeedState();
  const handles = {
    mythpen: handle('m'),
    volumes: handle('v'),
    chapters: handle('c'),
  };

  assert.throws(() => state.arm('other', handle('other')), TypeError);
  assert.throws(() => state.arm('mythpen', 7), TypeError);
  state.arm('mythpen', handles.mythpen);
  assert.throws(() => state.arm('mythpen', handles.mythpen), TypeError);
  state.arm('volumes', handles.volumes);
  state.arm('chapters', handles.chapters);

  let probes = 0;
  const snapshot = state.gateSnapshot(() => {
    probes += 1;
    return NO_EVENTS;
  });
  assert.equal(probes, 1);
  assert.deepEqual(snapshot, {
    lifecycleState: 'ACTIVE',
    degradedReason: null,
    events: NO_EVENTS,
    feeds: {
      mythpen: {
        handleInstance: handles.mythpen,
        armed: true,
        observed: '0',
        accounted: '0',
      },
      volumes: {
        handleInstance: handles.volumes,
        armed: true,
        observed: '0',
        accounted: '0',
      },
      chapters: {
        handleInstance: handles.chapters,
        armed: true,
        observed: '0',
        accounted: '0',
      },
    },
    dirtyPaths: [],
    refresh: null,
    coverageLost: true,
    coverageLossEpoch: '1',
    clean: false,
  });
  assertDeepFrozenSnapshot(snapshot);

  const claim = state.claimRefresh(0);
  assert.equal(Object.isFrozen(claim), true);
  assert.deepEqual(Reflect.ownKeys(claim), []);
  assert.deepEqual(state.claimSnapshot(claim), {
    baseGeneration: 0,
    dirtyPaths: [],
  });
  const result = alreadyCurrent(0);
  assert.equal(state.settleRefresh(claim, result), result);

  const clean = gate(state);
  assert.equal(clean.coverageLost, false);
  assert.equal(clean.coverageLossEpoch, '1');
  assert.equal(clean.clean, true);
});

test('degraded mode has no handles, remains full-dirty after refresh, and closes without feed calls', () => {
  for (const reason of ['CAPABILITY_DISABLED', 'NO_SLOT', 'KNOWN_UNAVAILABLE']) {
    const state = new ManuscriptFeedState();
    state.enterDegraded(reason);

    const before = gate(state);
    assert.equal(before.lifecycleState, 'DEGRADED');
    assert.equal(before.degradedReason, reason);
    assert.equal(before.coverageLost, true);
    assert.equal(before.clean, false);
    for (const feedId of FEED_IDS) {
      assert.deepEqual(before.feeds[feedId], {
        handleInstance: null,
        armed: false,
        observed: '0',
        accounted: '0',
      });
    }

    const claim = state.claimRefresh(3);
    assert.deepEqual(state.claimSnapshot(claim), {
      baseGeneration: 3,
      dirtyPaths: [],
    });
    state.settleRefresh(claim, alreadyCurrent(3));
    assert.equal(gate(state).coverageLost, true);

    state.beginStopping();
    state.finishClosed();
    assert.throws(() => gate(state), TypeError);
  }

  const invalid = new ManuscriptFeedState();
  assert.throws(() => invalid.enterDegraded('UNAVAILABLE'), TypeError);
  assert.throws(() => invalid.enterDegraded(true), TypeError);
  invalid.enterDegraded('NO_SLOT');
  assert.throws(() => invalid.enterDegraded('NO_SLOT'), TypeError);
  assert.throws(() => invalid.arm('mythpen', handle('late')), TypeError);
});

test('gate probe executes exactly once inside the writer and any probe failure latches loss first', () => {
  const { state } = directState();
  settleStartup(state);

  const probeError = new Error('WaitForSingleObject failed');
  let calls = 0;
  assert.throws(
    () => state.gateSnapshot(() => {
      calls += 1;
      throw probeError;
    }),
    (error) => error === probeError,
  );
  assert.equal(calls, 1);
  let snapshot = gate(state);
  assert.equal(snapshot.coverageLost, true);
  assert.equal(snapshot.coverageLossEpoch, '2');
  assert.equal(snapshot.clean, false);

  assert.throws(
    () => state.gateSnapshot(() => {
      state.claimRefresh(0);
      return NO_EVENTS;
    }),
    (error) => error instanceof TypeError,
  );
  snapshot = gate(state);
  assert.equal(snapshot.coverageLossEpoch, '3');

  let getterCalls = 0;
  const accessorEvents = {};
  Object.defineProperty(accessorEvents, 'mythpen', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return false;
    },
  });
  Object.defineProperties(accessorEvents, {
    volumes: { enumerable: true, value: false },
    chapters: { enumerable: true, value: false },
  });
  Object.freeze(accessorEvents);
  assert.throws(() => state.gateSnapshot(() => accessorEvents), TypeError);
  assert.equal(getterCalls, 0);
  assert.equal(gate(state).coverageLossEpoch, '4');

  assert.throws(
    () => state.gateSnapshot(() => Object.freeze({ ...NO_EVENTS, extra: false })),
    TypeError,
  );
  assert.equal(gate(state).coverageLossEpoch, '5');
});

test('observe, successful rearm, and account are one ordered authority chain with decimal counters', () => {
  const { state, handles } = directState();
  settleStartup(state);

  const completion = state.observeCompletion('chapters', handles.chapters);
  assert.equal(Object.isFrozen(completion), true);
  assert.deepEqual(Reflect.ownKeys(completion), []);
  let snapshot = gate(state);
  assert.equal(snapshot.feeds.chapters.armed, false);
  assert.equal(snapshot.feeds.chapters.observed, '1');
  assert.equal(snapshot.feeds.chapters.accounted, '0');
  assert.equal(snapshot.clean, false);

  state.recordRearm(completion, handles.chapters);
  snapshot = gate(state);
  assert.equal(snapshot.feeds.chapters.armed, true);
  assert.equal(snapshot.feeds.chapters.observed, '1');
  assert.equal(snapshot.feeds.chapters.accounted, '0');
  assert.equal(snapshot.clean, false);

  state.accountCompletion(completion, Object.freeze([
    'mythpen/chapters/b.json',
    'mythpen/a.json',
    'mythpen/volumes/c.json',
  ]), false);
  snapshot = gate(state);
  assert.deepEqual(snapshot.dirtyPaths, [
    'mythpen/a.json',
    'mythpen/chapters/b.json',
    'mythpen/volumes/c.json',
  ]);
  assert.equal(snapshot.feeds.chapters.observed, '1');
  assert.equal(snapshot.feeds.chapters.accounted, '1');
  assert.equal(typeof snapshot.feeds.chapters.observed, 'string');
  assert.equal(snapshot.coverageLost, false);

  const claim = state.claimRefresh(4);
  const result = committed(4, 5);
  assert.equal(state.settleRefresh(claim, result), result);
  assert.equal(gate(state).clean, true);
});

test('dirty paths must be dense frozen unique canonical relative component keys', () => {
  const invalidPaths = [
    ['mythpen/chapter.json'],
    Object.freeze(['C:/mythpen/chapter.json']),
    Object.freeze(['mythpen\\chapter.json']),
    Object.freeze(['mythpen/.']),
    Object.freeze(['mythpen/..']),
    Object.freeze(['mythpen/volumes']),
    Object.freeze(['mythpen/volumes/a/b']),
    Object.freeze(['mythpen//a']),
    Object.freeze(['mythpen/a', 'mythpen/a']),
    Object.freeze(['mythpen/a\u0000b']),
    Object.freeze(['mythpen/e\u0301']),
  ];
  const sparse = [];
  sparse.length = 1;
  invalidPaths.push(Object.freeze(sparse));
  const accessor = [];
  let getterCalls = 0;
  Object.defineProperty(accessor, '0', {
    configurable: false,
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'mythpen/a';
    },
  });
  accessor.length = 1;
  invalidPaths.push(Object.freeze(accessor));

  const { state, handles } = directState();
  settleStartup(state);
  const completion = state.observeCompletion('mythpen', handles.mythpen);
  for (const paths of invalidPaths) {
    assert.throws(() => state.accountCompletion(completion, paths, true), TypeError);
    const snapshot = gate(state);
    assert.equal(snapshot.feeds.mythpen.observed, '1');
    assert.equal(snapshot.feeds.mythpen.accounted, '0');
    assert.equal(snapshot.clean, false);
  }
  assert.equal(getterCalls, 0);
  assert.throws(
    () => state.accountCompletion(completion, Object.freeze([]), 1),
    TypeError,
  );

  state.accountCompletion(completion, Object.freeze([]), true);
  const recovered = gate(state);
  assert.equal(recovered.feeds.mythpen.accounted, '1');
  assert.equal(recovered.feeds.mythpen.armed, false);
  assert.equal(recovered.coverageLost, true);
});

test('plain, cloned, foreign, stale, repeated, and out-of-order completion use cannot mutate state', () => {
  const first = directState();
  const second = directState();
  settleStartup(first.state);
  settleStartup(second.state);

  const completion = first.state.observeCompletion('volumes', first.handles.volumes);
  for (const invalid of [Object.freeze({}), { ...completion }]) {
    assert.throws(
      () => first.state.recordRearm(invalid, first.handles.volumes),
      TypeError,
    );
    assert.throws(
      () => first.state.accountCompletion(invalid, Object.freeze([]), true),
      TypeError,
    );
  }
  assert.throws(
    () => second.state.recordRearm(completion, second.handles.volumes),
    TypeError,
  );
  assert.throws(
    () => first.state.recordRearm(completion, handle('stale')),
    TypeError,
  );
  assert.throws(
    () => first.state.accountCompletion(completion, Object.freeze([]), false),
    TypeError,
  );
  let snapshot = gate(first.state);
  assert.equal(snapshot.feeds.volumes.observed, '1');
  assert.equal(snapshot.feeds.volumes.accounted, '0');

  first.state.recordRearm(completion, first.handles.volumes);
  assert.throws(
    () => first.state.recordRearm(completion, first.handles.volumes),
    TypeError,
  );
  first.state.accountCompletion(completion, Object.freeze([]), false);
  assert.throws(
    () => first.state.accountCompletion(completion, Object.freeze([]), true),
    TypeError,
  );
  assert.throws(
    () => first.state.recordRearm(completion, first.handles.volumes),
    TypeError,
  );
  snapshot = gate(first.state);
  assert.equal(snapshot.feeds.volumes.observed, '1');
  assert.equal(snapshot.feeds.volumes.accounted, '1');

  const lossCompletion = first.state.observeCompletion('chapters', first.handles.chapters);
  first.state.accountCompletion(lossCompletion, Object.freeze([]), true);
  assert.equal(gate(first.state).coverageLost, true);
});

test('background take/rearm followed by decode failure cannot stitch a false-clean gate', () => {
  const { state, handles } = directState();
  settleStartup(state);

  const completion = state.observeCompletion('mythpen', handles.mythpen);
  state.recordRearm(completion, handles.mythpen);
  const decodeError = new Error('malformed FILE_NOTIFY_INFORMATION');
  state.accountCompletion(completion, Object.freeze([]), true);

  const snapshot = gate(state);
  assert.equal(snapshot.feeds.mythpen.armed, true);
  assert.equal(snapshot.feeds.mythpen.observed, snapshot.feeds.mythpen.accounted);
  assert.equal(snapshot.coverageLost, true);
  assert.equal(snapshot.clean, false);
  assert.equal(decodeError.message, 'malformed FILE_NOTIFY_INFORMATION');
});

test('claim atomically moves old dirty paths while new completions remain ordinary dirty', () => {
  const { state, handles } = directState();
  settleStartup(state);
  record(state, handles, 'mythpen', Object.freeze(['mythpen/manuscript.json']));
  record(state, handles, 'volumes', Object.freeze(['mythpen/volumes/a.json']));

  const claim = state.claimRefresh(10);
  const claimSnapshot = state.claimSnapshot(claim);
  assert.deepEqual(claimSnapshot, {
    baseGeneration: 10,
    dirtyPaths: ['mythpen/manuscript.json', 'mythpen/volumes/a.json'],
  });
  assert.equal(Object.isFrozen(claimSnapshot), true);
  assert.equal(Object.isFrozen(claimSnapshot.dirtyPaths), true);
  assert.equal(state.claimSnapshot(claim), claimSnapshot);
  let snapshot = gate(state);
  assert.deepEqual(snapshot.dirtyPaths, []);
  assert.deepEqual(snapshot.refresh, claimSnapshot);
  assert.equal(snapshot.clean, false);

  record(state, handles, 'chapters', Object.freeze(['mythpen/chapters/new.md']));
  snapshot = gate(state);
  assert.deepEqual(snapshot.dirtyPaths, ['mythpen/chapters/new.md']);
  assert.deepEqual(snapshot.refresh.dirtyPaths, [
    'mythpen/manuscript.json',
    'mythpen/volumes/a.json',
  ]);

  state.settleRefresh(claim, committed(10, 11));
  assert.throws(() => state.claimSnapshot(claim), TypeError);
  snapshot = gate(state);
  assert.equal(snapshot.refresh, null);
  assert.deepEqual(snapshot.dirtyPaths, ['mythpen/chapters/new.md']);
});

test('refresh claim authorities reject plain, cloned, foreign, and settled reuse', () => {
  const first = directState();
  const second = directState();
  settleStartup(first.state);
  settleStartup(second.state);
  const firstClaim = first.state.claimRefresh(1);
  const secondClaim = second.state.claimRefresh(1);

  for (const invalid of [Object.freeze({}), { ...firstClaim }, secondClaim]) {
    assert.throws(() => first.state.claimSnapshot(invalid), TypeError);
    assert.throws(
      () => first.state.settleRefresh(invalid, alreadyCurrent(1)),
      TypeError,
    );
  }
  first.state.settleRefresh(firstClaim, alreadyCurrent(1));
  assert.throws(
    () => first.state.settleRefresh(firstClaim, alreadyCurrent(1)),
    TypeError,
  );
  second.state.settleRefresh(secondClaim, alreadyCurrent(1));
});

test('settleRefresh accepts only exact frozen plain result variants and matching generations', () => {
  const { state } = directState();
  settleStartup(state);
  const claim = state.claimRefresh(8);
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperties(accessor, {
    disposition: {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'ALREADY_CURRENT';
      },
    },
    generation: { enumerable: true, value: 8 },
    refreshKind: { enumerable: true, value: 'FULL' },
  });
  Object.freeze(accessor);
  const withSymbol = {
    disposition: 'ALREADY_CURRENT',
    generation: 8,
    refreshKind: 'FULL',
  };
  Object.defineProperty(withSymbol, Symbol('extra'), { value: true });
  Object.freeze(withSymbol);

  const invalidResults = [
    { disposition: 'ALREADY_CURRENT', generation: 8, refreshKind: 'FULL' },
    Object.freeze({
      disposition: 'ALREADY_CURRENT',
      generation: 8,
      refreshKind: 'FULL',
      extra: true,
    }),
    accessor,
    withSymbol,
    Object.freeze(['ALREADY_CURRENT', 8, 'FULL']),
    Object.freeze({ disposition: 'ALREADY_CURRENT', generation: 7, refreshKind: 'FULL' }),
    Object.freeze({ disposition: 'ALREADY_CURRENT', generation: 8, refreshKind: 'full' }),
    Object.freeze({ disposition: 'COMMITTED', baseGeneration: 7, targetGeneration: 9, refreshKind: 'FULL' }),
    Object.freeze({ disposition: 'COMMITTED', baseGeneration: 8, targetGeneration: 8, refreshKind: 'FULL' }),
    Object.freeze({ disposition: 'COMMITTED', baseGeneration: 8, targetGeneration: 9.5, refreshKind: 'FULL' }),
    Object.freeze({ disposition: 'KNOWN_NOT_COMMITTED', generation: 8, refreshKind: 'FULL' }),
    Object.freeze({ disposition: 'UNKNOWN', generation: -0, refreshKind: 'FULL', error: new Error('x') }),
  ];
  for (const result of invalidResults) {
    assert.throws(() => state.settleRefresh(claim, result), TypeError);
    assert.equal(state.claimSnapshot(claim).baseGeneration, 8);
  }
  assert.equal(getterCalls, 0);

  const result = committed(8, 9, 'INCREMENTAL');
  assert.equal(state.settleRefresh(claim, result), result);

  for (const invalidGeneration of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const fixture = directState();
    assert.throws(() => fixture.state.claimRefresh(invalidGeneration), TypeError);
  }
});

test('known-not-committed and unknown results merge claimed dirty and throw the original error', () => {
  for (const disposition of ['KNOWN_NOT_COMMITTED', 'UNKNOWN']) {
    const { state, handles } = directState();
    settleStartup(state);
    record(state, handles, 'mythpen', Object.freeze(['mythpen/old.json']));
    const claim = state.claimRefresh(5);
    record(state, handles, 'chapters', Object.freeze(['mythpen/chapters/new.md']));
    const error = new Error(disposition, { cause: new Error('original cause') });
    let getterCalls = 0;
    Object.defineProperty(error, 'dangerous', {
      get() {
        getterCalls += 1;
        throw new Error('must not inspect error');
      },
    });
    const result = Object.freeze({
      disposition,
      generation: 5,
      refreshKind: 'FULL',
      error,
    });

    assert.throws(
      () => state.settleRefresh(claim, result),
      (thrown) => thrown === error,
    );
    assert.equal(getterCalls, 0);
    const snapshot = gate(state);
    assert.deepEqual(snapshot.dirtyPaths, [
      'mythpen/chapters/new.md',
      'mythpen/old.json',
    ]);
    assert.equal(snapshot.refresh, null);
    assert.equal(snapshot.coverageLost, disposition === 'UNKNOWN');
    assert.equal(snapshot.coverageLossEpoch, disposition === 'UNKNOWN' ? '2' : '1');
  }
});

test('only a stable full success can clear loss; incremental or interleaved loss cannot', () => {
  const { state, handles } = directState();
  settleStartup(state);
  record(state, handles, 'mythpen', Object.freeze([]), true);
  assert.equal(gate(state).coverageLost, true);

  let claim = state.claimRefresh(2);
  state.settleRefresh(claim, alreadyCurrent(2, 'INCREMENTAL'));
  assert.equal(gate(state).coverageLost, true);

  claim = state.claimRefresh(2);
  record(state, handles, 'volumes', Object.freeze([]), true);
  state.settleRefresh(claim, alreadyCurrent(2));
  let snapshot = gate(state);
  assert.equal(snapshot.coverageLost, true);
  assert.equal(snapshot.coverageLossEpoch, '3');

  claim = state.claimRefresh(2);
  state.settleRefresh(claim, alreadyCurrent(2));
  snapshot = gate(state);
  assert.equal(snapshot.coverageLost, false);
  assert.equal(snapshot.coverageLossEpoch, '3');
});

test('a balanced completion during a full refresh still prevents loss from clearing', () => {
  const { state, handles } = directState();
  settleStartup(state);
  record(state, handles, 'mythpen', Object.freeze([]), true);
  assert.equal(gate(state).coverageLost, true);

  const claim = state.claimRefresh(6);
  record(state, handles, 'chapters', Object.freeze([]), false);
  state.settleRefresh(claim, alreadyCurrent(6));

  const snapshot = gate(state);
  assert.equal(snapshot.feeds.chapters.observed, '1');
  assert.equal(snapshot.feeds.chapters.accounted, '1');
  assert.equal(snapshot.coverageLossEpoch, '2');
  assert.equal(snapshot.coverageLost, true);
  assert.equal(snapshot.clean, false);
});

test('an unarmed or unaccounted feed prevents full success from clearing coverage loss', () => {
  const { state, handles } = directState();
  settleStartup(state);
  record(state, handles, 'mythpen', Object.freeze([]), true);
  const claim = state.claimRefresh(0);
  const pending = state.observeCompletion('chapters', handles.chapters);
  state.settleRefresh(claim, alreadyCurrent(0));
  let snapshot = gate(state);
  assert.equal(snapshot.coverageLost, true);
  assert.equal(snapshot.feeds.chapters.observed, '1');
  assert.equal(snapshot.feeds.chapters.accounted, '0');

  state.accountCompletion(pending, Object.freeze([]), true);
  snapshot = gate(state);
  assert.equal(snapshot.feeds.chapters.armed, false);
  assert.equal(snapshot.coverageLost, true);
});

test('stopping blocks new gates, claims, arms, and rearms but permits terminal observation/accounting', () => {
  const { state, handles } = directState();
  settleStartup(state);
  record(state, handles, 'mythpen', Object.freeze(['mythpen/dirty.json']));
  const beforeStop = gate(state);
  assert.deepEqual(beforeStop.dirtyPaths, ['mythpen/dirty.json']);

  state.beginStopping();
  assert.throws(() => gate(state), TypeError);
  assert.throws(() => state.claimRefresh(0), TypeError);
  assert.throws(() => state.arm('mythpen', handle('replacement')), TypeError);
  assert.throws(() => state.enterDegraded('NO_SLOT'), TypeError);
  assert.throws(() => state.beginStopping(), TypeError);
  assert.throws(() => state.finishClosed(), TypeError);

  for (const feedId of FEED_IDS) {
    assert.throws(() => state.closeFeed(feedId, handles[feedId]), TypeError);
    const completion = state.observeCompletion(feedId, handles[feedId]);
    assert.throws(
      () => state.recordRearm(completion, handles[feedId]),
      TypeError,
    );
    assert.throws(
      () => state.closeFeed(feedId, handles[feedId]),
      TypeError,
    );
    state.accountCompletion(completion, Object.freeze([]), true);
    assert.throws(() => state.closeFeed(feedId, handle('stale')), TypeError);
    state.closeFeed(feedId, handles[feedId]);
    assert.throws(() => state.closeFeed(feedId, handles[feedId]), TypeError);
  }
  state.finishClosed();
  assert.throws(() => state.finishClosed(), TypeError);
  assert.throws(
    () => state.observeCompletion('mythpen', handles.mythpen),
    TypeError,
  );
});

test('finishClosed rejects an outstanding refresh claim even after all feeds are closed', () => {
  const { state, handles } = directState();
  settleStartup(state);
  const claim = state.claimRefresh(0);
  state.beginStopping();
  for (const feedId of FEED_IDS) {
    const completion = state.observeCompletion(feedId, handles[feedId]);
    state.accountCompletion(completion, Object.freeze([]), true);
    state.closeFeed(feedId, handles[feedId]);
  }
  assert.throws(() => state.finishClosed(), TypeError);
  state.settleRefresh(claim, alreadyCurrent(0));
  state.finishClosed();
});

test('handle instances are immutable for one feed-state lifetime and old authorities cannot create ABA clean', () => {
  const first = directState();
  settleStartup(first.state);
  const oldCompletion = first.state.observeCompletion('mythpen', first.handles.mythpen);
  first.state.accountCompletion(oldCompletion, Object.freeze([]), true);
  assert.throws(
    () => first.state.arm('mythpen', handle('replacement')),
    TypeError,
  );
  const snapshot = gate(first.state);
  assert.equal(snapshot.feeds.mythpen.observed, '1');
  assert.equal(snapshot.feeds.mythpen.accounted, '1');
  assert.equal(snapshot.coverageLost, true);

  const second = directState();
  settleStartup(second.state);
  assert.throws(
    () => second.state.accountCompletion(oldCompletion, Object.freeze([]), true),
    TypeError,
  );
  assert.equal(gate(second.state).clean, true);
});
