'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const storeModule = require('../manuscript/store');
const { serializeCanonicalJson } = require('../manuscript/format');
const {
  deriveChapterPaths,
  deriveManuscriptPaths,
  deriveVolumePath,
} = require('../manuscript/paths');

const READ_METHODS = Object.freeze({
  enumerateDirectory() {
    return { async *[Symbol.asyncIterator]() {} };
  },
  async inspectDirectory() {},
  inspectPath() {},
  listActualNames() {},
  async probeControlledFile() {},
  async readControlledFile() {},
});

const WRITER_METHODS = Object.freeze({
  createAssetVerified() {},
  deleteVerified() {},
  readVerified() {},
  relocateVerifiedToAbsent() {},
});

const JOURNAL_METHODS = Object.freeze({
  async resolveCandidate() {
    return null;
  },
});

function physicalIdentity(targetPath) {
  const stats = fs.lstatSync(targetPath, { bigint: true });
  return { dev: String(stats.dev), ino: String(stats.ino) };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('manuscript file boundary exposes no generic production mint and isolates test capabilities', () => {
  assert.equal(storeModule.createFileBoundaryCapability, undefined);
  assert.equal(storeModule.createJournalAuthorityCapability, undefined);

  const {
    createTestFileBoundaryCapability,
    createTestFileWriterCapability,
    createTestJournalAuthorityCapability,
  } = require('../testing/manuscript-capability-mint');
  const fileBoundary = createTestFileBoundaryCapability(READ_METHODS);
  const writerCapability = createTestFileWriterCapability(WRITER_METHODS);
  const journalAuthority = createTestJournalAuthorityCapability(JOURNAL_METHODS);

  assert.equal(Object.isFrozen(fileBoundary), true);
  assert.equal(Object.isFrozen(writerCapability), true);
  assert.equal(Object.isFrozen(journalAuthority), true);
  assert.doesNotThrow(() => new storeModule.ManuscriptStore({
    dataRoot: path.resolve(path.parse(process.cwd()).root, 'mythpen-boundary-test'),
    fileBoundary,
    journalAuthority,
  }));
  assert.throws(() => new storeModule.ManuscriptStore({
    dataRoot: path.resolve(path.parse(process.cwd()).root, 'mythpen-boundary-test'),
    fileBoundary: { ...fileBoundary },
    journalAuthority,
  }), TypeError);
});

test('manuscript file boundary production factory is zero-injection and rejects clone foreign swap', () => {
  const {
    assertProductionManuscriptFileBoundaryPair,
    createProductionManuscriptFileBoundary,
  } = require('../platform/manuscript-file-boundary');
  assert.throws(() => createProductionManuscriptFileBoundary({}), TypeError);

  const first = createProductionManuscriptFileBoundary();
  const second = createProductionManuscriptFileBoundary();
  const {
    requireFileBoundaryCapability,
    requireFileWriterCapability,
  } = require('../manuscript/capability-registry');
  assert.strictEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.readCapability), true);
  assert.equal(Object.isFrozen(first.writerCapability), true);
  assert.strictEqual(assertProductionManuscriptFileBoundaryPair(first), first);
  assert.throws(() => requireFileWriterCapability(first.readCapability), TypeError);
  assert.throws(() => requireFileBoundaryCapability(first.writerCapability), TypeError);
  assert.throws(() => requireFileWriterCapability({ ...first.writerCapability }), TypeError);
  assert.throws(
    () => assertProductionManuscriptFileBoundaryPair({ ...first }),
    TypeError,
  );
  assert.throws(
    () => assertProductionManuscriptFileBoundaryPair({
      readCapability: first.writerCapability,
      writerCapability: first.readCapability,
    }),
    TypeError,
  );

  const { createTestFileWriterCapability } = require('../testing/manuscript-capability-mint');
  assert.throws(
    () => assertProductionManuscriptFileBoundaryPair({
      readCapability: first.readCapability,
      writerCapability: createTestFileWriterCapability(WRITER_METHODS),
    }),
    TypeError,
  );
});

test('manuscript file boundary production read capability drives all six Store adapters', async (t) => {
  const projectUid = '71111111-1111-4111-8111-111111111111';
  const volumeUid = '72222222-2222-4222-8222-222222222222';
  const chapterUid = '73333333-3333-4333-8333-333333333333';
  const dataRoot = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-production-boundary-',
  ));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const paths = deriveManuscriptPaths({ dataRoot, projectUid });
  fs.mkdirSync(paths.volumesRoot, { recursive: true });
  fs.mkdirSync(paths.chaptersRoot, { recursive: true });
  fs.writeFileSync(paths.manuscriptPath, serializeCanonicalJson('manuscript', {
    format_version: 1,
    project_uid: projectUid,
    volume_uids: [volumeUid],
  }));
  fs.writeFileSync(paths.unassignedPath, serializeCanonicalJson('unassigned', {
    format_version: 1,
    kind: 'unassigned',
    chapter_uids: [],
  }));
  fs.writeFileSync(deriveVolumePath(paths, volumeUid), serializeCanonicalJson('volume_index', {
    format_version: 1,
    volume_uid: volumeUid,
    title: '真实卷',
    summary: '',
    chapter_uids: [chapterUid],
  }));
  const chapterPaths = deriveChapterPaths(paths, chapterUid);
  fs.writeFileSync(chapterPaths.bodyPath, Buffer.from('真实正文', 'utf8'));
  fs.writeFileSync(chapterPaths.sidecarPath, serializeCanonicalJson('chapter_sidecar', {
    format_version: 1,
    chapter_uid: chapterUid,
    title: '真实章',
    outline: '',
    status: 'pending',
    summary: '',
    cognitive_frame: '',
    emotional_anchor: '',
    world_texture: '',
    concrete_mystery: '',
    interpersonal_tension: '',
  }));

  const {
    createTestJournalAuthorityCapability,
  } = require('../testing/manuscript-capability-mint');
  const {
    createProductionManuscriptFileBoundary,
  } = require('../platform/manuscript-file-boundary');
  const pair = createProductionManuscriptFileBoundary();
  const store = new storeModule.ManuscriptStore({
    dataRoot,
    fileBoundary: pair.readCapability,
    journalAuthority: createTestJournalAuthorityCapability(JOURNAL_METHODS),
  });
  const snapshot = await store.validateFull({
    articleRootIdentity: physicalIdentity(paths.articleRoot),
    projectUid,
  }, {
    ignoredLedger: { entries: [] },
    lifecycleBasis: {
      activeChapterUids: [chapterUid],
      activeVolumeUids: [volumeUid],
      chapterTombstoneUids: [],
      volumeTombstoneUids: [],
    },
  });
  const projection = await store.buildProjectionCandidate(snapshot);

  assert.equal(projection.chapters.length, 1);
  assert.equal(projection.chapters[0].content, '真实正文');
  assert.deepEqual(projection.volumeOrder, [volumeUid]);
});

test('manuscript file boundary enumeration rejects a directory substituted after inspection', (t) => {
  const dataRoot = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-enumerate-aba-',
  ));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const paths = deriveManuscriptPaths({
    dataRoot,
    projectUid: '74444444-4444-4444-8444-444444444444',
  });
  fs.mkdirSync(paths.volumesRoot, { recursive: true });
  fs.mkdirSync(paths.chaptersRoot, { recursive: true });
  const expectedIdentity = physicalIdentity(paths.volumesRoot);
  const displacedPath = path.join(paths.mythpenRoot, 'volumes-old');
  fs.renameSync(paths.volumesRoot, displacedPath);
  fs.mkdirSync(paths.volumesRoot);

  const { createProductionManuscriptFileBoundary } = require('../platform/manuscript-file-boundary');
  const { requireFileBoundaryCapability } = require('../manuscript/capability-registry');
  const reader = requireFileBoundaryCapability(
    createProductionManuscriptFileBoundary().readCapability,
  ).methods;

  assert.throws(
    () => reader.enumerateDirectory({
      directoryRole: 'volumes',
      expectedIdentity,
      paths,
    }),
    { code: 'VERIFIED_SOURCE_TOPOLOGY_CHANGED' },
  );
});

test('manuscript file boundary enumeration pins one directory handle across readdir', (t) => {
  const dataRoot = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-enumerate-pin-',
  ));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const paths = deriveManuscriptPaths({
    dataRoot,
    projectUid: '75555555-5555-4555-8555-555555555555',
  });
  fs.mkdirSync(paths.volumesRoot, { recursive: true });
  fs.mkdirSync(paths.chaptersRoot, { recursive: true });
  fs.writeFileSync(path.join(paths.volumesRoot, 'sentinel.txt'), 'sentinel');
  const movedPath = path.join(paths.mythpenRoot, 'volumes-moved');
  const originalReaddirSync = fs.readdirSync;
  let renameAttempted = false;
  let renameBlocked = false;
  fs.readdirSync = (targetPath, ...args) => {
    if (path.resolve(targetPath) === path.resolve(paths.volumesRoot)) {
      renameAttempted = true;
      try {
        fs.renameSync(paths.volumesRoot, movedPath);
        fs.mkdirSync(paths.volumesRoot);
        fs.writeFileSync(path.join(paths.volumesRoot, 'replacement.txt'), 'replacement');
      } catch (error) {
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
        renameBlocked = true;
      }
    }
    return originalReaddirSync(targetPath, ...args);
  };
  let enumerationError;
  try {
    const { createProductionManuscriptFileBoundary } = require('../platform/manuscript-file-boundary');
    const { requireFileBoundaryCapability } = require('../manuscript/capability-registry');
    const reader = requireFileBoundaryCapability(
      createProductionManuscriptFileBoundary().readCapability,
    ).methods;
    try {
      reader.enumerateDirectory({
        directoryRole: 'volumes',
        expectedIdentity: physicalIdentity(paths.volumesRoot),
        paths,
      });
    } catch (error) {
      enumerationError = error;
    }
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
  assert.equal(renameAttempted, true);
  if (renameBlocked) {
    assert.equal(enumerationError, undefined);
    fs.renameSync(paths.volumesRoot, movedPath);
  } else {
    assert.equal(enumerationError?.code, 'VERIFIED_SOURCE_TOPOLOGY_CHANGED');
  }
});

test('manuscript file boundary createAssetVerified is create-new durable and buffer-isolated', (t) => {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-create-asset-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetPath = path.join(root, 'staged-after.bin');
  const bytes = Buffer.from('frozen staged bytes');
  const original = Buffer.from(bytes);
  const {
    createProductionManuscriptFileBoundary,
  } = require('../platform/manuscript-file-boundary');
  const { requireFileWriterCapability } = require('../manuscript/capability-registry');
  const pair = createProductionManuscriptFileBoundary();
  const writer = requireFileWriterCapability(pair.writerCapability).methods;
  const originalFs = {
    closeSync: fs.closeSync,
    fstatSync: fs.fstatSync,
    fsyncSync: fs.fsyncSync,
    openSync: fs.openSync,
    readSync: fs.readSync,
    writeSync: fs.writeSync,
  };
  const fdCalls = [];
  let openCall;
  let result;
  fs.openSync = (...args) => {
    const fd = originalFs.openSync(...args);
    openCall = { fd, flags: args[1] };
    return fd;
  };
  for (const method of ['closeSync', 'fstatSync', 'fsyncSync', 'readSync', 'writeSync']) {
    fs[method] = (fd, ...args) => {
      fdCalls.push({ fd, method });
      return originalFs[method](fd, ...args);
    };
  }
  try {
    result = writer.createAssetVerified(assetPath, {
      byteSize: bytes.length,
      bytes,
      parentIdentity: physicalIdentity(root),
      sha256: sha256(bytes),
    });
  } finally {
    Object.assign(fs, originalFs);
  }
  bytes.fill(0);

  assert.deepEqual(openCall, {
    fd: openCall.fd,
    flags: fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
  });
  assert.equal(fdCalls.length >= 6, true);
  assert.equal(fdCalls.every(({ fd }) => fd === openCall.fd), true);
  assert.equal(fdCalls.some(({ method }) => method === 'writeSync'), true);
  assert.equal(fdCalls.some(({ method }) => method === 'fsyncSync'), true);
  assert.equal(fdCalls.filter(({ method }) => method === 'fstatSync').length, 2);
  assert.equal(fdCalls.some(({ method }) => method === 'readSync'), true);
  assert.equal(fdCalls.at(-1).method, 'closeSync');
  assert.deepEqual(fs.readFileSync(assetPath), original);
  assert.deepEqual(result, {
    byteSize: original.length,
    fileFsync: true,
    identity: physicalIdentity(assetPath),
    parentFsync: true,
    parentIdentity: physicalIdentity(root),
    sha256: sha256(original),
  });
  assert.equal(Object.isFrozen(result), true);

  assert.throws(
    () => writer.createAssetVerified(assetPath, {
      byteSize: 11,
      bytes: Buffer.from('replacement'),
      parentIdentity: physicalIdentity(root),
      sha256: sha256(Buffer.from('replacement')),
    }),
    { code: 'INSTALL_TARGET_EXISTS' },
  );
  assert.deepEqual(fs.readFileSync(assetPath), original);
});

test('manuscript file boundary relocateVerifiedToAbsent preserves identity and never clobbers', (t) => {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-relocate-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceParent = path.join(root, 'article');
  const targetParent = path.join(root, 'recovery');
  fs.mkdirSync(sourceParent);
  fs.mkdirSync(targetParent);
  const sourcePath = path.join(sourceParent, 'chapter.md');
  const targetPath = path.join(targetParent, 'displaced-before.bin');
  const bytes = Buffer.from('same physical entity');
  fs.writeFileSync(sourcePath, bytes);
  const identity = physicalIdentity(sourcePath);
  const expected = {
    byteSize: bytes.length,
    identity,
    sha256: sha256(bytes),
    sourceParentIdentity: physicalIdentity(sourceParent),
    targetParentIdentity: physicalIdentity(targetParent),
  };
  const {
    createProductionManuscriptFileBoundary,
  } = require('../platform/manuscript-file-boundary');
  const { requireFileWriterCapability } = require('../manuscript/capability-registry');
  const writer = requireFileWriterCapability(
    createProductionManuscriptFileBoundary().writerCapability,
  ).methods;

  fs.writeFileSync(targetPath, 'third-party');
  assert.throws(
    () => writer.relocateVerifiedToAbsent(sourcePath, targetPath, expected),
    { code: 'INSTALL_TARGET_EXISTS' },
  );
  assert.deepEqual(physicalIdentity(sourcePath), identity);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'third-party');
  fs.unlinkSync(targetPath);

  const result = writer.relocateVerifiedToAbsent(sourcePath, targetPath, expected);
  assert.equal(fs.existsSync(sourcePath), false);
  assert.deepEqual(fs.readFileSync(targetPath), bytes);
  assert.deepEqual(physicalIdentity(targetPath), identity);
  assert.deepEqual(result, {
    byteSize: bytes.length,
    identity,
    relocated: true,
    sha256: sha256(bytes),
    sourceParentFsync: true,
    sourceParentIdentity: physicalIdentity(sourceParent),
    targetParentFsync: true,
    targetParentIdentity: physicalIdentity(targetParent),
  });
  assert.equal(Object.isFrozen(result), true);
});

test('manuscript file boundary deleteVerified preserves third state and makes absence idempotent', (t) => {
  const root = fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-delete-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetPath = path.join(root, 'owned-before.bin');
  const evidencePath = path.join(root, 'original-evidence.bin');
  const bytes = Buffer.from('owned asset');
  fs.writeFileSync(assetPath, bytes);
  const identity = physicalIdentity(assetPath);
  const expected = {
    byteSize: bytes.length,
    identity,
    parentIdentity: physicalIdentity(root),
    sha256: sha256(bytes),
  };
  const {
    createProductionManuscriptFileBoundary,
  } = require('../platform/manuscript-file-boundary');
  const { requireFileWriterCapability } = require('../manuscript/capability-registry');
  const writer = requireFileWriterCapability(
    createProductionManuscriptFileBoundary().writerCapability,
  ).methods;

  fs.renameSync(assetPath, evidencePath);
  fs.writeFileSync(assetPath, 'third-party');
  assert.throws(() => writer.deleteVerified(assetPath, expected), {
    code: 'VERIFIED_SOURCE_MISMATCH',
  });
  assert.equal(fs.readFileSync(assetPath, 'utf8'), 'third-party');
  assert.deepEqual(physicalIdentity(evidencePath), identity);
  fs.unlinkSync(assetPath);
  fs.renameSync(evidencePath, assetPath);

  assert.deepEqual(writer.deleteVerified(assetPath, expected), {
    alreadyAbsent: false,
    deleted: true,
    identity,
    parentFsync: true,
    parentIdentity: physicalIdentity(root),
  });
  assert.equal(fs.existsSync(assetPath), false);
  assert.deepEqual(writer.deleteVerified(assetPath, expected), {
    alreadyAbsent: true,
    deleted: false,
    parentFsync: false,
    parentIdentity: physicalIdentity(root),
  });
});
