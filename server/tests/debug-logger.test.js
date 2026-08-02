const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRollingLogger } = require('../debug-logger');

function tempLogDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-debug-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('writes JSONL diagnostics and redacts credentials', (t) => {
  const logger = createRollingLogger({
    logDir: tempLogDir(t),
    clock: () => new Date('2026-08-01T00:00:00.000Z'),
  });

  logger.write('openai_tool_arguments_parse_failed', {
    model: 'test-model',
    apiKey: 'secret-value',
    authorization: 'Bearer another-secret',
    rawArguments: '{"chapter_num":"unterminated',
  });

  const [line] = fs.readFileSync(logger.logPath, 'utf8').trim().split('\n');
  const entry = JSON.parse(line);
  assert.equal(entry.timestamp, '2026-08-01T00:00:00.000Z');
  assert.equal(entry.event, 'openai_tool_arguments_parse_failed');
  assert.equal(entry.details.apiKey, '[REDACTED]');
  assert.equal(entry.details.authorization, '[REDACTED]');
  assert.equal(entry.details.rawArguments, '{"chapter_num":"unterminated');
  assert.equal(fs.readFileSync(logger.logPath, 'utf8').includes('secret-value'), false);
});

test('rotates logs once the active file reaches its size limit', (t) => {
  const logger = createRollingLogger({ logDir: tempLogDir(t), maxBytes: 180, maxBackups: 2 });

  logger.write('first', { value: 'x'.repeat(80) });
  logger.write('second', { value: 'x'.repeat(80) });
  logger.write('third', { value: 'x'.repeat(80) });

  assert.equal(fs.existsSync(logger.logPath), true);
  assert.equal(fs.existsSync(`${logger.logPath}.1`), true);
  assert.equal(fs.existsSync(`${logger.logPath}.2`), true);
});
