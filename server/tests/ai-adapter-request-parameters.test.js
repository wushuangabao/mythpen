const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OpenAIProvider,
  ClaudeProvider,
  createAIAdapter,
} = require('../ai-adapter');
const {
  validateRequestParameterConfig,
} = require('../ai-request-parameters');

function configWithParameters() {
  return validateRequestParameterConfig({
    version: 1,
    defaults: {
      params: { max_tokens: 1234 },
      operations: {
        complete: { params: { temperature: 0.4 } },
        stream: { params: { temperature: 0.5 } },
      },
    },
    models: [{
      name: 'Configured',
      match: { models: ['configured'], apiTypes: ['openai', 'claude'] },
      params: { reasoning_effort: 'high' },
      omit: ['temperature'],
    }],
  });
}

test('OpenAI complete applies configured params and preserves protocol fields', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: {},
      }),
    };
  };
  try {
    const provider = new OpenAIProvider({
      apiModel: 'configured',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, configWithParameters());
    await provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0);
    assert.deepEqual(captured, {
      model: 'configured',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      tools: [],
      max_tokens: 1234,
      reasoning_effort: 'high',
      stream: false,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAI stream uses stream operation params and yields content', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"片段"}}]}\n\ndata: [DONE]\n\n',
    );
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
    const provider = new OpenAIProvider({
      apiModel: 'configured',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, configWithParameters());
    const events = [];
    for await (const event of provider.stream(
      'system',
      [{ role: 'user', content: 'hello' }],
      0,
    )) {
      events.push(event);
    }
    assert.equal(captured.stream, true);
    assert.equal(captured.max_tokens, 1234);
    assert.equal(captured.reasoning_effort, 'high');
    assert.equal('temperature' in captured, false);
    assert.deepEqual(events, [{ type: 'chunk', text: '片段' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Claude complete applies the same resolver before SDK invocation', async () => {
  let captured;
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters());
  provider.client = {
    messages: {
      create: async params => {
        captured = params;
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: {},
        };
      },
    },
  };

  await provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0);
  assert.equal(captured.model, 'configured');
  assert.equal(captured.max_tokens, 1234);
  assert.equal(captured.reasoning_effort, 'high');
  assert.equal('temperature' in captured, false);
  assert.equal(captured.system, 'system');
  assert.deepEqual(captured.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal('tools' in captured, false);
});

test('Claude stream applies stream parameters and keeps SDK streaming behavior', async () => {
  let captured;
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters());
  provider.client = {
    messages: {
      stream: params => {
        captured = params;
        return (async function* events() {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '片段' },
          };
        }());
      },
    },
  };

  const events = [];
  for await (const event of provider.stream(
    'system',
    [{ role: 'user', content: 'hello' }],
    0,
  )) {
    events.push(event);
  }
  assert.equal(captured.max_tokens, 1234);
  assert.equal(captured.reasoning_effort, 'high');
  assert.equal('temperature' in captured, false);
  assert.equal('stream' in captured, false);
  assert.deepEqual(events, [
    { type: 'chunk', text: '片段' },
    { type: 'usage', inputTokens: 0, outputTokens: 0 },
  ]);
});

test('createAIAdapter reads the loader once and each Adapter keeps its snapshot', () => {
  const firstConfig = validateRequestParameterConfig({
    version: 1,
    defaults: { params: { marker: 'first' } },
    models: [],
  });
  const secondConfig = validateRequestParameterConfig({
    version: 1,
    defaults: { params: { marker: 'second' } },
    models: [],
  });
  let calls = 0;
  const loader = {
    getSnapshot() {
      calls += 1;
      return calls === 1 ? firstConfig : secondConfig;
    },
  };
  const base = {
    apiModel: 'model',
    apiKey: 'test',
    apiBaseUrl: 'https://example.invalid/v1',
  };

  const first = createAIAdapter('model', { ...base }, 'openai', {
    requestParameterLoader: loader,
  });
  const second = createAIAdapter('model', { ...base }, 'openai', {
    requestParameterLoader: loader,
  });

  assert.equal(calls, 2);
  assert.equal(first.requestParameterConfig, firstConfig);
  assert.equal(second.requestParameterConfig, secondConfig);
});
