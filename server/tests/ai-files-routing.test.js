const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_UID = '33333333-3333-4333-8333-333333333333';
const BASE_WITNESS = Object.freeze({
  expectedDataVersion: 5,
  generation: 9,
  rawSha256: 'a'.repeat(64),
  sidecarRawSha256: 'b'.repeat(64),
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function request(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('files AI continue/polish use stable-UID runtime admission and never open article SQL', async (t) => {
  const database = require('../db');
  const original = Object.fromEntries([
    'captureProjectInstance',
    'dbQuery',
    'getProjectDb',
    'inspectProjectManuscriptRoute',
    'projectExecute',
    'projectGet',
    'runWithProjectInstance',
  ].map((key) => [key, database[key]]));
  let legacyTouches = 0;
  database.inspectProjectManuscriptRoute = () => Object.freeze({
    route: 'files',
    databaseFacts: Object.freeze({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
    }),
  });
  database.runWithProjectInstance = (_project, _instance, operation) => operation();
  database.captureProjectInstance = () => {
    legacyTouches += 1;
    throw Object.assign(new Error('files route must not capture through getProjectDb'), {
      code: 'RECOVERY_REQUIRED',
    });
  };
  database.getProjectDb = () => {
    legacyTouches += 1;
    throw new Error('files route must not open project DB');
  };
  database.projectGet = () => {
    legacyTouches += 1;
    throw new Error('files route must not query project DB');
  };
  database.projectExecute = () => {
    legacyTouches += 1;
    throw new Error('files route must not write project DB');
  };
  let providerPort;
  database.dbQuery = () => [
    { key: 'api_base_url', value: `http://127.0.0.1:${providerPort}/v1` },
    { key: 'api_key', value: 'test-key' },
    { key: 'api_model', value: 'test-model' },
    { key: 'api_type', value: 'openai' },
  ];
  t.after(() => {
    for (const [key, value] of Object.entries(original)) database[key] = value;
  });

  const authorityEvents = [];
  let providerCalls = 0;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      providerCalls += 1;
      authorityEvents.push(JSON.stringify(body).includes('## 当前内容')
        ? 'provider:continue'
        : 'provider:other');
      res.setHeader('Connection', 'close');
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        if (JSON.stringify(body.messages).includes('Attempt unsafe auxiliary')) {
          res.end(JSON.stringify({
            choices: [{
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [{
                  id: 'unsafe-auxiliary',
                  type: 'function',
                  function: {
                    name: 'create_memory',
                    arguments: JSON.stringify({ category: 'event', content: 'must not persist' }),
                  },
                }],
              },
            }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }));
          return;
        }
        res.end(JSON.stringify({
          choices: [{ message: { content: 'Chat result' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 13, completion_tokens: 3 },
        }));
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Continuation' } }] })}\n\n`
        + `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        })}\n\n`
        + 'data: [DONE]\n\n',
      );
    });
  });
  providerPort = await listen(provider);
  t.after(() => close(provider));

  const reads = [];
  const writes = [];
  const runtime = Object.freeze({
    async close() {},
    async createProject() {},
    async ignoreInPlace() {},
    async migrateProject() {},
    async read(selector, readRequest) {
      reads.push({ selector, request: readRequest });
      authorityEvents.push(`read:${readRequest.kind}`);
      if (readRequest.kind === 'chapter') {
        return Object.freeze({
          baseWitness: BASE_WITNESS,
          value: Object.freeze({
            chapter_uid: CHAPTER_UID,
            content: 'Existing',
            data_version: 5,
            num: 4,
            title: 'Stable chapter',
          }),
        });
      }
      assert.equal(readRequest.kind, 'prompt_context');
      return Object.freeze({
        baseWitness: BASE_WITNESS,
        value: Object.freeze({
          metadata: Object.freeze({ name: 'Files Project', mode: 'short-story', language: 'zh', workflow_phase: 'writing', word_count: '8' }),
          genres: Object.freeze(['other']),
          characters: Object.freeze([]),
          chapters: Object.freeze([]),
          foreshadows: Object.freeze([]),
        }),
      });
    },
    async recover() {},
    async revokeIgnore() {},
    async write(selector, writeRequest) {
      writes.push({ selector, request: writeRequest });
      authorityEvents.push(`write:${writeRequest.command.kind}`);
      if (writeRequest.command.kind === 'revision.create') {
        if (writeRequest.requestId === 'ai-files-polish-stale') {
          return Object.freeze({
            state: 'stale',
            revision: Object.freeze({ id: 42, status: 'stale' }),
          });
        }
        return Object.freeze({
          state: 'created',
          revision: Object.freeze({
            id: 41,
            chapterId: 7,
            chapterUid: CHAPTER_UID,
            baseContent: writeRequest.command.baseContent,
            proposedContent: writeRequest.command.proposedContent,
            decisions: Object.freeze({}),
            status: 'pending',
            previousChapterStatus: 'writing',
            createdAt: '2026-08-20T00:00:00.000Z',
            updatedAt: '2026-08-20T00:00:00.000Z',
            resolvedAt: null,
          }),
        });
      }
      return Object.freeze({ state: 'committed', generation: 10 });
    },
  });
  const { createApp } = require('../index');
  const server = http.createServer(createApp({ manuscriptRuntime: runtime }));
  const appPort = await listen(server);
  t.after(() => close(server));

  const commonHeaders = {
    'X-Mythpen-Project-Instance': PROJECT_INSTANCE_ID,
    'X-Mythpen-Request-Id': 'ai-files-request-1',
  };
  const chat = await request(appPort, '/api/ai/chat', {
    project: 'files-project',
    messages: [{ role: 'user', content: 'Chat safely' }],
  }, commonHeaders);
  assert.equal(chat.status, 200, chat.text);
  assert.match(chat.text, /Chat result/u);

  const streamChat = await request(appPort, '/api/ai/chat/stream', {
    project: 'files-project',
    messages: [{ role: 'user', content: 'Stream safely' }],
  }, commonHeaders);
  assert.equal(streamChat.status, 200, streamChat.text);
  assert.match(streamChat.text, /event: task_end\b/u);

  const unsafeAuxiliary = await request(appPort, '/api/ai/chat/stream', {
    project: 'files-project',
    messages: [{ role: 'user', content: 'Attempt unsafe auxiliary' }],
  }, commonHeaders);
  assert.equal(unsafeAuxiliary.status, 200, unsafeAuxiliary.text);
  assert.match(unsafeAuxiliary.text, /event: task_error\b/u);
  assert.doesNotMatch(unsafeAuxiliary.text, /event: tool_result\b/u);

  const readsBeforeInvalidContinue = reads.length;
  const missingLogicalRequest = await request(appPort, '/api/ai/continue', {
    project: 'files-project',
    chapterUid: CHAPTER_UID,
  }, {
    'X-Mythpen-Project-Instance': PROJECT_INSTANCE_ID,
  });
  assert.equal(missingLogicalRequest.status, 400, missingLogicalRequest.text);
  assert.equal(reads.length, readsBeforeInvalidContinue);

  const numericFilesChapter = await request(appPort, '/api/ai/continue', {
    project: 'files-project',
    chapterId: 7,
  }, commonHeaders);
  assert.equal(numericFilesChapter.status, 400, numericFilesChapter.text);
  assert.equal(reads.length, readsBeforeInvalidContinue);

  const continuation = await request(appPort, '/api/ai/continue', {
    project: 'files-project',
    chapterUid: CHAPTER_UID,
  }, commonHeaders);
  assert.equal(continuation.status, 200, continuation.text);
  assert.match(continuation.text, /event: done\b/u);
  assert.match(continuation.text, /"chapterUid":"33333333-3333-4333-8333-333333333333"/u);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    selector: { projectUid: PROJECT_UID },
    request: {
      requestId: 'ai-files-request-1',
      baseWitness: BASE_WITNESS,
      command: {
        kind: 'chapter.replace_body',
        chapterUid: CHAPTER_UID,
        expected_data_version: 5,
        content: 'Existing\n\nContinuation',
      },
    },
  });
  const continueReadIndex = authorityEvents.lastIndexOf('read:chapter');
  const continueProviderIndex = authorityEvents.indexOf('provider:continue');
  const continueWriteIndex = authorityEvents.indexOf('write:chapter.replace_body');
  assert.ok(continueReadIndex < continueProviderIndex);
  assert.ok(continueProviderIndex < continueWriteIndex);

  const readsBeforeInvalidPolish = reads.length;
  const providerCallsBeforeInvalidPolish = providerCalls;
  const missingPolishRequestId = await request(appPort, '/api/ai/polish', {
    project: 'files-project',
    chapterUid: CHAPTER_UID,
  }, {
    'X-Mythpen-Project-Instance': PROJECT_INSTANCE_ID,
  });
  assert.equal(missingPolishRequestId.status, 400, missingPolishRequestId.text);
  assert.equal(reads.length, readsBeforeInvalidPolish);
  assert.equal(providerCalls, providerCallsBeforeInvalidPolish);

  const providerCallsBeforePolish = providerCalls;
  const polish = await request(appPort, '/api/ai/polish', {
    project: 'files-project',
    chapterUid: CHAPTER_UID,
  }, {
    ...commonHeaders,
    'X-Mythpen-Request-Id': 'ai-files-polish-1',
  });
  assert.equal(polish.status, 200, polish.text);
  assert.match(polish.text, /event: done\b/u);
  assert.match(polish.text, /"id":41/u);
  assert.equal(providerCalls, providerCallsBeforePolish + 1);
  assert.deepEqual(writes[1], {
    selector: { projectUid: PROJECT_UID },
    request: {
      requestId: 'ai-files-polish-1',
      baseWitness: BASE_WITNESS,
      command: {
        kind: 'revision.create',
        chapterUid: CHAPTER_UID,
        baseContent: 'Existing',
        proposedContent: 'Continuation',
      },
    },
  });
  const polishReadIndex = authorityEvents.lastIndexOf('read:chapter');
  const polishProviderIndex = authorityEvents.lastIndexOf('provider:other');
  const polishWriteIndex = authorityEvents.lastIndexOf('write:revision.create');
  assert.ok(polishReadIndex < polishProviderIndex);
  assert.ok(polishProviderIndex < polishWriteIndex);

  const stalePolish = await request(appPort, '/api/ai/polish', {
    project: 'files-project',
    chapterUid: CHAPTER_UID,
  }, {
    ...commonHeaders,
    'X-Mythpen-Request-Id': 'ai-files-polish-stale',
  });
  assert.equal(stalePolish.status, 200, stalePolish.text);
  assert.match(stalePolish.text, /event: error\b/u);
  assert.match(stalePolish.text, /EXTERNAL_DRAFT_CONFLICT/u);
  assert.doesNotMatch(stalePolish.text, /event: done\b/u);
  assert.deepEqual(
    reads.filter((entry) => entry.request.kind === 'chapter').map((entry) => entry.request),
    [
      { kind: 'chapter', chapterUid: CHAPTER_UID },
      { kind: 'chapter', chapterUid: CHAPTER_UID },
      { kind: 'chapter', chapterUid: CHAPTER_UID },
    ],
  );
  assert.equal(legacyTouches, 0);
});
