export type ToolEntityName =
  | 'chapter'
  | 'volume'
  | 'character'
  | 'world'
  | 'science'
  | 'foreshadow'
  | 'relation'
  | 'memory'
  | 'timeline'
  | 'stats'
  | 'project'
  | 'chat'
  | 'all'

export type ToolEntityTargets = ToolEntityName | readonly ToolEntityName[]

/** Mutating AI tools and the client data domain they invalidate. */
export const TOOL_ENTITY_MAP: Readonly<Record<string, ToolEntityTargets | undefined>> = {
  create_chapter: ['chapter', 'stats'],
  update_chapter: ['chapter', 'character', 'stats'],
  delete_chapter: ['chapter', 'character', 'memory', 'stats'],
  create_volume: ['chapter', 'stats'],
  update_volume: ['chapter', 'stats'],
  delete_volume: ['chapter', 'character', 'memory', 'stats'],

  create_character: ['character', 'stats'],
  update_character: 'character',
  delete_character: ['character', 'stats'],
  set_chapter_character: 'character',
  remove_chapter_character: 'character',

  create_world_entry: ['world', 'stats'],
  update_world_entry: 'world',
  delete_world_entry: ['world', 'stats'],
  create_science_entry: ['science', 'stats'],
  delete_science_entry: ['science', 'stats'],

  create_foreshadow: ['foreshadow', 'stats'],
  update_foreshadow: ['foreshadow', 'stats'],
  delete_foreshadow: ['foreshadow', 'stats'],
  create_relation: ['relation', 'stats'],
  update_relation: 'relation',
  delete_relation: ['relation', 'stats'],
  create_memory: ['memory', 'stats'],
  update_memory: 'memory',
  delete_memory: ['memory', 'stats'],
  create_timeline_event: ['timeline', 'stats'],
  update_timeline_event: 'timeline',
  delete_timeline_event: ['timeline', 'stats'],

  create_clue: 'stats',
  update_clue: 'stats',
  delete_clue: 'stats',
  update_project_phase: 'project',
}
