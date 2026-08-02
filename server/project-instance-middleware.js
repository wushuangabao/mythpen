const db = require('./db');

function sendProjectScopeError(res, error) {
  if (error?.code !== 'PROJECT_NOT_FOUND' && error?.code !== 'PROJECT_INSTANCE_MISMATCH') {
    return false;
  }
  res.status(error.status).json({
    error: { code: error.code, message: error.message, recoverable: true },
  });
  return true;
}

function bindAiProjectInstance(req, res, next) {
  const project = req.body?.project;
  if (typeof project !== 'string' || !project) return next();

  try {
    const requestedInstanceId = req.get('X-Mythpen-Project-Instance') || '';
    const capturedInstanceId = db.captureProjectInstance(project, requestedInstanceId);
    return db.runWithProjectInstance(project, capturedInstanceId, next);
  } catch (error) {
    if (sendProjectScopeError(res, error)) return undefined;
    return next(error);
  }
}

module.exports = { bindAiProjectInstance, sendProjectScopeError };
