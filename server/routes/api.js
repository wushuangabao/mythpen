const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { publishGeneratedProjectFile } = require('../project-export');
const { readRecentProject } = require('../recent-projects');
const { normalizeCharacterName } = require('../character-validation');
const { clampTimelineImportance } = require('../timeline-importance');
const { orderTimelineEvents, validateTimelineEventOrder } = require('../timeline-order');
const {
  applyRevision,
  createPendingRevision,
  getActiveRevision,
  updateRevisionDecisions,
} = require('../chapter-revisions');

const CHARACTER_ROLES = new Set(['major', 'minor', 'extra']);
const PROJECT_INSTANCE_HEADER = 'X-Mythpen-Project-Instance';
const COVER_FILE_NAMES = ['cover.png', 'cover.jpg', 'cover.jpeg', 'cover.webp', 'cover.gif'];

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

router.param('project', (req, res, next, name) => {
  const expectedInstanceId = req.get(PROJECT_INSTANCE_HEADER) || '';
  return db.runWithProjectInstance(name, expectedInstanceId, () => {
    try {
      db.getProjectDb(name);
      next();
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND' || error?.code === 'PROJECT_INSTANCE_MISMATCH') {
        return res.status(error.status).json({
          error: { code: error.code, message: error.message, recoverable: true },
        });
      }
      next(error);
    }
  });
});

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

router.get('/projects', (req, res) => {
  const rows = db.dbQuery('SELECT * FROM recent_projects ORDER BY last_opened DESC');
  const projects = rows.map((row) => readRecentProject(row, { openProjectDb: db.openProjectDb }));
  res.json(projects);
});

router.post('/projects', (req, res) => {
  const { name, mode = 'medium-novel', language = 'zh', genres = ['other'] } = req.body || {};
  if (!name) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '项目名称不能为空', recoverable: true } });

  const filePath = db.getProjectDbPath(name);
  if (require('fs').existsSync(filePath)) {
    return res.status(409).json({ error: { code: 'PROJECT_ALREADY_EXISTS', message: `项目"${name}"已存在`, recoverable: true } });
  }

  // Create new project DB
  const pdb = db.openProjectDb(filePath);
  const metaInsert = pdb.prepare('INSERT OR REPLACE INTO project_meta (key, value) VALUES (?, ?)');
  const meta = { name, description: '', mode, language, version: '1', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), word_count: '0', author_name: '佚名', workflow_phase: 'idea' };
  for (const [k, v] of Object.entries(meta)) metaInsert.run(k, v);

  // Default volume
  pdb.prepare("INSERT INTO volumes (id, sort_order, title, summary) VALUES (1, 1, '第一卷', '')").run();

  // Genres
  for (const g of genres) {
    pdb.prepare('INSERT OR IGNORE INTO project_genres (genre) VALUES (?)').run(g);
  }

  // Config
  const config = db.getConfigDb();
  config.prepare('INSERT OR REPLACE INTO recent_projects (id, name, file_path, last_opened, word_count) VALUES (?, ?, ?, ?, ?)').run(name, name, filePath, new Date().toISOString(), 0);

  const instanceId = pdb
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get()?.value;
  // The client immediately lists and opens the new project. Persist before the
  // 200 response so file-existence checks and duplicate-name detection observe
  // the same committed instance rather than the 250 ms write batch window.
  pdb.flush();
  config.flush();
  res.json({ name, filePath, mode, language, genres, instanceId });
});

function sendProjectMetadata(req, res, next) {
  const { name } = req.params;
  const expectedInstanceId = req.get(PROJECT_INSTANCE_HEADER) || '';
  return db.runWithProjectInstance(name, expectedInstanceId, () => {
    try {
      const pdb = db.getProjectDb(name);
      const meta = {};
      pdb.prepare('SELECT key, value FROM project_meta').all().forEach(m => meta[m.key] = m.value);
      const genres = pdb.prepare('SELECT genre FROM project_genres').all().map(g => g.genre);
      res.json({ ...meta, genres, filePath: db.getProjectDbPath(name) });
    } catch (error) {
      if (error?.code === 'PROJECT_NOT_FOUND' || error?.code === 'PROJECT_INSTANCE_MISMATCH') {
        return res.status(error.status).json({
          error: { code: error.code, message: error.message, recoverable: true },
        });
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
      return res.status(error.status).json({
        error: { code: error.code, message: error.message, recoverable: true },
      });
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
router.get('/:project/sidebar-items', (req, res) => {
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
    res.status(500).json({ error: { message: e.message } });
  }
});

// ═══════════════════════════════════════════
// CHAPTERS
// ═══════════════════════════════════════════

router.get('/:project/chapters', (req, res) => {
  const rows = db.projectQuery(project(req.params.project),
    'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id ORDER BY c.num'
  );
  res.json(rows);
});

router.get('/:project/chapters/:chapterId/revisions/active', (req, res) => {
  const projectName = project(req.params.project);
  const chapterId = Number(req.params.chapterId);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节标识无效', recoverable: true } });
  }
  const chapter = db.projectGet(projectName, 'SELECT id FROM chapters WHERE id = ?', [chapterId]);
  if (!chapter) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '章节不存在', recoverable: true } });
  }
  res.json(getActiveRevision(projectName, chapterId));
});

router.post('/:project/chapters/:chapterId/revisions', (req, res) => {
  const projectName = project(req.params.project);
  const chapterId = Number(req.params.chapterId);
  const { baseContent, proposedContent } = req.body || {};
  if (!Number.isInteger(chapterId) || chapterId < 1 || typeof baseContent !== 'string' || typeof proposedContent !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订稿参数无效', recoverable: true } });
  }
  const result = createPendingRevision(projectName, chapterId, baseContent, proposedContent);
  if (result.missing) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: '章节不存在', recoverable: true } });
  }
  if (result.unchanged) return res.json({ unchanged: true, rebased: result.rebased });
  res.status(201).json({ revision: result.revision, rebased: result.rebased });
});

router.get('/:project/chapters/:num', (req, res) => {
  const projectName = project(req.params.project);
  const chapterNum = positiveInteger(req.params.num);
  const hasChapterId = req.query.chapter_id !== undefined;
  const hasVolumeId = req.query.volume_id !== undefined;
  const chapterId = hasChapterId ? positiveInteger(req.query.chapter_id) : null;
  const volumeId = hasVolumeId ? positiveInteger(req.query.volume_id) : null;
  if (!chapterNum || (hasChapterId && !chapterId) || (hasVolumeId && !volumeId)) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节身份参数无效', recoverable: true } });
  }

  let row;
  if (chapterId) {
    const volumeClause = volumeId ? ' AND c.volume_id = ?' : '';
    row = db.projectGet(
      projectName,
      `SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.id = ? AND c.num = ?${volumeClause}`,
      volumeId ? [chapterId, chapterNum, volumeId] : [chapterId, chapterNum],
    );
  } else if (volumeId) {
    row = db.projectGet(
      projectName,
      'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.num = ? AND c.volume_id = ?',
      [chapterNum, volumeId],
    );
  } else {
    const candidates = db.projectQuery(
      projectName,
      'SELECT c.*, v.title as volume_title FROM chapters c JOIN volumes v ON c.volume_id = v.id WHERE c.num = ? ORDER BY c.volume_id, c.id',
      [chapterNum],
    );
    if (candidates.length > 1) return ambiguousChapterResponse(res, chapterNum);
    row = candidates[0];
  }
  if (!row) return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${req.params.num} 不存在`, recoverable: true } });
  res.json(row);
});

router.put('/:project/chapters/:num', (req, res) => {
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
    status,
    cognitive_frame,
    emotional_anchor,
    world_texture,
    concrete_mystery,
    interpersonal_tension,
  } = body;
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

  let targetChapter;
  if (requestedChapterId !== undefined) {
    const chapterId = Number(requestedChapterId);
    if (!Number.isInteger(chapterId) || chapterId < 1) {
      return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '章节标识无效', recoverable: true } });
    }
    targetChapter = db.projectGet(projectName, 'SELECT id, num FROM chapters WHERE id = ?', [chapterId]);
    if (targetChapter && Number(targetChapter.num) !== chapterNum) {
      return res.status(409).json({
        error: {
          code: 'CHAPTER_IDENTITY_MISMATCH',
          message: `章节 ID ${chapterId} 与 URL 中的章节编号 ${chapterNum} 不匹配`,
          recoverable: true,
        },
      });
    }
  } else {
    const candidates = db.projectQuery(projectName, 'SELECT id FROM chapters WHERE num = ?', [chapterNum]);
    if (candidates.length > 1) {
      return res.status(409).json({
        error: {
          code: 'AMBIGUOUS_CHAPTER',
          message: `多个卷中存在第 ${chapterNum} 章，请提供章节标识`,
          recoverable: true,
        },
      });
    }
    targetChapter = candidates[0];
  }
  if (!targetChapter) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${num} 不存在`, recoverable: true } });
  }

  const fields = [];
  const params = [];
  if (title !== undefined) { fields.push('title = ?'); params.push(title); }
  if (content !== undefined) { fields.push('content = ?'); params.push(content); }
  if (outline !== undefined) { fields.push('outline = ?'); params.push(outline); }
  if (status !== undefined) { fields.push('status = ?'); params.push(status); }
  if (cognitive_frame !== undefined) { fields.push('cognitive_frame = ?'); params.push(cognitive_frame); }
  if (emotional_anchor !== undefined) { fields.push('emotional_anchor = ?'); params.push(emotional_anchor); }
  if (world_texture !== undefined) { fields.push('world_texture = ?'); params.push(world_texture); }
  if (concrete_mystery !== undefined) { fields.push('concrete_mystery = ?'); params.push(concrete_mystery); }
  if (interpersonal_tension !== undefined) { fields.push('interpersonal_tension = ?'); params.push(interpersonal_tension); }

  if (content !== undefined) {
    // Update word count for Chinese text
    const wc = content.replace(/\s/g, '').length;
    fields.push('word_count = ?');
    params.push(wc);
  }

  fields.push("updated_at = datetime('now')");
  params.push(targetChapter.id);
  if (hasExpectedDataVersion) params.push(expectedDataVersion);

  const versionClause = hasExpectedDataVersion ? ' AND data_version = ?' : '';
  const sql = `UPDATE chapters SET ${fields.join(', ')} WHERE id = ?${versionClause}`;
  const projectDb = db.getProjectDb(projectName);
  const updateResult = projectDb.transaction(() => {
    const changes = projectDb.prepare(sql).run(...params).changes;
    if (changes === 0) {
      const current = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(targetChapter.id);
      if (!current) return { changes, missing: true, updated: null };
      if (hasExpectedDataVersion) return { changes, conflict: true, current, updated: null };
      return { changes, missing: true, updated: null };
    }
    db.updateProjectWordCount(projectDb);
    return {
      changes,
      updated: projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(targetChapter.id),
    };
  })();
  const { changes } = updateResult;
  if (changes === 0) {
    if (updateResult.conflict) {
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
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${num} 不存在`, recoverable: true } });
  }
  res.json(updateResult.updated);
});

router.post('/:project/chapters', (req, res) => {
  const { title, volume_id = 1, outline = '', status = 'pending', chapter_num } = req.body || {};
  let num;
  if (chapter_num !== undefined) {
    num = chapter_num;
  } else {
    const maxNum = db.projectGet(project(req.params.project), 'SELECT MAX(num) as mx FROM chapters WHERE volume_id = ?', [volume_id]);
    num = (maxNum?.mx || 0) + 1;
  }
  db.projectExecute(project(req.params.project),
    'INSERT INTO chapters (volume_id, num, title, outline, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))',
    [volume_id, num, title, outline, status]
  );
  const created = db.projectGet(
    project(req.params.project),
    'SELECT * FROM chapters WHERE volume_id = ? AND num = ?',
    [volume_id, num],
  );
  res.status(201).json(created);
});

router.delete('/:project/chapters/:num', (req, res) => {
  const projectName = project(req.params.project);
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
    if (candidates.length > 1) return ambiguousChapterResponse(res, chapterNum);
    targetChapter = candidates[0];
  }
  if (!targetChapter) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${req.params.num} 不存在`, recoverable: true } });
  }

  const changes = projectDb.transaction(() => {
    projectDb.prepare('DELETE FROM chapter_revisions WHERE chapter_id = ?').run(targetChapter.id);
    const deleted = projectDb.prepare('DELETE FROM chapters WHERE id = ?').run(targetChapter.id).changes;
    if (deleted > 0) db.updateProjectWordCount(projectDb);
    return deleted;
  })();
  if (changes === 0) {
    return res.status(404).json({ error: { code: 'DB_NOT_FOUND', message: `章节 ${req.params.num} 不存在`, recoverable: true } });
  }
  res.json({
    success: true,
    chapter_id: targetChapter.id,
    volume_id: targetChapter.volume_id,
    deleted_num: targetChapter.num,
  });
});

router.patch('/:project/revisions/:revisionId', (req, res) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  if (!Number.isInteger(revisionId) || revisionId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订标识无效', recoverable: true } });
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

router.post('/:project/revisions/:revisionId/accept-all', (req, res) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  if (!Number.isInteger(revisionId) || revisionId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订标识无效', recoverable: true } });
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

router.post('/:project/revisions/:revisionId/reject-all', (req, res) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  if (!Number.isInteger(revisionId) || revisionId < 1) {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订标识无效', recoverable: true } });
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

router.post('/:project/revisions/:revisionId/finalize', (req, res) => {
  const projectName = project(req.params.project);
  const revisionId = Number(req.params.revisionId);
  const { content, expectedDecisions } = req.body || {};
  if (!Number.isInteger(revisionId) || revisionId < 1 || typeof content !== 'string') {
    return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: '修订确认参数无效', recoverable: true } });
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

router.get('/:project/volumes', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT * FROM volumes ORDER BY sort_order');
  for (const v of rows) {
    v.chapters = db.projectQuery(project(req.params.project),
      'SELECT * FROM chapters WHERE volume_id = ? ORDER BY num', [v.id]
    );
  }
  res.json(rows);
});

router.post('/:project/volumes', (req, res) => {
  const { title, summary = '' } = req.body || {};
  const pdb = db.getProjectDb(project(req.params.project));
  const max = pdb.prepare('SELECT COALESCE(MAX(sort_order), 0) as mx FROM volumes').get();
  const sortOrder = (max?.mx || 0) + 1;
  const result = pdb.prepare("INSERT INTO volumes (sort_order, title, summary, created_at) VALUES (?, ?, ?, datetime('now'))").run(sortOrder, title, summary);
  res.status(201).json({ id: result.lastInsertRowid, title });
});

router.put('/:project/volumes/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'volumes', req.params.id, req.body, ['title', 'summary'], false);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '卷不存在' } });
  res.json({ success: true });
});

router.delete('/:project/volumes/:id', (req, res) => {
  const { id } = req.params;
  const projectDb = db.getProjectDb(project(req.params.project));
  const changes = projectDb.transaction(() => {
    projectDb.prepare('DELETE FROM chapters WHERE volume_id = ?').run(id);
    const deleted = projectDb.prepare('DELETE FROM volumes WHERE id = ?').run(id).changes;
    if (deleted > 0) db.updateProjectWordCount(projectDb);
    return deleted;
  })();
  if (changes === 0) return res.status(404).json({ error: { message: '卷不存在' } });
  res.json({ success: true });
});

// ═══════════════════════════════════════════
// CHARACTERS
// ═══════════════════════════════════════════

router.get('/:project/characters', (req, res) => {
  const projectName = project(req.params.project);
  const chars = db.projectQuery(projectName, 'SELECT * FROM characters ORDER BY name');
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

  for (const c of chars) {
    c.appearances = appearancesByCharacter.get(c.id) || [];
    c.chapterCount = c.appearances.length;
  }
  res.json(chars);
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
  if (changes === 0) return res.status(404).json({ error: { message: '角色不存在' } });
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
  const id = randomUUID();
  db.projectExecute(project(req.params.project),
    'INSERT INTO world_entries (id, category, name, description, tags) VALUES (?, ?, ?, ?, ?)',
    [id, category, name, description, tags]
  );
  res.status(201).json({ id, name });
});

router.put('/:project/world/:id', (req, res) => {
  const changes = updateRecord(project(req.params.project), 'world_entries', req.params.id, req.body, ['category', 'name', 'description', 'tags'], true);
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '条目不存在' } });
  res.json({ success: true });
});

router.delete('/:project/world/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM world_entries WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '条目不存在' } });
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
  if (changes === 0) return res.status(404).json({ error: { message: '条目不存在' } });
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
  db.projectExecute(project(req.params.project),
    'INSERT INTO foreshadows (id, title, description, status, priority, expected_resolve_chapter) VALUES (?, ?, ?, ?, ?, ?)',
    [id, title, description, status, priority, expected_resolve_chapter]
  );
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
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '关系不存在' } });
  res.json({ success: true });
});

router.delete('/:project/relations/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM character_relations WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '关系不存在' } });
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
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '记忆不存在' } });
  res.json({ success: true });
});

router.delete('/:project/memories/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM memories WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '记忆不存在' } });
  res.json({ success: true });
});

// ─── Memory Search ───
router.post('/:project/memories/search', (req, res) => {
  const pn = project(req.params.project);
  const { query } = req.body || {};
  if (!query) return res.status(400).json({ error: { message: '缺少搜索关键词' } });
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
  if (changes === null) return res.status(400).json({ error: { message: '没有要更新的字段' } });
  if (changes === 0) return res.status(404).json({ error: { message: '事件不存在' } });
  res.json({ success: true });
});

router.delete('/:project/timeline/:id', (req, res) => {
  const changes = db.projectExecute(project(req.params.project), 'DELETE FROM timeline_events WHERE id = ?', [req.params.id]);
  if (changes === 0) return res.status(404).json({ error: { message: '事件不存在' } });
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

router.get('/:project/meta', (req, res) => {
  const rows = db.projectQuery(project(req.params.project), 'SELECT key, value FROM project_meta');
  const meta = {};
  for (const r of rows) meta[r.key] = r.value;
  meta.genres = db.projectQuery(project(req.params.project), 'SELECT genre FROM project_genres').map(g => g.genre);
  res.json(meta);
});

// ═══════════════════════════════════════════
// WORKFLOW PHASE
// ═══════════════════════════════════════════

router.get('/:project/workflow/phase', (req, res) => {
  const row = db.projectGet(project(req.params.project),
    "SELECT value FROM project_meta WHERE key = 'workflow_phase'"
  );
  res.json({ phase: row?.value || 'idea' });
});

router.put('/:project/workflow/phase', (req, res) => {
  const { phase } = req.body || {};
  const valid = ['idea', 'setting', 'outline', 'writing', 'review', 'consistency', 'export'];
  if (!phase || !valid.includes(phase)) {
    return res.status(400).json({ error: { message: `Invalid phase. Must be one of: ${valid.join(', ')}` } });
  }
  db.projectExecute(project(req.params.project),
    "INSERT OR REPLACE INTO project_meta (key, value) VALUES ('workflow_phase', ?)", [phase]
  );
  res.json({ success: true, phase });
});

// ═══════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════

router.get('/:project/stats', (req, res) => {
  const pn = project(req.params.project);
  const totalWords = db.projectGet(pn, 'SELECT SUM(word_count) as total FROM chapters')?.total || 0;
  const chCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM chapters')?.cnt || 0;
  const acceptedCount = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM chapters WHERE status = 'accepted'")?.cnt || 0;
  const charCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM characters')?.cnt || 0;
  const foreshadowCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM foreshadows')?.cnt || 0;
  const resolvedForeshadow = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM foreshadows WHERE status = 'resolved'")?.cnt || 0;
  const overdueForeshadow = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM foreshadows WHERE status = 'planted' AND expected_resolve_chapter < (SELECT COALESCE(MAX(num), 0) FROM chapters)")?.cnt || 0;
  const worldCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM world_entries')?.cnt || 0;
  const sciCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM science_entries')?.cnt || 0;
  const relCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM character_relations')?.cnt || 0;
  const memCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM memories')?.cnt || 0;
  const tlCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM timeline_events')?.cnt || 0;
  const volCount = db.projectGet(pn, 'SELECT COUNT(*) as cnt FROM volumes')?.cnt || 0;
  const clueUnresolved = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM clue_board WHERE resolved = 0")?.cnt || 0;
  const clueResolved = db.projectGet(pn, "SELECT COUNT(*) as cnt FROM clue_board WHERE resolved = 1")?.cnt || 0;
  const genres = db.projectQuery(pn, 'SELECT genre FROM project_genres').map(g => g.genre);
  const tokenUsage = db.projectGet(pn, 'SELECT COALESCE(SUM(input_tokens), 0) as input, COALESCE(SUM(output_tokens), 0) as output FROM token_usage') || { input: 0, output: 0 };

  // Target words: custom override or fallback to project mode default
  const projectMode = db.projectGet(pn, "SELECT value FROM project_meta WHERE key = 'mode'")?.value || 'medium-novel';
  const TARGET_WORDS = { 'short-story': 30000, 'medium-novel': 100000, 'long-novel': 200000 };
  const customTarget = db.projectGet(pn, "SELECT value FROM project_meta WHERE key = 'target_words'")?.value;
  const targetWords = customTarget ? parseInt(customTarget) : (TARGET_WORDS[projectMode] || 100000);

  // Volume structure summary
  const volumes = db.projectQuery(pn, 'SELECT id, title, sort_order, (SELECT COUNT(*) FROM chapters WHERE volume_id = volumes.id) as chapter_count, (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE volume_id = volumes.id) as word_count FROM volumes ORDER BY sort_order');

  // Daily word counts for sparkline (last 7 days)
  const rawDaily = db.projectQuery(pn,
    "SELECT date(updated_at) as day, SUM(word_count) as words FROM chapters WHERE updated_at >= date('now', '-6 days') GROUP BY date(updated_at) ORDER BY day"
  );
  const dailyMap = {};
  for (const r of rawDaily) dailyMap[r.day] = r.words;
  const dailyWords = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dailyWords.push(dailyMap[key] || 0);
  }

  res.json({
    totalWords, chapterCount: chCount, acceptedCount, characterCount: charCount,
    foreshadowCount, resolvedForeshadow, overdueForeshadow, worldCount, sciCount,
    relationCount: relCount, memoryCount: memCount, timelineCount: tlCount,
    volumeCount: volCount, volumes,
    clueUnresolved, clueResolved,
    genres,
    tokenInput: tokenUsage.input || 0, tokenOutput: tokenUsage.output || 0,
    targetWords,
    currentChapter: db.projectGet(pn, "SELECT * FROM chapters WHERE status = 'writing' ORDER BY num LIMIT 1"),
    chapters: db.projectQuery(pn, 'SELECT id, num, title, word_count, status FROM chapters ORDER BY num'),
    dailyWords,
    });
  });

// ─── Target words ───

router.put('/:project/target-words', (req, res) => {
  const pn = project(req.params.project);
  const { targetWords } = req.body;
  if (typeof targetWords !== 'number' || targetWords < 1000) {
    return res.status(400).json({ error: { message: 'targetWords must be a number ≥ 1000' } });
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
  if (!data) return res.status(400).json({ error: { message: '缺少图片数据' } });
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
  res.status(404).json({ error: { message: '未上传封面' } });
});

router.delete('/:project/cover', (req, res) => {
  const pn = project(req.params.project);
  let stagedFiles = [];
  try {
    stagedFiles = stageProjectCoverFiles(pn);
    if (stagedFiles.length === 0) return res.status(404).json({ error: { message: '未上传封面' } });
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

router.get('/:project/export', async (req, res) => {
  const { format = 'txt' } = req.query;
  const pn = project(req.params.project);
  const chapters = db.projectQuery(pn, `
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
  const volumes = db.projectQuery(pn, 'SELECT * FROM volumes ORDER BY sort_order');
  const meta = {};
  db.projectQuery(pn, 'SELECT key, value FROM project_meta').forEach(m => meta[m.key] = m.value);
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
        return res.status(error.status).json({
          error: { code: error.code, message: error.message, recoverable: true },
        });
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
  if (!title) return res.status(400).json({ error: { code: 'INVALID_PARAMS', message: 'title is required' } });
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
