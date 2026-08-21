'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FIXED_L2_BENCHMARK_PROFILES,
  L2_PERFORMANCE_CASE_IDS,
  describeL2BenchmarkProfile,
  materializeL2BenchmarkProbe,
  verifyL2BenchmarkProject,
} = require('./fixtures/create-l2-benchmark-project');

test('L2 performance harness freezes the two non-shrinkable profiles and fixed case set', () => {
  assert.deepEqual(Object.keys(FIXED_L2_BENCHMARK_PROFILES), [
    'chapters-3000',
    'chapters-10000-1gib',
  ]);
  assert.deepEqual(L2_PERFORMANCE_CASE_IDS, [
    'sidebar_3000',
    'autosave_3000',
    'startup_full_3000',
    'explicit_full_3000',
    'sidebar_10000',
    'autosave_10000',
    'startup_full_10000',
    'explicit_full_10000',
  ]);

  const small = describeL2BenchmarkProfile('chapters-3000');
  const large = describeL2BenchmarkProfile('chapters-10000-1gib');
  assert.equal(small.chapterCount, 3_000);
  assert.equal(small.volumeCount, 300);
  assert.ok(small.targetControlledBytes >= 30 * 1024 * 1024);
  assert.ok(small.targetControlledBytes <= 40 * 1024 * 1024);
  assert.equal(large.chapterCount, 10_000);
  assert.equal(large.volumeCount, 2_000);
  assert.equal(large.targetControlledBytes, 1024 ** 3);
  assert.equal(large.controlledFileCount, 22_002);
  assert.equal(large.chapterDirectoryEntries, 20_000);

  for (const description of [small, large]) {
    assert.equal(description.maxWorkingBufferBytes, 64 * 1024);
    assert.match(description.planSha256, /^[0-9a-f]{64}$/u);
    assert.equal(Object.isFrozen(description), true);
    assert.deepEqual(describeL2BenchmarkProfile(description.profile), description);
  }
});

test('benchmark fixture source forbids whole-project clone and deep equality paths', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'create-l2-benchmark-project.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /structuredClone|JSON\.parse\(JSON\.stringify|deepStrictEqual/u);
  assert.match(source, /MAX_WORKING_BUFFER_BYTES = 64 \* 1024/u);
  assert.match(source, /createHash\('sha256'\)/u);
});

test('streaming probe materializes and verifies exact bytes within the fixed buffer budget', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-l2-benchmark-probe-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const projectRoot = path.join(parent, 'fixture');
  const result = materializeL2BenchmarkProbe({ projectRoot });

  assert.equal(result.formalProfile, false);
  assert.equal(result.chapterCount, 4);
  assert.equal(result.volumeCount, 2);
  assert.equal(result.controlledFileCount, 12);
  assert.equal(result.targetControlledBytes, 1024 * 1024);
  assert.ok(result.maxObservedBufferBytes <= 64 * 1024);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(verifyL2BenchmarkProject({ projectRoot, expected: result }), result);
});
