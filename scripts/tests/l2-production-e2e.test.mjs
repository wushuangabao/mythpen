import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

const L2_PRODUCTION_CASE_IDS = Object.freeze([
  'build-info-artifact-binding',
  'create-files-project',
  'migrate-sqlite-project',
  'first-restart-retention',
  'external-edit-refresh',
  'draft-conflict-recovery',
  'retire-and-reactivate',
  'export-file-authority',
  'second-restart-retention',
])
const REQUIRED_L2_ENV = Object.freeze([
  'MYTHPEN_L2_PRODUCTION_CANDIDATE',
  'MYTHPEN_L1_REVIEWED_MANIFEST',
  'MYTHPEN_L2_REVIEWED_MANIFEST',
  'MYTHPEN_L2_BUILD_RECEIPT',
  'MYTHPEN_L2_E2E_RESULT',
  'MYTHPEN_EXPECT_L2_DEFAULT',
])
const L2_E2E_RESULT_TYPE = 'mythpen.windows-l2-production-e2e-result.v1'

function configuredAcceptanceEnvironment(environment) {
  const values = Object.fromEntries(
    REQUIRED_L2_ENV.map((key) => [key, String(environment[key] || '').trim()]),
  )
  const configured = Object.values(values).filter(Boolean).length
  if (configured === 0) return Object.freeze({ mode: 'not-run', values })
  if (configured !== REQUIRED_L2_ENV.length) throw new Error('L2_PRODUCTION_E2E_INPUTS_INCOMPLETE')
  if (!new Set(['true', 'false']).has(values.MYTHPEN_EXPECT_L2_DEFAULT)) {
    throw new Error('L2_PRODUCTION_E2E_DEFAULT_EXPECTATION_INVALID')
  }
  for (const key of REQUIRED_L2_ENV.filter((key) => key !== 'MYTHPEN_EXPECT_L2_DEFAULT')) {
    if (!path.isAbsolute(values[key])) throw new Error(`L2_PRODUCTION_E2E_INPUT_NOT_ABSOLUTE:${key}`)
  }
  return Object.freeze({ mode: 'acceptance', values })
}

function assertExactKeys(value, expected, label) {
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true, label)
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`)
}

function assertArtifactReference(value, label) {
  assertExactKeys(value, ['path', 'sha256'], label)
  assert.equal(path.isAbsolute(value.path), true, `${label} path`)
  assert.match(value.sha256, /^[0-9a-f]{64}$/, `${label} sha256`)
}

function assertL2ResultSchema(result) {
  assertExactKeys(result, [
    'version', 'type', 'status', 'sourceCommit', 'targetTriple', 'expectL2Default',
    'candidate', 'l1Manifest', 'l2Manifest', 'buildReceipt', 'cases',
  ], 'L2 E2E result')
  assert.equal(result.version, 1)
  assert.equal(result.type, L2_E2E_RESULT_TYPE)
  assert.equal(result.status, 'PASS')
  assert.match(result.sourceCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  assert.match(result.targetTriple, /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/)
  assert.equal(typeof result.expectL2Default, 'boolean')
  assertArtifactReference(result.candidate, 'candidate')
  assertArtifactReference(result.l1Manifest, 'L1 manifest')
  assertArtifactReference(result.l2Manifest, 'L2 manifest')
  assertArtifactReference(result.buildReceipt, 'build receipt')
  assert.deepEqual(result.cases.map((entry) => entry.id), L2_PRODUCTION_CASE_IDS)
  for (const entry of result.cases) {
    assertExactKeys(entry, ['id', 'status', 'durationMs', 'evidenceSha256'], `L2 E2E case ${entry.id}`)
    assert.equal(entry.status, 'PASS')
    assert.match(entry.evidenceSha256, /^[0-9a-f]{64}$/)
  }
}

test('production acceptance harness source contract', () => {
  assert.deepEqual(L2_PRODUCTION_CASE_IDS, [
    'build-info-artifact-binding',
    'create-files-project',
    'migrate-sqlite-project',
    'first-restart-retention',
    'external-edit-refresh',
    'draft-conflict-recovery',
    'retire-and-reactivate',
    'export-file-authority',
    'second-restart-retention',
  ])
  assert.equal(configuredAcceptanceEnvironment({}).mode, 'not-run')
  assert.throws(
    () => configuredAcceptanceEnvironment({ MYTHPEN_L2_PRODUCTION_CANDIDATE: 'candidate.exe' }),
    /INPUTS_INCOMPLETE/,
  )
  const complete = Object.fromEntries(REQUIRED_L2_ENV.map((key) => [key, 'C:\\evidence\\input']))
  complete.MYTHPEN_EXPECT_L2_DEFAULT = 'maybe'
  assert.throws(() => configuredAcceptanceEnvironment(complete), /DEFAULT_EXPECTATION_INVALID/)
  assert.equal(L2_E2E_RESULT_TYPE, 'mythpen.windows-l2-production-e2e-result.v1')
  assert.equal(typeof assertL2ResultSchema, 'function')
})

let acceptanceConfiguration
let acceptanceConfigurationError = null
try {
  acceptanceConfiguration = configuredAcceptanceEnvironment(process.env)
} catch (error) {
  acceptanceConfigurationError = error
}

test('L2 production E2E configuration fails closed', {
  skip: acceptanceConfigurationError === null ? 'configuration is complete or absent' : false,
}, () => {
  throw acceptanceConfigurationError
})

const acceptanceTest = acceptanceConfiguration?.mode === 'acceptance' ? test : test.skip
acceptanceTest('L2 production artifact acceptance execution', { timeout: 600_000 }, () => {
  throw new Error('L2_PRODUCTION_E2E_IMPLEMENTATION_NOT_FROZEN')
})
