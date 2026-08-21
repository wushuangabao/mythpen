'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { after } = test;

const { createCapacityAccumulator } = require('../manuscript/capacity');
const { LIMITS } = require('../manuscript/contracts');
const {
  createPassedCase,
  writeL2RawMatrixFromEnvironment,
} = require('./fixtures/l2-raw-evidence');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const passedCases = new Map();

const L2_CAPACITY_CASE_IDS = Object.freeze([
  'chapter_identities_10000',
  'volume_identities_2000',
  'controlled_files_25000',
  'chapter_directory_entries_20000',
  'single_markdown_16mib',
  'single_json_256kib',
  'controlled_bytes_1gib',
]);

function expectOverflow(action, dimension, observed, allowed) {
  let captured;
  assert.throws(action, (error) => {
    captured = error;
    return error?.code === 'MANUSCRIPT_CONTENT_TOO_LARGE'
      && JSON.stringify(error.details) === JSON.stringify({ dimension, observed, allowed });
  });
  return captured;
}

function assertLatched(accumulator, error) {
  const terminal = accumulator.snapshot();
  assert.equal(terminal.state, 'exceeded');
  assert.equal(terminal.error, error);
  for (const action of [
    () => accumulator.recordIdentity({ kind: 'chapter', uid: 'later', source: 'active' }),
    () => accumulator.recordDirectoryEntry({ chapterDirectory: true }),
    () => accumulator.recordIdentityProbe(),
    () => accumulator.recordContentOpen(),
    () => accumulator.recordContentBytes(1),
    () => accumulator.recordFileMetadata({ kind: 'json', byteSize: 0 }),
  ]) {
    assert.throws(action, (next) => next === error);
  }
  const repeated = accumulator.snapshot();
  assert.equal(repeated.error, error);
  assert.deepEqual(repeated, terminal);
}

function recordPassedCase(id, evidence) {
  assert.equal(passedCases.has(id), false, `duplicate capacity evidence case ${id}`);
  passedCases.set(id, createPassedCase(id, evidence));
}

function capacityEvidence(accumulator, error) {
  const snapshot = accumulator.snapshot();
  return {
    state: snapshot.state,
    measurements: snapshot.measurements,
    counters: snapshot.counters,
    error: { code: error.code, details: error.details },
  };
}

test('L2 capacity matrix freezes every normative dimension and its exact limit', () => {
  assert.deepEqual(L2_CAPACITY_CASE_IDS, [
    'chapter_identities_10000',
    'volume_identities_2000',
    'controlled_files_25000',
    'chapter_directory_entries_20000',
    'single_markdown_16mib',
    'single_json_256kib',
    'controlled_bytes_1gib',
  ]);
  assert.deepEqual(LIMITS, {
    chapterIdentities: 10_000,
    volumeIdentities: 2_000,
    markdownBytes: 16 * 1024 * 1024,
    jsonBytes: 256 * 1024,
    controlledFiles: 25_000,
    chapterDirectoryEntries: 20_000,
    controlledBytes: 1024 * 1024 * 1024,
  });
});

for (const testCase of [
  { caseId: 'chapter_identities_10000', kind: 'chapter', dimension: 'chapterIdentities' },
  { caseId: 'volume_identities_2000', kind: 'volume', dimension: 'volumeIdentities' },
]) {
  test(`${testCase.caseId} accepts the boundary and latches the first excess identity`, () => {
    const accumulator = createCapacityAccumulator(LIMITS);
    const allowed = LIMITS[testCase.dimension];
    for (let index = 0; index < allowed; index += 1) {
      accumulator.recordIdentity({
        kind: testCase.kind,
        uid: `${testCase.kind}-${index}`,
        source: index % 2 === 0 ? 'active' : 'tombstone',
      });
    }
    assert.equal(accumulator.snapshot().measurements[testCase.dimension], allowed);
    const error = expectOverflow(
      () => accumulator.recordIdentity({
        kind: testCase.kind,
        uid: `${testCase.kind}-overflow`,
        source: 'ignored_revoked',
      }),
      testCase.dimension,
      allowed + 1,
      allowed,
    );
    assertLatched(accumulator, error);
    recordPassedCase(testCase.caseId, capacityEvidence(accumulator, error));
  });
}

test('controlled_files_25000 stops before any later probe or content open', () => {
  const accumulator = createCapacityAccumulator(LIMITS);
  for (let index = 0; index < LIMITS.controlledFiles; index += 1) {
    accumulator.recordFileMetadata({ kind: 'json', byteSize: 0 });
  }
  const before = accumulator.snapshot();
  assert.equal(before.measurements.controlledFiles, LIMITS.controlledFiles);
  assert.equal(before.counters.identityProbes, 0);
  assert.equal(before.counters.contentOpens, 0);
  const error = expectOverflow(
    () => accumulator.recordFileMetadata({ kind: 'json', byteSize: 0 }),
    'controlledFiles',
    LIMITS.controlledFiles + 1,
    LIMITS.controlledFiles,
  );
  assertLatched(accumulator, error);
  recordPassedCase('controlled_files_25000', capacityEvidence(accumulator, error));
});

test('chapter_directory_entries_20000 stops on the first extra enumeration result', () => {
  const accumulator = createCapacityAccumulator(LIMITS);
  for (let index = 0; index < LIMITS.chapterDirectoryEntries; index += 1) {
    accumulator.recordDirectoryEntry({ chapterDirectory: true });
  }
  const error = expectOverflow(
    () => accumulator.recordDirectoryEntry({ chapterDirectory: true }),
    'chapterDirectoryEntries',
    LIMITS.chapterDirectoryEntries + 1,
    LIMITS.chapterDirectoryEntries,
  );
  assert.equal(accumulator.snapshot().counters.directoryEntries, LIMITS.chapterDirectoryEntries + 1);
  assertLatched(accumulator, error);
  recordPassedCase('chapter_directory_entries_20000', capacityEvidence(accumulator, error));
});

for (const testCase of [
  { caseId: 'single_markdown_16mib', kind: 'markdown', dimension: 'markdownBytes' },
  { caseId: 'single_json_256kib', kind: 'json', dimension: 'jsonBytes' },
]) {
  test(`${testCase.caseId} rejects oversized metadata with zero content bytes opened`, () => {
    const allowed = LIMITS[testCase.dimension];
    const boundary = createCapacityAccumulator(LIMITS);
    boundary.recordIdentityProbe();
    boundary.recordFileMetadata({ kind: testCase.kind, byteSize: allowed });
    assert.equal(boundary.snapshot().measurements[testCase.dimension], allowed);

    const overflow = createCapacityAccumulator(LIMITS);
    overflow.recordIdentityProbe();
    const error = expectOverflow(
      () => overflow.recordFileMetadata({ kind: testCase.kind, byteSize: allowed + 1 }),
      testCase.dimension,
      allowed + 1,
      allowed,
    );
    assert.equal(overflow.snapshot().counters.contentOpens, 0);
    assert.equal(overflow.snapshot().counters.contentBytes, 0);
    assertLatched(overflow, error);
    recordPassedCase(testCase.caseId, capacityEvidence(overflow, error));
  });
}

test('controlled_bytes_1gib is measured arithmetically without allocating body buffers', () => {
  const accumulator = createCapacityAccumulator(LIMITS);
  const chunk = LIMITS.markdownBytes;
  const count = LIMITS.controlledBytes / chunk;
  assert.equal(Number.isSafeInteger(count), true);
  for (let index = 0; index < count; index += 1) {
    accumulator.recordFileMetadata({ kind: 'markdown', byteSize: chunk });
  }
  assert.equal(accumulator.snapshot().measurements.controlledBytes, LIMITS.controlledBytes);
  const error = expectOverflow(
    () => accumulator.recordFileMetadata({ kind: 'json', byteSize: 1 }),
    'controlledBytes',
    LIMITS.controlledBytes + 1,
    LIMITS.controlledBytes,
  );
  assertLatched(accumulator, error);
  recordPassedCase('controlled_bytes_1gib', capacityEvidence(accumulator, error));
});

after(() => {
  if (!String(process.env.MYTHPEN_L2_EVIDENCE_OUTPUT || '').trim()) return;
  assert.deepEqual([...passedCases.keys()].sort(), [...L2_CAPACITY_CASE_IDS].sort());
  const cases = L2_CAPACITY_CASE_IDS.map((id) => passedCases.get(id));
  writeL2RawMatrixFromEnvironment({ cases, matrix: 'capacity', repositoryRoot });
});

module.exports = { L2_CAPACITY_CASE_IDS };
