const { createHash, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');

const CONTROL_CHANNEL = 'mythpen.sidecar.v1';
const MAX_CONTROL_FRAME_BYTES = 16 * 1024;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TARGET_TRIPLE_PATTERN = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/;
const NATIVE_ACTIVATION_MODES = new Set(['off', 'fixture_only', 'production']);
const CONTROL_ERROR_CODES = new Set([
  'CONTROL_INVALID_FRAME',
  'CONTROL_BOOTSTRAP_REQUIRED',
  'CONTROL_ALREADY_BOOTSTRAPPED',
  'CONTROL_AUTH_FAILED',
  'CONTROL_ATTEMPT_INVALID',
  'CONTROL_INVALID_STATE',
  'CONTROL_CANCEL_TOO_LATE',
]);
const decoder = new TextDecoder('utf-8', { fatal: true });

class SidecarControlError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SidecarControlError';
    this.code = code;
  }
}

function controlError(code = 'CONTROL_INVALID_FRAME') {
  return new SidecarControlError(code);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length
    && actualKeys.every((key, index) => key === sortedExpected[index]);
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function scanJsonString(text, start) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  throw controlError();
}

function topLevelObjectKeys(text) {
  let index = skipWhitespace(text, 0);
  if (text[index] !== '{') throw controlError();
  index = skipWhitespace(text, index + 1);
  const keys = [];
  if (text[index] === '}') return keys;

  while (index < text.length) {
    if (text[index] !== '"') throw controlError();
    const keyEnd = scanJsonString(text, index);
    let key;
    try {
      key = JSON.parse(text.slice(index, keyEnd));
    } catch {
      throw controlError();
    }
    keys.push(key);
    index = skipWhitespace(text, keyEnd);
    if (text[index] !== ':') throw controlError();
    index += 1;

    let nestedDepth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{' || character === '[') {
        nestedDepth += 1;
      } else if (character === ']') {
        nestedDepth -= 1;
      } else if (character === '}') {
        if (nestedDepth === 0) break;
        nestedDepth -= 1;
      } else if (character === ',' && nestedDepth === 0) {
        break;
      }
    }

    if (text[index] === ',') {
      index = skipWhitespace(text, index + 1);
      continue;
    }
    if (text[index] === '}') return keys;
    throw controlError();
  }
  throw controlError();
}

function decodeControlFrame(line) {
  const bytes = typeof line === 'string' ? Buffer.from(line, 'utf8') : Buffer.from(line);
  if (bytes.length === 0 || bytes.length > MAX_CONTROL_FRAME_BYTES) throw controlError();
  let text;
  let frame;
  try {
    text = decoder.decode(bytes);
    frame = JSON.parse(text);
  } catch {
    throw controlError();
  }
  if (!isPlainObject(frame)) throw controlError();
  const keys = topLevelObjectKeys(text);
  if (new Set(keys).size !== keys.length) throw controlError();
  return frame;
}

function createNonceAuthenticator(nonce) {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) throw controlError();
  const nonceBytes = Buffer.from(nonce, 'hex');
  const nonceDigest = createHash('sha256').update(nonceBytes).digest('hex');
  return Object.freeze({
    nonceDigest,
    authenticate(candidate) {
      if (typeof candidate !== 'string' || !NONCE_PATTERN.test(candidate)) return false;
      return timingSafeEqual(nonceBytes, Buffer.from(candidate, 'hex'));
    },
  });
}

function parseBootstrapFrame(line) {
  const frame = decodeControlFrame(line);
  if (
    !hasExactKeys(frame, ['channel', 'type', 'nonce'])
    || frame.channel !== CONTROL_CHANNEL
    || frame.type !== 'bootstrap'
  ) {
    throw controlError();
  }
  return createNonceAuthenticator(frame.nonce);
}

function parseAuthenticatedCommandFrame(line, authenticator) {
  if (!authenticator || typeof authenticator.authenticate !== 'function') {
    throw controlError('CONTROL_BOOTSTRAP_REQUIRED');
  }
  const frame = decodeControlFrame(line);
  const commandKeys = frame.type === 'build.info.request'
    ? ['channel', 'type', 'nonce']
    : ['channel', 'type', 'nonce', 'attemptSeq'];
  const supported = new Set([
    'build.info.request',
    'shutdown.request',
    'shutdown.continue_wait',
    'shutdown.cancel',
  ]);
  if (
    !supported.has(frame.type)
    || !hasExactKeys(frame, commandKeys)
    || frame.channel !== CONTROL_CHANNEL
  ) {
    throw controlError();
  }
  if (!authenticator.authenticate(frame.nonce)) {
    throw controlError('CONTROL_AUTH_FAILED');
  }
  if (frame.type === 'build.info.request') return Object.freeze({ type: frame.type });
  if (!Number.isSafeInteger(frame.attemptSeq) || frame.attemptSeq < 1) {
    throw controlError('CONTROL_ATTEMPT_INVALID');
  }
  return Object.freeze({ type: frame.type, attemptSeq: frame.attemptSeq });
}

function validReadyPayload(payload) {
  return hasExactKeys(payload, [
    'childPid',
    'host',
    'port',
    'nonceDigest',
    'nativeActivationMode',
    'sourceCommit',
    'targetTriple',
  ])
    && Number.isSafeInteger(payload.childPid) && payload.childPid > 0
    && payload.host === '127.0.0.1'
    && Number.isInteger(payload.port) && payload.port > 0 && payload.port <= 65535
    && NONCE_PATTERN.test(payload.nonceDigest)
    && NATIVE_ACTIVATION_MODES.has(payload.nativeActivationMode)
    && SOURCE_COMMIT_PATTERN.test(payload.sourceCommit)
    && TARGET_TRIPLE_PATTERN.test(payload.targetTriple);
}

function validBuildInfoPayload(payload) {
  return hasExactKeys(payload, [
    'childPid',
    'nonceDigest',
    'nativeActivationMode',
    'sourceCommit',
    'targetTriple',
  ])
    && Number.isSafeInteger(payload.childPid) && payload.childPid > 0
    && NONCE_PATTERN.test(payload.nonceDigest)
    && NATIVE_ACTIVATION_MODES.has(payload.nativeActivationMode)
    && SOURCE_COMMIT_PATTERN.test(payload.sourceCommit)
    && TARGET_TRIPLE_PATTERN.test(payload.targetTriple);
}

function validShutdownStatePayload(payload) {
  return hasExactKeys(payload, ['childPid', 'attemptSeq', 'state'])
    && Number.isSafeInteger(payload.childPid) && payload.childPid > 0
    && Number.isSafeInteger(payload.attemptSeq) && payload.attemptSeq > 0
    && new Set(['quiescing', 'draining', 'closing']).has(payload.state);
}

function validShutdownCancelledPayload(payload) {
  return hasExactKeys(payload, [
    'childPid',
    'attemptSeq',
    'outcome',
    'serviceEpoch',
  ])
    && Number.isSafeInteger(payload.childPid) && payload.childPid > 0
    && Number.isSafeInteger(payload.attemptSeq) && payload.attemptSeq > 0
    && payload.outcome === 'cancelled'
    && Number.isSafeInteger(payload.serviceEpoch) && payload.serviceEpoch > 0;
}

function validShutdownCompletePayload(payload) {
  return hasExactKeys(payload, ['childPid', 'attemptSeq', 'outcome'])
    && Number.isSafeInteger(payload.childPid) && payload.childPid > 0
    && Number.isSafeInteger(payload.attemptSeq) && payload.attemptSeq > 0
    && payload.outcome === 'clean';
}

function validShutdownFailedPayload(payload) {
  return hasExactKeys(payload, ['childPid', 'attemptSeq', 'outcome', 'code'])
    && Number.isSafeInteger(payload.childPid) && payload.childPid > 0
    && Number.isSafeInteger(payload.attemptSeq) && payload.attemptSeq > 0
    && payload.outcome === 'failed'
    && payload.code === 'STORAGE_UNAVAILABLE';
}

function encodeControlFrame(type, payload) {
  let valid = false;
  if (type === 'ready') valid = validReadyPayload(payload);
  if (type === 'build.info') valid = validBuildInfoPayload(payload);
  if (type === 'shutdown.state' || type === 'shutdown.soft_deadline') {
    valid = validShutdownStatePayload(payload);
  }
  if (type === 'shutdown.cancelled') valid = validShutdownCancelledPayload(payload);
  if (type === 'shutdown.complete') valid = validShutdownCompletePayload(payload);
  if (type === 'shutdown.failed') valid = validShutdownFailedPayload(payload);
  if (type === 'control.error') {
    valid = hasExactKeys(payload, ['code']) && CONTROL_ERROR_CODES.has(payload.code);
  }
  if (!valid) throw controlError();
  return `${JSON.stringify({ channel: CONTROL_CHANNEL, type, ...payload })}\n`;
}

function createInstanceNonceMiddleware(authenticator) {
  if (!authenticator || typeof authenticator.authenticate !== 'function') {
    throw new TypeError('authenticator is required');
  }
  return function instanceNonceMiddleware(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    const candidate = req.get('X-Mythpen-Instance-Nonce');
    if (authenticator.authenticate(candidate)) return next();
    return res.status(401).json({
      error: {
        code: 'INSTANCE_NONCE_INVALID',
        message: '实例认证失败',
        recoverable: false,
      },
    });
  };
}

function createSidecarControlChannel({ input, output }) {
  if (!input || typeof input.on !== 'function') throw new TypeError('input stream is required');
  if (!output || typeof output.write !== 'function') throw new TypeError('output stream is required');

  let authenticator = null;
  let buffered = Buffer.alloc(0);
  let closed = false;
  let discardingOversizedLine = false;
  let commandHandler = null;
  const pendingCommands = [];
  let resolveBootstrap;
  let rejectBootstrap;
  const bootstrapPromise = new Promise((resolve, reject) => {
    resolveBootstrap = resolve;
    rejectBootstrap = reject;
  });

  function send(type, payload) {
    if (closed) return Promise.reject(controlError('CONTROL_INVALID_STATE'));
    const encoded = encodeControlFrame(type, payload);
    return new Promise((resolve, reject) => {
      output.write(encoded, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function sendError(code) {
    void send('control.error', { code }).catch(() => {});
  }

  function failBootstrap(code) {
    const error = controlError(code);
    sendError(code);
    rejectBootstrap(error);
    close();
  }

  function dispatchCommand(command) {
    if (!commandHandler) {
      pendingCommands.push(command);
      return;
    }
    Promise.resolve()
      .then(() => commandHandler(command))
      .catch(() => sendError('CONTROL_INVALID_STATE'));
  }

  function processLine(line) {
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    if (!authenticator) {
      try {
        authenticator = parseBootstrapFrame(line);
      } catch (error) {
        let code = error?.code || 'CONTROL_INVALID_FRAME';
        try {
          const firstFrame = decodeControlFrame(line);
          if (firstFrame.type !== 'bootstrap') code = 'CONTROL_BOOTSTRAP_REQUIRED';
        } catch {
          // Retain the parser's stable error code.
        }
        failBootstrap(code);
        return;
      }
      resolveBootstrap(authenticator);
      return;
    }

    try {
      dispatchCommand(parseAuthenticatedCommandFrame(line, authenticator));
    } catch (error) {
      sendError(error?.code || 'CONTROL_INVALID_FRAME');
    }
  }

  function onData(chunk) {
    if (closed) return;
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (discardingOversizedLine) {
      const discardedLineEnd = buffered.indexOf(0x0a);
      if (discardedLineEnd < 0) {
        buffered = Buffer.alloc(0);
        return;
      }
      buffered = buffered.subarray(discardedLineEnd + 1);
      discardingOversizedLine = false;
    }
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      const line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      processLine(line);
      if (closed) return;
    }
    const onlyExtraByteIsCarriageReturn = buffered.length === MAX_CONTROL_FRAME_BYTES + 1
      && buffered[buffered.length - 1] === 0x0d;
    if (buffered.length > MAX_CONTROL_FRAME_BYTES && !onlyExtraByteIsCarriageReturn) {
      if (!authenticator) failBootstrap('CONTROL_INVALID_FRAME');
      else {
        sendError('CONTROL_INVALID_FRAME');
        discardingOversizedLine = true;
        buffered = Buffer.alloc(0);
      }
    }
  }

  function onEnd() {
    if (closed) return;
    if (discardingOversizedLine) return;
    if (buffered.length > 0) {
      if (!authenticator) failBootstrap('CONTROL_INVALID_FRAME');
      else sendError('CONTROL_INVALID_FRAME');
    } else if (!authenticator) {
      failBootstrap('CONTROL_BOOTSTRAP_REQUIRED');
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.pause?.();
  }

  input.on('data', onData);
  input.on('end', onEnd);

  return Object.freeze({
    close,
    createInstanceNonceMiddleware() {
      if (!authenticator) throw controlError('CONTROL_BOOTSTRAP_REQUIRED');
      return createInstanceNonceMiddleware(authenticator);
    },
    get nonceDigest() {
      return authenticator?.nonceDigest || null;
    },
    send,
    setCommandHandler(handler) {
      if (typeof handler !== 'function') throw new TypeError('command handler is required');
      commandHandler = handler;
      for (const command of pendingCommands.splice(0)) dispatchCommand(command);
    },
    waitForBootstrap() {
      return bootstrapPromise;
    },
  });
}

module.exports = {
  CONTROL_CHANNEL,
  MAX_CONTROL_FRAME_BYTES,
  SidecarControlError,
  createInstanceNonceMiddleware,
  createNonceAuthenticator,
  createSidecarControlChannel,
  encodeControlFrame,
  parseAuthenticatedCommandFrame,
  parseBootstrapFrame,
};
