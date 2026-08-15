const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { openControlStore } = require('../control-store');
const { canonicalDatabasePath } = require('../sqljs-atomic-store');
const { FAULT_POINTS, withFaults } = require('../testing/fault-injection');
const { withRawManuscriptSetup } = require('./fixtures/raw-manuscript-setup');
const { withIsolatedDataDir } = require('./helpers/isolated-data-dir');

function projectControlStore(database, projectName) {
  const filePath = database.getProjectDbPath(projectName);
  const dbKey = createHash('sha256').update(canonicalDatabasePath(filePath)).digest('hex');
  return openControlStore(path.join(database.getDataDir(), 'control', 'sqlite', dbKey));
}

test('AI chapter tools require an unambiguous stable chapter identity', async (t) => {
  withIsolatedDataDir(t);

  const db = require('../db');
  const { executeTool, TOOLS } = require('../tools');
  const project = 'chapter-tools-identity';

  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume One')").run();
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (2, 2, 'Volume Two')").run();
  withRawManuscriptSetup(() => {
    projectDb.prepare("INSERT INTO chapters (volume_id, num, title, content) VALUES (1, 1, 'First volume', 'First')").run();
    projectDb.prepare("INSERT INTO chapters (volume_id, num, title, content) VALUES (2, 1, 'Second volume', 'Second')").run();
    projectDb.prepare("INSERT INTO chapters (volume_id, num, title, content) VALUES (1, 2, 'Unique legacy number', 'Unique')").run();
  });
  projectDb.prepare("INSERT INTO characters (id, name, role) VALUES ('character-1', 'Character', 'major')").run();

  const first = projectDb.prepare('SELECT * FROM chapters WHERE volume_id = 1 AND num = 1').get();
  const second = projectDb.prepare('SELECT * FROM chapters WHERE volume_id = 2 AND num = 1').get();
  const unique = projectDb.prepare('SELECT * FROM chapters WHERE volume_id = 1 AND num = 2').get();

  const chapterToolSchemas = TOOLS
    .filter((tool) => ['get_chapter', 'update_chapter', 'delete_chapter'].includes(tool.function.name));
  assert.equal(chapterToolSchemas.length, 3);
  for (const tool of chapterToolSchemas) {
    assert.ok(tool.function.parameters.properties.chapter_id);
    assert.ok(tool.function.parameters.properties.volume_id);
  }

  for (const name of ['list_chapter_characters', 'set_chapter_character', 'remove_chapter_character']) {
    const schema = TOOLS.find((tool) => tool.function.name === name).function.parameters.properties;
    assert.ok(schema.chapter_id);
    assert.ok(schema.volume_id);
    assert.ok(schema.chapter_num);
  }
  const memorySchema = TOOLS.find((tool) => tool.function.name === 'create_memory').function.parameters.properties;
  assert.ok(memorySchema.source_chapter_id);
  assert.ok(memorySchema.source_volume_id);
  assert.ok(memorySchema.source_chapter_num);
  const clueSchema = TOOLS.find((tool) => tool.function.name === 'create_clue').function.parameters.properties;
  assert.ok(clueSchema.related_chapter_id);
  assert.ok(clueSchema.related_volume_id);
  assert.ok(clueSchema.related_chapter_num);

  const listed = executeTool(project, 'list_chapters', {});
  assert.deepEqual(
    listed.map(({ chapter_id, volume_id, num }) => ({ chapter_id, volume_id, num })),
    [
      { chapter_id: first.id, volume_id: 1, num: 1 },
      { chapter_id: unique.id, volume_id: 1, num: 2 },
      { chapter_id: second.id, volume_id: 2, num: 1 },
    ],
  );

  const ambiguousGet = executeTool(project, 'get_chapter', { chapter_num: 1 });
  assert.equal(ambiguousGet.code, 'AMBIGUOUS_CHAPTER');
  assert.equal(executeTool(project, 'get_chapter', { volume_id: 2, chapter_num: 1 }).id, second.id);
  assert.equal(executeTool(project, 'get_chapter', { chapter_id: first.id }).id, first.id);
  assert.equal(
    executeTool(project, 'get_chapter', { chapter_id: first.id, chapter_num: 2 }).code,
    'CHAPTER_IDENTITY_MISMATCH',
  );

  assert.equal(executeTool(project, 'list_chapter_characters', { chapter_num: 1 }).code, 'AMBIGUOUS_CHAPTER');
  assert.equal(
    executeTool(project, 'set_chapter_character', { chapter_num: 1, character_name: 'Character' }).code,
    'AMBIGUOUS_CHAPTER',
  );
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM chapter_characters').get().count, 0);

  const tupleCharacter = executeTool(project, 'set_chapter_character', {
    volume_id: 2,
    chapter_num: 1,
    character_name: 'Character',
    role: 'pov',
  });
  assert.deepEqual(
    {
      set: tupleCharacter.set,
      chapter_id: tupleCharacter.chapter_id,
      volume_id: tupleCharacter.volume_id,
      chapter_num: tupleCharacter.chapter_num,
    },
    { set: true, chapter_id: second.id, volume_id: 2, chapter_num: 1 },
  );
  assert.ok(projectDb.prepare('SELECT 1 FROM chapter_characters WHERE chapter_id = ?').get(second.id));

  const listedCharacters = executeTool(project, 'list_chapter_characters', { chapter_id: second.id });
  assert.equal(listedCharacters.length, 1);
  assert.deepEqual(
    {
      chapter_id: listedCharacters[0].chapter_id,
      volume_id: listedCharacters[0].volume_id,
      chapter_num: listedCharacters[0].chapter_num,
      character_name: listedCharacters[0].character_name,
      role: listedCharacters[0].role,
    },
    { chapter_id: second.id, volume_id: 2, chapter_num: 1, character_name: 'Character', role: 'pov' },
  );
  assert.equal(
    executeTool(project, 'remove_chapter_character', { chapter_num: 1, character_name: 'Character' }).code,
    'AMBIGUOUS_CHAPTER',
  );
  assert.ok(projectDb.prepare('SELECT 1 FROM chapter_characters WHERE chapter_id = ?').get(second.id));
  const removedCharacter = executeTool(project, 'remove_chapter_character', {
    chapter_id: second.id,
    character_name: 'Character',
  });
  assert.deepEqual(
    {
      deleted: removedCharacter.deleted,
      chapter_id: removedCharacter.chapter_id,
      volume_id: removedCharacter.volume_id,
      chapter_num: removedCharacter.chapter_num,
    },
    { deleted: true, chapter_id: second.id, volume_id: 2, chapter_num: 1 },
  );

  const legacyCharacter = executeTool(project, 'set_chapter_character', {
    chapter_num: 2,
    character_name: 'Character',
  });
  assert.equal(legacyCharacter.chapter_id, unique.id);
  assert.equal(legacyCharacter.volume_id, 1);
  assert.equal(legacyCharacter.chapter_num, 2);

  assert.equal(
    executeTool(project, 'create_memory', {
      category: 'event',
      content: 'ambiguous',
      source_chapter_num: 1,
    }).code,
    'AMBIGUOUS_CHAPTER',
  );
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 0);
  const tupleMemory = executeTool(project, 'create_memory', {
    category: 'event',
    content: 'tuple source',
    source_volume_id: 2,
    source_chapter_num: 1,
  });
  assert.equal(tupleMemory.source_chapter_id, second.id);
  assert.equal(tupleMemory.source_volume_id, 2);
  assert.equal(tupleMemory.source_chapter_num, 1);
  assert.equal(
    projectDb.prepare('SELECT source_chapter_id FROM memories WHERE id = ?').get(tupleMemory.id).source_chapter_id,
    second.id,
  );
  const legacyMemory = executeTool(project, 'create_memory', {
    category: 'event',
    content: 'legacy source',
    source_chapter_num: 2,
  });
  assert.equal(legacyMemory.source_chapter_id, unique.id);
  assert.equal(
    executeTool(project, 'create_memory', {
      category: 'event',
      content: 'missing source',
      source_chapter_id: 999999,
    }).code,
    'CHAPTER_NOT_FOUND',
  );
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM memories').get().count, 2);

  assert.equal(
    executeTool(project, 'create_clue', {
      title: 'ambiguous',
      kind: 'clue',
      related_chapter_num: 1,
    }).code,
    'AMBIGUOUS_CHAPTER',
  );
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM clue_board').get().count, 0);
  const idClue = executeTool(project, 'create_clue', {
    title: 'stable id',
    kind: 'clue',
    related_chapter_id: first.id,
  });
  assert.equal(idClue.related_chapter_id, first.id);
  assert.equal(idClue.related_volume_id, 1);
  assert.equal(idClue.related_chapter_num, 1);
  assert.equal(
    projectDb.prepare('SELECT related_chapter_id FROM clue_board WHERE id = ?').get(idClue.id).related_chapter_id,
    first.id,
  );
  const legacyClue = executeTool(project, 'create_clue', {
    title: 'legacy number',
    kind: 'question',
    related_chapter_num: 2,
  });
  assert.equal(legacyClue.related_chapter_id, unique.id);
  assert.equal(
    executeTool(project, 'create_clue', {
      title: 'missing tuple',
      kind: 'clue',
      related_volume_id: 2,
      related_chapter_num: 999,
    }).code,
    'CHAPTER_NOT_FOUND',
  );
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM clue_board').get().count, 2);

  const ambiguousUpdate = executeTool(project, 'update_chapter', { chapter_num: 1, title: 'Must not be written' });
  assert.equal(ambiguousUpdate.code, 'AMBIGUOUS_CHAPTER');
  assert.equal(projectDb.prepare('SELECT title FROM chapters WHERE id = ?').get(first.id).title, 'First volume');
  assert.equal(projectDb.prepare('SELECT title FROM chapters WHERE id = ?').get(second.id).title, 'Second volume');

  const tupleUpdate = executeTool(project, 'update_chapter', {
    volume_id: 1,
    chapter_num: 1,
    content: 'Updated first volume',
  });
  assert.equal(tupleUpdate.updated, true);
  assert.equal(tupleUpdate.chapter_id, first.id);
  assert.deepEqual(tupleUpdate.changed_fields, ['content']);
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(first.id).content, 'Updated first volume');
  assert.equal(projectDb.prepare('SELECT content FROM chapters WHERE id = ?').get(second.id).content, 'Second');

  const toolControlStore = projectControlStore(db, project);
  const eventsBeforeCombined = toolControlStore.read();
  const preparedBeforeCombined = eventsBeforeCombined
    .filter((event) => event.type === 'sqlite.publish.prepared').length;
  const sourcesBeforeCombined = eventsBeforeCombined
    .filter((event) => event.type === 'manuscript.body_mutation.attempt').length;
  const combinedUpdate = executeTool(project, 'update_chapter', {
    chapter_id: second.id,
    content: 'Updated second body',
    title: 'Updated second body title',
    outline: 'Updated second outline',
  });
  assert.deepEqual(combinedUpdate, {
    updated: true,
    chapter_id: second.id,
    volume_id: 2,
    chapter_num: 1,
    changed_fields: ['content', 'title', 'outline'],
  });
  assert.deepEqual(
    projectDb.prepare('SELECT title, outline, content, word_count FROM chapters WHERE id = ?').get(second.id),
    {
      title: 'Updated second body title',
      outline: 'Updated second outline',
      content: 'Updated second body',
      word_count: 'Updatedsecondbody'.length,
    },
  );
  const eventsAfterCombined = toolControlStore.read();
  assert.equal(
    eventsAfterCombined.filter((event) => event.type === 'sqlite.publish.prepared').length,
    preparedBeforeCombined + 1,
  );
  assert.equal(
    eventsAfterCombined.filter((event) => event.type === 'manuscript.body_mutation.attempt').length,
    sourcesBeforeCombined + 1,
  );
  const combinedSourceEvent = eventsAfterCombined
    .filter((event) => event.type === 'manuscript.body_mutation.attempt')
    .at(-1);
  assert.equal(combinedSourceEvent.payload.source, 'ai_tool');
  assert.equal(eventsAfterCombined[eventsAfterCombined.indexOf(combinedSourceEvent) + 1].type, 'sqlite.publish.prepared');

  const sourcesBeforeMetadataOnly = eventsAfterCombined
    .filter((event) => event.type === 'manuscript.body_mutation.attempt').length;
  const idUpdate = executeTool(project, 'update_chapter', { chapter_id: second.id, title: 'Updated second volume' });
  assert.deepEqual(idUpdate, {
    updated: true,
    chapter_id: second.id,
    volume_id: 2,
    chapter_num: 1,
    changed_fields: ['title'],
  });
  assert.deepEqual(
    projectDb.prepare('SELECT title, content FROM chapters WHERE id = ?').get(second.id),
    { title: 'Updated second volume', content: 'Updated second body' },
  );
  assert.equal(
    toolControlStore.read().filter((event) => event.type === 'manuscript.body_mutation.attempt').length,
    sourcesBeforeMetadataOnly,
  );

  const insertRevision = projectDb.prepare(
    'INSERT INTO chapter_revisions (chapter_id, base_content, proposed_content) VALUES (?, ?, ?)',
  );
  insertRevision.run(first.id, 'first base', 'first proposal');
  insertRevision.run(second.id, 'second base', 'second proposal');

  const ambiguousDelete = executeTool(project, 'delete_chapter', { chapter_num: 1 });
  assert.equal(ambiguousDelete.code, 'AMBIGUOUS_CHAPTER');
  assert.equal(projectDb.prepare('SELECT COUNT(*) AS count FROM chapters WHERE num = 1').get().count, 2);

  const tupleDelete = executeTool(project, 'delete_chapter', { volume_id: 1, chapter_num: 1 });
  assert.equal(tupleDelete.deleted, true);
  assert.equal(tupleDelete.chapter_id, first.id);
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(first.id), null);
  assert.equal(projectDb.prepare('SELECT id FROM chapter_revisions WHERE chapter_id = ?').get(first.id), null);
  assert.ok(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(second.id));
  assert.ok(projectDb.prepare('SELECT id FROM chapter_revisions WHERE chapter_id = ?').get(second.id));

  const created = executeTool(project, 'create_chapter', {
    volume_id: 1,
    chapter_num: 1,
    title: 'Replacement',
    outline: 'Replacement outline',
    content: 'Replacement body',
    cognitive_frame: 'Replacement frame',
  });
  assert.deepEqual(created, {
    created: true,
    chapter_id: created.chapter_id,
    volume_id: 1,
    chapter_num: 1,
    title: 'Replacement',
  });
  assert.ok(created.chapter_id);
  assert.deepEqual(
    projectDb.prepare('SELECT title, outline, content, word_count, cognitive_frame FROM chapters WHERE id = ?').get(created.chapter_id),
    {
      title: 'Replacement',
      outline: 'Replacement outline',
      content: 'Replacement body',
      word_count: 'Replacementbody'.length,
      cognitive_frame: 'Replacement frame',
    },
  );
  insertRevision.run(created.chapter_id, 'replacement base', 'replacement proposal');

  const idDelete = executeTool(project, 'delete_chapter', { chapter_id: created.chapter_id });
  assert.equal(idDelete.deleted, true);
  assert.equal(idDelete.chapter_id, created.chapter_id);
  assert.equal(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(created.chapter_id), null);
  assert.equal(projectDb.prepare('SELECT id FROM chapter_revisions WHERE chapter_id = ?').get(created.chapter_id), null);
  assert.ok(projectDb.prepare('SELECT id FROM chapters WHERE id = ?').get(second.id));
});

test('cold AI body tool uses one lease and a persistence failure cannot be downgraded before usage', async (t) => {
  withIsolatedDataDir(t);
  const db = require('../db');
  const { executeTool } = require('../tools');
  const {
    createChapter,
    isManuscriptPersistenceError,
  } = require('../manuscript-service');
  const { projectWriteDiagnostics } = require('../testing/database-internals');
  const project = 'chapter-tool-persistence-failure';
  await db.initDatabase();
  const projectDb = db.createProjectDb(project);
  projectDb.prepare("INSERT INTO volumes (id, sort_order, title) VALUES (1, 1, 'Volume')").run();
  const chapter = createChapter({
    projectName: project,
    source: 'ai_tool',
    fields: { volume_id: 1, chapter_num: 1, title: 'Before title', content: 'Before body' },
  }).chapter;
  const filePath = db.getProjectDbPath(project);
  db.closeProjectDb(filePath);
  const leasesBefore = projectWriteDiagnostics().leaseAcquisitionCount(filePath);
  let persistenceError;
  try {
    await withFaults({
      [FAULT_POINTS.ATOMIC_STORE_PUBLISH_BEFORE_CANDIDATE_WRITE]: { throw: 'EIO' },
    }, async () => executeTool(project, 'update_chapter', {
      chapter_id: chapter.id,
      title: 'Failed title',
      content: 'Failed body',
    }));
  } catch (error) {
    persistenceError = error;
  }
  const marked = typeof isManuscriptPersistenceError === 'function'
    && isManuscriptPersistenceError(persistenceError);
  assert.equal(persistenceError?.code, 'EIO');
  assert.equal(marked, true);
  assert.equal(projectWriteDiagnostics().leaseAcquisitionCount(filePath), leasesBefore + 1);

  if (!marked) {
    db.projectExecute(
      project,
      'INSERT INTO token_usage (task_name, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?)',
      ['stream_chat', 5, 3, 'model'],
    );
  }
  const reopened = db.getProjectDb(project);
  assert.deepEqual(
    reopened.prepare('SELECT title, content FROM chapters WHERE id = ?').get(chapter.id),
    { title: 'Before title', content: 'Before body' },
  );
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM token_usage').get().count, 0);
});
