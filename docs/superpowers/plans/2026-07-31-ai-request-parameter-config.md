# AI Request Parameter Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-coded model parameter exceptions with a user-editable, hot-reloaded request-parameter configuration that applies consistently to OpenAI-compatible and Anthropic Claude requests.

**Architecture:** A focused CommonJS module owns the built-in version-1 configuration, schema validation, exact model/provider matching, parameter merging, and next-request file reload. `createAIAdapter` obtains one immutable configuration snapshot and injects it into the selected Provider, so every call made by one tool loop remains stable while newly created Adapters see valid file changes.

**Tech Stack:** Node.js CommonJS, built-in `node:fs`/`node:path`, `node:test`, existing OpenAI-compatible `fetch` adapter, existing `@anthropic-ai/sdk`, Bun sidecar compiler.

## Global Constraints

- Create `docs/ai-request-parameters.md` before any implementation or test file.
- The external file is `<current data directory>/ai-request-parameters.json`.
- A valid edit takes effect for the next newly created AI Adapter; never change a running Adapter's snapshot.
- Do not use `fs.watch`, background timers, or new dependencies.
- `params` may add or shallowly replace ordinary top-level API parameters.
- Combined global/model `omit` entries run last and remove parameters.
- Protect `model`, `messages`, `system`, `tools`, and `stream` from both `params` and `omit`.
- Match normalized exact full model IDs and their final slash-delimited segment; do not add regular expressions or fuzzy matching.
- Reject ambiguous overlapping rules rather than relying on declaration order.
- Invalid reloads retain the last valid snapshot; an invalid cold start falls back to the built-in default.
- Existing external files are never overwritten during application upgrades.
- Do not change `src/components/SettingsDrawer.tsx` or the “测试连接” behavior.
- Automated tests must not call a real AI API.

---

## File Structure

- Create `docs/ai-request-parameters.md`: authoritative user and maintainer documentation.
- Create `server/ai-request-parameters.js`: default configuration, validation, matching, resolution, hot loader, and external-file creation.
- Create `server/tests/ai-request-parameters.test.js`: pure resolver, validation, storage, reload, and fallback tests.
- Create `server/tests/ai-adapter-request-parameters.test.js`: captured-request integration tests for all four Provider methods and Adapter snapshot behavior.
- Modify `server/storage-paths.js`: expose `aiRequestParametersPath` under the effective data directory.
- Modify `server/tests/storage-paths.test.js`: lock the new path contract.
- Modify `server/ai-adapter.js`: remove the Opus-specific helper and consume one configuration snapshot in OpenAI/Claude complete/stream paths.

---

### Task 1: Publish the Authoritative Configuration Document

**Files:**
- Create: `docs/ai-request-parameters.md`
- Reference: `docs/superpowers/specs/2026-07-31-ai-request-parameter-config-design.md`

**Interfaces:**
- Consumes: the approved version-1 design.
- Produces: the authority that Task 2–4 code, defaults, and tests must follow.

- [ ] **Step 1: Create the authority document before touching code**

Write the document with these exact sections and facts:

```markdown
# AI 请求参数配置

Mythpen 通过数据目录中的 `ai-request-parameters.json` 控制发送给模型的普通顶层 API 参数。本文件是该配置格式与运行行为的权威说明。

## 配置文件位置

配置文件位于：

```text
<当前 Mythpen 数据目录>/ai-request-parameters.json
```

数据目录由 `MYTHPEN_DATA_DIR`、Mythpen 数据目录设置或默认的 `<用户目录>/.mythpen` 决定。配置文件会随整个数据目录迁移，并且不会在应用升级时覆盖已有内容。

文件不存在时，下一次创建 AI 请求会生成默认配置。用户删除文件后，下一次请求会重新生成默认配置。

## 热加载

Mythpen 不使用文件监听器。每次创建新的 AI Adapter 时检查文件的修改时间与大小；文件变化后重新读取、解析和校验。

- 有效修改：从下一次新请求开始生效。
- 无效修改：继续使用最后一次有效配置。
- 冷启动时配置无效：使用程序内置默认配置。
- 同一次工具调用循环固定使用创建 Adapter 时的配置快照。

配置错误会写入服务端日志，但 Mythpen 不覆盖或自动修复错误文件。修正文件后，后续新请求会再次尝试加载。

## 默认配置

```json
{
  "version": 1,
  "defaults": {
    "params": {
      "max_tokens": 4096
    },
    "operations": {
      "complete": {
        "params": {
          "temperature": 0.8
        }
      },
      "stream": {
        "params": {
          "temperature": 0.85
        }
      }
    }
  },
  "models": [
    {
      "name": "Claude Opus 5",
      "match": {
        "models": ["claude-opus-5"],
        "apiTypes": ["openai", "claude"]
      },
      "params": {},
      "omit": ["temperature"]
    },
    {
      "name": "Kimi K3",
      "match": {
        "models": ["kimi-k3"],
        "apiTypes": ["openai"]
      },
      "params": {},
      "omit": ["temperature"]
    }
  ]
}
```

`version` 必须是 `1`。JSON 不支持注释。

## 配置结构

`defaults` 与每条模型规则都可以包含：

- `params`：同时作用于非流式与流式请求。
- `omit`：最终删除的参数名。
- `operations.complete`：仅作用于上游非流式请求。
- `operations.stream`：仅作用于上游流式请求。

操作配置也可以包含 `params` 和 `omit`。

`params` 可以保存任意合法 JSON 值，并以顶层参数为单位覆盖。对象和数组整体替换，不进行深层合并。`null` 会作为真实值发送；如需不发送参数，必须将名称放进 `omit`。

## 模型匹配

`match.models` 是非空模型标识数组。`match.apiTypes` 可以省略，或填写 `openai`、`claude`。

模型名匹配忽略大小写和首尾空格，同时检查完整标识及最后一个 `/` 后的末段。例如 `vendor/kimi-k3` 可以命中 `kimi-k3`，但 `kimi-k3-preview` 不会命中。版本化模型必须显式列入 `models`。

`apiTypes` 使用 Adapter 最终解析出的 Provider。自动识别的 Claude 使用 `claude`；配置为 OpenAI-compatible 的 Claude 代理使用 `openai`。

多条规则不能在相同接口类型下匹配同一模型。

## 合并顺序

同名参数按以下顺序覆盖：

1. Mythpen 协议请求体；
2. `defaults.params`；
3. `defaults.operations.<operation>.params`；
4. 调用方运行时参数；
5. 模型规则 `params`；
6. 模型规则 `operations.<operation>.params`；
7. 删除全部公共及操作级 `omit` 参数。

因此 `omit` 的优先级最高。

## 受保护字段

以下协议结构字段不能出现在 `params` 或 `omit` 中：

- `model`
- `messages`
- `system`
- `tools`
- `stream`

## 自定义示例

要给 Kimi K3 指定推理强度，应编辑已有的 Kimi K3 规则，不要新增第二条重复规则：

```json
{
  "name": "Kimi K3",
  "match": {
    "models": ["kimi-k3"],
    "apiTypes": ["openai"]
  },
  "params": {
    "reasoning_effort": "high"
  },
  "omit": ["temperature"]
}
```

仅为流式续写增加参数：

```json
{
  "name": "Example Model",
  "match": {
    "models": ["example-model"],
    "apiTypes": ["openai"]
  },
  "operations": {
    "stream": {
      "params": {
        "stream_options": {
          "include_usage": true
        }
      }
    }
  }
}
```

## 错误处理

以下情况会使整个新配置失效并回退：

- JSON 语法错误或 `version` 不受支持；
- 未知结构字段；
- 对象、数组或字符串字段类型不正确；
- 空模型标识、未知接口类型或重复匹配；
- 使用受保护字段；
- 顶层参数名使用 `__proto__`、`prototype` 或 `constructor`。

Mythpen 不会在加载失败时修改用户文件。
```

- [ ] **Step 2: Verify the document is complete and its JSON examples parse**

Run:

```powershell
rg -n "^## (配置文件位置|热加载|默认配置|配置结构|模型匹配|合并顺序|受保护字段|自定义示例|错误处理)$" docs/ai-request-parameters.md
node -e "const fs=require('fs'); const s=fs.readFileSync('docs/ai-request-parameters.md','utf8'); const blocks=[...s.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(x=>x[1]); blocks.forEach(JSON.parse); console.log('parsed JSON examples:', blocks.length)"
```

Expected:

```text
Nine required section headings are found.
parsed JSON examples: 3
```

- [ ] **Step 3: Commit the authoritative document**

```bash
git add docs/ai-request-parameters.md
git commit -m "docs: document AI request parameter configuration"
```

---

### Task 2: Implement Version-1 Validation, Matching, and Parameter Resolution

**Files:**
- Create: `server/ai-request-parameters.js`
- Create: `server/tests/ai-request-parameters.test.js`
- Reference: `docs/ai-request-parameters.md`

**Interfaces:**
- Produces: `DEFAULT_AI_REQUEST_PARAMETER_CONFIG`, `PROTECTED_REQUEST_FIELDS`, `validateRequestParameterConfig(raw)`, and `resolveRequestBody(config, context)`.
- `context`: `{ baseBody: object, model: string, apiType: 'openai'|'claude', operation: 'complete'|'stream', runtimeParams?: object }`.
- `resolveRequestBody` returns a new complete request body and never mutates `config`, `baseBody`, or `runtimeParams`. Resolving the complete body ensures `omit` can remove an ordinary parameter that originated in any lower layer, including `baseBody`.

- [ ] **Step 1: Write failing tests for defaults, matching, precedence, and omission**

Create `server/tests/ai-request-parameters.test.js` with these initial tests:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_AI_REQUEST_PARAMETER_CONFIG,
  validateRequestParameterConfig,
  resolveRequestBody,
} = require('../ai-request-parameters');

test('unknown models receive operation defaults and runtime values override defaults', () => {
  const config = validateRequestParameterConfig(DEFAULT_AI_REQUEST_PARAMETER_CONFIG);

  assert.deepEqual(resolveRequestBody(config, {
    baseBody: {},
    model: 'unknown-model',
    apiType: 'openai',
    operation: 'complete',
    runtimeParams: { temperature: 0.2 },
  }), {
    max_tokens: 4096,
    temperature: 0.2,
  });

  assert.deepEqual(resolveRequestBody(config, {
    baseBody: {},
    model: 'unknown-model',
    apiType: 'openai',
    operation: 'stream',
  }), {
    max_tokens: 4096,
    temperature: 0.85,
  });
});

test('Opus 5 and Kimi K3 omit temperature after every merge layer', () => {
  const config = validateRequestParameterConfig(DEFAULT_AI_REQUEST_PARAMETER_CONFIG);

  for (const scenario of [
    { model: 'vendor/CLAUDE-OPUS-5 ', apiType: 'openai' },
    { model: 'claude-opus-5', apiType: 'claude' },
    { model: 'moonshot/kimi-k3', apiType: 'openai' },
  ]) {
    assert.deepEqual(resolveRequestBody(config, {
      baseBody: {},
      ...scenario,
      operation: 'complete',
      runtimeParams: { temperature: 0, custom: true },
    }), {
      max_tokens: 4096,
      custom: true,
    });
  }

  assert.deepEqual(resolveRequestBody(config, {
    baseBody: {},
    model: 'kimi-k3',
    apiType: 'claude',
    operation: 'complete',
    runtimeParams: { temperature: 0 },
  }), {
    max_tokens: 4096,
    temperature: 0,
  });
});

test('model and operation params shallowly override lower layers before omit runs', () => {
  const config = validateRequestParameterConfig({
    version: 1,
    defaults: {
      params: {
        max_tokens: 4096,
        nested: { source: 'default', retained: true },
      },
      omit: ['global_remove'],
      operations: {
        stream: {
          params: { temperature: 0.85 },
          omit: ['stream_remove'],
        },
      },
    },
    models: [{
      name: 'Configured Model',
      match: { models: ['configured-model'], apiTypes: ['openai'] },
      params: {
        nested: { source: 'model' },
        nullable: null,
        reasoning_effort: 'high',
        model_remove: 'removed',
      },
      omit: ['model_remove'],
      operations: {
        stream: {
          params: {
            temperature: 1,
            stream_options: { include_usage: true },
          },
        },
      },
    }],
  });

  const baseBody = {
    global_remove: true,
    stream_remove: true,
    model_remove: true,
  };
  const runtimeParams = {
    temperature: 0.2,
  };
  const resolved = resolveRequestBody(config, {
    baseBody,
    model: 'configured-model',
    apiType: 'openai',
    operation: 'stream',
    runtimeParams,
  });

  assert.deepEqual(resolved, {
    max_tokens: 4096,
    nested: { source: 'model' },
    nullable: null,
    reasoning_effort: 'high',
    temperature: 1,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(runtimeParams, {
    temperature: 0.2,
  });
  assert.deepEqual(baseBody, {
    global_remove: true,
    stream_remove: true,
    model_remove: true,
  });
});
```

- [ ] **Step 2: Add failing validation and immutability tests before implementation**

Append:

```js
test('validation rejects protected fields, dangerous fields, unknown fields, and overlaps', () => {
  const invalidConfigs = [
    {
      expected: /protected field "stream"/,
      config: {
        version: 1,
        defaults: { params: { stream: false } },
        models: [],
      },
    },
    {
      expected: /dangerous field "constructor"/,
      config: {
        version: 1,
        defaults: { params: JSON.parse('{"constructor":"unsafe"}') },
        models: [],
      },
    },
    {
      expected: /unknown field "unexpected"/,
      config: {
        version: 1,
        defaults: { unexpected: true },
        models: [],
      },
    },
    {
      expected: /overlaps another rule/,
      config: {
        version: 1,
        defaults: {},
        models: [
          {
            name: 'one',
            match: { models: ['kimi-k3'], apiTypes: ['openai'] },
          },
          {
            name: 'two',
            match: { models: ['vendor/kimi-k3'], apiTypes: ['openai'] },
          },
        ],
      },
    },
  ];

  for (const scenario of invalidConfigs) {
    assert.throws(
      () => validateRequestParameterConfig(scenario.config),
      scenario.expected,
    );
  }
});

test('resolved nested values do not mutate a frozen shared configuration', () => {
  const config = validateRequestParameterConfig({
    version: 1,
    defaults: { params: { nested: { value: 1 } } },
    models: [],
  });
  const first = resolveRequestBody(config, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  });
  first.nested.value = 9;
  const second = resolveRequestBody(config, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  });
  assert.deepEqual(second.nested, { value: 1 });
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
node server/tests/ai-request-parameters.test.js
```

Expected: FAIL because `server/ai-request-parameters.js` does not exist.

- [ ] **Step 4: Implement the built-in config, validator, and resolver**

Create `server/ai-request-parameters.js` with:

```js
const fs = require('node:fs');
const path = require('node:path');

const AI_REQUEST_PARAMETERS_FILE = 'ai-request-parameters.json';
const SUPPORTED_API_TYPES = new Set(['openai', 'claude']);
const SUPPORTED_OPERATIONS = new Set(['complete', 'stream']);
const PROTECTED_REQUEST_FIELDS = new Set(['model', 'messages', 'system', 'tools', 'stream']);
const DANGEROUS_PARAMETER_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);

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
  return basename === full ? [full] : [full, basename];
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

module.exports = {
  AI_REQUEST_PARAMETERS_FILE,
  DEFAULT_AI_REQUEST_PARAMETER_CONFIG,
  PROTECTED_REQUEST_FIELDS,
  validateRequestParameterConfig,
  resolveRequestBody,
};
```

Do not implement file loading yet; `fs` and `path` are intentionally used in Task 3.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
node server/tests/ai-request-parameters.test.js
```

Expected: all resolver and validation subtests pass with zero failures.

- [ ] **Step 6: Commit the pure configuration contract**

```bash
git add server/ai-request-parameters.js server/tests/ai-request-parameters.test.js
git commit -m "feat(ai): add request parameter configuration resolver"
```

---

### Task 3: Add Data-Directory Storage and Next-Request Hot Reload

**Files:**
- Modify: `server/storage-paths.js:20-25`
- Modify: `server/tests/storage-paths.test.js:11-38`
- Modify: `server/ai-request-parameters.js`
- Modify: `server/tests/ai-request-parameters.test.js`

**Interfaces:**
- `resolveStoragePaths()` additionally produces `aiRequestParametersPath`.
- `createRequestParameterConfigLoader(options)` consumes `{ configPath, fsApi?, logger?, defaultConfig? }`.
- The loader produces `{ getSnapshot(): ValidatedConfig }`.
- A successful `getSnapshot()` result is immutable and remains valid after later loader reloads.

- [ ] **Step 1: Write a failing storage-path assertion**

Add to every relevant `resolveStoragePaths` scenario:

```js
assert.equal(
  paths.aiRequestParametersPath,
  path.join(paths.dataDir, 'ai-request-parameters.json'),
);
```

Run:

```bash
node server/tests/storage-paths.test.js
```

Expected: FAIL because `aiRequestParametersPath` is undefined.

- [ ] **Step 2: Expose the configuration path**

In `resolveStoragePaths`, add:

```js
aiRequestParametersPath: path.join(dataDir, 'ai-request-parameters.json'),
```

Run:

```bash
node server/tests/storage-paths.test.js
```

Expected: all storage-path tests pass.

- [ ] **Step 3: Write failing loader tests**

Extend `server/tests/ai-request-parameters.test.js` imports:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_AI_REQUEST_PARAMETER_CONFIG,
  createRequestParameterConfigLoader,
  validateRequestParameterConfig,
  resolveRequestBody,
} = require('../ai-request-parameters');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-${label}-`));
}

function writeConfig(filePath, config) {
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
```

Add these tests:

```js
test('loader creates the default file once and does not overwrite an existing file', () => {
  const directory = tempDir('ai-request-create');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  const loader = createRequestParameterConfigLoader({ configPath });

  const first = loader.getSnapshot();
  assert.deepEqual(first, validateRequestParameterConfig(DEFAULT_AI_REQUEST_PARAMETER_CONFIG));
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), DEFAULT_AI_REQUEST_PARAMETER_CONFIG);

  const custom = {
    version: 1,
    defaults: { params: { max_tokens: 1234 } },
    models: [],
  };
  writeConfig(configPath, custom);
  const second = loader.getSnapshot();
  assert.equal(resolveRequestBody(second, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  }).max_tokens, 1234);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), custom);
});

test('loader reloads valid changes for the next snapshot while old snapshots stay fixed', () => {
  const directory = tempDir('ai-request-reload');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  const loader = createRequestParameterConfigLoader({ configPath });
  const oldSnapshot = loader.getSnapshot();

  const updated = {
    version: 1,
    defaults: { params: { max_tokens: 9000, added: true } },
    models: [],
  };
  writeConfig(configPath, updated);
  const now = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, now, now);
  const newSnapshot = loader.getSnapshot();

  assert.equal(resolveRequestBody(oldSnapshot, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  }).max_tokens, 4096);
  assert.deepEqual(resolveRequestBody(newSnapshot, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  }), {
    max_tokens: 9000,
    added: true,
  });
});

test('invalid reload retains the last valid snapshot and logs once per failed signature', () => {
  const directory = tempDir('ai-request-invalid-reload');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  const warnings = [];
  const loader = createRequestParameterConfigLoader({
    configPath,
    logger: { warn: message => warnings.push(message) },
  });
  const valid = loader.getSnapshot();

  fs.writeFileSync(configPath, '{"version":', 'utf8');
  const now = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, now, now);
  assert.equal(loader.getSnapshot(), valid);
  assert.equal(loader.getSnapshot(), valid);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ai-request-parameters\.json/);
});

test('loader retries an unchanged failed signature and recovers after in-place repair', () => {
  const directory = tempDir('ai-request-retry');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  const warnings = [];
  const loader = createRequestParameterConfigLoader({
    configPath,
    logger: { warn: message => warnings.push(message) },
  });
  loader.getSnapshot();

  const validText = JSON.stringify({
    version: 1,
    defaults: { params: { repaired: true } },
    models: [],
  });
  const invalidText = validText.replace('"version":1', '"version":2');
  const fixedTime = new Date(Date.now() + 2000);
  fs.writeFileSync(configPath, invalidText, 'utf8');
  fs.utimesSync(configPath, fixedTime, fixedTime);
  loader.getSnapshot();

  fs.writeFileSync(configPath, validText, 'utf8');
  fs.utimesSync(configPath, fixedTime, fixedTime);
  const repaired = loader.getSnapshot();
  assert.equal(resolveRequestBody(repaired, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  }).repaired, true);
  assert.equal(warnings.length, 1);
});

test('invalid cold start falls back to built-in defaults without overwriting the file', () => {
  const directory = tempDir('ai-request-invalid-cold');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  fs.writeFileSync(configPath, '{"broken":true}', 'utf8');
  const warnings = [];
  const loader = createRequestParameterConfigLoader({
    configPath,
    logger: { warn: message => warnings.push(message) },
  });

  const snapshot = loader.getSnapshot();
  assert.deepEqual(snapshot, validateRequestParameterConfig(DEFAULT_AI_REQUEST_PARAMETER_CONFIG));
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{"broken":true}');
  assert.equal(warnings.length, 1);
});

test('deleting the file regenerates defaults on the next snapshot request', () => {
  const directory = tempDir('ai-request-delete');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  const loader = createRequestParameterConfigLoader({ configPath });
  loader.getSnapshot();
  writeConfig(configPath, {
    version: 1,
    defaults: { params: { max_tokens: 7777 } },
    models: [],
  });
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, changed, changed);
  const customSnapshot = loader.getSnapshot();
  assert.equal(resolveRequestBody(customSnapshot, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  }).max_tokens, 7777);
  fs.unlinkSync(configPath);

  const snapshot = loader.getSnapshot();
  assert.equal(fs.existsSync(configPath), true);
  assert.deepEqual(snapshot, validateRequestParameterConfig(DEFAULT_AI_REQUEST_PARAMETER_CONFIG));
});
```

- [ ] **Step 4: Run loader tests and verify RED**

Run:

```bash
node server/tests/ai-request-parameters.test.js
```

Expected: FAIL because `createRequestParameterConfigLoader` is not exported.

- [ ] **Step 5: Implement creation, signature checking, reload, and fallback**

Add to `server/ai-request-parameters.js`:

```js
function defaultConfigText(defaultConfig) {
  return `${JSON.stringify(defaultConfig, null, 2)}\n`;
}

function fileSignature(stat) {
  return `${stat.mtimeMs}:${stat.size}`;
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
        const rawText = fsApi.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
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
```

Add `createRequestParameterConfigLoader` to `module.exports`.

- [ ] **Step 6: Run focused tests and full server tests**

Run:

```bash
node server/tests/storage-paths.test.js
node server/tests/ai-request-parameters.test.js
pnpm test:server
```

Expected: every test passes. If the sandbox reports `spawn EPERM` for `pnpm test:server`, rerun the same command with the required sandbox approval; do not treat the sandbox process error as an assertion failure.

- [ ] **Step 7: Commit hot reload and storage integration**

```bash
git add server/storage-paths.js server/tests/storage-paths.test.js server/ai-request-parameters.js server/tests/ai-request-parameters.test.js
git commit -m "feat(ai): hot reload request parameter configuration"
```

---

### Task 4: Apply One Configuration Snapshot to All Provider Request Paths

**Files:**
- Modify: `server/ai-adapter.js:1-302`
- Create: `server/tests/ai-adapter-request-parameters.test.js`
- Verify unchanged: `src/components/SettingsDrawer.tsx`

**Interfaces:**
- `createAIAdapter(model, apiConfig, apiType, options?)` accepts optional `{ requestParameterLoader }`.
- The loader is called exactly once per Adapter creation.
- `OpenAIProvider` and `ClaudeProvider` receive `(apiConfig, requestParameterConfig)`.
- Both Provider methods call `resolveRequestBody` with their structural base body, resolved Provider type, and operation.

- [ ] **Step 1: Write failing captured-request tests for OpenAI complete and stream**

Create `server/tests/ai-adapter-request-parameters.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OpenAIProvider,
  ClaudeProvider,
  createAIAdapter,
} = require('../ai-adapter');
const {
  validateRequestParameterConfig,
} = require('../ai-request-parameters');

function configWithParameters() {
  return validateRequestParameterConfig({
    version: 1,
    defaults: {
      params: { max_tokens: 1234 },
      operations: {
        complete: { params: { temperature: 0.4 } },
        stream: { params: { temperature: 0.5 } },
      },
    },
    models: [{
      name: 'Configured',
      match: { models: ['configured'], apiTypes: ['openai', 'claude'] },
      params: { reasoning_effort: 'high' },
      omit: ['temperature'],
    }],
  });
}

test('OpenAI complete applies configured params and preserves protocol fields', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: {},
      }),
    };
  };
  try {
    const provider = new OpenAIProvider({
      apiModel: 'configured',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, configWithParameters());
    await provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0);
    assert.deepEqual(captured, {
      model: 'configured',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      tools: [],
      max_tokens: 1234,
      reasoning_effort: 'high',
      stream: false,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAI stream uses stream operation params and yields content', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"片段"}}]}\\n\\ndata: [DONE]\\n\\n',
    );
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };
  try {
    const provider = new OpenAIProvider({
      apiModel: 'configured',
      apiKey: 'test',
      chatUrl: 'https://example.invalid/chat/completions',
    }, configWithParameters());
    const events = [];
    for await (const event of provider.stream(
      'system',
      [{ role: 'user', content: 'hello' }],
      0,
    )) {
      events.push(event);
    }
    assert.equal(captured.stream, true);
    assert.equal(captured.max_tokens, 1234);
    assert.equal(captured.reasoning_effort, 'high');
    assert.equal('temperature' in captured, false);
    assert.deepEqual(events, [{ type: 'chunk', text: '片段' }]);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Write failing captured-request tests for Claude complete and stream**

Append:

```js
test('Claude complete applies the same resolver before SDK invocation', async () => {
  let captured;
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters());
  provider.client = {
    messages: {
      create: async params => {
        captured = params;
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: {},
        };
      },
    },
  };

  await provider.complete('system', [{ role: 'user', content: 'hello' }], [], 0);
  assert.equal(captured.model, 'configured');
  assert.equal(captured.max_tokens, 1234);
  assert.equal(captured.reasoning_effort, 'high');
  assert.equal('temperature' in captured, false);
  assert.equal(captured.system, 'system');
  assert.deepEqual(captured.messages, [{ role: 'user', content: 'hello' }]);
  assert.equal('tools' in captured, false);
});

test('Claude stream applies stream parameters and keeps SDK streaming behavior', async () => {
  let captured;
  const provider = new ClaudeProvider({
    apiModel: 'configured',
    apiKey: 'test',
  }, configWithParameters());
  provider.client = {
    messages: {
      stream: params => {
        captured = params;
        return (async function* events() {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '片段' },
          };
        }());
      },
    },
  };

  const events = [];
  for await (const event of provider.stream(
    'system',
    [{ role: 'user', content: 'hello' }],
    0,
  )) {
    events.push(event);
  }
  assert.equal(captured.max_tokens, 1234);
  assert.equal(captured.reasoning_effort, 'high');
  assert.equal('temperature' in captured, false);
  assert.deepEqual(events, [
    { type: 'chunk', text: '片段' },
    { type: 'usage', inputTokens: 0, outputTokens: 0 },
  ]);
});
```

- [ ] **Step 3: Write a failing Adapter snapshot test**

Append:

```js
test('createAIAdapter reads the loader once and each Adapter keeps its snapshot', () => {
  const firstConfig = validateRequestParameterConfig({
    version: 1,
    defaults: { params: { marker: 'first' } },
    models: [],
  });
  const secondConfig = validateRequestParameterConfig({
    version: 1,
    defaults: { params: { marker: 'second' } },
    models: [],
  });
  let calls = 0;
  const loader = {
    getSnapshot() {
      calls += 1;
      return calls === 1 ? firstConfig : secondConfig;
    },
  };
  const base = {
    apiModel: 'model',
    apiKey: 'test',
    apiBaseUrl: 'https://example.invalid/v1',
  };

  const first = createAIAdapter('model', { ...base }, 'openai', {
    requestParameterLoader: loader,
  });
  const second = createAIAdapter('model', { ...base }, 'openai', {
    requestParameterLoader: loader,
  });

  assert.equal(calls, 2);
  assert.equal(first.requestParameterConfig, firstConfig);
  assert.equal(second.requestParameterConfig, secondConfig);
});
```

- [ ] **Step 4: Run Adapter tests and verify RED**

Run:

```bash
node server/tests/ai-adapter-request-parameters.test.js
```

Expected: FAIL because Provider constructors and `createAIAdapter` do not accept configuration snapshots.

- [ ] **Step 5: Replace the hard-coded temperature helper with the shared resolver**

At the top of `server/ai-adapter.js`, add:

```js
const { resolveStoragePaths } = require('./storage-paths');
const {
  createRequestParameterConfigLoader,
  resolveRequestBody,
} = require('./ai-request-parameters');

const defaultRequestParameterLoader = createRequestParameterConfigLoader({
  configPath: resolveStoragePaths().aiRequestParametersPath,
});
```

Delete `shouldOmitSamplingParameters` and `buildTemperatureParam`.

Update constructors:

```js
class OpenAIProvider {
  constructor(apiConfig, requestParameterConfig) {
    this.apiConfig = apiConfig;
    this.requestParameterConfig = requestParameterConfig;
  }

  requestBody(baseBody, operation, temperature) {
    return resolveRequestBody(this.requestParameterConfig, {
      baseBody,
      model: this.apiConfig.apiModel,
      apiType: 'openai',
      operation,
      runtimeParams: temperature === undefined ? {} : { temperature },
    });
  }
}
```

```js
class ClaudeProvider {
  constructor(apiConfig, requestParameterConfig) {
    this.apiConfig = apiConfig;
    this.requestParameterConfig = requestParameterConfig;
    this.client = new Anthropic({ apiKey: apiConfig.apiKey });
  }

  requestBody(baseBody, operation, temperature) {
    return resolveRequestBody(this.requestParameterConfig, {
      baseBody,
      model: this.apiConfig.apiModel,
      apiType: 'claude',
      operation,
      runtimeParams: temperature === undefined ? {} : { temperature },
    });
  }
}
```

Construct OpenAI complete and stream bodies by resolving the whole base body:

```js
const body = this.requestBody({
  model: apiConfig.apiModel,
  messages: [{ role: 'system', content: systemPrompt }, ...messages],
  tools: tools || undefined,
  stream: false,
}, 'complete', temperature);
```

```js
const body = this.requestBody({
  model: apiConfig.apiModel,
  messages: [{ role: 'system', content: systemPrompt }, ...messages],
  stream: true,
}, 'stream', temperature);
```

Construct Claude complete and stream params with:

```js
const baseBody = {
  model: apiConfig.apiModel,
  system: systemPrompt,
  messages: toClaudeMessages(messages),
};
if (tools && tools.length > 0) {
  baseBody.tools = toClaudeTools(tools);
}
const params = this.requestBody(baseBody, 'complete', temperature);
```

```js
const params = this.requestBody({
  model: apiConfig.apiModel,
  system: systemPrompt,
  messages: toClaudeMessages(messages),
}, 'stream', temperature);
const stream = client.messages.stream(params);
```

Update the factory:

```js
function createAIAdapter(model, apiConfig, apiType, options = {}) {
  const provider = detectProvider(model, apiType);
  const requestParameterLoader = options.requestParameterLoader || defaultRequestParameterLoader;
  const requestParameterConfig = requestParameterLoader.getSnapshot();
  console.log(`[AI Adapter] Using ${provider} provider for model "${model}" (apiType: ${apiType || 'auto'})`);

  if (provider === 'openai') {
    const baseUrl = apiConfig.apiBaseUrl || 'https://api.deepseek.com/v1';
    apiConfig.chatUrl = baseUrl.replace(/\/?$/, '') + '/chat/completions';
  }

  switch (provider) {
    case 'claude':
      return new ClaudeProvider(apiConfig, requestParameterConfig);
    case 'openai':
    default:
      return new OpenAIProvider(apiConfig, requestParameterConfig);
  }
}
```

Keep existing response parsing, error details, tool conversion, token accounting, and factory exports unchanged.

- [ ] **Step 6: Run focused Adapter tests and resolve exact request-shape differences**

Run:

```bash
node server/tests/ai-adapter-request-parameters.test.js
```

Expected: all five subtests pass. The OpenAI complete expectation must match the existing `tools || undefined` serialization behavior: if an empty array is supplied, the body contains `tools: []`; if `null` is supplied, JSON serialization omits the field.

- [ ] **Step 7: Run all server tests and syntax checks**

Run:

```bash
node --check server/ai-request-parameters.js
node --check server/ai-adapter.js
pnpm test:server
```

Expected: exit code 0 and zero failing tests.

- [ ] **Step 8: Commit Provider integration**

```bash
git add server/ai-adapter.js server/tests/ai-adapter-request-parameters.test.js
git commit -m "feat(ai): configure request parameters per model"
```

---

### Task 5: Verify Runtime Generation, Build Compatibility, and Scope

**Files:**
- Verify: `docs/ai-request-parameters.md`
- Verify: `server/ai-request-parameters.js`
- Verify: `server/ai-adapter.js`
- Verify unchanged: `src/components/SettingsDrawer.tsx`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that local Node, the complete server suite, TypeScript, lint, and Bun sidecar packaging agree with the authority document.

- [ ] **Step 1: Run a temporary-directory generation and hot-reload smoke test**

Run:

```powershell
@'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createRequestParameterConfigLoader,
  resolveRequestBody,
} = require('./server/ai-request-parameters');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-ai-config-smoke-'));
const configPath = path.join(directory, 'ai-request-parameters.json');
const loader = createRequestParameterConfigLoader({ configPath });
const first = loader.getSnapshot();
const firstParams = resolveRequestBody(first, {
  baseBody: {},
  model: 'kimi-k3',
  apiType: 'openai',
  operation: 'complete',
  runtimeParams: { temperature: 0.8 },
});
if ('temperature' in firstParams) throw new Error('Kimi K3 temperature was not omitted');

const changed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
changed.models.find(rule => rule.name === 'Kimi K3').params.reasoning_effort = 'high';
fs.writeFileSync(configPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8');
const now = new Date(Date.now() + 2000);
fs.utimesSync(configPath, now, now);
const second = loader.getSnapshot();
const secondParams = resolveRequestBody(second, {
  baseBody: {},
  model: 'kimi-k3',
  apiType: 'openai',
  operation: 'complete',
});
if (secondParams.reasoning_effort !== 'high') throw new Error('hot reload did not apply');
console.log('AI request parameter smoke test passed');
'@ | node -
```

Expected:

```text
AI request parameter smoke test passed
```

- [ ] **Step 2: Run the full project verification**

Run:

```bash
pnpm test:server
pnpm tsc --project tsconfig.app.json --noEmit
pnpm lint
pnpm build:sidecar
```

Expected:

- Server tests: zero failures.
- TypeScript: exit code 0.
- Biome: exit code 0 with no unrelated rewrites.
- Sidecar build: both server and CLI binaries are produced for the detected Rust host triple.

If a command fails because the sandbox forbids process spawning or network access, rerun that exact command with the required approval. If it fails for a source, assertion, toolchain-version, or packaging reason, fix that reason and rerun the complete command.

- [ ] **Step 3: Confirm the authorized scope**

Run:

```bash
git status --short
git diff --check
git diff --name-only 3eca094..HEAD
```

Expected changed implementation files are limited to:

```text
docs/ai-request-parameters.md
docs/superpowers/plans/2026-07-31-ai-request-parameter-config.md
server/ai-request-parameters.js
server/ai-adapter.js
server/storage-paths.js
server/tests/ai-request-parameters.test.js
server/tests/ai-adapter-request-parameters.test.js
server/tests/storage-paths.test.js
```

`3eca094` is the approved design-specification baseline. The plan file is expected after that baseline; the approved specification itself is already contained in the baseline. `src/components/SettingsDrawer.tsx` must not be changed.

- [ ] **Step 4: Review authority consistency**

Compare these exact contracts:

```text
Authority default JSON == DEFAULT_AI_REQUEST_PARAMETER_CONFIG
Authority protected fields == PROTECTED_REQUEST_FIELDS
Authority matching rules == normalizeModelNames + ruleMatches
Authority precedence == resolveRequestBody merge and omit order
Authority reload/fallback == createRequestParameterConfigLoader
```

Correct any mismatch in code, tests, or `docs/ai-request-parameters.md`, rerun the affected focused tests, and rerun `git diff --check`.

- [ ] **Step 5: Commit any verification-only consistency correction**

Only if Step 4 required a correction:

```bash
git add docs/ai-request-parameters.md server/ai-request-parameters.js server/ai-adapter.js server/tests
git commit -m "fix(ai): align request parameter configuration contract"
```

If no correction was needed, do not create an empty commit.

---

## Completion Checklist

- [ ] The authority document was the first implementation commit.
- [ ] The external file is generated in the effective data directory.
- [ ] Valid changes apply to the next Adapter without restart.
- [ ] Invalid changes retain the last valid or built-in snapshot.
- [ ] Opus 5 and Kimi K3 omit `temperature`.
- [ ] Arbitrary ordinary parameters can be added or shallowly replaced.
- [ ] Protected fields and ambiguous rules are rejected.
- [ ] Existing user files are not overwritten.
- [ ] All four Provider methods consume the same resolver.
- [ ] One Adapter retains one snapshot across a tool loop.
- [ ] “测试连接” source remains unchanged.
- [ ] Focused tests, full server tests, TypeScript, lint, and sidecar build have fresh passing evidence.
