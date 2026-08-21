const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Database } = require('bun:sqlite');

const {
  WRITABLE_PROJECT_TABLES,
  auditWritableTableManifest,
  canonicalTriggerDefinitions,
  canonicalTriggerSetDigest,
  inspectSchema11Contract,
  installSchema11Contract,
} = require('../native/durability-schema');
const {
  createNativeStageBFixture,
  createSchema10ProjectFixture,
  snapshotDefaultUserRoots,
} = require('../testing/native-stage-b-fixture');
const { inspectControlStoreEvidence } = require('../control-store');

const EXPECTED_WRITABLE_TABLES = Object.freeze([
  'chapter_characters',
  'chapter_revisions',
  'chapters',
  'character_relations',
  'characters',
  'chat_messages',
  'chat_sessions',
  'clue_board',
  'foreshadows',
  'memories',
  'project_genres',
  'project_meta',
  'science_entries',
  'sidebar_items',
  'timeline_events',
  'token_usage',
  'volumes',
  'world_entries',
]);
const EXPECTED_TRIGGER_SET_DIGEST = '5b7051891e370d2dbfe5c924cf6d1b3cb7dcc896cab5bafa51f67be6a5a46afe';
const NATIVE_KEYS = Object.freeze([
  'durability_backend',
  'durability_commit_seq',
  'durability_trigger_set_digest',
  'durability_trigger_version',
]);

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function closeDatabase(database) {
  try {
    database.close();
  } catch {
    // The test still reports the primary assertion or installer failure.
  }
}

function openFixtureDatabase(fixture) {
  return new Database(fixture.databasePath, { create: false, strict: true });
}

function withSchema10Fixture(t, name) {
  const fixture = createSchema10ProjectFixture({ name });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  return fixture;
}

function schemaSnapshot(database) {
  return {
    meta: database.query('SELECT key, value FROM project_meta ORDER BY key').all(),
    schema: database.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all(),
  };
}

function byteTreeSnapshot(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => utf8Compare(left.name, right.name))
    .flatMap((entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return [
          { kind: 'directory', path: entry.name },
          ...byteTreeSnapshot(entryPath).map((child) => ({
            ...child,
            path: path.join(entry.name, child.path),
          })),
        ];
      }
      const bytes = fs.readFileSync(entryPath);
      return [{
        kind: entry.isFile() ? 'file' : 'other',
        path: entry.name,
        bytes: bytes.toString('base64'),
      }];
    });
}

function runDowngradeGuardWorker(databasePath, mode) {
  const script = String.raw`
    const { Database } = require('bun:sqlite');
    const { WRITABLE_PROJECT_TABLES, canonicalTriggerDefinitions } = require('./server/native/durability-schema');
    const database = new Database(process.argv[1], { create: false, strict: true });
    const quote = (value) => '"' + String(value).replaceAll('"', '""') + '"';
    if (process.argv[2] === 'seed') {
      database.exec('PRAGMA foreign_keys = OFF');
      database.exec('PRAGMA ignore_check_constraints = ON');
      database.exec('BEGIN EXCLUSIVE');
      database.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
      for (const table of WRITABLE_PROJECT_TABLES) {
        if (database.query('SELECT COUNT(*) AS count FROM ' + quote(table)).get().count > 0) continue;
        const required = database.query('PRAGMA table_info(' + quote(table) + ')').all()
          .filter((column) => column.notnull === 1 && column.dflt_value === null
            && !(column.pk === 1 && /INT/i.test(column.type || '')));
        const columns = required.map((column) => quote(column.name));
        const values = required.map((column) => /INT|REAL|NUM|DEC|FLOAT|DOUBLE/i.test(column.type || '')
          ? 1 : 'guard-' + table + '-' + column.name);
        const sql = columns.length === 0
          ? 'INSERT INTO ' + quote(table) + ' DEFAULT VALUES'
          : 'INSERT INTO ' + quote(table) + ' (' + columns.join(', ') + ') VALUES ('
            + values.map(() => '?').join(', ') + ')';
        database.query(sql).run(...values);
      }
      database.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
      database.exec('COMMIT');
    } else {
      for (const definition of canonicalTriggerDefinitions()) {
        const sql = definition.operation === 'INSERT'
          ? 'INSERT INTO ' + quote(definition.table) + ' DEFAULT VALUES'
          : definition.operation === 'UPDATE'
            ? 'UPDATE ' + quote(definition.table) + ' SET rowid = rowid'
            : 'DELETE FROM ' + quote(definition.table);
        let rejected = false;
        try { database.exec(sql); }
        catch (error) { rejected = /MYTHPEN_DURABILITY_WRITE_GATE_CLOSED/.test(String(error.message)); }
        if (!rejected) throw new Error(definition.operation + ' ' + definition.table + ' was not rejected');
      }
    }
    if (database.inTransaction) throw new Error('downgrade guard worker left a transaction open');
    database.close(true);
  `;
  const result = spawnSync(process.execPath, ['-e', script, databasePath, mode], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function interceptDatabase(database, intercept) {
  return {
    get inTransaction() {
      return database.inTransaction;
    },
    exec(sql) {
      intercept({ kind: 'exec', sql, database });
      return database.exec(sql);
    },
    query(sql) {
      const statement = database.query(sql);
      return {
        all: (...params) => statement.all(...params),
        get: (...params) => statement.get(...params),
        run: (...params) => {
          intercept({ kind: 'run', sql, params, database });
          return statement.run(...params);
        },
      };
    },
  };
}

test('schema 11 freezes the complete 18-table writable manifest and 54 canonical triggers', () => {
  assert.deepEqual(WRITABLE_PROJECT_TABLES, EXPECTED_WRITABLE_TABLES);
  assert.ok(Object.isFrozen(WRITABLE_PROJECT_TABLES));

  const definitions = canonicalTriggerDefinitions();
  assert.equal(definitions.length, 54);
  assert.deepEqual(
    definitions.map(({ name }) => name),
    definitions.map(({ name }) => name).toSorted(utf8Compare),
  );
  assert.deepEqual(
    [...new Set(definitions.map(({ table }) => table))].toSorted(utf8Compare),
    EXPECTED_WRITABLE_TABLES,
  );
  for (const table of EXPECTED_WRITABLE_TABLES) {
    const tableDefinitions = definitions.filter((definition) => definition.table === table);
    assert.deepEqual(tableDefinitions.map(({ operation }) => operation), ['DELETE', 'INSERT', 'UPDATE']);
    for (const definition of tableDefinitions) {
      assert.deepEqual(Object.keys(definition), ['name', 'table', 'operation', 'sql']);
      assert.equal(
        definition.name,
        `_mythpen_downgrade_guard__${table}__${definition.operation.toLowerCase()}`,
      );
      assert.match(definition.sql, new RegExp(`BEFORE ${definition.operation} ON "${table}"`));
      assert.match(definition.sql, /MYTHPEN_DURABILITY_WRITE_GATE_CLOSED/);
      assert.ok(Object.isFrozen(definition));
    }
  }
  assert.equal(canonicalTriggerSetDigest(), EXPECTED_TRIGGER_SET_DIGEST);
});

test('the canonical digest is stable under CRLF and formatting but rejects malformed SQL', () => {
  const definitions = canonicalTriggerDefinitions();
  const keywordPattern = /\b(CREATE|TRIGGER|BEFORE|DELETE|INSERT|UPDATE|ON|FOR|EACH|ROW|WHEN|NOT|EXISTS|SELECT|FROM|WHERE|BEGIN|RAISE|ABORT|END)\b/g;
  const reformatted = definitions.map((definition) => ({
    ...definition,
    sql: `/* harmless leading comment */\r\n${definition.sql
      .replace(keywordPattern, (keyword) => keyword.toLowerCase())
      .replaceAll('\n', '\r\n')
      .replaceAll('  ', '    ')}; -- optional final semicolon\r\n`,
  }));
  assert.equal(canonicalTriggerSetDigest(reformatted), EXPECTED_TRIGGER_SET_DIGEST);
  for (const sql of [
    `${definitions[0].sql}\0`,
    'CREATE TRIGGER "unterminated',
    `${definitions[0].sql}; SELECT 1`,
    'SELECT 1',
  ]) {
    assert.throws(
      () => canonicalTriggerSetDigest([{ ...definitions[0], sql }]),
      /malformed|unterminated|NUL|structure|statement/i,
    );
  }
});

test('the direct installer atomically creates the exact schema 11 contract', (t) => {
  const fixture = withSchema10Fixture(t, 'schema11-happy');
  const database = openFixtureDatabase(fixture);
  t.after(() => closeDatabase(database));
  const beforeInstance = database.query(
    "SELECT value FROM project_meta WHERE key = 'project_instance_id'",
  ).get().value;

  const installed = installSchema11Contract(database);
  const inspected = inspectSchema11Contract(database);

  assert.deepEqual(installed, inspected);
  assert.deepEqual(inspected, {
    schemaVersion: 11,
    projectInstanceId: beforeInstance,
    projectInstanceIdSha256: crypto.createHash('sha256').update(beforeInstance).digest('hex'),
    backend: 'native-sqlite-v2',
    finalSeq: 0,
    gateEmpty: true,
    triggerVersion: 1,
    triggerSetDigest: EXPECTED_TRIGGER_SET_DIGEST,
    observedTriggerSetDigest: EXPECTED_TRIGGER_SET_DIGEST,
    expectedTriggerSetDigest: EXPECTED_TRIGGER_SET_DIGEST,
  });
  assert.deepEqual(
    database.query(
      "SELECT key, value FROM project_meta WHERE key IN ('schema_version', 'project_instance_id', 'durability_backend', 'durability_commit_seq', 'durability_trigger_version', 'durability_trigger_set_digest') ORDER BY key",
    ).all(),
    [
      { key: 'durability_backend', value: 'native-sqlite-v2' },
      { key: 'durability_commit_seq', value: '0' },
      { key: 'durability_trigger_set_digest', value: EXPECTED_TRIGGER_SET_DIGEST },
      { key: 'durability_trigger_version', value: '1' },
      { key: 'project_instance_id', value: beforeInstance },
      { key: 'schema_version', value: '11' },
    ],
  );
  assert.equal(database.query('SELECT COUNT(*) AS count FROM "_durability_write_gate"').get().count, 0);
  assert.equal(
    database.query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = '_durability_write_gate'").get().sql,
    'CREATE TABLE "_durability_write_gate" ("gate_id" INTEGER NOT NULL PRIMARY KEY CHECK ("gate_id" = 1)) WITHOUT ROWID',
  );
  assert.equal(
    database.query("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND substr(name, 1, length('_mythpen_downgrade_guard__')) = '_mythpen_downgrade_guard__'").get().count,
    54,
  );
});

test('schema 11 inspection requires an explicit exact committed sequence', (t) => {
  const fixture = withSchema10Fixture(t, 'schema11-committed-sequence');
  const database = openFixtureDatabase(fixture);
  t.after(() => closeDatabase(database));
  installSchema11Contract(database);
  database.exec('BEGIN IMMEDIATE');
  database.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
  database.query(
    "UPDATE project_meta SET value = '1' WHERE key = 'durability_commit_seq'",
  ).run();
  database.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
  database.exec('COMMIT');

  assert.throws(() => inspectSchema11Contract(database), /must be exactly 0/);
  assert.equal(inspectSchema11Contract(database, { expectedFinalSeq: 1 }).finalSeq, 1);
  assert.throws(
    () => inspectSchema11Contract(database, { expectedFinalSeq: 2 }),
    /must be exactly 2/,
  );
});

test('closed gate rejects ordinary DML and an open gate admits it', (t) => {
  const fixture = withSchema10Fixture(t, 'schema11-gate');
  const database = openFixtureDatabase(fixture);
  t.after(() => closeDatabase(database));
  installSchema11Contract(database);

  assert.throws(
    () => database.query("INSERT INTO project_meta (key, value) VALUES ('gate_probe', 'one')").run(),
    /MYTHPEN_DURABILITY_WRITE_GATE_CLOSED/,
  );
  database.exec('BEGIN EXCLUSIVE');
  database.query('INSERT INTO "_durability_write_gate" ("gate_id") VALUES (1)').run();
  database.query("INSERT INTO project_meta (key, value) VALUES ('gate_probe', 'one')").run();
  database.query("UPDATE project_meta SET value = 'two' WHERE key = 'gate_probe'").run();
  database.query("DELETE FROM project_meta WHERE key = 'gate_probe'").run();
  database.query('DELETE FROM "_durability_write_gate" WHERE "gate_id" = 1').run();
  database.exec('COMMIT');
  assert.equal(database.query("SELECT COUNT(*) AS count FROM project_meta WHERE key = 'gate_probe'").get().count, 0);
});

test('generator-derived downgrade guards reject INSERT UPDATE and DELETE on every writable table without byte mutation', (t) => {
  const fixture = createNativeStageBFixture({ name: 'schema11-all-downgrade-dml' });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  runDowngradeGuardWorker(fixture.databasePath, 'seed');

  const beforeDatabase = fs.readFileSync(fixture.databasePath);
  const beforeControl = byteTreeSnapshot(fixture.controlDirectory);
  runDowngradeGuardWorker(fixture.databasePath, 'verify');

  assert.deepEqual(fs.readFileSync(fixture.databasePath), beforeDatabase);
  assert.deepEqual(byteTreeSnapshot(fixture.controlDirectory), beforeControl);
});

test('manifest audit rejects unknown application tables', (t) => {
  const fixture = withSchema10Fixture(t, 'schema11-unknown-table');
  const database = openFixtureDatabase(fixture);
  t.after(() => closeDatabase(database));
  assert.deepEqual(auditWritableTableManifest(database).writableTables, EXPECTED_WRITABLE_TABLES);
  database.exec('CREATE TABLE unregistered_application_table (id INTEGER PRIMARY KEY)');
  assert.throws(() => auditWritableTableManifest(database), /unregistered_application_table/);
});

test('manifest audit excludes only the literal sqlite_ internal prefix', (t) => {
  const fixture = withSchema10Fixture(t, 'schema11-sqlite-prefix');
  const database = openFixtureDatabase(fixture);
  t.after(() => closeDatabase(database));
  database.exec('CREATE TABLE sqliteX_application_table (id INTEGER PRIMARY KEY)');
  assert.throws(() => auditWritableTableManifest(database), /sqliteX_application_table/);
});

test('inspection recognizes only the literal canonical trigger prefix', (t) => {
  const fixture = withSchema10Fixture(t, 'schema11-trigger-prefix');
  const database = openFixtureDatabase(fixture);
  t.after(() => closeDatabase(database));
  installSchema11Contract(database);
  database.exec(
    'CREATE TRIGGER "_mythpenXdowngradeYguard__unrelated" BEFORE INSERT ON "volumes" BEGIN SELECT 1; END',
  );
  assert.equal(inspectSchema11Contract(database).triggerSetDigest, EXPECTED_TRIGGER_SET_DIGEST);
});

for (const mode of ['missing', 'extra', 'altered', 'malformed']) {
  test(`inspection rejects a ${mode} canonical trigger set`, (t) => {
    const fixture = withSchema10Fixture(t, `schema11-trigger-${mode}`);
    const database = openFixtureDatabase(fixture);
    t.after(() => closeDatabase(database));
    installSchema11Contract(database);
    const first = canonicalTriggerDefinitions()[0];
    let inspectionTarget = database;
    if (mode === 'missing') {
      database.exec(`DROP TRIGGER "${first.name}"`);
    } else if (mode === 'extra') {
      database.exec('CREATE TRIGGER "_mythpen_downgrade_guard__extra__insert" BEFORE INSERT ON "volumes" BEGIN SELECT 1; END');
    } else if (mode === 'altered') {
      database.exec(`DROP TRIGGER "${first.name}"`);
      database.exec(first.sql.replace('MYTHPEN_DURABILITY_WRITE_GATE_CLOSED', 'ALTERED_GATE'));
    } else {
      inspectionTarget = {
        query(sql) {
          const statement = database.query(sql);
          return {
            all(...params) {
              const rows = statement.all(...params);
              if (/FROM sqlite_schema WHERE type = 'trigger'/i.test(sql)) {
                return rows.map((row, index) => index === 0
                  ? { ...row, sql: 'CREATE TRIGGER "unterminated' }
                  : row);
              }
              return rows;
            },
            get: (...params) => statement.get(...params),
            run: (...params) => statement.run(...params),
          };
        },
      };
    }
    assert.throws(() => inspectSchema11Contract(inspectionTarget), /trigger|digest|malformed|unterminated/i);
  });
}

for (const mode of ['pre-existing-key', 'invalid-instance', 'schema-cas-miss', 'changed-instance']) {
  test(`installer rejects dirty v10 predicate: ${mode}`, (t) => {
    const fixture = withSchema10Fixture(t, `schema11-dirty-${mode}`);
    const database = openFixtureDatabase(fixture);
    t.after(() => closeDatabase(database));
    let installTarget = database;
    if (mode === 'pre-existing-key') {
      database.query("INSERT INTO project_meta (key, value) VALUES ('durability_backend', 'native-sqlite-v2')").run();
    } else if (mode === 'invalid-instance') {
      database.query("UPDATE project_meta SET value = 'not-a-uuid' WHERE key = 'project_instance_id'").run();
    } else if (mode === 'schema-cas-miss') {
      let injected = false;
      installTarget = interceptDatabase(database, ({ kind, sql, database: raw }) => {
        if (!injected && kind === 'run' && /UPDATE project_meta SET value = \? WHERE key = 'schema_version'/i.test(sql)) {
          injected = true;
          raw.query("UPDATE project_meta SET value = '9' WHERE key = 'schema_version'").run();
        }
      });
    } else {
      let injected = false;
      installTarget = interceptDatabase(database, ({ kind, sql, database: raw }) => {
        if (!injected && kind === 'run' && /UPDATE project_meta SET value = \? WHERE key = 'schema_version'/i.test(sql)) {
          injected = true;
          raw.query("UPDATE project_meta SET value = '00000000-0000-4000-8000-000000000000' WHERE key = 'project_instance_id'").run();
        }
      });
    }
    const before = schemaSnapshot(database);
    assert.throws(() => installSchema11Contract(installTarget));
    assert.deepEqual(schemaSnapshot(database), before);
    assert.equal(database.inTransaction, false);
  });
}

test('an injected install failure rolls back every schema 11 artifact to exact v10 state', (t) => {
  const fixture = withSchema10Fixture(t, 'schema11-install-fault');
  const beforeBytes = fs.readFileSync(fixture.databasePath);
  let database = openFixtureDatabase(fixture);
  let triggerCreates = 0;
  const faulted = interceptDatabase(database, ({ kind, sql }) => {
    if (kind === 'exec' && /^CREATE TRIGGER/i.test(sql.trim())) {
      triggerCreates += 1;
      if (triggerCreates === 19) throw new Error('injected schema install failure');
    }
  });
  assert.throws(() => installSchema11Contract(faulted), /injected schema install failure/);
  closeDatabase(database);
  database = null;
  assert.deepEqual(fs.readFileSync(fixture.databasePath), beforeBytes);
});

test('the Stage B fixture is isolated, exact, post-checked, and exposes no authority token', (t) => {
  const stableBefore = snapshotDefaultUserRoots();
  const fixture = createNativeStageBFixture({ name: 'schema11-genesis' });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const stableAfter = snapshotDefaultUserRoots();
  assert.deepEqual(stableAfter, stableBefore);

  assert.ok(Object.isFrozen(fixture));
  assert.equal(Object.hasOwn(fixture, 'authority'), false);
  assert.equal(Object.hasOwn(fixture, 'authorityToken'), false);
  assert.doesNotMatch(JSON.stringify(fixture), /authority/i);

  const database = openFixtureDatabase(fixture);
  t.after(() => closeDatabase(database));
  const contract = inspectSchema11Contract(database);
  const evidence = inspectControlStoreEvidence(fixture.controlDirectory);
  assert.equal(evidence.events.length, 1);
  const genesis = evidence.events[0];
  assert.equal(genesis.type, 'sqlite.native.stage_b.fixture_genesis');
  assert.equal(genesis.digest, fixture.genesisDigest);
  assert.deepEqual(Object.keys(genesis.payload).sort(), [
    'backend',
    'connectionEpoch',
    'createdAt',
    'dbKey',
    'eventId',
    'finalSeq',
    'fixtureRunId',
    'gateEmpty',
    'identity',
    'ownershipHash',
    'projectInstanceIdSha256',
    'schemaVersion',
    'triggerSetDigest',
    'triggerVersion',
    'version',
  ]);
  assert.deepEqual(
    {
      backend: genesis.payload.backend,
      finalSeq: genesis.payload.finalSeq,
      gateEmpty: genesis.payload.gateEmpty,
      projectInstanceIdSha256: genesis.payload.projectInstanceIdSha256,
      schemaVersion: genesis.payload.schemaVersion,
      triggerSetDigest: genesis.payload.triggerSetDigest,
      triggerVersion: genesis.payload.triggerVersion,
    },
    {
      backend: contract.backend,
      finalSeq: contract.finalSeq,
      gateEmpty: contract.gateEmpty,
      projectInstanceIdSha256: contract.projectInstanceIdSha256,
      schemaVersion: contract.schemaVersion,
      triggerSetDigest: contract.triggerSetDigest,
      triggerVersion: contract.triggerVersion,
    },
  );
  assert.equal(genesis.payload.fixtureRunId, fixture.fixtureRunId);
  assert.equal(genesis.payload.version, 1);
  for (const key of ['eventId', 'connectionEpoch', 'fixtureRunId']) {
    assert.match(genesis.payload[key], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.equal(new Date(genesis.payload.createdAt).toISOString(), genesis.payload.createdAt);
  assert.deepEqual(Object.keys(genesis.payload.identity), ['dev', 'ino']);
  assert.match(genesis.payload.ownershipHash, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(genesis.payload, 'creationEpoch'), false);
  assert.equal(path.dirname(fixture.root), fs.realpathSync.native(os.tmpdir()));
  assert.match(path.basename(fixture.root), /^mythpen-native-stage-b-/);
});

test('fixture helper rejects caller-owned roots without deleting them', () => {
  const callerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-caller-owned-'));
  const marker = path.join(callerRoot, 'keep.txt');
  fs.writeFileSync(marker, 'caller-owned');
  try {
    assert.throws(
      () => createSchema10ProjectFixture({ name: 'caller-root-rejected', root: callerRoot }),
      /root.*not supported|caller-owned root/i,
    );
    assert.equal(fs.readFileSync(marker, 'utf8'), 'caller-owned');
  } finally {
    fs.rmSync(callerRoot, { recursive: true, force: true });
  }
});

test('a genesis failure destroys the unpublished fixture', () => {
  let failedRoot;
  assert.throws(
    () => createNativeStageBFixture({
      name: 'schema11-genesis-fault',
      beforeGenesisAppend(context) {
        failedRoot = context.root;
        throw new Error('injected genesis failure');
      },
    }),
    /injected genesis failure/,
  );
  assert.equal(fs.existsSync(failedRoot), false);
});

test('production db separates schema 11 admission from the schema 10 sql.js migration target', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.match(source, /const PROJECT_SCHEMA_VERSION = 11;/);
  assert.match(source, /const SQLJS_PROJECT_SCHEMA_VERSION = 10;/);
  assert.match(source, /const NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION = 10;/);
  assert.match(
    source,
    /runMigrations\(\s*db,\s*projectMigrations,\s*SQLJS_PROJECT_SCHEMA_VERSION,\s*getProjectVersion,\s*setProjectVersion,?\s*\)/,
  );
  assert.match(source, /typeof migration !== ['"]function['"]/);
  assert.match(source, /schema migration step .* is missing/i);
  assert.match(source, /schemaVersion !== NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION/);
  assert.doesNotMatch(source, /projectMigrations\[10\]\s*=/);
  assert.doesNotMatch(source, /installSchema11Contract/);
});
