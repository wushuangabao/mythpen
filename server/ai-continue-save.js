const {
  isPolishOutputTruncated,
  isSuccessfulTextFinishReason,
  normalizeFinishReason,
} = require('./ai-polish-completion');

class ContinuationSaveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContinuationSaveError';
    this.code = code;
  }
}

function validateContinuationCompletion(continuation, finishReason) {
  if (typeof continuation !== 'string' || !continuation.trim()) {
    throw new ContinuationSaveError('continuation_empty', 'AI did not return continuation content');
  }

  if (isSuccessfulTextFinishReason(finishReason)) return;
  const normalizedReason = normalizeFinishReason(finishReason);
  if (isPolishOutputTruncated(normalizedReason)) {
    throw new ContinuationSaveError(
      'continuation_output_limit',
      'AI reached its output limit before completing the continuation',
    );
  }
  throw new ContinuationSaveError(
    'continuation_incomplete_response',
    normalizedReason
      ? `AI stopped before completing the continuation (${normalizedReason})`
      : 'AI stream ended without confirming that the continuation was complete',
  );
}

function saveContinuation(database, projectName, chapterId, continuation, finishReason) {
  validateContinuationCompletion(continuation, finishReason);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    throw new ContinuationSaveError('chapter_invalid', 'Chapter identifier is invalid');
  }

  const projectDb = database.getProjectDb(projectName);
  return projectDb.transaction(() => {
    const chapter = projectDb
      .prepare('SELECT id, content FROM chapters WHERE id = ?')
      .get(chapterId);
    if (!chapter) {
      throw new ContinuationSaveError('chapter_missing', 'Chapter no longer exists');
    }

    const existingContent = chapter.content || '';
    const nextContent = existingContent
      ? `${existingContent}\n\n${continuation}`
      : continuation;
    const wordCount = nextContent.replace(/\s/g, '').length;
    const updated = projectDb
      .prepare("UPDATE chapters SET content = ?, word_count = ?, status = 'writing', updated_at = datetime('now') WHERE id = ?")
      .run(nextContent, wordCount, chapter.id);
    if (updated.changes === 0) {
      throw new ContinuationSaveError('chapter_missing', 'Chapter no longer exists');
    }

    database.updateProjectWordCount(projectDb);
    const persistedChapter = projectDb
      .prepare('SELECT data_version FROM chapters WHERE id = ?')
      .get(chapter.id);
    return {
      chapterId: chapter.id,
      content: nextContent,
      wordCount,
      dataVersion: persistedChapter?.data_version,
    };
  })();
}

module.exports = { ContinuationSaveError, saveContinuation, validateContinuationCompletion };
