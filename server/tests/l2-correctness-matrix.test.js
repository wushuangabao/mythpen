'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

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
});

test('L2 correctness matrix executes every focused file in an isolated child sequentially', {
  timeout: 300_000,
}, () => {
  assert.ok(process.versions.bun, 'L2 correctness matrix must run under the pinned Bun runtime');
  for (const group of L2_CORRECTNESS_GROUPS) {
    for (const file of group.files) {
      const result = spawnSync(
        process.execPath,
        ['test', '--timeout', '120000', path.join(__dirname, file)],
        {
          cwd: path.resolve(__dirname, '..', '..'),
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
    }
    process.stdout.write(`MYTHPEN_L2_CORRECTNESS_GROUP ${JSON.stringify({
      id: group.id,
      files: group.files,
      status: 'PASS',
    })}\n`);
  }
});

module.exports = {
  L2_CORRECTNESS_CASE_IDS,
  L2_CORRECTNESS_GROUPS,
};
