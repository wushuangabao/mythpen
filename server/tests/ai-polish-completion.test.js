const assert = require('node:assert/strict');
const test = require('node:test');

const { getPolishStreamFailure, isPolishOutputTruncated } = require('../ai-polish-completion');

test('polish rejects a non-empty result when the provider reached its output limit', () => {
  assert.equal(isPolishOutputTruncated('length'), true);
  assert.equal(isPolishOutputTruncated('max_tokens'), true);
  assert.deepEqual(getPolishStreamFailure('length', 'partial polished chapter'), {
    code: 'polish_output_limit',
    error: 'AI reached its output limit before producing the polished chapter',
  });
  assert.deepEqual(getPolishStreamFailure('max_tokens', 'partial Claude chapter'), {
    code: 'polish_output_limit',
    error: 'AI reached its output limit before producing the polished chapter',
  });
});

test('polish accepts completed content and still rejects an empty response', () => {
  assert.equal(getPolishStreamFailure('stop', 'complete polished chapter'), null);
  assert.equal(getPolishStreamFailure('end_turn', 'complete Claude chapter'), null);
  assert.equal(getPolishStreamFailure('stop_sequence', 'complete stopped chapter'), null);
  assert.deepEqual(getPolishStreamFailure('stop', ''), {
    code: 'polish_empty_response',
    error: 'AI did not return a polished chapter',
  });
});

test('polish rejects abnormal and unconfirmed stream endings even when text is non-empty', () => {
  for (const reason of ['content_filter', 'refusal', 'tool_use', 'pause_turn', 'done', 'unknown_provider_reason']) {
    const failure = getPolishStreamFailure(reason, 'partial chapter');
    assert.equal(failure.code, 'polish_incomplete_response');
    assert.match(failure.error, new RegExp(reason));
  }

  assert.deepEqual(getPolishStreamFailure(null, 'partial chapter'), {
    code: 'polish_incomplete_response',
    error: 'AI stream ended without confirming that the polished chapter was complete',
  });
});
