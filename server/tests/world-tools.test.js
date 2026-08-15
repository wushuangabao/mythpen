const assert = require('node:assert/strict');
const test = require('node:test');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

test('AI world tools share their category contract and preserve complete CRUD behavior', async (t) => {
  const { parseWorldTags } = require('../world-tags');
  withIsolatedDataDir(t);

  const db = require('../db');
  const { executeTool, TOOLS } = require('../tools');
  const project = 'world-tools';

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);

  const expectedCategories = ['location', 'organization', 'concept', 'event', 'technology'];
  for (const toolName of ['create_world_entry', 'update_world_entry']) {
    const schema = TOOLS.find((tool) => tool.function.name === toolName).function.parameters.properties;
    assert.deepEqual(schema.category.enum, expectedCategories);
    assert.deepEqual(schema.tags, {
      anyOf: [
        { type: 'array', items: { type: 'string' } },
        { type: 'string' },
      ],
      description: '标签（可选；推荐使用字符串数组，兼容旧版逗号分隔字符串）',
    });
  }

  const invalidCreate = executeTool(project, 'create_world_entry', {
    category: 'alien',
    name: 'Must not persist',
    description: 'invalid',
  });

  const created = executeTool(project, 'create_world_entry', {
    category: 'concept',
    name: 'City archive',
    description: 'A living archive beneath the city.',
    tags: ['priority', 'city', 'priority'],
  });
  assert.equal(created.created, true);

  const invalidUpdate = executeTool(project, 'update_world_entry', {
    id: created.id,
    category: 'alien',
    name: 'Must not replace the valid name',
    description: 'Must not replace the valid description',
    tags: ['must-not-persist'],
  });
  const afterRejectedMutations = executeTool(project, 'list_world', {});
  assert.deepEqual(
    [typeof invalidCreate.error, typeof invalidUpdate.error],
    ['string', 'string'],
    'AI create and update must both return readable errors for categories outside the shared enum',
  );
  assert.deepEqual(afterRejectedMutations, [{
    id: created.id,
    category: 'concept',
    name: 'City archive',
    description: 'A living archive beneath the city.',
    tags: ['priority', 'city'],
  }]);
  assert.deepEqual(
    parseWorldTags(projectDb.prepare('SELECT tags FROM world_entries WHERE id = ?').get(created.id).tags),
    ['priority', 'city'],
  );

  const { WORLD_ENTRY_CATEGORIES } = require('../world-entry-categories');
  for (const toolName of ['create_world_entry', 'update_world_entry']) {
    const schema = TOOLS.find((tool) => tool.function.name === toolName).function.parameters.properties;
    assert.strictEqual(schema.category.enum, WORLD_ENTRY_CATEGORIES);
  }

  const updated = executeTool(project, 'update_world_entry', {
    id: created.id,
    category: 'event',
    name: 'Archive awakening',
    description: 'The archive became sentient during the blackout.',
    tags: 'future， legacy, future',
  });
  assert.equal(updated.updated, true);
  assert.deepEqual(executeTool(project, 'list_world', {}), [{
    id: created.id,
    category: 'event',
    name: 'Archive awakening',
    description: 'The archive became sentient during the blackout.',
    tags: ['future', 'legacy'],
  }]);

  assert.equal(executeTool(project, 'delete_world_entry', { id: created.id }).deleted, true);
  assert.deepEqual(executeTool(project, 'list_world', {}), []);
});
