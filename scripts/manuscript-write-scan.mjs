#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const QUOTED_IDENTIFIER_OPEN = '\u0001'
const QUOTED_IDENTIFIER_CLOSE = '\u0002'

function identifierName(value) {
  const normalized = value.trim()
  if (/^[a-z_$][\w$]*$/.test(normalized)) return normalized
  if (
    normalized.startsWith(QUOTED_IDENTIFIER_OPEN)
    && normalized.endsWith(QUOTED_IDENTIFIER_CLOSE)
  ) {
    const identifier = normalized.slice(1, -1)
    if (/^[a-z_$][\w$]*$/.test(identifier)) return identifier
  }
  return null
}

function maskSql(sql) {
  if (typeof sql !== 'string') return ''
  let output = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    const next = sql[index + 1]
    if (char === '-' && next === '-') {
      index += 2
      while (index < sql.length && !/[\r\n]/.test(sql[index])) index += 1
      output += ' '
      continue
    }
    if (char === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      output += ' '
      continue
    }
    if (char === "'") {
      index += 1
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2
            continue
          }
          index += 1
          break
        }
        index += 1
      }
      output += ' '
      continue
    }
    if (char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char
      let identifier = ''
      index += 1
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (closing !== ']' && sql[index + 1] === closing) {
            identifier += closing
            index += 2
            continue
          }
          index += 1
          break
        }
        identifier += sql[index]
        index += 1
      }
      output += /^[A-Za-z_$][\w$]*$/.test(identifier)
        ? ` ${QUOTED_IDENTIFIER_OPEN}${identifier.toLowerCase()}${QUOTED_IDENTIFIER_CLOSE} `
        : ' '
      continue
    }
    if (char === QUOTED_IDENTIFIER_OPEN || char === QUOTED_IDENTIFIER_CLOSE) {
      output += ' '
      index += 1
      continue
    }
    output += char.toLowerCase()
    index += 1
  }
  return output
}

function parenthesizedRange(value, openIndex) {
  if (value[openIndex] !== '(') return null
  let depth = 0
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') {
      depth -= 1
      if (depth === 0) return { body: value.slice(openIndex + 1, index), closeIndex: index }
    }
  }
  return null
}

function splitTopLevel(value) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') depth -= 1
    else if (value[index] === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

function skipWhitespace(value, start, end = value.length) {
  let cursor = start
  while (cursor < end && /\s/.test(value[cursor])) cursor += 1
  return cursor
}

function wordAt(value, start, end = value.length) {
  const cursor = skipWhitespace(value, start, end)
  if (value[cursor] === QUOTED_IDENTIFIER_OPEN) {
    const closeIndex = value.indexOf(QUOTED_IDENTIFIER_CLOSE, cursor + 1)
    if (closeIndex === -1 || closeIndex >= end) return null
    const word = value.slice(cursor, closeIndex + 1)
    return identifierName(word) === null
      ? null
      : { endIndex: closeIndex + 1, startIndex: cursor, word }
  }
  const match = /^[a-z_$][\w$]*/.exec(value.slice(cursor, end))
  return match
    ? { endIndex: cursor + match[0].length, startIndex: cursor, word: match[0] }
    : null
}

function statementEnd(value, start) {
  let depth = 0
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') depth = Math.max(0, depth - 1)
    else if (value[index] === ';' && depth === 0) return index
  }
  return value.length
}

function topLevelClause(value, start, end, boundaries) {
  let depth = 0
  for (let index = start; index < end; index += 1) {
    const char = value[index]
    if (char === QUOTED_IDENTIFIER_OPEN) {
      const closeIndex = value.indexOf(QUOTED_IDENTIFIER_CLOSE, index + 1)
      if (closeIndex === -1 || closeIndex >= end) {
        return { balanced: false, text: value.slice(start, index) }
      }
      index = closeIndex
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      if (depth === 0) return { balanced: false, text: value.slice(start, index) }
      depth -= 1
      continue
    }
    if (depth !== 0 || !/[A-Za-z_$]/.test(char)) continue
    const word = /^[A-Za-z_$][\w$]*/.exec(value.slice(index, end))?.[0]
    if (!word) continue
    if (boundaries.has(word.toLowerCase())) return { balanced: true, text: value.slice(start, index) }
    index += word.length - 1
  }
  return { balanced: depth === 0, text: value.slice(start, end) }
}

function topLevelEquals(value) {
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') {
      depth -= 1
      if (depth < 0) return -1
    } else if (value[index] === '=' && depth === 0) return index
  }
  return -1
}

function assignmentColumns(left) {
  const normalized = left.trim()
  const column = identifierName(normalized)
  if (column !== null) return [column]
  if (normalized[0] !== '(') return null
  const range = parenthesizedRange(normalized, 0)
  if (!range || range.closeIndex !== normalized.length - 1) return null
  const columns = splitTopLevel(range.body).map((part) => identifierName(part))
  return columns.length > 0 && columns.every((part) => part !== null)
    ? columns
    : null
}

function classifyAssignments(value, start, end, boundaries) {
  const clause = topLevelClause(value, start, end, boundaries)
  if (!clause.balanced || clause.text.trim() === '') return 'unknown'
  let body = false
  for (const assignment of splitTopLevel(clause.text)) {
    const equalsIndex = topLevelEquals(assignment)
    const columns = equalsIndex < 0 ? null : assignmentColumns(assignment.slice(0, equalsIndex))
    if (!columns) return 'unknown'
    if (columns.includes('content')) body = true
  }
  return body ? 'body' : 'safe'
}

function updateSetStart(value, targetEnd, end) {
  let word = wordAt(value, targetEnd, end)
  if (!word) return null
  if (word.word === 'as') {
    const alias = wordAt(value, word.endIndex, end)
    if (!alias) return null
    word = wordAt(value, alias.endIndex, end)
  } else if (!new Set(['set', 'indexed', 'not']).has(word.word)) {
    word = wordAt(value, word.endIndex, end)
  }
  if (!word) return null
  if (word.word === 'indexed') {
    const by = wordAt(value, word.endIndex, end)
    const indexName = by?.word === 'by' ? wordAt(value, by.endIndex, end) : null
    if (!indexName) return null
    word = wordAt(value, indexName.endIndex, end)
  } else if (word.word === 'not') {
    const indexed = wordAt(value, word.endIndex, end)
    if (indexed?.word !== 'indexed') return null
    word = wordAt(value, indexed.endIndex, end)
  }
  return word?.word === 'set' ? word.endIndex : null
}

function topLevelWords(value, start, end) {
  const words = []
  let depth = 0
  for (let index = start; index < end; index += 1) {
    const char = value[index]
    if (char === QUOTED_IDENTIFIER_OPEN) {
      const closeIndex = value.indexOf(QUOTED_IDENTIFIER_CLOSE, index + 1)
      if (closeIndex === -1 || closeIndex >= end) return null
      index = closeIndex
      continue
    }
    if (char === '(') {
      depth += 1
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth < 0) return null
      continue
    }
    if (depth !== 0 || !/[a-z_$]/.test(char)) continue
    const word = /^[a-z_$][\w$]*/.exec(value.slice(index, end))?.[0]
    if (!word) continue
    words.push({ endIndex: index + word.length, startIndex: index, word })
    index += word.length - 1
  }
  return depth === 0 ? words : null
}

function classifyUpsert(value, start, end) {
  const words = topLevelWords(value, start, end)
  if (!words) return 'unknown'
  const arms = []
  for (let index = 0; index < words.length - 1; index += 1) {
    if (words[index].word === 'on' && words[index + 1].word === 'conflict') {
      arms.push({ startIndex: words[index].startIndex, wordIndex: index + 2 })
    }
  }
  if (arms.length === 0) return 'none'

  let unknown = false
  for (let armIndex = 0; armIndex < arms.length; armIndex += 1) {
    const arm = arms[armIndex]
    const armEnd = arms[armIndex + 1]?.startIndex ?? end
    const doIndex = words.findIndex(
      (word, index) => index >= arm.wordIndex && word.startIndex < armEnd && word.word === 'do',
    )
    const action = doIndex < 0 ? null : words[doIndex + 1]
    if (!action || action.startIndex >= armEnd) {
      unknown = true
      continue
    }
    if (action.word === 'nothing') continue
    if (action.word !== 'update') {
      unknown = true
      continue
    }
    const set = words[doIndex + 2]
    if (!set || set.startIndex >= armEnd || set.word !== 'set') {
      unknown = true
      continue
    }
    const assignment = classifyAssignments(
      value,
      set.endIndex,
      armEnd,
      new Set(['returning', 'where']),
    )
    if (assignment === 'body') return 'body'
    if (assignment === 'unknown') unknown = true
  }
  return unknown ? 'unknown' : 'safe'
}

function classifySqlWrite(sql) {
  const value = maskSql(sql)
  const quotedIdentifier = `${QUOTED_IDENTIFIER_OPEN}[a-z_$][\\w$]*${QUOTED_IDENTIFIER_CLOSE}`
  const identifier = `(?:[a-z_$][\\w$]*|${quotedIdentifier})`
  const chapterIdentifier = `(?:chapters|${QUOTED_IDENTIFIER_OPEN}chapters${QUOTED_IDENTIFIER_CLOSE})`
  const target = `(?:${identifier}\\s*\\.\\s*)?${chapterIdentifier}`
  let unknown = false

  const updates = new RegExp(
    `\\bupdate\\s+(?:or\\s+(?:rollback|abort|replace|fail|ignore)\\s+)?${target}(?![\\w$])`,
    'g',
  )
  for (const update of value.matchAll(updates)) {
    const end = statementEnd(value, update.index)
    const setStart = updateSetStart(value, update.index + update[0].length, end)
    if (setStart === null) {
      unknown = true
      continue
    }
    const assignmentKind = classifyAssignments(
      value,
      setStart,
      end,
      new Set(['from', 'limit', 'order', 'returning', 'where']),
    )
    if (assignmentKind === 'body') return 'update-content'
    if (assignmentKind === 'unknown') unknown = true
  }

  const inserts = new RegExp(
    `\\b(insert(?:\\s+or\\s+(?:rollback|abort|replace|fail|ignore))?|replace)`
      + `\\s+into\\s+${target}(?![\\w$])`,
    'g',
  )
  for (const insert of value.matchAll(inserts)) {
    const end = statementEnd(value, insert.index)
    const command = insert[1].replace(/\s+/g, ' ').trim()
    const afterTable = insert.index + insert[0].length
    let cursor = skipWhitespace(value, afterTable, end)
    let columns = null
    let afterColumns = afterTable
    if (value[cursor] === '(') {
      const range = parenthesizedRange(value, cursor)
      if (!range || range.closeIndex >= end) {
        unknown = true
        continue
      }
      columns = splitTopLevel(range.body).map((column) => identifierName(column))
      afterColumns = range.closeIndex + 1
      if (columns.length === 0 || columns.some((column) => column === null)) {
        unknown = true
        continue
      }
    }
    const replacement = command === 'replace' || command === 'insert or replace'
    const upsert = classifyUpsert(value, afterColumns, end)
    if (upsert === 'body') return 'upsert-content'
    if (replacement) return 'replace-content'
    if (columns === null || columns.includes('content')) return 'insert-content'
    if (upsert === 'unknown') unknown = true
    cursor = skipWhitespace(value, afterColumns, end)
    const source = wordAt(value, cursor, end)
    if (!source || !new Set(['default', 'select', 'values', 'with']).has(source.word)) unknown = true
  }
  return unknown ? 'unknown-protected-write' : null
}

function classifyProductSqlBypass(sql) {
  const value = maskSql(sql)
  if (/\bcreate\s+(?:index|table|trigger)\b/.test(value)) return null
  const quotedIdentifier = `${QUOTED_IDENTIFIER_OPEN}[a-z_$][\\w$]*${QUOTED_IDENTIFIER_CLOSE}`
  const identifier = `(?:[a-z_$][\\w$]*|${quotedIdentifier})`
  const articleTable = `(?:chapters|volumes|${QUOTED_IDENTIFIER_OPEN}(?:chapters|volumes)${QUOTED_IDENTIFIER_CLOSE})`
  const qualifiedArticleTable = `(?:${identifier}\\s*\\.\\s*)?${articleTable}`

  if (new RegExp(`\\bdelete\\s+from\\s+${qualifiedArticleTable}(?![\\w$])`).test(value)) {
    return 'physical-delete'
  }
  if (
    new RegExp(`\\bupdate\\s+(?:or\\s+\\w+\\s+)?${qualifiedArticleTable}(?![\\w$])`).test(value)
    || new RegExp(`\\b(?:insert(?:\\s+or\\s+\\w+)?|replace)\\s+into\\s+${qualifiedArticleTable}(?![\\w$])`).test(value)
  ) return 'article-truth-write'
  if (/\bmax\s*\(\s*(?:(?:[a-z_$][\w$]*|\u0001[a-z_$][\w$]*\u0002)\s*\.\s*)?num\s*\)/.test(value)) {
    return 'legacy-max-num'
  }
  if (/\bexpected_resolve_chapter\b/.test(value)) {
    return 'legacy-expected-resolve-chapter'
  }
  if (
    /\bselect\b/.test(value)
    && new RegExp(`\\b(?:from|join)\\s+${qualifiedArticleTable}(?![\\w$])`).test(value)
  ) return 'freshness-bypass-read'
  return null
}

function parseJavaScript(sourceText, fileName) {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
}

function staticExpressionText(node, bindings = new Map(), preserveDynamic = true) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null
  if (ts.isParenthesizedExpression(node)) {
    return staticExpressionText(node.expression, bindings, preserveDynamic)
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const resolved = staticExpressionText(span.expression, bindings, false)
      if (resolved === null && !preserveDynamic) return null
      value += resolved === null ? `\${}{${span.expression.getText()}}` : resolved
      value += span.literal.text
    }
    return value
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticExpressionText(node.left, bindings, preserveDynamic)
    const right = staticExpressionText(node.right, bindings, preserveDynamic)
    return left === null || right === null ? null : left + right
  }
  return null
}

function propertyCallName(call) {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function functionScopeName(scope) {
  let current = scope
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current) && current.name) {
      if (ts.isIdentifier(current.name) || ts.isStringLiteralLike(current.name)) {
        return current.name.text
      }
    }
    if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current))
      && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)
    ) return current.parent.name.text
    current = current.parent
  }
  return null
}

function assignmentIdentifier(text) {
  const match = text?.match(/^\s*(?:([A-Za-z_$][\w$]*)|"([A-Za-z_$][\w$]*)"|\[([A-Za-z_$][\w$]*)\]|`([A-Za-z_$][\w$]*)`)\s*=/)
  return match?.slice(1).find(Boolean)?.toLowerCase() ?? null
}

function dynamicAssignmentIdentifier(text) {
  const match = text?.match(
    /(?:"\$\{\}\{([A-Za-z_$][\w$]*)\}"|\[\$\{\}\{([A-Za-z_$][\w$]*)\}\]|`\$\{\}\{([A-Za-z_$][\w$]*)\}`|\$\{\}\{([A-Za-z_$][\w$]*)\})\s*=\s*\?/,
  )
  return match?.slice(1).find(Boolean) ?? null
}

function dynamicSetTargetNames(text) {
  const masked = maskSql(text)
  const match = /\bupdate\s+(?:or\s+\w+\s+)?(?:[a-z_$][\w$]*\s*\.\s*)?chapters(?:\s+(?:as\s+)?[a-z_$][\w$]*)?(?:\s+(?:indexed\s+by\s+[a-z_$][\w$]*|not\s+indexed))?\s+set\b/.exec(masked)
  if (!match) return null
  const clause = topLevelClause(
    text,
    match.index + match[0].length,
    text.length,
    new Set(['from', 'limit', 'order', 'returning', 'where']),
  ).text
  return [...clause.matchAll(/\$\{\}\{([A-Za-z_$][\w$]*)/g)].map((item) => item[1])
}

function scanSource(sourceText, fileName) {
  const sourceFile = parseJavaScript(sourceText, fileName)
  const sqlExpressions = []
  const calls = []
  const forOfStatements = []
  const arrayValuesByScope = new Map()
  const arrayAliasesByScope = new Map()

  const scopeOf = (node) => {
    let current = node
    while (current && current !== sourceFile) {
      if (ts.isFunctionLike(current)) return current
      current = current.parent
    }
    return sourceFile
  }
  const scopedMap = (root, scope) => {
    if (!root.has(scope)) root.set(scope, new Map())
    return root.get(scope)
  }
  const declarations = []
  const collectDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push(node)
    }
    ts.forEachChild(node, collectDeclarations)
  }
  collectDeclarations(sourceFile)
  const staticBindingsByScope = new Map()
  for (let pass = 0; pass <= declarations.length; pass += 1) {
    let changed = false
    for (const declaration of declarations) {
      if (ts.isArrayLiteralExpression(declaration.initializer)) continue
      const bindings = scopedMap(staticBindingsByScope, scopeOf(declaration))
      const value = staticExpressionText(declaration.initializer, bindings, false)
      if (value !== null && bindings.get(declaration.name.text) !== value) {
        bindings.set(declaration.name.text, value)
        changed = true
      }
    }
    if (!changed) break
  }
  const expressionText = (node, preserveDynamic = true) => staticExpressionText(
    node,
    staticBindingsByScope.get(scopeOf(node)) || new Map(),
    preserveDynamic,
  )
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = expressionText(node)
      const staticPlusParent = ts.isBinaryExpression(node.parent)
        && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
        && expressionText(node.parent, false) !== null
      if (text !== null && !staticPlusParent) sqlExpressions.push({ node, text })
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const text = expressionText(node, false)
      if (text !== null) sqlExpressions.push({ node, text })
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      const values = node.initializer.elements
        .map((element) => expressionText(element, false))
        .filter((value) => value !== null)
      scopedMap(arrayValuesByScope, scopeOf(node)).set(node.name.text, values)
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isIdentifier(node.initializer)
    ) {
      scopedMap(arrayAliasesByScope, scopeOf(node)).set(node.name.text, node.initializer.text)
    }
    if (ts.isForOfStatement(node)) forOfStatements.push(node)
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const buildersByScope = new Map()
  const builders = (scope) => scopedMap(buildersByScope, scope)
  const addBuilderColumns = (scope, name, columns) => {
    const target = builders(scope)
    if (!target.has(name)) target.set(name, new Set())
    for (const column of columns) target.get(name).add(column)
  }
  const pushedIdentifier = (call) => (
    propertyCallName(call) === 'push'
    && ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
      ? call.expression.expression.text
      : null
  )

  for (const [scope, arrays] of arrayValuesByScope) {
    for (const [name, values] of arrays) {
      const columns = values.map(assignmentIdentifier)
      if (columns.length > 0 && columns.every(Boolean)) addBuilderColumns(scope, name, columns)
    }
  }
  for (const call of calls) {
    const target = pushedIdentifier(call)
    const text = call.arguments[0] ? expressionText(call.arguments[0]) : null
    const column = assignmentIdentifier(text)
    if (target && column) addBuilderColumns(scopeOf(call), target, [column])
  }
  for (const statement of forOfStatements) {
    const declaration = ts.isVariableDeclarationList(statement.initializer)
      ? statement.initializer.declarations[0]
      : null
    const loopVariable = declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null
    const sourceName = ts.isIdentifier(statement.expression) ? statement.expression.text : null
    const scope = scopeOf(statement)
    const sourceValues = sourceName ? arrayValuesByScope.get(scope)?.get(sourceName) : null
    if (!loopVariable || !sourceValues?.every((value) => /^[A-Za-z_$][\w$]*$/.test(value))) continue
    const inspectLoop = (node) => {
      if (ts.isCallExpression(node)) {
        const target = pushedIdentifier(node)
        const text = node.arguments[0] ? expressionText(node.arguments[0]) : null
        if (target && dynamicAssignmentIdentifier(text) === loopVariable && scopeOf(node) === scope) {
          addBuilderColumns(scope, target, sourceValues.map((value) => value.toLowerCase()))
        }
      }
      ts.forEachChild(node, inspectLoop)
    }
    inspectLoop(statement.statement)
  }
  for (const [scope, aliases] of arrayAliasesByScope) {
    const targetBuilders = builders(scope)
    for (let pass = 0; pass <= aliases.size; pass += 1) {
      let changed = false
      for (const [alias, source] of aliases) {
        const aliasColumns = targetBuilders.get(alias)
        const sourceColumns = targetBuilders.get(source)
        if (aliasColumns && !sourceColumns) {
          targetBuilders.set(source, new Set(aliasColumns))
          changed = true
        } else if (sourceColumns && !aliasColumns) {
          targetBuilders.set(alias, new Set(sourceColumns))
          changed = true
        } else if (aliasColumns && sourceColumns) {
          const size = aliasColumns.size + sourceColumns.size
          for (const column of aliasColumns) sourceColumns.add(column)
          for (const column of sourceColumns) aliasColumns.add(column)
          if (aliasColumns.size + sourceColumns.size !== size) changed = true
        }
      }
      if (!changed) break
    }
  }

  const matches = []
  for (const { node, text } of sqlExpressions) {
    const scope = scopeOf(node)
    const functionName = functionScopeName(scope)
    if (text.includes('${}')) {
      const targetNames = dynamicSetTargetNames(text)
      if (targetNames?.length) {
        const targetBuilders = buildersByScope.get(scope)
        let body = false
        let unresolved = false
        for (const name of targetNames) {
          const columns = targetBuilders?.get(name)
          if (!columns) unresolved = true
          else if (columns.has('content')) body = true
        }
        if (body || unresolved) {
          matches.push({
            functionName,
            kind: body ? 'dynamic-update-content' : 'unknown-protected-write',
            line: lineOf(sourceFile, node),
            text,
          })
        }
        continue
      }
    }
    const kind = classifySqlWrite(text) || classifyProductSqlBypass(text)
    if (kind) matches.push({ functionName, kind, line: lineOf(sourceFile, node), text })
  }
  for (const call of calls) {
    if (!ts.isIdentifier(call.expression) || call.expression.text !== 'publishGeneratedProjectFile') {
      continue
    }
    const input = call.arguments[0]
    if (!input || !ts.isObjectLiteralExpression(input)) continue
    for (const property of input.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const name = property.name && (
        ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
      ) ? property.name.text : null
      if (name !== 'finalPath') continue
      if (/\b(?:req|request|body|query|params)\b/.test(property.initializer.getText(sourceFile))) {
        const scope = scopeOf(call)
        matches.push({
          functionName: functionScopeName(scope),
          kind: 'caller-controlled-path',
          line: lineOf(sourceFile, call),
          text: call.getText(sourceFile),
        })
      }
    }
  }
  return matches
}

function repositoryPath(repositoryRoot, filePath) {
  return relative(repositoryRoot, filePath).replaceAll('\\', '/')
}

function productionServerFiles(repositoryRoot) {
  const serverRoot = join(repositoryRoot, 'server')
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name)
      const file = repositoryPath(repositoryRoot, target)
      if (entry.isDirectory()) {
        if (file === 'server/tests') continue
        visit(target)
      } else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target)
    }
  }
  visit(serverRoot)
  return files.sort((left, right) => repositoryPath(repositoryRoot, left).localeCompare(
    repositoryPath(repositoryRoot, right),
  ))
}

function isExactMigration(match) {
  return match.kind === 'update-content'
    && match.functionName === 'normalizeLegacyChapterContent'
    && match.text.replace(/\s+/g, ' ').trim() === "UPDATE chapters SET content = '' WHERE content IS NULL"
}

function isExactSchemaMigrationRead(match) {
  return match.kind === 'freshness-bypass-read'
    && match.text.replace(/\s+/g, ' ').trim()
      === 'SELECT status FROM chapters WHERE id = ?'
}

const EXACT_INTERNAL_PRODUCT_OWNERS = new Map([
  ['server/chapter-revisions.js', new Set([
    'getPendingRevision',
    'rebasePendingRevision',
    'ensureRevisionBase',
    'getActiveRevision',
    'createPendingRevision',
    'updateRevisionDecisions',
    'applyRevision',
    'applyInTransaction',
  ])],
  ['server/manuscript/active-projection.js', new Set([
    'listVolumes',
    'listChapters',
    'getChapter',
    'resolveLegacyChapterNumber',
    'exportSnapshot',
  ])],
  ['server/index.js', new Set(['readAiChapter'])],
  ['server/manuscript-service.js', new Set([
    'readLegacyPromptContext',
    'resolveChapter',
    'writeChapterBodyInTransaction',
    'appendChapterBody',
    'createChapter',
  ])],
  ['server/manuscript/production-runtime.js', new Set([
    'dataVersionFor',
    'witnessFor',
    'statsView',
    'publishRevisionResolution',
    'readCommittedRevisionResolution',
  ])],
  ['server/manuscript/projection-store.js', new Set(['captureInstalledOrphanBaseline'])],
  ['server/recent-projects.js', new Set(['readLegacyRecentProject'])],
  ['server/routes/api.js', new Set([
    'createLegacySqliteProject',
    'listLegacySqliteChapters',
    'readLegacySqliteChapter',
    'resolveLegacySqliteChapter',
    'updateLegacySqliteChapter',
    'createLegacySqliteChapter',
    'deleteLegacySqliteChapter',
    'listLegacySqliteVolumes',
    'createLegacySqliteVolume',
    'updateLegacySqliteVolume',
    'deleteLegacySqliteVolume',
    'readLegacySqliteCharacterAssociations',
    'createLegacySqliteForeshadow',
    'readLegacySqliteStats',
    'readLegacySqliteExportSnapshot',
  ])],
  ['server/tools.js', new Set([
    'executeLegacySqliteTool',
    'executeLegacySqliteResolveChapter',
    'executeLegacySqliteUpdateById',
    'executeLegacySqliteDeleteById',
  ])],
  ['server/native/durability-schema.js', new Set(['installSchema12Candidate'])],
  ['server/native/native-project-store.js', new Set([
    'installTargetRows',
    'assertRevisionResolutionBase',
    'captureSchema12ProjectionBase',
    'schema12DesiredProjectionMatches',
    'assertCandidateProjection',
    'auxiliaryBasisChapter',
    'currentAuxiliaryChapter',
    'auxiliaryRevisionRow',
  ])],
  ['server/db.js', new Set(['captureProjection', 'captureMigrationSource', 'updateProjectWordCount'])],
])

function isExactInternalProductOwner(file, match) {
  return EXACT_INTERNAL_PRODUCT_OWNERS.get(file)?.has(match.functionName) === true
}

export function scanManuscriptWriteBoundary({ repositoryRoot = defaultRepositoryRoot } = {}) {
  const offenders = []
  for (const filePath of productionServerFiles(repositoryRoot)) {
    const file = repositoryPath(repositoryRoot, filePath)
    if (file === 'server/seed.js') continue
    for (const match of scanSource(readFileSync(filePath, 'utf8'), file)) {
      if (file === 'server/db.js' && isExactMigration(match)) continue
      if (file === 'server/db.js' && isExactSchemaMigrationRead(match)) continue
      if (isExactInternalProductOwner(file, match)) continue
      offenders.push({ file, line: match.line, kind: match.kind })
    }
  }
  return offenders.sort(
    (left, right) => left.file.localeCompare(right.file)
      || left.line - right.line
      || left.kind.localeCompare(right.kind),
  )
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const offenders = scanManuscriptWriteBoundary()
  if (offenders.length > 0) {
    for (const offender of offenders) {
      console.error(`${offender.file}:${offender.line}:${offender.kind}`)
    }
    process.exitCode = 1
  }
}
