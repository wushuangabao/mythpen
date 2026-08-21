import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  WINDOWS_PRODUCTION_BUILD_RECEIPT_TYPE,
  WINDOWS_L1_NATIVE_BENCHMARK_RESULT_TYPE,
  WINDOWS_L1_PRODUCTION_E2E_RESULT_TYPE,
  WINDOWS_L2_PRODUCTION_E2E_RESULT_TYPE,
  WINDOWS_L2_REVIEWED_MANIFEST_TYPE,
  canonicalJsonBytes,
  publishCanonicalJsonNoReplace,
  publishFileCli,
  validateProductionBuildReceipt,
  validateL1ProductionE2eResult,
  validateL1NativeBenchmarkResult,
  validateL2ReviewedManifest,
} from '../production-evidence-publisher.js'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const artifact = (name) => ({ path: `C:\\evidence\\${name}`, sha256: 'a'.repeat(64) })

test('canonical JSON publication is stable create-new and flushes file then parent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-publisher-'))
  const outputPath = path.join(root, 'result.json')
  const calls = []
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))

  const expected = Buffer.from('{\n  "a": {\n    "x": 2,\n    "z": 1\n  },\n  "b": 1\n}\n')
  assert.deepEqual(canonicalJsonBytes({ b: 1, a: { z: 1, x: 2 } }), expected)
  const receipt = publishCanonicalJsonNoReplace({
    outputPath,
    value: { b: 1, a: { z: 1, x: 2 } },
  }, {
    fsyncDirectory(directory) { calls.push(['directory', directory]) },
    fsyncFile(file) { calls.push(['file', file]) },
  })

  assert.deepEqual(fs.readFileSync(outputPath), expected)
  assert.equal(receipt.sha256, sha256(expected))
  assert.equal(receipt.bytes, expected.length)
  assert.equal(receipt.protocol, 'same-directory-createhardlinkw-v1')
  assert.deepEqual(calls.map(([kind]) => kind), ['file', 'directory'])
  assert.throws(
    () => publishCanonicalJsonNoReplace({ outputPath, value: { replacement: true } }, {
      fsyncDirectory() {},
      fsyncFile() {},
    }),
    /already exists/i,
  )
  assert.deepEqual(fs.readFileSync(outputPath), expected)
})

test('pre-publication failure cleans only its run-owned staging and leaves final absent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-publisher-failure-'))
  const outputPath = path.join(root, 'result.json')
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))

  assert.throws(
    () => publishCanonicalJsonNoReplace({ outputPath, value: { status: 'PASS' } }, {
      fsyncDirectory() {},
      fsyncFile() {},
      link() { throw new Error('injected hard-link failure') },
    }),
    /hard link failed/i,
  )
  assert.equal(fs.existsSync(outputPath), false)
  assert.deepEqual(fs.readdirSync(root), [])
})

test('publish-file CLI accepts only a run-owned sibling and preserves create-new identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-publisher-file-'))
  const stagingPath = path.join(root, '.candidate.exe.0123456789abcdef0123456789abcdef.staging')
  const outputPath = path.join(root, 'candidate.exe')
  const bytes = Buffer.from('production-candidate')
  fs.writeFileSync(stagingPath, bytes, { flag: 'wx' })
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))

  const receipt = publishFileCli([
    'publish-file', '--staging', stagingPath, '--output', outputPath, '--sha256', sha256(bytes),
  ], {
    platform: 'win32',
    bunVersion: '1.3.14',
    publication: { fsyncDirectory() {}, fsyncFile() {} },
  })

  assert.deepEqual(fs.readFileSync(outputPath), bytes)
  assert.equal(fs.existsSync(stagingPath), false)
  assert.equal(receipt.sha256, sha256(bytes))
  assert.throws(
    () => publishFileCli([
      'publish-file', '--staging', stagingPath, '--output', outputPath, '--sha256', sha256(bytes),
    ], {
      platform: 'win32',
      bunVersion: '1.3.14',
      publication: { fsyncDirectory() {}, fsyncFile() {} },
    }),
    /already exists/i,
  )
})

test('production build receipt validator binds manifests candidate and compiled smoke exactly', () => {
  const sourceCommit = 'b'.repeat(40)
  const targetTriple = 'x86_64-pc-windows-msvc'
  const l1Manifest = artifact('l1-manifest.json')
  const l2Manifest = artifact('l2-manifest.json')
  const candidate = {
    ...artifact('candidate.exe'),
    bytes: 123,
    identity: { dev: '7', ino: '11' },
  }
  const receipt = {
    version: 1,
    type: WINDOWS_PRODUCTION_BUILD_RECEIPT_TYPE,
    sourceCommit,
    targetTriple,
    l1Manifest,
    l2Manifest,
    candidate,
    compiledSmoke: { nativeActivationMode: 'production', sourceCommit, targetTriple },
    protocol: 'same-directory-createhardlinkw-v1',
    stagingCleanup: 'complete',
    parentFlush: 'complete',
  }
  const facts = new Map([
    [l1Manifest.path, { bytes: 10, sha256: l1Manifest.sha256, identity: { dev: '7', ino: '1' }, links: 1 }],
    [l2Manifest.path, { bytes: 20, sha256: l2Manifest.sha256, identity: { dev: '7', ino: '2' }, links: 1 }],
    [candidate.path, { ...candidate, links: 1 }],
  ])
  const manifests = new Map([
    [l1Manifest.path, { sourceCommit, targetTriple }],
    [l2Manifest.path, { sourceCommit, targetTriple }],
  ])
  const dependencies = {
    inspectFile: (filePath) => facts.get(filePath),
    readJson: (filePath) => manifests.get(filePath),
    validateL1Manifest: (value) => value,
    validateL2Manifest: (value) => value,
  }

  assert.equal(validateProductionBuildReceipt(receipt, dependencies), receipt)
  assert.throws(
    () => validateProductionBuildReceipt({
      ...receipt,
      candidate: { ...candidate, sha256: 'c'.repeat(64) },
    }, dependencies),
    /inexact|incomplete/i,
  )
  assert.throws(
    () => validateProductionBuildReceipt({
      ...receipt,
      compiledSmoke: { ...receipt.compiledSmoke, sourceCommit: 'c'.repeat(40) },
    }, dependencies),
    /inexact|incomplete/i,
  )
})

test('L1 E2E validator requires exact bound PASS cases without skips', () => {
  const cases = [
    'missing-manifest-zero-mutation',
    'activate-and-retain-two-restarts',
    'off-sidecar-zero-mutation',
    'profile-mismatch-zero-mutation',
  ].map((id) => ({ id, status: 'PASS' }))
  const result = {
    version: 1,
    type: WINDOWS_L1_PRODUCTION_E2E_RESULT_TYPE,
    status: 'PASS',
    sourceCommit: 'b'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
    reviewedManifest: artifact('l1-manifest.json'),
    buildReceipt: artifact('build.json'),
    candidate: { ...artifact('candidate.exe'), bytes: 123 },
    suite: { total: 4, passed: 4, failed: 0, skipped: 0 },
    cases,
  }
  assert.equal(validateL1ProductionE2eResult(result), result)
  assert.throws(() => validateL1ProductionE2eResult({
    ...result,
    suite: { total: 4, passed: 3, failed: 0, skipped: 1 },
  }), /inexact|incomplete/i)
})

test('L2 reviewed manifest validator binds all three recomputed raw matrix aggregates', () => {
  const rawEvidence = 'C:\\evidence\\windows-l2-raw-source'
  const matrix = (caseCount, aggregateSha256) => ({
    caseCount,
    passed: caseCount,
    failed: 0,
    aggregateSha256,
  })
  const manifest = {
    version: 1,
    type: WINDOWS_L2_REVIEWED_MANIFEST_TYPE,
    status: 'PASS',
    sourceCommit: 'c'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
    rawEvidence: { path: rawEvidence, treeSha256: 'd'.repeat(64) },
    matrices: {
      correctness: matrix(8, '1'.repeat(64)),
      twoProcess: matrix(8, '2'.repeat(64)),
      capacity: matrix(7, '3'.repeat(64)),
    },
  }
  const facts = {
    path: rawEvidence,
    sourceCommit: 'c'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
    treeSha256: 'd'.repeat(64),
    matrices: {
      correctness: { caseCount: 8, aggregateSha256: '1'.repeat(64) },
      twoProcess: { caseCount: 8, aggregateSha256: '2'.repeat(64) },
      capacity: { caseCount: 7, aggregateSha256: '3'.repeat(64) },
    },
  }
  assert.equal(validateL2ReviewedManifest(manifest, { inspectRawEvidence: () => facts }), manifest)
  assert.throws(
    () => validateL2ReviewedManifest(manifest, {
      inspectRawEvidence: () => ({ ...facts, treeSha256: 'e'.repeat(64) }),
    }),
    /inexact|incomplete/i,
  )
})

test('L1 native benchmark validator recomputes samples, eight segments, and hard thresholds', () => {
  const sampleMap = (value) => Object.fromEntries([
    'queueLeaseWait',
    'manuscriptSourceAppend',
    'preparedAppend',
    'beginAndPreflight',
    'dmlSequenceAndGate',
    'sqliteCommit',
    'terminalAppendAndPostcheck',
    'apiClientRemainder',
  ].map((segment) => [segment, Array(20).fill(value)]))
  const cohort = (terminalEventCount) => ({
    terminalEventCount,
    warmupCount: 2,
    measurementCount: 20,
    samplesMs: {
      nativeTransaction: Array(20).fill(100),
      saveE2e: Array(20).fill(200),
    },
    p50Ms: { nativeTransaction: 100, saveE2e: 200 },
    p95Ms: { nativeTransaction: 100, saveE2e: 200 },
    maxMs: { nativeTransaction: 100, saveE2e: 200 },
    segmentsMs: sampleMap(25),
  })
  const result = {
    version: 1,
    type: WINDOWS_L1_NATIVE_BENCHMARK_RESULT_TYPE,
    status: 'PASS',
    sourceCommit: 'b'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
    reviewedManifest: artifact('l1-manifest.json'),
    buildReceipt: artifact('build.json'),
    candidate: { ...artifact('candidate.exe'), bytes: 123 },
    fixture: { chapterCount: 3000, charactersPerChapter: 3400 },
    cohorts: [cohort(0), cohort(10_000), cohort(100_000)],
    thresholds: { nativeTransactionP95Ms: 500, saveE2eP95Ms: 300 },
  }
  assert.equal(validateL1NativeBenchmarkResult(result), result)
  const slow = structuredClone(result)
  slow.cohorts[2].samplesMs.saveE2e.fill(300)
  slow.cohorts[2].p50Ms.saveE2e = 300
  slow.cohorts[2].p95Ms.saveE2e = 300
  slow.cohorts[2].maxMs.saveE2e = 300
  for (const samples of Object.values(slow.cohorts[2].segmentsMs)) samples.fill(37.5)
  assert.throws(() => validateL1NativeBenchmarkResult(slow), /inexact|incomplete/i)
})

test('publisher exports the frozen L1 and L2 result type names', () => {
  assert.equal(WINDOWS_L1_NATIVE_BENCHMARK_RESULT_TYPE, 'mythpen.windows-l1-native-benchmark-result.v1')
  assert.equal(WINDOWS_L2_PRODUCTION_E2E_RESULT_TYPE, 'mythpen.windows-l2-production-e2e-result.v1')
})
