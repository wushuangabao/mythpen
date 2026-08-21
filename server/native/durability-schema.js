const { createHash } = require('node:crypto');
const { RESERVED_PROJECT_META_KEYS } = require('../manuscript/contracts');

const GATE_TABLE = '_durability_write_gate';
const TRIGGER_PREFIX = '_mythpen_downgrade_guard__';
const TRIGGER_SET_FORMAT = 'mythpen-downgrade-trigger-set-v1';
const TRIGGER_VERSION = 1;
const NATIVE_BACKEND = 'native-sqlite-v2';
const NATIVE_META_VALUES = Object.freeze({
  durability_backend: NATIVE_BACKEND,
  durability_commit_seq: '0',
  durability_trigger_version: String(TRIGGER_VERSION),
});
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WRITABLE_PROJECT_TABLES = Object.freeze([
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

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function triggerName(table, operation) {
  return `${TRIGGER_PREFIX}${table}__${operation.toLowerCase()}`;
}

function triggerSql(name, table, operation) {
  return [
    `CREATE TRIGGER ${quoteIdentifier(name)}`,
    `BEFORE ${operation} ON ${quoteIdentifier(table)}`,
    'FOR EACH ROW',
    'WHEN NOT EXISTS (',
    `  SELECT 1 FROM ${quoteIdentifier(GATE_TABLE)} WHERE ${quoteIdentifier('gate_id')} = 1`,
    ')',
    'BEGIN',
    "  SELECT RAISE(ABORT, 'MYTHPEN_DURABILITY_WRITE_GATE_CLOSED');",
    'END',
  ].join('\n');
}

const CANONICAL_TRIGGER_DEFINITIONS = Object.freeze(
  WRITABLE_PROJECT_TABLES
    .flatMap((table) => ['DELETE', 'INSERT', 'UPDATE'].map((operation) => {
      const name = triggerName(table, operation);
      return Object.freeze({
        name,
        table,
        operation,
        sql: triggerSql(name, table, operation),
      });
    }))
    .sort((left, right) => utf8Compare(left.name, right.name)),
);

function malformedSql(message) {
  const error = new Error(`Malformed canonical trigger SQL: ${message}`);
  error.code = 'MALFORMED_CANONICAL_TRIGGER_SQL';
  return error;
}

function tokenizeTriggerSql(sql) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw malformedSql('SQL must be a non-empty string');
  }
  if (sql.includes('\0')) throw malformedSql('SQL must not contain NUL');
  const tokens = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && !/[\r\n]/.test(sql[index])) index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = sql.indexOf('*/', index + 2);
      if (close === -1) throw malformedSql('unterminated block comment');
      index = close + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`' || char === '[') {
      const closeChar = char === '[' ? ']' : char;
      let token = char;
      let closed = false;
      index += 1;
      while (index < sql.length) {
        token += sql[index];
        if (sql[index] === closeChar) {
          if (closeChar !== ']' && sql[index + 1] === closeChar) {
            token += closeChar;
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) throw malformedSql('unterminated quoted token');
      tokens.push(token);
      continue;
    }
    const word = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (word) {
      tokens.push(word.toUpperCase());
      index += word.length;
      continue;
    }
    const number = sql.slice(index).match(/^\d+/)?.[0];
    if (number) {
      tokens.push(number);
      index += number.length;
      continue;
    }
    if ('(),;=.'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    throw malformedSql(`unexpected token ${JSON.stringify(char)}`);
  }
  if (tokens.length === 0) throw malformedSql('SQL contains no tokens');
  if (tokens.at(-1) === ';') tokens.pop();
  if (tokens.length === 0) throw malformedSql('SQL contains no statement');
  return tokens;
}

function validateDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw malformedSql('definition must be an object');
  for (const key of ['name', 'table', 'operation', 'sql']) {
    if (typeof definition[key] !== 'string' || definition[key].length === 0) {
      throw malformedSql(`definition.${key} must be a non-empty string`);
    }
  }
  if (!['DELETE', 'INSERT', 'UPDATE'].includes(definition.operation)) {
    throw malformedSql(`unsupported operation ${definition.operation}`);
  }
  if (definition.name !== triggerName(definition.table, definition.operation)) {
    throw malformedSql('definition name/table/operation structure does not match');
  }
}

function canonicalizeDefinitionSql(definition) {
  const actualTokens = tokenizeTriggerSql(definition.sql);
  const expectedTokens = tokenizeTriggerSql(
    triggerSql(definition.name, definition.table, definition.operation),
  );
  if (JSON.stringify(actualTokens) !== JSON.stringify(expectedTokens)) {
    throw malformedSql(`unknown trigger structure for ${definition.name}`);
  }
  return actualTokens.join(' ');
}

function canonicalTriggerDefinitions() {
  return CANONICAL_TRIGGER_DEFINITIONS;
}

function canonicalTriggerSetDigest(definitions = CANONICAL_TRIGGER_DEFINITIONS) {
  if (!Array.isArray(definitions)) throw malformedSql('trigger definitions must be an array');
  const names = new Set();
  const material = definitions.map((definition) => {
    validateDefinition(definition);
    if (names.has(definition.name)) throw malformedSql(`duplicate trigger name ${definition.name}`);
    names.add(definition.name);
    return {
      name: definition.name,
      table: definition.table,
      operation: definition.operation,
      sql: canonicalizeDefinitionSql(definition),
    };
  }).sort((left, right) => utf8Compare(left.name, right.name));
  return createHash('sha256').update(JSON.stringify({
    format: TRIGGER_SET_FORMAT,
    triggers: material,
  })).digest('hex');
}

function contractError(message, code = 'RECOVERY_REQUIRED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function queryRows(database, sql, ...params) {
  return database.query(sql).all(...params);
}

function auditWritableTableManifest(database) {
  const actualTables = queryRows(
    database,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_'",
  ).map(({ name }) => name).sort(utf8Compare);
  const allowed = new Set([...WRITABLE_PROJECT_TABLES, GATE_TABLE]);
  const unknownTables = actualTables.filter((name) => !allowed.has(name));
  const missingWritableTables = WRITABLE_PROJECT_TABLES.filter((name) => !actualTables.includes(name));
  if (unknownTables.length > 0 || missingWritableTables.length > 0) {
    throw contractError(
      `Writable table manifest mismatch; unknown=[${unknownTables.join(',')}], missing=[${missingWritableTables.join(',')}]`,
      'SCHEMA_11_TABLE_MANIFEST_MISMATCH',
    );
  }
  return Object.freeze({
    writableTables: WRITABLE_PROJECT_TABLES,
    internalTables: Object.freeze(actualTables.includes(GATE_TABLE) ? [GATE_TABLE] : []),
    allApplicationTables: Object.freeze(actualTables),
  });
}

function readReservedRows(database) {
  return queryRows(
    database,
    "SELECT key, value FROM project_meta WHERE key IN ('schema_version', 'project_instance_id', 'durability_backend', 'durability_commit_seq', 'durability_trigger_version', 'durability_trigger_set_digest') ORDER BY key",
  );
}

function exactReservedMap(rows, expectedCount) {
  if (rows.length !== expectedCount) {
    throw contractError(`Expected ${expectedCount} unique reserved project_meta rows, found ${rows.length}`);
  }
  const map = new Map(rows.map(({ key, value }) => [key, value]));
  if (map.size !== rows.length) throw contractError('Reserved project_meta keys are not unique');
  return map;
}

function triggerOperationFromName(name) {
  const match = /__(delete|insert|update)$/.exec(name);
  if (!match) throw malformedSql(`trigger name has unknown structure: ${name}`);
  return match[1].toUpperCase();
}

function observedTriggerDefinitions(database) {
  const rows = queryRows(
    database,
    "SELECT name, tbl_name AS tableName, sql FROM sqlite_schema WHERE type = 'trigger' AND substr(name, 1, ?) = ?",
    TRIGGER_PREFIX.length,
    TRIGGER_PREFIX,
  );
  return rows.map((row) => ({
    name: row.name,
    table: row.tableName,
    operation: triggerOperationFromName(row.name),
    sql: row.sql,
  })).sort((left, right) => utf8Compare(left.name, right.name));
}

function inspectSchema11Contract(database, { expectedFinalSeq = 0 } = {}) {
  if (
    !Number.isSafeInteger(expectedFinalSeq)
    || expectedFinalSeq < 0
    || Object.is(expectedFinalSeq, -0)
  ) {
    throw contractError('Expected durability commit sequence must be a non-negative safe integer');
  }
  auditWritableTableManifest(database);
  const reserved = exactReservedMap(readReservedRows(database), 6);
  if (reserved.get('schema_version') !== '11') throw contractError('schema_version must be exactly 11');
  const projectInstanceId = reserved.get('project_instance_id');
  if (!UUID_V4_PATTERN.test(projectInstanceId || '')) {
    throw contractError('project_instance_id must be one valid UUID v4 value');
  }
  if (reserved.get('durability_backend') !== NATIVE_BACKEND) {
    throw contractError(`durability_backend must be ${NATIVE_BACKEND}`);
  }
  if (reserved.get('durability_commit_seq') !== String(expectedFinalSeq)) {
    throw contractError(`durability_commit_seq must be exactly ${expectedFinalSeq}`);
  }
  if (reserved.get('durability_trigger_version') !== String(TRIGGER_VERSION)) {
    throw contractError(`durability_trigger_version must be exactly ${TRIGGER_VERSION}`);
  }
  const gateRows = database.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(GATE_TABLE)}`).get();
  if (gateRows?.count !== 0) throw contractError('Durability write gate must be empty');

  const expectedDefinitions = canonicalTriggerDefinitions();
  const observedDefinitions = observedTriggerDefinitions(database);
  if (observedDefinitions.length !== expectedDefinitions.length) {
    throw contractError(
      `Canonical trigger count mismatch: expected ${expectedDefinitions.length}, observed ${observedDefinitions.length}`,
    );
  }
  const expectedNames = expectedDefinitions.map(({ name }) => name);
  const observedNames = observedDefinitions.map(({ name }) => name);
  if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
    throw contractError('Canonical trigger names do not match the expected UTF-8 ordered set');
  }
  const expectedTriggerSetDigest = canonicalTriggerSetDigest(expectedDefinitions);
  const observedTriggerSetDigest = canonicalTriggerSetDigest(observedDefinitions);
  const triggerSetDigest = reserved.get('durability_trigger_set_digest');
  if (
    triggerSetDigest !== expectedTriggerSetDigest
    || observedTriggerSetDigest !== expectedTriggerSetDigest
  ) {
    throw contractError('Canonical trigger digest three-way comparison failed');
  }
  return Object.freeze({
    schemaVersion: 11,
    projectInstanceId,
    projectInstanceIdSha256: createHash('sha256').update(projectInstanceId).digest('hex'),
    backend: NATIVE_BACKEND,
    finalSeq: expectedFinalSeq,
    gateEmpty: true,
    triggerVersion: TRIGGER_VERSION,
    triggerSetDigest,
    observedTriggerSetDigest,
    expectedTriggerSetDigest,
  });
}

function assertOneChange(result, operation) {
  if (result?.changes !== 1) {
    throw contractError(`${operation} must change exactly one row`, 'SCHEMA_11_INSTALL_CAS_FAILED');
  }
}

function verifyCleanSchema10(database) {
  auditWritableTableManifest(database);
  const rows = readReservedRows(database);
  const reserved = exactReservedMap(rows, 2);
  if (reserved.get('schema_version') !== '10') {
    throw contractError('Schema 11 installation requires exact schema_version 10', 'SCHEMA_11_INSTALL_PREFLIGHT_FAILED');
  }
  const projectInstanceId = reserved.get('project_instance_id');
  if (!UUID_V4_PATTERN.test(projectInstanceId || '')) {
    throw contractError(
      'Schema 11 installation requires one valid project_instance_id UUID v4',
      'SCHEMA_11_INSTALL_PREFLIGHT_FAILED',
    );
  }
  for (const key of Object.keys(NATIVE_META_VALUES).concat('durability_trigger_set_digest')) {
    if (reserved.has(key)) {
      throw contractError(`Native reserved key already exists: ${key}`, 'SCHEMA_11_INSTALL_PREFLIGHT_FAILED');
    }
  }
  return projectInstanceId;
}

function rollbackInstall(database, primaryError) {
  if (!database.inTransaction) return;
  try {
    database.exec('ROLLBACK');
  } catch (rollbackError) {
    try {
      Object.defineProperty(primaryError, 'rollbackError', {
        value: rollbackError,
        configurable: true,
      });
    } catch {
      // Preserve the primary installation failure.
    }
  }
}

function installSchema11Contract(database) {
  let began = false;
  try {
    database.exec('BEGIN EXCLUSIVE');
    began = true;
    const expectedProjectInstanceId = verifyCleanSchema10(database);
    database.exec(
      `CREATE TABLE ${quoteIdentifier(GATE_TABLE)} (`
      + `${quoteIdentifier('gate_id')} INTEGER NOT NULL PRIMARY KEY CHECK (${quoteIdentifier('gate_id')} = 1)) WITHOUT ROWID`,
    );
    assertOneChange(
      database.query(`INSERT INTO ${quoteIdentifier(GATE_TABLE)} (${quoteIdentifier('gate_id')}) VALUES (1)`).run(),
      'Opening the durability write gate',
    );
    for (const definition of canonicalTriggerDefinitions()) database.exec(definition.sql);

    const triggerSetDigest = canonicalTriggerSetDigest();
    const nativeValues = {
      ...NATIVE_META_VALUES,
      durability_trigger_set_digest: triggerSetDigest,
    };
    for (const [key, value] of Object.entries(nativeValues)) {
      assertOneChange(
        database.query('INSERT INTO project_meta (key, value) VALUES (?, ?)').run(key, value),
        `Installing native reserved key ${key}`,
      );
    }
    assertOneChange(
      database.query("UPDATE project_meta SET value = ? WHERE key = 'schema_version' AND value = '10'").run('11'),
      'Schema version 10 to 11 compare-and-swap',
    );
    assertOneChange(
      database.query(`DELETE FROM ${quoteIdentifier(GATE_TABLE)} WHERE ${quoteIdentifier('gate_id')} = 1`).run(),
      'Closing the durability write gate',
    );
    const inspection = inspectSchema11Contract(database);
    if (inspection.projectInstanceId !== expectedProjectInstanceId) {
      throw contractError('project_instance_id changed during schema 11 installation');
    }
    database.exec('COMMIT');
    began = false;
    return inspection;
  } catch (error) {
    if (began || database.inTransaction) rollbackInstall(database, error);
    throw error;
  }
}

// Schema 12 is intentionally a read-only contract in Task 2. It describes the
// one candidate shape that the later migration/new-project journals may build;
// it does not mint UIDs, derive projection values, or install a database.
const SCHEMA12_TRIGGER_SET_FORMAT = 'mythpen-downgrade-trigger-set-v2';
const SCHEMA12_TRIGGER_VERSION = 2;
const SCHEMA12_DELETE_TRIGGER_PREFIX = '_mythpen_manuscript_delete_guard__';
const SCHEMA12_DELETE_ERROR = 'MYTHPEN_MANUSCRIPT_PHYSICAL_DELETE_FORBIDDEN';
const SCHEMA12_WRITABLE_PROJECT_TABLES = Object.freeze([
  ...WRITABLE_PROJECT_TABLES,
  'manuscript_capacity_snapshot',
  'manuscript_controlled_files',
  'manuscript_ignored_resources',
].sort(utf8Compare));
const SCHEMA12_INTERNAL_TABLES = Object.freeze([GATE_TABLE]);
const SCHEMA12_RESERVED_PROJECT_META_KEYS = RESERVED_PROJECT_META_KEYS;
const SCHEMA12_CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function schema12Column(name, type, options = {}) {
  return {
    name,
    type,
    notNull: options.notNull === true,
    defaultSql: options.defaultSql ?? null,
    primaryKey: options.primaryKey === true,
    autoIncrement: options.autoIncrement === true,
    checkSql: options.checkSql ?? null,
    references: options.references ?? null,
  };
}

function schema12CanonicalUuidCheck(name, { nullable = false } = {}) {
  const identifier = quoteIdentifier(name);
  const hex = '[0-9a-f]';
  const glob = `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-[89ab]${hex.repeat(3)}-${hex.repeat(12)}`;
  const exact = `length(${identifier}) = 36 AND lower(${identifier}) = ${identifier} AND ${identifier} GLOB '${glob}'`;
  return nullable ? `${identifier} IS NULL OR (${exact})` : exact;
}

function schema12Sha256Check(name, { nullable = false } = {}) {
  const identifier = quoteIdentifier(name);
  const exact = `length(${identifier}) = 64 AND lower(${identifier}) = ${identifier} AND ${identifier} NOT GLOB '*[^0-9a-f]*'`;
  return nullable ? `${identifier} IS NULL OR (${exact})` : exact;
}

function schema12ColumnSql(column) {
  const parts = [quoteIdentifier(column.name), column.type];
  if (column.primaryKey) parts.push('PRIMARY KEY');
  if (column.autoIncrement) parts.push('AUTOINCREMENT');
  if (column.notNull) parts.push('NOT NULL');
  if (column.defaultSql !== null) parts.push(`DEFAULT ${column.defaultSql}`);
  if (column.checkSql !== null) parts.push(`CHECK (${column.checkSql})`);
  if (column.references !== null) {
    parts.push(
      `REFERENCES ${quoteIdentifier(column.references.table)}`
      + ` (${quoteIdentifier(column.references.column)})`
      + ` ON DELETE ${column.references.onDelete}`,
    );
  }
  return parts.join(' ');
}

function schema12Table(name, strategy, columns, tableConstraints = []) {
  const createSql = [
    `CREATE TABLE ${quoteIdentifier(name)} (`,
    [...columns.map(schema12ColumnSql), ...tableConstraints]
      .map((line) => `  ${line}`)
      .join(',\n'),
    ')',
  ].join('\n');
  return {
    name,
    strategy,
    columns,
    tableConstraints,
    createSql,
  };
}

const SCHEMA12_TABLES = {
  volumes: schema12Table('volumes', 'rebuild', [
    schema12Column('id', 'INTEGER', { primaryKey: true, autoIncrement: true }),
    schema12Column('sort_order', 'INTEGER', { notNull: true }),
    schema12Column('title', 'TEXT', { notNull: true }),
    schema12Column('summary', 'TEXT', { defaultSql: "''" }),
    schema12Column('created_at', 'TEXT', { notNull: true, defaultSql: "(datetime('now'))" }),
    schema12Column('volume_uid', 'TEXT', {
      notNull: true,
      checkSql: schema12CanonicalUuidCheck('volume_uid'),
    }),
    schema12Column('is_present', 'INTEGER', {
      notNull: true,
      defaultSql: '1',
      checkSql: '"is_present" IN (0, 1)',
    }),
    schema12Column('deleted_at', 'TEXT'),
  ]),
  chapters: schema12Table('chapters', 'rebuild', [
    schema12Column('id', 'INTEGER', { primaryKey: true, autoIncrement: true }),
    schema12Column('volume_id', 'INTEGER', {
      references: { table: 'volumes', column: 'id', onDelete: 'RESTRICT' },
    }),
    schema12Column('num', 'INTEGER', { notNull: true }),
    schema12Column('title', 'TEXT', { notNull: true }),
    schema12Column('outline', 'TEXT', { defaultSql: "''" }),
    schema12Column('content', 'TEXT', { defaultSql: "''" }),
    schema12Column('summary', 'TEXT', { defaultSql: "''" }),
    schema12Column('word_count', 'INTEGER', { defaultSql: '0' }),
    schema12Column('status', 'TEXT', {
      notNull: true,
      defaultSql: "'pending'",
      checkSql: '"status" IN (\'pending\', \'writing\', \'review\', \'accepted\')',
    }),
    schema12Column('cognitive_frame', 'TEXT', { defaultSql: "''" }),
    schema12Column('emotional_anchor', 'TEXT', { defaultSql: "''" }),
    schema12Column('world_texture', 'TEXT', { defaultSql: "''" }),
    schema12Column('concrete_mystery', 'TEXT', { defaultSql: "''" }),
    schema12Column('interpersonal_tension', 'TEXT', { defaultSql: "''" }),
    schema12Column('created_at', 'TEXT', { notNull: true, defaultSql: "(datetime('now'))" }),
    schema12Column('updated_at', 'TEXT', { notNull: true, defaultSql: "(datetime('now'))" }),
    schema12Column('data_version', 'INTEGER', { notNull: true, defaultSql: '0' }),
    schema12Column('chapter_uid', 'TEXT', {
      notNull: true,
      checkSql: schema12CanonicalUuidCheck('chapter_uid'),
    }),
    schema12Column('is_present', 'INTEGER', {
      notNull: true,
      defaultSql: '1',
      checkSql: '"is_present" IN (0, 1)',
    }),
    schema12Column('deleted_at', 'TEXT'),
    schema12Column('chapter_position', 'INTEGER', {
      checkSql: '"chapter_position" IS NULL OR "chapter_position" > 0',
    }),
    schema12Column('manuscript_position', 'INTEGER', {
      checkSql: '"manuscript_position" IS NULL OR "manuscript_position" > 0',
    }),
    schema12Column('body_raw_sha256', 'TEXT', {
      checkSql: schema12Sha256Check('body_raw_sha256', { nullable: true }),
    }),
    schema12Column('sidecar_raw_sha256', 'TEXT', {
      checkSql: schema12Sha256Check('sidecar_raw_sha256', { nullable: true }),
    }),
    schema12Column('content_available', 'INTEGER', {
      notNull: true,
      defaultSql: '1',
      checkSql: '"content_available" IN (0, 1)',
    }),
  ]),
  foreshadows: schema12Table('foreshadows', 'rebuild', [
    schema12Column('id', 'TEXT', { primaryKey: true }),
    schema12Column('title', 'TEXT', { notNull: true }),
    schema12Column('description', 'TEXT', { defaultSql: "''" }),
    schema12Column('status', 'TEXT', {
      notNull: true,
      defaultSql: "'planted'",
      checkSql: '"status" IN (\'planted\', \'progressing\', \'resolved\', \'abandoned\')',
    }),
    schema12Column('planted_chapter_id', 'INTEGER', {
      references: { table: 'chapters', column: 'id', onDelete: 'SET NULL' },
    }),
    schema12Column('expected_resolve_manuscript_position', 'INTEGER', {
      checkSql: '"expected_resolve_manuscript_position" IS NULL OR "expected_resolve_manuscript_position" > 0',
    }),
    schema12Column('resolved_chapter_id', 'INTEGER', {
      references: { table: 'chapters', column: 'id', onDelete: 'SET NULL' },
    }),
    schema12Column('priority', 'TEXT', {
      defaultSql: "'normal'",
      checkSql: '"priority" IN (\'low\', \'normal\', \'high\')',
    }),
    schema12Column('created_at', 'TEXT', { notNull: true, defaultSql: "(datetime('now'))" }),
    schema12Column('updated_at', 'TEXT', { notNull: true, defaultSql: "(datetime('now'))" }),
  ]),
  manuscript_ignored_resources: schema12Table('manuscript_ignored_resources', 'create', [
    schema12Column('resource_kind', 'TEXT', {
      notNull: true,
      checkSql: '"resource_kind" IN (\'chapter\', \'volume\')',
    }),
    schema12Column('resource_uid', 'TEXT', {
      notNull: true,
      checkSql: schema12CanonicalUuidCheck('resource_uid'),
    }),
    schema12Column('ignore_status', 'TEXT', {
      notNull: true,
      checkSql: '"ignore_status" IN (\'active\', \'revoked\')',
    }),
    schema12Column('opaque_container_kind', 'TEXT', {
      checkSql: '"opaque_container_kind" IS NULL OR "opaque_container_kind" IN (\'manuscript\', \'unassigned\', \'volume\')',
    }),
    schema12Column('opaque_container_uid', 'TEXT', {
      checkSql: schema12CanonicalUuidCheck('opaque_container_uid', { nullable: true }),
    }),
    schema12Column('is_currently_referenced', 'INTEGER', {
      notNull: true,
      checkSql: '"is_currently_referenced" IN (0, 1)',
    }),
    schema12Column('member_snapshot_json', 'TEXT', {
      notNull: true,
      checkSql: 'json_valid("member_snapshot_json") = 1',
    }),
    schema12Column('projection_generation', 'INTEGER', {
      notNull: true,
      checkSql: '"projection_generation" >= 0',
    }),
  ], [
    'PRIMARY KEY ("resource_kind", "resource_uid")',
    'CHECK (("is_currently_referenced" = 0 AND "opaque_container_kind" IS NULL AND "opaque_container_uid" IS NULL) OR ("is_currently_referenced" = 1 AND "opaque_container_kind" IS NOT NULL AND (("resource_kind" = \'volume\' AND "opaque_container_kind" = \'manuscript\' AND "opaque_container_uid" IS NULL) OR ("resource_kind" = \'chapter\' AND (("opaque_container_kind" = \'unassigned\' AND "opaque_container_uid" IS NULL) OR ("opaque_container_kind" = \'volume\' AND "opaque_container_uid" IS NOT NULL))))))',
  ]),
  manuscript_controlled_files: schema12Table('manuscript_controlled_files', 'create', [
    schema12Column('file_role', 'TEXT', {
      notNull: true,
      checkSql: '"file_role" IN (\'manuscript\', \'unassigned\', \'volume_index\', \'chapter_body\', \'chapter_sidecar\')',
    }),
    schema12Column('resource_uid', 'TEXT', {
      checkSql: schema12CanonicalUuidCheck('resource_uid', { nullable: true }),
    }),
    schema12Column('raw_sha256', 'TEXT', {
      notNull: true,
      checkSql: schema12Sha256Check('raw_sha256'),
    }),
    schema12Column('byte_size', 'INTEGER', {
      notNull: true,
      checkSql: '"byte_size" >= 0',
    }),
    schema12Column('file_identity_json', 'TEXT', {
      notNull: true,
      checkSql: 'json_valid("file_identity_json") = 1',
    }),
    schema12Column('projection_generation', 'INTEGER', {
      notNull: true,
      checkSql: '"projection_generation" >= 0',
    }),
  ], [
    'CHECK ((("file_role" IN (\'manuscript\', \'unassigned\')) AND "resource_uid" IS NULL) OR (("file_role" IN (\'volume_index\', \'chapter_body\', \'chapter_sidecar\')) AND "resource_uid" IS NOT NULL))',
  ]),
  manuscript_capacity_snapshot: schema12Table('manuscript_capacity_snapshot', 'create', [
    schema12Column('singleton_id', 'INTEGER', {
      primaryKey: true,
      checkSql: '"singleton_id" = 1',
    }),
    schema12Column('chapter_identities', 'INTEGER', { notNull: true, checkSql: '"chapter_identities" >= 0' }),
    schema12Column('volume_identities', 'INTEGER', { notNull: true, checkSql: '"volume_identities" >= 0' }),
    schema12Column('controlled_files', 'INTEGER', { notNull: true, checkSql: '"controlled_files" >= 0' }),
    schema12Column('chapter_directory_entries', 'INTEGER', { notNull: true, checkSql: '"chapter_directory_entries" >= 0' }),
    schema12Column('controlled_bytes', 'INTEGER', { notNull: true, checkSql: '"controlled_bytes" >= 0' }),
    schema12Column('projection_generation', 'INTEGER', { notNull: true, checkSql: '"projection_generation" >= 0' }),
  ]),
};

function schema12Index(name, table, terms, where = null) {
  const sql = `CREATE UNIQUE INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table)}`
    + ` (${terms.join(', ')})${where === null ? '' : ` WHERE ${where}`}`;
  return { name, table, unique: true, terms, where, sql };
}

const SCHEMA12_INDEXES = [
  schema12Index(
    'idx_chapters_active_assigned_num',
    'chapters',
    [quoteIdentifier('volume_id'), quoteIdentifier('num')],
    '"is_present" = 1 AND "volume_id" IS NOT NULL',
  ),
  schema12Index(
    'idx_chapters_active_unassigned_num',
    'chapters',
    [quoteIdentifier('num')],
    '"is_present" = 1 AND "volume_id" IS NULL',
  ),
  schema12Index('idx_chapters_chapter_uid', 'chapters', [quoteIdentifier('chapter_uid')]),
  schema12Index(
    'idx_manuscript_controlled_files_identity',
    'manuscript_controlled_files',
    [quoteIdentifier('file_role'), `COALESCE(${quoteIdentifier('resource_uid')}, '')`],
  ),
  schema12Index('idx_volumes_volume_uid', 'volumes', [quoteIdentifier('volume_uid')]),
].sort((left, right) => utf8Compare(left.name, right.name));

function schema12PhysicalDeleteBarrier(table) {
  const name = `${SCHEMA12_DELETE_TRIGGER_PREFIX}${table}`;
  const sql = [
    `CREATE TRIGGER ${quoteIdentifier(name)}`,
    `BEFORE DELETE ON ${quoteIdentifier(table)}`,
    'FOR EACH ROW',
    'BEGIN',
    `  SELECT RAISE(ABORT, '${SCHEMA12_DELETE_ERROR}');`,
    'END',
  ].join('\n');
  return { name, table, operation: 'DELETE', sql };
}

const SCHEMA12_PHYSICAL_DELETE_BARRIERS = [
  schema12PhysicalDeleteBarrier('chapters'),
  schema12PhysicalDeleteBarrier('manuscript_ignored_resources'),
  schema12PhysicalDeleteBarrier('volumes'),
].sort((left, right) => utf8Compare(left.name, right.name));

const SCHEMA12_GATE_TABLE_OBJECT = {
  type: 'table',
  name: GATE_TABLE,
  table: GATE_TABLE,
  sql: 'CREATE TABLE "_durability_write_gate" ("gate_id" INTEGER NOT NULL PRIMARY KEY CHECK ("gate_id" = 1)) WITHOUT ROWID',
};

const SCHEMA12_SCHEMA_OBJECTS = [
  SCHEMA12_GATE_TABLE_OBJECT,
  ...Object.values(SCHEMA12_TABLES).map((table) => ({
    type: 'table',
    name: table.name,
    table: table.name,
    sql: table.createSql,
  })),
  ...SCHEMA12_INDEXES.map((index) => ({
    type: 'index',
    name: index.name,
    table: index.table,
    sql: index.sql,
  })),
].sort((left, right) => utf8Compare(left.name, right.name));

const SCHEMA12_CONTRACT = deepFreeze({
  schemaVersion: 12,
  triggerVersion: SCHEMA12_TRIGGER_VERSION,
  triggerSetFormat: SCHEMA12_TRIGGER_SET_FORMAT,
  writableTables: SCHEMA12_WRITABLE_PROJECT_TABLES,
  internalTables: SCHEMA12_INTERNAL_TABLES,
  reservedProjectMetaKeys: SCHEMA12_RESERVED_PROJECT_META_KEYS,
  tables: SCHEMA12_TABLES,
  foreignKeys: [{
    table: 'chapters',
    from: 'volume_id',
    toTable: 'volumes',
    to: 'id',
    onDelete: 'RESTRICT',
  }],
  indexes: SCHEMA12_INDEXES,
  physicalDeleteBarriers: SCHEMA12_PHYSICAL_DELETE_BARRIERS,
  schemaObjects: SCHEMA12_SCHEMA_OBJECTS,
  preservation: {
    integerPrimaryKeys: true,
    businessRows: true,
    sqliteSequence: true,
    views: true,
    nonConflictingIndexes: true,
    nonConflictingTriggers: true,
    createTableAsSelect: false,
  },
});

const SCHEMA12_CANONICAL_TRIGGER_DEFINITIONS = Object.freeze([
  ...SCHEMA12_WRITABLE_PROJECT_TABLES.flatMap((table) => (
    ['DELETE', 'INSERT', 'UPDATE'].map((operation) => {
      const name = triggerName(table, operation);
      return Object.freeze({ name, table, operation, sql: triggerSql(name, table, operation) });
    })
  )),
  ...SCHEMA12_PHYSICAL_DELETE_BARRIERS,
].sort((left, right) => utf8Compare(left.name, right.name)).map(Object.freeze));

function schema12CanonicalTriggerDefinitions() {
  return SCHEMA12_CANONICAL_TRIGGER_DEFINITIONS;
}

function schema12CanonicalTriggerSetDigest(
  definitions = SCHEMA12_CANONICAL_TRIGGER_DEFINITIONS,
) {
  if (!Array.isArray(definitions)) throw malformedSql('schema 12 trigger definitions must be an array');
  if (definitions.length !== SCHEMA12_CANONICAL_TRIGGER_DEFINITIONS.length) {
    throw malformedSql(
      `schema 12 trigger definition count mismatch; expected ${SCHEMA12_CANONICAL_TRIGGER_DEFINITIONS.length}, found ${definitions.length}`,
    );
  }
  const expectedByName = new Map(
    SCHEMA12_CANONICAL_TRIGGER_DEFINITIONS.map((definition) => [definition.name, definition]),
  );
  const names = new Set();
  const material = definitions.map((definition) => {
    if (!definition || typeof definition !== 'object') {
      throw malformedSql('schema 12 trigger definition must be an object');
    }
    for (const key of ['name', 'table', 'operation', 'sql']) {
      if (typeof definition[key] !== 'string' || definition[key].length === 0) {
        throw malformedSql(`schema 12 trigger definition.${key} must be a non-empty string`);
      }
    }
    if (names.has(definition.name)) {
      throw malformedSql(`duplicate schema 12 trigger name ${definition.name}`);
    }
    names.add(definition.name);
    const expected = expectedByName.get(definition.name);
    if (
      !expected
      || definition.table !== expected.table
      || definition.operation !== expected.operation
    ) {
      throw malformedSql(`schema 12 trigger identity differs for ${definition.name}`);
    }
    const actualTokens = tokenizeTriggerSql(definition.sql);
    const expectedTokens = tokenizeTriggerSql(expected.sql);
    if (JSON.stringify(actualTokens) !== JSON.stringify(expectedTokens)) {
      throw malformedSql(`schema 12 trigger semantic structure differs for ${definition.name}`);
    }
    return {
      name: definition.name,
      table: definition.table,
      operation: definition.operation,
      sql: actualTokens.join(' '),
    };
  }).sort((left, right) => utf8Compare(left.name, right.name));
  if (names.size !== expectedByName.size || [...expectedByName.keys()].some((name) => !names.has(name))) {
    throw malformedSql('schema 12 trigger definition set has missing identities');
  }
  return createHash('sha256').update(JSON.stringify({
    format: SCHEMA12_TRIGGER_SET_FORMAT,
    triggers: material,
  })).digest('hex');
}

function auditSchema12WritableTableManifest(database) {
  const actualTables = queryRows(
    database,
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_'",
  ).map(({ name }) => name).sort(utf8Compare);
  const allowed = new Set([
    ...SCHEMA12_WRITABLE_PROJECT_TABLES,
    ...SCHEMA12_INTERNAL_TABLES,
  ]);
  const unknown = actualTables.filter((name) => !allowed.has(name));
  const missingWritable = SCHEMA12_WRITABLE_PROJECT_TABLES
    .filter((name) => !actualTables.includes(name));
  const missingInternal = SCHEMA12_INTERNAL_TABLES
    .filter((name) => !actualTables.includes(name));
  if (unknown.length > 0 || missingWritable.length > 0 || missingInternal.length > 0) {
    throw contractError(
      `Schema 12 writable table manifest mismatch; unknown=[${unknown.join(',')}], missing=[${[
        ...missingWritable,
        ...missingInternal,
      ].join(',')}]`,
      'SCHEMA_12_TABLE_MANIFEST_MISMATCH',
    );
  }
  return Object.freeze({
    writableTables: SCHEMA12_WRITABLE_PROJECT_TABLES,
    internalTables: SCHEMA12_INTERNAL_TABLES,
  });
}

function schema12ReservedRows(database) {
  return queryRows(
    database,
    "SELECT key, value, typeof(value) AS storageType FROM project_meta WHERE key IN ('schema_version', 'project_instance_id', 'durability_backend', 'durability_commit_seq', 'durability_trigger_version', 'durability_trigger_set_digest', 'manuscript_route', 'manuscript_project_uid', 'manuscript_route_journal', 'manuscript_projection_generation') ORDER BY key",
  );
}

function canonicalNonNegativeInteger(raw, label) {
  if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw contractError(`${label} must be canonical non-negative decimal TEXT`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw contractError(`${label} exceeds the safe integer contract`);
  }
  return value;
}

function inspectSchema12Contract(database, options) {
  if (
    options === null
    || typeof options !== 'object'
    || !Object.prototype.hasOwnProperty.call(options, 'expectedFinalSeq')
  ) {
    throw contractError('Schema 12 inspection requires an external expected durability sequence');
  }
  const { expectedFinalSeq } = options;
  if (
    !Number.isSafeInteger(expectedFinalSeq)
    || expectedFinalSeq < 0
    || Object.is(expectedFinalSeq, -0)
  ) {
    throw contractError('Expected durability commit sequence must be a non-negative safe integer');
  }
  const manifest = auditSchema12WritableTableManifest(database);
  const rows = schema12ReservedRows(database);
  if (
    rows.length !== 10
    || new Set(rows.map(({ key }) => key)).size !== 10
    || rows.some(({ storageType }) => storageType !== 'text')
  ) {
    throw contractError('Schema 12 reserved project_meta rows are not ten unique TEXT values');
  }
  const reserved = new Map(rows.map(({ key, value }) => [key, value]));
  const exactKeys = [
    'schema_version',
    'project_instance_id',
    'durability_backend',
    'durability_commit_seq',
    'durability_trigger_version',
    'durability_trigger_set_digest',
    ...SCHEMA12_RESERVED_PROJECT_META_KEYS,
  ];
  if (exactKeys.some((key) => !reserved.has(key))) {
    throw contractError('Schema 12 reserved project_meta key set is incomplete');
  }
  if (reserved.get('schema_version') !== '12') throw contractError('schema_version must be exactly 12');
  const projectInstanceId = reserved.get('project_instance_id');
  if (!UUID_V4_PATTERN.test(projectInstanceId || '')) {
    throw contractError('project_instance_id must be one valid UUID v4 value');
  }
  if (reserved.get('durability_backend') !== NATIVE_BACKEND) {
    throw contractError(`durability_backend must be ${NATIVE_BACKEND}`);
  }
  const finalSeq = canonicalNonNegativeInteger(
    reserved.get('durability_commit_seq'),
    'durability_commit_seq',
  );
  if (finalSeq !== expectedFinalSeq) {
    throw contractError(`durability_commit_seq must be exactly ${expectedFinalSeq}`);
  }
  if (reserved.get('durability_trigger_version') !== String(SCHEMA12_TRIGGER_VERSION)) {
    throw contractError(`durability_trigger_version must be exactly ${SCHEMA12_TRIGGER_VERSION}`);
  }
  const route = reserved.get('manuscript_route');
  if (!['sqlite', 'migrating', 'files', 'retired'].includes(route)) {
    throw contractError('manuscript_route is not one stable route');
  }
  const manuscriptProjectUid = reserved.get('manuscript_project_uid');
  if (route !== 'sqlite' && !SCHEMA12_CANONICAL_UUID_V4_PATTERN.test(manuscriptProjectUid || '')) {
    throw contractError('manuscript_project_uid must be one valid UUID v4 outside sqlite route');
  }
  if (typeof reserved.get('manuscript_route_journal') !== 'string') {
    throw contractError('manuscript_route_journal must be TEXT');
  }
  const projectionGeneration = canonicalNonNegativeInteger(
    reserved.get('manuscript_projection_generation'),
    'manuscript_projection_generation',
  );

  const gateRows = database.query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(GATE_TABLE)}`).get();
  if (gateRows?.count !== 0) throw contractError('Durability write gate must be empty');

  const observedObjects = queryRows(
    database,
    `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE type IN ('table', 'index') AND name IN (${SCHEMA12_SCHEMA_OBJECTS.map(() => '?').join(', ')}) ORDER BY name`,
    ...SCHEMA12_SCHEMA_OBJECTS.map(({ name }) => name),
  );
  const observedByName = new Map(observedObjects.map((object) => [object.name, object]));
  if (
    observedObjects.length !== SCHEMA12_SCHEMA_OBJECTS.length
    || observedByName.size !== observedObjects.length
  ) {
    throw contractError('Schema 12 described object set is not exact');
  }
  for (const expected of SCHEMA12_SCHEMA_OBJECTS) {
    const observed = observedByName.get(expected.name);
    if (
      !observed
      || observed.type !== expected.type
      || observed.tableName !== expected.table
      || observed.sql !== expected.sql
    ) {
      throw contractError(`Schema 12 object differs: ${expected.name}`);
    }
  }

  const observedTriggerRows = queryRows(
    database,
    "SELECT name, tbl_name AS tableName, sql FROM sqlite_schema WHERE type = 'trigger' AND (substr(name, 1, ?) = ? OR substr(name, 1, ?) = ?) ORDER BY name",
    TRIGGER_PREFIX.length,
    TRIGGER_PREFIX,
    SCHEMA12_DELETE_TRIGGER_PREFIX.length,
    SCHEMA12_DELETE_TRIGGER_PREFIX,
  );
  const expectedTriggersByName = new Map(
    SCHEMA12_CANONICAL_TRIGGER_DEFINITIONS.map((definition) => [definition.name, definition]),
  );
  const observedDefinitions = observedTriggerRows.map((row) => ({
    name: row.name,
    table: row.tableName,
    operation: expectedTriggersByName.get(row.name)?.operation || 'UNKNOWN',
    sql: row.sql,
  }));
  let observedTriggerSetDigest;
  try {
    observedTriggerSetDigest = schema12CanonicalTriggerSetDigest(observedDefinitions);
  } catch (cause) {
    throw contractError('Schema 12 observed trigger set is not canonical', 'RECOVERY_REQUIRED', cause);
  }
  const expectedTriggerSetDigest = schema12CanonicalTriggerSetDigest();
  const triggerSetDigest = reserved.get('durability_trigger_set_digest');
  if (
    triggerSetDigest !== expectedTriggerSetDigest
    || observedTriggerSetDigest !== expectedTriggerSetDigest
  ) {
    throw contractError('Schema 12 canonical trigger digest three-way comparison failed');
  }
  return Object.freeze({
    schemaVersion: 12,
    projectInstanceId,
    projectInstanceIdSha256: createHash('sha256').update(projectInstanceId).digest('hex'),
    backend: NATIVE_BACKEND,
    finalSeq,
    gateEmpty: true,
    triggerVersion: SCHEMA12_TRIGGER_VERSION,
    triggerSetDigest,
    observedTriggerSetDigest,
    expectedTriggerSetDigest,
    route,
    manuscriptProjectUid,
    routeJournal: reserved.get('manuscript_route_journal'),
    projectionGeneration,
    writableTables: manifest.writableTables,
    internalTables: manifest.internalTables,
  });
}

module.exports = {
  WRITABLE_PROJECT_TABLES,
  canonicalTriggerDefinitions,
  canonicalTriggerSetDigest,
  installSchema11Contract,
  inspectSchema11Contract,
  auditWritableTableManifest,
  SCHEMA12_CONTRACT,
  schema12CanonicalTriggerDefinitions,
  schema12CanonicalTriggerSetDigest,
  inspectSchema12Contract,
};
