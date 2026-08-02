import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  TOOL_ENTITY_MAP,
  type ToolEntityName,
  type ToolEntityTargets,
} from '../src/lib/toolEntityMap.ts'

const require = createRequire(import.meta.url)
const { TOOLS } = require('../server/tools.js') as {
  TOOLS: Array<{ function: { name: string } }>
}

function targets(value: ToolEntityTargets | undefined): readonly ToolEntityName[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value as ToolEntityName]
}

test('AI character deletion invalidates character data', () => {
  assert.ok(targets(TOOL_ENTITY_MAP.delete_character).includes('character'))
  assert.ok(targets(TOOL_ENTITY_MAP.delete_character).includes('stats'))
})

test('every mutating server tool has an explicit client invalidation mapping', () => {
  const mutatingPrefixes = ['create_', 'update_', 'delete_', 'set_', 'remove_']
  const mutatingTools = TOOLS.map((tool) => tool.function.name).filter((name) =>
    mutatingPrefixes.some((prefix) => name.startsWith(prefix)),
  )

  assert.deepEqual(
    mutatingTools.filter((name) => targets(TOOL_ENTITY_MAP[name]).length === 0),
    [],
  )
})

test('tool invalidations cover structural chapter changes and dashboard statistics', () => {
  for (const name of ['create_volume', 'update_volume', 'delete_volume']) {
    assert.ok(targets(TOOL_ENTITY_MAP[name]).includes('chapter'), `${name} must refresh chapters`)
  }

  for (const name of [
    'create_chapter',
    'update_chapter',
    'delete_chapter',
    'create_volume',
    'update_volume',
    'delete_volume',
    'create_character',
    'delete_character',
    'create_world_entry',
    'delete_world_entry',
    'create_science_entry',
    'delete_science_entry',
    'create_foreshadow',
    'update_foreshadow',
    'delete_foreshadow',
    'create_relation',
    'delete_relation',
    'create_memory',
    'delete_memory',
    'create_timeline_event',
    'delete_timeline_event',
    'create_clue',
    'update_clue',
    'delete_clue',
  ]) {
    assert.ok(targets(TOOL_ENTITY_MAP[name]).includes('stats'), `${name} must refresh stats`)
  }
})

test('chapter writes invalidate joined and foreign-key-cascaded client data', () => {
  assert.ok(targets(TOOL_ENTITY_MAP.update_chapter).includes('character'))

  for (const name of ['delete_chapter', 'delete_volume']) {
    assert.ok(targets(TOOL_ENTITY_MAP[name]).includes('character'), `${name} must refresh appearances`)
    assert.ok(targets(TOOL_ENTITY_MAP[name]).includes('memory'), `${name} must refresh cleared memory sources`)
  }
})
