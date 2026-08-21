'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { deriveControlledFileRef } = require('../manuscript/paths');
const { LIMITS } = require('../manuscript/contracts');
const capabilityRegistry = require('../manuscript/capability-registry');
const { ManuscriptStore } = require('../manuscript/store');
const { withFaults, FAULT_POINTS } = require('../testing/fault-injection');
const { createTestFileWriterCapability } = require('../testing/manuscript-capability-mint');
const { createManuscriptTreeFixture } = require('./fixtures/manuscript-tree');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const JOURNAL_ID = '33333333-3333-4333-8333-333333333333';
const PARENT_ID = '44444444-4444-4444-8444-444444444444';
const CHAPTER_UID = '55555555-5555-4555-8555-555555555555';
const BASIS_DIGEST = 'a'.repeat(64);
const originalRequireFileWriterCapability = capabilityRegistry.requireFileWriterCapability;
let writerCapabilityResolveCount = 0;
capabilityRegistry.requireFileWriterCapability = function countingWriterCapabilityResolver(capability) {
  writerCapabilityResolveCount += 1;
  return originalRequireFileWriterCapability(capability);
};
delete require.cache[require.resolve('../manuscript/file-publisher')];
const { FilePublisher } = require('../manuscript/file-publisher');
const { requireJournalAuthorityCapability } = capabilityRegistry;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function identity(ino, dev = 7) {
  return Object.freeze({ dev: String(dev), ino: String(ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function reservationInputDigest(reservation) {
  return digestPlain({
    journalId: reservation.journalId,
    logicalRequestId: reservation.logicalRequestId,
    baseGeneration: reservation.baseGeneration,
    targetGeneration: reservation.targetGeneration,
    basisDigest: reservation.basisDigest,
    identityReservation: reservation.identityReservation,
    parent: reservation.parent,
    projectBinding: reservation.projectBinding,
    members: reservation.members,
  });
}

function finalPathForRef(dataRoot, ref) {
  const mythpenRoot = path.join(dataRoot, 'manuscripts', PROJECT_UID, 'mythpen');
  if (ref.role === 'manuscript') return path.join(mythpenRoot, 'manuscript.json');
  if (ref.role === 'unassigned') return path.join(mythpenRoot, 'unassigned.json');
  if (ref.role === 'volume_index') return path.join(mythpenRoot, 'volumes', `vol_${ref.volumeUid}.json`);
  const suffix = ref.role === 'chapter_body' ? 'md' : 'json';
  return path.join(mythpenRoot, 'chapters', `ch_${ref.chapterUid}.${suffix}`);
}

function createMemoryControlStore({ directory = null, incarnationId = 'control-incarnation-1' } = {}) {
  const events = [];
  return {
    directory,
    incarnationId,
    append(input) {
      return this.compareAndAppend(events.at(-1)?.digest ?? null, input);
    },
    compareAndAppend(expected, input) {
      assert.equal(expected, events.at(-1)?.digest ?? null, 'CAS must use the live global tail');
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
      return Object.freeze([...events]);
    },
    tail() {
      return events.at(-1) ?? null;
    },
    events,
  };
}

function matches(record, expected, pathValue) {
  return record !== undefined
    && record.path === pathValue
    && record.bytes.length === expected.byteSize
    && sha256(record.bytes) === expected.sha256
    && sameIdentity(record.identity, expected.fileIdentity)
    && sameIdentity(record.parentIdentity, expected.parentIdentity);
}

function createFakeWriterCapability(controlStore) {
  const files = new Map();
  const calls = [];
  let nextIno = 100;
  let beforeCreate;
  let relocateFailure;
  let deleteFailure;
  let readFailure;

  function put(filePath, bytes, parentIdentity, fileIdentity = identity(nextIno++)) {
    const record = {
      bytes: Buffer.from(bytes),
      identity: Object.freeze({ ...fileIdentity }),
      parentIdentity: Object.freeze({ ...parentIdentity }),
      path: filePath,
    };
    files.set(filePath, record);
    return record;
  }

  const capability = {
    async createAssetVerified(assetPath, expected) {
      const assetName = path.basename(assetPath);
      const assetKind = assetName.endsWith('.projection-target.json')
        ? 'projection_target'
        : /\.before-[0-9]{5}\.bin$/u.test(assetName)
          ? 'before_copy'
          : 'staged_after';
      const request = { assetKind, assetPath, bytes: expected.bytes, expected };
      calls.push({ method: 'create', request, eventCount: controlStore.events.length });
      if (beforeCreate) await beforeCreate(request);
      if (files.has(assetPath)) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      const record = put(
        assetPath,
        expected.bytes,
        expected.parentIdentity,
      );
      return Object.freeze({
        byteSize: record.bytes.length,
        fileFsync: true,
        identity: record.identity,
        parentFsync: true,
        parentIdentity: record.parentIdentity,
        sha256: sha256(record.bytes),
      });
    },
    async readVerified(filePath, expected) {
      calls.push({ method: 'read', filePath, expected });
      if (readFailure) throw readFailure;
      const record = files.get(filePath);
      if (expected.disposition === 'absent') {
        if (record === undefined) return Object.freeze({ disposition: 'ABSENT' });
      } else if (
        expected.disposition === 'present'
        && matches(record, {
          byteSize: expected.byteSize,
          sha256: expected.sha256,
          fileIdentity: expected.identity,
          parentIdentity: expected.parentIdentity,
        }, filePath)
      ) {
        return Object.freeze({
          disposition: 'PRESENT',
          bytes: Buffer.from(record.bytes),
          byteSize: record.bytes.length,
          sha256: sha256(record.bytes),
          identity: record.identity,
          parentIdentity: record.parentIdentity,
        });
      }
      const error = new Error('verified source mismatch');
      error.code = 'VERIFIED_SOURCE_MISMATCH';
      throw error;
    },
    async relocateVerifiedToAbsent(sourcePath, targetPath, expected) {
      const request = { sourcePath, targetPath, expected };
      calls.push({ method: 'relocate', request });
      if (relocateFailure && !relocateFailure.afterEffect) throw relocateFailure.error;
      if (files.has(targetPath)) {
        const error = new Error('target exists');
        error.code = 'INSTALL_TARGET_EXISTS';
        throw error;
      }
      const record = files.get(sourcePath);
      if (!matches(record, {
        byteSize: expected.byteSize,
        sha256: expected.sha256,
        fileIdentity: expected.identity,
        parentIdentity: expected.sourceParentIdentity,
      }, sourcePath)) {
        const error = new Error('verified source mismatch');
        error.code = 'VERIFIED_SOURCE_MISMATCH';
        throw error;
      }
      files.delete(sourcePath);
      record.path = targetPath;
      record.parentIdentity = Object.freeze({ ...expected.targetParentIdentity });
      files.set(targetPath, record);
      if (relocateFailure?.afterEffect) throw relocateFailure.error;
      return Object.freeze({
        byteSize: record.bytes.length,
        identity: record.identity,
        relocated: true,
        sha256: sha256(record.bytes),
        sourceParentFsync: true,
        sourceParentIdentity: expected.sourceParentIdentity,
        targetParentFsync: true,
        targetParentIdentity: expected.targetParentIdentity,
      });
    },
    async deleteVerified(filePath, expected) {
      calls.push({ method: 'delete', filePath, expected });
      const record = files.get(filePath);
      if (record === undefined) {
        return Object.freeze({
          alreadyAbsent: true,
          deleted: false,
          parentFsync: false,
          parentIdentity: expected.parentIdentity,
        });
      }
      if (!matches(record, {
        byteSize: expected.byteSize,
        sha256: expected.sha256,
        fileIdentity: expected.identity,
        parentIdentity: expected.parentIdentity,
      }, filePath)) {
        const error = new Error('verified delete mismatch');
        error.code = 'VERIFIED_SOURCE_MISMATCH';
        throw error;
      }
      files.delete(filePath);
      if (deleteFailure?.afterEffect) throw deleteFailure.error;
      return Object.freeze({
        alreadyAbsent: false,
        deleted: true,
        identity: expected.identity,
        parentFsync: true,
        parentIdentity: expected.parentIdentity,
      });
    },
  };

  return {
    calls,
    capability: createTestFileWriterCapability(capability),
    files,
    put,
    mintCapability() {
      return createTestFileWriterCapability(capability);
    },
    setBeforeCreate(fn) {
      beforeCreate = fn;
    },
    setDeleteFailure(error, { afterEffect = false } = {}) {
      deleteFailure = error ? { afterEffect, error } : null;
    },
    setReadFailure(error) {
      readFailure = error;
    },
    setRelocateFailure(error, { afterEffect = false } = {}) {
      relocateFailure = error ? { afterEffect, error } : null;
    },
  };
}

function createParentAuthority() {
  const reservations = new WeakSet();
  const pins = new WeakSet();
  const intents = new WeakMap();
  const gc = new WeakSet();
  const calls = [];
  return {
    port: {
      async assertReservation({ authority }) {
        calls.push('reservation');
        if (!reservations.has(authority)) throw new TypeError('invalid parent reservation authority');
      },
      async assertPin({ authority }) {
        calls.push('pin');
        if (!pins.has(authority)) throw new TypeError('invalid parent pin authority');
      },
      async readRecoveryIntent({ authority }) {
        calls.push('intent');
        const disposition = intents.get(authority);
        if (!disposition) throw new TypeError('invalid parent recovery intent');
        return disposition;
      },
      async assertGc({ authority }) {
        calls.push('gc');
        if (!gc.has(authority)) throw new TypeError('invalid parent gc authority');
      },
    },
    calls,
    mintGc() {
      const authority = Object.freeze({ capability: 'gc' });
      gc.add(authority);
      return authority;
    },
    mintIntent(disposition) {
      const authority = Object.freeze({ capability: 'intent' });
      intents.set(authority, disposition);
      return authority;
    },
    mintPin() {
      const authority = Object.freeze({ capability: 'pin' });
      pins.add(authority);
      return authority;
    },
    mintReservation() {
      const authority = Object.freeze({ capability: 'reservation' });
      reservations.add(authority);
      return authority;
    },
  };
}

function projectBinding({ recoveryDev = 7 } = {}) {
  return deepFreeze({
    dataRoot: path.join(path.parse(process.cwd()).root, 'mythpen-task6-fixture'),
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    controlIncarnationId: 'control-incarnation-1',
    articleRootIdentity: identity(10, 7),
    recoveryRootIdentity: identity(20, recoveryDev),
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

function updateClosure(binding = projectBinding()) {
  const ref = deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_UID,
  });
  const beforeBytes = Buffer.from('before');
  const afterBytes = Buffer.from('after');
  return deepFreeze([{
    ref,
    parentIdentity: identity(30),
    before: {
      exists: true,
      bytes: beforeBytes,
      byteSize: beforeBytes.length,
      rawSha256: sha256(beforeBytes),
      fileIdentity: identity(40),
    },
    after: {
      exists: true,
      bytes: afterBytes,
      byteSize: afterBytes.length,
      rawSha256: sha256(afterBytes),
    },
  }]);
}

function createTarget(stagedAfterFacts, binding = projectBinding()) {
  return deepFreeze({
    domain: 'mythpen.test.projection-target',
    version: 1,
    projectUid: binding.projectUid,
    projectInstanceId: binding.projectInstanceId,
    basisDigest: BASIS_DIGEST,
    baseGeneration: 3,
    targetGeneration: 4,
    controlledFiles: stagedAfterFacts.map((staged) => ({
      role: staged.ref.role,
      resourceUid: staged.ref.chapterUid ?? staged.ref.volumeUid ?? null,
      byteSize: staged.byteSize,
      rawSha256: staged.rawSha256,
      fileIdentity: staged.fileIdentity,
      parentIdentity: staged.parentIdentity,
    })),
  });
}

function createHarness({
  parentKind = null,
  binding = projectBinding(),
  controlDirectoryPath = controlDirectory(binding),
  controlIncarnationId = binding.controlIncarnationId,
} = {}) {
  const { FilePublicationJournal } = require('../manuscript/file-publication-journal');
  const controlStore = createMemoryControlStore({
    directory: controlDirectoryPath,
    incarnationId: controlIncarnationId,
  });
  const writer = createFakeWriterCapability(controlStore);
  const filePublisher = new FilePublisher({ writerCapability: writer.capability });
  const parent = createParentAuthority();
  const projectionCalls = [];
  let projectionInstalled = false;
  const projectionStore = {
    validateTarget(target) {
      projectionCalls.push({ method: 'validate', target });
      assert.equal(Object.isFrozen(target), true);
      return target;
    },
    async publish({ projectStore, target }) {
      projectionCalls.push({ method: 'publish', projectStore, target });
      projectionInstalled = true;
    },
  };
  const dispositions = [];
  const projectionDisposition = {
    async inspectTarget() {
      return dispositions.shift() ?? (projectionInstalled ? 'target' : 'base');
    },
  };
  const writeChecks = [];
  const journal = new FilePublicationJournal({
    controlStore,
    filePublisher,
    projectionStore,
    projectStore: Object.freeze({ id: 'project-store' }),
    projectionDisposition,
    parentAuthority: parent.port,
    projectBinding: binding,
    async assertWriteAuthority(input) {
      writeChecks.push(input);
    },
  });
  const parentValue = parentKind === null
    ? null
    : deepFreeze({ kind: parentKind, journalId: PARENT_ID });
  return {
    binding,
    controlStore,
    dispositions,
    filePublisher,
    journal,
    parent,
    parentValue,
    projectionCalls,
    writer,
    writeChecks,
  };
}

async function stageUpdate(harness, overrides = {}) {
  const closure = overrides.closure ?? updateClosure(harness.binding);
  for (const member of closure) {
    if (!member.before.exists) continue;
    const formalPath = finalPathForRef(harness.binding.dataRoot, member.ref);
    if (harness.writer.files.has(formalPath)) continue;
    harness.writer.put(
      formalPath,
      member.before.bytes,
      member.parentIdentity,
      member.before.fileIdentity,
    );
  }
  return harness.journal.stageAssets({
    journalId: JOURNAL_ID,
    logicalRequestId: 'logical-request-1',
    baseGeneration: 3,
    targetGeneration: 4,
    basisDigest: BASIS_DIGEST,
    closure,
    identityReservation: null,
    parent: harness.parentValue,
    parentReservationAuthority: overrides.parentReservationAuthority,
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

function absentAfter() {
  return deepFreeze({ exists: false, bytes: null, byteSize: 0, rawSha256: null });
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

function mixedClosure() {
  const chapterBody = deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_UID,
  });
  const newSidecarUid = '66666666-6666-4666-8666-666666666666';
  const chapterSidecar = deriveControlledFileRef({
    role: 'chapter_sidecar',
    projectUid: PROJECT_UID,
    chapterUid: newSidecarUid,
  });
  const volume = deriveControlledFileRef({
    role: 'volume_index',
    projectUid: PROJECT_UID,
    volumeUid: '77777777-7777-4777-8777-777777777777',
  });
  return deepFreeze([
    deepFreeze({
      ref: chapterBody,
      parentIdentity: identity(30),
      before: presentBefore('body-before', identity(41)),
      after: presentAfter('body-after'),
    }),
    deepFreeze({
      ref: chapterSidecar,
      parentIdentity: identity(30),
      before: absentBefore(),
      after: presentAfter('{"title":"new"}\n'),
    }),
    deepFreeze({
      ref: volume,
      parentIdentity: identity(31),
      before: presentBefore('{"volume":"old"}\n', identity(42)),
      after: absentAfter(),
    }),
  ]);
}

function createOnlyClosure(binding = projectBinding()) {
  const ref = deriveControlledFileRef({
    role: 'chapter_sidecar',
    projectUid: PROJECT_UID,
    chapterUid: '66666666-6666-4666-8666-666666666666',
  });
  return deepFreeze([{
    ref,
    parentIdentity: identity(30),
    before: absentBefore(),
    after: presentAfter('{"title":"new"}\n'),
  }]);
}

async function bindAndPrepare(harness, { closure = updateClosure(harness.binding), pin } = {}) {
  const staged = await stageUpdate(harness, {
    closure,
    parentReservationAuthority: harness.parentValue === null
      ? undefined
      : harness.parent.mintReservation(),
  });
  const bound = await harness.journal.bindTarget({
    stagedAssets: staged.stagedAssets,
    projectionTarget: createTarget(staged.stagedAfterFacts, harness.binding),
  });
  await harness.journal.prepare({
    preparedAssets: bound.preparedAssets,
    parentPinAuthority: pin ?? (harness.parentValue === null ? undefined : harness.parent.mintPin()),
  });
  return { bound, staged };
}

test('Task 6 RED: file publication modules expose the committed API', () => {
  const { FilePublicationJournal } = require('../manuscript/file-publication-journal');
  const { FilePublisher } = require('../manuscript/file-publisher');

  assert.equal(typeof FilePublicationJournal, 'function');
  assert.equal(typeof FilePublisher, 'function');
  for (const method of [
    'stageAssets',
    'bindTarget',
    'prepare',
    'publishFiles',
    'commitProjection',
    'complete',
    'recover',
    'collectAssets',
    'journalAuthority',
  ]) {
    assert.equal(typeof FilePublicationJournal.prototype[method], 'function', method);
  }
  const store = createMemoryControlStore();
  const writer = createFakeWriterCapability(store);
  assert.throws(
    () => new FilePublisher({ writerCapability: { ...writer.capability } }),
    TypeError,
  );
});

test('Task 6 group 1 RED: reservation is durable before assets, buffers are isolated, and displaced remains absent', async () => {
  const harness = createHarness();
  const closure = updateClosure(harness.binding);
  const originalAfter = Buffer.from(closure[0].after.bytes);
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  harness.writer.setBeforeCreate(async () => createGate);

  writerCapabilityResolveCount = 0;
  const primitiveCallsBeforeStage = harness.writer.calls.length;
  const staging = stageUpdate(harness, { closure });
  closure[0].after.bytes.fill(0x78);
  releaseCreate();
  const result = await staging;
  assert.ok(
    writerCapabilityResolveCount >= harness.writer.calls.length - primitiveCallsBeforeStage,
  );

  assert.equal(harness.controlStore.events[0].type, 'manuscript.file_publication.assets_reserved');
  assert.equal(harness.controlStore.events[0].payload.record_kind, 'reservation');
  assert.equal(harness.writer.calls.filter((call) => call.method === 'create').every((call) => call.eventCount >= 1), true);
  assert.equal(result.reservationManifest.identityReservation, null);
  assert.equal(Object.isFrozen(result.reservationManifest), true);
  const stagedCreate = harness.writer.calls.find((call) => (
    call.method === 'create' && call.request.assetKind === 'staged_after'
  ));
  assert.deepEqual(stagedCreate.request.bytes, originalAfter);
  const displacedPath = result.reservationManifest.members[0].displaced.path;
  assert.equal(harness.writer.files.has(displacedPath), false);
  assert.equal(
    harness.controlStore.events.filter((event) => event.payload.record_kind === 'asset_ready').length,
    2,
  );
  const projectRecoveryRoot = path.join(
    harness.binding.dataRoot,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
    'file-assets',
  );
  for (const asset of result.reservationManifest.assets) {
    assert.equal(path.dirname(asset.path), projectRecoveryRoot);
    assert.equal(path.basename(asset.path).startsWith(`${JOURNAL_ID}.`), true);
  }
});

test('Task 6 group 1 RED: cross-volume binding fails before journal or asset side effects', async () => {
  assert.throws(
    () => createHarness({ binding: projectBinding({ recoveryDev: 8 }) }),
    { code: 'RECOVERY_REQUIRED' },
  );
});

test('Task 6 group 1 RED: journal binds the exact project ControlStore before side effects', () => {
  const binding = projectBinding();
  assert.throws(
    () => createHarness({
      binding,
      controlDirectoryPath: path.join(binding.dataRoot, 'control', 'wrong-project'),
    }),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.throws(
    () => createHarness({ binding, controlIncarnationId: 'foreign-incarnation' }),
    { code: 'RECOVERY_REQUIRED' },
  );
});

test('Task 6 group 2 RED: staged physical identity is required by target bind and target is reserved before creation', async () => {
  const harness = createHarness();
  const staged = await stageUpdate(harness);
  assert.equal(staged.stagedAfterFacts.length, 1);
  assert.equal(staged.stagedAfterFacts[0].ref.role, 'chapter_body');
  const target = createTarget(staged.stagedAfterFacts, harness.binding);
  const bound = await harness.journal.bindTarget({
    stagedAssets: staged.stagedAssets,
    projectionTarget: target,
  });

  const targetReservationIndex = harness.controlStore.events.findIndex((event) => (
    event.type === 'manuscript.file_publication.target_reserved'
    && event.payload.record_kind === 'reservation'
  ));
  const targetCreate = harness.writer.calls.find((call) => (
    call.method === 'create' && call.request.assetKind === 'projection_target'
  ));
  assert.notEqual(targetReservationIndex, -1);
  assert.ok(targetCreate.eventCount >= targetReservationIndex + 1);
  assert.equal(bound.manifest.members[0].after.fileIdentity.ino, staged.stagedAfterFacts[0].fileIdentity.ino);
  assert.equal(Object.isFrozen(bound.manifest), true);

  const second = createHarness();
  const secondStage = await stageUpdate(second);
  const wrongTarget = clone(createTarget(secondStage.stagedAfterFacts, second.binding));
  wrongTarget.controlledFiles[0].fileIdentity = { dev: '7', ino: '99999' };
  await assert.rejects(
    second.journal.bindTarget({
      stagedAssets: secondStage.stagedAssets,
      projectionTarget: deepFreeze(wrongTarget),
    }),
    TypeError,
  );
  assert.equal(second.controlStore.events.some((event) => event.type.endsWith('target_reserved')), false);
});

test('Task 6 group 2 RED: exact logical retry resumes target_reserved without a second reservation', async () => {
  const harness = createHarness();
  const first = await stageUpdate(harness);
  const target = createTarget(first.stagedAfterFacts, harness.binding);
  await assert.rejects(
    withFaults({
      [FAULT_POINTS.FILE_PUBLICATION_AFTER_TARGET_RESERVED]: { throw: 'EIO' },
    }, () => harness.journal.bindTarget({
      stagedAssets: first.stagedAssets,
      projectionTarget: target,
    })),
    { code: 'EIO' },
  );
  const retried = await stageUpdate(harness);
  const bound = await harness.journal.bindTarget({
    stagedAssets: retried.stagedAssets,
    projectionTarget: target,
  });
  assert.equal(bound.manifest.targetAsset.assetKind, 'projection_target');
  assert.equal(
    harness.controlStore.events.filter((event) => (
      event.type.endsWith('target_reserved') && event.payload.record_kind === 'reservation'
    )).length,
    1,
  );
});

test('Task 6 group 3 RED: file-only reservation and full-manifest pin are branded parent gates', async () => {
  const harness = createHarness({ parentKind: 'migration' });
  await assert.rejects(stageUpdate(harness), TypeError);
  assert.equal(harness.controlStore.events.length, 0);

  const reservation = harness.parent.mintReservation();
  const staged = await stageUpdate(harness, { parentReservationAuthority: reservation });
  const bound = await harness.journal.bindTarget({
    stagedAssets: staged.stagedAssets,
    projectionTarget: createTarget(staged.stagedAfterFacts, harness.binding),
  });
  await assert.rejects(
    harness.journal.prepare({ preparedAssets: bound.preparedAssets }),
    TypeError,
  );
  assert.equal(harness.controlStore.events.some((event) => event.type.endsWith('.prepared')), false);
  const pin = harness.parent.mintPin();
  await harness.journal.prepare({ preparedAssets: bound.preparedAssets, parentPinAuthority: pin });
  assert.equal(harness.controlStore.events.at(-1).type, 'manuscript.file_publication.prepared');
  assert.deepEqual(harness.parent.calls, ['reservation', 'reservation', 'pin', 'pin']);
});

test('Task 6 group 4 RED: update/create/delete converge through BEFORE, GAP, and AFTER without controlled-tree tmp files', async () => {
  const harness = createHarness();
  const { bound } = await bindAndPrepare(harness, { closure: mixedClosure() });
  writerCapabilityResolveCount = 0;
  const readsBeforeInspection = harness.writer.calls.filter((call) => call.method === 'read').length;
  const before = await harness.filePublisher.inspect({ manifest: bound.manifest });
  const inspectionReads = harness.writer.calls.filter((call) => call.method === 'read').length
    - readsBeforeInspection;
  assert.equal(before.disposition, 'BEFORE');
  assert.ok(writerCapabilityResolveCount >= inspectionReads);

  const resolvesBeforePublish = writerCapabilityResolveCount;
  const primitiveCallsBeforePublish = harness.writer.calls.length;
  await harness.journal.publishFiles(JOURNAL_ID);
  assert.ok(
    writerCapabilityResolveCount - resolvesBeforePublish
      >= harness.writer.calls.length - primitiveCallsBeforePublish,
  );
  const after = await harness.filePublisher.inspect({ manifest: bound.manifest });
  assert.equal(after.disposition, 'AFTER');
  assert.equal(
    [...harness.writer.files.keys()].some((filePath) => (
      filePath.includes(`${path.sep}mythpen${path.sep}`) && filePath.endsWith('.tmp')
    )),
    false,
  );

  const rolledBack = await harness.filePublisher.rollback({ manifest: bound.manifest });
  assert.equal(rolledBack.disposition, 'BEFORE');
  for (const member of bound.manifest.members) {
    const formal = harness.writer.files.get(member.final.path);
    if (member.before.exists) {
      assert.equal(sha256(formal.bytes), member.before.sha256);
      assert.equal(formal.identity.ino, member.before.fileIdentity.ino);
    } else {
      assert.equal(formal, undefined);
    }
  }
});

test('Task 6 group 4 RED: a crash-shaped first relocate leaves GAP and third-party final occupancy is never overwritten', async () => {
  const harness = createHarness();
  const { bound } = await bindAndPrepare(harness);
  await assert.rejects(
    withFaults({
      [FAULT_POINTS.FILE_PUBLICATION_AFTER_RELOCATE]: { throw: 'EIO' },
    }, () => harness.journal.publishFiles(JOURNAL_ID)),
    { code: 'EIO' },
  );
  assert.equal((await harness.filePublisher.inspect({ manifest: bound.manifest })).disposition, 'GAP');

  const member = bound.manifest.members[0];
  harness.writer.put(member.final.path, Buffer.from('third-party'), member.final.parentIdentity, identity(999));
  await assert.rejects(harness.journal.publishFiles(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });
  assert.equal(harness.writer.files.get(member.final.path).identity.ino, '999');
  assert.equal((await harness.filePublisher.inspect({ manifest: bound.manifest })).disposition, 'OTHER');

  const uncertain = createHarness();
  await bindAndPrepare(uncertain);
  const postEffect = new Error('relocate postcheck failed');
  postEffect.code = 'VERIFIED_SOURCE_MISMATCH';
  postEffect.relocated = true;
  uncertain.writer.setRelocateFailure(postEffect, { afterEffect: true });
  await assert.rejects(
    uncertain.journal.publishFiles(JOURNAL_ID),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.relocated === true,
  );
  uncertain.writer.setRelocateFailure(null);
  await assert.rejects(
    uncertain.journal.publishFiles(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(
    uncertain.controlStore.events.some((event) => event.type.endsWith('files_published')),
    false,
  );

  const topology = createHarness();
  const topologyBound = await bindAndPrepare(topology);
  const topologyError = new Error('topology changed');
  topologyError.code = 'VERIFIED_SOURCE_TOPOLOGY_CHANGED';
  topology.writer.setReadFailure(topologyError);
  assert.equal(
    (await topology.filePublisher.inspect({ manifest: topologyBound.bound.manifest })).disposition,
    'OTHER',
  );
});

test('Task 6 group 4 RED: bounded relocate lock exhaustion maps to MANUSCRIPT_TARGET_LOCKED without mutation', async () => {
  const harness = createHarness();
  const { bound } = await bindAndPrepare(harness);
  const locked = new Error('locked');
  locked.code = 'TARGET_LOCKED';
  harness.writer.setRelocateFailure(locked);
  await assert.rejects(harness.journal.publishFiles(JOURNAL_ID), {
    code: 'MANUSCRIPT_TARGET_LOCKED',
  });
  assert.equal((await harness.filePublisher.inspect({ manifest: bound.manifest })).disposition, 'BEFORE');
  assert.equal(harness.controlStore.events.some((event) => event.type.endsWith('files_published')), false);
});

test('Task 6 group 5 RED: full journal uses exact projection disposition and publishes base at most once', async () => {
  const harness = createHarness();
  await bindAndPrepare(harness);
  await harness.journal.publishFiles(JOURNAL_ID);
  await harness.journal.commitProjection(JOURNAL_ID);
  await harness.journal.complete(JOURNAL_ID);

  assert.equal(harness.projectionCalls.filter((call) => call.method === 'publish').length, 1);
  const stateEvents = harness.controlStore.events
    .filter((event) => event.payload.record_kind !== 'asset_ready')
    .map((event) => event.type.slice('manuscript.file_publication.'.length));
  assert.deepEqual(stateEvents, [
    'assets_reserved',
    'target_reserved',
    'prepared',
    'files_published',
    'projection_committed',
    'completed',
  ]);

  const other = createHarness();
  await bindAndPrepare(other);
  await other.journal.publishFiles(JOURNAL_ID);
  other.dispositions.push('other');
  await assert.rejects(other.journal.commitProjection(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });
  assert.equal(other.projectionCalls.filter((call) => call.method === 'publish').length, 0);

  const prePublicationOther = createHarness();
  await bindAndPrepare(prePublicationOther);
  prePublicationOther.dispositions.push('other');
  await assert.rejects(
    prePublicationOther.journal.recover(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(
    prePublicationOther.writer.calls.filter((call) => call.method === 'relocate').length,
    0,
  );
  assert.equal(
    prePublicationOther.controlStore.events.some((event) => event.type.endsWith('files_published')),
    false,
  );
  assert.equal(
    prePublicationOther.controlStore.events.some((event) => event.type.endsWith('rolled_back')),
    false,
  );

  const prePublicationTarget = createHarness();
  await bindAndPrepare(prePublicationTarget);
  prePublicationTarget.dispositions.push('target');
  await assert.rejects(
    prePublicationTarget.journal.recover(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(
    prePublicationTarget.writer.calls.filter((call) => call.method === 'relocate').length,
    0,
  );
  assert.equal(
    prePublicationTarget.controlStore.events.some((event) => event.type.endsWith('files_published')),
    false,
  );

  const changedFiles = createHarness();
  const changedBound = await bindAndPrepare(changedFiles);
  await changedFiles.journal.publishFiles(JOURNAL_ID);
  const changedMember = changedBound.bound.manifest.members[0];
  changedFiles.writer.files.delete(changedMember.final.path);
  changedFiles.writer.put(
    changedMember.final.path,
    Buffer.from('third-party after publication'),
    changedMember.final.parentIdentity,
    identity(88887),
  );
  changedFiles.dispositions.push('base', 'target');
  await assert.rejects(
    changedFiles.journal.commitProjection(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(changedFiles.projectionCalls.filter((call) => call.method === 'publish').length, 0);
  assert.equal(
    changedFiles.controlStore.events.some((event) => event.type.endsWith('projection_committed')),
    false,
  );
});

test('Task 6 group 5 RED: file-only journal never reaches projection or project store', async () => {
  const harness = createHarness({ parentKind: 'creation' });
  await bindAndPrepare(harness);
  await harness.journal.publishFiles(JOURNAL_ID);
  await assert.rejects(harness.journal.commitProjection(JOURNAL_ID), TypeError);
  assert.equal(harness.projectionCalls.filter((call) => call.method === 'publish').length, 0);
  assert.equal(harness.controlStore.events.some((event) => event.type.endsWith('projection_committed')), false);
});

test('Task 6 group 6 RED: full early rollback and file-only pre-pin rollback use different authority roots', async () => {
  const unsafe = createHarness();
  const unsafeStage = await stageUpdate(unsafe);
  const unsafeMember = unsafeStage.reservationManifest.members[0];
  unsafe.writer.files.delete(unsafeMember.final.path);
  unsafe.writer.put(
    unsafeMember.final.path,
    Buffer.from('third-party'),
    unsafeMember.final.parentIdentity,
    identity(99999),
  );
  await assert.rejects(unsafe.journal.recover(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });
  assert.equal(
    unsafe.controlStore.events.some((event) => event.type.endsWith('rolled_back')),
    false,
  );

  const changedAsset = createHarness();
  const changedStage = await stageUpdate(changedAsset);
  const stagedAfter = changedStage.reservationManifest.assets.find((asset) => (
    asset.assetKind === 'staged_after'
  ));
  changedAsset.writer.files.delete(stagedAfter.path);
  changedAsset.writer.put(
    stagedAfter.path,
    Buffer.from('third-party asset'),
    stagedAfter.parentIdentity,
    identity(99998),
  );
  await assert.rejects(changedAsset.journal.recover(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });
  assert.equal(
    changedAsset.controlStore.events.some((event) => event.type.endsWith('rolled_back')),
    false,
  );

  const full = createHarness();
  await stageUpdate(full);
  assert.deepEqual(await full.journal.recover(JOURNAL_ID), { state: 'rolled_back' });

  const child = createHarness({ parentKind: 'migration' });
  await stageUpdate(child, { parentReservationAuthority: child.parent.mintReservation() });
  await assert.rejects(child.journal.recover(JOURNAL_ID), TypeError);
  const before = child.parent.mintIntent('before');
  assert.deepEqual(
    await child.journal.recover(JOURNAL_ID, { parentRecoveryIntent: before }),
    { state: 'rolled_back' },
  );
});

test('Task 6 group 6 RED: after full pin, target_reserved/prepared/files_published obey only branded parent before or after', async () => {
  const forward = createHarness({ parentKind: 'migration' });
  const reservation = forward.parent.mintReservation();
  const staged = await stageUpdate(forward, { parentReservationAuthority: reservation });
  await forward.journal.bindTarget({
    stagedAssets: staged.stagedAssets,
    projectionTarget: createTarget(staged.stagedAfterFacts, forward.binding),
  });
  await assert.rejects(forward.journal.recover(JOURNAL_ID), TypeError);
  const after = forward.parent.mintIntent('after');
  assert.deepEqual(
    await forward.journal.recover(JOURNAL_ID, { parentRecoveryIntent: after }),
    { state: 'files_published' },
  );
  assert.equal(forward.projectionCalls.filter((call) => call.method === 'publish').length, 0);

  const backward = createHarness({ parentKind: 'creation' });
  await bindAndPrepare(backward);
  await backward.journal.publishFiles(JOURNAL_ID);
  const before = backward.parent.mintIntent('before');
  assert.deepEqual(
    await backward.journal.recover(JOURNAL_ID, { parentRecoveryIntent: before }),
    { state: 'rolled_back' },
  );
  const finalPath = backward.controlStore.events[0].payload.members[0].final.path;
  assert.equal(sha256(backward.writer.files.get(finalPath).bytes), sha256(Buffer.from('before')));

  async function createUncertainReverseRollback() {
    const harness = createHarness({ parentKind: 'creation' });
    const { bound } = await bindAndPrepare(harness);
    await harness.journal.publishFiles(JOURNAL_ID);
    const published = harness.controlStore.events.find((event) => (
      event.type === 'manuscript.file_publication.files_published'
    ));
    const postEffect = new Error('reverse relocate postcheck failed');
    postEffect.code = 'VERIFIED_SOURCE_MISMATCH';
    postEffect.relocated = true;
    harness.writer.setRelocateFailure(postEffect, { afterEffect: true });
    await assert.rejects(
      harness.journal.recover(JOURNAL_ID, {
        parentRecoveryIntent: harness.parent.mintIntent('before'),
      }),
      (error) => error?.code === 'RECOVERY_REQUIRED' && error.relocated === true,
    );
    harness.writer.setRelocateFailure(null);
    return { bound, harness, publication: published.payload.publication };
  }

  const retryRollback = await createUncertainReverseRollback();
  await assert.rejects(
    retryRollback.harness.journal.recover(JOURNAL_ID, {
      parentRecoveryIntent: retryRollback.harness.parent.mintIntent('before'),
    }),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(
    retryRollback.harness.controlStore.events.some((event) => event.type.endsWith('rolled_back')),
    false,
  );

  const coldRollback = await createUncertainReverseRollback();
  const coldPublisher = new FilePublisher({
    writerCapability: coldRollback.harness.writer.mintCapability(),
  });
  await assert.rejects(
    coldPublisher.rollback({
      manifest: coldRollback.bound.manifest,
      publicationReceipt: coldRollback.publication,
    }),
    { code: 'RECOVERY_REQUIRED' },
  );

  const unpublishedRollback = createHarness({ parentKind: 'creation' });
  const unpublishedBound = await bindAndPrepare(unpublishedRollback);
  await unpublishedRollback.filePublisher.publish({ manifest: unpublishedBound.bound.manifest });
  const unpublishedPostEffect = new Error('unpublished reverse relocate postcheck failed');
  unpublishedPostEffect.code = 'VERIFIED_SOURCE_MISMATCH';
  unpublishedPostEffect.relocated = true;
  unpublishedRollback.writer.setRelocateFailure(unpublishedPostEffect, { afterEffect: true });
  await assert.rejects(
    unpublishedRollback.filePublisher.rollback({ manifest: unpublishedBound.bound.manifest }),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.relocated === true,
  );
  unpublishedRollback.writer.setRelocateFailure(null);
  await assert.rejects(
    unpublishedRollback.filePublisher.rollback({ manifest: unpublishedBound.bound.manifest }),
    { code: 'RECOVERY_REQUIRED' },
  );

  const completedWithoutEvent = createHarness({ parentKind: 'creation' });
  const completedWithoutEventBound = await bindAndPrepare(completedWithoutEvent);
  await completedWithoutEvent.filePublisher.publish({
    manifest: completedWithoutEventBound.bound.manifest,
  });
  await completedWithoutEvent.filePublisher.rollback({
    manifest: completedWithoutEventBound.bound.manifest,
  });
  const coldBeforePublisher = new FilePublisher({
    writerCapability: completedWithoutEvent.writer.mintCapability(),
  });
  await assert.rejects(
    coldBeforePublisher.rollback({ manifest: completedWithoutEventBound.bound.manifest }),
    { code: 'RECOVERY_REQUIRED' },
  );

  const restoredWithoutReverse = createHarness({ parentKind: 'creation' });
  const restoredWithoutReverseBound = await bindAndPrepare(restoredWithoutReverse);
  const restoredManifest = restoredWithoutReverseBound.bound.manifest;
  await restoredWithoutReverse.filePublisher.publish({ manifest: restoredManifest });
  const restoredMember = restoredManifest.members[0];
  const afterRecord = restoredWithoutReverse.writer.files.get(restoredMember.final.path);
  const beforeRecord = restoredWithoutReverse.writer.files.get(restoredMember.displaced.path);
  restoredWithoutReverse.writer.files.delete(restoredMember.final.path);
  restoredWithoutReverse.writer.files.delete(restoredMember.displaced.path);
  afterRecord.path = restoredMember.after.asset.path;
  afterRecord.parentIdentity = restoredMember.after.asset.parentIdentity;
  restoredWithoutReverse.writer.files.set(afterRecord.path, afterRecord);
  beforeRecord.path = restoredMember.final.path;
  beforeRecord.parentIdentity = restoredMember.final.parentIdentity;
  restoredWithoutReverse.writer.files.set(beforeRecord.path, beforeRecord);
  await assert.rejects(
    restoredWithoutReverse.filePublisher.rollback({ manifest: restoredManifest }),
    { code: 'RECOVERY_REQUIRED' },
  );

  const successfulSibling = createHarness({ parentKind: 'creation' });
  const successfulSiblingBound = await bindAndPrepare(successfulSibling, {
    closure: createOnlyClosure(successfulSibling.binding),
  });
  const successfulSiblingPublisher = new FilePublisher({
    writerCapability: successfulSibling.writer.capability,
  });
  await successfulSiblingPublisher.publish({ manifest: successfulSiblingBound.bound.manifest });
  await assert.rejects(
    successfulSibling.filePublisher.rollback({ manifest: successfulSiblingBound.bound.manifest }),
    { code: 'RECOVERY_REQUIRED' },
  );
  await successfulSiblingPublisher.rollback({ manifest: successfulSiblingBound.bound.manifest });
  await assert.rejects(
    successfulSibling.filePublisher.rollback({ manifest: successfulSiblingBound.bound.manifest }),
    { code: 'RECOVERY_REQUIRED' },
  );

  const sharedCapability = createHarness({ parentKind: 'creation' });
  const sharedCapabilityBound = await bindAndPrepare(sharedCapability, {
    closure: createOnlyClosure(sharedCapability.binding),
  });
  const siblingPublisher = new FilePublisher({
    writerCapability: sharedCapability.writer.capability,
  });
  await siblingPublisher.publish({ manifest: sharedCapabilityBound.bound.manifest });
  const siblingPostEffect = new Error('sibling reverse relocate postcheck failed');
  siblingPostEffect.code = 'VERIFIED_SOURCE_MISMATCH';
  siblingPostEffect.relocated = true;
  sharedCapability.writer.setRelocateFailure(siblingPostEffect, { afterEffect: true });
  await assert.rejects(
    siblingPublisher.rollback({ manifest: sharedCapabilityBound.bound.manifest }),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.relocated === true,
  );
  sharedCapability.writer.setRelocateFailure(null);
  await assert.rejects(
    sharedCapability.filePublisher.rollback({ manifest: sharedCapabilityBound.bound.manifest }),
    { code: 'RECOVERY_REQUIRED' },
  );
});

test('Task 6 group 7 RED: malformed event chains fail closed and normal publication owns no controlled-tree tmp candidate', async () => {
  const harness = createHarness();
  await stageUpdate(harness);
  const authority = harness.journal.journalAuthority();
  assert.equal(Object.isFrozen(authority), true);
  assert.equal(typeof authority.resolveCandidate, 'undefined');

  const fixture = createManuscriptTreeFixture();
  const candidateName = fixture.controls.addCandidate(fixture.refs.chapterBody, JOURNAL_ID);
  const resolveCandidate = requireJournalAuthorityCapability(authority).methods.resolveCandidate;
  assert.equal(await resolveCandidate({
    actualName: candidateName,
    journalId: JOURNAL_ID,
    projectUid: PROJECT_UID,
    targetRef: fixture.refs.chapterBody,
  }), null);
  const store = new ManuscriptStore({
    dataRoot: fixture.dataRoot,
    fileBoundary: fixture.fileBoundary,
    journalAuthority: authority,
    limits: LIMITS,
  });
  const snapshot = await store.validateFull(fixture.projectBinding, {
    ignoredLedger: fixture.ignoredLedger,
    lifecycleBasis: fixture.lifecycleBasis,
  });
  assert.equal(snapshot.classifications.journalCandidates.length, 0);
  assert.equal(snapshot.classifications.residues.some((entry) => entry.actualName === candidateName), true);

  harness.controlStore.append({
    type: 'manuscript.file_publication.unknown_terminal',
    payload: { journalId: JOURNAL_ID },
  });
  await assert.rejects(harness.journal.recover(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });

  const extra = createHarness();
  await stageUpdate(extra);
  const ready = extra.controlStore.events.find((event) => event.payload.record_kind === 'asset_ready');
  extra.controlStore.append({
    type: ready.type,
    payload: { ...ready.payload, unexpected: true },
  });
  await assert.rejects(extra.journal.recover(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });

  const reservationSeed = createHarness();
  await stageUpdate(reservationSeed);
  const baseReservation = reservationSeed.controlStore.events[0].payload;
  function journalWithForgedReservation(mutate) {
    const payload = clone(baseReservation);
    mutate(payload);
    const forged = createHarness();
    const member = payload.members[0];
    if (member.before.exists) {
      forged.writer.put(
        member.final.path,
        Buffer.from('before'),
        member.final.parentIdentity,
        member.before.fileIdentity,
      );
    }
    forged.controlStore.append({
      type: 'manuscript.file_publication.assets_reserved',
      payload,
    });
    return forged;
  }

  const wrongInputDigest = journalWithForgedReservation((payload) => {
    payload.inputDigest = 'c'.repeat(64);
  });
  await assert.rejects(wrongInputDigest.journal.recover(JOURNAL_ID), {
    code: 'RECOVERY_REQUIRED',
  });

  const evilFinalPath = path.join(path.parse(process.cwd()).root, 'outside-manuscript.md');
  const wrongPath = journalWithForgedReservation((payload) => {
    payload.members[0].final.path = evilFinalPath;
    payload.inputDigest = reservationInputDigest(payload);
  });
  await assert.rejects(wrongPath.journal.recover(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });
  assert.equal(
    wrongPath.writer.calls.some((call) => call.method === 'read' && call.filePath === evilFinalPath),
    false,
  );

  const nestedExtra = journalWithForgedReservation((payload) => {
    payload.members[0].unexpected = true;
    payload.inputDigest = reservationInputDigest(payload);
  });
  await assert.rejects(nestedExtra.journal.recover(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });

  const forgedOrdinaryParent = journalWithForgedReservation((payload) => {
    payload.parent.journalId = PARENT_ID;
    payload.inputDigest = reservationInputDigest(payload);
  });
  await assert.rejects(forgedOrdinaryParent.journal.recover(JOURNAL_ID), {
    code: 'RECOVERY_REQUIRED',
  });

  const forgedRollback = createHarness();
  await stageUpdate(forgedRollback);
  forgedRollback.controlStore.append({
    type: 'manuscript.file_publication.rolled_back',
    payload: {
      version: 1,
      journalId: JOURNAL_ID,
      manifestDigest: 'b'.repeat(64),
    },
  });
  await assert.rejects(
    forgedRollback.journal.recover(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );

  const forgedCollection = createHarness();
  await stageUpdate(forgedCollection);
  await forgedCollection.journal.recover(JOURNAL_ID);
  const rollback = forgedCollection.controlStore.events.at(-1);
  forgedCollection.controlStore.append({
    type: 'manuscript.file_publication.assets_collected',
    payload: {
      version: 1,
      journalId: JOURNAL_ID,
      manifestDigest: rollback.payload.manifestDigest,
      assets: [],
    },
  });
  await assert.rejects(
    forgedCollection.journal.recover(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );

  const forgedPublished = createHarness();
  const forgedBound = await bindAndPrepare(forgedPublished);
  forgedPublished.controlStore.append({
    type: 'manuscript.file_publication.files_published',
    payload: {
      version: 1,
      journalId: JOURNAL_ID,
      manifestDigest: digestPlain(forgedBound.bound.manifest),
      publication: { disposition: 'AFTER' },
    },
  });
  await assert.rejects(
    forgedPublished.journal.recover(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );

  const wrongTarget = createHarness();
  const staged = await stageUpdate(wrongTarget);
  const target = clone(createTarget(staged.stagedAfterFacts, wrongTarget.binding));
  target.projectInstanceId = '88888888-8888-4888-8888-888888888888';
  const targetBytes = Buffer.from(JSON.stringify(target), 'utf8');
  const targetPath = path.join(
    wrongTarget.binding.dataRoot,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
    'file-assets',
    `${JOURNAL_ID}.projection-target.json`,
  );
  const targetReservation = {
    version: 1,
    record_kind: 'reservation',
    journalId: JOURNAL_ID,
    reservationDigest: digestPlain(wrongTarget.controlStore.events[0].payload),
    targetDigest: sha256(targetBytes),
    targetAssetReservation: {
      assetKind: 'projection_target',
      path: targetPath,
      parentIdentity: wrongTarget.binding.recoveryRootIdentity,
      byteSize: targetBytes.length,
      sha256: sha256(targetBytes),
    },
  };
  wrongTarget.controlStore.append({
    type: 'manuscript.file_publication.target_reserved',
    payload: targetReservation,
  });
  const targetFile = wrongTarget.writer.put(
    targetPath,
    targetBytes,
    wrongTarget.binding.recoveryRootIdentity,
    identity(7654),
  );
  const targetAsset = deepFreeze({
    assetKind: 'projection_target',
    path: targetPath,
    parentIdentity: targetFile.parentIdentity,
    fileIdentity: targetFile.identity,
    byteSize: targetBytes.length,
    sha256: sha256(targetBytes),
    fileSynced: true,
    parentSynced: true,
  });
  wrongTarget.controlStore.append({
    type: 'manuscript.file_publication.target_reserved',
    payload: {
      version: 1,
      record_kind: 'asset_ready',
      journalId: JOURNAL_ID,
      targetReservationDigest: digestPlain(targetReservation),
      asset: targetAsset,
    },
  });
  const wrongManifest = deepFreeze({
    ...staged.reservationManifest,
    assets: Object.freeze([...staged.reservationManifest.assets, targetAsset]),
    targetDigest: sha256(targetBytes),
    targetAsset,
  });
  wrongTarget.controlStore.append({
    type: 'manuscript.file_publication.prepared',
    payload: {
      version: 1,
      journalId: JOURNAL_ID,
      manifestDigest: digestPlain(wrongManifest),
      recovery: 'none',
    },
  });
  await assert.rejects(wrongTarget.journal.recover(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });
  assert.equal(
    wrongTarget.writer.calls.filter((call) => call.method === 'relocate').length,
    0,
  );
});

test('Task 6 group 8 RED: exact terminal assets are collected idempotently and third identities are retained', async () => {
  const harness = createHarness();
  const { bound } = await bindAndPrepare(harness);
  await harness.journal.publishFiles(JOURNAL_ID);
  await harness.journal.commitProjection(JOURNAL_ID);
  await harness.journal.complete(JOURNAL_ID);
  const resolvesBeforeCollect = writerCapabilityResolveCount;
  const primitiveCallsBeforeCollect = harness.writer.calls.length;
  assert.deepEqual(await harness.journal.collectAssets(JOURNAL_ID), { state: 'assets_collected' });
  assert.ok(
    writerCapabilityResolveCount - resolvesBeforeCollect
      >= harness.writer.calls.length - primitiveCallsBeforeCollect,
  );
  assert.deepEqual(await harness.journal.collectAssets(JOURNAL_ID), { state: 'assets_collected' });
  assert.equal(bound.manifest.assets.every((asset) => !harness.writer.files.has(asset.path)), true);
  assert.equal(harness.writer.files.has(bound.manifest.members[0].final.path), true);

  const third = createHarness();
  const thirdBound = await bindAndPrepare(third);
  await third.journal.publishFiles(JOURNAL_ID);
  await third.journal.commitProjection(JOURNAL_ID);
  await third.journal.complete(JOURNAL_ID);
  const targetAsset = thirdBound.bound.manifest.targetAsset;
  third.writer.files.delete(targetAsset.path);
  third.writer.put(targetAsset.path, Buffer.from('third identity'), targetAsset.parentIdentity, identity(12345));
  await assert.rejects(third.journal.collectAssets(JOURNAL_ID), { code: 'RECOVERY_REQUIRED' });
  assert.equal(third.writer.files.get(targetAsset.path).identity.ino, '12345');
  assert.equal(third.controlStore.events.some((event) => event.type.endsWith('assets_collected')), false);

  const uncertainDelete = createHarness();
  await bindAndPrepare(uncertainDelete);
  await uncertainDelete.journal.publishFiles(JOURNAL_ID);
  await uncertainDelete.journal.commitProjection(JOURNAL_ID);
  await uncertainDelete.journal.complete(JOURNAL_ID);
  const postDelete = new Error('delete postcheck failed');
  postDelete.code = 'VERIFIED_SOURCE_MISMATCH';
  postDelete.deleted = true;
  uncertainDelete.writer.setDeleteFailure(postDelete, { afterEffect: true });
  await assert.rejects(
    uncertainDelete.journal.collectAssets(JOURNAL_ID),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.deleted === true,
  );
  uncertainDelete.writer.setDeleteFailure(null);
  await assert.rejects(
    uncertainDelete.journal.collectAssets(JOURNAL_ID),
    { code: 'RECOVERY_REQUIRED' },
  );
  assert.equal(
    uncertainDelete.controlStore.events.some((event) => event.type.endsWith('assets_collected')),
    false,
  );
});

test('Task 6 group 8 RED: file-only terminal collection requires branded parent GC authority', async () => {
  const harness = createHarness({ parentKind: 'migration' });
  await bindAndPrepare(harness);
  await harness.journal.publishFiles(JOURNAL_ID);
  await assert.rejects(harness.journal.collectAssets(JOURNAL_ID), TypeError);
  const gc = harness.parent.mintGc();
  assert.deepEqual(
    await harness.journal.collectAssets(JOURNAL_ID, { parentGcAuthority: gc }),
    { state: 'assets_collected' },
  );
});
