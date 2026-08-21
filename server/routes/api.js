const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { sendJsonError } = require('../json-error-middleware');
const { writeChapterBody } = require('../manuscript-service');
const { getManuscriptRuntime } = require('../manuscript/runtime');
const {
  publishGeneratedProjectFile,
  publishOpaqueDiagnosticsExport,
  publishProjectExport,
} = require('../project-export');
const { readRecentProject } = require('../recent-projects');
const { normalizeCharacterName } = require('../character-validation');
const { clampTimelineImportance } = require('../timeline-importance');
const { orderTimelineEvents, validateTimelineEventOrder } = require('../timeline-order');
const { serializeWorldTags } = require('../world-tags');
const { isValidWorldEntryCategory, worldEntryCategoryError } = require('../world-entry-categories');
const {
  applyRevision,
  createPendingRevision,
  getActiveRevision,
  updateRevisionDecisions,
} = require('../chapter-revisions');

const CHARACTER_ROLES = new Set(['major', 'minor', 'extra']);
const PROJECT_INSTANCE_HEADER = 'X-Mythpen-Project-Instance';
const REQUEST_ID_HEADER = 'X-Mythpen-Request-Id';
const COVER_FILE_NAMES = ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp', 'cover.gif'];
const RECOVERY_ACTIONS = new Set([
  'recover_transaction',
  'recover_v1_publication',
  'adopt_same_path_identity',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FILES_PROJECT_ICON = Object.freeze({
  'sci-fi': 'Rocket', fantasy: 'Wand', romance: 'Heart', history: 'Landmark',
  urban: 'Building', 'power-fantasy': 'Zap', biography: 'BookOpen', other: 'Scroll',
});
const FILES_PROJECT_GENRE_LABEL = Object.freeze({
  'sci-fi': '科幻', fantasy: '玄幻', romance: '言情', history: '历史', urban: '都市',
  'power-fantasy': '爽文', biography: '传记', other: '其他',
});

function isPlainJsonObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainJsonObject(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length
    && actualKeys.every((key, index) => key === sortedExpected[index]);
}

function hasEmptyQuery(req) {
  return req.query === undefined || Object.keys(req.query).length === 0;
}

function invalidFilesParams(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_PARAMS';
  throw error;
}

function canonicalFilesUid(value, label) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    invalidFilesParams(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function filesBody(value, allowedKeys, requiredKeys = ['base_witness']) {
  if (!isPlainJsonObject(value)) invalidFilesParams('files request body must be an object');
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowedKeys.includes(key))
    || requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) invalidFilesParams('files request body has an invalid shape');
  return value;
}

function filesUidArray(value, label) {
  if (!Array.isArray(value)) invalidFilesParams(`${label} must be a UID array`);
  const result = value.map((uid, index) => canonicalFilesUid(uid, `${label}[${index}]`));
  if (new Set(result).size !== result.length) invalidFilesParams(`${label} contains duplicates`);
  return Object.freeze(result);
}

function nullableFilesUid(value, label) {
  return value === null ? null : canonicalFilesUid(value, label);
}

function nonNegativePosition(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidFilesParams(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function optionalPositiveInteger(value, label) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    invalidFilesParams(`${label} must be null or a positive safe integer`);
  }
  return value;
}

function optionalString(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') invalidFilesParams(`${label} must be a string`);
  return value;
}

function invalidDiagnosticsParams(res) {
  return sendJsonError(res, 'INVALID_PARAMS');
}

function project(name) {
  // The :project router guard has already verified this database. Keep the
  // helper for call-site readability without creating missing projects.
  return name;
}

function getSafeProjectCoverLocation(projectName) {
  const projectsDir = path.resolve(path.dirname(db.getProjectDbPath('')));
  const coverDir = path.resolve(db.getCoverDir(projectName));
  const relativeCoverDir = path.relative(projectsDir, coverDir);
  const isDirectChild = relativeCoverDir
    && !path.isAbsolute(relativeCoverDir)
    && relativeCoverDir !== '..'
    && !relativeCoverDir.startsWith(`..${path.sep}`)
    && !relativeCoverDir.includes(path.sep);
  if (!isDirectChild) {
    const error = new Error(`Unsafe project cover path: ${coverDir}`);
    error.code = 'UNSAFE_PROJECT_COVER_PATH';
    throw error;
  }

  return coverDir;
}

function ensureWritableProjectCoverDirectory(projectName) {
  const coverDir = getSafeProjectCoverLocation(projectName);
  try {
    const stat = fs.lstatSync(coverDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      const error = new Error(`Unsafe project cover container: ${coverDir}`);
      error.code = 'UNSAFE_PROJECT_COVER_CONTAINER';
      throw error;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(coverDir, { recursive: true });
  }
  return coverDir;
}

function rollbackStagedProjectCoverFiles(stagedFiles) {
  const rollbackErrors = [];
  for (const staged of [...stagedFiles].reverse()) {
    try {
      fs.renameSync(staged.tombstonePath, staged.originalPath);
    } catch (error) {
      if (error.code !== 'ENOENT') rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

function stageProjectCoverFiles(projectName) {
  const coverDir = getSafeProjectCoverLocation(projectName);

  let coverDirStat;
  try {
    coverDirStat = fs.lstatSync(coverDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  // Never traverse a link supplied in place of the project's cover directory.
  // Stage the link/container itself and leave its target untouched.
  if (coverDirStat.isSymbolicLink() || !coverDirStat.isDirectory()) {
    const tombstonePath = `${coverDir}.cover-delete-${randomUUID()}`;
    fs.renameSync(coverDir, tombstonePath);
    return [{ originalPath: coverDir, tombstonePath }];
  }

  const stagedFiles = [];
  for (const fileName of COVER_FILE_NAMES) {
    const originalPath = path.join(coverDir, fileName);
    const tombstonePath = path.join(coverDir, `.${fileName}.cover-delete-${randomUUID()}`);
    try {
      fs.renameSync(originalPath, tombstonePath);
      stagedFiles.push({ originalPath, tombstonePath });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      const rollbackErrors = rollbackStagedProjectCoverFiles(stagedFiles);
      if (rollbackErrors.length > 0) {
        console.error(`[Project Delete] Failed to roll back staged covers for "${projectName}":`, rollbackErrors);
      }
      throw error;
    }
  }
  return stagedFiles;
}

function retireStagedProjectCoverFiles(projectName, stagedFiles) {
  for (const staged of stagedFiles) {
    try {
      fs.unlinkSync(staged.tombstonePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Tombstones are deliberately not recognised by findCoverPath. Once
        // the database is gone, cleanup failure must not make a replacement
        // project inherit the retired cover.
        console.warn(`[Project Delete] Failed to clean cover tombstone for "${projectName}":`, error);
      }
    }
  }
}

router.use((req, res, next) => {
  if (
    req.method !== 'POST'
    || !/^\/[^/]+\/manuscript\/orphans\/(?:ignore-in-place|revoke-ignore)\/?$/.test(req.path)
  ) return next();
  try {
    if (!hasEmptyQuery(req)) invalidFilesParams('orphan request query must be empty');
    const body = filesBody(req.body, ['kind', 'uid'], ['kind', 'uid']);
    if (body.kind !== 'chapter' && body.kind !== 'volume') {
      invalidFilesParams('orphan kind must be chapter or volume');
    }
    req.filesOrphanRequest = Object.freeze({
      kind: body.kind,
      uid: canonicalFilesUid(body.uid, 'orphan uid'),
    });
    filesRequestId(req);
    return next();
  } catch (error) {
    if (error?.code === 'INVALID_PARAMS') return sendJsonError(res, error.code);
    return next(error);
  }
});

router.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const match = /^\/[^/]+\/manuscript\/draft-conflicts\/([^/]+)\/(copy-backup|accept-external|apply-saved-draft)\/?$/.exec(req.path);
  if (match === null) return next();
  try {
    if (!hasEmptyQuery(req)) invalidFilesParams('draft conflict request query must be empty');
    const conflictId = canonicalFilesUid(match[1], 'draft conflict id');
    const action = match[2];
    const body = action === 'copy-backup'
      ? filesBody(req.body, [], [])
      : filesBody(req.body, ['decision_epoch'], ['decision_epoch']);
    const decisionEpoch = action === 'copy-backup' ? null : body.decision_epoch;
    if (
      decisionEpoch !== null
      && (!Number.isSafeInteger(decisionEpoch) || decisionEpoch < 0 || Object.is(decisionEpoch, -0))
    ) invalidFilesParams('draft conflict decision_epoch must be a non-negative safe integer');
    req.filesDraftConflictRequest = Object.freeze({ action, conflictId, decisionEpoch });
    filesRequestId(req);
    return next();
  } catch (error) {
    if (error?.code === 'INVALID_PARAMS') return sendJsonError(res, error.code);
    return next(error);
  }
});

router.use((req, res, next) => {
  if (
    req.method !== 'POST'
    || !/^\/[^/]+\/manuscript\/ignored\/reference\/?$/.test(req.path)
  ) return next();
  try {
    if (!hasEmptyQuery(req)) invalidFilesParams('ignored reference query must be empty');
    const body = filesBody(req.body, ['action', 'uid'], ['action', 'uid']);
    if (
      body.action !== 'ignored.preserve_move_to_unassigned'
      && body.action !== 'ignored.detach_reference'
    ) invalidFilesParams('ignored reference action is unsupported');
    req.filesIgnoredReferenceRequest = Object.freeze({
      action: body.action,
      uid: canonicalFilesUid(body.uid, 'ignored chapter uid'),
    });
    filesRequestId(req);
    return next();
  } catch (error) {
    if (error?.code === 'INVALID_PARAMS') return sendJsonError(res, error.code);
    return next(error);
  }
});

router.param('project', (req, res, next, name) => {
  const expectedInstanceId = req.get(PROJECT_INSTANCE_HEADER) || '';
  return db.runWithProjectInstance(name, expectedInstanceId, () => {
    try {
      req.manuscriptAdmission = db.inspectProjectManuscriptRoute(name);
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND') return sendJsonError(res, error.code);
      return next(error);
    }
    if (req.manuscriptAdmission.route === 'files') return next();
    if (req.manuscriptAdmission.route === 'migrating') {
      const error = new Error('Project migration is in progress');
      error.code = 'PROJECT_MIGRATION_BUSY';
      return next(error);
    }
    if (req.manuscriptAdmission.route === 'retired') {
      const error = new Error('Project is retired');
      error.code = 'RECOVERY_REQUIRED';
      return next(error);
    }
    if (
      req.method === 'PUT'
      && Object.prototype.hasOwnProperty.call(req.body || {}, 'content')
      && /\/chapters\/[^/]+\/?$/.test(req.path)
    ) {
      return next();
    }
    try {
      db.getProjectDb(name);
      next();
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND' || error?.code === 'PROJECT_INSTANCE_MISMATCH') {
        return sendJsonError(res, error.code);
      }
      next(error);
    }
  });
});

function isFilesRequest(req) {
  return req.manuscriptAdmission?.route === 'files';
}

function filesProjectSelector(req) {
  return Object.freeze({
    projectUid: req.manuscriptAdmission.databaseFacts.projectUid,
  });
}

function filesRequestId(req) {
  const requestId = req.get(REQUEST_ID_HEADER) || '';
  if (!requestId) {
    const error = new Error(`${REQUEST_ID_HEADER} is required for files mutations`);
    error.code = 'INVALID_PARAMS';
    throw error;
  }
  return requestId;
}

function filesBaseWitness(body) {
  const witness = body?.base_witness;
  if (!hasExactKeys(witness, [
    'expected_data_version',
    'generation',
    'raw_sha256',
    'sidecar_raw_sha256',
  ])) invalidFilesParams('base_witness has an invalid shape');
  if (
    !Number.isSafeInteger(witness.expected_data_version)
    || witness.expected_data_version < 0
    || !Number.isSafeInteger(witness.generation)
    || witness.generation < 0
    || typeof witness.raw_sha256 !== 'string'
    || !SHA256_PATTERN.test(witness.raw_sha256)
    || (
      witness.sidecar_raw_sha256 !== null
      && (
        typeof witness.sidecar_raw_sha256 !== 'string'
        || !SHA256_PATTERN.test(witness.sidecar_raw_sha256)
      )
    )
  ) invalidFilesParams('base_witness contains invalid values');
  return Object.freeze({
    expectedDataVersion: witness.expected_data_version,
    generation: witness.generation,
    rawSha256: witness.raw_sha256,
    sidecarRawSha256: witness.sidecar_raw_sha256 ?? null,
  });
}

function serializeFilesBaseWitness(witness) {
  return {
    expected_data_version: witness.expectedDataVersion,
    generation: witness.generation,
    raw_sha256: witness.rawSha256,
    sidecar_raw_sha256: witness.sidecarRawSha256,
  };
}

function filesChapterIdentity(req) {
  return {
    manuscript_project_uid: req.manuscriptAdmission.databaseFacts.projectUid,
    project_instance_id: req.manuscriptAdmission.databaseFacts.projectInstanceId,
  };
}

function serializeFilesChapter(req, chapter, generation) {
  return {
    ...chapter,
    ...filesChapterIdentity(req),
    ...(Number.isSafeInteger(generation) ? {
      base_witness: serializeFilesBaseWitness({
        expectedDataVersion: chapter.data_version,
        generation,
        rawSha256: chapter.body_raw_sha256,
        sidecarRawSha256: chapter.sidecar_raw_sha256,
      }),
    } : {}),
  };
}

function serializeFilesVolumes(req, volumes, generation) {
  return volumes.map((volume) => ({
    ...volume,
    chapters: (volume.chapters || []).map((chapter) => serializeFilesChapter(req, chapter, generation)),
  }));
}

function sendFilesRead(req, res, result) {
  return res.json({
    ...serializeFilesChapter(req, result.value, result.baseWitness.generation),
    base_witness: serializeFilesBaseWitness(result.baseWitness),
  });
}

function filesRevisionDecisions(value, label) {
  if (!isPlainJsonObject(value)) invalidFilesParams(`${label} must be an object`);
  const decisions = {};
  for (const [changeId, decision] of Object.entries(value)) {
    if (!changeId || (decision !== 'accepted' && decision !== 'rejected')) {
      invalidFilesParams(`${label} contains an invalid decision`);
    }
    decisions[changeId] = decision;
  }
  return Object.freeze(decisions);
}

function sendFilesRevisionConflict(res, result, missingMessage) {
  if (result.reason === 'chapter_missing' || result.reason === 'revision_missing') {
    return sendJsonError(res, 'DB_NOT_FOUND', missingMessage);
  }
  return sendJsonError(res, 'EXTERNAL_DRAFT_CONFLICT', '待审修订已失效，请刷新后重试');
}

// ─── Shared helpers ───
function updateRecord(projectName, table, id, body, allowedFields, addUpdatedAt) {
  const fields = []; const params = [];
  const data = body || {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) { fields.push(`${key} = ?`); params.push(data[key]); }
  }
  if (fields.length === 0) return null;
  if (addUpdatedAt) fields.push("updated_at = datetime('now')");
  params.push(id);
  const changes = db.projectExecute(projectName, `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`, params);
  return changes;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ambiguousChapterResponse(res, chapterNum) {
  return res.status(409).json({
    error: {
      code: 'AMBIGUOUS_CHAPTER',
      message: `多个卷中存在第 ${chapterNum} 章，请提供 chapter_id，或同时提供 volume_id 和章节号`,
      recoverable: true,
    },
  });
}

function createLegacySqliteProject({ name, mode, language, genres, filePath }) {
  const projectDb = db.createProjectDb(name);
  const metaInsert = projectDb.prepare(
    'INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)',
  );
  const now = new Date().toISOString();
  const meta = {
    name,
    description: '',
    mode,
    language,
    version: '1',
    created_at: now,
    updated_at: now,
    word_count: '0',
    author_name: '佚名',
    workflow_phase: 'idea',
  };
  for (const [key, value] of Object.entries(meta)) metaInsert.run(key, value);
  projectDb.prepare(
    "INSERT INTO volumes (id, sort_order, title, summary) VALUES (1, 1, '第一卷', '')",
  ).run();
  for (const genre of genres) {
    projectDb.prepare('INSERT OR IGNORE INTO project_genres (genre) VALUES (?)').run(genre);
  }
  const config = db.getConfigDb();
  config.prepare(`
    INSERT OR REPLACE INTO recent_projects
      (id, name, file_path, last_opened, word_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, name, filePath, now, 0);
  const instanceId = projectDb
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get()?.value;
  projectDb.flush();
  config.flush();
  return Object.freeze({ instanceId });
}

function listLegacySqliteChapters(projectName) {
  return db.projectQuery(
    projectName,
    'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id ORDER BY c.num',
  );
}

function readLegacySqliteChapter(projectName, chapterId) {
  return db.projectGet(projectName, 'SELECT id FROM chapters WHERE id = ?', [chapterId]);
}

function resolveLegacySqliteChapter(projectName, { chapterId, chapterNum, volumeId }) {
  if (chapterId) {
    const volumeClause = volumeId ? ' AND c.volume_id = ?' : '';
    return Object.freeze({
      ambiguous: false,
      row: db.projectGet(
        projectName,
        `SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.id = ? AND c.num = ?${volumeClause}`,
        volumeId ? [chapterId, chapterNum, volumeId] : [chapterId, chapterNum],
      ),
    });
  }
  if (volumeId) {
    return Object.freeze({
      ambiguous: false,
      row: db.projectGet(
        projectName,
        'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.num = ? AND c.volume_id = ?',
        [chapterNum, volumeId],
      ),
    });
  }
  const candidates = db.projectQuery(
    projectName,
    'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.num = ? ORDER BY c.volume_id, c.id',
    [chapterNum],
  );
  return Object.freeze({ ambiguous: candidates.length > 1, row: candidates[0] });
}

function createLegacySqliteChapter(projectName, input) {
  const num = input.chapterNum === undefined
    ? (db.projectGet(
      projectName,
      'SELECT MAX(num) as mx FROM chapters WHERE volume_id = ?',
      [input.volumeId],
    )?.mx || 0) + 1
    : input.chapterNum;
  db.projectExecute(
    projectName,
    "INSERT INTO chapters (volume_id, num, title, outline, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    [input.volumeId, num, input.title, input.outline, input.status],
  );
  return db.projectGet(
    projectName,
    'SELECT * FROM chapters WHERE volume_id = ? AND num = ?',
    [input.volumeId, num],
  );
}

function updateLegacySqliteChapter(projectName, input) {
  let targetChapter;
  if (input.chapterId !== null) {
    targetChapter = db.projectGet(
      projectName,
      'SELECT id, num FROM chapters WHERE id = ?',
      [input.chapterId],
    );
    if (targetChapter && Number(targetChapter.num) !== input.chapterNum) {
      return Object.freeze({ disposition: 'identity_mismatch' });
    }
  } else {
    const candidates = db.projectQuery(
      projectName,
      'SELECT id FROM chapters WHERE num = ?',
      [input.chapterNum],
    );
    if (candidates.length > 1) return Object.freeze({ disposition: 'ambiguous' });
    targetChapter = candidates[0];
  }
  if (!targetChapter) return Object.freeze({ disposition: 'missing' });

  const fields = [];
  const params = [];
  for (const [field, value] of Object.entries(input.patch)) {
    if (value !== undefined) {
      fields.push(`${field} = ?`);
      params.push(value);
    }
  }
  fields.push("updated_at = datetime('now')");
  params.push(targetChapter.id);
  if (input.expectedDataVersion !== undefined) params.push(input.expectedDataVersion);
  const versionClause = input.expectedDataVersion === undefined ? '' : ' AND data_version = ?';
  const sql = `UPDATE chapters SET ${fields.join(', ')} WHERE id = ?${versionClause}`;
  const projectDb = db.getProjectDb(projectName);
  return projectDb.transaction(() => {
    const changes = projectDb.prepare(sql).run(...params).changes;
    if (changes === 0) {
      const current = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(targetChapter.id);
      if (!current) return Object.freeze({ disposition: 'missing' });
      if (input.expectedDataVersion !== undefined) {
        return Object.freeze({ disposition: 'conflict', current });
      }
      return Object.freeze({ disposition: 'missing' });
    }
    db.updateProjectWordCount(projectDb);
    return Object.freeze({
      disposition: 'updated',
      updated: projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(targetChapter.id),
    });
  })();
}

function deleteLegacySqliteChapter(projectName, { chapterId, chapterNum, volumeId }) {
  const projectDb = db.getProjectDb(projectName);
  let targetChapter;
  if (chapterId) {
    const volumeClause = volumeId ? ' AND volume_id = ?' : '';
    targetChapter = projectDb
      .prepare(`SELECT id, volume_id, num FROM chapters WHERE id = ? AND num = ?${volumeClause}`)
      .get(...(volumeId ? [chapterId, chapterNum, volumeId] : [chapterId, chapterNum]));
  } else if (volumeId) {
    targetChapter = projectDb
      .prepare('SELECT id, volume_id, num FROM chapters WHERE volume_id = ? AND num = ?')
      .get(volumeId, chapterNum);
  } else {
    const candidates = projectDb
      .prepare('SELECT id, volume_id, num FROM chapters WHERE num = ? ORDER BY volume_id, id')
      .all(chapterNum);
    if (candidates.length > 1) return Object.freeze({ disposition: 'ambiguous' });
    targetChapter = candidates[0];
  }
  if (!targetChapter) return Object.freeze({ disposition: 'missing' });
  const changes = projectDb.transaction(() => {
    projectDb.prepare('DELETE FROM chapter_revisions WHERE chapter_id = ?').run(targetChapter.id);
    const deleted = projectDb.prepare('DELETE FROM chapters WHERE id = ?').run(targetChapter.id).changes;
    if (deleted > 0) db.updateProjectWordCount(projectDb);
    return deleted;
  })();
  if (changes === 0) return Object.freeze({ disposition: 'missing' });
  return Object.freeze({ disposition: 'deleted', chapter: Object.freeze({ ...targetChapter }) });
}

function listLegacySqliteVolumes(projectName) {
  const rows = db.projectQuery(projectName, 'SELECT * FROM volumes ORDER BY sort_order');
  for (const volume of rows) {
    volume.chapters = db.projectQuery(
      projectName,
      'SELECT * FROM chapters WHERE volume_id = ? ORDER BY num',
      [volume.id],
    );
  }
  return rows;
}

function createLegacySqliteVolume(projectName, { title, summary }) {
  const projectDb = db.getProjectDb(projectName);
  const max = projectDb.prepare('SELECT COALESCE(MAX(sort_order), 0) as mx FROM volumes').get();
  const sortOrder = (max?.mx || 0) + 1;
  const result = projectDb.prepare(
    "INSERT INTO volumes (sort_order, title, summary, created_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(sortOrder, title, summary);
  return Object.freeze({ id: result.lastInsertRowid, title });
}

function updateLegacySqliteVolume(projectName, id, body) {
  const fields = [];
  const params = [];
  for (const key of ['title', 'summary']) {
    if (body?.[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(body[key]);
    }
  }
  if (fields.length === 0) return null;
  params.push(id);
  return db.projectExecute(
    projectName,
    `UPDATE volumes SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
}

function deleteLegacySqliteVolume(projectName, id) {
  const projectDb = db.getProjectDb(projectName);
  return projectDb.transaction(() => {
    projectDb.prepare('DELETE FROM chapters WHERE volume_id = ?').run(id);
    const deleted = projectDb.prepare('DELETE FROM volumes WHERE id = ?').run(id).changes;
    if (deleted > 0) db.updateProjectWordCount(projectDb);
    return deleted;
  })();
}

function readLegacySqliteCharacterAssociations(projectName) {
  const characters = db.projectQuery(projectName, 'SELECT * FROM characters ORDER BY name');
  const appearanceRows = db.projectQuery(projectName, `
    SELECT
      cc.character_id,
      c.id AS chapter_id,
      c.volume_id,
      c.num,
      c.title,
      COALESCE(cc.role, 'appears') AS role
    FROM chapter_characters cc
    JOIN chapters c ON c.id = cc.chapter_id
    LEFT JOIN volumes v ON v.id = c.volume_id
    ORDER BY
      CASE WHEN v.id IS NULL THEN 1 ELSE 0 END ASC,
      v.sort_order ASC,
      CASE WHEN c.volume_id IS NULL THEN 1 ELSE 0 END ASC,
      c.volume_id ASC,
      c.num ASC,
      c.id ASC
  `);
  const appearancesByCharacter = new Map();
  for (const appearance of appearanceRows) {
    const appearances = appearancesByCharacter.get(appearance.character_id) || [];
    appearances.push({
      chapter_id: appearance.chapter_id,
      volume_id: appearance.volume_id,
      num: appearance.num,
      title: appearance.title,
      role: appearance.role,
    });
    appearancesByCharacter.set(appearance.character_id, appearances);
  }
  for (const character of characters) {
    character.appearances = appearancesByCharacter.get(character.id) || [];
    character.chapterCount = character.appearances.length;
  }
  return characters;
}

function createLegacySqliteForeshadow(projectName, input) {
  db.projectExecute(
    projectName,
    'INSERT INTO foreshadows (id, title, description, status, priority, expected_resolve_chapter) VALUES (?, ?, ?, ?, ?, ?)',
    [
      input.id,
      input.title,
      input.description,
      input.status,
      input.priority,
      input.expectedResolveChapter,
    ],
  );
}

function readLegacySqliteStats(projectName) {
  const totalWords = db.projectGet(projectName, 'SELECT SUM(word_count) as total FROM chapters')?.total || 0;
  const chapterCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM chapters')?.cnt || 0;
  const acceptedCount = db.projectGet(projectName, "SELECT COUNT(*) as cnt FROM chapters WHERE status = 'accepted'")?.cnt || 0;
  const characterCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM characters')?.cnt || 0;
  const foreshadowCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM foreshadows')?.cnt || 0;
  const resolvedForeshadow = db.projectGet(projectName, "SELECT COUNT(*) as cnt FROM foreshadows WHERE status = 'resolved'")?.cnt || 0;
  const overdueForeshadow = db.projectGet(projectName, "SELECT COUNT(*) as cnt FROM foreshadows WHERE status = 'planted' AND expected_resolve_chapter < (SELECT COALESCE(MAX(num), 0) FROM chapters)")?.cnt || 0;
  const worldCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM world_entries')?.cnt || 0;
  const sciCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM science_entries')?.cnt || 0;
  const relationCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM character_relations')?.cnt || 0;
  const memoryCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM memories')?.cnt || 0;
  const timelineCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM timeline_events')?.cnt || 0;
  const volumeCount = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM volumes')?.cnt || 0;
  const clueUnresolved = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM clue_board WHERE resolved = 0')?.cnt || 0;
  const clueResolved = db.projectGet(projectName, 'SELECT COUNT(*) as cnt FROM clue_board WHERE resolved = 1')?.cnt || 0;
  const genres = db.projectQuery(projectName, 'SELECT genre FROM project_genres').map((row) => row.genre);
  const tokenUsage = db.projectGet(projectName, 'SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output FROM token_usage') || { input: 0, output: 0 };
  const projectMode = db.projectGet(projectName, "SELECT value FROM project_meta WHERE key = 'mode'")?.value || 'medium-novel';
  const targetDefaults = { 'short-story': 30000, 'medium-novel': 100000, 'long-novel': 200000 };
  const customTarget = db.projectGet(projectName, "SELECT value FROM project_meta WHERE key = 'target_words'")?.value;
  const targetWords = customTarget ? parseInt(customTarget) : (targetDefaults[projectMode] || 100000);
  const volumes = db.projectQuery(projectName, 'SELECT id, title, sort_order, (SELECT COUNT(*) FROM chapters WHERE volume_id = volumes.id) as chapter_count, (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE volume_id = volumes.id) as word_count FROM volumes ORDER BY sort_order');
  const rawDaily = db.projectQuery(
    projectName,
    "SELECT date(updated_at) as day, SUM(word_count) as words FROM chapters WHERE updated_at >= date('now', '-6 days') GROUP BY date(updated_at) ORDER BY day",
  );
  const dailyMap = Object.fromEntries(rawDaily.map((row) => [row.day, row.words]));
  const dailyWords = [];
  for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    dailyWords.push(dailyMap[date.toISOString().slice(0, 10)] || 0);
  }
  return {
    totalWords,
    chapterCount,
    acceptedCount,
    characterCount,
    foreshadowCount,
    resolvedForeshadow,
    overdueForeshadow,
    worldCount,
    sciCount,
    relationCount,
    memoryCount,
    timelineCount,
    volumeCount,
    volumes,
    clueUnresolved,
    clueResolved,
    genres,
    tokenInput: tokenUsage.input || 0,
    tokenOutput: tokenUsage.output || 0,
    targetWords,
    currentChapter: db.projectGet(projectName, "SELECT * FROM chapters WHERE status = 'writing' ORDER BY num LIMIT 1"),
    chapters: db.projectQuery(projectName, 'SELECT id, num, title, word_count, status FROM chapters ORDER BY num'),
    dailyWords,
  };
}

function readLegacySqliteExportSnapshot(projectName) {
  const chapters = db.projectQuery(projectName, `
    SELECT
      c.id,
      c.num,
      c.title,
      c.content,
      c.volume_id,
      v.sort_order AS volume_sort_order,
      v.title AS volume_title,
      v.summary AS volume_summary
    FROM chapters c
    LEFT JOIN volumes v ON v.id = c.volume_id
    WHERE c.content != ''
    ORDER BY
      CASE WHEN v.id IS NULL THEN 1 ELSE 0 END ASC,
      v.sort_order ASC,
      c.volume_id ASC,
      c.num ASC,
      c.id ASC
  `);
  const volumes = db.projectQuery(projectName, 'SELECT * FROM volumes ORDER BY sort_order');
  const meta = {};
  for (const row of db.projectQuery(projectName, 'SELECT key, value FROM project_meta')) {
    meta[row.key] = row.value;
  }
  return Object.freeze({ chapters, volumes, meta: Object.freeze(meta) });
}

function getTimelineSortMode(projectName) {
  const mode = db.projectGet(
    projectName,
    "SELECT value FROM project_meta WHERE key = 'timeline_sort_mode'",
  )?.value;
  return mode === 'auto' ? 'auto' : 'manual';
}

function listTimelineEvents(projectName) {
  const rows = db.projectQuery(
    projectName,
    'SELECT * FROM timeline_events ORDER BY sort_order ASC, created_at ASC, id ASC',
  );
  return orderTimelineEvents(rows, getTimelineSortMode(projectName));
}

// ═══════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════

router.get('/projects', async (req, res, next) => {
  try {
  const rows = db.dbQuery('SELECT * FROM recent_projects ORDER BY last_opened DESC');
  const routeRecords = db.listProjectRouteCache();
  const routeByName = new Map(routeRecords.map((record) => [record.name, record]));
  const rowsByName = new Map(rows.map((row) => [row.name, row]));
  for (const record of routeRecords) {
    if (rowsByName.has(record.name)) continue;
    rowsByName.set(record.name, {
      id: record.name,
      name: record.name,
      file_path: record.filePath,
      last_opened: record.lastModified,
      word_count: 0,
    });
  }
  const projects = await Promise.all([...rowsByName.values()].map((row) => readRecentProject(row, {
      getProjectOpenState: db.getProjectOpenState,
      openProjectDb: db.openProjectDb,
      recordProjectOpenFailure: db.recordProjectOpenFailure,
      async readFilesRecentSummary(currentRow) {
        const record = routeByName.get(currentRow.name);
        if (record === undefined || record.route === 'sqlite') return null;
        if (record.route !== 'files') {
          return {
            id: currentRow.id,
            name: currentRow.name,
            iconName: 'BookOpen',
            genres: [],
            wordCount: currentRow.word_count || 0,
            chapterCount: 0,
            lastOpened: currentRow.last_opened,
            mode: 'medium-novel',
            instanceId: record.projectInstanceId || '',
            status: '未知',
            openState: 'isolated',
            reasonCode: record.route === 'migrating'
              ? 'PROJECT_MIGRATION_BUSY'
              : 'RECOVERY_REQUIRED',
            recommendedAction: null,
            manuscriptRoute: record.route,
          };
        }
        const result = await getManuscriptRuntime().read(
          Object.freeze({ projectUid: record.projectUid }),
          Object.freeze({ kind: 'product_view' }),
        );
        const view = result.value;
        const genres = view.metadata.genres || [];
        const wordCount = view.summary.wordCount;
        return {
          id: currentRow.id,
          name: currentRow.name,
          iconName: genres.map((genre) => FILES_PROJECT_ICON[genre] || 'BookOpen').join(' ') || 'BookOpen',
          genres: genres.map((genre) => FILES_PROJECT_GENRE_LABEL[genre] || genre),
          wordCount,
          chapterCount: view.summary.chapterCount,
          lastOpened: currentRow.last_opened || record.lastModified,
          mode: view.metadata.mode || 'medium-novel',
          instanceId: record.projectInstanceId,
          status: wordCount > 30000 ? '写作中' : wordCount > 5000 ? '进行中' : '刚起步',
          openState: 'ready',
          reasonCode: null,
          recommendedAction: null,
          manuscriptRoute: 'files',
        };
      },
    })));
  projects.sort((left, right) => (
    left.lastOpened > right.lastOpened ? -1 : left.lastOpened < right.lastOpened ? 1 : 0
  ));
  return res.json(projects);
  } catch (error) {
    return next(error);
  }
});

router.post('/projects', (req, res) => {
  const { name, mode = 'medium-novel', language = 'zh', genres = ['other'] } = req.body || {};
  if (!name) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '项目名称不能为空', recoverable: true } });

  const filePath = db.getProjectDbPath(name);
  if (require('fs').existsSync(filePath)) {
    return res.status(409).json({ error: { code: 'PROJECT_ALREADY_EXISTS', message: `项目"${name}"已存在`, recoverable: true } });
  }

  const { instanceId } = createLegacySqliteProject({ name, mode, language, genres, filePath });
  res.json({ name, filePath, mode, language, genres, instanceId });
});

router.post('/projects/files-beta', async (req, res, next) => {
  if (
    !hasEmptyQuery(req)
    || !hasExactKeys(req.body, ['genres', 'language', 'mode', 'name'])
  ) return invalidDiagnosticsParams(res);
  try {
    return res.status(201).json(await getManuscriptRuntime().createProject(Object.freeze({
      requestId: filesRequestId(req),
      name: req.body.name,
      mode: req.body.mode,
      language: req.body.language,
      genres: req.body.genres,
    })));
  } catch (error) {
    return next(error);
  }
});

router.post('/projects/by-name/:name/files-beta/migrate', async (req, res, next) => {
  if (!hasEmptyQuery(req) || !hasExactKeys(req.body, [])) {
    return invalidDiagnosticsParams(res);
  }
  try {
    return res.json(await getManuscriptRuntime().migrateProject(Object.freeze({
      projectSelector: Object.freeze({ projectName: req.params.name }),
      requestId: filesRequestId(req),
    })));
  } catch (error) {
    return next(error);
  }
});

router.get('/projects/by-name/:name/files-beta/status', (req, res, next) => {
  if (req.body !== undefined || !hasEmptyQuery(req)) return invalidDiagnosticsParams(res);
  try {
    const admission = db.inspectProjectManuscriptRoute(req.params.name);
    const facts = admission.route === 'files' ? admission.databaseFacts : admission;
    return res.json({
      route: admission.route,
      project_uid: facts.projectUid ?? null,
      project_instance_id: facts.projectInstanceId ?? null,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/testing/native-fixture', (req, res, next) => {
  if (!hasEmptyQuery(req)) return invalidDiagnosticsParams(res);
  try {
    const { getFixtureNativeActivationInfo } = require('../native/native-activation-controller');
    return res.json(getFixtureNativeActivationInfo());
  } catch (error) {
    return next(error);
  }
});

router.post('/projects/by-name/:name/durability/native', async (req, res, next) => {
  if (!hasEmptyQuery(req) || !hasExactKeys(req.body, [])) {
    return invalidDiagnosticsParams(res);
  }
  const expectedInstanceId = req.get(PROJECT_INSTANCE_HEADER) || '';
  if (!expectedInstanceId) return invalidDiagnosticsParams(res);
  try {
    return res.json(await db.enableNativeProject(req.params.name, expectedInstanceId));
  } catch (error) {
    return next(error);
  }
});

router.get('/projects/by-name/:name/diagnostics', (req, res, next) => {
  if (req.body !== undefined || !hasEmptyQuery(req)) {
    return invalidDiagnosticsParams(res);
  }
  try {
    return res.json(db.inspectRegisteredProject(req.params.name));
  } catch (error) {
    return next(error);
  }
});

router.post('/projects/by-name/:name/diagnostics/recover', (req, res, next) => {
  if (
    !hasEmptyQuery(req)
    || !hasExactKeys(req.body, ['action', 'snapshot'])
    || typeof req.body.action !== 'string'
    || typeof req.body.snapshot !== 'string'
    || !RECOVERY_ACTIONS.has(req.body.action)
    || !SHA256_PATTERN.test(req.body.snapshot)
  ) {
    return invalidDiagnosticsParams(res);
  }
  try {
    return res.json(db.recoverRegisteredProject(req.params.name, req.body));
  } catch (error) {
    return next(error);
  }
});

router.post('/projects/by-name/:name/diagnostics/export', (req, res, next) => {
  if (!hasEmptyQuery(req) || !hasExactKeys(req.body, [])) {
    return invalidDiagnosticsParams(res);
  }
  try {
    const diagnostics = db.inspectRegisteredProject(req.params.name);
    const currentDatabaseSha256 = db.getRegisteredProjectDatabaseSha256(req.params.name);
    return res.json(publishOpaqueDiagnosticsExport({
      exportDir: db.getExportDir(),
      diagnostics,
      currentDatabaseSha256,
    }));
  } catch (error) {
    return next(error);
  }
});

async function sendProjectMetadata(req, res, next) {
  const { name } = req.params;
  const expectedInstanceId = req.get(PROJECT_INSTANCE_HEADER) || '';
  return db.runWithProjectInstance(name, expectedInstanceId, async () => {
    try {
      const admission = db.inspectProjectManuscriptRoute(name);
      if (admission.route === 'files') {
        const result = await getManuscriptRuntime().read(
          Object.freeze({ projectUid: admission.databaseFacts.projectUid }),
          Object.freeze({ kind: 'product_view' }),
        );
        return res.json({ ...result.value.metadata, filePath: db.getProjectDbPath(name) });
      }
      const pdb = db.getProjectDb(name);
      const meta = {};
      pdb.prepare('SELECT key, value FROM project_meta').all().forEach(m => meta[m.key] = m.value);
      const genres = pdb.prepare('SELECT genre FROM project_genres').all().map(g => g.genre);
      res.json({ ...meta, genres, filePath: db.getProjectDbPath(name) });
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND' || error?.code === 'PROJECT_INSTANCE_MISMATCH') {
        return sendJsonError(res, error.code);
      }
      next(error);
    }
  });
}

// The explicit metadata path is unambiguous even when a project itself is
// named "projects". Keep the legacy two-segment route below for callers whose
// project name does not collide with a project-data resource.
router.get('/projects/by-name/:name', sendProjectMetadata);

router.get('/projects/:name', (req, res, next) => {
  const expectedInstanceId = req.get(PROJECT_INSTANCE_HEADER) || '';
  if (expectedInstanceId) {
    try {
      // GET /projects/chapters can mean either metadata for a project named
      // "chapters" or the chapter list of a project named "projects". Modern
      // project-data requests carry the latter project's immutable token, so
      // let the later /:project/chapters route handle that interpretation.
      db.assertProjectInstance('projects', expectedInstanceId);
      return next('route');
    } catch (error) {
      if (error?.code !== 'PROJECT_NOT_FOUND' && error?.code !== 'PROJECT_INSTANCE_MISMATCH') {
        return next(error);
      }
    }
  }
  return sendProjectMetadata(req, res, next);
});

function deleteProject(req, res) {
  const { name } = req.params;
  const filePath = db.getProjectDbPath(name);
  let stagedCoverFiles = [];
  try {
    try {
      const route = db.inspectProjectManuscriptRoute(name);
      if (route.route === 'files') {
        return res.status(409).json({
          error: {
            code: 'PROJECT_PERMANENT_DELETE_UNSUPPORTED',
            message: '文件权威项目不支持永久物理删除',
            recoverable: true,
          },
        });
      }
    } catch (error) {
      if (error?.code !== 'PROJECT_NOT_FOUND') throw error;
    }
    try {
      db.assertProjectInstance(name, req.get(PROJECT_INSTANCE_HEADER) || '');
    } catch (error) {
      if (error?.code !== 'PROJECT_NOT_FOUND') throw error;
      // Deleting an already absent project is idempotent.
    }
    db.closeProjectDb(filePath);
    // Hide name-keyed covers with atomic same-filesystem renames. The original
    // names can be restored precisely if deleting the database fails.
    stagedCoverFiles = stageProjectCoverFiles(name);
  } catch (error) {
    if (error?.code === 'PROJECT_INSTANCE_MISMATCH') {
      return sendJsonError(res, error.code);
    }
    console.error(`[Project Delete] Failed to prepare "${filePath}" for deletion:`, error);
    return res.status(500).json({
      error: {
        code: 'PROJECT_DELETE_FAILED',
        message: `无法删除项目"${name}"，请稍后重试`,
        recoverable: true,
      },
    });
  }
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    // Deleting an already-absent project is idempotent. Every other filesystem
    // failure means the project still exists and must not be reported as
    // deleted: the client retires all recoverable drafts only after this 200.
    if (error.code !== 'ENOENT') {
      const rollbackErrors = rollbackStagedProjectCoverFiles(stagedCoverFiles);
      if (rollbackErrors.length > 0) {
        console.error(`[Project Delete] Failed to restore covers for "${name}":`, rollbackErrors);
      }
      console.error(`[Project Delete] Failed to remove "${filePath}":`, error);
      return res.status(500).json({
        error: {
          code: 'PROJECT_DELETE_FAILED',
          message: `无法删除项目"${name}"，请稍后重试`,
          recoverable: true,
        },
      });
    }
  }
  retireStagedProjectCoverFiles(name, stagedCoverFiles);
  db.dbExecute('DELETE FROM recent_projects WHERE name = ?', [name]);
  db.getConfigDb().flush();
  db.removeProjectOpenState(filePath);
  res.json({ success: true });
}

// New clients use an unambiguous path so a project can itself be named after
// either the static "projects" prefix or a project-data resource.
router.delete('/projects/by-name/:name', deleteProject);

router.delete('/projects/:name', (req, res, next) => {
  const expectedInstanceId = req.get(PROJECT_INSTANCE_HEADER) || '';
  const projectDataDeleteResources = new Set(['cover', 'target-words']);
  if (expectedInstanceId && projectDataDeleteResources.has(req.params.name)) {
    try {
      // DELETE /projects/cover can mean deleting the project named "cover" or
      // deleting the cover belonging to the project named "projects". The
      // immutable token makes that intent unambiguous.
      db.assertProjectInstance('projects', expectedInstanceId);
      return next('route');
    } catch (error) {
      if (error?.code !== 'PROJECT_NOT_FOUND' && error?.code !== 'PROJECT_INSTANCE_MISMATCH') {
        return next(error);
      }
    }
  }
  return deleteProject(req, res);
});

// ─── Sidebar Items (genre-filtered) ───
router.get('/:project/sidebar-items', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      const result = await getManuscriptRuntime().read(
        Object.freeze({ projectUid: req.manuscriptAdmission.databaseFacts.projectUid }),
        Object.freeze({ kind: 'product_view' }),
      );
      return res.json(result.value.sidebarItems);
    } catch (error) {
      return next(error);
    }
  }
  const pdb = db.getProjectDb(req.params.project);
  try {
    const genres = pdb.prepare('SELECT genre FROM project_genres').all().map((g) => g.genre);
    const items = pdb.prepare('SELECT * FROM sidebar_items WHERE enabled = 1 ORDER BY sort_order').all();
    const filtered = items.filter((item) => {
      if (item.category === 'universal') return true;
      if (item.category === 'genre') {
        const itemGenres = item.genres ? item.genres.split(',').map((s) => s.trim()) : [];
        return genres.some((g) => itemGenres.includes(g));
      }
      return false;
    });
    res.json(filtered);
  } catch (e) {
    sendJsonError(res, 'INTERNAL_ERROR');
  }
});

// ═══════════════════════════════════════════
// CHAPTERS
// ═══════════════════════════════════════════

router.get('/:project/manuscript/witness', async (req, res, next) => {
  if (!isFilesRequest(req)) return res.json({ base_witness: null });
  try {
    const result = await getManuscriptRuntime().read(
      filesProjectSelector(req),
      Object.freeze({ kind: 'project' }),
    );
    return res.json({ base_witness: serializeFilesBaseWitness(result.baseWitness) });
  } catch (error) { return next(error); }
});

router.get('/:project/manuscript/draft-conflicts', async (req, res, next) => {
  if (!isFilesRequest(req)) {
    return sendJsonError(res, 'INVALID_PARAMS', '草稿冲突恢复仅供 files 项目使用');
  }
  try {
    if (!hasEmptyQuery(req)) invalidFilesParams('draft conflict list query must be empty');
    return res.json(await getManuscriptRuntime().listDraftConflicts(filesProjectSelector(req)));
  } catch (error) { return next(error); }
});

async function resolveFilesDraftConflict(req, res, next, action) {
  if (!isFilesRequest(req)) {
    return sendJsonError(res, 'INVALID_PARAMS', '草稿冲突恢复仅供 files 项目使用');
  }
  try {
    const request = req.filesDraftConflictRequest;
    if (request === undefined || request.action !== action) {
      invalidFilesParams('draft conflict request was not preflighted');
    }
    const selector = filesProjectSelector(req);
    const requestId = filesRequestId(req);
    if (action === 'copy-backup') {
      return res.json(await getManuscriptRuntime().copyDraftConflictBackup(
        selector,
        Object.freeze({ conflictId: request.conflictId, requestId }),
      ));
    }
    const resolutionAction = action === 'accept-external'
      ? 'accept_external'
      : 'apply_saved_draft';
    return res.json(await getManuscriptRuntime().resolveDraftConflict(
      selector,
      Object.freeze({
        action: resolutionAction,
        conflictId: request.conflictId,
        decisionEpoch: request.decisionEpoch,
        requestId,
      }),
    ));
  } catch (error) {
    if (error?.code === 'PROJECTION_STALE') {
      return sendJsonError(res, 'RECOVERY_SNAPSHOT_STALE');
    }
    return next(error);
  }
}

router.post('/:project/manuscript/draft-conflicts/:conflictId/copy-backup', (req, res, next) => (
  resolveFilesDraftConflict(req, res, next, 'copy-backup')
));

router.post('/:project/manuscript/draft-conflicts/:conflictId/accept-external', (req, res, next) => (
  resolveFilesDraftConflict(req, res, next, 'accept-external')
));

router.post('/:project/manuscript/draft-conflicts/:conflictId/apply-saved-draft', (req, res, next) => (
  resolveFilesDraftConflict(req, res, next, 'apply-saved-draft')
));

async function resolveFilesOrphan(req, res, next, method) {
  if (!isFilesRequest(req)) {
    return sendJsonError(res, 'INVALID_PARAMS', '孤儿资源动作仅供 files 项目使用');
  }
  try {
    const request = req.filesOrphanRequest;
    if (request === undefined) invalidFilesParams('orphan request was not preflighted');
    const result = await getManuscriptRuntime()[method](
      filesProjectSelector(req),
      Object.freeze({
        requestId: filesRequestId(req),
        kind: request.kind,
        uid: request.uid,
      }),
    );
    return res.json(result);
  } catch (error) { return next(error); }
}

router.post('/:project/manuscript/orphans/ignore-in-place', (req, res, next) => (
  resolveFilesOrphan(req, res, next, 'ignoreInPlace')
));

router.post('/:project/manuscript/orphans/revoke-ignore', (req, res, next) => (
  resolveFilesOrphan(req, res, next, 'revokeIgnore')
));

router.post('/:project/manuscript/ignored/reference', async (req, res, next) => {
  if (!isFilesRequest(req)) {
    return sendJsonError(res, 'INVALID_PARAMS', 'ignored 结构动作仅供 files 项目使用');
  }
  try {
    const request = req.filesIgnoredReferenceRequest;
    if (request === undefined) invalidFilesParams('ignored reference request was not preflighted');
    const selector = filesProjectSelector(req);
    const snapshot = await getManuscriptRuntime().read(
      selector,
      Object.freeze({ kind: 'project' }),
    );
    const result = await getManuscriptRuntime().write(selector, Object.freeze({
      requestId: filesRequestId(req),
      baseWitness: snapshot.baseWitness,
      command: Object.freeze({
        kind: request.action,
        chapterUid: request.uid,
      }),
    }));
    return res.json(result);
  } catch (error) { return next(error); }
});

router.get('/:project/chapters', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      const result = await getManuscriptRuntime().read(
        filesProjectSelector(req),
        Object.freeze({ kind: 'chapters' }),
      );
      return res.json(result.value.map((chapter) => (
        serializeFilesChapter(req, chapter, result.baseWitness.generation)
      )));
    } catch (error) { return next(error); }
  }
  res.json(listLegacySqliteChapters(project(req.params.project)));
});

router.get('/:project/chapters/:chapterId/revisions/active', async (req, res, next) => {
  const projectName = project(req.params.project);
  if (isFilesRequest(req)) {
    try {
      if (!hasEmptyQuery(req)) invalidFilesParams('files active revision query must be empty');
      const chapterUid = canonicalFilesUid(req.params.chapterId, 'chapter_uid');
      const result = await getManuscriptRuntime().read(
        filesProjectSelector(req),
        Object.freeze({ kind: 'revision_snapshot', chapterUid }),
      );
      return res.json(result.value);
    } catch (error) { return next(error); }
  }
  const chapterId = Number(req.params.chapterId);
  if (!Number.isSafeInteger(chapterId) || chapterId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节标识无效', recoverable: true } });
  }
  const chapter = readLegacySqliteChapter(projectName, chapterId);
  if (!chapter) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '章节不存在', recoverable: true } });
  }
  res.json(getActiveRevision(projectName, chapterId));
});

router.post('/:project/chapters/:chapterId/revisions', async (req, res, next) => {
  const projectName = project(req.params.project);
  const { baseContent, proposedContent } = req.body || {};
  if (isFilesRequest(req)) {
    try {
      const chapterUid = canonicalFilesUid(req.params.chapterId, 'chapter_uid');
      const body = filesBody(
        req.body,
        ['base_witness', 'baseContent', 'proposedContent'],
        ['base_witness', 'baseContent', 'proposedContent'],
      );
      if (typeof body.baseContent !== 'string' || typeof body.proposedContent !== 'string') {
        invalidFilesParams('revision content must be strings');
      }
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({ kind: 'revision.create', chapterUid, baseContent, proposedContent }),
      }));
      if (result.state === 'conflict') {
        return sendFilesRevisionConflict(res, result, '章节不存在');
      }
      if (result.state === 'unchanged') return res.json({ unchanged: true, rebased: false });
      if (result.state === 'created' || result.state === 'stale') {
        return res.status(201).json({
          revision: result.revision,
          rebased: false,
          ...(result.state === 'stale' ? { stale: true } : {}),
        });
      }
      invalidFilesParams('revision.create returned an invalid state');
    } catch (error) { return next(error); }
  }
  const chapterId = Number(req.params.chapterId);
  if (!Number.isSafeInteger(chapterId) || chapterId < 1 || typeof baseContent !== 'string' || typeof proposedContent !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订稿参数无效', recoverable: true } });
  }
  const result = createPendingRevision(projectName, chapterId, baseContent, proposedContent);
  if (result.missing) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '章节不存在', recoverable: true } });
  }
  if (result.unchanged) return res.json({ unchanged: true, rebased: result.rebased });
  res.status(201).json({ revision: result.revision, rebased: result.rebased });
});

router.put('/:project/chapters/order', async (req, res, next) => {
  if (!isFilesRequest(req)) return sendJsonError(res, 'INVALID_PARAMS', '章节排序仅供 files Beta 项目使用');
  try {
    const body = filesBody(req.body, [
      'base_witness',
      'container_volume_uid',
      'chapter_uids',
    ], ['base_witness', 'container_volume_uid', 'chapter_uids']);
    const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
      requestId: filesRequestId(req),
      baseWitness: filesBaseWitness(body),
      command: Object.freeze({
        kind: 'chapter.reorder',
        containerVolumeUid: nullableFilesUid(
          body.container_volume_uid,
          'container_volume_uid',
        ),
        chapterUids: filesUidArray(body.chapter_uids, 'chapter_uids'),
      }),
    }));
    return res.json(result);
  } catch (error) { return next(error); }
});

router.put('/:project/chapters/:chapterId/move', async (req, res, next) => {
  if (!isFilesRequest(req)) return sendJsonError(res, 'INVALID_PARAMS', '章节移动仅供 files Beta 项目使用');
  try {
    const body = filesBody(req.body, [
      'base_witness',
      'target_volume_uid',
      'target_position',
    ], ['base_witness', 'target_volume_uid', 'target_position']);
    const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
      requestId: filesRequestId(req),
      baseWitness: filesBaseWitness(body),
      command: Object.freeze({
        kind: 'chapter.move',
        chapterUid: canonicalFilesUid(req.params.chapterId, 'chapter_uid'),
        targetVolumeUid: nullableFilesUid(body.target_volume_uid, 'target_volume_uid'),
        targetPosition: nonNegativePosition(body.target_position, 'target_position'),
      }),
    }));
    return res.json(result);
  } catch (error) { return next(error); }
});

router.get('/:project/chapters/:num', async (req, res, next) => {
  const projectName = project(req.params.project);
  if (isFilesRequest(req)) {
    try {
      if (!hasEmptyQuery(req)) invalidFilesParams('files chapter query must be empty');
      const result = await getManuscriptRuntime().read(
        filesProjectSelector(req),
        Object.freeze({
          kind: 'chapter',
          chapterUid: canonicalFilesUid(req.params.num, 'chapter_uid'),
        }),
      );
      return sendFilesRead(req, res, result);
    } catch (error) { return next(error); }
  }

  const chapterNum = positiveInteger(req.params.num);
  const hasChapterId = req.query.chapter_id !== undefined;
  const hasVolumeId = req.query.volume_id !== undefined;
  const chapterId = hasChapterId ? positiveInteger(req.query.chapter_id) : null;
  const volumeId = hasVolumeId ? positiveInteger(req.query.volume_id) : null;
  if (!chapterNum || (hasChapterId && !chapterId) || (hasVolumeId && !volumeId)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节身份参数无效', recoverable: true } });
  }

  const resolved = resolveLegacySqliteChapter(projectName, { chapterId, chapterNum, volumeId });
  if (resolved.ambiguous) return ambiguousChapterResponse(res, chapterNum);
  const { row } = resolved;
  if (!row) return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${req.params.num} 不存在`, recoverable: true } });
  res.json(row);
});

router.put('/:project/chapters/:num', async (req, res, next) => {
  const { num } = req.params;
  const projectName = project(req.params.project);
  const chapterNum = Number(num);
  const body = req.body || {};
  const {
    chapter_id: requestedChapterId,
    expected_data_version: expectedDataVersion,
    title,
    content,
    outline,
    summary,
    status,
    cognitive_frame,
    emotional_anchor,
    world_texture,
    concrete_mystery,
    interpersonal_tension,
  } = body;
  if (isFilesRequest(req)) {
    try {
      const filesInput = filesBody(body, [
        'base_witness',
        'expected_data_version',
        'title',
        'content',
        'outline',
        'summary',
        'status',
        'cognitive_frame',
        'emotional_anchor',
        'world_texture',
        'concrete_mystery',
        'interpersonal_tension',
      ]);
      const baseWitness = filesBaseWitness(filesInput);
      if (
        expectedDataVersion !== undefined
        && (
          !Number.isSafeInteger(expectedDataVersion)
          || expectedDataVersion < 0
          || expectedDataVersion !== baseWitness.expectedDataVersion
        )
      ) invalidFilesParams('expected_data_version must match base_witness');
      const patchInput = {
        title,
        outline,
        summary,
        status,
        cognitive_frame,
        emotional_anchor,
        world_texture,
        concrete_mystery,
        interpersonal_tension,
      };
      for (const [key, value] of Object.entries(patchInput)) {
        if (value !== undefined && typeof value !== 'string') {
          invalidFilesParams(`${key} must be a string`);
        }
      }
      if (content !== undefined && typeof content !== 'string') {
        invalidFilesParams('content must be a string');
      }
      const patch = Object.fromEntries(
        Object.entries(patchInput).filter(([, value]) => value !== undefined),
      );
      if (content === undefined && Object.keys(patch).length === 0) {
        invalidFilesParams('chapter update has no fields');
      }
      const chapterUid = canonicalFilesUid(num, 'chapter_uid');
      let command;
      if (content === undefined) {
        command = Object.freeze({
          kind: 'chapter.patch_sidecar',
          chapterUid,
          expected_data_version: baseWitness.expectedDataVersion,
          patch: Object.freeze(patch),
        });
      } else if (Object.keys(patch).length === 0) {
        command = Object.freeze({
          kind: 'chapter.replace_body',
          chapterUid,
          expected_data_version: baseWitness.expectedDataVersion,
          content,
        });
      } else {
        command = Object.freeze({
          kind: 'chapter.replace_body_and_sidecar',
          chapterUid,
          expected_data_version: baseWitness.expectedDataVersion,
          content,
          patch: Object.freeze(patch),
        });
      }
      await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness,
        command,
      }));
      const result = await getManuscriptRuntime().read(
        filesProjectSelector(req),
        Object.freeze({ kind: 'chapter', chapterUid }),
      );
      return sendFilesRead(req, res, result);
    } catch (error) { return next(error); }
  }

  if (!Number.isInteger(chapterNum) || chapterNum < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节编号无效', recoverable: true } });
  }

  const hasExpectedDataVersion = expectedDataVersion !== undefined;
  if (hasExpectedDataVersion && (!Number.isSafeInteger(expectedDataVersion) || expectedDataVersion < 0)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_PARAMS',
        message: '章节数据版本无效',
        recoverable: true,
      },
    });
  }

  if (content !== undefined) {
    const chapterId = requestedChapterId === undefined ? null : Number(requestedChapterId);
    if (requestedChapterId !== undefined && (!Number.isInteger(chapterId) || chapterId < 1)) {
      return res.status(400).json({
        error: { code: 'INVALID_PARAMS', message: '章节标识无效', recoverable: true },
      });
    }
    const updateResult = writeChapterBody({
      projectName,
      identity: { chapterId, chapterNumber: chapterNum, volumeId: null },
      content,
      expectedDataVersion,
      source: 'rest',
      title,
      outline,
      summary,
      status,
      cognitive_frame,
      emotional_anchor,
      world_texture,
      concrete_mystery,
      interpersonal_tension,
    });
    if (updateResult.identityError?.code === 'CHAPTER_IDENTITY_MISMATCH') {
      return res.status(409).json({
        error: { code: 'CHAPTER_IDENTITY_MISMATCH', message: '章节 ID 与 URL 章节编号不匹配', recoverable: true },
      });
    }
    if (updateResult.identityError?.code === 'AMBIGUOUS_CHAPTER') {
      return res.status(409).json({
        error: { code: 'AMBIGUOUS_CHAPTER', message: '多个卷中存在相同章节编号，请提供章节标识', recoverable: true },
      });
    }
    if (updateResult.identityError?.code === 'CHAPTER_NOT_FOUND' || updateResult.missing) {
      return res.status(404).json({
        error: { code: 'DB_NOT_FOUND', message: `章节 ${num} 不存在`, recoverable: true },
      });
    }
    if (updateResult.changes === 0 && updateResult.conflict) {
      return res.status(409).json({
        error: {
          code: 'CHAPTER_VERSION_CONFLICT',
          message: '章节已在其他窗口更新；本地草稿已保留，请处理冲突后重试',
          recoverable: true,
        },
        chapter: updateResult.current,
        current_data_version: updateResult.current.data_version,
      });
    }
    return res.json(updateResult.chapter);
  }

  const chapterId = requestedChapterId === undefined ? null : Number(requestedChapterId);
  if (chapterId !== null && (!Number.isInteger(chapterId) || chapterId < 1)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节标识无效', recoverable: true } });
  }
  const updateResult = updateLegacySqliteChapter(projectName, {
    chapterId,
    chapterNum,
    expectedDataVersion,
    patch: {
      title,
      outline,
      summary,
      status,
      cognitive_frame,
      emotional_anchor,
      world_texture,
      concrete_mystery,
      interpersonal_tension,
    },
  });
  if (updateResult.disposition === 'identity_mismatch') {
    return res.status(409).json({
      error: {
        code: 'CHAPTER_IDENTITY_MISMATCH',
        message: `章节 ID ${chapterId} 与 URL 中的章节编号 ${chapterNum} 不匹配`,
        recoverable: true,
      },
    });
  }
  if (updateResult.disposition === 'ambiguous') {
    return res.status(409).json({
      error: {
        code: 'AMBIGUOUS_CHAPTER',
        message: `多个卷中存在第 ${chapterNum} 章，请提供章节标识`,
        recoverable: true,
      },
    });
  }
  if (updateResult.disposition === 'conflict') {
    return res.status(409).json({
      error: {
        code: 'CHAPTER_VERSION_CONFLICT',
        message: '章节已在其他窗口更新；本地草稿已保留，请人工处理冲突后再重试',
        recoverable: true,
      },
      chapter: updateResult.current,
      current_data_version: updateResult.current.data_version,
    });
  }
  if (updateResult.disposition === 'missing') {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${num} 不存在`, recoverable: true } });
  }
  return res.json(updateResult.updated);
});

router.post('/:project/chapters', async (req, res, next) => {
  const { title, volume_id = 1, outline = '', status = 'pending', chapter_num } = req.body || {};
  if (isFilesRequest(req)) {
    try {
      const body = filesBody(req.body, [
        'base_witness',
        'container_volume_uid',
        'requested_num',
        'title',
        'outline',
        'summary',
        'status',
        'content',
        'cognitive_frame',
        'emotional_anchor',
        'world_texture',
        'concrete_mystery',
        'interpersonal_tension',
      ], ['base_witness', 'container_volume_uid', 'title']);
      const sidecar = Object.freeze({
        title: optionalString(body.title, 'title', ''),
        outline: optionalString(body.outline, 'outline', ''),
        summary: optionalString(body.summary, 'summary', ''),
        status: optionalString(body.status, 'status', 'pending'),
        cognitive_frame: optionalString(body.cognitive_frame, 'cognitive_frame', ''),
        emotional_anchor: optionalString(body.emotional_anchor, 'emotional_anchor', ''),
        world_texture: optionalString(body.world_texture, 'world_texture', ''),
        concrete_mystery: optionalString(body.concrete_mystery, 'concrete_mystery', ''),
        interpersonal_tension: optionalString(
          body.interpersonal_tension,
          'interpersonal_tension',
          '',
        ),
      });
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'chapter.create',
          containerVolumeUid: nullableFilesUid(
            body.container_volume_uid,
            'container_volume_uid',
          ),
          requestedNum: optionalPositiveInteger(body.requested_num ?? null, 'requested_num'),
          content: optionalString(body.content, 'content', ''),
          sidecar,
        }),
      }));
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  }
  const created = createLegacySqliteChapter(project(req.params.project), {
    title,
    volumeId: volume_id,
    outline,
    status,
    chapterNum: chapter_num,
  });
  res.status(201).json(created);
});

router.delete('/:project/chapters/:num', async (req, res, next) => {
  const projectName = project(req.params.project);
  if (isFilesRequest(req)) {
    try {
      if (!hasEmptyQuery(req)) invalidFilesParams('files chapter delete query must be empty');
      const body = filesBody(req.body, ['base_witness']);
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'chapter.delete',
          chapterUid: canonicalFilesUid(req.params.num, 'chapter_uid'),
        }),
      }));
      return res.json(result);
    } catch (error) { return next(error); }
  }

  const chapterNum = positiveInteger(req.params.num);
  const requestedChapterId = req.query.chapter_id ?? req.body?.chapter_id;
  const requestedVolumeId = req.query.volume_id ?? req.body?.volume_id;
  const hasChapterId = requestedChapterId !== undefined;
  const hasVolumeId = requestedVolumeId !== undefined;
  const chapterId = hasChapterId ? positiveInteger(requestedChapterId) : null;
  const volumeId = hasVolumeId ? positiveInteger(requestedVolumeId) : null;
  if (!chapterNum || (hasChapterId && !chapterId) || (hasVolumeId && !volumeId)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节身份参数无效', recoverable: true } });
  }

  const deletion = deleteLegacySqliteChapter(projectName, { chapterId, chapterNum, volumeId });
  if (deletion.disposition === 'ambiguous') return ambiguousChapterResponse(res, chapterNum);
  if (deletion.disposition === 'missing') {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${req.params.num} 不存在`, recoverable: true } });
  }
  res.json({
    success: true,
    chapter_id: deletion.chapter.id,
    volume_id: deletion.chapter.volume_id,
    deleted_num: deletion.chapter.num,
  });
});

router.patch('/:project/revisions/:revisionId', async (req, res, next) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订标识无效', recoverable: true } });
  }
  if (isFilesRequest(req)) {
    try {
      const body = filesBody(
        req.body,
        ['base_witness', 'decisions', 'expectedBaseContent'],
        ['base_witness', 'decisions', 'expectedBaseContent'],
      );
      if (typeof body.expectedBaseContent !== 'string') {
        invalidFilesParams('expectedBaseContent must be a string');
      }
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'revision.update_decisions',
          revisionId,
          decisions: filesRevisionDecisions(body.decisions, 'decisions'),
          expectedBaseContent: body.expectedBaseContent,
        }),
      }));
      if (result.state === 'conflict') {
        return sendFilesRevisionConflict(res, result, '待审修订不存在');
      }
      if (result.state === 'stale') {
        return sendJsonError(res, 'EXTERNAL_DRAFT_CONFLICT', '待审修订基线已失效，请刷新后重试');
      }
      if (result.state !== 'updated') invalidFilesParams('revision.update returned an invalid state');
      return res.json({ revision: result.revision, rebased: false });
    } catch (error) { return next(error); }
  }
  const result = updateRevisionDecisions(projectName, revisionId, req.body?.decisions, req.body?.expectedBaseContent);
  if (result.invalid) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订决定无效', recoverable: true } });
  }
  if (result.missing) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '待审修订不存在', recoverable: true } });
  }
  res.json({ revision: result.revision, rebased: !!result.rebased });
});

router.post('/:project/revisions/:revisionId/accept-all', async (req, res, next) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订标识无效', recoverable: true } });
  }
  if (isFilesRequest(req)) {
    try {
      const body = filesBody(
        req.body,
        ['base_witness', 'expectedBaseContent'],
        ['base_witness', 'expectedBaseContent'],
      );
      if (typeof body.expectedBaseContent !== 'string') {
        invalidFilesParams('expectedBaseContent must be a string');
      }
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'revision.accept',
          revisionId,
          expectedBaseContent: body.expectedBaseContent,
        }),
      }));
      if (result.state === 'conflict') {
        return sendFilesRevisionConflict(res, result, '待审修订不存在');
      }
      if (result.state === 'stale') {
        return sendJsonError(res, 'EXTERNAL_DRAFT_CONFLICT', '待审修订基线已失效，请刷新后重试');
      }
      if (result.state !== 'accepted') invalidFilesParams('revision.accept returned an invalid state');
      const chapter = result.chapter;
      return res.json({
        success: true,
        chapterId: chapter.id,
        chapterUid: chapter.chapterUid,
        content: chapter.content,
        wordCount: chapter.wordCount,
        status: chapter.status,
        dataVersion: chapter.dataVersion,
      });
    } catch (error) { return next(error); }
  }
  const result = applyRevision(projectName, revisionId, 'accept-all', undefined, req.body?.expectedBaseContent);
  if (result.invalid) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订确认参数无效', recoverable: true } });
  }
  if (result.missing) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '待审修订不存在', recoverable: true } });
  }
  if (result.rebased) return res.json({ revision: result.revision, rebased: true });
  res.json({
    success: true,
    chapterId: result.chapterId,
    content: result.content,
    wordCount: result.wordCount,
    dataVersion: result.dataVersion,
  });
});

router.post('/:project/revisions/:revisionId/reject-all', async (req, res, next) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订标识无效', recoverable: true } });
  }
  if (isFilesRequest(req)) {
    try {
      const body = filesBody(
        req.body,
        ['base_witness', 'expectedBaseContent'],
        ['base_witness', 'expectedBaseContent'],
      );
      if (typeof body.expectedBaseContent !== 'string') {
        invalidFilesParams('expectedBaseContent must be a string');
      }
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'revision.reject',
          revisionId,
          expectedBaseContent: body.expectedBaseContent,
        }),
      }));
      if (result.state === 'conflict') {
        return sendFilesRevisionConflict(res, result, '待审修订不存在');
      }
      if (result.state === 'stale') {
        return sendJsonError(res, 'EXTERNAL_DRAFT_CONFLICT', '待审修订基线已失效，请刷新后重试');
      }
      if (result.state !== 'rejected') invalidFilesParams('revision.reject returned an invalid state');
      const chapter = result.chapter ?? result;
      return res.json({
        success: true,
        chapterId: chapter.id ?? result.chapterId,
        content: chapter.content,
        wordCount: chapter.wordCount,
        status: chapter.status,
        dataVersion: chapter.dataVersion,
      });
    } catch (error) { return next(error); }
  }
  const result = applyRevision(projectName, revisionId, 'reject-all', undefined, req.body?.expectedBaseContent);
  if (result.invalid) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订确认参数无效', recoverable: true } });
  }
  if (result.missing) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '待审修订不存在', recoverable: true } });
  }
  if (result.rebased) return res.json({ revision: result.revision, rebased: true });
  res.json({
    success: true,
    chapterId: result.chapterId,
    content: result.content,
    wordCount: result.wordCount,
    status: result.status,
    dataVersion: result.dataVersion,
  });
});

router.post('/:project/revisions/:revisionId/finalize', async (req, res, next) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  const { content, expectedDecisions } = req.body || {};
  if (!Number.isSafeInteger(revisionId) || revisionId < 1 || typeof content !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订确认参数无效', recoverable: true } });
  }
  if (isFilesRequest(req)) {
    try {
      const body = filesBody(
        req.body,
        ['base_witness', 'content', 'expectedBaseContent', 'expectedDecisions'],
        ['base_witness', 'content', 'expectedBaseContent', 'expectedDecisions'],
      );
      if (typeof body.content !== 'string' || typeof body.expectedBaseContent !== 'string') {
        invalidFilesParams('revision.finalize content fields must be strings');
      }
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'revision.finalize',
          revisionId,
          content: body.content,
          expectedBaseContent: body.expectedBaseContent,
          expectedDecisions: filesRevisionDecisions(
            body.expectedDecisions,
            'expectedDecisions',
          ),
        }),
      }));
      if (result.state === 'conflict') {
        return sendFilesRevisionConflict(res, result, '待审修订不存在');
      }
      if (result.state === 'stale') {
        return sendJsonError(res, 'EXTERNAL_DRAFT_CONFLICT', '待审修订基线已失效，请刷新后重试');
      }
      if (result.state !== 'accepted') invalidFilesParams('revision.finalize returned an invalid state');
      const chapter = result.chapter;
      return res.json({
        success: true,
        chapterId: chapter.id,
        chapterUid: chapter.chapterUid,
        content: chapter.content,
        wordCount: chapter.wordCount,
        status: chapter.status,
        dataVersion: chapter.dataVersion,
      });
    } catch (error) { return next(error); }
  }
  const result = applyRevision(
    projectName,
    revisionId,
    'finalize',
    content,
    req.body?.expectedBaseContent,
    expectedDecisions,
  );
  if (result.missing) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '待审修订不存在', recoverable: true } });
  }
  if (result.invalid) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订确认参数无效', recoverable: true } });
  }
  if (result.rebased) return res.json({ revision: result.revision, rebased: true });
  if (result.conflicted) return res.json({ revision: result.revision, conflicted: true });
  res.json({
    success: true,
    chapterId: result.chapterId,
    content: result.content,
    wordCount: result.wordCount,
    dataVersion: result.dataVersion,
  });
});

router.get('/:project/volumes', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      const result = await getManuscriptRuntime().read(
        filesProjectSelector(req),
        Object.freeze({ kind: 'volumes' }),
      );
      return res.json(serializeFilesVolumes(req, result.value, result.baseWitness.generation));
    } catch (error) { return next(error); }
  }
  res.json(listLegacySqliteVolumes(project(req.params.project)));
});

router.post('/:project/volumes', async (req, res, next) => {
  const { title, summary = '' } = req.body || {};
  if (isFilesRequest(req)) {
    try {
      const body = filesBody(
        req.body,
        ['base_witness', 'title', 'summary'],
        ['base_witness', 'title'],
      );
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'volume.create',
          title: optionalString(body.title, 'title', ''),
          summary: optionalString(body.summary, 'summary', ''),
        }),
      }));
      return res.status(201).json(result);
    } catch (error) { return next(error); }
  }
  res.status(201).json(createLegacySqliteVolume(
    project(req.params.project),
    { title, summary },
  ));
});

router.put('/:project/volumes/order', async (req, res, next) => {
  if (!isFilesRequest(req)) return sendJsonError(res, 'INVALID_PARAMS', '卷排序仅供 files Beta 项目使用');
  try {
    const body = filesBody(
      req.body,
      ['base_witness', 'volume_uids'],
      ['base_witness', 'volume_uids'],
    );
    const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
      requestId: filesRequestId(req),
      baseWitness: filesBaseWitness(body),
      command: Object.freeze({
        kind: 'volume.reorder',
        volumeUids: filesUidArray(body.volume_uids, 'volume_uids'),
      }),
    }));
    return res.json(result);
  } catch (error) { return next(error); }
});

router.put('/:project/volumes/:id', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      const body = filesBody(req.body, ['base_witness', 'title', 'summary']);
      for (const key of ['title', 'summary']) {
        if (body[key] !== undefined && typeof body[key] !== 'string') {
          invalidFilesParams(`${key} must be a string`);
        }
      }
      const patch = Object.fromEntries(
        Object.entries({ title: body.title, summary: body.summary })
          .filter(([, value]) => value !== undefined),
      );
      if (Object.keys(patch).length === 0) invalidFilesParams('volume update has no fields');
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'volume.patch_metadata',
          volumeUid: canonicalFilesUid(req.params.id, 'volume_uid'),
          patch: Object.freeze(patch),
        }),
      }));
      return res.json(result);
    } catch (error) { return next(error); }
  }
  const changes = updateLegacySqliteVolume(
    project(req.params.project),
    req.params.id,
    req.body,
  );
  if (changes === null) return sendJsonError(res, 'INVALID_PARAMS', '没有要更新的字段');
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '卷不存在');
  res.json({ success: true });
});

router.delete('/:project/volumes/:id', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      if (!hasEmptyQuery(req)) invalidFilesParams('files volume delete query must be empty');
      const body = filesBody(req.body, ['base_witness']);
      const result = await getManuscriptRuntime().write(filesProjectSelector(req), Object.freeze({
        requestId: filesRequestId(req),
        baseWitness: filesBaseWitness(body),
        command: Object.freeze({
          kind: 'volume.delete',
          volumeUid: canonicalFilesUid(req.params.id, 'volume_uid'),
        }),
      }));
      return res.json(result);
    } catch (error) { return next(error); }
  }
  const changes = deleteLegacySqliteVolume(project(req.params.project), req.params.id);
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '卷不存在');
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// CHARACTERS
// ═══════════════════════════════════════════

const FILES_UNAVAILABLE_PRODUCT_PATHS = Object.freeze([
  '/:project/world',
  '/:project/science',
  '/:project/foreshadows',
  '/:project/relations',
  '/:project/memories',
  '/:project/timeline',
  '/:project/workflow',
  '/:project/target-words',
  '/:project/tokens',
  '/:project/cover',
  '/:project/chat',
]);

router.use('/:project/characters', (req, res, next) => {
  if (!isFilesRequest(req)) return next();
  if (req.method === 'GET' && /^\/?$/u.test(req.path)) return next();
  return sendJsonError(
    res,
    'RECOVERY_REQUIRED',
    '该 files 项目功能尚未接入同一写入 authority',
  );
});

router.use(FILES_UNAVAILABLE_PRODUCT_PATHS, (req, res, next) => {
  if (req.params.project === 'ai') return next();
  if (!isFilesRequest(req)) return next();
  if (req.method === 'GET' && /^\/phase\/?$/u.test(req.path)) return next();
  return sendJsonError(
    res,
    'RECOVERY_REQUIRED',
    '该 files 项目功能尚未接入同一写入 authority',
  );
});

router.get('/:project/characters', async (req, res, next) => {
  const projectName = project(req.params.project);
  if (isFilesRequest(req)) {
    try {
      const result = await getManuscriptRuntime().read(
        filesProjectSelector(req),
        Object.freeze({ kind: 'character_associations' }),
      );
      return res.json(result.value);
    } catch (error) { return next(error); }
  }
  res.json(readLegacySqliteCharacterAssociations(projectName));
});

router.get('/:project/characters/:id', (req, res) => {
  const row = db.projectGet(project(req.params.project), 'SELECT * FROM characters WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '角色不存在', recoverable: true } });
  res.json(row);
});

router.post('/:project/characters', (req, res) => {
  const { name, age = '', gender = '', appearance = '', personality = '', background = '', motivation = '', arc = '', ext_markers = '', role: requestedRole } = req.body || {};
  const role = requestedRole === undefined || requestedRole === '' ? 'minor' : requestedRole;
  const normalizedName = normalizeCharacterName(name);
  if (!normalizedName) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '角色名不能为空', recoverable: true } });
  }
  if (!CHARACTER_ROLES.has(role)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '角色定位必须是主角、配角或客串', recoverable: true } });
  }
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO characters (id, name, age, gender, role, appearance, personality, background, motivation, arc, ext_markers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, normalizedName, age, gender, role, appearance, personality, background, motivation, arc, ext_markers]
  );
  res.status(201).json({ id, name: normalizedName, role });
});

router.put('/:project/characters/:id', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  if (body.name !== undefined) {
    const normalizedName = normalizeCharacterName(body.name);
    if (!normalizedName) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '角色名不能为空', recoverable: true } });
    }
    body.name = normalizedName;
  }
  if (body.role !== undefined && !CHARACTER_ROLES.has(body.role)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '角色定位必须是主角、配角或客串', recoverable: true } });
  }
  const fields = []; const params = [];
  for (const key of ['name', 'age', 'gender', 'role', 'appearance', 'personality', 'background', 'motivation', 'arc', 'ext_markers', 'notes']) {
    if (body[key] !== undefined) { fields.push(`${key} = ?`); params.push(body[key]); }
  }
  if (fields.length === 0) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '没有要更新的字段', recoverable: true } });
  fields.push("updated_at = datetime('now')");
  params.push(id);
  const changes = db.projectExecute(project(req.params.project), `UPDATE characters SET ${fields.join(', ')} WHERE id = ?`, params);
  if (changes === 0) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '角色不存在', recoverable: true } });
  }
  res.json({ success: true });
});

router.delete('/:project/characters/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM characters WHERE id = ?', [req.params.id]);
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '角色不存在');
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// WORLD ENTRIES
// ═══════════════════════════════════════════

router.get('/:project/world', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM world_entries ORDER BY category, name');
  res.json(rows);
});

router.post('/:project/world', (req, res) => {
  const { category, name, description = '', tags = '[]' } = req.body || {};
  if (!isValidWorldEntryCategory(category)) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: worldEntryCategoryError(), recoverable: true },
    });
  }
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO world_entries (id, category, name, description, tags) VALUES (?, ?, ?, ?, ?)',
    [id, category, name, description, serializeWorldTags(tags)]
  );
  res.status(201).json({ id, name });
});

router.put('/:project/world/:id', (req, res) => {
  const data = { ...(req.body || {}) };
  if (data.category !== undefined && !isValidWorldEntryCategory(data.category)) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: worldEntryCategoryError(), recoverable: true },
    });
  }
  if (data.tags !== undefined) data.tags = serializeWorldTags(data.tags);
  const changes = updateRecord(project(req.params.project), 'world_entries', req.params.id, data, ['category', 'name', 'description', 'tags'], true);
  if (changes === null) return sendJsonError(res, 'INVALID_PARAMS', '没有要更新的字段');
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '条目不存在');
  res.json({ success: true });
});

router.delete('/:project/world/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM world_entries WHERE id = ?', [req.params.id]);
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '条目不存在');
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// SCIENCE ENTRIES
// ═══════════════════════════════════════════

router.get('/:project/science', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM science_entries ORDER BY label, name');
  res.json(rows);
});

router.post('/:project/science', (req, res) => {
  const { label, name, description = '', references = '' } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO science_entries (id, label, name, description, "references") VALUES (?, ?, ?, ?, ?)',
    [id, label, name, description, references]
  );
  res.status(201).json({ id, name });
});

router.delete('/:project/science/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM science_entries WHERE id = ?', [req.params.id]);
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '条目不存在');
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// FORESHADOWS
// ═══════════════════════════════════════════

router.get('/:project/foreshadows', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM foreshadows';
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at';
  const rows = db.projectQuery(project(req.params.project), sql, params);
  res.json(rows);
});

router.post('/:project/foreshadows', (req, res) => {
  const { title, description = '', status = 'planted', priority = 'normal', expected_resolve_chapter = 0 } = req.body || {};
  const id = randomUUID();
  createLegacySqliteForeshadow(project(req.params.project), {
    id,
    title,
    description,
    status,
    priority,
    expectedResolveChapter: expected_resolve_chapter,
  });
  res.status(201).json({ id, title });
});

// ═══════════════════════════════════════════
// CHARACTER RELATIONS
// ═══════════════════════════════════════════

router.get('/:project/relations', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM character_relations');
  res.json(rows);
});

router.post('/:project/relations', (req, res) => {
  const { character_a_id, character_b_id, relation_type, description = '', intensity = 3 } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO character_relations (id, character_a_id, character_b_id, relation_type, description, intensity) VALUES (?, ?, ?, ?, ?, ?)',
    [id, character_a_id, character_b_id, relation_type, description, intensity]
  );
  res.status(201).json({ id });
});

router.put('/:project/relations/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'character_relations', req.params.id, req.body, ['relation_type', 'description', 'intensity'], false);
  if (changes === null) return sendJsonError(res, 'INVALID_PARAMS', '没有要更新的字段');
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '关系不存在');
  res.json({ success: true });
});

router.delete('/:project/relations/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM character_relations WHERE id = ?', [req.params.id]);
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '关系不存在');
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// MEMORIES
// ═══════════════════════════════════════════

router.get('/:project/memories', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM memories ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/:project/memories', (req, res) => {
  const { category, content, source_chapter_id } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO memories (id, category, content, source_chapter_id) VALUES (?, ?, ?, ?)',
    [id, category, content, source_chapter_id || null]
  );
  res.status(201).json({ id });
});

router.put('/:project/memories/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'memories', req.params.id, req.body, ['category', 'content'], false);
  if (changes === null) return sendJsonError(res, 'INVALID_PARAMS', '没有要更新的字段');
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '记忆不存在');
  res.json({ success: true });
});

router.delete('/:project/memories/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM memories WHERE id = ?', [req.params.id]);
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '记忆不存在');
  res.json({ success: true });
});

// ─── Memory Search ───
router.post('/:project/memories/search', (req, res) => {
  const pn = project(req.params.project);
  const { query } = req.body || {};
  if (!query) return sendJsonError(res, 'INVALID_PARAMS', '缺少搜索关键词');
  const rows = db.projectQuery(pn,
    "SELECT * FROM memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT 20",
    [`%${query}%`]
  );
  res.json(rows);
});

// ═══════════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════════

router.get('/:project/timeline', (req, res) => {
  res.json(listTimelineEvents(project(req.params.project)));
});

router.get('/:project/timeline/order-mode', (req, res) => {
  const projectName = project(req.params.project);
  res.json({ mode: getTimelineSortMode(projectName) });
});

router.post('/:project/timeline', (req, res) => {
  const body = req.body || {};
  const { year, title, description = '' } = body;
  const importance = clampTimelineImportance(body.importance === undefined ? 3 : body.importance);
  const projectName = project(req.params.project);
  const maxSortOrder = db.projectGet(projectName, 'SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order FROM timeline_events');
  const sortOrder = (maxSortOrder?.max_sort_order ?? 0) + 1;
  const id = randomUUID();
  db.projectExecute(projectName,
    'INSERT INTO timeline_events (id, year, title, description, importance, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [id, year, title, description, importance, sortOrder]
  );
  res.status(201).json({ id, title, sort_order: sortOrder });
});

router.put('/:project/timeline/order', (req, res) => {
  const projectName = project(req.params.project);
  const ids = req.body?.ids;
  const events = db.projectQuery(projectName, 'SELECT id FROM timeline_events');
  const validationError = validateTimelineEventOrder(ids, events);
  if (validationError) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: validationError, recoverable: true } });
  }

  const projectDb = db.getProjectDb(projectName);
  const updateSortOrder = projectDb.prepare('UPDATE timeline_events SET sort_order = ? WHERE id = ?');
  const setSortMode = projectDb.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('timeline_sort_mode', 'manual')");
  projectDb.transaction(() => {
    ids.forEach((id, index) => updateSortOrder.run(index + 1, id));
    setSortMode.run();
  })();
  res.json({ success: true });
});

router.put('/:project/timeline/order-mode', (req, res) => {
  if (req.body?.mode !== 'auto') {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '仅支持恢复按日期自动排序', recoverable: true } });
  }
  const projectName = project(req.params.project);
  db.projectExecute(
    projectName,
    "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('timeline_sort_mode', 'auto')",
  );
  res.json({ success: true, mode: 'auto' });
});

router.put('/:project/timeline/:id', (req, res) => {
  const body = { ...(req.body || {}) };
  if (body.importance !== undefined) body.importance = clampTimelineImportance(body.importance);
  const changes = updateRecord(project(req.params.project), 'timeline_events', req.params.id, body, ['year', 'title', 'description', 'importance'], false);
  if (changes === null) return sendJsonError(res, 'INVALID_PARAMS', '没有要更新的字段');
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '事件不存在');
  res.json({ success: true });
});

router.delete('/:project/timeline/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM timeline_events WHERE id = ?', [req.params.id]);
  if (changes === 0) return sendJsonError(res, 'DB_NOT_FOUND', '事件不存在');
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// SETTINGS (global)
// ═══════════════════════════════════════════

router.get('/settings', (req, res) => {
  const rows = db.dbQuery('SELECT key, value FROM app_settings');
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  // Fill in effective API key from env/fallback if DB entry is empty
  if (!settings.api_key) {
    settings.api_key = process.env.DEEPSEEK_KEY || '';
  }
  if (!settings.api_base_url) {
    settings.api_base_url = 'https://api.deepseek.com/v1';
  }
  if (!settings.api_model) {
    settings.api_model = 'deepseek-v4-flash';
  }
  res.json(settings);
});

router.put('/settings', (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '缺少key', recoverable: true } });
  db.dbExecute('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, String(value)]);
  // Invalidate AI config cache so next AI request picks up the change
  if (db.invalidateAiConfigCache) db.invalidateAiConfigCache();
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// PROJECT META
// ═══════════════════════════════════════════

router.get('/:project/meta', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      const result = await getManuscriptRuntime().read(
        Object.freeze({ projectUid: req.manuscriptAdmission.databaseFacts.projectUid }),
        Object.freeze({ kind: 'product_view' }),
      );
      return res.json(result.value.metadata);
    } catch (error) {
      return next(error);
    }
  }
  const rows = db.projectQuery(project(req.params.project), 'SELECT key, value FROM project_meta');
  const meta = {};
  for (const r of rows) meta[r.key] = r.value;
  meta.genres = db.projectQuery(project(req.params.project), 'SELECT genre FROM project_genres').map(g => g.genre);
  res.json(meta);
});

// ═══════════════════════════════════════════
// WORKFLOW PHASE
// ═══════════════════════════════════════════

router.get('/:project/workflow/phase', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      const result = await getManuscriptRuntime().read(
        Object.freeze({ projectUid: req.manuscriptAdmission.databaseFacts.projectUid }),
        Object.freeze({ kind: 'product_view' }),
      );
      return res.json({ phase: result.value.metadata.workflow_phase || 'idea' });
    } catch (error) {
      return next(error);
    }
  }
  const row = db.projectGet(project(req.params.project),
    "SELECT value FROM project_meta WHERE key = 'workflow_phase'"
  );
  res.json({ phase: row?.value || 'idea' });
});

router.put('/:project/workflow/phase', (req, res) => {
  const { phase } = req.body || {};
  const valid = ['idea', 'setting', 'outline', 'writing', 'review', 'consistency', 'export'];
  if (!phase || !valid.includes(phase)) {
    return sendJsonError(res, 'INVALID_PARAMS', `Invalid phase. Must be one of: ${valid.join(', ')}`);
  }
  db.projectExecute(project(req.params.project),
    "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('workflow_phase', ?)", [phase]
  );
  res.json({ success: true, phase });
});

// ═══════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════

router.get('/:project/stats', async (req, res, next) => {
  if (isFilesRequest(req)) {
    try {
      const result = await getManuscriptRuntime().read(
        Object.freeze({ projectUid: req.manuscriptAdmission.databaseFacts.projectUid }),
        Object.freeze({ kind: 'stats' }),
      );
      return res.json(result.value);
    } catch (error) {
      return next(error);
    }
  }
  return res.json(readLegacySqliteStats(project(req.params.project)));
  });

// ─── Target words ───

router.put('/:project/target-words', (req, res) => {
  const pn = project(req.params.project);
  const { targetWords } = req.body;
  if (typeof targetWords !== 'number' || targetWords < 1000) {
    return sendJsonError(res, 'INVALID_PARAMS', 'targetWords must be a number ≥ 1000');
  }
  db.projectExecute(pn,
    "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('target_words', ?)", [String(targetWords)]
  );
  res.json({ success: true, targetWords });
});

router.delete('/:project/target-words', (req, res) => {
  const pn = project(req.params.project);
  db.projectExecute(pn, "DELETE FROM project_meta WHERE key = 'target_words'");
  // Return the mode-based default
  const projectMode = db.projectGet(pn, "SELECT value FROM project_meta WHERE key = 'mode'")?.value || 'medium-novel';
  const TARGET_WORDS = { 'short-story': 30000, 'medium-novel': 100000, 'long-novel': 200000 };
  res.json({ success: true, targetWords: TARGET_WORDS[projectMode] || 100000 });
});

// ═══════════════════════════════════════════
// TOKEN USAGE
// ═══════════════════════════════════════════

router.get('/:project/tokens', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM token_usage ORDER BY created_at DESC LIMIT 50');
  res.json(rows);
});

// ═══════════════════════════════════════════
// COVER IMAGE
// ═══════════════════════════════════════════

router.post('/:project/cover', (req, res) => {
  const pn = project(req.params.project);
  const { data, mime } = req.body || {};
  if (!data) return sendJsonError(res, 'INVALID_PARAMS', '缺少图片数据');
  const ext = db.MIME_TO_EXT[mime || 'image/png'] || 'png';
  const coverFileName = `cover.${ext}`;
  let stagedFiles = [];
  let tempPath = null;
  let publishedPath = null;
  try {
    const coverDir = ensureWritableProjectCoverDirectory(pn);
    const coverPath = path.join(coverDir, coverFileName);
    stagedFiles = stageProjectCoverFiles(pn);
    tempPath = path.join(coverDir, `.${coverFileName}.cover-upload-${randomUUID()}.tmp`);
    fs.writeFileSync(tempPath, Buffer.from(data, 'base64'), { flag: 'wx' });
    fs.renameSync(tempPath, coverPath);
    tempPath = null;
    publishedPath = coverPath;

    const projectDb = db.getProjectDb(pn);
    projectDb.transaction(() => {
      projectDb.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('cover_mime', ?)")
        .run(mime || 'image/png');
      projectDb.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('cover_ext', ?)")
        .run(ext);
    })();
  } catch (error) {
    try {
      if (tempPath) fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error(`[Cover Upload] Failed to remove temp file for "${pn}":`, cleanupError);
    }
    try {
      if (publishedPath) fs.unlinkSync(publishedPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error(`[Cover Upload] Failed to remove replacement for "${pn}":`, cleanupError);
    }
    const rollbackErrors = rollbackStagedProjectCoverFiles(stagedFiles);
    if (rollbackErrors.length > 0) {
      console.error(`[Cover Upload] Failed to restore previous covers for "${pn}":`, rollbackErrors);
    }
    console.error(`[Cover Upload] Failed to replace cover for "${pn}":`, error);
    return res.status(500).json({
      error: { code: 'COVER_UPDATE_FAILED', message: '无法更新封面，请稍后重试', recoverable: true },
    });
  }
  retireStagedProjectCoverFiles(pn, stagedFiles);
  res.json({ success: true, ext, mime: mime || 'image/png' });
});

router.get('/:project/cover', (req, res) => {
  const pn = project(req.params.project);
  const coverPath = db.findCoverPath(pn);
  if (coverPath) {
    const ext = path.extname(coverPath).slice(1);
    res.setHeader('Content-Type', db.EXT_TO_MIME[ext] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    return res.end(fs.readFileSync(coverPath));
  }
  sendJsonError(res, 'DB_NOT_FOUND', '未上传封面');
});

router.delete('/:project/cover', (req, res) => {
  const pn = project(req.params.project);
  let stagedFiles = [];
  try {
    stagedFiles = stageProjectCoverFiles(pn);
    if (stagedFiles.length === 0) return sendJsonError(res, 'DB_NOT_FOUND', '未上传封面');
    const projectDb = db.getProjectDb(pn);
    projectDb.transaction(() => {
      projectDb.prepare("DELETE FROM project_meta WHERE key IN ('cover_mime', 'cover_ext')").run();
    })();
  } catch (error) {
    const rollbackErrors = rollbackStagedProjectCoverFiles(stagedFiles);
    if (rollbackErrors.length > 0) {
      console.error(`[Cover Delete] Failed to restore covers for "${pn}":`, rollbackErrors);
    }
    console.error(`[Cover Delete] Failed to delete cover for "${pn}":`, error);
    return res.status(500).json({
      error: { code: 'COVER_DELETE_FAILED', message: '无法删除封面，请稍后重试', recoverable: true },
    });
  }
  retireStagedProjectCoverFiles(pn, stagedFiles);
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════

router.get('/:project/export', async (req, res, next) => {
  const { format = 'txt' } = req.query;
  const pn = project(req.params.project);
  if (isFilesRequest(req)) {
    try {
      const initialFacts = req.manuscriptAdmission.databaseFacts;
      const result = await getManuscriptRuntime().read(
        Object.freeze({ projectUid: initialFacts.projectUid }),
        Object.freeze({ kind: 'export_snapshot' }),
      );
      const published = await publishProjectExport({
        snapshot: result.value,
        exportRoot: db.getExportDir(),
        exportName: pn,
        options: Object.freeze({ format }),
        assertCurrent: async (expected) => {
          const current = db.inspectProjectManuscriptRoute(pn);
          if (
            current.route !== 'files'
            || current.databaseFacts.projectUid !== initialFacts.projectUid
            || current.databaseFacts.projectInstanceId !== initialFacts.projectInstanceId
            || current.databaseFacts.projectionGeneration !== expected.projectionGeneration
          ) {
            const error = new Error('Project changed while its export was being generated');
            error.code = 'PROJECT_INSTANCE_MISMATCH';
            throw error;
          }
        },
      });
      if (req.query.download === '1' || req.query.download === 'true') {
        res.setHeader('Content-Type', published.manifest.mime);
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(published.manifest.filename)}"`,
        );
        return res.end(published.bytes);
      }
      return res.json({
        success: true,
        format: published.manifest.format,
        filePath: published.filePath,
        wordCount: published.manifest.wordCount,
        chapterCount: published.manifest.chapterCount,
        filename: published.manifest.filename,
      });
    } catch (error) {
      return next(error);
    }
  }
  const { chapters, volumes, meta } = readLegacySqliteExportSnapshot(pn);
  const exportInstanceId = meta.project_instance_id;

  const totalWords = chapters.reduce((s, c) => s + (c.content?.replace(/\s/g, '').length || 0), 0);
  const showVolumeHeadings = new Set(chapters.map(ch => ch.volume_id ?? 'unassigned')).size > 1;
  const volumeLabel = ch => ch.volume_title || '未分卷';
  const EXPORT_DIR = path.join(db.getExportDir(), pn);
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  // Find cover image
  const coverPath = db.findCoverPath(pn);
  const coverBase64 = coverPath ? fs.readFileSync(coverPath).toString('base64') : null;
  const coverMime = coverPath ? (db.EXT_TO_MIME[path.extname(coverPath).slice(1)] || 'image/png') : null;

  let ext = 'txt';
  let mime = 'text/plain; charset=utf-8';
  let output;
  let filename;

  if (format === 'epub') {
    // ── EPUB with cover ──
    ext = 'epub';
    mime = 'application/epub+zip';
    filename = `${pn}.epub`;

    const EpubGen = require('epub-gen');

    // Build content grouped by volume
    const volumeMap = new Map();
    for (const v of volumes) volumeMap.set(v.id, v);
    const volChapters = new Map();
    for (const ch of chapters) {
      const vId = ch.volume_id ?? 'unassigned';
      if (!volChapters.has(vId)) volChapters.set(vId, []);
      volChapters.get(vId).push(ch);
    }

    const content = [];

    for (const [vId, vchs] of volChapters) {
      const vol = volumeMap.get(vId);
      if (volumes.length > 1 && vol) {
        content.push({
          title: vol.title,
          data: `<h2>第${vol.sort_order}卷 ${vol.title}</h2>${vol.summary ? `<p>${vol.summary}</p>` : ''}`,
        });
      }
      for (const ch of vchs) {
        const displayTitle = ch.title.startsWith('第') ? ch.title : `第${ch.num}章 ${ch.title}`;
        content.push({
          title: ch.title,
          data: `<h1>${displayTitle}</h1>${ch.content}`,
        });
      }
    }

    const epubPath = path.join(EXPORT_DIR, filename);
    const epubOptions = {
      title: meta.name || pn,
      author: meta.author_name || '佚名',
      publisher: 'Mythpen',
      cover: coverPath || undefined,
      content,
    };
    let epubBytes;
    try {
      epubBytes = await publishGeneratedProjectFile({
        finalPath: epubPath,
        generate: tempPath => new EpubGen({ ...epubOptions, output: tempPath }).promise,
        // Validate the incarnation captured with the chapter snapshot. This is
        // stronger than relying only on a client header and also protects
        // legacy callers that started before instance headers were introduced.
        assertCurrent: () => db.assertProjectInstance(pn, exportInstanceId),
        capturePublished: publishedPath => fs.readFileSync(publishedPath),
      });
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND' || error?.code === 'PROJECT_INSTANCE_MISMATCH') {
        return sendJsonError(res, error.code);
      }
      throw error;
    }

    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return res.end(epubBytes);
    }
    return res.json({ success: true, format: 'epub', filePath: epubPath, wordCount: totalWords, chapterCount: chapters.length, filename });

  } else if (format === 'html') {
    // ── HTML with cover (for save-as-PDF) ──
    ext = 'html';
    mime = 'text/html; charset=utf-8';
    filename = `${pn}.html`;

    let coverHtml = '';
    if (coverPath) {
      coverHtml = `<div class="cover-page"><img src="data:${coverMime};base64,${coverBase64}" alt="封面"></div>`;
    }
    let previousHtmlVolume = Symbol('no-volume');
    const htmlChapters = chapters.map(ch => {
      const volumeKey = ch.volume_id ?? 'unassigned';
      const volumeHeading = showVolumeHeadings && previousHtmlVolume !== volumeKey
        ? `<div class="volume"><h1>${volumeLabel(ch)}</h1>${ch.volume_summary ? `<p>${ch.volume_summary}</p>` : ''}</div>`
        : '';
      previousHtmlVolume = volumeKey;
      return `${volumeHeading}<div class="chapter"><h1>第${ch.num}章 ${ch.title}</h1>${ch.content}</div>`;
    }).join('');

    output = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${meta.name || pn}</title>
<style>
  @page { margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Serif SC', 'Songti SC', serif; color: #333; background: #fff; line-height: 1.8; }
  .cover-page { page-break-after: always; text-align: center; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .cover-page img { max-width: 100%; max-height: 90vh; object-fit: contain; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
  .toc-page { page-break-after: always; padding: 40px; }
  .toc-page h1 { text-align: center; font-size: 24px; margin-bottom: 30px; }
  .toc-page ul { list-style: none; padding: 0; max-width: 500px; margin: 0 auto; }
  .toc-page li { padding: 8px 0; border-bottom: 1px solid #eee; font-size: 16px; }
  .volume { page-break-after: always; padding: 80px 40px; text-align: center; }
  .volume h1 { font-size: 28px; margin-bottom: 24px; }
  .chapter { page-break-after: always; padding: 40px; max-width: 700px; margin: 0 auto; }
  .chapter h1 { font-size: 22px; text-align: center; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #333; }
  .chapter p { text-indent: 2em; margin-bottom: 0.8em; font-size: 16px; }
  .chapter h1, .chapter h2, .chapter h3, .chapter h4 { text-indent: 0; }
</style>
</head>
<body>
${coverHtml}
<div class="toc-page">
  <h1>${meta.name || pn}</h1>
  <p style="text-align:center;color:#999;margin-bottom:30px;">${meta.author_name || '佚名'} 著</p>
  <ul>${chapters.map(ch => `<li>${showVolumeHeadings ? `${volumeLabel(ch)} · ` : ''}第${ch.num}章 ${ch.title}</li>`).join('')}</ul>
</div>
${htmlChapters}
</body>
</html>`;

    const filePath = path.join(EXPORT_DIR, filename);
    fs.writeFileSync(filePath, output, 'utf-8');

    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return res.send(output);
    }
    return res.json({ success: true, format: 'html', filePath, wordCount: totalWords, chapterCount: chapters.length, filename });

  } else if (format === 'md' || format === 'markdown') {
    ext = 'md';
    mime = 'text/markdown; charset=utf-8';
    filename = `${pn}.md`;
    output = `# ${meta.name || pn}\n\n${meta.description ? `> ${meta.description}\n\n` : ''}`;
    if (coverPath) {
      output += `<img src="data:${coverMime};base64,${coverBase64}" alt="封面" style="max-width:100%;height:auto;">\n\n`;
    }
    let previousMarkdownVolume = Symbol('no-volume');
    for (const ch of chapters) {
      const volumeKey = ch.volume_id ?? 'unassigned';
      if (showVolumeHeadings && previousMarkdownVolume !== volumeKey) {
        output += `\n---\n\n# ${volumeLabel(ch)}\n\n${ch.volume_summary ? `${ch.volume_summary}\n` : ''}`;
      }
      previousMarkdownVolume = volumeKey;
      output += `\n---\n\n## 第${ch.num}章 ${ch.title}\n\n${ch.content}\n`;
    }
  } else {
    // TXT
    ext = 'txt';
    mime = 'text/plain; charset=utf-8';
    filename = `${pn}.txt`;
    output = `${meta.name || pn}\n${'='.repeat(meta.name?.length || 10)}\n\n`;
    if (meta.description) output += `${meta.description}\n\n`;
    let previousTextVolume = Symbol('no-volume');
    for (const ch of chapters) {
      const volumeKey = ch.volume_id ?? 'unassigned';
      if (showVolumeHeadings && previousTextVolume !== volumeKey) {
        output += `\n${volumeLabel(ch)}\n${'='.repeat(Math.max(volumeLabel(ch).length, 4))}\n`;
        if (ch.volume_summary) output += `${ch.volume_summary}\n`;
      }
      previousTextVolume = volumeKey;
      output += `\n第${ch.num}章 ${ch.title}\n${'-'.repeat(20)}\n\n${ch.content.replace(/^#+/gm, '').trim()}\n`;
    }
  }

  output += `\n\n---\n共 ${chapters.length} 章 · ${totalWords} 字\n`;

  // Save to exports dir
  const filePath = path.join(EXPORT_DIR, filename);
  fs.writeFileSync(filePath, output, 'utf-8');

  // Record in exports table
  try {
    db.projectExecute(pn,
      'INSERT OR REPLACE INTO exports (id, format, file_path, word_count, exported_at) VALUES (?, ?, ?, ?, datetime(\'now\'))',
      [randomUUID(), ext, filePath, totalWords]
    );
  } catch(e) {}

  if (req.query.download === '1' || req.query.download === 'true') {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    return res.send(output);
  }

  res.json({
    success: true,
    format: ext,
    filePath,
    wordCount: totalWords,
    chapterCount: chapters.length,
    preview: (output || '').slice(0, 2000),
    filename,
  });
});

// ═══════════════════════════════════════════
// CHAT SESSIONS (per-project)
// ═══════════════════════════════════════════

router.get('/:project/chat/sessions', (req, res) => {
  const rows = db.projectQuery(project(req.params.project),
    'SELECT * FROM chat_sessions ORDER BY updated_at DESC'
  );
  res.json(rows);
});

router.post('/:project/chat/sessions', (req, res) => {
  const { title } = req.body || {};
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO chat_sessions (id, title) VALUES (?, ?)',
    [id, title || '新对话']
  );
  res.status(201).json({ id, title: title || '新对话', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
});

router.put('/:project/chat/sessions/:id', (req, res) => {
  const { title } = req.body || {};
  if (!title) return sendJsonError(res, 'INVALID_PARAMS', 'title is required');
  db.projectExecute(project(req.params.project),
    "UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE id = ?",
    [title, req.params.id]
  );
  res.json({ success: true });
});

router.delete('/:project/chat/sessions/:id', (req, res) => {
  db.projectExecute(project(req.params.project),
    'DELETE FROM chat_messages WHERE session_id = ?', [req.params.id]
  );
  db.projectExecute(project(req.params.project),
    'DELETE FROM chat_sessions WHERE id = ?', [req.params.id]
  );
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// CHAT MESSAGES (per-project)
// ═══════════════════════════════════════════

router.get('/:project/chat/messages', (req, res) => {
  const { session_id } = req.query;
  let sql = 'SELECT * FROM chat_messages';
  const params = [];
  if (session_id) {
    sql += ' WHERE session_id = ?';
    params.push(session_id);
  }
  sql += ' ORDER BY created_at ASC';
  const rows = db.projectQuery(project(req.params.project), sql, params);
  const messages = rows.map(r => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: JSON.parse(r.tool_calls || '[]'),
    createdAt: r.created_at,
  }));
  res.json(messages);
});

router.post('/:project/chat/messages', (req, res) => {
  const { role, content, toolCalls, session_id } = req.body || {};
  if (!role || !content || !session_id) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'role, content and session_id are required', recoverable: true } });
  }
  if (!['user', 'ai', 'system'].includes(role)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'role must be user/ai/system', recoverable: true } });
  }
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO chat_messages (id, session_id, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)',
    [id, session_id, role, content, JSON.stringify(toolCalls || [])]
  );
  // Update session's updated_at
  db.projectExecute(project(req.params.project),
    "UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?", [session_id]
  );
  res.status(201).json({ id, role, content, toolCalls: toolCalls || [], session_id, createdAt: new Date().toISOString() });
});

module.exports = router;
