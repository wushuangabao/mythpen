const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const WINDOWS_ROLLBACK_CRASH_CASES = Object.freeze([
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
const NATIVE_TRANSACTION_CRASH_CUTS = WINDOWS_ROLLBACK_CRASH_CASES;

function exactObject(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.isFrozen(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function exactFilesystem(value) {
  return exactObject(value, ['bytesPerSector', 'name', 'rootKind'])
    && value.name === 'NTFS'
    && Number.isSafeInteger(value.bytesPerSector)
    && value.bytesPerSector > 0
    && value.rootKind === 'plain-directory';
}

function exactPragmas(value) {
  return exactObject(value, ['journalMode', 'synchronous'])
    && value.journalMode === 'delete'
    && value.synchronous === 3;
}

function sameBinding(evidence, current) {
  return evidence.binarySha256 === current.binarySha256
    && evidence.sourceCommit === current.sourceCommit
    && evidence.targetTriple === current.targetTriple
    && evidence.bunVersion === current.bunVersion
    && evidence.sqliteVersion === current.sqliteVersion
    && evidence.sqliteSourceId === current.sqliteSourceId
    && evidence.filesystem.name === current.filesystem.name
    && evidence.filesystem.bytesPerSector === current.filesystem.bytesPerSector
    && evidence.filesystem.rootKind === current.filesystem.rootKind
    && evidence.pragmas.journalMode === current.pragmas.journalMode
    && evidence.pragmas.synchronous === current.pragmas.synchronous;
}

function validBinding(value) {
  return exactObject(value, [
    'binarySha256', 'bunVersion', 'filesystem', 'pragmas', 'sourceCommit',
    'sqliteSourceId', 'sqliteVersion', 'targetTriple',
  ])
    && HASH_PATTERN.test(value.binarySha256)
    && COMMIT_PATTERN.test(value.sourceCommit)
    && value.targetTriple === 'x86_64-pc-windows-msvc'
    && value.bunVersion === '1.3.14'
    && /^3\.[0-9]+\.[0-9]+$/.test(value.sqliteVersion)
    && typeof value.sqliteSourceId === 'string'
    && value.sqliteSourceId.length > 0
    && exactFilesystem(value.filesystem)
    && exactPragmas(value.pragmas);
}

function inspectWindowsNativeRollbackJournalEvidence(evidence, currentBinding) {
  const bindingMatches = validBinding(currentBinding)
    && exactObject(evidence, [
    'binarySha256', 'bunVersion', 'cuts', 'evidenceKind', 'filesystem', 'pragmas',
    'sourceCommit', 'sqliteSourceId', 'sqliteVersion', 'targetTriple', 'version',
    ])
    && evidence.version === 1
    && evidence.evidenceKind === 'windows-ntfs-vm-hard-reset-v1'
    && validBinding(Object.freeze({
      binarySha256: evidence.binarySha256,
      bunVersion: evidence.bunVersion,
      filesystem: evidence.filesystem,
      pragmas: evidence.pragmas,
      sourceCommit: evidence.sourceCommit,
      sqliteSourceId: evidence.sqliteSourceId,
      sqliteVersion: evidence.sqliteVersion,
      targetTriple: evidence.targetTriple,
    }))
    && sameBinding(evidence, currentBinding);
  const completeCuts = bindingMatches
    && Array.isArray(evidence.cuts)
    && Object.isFrozen(evidence.cuts)
    && evidence.cuts.length === NATIVE_TRANSACTION_CRASH_CUTS.length
    && !evidence.cuts.some((cut, index) => (
      !exactObject(cut, ['name', 'outcome'])
      || cut.name !== NATIVE_TRANSACTION_CRASH_CUTS[index]
      || cut.outcome !== 'cold-converged'
    ));
  return Object.freeze({
    authority: false,
    bindingMatches,
    completeCuts,
  });
}

function requireWindowsNativeRollbackJournalDurability() {
  if (arguments.length !== 0) {
    const error = new Error('Runtime callers cannot supply rollback-journal durability evidence');
    error.code = 'DURABILITY_UNSUPPORTED';
    throw error;
  }
  if (require('../build-info').getBuildInfo().nativeActivationMode !== 'production') return false;
  const {
    requireEmbeddedWindowsNativeDurabilityProfile,
  } = require('./windows-native-durability-profile');
  const profile = requireEmbeddedWindowsNativeDurabilityProfile();
  if (
    profile.rollbackJournal.caseCount !== WINDOWS_ROLLBACK_CRASH_CASES.length
    || profile.rollbackJournal.pragmas.journalMode !== 'delete'
    || profile.rollbackJournal.pragmas.synchronous !== 3
  ) {
    const error = new Error('Embedded rollback-journal durability profile is incomplete');
    error.code = 'DURABILITY_UNSUPPORTED';
    throw error;
  }
  return profile;
}

module.exports = {
  NATIVE_TRANSACTION_CRASH_CUTS,
  WINDOWS_ROLLBACK_CRASH_CASES,
  inspectWindowsNativeRollbackJournalEvidence,
  requireWindowsNativeRollbackJournalDurability,
};
