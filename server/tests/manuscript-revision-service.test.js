'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createManuscriptService } = require('../manuscript-service');
const { createRevisionService } = require('../manuscript/revision-service');
const CHAPTER_UID = '44444444-4444-4444-8444-444444444444';

function revisionServiceScene() {
  const calls = [];
  const publications = [];
  const revisionService = createRevisionService({
    auxiliaryStore: Object.freeze({
      apply(input) {
        calls.push(input);
        return Object.freeze({
          disposition: 'after',
          generation: 4,
          state: 'created',
          revision: Object.freeze({ id: 9, chapterId: 3, status: 'pending' }),
        });
      },
    }),
    resolutionPublisher: Object.freeze({
      publish(command, turnContext) {
        publications.push({ command, turnContext });
        return Object.freeze({ state: 'accepted', revision: Object.freeze({ id: 9 }) });
      },
    }),
  });
  const l2Authority = Object.freeze({
    assert(intent) { return intent; },
    describe() { return Object.freeze({ family: 'non_create', logicalInputDigest: null }); },
  });
  const owner = createManuscriptService(Object.freeze({}), Object.freeze({
    l2Service: Object.freeze({
      bindWriteIntent() { return Object.freeze({}); },
      execute() { throw new Error('unexpected L2 execution'); },
      writeIntentAuthority() { return l2Authority; },
    }),
    orphanResolutionService: Object.freeze({
      snapshotRequest() { return Object.freeze({}); },
      preflightResolution() { throw new Error('unexpected orphan preflight'); },
      publishResolution() { throw new Error('unexpected orphan publish'); },
    }),
    revisionService,
  }));
  return { calls, publications, owner };
}

test('product broker binds module-authentic revision intents and executes them in the original turn', async () => {
  const { calls, owner } = revisionServiceScene();
  const command = Object.freeze({
    kind: 'revision.create',
    chapterUid: CHAPTER_UID,
    baseContent: 'base',
    proposedContent: 'proposal',
  });
  const intent = owner.bindProductRevisionCommand(command);
  const authority = owner.productWriteIntentAuthority();
  assert.equal(Reflect.apply(authority.assert, authority, [intent]), intent);
  assert.deepEqual(Reflect.apply(authority.describe, authority, [intent]), {
    family: 'non_create',
    logicalInputDigest: null,
  });
  assert.throws(
    () => Reflect.apply(authority.assert, authority, [Object.freeze({})]),
    (error) => error instanceof TypeError && /foreign|stale/u.test(error.message),
  );

  const turnContext = Object.freeze({
    journalId: '11111111-1111-4111-8111-111111111111',
    logicalRequestId: 'revision-create',
    projectedAt: '2026-08-20T00:00:00.000Z',
    currentProjection: Object.freeze({ projectUid: 'project' }),
    fileSnapshot: Object.freeze({ snapshot: true }),
    ignoredLedger: Object.freeze([]),
  });
  const result = await owner.executeProductWriteIntent(intent, turnContext);
  assert.equal(result.state, 'created');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].currentProjection, turnContext.currentProjection);
  assert.equal(calls[0].logicalRequestId, 'revision-create');
  assert.deepEqual(calls[0].action, command);
});

test('accept and finalize remain branded revision intents and delegate one same-turn L2 resolution', async () => {
  const { calls, publications, owner } = revisionServiceScene();
  const turnContext = Object.freeze({
    journalId: '11111111-1111-4111-8111-111111111111',
    logicalRequestId: 'revision-resolution',
    projectedAt: '2026-08-20T00:00:00.000Z',
    currentProjection: Object.freeze({ projectUid: 'project' }),
    fileSnapshot: Object.freeze({ snapshot: true }),
    ignoredLedger: Object.freeze([]),
  });
  for (const command of [
    Object.freeze({ kind: 'revision.accept', revisionId: 9, expectedBaseContent: 'base' }),
    Object.freeze({
      kind: 'revision.finalize',
      revisionId: 9,
      content: 'materialized',
      expectedBaseContent: 'base',
      expectedDecisions: Object.freeze({ 'change-0': 'accepted' }),
    }),
  ]) {
    const intent = owner.bindProductRevisionCommand(command);
    const result = await owner.executeProductWriteIntent(intent, turnContext);
    assert.equal(result.state, 'accepted');
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(publications.map((entry) => entry.command.kind), [
    'revision.accept',
    'revision.finalize',
  ]);
  assert.equal(publications.every((entry) => entry.turnContext === turnContext), true);
});
