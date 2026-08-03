const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('AI world tools share their category contract and preserve complete CRUD behavior', async (t) => {
  const { parseWorldTags } = require('../world-tags');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-world-tools-'));
  const previousDataDir = process.env.MYTHPEN_DATA_DIR;
  process.env.MYTHPEN_DATA_DIR = dataDir;

  const db = require('../db');
  const { executeTool, TOOLS } = require('../tools');
  const project = 'world-tools';

  t.after(async () => {
    db.closeProjectDb(db.getProjectDbPath(project));
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.MYTHPEN_DATA_DIR;
    else process.env.MYTHPEN_DATA_DIR = previousDataDir;
  });

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
