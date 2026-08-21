'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DraftConflictService } = require('../manuscript/draft-conflict-service');

const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = '66666666-6666-4666-8666-666666666666';
const CHAPTER_UID = '55555555-5555-4555-8555-555555555555';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function exactAuthority() {
  const records = new WeakMap();
  const authority = Object.freeze({
    assert(intent) {
      if (records.get(intent) === undefined) throw new TypeError('foreign intent');
      return intent;
    },
    describe(intent) {
      const descriptor = records.get(intent);
      if (descriptor === undefined) throw new TypeError('foreign intent');
      return descriptor;
    },
  });
  return {
    authority,
    bind(descriptor) {
      const intent = Object.freeze({});
      records.set(intent, descriptor);
      return intent;
    },
  };
}

function contextAuthority() {
  const contexts = new WeakMap();
  const authority = Object.freeze({
    assert(context) {
      if (!contexts.has(context)) throw new TypeError('foreign turn context');
      return context;
    },
    describe(context) {
      const descriptor = contexts.get(context);
      if (descriptor === undefined) throw new TypeError('foreign turn context');
      return descriptor;
    },
  });
  return {
    authority,
    mint(descriptor = Object.freeze({ journalId: CHILD_ID })) {
      const context = Object.freeze({});
      contexts.set(context, descriptor);
      return context;
    },
  };
}

function readyView(overrides = {}) {
  return Object.freeze({
    conflictId: CONFLICT_ID,
    supersedes: null,
    state: 'decision_ready',
    decisionEpoch: 2,
    childJournalId: null,
    resource: Object.freeze({ kind: 'chapter', uid: CHAPTER_UID, domain: 'body' }),
    baseGeneration: 7,
    baseRawSha256: HASH_A,
    externalRawSha256: HASH_B,
    draftRawSha256: HASH_C,
    externalByteSize: 8,
    draftByteSize: 5,
    fieldMask: Object.freeze(['body']),
    createdAt: 123,
    ...overrides,
  });
}

function createHarness(options = {}) {
  const intents = exactAuthority();
  const contexts = contextAuthority();
  const calls = [];
  const decisionIntents = new WeakMap();
  const journalIntentAuthority = Object.freeze({
    assert(intent) {
      if (!decisionIntents.has(intent)) throw codedError('RECOVERY_REQUIRED');
      return intent;
    },
    describe(intent) {
      const descriptor = decisionIntents.get(intent);
      if (descriptor === undefined) throw codedError('RECOVERY_REQUIRED');
      return descriptor;
    },
  });
  const view = options.view || readyView();
  const journal = {
    listConflicts() {
      calls.push(['list']);
      return options.views || Object.freeze([view]);
    },
    async createConflict(input) {
      calls.push(['create', input]);
      if (options.createError) throw options.createError;
      return Object.freeze({ conflictId: CONFLICT_ID, state: 'decision_ready', decisionEpoch: 0 });
    },
    readConflict(conflictId) {
      calls.push(['read', conflictId]);
      return view;
    },
    async beginAccept(input) {
      calls.push(['beginAccept', input]);
      if (options.beginError) throw options.beginError;
      const intent = Object.freeze({});
      decisionIntents.set(intent, Object.freeze({ kind: 'accept', ...input }));
      return intent;
    },
    async beginApply(input) {
      calls.push(['beginApply', input]);
      if (options.beginError) throw options.beginError;
      const intent = Object.freeze({});
      decisionIntents.set(intent, Object.freeze({ kind: 'apply', ...input }));
      return intent;
    },
    async recordAcceptResolved(intent, evidence) {
      calls.push(['recordAccept', intent, evidence]);
      if (decisionIntents.get(intent)?.kind !== 'accept' || evidence !== options.acceptEvidence) {
        throw codedError('RECOVERY_REQUIRED');
      }
      return Object.freeze({ conflictId: CONFLICT_ID, state: 'resolved_accept_external', decisionEpoch: 2 });
    },
    async recordApplyResolved(intent, evidence) {
      calls.push(['recordApply', intent, evidence]);
      if (decisionIntents.get(intent)?.kind !== 'apply' || evidence !== options.applyEvidence) {
        throw codedError('RECOVERY_REQUIRED');
      }
      return Object.freeze({ conflictId: CONFLICT_ID, state: 'resolved_apply_draft', decisionEpoch: 2 });
    },
    async archive(input) {
      calls.push(['archive', input]);
      return Object.freeze({ conflictId: input.conflictId, state: 'archived', decisionEpoch: 2 });
    },
    intentAuthority() {
      return journalIntentAuthority;
    },
  };
  const capturedJournalIntentAuthority = options.pipelineIntentAuthority || journalIntentAuthority;
  const pipeline = {
    async acceptExternal(intent, context) {
      calls.push(['pipelineAccept', intent, context]);
      capturedJournalIntentAuthority.describe(intent);
      if (options.pipelineError) throw options.pipelineError;
      return options.pipelineAcceptResult === undefined
        ? options.acceptEvidence
        : options.pipelineAcceptResult;
    },
    async applySavedDraft(intent, context) {
      calls.push(['pipelineApply', intent, context]);
      capturedJournalIntentAuthority.describe(intent);
      if (options.pipelineError) throw options.pipelineError;
      return options.pipelineApplyResult === undefined
        ? options.applyEvidence
        : options.pipelineApplyResult;
    },
    intentAuthority() {
      return capturedJournalIntentAuthority;
    },
  };
  const service = new DraftConflictService({
    contextAuthority: contexts.authority,
    intentAuthority: intents.authority,
    journal,
    resolutionPipeline: pipeline,
  });
  return { calls, contexts, intents, journal, pipeline, service };
}

function createDescriptor() {
  return Object.freeze({
    kind: 'create_backup',
    conflict: Object.freeze({
      resource: Object.freeze({ kind: 'chapter', uid: CHAPTER_UID, domain: 'body' }),
      basis: Object.freeze({ baseGeneration: 7, baseRawSha256: HASH_A }),
      draftBytes: Buffer.from('draft'),
      externalBytes: Buffer.from('external'),
      fieldMask: Object.freeze(['body']),
      supersedes: null,
    }),
  });
}

test('plain or foreign intent/context is rejected before journal and pipeline side effects', async () => {
  const fixture = createHarness();
  const context = fixture.contexts.mint();
  await assert.rejects(fixture.service.createBackup(Object.freeze({}), context), TypeError);
  const intent = fixture.intents.bind(createDescriptor());
  await assert.rejects(fixture.service.createBackup(intent, Object.freeze({})), TypeError);
  assert.deepEqual(fixture.calls, []);
});

test('resolution pipeline must be constructor-bound to the same journal intent authority', () => {
  const foreignAuthority = Object.freeze({
    assert(intent) { return intent; },
    describe() { return Object.freeze({}); },
  });
  assert.throws(
    () => createHarness({ pipelineIntentAuthority: foreignAuthority }),
    /intent authority/u,
  );
});

test('createBackup snapshots opaque bytes before await and never claims a non-durable backup', async () => {
  const nonDurable = createHarness({ createError: codedError('RECOVERY_REQUIRED') });
  const failedIntent = nonDurable.intents.bind(createDescriptor());
  await assert.rejects(
    nonDurable.service.createBackup(failedIntent, nonDurable.contexts.mint()),
    (error) => error.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(nonDurable.calls.filter(([name]) => name === 'create').length, 1);
  assert.equal(nonDurable.calls.some(([name]) => name === 'archive'), false);

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const fixture = createHarness();
  fixture.journal.createConflict = async () => pending;
  // Methods are captured by the service constructor, so replacing the source port is inert.
  const descriptor = createDescriptor();
  const intent = fixture.intents.bind(descriptor);
  const operation = fixture.service.createBackup(intent, fixture.contexts.mint());
  descriptor.conflict.draftBytes.fill(0x78);
  release(Object.freeze({ conflictId: CONFLICT_ID, state: 'decision_ready', decisionEpoch: 0 }));
  const result = await operation;
  assert.equal(result.state, 'decision_ready');
  const createInput = fixture.calls.find(([name]) => name === 'create')?.[1];
  assert.equal(createInput.draftBytes.toString('utf8'), 'draft');
});

test('listConflicts hides conflict_detected and marks only durable journal states as backup available', () => {
  const fixture = createHarness({
    views: Object.freeze([
      readyView({ state: 'conflict_detected' }),
      readyView({ conflictId: '44444444-4444-4444-8444-444444444444', state: 'backup_durable' }),
      readyView(),
    ]),
  });
  const result = fixture.service.listConflicts(fixture.contexts.mint());
  assert.deepEqual(result.map(({ state, backupAvailable, decisionAvailable }) => ({
    state,
    backupAvailable,
    decisionAvailable,
  })), [
    { state: 'backup_durable', backupAvailable: true, decisionAvailable: false },
    { state: 'decision_ready', backupAvailable: true, decisionAvailable: true },
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

test('listConflicts rejects accessor-backed journal views without evaluating them', () => {
  let getterCalls = 0;
  const malicious = Object.freeze(Object.defineProperty({}, 'state', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'conflict_detected';
    },
  }));
  const fixture = createHarness({ views: Object.freeze([malicious]) });
  assert.throws(() => fixture.service.listConflicts(fixture.contexts.mint()), TypeError);
  assert.equal(getterCalls, 0);
});

test('acceptExternal derives journal CAS input, passes original journal intent/context, and archives only proven after evidence', async () => {
  const evidence = Object.freeze({});
  const fixture = createHarness({ acceptEvidence: evidence });
  const context = fixture.contexts.mint();
  const request = fixture.intents.bind(Object.freeze({
    kind: 'accept_external',
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
  }));
  const result = await fixture.service.acceptExternal(request, context);
  assert.equal(result.state, 'archived');
  const begin = fixture.calls.find(([name]) => name === 'beginAccept');
  assert.deepEqual(begin[1], {
    acceptedRawSha256: HASH_B,
    baseGeneration: 7,
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
    targetGeneration: 8,
  });
  const pipeline = fixture.calls.find(([name]) => name === 'pipelineAccept');
  const record = fixture.calls.find(([name]) => name === 'recordAccept');
  assert.equal(pipeline[1], record[1]);
  assert.equal(pipeline[2], context);
  assert.equal(record[2], evidence);
  assert.deepEqual(fixture.calls.map(([name]) => name), [
    'read', 'beginAccept', 'pipelineAccept', 'recordAccept', 'archive',
  ]);
});

test('stale epoch and unproven plain evidence never reach an erroneous terminal state', async () => {
  const stale = createHarness({ beginError: codedError('PROJECTION_STALE') });
  const staleRequest = stale.intents.bind(Object.freeze({
    kind: 'accept_external', conflictId: CONFLICT_ID, decisionEpoch: 1,
  }));
  await assert.rejects(
    stale.service.acceptExternal(staleRequest, stale.contexts.mint()),
    (error) => error.code === 'PROJECTION_STALE',
  );
  assert.deepEqual(stale.calls.map(([name]) => name), ['read', 'beginAccept']);

  const plainEvidence = Object.freeze({ state: 'after' });
  const unproven = createHarness({ acceptEvidence: Object.freeze({}), pipelineAcceptResult: plainEvidence });
  const request = unproven.intents.bind(Object.freeze({
    kind: 'accept_external', conflictId: CONFLICT_ID, decisionEpoch: 2,
  }));
  await assert.rejects(
    unproven.service.acceptExternal(request, unproven.contexts.mint()),
    (error) => error.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(unproven.calls.some(([name]) => name === 'archive'), false);
});

test('applySavedDraft binds a unique child and publication failure leaves journal resolution uncompleted', async () => {
  const failure = codedError('RECOVERY_REQUIRED');
  const fixture = createHarness({ pipelineError: failure });
  const context = fixture.contexts.mint();
  const request = fixture.intents.bind(Object.freeze({
    kind: 'apply_saved_draft',
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
  }));
  await assert.rejects(fixture.service.applySavedDraft(request, context), failure);
  const begin = fixture.calls.find(([name]) => name === 'beginApply');
  assert.deepEqual(begin[1], {
    baseGeneration: 7,
    childJournalId: CHILD_ID,
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
    externalRawSha256: HASH_B,
    targetGeneration: 8,
  });
  assert.equal(fixture.calls.some(([name]) => name === 'recordApply'), false);
  assert.equal(fixture.calls.some(([name]) => name === 'archive'), false);
});

test('resolution requests are consumed before downstream work and cannot retry after failure', async () => {
  const fixture = createHarness({ pipelineError: codedError('RECOVERY_REQUIRED') });
  const context = fixture.contexts.mint();
  const request = fixture.intents.bind(Object.freeze({
    kind: 'apply_saved_draft',
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
  }));
  await assert.rejects(fixture.service.applySavedDraft(request, context));
  const callsAfterFailure = fixture.calls.length;
  await assert.rejects(fixture.service.applySavedDraft(request, context), /consumed/u);
  assert.equal(fixture.calls.length, callsAfterFailure);
});

test('apply child journal identity comes only from the original production turn context', async () => {
  const evidence = Object.freeze({});
  const fixture = createHarness({ applyEvidence: evidence });
  const request = fixture.intents.bind(Object.freeze({
    kind: 'apply_saved_draft',
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
  }));
  const context = fixture.contexts.mint(Object.freeze({ journalId: CHILD_ID }));
  await fixture.service.applySavedDraft(request, context);
  assert.equal(
    fixture.calls.find(([name]) => name === 'beginApply')[1].childJournalId,
    CHILD_ID,
  );

  const widened = fixture.intents.bind(Object.freeze({
    kind: 'apply_saved_draft',
    conflictId: CONFLICT_ID,
    decisionEpoch: 2,
    childJournalId: CHILD_ID,
  }));
  const callsBefore = fixture.calls.length;
  await assert.rejects(fixture.service.applySavedDraft(widened, context), /inexact/u);
  assert.equal(fixture.calls.length, callsBefore);
});
