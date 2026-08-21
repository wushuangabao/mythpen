'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MATRIX_FILES = Object.freeze({
  correctness: 'l2-correctness.json',
  twoProcess: 'l2-two-process.json',
  capacity: 'l2-capacity.json',
});
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Raw evidence rejects non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
  if (!isPlainObject(value) || seen.has(value)) {
    throw new TypeError('Raw evidence requires acyclic plain data');
  }
  seen.add(value);
  const sorted = Object.keys(value).sort((left, right) => (
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  ));
  const result = {};
  for (const key of sorted) result[key] = canonicalValue(value[key], seen);
  seen.delete(value);
  return result;
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, 'utf8');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createPassedCase(id, evidence) {
  if (typeof id !== 'string' || !/^[a-z0-9_\-]+$/.test(id)) {
    throw new TypeError('L2 raw evidence case id is invalid');
  }
  return Object.freeze({
    id,
    status: 'PASS',
    evidenceSha256: sha256(canonicalJsonBytes(evidence)),
  });
}

function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('L2 raw evidence cases are required');
  const seen = new Set();
  for (const entry of cases) {
    if (
      !isPlainObject(entry)
      || Object.keys(entry).sort().join(',') !== 'evidenceSha256,id,status'
      || typeof entry.id !== 'string'
      || entry.status !== 'PASS'
      || !HASH_PATTERN.test(entry.evidenceSha256 || '')
      || seen.has(entry.id)
    ) throw new TypeError('L2 raw evidence case is invalid or duplicate');
    seen.add(entry.id);
  }
}

function writeL2RawMatrix({ cases, matrix, outputDirectory, sourceCommit, targetTriple }) {
  if (!Object.hasOwn(MATRIX_FILES, matrix)) throw new TypeError('L2 raw evidence matrix is invalid');
  if (
    typeof outputDirectory !== 'string'
    || !path.isAbsolute(outputDirectory)
    || path.resolve(outputDirectory) !== outputDirectory
  ) throw new TypeError('L2 raw evidence output directory must be an absolute normalized path');
  const stats = fs.lstatSync(outputDirectory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new TypeError('L2 raw evidence output must be a plain directory');
  }
  if (!COMMIT_PATTERN.test(sourceCommit || '') || targetTriple !== 'x86_64-pc-windows-msvc') {
    throw new TypeError('L2 raw evidence build binding is invalid');
  }
  validateCases(cases);
  const value = Object.freeze({
    version: 1,
    type: 'mythpen.windows-l2-raw-matrix.v1',
    matrix,
    sourceCommit,
    targetTriple,
    aggregateSha256: sha256(canonicalJsonBytes(cases)),
    cases: Object.freeze(cases.map((entry) => Object.freeze({ ...entry }))),
  });
  const outputPath = path.join(outputDirectory, MATRIX_FILES[matrix]);
  if (fs.existsSync(outputPath)) throw new Error(`L2 raw evidence output already exists: ${outputPath}`);
  fs.writeFileSync(outputPath, canonicalJsonBytes(value), { encoding: null, flag: 'wx', mode: 0o600 });
  return Object.freeze({ outputPath, value });
}

function currentSourceCommit(repositoryRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !COMMIT_PATTERN.test(result.stdout.trim())) {
    throw new Error('Unable to bind L2 raw evidence to the current source commit');
  }
  return result.stdout.trim();
}

function writeL2RawMatrixFromEnvironment({ cases, matrix, repositoryRoot }) {
  const outputDirectory = String(process.env.MYTHPEN_L2_EVIDENCE_OUTPUT || '').trim();
  if (!outputDirectory) return null;
  return writeL2RawMatrix({
    cases,
    matrix,
    outputDirectory,
    sourceCommit: currentSourceCommit(repositoryRoot),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
}

module.exports = {
  MATRIX_FILES,
  canonicalJsonBytes,
  createPassedCase,
  writeL2RawMatrix,
  writeL2RawMatrixFromEnvironment,
};
