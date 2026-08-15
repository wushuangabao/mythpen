const {
  isPolishOutputTruncated,
  isSuccessfulTextFinishReason,
  normalizeFinishReason,
} = require('./ai-polish-completion');
const { createManuscriptService } = require('./manuscript-service');

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

function saveContinuation(
  database,
  projectName,
  chapterId,
  continuation,
  finishReason,
  expectedBodyHash,
  usage,
) {
  validateContinuationCompletion(continuation, finishReason);
  if (!Number.isInteger(chapterId) || chapterId < 1) {
    throw new ContinuationSaveError('chapter_invalid', 'Chapter identifier is invalid');
  }

  const result = createManuscriptService(database).appendChapterBody({
    projectName,
    chapterId,
    appended: continuation,
    expectedBodyHash,
    source: 'ai_continue',
    usage,
  });
  if (result.missing) {
    throw new ContinuationSaveError('chapter_missing', 'Chapter no longer exists');
  }
  if (result.conflict) {
    throw new ContinuationSaveError(
      'continuation_conflict',
      'Chapter changed while the continuation was being generated',
    );
  }
  return {
    chapterId: result.chapterId,
    content: result.content,
    wordCount: result.wordCount,
    dataVersion: result.dataVersion,
  };
}

module.exports = { ContinuationSaveError, saveContinuation, validateContinuationCompletion };
