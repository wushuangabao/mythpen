const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  FAULT_POINTS,
  createFixtureOnlyExternalVmArmAction,
  faultPoint,
  withFaults,
} = require('../testing/fault-injection');

function withNativeActivationMode(mode, operation) {
  const buildInfo = require('../build-info');
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: mode,
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  try {
    return operation();
  } finally {
    buildInfo.getBuildInfo = originalGetBuildInfo;
  }
}

function runUntilCrash(options) {
  return require('../testing/crash-harness').runUntilCrash(options);
}

function snapshotCrashScenes() {
  return new Set(
    fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mythpen-crash-')),
  );
}

function newCrashScenes(before) {
  return fs.readdirSync(os.tmpdir()).filter(
    (name) => name.startsWith('mythpen-crash-') && !before.has(name),
  );
}

async function assertCrashRejectedAndClean(t, options, expected) {
  const before = snapshotCrashScenes();
  let leakedScenes = [];
  try {
    await assert.rejects(runUntilCrash(options), expected);
  } finally {
    leakedScenes = newCrashScenes(before);
    t.after(() => {
      for (const name of leakedScenes) {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    });
  }
  assert.deepEqual(leakedScenes, []);
}

function createTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function demoOperation() {
  faultPoint(FAULT_POINTS.DEMO_STEP, { operation: 'demo' });
  return 'ok';
}

test('withFaults throws the configured error only inside its scope', async () => {
  assert.equal(demoOperation(), 'ok');

  await withFaults({
    [FAULT_POINTS.DEMO_STEP]: { throw: 'EIO' },
  }, async () => {
    assert.throws(
      () => demoOperation(),
      (error) => (
        error.code === 'EIO'
        && error.faultPoint === FAULT_POINTS.DEMO_STEP
        && error.context.operation === 'demo'
      ),
    );
  });

  assert.equal(demoOperation(), 'ok');
});

test('withFaults can arm a fault only after a marker file exists', async (t) => {
  const scene = createTempDir(t, 'mythpen-fault-arm-');
  const markerPath = path.join(scene, 'shutdown.arm');

  await withFaults({
    [FAULT_POINTS.DEMO_STEP]: {
      throw: 'ARMED_EIO',
      whenFileExists: markerPath,
    },
  }, async () => {
    assert.equal(demoOperation(), 'ok');
    fs.writeFileSync(markerPath, 'armed', { flag: 'wx' });
    assert.throws(() => demoOperation(), { code: 'ARMED_EIO' });
  });
});

test('fixture-only external VM arm actions select immutable exact data contexts', { concurrency: false }, async (t) => {
  const publisherReturned = new Error('publisher returned');
  const markerPath = path.join(createTempDir(t, 'mythpen-external-vm-arm-'), 'armed');
  const selector = {
    booleanValue: true,
    count: 2,
    nullValue: null,
    operation: 'demo',
  };
  const publishedContexts = [];
  const publish = (context) => {
    publishedContexts.push(context);
    throw publisherReturned;
  };

  withNativeActivationMode('off', () => {
    assert.throws(
      () => createFixtureOnlyExternalVmArmAction({ publish }),
      /fixture_only compiled probe/i,
    );
  });

  const invalidOptions = [
    {},
    { whenContextEquals: { operation: 'demo' } },
    { publish, unexpected: true },
    { publish, whenFileExists: '' },
    { publish, whenContextEquals: undefined },
  ];
  const accessorSelector = {};
  let accessorReads = 0;
  Object.defineProperty(accessorSelector, 'operation', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'demo';
    },
  });
  const nonEnumerableSelector = {};
  Object.defineProperty(nonEnumerableSelector, 'operation', {
    enumerable: false,
    value: 'demo',
  });
  let proxyGetCalls = 0;
  const proxySelector = new Proxy({ operation: 'demo' }, {
    get() {
      proxyGetCalls += 1;
      throw new Error('selector proxy get trap');
    },
  });
  const invalidSelectors = [
    {},
    null,
    [],
    Object.assign(Object.create(null), { operation: 'demo' }),
    Object.assign(Object.create({ inherited: true }), { operation: 'demo' }),
    accessorSelector,
    nonEnumerableSelector,
    { [Symbol('operation')]: 'demo' },
    { operation: { nested: true } },
    { operation: ['demo'] },
    { operation: undefined },
    { operation: 1n },
    { operation: Symbol('demo') },
    { operation() {} },
    { count: Number.NaN },
    { count: Number.POSITIVE_INFINITY },
    { count: Number.NEGATIVE_INFINITY },
    proxySelector,
  ];

  withNativeActivationMode('fixture_only', () => {
    assert.equal(
      Object.isFrozen(createFixtureOnlyExternalVmArmAction({ publish })),
      true,
    );
    assert.equal(
      Object.isFrozen(createFixtureOnlyExternalVmArmAction({ publish, whenFileExists: markerPath })),
      true,
    );
    assert.equal(
      Object.isFrozen(createFixtureOnlyExternalVmArmAction({
        publish,
        whenContextEquals: { operation: 'demo' },
      })),
      true,
    );
    for (const options of invalidOptions) {
      assert.throws(() => createFixtureOnlyExternalVmArmAction(options), TypeError);
    }
    for (const invalidSelector of invalidSelectors) {
      assert.throws(
        () => createFixtureOnlyExternalVmArmAction({ publish, whenContextEquals: invalidSelector }),
        TypeError,
      );
    }
  });
  assert.equal(accessorReads, 0);
  assert.equal(proxyGetCalls, 0);

  const action = withNativeActivationMode('fixture_only', () => (
    createFixtureOnlyExternalVmArmAction({
      publish,
      whenContextEquals: selector,
      whenFileExists: markerPath,
    })
  ));
  assert.equal(Object.isFrozen(action), true);
  assert.equal(Object.isFrozen(action.whenContextEquals), true);
  assert.notEqual(action.whenContextEquals, selector);
  assert.deepEqual(action.whenContextEquals, {
    booleanValue: true,
    count: 2,
    nullValue: null,
    operation: 'demo',
  });

  selector.operation = 'changed-after-create';
  await withFaults({ [FAULT_POINTS.DEMO_STEP]: action }, async () => {
    const matchingContext = {
      booleanValue: true,
      count: 2,
      extra: 'allowed',
      nullValue: null,
      operation: 'demo',
    };
    assert.equal(faultPoint(FAULT_POINTS.DEMO_STEP, matchingContext), false);
    fs.writeFileSync(markerPath, 'armed', { flag: 'wx' });
    assert.equal(faultPoint(FAULT_POINTS.DEMO_STEP, {
      ...matchingContext,
      operation: 'other',
    }), false);
    assert.throws(
      () => faultPoint(FAULT_POINTS.DEMO_STEP, matchingContext),
      (error) => error === publisherReturned,
    );
  });
  assert.deepEqual(publishedContexts, [{
    booleanValue: true,
    count: 2,
    extra: 'allowed',
    nullValue: null,
    operation: 'demo',
  }]);
});

test('withFaults restores the outer fault map after nested scopes and rejection', async () => {
  await withFaults({
    [FAULT_POINTS.DEMO_STEP]: { throw: 'OUTER' },
  }, async () => {
    await assert.rejects(
      withFaults({
        [FAULT_POINTS.DEMO_STEP]: { throw: 'INNER' },
      }, async () => {
        demoOperation();
      }),
      { code: 'INNER' },
    );

    assert.throws(() => demoOperation(), { code: 'OUTER' });
  });

  assert.equal(demoOperation(), 'ok');
});

test('inactive faultPoint remains a sub-microsecond fast path', () => {
  const iterations = 1_000_000;
  for (let index = 0; index < 10_000; index += 1) {
    faultPoint(FAULT_POINTS.DEMO_STEP);
  }

  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    faultPoint(FAULT_POINTS.DEMO_STEP);
  }
  const elapsedNanoseconds = Number(process.hrtime.bigint() - startedAt);
  const nanosecondsPerCall = elapsedNanoseconds / iterations;

  assert.ok(
    nanosecondsPerCall < 1_000,
    `inactive faultPoint took ${nanosecondsPerCall.toFixed(1)} ns/call`,
  );
});

test('runUntilCrash preserves the pre-rename filesystem scene for the parent', async (t) => {
  const crash = await runUntilCrash({
    script: path.join(__dirname, 'fixtures', 'crash-demo.js'),
    faults: { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { crash: true } },
  });
  t.after(() => crash.cleanup());

  assert.equal(crash.signal, 'SIGKILL');
  assert.equal(crash.crashPoint.name, FAULT_POINTS.DEMO_AFTER_TEMP_WRITE);
  if (process.platform === 'win32') {
    assert.equal(crash.observedSignal, null);
    assert.equal(Number.isInteger(crash.status), true);
  } else {
    assert.equal(crash.observedSignal, 'SIGKILL');
    assert.equal(crash.status, null);
  }
  assert.equal(fs.existsSync(crash.artifacts.tempPath), true);
  assert.equal(fs.readFileSync(crash.artifacts.tempPath, 'utf8'), 'candidate');
  assert.equal(fs.existsSync(crash.artifacts.targetPath), false);
});

test('runUntilCrash rejects forged crash markers followed by exit 0 or exit 1', async (t) => {
  for (const exitCode of [0, 1]) {
    await assertCrashRejectedAndClean(t, {
      script: path.join(__dirname, 'fixtures', 'crash-demo.js'),
      faults: { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { crash: true } },
      env: { MYTHPEN_CRASH_DEMO_FAKE_MARKER_EXIT_CODE: String(exitCode) },
    }, /authentic crash marker|raw exit/i);
  }
});

test('runUntilCrash rejects a full-valid copied-token marker followed by ordinary exit 1', async (t) => {
  await assertCrashRejectedAndClean(t, {
    script: path.join(__dirname, 'fixtures', 'crash-demo.js'),
    faults: { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { crash: true } },
    env: {
      MYTHPEN_CRASH_DEMO_COPY_MARKER_TOKEN: '1',
      MYTHPEN_CRASH_DEMO_FAKE_MARKER_EXIT_CODE: '1',
    },
  }, /authentic crash marker|raw exit/i);
});

test('runUntilCrash validates marker schema, configured action, pid, signal, and raw exit', async (t) => {
  const fixture = path.join(__dirname, 'fixtures', 'crash-demo.js');
  const crashFaults = { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { crash: true } };
  const cases = [
    {
      expected: /schema/i,
      faults: crashFaults,
      overrides: { MYTHPEN_CRASH_DEMO_FAKE_MARKER_SHAPE: 'array' },
    },
    {
      expected: /configured crash fault/i,
      faults: crashFaults,
      overrides: { MYTHPEN_CRASH_DEMO_FAKE_MARKER_NAME: FAULT_POINTS.DEMO_STEP },
    },
    {
      expected: /configured crash fault/i,
      faults: { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { throw: 'EIO' } },
      overrides: {},
    },
    {
      expected: /pid/i,
      faults: crashFaults,
      overrides: { MYTHPEN_CRASH_DEMO_FAKE_MARKER_PID_OFFSET: '1' },
    },
    {
      expected: /signal/i,
      faults: crashFaults,
      overrides: { MYTHPEN_CRASH_DEMO_FAKE_MARKER_SIGNAL: 'SIGTERM' },
    },
    {
      expected: /raw exit/i,
      faults: crashFaults,
      overrides: { MYTHPEN_CRASH_DEMO_FAKE_MARKER_EXIT_CODE: '0' },
    },
  ];

  for (const { expected, faults, overrides } of cases) {
    await assertCrashRejectedAndClean(t, {
      script: fixture,
      faults,
      env: {
        MYTHPEN_CRASH_DEMO_COPY_MARKER_TOKEN: '1',
        MYTHPEN_CRASH_DEMO_FAKE_MARKER_EXIT_CODE: '1',
        ...overrides,
      },
    }, expected);
  }
});

test('faultPoint crash survives circular and BigInt context serialization', async (t) => {
  for (const contextMode of ['circular', 'bigint']) {
    const crash = await runUntilCrash({
      script: path.join(__dirname, 'fixtures', 'crash-demo.js'),
      faults: { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { crash: true } },
      env: { MYTHPEN_CRASH_DEMO_CONTEXT_MODE: contextMode },
    });
    t.after(() => crash.cleanup());

    assert.equal(crash.signal, 'SIGKILL');
    if (contextMode === 'circular') {
      assert.equal(crash.crashPoint.context.self, '[Circular]');
    } else {
      assert.equal(crash.crashPoint.context.value, '42n');
    }
  }
});

test('runUntilCrash rejects and cleans a child that exits without a crash marker', async (t) => {
  await assertCrashRejectedAndClean(t, {
    script: path.join(__dirname, 'fixtures', 'crash-demo.js'),
    faults: {},
  }, /crash marker/i);
});

test('runUntilCrash does not misclassify or leak an ordinary exit 1', async (t) => {
  await assertCrashRejectedAndClean(t, {
    script: path.join(__dirname, 'fixtures', 'crash-demo.js'),
    faults: {},
    env: { MYTHPEN_CRASH_DEMO_EXIT_CODE: '1' },
  }, /crash marker/i);
});

test('runUntilCrash waits for timeout child death and cleans its scene before rejecting', async (t) => {
  const observerDir = createTempDir(t, 'mythpen-crash-observer-');
  const pidPath = path.join(observerDir, 'pid.txt');
  const before = snapshotCrashScenes();

  await assert.rejects(
    runUntilCrash({
      script: path.join(__dirname, 'fixtures', 'crash-demo.js'),
      faults: {},
      env: {
        MYTHPEN_CRASH_DEMO_DELAY_EXIT_MS: '5000',
        MYTHPEN_CRASH_DEMO_PID_PATH: pidPath,
      },
      timeoutMs: 1000,
    }),
    /timed out after 1000ms/i,
  );

  const childPid = Number(fs.readFileSync(pidPath, 'utf8'));
  assert.equal(Number.isSafeInteger(childPid), true);
  assert.equal(isProcessAlive(childPid), false);
  assert.deepEqual(newCrashScenes(before), []);
});

test('runUntilCrash rejects malformed marker and artifacts while cleaning scenes', async (t) => {
  const fixture = path.join(__dirname, 'fixtures', 'crash-demo.js');

  await assertCrashRejectedAndClean(t, {
    script: fixture,
    faults: { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { crash: true } },
    env: { MYTHPEN_CRASH_DEMO_MALFORMED_MARKER: '1' },
  }, /crash marker/i);

  await assertCrashRejectedAndClean(t, {
    script: fixture,
    faults: { [FAULT_POINTS.DEMO_AFTER_TEMP_WRITE]: { crash: true } },
    env: { MYTHPEN_CRASH_DEMO_MALFORMED_ARTIFACTS: '1' },
  }, /artifacts/i);
});

test('runUntilCrash cleans its scene when spawning fails synchronously', async (t) => {
  const before = snapshotCrashScenes();
  const harnessPath = require.resolve('../testing/crash-harness');
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = () => {
    const error = new Error('spawn blocked');
    error.code = 'EPERM';
    throw error;
  };
  delete require.cache[harnessPath];

  try {
    const failingRunUntilCrash = require('../testing/crash-harness').runUntilCrash;
    await assert.rejects(
      failingRunUntilCrash({ script: __filename, faults: {} }),
      { code: 'EPERM' },
    );
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[harnessPath];
  }

  const after = newCrashScenes(before);
  t.after(() => {
    for (const name of after) {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  });
  assert.deepEqual(after, []);
});
