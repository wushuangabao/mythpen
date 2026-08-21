'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createManuscriptRuntime } = require('../manuscript/runtime');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const JOURNAL_ID = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);
const CHAPTER_UID = '44444444-4444-4444-8444-444444444444';
const ADMISSION = Object.freeze({
  route: 'files',
  databaseFacts: Object.freeze({
    schemaVersion: 12,
    route: 'files',
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    routeJournal: JOURNAL_ID,
    projectionGeneration: 9,
  }),
  routeFacts: Object.freeze({
    route: 'files',
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    routeJournal: JOURNAL_ID,
    projectionGeneration: 9,
  }),
  activatedProof: Object.freeze({
    kind: 'creation',
    state: 'activated',
    journalId: JOURNAL_ID,
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    targetGeneration: 1,
  }),
});
const WITNESS = Object.freeze({
  expectedDataVersion: 0,
  generation: 9,
  rawSha256: HASH,
  sidecarRawSha256: null,
});

function scene() {
  const calls = { reads: [], writes: [] };
  const runtime = createManuscriptRuntime({
    routeResolver: Object.freeze({ async admit() { return ADMISSION; } }),
    sqlite: Object.freeze({
      async close() {},
      async read() { throw new Error('unexpected sqlite read'); },
      async recover() { throw new Error('unexpected sqlite recover'); },
      async write() { throw new Error('unexpected sqlite write'); },
    }),
    files: Object.freeze({
      async close() {},
      async ignoreInPlace() {},
      async read(admission, request) {
        calls.reads.push({ admission, request });
        return Object.freeze({ baseWitness: WITNESS, value: Object.freeze({ revision: null }) });
      },
      async recover() {},
      async revokeIgnore() {},
      async write(admission, request) {
        calls.writes.push({ admission, request });
        return Object.freeze({ state: 'updated' });
      },
    }),
    creation: Object.freeze({ async create() {} }),
    migration: Object.freeze({ async migrate() {}, async recover() {} }),
  });
  return { calls, runtime };
}

test('runtime admits revision_snapshot and exact revision command families through the files port', async () => {
  const { calls, runtime } = scene();
  const selector = Object.freeze({ projectUid: PROJECT_UID });
  const snapshot = await runtime.read(selector, Object.freeze({
    kind: 'revision_snapshot',
    chapterUid: CHAPTER_UID,
  }));
  assert.deepEqual(snapshot.value, { revision: null });

  const commands = [
    Object.freeze({ kind: 'revision.create', chapterUid: CHAPTER_UID, baseContent: 'base', proposedContent: 'proposal' }),
    Object.freeze({
      kind: 'revision.update_decisions',
      revisionId: 41,
      decisions: Object.freeze({ 'change-0': 'accepted' }),
      expectedBaseContent: 'base',
    }),
    Object.freeze({ kind: 'revision.reject', revisionId: 41, expectedBaseContent: 'base' }),
    Object.freeze({ kind: 'revision.accept', revisionId: 41, expectedBaseContent: 'base' }),
    Object.freeze({
      kind: 'revision.finalize',
      revisionId: 41,
      content: 'materialized',
      expectedBaseContent: 'base',
      expectedDecisions: Object.freeze({ 'change-0': 'accepted' }),
    }),
  ];
  for (let index = 0; index < commands.length; index += 1) {
    await runtime.write(selector, Object.freeze({
      requestId: `revision-${index}`,
      baseWitness: WITNESS,
      command: commands[index],
    }));
  }

  assert.deepEqual(calls.reads[0].request, { kind: 'revision_snapshot', chapterUid: CHAPTER_UID });
  assert.deepEqual(calls.writes.map((entry) => entry.request.command), commands);
  assert.deepEqual(calls.writes.map((entry) => entry.request.witnessCommand), commands);
});

test('revision runtime contracts reject extra fields, accessors, prototypes, and sparse decision data', async () => {
  const { calls, runtime } = scene();
  const selector = Object.freeze({ projectUid: PROJECT_UID });
  const invalidReads = [
    Object.freeze({ kind: 'revision_snapshot', chapterUid: CHAPTER_UID, extra: true }),
    Object.freeze(Object.assign(Object.create({ inherited: true }), { kind: 'revision_snapshot', chapterUid: CHAPTER_UID })),
  ];
  for (const request of invalidReads) {
    await assert.rejects(runtime.read(selector, request), TypeError);
  }

  let getterReads = 0;
  const getterCommand = { kind: 'revision.create', chapterUid: CHAPTER_UID, baseContent: 'base' };
  Object.defineProperty(getterCommand, 'proposedContent', {
    enumerable: true,
    get() { getterReads += 1; return 'proposal'; },
  });
  await assert.rejects(runtime.write(selector, Object.freeze({
    requestId: 'getter',
    baseWitness: WITNESS,
    command: Object.freeze(getterCommand),
  })), TypeError);
  assert.equal(getterReads, 0);

  const sparse = [];
  sparse.length = 1;
  await assert.rejects(runtime.write(selector, Object.freeze({
    requestId: 'sparse',
    baseWitness: WITNESS,
    command: Object.freeze({
      kind: 'revision.update_decisions',
      revisionId: 41,
      decisions: sparse,
      expectedBaseContent: 'base',
    }),
  })), TypeError);
  assert.equal(calls.reads.length, 0);
  assert.equal(calls.writes.length, 0);
});
