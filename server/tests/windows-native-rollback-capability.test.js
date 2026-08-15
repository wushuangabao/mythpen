const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NATIVE_TRANSACTION_CRASH_CUTS,
  WINDOWS_ROLLBACK_CRASH_CASES,
  inspectWindowsNativeRollbackJournalEvidence,
  requireWindowsNativeRollbackJournalDurability,
} = require('../platform/windows-native-rollback-capability');

const HASH = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const TRIPLE = 'x86_64-pc-windows-msvc';
const CUTS = Object.freeze([
  'native.caller.after-source-postcheck',
  'native.tx.after-prepared-postcheck',
  'native.tx.after-begin-acquired',
  'native.tx.after-gate-insert',
  'native.tx.after-business-callback',
  'native.tx.after-seq-cas',
  'native.tx.after-gate-delete',
  'native.tx.before-commit-invoke',
  'native.tx.after-commit-return',
  'native.tx.before-terminal-append',
  'controlstore.append.before-publish',
  'controlstore.append.before-dir-fsync',
  'native.tx.after-terminal-postcheck',
]);

function exactEvidence(overrides = {}) {
  return Object.freeze({
    version: 1,
    evidenceKind: 'windows-ntfs-vm-hard-reset-v1',
    binarySha256: HASH,
    sourceCommit: COMMIT,
    targetTriple: TRIPLE,
    bunVersion: '1.3.14',
    sqliteVersion: '3.53.0',
    sqliteSourceId: '2026-04-09 11:41:38 source-id',
    filesystem: Object.freeze({ name: 'NTFS', bytesPerSector: 4096, rootKind: 'plain-directory' }),
    pragmas: Object.freeze({ journalMode: 'delete', synchronous: 3 }),
    cuts: Object.freeze(CUTS.map((name) => Object.freeze({ name, outcome: 'cold-converged' }))),
    ...overrides,
  });
}

function currentBinding(overrides = {}) {
  return Object.freeze({
    binarySha256: HASH,
    sourceCommit: COMMIT,
    targetTriple: TRIPLE,
    bunVersion: '1.3.14',
    sqliteVersion: '3.53.0',
    sqliteSourceId: '2026-04-09 11:41:38 source-id',
    filesystem: Object.freeze({ name: 'NTFS', bytesPerSector: 4096, rootKind: 'plain-directory' }),
    pragmas: Object.freeze({ journalMode: 'delete', synchronous: 3 }),
    ...overrides,
  });
}

test('Windows rollback-journal capability stays false without exact matching external VM evidence', () => {
  assert.deepEqual(WINDOWS_ROLLBACK_CRASH_CASES, CUTS);
  assert.deepEqual(NATIVE_TRANSACTION_CRASH_CUTS, CUTS);
  assert.deepEqual(inspectWindowsNativeRollbackJournalEvidence(null, currentBinding()), {
    authority: false,
    bindingMatches: false,
    completeCuts: false,
  });
  assert.deepEqual(inspectWindowsNativeRollbackJournalEvidence(
    exactEvidence({ binarySha256: 'c'.repeat(64) }),
    currentBinding(),
  ), { authority: false, bindingMatches: false, completeCuts: false });
  assert.deepEqual(inspectWindowsNativeRollbackJournalEvidence(
    exactEvidence({ cuts: Object.freeze(CUTS.slice(0, -1).map((name) => Object.freeze({ name, outcome: 'cold-converged' }))) }),
    currentBinding(),
  ), { authority: false, bindingMatches: true, completeCuts: false });
  assert.deepEqual(
    inspectWindowsNativeRollbackJournalEvidence(exactEvidence(), currentBinding()),
    { authority: false, bindingMatches: true, completeCuts: true },
  );
  assert.deepEqual(inspectWindowsNativeRollbackJournalEvidence(
    { ...exactEvidence() },
    currentBinding(),
  ), { authority: false, bindingMatches: false, completeCuts: false });
  assert.deepEqual(inspectWindowsNativeRollbackJournalEvidence(
    Object.freeze({ ...exactEvidence(), extra: true }),
    currentBinding(),
  ), { authority: false, bindingMatches: false, completeCuts: false });
});

test('runtime-constructible matching VM evidence never mints production durability authority', () => {
  assert.throws(
    () => requireWindowsNativeRollbackJournalDurability({
      buildInfo: Object.freeze({
        nativeActivationMode: 'production',
        sourceCommit: COMMIT,
        targetTriple: TRIPLE,
      }),
      evidence: exactEvidence(),
      currentBinding: currentBinding(),
    }),
    (error) => error?.code === 'DURABILITY_UNSUPPORTED',
  );
});

test('production rollback-journal preflight fails closed without mutation when VM evidence is absent', () => {
  const trace = [];
  const input = {
    buildInfo: Object.freeze({ nativeActivationMode: 'production', sourceCommit: COMMIT, targetTriple: TRIPLE }),
    evidence: null,
  };
  Object.defineProperty(input, 'currentBinding', {
    get() { trace.push('inspect'); return currentBinding(); },
  });
  assert.throws(
    () => requireWindowsNativeRollbackJournalDurability(input),
    (error) => error?.code === 'DURABILITY_UNSUPPORTED',
  );
  assert.deepEqual(trace, []);
});

test('production activation core rejects before any caller capability or activation state is observed', () => {
  const buildInfoPath = require.resolve('../build-info');
  const activationPath = require.resolve('../native/native-activation');
  const buildInfo = require(buildInfoPath);
  const original = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'production',
    sourceCommit: COMMIT,
    targetTriple: TRIPLE,
  });
  delete require.cache[activationPath];
  try {
    const { activateNativeProjectCore } = require(activationPath);
    const observed = [];
    const options = new Proxy({}, {
      get(_target, key) { observed.push(String(key)); return undefined; },
    });
    assert.throws(
      () => activateNativeProjectCore(options),
      (error) => error?.code === 'DURABILITY_UNSUPPORTED',
    );
    assert.deepEqual(observed, []);
  } finally {
    buildInfo.getBuildInfo = original;
    delete require.cache[activationPath];
  }
});
