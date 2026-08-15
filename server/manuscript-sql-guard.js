'use strict';

const QUOTED_IDENTIFIER_OPEN = '\u0001';
const QUOTED_IDENTIFIER_CLOSE = '\u0002';

function sqlIdentifierName(value) {
  const normalized = value.trim();
  if (/^[a-z_$][\w$]*$/.test(normalized)) return normalized;
  if (
    normalized.startsWith(QUOTED_IDENTIFIER_OPEN)
    && normalized.endsWith(QUOTED_IDENTIFIER_CLOSE)
  ) {
    const identifier = normalized.slice(1, -1);
    if (/^[a-z_$][\w$]*$/.test(identifier)) return identifier;
  }
  return null;
}

function lexSqlForManuscriptGuard(sql) {
  if (typeof sql !== 'string') return '';
  let output = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && !/[\r\n]/.test(sql[index])) index += 1;
      output += ' ';
      continue;
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      output += ' ';
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += ' ';
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      let identifier = '';
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (closing !== ']' && sql[index + 1] === closing) {
            identifier += closing;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        identifier += sql[index];
        index += 1;
      }
      output += /^[A-Za-z_$][\w$]*$/.test(identifier)
        ? ` ${QUOTED_IDENTIFIER_OPEN}${identifier.toLowerCase()}${QUOTED_IDENTIFIER_CLOSE} `
        : ' ';
      continue;
    }
    if (char === QUOTED_IDENTIFIER_OPEN || char === QUOTED_IDENTIFIER_CLOSE) {
      output += ' ';
      index += 1;
      continue;
    }
    output += char.toLowerCase();
    index += 1;
  }
  return output;
}

function splitTopLevelSqlList(value) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth -= 1;
    else if (value[index] === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function parenthesizedSqlRangeAt(value, openIndex) {
  if (value[openIndex] !== '(') return null;
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return { body: value.slice(openIndex + 1, index), closeIndex: index };
      }
    }
  }
  return null;
}

function skipSqlWhitespace(value, start, end = value.length) {
  let cursor = start;
  while (cursor < end && /\s/.test(value[cursor])) cursor += 1;
  return cursor;
}

function sqlWordAt(value, start, end = value.length) {
  const cursor = skipSqlWhitespace(value, start, end);
  if (value[cursor] === QUOTED_IDENTIFIER_OPEN) {
    const closeIndex = value.indexOf(QUOTED_IDENTIFIER_CLOSE, cursor + 1);
    if (closeIndex === -1 || closeIndex >= end) return null;
    const word = value.slice(cursor, closeIndex + 1);
    if (sqlIdentifierName(word) === null) return null;
    return { endIndex: closeIndex + 1, startIndex: cursor, word };
  }
  const match = /^[a-z_$][\w$]*/.exec(value.slice(cursor, end));
  if (!match) return null;
  return { endIndex: cursor + match[0].length, startIndex: cursor, word: match[0] };
}

function topLevelStatementEnd(value, start) {
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') depth = Math.max(0, depth - 1);
    else if (value[index] === ';' && depth === 0) return index;
  }
  return value.length;
}

function topLevelClause(value, start, end, boundaryWords) {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const char = value[index];
    if (char === QUOTED_IDENTIFIER_OPEN) {
      const closeIndex = value.indexOf(QUOTED_IDENTIFIER_CLOSE, index + 1);
      if (closeIndex === -1 || closeIndex >= end) {
        return { balanced: false, endIndex: index, text: value.slice(start, index) };
      }
      index = closeIndex;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      if (depth === 0) return { balanced: false, endIndex: index, text: value.slice(start, index) };
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !/[a-z_$]/.test(char)) continue;
    const word = /^[a-z_$][\w$]*/.exec(value.slice(index, end))?.[0];
    if (!word) continue;
    if (boundaryWords.has(word)) {
      return { balanced: depth === 0, endIndex: index, text: value.slice(start, index) };
    }
    index += word.length - 1;
  }
  return { balanced: depth === 0, endIndex: end, text: value.slice(start, end) };
}

function topLevelEqualsIndex(value) {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (depth < 0) return -1;
    } else if (value[index] === '=' && depth === 0) {
      return index;
    }
  }
  return -1;
}

function assignmentColumnNames(left) {
  const normalized = left.trim();
  const column = sqlIdentifierName(normalized);
  if (column !== null) return [column];
  if (normalized[0] !== '(') return null;
  const range = parenthesizedSqlRangeAt(normalized, 0);
  if (!range || range.closeIndex !== normalized.length - 1) return null;
  const columns = splitTopLevelSqlList(range.body).map((part) => sqlIdentifierName(part));
  if (columns.length === 0 || columns.some((part) => part === null)) {
    return null;
  }
  return columns;
}

function classifySetClause(value, start, end, boundaryWords) {
  const clause = topLevelClause(value, start, end, boundaryWords);
  if (!clause.balanced || clause.text.trim() === '') return { kind: 'unknown' };
  let writesBody = false;
  for (const assignment of splitTopLevelSqlList(clause.text)) {
    const equalsIndex = topLevelEqualsIndex(assignment);
    if (equalsIndex < 0) return { kind: 'unknown' };
    const columns = assignmentColumnNames(assignment.slice(0, equalsIndex));
    if (!columns) return { kind: 'unknown' };
    if (columns.includes('content')) writesBody = true;
  }
  return { kind: writesBody ? 'body' : 'safe' };
}

function updateSetStart(value, targetEnd, statementEnd) {
  let cursor = skipSqlWhitespace(value, targetEnd, statementEnd);
  let word = sqlWordAt(value, cursor, statementEnd);
  if (!word) return null;

  if (word.word === 'as') {
    const alias = sqlWordAt(value, word.endIndex, statementEnd);
    if (!alias) return null;
    cursor = alias.endIndex;
    word = sqlWordAt(value, cursor, statementEnd);
  } else if (!new Set(['set', 'indexed', 'not']).has(word.word)) {
    cursor = word.endIndex;
    word = sqlWordAt(value, cursor, statementEnd);
  }
  if (!word) return null;

  if (word.word === 'indexed') {
    const by = sqlWordAt(value, word.endIndex, statementEnd);
    const indexName = by?.word === 'by' ? sqlWordAt(value, by.endIndex, statementEnd) : null;
    if (!indexName) return null;
    word = sqlWordAt(value, indexName.endIndex, statementEnd);
  } else if (word.word === 'not') {
    const indexed = sqlWordAt(value, word.endIndex, statementEnd);
    if (indexed?.word !== 'indexed') return null;
    word = sqlWordAt(value, indexed.endIndex, statementEnd);
  }
  return word?.word === 'set' ? word.endIndex : null;
}

function classifyUpdateAt(masked, match) {
  const statementEnd = topLevelStatementEnd(masked, match.index);
  const setStart = updateSetStart(masked, match.index + match[0].length, statementEnd);
  if (setStart === null) return { kind: 'unknown-protected-write', masked };
  const set = classifySetClause(
    masked,
    setStart,
    statementEnd,
    new Set(['from', 'limit', 'order', 'returning', 'where']),
  );
  if (set.kind === 'body') return { kind: 'update', masked };
  if (set.kind === 'unknown') return { kind: 'unknown-protected-write', masked };
  return null;
}

function topLevelSqlWords(value, start, end) {
  const words = [];
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const char = value[index];
    if (char === QUOTED_IDENTIFIER_OPEN) {
      const closeIndex = value.indexOf(QUOTED_IDENTIFIER_CLOSE, index + 1);
      if (closeIndex === -1 || closeIndex >= end) return null;
      index = closeIndex;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth < 0) return null;
      continue;
    }
    if (depth !== 0 || !/[a-z_$]/.test(char)) continue;
    const word = /^[a-z_$][\w$]*/.exec(value.slice(index, end))?.[0];
    if (!word) continue;
    words.push({ endIndex: index + word.length, startIndex: index, word });
    index += word.length - 1;
  }
  return depth === 0 ? words : null;
}

function classifyUpsert(masked, start, statementEnd) {
  const words = topLevelSqlWords(masked, start, statementEnd);
  if (!words) return { kind: 'unknown' };
  const arms = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    if (words[index].word === 'on' && words[index + 1].word === 'conflict') {
      arms.push({ startIndex: words[index].startIndex, wordIndex: index + 2 });
    }
  }
  if (arms.length === 0) return { kind: 'none' };

  let hasUnknown = false;
  for (let armIndex = 0; armIndex < arms.length; armIndex += 1) {
    const arm = arms[armIndex];
    const armEnd = arms[armIndex + 1]?.startIndex ?? statementEnd;
    const doIndex = words.findIndex(
      (word, index) => index >= arm.wordIndex && word.startIndex < armEnd && word.word === 'do',
    );
    const action = doIndex < 0 ? null : words[doIndex + 1];
    if (!action || action.startIndex >= armEnd) {
      hasUnknown = true;
      continue;
    }
    if (action.word === 'nothing') continue;
    if (action.word !== 'update') {
      hasUnknown = true;
      continue;
    }
    const set = words[doIndex + 2];
    if (!set || set.startIndex >= armEnd || set.word !== 'set') {
      hasUnknown = true;
      continue;
    }
    const classification = classifySetClause(
      masked,
      set.endIndex,
      armEnd,
      new Set(['returning', 'where']),
    );
    if (classification.kind === 'body') return classification;
    if (classification.kind === 'unknown') hasUnknown = true;
  }
  return { kind: hasUnknown ? 'unknown' : 'safe' };
}

function classifyInsertAt(sql, masked, insert) {
  const command = insert[1].replace(/\s+/g, ' ').trim();
  const target = insert[2].replace(/\s+/g, '');
  const afterTable = insert.index + insert[0].length;
  const statementEnd = topLevelStatementEnd(masked, insert.index);
  let cursor = skipSqlWhitespace(masked, afterTable, statementEnd);
  let columnsRange = null;
  if (masked[cursor] === '(') {
    columnsRange = parenthesizedSqlRangeAt(masked, cursor);
    if (!columnsRange || columnsRange.closeIndex >= statementEnd) {
      return { kind: 'unknown-protected-write', masked };
    }
  }
  const columnNames = columnsRange === null
    ? null
    : splitTopLevelSqlList(columnsRange.body).map((column) => sqlIdentifierName(column));
  if (
    columnNames !== null
    && (columnNames.length === 0 || columnNames.some((column) => column === null))
  ) {
    return { kind: 'unknown-protected-write', masked };
  }
  const afterColumns = columnsRange === null ? afterTable : columnsRange.closeIndex + 1;
  cursor = skipSqlWhitespace(masked, afterColumns, statementEnd);
  const source = sqlWordAt(masked, cursor, statementEnd);
  const replacement = command === 'replace' || command === 'insert or replace';
  const upsert = classifyUpsert(masked, afterColumns, statementEnd);
  const writesBody = columnNames === null
    || columnNames.includes('content')
    || replacement
    || upsert.kind === 'body';

  if (!writesBody) {
    if (upsert.kind === 'unknown') return { kind: 'unknown-protected-write', masked };
    if (!source || !new Set(['default', 'select', 'values', 'with']).has(source.word)) {
      return { kind: 'unknown-protected-write', masked };
    }
    return null;
  }

  let valuesRange = null;
  const valuesMatch = /^\s*values\s*\(/.exec(masked.slice(afterColumns, statementEnd));
  if (valuesMatch) {
    const openIndex = afterColumns + valuesMatch[0].lastIndexOf('(');
    valuesRange = parenthesizedSqlRangeAt(masked, openIndex);
  }
  return {
    columnNames,
    command,
    kind: upsert.kind === 'body' ? 'upsert' : (replacement ? 'replace' : 'insert'),
    masked,
    sql,
    statementPrefix: masked.slice(0, insert.index),
    target,
    values: valuesRange === null ? null : splitTopLevelSqlList(valuesRange.body),
    valuesTail: valuesRange === null ? null : masked.slice(valuesRange.closeIndex + 1, statementEnd),
  };
}

function classifyChapterBodyMutation(sql) {
  const masked = lexSqlForManuscriptGuard(sql);
  const quotedIdentifier = `${QUOTED_IDENTIFIER_OPEN}[a-z_$][\\w$]*${QUOTED_IDENTIFIER_CLOSE}`;
  const identifier = `(?:[a-z_$][\\w$]*|${quotedIdentifier})`;
  const chapterIdentifier = `(?:chapters|${QUOTED_IDENTIFIER_OPEN}chapters${QUOTED_IDENTIFIER_CLOSE})`;
  const chapterTarget = `(?:${identifier}\\s*\\.\\s*)?${chapterIdentifier}`;
  let unknown = null;
  const updatePattern = new RegExp(
    `\\bupdate\\s+(?:or\\s+(?:rollback|abort|replace|fail|ignore)\\s+)?`
      + `${chapterTarget}(?![\\w$])`,
    'g',
  );
  for (const update of masked.matchAll(updatePattern)) {
    const classification = classifyUpdateAt(masked, update);
    if (classification?.kind === 'update') return classification;
    if (classification?.kind === 'unknown-protected-write') unknown = classification;
  }

  const insertPattern = new RegExp(
    `\\b(insert(?:\\s+or\\s+(?:rollback|abort|replace|fail|ignore))?|replace)`
      + `\\s+into\\s+(${chapterTarget})(?![\\w$])`,
    'g',
  );
  for (const insert of masked.matchAll(insertPattern)) {
    const classification = classifyInsertAt(sql, masked, insert);
    if (classification?.kind !== 'unknown-protected-write' && classification !== null) {
      return classification;
    }
    if (classification?.kind === 'unknown-protected-write') unknown = classification;
  }
  return unknown;
}

module.exports = {
  classifyChapterBodyMutation,
  lexSqlForManuscriptGuard,
};
