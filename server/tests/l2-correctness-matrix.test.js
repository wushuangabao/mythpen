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

const L2_CORRECTNESS_CASE_IDS = Object.freeze([
  'format_and_path_authority',
  'ignored_and_orphan_exits',
  'schema12_and_projection_atomicity',
  'publication_crash_convergence',
  'draft_conflict_crash_convergence',
  'migration_crash_convergence',
  'creation_crash_convergence',
  'product_authority_routing',
]);

const L2_CORRECTNESS_GROUPS = Object.freeze([
  Object.freeze({
    id: 'format_and_orphans',
    files: Object.freeze([
      'manuscript-paths.test.js',
      'manuscript-format.test.js',
      'manuscript-store.test.js',
      'manuscript-ignored-ledger.test.js',
      'manuscript-orphan-resolution.test.js',
    ]),
  }),
  Object.freeze({
    id: 'schema_and_projection',
    files: Object.freeze([
      'manuscript-schema-12.test.js',
      'manuscript-projection-store.test.js',
      'native-project-store-full-refresh.test.js',
    ]),
  }),
  Object.freeze({
    id: 'crash_protocols',
    files: Object.freeze([
      'file-publication-crash.test.js',
      'draft-conflict-crash.test.js',
      'manuscript-migration-crash.test.js',
      'project-creation-crash.test.js',
    ]),
  }),
  Object.freeze({
    id: 'product_authority',
    files: Object.freeze([
      'manuscript-runtime.test.js',
      'manuscript-product-gates.test.js',
      'manuscript-product-routing.test.js',
      'active-manuscript-projection.test.js',
    ]),
  }),
]);

const L2_CORRECTNESS_CASE_FILES = Object.freeze({
  format_and_path_authority: Object.freeze([
    'manuscript-paths.test.js',
    'manuscript-format.test.js',
    'manuscript-store.test.js',
  ]),
  ignored_and_orphan_exits: Object.freeze([
    'manuscript-ignored-ledger.test.js',
    'manuscript-orphan-resolution.test.js',
  ]),
  schema12_and_projection_atomicity: Object.freeze([
    'manuscript-schema-12.test.js',
    'manuscript-projection-store.test.js',
    'native-project-store-full-refresh.test.js',
  ]),
  publication_crash_convergence: Object.freeze(['file-publication-crash.test.js']),
  draft_conflict_crash_convergence: Object.freeze(['draft-conflict-crash.test.js']),
  migration_crash_convergence: Object.freeze(['manuscript-migration-crash.test.js']),
  creation_crash_convergence: Object.freeze(['project-creation-crash.test.js']),
  product_authority_routing: Object.freeze([
    'manuscript-runtime.test.js',
    'manuscript-product-gates.test.js',
    'manuscript-product-routing.test.js',
    'active-manuscript-projection.test.js',
  ]),
});

test('L2 correctness matrix freezes auditable case IDs and isolated sequential groups', () => {
  assert.deepEqual(L2_CORRECTNESS_CASE_IDS, [
    'format_and_path_authority',
    'ignored_and_orphan_exits',
    'schema12_and_projection_atomicity',
    'publication_crash_convergence',
    'draft_conflict_crash_convergence',
    'migration_crash_convergence',
    'creation_crash_convergence',
    'product_authority_routing',
  ]);
  assert.deepEqual(L2_CORRECTNESS_GROUPS.map((group) => group.id), [
    'format_and_orphans',
    'schema_and_projection',
    'crash_protocols',
    'product_authority',
  ]);
  const joined = L2_CORRECTNESS_GROUPS.flatMap((group) => group.files);
  assert.equal(new Set(joined).size, joined.length);
  assert.equal(Object.isFrozen(L2_CORRECTNESS_GROUPS), true);
  assert.equal(Object.isFrozen(L2_CORRECTNESS_GROUPS[0].files), true);
  assert.deepEqual(
    L2_CORRECTNESS_CASE_IDS.flatMap((id) => L2_CORRECTNESS_CASE_FILES[id]).sort(),
    [...joined].sort(),
  );
});

test('L2 correctness matrix executes every focused file in an isolated child sequentially', {
  timeout: 300_000,
}, () => {
  assert.ok(process.versions.bun, 'L2 correctness matrix must run under the pinned Bun runtime');
  const observations = new Map();
  for (const group of L2_CORRECTNESS_GROUPS) {
    for (const file of group.files) {
      const result = spawnSync(
        process.execPath,
        ['test', '--timeout', '120000', path.join(__dirname, file)],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            MYTHPEN_L2_CORRECTNESS_GROUP: group.id,
          },
          maxBuffer: 16 * 1024 * 1024,
          timeout: 180_000,
          windowsHide: true,
        },
      );
      assert.ifError(result.error);
      assert.equal(
        result.status,
        0,
        `L2 correctness file ${file} failed\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`,
      );
      observations.set(file, Object.freeze({
        exitCode: result.status,
        stderr: result.stderr,
        stdout: result.stdout,
      }));
    }
    process.stdout.write(`MYTHPEN_L2_CORRECTNESS_GROUP ${JSON.stringify({
      id: group.id,
      files: group.files,
      status: 'PASS',
    })}\n`);
  }
  const cases = L2_CORRECTNESS_CASE_IDS.map((id) => createPassedCase(id, {
    files: L2_CORRECTNESS_CASE_FILES[id].map((file) => ({ file, ...observations.get(file) })),
  }));
  writeL2RawMatrixFromEnvironment({ cases, matrix: 'correctness', repositoryRoot });
});

module.exports = {
  L2_CORRECTNESS_CASE_IDS,
  L2_CORRECTNESS_GROUPS,
  L2_CORRECTNESS_CASE_FILES,
};
