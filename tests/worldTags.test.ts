import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorldTags, serializeWorldTags } from '../src/lib/worldTags.ts'

test('parseWorldTags converts persisted JSON and legacy comma-separated tags into normalized arrays', () => {
  assert.deepEqual(parseWorldTags('["critical", "city"]'), ['critical', 'city'])
  assert.deepEqual(parseWorldTags('critical， city, critical'), ['critical', 'city'])
  assert.deepEqual(parseWorldTags([' city ', '', 'city', 1]), ['city'])
  assert.deepEqual(parseWorldTags(null), [])
})

test('serializeWorldTags persists a normalized JSON tag array', () => {
  assert.equal(serializeWorldTags(['city', ' city ', '']), '["city"]')
})
