'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createManuscriptService,
} = require('../manuscript-service');
const {
  createProductWriteFreshness,
} = require('../manuscript/freshness');
const {
  createManuscriptProductGates,
} = require('../manuscript/product-gates');

const DIGEST = 'a'.repeat(64);
const LOGICAL_REQUEST_ID = 'task-14b-product-routing';

function createProductWriteIntents(options) {
  const owner = createManuscriptService(Object.freeze({}), Object.freeze(options));
  return Object.freeze({
    bindL2Command(command) { return owner.bindProductL2Command(command); },
    bindOrphanAction(action, request) {
      return owner.bindProductOrphanAction(action, request);
    },
    authority() { return owner.productWriteIntentAuthority(); },
    execute(intent, turnContext) {
      return owner.executeProductWriteIntent(intent, turnContext);
    },
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

function downstreamFixture({ family = 'non_create', logicalInputDigest = null } = {}) {
  const intents = new WeakMap();
  const calls = { bind: 0, execute: 0 };
  let authority;
  authority = Object.freeze({
    assert(intent) {
      assert.strictEqual(this, authority);
      if (!intents.has(intent)) throw new TypeError('foreign downstream intent');
      return intent;
    },
    describe(intent) {
      this.assert(intent);
      return intents.get(intent).descriptor;
    },
  });
  const service = Object.freeze({
    bindWriteIntent(command) {
      calls.bind += 1;
      const snapshot = Object.freeze({ kind: command.kind, bytes: command.bytes });
      const intent = Object.freeze({});
      intents.set(intent, Object.freeze({
        command: snapshot,
        descriptor: Object.freeze({ family, logicalInputDigest }),
      }));
      return intent;
    },
    writeIntentAuthority() { return authority; },
    execute(intent, turnContext) {
      authority.assert(intent);
      calls.execute += 1;
      return Object.freeze({ command: intents.get(intent).command, turnContext });
    },
  });
  return { authority, calls, service };
}

function orphanFixture() {
  const requests = new WeakSet();
  const prepared = new WeakMap();
  const calls = { snapshot: 0, preflight: 0, publish: 0 };
  const service = Object.freeze({
    snapshotRequest(request) {
      calls.snapshot += 1;
      exactKeys(request, ['kind', 'uid']);
      const snapshot = Object.freeze({ kind: request.kind, uid: request.uid });
      requests.add(snapshot);
      return snapshot;
    },
    async preflightResolution(action, request, baseline) {
      calls.preflight += 1;
      if (!requests.has(request)) throw new TypeError('foreign orphan request');
      const authority = Object.freeze({});
      prepared.set(authority, Object.freeze({ action, baseline, request }));
      return authority;
    },
    publishResolution(authority, projectionContext) {
      calls.publish += 1;
      const record = prepared.get(authority);
      if (!record) throw new TypeError('foreign prepared resolution');
      return Object.freeze({ ...record, projectionContext });
    },
  });
  return { calls, service };
}

test('production write broker preserves original downstream authority and snapshots caller data', async () => {
  assert.equal(
    Object.hasOwn(require('../manuscript-service'), 'createProductionProductWriteIntents'),
    false,
  );
  const l2 = downstreamFixture();
  const orphan = orphanFixture();
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphan.service,
  });
  const authority = broker.authority();
  assert.strictEqual(broker.authority(), authority);
  assert.equal(Object.isFrozen(authority), true);
  exactKeys(authority, ['assert', 'describe']);

  const command = { kind: 'chapter.replace_body', bytes: 'before' };
  const writeIntent = broker.bindL2Command(command);
  command.bytes = 'after';
  assert.deepEqual(authority.describe(writeIntent), Object.freeze({
    family: 'non_create',
    logicalInputDigest: null,
  }));
  const turnContext = Object.freeze({ marker: 'turn' });
  const result = await broker.execute(writeIntent, turnContext);
  assert.deepEqual(result.command, Object.freeze({
    kind: 'chapter.replace_body',
    bytes: 'before',
  }));
  assert.strictEqual(result.turnContext, turnContext);

  const foreign = createProductWriteIntents({
    l2Service: downstreamFixture().service,
    orphanResolutionService: orphanFixture().service,
  });
  assert.throws(() => authority.assert(Object.freeze({ ...writeIntent })), TypeError);
  assert.throws(() => foreign.authority().assert(writeIntent), TypeError);
  await assert.rejects(foreign.execute(writeIntent, turnContext), TypeError);
  assert.deepEqual(l2.calls, { bind: 1, execute: 1 });
});

test('broker captures downstream methods once so a late service swap cannot change dispatch', async () => {
  const l2Fixture = downstreamFixture();
  const orphanServiceFixture = orphanFixture();
  const mutableL2 = { ...l2Fixture.service };
  const mutableOrphan = { ...orphanServiceFixture.service };
  const broker = createProductWriteIntents({
    l2Service: mutableL2,
    orphanResolutionService: mutableOrphan,
  });
  const l2Intent = broker.bindL2Command({ kind: 'chapter.replace_body', bytes: 'original' });
  const orphanIntent = broker.bindOrphanAction('ignore_in_place', {
    kind: 'chapter',
    uid: '11111111-1111-4111-8111-111111111111',
  });
  mutableL2.execute = () => Object.freeze({ swapped: true });
  mutableL2.writeIntentAuthority = () => Object.freeze({
    assert() {},
    describe() { return Object.freeze({ family: 'non_create', logicalInputDigest: null }); },
  });
  mutableOrphan.preflightResolution = () => Object.freeze({ swapped: true });
  mutableOrphan.publishResolution = () => Object.freeze({ swapped: true });

  const ordinary = await broker.execute(l2Intent, Object.freeze({ marker: 'turn' }));
  assert.equal(ordinary.command.bytes, 'original');
  const orphanResult = await broker.execute(orphanIntent, Object.freeze({
    fileSnapshot: Object.freeze({}),
    currentProjection: Object.freeze({ projectUid: 'project' }),
    projectedAt: '2026-08-20T00:00:00.000Z',
  }));
  assert.equal(orphanResult.action, 'ignore_in_place');
  assert.equal(ordinary.swapped, undefined);
  assert.equal(orphanResult.swapped, undefined);
  assert.deepEqual(l2Fixture.calls, { bind: 1, execute: 1 });
  assert.deepEqual(orphanServiceFixture.calls, { snapshot: 1, preflight: 1, publish: 1 });
});

test('broker captures only own data service methods without invoking getters or prototypes', () => {
  const orphan = orphanFixture();
  let getterCalls = 0;
  const poisonL2 = { ...downstreamFixture().service };
  Object.defineProperty(poisonL2, 'execute', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('poisoned l2 execute getter');
    },
  });
  assert.throws(() => createProductWriteIntents({
    l2Service: poisonL2,
    orphanResolutionService: orphan.service,
  }), TypeError);
  assert.equal(getterCalls, 0);

  const inheritedOrphan = Object.create(orphan.service);
  assert.throws(() => createProductWriteIntents({
    l2Service: downstreamFixture().service,
    orphanResolutionService: inheritedOrphan,
  }), TypeError);
});

test('orphan broker accepts only server actions and executes original snapshot through one resolution', async () => {
  const l2 = downstreamFixture();
  const orphan = orphanFixture();
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphan.service,
  });
  const request = { kind: 'chapter', uid: '11111111-1111-4111-8111-111111111111' };
  const intent = broker.bindOrphanAction('ignore_in_place', request);
  request.uid = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(broker.authority().describe(intent), Object.freeze({
    family: 'orphan_resolution',
    logicalInputDigest: null,
  }));
  assert.throws(() => broker.bindOrphanAction('caller_action', request), TypeError);

  const baseline = Object.freeze({ baseline: true });
  const currentProjection = Object.freeze({ projectUid: 'project' });
  const turnContext = Object.freeze({
    fileSnapshot: baseline,
    currentProjection,
    projectedAt: '2026-08-20T00:00:00.000Z',
  });
  const result = await broker.execute(intent, turnContext);
  assert.equal(result.action, 'ignore_in_place');
  assert.equal(result.request.uid, '11111111-1111-4111-8111-111111111111');
  assert.strictEqual(result.baseline, baseline);
  assert.strictEqual(result.projectionContext.currentProjection, currentProjection);
  assert.deepEqual(orphan.calls, { snapshot: 1, preflight: 1, publish: 1 });
  assert.equal(l2.calls.execute, 0);
});

test('product freshness reasserts the same intent before journal work and keeps ordinary FULL-only', async () => {
  const l2 = downstreamFixture();
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphanFixture().service,
  });
  const intent = broker.bindL2Command({ kind: 'chapter.replace_body', bytes: 'body' });
  const calls = { journal: 0, recovery: 0, full: 0, readable: 0 };
  const journalRecovery = {
    lookupCommittedRequest() { return null; },
    lookupOrdinaryRequest(logicalRequestId) {
      calls.journal += 1;
      assert.equal(logicalRequestId, LOGICAL_REQUEST_ID);
      return null;
    },
    async recoverPendingOrdinary(...args) {
      calls.recovery += 1;
      assert.equal(args.length, 0);
    },
  };
  const projectionFreshness = {
    async ensureProjectionCurrent(admission, writerTurn) {
      calls.full += 1;
      assert.equal(admission.name, 'admission');
      assert.equal(writerTurn.name, 'writer');
    },
    async ensureReadableProjection(_admission, query) {
      calls.readable += 1;
      return query;
    },
  };
  const freshness = createProductWriteFreshness({
    productWriteIntentAuthority: broker.authority(),
    journalRecovery,
    projectionFreshness,
  });
  const admission = Object.freeze({ name: 'admission' });
  const writerTurn = Object.freeze({ name: 'writer' });
  const input = Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, writeIntent: intent });
  await freshness.ensureProjectionCurrentForWrite(admission, writerTurn, input);
  assert.deepEqual(calls, { journal: 2, recovery: 1, full: 1, readable: 0 });

  const before = { ...calls };
  await assert.rejects(
    freshness.ensureProjectionCurrentForWrite(
      admission,
      writerTurn,
      Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, writeIntent: Object.freeze({ ...intent }) }),
    ),
    TypeError,
  );
  assert.deepEqual(calls, before);
  assert.equal(require('node:fs').existsSync(require('node:path').join(
    __dirname,
    '..',
    'manuscript',
    'incremental-refresh.js',
  )), false);
});

test('product freshness replays one exact committed non-create request before journal lookup', async () => {
  const l2 = downstreamFixture();
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphanFixture().service,
  });
  const intent = broker.bindL2Command({ kind: 'chapter.replace_body', bytes: 'body' });
  const calls = { replay: 0, journal: 0, recovery: 0, full: 0 };
  const freshness = createProductWriteFreshness({
    productWriteIntentAuthority: broker.authority(),
    journalRecovery: {
      lookupCommittedRequest(receivedIntent, logicalRequestId) {
        calls.replay += 1;
        assert.equal(receivedIntent, intent);
        assert.equal(logicalRequestId, LOGICAL_REQUEST_ID);
        return Object.freeze({ disposition: 'after' });
      },
      lookupOrdinaryRequest() { calls.journal += 1; return null; },
      async recoverPendingOrdinary() { calls.recovery += 1; },
    },
    projectionFreshness: {
      async ensureProjectionCurrent() { calls.full += 1; },
      async ensureReadableProjection(_admission, query) { return query; },
    },
  });

  await freshness.ensureProjectionCurrentForWrite(
    Object.freeze({ name: 'admission' }),
    Object.freeze({ name: 'writer' }),
    Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, writeIntent: intent }),
  );

  assert.deepEqual(calls, { replay: 1, journal: 0, recovery: 0, full: 1 });
});

test('product freshness admits only one exact matching ordinary-create chain before FULL', async () => {
  const l2 = downstreamFixture({ family: 'ordinary_create', logicalInputDigest: DIGEST });
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphanFixture().service,
  });
  const intent = broker.bindL2Command({ kind: 'chapter.create', bytes: 'new' });
  const calls = { journal: 0, recovery: 0, full: 0 };
  let lookup = Object.freeze({
    state: 'assets_reserved',
    outcome: 'early',
    identityReservation: Object.freeze({ marker: 'durable' }),
    reservationBinding: Object.freeze({
      projectUid: '11111111-1111-4111-8111-111111111111',
      projectInstanceId: '22222222-2222-4222-8222-222222222222',
      journalId: '33333333-3333-4333-8333-333333333333',
      logicalRequestId: LOGICAL_REQUEST_ID,
      baseGeneration: 7,
      targetGeneration: 8,
      basisDigest: 'b'.repeat(64),
      logicalInputDigest: DIGEST,
      inputDigest: 'c'.repeat(64),
      reservationDigest: 'd'.repeat(64),
    }),
  });
  const freshness = createProductWriteFreshness({
    productWriteIntentAuthority: broker.authority(),
    journalRecovery: {
      lookupCommittedRequest() { return null; },
      lookupOrdinaryRequest() { calls.journal += 1; return lookup; },
      async recoverPendingOrdinary(...args) {
        calls.recovery += 1;
        assert.equal(args.length, 0);
        lookup = Object.freeze({
          ...lookup,
          state: 'completed',
          outcome: 'after',
        });
      },
    },
    projectionFreshness: {
      async ensureProjectionCurrent() { calls.full += 1; },
      async ensureReadableProjection(_admission, query) { return query; },
    },
  });
  const input = Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, writeIntent: intent });
  await freshness.ensureProjectionCurrentForWrite(Object.freeze({}), Object.freeze({}), input);
  assert.deepEqual(calls, { journal: 2, recovery: 1, full: 1 });
  const replayContext = Object.freeze({ marker: 'matching-early-replay' });
  const replayed = await broker.execute(intent, replayContext);
  assert.strictEqual(replayed.turnContext, replayContext);
  assert.equal(l2.calls.execute, 1);

  lookup = Object.freeze({
    ...lookup,
    reservationBinding: Object.freeze({
      ...lookup.reservationBinding,
      logicalInputDigest: 'e'.repeat(64),
    }),
  });
  await assert.rejects(
    freshness.ensureProjectionCurrentForWrite(Object.freeze({}), Object.freeze({}), input),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(calls.full, 1);

  lookup = Object.freeze({
    reservationBinding: Object.freeze({
      logicalRequestId: LOGICAL_REQUEST_ID,
      logicalInputDigest: DIGEST,
    }),
  });
  await assert.rejects(
    freshness.ensureProjectionCurrentForWrite(Object.freeze({}), Object.freeze({}), input),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(calls.full, 1);
});

test('non-create and orphan collisions stop before FULL or downstream resolution', async () => {
  for (const family of ['non_create', 'orphan_resolution']) {
    const l2 = downstreamFixture();
    const orphan = orphanFixture();
    const broker = createProductWriteIntents({
      l2Service: l2.service,
      orphanResolutionService: orphan.service,
    });
    const intent = family === 'orphan_resolution'
      ? broker.bindOrphanAction('ignore_in_place', {
        kind: 'chapter',
        uid: '11111111-1111-4111-8111-111111111111',
      })
      : broker.bindL2Command({ kind: 'chapter.replace_body', bytes: 'body' });
    let full = 0;
    const freshness = createProductWriteFreshness({
      productWriteIntentAuthority: broker.authority(),
      journalRecovery: {
        lookupCommittedRequest() { return null; },
        lookupOrdinaryRequest() {
          return Object.freeze({ reservationBinding: Object.freeze({}) });
        },
        async recoverPendingOrdinary() {
          throw new Error('collision must stop before recovery');
        },
      },
      projectionFreshness: {
        async ensureProjectionCurrent() { full += 1; },
        async ensureReadableProjection(_admission, query) { return query; },
      },
    });
    await assert.rejects(
      freshness.ensureProjectionCurrentForWrite(
        Object.freeze({}),
        Object.freeze({}),
        Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, writeIntent: intent }),
      ),
      { code: 'RECOVERY_REQUIRED' },
    );
    assert.equal(full, 0);
    assert.equal(orphan.calls.preflight, 0);
    assert.equal(l2.calls.execute, 0);
  }
});

test('ordinary recovery failure stops before FULL, policy, and broker execution', async () => {
  const l2 = downstreamFixture();
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphanFixture().service,
  });
  const intent = broker.bindL2Command({ kind: 'chapter.replace_body', bytes: 'body' });
  const recoveryError = Object.assign(new Error('recovery disposition unknown'), {
    code: 'RECOVERY_REQUIRED',
  });
  const calls = { lookup: 0, recover: 0, full: 0 };
  const freshness = createProductWriteFreshness({
    productWriteIntentAuthority: broker.authority(),
    journalRecovery: {
      lookupCommittedRequest() { return null; },
      lookupOrdinaryRequest() { calls.lookup += 1; return null; },
      async recoverPendingOrdinary() {
        calls.recover += 1;
        throw recoveryError;
      },
    },
    projectionFreshness: {
      async ensureProjectionCurrent() { calls.full += 1; },
      async ensureReadableProjection(_admission, query) { return query; },
    },
  });
  await assert.rejects(
    freshness.ensureProjectionCurrentForWrite(
      Object.freeze({}),
      Object.freeze({}),
      Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, writeIntent: intent }),
    ),
    (error) => error === recoveryError,
  );
  assert.deepEqual(calls, { lookup: 1, recover: 1, full: 0 });
  assert.equal(l2.calls.execute, 0);
});

test('duplicate lookup and FULL failure cannot reach context, policy, or broker execution', async () => {
  for (const failureStage of ['duplicate_lookup', 'full_refresh']) {
    const l2 = downstreamFixture();
    const broker = createProductWriteIntents({
      l2Service: l2.service,
      orphanResolutionService: orphanFixture().service,
    });
    const intent = broker.bindL2Command({ kind: 'chapter.replace_body', bytes: 'body' });
    const calls = { context: 0, policy: 0, recover: 0 };
    const expected = Object.assign(new Error(failureStage), { code: 'RECOVERY_REQUIRED' });
    const freshness = createProductWriteFreshness({
      productWriteIntentAuthority: broker.authority(),
      journalRecovery: {
        lookupCommittedRequest() { return null; },
        lookupOrdinaryRequest() {
          if (failureStage === 'duplicate_lookup') throw expected;
          return null;
        },
        async recoverPendingOrdinary() { calls.recover += 1; },
      },
      projectionFreshness: {
        async ensureProjectionCurrent() { throw expected; },
        async ensureReadableProjection(_admission, query) { return query; },
      },
    });
    const gates = createManuscriptProductGates({
      projectSessionAdmission: {
        async withAdmission(_selector, operation) { return operation(Object.freeze({})); },
        async withOrphanAdmission(_selector, operation) { return operation(Object.freeze({})); },
      },
      writerTurns: {
        async withWriterTurn(_admission, operation) { return operation(Object.freeze({})); },
      },
      freshness,
      turnContextSource: {
        async capture() { calls.context += 1; throw new Error('unreachable context'); },
        async captureOrphanBaseline() { throw new Error('unreachable orphan context'); },
      },
      policy: {
        async authorizeWrite() {
          calls.policy += 1;
          return Object.freeze({ disposition: 'ALLOWED' });
        },
      },
      productWriteIntentAuthority: broker.authority(),
    });
    await assert.rejects(
      gates.withCurrentManuscriptWriteTurn(
        Object.freeze({}),
        Object.freeze({
          logicalRequestId: LOGICAL_REQUEST_ID,
          policyInput: Object.freeze({}),
          writeIntent: intent,
        }),
        (turnContext) => broker.execute(intent, turnContext),
      ),
      (error) => error === expected,
    );
    assert.deepEqual(calls, {
      context: 0,
      policy: 0,
      recover: failureStage === 'full_refresh' ? 1 : 0,
    });
    assert.equal(l2.calls.execute, 0);
  }
});

test('orphan product gate performs no ordinary FULL and one original resolution after policy', async () => {
  const l2 = downstreamFixture();
  const orphan = orphanFixture();
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphan.service,
  });
  const intent = broker.bindOrphanAction('revoke_ignore', {
    kind: 'chapter',
    uid: '11111111-1111-4111-8111-111111111111',
  });
  const calls = { admission: 0, writer: 0, journal: 0, full: 0, baseline: 0, policy: 0 };
  const admission = Object.freeze({});
  const writerTurn = Object.freeze({});
  const baseline = Object.freeze({});
  const currentProjection = Object.freeze({ projectUid: 'project' });
  const context = Object.freeze({
    journalId: '11111111-1111-4111-8111-111111111111',
    logicalRequestId: LOGICAL_REQUEST_ID,
    projectedAt: '2026-08-20T00:00:00.000Z',
    currentProjection,
    fileSnapshot: baseline,
    ignoredLedger: Object.freeze([]),
  });
  const projectionFreshness = {
    async ensureProjectionCurrent() { calls.full += 1; },
    async ensureReadableProjection(_admission, query) { return query; },
  };
  const freshness = createProductWriteFreshness({
    productWriteIntentAuthority: broker.authority(),
    journalRecovery: {
      lookupCommittedRequest() { return null; },
      lookupOrdinaryRequest() { calls.journal += 1; return null; },
      async recoverPendingOrdinary() { calls.journal += 100; },
    },
    projectionFreshness,
  });
  const gates = createManuscriptProductGates({
    projectSessionAdmission: {
      async withAdmission(_selector, operation) {
        calls.admission += 1;
        return operation(admission);
      },
      async withOrphanAdmission(_selector, operation) {
        calls.admission += 1;
        return operation(admission);
      },
    },
    writerTurns: {
      async withWriterTurn(_admission, operation) {
        calls.writer += 1;
        return operation(writerTurn);
      },
    },
    freshness,
    turnContextSource: {
      async capture() { throw new Error('ordinary capture forbidden'); },
      async captureOrphanBaseline(input) {
        calls.baseline += 1;
        exactKeys(input, ['admission', 'writerTurn', 'logicalRequestId']);
        return context;
      },
    },
    policy: {
      async authorizeWrite(input) {
        calls.policy += 1;
        assert.strictEqual(input.turnContext, context);
        return Object.freeze({ disposition: 'ALLOWED' });
      },
    },
    productWriteIntentAuthority: broker.authority(),
  });
  const request = Object.freeze({
    logicalRequestId: LOGICAL_REQUEST_ID,
    policyInput: Object.freeze({ kind: 'orphan' }),
    writeIntent: intent,
  });
  const result = await gates.withCurrentManuscriptWriteTurn(
    Object.freeze({ projectUid: 'project' }),
    request,
    (turnContext) => broker.execute(intent, turnContext),
  );
  assert.equal(result.action, 'revoke_ignore');
  assert.deepEqual(calls, {
    admission: 1,
    writer: 1,
    journal: 1,
    full: 0,
    baseline: 1,
    policy: 1,
  });
  assert.deepEqual(orphan.calls, { snapshot: 1, preflight: 1, publish: 1 });
});

test('gate rejects an inexact request or foreign intent before admission', async () => {
  const l2 = downstreamFixture();
  const orphan = orphanFixture();
  const broker = createProductWriteIntents({
    l2Service: l2.service,
    orphanResolutionService: orphan.service,
  });
  const foreign = createProductWriteIntents({
    l2Service: downstreamFixture().service,
    orphanResolutionService: orphanFixture().service,
  });
  const intent = broker.bindL2Command({ kind: 'chapter.replace_body', bytes: 'body' });
  let admissions = 0;
  const gates = createManuscriptProductGates({
    projectSessionAdmission: {
      async withAdmission(_selector, operation) { admissions += 1; return operation(Object.freeze({})); },
      async withOrphanAdmission(_selector, operation) { admissions += 1; return operation(Object.freeze({})); },
    },
    writerTurns: { async withWriterTurn(_admission, operation) { return operation(Object.freeze({})); } },
    freshness: {
      async ensureProjectionCurrentForWrite() {},
      async ensureReadableProjection(_admission, query) { return query; },
    },
    turnContextSource: {
      async capture() { throw new Error('not reached'); },
      async captureOrphanBaseline() { throw new Error('not reached'); },
    },
    policy: { async authorizeWrite() { return Object.freeze({ disposition: 'ALLOWED' }); } },
    productWriteIntentAuthority: broker.authority(),
  });
  const selector = Object.freeze({});
  const invalid = [
    Object.freeze({ logicalRequestId: LOGICAL_REQUEST_ID, policyInput: Object.freeze({}) }),
    Object.freeze({
      logicalRequestId: LOGICAL_REQUEST_ID,
      policyInput: Object.freeze({}),
      writeIntent: Object.freeze({ ...intent }),
    }),
    Object.freeze({
      logicalRequestId: LOGICAL_REQUEST_ID,
      policyInput: Object.freeze({}),
      writeIntent: foreign.bindL2Command({ kind: 'chapter.replace_body', bytes: 'foreign' }),
    }),
  ];
  for (const request of invalid) {
    await assert.rejects(
      gates.withCurrentManuscriptWriteTurn(selector, request, () => {}),
      TypeError,
    );
  }
  assert.equal(admissions, 0);
});

test('production runtime source has one brokered gate path and validates the production boundary pair', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'manuscript',
    'production-runtime.js',
  ), 'utf8');
  assert.match(source, /assertProductionManuscriptFileBoundaryPair/u);
  assert.match(source, /createManuscriptProductGates/u);
  assert.match(source, /createProductWriteFreshness/u);
  assert.match(source, /ManuscriptSessionController/u);
  assert.match(source, /createManuscriptFreshnessLifecycle/u);
  assert.match(source, /createWindowsManuscriptLifecycleLeaseAdapter/u);
  assert.match(
    source,
    /notificationCapability:\s*Object\.freeze\(\{\s*read\(\)\s*\{\s*return getBuildInfo\(\)\.manuscriptChangeNotification;\s*\},?\s*\}\)/u,
    'production freshness must consume the same compile-time change-notification capability advertised by build-info',
  );
  assert.doesNotMatch(
    source,
    /notificationCapability:\s*Object\.freeze\(\{\s*read\(\)\s*\{\s*return false;\s*\}\s*\}\)/u,
  );
  assert.doesNotMatch(source, /\.createFresh\(/u);
  assert.match(source, /bindL2Command/u);
  assert.match(source, /productWriteIntents\.execute/u);
  assert.doesNotMatch(source, /entry\.l2\.execute\s*\(/u);
  assert.doesNotMatch(source, /files\.prime\(/u);
  const entryShell = source.slice(
    source.indexOf('function entryFor(admission)'),
    source.indexOf('function ensureSession'),
  );
  assert.ok(entryShell.indexOf('verifyBeforeFeedStart') < entryShell.indexOf('bootstrapEntry(entry)'));
  assert.ok(entryShell.indexOf('bootstrapEntry(entry)') < entryShell.indexOf('captureChangeFeedPlatformIdentity'));
});

test('production shutdown awaits manuscript teardown before database close', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(
    __dirname,
    '..',
    'index.js',
  ), 'utf8');
  assert.match(source, /await manuscriptRuntime\?\.close\(\)/u);
  assert.match(source, /finally\s*\{\s*await db\.closeAllDatabases\(\)/u);
});

test('AI prompt context uses the readable runtime and never downgrades admission failures', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const contextSource = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'context.js'), 'utf8');
  const writingSource = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'writing.js'), 'utf8');
  const collabSource = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'collab.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(contextSource, /getManuscriptRuntime\(\)\.read/u);
  assert.match(contextSource, /kind:\s*'prompt_context'/u);
  assert.doesNotMatch(contextSource, /catch\s*\(/u);
  assert.doesNotMatch(contextSource, /\bSELECT\b|\bgetProjectDb\b/u);
  assert.match(writingSource, /async function buildWritingPrompt/u);
  assert.match(collabSource, /async function buildCollabPrompt/u);
  assert.match(indexSource, /await buildWritingPrompt/u);
  assert.match(indexSource, /await buildCollabPrompt/u);
});
