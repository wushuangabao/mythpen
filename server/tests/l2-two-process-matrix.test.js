'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  createPassedCase,
  writeL2RawMatrixFromEnvironment,
} = require('./fixtures/l2-raw-evidence');

const repositoryRoot = path.resolve(__dirname, '..', '..');

const L2_TWO_PROCESS_CASES = Object.freeze([
  Object.freeze({
    id: 'shared_lifecycle_cross_process',
    file: 'windows-manuscript-lifecycle-lease.test.js',
    pattern: 'shared leases coexist across processes',
  }),
  Object.freeze({
    id: 'exclusive_lifecycle_contention',
    file: 'windows-manuscript-lifecycle-lease.test.js',
    pattern: 'contention maps all exclusive combinations',
  }),
  Object.freeze({
    id: 'owner_death_releases_lifecycle',
    file: 'windows-manuscript-lifecycle-lease.test.js',
    pattern: 'owner death releases the kernel range lock',
  }),
  Object.freeze({
    id: 'direct_feed_second_process',
    file: 'windows-manuscript-change-feed.test.js',
    pattern: 'observes writes from a second process',
  }),
  Object.freeze({
    id: 'concurrent_first_open_single_handle',
    file: 'manuscript-session-controller.test.js',
    pattern: 'concurrent first-open reserves one physical-key entry',
  }),
  Object.freeze({
    id: 'retirement_drains_admissions',
    file: 'manuscript-session-controller.test.js',
    pattern: 'retiring one project fences new opens and admits',
  }),
  Object.freeze({
    id: 'refresh_claim_settles_original',
    file: 'manuscript-freshness.test.js',
    pattern: 'gives ports only claimSnapshot, and settles the original claim',
  }),
  Object.freeze({
    id: 'live_feed_failure_false_clean_fence',
    file: 'manuscript-freshness.test.js',
    pattern: 'live feed failure latches loss',
  }),
]);

test('L2 two-process matrix freezes the lifecycle feed session retirement and refresh cases', () => {
  assert.deepEqual(L2_TWO_PROCESS_CASES.map((entry) => entry.id), [
    'shared_lifecycle_cross_process',
    'exclusive_lifecycle_contention',
    'owner_death_releases_lifecycle',
    'direct_feed_second_process',
    'concurrent_first_open_single_handle',
    'retirement_drains_admissions',
    'refresh_claim_settles_original',
    'live_feed_failure_false_clean_fence',
  ]);
  assert.equal(Object.isFrozen(L2_TWO_PROCESS_CASES), true);
  assert.equal(L2_TWO_PROCESS_CASES.every(Object.isFrozen), true);
  assert.equal(new Set(L2_TWO_PROCESS_CASES.map((entry) => entry.id)).size, 8);
});

test('L2 two-process matrix runs every case in its own child and never overlaps cases', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
  timeout: 240_000,
}, () => {
  assert.ok(process.versions.bun, 'L2 two-process matrix must run under the pinned Bun runtime');
  const cases = [];
  for (const entry of L2_TWO_PROCESS_CASES) {
    const result = spawnSync(process.execPath, [
      'test',
      '--timeout',
      '30000',
      '--test-name-pattern',
      entry.pattern,
      path.join(__dirname, entry.file),
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MYTHPEN_L2_TWO_PROCESS_CASE: entry.id,
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 45_000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(
      result.status,
      0,
      `L2 two-process case ${entry.id} failed\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`,
    );
    assert.match(result.stderr, /\(pass\)/u, `L2 two-process case ${entry.id} did not execute a test`);
    cases.push(createPassedCase(entry.id, {
      file: entry.file,
      pattern: entry.pattern,
      exitCode: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    }));
    process.stdout.write(`MYTHPEN_L2_TWO_PROCESS_CASE ${JSON.stringify({
      id: entry.id,
      status: 'PASS',
    })}\n`);
  }
  writeL2RawMatrixFromEnvironment({ cases, matrix: 'twoProcess', repositoryRoot });
});

module.exports = { L2_TWO_PROCESS_CASES };
