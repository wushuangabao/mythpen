const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

const {
  OpenAIProvider,
  ClaudeProvider,
  createAIAdapter,
  createStreamAbortContext,
  executeToolCallsWithAbort,
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

function legacyConfigWithoutKimiRule() {
  return validateRequestParameterConfig({
    version: 1,
    defaults: {
      params: { max_tokens: 4096 },
      operations: {
        complete: { params: { temperature: 0.8 } },
        stream: { params: { temperature: 0.85 } },
      },
    },
    models: [],
  });
}

test('AI stream abort context distinguishes a client disconnect from a normal response close', () => {
  const request = new EventEmitter();
  request.aborted = false;
  const response = new EventEmitter();
  response.writableEnded = false;
  response.destroyed = false;
  response.closed = false;

  const disconnected = createStreamAbortContext(request, response);
  assert.equal(disconnected.canWrite(), true);
  response.emit('close');
  assert.equal(disconnected.signal.aborted, true);
  assert.equal(disconnected.isDisconnected(), true);
  assert.equal(disconnected.canWrite(), false);
  disconnected.cleanup();
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(response.listenerCount('close'), 0);

  const completedRequest = new EventEmitter();
  completedRequest.aborted = false;
  const completedResponse = new EventEmitter();
  completedResponse.writableEnded = false;
  completedResponse.destroyed = false;
  completedResponse.closed = false;
  const completed = createStreamAbortContext(completedRequest, completedResponse);
  completedResponse.writableEnded = true;
  completedResponse.emit('close');
  assert.equal(completed.signal.aborted, false);
  completed.cleanup();
});

test('tool-call batch yields for cancellation and skips the announced tool plus later calls', async () => {
  let disconnected = false;
  const announced = [];
  const executed = [];
  const completed = [];
  const streamContext = { isDisconnected: () => disconnected };

  const finished = await executeToolCallsWithAbort(
    [
      { id: 'first', name: 'update_chapter', args: {} },
      { id: 'second', name: 'delete_chapter', args: {} },
      { id: 'third', name: 'delete_volume', args: {} },
    ],
    streamContext,
    toolCall => {
      executed.push(toolCall.id);
      return { ok: true };
    },
    {
      onToolCall: toolCall => {
        announced.push(toolCall.id);
        if (toolCall.id === 'second') setImmediate(() => { disconnected = true; });
      },
      onToolResult: toolCall => completed.push(toolCall.id),
    },
  );

  assert.equal(finished, false);
  assert.deepEqual(announced, ['first', 'second']);
  assert.deepEqual(executed, ['first']);
  assert.deepEqual(completed, ['first']);
});

test('a marked manuscript persistence failure aborts the provider tool batch before later writes', async (t) => {
  withIsolatedDataDir(t);
  const database = require('../db');
  const { executeTool } = require('../tools');
  const {
    createChapter,
    isManuscriptPersistenceError,
  } = require('../manuscript-service');
  const projectName = 'ai-tool-persistence-abort';
  await database.initDatabase();
  const projectDb = database.createProjectDb(projectName);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  const chapter = createChapter({
    projectName,
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Chapter', content: 'Before body' },
  }).chapter;
  // Provider usage is known before its announced tools execute.
  database.projectExecute(
    projectName,
    'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
    ['stream_chat', 17, 9, 'provider-model'],
  );
  const executed = [];

  await assert.rejects(
    withFaults({
      [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
    }, async () => executeToolCallsWithAbort(
      [
        {
          id: 'body',
          name: 'update_chapter',
          args: { chapter_id: chapter.id, content: 'Failed body' },
        },
        {
          id: 'later',
          name: 'create_memory',
          args: { category: 'event', content: 'Must not run' },
        },
      ],
      { isDisconnected: () => false },
      (toolCall) => {
        executed.push(toolCall.id);
        return executeTool(projectName, toolCall.name, toolCall.args);
      },
    )),
    (error) => typeof isManuscriptPersistenceError === 'function'
      && isManuscriptPersistenceError(error)
      && error.code === 'EIO',
  );

  assert.deepEqual(executed, ['body']);
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(chapter.id).content, 'Before body');
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
  assert.deepEqual(
    projectDb.prepare('SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM token_usage').get(),
    { input: 17, output: 9 },
  );
});

test('OpenAI complete forwards AbortSignal to fetch', async () => {
  const originalFetch = global.fetch;
  let capturedSignal;
  global.fetch = async (_url, options) => {
    capturedSignal = options.signal;
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  };

  try {
    const provider = new OpenAIProvider({
      apiModel: 'configured',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, configWithParameters(), { debugLogger: { write: () => {} } });
    const controller = new AbortController();
    const pending = provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0, controller.signal);
    controller.abort();
    await assert.rejects(pending, error => error?.name === 'AbortError');
    assert.equal(capturedSignal, controller.signal);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Claude complete forwards AbortSignal to the SDK request options', async () => {
  let capturedOptions;
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters(), { debugLogger: { write: () => {} } });
  provider.client = {
    messages: {
      create: async (_params, options) => {
        capturedOptions = options;
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) {
            reject(options.signal.reason);
            return;
          }
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      },
    },
  };

  const controller = new AbortController();
  const pending = provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.equal(capturedOptions.signal, controller.signal);
});

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

test('OpenAI complete keeps Kimi K3 compatible with a persisted legacy parameter config', async () => {
  const originalFetch = global.fetch;
  const capturedBodies = [];
  global.fetch = async (_url, options) => {
    capturedBodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: {},
      }),
    };
  };

  try {
    const legacyConfig = legacyConfigWithoutKimiRule();
    const kimiProvider = new OpenAIProvider({
      apiModel: 'vendor/KIMI-K3-preview',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, legacyConfig);
    const ordinaryProvider = new OpenAIProvider({
      apiModel: 'ordinary-compatible-model',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, legacyConfig);

    await kimiProvider.complete('system', [{ role: 'user', content: 'hello' }], [], 0.2);
    await ordinaryProvider.complete('system', [{ role: 'user', content: 'hello' }], [], 0.2);

    assert.equal('temperature' in capturedBodies[0], false);
    assert.equal(capturedBodies[0].max_tokens, 4096);
    assert.equal(capturedBodies[1].temperature, 0.2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAI Kimi stream compatibility is applied after task overrides', async () => {
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
    const provider = new OpenAIProvider({
      apiModel: 'vendor/kimi-k3-preview',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, legacyConfigWithoutKimiRule());

    for await (const _event of provider.stream(
      'system',
      [{ role: 'user', content: 'hello' }],
      0.2,
      { params: { temperature: 0.9 } },
    )) {
      // Drain the stream so the final body can be asserted.
    }

    assert.equal('temperature' in captured, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Claude complete does not apply the OpenAI-compatible Kimi guard', async () => {
  let captured;
  const provider = new ClaudeProvider({
    apiModel: 'vendor/kimi-k3-preview',
    apiKey: 'test',
  }, legacyConfigWithoutKimiRule());
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

  await provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0.2);
  assert.equal(captured.temperature, 0.2);
});

test('OpenAI DONE is exposed only as a transport terminator', async () => {
  const originalFetch = global.fetch;
  let captured;
  let capturedSignal;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    capturedSignal = options.signal;
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
    const streamController = new AbortController();
    const events = [];
    for await (const event of provider.stream(
      'system',
      [{ role: 'user', content: 'hello' }],
      0,
      undefined,
      streamController.signal,
    )) {
      events.push(event);
    }
    assert.equal(captured.stream, true);
    assert.equal(captured.max_tokens, 1234);
    assert.equal(captured.reasoning_effort, 'high');
    assert.equal('temperature' in captured, false);
    assert.equal(capturedSignal, streamController.signal);
    assert.deepEqual(events, [
      { type: 'chunk', text: '片段' },
      { type: 'transport_end' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAI DONE does not mask an earlier abnormal finish reason', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"content_filter"}]}\n\n'
      + 'data: [DONE]\n\n',
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
    for await (const event of provider.stream('system', [{ role: 'user', content: 'hello' }], 0)) {
      events.push(event);
    }
    assert.deepEqual(events, [
      { type: 'chunk', text: 'partial' },
      { type: 'finish', reason: 'content_filter' },
      { type: 'transport_end' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAI stream surfaces malformed data frames instead of accepting partial text', async () => {
  const originalFetch = global.fetch;
  const diagnostics = [];
  global.fetch = async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"kept"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"lost"}}\n\n'
      + 'data: [DONE]\n\n',
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
    }, configWithParameters(), {
      debugLogger: { write: (event, details) => diagnostics.push({ event, details }) },
    });
    await assert.rejects(async () => {
      for await (const _event of provider.stream('system', [{ role: 'user', content: 'hello' }], 0)) {
        // Drain the stream until the malformed provider frame is encountered.
      }
    }, SyntaxError);
    assert.equal(diagnostics.at(-1)?.event, 'openai_stream_event_parse_failed');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAI stream supports Kimi-style usage, trailing SSE data, and per-task overrides', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"reasoning_content":"thought"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"text"},"usage":{"prompt_tokens":12,"completion_tokens":34},"finish_reason":"stop"}]}',
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
      0.35,
      {
        params: {
          reasoning_effort: 'low',
          max_completion_tokens: 32768,
          stream_options: { include_usage: true },
        },
        omit: ['max_tokens'],
      },
    )) {
      events.push(event);
    }
    assert.equal('max_tokens' in captured, false);
    assert.equal(captured.reasoning_effort, 'low');
    assert.equal(captured.max_completion_tokens, 32768);
    assert.deepEqual(captured.stream_options, { include_usage: true });
    assert.deepEqual(events, [
      { type: 'reasoning', text: 'thought' },
      { type: 'chunk', text: 'text' },
      { type: 'usage', inputTokens: 12, outputTokens: 34 },
      { type: 'finish', reason: 'stop' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAI complete logs malformed tool arguments before surfacing the parse error', async () => {
  const originalFetch = global.fetch;
  const diagnostics = [];
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'length',
        message: {
          tool_calls: [{
            id: 'call_1',
            function: { name: 'update_chapter', arguments: '{"chapter_num":"unterminated' },
          }],
        },
      }],
      usage: {},
    }),
  });
  try {
    const provider = new OpenAIProvider({
      apiModel: 'configured',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, configWithParameters(), {
      debugLogger: { write: (event, details) => diagnostics.push({ event, details }) },
    });

    await assert.rejects(
      provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0),
      /Unterminated string|Expected ',' or '}'/,
    );
    assert.deepEqual(diagnostics.map(item => item.event), ['openai_tool_arguments_parse_failed']);
    assert.equal(diagnostics[0].details.finishReason, 'length');
    assert.equal(diagnostics[0].details.toolName, 'update_chapter');
    assert.equal(diagnostics[0].details.rawArguments, '{"chapter_num":"unterminated');
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
  let capturedOptions;
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters());
  provider.client = {
    messages: {
      stream: (params, options) => {
        captured = params;
        capturedOptions = options;
        return (async function* events() {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '片段' },
          };
        }());
      },
    },
  };

  const streamController = new AbortController();
  const events = [];
  for await (const event of provider.stream(
    'system',
    [{ role: 'user', content: 'hello' }],
    0,
    undefined,
    streamController.signal,
  )) {
    events.push(event);
  }
  assert.equal(captured.max_tokens, 1234);
  assert.equal(captured.reasoning_effort, 'high');
  assert.equal('temperature' in captured, false);
  assert.equal('stream' in captured, false);
  assert.equal(capturedOptions.signal, streamController.signal);
  assert.deepEqual(events, [
    { type: 'chunk', text: '片段' },
    { type: 'usage', inputTokens: 0, outputTokens: 0 },
  ]);
});

test('Claude stream exposes its stop reason so callers can reject truncated output', async () => {
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters());
  provider.client = {
    messages: {
      stream: () => (async function* events() {
        yield { type: 'message_start', message: { usage: { input_tokens: 12 } } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
        yield {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 34 },
        };
      }()),
    },
  };

  const events = [];
  for await (const event of provider.stream('system', [{ role: 'user', content: 'hello' }], 0)) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: 'chunk', text: 'partial' },
    { type: 'finish', reason: 'max_tokens' },
    { type: 'usage', inputTokens: 12, outputTokens: 34 },
  ]);
});

test('Claude stream surfaces usage observed before an upstream failure', async () => {
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters());
  provider.client = {
    messages: {
      stream: () => (async function* events() {
        yield { type: 'message_start', message: { usage: { input_tokens: 21 } } };
        yield {
          type: 'message_delta',
          delta: {},
          usage: { output_tokens: 13 },
        };
        throw new Error('connection lost');
      }()),
    },
  };

  const events = [];
  await assert.rejects(async () => {
    for await (const event of provider.stream('system', [{ role: 'user', content: 'hello' }], 0)) {
      events.push(event);
    }
  }, /connection lost/);
  assert.deepEqual(events, [
    { type: 'usage', inputTokens: 21, outputTokens: 13 },
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
