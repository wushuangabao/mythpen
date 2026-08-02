import assert from 'node:assert/strict'
import test from 'node:test'
import {
  initializeProjectCacheValue,
  projectInstanceCacheKey,
  setProjectCacheValue,
} from '../src/lib/projectCache.ts'

test('a failed A refresh after A -> B -> A keeps A last successful menu', () => {
  let cache = new Map<string, string[]>()
  cache = setProjectCacheValue(cache, 'project-a', ['writing', 'characters'])
  cache = setProjectCacheValue(cache, 'project-b', ['writing', 'timeline'])

  const afterFailedReturn = initializeProjectCacheValue(cache, 'project-a', [])

  assert.strictEqual(afterFailedReturn, cache)
  assert.deepEqual(afterFailedReturn.get('project-a'), ['writing', 'characters'])
  assert.deepEqual(afterFailedReturn.get('project-b'), ['writing', 'timeline'])
})

test('a first-load failure initialises only the missing project with an empty menu', () => {
  const cache = setProjectCacheValue(new Map<string, string[]>(), 'project-a', ['writing'])
  const afterFailure = initializeProjectCacheValue(cache, 'project-b', [])

  assert.deepEqual(afterFailure.get('project-a'), ['writing'])
  assert.deepEqual(afterFailure.get('project-b'), [])
})

test('a same-name replacement cannot reuse the deleted instance menu after its first refresh fails', () => {
  const oldKey = projectInstanceCacheKey('same-name', 'old-instance')
  const replacementKey = projectInstanceCacheKey('same-name', 'replacement-instance')
  assert.ok(oldKey)
  assert.ok(replacementKey)
  assert.notEqual(replacementKey, oldKey)

  const oldCache = setProjectCacheValue(new Map<string, string[]>(), oldKey, ['old-menu'])
  const afterReplacementFailure = initializeProjectCacheValue(oldCache, replacementKey, [])

  assert.deepEqual(afterReplacementFailure.get(oldKey), ['old-menu'])
  assert.deepEqual(afterReplacementFailure.get(replacementKey), [])
})

test('unknown project metadata has no reusable sidebar cache key', () => {
  assert.equal(projectInstanceCacheKey('same-name', undefined), null)
  assert.equal(projectInstanceCacheKey('same-name', ''), null)
  assert.equal(projectInstanceCacheKey(null, 'instance'), null)
})
