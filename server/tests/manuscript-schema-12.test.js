const assert = require('node:assert/strict');
const test = require('node:test');
const { RESERVED_PROJECT_META_KEYS } = require('../manuscript/contracts');

const {
  WRITABLE_PROJECT_TABLES,
  canonicalTriggerDefinitions,
  canonicalTriggerSetDigest,
  SCHEMA12_CONTRACT,
  schema12CanonicalTriggerDefinitions,
  schema12CanonicalTriggerSetDigest,
  inspectSchema12Contract,
} = require('../native/durability-schema');

const V1_DIGEST = '5b7051891e370d2dbfe5c924cf6d1b3cb7dcc896cab5bafa51f67be6a5a46afe';
const V2_DIGEST = 'f50f45164aa5f1e9dfe989718be9b80f44503316df78725fd148fc5576fe045a';
const EXPECTED_V2_WRITABLE_TABLES = Object.freeze([
  'chapter_characters',
  'chapter_revisions',
  'chapters',
  'character_relations',
  'characters',
  'chat_messages',
  'chat_sessions',
  'clue_board',
  'foreshadows',
  'manuscript_capacity_snapshot',
  'manuscript_controlled_files',
  'manuscript_ignored_resources',
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
const EXPECTED_RESERVED_KEYS = Object.freeze([
  'manuscript_route',
  'manuscript_project_uid',
  'manuscript_route_journal',
  'manuscript_projection_generation',
]);
const EXPECTED_OBJECT_NAMES = Object.freeze([
  '_durability_write_gate',
  'chapters',
  'foreshadows',
  'idx_chapters_active_assigned_num',
  'idx_chapters_active_unassigned_num',
  'idx_chapters_chapter_uid',
  'idx_manuscript_controlled_files_identity',
  'idx_volumes_volume_uid',
  'manuscript_capacity_snapshot',
  'manuscript_controlled_files',
  'manuscript_ignored_resources',
  'volumes',
]);

function columnNames(table) {
  return SCHEMA12_CONTRACT.tables[table].columns.map(({ name }) => name);
}

function exactMetaRows(overrides = {}) {
  const values = {
    schema_version: '12',
    project_instance_id: '3eb38b78-df65-4cd8-8885-767ea0d04308',
    durability_backend: 'native-sqlite-v2',
    durability_commit_seq: '0',
    durability_trigger_version: '2',
    durability_trigger_set_digest: schema12CanonicalTriggerSetDigest(),
    manuscript_route: 'files',
    manuscript_project_uid: '6e371f43-ef8d-42ec-8d8f-351edb2d49b0',
    manuscript_route_journal: '',
    manuscript_projection_generation: '0',
    ...overrides,
  };
  return Object.entries(values)
    .map(([key, value]) => ({ key, value, storageType: 'text' }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)));
}

function fixtureDatabase(overrides = {}) {
  const tables = overrides.tables || [
    ...SCHEMA12_CONTRACT.writableTables,
    ...SCHEMA12_CONTRACT.internalTables,
  ].map((name) => ({ name }));
  const meta = overrides.meta || exactMetaRows();
  const triggers = overrides.triggers || schema12CanonicalTriggerDefinitions().map((definition) => ({
    name: definition.name,
    tableName: definition.table,
    sql: definition.sql,
  }));
  const objects = overrides.objects || SCHEMA12_CONTRACT.schemaObjects.map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.table,
    sql: object.sql,
  }));
  return Object.freeze({
    query(sql) {
      return Object.freeze({
        all() {
          if (/substr\(name, 1, 7\).*sqlite_/i.test(sql)) return structuredClone(tables);
          if (/typeof\(value\).*project_meta/i.test(sql)) return structuredClone(meta);
          if (/type = 'trigger'.*substr\(name/i.test(sql)) return structuredClone(triggers);
          if (/type IN \('table', 'index'\)/i.test(sql)) return structuredClone(objects);
          throw new Error(`Unexpected schema 12 fixture query: ${sql}`);
        },
        get() {
          if (/COUNT\(\*\).*_durability_write_gate/i.test(sql)) return { count: 0 };
          throw new Error(`Unexpected schema 12 fixture scalar query: ${sql}`);
        },
      });
    },
  });
}

test('schema 11 v1 manifest, 54 triggers, and fixed digest remain byte-compatible', () => {
  assert.equal(WRITABLE_PROJECT_TABLES.length, 18);
  assert.equal(canonicalTriggerDefinitions().length, 54);
  assert.equal(canonicalTriggerSetDigest(), V1_DIGEST);
});

test('schema 12 freezes the complete v2 manifest and uniquely generative object descriptors', () => {
  assert.equal(SCHEMA12_CONTRACT.schemaVersion, 12);
  assert.equal(SCHEMA12_CONTRACT.triggerVersion, 2);
  assert.equal(SCHEMA12_CONTRACT.triggerSetFormat, 'mythpen-downgrade-trigger-set-v2');
  assert.deepEqual(SCHEMA12_CONTRACT.writableTables, EXPECTED_V2_WRITABLE_TABLES);
  assert.deepEqual(SCHEMA12_CONTRACT.internalTables, ['_durability_write_gate']);
  assert.deepEqual(SCHEMA12_CONTRACT.reservedProjectMetaKeys, EXPECTED_RESERVED_KEYS);
  assert.equal(SCHEMA12_CONTRACT.reservedProjectMetaKeys, RESERVED_PROJECT_META_KEYS);
  assert.deepEqual(
    SCHEMA12_CONTRACT.schemaObjects.map(({ name }) => name),
    EXPECTED_OBJECT_NAMES,
  );
  assert.equal(
    SCHEMA12_CONTRACT.schemaObjects.find(({ name }) => name === '_durability_write_gate').sql,
    'CREATE TABLE "_durability_write_gate" ("gate_id" INTEGER NOT NULL PRIMARY KEY CHECK ("gate_id" = 1)) WITHOUT ROWID',
  );
  assert.ok(Object.isFrozen(SCHEMA12_CONTRACT));
  assert.ok(Object.isFrozen(SCHEMA12_CONTRACT.tables.chapters.columns));

  assert.deepEqual(columnNames('volumes'), [
    'id', 'sort_order', 'title', 'summary', 'created_at',
    'volume_uid', 'is_present', 'deleted_at',
  ]);
  assert.deepEqual(columnNames('chapters'), [
    'id', 'volume_id', 'num', 'title', 'outline', 'content', 'summary', 'word_count',
    'status', 'cognitive_frame', 'emotional_anchor', 'world_texture', 'concrete_mystery',
    'interpersonal_tension', 'created_at', 'updated_at', 'data_version', 'chapter_uid',
    'is_present', 'deleted_at', 'chapter_position', 'manuscript_position',
    'body_raw_sha256', 'sidecar_raw_sha256', 'content_available',
  ]);
  assert.equal(columnNames('foreshadows').includes('expected_resolve_chapter'), false);
  assert.equal(columnNames('foreshadows').includes('expected_resolve_manuscript_position'), true);
  assert.match(SCHEMA12_CONTRACT.tables.chapters.createSql, /body_raw_sha256.*NOT GLOB/is);
  assert.match(SCHEMA12_CONTRACT.tables.chapters.createSql, /sidecar_raw_sha256.*NOT GLOB/is);
  assert.deepEqual(columnNames('manuscript_controlled_files'), [
    'file_role', 'resource_uid', 'raw_sha256', 'byte_size', 'file_identity_json',
    'projection_generation',
  ]);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_controlled_files.createSql, /"resource_uid" IS NULL/i);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_controlled_files.createSql, /file_identity_json.*NOT NULL/is);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_controlled_files.createSql, /json_valid\("file_identity_json"\)/i);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_controlled_files.createSql, /raw_sha256.*GLOB/is);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_ignored_resources.createSql, /member_snapshot_json.*NOT NULL/is);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_ignored_resources.createSql, /json_valid\("member_snapshot_json"\)/i);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_ignored_resources.createSql, /is_currently_referenced.*CHECK/is);
  assert.match(SCHEMA12_CONTRACT.tables.manuscript_ignored_resources.createSql, /resource_uid.*GLOB/is);
  assert.deepEqual(SCHEMA12_CONTRACT.foreignKeys, [{
    table: 'chapters',
    from: 'volume_id',
    toTable: 'volumes',
    to: 'id',
    onDelete: 'RESTRICT',
  }]);
  assert.deepEqual(
    SCHEMA12_CONTRACT.physicalDeleteBarriers.map(({ name, table }) => ({ name, table })),
    [
      { name: '_mythpen_manuscript_delete_guard__chapters', table: 'chapters' },
      { name: '_mythpen_manuscript_delete_guard__manuscript_ignored_resources', table: 'manuscript_ignored_resources' },
      { name: '_mythpen_manuscript_delete_guard__volumes', table: 'volumes' },
    ],
  );
  assert.deepEqual(SCHEMA12_CONTRACT.preservation, {
    integerPrimaryKeys: true,
    businessRows: true,
    sqliteSequence: true,
    views: true,
    nonConflictingIndexes: true,
    nonConflictingTriggers: true,
    createTableAsSelect: false,
  });
});

test('schema 12 ignored ledger descriptor freezes resource-specific indexed containers', () => {
  const ignoredResources = SCHEMA12_CONTRACT.tables.manuscript_ignored_resources;
  const containerKind = ignoredResources.columns.find(
    ({ name }) => name === 'opaque_container_kind',
  );
  const containerUid = ignoredResources.columns.find(
    ({ name }) => name === 'opaque_container_uid',
  );
  const hex = '[0-9a-f]';
  const canonicalUuidGlob = `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-[89ab]${hex.repeat(3)}-${hex.repeat(12)}`;

  assert.deepEqual(
    {
      containerKindCheck: containerKind.checkSql,
      containerUidCheck: containerUid.checkSql,
      tableConstraints: ignoredResources.tableConstraints,
    },
    {
      containerKindCheck: '"opaque_container_kind" IS NULL OR "opaque_container_kind" IN (\'manuscript\', \'unassigned\', \'volume\')',
      containerUidCheck: '"opaque_container_uid" IS NULL OR (length("opaque_container_uid") = 36 AND lower("opaque_container_uid") = "opaque_container_uid" AND "opaque_container_uid" GLOB '
        + `'${canonicalUuidGlob}')`,
      tableConstraints: [
        'PRIMARY KEY ("resource_kind", "resource_uid")',
        'CHECK (("is_currently_referenced" = 0 AND "opaque_container_kind" IS NULL AND "opaque_container_uid" IS NULL) OR ("is_currently_referenced" = 1 AND "opaque_container_kind" IS NOT NULL AND (("resource_kind" = \'volume\' AND "opaque_container_kind" = \'manuscript\' AND "opaque_container_uid" IS NULL) OR ("resource_kind" = \'chapter\' AND (("opaque_container_kind" = \'unassigned\' AND "opaque_container_uid" IS NULL) OR ("opaque_container_kind" = \'volume\' AND "opaque_container_uid" IS NOT NULL))))))',
      ],
    },
  );
});

test('schema 12 ignored ledger rejects referenced rows without an indexed container in SQLite', async () => {
  const initSqlJs = require('sql.js');
  const { getWasmBinary } = require('../wasm-binary');
  const SQL = await initSqlJs({ wasmBinary: getWasmBinary() });
  const database = new SQL.Database();
  const uid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
  const insert = ([kind, suffix, containerKind, containerUid, referenced]) => database.run(`
    INSERT INTO manuscript_ignored_resources (
      resource_kind,
      resource_uid,
      ignore_status,
      opaque_container_kind,
      opaque_container_uid,
      is_currently_referenced,
      member_snapshot_json,
      projection_generation
    ) VALUES (?, ?, 'active', ?, ?, ?, '{"version":1,"members":[]}', 0)
  `, [kind, uid(suffix), containerKind, containerUid, referenced]);

  try {
    database.exec(SCHEMA12_CONTRACT.tables.manuscript_ignored_resources.createSql);
    for (const row of [
      ['volume', 1, 'manuscript', null, 1],
      ['chapter', 2, 'unassigned', null, 1],
      ['chapter', 3, 'volume', uid(100), 1],
      ['volume', 4, null, null, 0],
    ]) {
      insert(row);
    }

    const invalidOutcomes = [
      ['chapter', 5, null, null, 1],
      ['volume', 6, null, null, 1],
    ].map((row) => {
      try {
        insert(row);
        return 'accepted';
      } catch (error) {
        return /check constraint failed/i.test(error.message) ? 'rejected' : error.message;
      }
    });
    const [{ values: [[rowCount]] }] = database.exec(
      'SELECT COUNT(*) FROM manuscript_ignored_resources',
    );

    assert.deepEqual(
      { invalidOutcomes, rowCount },
      { invalidOutcomes: ['rejected', 'rejected'], rowCount: 4 },
    );
  } finally {
    database.close();
  }
});

test('schema 12 canonical trigger set is deterministic, independent from v1, and complete', () => {
  const definitions = schema12CanonicalTriggerDefinitions();
  assert.equal(definitions.length, 66);
  assert.equal(new Set(definitions.map(({ name }) => name)).size, 66);
  assert.deepEqual(
    definitions.map(({ name }) => name),
    definitions.map(({ name }) => name).toSorted((left, right) => (
      Buffer.compare(Buffer.from(left), Buffer.from(right))
    )),
  );
  for (const table of EXPECTED_V2_WRITABLE_TABLES) {
    assert.deepEqual(
      definitions.filter((definition) => (
        definition.table === table && definition.name.startsWith('_mythpen_downgrade_guard__')
      )).map(({ operation }) => operation),
      ['DELETE', 'INSERT', 'UPDATE'],
      table,
    );
  }
  const digest = schema12CanonicalTriggerSetDigest();
  assert.equal(digest, V2_DIGEST);
  assert.equal(schema12CanonicalTriggerSetDigest(), digest);
  assert.notEqual(digest, V1_DIGEST);

  const reformatted = definitions.map((definition) => ({
    ...definition,
    sql: `/* harmless */\r\n${definition.sql.replaceAll('\n', '\r\n')}; -- trailing\r\n`,
  }));
  assert.equal(schema12CanonicalTriggerSetDigest(reformatted), digest);
  assert.throws(
    () => schema12CanonicalTriggerSetDigest(definitions.slice(1)),
    /missing|count|identity|definition/i,
  );
  assert.throws(
    () => schema12CanonicalTriggerSetDigest([
      { ...definitions[0], sql: definitions[0].sql.replace('BEFORE', 'AFTER') },
      ...definitions.slice(1),
    ]),
    /structure|semantic|definition/i,
  );
});

test('schema 12 offline inspector performs strict expected-meta-observed comparison', () => {
  const inspected = inspectSchema12Contract(fixtureDatabase(), { expectedFinalSeq: 0 });
  assert.equal(inspected.schemaVersion, 12);
  assert.equal(inspected.triggerVersion, 2);
  assert.equal(inspected.triggerSetDigest, schema12CanonicalTriggerSetDigest());
  assert.equal(inspected.expectedTriggerSetDigest, inspected.triggerSetDigest);
  assert.equal(inspected.observedTriggerSetDigest, inspected.triggerSetDigest);
  assert.deepEqual(inspected.writableTables, EXPECTED_V2_WRITABLE_TABLES);
  assert.deepEqual(inspected.internalTables, ['_durability_write_gate']);
  assert.equal(inspected.finalSeq, 0);
  assert.equal(inspected.gateEmpty, true);
});

test('schema 12 inspector requires an external expected sequence and rejects mismatch', () => {
  assert.throws(
    () => inspectSchema12Contract(fixtureDatabase()),
    /expected.*sequence|required/i,
  );
  assert.throws(
    () => inspectSchema12Contract(fixtureDatabase(), { expectedFinalSeq: 1 }),
    /must be exactly 1/i,
  );
  assert.throws(
    () => inspectSchema12Contract(fixtureDatabase(), { expectedFinalSeq: -1 }),
    /non-negative safe integer/i,
  );
});

test('schema 12 offline inspector rejects missing, extra, semantic, meta, and cross-version drift', () => {
  const allTables = [
    ...SCHEMA12_CONTRACT.writableTables,
    ...SCHEMA12_CONTRACT.internalTables,
  ].map((name) => ({ name }));
  const objects = SCHEMA12_CONTRACT.schemaObjects.map((object) => ({
    type: object.type,
    name: object.name,
    tableName: object.table,
    sql: object.sql,
  }));
  const triggers = schema12CanonicalTriggerDefinitions().map((definition) => ({
    name: definition.name,
    tableName: definition.table,
    sql: definition.sql,
  }));
  const cases = [
    fixtureDatabase({ tables: allTables.slice(1) }),
    fixtureDatabase({ tables: [...allTables, { name: 'unexpected_table' }] }),
    fixtureDatabase({ objects: objects.slice(1) }),
    fixtureDatabase({
      objects: [...objects, {
        type: 'index',
        name: 'unexpected_required_object',
        tableName: 'chapters',
        sql: 'CREATE INDEX unexpected_required_object ON chapters(id)',
      }],
    }),
    fixtureDatabase({
      objects: objects.map((object) => object.name === 'chapters'
        ? { ...object, sql: object.sql.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE') }
        : object),
    }),
    fixtureDatabase({
      objects: objects.map((object) => object.name === '_durability_write_gate'
        ? { ...object, sql: object.sql.replace('"gate_id" = 1', '"gate_id" = 2') }
        : object),
    }),
    fixtureDatabase({ triggers: triggers.slice(1) }),
    fixtureDatabase({ triggers: [...triggers, { ...triggers[0], name: 'unexpected_trigger' }] }),
    fixtureDatabase({
      triggers: triggers.map((trigger, index) => index === 0
        ? { ...trigger, sql: trigger.sql.replace('BEFORE', 'AFTER') }
        : trigger),
    }),
    fixtureDatabase({ meta: exactMetaRows().slice(1) }),
    fixtureDatabase({ meta: [...exactMetaRows(), exactMetaRows()[0]] }),
    fixtureDatabase({
      meta: exactMetaRows().map((row, index) => index === 0
        ? { ...row, storageType: 'integer' }
        : row),
    }),
    fixtureDatabase({ meta: exactMetaRows({ durability_trigger_version: '1' }) }),
    fixtureDatabase({ meta: exactMetaRows({ durability_trigger_set_digest: V1_DIGEST }) }),
    fixtureDatabase({
      triggers: canonicalTriggerDefinitions().map((definition) => ({
        name: definition.name,
        tableName: definition.table,
        sql: definition.sql,
      })),
    }),
  ];
  for (const database of cases) {
    assert.throws(
      () => inspectSchema12Contract(database, { expectedFinalSeq: 0 }),
      (error) => error?.code === 'RECOVERY_REQUIRED'
        || error?.code === 'SCHEMA_12_TABLE_MANIFEST_MISMATCH',
    );
  }
});
