const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WINDOWS_DIRECTORY_ENTRY_CRASH_CASES,
  inspectWindowsNativeDirectoryEvidence,
} = require('../platform/windows-native-directory-capability');

const CASES = Object.freeze([
  Object.freeze({ scenario: 'generic-event-before-publish', cut: 'controlstore.append.before-publish' }),
  Object.freeze({ scenario: 'generic-event-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync' }),
  Object.freeze({ scenario: 'checkpoint-tail-before-publish', cut: 'controlstore.tail.before-publish', whenContextEquals: Object.freeze({ operation: 'checkpoint-activation' }) }),
  Object.freeze({ scenario: 'checkpoint-tail-before-dir-fsync', cut: 'controlstore.tail.before-dir-fsync', whenContextEquals: Object.freeze({ operation: 'checkpoint-activation' }) }),
  Object.freeze({ scenario: 'checkpoint-before-publish', cut: 'controlstore.checkpoint.before-publish' }),
  Object.freeze({ scenario: 'checkpoint-before-candidate-unlink', cut: 'controlstore.checkpoint.before-candidate-unlink' }),
  Object.freeze({ scenario: 'checkpoint-before-final-dir-fsync', cut: 'controlstore.checkpoint.before-final-dir-fsync' }),
  Object.freeze({ scenario: 'checkpoint-after-final-dir-fsync', cut: 'controlstore.checkpoint.after-final-dir-fsync' }),
  Object.freeze({ scenario: 'checkpoint-before-gc', cut: 'controlstore.checkpoint.before-gc' }),
  Object.freeze({ scenario: 'checkpoint-after-gc-event', cut: 'controlstore.checkpoint.after-gc-entry', whenContextEquals: Object.freeze({ entryKind: 'event' }) }),
  Object.freeze({ scenario: 'checkpoint-after-gc-old-checkpoint', cut: 'controlstore.checkpoint.after-gc-entry', whenContextEquals: Object.freeze({ entryKind: 'old-checkpoint' }) }),
  Object.freeze({ scenario: 'checkpoint-before-gc-dir-fsync', cut: 'controlstore.checkpoint.before-gc-dir-fsync' }),
  Object.freeze({ scenario: 'retire-before-dir-fsync', cut: 'controlstore.retire.before-dir-fsync' }),
  Object.freeze({ scenario: 'activation-prepared-before-publish', cut: 'controlstore.append.before-publish', whenContextEquals: Object.freeze({ seq: 3 }) }),
  Object.freeze({ scenario: 'activation-prepared-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync', whenContextEquals: Object.freeze({ seq: 3 }) }),
  Object.freeze({ scenario: 'activation-activated-before-publish', cut: 'controlstore.append.before-publish', whenContextEquals: Object.freeze({ seq: 4 }) }),
  Object.freeze({ scenario: 'activation-activated-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync', whenContextEquals: Object.freeze({ seq: 4 }) }),
  Object.freeze({ scenario: 'activation-aborted-before-publish', cut: 'controlstore.append.before-publish', whenContextEquals: Object.freeze({ seq: 6 }) }),
  Object.freeze({ scenario: 'activation-aborted-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync', whenContextEquals: Object.freeze({ seq: 6 }) }),
]);

test('freezes the exact 19-row Windows application-directory hard-reset envelope', () => {
  assert.deepEqual(WINDOWS_DIRECTORY_ENTRY_CRASH_CASES, CASES);
  assert.equal(Object.isFrozen(WINDOWS_DIRECTORY_ENTRY_CRASH_CASES), true);
  assert.equal(new Set(CASES.map(({ scenario }) => scenario)).size, 19);
});

test('directory evidence inspection remains non-authoritative even when complete and bound', () => {
  const currentBinding = Object.freeze({
    binarySha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), targetTriple: 'x86_64-pc-windows-msvc',
    bunVersion: '1.3.14', sqliteVersion: '3.53.0', sqliteSourceId: 'source-id',
    filesystem: Object.freeze({ name: 'NTFS', bytesPerSector: 4096, rootKind: 'plain-directory' }),
  });
  const evidence = Object.freeze({
    version: 1, evidenceKind: 'windows-ntfs-vm-hard-reset-v1', ...currentBinding,
    rows: Object.freeze(CASES.map((scenario, index) => Object.freeze({
      caseIndex: index + 1, scenario: scenario.scenario, armId: `${index + 1}`.padStart(8, '0'),
      convergence: Object.freeze({ canonical: true }),
    }))),
  });
  assert.deepEqual(inspectWindowsNativeDirectoryEvidence(evidence, currentBinding), {
    authority: false, bindingMatches: true, completeRows: true,
  });
});
