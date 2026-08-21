'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMITS } = require('../manuscript/contracts');
const { IgnoredIdentityLedger } = require('../manuscript/ignored-ledger');
const { deriveControlledFileRef } = require('../manuscript/paths');
const {
  SQLiteProjectionStore,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
  canonicalSchema12ReuseIdentityPlan,
  currentProjectionAfterTarget,
} = require('../manuscript/projection-store');
const { ManuscriptStore } = require('../manuscript/store');
const {
  CHAPTER_UID: FIXTURE_CHAPTER_UID,
  UNASSIGNED_CHAPTER_UID: FIXTURE_UNASSIGNED_CHAPTER_UID,
  VOLUME_UID: FIXTURE_VOLUME_UID,
  createManuscriptTreeFixture,
} = require('./fixtures/manuscript-tree');

const ZERO_DIGEST = '0'.repeat(64);
const BODY_OLD = '1'.repeat(64);
const BODY_NEW = '2'.repeat(64);
const BODY_STABLE = '3'.repeat(64);
const SIDECAR_HASH = '4'.repeat(64);
const PROJECTED_AT = '2026-08-17T08:09:10.123Z';

function uuid(seed) {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

const PROJECT_UID = uuid(1);
const PROJECT_INSTANCE_ID = uuid(2);
const VOLUME_KEEP = uuid(10);
const VOLUME_TOMBSTONE = uuid(11);
const VOLUME_NEW = uuid(12);
const CHAPTER_KEEP = uuid(20);
const CHAPTER_DELETE = uuid(21);
const CHAPTER_REVIVE = uuid(22);
const CHAPTER_NEW = uuid(23);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneCandidate(value) {
  const copied = clone(value);
  copied.controlledFiles.forEach((row, index) => {
    row.ref = value.controlledFiles[index].ref;
  });
  return copied;
}

function schema12Volume(overrides = {}) {
  return {
    id: 1,
    uid: VOLUME_KEEP,
    sortOrder: 1,
    isPresent: 1,
    deletedAt: null,
    ...overrides,
  };
}

function schema12Chapter(overrides = {}) {
  return {
    id: 1,
    uid: CHAPTER_KEEP,
    volumeId: 1,
    num: 1,
    isPresent: 1,
    deletedAt: null,
    chapterPosition: 1,
    manuscriptPosition: 1,
    bodyRawSha256: BODY_OLD,
    status: 'writing',
    ...overrides,
  };
}

function schema11Volume(overrides = {}) {
  return {
    id: 1,
    sortOrder: 1,
    ...overrides,
  };
}

function schema11Chapter(overrides = {}) {
  return {
    id: 1,
    volumeId: 1,
    num: 7,
    bodyRawSha256: BODY_OLD,
    status: 'writing',
    ...overrides,
  };
}

function basisWithDigest(overrides = {}) {
  const draft = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: 8,
    volumes: [
      schema12Volume(),
      schema12Volume({
        id: 2,
        uid: VOLUME_TOMBSTONE,
        sortOrder: 2,
        isPresent: 0,
        deletedAt: '2026-02-01T00:00:00.000Z',
      }),
    ],
    chapters: [
      schema12Chapter(),
      schema12Chapter({
        id: 2,
        num: 2,
        uid: CHAPTER_DELETE,
        bodyRawSha256: BODY_STABLE,
      }),
      schema12Chapter({
        id: 3,
        uid: CHAPTER_REVIVE,
        volumeId: null,
        num: 1,
        isPresent: 0,
        deletedAt: '2026-03-01T00:00:00.000Z',
        chapterPosition: null,
        manuscriptPosition: null,
        bodyRawSha256: BODY_STABLE,
      }),
    ],
    sqliteSequence: [
      { name: 'chapters', seq: 3 },
      { name: 'volumes', seq: 2 },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
    pendingProposals: [
      { revisionId: 31, chapterId: 1 },
      { revisionId: 32, chapterId: 2 },
      { revisionId: 33, chapterId: 3 },
    ],
    basisDigest: ZERO_DIGEST,
    ...overrides,
  };
  draft.basisDigest = canonicalProjectionBasisDigest(draft);
  return draft;
}

function currentProjection(overrides = {}) {
  return deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    basis: basisWithDigest(),
    ...overrides,
  });
}

function capacitySnapshot() {
  return {
    state: 'active',
    measurements: {
      chapterIdentities: 4,
      volumeIdentities: 3,
      markdownBytes: 20,
      jsonBytes: 40,
      controlledFiles: 10,
      chapterDirectoryEntries: 8,
      controlledBytes: 240,
    },
    counters: {
      directoryEntries: 10,
      identityProbes: 10,
      contentOpens: 10,
      contentBytes: 240,
    },
    warnings: [],
    error: null,
  };
}

function fileIdentity(seed) {
  return { dev: '1', ino: String(seed) };
}

function absentIgnoredMember(role) {
  return { role, present: false };
}

function presentIgnoredMember(role, seed) {
  return {
    role,
    present: true,
    byteSize: 10 + seed,
    fileIdentity: fileIdentity(900 + seed),
    parentIdentity: fileIdentity(990 + seed),
  };
}

function ignoredChapterMembers(overrides = {}) {
  return [
    overrides.body ?? presentIgnoredMember('chapter_body', 1),
    overrides.sidecar ?? presentIgnoredMember('chapter_sidecar', 2),
  ];
}

function ignoredVolumeMembers(overrides = {}) {
  return [overrides.index ?? presentIgnoredMember('volume_index', 3)];
}

function ignoredMemberJson(members) {
  return JSON.stringify({ version: 1, members });
}

function controlledFileRef(role, resourceUid) {
  const input = { role, projectUid: PROJECT_UID };
  if (role === 'volume_index') input.volumeUid = resourceUid;
  if (role === 'chapter_body' || role === 'chapter_sidecar') input.chapterUid = resourceUid;
  return deriveControlledFileRef(input);
}

function controlledFile(role, resourceUid, seed, overrides = {}) {
  return {
    byteSize: 10 + seed,
    fileIdentity: fileIdentity(seed),
    parentIdentity: fileIdentity(seed + 100),
    rawSha256: seed.toString(16).padStart(64, '0'),
    ref: controlledFileRef(role, resourceUid),
    resourceUid,
    role,
    ...overrides,
  };
}

function controlledFact(role, resourceUid, seed, overrides = {}) {
  const { ref, ...fact } = controlledFile(role, resourceUid, seed, overrides);
  return fact;
}

function sortControlledFacts(rows) {
  rows.sort((left, right) => (
    left.role.localeCompare(right.role, 'en')
    || String(left.resourceUid ?? '').localeCompare(String(right.resourceUid ?? ''), 'en')
    || left.rawSha256.localeCompare(right.rawSha256, 'en')
  ));
}

function candidate(overrides = {}) {
  const value = {
    capacitySnapshot: capacitySnapshot(),
    chapters: [
      {
        bodyFileIdentity: fileIdentity(201),
        bodyRawSha256: BODY_NEW,
        chapterPosition: 1,
        chapterUid: CHAPTER_KEEP,
        cognitiveFrame: 'frame new',
        concreteMystery: 'mystery new',
        content: 'New body',
        contentAvailable: true,
        emotionalAnchor: 'anchor new',
        interpersonalTension: 'tension new',
        manuscriptPosition: 1,
        markdownMode: 'visual',
        outline: 'Outline new',
        sidecarFileIdentity: fileIdentity(202),
        sidecarRawSha256: SIDECAR_HASH,
        status: 'accepted',
        summary: 'Summary new',
        title: 'Chapter keep new',
        volumeUid: VOLUME_KEEP,
        wordCount: 9,
        worldTexture: 'texture new',
      },
      {
        bodyFileIdentity: fileIdentity(203),
        bodyRawSha256: BODY_STABLE,
        chapterPosition: 1,
        chapterUid: CHAPTER_REVIVE,
        cognitiveFrame: 'revived frame',
        concreteMystery: 'revived mystery',
        content: 'Revived body',
        contentAvailable: true,
        emotionalAnchor: 'revived anchor',
        interpersonalTension: 'revived tension',
        manuscriptPosition: 3,
        markdownMode: 'visual',
        outline: 'Revived outline',
        sidecarFileIdentity: fileIdentity(204),
        sidecarRawSha256: SIDECAR_HASH,
        status: 'writing',
        summary: 'Revived summary',
        title: 'Revived chapter',
        volumeUid: null,
        wordCount: 12,
        worldTexture: 'revived texture',
      },
      {
        bodyFileIdentity: fileIdentity(205),
        bodyRawSha256: BODY_STABLE,
        chapterPosition: 1,
        chapterUid: CHAPTER_NEW,
        cognitiveFrame: 'new frame',
        concreteMystery: 'new mystery',
        content: 'Brand new body',
        contentAvailable: true,
        emotionalAnchor: 'new anchor',
        interpersonalTension: 'new tension',
        manuscriptPosition: 2,
        markdownMode: 'visual',
        outline: 'Brand new outline',
        sidecarFileIdentity: fileIdentity(206),
        sidecarRawSha256: SIDECAR_HASH,
        status: 'pending',
        summary: 'Brand new summary',
        title: 'Brand new chapter',
        volumeUid: VOLUME_NEW,
        wordCount: 14,
        worldTexture: 'new texture',
      },
    ],
    controlledFiles: [
      controlledFile('manuscript', null, 1),
      controlledFile('unassigned', null, 2),
      controlledFile('volume_index', VOLUME_KEEP, 3),
      controlledFile('volume_index', VOLUME_NEW, 4),
      controlledFile('chapter_body', CHAPTER_KEEP, 5, {
        fileIdentity: fileIdentity(201),
        rawSha256: BODY_NEW,
      }),
      controlledFile('chapter_sidecar', CHAPTER_KEEP, 6, {
        fileIdentity: fileIdentity(202),
        rawSha256: SIDECAR_HASH,
      }),
      controlledFile('chapter_body', CHAPTER_REVIVE, 7, {
        fileIdentity: fileIdentity(203),
        rawSha256: BODY_STABLE,
      }),
      controlledFile('chapter_sidecar', CHAPTER_REVIVE, 8, {
        fileIdentity: fileIdentity(204),
        rawSha256: SIDECAR_HASH,
      }),
      controlledFile('chapter_body', CHAPTER_NEW, 9, {
        fileIdentity: fileIdentity(205),
        rawSha256: BODY_STABLE,
      }),
      controlledFile('chapter_sidecar', CHAPTER_NEW, 10, {
        fileIdentity: fileIdentity(206),
        rawSha256: SIDECAR_HASH,
      }),
    ],
    diagnostics: { journalCandidates: [], residues: [] },
    ignoredLedgerAfter: [],
    projectUid: PROJECT_UID,
    volumeOrder: [VOLUME_KEEP, VOLUME_NEW],
    volumes: [
      { summary: 'Volume summary new', title: 'Volume keep new', volumePosition: 1, volumeUid: VOLUME_KEEP },
      { summary: 'New volume summary', title: 'New volume', volumePosition: 2, volumeUid: VOLUME_NEW },
    ],
    warnings: [],
    ...overrides,
  };
  return deepFreeze(value);
}

function identityPlan() {
  return deepFreeze([
    { assignmentKind: 'reuse_uid', objectKind: 'chapter', uid: CHAPTER_DELETE, id: 2, num: 2 },
    { assignmentKind: 'reserved_new', objectKind: 'chapter', uid: CHAPTER_NEW, id: 4, num: 1, reservationId: 'reservation-chapter-new' },
    { assignmentKind: 'reuse_uid', objectKind: 'chapter', uid: CHAPTER_KEEP, id: 1, num: 1 },
    { assignmentKind: 'reuse_uid', objectKind: 'chapter', uid: CHAPTER_REVIVE, id: 3, num: 1 },
    { assignmentKind: 'reuse_uid', objectKind: 'volume', uid: VOLUME_KEEP, id: 1 },
    { assignmentKind: 'reserved_new', objectKind: 'volume', uid: VOLUME_NEW, id: 3, reservationId: 'reservation-volume-new' },
    { assignmentKind: 'reuse_uid', objectKind: 'volume', uid: VOLUME_TOMBSTONE, id: 2 },
  ].sort((left, right) => `${left.objectKind}:${left.uid}`.localeCompare(`${right.objectKind}:${right.uid}`, 'en')));
}

function ignoredRow(projectionGeneration, overrides = {}) {
  const resourceKind = overrides.resource_kind ?? 'chapter';
  const members = overrides.members ?? (
    resourceKind === 'chapter' ? ignoredChapterMembers() : ignoredVolumeMembers()
  );
  return {
    resource_kind: resourceKind,
    resource_uid: overrides.resource_uid ?? uuid(90),
    ignore_status: overrides.ignore_status ?? 'active',
    opaque_container_kind: Object.hasOwn(overrides, 'opaque_container_kind')
      ? overrides.opaque_container_kind
      : 'unassigned',
    opaque_container_uid: Object.hasOwn(overrides, 'opaque_container_uid')
      ? overrides.opaque_container_uid
      : null,
    is_currently_referenced: overrides.is_currently_referenced ?? 1,
    member_snapshot_json: overrides.member_snapshot_json ?? ignoredMemberJson(members),
    projection_generation: projectionGeneration,
  };
}

function ignoredBefore(overrides = {}) {
  return deepFreeze([ignoredRow(8, overrides)]);
}

function ignoredAfter(overrides = {}) {
  return deepFreeze([ignoredRow(9, overrides)]);
}

function ignoredObservation(overrides = {}) {
  const kind = overrides.kind ?? 'chapter';
  return {
    kind,
    uid: overrides.uid ?? uuid(90),
    status: overrides.status ?? 'active',
    members: overrides.members ?? (
      kind === 'chapter' ? ignoredChapterMembers() : ignoredVolumeMembers()
    ),
    reference: overrides.reference ?? {
      state: 'indexed',
      containerKind: kind === 'chapter' ? 'unassigned' : 'manuscript',
      containerUid: null,
    },
  };
}

function buildDefaultTarget(store = new SQLiteProjectionStore(), overrides = {}) {
  return store.buildTarget({
    candidate: candidate(),
    currentProjection: currentProjection(),
    targetGeneration: 9,
    projectedAt: PROJECTED_AT,
    ignoredLedger: deepFreeze([]),
    localIdentityPlan: identityPlan(),
    ...overrides,
  });
}

function emptySchema12CurrentProjection(
  projectUid,
  ignoredRows,
  projectInstanceId = PROJECT_INSTANCE_ID,
) {
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: 0,
    volumes: [],
    chapters: [],
    sqliteSequence: [{ name: 'chapters', seq: 0 }, { name: 'volumes', seq: 0 }],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(ignoredRows),
    pendingProposals: [],
    basisDigest: ZERO_DIGEST,
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return deepFreeze({ projectUid, projectInstanceId, basis });
}

test('currentProjectionAfterTarget derives one exact frozen schema12 basis without rescanning', () => {
  const target = buildDefaultTarget();

  const current = currentProjectionAfterTarget(target);

  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.basis), true);
  assert.equal(current.projectUid, target.projectUid);
  assert.equal(current.projectInstanceId, target.projectInstanceId);
  assert.equal(current.basis.sourceKind, 'schema12');
  assert.equal(current.basis.baseGeneration, target.targetGeneration);
  assert.deepEqual(current.basis.sqliteSequence, target.sqliteSequence);
  assert.equal(
    current.basis.ignoredBeforeDigest,
    canonicalIgnoredLedgerDigest(target.ignoredLedger),
  );
  assert.deepEqual(
    current.basis.pendingProposals,
    target.basis.pendingProposals.filter((proposal) => (
      !target.proposalInvalidations.some(({ revisionId }) => revisionId === proposal.revisionId)
    )),
  );
  assert.equal(
    current.basis.basisDigest,
    canonicalProjectionBasisDigest(current.basis),
  );
  const tombstoneVolume = current.basis.volumes.find(({ uid }) => uid === VOLUME_TOMBSTONE);
  const baseTombstoneVolume = target.basis.volumes.find(({ uid }) => uid === VOLUME_TOMBSTONE);
  assert.equal(tombstoneVolume.sortOrder, baseTombstoneVolume.sortOrder);
  const tombstoneChapter = current.basis.chapters.find(({ uid }) => uid === CHAPTER_DELETE);
  const baseTombstoneChapter = target.basis.chapters.find(({ uid }) => uid === CHAPTER_DELETE);
  assert.equal(tombstoneChapter.bodyRawSha256, baseTombstoneChapter.bodyRawSha256);
  assert.equal(tombstoneChapter.status, baseTombstoneChapter.status);
  assert.doesNotThrow(() => canonicalSchema12ReuseIdentityPlan(current));
});

test('installed orphan baseline receipt is Store-private, exact-generation, and binds complete schema12 facts', () => {
  const store = new SQLiteProjectionStore();
  const target = buildDefaultTarget(store);
  const installedProjection = currentProjectionAfterTarget(target);
  const queries = [];
  const projectStore = Object.freeze({
    readAll(sql) {
      queries.push(sql);
      if (/FROM volumes/u.test(sql)) {
        return target.volumes.filter((row) => row.is_present === 1).map((row) => ({ ...row }));
      }
      if (/FROM chapters/u.test(sql)) {
        return target.chapters.filter((row) => row.is_present === 1).map((row) => ({ ...row }));
      }
      if (/FROM manuscript_controlled_files/u.test(sql)) {
        return target.controlledFiles.map((row) => ({
          file_role: row.role,
          resource_uid: row.resourceUid,
          raw_sha256: row.rawSha256,
          byte_size: row.byteSize,
          file_identity_json: JSON.stringify({
            fileIdentity: row.fileIdentity,
            parentIdentity: row.parentIdentity,
          }),
          projection_generation: target.targetGeneration,
        }));
      }
      if (/FROM manuscript_capacity_snapshot/u.test(sql)) {
        const measurements = target.capacitySnapshot.measurements;
        return [{
          singleton_id: 1,
          chapter_identities: measurements.chapterIdentities,
          volume_identities: measurements.volumeIdentities,
          controlled_files: measurements.controlledFiles,
          chapter_directory_entries: measurements.chapterDirectoryEntries,
          controlled_bytes: measurements.controlledBytes,
          projection_generation: target.targetGeneration,
        }];
      }
      throw new Error(`unexpected installed baseline query: ${sql}`);
    },
  });

  const receipt = store.captureInstalledOrphanBaseline({
    projectStore,
    currentProjection: installedProjection,
    ignoredLedger: target.ignoredLedger,
  });
  const authority = store.installedOrphanBaselineAuthority();
  const description = authority.describe(receipt);

  assert.equal(authority.assert(receipt), receipt);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Reflect.ownKeys(receipt), []);
  assert.equal(description.projectUid, target.projectUid);
  assert.equal(description.projectInstanceId, target.projectInstanceId);
  assert.equal(description.baseGeneration, target.targetGeneration);
  assert.equal(description.basisDigest, installedProjection.basis.basisDigest);
  assert.equal(description.ignoredDigest, installedProjection.basis.ignoredBeforeDigest);
  assert.equal(description.volumes.length, target.volumes.filter((row) => row.is_present === 1).length);
  assert.equal(description.chapters.length, target.chapters.filter((row) => row.is_present === 1).length);
  assert.equal(description.controlledFiles.length, target.controlledFiles.length);
  assert.equal(description.capacity.projection_generation, target.targetGeneration);
  assert.equal(queries.length, 4);
  assert.throws(() => authority.assert(Object.freeze({})), TypeError);
  assert.throws(
    () => new SQLiteProjectionStore().installedOrphanBaselineAuthority().assert(receipt),
    TypeError,
  );
  let getterCalls = 0;
  const poisonedProjectStore = {};
  Object.defineProperty(poisonedProjectStore, 'readAll', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('poisoned installed baseline readAll');
    },
  });
  assert.throws(() => store.captureInstalledOrphanBaseline({
    projectStore: poisonedProjectStore,
    currentProjection: installedProjection,
    ignoredLedger: target.ignoredLedger,
  }), TypeError);
  assert.equal(getterCalls, 0);
});

function reservedPlanForCandidate(value) {
  return deepFreeze([
    ...value.volumes.map((row, index) => ({
      assignmentKind: 'reserved_new',
      objectKind: 'volume',
      uid: row.volumeUid,
      id: index + 1,
      reservationId: `fixture-volume-${index + 1}`,
    })),
    ...value.chapters.map((row, index) => ({
      assignmentKind: 'reserved_new',
      objectKind: 'chapter',
      uid: row.chapterUid,
      id: index + 1,
      num: row.chapterPosition,
      reservationId: `fixture-chapter-${index + 1}`,
    })),
  ].sort((left, right) => (
    `${left.objectKind}:${left.uid}`.localeCompare(`${right.objectKind}:${right.uid}`, 'en')
  )));
}

test('canonical digests are exact, order-independent, compact, and exclude only basis self digest', () => {
  const basis = basisWithDigest();
  const permuted = clone(basis);
  permuted.volumes = permuted.volumes.reverse()
    .map((row) => Object.fromEntries(Object.entries(row).reverse()));
  permuted.chapters = permuted.chapters.reverse()
    .map((row) => Object.fromEntries(Object.entries(row).reverse()));
  permuted.sqliteSequence.reverse();
  permuted.pendingProposals.reverse();
  permuted.basisDigest = 'f'.repeat(64);

  assert.equal(canonicalProjectionBasisDigest(permuted), basis.basisDigest);
  const changed = clone(basis);
  changed.chapters[0].bodyRawSha256 = BODY_STABLE;
  assert.notEqual(canonicalProjectionBasisDigest(changed), basis.basisDigest);
  const tombstoneNullHash = clone(basis);
  tombstoneNullHash.chapters.find((row) => row.uid === CHAPTER_REVIVE).bodyRawSha256 = null;
  assert.match(canonicalProjectionBasisDigest(tombstoneNullHash), /^[0-9a-f]{64}$/);
  const activeNullHash = clone(basis);
  activeNullHash.chapters.find((row) => row.uid === CHAPTER_KEEP).bodyRawSha256 = null;
  assert.throws(() => canonicalProjectionBasisDigest(activeNullHash), TypeError);
  for (const negativeZero of [
    { ...clone(basis), baseGeneration: -0 },
    {
      ...clone(basis),
      volumes: basis.volumes.map((row, index) => (index === 0 ? { ...row, sortOrder: -0 } : row)),
    },
  ]) assert.throws(() => canonicalProjectionBasisDigest(negativeZero), TypeError);
  assert.equal(Object.hasOwn(basis.chapters[0], 'content'), false);
  assert.equal(Object.hasOwn(basis.chapters[0], 'data_version'), false);
  assert.equal(Object.hasOwn(basis.volumes[0], 'title'), false);
  assert.throws(
    () => canonicalProjectionBasisDigest({ ...basis, extra: true }),
    TypeError,
  );
  assert.throws(
    () => canonicalProjectionBasisDigest({ ...basis, chapters: [...basis.chapters, clone(basis.chapters[0])] }),
    TypeError,
  );

  const ledger = [
    ...ignoredAfter(),
    {
      resource_kind: 'volume',
      resource_uid: uuid(91),
      ignore_status: 'revoked',
      opaque_container_kind: null,
      opaque_container_uid: null,
      is_currently_referenced: 0,
      member_snapshot_json: ignoredMemberJson(ignoredVolumeMembers()),
      projection_generation: 9,
    },
  ];
  const permutedLedger = [...ledger].reverse()
    .map((row) => Object.fromEntries(Object.entries(row).reverse()));
  assert.equal(canonicalIgnoredLedgerDigest(ledger), canonicalIgnoredLedgerDigest(permutedLedger));
  const changedLedger = clone(ledger);
  changedLedger[0].member_snapshot_json = ignoredMemberJson(ignoredChapterMembers({
    body: absentIgnoredMember('chapter_body'),
  }));
  assert.notEqual(canonicalIgnoredLedgerDigest(changedLedger), canonicalIgnoredLedgerDigest(ledger));
  const negativeZeroLedger = clone(ledger);
  negativeZeroLedger[0].projection_generation = -0;
  assert.throws(() => canonicalIgnoredLedgerDigest(negativeZeroLedger), TypeError);
  const negativeZeroLedgerFlag = clone(ledger);
  negativeZeroLedgerFlag[0].is_currently_referenced = -0;
  assert.throws(() => canonicalIgnoredLedgerDigest(negativeZeroLedgerFlag), TypeError);
  assert.throws(() => canonicalIgnoredLedgerDigest([{ ...ledger[0], extra: true }]), TypeError);
});

test('ignored rows require canonical member snapshots and the exact resource/container matrix', () => {
  const base = clone(ignoredAfter()[0]);
  const invalidRows = [
    ['invalid member JSON', { ...base, member_snapshot_json: '{' }],
    ['non-canonical member JSON', {
      ...base,
      member_snapshot_json: JSON.stringify({
        members: ignoredChapterMembers(),
        version: 1,
      }),
    }],
    ['detached row with container kind', {
      ...base,
      is_currently_referenced: 0,
      opaque_container_kind: 'unassigned',
      opaque_container_uid: null,
    }],
    ['referenced row without container kind', {
      ...base,
      opaque_container_kind: null,
      opaque_container_uid: null,
    }],
    ['volume container without UID', {
      ...base,
      opaque_container_kind: 'volume',
      opaque_container_uid: null,
    }],
    ['unassigned container with UID', {
      ...base,
      opaque_container_kind: 'unassigned',
      opaque_container_uid: VOLUME_KEEP,
    }],
    ['chapter in manuscript container', {
      ...base,
      opaque_container_kind: 'manuscript',
    }],
  ];
  for (const [name, row] of invalidRows) {
    assert.throws(() => canonicalIgnoredLedgerDigest([row]), TypeError, name);
  }

  assert.match(canonicalIgnoredLedgerDigest([{
    ...base,
    opaque_container_kind: 'volume',
    opaque_container_uid: VOLUME_KEEP,
  }]), /^[0-9a-f]{64}$/);
  assert.match(canonicalIgnoredLedgerDigest([{
    ...base,
    is_currently_referenced: 0,
    opaque_container_kind: null,
    opaque_container_uid: null,
  }]), /^[0-9a-f]{64}$/);
  assert.match(canonicalIgnoredLedgerDigest([{
    ...base,
    resource_kind: 'volume',
    resource_uid: uuid(92),
    opaque_container_kind: 'manuscript',
    opaque_container_uid: null,
    member_snapshot_json: ignoredMemberJson(ignoredVolumeMembers()),
  }]), /^[0-9a-f]{64}$/);
  assert.throws(() => canonicalIgnoredLedgerDigest([{
    ...base,
    resource_kind: 'volume',
    resource_uid: uuid(92),
    opaque_container_kind: 'unassigned',
    opaque_container_uid: null,
    member_snapshot_json: ignoredMemberJson(ignoredVolumeMembers()),
  }]), TypeError);
});

test('buildTarget binds complete base ledger rows and derives target rows only from candidate observations', () => {
  const beforeRows = ignoredBefore();
  const basis = basisWithDigest({
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(beforeRows),
  });
  const current = deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    basis,
  });
  const changedMembers = ignoredChapterMembers({
    body: absentIgnoredMember('chapter_body'),
  });
  const changedObservation = ignoredObservation({
    members: changedMembers,
    reference: {
      state: 'indexed',
      containerKind: 'volume',
      containerUid: VOLUME_KEEP,
    },
  });
  const compiled = buildDefaultTarget(undefined, {
    candidate: candidate({ ignoredLedgerAfter: deepFreeze([changedObservation]) }),
    currentProjection: current,
    ignoredLedger: beforeRows,
  });
  assert.deepEqual(compiled.ignoredLedger, ignoredAfter({
    opaque_container_kind: 'volume',
    opaque_container_uid: VOLUME_KEEP,
    members: changedMembers,
  }));

  for (const [name, ignoredLedgerAfter] of [
    ['missing observation', []],
    ['extra observation', [ignoredObservation(), ignoredObservation({ uid: uuid(93) })]],
    ['status mismatch', [ignoredObservation({ status: 'revoked' })]],
  ]) {
    assert.throws(() => buildDefaultTarget(undefined, {
      candidate: candidate({ ignoredLedgerAfter: deepFreeze(ignoredLedgerAfter) }),
      currentProjection: current,
      ignoredLedger: beforeRows,
    }), TypeError, name);
  }

  assert.throws(() => buildDefaultTarget(undefined, {
    candidate: candidate({ ignoredLedgerAfter: deepFreeze([ignoredObservation()]) }),
    currentProjection: current,
    ignoredLedger: ignoredAfter(),
  }), TypeError, 'caller cannot inject SQL-shaped target rows');

  const staleBefore = deepFreeze([ignoredRow(7)]);
  const staleBasis = basisWithDigest({
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(staleBefore),
  });
  assert.throws(() => buildDefaultTarget(undefined, {
    currentProjection: deepFreeze({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      basis: staleBasis,
    }),
    ignoredLedger: staleBefore,
  }), TypeError, 'every before row must use the base generation');
});

test('buildTarget does not rewalk compiler-branded ignored rows', () => {
  const beforeRows = ignoredBefore();
  const basis = basisWithDigest({
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(beforeRows),
  });
  const originalDescriptors = Object.getOwnPropertyDescriptors;
  const originalIterator = Array.prototype[Symbol.iterator];
  const originalSome = Array.prototype.some;
  let brandedLedgerWalks = 0;
  function isCompiledLedger(value) {
    return (
      Array.isArray(value)
      && value.length === 1
      && value[0]?.resource_uid === uuid(90)
      && value[0]?.projection_generation === 9
    );
  }
  Object.getOwnPropertyDescriptors = function observeDescriptors(value) {
    if (isCompiledLedger(value)) brandedLedgerWalks += 1;
    return originalDescriptors(value);
  };
  Array.prototype[Symbol.iterator] = function observeIterator(...args) {
    if (isCompiledLedger(this)) brandedLedgerWalks += 1;
    return originalIterator.apply(this, args);
  };
  Array.prototype.some = function observeSome(...args) {
    if (isCompiledLedger(this)) brandedLedgerWalks += 1;
    return originalSome.apply(this, args);
  };
  try {
    buildDefaultTarget(undefined, {
      candidate: candidate({
        ignoredLedgerAfter: deepFreeze([ignoredObservation()]),
      }),
      currentProjection: deepFreeze({
        projectUid: PROJECT_UID,
        projectInstanceId: PROJECT_INSTANCE_ID,
        basis,
      }),
      ignoredLedger: beforeRows,
    });
  } finally {
    Object.getOwnPropertyDescriptors = originalDescriptors;
    Array.prototype[Symbol.iterator] = originalIterator;
    Array.prototype.some = originalSome;
  }
  assert.equal(brandedLedgerWalks, 0);
});

test('validateTarget keeps cold ignored rows canonical, ordered, and target-generation bound', () => {
  const beforeRows = deepFreeze([
    ignoredRow(8),
    ignoredRow(8, {
      resource_kind: 'volume',
      resource_uid: uuid(91),
      opaque_container_kind: 'manuscript',
      opaque_container_uid: null,
      members: ignoredVolumeMembers(),
    }),
  ]);
  const basis = basisWithDigest({
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(beforeRows),
  });
  const target = buildDefaultTarget(undefined, {
    candidate: candidate({
      ignoredLedgerAfter: deepFreeze([
        ignoredObservation(),
        ignoredObservation({ kind: 'volume', uid: uuid(91) }),
      ]),
    }),
    currentProjection: deepFreeze({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      basis,
    }),
    ignoredLedger: beforeRows,
  });
  const store = new SQLiteProjectionStore();
  const cold = deepFreeze(clone(target));
  assert.strictEqual(store.validateTarget(cold), cold);

  const reversed = clone(target);
  reversed.ignoredLedger.reverse();
  assert.throws(() => store.validateTarget(deepFreeze(reversed)), TypeError);

  const wrongGeneration = clone(target);
  wrongGeneration.ignoredLedger[0].projection_generation = 8;
  assert.throws(() => store.validateTarget(deepFreeze(wrongGeneration)), TypeError);

  const nonCanonicalMemberJson = clone(target);
  const snapshot = JSON.parse(nonCanonicalMemberJson.ignoredLedger[0].member_snapshot_json);
  nonCanonicalMemberJson.ignoredLedger[0].member_snapshot_json = JSON.stringify({
    members: snapshot.members,
    version: snapshot.version,
  });
  assert.throws(() => store.validateTarget(deepFreeze(nonCanonicalMemberJson)), TypeError);
});

test('buildTarget compiles one immutable deterministic full target with reuse, tombstone, revival, and reserved rows', () => {
  const first = buildDefaultTarget();
  const second = buildDefaultTarget();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.basis.chapters[0]), true);
  assert.equal(Object.isFrozen(first.controlledFiles[0].fileIdentity), true);
  assert.equal(first.projectUid, PROJECT_UID);
  assert.equal(first.projectInstanceId, PROJECT_INSTANCE_ID);
  assert.equal(first.baseGeneration, 8);
  assert.equal(first.targetGeneration, 9);
  assert.equal(first.projectedAt, PROJECTED_AT);
  assert.equal(first.basisDigest, first.basis.basisDigest);
  assert.deepEqual(first.sqliteSequence, [
    { name: 'chapters', seq: 4 },
    { name: 'volumes', seq: 3 },
  ]);
  assert.deepEqual(Object.keys(first.basis.volumes[0]).sort(), [
    'deletedAt', 'id', 'isPresent', 'sortOrder', 'uid',
  ]);
  assert.deepEqual(Object.keys(first.basis.chapters[0]).sort(), [
    'bodyRawSha256', 'chapterPosition', 'deletedAt', 'id', 'isPresent',
    'manuscriptPosition', 'num', 'status', 'uid', 'volumeId',
  ]);
  assert.equal(first.basis.ignoredBeforeDigest, canonicalIgnoredLedgerDigest([]));

  const volumes = new Map(first.volumes.map((row) => [row.volume_uid, row]));
  assert.deepEqual(
    { id: volumes.get(VOLUME_KEEP).id, title: volumes.get(VOLUME_KEEP).title, isPresent: volumes.get(VOLUME_KEEP).is_present },
    { id: 1, title: 'Volume keep new', isPresent: 1 },
  );
  assert.deepEqual(
    volumes.get(VOLUME_TOMBSTONE),
    {
      id: 2,
      volume_uid: VOLUME_TOMBSTONE,
      is_present: 0,
      deleted_at: '2026-02-01T00:00:00.000Z',
    },
  );
  assert.deepEqual(
    { id: volumes.get(VOLUME_NEW).id, hasCreatedAt: Object.hasOwn(volumes.get(VOLUME_NEW), 'created_at') },
    { id: 3, hasCreatedAt: false },
  );

  const chapters = new Map(first.chapters.map((row) => [row.chapter_uid, row]));
  assert.deepEqual(
    {
      id: chapters.get(CHAPTER_KEEP).id,
      num: chapters.get(CHAPTER_KEEP).num,
      content: chapters.get(CHAPTER_KEEP).content,
      status: chapters.get(CHAPTER_KEEP).status,
      position: chapters.get(CHAPTER_KEEP).manuscript_position,
    },
    { id: 1, num: 1, content: 'New body', status: 'accepted', position: 1 },
  );
  assert.deepEqual(
    chapters.get(CHAPTER_DELETE),
    {
      id: 2,
      num: 2,
      chapter_uid: CHAPTER_DELETE,
      is_present: 0,
      deleted_at: PROJECTED_AT,
      chapter_position: null,
      manuscript_position: null,
    },
  );
  assert.deepEqual(
    {
      id: chapters.get(CHAPTER_REVIVE).id,
      present: chapters.get(CHAPTER_REVIVE).is_present,
      deletedAt: chapters.get(CHAPTER_REVIVE).deleted_at,
    },
    { id: 3, present: 1, deletedAt: null },
  );
  assert.deepEqual(
    {
      id: chapters.get(CHAPTER_NEW).id,
      num: chapters.get(CHAPTER_NEW).num,
      volumeId: chapters.get(CHAPTER_NEW).volume_id,
      hasCreatedAt: Object.hasOwn(chapters.get(CHAPTER_NEW), 'created_at'),
    },
    { id: 4, num: 1, volumeId: 3, hasCreatedAt: false },
  );
  const targetBodyBytes = first.chapters
    .filter((row) => row.is_present === 1)
    .reduce((total, row) => total + Buffer.byteLength(row.content, 'utf8'), 0);
  const candidateBodyBytes = candidate().chapters
    .reduce((total, row) => total + Buffer.byteLength(row.content, 'utf8'), 0);
  assert.equal(targetBodyBytes, candidateBodyBytes);
  for (const row of first.chapters.filter((entry) => entry.is_present === 0)) {
    assert.equal(Object.hasOwn(row, 'content'), false);
    assert.equal(Object.hasOwn(row, 'data_version'), false);
  }
  assert.deepEqual(first.capacitySnapshot, candidate().capacitySnapshot);
  assert.deepEqual(first.ignoredLedger, []);
  assert.equal(first.controlledFiles.length, 10);
  assert.equal(first.controlledFiles.some((row) => Object.hasOwn(row, 'ref')), false);
  assert.throws(() => { first.chapters[0].title = 'mutated'; }, TypeError);

  const nullableTombstoneBasis = clone(basisWithDigest());
  nullableTombstoneBasis.chapters
    .find((row) => row.uid === CHAPTER_REVIVE).bodyRawSha256 = null;
  nullableTombstoneBasis.basisDigest = canonicalProjectionBasisDigest(nullableTombstoneBasis);
  const nullableTarget = buildDefaultTarget(undefined, {
    currentProjection: deepFreeze({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      basis: nullableTombstoneBasis,
    }),
  });
  assert.equal(nullableTarget.basis.chapters.find((row) => row.uid === CHAPTER_REVIVE).bodyRawSha256, null);

  for (const mutate of [
    (value) => { value.controlledFiles[0].byteSize = -0; },
    (value) => { value.controlledFiles[0].fileIdentity = { dev: '1', ino: '2', extra: true }; },
    (value) => { value.capacitySnapshot.measurements.controlledBytes = -0; },
    (value) => { value.capacitySnapshot.extra = true; },
    (value) => { value.chapters[0].title = 7; },
  ]) {
    const sourceCandidate = candidate();
    const invalidCandidate = cloneCandidate(sourceCandidate);
    mutate(invalidCandidate);
    assert.throws(
      () => buildDefaultTarget(undefined, { candidate: deepFreeze(invalidCandidate) }),
      TypeError,
    );
  }

  const refMismatchCases = [
    (value) => {
      value.controlledFiles.find((row) => row.role === 'manuscript').ref = deriveControlledFileRef({
        role: 'manuscript',
        projectUid: uuid(998),
      });
    },
    (value) => {
      value.controlledFiles.find((row) => row.role === 'volume_index').ref = deriveControlledFileRef({
        role: 'volume_index',
        projectUid: PROJECT_UID,
        volumeUid: uuid(997),
      });
    },
    (value) => {
      value.controlledFiles.find((row) => row.role === 'chapter_body').ref = deriveControlledFileRef({
        role: 'chapter_body',
        projectUid: PROJECT_UID,
        chapterUid: uuid(996),
      });
    },
  ];
  for (const mutate of refMismatchCases) {
    const invalidCandidate = cloneCandidate(candidate());
    mutate(invalidCandidate);
    assert.throws(
      () => buildDefaultTarget(undefined, { candidate: deepFreeze(invalidCandidate) }),
      TypeError,
    );
  }
  assert.throws(
    () => buildDefaultTarget(undefined, { candidate: deepFreeze(clone(candidate())) }),
    TypeError,
  );
});

test('buildTarget consumes a real Task3 branded candidate and persists only controlled-file facts', async () => {
  const fixture = createManuscriptTreeFixture();
  const beforeRows = deepFreeze([ignoredRow(0, {
    resource_uid: FIXTURE_CHAPTER_UID,
    opaque_container_kind: 'volume',
    opaque_container_uid: FIXTURE_VOLUME_UID,
    members: ignoredChapterMembers({
      body: absentIgnoredMember('chapter_body'),
      sidecar: absentIgnoredMember('chapter_sidecar'),
    }),
  })]);
  const ledger = new IgnoredIdentityLedger();
  const manuscriptStore = new ManuscriptStore({
    dataRoot: fixture.dataRoot,
    fileBoundary: fixture.fileBoundary,
    journalAuthority: fixture.journalAuthority,
    limits: LIMITS,
  });
  const snapshot = await manuscriptStore.validateFull(fixture.projectBinding, {
    ignoredLedger: ledger.toValidationEntries(beforeRows, 0),
    lifecycleBasis: Object.freeze({
      ...fixture.lifecycleBasis,
      activeChapterUids: Object.freeze([FIXTURE_UNASSIGNED_CHAPTER_UID]),
    }),
  });
  const task3Candidate = await manuscriptStore.buildProjectionCandidate(snapshot);
  const target = new SQLiteProjectionStore().buildTarget({
    candidate: task3Candidate,
    currentProjection: emptySchema12CurrentProjection(task3Candidate.projectUid, beforeRows),
    targetGeneration: 1,
    projectedAt: PROJECTED_AT,
    ignoredLedger: beforeRows,
    localIdentityPlan: reservedPlanForCandidate(task3Candidate),
  });

  assert.equal(target.controlledFiles.length, task3Candidate.controlledFiles.length);
  assert.equal(target.controlledFiles.some((row) => Object.hasOwn(row, 'ref')), false);
  assert.deepEqual(
    target.controlledFiles.map(({ role, resourceUid }) => ({ role, resourceUid })),
    task3Candidate.controlledFiles
      .map(({ role, resourceUid }) => ({ role, resourceUid }))
      .sort((left, right) => (
        left.role.localeCompare(right.role, 'en')
        || String(left.resourceUid ?? '').localeCompare(String(right.resourceUid ?? ''), 'en')
      )),
  );
  assert.equal(task3Candidate.ignoredLedgerAfter.length, 1);
  assert.equal(task3Candidate.ignoredLedgerAfter[0].uid, FIXTURE_CHAPTER_UID);
  assert.deepEqual(target.ignoredLedger, ledger.compileAfter({
    beforeRows,
    observations: task3Candidate.ignoredLedgerAfter,
    targetGeneration: 1,
  }));
  assert.equal(target.ignoredLedger[0].opaque_container_kind, 'volume');
  assert.equal(target.ignoredLedger[0].opaque_container_uid, FIXTURE_VOLUME_UID);
  assert.equal(target.ignoredLedger[0].projection_generation, 1);
});

test('buildTarget distinguishes legacy binding from reserved-new and rejects incomplete or conflicting identity plans', () => {
  const store = new SQLiteProjectionStore();
  const legacyDraft = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema11',
    baseGeneration: 0,
    volumes: [schema11Volume()],
    chapters: [schema11Chapter()],
    sqliteSequence: [{ name: 'chapters', seq: 1 }, { name: 'volumes', seq: 1 }],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
    pendingProposals: [],
    basisDigest: ZERO_DIGEST,
  };
  legacyDraft.basisDigest = canonicalProjectionBasisDigest(legacyDraft);
  const legacyCurrent = deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    basis: legacyDraft,
  });
  const legacyCandidate = candidate({
    chapters: [candidate().chapters[0]],
    controlledFiles: candidate().controlledFiles.filter((row) => (
      row.resourceUid === null
      || row.resourceUid === VOLUME_KEEP
      || row.resourceUid === CHAPTER_KEEP
    )),
    volumeOrder: [VOLUME_KEEP],
    volumes: [candidate().volumes[0]],
  });
  const legacyPlan = deepFreeze([
    { assignmentKind: 'bind_legacy', objectKind: 'chapter', uid: CHAPTER_KEEP, id: 1, num: 7, reservationId: 'migration-chapter' },
    { assignmentKind: 'bind_legacy', objectKind: 'volume', uid: VOLUME_KEEP, id: 1, reservationId: 'migration-volume' },
  ]);
  const legacyTarget = store.buildTarget({
    candidate: legacyCandidate,
    currentProjection: legacyCurrent,
    targetGeneration: 1,
    projectedAt: PROJECTED_AT,
    ignoredLedger: deepFreeze([]),
    localIdentityPlan: legacyPlan,
  });
  assert.equal(legacyTarget.volumes[0].id, 1);
  assert.equal(legacyTarget.chapters[0].id, 1);
  assert.equal(legacyTarget.chapters[0].num, 7);
  assert.equal(legacyTarget.basis.chapters[0].bodyRawSha256, BODY_OLD);
  assert.equal(Object.hasOwn(legacyTarget.basis.chapters[0], 'content'), false);

  const absentLegacyCandidate = candidate({
    chapters: [],
    controlledFiles: candidate().controlledFiles.filter((row) => row.resourceUid === null),
    volumeOrder: [],
    volumes: [],
  });
  const absentLegacyTarget = store.buildTarget({
    candidate: absentLegacyCandidate,
    currentProjection: legacyCurrent,
    targetGeneration: 1,
    projectedAt: PROJECTED_AT,
    ignoredLedger: deepFreeze([]),
    localIdentityPlan: legacyPlan,
  });
  assert.equal(absentLegacyTarget.volumes[0].deleted_at, PROJECTED_AT);
  assert.equal(absentLegacyTarget.chapters[0].deleted_at, PROJECTED_AT);
  const changedLegacyTombstone = clone(absentLegacyTarget);
  changedLegacyTombstone.chapters[0].deleted_at = '2026-08-17T08:09:11.123Z';
  assert.throws(
    () => store.validateTarget(deepFreeze(changedLegacyTombstone)),
    TypeError,
  );

  const missingNew = identityPlan().filter((entry) => entry.uid !== CHAPTER_NEW);
  assert.throws(
    () => buildDefaultTarget(store, { localIdentityPlan: deepFreeze(missingNew) }),
    TypeError,
  );
  const wrongReuse = clone(identityPlan());
  wrongReuse.find((entry) => entry.uid === CHAPTER_KEEP).id = 99;
  assert.throws(
    () => buildDefaultTarget(store, { localIdentityPlan: deepFreeze(wrongReuse) }),
    TypeError,
  );
  const forgedReuse = clone(identityPlan());
  const forgedReuseEntry = forgedReuse.find((entry) => entry.uid === CHAPTER_NEW);
  forgedReuseEntry.assignmentKind = 'reuse_uid';
  delete forgedReuseEntry.reservationId;
  assert.throws(
    () => buildDefaultTarget(store, { localIdentityPlan: deepFreeze(forgedReuse) }),
    TypeError,
  );
  const wrongLegacyKind = clone(legacyPlan);
  wrongLegacyKind[0].assignmentKind = 'reserved_new';
  assert.throws(
    () => store.buildTarget({
      candidate: legacyCandidate,
      currentProjection: legacyCurrent,
      targetGeneration: 1,
      projectedAt: PROJECTED_AT,
      ignoredLedger: deepFreeze([]),
      localIdentityPlan: deepFreeze(wrongLegacyKind),
    }),
    TypeError,
  );

  const extraLegacyCandidate = cloneCandidate(legacyCandidate);
  extraLegacyCandidate.volumes.push(candidate().volumes.find((row) => row.volumeUid === VOLUME_NEW));
  extraLegacyCandidate.volumeOrder.push(VOLUME_NEW);
  extraLegacyCandidate.chapters.push(candidate().chapters.find((row) => row.chapterUid === CHAPTER_NEW));
  const forgedLegacyPlan = clone(legacyPlan);
  forgedLegacyPlan.push(
    {
      assignmentKind: 'bind_legacy',
      objectKind: 'chapter',
      uid: CHAPTER_NEW,
      id: 2,
      num: 1,
      reservationId: 'forged-legacy-chapter',
    },
    {
      assignmentKind: 'bind_legacy',
      objectKind: 'volume',
      uid: VOLUME_NEW,
      id: 2,
      reservationId: 'forged-legacy-volume',
    },
  );
  forgedLegacyPlan.sort((left, right) => (
    `${left.objectKind}:${left.uid}`.localeCompare(`${right.objectKind}:${right.uid}`, 'en')
  ));
  assert.throws(
    () => store.buildTarget({
      candidate: deepFreeze(extraLegacyCandidate),
      currentProjection: legacyCurrent,
      targetGeneration: 1,
      projectedAt: PROJECTED_AT,
      ignoredLedger: deepFreeze([]),
      localIdentityPlan: deepFreeze(forgedLegacyPlan),
    }),
    TypeError,
  );
  assert.throws(
    () => buildDefaultTarget(store, { projectedAt: '2026-08-17T16:09:10.123+08:00' }),
    TypeError,
  );
});

test('buildTarget derives exact pending-to-stale invalidations and ignores movement or unrelated metadata', () => {
  const target = buildDefaultTarget();
  assert.deepEqual(target.proposalInvalidations, [
    { revisionId: 31, chapterId: 1, from: 'pending', to: 'stale' },
    { revisionId: 32, chapterId: 2, from: 'pending', to: 'stale' },
  ]);
  assert.equal(target.proposalInvalidations.some((entry) => entry.revisionId === 33), false);

  const moved = cloneCandidate(candidate());
  const keep = moved.chapters.find((chapter) => chapter.chapterUid === CHAPTER_KEEP);
  keep.bodyRawSha256 = BODY_OLD;
  keep.status = 'writing';
  keep.title = 'Only title changed';
  keep.volumeUid = VOLUME_NEW;
  keep.chapterPosition = 2;
  keep.manuscriptPosition = 2;
  moved.controlledFiles.find((row) => (
    row.role === 'chapter_body' && row.resourceUid === CHAPTER_KEEP
  )).rawSha256 = BODY_OLD;
  const newChapter = moved.chapters.find((chapter) => chapter.chapterUid === CHAPTER_NEW);
  newChapter.chapterPosition = 1;
  newChapter.manuscriptPosition = 1;
  const movedPlan = clone(identityPlan());
  movedPlan.find((entry) => entry.uid === CHAPTER_NEW).num = 2;
  const movedTarget = buildDefaultTarget(undefined, {
    candidate: deepFreeze(moved),
    localIdentityPlan: deepFreeze(movedPlan),
  });
  assert.deepEqual(movedTarget.proposalInvalidations, [
    { revisionId: 32, chapterId: 2, from: 'pending', to: 'stale' },
  ]);
  assert.throws(
    () => new SQLiteProjectionStore().buildTarget({
      candidate: candidate(),
      currentProjection: currentProjection(),
      targetGeneration: 9,
      projectedAt: PROJECTED_AT,
      ignoredLedger: deepFreeze([]),
      localIdentityPlan: identityPlan(),
      proposalInvalidations: [],
    }),
    TypeError,
  );
});

test('publish validates a persisted plain target and forwards the same references exactly once without retrying errors', () => {
  const store = new SQLiteProjectionStore();
  const target = buildDefaultTarget(store);
  const persistedTarget = deepFreeze(clone(target));
  const routeCas = Object.freeze({ opaque: 'test-only-value' });
  const calls = [];
  const expectedResult = Object.freeze({ disposition: 'committed' });
  const projectStore = Object.freeze({
    publishProjectionTarget(input) {
      calls.push(input);
      return expectedResult;
    },
  });
  assert.equal(store.publish({ projectStore, target: persistedTarget, routeCas }), expectedResult);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, persistedTarget);
  assert.equal(calls[0].routeCas, routeCas);

  const persistedTamperCases = [
    ['sequence -0', (value) => { value.sqliteSequence[0].seq = -0; }],
    ['controlled file garbage', (value) => { value.controlledFiles[0].byteSize = -0; }],
    ['capacity garbage', (value) => { value.capacitySnapshot.extra = true; }],
    ['identity mismatch', (value) => { value.chapters[0].id = 99; }],
    ['retained tombstone time changed', (value) => {
      value.volumes.find((row) => row.volume_uid === VOLUME_TOMBSTONE).deleted_at = '2026-02-02T00:00:00.000Z';
    }],
    ['new tombstone time changed', (value) => {
      value.chapters.find((row) => row.chapter_uid === CHAPTER_DELETE).deleted_at = '2026-02-02T00:00:00.000Z';
    }],
    ['volume positions are not contiguous', (value) => {
      value.volumes.find((row) => row.volume_uid === VOLUME_NEW).sort_order = 3;
    }],
    ['manuscript positions are not contiguous', (value) => {
      value.chapters.find((row) => row.chapter_uid === CHAPTER_NEW).manuscript_position = 4;
    }],
    ['container positions are not contiguous', (value) => {
      const row = value.chapters.find((entry) => entry.chapter_uid === CHAPTER_NEW);
      row.volume_id = 1;
      row.num = 2;
      row.chapter_position = 3;
      value.localIdentityPlan.find((entry) => entry.uid === CHAPTER_NEW).num = 2;
    }],
    ['chapter parent is not active', (value) => {
      value.chapters.find((row) => row.chapter_uid === CHAPTER_NEW).volume_id = 2;
    }],
    ['missing manuscript fact', (value) => {
      value.controlledFiles = value.controlledFiles.filter((row) => row.role !== 'manuscript');
    }],
    ['missing volume fact', (value) => {
      value.controlledFiles = value.controlledFiles.filter((row) => (
        row.role !== 'volume_index' || row.resourceUid !== VOLUME_NEW
      ));
    }],
    ['missing chapter sidecar fact', (value) => {
      value.controlledFiles = value.controlledFiles.filter((row) => (
        row.role !== 'chapter_sidecar' || row.resourceUid !== CHAPTER_NEW
      ));
    }],
    ['extra tombstone fact', (value) => {
      value.controlledFiles.push(controlledFact('volume_index', VOLUME_TOMBSTONE, 90));
      sortControlledFacts(value.controlledFiles);
    }],
    ['duplicate controlled fact', (value) => {
      value.controlledFiles.push(clone(value.controlledFiles[0]));
      sortControlledFacts(value.controlledFiles);
    }],
    ['body fact hash mismatch', (value) => {
      value.controlledFiles.find((row) => (
        row.role === 'chapter_body' && row.resourceUid === CHAPTER_KEEP
      )).rawSha256 = BODY_OLD;
    }],
    ['sidecar fact hash mismatch', (value) => {
      value.controlledFiles.find((row) => (
        row.role === 'chapter_sidecar' && row.resourceUid === CHAPTER_KEEP
      )).rawSha256 = BODY_OLD;
    }],
    ['missing stale transition', (value) => { value.proposalInvalidations.pop(); }],
    ['expanded stale transition', (value) => {
      value.proposalInvalidations.push({ revisionId: 999, chapterId: 1, from: 'pending', to: 'stale' });
    }],
    ['stale derivation mismatch', (value) => {
      const keep = value.chapters.find((row) => row.chapter_uid === CHAPTER_KEEP);
      keep.body_raw_sha256 = BODY_OLD;
      keep.status = 'writing';
    }],
  ];
  for (const [name, mutate] of persistedTamperCases) {
    const tampered = clone(target);
    mutate(tampered);
    let attempts = 0;
    const rejectingPort = Object.freeze({
      publishProjectionTarget() {
        attempts += 1;
        return expectedResult;
      },
    });
    assert.throws(
      () => store.publish({ projectStore: rejectingPort, target: deepFreeze(tampered) }),
      TypeError,
      name,
    );
    assert.equal(attempts, 0, name);
  }

  for (const code of [
    'TRIGGER_DIGEST_MISMATCH',
    'PROJECT_SCHEMA_TOO_NEW',
    'PROJECTION_STALE',
    'TRANSACTION_PREFLIGHT_FAILED',
    'RECOVERY_REQUIRED',
  ]) {
    const exactError = Object.assign(new Error(code), { code });
    let attempts = 0;
    const failingStore = Object.freeze({
      publishProjectionTarget() {
        attempts += 1;
        throw exactError;
      },
    });
    assert.throws(
      () => store.publish({ projectStore: failingStore, target: persistedTarget }),
      (error) => error === exactError,
    );
    assert.equal(attempts, 1, code);
  }
});

test('validateTarget validates a rehydrated frozen target without a project-store side effect', () => {
  const store = new SQLiteProjectionStore();
  const persistedTarget = deepFreeze(clone(buildDefaultTarget(store)));

  assert.equal(store.validateTarget(persistedTarget), persistedTarget);
  assert.throws(() => store.validateTarget(clone(persistedTarget)), TypeError);
});

function createAtomicFake({ current, reservations = [] }) {
  let visibleTarget = null;
  let visibleRoute = 'sqlite';
  const reservationAuthority = new Map(reservations.map((entry) => [entry.reservationId, entry]));
  const routeTokens = new WeakMap();
  let failAt = null;
  let calls = 0;

  function mintRouteCas(target) {
    const token = Object.freeze({});
    routeTokens.set(token, {
      projectUid: target.projectUid,
      projectInstanceId: target.projectInstanceId,
      basisDigest: target.basisDigest,
      targetGeneration: target.targetGeneration,
    });
    return token;
  }

  const projectStore = Object.freeze({
    publishProjectionTarget({ target, routeCas }) {
      calls += 1;
      if (target.projectUid !== current.projectUid || target.projectInstanceId !== current.projectInstanceId) {
        throw Object.assign(new Error('PROJECT_BINDING_MISMATCH'), { code: 'PROJECT_BINDING_MISMATCH' });
      }
      const liveDigest = canonicalProjectionBasisDigest(current.basis);
      if (
        liveDigest !== target.basisDigest
        || current.basis.baseGeneration !== target.baseGeneration
      ) {
        throw Object.assign(new Error('PROJECTION_STALE'), { code: 'PROJECTION_STALE' });
      }
      for (const assignment of target.localIdentityPlan) {
        if (assignment.assignmentKind === 'reuse_uid') continue;
        const authorized = reservationAuthority.get(assignment.reservationId);
        if (
          authorized === undefined
          || authorized.assignmentKind !== assignment.assignmentKind
          || authorized.objectKind !== assignment.objectKind
          || authorized.uid !== assignment.uid
          || authorized.id !== assignment.id
          || authorized.num !== assignment.num
          || authorized.basisDigest !== target.basisDigest
        ) {
          throw Object.assign(new Error('UID_RESERVATION_COLLISION'), { code: 'UID_RESERVATION_COLLISION' });
        }
      }
      if (routeCas !== undefined) {
        const route = routeTokens.get(routeCas);
        if (
          route === undefined
          || route.projectUid !== target.projectUid
          || route.projectInstanceId !== target.projectInstanceId
          || route.basisDigest !== target.basisDigest
          || route.targetGeneration !== target.targetGeneration
        ) {
          throw Object.assign(new Error('MIGRATION_STATE_MISMATCH'), { code: 'MIGRATION_STATE_MISMATCH' });
        }
      }
      if (failAt === 'preflight') {
        throw Object.assign(new Error('TRANSACTION_PREFLIGHT_FAILED'), { code: 'TRANSACTION_PREFLIGHT_FAILED' });
      }
      visibleTarget = target;
      if (routeCas !== undefined) visibleRoute = 'files';
      if (failAt === 'commit-unknown') {
        throw Object.assign(new Error('RECOVERY_REQUIRED'), { code: 'RECOVERY_REQUIRED' });
      }
      return Object.freeze({ disposition: 'committed' });
    },
  });

  return Object.freeze({
    projectStore,
    mintRouteCas,
    setFailure(value) { failAt = value; },
    observation() { return { calls, visibleTarget, visibleRoute }; },
  });
}

test('fake project store owns project, reservation, route token, and atomic visibility authority', () => {
  const store = new SQLiteProjectionStore();
  const target = buildDefaultTarget(store);
  const reservations = target.localIdentityPlan
    .filter((entry) => entry.assignmentKind !== 'reuse_uid')
    .map((entry) => ({ ...entry, basisDigest: target.basisDigest }));
  const fake = createAtomicFake({ current: currentProjection(), reservations });
  const routeCas = fake.mintRouteCas(target);
  const before = fake.observation();
  assert.equal(before.visibleTarget, null);
  assert.equal(before.visibleRoute, 'sqlite');
  store.publish({ projectStore: fake.projectStore, target, routeCas });
  const after = fake.observation();
  assert.equal(after.visibleTarget, target);
  assert.equal(after.visibleRoute, 'files');

  const invalidCases = [
    { name: 'plain route token', target, routeCas: Object.freeze({}) },
    {
      name: 'cross-project target',
      target: deepFreeze({ ...clone(target), projectUid: uuid(999) }),
      routeCas: undefined,
    },
    {
      name: 'unauthorized reservation',
      target: deepFreeze({
        ...clone(target),
        targetGeneration: 10,
        localIdentityPlan: target.localIdentityPlan.map((entry) => (
          entry.uid === CHAPTER_NEW ? { ...entry, reservationId: 'forged-reservation' } : entry
        )),
      }),
      routeCas: undefined,
    },
  ];
  for (const currentCase of invalidCases) {
    const isolated = createAtomicFake({ current: currentProjection(), reservations });
    assert.throws(
      () => store.publish({
        projectStore: isolated.projectStore,
        target: currentCase.target,
        ...(currentCase.routeCas === undefined ? {} : { routeCas: currentCase.routeCas }),
      }),
      undefined,
      currentCase.name,
    );
    assert.equal(isolated.observation().visibleTarget, null, currentCase.name);
    assert.equal(isolated.observation().visibleRoute, 'sqlite', currentCase.name);
  }

  const uncertain = createAtomicFake({ current: currentProjection(), reservations });
  uncertain.setFailure('commit-unknown');
  assert.throws(
    () => store.publish({ projectStore: uncertain.projectStore, target }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(uncertain.observation().calls, 1);
  assert.equal(uncertain.observation().visibleTarget, target);
});
