import assert from 'node:assert/strict'
import test from 'node:test'
import { removeDeletedProject } from '../src/lib/projectDeletion.ts'

const projects = [{ name: 'project-a' }, { name: 'project-b' }, { name: 'project-c' }]

test('deleting the current project synchronously selects only a retained project', () => {
  assert.deepEqual(removeDeletedProject(projects, 'project-a', 'project-a'), {
    projects: [{ name: 'project-b' }, { name: 'project-c' }],
    currentProject: 'project-b',
    deletedCurrentProject: true,
  })
})

test('deleting the final project leaves no reusable deleted-name fallback', () => {
  assert.deepEqual(removeDeletedProject([{ name: 'only-project' }], 'only-project', 'only-project'), {
    projects: [],
    currentProject: null,
    deletedCurrentProject: true,
  })
})

test('deleting a background project does not switch or remove another project', () => {
  assert.deepEqual(removeDeletedProject(projects, 'project-b', 'project-a'), {
    projects: [{ name: 'project-b' }, { name: 'project-c' }],
    currentProject: 'project-b',
    deletedCurrentProject: false,
  })
})
