'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMITS } = require('../manuscript/contracts');
const {
  ManuscriptStore,
  createFileBoundaryCapability,
  createJournalAuthorityCapability,
} = require('../manuscript/store');
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

test('ManuscriptStore exposes only explicit read capabilities and has no filesystem fallback', () => {
  assert.equal(typeof ManuscriptStore, 'function');
  assert.equal(typeof createFileBoundaryCapability, 'function');
  assert.equal(typeof createJournalAuthorityCapability, 'function');
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
  assert.throws(() => createFileBoundaryCapability({}), TypeError);
  assert.throws(() => createJournalAuthorityCapability({}), TypeError);
  const store = createStore(fixture);
  assert.equal(store.buildClosure, undefined);
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
  assert.equal(snapshot.ignoredMemberObservations.length, 1);
  assert.deepEqual(
    snapshot.ignoredMemberObservations[0].members.map((member) => member.role).sort(),
    ['chapter_body', 'chapter_sidecar'],
  );
  assert.equal(snapshot.capacitySnapshot.measurements.chapterIdentities, 2);
  const calls = fixture.controls.calls();
  assert.equal(calls.contentOpens, 5);
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
      lifecycleBasis: duplicateFixture.lifecycleBasis,
    }),
    'MANUSCRIPT_FILESET_INVALID',
  );

  const revokedFixture = createManuscriptTreeFixture();
  await assertCode(
    createStore(revokedFixture).validateFull(revokedFixture.projectBinding, {
      ignoredLedger: { entries: [{ kind: 'chapter', status: 'revoked', uid: CHAPTER_UID }] },
      lifecycleBasis: revokedFixture.lifecycleBasis,
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
    lifecycleBasis: deletedFixture.lifecycleBasis,
  });
  assert.equal(deletedSnapshot.capacitySnapshot.measurements.chapterIdentities, 2);
  assert.deepEqual(deletedSnapshot.warnings.map((warning) => warning.dimension), [
    'chapterIdentities',
  ]);
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
