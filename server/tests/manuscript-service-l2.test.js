'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { normalizeIgnoredLedgerRows } = require('../manuscript/ignored-ledger');
const {
  deriveChapterPaths,
  deriveControlledFileRef,
  deriveManuscriptPaths,
  deriveVolumePath,
} = require('../manuscript/paths');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
  canonicalSchema12ReuseIdentityPlan,
} = require('../manuscript/projection-store');
const { createL2ManuscriptService } = require('../manuscript/l2-service');
const {
  canonicalCreateLogicalInputDigest,
  validateIdentityReservationManifest,
} = require('../manuscript/uid-reservation');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_UID = '99999999-9999-4999-8999-999999999999';
const VOLUME_ACTIVE = '33333333-3333-4333-8333-333333333333';
const VOLUME_TOMBSTONE = '44444444-4444-4444-8444-444444444444';
const CHAPTER_ACTIVE = '55555555-5555-4555-8555-555555555555';
const CHAPTER_TOMBSTONE = '66666666-6666-4666-8666-666666666666';
const IGNORED_UID = '77777777-7777-4777-8777-777777777777';
const JOURNAL_ID = '88888888-8888-4888-8888-888888888888';
const CHAPTER_SAME_NUM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREATED_VOLUME_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CREATED_CHAPTER_UID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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

function presentMember(role, seed) {
  return {
    role,
    present: true,
    byteSize: 10 + seed,
    fileIdentity: { dev: '1', ino: String(100 + seed) },
    parentIdentity: { dev: '1', ino: String(200 + seed) },
  };
}

function baseMembers() {
  return [
    presentMember('chapter_body', 1),
    presentMember('chapter_sidecar', 2),
  ];
}

function memberJson(members) {
  return JSON.stringify({ version: 1, members });
}

function ignoredLedger(baseGeneration = 4) {
  return [{
    resource_kind: 'chapter',
    resource_uid: IGNORED_UID,
    ignore_status: 'active',
    opaque_container_kind: 'unassigned',
    opaque_container_uid: null,
    is_currently_referenced: 1,
    member_snapshot_json: memberJson(baseMembers()),
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

function turnContextAtGeneration(baseGeneration) {
  const ledger = ignoredLedger(baseGeneration);
  const projection = currentProjection(ledger);
  projection.basis.baseGeneration = baseGeneration;
  projection.basis.basisDigest = canonicalProjectionBasisDigest(projection.basis);
  return turnContext({ currentProjection: projection, ignoredLedger: ledger });
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

function reservationIdFor(material) {
  return createHash('sha256')
    .update('mythpen.manuscript.uid-reservation-id.v1\0', 'utf8')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex');
}

function volumeCreateCommand(overrides = {}) {
  return {
    kind: 'volume.create',
    title: '新卷',
    summary: '新卷摘要',
    ...overrides,
  };
}

function chapterCreateCommand(overrides = {}) {
  return {
    kind: 'chapter.create',
    containerVolumeUid: VOLUME_ACTIVE,
    requestedNum: null,
    content: '新章正文',
    sidecar: {
      title: '新章',
      outline: '新章提纲',
      status: 'pending',
      summary: '新章摘要',
      cognitive_frame: '',
      emotional_anchor: '',
      world_texture: '',
      concrete_mystery: '',
      interpersonal_tension: '',
    },
    ...overrides,
  };
}

function identityReservationFor(command, context = turnContext()) {
  const objectKind = command.kind === 'volume.create' ? 'volume' : 'chapter';
  const uid = objectKind === 'volume' ? CREATED_VOLUME_UID : CREATED_CHAPTER_UID;
  const paths = deriveManuscriptPaths({
    dataRoot: path.join(path.parse(process.cwd()).root, 'mythpen-task10b3-service'),
    projectUid: PROJECT_UID,
  });
  const pathPredicates = objectKind === 'volume'
    ? [{
      role: 'volume_index',
      canonicalPath: deriveVolumePath(paths, uid),
      parentIdentity: { dev: '1', ino: '301' },
      disposition: 'absent',
    }]
    : (() => {
      const chapterPaths = deriveChapterPaths(paths, uid);
      return [
        {
          role: 'chapter_body',
          canonicalPath: chapterPaths.bodyPath,
          parentIdentity: { dev: '1', ino: '302' },
          disposition: 'absent',
        },
        {
          role: 'chapter_sidecar',
          canonicalPath: chapterPaths.sidecarPath,
          parentIdentity: { dev: '1', ino: '302' },
          disposition: 'absent',
        },
      ];
    })();
  const material = {
    domain: 'mythpen.manuscript.uid-reservation',
    version: 1,
    assignmentKind: 'reserved_new',
    objectKind,
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    logicalRequestId: context.logicalRequestId,
    logicalInputDigest: canonicalCreateLogicalInputDigest(command),
    sourceBasisDigest: context.currentProjection.basis.basisDigest,
    uid,
    id: objectKind === 'volume' ? 9 : 13,
    ...(objectKind === 'chapter' ? {
      num: command.requestedNum ?? 4,
      containerVolumeUid: command.containerVolumeUid,
      requestedNum: command.requestedNum,
    } : {}),
    pathPredicates,
  };
  return validateIdentityReservationManifest({
    ...material,
    reservationId: reservationIdFor(material),
  });
}

function remintReservation(identityReservation, mutate) {
  const material = JSON.parse(JSON.stringify(identityReservation));
  delete material.reservationId;
  mutate(material);
  return validateIdentityReservationManifest({
    ...material,
    reservationId: reservationIdFor(material),
  });
}

function bindingFor(identityReservation, context = turnContext(), overrides = {}) {
  return deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    journalId: context.journalId,
    logicalRequestId: context.logicalRequestId,
    baseGeneration: 4,
    targetGeneration: 5,
    basisDigest: context.currentProjection.basis.basisDigest,
    logicalInputDigest: identityReservation.logicalInputDigest,
    inputDigest: 'd'.repeat(64),
    reservationDigest: 'e'.repeat(64),
    ...overrides,
  });
}

function createHarness({
  noOp = false,
  failAt = null,
  buildGate = null,
  identityReservation = null,
  lookupResults = [],
  assertedBinding = null,
} = {}) {
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
  const freshAuthority = Object.freeze(() => {});
  const resumeAuthority = Object.freeze(() => {});
  let lookupIndex = 0;

  function mark(name, value) {
    calls.push(name);
    captured[name] = value;
    if (failAt === name) throw new Error(`fail:${name}`);
  }

  const manuscriptStore = {
    async buildClosure(snapshot, command, ignoredRows, receivedReservation) {
      mark('buildClosure', {
        snapshot,
        command,
        ignoredRows,
        identityReservation: receivedReservation,
      });
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
    buildRevisionTarget(input) {
      mark('buildRevisionTarget', input);
      return target;
    },
    publish() {
      throw new Error('service must not publish a projection twice');
    },
  };
  const fileJournal = {
    lookupOrdinaryRequest(logicalRequestId) {
      mark('lookupOrdinaryRequest', logicalRequestId);
      return lookupResults[Math.min(lookupIndex++, lookupResults.length - 1)] ?? null;
    },
    readReservation(input) {
      mark('readReservation', input);
      return Object.freeze({ identityReservation, authority: resumeAuthority });
    },
    assertReservation(input) {
      mark('journal.assertReservation', input);
      return assertedBinding ?? bindingFor(identityReservation);
    },
    async recover(journalId) {
      mark('recover', journalId);
      return Object.freeze({ state: 'completed' });
    },
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
  const uidReservation = {
    async reserveNewIdentity(input) {
      mark('reserveNewIdentity', input);
      return Object.freeze({ identityReservation, authority: freshAuthority });
    },
    assertReservation(input) {
      mark('uid.assertReservation', input);
      return identityReservation;
    },
  };
  const uidPathProbe = {
    async probe(input) {
      mark('probe', input);
      throw new Error('service must pass the probe port to UID reservation, not call it directly');
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
    uidPathProbe,
    uidReservation,
  };
}

function serviceFor(harness, draftConflictIntentAuthority = null) {
  const options = {
    manuscriptStore: harness.manuscriptStore,
    fileJournal: harness.fileJournal,
    projectionStore: harness.projectionStore,
    uidReservation: harness.uidReservation,
    uidPathProbe: harness.uidPathProbe,
  };
  if (draftConflictIntentAuthority !== null) {
    options.draftConflictIntentAuthority = draftConflictIntentAuthority;
  }
  return createL2ManuscriptService(options);
}

async function executeCommand(service, command, context) {
  return service.execute(service.bindWriteIntent(command), context);
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

test('draft conflict execution accepts only its constructor-bound original apply intent and persists parent', async () => {
  const records = new WeakMap();
  const authority = Object.freeze({
    assert(intent) {
      if (!records.has(intent)) throw new TypeError('foreign draft conflict intent');
      return intent;
    },
    describe(intent) {
      const descriptor = records.get(intent);
      if (descriptor === undefined) throw new TypeError('foreign draft conflict intent');
      return descriptor;
    },
  });
  const applyIntent = Object.freeze({});
  records.set(applyIntent, deepFreeze({
    kind: 'apply',
    conflictId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    decisionEpoch: 3,
    childJournalId: JOURNAL_ID,
    externalRawSha256: 'e'.repeat(64),
    baseGeneration: 4,
    targetGeneration: 5,
    resource: { kind: 'chapter', uid: CHAPTER_ACTIVE, domain: 'body' },
  }));
  const harness = createHarness();
  const service = serviceFor(harness, authority);
  const command = Object.freeze({
    kind: 'chapter.replace_body',
    bodyRef: REFS.body,
    content: 'saved draft body',
  });
  await service.executeDraftConflict(
    service.bindWriteIntent(command),
    turnContext(),
    applyIntent,
  );
  assert.deepEqual(harness.captured.stageAssets.parent, {
    kind: 'draft_conflict',
    journalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  });

  const before = harness.calls.length;
  await assert.rejects(
    service.executeDraftConflict(
      service.bindWriteIntent(command),
      turnContext(),
      Object.freeze({}),
    ),
    TypeError,
  );
  assert.equal(harness.calls.length, before);
});

const STRUCTURAL_MUTATIONS = [
  {
    kind: 'chapter.move',
    chapterUid: CHAPTER_ACTIVE,
    targetVolumeUid: null,
    targetPosition: 0,
  },
  {
    kind: 'chapter.reorder',
    containerVolumeUid: VOLUME_ACTIVE,
    chapterUids: [CHAPTER_ACTIVE],
  },
  {
    kind: 'volume.reorder',
    volumeUids: [VOLUME_ACTIVE],
  },
  { kind: 'chapter.delete', chapterUid: CHAPTER_ACTIVE },
  { kind: 'volume.delete', volumeUid: VOLUME_ACTIVE },
  { kind: 'ignored.preserve_move_to_unassigned', chapterUid: IGNORED_UID },
  { kind: 'ignored.detach_reference', chapterUid: IGNORED_UID },
];

test('write intents are opaque service-owned authority and bind is recursively frozen zero-I/O preflight', async () => {
  const harness = createHarness();
  const service = serviceFor(harness);
  const command = chapterCreateCommand();
  const intent = service.bindWriteIntent(command);
  const authority = service.writeIntentAuthority();

  assert.deepEqual(harness.calls, []);
  assert.equal(service.writeIntentAuthority(), authority);
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(Object.isFrozen(intent), true);
  assert.deepEqual(Object.keys(intent), []);
  assert.doesNotThrow(() => authority.assert.call(authority, intent));
  assert.deepEqual(authority.describe.call(authority, intent), {
    family: 'ordinary_create',
    logicalInputDigest: canonicalCreateLogicalInputDigest(command),
  });
  assert.equal(Object.isFrozen(authority.describe.call(authority, intent)), true);
  assert.deepEqual(harness.calls, []);

  const foreign = serviceFor(createHarness());
  const foreignIntent = foreign.bindWriteIntent(volumeCreateCommand());
  for (const value of [{}, { ...intent }, foreignIntent]) {
    assert.throws(() => authority.assert.call(authority, value), TypeError);
    assert.throws(() => authority.describe.call(authority, value), TypeError);
  }
  assert.throws(() => authority.assert.call({}, intent), TypeError);
  assert.throws(() => authority.describe.call({}, intent), TypeError);
  await assert.rejects(service.execute(command, turnContext()), TypeError);

  command.sidecar.title = '绑定后篡改';
  assert.deepEqual(authority.describe.call(authority, intent), {
    family: 'ordinary_create',
    logicalInputDigest: canonicalCreateLogicalInputDigest(chapterCreateCommand()),
  });
  assert.deepEqual(harness.calls, []);

  let getterCalls = 0;
  const accessor = { kind: 'volume.create', summary: '摘要' };
  Object.defineProperty(accessor, 'title', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return '卷';
    },
  });
  for (const invalidCommand of [
    volumeCreateCommand({ extra: true }),
    chapterCreateCommand({ sidecar: { ...chapterCreateCommand().sidecar, status: 'done' } }),
    chapterCreateCommand({
      sidecar: { ...chapterCreateCommand().sidecar, format_version: 1 },
    }),
    accessor,
  ]) assert.throws(() => service.bindWriteIntent(invalidCommand), TypeError);
  assert.equal(getterCalls, 0);
  assert.deepEqual(harness.calls, []);
});

test('fresh volume and chapter create lookup before reservation, build once, and return the final durable assignment', async () => {
  for (const command of [volumeCreateCommand(), chapterCreateCommand()]) {
    const context = turnContext();
    const identityReservation = identityReservationFor(command, context);
    const durableBinding = bindingFor(identityReservation, context);
    const afterLookup = deepFreeze({
      state: 'completed',
      outcome: 'after',
      identityReservation,
      reservationBinding: durableBinding,
    });
    const harness = createHarness({
      identityReservation,
      lookupResults: [null, afterLookup],
    });
    const service = serviceFor(harness);
    const result = await service.execute(service.bindWriteIntent(command), context);

    assert.deepEqual(harness.calls, [
      'lookupOrdinaryRequest',
      'reserveNewIdentity',
      'uid.assertReservation',
      'buildClosure',
      'stageAssets',
      'finalizeCandidate',
      'buildTarget',
      'bindTarget',
      'prepare',
      'publishFiles',
      'commitProjection',
      'complete',
      'lookupOrdinaryRequest',
    ], command.kind);
    assert.strictEqual(harness.captured.buildClosure.identityReservation, identityReservation);
    assert.equal(Object.isFrozen(harness.captured.buildClosure.command), true);
    if (command.kind === 'chapter.create') {
      assert.equal(Object.isFrozen(harness.captured.buildClosure.command.sidecar), true);
    }
    assert.strictEqual(harness.captured.stageAssets.identityReservation, identityReservation);
    assert.strictEqual(
      harness.captured.reserveNewIdentity.pathProbe,
      harness.uidPathProbe,
    );
    assert.equal(
      harness.captured.reserveNewIdentity.logicalInputDigest,
      identityReservation.logicalInputDigest,
    );
    assert.equal(harness.calls.filter((name) => name === 'buildClosure').length, 1);
    assert.deepEqual(result, {
      state: 'created',
      objectKind: identityReservation.objectKind,
      uid: identityReservation.uid,
      id: identityReservation.id,
      ...(identityReservation.objectKind === 'chapter' ? { num: identityReservation.num } : {}),
      targetGeneration: durableBinding.targetGeneration,
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(
      harness.captured.buildTarget.localIdentityPlan.find(
        (entry) => entry.assignmentKind === 'reserved_new',
      ),
      {
        assignmentKind: 'reserved_new',
        objectKind: identityReservation.objectKind,
        uid: identityReservation.uid,
        id: identityReservation.id,
        ...(identityReservation.objectKind === 'chapter' ? { num: identityReservation.num } : {}),
        reservationId: identityReservation.reservationId,
      },
    );
  }
});

test('persisted create outcomes validate command identity before resume, recover, or replay', async () => {
  const command = volumeCreateCommand();
  const context = turnContext();
  const identityReservation = identityReservationFor(command, context);
  const binding = bindingFor(identityReservation, context);
  function lookup(outcome, overrides = {}) {
    return deepFreeze({
      state: outcome === 'early' ? 'assets_reserved' : outcome === 'advanced' ? 'prepared' : 'completed',
      outcome,
      identityReservation,
      reservationBinding: binding,
      ...overrides,
    });
  }

  {
    const harness = createHarness({ identityReservation, lookupResults: [lookup('after')] });
    const service = serviceFor(harness);
    const result = await service.execute(service.bindWriteIntent(command), context);
    assert.deepEqual(harness.calls, ['lookupOrdinaryRequest']);
    assert.deepEqual(result, {
      state: 'created',
      objectKind: 'volume',
      uid: CREATED_VOLUME_UID,
      id: 9,
      targetGeneration: 5,
    });
  }

  {
    const newerContext = turnContextAtGeneration(9);
    const harness = createHarness({ identityReservation, lookupResults: [lookup('after')] });
    const service = serviceFor(harness);
    const result = await service.execute(service.bindWriteIntent(command), newerContext);
    assert.deepEqual(harness.calls, ['lookupOrdinaryRequest']);
    assert.equal(result.targetGeneration, 5);
  }

  {
    const harness = createHarness({
      identityReservation,
      lookupResults: [lookup('advanced'), lookup('after')],
    });
    const service = serviceFor(harness);
    await service.execute(service.bindWriteIntent(command), context);
    assert.deepEqual(harness.calls, [
      'lookupOrdinaryRequest',
      'recover',
      'lookupOrdinaryRequest',
    ]);
  }

  {
    const driftedAfter = deepFreeze({
      ...lookup('after'),
      reservationBinding: bindingFor(identityReservation, context, {
        inputDigest: 'f'.repeat(64),
      }),
    });
    const harness = createHarness({
      identityReservation,
      lookupResults: [lookup('advanced'), driftedAfter],
    });
    const service = serviceFor(harness);
    await assert.rejects(service.execute(service.bindWriteIntent(command), context));
    assert.deepEqual(harness.calls, [
      'lookupOrdinaryRequest',
      'recover',
      'lookupOrdinaryRequest',
    ]);
  }

  {
    const harness = createHarness({ identityReservation, lookupResults: [lookup('before')] });
    const service = serviceFor(harness);
    await assert.rejects(
      service.execute(service.bindWriteIntent(command), context),
      (error) => error?.code === 'RECOVERY_REQUIRED',
    );
    assert.deepEqual(harness.calls, ['lookupOrdinaryRequest']);
  }

  for (const outcome of ['early', 'advanced', 'after', 'before']) {
    const otherCommand = volumeCreateCommand({ title: '不同命令' });
    const otherReservation = identityReservationFor(otherCommand, context);
    const mismatched = deepFreeze({
      state: outcome === 'early' ? 'assets_reserved' : outcome === 'advanced' ? 'prepared' : 'completed',
      outcome,
      identityReservation: otherReservation,
      reservationBinding: bindingFor(otherReservation, context),
    });
    const harness = createHarness({
      identityReservation: otherReservation,
      lookupResults: [mismatched],
    });
    const service = serviceFor(harness);
    await assert.rejects(service.execute(service.bindWriteIntent(command), context));
    assert.deepEqual(harness.calls, ['lookupOrdinaryRequest'], outcome);
  }
});

test('early create resumes only its journal authority, while empty create closure is never a no-op', async () => {
  const command = volumeCreateCommand();
  const context = turnContext();
  const identityReservation = identityReservationFor(command, context);
  const binding = bindingFor(identityReservation, context);
  const early = deepFreeze({
    state: 'assets_reserved',
    outcome: 'early',
    identityReservation,
    reservationBinding: binding,
  });
  const after = deepFreeze({
    state: 'completed',
    outcome: 'after',
    identityReservation,
    reservationBinding: binding,
  });
  const harness = createHarness({
    identityReservation,
    lookupResults: [early, after],
  });
  const service = serviceFor(harness);
  const result = await service.execute(service.bindWriteIntent(command), context);
  assert.deepEqual(harness.calls, [
    'lookupOrdinaryRequest',
    'readReservation',
    'journal.assertReservation',
    'buildClosure',
    'stageAssets',
    'finalizeCandidate',
    'buildTarget',
    'bindTarget',
    'prepare',
    'publishFiles',
    'commitProjection',
    'complete',
    'lookupOrdinaryRequest',
  ]);
  assert.equal(harness.calls.includes('reserveNewIdentity'), false);
  assert.equal(harness.calls.includes('uid.assertReservation'), false);
  assert.strictEqual(harness.captured.buildClosure.identityReservation, identityReservation);
  assert.strictEqual(harness.captured.stageAssets.identityReservation, identityReservation);
  assert.equal(result.targetGeneration, binding.targetGeneration);

  const empty = createHarness({
    noOp: true,
    identityReservation,
    lookupResults: [null],
  });
  const emptyService = serviceFor(empty);
  await assert.rejects(
    emptyService.execute(emptyService.bindWriteIntent(command), context),
    TypeError,
  );
  assert.deepEqual(empty.calls, [
    'lookupOrdinaryRequest',
    'reserveNewIdentity',
    'uid.assertReservation',
    'buildClosure',
  ]);
});

test('fresh and early create reject generation, basis, and allocation drift before Store use', async () => {
  const volumeCommand = volumeCreateCommand();
  const context = turnContext();
  const volumeReservation = identityReservationFor(volumeCommand, context);
  const basisDriftReservation = remintReservation(volumeReservation, (value) => {
    value.sourceBasisDigest = 'f'.repeat(64);
  });
  for (const { reservation, overrides } of [
    { reservation: volumeReservation, overrides: { baseGeneration: 3, targetGeneration: 4 } },
    { reservation: volumeReservation, overrides: { baseGeneration: 5, targetGeneration: 6 } },
    { reservation: basisDriftReservation, overrides: { basisDigest: 'f'.repeat(64) } },
  ]) {
    const driftedBinding = bindingFor(reservation, context, overrides);
    const early = deepFreeze({
      state: 'assets_reserved',
      outcome: 'early',
      identityReservation: reservation,
      reservationBinding: driftedBinding,
    });
    const harness = createHarness({
      identityReservation: reservation,
      lookupResults: [early],
      assertedBinding: driftedBinding,
    });
    const service = serviceFor(harness);
    await assert.rejects(service.execute(service.bindWriteIntent(volumeCommand), context));
    assert.deepEqual(harness.calls, [
      'lookupOrdinaryRequest',
      'readReservation',
      'journal.assertReservation',
    ]);
  }

  const chapterCommand = chapterCreateCommand();
  const chapterReservation = identityReservationFor(chapterCommand, context);
  const allocationDrifts = [
    (value) => { value.id += 1; },
    (value) => { value.num += 1; },
    (value) => { value.containerVolumeUid = null; },
    (value) => { value.num = 5; value.requestedNum = 5; },
  ];
  for (const mutate of allocationDrifts) {
    const driftedReservation = remintReservation(chapterReservation, mutate);
    const earlyBinding = bindingFor(driftedReservation, context);
    const early = deepFreeze({
      state: 'assets_reserved',
      outcome: 'early',
      identityReservation: driftedReservation,
      reservationBinding: earlyBinding,
    });
    const earlyHarness = createHarness({
      identityReservation: driftedReservation,
      lookupResults: [early],
      assertedBinding: earlyBinding,
    });
    const earlyService = serviceFor(earlyHarness);
    await assert.rejects(earlyService.execute(
      earlyService.bindWriteIntent(chapterCommand),
      context,
    ));
    assert.deepEqual(earlyHarness.calls, [
      'lookupOrdinaryRequest',
      'readReservation',
      'journal.assertReservation',
    ]);

    const freshHarness = createHarness({
      identityReservation: driftedReservation,
      lookupResults: [null],
    });
    const freshService = serviceFor(freshHarness);
    await assert.rejects(freshService.execute(
      freshService.bindWriteIntent(chapterCommand),
      context,
    ));
    assert.deepEqual(freshHarness.calls, [
      'lookupOrdinaryRequest',
      'reserveNewIdentity',
      'uid.assertReservation',
    ]);
  }
});

test('fresh and early create reject tombstone and ignored UID takeover before Store use', async () => {
  const context = turnContext();
  const cases = [
    [volumeCreateCommand(), VOLUME_TOMBSTONE, CREATED_VOLUME_UID],
    [chapterCreateCommand(), CHAPTER_TOMBSTONE, CREATED_CHAPTER_UID],
    [chapterCreateCommand(), IGNORED_UID, CREATED_CHAPTER_UID],
  ];
  for (const [command, conflictingUid, originalUid] of cases) {
    const reservation = remintReservation(identityReservationFor(command, context), (value) => {
      value.uid = conflictingUid;
      for (const predicate of value.pathPredicates) {
        predicate.canonicalPath = predicate.canonicalPath.replace(originalUid, conflictingUid);
      }
    });
    const binding = bindingFor(reservation, context);
    const early = deepFreeze({
      state: 'assets_reserved',
      outcome: 'early',
      identityReservation: reservation,
      reservationBinding: binding,
    });
    const earlyHarness = createHarness({
      identityReservation: reservation,
      lookupResults: [early],
      assertedBinding: binding,
    });
    const earlyService = serviceFor(earlyHarness);
    await assert.rejects(earlyService.execute(
      earlyService.bindWriteIntent(command),
      context,
    ));
    assert.deepEqual(earlyHarness.calls, [
      'lookupOrdinaryRequest',
      'readReservation',
      'journal.assertReservation',
    ]);

    const freshHarness = createHarness({
      identityReservation: reservation,
      lookupResults: [null],
    });
    const freshService = serviceFor(freshHarness);
    await assert.rejects(freshService.execute(
      freshService.bindWriteIntent(command),
      context,
    ));
    assert.deepEqual(freshHarness.calls, [
      'lookupOrdinaryRequest',
      'reserveNewIdentity',
      'uid.assertReservation',
    ]);
  }
});

test('ordinary service preserves the four Task 7B non-create mutations and exact full sequence', async () => {
  for (const mutation of MUTATIONS) {
    const harness = createHarness();
    const context = turnContext();
    const result = await executeCommand(serviceFor(harness), mutation, context);

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
    assert.strictEqual(harness.captured.buildClosure.ignoredRows, targetInput.ignoredLedger);
    assert.equal(targetInput.targetGeneration, 5);
    assert.equal(targetInput.projectedAt, PROJECTED_AT);
    assert.equal(targetInput.ignoredLedger[0].projection_generation, 4);
    assert.strictEqual(
      normalizeIgnoredLedgerRows(targetInput.ignoredLedger),
      targetInput.ignoredLedger,
    );
    assert.deepEqual(targetInput.localIdentityPlan, expectedIdentityPlan());
    assert.deepEqual(
      targetInput.localIdentityPlan,
      canonicalSchema12ReuseIdentityPlan(targetInput.currentProjection),
    );
    assert.equal(Object.isFrozen(targetInput.currentProjection), true);
    assert.equal(Object.isFrozen(targetInput.ignoredLedger), true);
    assert.equal(Object.isFrozen(targetInput.localIdentityPlan), true);
  }
});

test('revision resolution publishes its selected accepted chapter through one L2 target sequence', async () => {
  const harness = createHarness();
  const context = turnContext();
  context.currentProjection.basis.pendingProposals = [{ revisionId: 41, chapterId: 11 }];
  context.currentProjection.basis.basisDigest = canonicalProjectionBasisDigest(
    context.currentProjection.basis,
  );
  const resolution = Object.freeze({
    revisionId: 41,
    chapterId: 11,
    chapterUid: CHAPTER_ACTIVE,
    from: 'pending',
    to: 'accepted',
    baseContentSha256: '1'.repeat(64),
    proposedContentSha256: '2'.repeat(64),
    acceptedContentSha256: '3'.repeat(64),
    decisionsSha256: '4'.repeat(64),
    logicalRequestId: context.logicalRequestId,
    commandKind: 'revision.accept',
    commandDigest: '5'.repeat(64),
  });
  const command = Object.freeze({
    kind: 'chapter.replace_body_and_sidecar',
    bodyRef: REFS.body,
    sidecarRef: REFS.sidecar,
    content: 'accepted body',
    patch: Object.freeze({ status: 'accepted' }),
  });

  const result = await serviceFor(harness).executeRevisionResolution(
    Object.freeze({ command, revisionResolution: resolution }),
    context,
  );

  assert.deepEqual(harness.calls, [
    'buildClosure',
    'stageAssets',
    'finalizeCandidate',
    'buildRevisionTarget',
    'bindTarget',
    'prepare',
    'publishFiles',
    'commitProjection',
    'complete',
  ]);
  assert.deepEqual(result, { state: 'completed' });
  assert.strictEqual(harness.captured.buildClosure.command.bodyRef, REFS.body);
  assert.deepEqual(harness.captured.buildRevisionTarget.revisionResolution, resolution);
  assert.equal(Object.isFrozen(harness.captured.buildRevisionTarget.revisionResolution), true);
  assert.strictEqual(harness.captured.bindTarget.projectionTarget, harness.target);
});

test('revision resolution rejects extra transition or patch data before Store and journal I/O', async () => {
  const baseResolution = {
    revisionId: 41,
    chapterId: 11,
    chapterUid: CHAPTER_ACTIVE,
    from: 'pending',
    to: 'accepted',
    baseContentSha256: '1'.repeat(64),
    proposedContentSha256: '2'.repeat(64),
    acceptedContentSha256: '3'.repeat(64),
    decisionsSha256: '4'.repeat(64),
    logicalRequestId: 'logical-request-1',
    commandKind: 'revision.accept',
    commandDigest: '5'.repeat(64),
  };
  for (const input of [
    {
      command: {
        kind: 'chapter.replace_body_and_sidecar',
        bodyRef: REFS.body,
        sidecarRef: REFS.sidecar,
        content: 'accepted body',
        patch: { status: 'accepted' },
      },
      revisionResolution: { ...baseResolution, extra: true },
    },
    {
      command: {
        kind: 'chapter.replace_body_and_sidecar',
        bodyRef: REFS.body,
        sidecarRef: REFS.sidecar,
        content: 'accepted body',
        patch: { status: 'accepted', title: 'forged' },
      },
      revisionResolution: baseResolution,
    },
    {
      command: {
        kind: 'chapter.replace_body_and_sidecar',
        bodyRef: REFS.body,
        sidecarRef: REFS.sidecar,
        content: 'accepted body',
        patch: { status: 'accepted' },
      },
      revisionResolution: { ...baseResolution, logicalRequestId: 'foreign-request' },
    },
  ]) {
    const harness = createHarness();
    await assert.rejects(
      serviceFor(harness).executeRevisionResolution(input, turnContext()),
      TypeError,
    );
    assert.deepEqual(harness.calls, []);
  }
});

test('ordinary service snapshots and forwards every exact Task 10B1 structural command', async () => {
  for (const mutation of STRUCTURAL_MUTATIONS) {
    const harness = createHarness();
    const context = turnContext();
    await executeCommand(serviceFor(harness), mutation, context);

    assert.equal(harness.calls[0], 'buildClosure', mutation.kind);
    assert.deepEqual(harness.captured.buildClosure.command, mutation, mutation.kind);
    assert.equal(Object.isFrozen(harness.captured.buildClosure.command), true, mutation.kind);
    for (const value of Object.values(harness.captured.buildClosure.command)) {
      if (Array.isArray(value)) assert.equal(Object.isFrozen(value), true, mutation.kind);
    }
    assert.strictEqual(
      harness.captured.buildClosure.ignoredRows,
      harness.captured.buildTarget.ignoredLedger,
      mutation.kind,
    );
  }
});

test('chapter.move rejects same-number target collisions before Store or journal use', async () => {
  const context = turnContext();
  context.currentProjection.basis.chapters.push({
    id: 13,
    uid: CHAPTER_SAME_NUM,
    volumeId: null,
    num: 3,
    isPresent: 1,
    deletedAt: null,
    chapterPosition: 1,
    manuscriptPosition: 2,
    bodyRawSha256: '3'.repeat(64),
    status: 'pending',
  });
  context.currentProjection.basis.sqliteSequence[0].seq = 13;
  context.currentProjection.basis.basisDigest = canonicalProjectionBasisDigest(
    context.currentProjection.basis,
  );
  const harness = createHarness();

  await assert.rejects(executeCommand(serviceFor(harness), {
    kind: 'chapter.move',
    chapterUid: CHAPTER_ACTIVE,
    targetVolumeUid: null,
    targetPosition: 1,
  }, context), (error) => (
    error instanceof TypeError
    && error.message === 'chapter.move target contains the same active chapter number'
  ));
  assert.deepEqual(harness.calls, []);
});

test('structural command descriptors and arrays fail closed before Store use', async () => {
  const invalid = [
    {
      kind: 'chapter.move',
      chapterUid: CHAPTER_ACTIVE,
      targetVolumeUid: null,
      targetPosition: -0,
    },
    {
      kind: 'chapter.reorder',
      containerVolumeUid: VOLUME_ACTIVE,
      chapterUids: [CHAPTER_ACTIVE, CHAPTER_ACTIVE],
    },
    {
      kind: 'volume.delete',
      volumeUid: VOLUME_ACTIVE,
      childPolicy: 'cascade',
    },
  ];
  const sparse = [];
  sparse.length = 1;
  invalid.push({
    kind: 'volume.reorder',
    volumeUids: sparse,
  });
  let getterCalls = 0;
  const accessor = { kind: 'chapter.delete' };
  Object.defineProperty(accessor, 'chapterUid', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return CHAPTER_ACTIVE;
    },
  });
  invalid.push(accessor);

  for (const command of invalid) {
    const harness = createHarness();
    await assert.rejects(executeCommand(serviceFor(harness), command, turnContext()));
    assert.deepEqual(harness.calls, []);
  }
  assert.equal(getterCalls, 0);
});

test('10k chapter permutation admission remains bounded and reaches Store once', async () => {
  const context = turnContext();
  const chapterUids = Array.from({ length: 10_000 }, (_, index) => (
    `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
  ));
  context.currentProjection.basis.chapters = chapterUids.map((uid, index) => ({
    id: index + 1,
    uid,
    volumeId: 7,
    num: index + 1,
    isPresent: 1,
    deletedAt: null,
    chapterPosition: index + 1,
    manuscriptPosition: index + 1,
    bodyRawSha256: index.toString(16).padStart(64, '0'),
    status: 'pending',
  }));
  context.currentProjection.basis.sqliteSequence[0].seq = 10_000;
  context.currentProjection.basis.basisDigest = canonicalProjectionBasisDigest(
    context.currentProjection.basis,
  );
  const harness = createHarness();
  const startedAt = Date.now();

  await executeCommand(serviceFor(harness), {
    kind: 'chapter.reorder',
    containerVolumeUid: VOLUME_ACTIVE,
    chapterUids,
  }, context);

  assert.equal(harness.calls.filter((name) => name === 'buildClosure').length, 1);
  assert.equal(harness.captured.buildClosure.command.chapterUids.length, 10_000);
  assert.ok(Date.now() - startedAt < 5_000);
});

test('no-op returns immediately after the single closure build and never touches the journal', async () => {
  const harness = createHarness({ noOp: true });
  const result = await executeCommand(serviceFor(harness), MUTATIONS[0], turnContext());

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
  const pending = executeCommand(serviceFor(harness), command, context);

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
    memberJson(baseMembers()));
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
    await assert.rejects(executeCommand(serviceFor(harness), MUTATIONS[0], context), TypeError);
    assert.deepEqual(harness.calls, []);
  }
  assert.equal(getterCalled, false);

  const unsupported = createHarness();
  await assert.rejects(executeCommand(serviceFor(unsupported), { kind: 'chapter.create' }, turnContext()),
    TypeError);
  assert.deepEqual(unsupported.calls, []);

  const arrayKind = createHarness();
  await assert.rejects(executeCommand(serviceFor(arrayKind), {
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
  await assert.rejects(executeCommand(serviceFor(coercing), {
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
    executeCommand(serviceFor(wrongProject), MUTATIONS[0], wrongProjectContext),
    TypeError,
  );
  assert.deepEqual(wrongProject.calls, ['buildClosure']);

  const foreign = createHarness();
  const context = turnContext({ fileSnapshot: Object.freeze({ copied: true }) });
  await assert.rejects(executeCommand(serviceFor(foreign), MUTATIONS[0], context), TypeError);
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
    await assert.rejects(executeCommand(serviceFor(harness), MUTATIONS[0], turnContext()), {
      message: `fail:${failAt}`,
    });
    assert.deepEqual(harness.calls, sequence.slice(0, index + 1));
  }
});
