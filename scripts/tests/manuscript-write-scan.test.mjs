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
    'server/manuscript-service.js': "db.prepare('UPDATE chapters SET content = ? WHERE id = ?')\n",
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
    { file: 'server/routes/api.js', line: 1, kind: 'update-content' },
    { file: 'server/tools.js', line: 1, kind: 'update-content' },
  ])
})

test('static scanner reports no unexpected production manuscript writes', () => {
  assert.deepEqual(scanManuscriptWriteBoundary({ repositoryRoot }), [])
})
