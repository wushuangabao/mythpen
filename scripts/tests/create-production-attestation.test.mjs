import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  WINDOWS_L2_PRODUCTION_ATTESTATION_TYPE,
  validateL2ProductionAttestation,
} from '../production-evidence-publisher.js'
import {
  createProductionAttestation,
  parseProductionAttestationArguments,
} from '../create-production-attestation.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const reference = (name) => ({ path: `C:\\evidence\\${name}`, sha256: 'a'.repeat(64) })

function correctnessFixture() {
  const sourceCommit = 'b'.repeat(40)
  const targetTriple = 'x86_64-pc-windows-msvc'
  const l1Manifest = reference('l1.json')
  const l2Manifest = reference('l2.json')
  const buildReceipt = reference('receipt.json')
  const candidate = { ...reference('candidate.exe'), bytes: 123 }
  const results = {
    l1NativeBenchmark: reference('results\\l1-native-benchmark.json'),
    l2ProductionE2e: reference('results\\l2-e2e.json'),
    desktopManuscriptFiles: reference('results\\desktop-manuscript-files.json'),
  }
  const attestation = {
    version: 1,
    type: WINDOWS_L2_PRODUCTION_ATTESTATION_TYPE,
    profile: 'l2-correctness',
    status: 'PASS',
    sourceCommit,
    targetTriple,
    l1Manifest,
    l2Manifest,
    buildReceipt,
    candidate,
    results,
  }
  const documents = new Map([
    [l1Manifest.path, { sourceCommit, targetTriple }],
    [l2Manifest.path, { sourceCommit, targetTriple }],
    [buildReceipt.path, {
      sourceCommit,
      targetTriple,
      l1Manifest,
      l2Manifest,
      candidate: { ...candidate, identity: { dev: '7', ino: '11' } },
    }],
    [results.l1NativeBenchmark.path, {
      sourceCommit,
      targetTriple,
      reviewedManifest: l1Manifest,
      buildReceipt,
      candidate,
    }],
    [results.l2ProductionE2e.path, {
      sourceCommit,
      targetTriple,
      l1Manifest,
      l2Manifest,
      buildReceipt,
      candidate: { path: candidate.path, sha256: candidate.sha256 },
    }],
    [results.desktopManuscriptFiles.path, {
      version: 1,
      type: 'mythpen.desktop-l2-files-smoke.v1',
      status: 'PASS',
      sourceCommit,
      targetTriple,
      desktop: { path: 'C:\\evidence\\mythpen.exe', bytes: 321, sha256: 'd'.repeat(64) },
      sidecar: candidate,
      auth: { mode: 'debug-only-one-time-nonce-v1' },
      runId: '11111111-1111-4111-8111-111111111111',
      request: { path: 'C:\\evidence\\request.json', bytes: 42, sha256: 'e'.repeat(64) },
      suite: { total: 8, passed: 8, failed: 0 },
      cases: [
        'open_chapter_body', 'open_chapter_sidecar', 'open_volume_index', 'reveal_project',
        'unknown_uid_rejected', 'wrong_route_rejected', 'hard_link_rejected', 'reparse_alias_rejected',
      ].map((id) => ({
        id,
        status: 'PASS',
        launchCalls: id.endsWith('_rejected') ? 0 : 1,
        target: id.endsWith('_rejected') ? null : `C:\\evidence\\${id}.txt`,
        errorCode: id.endsWith('_rejected') ? 'REJECTED' : null,
      })),
    }],
  ])
  const facts = new Map([
    ...[l1Manifest, l2Manifest, buildReceipt, ...Object.values(results)].map((artifact) => [
      artifact.path,
      { bytes: 10, identity: { dev: '7', ino: artifact.path }, links: 1, sha256: artifact.sha256 },
    ]),
    [candidate.path, {
      bytes: candidate.bytes,
      identity: { dev: '7', ino: '11' },
      links: 1,
      sha256: candidate.sha256,
    }],
  ])
  return { attestation, documents, facts }
}

test('L2 correctness attestation validator binds every source artifact and result', () => {
  const { attestation, documents, facts } = correctnessFixture()
  const dependencies = {
    inspectFile: (filePath) => facts.get(filePath),
    readJson: (filePath) => documents.get(filePath),
    validateL1Manifest: (value) => value,
    validateL2Manifest: (value) => value,
    validateBuildReceipt: (value) => value,
    validateL1Benchmark: (value) => value,
    validateL2E2e: (value) => value,
  }

  assert.equal(validateL2ProductionAttestation(attestation, dependencies), attestation)
  assert.throws(() => validateL2ProductionAttestation({
    ...attestation,
    candidate: { ...attestation.candidate, sha256: 'c'.repeat(64) },
  }, dependencies), /inexact|incomplete/i)
  const mismatched = structuredClone(attestation)
  const changedDocuments = new Map(documents)
  changedDocuments.set(attestation.results.l2ProductionE2e.path, {
    ...documents.get(attestation.results.l2ProductionE2e.path),
    buildReceipt: reference('other-receipt.json'),
  })
  assert.throws(() => validateL2ProductionAttestation(mismatched, {
    ...dependencies,
    readJson: (filePath) => changedDocuments.get(filePath),
  }), /inexact|incomplete/i)
  const incompleteDesktop = new Map(documents)
  incompleteDesktop.set(attestation.results.desktopManuscriptFiles.path, {
    ...documents.get(attestation.results.desktopManuscriptFiles.path),
    cases: documents.get(attestation.results.desktopManuscriptFiles.path).cases.map(({ id, status }) => ({ id, status })),
  })
  assert.throws(() => validateL2ProductionAttestation(attestation, {
    ...dependencies,
    readJson: (filePath) => incompleteDesktop.get(filePath),
  }), /inexact|incomplete/i)
})

test('attestation CLI parser requires the exact l2-correctness input set', () => {
  const args = [
    '--profile', 'l2-correctness',
    '--source-commit', 'b'.repeat(40),
    '--l1-manifest', 'C:\\evidence\\l1.json',
    '--l2-manifest', 'C:\\evidence\\l2.json',
    '--build-receipt', 'C:\\evidence\\receipt.json',
    '--candidate', 'C:\\evidence\\candidate.exe',
    '--results', 'C:\\evidence\\results',
    '--output', 'C:\\evidence\\attestation.json',
  ]
  assert.deepEqual(parseProductionAttestationArguments(args), {
    profile: 'l2-correctness',
    sourceCommit: 'b'.repeat(40),
    l1ManifestPath: 'C:\\evidence\\l1.json',
    l2ManifestPath: 'C:\\evidence\\l2.json',
    buildReceiptPath: 'C:\\evidence\\receipt.json',
    candidatePath: 'C:\\evidence\\candidate.exe',
    resultsPath: 'C:\\evidence\\results',
    outputPath: 'C:\\evidence\\attestation.json',
  })
  assert.throws(() => parseProductionAttestationArguments(args.slice(0, -2)), /arguments/i)
})

test('attestation creator derives hashes from closed files and publishes once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-attestation-'))
  const resultsPath = path.join(root, 'results')
  fs.mkdirSync(resultsPath)
  t.after(() => fs.rmSync(root, { force: true, recursive: true }))
  const paths = {
    l1ManifestPath: path.join(root, 'l1.json'),
    l2ManifestPath: path.join(root, 'l2.json'),
    buildReceiptPath: path.join(root, 'receipt.json'),
    candidatePath: path.join(root, 'candidate.exe'),
    resultsPath,
    outputPath: path.join(root, 'attestation.json'),
  }
  for (const filePath of [
    paths.l1ManifestPath,
    paths.l2ManifestPath,
    paths.buildReceiptPath,
    paths.candidatePath,
    path.join(resultsPath, 'l1-native-benchmark.json'),
    path.join(resultsPath, 'l2-e2e.json'),
    path.join(resultsPath, 'desktop-manuscript-files.json'),
  ]) fs.writeFileSync(filePath, path.basename(filePath), { flag: 'wx' })
  let published = null

  const value = createProductionAttestation({
    profile: 'l2-correctness',
    sourceCommit: 'b'.repeat(40),
    ...paths,
  }, {
    runtime: { platform: 'win32', bunVersion: '1.3.14' },
    readJson(filePath) {
      if (filePath === paths.buildReceiptPath) {
        return { sourceCommit: 'b'.repeat(40), targetTriple: 'x86_64-pc-windows-msvc' }
      }
      return { sourceCommit: 'b'.repeat(40), targetTriple: 'x86_64-pc-windows-msvc' }
    },
    validateAttestation(attestation) { return attestation },
    publish(request) { published = request; return { sha256: 'f'.repeat(64) } },
  })

  assert.equal(published.outputPath, paths.outputPath)
  assert.equal(published.value, value)
  assert.equal(value.candidate.sha256, sha256(Buffer.from('candidate.exe')))
  assert.equal(value.results.l2ProductionE2e.sha256, sha256(Buffer.from('l2-e2e.json')))
  assert.equal(fs.existsSync(paths.outputPath), false)
})
