const { WRITABLE_PROJECT_TABLES } = require('./durability-schema');

const BUSINESS_TABLES = new Set(WRITABLE_PROJECT_TABLES);

const RESERVED_META_KEYS = new Set([
  'schema_version',
  'project_instance_id',
  'durability_backend',
  'durability_commit_seq',
  'durability_trigger_version',
  'durability_trigger_set_digest',
]);
const FROM_LIST_TERMINATORS = new Set([
  'where',
  'group',
  'having',
  'order',
  'limit',
  'union',
  'intersect',
  'except',
  'returning',
  'window',
]);
const SUBQUERY_STARTERS = new Set(['select', 'values', 'with']);

function forbidden(message) {
  const error = new Error(message);
  error.code = 'NATIVE_SQL_FORBIDDEN';
  return error;
}

function tokenize(sql) {
  if (typeof sql !== 'string' || sql.includes('\0')) throw forbidden('SQL must be a NUL-free string');
  const tokens = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw forbidden('SQL contains an unterminated comment');
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      let value = '';
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (char !== '[' && sql[index + 1] === closing) {
            value += closing;
            index += 2;
            continue;
          }
          closed = true;
          index += 1;
          break;
        }
        value += sql[index];
        index += 1;
      }
      if (!closed) throw forbidden('SQL contains an unterminated quoted token');
      tokens.push({ type: char === "'" ? 'string' : 'word', value, quote: char });
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(char)) {
      const start = index;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1;
      tokens.push({ type: 'word', value: sql.slice(start, index) });
      continue;
    }
    tokens.push({ type: 'symbol', value: char });
    index += 1;
  }
  return tokens;
}

function normalizedWord(token) {
  return token?.type === 'word' ? token.value.toLowerCase() : null;
}

function normalizedKeyword(token) {
  return token?.quote === undefined ? normalizedWord(token) : null;
}

function isIdentifierToken(token) {
  return token?.type === 'word' || token?.type === 'string';
}

function addTableReference(tokens, startIndex, indexes) {
  if (!isIdentifierToken(tokens[startIndex])) return;
  indexes.add(startIndex);
  if (
    tokens[startIndex + 1]?.type === 'symbol'
    && tokens[startIndex + 1].value === '.'
    && isIdentifierToken(tokens[startIndex + 2])
  ) {
    indexes.add(startIndex + 2);
  }
}

function scanTableSource(tokens, startIndex, endIndex, indexes) {
  if (startIndex >= endIndex) return;
  if (tokens[startIndex]?.type === 'symbol' && tokens[startIndex].value === '(') {
    const closeIndex = matchingParenthesis(tokens, startIndex);
    if (!SUBQUERY_STARTERS.has(normalizedKeyword(tokens[startIndex + 1]))) {
      scanFromTableList(tokens, startIndex + 1, closeIndex, indexes);
    }
    return;
  }
  addTableReference(tokens, startIndex, indexes);
}

function scanFromTableList(tokens, startIndex, endIndex, indexes) {
  scanTableSource(tokens, startIndex, endIndex, indexes);
  for (let index = startIndex; index < endIndex; index += 1) {
    if (tokens[index].type === 'symbol' && tokens[index].value === '(') {
      index = matchingParenthesis(tokens, index);
      continue;
    }
    if (tokens[index].type === 'symbol' && tokens[index].value === ')') return;
    const keyword = normalizedKeyword(tokens[index]);
    if (FROM_LIST_TERMINATORS.has(keyword)) return;
    if (keyword === 'join') scanTableSource(tokens, index + 1, endIndex, indexes);
    if (tokens[index].type === 'symbol' && tokens[index].value === ',') {
      scanTableSource(tokens, index + 1, endIndex, indexes);
    }
  }
}

function tableReferenceTokenIndexes(tokens) {
  const indexes = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = normalizedKeyword(tokens[index]);
    if (!['from', 'join', 'into', 'update'].includes(keyword)) continue;
    let identifierIndex = index + 1;
    if (keyword === 'update' && normalizedKeyword(tokens[identifierIndex]) === 'or') {
      identifierIndex += 2;
    }
    if (keyword === 'from') scanFromTableList(tokens, identifierIndex, tokens.length, indexes);
    else scanTableSource(tokens, identifierIndex, tokens.length, indexes);
  }
  return indexes;
}

function assertSingleStatement(tokens) {
  const semicolons = tokens.reduce((indexes, token, index) => {
    if (token.type === 'symbol' && token.value === ';') indexes.push(index);
    return indexes;
  }, []);
  if (semicolons.length > 1 || (semicolons.length === 1 && semicolons[0] !== tokens.length - 1)) {
    throw forbidden('Multiple SQL statements are forbidden');
  }
  if (semicolons.length === 1) tokens.pop();
  if (tokens.length === 0) throw forbidden('Empty SQL is forbidden');
}

function assertNoInternalReference(tokens) {
  for (const index of tableReferenceTokenIndexes(tokens)) {
    if (tokens[index].type === 'string') {
      throw forbidden('Single-quoted table identifiers are forbidden');
    }
  }
  for (const token of tokens) {
    const word = normalizedWord(token);
    if (
      word === '_durability_write_gate'
      || word === 'sqlite_schema'
      || word === 'sqlite_master'
      || word?.startsWith('_mythpen_downgrade_guard__')
    ) {
      throw forbidden('Durability internals are not available to business SQL');
    }
  }
}

function dmlTable(tokens, operation) {
  let index = 1;
  if (operation === 'INSERT') {
    if (normalizedWord(tokens[index]) === 'or') index += 2;
    if (normalizedWord(tokens[index]) !== 'into') throw forbidden('Unknown INSERT shape');
    index += 1;
  } else if (operation === 'UPDATE') {
    if (normalizedWord(tokens[index]) === 'or') index += 2;
  } else if (operation === 'DELETE') {
    if (normalizedWord(tokens[index]) !== 'from') throw forbidden('Unknown DELETE shape');
    index += 1;
  }
  const table = normalizedWord(tokens[index]);
  if (!BUSINESS_TABLES.has(table)) throw forbidden('DML target is not a business table');
  return table;
}

function isSymbol(token, value) {
  return token?.type === 'symbol' && token.value === value;
}

function matchingParenthesis(tokens, start) {
  if (!isSymbol(tokens[start], '(')) throw forbidden('Expected a parenthesized SQL list');
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (isSymbol(tokens[index], '(')) depth += 1;
    if (isSymbol(tokens[index], ')')) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw forbidden('SQL contains an unterminated parenthesized list');
}

function splitTopLevel(tokens, start, end) {
  const segments = [];
  let segmentStart = start;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (isSymbol(tokens[index], '(')) depth += 1;
    if (isSymbol(tokens[index], ')')) depth -= 1;
    if (depth === 0 && isSymbol(tokens[index], ',')) {
      segments.push(tokens.slice(segmentStart, index));
      segmentStart = index + 1;
    }
  }
  segments.push(tokens.slice(segmentStart, end));
  return segments;
}

function safeLiteralKey(segment) {
  return segment.length === 1
    && segment[0].type === 'string'
    && !RESERVED_META_KEYS.has(segment[0].value.toLowerCase());
}

function assertStaticProjectMetaInsert(tokens) {
  const tableIndex = tokens.findIndex((token) => normalizedWord(token) === 'project_meta');
  const columnsStart = tableIndex + 1;
  const columnsEnd = matchingParenthesis(tokens, columnsStart);
  const columns = splitTopLevel(tokens, columnsStart + 1, columnsEnd);
  if (columns.some((column) => column.length !== 1 || normalizedWord(column[0]) === null)) {
    throw forbidden('project_meta INSERT columns are ambiguous');
  }
  const keyIndex = columns.findIndex((column) => normalizedWord(column[0]) === 'key');
  if (keyIndex < 0 || normalizedWord(tokens[columnsEnd + 1]) !== 'values') {
    throw forbidden('project_meta INSERT must provide a statically verified key');
  }
  let index = columnsEnd + 2;
  let rows = 0;
  while (index < tokens.length) {
    const valuesEnd = matchingParenthesis(tokens, index);
    const values = splitTopLevel(tokens, index + 1, valuesEnd);
    if (values.length !== columns.length || !safeLiteralKey(values[keyIndex])) {
      throw forbidden('Every project_meta INSERT key must be a non-reserved string literal');
    }
    rows += 1;
    index = valuesEnd + 1;
    if (index === tokens.length) break;
    if (!isSymbol(tokens[index], ',')) throw forbidden('Unknown project_meta INSERT shape');
    index += 1;
  }
  if (rows === 0) throw forbidden('project_meta INSERT has no statically verified row');
}

function assertStaticProjectMetaUpdate(tokens) {
  const setIndex = tokens.findIndex((token) => normalizedWord(token) === 'set');
  const whereIndex = tokens.findIndex((token, index) => (
    index > setIndex && normalizedWord(token) === 'where'
  ));
  if (setIndex < 0 || whereIndex < 0) throw forbidden('project_meta UPDATE requires an exact key predicate');
  const assignments = splitTopLevel(tokens, setIndex + 1, whereIndex);
  if (assignments.some((assignment) => normalizedWord(assignment[0]) === 'key')) {
    throw forbidden('Business SQL cannot update project_meta keys');
  }
  const predicate = tokens.slice(whereIndex + 1);
  if (
    normalizedWord(predicate[0]) !== 'key'
    || !isSymbol(predicate[1], '=')
    || !safeLiteralKey(predicate.slice(2))
  ) {
    throw forbidden('project_meta UPDATE key must be one non-reserved string literal');
  }
}

function assertStaticProjectMetaDelete(tokens) {
  const whereIndex = tokens.findIndex((token) => normalizedWord(token) === 'where');
  const predicate = whereIndex < 0 ? [] : tokens.slice(whereIndex + 1);
  if (
    normalizedWord(predicate[0]) !== 'key'
    || !isSymbol(predicate[1], '=')
    || !safeLiteralKey(predicate.slice(2))
  ) {
    throw forbidden('project_meta DELETE key must be one non-reserved string literal');
  }
}

function assertStaticProjectMetaKey(tokens, operation) {
  if (operation === 'INSERT') return assertStaticProjectMetaInsert(tokens);
  if (operation === 'UPDATE') return assertStaticProjectMetaUpdate(tokens);
  return assertStaticProjectMetaDelete(tokens);
}

function classifyNativeSql(sql) {
  const tokens = tokenize(sql);
  assertSingleStatement(tokens);
  assertNoInternalReference(tokens);
  const operation = normalizedWord(tokens[0])?.toUpperCase();
  if (operation === 'SELECT') {
    return Object.freeze({ kind: 'business_read', operation });
  }
  if (operation === 'INSERT' || operation === 'UPDATE' || operation === 'DELETE') {
    const table = dmlTable(tokens, operation);
    if (
      table === 'project_meta'
      && tokens.some((token) => token.type === 'string' && RESERVED_META_KEYS.has(token.value.toLowerCase()))
    ) {
      throw forbidden('Reserved project metadata cannot be mutated by business SQL');
    }
    if (table === 'project_meta') assertStaticProjectMetaKey(tokens, operation);
    return Object.freeze({ kind: 'business_dml', operation });
  }
  throw forbidden('Unknown or privileged SQL shape');
}

function assertStaticProjectMetaRead(tokens) {
  const projectMetaIndexes = tokens
    .map((token, index) => (normalizedWord(token) === 'project_meta' ? index : -1))
    .filter((index) => index >= 0);
  if (projectMetaIndexes.length === 0) return;
  const fromIndexes = tokens
    .map((token, index) => (normalizedWord(token) === 'from' ? index : -1))
    .filter((index) => index >= 0);
  const whereIndexes = tokens
    .map((token, index) => (normalizedWord(token) === 'where' ? index : -1))
    .filter((index) => index >= 0);
  if (
    projectMetaIndexes.length !== 1
    || fromIndexes.length !== 1
    || whereIndexes.length !== 1
    || projectMetaIndexes[0] !== fromIndexes[0] + 1
    || whereIndexes[0] !== projectMetaIndexes[0] + 1
    || tokens.some((token) => ['join', 'union', 'intersect', 'except'].includes(normalizedWord(token)))
  ) {
    throw forbidden('Transaction project_meta reads require one unaliased exact table predicate');
  }
  const predicate = tokens.slice(whereIndexes[0] + 1);
  if (
    normalizedWord(predicate[0]) !== 'key'
    || !isSymbol(predicate[1], '=')
    || !safeLiteralKey(predicate.slice(2))
  ) {
    throw forbidden('Transaction project_meta reads require one non-reserved literal key');
  }
}

function classifyNativeTransactionSql(sql) {
  const tokens = tokenize(sql);
  assertSingleStatement(tokens);
  assertNoInternalReference(tokens);
  const operation = normalizedWord(tokens[0])?.toUpperCase();
  if (operation === 'SELECT') {
    assertStaticProjectMetaRead(tokens);
    return Object.freeze({ kind: 'business_read', operation });
  }
  if (operation === 'INSERT' || operation === 'UPDATE' || operation === 'DELETE') {
    const classification = classifyNativeSql(sql);
    const table = dmlTable(tokens, operation);
    const projectMetaReferences = tokens.filter(
      (token) => normalizedWord(token) === 'project_meta',
    ).length;
    if (
      (table === 'project_meta' && projectMetaReferences !== 1)
      || (table !== 'project_meta' && projectMetaReferences !== 0)
    ) {
      throw forbidden('Transaction DML cannot read project_meta');
    }
    return classification;
  }
  throw forbidden('Unknown or privileged transaction SQL shape');
}

module.exports = { classifyNativeSql, classifyNativeTransactionSql };
