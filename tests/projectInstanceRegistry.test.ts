import assert from 'node:assert/strict'
import test from 'node:test'
import {
  forgetProjectInstance,
  getProjectInstanceHeaders,
  PROJECT_INSTANCE_HEADER,
  rememberProjectInstance,
  replaceProjectInstances,
} from '../src/lib/projectInstanceRegistry.ts'

test('project instance headers rotate when a name is deleted and recreated', () => {
  replaceProjectInstances([{ name: 'same-name', instanceId: 'old-instance' }])
  assert.deepEqual(getProjectInstanceHeaders('same-name'), {
    [PROJECT_INSTANCE_HEADER]: 'old-instance',
  })

  forgetProjectInstance('same-name')
  assert.deepEqual(getProjectInstanceHeaders('same-name'), {})

  rememberProjectInstance('same-name', 'new-instance')
  assert.deepEqual(getProjectInstanceHeaders('same-name'), {
    [PROJECT_INSTANCE_HEADER]: 'new-instance',
  })
  forgetProjectInstance('same-name')
})

test('authoritative project lists remove tokens for projects no longer present', () => {
  rememberProjectInstance('removed', 'stale')
  const changes = replaceProjectInstances([{ name: 'retained', instanceId: 'current' }])
  assert.deepEqual(getProjectInstanceHeaders('removed'), {})
  assert.deepEqual(changes, [{ project: 'removed', previousInstanceId: 'stale' }])
  assert.deepEqual(getProjectInstanceHeaders('retained'), {
    [PROJECT_INSTANCE_HEADER]: 'current',
  })
})

test('a fallback list row cannot downgrade a known project to headerless requests', () => {
  rememberProjectInstance('temporarily-unreadable', 'last-known-instance')

  replaceProjectInstances([{ name: 'temporarily-unreadable', instanceId: '' }])

  assert.deepEqual(getProjectInstanceHeaders('temporarily-unreadable'), {
    [PROJECT_INSTANCE_HEADER]: 'last-known-instance',
  })
  forgetProjectInstance('temporarily-unreadable')
})

test('an authoritative same-name token rotation is reported to state owners', () => {
  rememberProjectInstance('reused-name', 'instance-a')
  const changes = replaceProjectInstances([{ name: 'reused-name', instanceId: 'instance-b' }])

  assert.deepEqual(changes, [
    { project: 'reused-name', previousInstanceId: 'instance-a', currentInstanceId: 'instance-b' },
  ])
  forgetProjectInstance('reused-name')
})

test('a direct create response reports a same-name token rotation', () => {
  rememberProjectInstance('directly-recreated', 'instance-a')

  const change = rememberProjectInstance('directly-recreated', 'instance-b')

  assert.deepEqual(change, {
    project: 'directly-recreated',
    previousInstanceId: 'instance-a',
    currentInstanceId: 'instance-b',
  })
  assert.deepEqual(getProjectInstanceHeaders('directly-recreated'), {
    [PROJECT_INSTANCE_HEADER]: 'instance-b',
  })
  forgetProjectInstance('directly-recreated')
})
