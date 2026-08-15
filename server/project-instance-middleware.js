const db = require('./db');

function bindAiProjectInstance(req, res, next) {
  const project = req.body?.project;
  if (typeof project !== 'string' || !project) return next();

  try {
    const requestedInstanceId = req.get('X-Mythpen-Project-Instance') || '';
    const capturedInstanceId = db.captureProjectInstance(project, requestedInstanceId);
    return db.runWithProjectInstance(project, capturedInstanceId, next);
  } catch (error) {
    return next(error);
  }
}

module.exports = { bindAiProjectInstance };
