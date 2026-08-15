const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createNativeDbAdapter } = require('../native/native-db-adapter');
const { createManuscriptService } = require('../manuscript-service');
const { openControlStore } = require('../control-store');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function harness({
  transactionAll = () => [{ value: 'tx-all' }],
  transactionGet = () => ({ value: 'tx-get' }),
  transactionRun = () => ({ changes: 1 }),
  validateManuscriptSqlScope = () => true,
} = {}) {
  const trace = [];
  const events = [];
  const activated = {
    digest: sha256('activation'),
    type: 'sqlite.native.activation.activated',
    payload: {
      dbKey: sha256('db'),
      ownershipHash: sha256('owner'),
      projectInstanceIdSha256: sha256('instance'),
    },
  };
  let active = false;
  const nativeStore = {
    connectionEpoch: randomUUID(),
    readAll(sql, ...params) { trace.push(['readAll', sql, params]); return [{ value: 'all' }]; },
    readGet(sql, ...params) { trace.push(['readGet', sql, params]); return { value: 'get' }; },
    executeTransaction(input, callback) {
      trace.push(['executeTransaction', input]);
      active = true;
      try {
        return callback({
          all(sql, ...params) {
            trace.push(['tx.all', sql, params]);
            return transactionAll(sql, params);
          },
          get(sql, ...params) {
            trace.push(['tx.get', sql, params]);
            return transactionGet(sql, params);
          },
          run(sql, ...params) {
            trace.push(['tx.run', sql, params]);
            return transactionRun(sql, params);
          },
        });
      } finally { active = false; }
    },
    close() { trace.push(['close']); },
  };
  const controlStore = {
    read() { return [activated, ...events]; },
    tail() { return events.at(-1) || activated; },
    compareAndAppend(previous, event) {
      assert.equal(previous, this.tail().digest);
      const appended = { ...event, digest: sha256(JSON.stringify(event)), prevDigest: previous };
      events.push(appended);
      trace.push(['source', appended]);
      return appended;
    },
  };
  const coordinator = {
    withProjectRecoveryLeaseSync(_path, callback) { return callback(); },
    withProjectLogicalRequestSync(_path, callback) {
      trace.push(['logical.begin']);
      try { return callback({ assertLease() { return true; } }); }
      finally { trace.push(['logical.end']); }
    },
  };
  const adapter = createNativeDbAdapter({
    controlStore,
    coordinator,
    databasePath: 'C:\\fixture\\project.mythpen.db',
    nativeStore,
    validateManuscriptSqlScope,
  });
  return { active: () => active, adapter, events, trace };
}

test('native adapter preserves prepare all/get/run and one outer transaction', () => {
  const { adapter, trace } = harness();
  assert.deepEqual(adapter.prepare('SELECT value FROM project_meta WHERE key = ?').all('a'), [{ value: 'all' }]);
  assert.deepEqual(adapter.prepare('SELECT value FROM project_meta WHERE key = ?').get('a'), { value: 'get' });
  assert.deepEqual(
    adapter.prepare("INSERT INTO project_meta (key, value) VALUES ('a', ?)").run('b'),
    { changes: 1 },
  );
  const value = adapter.transaction(() => adapter.prepare(
    "INSERT INTO project_meta (key, value) VALUES ('a', ?)",
  ).run('b'))();
  assert.deepEqual(value, { changes: 1 });
  assert.equal(trace.filter(([kind]) => kind === 'logical.begin').length, 2);
  assert.throws(() => adapter.transaction(() => adapter.transaction(() => null)())(),
    (error) => error?.code === 'NESTED_TRANSACTION');
  assert.throws(() => adapter.transaction(() => Promise.resolve())(),
    (error) => error?.code === 'ASYNC_TRANSACTION_CALLBACK');
  assert.equal(adapter.flush(), undefined);
  adapter.close();
});

test('direct chapter-body DML cannot enter a generic transaction through run, all, or get', () => {
  const sql = 'UPDATE chapters SET content = ? WHERE id = ?';
  for (const method of ['run', 'all', 'get']) {
    let databaseMutations = 0;
    const { adapter, events, trace } = harness({
      transactionAll() { databaseMutations += 1; return []; },
      transactionGet() { databaseMutations += 1; return null; },
      transactionRun() { databaseMutations += 1; return { changes: 1 }; },
    });

    assert.throws(
      () => adapter.prepare(sql)[method]('forged body', 7),
      (error) => error?.code === 'MANUSCRIPT_SERVICE_REQUIRED',
      `${method} must reject before generic transaction admission`,
    );
    assert.equal(databaseMutations, 0, `${method} reached the database`);
    assert.deepEqual(events, [], `${method} appended ControlStore evidence`);
    assert.deepEqual(trace, [], `${method} entered a logical or native transaction`);
  }
});

test('native manuscript adapter appends exact source before callback and validates capability in transaction', () => {
  const { adapter, events, trace } = harness();
  const body = 'Native body';
  const intent = Object.freeze({
    bodyBytes: Buffer.byteLength(body), bodySha256: sha256(body), chapterId: 7,
    chapterNumber: null, expectedBodySha256: null, expectedDataVersion: 3,
    operation: 'replace', source: 'rest', targetKind: 'chapter', version: 1, volumeId: null,
  });
  const result = adapter.runManuscriptTransaction('fixture', intent, (projectDb) => {
    const claim = adapter.manuscriptTransactionCapability.claim('fixture', projectDb, {
      chapterId: 7, chapterNumber: null, operation: 'replace', source: 'rest', volumeId: null,
    });
    adapter.manuscriptTransactionCapability.appendSourceEvent('fixture', projectDb, claim, {
      type: 'manuscript.body_mutation.attempt',
      payload: {
        bodyBytes: intent.bodyBytes, bodySha256: intent.bodySha256, chapterId: 7,
        chapterNumber: null, expectedBodySha256: null, expectedDataVersion: 3,
        operation: 'replace', source: 'rest', version: 1, volumeId: null,
      },
    });
    return projectDb.prepare('UPDATE chapters SET content = ? WHERE id = ?').run(body, 7);
  });
  assert.deepEqual(result, { changes: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'manuscript.source');
  assert.equal(trace.findIndex(([kind]) => kind === 'source') < trace.findIndex(([kind]) => kind === 'tx.run'), true);
});

test('REST-shaped replace preserves request identity while using the existing body event target', () => {
  const projectMeta = new Map();
  const chapter = {
    content: 'schema10-before-activation',
    data_version: 4,
    id: 7,
    num: 1,
    volume_id: 1,
    word_count: 26,
  };
  const { adapter } = harness({
    transactionGet(sql) {
      if (/SELECT \* FROM chapters WHERE id/.test(sql)) return { ...chapter };
      if (/SELECT SUM\(word_count\)/.test(sql)) return { total: chapter.word_count };
      throw new Error(`Unexpected get SQL: ${sql}`);
    },
    transactionRun(sql, params) {
      if (/UPDATE chapters SET/.test(sql)) {
        chapter.content = params[0];
        chapter.word_count = params[1];
        chapter.data_version += 1;
        return { changes: 1 };
      }
      const updateMeta = /UPDATE project_meta SET value = \? WHERE key = '([^']+)'/.exec(sql);
      if (updateMeta) {
        if (!projectMeta.has(updateMeta[1])) return { changes: 0 };
        projectMeta.set(updateMeta[1], params[0]);
        return { changes: 1 };
      }
      const insertMeta = /INSERT INTO project_meta \(key, value\) VALUES \('([^']+)', \?\)/.exec(sql);
      if (insertMeta) {
        projectMeta.set(insertMeta[1], params[0]);
        return { changes: 1 };
      }
      throw new Error(`Unexpected run SQL: ${sql}`);
    },
  });
  const { updateProjectWordCount } = require('../db');
  const service = createManuscriptService({
    manuscriptTransactionCapability: adapter.manuscriptTransactionCapability,
    runManuscriptTransaction: adapter.runManuscriptTransaction,
    updateProjectWordCount,
  });

  const result = service.writeChapterBody({
    projectName: 'fixture-e2e',
    identity: { chapterId: 7, chapterNumber: 1, volumeId: null },
    content: 'native-before-restart',
    expectedDataVersion: 4,
    source: 'rest',
  });
  assert.equal(result.content, 'native-before-restart');
  assert.equal(result.dataVersion, 5);
  assert.equal(projectMeta.get('word_count'), String(chapter.word_count));
  assert.match(projectMeta.get('updated_at'), /^\d{4}-\d{2}-\d{2}T/);
});

test('activated schema11 survives startup inspection and cold instance capture', async (t) => {
  const buildInfoPath = require.resolve('../build-info');
  const activationPath = require.resolve('../native/native-activation');
  const authorityPath = require.resolve('../native/native-activation-authority');
  const helperPath = require.resolve('../testing/native-stage-c-activation');
  const controllerPath = require.resolve('../testing/fixture-native-activation-controller');
  const buildInfo = require(buildInfoPath);
  const originalGetBuildInfo = buildInfo.getBuildInfo;
  buildInfo.getBuildInfo = () => Object.freeze({
    nativeActivationMode: 'fixture_only',
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  });
  for (const modulePath of [activationPath, authorityPath, helperPath, controllerPath]) {
    delete require.cache[modulePath];
  }
  t.after(() => {
    buildInfo.getBuildInfo = originalGetBuildInfo;
    for (const modulePath of [activationPath, authorityPath, helperPath, controllerPath]) {
      delete require.cache[modulePath];
    }
  });

  const helper = require(helperPath);
  const fixture = helper.createNativeStageCActivationFixture({
    name: 'cold-native-project',
    sentinel: { id: 'cold', name: 'Cold', background: 'activated' },
  });
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const initial = await helper.activateNativeStageCFixture(fixture);
  const controlStore = openControlStore(fixture.controlDirectory);
  const admission = controlStore.read().findLast((event) => (
    event.type === 'sqlite.native.activation.activated'
  ));
  const logicalRequestDigest = sha256('cold-native-committed-request');
  const source = controlStore.compareAndAppend(controlStore.tail().digest, {
    type: 'manuscript.source',
    payload: {
      version: 1,
      eventId: randomUUID(),
      dbKey: admission.payload.dbKey,
      projectInstanceIdSha256: admission.payload.projectInstanceIdSha256,
      createdAt: new Date().toISOString(),
      ownershipHash: admission.payload.ownershipHash,
      connectionEpoch: initial.connectionEpoch,
      logicalRequestDigest,
      attemptSeq: 1,
      previousAttemptSourceDigest: null,
      operationKind: 'chapter_body_write',
      targetKind: 'chapter',
      targetIdSha256: sha256('cold-native-target'),
      expectedDataVersion: null,
    },
  });
  initial.executeTransaction({
    sourceDigest: source.digest,
    operationKind: 'chapter_body_write',
    logicalRequestDigest,
    attemptSeq: 1,
  }, (transaction) => transaction.run(
    'UPDATE characters SET background = ? WHERE id = ?',
    'committed-before-restart',
    fixture.sentinel.id,
  ));
  initial.close();

  const controller = require(controllerPath).createFixtureNativeActivationController({
    receipt: null,
    root: fixture.root,
  });
  const db = require('../db');
  db.configureStorage({ dataDir: fixture.root });
  db.installFixtureNativeActivationController(controller);
  await db.initDatabase();
  t.after(() => {
    try { db.closeAllDatabases(); } catch {}
  });
  db.getConfigDb().prepare(
    'INSERT INTO recent_projects (id, name, file_path) VALUES (?, ?, ?)',
  ).run(randomUUID(), fixture.name, fixture.databasePath);
  db.getConfigDb().flush();

  db.getProjectDb(fixture.name);
  db.closeProjectDb(fixture.databasePath);
  const states = db.inspectProjectDatabasesAtStartup();
  const state = db.getProjectOpenState(fixture.databasePath);
  assert.equal(states.get(path.normalize(fixture.databasePath))?.openState ?? state?.openState, 'ready',
    JSON.stringify(state));
  const expectedInstanceId = db.getProjectDb(fixture.name)
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get().value;
  db.closeProjectDb(fixture.databasePath);
  assert.equal(db.captureProjectInstance(fixture.name, expectedInstanceId), expectedInstanceId);
});
