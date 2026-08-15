const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  publishGeneratedProjectFile,
  publishOpaqueDiagnosticsExport,
} = require('../project-export');

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('generated exports publish only while their starting project incarnation is current', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-project-export-'));
  const finalPath = path.join(tempDir, 'novel.epub');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.writeFileSync(finalPath, 'replacement-project-export');
  let currentInstance = 'old-instance';
  const generationStarted = deferred();
  const finishGeneration = deferred();
  const staleError = Object.assign(new Error('project was replaced'), {
    code: 'PROJECT_INSTANCE_MISMATCH',
  });

  const stalePublication = publishGeneratedProjectFile({
    finalPath,
    createId: () => 'stale-task',
    generate: async (tempPath) => {
      fs.writeFileSync(tempPath, 'old-instance-export');
      generationStarted.resolve();
      await finishGeneration.promise;
    },
    assertCurrent: () => {
      if (currentInstance !== 'old-instance') throw staleError;
    },
  });

  await generationStarted.promise;
  currentInstance = 'replacement-instance';
  finishGeneration.resolve();
  await assert.rejects(stalePublication, (error) => error === staleError);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'replacement-project-export');
  assert.equal(fs.existsSync(path.join(tempDir, '.novel.epub.stale-task.tmp')), false);

  await publishGeneratedProjectFile({
    finalPath,
    createId: () => 'current-task',
    generate: async (tempPath) => fs.writeFileSync(tempPath, 'current-instance-export'),
    assertCurrent: () => assert.equal(currentInstance, 'replacement-instance'),
  });
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'current-instance-export');
  assert.equal(fs.existsSync(path.join(tempDir, '.novel.epub.current-task.tmp')), false);
});

test('concurrent callers capture their own bytes before the shared artifact can be replaced', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-concurrent-export-'));
  const finalPath = path.join(tempDir, 'novel.epub');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const finishFirst = deferred();
  const finishSecond = deferred();

  const first = publishGeneratedProjectFile({
    finalPath,
    createId: () => 'first',
    generate: async (tempPath) => {
      fs.writeFileSync(tempPath, 'first-snapshot');
      await finishFirst.promise;
    },
    assertCurrent: () => {},
    capturePublished: publishedPath => fs.readFileSync(publishedPath, 'utf8'),
  });
  const second = publishGeneratedProjectFile({
    finalPath,
    createId: () => 'second',
    generate: async (tempPath) => {
      fs.writeFileSync(tempPath, 'second-snapshot');
      await finishSecond.promise;
    },
    assertCurrent: () => {},
    capturePublished: publishedPath => fs.readFileSync(publishedPath, 'utf8'),
  });

  finishFirst.resolve();
  finishSecond.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first-snapshot', 'second-snapshot']);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'second-snapshot');
});

const FINAL_UUID = '11111111-1111-4111-8111-111111111111';
const TEMP_UUID = '22222222-2222-4222-8222-222222222222';

function diagnosticsManifestInput() {
  return {
    state: 'isolated',
    reasonCode: 'RECOVERY_REQUIRED',
    protocol: 'sqljs-publication-v1',
    backend: 'sqljs-v1',
    schema: 10,
    triggerVersion: null,
    expectedTriggerSetDigest: null,
    projectMetaTriggerSetDigest: null,
    observedTriggerSetDigest: null,
    dbIdentity: null,
    expectedIdentity: null,
    projectInstanceIdSha256: '1'.repeat(64),
    currentSeq: null,
    expectedSeq: null,
    controlStore: { tail: null, checkpoint: null, events: [] },
    integrity: { integrityCheck: 'ok', foreignKeyCheck: 'ok' },
    platformCapabilities: {
      backend: 'win32',
      exclusiveLease: true,
      directoryFsync: true,
      atomicReplace: true,
      verifiedAbsentInstall: true,
    },
    canAutoRecover: false,
    canAdoptIdentity: false,
    recommendedAction: null,
    snapshot: '2'.repeat(64),
  };
}

function recordingFs(operations, overrides = {}) {
  return {
    mkdirSync(target, options) {
      operations.push(['mkdir', target, options]);
      return fs.mkdirSync(target, options);
    },
    openSync(target, flags, mode) {
      operations.push(['open', target, flags, mode]);
      return fs.openSync(target, flags, mode);
    },
    writeFileSync(descriptor, value, encoding) {
      operations.push(['write', encoding]);
      return fs.writeFileSync(descriptor, value, encoding);
    },
    fsyncSync(descriptor) {
      operations.push(['file-fsync']);
      return fs.fsyncSync(descriptor);
    },
    closeSync(descriptor) {
      operations.push(['close']);
      return fs.closeSync(descriptor);
    },
    linkSync(source, target) {
      operations.push(['link', source, target]);
      return fs.linkSync(source, target);
    },
    unlinkSync(target) {
      operations.push(['unlink', target]);
      return fs.unlinkSync(target);
    },
    ...overrides,
  };
}

function fixedIds() {
  const ids = [FINAL_UUID, TEMP_UUID];
  return () => ids.shift();
}

test('opaque diagnostics export uses exclusive durable no-clobber publication order', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-opaque-export-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exportDir = path.join(root, 'exports');
  const operations = [];
  const result = publishOpaqueDiagnosticsExport({
    exportDir,
    diagnostics: diagnosticsManifestInput(),
    currentDatabaseSha256: 'a'.repeat(64),
    fsApi: recordingFs(operations),
    createId: fixedIds(),
    fsyncDirectoryApi(directory) {
      operations.push(['directory-fsync', directory]);
    },
  });

  assert.deepEqual(result, {
    filename: `${FINAL_UUID}.mythpen-diagnostics.json`,
  });
  const open = operations.find(([operation]) => operation === 'open');
  assert.equal(open[2], 'wx');
  assert.equal(open[3], 0o600);
  assert.deepEqual(
    operations.map(([operation]) => operation),
    ['mkdir', 'open', 'write', 'file-fsync', 'close', 'link', 'unlink', 'directory-fsync'],
  );
  assert.equal(path.dirname(open[1]), exportDir);
  const link = operations.find(([operation]) => operation === 'link');
  assert.equal(path.dirname(link[1]), exportDir);
  assert.equal(path.dirname(link[2]), exportDir);
  assert.equal(fs.existsSync(link[1]), false);
  const manifest = JSON.parse(fs.readFileSync(link[2], 'utf8'));
  assert.deepEqual(Object.keys(manifest), [
    'format',
    'formatVersion',
    'diagnostics',
    'currentDatabaseSha256',
  ]);
  assert.deepEqual(manifest.diagnostics, diagnosticsManifestInput());
});

test('opaque diagnostics export independently projects every nested whitelist', (t) => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-opaque-whitelist-'));
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const expected = diagnosticsManifestInput();
  expected.dbIdentity = { dev: '5', ino: '6' };
  expected.expectedIdentity = { dev: '5', ino: '6' };
  expected.controlStore = {
    tail: { seq: 8, digest: '8'.repeat(64) },
    checkpoint: { seq: 7, digest: '7'.repeat(64) },
    events: [{
      seq: 8,
      type: 'sqlite.publish.prepared',
      digest: '8'.repeat(64),
      prevDigest: '7'.repeat(64),
    }],
  };
  const diagnostics = {
    ...expected,
    path: 'C:\\Users\\writer\\private-project.db',
    chapterBody: 'SECRET CHAPTER BODY',
    originalInstanceId: 'raw-instance-secret',
    futureField: { rawPayload: 'future-secret' },
    dbIdentity: { ...expected.dbIdentity, path: 'C:\\private\\identity' },
    expectedIdentity: { ...expected.expectedIdentity, originalInstanceId: 'raw-id' },
    controlStore: {
      ...expected.controlStore,
      rawPayload: { chapterBody: 'control-secret' },
      tail: { ...expected.controlStore.tail, path: 'C:\\private\\tail' },
      checkpoint: {
        ...expected.controlStore.checkpoint,
        rawPayload: 'checkpoint-secret',
      },
      events: [{
        ...expected.controlStore.events[0],
        path: 'C:\\private\\event',
        payload: { chapterBody: 'event-secret' },
        rawPayload: 'raw-event-secret',
      }],
    },
    integrity: {
      ...expected.integrity,
      databaseBytes: 'raw-database-secret',
      futureCheck: 'future-secret',
    },
    platformCapabilities: {
      ...expected.platformCapabilities,
      path: 'C:\\private\\capability',
      futureCapability: 'future-secret',
    },
  };

  const result = publishOpaqueDiagnosticsExport({
    exportDir,
    diagnostics,
    currentDatabaseSha256: 'a'.repeat(64),
    createId: fixedIds(),
    fsyncDirectoryApi() {},
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(exportDir, result.filename), 'utf8'),
  );

  assert.deepEqual(manifest.diagnostics, expected);
  assert.deepEqual(Object.keys(manifest.diagnostics), Object.keys(expected));
  assert.deepEqual(Object.keys(manifest.diagnostics.dbIdentity), ['dev', 'ino']);
  assert.deepEqual(Object.keys(manifest.diagnostics.expectedIdentity), ['dev', 'ino']);
  assert.deepEqual(Object.keys(manifest.diagnostics.controlStore), [
    'tail',
    'checkpoint',
    'events',
  ]);
  assert.deepEqual(Object.keys(manifest.diagnostics.controlStore.tail), ['seq', 'digest']);
  assert.deepEqual(Object.keys(manifest.diagnostics.controlStore.checkpoint), ['seq', 'digest']);
  assert.deepEqual(Object.keys(manifest.diagnostics.controlStore.events[0]), [
    'seq',
    'type',
    'digest',
    'prevDigest',
  ]);
  assert.deepEqual(Object.keys(manifest.diagnostics.integrity), [
    'integrityCheck',
    'foreignKeyCheck',
  ]);
  assert.deepEqual(Object.keys(manifest.diagnostics.platformCapabilities), [
    'backend',
    'exclusiveLease',
    'directoryFsync',
    'atomicReplace',
    'verifiedAbsentInstall',
  ]);
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /private|secret|chapter body|rawPayload|originalInstanceId|futureField|futureCapability/i,
  );
});

test('opaque diagnostics export never overwrites a colliding final and cleans its temp', (t) => {
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-opaque-collision-'));
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const finalPath = path.join(exportDir, `${FINAL_UUID}.mythpen-diagnostics.json`);
  fs.writeFileSync(finalPath, 'existing diagnostics');

  assert.throws(() => publishOpaqueDiagnosticsExport({
    exportDir,
    diagnostics: diagnosticsManifestInput(),
    currentDatabaseSha256: 'a'.repeat(64),
    createId: fixedIds(),
    fsyncDirectoryApi() {},
  }), (error) => error?.code === 'EEXIST');

  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'existing diagnostics');
  assert.deepEqual(fs.readdirSync(exportDir), [path.basename(finalPath)]);
});

test('opaque diagnostics export cleans pre-publication failures but preserves a linked final after directory fsync fails', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-opaque-faults-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const failedBeforePublishDir = path.join(root, 'before');
  const operations = [];
  const failingFs = recordingFs(operations, {
    fsyncSync() {
      operations.push(['file-fsync']);
      const error = new Error('file fsync failed');
      error.code = 'EIO';
      throw error;
    },
  });
  assert.throws(() => publishOpaqueDiagnosticsExport({
    exportDir: failedBeforePublishDir,
    diagnostics: diagnosticsManifestInput(),
    currentDatabaseSha256: 'a'.repeat(64),
    fsApi: failingFs,
    createId: fixedIds(),
    fsyncDirectoryApi() {},
  }), /file fsync failed/);
  assert.deepEqual(fs.readdirSync(failedBeforePublishDir), []);
  assert.equal(operations.some(([operation]) => operation === 'close'), true);

  const failedAfterPublishDir = path.join(root, 'after');
  const directoryFailure = new Error('private directory fsync failure');
  assert.throws(() => publishOpaqueDiagnosticsExport({
    exportDir: failedAfterPublishDir,
    diagnostics: diagnosticsManifestInput(),
    currentDatabaseSha256: 'b'.repeat(64),
    createId: fixedIds(),
    fsyncDirectoryApi() {
      throw directoryFailure;
    },
  }), (error) => error === directoryFailure);
  const finalPath = path.join(
    failedAfterPublishDir,
    `${FINAL_UUID}.mythpen-diagnostics.json`,
  );
  assert.equal(fs.existsSync(finalPath), true);
  assert.deepEqual(fs.readdirSync(failedAfterPublishDir), [path.basename(finalPath)]);
});
