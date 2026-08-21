'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decodeDraftConflictCommand,
  encodeDraftConflictBackup,
} = require('../manuscript/production-draft-conflict-codec');
const {
  assertControlledFileRef,
  deriveControlledFileRef,
} = require('../manuscript/paths');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const CHAPTER_UID = '22222222-2222-4222-8222-222222222222';
const VOLUME_UID = '33333333-3333-4333-8333-333333333333';
const SECOND_VOLUME_UID = '44444444-4444-4444-8444-444444444444';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function bodyRef() {
  return deriveControlledFileRef({ role: 'chapter_body', projectUid: PROJECT_UID, chapterUid: CHAPTER_UID });
}

function sidecarRef() {
  return deriveControlledFileRef({ role: 'chapter_sidecar', projectUid: PROJECT_UID, chapterUid: CHAPTER_UID });
}

function volumeRef() {
  return deriveControlledFileRef({ role: 'volume_index', projectUid: PROJECT_UID, volumeUid: VOLUME_UID });
}

function witness() {
  return Object.freeze({
    expectedDataVersion: 7,
    generation: 11,
    rawSha256: HASH_A,
    sidecarRawSha256: HASH_B,
  });
}

const cases = [
  {
    command: () => Object.freeze({ kind: 'chapter.replace_body', bodyRef: bodyRef(), content: 'draft body' }),
    resource: { kind: 'chapter', uid: CHAPTER_UID, domain: 'body' },
    fields: ['content'],
  },
  {
    command: () => Object.freeze({
      kind: 'chapter.patch_sidecar',
      sidecarRef: sidecarRef(),
      patch: Object.freeze({ title: 'Draft title', summary: 'Draft summary' }),
    }),
    resource: { kind: 'chapter', uid: CHAPTER_UID, domain: 'sidecar' },
    fields: ['summary', 'title'],
  },
  {
    command: () => Object.freeze({
      kind: 'chapter.replace_body_and_sidecar',
      bodyRef: bodyRef(),
      sidecarRef: sidecarRef(),
      content: 'combined body',
      patch: Object.freeze({ status: 'review' }),
    }),
    resource: { kind: 'chapter', uid: CHAPTER_UID, domain: 'body' },
    fields: ['content', 'status'],
  },
  {
    command: () => Object.freeze({
      kind: 'volume.patch_metadata',
      volumeRef: volumeRef(),
      patch: Object.freeze({ title: 'Volume draft' }),
    }),
    resource: { kind: 'volume', uid: VOLUME_UID, domain: 'volume_metadata' },
    fields: ['title'],
  },
  {
    command: () => Object.freeze({
      kind: 'chapter.move',
      chapterUid: CHAPTER_UID,
      targetVolumeUid: SECOND_VOLUME_UID,
      targetPosition: 2,
    }),
    resource: { kind: 'chapter', uid: CHAPTER_UID, domain: 'structure' },
    fields: ['structure'],
  },
  {
    command: () => Object.freeze({
      kind: 'chapter.reorder',
      containerVolumeUid: VOLUME_UID,
      chapterUids: Object.freeze([CHAPTER_UID]),
    }),
    resource: { kind: 'manuscript', uid: PROJECT_UID, domain: 'structure' },
    fields: ['structure'],
  },
  {
    command: () => Object.freeze({
      kind: 'volume.reorder',
      volumeUids: Object.freeze([VOLUME_UID, SECOND_VOLUME_UID]),
    }),
    resource: { kind: 'manuscript', uid: PROJECT_UID, domain: 'structure' },
    fields: ['structure'],
  },
  {
    command: () => Object.freeze({ kind: 'chapter.delete', chapterUid: CHAPTER_UID }),
    resource: { kind: 'chapter', uid: CHAPTER_UID, domain: 'structure' },
    fields: ['structure'],
  },
  {
    command: () => Object.freeze({ kind: 'volume.delete', volumeUid: VOLUME_UID }),
    resource: { kind: 'volume', uid: VOLUME_UID, domain: 'structure' },
    fields: ['structure'],
  },
];

test('draft conflict codec persists deterministic no-path L2 commands and reconstructs branded refs', () => {
  for (const scene of cases) {
    const command = scene.command();
    const first = encodeDraftConflictBackup(command, witness(), PROJECT_UID);
    const second = encodeDraftConflictBackup(command, witness(), PROJECT_UID);
    assert.equal(first.draftBytes.equals(second.draftBytes), true, command.kind);
    assert.equal(first.externalBytes.equals(second.externalBytes), true, command.kind);
    assert.deepEqual(first.resource, scene.resource, command.kind);
    assert.deepEqual(first.fieldMask, scene.fields, command.kind);
    assert.equal(first.basis.baseGeneration, 11, command.kind);
    assert.equal(first.draftBytes.includes(Buffer.from('Path', 'utf8')), false, command.kind);

    const decoded = decodeDraftConflictCommand(first.draftBytes, PROJECT_UID);
    assert.deepEqual(decoded, command, command.kind);
    for (const key of ['bodyRef', 'sidecarRef', 'volumeRef']) {
      if (Object.hasOwn(decoded, key)) assert.equal(assertControlledFileRef(decoded[key]), decoded[key]);
    }
  }
});

test('draft conflict codec rejects create, revision, foreign ref, and path-bearing payloads', () => {
  assert.throws(
    () => encodeDraftConflictBackup(Object.freeze({
      kind: 'chapter.create',
      containerVolumeUid: VOLUME_UID,
      requestedNum: null,
      content: 'body',
      sidecar: Object.freeze({}),
    }), witness(), PROJECT_UID),
    /unsupported/u,
  );
  assert.throws(
    () => encodeDraftConflictBackup(
      Object.freeze({ kind: 'revision.accept', revisionId: 1 }),
      witness(),
      PROJECT_UID,
    ),
    /unsupported/u,
  );
  const foreignRef = deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: '55555555-5555-4555-8555-555555555555',
    chapterUid: CHAPTER_UID,
  });
  assert.throws(
    () => encodeDraftConflictBackup(Object.freeze({
      kind: 'chapter.replace_body',
      bodyRef: foreignRef,
      content: 'draft',
    }), witness(), PROJECT_UID),
    /project/u,
  );
  const encoded = encodeDraftConflictBackup(cases[0].command(), witness(), PROJECT_UID);
  const payload = JSON.parse(encoded.draftBytes.toString('utf8'));
  payload.absolutePath = 'C:\\Users\\attacker\\draft.md';
  assert.throws(
    () => decodeDraftConflictCommand(Buffer.from(JSON.stringify(payload), 'utf8'), PROJECT_UID),
    /shape/u,
  );
});
