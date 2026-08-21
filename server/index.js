const express = require('express');
const cors = require('cors');
const { createHash } = require('node:crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { installManuscriptRuntime } = require('./manuscript/runtime');
const { createProductionManuscriptRuntime } = require('./manuscript/production-runtime');
const apiRoutes = require('./routes/api');
const { TOOLS, executeTool } = require('./tools');
const {
  createAIAdapter,
  createStreamAbortContext,
  detectProvider,
  executeToolCallsWithAbort,
} = require('./ai-adapter');
const { buildWritingPrompt } = require('./prompts/writing');
const { buildCollabPrompt } = require('./prompts/collab');
const { createPendingRevision } = require('./chapter-revisions');
const { getPolishStreamFailure } = require('./ai-polish-completion');
const {
  getContinuationStreamOverrides,
  getPolishStreamOverrides,
} = require('./ai-polish-request');
const { saveContinuation } = require('./ai-continue-save');
const { bindAiProjectInstance } = require('./project-instance-middleware');
const {
  jsonErrorMiddleware,
  jsonNotFoundMiddleware,
  publicErrorEnvelope,
  sendJsonError,
} = require('./json-error-middleware');
const { recordTokenUsageBestEffort } = require('./token-usage-recorder');
const { startServerRuntime } = require('./server-runtime');
const {
  assertDurabilitySupported,
  detectCapabilities,
} = require('./platform/durability');

const app = express();
let activeInstanceNonceMiddleware = null;
let activeLifecycleAdmissionMiddleware = null;

// ─── Middleware ───
app.use(cors());
app.use('/api', (req, res, next) => {
  if (!activeInstanceNonceMiddleware) return next();
  return activeInstanceNonceMiddleware(req, res, next);
});
app.use('/api', (req, res, next) => {
  if (!activeLifecycleAdmissionMiddleware) return next();
  return activeLifecycleAdmissionMiddleware(req, res, next);
});
app.use(express.json({ limit: '10mb' }));

// ─── Request logging ───
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/ai')) return; // don't log AI streaming
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ─── API Routes ───
app.use('/api/ai', bindAiProjectInstance);
app.use('/api', apiRoutes);

// ═══════════════════════════════════════════
// AI CONFIG — read from config.db
// ═══════════════════════════════════════════

// ─── AI Config cache (invalidated when settings are updated) ───
let aiConfigCache = null;

function invalidateAiConfigCache() {
  aiConfigCache = null;
}

function getAiConfig() {
  if (aiConfigCache) return aiConfigCache;

  const DEFAULTS = {
    apiBaseUrl: 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_KEY || '',
    apiModel: 'deepseek-v4-flash',
    apiType: '',
  };
  try {
    const db = require('./db');
    const rows = db.dbQuery('SELECT key, value FROM app_settings');
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    aiConfigCache = {
      apiBaseUrl: map.api_base_url || DEFAULTS.apiBaseUrl,
      apiKey: map.api_key || DEFAULTS.apiKey,
      apiModel: map.api_model || DEFAULTS.apiModel,
      apiType: map.api_type || DEFAULTS.apiType,
    };
    return aiConfigCache;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function safeSseError(error) {
  const publicError = publicErrorEnvelope(error?.code).error;
  return {
    code: publicError.code,
    error: publicError.message,
    recoverable: publicError.recoverable,
  };
}


// ─── AI Chat Completion (non-streaming) ───
app.post('/api/ai/chat', async (req, res, next) => {
  try {
    const { messages, project, temperature = 0.8 } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return sendJsonError(res, 'INVALID_PARAMS', 'messages is required');
    }

    const aiConfig = getAiConfig();
    // 测试连接时允许前端传入 API key/baseUrl/model 覆盖数据库配置
    if (req.body.apiKey !== undefined) {
      aiConfig.apiKey = req.body.apiKey;
    }
    if (req.body.apiBaseUrl !== undefined) {
      aiConfig.apiBaseUrl = req.body.apiBaseUrl;
    }
    if (req.body.apiModel !== undefined) {
      aiConfig.apiModel = req.body.apiModel;
    }
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
    const systemPrompt = buildWritingPrompt(project);

    const result = await adapter.complete(systemPrompt, messages, null, temperature);

    // Record token usage
    if (result.usage.inputTokens || result.usage.outputTokens) {
      recordTokenUsageBestEffort(() => {
        const db = require('./db');
        db.projectExecute(project,
          'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
          ['chat', result.usage.inputTokens, result.usage.outputTokens, aiConfig.apiModel]
        );
      });
    }

    res.json({
      choices: [{ message: { content: result.content, role: 'assistant' } }],
      usage: { prompt_tokens: result.usage.inputTokens, completion_tokens: result.usage.outputTokens },
    });
  } catch (err) {
    console.error('AI chat error:', err);
    return next(err);
  }
});


// ─── AI Streaming Chat with Tool Calling (SSE) ───
app.post('/api/ai/chat/stream', async (req, res, next) => {
  let streamContext = null;
  try {
    const { messages, project, temperature = 0.8, mode = 'writing' } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return sendJsonError(res, 'INVALID_PARAMS', 'messages is required');
    }

    const aiConfig = getAiConfig();
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
    const systemPrompt = mode === 'collab' ? buildCollabPrompt(project) : buildWritingPrompt(project);
    streamContext = createStreamAbortContext(req, res);
    if (streamContext.isDisconnected()) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(':ok\n\n');

    const conversation = [...messages]; // system is passed separately to adapter
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let disconnected = false;
    const MAX_TOOL_ROUNDS = 120;

    toolLoop: for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (streamContext.isDisconnected()) {
        disconnected = true;
        break;
      }
      console.log(`[AI Stream] Round ${round}, messages: ${conversation.length}`);

      let result;
      try {
        result = await adapter.complete(
          systemPrompt,
          conversation,
          TOOLS,
          temperature,
          streamContext.signal,
        );
      } catch (err) {
        if (streamContext.isDisconnected()) {
          disconnected = true;
          break;
        }
        if (streamContext.canWrite()) {
          res.write(`event: error\ndata: ${JSON.stringify(safeSseError(err))}\n\n`);
          res.end();
        }
        return;
      }

      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      if (result.usage.inputTokens || result.usage.outputTokens) {
        recordTokenUsageBestEffort(() => {
          db.projectExecute(
            project,
            'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
            ['stream_chat', result.usage.inputTokens, result.usage.outputTokens, aiConfig.apiModel],
          );
        });
      }
      if (streamContext.isDisconnected()) {
        disconnected = true;
        break;
      }

      console.log(`[AI Stream] Round ${round} result:`, {
        hasContent: !!result.content,
        contentLen: result.content?.length || 0,
        hasToolCalls: result.toolCalls.length > 0,
        toolCallNames: result.toolCalls.map(tc => tc.name) || [],
      });

      if (result.toolCalls.length > 0) {
        // Add assistant message with tool calls to conversation
        conversation.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });

        // Execute each tool. Yield after announcing it so a client stop can be
        // observed before this (or any later tool from the same model turn) runs.
        const completedBatch = await executeToolCallsWithAbort(
          result.toolCalls,
          streamContext,
          tc => executeTool(project, tc.name, tc.args),
          {
            onToolCall: tc => {
              if (streamContext.canWrite()) {
                res.write(`event: tool_call\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, arguments: tc.args })}\n\n`);
              }
            },
            onToolExecuted: (tc, toolResult) => {
              console.log(`[AI Stream] Tool ${tc.name}:`, JSON.stringify(toolResult).slice(0, 200));
            },
            onToolResult: (tc, toolResult) => {
              if (streamContext.canWrite()) {
                res.write(`event: tool_result\ndata: ${JSON.stringify({ id: tc.id, name: tc.name, result: toolResult })}\n\n`);
              }
              conversation.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
            },
          },
        );
        if (!completedBatch) {
          disconnected = true;
          break toolLoop;
        }
        // Continue loop
      } else if (result.content) {
        // Got text without tool calls — send as content
        fullContent = result.content;
        if (streamContext.canWrite()) {
          res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: result.content, position: result.content.length })}\n\n`);
        }
        break;
      } else {
        console.log('[AI Stream] No content and no tool calls — ending');
        break;
      }
    }

    if (disconnected || streamContext.isDisconnected()) return;
    if (streamContext.canWrite()) {
      res.write(`event: task_end\ndata: ${JSON.stringify({ success: true, content: fullContent, inputTokens, outputTokens })}\n\n`);
      res.end();
    }

  } catch (err) {
    if (streamContext?.isDisconnected()) return;
    console.error('AI stream error:', err);
    if (!res.headersSent) {
      return next(err);
    } else if (!streamContext || streamContext.canWrite()) {
      res.write(`event: task_error\ndata: ${JSON.stringify(safeSseError(err))}\n\n`);
      res.end();
    }
  } finally {
    streamContext?.cleanup();
  }
});

function normalizePolishedContent(content) {
  const trimmed = String(content || '').trim();
  const fenced = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

// ─── AI Polish (streaming, produces a review proposal without overwriting the chapter) ───
app.post('/api/ai/polish', async (req, res, next) => {
  let streamContext = null;
  try {
    const { chapterId, project } = req.body || {};
    if (!project || !Number.isInteger(chapterId) || chapterId < 1) {
      return sendJsonError(res, 'INVALID_PARAMS', 'project and chapterId are required');
    }

    const db = require('./db');
    const chapter = db.projectGet(project, 'SELECT id, num, title, content FROM chapters WHERE id = ?', [chapterId]);
    if (!chapter) return sendJsonError(res, 'DB_NOT_FOUND', 'Chapter not found');
    if (!chapter.content?.trim()) return sendJsonError(res, 'INVALID_PARAMS', 'Chapter content is empty');

    const baseContent = chapter.content;
    const aiConfig = getAiConfig();
    const provider = detectProvider(aiConfig.apiModel, aiConfig.apiType);
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
    const systemPrompt = '你是一名小说编辑。当前只执行一次“全文润色”任务。你必须只输出润色后的完整章节正文，不要解释、不要标题前缀、不要 Markdown 代码块、不要调用工具，也不要续写。保留原有故事事实、人物、情节和 Markdown 结构，只改善语言、节奏和表达。';
    const messages = [{
      role: 'user',
      content: `请润色第 ${chapter.num} 章《${chapter.title}》。以下是完整原文；请以完整润色稿替换它：\n\n${baseContent}`,
    }];

    streamContext = createStreamAbortContext(req, res);
    if (streamContext.isDisconnected()) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(':ok\n\n');

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = null;
    let reasoningCharacters = 0;
    const recordPolishUsage = () => {
      if (!inputTokens && !outputTokens) return;
      recordTokenUsageBestEffort(() => {
        db.projectExecute(project,
          'INSERT INTO token_usage (task_name, chapter_num, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?, ?)',
          ['polish', chapter.num, inputTokens, outputTokens, aiConfig.apiModel],
        );
      });
    };
    try {
      for await (const event of adapter.stream(
        systemPrompt,
        messages,
        0.35,
        getPolishStreamOverrides(aiConfig.apiModel, provider),
        streamContext.signal,
      )) {
        if (event.type === 'chunk') {
          fullContent += event.text;
          if (streamContext.canWrite()) {
            res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: event.text, position: fullContent.length })}\n\n`);
          }
        }
        if (event.type === 'reasoning') {
          reasoningCharacters += event.text.length;
        }
        if (event.type === 'usage') {
          inputTokens = event.inputTokens || 0;
          outputTokens = event.outputTokens || 0;
        }
        if (event.type === 'finish') finishReason = event.reason || null;
      }
    } catch (err) {
      console.error('Polish stream error:', err);
      recordPolishUsage();
      if (streamContext.canWrite()) {
        res.write(`event: error\ndata: ${JSON.stringify(safeSseError(err))}\n\n`);
        res.end();
      }
      return;
    }

    // Generation has already consumed these tokens regardless of whether the
    // resulting full-chapter replacement is safe to keep.
    recordPolishUsage();
    if (streamContext.isDisconnected()) return;

    const proposedContent = normalizePolishedContent(fullContent);
    const completionFailure = getPolishStreamFailure(finishReason, proposedContent);
    if (completionFailure) {
      console.warn('[AI Polish] Rejecting incomplete stream result', {
        model: aiConfig.apiModel,
        finishReason,
        reasoningCharacters,
        inputTokens,
        outputTokens,
      });
      if (streamContext.canWrite()) {
        res.write(`event: error\ndata: ${JSON.stringify(completionFailure)}\n\n`);
        res.end();
      }
      return;
    }

    // The disconnect event cannot interleave with this synchronous check/write
    // section. Once it passes, creating the revision is atomic with respect to
    // the Node event loop.
    if (streamContext.isDisconnected()) return;
    const result = createPendingRevision(project, chapterId, baseContent, proposedContent);
    if (!streamContext.canWrite()) return;
    if (result.missing) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Chapter no longer exists' })}\n\n`);
    } else if (result.unchanged) {
      res.write(`event: done\ndata: ${JSON.stringify({ success: true, unchanged: true, rebased: result.rebased })}\n\n`);
    } else {
      res.write(`event: done\ndata: ${JSON.stringify({ success: true, revision: result.revision, rebased: result.rebased })}\n\n`);
    }
    res.end();
  } catch (err) {
    console.error('Polish error:', err);
    if (streamContext?.isDisconnected()) return;
    if (!res.headersSent) {
      return next(err);
    } else if (!streamContext || streamContext.canWrite()) {
      res.write(`event: error\ndata: ${JSON.stringify(safeSseError(err))}\n\n`);
      res.end();
    }
  } finally {
    streamContext?.cleanup();
  }
});

// ─── AI Continue Writing (streaming) ───
app.post('/api/ai/continue', async (req, res, next) => {
  let streamContext = null;
  try {
    const { chapterId, context, style = '悬疑', project } = req.body || {};
    if (!project || !Number.isInteger(chapterId) || chapterId < 1) {
      return sendJsonError(res, 'INVALID_PARAMS', 'project and chapterId are required');
    }

    const db = require('./db');
    const chapter = db.projectGet(project, 'SELECT * FROM chapters WHERE id = ?', [chapterId]);
    if (!chapter) return sendJsonError(res, 'DB_NOT_FOUND', 'Chapter not found');
    const continuationBaseBodyHash = createHash('sha256')
      .update(chapter.content ?? '')
      .digest('hex');

    const messages = [
      { role: 'user', content: `请续写以下小说的第${chapter.num}章「${chapter?.title || '未知'}」。保持${style}氛围，延续已有的文风和叙事视角。\n\n## 当前内容\n\n${chapter?.content?.slice(-1500) || '（新章节开头）'}\n\n## 用户额外要求\n${context || '请自然续写，保持文学质感。'}\n\n请直接开始续写，不要加任何前缀说明。` }
    ];

    const aiConfig = getAiConfig();
    const provider = detectProvider(aiConfig.apiModel, aiConfig.apiType);
    const adapter = createAIAdapter(aiConfig.apiModel, aiConfig, aiConfig.apiType);
    const systemPrompt = buildWritingPrompt(project);

    streamContext = createStreamAbortContext(req, res);
    if (streamContext.isDisconnected()) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    // Flush headers immediately so browser sees SSE connection is live
    res.write(':ok\n\n');

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = null;
    const recordContinuationUsage = () => {
      if (!inputTokens && !outputTokens) return;
      recordTokenUsageBestEffort(() => {
        db.projectExecute(project,
          'INSERT INTO token_usage (task_name, chapter_num, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?, ?)',
          ['continue', chapter.num, inputTokens, outputTokens, aiConfig.apiModel],
        );
      });
    };

    try {
      for await (const event of adapter.stream(
        systemPrompt,
        messages,
        0.85,
        getContinuationStreamOverrides(aiConfig.apiModel, provider),
        streamContext.signal,
      )) {
        if (event.type === 'chunk') {
          fullContent += event.text;
          if (streamContext.canWrite()) {
            res.write(`event: content_chunk\ndata: ${JSON.stringify({ text: event.text, position: fullContent.length })}\n\n`);
          }
        }
        if (event.type === 'usage') {
          inputTokens = event.inputTokens || 0;
          outputTokens = event.outputTokens || 0;
        }
        if (event.type === 'finish') finishReason = event.reason || null;
      }
    } catch (err) {
      console.error('Continue stream error:', err);
      recordContinuationUsage();
      if (streamContext.canWrite()) {
        res.write(`event: error\ndata: ${JSON.stringify(safeSseError(err))}\n\n`);
        res.end();
      }
      return;
    }

    if (streamContext.isDisconnected()) {
      recordContinuationUsage();
      return;
    }

    let saveError = null;
    let savedChapter = null;
    try {
      savedChapter = saveContinuation(
        db,
        project,
        chapterId,
        fullContent,
        finishReason,
        continuationBaseBodyHash,
      );
    } catch (error) {
      saveError = error;
      console.error('Continue save error:', error);
    }

    if (saveError) {
      if (!db.isManuscriptPersistenceError(saveError)) recordContinuationUsage();
      if (streamContext.canWrite()) {
        res.write(`event: error\ndata: ${JSON.stringify(safeSseError(saveError))}\n\n`);
        res.end();
      }
      return;
    }

    recordContinuationUsage();
    if (!streamContext.canWrite()) return;
    res.write(`event: done\ndata: ${JSON.stringify({
      success: true,
      content: fullContent,
      chapterId: savedChapter.chapterId,
      chapterContent: savedChapter.content,
      wordCount: savedChapter.wordCount,
      dataVersion: savedChapter.dataVersion,
    })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Continue error:', err);
    if (streamContext?.isDisconnected()) return;
    if (!res.headersSent) {
      return next(err);
    } else if (!streamContext || streamContext.canWrite()) {
      res.write(`event: error\ndata: ${JSON.stringify(safeSseError(err))}\n\n`);
      res.end();
    }
  } finally {
    streamContext?.cleanup();
  }
});

// ─── Health check ───
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    db: 'connected',
    version: '0.1.0',
    mode: 'development',
  });
});

app.use(jsonNotFoundMiddleware);
app.use(jsonErrorMiddleware);

// Share cache invalidation with routes (settings updates clear the cache)
db.invalidateAiConfigCache = invalidateAiConfigCache;

function createApp({
  instanceNonceMiddleware = null,
  lifecycleAdmissionMiddleware = null,
  manuscriptRuntime = null,
} = {}) {
  if (manuscriptRuntime !== null) installManuscriptRuntime(manuscriptRuntime);
  activeInstanceNonceMiddleware = instanceNonceMiddleware;
  activeLifecycleAdmissionMiddleware = lifecycleAdmissionMiddleware;
  return app;
}

async function startMainServer() {
  const startedAt = Date.now();
  const desktopOwned = process.env.MYTHPEN_DESKTOP_OWNED === '1';
  if (desktopOwned) {
    console.log = (...args) => console.error(...args);
  } else {
    console.log('[Server] Mythpen API Server starting...');
  }
  let manuscriptRuntime = null;
  const closeProductionDatabases = async () => {
    try {
      manuscriptRuntime?.close();
    } finally {
      await db.closeAllDatabases();
    }
  };
  const runtime = await startServerRuntime({
    assertDurabilitySupported,
    closeDatabases: closeProductionDatabases,
    configureRecoveryDiagnosticsCapabilities: db.configureRecoveryDiagnosticsCapabilities,
    coordinator: db.getProjectWriteLifecycle(),
    createApp(options) {
      manuscriptRuntime = createProductionManuscriptRuntime();
      return createApp({ ...options, manuscriptRuntime });
    },
    detectCapabilities,
    initDatabase: db.initDatabase,
    inspectProjectDatabasesAtStartup: db.inspectProjectDatabasesAtStartup,
  });
  if (!desktopOwned) {
    const address = runtime.server.address();
    const port = address && typeof address !== 'string' ? address.port : 'unknown';
    const cfg = getAiConfig();
    console.log(`\n  🖋️  Mythpen API Server`);
    console.log(`  Local:   http://127.0.0.1:${port}`);
    console.log(`  Health:  http://127.0.0.1:${port}/api/health`);
    console.log(`  AI:      ${cfg.apiModel} @ ${cfg.apiBaseUrl}`);
    console.log(`  Startup: ${Date.now() - startedAt}ms`);
    console.log('\n  Ready.\n');
  }
  return runtime;
}

if (require.main === module) {
  void startMainServer().catch((error) => {
    console.error(`❌ Server startup failed [${error.code || 'UNKNOWN'}]:`, error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  startMainServer,
};
