const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getContinuationStreamOverrides,
  getPolishStreamOverrides,
} = require('../ai-polish-request');
const { OpenAIProvider } = require('../ai-adapter');
const {
  DEFAULT_AI_REQUEST_PARAMETER_CONFIG,
  validateRequestParameterConfig,
} = require('../ai-request-parameters');

test('OpenAI continuation requests usage for ordinary compatible models', () => {
  assert.deepEqual(getContinuationStreamOverrides('gpt-compatible', 'openai'), {
    params: { stream_options: { include_usage: true } },
  });
});

test('Kimi continuation requests usage and omits unsupported temperature', () => {
  assert.deepEqual(getContinuationStreamOverrides('vendor/kimi-k3-preview', 'openai'), {
    params: { stream_options: { include_usage: true } },
    omit: ['temperature'],
  });
});

test('Kimi preview continuation omits temperature with an existing legacy parameter config', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    const bytes = new TextEncoder().encode('data: [DONE]\n\n');
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };

  try {
    const model = 'vendor/kimi-k3-preview';
    const legacyConfig = validateRequestParameterConfig({
      version: 1,
      defaults: {
        params: { max_tokens: 4096 },
        operations: { stream: { params: { temperature: 0.85 } } },
      },
      // Simulate a persisted file created before Kimi K3 Preview was added.
      models: [],
    });
    const provider = new OpenAIProvider({
      apiModel: model,
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, legacyConfig);

    for await (const _event of provider.stream(
      'system',
      [{ role: 'user', content: 'continue' }],
      0.85,
      getContinuationStreamOverrides(model, 'openai'),
    )) {
      // Drain the stream so the final request body is observed.
    }

    assert.equal('temperature' in captured, false);
    assert.equal(captured.max_tokens, 4096);
    assert.deepEqual(captured.stream_options, { include_usage: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Claude continuation does not receive OpenAI stream_options', () => {
  assert.equal(getContinuationStreamOverrides('claude-opus-5', 'claude'), undefined);
});

test('OpenAI polish requests usage for ordinary models', () => {
  assert.deepEqual(getPolishStreamOverrides('gpt-compatible', 'openai'), {
    params: { stream_options: { include_usage: true } },
  });
});

test('Kimi polish retains its completion budget and requests usage', () => {
  assert.deepEqual(getPolishStreamOverrides('vendor/kimi-k3-preview', 'openai'), {
    params: {
      stream_options: { include_usage: true },
      reasoning_effort: 'low',
      max_completion_tokens: 32768,
    },
    omit: ['max_tokens', 'temperature'],
  });
});

test('Kimi preview polish removes temperature from the final request body', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    const bytes = new TextEncoder().encode('data: [DONE]\n\n');
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };

  try {
    const model = 'vendor/kimi-k3-preview';
    const provider = new OpenAIProvider({
      apiModel: model,
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, validateRequestParameterConfig(DEFAULT_AI_REQUEST_PARAMETER_CONFIG));

    for await (const _event of provider.stream(
      'system',
      [{ role: 'user', content: 'polish' }],
      0.35,
      getPolishStreamOverrides(model, 'openai'),
    )) {
      // Drain the stream so the final request body is observed.
    }

    assert.equal('temperature' in captured, false);
    assert.equal('max_tokens' in captured, false);
    assert.equal(captured.max_completion_tokens, 32768);
    assert.equal(captured.reasoning_effort, 'low');
  } finally {
    global.fetch = originalFetch;
  }
});

test('configured stream omissions remain final after Kimi task overrides', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    const bytes = new TextEncoder().encode('data: [DONE]\n\n');
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };

  try {
    const model = 'vendor/kimi-k3-preview';
    const config = validateRequestParameterConfig({
      version: 1,
      defaults: {
        params: { max_tokens: 4096 },
        operations: {
          stream: {
            params: { temperature: 0.85 },
            omit: ['stream_options'],
          },
        },
      },
      // Exercise the compatibility fallback for persisted configs that predate
      // this model while still honoring the user's explicit provider omission.
      models: [],
    });
    const provider = new OpenAIProvider({
      apiModel: model,
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, config);

    for await (const _event of provider.stream(
      'system',
      [{ role: 'user', content: 'polish' }],
      0.35,
      getPolishStreamOverrides(model, 'openai'),
    )) {
      // Drain the request.
    }

    assert.equal('stream_options' in captured, false);
    assert.equal('temperature' in captured, false);
    assert.equal('max_tokens' in captured, false);
    assert.equal(captured.max_completion_tokens, 32768);
    assert.equal(captured.reasoning_effort, 'low');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Claude polish does not receive OpenAI stream_options', () => {
  assert.equal(getPolishStreamOverrides('claude-opus-5', 'claude'), undefined);
});
