const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const NATIVE_BENCHMARK_CASE_IDS = Object.freeze([
  'native-fresh-0-terminal-events',
  'native-scale-10000-terminal-events',
  'native-aged-100000-terminal-events',
]);
const NATIVE_BENCHMARK_SEGMENT_IDS = Object.freeze([
  'queueLeaseWait',
  'manuscriptSourceAppend',
  'preparedAppend',
  'beginAndPreflight',
  'dmlSequenceAndGate',
  'sqliteCommit',
  'terminalAppendAndPostcheck',
  'apiClientRemainder',
]);
const REQUIRED_BENCHMARK_ENV = Object.freeze([
  'MYTHPEN_L1_PRODUCTION_CANDIDATE',
  'MYTHPEN_L1_REVIEWED_MANIFEST',
  'MYTHPEN_L1_BUILD_RECEIPT',
  'MYTHPEN_L1_BENCHMARK_RESULT',
]);
const BENCHMARK_RESULT_TYPE = 'mythpen.windows-l1-native-benchmark-result.v1';

function configuredAcceptanceEnvironment(environment) {
  const values = Object.fromEntries(
    REQUIRED_BENCHMARK_ENV.map((key) => [key, String(environment[key] || '').trim()]),
  );
  const configured = Object.values(values).filter(Boolean).length;
  if (configured === 0) return Object.freeze({ mode: 'not-run', values });
  if (configured !== REQUIRED_BENCHMARK_ENV.length) {
    throw new Error('L1_NATIVE_BENCHMARK_INPUTS_INCOMPLETE');
  }
  for (const key of REQUIRED_BENCHMARK_ENV) {
    if (!path.isAbsolute(values[key])) throw new Error(`L1_NATIVE_BENCHMARK_INPUT_NOT_ABSOLUTE:${key}`);
  }
  return Object.freeze({ mode: 'acceptance', values });
}

function assertExactKeys(value, expected, label) {
  assert.equal(value !== null && typeof value === 'object' && !Array.isArray(value), true, label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function assertArtifactReference(value, label) {
  assertExactKeys(value, ['path', 'sha256'], label);
  assert.equal(path.isAbsolute(value.path), true, `${label} path`);
  assert.match(value.sha256, /^[0-9a-f]{64}$/, `${label} sha256`);
}

function assertCandidateReference(value) {
  assertExactKeys(value, ['path', 'sha256', 'bytes'], 'candidate');
  assert.equal(path.isAbsolute(value.path), true, 'candidate path');
  assert.match(value.sha256, /^[0-9a-f]{64}$/, 'candidate sha256');
  assert.equal(Number.isSafeInteger(value.bytes) && value.bytes > 0, true, 'candidate bytes');
}

function assertBenchmarkResultSchema(result) {
  assertExactKeys(result, [
    'version', 'type', 'status', 'sourceCommit', 'targetTriple', 'candidate',
    'reviewedManifest', 'buildReceipt', 'fixture', 'cohorts', 'thresholds',
  ], 'benchmark result');
  assert.equal(result.version, 1);
  assert.equal(result.type, BENCHMARK_RESULT_TYPE);
  assert.equal(result.status, 'PASS');
  assert.match(result.sourceCommit, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  assert.match(result.targetTriple, /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/);
  assertCandidateReference(result.candidate);
  assertArtifactReference(result.reviewedManifest, 'reviewed manifest');
  assertArtifactReference(result.buildReceipt, 'build receipt');
  assert.deepEqual(result.cohorts.map((entry) => entry.terminalEventCount), [0, 10_000, 100_000]);
  for (const entry of result.cohorts) {
    assertExactKeys(entry, [
      'terminalEventCount', 'warmupCount', 'measurementCount', 'samplesMs', 'p50Ms',
      'p95Ms', 'maxMs', 'segmentsMs',
    ], `benchmark cohort ${entry.terminalEventCount}`);
    assert.equal(entry.warmupCount, 2);
    assert.equal(entry.measurementCount, 20);
    assert.deepEqual(Object.keys(entry.samplesMs), ['nativeTransaction', 'saveE2e']);
    assert.deepEqual(Object.keys(entry.segmentsMs), NATIVE_BENCHMARK_SEGMENT_IDS);
  }
}

test('production acceptance harness source contract', () => {
  assert.deepEqual(NATIVE_BENCHMARK_CASE_IDS, [
    'native-fresh-0-terminal-events',
    'native-scale-10000-terminal-events',
    'native-aged-100000-terminal-events',
  ]);
  assert.deepEqual(NATIVE_BENCHMARK_SEGMENT_IDS, [
    'queueLeaseWait',
    'manuscriptSourceAppend',
    'preparedAppend',
    'beginAndPreflight',
    'dmlSequenceAndGate',
    'sqliteCommit',
    'terminalAppendAndPostcheck',
    'apiClientRemainder',
  ]);
  assert.equal(configuredAcceptanceEnvironment({}).mode, 'not-run');
  assert.throws(
    () => configuredAcceptanceEnvironment({ MYTHPEN_L1_PRODUCTION_CANDIDATE: 'candidate.exe' }),
    /INPUTS_INCOMPLETE/,
  );
  assert.throws(
    () => configuredAcceptanceEnvironment(Object.fromEntries(
      REQUIRED_BENCHMARK_ENV.map((key) => [key, 'relative-path']),
    )),
    /INPUT_NOT_ABSOLUTE/,
  );
  assert.equal(BENCHMARK_RESULT_TYPE, 'mythpen.windows-l1-native-benchmark-result.v1');
  assert.equal(typeof assertBenchmarkResultSchema, 'function');
});

let acceptanceConfiguration;
let acceptanceConfigurationError = null;
try {
  acceptanceConfiguration = configuredAcceptanceEnvironment(process.env);
} catch (error) {
  acceptanceConfigurationError = error;
}

test('native durability benchmark configuration fails closed', {
  skip: acceptanceConfigurationError === null ? 'configuration is complete or absent' : false,
}, () => {
  throw acceptanceConfigurationError;
});

const acceptanceTest = acceptanceConfiguration?.mode === 'acceptance' ? test : test.skip;
acceptanceTest('native durability benchmark acceptance execution', {
  timeout: 600_000,
}, () => {
  throw new Error('L1_NATIVE_BENCHMARK_IMPLEMENTATION_NOT_FROZEN');
});
