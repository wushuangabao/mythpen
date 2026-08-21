'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createProductionDraftConflictStorage,
} = require('../manuscript/production-draft-conflict-storage');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_ID = '44444444-4444-4444-8444-444444444444';
const CHAPTER_UID = '55555555-5555-4555-8555-555555555555';
const BASE_HASH = 'a'.repeat(64);

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

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function createScene(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-production-draft-conflict-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const controlDirectory = path.join(
    root,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
  );
  fs.mkdirSync(controlDirectory, { recursive: true });
  const owner = createProductionDraftConflictStorage({
    controlDirectory,
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
  });
  return { controlDirectory, owner, root };
}

function manifestFor(controlDirectory, draftBytes = Buffer.from('saved draft')) {
  const externalBytes = Buffer.from('external bytes');
  const backupRootPath = path.join(controlDirectory, 'draft-conflict');
  const conflictDirectoryPath = path.join(backupRootPath, CONFLICT_ID);
  const resource = deepFreeze({ kind: 'chapter', uid: CHAPTER_UID, domain: 'body' });
  const fieldMask = deepFreeze(['body']);
  const layout = {
    domain: 'mythpen.draft-conflict.backup-layout',
    version: 1,
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    conflictId: CONFLICT_ID,
    backupRootPath,
    conflictDirectoryPath,
    resource,
    baseGeneration: 7,
    baseRawSha256: BASE_HASH,
    fieldMask,
    files: [
      { name: 'draft.bin', byteSize: draftBytes.length, rawSha256: sha256(draftBytes) },
      { name: 'external.bin', byteSize: externalBytes.length, rawSha256: sha256(externalBytes) },
      { name: 'manifest.json' },
    ],
  };
  return {
    draftBytes,
    externalBytes,
    manifest: deepFreeze({
      domain: 'mythpen.draft-conflict.backup',
      version: 1,
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      conflictId: CONFLICT_ID,
      backupRootPath,
      conflictDirectoryPath,
      resource,
      basis: { baseGeneration: 7, baseRawSha256: BASE_HASH },
      fieldMask,
      draft: { name: 'draft.bin', byteSize: draftBytes.length, rawSha256: sha256(draftBytes) },
      external: {
        name: 'external.bin',
        byteSize: externalBytes.length,
        rawSha256: sha256(externalBytes),
      },
      manifestFileName: 'manifest.json',
      layoutDigest: sha256(Buffer.from(canonicalJson(layout), 'utf8')),
    }),
  };
}

function intentAuthority(manifest) {
  const intents = new WeakMap();
  const authority = Object.freeze({
    assert(intent) {
      if (!intents.has(intent)) throw new TypeError('foreign journal intent');
      return intent;
    },
    describe(intent) {
      const descriptor = intents.get(intent);
      if (descriptor === undefined) throw new TypeError('foreign journal intent');
      return descriptor;
    },
  });
  return {
    authority,
    mint() {
      const intent = Object.freeze({});
      intents.set(intent, deepFreeze({
        kind: 'apply',
        conflictId: manifest.conflictId,
        decisionEpoch: 0,
        childJournalId: CHILD_ID,
        externalRawSha256: manifest.external.rawSha256,
        baseGeneration: manifest.basis.baseGeneration,
        targetGeneration: manifest.basis.baseGeneration + 1,
        resource: manifest.resource,
      }));
      return intent;
    },
  };
}

test('production storage creates a complete durable backup and only an original apply intent reads it', async (t) => {
  const scene = createScene(t);
  const input = manifestFor(scene.controlDirectory);
  const journalStorage = scene.owner.journalStorage();
  const receipt = await journalStorage.create(Object.freeze({
    manifest: input.manifest,
    draftBytes: input.draftBytes,
    externalBytes: input.externalBytes,
  }));
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.directoryFlushed, true);
  assert.equal(receipt.parentFlushed, true);
  assert.deepEqual(receipt.files.map((file) => file.name), [
    'draft.bin', 'external.bin', 'manifest.json',
  ]);
  assert.equal(receipt.files.every((file) => file.flushed && file.readback), true);

  const intents = intentAuthority(input.manifest);
  const reader = scene.owner.bindDraftReader(intents.authority);
  const original = intents.mint();
  assert.equal((await reader.readDraft(original)).toString('utf8'), 'saved draft');
  assert.equal((await scene.owner.readDraftCopy(CONFLICT_ID)).toString('utf8'), 'saved draft');
  await assert.rejects(reader.readDraft(Object.freeze({ ...original })), TypeError);
  await assert.rejects(
    scene.owner.readDraftCopy('not-a-conflict-id'),
    (error) => error?.code === 'MANUSCRIPT_FILESET_INVALID',
  );
  assert.deepEqual(Object.keys(scene.owner), ['bindDraftReader', 'journalStorage', 'readDraftCopy']);
  assert.deepEqual(Object.keys(reader), ['readDraft']);
  assert.doesNotMatch(JSON.stringify(scene.owner), /draft\.bin|external\.bin|[A-Z]:\\/u);
});

test('manifest binding is checked before creating the draft-conflict root', async (t) => {
  const scene = createScene(t);
  const input = manifestFor(scene.controlDirectory);
  const foreign = deepFreeze({
    ...input.manifest,
    projectUid: '66666666-6666-4666-8666-666666666666',
  });
  await assert.rejects(
    scene.owner.journalStorage().create(Object.freeze({
      manifest: foreign,
      draftBytes: input.draftBytes,
      externalBytes: input.externalBytes,
    })),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(path.join(scene.controlDirectory, 'draft-conflict')), false);
});

test('owned partial backup is removable but unexpected contents are retained fail-closed', async (t) => {
  const scene = createScene(t);
  const input = manifestFor(scene.controlDirectory);
  const storage = scene.owner.journalStorage();
  fs.mkdirSync(input.manifest.backupRootPath);
  fs.mkdirSync(input.manifest.conflictDirectoryPath);
  fs.writeFileSync(
    path.join(input.manifest.conflictDirectoryPath, 'draft.bin'),
    input.draftBytes,
  );
  assert.deepEqual(await storage.inspect(Object.freeze({ manifest: input.manifest })), {
    status: 'incomplete',
    conflictId: CONFLICT_ID,
    owned: true,
    externalContents: false,
  });
  assert.deepEqual(await storage.discardIncomplete(Object.freeze({ manifest: input.manifest })), {
    conflictId: CONFLICT_ID,
    removed: true,
  });
  assert.equal(fs.existsSync(input.manifest.conflictDirectoryPath), false);

  fs.mkdirSync(input.manifest.conflictDirectoryPath);
  fs.writeFileSync(path.join(input.manifest.conflictDirectoryPath, 'foreign.bin'), 'foreign');
  assert.deepEqual(await storage.inspect(Object.freeze({ manifest: input.manifest })), {
    status: 'incomplete',
    conflictId: CONFLICT_ID,
    owned: true,
    externalContents: true,
  });
  await assert.rejects(
    storage.discardIncomplete(Object.freeze({ manifest: input.manifest })),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(fs.readFileSync(
    path.join(input.manifest.conflictDirectoryPath, 'foreign.bin'),
    'utf8',
  ), 'foreign');
});

test('constructor and journal intent authority reject accessors and prototype methods without invocation', (t) => {
  const scene = createScene(t);
  let getterCalls = 0;
  const getterOptions = Object.defineProperty({}, 'controlDirectory', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return scene.controlDirectory;
    },
  });
  assert.throws(
    () => createProductionDraftConflictStorage(getterOptions),
    TypeError,
  );
  const inherited = Object.create({
    assert(intent) { return intent; },
    describe() { return Object.freeze({}); },
  });
  assert.throws(() => scene.owner.bindDraftReader(inherited), TypeError);
  assert.equal(getterCalls, 0);
});
