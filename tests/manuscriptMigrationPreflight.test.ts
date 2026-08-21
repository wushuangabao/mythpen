import assert from 'node:assert/strict'
import test from 'node:test'
import {
  discardProjectEditorSaves,
  enqueueEditorSave,
} from '../src/lib/editorSaveQueue.ts'
import {
  beginFilesBetaMigration,
  inspectFilesBetaMigrationPreflight,
  FilesBetaMigrationBlockedError,
} from '../src/lib/manuscriptMigrationPreflight.ts'
import {
  discardProjectTitleSaves,
  stageTitleSave,
} from '../src/lib/titleSaveQueue.ts'

test('files Beta migration calls the API only when every local draft queue is empty', async () => {
  const cleanProject = 'migration-clean-project'
  let migrations = 0
  const cleanResult = await beginFilesBetaMigration(cleanProject, async () => {
    migrations += 1
    return { state: 'activated' }
  })
  assert.deepEqual(cleanResult, { state: 'activated' })
  assert.equal(migrations, 1)

  const cases = [
    {
      project: 'migration-body-dirty',
      stage() {
        enqueueEditorSave(this.project, 1, 1, '未保存正文', 0)
      },
      cleanup() {
        discardProjectEditorSaves(this.project)
      },
      expected: { bodyDrafts: 1, titleDrafts: 0 },
    },
    {
      project: 'migration-title-dirty',
      stage() {
        stageTitleSave(this.project, 2, 2, '未保存标题')
      },
      cleanup() {
        discardProjectTitleSaves(this.project)
      },
      expected: { bodyDrafts: 0, titleDrafts: 1 },
    },
  ]

  for (const scenario of cases) {
    try {
      scenario.stage()
      assert.deepEqual(inspectFilesBetaMigrationPreflight(scenario.project), {
        canMigrate: false,
        ...scenario.expected,
      })
      await assert.rejects(
        beginFilesBetaMigration(scenario.project, async () => {
          migrations += 1
          return { state: 'activated' }
        }),
        FilesBetaMigrationBlockedError,
      )
      assert.equal(migrations, 1, scenario.project)
    } finally {
      scenario.cleanup()
    }
  }
})
