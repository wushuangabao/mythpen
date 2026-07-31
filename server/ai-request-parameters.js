const fs = require('node:fs');
const path = require('node:path');

const AI_REQUEST_PARAMETERS_FILE = 'ai-request-parameters.json';
const SUPPORTED_API_TYPES = new Set(['openai', 'claude']);
const SUPPORTED_OPERATIONS = new Set(['complete', 'stream']);
const PROTECTED_REQUEST_FIELDS = new Set(['model', 'messages', 'system', 'tools', 'stream']);
const DANGEROUS_PARAMETER_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_CONFIG_BYTES = 1_048_576;

const DEFAULT_AI_REQUEST_PARAMETER_CONFIG = deepFreeze({
  version: 1,
  defaults: {
    params: { max_tokens: 4096 },
    operations: {
      complete: { params: { temperature: 0.8 } },
      stream: { params: { temperature: 0.85 } },
    },
  },
  models: [
    {
      name: 'Claude Opus 5',
      match: {
        models: ['claude-opus-5'],
        apiTypes: ['openai', 'claude'],
      },
      params: {},
      omit: ['temperature'],
    },
    {
      name: 'Kimi K3',
      match: {
        models: ['kimi-k3'],
        apiTypes: ['openai'],
      },
      params: {},
      omit: ['temperature'],
    },
  ],
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertKnownKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${location} contains unknown field "${key}"`);
  }
}

function validateStringArray(value, location, { allowed, allowEmpty = true } = {}) {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${location}[${index}] must be a non-empty string`);
    }
    const normalized = item.trim();
    if (allowed && !allowed.has(normalized)) {
      throw new Error(`${location}[${index}] has unsupported value "${normalized}"`);
    }
    return normalized;
  });
  if (!allowEmpty && result.length === 0) throw new Error(`${location} must not be empty`);
  if (new Set(result).size !== result.length) throw new Error(`${location} contains duplicates`);
  return result;
}

function validateParams(value, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be an object`);
  for (const key of Object.keys(value)) {
    if (PROTECTED_REQUEST_FIELDS.has(key)) {
      throw new Error(`${location} cannot configure protected field "${key}"`);
    }
    if (DANGEROUS_PARAMETER_FIELDS.has(key)) {
      throw new Error(`${location} cannot configure dangerous field "${key}"`);
    }
  }
  return cloneJson(value);
}

function validateOmit(value, location) {
  const omit = validateStringArray(value, location);
  for (const key of omit) {
    if (PROTECTED_REQUEST_FIELDS.has(key)) {
      throw new Error(`${location} cannot omit protected field "${key}"`);
    }
    if (DANGEROUS_PARAMETER_FIELDS.has(key)) {
      throw new Error(`${location} cannot omit dangerous field "${key}"`);
    }
  }
  return omit;
}

function validateOperation(value, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be an object`);
  assertKnownKeys(value, new Set(['params', 'omit']), location);
  return {
    ...(value.params === undefined ? {} : { params: validateParams(value.params, `${location}.params`) }),
    ...(value.omit === undefined ? {} : { omit: validateOmit(value.omit, `${location}.omit`) }),
  };
}

function validateOperations(value, location) {
  if (!isPlainObject(value)) throw new Error(`${location} must be an object`);
  assertKnownKeys(value, SUPPORTED_OPERATIONS, location);
  const result = {};
  for (const [operation, entry] of Object.entries(value)) {
    result[operation] = validateOperation(entry, `${location}.${operation}`);
  }
  return result;
}

function validateScope(value, location, allowedKeys) {
  if (!isPlainObject(value)) throw new Error(`${location} must be an object`);
  assertKnownKeys(value, allowedKeys, location);
  return {
    ...(value.params === undefined ? {} : { params: validateParams(value.params, `${location}.params`) }),
    ...(value.omit === undefined ? {} : { omit: validateOmit(value.omit, `${location}.omit`) }),
    ...(value.operations === undefined ? {} : {
      operations: validateOperations(value.operations, `${location}.operations`),
    }),
  };
}

function normalizeModelNames(model) {
  const full = String(model || '').trim().toLowerCase();
  if (!full) return [];
  const basename = full.split('/').pop();
  return basename && basename !== full ? [full, basename] : [full];
}

function validateRequestParameterConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) throw new Error('config must be an object');
  assertKnownKeys(rawConfig, new Set(['version', 'defaults', 'models']), 'config');
  if (rawConfig.version !== 1) throw new Error('config.version must be 1');
  if (rawConfig.defaults === undefined) throw new Error('config.defaults is required');
  if (!Array.isArray(rawConfig.models)) throw new Error('config.models must be an array');

  const defaults = validateScope(
    rawConfig.defaults,
    'config.defaults',
    new Set(['params', 'omit', 'operations']),
  );
  const claimedMatches = new Set();
  const models = rawConfig.models.map((rule, index) => {
    const location = `config.models[${index}]`;
    if (!isPlainObject(rule)) throw new Error(`${location} must be an object`);
    assertKnownKeys(rule, new Set(['name', 'match', 'params', 'omit', 'operations']), location);
    if (typeof rule.name !== 'string' || !rule.name.trim()) {
      throw new Error(`${location}.name must be a non-empty string`);
    }
    if (!isPlainObject(rule.match)) throw new Error(`${location}.match must be an object`);
    assertKnownKeys(rule.match, new Set(['models', 'apiTypes']), `${location}.match`);
    const modelIds = validateStringArray(rule.match.models, `${location}.match.models`, {
      allowEmpty: false,
    }).map(modelId => modelId.toLowerCase());
    const apiTypes = rule.match.apiTypes === undefined
      ? [...SUPPORTED_API_TYPES]
      : validateStringArray(rule.match.apiTypes, `${location}.match.apiTypes`, {
        allowed: SUPPORTED_API_TYPES,
        allowEmpty: false,
      });

    for (const modelId of modelIds) {
      for (const normalizedName of normalizeModelNames(modelId)) {
        for (const apiType of apiTypes) {
          const key = `${apiType}:${normalizedName}`;
          if (claimedMatches.has(key)) {
            throw new Error(`${location}.match overlaps another rule for ${key}`);
          }
          claimedMatches.add(key);
        }
      }
    }

    return {
      name: rule.name.trim(),
      match: { models: modelIds, apiTypes },
      ...validateScope(rule, location, new Set(['name', 'match', 'params', 'omit', 'operations'])),
    };
  });

  return deepFreeze({ version: 1, defaults, models });
}

function ruleMatches(rule, model, apiType) {
  if (!rule.match.apiTypes.includes(apiType)) return false;
  const requested = new Set(normalizeModelNames(model));
  return rule.match.models.some(modelId => (
    normalizeModelNames(modelId).some(candidate => requested.has(candidate))
  ));
}

function mergeParams(target, source) {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = cloneJson(value);
  }
}

function resolveRequestBody(config, context) {
  const {
    baseBody,
    model,
    apiType,
    operation,
    runtimeParams = {},
  } = context;
  if (!isPlainObject(baseBody)) throw new Error('baseBody must be an object');
  if (!SUPPORTED_API_TYPES.has(apiType)) throw new Error(`Unsupported apiType "${apiType}"`);
  if (!SUPPORTED_OPERATIONS.has(operation)) throw new Error(`Unsupported operation "${operation}"`);
  const validatedRuntimeParams = validateParams(runtimeParams, 'runtimeParams');

  const matches = config.models.filter(rule => ruleMatches(rule, model, apiType));
  if (matches.length > 1) throw new Error(`Multiple request parameter rules match "${model}"`);
  const rule = matches[0];
  const resolved = cloneJson(baseBody);
  mergeParams(resolved, config.defaults.params);
  mergeParams(resolved, config.defaults.operations?.[operation]?.params);
  mergeParams(resolved, validatedRuntimeParams);
  mergeParams(resolved, rule?.params);
  mergeParams(resolved, rule?.operations?.[operation]?.params);

  const omit = [
    ...(config.defaults.omit || []),
    ...(config.defaults.operations?.[operation]?.omit || []),
    ...(rule?.omit || []),
    ...(rule?.operations?.[operation]?.omit || []),
  ];
  for (const key of omit) delete resolved[key];
  return resolved;
}

function defaultConfigText(defaultConfig) {
  return `${JSON.stringify(defaultConfig, null, 2)}\n`;
}

function fileSignature(stat) {
  return `${stat.mtimeMs}:${stat.size}`;
}

function assertReadableConfigFile(stat) {
  if (!stat.isFile()) throw new Error('configuration path is not a regular file');
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new Error(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
}

function sameFileVersion(first, second) {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs;
}

function openFlags(fsApi) {
  const constants = fsApi.constants || fs.constants;
  const flags = constants.O_RDONLY;
  return typeof constants.O_NONBLOCK === 'number'
    ? flags | constants.O_NONBLOCK
    : flags;
}

function readConfigFile(fsApi, configPath, pathStat) {
  assertReadableConfigFile(pathStat);
  let descriptor;
  try {
    descriptor = fsApi.openSync(configPath, openFlags(fsApi));
    const beforeRead = fsApi.fstatSync(descriptor);
    assertReadableConfigFile(beforeRead);
    if (!sameFileVersion(pathStat, beforeRead)) {
      throw new Error('configuration file changed before it could be read');
    }

    const buffer = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const bytesRead = fsApi.readSync(
        descriptor,
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_CONFIG_BYTES) {
      throw new Error(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes`);
    }

    const afterRead = fsApi.fstatSync(descriptor);
    assertReadableConfigFile(afterRead);
    if (!sameFileVersion(beforeRead, afterRead)) {
      throw new Error('configuration file changed while it was being read');
    }
    return buffer.toString('utf8', 0, totalBytes);
  } finally {
    if (descriptor !== undefined) fsApi.closeSync(descriptor);
  }
}

function createRequestParameterConfigLoader(options) {
  const {
    configPath,
    fsApi = fs,
    logger = console,
    defaultConfig = DEFAULT_AI_REQUEST_PARAMETER_CONFIG,
  } = options || {};
  if (typeof configPath !== 'string' || !configPath.trim()) {
    throw new Error('configPath is required');
  }

  const builtInSnapshot = validateRequestParameterConfig(defaultConfig);
  let activeSnapshot = builtInSnapshot;
  let successfulSignature = null;
  let failedSignature = null;

  function warnOnce(signature, error) {
    if (failedSignature === signature) return;
    failedSignature = signature;
    logger.warn(
      `[AI Request Parameters] Failed to load "${configPath}": ${error.message}. `
      + 'Using the last valid configuration.',
    );
  }

  function ensureConfigFile() {
    fsApi.mkdirSync(path.dirname(configPath), { recursive: true });
    try {
      fsApi.writeFileSync(configPath, defaultConfigText(defaultConfig), {
        encoding: 'utf8',
        flag: 'wx',
      });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  }

  function getSnapshot() {
    try {
      const created = ensureConfigFile();
      const stat = fsApi.statSync(configPath);
      const signature = fileSignature(stat);
      if (!created && signature === successfulSignature) return activeSnapshot;

      try {
        const rawText = readConfigFile(fsApi, configPath, stat).replace(/^\uFEFF/, '');
        const candidate = validateRequestParameterConfig(JSON.parse(rawText));
        activeSnapshot = candidate;
        successfulSignature = signature;
        failedSignature = null;
        return activeSnapshot;
      } catch (error) {
        warnOnce(signature, error);
        return activeSnapshot;
      }
    } catch (error) {
      warnOnce(`io:${error.code || error.message}`, error);
      return activeSnapshot;
    }
  }

  return { getSnapshot };
}

module.exports = {
  AI_REQUEST_PARAMETERS_FILE,
  DEFAULT_AI_REQUEST_PARAMETER_CONFIG,
  PROTECTED_REQUEST_FIELDS,
  createRequestParameterConfigLoader,
  validateRequestParameterConfig,
  resolveRequestBody,
};
