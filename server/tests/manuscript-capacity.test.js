'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCapacityAccumulator } = require('../manuscript/capacity');

function limits(overrides = {}) {
  return {
    chapterIdentities: 2,
    volumeIdentities: 2,
    markdownBytes: 16,
    jsonBytes: 8,
    controlledFiles: 3,
    chapterDirectoryEntries: 3,
    controlledBytes: 24,
    ...overrides,
  };
}

test('limits are complete finite counters snapshotted at accumulator creation', () => {
  const mutableLimits = limits();
  const accumulator = createCapacityAccumulator(mutableLimits);
  mutableLimits.chapterIdentities = 99;

  accumulator.recordIdentity({ kind: 'chapter', uid: 'chapter-a', source: 'active' });
  accumulator.recordIdentity({ kind: 'chapter', uid: 'chapter-b', source: 'active' });
  assert.throws(
    () => accumulator.recordIdentity({ kind: 'chapter', uid: 'chapter-c', source: 'active' }),
    (error) => JSON.stringify(error?.details) === JSON.stringify({
      dimension: 'chapterIdentities',
      observed: 3,
      allowed: 2,
    }),
  );

  const requiredDimensions = Object.keys(limits());
  for (const invalidLimits of [
    null,
    {},
    Object.fromEntries(requiredDimensions.slice(1).map((key) => [key, 1])),
    limits({ jsonBytes: -1 }),
    limits({ controlledFiles: 1.5 }),
    limits({ controlledBytes: Number.MAX_SAFE_INTEGER + 1 }),
  ]) {
    assert.throws(() => createCapacityAccumulator(invalidLimits), TypeError);
  }
});

test('chapter identities are a lifecycle union and the first excess latches the accumulator', () => {
  const accumulator = createCapacityAccumulator(limits());

  accumulator.recordIdentity({ kind: 'chapter', uid: 'chapter-a', source: 'active' });
  accumulator.recordIdentity({ kind: 'chapter', uid: 'chapter-a', source: 'tombstone' });
  accumulator.recordIdentity({ kind: 'chapter', uid: 'chapter-b', source: 'ignored_revoked' });

  assert.equal(accumulator.snapshot().measurements.chapterIdentities, 2);
  assert.throws(
    () => accumulator.recordIdentity({
      kind: 'chapter',
      uid: 'chapter-c',
      source: 'ignored_active',
    }),
    (error) => (
      error?.code === 'MANUSCRIPT_CONTENT_TOO_LARGE'
      && error.message === 'MANUSCRIPT_CONTENT_TOO_LARGE'
      && JSON.stringify(error.details) === JSON.stringify({
        dimension: 'chapterIdentities',
        observed: 3,
        allowed: 2,
      })
    ),
  );

  const terminal = accumulator.snapshot();
  assert.equal(terminal.state, 'exceeded');
  assert.equal(terminal.measurements.chapterIdentities, 3);
  assert.throws(
    () => accumulator.recordIdentity({ kind: 'chapter', uid: 'chapter-d', source: 'active' }),
    (error) => error === terminal.error,
  );
  assert.deepEqual(accumulator.snapshot(), terminal);
});

test('volume lifecycle sources share one identity set and emit one persistent 80 percent warning', () => {
  const observed = [];
  const persistedWarnings = new Map();
  const observer = (snapshot) => {
    observed.push(snapshot);
    for (const warning of snapshot.warnings) persistedWarnings.set(warning.key, warning);
  };
  const accumulator = createCapacityAccumulator(limits({ volumeIdentities: 5 }), observer);

  accumulator.recordIdentity({ kind: 'volume', uid: 'volume-a', source: 'active' });
  accumulator.recordIdentity({ kind: 'volume', uid: 'volume-a', source: 'tombstone' });
  accumulator.recordIdentity({ kind: 'volume', uid: 'volume-b', source: 'ignored_active' });
  accumulator.recordIdentity({ kind: 'volume', uid: 'volume-c', source: 'ignored_revoked' });
  accumulator.recordIdentity({ kind: 'volume', uid: 'volume-d', source: 'tombstone' });
  accumulator.recordIdentity({ kind: 'volume', uid: 'volume-d', source: 'active' });
  accumulator.recordIdentity({ kind: 'volume', uid: 'volume-e', source: 'active' });

  const snapshot = accumulator.snapshot();
  assert.equal(snapshot.measurements.volumeIdentities, 5);
  assert.deepEqual(snapshot.warnings, [{
    key: 'manuscript-capacity:volumeIdentities:80-percent',
    dimension: 'volumeIdentities',
    observed: 4,
    allowed: 5,
    threshold: 4,
    persistent: true,
  }]);
  assert.equal(persistedWarnings.size, 1);
  assert.equal(observed.length, 5);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.measurements), true);
  assert.equal(Object.isFrozen(snapshot.counters), true);
  assert.equal(Object.isFrozen(snapshot.warnings), true);
  assert.equal(Object.isFrozen(snapshot.warnings[0]), true);
  assert.throws(() => { snapshot.measurements.volumeIdentities = 0; }, TypeError);
  assert.throws(() => { snapshot.warnings[0].observed = 0; }, TypeError);
});

test('directory overflow stops every later observer enumeration probe open and byte counter', () => {
  const observed = [];
  const accumulator = createCapacityAccumulator(
    limits({ chapterDirectoryEntries: 1 }),
    (snapshot) => observed.push(snapshot),
  );

  accumulator.recordDirectoryEntry({ chapterDirectory: false });
  accumulator.recordIdentityProbe();
  accumulator.recordDirectoryEntry({ chapterDirectory: true });
  assert.throws(
    () => accumulator.recordDirectoryEntry({ chapterDirectory: true }),
    (error) => (
      error?.code === 'MANUSCRIPT_CONTENT_TOO_LARGE'
      && JSON.stringify(error.details) === JSON.stringify({
        dimension: 'chapterDirectoryEntries',
        observed: 2,
        allowed: 1,
      })
    ),
  );

  const terminal = accumulator.snapshot();
  const observerCalls = observed.length;
  assert.deepEqual(terminal.counters, {
    directoryEntries: 3,
    identityProbes: 1,
    contentOpens: 0,
    contentBytes: 0,
  });
  assert.equal(terminal.measurements.chapterDirectoryEntries, 2);

  for (const mutate of [
    () => accumulator.recordDirectoryEntry({ chapterDirectory: false }),
    () => accumulator.recordIdentityProbe(),
    () => accumulator.recordContentOpen(),
    () => accumulator.recordContentBytes(7),
  ]) {
    assert.throws(mutate, (error) => error === terminal.error);
  }
  assert.deepEqual(accumulator.snapshot(), terminal);
  assert.equal(observed.length, observerCalls);
});

test('metadata rejects an oversized markdown or JSON file before any content open', () => {
  for (const testCase of [
    { kind: 'markdown', byteSize: 17, dimension: 'markdownBytes', allowed: 16 },
    { kind: 'json', byteSize: 9, dimension: 'jsonBytes', allowed: 8 },
  ]) {
    let physicalOpenCalls = 0;
    const accumulator = createCapacityAccumulator(limits());
    const inspectFile = () => {
      accumulator.recordIdentityProbe();
      accumulator.recordFileMetadata({
        kind: testCase.kind,
        byteSize: testCase.byteSize,
        source: 'ignored_active',
      });
      physicalOpenCalls += 1;
      accumulator.recordContentOpen();
    };

    assert.throws(
      inspectFile,
      (error) => (
        error?.code === 'MANUSCRIPT_CONTENT_TOO_LARGE'
        && JSON.stringify(error.details) === JSON.stringify({
          dimension: testCase.dimension,
          observed: testCase.byteSize,
          allowed: testCase.allowed,
        })
      ),
    );
    const terminal = accumulator.snapshot();
    assert.equal(physicalOpenCalls, 0);
    assert.equal(terminal.counters.contentOpens, 0);
    assert.equal(terminal.measurements[testCase.dimension], testCase.byteSize);
    assert.equal(terminal.measurements.controlledFiles, 0);
    assert.equal(terminal.measurements.controlledBytes, 0);
  }
});

test('active ignored files still consume file and byte capacity without content parsing', () => {
  const accumulator = createCapacityAccumulator(limits());

  accumulator.recordFileMetadata({
    kind: 'markdown',
    byteSize: 11,
    source: 'ignored_active',
  });
  accumulator.recordFileMetadata({
    kind: 'json',
    byteSize: 7,
    source: 'ignored_active',
  });

  const snapshot = accumulator.snapshot();
  assert.deepEqual(snapshot.measurements, {
    chapterIdentities: 0,
    volumeIdentities: 0,
    markdownBytes: 11,
    jsonBytes: 7,
    controlledFiles: 2,
    chapterDirectoryEntries: 0,
    controlledBytes: 18,
  });
  assert.equal(snapshot.counters.contentOpens, 0);
  assert.equal(snapshot.counters.contentBytes, 0);
});

test('controlled file count and total raw bytes fail on the first over-limit metadata record', () => {
  const cases = [
    {
      overrides: { controlledFiles: 1, controlledBytes: 20 },
      firstBytes: 2,
      secondBytes: 2,
      dimension: 'controlledFiles',
      observed: 2,
      allowed: 1,
      finalFiles: 2,
      finalBytes: 2,
    },
    {
      overrides: { controlledFiles: 3, controlledBytes: 3 },
      firstBytes: 2,
      secondBytes: 2,
      dimension: 'controlledBytes',
      observed: 4,
      allowed: 3,
      finalFiles: 2,
      finalBytes: 4,
    },
  ];

  for (const testCase of cases) {
    const observed = [];
    const accumulator = createCapacityAccumulator(
      limits(testCase.overrides),
      (snapshot) => observed.push(snapshot),
    );
    accumulator.recordFileMetadata({ kind: 'json', byteSize: testCase.firstBytes });
    assert.throws(
      () => accumulator.recordFileMetadata({ kind: 'json', byteSize: testCase.secondBytes }),
      (error) => JSON.stringify(error?.details) === JSON.stringify({
        dimension: testCase.dimension,
        observed: testCase.observed,
        allowed: testCase.allowed,
      }),
    );
    const terminal = accumulator.snapshot();
    const observerCalls = observed.length;
    assert.equal(terminal.measurements.controlledFiles, testCase.finalFiles);
    assert.equal(terminal.measurements.controlledBytes, testCase.finalBytes);
    for (const mutate of [
      () => accumulator.recordDirectoryEntry({ chapterDirectory: true }),
      () => accumulator.recordIdentityProbe(),
      () => accumulator.recordContentOpen(),
      () => accumulator.recordContentBytes(1),
      () => accumulator.recordFileMetadata({ kind: 'json', byteSize: 1 }),
    ]) {
      assert.throws(mutate, (error) => error === terminal.error);
    }
    assert.deepEqual(accumulator.snapshot(), terminal);
    assert.equal(observed.length, observerCalls);
  }
});

test('successful streaming records expose exact read-only operational counters', () => {
  const accumulator = createCapacityAccumulator(limits());

  accumulator.recordDirectoryEntry({ chapterDirectory: false });
  accumulator.recordDirectoryEntry({ chapterDirectory: true });
  accumulator.recordIdentityProbe();
  accumulator.recordFileMetadata({ kind: 'markdown', byteSize: 6 });
  accumulator.recordContentOpen();
  accumulator.recordContentBytes(2);
  accumulator.recordContentBytes(4);

  assert.deepEqual(accumulator.snapshot().counters, {
    directoryEntries: 2,
    identityProbes: 1,
    contentOpens: 1,
    contentBytes: 6,
  });
});
