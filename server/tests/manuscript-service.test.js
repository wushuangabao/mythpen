const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const { openControlStore } = require('../control-store');
const { classifyChapterBodyMutation } = require('../manuscript-sql-guard');
const { acquireExclusiveLease } = require('../platform/durability');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ROOT = path.join(REPO_ROOT, 'server');

// `server/seed.js` is an explicitly invoked, destructive sample-project
// bootstrap. It is not imported by the running server and is not one of L1's
// five product write paths. Keep this exclusion exact: broad bootstrap/source
// patterns would create an unaudited way around ManuscriptService.
const NON_RUNTIME_BOOTSTRAP = 'server/seed.js';
const NATIVE_PROJECTION_INSTALL_TARGET_BODY_UPSERT_SHA256 =
  'b8ecd0807edd2c35e7817b03ba6054020f178cdae7f3388516b504966e795808';

function repositoryPath(filePath) {
  return path.relative(REPO_ROOT, filePath).replaceAll('\\', '/');
}

function productionServerFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (repositoryPath(target) === 'server/tests') continue;
        visit(target);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(target);
      }
    }
  };
  visit(SERVER_ROOT);
  return files.sort((left, right) => repositoryPath(left).localeCompare(repositoryPath(right)));
}

function parseJavaScript(sourceText, fileName = 'fixture.js') {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
}

function staticExpressionText(node, bindings = new Map(), preserveDynamic = true) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null;
  if (ts.isParenthesizedExpression(node)) {
    return staticExpressionText(node.expression, bindings, preserveDynamic);
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const resolved = staticExpressionText(span.expression, bindings, false);
      if (resolved === null && !preserveDynamic) return null;
      value += resolved === null ? `\${}{${span.expression.getText()}}` : resolved;
      value += span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticExpressionText(node.left, bindings, preserveDynamic);
    const right = staticExpressionText(node.right, bindings, preserveDynamic);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function propertyCallName(call) {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function dynamicAssignmentIdentifier(text) {
  const match = text?.match(
    /(?:"\$\{\}\{([A-Za-z_$][\w$]*)\}"|\[\$\{\}\{([A-Za-z_$][\w$]*)\}\]|`\$\{\}\{([A-Za-z_$][\w$]*)\}`|\$\{\}\{([A-Za-z_$][\w$]*)\})\s*=\s*\?/,
  );
  return match?.slice(1).find(Boolean) ?? null;
}

function directBodySqlKind(text) {
  const normalized = text.replace(/["`\[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const insert = /\b(insert(?:\s+or\s+\w+)?|replace)\s+into\s+(?:[a-z_$][\w$]*\s*\.\s*)?chapters\s*(?:\(([^)]*)\))?/.exec(normalized);
  if (insert) {
    if (/\bon\s+conflict\b[\s\S]*?\bdo\s+update\s+set\b[\s\S]*?\bcontent\s*=/.test(normalized)) {
      return 'upsert-content';
    }
    const command = insert[1].replace(/\s+/g, ' ');
    if (command === 'replace' || command === 'insert or replace') return 'replace-content';
    if (!insert[2] || insert[2].split(',').some((column) => column.trim() === 'content')) {
      return 'insert-content';
    }
  }
  if (
    /\bupdate\s+(?:or\s+\w+\s+)?(?:[a-z_$][\w$]*\s*\.\s*)?chapters\b/.test(normalized)
    && /\bset\b[\s\S]*?\bcontent\s*=/.test(normalized)
  ) {
    return 'update-content';
  }
  return null;
}

function scanSource(sourceText, fileName = 'fixture.js') {
  const sourceFile = parseJavaScript(sourceText, fileName);
  const sqlExpressions = [];
  const calls = [];
  const forOfStatements = [];
  const arrayValuesByScope = new Map();
  const arrayAliasesByScope = new Map();

  const scopeOf = (node) => {
    let current = node;
    while (current && current !== sourceFile) {
      if (ts.isFunctionLike(current)) return current;
      current = current.parent;
    }
    return sourceFile;
  };
  const scopedMap = (root, scope) => {
    if (!root.has(scope)) root.set(scope, new Map());
    return root.get(scope);
  };
  const declarations = [];
  const collectDeclarations = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push(node);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);
  const staticBindingsByScope = new Map();
  for (let pass = 0; pass <= declarations.length; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      if (ts.isArrayLiteralExpression(declaration.initializer)) continue;
      const bindings = scopedMap(staticBindingsByScope, scopeOf(declaration));
      const value = staticExpressionText(declaration.initializer, bindings, false);
      if (value !== null && bindings.get(declaration.name.text) !== value) {
        bindings.set(declaration.name.text, value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const expressionText = (node, preserveDynamic = true) => staticExpressionText(
    node,
    staticBindingsByScope.get(scopeOf(node)) || new Map(),
    preserveDynamic,
  );
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = expressionText(node);
      const staticPlusParent = ts.isBinaryExpression(node.parent)
        && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
        && expressionText(node.parent, false) !== null;
      if (text !== null && !staticPlusParent) sqlExpressions.push({ node, text });
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const text = expressionText(node, false);
      if (text !== null) {
        sqlExpressions.push({ node, text });
      }
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isArrayLiteralExpression(node.initializer)
    ) {
      const values = node.initializer.elements
        .map((element) => expressionText(element, false))
        .filter((value) => value !== null);
      scopedMap(arrayValuesByScope, scopeOf(node)).set(node.name.text, values);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isIdentifier(node.initializer)
    ) {
      scopedMap(arrayAliasesByScope, scopeOf(node)).set(node.name.text, node.initializer.text);
    }
    if (ts.isForOfStatement(node)) forOfStatements.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const contentTargetsByScope = new Map();
  const scopedTargets = (scope) => {
    if (!contentTargetsByScope.has(scope)) contentTargetsByScope.set(scope, new Set());
    return contentTargetsByScope.get(scope);
  };
  const pushedIdentifier = (call) => (
    propertyCallName(call) === 'push'
    && ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
      ? call.expression.expression.text
      : null
  );

  for (const [scope, arrays] of arrayValuesByScope) {
    for (const [name, values] of arrays) {
      if (values.some((value) => /^\s*(?:content|"content"|`content`|\[content\])\s*=/i.test(value))) {
        scopedTargets(scope).add(name);
      }
    }
  }
  for (const call of calls) {
    const target = pushedIdentifier(call);
    const text = call.arguments[0] ? expressionText(call.arguments[0]) : null;
    if (
      target
      && text !== null
      && /^\s*(?:content|"content"|`content`|\[content\])\s*=/i.test(text)
    ) {
      scopedTargets(scopeOf(call)).add(target);
    }
  }
  for (const statement of forOfStatements) {
    const declaration = ts.isVariableDeclarationList(statement.initializer)
      ? statement.initializer.declarations[0]
      : null;
    const loopVariable = declaration && ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : null;
    const sourceName = ts.isIdentifier(statement.expression) ? statement.expression.text : null;
    const scope = scopeOf(statement);
    const sourceValues = sourceName ? arrayValuesByScope.get(scope)?.get(sourceName) : null;
    if (!loopVariable || !sourceValues?.includes('content')) continue;

    const inspectLoop = (node) => {
      if (ts.isCallExpression(node)) {
        const target = pushedIdentifier(node);
        const text = node.arguments[0] ? expressionText(node.arguments[0]) : null;
        const dynamicKey = dynamicAssignmentIdentifier(text);
        if (target && dynamicKey === loopVariable && scopeOf(node) === scope) {
          scopedTargets(scope).add(target);
        }
      }
      ts.forEachChild(node, inspectLoop);
    };
    inspectLoop(statement.statement);
  }
  for (const [scope, aliases] of arrayAliasesByScope) {
    const targets = scopedTargets(scope);
    for (let pass = 0; pass <= aliases.size; pass += 1) {
      let changed = false;
      for (const [alias, source] of aliases) {
        if (targets.has(alias) && !targets.has(source)) {
          targets.add(source);
          changed = true;
        }
        if (targets.has(source) && !targets.has(alias)) {
          targets.add(alias);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  const matches = [];

  // Inspect static SQL expressions themselves instead of assuming which API
  // receives them. This catches constants and wrappers such as run/exec or
  // projectExecute, while AST parsing still excludes comments.
  for (const { node, text } of sqlExpressions) {
    const kind = directBodySqlKind(text);
    const scope = scopeOf(node);
    const functionName = ts.isFunctionDeclaration(scope) && scope.name ? scope.name.text : null;
    if (kind) matches.push({ functionName, kind, line: lineOf(sourceFile, node), text });
    else if (/\bUPDATE\s+(?:chapters|"chapters"|`chapters`|\[chapters\])\s+SET\b/i.test(text) && text.includes('${}')) {
      const interpolatedTargets = [...text.matchAll(/\$\{\}\{([A-Za-z_$][\w$]*)/g)]
        .map((match) => match[1]);
      const contentTargets = contentTargetsByScope.get(scope);
      if (interpolatedTargets.some((target) => contentTargets?.has(target))) {
        matches.push({ functionName, kind: 'dynamic-update-content', line: lineOf(sourceFile, node), text });
      }
    }
  }
  return matches;
}

function isExistingDbMigration(match) {
  return match.kind === 'update-content'
    && match.functionName === 'normalizeLegacyChapterContent'
    && match.text.replace(/\s+/g, ' ').trim()
      === "UPDATE chapters SET content = '' WHERE content IS NULL";
}

function isNativeProjectionInstallTargetBodyWrite(file, match) {
  if (
    file !== 'server/native/native-project-store.js'
    || match.functionName !== 'installTargetRows'
    || match.kind !== 'upsert-content'
  ) return false;
  const normalizedSql = match.text.replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalizedSql).digest('hex')
    === NATIVE_PROJECTION_INSTALL_TARGET_BODY_UPSERT_SHA256;
}

function findUnexpectedDirectContentWrites() {
  const offenders = [];
  for (const filePath of productionServerFiles()) {
    const file = repositoryPath(filePath);
    if (file === NON_RUNTIME_BOOTSTRAP) continue;
    const matches = scanSource(fs.readFileSync(filePath, 'utf8'), file);
    for (const match of matches) {
      if (file === 'server/manuscript-service.js') continue;
      if (file === 'server/db.js' && isExistingDbMigration(match)) continue;
      if (isNativeProjectionInstallTargetBodyWrite(file, match)) continue;
      offenders.push(`${file}:${match.line}:${match.kind}`);
    }
  }
  return offenders;
}

function importedModules(sourceText, fileName) {
  const sourceFile = parseJavaScript(sourceText, fileName);
  const modules = [];
  const declarations = [];
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const bindings = new Map();
  for (let pass = 0; pass <= declarations.length; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      const value = staticExpressionText(declaration.initializer, bindings, false);
      if (value !== null && bindings.get(declaration.name.text) !== value) {
        bindings.set(declaration.name.text, value);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node)
      && (
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
        || node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
    ) {
      const moduleName = node.arguments[0]
        ? staticExpressionText(node.arguments[0], bindings, false)
        : null;
      if (moduleName !== null) modules.push(moduleName);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return modules;
}

function bodyHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('native manuscript intent is frozen before transaction entry without changing v1 publication', () => {
  const { createManuscriptService } = require('../manuscript-service');
  const trace = [];
  const body = 'Native intent body';
  const row = { id: 7, num: 1, content: 'Before', data_version: 3, word_count: 6 };
  const database = {
    manuscriptTransactionCapability: {
      assertActive() { return true; },
      claim() { return Object.freeze({}); },
      appendSourceEvent() { return Object.freeze({ digest: bodyHash('v1-event') }); },
    },
    runManuscriptTransaction(projectName, intent, callback) {
      trace.push(['intent', projectName, intent, Object.isFrozen(intent)]);
      assert.deepEqual(intent, {
        bodyBytes: Buffer.byteLength(body),
        bodySha256: bodyHash(body),
        chapterId: 7,
        chapterNumber: null,
        expectedBodySha256: null,
        expectedDataVersion: 3,
        operation: 'replace',
        source: 'rest',
        targetKind: 'chapter',
        version: 1,
        volumeId: null,
      });
      assert.equal(Object.isFrozen(intent), true);
      const projectDb = {
        prepare(sql) {
          if (/SELECT \* FROM chapters WHERE id/.test(sql)) {
            return { get: () => ({ ...row }) };
          }
          if (/UPDATE chapters SET/.test(sql)) return { run: (content) => {
            row.content = content;
            row.word_count = content.replace(/\s/g, '').length;
            return { changes: 1 };
          } };
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
      return callback(projectDb);
    },
    updateProjectWordCount() { return 1; },
  };

  const result = createManuscriptService(database).writeChapterBody({
    projectName: 'native-intent',
    chapterId: 7,
    content: body,
    expectedDataVersion: 3,
    source: 'rest',
  });
  assert.equal(result.content, 'Native intent body');
  assert.equal(trace.length, 1);
});

function projectControlStore(database, projectName) {
  const filePath = database.getProjectDbPath(projectName);
  const dbKey = createHash('sha256').update(canonicalDatabasePath(filePath)).digest('hex');
  return openControlStore(path.join(database.getDataDir(), 'control', 'sqlite', dbKey));
}

function projectLeasePath(database, projectName) {
  const canonicalPath = canonicalDatabasePath(database.getProjectDbPath(projectName));
  const digest = createHash('sha256').update(canonicalPath).digest('hex');
  return path.join(database.getDataDir(), 'locks', `${digest}.lease`);
}

async function createProject(t, projectName) {
  withIsolatedDataDir(t);
  const database = require('../db');
  await database.initDatabase();
  const projectDb = database.createProjectDb(projectName);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  return { database, projectDb };
}

test('static scanner finds multiline/template body SQL, dynamic assignments, and ignores comments', () => {
  const fixture = `
    // db.prepare("UPDATE chapters SET content = ? WHERE id = ?")
    db.prepare(\`INSERT INTO chapters (
      id,
      content
    ) VALUES (?, ?)\`);
    const allowed = ['title', 'content'];
    for (const key of allowed) updates.push(\`\${key} = ?\`);
    db.prepare(\`UPDATE chapters SET \${updates.join(', ')} WHERE id = ?\`);
    const updateSql = 'UPDATE chapters SET content = ? WHERE id = ?';
    db.run(updateSql, ['body', 1]);
    db.prepare(\`UPDATE chapters
      SET "content" = ?
      WHERE id = ?\`);
    db.run('UPDATE chapters SET [content] = ? WHERE id = ?', ['body', 1]);
    db.projectExecute('project', 'UPDATE chapters SET \`content\` = ? WHERE id = ?', ['body', 1]);
    const quotedAllowed = ['title', 'content'];
    for (const quotedKey of quotedAllowed) {
      doubleQuotedUpdates.push(\`"\${quotedKey}" = ?\`);
      bracketQuotedUpdates.push(\`[\${quotedKey}] = ?\`);
      backtickQuotedUpdates.push(\`\\\`\${quotedKey}\\\` = ?\`);
    }
    db.prepare(\`UPDATE chapters SET \${doubleQuotedUpdates.join(', ')} WHERE id = ?\`);
    db.prepare(\`UPDATE chapters SET \${bracketQuotedUpdates.join(', ')} WHERE id = ?\`);
    db.prepare(\`UPDATE chapters SET \${backtickQuotedUpdates.join(', ')} WHERE id = ?\`);
    db.prepare('UPDATE "chapters" SET "content" = ? WHERE id = ?');
    db.prepare('REPLACE INTO [chapters] ([id], [content]) VALUES (?, ?)');
    db.prepare('INSERT INTO \`chapters\` (id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET \`content\` = ?');
    const chapterTable = 'chapters';
    const bodyColumn = 'content';
    db.prepare(\`UPDATE "\${chapterTable}" SET [\${bodyColumn}] = ? WHERE id = ?\`);
    const directAssignments = [];
    const assignmentAlias = directAssignments;
    assignmentAlias.push('content = ?');
    db.prepare(\`UPDATE chapters SET \${directAssignments.join(', ')} WHERE id = ?\`);
    db.projectExecute('project', \`INSERT INTO chapters (
      title, content
    ) VALUES (?, ?)\`, ['Title', 'Body']);
    db.prepare('UPDATE OR REPLACE chapters SET content = ? WHERE id = ?');
    db.prepare('UPDATE main.chapters SET content = ? WHERE id = ?');
    db.prepare('UPDATE chapters AS chapter SET content = ? WHERE chapter.id = ?');
    db.prepare('UPDATE chapters INDEXED BY chapter_idx SET content = ? WHERE id = ?');
    db.prepare('UPDATE chapters NOT INDEXED SET content = ? WHERE id = ?');
    db.prepare('INSERT OR REPLACE INTO main.chapters (id, title) VALUES (?, ?)');
  `;
  assert.deepEqual(
    scanSource(fixture).map(({ kind }) => kind),
    [
      'insert-content',
      'dynamic-update-content',
      'update-content',
      'update-content',
      'update-content',
      'update-content',
      'dynamic-update-content',
      'dynamic-update-content',
      'dynamic-update-content',
      'update-content',
      'replace-content',
      'upsert-content',
      'update-content',
      'dynamic-update-content',
      'insert-content',
      'update-content',
      'update-content',
      'update-content',
      'update-content',
      'update-content',
      'replace-content',
    ],
  );
});

test('native projection body-write ownership is exact to installTargetRows and its approved SQL', () => {
  const nativeFile = 'server/native/native-project-store.js';
  const nativeSource = fs.readFileSync(path.join(REPO_ROOT, nativeFile), 'utf8');
  const productionMatches = scanSource(nativeSource, nativeFile).filter((match) => (
    match.functionName === 'installTargetRows' && match.kind === 'upsert-content'
  ));
  assert.equal(productionMatches.length, 1);
  assert.equal(isNativeProjectionInstallTargetBodyWrite(nativeFile, productionMatches[0]), true);

  const fixture = `
    function anotherNativeFunction() {
      db.prepare('INSERT INTO chapters (id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.title');
    }
    function installTargetRows() {
      db.prepare('INSERT INTO chapters (id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.title');
    }
  `;
  const rejected = scanSource(fixture, nativeFile);
  assert.equal(rejected.length, 2);
  assert.deepEqual(
    rejected.map((match) => isNativeProjectionInstallTargetBodyWrite(nativeFile, match)),
    [false, false],
  );
});

test('only ManuscriptService owns runtime SQL that writes chapters.content', () => {
  assert.deepEqual(findUnexpectedDirectContentWrites(), []);
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'manuscript-service.js')), true);
});

test('the exact non-runtime seed bootstrap exclusion is not imported by runtime modules', () => {
  const importers = [];
  for (const filePath of productionServerFiles()) {
    const file = repositoryPath(filePath);
    if (file === NON_RUNTIME_BOOTSTRAP) continue;
    const modules = importedModules(fs.readFileSync(filePath, 'utf8'), file);
    if (modules.some((specifier) => /(?:^|\/)seed(?:\.js)?$/.test(specifier))) importers.push(file);
  }
  assert.deepEqual(importers, []);
});

test('bootstrap capabilities have an exact production import topology', () => {
  const offlineImporters = [];
  const testCapabilityImporters = [];
  for (const filePath of productionServerFiles()) {
    const file = repositoryPath(filePath);
    const modules = importedModules(fs.readFileSync(filePath, 'utf8'), file);
    if (modules.some((specifier) => specifier.endsWith('/offline-seed-capability'))) {
      offlineImporters.push(file);
    }
    if (modules.some((specifier) => specifier.endsWith('/testing/database-internals'))) {
      testCapabilityImporters.push(file);
    }
  }
  assert.deepEqual(offlineImporters, ['server/db.js', 'server/seed.js']);
  assert.deepEqual(testCapabilityImporters, []);
  assert.deepEqual(
    importedModules(
      fs.readFileSync(path.join(SERVER_ROOT, 'tests', 'fixtures', 'raw-manuscript-setup.js'), 'utf8'),
      'server/tests/fixtures/raw-manuscript-setup.js',
    ),
    ['../../testing/database-internals'],
  );
});

test('seed import scanning resolves computed constants, aliases, and templates', () => {
  const fixture = `
    require('./' + 'seed');
    const seedModule = './seed';
    const seedAlias = seedModule;
    require(seedAlias);
    require(\`./\${'seed'}\`);
    import('./' + 'seed.js');
  `;
  assert.deepEqual(importedModules(fixture, 'dynamic-seed-imports.js'), [
    './seed',
    './seed',
    './seed',
    './seed.js',
  ]);
});

test('the db migration exemption is bound to the exact named migration AST scope', () => {
  const wrongScope = scanSource(`
    function unrelatedRuntimeWrite(db) {
      db.prepare("UPDATE chapters SET content = '' WHERE content IS NULL").run();
    }
  `)[0];
  const exactScope = scanSource(`
    function normalizeLegacyChapterContent(db) {
      db.prepare("UPDATE chapters SET content = '' WHERE content IS NULL").run();
    }
  `)[0];
  assert.equal(isExistingDbMigration(wrongScope), false);
  assert.equal(isExistingDbMigration(exactScope), true);
});

test('runtime guard rejects final chapter body SQL outside an exact manuscript authorization', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { projectDb } = await createProject(t, 'manuscript-runtime-guard');
  const created = createChapter({
    projectName: 'manuscript-runtime-guard',
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Chapter', content: 'Before' },
  });
  const directWrites = [
    () => projectDb.prepare('UPDATE OR REPLACE chapters SET content = ? WHERE id = ?').run('After', created.chapterId),
    () => projectDb.prepare('UPDATE main.chapters SET content = ? WHERE id = ?').run('After', created.chapterId),
    () => projectDb.prepare('UPDATE chapters AS chapter SET content = ? WHERE chapter.id = ?').run('After', created.chapterId),
    () => projectDb.prepare('UPDATE "chapters" SET "content" = ? WHERE id = ?').run('After', created.chapterId),
    () => projectDb.prepare('UPDATE [chapters] SET [content] = ? WHERE id = ?').run('After', created.chapterId),
    () => projectDb.prepare('UPDATE `chapters` SET `content` = ? WHERE id = ?').run('After', created.chapterId),
    () => projectDb.prepare('REPLACE INTO chapters (id, volume_id, num, content) VALUES (?, 1, 1, ?)').run(created.chapterId, 'After'),
    () => projectDb.prepare('INSERT OR REPLACE INTO main.chapters (id, volume_id, num, content) VALUES (?, 1, 1, ?)').run(created.chapterId, 'After'),
    () => projectDb.prepare("INSERT OR REPLACE INTO chapters (id, volume_id, num, title) VALUES (?, 1, 1, 'After')").run(created.chapterId),
    () => projectDb.prepare("REPLACE INTO main.chapters (id, volume_id, num, title) VALUES (?, 1, 1, 'After')").run(created.chapterId),
    () => projectDb.prepare("INSERT INTO chapters (id, volume_id, num, title) VALUES (?, 1, 1, 'After') ON CONFLICT(id) DO UPDATE SET content = excluded.title").run(created.chapterId),
    () => projectDb.exec(`UPDATE chapters SET content = 'After' WHERE id = ${created.chapterId}`),
  ];
  for (const directWrite of directWrites) {
    assert.throws(directWrite, (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED');
  }
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(created.chapterId).content, 'Before');
});

test('runtime row-value guard protects body writes and allows metadata-only assignments', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { projectDb } = await createProject(t, 'manuscript-row-value-runtime-guard');
  const created = createChapter({
    projectName: 'manuscript-row-value-runtime-guard',
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before title', outline: 'Before outline', content: 'Before body' },
  });

  assert.throws(
    () => projectDb
      .prepare('UPDATE chapters SET (content, title) = (?, ?) WHERE id = ?')
      .run('Escaped body', 'Escaped title', created.chapterId),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.throws(
    () => projectDb.prepare(`
      WITH chosen(id) AS (SELECT ?)
      UPDATE /* guard */ main."chapters"
      SET ("content", "title") = (?, ?)
      WHERE id IN (SELECT id FROM chosen)
    `).run(created.chapterId, 'Escaped body', 'Escaped title'),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.throws(
    () => projectDb.prepare(`
      INSERT INTO chapters (id, volume_id, num, title)
      VALUES (?, 1, 1, ?)
      ON CONFLICT(id) DO UPDATE
      SET (content, title) = (excluded.title, excluded.title)
    `).run(created.chapterId, 'Escaped body'),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );

  projectDb
    .prepare('UPDATE chapters SET (title, outline) = (?, ?) WHERE id = ?')
    .run('Metadata title', 'Metadata outline', created.chapterId);
  projectDb
    .prepare('UPDATE chapters SET title = CASE WHEN content = ? THEN ? ELSE title END WHERE id = ?')
    .run('Before body', 'Compared body safely', created.chapterId);

  assert.deepEqual(
    projectDb.prepare('SELECT title, outline, content FROM chapters WHERE id = ?').get(created.chapterId),
    { title: 'Compared body safely', outline: 'Metadata outline', content: 'Before body' },
  );
});

test('runtime quoted RHS boundary keywords cannot hide later body assignments', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { projectDb } = await createProject(t, 'manuscript-quoted-rhs-boundary-guard');
  const created = createChapter({
    projectName: 'manuscript-quoted-rhs-boundary-guard',
    source: 'rest',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before title', content: 'Before body' },
  });

  for (const keyword of ['where', 'returning', 'from']) {
    assert.throws(
      () => projectDb.exec(`
        UPDATE chapters
        SET title = "${keyword}", content = 'escaped-${keyword}'
        WHERE id = ${created.chapterId}
      `),
      (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
    );
  }
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(created.chapterId),
    { title: 'Before title', content: 'Before body' },
  );
});

test('runtime guard inspects every ON CONFLICT arm before allowing an upsert', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { projectDb } = await createProject(t, 'manuscript-multi-conflict-arm-guard');
  const created = createChapter({
    projectName: 'manuscript-multi-conflict-arm-guard',
    source: 'rest',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before title', content: 'Before body' },
  });
  const unusedId = created.chapterId + 1000;

  assert.throws(
    () => projectDb.prepare(`
      INSERT INTO chapters (id, volume_id, num, title)
      VALUES (?, 1, 1, 'New title')
      ON CONFLICT(id) DO NOTHING
      ON CONFLICT DO UPDATE SET content = 'escaped-upsert'
    `).run(unusedId),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(created.chapterId),
    { title: 'Before title', content: 'Before body' },
  );
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(unusedId), null);
});

test('runtime unknown-protected chapters mutations fail closed before SQLite execution', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { projectDb } = await createProject(t, 'manuscript-unknown-protected-runtime-guard');
  const created = createChapter({
    projectName: 'manuscript-unknown-protected-runtime-guard',
    source: 'rest',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before title', content: 'Before body' },
  });

  assert.throws(
    () => projectDb
      .prepare('UPDATE chapters SET (title, outline = (?, ?) WHERE id = ?')
      .run('Escaped title', 'Escaped outline', created.chapterId),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.equal(
    classifyChapterBodyMutation('UPDATE chapters SET (title, outline = (?, ?) WHERE id = ?')?.kind,
    'unknown-protected-write',
  );
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(created.chapterId),
    { title: 'Before title', content: 'Before body' },
  );
});

test('runtime guard checks later statements and preserves columnless insert classification', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { projectDb } = await createProject(t, 'manuscript-multi-statement-runtime-guard');
  const created = createChapter({
    projectName: 'manuscript-multi-statement-runtime-guard',
    source: 'rest',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before title', content: 'Before body' },
  });

  assert.equal(
    classifyChapterBodyMutation('INSERT INTO chapters VALUES (?, ?, ...)')?.kind,
    'insert',
  );
  assert.equal(
    classifyChapterBodyMutation('INSERT INTO chapters (id, title) VALUES (?, ?)'),
    null,
  );
  assert.throws(
    () => projectDb.prepare(`
      INSERT INTO chapters VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?
      )
    `).run(
      999, 1, 2, 'Escaped title', '', 'Escaped body', '', 12, 'pending',
      '', '', '', '', '', 0,
    ),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  projectDb
    .prepare('INSERT INTO chapters (id, volume_id, num, title) VALUES (?, ?, ?, ?)')
    .run(1000, 1, 2, 'Metadata-only insert');
  assert.throws(
    () => projectDb.exec(`
      UPDATE chapters SET title = 'Escaped metadata' WHERE id = ${created.chapterId};
      UPDATE chapters SET (content, title) = ('Escaped body', 'Escaped title') WHERE id = ${created.chapterId};
    `),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(created.chapterId),
    { title: 'Before title', content: 'Before body' },
  );
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = 1000').get(),
    { title: 'Metadata-only insert', content: '' },
  );
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = 999').get(), null);
});

test('create authority accepts only the exact single-row ManuscriptService insert shape', async (t) => {
  const { database, projectDb } = await createProject(t, 'manuscript-create-authority-shape');
  const capability = database.manuscriptTransactionCapability;
  const cases = [
    ['short column list', 'INSERT INTO chapters (volume_id, num, content) VALUES (?, ?, ?)', [1, 1, 'Body']],
    ['OR conflict', 'INSERT OR ABORT INTO chapters (volume_id, num, content) VALUES (?, ?, ?)', [1, 2, 'Body']],
    ['replacement without content', 'INSERT OR REPLACE INTO chapters (volume_id, num, title) VALUES (?, ?, ?)', [1, 3, 'Title']],
    ['multiple VALUES tuples', 'INSERT INTO chapters (volume_id, num, content) VALUES (?, ?, ?), (?, ?, ?)', [1, 4, 'Body', 1, 404, 'Escaped']],
    ['SELECT source', 'INSERT INTO chapters (volume_id, num, content) SELECT ?, ?, ?', [1, 5, 'Body']],
    ['upsert', 'INSERT INTO chapters (volume_id, num, content) VALUES (?, ?, ?) ON CONFLICT(volume_id, num) DO UPDATE SET title = excluded.content', [1, 6, 'Body']],
    ['extra statement', "INSERT INTO chapters (volume_id, num, content) VALUES (?, ?, ?); UPDATE chapters SET content = 'Escaped' WHERE id = -1", [1, 7, 'Body']],
  ];

  for (const [name, sql, args] of cases) {
    const chapterNumber = args[1];
    assert.throws(
      () => projectDb.transaction(() => {
        const token = capability.claim('manuscript-create-authority-shape', projectDb, {
          chapterId: null,
          chapterNumber,
          operation: 'create',
          source: 'rest',
          volumeId: 1,
        });
        capability.appendSourceEvent(
          'manuscript-create-authority-shape',
          projectDb,
          token,
          {
            type: 'manuscript.body_mutation.attempt',
            payload: {
              bodyBytes: 4,
              bodySha256: bodyHash('Body'),
              chapterId: null,
              chapterNumber,
              expectedBodySha256: null,
              expectedDataVersion: null,
              operation: 'create',
              source: 'rest',
              version: 1,
              volumeId: 1,
            },
          },
        );
        projectDb.run(sql, args);
      })(),
      (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
      name,
    );
  }
});

test('all public mutations reject missing or forged sources before database side effects', () => {
  const { createManuscriptService } = require('../manuscript-service');
  let opened = 0;
  const service = createManuscriptService({
    getProjectDb() {
      opened += 1;
      throw new Error('database must not be opened');
    },
  });

  for (const mutate of [
    () => service.writeChapterBody({ projectName: 'p', chapterId: 1, content: 'body' }),
    () => service.writeChapterBody({ projectName: 'p', chapterId: 1, content: 'body', source: 'seed' }),
    () => service.appendChapterBody({ projectName: 'p', chapterId: 1, appended: 'more', expectedBodyHash: bodyHash('') }),
    () => service.createChapter({ projectName: 'p', fields: { title: 'Title' }, source: 'user' }),
  ]) {
    assert.throws(mutate, (error) => error.code === 'MANUSCRIPT_SOURCE_INVALID');
  }
  assert.equal(opened, 0);
});

test('all four source families replace bodies with identical bytes, counts, versions, and one publication each', async (t) => {
  const { writeChapterBody } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-source-families');
  const sources = ['rest', 'ai_tool', 'ai_continue', 'revision_accept'];
  const original = 'Original';
  const replacement = '新正文 with spaces\n第二行';

  withRawManuscriptSetup(() => projectDb.transaction(() => {
    const insert = projectDb.prepare(
      "INSERT INTO chapters (volume_id, num, title, content, word_count, status) VALUES (1, ?, ?, ?, ?, 'pending')",
    );
    sources.forEach((source, index) => insert.run(index + 1, source, original, original.length));
  })());
  const journalBefore = projectControlStore(database, 'manuscript-source-families').read();
  const preparedBefore = journalBefore.filter((event) => event.type === 'sqlite.publish.prepared').length;

  for (let index = 0; index < sources.length; index += 1) {
    const result = writeChapterBody({
      projectName: 'manuscript-source-families',
      chapterId: index + 1,
      content: replacement,
      expectedDataVersion: 0,
      source: sources[index],
      status: 'writing',
    });
    assert.equal(result.chapter.content, replacement);
    assert.equal(result.chapter.word_count, replacement.replace(/\s/g, '').length);
  }

  // A clean recovery may install a new connection epoch before the callback;
  // publication count is proven from the journal, not inferred from epochs.
  const journalAfter = projectControlStore(database, 'manuscript-source-families').read();
  assert.equal(
    journalAfter.filter((event) => event.type === 'sqlite.publish.prepared').length,
    preparedBefore + sources.length,
  );
  const stored = projectDb
    .prepare('SELECT content, word_count, status, data_version FROM chapters ORDER BY id')
    .all();
  assert.equal(stored.length, sources.length);
  for (const chapter of stored) {
    assert.deepEqual(chapter, {
      content: replacement,
      word_count: replacement.replace(/\s/g, '').length,
      status: 'writing',
      data_version: 1,
    });
  }

  const events = projectControlStore(database, 'manuscript-source-families').read();
  const sourceEvents = events.filter((event) => event.type === 'manuscript.body_mutation.attempt');
  assert.deepEqual(sourceEvents.map((event) => event.payload.source), sources);
  for (const event of sourceEvents) {
    assert.deepEqual(Object.keys(event.payload).sort(), [
      'bodyBytes',
      'bodySha256',
      'chapterId',
      'chapterNumber',
      'expectedBodySha256',
      'expectedDataVersion',
      'operation',
      'source',
      'version',
      'volumeId',
    ]);
    assert.equal(event.payload.operation, 'replace');
    assert.equal(event.payload.bodyBytes, Buffer.byteLength(replacement, 'utf8'));
    assert.equal(event.payload.bodySha256, bodyHash(replacement));
    assert.equal(event.payload.expectedDataVersion, 0);
    assert.equal(JSON.stringify(event).includes(replacement), false);
    const sourceIndex = events.indexOf(event);
    assert.equal(events[sourceIndex + 1].type, 'sqlite.publish.prepared');
  }
});

test('source append failure is ordered before combined body/metadata mutation and leaves database bytes unchanged', async (t) => {
  const { writeChapterBody } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-source-failure');
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, outline, content, word_count) VALUES (1, 1, 'Before title', 'Before outline', 'Before body', 10)")
    .run());
  const before = fs.readFileSync(database.getProjectDbPath('manuscript-source-failure'));

  await assert.rejects(
    withFaults({
      [FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC]: { throw: 'EIO' },
    }, async () => writeChapterBody({
      projectName: 'manuscript-source-failure',
      chapterId: 1,
      content: 'Never written body',
      source: 'rest',
      title: 'Never written title',
      outline: 'Never written outline',
    })),
    (error) => error.code === 'EIO'
      && error.faultPoint === FAULT_POINTS.CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC,
  );

  assert.deepEqual(
    projectDb.prepare('SELECT title, outline, content FROM chapters WHERE id = 1').get(),
    { title: 'Before title', outline: 'Before outline', content: 'Before body' },
  );
  assert.deepEqual(fs.readFileSync(database.getProjectDbPath('manuscript-source-failure')), before);
  const sourceEvents = projectControlStore(database, 'manuscript-source-failure')
    .read()
    .filter((event) => event.type === 'manuscript.body_mutation.attempt');
  assert.equal(sourceEvents.length, 1, 'the durable attempt may remain after its final fsync reports failure');
});

test('append uses the complete-body SHA-256 CAS and retry never duplicates bytes', async (t) => {
  const { appendChapterBody, writeChapterBody } = require('../manuscript-service');
  const { projectDb } = await createProject(t, 'manuscript-append-cas');
  const original = 'Existing body';
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, content, word_count, status) VALUES (1, 1, 'Chapter', ?, ?, 'pending')")
    .run(original, original.length));

  const expectedBodyHash = bodyHash(original);
  const appended = appendChapterBody({
    projectName: 'manuscript-append-cas',
    chapterId: 1,
    appended: 'Continuation',
    expectedBodyHash,
    source: 'ai_continue',
  });
  assert.equal(appended.chapter.content, 'Existing body\n\nContinuation');
  assert.equal(appended.chapter.status, 'writing');

  const retry = appendChapterBody({
    projectName: 'manuscript-append-cas',
    chapterId: 1,
    appended: 'Continuation',
    expectedBodyHash,
    source: 'ai_continue',
  });
  assert.equal(retry.conflict, true);
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = 1').get().content, 'Existing body\n\nContinuation');

  const current = projectDb.prepare('SELECT data_version FROM chapters WHERE id = 1').get();
  writeChapterBody({
    projectName: 'manuscript-append-cas',
    chapterId: 1,
    content: 'Concurrent replacement',
    expectedDataVersion: current.data_version,
    source: 'rest',
  });
  const stale = appendChapterBody({
    projectName: 'manuscript-append-cas',
    chapterId: 1,
    appended: 'Must not append',
    expectedBodyHash: bodyHash('Existing body\n\nContinuation'),
    source: 'ai_continue',
  });
  assert.equal(stale.conflict, true);
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = 1').get().content, 'Concurrent replacement');
});

test('createChapter preserves explicit numbering, metadata, result identity, and source-safe event shape', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-create');
  const content = 'Created body';
  const title = 'Sensitive title';
  const outline = 'Sensitive outline';
  const result = createChapter({
    projectName: 'manuscript-create',
    source: 'ai_tool',
    fields: {
      volume_id: 1,
      chapter_num: 9,
      title,
      outline,
      content,
      cognitive_frame: 'Frame',
      emotional_anchor: 'Anchor',
      world_texture: 'Texture',
      concrete_mystery: 'Mystery',
      interpersonal_tension: 'Tension',
    },
  });
  assert.equal(result.chapter.id, result.chapterId);
  assert.equal(result.chapter.num, 9);
  assert.equal(result.chapter.content, content);
  assert.equal(result.chapter.word_count, content.replace(/\s/g, '').length);
  assert.equal(result.chapter.status, 'pending');
  assert.deepEqual(
    projectDb.prepare('SELECT title, outline, cognitive_frame, emotional_anchor, world_texture, concrete_mystery, interpersonal_tension FROM chapters WHERE id = ?').get(result.chapterId),
    {
      title,
      outline,
      cognitive_frame: 'Frame',
      emotional_anchor: 'Anchor',
      world_texture: 'Texture',
      concrete_mystery: 'Mystery',
      interpersonal_tension: 'Tension',
    },
  );
  const event = projectControlStore(database, 'manuscript-create')
    .read()
    .findLast((entry) => entry.type === 'manuscript.body_mutation.attempt');
  assert.equal(event.payload.operation, 'create');
  assert.equal(event.payload.chapterId, null);
  assert.equal(event.payload.volumeId, 1);
  assert.equal(event.payload.chapterNumber, 9);
  const serialized = JSON.stringify(event);
  for (const forbidden of [content, title, outline, 'Frame', 'Anchor', 'Texture', 'Mystery', 'Tension']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('private transaction body helper requires active ownership and mints its own one-shot claim', async (t) => {
  const { internals } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-private-token');
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, content) VALUES (1, 1, 'Chapter', 'Before')")
    .run());

  for (const ownershipToken of [undefined, {}, Object.freeze({ id: 'forged' })]) {
    for (const chapterId of [1, 999]) {
      assert.throws(
        () => internals.writeChapterBodyInTransaction({
          projectName: 'manuscript-private-token',
          projectDb,
          ownershipToken,
          chapterId,
          content: 'Must not be written',
          source: 'revision_accept',
        }),
        (error) => error.code === 'MANUSCRIPT_TRANSACTION_REQUIRED',
      );
    }
  }

  const updated = database.runManuscriptTransaction(
    'manuscript-private-token',
    (ownedProjectDb) => internals.writeChapterBodyInTransaction({
      projectName: 'manuscript-private-token',
      projectDb: ownedProjectDb,
      ownershipToken: Object.freeze({ id: 'ignored-forged-proof' }),
      chapterId: 1,
      content: 'Written only by active ownership',
      source: 'revision_accept',
    }),
  );
  assert.equal(updated.content, 'Written only by active ownership');
  assert.equal(
    projectDb.prepare('SELECT content FROM chapters WHERE id = 1').get().content,
    'Written only by active ownership',
  );
});

test('borrowed source append cannot replace the exact transaction claim with forged this', async (t) => {
  const { database, projectDb } = await createProject(t, 'manuscript-borrowed-capability');
  const controlStore = projectControlStore(database, 'manuscript-borrowed-capability');
  const sourceCountBefore = controlStore
    .read()
    .filter((event) => event.type === 'manuscript.body_mutation.attempt').length;
  const forgedOwnership = Object.freeze({
    writeContext: Object.freeze({ assertLease() {} }),
  });
  const event = {
    type: 'manuscript.body_mutation.attempt',
    payload: {
      bodyBytes: 0,
      bodySha256: createHash('sha256').update('').digest('hex'),
      chapterId: 1,
      chapterNumber: null,
      expectedBodySha256: null,
      expectedDataVersion: null,
      operation: 'replace',
      source: 'rest',
      version: 1,
      volumeId: null,
    },
  };

  assert.throws(
    () => database.manuscriptTransactionCapability.appendSourceEvent.call(
      { claim: () => forgedOwnership },
      'manuscript-borrowed-capability',
      projectDb,
      forgedOwnership,
      event,
    ),
    (error) => error.code === 'MANUSCRIPT_TRANSACTION_REQUIRED',
  );
  assert.equal(
    controlStore.read().filter((entry) => entry.type === 'manuscript.body_mutation.attempt').length,
    sourceCountBefore,
  );
});

test('manuscript authorization is one-shot and bound to operation, source, and target chapter', async (t) => {
  const { createChapter } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-one-shot');
  const created = createChapter({
    projectName: 'manuscript-one-shot',
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Chapter', content: 'Before' },
  });
  const capability = database.manuscriptTransactionCapability;
  const eventFor = (source = 'rest', chapterId = created.chapterId) => ({
    type: 'manuscript.body_mutation.attempt',
    payload: {
      bodyBytes: 5,
      bodySha256: bodyHash('After'),
      chapterId,
      chapterNumber: null,
      expectedBodySha256: null,
      expectedDataVersion: null,
      operation: 'replace',
      source,
      version: 1,
      volumeId: null,
    },
  });

  projectDb.transaction(() => {
    const token = capability.claim('manuscript-one-shot', projectDb, {
      chapterId: created.chapterId,
      chapterNumber: null,
      operation: 'replace',
      source: 'rest',
      volumeId: null,
    });
    capability.appendSourceEvent('manuscript-one-shot', projectDb, token, eventFor());
    assert.throws(
      () => capability.appendSourceEvent('manuscript-one-shot', projectDb, token, eventFor()),
      (error) => error.code === 'MANUSCRIPT_TRANSACTION_REQUIRED',
    );

    const wrongSource = capability.claim('manuscript-one-shot', projectDb, {
      chapterId: created.chapterId,
      chapterNumber: null,
      operation: 'replace',
      source: 'rest',
      volumeId: null,
    });
    assert.throws(
      () => capability.appendSourceEvent(
        'manuscript-one-shot',
        projectDb,
        wrongSource,
        eventFor('ai_tool'),
      ),
      (error) => error.code === 'MANUSCRIPT_TRANSACTION_REQUIRED',
    );
    assert.throws(
      () => capability.appendSourceEvent('manuscript-one-shot', projectDb, wrongSource, eventFor()),
      (error) => error.code === 'MANUSCRIPT_TRANSACTION_REQUIRED',
    );

    const wrongTarget = capability.claim('manuscript-one-shot', projectDb, {
      chapterId: created.chapterId,
      chapterNumber: null,
      operation: 'replace',
      source: 'rest',
      volumeId: null,
    });
    assert.throws(
      () => capability.appendSourceEvent(
        'manuscript-one-shot',
        projectDb,
        wrongTarget,
        eventFor('rest', created.chapterId + 1),
      ),
      (error) => error.code === 'MANUSCRIPT_TRANSACTION_REQUIRED',
    );
  })();

  const sibling = createChapter({
    projectName: 'manuscript-one-shot',
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 2, title: 'Sibling', content: 'Sibling before' },
  });
  assert.throws(
    () => projectDb.transaction(() => {
      const widenedTarget = capability.claim('manuscript-one-shot', projectDb, {
        chapterId: created.chapterId,
        chapterNumber: null,
        operation: 'replace',
        source: 'rest',
        volumeId: null,
      });
      capability.appendSourceEvent(
        'manuscript-one-shot',
        projectDb,
        widenedTarget,
        eventFor(),
      );
      projectDb
        .prepare('UPDATE chapters SET content = ? WHERE id = ? OR 1 = 1')
        .run('Escaped target', created.chapterId);
    })(),
    (error) => error.code === 'MANUSCRIPT_SERVICE_REQUIRED',
  );
  assert.deepEqual(
    projectDb.prepare('SELECT id, content FROM chapters ORDER BY id').all(),
    [
      { id: created.chapterId, content: 'Before' },
      { id: sibling.chapterId, content: 'Sibling before' },
    ],
  );
});

test('known unpublished manuscript failure reloads formal state before any later mutation', async (t) => {
  const {
    createChapter,
    isManuscriptPersistenceError,
    writeChapterBody,
  } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-unpublished-discard');
  const created = createChapter({
    projectName: 'manuscript-unpublished-discard',
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before title', content: 'Before body' },
  });
  let primary;
  try {
    await withFaults({
      [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
    }, async () => writeChapterBody({
      projectName: 'manuscript-unpublished-discard',
      chapterId: created.chapterId,
      content: 'Failed body',
      source: 'rest',
      title: 'Failed title',
    }));
  } catch (error) {
    primary = error;
  }
  assert.equal(primary?.code, 'EIO');
  assert.equal(primary?.faultPoint, FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE);
  assert.equal(isManuscriptPersistenceError(primary), true);
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(created.chapterId),
    { title: 'Before title', content: 'Before body' },
  );

  database.projectExecute(
    'manuscript-unpublished-discard',
    'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
    ['after_failure', 1, 2, 'model'],
  );
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(created.chapterId),
    { title: 'Before title', content: 'Before body' },
  );
});

test('uncertain prepared manuscript failure fences every later read and unrelated mutation', async (t) => {
  const {
    createChapter,
    isManuscriptPersistenceError,
    writeChapterBody,
  } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-uncertain-fence');
  const created = createChapter({
    projectName: 'manuscript-uncertain-fence',
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before', content: 'Before body' },
  });
  let primary;
  try {
    await withFaults({
      [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE]: { throw: 'EIO_UNCERTAIN' },
    }, async () => writeChapterBody({
      projectName: 'manuscript-uncertain-fence',
      chapterId: created.chapterId,
      content: 'Uncertain body',
      source: 'rest',
    }));
  } catch (error) {
    primary = error;
  }
  assert.equal(primary?.code, 'EIO_UNCERTAIN');
  assert.equal(primary?.faultPoint, FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_REPLACE);
  assert.equal(isManuscriptPersistenceError(primary), true);
  assert.throws(
    () => projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(created.chapterId),
    (error) => error === primary || error.code === 'RECOVERY_REQUIRED',
  );
  assert.throws(
    () => database.projectExecute(
      'manuscript-uncertain-fence',
      'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
      ['must_not_run', 1, 2, 'model'],
    ),
    (error) => error === primary || error.code === 'RECOVERY_REQUIRED',
  );
  // This test intentionally leaves the wrapper fenced. Discard the test-only
  // process state so the isolated-data-dir cleanup can switch databases.
  projectDb._discard();
});

test('cold-cache public service mutation acquires one physical project lease', async (t) => {
  const { createChapter, writeChapterBody } = require('../manuscript-service');
  const { projectWriteDiagnostics } = require('../testing/database-internals');
  const { database } = await createProject(t, 'manuscript-cold-lease');
  const created = createChapter({
    projectName: 'manuscript-cold-lease',
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Chapter', content: 'Before' },
  });
  const filePath = database.getProjectDbPath('manuscript-cold-lease');
  database.closeProjectDb(filePath);
  const before = projectWriteDiagnostics().leaseAcquisitionCount(filePath);

  const result = writeChapterBody({
    projectName: 'manuscript-cold-lease',
    chapterId: created.chapterId,
    content: 'After',
    source: 'rest',
  });

  assert.equal(result.content, 'After');
  assert.equal(projectWriteDiagnostics().leaseAcquisitionCount(filePath), before + 1);
});

test('external project lease contention records neither source nor body mutation', async (t) => {
  const { writeChapterBody } = require('../manuscript-service');
  const { database, projectDb } = await createProject(t, 'manuscript-lease-contention');
  withRawManuscriptSetup(() => projectDb
    .prepare("INSERT INTO chapters (volume_id, num, title, content) VALUES (1, 1, 'Chapter', 'Before')")
    .run());
  const beforeSourceCount = projectControlStore(database, 'manuscript-lease-contention')
    .read()
    .filter((event) => event.type === 'manuscript.body_mutation.attempt').length;
  const lease = acquireExclusiveLease(projectLeasePath(database, 'manuscript-lease-contention'));
  try {
    assert.throws(
      () => writeChapterBody({
        projectName: 'manuscript-lease-contention',
        chapterId: 1,
        content: 'Must not be written',
        source: 'rest',
      }),
      (error) => error.code === 'PROJECT_WRITE_BUSY',
    );
  } finally {
    lease.release();
  }
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = 1').get().content, 'Before');
  const afterSourceCount = projectControlStore(database, 'manuscript-lease-contention')
    .read()
    .filter((event) => event.type === 'manuscript.body_mutation.attempt').length;
  assert.equal(afterSourceCount, beforeSourceCount);
});
