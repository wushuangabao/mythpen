'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Database } = require('bun:sqlite');

const { buildSchema12Candidate } = require('../native/durability-schema');
const {
  createProofBoundSchema12ProjectStore,
} = require('../native/native-project-store');
const {
  SQLiteProjectionStore,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
  canonicalSchema12ReuseIdentityPlan,
  currentProjectionAfterTarget,
} = require('../manuscript/projection-store');
const { ManuscriptStore } = require('../manuscript/store');
const { createNativeStageBFixture } = require('../testing/native-stage-b-fixture');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const {
  CHILD_JOURNAL_ID,
  CREATION_ID,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  PROJECT_UID,
  completeEmptySource,
  createEmptyProjectionTarget,
  deepFreeze,
  emptyDirectoryPlan,
  lifecycleLockReceipt,
  physicalIdentity,
  sha256File,
} = require('./fixtures/project-creation-crash');
const { createManuscriptTreeFixture } = require('./fixtures/manuscript-tree');

function currentProjectionFromEmptyTarget(target) {
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: target.targetGeneration,
    volumes: [],
    chapters: [],
    sqliteSequence: target.sqliteSequence.map((row) => ({ ...row })),
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(target.ignoredLedger),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return deepFreeze({
    projectUid: target.projectUid,
    projectInstanceId: target.projectInstanceId,
    basis,
  });
}

async function fullRefreshScene(t, name) {
  const fixture = createNativeStageBFixture({ name });
  let projectStore = null;
  t.after(() => {
    if (projectStore?.state === 'active') projectStore.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const source = new Database(fixture.databasePath, { readonly: true, strict: true });
  const projectInstanceId = source.query(
    "SELECT value FROM project_meta WHERE key = 'project_instance_id'",
  ).get().value;
  source.close(true);
  const creation = await createEmptyProjectionTarget({
    dataRoot: path.join(fixture.root, 'manuscripts-data'),
    projectInstanceId,
  });
  const databasePath = path.join(path.dirname(fixture.databasePath), `${name}.schema12`);
  buildSchema12Candidate(deepFreeze({
    sourcePath: fixture.databasePath,
    candidatePath: databasePath,
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
  let writerLeaseAssertions = 0;
  const admission = deepFreeze({
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
    });
  projectStore = createProofBoundSchema12ProjectStore({
    admission,
    databasePath,
    assertWriterLease() {
      writerLeaseAssertions += 1;
      return true;
    },
  });
  const currentProjection = currentProjectionFromEmptyTarget(creation.target);
  const target = new SQLiteProjectionStore().buildTarget({
    candidate: creation.candidate,
    currentProjection,
    targetGeneration: 2,
    projectedAt: '2026-08-20T00:00:00.000Z',
    ignoredLedger: deepFreeze([]),
    localIdentityPlan: deepFreeze([]),
  });
  return {
    creation,
    currentProjection,
    databasePath,
    admission,
    projectStore,
    target,
    writerLeaseAssertions: () => writerLeaseAssertions,
  };
}

function changedFullRefreshTarget(scene) {
  const changedCandidateValue = {
    ...scene.creation.candidate,
    controlledFiles: scene.creation.candidate.controlledFiles.map((row, index) => (
      index === 0 ? { ...row, rawSha256: 'f'.repeat(64) } : row
    )),
  };
  return new SQLiteProjectionStore().buildTarget({
    candidate: deepFreeze(changedCandidateValue),
    currentProjection: scene.currentProjection,
    targetGeneration: 2,
    projectedAt: '2026-08-20T00:00:00.000Z',
    ignoredLedger: deepFreeze([]),
    localIdentityPlan: deepFreeze([]),
  });
}

async function installActivatedCreationProof(dataRoot, finalPath, projectInstanceId) {
  const { openControlStore } = require('../control-store');
  const { ProjectCreationJournal } = require('../manuscript/project-creation-journal');
  const { ManuscriptUidReservation } = require('../manuscript/uid-reservation');
  const { createUidReservationSources } = require('../manuscript/uid-reservation-sources');
  const creationSource = Object.freeze({
    async enumerate(scope) {
      return Object.freeze({ ...scope, complete: true, records: Object.freeze([]) });
    },
    async lookup(input) {
      return Object.freeze({
        complete: true,
        logicalRequestId: input.logicalRequestId,
        reservations: Object.freeze([]),
      });
    },
  });
  const uuidValues = [CREATION_ID, PROJECT_UID];
  const uidReservations = new ManuscriptUidReservation({
    reservationSources: createUidReservationSources({
      registrySource: completeEmptySource(),
      existingRootsSource: completeEmptySource(),
      migrationSources: Object.freeze([]),
      creationSources: Object.freeze([creationSource]),
    }),
    uuidV4() { return uuidValues.shift(); },
  });
  const { creationReservation } = await uidReservations.reserveCreationIdentity(deepFreeze({
    projectInstanceId,
    logicalRequestId: 'full-refresh-db-receipt',
    logicalInputDigest: DIGEST_A,
    projectRootProbe: Object.freeze({
      probe() { return Object.freeze({ disposition: 'absent' }); },
    }),
  }));
  const disposition = Object.freeze({
    classify(evidence) { return evidence.disposition; },
    inspect() { return Object.freeze({ disposition: 'after' }); },
  });
  const journal = new ProjectCreationJournal({
    controlStore: openControlStore(path.join(
      dataRoot,
      'control',
      'project-creation',
      CREATION_ID,
    )),
    dataRoot,
    creationId: CREATION_ID,
    childDisposition: disposition,
    databaseDisposition: disposition,
    clock: () => 1_723_900_000_000,
  });
  let authority = await journal.reserve(deepFreeze({
    creationReservation,
    directoryPlan: emptyDirectoryPlan(dataRoot, PROJECT_UID, projectInstanceId, finalPath),
    projectMetadata: {
      name: 'Receipt', mode: 'medium-novel', language: 'zh', genres: ['fantasy'],
    },
    baseGeneration: 0,
    targetGeneration: 1,
  }));
  authority = await journal.recordProjectControlReady(authority, deepFreeze({
    childJournalId: CHILD_JOURNAL_ID,
    childReservation: { version: 1 },
    closureDigest: DIGEST_A,
    lifecycleLockReceipt: lifecycleLockReceipt(dataRoot, PROJECT_UID, projectInstanceId),
    logicalRequestId: 'full-refresh-db-receipt',
    partialManifest: { version: 1, members: [] },
    projectionBasisDigest: DIGEST_B,
    targetBindingDigest: DIGEST_C,
    targetGeneration: 1,
  }));
  authority = await journal.recordFilePublicationStarted(authority, deepFreeze({
    manifest: { version: 1, members: [] },
  }));
  authority = await journal.recordFilesPublished(
    authority,
    Object.freeze({ disposition: 'after' }),
  );
  const candidatePath = `${finalPath}.proof-candidate`;
  fs.writeFileSync(candidatePath, 'proof');
  authority = await journal.recordDatabaseCandidate(authority, deepFreeze({
    candidatePath,
    candidateIdentity: physicalIdentity(candidatePath),
    candidateSha256: sha256File(candidatePath),
    finalPath,
    finalParentIdentity: physicalIdentity(path.dirname(finalPath)),
    finalCommitSeq: 1,
    transitionProofDigest: DIGEST_C,
  }));
  authority = await journal.beginActivation(authority);
  await journal.recordActivated(
    authority,
    Object.freeze({ disposition: 'after', generation: 1, route: 'files' }),
  );
}

async function populatedFullRefreshScene(t, name) {
  const fixture = createNativeStageBFixture({ name });
  let projectStore = null;
  t.after(() => {
    if (projectStore?.state === 'active') projectStore.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const source = new Database(fixture.databasePath, { readonly: true, strict: true });
  const projectInstanceId = source.query(
    "SELECT value FROM project_meta WHERE key = 'project_instance_id'",
  ).get().value;
  source.close(true);
  const creation = await createEmptyProjectionTarget({
    dataRoot: path.join(fixture.root, 'empty-manuscripts'),
    projectInstanceId,
  });
  const tree = createManuscriptTreeFixture({
    dataRoot: path.join(fixture.root, 'populated-manuscripts'),
  });
  const manuscriptStore = new ManuscriptStore({
    dataRoot: tree.dataRoot,
    fileBoundary: tree.fileBoundary,
    journalAuthority: tree.journalAuthority,
  });
  const snapshot = await manuscriptStore.validateFull(tree.projectBinding, {
    ignoredLedger: tree.ignoredLedger,
    lifecycleBasis: tree.lifecycleBasis,
  });
  const candidate = await manuscriptStore.buildProjectionCandidate(snapshot);
  const chapterNumbers = new Map();
  const identityPlan = [
    ...candidate.volumes.map((row, index) => ({
      assignmentKind: 'reserved_new',
      objectKind: 'volume',
      uid: row.volumeUid,
      id: index + 1,
      reservationId: `volume-${index + 1}`,
    })),
    ...candidate.chapters.map((row, index) => {
      const container = row.volumeUid ?? 'unassigned';
      const num = (chapterNumbers.get(container) ?? 0) + 1;
      chapterNumbers.set(container, num);
      return {
        assignmentKind: 'reserved_new',
        objectKind: 'chapter',
        uid: row.chapterUid,
        id: index + 1,
        num,
        reservationId: `chapter-${index + 1}`,
      };
    }),
  ].sort((left, right) => (
    Buffer.compare(Buffer.from(left.objectKind), Buffer.from(right.objectKind))
    || Buffer.compare(Buffer.from(left.uid), Buffer.from(right.uid))
  ));
  const initialTarget = creation.target;
  const databasePath = path.join(path.dirname(fixture.databasePath), `${name}.schema12`);
  buildSchema12Candidate(deepFreeze({
    sourcePath: fixture.databasePath,
    candidatePath: databasePath,
    creationId: CREATION_ID,
    sourceKind: 'empty',
    transitionKind: 'new_creation',
    target: initialTarget,
  }));
  const commonFacts = deepFreeze({
    projectUid: PROJECT_UID,
    projectInstanceId,
    route: 'files',
    routeJournal: CREATION_ID,
    projectionGeneration: 1,
  });
  const admission = deepFreeze({
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
  });
  projectStore = createProofBoundSchema12ProjectStore({
    admission,
    databasePath,
    assertWriterLease() { return true; },
  });
  const emptyCurrent = currentProjectionAfterTarget(initialTarget);
  const populatedTarget = new SQLiteProjectionStore().buildTarget({
    candidate,
    currentProjection: emptyCurrent,
    targetGeneration: 2,
    projectedAt: '2026-08-20T00:00:01.000Z',
    ignoredLedger: initialTarget.ignoredLedger,
    localIdentityPlan: deepFreeze(identityPlan),
  });
  assert.deepEqual(projectStore.publishProjectionTarget({ target: populatedTarget }), {
    disposition: 'after',
    generation: 2,
    route: 'files',
  });
  const currentProjection = currentProjectionAfterTarget(populatedTarget);
  const target = new SQLiteProjectionStore().buildTarget({
    candidate,
    currentProjection,
    targetGeneration: 3,
    projectedAt: '2026-08-20T00:00:02.000Z',
    ignoredLedger: populatedTarget.ignoredLedger,
    localIdentityPlan: canonicalSchema12ReuseIdentityPlan(currentProjection),
  });
  return {
    candidate,
    currentProjection,
    databasePath,
    admission,
    projectStore,
    target,
  };
}

function gatedWrite(databasePath, action) {
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    database.exec('BEGIN IMMEDIATE');
    database.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
    action(database);
    database.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
    database.exec('COMMIT');
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close(true);
  }
}

function projectionWithPendingRevision(currentProjection, revision) {
  const value = structuredClone(currentProjection);
  value.basis.pendingProposals = [{
    revisionId: revision.id,
    chapterId: revision.chapterId,
  }];
  value.basis.basisDigest = canonicalProjectionBasisDigest(value.basis);
  return deepFreeze(value);
}

test('generation-verified auxiliary revision CAS creates, retries, updates, and rejects without changing projection generation', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'auxiliary-revision-cas');
  const chapter = scene.candidate.chapters[0];
  const chapterId = scene.currentProjection.basis.chapters.find(
    (row) => row.uid === chapter.chapterUid,
  ).id;
  const createInput = deepFreeze({
    currentProjection: scene.currentProjection,
    logicalRequestId: 'auxiliary-create',
    projectedAt: '2026-08-20T00:00:03.000Z',
    action: {
      kind: 'revision.create',
      chapterUid: chapter.chapterUid,
      baseContent: chapter.content,
      proposedContent: `${chapter.content}\nproposal`,
    },
  });
  const beforeSequence = Number(scene.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'durability_commit_seq'",
  ).value);

  const created = scene.projectStore.applyAuxiliaryAction(createInput);
  assert.equal(created.disposition, 'after');
  assert.equal(created.generation, 2);
  assert.equal(created.state, 'created');
  assert.equal(created.revision.status, 'pending');
  assert.equal(created.revision.baseContent, chapter.content);
  assert.equal(created.revision.proposedContent, `${chapter.content}\nproposal`);
  assert.deepEqual(scene.projectStore.applyAuxiliaryAction(createInput), created);
  assert.equal(Number(scene.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'durability_commit_seq'",
  ).value), beforeSequence + 1);
  assert.deepEqual(scene.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
  ), { value: '2' });

  const pendingProjection = projectionWithPendingRevision(scene.currentProjection, created.revision);
  const updated = scene.projectStore.applyAuxiliaryAction(deepFreeze({
    currentProjection: pendingProjection,
    logicalRequestId: 'auxiliary-update',
    projectedAt: '2026-08-20T00:00:04.000Z',
    action: {
      kind: 'revision.update_decisions',
      revisionId: created.revision.id,
      expectedBaseContent: chapter.content,
      decisions: { 'change-0': 'accepted' },
    },
  }));
  assert.equal(updated.state, 'updated');
  assert.deepEqual(updated.revision.decisions, { 'change-0': 'accepted' });

  const rejected = scene.projectStore.applyAuxiliaryAction(deepFreeze({
    currentProjection: pendingProjection,
    logicalRequestId: 'auxiliary-reject',
    projectedAt: '2026-08-20T00:00:05.000Z',
    action: {
      kind: 'revision.reject',
      revisionId: created.revision.id,
      expectedBaseContent: chapter.content,
    },
  }));
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.revision.status, 'rejected');
  assert.deepEqual(scene.projectStore.readGet(
    'SELECT status FROM chapter_revisions WHERE id = ?',
    created.revision.id,
  ), { status: 'rejected' });
});

test('auxiliary create records a base-mismatched proposal as durable stale history', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'auxiliary-revision-stale');
  const chapterId = scene.currentProjection.basis.chapters[0].id;
  const result = scene.projectStore.applyAuxiliaryAction(deepFreeze({
    currentProjection: scene.currentProjection,
    logicalRequestId: 'auxiliary-stale',
    projectedAt: '2026-08-20T00:00:03.000Z',
    action: {
      kind: 'revision.create',
      chapterUid: scene.currentProjection.basis.chapters[0].uid,
      baseContent: 'older editor content',
      proposedContent: 'late proposal',
    },
  }));

  assert.equal(result.state, 'stale');
  assert.equal(result.revision.status, 'stale');
  assert.deepEqual(scene.projectStore.readGet(
    'SELECT status, base_content, proposed_content FROM chapter_revisions WHERE id = ?',
    result.revision.id,
  ), {
    status: 'stale',
    base_content: 'older editor content',
    proposed_content: 'late proposal',
  });
  assert.deepEqual(scene.projectStore.readAll(
    "SELECT id FROM chapter_revisions WHERE status = 'pending'",
  ), []);
});

test('server-owned mark-stale auxiliary action durably closes an admitted mismatched pending row', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'auxiliary-mark-stale');
  const chapter = scene.candidate.chapters[0];
  const created = scene.projectStore.applyAuxiliaryAction(deepFreeze({
    currentProjection: scene.currentProjection,
    logicalRequestId: 'auxiliary-mark-stale-create',
    projectedAt: '2026-08-20T00:00:03.000Z',
    action: {
      kind: 'revision.create',
      chapterUid: chapter.chapterUid,
      baseContent: chapter.content,
      proposedContent: `${chapter.content}\npending`,
    },
  }));
  const changedContent = `${chapter.content}\noutside accepted content`;
  const changedSha = createHash('sha256').update(changedContent, 'utf8').digest('hex');
  gatedWrite(scene.databasePath, (database) => {
    assert.ok(database.query(`
      UPDATE chapters SET content = ?, body_raw_sha256 = ? WHERE id = ?
    `).run(changedContent, changedSha, created.revision.chapterId).changes >= 1);
  });
  const changedProjection = structuredClone(
    projectionWithPendingRevision(scene.currentProjection, created.revision),
  );
  const basisChapter = changedProjection.basis.chapters.find(
    (row) => row.id === created.revision.chapterId,
  );
  basisChapter.bodyRawSha256 = changedSha;
  changedProjection.basis.basisDigest = canonicalProjectionBasisDigest(changedProjection.basis);
  const input = deepFreeze({
    currentProjection: changedProjection,
    logicalRequestId: 'auxiliary-mark-stale-resolution',
    projectedAt: '2026-08-20T00:00:04.000Z',
    action: { kind: 'revision.mark_stale', revisionId: created.revision.id },
  });

  const stale = scene.projectStore.applyAuxiliaryAction(input);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.revision.status, 'stale');
  assert.deepEqual(scene.projectStore.applyAuxiliaryAction(input), stale);
  assert.deepEqual(scene.projectStore.readGet(
    'SELECT status, resolved_at FROM chapter_revisions WHERE id = ?',
    created.revision.id,
  ), { status: 'stale', resolved_at: '2026-08-20T00:00:04.000Z' });
});

test('finalize-noop accepts all-rejected revision without file publication or generation change', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'auxiliary-finalize-noop');
  const chapter = scene.candidate.chapters[0];
  const acceptedProjection = structuredClone(scene.currentProjection);
  const basisChapter = acceptedProjection.basis.chapters.find((row) => row.uid === chapter.chapterUid);
  gatedWrite(scene.databasePath, (database) => {
    assert.ok(database.query('UPDATE chapters SET status = ? WHERE id = ?')
      .run('accepted', basisChapter.id).changes >= 1);
  });
  basisChapter.status = 'accepted';
  acceptedProjection.basis.basisDigest = canonicalProjectionBasisDigest(acceptedProjection.basis);
  const frozenAcceptedProjection = deepFreeze(acceptedProjection);
  const created = scene.projectStore.applyAuxiliaryAction(deepFreeze({
    currentProjection: frozenAcceptedProjection,
    logicalRequestId: 'auxiliary-finalize-noop-create',
    projectedAt: '2026-08-20T00:00:03.000Z',
    action: {
      kind: 'revision.create',
      chapterUid: chapter.chapterUid,
      baseContent: chapter.content,
      proposedContent: `${chapter.content}\nproposal that is fully rejected`,
    },
  }));
  const pendingProjection = projectionWithPendingRevision(
    frozenAcceptedProjection,
    created.revision,
  );
  const updated = scene.projectStore.applyAuxiliaryAction(deepFreeze({
    currentProjection: pendingProjection,
    logicalRequestId: 'auxiliary-finalize-noop-decisions',
    projectedAt: '2026-08-20T00:00:04.000Z',
    action: {
      kind: 'revision.update_decisions',
      revisionId: created.revision.id,
      expectedBaseContent: chapter.content,
      decisions: { 'change-0': 'rejected' },
    },
  }));
  const beforeChapter = scene.projectStore.readGet(
    'SELECT data_version FROM chapters WHERE id = ?',
    basisChapter.id,
  );
  const finalizeInput = deepFreeze({
    currentProjection: pendingProjection,
    logicalRequestId: 'auxiliary-finalize-noop-commit',
    projectedAt: '2026-08-20T00:00:05.000Z',
    action: {
      kind: 'revision.finalize_noop',
      revisionId: created.revision.id,
      content: chapter.content,
      expectedBaseContent: chapter.content,
      expectedDecisions: updated.revision.decisions,
    },
  });
  const result = scene.projectStore.applyAuxiliaryAction(finalizeInput);

  assert.equal(result.state, 'accepted');
  assert.equal(result.generation, 2);
  assert.equal(result.revision.status, 'accepted');
  assert.deepEqual(result.chapter, {
    id: basisChapter.id,
    chapterUid: chapter.chapterUid,
    content: chapter.content,
    wordCount: chapter.wordCount,
    status: 'accepted',
    dataVersion: beforeChapter.data_version,
  });
  assert.deepEqual(scene.projectStore.applyAuxiliaryAction(finalizeInput), result);
  assert.deepEqual(scene.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
  ), { value: '2' });
});

test('revision resolution target atomically installs accepted article and selected revision', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'revision-resolution-target');
  const chapter = scene.candidate.chapters[0];
  const chapterId = scene.currentProjection.basis.chapters.find(
    (row) => row.uid === chapter.chapterUid,
  ).id;
  const acceptedContent = `${chapter.content}\naccepted resolution`;
  const created = scene.projectStore.applyAuxiliaryAction(deepFreeze({
    currentProjection: scene.currentProjection,
    logicalRequestId: 'revision-resolution-create',
    projectedAt: '2026-08-20T00:00:03.000Z',
    action: {
      kind: 'revision.create',
      chapterUid: chapter.chapterUid,
      baseContent: chapter.content,
      proposedContent: acceptedContent,
    },
  }));
  const pendingProjection = projectionWithPendingRevision(scene.currentProjection, created.revision);
  const bodySha = createHash('sha256').update(acceptedContent, 'utf8').digest('hex');
  const sidecarSha = createHash('sha256').update('accepted-sidecar', 'utf8').digest('hex');
  let controlledByteDelta = 0;
  const controlledFiles = scene.candidate.controlledFiles.map((row) => {
    if (row.resourceUid !== chapter.chapterUid) return row;
    if (row.role === 'chapter_body') {
      const byteSize = Buffer.byteLength(acceptedContent, 'utf8');
      controlledByteDelta += byteSize - row.byteSize;
      return { ...row, rawSha256: bodySha, byteSize };
    }
    if (row.role === 'chapter_sidecar') {
      const byteSize = Buffer.byteLength('accepted-sidecar', 'utf8');
      controlledByteDelta += byteSize - row.byteSize;
      return { ...row, rawSha256: sidecarSha, byteSize };
    }
    return row;
  });
  const acceptedCandidate = deepFreeze({
    ...scene.candidate,
    chapters: scene.candidate.chapters.map((row) => row.chapterUid === chapter.chapterUid
      ? {
        ...row,
        content: acceptedContent,
        wordCount: acceptedContent.length,
        status: 'accepted',
        bodyRawSha256: bodySha,
        sidecarRawSha256: sidecarSha,
      }
      : row),
    controlledFiles,
    capacitySnapshot: {
      ...scene.candidate.capacitySnapshot,
      measurements: {
        ...scene.candidate.capacitySnapshot.measurements,
        controlledBytes:
          scene.candidate.capacitySnapshot.measurements.controlledBytes + controlledByteDelta,
      },
    },
  });
  const target = new SQLiteProjectionStore().buildRevisionTarget(deepFreeze({
    candidate: acceptedCandidate,
    currentProjection: pendingProjection,
    targetGeneration: 3,
    projectedAt: '2026-08-20T00:00:04.000Z',
    ignoredLedger: scene.target.ignoredLedger.map((row) => ({
      ...row,
      projection_generation: 2,
    })),
    localIdentityPlan: canonicalSchema12ReuseIdentityPlan(pendingProjection),
    revisionResolution: {
      revisionId: created.revision.id,
      chapterId,
      chapterUid: chapter.chapterUid,
      from: 'pending',
      to: 'accepted',
      baseContentSha256: createHash('sha256').update(chapter.content, 'utf8').digest('hex'),
      proposedContentSha256: createHash('sha256').update(acceptedContent, 'utf8').digest('hex'),
      acceptedContentSha256: bodySha,
      decisionsSha256: createHash('sha256').update('{}', 'utf8').digest('hex'),
      logicalRequestId: 'revision-resolution-accept',
      commandKind: 'revision.accept',
      commandDigest: '5'.repeat(64),
    },
  }));

  const reboundTarget = new SQLiteProjectionStore().buildRevisionTarget(deepFreeze({
    candidate: acceptedCandidate,
    currentProjection: pendingProjection,
    targetGeneration: 3,
    projectedAt: '2026-08-20T00:00:04.000Z',
    ignoredLedger: scene.target.ignoredLedger.map((row) => ({
      ...row,
      projection_generation: 2,
    })),
    localIdentityPlan: canonicalSchema12ReuseIdentityPlan(pendingProjection),
    revisionResolution: {
      revisionId: created.revision.id,
      chapterId,
      chapterUid: chapter.chapterUid,
      from: 'pending',
      to: 'accepted',
      baseContentSha256: createHash('sha256').update(chapter.content, 'utf8').digest('hex'),
      proposedContentSha256: createHash('sha256').update(acceptedContent, 'utf8').digest('hex'),
      acceptedContentSha256: bodySha,
      decisionsSha256: createHash('sha256').update('{}', 'utf8').digest('hex'),
      logicalRequestId: 'revision-resolution-create',
      commandKind: 'revision.accept',
      commandDigest: '5'.repeat(64),
    },
  }));

  assert.throws(
    () => scene.projectStore.publishProjectionTarget({ target: reboundTarget }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(scene.projectStore.state, 'active');

  assert.deepEqual(target.proposalInvalidations, []);
  assert.deepEqual(scene.projectStore.publishProjectionTarget({ target }), {
    disposition: 'after', generation: 3, route: 'files',
  });
  assert.deepEqual(scene.projectStore.readGet(
    'SELECT content, status FROM chapters WHERE id = ?',
    chapterId,
  ), { content: acceptedContent, status: 'accepted' });
  assert.deepEqual(scene.projectStore.readGet(
    'SELECT status, resolved_at FROM chapter_revisions WHERE id = ?',
    created.revision.id,
  ), { status: 'accepted', resolved_at: '2026-08-20T00:00:04.000Z' });
});

test('a known pre-commit auxiliary rollback leaves the schema12 store active and retryable', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'auxiliary-known-rollback');
  const chapter = scene.candidate.chapters[0];
  const chapterId = scene.currentProjection.basis.chapters.find(
    (row) => row.uid === chapter.chapterUid,
  ).id;
  const input = deepFreeze({
    currentProjection: scene.currentProjection,
    logicalRequestId: 'auxiliary-known-rollback',
    projectedAt: '2026-08-20T00:00:03.000Z',
    action: {
      kind: 'revision.create',
      chapterUid: chapter.chapterUid,
      baseContent: chapter.content,
      proposedContent: `${chapter.content}\nknown rollback proposal`,
    },
  });

  await assert.rejects(
    withFaults({
      [FAULT_POINTS.NATIVE_AUXILIARY_BEFORE_COMMIT_INVOKE]: { throw: 'EIO' },
    }, () => scene.projectStore.applyAuxiliaryAction(input)),
    (error) => error?.code === 'EIO',
  );

  assert.equal(scene.projectStore.state, 'active');
  assert.deepEqual(scene.projectStore.readAll(
    "SELECT id FROM chapter_revisions WHERE proposed_content LIKE '%known rollback proposal%'",
  ), []);
  assert.equal(scene.projectStore.applyAuxiliaryAction(input).state, 'created');
});

test('every post-commit auxiliary stage fences until a cold reopen can return its receipt', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'auxiliary-unknown-stages');
  const chapter = scene.candidate.chapters[0];
  const chapterId = scene.currentProjection.basis.chapters.find(
    (row) => row.uid === chapter.chapterUid,
  ).id;
  scene.projectStore.close();
  const reopenedAdmission = deepFreeze({
    ...scene.admission,
    databaseFacts: { ...scene.admission.databaseFacts, projectionGeneration: 2 },
    routeFacts: { ...scene.admission.routeFacts, projectionGeneration: 2 },
  });

  for (const faultName of [
    'NATIVE_AUXILIARY_AFTER_COMMIT_RETURN',
    'NATIVE_AUXILIARY_AFTER_FILE_FSYNC',
    'NATIVE_AUXILIARY_AFTER_DIRECTORY_FSYNC',
    'NATIVE_AUXILIARY_AFTER_GUARD_RECHECK',
    'NATIVE_AUXILIARY_AFTER_RECEIPT_RECHECK',
  ]) {
    const faultDatabasePath = path.join(
      path.dirname(scene.databasePath),
      `${faultName}.schema12`,
    );
    fs.copyFileSync(scene.databasePath, faultDatabasePath);
    const input = deepFreeze({
      currentProjection: scene.currentProjection,
      logicalRequestId: `auxiliary-${faultName.toLowerCase()}`,
      projectedAt: '2026-08-20T00:00:03.000Z',
      action: {
        kind: 'revision.create',
        chapterUid: chapter.chapterUid,
        baseContent: chapter.content,
        proposedContent: `${chapter.content}\n${faultName}`,
      },
    });
    const store = createProofBoundSchema12ProjectStore({
      admission: reopenedAdmission,
      databasePath: faultDatabasePath,
      assertWriterLease() { return true; },
    });

    await assert.rejects(
      withFaults({ [FAULT_POINTS[faultName]]: { throw: 'EIO' } }, () => (
        store.applyAuxiliaryAction(input)
      )),
      (error) => error?.code === 'RECOVERY_REQUIRED'
        && /disposition is unknown/u.test(error.message),
      faultName,
    );
    assert.equal(store.state, 'disposition_unknown', faultName);
    assert.throws(
      () => store.applyAuxiliaryAction(input),
      (error) => error?.code === 'RECOVERY_REQUIRED' && /not active/u.test(error.message),
      faultName,
    );

    const reopened = createProofBoundSchema12ProjectStore({
      admission: reopenedAdmission,
      databasePath: faultDatabasePath,
      assertWriterLease() { return true; },
    });
    try {
      const result = reopened.applyAuxiliaryAction(input);
      assert.equal(result.state, 'created', faultName);
      assert.equal(result.generation, 2, faultName);
      assert.equal(result.revision.proposedContent, `${chapter.content}\n${faultName}`, faultName);
    } finally {
      if (reopened.state === 'active') reopened.close();
    }
  }
});

test('exact full-refresh inspection returns an opaque instance-authentic already-current disposition', async (t) => {
  const scene = await fullRefreshScene(t, 'full-refresh-authentic');

  const receipt = scene.projectStore.inspectFullRefreshTarget({ target: scene.target });

  assert.equal(typeof receipt, 'function');
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(
    scene.projectStore.describeFullRefreshDisposition(receipt),
    { disposition: 'already_current', generation: 1 },
  );
  assert.equal(scene.writerLeaseAssertions(), 1);
  assert.throws(
    () => scene.projectStore.describeFullRefreshDisposition(Object.freeze(() => {})),
    (error) => error instanceof TypeError && /foreign/u.test(error.message),
  );
});

test('publication revalidates the complete compact base after BEGIN and before target DML', async (t) => {
  const scene = await fullRefreshScene(t, 'full-refresh-transaction-cas');
  gatedWrite(scene.databasePath, (database) => {
    assert.equal(
      database.query("UPDATE sqlite_sequence SET seq = 1 WHERE name = 'chapters'").run().changes,
      1,
    );
  });

  assert.throws(
    () => scene.projectStore.publishProjectionTarget({ target: scene.target }),
    (error) => error?.code === 'RECOVERY_REQUIRED'
      && /base changed before publication/u.test(error.message),
  );

  assert.deepEqual(scene.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
  ), { value: '1' });
  assert.deepEqual(scene.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'durability_commit_seq'",
  ), { value: '1' });
  assert.deepEqual(scene.projectStore.readGet(
    'SELECT COUNT(*) AS count FROM "_durability_write_gate"',
  ), { count: 0 });
  assert.deepEqual(scene.projectStore.readGet(
    "SELECT seq FROM sqlite_sequence WHERE name = 'chapters'",
  ), { seq: 1 });
});

test('a known pre-commit rollback leaves the schema12 store active and retryable', async (t) => {
  const scene = await fullRefreshScene(t, 'full-refresh-known-rollback');
  const target = changedFullRefreshTarget(scene);

  await assert.rejects(
    withFaults({
      [FAULT_POINTS.NATIVE_FULL_REFRESH_BEFORE_COMMIT_INVOKE]: { throw: 'EIO' },
    }, () => scene.projectStore.publishProjectionTarget({ target })),
    (error) => error?.code === 'EIO',
  );

  assert.equal(scene.projectStore.state, 'active');
  assert.deepEqual(scene.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
  ), { value: '1' });
  assert.deepEqual(scene.projectStore.publishProjectionTarget({ target }), {
    disposition: 'after', generation: 2, route: 'files',
  });
});

test('every post-commit full-refresh stage fences until a cold reopen', async (t) => {
  const scene = await fullRefreshScene(t, 'full-refresh-unknown-stages');
  const target = changedFullRefreshTarget(scene);
  scene.projectStore.close();
  const reopenedAdmission = deepFreeze({
    ...scene.admission,
    databaseFacts: { ...scene.admission.databaseFacts, projectionGeneration: 2 },
    routeFacts: { ...scene.admission.routeFacts, projectionGeneration: 2 },
  });

  for (const faultName of [
    'NATIVE_FULL_REFRESH_AFTER_COMMIT_RETURN',
    'NATIVE_FULL_REFRESH_AFTER_FILE_FSYNC',
    'NATIVE_FULL_REFRESH_AFTER_DIRECTORY_FSYNC',
    'NATIVE_FULL_REFRESH_AFTER_GUARD_RECHECK',
    'NATIVE_FULL_REFRESH_AFTER_TARGET_RECHECK',
  ]) {
    const faultDatabasePath = path.join(
      path.dirname(scene.databasePath),
      `${faultName}.schema12`,
    );
    fs.copyFileSync(scene.databasePath, faultDatabasePath);
    const store = createProofBoundSchema12ProjectStore({
      admission: scene.admission,
      databasePath: faultDatabasePath,
      assertWriterLease() { return true; },
    });

    await assert.rejects(
      withFaults({ [FAULT_POINTS[faultName]]: { throw: 'EIO' } }, () => (
        store.publishProjectionTarget({ target })
      )),
      (error) => error?.code === 'RECOVERY_REQUIRED'
        && /disposition is unknown/u.test(error.message),
      faultName,
    );

    assert.equal(store.state, 'disposition_unknown', faultName);
    assert.throws(
      () => store.publishProjectionTarget({ target }),
      (error) => error?.code === 'RECOVERY_REQUIRED' && /not active/u.test(error.message),
      faultName,
    );

    const reopened = createProofBoundSchema12ProjectStore({
      admission: reopenedAdmission,
      databasePath: faultDatabasePath,
      assertWriterLease() { return true; },
    });
    try {
      assert.deepEqual(reopened.publishProjectionTarget({ target }), {
        disposition: 'after', generation: 2, route: 'files',
      }, faultName);
    } finally {
      if (reopened.state === 'active') reopened.close();
    }
  }
});

test('exact inspection distinguishes a required target, a changed base, and another generation', async (t) => {
  const scene = await fullRefreshScene(t, 'full-refresh-exact-states');
  const changedTarget = changedFullRefreshTarget(scene);
  const required = scene.projectStore.inspectFullRefreshTarget({ target: changedTarget });
  assert.deepEqual(scene.projectStore.describeFullRefreshDisposition(required), {
    disposition: 'target',
    generation: 1,
  });

  gatedWrite(scene.databasePath, (database) => {
    database.query("UPDATE sqlite_sequence SET seq = 1 WHERE name = 'chapters'").run();
  });
  const changed = scene.projectStore.inspectFullRefreshTarget({ target: scene.target });
  assert.deepEqual(scene.projectStore.describeFullRefreshDisposition(changed), {
    disposition: 'base_changed',
    generation: 1,
  });

  gatedWrite(scene.databasePath, (database) => {
    database.query(`
      UPDATE project_meta SET value = '7'
      WHERE key = 'manuscript_projection_generation'
    `).run();
  });
  const other = scene.projectStore.inspectFullRefreshTarget({ target: scene.target });
  assert.deepEqual(scene.projectStore.describeFullRefreshDisposition(other), {
    disposition: 'other',
    generation: 7,
  });
});

test('full-refresh dispositions cannot be described by another schema12 store instance', async (t) => {
  const first = await fullRefreshScene(t, 'full-refresh-owner-first');
  const second = await fullRefreshScene(t, 'full-refresh-owner-second');
  const receipt = first.projectStore.inspectFullRefreshTarget({ target: first.target });

  assert.throws(
    () => second.projectStore.describeFullRefreshDisposition(receipt),
    (error) => error instanceof TypeError && /foreign/u.test(error.message),
  );
});

test('schema12 store rejects a valid target minted for another project instance', async (t) => {
  const first = await fullRefreshScene(t, 'full-refresh-target-first');
  const second = await fullRefreshScene(t, 'full-refresh-target-second');

  for (const method of ['inspectFullRefreshTarget', 'publishProjectionTarget']) {
    assert.throws(
      () => first.projectStore[method]({ target: second.target }),
      (error) => error instanceof TypeError && /project instance/u.test(error.message),
      method,
    );
  }
  assert.deepEqual(first.projectStore.readGet(
    "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
  ), { value: '1' });
});

test('exact inspection covers populated rows and pending proposal invalidations', async (t) => {
  const scene = await populatedFullRefreshScene(t, 'full-refresh-populated');
  const noChange = scene.projectStore.inspectFullRefreshTarget({ target: scene.target });
  assert.deepEqual(scene.projectStore.describeFullRefreshDisposition(noChange), {
    disposition: 'already_current',
    generation: 2,
  });

  let revisionId;
  gatedWrite(scene.databasePath, (database) => {
    const chapterId = database.query('SELECT id FROM chapters ORDER BY id LIMIT 1').get().id;
    revisionId = Number(database.query(`
      INSERT INTO chapter_revisions (chapter_id, base_content, proposed_content)
      VALUES (?, 'base', 'proposal')
    `).run(chapterId).lastInsertRowid);
  });
  const stale = scene.projectStore.inspectFullRefreshTarget({ target: scene.target });
  assert.deepEqual(scene.projectStore.describeFullRefreshDisposition(stale), {
    disposition: 'base_changed',
    generation: 2,
  });

  const pendingCurrentValue = structuredClone(scene.currentProjection);
  const chapterId = scene.currentProjection.basis.chapters[0].id;
  pendingCurrentValue.basis.pendingProposals = [{ revisionId, chapterId }];
  pendingCurrentValue.basis.basisDigest = canonicalProjectionBasisDigest(
    pendingCurrentValue.basis,
  );
  const pendingCurrent = deepFreeze(pendingCurrentValue);
  const changedChapter = scene.candidate.chapters[0];
  const changedHash = 'e'.repeat(64);
  const changedCandidate = deepFreeze({
    ...scene.candidate,
    chapters: scene.candidate.chapters.map((row, index) => (
      index === 0 ? { ...row, bodyRawSha256: changedHash, content: `${row.content}\nchanged` } : row
    )),
    controlledFiles: scene.candidate.controlledFiles.map((row) => (
      row.role === 'chapter_body' && row.resourceUid === changedChapter.chapterUid
        ? { ...row, rawSha256: changedHash }
        : row
    )),
  });
  const invalidatingTarget = new SQLiteProjectionStore().buildTarget({
    candidate: changedCandidate,
    currentProjection: pendingCurrent,
    targetGeneration: 3,
    projectedAt: '2026-08-20T00:00:03.000Z',
    ignoredLedger: scene.target.ignoredLedger,
    localIdentityPlan: canonicalSchema12ReuseIdentityPlan(pendingCurrent),
  });
  assert.deepEqual(invalidatingTarget.proposalInvalidations, [{
    revisionId,
    chapterId,
    from: 'pending',
    to: 'stale',
  }]);
  const required = scene.projectStore.inspectFullRefreshTarget({ target: invalidatingTarget });
  assert.deepEqual(scene.projectStore.describeFullRefreshDisposition(required), {
    disposition: 'target',
    generation: 2,
  });
});

test('files database port binds FULL receipts inside the publication logical-request lease', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const portBoundary = source.indexOf('function manuscriptTransactionRequired');
  const portStart = source.lastIndexOf('  return Object.freeze({', portBoundary);
  const portEnd = source.indexOf('\n  });\n}', portStart);
  const portSource = source.slice(portStart, portEnd);
  assert.match(portSource, /inspectFullRefreshTarget\(admission, input\)\s*\{[\s\S]*?activeTurn === null[\s\S]*?captureFullRefreshTarget\(input\)[\s\S]*?withProjectLogicalRequestSync\([\s\S]*?mintFullRefreshReceipt\([\s\S]*?nativeStore\.inspectFullRefreshTarget\(Object\.freeze\(\{ target \}\)\)/u);
  assert.match(portSource, /describeFullRefreshDisposition\(admission, authority\)\s*\{[\s\S]*?fullRefreshReceiptRecords\.get\(authority\)[\s\S]*?record\.activeTurn !== entry\.activeTurn[\s\S]*?record\.consumed = true[\s\S]*?record\.innerReceipt,[\s\S]*?record\.target/u);
});

test('FULL inspect and publish reject accessor inputs without invoking them', async (t) => {
  const scene = await fullRefreshScene(t, 'full-refresh-accessor-input');
  for (const method of ['inspectFullRefreshTarget', 'publishProjectionTarget']) {
    let reads = 0;
    const input = {};
    Object.defineProperty(input, 'target', {
      enumerable: true,
      get() {
        reads += 1;
        return scene.target;
      },
    });
    Object.freeze(input);
    assert.throws(
      () => scene.projectStore[method](input),
      (error) => error instanceof TypeError && /data property/u.test(error.message),
      method,
    );
    assert.equal(reads, 0, method);
  }
});

test('files database FULL receipts are same-turn one-shot authorities bound to their port', async (t) => {
  const scene = await fullRefreshScene(t, 'full-refresh-db-receipt');
  scene.projectStore.close();
  const db = require('../db');
  db.configureStorage({ dataDir: path.join(path.dirname(scene.databasePath), 'db-port-data') });
  await db.initDatabase();
  const registeredPath = db.getProjectDbPath('full-refresh-db-receipt');
  await installActivatedCreationProof(
    db.getDataDir(),
    registeredPath,
    scene.admission.databaseFacts.projectInstanceId,
  );
  fs.copyFileSync(scene.databasePath, registeredPath);
  const firstPort = db.createFilesManuscriptDatabasePort();
  const secondPort = db.createFilesManuscriptDatabasePort();
  let laterReceipt;
  let foreignReceipt;
  try {
    await firstPort.withWriterTurn(scene.admission, async () => {
      const mutableInput = { target: scene.target };
      const oneShotReceipt = firstPort.inspectFullRefreshTarget(
        scene.admission,
        mutableInput,
      );
      mutableInput.target = changedFullRefreshTarget(scene);
      assert.deepEqual(
        firstPort.describeFullRefreshDisposition(scene.admission, oneShotReceipt),
        { disposition: 'already_current', generation: 1 },
      );
      assert.throws(
        () => firstPort.describeFullRefreshDisposition(scene.admission, oneShotReceipt),
        (error) => error instanceof TypeError && /consumed/u.test(error.message),
      );
      laterReceipt = firstPort.inspectFullRefreshTarget(
        scene.admission,
        { target: scene.target },
      );
      foreignReceipt = firstPort.inspectFullRefreshTarget(
        scene.admission,
        { target: scene.target },
      );
    });

    await firstPort.withWriterTurn(scene.admission, async () => {
      assert.throws(
        () => firstPort.describeFullRefreshDisposition(scene.admission, laterReceipt),
        (error) => error instanceof TypeError && /writer turn/u.test(error.message),
      );
    });
    await secondPort.withWriterTurn(scene.admission, async () => {
      assert.throws(
        () => secondPort.describeFullRefreshDisposition(scene.admission, foreignReceipt),
        (error) => error instanceof TypeError && /foreign/u.test(error.message),
      );
    });
  } finally {
    firstPort.close();
    secondPort.close();
    db.closeAllDatabases();
  }

  assert.throws(
    () => firstPort.describeFullRefreshDisposition(scene.admission, laterReceipt),
    (error) => error?.code === 'RECOVERY_REQUIRED' && /closed/u.test(error.message),
  );
});
