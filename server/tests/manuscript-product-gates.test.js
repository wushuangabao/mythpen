'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createManuscriptProductGates } = require('../manuscript/product-gates');

const JOURNAL_ID = '11111111-1111-4111-8111-111111111111';
const LOGICAL_REQUEST_ID = 'logical-request-9d';
const PROJECTED_AT = '2026-08-18T01:02:03.004Z';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function turnContext({
  fileSnapshot = deepFreeze({ snapshot: { generation: 7 } }),
  logicalRequestId = LOGICAL_REQUEST_ID,
  overrides = {},
} = {}) {
  return deepFreeze({
    journalId: JOURNAL_ID,
    logicalRequestId,
    projectedAt: PROJECTED_AT,
    currentProjection: { generation: 7, connectionEpoch: 3, basisDigest: 'a'.repeat(64) },
    fileSnapshot,
    ignoredLedger: [{ ignoredUid: 'ignored-a', projectionGeneration: 7 }],
    ...overrides,
  });
}

function exactKeys(value, keys) {
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.equal(descriptor.enumerable, true);
    assert.equal(Object.hasOwn(descriptor, 'value'), true);
  }
}

function fixture({
  context = turnContext(),
  admissionImplementation = null,
  writerImplementation = null,
  freshnessError = null,
  captureError = null,
  policyError = null,
  policyResult = Object.freeze({ disposition: 'ALLOWED' }),
  policyInput = Object.freeze({ kind: 'chapter.replace_body' }),
  readableError = null,
  readableResult = Object.freeze({ projection: 'readable' }),
} = {}) {
  const events = [];
  const calls = {
    admission: 0,
    callback: 0,
    capture: 0,
    current: 0,
    policy: 0,
    readable: 0,
    writer: 0,
  };
  const selector = Object.freeze({ project: 'novel-a' });
  const admission = Object.freeze({});
  const writerTurn = Object.freeze({});
  const admissionBrands = new WeakSet([admission]);
  const writerBrands = new WeakMap([[writerTurn, admission]]);
  const writeRequest = Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, policyInput });
  const seen = {};

  const defaultAdmission = async function defaultAdmission(receivedSelector, operation) {
    calls.admission += 1;
    events.push('admission:enter');
    assert.strictEqual(this, projectSessionAdmission);
    assert.strictEqual(receivedSelector, selector);
    const result = await operation(admission);
    events.push('admission:release');
    return result;
  };
  const projectSessionAdmission = {
    async withAdmission(receivedSelector, operation) {
      if (admissionImplementation) {
        return Reflect.apply(
          admissionImplementation,
          this,
          [receivedSelector, operation, admission],
        );
      }
      return Reflect.apply(defaultAdmission, this, [receivedSelector, operation]);
    },
  };

  const defaultWriter = async function defaultWriter(receivedAdmission, operation) {
    calls.writer += 1;
    events.push('writer:enter');
    assert.strictEqual(this, writerTurns);
    assert.equal(admissionBrands.has(receivedAdmission), true);
    const result = await operation(writerTurn);
    events.push('writer:release');
    return result;
  };
  const writerTurns = {
    async withWriterTurn(receivedAdmission, operation) {
      if (writerImplementation) {
        return Reflect.apply(
          writerImplementation,
          this,
          [receivedAdmission, operation, writerTurn],
        );
      }
      return Reflect.apply(defaultWriter, this, [receivedAdmission, operation]);
    },
  };

  const freshness = {
    async ensureProjectionCurrent(receivedAdmission, receivedTurn) {
      calls.current += 1;
      events.push('freshness:current');
      assert.strictEqual(this, freshness);
      assert.equal(admissionBrands.has(receivedAdmission), true);
      assert.strictEqual(writerBrands.get(receivedTurn), receivedAdmission);
      if (freshnessError) throw freshnessError;
    },
    async ensureReadableProjection(receivedAdmission, query) {
      calls.readable += 1;
      events.push('freshness:readable');
      assert.strictEqual(this, freshness);
      assert.equal(admissionBrands.has(receivedAdmission), true);
      seen.query = query;
      if (readableError) throw readableError;
      return readableResult;
    },
  };

  const turnContextSource = {
    async capture(input) {
      calls.capture += 1;
      events.push('context:capture');
      assert.strictEqual(this, turnContextSource);
      exactKeys(input, ['admission', 'writerTurn', 'logicalRequestId']);
      assert.equal(Object.isFrozen(input), true);
      assert.strictEqual(input.admission, admission);
      assert.strictEqual(input.writerTurn, writerTurn);
      assert.equal(input.logicalRequestId, LOGICAL_REQUEST_ID);
      seen.captureInput = input;
      if (captureError) throw captureError;
      return context;
    },
  };

  const policy = {
    async authorizeWrite(input) {
      calls.policy += 1;
      events.push('policy:authorize');
      assert.strictEqual(this, policy);
      exactKeys(input, ['admission', 'writerTurn', 'policyInput', 'turnContext']);
      assert.equal(Object.isFrozen(input), true);
      assert.strictEqual(input.admission, admission);
      assert.strictEqual(input.writerTurn, writerTurn);
      assert.strictEqual(input.policyInput, policyInput);
      assert.strictEqual(input.turnContext, context);
      seen.policyInput = input;
      if (policyError) throw policyError;
      return policyResult;
    },
  };

  const ports = {
    projectSessionAdmission,
    writerTurns,
    freshness,
    turnContextSource,
    policy,
  };

  return {
    admission,
    calls,
    context,
    events,
    gates: createManuscriptProductGates(ports),
    policyInput,
    ports,
    readableResult,
    seen,
    selector,
    writeRequest,
    writerTurn,
  };
}

function invalidPortVariants(valid, methods) {
  const variants = [null, {}, Object.create(valid), { ...valid, extra() {} }];
  for (const method of methods) {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, method, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return valid[method];
      },
    });
    for (const other of methods) {
      if (other !== method) accessor[other] = valid[other];
    }
    variants.push({ value: accessor, getterCalls: () => getterCalls });
  }
  return variants;
}

test('factory validates five exact own-data method ports before any lifecycle side effect', () => {
  const baseline = fixture();
  const sideEffectsBefore = { ...baseline.calls };
  exactKeys(baseline.gates, [
    'withCurrentManuscriptWriteTurn',
    'withReadableManuscriptProjection',
  ]);
  assert.equal(Object.isFrozen(baseline.gates), true);

  const { policy: _omittedPolicy, ...missingPolicy } = baseline.ports;
  assert.throws(() => createManuscriptProductGates(missingPolicy), TypeError);
  assert.throws(() => createManuscriptProductGates({ ...baseline.ports, extra: {} }), TypeError);
  const optionsGetter = { ...baseline.ports };
  let optionsGetterCalls = 0;
  Object.defineProperty(optionsGetter, 'policy', {
    enumerable: true,
    get() {
      optionsGetterCalls += 1;
      return baseline.ports.policy;
    },
  });
  assert.throws(() => createManuscriptProductGates(optionsGetter), TypeError);
  assert.equal(optionsGetterCalls, 0);

  const surfaces = [
    ['projectSessionAdmission', ['withAdmission']],
    ['writerTurns', ['withWriterTurn']],
    ['freshness', ['ensureProjectionCurrent', 'ensureReadableProjection']],
    ['turnContextSource', ['capture']],
    ['policy', ['authorizeWrite']],
  ];
  for (const [name, methods] of surfaces) {
    for (const variant of invalidPortVariants(baseline.ports[name], methods)) {
      const value = variant?.value || variant;
      assert.throws(
        () => createManuscriptProductGates({ ...baseline.ports, [name]: value }),
        TypeError,
        `${name} must reject an inexact surface`,
      );
      if (variant?.getterCalls) assert.equal(variant.getterCalls(), 0);
    }
  }
  assert.deepEqual(baseline.calls, sideEffectsBefore);
});

test('write turn preserves authority identity and the only allowed order through reverse release', async () => {
  const current = fixture();
  const result = Object.freeze({ state: 'complete' });
  const returned = await current.gates.withCurrentManuscriptWriteTurn(
    current.selector,
    current.writeRequest,
    async (receivedContext) => {
      current.calls.callback += 1;
      current.events.push('callback');
      assert.strictEqual(receivedContext, current.context);
      assert.strictEqual(receivedContext.fileSnapshot, current.context.fileSnapshot);
      return result;
    },
  );

  assert.strictEqual(returned, result);
  assert.deepEqual(current.events, [
    'admission:enter',
    'writer:enter',
    'freshness:current',
    'context:capture',
    'policy:authorize',
    'callback',
    'writer:release',
    'admission:release',
  ]);
  assert.deepEqual(current.calls, {
    admission: 1,
    callback: 1,
    capture: 1,
    current: 1,
    policy: 1,
    readable: 0,
    writer: 1,
  });
});

test('writeRequest is an exact frozen own-data envelope and never evaluates policyInput', async () => {
  let getterCalls = 0;
  const hostilePolicyInput = Object.freeze(Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('must not evaluate policy input');
    },
  }));
  const current = fixture({ policyInput: hostilePolicyInput });
  await current.gates.withCurrentManuscriptWriteTurn(
    current.selector,
    current.writeRequest,
    (context) => context,
  );
  assert.equal(getterCalls, 0);

  const accessor = {};
  Object.defineProperty(accessor, 'logicalRequestId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return LOGICAL_REQUEST_ID;
    },
  });
  accessor.policyInput = current.policyInput;
  Object.freeze(accessor);
  const withSymbol = Object.freeze({
    logicalRequestId: LOGICAL_REQUEST_ID,
    policyInput: current.policyInput,
    [Symbol('extra')]: true,
  });
  const inherited = Object.freeze(Object.assign(
    Object.create({ logicalRequestId: LOGICAL_REQUEST_ID }),
    { policyInput: current.policyInput },
  ));
  const invalid = [
    { logicalRequestId: LOGICAL_REQUEST_ID, policyInput: current.policyInput },
    Object.freeze({ logicalRequestId: '', policyInput: current.policyInput }),
    Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, policyInput: current.policyInput, extra: true }),
    accessor,
    withSymbol,
    inherited,
  ];
  const before = current.calls.admission;
  for (const request of invalid) {
    await assert.rejects(
      current.gates.withCurrentManuscriptWriteTurn(current.selector, request, () => {}),
      TypeError,
    );
  }
  await assert.rejects(
    current.gates.withCurrentManuscriptWriteTurn(current.selector, current.writeRequest, null),
    TypeError,
  );
  assert.equal(current.calls.admission, before);
  assert.equal(getterCalls, 0);
});

test('context source must return the exact deeply frozen canonical six-key turn context', async () => {
  let getterCalls = 0;
  const valid = turnContext();
  const accessor = { ...valid };
  Object.defineProperty(accessor, 'journalId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return JOURNAL_ID;
    },
  });
  Object.freeze(accessor);
  const shallowNested = Object.freeze({
    ...valid,
    currentProjection: { generation: 7 },
  });
  const cases = [
    Object.freeze({ ...valid, extra: true }),
    accessor,
    Object.freeze({ ...valid, journalId: 'NOT-A-UUID' }),
    Object.freeze({ ...valid, projectedAt: '2026-08-18T01:02:03Z' }),
    turnContext({ logicalRequestId: 'different-request' }),
    shallowNested,
    { ...valid },
  ];

  for (const context of cases) {
    const current = fixture({ context });
    await assert.rejects(
      current.gates.withCurrentManuscriptWriteTurn(
        current.selector,
        current.writeRequest,
        () => { current.calls.callback += 1; },
      ),
      TypeError,
    );
    assert.equal(current.calls.policy, 0);
    assert.equal(current.calls.callback, 0);
  }
  assert.equal(getterCalls, 0);
});

test('policy accepts only exact frozen ALLOWED and short-circuits the domain callback', async () => {
  const policyError = new Error('policy conflict persisted');
  const getterResult = {};
  let getterCalls = 0;
  Object.defineProperty(getterResult, 'disposition', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'ALLOWED';
    },
  });
  Object.freeze(getterResult);
  const cases = [
    { result: Object.freeze({ disposition: 'DENIED' }), expected: TypeError },
    { result: Object.freeze({ disposition: 'ALLOWED', extra: true }), expected: TypeError },
    { result: { disposition: 'ALLOWED' }, expected: TypeError },
    { result: true, expected: TypeError },
    { result: getterResult, expected: TypeError },
    { error: policyError, expected: (error) => error === policyError },
  ];
  for (const entry of cases) {
    const current = fixture({ policyResult: entry.result, policyError: entry.error });
    await assert.rejects(
      current.gates.withCurrentManuscriptWriteTurn(
        current.selector,
        current.writeRequest,
        () => { current.calls.callback += 1; },
      ),
      entry.expected,
    );
    assert.equal(current.calls.callback, 0);
  }
  assert.equal(getterCalls, 0);
});

test('admission, writer, freshness, context, and policy failures stop every later stage and preserve identity', async () => {
  const stages = [
    {
      name: 'admission',
      build(error) {
        return fixture({
          admissionImplementation: async function failAdmission() { throw error; },
        });
      },
      expected: { writer: 0, current: 0, capture: 0, policy: 0, callback: 0 },
    },
    {
      name: 'writer',
      build(error) {
        return fixture({
          writerImplementation: async function failWriter() { throw error; },
        });
      },
      expected: { current: 0, capture: 0, policy: 0, callback: 0 },
    },
    {
      name: 'freshness',
      build: (error) => fixture({ freshnessError: error }),
      expected: { capture: 0, policy: 0, callback: 0 },
    },
    {
      name: 'context',
      build: (error) => fixture({ captureError: error }),
      expected: { policy: 0, callback: 0 },
    },
    {
      name: 'policy',
      build: (error) => fixture({ policyError: error }),
      expected: { callback: 0 },
    },
  ];

  for (const stage of stages) {
    const error = new Error(`${stage.name} failed`);
    const current = stage.build(error);
    let publicationCandidates = 0;
    await assert.rejects(
      current.gates.withCurrentManuscriptWriteTurn(
        current.selector,
        current.writeRequest,
        () => {
          current.calls.callback += 1;
          publicationCandidates += 1;
        },
      ),
      (actual) => actual === error,
    );
    for (const [name, expected] of Object.entries(stage.expected)) {
      assert.equal(current.calls[name], expected, `${stage.name} must stop ${name}`);
    }
    assert.equal(publicationCandidates, 0, `${stage.name} must create no publication candidate`);
  }
});

test('duplicate or missing admission/writer callbacks fail closed before a second freshness or domain call', async () => {
  const duplicateAdmission = fixture({
    admissionImplementation: async function twice(_selector, operation, admission) {
      const first = await operation(admission);
      try {
        await operation(admission);
      } catch {
        // Deliberately swallow the duplicate error; the gate must still notice the count.
      }
      return first;
    },
  });
  await assert.rejects(
    duplicateAdmission.gates.withCurrentManuscriptWriteTurn(
      duplicateAdmission.selector,
      duplicateAdmission.writeRequest,
      () => { duplicateAdmission.calls.callback += 1; },
    ),
    TypeError,
  );
  assert.equal(duplicateAdmission.calls.current, 1);
  assert.equal(duplicateAdmission.calls.callback, 1);

  const duplicateWriter = fixture({
    writerImplementation: async function twice(_admission, operation, writerTurn) {
      const first = await operation(writerTurn);
      try {
        await operation(writerTurn);
      } catch {
        // The second writer callback must be rejected before freshness.
      }
      return first;
    },
  });
  await assert.rejects(
    duplicateWriter.gates.withCurrentManuscriptWriteTurn(
      duplicateWriter.selector,
      duplicateWriter.writeRequest,
      () => { duplicateWriter.calls.callback += 1; },
    ),
    TypeError,
  );
  assert.equal(duplicateWriter.calls.current, 1);
  assert.equal(duplicateWriter.calls.callback, 1);

  for (const current of [
    fixture({ admissionImplementation: async () => Object.freeze({ skipped: true }) }),
    fixture({ writerImplementation: async () => Object.freeze({ skipped: true }) }),
  ]) {
    await assert.rejects(
      current.gates.withCurrentManuscriptWriteTurn(
        current.selector,
        current.writeRequest,
        () => { current.calls.callback += 1; },
      ),
      TypeError,
    );
    assert.equal(current.calls.callback, 0);
  }
});

test('an admission callback first invoked after its port settled is revoked before writer or domain work', async () => {
  let savedCallback;
  const current = fixture({
    admissionImplementation: async function returnWithoutCallback(_selector, operation) {
      savedCallback = operation;
      return Object.freeze({ skipped: true });
    },
  });
  await assert.rejects(
    current.gates.withCurrentManuscriptWriteTurn(
      current.selector,
      current.writeRequest,
      () => { current.calls.callback += 1; },
    ),
    TypeError,
  );
  assert.equal(current.calls.writer, 0);
  assert.equal(current.calls.current, 0);
  assert.equal(current.calls.callback, 0);

  await assert.rejects(savedCallback(current.admission), TypeError);
  assert.equal(current.calls.writer, 0);
  assert.equal(current.calls.current, 0);
  assert.equal(current.calls.callback, 0);
});

test('a writer callback first invoked after its port settled is revoked before freshness or domain work', async () => {
  let savedCallback;
  const current = fixture({
    writerImplementation: async function returnWithoutCallback(_admission, operation) {
      savedCallback = operation;
      return Object.freeze({ skipped: true });
    },
  });
  await assert.rejects(
    current.gates.withCurrentManuscriptWriteTurn(
      current.selector,
      current.writeRequest,
      () => { current.calls.callback += 1; },
    ),
    TypeError,
  );
  assert.equal(current.calls.current, 0);
  assert.equal(current.calls.capture, 0);
  assert.equal(current.calls.policy, 0);
  assert.equal(current.calls.callback, 0);

  await assert.rejects(savedCallback(current.writerTurn), TypeError);
  assert.equal(current.calls.current, 0);
  assert.equal(current.calls.capture, 0);
  assert.equal(current.calls.policy, 0);
  assert.equal(current.calls.callback, 0);
});

test('callback boundary leaves pre-stage failures at zero candidates and post-stage failures recoverable', async () => {
  const beforeError = new Error('domain rejected before stageAssets');
  const before = fixture();
  let beforeCandidates = 0;
  const beforeJournal = Object.freeze({
    stageAssets() {
      beforeCandidates += 1;
    },
  });
  await assert.rejects(
    before.gates.withCurrentManuscriptWriteTurn(
      before.selector,
      before.writeRequest,
      async () => {
        before.calls.callback += 1;
        assert.equal(typeof beforeJournal.stageAssets, 'function');
        throw beforeError;
      },
    ),
    (error) => error === beforeError,
  );
  assert.equal(beforeCandidates, 0);

  const afterError = new Error('publish failed after stageAssets');
  const after = fixture();
  let candidates = 0;
  let rollbacks = 0;
  const l2Service = Object.freeze({
    async execute(_command, receivedContext) {
      assert.strictEqual(receivedContext, after.context);
      candidates += 1; // Models FilePublicationJournal.stageAssets().
      throw afterError;
    },
  });
  await assert.rejects(
    after.gates.withCurrentManuscriptWriteTurn(
      after.selector,
      after.writeRequest,
      async (receivedContext) => {
        after.calls.callback += 1;
        return l2Service.execute(Object.freeze({ kind: 'chapter.replace_body' }), receivedContext);
      },
    ),
    (error) => error === afterError,
  );
  assert.equal(candidates, 1);
  assert.equal(rollbacks, 0);
  assert.equal(after.calls.callback, 1);
});

test('opaque file snapshot is passed by identity and a downstream Store brand rejects its clone', async () => {
  const brandedSnapshot = turnContext().fileSnapshot;
  const storeBrands = new WeakSet([brandedSnapshot]);
  const accepted = fixture({ context: turnContext({ fileSnapshot: brandedSnapshot }) });
  await accepted.gates.withCurrentManuscriptWriteTurn(
    accepted.selector,
    accepted.writeRequest,
    (context) => {
      accepted.calls.callback += 1;
      assert.equal(storeBrands.has(context.fileSnapshot), true);
    },
  );

  const clonedSnapshot = deepFreeze({ ...brandedSnapshot });
  const rejected = fixture({ context: turnContext({ fileSnapshot: clonedSnapshot }) });
  await assert.rejects(
    rejected.gates.withCurrentManuscriptWriteTurn(
      rejected.selector,
      rejected.writeRequest,
      (context) => {
        rejected.calls.callback += 1;
        if (!storeBrands.has(context.fileSnapshot)) throw new TypeError('foreign Store snapshot');
      },
    ),
    TypeError,
  );
  assert.equal(rejected.calls.callback, 1);
});

test('readable wrapper uses only admission plus freshness and propagates the exact result and error', async () => {
  const current = fixture();
  const query = Object.freeze({ kind: 'outline' });
  const result = await current.gates.withReadableManuscriptProjection(current.selector, query);
  assert.strictEqual(result, current.readableResult);
  assert.strictEqual(current.seen.query, query);
  assert.deepEqual(current.events, [
    'admission:enter',
    'freshness:readable',
    'admission:release',
  ]);
  assert.equal(current.calls.writer, 0);
  assert.equal(current.calls.current, 0);
  assert.equal(current.calls.capture, 0);
  assert.equal(current.calls.policy, 0);

  const readError = new Error('read freshness failed');
  const failed = fixture({ readableError: readError });
  await assert.rejects(
    failed.gates.withReadableManuscriptProjection(failed.selector, query),
    (error) => error === readError,
  );
  assert.equal(failed.calls.readable, 1);
  assert.equal(failed.calls.writer, 0);
});

test('cloned gate methods have no factory brand and cannot reach lifecycle ports', async () => {
  const current = fixture();
  const clone = { ...current.gates };
  await assert.rejects(
    clone.withCurrentManuscriptWriteTurn(
      current.selector,
      current.writeRequest,
      () => { current.calls.callback += 1; },
    ),
    TypeError,
  );
  await assert.rejects(
    clone.withReadableManuscriptProjection(current.selector, Object.freeze({ kind: 'outline' })),
    TypeError,
  );
  assert.equal(current.calls.admission, 0);
  assert.equal(current.calls.callback, 0);
  assert.equal(current.calls.readable, 0);
});
