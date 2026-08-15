const db = require('./db');
const { internals: manuscriptInternals } = require('./manuscript-service');

const DECISIONS = new Set(['accepted', 'rejected']);
const CHAPTER_STATUSES = new Set(['pending', 'writing', 'review', 'accepted']);

function normalizeChapterStatus(status, content) {
  if (CHAPTER_STATUSES.has(status)) return status;
  return String(content || '').trim() ? 'writing' : 'pending';
}

function parseDecisions(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, decision]) => DECISIONS.has(decision)),
    );
  } catch {
    return {};
  }
}

function isDecisionMap(value) {
  return !!value
    && !Array.isArray(value)
    && typeof value === 'object'
    && Object.values(value).every((decision) => DECISIONS.has(decision));
}

function decisionsMatch(left, right) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([changeId, decision]) => right[changeId] === decision);
}

function serializeRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    chapterId: row.chapter_id,
    baseContent: row.base_content,
    proposedContent: row.proposed_content,
    decisions: parseDecisions(row.decisions_json),
    status: row.status,
    previousChapterStatus: row.previous_chapter_status || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function getPendingRevision(projectDb, revisionId) {
  return projectDb
    .prepare(`SELECT r.*, c.content AS current_content, c.status AS current_status,
        c.word_count AS current_word_count
      FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id
      WHERE r.id = ? AND r.status = 'pending'`)
    .get(revisionId);
}

function rebasePendingRevision(projectDb, revision) {
  const currentContent = revision.current_content ?? '';
  const baseContent = revision.base_content ?? '';
  if (currentContent === baseContent) {
    return { revision: serializeRevision(revision), rebased: false };
  }

  // A revision is always displayed against the text currently stored in the chapter.
  // The proposed full text stays intact, while prior per-change decisions are no
  // longer meaningful because the diff blocks have changed.
  projectDb
    .prepare("UPDATE chapter_revisions SET base_content = ?, decisions_json = '{}', updated_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(currentContent, revision.id);
  const rebasedRevision = projectDb.prepare('SELECT * FROM chapter_revisions WHERE id = ?').get(revision.id);
  return { revision: serializeRevision(rebasedRevision), rebased: true };
}

function ensureRevisionBase(projectDb, revision, expectedBaseContent) {
  const rebaseResult = rebasePendingRevision(projectDb, revision);
  if (rebaseResult.rebased) return rebaseResult;

  // A client can hold an older copy of the same revision while another reader
  // has already rebased it. Do not apply its old hunk decisions to the new diff.
  if (expectedBaseContent !== (revision.base_content ?? '')) {
    return { revision: rebaseResult.revision, rebased: true };
  }
  return rebaseResult;
}

function getActiveRevision(projectName, chapterId) {
  const projectDb = db.getProjectDb(projectName);
  return projectDb.transaction(() => {
    // Always return the chapter's monotonic data version, even when there is
    // no pending revision. A window may never have observed a proposal before
    // another window resolves it; the version is then the only signal that its
    // pre-revision editor snapshot is no longer authoritative.
    const chapter = projectDb
      .prepare('SELECT data_version FROM chapters WHERE id = ?')
      .get(chapterId);
    const revision = projectDb
      .prepare(`SELECT r.*, c.content AS current_content
        FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id
        WHERE r.chapter_id = ? AND r.status = 'pending'
        ORDER BY r.id DESC LIMIT 1`)
      .get(chapterId);
    if (!revision) {
      return {
        revision: null,
        rebased: false,
        chapterDataVersion: chapter?.data_version,
      };
    }
    return {
      ...rebasePendingRevision(projectDb, revision),
      chapterDataVersion: chapter?.data_version,
    };
  })();
}

function createPendingRevision(projectName, chapterId, baseContent, proposedContent) {
  if (typeof baseContent !== 'string' || typeof proposedContent !== 'string') {
    throw new Error('修订稿内容格式无效');
  }

  const projectDb = db.getProjectDb(projectName);
  return projectDb.transaction(() => {
    const chapter = projectDb.prepare('SELECT id, content, status FROM chapters WHERE id = ?').get(chapterId);
    if (!chapter) return { missing: true };

    // The AI may finish after someone has edited the chapter. Keep the AI candidate,
    // but compare it to the newer text rather than rejecting the revision as stale.
    const currentContent = chapter.content || '';
    const rebased = currentContent !== baseContent;
    if (currentContent === proposedContent) return { unchanged: true, rebased };

    const priorPendingRevision = projectDb
      .prepare(`SELECT previous_chapter_status
        FROM chapter_revisions
        WHERE chapter_id = ? AND status = 'pending'
        ORDER BY id DESC LIMIT 1`)
      .get(chapterId);
    // Creating a replacement proposal while another one is pending carries the
    // status from before the first proposal only while the chapter is still in
    // the temporary review state. If another action changed the chapter status,
    // that newer status is the baseline the replacement must restore.
    const previousChapterStatus = normalizeChapterStatus(
      chapter.status === 'review'
        ? priorPendingRevision?.previous_chapter_status || chapter.status
        : chapter.status,
      currentContent,
    );

    projectDb
      .prepare("UPDATE chapter_revisions SET status = 'superseded', updated_at = datetime('now'), resolved_at = datetime('now') WHERE chapter_id = ? AND status = 'pending'")
      .run(chapterId);
    projectDb
      .prepare("UPDATE chapters SET status = 'review', updated_at = datetime('now') WHERE id = ?")
      .run(chapterId);
    projectDb
      .prepare(`INSERT INTO chapter_revisions
        (chapter_id, base_content, proposed_content, previous_chapter_status)
        VALUES (?, ?, ?, ?)`)
      .run(chapterId, currentContent, proposedContent, previousChapterStatus);
    const inserted = projectDb.prepare('SELECT last_insert_rowid() AS id').get();
    const revision = projectDb.prepare('SELECT * FROM chapter_revisions WHERE id = ?').get(inserted.id);
    return { revision: serializeRevision(revision), rebased };
  })();
}

function updateRevisionDecisions(projectName, revisionId, decisions, expectedBaseContent) {
  if (!isDecisionMap(decisions) || typeof expectedBaseContent !== 'string') return { invalid: true };

  const projectDb = db.getProjectDb(projectName);
  return projectDb.transaction(() => {
    const revision = getPendingRevision(projectDb, revisionId);
    if (!revision) return { missing: true };

    const rebaseResult = ensureRevisionBase(projectDb, revision, expectedBaseContent);
    if (rebaseResult.rebased) return rebaseResult;

    // PATCH carries the decisions this client knows about, not an authoritative
    // replacement of the whole map. Merge while holding the transaction so a
    // client that started from an older snapshot cannot erase decisions saved
    // by another client for different hunks. A decision for the same hunk keeps
    // normal last-write-wins semantics.
    const mergedDecisions = {
      ...parseDecisions(revision.decisions_json),
      ...decisions,
    };
    projectDb
      .prepare("UPDATE chapter_revisions SET decisions_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(mergedDecisions), revisionId);
    return { revision: serializeRevision(projectDb.prepare('SELECT * FROM chapter_revisions WHERE id = ?').get(revisionId)) };
  })();
}

function applyRevision(projectName, revisionId, action, content, expectedBaseContent, expectedDecisions) {
  if (typeof expectedBaseContent !== 'string') return { invalid: true };
  if (action === 'finalize' && !isDecisionMap(expectedDecisions)) return { invalid: true };

  const applyInTransaction = (projectDb) => {
    const revision = getPendingRevision(projectDb, revisionId);
    if (!revision) return { missing: true };

    const rebaseResult = ensureRevisionBase(projectDb, revision, expectedBaseContent);
    if (rebaseResult.rebased) return rebaseResult;

    if (action === 'finalize') {
      // The client materializes a mixed decision result. Verify its complete
      // decision snapshot while the same transaction still owns the pending
      // revision; otherwise a later PATCH from another window could be
      // finalized using this client's stale content.
      const currentDecisions = parseDecisions(revision.decisions_json);
      if (!decisionsMatch(expectedDecisions, currentDecisions)) {
        return { revision: serializeRevision(revision), conflicted: true };
      }
    }

    if (action === 'reject-all') {
      projectDb
        .prepare("UPDATE chapter_revisions SET status = 'rejected', updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?")
        .run(revisionId);
      const previousChapterStatus = normalizeChapterStatus(
        revision.previous_chapter_status,
        revision.base_content,
      );
      // Do not overwrite a status explicitly changed by another action while
      // the review was open; only undo the temporary state set by this feature.
      projectDb
        .prepare("UPDATE chapters SET status = ?, updated_at = datetime('now') WHERE id = ? AND status = 'review'")
        .run(previousChapterStatus, revision.chapter_id);
      const resolvedChapter = projectDb
        .prepare('SELECT content, word_count, status, data_version FROM chapters WHERE id = ?')
        .get(revision.chapter_id);
      return {
        rejected: true,
        chapterId: revision.chapter_id,
        content: resolvedChapter?.content || '',
        wordCount: resolvedChapter?.word_count || 0,
        status: resolvedChapter?.status || previousChapterStatus,
        dataVersion: resolvedChapter?.data_version,
      };
    }

    const nextContent = action === 'accept-all' ? revision.proposed_content : content;
    if (typeof nextContent !== 'string') return { invalid: true };
    const updated = manuscriptInternals.writeChapterBodyInTransaction({
      projectName,
      projectDb,
      chapterId: revision.chapter_id,
      content: nextContent,
      expectedBodyContent: revision.base_content ?? '',
      source: 'revision_accept',
      status: 'accepted',
    });
    if (updated.changes === 0) {
      const latestRevision = getPendingRevision(projectDb, revisionId);
      if (!latestRevision) return { missing: true };
      return rebasePendingRevision(projectDb, latestRevision);
    }

    projectDb
      .prepare("UPDATE chapter_revisions SET status = 'accepted', updated_at = datetime('now'), resolved_at = datetime('now') WHERE id = ?")
      .run(revisionId);
    return {
      accepted: true,
      chapterId: revision.chapter_id,
      content: updated.content,
      wordCount: updated.wordCount,
      dataVersion: updated.dataVersion,
    };
  };
  const result = action === 'reject-all'
    ? (() => {
      const projectDb = db.getProjectDb(projectName);
      return projectDb.transaction(() => applyInTransaction(projectDb))();
    })()
    : db.runManuscriptTransaction(projectName, applyInTransaction);
  return result;
}

module.exports = {
  applyRevision,
  createPendingRevision,
  getActiveRevision,
  parseDecisions,
  serializeRevision,
  updateRevisionDecisions,
};
