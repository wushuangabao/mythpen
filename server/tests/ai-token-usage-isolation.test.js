const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const { recordTokenUsageBestEffort } = require('../token-usage-recorder');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check (${child.exitCode})\n${output.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server health check timed out\n${output.join('')}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

test('recordTokenUsageBestEffort calls write once and isolates write and logger failures', () => {
  let writes = 0;
  let warnings = 0;
  assert.equal(recordTokenUsageBestEffort(() => {
    writes += 1;
    const error = new Error('C:\\private\\novel.db api-key=super-secret provider-payload');
    error.code = 'EIO';
    throw error;
  }, {
    warn(_message, details) {
      warnings += 1;
      assert.deepEqual(details, { code: 'EIO' });
      throw new Error('logger unavailable');
    },
  }), false);
  assert.equal(writes, 1);
  assert.equal(warnings, 1);

  assert.equal(recordTokenUsageBestEffort(() => 'ok'), true);
});

test('recordTokenUsageBestEffort logs only a bounded safe code', () => {
  const entries = [];
  const secret = 'C:\\Users\\writer\\private-project api-key=secret model-x provider-payload正文';
  recordTokenUsageBestEffort(() => {
    const error = new Error(secret);
    error.code = `BAD CODE ${secret}`;
    error.stack = secret;
    throw error;
  }, { warn: (...args) => entries.push(args) });

  assert.deepEqual(entries, [['[token_usage] write_failed', { code: 'UNKNOWN' }]]);
  assert.doesNotMatch(JSON.stringify(entries), /private-project|api-key|model-x|provider-payload|正文/i);
});

test('all AI responses complete when token usage storage rejects every write', async (t) => {
  const { dataDir } = withIsolatedDataDir(t);
  const database = require('../db');
  await database.initDatabase();

  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: 'provider result' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }));
        return;
      }
      const system = body.messages?.[0]?.content || '';
      const content = system.includes('小说编辑') ? 'polished full chapter' : 'continued text';
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
        + `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 5 },
        })}\n\n`
        + 'data: [DONE]\n\n',
      );
    });
  });
  const providerPort = await listen(provider);
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const project = 'usage-stream-isolation';
  const projectDb = database.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  const chapter = require('../manuscript-service').createManuscriptService(database).createChapter({
    projectName: project,
    source: 'rest',
    fields: {
      volume_id: 1,
      chapter_num: 1,
      title: 'Chapter',
      content: 'Before body',
    },
  }).chapter;
  projectDb.exec(`
    CREATE TRIGGER reject_token_usage
    BEFORE INSERT ON token_usage
    BEGIN
      SELECT RAISE(FAIL, 'token usage unavailable');
    END
  `);
  projectDb.flush();

  const configDb = database.getConfigDb();
  const putSetting = configDb.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  for (const [key, value] of [
    ['api_base_url', `http://127.0.0.1:${providerPort}/v1`],
    ['api_key', 'test-only-key'],
    ['api_model', 'test-model'],
    ['api_type', 'openai'],
  ]) putSetting.run(key, value);
  configDb.flush();
  database.closeAllDatabases();

  const port = await reservePort();
  const output = [];
  const child = spawn(process.execPath, [path.join('server', 'index.js')], {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, MYTHPEN_DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  t.after(() => stopChild(child));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/api/health`, child, output);

  const chat = await fetch(`${baseUrl}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project,
      messages: [{ role: 'user', content: 'answer safely' }],
    }),
  });
  assert.equal(chat.status, 200, output.join(''));
  assert.deepEqual(await chat.json(), {
    choices: [{ message: { content: 'provider result', role: 'assistant' } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  });

  const stream = await fetch(`${baseUrl}/api/ai/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project,
      messages: [{ role: 'user', content: 'write safely' }],
    }),
  });
  const streamEvents = await stream.text();

  assert.equal(stream.status, 200, output.join(''));
  assert.match(streamEvents, /event: task_end\b/);
  assert.doesNotMatch(streamEvents, /event: task_error\b/);
  assert.match(streamEvents, /provider result/);

  const polish = await fetch(`${baseUrl}/api/ai/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, chapterId: chapter.id }),
  });
  const polishEvents = await polish.text();
  assert.equal(polish.status, 200, output.join(''));
  assert.match(polishEvents, /event: done\b/);
  assert.match(polishEvents, /polished full chapter/);

  const continuation = await fetch(`${baseUrl}/api/ai/continue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, chapterId: chapter.id }),
  });
  const continuationEvents = await continuation.text();
  assert.equal(continuation.status, 200, output.join(''));
  assert.match(continuationEvents, /event: done\b/);
  assert.doesNotMatch(continuationEvents, /event: error\b/);

  const persisted = await fetch(`${baseUrl}/api/${project}/chapters/1`);
  assert.equal(persisted.status, 200, output.join(''));
  assert.match((await persisted.json()).content, /Before body[\s\S]*continued text/);

  assert.doesNotMatch(output.join(''), /token usage unavailable/i);
});
