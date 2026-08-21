// ─── AI Provider Adapter ───
// Unified interface for OpenAI-compatible (DeepSeek, etc.) and Anthropic Claude models.
// Auto-detects provider from model name.

const Anthropic = require('@anthropic-ai/sdk');
const { logAiDebug } = require('./debug-logger');
const {
  createRequestParameterConfigLoader,
  resolveRequestBody,
} = require('./ai-request-parameters');
const { isManuscriptPersistenceError } = require('./manuscript-service');

function createDefaultRequestParameterLoader() {
  const { getStoragePaths } = require('./db');
  return createRequestParameterConfigLoader({
    configPath: getStoragePaths().aiRequestParametersPath,
  });
}

// ─── Provider detection ───
// apiType takes priority; fallback to model name heuristic

function detectProvider(model, apiType) {
  if (apiType === 'claude') return 'claude';
  if (apiType === 'openai') return 'openai';
  if (!model) return 'openai';
  const m = model.toLowerCase();
  if (m.startsWith('claude') || m.startsWith('anthropic/')) return 'claude';
  return 'openai';
}

// ─── Tool format conversion ───
// OpenAI: { type: 'function', function: { name, description, parameters } }
// Claude: { name, description, input_schema }

function toClaudeTools(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return undefined;
  return openaiTools.map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// ─── Message format conversion ───

function toClaudeMessages(openaiMessages) {
  const msgs = [];
  for (const msg of openaiMessages) {
    if (msg.role === 'system') continue; // system is handled separately

    if (msg.role === 'tool') {
      // OpenAI: { role: 'tool', tool_call_id, content }
      // Claude: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
      msgs.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
      });
    } else if (msg.role === 'assistant' && msg.tool_calls) {
      // OpenAI: { role: 'assistant', content, tool_calls: [{ id, function: { name, arguments } }] }
      // Claude: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
      const content = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        let input;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      msgs.push({ role: 'assistant', content });
    } else {
      // Regular user/assistant message
      // Claude requires content to be an array when there are tool blocks in conversation
      // but for plain text messages we can use a string
      msgs.push({
        role: msg.role,
        content: msg.content || '',
      });
    }
  }
  return msgs;
}

// ─── Unified response format ───

function makeResponse(content, toolCalls, inputTokens, outputTokens) {
  return { content, toolCalls, usage: { inputTokens, outputTokens } };
}

function applyOpenAIModelCompatibility(body, model) {
  const normalizedModel = String(model || '').trim().toLowerCase().replace(/\/+$/, '');
  const modelId = normalizedModel.split('/').pop() || '';
  if (modelId.startsWith('kimi-k3')) {
    // Generated request-parameter files are deliberately not overwritten on
    // upgrade. Keep every OpenAI-compatible Kimi K3 request valid even when a
    // persisted legacy file does not yet contain the current model alias.
    delete body.temperature;
  }
  return body;
}

/**
 * Bind one AI stream to the lifetime of its HTTP request/response pair.
 * `req.close` is intentionally not used: recent Node versions also emit it
 * after an ordinary, fully-read request. A premature response close is the
 * reliable signal that the client can no longer receive this stream.
 */
function createStreamAbortContext(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onRequestAborted = () => abort();
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };

  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClose);
  if (req.aborted || (res.destroyed && !res.writableEnded)) abort();

  return {
    signal: controller.signal,
    isDisconnected: () => (
      controller.signal.aborted
      || req.aborted
      || (res.destroyed && !res.writableEnded)
      || (res.closed && !res.writableEnded)
    ),
    canWrite: () => (
      !controller.signal.aborted
      && !req.aborted
      && !res.destroyed
      && !res.closed
      && !res.writableEnded
    ),
    cleanup: () => {
      req.removeListener('aborted', onRequestAborted);
      res.removeListener('close', onResponseClose);
    },
  };
}

/**
 * Execute one model turn's tool calls without starting any call after the
 * client disconnects. The event-loop yield is intentional: it gives the
 * client time to receive `tool_call` and abort before the announced tool runs.
 */
async function executeToolCallsWithAbort(toolCalls, streamContext, execute, callbacks = {}) {
  for (const toolCall of toolCalls) {
    if (streamContext.isDisconnected()) return false;

    callbacks.onToolCall?.(toolCall);
    await new Promise(resolve => setImmediate(resolve));
    if (streamContext.isDisconnected()) return false;

    let result;
    try {
      result = await execute(toolCall);
    } catch (error) {
      if (isManuscriptPersistenceError(error)) throw error;
      result = { error: error.message };
    }

    callbacks.onToolExecuted?.(toolCall, result);
    if (streamContext.isDisconnected()) return false;
    callbacks.onToolResult?.(toolCall, result);
  }
  return true;
}

// ═══════════════════════════════════════════
// OPENAI PROVIDER (DeepSeek / any OpenAI-compatible API)
// ═══════════════════════════════════════════

class OpenAIProvider {
  constructor(apiConfig, requestParameterConfig, options = {}) {
    this.apiConfig = apiConfig;
    this.requestParameterConfig = requestParameterConfig;
    this.debugLogger = options.debugLogger || { write: logAiDebug };
  }

  logDebug(event, details) {
    this.debugLogger.write(event, details);
  }

  requestBody(baseBody, operation, temperature, requestOverrides) {
    return applyOpenAIModelCompatibility(resolveRequestBody(this.requestParameterConfig, {
      baseBody,
      model: this.apiConfig.apiModel,
      apiType: 'openai',
      operation,
      runtimeParams: temperature === undefined ? {} : { temperature },
      requestOverrides,
    }), this.apiConfig.apiModel);
  }

  /**
   * Non-streaming chat completion (supports tools).
   * Used by the tool-call loop in /api/ai/chat/stream.
   */
  async complete(systemPrompt, messages, tools, temperature, signal) {
    const { apiConfig } = this;
    const body = this.requestBody({
      model: apiConfig.apiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools: tools || undefined,
      stream: false,
    }, 'complete', temperature);

    let response;
    try {
      response = await fetch(apiConfig.chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      this.logDebug('openai_request_failed', {
        operation: 'complete', model: apiConfig.apiModel, url: apiConfig.chatUrl, error,
      });
      throw error;
    }

    if (!response.ok) {
      const errText = await response.text();
      this.logDebug('openai_http_error', {
        operation: 'complete', model: apiConfig.apiModel, url: apiConfig.chatUrl,
        status: response.status, responseBody: errText,
      });
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }

    const debugResponse = typeof response.clone === 'function' ? response.clone() : null;
    let data;
    try {
      data = await response.json();
    } catch (error) {
      let responseBody;
      try { responseBody = debugResponse ? await debugResponse.text() : undefined; } catch { /* best effort */ }
      this.logDebug('openai_response_json_parse_failed', {
        operation: 'complete', model: apiConfig.apiModel, url: apiConfig.chatUrl,
        status: response.status, responseBody, error,
      });
      throw error;
    }
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;

    const toolCalls = (msg?.tool_calls || []).map(tc => {
      const rawArguments = tc.function.arguments || '{}';
      let args;
      try {
        args = JSON.parse(rawArguments);
      } catch (error) {
        this.logDebug('openai_tool_arguments_parse_failed', {
          model: apiConfig.apiModel,
          url: apiConfig.chatUrl,
          finishReason: choice?.finish_reason,
          toolCallId: tc.id,
          toolName: tc.function.name,
          rawArguments,
          argumentType: typeof rawArguments,
          error,
        });
        throw error;
      }
      return { id: tc.id, name: tc.function.name, args };
    });

    return makeResponse(msg?.content || null, toolCalls, inputTokens, outputTokens);
  }

  /**
   * Streaming chat completion (no tools).
   * Used by /api/ai/continue.
   */
  async *stream(systemPrompt, messages, temperature, requestOverrides, signal) {
    const { apiConfig } = this;
    const body = this.requestBody({
      model: apiConfig.apiModel,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true,
    }, 'stream', temperature, requestOverrides);

    let response;
    try {
      response = await fetch(apiConfig.chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      this.logDebug('openai_request_failed', {
        operation: 'stream', model: apiConfig.apiModel, url: apiConfig.chatUrl, error,
      });
      throw error;
    }

    if (!response.ok) {
      const errText = await response.text();
      this.logDebug('openai_http_error', {
        operation: 'stream', model: apiConfig.apiModel, url: apiConfig.chatUrl,
        status: response.status, responseBody: errText,
      });
      throw Object.assign(new Error(`API Error: ${response.status}`), {
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }

    if (!response.body) throw new Error('AI stream response body is empty');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let receivedFinishReason = false;

    const parsePayload = (payload) => {
      if (!payload) return [];
      // `[DONE]` confirms only that the SSE transport ended. It cannot replace
      // the model-level finish_reason used to decide whether generated text is
      // complete and safe to persist.
      if (payload === '[DONE]') {
        return [{ type: 'transport_end' }];
      }

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (error) {
        this.logDebug('openai_stream_event_parse_failed', {
          model: apiConfig.apiModel,
          url: apiConfig.chatUrl,
          payload,
          error,
        });
        throw error;
      }

      if (parsed.error) {
        const message = typeof parsed.error === 'string'
          ? parsed.error
          : parsed.error.message || parsed.error.code || 'AI stream returned an error';
        this.logDebug('openai_stream_api_error', {
          model: apiConfig.apiModel,
          url: apiConfig.chatUrl,
          error: parsed.error,
        });
        throw new Error(message);
      }

      const choice = parsed.choices?.[0];
      const delta = choice?.delta;
      const events = [];
      if (delta?.reasoning_content) events.push({ type: 'reasoning', text: delta.reasoning_content });
      if (delta?.content) events.push({ type: 'chunk', text: delta.content });

      // Kimi places usage in choices[0].usage on the final stream frame.
      const usage = parsed.usage || choice?.usage;
      if (usage) {
        events.push({
          type: 'usage',
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0,
        });
      }
      if (choice?.finish_reason && !receivedFinishReason) {
        receivedFinishReason = true;
        events.push({ type: 'finish', reason: choice.finish_reason });
      }
      return events;
    };

    const parseLine = (rawLine) => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data:')) return [];
      return parsePayload(line.slice(5).trimStart());
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        for (const event of parseLine(line)) yield event;
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split('\n')) {
      for (const event of parseLine(line)) yield event;
    }
  }
}

// ═══════════════════════════════════════════
// CLAUDE PROVIDER (Anthropic)
// ═══════════════════════════════════════════

class ClaudeProvider {
  constructor(apiConfig, requestParameterConfig, options = {}) {
    this.apiConfig = apiConfig;
    this.requestParameterConfig = requestParameterConfig;
    this.client = new Anthropic({ apiKey: apiConfig.apiKey });
    this.debugLogger = options.debugLogger || { write: logAiDebug };
  }

  logDebug(event, details) {
    this.debugLogger.write(event, details);
  }

  requestBody(baseBody, operation, temperature, requestOverrides) {
    return resolveRequestBody(this.requestParameterConfig, {
      baseBody,
      model: this.apiConfig.apiModel,
      apiType: 'claude',
      operation,
      runtimeParams: temperature === undefined ? {} : { temperature },
      requestOverrides,
    });
  }

  /**
   * Non-streaming chat completion (supports tools).
   */
  async complete(systemPrompt, messages, tools, temperature, signal) {
    const { apiConfig, client } = this;

    const baseBody = {
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
    };

    if (tools && tools.length > 0) {
      baseBody.tools = toClaudeTools(tools);
    }
    const params = this.requestBody(baseBody, 'complete', temperature);

    let response;
    try {
      response = await client.messages.create(params, { signal });
    } catch (error) {
      this.logDebug('claude_request_failed', {
        operation: 'complete', model: apiConfig.apiModel, error,
      });
      throw error;
    }
    const toolCalls = [];
    let content = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input });
      }
    }

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    return makeResponse(content || null, toolCalls, inputTokens, outputTokens);
  }

  /**
   * Streaming chat completion (no tools).
   */
  async *stream(systemPrompt, messages, temperature, requestOverrides, signal) {
    const { apiConfig, client } = this;

    const params = this.requestBody({
      model: apiConfig.apiModel,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
    }, 'stream', temperature, requestOverrides);
    let stream;
    try {
      stream = client.messages.stream(params, { signal });
    } catch (error) {
      this.logDebug('claude_request_failed', {
        operation: 'stream', model: apiConfig.apiModel, error,
      });
      throw error;
    }

    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { type: 'chunk', text: event.delta.text };
        }
        if (event.type === 'message_delta') {
          if (event.usage) {
            outputTokens = event.usage.output_tokens || 0;
          }
          if (event.delta?.stop_reason) {
            yield { type: 'finish', reason: event.delta.stop_reason };
          }
        }
        if (event.type === 'message_start') {
          if (event.message?.usage) {
            inputTokens = event.message.usage.input_tokens || 0;
          }
        }
      }
    } catch (error) {
      // Surface usage observed before a disconnect/provider failure so the
      // route can account for consumed tokens before handling the error.
      if (inputTokens || outputTokens) {
        yield { type: 'usage', inputTokens, outputTokens };
      }
      throw error;
    }

    yield { type: 'usage', inputTokens, outputTokens };
  }
}

// ═══════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════

function createAIAdapter(model, apiConfig, apiType, options = {}) {
  const provider = detectProvider(model, apiType);
  const requestParameterLoader = options.requestParameterLoader || createDefaultRequestParameterLoader();
  const requestParameterConfig = requestParameterLoader.getSnapshot();
  console.log(`[AI Adapter] Using ${provider} provider for model "${model}" (apiType: ${apiType || 'auto'})`);

  // Ensure chatUrl is set for OpenAI-compatible
  if (provider === 'openai') {
    const baseUrl = apiConfig.apiBaseUrl || 'https://api.deepseek.com/v1';
    apiConfig.chatUrl = baseUrl.replace(/\/?$/, '') + '/chat/completions';
  }

  switch (provider) {
    case 'claude':
      return new ClaudeProvider(apiConfig, requestParameterConfig, { debugLogger: options.debugLogger });
    case 'openai':
    default:
      return new OpenAIProvider(apiConfig, requestParameterConfig, { debugLogger: options.debugLogger });
  }
}

module.exports = {
  createAIAdapter,
  createStreamAbortContext,
  executeToolCallsWithAbort,
  OpenAIProvider,
  ClaudeProvider,
  detectProvider,
};
