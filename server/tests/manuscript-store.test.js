'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { LIMITS } = require('../manuscript/contracts');
const { serializeCanonicalJson } = require('../manuscript/format');
const { normalizeIgnoredLedgerRows } = require('../manuscript/ignored-ledger');
const {
  deriveChapterPaths,
  deriveManuscriptPaths,
  deriveVolumePath,
} = require('../manuscript/paths');
const {
  SQLiteProjectionStore,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('../manuscript/projection-store');
const storeModule = require('../manuscript/store');
const { ManuscriptStore } = storeModule;
const {
  canonicalCreateLogicalInputDigest,
  validateIdentityReservationManifest,
} = require('../manuscript/uid-reservation');
const {
  CHAPTER_UID,
  PROJECT_UID,
  UNASSIGNED_CHAPTER_UID,
  UNKNOWN_CHAPTER_UID,
  UNKNOWN_VOLUME_UID,
  VOLUME_UID,
  createManuscriptTreeFixture,
  refKey,
} = require('./fixtures/manuscript-tree');

const CREATED_VOLUME_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CREATED_CHAPTER_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT_INSTANCE_ID = '77777777-7777-4777-8777-777777777777';

function limits(overrides = {}) {
  return { ...LIMITS, ...overrides };
}

function createStore(fixture, overrides = {}) {
  return new ManuscriptStore({
    dataRoot: fixture.dataRoot,
    fileBoundary: fixture.fileBoundary,
    journalAuthority: fixture.journalAuthority,
    limits: limits(overrides),
  });
}

async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code && error.message === code);
}

async function captureCode(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error?.code ?? null;
  }
}

function validationOptions(fixture, overrides = {}) {
  return {
    ignoredLedger: fixture.ignoredLedger,
    lifecycleBasis: fixture.lifecycleBasis,
    ...overrides,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function reservationIdFor(material) {
  return createHash('sha256')
    .update('mythpen.manuscript.uid-reservation-id.v1\0', 'utf8')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex');
}

function createReservation(fixture, command, parentIdentity) {
  const objectKind = command.kind === 'volume.create' ? 'volume' : 'chapter';
  const uid = objectKind === 'volume' ? CREATED_VOLUME_UID : CREATED_CHAPTER_UID;
  const paths = deriveManuscriptPaths({
    dataRoot: fixture.dataRoot,
    projectUid: PROJECT_UID,
  });
  const pathPredicates = objectKind === 'volume'
    ? [{
      role: 'volume_index',
      canonicalPath: deriveVolumePath(paths, uid),
      parentIdentity,
      disposition: 'absent',
    }]
    : (() => {
      const chapterPaths = deriveChapterPaths(paths, uid);
      return [
        {
          role: 'chapter_body',
          canonicalPath: chapterPaths.bodyPath,
          parentIdentity,
          disposition: 'absent',
        },
        {
          role: 'chapter_sidecar',
          canonicalPath: chapterPaths.sidecarPath,
          parentIdentity,
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
    logicalRequestId: 'task10b3-store-create',
    logicalInputDigest: canonicalCreateLogicalInputDigest(command),
    sourceBasisDigest: 'a'.repeat(64),
    uid,
    id: objectKind === 'volume' ? 2 : 3,
    ...(objectKind === 'chapter' ? {
      num: command.requestedNum ?? 2,
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

function remintReservation(reservation, mutate) {
  const material = JSON.parse(JSON.stringify(reservation));
  delete material.reservationId;
  mutate(material);
  return validateIdentityReservationManifest({
    ...material,
    reservationId: reservationIdFor(material),
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function stagedFact(templateFact, ino) {
  return Object.freeze({
    ref: templateFact.ref,
    byteSize: templateFact.byteSize,
    rawSha256: templateFact.rawSha256,
    fileIdentity: Object.freeze({ dev: templateFact.parentIdentity.dev, ino: String(ino) }),
    parentIdentity: templateFact.parentIdentity,
  });
}

function canonicalObservedMembers(members) {
  return members.map((member) => (member.present
    ? {
      role: member.role,
      present: true,
      byteSize: member.byteSize,
      fileIdentity: { ...member.fileIdentity },
      parentIdentity: { ...member.parentIdentity },
    }
    : { role: member.role, present: false }));
}

function ignoredRowsFor(snapshot, generation = 1) {
  return normalizeIgnoredLedgerRows(snapshot.ignoredMemberObservations.map((observation) => ({
    resource_kind: observation.kind,
    resource_uid: observation.uid,
    ignore_status: observation.status,
    opaque_container_kind: observation.reference.containerKind,
    opaque_container_uid: observation.reference.containerUid,
    is_currently_referenced: observation.reference.state === 'indexed' ? 1 : 0,
    member_snapshot_json: JSON.stringify({
      version: 1,
      members: canonicalObservedMembers(observation.members),
    }),
    projection_generation: generation,
  })));
}

function buildClosure(
  store,
  snapshot,
  mutation,
  rows = ignoredRowsFor(snapshot),
  identityReservation = null,
) {
  return store.buildClosure(snapshot, mutation, rows, identityReservation);
}

function currentProjectionFor(candidate) {
  const chapters = candidate.chapters.map((chapter, index) => ({
    id: index + 1,
    uid: chapter.chapterUid,
    volumeId: chapter.volumeUid === null ? null : 1,
    num: 1,
    isPresent: 1,
    deletedAt: null,
    chapterPosition: chapter.chapterPosition,
    manuscriptPosition: chapter.manuscriptPosition,
    bodyRawSha256: chapter.bodyRawSha256,
    status: chapter.status,
  }));
  const material = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: 1,
    volumes: [{
      id: 1,
      uid: VOLUME_UID,
      sortOrder: 1,
      isPresent: 1,
      deletedAt: null,
    }],
    chapters,
    sqliteSequence: [
      { name: 'chapters', seq: chapters.length },
      { name: 'volumes', seq: 1 },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  material.basisDigest = canonicalProjectionBasisDigest(deepFreeze({
    ...material,
    chapters: material.chapters.map((chapter) => ({ ...chapter })),
    pendingProposals: [],
    sqliteSequence: material.sqliteSequence.map((row) => ({ ...row })),
    volumes: material.volumes.map((volume) => ({ ...volume })),
  }));
  return deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId: '77777777-7777-4777-8777-777777777777',
    basis: material,
  });
}

function reuseIdentityPlan(candidate) {
  return deepFreeze([
    ...candidate.chapters.map((chapter, index) => ({
      assignmentKind: 'reuse_uid',
      objectKind: 'chapter',
      uid: chapter.chapterUid,
      id: index + 1,
      num: 1,
    })),
    ...candidate.volumes.map((volume, index) => ({
      assignmentKind: 'reuse_uid',
      objectKind: 'volume',
      uid: volume.volumeUid,
      id: index + 1,
    })),
  ].sort((left, right) => (
    Buffer.compare(Buffer.from(left.objectKind), Buffer.from(right.objectKind))
    || Buffer.compare(Buffer.from(left.uid), Buffer.from(right.uid))
  )));
}

test('ManuscriptStore exposes only explicit read capabilities and has no filesystem fallback', () => {
  assert.equal(typeof ManuscriptStore, 'function');
  assert.equal(storeModule.createFileBoundaryCapability, undefined);
  assert.equal(storeModule.createJournalAuthorityCapability, undefined);
  const fixture = createManuscriptTreeFixture();
  assert.throws(
    () => new ManuscriptStore({
      dataRoot: fixture.dataRoot,
      fileBoundary: { ...fixture.fileBoundary },
      journalAuthority: fixture.journalAuthority,
      limits: LIMITS,
    }),
    TypeError,
  );
  assert.throws(
    () => new ManuscriptStore({
      dataRoot: fixture.dataRoot,
      fileBoundary: fixture.fileBoundary,
      journalAuthority: { ...fixture.journalAuthority },
      limits: LIMITS,
    }),
    TypeError,
  );
  const store = createStore(fixture);
  assert.equal(typeof store.buildClosure, 'function');
  assert.equal(typeof store.finalizeCandidate, 'function');
});

test('buildClosure rereads only the changed body and finalizeCandidate injects its staged identity', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
  const beforeCandidate = await store.buildProjectionCandidate(snapshot);
  const readsBefore = fixture.controls.calls().contentReads;

  const content = '替换后的正文';
  const afterBytes = Buffer.from(content, 'utf8');
  const buildResult = await buildClosure(store, snapshot, {
    kind: 'chapter.replace_body',
    bodyRef: fixture.refs.chapterBody,
    content,
  });

  assert.equal(fixture.controls.calls().contentReads, readsBefore + 1);
  assert.equal(Object.isFrozen(buildResult), true);
  assert.equal(Object.isFrozen(buildResult.closure), true);
  assert.equal(Object.isFrozen(buildResult.candidateTemplate), true);
  assert.equal(buildResult.closure.length, 1);
  assert.deepEqual(buildResult.closure[0].ref, fixture.refs.chapterBody);
  assert.equal(buildResult.closure[0].before.bytes.toString('utf8'), '第一章正文');
  assert.equal(buildResult.closure[0].before.rawSha256, beforeCandidate.chapters[0].bodyRawSha256);
  assert.equal(buildResult.closure[0].after.bytes.equals(afterBytes), true);
  assert.equal(buildResult.closure[0].after.rawSha256, sha256(afterBytes));

  const templateFact = buildResult.candidateTemplate.controlledFiles.find(
    (fact) => fact.role === 'chapter_body' && fact.resourceUid === CHAPTER_UID,
  );
  const templateChapter = buildResult.candidateTemplate.chapters.find(
    (chapter) => chapter.chapterUid === CHAPTER_UID,
  );
  assert.equal(templateFact.fileIdentity, null);
  assert.equal(templateChapter.bodyFileIdentity, null);
  assert.equal(templateChapter.content, content);
  assert.equal(templateChapter.bodyRawSha256, sha256(afterBytes));

  const candidate = store.finalizeCandidate(buildResult, Object.freeze([
    stagedFact(templateFact, 9001),
  ]));
  const finalFact = candidate.controlledFiles.find(
    (fact) => fact.role === 'chapter_body' && fact.resourceUid === CHAPTER_UID,
  );
  const finalChapter = candidate.chapters.find((chapter) => chapter.chapterUid === CHAPTER_UID);
  assert.deepEqual(finalFact.fileIdentity, { dev: templateFact.parentIdentity.dev, ino: '9001' });
  assert.equal(finalChapter.bodyFileIdentity, finalFact.fileIdentity);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(finalFact.fileIdentity), true);

  const currentProjection = currentProjectionFor(beforeCandidate);
  assert.doesNotThrow(() => new SQLiteProjectionStore().buildTarget({
    candidate,
    currentProjection,
    targetGeneration: 2,
    projectedAt: '2026-08-18T00:00:00.000Z',
    ignoredLedger: deepFreeze([]),
    localIdentityPlan: reuseIdentityPlan(beforeCandidate),
  }));
});

test('buildClosure compiles sidecar, combined, and volume metadata updates with canonical bytes', async () => {
  const rows = [
    {
      name: 'sidecar',
      mutation(fixture) {
        return {
          kind: 'chapter.patch_sidecar',
          sidecarRef: fixture.refs.chapterSidecar,
          patch: { title: '新章名', status: 'writing' },
        };
      },
      expectedRoles: ['chapter_sidecar'],
    },
    {
      name: 'body plus sidecar',
      mutation(fixture) {
        return {
          kind: 'chapter.replace_body_and_sidecar',
          bodyRef: fixture.refs.chapterBody,
          sidecarRef: fixture.refs.chapterSidecar,
          content: '组合正文',
          patch: { summary: '组合摘要' },
        };
      },
      expectedRoles: ['chapter_body', 'chapter_sidecar'],
    },
    {
      name: 'volume metadata',
      mutation(fixture) {
        return {
          kind: 'volume.patch_metadata',
          volumeRef: fixture.refs.volume,
          patch: { title: '第二卷名', summary: '第二卷摘要' },
        };
      },
      expectedRoles: ['volume_index'],
    },
  ];

  for (const row of rows) {
    const fixture = createManuscriptTreeFixture();
    const store = createStore(fixture);
    const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
    const buildResult = await buildClosure(store, snapshot, row.mutation(fixture));
    assert.deepEqual(buildResult.closure.map((member) => member.ref.role), row.expectedRoles, row.name);
    assert.equal(
      fixture.controls.calls().contentReads,
      7 + row.expectedRoles.length,
      row.name,
    );
    if (row.name === 'volume metadata') {
      const expected = serializeCanonicalJson('volume_index', {
        ...fixture.values.volume,
        title: '第二卷名',
        summary: '第二卷摘要',
      });
      assert.equal(buildResult.closure[0].after.bytes.equals(expected), true);
      assert.deepEqual(
        buildResult.candidateTemplate.volumes[0],
        {
          summary: '第二卷摘要',
          title: '第二卷名',
          volumePosition: 1,
          volumeUid: VOLUME_UID,
        },
      );
    }
  }
});

test('buildClosure rejects copied or foreign snapshots, unsupported markdown, and exact-before drift', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
  const mutation = {
    kind: 'chapter.replace_body',
    bodyRef: fixture.refs.chapterBody,
    content: '合法正文',
  };
  await assert.rejects(buildClosure(store, { ...snapshot }, mutation), TypeError);

  const otherFixture = createManuscriptTreeFixture({
    dataRoot: fixture.dataRoot.replace('mythpen-store-fixture', 'mythpen-store-foreign'),
  });
  const otherStore = createStore(otherFixture);
  await assert.rejects(buildClosure(otherStore, snapshot, mutation), TypeError);

  await assertCode(buildClosure(store, snapshot, {
    ...mutation,
    content: '- unsupported list',
  }), 'UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE');

  fixture.controls.setBytes(fixture.refs.chapterBody, Buffer.from('原地改正文', 'utf8'));
  await assertCode(buildClosure(store, snapshot, mutation), 'EXTERNAL_CHANGE_CONFLICT');
});

test('buildClosure rejects a body write from read-only Markdown before opening closure bytes', async () => {
  const fixture = createManuscriptTreeFixture();
  fixture.controls.setBytes(fixture.refs.chapterBody, Buffer.from('- existing list', 'utf8'));
  const store = createStore(fixture);
  const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
  const readsBefore = fixture.controls.calls().contentReads;

  await assertCode(buildClosure(store, snapshot, {
    kind: 'chapter.replace_body',
    bodyRef: fixture.refs.chapterBody,
    content: '转换为可视正文',
  }), 'UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE');
  assert.equal(fixture.controls.calls().contentReads, readsBefore);
});

test('buildClosure recomputes capacity from final controlled facts plus active ignored metadata', async () => {
  const fixture = createManuscriptTreeFixture();
  fixture.controls.setBytes(fixture.refs.chapterBody, Buffer.from('A'.repeat(100), 'utf8'));
  const ignored = fixture.controls.addChapter(UNKNOWN_CHAPTER_UID, {
    body: 'I'.repeat(80),
  });
  const ignoredLedger = deepFreeze({
    entries: [{ kind: 'chapter', status: 'active', uid: UNKNOWN_CHAPTER_UID }],
  });
  const store = createStore(fixture);
  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture, { ignoredLedger }),
  );

  const result = await buildClosure(store, snapshot, {
    kind: 'chapter.replace_body',
    bodyRef: fixture.refs.chapterBody,
    content: 'x',
  });
  const ignoredMembers = snapshot.ignoredMemberObservations
    .flatMap((observation) => observation.members)
    .filter((member) => member.present);
  const allFinalSizes = [
    ...result.candidateTemplate.controlledFiles.map((fact) => ({
      byteSize: fact.byteSize,
      role: fact.role,
    })),
    ...ignoredMembers,
  ];
  const measurements = result.candidateTemplate.capacitySnapshot.measurements;
  assert.equal(measurements.markdownBytes, 80);
  assert.equal(measurements.controlledFiles, allFinalSizes.length);
  assert.equal(
    measurements.controlledBytes,
    allFinalSizes.reduce((sum, member) => sum + member.byteSize, 0),
  );
  assert.equal(result.candidateTemplate.controlledFiles.some(
    (fact) => fact.ref === ignored.bodyRef || fact.ref === ignored.sidecarRef,
  ), false);
});

test('buildClosure no-op stays read-free and finalizeCandidate rejects every inexact staged fact set', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
  const readsBefore = fixture.controls.calls().contentReads;
  const noOp = await buildClosure(store, snapshot, {
    kind: 'chapter.patch_sidecar',
    sidecarRef: fixture.refs.chapterSidecar,
    patch: { title: fixture.values.chapter.title },
  });
  assert.deepEqual(noOp.closure, []);
  assert.equal(fixture.controls.calls().contentReads, readsBefore);
  assert.doesNotThrow(() => store.finalizeCandidate(noOp, Object.freeze([])));

  const buildResult = await buildClosure(store, snapshot, {
    kind: 'chapter.replace_body_and_sidecar',
    bodyRef: fixture.refs.chapterBody,
    sidecarRef: fixture.refs.chapterSidecar,
    content: '严格合并正文',
    patch: { title: '严格合并章名' },
  });
  const templates = buildResult.candidateTemplate.controlledFiles.filter(
    (fact) => fact.fileIdentity === null,
  );
  const good = templates.map((fact, index) => stagedFact(fact, 9100 + index));

  assert.throws(() => store.finalizeCandidate({ ...buildResult }, Object.freeze(good)), TypeError);
  assert.throws(() => store.finalizeCandidate(buildResult, Object.freeze(good.slice(0, 1))), TypeError);
  assert.throws(() => store.finalizeCandidate(buildResult, Object.freeze([...good, good[0]])), TypeError);
  assert.throws(() => store.finalizeCandidate(buildResult, Object.freeze([
    Object.freeze({ ...good[0], rawSha256: '0'.repeat(64) }),
    good[1],
  ])), TypeError);
  assert.throws(() => store.finalizeCandidate(buildResult, Object.freeze([
    Object.freeze({
      ...good[0],
      parentIdentity: Object.freeze({ dev: '1', ino: '999999' }),
    }),
    good[1],
  ])), TypeError);
  assert.doesNotThrow(() => store.finalizeCandidate(buildResult, Object.freeze(good)));
});

test('buildClosure moves a known chapter and derives both index bytes and positions once', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));

  const result = await buildClosure(store, snapshot, {
    kind: 'chapter.move',
    chapterUid: CHAPTER_UID,
    targetVolumeUid: null,
    targetPosition: 1,
  });

  assert.deepEqual(result.closure.map((member) => member.ref.role), [
    'volume_index',
    'unassigned',
  ]);
  const volumeAfter = JSON.parse(result.closure[0].after.bytes.toString('utf8'));
  const unassignedAfter = JSON.parse(result.closure[1].after.bytes.toString('utf8'));
  assert.deepEqual(volumeAfter.chapter_uids, []);
  assert.deepEqual(unassignedAfter.chapter_uids, [UNASSIGNED_CHAPTER_UID, CHAPTER_UID]);
  assert.deepEqual(result.candidateTemplate.chapters.map((chapter) => ({
    uid: chapter.chapterUid,
    volumeUid: chapter.volumeUid,
    chapterPosition: chapter.chapterPosition,
    manuscriptPosition: chapter.manuscriptPosition,
  })), [
    {
      uid: UNASSIGNED_CHAPTER_UID,
      volumeUid: null,
      chapterPosition: 1,
      manuscriptPosition: 1,
    },
    {
      uid: CHAPTER_UID,
      volumeUid: null,
      chapterPosition: 2,
      manuscriptPosition: 2,
    },
  ]);
});

test('buildClosure requires complete chapter and volume permutations and preserves domain order', async () => {
  const fixture = createManuscriptTreeFixture();
  fixture.values.volume.chapter_uids = [CHAPTER_UID, UNASSIGNED_CHAPTER_UID];
  fixture.values.unassigned.chapter_uids = [];
  fixture.controls.setJson(fixture.refs.volume, fixture.values.volume);
  fixture.controls.setJson(fixture.refs.unassigned, fixture.values.unassigned);
  const secondVolumeRef = fixture.controls.addVolume(UNKNOWN_VOLUME_UID);
  fixture.values.manuscript.volume_uids = [VOLUME_UID, UNKNOWN_VOLUME_UID];
  fixture.controls.setJson(fixture.refs.manuscript, fixture.values.manuscript);
  const lifecycleBasis = deepFreeze({
    ...fixture.lifecycleBasis,
    activeVolumeUids: [VOLUME_UID, UNKNOWN_VOLUME_UID],
  });
  const store = createStore(fixture);
  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture, { lifecycleBasis }),
  );
  const readsBeforeNoOp = fixture.controls.calls().contentReads;
  const noOp = await buildClosure(store, snapshot, {
    kind: 'chapter.reorder',
    containerVolumeUid: VOLUME_UID,
    chapterUids: [CHAPTER_UID, UNASSIGNED_CHAPTER_UID],
  });
  assert.deepEqual(noOp.closure, []);
  assert.equal(fixture.controls.calls().contentReads, readsBeforeNoOp);

  const chapters = await buildClosure(store, snapshot, {
    kind: 'chapter.reorder',
    containerVolumeUid: VOLUME_UID,
    chapterUids: [UNASSIGNED_CHAPTER_UID, CHAPTER_UID],
  });
  assert.deepEqual(chapters.closure.map((member) => member.ref.role), ['volume_index']);
  assert.deepEqual(chapters.candidateTemplate.chapters.map((chapter) => chapter.chapterUid), [
    UNASSIGNED_CHAPTER_UID,
    CHAPTER_UID,
  ]);
  await assert.rejects(buildClosure(store, snapshot, {
    kind: 'chapter.reorder',
    containerVolumeUid: VOLUME_UID,
    chapterUids: [CHAPTER_UID],
  }), TypeError);

  const volumes = await buildClosure(store, snapshot, {
    kind: 'volume.reorder',
    volumeUids: [UNKNOWN_VOLUME_UID, VOLUME_UID],
  });
  assert.deepEqual(volumes.closure.map((member) => member.ref.role), ['manuscript']);
  assert.deepEqual(volumes.candidateTemplate.volumeOrder, [UNKNOWN_VOLUME_UID, VOLUME_UID]);
  assert.deepEqual(volumes.candidateTemplate.volumes.map((volume) => volume.volumePosition), [1, 2]);
  assert.deepEqual(
    volumes.closure[0].ref,
    fixture.refs.manuscript,
  );
  assert.equal(secondVolumeRef.role, 'volume_index');
});

test('chapter and volume delete emit exact delete closure and keep lifetime identity capacity', async () => {
  {
    const fixture = createManuscriptTreeFixture();
    const store = createStore(fixture);
    const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
    const result = await buildClosure(store, snapshot, {
      kind: 'chapter.delete',
      chapterUid: CHAPTER_UID,
    });

    assert.deepEqual(result.closure.map((member) => member.ref.role), [
      'chapter_body',
      'chapter_sidecar',
      'volume_index',
    ]);
    assert.deepEqual(result.closure.map((member) => member.after.exists), [false, false, true]);
    assert.deepEqual(result.closure[0].after, {
      exists: false,
      bytes: null,
      byteSize: 0,
      rawSha256: null,
    });
    assert.deepEqual(result.candidateTemplate.chapters.map((chapter) => chapter.chapterUid), [
      UNASSIGNED_CHAPTER_UID,
    ]);
    assert.equal(result.candidateTemplate.capacitySnapshot.measurements.chapterIdentities, 2);
    assert.equal(result.candidateTemplate.capacitySnapshot.measurements.chapterDirectoryEntries, 2);

    const afterPresent = result.candidateTemplate.controlledFiles.filter(
      (fact) => fact.fileIdentity === null,
    );
    assert.equal(afterPresent.length, 1);
    const candidate = store.finalizeCandidate(result, Object.freeze([
      stagedFact(afterPresent[0], 9301),
    ]));
    assert.equal(candidate.controlledFiles.some(
      (fact) => fact.resourceUid === CHAPTER_UID,
    ), false);
    const deletedBody = snapshot.controlledFiles.find(
      (fact) => fact.role === 'chapter_body' && fact.resourceUid === CHAPTER_UID,
    );
    assert.throws(() => store.finalizeCandidate(result, Object.freeze([
      stagedFact(afterPresent[0], 9301),
      stagedFact(deletedBody, 9302),
    ])), TypeError);
  }

  {
    const fixture = createManuscriptTreeFixture();
    const store = createStore(fixture);
    const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
    const result = await buildClosure(store, snapshot, {
      kind: 'volume.delete',
      volumeUid: VOLUME_UID,
    });

    assert.deepEqual(result.closure.map((member) => member.ref.role), [
      'chapter_body',
      'chapter_sidecar',
      'volume_index',
      'manuscript',
    ]);
    assert.deepEqual(result.closure.map((member) => member.after.exists), [
      false,
      false,
      false,
      true,
    ]);
    assert.deepEqual(result.candidateTemplate.volumeOrder, []);
    assert.deepEqual(result.candidateTemplate.chapters.map((chapter) => chapter.chapterUid), [
      UNASSIGNED_CHAPTER_UID,
    ]);
    assert.equal(result.candidateTemplate.capacitySnapshot.measurements.volumeIdentities, 1);
    assert.equal(result.candidateTemplate.capacitySnapshot.measurements.chapterIdentities, 2);
  }
});

test('volume metadata and ignored reference actions use one known plus opaque serializer', async () => {
  const fixture = createManuscriptTreeFixture();
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  fixture.values.volume.chapter_uids = [UNKNOWN_CHAPTER_UID, CHAPTER_UID];
  fixture.controls.setJson(fixture.refs.volume, fixture.values.volume);
  const ignoredLedger = deepFreeze({
    entries: [{ kind: 'chapter', status: 'active', uid: UNKNOWN_CHAPTER_UID }],
  });
  const store = createStore(fixture);
  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture, { ignoredLedger }),
  );
  const rows = ignoredRowsFor(snapshot);

  const metadata = await buildClosure(store, snapshot, {
    kind: 'volume.patch_metadata',
    volumeRef: fixture.refs.volume,
    patch: { title: '规范尾部' },
  }, rows);
  assert.deepEqual(
    JSON.parse(metadata.closure[0].after.bytes.toString('utf8')).chapter_uids,
    [CHAPTER_UID, UNKNOWN_CHAPTER_UID],
  );

  const preserve = await buildClosure(store, snapshot, {
    kind: 'ignored.preserve_move_to_unassigned',
    chapterUid: UNKNOWN_CHAPTER_UID,
  }, rows);
  assert.deepEqual(preserve.closure.map((member) => member.ref.role), [
    'volume_index',
    'unassigned',
  ]);
  assert.deepEqual(
    JSON.parse(preserve.closure[0].after.bytes.toString('utf8')).chapter_uids,
    [CHAPTER_UID],
  );
  assert.deepEqual(
    JSON.parse(preserve.closure[1].after.bytes.toString('utf8')).chapter_uids,
    [UNASSIGNED_CHAPTER_UID, UNKNOWN_CHAPTER_UID],
  );
  assert.deepEqual(preserve.candidateTemplate.ignoredLedgerAfter[0].reference, {
    state: 'indexed',
    containerKind: 'unassigned',
    containerUid: null,
  });

  const detach = await buildClosure(store, snapshot, {
    kind: 'ignored.detach_reference',
    chapterUid: UNKNOWN_CHAPTER_UID,
  }, rows);
  assert.deepEqual(detach.closure.map((member) => member.ref.role), ['volume_index']);
  assert.deepEqual(detach.candidateTemplate.ignoredLedgerAfter[0].reference, {
    state: 'detached',
    containerKind: null,
    containerUid: null,
  });
});

test('create closure binds the fourth-argument reservation into exact absent members and final candidates', async () => {
  const rows = [
    {
      command: {
        kind: 'volume.create',
        title: '新增卷',
        summary: '新增卷摘要',
      },
      expectedRoles: ['volume_index', 'manuscript'],
      identityDimension: 'volumeIdentities',
      directoryDelta: 0,
    },
    {
      command: {
        kind: 'chapter.create',
        containerVolumeUid: VOLUME_UID,
        requestedNum: null,
        content: '新增章正文',
        sidecar: {
          title: '新增章',
          outline: '新增章提纲',
          status: 'pending',
          summary: '新增章摘要',
          cognitive_frame: '',
          emotional_anchor: '',
          world_texture: '',
          concrete_mystery: '',
          interpersonal_tension: '',
        },
      },
      expectedRoles: ['chapter_body', 'chapter_sidecar', 'volume_index'],
      identityDimension: 'chapterIdentities',
      directoryDelta: 2,
    },
  ];

  for (const row of rows) {
    const fixture = createManuscriptTreeFixture();
    const store = createStore(fixture);
    const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
    const parentRole = row.command.kind === 'volume.create' ? 'volume_index' : 'chapter_body';
    const parentIdentity = snapshot.controlledFiles.find(
      (fact) => fact.role === parentRole,
    ).parentIdentity;
    const reservation = createReservation(fixture, row.command, parentIdentity);
    const beforeCapacity = snapshot.capacitySnapshot.measurements;

    await assert.rejects(
      store.buildClosure(snapshot, row.command, ignoredRowsFor(snapshot)),
      TypeError,
    );
    await assert.rejects(
      store.buildClosure(
        snapshot,
        row.command,
        ignoredRowsFor(snapshot),
        JSON.parse(JSON.stringify(reservation)),
      ),
      TypeError,
    );
    await assert.rejects(store.buildClosure(
      snapshot,
      row.command,
      ignoredRowsFor(snapshot),
      Object.freeze({
        ...reservation,
        pathPredicates: reservation.pathPredicates.map((predicate) => ({ ...predicate })),
      }),
    ), TypeError);
    const wrongDirectory = remintReservation(reservation, (value) => {
      const directory = path.join(
        path.dirname(path.dirname(value.pathPredicates[0].canonicalPath)),
        'wrong-create-directory',
      );
      for (const predicate of value.pathPredicates) {
        predicate.canonicalPath = path.join(directory, path.basename(predicate.canonicalPath));
      }
    });
    const wrongParent = remintReservation(reservation, (value) => {
      for (const predicate of value.pathPredicates) {
        predicate.parentIdentity = { dev: parentIdentity.dev, ino: '999999' };
      }
    });
    const readsBeforePathDrift = fixture.controls.calls().contentReads;
    for (const driftedReservation of [wrongDirectory, wrongParent]) {
      await assert.rejects(store.buildClosure(
        snapshot,
        row.command,
        ignoredRowsFor(snapshot),
        driftedReservation,
      ), TypeError);
      assert.equal(fixture.controls.calls().contentReads, readsBeforePathDrift);
    }

    const result = await store.buildClosure(
      snapshot,
      row.command,
      ignoredRowsFor(snapshot),
      reservation,
    );
    assert.deepEqual(result.closure.map((member) => member.ref.role), row.expectedRoles);
    const creates = result.closure.filter((member) => member.before.exists === false);
    assert.equal(creates.length, reservation.pathPredicates.length);
    for (const member of creates) {
      assert.deepEqual(member.before, {
        exists: false,
        bytes: null,
        byteSize: 0,
        rawSha256: null,
        fileIdentity: null,
      });
      assert.deepEqual(
        member.parentIdentity,
        reservation.pathPredicates.find((predicate) => predicate.role === member.ref.role)
          .parentIdentity,
      );
    }
    assert.equal(
      result.candidateTemplate.capacitySnapshot.measurements[row.identityDimension],
      beforeCapacity[row.identityDimension] + 1,
    );
    assert.equal(
      result.candidateTemplate.capacitySnapshot.measurements.chapterDirectoryEntries,
      beforeCapacity.chapterDirectoryEntries + row.directoryDelta,
    );

    const newUid = reservation.uid;
    const createdFacts = result.candidateTemplate.controlledFiles.filter(
      (fact) => fact.resourceUid === newUid,
    );
    assert.equal(createdFacts.length, reservation.objectKind === 'volume' ? 1 : 2);
    assert.equal(createdFacts.every((fact) => fact.fileIdentity === null), true);
    const staged = result.candidateTemplate.controlledFiles
      .filter((fact) => fact.fileIdentity === null)
      .map((fact, index) => stagedFact(fact, 9400 + index));
    const candidate = store.finalizeCandidate(result, Object.freeze(staged));
    assert.equal(candidate.controlledFiles.filter(
      (fact) => fact.resourceUid === newUid,
    ).every((fact) => fact.fileIdentity !== null), true);
    if (reservation.objectKind === 'volume') {
      assert.equal(candidate.volumeOrder.at(-1), newUid);
      assert.deepEqual(candidate.volumes.at(-1), {
        summary: row.command.summary,
        title: row.command.title,
        volumePosition: candidate.volumes.length,
        volumeUid: newUid,
      });
    } else {
      const chapter = candidate.chapters.find((value) => value.chapterUid === newUid);
      assert.equal(chapter.volumeUid, VOLUME_UID);
      assert.equal(chapter.chapterPosition, 2);
      assert.equal(chapter.manuscriptPosition, 2);
      assert.equal(chapter.title, row.command.sidecar.title);
      assert.equal(chapter.content, row.command.content);
    }
  }
});

test('chapter create serializes known then new then opaque and enforces lifetime capacity before staging', async () => {
  const command = {
    kind: 'chapter.create',
    containerVolumeUid: VOLUME_UID,
    requestedNum: 2,
    content: '容量边界正文',
    sidecar: {
      title: '容量边界章',
      outline: '',
      status: 'writing',
      summary: '',
      cognitive_frame: '',
      emotional_anchor: '',
      world_texture: '',
      concrete_mystery: '',
      interpersonal_tension: '',
    },
  };
  const fixture = createManuscriptTreeFixture();
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  fixture.values.volume.chapter_uids = [UNKNOWN_CHAPTER_UID, CHAPTER_UID];
  fixture.controls.setJson(fixture.refs.volume, fixture.values.volume);
  const ignoredLedger = deepFreeze({
    entries: [{ kind: 'chapter', status: 'active', uid: UNKNOWN_CHAPTER_UID }],
  });
  const store = createStore(fixture);
  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture, { ignoredLedger }),
  );
  const parentIdentity = snapshot.controlledFiles.find(
    (fact) => fact.role === 'chapter_body',
  ).parentIdentity;
  const reservation = createReservation(fixture, command, parentIdentity);
  const result = await store.buildClosure(
    snapshot,
    command,
    ignoredRowsFor(snapshot),
    reservation,
  );
  const indexMember = result.closure.find((member) => member.ref.role === 'volume_index');
  assert.deepEqual(
    JSON.parse(indexMember.after.bytes.toString('utf8')).chapter_uids,
    [CHAPTER_UID, CREATED_CHAPTER_UID, UNKNOWN_CHAPTER_UID],
  );

  const limitedFixture = createManuscriptTreeFixture();
  const limitedStore = createStore(limitedFixture, { chapterIdentities: 2 });
  const limitedSnapshot = await limitedStore.validateFull(
    limitedFixture.projectBinding,
    validationOptions(limitedFixture),
  );
  const limitedParent = limitedSnapshot.controlledFiles.find(
    (fact) => fact.role === 'chapter_body',
  ).parentIdentity;
  await assertCode(limitedStore.buildClosure(
    limitedSnapshot,
    command,
    ignoredRowsFor(limitedSnapshot),
    createReservation(limitedFixture, command, limitedParent),
  ), 'MANUSCRIPT_CONTENT_TOO_LARGE');
});

test('chapter create rejects non-writable Markdown and lossy string encoding before closure reads', async () => {
  for (const content of ['- unsupported list', 'nul\u0000body', '\ud800']) {
    const fixture = createManuscriptTreeFixture();
    const store = createStore(fixture);
    const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
    const command = {
      kind: 'chapter.create',
      containerVolumeUid: VOLUME_UID,
      requestedNum: null,
      content,
      sidecar: {
        title: '不可写正文',
        outline: '',
        status: 'pending',
        summary: '',
        cognitive_frame: '',
        emotional_anchor: '',
        world_texture: '',
        concrete_mystery: '',
        interpersonal_tension: '',
      },
    };
    const parentIdentity = snapshot.controlledFiles.find(
      (fact) => fact.role === 'chapter_body',
    ).parentIdentity;
    const readsBefore = fixture.controls.calls().contentReads;
    await assertCode(store.buildClosure(
      snapshot,
      command,
      ignoredRowsFor(snapshot),
      createReservation(fixture, command, parentIdentity),
    ), 'UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE');
    assert.equal(fixture.controls.calls().contentReads, readsBefore);
  }
});

test('ignored row bijection and indexed opaque children block structure work before boundary reads', async () => {
  const fixture = createManuscriptTreeFixture();
  fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  fixture.values.volume.chapter_uids.push(UNKNOWN_CHAPTER_UID);
  fixture.controls.setJson(fixture.refs.volume, fixture.values.volume);
  const ignoredLedger = deepFreeze({
    entries: [{ kind: 'chapter', status: 'active', uid: UNKNOWN_CHAPTER_UID }],
  });
  const store = createStore(fixture);
  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture, { ignoredLedger }),
  );
  const readsBefore = fixture.controls.calls().contentReads;

  await assertCode(buildClosure(store, snapshot, {
    kind: 'volume.delete',
    volumeUid: VOLUME_UID,
  }, ignoredRowsFor(snapshot)), 'IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE');
  assert.equal(fixture.controls.calls().contentReads, readsBefore);

  await assert.rejects(buildClosure(store, snapshot, {
    kind: 'chapter.delete',
    chapterUid: CHAPTER_UID,
  }, normalizeIgnoredLedgerRows([])), TypeError);
  assert.equal(fixture.controls.calls().contentReads, readsBefore);

  const mismatched = ignoredRowsFor(snapshot).map((row) => {
    const parsed = JSON.parse(row.member_snapshot_json);
    parsed.members[0].byteSize += 1;
    return { ...row, member_snapshot_json: JSON.stringify(parsed) };
  });
  await assert.rejects(buildClosure(store, snapshot, {
    kind: 'chapter.delete',
    chapterUid: CHAPTER_UID,
  }, mismatched), TypeError);
  assert.equal(fixture.controls.calls().contentReads, readsBefore);
});

test('Store rejects every inexact structural shape and bound before opening closure bytes', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);
  const snapshot = await store.validateFull(fixture.projectBinding, validationOptions(fixture));
  const rows = ignoredRowsFor(snapshot);
  const readsBefore = fixture.controls.calls().contentReads;
  let getterCalls = 0;
  const accessor = {
    kind: 'chapter.delete',
  };
  Object.defineProperty(accessor, 'chapterUid', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return CHAPTER_UID;
    },
  });
  const sparse = [];
  sparse.length = 1;
  const invalid = [
    { kind: 'chapter.delete', chapterUid: CHAPTER_UID, extra: true },
    accessor,
    {
      kind: 'chapter.move',
      chapterUid: CHAPTER_UID,
      targetVolumeUid: null,
      targetPosition: 2,
    },
    {
      kind: 'chapter.move',
      chapterUid: CHAPTER_UID,
      targetVolumeUid: VOLUME_UID,
      targetPosition: 0,
    },
    {
      kind: 'chapter.reorder',
      containerVolumeUid: VOLUME_UID,
      chapterUids: [CHAPTER_UID, CHAPTER_UID],
    },
    {
      kind: 'chapter.reorder',
      containerVolumeUid: VOLUME_UID,
      chapterUids: sparse,
    },
    {
      kind: 'volume.delete',
      volumeUid: VOLUME_UID,
      childPolicy: 'cascade',
    },
  ];
  for (const mutation of invalid) {
    await assert.rejects(buildClosure(store, snapshot, mutation, rows));
    assert.equal(fixture.controls.calls().contentReads, readsBefore);
  }
  await assert.rejects(store.buildClosure(snapshot, {
    kind: 'chapter.delete',
    chapterUid: CHAPTER_UID,
  }), TypeError);
  assert.equal(fixture.controls.calls().contentReads, readsBefore);
  assert.equal(getterCalls, 0);
});

test('full validation builds one immutable file-fact projection with canonical positions', async () => {
  const fixture = createManuscriptTreeFixture();
  const store = createStore(fixture);

  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture),
  );
  const candidate = await store.buildProjectionCandidate(snapshot);

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(snapshot.controlledFiles), true);
  assert.equal(Object.isFrozen(snapshot.controlledFiles[0].fileIdentity), true);
  assert.equal(Object.isFrozen(candidate.chapters), true);
  assert.equal(Object.isFrozen(candidate.chapters[0]), true);
  assert.equal(snapshot.projectUid, PROJECT_UID);
  assert.deepEqual(candidate.volumeOrder, [VOLUME_UID]);
  assert.deepEqual(candidate.volumes, [{
    summary: '卷摘要',
    title: '第一卷',
    volumePosition: 1,
    volumeUid: VOLUME_UID,
  }]);
  assert.deepEqual(
    candidate.chapters.map((chapter) => ({
      chapterPosition: chapter.chapterPosition,
      chapterUid: chapter.chapterUid,
      manuscriptPosition: chapter.manuscriptPosition,
      volumeUid: chapter.volumeUid,
    })),
    [
      {
        chapterPosition: 1,
        chapterUid: CHAPTER_UID,
        manuscriptPosition: 1,
        volumeUid: VOLUME_UID,
      },
      {
        chapterPosition: 1,
        chapterUid: UNASSIGNED_CHAPTER_UID,
        manuscriptPosition: 2,
        volumeUid: null,
      },
    ],
  );
  assert.equal(candidate.chapters[0].content, '第一章正文');
  assert.equal(candidate.chapters[0].contentAvailable, true);
  assert.equal(candidate.controlledFiles.length, 7);
  assert.equal(snapshot.capacitySnapshot.measurements.controlledFiles, 7);
  assert.equal(Object.hasOwn(candidate, 'generation'), false);
  assert.equal(Object.hasOwn(candidate, 'localId'), false);
  assert.deepEqual(fixture.controls.calls().enumerateCalls, ['mythpen', 'volumes', 'chapters']);
  assert.equal(fixture.controls.calls().unexpectedSiblingLists, 0);
});

test('journal authority is exact and unowned candidates plus residues are never read or hashed', async () => {
  const fixture = createManuscriptTreeFixture();
  const ownedName = fixture.controls.addCandidate(fixture.refs.chapterBody, 'journal-one', {
    owned: true,
  });
  const unownedName = fixture.controls.addCandidate(
    fixture.refs.chapterSidecar,
    'journal-one',
  );
  fixture.controls.addResidue('chapters', 'desktop.ini');
  const store = createStore(fixture);

  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture),
  );
  assert.deepEqual(
    snapshot.classifications.journalCandidates.map((entry) => entry.actualName),
    [ownedName],
  );
  assert.deepEqual(
    snapshot.classifications.residues.map((entry) => entry.actualName).sort(),
    ['desktop.ini', unownedName].sort(),
  );
  const calls = fixture.controls.calls();
  assert.equal(calls.authorityLookups.length, 2);
  assert.deepEqual(calls.authorityLookups.map((entry) => entry.projectUid), [
    PROJECT_UID,
    PROJECT_UID,
  ]);
  assert.deepEqual(calls.authorityLookups.map((entry) => entry.targetKey), [
    refKey(fixture.refs.chapterBody),
    refKey(fixture.refs.chapterSidecar),
  ]);
  assert.equal(calls.contentOpens, 7);
  assert.equal(calls.probes.length, 7);
  assert.equal(calls.inspectPaths.length, 14);
});

test('full validation rejects missing roots members and duplicate chapter ownership', async () => {
  const cases = [
    ['missing unassigned root', (fixture) => fixture.controls.deleteFile(fixture.refs.unassigned)],
    ['missing referenced volume', (fixture) => fixture.controls.deleteFile(fixture.refs.volume)],
    ['single-sided chapter pair', (fixture) => fixture.controls.deleteFile(fixture.refs.chapterBody)],
    ['chapter in two indexes', (fixture) => {
      const value = { ...fixture.values.unassigned, chapter_uids: [CHAPTER_UID, UNASSIGNED_CHAPTER_UID] };
      fixture.controls.setJson(fixture.refs.unassigned, value);
    }],
  ];

  for (const [_name, mutate] of cases) {
    const fixture = createManuscriptTreeFixture();
    mutate(fixture);
    await assertCode(
      createStore(fixture).validateFull(
        fixture.projectBinding,
        validationOptions(fixture),
      ),
      'MANUSCRIPT_FILESET_INVALID',
    );
  }

  const invalidSurvivorFixture = createManuscriptTreeFixture();
  invalidSurvivorFixture.controls.deleteFile(invalidSurvivorFixture.refs.chapterBody);
  invalidSurvivorFixture.controls.setBytes(
    invalidSurvivorFixture.refs.chapterSidecar,
    Buffer.from('{"format_version":2}\n', 'utf8'),
  );
  const missingExternalFixture = createManuscriptTreeFixture();
  missingExternalFixture.controls.setJson(missingExternalFixture.refs.volume, {
    ...missingExternalFixture.values.volume,
    chapter_uids: [CHAPTER_UID, UNKNOWN_CHAPTER_UID],
  });
  assert.deepEqual(await Promise.all([
    captureCode(createStore(invalidSurvivorFixture).validateFull(
      invalidSurvivorFixture.projectBinding,
      validationOptions(invalidSurvivorFixture),
    )),
    captureCode(createStore(missingExternalFixture).validateFull(
      missingExternalFixture.projectBinding,
      validationOptions(missingExternalFixture),
    )),
  ]), [
    'MANUSCRIPT_FILESET_INVALID',
    'MANUSCRIPT_FILESET_INVALID',
  ]);
});

test('known orphans and complete indexed external UIDs use the external-creation error', async () => {
  const cases = [
    (fixture) => fixture.controls.setJson(fixture.refs.volume, {
      ...fixture.values.volume,
      chapter_uids: [],
    }),
    (fixture) => {
      fixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
      fixture.controls.setJson(fixture.refs.volume, {
        ...fixture.values.volume,
        chapter_uids: [CHAPTER_UID, UNKNOWN_CHAPTER_UID],
      });
    },
    (fixture) => {
      fixture.controls.addVolume(UNKNOWN_VOLUME_UID);
      fixture.controls.setJson(fixture.refs.manuscript, {
        ...fixture.values.manuscript,
        volume_uids: [VOLUME_UID, UNKNOWN_VOLUME_UID],
      });
    },
  ];
  for (const mutate of cases) {
    const fixture = createManuscriptTreeFixture();
    mutate(fixture);
    await assertCode(
      createStore(fixture).validateFull(fixture.projectBinding, validationOptions(fixture)),
      'EXTERNAL_RESOURCE_CREATION_UNSUPPORTED',
    );
  }

  const oneSidedFixture = createManuscriptTreeFixture();
  const oneSided = oneSidedFixture.controls.addChapter(UNKNOWN_CHAPTER_UID);
  oneSidedFixture.controls.deleteFile(oneSided.sidecarRef);
  await assertCode(
    createStore(oneSidedFixture).validateFull(
      oneSidedFixture.projectBinding,
      validationOptions(oneSidedFixture),
    ),
    'MANUSCRIPT_FILESET_INVALID',
  );
});

test('tombstone resources can revive while a complete known deletion remains a valid file fact', async () => {
  const revivalFixture = createManuscriptTreeFixture();
  const revivalBasis = {
    ...revivalFixture.lifecycleBasis,
    activeChapterUids: [UNASSIGNED_CHAPTER_UID],
    chapterTombstoneUids: [CHAPTER_UID],
  };
  const revivalStore = createStore(revivalFixture);
  const revivalSnapshot = await revivalStore.validateFull(revivalFixture.projectBinding, {
    ignoredLedger: revivalFixture.ignoredLedger,
    lifecycleBasis: revivalBasis,
  });
  const revivalCandidate = await revivalStore.buildProjectionCandidate(revivalSnapshot);
  assert.equal(
    revivalCandidate.chapters.some((entry) => entry.chapterUid === CHAPTER_UID),
    true,
  );

  const deletionFixture = createManuscriptTreeFixture();
  deletionFixture.controls.setJson(deletionFixture.refs.volume, {
    ...deletionFixture.values.volume,
    chapter_uids: [],
  });
  deletionFixture.controls.deleteFile(deletionFixture.refs.chapterBody);
  deletionFixture.controls.deleteFile(deletionFixture.refs.chapterSidecar);
  const deletionStore = createStore(deletionFixture);
  const deletionSnapshot = await deletionStore.validateFull(
    deletionFixture.projectBinding,
    validationOptions(deletionFixture),
  );
  const deletionCandidate = await deletionStore.buildProjectionCandidate(deletionSnapshot);
  assert.equal(
    deletionCandidate.chapters.some((entry) => entry.chapterUid === CHAPTER_UID),
    false,
  );
  assert.equal(deletionSnapshot.capacitySnapshot.measurements.chapterIdentities, 2);
});

test('active ignored members stay opaque while revoked identities still consume lifetime capacity', async () => {
  const fixture = createManuscriptTreeFixture();
  fixture.controls.setBytes(fixture.refs.chapterBody, Buffer.from([0xff, 0x00]));
  fixture.controls.setBytes(fixture.refs.chapterSidecar, Buffer.from('{', 'utf8'));
  const lifecycleBasis = {
    ...fixture.lifecycleBasis,
    activeChapterUids: [UNASSIGNED_CHAPTER_UID],
  };
  const activeIgnored = {
    entries: [{ kind: 'chapter', status: 'active', uid: CHAPTER_UID }],
  };
  const store = createStore(fixture);
  const snapshot = await store.validateFull(fixture.projectBinding, {
    ignoredLedger: activeIgnored,
    lifecycleBasis,
  });
  const projected = await store.buildProjectionCandidate(snapshot);
  assert.deepEqual(projected.chapters.map((entry) => entry.chapterUid), [
    UNASSIGNED_CHAPTER_UID,
  ]);
  assert.deepEqual(snapshot.ignoredMemberObservations, [{
    kind: 'chapter',
    members: [
      {
        byteSize: 2,
        fileIdentity: { dev: '1', ino: '103' },
        parentIdentity: { dev: '1', ino: '13' },
        present: true,
        role: 'chapter_body',
      },
      {
        byteSize: 1,
        fileIdentity: { dev: '1', ino: '104' },
        parentIdentity: { dev: '1', ino: '13' },
        present: true,
        role: 'chapter_sidecar',
      },
    ],
    reference: {
      containerKind: 'volume',
      containerUid: VOLUME_UID,
      state: 'indexed',
    },
    status: 'active',
    uid: CHAPTER_UID,
  }]);
  assert.equal(snapshot.capacitySnapshot.measurements.chapterIdentities, 2);
  assert.equal(snapshot.capacitySnapshot.measurements.controlledFiles, 7);
  const calls = fixture.controls.calls();
  assert.equal(calls.contentOpens, 5);
  assert.equal(calls.contentReads, 5);
  assert.equal(calls.probes.includes(refKey(fixture.refs.chapterBody)), true);
  assert.equal(calls.probes.includes(refKey(fixture.refs.chapterSidecar)), true);

  const duplicateFixture = createManuscriptTreeFixture();
  duplicateFixture.controls.setJson(duplicateFixture.refs.unassigned, {
    ...duplicateFixture.values.unassigned,
    chapter_uids: [CHAPTER_UID, UNASSIGNED_CHAPTER_UID],
  });
  await assertCode(
    createStore(duplicateFixture).validateFull(duplicateFixture.projectBinding, {
      ignoredLedger: {
        entries: [{ kind: 'chapter', status: 'active', uid: CHAPTER_UID }],
      },
      lifecycleBasis: {
        ...duplicateFixture.lifecycleBasis,
        activeChapterUids: [UNASSIGNED_CHAPTER_UID],
      },
    }),
    'MANUSCRIPT_FILESET_INVALID',
  );

  const revokedFixture = createManuscriptTreeFixture();
  await assertCode(
    createStore(revokedFixture).validateFull(revokedFixture.projectBinding, {
      ignoredLedger: { entries: [{ kind: 'chapter', status: 'revoked', uid: CHAPTER_UID }] },
      lifecycleBasis: {
        ...revokedFixture.lifecycleBasis,
        activeChapterUids: [UNASSIGNED_CHAPTER_UID],
      },
    }),
    'EXTERNAL_RESOURCE_CREATION_UNSUPPORTED',
  );

  const deletedFixture = createManuscriptTreeFixture();
  deletedFixture.controls.setJson(deletedFixture.refs.volume, {
    ...deletedFixture.values.volume,
    chapter_uids: [],
  });
  deletedFixture.controls.deleteFile(deletedFixture.refs.chapterBody);
  deletedFixture.controls.deleteFile(deletedFixture.refs.chapterSidecar);
  const deletedSnapshot = await createStore(deletedFixture, {
    chapterIdentities: 2,
  }).validateFull(deletedFixture.projectBinding, {
    ignoredLedger: { entries: [{ kind: 'chapter', status: 'revoked', uid: CHAPTER_UID }] },
    lifecycleBasis: {
      ...deletedFixture.lifecycleBasis,
      activeChapterUids: [UNASSIGNED_CHAPTER_UID],
    },
  });
  assert.equal(deletedSnapshot.capacitySnapshot.measurements.chapterIdentities, 2);
  assert.deepEqual(deletedSnapshot.warnings.map((warning) => warning.dimension), [
    'chapterIdentities',
  ]);
  assert.deepEqual(deletedSnapshot.ignoredMemberObservations[0].reference, {
    containerKind: null,
    containerUid: null,
    state: 'detached',
  });
});

test('ignored references come only from the validated index closure and cover every legal container', async () => {
  const cases = [
    {
      expected: {
        containerKind: 'unassigned',
        containerUid: null,
        state: 'indexed',
      },
      kind: 'chapter',
      prepare(fixture) {
        return {
          lifecycleBasis: {
            ...fixture.lifecycleBasis,
            activeChapterUids: [CHAPTER_UID],
          },
          uid: UNASSIGNED_CHAPTER_UID,
        };
      },
    },
    {
      expected: {
        containerKind: 'manuscript',
        containerUid: null,
        state: 'indexed',
      },
      kind: 'volume',
      prepare(fixture) {
        fixture.controls.setBytes(fixture.refs.volume, Buffer.from('{', 'utf8'));
        fixture.controls.deleteFile(fixture.refs.chapterBody);
        fixture.controls.deleteFile(fixture.refs.chapterSidecar);
        return {
          lifecycleBasis: {
            ...fixture.lifecycleBasis,
            activeChapterUids: [UNASSIGNED_CHAPTER_UID],
            activeVolumeUids: [],
          },
          uid: VOLUME_UID,
        };
      },
    },
    {
      expected: {
        containerKind: null,
        containerUid: null,
        state: 'detached',
      },
      kind: 'chapter',
      prepare(fixture) {
        fixture.controls.addChapter(UNKNOWN_CHAPTER_UID, {
          body: Buffer.from([0xff]).toString('latin1'),
          sidecar: fixture.values.chapter,
        });
        return {
          lifecycleBasis: fixture.lifecycleBasis,
          uid: UNKNOWN_CHAPTER_UID,
        };
      },
    },
    {
      expected: {
        containerKind: null,
        containerUid: null,
        state: 'detached',
      },
      kind: 'volume',
      prepare(fixture) {
        fixture.controls.addVolume(UNKNOWN_VOLUME_UID);
        return {
          lifecycleBasis: fixture.lifecycleBasis,
          uid: UNKNOWN_VOLUME_UID,
        };
      },
    },
    {
      expected: {
        containerKind: null,
        containerUid: null,
        state: 'detached',
      },
      kind: 'chapter',
      prepare(fixture) {
        return {
          lifecycleBasis: fixture.lifecycleBasis,
          uid: UNKNOWN_CHAPTER_UID,
        };
      },
    },
  ];

  for (const row of cases) {
    const fixture = createManuscriptTreeFixture();
    const { lifecycleBasis, uid } = row.prepare(fixture);
    const snapshot = await createStore(fixture).validateFull(fixture.projectBinding, {
      ignoredLedger: { entries: [{ kind: row.kind, status: 'active', uid }] },
      lifecycleBasis,
    });
    assert.deepEqual(snapshot.ignoredMemberObservations[0].reference, row.expected);
    if (row === cases.at(-1)) {
      assert.deepEqual(snapshot.ignoredMemberObservations[0].members, [
        { present: false, role: 'chapter_body' },
        { present: false, role: 'chapter_sidecar' },
      ]);
    }
  }

  const callerFixture = createManuscriptTreeFixture();
  await assert.rejects(createStore(callerFixture).validateFull(callerFixture.projectBinding, {
    ignoredLedger: {
      entries: [{
        containerKind: 'volume',
        kind: 'chapter',
        status: 'active',
        uid: CHAPTER_UID,
      }],
    },
    lifecycleBasis: callerFixture.lifecycleBasis,
  }), TypeError);
  assert.deepEqual(callerFixture.controls.calls().enumerateCalls, []);

  const unsafeFixture = createManuscriptTreeFixture();
  unsafeFixture.controls.setUnsafe(unsafeFixture.refs.chapterBody, { reparse: true });
  await assertCode(createStore(unsafeFixture).validateFull(unsafeFixture.projectBinding, {
    ignoredLedger: {
      entries: [{ kind: 'chapter', status: 'active', uid: CHAPTER_UID }],
    },
    lifecycleBasis: {
      ...unsafeFixture.lifecycleBasis,
      activeChapterUids: [UNASSIGNED_CHAPTER_UID],
    },
  }), 'MANUSCRIPT_PATH_UNSAFE');
  assert.equal(unsafeFixture.controls.calls().contentOpens, 0);
});

test('ignored identities cannot overlap active or tombstoned lifecycle identities', async () => {
  const rows = [];
  for (const kind of ['chapter', 'volume']) {
    for (const status of ['active', 'revoked']) {
      for (const lifecycleState of ['active', 'tombstone']) {
        rows.push({ kind, lifecycleState, status });
      }
    }
  }

  const actual = [];
  for (const row of rows) {
    const fixture = createManuscriptTreeFixture();
    const uid = row.kind === 'chapter' ? CHAPTER_UID : VOLUME_UID;
    const lifecycleBasis = {
      ...fixture.lifecycleBasis,
      ...(row.kind === 'chapter'
        ? {
          activeChapterUids: row.lifecycleState === 'active'
            ? fixture.lifecycleBasis.activeChapterUids
            : [UNASSIGNED_CHAPTER_UID],
          chapterTombstoneUids: row.lifecycleState === 'tombstone' ? [CHAPTER_UID] : [],
        }
        : {
          activeVolumeUids: row.lifecycleState === 'active' ? [VOLUME_UID] : [],
          volumeTombstoneUids: row.lifecycleState === 'tombstone' ? [VOLUME_UID] : [],
        }),
    };

    const code = await captureCode(createStore(fixture).validateFull(fixture.projectBinding, {
      ignoredLedger: { entries: [{ kind: row.kind, status: row.status, uid }] },
      lifecycleBasis,
    }));
    const calls = fixture.controls.calls();
    actual.push({
      code,
      contentOpens: calls.contentOpens,
      contentReads: calls.contentReads,
      directoryInspects: calls.directoryInspects.length,
      enumerateCalls: calls.enumerateCalls.length,
      identityProbes: calls.probes.length,
      ...row,
    });
  }
  assert.deepEqual(actual, rows.map((row) => ({
    code: 'MANUSCRIPT_FILESET_INVALID',
    contentOpens: 0,
    contentReads: 0,
    directoryInspects: 0,
    enumerateCalls: 0,
    identityProbes: 0,
    ...row,
  })));
});

test('stable read rejects handle drift and unsafe physical files without exposing raw bytes', async () => {
  const driftFixture = createManuscriptTreeFixture();
  driftFixture.controls.setReadDrift(driftFixture.refs.chapterBody);
  await assertCode(
    createStore(driftFixture).validateFull(
      driftFixture.projectBinding,
      validationOptions(driftFixture),
    ),
    'MANUSCRIPT_TREE_CHANGED_DURING_READ',
  );

  const unsafeFixture = createManuscriptTreeFixture();
  unsafeFixture.controls.setUnsafe(unsafeFixture.refs.chapterSidecar, { reparse: true });
  await assertCode(
    createStore(unsafeFixture).validateFull(
      unsafeFixture.projectBinding,
      validationOptions(unsafeFixture),
    ),
    'MANUSCRIPT_PATH_UNSAFE',
  );

  const fixture = createManuscriptTreeFixture();
  const snapshot = await createStore(fixture).validateFull(
    fixture.projectBinding,
    validationOptions(fixture),
  );
  assert.equal(snapshot.controlledFiles.some((file) => Object.hasOwn(file, 'bytes')), false);
  assert.throws(() => { snapshot.controlledFiles[0].byteSize = 0; }, TypeError);

  const enumerationFailureFixture = createManuscriptTreeFixture();
  enumerationFailureFixture.controls.failEnumerationAfter('volumes', 0);
  await assertCode(
    createStore(enumerationFailureFixture).validateFull(
      enumerationFailureFixture.projectBinding,
      validationOptions(enumerationFailureFixture),
    ),
    'MANUSCRIPT_PATH_UNSAFE',
  );
});

test('store integration stops at the first capacity overflow before later opens or enumeration', async () => {
  const oversizedFixture = createManuscriptTreeFixture();
  oversizedFixture.controls.setBytes(oversizedFixture.refs.chapterBody, Buffer.alloc(17));
  await assertCode(
    createStore(oversizedFixture, { markdownBytes: 16 }).validateFull(
      oversizedFixture.projectBinding,
      validationOptions(oversizedFixture),
    ),
    'MANUSCRIPT_CONTENT_TOO_LARGE',
  );
  const oversizedCalls = oversizedFixture.controls.calls();
  assert.deepEqual(oversizedCalls.enumerateCalls, ['mythpen', 'volumes', 'chapters']);
  assert.equal(oversizedCalls.iteratorNext.chapters, 1);
  assert.equal(oversizedCalls.probes.length, 4);
  assert.equal(oversizedCalls.inspectPaths.length, 0);
  assert.equal(oversizedCalls.contentOpens, 0);

  const directoryFixture = createManuscriptTreeFixture();
  await assertCode(
    createStore(directoryFixture, { chapterDirectoryEntries: 1 }).validateFull(
      directoryFixture.projectBinding,
      validationOptions(directoryFixture),
    ),
    'MANUSCRIPT_CONTENT_TOO_LARGE',
  );
  const directoryCalls = directoryFixture.controls.calls();
  assert.equal(directoryCalls.iteratorNext.chapters, 2);
  assert.equal(directoryCalls.probes.length, 4);
  assert.equal(directoryCalls.inspectPaths.length, 0);
  assert.equal(directoryCalls.contentOpens, 0);

  const fileFixture = createManuscriptTreeFixture();
  await assertCode(
    createStore(fileFixture, { controlledFiles: 2 }).validateFull(
      fileFixture.projectBinding,
      validationOptions(fileFixture),
    ),
    'MANUSCRIPT_CONTENT_TOO_LARGE',
  );
  const fileCalls = fileFixture.controls.calls();
  assert.deepEqual(fileCalls.enumerateCalls, ['mythpen', 'volumes']);
  assert.equal(fileCalls.iteratorNext.mythpen, 4);
  assert.equal(fileCalls.iteratorNext.volumes, 1);
  assert.equal(fileCalls.probes.length, 3);
  assert.equal(fileCalls.inspectPaths.length, 0);
  assert.equal(fileCalls.contentOpens, 0);
});

test('20k chapter entries build three linear name indexes with no per-file sibling listing', async () => {
  const fixture = createManuscriptTreeFixture({ largeChapterPairs: 10_000 });
  const snapshot = await createStore(fixture).enumerateAndClassify(fixture.projectBinding);
  const calls = fixture.controls.calls();

  assert.deepEqual(calls.enumerateCalls, ['mythpen', 'volumes', 'chapters']);
  assert.equal(calls.iteratorNext.chapters, 20_000);
  assert.equal(calls.unexpectedSiblingLists, 0);
  assert.equal(snapshot.nameIndexStats.chapters.entryCount, 20_000);
  assert.equal(snapshot.nameIndexStats.chapters.foldEvaluations <= 40_000, true);
});

test('U+0000 projection is deterministic unavailable content and copied snapshots are rejected', async () => {
  const fixture = createManuscriptTreeFixture();
  fixture.controls.setBytes(fixture.refs.chapterBody, Buffer.from('A\u0000 B', 'utf8'));
  const store = createStore(fixture);
  const snapshot = await store.validateFull(
    fixture.projectBinding,
    validationOptions(fixture),
  );
  const first = await store.buildProjectionCandidate(snapshot);
  const second = await store.buildProjectionCandidate(snapshot);
  const chapter = first.chapters.find((entry) => entry.chapterUid === CHAPTER_UID);

  assert.deepEqual(first, second);
  assert.equal(chapter.content, null);
  assert.equal(chapter.contentAvailable, false);
  assert.equal(chapter.markdownMode, 'read_only_passthrough');
  assert.equal(chapter.wordCount, 3);
  assert.equal(typeof chapter.bodyRawSha256, 'string');
  assert.equal(chapter.bodyRawSha256.length, 64);
  await assert.rejects(store.buildProjectionCandidate({ ...snapshot }), TypeError);
  assert.equal(Object.hasOwn(first, 'generation'), false);
});
