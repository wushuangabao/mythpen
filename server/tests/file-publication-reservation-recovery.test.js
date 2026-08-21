'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { FilePublicationJournal } = require('../manuscript/file-publication-journal');
const { createL2ManuscriptService } = require('../manuscript/l2-service');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('../manuscript/projection-store');
const {
  canonicalCreateLogicalInputDigest,
  validateIdentityReservationManifest,
} = require('../manuscript/uid-reservation');
const { serializeCanonicalJson } = require('../manuscript/format');
const {
  deriveChapterPaths,
  deriveControlledFileRef,
  deriveManuscriptPaths,
  deriveVolumePath,
} = require('../manuscript/paths');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const JOURNAL_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_JOURNAL_ID = '44444444-4444-4444-8444-444444444444';
const PARENT_JOURNAL_ID = '55555555-5555-4555-8555-555555555555';
const VOLUME_UID = '66666666-6666-4666-8666-666666666666';
const SECOND_VOLUME_UID = '77777777-7777-4777-8777-777777777777';
const CHAPTER_UID = '99999999-9999-4999-8999-999999999999';
const BASIS_DIGEST = 'a'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalValue(value[key]);
    return result;
  }
  return value;
}

function digestPlain(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function assertRecursivelyFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertRecursivelyFrozen(child, seen);
}

function identity(ino, dev = 7) {
  return Object.freeze({ dev: String(dev), ino: String(ino) });
}

function projectBinding() {
  return deepFreeze({
    dataRoot: path.join(path.parse(process.cwd()).root, 'mythpen-task10b2-fixture'),
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    controlIncarnationId: 'control-incarnation-task10b2',
    articleRootIdentity: identity(10),
    recoveryRootIdentity: identity(20),
  });
}

function controlDirectory(binding) {
  return path.join(
    binding.dataRoot,
    'control',
    'manuscripts',
    binding.projectUid,
    binding.projectInstanceId,
  );
}

function createMemoryControlStore(binding) {
  const events = [];
  const stats = { reads: 0 };
  return {
    directory: controlDirectory(binding),
    incarnationId: binding.controlIncarnationId,
    compareAndAppend(expected, input) {
      assert.equal(expected, events.at(-1)?.digest ?? null);
      const event = deepFreeze({
        seq: events.length + 1,
        type: input.type,
        payload: clone(input.payload),
        prevDigest: expected,
        digest: `digest-${events.length + 1}`,
      });
      events.push(event);
      return event;
    },
    read() {
      stats.reads += 1;
      return Object.freeze([...events]);
    },
    tail() {
      return events.at(-1) ?? null;
    },
    events,
    stats,
  };
}

function relocationReceipt(plan) {
  return deepFreeze({
    kind: 'relocate',
    sourcePath: plan.sourcePath,
    targetPath: plan.targetPath,
    byteSize: plan.byteSize,
    sha256: plan.sha256,
    identity: plan.identity,
    sourceParentIdentity: plan.sourceParentIdentity,
    targetParentIdentity: plan.targetParentIdentity,
    relocated: true,
    sourceParentFsync: true,
    targetParentFsync: true,
  });
}

function publicationPlans(member) {
  const plans = [];
  if (member.operation === 'update' || member.operation === 'delete') {
    plans.push({
      sourcePath: member.final.path,
      targetPath: member.displaced.path,
      byteSize: member.before.byteSize,
      sha256: member.before.sha256,
      identity: member.before.fileIdentity,
      sourceParentIdentity: member.final.parentIdentity,
      targetParentIdentity: member.displaced.parentIdentity,
    });
  }
  if (member.operation === 'update' || member.operation === 'create') {
    plans.push({
      sourcePath: member.after.asset.path,
      targetPath: member.final.path,
      byteSize: member.after.byteSize,
      sha256: member.after.sha256,
      identity: member.after.fileIdentity,
      sourceParentIdentity: member.after.asset.parentIdentity,
      targetParentIdentity: member.final.parentIdentity,
    });
  }
  return plans;
}

function createFakeFilePublisher() {
  const assets = new Map();
  const calls = [];
  let nextIdentity = 100;
  return {
    calls,
    async createAsset({ reservation, bytes }) {
      calls.push({ method: 'createAsset', reservation });
      const fileIdentity = identity(nextIdentity++);
      assets.set(reservation.path, Buffer.from(bytes));
      return deepFreeze({
        assetKind: reservation.assetKind,
        path: reservation.path,
        parentIdentity: reservation.parentIdentity,
        fileIdentity,
        byteSize: reservation.byteSize,
        sha256: reservation.sha256,
        fileSynced: true,
        parentSynced: true,
      });
    },
    async readAsset({ asset }) {
      calls.push({ method: 'readAsset', asset });
      const bytes = assets.get(asset.path);
      if (bytes === undefined) throw new Error('asset missing');
      return Buffer.from(bytes);
    },
    async inspect({ manifest, scope }) {
      calls.push({ method: 'inspect', scope: scope ?? null });
      if (scope === 'safe_abort') return Object.freeze({ disposition: 'SAFE_ABORT' });
      return deepFreeze({
        disposition: 'AFTER',
        members: manifest.members.map((member) => ({ refKey: member.refKey, disposition: 'AFTER' })),
      });
    },
    async publish({ manifest }) {
      calls.push({ method: 'publish' });
      return deepFreeze({
        disposition: 'AFTER',
        members: manifest.members.map((member) => ({
          refKey: member.refKey,
          disposition: 'AFTER',
          effects: publicationPlans(member).map(relocationReceipt),
        })),
      });
    },
    async rollback() {
      calls.push({ method: 'rollback' });
      return Object.freeze({ disposition: 'BEFORE' });
    },
    async collect({ manifest, terminalDisposition }) {
      calls.push({ method: 'collect', terminalDisposition });
      const expected = [];
      const seen = new Set();
      for (const asset of manifest.assets) {
        if (terminalDisposition === 'AFTER' && asset.assetKind === 'staged_after') continue;
        if (seen.has(asset.path)) continue;
        seen.add(asset.path);
        expected.push(asset);
      }
      if (terminalDisposition === 'AFTER') {
        for (const member of manifest.members) {
          if (!member.before.exists || seen.has(member.displaced.path)) continue;
          seen.add(member.displaced.path);
          expected.push({
            path: member.displaced.path,
            parentIdentity: member.displaced.parentIdentity,
            fileIdentity: member.before.fileIdentity,
          });
        }
      }
      return deepFreeze({
        disposition: 'COLLECTED',
        assets: expected.map((asset) => ({
          path: asset.path,
          disposition: 'DELETED',
          alreadyAbsent: false,
          deleted: true,
          identity: asset.fileIdentity,
          parentFsync: true,
          parentIdentity: asset.parentIdentity,
        })),
      });
    },
  };
}

function createHarness({ binding = projectBinding(), controlStore } = {}) {
  const safeControlStore = controlStore ?? createMemoryControlStore(binding);
  const filePublisher = createFakeFilePublisher();
  let projectionInstalled = false;
  const projectionStore = {
    validateTarget(target) {
      return target;
    },
    async publish() {
      projectionInstalled = true;
    },
  };
  const parentAuthority = {
    async assertReservation() {},
    async assertPin() {},
    async readRecoveryIntent() { return 'before'; },
    async assertGc() {},
  };
  const writeChecks = [];
  const journal = new FilePublicationJournal({
    controlStore: safeControlStore,
    filePublisher,
    projectionStore,
    projectStore: Object.freeze({ kind: 'test-project-store' }),
    projectionDisposition: {
      async inspectTarget() {
        return projectionInstalled ? 'target' : 'base';
      },
    },
    parentAuthority,
    projectBinding: binding,
    async assertWriteAuthority(value) {
      writeChecks.push(value);
    },
  });
  return {
    binding,
    controlStore: safeControlStore,
    filePublisher,
    journal,
    writeChecks,
  };
}

function reservationIdFor(manifestWithoutId) {
  return createHash('sha256')
    .update('mythpen.manuscript.uid-reservation-id.v1\0', 'utf8')
    .update(JSON.stringify(manifestWithoutId), 'utf8')
    .digest('hex');
}

function volumeReservation(binding, {
  logicalRequestId = 'logical-volume-create-1',
  uid = VOLUME_UID,
  title = 'Volume 1',
  summary = 'Arc 1',
  sourceBasisDigest = BASIS_DIGEST,
} = {}) {
  const logicalInputDigest = canonicalCreateLogicalInputDigest({
    kind: 'volume.create',
    title,
    summary,
  });
  const paths = deriveManuscriptPaths({ dataRoot: binding.dataRoot, projectUid: binding.projectUid });
  const manifestWithoutId = {
    domain: 'mythpen.manuscript.uid-reservation',
    version: 1,
    assignmentKind: 'reserved_new',
    objectKind: 'volume',
    projectUid: binding.projectUid,
    projectInstanceId: binding.projectInstanceId,
    logicalRequestId,
    logicalInputDigest,
    sourceBasisDigest,
    uid,
    id: uid === VOLUME_UID ? 8 : 9,
    pathPredicates: [{
      role: 'volume_index',
      canonicalPath: deriveVolumePath(paths, uid),
      parentIdentity: identity(31),
      disposition: 'absent',
    }],
  };
  return validateIdentityReservationManifest({
    ...manifestWithoutId,
    reservationId: reservationIdFor(manifestWithoutId),
  });
}

function mutateReservation(reservation, mutate) {
  const value = clone(reservation);
  delete value.reservationId;
  mutate(value);
  return validateIdentityReservationManifest({
    ...value,
    reservationId: reservationIdFor(value),
  });
}

function reservationInputDigest(payload) {
  return digestPlain({
    journalId: payload.journalId,
    logicalRequestId: payload.logicalRequestId,
    baseGeneration: payload.baseGeneration,
    targetGeneration: payload.targetGeneration,
    basisDigest: payload.basisDigest,
    identityReservation: payload.identityReservation,
    parent: payload.parent,
    projectBinding: payload.projectBinding,
    members: payload.members,
  });
}

function chapterReservation(binding, {
  logicalRequestId = 'logical-chapter-create-1',
  requestedNum = null,
} = {}) {
  const logicalInputDigest = canonicalCreateLogicalInputDigest({
    kind: 'chapter.create',
    containerVolumeUid: VOLUME_UID,
    requestedNum,
    content: '# Chapter 1\n',
    sidecar: {
      title: 'Chapter 1',
      outline: '',
      status: 'writing',
      summary: '',
      cognitive_frame: '',
      emotional_anchor: '',
      world_texture: '',
      concrete_mystery: '',
      interpersonal_tension: '',
    },
  });
  const paths = deriveManuscriptPaths({ dataRoot: binding.dataRoot, projectUid: binding.projectUid });
  const chapterPaths = deriveChapterPaths(paths, CHAPTER_UID);
  const manifestWithoutId = {
    domain: 'mythpen.manuscript.uid-reservation',
    version: 1,
    assignmentKind: 'reserved_new',
    objectKind: 'chapter',
    projectUid: binding.projectUid,
    projectInstanceId: binding.projectInstanceId,
    logicalRequestId,
    logicalInputDigest,
    sourceBasisDigest: BASIS_DIGEST,
    uid: CHAPTER_UID,
    id: 51,
    num: 5,
    containerVolumeUid: VOLUME_UID,
    requestedNum,
    pathPredicates: [
      {
        role: 'chapter_body',
        canonicalPath: chapterPaths.bodyPath,
        parentIdentity: identity(32),
        disposition: 'absent',
      },
      {
        role: 'chapter_sidecar',
        canonicalPath: chapterPaths.sidecarPath,
        parentIdentity: identity(32),
        disposition: 'absent',
      },
    ],
  };
  return validateIdentityReservationManifest({
    ...manifestWithoutId,
    reservationId: reservationIdFor(manifestWithoutId),
  });
}

function absentBefore() {
  return deepFreeze({
    exists: false,
    bytes: null,
    byteSize: 0,
    rawSha256: null,
    fileIdentity: null,
  });
}

function presentBefore(bytes, fileIdentity) {
  const copy = Buffer.from(bytes);
  return deepFreeze({
    exists: true,
    bytes: copy,
    byteSize: copy.length,
    rawSha256: sha256(copy),
    fileIdentity,
  });
}

function presentAfter(bytes) {
  const copy = Buffer.from(bytes);
  return deepFreeze({
    exists: true,
    bytes: copy,
    byteSize: copy.length,
    rawSha256: sha256(copy),
  });
}

function volumeCreateClosure(binding, uid = VOLUME_UID, afterSuffix = '') {
  return deepFreeze([
    {
      ref: deriveControlledFileRef({ role: 'volume_index', projectUid: binding.projectUid, volumeUid: uid }),
      parentIdentity: identity(31),
      before: absentBefore(),
      after: presentAfter(serializeCanonicalJson('volume_index', {
        format_version: 1,
        volume_uid: uid,
        title: `Volume 1${afterSuffix}`,
        summary: 'Arc 1',
        chapter_uids: [],
      })),
    },
    {
      ref: deriveControlledFileRef({ role: 'manuscript', projectUid: binding.projectUid }),
      parentIdentity: identity(30),
      before: presentBefore('{"format_version":1,"project_uid":"old","volume_uids":[]}\n', identity(40)),
      after: presentAfter(`{\"format_version\":1,\"project_uid\":\"${binding.projectUid}\",\"volume_uids\":[\"${uid}\"]}\n`),
    },
  ]);
}

function volumeCreateClosureWithExtraIndex(binding) {
  const [volumeMember, manuscriptMember] = volumeCreateClosure(binding);
  return deepFreeze([
    volumeMember,
    {
      ref: deriveControlledFileRef({ role: 'unassigned', projectUid: binding.projectUid }),
      parentIdentity: identity(30),
      before: presentBefore('{"format_version":1,"project_uid":"old","chapter_uids":[]}\n', identity(41)),
      after: presentAfter('{"format_version":1,"project_uid":"old","chapter_uids":["unexpected"]}\n'),
    },
    manuscriptMember,
  ]);
}

function chapterCreateClosure(binding, targetRole = 'volume_index', {
  content = '# Chapter 1\n',
  title = 'Chapter 1',
} = {}) {
  const indexRef = targetRole === 'volume_index'
    ? deriveControlledFileRef({ role: 'volume_index', projectUid: binding.projectUid, volumeUid: VOLUME_UID })
    : deriveControlledFileRef({ role: 'unassigned', projectUid: binding.projectUid });
  return deepFreeze([
    {
      ref: deriveControlledFileRef({ role: 'chapter_body', projectUid: binding.projectUid, chapterUid: CHAPTER_UID }),
      parentIdentity: identity(32),
      before: absentBefore(),
      after: presentAfter(content),
    },
    {
      ref: deriveControlledFileRef({ role: 'chapter_sidecar', projectUid: binding.projectUid, chapterUid: CHAPTER_UID }),
      parentIdentity: identity(32),
      before: absentBefore(),
      after: presentAfter(serializeCanonicalJson('chapter_sidecar', {
        format_version: 1,
        chapter_uid: CHAPTER_UID,
        title,
        outline: '',
        status: 'writing',
        summary: '',
        cognitive_frame: '',
        emotional_anchor: '',
        world_texture: '',
        concrete_mystery: '',
        interpersonal_tension: '',
      })),
    },
    {
      ref: indexRef,
      parentIdentity: targetRole === 'volume_index' ? identity(31) : identity(30),
      before: presentBefore('{"format_version":1,"chapter_uids":[]}\n', identity(42)),
      after: presentAfter(`{\"format_version\":1,\"chapter_uids\":[\"${CHAPTER_UID}\"]}\n`),
    },
  ]);
}

async function stageVolume(harness, {
  journalId = JOURNAL_ID,
  logicalRequestId = 'logical-volume-create-1',
  uid = VOLUME_UID,
  identityReservation = volumeReservation(harness.binding, { logicalRequestId, uid }),
  closure = volumeCreateClosure(harness.binding, uid),
  parent = null,
  baseGeneration = 3,
  targetGeneration = 4,
  basisDigest = identityReservation?.sourceBasisDigest ?? BASIS_DIGEST,
} = {}) {
  return harness.journal.stageAssets({
    journalId,
    logicalRequestId,
    baseGeneration,
    targetGeneration,
    basisDigest,
    closure,
    identityReservation,
    parent,
    parentReservationAuthority: undefined,
  });
}

async function stageChapter(harness, {
  closure = chapterCreateClosure(harness.binding),
  identityReservation = chapterReservation(harness.binding),
} = {}) {
  return harness.journal.stageAssets({
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-chapter-create-1',
    baseGeneration: 3,
    targetGeneration: 4,
    basisDigest: BASIS_DIGEST,
    closure,
    identityReservation,
    parent: null,
    parentReservationAuthority: undefined,
  });
}

function projectionTarget(stagedAfterFacts, binding, {
  basisDigest = BASIS_DIGEST,
  baseGeneration = 3,
  targetGeneration = 4,
} = {}) {
  return deepFreeze({
    domain: 'mythpen.test.projection-target',
    version: 1,
    projectUid: binding.projectUid,
    projectInstanceId: binding.projectInstanceId,
    basisDigest,
    baseGeneration,
    targetGeneration,
    controlledFiles: stagedAfterFacts.map((fact) => ({
      role: fact.ref.role,
      resourceUid: fact.ref.volumeUid ?? fact.ref.chapterUid ?? null,
      byteSize: fact.byteSize,
      rawSha256: fact.rawSha256,
      fileIdentity: fact.fileIdentity,
      parentIdentity: fact.parentIdentity,
    })),
  });
}

async function advanceTo(harness, state, options = {}) {
  const staged = await stageVolume(harness, options);
  if (state === 'assets_reserved') return staged;
  const bound = await harness.journal.bindTarget({
    stagedAssets: staged.stagedAssets,
    projectionTarget: projectionTarget(staged.stagedAfterFacts, harness.binding),
  });
  if (state === 'target_reserved') return bound;
  await harness.journal.prepare({ preparedAssets: bound.preparedAssets });
  if (state === 'prepared') return bound;
  await harness.journal.publishFiles(options.journalId ?? JOURNAL_ID);
  if (state === 'files_published') return bound;
  await harness.journal.commitProjection(options.journalId ?? JOURNAL_ID);
  if (state === 'projection_committed') return bound;
  await harness.journal.complete(options.journalId ?? JOURNAL_ID);
  return bound;
}

function emptySchema12Projection(binding) {
  const ignoredLedger = deepFreeze([]);
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'schema12',
    baseGeneration: 3,
    volumes: [],
    chapters: [],
    sqliteSequence: [
      { name: 'chapters', seq: 0 },
      { name: 'volumes', seq: 7 },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(ignoredLedger),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return {
    ignoredLedger,
    currentProjection: deepFreeze({
      projectUid: binding.projectUid,
      projectInstanceId: binding.projectInstanceId,
      basis,
    }),
  };
}

test('ordinary lookup restarts with exact early binding and opaque read/assert authority', async () => {
  const harness = createHarness();
  const reservation = volumeReservation(harness.binding);
  await stageVolume(harness, { identityReservation: reservation });

  harness.controlStore.stats.reads = 0;
  const lookup = harness.journal.lookupOrdinaryRequest('logical-volume-create-1');
  assert.equal(harness.controlStore.stats.reads, 1);
  assert.deepEqual(Object.keys(lookup), ['state', 'outcome', 'identityReservation', 'reservationBinding']);
  assert.equal(lookup.state, 'assets_reserved');
  assert.equal(lookup.outcome, 'early');
  assert.deepEqual(lookup.identityReservation, reservation);
  assertRecursivelyFrozen(lookup);
  assert.deepEqual(lookup.reservationBinding, {
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
    baseGeneration: 3,
    targetGeneration: 4,
    basisDigest: BASIS_DIGEST,
    logicalInputDigest: reservation.logicalInputDigest,
    inputDigest: lookup.reservationBinding.inputDigest,
    reservationDigest: lookup.reservationBinding.reservationDigest,
  });
  assert.match(lookup.reservationBinding.inputDigest, /^[0-9a-f]{64}$/u);
  assert.match(lookup.reservationBinding.reservationDigest, /^[0-9a-f]{64}$/u);

  const restarted = createHarness({ binding: harness.binding, controlStore: harness.controlStore });
  harness.controlStore.stats.reads = 0;
  assert.deepEqual(restarted.journal.lookupOrdinaryRequest('logical-volume-create-1'), lookup);
  assert.equal(harness.controlStore.stats.reads, 1);
  const read = restarted.journal.readReservation({
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  });
  assert.deepEqual(Object.keys(read), ['identityReservation', 'authority']);
  assert.deepEqual(read.identityReservation, reservation);
  assert.equal(JSON.stringify(read.authority), undefined);
  assert.deepEqual(restarted.journal.assertReservation({
    authority: read.authority,
    identityReservation: read.identityReservation,
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  }), lookup.reservationBinding);
  assert.throws(() => restarted.journal.assertReservation({
    authority: read.authority,
    identityReservation: deepFreeze(clone(read.identityReservation)),
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  }), TypeError);
  assert.equal(restarted.journal.readReservation({
    journalId: SECOND_JOURNAL_ID,
    logicalRequestId: 'not-created',
  }), null);

  await stageVolume(restarted, {
    journalId: SECOND_JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-2',
    uid: SECOND_VOLUME_UID,
  });
  assert.deepEqual(restarted.journal.assertReservation({
    authority: read.authority,
    identityReservation: read.identityReservation,
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  }), lookup.reservationBinding, 'another journal tail append must not invalidate the authority');

  const resumed = await stageVolume(restarted);
  const target = await restarted.journal.bindTarget({
    stagedAssets: resumed.stagedAssets,
    projectionTarget: projectionTarget(resumed.stagedAfterFacts, restarted.binding),
  });
  const targetRead = restarted.journal.readReservation({
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  });
  assert.equal(
    restarted.journal.lookupOrdinaryRequest('logical-volume-create-1').state,
    'target_reserved',
  );
  assert.deepEqual(restarted.journal.assertReservation({
    authority: targetRead.authority,
    identityReservation: targetRead.identityReservation,
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  }), restarted.journal.lookupOrdinaryRequest('logical-volume-create-1').reservationBinding);
  await restarted.journal.prepare({ preparedAssets: target.preparedAssets });
  assert.throws(() => restarted.journal.assertReservation({
    authority: targetRead.authority,
    identityReservation: targetRead.identityReservation,
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  }), (error) => error?.code === 'RECOVERY_REQUIRED');
});

test('L2 service resumes an upstream-preserved early create without a new UID or journal chain', async () => {
  const harness = createHarness();
  const projection = emptySchema12Projection(harness.binding);
  const command = {
    kind: 'volume.create',
    title: 'Volume 1',
    summary: 'Arc 1',
  };
  const identityReservation = volumeReservation(harness.binding, {
    sourceBasisDigest: projection.currentProjection.basis.basisDigest,
  });
  await stageVolume(harness, { identityReservation });

  const calls = [];
  const buildResult = Object.freeze({
    closure: volumeCreateClosure(harness.binding),
    candidateTemplate: Object.freeze({ projectUid: PROJECT_UID }),
  });
  const manuscriptStore = {
    async buildClosure(snapshot, receivedCommand, ignoredRows, receivedReservation) {
      calls.push('buildClosure');
      assert.equal(snapshot.capability, 'validated-file-snapshot');
      assert.deepEqual(receivedCommand, command);
      assert.deepEqual(receivedReservation, identityReservation);
      assert.deepEqual(ignoredRows, []);
      return buildResult;
    },
    finalizeCandidate(receivedBuild, stagedAfterFacts) {
      calls.push('finalizeCandidate');
      assert.strictEqual(receivedBuild, buildResult);
      return deepFreeze({ stagedAfterFacts });
    },
  };
  const projectionStore = {
    buildTarget({ candidate, localIdentityPlan }) {
      calls.push('buildTarget');
      assert.deepEqual(localIdentityPlan.filter(
        (entry) => entry.assignmentKind === 'reserved_new',
      ), [{
        assignmentKind: 'reserved_new',
        objectKind: 'volume',
        uid: VOLUME_UID,
        id: 8,
        reservationId: identityReservation.reservationId,
      }]);
      return projectionTarget(candidate.stagedAfterFacts, harness.binding, {
        basisDigest: projection.currentProjection.basis.basisDigest,
      });
    },
  };
  const uidReservation = {
    async reserveNewIdentity() {
      calls.push('unexpected-reserve');
      throw new Error('early resume must not reserve another identity');
    },
    assertReservation() {
      calls.push('unexpected-core-assert');
      throw new Error('early resume must use journal authority only');
    },
  };
  const uidPathProbe = {
    async probe() {
      calls.push('unexpected-probe');
      throw new Error('early resume must not probe another UID path');
    },
  };
  const service = createL2ManuscriptService({
    manuscriptStore,
    fileJournal: harness.journal,
    projectionStore,
    uidReservation,
    uidPathProbe,
  });
  const result = await service.execute(service.bindWriteIntent(command), {
    journalId: SECOND_JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
    projectedAt: '2026-08-18T00:00:00.000Z',
    currentProjection: projection.currentProjection,
    fileSnapshot: Object.freeze({ capability: 'validated-file-snapshot' }),
    ignoredLedger: projection.ignoredLedger,
  });

  assert.deepEqual(result, {
    state: 'created',
    objectKind: 'volume',
    uid: VOLUME_UID,
    id: 8,
    targetGeneration: 4,
  });
  assert.deepEqual(calls, ['buildClosure', 'finalizeCandidate', 'buildTarget']);
  assert.equal(harness.journal.lookupOrdinaryRequest('logical-volume-create-1').outcome, 'after');
  assert.equal(harness.journal.lookupOrdinaryRequest('logical-volume-create-1')
    .reservationBinding.journalId, JOURNAL_ID);
});

test('ordinary reserved_new staging rejects closure, path, structure, and replay drift before new effects', async () => {
  const wrongClosure = createHarness();
  await assert.rejects(stageVolume(wrongClosure, {
    closure: volumeCreateClosure(wrongClosure.binding, SECOND_VOLUME_UID),
  }), TypeError);
  assert.equal(wrongClosure.controlStore.events.length, 0);
  assert.equal(wrongClosure.filePublisher.calls.length, 0);

  const ordinaryNonCreate = createHarness();
  await assert.rejects(stageVolume(ordinaryNonCreate, {
    identityReservation: deepFreeze({ kind: 'legacy_identity_plan', version: 1 }),
  }), TypeError);
  assert.equal(ordinaryNonCreate.controlStore.events.length, 0);
  assert.equal(ordinaryNonCreate.filePublisher.calls.length, 0);

  for (const [label, mutate] of [
    ['canonical path', (value, binding) => {
      value.pathPredicates[0].canonicalPath = path.join(
        binding.dataRoot,
        'elsewhere',
        path.basename(value.pathPredicates[0].canonicalPath),
      );
    }],
    ['parent identity', (value) => {
      value.pathPredicates[0].parentIdentity = { dev: '7', ino: '999' };
    }],
  ]) {
    const current = createHarness();
    const reservation = mutateReservation(volumeReservation(current.binding), (value) => {
      mutate(value, current.binding);
    });
    await assert.rejects(stageVolume(current, { identityReservation: reservation }), TypeError, label);
    assert.equal(current.controlStore.events.length, 0, label);
    assert.equal(current.filePublisher.calls.length, 0, label);
  }

  const extraStructure = createHarness();
  await assert.rejects(stageVolume(extraStructure, {
    closure: volumeCreateClosureWithExtraIndex(extraStructure.binding),
  }), TypeError);
  assert.equal(extraStructure.controlStore.events.length, 0);
  assert.equal(extraStructure.filePublisher.calls.length, 0);

  const wrongChapterContainer = createHarness();
  await assert.rejects(stageChapter(wrongChapterContainer, {
    closure: chapterCreateClosure(wrongChapterContainer.binding, 'unassigned'),
  }), TypeError);
  assert.equal(wrongChapterContainer.controlStore.events.length, 0);
  assert.equal(wrongChapterContainer.filePublisher.calls.length, 0);

  const replay = createHarness();
  await stageVolume(replay);
  const eventCount = replay.controlStore.events.length;
  const createCount = replay.filePublisher.calls.filter((call) => call.method === 'createAsset').length;
  await assert.rejects(stageVolume(replay, {
    closure: volumeCreateClosure(replay.binding, VOLUME_UID, ' changed'),
  }), TypeError);
  assert.equal(replay.controlStore.events.length, eventCount);
  assert.equal(
    replay.filePublisher.calls.filter((call) => call.method === 'createAsset').length,
    createCount,
  );
  await assert.rejects(stageVolume(replay, {
    closure: volumeCreateClosure(replay.binding, VOLUME_UID, ' changed'),
    identityReservation: volumeReservation(replay.binding, { title: 'Volume 1 changed' }),
  }), (error) => error?.code === 'RECOVERY_REQUIRED');
  assert.equal(replay.controlStore.events.length, eventCount);
  assert.equal(
    replay.filePublisher.calls.filter((call) => call.method === 'createAsset').length,
    createCount,
  );
});

test('fresh ordinary create binds logical input digest to exact volume and chapter bytes', async () => {
  const volume = createHarness();
  await assert.rejects(stageVolume(volume, {
    closure: volumeCreateClosure(volume.binding, VOLUME_UID, ' changed'),
  }), TypeError);
  assert.equal(volume.controlStore.events.length, 0);
  assert.equal(volume.filePublisher.calls.length, 0);

  const automaticChapter = createHarness();
  await assert.rejects(stageChapter(automaticChapter, {
    closure: chapterCreateClosure(automaticChapter.binding, 'volume_index', {
      content: '# Different chapter\n',
    }),
  }), TypeError);
  assert.equal(automaticChapter.controlStore.events.length, 0);
  assert.equal(automaticChapter.filePublisher.calls.length, 0);

  const requestedChapter = createHarness();
  await assert.rejects(stageChapter(requestedChapter, {
    closure: chapterCreateClosure(requestedChapter.binding, 'volume_index', {
      title: 'Different title',
    }),
    identityReservation: chapterReservation(requestedChapter.binding, { requestedNum: 5 }),
  }), TypeError);
  assert.equal(requestedChapter.controlStore.events.length, 0);
  assert.equal(requestedChapter.filePublisher.calls.length, 0);

  const validAutomaticChapter = createHarness();
  await assert.doesNotReject(stageChapter(validAutomaticChapter));
  const validRequestedChapter = createHarness();
  await assert.doesNotReject(stageChapter(validRequestedChapter, {
    identityReservation: chapterReservation(validRequestedChapter.binding, { requestedNum: 5 }),
  }));
});

test('ordinary lookup classifies advanced, terminal, and collected terminal disposition', async () => {
  const advanced = createHarness();
  await advanceTo(advanced, 'prepared');
  assert.equal(advanced.journal.lookupOrdinaryRequest('logical-volume-create-1').outcome, 'advanced');
  assert.throws(() => advanced.journal.readReservation({
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-1',
  }), (error) => error?.code === 'RECOVERY_REQUIRED');

  const after = createHarness();
  await advanceTo(after, 'completed');
  assert.deepEqual(
    { state: after.journal.lookupOrdinaryRequest('logical-volume-create-1').state,
      outcome: after.journal.lookupOrdinaryRequest('logical-volume-create-1').outcome },
    { state: 'completed', outcome: 'after' },
  );
  await after.journal.collectAssets(JOURNAL_ID);
  assert.deepEqual(
    { state: after.journal.lookupOrdinaryRequest('logical-volume-create-1').state,
      outcome: after.journal.lookupOrdinaryRequest('logical-volume-create-1').outcome },
    { state: 'assets_collected', outcome: 'after' },
  );

  const before = createHarness();
  await stageVolume(before);
  await before.journal.recover(JOURNAL_ID);
  assert.equal(before.journal.lookupOrdinaryRequest('logical-volume-create-1').outcome, 'before');
  await before.journal.collectAssets(JOURNAL_ID);
  assert.deepEqual(
    { state: before.journal.lookupOrdinaryRequest('logical-volume-create-1').state,
      outcome: before.journal.lookupOrdinaryRequest('logical-volume-create-1').outcome },
    { state: 'assets_collected', outcome: 'before' },
  );
});

test('ordinary lookup fails closed for duplicate logical requests and non-create full journals', async () => {
  const duplicate = createHarness();
  await stageVolume(duplicate);
  await stageVolume(duplicate, {
    journalId: SECOND_JOURNAL_ID,
    uid: SECOND_VOLUME_UID,
    logicalRequestId: 'logical-volume-create-1',
  });
  assert.throws(
    () => duplicate.journal.lookupOrdinaryRequest('logical-volume-create-1'),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );

  const nonCreate = createHarness();
  await stageVolume(nonCreate, {
    logicalRequestId: 'ordinary-non-create',
    identityReservation: null,
  });
  assert.throws(
    () => nonCreate.journal.lookupOrdinaryRequest('ordinary-non-create'),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );

  const conflict = createHarness();
  await stageVolume(conflict, {
    logicalRequestId: 'draft-conflict-request',
    identityReservation: null,
    parent: deepFreeze({ kind: 'draft_conflict', journalId: PARENT_JOURNAL_ID }),
  });
  assert.throws(
    () => conflict.journal.lookupOrdinaryRequest('draft-conflict-request'),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
});

test('reservation source is stable, exact, retained through terminal, and removed only after collection', async () => {
  const early = createHarness();
  await stageVolume(early);
  const source = early.journal.reservationSource();
  assert.equal(early.journal.reservationSource(), source);
  const scope = { projectUid: PROJECT_UID, projectInstanceId: PROJECT_INSTANCE_ID, objectKind: 'volume' };
  early.controlStore.stats.reads = 0;
  const snapshot = source.enumerate(scope);
  assert.equal(early.controlStore.stats.reads, 1);
  assert.deepEqual(snapshot, {
    complete: true,
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    objectKind: 'volume',
    records: [{
      ownerKind: 'file_publication',
      ownerId: JOURNAL_ID,
      reservationId: early.journal.lookupOrdinaryRequest('logical-volume-create-1')
        .identityReservation.reservationId,
      uid: VOLUME_UID,
    }],
  });
  assertRecursivelyFrozen(snapshot);
  assert.throws(() => source.enumerate({ ...scope, extra: true }), TypeError);
  assert.throws(() => source.enumerate({ ...scope, projectUid: SECOND_VOLUME_UID }), TypeError);

  const after = createHarness();
  await advanceTo(after, 'completed');
  assert.equal(after.journal.reservationSource().enumerate(scope).records.length, 1);
  await after.journal.collectAssets(JOURNAL_ID);
  assert.equal(after.journal.reservationSource().enumerate(scope).records.length, 0);

  const before = createHarness();
  await stageVolume(before);
  await before.journal.recover(JOURNAL_ID);
  assert.equal(before.journal.reservationSource().enumerate(scope).records.length, 1);
  await before.journal.collectAssets(JOURNAL_ID);
  assert.equal(before.journal.reservationSource().enumerate(scope).records.length, 0);
});

test('reservation source excludes legal non-create and draft-conflict journals but fails on duplicate ownership', async () => {
  const excluded = createHarness();
  await stageVolume(excluded, {
    logicalRequestId: 'ordinary-non-create',
    identityReservation: null,
  });
  await stageVolume(excluded, {
    journalId: SECOND_JOURNAL_ID,
    logicalRequestId: 'draft-conflict-request',
    uid: SECOND_VOLUME_UID,
    identityReservation: null,
    parent: deepFreeze({ kind: 'draft_conflict', journalId: PARENT_JOURNAL_ID }),
  });
  await stageVolume(excluded, {
    journalId: '88888888-8888-4888-8888-888888888888',
    logicalRequestId: 'migration-file-only-request',
    uid: SECOND_VOLUME_UID,
    identityReservation: deepFreeze({ kind: 'legacy_identity_plan', version: 1 }),
    parent: deepFreeze({ kind: 'migration', journalId: PARENT_JOURNAL_ID }),
  });
  const scope = { projectUid: PROJECT_UID, projectInstanceId: PROJECT_INSTANCE_ID, objectKind: 'volume' };
  assert.deepEqual(excluded.journal.reservationSource().enumerate(scope).records, []);
  assert.throws(
    () => excluded.journal.lookupOrdinaryRequest('migration-file-only-request'),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );

  const duplicate = createHarness();
  await stageVolume(duplicate);
  await stageVolume(duplicate, {
    journalId: SECOND_JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-2',
    identityReservation: volumeReservation(duplicate.binding, {
      logicalRequestId: 'logical-volume-create-2',
      uid: VOLUME_UID,
    }),
  });
  assert.throws(
    () => duplicate.journal.reservationSource().enumerate(scope),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
});

test('persisted manifest corruption fails lookup and source closed after restart', async () => {
  const harness = createHarness();
  await stageVolume(harness);
  const first = clone(harness.controlStore.events[0]);
  first.payload.identityReservation.reservationId = '0'.repeat(64);
  harness.controlStore.events.splice(0, harness.controlStore.events.length, deepFreeze(first));
  const restarted = createHarness({ binding: harness.binding, controlStore: harness.controlStore });

  assert.throws(
    () => restarted.journal.lookupOrdinaryRequest('logical-volume-create-1'),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.throws(
    () => restarted.journal.reservationSource().enumerate({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      objectKind: 'volume',
    }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );

  const unrelatedUnknown = createHarness();
  await stageVolume(unrelatedUnknown);
  unrelatedUnknown.controlStore.compareAndAppend(
    unrelatedUnknown.controlStore.tail().digest,
    {
      type: 'manuscript.file_publication.future_state',
      payload: { journalId: SECOND_JOURNAL_ID, version: 1 },
    },
  );
  assert.throws(
    () => unrelatedUnknown.journal.reservationSource().enumerate({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      objectKind: 'volume',
    }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
});


test('cold parser rebinds a checksum-valid manifest to the persisted ordinary closure', async () => {
  const harness = createHarness();
  await stageVolume(harness);
  const first = clone(harness.controlStore.events[0]);
  const manifest = first.payload.identityReservation;
  delete manifest.reservationId;
  manifest.pathPredicates[0].canonicalPath = path.join(
    harness.binding.dataRoot,
    'elsewhere',
    path.basename(manifest.pathPredicates[0].canonicalPath),
  );
  manifest.reservationId = reservationIdFor(manifest);
  first.payload.inputDigest = reservationInputDigest(first.payload);
  harness.controlStore.events.splice(0, harness.controlStore.events.length, deepFreeze(first));
  const restarted = createHarness({ binding: harness.binding, controlStore: harness.controlStore });

  assert.throws(
    () => restarted.journal.lookupOrdinaryRequest('logical-volume-create-1'),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.throws(
    () => restarted.journal.readReservation({
      journalId: JOURNAL_ID,
      logicalRequestId: 'logical-volume-create-1',
    }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.throws(
    () => restarted.journal.reservationSource().enumerate({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      objectKind: 'volume',
    }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
});

test('reservation source permits UID reuse after a rolled-back reservation is collected', async () => {
  const harness = createHarness();
  await stageVolume(harness);
  await harness.journal.recover(JOURNAL_ID);
  await harness.journal.collectAssets(JOURNAL_ID);
  const staged = await stageVolume(harness, {
    journalId: SECOND_JOURNAL_ID,
    logicalRequestId: 'logical-volume-create-after-collection',
    uid: VOLUME_UID,
  });

  assert.deepEqual(harness.journal.reservationSource().enumerate({
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    objectKind: 'volume',
  }).records, [{
    ownerKind: 'file_publication',
    ownerId: SECOND_JOURNAL_ID,
    reservationId: staged.reservationManifest.identityReservation.reservationId,
    uid: VOLUME_UID,
  }]);
});

test('cold parser builds the expected staged-asset catalog once per journal', async () => {
  const harness = createHarness();
  await stageVolume(harness);
  const NativeMap = global.Map;
  let expectedCatalogConstructions = 0;
  const CountingMap = new Proxy(NativeMap, {
    construct(target, args) {
      if (new Error().stack?.includes('expectedStageReservations')) {
        expectedCatalogConstructions += 1;
      }
      return Reflect.construct(target, args);
    },
  });
  global.Map = CountingMap;
  try {
    harness.journal.lookupOrdinaryRequest('logical-volume-create-1');
  } finally {
    global.Map = NativeMap;
  }
  assert.equal(expectedCatalogConstructions, 1);
});
