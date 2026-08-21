'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { LIMITS } = require('../manuscript/contracts');
const { IgnoredIdentityLedger } = require('../manuscript/ignored-ledger');
const {
  SQLiteProjectionStore,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('../manuscript/projection-store');
const { ManuscriptStore } = require('../manuscript/store');
const {
  PROJECT_UID,
  UNKNOWN_CHAPTER_UID,
  UNKNOWN_VOLUME_UID,
  UNASSIGNED_CHAPTER_UID,
  VOLUME_UID,
  createManuscriptTreeFixture,
} = require('./fixtures/manuscript-tree');

const CHAPTER_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '77777777-7777-4777-8777-777777777777';
const PROJECTED_AT = '2026-08-20T01:02:03.004Z';
const baselineCandidateByStore = new WeakMap();

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createStore(fixture, limits = LIMITS) {
  return new ManuscriptStore({
    dataRoot: fixture.dataRoot,
    fileBoundary: fixture.fileBoundary,
    journalAuthority: fixture.journalAuthority,
    limits,
  });
}

async function rememberProjectionCandidate(store, fixture, options = {}) {
  const snapshot = await store.validateFull(fixture.projectBinding, {
    ignoredLedger: options.ignoredLedger ?? fixture.ignoredLedger,
    lifecycleBasis: options.lifecycleBasis ?? fixture.lifecycleBasis,
  });
  const candidate = await store.buildProjectionCandidate(snapshot);
  baselineCandidateByStore.set(store, candidate);
  return candidate;
}

async function initialProjection(store, fixture) {
  const candidate = await rememberProjectionCandidate(store, fixture);
  const volumeIds = new Map(candidate.volumes.map((volume, index) => [volume.volumeUid, index + 1]));
  const containerNumbers = new Map();
  const chapters = candidate.chapters.map((chapter, index) => {
    const key = chapter.volumeUid ?? 'unassigned';
    const num = (containerNumbers.get(key) ?? 0) + 1;
    containerNumbers.set(key, num);
    return {
      id: index + 1,
      uid: chapter.chapterUid,
      volumeId: chapter.volumeUid === null ? null : volumeIds.get(chapter.volumeUid),
      num,
      isPresent: 1,
      deletedAt: null,
      chapterPosition: chapter.chapterPosition,
      manuscriptPosition: chapter.manuscriptPosition,
      bodyRawSha256: chapter.bodyRawSha256,
      status: chapter.status,
    };
  });
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: 1,
    volumes: candidate.volumes.map((volume, index) => ({
      id: index + 1,
      uid: volume.volumeUid,
      sortOrder: volume.volumePosition,
      isPresent: 1,
      deletedAt: null,
    })),
    chapters,
    sqliteSequence: [
      { name: 'chapters', seq: chapters.length },
      { name: 'volumes', seq: candidate.volumes.length },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return deepFreeze({ projectUid: PROJECT_UID, projectInstanceId: PROJECT_INSTANCE_ID, basis });
}

function currentProjectionFromTarget(target) {
  const invalidated = new Set(target.proposalInvalidations.map((entry) => entry.revisionId));
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: target.targetGeneration,
    volumes: target.volumes.map((row) => ({
      id: row.id,
      uid: row.volume_uid,
      sortOrder: row.is_present === 1 ? row.sort_order : 0,
      isPresent: row.is_present,
      deletedAt: row.deleted_at,
    })),
    chapters: target.chapters.map((row) => ({
      id: row.id,
      uid: row.chapter_uid,
      volumeId: row.is_present === 1 ? row.volume_id : null,
      num: row.num,
      isPresent: row.is_present,
      deletedAt: row.deleted_at,
      chapterPosition: row.chapter_position,
      manuscriptPosition: row.manuscript_position,
      bodyRawSha256: row.is_present === 1 ? row.body_raw_sha256 : null,
      status: row.is_present === 1 ? row.status : 'pending',
    })),
    sqliteSequence: target.sqliteSequence.map((row) => ({ ...row })),
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(target.ignoredLedger),
    pendingProposals: target.basis.pendingProposals.filter(
      (entry) => !invalidated.has(entry.revisionId),
    ).map((entry) => ({ ...entry })),
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return deepFreeze({
    projectUid: target.projectUid,
    projectInstanceId: target.projectInstanceId,
    basis,
  });
}

function projectionContext(currentProjection, projectedAt = PROJECTED_AT) {
  return Object.freeze({ currentProjection, projectedAt });
}

function createCasProjectStore(initial) {
  let current = initial;
  let currentIgnoredRows = [];
  let calls = 0;
  let inspectCalls = 0;
  let inspectResultOverride;
  let readCalls = 0;
  let visibleTarget = null;
  const projectStore = Object.freeze({
    inspectProjectionTarget({ target }) {
      inspectCalls += 1;
      if (inspectResultOverride !== undefined) return inspectResultOverride;
      return current.basis.baseGeneration === target.baseGeneration ? 'base' : 'unknown';
    },
    readAll(sql) {
      readCalls += 1;
      assert.match(sql, /manuscript_ignored_resources/u);
      return currentIgnoredRows.map((row) => ({ ...row }));
    },
    publishProjectionTarget({ target }) {
      calls += 1;
      if (
        target.projectUid !== current.projectUid
        || target.projectInstanceId !== current.projectInstanceId
        || target.baseGeneration !== current.basis.baseGeneration
        || target.basisDigest !== current.basis.basisDigest
        || target.basis.ignoredBeforeDigest !== current.basis.ignoredBeforeDigest
      ) {
        throw Object.assign(new Error('PROJECTION_STALE'), { code: 'PROJECTION_STALE' });
      }
      visibleTarget = target;
      current = currentProjectionFromTarget(target);
      currentIgnoredRows = target.ignoredLedger;
      return Object.freeze({
        disposition: 'after',
        generation: target.targetGeneration,
        route: 'files',
      });
    },
  });
  return Object.freeze({
    projectStore,
    replaceIgnoredRowsForTest(rows) { currentIgnoredRows = rows; },
    replaceInspectResultForTest(result) { inspectResultOverride = result; },
    observation() {
      return { calls, current, currentIgnoredRows, inspectCalls, readCalls, visibleTarget };
    },
  });
}

function serviceFor(store, projectStore) {
  const { OrphanResolutionService } = require('../manuscript/orphan-resolution-service');
  return new OrphanResolutionService({
    manuscriptStore: store,
    projectionStore: new SQLiteProjectionStore(),
    projectStore,
  });
}

function baseline(store, fixture, currentProjection, ignoredLedger) {
  return store.captureOrphanBaseline(Object.freeze({
    projectBinding: fixture.projectBinding,
    currentProjection,
    ignoredLedger,
    projectionCandidate: baselineCandidateByStore.get(store),
  }));
}

test('snapshotRequest accepts exact own chapter data, freezes it, and performs zero I/O', () => {
  const { OrphanResolutionService } = require('../manuscript/orphan-resolution-service');
  const calls = {
    describe: 0,
    preflight: 0,
    build: 0,
    publish: 0,
  };
  const service = new OrphanResolutionService({
    manuscriptStore: Object.freeze({
      describeOrphanResolution() { calls.describe += 1; },
      preflightOrphanResolution() { calls.preflight += 1; },
    }),
    projectionStore: Object.freeze({
      buildResolutionTarget() { calls.build += 1; },
      publishResolution() { calls.publish += 1; },
      verifyResolutionNoop() { calls.publish += 1; },
    }),
    projectStore: Object.freeze({
      inspectProjectionTarget() { return 'base'; },
      readAll() { return []; },
      publishProjectionTarget() {},
    }),
  });
  const input = { kind: 'chapter', uid: CHAPTER_UID };

  const request = service.snapshotRequest(input);

  assert.deepEqual(request, input);
  assert.notStrictEqual(request, input);
  assert.equal(Object.isFrozen(request), true);
  assert.deepEqual(calls, { describe: 0, preflight: 0, build: 0, publish: 0 });

  let getterCalls = 0;
  const accessor = { kind: 'chapter' };
  Object.defineProperty(accessor, 'uid', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return CHAPTER_UID;
    },
  });
  assert.throws(() => service.snapshotRequest(accessor), TypeError);
  assert.equal(getterCalls, 0);
  assert.throws(
    () => service.snapshotRequest({ kind: 'chapter', uid: CHAPTER_UID, path: 'forbidden' }),
    TypeError,
  );
  assert.deepEqual(
    service.snapshotRequest({ kind: 'volume', uid: CHAPTER_UID }),
    { kind: 'volume', uid: CHAPTER_UID },
  );
  assert.throws(() => service.snapshotRequest({ kind: 'unknown', uid: CHAPTER_UID }), TypeError);
  assert.throws(
    () => service.snapshotRequest({
      kind: 'chapter',
      uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
    }),
    (error) => error?.code === 'MANUSCRIPT_FILESET_INVALID',
  );
});

test('orphan service requires both read-only noop verification seams', () => {
  const { OrphanResolutionService } = require('../manuscript/orphan-resolution-service');
  const manuscriptStore = Object.freeze({
    describeOrphanResolution() {},
    preflightOrphanResolution() {},
  });
  const projectStore = Object.freeze({
    inspectProjectionTarget() { return 'base'; },
    readAll() { return []; },
    publishProjectionTarget() {},
  });
  assert.throws(() => new OrphanResolutionService({
    manuscriptStore,
    projectionStore: Object.freeze({
      buildResolutionTarget() {},
      publishResolution() {},
    }),
    projectStore,
  }), /projectionStore.*invalid/i);
  assert.throws(() => new OrphanResolutionService({
    manuscriptStore,
    projectionStore: Object.freeze({
      buildResolutionTarget() {},
      publishResolution() {},
      verifyResolutionNoop() {},
    }),
    projectStore: Object.freeze({
      readAll() { return []; },
      publishProjectionTarget() {},
    }),
  }), /projectStore.*invalid/i);
});

test('projection store exports the canonical schema12 reuse identity-plan producer', () => {
  const { canonicalSchema12ReuseIdentityPlan } = require('../manuscript/projection-store');
  assert.equal(typeof canonicalSchema12ReuseIdentityPlan, 'function');
});

test('canonical schema12 reuse plan covers active and tombstone identities in stable UTF-8 order', () => {
  const { canonicalSchema12ReuseIdentityPlan } = require('../manuscript/projection-store');
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  return initialProjection(store, fixture).then((current) => {
    const tombstone = structuredClone(current);
    tombstone.basis.baseGeneration = 2;
    tombstone.basis.chapters.push({
      id: 99,
      uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      volumeId: null,
      num: 99,
      isPresent: 0,
      deletedAt: '2026-08-19T01:02:03.004Z',
      chapterPosition: null,
      manuscriptPosition: null,
      bodyRawSha256: null,
      status: 'pending',
    });
    tombstone.basis.sqliteSequence[0].seq = 99;
    tombstone.basis.basisDigest = canonicalProjectionBasisDigest(tombstone.basis);
    const frozen = deepFreeze(tombstone);
    const plan = canonicalSchema12ReuseIdentityPlan(frozen);

    assert.equal(plan.length, frozen.basis.chapters.length + frozen.basis.volumes.length);
    assert.equal(plan.find((row) => row.id === 99).assignmentKind, 'reuse_uid');
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan[0]), true);
    assert.deepEqual([...plan].sort((left, right) => (
      Buffer.compare(Buffer.from(left.objectKind), Buffer.from(right.objectKind))
      || Buffer.compare(Buffer.from(left.uid), Buffer.from(right.uid))
    )), plan);
    assert.throws(
      () => canonicalSchema12ReuseIdentityPlan(structuredClone(frozen)),
      TypeError,
    );
    const missingTombstone = structuredClone(frozen);
    missingTombstone.basis.chapters.pop();
    assert.throws(
      () => canonicalSchema12ReuseIdentityPlan(deepFreeze(missingTombstone)),
      TypeError,
    );
    const emptySource = structuredClone(frozen);
    emptySource.basis.sourceKind = 'empty';
    emptySource.basis.baseGeneration = 0;
    emptySource.basis.volumes = [];
    emptySource.basis.chapters = [];
    emptySource.basis.sqliteSequence = [
      { name: 'chapters', seq: 0 },
      { name: 'volumes', seq: 0 },
    ];
    emptySource.basis.basisDigest = canonicalProjectionBasisDigest(emptySource.basis);
    assert.throws(
      () => canonicalSchema12ReuseIdentityPlan(deepFreeze(emptySource)),
      /schema12/i,
    );
  });
});

test('ignore, active no-op, revoke, and reactivate use one scan and projection-only publication', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  let current = await initialProjection(store, fixture);
  const opaque = fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);
  const request = service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID });
  let ledger = deepFreeze([]);
  let beforeCalls = fixture.controls.calls();

  const preparedIgnore = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, ledger),
  );
  let afterCalls = fixture.controls.calls();
  assert.deepEqual(afterCalls.enumerateCalls.slice(beforeCalls.enumerateCalls.length), [
    'mythpen', 'volumes', 'chapters',
  ]);
  assert.equal(Object.isFrozen(preparedIgnore), true);
  assert.deepEqual(Object.keys(preparedIgnore), []);
  const ignored = await service.publishResolution(
    preparedIgnore,
    projectionContext(current),
  );
  assert.deepEqual(ignored, { disposition: 'after', generation: 2, route: 'files' });
  let observation = adapter.observation();
  assert.equal(observation.calls, 1);
  assert.equal(observation.visibleTarget.ignoredLedger.length, 1);
  assert.deepEqual(observation.visibleTarget.ignoredLedger[0], {
    resource_kind: 'chapter',
    resource_uid: UNKNOWN_CHAPTER_UID,
    ignore_status: 'active',
    opaque_container_kind: null,
    opaque_container_uid: null,
    is_currently_referenced: 0,
    member_snapshot_json: observation.visibleTarget.ignoredLedger[0].member_snapshot_json,
    projection_generation: 2,
  });
  current = observation.current;
  ledger = observation.visibleTarget.ignoredLedger;

  beforeCalls = fixture.controls.calls();
  const preparedNoop = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, ledger),
  );
  afterCalls = fixture.controls.calls();
  assert.deepEqual(afterCalls.enumerateCalls.slice(beforeCalls.enumerateCalls.length), [
    'mythpen', 'volumes', 'chapters',
  ]);
  assert.deepEqual(
    await service.publishResolution(preparedNoop, projectionContext(current)),
    { state: 'noop' },
  );
  assert.throws(
    () => service.publishResolution(preparedNoop, projectionContext(current)),
    /stale/i,
  );
  assert.equal(adapter.observation().calls, 1);

  const preparedRevoke = await service.preflightResolution(
    'revoke_ignore',
    request,
    baseline(store, fixture, current, ledger),
  );
  assert.deepEqual(
    await service.publishResolution(preparedRevoke, projectionContext(current)),
    { disposition: 'after', generation: 3, route: 'files' },
  );
  observation = adapter.observation();
  assert.equal(observation.calls, 2);
  assert.equal(observation.visibleTarget.ignoredLedger[0].ignore_status, 'revoked');
  assert.equal(observation.visibleTarget.ignoredLedger[0].member_snapshot_json, ledger[0].member_snapshot_json);
  current = observation.current;
  ledger = observation.visibleTarget.ignoredLedger;

  await assert.rejects(
    store.validateFull(fixture.projectBinding, {
      ignoredLedger: new IgnoredIdentityLedger().toValidationEntries(
        ledger,
        current.basis.baseGeneration,
      ),
      lifecycleBasis: fixture.lifecycleBasis,
    }),
    (error) => error?.code === 'EXTERNAL_RESOURCE_CREATION_UNSUPPORTED',
  );

  const reactivated = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, ledger),
  );
  assert.deepEqual(
    await service.publishResolution(reactivated, projectionContext(current)),
    { disposition: 'after', generation: 4, route: 'files' },
  );
  observation = adapter.observation();
  assert.equal(observation.visibleTarget.ignoredLedger[0].ignore_status, 'active');
  assert.equal(observation.visibleTarget.ignoredLedger[0].member_snapshot_json, ledger[0].member_snapshot_json);
  assert.deepEqual(fixture.controls.calls().probes.filter((key) => (
    key === `chapter_body:${UNKNOWN_CHAPTER_UID}`
    || key === `chapter_sidecar:${UNKNOWN_CHAPTER_UID}`
  )).length > 0, true);
  assert.ok(opaque.bodyRef);
});

test('foreign, cloned, stale, second-unknown, and copied prepared authorities fail before publish', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const current = await initialProjection(store, fixture);
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);
  const request = service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID });
  const originalBaseline = baseline(store, fixture, current, deepFreeze([]));

  await assert.rejects(
    service.preflightResolution('caller_action', request, originalBaseline),
    /action/i,
  );
  await assert.rejects(
    service.preflightResolution('revoke_ignore', request, originalBaseline),
    /active exact ignored row/i,
  );

  await assert.rejects(
    service.preflightResolution('ignore_in_place', { ...request }, originalBaseline),
    /original.*request/i,
  );
  await assert.rejects(
    service.preflightResolution('ignore_in_place', request, Object.freeze({ ...originalBaseline })),
    /original.*baseline/i,
  );

  const prepared = await service.preflightResolution('ignore_in_place', request, originalBaseline);
  await assert.rejects(
    service.preflightResolution('ignore_in_place', request, originalBaseline),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.throws(
    () => service.publishResolution(Object.freeze({ ...prepared }), projectionContext(current)),
    /original.*prepared/i,
  );
  const foreignService = serviceFor(store, adapter.projectStore);
  assert.throws(
    () => foreignService.publishResolution(prepared, projectionContext(current)),
    /original.*prepared/i,
  );
  assert.throws(
    () => service.publishResolution(prepared, projectionContext(structuredClone(current))),
    /original.*projection/i,
  );
  assert.equal(adapter.observation().calls, 0);

  const secondFixture = createManuscriptTreeFixture();
  const secondStore = createStore(secondFixture);
  const secondCurrent = await initialProjection(secondStore, secondFixture);
  secondFixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  secondFixture.controls.addChapter('99999999-9999-4999-8999-999999999999');
  const secondAdapter = createCasProjectStore(secondCurrent);
  const secondService = serviceFor(secondStore, secondAdapter.projectStore);
  await assert.rejects(
    secondService.preflightResolution(
      'ignore_in_place',
      secondService.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
      baseline(secondStore, secondFixture, secondCurrent, deepFreeze([])),
    ),
    (error) => error?.code === 'EXTERNAL_RESOURCE_CREATION_UNSUPPORTED',
  );
  assert.equal(secondAdapter.observation().calls, 0);
});

test('resolution FULL diagnostics reject journal candidates and residues before prepared publish', async () => {
  const cases = [
    {
      name: 'journal candidate',
      arrange(fixture) {
        fixture.controls.addCandidate(
          fixture.refs.chapterBody,
          '99999999-9999-4999-8999-999999999998',
          { owned: true },
        );
      },
    },
    {
      name: 'residue',
      arrange(fixture) {
        fixture.controls.addResidue('chapters', 'unexpected.external-residue');
      },
    },
  ];
  const outcomes = [];
  for (const entry of cases) {
    const fixture = createManuscriptTreeFixture();
    const store = createStore(fixture);
    const current = await initialProjection(store, fixture);
    const originalBaseline = baseline(store, fixture, current, deepFreeze([]));
    fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
    entry.arrange(fixture);
    const adapter = createCasProjectStore(current);
    const service = serviceFor(store, adapter.projectStore);
    try {
      await service.preflightResolution(
        'ignore_in_place',
        service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
        originalBaseline,
      );
      outcomes.push({ name: entry.name, result: 'prepared' });
    } catch (error) {
      outcomes.push({ name: entry.name, result: error?.code });
    }
    assert.equal(adapter.observation().calls, 0);
  }
  assert.deepEqual(outcomes, cases.map((entry) => ({
    name: entry.name,
    result: 'RECOVERY_REQUIRED',
  })));
});

test('wrong absent target, changed active identity facts, and capacity failure mint no prepared publish', async () => {
  const absentFixture = createManuscriptTreeFixture();
  const absentStore = createStore(absentFixture);
  const absentCurrent = await initialProjection(absentStore, absentFixture);
  const absentAdapter = createCasProjectStore(absentCurrent);
  const absentService = serviceFor(absentStore, absentAdapter.projectStore);
  await assert.rejects(
    absentService.preflightResolution(
      'ignore_in_place',
      absentService.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
      baseline(absentStore, absentFixture, absentCurrent, deepFreeze([])),
    ),
    /target.*members/i,
  );
  assert.equal(absentAdapter.observation().calls, 0);

  const changedFixture = createManuscriptTreeFixture();
  const changedStore = createStore(changedFixture);
  let changedCurrent = await initialProjection(changedStore, changedFixture);
  const changedOpaque = changedFixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const changedAdapter = createCasProjectStore(changedCurrent);
  const changedService = serviceFor(changedStore, changedAdapter.projectStore);
  const changedRequest = changedService.snapshotRequest({
    kind: 'chapter',
    uid: UNKNOWN_CHAPTER_UID,
  });
  const firstPrepared = await changedService.preflightResolution(
    'ignore_in_place',
    changedRequest,
    baseline(changedStore, changedFixture, changedCurrent, deepFreeze([])),
  );
  changedService.publishResolution(firstPrepared, projectionContext(changedCurrent));
  let changedObservation = changedAdapter.observation();
  changedCurrent = changedObservation.current;
  const changedLedger = changedObservation.visibleTarget.ignoredLedger;
  changedFixture.controls.setBytes(changedOpaque.bodyRef, 'external identity-sized change');
  await assert.rejects(
    changedService.preflightResolution(
      'ignore_in_place',
      changedRequest,
      baseline(changedStore, changedFixture, changedCurrent, changedLedger),
    ),
    /identity facts/i,
  );
  assert.equal(changedAdapter.observation().calls, 1);

  const capacityFixture = createManuscriptTreeFixture();
  const capacityStore = createStore(capacityFixture, {
    ...LIMITS,
    chapterIdentities: 2,
  });
  const capacityCurrent = await initialProjection(capacityStore, capacityFixture);
  capacityFixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const capacityAdapter = createCasProjectStore(capacityCurrent);
  const capacityService = serviceFor(capacityStore, capacityAdapter.projectStore);
  await assert.rejects(
    capacityService.preflightResolution(
      'ignore_in_place',
      capacityService.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
      baseline(capacityStore, capacityFixture, capacityCurrent, deepFreeze([])),
    ),
    (error) => error?.code === 'MANUSCRIPT_CONTENT_TOO_LARGE',
  );
  assert.equal(capacityAdapter.observation().calls, 0);

  const nonTargetFixture = createManuscriptTreeFixture();
  const nonTargetStore = createStore(nonTargetFixture);
  const nonTargetCurrent = await initialProjection(nonTargetStore, nonTargetFixture);
  nonTargetFixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  nonTargetFixture.controls.setBytes(nonTargetFixture.refs.chapterBody, 'changed known body');
  const nonTargetAdapter = createCasProjectStore(nonTargetCurrent);
  const nonTargetService = serviceFor(nonTargetStore, nonTargetAdapter.projectStore);
  await assert.rejects(
    nonTargetService.preflightResolution(
      'ignore_in_place',
      nonTargetService.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
      baseline(nonTargetStore, nonTargetFixture, nonTargetCurrent, deepFreeze([])),
    ),
    /non-target.*projection/i,
  );
  assert.equal(nonTargetAdapter.observation().calls, 0);
});

test('non-target metadata and controlled file facts reject before orphan publication', async () => {
  const cases = [
    ...[
      'title',
      'outline',
      'summary',
      'cognitive_frame',
      'emotional_anchor',
      'world_texture',
      'concrete_mystery',
      'interpersonal_tension',
    ].map((field) => ({
      name: `chapter sidecar ${field}`,
      mutate(fixture) {
        fixture.controls.setJson(fixture.refs.chapterSidecar, {
          ...fixture.values.chapter,
          [field]: `drift-${field}`,
        });
      },
    })),
    ...['title', 'summary'].map((field) => ({
      name: `volume ${field}`,
      mutate(fixture) {
        fixture.controls.setJson(fixture.refs.volume, {
          ...fixture.values.volume,
          [field]: `drift-${field}`,
        });
      },
    })),
    {
      name: 'controlled raw hash and byte size',
      mutate(fixture) {
        fixture.controls.setJson(fixture.refs.volume, {
          ...fixture.values.volume,
          title: '第一卷-controlled-fact-drift',
        });
      },
    },
    {
      name: 'controlled file identity',
      mutate(fixture) {
        fixture.controls.deleteFile(fixture.refs.volume);
        fixture.controls.addVolume(VOLUME_UID, fixture.values.volume);
      },
    },
  ];
  const outcomes = [];

  for (const entry of cases) {
    const fixture = createManuscriptTreeFixture();
    const store = createStore(fixture);
    const current = await initialProjection(store, fixture);
    const originalBaseline = baseline(store, fixture, current, deepFreeze([]));
    entry.mutate(fixture);
    fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
    const adapter = createCasProjectStore(current);
    const service = serviceFor(store, adapter.projectStore);
    try {
      await service.preflightResolution(
        'ignore_in_place',
        service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
        originalBaseline,
      );
      outcomes.push({ name: entry.name, result: 'prepared' });
    } catch (error) {
      outcomes.push({ name: entry.name, result: error?.message });
    }
    assert.equal(adapter.observation().calls, 0);
  }

  assert.deepEqual(
    outcomes,
    cases.map((entry) => ({
      name: entry.name,
      result: 'orphan resolution found a non-target projection or file fact change',
    })),
  );
});

test('active ignored no-op validates non-target full facts before returning noop', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  let current = await initialProjection(store, fixture);
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);
  const request = service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID });
  const prepared = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, deepFreeze([])),
  );
  service.publishResolution(prepared, projectionContext(current));
  let observation = adapter.observation();
  current = observation.current;
  const activeLedger = observation.visibleTarget.ignoredLedger;
  const noopBaseline = baseline(store, fixture, current, activeLedger);
  fixture.controls.setJson(fixture.refs.chapterSidecar, {
    ...fixture.values.chapter,
    emotional_anchor: 'drift-before-noop',
  });

  await assert.rejects(
    service.preflightResolution('ignore_in_place', request, noopBaseline),
    /non-target projection or file fact change/i,
  );
  observation = adapter.observation();
  assert.equal(observation.calls, 1);
  assert.equal(observation.visibleTarget.targetGeneration, 2);
});

test('active no-op rejects live revoke and generation advance after preflight', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  let current = await initialProjection(store, fixture);
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);
  const request = service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID });
  const active = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, deepFreeze([])),
  );
  service.publishResolution(active, projectionContext(current));
  let observation = adapter.observation();
  current = observation.current;
  const activeLedger = observation.visibleTarget.ignoredLedger;
  const noopPrepared = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, activeLedger),
  );
  const revokePrepared = await service.preflightResolution(
    'revoke_ignore',
    request,
    baseline(store, fixture, current, activeLedger),
  );
  service.publishResolution(revokePrepared, projectionContext(current));
  observation = adapter.observation();
  assert.equal(observation.current.basis.baseGeneration, 3);
  assert.equal(observation.visibleTarget.ignoredLedger[0].ignore_status, 'revoked');

  assert.throws(
    () => service.publishResolution(noopPrepared, projectionContext(current)),
    (error) => error?.code === 'PROJECTION_STALE',
  );
  observation = adapter.observation();
  assert.equal(observation.calls, 2);
  assert.equal(observation.current.basis.baseGeneration, 3);
});

test('active no-op rejects a plain inspect disposition before returning noop', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  let current = await initialProjection(store, fixture);
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);
  const request = service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID });
  const active = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, deepFreeze([])),
  );
  service.publishResolution(active, projectionContext(current));
  let observation = adapter.observation();
  current = observation.current;
  const noopPrepared = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, observation.visibleTarget.ignoredLedger),
  );
  adapter.replaceInspectResultForTest(Object.freeze({ disposition: 'base' }));

  assert.throws(
    () => service.publishResolution(noopPrepared, projectionContext(current)),
    (error) => error?.code === 'PROJECTION_STALE',
  );
  observation = adapter.observation();
  assert.equal(observation.calls, 1);
  assert.equal(observation.inspectCalls, 1);
  assert.equal(observation.current.basis.baseGeneration, 2);
});

test('new active indexed chapter allows only its exact volume-index insertion', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const current = await initialProjection(store, fixture);
  const originalBaseline = baseline(store, fixture, current, deepFreeze([]));
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  fixture.controls.deleteFile(fixture.refs.volume);
  fixture.controls.addVolume(VOLUME_UID, {
    ...fixture.values.volume,
    chapter_uids: [...fixture.values.volume.chapter_uids, UNKNOWN_CHAPTER_UID],
  });
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);

  const prepared = await service.preflightResolution(
    'ignore_in_place',
    service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
    originalBaseline,
  );
  assert.deepEqual(
    service.publishResolution(prepared, projectionContext(current)),
    { disposition: 'after', generation: 2, route: 'files' },
  );
  const observation = adapter.observation();
  assert.equal(observation.calls, 1);
  assert.deepEqual(
    {
      containerKind: observation.visibleTarget.ignoredLedger[0].opaque_container_kind,
      containerUid: observation.visibleTarget.ignoredLedger[0].opaque_container_uid,
      referenced: observation.visibleTarget.ignoredLedger[0].is_currently_referenced,
    },
    { containerKind: 'volume', containerUid: VOLUME_UID, referenced: 1 },
  );
});

test('new active indexed volume allows only its exact manuscript-index insertion', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const current = await initialProjection(store, fixture);
  const originalBaseline = baseline(store, fixture, current, deepFreeze([]));
  fixture.controls.addVolume(UNKNOWN_VOLUME_UID);
  fixture.controls.setJson(fixture.refs.manuscript, {
    ...fixture.values.manuscript,
    volume_uids: [...fixture.values.manuscript.volume_uids, UNKNOWN_VOLUME_UID],
  });
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);

  const prepared = await service.preflightResolution(
    'ignore_in_place',
    service.snapshotRequest({ kind: 'volume', uid: UNKNOWN_VOLUME_UID }),
    originalBaseline,
  );
  assert.deepEqual(
    service.publishResolution(prepared, projectionContext(current)),
    { disposition: 'after', generation: 2, route: 'files' },
  );
  const observation = adapter.observation();
  assert.equal(observation.calls, 1);
  assert.deepEqual(
    {
      containerKind: observation.visibleTarget.ignoredLedger[0].opaque_container_kind,
      containerUid: observation.visibleTarget.ignoredLedger[0].opaque_container_uid,
      referenced: observation.visibleTarget.ignoredLedger[0].is_currently_referenced,
    },
    { containerKind: 'manuscript', containerUid: null, referenced: 1 },
  );
});

test('indexed target insertion cannot hide parent metadata or known-order drift', async () => {
  const metadataFixture = createManuscriptTreeFixture();
  const metadataStore = createStore(metadataFixture);
  const metadataCurrent = await initialProjection(metadataStore, metadataFixture);
  const metadataBaseline = baseline(
    metadataStore,
    metadataFixture,
    metadataCurrent,
    deepFreeze([]),
  );
  metadataFixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  metadataFixture.controls.setJson(metadataFixture.refs.volume, {
    ...metadataFixture.values.volume,
    title: '夹带的非目标标题',
    chapter_uids: [...metadataFixture.values.volume.chapter_uids, UNKNOWN_CHAPTER_UID],
  });
  const metadataAdapter = createCasProjectStore(metadataCurrent);
  const metadataService = serviceFor(metadataStore, metadataAdapter.projectStore);
  await assert.rejects(
    metadataService.preflightResolution(
      'ignore_in_place',
      metadataService.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
      metadataBaseline,
    ),
    /non-target projection or file fact change/i,
  );
  assert.equal(metadataAdapter.observation().calls, 0);

  const orderFixture = createManuscriptTreeFixture();
  orderFixture.controls.setJson(orderFixture.refs.volume, {
    ...orderFixture.values.volume,
    chapter_uids: [...orderFixture.values.volume.chapter_uids, UNASSIGNED_CHAPTER_UID],
  });
  orderFixture.controls.setJson(orderFixture.refs.unassigned, {
    ...orderFixture.values.unassigned,
    chapter_uids: [],
  });
  const orderStore = createStore(orderFixture);
  const orderCurrent = await initialProjection(orderStore, orderFixture);
  const orderBaseline = baseline(orderStore, orderFixture, orderCurrent, deepFreeze([]));
  orderFixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  orderFixture.controls.setJson(orderFixture.refs.volume, {
    ...orderFixture.values.volume,
    chapter_uids: [
      UNASSIGNED_CHAPTER_UID,
      UNKNOWN_CHAPTER_UID,
      ...orderFixture.values.volume.chapter_uids,
    ],
  });
  const orderAdapter = createCasProjectStore(orderCurrent);
  const orderService = serviceFor(orderStore, orderAdapter.projectStore);
  await assert.rejects(
    orderService.preflightResolution(
      'ignore_in_place',
      orderService.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
      orderBaseline,
    ),
    /non-target projection or file fact change/i,
  );
  assert.equal(orderAdapter.observation().calls, 0);
});

test('ignored-ledger digest drift rejects before projection publication', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const current = await initialProjection(store, fixture);
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const adapter = createCasProjectStore(current);
  const service = serviceFor(store, adapter.projectStore);
  const prepared = await service.preflightResolution(
    'ignore_in_place',
    service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID }),
    baseline(store, fixture, current, deepFreeze([])),
  );
  adapter.replaceIgnoredRowsForTest([{
    resource_kind: 'chapter',
    resource_uid: '99999999-9999-4999-8999-999999999999',
    ignore_status: 'active',
    opaque_container_kind: null,
    opaque_container_uid: null,
    is_currently_referenced: 0,
    member_snapshot_json: JSON.stringify({
      version: 1,
      members: [
        { role: 'chapter_body', present: false },
        { role: 'chapter_sidecar', present: false },
      ],
    }),
    projection_generation: 1,
  }]);

  assert.throws(
    () => service.publishResolution(prepared, projectionContext(current)),
    (error) => error?.code === 'PROJECTION_STALE',
  );
  assert.deepEqual(adapter.observation(), {
    calls: 0,
    current,
    currentIgnoredRows: adapter.observation().currentIgnoredRows,
    inspectCalls: 0,
    readCalls: 1,
    visibleTarget: null,
  });
});

test('projection-only ignore commits through the real proof-bound schema12 project store', async (t) => {
  const { Database } = require('bun:sqlite');
  const { buildSchema12Candidate } = require('../native/durability-schema');
  const { createProofBoundSchema12ProjectStore } = require('../native/native-project-store');
  const { createNativeStageBFixture } = require('../testing/native-stage-b-fixture');
  const {
    CREATION_ID,
    createEmptyProjectionTarget,
  } = require('./fixtures/project-creation-crash');

  const nativeFixture = createNativeStageBFixture({ name: 'task-l2-10a2-real-adapter' });
  let projectStore = null;
  t.after(() => {
    if (projectStore?.state === 'active') projectStore.close();
    fs.rmSync(nativeFixture.root, { recursive: true, force: true });
  });
  const source = new Database(nativeFixture.databasePath, { readonly: true, strict: true });
  const projectInstanceId = source.query(
    "SELECT value FROM project_meta WHERE key = 'project_instance_id'",
  ).get().value;
  source.close(true);
  const creation = await createEmptyProjectionTarget({
    dataRoot: path.join(nativeFixture.root, 'empty-files'),
    projectInstanceId,
  });
  const candidatePath = path.join(path.dirname(nativeFixture.databasePath), 'orphan.schema12.candidate');
  buildSchema12Candidate(deepFreeze({
    sourcePath: nativeFixture.databasePath,
    candidatePath,
    creationId: CREATION_ID,
    sourceKind: 'empty',
    transitionKind: 'new_creation',
    target: creation.target,
  }));
  const commonFacts = deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId,
    route: 'files',
    routeJournal: CREATION_ID,
    projectionGeneration: 1,
  });
  projectStore = createProofBoundSchema12ProjectStore({
    admission: deepFreeze({
      route: 'files',
      databaseFacts: { schemaVersion: 12, ...commonFacts },
      routeFacts: { ...commonFacts },
      activatedProof: {
        kind: 'creation',
        state: 'activated',
        journalId: CREATION_ID,
        projectUid: PROJECT_UID,
        projectInstanceId,
        targetGeneration: 1,
      },
    }),
    databasePath: candidatePath,
    assertWriterLease() { return true; },
  });

  const fixture = createManuscriptTreeFixture();
  fixture.controls.setJson(fixture.refs.manuscript, {
    ...fixture.values.manuscript,
    volume_uids: [],
  });
  fixture.controls.setJson(fixture.refs.unassigned, {
    ...fixture.values.unassigned,
    chapter_uids: [],
  });
  for (const ref of [
    fixture.refs.volume,
    fixture.refs.chapterBody,
    fixture.refs.chapterSidecar,
    fixture.refs.unassignedBody,
    fixture.refs.unassignedSidecar,
  ]) fixture.controls.deleteFile(ref);
  const store = createStore(fixture);
  await rememberProjectionCandidate(store, fixture);
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  const current = currentProjectionFromTarget(creation.target);
  const service = serviceFor(store, projectStore);
  const request = service.snapshotRequest({ kind: 'chapter', uid: UNKNOWN_CHAPTER_UID });
  const prepared = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, current, deepFreeze([])),
  );

  assert.deepEqual(
    service.publishResolution(prepared, projectionContext(current)),
    { disposition: 'after', generation: 2, route: 'files' },
  );
  assert.deepEqual(projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
  ), { value: '2' });
  assert.deepEqual(projectStore.readGet(
    'SELECT resource_uid, ignore_status, projection_generation FROM manuscript_ignored_resources',
  ), {
    resource_uid: UNKNOWN_CHAPTER_UID,
    ignore_status: 'active',
    projection_generation: 2,
  });
  const liveRows = projectStore.readAll(`
    SELECT resource_kind, resource_uid, ignore_status,
           opaque_container_kind, opaque_container_uid,
           is_currently_referenced, member_snapshot_json,
           projection_generation
    FROM manuscript_ignored_resources
    ORDER BY resource_kind, resource_uid
  `);
  const noopCurrentValue = structuredClone(current);
  noopCurrentValue.basis.baseGeneration = 2;
  noopCurrentValue.basis.ignoredBeforeDigest = canonicalIgnoredLedgerDigest(liveRows);
  noopCurrentValue.basis.basisDigest = canonicalProjectionBasisDigest(noopCurrentValue.basis);
  const noopCurrent = deepFreeze(noopCurrentValue);
  await rememberProjectionCandidate(store, fixture, {
    ignoredLedger: new IgnoredIdentityLedger().toValidationEntries(liveRows, 2),
  });
  const noopPrepared = await service.preflightResolution(
    'ignore_in_place',
    request,
    baseline(store, fixture, noopCurrent, deepFreeze(liveRows)),
  );
  assert.deepEqual(
    service.publishResolution(noopPrepared, projectionContext(noopCurrent)),
    { state: 'noop' },
  );
  assert.deepEqual(projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
  ), { value: '2' });
});
