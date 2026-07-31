const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_AI_REQUEST_PARAMETER_CONFIG,
  createRequestParameterConfigLoader,
  validateRequestParameterConfig,
  resolveRequestBody,
} = require('../ai-request-parameters');

const MAX_CONFIG_BYTES = 1_048_576;

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-${label}-`));
}

function writeConfig(filePath, config) {
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function fsApiWith(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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

test('trailing slash model IDs do not match a different trailing slash model', () => {
  const config = validateRequestParameterConfig({
    version: 1,
    defaults: {},
    models: [{
      name: 'Invalid Tail Match',
      match: { models: ['vendor/'], apiTypes: ['openai'] },
      params: { should_not_apply: true },
    }],
  });

  assert.deepEqual(resolveRequestBody(config, {
    baseBody: { preserved: true },
    model: 'other/',
    apiType: 'openai',
    operation: 'complete',
  }), {
    preserved: true,
  });
});

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

test('loader reads an ordinary file through a bounded descriptor read', () => {
  const directory = tempDir('ai-request-bounded-file');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  writeConfig(configPath, {
    version: 1,
    defaults: { params: { bounded_read: true } },
    models: [],
  });
  const readRequests = [];
  let totalBytesRead = 0;
  const fsApi = fsApiWith({
    readFileSync() {
      throw new Error('unbounded path read must not be used');
    },
    readSync(fd, buffer, offset, length, position) {
      readRequests.push({ bufferLength: buffer.length, length });
      const bytesRead = fs.readSync(fd, buffer, offset, length, position);
      totalBytesRead += bytesRead;
      return bytesRead;
    },
  });

  const snapshot = createRequestParameterConfigLoader({ configPath, fsApi }).getSnapshot();

  assert.equal(resolveRequestBody(snapshot, {
    baseBody: {},
    model: 'model',
    apiType: 'openai',
    operation: 'complete',
  }).bounded_read, true);
  assert.ok(readRequests.length > 0);
  assert.ok(readRequests.every(request => (
    request.bufferLength === MAX_CONFIG_BYTES + 1
    && request.length <= MAX_CONFIG_BYTES + 1
  )));
  assert.ok(totalBytesRead <= MAX_CONFIG_BYTES + 1);
});

test('loader rejects a non-regular opened entry and retains the last good snapshot', () => {
  const directory = tempDir('ai-request-non-file');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  writeConfig(configPath, {
    version: 1,
    defaults: { params: { last_good: true } },
    models: [],
  });
  let rejectOpenedEntry = false;
  let readsAfterRejection = 0;
  const warnings = [];
  const fsApi = fsApiWith({
    fstatSync(fd) {
      const stat = fs.fstatSync(fd);
      return rejectOpenedEntry
        ? { ...stat, isFile: () => false }
        : stat;
    },
    readSync(...arguments_) {
      if (rejectOpenedEntry) readsAfterRejection += 1;
      return fs.readSync(...arguments_);
    },
  });
  const loader = createRequestParameterConfigLoader({
    configPath,
    fsApi,
    logger: { warn: message => warnings.push(message) },
  });
  const lastGood = loader.getSnapshot();

  writeConfig(configPath, {
    version: 1,
    defaults: { params: { should_not_load: true } },
    models: [],
  });
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, changed, changed);
  rejectOpenedEntry = true;

  assert.equal(loader.getSnapshot(), lastGood);
  assert.equal(loader.getSnapshot(), lastGood);
  assert.equal(readsAfterRejection, 0);
  assert.equal(warnings.length, 1);
});

test('loader rejects a file larger than 1 MiB without reading it', () => {
  const directory = tempDir('ai-request-oversized');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  writeConfig(configPath, {
    version: 1,
    defaults: { params: { last_good: true } },
    models: [],
  });
  let boundedReadCalls = 0;
  const warnings = [];
  const fsApi = fsApiWith({
    readSync(...arguments_) {
      boundedReadCalls += 1;
      return fs.readSync(...arguments_);
    },
  });
  const loader = createRequestParameterConfigLoader({
    configPath,
    fsApi,
    logger: { warn: message => warnings.push(message) },
  });
  const lastGood = loader.getSnapshot();

  writeConfig(configPath, {
    version: 1,
    defaults: { params: { oversized: 'x'.repeat(MAX_CONFIG_BYTES) } },
    models: [],
  });
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, changed, changed);
  boundedReadCalls = 0;

  assert.equal(loader.getSnapshot(), lastGood);
  assert.equal(boundedReadCalls, 0);
  assert.equal(warnings.length, 1);
});

test('loader reads at most the limit plus one byte when metadata underreports size', () => {
  const directory = tempDir('ai-request-bounded-overflow');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  writeConfig(configPath, {
    version: 1,
    defaults: { params: { last_good: true } },
    models: [],
  });
  let underreportSize = false;
  let totalBytesRead = 0;
  let largestReadRequest = 0;
  const fsApi = fsApiWith({
    statSync(filePath) {
      const stat = fs.statSync(filePath);
      return underreportSize
        ? { ...stat, size: MAX_CONFIG_BYTES, isFile: () => stat.isFile() }
        : stat;
    },
    fstatSync(fd) {
      const stat = fs.fstatSync(fd);
      return underreportSize
        ? { ...stat, size: MAX_CONFIG_BYTES, isFile: () => stat.isFile() }
        : stat;
    },
    readSync(fd, buffer, offset, length, position) {
      largestReadRequest = Math.max(largestReadRequest, length);
      const bytesRead = fs.readSync(fd, buffer, offset, length, position);
      totalBytesRead += bytesRead;
      return bytesRead;
    },
  });
  const loader = createRequestParameterConfigLoader({ configPath, fsApi, logger: { warn() {} } });
  const lastGood = loader.getSnapshot();

  writeConfig(configPath, {
    version: 1,
    defaults: { params: { oversized: 'x'.repeat(MAX_CONFIG_BYTES) } },
    models: [],
  });
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, changed, changed);
  underreportSize = true;
  totalBytesRead = 0;
  largestReadRequest = 0;

  assert.equal(loader.getSnapshot(), lastGood);
  assert.equal(totalBytesRead, MAX_CONFIG_BYTES + 1);
  assert.ok(largestReadRequest <= MAX_CONFIG_BYTES + 1);
});

test('loader closes the descriptor and retains the last good snapshot after a read error', () => {
  const directory = tempDir('ai-request-read-error');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  writeConfig(configPath, {
    version: 1,
    defaults: { params: { last_good: true } },
    models: [],
  });
  let failRead = false;
  let closedAfterFailure = 0;
  const warnings = [];
  const fsApi = fsApiWith({
    readSync(...arguments_) {
      if (failRead) {
        const error = new Error('permission denied while reading');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readSync(...arguments_);
    },
    closeSync(fd) {
      fs.closeSync(fd);
      if (failRead) closedAfterFailure += 1;
    },
  });
  const loader = createRequestParameterConfigLoader({
    configPath,
    fsApi,
    logger: { warn: message => warnings.push(message) },
  });
  const lastGood = loader.getSnapshot();

  writeConfig(configPath, {
    version: 1,
    defaults: { params: { should_not_load: true } },
    models: [],
  });
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, changed, changed);
  failRead = true;

  assert.equal(loader.getSnapshot(), lastGood);
  assert.equal(loader.getSnapshot(), lastGood);
  assert.equal(closedAfterFailure, 2);
  assert.equal(warnings.length, 1);
});

test('loader rejects a configuration file that changes during its bounded read', () => {
  const directory = tempDir('ai-request-changing-read');
  const configPath = path.join(directory, 'ai-request-parameters.json');
  writeConfig(configPath, {
    version: 1,
    defaults: { params: { last_good: true } },
    models: [],
  });
  let mutateDuringRead = false;
  let mutated = false;
  const warnings = [];
  const fsApi = fsApiWith({
    readSync(...arguments_) {
      const bytesRead = fs.readSync(...arguments_);
      if (mutateDuringRead && !mutated) {
        fs.appendFileSync(configPath, ' ');
        mutated = true;
      }
      return bytesRead;
    },
  });
  const loader = createRequestParameterConfigLoader({
    configPath,
    fsApi,
    logger: { warn: message => warnings.push(message) },
  });
  const lastGood = loader.getSnapshot();

  writeConfig(configPath, {
    version: 1,
    defaults: { params: { should_not_load: true } },
    models: [],
  });
  const changed = new Date(Date.now() + 2000);
  fs.utimesSync(configPath, changed, changed);
  mutateDuringRead = true;

  assert.equal(loader.getSnapshot(), lastGood);
  assert.equal(mutated, true);
  assert.equal(warnings.length, 1);
});
