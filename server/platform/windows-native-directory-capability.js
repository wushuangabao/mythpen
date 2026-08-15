const HASH_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function frozen(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

const WINDOWS_DIRECTORY_ENTRY_CRASH_CASES = frozen([
  { scenario: 'generic-event-before-publish', cut: 'controlstore.append.before-publish' },
  { scenario: 'generic-event-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync' },
  { scenario: 'checkpoint-tail-before-publish', cut: 'controlstore.tail.before-publish', whenContextEquals: { operation: 'checkpoint-activation' } },
  { scenario: 'checkpoint-tail-before-dir-fsync', cut: 'controlstore.tail.before-dir-fsync', whenContextEquals: { operation: 'checkpoint-activation' } },
  { scenario: 'checkpoint-before-publish', cut: 'controlstore.checkpoint.before-publish' },
  { scenario: 'checkpoint-before-candidate-unlink', cut: 'controlstore.checkpoint.before-candidate-unlink' },
  { scenario: 'checkpoint-before-final-dir-fsync', cut: 'controlstore.checkpoint.before-final-dir-fsync' },
  { scenario: 'checkpoint-after-final-dir-fsync', cut: 'controlstore.checkpoint.after-final-dir-fsync' },
  { scenario: 'checkpoint-before-gc', cut: 'controlstore.checkpoint.before-gc' },
  { scenario: 'checkpoint-after-gc-event', cut: 'controlstore.checkpoint.after-gc-entry', whenContextEquals: { entryKind: 'event' } },
  { scenario: 'checkpoint-after-gc-old-checkpoint', cut: 'controlstore.checkpoint.after-gc-entry', whenContextEquals: { entryKind: 'old-checkpoint' } },
  { scenario: 'checkpoint-before-gc-dir-fsync', cut: 'controlstore.checkpoint.before-gc-dir-fsync' },
  { scenario: 'retire-before-dir-fsync', cut: 'controlstore.retire.before-dir-fsync' },
  { scenario: 'activation-prepared-before-publish', cut: 'controlstore.append.before-publish', whenContextEquals: { seq: 3 } },
  { scenario: 'activation-prepared-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync', whenContextEquals: { seq: 3 } },
  { scenario: 'activation-activated-before-publish', cut: 'controlstore.append.before-publish', whenContextEquals: { seq: 4 } },
  { scenario: 'activation-activated-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync', whenContextEquals: { seq: 4 } },
  { scenario: 'activation-aborted-before-publish', cut: 'controlstore.append.before-publish', whenContextEquals: { seq: 6 } },
  { scenario: 'activation-aborted-before-dir-fsync', cut: 'controlstore.append.before-dir-fsync', whenContextEquals: { seq: 6 } },
]);

function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.isFrozen(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validBinding(value) {
  return exact(value, ['binarySha256', 'bunVersion', 'filesystem', 'sourceCommit', 'sqliteSourceId', 'sqliteVersion', 'targetTriple'])
    && HASH_PATTERN.test(value.binarySha256) && COMMIT_PATTERN.test(value.sourceCommit)
    && value.targetTriple === 'x86_64-pc-windows-msvc' && value.bunVersion === '1.3.14'
    && typeof value.sqliteVersion === 'string' && typeof value.sqliteSourceId === 'string'
    && exact(value.filesystem, ['bytesPerSector', 'name', 'rootKind'])
    && value.filesystem.name === 'NTFS' && Number.isSafeInteger(value.filesystem.bytesPerSector)
    && value.filesystem.bytesPerSector > 0 && value.filesystem.rootKind === 'plain-directory';
}

function sameBinding(left, right) {
  return left.binarySha256 === right.binarySha256
    && left.bunVersion === right.bunVersion
    && left.sourceCommit === right.sourceCommit
    && left.sqliteSourceId === right.sqliteSourceId
    && left.sqliteVersion === right.sqliteVersion
    && left.targetTriple === right.targetTriple
    && left.filesystem.name === right.filesystem.name
    && left.filesystem.bytesPerSector === right.filesystem.bytesPerSector
    && left.filesystem.rootKind === right.filesystem.rootKind;
}

function inspectWindowsNativeDirectoryEvidence(evidence, currentBinding) {
  const bindingMatches = validBinding(currentBinding) && exact(evidence, [
    'binarySha256', 'bunVersion', 'evidenceKind', 'filesystem', 'rows', 'sourceCommit',
    'sqliteSourceId', 'sqliteVersion', 'targetTriple', 'version',
  ]) && evidence.version === 1 && evidence.evidenceKind === 'windows-ntfs-vm-hard-reset-v1'
    && validBinding(frozen({
      binarySha256: evidence.binarySha256, bunVersion: evidence.bunVersion,
      filesystem: evidence.filesystem, sourceCommit: evidence.sourceCommit,
      sqliteSourceId: evidence.sqliteSourceId, sqliteVersion: evidence.sqliteVersion,
      targetTriple: evidence.targetTriple,
    })) && sameBinding(frozen({
      binarySha256: evidence.binarySha256, bunVersion: evidence.bunVersion,
      filesystem: evidence.filesystem, sourceCommit: evidence.sourceCommit,
      sqliteSourceId: evidence.sqliteSourceId, sqliteVersion: evidence.sqliteVersion,
      targetTriple: evidence.targetTriple,
    }), currentBinding);
  const armIds = new Set();
  const completeRows = bindingMatches && Array.isArray(evidence.rows) && Object.isFrozen(evidence.rows)
    && evidence.rows.length === WINDOWS_DIRECTORY_ENTRY_CRASH_CASES.length
    && evidence.rows.every((row, index) => {
      if (!exact(row, ['armId', 'caseIndex', 'convergence', 'scenario'])
        || row.caseIndex !== index + 1 || row.scenario !== WINDOWS_DIRECTORY_ENTRY_CRASH_CASES[index].scenario
        || typeof row.armId !== 'string' || row.armId.length === 0 || armIds.has(row.armId)
        || !exact(row.convergence, ['canonical']) || row.convergence.canonical !== true) return false;
      armIds.add(row.armId);
      return true;
    });
  return Object.freeze({ authority: false, bindingMatches, completeRows });
}

function requireWindowsNativeDirectoryEntryDurability() {
  if (arguments.length !== 0) {
    const error = new Error('Runtime callers cannot supply directory durability evidence');
    error.code = 'DURABILITY_UNSUPPORTED';
    throw error;
  }
  if (require('../build-info').getBuildInfo().nativeActivationMode !== 'production') return false;
  const {
    requireEmbeddedWindowsNativeDurabilityProfile,
  } = require('./windows-native-durability-profile');
  const profile = requireEmbeddedWindowsNativeDurabilityProfile();
  if (profile.directoryEntries.caseCount !== WINDOWS_DIRECTORY_ENTRY_CRASH_CASES.length) {
    const error = new Error('Embedded directory durability profile is incomplete');
    error.code = 'DURABILITY_UNSUPPORTED';
    throw error;
  }
  return profile;
}

module.exports = {
  WINDOWS_DIRECTORY_ENTRY_CRASH_CASES,
  inspectWindowsNativeDirectoryEvidence,
  requireWindowsNativeDirectoryEntryDurability,
};
