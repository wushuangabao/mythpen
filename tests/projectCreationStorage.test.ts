import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProjectForStorage,
  DEFAULT_PROJECT_STORAGE,
  initialChapterForStorage,
} from '../src/lib/projectCreationStorage.ts'

test('SQLite stays default while files Beta uses the explicit creation endpoint and activated instance', async () => {
  assert.equal(DEFAULT_PROJECT_STORAGE, 'sqlite')
  const calls: string[] = []
  const gateway = {
    async create(input: Record<string, unknown>) {
      calls.push(`sqlite:${input.name}`)
      return { instanceId: 'sqlite-instance', ...input }
    },
    async createFilesBeta(input: Record<string, unknown>) {
      calls.push(`files:${input.name}`)
      return { state: 'activated', projectUid: 'files-project', ...input }
    },
    async getFilesBetaStatus(name: string) {
      calls.push(`status:${name}`)
      return {
        route: 'files' as const,
        project_uid: 'files-project',
        project_instance_id: 'files-instance',
      }
    },
  }
  const input = {
    name: 'Beta book',
    mode: 'medium-novel',
    language: 'zh',
    genres: ['fantasy'],
  }

  assert.equal((await createProjectForStorage(gateway, 'sqlite', input)).instanceId, 'sqlite-instance')
  assert.equal((await createProjectForStorage(gateway, 'files-beta', input)).instanceId, 'files-instance')
  assert.deepEqual(initialChapterForStorage('sqlite', 'First chapter'), { title: 'First chapter' })
  assert.deepEqual(initialChapterForStorage('files-beta', 'First chapter'), {
    title: 'First chapter',
    volume_id: null,
  })
  assert.deepEqual(calls, ['sqlite:Beta book', 'files:Beta book', 'status:Beta book'])
})
