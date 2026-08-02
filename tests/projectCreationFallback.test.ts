import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProjectFallbackSummary,
  upsertProjectFallback,
} from '../src/lib/projectCreationFallback.ts'

test('a successful create response leaves a complete reactive row when the follow-up list fails', async () => {
  const created = createProjectFallbackSummary(
    'created-project',
    {
      name: 'created-project',
      mode: 'long-novel',
      genres: ['fantasy'],
      instanceId: 'created-instance',
    },
    { mode: 'medium-novel', genres: ['other'] },
    '2026-08-02T00:00:00.000Z',
  )
  let projects = upsertProjectFallback([], created)

  // loadProjects intentionally catches transport failures. Its failure must
  // not roll back the row established from the successful create response.
  await Promise.reject(new Error('list unavailable')).catch(() => {})

  assert.equal(projects.length, 1)
  assert.equal(projects[0]?.name, 'created-project')
  assert.equal(projects[0]?.instanceId, 'created-instance')
  assert.equal(projects[0]?.mode, 'long-novel')

  projects = upsertProjectFallback(projects, { ...created, chapterCount: 1 })
  assert.equal(projects.length, 1)
  assert.equal(projects[0]?.chapterCount, 1)
})
