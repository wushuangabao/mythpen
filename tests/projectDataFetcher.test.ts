import assert from 'node:assert/strict'
import test from 'node:test'
import { createProjectDataFetcher, projectDataDependencyKey } from '../src/lib/projectDataScope.ts'
import { forgetProjectInstance, rememberProjectInstance } from '../src/lib/projectInstanceRegistry.ts'

test('an inactive project scope cannot issue a project data request', () => {
  let calls = 0
  const fetcher = createProjectDataFetcher('', async () => {
    calls++
    return 'unexpected'
  })

  assert.equal(fetcher, null)
  assert.equal(calls, 0)
})

test('an active project scope binds the exact project name', async () => {
  const projects: string[] = []
  const fetcher = createProjectDataFetcher('active-project', async (project) => {
    projects.push(project)
    return 'loaded'
  })

  assert.ok(fetcher)
  assert.equal(await fetcher(), 'loaded')
  assert.deepEqual(projects, ['active-project'])
})

test('project data dependencies rotate when a same-name instance changes', () => {
  assert.notEqual(projectDataDependencyKey('same', 'instance-a'), projectDataDependencyKey('same', 'instance-b'))
  assert.notEqual(
    projectDataDependencyKey('same', 'instance-a', 'filter-a'),
    projectDataDependencyKey('same', 'instance-a', 'filter-b'),
  )
})

test('a response captured from an old same-name instance is rejected before commit', async () => {
  const project = 'scoped-response'
  rememberProjectInstance(project, 'instance-a')
  let release!: (value: string) => void
  const response = new Promise<string>((resolve) => {
    release = resolve
  })
  const fetcher = createProjectDataFetcher(project, () => response, 'instance-a')
  assert.ok(fetcher)

  const request = fetcher()
  rememberProjectInstance(project, 'instance-b')
  release('old data')
  await assert.rejects(request, { name: 'ProjectDataSupersededError' })
  forgetProjectInstance(project)
})
