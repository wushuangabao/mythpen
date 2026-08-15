function freezeSpec(status, message, recoverable) {
  return Object.freeze({ status, message, recoverable });
}

const PUBLIC_ERROR_SPECS = Object.freeze({
  CONFIG_DATABASE_BUSY: freezeSpec(423, '配置数据库正在被其他进程使用', true),
  PROJECT_WRITE_BUSY: freezeSpec(423, '项目正在被其他写入操作占用', true),
  RECOVERY_REQUIRED: freezeSpec(409, '项目需要恢复后才能继续', true),
  RECOVERY_SNAPSHOT_STALE: freezeSpec(409, '项目现场已变化，请刷新后重试', true),
  PROJECT_IDENTITY_REBIND_REQUIRED: freezeSpec(409, '项目身份已变化，需要确认后继续', true),
  PROJECT_SCHEMA_TOO_NEW: freezeSpec(409, '项目由更新版本创建，请升级 Mythpen 后重试', true),
  NATIVE_ACTIVATION_DISABLED: freezeSpec(409, '当前构建不允许启用原生耐久性存储', false),
  NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED: freezeSpec(409, '原生项目暂不支持迁移数据目录', false),
  DURABILITY_UNSUPPORTED: freezeSpec(422, '当前平台或存储路径不满足耐久性要求', false),
  CONTROL_CHECKPOINT_BLOCKED: freezeSpec(503, '耐久性历史暂时无法安全收敛', false),
  SERVICE_SHUTTING_DOWN: freezeSpec(503, '服务正在退出，请稍后重试', true),
  STORAGE_UNAVAILABLE: freezeSpec(503, '存储状态暂时不可用，请重启 Mythpen', false),

  INVALID_JSON: freezeSpec(400, '请求 JSON 格式无效', true),
  ROUTE_NOT_FOUND: freezeSpec(404, '请求的接口不存在', false),
  INVALID_PARAMS: freezeSpec(400, '请求参数无效', true),
  DB_NOT_FOUND: freezeSpec(404, '请求的数据不存在', true),
  PROJECT_NOT_FOUND: freezeSpec(404, '项目不存在', true),
  PROJECT_ALREADY_EXISTS: freezeSpec(409, '同名项目已存在', true),
  PROJECT_INSTANCE_MISMATCH: freezeSpec(409, '项目实例已变化，请刷新后重试', true),
  AMBIGUOUS_CHAPTER: freezeSpec(409, '章节编号不唯一，请提供章节标识', true),
  CHAPTER_IDENTITY_MISMATCH: freezeSpec(409, '章节身份不匹配，请刷新后重试', true),
  CHAPTER_VERSION_CONFLICT: freezeSpec(409, '章节已被修改，请刷新后重试', true),
  PROJECT_DELETE_FAILED: freezeSpec(500, '无法删除项目，请稍后重试', true),
  COVER_UPDATE_FAILED: freezeSpec(500, '无法更新封面，请稍后重试', true),
  COVER_DELETE_FAILED: freezeSpec(500, '无法删除封面，请稍后重试', true),
  INTERNAL_ERROR: freezeSpec(500, '服务内部错误', false),
});

const DIAGNOSTICS_EXACT_OBJECT_ROUTE = /^\/api\/projects\/by-name\/[^/]+\/diagnostics(?:\/(?:recover|export))?\/?$/;

function isDiagnosticsShapeParseError(error, req) {
  if (
    error?.type !== 'entity.parse.failed'
    || typeof error.body !== 'string'
    || !DIAGNOSTICS_EXACT_OBJECT_ROUTE.test(req?.path || '')
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(error.body);
    return parsed === null || Array.isArray(parsed) || typeof parsed !== 'object';
  } catch {
    return false;
  }
}

function publicSpec(code) {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_SPECS, code)
    ? { code, spec: PUBLIC_ERROR_SPECS[code] }
    : { code: 'INTERNAL_ERROR', spec: PUBLIC_ERROR_SPECS.INTERNAL_ERROR };
}

function statusForErrorCode(code) {
  return publicSpec(code).spec.status;
}

function publicErrorEnvelope(code, publicMessage) {
  const selected = publicSpec(code);
  const message = selected.code === code && typeof publicMessage === 'string' && publicMessage
    ? publicMessage
    : selected.spec.message;
  return {
    error: {
      code: selected.code,
      message,
      recoverable: selected.spec.recoverable,
    },
  };
}

function sendJsonError(res, code, publicMessage) {
  const selected = publicSpec(code);
  return res
    .status(selected.spec.status)
    .json(publicErrorEnvelope(selected.code, selected.code === code ? publicMessage : undefined));
}

function jsonNotFoundMiddleware(_req, _res, next) {
  const error = new Error(PUBLIC_ERROR_SPECS.ROUTE_NOT_FOUND.message);
  error.code = 'ROUTE_NOT_FOUND';
  next(error);
}

function jsonErrorMiddleware(error, req, res, next) {
  if (res.headersSent) return next(error);
  const code = error?.type === 'entity.parse.failed'
    ? isDiagnosticsShapeParseError(error, req) ? 'INVALID_PARAMS' : 'INVALID_JSON'
    : error?.code;
  return sendJsonError(res, code);
}

module.exports = {
  PUBLIC_ERROR_SPECS,
  jsonErrorMiddleware,
  jsonNotFoundMiddleware,
  publicErrorEnvelope,
  sendJsonError,
  statusForErrorCode,
};
