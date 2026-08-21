import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

export const WINDOWS_PRODUCTION_BUILD_RECEIPT_TYPE = 'mythpen.windows-production-build-receipt.v1'
export const WINDOWS_L1_PRODUCTION_ATTESTATION_TYPE = 'mythpen.windows-l1-production-attestation.v2'
export const WINDOWS_L1_PRODUCTION_E2E_RESULT_TYPE = 'mythpen.windows-l1-production-e2e-result.v1'
export const WINDOWS_L1_NATIVE_BENCHMARK_RESULT_TYPE = 'mythpen.windows-l1-native-benchmark-result.v1'
export const WINDOWS_L2_REVIEWED_MANIFEST_TYPE = 'mythpen.windows-l2-reviewed-manifest.v1'
export const WINDOWS_L2_PRODUCTION_E2E_RESULT_TYPE = 'mythpen.windows-l2-production-e2e-result.v1'
export const WINDOWS_L2_PERFORMANCE_RESULT_TYPE = 'mythpen.windows-l2-performance-result.v1'
export const WINDOWS_L2_PRODUCTION_ATTESTATION_TYPE = 'mythpen.windows-l2-production-attestation.v1'

const HASH_PATTERN = /^[0-9a-f]{64}$/
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const TARGET_PATTERN = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/
const TARGET_TRIPLE = 'x86_64-pc-windows-msvc'
const PUBLICATION_PROTOCOL = 'same-directory-createhardlinkw-v1'
const L1_E2E_CASE_IDS = Object.freeze([
  'missing-manifest-zero-mutation',
  'activate-and-retain-two-restarts',
  'off-sidecar-zero-mutation',
  'profile-mismatch-zero-mutation',
])
const L2_MATRIX_CASE_COUNTS = Object.freeze({ correctness: 8, twoProcess: 8, capacity: 7 })
const L2_RAW_FILES = Object.freeze({
  correctness: 'l2-correctness.json',
  twoProcess: 'l2-two-process.json',
  capacity: 'l2-capacity.json',
})
const L2_RAW_CASE_IDS = Object.freeze({
  correctness: Object.freeze([
    'format_and_path_authority',
    'ignored_and_orphan_exits',
    'schema12_and_projection_atomicity',
    'publication_crash_convergence',
    'draft_conflict_crash_convergence',
    'migration_crash_convergence',
    'creation_crash_convergence',
    'product_authority_routing',
  ]),
  twoProcess: Object.freeze([
    'shared_lifecycle_cross_process',
    'exclusive_lifecycle_contention',
    'owner_death_releases_lifecycle',
    'direct_feed_second_process',
    'concurrent_first_open_single_handle',
    'retirement_drains_admissions',
    'refresh_claim_settles_original',
    'live_feed_failure_false_clean_fence',
  ]),
  capacity: Object.freeze([
    'chapter_identities_10000',
    'volume_identities_2000',
    'controlled_files_25000',
    'chapter_directory_entries_20000',
    'single_markdown_16mib',
    'single_json_256kib',
    'controlled_bytes_1gib',
  ]),
})
const BENCHMARK_METRICS = Object.freeze(['nativeTransaction', 'saveE2e'])
const BENCHMARK_SEGMENTS = Object.freeze([
  'queueLeaseWait',
  'manuscriptSourceAppend',
  'preparedAppend',
  'beginAndPreflight',
  'dmlSequenceAndGate',
  'sqliteCommit',
  'terminalAppendAndPostcheck',
  'apiClientRemainder',
])
const SEGMENT_RECONCILIATION_TOLERANCE_MS = 2

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  return actual.length === required.length && actual.every((key, index) => key === required[index])
}

function invalid(label) {
  throw new Error(`${label} is inexact or incomplete`)
}

function utf8KeyCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
    return value
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen))
  if (!isPlainObject(value) || seen.has(value)) throw new TypeError('Canonical JSON requires an acyclic plain-data value')
  seen.add(value)
  const result = {}
  for (const key of Object.keys(value).sort(utf8KeyCompare)) {
    const entry = value[key]
    if (entry === undefined || typeof entry === 'bigint' || typeof entry === 'function' || typeof entry === 'symbol') {
      throw new TypeError('Canonical JSON rejects non-JSON values')
    }
    result[key] = canonicalValue(entry, seen)
  }
  seen.delete(value)
  return result
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, 'utf8')
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256File(filePath) {
  const hash = createHash('sha256')
  const handle = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

function fileFacts(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true })
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Publication path is not a plain file: ${filePath}`)
  return {
    bytes: Number(stats.size),
    identity: { dev: String(stats.dev), ino: String(stats.ino) },
    links: Number(stats.nlink),
    sha256: sha256File(filePath),
  }
}

function sameIdentity(left, right) {
  return left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino
}

function defaultDurability() {
  return require('../server/platform/durability')
}

function publicationDependencies(overrides = {}) {
  return {
    exists: fs.existsSync,
    facts: fileFacts,
    fsyncDirectory: (directory) => defaultDurability().fsyncDirectory(directory),
    fsyncFile: (file) => defaultDurability().fsyncFile(file),
    link: fs.linkSync,
    unlink: fs.unlinkSync,
    writeExclusive(file, bytes) {
      const handle = fs.openSync(file, 'wx', 0o600)
      try {
        fs.writeFileSync(handle, bytes)
      } finally {
        fs.closeSync(handle)
      }
    },
    randomId: () => randomUUID().replaceAll('-', ''),
    ...overrides,
  }
}

function exactAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`)
  }
  if (path.resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path`)
  return value
}

export function publishVerifiedFileNoReplace({ stagingPath, outputPath, expectedSha256 }, overrides = {}) {
  const dependencies = publicationDependencies(overrides)
  const staging = exactAbsolutePath(stagingPath, 'stagingPath')
  const output = exactAbsolutePath(outputPath, 'outputPath')
  if (path.dirname(staging) !== path.dirname(output) || staging === output) {
    throw new Error('Publication paths must be distinct siblings')
  }
  if (!/^\..+\.[0-9a-f]{32}\.staging$/u.test(path.basename(staging))) {
    throw new Error('Publication staging path is not run-owned')
  }
  if (!HASH_PATTERN.test(expectedSha256 || '')) throw new Error('expectedSha256 is invalid')
  if (dependencies.exists(output)) throw new Error(`Publication output already exists: ${output}`)

  let initial
  let linked = false
  try {
    initial = dependencies.facts(staging)
    if (initial.links !== 1 || initial.sha256 !== expectedSha256) {
      throw new Error('Publication staging identity or bytes are inexact')
    }
    dependencies.fsyncFile(staging)
    const flushed = dependencies.facts(staging)
    if (!sameIdentity(initial, flushed) || flushed.links !== 1 || flushed.sha256 !== expectedSha256) {
      throw new Error('Publication staging changed during durable flush')
    }
    dependencies.link(staging, output)
    linked = true
  } catch (cause) {
    const error = cause?.message?.includes('Publication staging')
      ? cause
      : new Error('Publication create-new hard link failed', { cause })
    if (!linked && initial) {
      try {
        const residual = dependencies.facts(staging)
        if (sameIdentity(initial, residual)) dependencies.unlink(staging)
      } catch (cleanupError) {
        error.stagingCleanupError = cleanupError
      }
    }
    throw error
  }

  const stagedAfterLink = dependencies.facts(staging)
  const finalAfterLink = dependencies.facts(output)
  if (
    !sameIdentity(initial, stagedAfterLink)
    || !sameIdentity(initial, finalAfterLink)
    || stagedAfterLink.links !== 2
    || finalAfterLink.links !== 2
    || finalAfterLink.sha256 !== expectedSha256
  ) {
    const error = new Error('Published hard-link identity is inexact')
    error.published = linked
    throw error
  }

  try {
    dependencies.unlink(staging)
  } catch (cause) {
    const error = new Error('Published staging cleanup is incomplete', { cause })
    error.published = true
    throw error
  }
  try {
    dependencies.fsyncDirectory(path.dirname(output))
  } catch (cause) {
    const error = new Error('Published parent flush is incomplete', { cause })
    error.published = true
    throw error
  }
  const final = dependencies.facts(output)
  if (!sameIdentity(initial, final) || final.links !== 1 || final.sha256 !== expectedSha256) {
    const error = new Error('Published final identity or bytes changed')
    error.published = true
    throw error
  }
  return Object.freeze({
    bytes: final.bytes,
    identity: Object.freeze({ ...final.identity }),
    parentFlush: 'complete',
    protocol: PUBLICATION_PROTOCOL,
    sha256: final.sha256,
    stagingCleanup: 'complete',
  })
}

export function publishCanonicalJsonNoReplace({ outputPath, value }, overrides = {}) {
  const dependencies = publicationDependencies(overrides)
  const output = exactAbsolutePath(outputPath, 'outputPath')
  if (dependencies.exists(output)) throw new Error(`Publication output already exists: ${output}`)
  const bytes = canonicalJsonBytes(value)
  const staging = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${dependencies.randomId()}.staging`,
  )
  dependencies.writeExclusive(staging, bytes)
  return publishVerifiedFileNoReplace({
    stagingPath: staging,
    outputPath: output,
    expectedSha256: sha256Bytes(bytes),
  }, dependencies)
}

function validArtifact(value, withBytes = false) {
  const keys = withBytes ? ['bytes', 'path', 'sha256'] : ['path', 'sha256']
  return exactKeys(value, keys)
    && path.isAbsolute(value.path)
    && HASH_PATTERN.test(value.sha256)
    && (!withBytes || (Number.isSafeInteger(value.bytes) && value.bytes > 0))
}

function validBuildBinding(value) {
  return COMMIT_PATTERN.test(value.sourceCommit || '') && value.targetTriple === TARGET_TRIPLE
}

function sameArtifactReference(left, right, withBytes = false) {
  return left?.path === right?.path
    && left?.sha256 === right?.sha256
    && (!withBytes || left?.bytes === right?.bytes)
}

function validIdentity(value) {
  return exactKeys(value, ['dev', 'ino'])
    && typeof value.dev === 'string'
    && value.dev.length > 0
    && typeof value.ino === 'string'
    && value.ino.length > 0
}

function buildReceiptDependencies(overrides = {}) {
  return {
    inspectFile: fileFacts,
    readJson(filePath) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    },
    validateL1Manifest: validateL1ReviewedManifest,
    validateL2Manifest: validateL2ReviewedManifest,
    ...overrides,
  }
}

export function validateProductionBuildReceipt(value, overrides = {}) {
  const dependencies = buildReceiptDependencies(overrides)
  if (
    !exactKeys(value, [
      'candidate', 'compiledSmoke', 'l1Manifest', 'l2Manifest', 'parentFlush', 'protocol',
      'sourceCommit', 'stagingCleanup', 'targetTriple', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== WINDOWS_PRODUCTION_BUILD_RECEIPT_TYPE
    || !validBuildBinding(value)
    || !validArtifact(value.l1Manifest)
    || !validArtifact(value.l2Manifest)
    || !exactKeys(value.candidate, ['bytes', 'identity', 'path', 'sha256'])
    || !validArtifact({
      bytes: value.candidate?.bytes,
      path: value.candidate?.path,
      sha256: value.candidate?.sha256,
    }, true)
    || !validIdentity(value.candidate.identity)
    || !exactKeys(value.compiledSmoke, ['nativeActivationMode', 'sourceCommit', 'targetTriple'])
    || value.compiledSmoke.nativeActivationMode !== 'production'
    || value.compiledSmoke.sourceCommit !== value.sourceCommit
    || value.compiledSmoke.targetTriple !== value.targetTriple
    || value.protocol !== PUBLICATION_PROTOCOL
    || value.stagingCleanup !== 'complete'
    || value.parentFlush !== 'complete'
  ) invalid('Production build receipt')

  try {
    for (const reference of [value.l1Manifest, value.l2Manifest]) {
      exactAbsolutePath(reference.path, 'manifest path')
      const facts = dependencies.inspectFile(reference.path)
      if (!facts || facts.sha256 !== reference.sha256 || facts.links < 1) {
        invalid('Production build receipt')
      }
    }
    exactAbsolutePath(value.candidate.path, 'candidate path')
    const candidateFacts = dependencies.inspectFile(value.candidate.path)
    if (
      !candidateFacts
      || candidateFacts.sha256 !== value.candidate.sha256
      || candidateFacts.bytes !== value.candidate.bytes
      || candidateFacts.links !== 1
      || !sameIdentity(candidateFacts, value.candidate)
    ) invalid('Production build receipt')

    const l1Manifest = dependencies.readJson(value.l1Manifest.path)
    const l2Manifest = dependencies.readJson(value.l2Manifest.path)
    dependencies.validateL1Manifest(l1Manifest)
    dependencies.validateL2Manifest(l2Manifest)
    for (const manifest of [l1Manifest, l2Manifest]) {
      if (manifest.sourceCommit !== value.sourceCommit || manifest.targetTriple !== value.targetTriple) {
        invalid('Production build receipt')
      }
    }
  } catch (error) {
    if (error?.message === 'Production build receipt is inexact or incomplete') throw error
    invalid('Production build receipt')
  }
  return value
}

export function validateL1ReviewedManifest(value) {
  try {
    const { createWindowsNativeDurabilityBuildAuthorization } = require(
      '../server/platform/windows-native-durability-profile',
    )
    createWindowsNativeDurabilityBuildAuthorization(value, {
      sourceCommit: value?.sourceCommit,
      targetTriple: value?.targetTriple,
    })
  } catch {
    invalid('L1 reviewed manifest')
  }
  return value
}

export function validateL1ProductionE2eResult(value) {
  if (
    !exactKeys(value, [
      'buildReceipt', 'candidate', 'cases', 'reviewedManifest', 'sourceCommit', 'status',
      'suite', 'targetTriple', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== WINDOWS_L1_PRODUCTION_E2E_RESULT_TYPE
    || value.status !== 'PASS'
    || !validBuildBinding(value)
    || !validArtifact(value.reviewedManifest)
    || !validArtifact(value.buildReceipt)
    || !validArtifact(value.candidate, true)
    || !exactKeys(value.suite, ['failed', 'passed', 'skipped', 'total'])
    || value.suite.total !== L1_E2E_CASE_IDS.length
    || value.suite.passed !== L1_E2E_CASE_IDS.length
    || value.suite.failed !== 0
    || value.suite.skipped !== 0
    || !Array.isArray(value.cases)
    || value.cases.length !== L1_E2E_CASE_IDS.length
    || value.cases.some((entry, index) => (
      !exactKeys(entry, ['id', 'status'])
      || entry.id !== L1_E2E_CASE_IDS[index]
      || entry.status !== 'PASS'
    ))
  ) invalid('L1 production E2E result')
  return value
}

function validSamples(values, count) {
  return Array.isArray(values)
    && values.length === count
    && values.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
}

function exactNumberMap(value, keys) {
  return exactKeys(value, keys)
    && keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)
}

function nearestRank(values, percentile) {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.ceil(percentile * ordered.length) - 1]
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= 0.001
}

export function validateL1NativeBenchmarkResult(value) {
  const expectedEvents = [0, 10_000, 100_000]
  if (
    !exactKeys(value, [
      'buildReceipt', 'candidate', 'cohorts', 'fixture', 'reviewedManifest', 'sourceCommit',
      'status', 'targetTriple', 'thresholds', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== WINDOWS_L1_NATIVE_BENCHMARK_RESULT_TYPE
    || value.status !== 'PASS'
    || !validBuildBinding(value)
    || !validArtifact(value.reviewedManifest)
    || !validArtifact(value.buildReceipt)
    || !validArtifact(value.candidate, true)
    || !exactKeys(value.fixture, ['chapterCount', 'charactersPerChapter'])
    || value.fixture.chapterCount !== 3_000
    || value.fixture.charactersPerChapter !== 3_400
    || !exactKeys(value.thresholds, ['nativeTransactionP95Ms', 'saveE2eP95Ms'])
    || value.thresholds.nativeTransactionP95Ms !== 500
    || value.thresholds.saveE2eP95Ms !== 300
    || !Array.isArray(value.cohorts)
    || value.cohorts.length !== expectedEvents.length
  ) invalid('L1 native benchmark result')
  for (const [index, cohort] of value.cohorts.entries()) {
    if (
      !exactKeys(cohort, [
        'maxMs', 'measurementCount', 'p50Ms', 'p95Ms', 'samplesMs', 'segmentsMs',
        'terminalEventCount', 'warmupCount',
      ])
      || cohort.terminalEventCount !== expectedEvents[index]
      || cohort.warmupCount !== 2
      || cohort.measurementCount !== 20
      || !exactKeys(cohort.samplesMs, BENCHMARK_METRICS)
      || BENCHMARK_METRICS.some((metric) => !validSamples(cohort.samplesMs[metric], 20))
      || !exactKeys(cohort.segmentsMs, BENCHMARK_SEGMENTS)
      || BENCHMARK_SEGMENTS.some((segment) => !validSamples(cohort.segmentsMs[segment], 20))
      || !exactNumberMap(cohort.p50Ms, BENCHMARK_METRICS)
      || !exactNumberMap(cohort.p95Ms, BENCHMARK_METRICS)
      || !exactNumberMap(cohort.maxMs, BENCHMARK_METRICS)
    ) invalid('L1 native benchmark result')
    for (const metric of BENCHMARK_METRICS) {
      const samples = cohort.samplesMs[metric]
      if (
        !nearlyEqual(cohort.p50Ms[metric], nearestRank(samples, 0.5))
        || !nearlyEqual(cohort.p95Ms[metric], nearestRank(samples, 0.95))
        || !nearlyEqual(cohort.maxMs[metric], Math.max(...samples))
      ) invalid('L1 native benchmark result')
    }
    for (let sampleIndex = 0; sampleIndex < cohort.measurementCount; sampleIndex += 1) {
      const segmentTotal = BENCHMARK_SEGMENTS.reduce(
        (total, segment) => total + cohort.segmentsMs[segment][sampleIndex],
        0,
      )
      if (Math.abs(segmentTotal - cohort.samplesMs.saveE2e[sampleIndex]) > SEGMENT_RECONCILIATION_TOLERANCE_MS) {
        invalid('L1 native benchmark result')
      }
    }
  }
  for (const cohort of [value.cohorts[0], value.cohorts[2]]) {
    if (
      cohort.p95Ms.nativeTransaction >= value.thresholds.nativeTransactionP95Ms
      || cohort.p95Ms.saveE2e >= value.thresholds.saveE2eP95Ms
    ) invalid('L1 native benchmark result')
  }
  return value
}

function matrixFacts(value, expectedCount) {
  return exactKeys(value, ['aggregateSha256', 'caseCount', 'failed', 'passed'])
    && value.caseCount === expectedCount
    && value.passed === expectedCount
    && value.failed === 0
    && HASH_PATTERN.test(value.aggregateSha256)
}

export function inspectL2RawEvidence(rawPath) {
  const root = exactAbsolutePath(rawPath, 'rawEvidence.path')
  const names = fs.readdirSync(root, { withFileTypes: true })
  if (
    names.length !== Object.keys(L2_RAW_FILES).length
    || names.some((entry) => !entry.isFile() || !Object.values(L2_RAW_FILES).includes(entry.name))
  ) invalid('L2 raw evidence tree')
  const treeEntries = []
  const matrices = {}
  let sourceCommit = null
  let targetTriple = null
  for (const [matrix, name] of Object.entries(L2_RAW_FILES)) {
    const filePath = path.join(root, name)
    const bytes = fs.readFileSync(filePath)
    const value = JSON.parse(bytes.toString('utf8'))
    if (
      !exactKeys(value, ['aggregateSha256', 'cases', 'matrix', 'sourceCommit', 'targetTriple', 'type', 'version'])
      || value.version !== 1
      || value.type !== 'mythpen.windows-l2-raw-matrix.v1'
      || value.matrix !== matrix
      || !validBuildBinding(value)
      || !Array.isArray(value.cases)
      || value.cases.length !== L2_MATRIX_CASE_COUNTS[matrix]
      || value.cases.some((entry, index) => (
        !exactKeys(entry, ['evidenceSha256', 'id', 'status'])
        || entry.id !== L2_RAW_CASE_IDS[matrix][index]
        || entry.status !== 'PASS'
        || !HASH_PATTERN.test(entry.evidenceSha256 || '')
      ))
    ) invalid('L2 raw evidence matrix')
    if (sourceCommit === null) {
      sourceCommit = value.sourceCommit
      targetTriple = value.targetTriple
    } else if (value.sourceCommit !== sourceCommit || value.targetTriple !== targetTriple) {
      invalid('L2 raw evidence matrix')
    }
    const aggregateSha256 = sha256Bytes(canonicalJsonBytes(value.cases))
    if (value.aggregateSha256 !== aggregateSha256) invalid('L2 raw evidence matrix')
    matrices[matrix] = { caseCount: value.cases.length, aggregateSha256 }
    treeEntries.push({ bytes: bytes.length, path: name, sha256: sha256Bytes(bytes) })
  }
  treeEntries.sort((left, right) => utf8KeyCompare(left.path, right.path))
  return Object.freeze({
    path: root,
    sourceCommit,
    targetTriple,
    treeSha256: sha256Bytes(canonicalJsonBytes(treeEntries)),
    matrices: Object.freeze(matrices),
  })
}

export function validateL2ReviewedManifest(value, dependencies = {}) {
  if (
    !exactKeys(value, [
      'matrices', 'rawEvidence', 'sourceCommit', 'status', 'targetTriple', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== WINDOWS_L2_REVIEWED_MANIFEST_TYPE
    || value.status !== 'PASS'
    || !validBuildBinding(value)
    || !exactKeys(value.rawEvidence, ['path', 'treeSha256'])
    || !path.isAbsolute(value.rawEvidence.path)
    || !HASH_PATTERN.test(value.rawEvidence.treeSha256)
    || !exactKeys(value.matrices, ['capacity', 'correctness', 'twoProcess'])
    || !matrixFacts(value.matrices.correctness, L2_MATRIX_CASE_COUNTS.correctness)
    || !matrixFacts(value.matrices.twoProcess, L2_MATRIX_CASE_COUNTS.twoProcess)
    || !matrixFacts(value.matrices.capacity, L2_MATRIX_CASE_COUNTS.capacity)
  ) invalid('L2 reviewed manifest')
  let inspected
  try {
    inspected = (dependencies.inspectRawEvidence || inspectL2RawEvidence)(value.rawEvidence.path)
  } catch {
    invalid('L2 reviewed manifest')
  }
  if (
    inspected.path !== value.rawEvidence.path
    || inspected.treeSha256 !== value.rawEvidence.treeSha256
    || inspected.sourceCommit !== value.sourceCommit
    || inspected.targetTriple !== value.targetTriple
    || Object.entries(L2_MATRIX_CASE_COUNTS).some(([matrix, count]) => (
      inspected.matrices?.[matrix]?.caseCount !== count
      || inspected.matrices[matrix].aggregateSha256 !== value.matrices[matrix].aggregateSha256
    ))
  ) invalid('L2 reviewed manifest')
  return value
}

export function validateL2ProductionE2eResult(value) {
  if (
    !exactKeys(value, [
      'buildReceipt', 'candidate', 'cases', 'expectL2Default', 'l1Manifest', 'l2Manifest',
      'sourceCommit', 'status', 'targetTriple', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== WINDOWS_L2_PRODUCTION_E2E_RESULT_TYPE
    || value.status !== 'PASS'
    || !validBuildBinding(value)
    || typeof value.expectL2Default !== 'boolean'
    || !validArtifact(value.candidate)
    || !validArtifact(value.l1Manifest)
    || !validArtifact(value.l2Manifest)
    || !validArtifact(value.buildReceipt)
    || !Array.isArray(value.cases)
    || value.cases.length !== 9
    || value.cases.some((entry) => (
      !exactKeys(entry, ['durationMs', 'evidenceSha256', 'id', 'status'])
      || entry.status !== 'PASS'
      || !Number.isFinite(entry.durationMs)
      || entry.durationMs < 0
      || !HASH_PATTERN.test(entry.evidenceSha256)
    ))
  ) invalid('L2 production E2E result')
  return value
}

export function validateL2PerformanceResult(value) {
  if (
    !exactKeys(value, [
      'attestation', 'buildReceipt', 'candidate', 'fixtures', 'measurements', 'sourceCommit',
      'status', 'targetTriple', 'thresholds', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== WINDOWS_L2_PERFORMANCE_RESULT_TYPE
    || value.status !== 'PASS'
    || !validBuildBinding(value)
    || !validArtifact(value.attestation)
    || !validArtifact(value.buildReceipt)
    || !validArtifact(value.candidate)
    || !Array.isArray(value.fixtures)
    || !Array.isArray(value.measurements)
    || !isPlainObject(value.thresholds)
  ) invalid('L2 performance result')
  return value
}

function validateDesktopManuscriptFilesResult(value) {
  const expectedCases = [
    'open_chapter_body',
    'open_chapter_sidecar',
    'open_volume_index',
    'reveal_project',
    'unknown_uid_rejected',
    'wrong_route_rejected',
    'hard_link_rejected',
    'reparse_alias_rejected',
  ]
  if (
    !exactKeys(value, [
      'auth', 'cases', 'desktop', 'request', 'runId', 'sidecar', 'sourceCommit', 'status',
      'suite', 'targetTriple', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== 'mythpen.desktop-l2-files-smoke.v1'
    || value.status !== 'PASS'
    || !validBuildBinding(value)
    || !validArtifact(value.desktop, true)
    || !validArtifact(value.sidecar, true)
    || !validArtifact(value.request, true)
    || !exactKeys(value.auth, ['mode'])
    || value.auth.mode !== 'debug-only-one-time-nonce-v1'
    || typeof value.runId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.runId)
    || !exactKeys(value.suite, ['failed', 'passed', 'total'])
    || value.suite.total !== expectedCases.length
    || value.suite.passed !== expectedCases.length
    || value.suite.failed !== 0
    || !Array.isArray(value.cases)
    || value.cases.length !== expectedCases.length
    || value.cases.some((entry, index) => {
      if (
        !exactKeys(entry, ['errorCode', 'id', 'launchCalls', 'status', 'target'])
        || entry.id !== expectedCases[index]
        || entry.status !== 'PASS'
      ) return true
      const rejected = entry.id.endsWith('_rejected')
      return rejected
        ? entry.launchCalls !== 0 || entry.target !== null || typeof entry.errorCode !== 'string' || entry.errorCode.length === 0
        : entry.launchCalls !== 1 || typeof entry.target !== 'string' || !path.isAbsolute(entry.target) || entry.errorCode !== null
    })
  ) invalid('Desktop manuscript files result')
  return value
}

function attestationDependencies(overrides = {}) {
  return {
    inspectFile: fileFacts,
    readJson(filePath) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    },
    validateL1Manifest: validateL1ReviewedManifest,
    validateL2Manifest: validateL2ReviewedManifest,
    validateBuildReceipt: validateProductionBuildReceipt,
    validateL1Benchmark: validateL1NativeBenchmarkResult,
    validateL2E2e: validateL2ProductionE2eResult,
    validateDesktopFiles: validateDesktopManuscriptFilesResult,
    ...overrides,
  }
}

function artifactMatchesFile(reference, facts, withBytes = false) {
  return facts
    && facts.links >= 1
    && facts.sha256 === reference.sha256
    && (!withBytes || facts.bytes === reference.bytes)
}

export function validateL2ProductionAttestation(value, overrides = {}) {
  const dependencies = attestationDependencies(overrides)
  const expectedResultKeys = ['desktopManuscriptFiles', 'l1NativeBenchmark', 'l2ProductionE2e']
  if (
    !exactKeys(value, [
      'buildReceipt', 'candidate', 'l1Manifest', 'l2Manifest', 'profile', 'results',
      'sourceCommit', 'status', 'targetTriple', 'type', 'version',
    ])
    || value.version !== 1
    || value.type !== WINDOWS_L2_PRODUCTION_ATTESTATION_TYPE
    || value.profile !== 'l2-correctness'
    || value.status !== 'PASS'
    || !validBuildBinding(value)
    || !validArtifact(value.l1Manifest)
    || !validArtifact(value.l2Manifest)
    || !validArtifact(value.buildReceipt)
    || !validArtifact(value.candidate, true)
    || !exactKeys(value.results, expectedResultKeys)
    || Object.values(value.results).some((reference) => !validArtifact(reference))
  ) invalid('L2 production attestation')

  try {
    for (const reference of [
      value.l1Manifest,
      value.l2Manifest,
      value.buildReceipt,
      ...Object.values(value.results),
    ]) {
      exactAbsolutePath(reference.path, 'attestation artifact path')
      if (!artifactMatchesFile(reference, dependencies.inspectFile(reference.path))) {
        invalid('L2 production attestation')
      }
    }
    exactAbsolutePath(value.candidate.path, 'attestation candidate path')
    if (!artifactMatchesFile(
      value.candidate,
      dependencies.inspectFile(value.candidate.path),
      true,
    )) invalid('L2 production attestation')

    const l1Manifest = dependencies.readJson(value.l1Manifest.path)
    const l2Manifest = dependencies.readJson(value.l2Manifest.path)
    const buildReceipt = dependencies.readJson(value.buildReceipt.path)
    const l1Benchmark = dependencies.readJson(value.results.l1NativeBenchmark.path)
    const l2E2e = dependencies.readJson(value.results.l2ProductionE2e.path)
    const desktopFiles = dependencies.readJson(value.results.desktopManuscriptFiles.path)
    dependencies.validateL1Manifest(l1Manifest)
    dependencies.validateL2Manifest(l2Manifest)
    dependencies.validateBuildReceipt(buildReceipt)
    dependencies.validateL1Benchmark(l1Benchmark)
    dependencies.validateL2E2e(l2E2e)
    dependencies.validateDesktopFiles?.(desktopFiles)

    for (const document of [l1Manifest, l2Manifest, buildReceipt, l1Benchmark, l2E2e, desktopFiles]) {
      if (document.sourceCommit !== value.sourceCommit || document.targetTriple !== value.targetTriple) {
        invalid('L2 production attestation')
      }
    }
    if (
      !sameArtifactReference(buildReceipt.l1Manifest, value.l1Manifest)
      || !sameArtifactReference(buildReceipt.l2Manifest, value.l2Manifest)
      || !sameArtifactReference(buildReceipt.candidate, value.candidate, true)
      || !sameArtifactReference(l1Benchmark.reviewedManifest, value.l1Manifest)
      || !sameArtifactReference(l1Benchmark.buildReceipt, value.buildReceipt)
      || !sameArtifactReference(l1Benchmark.candidate, value.candidate, true)
      || !sameArtifactReference(l2E2e.l1Manifest, value.l1Manifest)
      || !sameArtifactReference(l2E2e.l2Manifest, value.l2Manifest)
      || !sameArtifactReference(l2E2e.buildReceipt, value.buildReceipt)
      || !sameArtifactReference(l2E2e.candidate, value.candidate)
      || !sameArtifactReference(desktopFiles.sidecar, value.candidate, true)
    ) invalid('L2 production attestation')
  } catch (error) {
    if (error?.message === 'L2 production attestation is inexact or incomplete') throw error
    invalid('L2 production attestation')
  }
  return value
}

const PROFILE_VALIDATORS = new Map([
  ['production-build-receipt', validateProductionBuildReceipt],
  ['l1-reviewed-manifest', validateL1ReviewedManifest],
  ['l1-production-e2e-result', validateL1ProductionE2eResult],
  ['l1-native-benchmark-result', validateL1NativeBenchmarkResult],
  ['l2-reviewed-manifest', validateL2ReviewedManifest],
  ['l2-production-e2e-result', validateL2ProductionE2eResult],
  ['l2-performance-result', validateL2PerformanceResult],
  ['l2-production-attestation', validateL2ProductionAttestation],
])

function parsePublishJsonArguments(args) {
  if (args[0] !== 'publish-json' || args.length !== 7) throw new Error('Invalid publisher arguments')
  const values = {}
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    if (!new Set(['--profile', '--input', '--output']).has(flag) || Object.hasOwn(values, flag)) {
      throw new Error('Invalid publisher arguments')
    }
    values[flag] = args[index + 1]
  }
  if (!values['--profile'] || !values['--input'] || !values['--output']) {
    throw new Error('Invalid publisher arguments')
  }
  return values
}

function assertPublisherRuntime(overrides = {}) {
  const platform = overrides.platform ?? process.platform
  const bunVersion = overrides.bunVersion ?? process.versions.bun
  if (platform !== 'win32' || bunVersion !== '1.3.14') {
    throw new Error('Production evidence publication requires Bun 1.3.14 on Windows')
  }
}

function parsePublishFileArguments(args) {
  if (args[0] !== 'publish-file' || args.length !== 7) throw new Error('Invalid publisher arguments')
  const values = {}
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    if (!new Set(['--staging', '--output', '--sha256']).has(flag) || Object.hasOwn(values, flag)) {
      throw new Error('Invalid publisher arguments')
    }
    values[flag] = args[index + 1]
  }
  if (!values['--staging'] || !values['--output'] || !values['--sha256']) {
    throw new Error('Invalid publisher arguments')
  }
  return values
}

export function publishFileCli(args, overrides = {}) {
  assertPublisherRuntime(overrides)
  const parsed = parsePublishFileArguments(args)
  return publishVerifiedFileNoReplace({
    stagingPath: parsed['--staging'],
    outputPath: parsed['--output'],
    expectedSha256: parsed['--sha256'],
  }, overrides.publication)
}

export function publishJsonCli(args, overrides = {}) {
  assertPublisherRuntime(overrides)
  const parsed = parsePublishJsonArguments(args)
  const validator = PROFILE_VALIDATORS.get(parsed['--profile'])
  if (!validator) throw new Error('Unknown production evidence profile')
  const input = exactAbsolutePath(parsed['--input'], 'input')
  const output = exactAbsolutePath(parsed['--output'], 'output')
  if (!fs.existsSync(input) || fs.existsSync(output)) throw new Error('Publisher input/output disposition is invalid')
  const value = JSON.parse(fs.readFileSync(input, 'utf8'))
  validator(value)
  return publishCanonicalJsonNoReplace({ outputPath: output, value })
}

export function publisherCli(args, overrides = {}) {
  if (args[0] === 'publish-file') return publishFileCli(args, overrides)
  return publishJsonCli(args, overrides)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    publisherCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`Production evidence publication failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
