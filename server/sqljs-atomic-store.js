const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const {
  atomicReplace,
  fsyncDirectory,
  fsyncFile,
  installAbsentFromVerifiedSource: installAbsentFromVerifiedSourceDurably,
} = require('./platform/durability');
const { FAULT_POINTS, faultPoint } = require('./testing/fault-injection');

class CandidateVerificationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CandidateVerificationError';
    this.code = 'CANDIDATE_VERIFICATION_FAILED';
  }
}

class DbConnectionStaleError extends Error {
  constructor(expectedEpoch, actualEpoch) {
    super(`Database connection epoch ${expectedEpoch} is stale; current epoch is ${actualEpoch}`);
    this.name = 'DbConnectionStaleError';
    this.code = 'DB_CONNECTION_STALE';
  }
}

class RecoveryRequiredError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RecoveryRequiredError';
    this.code = 'RECOVERY_REQUIRED';
  }
}

class UnsafeStoragePathError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'UnsafeStoragePathError';
    this.code = 'UNSAFE_STORAGE_PATH';
  }
}

const JOURNAL_VERSION = 1;
const PUBLICATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROJECT_IDENTITY_TABLES = new Set([
  'volumes',
  'chapters',
  'characters',
  'relationships',
  'locations',
  'factions',
  'world_rules',
  'plot_threads',
  'timeline_events',
  'foreshadows',
  'scene_cards',
  'chapter_revisions',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalFilePath(filePath) {
  const missing = [];
  let existing = path.normalize(path.resolve(filePath));
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const physical = path.join(fs.realpathSync.native(existing), ...missing);
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

function pathsEqual(left, right) {
  return canonicalFilePath(left) === canonicalFilePath(right);
}

function assertPlainDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const relative = path.relative(root, absolute);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new UnsafeStoragePathError(
        `SQLite storage parent contains a symlink, junction, or non-directory: ${current}`,
      );
    }
  }
}

function candidatePathFor(officialPath, publicationId) {
  return path.join(
    path.dirname(officialPath),
    `.${path.basename(officialPath)}.${publicationId}.candidate.db`,
  );
}

function backupPathFor(controlDirectory, dbKey, publicationId) {
  return path.join(
    controlDirectory,
    'sqlite-recovery',
    dbKey,
    `${publicationId}.before.db`,
  );
}

function rollbackPathFor(officialPath, publicationId) {
  return path.join(
    path.dirname(officialPath),
    `.${path.basename(officialPath)}.${publicationId}.rollback.db`,
  );
}

function firstColumnRows(database, sql, cleanupErrors) {
  return columnRows(database, sql, 0, cleanupErrors);
}

function columnRows(database, sql, columnIndex, cleanupErrors) {
  const statement = database.prepare(sql);
  try {
    const rows = [];
    while (statement.step()) rows.push(statement.get()[columnIndex]);
    return rows;
  } finally {
    try {
      statement.free();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
}

function verifyDatabaseBytes(sqlModule, bytes) {
  let database;
  let primaryError;
  const cleanupErrors = [];
  try {
    database = new sqlModule.Database(bytes);
    const integrityRows = firstColumnRows(database, 'PRAGMA integrity_check', cleanupErrors);
    if (integrityRows.length !== 1 || integrityRows[0] !== 'ok') {
      throw new Error(`integrity_check returned ${JSON.stringify(integrityRows)}`);
    }
    const foreignKeyRows = firstColumnRows(database, 'PRAGMA foreign_key_check', cleanupErrors);
    if (foreignKeyRows.length !== 0) {
      throw new Error(`foreign_key_check returned ${foreignKeyRows.length} violation(s)`);
    }
  } catch (cause) {
    primaryError = cause?.code === 'CANDIDATE_VERIFICATION_FAILED'
      ? cause
      : new CandidateVerificationError('SQLite candidate verification failed', { cause });
  } finally {
    try {
      database?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (primaryError) {
    cleanupErrors.forEach((cleanupError, index) => {
      attachSecondaryFailure(
        primaryError,
        index === 0 ? 'verifierCleanupError' : `verifierCleanupError${index + 1}`,
        cleanupError,
      );
    });
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    const [cleanupPrimary, ...secondary] = cleanupErrors;
    secondary.forEach((cleanupError, index) => {
      attachSecondaryFailure(cleanupPrimary, `verifierCleanupError${index + 2}`, cleanupError);
    });
    throw cleanupPrimary;
  }
}

function inspectDatabaseBytes(sqlModule, bytes) {
  if (bytes === null) {
    return {
      isProject: false,
      schema: null,
      projectInstanceIdSha256: null,
      triggerVersion: null,
      projectMetaTriggerSetDigest: null,
      integrity: {
        integrityCheck: 'unavailable',
        foreignKeyCheck: 'unavailable',
      },
    };
  }

  let database;
  const cleanupErrors = [];
  let primaryError;
  let result;
  try {
    database = new sqlModule.Database(bytes);
    const integrityRows = firstColumnRows(database, 'PRAGMA integrity_check', cleanupErrors);
    const foreignKeyRows = firstColumnRows(database, 'PRAGMA foreign_key_check', cleanupErrors);
    if (integrityRows.length !== 1 || integrityRows[0] !== 'ok') {
      throw new CandidateVerificationError('SQLite integrity check failed');
    }
    if (foreignKeyRows.length !== 0) {
      throw new CandidateVerificationError('SQLite foreign key check failed');
    }

    const tableNames = new Set(firstColumnRows(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
      cleanupErrors,
    ));
    const hasProjectMeta = tableNames.has('project_meta');
    const metaColumns = hasProjectMeta
      ? new Set(columnRows(database, 'PRAGMA table_info(project_meta)', 1, cleanupErrors))
      : new Set();
    const hasRequiredMetaColumns = metaColumns.has('key') && metaColumns.has('value');
    const hasDomainTable = [...PROJECT_IDENTITY_TABLES]
      .some((tableName) => tableNames.has(tableName));

    const meta = new Map();
    if (hasProjectMeta && hasRequiredMetaColumns) {
      const statement = database.prepare(
        "SELECT key, value FROM project_meta WHERE key IN ('schema_version', 'project_instance_id', 'durability_trigger_version', 'durability_trigger_set_digest')",
      );
      try {
        while (statement.step()) {
          const [key, value] = statement.get();
          meta.set(String(key), String(value));
        }
      } finally {
        try {
          statement.free();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }

    const versionText = meta.get('schema_version');
    const parsedSchema = typeof versionText === 'string' && /^\d+$/.test(versionText)
      ? Number(versionText)
      : null;
    const schema = Number.isSafeInteger(parsedSchema) ? parsedSchema : null;
    const isProject = hasProjectMeta
      && hasRequiredMetaColumns
      && hasDomainTable
      && schema !== null;
    const instanceId = meta.get('project_instance_id');
    const triggerVersionText = meta.get('durability_trigger_version');
    result = {
      isProject,
      schema,
      projectInstanceIdSha256: instanceId
        ? sha256(Buffer.from(instanceId, 'utf8'))
        : null,
      triggerVersion: triggerVersionText && /^\d+$/.test(triggerVersionText)
        ? Number(triggerVersionText)
        : null,
      projectMetaTriggerSetDigest: meta.get('durability_trigger_set_digest') || null,
      integrity: {
        integrityCheck: 'ok',
        foreignKeyCheck: 'ok',
      },
    };
  } catch (cause) {
    primaryError = cause?.code === 'CANDIDATE_VERIFICATION_FAILED'
      ? cause
      : new CandidateVerificationError('SQLite diagnostic verification failed', { cause });
  } finally {
    try {
      database?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (primaryError) {
    cleanupErrors.forEach((cleanupError, index) => {
      attachSecondaryFailure(
        primaryError,
        index === 0 ? 'verifierCleanupError' : `verifierCleanupError${index + 1}`,
        cleanupError,
      );
    });
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
  return result;
}

function exportDatabase(database) {
  let bytes;
  let exportError;
  try {
    bytes = Buffer.from(database.export());
  } catch (error) {
    exportError = error;
  }

  try {
    database.run('PRAGMA foreign_keys = ON');
  } catch (restoreError) {
    if (!exportError) throw restoreError;
    attachSecondaryFailure(exportError, 'foreignKeyRestoreError', restoreError);
  }
  if (exportError) throw exportError;
  return bytes;
}

function ensureBackupDirectory(controlDirectory, dbKey, assertWriterLease = () => {}) {
  const recoveryRoot = path.join(controlDirectory, 'sqlite-recovery');
  const backupDirectory = path.join(recoveryRoot, dbKey);
  const recoveryRootExisted = fs.existsSync(recoveryRoot);
  const backupDirectoryExisted = fs.existsSync(backupDirectory);
  assertPlainDirectoryChain(controlDirectory);
  if (!recoveryRootExisted) {
    assertWriterLease();
    fs.mkdirSync(recoveryRoot);
    assertWriterLease();
    fsyncDirectory(controlDirectory);
  }
  assertPlainDirectoryChain(recoveryRoot);
  if (!backupDirectoryExisted) {
    assertWriterLease();
    fs.mkdirSync(backupDirectory);
    assertWriterLease();
    fsyncDirectory(recoveryRoot);
  }
  assertPlainDirectoryChain(backupDirectory);
  return backupDirectory;
}

function cleanTerminalArtifacts(paths, assertWriterLease = () => {}) {
  for (const artifactPath of paths) {
    if (!artifactPath) continue;
    try {
      assertPlainDirectoryChain(path.dirname(artifactPath));
      let stats;
      try {
        stats = fs.lstatSync(artifactPath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      assertWriterLease();
      fs.unlinkSync(artifactPath);
    } catch (error) {
      if (error?.code === 'WRITER_LEASE_LOST') throw error;
      // A durable terminal event is authoritative. Residual recovery artifacts
      // remain harmless and can be cleaned during a later recovery pass.
    }
  }
}

function attachSecondaryFailure(primaryError, property, secondaryError) {
  if ((typeof primaryError !== 'object' && typeof primaryError !== 'function') || primaryError === null) return;
  try {
    Object.defineProperty(primaryError, property, {
      value: secondaryError,
      configurable: true,
    });
    Object.defineProperty(primaryError, 'secondaryErrors', {
      value: [...(primaryError.secondaryErrors || []), secondaryError],
      configurable: true,
    });
  } catch {
    // Preserve the primary error identity for frozen/custom thrown values.
  }
}

function createExclusiveArtifact(filePath, bytes, assertWriterLease = () => {}) {
  const parent = path.dirname(filePath);
  assertPlainDirectoryChain(parent);
  const noFollow = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  let created = false;
  let primaryError;
  try {
    assertWriterLease();
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    created = true;
    assertWriterLease();
    fs.writeFileSync(descriptor, bytes);
    assertWriterLease();
    fs.fsyncSync(descriptor);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        attachSecondaryFailure(primaryError, 'artifactCloseError', cleanupError);
      }
    }
  }
  try {
    const identity = physicalFileIdentity(filePath);
    assertWriterLease();
    fsyncFile(filePath);
    if (!identitiesEqual(identity, physicalFileIdentity(filePath))) {
      throw new UnsafeStoragePathError(`SQLite artifact identity changed while syncing: ${filePath}`);
    }
    assertWriterLease();
    fsyncDirectory(parent);
    return identity;
  } catch (error) {
    if (created && error?.code !== 'WRITER_LEASE_LOST') {
      try {
        assertWriterLease();
        fs.unlinkSync(filePath);
      } catch (cleanupError) {
        if (cleanupError?.code === 'WRITER_LEASE_LOST') {
          attachSecondaryFailure(cleanupError, 'artifactPrimaryError', error);
          throw cleanupError;
        }
        attachSecondaryFailure(error, 'artifactCleanupError', cleanupError);
      }
    }
    throw error;
  }
}

function createOrReuseRollbackArtifact({
  assertWriterLease,
  expectedBytes,
  expectedSha256,
  filePath,
  sqlModule,
}) {
  try {
    createExclusiveArtifact(filePath, expectedBytes, assertWriterLease);
    return;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  // The path is derived solely from the validated formal path and publication
  // id. EEXIST is reusable only as exact evidence left by the same recovery.
  try {
    assertPlainDirectoryChain(path.dirname(filePath));
    assertWriterLease();
    const snapshot = readFileSnapshot(filePath);
    if (
      snapshot.bytes === null
      || snapshot.sha256 !== expectedSha256
      || !snapshot.bytes.equals(expectedBytes)
    ) {
      throw new RecoveryRequiredError('Residual rollback artifact does not match before bytes');
    }
    try {
      verifyDatabaseBytes(sqlModule, snapshot.bytes);
    } catch (cause) {
      throw new RecoveryRequiredError('Residual rollback artifact is not a healthy SQLite database', {
        cause,
      });
    }

    assertWriterLease();
    fsyncFile(filePath);
    const syncedSnapshot = readFileSnapshot(filePath);
    if (
      !identitiesEqual(snapshot.identity, syncedSnapshot.identity)
      || syncedSnapshot.sha256 !== expectedSha256
      || !syncedSnapshot.bytes.equals(expectedBytes)
    ) {
      throw new RecoveryRequiredError('Residual rollback artifact changed while being reused');
    }
    assertWriterLease();
    fsyncDirectory(path.dirname(filePath));
  } catch (cause) {
    if (cause?.code === 'WRITER_LEASE_LOST' || cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw new RecoveryRequiredError('Residual rollback artifact cannot be reused safely', { cause });
  }
}

function overwriteExistingArtifact(filePath, bytes, assertWriterLease = () => {}) {
  assertPlainDirectoryChain(path.dirname(filePath));
  const expectedIdentity = physicalFileIdentity(filePath);
  assertWriterLease();
  const descriptor = process.platform === 'win32'
    ? fs.openSync(filePath, 'r+')
    : fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    );
  let primaryError;
  try {
    assertWriterLease();
    fs.ftruncateSync(descriptor, 0);
    assertWriterLease();
    fs.writeFileSync(descriptor, bytes);
    assertWriterLease();
    fs.fsyncSync(descriptor);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      attachSecondaryFailure(primaryError, 'artifactCloseError', cleanupError);
    }
  }
  if (!identitiesEqual(expectedIdentity, physicalFileIdentity(filePath))) {
    throw new UnsafeStoragePathError(`SQLite artifact identity changed while rewriting: ${filePath}`);
  }
  assertWriterLease();
  fsyncFile(filePath);
  assertWriterLease();
  fsyncDirectory(path.dirname(filePath));
}

function hasExactKeys(value, expectedKeys) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasExactFileIdentity(value) {
  return (
    hasExactKeys(value, ['dev', 'ino'])
    && typeof value.dev === 'string'
    && /^\d+$/.test(value.dev)
    && typeof value.ino === 'string'
    && /^\d+$/.test(value.ino)
  );
}

function predicateMatchesSnapshot(predicate, snapshot) {
  const expectedExists = predicate.exists ?? true;
  return (
    expectedExists === snapshot.exists
    && predicate.sha256 === snapshot.sha256
    && (
      expectedExists === false
        ? predicate.identity === null
        : hasExactFileIdentity(predicate.identity)
          && identitiesEqual(predicate.identity, snapshot.identity)
    )
  );
}

function assertSnapshotMatchesPredicate(predicate, snapshot, message) {
  if (!predicateMatchesSnapshot(predicate, snapshot)) {
    throw new RecoveryRequiredError(message);
  }
  return snapshot;
}

function inspectPublicationJournal({
  controlDirectory,
  dbKey,
  events,
  officialPath,
}) {
  const seenPublicationIds = new Set();
  const completed = [];
  let activePrepared = null;
  let activeRollbackIntent = null;
  let latestTerminalPredicate = null;
  for (const event of events) {
    if (!String(event.type).startsWith('sqlite.publish.')) continue;
    if (![
      'sqlite.publish.prepared',
      'sqlite.publish.rollback_installing',
      'sqlite.publish.committed',
      'sqlite.publish.rolled_back',
    ].includes(event.type)) {
      throw new RecoveryRequiredError(`Unknown SQLite publication event type ${event.type}`);
    }
    if (event.payload?.dbKey !== dbKey) {
      throw new RecoveryRequiredError('SQLite publication event belongs to a different dbKey');
    }
    if (event.type === 'sqlite.publish.prepared') {
      validatePreparedEvent({ controlDirectory, dbKey, officialPath, prepared: event });
      if (activePrepared) {
        throw new RecoveryRequiredError('SQLite publications are interleaved');
      }
      if (seenPublicationIds.has(event.payload.publicationId)) {
        throw new RecoveryRequiredError('Duplicate SQLite prepared publication id');
      }
      if (latestTerminalPredicate) {
        const beforePredicate = {
          filePath: canonicalFilePath(officialPath),
          exists: event.payload.before.exists,
          sha256: event.payload.before.sha256,
          identity: event.payload.before.identity,
        };
        const normalizedTerminalPredicate = {
          filePath: canonicalFilePath(latestTerminalPredicate.filePath),
          exists: latestTerminalPredicate.exists ?? true,
          sha256: latestTerminalPredicate.sha256,
          identity: latestTerminalPredicate.identity,
        };
        if (
          beforePredicate.filePath !== normalizedTerminalPredicate.filePath
          || beforePredicate.exists !== normalizedTerminalPredicate.exists
          || beforePredicate.sha256 !== normalizedTerminalPredicate.sha256
          || (
            beforePredicate.exists
            && !identitiesEqual(beforePredicate.identity, normalizedTerminalPredicate.identity)
          )
          || (!beforePredicate.exists && normalizedTerminalPredicate.identity !== null)
        ) {
          throw new RecoveryRequiredError('SQLite publication history is not continuous');
        }
      }
      seenPublicationIds.add(event.payload.publicationId);
      activePrepared = event;
      continue;
    }

    if (event.type === 'sqlite.publish.rollback_installing') {
      if (!activePrepared || activeRollbackIntent) {
        throw new RecoveryRequiredError('SQLite rollback-install intent is out of sequence');
      }
      validateRollbackInstallingEvent({
        dbKey,
        intent: event,
        officialPath,
        prepared: activePrepared,
      });
      activeRollbackIntent = event;
      continue;
    }

    if (
      !hasExactKeys(event.payload, ['version', 'publicationId', 'dbKey'])
      || event.payload.version !== JOURNAL_VERSION
      || !PUBLICATION_ID_PATTERN.test(event.payload.publicationId)
      || !activePrepared
      || activePrepared.payload.publicationId !== event.payload.publicationId
    ) {
      throw new RecoveryRequiredError('SQLite terminal publication event is not exact');
    }
    if (activeRollbackIntent && event.type !== 'sqlite.publish.rolled_back') {
      throw new RecoveryRequiredError('SQLite rollback-install intent cannot commit');
    }
    const source = activePrepared;
    const expectedExists = event.type === 'sqlite.publish.committed'
      ? true
      : source.payload.before.exists;
    const expectedSha256 = event.type === 'sqlite.publish.committed'
      ? source.payload.after.sha256
      : source.payload.before.sha256;
    if (
      !hasExactKeys(event.afterPredicate, ['filePath', 'exists', 'sha256', 'identity'])
      || typeof event.afterPredicate.filePath !== 'string'
      || !pathsEqual(event.afterPredicate.filePath, officialPath)
      || event.afterPredicate.exists !== expectedExists
      || event.afterPredicate.sha256 !== expectedSha256
      || (expectedExists
        ? !hasExactFileIdentity(event.afterPredicate.identity)
        : event.afterPredicate.identity !== null)
    ) {
      throw new RecoveryRequiredError('SQLite terminal after predicate is not exact');
    }
    if (
      activeRollbackIntent
      && (
        event.afterPredicate.exists !== activeRollbackIntent.afterPredicate.exists
        || event.afterPredicate.sha256 !== activeRollbackIntent.afterPredicate.sha256
        || !identitiesEqual(
          event.afterPredicate.identity,
          activeRollbackIntent.afterPredicate.identity,
        )
      )
    ) {
      throw new RecoveryRequiredError('SQLite rollback terminal does not match its install intent');
    }
    if (event.type === 'sqlite.publish.committed' || event.type === 'sqlite.publish.rolled_back') {
      completed.push({ prepared: source, rollbackIntent: activeRollbackIntent, terminal: event });
      latestTerminalPredicate = event.afterPredicate;
      activePrepared = null;
      activeRollbackIntent = null;
    }
  }
  return {
    completed,
    rollbackIntent: activeRollbackIntent,
    unresolved: activePrepared ? [activePrepared] : [],
  };
}

function validateRollbackInstallingEvent({
  dbKey,
  intent,
  officialPath,
  prepared,
}) {
  const payload = intent?.payload;
  const rollback = payload?.rollback;
  const publicationId = prepared?.payload?.publicationId;
  if (
    intent?.type !== 'sqlite.publish.rollback_installing'
    || !hasExactKeys(payload, ['version', 'publicationId', 'dbKey', 'rollback'])
    || !hasExactKeys(rollback, ['path', 'sha256', 'identity'])
    || payload?.version !== JOURNAL_VERSION
    || payload?.publicationId !== publicationId
    || !PUBLICATION_ID_PATTERN.test(payload?.publicationId)
    || payload?.dbKey !== dbKey
    || prepared?.payload?.before?.exists !== true
    || typeof rollback?.path !== 'string'
    || !pathsEqual(rollback?.path, rollbackPathFor(officialPath, publicationId))
    || !SHA256_PATTERN.test(rollback?.sha256)
    || rollback?.sha256 !== prepared.payload.before.sha256
    || !hasExactFileIdentity(rollback?.identity)
    || !hasExactKeys(intent.afterPredicate, ['filePath', 'exists', 'sha256', 'identity'])
    || typeof intent.afterPredicate.filePath !== 'string'
    || !pathsEqual(intent.afterPredicate.filePath, officialPath)
    || intent.afterPredicate.exists !== true
    || intent.afterPredicate.sha256 !== rollback.sha256
    || !hasExactFileIdentity(intent.afterPredicate.identity)
    || !identitiesEqual(intent.afterPredicate.identity, rollback.identity)
  ) {
    throw new RecoveryRequiredError('SQLite rollback-install intent schema is not exact');
  }
  return payload;
}

function validatePreparedEvent({
  controlDirectory,
  dbKey,
  officialPath,
  prepared,
}) {
  const payload = prepared?.payload;
  const publicationId = payload?.publicationId;
  if (
    prepared?.type !== 'sqlite.publish.prepared'
    || !hasExactKeys(payload, [
      'version',
      'publicationId',
      'dbKey',
      'before',
      'candidate',
      'after',
    ])
    || payload?.version !== JOURNAL_VERSION
    || payload?.dbKey !== dbKey
    || !PUBLICATION_ID_PATTERN.test(publicationId)
    || !hasExactKeys(payload.before, ['exists', 'sha256', 'identity', 'backupPath'])
    || !hasExactKeys(payload.candidate, ['path', 'sha256'])
    || !hasExactKeys(payload.after, ['sha256'])
    || !hasExactKeys(prepared.afterPredicate, ['filePath', 'sha256'])
    || !SHA256_PATTERN.test(payload.after.sha256)
    || typeof payload.candidate.path !== 'string'
    || payload.candidate.sha256 !== payload.after.sha256
    || typeof prepared.afterPredicate?.filePath !== 'string'
    || !pathsEqual(prepared.afterPredicate.filePath, officialPath)
    || prepared.afterPredicate?.sha256 !== payload.after.sha256
  ) {
    throw new RecoveryRequiredError('SQLite prepared publication schema is not exact');
  }

  const expectedCandidatePath = candidatePathFor(officialPath, publicationId);
  if (!pathsEqual(payload.candidate.path, expectedCandidatePath)) {
    throw new RecoveryRequiredError('SQLite candidate path is not the controlled derived path');
  }
  if (payload.before.exists === true) {
    const expectedBackupPath = backupPathFor(controlDirectory, dbKey, publicationId);
    if (
      !SHA256_PATTERN.test(payload.before.sha256)
      || !hasExactFileIdentity(payload.before.identity)
      || typeof payload.before.backupPath !== 'string'
      || !pathsEqual(payload.before.backupPath, expectedBackupPath)
    ) {
      throw new RecoveryRequiredError('SQLite before backup path or hash is not exact');
    }
  } else if (
    payload.before.exists !== false
    || payload.before.sha256 !== null
    || payload.before.identity !== null
    || payload.before.backupPath !== null
  ) {
    throw new RecoveryRequiredError('SQLite absent before state is not exact');
  }
  return payload;
}

function readArtifact(filePath) {
  if (!filePath) return null;
  try {
    assertPlainDirectoryChain(path.dirname(filePath));
    return readFileSnapshot(filePath).bytes;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'RECOVERY_REQUIRED') throw error;
    throw new RecoveryRequiredError(`SQLite recovery artifact cannot be read safely: ${filePath}`, {
      cause: error,
    });
  }
}

function physicalFileIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new UnsafeStoragePathError(`SQLite artifact is not a plain file: ${filePath}`);
  }
  if (stats.nlink !== 1n) {
    throw new UnsafeStoragePathError(
      `SQLite artifact must have exactly one hard link: ${filePath}`,
    );
  }
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function identitiesEqual(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function readFileSnapshot(filePath) {
  let beforeIdentity;
  try {
    beforeIdentity = physicalFileIdentity(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, bytes: null, sha256: null, identity: null };
    }
    throw error;
  }
  const bytes = fs.readFileSync(filePath);
  const afterIdentity = physicalFileIdentity(filePath);
  if (!identitiesEqual(beforeIdentity, afterIdentity)) {
    throw new Error(`SQLite artifact identity changed while reading: ${filePath}`);
  }
  return {
    exists: true,
    bytes,
    sha256: sha256(bytes),
    identity: afterIdentity,
  };
}

function snapshotsEqual(left, right) {
  return (
    left?.exists === right?.exists
    && left?.sha256 === right?.sha256
    && (left?.exists === false || identitiesEqual(left?.identity, right?.identity))
  );
}

function matchesHash(bytes, expectedSha256) {
  return bytes !== null && sha256(bytes) === expectedSha256;
}

function assertPublicationJournalRetirable({ filePath, controlDirectory, events }) {
  const officialPath = path.resolve(filePath);
  const dbKey = sha256(Buffer.from(canonicalFilePath(officialPath)));
  let unresolved;
  try {
    ({ unresolved } = inspectPublicationJournal({
      controlDirectory: path.resolve(controlDirectory),
      dbKey,
      events,
      officialPath,
    }));
  } catch (cause) {
    if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
    throw new RecoveryRequiredError('SQLite publication journal cannot be retired safely', { cause });
  }
  if (unresolved.length > 0) {
    throw new RecoveryRequiredError('An unfinished SQLite publication cannot be retired');
  }
}

function inspectSqlJsAtomicStore({
  controlDirectory,
  events,
  filePath,
  sqlModule,
  supportedSchemaVersion,
}) {
  const officialPath = path.resolve(filePath);
  const canonicalPath = canonicalFilePath(officialPath);
  const dbKey = sha256(Buffer.from(canonicalPath));
  const formalSnapshot = readFileSnapshot(officialPath);
  let selectedSnapshot = formalSnapshot;
  let database = inspectDatabaseBytes(sqlModule, formalSnapshot.bytes);
  if (
    Number.isSafeInteger(database.schema)
    && Number.isSafeInteger(supportedSchemaVersion)
    && database.schema > supportedSchemaVersion
  ) {
    return {
      canAutoRecover: false,
      database,
      dbIdentity: formalSnapshot.identity,
      expectedIdentity: null,
      reasonCode: 'PROJECT_SCHEMA_TOO_NEW',
      recommendedAction: null,
      state: 'too-new',
    };
  }

  const journal = inspectPublicationJournal({
    controlDirectory: path.resolve(controlDirectory),
    dbKey,
    events,
    officialPath,
  });
  const { completed, rollbackIntent, unresolved } = journal;
  if (unresolved.length === 0) {
    const latestTerminal = completed.at(-1)?.terminal || null;
    if (latestTerminal) {
      assertSnapshotMatchesPredicate(
        latestTerminal.afterPredicate,
        formalSnapshot,
        'Formal SQLite database does not match the latest terminal predicate',
      );
    }
    if (!database.isProject) {
      return {
        canAutoRecover: false,
        database,
        dbIdentity: formalSnapshot.identity,
        expectedIdentity: latestTerminal?.afterPredicate?.identity || formalSnapshot.identity,
        reasonCode: 'PROJECT_DATABASE_NOT_PROJECT',
        recommendedAction: null,
        state: 'not-project',
      };
    }
    return {
      canAutoRecover: false,
      database,
      dbIdentity: formalSnapshot.identity,
      expectedIdentity: latestTerminal?.afterPredicate?.identity || formalSnapshot.identity,
      reasonCode: null,
      recommendedAction: null,
      state: 'clean',
    };
  }
  if (unresolved.length !== 1) {
    return {
      canAutoRecover: false,
      database,
      dbIdentity: formalSnapshot.identity,
      expectedIdentity: null,
      reasonCode: 'RECOVERY_REQUIRED',
      recommendedAction: null,
      state: 'third',
    };
  }

  const prepared = unresolved[0];
  const payload = validatePreparedEvent({
    controlDirectory: path.resolve(controlDirectory),
    dbKey,
    officialPath,
    prepared,
  });
  let disposition = null;
  let expectedIdentity = payload.before.identity;
  if (rollbackIntent) {
    const intentPayload = validateRollbackInstallingEvent({
      dbKey,
      intent: rollbackIntent,
      officialPath,
      prepared,
    });
    const rollbackSnapshot = readFileSnapshot(intentPayload.rollback.path);
    if (
      rollbackSnapshot.exists
      && !formalSnapshot.exists
      && rollbackSnapshot.sha256 === intentPayload.rollback.sha256
      && identitiesEqual(rollbackSnapshot.identity, intentPayload.rollback.identity)
    ) {
      selectedSnapshot = rollbackSnapshot;
      disposition = 'rollback';
      expectedIdentity = rollbackSnapshot.identity;
    } else if (
      !rollbackSnapshot.exists
      && predicateMatchesSnapshot(rollbackIntent.afterPredicate, formalSnapshot)
    ) {
      disposition = 'rollback';
      expectedIdentity = rollbackIntent.afterPredicate.identity;
    }
  } else if (matchesHash(formalSnapshot.bytes, payload.after.sha256)) {
    disposition = 'forward';
    expectedIdentity = formalSnapshot.identity;
  } else {
    const formalMatchesBefore = payload.before.exists
      ? matchesHash(formalSnapshot.bytes, payload.before.sha256)
        && identitiesEqual(formalSnapshot.identity, payload.before.identity)
      : !formalSnapshot.exists;
    if (formalMatchesBefore) {
      const candidateSnapshot = readFileSnapshot(payload.candidate.path);
      if (matchesHash(candidateSnapshot.bytes, payload.after.sha256)) {
        selectedSnapshot = candidateSnapshot;
        disposition = 'forward';
        expectedIdentity = candidateSnapshot.identity;
      } else {
        disposition = 'rollback';
      }
    } else if (payload.before.exists && !formalSnapshot.exists) {
      const backupSnapshot = readFileSnapshot(payload.before.backupPath);
      if (matchesHash(backupSnapshot.bytes, payload.before.sha256)) {
        selectedSnapshot = backupSnapshot;
        disposition = 'rollback';
      }
    }
  }

  if (disposition) {
    database = inspectDatabaseBytes(sqlModule, selectedSnapshot.bytes);
    if (
      Number.isSafeInteger(database.schema)
      && Number.isSafeInteger(supportedSchemaVersion)
      && database.schema > supportedSchemaVersion
    ) {
      return {
        canAutoRecover: false,
        database,
        dbIdentity: formalSnapshot.identity,
        expectedIdentity,
        reasonCode: 'PROJECT_SCHEMA_TOO_NEW',
        recommendedAction: null,
        state: 'too-new',
      };
    }
    if (!database.isProject) disposition = null;
  }

  return {
    canAutoRecover: Boolean(disposition),
    database,
    dbIdentity: formalSnapshot.identity,
    expectedIdentity,
    reasonCode: disposition === 'forward'
      ? 'V1_PUBLICATION_FORWARD_RECOVERABLE'
      : disposition === 'rollback'
        ? 'V1_PUBLICATION_ROLLBACK_RECOVERABLE'
        : 'RECOVERY_REQUIRED',
    recommendedAction: disposition ? 'recover_v1_publication' : null,
    state: disposition || 'third',
  };
}

function createAtomicStore({
  assertWriterLease = () => {},
  filePath,
  controlStore,
  installAbsentFromVerifiedSource = installAbsentFromVerifiedSourceDurably,
  sqlModule,
}) {
  if (typeof assertWriterLease !== 'function') {
    throw new TypeError('assertWriterLease must be a function');
  }
  if (typeof installAbsentFromVerifiedSource !== 'function') {
    throw new TypeError('installAbsentFromVerifiedSource must be a function');
  }
  const officialPath = path.resolve(filePath);
  const canonicalPath = canonicalFilePath(officialPath);
  const dbKey = sha256(Buffer.from(canonicalPath));
  let connectionEpoch = 0;
  let database = null;
  let databaseCleanup = null;
  let recoveryBlocked = false;
  let formalBaseline = null;
  const managedConnections = new WeakMap();
  let currentConnection = null;

  function assertEpoch(epoch) {
    if (recoveryBlocked) {
      throw new RecoveryRequiredError('Database recovery must complete before using a connection');
    }
    if (epoch !== connectionEpoch) {
      throw new DbConnectionStaleError(epoch, connectionEpoch);
    }
  }

  function manageStatement(statement, epoch) {
    return new Proxy(statement, {
      get(target, property) {
        assertEpoch(epoch);
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        return (...args) => {
          assertEpoch(epoch);
          return Reflect.apply(value, target, args);
        };
      },
      set(target, property, value) {
        assertEpoch(epoch);
        return Reflect.set(target, property, value, target);
      },
    });
  }

  function createDatabaseCleanup(rawDatabase) {
    const rawClose = Reflect.get(rawDatabase, 'close', rawDatabase);
    let closed = false;
    return () => {
      if (closed) return;
      faultPoint(FAULT_POINTS.ATOMIC_STORE_CLOSE_BEFORE_DATABASE_CLOSE, { officialPath });
      Reflect.apply(rawClose, rawDatabase, []);
      closed = true;
    };
  }

  function manageConnection(rawDatabase, epoch, cleanupDatabase) {
    const cleanupOnlyClose = () => {
      if (epoch === connectionEpoch && cleanupDatabase === databaseCleanup) {
        recoveryBlocked = true;
      }
      cleanupDatabase();
    };
    const managed = new Proxy(rawDatabase, {
      get(target, property) {
        assertEpoch(epoch);
        if (property === 'close') return cleanupOnlyClose;
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property === 'prepare') {
          return (...args) => {
            assertEpoch(epoch);
            return manageStatement(Reflect.apply(value, target, args), epoch);
          };
        }
        return (...args) => {
          assertEpoch(epoch);
          return Reflect.apply(value, target, args);
        };
      },
      set(target, property, value) {
        assertEpoch(epoch);
        return Reflect.set(target, property, value, target);
      },
      defineProperty(target, property, descriptor) {
        assertEpoch(epoch);
        return Reflect.defineProperty(target, property, descriptor);
      },
    });
    managedConnections.set(managed, { epoch, rawDatabase });
    return managed;
  }

  function installDatabase(snapshot) {
    assertWriterLease();
    let nextDatabase;
    let nextDatabaseCleanup;
    try {
      nextDatabase = snapshot.bytes === null
        ? new sqlModule.Database()
        : new sqlModule.Database(snapshot.bytes);
      nextDatabaseCleanup = createDatabaseCleanup(nextDatabase);
      nextDatabase.run('PRAGMA foreign_keys = ON');
    } catch (error) {
      try {
        nextDatabaseCleanup?.();
      } catch (cleanupError) {
        attachSecondaryFailure(error, 'nextDatabaseCleanupError', cleanupError);
      }
      throw error;
    }
    const previousDatabase = database;
    const previousDatabaseCleanup = databaseCleanup;
    try {
      previousDatabaseCleanup?.();
    } catch (error) {
      recoveryBlocked = true;
      try {
        nextDatabaseCleanup();
      } catch (cleanupError) {
        attachSecondaryFailure(error, 'nextDatabaseCleanupError', cleanupError);
      }
      throw error;
    }
    database = nextDatabase;
    databaseCleanup = nextDatabaseCleanup;
    formalBaseline = snapshot;
    connectionEpoch += 1;
    recoveryBlocked = false;
    currentConnection = manageConnection(database, connectionEpoch, databaseCleanup);
  }

  function readVerifiedCompletedState(completed) {
    const officialSnapshot = readFileSnapshot(officialPath);
    const officialBytes = officialSnapshot.bytes;
    const latestTerminal = completed.at(-1)?.terminal;
    if (latestTerminal) {
      assertSnapshotMatchesPredicate(
        latestTerminal.afterPredicate,
        officialSnapshot,
        'Formal SQLite database does not match the latest terminal predicate',
      );
    }
    if (officialBytes !== null) {
      try {
        verifyDatabaseBytes(sqlModule, officialBytes);
      } catch (cause) {
        throw new RecoveryRequiredError('Formal SQLite database cannot be verified', { cause });
      }
    }
    return officialSnapshot;
  }

  function cleanCompletedArtifacts(completed) {
    for (const { prepared } of completed) {
      const publicationId = prepared.payload.publicationId;
      cleanTerminalArtifacts([
        prepared.payload.before.backupPath,
        prepared.payload.candidate.path,
        rollbackPathFor(officialPath, publicationId),
      ], assertWriterLease);
    }
  }

  function installVerifiedRollback(sourcePath, expectedIdentity, expectedSha256) {
    try {
      return installAbsentFromVerifiedSource(
        sourcePath,
        officialPath,
        expectedIdentity,
        expectedSha256,
      );
    } catch (cause) {
      throw new RecoveryRequiredError(
        'Verified rollback installation could not complete safely',
        { cause },
      );
    }
  }

  let initialJournal = { completed: [], unresolved: [] };
  try {
    initialJournal = inspectPublicationJournal({
      controlDirectory: controlStore.directory,
      dbKey,
      events: controlStore.read(),
      officialPath,
    });
  } catch {
    recoveryBlocked = true;
  }
  if (initialJournal.unresolved.length > 0) {
    recoveryBlocked = true;
  } else if (!recoveryBlocked) {
    try {
      installDatabase(readVerifiedCompletedState(initialJournal.completed));
      cleanCompletedArtifacts(initialJournal.completed);
    } catch (error) {
      if (error?.code === 'UNSAFE_STORAGE_PATH') throw error;
      recoveryBlocked = true;
      database = null;
      formalBaseline = null;
      currentConnection = null;
    }
  }

  return {
    get connectionEpoch() {
      return connectionEpoch;
    },

    get recoveryRequired() {
      return recoveryBlocked;
    },

    currentConnection() {
      if (recoveryBlocked || !currentConnection) {
        throw new RecoveryRequiredError('Database recovery must complete before opening a connection');
      }
      return currentConnection;
    },

    assertEpoch,

    fence() {
      recoveryBlocked = true;
    },

    close() {
      if (!database) return;
      recoveryBlocked = true;
      databaseCleanup();
      database = null;
      databaseCleanup = null;
      formalBaseline = null;
      currentConnection = null;
      connectionEpoch += 1;
    },

    publish(candidateDatabase) {
      assertWriterLease();
      if (recoveryBlocked) {
        throw new RecoveryRequiredError('Database recovery must complete before publishing');
      }
      controlStore.assertCurrent();
      assertPlainDirectoryChain(path.dirname(officialPath));
      const candidateMetadata = managedConnections.get(candidateDatabase);
      if (!candidateMetadata || candidateMetadata.rawDatabase !== database) {
        throw new DbConnectionStaleError(candidateMetadata?.epoch, connectionEpoch);
      }
      assertEpoch(candidateMetadata.epoch);
      const beforeSnapshot = readFileSnapshot(officialPath);
      if (!snapshotsEqual(beforeSnapshot, formalBaseline)) {
        recoveryBlocked = true;
        throw new DbConnectionStaleError(candidateMetadata.epoch, connectionEpoch);
      }
      assertWriterLease();
      const bytes = exportDatabase(candidateDatabase);
      const publicationId = randomUUID();
      const candidatePath = candidatePathFor(officialPath, publicationId);
      const beforeBytes = beforeSnapshot.bytes;
      const beforeExists = beforeBytes !== null;
      const backupPath = beforeExists
        ? backupPathFor(controlStore.directory, dbKey, publicationId)
        : null;
      const afterSha256 = sha256(bytes);

      faultPoint(FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE, {
        candidatePath,
        publicationId,
      });
      createExclusiveArtifact(candidatePath, bytes, assertWriterLease);
      faultPoint(FAULT_POINTS.ATOMIC_STORE_PUBLISH_AFTER_CANDIDATE_WRITE, {
        candidatePath,
        publicationId,
      });
      if (faultPoint(FAULT_POINTS.ATOMIC_STORE_PUBLISH_CORRUPT_CANDIDATE, { candidatePath })) {
        overwriteExistingArtifact(
          candidatePath,
          Buffer.from('corrupt sqlite candidate'),
          assertWriterLease,
        );
      }
      let candidateSnapshot;
      try {
        candidateSnapshot = readFileSnapshot(candidatePath);
        verifyDatabaseBytes(sqlModule, candidateSnapshot.bytes);
      } catch (error) {
        assertWriterLease();
        cleanTerminalArtifacts([candidatePath], assertWriterLease);
        throw error;
      }

      if (beforeExists) {
        assertWriterLease();
        ensureBackupDirectory(controlStore.directory, dbKey, assertWriterLease);
        createExclusiveArtifact(backupPath, beforeBytes, assertWriterLease);
      }

      const afterPredicate = { filePath: canonicalPath, sha256: afterSha256 };
      const finalPredicate = {
        filePath: canonicalPath,
        exists: true,
        sha256: afterSha256,
        identity: candidateSnapshot.identity,
      };
      const preparedEvent = {
        type: 'sqlite.publish.prepared',
        payload: {
          version: JOURNAL_VERSION,
          publicationId,
          dbKey,
          before: {
            exists: beforeExists,
            sha256: beforeExists ? sha256(beforeBytes) : null,
            identity: beforeExists ? beforeSnapshot.identity : null,
            backupPath,
          },
          candidate: { path: candidatePath, sha256: afterSha256 },
          after: { sha256: afterSha256 },
        },
        afterPredicate,
      };
      try {
        assertWriterLease();
        controlStore.append(preparedEvent);
        recoveryBlocked = true;
      } catch (error) {
        assertWriterLease();
        try {
          const journalAfterFailure = inspectPublicationJournal({
            controlDirectory: controlStore.directory,
            dbKey,
            events: controlStore.read(),
            officialPath,
          });
          const publicationWasRecorded = [
            ...journalAfterFailure.completed.map(({ prepared }) => prepared),
            ...journalAfterFailure.unresolved,
          ].some((event) => event.payload.publicationId === publicationId);
          recoveryBlocked = publicationWasRecorded;
          if (!publicationWasRecorded) {
            cleanTerminalArtifacts([backupPath, candidatePath], assertWriterLease);
          }
        } catch (inspectionError) {
          recoveryBlocked = true;
          attachSecondaryFailure(error, 'publicationInspectionError', inspectionError);
        }
        throw error;
      }

      faultPoint(FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE, {
        candidatePath,
        officialPath,
        publicationId,
      });
      assertWriterLease();
      atomicReplace(candidatePath, officialPath);
      faultPoint(FAULT_POINTS.ATOMIC_STORE_PUBLISH_AFTER_REPLACE, {
        officialPath,
        publicationId,
      });
      assertWriterLease();
      fsyncDirectory(path.dirname(officialPath));
      const officialSnapshot = readFileSnapshot(officialPath);
      const officialBytes = officialSnapshot.bytes;
      verifyDatabaseBytes(sqlModule, officialBytes);
      assertSnapshotMatchesPredicate(
        finalPredicate,
        officialSnapshot,
        'Published SQLite database differs from its candidate',
      );
      assertWriterLease();
      controlStore.append({
        type: 'sqlite.publish.committed',
        payload: { version: JOURNAL_VERSION, publicationId, dbKey },
        afterPredicate: finalPredicate,
      });

      faultPoint(FAULT_POINTS.ATOMIC_STORE_PUBLISH_AFTER_TERMINAL_APPEND, {
        officialPath,
        publicationId,
      });
      const postTerminalSnapshot = assertSnapshotMatchesPredicate(
        finalPredicate,
        readFileSnapshot(officialPath),
        'Published SQLite state changed after committed terminal append',
      );

      faultPoint(FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_EPOCH_INSTALL, {
        officialPath,
        publicationId,
      });
      assertWriterLease();
      installDatabase(postTerminalSnapshot);
      cleanTerminalArtifacts([backupPath, candidatePath], assertWriterLease);
    },

    recover({ preserveLiveChanges = false } = {}) {
      assertWriterLease();
      if (preserveLiveChanges && !recoveryBlocked) {
        try {
          const liveJournal = inspectPublicationJournal({
            controlDirectory: controlStore.directory,
            dbKey,
            events: controlStore.read(),
            officialPath,
          });
          if (liveJournal.unresolved.length === 0) {
            const completedSnapshot = readVerifiedCompletedState(liveJournal.completed);
            if (snapshotsEqual(completedSnapshot, formalBaseline)) {
              assertWriterLease();
              return { status: 'live-preserved' };
            }
          }
        } catch (cause) {
          if (cause?.code === 'WRITER_LEASE_LOST') throw cause;
          // The full recovery path below fences the live epoch and reports the
          // stable recovery error. This preflight is read-only and may only
          // preserve local dirty state when both journal and formal identity
          // are provably unchanged.
        }
      }

      assertWriterLease();
      recoveryBlocked = true;
      let journal;
      try {
        journal = inspectPublicationJournal({
          controlDirectory: controlStore.directory,
          dbKey,
          events: controlStore.read(),
          officialPath,
        });
      } catch (cause) {
        recoveryBlocked = true;
        if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
        throw new RecoveryRequiredError('SQLite publication journal cannot be inspected', { cause });
      }
      const { completed, rollbackIntent, unresolved } = journal;
      if (unresolved.length === 0) {
        let completedSnapshot;
        try {
          completedSnapshot = readVerifiedCompletedState(completed);
        } catch (cause) {
          recoveryBlocked = true;
          if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
          throw new RecoveryRequiredError('Terminal SQLite state cannot be verified', { cause });
        }
        assertWriterLease();
        installDatabase(completedSnapshot);
        cleanCompletedArtifacts(completed);
        return { status: 'clean' };
      }
      if (unresolved.length !== 1) {
        recoveryBlocked = true;
        throw new RecoveryRequiredError('Multiple unfinished SQLite publications require recovery');
      }

      const prepared = unresolved[0];
      let payload;
      try {
        payload = validatePreparedEvent({
          controlDirectory: controlStore.directory,
          dbKey,
          officialPath,
          prepared,
        });
      } catch (cause) {
        recoveryBlocked = true;
        if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
        throw new RecoveryRequiredError('SQLite prepared publication cannot be inspected', { cause });
      }

      const publicationId = payload.publicationId;
      const officialSnapshot = readFileSnapshot(officialPath);
      const officialBytes = officialSnapshot.bytes;
      let backupBytes = null;
      let recoveredBytes;
      let terminalType = 'sqlite.publish.committed';
      let recoveryStatus = 'committed';
      let terminalPredicate = null;
      let rollbackPath = null;
      if (rollbackIntent) {
        const intentPayload = validateRollbackInstallingEvent({
          dbKey,
          intent: rollbackIntent,
          officialPath,
          prepared,
        });
        rollbackPath = intentPayload.rollback.path;
        let rollbackSnapshot;
        try {
          rollbackSnapshot = readFileSnapshot(rollbackPath);
        } catch (cause) {
          recoveryBlocked = true;
          throw new RecoveryRequiredError('Rollback-install artifact cannot be inspected safely', {
            cause,
          });
        }
        if (rollbackSnapshot.exists) {
          if (officialSnapshot.exists) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('Rollback-install intent has both artifact and formal state');
          }
          if (
            rollbackSnapshot.sha256 !== intentPayload.rollback.sha256
            || !identitiesEqual(rollbackSnapshot.identity, intentPayload.rollback.identity)
          ) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('Rollback-install artifact does not match its intent');
          }
          try {
            verifyDatabaseBytes(sqlModule, rollbackSnapshot.bytes);
          } catch (cause) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('Rollback-install artifact is not a healthy SQLite database', {
              cause,
            });
          }
          assertWriterLease();
          installVerifiedRollback(
            rollbackPath,
            intentPayload.rollback.identity,
            intentPayload.rollback.sha256,
          );
          faultPoint(FAULT_POINTS.ATOMIC_STORE_RECOVER_AFTER_ROLLBACK_REPLACE, {
            officialPath,
            publicationId,
            rollbackPath,
          });
          assertWriterLease();
          fsyncDirectory(path.dirname(officialPath));
          faultPoint(FAULT_POINTS.ATOMIC_STORE_RECOVER_AFTER_ROLLBACK_DIR_FSYNC, {
            officialPath,
            publicationId,
            rollbackPath,
          });
        } else {
          assertSnapshotMatchesPredicate(
            rollbackIntent.afterPredicate,
            officialSnapshot,
            'Installed rollback does not match its intent',
          );
          try {
            verifyDatabaseBytes(sqlModule, officialBytes);
          } catch (cause) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('Installed rollback is not a healthy SQLite database', {
              cause,
            });
          }
          assertWriterLease();
          fsyncDirectory(path.dirname(officialPath));
        }
        const installedSnapshot = readFileSnapshot(officialPath);
        assertSnapshotMatchesPredicate(
          rollbackIntent.afterPredicate,
          installedSnapshot,
          'Installed rollback changed before terminal publication',
        );
        recoveredBytes = installedSnapshot.bytes;
        terminalType = 'sqlite.publish.rolled_back';
        recoveryStatus = 'rolled_back';
        terminalPredicate = rollbackIntent.afterPredicate;
      } else if (matchesHash(officialBytes, payload.after.sha256)) {
        recoveredBytes = officialBytes;
        terminalPredicate = {
          filePath: canonicalPath,
          exists: true,
          sha256: payload.after.sha256,
          identity: officialSnapshot.identity,
        };
      } else {
        const officialMatchesBefore = payload.before.exists
          ? matchesHash(officialBytes, payload.before.sha256)
            && identitiesEqual(officialSnapshot.identity, payload.before.identity)
          : officialBytes === null;
        const canRestoreMissingBefore = (
          payload.before.exists
          && officialBytes === null
        );
        if (!officialMatchesBefore && !canRestoreMissingBefore) {
          recoveryBlocked = true;
          throw new RecoveryRequiredError('SQLite publication does not match an exact recoverable state');
        }
        if (officialBytes !== null) {
          try {
            verifyDatabaseBytes(sqlModule, officialBytes);
          } catch (cause) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('SQLite formal before state cannot be verified', { cause });
          }
        }

        if (canRestoreMissingBefore) {
          backupBytes = readArtifact(payload.before.backupPath);
          if (!matchesHash(backupBytes, payload.before.sha256)) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('SQLite before backup does not match its recorded hash');
          }
          try {
            verifyDatabaseBytes(sqlModule, backupBytes);
          } catch (cause) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('SQLite before backup cannot be verified', { cause });
          }
          rollbackPath = rollbackPathFor(officialPath, publicationId);
          createOrReuseRollbackArtifact({
            assertWriterLease,
            expectedBytes: backupBytes,
            expectedSha256: payload.before.sha256,
            filePath: rollbackPath,
            sqlModule,
          });
          const rollbackSnapshot = readFileSnapshot(rollbackPath);
          if (
            rollbackSnapshot.sha256 !== payload.before.sha256
            || !rollbackSnapshot.bytes.equals(backupBytes)
          ) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('Rollback artifact changed before intent publication');
          }
          const rollbackIntent = {
            type: 'sqlite.publish.rollback_installing',
            payload: {
              version: JOURNAL_VERSION,
              publicationId,
              dbKey,
              rollback: {
                path: rollbackPath,
                sha256: payload.before.sha256,
                identity: rollbackSnapshot.identity,
              },
            },
            afterPredicate: {
              filePath: canonicalPath,
              exists: true,
              sha256: payload.before.sha256,
              identity: rollbackSnapshot.identity,
            },
          };
          validateRollbackInstallingEvent({
            dbKey,
            intent: rollbackIntent,
            officialPath,
            prepared,
          });
          assertWriterLease();
          controlStore.append(rollbackIntent);
          const intentArtifactSnapshot = readFileSnapshot(rollbackPath);
          const formalBeforeInstall = readFileSnapshot(officialPath);
          if (
            formalBeforeInstall.exists
            || intentArtifactSnapshot.sha256 !== rollbackIntent.payload.rollback.sha256
            || !identitiesEqual(
              intentArtifactSnapshot.identity,
              rollbackIntent.payload.rollback.identity,
            )
          ) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError(
              'Rollback artifact or formal state changed after intent publication',
            );
          }
          try {
            verifyDatabaseBytes(sqlModule, intentArtifactSnapshot.bytes);
          } catch (cause) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError(
              'Rollback artifact is not healthy after intent publication',
              { cause },
            );
          }
          assertWriterLease();
          installVerifiedRollback(
            rollbackPath,
            rollbackIntent.payload.rollback.identity,
            rollbackIntent.payload.rollback.sha256,
          );
          faultPoint(FAULT_POINTS.ATOMIC_STORE_RECOVER_AFTER_ROLLBACK_REPLACE, {
            officialPath,
            publicationId,
            rollbackPath,
          });
          assertWriterLease();
          fsyncDirectory(path.dirname(officialPath));
          faultPoint(FAULT_POINTS.ATOMIC_STORE_RECOVER_AFTER_ROLLBACK_DIR_FSYNC, {
            officialPath,
            publicationId,
            rollbackPath,
          });
          recoveredBytes = fs.readFileSync(officialPath);
          if (!matchesHash(recoveredBytes, payload.before.sha256)) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('Rollback-restored SQLite database differs from its before hash');
          }
          terminalType = 'sqlite.publish.rolled_back';
          recoveryStatus = 'rolled_back';
          terminalPredicate = rollbackIntent.afterPredicate;
        } else {
          let candidateSnapshot;
          try {
            candidateSnapshot = readFileSnapshot(payload.candidate.path);
          } catch (cause) {
            recoveryBlocked = true;
            throw new RecoveryRequiredError('SQLite recovery candidate cannot be inspected safely', {
              cause,
            });
          }
          if (matchesHash(candidateSnapshot.bytes, payload.after.sha256)) {
            try {
              verifyDatabaseBytes(sqlModule, candidateSnapshot.bytes);
            } catch (cause) {
              recoveryBlocked = true;
              throw new RecoveryRequiredError('SQLite recovery candidate cannot be verified', { cause });
            }
            assertWriterLease();
            atomicReplace(payload.candidate.path, officialPath);
            assertWriterLease();
            fsyncDirectory(path.dirname(officialPath));
            recoveredBytes = fs.readFileSync(officialPath);
            if (!matchesHash(recoveredBytes, payload.after.sha256)) {
              recoveryBlocked = true;
              throw new RecoveryRequiredError('Forward-recovered SQLite database differs from its after hash');
            }
            terminalPredicate = {
              filePath: canonicalPath,
              exists: true,
              sha256: payload.after.sha256,
              identity: candidateSnapshot.identity,
            };
          } else {
            recoveredBytes = officialBytes;
            terminalType = 'sqlite.publish.rolled_back';
            recoveryStatus = 'rolled_back';
            terminalPredicate = {
              filePath: canonicalPath,
              exists: payload.before.exists,
              sha256: payload.before.sha256,
              identity: payload.before.identity,
            };
          }
        }
      }

      if (recoveredBytes !== null) {
        try {
          verifyDatabaseBytes(sqlModule, recoveredBytes);
        } catch (cause) {
          recoveryBlocked = true;
          throw new RecoveryRequiredError('Recovered SQLite state cannot be verified', { cause });
        }
      }

      faultPoint(FAULT_POINTS.ATOMIC_STORE_RECOVER_BEFORE_TERMINAL_APPEND, {
        officialPath,
        publicationId,
        terminalType,
      });
      assertWriterLease();
      assertSnapshotMatchesPredicate(
        terminalPredicate,
        readFileSnapshot(officialPath),
        'Recovered SQLite state changed before terminal publication',
      );
      controlStore.append({
        type: terminalType,
        payload: { version: JOURNAL_VERSION, publicationId, dbKey },
        afterPredicate: terminalPredicate,
      });
      faultPoint(FAULT_POINTS.ATOMIC_STORE_RECOVER_AFTER_TERMINAL_APPEND, {
        officialPath,
        publicationId,
        terminalType,
      });
      const recoveredSnapshot = assertSnapshotMatchesPredicate(
        terminalPredicate,
        readFileSnapshot(officialPath),
        'Recovered SQLite state changed after terminal publication',
      );
      assertWriterLease();
      installDatabase(recoveredSnapshot);
      cleanTerminalArtifacts([
        prepared.payload.before.backupPath,
        prepared.payload.candidate.path,
        rollbackPath,
      ], assertWriterLease);
      return { status: recoveryStatus, publicationId };
    },
  };
}

module.exports = {
  assertPublicationJournalRetirable,
  canonicalDatabasePath: canonicalFilePath,
  createAtomicStore,
  inspectProjectDatabaseBytes: inspectDatabaseBytes,
  inspectSqlJsAtomicStore,
};
