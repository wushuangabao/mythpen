const OUTPUT_LIMIT_FINISH_REASONS = new Set([
  'length',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'model_context_window_exceeded',
]);

// Only model-level terminal states that mean the model deliberately completed
// a text response are safe for a full-chapter replacement. A transport-level
// `[DONE]` marker is deliberately not a success reason.
const SUCCESS_FINISH_REASONS = new Set([
  'stop',
  'end_turn',
  'stop_sequence',
]);

function normalizeFinishReason(finishReason) {
  return String(finishReason || '').trim().toLowerCase();
}

function isPolishOutputTruncated(finishReason) {
  return OUTPUT_LIMIT_FINISH_REASONS.has(normalizeFinishReason(finishReason));
}

function isSuccessfulTextFinishReason(finishReason) {
  return SUCCESS_FINISH_REASONS.has(normalizeFinishReason(finishReason));
}

function getPolishStreamFailure(finishReason, proposedContent) {
  if (isPolishOutputTruncated(finishReason)) {
    return {
      code: 'polish_output_limit',
      error: 'AI reached its output limit before producing the polished chapter',
    };
  }

  if (!proposedContent) {
    return {
      code: 'polish_empty_response',
      error: 'AI did not return a polished chapter',
    };
  }

  const normalizedReason = normalizeFinishReason(finishReason);
  if (!isSuccessfulTextFinishReason(normalizedReason)) {
    return {
      code: 'polish_incomplete_response',
      error: normalizedReason
        ? `AI stopped before completing the polished chapter (${normalizedReason})`
        : 'AI stream ended without confirming that the polished chapter was complete',
    };
  }

  return null;
}

module.exports = {
  getPolishStreamFailure,
  isSuccessfulTextFinishReason,
  isPolishOutputTruncated,
  normalizeFinishReason,
};
