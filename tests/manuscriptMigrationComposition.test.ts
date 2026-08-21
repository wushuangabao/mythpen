import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  discardProjectEditorSaves,
  enqueueEditorSave,
  flushEditorSave,
} from '../src/lib/editorSaveQueue.ts'
import { productionManuscriptMigration } from '../src/lib/manuscriptMigrationComposition.ts'

test('ProjectList has one coordinator-owned migration entry and no legacy/direct migration bypass', () => {
  const source = readFileSync(new URL('../src/pages/ProjectList.tsx', import.meta.url), 'utf8')
  assert.match(source, /productionManuscriptMigration\.beginPreflight/u)
  assert.match(source, /productionManuscriptMigration\.confirm/u)
  assert.doesNotMatch(source, /beginFilesBetaMigration|inspectFilesBetaMigrationPreflight/u)
  assert.doesNotMatch(source, /projectsApi\.migrateFilesBeta/u)
})

test('production migration composition owns the coordinator and delegates its sole API crossing', () => {
  const source = readFileSync(new URL('../src/lib/manuscriptMigrationComposition.ts', import.meta.url), 'utf8')
  assert.match(source, /new HostMigrationPreflightCoordinator/u)
  assert.match(source, /projectsApi\.migrateFilesBeta/u)
  assert.doesNotMatch(source, /beginFilesBetaMigration|manuscriptMigrationPreflight/u)
})

test('production preflight keeps a successfully drained body snapshot stable and persisted', async () => {
  const projectName = 'composition-drained-success'
  const projectInstanceId = '11111111-1111-4111-8111-111111111111'
  let resolveWrite!: () => void
  const write = new Promise<void>((resolve) => { resolveWrite = resolve })
  let writes = 0

  try {
    enqueueEditorSave(projectName, 101, 1, 'persist before migration', 0)
    const save = flushEditorSave(projectName, 101, () => {
      writes += 1
      return write
    })
    while (writes === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    const pendingPreflight = productionManuscriptMigration.beginPreflight({ projectName, projectInstanceId })
    resolveWrite()
    await save
    const preflight = await pendingPreflight
    assert.equal(preflight.bodyDrafts, 1)
    assert.equal(preflight.canMigrate, true)
    await productionManuscriptMigration.cancel(preflight)
  } finally {
    discardProjectEditorSaves(projectName)
  }
})

test('production preflight keeps an unpersisted body draft unresolved and blocks confirmation', async () => {
  const projectName = 'composition-unresolved-draft'
  const projectInstanceId = '22222222-2222-4222-8222-222222222222'

  try {
    enqueueEditorSave(projectName, 202, 2, 'still local', 0)
    const preflight = await productionManuscriptMigration.beginPreflight({ projectName, projectInstanceId })
    assert.equal(preflight.bodyDrafts, 1)
    assert.equal(preflight.canMigrate, false)
    await productionManuscriptMigration.cancel(preflight)
  } finally {
    discardProjectEditorSaves(projectName)
  }
})
