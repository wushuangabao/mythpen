const { createHash } = require('node:crypto');

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

module.exports = {
  WRITABLE_PROJECT_TABLES,
  canonicalTriggerDefinitions,
  canonicalTriggerSetDigest,
  installSchema11Contract,
  inspectSchema11Contract,
  auditWritableTableManifest,
};
