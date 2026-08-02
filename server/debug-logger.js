const fs = require('node:fs');
const path = require('node:path');
const { resolveStoragePaths } = require('./storage-paths');

const LOG_FILE_NAME = 'ai-debug.jsonl';
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_BACKUPS = 3;
const MAX_VALUE_LENGTH = 16 * 1024;
const SENSITIVE_KEY = /api[_-]?key|authorization|token|password|secret/i;

function truncate(value, maxLength = MAX_VALUE_LENGTH) {
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
}

function redactText(value) {
  return truncate(value)
    .replace(/("(?:api[_-]?key|authorization|token|password|secret)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
}

function sanitize(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }
  if (typeof value !== 'object') return redactText(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, seen));

  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(child, seen);
  }
  return result;
}

function rotateLog(logPath, fsApi, maxBackups) {
  const oldest = `${logPath}.${maxBackups}`;
  if (fsApi.existsSync(oldest)) fsApi.unlinkSync(oldest);

  for (let index = maxBackups - 1; index >= 1; index--) {
    const source = `${logPath}.${index}`;
    if (fsApi.existsSync(source)) fsApi.renameSync(source, `${logPath}.${index + 1}`);
  }
  if (fsApi.existsSync(logPath)) fsApi.renameSync(logPath, `${logPath}.1`);
}

function createRollingLogger(options = {}) {
  const {
    logDir,
    fsApi = fs,
    maxBytes = MAX_LOG_BYTES,
    maxBackups = MAX_BACKUPS,
    clock = () => new Date(),
  } = options;
  if (!logDir) throw new Error('logDir is required');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
  if (!Number.isInteger(maxBackups) || maxBackups < 1) throw new Error('maxBackups must be a positive integer');

  const logPath = path.join(logDir, LOG_FILE_NAME);

  return {
    logPath,
    write(event, details = {}) {
      try {
        const entry = {
          timestamp: clock().toISOString(),
          event,
          details: sanitize(details),
        };
        const line = `${JSON.stringify(entry)}\n`;
        fsApi.mkdirSync(logDir, { recursive: true });
        const size = fsApi.existsSync(logPath) ? fsApi.statSync(logPath).size : 0;
        if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
          rotateLog(logPath, fsApi, maxBackups);
        }
        fsApi.appendFileSync(logPath, line, 'utf8');
      } catch (error) {
        // Logging must never make an AI request fail.
        console.warn('[AI Debug Log] Failed to write diagnostic log:', error.message);
      }
    },
  };
}

let defaultLogger;

function getDefaultLogger() {
  if (!defaultLogger) {
    const { dataDir } = resolveStoragePaths();
    defaultLogger = createRollingLogger({ logDir: path.join(dataDir, 'logs') });
  }
  return defaultLogger;
}

function logAiDebug(event, details) {
  getDefaultLogger().write(event, details);
}

function getAiDebugLogPath() {
  return getDefaultLogger().logPath;
}

module.exports = {
  LOG_FILE_NAME,
  MAX_LOG_BYTES,
  MAX_BACKUPS,
  createRollingLogger,
  getAiDebugLogPath,
  logAiDebug,
  redactText,
  sanitize,
};
