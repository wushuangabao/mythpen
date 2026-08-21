import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { scanManuscriptWriteBoundary } from '../manuscript-write-scan.mjs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function fixtureRepository(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'mythpen-manuscript-scan-'))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  for (const [relativePath, source] of Object.entries(files)) {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  return root
}

test('static scanner is independent from the runtime classifier and database modules', () => {
  const scannerSource = readFileSync(
    join(repositoryRoot, 'scripts', 'manuscript-write-scan.mjs'),
    'utf8',
  )
  const legacyTestSource = readFileSync(
    join(repositoryRoot, 'server', 'tests', 'manuscript-service.test.js'),
    'utf8',
  )

  assert.doesNotMatch(scannerSource, /manuscript-sql-guard|(?:from|require\s*\()\s*['"][^'"]*server\/db/)
  const legacyScannerBody = /function directBodySqlKind\([\s\S]*?\n}\n\nfunction scanSource/.exec(
    legacyTestSource,
  )?.[0]
  assert.ok(legacyScannerBody)
  assert.doesNotMatch(legacyScannerBody, /classifyChapterBodyMutation\(/)
})

test('static scanner catches structural chapter write evasions', (t) => {
  const root = fixtureRepository(t, {
    'server/routes/01-row-update.js': "db.prepare('UPDATE chapters SET (content, title) = (?, ?) WHERE id = ?')\n",
    'server/routes/02-row-upsert.js': "db.prepare('INSERT INTO chapters (id, title) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET (content, title) = (excluded.title, excluded.title)')\n",
    'server/routes/03-columnless.js': "db.prepare('INSERT INTO chapters VALUES (?, ?, ...)')\n",
    'server/routes/04-quoted-cte.js': "db.prepare('WITH chosen AS (SELECT 1) UPDATE /* guard */ main.\"chapters\" SET (\"content\", title) = (?, ?) WHERE id = ?')\n",
    'server/routes/05-malformed.js': "db.prepare('UPDATE chapters SET (title, outline = (?, ?) WHERE id = ?')\n",
    'server/routes/06-later-statement.js': "db.exec('UPDATE chapters SET title = ? WHERE id = ?; UPDATE chapters SET (content, title) = (?, ?) WHERE id = ?')\n",
    'server/routes/07-quoted-boundaries.js': [
      'db.exec(\'UPDATE chapters SET title = "where", content = ? WHERE id = ?\')',
      'db.exec(\'UPDATE chapters SET title = "returning", content = ? WHERE id = ?\')',
      'db.exec(\'UPDATE chapters SET title = "from", content = ? WHERE id = ?\')',
    ].join('\n'),
    'server/routes/08-multi-arm-upsert.js': "db.exec('INSERT INTO chapters (id, volume_id, num, title) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING ON CONFLICT DO UPDATE SET content = ?')\n",
    'server/routes/metadata-only.js': [
      "db.prepare('UPDATE chapters SET (title, outline) = (?, ?) WHERE id = ?')",
      "db.prepare('INSERT INTO chapters (id, title) VALUES (?, ?)')",
      "db.prepare('UPDATE chapters SET title = CASE WHEN content = ? THEN ? ELSE title END WHERE id = ?')",
    ].join('\n'),
    'server/tests/ignored.test.js': "db.prepare('UPDATE chapters SET content = ? WHERE id = ?')\n",
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/routes/01-row-update.js', line: 1, kind: 'update-content' },
    { file: 'server/routes/02-row-upsert.js', line: 1, kind: 'upsert-content' },
    { file: 'server/routes/03-columnless.js', line: 1, kind: 'insert-content' },
    { file: 'server/routes/04-quoted-cte.js', line: 1, kind: 'update-content' },
    { file: 'server/routes/05-malformed.js', line: 1, kind: 'unknown-protected-write' },
    { file: 'server/routes/06-later-statement.js', line: 1, kind: 'update-content' },
    { file: 'server/routes/07-quoted-boundaries.js', line: 1, kind: 'update-content' },
    { file: 'server/routes/07-quoted-boundaries.js', line: 2, kind: 'update-content' },
    { file: 'server/routes/07-quoted-boundaries.js', line: 3, kind: 'update-content' },
    { file: 'server/routes/08-multi-arm-upsert.js', line: 1, kind: 'upsert-content' },
    { file: 'server/routes/metadata-only.js', line: 1, kind: 'article-truth-write' },
    { file: 'server/routes/metadata-only.js', line: 2, kind: 'article-truth-write' },
    { file: 'server/routes/metadata-only.js', line: 3, kind: 'article-truth-write' },
  ])
})

test('static scanner follows dynamic assignment builders, aliases, and quoted keys', (t) => {
  const root = fixtureRepository(t, {
    'server/routes/dynamic.js': [
      'const directAssignments = []',
      'const assignmentAlias = directAssignments',
      "assignmentAlias.push('content = ?')",
      "db.prepare(`UPDATE chapters SET ${directAssignments.join(', ')} WHERE id = ?`)",
      "const allowed = ['title', 'content']",
      'const quotedAssignments = []',
      'for (const key of allowed) quotedAssignments.push(`"${key}" = ?`)',
      "db.prepare(`UPDATE chapters SET ${quotedAssignments.join(', ')} WHERE id = ?`)",
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/routes/dynamic.js', line: 4, kind: 'dynamic-update-content' },
    { file: 'server/routes/dynamic.js', line: 8, kind: 'dynamic-update-content' },
  ])
})

test('static scanner applies only the exact owner, migration, and seed exclusions', (t) => {
  const root = fixtureRepository(t, {
    'server/manuscript-service.js': [
      'function writeChapterBodyInTransaction(db) {',
      "  db.prepare('UPDATE chapters SET content = ? WHERE id = ?')",
      '}',
      'function unrelatedServiceWrite(db) {',
      "  db.prepare('UPDATE chapters SET content = ? WHERE id = ?')",
      '}',
    ].join('\n'),
    'server/seed.js': "db.prepare('INSERT INTO chapters (id, content) VALUES (?, ?)')\n",
    'server/db.js': [
      'function normalizeLegacyChapterContent(db) {',
      '  db.prepare("UPDATE chapters SET content = \'\' WHERE content IS NULL").run()',
      '}',
      'function unrelatedRuntimeWrite(db) {',
      '  db.prepare("UPDATE chapters SET content = \'\' WHERE content IS NULL").run()',
      '}',
    ].join('\n'),
    'server/routes/api.js': "db.prepare('UPDATE chapters SET content = ? WHERE id = ?')\n",
    'server/tools.js': "db.prepare('UPDATE chapters SET content = ? WHERE id = ?')\n",
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/db.js', line: 5, kind: 'update-content' },
    { file: 'server/manuscript-service.js', line: 5, kind: 'update-content' },
    { file: 'server/routes/api.js', line: 1, kind: 'update-content' },
    { file: 'server/tools.js', line: 1, kind: 'update-content' },
  ])
})

test('static scanner catches every files-authority product bypass family', (t) => {
  const root = fixtureRepository(t, {
    'server/routes/article-truth.js': [
      "db.prepare('UPDATE chapters SET title = ? WHERE id = ?')",
      "db.prepare('INSERT INTO volumes (title) VALUES (?)')",
      "db.prepare('DELETE FROM chapters WHERE id = ?')",
    ].join('\n'),
    'server/routes/legacy-position.js': [
      "db.prepare('SELECT COALESCE(MAX(num), 0) FROM chapters')",
      "db.prepare('SELECT expected_resolve_chapter FROM foreshadows')",
    ].join('\n'),
    'server/routes/read-bypass.js': [
      "db.prepare('SELECT id, title FROM chapters ORDER BY num')",
      "db.prepare('SELECT id, title FROM volumes ORDER BY sort_order')",
    ].join('\n'),
    'server/routes/caller-path.js': [
      "publishGeneratedProjectFile({ finalPath: req.body.outputPath, content: 'x' })",
      "publishOpaqueDiagnosticsExport({ exportDir: ownedExportDir, diagnostics })",
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/routes/article-truth.js', line: 1, kind: 'article-truth-write' },
    { file: 'server/routes/article-truth.js', line: 2, kind: 'article-truth-write' },
    { file: 'server/routes/article-truth.js', line: 3, kind: 'physical-delete' },
    { file: 'server/routes/caller-path.js', line: 1, kind: 'caller-controlled-path' },
    { file: 'server/routes/legacy-position.js', line: 1, kind: 'legacy-max-num' },
    { file: 'server/routes/legacy-position.js', line: 2, kind: 'legacy-expected-resolve-chapter' },
    { file: 'server/routes/read-bypass.js', line: 1, kind: 'freshness-bypass-read' },
    { file: 'server/routes/read-bypass.js', line: 2, kind: 'freshness-bypass-read' },
  ])
})

test('static scanner grants the production stats read only to its exact admitted owner', (t) => {
  const root = fixtureRepository(t, {
    'server/manuscript/production-runtime.js': [
      'function statsView(db) {',
      "  return db.prepare('SELECT chapter_uid, updated_at FROM chapters WHERE is_present = 1').all()",
      '}',
      'function unrelatedRead(db) {',
      "  return db.prepare('SELECT chapter_uid, updated_at FROM chapters WHERE is_present = 1').all()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/manuscript/production-runtime.js', line: 5, kind: 'freshness-bypass-read' },
  ])
})

test('static scanner grants revision resolution SQL only to its exact admitted publishers', (t) => {
  const root = fixtureRepository(t, {
    'server/manuscript/production-runtime.js': [
      'function publishRevisionResolution(db) {',
      "  return db.prepare('SELECT c.chapter_uid FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id WHERE r.id = ?').get()",
      '}',
      'function readCommittedRevisionResolution(db) {',
      "  return db.prepare('SELECT c.chapter_uid FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id WHERE r.id = ?').get()",
      '}',
      'function publish(db) {',
      "  return db.prepare('SELECT c.chapter_uid FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id WHERE r.id = ?').get()",
      '}',
      'function revisionResolutionRow(db) {',
      "  return db.prepare('SELECT c.chapter_uid FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id WHERE r.id = ?').get()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/manuscript/production-runtime.js', line: 8, kind: 'freshness-bypass-read' },
    { file: 'server/manuscript/production-runtime.js', line: 11, kind: 'freshness-bypass-read' },
  ])
})

test('static scanner grants legacy tool SQL only to the four exact SQLite owners', (t) => {
  const root = fixtureRepository(t, {
    'server/tools.js': [
      'function executeLegacySqliteTool(db) {',
      "  return db.prepare('SELECT id, title FROM chapters ORDER BY num').all()",
      '}',
      'function executeLegacySqliteResolveChapter(db) {',
      "  return db.prepare('SELECT expected_resolve_chapter FROM foreshadows').all()",
      '}',
      'function executeLegacySqliteUpdateById(db) {',
      "  return db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run()",
      '}',
      'function executeLegacySqliteDeleteById(db) {',
      "  return db.prepare('DELETE FROM chapters WHERE id = ?').run()",
      '}',
      'function unrelatedTool(db) {',
      "  db.prepare('SELECT id, title FROM chapters ORDER BY num').all()",
      "  db.prepare('SELECT expected_resolve_chapter FROM foreshadows').all()",
      "  db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run()",
      "  db.prepare('DELETE FROM chapters WHERE id = ?').run()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/tools.js', line: 14, kind: 'freshness-bypass-read' },
    { file: 'server/tools.js', line: 15, kind: 'legacy-expected-resolve-chapter' },
    { file: 'server/tools.js', line: 16, kind: 'article-truth-write' },
    { file: 'server/tools.js', line: 17, kind: 'physical-delete' },
  ])
})

test('static scanner grants recent-project SQL only to the exact legacy reader', (t) => {
  const root = fixtureRepository(t, {
    'server/recent-projects.js': [
      'function readLegacyRecentProject(db) {',
      "  return db.prepare('SELECT COUNT(*) AS c FROM chapters').get()",
      '}',
      'function unrelatedRecentReader(db) {',
      "  return db.prepare('SELECT COUNT(*) AS c FROM chapters').get()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/recent-projects.js', line: 5, kind: 'freshness-bypass-read' },
  ])
})

test('static scanner grants the AI chapter SQL fallback only to its exact route-aware owner', (t) => {
  const root = fixtureRepository(t, {
    'server/index.js': [
      'function readAiChapter(db) {',
      "  return db.prepare('SELECT * FROM chapters WHERE id = ?').get()",
      '}',
      'function unrelatedAiRead(db) {',
      "  return db.prepare('SELECT * FROM chapters WHERE id = ?').get()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/index.js', line: 5, kind: 'freshness-bypass-read' },
  ])
})

test('static scanner grants revision basis reads only to the native auxiliary owner', (t) => {
  const root = fixtureRepository(t, {
    'server/native/native-project-store.js': [
      'function currentAuxiliaryChapter(db) {',
      "  return db.prepare('SELECT id, content FROM chapters WHERE id = ?').get()",
      '}',
      'function unrelatedAuxiliaryRead(db) {',
      "  return db.prepare('SELECT id, content FROM chapters WHERE id = ?').get()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/native/native-project-store.js', line: 5, kind: 'freshness-bypass-read' },
  ])
})

test('static scanner grants legacy revision SQL only to exact revision owners', (t) => {
  const root = fixtureRepository(t, {
    'server/chapter-revisions.js': [
      'function getPendingRevision(db) {',
      "  return db.prepare('SELECT * FROM chapter_revisions JOIN chapters ON chapters.id = chapter_revisions.chapter_id').get()",
      '}',
      'function createPendingRevision(db) {',
      "  return db.prepare('UPDATE chapters SET status = ? WHERE id = ?').run()",
      '}',
      'function applyRevision() {',
      '  const applyInTransaction = (db) => {',
      "    db.prepare('UPDATE chapters SET status = ? WHERE id = ?').run()",
      '  }',
      '  return applyInTransaction',
      '}',
      'function unrelatedRevisionRead(db) {',
      "  return db.prepare('SELECT * FROM chapter_revisions JOIN chapters ON chapters.id = chapter_revisions.chapter_id').get()",
      '}',
      'function unrelatedRevisionWrite(db) {',
      "  return db.prepare('UPDATE chapters SET status = ? WHERE id = ?').run()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/chapter-revisions.js', line: 14, kind: 'freshness-bypass-read' },
    { file: 'server/chapter-revisions.js', line: 17, kind: 'article-truth-write' },
  ])
})

test('static scanner grants legacy REST SQL only to exact SQLite route owners', (t) => {
  const root = fixtureRepository(t, {
    'server/routes/api.js': [
      'function createLegacySqliteProject(db) {',
      "  return db.prepare('INSERT INTO volumes (title) VALUES (?)').run()",
      '}',
      'function listLegacySqliteChapters(db) {',
      "  return db.prepare('SELECT id, title FROM chapters ORDER BY num').all()",
      '}',
      'function readLegacySqliteChapter(db) {',
      "  return db.prepare('SELECT id FROM chapters WHERE id = ?').get()",
      '}',
      'function resolveLegacySqliteChapter(db) {',
      "  return db.prepare('SELECT id FROM chapters WHERE num = ?').all()",
      '}',
      'function updateLegacySqliteChapter(db) {',
      "  return db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run()",
      '}',
      'function createLegacySqliteChapter(db) {',
      "  return db.prepare('INSERT INTO chapters (title) VALUES (?)').run()",
      '}',
      'function deleteLegacySqliteChapter(db) {',
      "  return db.prepare('DELETE FROM chapters WHERE id = ?').run()",
      '}',
      'function listLegacySqliteVolumes(db) {',
      "  return db.prepare('SELECT id, title FROM volumes ORDER BY sort_order').all()",
      '}',
      'function createLegacySqliteVolume(db) {',
      "  return db.prepare('INSERT INTO volumes (title) VALUES (?)').run()",
      '}',
      'function updateLegacySqliteVolume(db) {',
      "  return db.prepare('UPDATE volumes SET title = ? WHERE id = ?').run()",
      '}',
      'function deleteLegacySqliteVolume(db) {',
      "  return db.prepare('DELETE FROM volumes WHERE id = ?').run()",
      '}',
      'function readLegacySqliteCharacterAssociations(db) {',
      "  return db.prepare('SELECT chapters.id FROM chapters JOIN chapter_characters ON chapters.id = chapter_characters.chapter_id').all()",
      '}',
      'function createLegacySqliteForeshadow(db) {',
      "  return db.prepare('INSERT INTO foreshadows (expected_resolve_chapter) VALUES (?)').run()",
      '}',
      'function readLegacySqliteStats(db) {',
      "  return db.prepare('SELECT COALESCE(MAX(num), 0) FROM chapters').get()",
      '}',
      'function readLegacySqliteExportSnapshot(db) {',
      "  return db.prepare('SELECT id, title FROM chapters ORDER BY num').all()",
      '}',
      'function unrelatedRoute(db) {',
      "  db.prepare('SELECT id, title FROM chapters ORDER BY num').all()",
      "  db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run()",
      "  db.prepare('DELETE FROM volumes WHERE id = ?').run()",
      "  db.prepare('SELECT COALESCE(MAX(num), 0) FROM chapters').get()",
      "  db.prepare('SELECT expected_resolve_chapter FROM foreshadows').all()",
      '}',
    ].join('\n'),
  })

  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot: root }), [
    { file: 'server/routes/api.js', line: 47, kind: 'freshness-bypass-read' },
    { file: 'server/routes/api.js', line: 48, kind: 'article-truth-write' },
    { file: 'server/routes/api.js', line: 49, kind: 'physical-delete' },
    { file: 'server/routes/api.js', line: 50, kind: 'legacy-max-num' },
    { file: 'server/routes/api.js', line: 51, kind: 'legacy-expected-resolve-chapter' },
  ])
})

test('static scanner reports no unexpected production manuscript writes', () => {
  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot }), [])
})
