const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Database } = require('bun:sqlite');

const {
  createNativeProjectStore,
  createNativeProjectStoreCore,
} = require('../native/native-project-store');
const { classifyNativeSql } = require('../native/native-sql-authorization');
const { createDatabaseIdentityGuard } = require('../native/database-identity-guard');
const { canonicalTriggerDefinitions } = require('../native/durability-schema');
const { createStageBFixtureStore } = require('../testing/native-stage-b-store');
const { createNativeStageBFixture } = require('../testing/native-stage-b-fixture');
const { openControlStore } = require('../control-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');

function nativeFixture(t, name) {
  const fixture = createNativeStageBFixture({ name });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  return fixture;
}

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function commonNativePayload(fixture, connectionEpoch) {
  const [genesis] = openControlStore(fixture.controlDirectory).read();
  return {
    version: 1,
    eventId: randomUUID(),
    dbKey: genesis.payload.dbKey,
    projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
    createdAt: new Date().toISOString(),
    ownershipHash: genesis.payload.ownershipHash,
    connectionEpoch,
  };
}

function sourcePayload(fixture, connectionEpoch, overrides = {}) {
  return {
    ...commonNativePayload(fixture, connectionEpoch),
    logicalRequestDigest: sha256(`request:${fixture.fixtureRunId}`),
    attemptSeq: 1,
    previousAttemptSourceDigest: null,
    operationKind: 'chapter_body_write',
    targetKind: 'chapter',
    targetIdSha256: sha256('chapter:one'),
    expectedDataVersion: null,
    ...overrides,
  };
}

function appendSource(fixture, store, overrides = {}) {
  const controlStore = openControlStore(fixture.controlDirectory);
  const tail = controlStore.tail();
  controlStore.compareAndAppend(tail.digest, {
    type: 'manuscript.source',
    payload: sourcePayload(fixture, store.connectionEpoch, overrides),
  });
  return controlStore.tail();
}

function callerOwnedAbandonedPayload(source, reasonCode, overrides = {}) {
  return {
    version: 1,
    eventId: randomUUID(),
    dbKey: source.payload.dbKey,
    projectInstanceIdSha256: source.payload.projectInstanceIdSha256,
    createdAt: new Date().toISOString(),
    ownershipHash: source.payload.ownershipHash,
    connectionEpoch: source.payload.connectionEpoch,
    sourceDigest: source.digest,
    reasonCode,
    ...overrides,
  };
}

function appendCallerOwnedAbandoned({ controlStore, source, reasonCode }) {
  assert.ok(['cancelled', 'superseded'].includes(reasonCode));
  const appended = controlStore.compareAndAppend(source.digest, {
    type: 'manuscript.source.abandoned',
    payload: callerOwnedAbandonedPayload(source, reasonCode),
  });
  const tail = controlStore.tail();
  assert.equal(tail.digest, appended.digest);
  assert.equal(tail.type, 'manuscript.source.abandoned');
  assert.equal(tail.payload.sourceDigest, source.digest);
  assert.equal(tail.payload.reasonCode, reasonCode);
  assert.equal(tail.payload.connectionEpoch, source.payload.connectionEpoch);
  return tail;
}

function appendAbandoned(fixture, store, source, reasonCode = 'cancelled') {
  const controlStore = openControlStore(fixture.controlDirectory);
  return appendCallerOwnedAbandoned({
    controlStore,
    source,
    reasonCode,
  });
}

function exactExecuteInput(source) {
  return {
    sourceDigest: source.digest,
    operationKind: source.payload.operationKind,
    logicalRequestDigest: source.payload.logicalRequestDigest,
    attemptSeq: source.payload.attemptSeq,
  };
}

function exactPreparedPayload(fixture, connectionEpoch, source, overrides = {}) {
  const [genesis] = openControlStore(fixture.controlDirectory).read();
  return {
    ...commonNativePayload(fixture, connectionEpoch),
    transactionId: randomUUID(),
    sourceDigest: source.digest,
    beforeSeq: 0,
    expectedFinalSeq: 1,
    schemaVersion: 11,
    backend: 'native-sqlite-v2',
    expectedGateEmpty: true,
    expectedTriggerVersion: 1,
    expectedTriggerSetDigest: genesis.payload.triggerSetDigest,
    expectedIdentity: genesis.payload.identity,
    operationKind: source.payload.operationKind,
    ...overrides,
  };
}

function exactTerminalPayload(fixture, connectionEpoch, prepared, terminalKind) {
  const [genesis] = openControlStore(fixture.controlDirectory).read();
  if (terminalKind === 'committed') {
    return {
      ...commonNativePayload(fixture, connectionEpoch),
      preparedDigest: prepared.digest,
      finalSeq: prepared.payload.expectedFinalSeq,
      schemaVersion: 11,
      backend: 'native-sqlite-v2',
      gateEmpty: true,
      triggerVersion: 1,
      triggerSetDigest: genesis.payload.triggerSetDigest,
      postCommitIdentity: genesis.payload.identity,
    };
  }
  const shapes = {
    begin_not_acquired: {
      reasonCode: 'sqlite_busy',
      predicate: {
        autocommit: true,
        writeLockAcquired: false,
        gateSqlExecuted: false,
        businessSqlExecuted: false,
        seqSqlExecuted: false,
      },
    },
    transaction_rolled_back: {
      reasonCode: 'transaction_failed',
      predicate: { autocommit: true, rollbackCompleted: true },
    },
    recovery_before_commit: {
      reasonCode: 'crash_recovery',
      predicate: { autocommit: true, hotJournalRecovered: true },
    },
  };
  const shape = shapes[terminalKind];
  return {
    ...commonNativePayload(fixture, connectionEpoch),
    preparedDigest: prepared.digest,
    beforeSeq: prepared.payload.beforeSeq,
    reasonCode: shape.reasonCode,
    rollbackKind: terminalKind,
    predicate: {
      ...shape.predicate,
      schemaVersion: 11,
      backend: 'native-sqlite-v2',
      finalSeq: prepared.payload.beforeSeq,
      gateEmpty: true,
      triggerVersion: 1,
      triggerSetDigest: genesis.payload.triggerSetDigest,
      identity: genesis.payload.identity,
    },
  };
}

function syntheticEvent(seq, type, payload, digest, prevDigest) {
  return { seq, type, digest, prevDigest, payload };
}

function createCoreFixtureStore(fixture, dependencies = {}) {
  const controlStore = dependencies.controlStore || openControlStore(fixture.controlDirectory);
  const [genesis] = controlStore.read();
  const coreFactory = dependencies.coreFactory || createNativeProjectStoreCore;
  return coreFactory({
    databasePath: fixture.databasePath,
    controlStore,
    dbKey: genesis.payload.dbKey,
    projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
    ownershipHash: genesis.payload.ownershipHash,
    assertWriterLease: dependencies.assertWriterLease || (() => true),
    admissionVerifier: ({ evidence }) => {
      if (evidence.length !== 1 || evidence[0].digest !== genesis.digest) {
        throw Object.assign(new Error('fixture genesis changed'), { code: 'NATIVE_ADMISSION_REJECTED' });
      }
      return { basisKind: 'stage_b_fixture_genesis', basisDigest: genesis.digest };
    },
    identityApi: dependencies.identityApi,
    sqliteFactory: dependencies.sqliteFactory,
  });
}

function loadNativeProjectStoreCoreWithUuidObserver(observer) {
  const crypto = require('node:crypto');
  const modulePath = require.resolve('../native/native-project-store');
  const cachedModule = require.cache[modulePath];
  const originalRandomUUID = crypto.randomUUID;
  crypto.randomUUID = (...args) => {
    const value = originalRandomUUID(...args);
    observer(Object.freeze({
      value,
      stack: new Error('observed randomUUID').stack,
    }));
    return value;
  };
  delete require.cache[modulePath];
  try {
    return require(modulePath).createNativeProjectStoreCore;
  } finally {
    crypto.randomUUID = originalRandomUUID;
    delete require.cache[modulePath];
    if (cachedModule) require.cache[modulePath] = cachedModule;
  }
}

function tracingSqliteFactory(fixture, trace, state = {}) {
  return (databasePath) => {
    const raw = new Database(databasePath, { create: false, strict: true });
    const statements = new Set();
    state.raw = raw;
    return {
      get inTransaction() {
        return raw.inTransaction;
      },
      query(sql) {
        if (state.capture) trace.push(`query:${sql}`);
        const statement = raw.query(sql);
        statements.add(statement);
        return {
          all(...params) {
            if (state.capture) trace.push(`all:${sql}`);
            return statement.all(...params);
          },
          get(...params) {
            if (state.capture) trace.push(`get:${sql}`);
            return statement.get(...params);
          },
          run(...params) {
            if (state.capture) trace.push(`run:${sql}`);
            return statement.run(...params);
          },
        };
      },
      exec(sql) {
        if (state.capture) {
          if (sql === 'BEGIN IMMEDIATE') {
            trace.push(`begin-tail:${openControlStore(fixture.controlDirectory).tail().type}`);
          }
          trace.push(`exec:${sql}`);
        }
        return raw.exec(sql);
      },
      close() {
        for (const statement of statements) statement.finalize();
        return raw.close(true);
      },
    };
  };
}

test('native Stage B exports only guarded core and testing entry points', () => {
  assert.equal(typeof createNativeProjectStore, 'function');
  assert.equal(typeof createNativeProjectStoreCore, 'function');
  assert.equal(typeof classifyNativeSql, 'function');
  assert.equal(typeof createStageBFixtureStore, 'function');
});

test('SQL classifier admits only single-statement business reads and DML shapes', () => {
  assert.deepEqual(classifyNativeSql('SELECT key, value FROM project_meta WHERE key = ?'), {
    kind: 'business_read',
    operation: 'SELECT',
  });
  assert.deepEqual(classifyNativeSql('INSERT INTO chapters (id, title) VALUES (?, ?)'), {
    kind: 'business_dml',
    operation: 'INSERT',
  });
  assert.deepEqual(classifyNativeSql('UPDATE chapters SET title = ? WHERE id = ?'), {
    kind: 'business_dml',
    operation: 'UPDATE',
  });
  assert.deepEqual(classifyNativeSql('DELETE FROM chapters WHERE id = ?;'), {
    kind: 'business_dml',
    operation: 'DELETE',
  });
});

test('SQL classifier fails closed for internal, structural, and ambiguous SQL', () => {
  for (const sql of [
    '',
    'SELECT 1; SELECT 2',
    'ATTACH DATABASE ? AS other',
    'DETACH DATABASE other',
    'BEGIN EXCLUSIVE',
    'COMMIT',
    'ROLLBACK',
    'SAVEPOINT nested',
    'RELEASE nested',
    'PRAGMA foreign_keys',
    'PRAGMA foreign_keys = OFF',
    'VACUUM',
    'CREATE TABLE surprise (id INTEGER)',
    'CREATE TRIGGER _mythpen_downgrade_guard__chapters__insert BEFORE INSERT ON chapters BEGIN SELECT 1; END',
    'DROP TRIGGER _mythpen_downgrade_guard__chapters__insert',
    'SELECT * FROM _durability_write_gate',
    'SELECT * FROM sqlite_schema',
    'INSERT INTO _durability_write_gate (gate_id) VALUES (1)',
    "INSERT INTO project_meta (key, value) VALUES ('schema_version', '99')",
    "UPDATE project_meta SET value = '99' WHERE key = 'durability_commit_seq'",
    "DELETE FROM project_meta WHERE key = 'project_instance_id'",
    'SELECT /* unterminated',
    'SELECT 1\0',
  ]) {
    assert.throws(
      () => classifyNativeSql(sql),
      (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
      sql,
    );
  }
});

test('SQL classifier requires every project_meta key mutation to be statically non-reserved', () => {
  for (const sql of [
    'INSERT INTO project_meta (key, value) VALUES (?, ?)',
    "INSERT INTO project_meta (key, value) VALUES ('safe_one', ?), (?, ?)",
    'INSERT INTO project_meta (value, key) VALUES (?, :key)',
    'UPDATE project_meta SET value = ? WHERE key = ?',
    "UPDATE project_meta SET key = @nextKey WHERE key = 'safe_key'",
    'DELETE FROM project_meta WHERE key = $key',
  ]) {
    assert.throws(
      () => classifyNativeSql(sql),
      (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
      sql,
    );
  }

  assert.deepEqual(
    classifyNativeSql("INSERT INTO project_meta (key, value) VALUES ('safe_key', ?)"),
    { kind: 'business_dml', operation: 'INSERT' },
  );
  assert.deepEqual(
    classifyNativeSql("UPDATE project_meta SET value = ? WHERE key = 'safe_key'"),
    { kind: 'business_dml', operation: 'UPDATE' },
  );
  assert.deepEqual(
    classifyNativeSql("DELETE FROM project_meta WHERE key = 'safe_key'"),
    { kind: 'business_dml', operation: 'DELETE' },
  );
  for (const key of [
    'manuscript_route',
    'manuscript_project_uid',
    'manuscript_route_journal',
    'manuscript_projection_generation',
  ]) {
    assert.throws(
      () => classifyNativeSql(`UPDATE project_meta SET value = 'forged' WHERE key = '${key}'`),
      (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
      key,
    );
  }
  assert.throws(
    () => classifyNativeSql('DELETE FROM chapters WHERE id = ?', { schemaVersion: 12 }),
    (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
  );
  assert.deepEqual(
    classifyNativeSql('DELETE FROM chapters WHERE id = ?', { schemaVersion: 11 }),
    { kind: 'business_dml', operation: 'DELETE' },
  );
});

test('database identity guard freezes canonical path and read-only handle identity', (t) => {
  const root = temporaryRoot(t, 'mythpen-native-identity-');
  const databasePath = path.join(root, 'project.db');
  fs.writeFileSync(databasePath, 'identity');
  const guard = createDatabaseIdentityGuard({ databasePath });
  t.after(() => guard.close());

  assert.equal(guard.canonicalPath, fs.realpathSync.native(databasePath));
  assert.deepEqual(Object.keys(guard.identity), ['dev', 'ino']);
  assert.match(guard.identity.dev, /^\d+$/);
  assert.match(guard.identity.ino, /^\d+$/);
  assert.equal(guard.assertCurrent(), true);
});

test('database identity guard rejects link-count growth and same-path replacement', (t) => {
  const root = temporaryRoot(t, 'mythpen-native-stale-');
  const databasePath = path.join(root, 'project.db');
  const hardlinkPath = path.join(root, 'project-hardlink.db');
  fs.writeFileSync(databasePath, 'before');
  const hardlinkGuard = createDatabaseIdentityGuard({ databasePath });
  fs.linkSync(databasePath, hardlinkPath);
  assert.throws(
    () => hardlinkGuard.assertCurrent(),
    (error) => error?.code === 'NATIVE_DATABASE_IDENTITY_STALE',
  );
  hardlinkGuard.close();
  fs.rmSync(hardlinkPath);

  const replacementGuard = createDatabaseIdentityGuard({ databasePath });
  const heldPath = path.join(root, 'held.db');
  fs.renameSync(databasePath, heldPath);
  fs.writeFileSync(databasePath, 'after');
  assert.throws(
    () => replacementGuard.assertCurrent(),
    (error) => error?.code === 'NATIVE_DATABASE_IDENTITY_STALE',
  );
  replacementGuard.close();
});

test('database identity guard rejects a symlink or junction ancestor', (t) => {
  const root = temporaryRoot(t, 'mythpen-native-reparse-');
  const physical = path.join(root, 'physical');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(physical);
  fs.writeFileSync(path.join(physical, 'project.db'), 'identity');
  fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => createDatabaseIdentityGuard({ databasePath: path.join(alias, 'project.db') }),
    (error) => error?.code === 'NATIVE_DATABASE_IDENTITY_STALE',
  );
});

test('database identity guard epoch is stale after close', (t) => {
  const root = temporaryRoot(t, 'mythpen-native-close-');
  const databasePath = path.join(root, 'project.db');
  fs.writeFileSync(databasePath, 'identity');
  const guard = createDatabaseIdentityGuard({ databasePath });
  guard.close();
  assert.throws(
    () => guard.assertCurrent(),
    (error) => error?.code === 'NATIVE_DATABASE_IDENTITY_STALE',
  );
});

function admissionOptions(overrides = {}) {
  const digest = 'a'.repeat(64);
  const controlStore = {
    read: () => [{
      seq: 1,
      type: 'sqlite.native.stage_b.fixture_genesis',
      digest,
      prevDigest: null,
      payload: {},
    }],
    assertCurrent: () => true,
  };
  return {
    databasePath: 'C:\\controlled\\project.db',
    controlStore,
    dbKey: 'b'.repeat(64),
    projectInstanceIdSha256: 'c'.repeat(64),
    ownershipHash: 'd'.repeat(64),
    assertWriterLease: () => true,
    admissionVerifier: () => ({
      basisKind: 'stage_b_fixture_genesis',
      basisDigest: digest,
    }),
    identityApi: () => {
      throw new Error('identity must not run in an admission rejection test');
    },
    sqliteFactory: () => {
      throw new Error('SQLite must not open in an admission rejection test');
    },
    ...overrides,
  };
}

test('core rejects empty evidence and invalid admission verifier capabilities before SQLite opens', () => {
  const cases = [
    { controlStore: { read: () => [], assertCurrent: () => true } },
    { admissionVerifier: undefined },
    { admissionVerifier: 'serializable-token' },
    { admissionVerifier: () => { throw new Error('denied'); } },
    { admissionVerifier: () => null },
    { admissionVerifier: () => ({ basisKind: 'stage_b_fixture_genesis' }) },
    { admissionVerifier: () => ({ basisKind: 'wrong', basisDigest: 'a'.repeat(64) }) },
    { admissionVerifier: () => ({ basisKind: 'stage_b_fixture_genesis', basisDigest: 'f'.repeat(64) }) },
    { admissionVerifier: () => ({ basisKind: 'stage_b_fixture_genesis', basisDigest: 'a'.repeat(64), extra: true }) },
  ];
  for (const overrides of cases) {
    assert.throws(
      () => createNativeProjectStoreCore(admissionOptions(overrides)),
      (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
    );
  }
});

test('core rechecks every authority after sqliteFactory and before the first SQL', () => {
  const identity = Object.freeze({ dev: '10', ino: '20' });
  const digest = 'a'.repeat(64);
  const evidence = [{
    seq: 1,
    type: 'sqlite.native.stage_b.fixture_genesis',
    digest,
    prevDigest: null,
    payload: {
      identity,
      dbKey: 'b'.repeat(64),
      ownershipHash: 'd'.repeat(64),
      projectInstanceIdSha256: 'c'.repeat(64),
    },
  }];
  const primary = new Error('identity changed after SQLite open');
  const trace = [];
  let guardChecks = 0;
  let databaseCloses = 0;
  let guardCloses = 0;
  let sqlCalls = 0;
  const database = {
    inTransaction: false,
    query(sql) {
      sqlCalls += 1;
      trace.push(`sql:${sql}`);
      return { get: () => ({ journal_mode: 'delete' }) };
    },
    exec(sql) {
      sqlCalls += 1;
      trace.push(`sql:${sql}`);
    },
    close() {
      databaseCloses += 1;
      trace.push('database.close');
    },
  };

  assert.throws(
    () => createNativeProjectStoreCore({
      databasePath: 'C:\\controlled\\project.db',
      controlStore: {
        read() {
          trace.push('evidence');
          return evidence;
        },
        assertCurrent() {
          trace.push('control');
          return true;
        },
      },
      dbKey: 'b'.repeat(64),
      projectInstanceIdSha256: 'c'.repeat(64),
      ownershipHash: 'd'.repeat(64),
      assertWriterLease() {
        trace.push('lease');
        return true;
      },
      admissionVerifier() {
        trace.push('admission');
        return { basisKind: 'stage_b_fixture_genesis', basisDigest: digest };
      },
      identityApi() {
        trace.push('identity.open');
        return {
          canonicalPath: 'C:\\controlled\\project.db',
          identity,
          assertCurrent() {
            guardChecks += 1;
            trace.push(`guard:${guardChecks}`);
            if (guardChecks === 2) throw primary;
            return true;
          },
          close() {
            guardCloses += 1;
            trace.push('guard.close');
          },
        };
      },
      sqliteFactory() {
        trace.push('sqlite.open');
        return database;
      },
    }),
    (error) => error === primary,
  );
  assert.equal(guardChecks, 2);
  assert.equal(sqlCalls, 0);
  assert.equal(databaseCloses, 1);
  assert.equal(guardCloses, 1);
  assert.deepEqual(trace.slice(-3), ['guard:2', 'database.close', 'guard.close']);
});

test('genesis verifier stays isolated from the replaceable Task 2 suffix policy', () => {
  const genesisDigest = 'a'.repeat(64);
  const fullEvidence = [
    {
      seq: 1,
      type: 'sqlite.native.stage_b.fixture_genesis',
      digest: genesisDigest,
      prevDigest: null,
      payload: {},
    },
    {
      seq: 2,
      type: 'sqlite.native.unknown_suffix',
      digest: 'b'.repeat(64),
      prevDigest: genesisDigest,
      payload: {},
    },
  ];
  const verifierEvidenceLengths = [];
  let identityCalls = 0;

  assert.throws(
    () => createNativeProjectStoreCore(admissionOptions({
      controlStore: {
        read: () => fullEvidence,
        assertCurrent: () => true,
      },
      admissionVerifier({ evidence }) {
        verifierEvidenceLengths.push(evidence.length);
        assert.ok(Object.isFrozen(evidence));
        assert.ok(Object.isFrozen(evidence[0]));
        return {
          basisKind: 'stage_b_fixture_genesis',
          basisDigest: genesisDigest,
        };
      },
      identityApi() {
        identityCalls += 1;
        throw new Error('identity must remain behind the Task 2 suffix policy');
      },
    })),
    (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
  );
  assert.deepEqual(verifierEvidenceLengths, [1]);
  assert.equal(identityCalls, 0);
});

test('ordinary native entry refuses fixture genesis even when a caller supplies a verifier', () => {
  assert.throws(
    () => createNativeProjectStore(admissionOptions()),
    (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED',
  );
});

function pragmaScalar(database, sql) {
  return Object.values(database.query(sql).get())[0];
}

test('testing factory opens exact genesis with the frozen read-only facade and PRAGMAs', (t) => {
  const fixture = nativeFixture(t, 'native-store-happy');
  let rawDatabase;
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory(databasePath) {
      rawDatabase = new Database(databasePath, { create: false, strict: true });
      return rawDatabase;
    },
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });

  assert.deepEqual(Object.keys(store), [
    'connectionEpoch',
    'state',
    'readAll',
    'readGet',
    'executeTransaction',
    'recover',
    'checkpoint',
    'publishProjectionTarget',
    'close',
    'fence',
  ]);
  assert.ok(Object.isFrozen(store));
  assert.match(store.connectionEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(store.state, 'active');
  assert.equal(store.database, undefined);
  assert.equal(store.rawDatabase, undefined);
  assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'schema_version'"), { value: '11' });
  assert.ok(store.readAll('SELECT key, value FROM project_meta ORDER BY key').length >= 6);
  assert.equal(pragmaScalar(rawDatabase, 'PRAGMA journal_mode'), 'delete');
  assert.equal(pragmaScalar(rawDatabase, 'PRAGMA synchronous'), 3);
  assert.equal(pragmaScalar(rawDatabase, 'PRAGMA foreign_keys'), 1);
  assert.equal(pragmaScalar(rawDatabase, 'PRAGMA busy_timeout'), 100);
  assert.equal(rawDatabase.inTransaction, false);

  assert.throws(
    () => store.readAll("INSERT INTO chapters (id, title) VALUES ('x', 'blocked')"),
    (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
  );
  let callbackCalled = false;
  assert.throws(
    () => store.executeTransaction({}, () => { callbackCalled = true; }),
    (error) => error?.code === 'NATIVE_TRANSACTION_INPUT_INVALID',
  );
  assert.equal(callbackCalled, false);
  assert.deepEqual(store.recover(), {
    status: 'clean',
    finalSeq: 0,
    connectionEpoch: store.connectionEpoch,
  });
  assert.throws(
    () => store.checkpoint(),
    (error) => error?.code === 'NATIVE_OPERATION_NOT_IMPLEMENTED',
  );
});

test('exact native suffix parser accepts one current source for transaction consumption', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-source-red');
  const store = createStageBFixtureStore(fixture);
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);

  assert.equal(store.executeTransaction(exactExecuteInput(source), () => undefined), undefined);
  assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'sqlite.tx.committed');
  assert.equal(store.state, 'active');
});

test('native afterPredicate and inexact source payload fail closed in the core parser', { timeout: 30_000 }, (t) => {
  const cases = [
    {
      name: 'after-predicate',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch),
          afterPredicate: { forbidden: true },
        };
      },
    },
    {
      name: 'extra-payload-key',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch, { unexpected: true }),
        };
      },
    },
    {
      name: 'invalid-created-at',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch, { createdAt: '2026-08-11' }),
        };
      },
    },
    {
      name: 'unsafe-attempt',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch, { attemptSeq: Number.MAX_SAFE_INTEGER + 1 }),
        };
      },
    },
    {
      name: 'missing-source-key',
      event(connectionEpoch, fixture) {
        const payload = sourcePayload(fixture, connectionEpoch);
        delete payload.targetKind;
        return { type: 'manuscript.source', payload };
      },
    },
    {
      name: 'invalid-source-uuid',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch, { eventId: 'not-a-uuid' }),
        };
      },
    },
    {
      name: 'invalid-source-hash',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch, { logicalRequestDigest: 'not-a-hash' }),
        };
      },
    },
    {
      name: 'unknown-source-enum',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch, { operationKind: 'unknown_operation' }),
        };
      },
    },
    {
      name: 'invalid-source-nullable-field',
      event(connectionEpoch, fixture) {
        return {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, connectionEpoch, { targetIdSha256: 1 }),
        };
      },
    },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task3-${current.name}`);
    const first = createStageBFixtureStore(fixture);
    const epoch = first.connectionEpoch;
    first.close();
    const controlStore = openControlStore(fixture.controlDirectory);
    controlStore.compareAndAppend(controlStore.tail().digest, current.event(epoch, fixture));
    assert.throws(
      () => createStageBFixtureStore(fixture),
      (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
      current.name,
    );
  }
});

test('wrong source owner and request are rejected before BEGIN without fencing', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-source-owner');
  const store = createStageBFixtureStore(fixture);
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);
  const wrong = exactExecuteInput(source);
  wrong.logicalRequestDigest = sha256('wrong-request');

  assert.throws(
    () => store.executeTransaction(wrong, () => undefined),
    (error) => error?.code === 'NATIVE_SOURCE_NOT_CURRENT',
  );
  assert.equal(store.state, 'active');
});

test('review fix I5: every execute-input ownership mismatch is rejected before BEGIN', (t) => {
  const fixture = nativeFixture(t, 'native-store-review-input-ownership');
  const trace = [];
  const sqliteState = {};
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);
  const valid = exactExecuteInput(source);
  const cases = [
    { name: 'sourceDigest', input: { ...valid, sourceDigest: sha256('wrong-source') } },
    { name: 'operationKind', input: { ...valid, operationKind: 'project_metadata_write' } },
    { name: 'logicalRequestDigest', input: { ...valid, logicalRequestDigest: sha256('wrong-request') } },
    { name: 'attemptSeq', input: { ...valid, attemptSeq: valid.attemptSeq + 1 } },
  ];
  sqliteState.capture = true;
  for (const current of cases) {
    let callbackCalled = false;
    assert.throws(
      () => store.executeTransaction(current.input, () => { callbackCalled = true; }),
      (error) => error?.code === 'NATIVE_SOURCE_NOT_CURRENT',
      current.name,
    );
    assert.equal(callbackCalled, false, current.name);
    assert.equal(store.state, 'active', current.name);
    assert.equal(openControlStore(fixture.controlDirectory).tail().digest, source.digest, current.name);
  }
  assert.equal(trace.filter((entry) => entry === 'exec:BEGIN IMMEDIATE').length, 0);
  assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '0' });
});

test('review fix I5: wrong source epoch, immutable owner, and consumed tail never reach BEGIN', { timeout: 30_000 }, (t) => {
  const cases = [
    { name: 'wrong-epoch', overrides: { connectionEpoch: randomUUID() }, code: 'NATIVE_SOURCE_NOT_CURRENT', state: 'fenced' },
    { name: 'wrong-db-key', overrides: { dbKey: sha256('wrong-db-key') }, code: 'NATIVE_ADMISSION_REJECTED', state: 'fenced' },
    { name: 'wrong-instance', overrides: { projectInstanceIdSha256: sha256('wrong-instance') }, code: 'NATIVE_ADMISSION_REJECTED', state: 'fenced' },
    { name: 'wrong-ownership', overrides: { ownershipHash: sha256('wrong-ownership') }, code: 'NATIVE_ADMISSION_REJECTED', state: 'fenced' },
    { name: 'consumed-tail', overrides: null, code: 'NATIVE_SOURCE_NOT_CURRENT', state: 'active' },
  ];
  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-review-source-${current.name}`);
    const trace = [];
    const sqliteState = {};
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
    });
    t.after(() => {
      if (store.state === 'active') store.close();
    });
    const source = appendSource(fixture, store, current.overrides || {});
    if (current.name === 'consumed-tail') appendAbandoned(fixture, store, source);
    const tailBefore = openControlStore(fixture.controlDirectory).tail().digest;
    let callbackCalled = false;
    sqliteState.capture = true;
    assert.throws(
      () => store.executeTransaction(exactExecuteInput(source), () => { callbackCalled = true; }),
      (error) => error?.code === current.code,
      current.name,
    );
    assert.equal(callbackCalled, false, current.name);
    assert.equal(trace.filter((entry) => entry === 'exec:BEGIN IMMEDIATE').length, 0, current.name);
    assert.equal(openControlStore(fixture.controlDirectory).tail().digest, tailBefore, current.name);
    assert.equal(store.state, current.state, current.name);
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    assert.deepEqual(inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(), { value: '0' }, current.name);
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0, current.name);
    inspector.close();
  }
});

test('normal transaction durably orders prepared, gate, DML, seq, COMMIT, and committed', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-normal');
  const trace = [];
  const sqliteState = {};
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);
  const privateBody = 'body-must-not-enter-evidence';
  sqliteState.capture = true;

  const result = store.executeTransaction(exactExecuteInput(source), (transaction) => {
    assert.deepEqual(Object.keys(transaction), ['all', 'get', 'run']);
    assert.ok(Object.isFrozen(transaction));
    trace.push('callback');
    const runResult = transaction.run(
      'INSERT INTO characters (id, name, background) VALUES (?, ?, ?)',
      'task3-normal-character',
      'Task 3 normal',
      privateBody,
    );
    assert.equal(runResult.changes, 1);
    return Object.freeze({ saved: true });
  });

  assert.deepEqual(result, { saved: true });
  const events = openControlStore(fixture.controlDirectory).read();
  assert.deepEqual(events.map(({ type }) => type), [
    'sqlite.native.stage_b.fixture_genesis',
    'manuscript.source',
    'sqlite.tx.prepared',
    'sqlite.tx.committed',
  ]);
  assert.equal(events[2].payload.sourceDigest, source.digest);
  assert.equal(source.payload.connectionEpoch, store.connectionEpoch);
  assert.equal(events[2].payload.connectionEpoch, store.connectionEpoch);
  assert.equal(events[2].payload.beforeSeq, 0);
  assert.equal(events[2].payload.expectedFinalSeq, 1);
  assert.equal(events[3].payload.preparedDigest, events[2].digest);
  assert.equal(events[3].payload.connectionEpoch, store.connectionEpoch);
  assert.equal(events[3].payload.finalSeq, 1);
  assert.equal(JSON.stringify(events).includes(privateBody), false);
  assert.equal(JSON.stringify(events).includes('databaseSha256'), false);
  assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '1' });
  assert.deepEqual(sqliteState.raw.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get(), { count: 0 });

  const order = [
    trace.indexOf('begin-tail:sqlite.tx.prepared'),
    trace.indexOf('exec:BEGIN IMMEDIATE'),
    trace.findIndex((entry) => entry.startsWith('run:INSERT INTO "_durability_write_gate"')),
    trace.indexOf('callback'),
    trace.findIndex((entry) => entry.startsWith('run:INSERT INTO characters')),
    trace.findIndex((entry) => entry.startsWith('run:UPDATE project_meta SET value = ?')),
    trace.findIndex((entry) => entry.startsWith('run:DELETE FROM "_durability_write_gate"')),
    trace.indexOf('exec:COMMIT'),
  ];
  assert.ok(order.every((index) => index >= 0), JSON.stringify(trace, null, 2));
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
});

test('transaction read auth, synchronous guard, and stale facade fail closed', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-guard');
  const trace = [];
  const sqliteState = {};
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);
  sqliteState.capture = true;
  let savedRun;

  store.executeTransaction(exactExecuteInput(source), (transaction) => {
    savedRun = transaction.run;
    assert.equal(transaction.get("SELECT value FROM project_meta WHERE key = 'safe_key'"), null);
    for (const sql of [
      "SELECT value FROM project_meta WHERE key = 'schema_version'",
      'SELECT value FROM project_meta WHERE key = ?',
      "SELECT p.value FROM project_meta AS p WHERE p.key = 'safe_key'",
      "SELECT value FROM project_meta WHERE key = 'safe_key' OR 1 = 1",
    ]) {
      assert.throws(
        () => transaction.get(sql, 'safe_key'),
        (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
        sql,
      );
      assert.equal(trace.some((entry) => entry.includes(sql)), false, sql);
    }
    for (const action of [
      () => store.readGet('SELECT 1'),
      () => store.readAll('SELECT 1'),
      () => store.executeTransaction(null, null),
      () => store.recover(),
      () => store.checkpoint(),
      () => store.close(),
      () => store.fence(),
    ]) {
      assert.throws(
        action,
        (error) => error?.code === 'NATIVE_OPERATION_IN_PROGRESS',
      );
    }
    transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', 'task3-guard', 'Task 3 guard');
  });

  assert.equal(store.state, 'active');
  assert.throws(
    () => savedRun('INSERT INTO characters (id, name) VALUES (?, ?)', 'stale', 'Stale'),
    (error) => error?.code === 'NATIVE_TRANSACTION_FACADE_STALE',
  );
  assert.equal(store.readGet("SELECT COUNT(*) AS count FROM characters WHERE id = 'stale'").count, 0);
});

test('clean commit closes and reopens without the genesis database hash', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-reopen');
  const first = createStageBFixtureStore(fixture);
  t.after(() => {
    if (first.state === 'active') first.close();
  });
  const firstEpoch = first.connectionEpoch;
  const firstSource = appendSource(fixture, first);
  first.executeTransaction(exactExecuteInput(firstSource), (transaction) => {
    transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', 'task3-reopen-1', 'First epoch');
  });
  first.close();

  const staleGenesisHash = Object.freeze({ ...fixture, databaseSha256: '0'.repeat(64) });
  const second = createStageBFixtureStore(staleGenesisHash);
  t.after(() => {
    if (second.state === 'active') second.close();
  });
  assert.notEqual(second.connectionEpoch, firstEpoch);
  assert.deepEqual(
    second.readGet("SELECT name FROM characters WHERE id = 'task3-reopen-1'"),
    { name: 'First epoch' },
  );
  const secondSource = appendSource(fixture, second, {
    logicalRequestDigest: sha256('second-clean-request'),
  });
  second.executeTransaction(exactExecuteInput(secondSource), (transaction) => {
    transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', 'task3-reopen-2', 'Second epoch');
  });
  assert.deepEqual(second.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '2' });
  const events = openControlStore(fixture.controlDirectory).read();
  assert.equal(events.at(-1).type, 'sqlite.tx.committed');
  assert.equal(events.at(-1).payload.connectionEpoch, second.connectionEpoch);
  assert.equal(events.at(-1).payload.finalSeq, 2);
});

test('RESERVED writer contention proves begin_not_acquired without ROLLBACK', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-reserved-busy');
  const trace = [];
  const sqliteState = {};
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);
  const blocker = new Database(fixture.databasePath, { create: false, strict: true });
  blocker.exec('PRAGMA busy_timeout = 100');
  blocker.exec('BEGIN IMMEDIATE');
  t.after(() => {
    try {
      blocker.exec('ROLLBACK');
    } catch {
      // Preserve the primary assertion.
    }
    blocker.close();
  });
  sqliteState.capture = true;
  const started = performance.now();

  assert.throws(
    () => store.executeTransaction(exactExecuteInput(source), () => {
      assert.fail('callback must not run when BEGIN is busy');
    }),
    (error) => error?.code === 'PROJECT_WRITE_BUSY',
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 50 && elapsed < 750, `BEGIN busy took ${elapsed}ms`);
  assert.equal(trace.filter((entry) => entry === 'exec:BEGIN IMMEDIATE').length, 1);
  assert.equal(trace.filter((entry) => entry === 'exec:ROLLBACK').length, 0);
  assert.equal(trace.some((entry) => entry.includes('INSERT INTO "_durability_write_gate"')), false);
  assert.equal(trace.some((entry) => entry.includes("UPDATE project_meta SET value = ? WHERE key = 'durability_commit_seq'")), false);

  const events = openControlStore(fixture.controlDirectory).read();
  assert.deepEqual(events.map(({ type }) => type), [
    'sqlite.native.stage_b.fixture_genesis',
    'manuscript.source',
    'sqlite.tx.prepared',
    'sqlite.tx.rolled_back',
  ]);
  const terminal = events.at(-1);
  assert.equal(source.payload.connectionEpoch, store.connectionEpoch);
  assert.equal(events[2].payload.connectionEpoch, store.connectionEpoch);
  assert.equal(terminal.payload.connectionEpoch, store.connectionEpoch);
  assert.equal(terminal.payload.rollbackKind, 'begin_not_acquired');
  assert.equal(terminal.payload.reasonCode, 'sqlite_busy');
  assert.deepEqual(terminal.payload.predicate, {
    autocommit: true,
    writeLockAcquired: false,
    gateSqlExecuted: false,
    businessSqlExecuted: false,
    seqSqlExecuted: false,
    schemaVersion: 11,
    backend: 'native-sqlite-v2',
    finalSeq: 0,
    gateEmpty: true,
    triggerVersion: 1,
    triggerSetDigest: events[0].payload.triggerSetDigest,
    identity: events[0].payload.identity,
  });
  assert.equal(store.state, 'active');
});

test('Batch 3: failure after BEGIN rolls back to the exact pre-write predicate', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-rollback');
  const trace = [];
  const sqliteState = {};
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);
  const primary = new Error('callback failed after business DML');
  sqliteState.capture = true;

  assert.throws(
    () => store.executeTransaction(exactExecuteInput(source), (transaction) => {
      transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', 'task3-rollback', 'Rolled back');
      throw primary;
    }),
    (error) => error === primary,
  );
  assert.equal(trace.filter((entry) => entry === 'exec:ROLLBACK').length, 1);
  assert.equal(trace.filter((entry) => entry === 'exec:COMMIT').length, 0);
  assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '0' });
  assert.equal(store.readGet("SELECT COUNT(*) AS count FROM characters WHERE id = 'task3-rollback'").count, 0);
  const terminal = openControlStore(fixture.controlDirectory).tail();
  const rollbackEvents = openControlStore(fixture.controlDirectory).read();
  assert.equal(source.payload.connectionEpoch, store.connectionEpoch);
  assert.equal(rollbackEvents[2].payload.connectionEpoch, store.connectionEpoch);
  assert.equal(terminal.payload.connectionEpoch, store.connectionEpoch);
  assert.equal(terminal.type, 'sqlite.tx.rolled_back');
  assert.equal(terminal.payload.rollbackKind, 'transaction_rolled_back');
  assert.equal(terminal.payload.reasonCode, 'transaction_failed');
  assert.equal(terminal.payload.predicate.rollbackCompleted, true);
  assert.equal(store.state, 'active');
});

test('Batch 3: Promise and custom thenables are synchronous rollback failures', async (t) => {
  const cases = [
    {
      name: 'promise',
      callback() {
        return Promise.resolve('never awaited');
      },
      code: 'NATIVE_TRANSACTION_ASYNC_FORBIDDEN',
    },
    {
      name: 'custom-thenable',
      callback() {
        return { then() { assert.fail('then must not be invoked'); } };
      },
      code: 'NATIVE_TRANSACTION_ASYNC_FORBIDDEN',
    },
    {
      name: 'throwing-then-getter',
      callback() {
        return Object.defineProperty({}, 'then', {
          get() {
            const error = new Error('then getter failed');
            error.code = 'THEN_GETTER_FAILED';
            throw error;
          },
        });
      },
      code: 'THEN_GETTER_FAILED',
    },
  ];
  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task3-${current.name}`);
    const store = createStageBFixtureStore(fixture);
    t.after(() => {
      if (store.state === 'active') store.close();
    });
    const source = appendSource(fixture, store);
    assert.throws(
      () => store.executeTransaction(exactExecuteInput(source), current.callback),
      (error) => error?.code === current.code,
      current.name,
    );
    assert.equal(openControlStore(fixture.controlDirectory).tail().payload.rollbackKind, 'transaction_rolled_back');
    assert.equal(store.state, 'active');
  }
});

test('Batch 3: EXCLUSIVE lock makes the busy predicate unreadable and requires recovery', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-exclusive-busy');
  const blocker = new Database(fixture.databasePath, { create: false, strict: true });
  blocker.exec('PRAGMA busy_timeout = 100');
  let raw;
  let beginCalls = 0;
  let rollbackCalls = 0;
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory(databasePath) {
      raw = new Database(databasePath, { create: false, strict: true });
      return {
        get inTransaction() {
          return raw.inTransaction;
        },
        query(sql) {
          return raw.query(sql);
        },
        exec(sql) {
          if (sql === 'BEGIN IMMEDIATE') {
            beginCalls += 1;
            blocker.exec('BEGIN EXCLUSIVE');
          }
          if (sql === 'ROLLBACK') rollbackCalls += 1;
          return raw.exec(sql);
        },
        close() {
          return raw.close();
        },
      };
    },
  });
  const source = appendSource(fixture, store);
  t.after(() => {
    try {
      blocker.exec('ROLLBACK');
    } catch {
      // Preserve the primary assertion.
    }
    blocker.close();
    if (store.state === 'active') store.close();
  });

  assert.throws(
    () => store.executeTransaction(exactExecuteInput(source), () => undefined),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(beginCalls, 1);
  assert.equal(rollbackCalls, 0);
  assert.equal(store.state, 'fenced');
  assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'sqlite.tx.prepared');
});

test('a pre-existing write gate fences without preparing or guessing a terminal', (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-preexisting-gate');
  const store = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, store);
  const mutator = new Database(fixture.databasePath, { create: false, strict: true });
  mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
  mutator.close();

  assert.throws(
    () => store.executeTransaction(exactExecuteInput(source), () => undefined),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(store.state, 'fenced');
  assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'manuscript.source');
  const inspector = new Database(fixture.databasePath, { create: false, strict: true });
  assert.equal(inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 1);
  inspector.close();
});

test('native transaction fault point names are frozen exactly', () => {
  assert.deepEqual({
    NATIVE_TX_AFTER_PREPARED_POSTCHECK: FAULT_POINTS.NATIVE_TX_AFTER_PREPARED_POSTCHECK,
    NATIVE_TX_AFTER_BEGIN_ACQUIRED: FAULT_POINTS.NATIVE_TX_AFTER_BEGIN_ACQUIRED,
    NATIVE_TX_AFTER_GATE_INSERT: FAULT_POINTS.NATIVE_TX_AFTER_GATE_INSERT,
    NATIVE_TX_AFTER_BUSINESS_CALLBACK: FAULT_POINTS.NATIVE_TX_AFTER_BUSINESS_CALLBACK,
    NATIVE_TX_AFTER_SEQ_CAS: FAULT_POINTS.NATIVE_TX_AFTER_SEQ_CAS,
    NATIVE_TX_AFTER_GATE_DELETE: FAULT_POINTS.NATIVE_TX_AFTER_GATE_DELETE,
    NATIVE_TX_BEFORE_COMMIT_INVOKE: FAULT_POINTS.NATIVE_TX_BEFORE_COMMIT_INVOKE,
    NATIVE_TX_AFTER_COMMIT_RETURN: FAULT_POINTS.NATIVE_TX_AFTER_COMMIT_RETURN,
    NATIVE_TX_BEFORE_TERMINAL_APPEND: FAULT_POINTS.NATIVE_TX_BEFORE_TERMINAL_APPEND,
  }, {
    NATIVE_TX_AFTER_PREPARED_POSTCHECK: 'native.tx.after-prepared-postcheck',
    NATIVE_TX_AFTER_BEGIN_ACQUIRED: 'native.tx.after-begin-acquired',
    NATIVE_TX_AFTER_GATE_INSERT: 'native.tx.after-gate-insert',
    NATIVE_TX_AFTER_BUSINESS_CALLBACK: 'native.tx.after-business-callback',
    NATIVE_TX_AFTER_SEQ_CAS: 'native.tx.after-seq-cas',
    NATIVE_TX_AFTER_GATE_DELETE: 'native.tx.after-gate-delete',
    NATIVE_TX_BEFORE_COMMIT_INVOKE: 'native.tx.before-commit-invoke',
    NATIVE_TX_AFTER_COMMIT_RETURN: 'native.tx.after-commit-return',
    NATIVE_TX_BEFORE_TERMINAL_APPEND: 'native.tx.before-terminal-append',
  });
});

test('before-COMMIT fault rolls back, after-COMMIT fault fences without terminal', async (t) => {
  const beforeFixture = nativeFixture(t, 'native-store-task3-before-commit');
  const beforeStore = createStageBFixtureStore(beforeFixture);
  t.after(() => {
    if (beforeStore.state === 'active') beforeStore.close();
  });
  const beforeSource = appendSource(beforeFixture, beforeStore);
  const observedContexts = [];
  await assert.rejects(
    () => withFaults({
      [FAULT_POINTS.NATIVE_TX_BEFORE_COMMIT_INVOKE]: {
        callback(context) {
          observedContexts.push(context);
        },
        throw: 'FAULT_BEFORE_COMMIT',
      },
    }, () => beforeStore.executeTransaction(exactExecuteInput(beforeSource), (transaction) => {
      transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', 'before-commit', 'Before commit');
    })),
    (error) => error?.code === 'FAULT_BEFORE_COMMIT',
  );
  assert.equal(beforeStore.state, 'active');
  assert.equal(openControlStore(beforeFixture.controlDirectory).tail().payload.rollbackKind, 'transaction_rolled_back');
  assert.equal(beforeStore.readGet("SELECT COUNT(*) AS count FROM characters WHERE id = 'before-commit'").count, 0);
  assert.equal(observedContexts.length, 1);
  assert.deepEqual(
    Object.keys(observedContexts[0]).sort(),
    [
      'beforeSeq',
      'businessSqlExecuted',
      'commitInvoked',
      'expectedFinalSeq',
      'gateDeleteSqlExecuted',
      'gateSqlExecuted',
      'preparedDigest',
      'seqSqlExecuted',
      'sourceDigest',
      'transactionId',
      'writeLockAcquired',
    ].sort(),
  );
  assert.equal(JSON.stringify(observedContexts).includes('INSERT'), false);

  const afterFixture = nativeFixture(t, 'native-store-task3-after-commit');
  const afterStore = createStageBFixtureStore(afterFixture);
  const afterSource = appendSource(afterFixture, afterStore);
  await assert.rejects(
    () => withFaults({
      [FAULT_POINTS.NATIVE_TX_AFTER_COMMIT_RETURN]: { throw: 'FAULT_AFTER_COMMIT' },
    }, () => afterStore.executeTransaction(exactExecuteInput(afterSource), (transaction) => {
      transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', 'after-commit', 'After commit');
      return 'must-not-escape';
    })),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(afterStore.state, 'fenced');
  assert.equal(openControlStore(afterFixture.controlDirectory).tail().type, 'sqlite.tx.prepared');
  const inspector = new Database(afterFixture.databasePath, { create: false, strict: true });
  assert.equal(inspector.query("SELECT COUNT(*) AS count FROM characters WHERE id = 'after-commit'").get().count, 1);
  assert.deepEqual(inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(), { value: '1' });
  inspector.close();
});

test('COMMIT throw before or after the real commit never invokes ROLLBACK or guesses a terminal', (t) => {
  for (const mode of ['before-real-commit', 'after-real-commit']) {
    const fixture = nativeFixture(t, `native-store-task3-${mode}`);
    let raw;
    let rollbackCalls = 0;
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        raw = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() {
            return raw.inTransaction;
          },
          query(sql) {
            return raw.query(sql);
          },
          exec(sql) {
            if (sql === 'ROLLBACK') rollbackCalls += 1;
            if (sql === 'COMMIT') {
              if (mode === 'after-real-commit') raw.exec(sql);
              const error = new Error(`commit wrapper ${mode}`);
              error.code = 'COMMIT_WRAPPER_THROW';
              throw error;
            }
            return raw.exec(sql);
          },
          close() {
            return raw.close();
          },
        };
      },
    });
    t.after(() => {
      if (store.state === 'active') store.close();
    });
    const source = appendSource(fixture, store);
    assert.throws(
      () => store.executeTransaction(exactExecuteInput(source), (transaction) => {
        transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', `commit-${mode}`, mode);
      }),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      mode,
    );
    assert.equal(rollbackCalls, 0, mode);
    assert.equal(store.state, 'fenced', mode);
    assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'sqlite.tx.prepared', mode);
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    const count = inspector.query('SELECT COUNT(*) AS count FROM characters WHERE id = ?').get(`commit-${mode}`).count;
    assert.equal(count, mode === 'after-real-commit' ? 1 : 0, mode);
    inspector.close();
  }
});

test('Batch 4: terminal publication uncertainty fences and never reports callback success', async (t) => {
  const fixture = nativeFixture(t, 'native-store-task3-terminal-append');
  const store = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, store);
  let callbackReturned = false;
  await assert.rejects(
    () => withFaults({
      [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: {
        callback(context) {
          if (context.seq === 4) {
            const error = new Error('terminal publish failed');
            error.code = 'TERMINAL_PUBLISH_FAILED';
            throw error;
          }
        },
      },
    }, () => {
      const result = store.executeTransaction(exactExecuteInput(source), (transaction) => {
        transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', 'terminal-append', 'Terminal append');
        return 'callback-result';
      });
      callbackReturned = result === 'callback-result';
    }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(callbackReturned, false);
  assert.equal(store.state, 'fenced');
  assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'sqlite.tx.prepared');
});

test('Batch 4: caller-owned abandoned source and two real busy attempts are bounded', (t) => {
  const abandonedFixture = nativeFixture(t, 'native-store-task3-abandoned');
  const abandonedStore = createStageBFixtureStore(abandonedFixture);
  t.after(() => {
    if (abandonedStore.state === 'active') abandonedStore.close();
  });
  const abandonedSource = appendSource(abandonedFixture, abandonedStore);
  const abandoned = appendAbandoned(abandonedFixture, abandonedStore, abandonedSource);
  assert.equal(abandoned.type, 'manuscript.source.abandoned');
  assert.throws(
    () => abandonedStore.executeTransaction(exactExecuteInput(abandonedSource), () => undefined),
    (error) => error?.code === 'NATIVE_SOURCE_NOT_CURRENT',
  );
  assert.equal(abandonedStore.state, 'active');

  const busyFixture = nativeFixture(t, 'native-store-task3-two-busy');
  const busyStore = createStageBFixtureStore(busyFixture);
  t.after(() => {
    if (busyStore.state === 'active') busyStore.close();
  });
  const blocker = new Database(busyFixture.databasePath, { create: false, strict: true });
  blocker.exec('PRAGMA busy_timeout = 100');
  blocker.exec('BEGIN IMMEDIATE');
  t.after(() => {
    try {
      blocker.exec('ROLLBACK');
    } catch {
      // Preserve the primary assertion.
    }
    blocker.close();
  });
  const source1 = appendSource(busyFixture, busyStore);
  const elapsed = [];
  for (const source of [
    source1,
    appendSource.bind(null, busyFixture, busyStore),
  ]) {
    const currentSource = typeof source === 'function'
      ? source({
        logicalRequestDigest: source1.payload.logicalRequestDigest,
        attemptSeq: 2,
        previousAttemptSourceDigest: source1.digest,
      })
      : source;
    const started = performance.now();
    assert.throws(
      () => busyStore.executeTransaction(exactExecuteInput(currentSource), () => undefined),
      (error) => error?.code === 'PROJECT_WRITE_BUSY',
    );
    elapsed.push(performance.now() - started);
  }
  assert.ok(elapsed.every((value) => value >= 50 && value < 750), JSON.stringify(elapsed));
  const types = openControlStore(busyFixture.controlDirectory).read().map(({ type }) => type);
  assert.deepEqual(types, [
    'sqlite.native.stage_b.fixture_genesis',
    'manuscript.source',
    'sqlite.tx.prepared',
    'sqlite.tx.rolled_back',
    'manuscript.source',
    'sqlite.tx.prepared',
    'sqlite.tx.rolled_back',
  ]);
  assert.equal(busyStore.state, 'active');
});

test('review fix C1: falsy callback and then-getter throws preserve the original value and roll back', { timeout: 30_000 }, (t) => {
  const thrownValues = [undefined, null, false, 0, ''];
  for (const origin of ['callback', 'then-getter']) {
    for (const [index, thrownValue] of thrownValues.entries()) {
      const fixture = nativeFixture(t, `native-store-review-falsy-${origin}-${index}`);
      const trace = [];
      const sqliteState = {};
      const store = createStageBFixtureStore(fixture, {
        sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
      });
      t.after(() => {
        if (store.state === 'active') store.close();
      });
      const source = appendSource(fixture, store);
      sqliteState.capture = true;
      let didThrow = false;
      let observed = Symbol('not-thrown');
      try {
        store.executeTransaction(exactExecuteInput(source), (transaction) => {
          transaction.run(
            'INSERT INTO characters (id, name) VALUES (?, ?)',
            `falsy-${origin}-${index}`,
            `Falsy ${origin} ${index}`,
          );
          if (origin === 'callback') throw thrownValue;
          return Object.defineProperty({}, 'then', {
            get() {
              throw thrownValue;
            },
          });
        });
      } catch (error) {
        didThrow = true;
        observed = error;
      }
      assert.equal(didThrow, true, `${origin}:${index}`);
      assert.equal(Object.is(observed, thrownValue), true, `${origin}:${index}`);
      assert.equal(trace.filter((entry) => entry === 'exec:ROLLBACK').length, 1, `${origin}:${index}`);
      assert.equal(trace.filter((entry) => entry === 'exec:COMMIT').length, 0, `${origin}:${index}`);
      assert.equal(
        store.readGet('SELECT COUNT(*) AS count FROM characters WHERE id = ?', `falsy-${origin}-${index}`).count,
        0,
        `${origin}:${index}`,
      );
      assert.deepEqual(
        store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"),
        { value: '0' },
      );
      const terminal = openControlStore(fixture.controlDirectory).tail();
      assert.equal(terminal.type, 'sqlite.tx.rolled_back', `${origin}:${index}`);
      assert.equal(terminal.payload.rollbackKind, 'transaction_rolled_back', `${origin}:${index}`);
    }
  }
});

test('review fix I1: transaction DML cannot read project_meta through a subquery', (t) => {
  const fixture = nativeFixture(t, 'native-store-review-dml-subquery');
  const trace = [];
  const sqliteState = {};
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store);
  sqliteState.capture = true;
  const forbiddenSql = [
    "INSERT INTO characters (id, name, background) VALUES ('subquery-insert', 'Insert', (SELECT value FROM project_meta WHERE key = 'schema_version'))",
    "UPDATE characters SET background = (SELECT value FROM project_meta WHERE key = ?) WHERE id = 'none'",
    "DELETE FROM characters WHERE id = (SELECT p.value FROM project_meta AS p WHERE p.key = 'safe_key')",
    "INSERT INTO characters (id, name, background) SELECT 'subquery-join', 'Join', p.value FROM project_meta p JOIN characters c ON c.id = p.key",
  ];

  store.executeTransaction(exactExecuteInput(source), (transaction) => {
    assert.equal(transaction.get("SELECT value FROM project_meta WHERE key = 'safe_key'"), null);
    for (const sql of forbiddenSql) {
      const queryCallsBefore = trace.filter((entry) => entry.includes(sql)).length;
      assert.throws(
        () => transaction.run(sql, 'schema_version'),
        (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
        sql,
      );
      assert.equal(trace.filter((entry) => entry.includes(sql)).length, queryCallsBefore, sql);
    }
    transaction.run(
      "INSERT INTO project_meta (key, value) VALUES ('safe_transaction_key', ?)",
      'safe-value',
    );
  });
  assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'safe_transaction_key'"), {
    value: 'safe-value',
  });
});

test('rereview I1: single-quoted table identifiers fail before query creation without rejecting string data', (t) => {
  const fixture = nativeFixture(t, 'native-store-rereview-single-quoted-table');
  const trace = [];
  const sqliteState = {};
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  const source = appendSource(fixture, store, {
    logicalRequestDigest: sha256('single-quoted-table-identifier'),
  });
  sqliteState.capture = true;

  for (const sql of [
    "SELECT value FROM 'project_meta' WHERE key = 'schema_version'",
    "SELECT value FROM main.'project_meta' WHERE key = 'schema_version'",
    "SELECT p.value FROM characters c, 'project_meta' p WHERE p.key = 'schema_version'",
    "SELECT p.value FROM ('project_meta') p WHERE p.key = 'schema_version'",
    "SELECT p.value FROM (characters c, 'project_meta' p) WHERE p.key = 'schema_version'",
    "SELECT COUNT(*) AS count FROM '_durability_write_gate'",
    "SELECT gate_id FROM ('_durability_write_gate')",
    "SELECT g.gate_id FROM (characters c, '_durability_write_gate' g) LIMIT 1",
    "SELECT name FROM 'sqlite_schema' WHERE type = 'table'",
  ]) {
    assert.throws(
      () => store.readGet(sql),
      (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
      `outer:${sql}`,
    );
    assert.equal(trace.some((entry) => entry.includes(sql)), false, `outer query creation:${sql}`);
  }
  assert.equal(openControlStore(fixture.controlDirectory).tail().digest, source.digest);
  assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '0' });

  const forbiddenTransactionSql = [
    { method: 'get', sql: "SELECT value FROM 'project_meta' WHERE key = 'schema_version'" },
    { method: 'all', sql: "SELECT value FROM main.'project_meta' WHERE key = 'schema_version'" },
    { method: 'all', sql: "SELECT c.id FROM characters c JOIN 'project_meta' p ON p.key = c.id" },
    { method: 'all', sql: "SELECT p.value FROM characters c, 'project_meta' p WHERE p.key = 'schema_version'" },
    { method: 'get', sql: "SELECT p.value FROM ('project_meta') p WHERE p.key = 'schema_version'" },
    { method: 'all', sql: "SELECT p.value FROM (characters c, 'project_meta' p) WHERE p.key = 'schema_version'" },
    { method: 'get', sql: "SELECT COUNT(*) AS count FROM '_durability_write_gate'" },
    { method: 'get', sql: "SELECT name FROM 'sqlite_schema' WHERE type = 'table'" },
    {
      method: 'run',
      sql: "INSERT INTO characters (id, name, background) VALUES ('quoted-insert', 'Insert', (SELECT value FROM 'project_meta' WHERE key = 'schema_version'))",
    },
    {
      method: 'run',
      sql: "UPDATE characters SET background = (SELECT value FROM main.'project_meta' WHERE key = 'schema_version') WHERE id = 'quoted-update'",
    },
    {
      method: 'run',
      sql: "DELETE FROM characters WHERE id = (SELECT key FROM 'project_meta' WHERE key = 'schema_version')",
    },
    {
      method: 'run',
      sql: "INSERT INTO characters (id, name, background) SELECT 'comma-nested', 'Comma', p.value FROM chapters c, 'project_meta' p WHERE p.key = 'schema_version'",
    },
    {
      method: 'run',
      sql: "INSERT INTO characters (id, name, background) SELECT 'paren-nested', 'Paren', p.value FROM ('project_meta') p WHERE p.key = 'schema_version'",
    },
    {
      method: 'run',
      sql: "INSERT INTO characters (id, name, background) SELECT 'paren-comma', 'Paren comma', p.value FROM (chapters c, 'project_meta' p) WHERE p.key = 'schema_version'",
    },
  ];
  store.executeTransaction(exactExecuteInput(source), (transaction) => {
    transaction.run(
      "INSERT INTO characters (id, name, background) VALUES ('quoted-update', 'Update', 'project_meta')",
    );
    transaction.run(
      "INSERT INTO characters (id, name, background) VALUES ('schema_version', 'Delete', 'project_meta')",
    );
    assert.deepEqual(transaction.get("SELECT 'project_meta' AS value"), { value: 'project_meta' });
    assert.deepEqual(transaction.get("SELECT ('project_meta') AS value"), { value: 'project_meta' });
    assert.deepEqual(
      transaction.get("SELECT printf('%s,%s', 'project_meta', 'value') AS value"),
      { value: 'project_meta,value' },
    );
    assert.equal(
      transaction.get("SELECT COUNT(*) AS count FROM characters WHERE background = 'project_meta'").count,
      2,
    );
    for (const current of forbiddenTransactionSql) {
      assert.throws(
        () => transaction[current.method](current.sql),
        (error) => error?.code === 'NATIVE_SQL_FORBIDDEN',
        `${current.method}:${current.sql}`,
      );
      assert.equal(
        trace.some((entry) => entry.includes(current.sql)),
        false,
        `transaction query creation:${current.sql}`,
      );
    }
    assert.equal(transaction.get("SELECT COUNT(*) AS count FROM characters WHERE id = 'quoted-insert'").count, 0);
    assert.deepEqual(
      transaction.get("SELECT background FROM characters WHERE id = 'quoted-update'"),
      { background: 'project_meta' },
    );
    assert.equal(transaction.get("SELECT COUNT(*) AS count FROM characters WHERE id = 'schema_version'").count, 1);
  });

  assert.deepEqual(
    store.readGet("SELECT 'project_meta' AS value FROM characters WHERE id = 'quoted-update' AND background = 'project_meta'"),
    { value: 'project_meta' },
  );
  assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '1' });
  assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'sqlite.tx.committed');
  store.close();
});

test('review fix I2: execute input accessors and proxies cannot reenter before validation', (t) => {
  const cases = [
    { name: 'accessor-read', kind: 'accessor', action: (store) => store.readGet('SELECT 1 AS value') },
    { name: 'accessor-close', kind: 'accessor', action: (store) => store.close() },
    { name: 'proxy-execute', kind: 'proxy', action: (store, input) => store.executeTransaction(input, () => undefined) },
  ];
  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-review-${current.name}`);
    const store = createStageBFixtureStore(fixture);
    t.after(() => {
      if (store.state === 'active') store.close();
    });
    const source = appendSource(fixture, store);
    const validInput = exactExecuteInput(source);
    let reentryError;
    let trapCalls = 0;
    const getter = () => {
      trapCalls += 1;
      try {
        current.action(store, validInput);
      } catch (error) {
        reentryError = error;
        throw error;
      }
      return source.digest;
    };
    const input = current.kind === 'accessor'
      ? {
        get sourceDigest() {
          return getter();
        },
        operationKind: validInput.operationKind,
        logicalRequestDigest: validInput.logicalRequestDigest,
        attemptSeq: validInput.attemptSeq,
      }
      : new Proxy(validInput, {
        get(target, property, receiver) {
          if (property === 'sourceDigest') return getter();
          return Reflect.get(target, property, receiver);
        },
      });
    assert.throws(
      () => store.executeTransaction(input, () => assert.fail('outer callback must not run')),
      (error) => error?.code === 'NATIVE_OPERATION_IN_PROGRESS',
      current.name,
    );
    assert.ok(trapCalls >= 1, current.name);
    assert.equal(reentryError?.code, 'NATIVE_OPERATION_IN_PROGRESS', current.name);
    assert.equal(store.state, 'active', current.name);
    assert.equal(openControlStore(fixture.controlDirectory).tail().digest, source.digest, current.name);
    assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '0' });
  }
});

test('review fix I3: recovery terminals require a fresh never-used connection epoch', { timeout: 30_000 }, (t) => {
  const terminalKinds = ['recovery_before_commit', 'committed'];
  const epochKinds = ['fresh', 'genesis', 'historical-clean', 'current-attempt'];
  for (const terminalKind of terminalKinds) {
    for (const epochKind of epochKinds) {
      const fixture = nativeFixture(t, `native-store-review-${terminalKind}-${epochKind}`);
      const first = createStageBFixtureStore(fixture);
      const historicalCleanEpoch = first.connectionEpoch;
      const firstSource = appendSource(fixture, first, {
        logicalRequestDigest: sha256(`first:${terminalKind}:${epochKind}`),
      });
      first.executeTransaction(exactExecuteInput(firstSource), () => undefined);
      first.close();

      const second = createStageBFixtureStore(fixture);
      const source = appendSource(fixture, second, {
        logicalRequestDigest: sha256(`second:${terminalKind}:${epochKind}`),
      });
      const controlStore = openControlStore(fixture.controlDirectory);
      const genesis = controlStore.read()[0];
      const preparedResult = controlStore.compareAndAppend(source.digest, {
        type: 'sqlite.tx.prepared',
        payload: {
          ...commonNativePayload(fixture, second.connectionEpoch),
          transactionId: randomUUID(),
          sourceDigest: source.digest,
          beforeSeq: 1,
          expectedFinalSeq: 2,
          schemaVersion: 11,
          backend: 'native-sqlite-v2',
          expectedGateEmpty: true,
          expectedTriggerVersion: 1,
          expectedTriggerSetDigest: genesis.payload.triggerSetDigest,
          expectedIdentity: genesis.payload.identity,
          operationKind: source.payload.operationKind,
        },
      });
      const recoveryEpoch = epochKind === 'fresh'
        ? randomUUID()
        : epochKind === 'genesis'
          ? genesis.payload.connectionEpoch
          : epochKind === 'historical-clean'
            ? historicalCleanEpoch
            : second.connectionEpoch;
      if (terminalKind === 'committed') {
        const mutator = new Database(fixture.databasePath, { create: false, strict: true });
        mutator.exec('BEGIN IMMEDIATE');
        mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
        mutator.query("UPDATE project_meta SET value = '2' WHERE key = 'durability_commit_seq' AND value = '1'").run();
        mutator.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
        mutator.exec('COMMIT');
        mutator.close();
        controlStore.compareAndAppend(preparedResult.digest, {
          type: 'sqlite.tx.committed',
          payload: {
            ...commonNativePayload(fixture, recoveryEpoch),
            preparedDigest: preparedResult.digest,
            finalSeq: 2,
            schemaVersion: 11,
            backend: 'native-sqlite-v2',
            gateEmpty: true,
            triggerVersion: 1,
            triggerSetDigest: genesis.payload.triggerSetDigest,
            postCommitIdentity: genesis.payload.identity,
          },
        });
      } else {
        controlStore.compareAndAppend(preparedResult.digest, {
          type: 'sqlite.tx.rolled_back',
          payload: {
            ...commonNativePayload(fixture, recoveryEpoch),
            preparedDigest: preparedResult.digest,
            beforeSeq: 1,
            reasonCode: 'crash_recovery',
            rollbackKind: 'recovery_before_commit',
            predicate: {
              autocommit: true,
              hotJournalRecovered: true,
              schemaVersion: 11,
              backend: 'native-sqlite-v2',
              finalSeq: 1,
              gateEmpty: true,
              triggerVersion: 1,
              triggerSetDigest: genesis.payload.triggerSetDigest,
              identity: genesis.payload.identity,
            },
          },
        });
      }
      second.close();

      let reopened;
      const shouldOpen = epochKind === 'fresh'
        || (terminalKind === 'committed' && epochKind === 'current-attempt');
      if (shouldOpen) {
        reopened = createStageBFixtureStore(fixture);
        assert.equal(reopened.state, 'active', `${terminalKind}:${epochKind}`);
        reopened.close();
      } else {
        assert.throws(
          () => {
            reopened = createStageBFixtureStore(fixture);
          },
          (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
          `${terminalKind}:${epochKind}`,
        );
        if (reopened?.state === 'active') reopened.close();
      }
    }
  }
});

test('review fix I4: unresolved prepared reopens cold and recovers before and after real COMMIT', (t) => {
  for (const mode of ['before-real-commit', 'after-real-commit']) {
    const fixture = nativeFixture(t, `native-store-review-reopen-${mode}`);
    let raw;
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        raw = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() {
            return raw.inTransaction;
          },
          query(sql) {
            return raw.query(sql);
          },
          exec(sql) {
            if (sql === 'COMMIT') {
              if (mode === 'after-real-commit') raw.exec(sql);
              const error = new Error(mode);
              error.code = 'REVIEW_COMMIT_WRAPPER_THROW';
              throw error;
            }
            return raw.exec(sql);
          },
          close() {
            return raw.close();
          },
        };
      },
    });
    const source = appendSource(fixture, store, {
      logicalRequestDigest: sha256(`review-reopen:${mode}`),
    });
    assert.throws(
      () => store.executeTransaction(exactExecuteInput(source), () => undefined),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      mode,
    );
    assert.equal(store.state, 'fenced', mode);
    const controlStore = openControlStore(fixture.controlDirectory);
    const prepared = controlStore.tail();
    assert.equal(prepared.type, 'sqlite.tx.prepared', mode);
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    assert.deepEqual(
      inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(),
      { value: mode === 'after-real-commit' ? '1' : '0' },
      mode,
    );
    inspector.close();

    let recoveryOpenCount = 0;
    const reopened = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        recoveryOpenCount += 1;
        return new Database(databasePath, { create: false, strict: true });
      },
    });
    assert.equal(reopened.state, 'recovery_required', mode);
    assert.equal(reopened.connectionEpoch, null, mode);
    assert.equal(recoveryOpenCount, 0, mode);
    const result = reopened.recover();
    const terminal = controlStore.tail();
    const expectedStatus = mode === 'after-real-commit' ? 'committed' : 'rolled_back';
    const expectedFinalSeq = mode === 'after-real-commit' ? 1 : 0;
    assert.deepEqual(result, {
      status: expectedStatus,
      preparedDigest: prepared.digest,
      terminalDigest: terminal.digest,
      finalSeq: expectedFinalSeq,
      connectionEpoch: reopened.connectionEpoch,
    }, mode);
    assert.equal(
      terminal.type,
      mode === 'after-real-commit' ? 'sqlite.tx.committed' : 'sqlite.tx.rolled_back',
      mode,
    );
    assert.equal(terminal.payload.preparedDigest, prepared.digest, mode);
    assert.equal(recoveryOpenCount, 1, mode);
    assert.equal(reopened.state, 'active', mode);
    reopened.close();
  }
});

test('review fix I5: exact prepared and terminal schemas reject missing, extra, type, range, and identity drift', { timeout: 30_000 }, (t) => {
  const fixture = nativeFixture(t, 'native-store-review-exact-terminal-matrix');
  const [genesis] = openControlStore(fixture.controlDirectory).read();
  const sourceEpoch = randomUUID();
  const source = syntheticEvent(
    2,
    'manuscript.source',
    sourcePayload(fixture, sourceEpoch),
    sha256('review-exact-source'),
    genesis.digest,
  );
  const prepared = syntheticEvent(
    3,
    'sqlite.tx.prepared',
    exactPreparedPayload(fixture, sourceEpoch, source),
    sha256('review-exact-prepared'),
    source.digest,
  );
  const terminalBases = [
    {
      name: 'prepared',
      events: [genesis, source, prepared],
      eventIndex: 2,
      mutations: {
        missing: (payload) => { delete payload.transactionId; },
        extra: (payload) => { payload.unexpected = true; },
        type: (payload) => { payload.expectedGateEmpty = 'true'; },
        range: (payload) => { payload.beforeSeq = -1; },
        identity: (payload) => { payload.expectedIdentity.dev = 'not-decimal'; },
      },
    },
    {
      name: 'committed',
      type: 'sqlite.tx.committed',
      terminalKind: 'committed',
      connectionEpoch: sourceEpoch,
      mutations: {
        missing: (payload) => { delete payload.preparedDigest; },
        extra: (payload) => { payload.unexpected = true; },
        type: (payload) => { payload.gateEmpty = 'true'; },
        range: (payload) => { payload.finalSeq = 0; },
        identity: (payload) => { payload.postCommitIdentity.ino = 'not-decimal'; },
      },
    },
    ...['begin_not_acquired', 'transaction_rolled_back', 'recovery_before_commit'].map((terminalKind) => ({
      name: terminalKind,
      type: 'sqlite.tx.rolled_back',
      terminalKind,
      connectionEpoch: terminalKind === 'recovery_before_commit' ? randomUUID() : sourceEpoch,
      mutations: {
        missing: (payload) => { delete payload.predicate.autocommit; },
        extra: (payload) => { payload.predicate.unexpected = true; },
        type: (payload) => { payload.predicate.autocommit = 'true'; },
        range: (payload) => { payload.beforeSeq = -1; },
        identity: (payload) => { payload.predicate.identity.dev = 'not-decimal'; },
      },
    })),
  ];

  function assertEvidenceRejected(events, label) {
    let identityCalls = 0;
    assert.throws(
      () => createNativeProjectStoreCore({
        databasePath: fixture.databasePath,
        controlStore: { read: () => events, assertCurrent: () => true },
        dbKey: genesis.payload.dbKey,
        projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
        ownershipHash: genesis.payload.ownershipHash,
        assertWriterLease: () => true,
        admissionVerifier: () => ({
          basisKind: 'stage_b_fixture_genesis',
          basisDigest: genesis.digest,
        }),
        identityApi() {
          identityCalls += 1;
          throw new Error('invalid evidence must be rejected before identity open');
        },
        sqliteFactory() {
          throw new Error('invalid evidence must be rejected before SQLite open');
        },
      }),
      (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
      label,
    );
    assert.equal(identityCalls, 0, label);
  }

  for (const terminalBase of terminalBases) {
    const baseEvents = terminalBase.events || [
      genesis,
      source,
      prepared,
      syntheticEvent(
        4,
        terminalBase.type,
        exactTerminalPayload(
          fixture,
          terminalBase.connectionEpoch,
          prepared,
          terminalBase.terminalKind,
        ),
        sha256(`review-exact-${terminalBase.name}`),
        prepared.digest,
      ),
    ];
    for (const [mutationName, mutate] of Object.entries(terminalBase.mutations)) {
      const events = JSON.parse(JSON.stringify(baseEvents));
      mutate(events[terminalBase.eventIndex ?? 3].payload);
      assertEvidenceRejected(events, `${terminalBase.name}:${mutationName}`);
    }
  }

  const abandoned = syntheticEvent(
    3,
    'manuscript.source.abandoned',
    {
      ...commonNativePayload(fixture, sourceEpoch),
      sourceDigest: source.digest,
      reasonCode: 'cancelled',
    },
    sha256('review-exact-abandoned'),
    source.digest,
  );
  const extraCases = [
    { name: 'event-missing-key', events: [genesis, source], mutate: (events) => { delete events[1].prevDigest; } },
    { name: 'event-extra-key', events: [genesis, source], mutate: (events) => { events[1].unexpected = true; } },
    { name: 'event-seq-range', events: [genesis, source], mutate: (events) => { events[1].seq = 0; } },
    { name: 'source-non-plain-payload', events: [genesis, source], mutate: (events) => { events[1].payload = []; } },
    { name: 'abandoned-missing-key', events: [genesis, source, abandoned], mutate: (events) => { delete events[2].payload.reasonCode; } },
    { name: 'abandoned-extra-key', events: [genesis, source, abandoned], mutate: (events) => { events[2].payload.unexpected = true; } },
    { name: 'abandoned-type', events: [genesis, source, abandoned], mutate: (events) => { events[2].payload.sourceDigest = null; } },
    { name: 'abandoned-enum', events: [genesis, source, abandoned], mutate: (events) => { events[2].payload.reasonCode = 'unknown'; } },
    { name: 'abandoned-owner', events: [genesis, source, abandoned], mutate: (events) => { events[2].payload.ownershipHash = sha256('wrong-owner'); } },
  ];
  for (const current of extraCases) {
    const events = JSON.parse(JSON.stringify(current.events));
    current.mutate(events);
    assertEvidenceRejected(events, current.name);
  }
});

test('review fix I5: live commit sequence is one canonical decimal TEXT matching the suffix projector', { timeout: 30_000 }, (t) => {
  const fixture = nativeFixture(t, 'native-store-review-canonical-seq');
  const first = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, first);
  appendAbandoned(fixture, first, source);
  first.close();
  const raw = new Database(fixture.databasePath, { create: false, strict: true });
  t.after(() => raw.close());

  function gatedWrite(action) {
    raw.exec('BEGIN IMMEDIATE');
    raw.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
    action();
    raw.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
    raw.exec('COMMIT');
  }

  function restoreCanonicalZero() {
    gatedWrite(() => {
      const exists = raw.query("SELECT COUNT(*) AS count FROM project_meta WHERE key = 'durability_commit_seq'").get().count;
      if (exists === 0) {
        raw.query("INSERT INTO project_meta (key, value) VALUES ('durability_commit_seq', '0')").run();
      } else {
        raw.query("UPDATE project_meta SET value = '0' WHERE key = 'durability_commit_seq'").run();
      }
    });
  }

  const cases = [
    {
      name: 'missing',
      apply: () => gatedWrite(() => raw.query("DELETE FROM project_meta WHERE key = 'durability_commit_seq'").run()),
    },
    {
      name: 'non-text',
      apply: () => gatedWrite(() => raw.query("UPDATE project_meta SET value = CAST(X'31' AS BLOB) WHERE key = 'durability_commit_seq'").run()),
    },
    ...['01', ' 1', '+1', '1e0', '9007199254740992', '1'].map((value, index) => ({
      name: index === 5 ? 'projector-mismatch' : `raw-${JSON.stringify(value)}`,
      apply: () => gatedWrite(() => raw.query("UPDATE project_meta SET value = ? WHERE key = 'durability_commit_seq'").run(value)),
    })),
  ];
  for (const current of cases) {
    current.apply();
    assert.throws(
      () => createStageBFixtureStore(fixture),
      (error) => error?.code === 'NATIVE_CONNECTION_REJECTED',
      current.name,
    );
    restoreCanonicalZero();
  }

  assert.throws(
    () => createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        const database = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() { return database.inTransaction; },
          exec(sql) { return database.exec(sql); },
          query(sql) {
            const statement = database.query(sql);
            return {
              all(...params) {
                const rows = statement.all(...params);
                if (!sql.startsWith('SELECT key, value, typeof(value) AS storageType FROM project_meta')) return rows;
                return [...rows, { ...rows.find(({ key }) => key === 'durability_commit_seq') }];
              },
              get: (...params) => statement.get(...params),
              run: (...params) => statement.run(...params),
            };
          },
          close() { return database.close(); },
        };
      },
    }),
    (error) => error?.code === 'NATIVE_CONNECTION_REJECTED',
    'duplicate durability_commit_seq row',
  );
});

test('review fix I5: prepared CAS distinguishes a proven consumer from append and post-check uncertainty', { timeout: 30_000 }, (t) => {
  for (const mode of ['consumer-conflict', 'append-throw', 'publish-throw', 'postcheck-throw']) {
    const fixture = nativeFixture(t, `native-store-review-prepared-${mode}`);
    const underlying = openControlStore(fixture.controlDirectory);
    let source;
    let failPostcheck = false;
    const controlStore = {
      read() {
        if (failPostcheck) {
          failPostcheck = false;
          throw Object.assign(new Error('prepared post-check read failed'), { code: 'CONTROL_STORE_READ_FAILED' });
        }
        return underlying.read();
      },
      assertCurrent: () => underlying.assertCurrent(),
      compareAndAppend(expectedDigest, event) {
        if (event.type !== 'sqlite.tx.prepared') {
          return underlying.compareAndAppend(expectedDigest, event);
        }
        if (mode === 'consumer-conflict') {
          underlying.compareAndAppend(source.digest, {
            type: 'manuscript.source.abandoned',
            payload: {
              ...commonNativePayload(fixture, source.payload.connectionEpoch),
              sourceDigest: source.digest,
              reasonCode: 'cancelled',
            },
          });
        }
        if (mode === 'append-throw') {
          throw Object.assign(new Error('prepared append failed'), { code: 'CONTROL_STORE_WRITE_FAILED' });
        }
        const appended = underlying.compareAndAppend(expectedDigest, event);
        if (mode === 'publish-throw') {
          throw Object.assign(new Error('prepared publish result unknown'), { code: 'CONTROL_STORE_PUBLISH_FAILED' });
        }
        if (mode === 'postcheck-throw') failPostcheck = true;
        return appended;
      },
    };
    const trace = [];
    const sqliteState = {};
    const store = createCoreFixtureStore(fixture, {
      controlStore,
      sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
    });
    underlying.compareAndAppend(underlying.tail().digest, {
      type: 'manuscript.source',
      payload: sourcePayload(fixture, store.connectionEpoch, {
        logicalRequestDigest: sha256(`prepared-cas:${mode}`),
      }),
    });
    source = underlying.tail();
    sqliteState.capture = true;
    let callbackCalled = false;

    assert.throws(
      () => store.executeTransaction(exactExecuteInput(source), () => { callbackCalled = true; }),
      (error) => error?.code === (mode === 'consumer-conflict'
        ? 'NATIVE_SOURCE_NOT_CURRENT'
        : 'RECOVERY_REQUIRED'),
      mode,
    );
    assert.equal(callbackCalled, false, mode);
    assert.equal(trace.filter((entry) => entry === 'exec:BEGIN IMMEDIATE').length, 0, mode);
    assert.equal(trace.filter((entry) => entry === 'exec:ROLLBACK').length, 0, mode);
    assert.equal(trace.filter((entry) => entry === 'exec:COMMIT').length, 0, mode);
    assert.equal(store.state, mode === 'consumer-conflict' ? 'active' : 'fenced', mode);
    assert.equal(
      underlying.tail().type,
      mode === 'consumer-conflict'
        ? 'manuscript.source.abandoned'
        : mode === 'append-throw'
          ? 'manuscript.source'
          : 'sqlite.tx.prepared',
      mode,
    );
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    assert.deepEqual(inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(), { value: '0' }, mode);
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0, mode);
    inspector.close();
    if (store.state === 'active') store.close();
  }
});

test('review fix I5: gate insert, sequence CAS, and gate delete require one exact changed row', { timeout: 30_000 }, (t) => {
  const targets = {
    gate: { sql: 'INSERT INTO "_durability_write_gate"', changes: 0 },
    sequence: { sql: "UPDATE project_meta SET value = ? WHERE key = 'durability_commit_seq'", changes: 2 },
    delete: { sql: 'DELETE FROM "_durability_write_gate"', changes: undefined },
  };
  for (const [name, target] of Object.entries(targets)) {
    const fixture = nativeFixture(t, `native-store-review-inexact-${name}`);
    let raw;
    let beginCalls = 0;
    let rollbackCalls = 0;
    let commitCalls = 0;
    let callbackCalls = 0;
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        raw = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() { return raw.inTransaction; },
          exec(sql) {
            if (sql === 'BEGIN IMMEDIATE') beginCalls += 1;
            if (sql === 'ROLLBACK') rollbackCalls += 1;
            if (sql === 'COMMIT') commitCalls += 1;
            return raw.exec(sql);
          },
          query(sql) {
            const statement = raw.query(sql);
            return {
              all: (...params) => statement.all(...params),
              get: (...params) => statement.get(...params),
              run(...params) {
                const result = statement.run(...params);
                return sql.startsWith(target.sql) ? { ...result, changes: target.changes } : result;
              },
            };
          },
          close() { return raw.close(); },
        };
      },
    });
    t.after(() => {
      if (store.state === 'active') store.close();
    });
    const source = appendSource(fixture, store, {
      logicalRequestDigest: sha256(`inexact-row-count:${name}`),
    });
    assert.throws(
      () => store.executeTransaction(exactExecuteInput(source), (transaction) => {
        callbackCalls += 1;
        transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', `inexact-${name}`, name);
      }),
      (error) => error?.code === 'NATIVE_CONNECTION_REJECTED',
      name,
    );
    assert.equal(callbackCalls, name === 'gate' ? 0 : 1, name);
    assert.equal(beginCalls, 1, name);
    assert.equal(rollbackCalls, 1, name);
    assert.equal(commitCalls, 0, name);
    assert.equal(store.state, 'active', name);
    assert.equal(openControlStore(fixture.controlDirectory).tail().payload.rollbackKind, 'transaction_rolled_back', name);
    assert.deepEqual(store.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '0' }, name);
    assert.equal(raw.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0, name);
    assert.equal(store.readGet('SELECT COUNT(*) AS count FROM characters WHERE id = ?', `inexact-${name}`).count, 0, name);
    store.close();
  }
});

test('review fix I5: unknown BEGIN and uncertain rollback predicates fence without a terminal', { timeout: 30_000 }, (t) => {
  const cases = [
    { name: 'begin-throw', phase: 'begin' },
    { name: 'begin-return-no-transaction', phase: 'begin' },
    { name: 'rollback-throw', phase: 'rollback' },
    { name: 'rollback-autocommit-unknown', phase: 'rollback' },
    { name: 'rollback-predicate-mismatch', phase: 'rollback' },
  ];
  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-review-${current.name}`);
    let raw;
    let rollbackCalls = 0;
    let commitCalls = 0;
    let beginCalls = 0;
    let afterRollback = false;
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        raw = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() {
            if (current.name === 'rollback-autocommit-unknown' && afterRollback) {
              throw Object.assign(new Error('autocommit unreadable'), { code: 'AUTOCOMMIT_UNKNOWN' });
            }
            return raw.inTransaction;
          },
          exec(sql) {
            if (sql === 'BEGIN IMMEDIATE') beginCalls += 1;
            if (sql === 'BEGIN IMMEDIATE' && current.name === 'begin-throw') {
              throw Object.assign(new Error('BEGIN result unknown'), { code: 'BEGIN_UNKNOWN' });
            }
            if (sql === 'BEGIN IMMEDIATE' && current.name === 'begin-return-no-transaction') return undefined;
            if (sql === 'ROLLBACK') {
              rollbackCalls += 1;
              if (current.name === 'rollback-throw') {
                throw Object.assign(new Error('ROLLBACK result unknown'), { code: 'ROLLBACK_UNKNOWN' });
              }
              const result = raw.exec(sql);
              afterRollback = true;
              return result;
            }
            if (sql === 'COMMIT') commitCalls += 1;
            return raw.exec(sql);
          },
          query(sql) {
            const statement = raw.query(sql);
            return {
              all(...params) {
                const rows = statement.all(...params);
                if (
                  current.name === 'rollback-predicate-mismatch'
                  && afterRollback
                  && sql.startsWith('SELECT key, value, typeof(value) AS storageType FROM project_meta')
                ) {
                  return rows.map((row) => row.key === 'durability_commit_seq'
                    ? { ...row, value: '1' }
                    : row);
                }
                return rows;
              },
              get: (...params) => statement.get(...params),
              run: (...params) => statement.run(...params),
            };
          },
          close() { return raw.close(); },
        };
      },
    });
    const source = appendSource(fixture, store, {
      logicalRequestDigest: sha256(`uncertain:${current.name}`),
    });
    let callbackCalled = false;
    assert.throws(
      () => store.executeTransaction(exactExecuteInput(source), (transaction) => {
        callbackCalled = true;
        if (current.phase === 'begin') assert.fail('BEGIN uncertainty must precede callback');
        transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', current.name, current.name);
        throw Object.assign(new Error('force rollback'), { code: 'CALLBACK_FAILED' });
      }),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      current.name,
    );
    assert.equal(beginCalls, 1, current.name);
    assert.equal(callbackCalled, current.phase === 'rollback', current.name);
    assert.equal(rollbackCalls, current.phase === 'begin' ? 0 : 1, current.name);
    assert.equal(commitCalls, 0, current.name);
    assert.equal(store.state, 'fenced', current.name);
    assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'sqlite.tx.prepared', current.name);
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    assert.deepEqual(inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(), { value: '0' }, current.name);
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0, current.name);
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM characters WHERE id = ?').get(current.name).count, 0, current.name);
    inspector.close();
  }
});

test('review fix I5: post-COMMIT autocommit and live-read uncertainty never expose callback success', { timeout: 30_000 }, (t) => {
  for (const mode of ['autocommit-not-proven', 'live-read-io']) {
    const fixture = nativeFixture(t, `native-store-review-postcommit-${mode}`);
    let raw;
    let committed = false;
    let rollbackCalls = 0;
    let commitCalls = 0;
    let beginCalls = 0;
    let callbackSuccessVisible = false;
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        raw = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() {
            if (committed && mode === 'autocommit-not-proven') return true;
            return raw.inTransaction;
          },
          exec(sql) {
            if (sql === 'BEGIN IMMEDIATE') beginCalls += 1;
            if (sql === 'ROLLBACK') rollbackCalls += 1;
            if (sql === 'COMMIT') {
              commitCalls += 1;
              const result = raw.exec(sql);
              committed = true;
              return result;
            }
            return raw.exec(sql);
          },
          query(sql) {
            if (
              committed
              && mode === 'live-read-io'
              && sql.startsWith('SELECT key, value, typeof(value) AS storageType FROM project_meta')
            ) {
              throw Object.assign(new Error('post-COMMIT read failed'), { code: 'SQLITE_IOERR' });
            }
            return raw.query(sql);
          },
          close() { return raw.close(); },
        };
      },
    });
    const source = appendSource(fixture, store, {
      logicalRequestDigest: sha256(`postcommit:${mode}`),
    });
    assert.throws(
      () => {
        const result = store.executeTransaction(exactExecuteInput(source), (transaction) => {
          transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', `postcommit-${mode}`, mode);
          return 'must-not-escape';
        });
        callbackSuccessVisible = result === 'must-not-escape';
      },
      (error) => error?.code === 'RECOVERY_REQUIRED',
      mode,
    );
    assert.equal(callbackSuccessVisible, false, mode);
    assert.equal(beginCalls, 1, mode);
    assert.equal(rollbackCalls, 0, mode);
    assert.equal(commitCalls, 1, mode);
    assert.equal(store.state, 'fenced', mode);
    assert.equal(openControlStore(fixture.controlDirectory).tail().type, 'sqlite.tx.prepared', mode);
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    assert.deepEqual(inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(), { value: '1' }, mode);
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0, mode);
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM characters WHERE id = ?').get(`postcommit-${mode}`).count, 1, mode);
    inspector.close();
  }
});

test('review fix I5: committed and rolled-back terminal uncertainty preserves the exact durable frontier', { timeout: 45_000 }, (t) => {
  for (const terminalKind of ['committed', 'rolled_back']) {
    for (const mode of ['before-publish', 'after-publish', 'postcheck']) {
      const fixture = nativeFixture(t, `native-store-review-terminal-${terminalKind}-${mode}`);
      const underlying = openControlStore(fixture.controlDirectory);
      let failPostcheck = false;
      const controlStore = {
        read() {
          if (failPostcheck) {
            failPostcheck = false;
            throw Object.assign(new Error('terminal post-check failed'), { code: 'CONTROL_STORE_READ_FAILED' });
          }
          return underlying.read();
        },
        assertCurrent: () => underlying.assertCurrent(),
        compareAndAppend(expectedDigest, event) {
          const isTerminal = event.type === 'sqlite.tx.committed' || event.type === 'sqlite.tx.rolled_back';
          if (isTerminal && mode === 'before-publish') {
            throw Object.assign(new Error('terminal append failed'), { code: 'CONTROL_STORE_WRITE_FAILED' });
          }
          const appended = underlying.compareAndAppend(expectedDigest, event);
          if (isTerminal && mode === 'after-publish') {
            throw Object.assign(new Error('terminal publish result unknown'), { code: 'CONTROL_STORE_PUBLISH_FAILED' });
          }
          if (isTerminal && mode === 'postcheck') failPostcheck = true;
          return appended;
        },
      };
      const trace = [];
      const sqliteState = {};
      const store = createCoreFixtureStore(fixture, {
        controlStore,
        sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
      });
      underlying.compareAndAppend(underlying.tail().digest, {
        type: 'manuscript.source',
        payload: sourcePayload(fixture, store.connectionEpoch, {
          logicalRequestDigest: sha256(`terminal:${terminalKind}:${mode}`),
        }),
      });
      const source = underlying.tail();
      sqliteState.capture = true;
      let callbackSuccessVisible = false;
      assert.throws(
        () => {
          const result = store.executeTransaction(exactExecuteInput(source), (transaction) => {
            transaction.run('INSERT INTO characters (id, name) VALUES (?, ?)', `terminal-${terminalKind}-${mode}`, mode);
            if (terminalKind === 'rolled_back') {
              throw Object.assign(new Error('callback failed'), { code: 'CALLBACK_FAILED' });
            }
            return 'must-not-escape';
          });
          callbackSuccessVisible = result === 'must-not-escape';
        },
        (error) => error?.code === 'RECOVERY_REQUIRED',
        `${terminalKind}:${mode}`,
      );
      assert.equal(callbackSuccessVisible, false, `${terminalKind}:${mode}`);
      assert.equal(trace.filter((entry) => entry === 'exec:BEGIN IMMEDIATE').length, 1, `${terminalKind}:${mode}`);
      assert.equal(trace.filter((entry) => entry === 'exec:ROLLBACK').length, terminalKind === 'rolled_back' ? 1 : 0, `${terminalKind}:${mode}`);
      assert.equal(trace.filter((entry) => entry === 'exec:COMMIT').length, terminalKind === 'committed' ? 1 : 0, `${terminalKind}:${mode}`);
      assert.equal(store.state, 'fenced', `${terminalKind}:${mode}`);
      assert.equal(
        underlying.tail().type,
        mode === 'before-publish'
          ? 'sqlite.tx.prepared'
          : terminalKind === 'committed'
            ? 'sqlite.tx.committed'
            : 'sqlite.tx.rolled_back',
        `${terminalKind}:${mode}`,
      );
      const inspector = new Database(fixture.databasePath, { create: false, strict: true });
      assert.deepEqual(
        inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(),
        { value: terminalKind === 'committed' ? '1' : '0' },
        `${terminalKind}:${mode}`,
      );
      assert.equal(inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0, `${terminalKind}:${mode}`);
      assert.equal(
        inspector.query('SELECT COUNT(*) AS count FROM characters WHERE id = ?').get(`terminal-${terminalKind}-${mode}`).count,
        terminalKind === 'committed' ? 1 : 0,
        `${terminalKind}:${mode}`,
      );
      inspector.close();
    }
  }
});

test('review fix I5: all nine transaction fault points expose exact safe context at frozen boundaries', { timeout: 60_000 }, async (t) => {
  const matrix = [
    {
      name: 'after-prepared',
      point: FAULT_POINTS.NATIVE_TX_AFTER_PREPARED_POSTCHECK,
      flags: [false, false, false, false, false, false],
      begin: 0,
      rollback: 0,
      commit: 0,
      callback: false,
      outcome: 'uncertain',
    },
    {
      name: 'after-begin',
      point: FAULT_POINTS.NATIVE_TX_AFTER_BEGIN_ACQUIRED,
      flags: [true, false, false, false, false, false],
      begin: 1,
      rollback: 1,
      commit: 0,
      callback: false,
      outcome: 'rollback',
    },
    {
      name: 'after-gate',
      point: FAULT_POINTS.NATIVE_TX_AFTER_GATE_INSERT,
      flags: [true, true, false, false, false, false],
      begin: 1,
      rollback: 1,
      commit: 0,
      callback: false,
      outcome: 'rollback',
    },
    {
      name: 'after-business',
      point: FAULT_POINTS.NATIVE_TX_AFTER_BUSINESS_CALLBACK,
      flags: [true, true, true, false, false, false],
      begin: 1,
      rollback: 1,
      commit: 0,
      callback: true,
      outcome: 'rollback',
    },
    {
      name: 'after-seq',
      point: FAULT_POINTS.NATIVE_TX_AFTER_SEQ_CAS,
      flags: [true, true, true, true, false, false],
      begin: 1,
      rollback: 1,
      commit: 0,
      callback: true,
      outcome: 'rollback',
    },
    {
      name: 'after-gate-delete',
      point: FAULT_POINTS.NATIVE_TX_AFTER_GATE_DELETE,
      flags: [true, true, true, true, true, false],
      begin: 1,
      rollback: 1,
      commit: 0,
      callback: true,
      outcome: 'rollback',
    },
    {
      name: 'before-commit',
      point: FAULT_POINTS.NATIVE_TX_BEFORE_COMMIT_INVOKE,
      flags: [true, true, true, true, true, false],
      begin: 1,
      rollback: 1,
      commit: 0,
      callback: true,
      outcome: 'rollback',
    },
    {
      name: 'after-commit',
      point: FAULT_POINTS.NATIVE_TX_AFTER_COMMIT_RETURN,
      flags: [true, true, true, true, true, true],
      begin: 1,
      rollback: 0,
      commit: 1,
      callback: true,
      outcome: 'uncertain',
    },
    {
      name: 'before-terminal',
      point: FAULT_POINTS.NATIVE_TX_BEFORE_TERMINAL_APPEND,
      flags: [true, true, true, true, true, true],
      begin: 1,
      rollback: 0,
      commit: 1,
      callback: true,
      outcome: 'uncertain',
    },
  ];
  const contextKeys = [
    'transactionId',
    'sourceDigest',
    'preparedDigest',
    'beforeSeq',
    'expectedFinalSeq',
    'writeLockAcquired',
    'gateSqlExecuted',
    'businessSqlExecuted',
    'seqSqlExecuted',
    'gateDeleteSqlExecuted',
    'commitInvoked',
  ].sort();
  const flagKeys = [
    'writeLockAcquired',
    'gateSqlExecuted',
    'businessSqlExecuted',
    'seqSqlExecuted',
    'gateDeleteSqlExecuted',
    'commitInvoked',
  ];

  for (const current of matrix) {
    const fixture = nativeFixture(t, `native-store-review-fault-${current.name}`);
    const trace = [];
    const sqliteState = {};
    const store = createStageBFixtureStore(fixture, {
      sqliteFactory: tracingSqliteFactory(fixture, trace, sqliteState),
    });
    t.after(() => {
      if (store.state === 'active') store.close();
    });
    const source = appendSource(fixture, store, {
      logicalRequestDigest: sha256(`fault-matrix:${current.name}`),
    });
    const privateBody = `private-body-${current.name}`;
    const privateParam = `private-param-${current.name}`;
    let observedContext;
    let callbackCalled = false;
    let callbackSuccessVisible = false;
    sqliteState.capture = true;
    await assert.rejects(
      () => withFaults({
        [current.point]: {
          callback(context) { observedContext = context; },
          throw: 'FAULT_MATRIX',
        },
      }, () => {
        const result = store.executeTransaction(exactExecuteInput(source), (transaction) => {
          callbackCalled = true;
          transaction.run(
            'INSERT INTO characters (id, name, background) VALUES (?, ?, ?)',
            `fault-${current.name}`,
            privateParam,
            privateBody,
          );
          return 'must-not-escape';
        });
        callbackSuccessVisible = result === 'must-not-escape';
      }),
      (error) => error?.code === (current.outcome === 'rollback' ? 'FAULT_MATRIX' : 'RECOVERY_REQUIRED'),
      current.name,
    );
    assert.equal(callbackCalled, current.callback, current.name);
    assert.equal(callbackSuccessVisible, false, current.name);
    assert.equal(trace.filter((entry) => entry === 'exec:BEGIN IMMEDIATE').length, current.begin, current.name);
    assert.equal(trace.filter((entry) => entry === 'exec:ROLLBACK').length, current.rollback, current.name);
    assert.equal(trace.filter((entry) => entry === 'exec:COMMIT').length, current.commit, current.name);
    assert.equal(store.state, current.outcome === 'rollback' ? 'active' : 'fenced', current.name);
    assert.deepEqual(Object.keys(observedContext).sort(), contextKeys, current.name);
    assert.equal(Object.isFrozen(observedContext), true, current.name);
    assert.match(observedContext.transactionId, /^[0-9a-f-]{36}$/i, current.name);
    assert.equal(observedContext.sourceDigest, source.digest, current.name);
    assert.match(observedContext.preparedDigest, /^[0-9a-f]{64}$/, current.name);
    assert.equal(observedContext.beforeSeq, 0, current.name);
    assert.equal(observedContext.expectedFinalSeq, 1, current.name);
    flagKeys.forEach((key, index) => assert.equal(observedContext[key], current.flags[index], `${current.name}:${key}`));
    const serializedContext = JSON.stringify(observedContext);
    for (const secret of ['INSERT INTO', privateParam, privateBody, fixture.databasePath, 'params']) {
      assert.equal(serializedContext.includes(secret), false, `${current.name}:${secret}`);
    }
    assert.equal(
      openControlStore(fixture.controlDirectory).tail().type,
      current.outcome === 'rollback' ? 'sqlite.tx.rolled_back' : 'sqlite.tx.prepared',
      current.name,
    );
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    assert.deepEqual(
      inspector.query("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'").get(),
      { value: current.commit === 1 ? '1' : '0' },
      current.name,
    );
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0, current.name);
    assert.equal(
      inspector.query('SELECT COUNT(*) AS count FROM characters WHERE id = ?').get(`fault-${current.name}`).count,
      current.commit,
      current.name,
    );
    inspector.close();
    if (store.state === 'active') store.close();
  }
});

test('core re-invokes the admission capability before open and before cached facade use', (t) => {
  const fixture = nativeFixture(t, 'native-store-admission-recheck');
  const controlStore = openControlStore(fixture.controlDirectory);
  const [genesis] = controlStore.read();
  const { payload } = genesis;
  let admissionCalls = 0;
  const store = createNativeProjectStoreCore({
    databasePath: fixture.databasePath,
    controlStore,
    dbKey: payload.dbKey,
    projectInstanceIdSha256: payload.projectInstanceIdSha256,
    ownershipHash: payload.ownershipHash,
    assertWriterLease: () => true,
    admissionVerifier({ evidence }) {
      admissionCalls += 1;
      if (evidence.length !== 1 || evidence[0].digest !== genesis.digest) {
        throw new Error('inexact fixture evidence');
      }
      return {
        basisKind: 'stage_b_fixture_genesis',
        basisDigest: genesis.digest,
      };
    },
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });

  assert.ok(admissionCalls >= 2, `admission was checked only ${admissionCalls} time(s) before open`);
  const callsAfterOpen = admissionCalls;
  assert.deepEqual(store.readGet('SELECT 1 AS value'), { value: 1 });
  assert.ok(admissionCalls > callsAfterOpen);
});

test('testing factory preserves the writer-lease capability for every epoch check', (t) => {
  const fixture = nativeFixture(t, 'native-store-writer-lease');
  let leaseChecks = 0;
  const store = createStageBFixtureStore(fixture, {
    assertWriterLease() {
      leaseChecks += 1;
      return true;
    },
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });

  assert.ok(leaseChecks >= 1);
  const checksAfterOpen = leaseChecks;
  assert.deepEqual(store.readGet('SELECT 1 AS value'), { value: 1 });
  assert.ok(leaseChecks > checksAfterOpen);
});

test('testing factory rejects copied, wrong, or incomplete fixture genesis claims', (t) => {
  const fixture = nativeFixture(t, 'native-store-admission');
  for (const claim of [
    {},
    { ...fixture, fixtureRunId: randomUUID() },
    { ...fixture, genesisDigest: '0'.repeat(64) },
    { ...fixture, extra: true },
  ]) {
    assert.throws(
      () => createStageBFixtureStore(claim),
      (error) => error?.code === 'NATIVE_ACTIVATION_DISABLED' || error?.code === 'NATIVE_ADMISSION_REJECTED',
    );
  }
});

test('testing factory rejects a genesis event with an extra afterPredicate field', (t) => {
  const fixture = nativeFixture(t, 'native-store-genesis-extra');
  const original = openControlStore(fixture.controlDirectory);
  const [genesis] = original.read();
  original.retireAndActivate(
    `${fixture.controlDirectory}.retired-${randomUUID()}`,
    (events) => assert.equal(events.length, 1),
  );
  const replacement = openControlStore(fixture.controlDirectory);
  const appended = replacement.compareAndAppend(null, {
    type: genesis.type,
    payload: genesis.payload,
    afterPredicate: { unexpected: true },
  });
  const inexactFixture = Object.freeze({ ...fixture, genesisDigest: appended.digest });

  let escapedStore;
  try {
    escapedStore = createStageBFixtureStore(inexactFixture);
    assert.fail('inexact genesis unexpectedly opened');
  } catch (error) {
    assert.equal(error?.code, 'NATIVE_ADMISSION_REJECTED');
  } finally {
    if (escapedStore?.state === 'active') escapedStore.close();
  }
});

test('close and fence invalidate cached facade methods and connection epochs', (t) => {
  const fixture = nativeFixture(t, 'native-store-lifecycle');
  const first = createStageBFixtureStore(fixture);
  const firstEpoch = first.connectionEpoch;
  first.close();
  assert.equal(first.state, 'released');
  assert.throws(
    () => first.readGet('SELECT 1 AS value'),
    (error) => error?.code === 'NATIVE_STORE_RELEASED',
  );

  const second = createStageBFixtureStore(fixture);
  assert.notEqual(second.connectionEpoch, firstEpoch);
  second.fence();
  assert.equal(second.state, 'fenced');
  assert.throws(
    () => second.readGet('SELECT 1 AS value'),
    (error) => error?.code === 'NATIVE_STORE_FENCED',
  );
});

test('external busy is bounded by 100ms and the caller second attempt fails immediately', (t) => {
  const fixture = nativeFixture(t, 'native-store-busy');
  const store = createStageBFixtureStore(fixture);
  const blocker = new Database(fixture.databasePath, { create: false, strict: true });
  blocker.exec('PRAGMA busy_timeout = 100');
  blocker.exec('BEGIN EXCLUSIVE');
  t.after(() => {
    try {
      blocker.exec('ROLLBACK');
    } catch {
      // Keep the primary assertion.
    }
    blocker.close();
  });

  const firstStarted = performance.now();
  assert.throws(
    () => store.readGet('SELECT 1 AS value'),
    (error) => ['NATIVE_DATABASE_IDENTITY_STALE', 'NATIVE_STORE_DISPOSITION_UNKNOWN'].includes(error?.code),
  );
  const firstElapsed = performance.now() - firstStarted;
  assert.ok(firstElapsed >= 50 && firstElapsed < 750, `first busy attempt took ${firstElapsed}ms`);

  const secondStarted = performance.now();
  assert.throws(
    () => store.readGet('SELECT 1 AS value'),
    (error) => ['NATIVE_STORE_FENCED', 'NATIVE_STORE_DISPOSITION_UNKNOWN'].includes(error?.code),
  );
  assert.ok(performance.now() - secondStarted < 100);
});

test('project instance change fences the captured connection epoch', (t) => {
  const fixture = nativeFixture(t, 'native-store-instance');
  const store = createStageBFixtureStore(fixture);
  const mutator = new Database(fixture.databasePath, { create: false, strict: true });
  mutator.exec('BEGIN EXCLUSIVE');
  mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
  mutator.query("UPDATE project_meta SET value = ? WHERE key = 'project_instance_id'").run(randomUUID());
  mutator.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
  mutator.exec('COMMIT');
  mutator.close();

  assert.throws(
    () => store.readGet('SELECT 1 AS value'),
    (error) => error?.code === 'NATIVE_CONNECTION_REJECTED',
  );
  assert.equal(store.state, 'fenced');
});

test('an added hardlink fences the store before the next read', (t) => {
  const fixture = nativeFixture(t, 'native-store-hardlink');
  const store = createStageBFixtureStore(fixture);
  fs.linkSync(fixture.databasePath, path.join(fixture.root, 'unexpected-hardlink.db'));
  assert.throws(
    () => store.readGet('SELECT 1 AS value'),
    (error) => error?.code === 'NATIVE_DATABASE_IDENTITY_STALE',
  );
  assert.equal(store.state, 'fenced');
});

test('underlying close failure leaves disposition unknown and poisons cached calls', (t) => {
  const fixture = nativeFixture(t, 'native-store-close-unknown');
  let rawDatabase;
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory(databasePath) {
      rawDatabase = new Database(databasePath, { create: false, strict: true });
      return {
        get inTransaction() {
          return rawDatabase.inTransaction;
        },
        query(sql) {
          return rawDatabase.query(sql);
        },
        exec(sql) {
          return rawDatabase.exec(sql);
        },
        close() {
          throw new Error('injected close failure');
        },
      };
    },
  });
  t.after(() => rawDatabase.close());

  assert.throws(
    () => store.close(),
    (error) => error?.code === 'NATIVE_STORE_DISPOSITION_UNKNOWN',
  );
  assert.equal(store.state, 'disposition_unknown');
  assert.throws(
    () => store.readGet('SELECT 1 AS value'),
    (error) => error?.code === 'NATIVE_STORE_DISPOSITION_UNKNOWN',
  );
});

test('ControlStore evidence drift fences the admitted epoch before another SQLite read', (t) => {
  const fixture = nativeFixture(t, 'native-store-evidence-drift');
  const store = createStageBFixtureStore(fixture);
  t.after(() => {
    if (store.state === 'active') store.close();
  });
  openControlStore(fixture.controlDirectory).append({
    type: 'sqlite.native.unexpected',
    payload: { version: 1 },
  });

  assert.throws(
    () => store.readGet('SELECT 1 AS value'),
    (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
  );
  assert.equal(store.state, 'fenced');
});

test('Task 4 Batch 1 RED: source-only suffix constructs an exact cold facade without opening SQLite', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-source-cold');
  const writer = createStageBFixtureStore(fixture);
  appendSource(fixture, writer);
  writer.close();

  const evidenceBefore = openControlStore(fixture.controlDirectory).read();
  let sqliteOpenCount = 0;
  const openedDatabases = [];
  let cold;
  t.after(() => {
    if (cold?.state === 'active') cold.close();
    for (const database of openedDatabases) {
      try {
        database.close(true);
      } catch {
        // The store owns successful opens; this only protects a failing RED run.
      }
    }
  });

  cold = createStageBFixtureStore(fixture, {
    sqliteFactory(databasePath) {
      sqliteOpenCount += 1;
      const database = new Database(databasePath, { create: false, strict: true });
      openedDatabases.push(database);
      return database;
    },
  });

  assert.deepEqual(Object.keys(cold), [
    'connectionEpoch',
    'state',
    'readAll',
    'readGet',
    'executeTransaction',
    'recover',
    'checkpoint',
    'close',
    'fence',
  ]);
  assert.ok(Object.isFrozen(cold));
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
  assert.equal(sqliteOpenCount, 0);

  const rejectedCalls = [
    () => cold.readAll('SELECT 1 AS value'),
    () => cold.readGet('SELECT 1 AS value'),
    () => cold.executeTransaction({}, () => undefined),
    () => cold.checkpoint(),
  ];
  for (const rejectedCall of rejectedCalls) {
    assert.throws(rejectedCall, (error) => error?.code === 'RECOVERY_REQUIRED');
  }
  assert.equal(sqliteOpenCount, 0);
  assert.deepEqual(openControlStore(fixture.controlDirectory).read(), evidenceBefore);
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
});

test('Task 4 Batch 1 RED: prepared suffix constructs cold before SQLite', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-prepared-cold');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const controlStore = openControlStore(fixture.controlDirectory);
  controlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  const evidenceBefore = controlStore.read();
  let sqliteOpenCount = 0;
  const cold = createStageBFixtureStore(fixture, {
    sqliteFactory() {
      sqliteOpenCount += 1;
      assert.fail('prepared classification must happen before sqliteFactory');
    },
  });

  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
  assert.equal(sqliteOpenCount, 0);
  assert.deepEqual(controlStore.read(), evidenceBefore);
});

test('Task 4 Batch 1 RED: clean suffix opens once and recover is exact and idempotent', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-clean-recover');
  let sqliteOpenCount = 0;
  const store = createStageBFixtureStore(fixture, {
    sqliteFactory(databasePath) {
      sqliteOpenCount += 1;
      return new Database(databasePath, { create: false, strict: true });
    },
  });
  t.after(() => {
    if (store.state === 'active') store.close();
  });

  const epoch = store.connectionEpoch;
  const evidenceBefore = openControlStore(fixture.controlDirectory).read();
  const expected = { status: 'clean', finalSeq: 0, connectionEpoch: epoch };
  assert.deepEqual(store.recover(), expected);
  assert.deepEqual(store.recover(), expected);
  assert.equal(store.connectionEpoch, epoch);
  assert.equal(store.state, 'active');
  assert.equal(sqliteOpenCount, 1);
  assert.deepEqual(openControlStore(fixture.controlDirectory).read(), evidenceBefore);
});

test('Task 4 Batch 1 RED: source pending and caller-owned abandoned reopen the same cold facade', { timeout: 30_000 }, (t) => {
  for (const reasonCode of ['cancelled', 'superseded']) {
    const fixture = nativeFixture(t, `native-store-task4-source-${reasonCode}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    writer.close();

    let sqliteOpenCount = 0;
    const cold = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        return new Database(databasePath, { create: false, strict: true });
      },
    });
    t.after(() => {
      if (cold.state === 'active') cold.close();
    });
    const controlStore = openControlStore(fixture.controlDirectory);
    const evidenceAfterSource = controlStore.read();
    const pending = {
      status: 'source_pending',
      sourceDigest: source.digest,
      finalSeq: 0,
      connectionEpoch: null,
    };

    assert.deepEqual(cold.recover(), pending, reasonCode);
    assert.deepEqual(cold.recover(), pending, reasonCode);
    assert.equal(sqliteOpenCount, 0, reasonCode);
    assert.deepEqual(controlStore.read(), evidenceAfterSource, reasonCode);
    assert.equal(cold.state, 'recovery_required', reasonCode);
    assert.equal(cold.connectionEpoch, null, reasonCode);

    const abandoned = appendCallerOwnedAbandoned({ controlStore, source, reasonCode });
    assert.equal(abandoned.payload.connectionEpoch, source.payload.connectionEpoch, reasonCode);
    assert.equal(cold.connectionEpoch, null, reasonCode);
    const evidenceAfterAbandoned = controlStore.read();
    const result = cold.recover();

    assert.deepEqual(result, {
      status: 'clean',
      finalSeq: 0,
      connectionEpoch: cold.connectionEpoch,
    }, reasonCode);
    assert.match(cold.connectionEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(
      evidenceAfterAbandoned.some((event) => event.payload?.connectionEpoch === cold.connectionEpoch),
      false,
      reasonCode,
    );
    assert.equal(cold.state, 'active', reasonCode);
    assert.equal(sqliteOpenCount, 1, reasonCode);
    assert.deepEqual(controlStore.read(), evidenceAfterAbandoned, reasonCode);
    assert.deepEqual(cold.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"), { value: '0' });

    const nextSource = appendSource(fixture, cold, {
      logicalRequestDigest: sha256(`task4-after-cleanup:${reasonCode}`),
    });
    const saved = cold.executeTransaction(exactExecuteInput(nextSource), (transaction) => {
      const runResult = transaction.run(
        'INSERT INTO characters (id, name, background) VALUES (?, ?, ?)',
        `task4-${reasonCode}`,
        `Task 4 ${reasonCode}`,
        'caller cleanup reopened the exact facade',
      );
      assert.equal(runResult.changes, 1);
      return 'saved';
    });
    assert.equal(saved, 'saved', reasonCode);
  }
});

test('Task 4 Batch 1 RED: source cleanup accepts only one exact abandoned successor', { timeout: 30_000 }, (t) => {
  const cases = [
    {
      name: 'wrong-reason',
      mutate(controlStore, fixture, source) {
        controlStore.compareAndAppend(source.digest, {
          type: 'manuscript.source.abandoned',
          payload: callerOwnedAbandonedPayload(source, 'validation_failed'),
        });
      },
    },
    {
      name: 'wrong-source',
      mutate(controlStore, fixture, source) {
        controlStore.compareAndAppend(source.digest, {
          type: 'manuscript.source.abandoned',
          payload: callerOwnedAbandonedPayload(source, 'cancelled', {
            sourceDigest: sha256('wrong-source'),
          }),
        });
      },
    },
    {
      name: 'wrong-epoch',
      mutate(controlStore, fixture, source) {
        controlStore.compareAndAppend(source.digest, {
          type: 'manuscript.source.abandoned',
          payload: callerOwnedAbandonedPayload(source, 'cancelled', {
            connectionEpoch: randomUUID(),
          }),
        });
      },
    },
    {
      name: 'extra-payload-key',
      mutate(controlStore, fixture, source) {
        controlStore.compareAndAppend(source.digest, {
          type: 'manuscript.source.abandoned',
          payload: callerOwnedAbandonedPayload(source, 'cancelled', { unexpected: true }),
        });
      },
    },
    {
      name: 'prepared-successor',
      mutate(controlStore, fixture, source) {
        controlStore.compareAndAppend(source.digest, {
          type: 'sqlite.tx.prepared',
          payload: exactPreparedPayload(fixture, source.payload.connectionEpoch, source),
        });
      },
    },
    {
      name: 'additional-successor',
      mutate(controlStore, fixture, source) {
        const abandoned = appendCallerOwnedAbandoned({
          controlStore,
          source,
          reasonCode: 'cancelled',
        });
        controlStore.compareAndAppend(abandoned.digest, {
          type: 'manuscript.source',
          payload: sourcePayload(fixture, randomUUID(), {
            logicalRequestDigest: sha256('additional-successor'),
          }),
        });
      },
    },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-source-negative-${current.name}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    writer.close();
    let sqliteOpenCount = 0;
    const openedDatabases = [];
    const cold = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        const database = new Database(databasePath, { create: false, strict: true });
        openedDatabases.push(database);
        return database;
      },
    });
    t.after(() => {
      for (const database of openedDatabases) {
        try {
          database.close(true);
        } catch {
          // The production store closes any rejected controlled open.
        }
      }
    });
    const controlStore = openControlStore(fixture.controlDirectory);
    current.mutate(controlStore, fixture, source);
    const evidenceBeforeRecover = controlStore.read();

    assert.throws(
      () => cold.recover(),
      (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
      current.name,
    );
    assert.equal(sqliteOpenCount, 0, current.name);
    assert.deepEqual(controlStore.read(), evidenceBeforeRecover, current.name);
    assert.equal(cold.state, 'recovery_required', current.name);
    assert.equal(cold.connectionEpoch, null, current.name);
  }
});

test('Task 4 Batch 1 RED: source controlled open closes before statements on post-open authority drift', { timeout: 30_000 }, (t) => {
  const cases = [
    {
      name: 'identity',
      expectedPostOpenTrace: ['sqlite.open', 'guard', 'database.close'],
    },
    {
      name: 'tail',
      expectedPostOpenTrace: ['sqlite.open', 'guard', 'control', 'evidence', 'database.close'],
    },
    {
      name: 'lease',
      expectedPostOpenTrace: ['sqlite.open', 'guard', 'control', 'evidence', 'lease', 'database.close'],
    },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-source-post-open-${current.name}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    writer.close();
    const rawControlStore = openControlStore(fixture.controlDirectory);
    const trace = [];
    let phase = 'cold';
    let implicitAppendCount = 0;
    let sqliteOpenCount = 0;
    let sqliteStatementCount = 0;
    let sqliteCloseCount = 0;
    let rawGuard;
    let rawDatabase;
    let databaseClosed = false;
    let evidenceAfterInjectedDrift;
    const controlStore = {
      read() {
        trace.push('evidence');
        return rawControlStore.read();
      },
      assertCurrent() {
        trace.push('control');
        return rawControlStore.assertCurrent();
      },
      tail() {
        return rawControlStore.tail();
      },
      compareAndAppend(...args) {
        implicitAppendCount += 1;
        return rawControlStore.compareAndAppend(...args);
      },
      append(...args) {
        implicitAppendCount += 1;
        return rawControlStore.append(...args);
      },
    };
    let cold;
    cold = createCoreFixtureStore(fixture, {
      controlStore,
      identityApi({ databasePath }) {
        rawGuard = createDatabaseIdentityGuard({ databasePath });
        return {
          canonicalPath: rawGuard.canonicalPath,
          identity: rawGuard.identity,
          assertCurrent() {
            trace.push('guard');
            if (phase === 'post-open' && current.name === 'identity') {
              throw Object.assign(new Error('injected post-open identity drift'), {
                code: 'NATIVE_DATABASE_IDENTITY_STALE',
              });
            }
            return rawGuard.assertCurrent();
          },
          close() {
            return rawGuard.close();
          },
        };
      },
      assertWriterLease() {
        trace.push('lease');
        if (phase === 'post-open' && current.name === 'lease') {
          throw Object.assign(new Error('injected post-open writer lease loss'), {
            code: 'WRITER_LEASE_LOST',
          });
        }
        return true;
      },
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        trace.push('sqlite.open');
        rawDatabase = new Database(databasePath, { create: false, strict: true });
        phase = 'post-open';
        if (current.name === 'tail') {
          const abandoned = rawControlStore.tail();
          rawControlStore.compareAndAppend(abandoned.digest, {
            type: 'manuscript.source',
            payload: sourcePayload(fixture, randomUUID(), {
              logicalRequestDigest: sha256('post-open-tail-drift'),
            }),
          });
          evidenceAfterInjectedDrift = rawControlStore.read();
        }
        return {
          get inTransaction() {
            return rawDatabase.inTransaction;
          },
          query(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.query(sql);
          },
          exec(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.exec(sql);
          },
          close() {
            sqliteCloseCount += 1;
            trace.push('database.close');
            databaseClosed = true;
            return rawDatabase.close(true);
          },
        };
      },
    });
    t.after(() => {
      if (!databaseClosed) {
        try {
          rawDatabase?.close(true);
        } catch {
          // Preserve the primary assertions.
        }
      }
      try {
        rawGuard?.close();
      } catch {
        // The facade may already own and close the guard in later batches.
      }
    });
    const abandoned = appendCallerOwnedAbandoned({
      controlStore: rawControlStore,
      source,
      reasonCode: 'cancelled',
    });
    const evidenceBeforeRecover = rawControlStore.read();
    assert.equal(abandoned.payload.connectionEpoch, source.payload.connectionEpoch);
    trace.length = 0;

    assert.throws(() => cold.recover(), current.name);
    assert.equal(sqliteOpenCount, 1, current.name);
    assert.equal(sqliteStatementCount, 0, current.name);
    assert.equal(sqliteCloseCount, 1, current.name);
    assert.equal(implicitAppendCount, 0, current.name);
    assert.equal(cold.state, 'recovery_required', current.name);
    assert.equal(cold.connectionEpoch, null, current.name);
    assert.deepEqual(
      rawControlStore.read(),
      evidenceAfterInjectedDrift || evidenceBeforeRecover,
      current.name,
    );
    const sqliteOpenIndex = trace.indexOf('sqlite.open');
    assert.deepEqual(trace.slice(sqliteOpenIndex), current.expectedPostOpenTrace, current.name);
  }
});

test('Task 4 Batch 1 RED: cold source and prepared facades close or fence without SQLite', { timeout: 30_000 }, (t) => {
  const cases = [
    { mode: 'source', action: 'close', finalState: 'released', finalCode: 'NATIVE_STORE_RELEASED' },
    { mode: 'source', action: 'fence', finalState: 'fenced', finalCode: 'NATIVE_STORE_FENCED' },
    { mode: 'prepared', action: 'close', finalState: 'released', finalCode: 'NATIVE_STORE_RELEASED' },
    { mode: 'prepared', action: 'fence', finalState: 'fenced', finalCode: 'NATIVE_STORE_FENCED' },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-cold-${current.mode}-${current.action}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    if (current.mode === 'prepared') {
      const controlStore = openControlStore(fixture.controlDirectory);
      controlStore.compareAndAppend(source.digest, {
        type: 'sqlite.tx.prepared',
        payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
      });
    }
    writer.close();

    let rawGuard;
    let guardCloseCount = 0;
    let sqliteOpenCount = 0;
    const cold = createCoreFixtureStore(fixture, {
      identityApi({ databasePath }) {
        rawGuard = createDatabaseIdentityGuard({ databasePath });
        return {
          canonicalPath: rawGuard.canonicalPath,
          identity: rawGuard.identity,
          assertCurrent: () => rawGuard.assertCurrent(),
          close() {
            guardCloseCount += 1;
            return rawGuard.close();
          },
        };
      },
      sqliteFactory() {
        sqliteOpenCount += 1;
        assert.fail('cold close/fence must not open SQLite');
      },
    });
    t.after(() => {
      try {
        rawGuard?.close();
      } catch {
        // The cold facade owns its successful guard close.
      }
    });
    const controlStore = openControlStore(fixture.controlDirectory);
    const evidenceBefore = controlStore.read();

    assert.equal(cold.state, 'recovery_required', `${current.mode}/${current.action}`);
    assert.equal(cold.connectionEpoch, null, `${current.mode}/${current.action}`);
    assert.equal(cold[current.action](), undefined, `${current.mode}/${current.action}`);
    assert.equal(cold.state, current.finalState, `${current.mode}/${current.action}`);
    assert.equal(cold.connectionEpoch, null, `${current.mode}/${current.action}`);
    assert.equal(guardCloseCount, 1, `${current.mode}/${current.action}`);
    assert.equal(sqliteOpenCount, 0, `${current.mode}/${current.action}`);
    assert.deepEqual(controlStore.read(), evidenceBefore, `${current.mode}/${current.action}`);
    assert.throws(
      () => cold.recover(),
      (error) => error?.code === current.finalCode,
      `${current.mode}/${current.action}`,
    );
  }
});

test('Task 4 Batch 1 RED: uncertain cold guard close enters disposition_unknown', { timeout: 30_000 }, (t) => {
  const cases = [
    { mode: 'source', action: 'close' },
    { mode: 'prepared', action: 'fence' },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-cold-close-unknown-${current.mode}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    if (current.mode === 'prepared') {
      const controlStore = openControlStore(fixture.controlDirectory);
      controlStore.compareAndAppend(source.digest, {
        type: 'sqlite.tx.prepared',
        payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
      });
    }
    writer.close();

    let rawGuard;
    let guardCloseCount = 0;
    let sqliteOpenCount = 0;
    const closeFailure = new Error(`injected ${current.mode} guard close failure`);
    const cold = createCoreFixtureStore(fixture, {
      identityApi({ databasePath }) {
        rawGuard = createDatabaseIdentityGuard({ databasePath });
        return {
          canonicalPath: rawGuard.canonicalPath,
          identity: rawGuard.identity,
          assertCurrent: () => rawGuard.assertCurrent(),
          close() {
            guardCloseCount += 1;
            throw closeFailure;
          },
        };
      },
      sqliteFactory() {
        sqliteOpenCount += 1;
        assert.fail('uncertain cold close must not open SQLite');
      },
    });
    t.after(() => {
      try {
        rawGuard?.close();
      } catch {
        // The injected facade close intentionally did not release the raw guard.
      }
    });
    const controlStore = openControlStore(fixture.controlDirectory);
    const evidenceBefore = controlStore.read();

    assert.throws(
      () => cold[current.action](),
      (error) => error?.code === 'NATIVE_STORE_DISPOSITION_UNKNOWN' && error.cause === closeFailure,
      `${current.mode}/${current.action}`,
    );
    assert.equal(cold.state, 'disposition_unknown', `${current.mode}/${current.action}`);
    assert.equal(cold.connectionEpoch, null, `${current.mode}/${current.action}`);
    assert.equal(guardCloseCount, 1, `${current.mode}/${current.action}`);
    assert.equal(sqliteOpenCount, 0, `${current.mode}/${current.action}`);
    assert.deepEqual(controlStore.read(), evidenceBefore, `${current.mode}/${current.action}`);
    assert.throws(
      () => cold.recover(),
      (error) => error?.code === 'NATIVE_STORE_DISPOSITION_UNKNOWN',
      `${current.mode}/${current.action}`,
    );
  }
});

test('Task 4 Batch 1 RED: cold recovery operation guard rejects every same-store reentry and clears its token', { timeout: 30_000 }, (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-cold-reentry');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  writer.close();

  let cold;
  let armedCall = null;
  let reentryError;
  let dependencyFailure = null;
  let sqliteOpenCount = 0;
  let executeInputTouches = 0;
  const coldStore = createStageBFixtureStore(fixture, {
    assertWriterLease() {
      if (dependencyFailure) {
        const failure = dependencyFailure;
        dependencyFailure = null;
        throw failure;
      }
      if (armedCall) {
        const call = armedCall;
        armedCall = null;
        try {
          call();
        } catch (error) {
          reentryError = error;
        }
      }
      return true;
    },
    sqliteFactory() {
      sqliteOpenCount += 1;
      assert.fail('source-pending reentry tests must not open SQLite');
    },
  });
  cold = coldStore;
  const evidenceBefore = openControlStore(fixture.controlDirectory).read();
  const pending = {
    status: 'source_pending',
    sourceDigest: source.digest,
    finalSeq: 0,
    connectionEpoch: null,
  };
  const executeInput = new Proxy({}, {
    ownKeys() {
      executeInputTouches += 1;
      return [];
    },
  });
  const cases = [
    { name: 'recover', call: () => cold.recover() },
    { name: 'close', call: () => cold.close() },
    { name: 'fence', call: () => cold.fence() },
    { name: 'readAll', call: () => cold.readAll('SELECT 1 AS value') },
    { name: 'readGet', call: () => cold.readGet('SELECT 1 AS value') },
    { name: 'executeTransaction', call: () => cold.executeTransaction(executeInput, () => undefined) },
    { name: 'checkpoint', call: () => cold.checkpoint() },
  ];

  for (const current of cases) {
    reentryError = undefined;
    armedCall = current.call;
    assert.deepEqual(cold.recover(), pending, current.name);
    assert.equal(reentryError?.code, 'NATIVE_OPERATION_IN_PROGRESS', current.name);
    assert.equal(cold.state, 'recovery_required', current.name);
    assert.equal(cold.connectionEpoch, null, current.name);
  }
  assert.equal(executeInputTouches, 0);
  assert.equal(sqliteOpenCount, 0);
  assert.deepEqual(openControlStore(fixture.controlDirectory).read(), evidenceBefore);

  const injectedFailure = new Error('injected dependency failure');
  dependencyFailure = injectedFailure;
  assert.throws(() => cold.recover(), (error) => error === injectedFailure);
  assert.deepEqual(cold.recover(), pending);
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
});

test('Task 4 Batch 1 RED: controlled-open dependency getter cannot reenter the cold facade', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-controlled-open-getter-reentry');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  writer.close();

  let cold;
  let rawDatabase;
  let getterReentryError;
  let getterState;
  let getterEpoch;
  let getterArmed = true;
  const coldStore = createStageBFixtureStore(fixture, {
    sqliteFactory(databasePath) {
      rawDatabase = new Database(databasePath, { create: false, strict: true });
      return {
        get inTransaction() {
          if (getterArmed) {
            getterArmed = false;
            getterState = cold.state;
            getterEpoch = cold.connectionEpoch;
            try {
              cold.readGet('SELECT 1 AS value');
            } catch (error) {
              getterReentryError = error;
            }
          }
          return rawDatabase.inTransaction;
        },
        query: (sql) => rawDatabase.query(sql),
        exec: (sql) => rawDatabase.exec(sql),
        close: () => rawDatabase.close(true),
      };
    },
  });
  cold = coldStore;
  t.after(() => {
    if (cold.state === 'active') cold.close();
  });
  const controlStore = openControlStore(fixture.controlDirectory);
  appendCallerOwnedAbandoned({ controlStore, source, reasonCode: 'cancelled' });

  const result = cold.recover();
  assert.equal(getterReentryError?.code, 'NATIVE_OPERATION_IN_PROGRESS');
  assert.equal(getterState, 'recovery_required');
  assert.equal(getterEpoch, null);
  assert.deepEqual(result, {
    status: 'clean',
    finalSeq: 0,
    connectionEpoch: cold.connectionEpoch,
  });
  assert.equal(cold.state, 'active');
  assert.deepEqual(cold.readGet('SELECT 1 AS value'), { value: 1 });
});

function assertTask4PreparedRecovery(t, outcome) {
  const fixture = nativeFixture(t, `native-store-task4-prepared-recovery-${outcome}`);
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const rawControlStore = openControlStore(fixture.controlDirectory);
  const prepared = rawControlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  if (outcome === 'committed') {
    const mutator = new Database(fixture.databasePath, { create: false, strict: true });
    mutator.exec('BEGIN IMMEDIATE');
    mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
    mutator.query(
      'INSERT INTO characters (id, name, background) VALUES (?, ?, ?)',
    ).run('task4-recovered-character', 'Task 4 recovered', 'committed before terminal publication');
    mutator.query(
      "UPDATE project_meta SET value = '1' WHERE key = 'durability_commit_seq' AND value = '0'",
    ).run();
    mutator.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
    mutator.exec('COMMIT');
    mutator.close();
  }

  const trace = [];
  let cold;
  let rawGuard;
  let rawDatabase;
  let databaseClosed = false;
  let sqliteOpenCount = 0;
  let terminalAppendCount = 0;
  let terminalEvent;
  let stateAtTerminalAppend;
  let epochAtTerminalAppend;
  let terminalPostcheckObservation;
  const controlStore = {
    read() {
      trace.push('evidence');
      const events = rawControlStore.read();
      const tail = events.at(-1);
      if (
        cold
        && terminalEvent
        && !terminalPostcheckObservation
        && tail?.digest === terminalEvent.digest
      ) {
        terminalPostcheckObservation = Object.freeze({
          state: cold.state,
          connectionEpoch: cold.connectionEpoch,
          tailDigest: tail.digest,
        });
      }
      return events;
    },
    assertCurrent() {
      trace.push('control');
      return rawControlStore.assertCurrent();
    },
    tail() {
      return rawControlStore.tail();
    },
    compareAndAppend(expectedTailDigest, event) {
      if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
        terminalAppendCount += 1;
        stateAtTerminalAppend = cold.state;
        epochAtTerminalAppend = cold.connectionEpoch;
        trace.push(`terminal.append:${event.type}`);
      }
      const appended = rawControlStore.compareAndAppend(expectedTailDigest, event);
      if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
        terminalEvent = rawControlStore.tail();
      }
      return appended;
    },
    append(...args) {
      return rawControlStore.append(...args);
    },
  };
  const coldStore = createCoreFixtureStore(fixture, {
    controlStore,
    identityApi({ databasePath }) {
      rawGuard = createDatabaseIdentityGuard({ databasePath });
      return {
        canonicalPath: rawGuard.canonicalPath,
        identity: rawGuard.identity,
        assertCurrent() {
          trace.push('guard');
          return rawGuard.assertCurrent();
        },
        close: () => rawGuard.close(),
      };
    },
    assertWriterLease() {
      trace.push('lease');
      return true;
    },
    sqliteFactory(databasePath) {
      sqliteOpenCount += 1;
      trace.push('sqlite.open');
      rawDatabase = new Database(databasePath, { create: false, strict: true });
      return {
        get inTransaction() {
          return rawDatabase.inTransaction;
        },
        query(sql) {
          trace.push(`sql.query:${sql}`);
          return rawDatabase.query(sql);
        },
        exec(sql) {
          trace.push(`sql.exec:${sql}`);
          return rawDatabase.exec(sql);
        },
        close() {
          databaseClosed = true;
          trace.push('database.close');
          return rawDatabase.close(true);
        },
      };
    },
  });
  cold = coldStore;
  t.after(() => {
    try {
      if (cold?.state === 'active' || cold?.state === 'recovery_required') cold.close();
    } catch {
      // Preserve the primary assertion.
    }
    if (!databaseClosed) {
      try {
        rawDatabase?.close(true);
      } catch {
        // The facade may already have closed the controlled connection.
      }
    }
    try {
      rawGuard?.close();
    } catch {
      // The facade owns a successful guard close.
    }
  });

  const evidenceBeforeRecovery = rawControlStore.read();
  const usedEpochs = new Set(
    evidenceBeforeRecovery
      .map((event) => event.payload?.connectionEpoch)
      .filter((value) => typeof value === 'string'),
  );
  trace.length = 0;
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);

  const result = cold.recover();
  const expectedStatus = outcome === 'committed' ? 'committed' : 'rolled_back';
  const expectedFinalSeq = outcome === 'committed' ? 1 : 0;
  assert.deepEqual(result, {
    status: expectedStatus,
    preparedDigest: prepared.digest,
    terminalDigest: terminalEvent.digest,
    finalSeq: expectedFinalSeq,
    connectionEpoch: cold.connectionEpoch,
  });
  assert.match(result.connectionEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(usedEpochs.has(result.connectionEpoch), false);
  assert.equal(sqliteOpenCount, 1);
  assert.equal(terminalAppendCount, 1);
  assert.equal(stateAtTerminalAppend, 'recovery_required');
  assert.equal(epochAtTerminalAppend, null);
  assert.deepEqual(terminalPostcheckObservation, {
    state: 'recovery_required',
    connectionEpoch: null,
    tailDigest: terminalEvent.digest,
  });
  assert.equal(cold.state, 'active');
  assert.equal(cold.connectionEpoch, result.connectionEpoch);

  const firstSqlIndex = trace.findIndex((entry) => entry.startsWith('sql.'));
  const sqliteOpenIndex = trace.indexOf('sqlite.open');
  assert.ok(sqliteOpenIndex >= 4, JSON.stringify(trace, null, 2));
  assert.ok(firstSqlIndex > sqliteOpenIndex, JSON.stringify(trace, null, 2));
  assert.deepEqual(trace.slice(sqliteOpenIndex - 4, sqliteOpenIndex), [
    'guard',
    'control',
    'evidence',
    'lease',
  ]);
  assert.deepEqual(trace.slice(sqliteOpenIndex + 1, firstSqlIndex), [
    'guard',
    'control',
    'evidence',
    'lease',
  ]);

  const eventsAfterRecovery = rawControlStore.read();
  assert.equal(eventsAfterRecovery.length, evidenceBeforeRecovery.length + 1);
  assert.equal(eventsAfterRecovery.at(-1).digest, terminalEvent.digest);
  assert.equal(terminalEvent.payload.connectionEpoch, result.connectionEpoch);
  assert.equal(terminalEvent.payload.preparedDigest, prepared.digest);
  if (outcome === 'committed') {
    assert.deepEqual(Object.keys(terminalEvent.payload).sort(), [
      ...['version', 'eventId', 'dbKey', 'projectInstanceIdSha256', 'createdAt', 'ownershipHash', 'connectionEpoch'],
      'preparedDigest',
      'finalSeq',
      'schemaVersion',
      'backend',
      'gateEmpty',
      'triggerVersion',
      'triggerSetDigest',
      'postCommitIdentity',
    ].sort());
    assert.equal(terminalEvent.type, 'sqlite.tx.committed');
    assert.equal(terminalEvent.payload.finalSeq, 1);
    assert.deepEqual(
      cold.readGet('SELECT id, name FROM characters WHERE id = ?', 'task4-recovered-character'),
      { id: 'task4-recovered-character', name: 'Task 4 recovered' },
    );
  } else {
    assert.deepEqual(Object.keys(terminalEvent.payload).sort(), [
      ...['version', 'eventId', 'dbKey', 'projectInstanceIdSha256', 'createdAt', 'ownershipHash', 'connectionEpoch'],
      'preparedDigest',
      'beforeSeq',
      'reasonCode',
      'rollbackKind',
      'predicate',
    ].sort());
    assert.equal(terminalEvent.type, 'sqlite.tx.rolled_back');
    assert.equal(terminalEvent.payload.beforeSeq, 0);
    assert.equal(terminalEvent.payload.reasonCode, 'crash_recovery');
    assert.equal(terminalEvent.payload.rollbackKind, 'recovery_before_commit');
    assert.deepEqual(Object.keys(terminalEvent.payload.predicate).sort(), [
      'autocommit',
      'hotJournalRecovered',
      'schemaVersion',
      'backend',
      'finalSeq',
      'gateEmpty',
      'triggerVersion',
      'triggerSetDigest',
      'identity',
    ].sort());
    assert.equal(terminalEvent.payload.predicate.autocommit, true);
    assert.equal(terminalEvent.payload.predicate.hotJournalRecovered, true);
    assert.equal(terminalEvent.payload.predicate.finalSeq, 0);
  }

  const evidenceAfterTerminal = rawControlStore.read();
  assert.deepEqual(cold.recover(), {
    status: 'clean',
    finalSeq: expectedFinalSeq,
    connectionEpoch: result.connectionEpoch,
  });
  assert.deepEqual(rawControlStore.read(), evidenceAfterTerminal);
}

test('Task 4 Batch 2 RED: prepared beforeSeq recovers one exact rolled_back terminal', { timeout: 30_000 }, (t) => {
  assertTask4PreparedRecovery(t, 'rolled_back');
});

test('Task 4 Batch 2 RED: prepared expectedFinalSeq recovers one exact committed terminal', { timeout: 30_000 }, (t) => {
  assertTask4PreparedRecovery(t, 'committed');
});

test('Task 4 Batch 2 RED: prepared pre-open authority drift never reaches sqliteFactory', { timeout: 30_000 }, (t) => {
  for (const drift of ['identity', 'tail', 'lease']) {
    const fixture = nativeFixture(t, `native-store-task4-prepared-pre-open-${drift}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    const rawControlStore = openControlStore(fixture.controlDirectory);
    rawControlStore.compareAndAppend(source.digest, {
      type: 'sqlite.tx.prepared',
      payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
    });
    const prepared = rawControlStore.tail();
    writer.close();

    let phase = 'construct';
    let cold;
    let rawGuard;
    let rawDatabase;
    let sqliteOpenCount = 0;
    let sqliteStatementCount = 0;
    let productionTerminalCount = 0;
    const controlStore = {
      read: () => rawControlStore.read(),
      assertCurrent: () => rawControlStore.assertCurrent(),
      tail: () => rawControlStore.tail(),
      compareAndAppend(expectedTailDigest, event) {
        if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
          productionTerminalCount += 1;
        }
        return rawControlStore.compareAndAppend(expectedTailDigest, event);
      },
      append: (...args) => rawControlStore.append(...args),
    };
    cold = createCoreFixtureStore(fixture, {
      controlStore,
      identityApi({ databasePath }) {
        rawGuard = createDatabaseIdentityGuard({ databasePath });
        return {
          canonicalPath: rawGuard.canonicalPath,
          identity: rawGuard.identity,
          assertCurrent() {
            if (phase === 'recover' && drift === 'identity') {
              throw Object.assign(new Error('injected prepared pre-open identity drift'), {
                code: 'NATIVE_DATABASE_IDENTITY_STALE',
              });
            }
            return rawGuard.assertCurrent();
          },
          close: () => rawGuard.close(),
        };
      },
      assertWriterLease() {
        if (phase === 'recover' && drift === 'lease') {
          throw Object.assign(new Error('injected prepared pre-open lease drift'), {
            code: 'WRITER_LEASE_LOST',
          });
        }
        return true;
      },
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        rawDatabase = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() {
            return rawDatabase.inTransaction;
          },
          query(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.query(sql);
          },
          exec(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.exec(sql);
          },
          close: () => rawDatabase.close(true),
        };
      },
    });
    t.after(() => {
      try {
        if (cold?.state === 'recovery_required' || cold?.state === 'active') cold.close();
      } catch {
        // Preserve the primary assertions.
      }
      try {
        rawDatabase?.close(true);
      } catch {
        // A rejected controlled open owns its close.
      }
      try {
        rawGuard?.close();
      } catch {
        // The facade owns its guard.
      }
    });
    phase = 'recover';
    if (drift === 'tail') {
      rawControlStore.compareAndAppend(prepared.digest, {
        type: 'sqlite.tx.rolled_back',
        payload: exactTerminalPayload(fixture, randomUUID(), prepared, 'recovery_before_commit'),
      });
    }
    const evidenceBeforeRecover = rawControlStore.read();

    assert.throws(
      () => cold.recover(),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      drift,
    );
    assert.equal(sqliteOpenCount, 0, drift);
    assert.equal(sqliteStatementCount, 0, drift);
    assert.equal(productionTerminalCount, 0, drift);
    assert.deepEqual(rawControlStore.read(), evidenceBeforeRecover, drift);
    assert.equal(cold.state, 'recovery_required', drift);
    assert.equal(cold.connectionEpoch, null, drift);
  }
});

test('Task 4 Batch 2 RED: prepared post-open authority drift closes before the first statement', { timeout: 30_000 }, (t) => {
  const cases = [
    { name: 'identity', postOpen: ['sqlite.open', 'guard', 'database.close'] },
    { name: 'tail', postOpen: ['sqlite.open', 'guard', 'control', 'evidence', 'database.close'] },
    { name: 'lease', postOpen: ['sqlite.open', 'guard', 'control', 'evidence', 'lease', 'database.close'] },
  ];
  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-prepared-post-open-${current.name}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    const rawControlStore = openControlStore(fixture.controlDirectory);
    rawControlStore.compareAndAppend(source.digest, {
      type: 'sqlite.tx.prepared',
      payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
    });
    const prepared = rawControlStore.tail();
    writer.close();

    const trace = [];
    let phase = 'construct';
    let cold;
    let rawGuard;
    let rawDatabase;
    let databaseClosed = false;
    let sqliteOpenCount = 0;
    let sqliteStatementCount = 0;
    let sqliteCloseCount = 0;
    let productionTerminalCount = 0;
    let evidenceAfterInjectedDrift;
    const controlStore = {
      read() {
        trace.push('evidence');
        return rawControlStore.read();
      },
      assertCurrent() {
        trace.push('control');
        return rawControlStore.assertCurrent();
      },
      tail: () => rawControlStore.tail(),
      compareAndAppend(expectedTailDigest, event) {
        if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
          productionTerminalCount += 1;
        }
        return rawControlStore.compareAndAppend(expectedTailDigest, event);
      },
      append: (...args) => rawControlStore.append(...args),
    };
    cold = createCoreFixtureStore(fixture, {
      controlStore,
      identityApi({ databasePath }) {
        rawGuard = createDatabaseIdentityGuard({ databasePath });
        return {
          canonicalPath: rawGuard.canonicalPath,
          identity: rawGuard.identity,
          assertCurrent() {
            trace.push('guard');
            if (phase === 'post-open' && current.name === 'identity') {
              throw Object.assign(new Error('injected prepared post-open identity drift'), {
                code: 'NATIVE_DATABASE_IDENTITY_STALE',
              });
            }
            return rawGuard.assertCurrent();
          },
          close: () => rawGuard.close(),
        };
      },
      assertWriterLease() {
        trace.push('lease');
        if (phase === 'post-open' && current.name === 'lease') {
          throw Object.assign(new Error('injected prepared post-open lease drift'), {
            code: 'WRITER_LEASE_LOST',
          });
        }
        return true;
      },
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        trace.push('sqlite.open');
        rawDatabase = new Database(databasePath, { create: false, strict: true });
        phase = 'post-open';
        if (current.name === 'tail') {
          rawControlStore.compareAndAppend(prepared.digest, {
            type: 'sqlite.tx.rolled_back',
            payload: exactTerminalPayload(fixture, randomUUID(), prepared, 'recovery_before_commit'),
          });
          evidenceAfterInjectedDrift = rawControlStore.read();
        }
        return {
          get inTransaction() {
            return rawDatabase.inTransaction;
          },
          query(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.query(sql);
          },
          exec(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.exec(sql);
          },
          close() {
            sqliteCloseCount += 1;
            databaseClosed = true;
            trace.push('database.close');
            return rawDatabase.close(true);
          },
        };
      },
    });
    t.after(() => {
      try {
        if (cold?.state === 'recovery_required' || cold?.state === 'active') cold.close();
      } catch {
        // Preserve the primary assertions.
      }
      if (!databaseClosed) {
        try {
          rawDatabase?.close(true);
        } catch {
          // A rejected controlled open owns its close.
        }
      }
      try {
        rawGuard?.close();
      } catch {
        // The facade owns its guard.
      }
    });
    trace.length = 0;
    const evidenceBeforeRecover = rawControlStore.read();

    assert.throws(
      () => cold.recover(),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      current.name,
    );
    assert.equal(sqliteOpenCount, 1, current.name);
    assert.equal(sqliteStatementCount, 0, current.name);
    assert.equal(sqliteCloseCount, 1, current.name);
    assert.equal(productionTerminalCount, 0, current.name);
    assert.deepEqual(
      rawControlStore.read(),
      evidenceAfterInjectedDrift || evidenceBeforeRecover,
      current.name,
    );
    assert.equal(cold.state, 'recovery_required', current.name);
    assert.equal(cold.connectionEpoch, null, current.name);
    const sqliteOpenIndex = trace.indexOf('sqlite.open');
    assert.deepEqual(trace.slice(sqliteOpenIndex), current.postOpen, current.name);
  }
});

test('Task 4 Batch 2 RED: prepared same-path replacement leaves a hot journal untouched', { timeout: 30_000 }, (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-prepared-replacement-hot-journal');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const rawControlStore = openControlStore(fixture.controlDirectory);
  rawControlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  let sqliteOpenCount = 0;
  let productionTerminalCount = 0;
  const controlStore = {
    read: () => rawControlStore.read(),
    assertCurrent: () => rawControlStore.assertCurrent(),
    tail: () => rawControlStore.tail(),
    compareAndAppend(expectedTailDigest, event) {
      if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
        productionTerminalCount += 1;
      }
      return rawControlStore.compareAndAppend(expectedTailDigest, event);
    },
    append: (...args) => rawControlStore.append(...args),
  };
  const cold = createCoreFixtureStore(fixture, {
    controlStore,
    sqliteFactory() {
      sqliteOpenCount += 1;
      assert.fail('same-path replacement must fail before sqliteFactory');
    },
  });
  t.after(() => {
    try {
      if (cold.state === 'recovery_required' || cold.state === 'active') cold.close();
    } catch {
      // Preserve the primary assertions.
    }
  });

  const replacementPath = path.join(fixture.root, 'replacement.db');
  const heldPath = path.join(fixture.root, 'held-original.db');
  const markerPath = path.join(fixture.root, 'hot-journal-ready.marker');
  const journalPath = `${fixture.databasePath}-journal`;
  fs.copyFileSync(fixture.databasePath, replacementPath);
  const crashScript = String.raw`
    const fs = require('node:fs');
    const { Database } = require('bun:sqlite');
    const databasePath = process.argv.at(-2);
    const markerPath = process.argv.at(-1);
    const database = new Database(databasePath, { create: false, strict: true });
    database.exec('PRAGMA journal_mode = DELETE');
    database.exec('PRAGMA synchronous = EXTRA');
    database.exec('BEGIN IMMEDIATE');
    database.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
    database.query("UPDATE project_meta SET value = '1' WHERE key = 'durability_commit_seq' AND value = '0'").run();
    const journalPath = databasePath + '-journal';
    if (!fs.existsSync(journalPath) || fs.statSync(journalPath).size === 0) process.exit(42);
    fs.writeFileSync(markerPath, 'ready');
    process.kill(process.pid, 'SIGKILL');
  `;
  const crashed = spawnSync(process.execPath, ['-e', crashScript, fixture.databasePath, markerPath], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(crashed.error, undefined, crashed.error?.message);
  assert.notEqual(crashed.status, 0, JSON.stringify(crashed));
  assert.equal(fs.readFileSync(markerPath, 'utf8'), 'ready');
  assert.ok(fs.statSync(journalPath).size > 0);
  const journalBeforeRecover = fs.readFileSync(journalPath);

  fs.renameSync(fixture.databasePath, heldPath);
  fs.renameSync(replacementPath, fixture.databasePath);
  const evidenceBeforeRecover = rawControlStore.read();
  assert.throws(
    () => cold.recover(),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );

  assert.equal(sqliteOpenCount, 0);
  assert.equal(productionTerminalCount, 0);
  assert.deepEqual(rawControlStore.read(), evidenceBeforeRecover);
  assert.deepEqual(fs.readFileSync(journalPath), journalBeforeRecover);
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
});

async function assertTask4RecoveryTerminalUncertainty(t, outcome) {
  const cases = [
    { name: 'cas-conflict', installed: false },
    {
      name: 'before-publish',
      installed: false,
      faults: {
        [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_PUBLISH]: {
          throw: 'RECOVERY_TERMINAL_BEFORE_PUBLISH',
        },
      },
    },
    {
      name: 'before-dir-fsync',
      installed: true,
      faults: {
        [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC]: {
          throw: 'RECOVERY_TERMINAL_BEFORE_DIR_FSYNC',
        },
      },
    },
    { name: 'receipt-throw', installed: true },
    { name: 'postcheck-read', installed: true },
    { name: 'postcheck-close-failure', installed: true, closeFails: true },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-recovery-terminal-${outcome}-${current.name}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    const underlying = openControlStore(fixture.controlDirectory);
    underlying.compareAndAppend(source.digest, {
      type: 'sqlite.tx.prepared',
      payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
    });
    const prepared = underlying.tail();
    writer.close();

    if (outcome === 'committed') {
      const mutator = new Database(fixture.databasePath, { create: false, strict: true });
      mutator.exec('BEGIN IMMEDIATE');
      mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
      mutator.query('INSERT INTO characters (id, name) VALUES (?, ?)').run(
        `recovery-terminal-${current.name}`,
        `Recovery ${current.name}`,
      );
      mutator.query(
        "UPDATE project_meta SET value = '1' WHERE key = 'durability_commit_seq' AND value = '0'",
      ).run();
      mutator.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
      mutator.exec('COMMIT');
      mutator.close();
    }

    let failPostcheckRead = false;
    let terminalAttemptCount = 0;
    const controlStore = {
      read() {
        if (failPostcheckRead) {
          failPostcheckRead = false;
          throw Object.assign(new Error('injected recovery terminal post-check read failure'), {
            code: 'CONTROL_STORE_READ_FAILED',
          });
        }
        return underlying.read();
      },
      assertCurrent: () => underlying.assertCurrent(),
      tail: () => underlying.tail(),
      compareAndAppend(expectedTailDigest, event) {
        const terminal = ['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type);
        if (terminal) {
          terminalAttemptCount += 1;
          if (current.name === 'cas-conflict') {
            throw Object.assign(new Error('injected recovery terminal CAS conflict'), {
              code: 'CONTROL_STORE_CAS_FAILED',
            });
          }
        }
        const receipt = underlying.compareAndAppend(expectedTailDigest, event);
        if (terminal && current.name === 'receipt-throw') {
          throw Object.assign(new Error('injected lost recovery terminal receipt'), {
            code: 'CONTROL_STORE_RECEIPT_LOST',
          });
        }
        if (terminal && ['postcheck-read', 'postcheck-close-failure'].includes(current.name)) {
          failPostcheckRead = true;
        }
        return receipt;
      },
      append: (...args) => underlying.append(...args),
    };
    let cold;
    let rawGuard;
    let rawDatabase;
    let rawDatabaseClosed = false;
    let sqliteOpenCount = 0;
    let sqliteCloseAttemptCount = 0;
    let guardCloseCount = 0;
    const closeFailure = new Error('injected recovery database close failure');
    cold = createCoreFixtureStore(fixture, {
      controlStore,
      identityApi({ databasePath }) {
        rawGuard = createDatabaseIdentityGuard({ databasePath });
        return {
          canonicalPath: rawGuard.canonicalPath,
          identity: rawGuard.identity,
          assertCurrent: () => rawGuard.assertCurrent(),
          close() {
            guardCloseCount += 1;
            return rawGuard.close();
          },
        };
      },
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        rawDatabase = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() {
            return rawDatabase.inTransaction;
          },
          query: (sql) => rawDatabase.query(sql),
          exec: (sql) => rawDatabase.exec(sql),
          close() {
            sqliteCloseAttemptCount += 1;
            if (current.closeFails) throw closeFailure;
            rawDatabaseClosed = true;
            return rawDatabase.close(true);
          },
        };
      },
    });
    t.after(() => {
      try {
        if (cold?.state === 'active' || cold?.state === 'recovery_required') cold.close();
      } catch {
        // Preserve the primary assertions.
      }
      if (!rawDatabaseClosed) {
        try {
          rawDatabase?.close(true);
          rawDatabaseClosed = true;
        } catch {
          // The disposition_unknown assertion is primary.
        }
      }
      try {
        rawGuard?.close();
      } catch {
        // A fenced facade owns its guard close.
      }
    });

    let recoveryResult;
    let recoveryError;
    try {
      recoveryResult = await withFaults(current.faults || {}, () => cold.recover());
    } catch (error) {
      recoveryError = error;
    }
    assert.equal(recoveryResult, undefined, `${outcome}/${current.name}`);
    assert.equal(
      recoveryError?.code,
      current.closeFails ? 'NATIVE_STORE_DISPOSITION_UNKNOWN' : 'RECOVERY_REQUIRED',
      `${outcome}/${current.name}`,
    );
    assert.equal(sqliteOpenCount, 1, `${outcome}/${current.name}`);
    assert.equal(sqliteCloseAttemptCount, 1, `${outcome}/${current.name}`);
    assert.equal(terminalAttemptCount, 1, `${outcome}/${current.name}`);
    assert.equal(cold.connectionEpoch, null, `${outcome}/${current.name}`);

    const evidenceAfterUncertainty = underlying.read();
    assert.equal(
      evidenceAfterUncertainty.length,
      current.installed ? 4 : 3,
      `${outcome}/${current.name}`,
    );
    assert.equal(
      evidenceAfterUncertainty.at(-1).type,
      current.installed
        ? outcome === 'committed'
          ? 'sqlite.tx.committed'
          : 'sqlite.tx.rolled_back'
        : 'sqlite.tx.prepared',
      `${outcome}/${current.name}`,
    );

    if (current.closeFails && !rawDatabaseClosed) {
      rawDatabase.close(true);
      rawDatabaseClosed = true;
    }
    const successorEvidenceBefore = underlying.read();
    let successorOpenCount = 0;
    const successor = createStageBFixtureStore(fixture, {
      sqliteFactory(databasePath) {
        successorOpenCount += 1;
        return new Database(databasePath, { create: false, strict: true });
      },
    });
    t.after(() => {
      if (successor.state === 'active') successor.close();
    });
    let successorResult;
    if (current.installed) {
      assert.equal(successor.state, 'active', `${outcome}/${current.name}`);
      successorResult = successor.recover();
      assert.deepEqual(successorResult, {
        status: 'clean',
        finalSeq: outcome === 'committed' ? 1 : 0,
        connectionEpoch: successor.connectionEpoch,
      }, `${outcome}/${current.name}`);
      assert.deepEqual(underlying.read(), successorEvidenceBefore, `${outcome}/${current.name}`);
    } else {
      assert.equal(successor.state, 'recovery_required', `${outcome}/${current.name}`);
      successorResult = successor.recover();
      assert.equal(successorResult.status, outcome, `${outcome}/${current.name}`);
      assert.equal(successorResult.preparedDigest, prepared.digest, `${outcome}/${current.name}`);
    }
    assert.equal(successorOpenCount, 1, `${outcome}/${current.name}`);
    const convergedEvidence = underlying.read();
    const terminals = convergedEvidence.filter((event) => (
      ['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)
      && event.payload.preparedDigest === prepared.digest
    ));
    assert.equal(terminals.length, 1, `${outcome}/${current.name}`);
    assert.equal(
      terminals[0].type,
      outcome === 'committed' ? 'sqlite.tx.committed' : 'sqlite.tx.rolled_back',
      `${outcome}/${current.name}`,
    );
    assert.deepEqual(
      successor.readGet("SELECT value FROM project_meta WHERE key = 'durability_commit_seq'"),
      { value: outcome === 'committed' ? '1' : '0' },
      `${outcome}/${current.name}`,
    );
    assert.equal(
      successor.readGet('SELECT COUNT(*) AS count FROM characters WHERE id = ?', `recovery-terminal-${current.name}`).count,
      outcome === 'committed' ? 1 : 0,
      `${outcome}/${current.name}`,
    );

    assert.equal(
      cold.state,
      current.closeFails ? 'disposition_unknown' : 'fenced',
      `${outcome}/${current.name}`,
    );
    if (!current.closeFails) assert.equal(guardCloseCount, 1, `${outcome}/${current.name}`);
  }
}

test('Task 4 Batch 2 RED: rolled_back recovery terminal uncertainty converges once', { timeout: 90_000 }, async (t) => {
  await assertTask4RecoveryTerminalUncertainty(t, 'rolled_back');
});

test('Task 4 Batch 2 RED: committed recovery terminal uncertainty converges once', { timeout: 90_000 }, async (t) => {
  await assertTask4RecoveryTerminalUncertainty(t, 'committed');
});

test('Task 4 Batch 3 RED: invalid prepared suffix outranks simultaneous identity drift', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-invalid-suffix-before-identity');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const rawControlStore = openControlStore(fixture.controlDirectory);
  rawControlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  const prepared = rawControlStore.tail();
  writer.close();

  let phase = 'construct';
  let cold;
  let rawGuard;
  let sqliteOpenCount = 0;
  let productionTerminalCount = 0;
  const controlStore = {
    read: () => rawControlStore.read(),
    assertCurrent: () => rawControlStore.assertCurrent(),
    tail: () => rawControlStore.tail(),
    compareAndAppend(expectedTailDigest, event) {
      if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
        productionTerminalCount += 1;
      }
      return rawControlStore.compareAndAppend(expectedTailDigest, event);
    },
    append: (...args) => rawControlStore.append(...args),
  };
  cold = createCoreFixtureStore(fixture, {
    controlStore,
    identityApi({ databasePath }) {
      rawGuard = createDatabaseIdentityGuard({ databasePath });
      return {
        canonicalPath: rawGuard.canonicalPath,
        identity: rawGuard.identity,
        assertCurrent() {
          if (phase === 'recover') {
            throw Object.assign(new Error('simultaneous identity drift'), {
              code: 'NATIVE_DATABASE_IDENTITY_STALE',
            });
          }
          return rawGuard.assertCurrent();
        },
        close: () => rawGuard.close(),
      };
    },
    sqliteFactory() {
      sqliteOpenCount += 1;
      assert.fail('invalid suffix must be rejected before sqliteFactory');
    },
  });
  t.after(() => {
    try {
      if (cold.state === 'recovery_required') cold.close();
    } catch {
      // Preserve the primary assertion.
    }
    try {
      rawGuard?.close();
    } catch {
      // The facade owns its guard.
    }
  });
  const invalidPayload = exactTerminalPayload(
    fixture,
    randomUUID(),
    prepared,
    'recovery_before_commit',
  );
  invalidPayload.unexpected = true;
  rawControlStore.compareAndAppend(prepared.digest, {
    type: 'sqlite.tx.rolled_back',
    payload: invalidPayload,
  });
  const evidenceBeforeRecover = rawControlStore.read();
  phase = 'recover';

  assert.throws(
    () => cold.recover(),
    (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
  );
  assert.equal(sqliteOpenCount, 0);
  assert.equal(productionTerminalCount, 0);
  assert.deepEqual(rawControlStore.read(), evidenceBeforeRecover);
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
});

test('Task 4 Batch 3 RED: failed corrupt-recovery close preserves primary and close errors', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-corrupt-close-unknown');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const rawControlStore = openControlStore(fixture.controlDirectory);
  rawControlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  const mutator = new Database(fixture.databasePath, { create: false, strict: true });
  mutator.exec('BEGIN IMMEDIATE');
  mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
  mutator.query(
    "UPDATE project_meta SET value = '2' WHERE key = 'durability_commit_seq' AND value = '0'",
  ).run();
  mutator.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
  mutator.exec('COMMIT');
  mutator.close();

  let cold;
  let rawGuard;
  let rawDatabase;
  let guardCloseCount = 0;
  let sqliteStatementCount = 0;
  let terminalAttemptCount = 0;
  const closeFailure = new Error('injected corrupt recovery database close failure');
  const controlStore = {
    read: () => rawControlStore.read(),
    assertCurrent: () => rawControlStore.assertCurrent(),
    tail: () => rawControlStore.tail(),
    compareAndAppend(expectedTailDigest, event) {
      if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
        terminalAttemptCount += 1;
      }
      return rawControlStore.compareAndAppend(expectedTailDigest, event);
    },
    append: (...args) => rawControlStore.append(...args),
  };
  cold = createCoreFixtureStore(fixture, {
    controlStore,
    identityApi({ databasePath }) {
      rawGuard = createDatabaseIdentityGuard({ databasePath });
      return {
        canonicalPath: rawGuard.canonicalPath,
        identity: rawGuard.identity,
        assertCurrent: () => rawGuard.assertCurrent(),
        close() {
          guardCloseCount += 1;
          return rawGuard.close();
        },
      };
    },
    sqliteFactory(databasePath) {
      rawDatabase = new Database(databasePath, { create: false, strict: true });
      return {
        get inTransaction() {
          return rawDatabase.inTransaction;
        },
        query(sql) {
          sqliteStatementCount += 1;
          return rawDatabase.query(sql);
        },
        exec(sql) {
          sqliteStatementCount += 1;
          return rawDatabase.exec(sql);
        },
        close() {
          throw closeFailure;
        },
      };
    },
  });
  t.after(() => {
    try {
      rawDatabase?.close(true);
    } catch {
      // The injected wrapper intentionally did not close it.
    }
    try {
      rawGuard?.close();
    } catch {
      // Best-effort recovery cleanup may already have closed it.
    }
  });
  const evidenceBeforeRecover = rawControlStore.read();
  let recoveryError;
  try {
    cold.recover();
  } catch (error) {
    recoveryError = error;
  }

  assert.equal(recoveryError?.code, 'NATIVE_STORE_DISPOSITION_UNKNOWN');
  assert.equal(recoveryError?.cause?.code, 'RECOVERY_REQUIRED');
  assert.equal(recoveryError?.closeError, closeFailure);
  assert.equal(cold.state, 'disposition_unknown');
  assert.equal(cold.connectionEpoch, null);
  assert.ok(sqliteStatementCount > 0);
  assert.equal(terminalAttemptCount, 0);
  assert.equal(guardCloseCount, 1);
  assert.deepEqual(rawControlStore.read(), evidenceBeforeRecover);
  assert.equal(rawDatabase.query('SELECT COUNT(*) AS count FROM characters').get().count, 0);
});

test('Task 4 Batch 3: corrupt prepared live predicates never publish a terminal', { timeout: 60_000 }, (t) => {
  const cases = [
    {
      name: 'seq-third-state',
      mutate(database) {
        database.query("UPDATE project_meta SET value = '2' WHERE key = 'durability_commit_seq'").run();
      },
    },
    {
      name: 'seq-noncanonical',
      mutate(database) {
        database.query("UPDATE project_meta SET value = '01' WHERE key = 'durability_commit_seq'").run();
      },
    },
    {
      name: 'seq-overflow',
      mutate(database) {
        database.query("UPDATE project_meta SET value = '9007199254740992' WHERE key = 'durability_commit_seq'").run();
      },
    },
    { name: 'gate-nonempty', keepGate: true, mutate() {} },
    {
      name: 'schema-version',
      mutate(database) {
        database.query("UPDATE project_meta SET value = '12' WHERE key = 'schema_version'").run();
      },
    },
    {
      name: 'backend',
      mutate(database) {
        database.query("UPDATE project_meta SET value = 'wrong-backend' WHERE key = 'durability_backend'").run();
      },
    },
    {
      name: 'project-instance',
      mutate(database) {
        database.query("UPDATE project_meta SET value = ? WHERE key = 'project_instance_id'").run(randomUUID());
      },
    },
    {
      name: 'trigger-meta-digest',
      mutate(database) {
        database.query(
          "UPDATE project_meta SET value = ? WHERE key = 'durability_trigger_set_digest'",
        ).run(sha256('wrong-trigger-meta-digest'));
      },
    },
    {
      name: 'trigger-sqlite-definition',
      mutate(database) {
        const triggerName = canonicalTriggerDefinitions()[0].name;
        database.exec(`DROP TRIGGER "${triggerName}"`);
      },
    },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-corrupt-${current.name}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    const rawControlStore = openControlStore(fixture.controlDirectory);
    rawControlStore.compareAndAppend(source.digest, {
      type: 'sqlite.tx.prepared',
      payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
    });
    writer.close();

    const mutator = new Database(fixture.databasePath, { create: false, strict: true });
    mutator.exec('BEGIN IMMEDIATE');
    mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
    current.mutate(mutator);
    if (!current.keepGate) {
      mutator.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
    }
    mutator.exec('COMMIT');
    mutator.close();

    let terminalAttemptCount = 0;
    let sqliteOpenCount = 0;
    let sqliteStatementCount = 0;
    let sqliteCloseCount = 0;
    const controlStore = {
      read: () => rawControlStore.read(),
      assertCurrent: () => rawControlStore.assertCurrent(),
      tail: () => rawControlStore.tail(),
      compareAndAppend(expectedTailDigest, event) {
        if (['sqlite.tx.rolled_back', 'sqlite.tx.committed'].includes(event.type)) {
          terminalAttemptCount += 1;
        }
        return rawControlStore.compareAndAppend(expectedTailDigest, event);
      },
      append: (...args) => rawControlStore.append(...args),
    };
    const cold = createCoreFixtureStore(fixture, {
      controlStore,
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        const database = new Database(databasePath, { create: false, strict: true });
        return {
          get inTransaction() {
            return database.inTransaction;
          },
          query(sql) {
            sqliteStatementCount += 1;
            return database.query(sql);
          },
          exec(sql) {
            sqliteStatementCount += 1;
            return database.exec(sql);
          },
          close() {
            sqliteCloseCount += 1;
            return database.close(true);
          },
        };
      },
    });
    const evidenceBeforeRecover = rawControlStore.read();

    assert.throws(
      () => cold.recover(),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      current.name,
    );
    assert.equal(cold.state, 'fenced', current.name);
    assert.equal(cold.connectionEpoch, null, current.name);
    assert.equal(sqliteOpenCount, 1, current.name);
    assert.ok(sqliteStatementCount > 0, current.name);
    assert.equal(sqliteCloseCount, 1, current.name);
    assert.equal(terminalAttemptCount, 0, current.name);
    assert.deepEqual(rawControlStore.read(), evidenceBeforeRecover, current.name);
    const inspector = new Database(fixture.databasePath, { create: false, strict: true });
    assert.equal(inspector.query('SELECT COUNT(*) AS count FROM characters').get().count, 0, current.name);
    assert.equal(
      inspector.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count,
      current.keepGate ? 1 : 0,
      current.name,
    );
    inspector.close();
  }
});

test('Task 4 Batch 3: invalid prepared admission never reaches identity or SQLite', { timeout: 30_000 }, (t) => {
  const cases = [
    {
      name: 'wrong-expected-trigger-digest',
      preparedOverrides: { expectedTriggerSetDigest: sha256('wrong-expected-trigger-digest') },
    },
    { name: 'wrong-db-key', preparedOverrides: { dbKey: sha256('wrong-prepared-db-key') } },
    {
      name: 'wrong-expected-identity',
      preparedOverrides(fixture) {
        const [genesis] = openControlStore(fixture.controlDirectory).read();
        return {
          expectedIdentity: {
            dev: genesis.payload.identity.dev,
            ino: String(BigInt(genesis.payload.identity.ino) + 1n),
          },
        };
      },
    },
    { name: 'extra-prepared-key', preparedOverrides: { unexpected: true } },
    { name: 'multiple-terminal-successors', multipleSuccessors: true },
  ];

  for (const current of cases) {
    const fixture = nativeFixture(t, `native-store-task4-invalid-admission-${current.name}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    const controlStore = openControlStore(fixture.controlDirectory);
    const overrides = typeof current.preparedOverrides === 'function'
      ? current.preparedOverrides(fixture)
      : current.preparedOverrides || {};
    controlStore.compareAndAppend(source.digest, {
      type: 'sqlite.tx.prepared',
      payload: exactPreparedPayload(fixture, writer.connectionEpoch, source, overrides),
    });
    const prepared = controlStore.tail();
    if (current.multipleSuccessors) {
      const firstEpoch = randomUUID();
      controlStore.compareAndAppend(prepared.digest, {
        type: 'sqlite.tx.rolled_back',
        payload: exactTerminalPayload(fixture, firstEpoch, prepared, 'recovery_before_commit'),
      });
      const firstTerminal = controlStore.tail();
      controlStore.compareAndAppend(firstTerminal.digest, {
        type: 'sqlite.tx.committed',
        payload: exactTerminalPayload(fixture, randomUUID(), prepared, 'committed'),
      });
    }
    writer.close();
    const evidenceBefore = controlStore.read();
    const databaseBytesBefore = sha256(fs.readFileSync(fixture.databasePath));
    let identityCalls = 0;
    let sqliteOpenCount = 0;

    assert.throws(
      () => createCoreFixtureStore(fixture, {
        identityApi() {
          identityCalls += 1;
          throw new Error('invalid admission must not reach identity');
        },
        sqliteFactory() {
          sqliteOpenCount += 1;
          throw new Error('invalid admission must not reach SQLite');
        },
      }),
      (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
      current.name,
    );
    assert.equal(identityCalls, 0, current.name);
    assert.equal(sqliteOpenCount, 0, current.name);
    assert.deepEqual(controlStore.read(), evidenceBefore, current.name);
    assert.equal(sha256(fs.readFileSync(fixture.databasePath)), databaseBytesBefore, current.name);
  }
});

test('Task 4 review I2 RED: prepared recovery does not mint an epoch before sqliteFactory succeeds', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-review-uuid-before-sqlite');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const controlStore = openControlStore(fixture.controlDirectory);
  controlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  const uuidCalls = [];
  const coreFactory = loadNativeProjectStoreCoreWithUuidObserver((call) => uuidCalls.push(call));
  const sqliteFailure = new Error('injected sqliteFactory entry failure');
  let sqliteOpenCount = 0;
  const cold = createCoreFixtureStore(fixture, {
    coreFactory,
    sqliteFactory() {
      sqliteOpenCount += 1;
      throw sqliteFailure;
    },
  });
  t.after(() => {
    try {
      if (cold.state === 'recovery_required') cold.close();
    } catch {
      // Preserve the primary assertion.
    }
  });
  const evidenceBeforeRecover = controlStore.read();
  uuidCalls.length = 0;

  assert.throws(
    () => cold.recover(),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.cause === sqliteFailure,
  );
  assert.equal(sqliteOpenCount, 1);
  assert.deepEqual(uuidCalls, []);
  assert.deepEqual(controlStore.read(), evidenceBeforeRecover);
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
});

test('Task 4 review I2: prepared post-open lease drift does not mint an epoch', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-review-uuid-post-open');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const controlStore = openControlStore(fixture.controlDirectory);
  controlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  const uuidCalls = [];
  const coreFactory = loadNativeProjectStoreCoreWithUuidObserver((call) => uuidCalls.push(call));
  const leaseFailure = Object.assign(new Error('injected post-open lease drift'), {
    code: 'WRITER_LEASE_LOST',
  });
  let phase = 'cold';
  let sqliteOpenCount = 0;
  let sqliteStatementCount = 0;
  let sqliteCloseCount = 0;
  const cold = createCoreFixtureStore(fixture, {
    coreFactory,
    assertWriterLease() {
      if (phase === 'post-open') throw leaseFailure;
      return true;
    },
    sqliteFactory() {
      sqliteOpenCount += 1;
      phase = 'post-open';
      return {
        get inTransaction() {
          return false;
        },
        query() {
          sqliteStatementCount += 1;
          assert.fail('post-open lease drift must precede SQLite statements');
        },
        exec() {
          sqliteStatementCount += 1;
          assert.fail('post-open lease drift must precede SQLite statements');
        },
        close() {
          sqliteCloseCount += 1;
        },
      };
    },
  });
  t.after(() => {
    try {
      if (cold.state === 'recovery_required') cold.close();
    } catch {
      // Preserve the primary assertion.
    }
  });
  const evidenceBeforeRecover = controlStore.read();
  uuidCalls.length = 0;

  assert.throws(
    () => cold.recover(),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.cause === leaseFailure,
  );
  assert.deepEqual(uuidCalls, []);
  assert.equal(sqliteOpenCount, 1);
  assert.equal(sqliteStatementCount, 0);
  assert.equal(sqliteCloseCount, 1);
  assert.deepEqual(controlStore.read(), evidenceBeforeRecover);
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
});

test('Task 4 review I2: prepared live third state does not mint an epoch', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-review-uuid-live-third-state');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const controlStore = openControlStore(fixture.controlDirectory);
  controlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  const mutator = new Database(fixture.databasePath, { create: false, strict: true });
  mutator.exec('BEGIN IMMEDIATE');
  mutator.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
  mutator.query(
    "UPDATE project_meta SET value = '2' WHERE key = 'durability_commit_seq' AND value = '0'",
  ).run();
  mutator.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
  mutator.exec('COMMIT');
  mutator.close();

  const uuidCalls = [];
  const coreFactory = loadNativeProjectStoreCoreWithUuidObserver((call) => uuidCalls.push(call));
  const cold = createCoreFixtureStore(fixture, { coreFactory });
  const evidenceBeforeRecover = controlStore.read();
  uuidCalls.length = 0;

  assert.throws(
    () => cold.recover(),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.deepEqual(uuidCalls, []);
  assert.deepEqual(controlStore.read(), evidenceBeforeRecover);
  assert.equal(cold.state, 'fenced');
  assert.equal(cold.connectionEpoch, null);
});

test('Task 4 review I2: successful prepared recovery mints once after live validation', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-review-uuid-after-live-validation');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const controlStore = openControlStore(fixture.controlDirectory);
  controlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();

  let phase = 'cold';
  const uuidCalls = [];
  const coreFactory = loadNativeProjectStoreCoreWithUuidObserver((call) => {
    uuidCalls.push(Object.freeze({ ...call, phase }));
  });
  let rawDatabase;
  let databaseClosed = false;
  const cold = createCoreFixtureStore(fixture, {
    coreFactory,
    sqliteFactory(databasePath) {
      rawDatabase = new Database(databasePath, { create: false, strict: true });
      phase = 'sqlite-open';
      return {
        get inTransaction() {
          return rawDatabase.inTransaction;
        },
        query(sql) {
          const statement = rawDatabase.query(sql);
          return {
            all(...params) {
              const result = statement.all(...params);
              if (sql.includes('FROM sqlite_schema') && sql.includes("type = 'trigger'")) {
                phase = 'live-validated';
              }
              return result;
            },
            get: (...params) => statement.get(...params),
            run: (...params) => statement.run(...params),
          };
        },
        exec: (sql) => rawDatabase.exec(sql),
        close() {
          databaseClosed = true;
          return rawDatabase.close(true);
        },
      };
    },
  });
  t.after(() => {
    try {
      if (cold.state === 'active') cold.close();
    } catch {
      // Preserve the primary assertion.
    }
    if (!databaseClosed) {
      try {
        rawDatabase?.close(true);
      } catch {
        // The facade owns its database close.
      }
    }
  });
  uuidCalls.length = 0;

  const recovered = cold.recover();
  const candidateCalls = uuidCalls.filter((call) => call.stack.includes('mintFreshConnectionEpoch'));
  const terminal = controlStore.tail();
  assert.equal(candidateCalls.length, 1);
  assert.equal(uuidCalls[0], candidateCalls[0]);
  assert.equal(candidateCalls[0].phase, 'live-validated');
  assert.equal(uuidCalls.every((call) => call.phase === 'live-validated'), true);
  assert.equal(recovered.connectionEpoch, candidateCalls[0].value);
  assert.equal(terminal.payload.connectionEpoch, candidateCalls[0].value);
  assert.equal(uuidCalls.some((call) => call.value === terminal.payload.eventId), true);
  assert.equal(cold.state, 'active');
});

test('Task 4 review I1 RED: close and fence own the operation token across resource callbacks', { timeout: 60_000 }, (t) => {
  const outerActions = ['close', 'fence'];
  const callbackPoints = ['database.close', 'guard.close'];
  const reentryBatches = [
    {
      name: 'operational',
      methods: ['readAll', 'readGet', 'executeTransaction', 'recover', 'checkpoint'],
    },
    { name: 'close', methods: ['close'] },
    { name: 'fence', methods: ['fence'] },
  ];

  for (const outerAction of outerActions) {
    for (const callbackPoint of callbackPoints) {
      for (const batch of reentryBatches) {
        const label = `${outerAction}/${callbackPoint}/${batch.name}`;
        const fixture = nativeFixture(
          t,
          `native-store-task4-review-token-${outerAction}-${callbackPoint.replace('.', '-')}-${batch.name}`,
        );
        const rawControlStore = openControlStore(fixture.controlDirectory);
        let facade;
        let rawGuard;
        let rawDatabase;
        let rawDatabaseClosed = false;
        let capture = false;
        let callbackArmed = false;
        let callbackTriggered = false;
        let sqliteOpenCount = 0;
        let sqliteStatementCount = 0;
        let databaseCloseCount = 0;
        let guardAssertCount = 0;
        let guardCloseCount = 0;
        let controlReadCount = 0;
        let controlAssertCount = 0;
        let controlAppendCount = 0;
        let leaseCount = 0;
        let executeInputTouches = 0;
        const reentryCodes = {};
        const executeInput = new Proxy({}, {
          ownKeys() {
            executeInputTouches += 1;
            return [];
          },
        });
        const controlStore = {
          read() {
            if (capture) controlReadCount += 1;
            return rawControlStore.read();
          },
          assertCurrent() {
            if (capture) controlAssertCount += 1;
            return rawControlStore.assertCurrent();
          },
          tail: () => rawControlStore.tail(),
          compareAndAppend(...args) {
            if (capture) controlAppendCount += 1;
            return rawControlStore.compareAndAppend(...args);
          },
          append(...args) {
            if (capture) controlAppendCount += 1;
            return rawControlStore.append(...args);
          },
        };
        const invokeReentry = () => {
          if (!callbackArmed || callbackTriggered) return;
          callbackTriggered = true;
          callbackArmed = false;
          const calls = {
            readAll: () => facade.readAll('SELECT key, value FROM project_meta WHERE key = ?', 'schema_version'),
            readGet: () => facade.readGet('SELECT key, value FROM project_meta WHERE key = ?', 'schema_version'),
            executeTransaction: () => facade.executeTransaction(executeInput, () => undefined),
            recover: () => facade.recover(),
            checkpoint: () => facade.checkpoint(),
            close: () => facade.close(),
            fence: () => facade.fence(),
          };
          for (const method of batch.methods) {
            try {
              calls[method]();
              reentryCodes[method] = null;
            } catch (error) {
              reentryCodes[method] = error?.code || null;
            }
          }
        };

        facade = createCoreFixtureStore(fixture, {
          controlStore,
          identityApi({ databasePath }) {
            rawGuard = createDatabaseIdentityGuard({ databasePath });
            return {
              canonicalPath: rawGuard.canonicalPath,
              identity: rawGuard.identity,
              assertCurrent() {
                if (capture) guardAssertCount += 1;
                return rawGuard.assertCurrent();
              },
              close() {
                guardCloseCount += 1;
                if (callbackPoint === 'guard.close') invokeReentry();
              },
            };
          },
          assertWriterLease() {
            if (capture) leaseCount += 1;
            return true;
          },
          sqliteFactory(databasePath) {
            if (capture) sqliteOpenCount += 1;
            rawDatabase = new Database(databasePath, { create: false, strict: true });
            return {
              get inTransaction() {
                return rawDatabase.inTransaction;
              },
              query(sql) {
                if (capture) sqliteStatementCount += 1;
                return rawDatabase.query(sql);
              },
              exec(sql) {
                if (capture) sqliteStatementCount += 1;
                return rawDatabase.exec(sql);
              },
              close() {
                databaseCloseCount += 1;
                if (callbackPoint === 'database.close') invokeReentry();
                if (!rawDatabaseClosed) {
                  rawDatabaseClosed = true;
                  rawDatabase.close(true);
                }
              },
            };
          },
        });
        t.after(() => {
          if (!rawDatabaseClosed) {
            try {
              rawDatabase?.close(true);
            } catch {
              // The facade owns its database close.
            }
          }
          try {
            rawGuard?.close();
          } catch {
            // The facade owns its guard close.
          }
        });
        const evidenceBefore = rawControlStore.read();
        const connectionEpochBefore = facade.connectionEpoch;
        capture = true;
        callbackArmed = true;

        assert.equal(facade[outerAction](), undefined, label);
        assert.equal(callbackTriggered, true, label);
        assert.deepEqual(
          reentryCodes,
          Object.fromEntries(batch.methods.map((method) => [method, 'NATIVE_OPERATION_IN_PROGRESS'])),
          label,
        );
        assert.equal(sqliteOpenCount, 0, label);
        assert.equal(sqliteStatementCount, 0, label);
        assert.equal(guardAssertCount, 0, label);
        assert.equal(controlReadCount, 0, label);
        assert.equal(controlAssertCount, 0, label);
        assert.equal(controlAppendCount, 0, label);
        assert.equal(leaseCount, 0, label);
        assert.equal(executeInputTouches, 0, label);
        assert.equal(databaseCloseCount, 1, label);
        assert.equal(guardCloseCount, 1, label);
        assert.equal(facade.state, outerAction === 'close' ? 'released' : 'fenced', label);
        assert.equal(facade.connectionEpoch, connectionEpochBefore, label);
        assert.deepEqual(rawControlStore.read(), evidenceBefore, label);
      }
    }
  }
});

test('Task 4 review I3 RED: pre-statement drift closes database and guard best-effort without losing the primary cause', { timeout: 30_000 }, (t) => {
  for (const mode of ['source', 'prepared']) {
    const fixture = nativeFixture(t, `native-store-task4-review-prestatement-close-${mode}`);
    const writer = createStageBFixtureStore(fixture);
    const source = appendSource(fixture, writer);
    const rawControlStore = openControlStore(fixture.controlDirectory);
    if (mode === 'prepared') {
      rawControlStore.compareAndAppend(source.digest, {
        type: 'sqlite.tx.prepared',
        payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
      });
    }
    writer.close();

    const primaryFailure = Object.assign(new Error(`injected ${mode} post-open lease drift`), {
      code: 'WRITER_LEASE_LOST',
    });
    const databaseCloseFailure = new Error(`injected ${mode} database close failure`);
    const guardCloseFailure = new Error(`injected ${mode} guard close failure`);
    let phase = 'construct';
    let cold;
    let rawGuard;
    let rawDatabase;
    let sqliteOpenCount = 0;
    let sqliteStatementCount = 0;
    let databaseCloseCount = 0;
    let guardCloseCount = 0;
    let productionAppendCount = 0;
    const controlStore = {
      read: () => rawControlStore.read(),
      assertCurrent: () => rawControlStore.assertCurrent(),
      tail: () => rawControlStore.tail(),
      compareAndAppend(...args) {
        productionAppendCount += 1;
        return rawControlStore.compareAndAppend(...args);
      },
      append(...args) {
        productionAppendCount += 1;
        return rawControlStore.append(...args);
      },
    };
    cold = createCoreFixtureStore(fixture, {
      controlStore,
      identityApi({ databasePath }) {
        rawGuard = createDatabaseIdentityGuard({ databasePath });
        return {
          canonicalPath: rawGuard.canonicalPath,
          identity: rawGuard.identity,
          assertCurrent: () => rawGuard.assertCurrent(),
          close() {
            guardCloseCount += 1;
            throw guardCloseFailure;
          },
        };
      },
      assertWriterLease() {
        if (phase === 'post-open') throw primaryFailure;
        return true;
      },
      sqliteFactory(databasePath) {
        sqliteOpenCount += 1;
        rawDatabase = new Database(databasePath, { create: false, strict: true });
        phase = 'post-open';
        return {
          get inTransaction() {
            return rawDatabase.inTransaction;
          },
          query(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.query(sql);
          },
          exec(sql) {
            sqliteStatementCount += 1;
            return rawDatabase.exec(sql);
          },
          close() {
            databaseCloseCount += 1;
            throw databaseCloseFailure;
          },
        };
      },
    });
    t.after(() => {
      try {
        rawDatabase?.close(true);
      } catch {
        // The injected wrapper intentionally failed before closing it.
      }
      try {
        rawGuard?.close();
      } catch {
        // The injected wrapper intentionally failed before closing it.
      }
    });
    if (mode === 'source') {
      appendCallerOwnedAbandoned({
        controlStore: rawControlStore,
        source,
        reasonCode: 'cancelled',
      });
    }
    const evidenceBeforeRecover = rawControlStore.read();
    productionAppendCount = 0;

    let thrown;
    try {
      cold.recover();
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown?.code, 'NATIVE_STORE_DISPOSITION_UNKNOWN', mode);
    assert.equal(thrown?.cause, primaryFailure, mode);
    assert.equal(thrown?.closeError, databaseCloseFailure, mode);
    assert.deepEqual(thrown?.additionalCloseErrors, [guardCloseFailure], mode);
    assert.equal(Object.isFrozen(thrown?.additionalCloseErrors), true, mode);
    assert.equal(sqliteOpenCount, 1, mode);
    assert.equal(sqliteStatementCount, 0, mode);
    assert.equal(databaseCloseCount, 1, mode);
    assert.equal(guardCloseCount, 1, mode);
    assert.equal(productionAppendCount, 0, mode);
    assert.deepEqual(rawControlStore.read(), evidenceBeforeRecover, mode);
    assert.equal(cold.state, 'disposition_unknown', mode);
    assert.equal(cold.connectionEpoch, null, mode);
  }
});

test('Task 4 review I4 RED: exact prepared replacement before construction maps to recovery required', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-review-prepared-construction-replacement');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  const controlStore = openControlStore(fixture.controlDirectory);
  controlStore.compareAndAppend(source.digest, {
    type: 'sqlite.tx.prepared',
    payload: exactPreparedPayload(fixture, writer.connectionEpoch, source),
  });
  writer.close();
  const evidenceBefore = controlStore.read();

  const replacementPath = path.join(fixture.root, 'construction-replacement.db');
  const heldPath = path.join(fixture.root, 'construction-held-original.db');
  fs.copyFileSync(fixture.databasePath, replacementPath);
  fs.renameSync(fixture.databasePath, heldPath);
  fs.renameSync(replacementPath, fixture.databasePath);

  let identityCalls = 0;
  let sqliteOpenCount = 0;
  assert.throws(
    () => createCoreFixtureStore(fixture, {
      identityApi(options) {
        identityCalls += 1;
        return createDatabaseIdentityGuard(options);
      },
      sqliteFactory() {
        sqliteOpenCount += 1;
        assert.fail('prepared construction replacement must not reach SQLite');
      },
    }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(identityCalls, 1);
  assert.equal(sqliteOpenCount, 0);
  assert.deepEqual(controlStore.read(), evidenceBefore);
});

test('Task 4 review I5 RED: invalid source suffix outranks simultaneous same-path identity drift', (t) => {
  const fixture = nativeFixture(t, 'native-store-task4-review-invalid-source-suffix-identity');
  const writer = createStageBFixtureStore(fixture);
  const source = appendSource(fixture, writer);
  writer.close();

  const rawControlStore = openControlStore(fixture.controlDirectory);
  let sqliteOpenCount = 0;
  let productionAppendCount = 0;
  const controlStore = {
    read: () => rawControlStore.read(),
    assertCurrent: () => rawControlStore.assertCurrent(),
    tail: () => rawControlStore.tail(),
    compareAndAppend(...args) {
      productionAppendCount += 1;
      return rawControlStore.compareAndAppend(...args);
    },
    append(...args) {
      productionAppendCount += 1;
      return rawControlStore.append(...args);
    },
  };
  const cold = createCoreFixtureStore(fixture, {
    controlStore,
    sqliteFactory() {
      sqliteOpenCount += 1;
      assert.fail('invalid source suffix must be rejected before SQLite');
    },
  });
  t.after(() => {
    try {
      if (cold.state === 'recovery_required') cold.close();
    } catch {
      // Preserve the primary assertion.
    }
  });

  rawControlStore.compareAndAppend(source.digest, {
    type: 'manuscript.source.abandoned',
    payload: callerOwnedAbandonedPayload(source, 'cancelled', { unexpected: true }),
  });
  const replacementPath = path.join(fixture.root, 'recover-replacement.db');
  const heldPath = path.join(fixture.root, 'recover-held-original.db');
  fs.copyFileSync(fixture.databasePath, replacementPath);
  fs.renameSync(fixture.databasePath, heldPath);
  fs.renameSync(replacementPath, fixture.databasePath);
  const evidenceBeforeRecover = rawControlStore.read();
  productionAppendCount = 0;

  assert.throws(
    () => cold.recover(),
    (error) => error?.code === 'NATIVE_ADMISSION_REJECTED',
  );
  assert.equal(sqliteOpenCount, 0);
  assert.equal(productionAppendCount, 0);
  assert.deepEqual(rawControlStore.read(), evidenceBeforeRecover);
  assert.equal(cold.state, 'recovery_required');
  assert.equal(cold.connectionEpoch, null);
});
