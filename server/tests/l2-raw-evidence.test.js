'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  canonicalJsonBytes,
  createPassedCase,
  writeL2RawMatrix,
} = require('./fixtures/l2-raw-evidence');

test('L2 raw matrix evidence is canonical create-new and case-bound', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-l2-raw-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const cases = [
    createPassedCase('case-a', { child: 'alpha', exitCode: 0 }),
    createPassedCase('case-b', { child: 'beta', exitCode: 0 }),
  ];

  const result = writeL2RawMatrix({
    cases,
    matrix: 'correctness',
    outputDirectory: root,
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });

  assert.equal(result.outputPath, path.join(root, 'l2-correctness.json'));
  assert.deepEqual(result.value.cases, cases);
  assert.deepEqual(fs.readFileSync(result.outputPath), canonicalJsonBytes(result.value));
  assert.throws(() => writeL2RawMatrix({
    cases,
    matrix: 'correctness',
    outputDirectory: root,
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  }), /already exists/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.outputPath, 'utf8')), result.value);
});

test('L2 raw matrix writer rejects duplicate cases, relative outputs, and failing cases', () => {
  const valid = createPassedCase('case-a', { exitCode: 0 });
  assert.throws(() => writeL2RawMatrix({
    cases: [valid, valid],
    matrix: 'capacity',
    outputDirectory: 'relative',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  }), /absolute|duplicate/i);
  assert.throws(() => writeL2RawMatrix({
    cases: [{ ...valid, status: 'FAIL' }],
    matrix: 'capacity',
    outputDirectory: path.resolve('.'),
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  }), /case/i);
});
