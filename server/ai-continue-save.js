const {
  isPolishOutputTruncated,
  isSuccessfulTextFinishReason,
  normalizeFinishReason,
} = require('./ai-polish-completion');
const { createManuscriptService } = require('./manuscript-service');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

async function saveFilesContinuation({
  runtime,
  projectUid,
  chapter,
  baseWitness,
  continuation,
  finishReason,
  requestId,
}) {
  validateContinuationCompletion(continuation, finishReason);
  if (typeof runtime?.write !== 'function') {
    throw new TypeError('runtime.write is required');
  }
  if (!UUID_PATTERN.test(projectUid)) {
    throw new ContinuationSaveError('chapter_invalid', 'Project identifier is invalid');
  }
  if (!UUID_PATTERN.test(chapter?.chapter_uid)) {
    throw new ContinuationSaveError('chapter_invalid', 'Chapter identifier is invalid');
  }
  if (typeof chapter.content !== 'string') {
    throw new ContinuationSaveError('chapter_invalid', 'Chapter body is unavailable');
  }
  if (
    !Number.isSafeInteger(chapter.data_version)
    || chapter.data_version < 0
    || baseWitness?.expectedDataVersion !== chapter.data_version
  ) {
    throw new ContinuationSaveError(
      'continuation_conflict',
      'Chapter generation-start witness is invalid',
    );
  }
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new ContinuationSaveError('continuation_request_invalid', 'Continuation request ID is required');
  }

  const content = chapter.content
    ? `${chapter.content}\n\n${continuation}`
    : continuation;
  await runtime.write(
    Object.freeze({ projectUid }),
    Object.freeze({
      requestId,
      baseWitness,
      command: Object.freeze({
        kind: 'chapter.replace_body',
        chapterUid: chapter.chapter_uid,
        expected_data_version: chapter.data_version,
        content,
      }),
    }),
  );
  return Object.freeze({
    chapterUid: chapter.chapter_uid,
    content,
    wordCount: content.replace(/\s/g, '').length,
    dataVersion: chapter.data_version + 1,
  });
}

module.exports = {
  ContinuationSaveError,
  saveContinuation,
  saveFilesContinuation,
  validateContinuationCompletion,
};
