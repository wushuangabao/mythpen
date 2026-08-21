'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { DraftConflictJournal } = require('../manuscript/draft-conflict-journal');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_CONFLICT_ID = '44444444-4444-4444-8444-444444444444';
const CHAPTER_UID = '55555555-5555-4555-8555-555555555555';
const CHILD_ID = '66666666-6666-4666-8666-666666666666';
const BASE_DIGEST = 'a'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function backupLayoutDigest(controlDirectory, detected) {
  const backupRootPath = path.join(controlDirectory, 'draft-conflict');
  return sha256(Buffer.from(canonicalJson({
    domain: 'mythpen.draft-conflict.backup-layout',
    version: 1,
    projectUid: detected.projectUid,
    projectInstanceId: detected.projectInstanceId,
    conflictId: detected.conflictId,
    backupRootPath,
    conflictDirectoryPath: path.join(backupRootPath, detected.conflictId),
    resource: detected.resource,
    baseGeneration: detected.baseGeneration,
    baseRawSha256: detected.baseRawSha256,
    fieldMask: detected.fieldMask,
    files: [
      {
        name: 'draft.bin',
        byteSize: detected.draftByteSize,
        rawSha256: detected.draftRawSha256,
      },
      {
        name: 'external.bin',
        byteSize: detected.externalByteSize,
        rawSha256: detected.externalRawSha256,
      },
      { name: 'manifest.json' },
    ],
  }), 'utf8'));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null
    || typeof value !== 'object'
    || Buffer.isBuffer(value)
    || Object.isFrozen(value)
  ) return value;
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function identity(seed) {
  return Object.freeze({ dev: '1', ino: String(seed) });
}

function receiptFor(manifest) {
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const directoryIdentity = identity(10);
  return deepFreeze({
    status: 'complete',
    projectUid: manifest.projectUid,
    projectInstanceId: manifest.projectInstanceId,
    conflictId: manifest.conflictId,
    layoutDigest: manifest.layoutDigest,
    directoryPath: manifest.conflictDirectoryPath,
    directoryIdentity,
    parentPath: manifest.backupRootPath,
    parentIdentity: identity(9),
    directoryFlushed: true,
    parentFlushed: true,
    files: [
      {
        name: 'draft.bin',
        byteSize: manifest.draft.byteSize,
        rawSha256: manifest.draft.rawSha256,
        fileIdentity: identity(11),
        parentIdentity: directoryIdentity,
        flushed: true,
        readback: true,
      },
      {
        name: 'external.bin',
        byteSize: manifest.external.byteSize,
        rawSha256: manifest.external.rawSha256,
        fileIdentity: identity(12),
        parentIdentity: directoryIdentity,
        flushed: true,
        readback: true,
      },
      {
        name: 'manifest.json',
        byteSize: manifestBytes.length,
        rawSha256: sha256(manifestBytes),
        fileIdentity: identity(13),
        parentIdentity: directoryIdentity,
        flushed: true,
        readback: true,
      },
    ],
  });
}

function memoryControlStore(options = {}) {
  const dataRoot = options.dataRoot || path.resolve('draft-conflict-test-data');
  const directory = options.directory || path.join(
    dataRoot,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
  );
  const incarnationId = options.incarnationId || 'control-incarnation-1';
  const events = [];
  return {
    directory,
    incarnationId,
    readCalls: 0,
    appendCalls: 0,
    read() {
      this.readCalls += 1;
      return events.slice();
    },
    tail() {
      return events.at(-1) || null;
    },
    compareAndAppend(expectedDigest, input) {
      this.appendCalls += 1;
      assert.equal(expectedDigest, events.at(-1)?.digest ?? null);
      const eventWithoutDigest = {
        seq: events.length + 1,
        type: input.type,
        payload: input.payload,
        prevDigest: events.at(-1)?.digest ?? null,
      };
      const event = deepFreeze({
        ...eventWithoutDigest,
        digest: sha256(Buffer.from(canonicalJson(eventWithoutDigest), 'utf8')),
      });
      events.push(event);
      return Object.freeze({ seq: event.seq, digest: event.digest });
    },
    inject(type, payload) {
      this.compareAndAppend(events.at(-1)?.digest ?? null, { type, payload });
    },
    rewritePayload(index, payload) {
      assert(index >= 0 && index < events.length);
      events[index] = { ...events[index], payload: deepFreeze(payload) };
      for (let cursor = index; cursor < events.length; cursor += 1) {
        const eventWithoutDigest = {
          seq: events[cursor].seq,
          type: events[cursor].type,
          payload: events[cursor].payload,
          prevDigest: cursor === 0 ? null : events[cursor - 1].digest,
        };
        events[cursor] = deepFreeze({
          ...eventWithoutDigest,
          digest: sha256(Buffer.from(canonicalJson(eventWithoutDigest), 'utf8')),
        });
      }
    },
  };
}

function createPorts() {
  const backups = new Map();
  const childEvidence = new WeakMap();
  const projectionEvidence = new WeakMap();
  const calls = { create: 0, inspect: 0, discard: 0 };
  let nextCreateReceipt;
  let nextInspectResult;
  let createError;
  let receiptMutator;
  let childRecovery = 'before';
  let projectionRecovery = 'after';

  function mint(records, disposition) {
    const evidence = Object.freeze({});
    records.set(evidence, disposition);
    return evidence;
  }

  const backupStorage = {
    async create(input) {
      calls.create += 1;
      if (createError) throw createError;
      assert.equal(input.draftBytes.toString('utf8'), 'local draft');
      assert.match(input.externalBytes.toString('utf8'), /^external byte(?:s|z)$/u);
      let receipt = nextCreateReceipt || receiptFor(input.manifest);
      nextCreateReceipt = undefined;
      if (receiptMutator) {
        receipt = JSON.parse(JSON.stringify(receipt));
        receiptMutator(receipt);
        receipt = deepFreeze(receipt);
      }
      backups.set(input.manifest.conflictId, { manifest: input.manifest, receipt });
      return receipt;
    },
    async inspect(input) {
      calls.inspect += 1;
      if (nextInspectResult !== undefined) {
        const result = nextInspectResult;
        nextInspectResult = undefined;
        return result;
      }
      return backups.get(input.manifest.conflictId)?.receipt || deepFreeze({
        status: 'incomplete',
        conflictId: input.manifest.conflictId,
        owned: true,
        externalContents: false,
      });
    },
    async discardIncomplete(input) {
      calls.discard += 1;
      backups.delete(input.manifest.conflictId);
      return deepFreeze({ conflictId: input.manifest.conflictId, removed: true });
    },
  };
  const childDisposition = {
    async inspect() {
      return mint(childEvidence, childRecovery);
    },
    classify(evidence) {
      return childEvidence.get(evidence) || 'unknown';
    },
  };
  const projectionDisposition = {
    async inspect() {
      return mint(projectionEvidence, projectionRecovery);
    },
    classify(evidence) {
      return projectionEvidence.get(evidence) || 'unknown';
    },
  };
  return {
    backupStorage,
    childDisposition,
    projectionDisposition,
    calls,
    backups,
    mintChild: (disposition) => mint(childEvidence, disposition),
    mintProjection: (disposition) => mint(projectionEvidence, disposition),
    setCreateReceipt: (receipt) => { nextCreateReceipt = receipt; },
    setCreateError: (error) => { createError = error; },
    setReceiptMutator: (mutator) => { receiptMutator = mutator; },
    setInspectResult: (result) => { nextInspectResult = result; },
    setChildRecovery: (value) => { childRecovery = value; },
    setProjectionRecovery: (value) => { projectionRecovery = value; },
  };
}

function createScene(options = {}) {
  const dataRoot = options.dataRoot || path.resolve('draft-conflict-test-data');
  const controlStore = options.controlStore || memoryControlStore({ dataRoot });
  const ports = options.ports || createPorts();
  const ids = options.ids || [CONFLICT_ID];
  let uuidCalls = 0;
  let clockCalls = 0;
  const times = options.times || [1_700_000_000_000];
  const journal = new DraftConflictJournal({
    controlStore,
    projectBinding: deepFreeze({
      dataRoot,
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      controlIncarnationId: 'control-incarnation-1',
    }),
    backupStorage: ports.backupStorage,
    childDisposition: ports.childDisposition,
    projectionDisposition: ports.projectionDisposition,
    uuidV4() {
      const value = ids[uuidCalls];
      uuidCalls += 1;
      return value;
    },
    clock() {
      const value = times[Math.min(clockCalls, times.length - 1)];
      clockCalls += 1;
      return value;
    },
  });
  return {
    journal,
    controlStore,
    ports,
    uuidCalls: () => uuidCalls,
    clockCalls: () => clockCalls,
  };
}

function createInput(overrides = {}) {
  return {
    resource: deepFreeze({ kind: 'chapter', uid: CHAPTER_UID, domain: 'body' }),
    basis: deepFreeze({ baseGeneration: 7, baseRawSha256: BASE_DIGEST }),
    draftBytes: Buffer.from('local draft'),
    externalBytes: Buffer.from('external bytes'),
    fieldMask: deepFreeze(['content']),
    supersedes: null,
    ...overrides,
  };
}

async function readyScene(options = {}) {
  const scene = createScene(options);
  const created = await scene.journal.createConflict(createInput());
  assert.deepEqual(created, {
    conflictId: CONFLICT_ID,
    state: 'decision_ready',
    decisionEpoch: 0,
  });
  return scene;
}

test('DraftConflictJournal binds exact project/control authority before any side effect', () => {
  const dataRoot = path.resolve('draft-conflict-test-data');
  for (const controlStore of [
    memoryControlStore({ dataRoot, directory: path.join(dataRoot, 'wrong') }),
    memoryControlStore({ dataRoot, incarnationId: 'wrong-incarnation' }),
  ]) {
    const ports = createPorts();
    assert.throws(
      () => createScene({ dataRoot, controlStore, ports }),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
    assert.equal(controlStore.readCalls, 0);
    assert.equal(controlStore.appendCalls, 0);
    assert.deepEqual(ports.calls, { create: 0, inspect: 0, discard: 0 });
  }
});

test('createConflict persists ownership before one complete fixed-layout backup and returns ready', async () => {
  const scene = createScene();
  const result = await scene.journal.createConflict(createInput());

  assert.deepEqual(result, {
    conflictId: CONFLICT_ID,
    state: 'decision_ready',
    decisionEpoch: 0,
  });
  assert.equal(scene.uuidCalls(), 1);
  assert.equal(scene.clockCalls(), 1);
  assert.equal(scene.ports.calls.create, 1);
  assert.deepEqual(
    scene.controlStore.read().map((event) => event.type),
    [
      'draft_conflict.conflict_detected',
      'draft_conflict.backup_durable',
      'draft_conflict.decision_ready',
    ],
  );
  const detected = scene.controlStore.read()[0].payload;
  assert.equal(detected.version, 1);
  assert.equal(detected.projectUid, PROJECT_UID);
  assert.equal(detected.projectInstanceId, PROJECT_INSTANCE_ID);
  assert.equal(detected.conflictId, CONFLICT_ID);
  assert.equal(detected.baseRawSha256, BASE_DIGEST);
  assert.equal(detected.draftRawSha256, sha256(Buffer.from('local draft')));
  assert.equal(detected.externalRawSha256, sha256(Buffer.from('external bytes')));
  assert.deepEqual(detected.fieldMask, ['content']);
  assert.equal(canonicalJson(detected).includes('local draft'), false);
  assert.equal(Object.isFrozen(detected), true);
  assert.equal(Object.isFrozen(detected.resource), true);
});

test('createConflict never returns ready for incomplete checksum, identity, parent or flush receipts', async () => {
  for (const mutate of [
    (receipt) => { receipt.files[0].rawSha256 = 'f'.repeat(64); },
    (receipt) => { delete receipt.files[0].fileIdentity; },
    (receipt) => { receipt.files[0].parentIdentity = identity(99); },
    (receipt) => { receipt.directoryFlushed = false; },
    (receipt) => { receipt.parentFlushed = false; },
    (receipt) => { receipt.files[1].readback = false; },
  ]) {
    const ports = createPorts();
    ports.setReceiptMutator(mutate);
    const scene = createScene({ ports });
    await assert.rejects(
      scene.journal.createConflict(createInput()),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
    assert.deepEqual(
      scene.controlStore.read().map((event) => event.type),
      ['draft_conflict.conflict_detected'],
    );
  }
});

test('accept transition requires journal-owned intent and constructor-bound after evidence', async () => {
  const scene = await readyScene();
  const intent = await scene.journal.beginAccept({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    acceptedRawSha256: sha256(Buffer.from('external bytes')),
    baseGeneration: 7,
    targetGeneration: 8,
  });
  await assert.rejects(
    scene.journal.recordAcceptResolved(Object.freeze({}), scene.ports.mintProjection('after')),
    (error) => error.code === 'RECOVERY_REQUIRED',
  );
  await assert.rejects(
    scene.journal.recordAcceptResolved(intent, Object.freeze({})),
    (error) => error.code === 'RECOVERY_REQUIRED',
  );
  const resolved = await scene.journal.recordAcceptResolved(
    intent,
    scene.ports.mintProjection('after'),
  );
  assert.equal(resolved.state, 'resolved_accept_external');
  assert.equal((await scene.journal.archive({ conflictId: CONFLICT_ID })).state, 'archived');
  await assert.rejects(
    scene.journal.recordAcceptResolved(intent, scene.ports.mintProjection('after')),
    (error) => error.code === 'PROJECTION_STALE',
  );
});

test('apply transition resolves after or aborts before and permanently advances epoch', async () => {
  const scene = await readyScene();
  const intent = await scene.journal.beginApply({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    childJournalId: CHILD_ID,
    externalRawSha256: sha256(Buffer.from('external bytes')),
    baseGeneration: 7,
    targetGeneration: 8,
  });
  const aborted = await scene.journal.recordApplyAborted(intent, scene.ports.mintChild('before'));
  assert.deepEqual(aborted, {
    conflictId: CONFLICT_ID,
    state: 'decision_ready',
    decisionEpoch: 1,
  });
  await assert.rejects(
    scene.journal.beginApply({
      conflictId: CONFLICT_ID,
      decisionEpoch: 0,
      childJournalId: CHILD_ID,
      externalRawSha256: sha256(Buffer.from('external bytes')),
      baseGeneration: 7,
      targetGeneration: 8,
    }),
    (error) => error.code === 'PROJECTION_STALE',
  );
  const secondIntent = await scene.journal.beginApply({
    conflictId: CONFLICT_ID,
    decisionEpoch: 1,
    childJournalId: '77777777-7777-4777-8777-777777777777',
    externalRawSha256: sha256(Buffer.from('external bytes')),
    baseGeneration: 7,
    targetGeneration: 8,
  });
  const resolved = await scene.journal.recordApplyResolved(
    secondIntent,
    scene.ports.mintChild('after'),
  );
  assert.equal(resolved.state, 'resolved_apply_draft');
});

test('unknown, duplicate and cross-event drift fail closed without a new append', async () => {
  for (const inject of [
    (store) => store.rewritePayload(0, {
      ...store.read()[0].payload,
      decisionEpoch: 1,
    }),
    (store) => store.inject('draft_conflict.unknown', { version: 1 }),
    (store) => store.inject('draft_conflict.conflict_detected', store.read()[0].payload),
    (store) => store.inject('draft_conflict.decision_ready', {
      ...store.read().at(-1).payload,
      projectInstanceId: '88888888-8888-4888-8888-888888888888',
    }),
  ]) {
    const scene = await readyScene();
    inject(scene.controlStore);
    const before = scene.controlStore.appendCalls;
    assert.throws(
      () => scene.journal.readConflict(CONFLICT_ID),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
    assert.equal(scene.controlStore.appendCalls, before);
  }
});

test('cold recover validates backup, resumes durable/ready, and classifies apply/accept evidence', async () => {
  const ports = createPorts();
  ports.setCreateError(new Error('crash after detected'));
  const detected = createScene({ ports });
  await assert.rejects(
    detected.journal.createConflict(createInput()),
    (error) => error.code === 'RECOVERY_REQUIRED',
  );
  detected.ports.setInspectResult(deepFreeze({
    status: 'incomplete',
    conflictId: CONFLICT_ID,
    owned: true,
    externalContents: false,
  }));
  assert.deepEqual(await detected.journal.recover(CONFLICT_ID), {
    conflictId: CONFLICT_ID,
    state: 'conflict_detected',
    cleanup: 'removed',
  });
  assert.equal(detected.ports.calls.discard, 1);

  const accept = await readyScene();
  await accept.journal.beginAccept({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    acceptedRawSha256: sha256(Buffer.from('external bytes')),
    baseGeneration: 7,
    targetGeneration: 8,
  });
  accept.ports.setProjectionRecovery('after');
  assert.equal((await accept.journal.recover(CONFLICT_ID)).state, 'resolved_accept_external');

  const applyBefore = await readyScene();
  await applyBefore.journal.beginApply({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    childJournalId: CHILD_ID,
    externalRawSha256: sha256(Buffer.from('external bytes')),
    baseGeneration: 7,
    targetGeneration: 8,
  });
  applyBefore.ports.setChildRecovery('before');
  assert.equal((await applyBefore.journal.recover(CONFLICT_ID)).decisionEpoch, 1);

  const applyAfter = await readyScene();
  await applyAfter.journal.beginApply({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    childJournalId: CHILD_ID,
    externalRawSha256: sha256(Buffer.from('external bytes')),
    baseGeneration: 7,
    targetGeneration: 8,
  });
  applyAfter.ports.setChildRecovery('after');
  assert.equal((await applyAfter.journal.recover(CONFLICT_ID)).state, 'resolved_apply_draft');
  await applyAfter.journal.archive({ conflictId: CONFLICT_ID });
  const inspectCalls = applyAfter.ports.calls.inspect;
  assert.equal((await applyAfter.journal.recover(CONFLICT_ID)).state, 'archived');
  assert.equal(applyAfter.ports.calls.inspect, inspectCalls);

  const applyOther = await readyScene();
  await applyOther.journal.beginApply({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    childJournalId: CHILD_ID,
    externalRawSha256: sha256(Buffer.from('external bytes')),
    baseGeneration: 7,
    targetGeneration: 8,
  });
  applyOther.ports.setChildRecovery('other');
  await assert.rejects(
    applyOther.journal.recover(CONFLICT_ID),
    (error) => error.code === 'RECOVERY_REQUIRED',
  );
});

test('superseded is terminal, retains backup, and records the successor chain', async () => {
  const scene = createScene({ ids: [CONFLICT_ID, SECOND_CONFLICT_ID] });
  await scene.journal.createConflict(createInput());
  await scene.journal.createConflict(createInput({
    externalBytes: Buffer.from('external bytez'),
    supersedes: CONFLICT_ID,
  }));
  const superseded = await scene.journal.supersede({
    conflictId: CONFLICT_ID,
    decisionEpoch: 0,
    successorConflictId: SECOND_CONFLICT_ID,
    projectionBeforeEvidence: null,
  });
  assert.equal(superseded.state, 'superseded');
  assert.equal(scene.ports.backups.has(CONFLICT_ID), true);
  await assert.rejects(
    scene.journal.beginAccept({
      conflictId: CONFLICT_ID,
      decisionEpoch: 0,
      acceptedRawSha256: sha256(Buffer.from('external bytes')),
      baseGeneration: 7,
      targetGeneration: 8,
    }),
    (error) => error.code === 'PROJECTION_STALE',
  );
});

test('supersedes rejects an unchanged external hash and a detected-only successor', async () => {
  {
    const scene = createScene({ ids: [CONFLICT_ID, SECOND_CONFLICT_ID] });
    await scene.journal.createConflict(createInput());
    await assert.rejects(
      scene.journal.createConflict(createInput({ supersedes: CONFLICT_ID })),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
  }

  {
    const scene = createScene({ ids: [CONFLICT_ID, SECOND_CONFLICT_ID] });
    await scene.journal.createConflict(createInput());
    await scene.journal.createConflict(createInput({
      externalBytes: Buffer.from('external bytez'),
      supersedes: CONFLICT_ID,
    }));
    const predecessor = scene.controlStore.read()[0].payload;
    const successor = scene.controlStore.read()[3].payload;
    const alteredSuccessor = {
      ...successor,
      externalRawSha256: predecessor.externalRawSha256,
      externalByteSize: predecessor.externalByteSize,
    };
    alteredSuccessor.backupLayoutDigest = backupLayoutDigest(
      scene.controlStore.directory,
      alteredSuccessor,
    );
    scene.controlStore.rewritePayload(3, alteredSuccessor);
    scene.controlStore.rewritePayload(4, {
      ...scene.controlStore.read()[4].payload,
      backupLayoutDigest: alteredSuccessor.backupLayoutDigest,
    });
    assert.throws(
      () => scene.journal.readConflict(SECOND_CONFLICT_ID),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
  }

  {
    const ports = createPorts();
    const scene = createScene({ ports, ids: [CONFLICT_ID, SECOND_CONFLICT_ID] });
    await scene.journal.createConflict(createInput());
    ports.setCreateError(new Error('crash after detected successor'));
    await assert.rejects(
      scene.journal.createConflict(createInput({
        externalBytes: Buffer.from('external bytez'),
        supersedes: CONFLICT_ID,
      })),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
    await assert.rejects(
      scene.journal.supersede({
        conflictId: CONFLICT_ID,
        decisionEpoch: 0,
        successorConflictId: SECOND_CONFLICT_ID,
        projectionBeforeEvidence: null,
      }),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
    const predecessor = scene.controlStore.read()[0].payload;
    scene.controlStore.inject('draft_conflict.superseded', deepFreeze({
      version: 1,
      projectUid: predecessor.projectUid,
      projectInstanceId: predecessor.projectInstanceId,
      conflictId: predecessor.conflictId,
      resource: predecessor.resource,
      decisionEpoch: 0,
      successorConflictId: SECOND_CONFLICT_ID,
    }));
    assert.throws(
      () => scene.journal.readConflict(CONFLICT_ID),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
  }

  {
    const ports = createPorts();
    const scene = createScene({ ports, ids: [CONFLICT_ID, SECOND_CONFLICT_ID] });
    await scene.journal.createConflict(createInput());
    await scene.journal.beginAccept({
      conflictId: CONFLICT_ID,
      decisionEpoch: 0,
      acceptedRawSha256: sha256(Buffer.from('external bytes')),
      baseGeneration: 7,
      targetGeneration: 8,
    });
    ports.setCreateError(new Error('crash after detected successor'));
    await assert.rejects(
      scene.journal.createConflict(createInput({
        externalBytes: Buffer.from('external bytez'),
        supersedes: CONFLICT_ID,
      })),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
    ports.setProjectionRecovery('before_changed');
    await assert.rejects(
      scene.journal.recover(CONFLICT_ID),
      (error) => error.code === 'RECOVERY_REQUIRED',
    );
  }
});

test('listGcDebt samples one clock and keeps recent 20 or 30 days, whichever is wider', async () => {
  const now = 2_000_000_000_000;
  const ids = Array.from({ length: 22 }, (_value, index) => (
    `${String(index + 1).padStart(8, '0')}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  ));
  const scene = createScene({
    ids,
    times: ids.map((_id, index) => now - ((61 - index) * DAY)).concat(now),
  });
  for (let index = 0; index < ids.length; index += 1) {
    const created = await scene.journal.createConflict(createInput({ supersedes: null }));
    const intent = await scene.journal.beginAccept({
      conflictId: created.conflictId,
      decisionEpoch: 0,
      acceptedRawSha256: sha256(Buffer.from('external bytes')),
      baseGeneration: 7,
      targetGeneration: 8,
    });
    await scene.journal.recordAcceptResolved(intent, scene.ports.mintProjection('after'));
    await scene.journal.archive({ conflictId: created.conflictId });
  }
  const beforeClock = scene.clockCalls();
  const debt = scene.journal.listGcDebt();
  assert.equal(scene.clockCalls(), beforeClock + 1);
  assert.equal(debt.length, 2);
  assert.deepEqual(debt.map((item) => item.conflictId), ids.slice(0, 2));
  assert.equal(scene.ports.backups.size, 22);
});
