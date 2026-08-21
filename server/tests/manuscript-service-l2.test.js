'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveControlledFileRef } = require('../manuscript/paths');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('../manuscript/projection-store');
const { createL2ManuscriptService } = require('../manuscript/l2-service');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_UID = '99999999-9999-4999-8999-999999999999';
const VOLUME_ACTIVE = '33333333-3333-4333-8333-333333333333';
const VOLUME_TOMBSTONE = '44444444-4444-4444-8444-444444444444';
const CHAPTER_ACTIVE = '55555555-5555-4555-8555-555555555555';
const CHAPTER_TOMBSTONE = '66666666-6666-4666-8666-666666666666';
const IGNORED_UID = '77777777-7777-4777-8777-777777777777';
const JOURNAL_ID = '88888888-8888-4888-8888-888888888888';
const PROJECTED_AT = '2026-08-18T00:00:00.000Z';

const REFS = Object.freeze({
  body: deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_ACTIVE,
  }),
  sidecar: deriveControlledFileRef({
    role: 'chapter_sidecar',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_ACTIVE,
  }),
  volume: deriveControlledFileRef({
    role: 'volume_index',
    projectUid: PROJECT_UID,
    volumeUid: VOLUME_ACTIVE,
  }),
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function ignoredLedger(baseGeneration = 4) {
  return [{
    resource_kind: 'chapter',
    resource_uid: IGNORED_UID,
    ignore_status: 'active',
    opaque_container_kind: 'unassigned',
    opaque_container_uid: null,
    is_currently_referenced: 1,
    member_snapshot_json: '{"body":true,"sidecar":true}',
    projection_generation: baseGeneration,
  }];
}

function currentProjection(ledger = ignoredLedger()) {
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: 4,
    volumes: [
      {
        id: 7,
        uid: VOLUME_ACTIVE,
        sortOrder: 1,
        isPresent: 1,
        deletedAt: null,
      },
      {
        id: 8,
        uid: VOLUME_TOMBSTONE,
        sortOrder: 2,
        isPresent: 0,
        deletedAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    chapters: [
      {
        id: 11,
        uid: CHAPTER_ACTIVE,
        volumeId: 7,
        num: 3,
        isPresent: 1,
        deletedAt: null,
        chapterPosition: 1,
        manuscriptPosition: 1,
        bodyRawSha256: '1'.repeat(64),
        status: 'writing',
      },
      {
        id: 12,
        uid: CHAPTER_TOMBSTONE,
        volumeId: null,
        num: 9,
        isPresent: 0,
        deletedAt: '2026-08-02T00:00:00.000Z',
        chapterPosition: null,
        manuscriptPosition: null,
        bodyRawSha256: '2'.repeat(64),
        status: 'accepted',
      },
    ],
    sqliteSequence: [
      { name: 'chapters', seq: 12 },
      { name: 'volumes', seq: 8 },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(ledger),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return { projectUid: PROJECT_UID, projectInstanceId: PROJECT_INSTANCE_ID, basis };
}

function turnContext(overrides = {}) {
  const ledger = ignoredLedger();
  return {
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-request-1',
    projectedAt: PROJECTED_AT,
    currentProjection: currentProjection(ledger),
    fileSnapshot: Object.freeze({ capability: 'fixture-file-snapshot' }),
    ignoredLedger: ledger,
    ...overrides,
  };
}

function expectedIdentityPlan() {
  return [
    {
      assignmentKind: 'reuse_uid',
      objectKind: 'chapter',
      uid: CHAPTER_ACTIVE,
      id: 11,
      num: 3,
    },
    {
      assignmentKind: 'reuse_uid',
      objectKind: 'chapter',
      uid: CHAPTER_TOMBSTONE,
      id: 12,
      num: 9,
    },
    {
      assignmentKind: 'reuse_uid',
      objectKind: 'volume',
      uid: VOLUME_ACTIVE,
      id: 7,
    },
    {
      assignmentKind: 'reuse_uid',
      objectKind: 'volume',
      uid: VOLUME_TOMBSTONE,
      id: 8,
    },
  ];
}

function createHarness({ noOp = false, failAt = null, buildGate = null } = {}) {
  const calls = [];
  const captured = {};
  const closure = Object.freeze(noOp ? [] : [Object.freeze({ member: 'changed-file' })]);
  const buildResult = Object.freeze({
    closure,
    candidateTemplate: Object.freeze({ projectUid: PROJECT_UID }),
  });
  const stagedAssets = Object.freeze({ capability: 'staged' });
  const preparedAssets = Object.freeze({ capability: 'prepared' });
  const stagedAfterFacts = Object.freeze([Object.freeze({ fact: 'after' })]);
  const candidate = Object.freeze({ candidate: true });
  const target = Object.freeze({ target: true });

  function mark(name, value) {
    calls.push(name);
    captured[name] = value;
    if (failAt === name) throw new Error(`fail:${name}`);
  }

  const manuscriptStore = {
    async buildClosure(snapshot, command) {
      mark('buildClosure', { snapshot, command });
      if (snapshot?.capability !== 'fixture-file-snapshot') {
        throw new TypeError('foreign file snapshot');
      }
      if (buildGate !== null) await buildGate;
      return buildResult;
    },
    finalizeCandidate(receivedBuild, facts) {
      mark('finalizeCandidate', { receivedBuild, facts });
      assert.strictEqual(receivedBuild, buildResult);
      assert.strictEqual(facts, stagedAfterFacts);
      return candidate;
    },
  };
  const projectionStore = {
    buildTarget(input) {
      mark('buildTarget', input);
      return target;
    },
    publish() {
      throw new Error('service must not publish a projection twice');
    },
  };
  const fileJournal = {
    async stageAssets(input) {
      mark('stageAssets', input);
      return Object.freeze({ stagedAssets, stagedAfterFacts });
    },
    async bindTarget(input) {
      mark('bindTarget', input);
      return Object.freeze({ preparedAssets });
    },
    async prepare(input) {
      mark('prepare', input);
      return Object.freeze({ state: 'prepared' });
    },
    async publishFiles(journalId) {
      mark('publishFiles', journalId);
      return Object.freeze({ state: 'files_published' });
    },
    async commitProjection(journalId) {
      mark('commitProjection', journalId);
      return Object.freeze({ state: 'projection_committed' });
    },
    async complete(journalId) {
      mark('complete', journalId);
      return Object.freeze({ state: 'completed' });
    },
  };
  return {
    calls,
    captured,
    manuscriptStore,
    projectionStore,
    fileJournal,
    closure,
    buildResult,
    stagedAssets,
    preparedAssets,
    target,
  };
}

function serviceFor(harness) {
  return createL2ManuscriptService({
    manuscriptStore: harness.manuscriptStore,
    fileJournal: harness.fileJournal,
    projectionStore: harness.projectionStore,
  });
}

const MUTATIONS = [
  {
    kind: 'chapter.replace_body',
    bodyRef: REFS.body,
    content: '新正文',
  },
  {
    kind: 'chapter.patch_sidecar',
    sidecarRef: REFS.sidecar,
    patch: { title: '新标题' },
  },
  {
    kind: 'chapter.replace_body_and_sidecar',
    bodyRef: REFS.body,
    sidecarRef: REFS.sidecar,
    content: '组合正文',
    patch: { summary: '组合摘要' },
  },
  {
    kind: 'volume.patch_metadata',
    volumeRef: REFS.volume,
    patch: { title: '新卷名', summary: '新卷摘要' },
  },
];

test('ordinary service accepts only the four Task 7B mutations and runs the exact full sequence', async () => {
  for (const mutation of MUTATIONS) {
    const harness = createHarness();
    const context = turnContext();
    const result = await serviceFor(harness).execute(mutation, context);

    assert.deepEqual(harness.calls, [
      'buildClosure',
      'stageAssets',
      'finalizeCandidate',
      'buildTarget',
      'bindTarget',
      'prepare',
      'publishFiles',
      'commitProjection',
      'complete',
    ]);
    assert.deepEqual(result, { state: 'completed' });
    assert.equal(Object.isFrozen(harness.captured.buildClosure.command), true);
    for (const key of ['bodyRef', 'sidecarRef', 'volumeRef']) {
      if (Object.hasOwn(mutation, key)) {
        assert.strictEqual(harness.captured.buildClosure.command[key], mutation[key]);
      }
    }
    assert.deepEqual(harness.captured.stageAssets, {
      journalId: JOURNAL_ID,
      logicalRequestId: 'logical-request-1',
      baseGeneration: 4,
      targetGeneration: 5,
      basisDigest: context.currentProjection.basis.basisDigest,
      closure: harness.closure,
      identityReservation: null,
      parent: null,
    });
    assert.strictEqual(harness.captured.bindTarget.stagedAssets, harness.stagedAssets);
    assert.strictEqual(harness.captured.bindTarget.projectionTarget, harness.target);
    assert.deepEqual(harness.captured.prepare, { preparedAssets: harness.preparedAssets });
    assert.equal(harness.captured.publishFiles, JOURNAL_ID);
    assert.equal(harness.captured.commitProjection, JOURNAL_ID);
    assert.equal(harness.captured.complete, JOURNAL_ID);

    const targetInput = harness.captured.buildTarget;
    assert.equal(targetInput.targetGeneration, 5);
    assert.equal(targetInput.projectedAt, PROJECTED_AT);
    assert.equal(targetInput.ignoredLedger[0].projection_generation, 5);
    assert.deepEqual(targetInput.localIdentityPlan, expectedIdentityPlan());
    assert.equal(Object.isFrozen(targetInput.currentProjection), true);
    assert.equal(Object.isFrozen(targetInput.ignoredLedger), true);
    assert.equal(Object.isFrozen(targetInput.localIdentityPlan), true);
  }
});

test('no-op returns immediately after the single closure build and never touches the journal', async () => {
  const harness = createHarness({ noOp: true });
  const result = await serviceFor(harness).execute(MUTATIONS[0], turnContext());

  assert.deepEqual(harness.calls, ['buildClosure']);
  assert.deepEqual(result, { state: 'noop' });
});

test('turn and command inputs are snapshotted before the first await while branded refs stay opaque', async () => {
  let release;
  const buildGate = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({ buildGate });
  const command = {
    kind: 'chapter.patch_sidecar',
    sidecarRef: REFS.sidecar,
    patch: { title: 'before' },
  };
  const context = turnContext();
  const originalProjection = context.currentProjection;
  const originalLedger = context.ignoredLedger;
  const pending = serviceFor(harness).execute(command, context);

  command.patch.title = 'after';
  context.currentProjection.basis.baseGeneration = 99;
  context.ignoredLedger[0].member_snapshot_json = '{"changed":true}';
  context.journalId = '99999999-9999-4999-8999-999999999999';
  release();
  await pending;

  assert.equal(harness.captured.buildClosure.command.patch.title, 'before');
  assert.strictEqual(harness.captured.buildClosure.command.sidecarRef, REFS.sidecar);
  assert.notStrictEqual(harness.captured.buildTarget.currentProjection, originalProjection);
  assert.notStrictEqual(harness.captured.buildTarget.ignoredLedger, originalLedger);
  assert.equal(harness.captured.buildTarget.currentProjection.basis.baseGeneration, 4);
  assert.equal(harness.captured.buildTarget.ignoredLedger[0].member_snapshot_json,
    '{"body":true,"sidecar":true}');
  assert.equal(harness.captured.stageAssets.journalId, JOURNAL_ID);
});

test('inexact, accessor, non-schema12, stale ignored, unsupported, and foreign snapshot inputs fail before journal use', async () => {
  const cases = [];
  cases.push(turnContext({ extra: true }));

  const withSymbol = turnContext();
  withSymbol[Symbol('extra')] = true;
  cases.push(withSymbol);

  let getterCalled = false;
  const withAccessor = turnContext();
  Object.defineProperty(withAccessor.currentProjection.basis, 'baseGeneration', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 4;
    },
  });
  cases.push(withAccessor);

  const wrongSource = turnContext();
  wrongSource.currentProjection.basis.sourceKind = 'schema11';
  cases.push(wrongSource);

  const staleIgnored = turnContext();
  staleIgnored.ignoredLedger[0].member_snapshot_json = '{"stale":true}';
  cases.push(staleIgnored);

  cases.push(turnContext({ projectedAt: 'not-a-time' }));

  for (const context of cases) {
    const harness = createHarness();
    await assert.rejects(serviceFor(harness).execute(MUTATIONS[0], context), TypeError);
    assert.deepEqual(harness.calls, []);
  }
  assert.equal(getterCalled, false);

  const unsupported = createHarness();
  await assert.rejects(serviceFor(unsupported).execute({ kind: 'chapter.create' }, turnContext()),
    TypeError);
  assert.deepEqual(unsupported.calls, []);

  const arrayKind = createHarness();
  await assert.rejects(serviceFor(arrayKind).execute({
    kind: ['chapter.replace_body'],
    bodyRef: REFS.body,
    content: '正文',
  }, turnContext()), TypeError);
  assert.deepEqual(arrayKind.calls, []);

  let coercionCalled = false;
  const coercingKind = {
    [Symbol.toPrimitive]() {
      coercionCalled = true;
      return 'chapter.replace_body';
    },
  };
  const coercing = createHarness();
  await assert.rejects(serviceFor(coercing).execute({
    kind: coercingKind,
    bodyRef: REFS.body,
    content: '正文',
  }, turnContext()), TypeError);
  assert.equal(coercionCalled, false);
  assert.deepEqual(coercing.calls, []);

  const wrongProject = createHarness();
  const wrongProjectContext = turnContext();
  wrongProjectContext.currentProjection.projectUid = OTHER_PROJECT_UID;
  await assert.rejects(
    serviceFor(wrongProject).execute(MUTATIONS[0], wrongProjectContext),
    TypeError,
  );
  assert.deepEqual(wrongProject.calls, ['buildClosure']);

  const foreign = createHarness();
  const context = turnContext({ fileSnapshot: Object.freeze({ copied: true }) });
  await assert.rejects(serviceFor(foreign).execute(MUTATIONS[0], context), TypeError);
  assert.deepEqual(foreign.calls, ['buildClosure']);
});

test('every failure stops at that operation without rollback, recovery, or duplicate projection publish', async () => {
  const sequence = [
    'buildClosure',
    'stageAssets',
    'finalizeCandidate',
    'buildTarget',
    'bindTarget',
    'prepare',
    'publishFiles',
    'commitProjection',
    'complete',
  ];
  for (const [index, failAt] of sequence.entries()) {
    const harness = createHarness({ failAt });
    await assert.rejects(serviceFor(harness).execute(MUTATIONS[0], turnContext()), {
      message: `fail:${failAt}`,
    });
    assert.deepEqual(harness.calls, sequence.slice(0, index + 1));
  }
});
