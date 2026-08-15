const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function safeErrorCode(error) {
  return typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : 'UNKNOWN';
}

function recordTokenUsageBestEffort(write, logger = console) {
  try {
    write();
    return true;
  } catch (error) {
    try {
      logger?.warn?.('[token_usage] write_failed', { code: safeErrorCode(error) });
    } catch {
      // Logging is also best effort and must not affect the AI response.
    }
    return false;
  }
}

module.exports = { recordTokenUsageBestEffort };
