const { createHash } = require('node:crypto');

const db = require('./db');

const SOURCES = new Set(['rest', 'ai_tool', 'ai_continue', 'revision_accept']);
const BODY_PATCH_COLUMNS = Object.freeze({
  cognitive_frame: 'cognitive_frame',
  concrete_mystery: 'concrete_mystery',
  emotional_anchor: 'emotional_anchor',
  interpersonal_tension: 'interpersonal_tension',
  outline: 'outline',
  status: 'status',
  summary: 'summary',
  title: 'title',
  world_texture: 'world_texture',
});
const CREATE_FIELDS = new Set([
  'chapter_num',
  'cognitive_frame',
  'concrete_mystery',
  'content',
  'emotional_anchor',
  'interpersonal_tension',
  'outline',
  'title',
  'volume_id',
  'world_texture',
]);

class ManuscriptServiceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ManuscriptServiceError';
    this.code = code;
  }
}

class NoManuscriptMutation extends Error {
  constructor(result) {
    super('Manuscript mutation was not applied');
    this.result = result;
  }
}

function fail(code, message) {
  throw new ManuscriptServiceError(code, message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateSource(source) {
  if (!SOURCES.has(source)) {
    fail('MANUSCRIPT_SOURCE_INVALID', 'Manuscript mutation source is missing or invalid');
  }
}

function validateProjectName(projectName) {
  if (typeof projectName !== 'string' || projectName.length === 0) {
    fail('MANUSCRIPT_PROJECT_INVALID', 'Project name must be a non-empty string');
  }
}

function validateProjectAndChapter(projectName, chapterId) {
  validateProjectName(projectName);
  if (!positiveInteger(chapterId)) {
    fail('MANUSCRIPT_CHAPTER_INVALID', 'Chapter identifier must be a positive safe integer');
  }
}

function validateIdentity(identity) {
  const keys = ['chapterId', 'chapterNumber', 'volumeId'];
  if (
    !hasExactKeys(identity, keys)
    || !(identity.chapterId === null || positiveInteger(identity.chapterId))
    || !(identity.chapterNumber === null || positiveInteger(identity.chapterNumber))
    || !(identity.volumeId === null || positiveInteger(identity.volumeId))
    || (identity.chapterId === null && !positiveInteger(identity.chapterNumber))
  ) {
    fail('MANUSCRIPT_CHAPTER_INVALID', 'Chapter identity must use exact positive identifiers');
  }
  return Object.freeze({ ...identity });
}

function validateContent(content, fieldName = 'content') {
  if (typeof content !== 'string') {
    fail('MANUSCRIPT_CONTENT_INVALID', `${fieldName} must be a string`);
  }
}

function validateExpectedDataVersion(expectedDataVersion) {
  if (
    expectedDataVersion !== undefined
    && (!Number.isSafeInteger(expectedDataVersion) || expectedDataVersion < 0)
  ) {
    fail('MANUSCRIPT_DATA_VERSION_INVALID', 'Expected data version must be a non-negative safe integer');
  }
}

function validateExpectedBodyHash(expectedBodyHash) {
  if (!/^[0-9a-f]{64}$/.test(expectedBodyHash || '')) {
    fail('MANUSCRIPT_BODY_HASH_INVALID', 'Expected body hash must be an exact lowercase SHA-256');
  }
}

function validatePatch(patch) {
  const unknown = Object.keys(patch).filter(
    (key) => key !== 'expectedBodyContent' && !Object.prototype.hasOwnProperty.call(BODY_PATCH_COLUMNS, key),
  );
  if (unknown.length > 0) {
    fail('MANUSCRIPT_PATCH_INVALID', `Unsupported manuscript patch field: ${unknown[0]}`);
  }
  if (patch.expectedBodyContent !== undefined) validateContent(patch.expectedBodyContent, 'expectedBodyContent');
}

function validateUsage(usage) {
  if (usage === undefined) return null;
  if (
    !hasExactKeys(usage, ['inputTokens', 'model', 'outputTokens'])
    || !Number.isSafeInteger(usage.inputTokens)
    || usage.inputTokens < 0
    || !Number.isSafeInteger(usage.outputTokens)
    || usage.outputTokens < 0
    || typeof usage.model !== 'string'
    || usage.model.length === 0
  ) {
    fail('MANUSCRIPT_USAGE_INVALID', 'Continuation usage must use the exact token schema');
  }
  return Object.freeze({ ...usage });
}

function diagnosticEvent({
  body,
  chapterId = null,
  chapterNumber = null,
  expectedBodySha256 = null,
  expectedDataVersion = null,
  operation,
  source,
  volumeId = null,
}) {
  return {
    type: 'manuscript.body_mutation.attempt',
    payload: {
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      bodySha256: sha256(body),
      chapterId,
      chapterNumber,
      expectedBodySha256,
      expectedDataVersion,
      operation,
      source,
      version: 1,
      volumeId,
    },
  };
}

function resolveChapter(projectDb, chapterId, identity) {
  if (!identity) {
    const chapter = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
    return chapter ? { chapter } : { missing: true };
  }
  if (identity.chapterId !== null) {
    const chapter = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(identity.chapterId);
    if (!chapter) return { identityError: { code: 'CHAPTER_NOT_FOUND', ...identity } };
    if (
      (identity.chapterNumber !== null && chapter.num !== identity.chapterNumber)
      || (identity.volumeId !== null && chapter.volume_id !== identity.volumeId)
    ) {
      return { identityError: { code: 'CHAPTER_IDENTITY_MISMATCH', ...identity } };
    }
    return { chapter };
  }
  if (identity.volumeId !== null) {
    const chapter = projectDb
      .prepare('SELECT * FROM chapters WHERE volume_id = ? AND num = ?')
      .get(identity.volumeId, identity.chapterNumber);
    return chapter
      ? { chapter }
      : { identityError: { code: 'CHAPTER_NOT_FOUND', ...identity } };
  }
  const candidates = projectDb
    .prepare('SELECT * FROM chapters WHERE num = ? ORDER BY volume_id, id')
    .all(identity.chapterNumber);
  if (candidates.length === 0) return { identityError: { code: 'CHAPTER_NOT_FOUND', ...identity } };
  if (candidates.length > 1) return { identityError: { code: 'AMBIGUOUS_CHAPTER', ...identity } };
  return { chapter: candidates[0] };
}

function createManuscriptService(database) {
  if (!database || typeof database !== 'object') {
    throw new TypeError('ManuscriptService requires a database facade');
  }

  function transactionCapability() {
    const capability = database.manuscriptTransactionCapability;
    if (
      !capability
      || typeof capability.assertActive !== 'function'
      || typeof capability.claim !== 'function'
      || typeof capability.appendSourceEvent !== 'function'
    ) {
      throw new TypeError('Database facade does not provide manuscript transaction ownership');
    }
    return capability;
  }

  function runTransaction(projectName, intent, callback) {
    if (typeof database.runManuscriptTransaction !== 'function') {
      throw new TypeError('Database facade does not provide manuscript transaction publication');
    }
    return database.runManuscriptTransaction(projectName, intent, callback);
  }

  function frozenIntent({
    body,
    chapterId,
    chapterNumber = null,
    expectedBodySha256 = null,
    expectedDataVersion = null,
    operation,
    source,
    volumeId = null,
  }) {
    return Object.freeze({
      bodyBytes: Buffer.byteLength(body),
      bodySha256: sha256(body),
      chapterId,
      chapterNumber,
      expectedBodySha256,
      expectedDataVersion,
      operation,
      source,
      targetKind: 'chapter',
      version: 1,
      volumeId,
    });
  }

  function writeChapterBodyInTransaction(input) {
    const {
      projectName,
      projectDb,
      ownershipToken: _obsoleteOwnershipToken,
      chapterId,
      content,
      expectedDataVersion,
      source,
      ...patch
    } = input || {};
    validateSource(source);
    validateProjectAndChapter(projectName, chapterId);
    validateContent(content);
    validateExpectedDataVersion(expectedDataVersion);
    validatePatch(patch);

    const capability = transactionCapability();
    capability.assertActive(projectName, projectDb);
    const expectedBodyContent = patch.expectedBodyContent;
    const current = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
    if (!current) return { changes: 0, missing: true, chapter: null };
    if (
      (expectedDataVersion !== undefined && current.data_version !== expectedDataVersion)
      || (expectedBodyContent !== undefined && (current.content ?? '') !== expectedBodyContent)
    ) {
      return { changes: 0, conflict: true, current, chapter: null };
    }

    const claim = capability.claim(projectName, projectDb, {
      chapterId,
      chapterNumber: null,
      operation: 'replace',
      source,
      volumeId: null,
    });
    capability.appendSourceEvent(
      projectName,
      projectDb,
      claim,
      diagnosticEvent({
        body: content,
        chapterId,
        expectedBodySha256: expectedBodyContent === undefined ? null : sha256(expectedBodyContent),
        expectedDataVersion: expectedDataVersion ?? null,
        operation: 'replace',
        source,
      }),
    );

    const assignments = ['content = ?', 'word_count = ?'];
    const params = [content, content.replace(/\s/g, '').length];
    for (const [inputName, columnName] of Object.entries(BODY_PATCH_COLUMNS)) {
      if (patch[inputName] === undefined) continue;
      assignments.push(`${columnName} = ?`);
      params.push(patch[inputName]);
    }
    assignments.push("updated_at = datetime('now')");
    const predicates = ['id = ?'];
    params.push(chapterId);
    if (expectedDataVersion !== undefined) {
      predicates.push('data_version = ?');
      params.push(expectedDataVersion);
    }
    if (expectedBodyContent !== undefined) {
      predicates.push("COALESCE(content, '') = ?");
      params.push(expectedBodyContent);
    }

    const changes = projectDb
      .prepare(`UPDATE chapters SET ${assignments.join(', ')} WHERE ${predicates.join(' AND ')}`)
      .run(...params).changes;
    if (changes === 0) {
      const latest = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
      if (!latest) return { changes, missing: true, chapter: null };
      return { changes, conflict: true, current: latest, chapter: null };
    }
    database.updateProjectWordCount(projectDb);
    const chapter = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
    return {
      changes,
      chapter,
      chapterId,
      content: chapter.content,
      dataVersion: chapter.data_version,
      wordCount: chapter.word_count,
    };
  }

  function writeChapterBody(input) {
    const {
      projectName,
      chapterId,
      identity: identityInput,
      content,
      expectedDataVersion,
      source,
      ...patch
    } = input || {};
    validateSource(source);
    validateProjectName(projectName);
    const identity = identityInput === undefined ? null : validateIdentity(identityInput);
    if (!identity) validateProjectAndChapter(projectName, chapterId);
    validateContent(content);
    validateExpectedDataVersion(expectedDataVersion);
    validatePatch(patch);

    try {
      return runTransaction(projectName, frozenIntent({
        body: content,
        chapterId: identity?.chapterId ?? chapterId,
        chapterNumber: identity?.chapterNumber ?? null,
        expectedDataVersion: expectedDataVersion ?? null,
        operation: 'replace',
        source,
        volumeId: identity?.volumeId ?? null,
      }), (projectDb) => {
        const resolved = resolveChapter(projectDb, chapterId, identity);
        if (resolved.identityError) {
          throw new NoManuscriptMutation({ changes: 0, identityError: resolved.identityError, chapter: null });
        }
        if (resolved.missing) {
          throw new NoManuscriptMutation({ changes: 0, missing: true, chapter: null });
        }
        const result = writeChapterBodyInTransaction({
          projectName,
          projectDb,
          chapterId: resolved.chapter.id,
          content,
          expectedDataVersion,
          source,
          ...patch,
        });
        if (result.missing || result.conflict) throw new NoManuscriptMutation(result);
        return result;
      });
    } catch (error) {
      if (error instanceof NoManuscriptMutation) return error.result;
      throw error;
    }
  }

  function appendChapterBody(input) {
    const {
      projectName,
      chapterId,
      appended,
      expectedBodyHash,
      source,
      usage: usageInput,
    } = input || {};
    validateSource(source);
    validateProjectAndChapter(projectName, chapterId);
    validateContent(appended, 'appended');
    validateExpectedBodyHash(expectedBodyHash);
    const usage = validateUsage(usageInput);

    try {
      return runTransaction(projectName, frozenIntent({
        body: appended,
        chapterId,
        expectedBodySha256: expectedBodyHash,
        operation: 'append',
        source,
      }), (projectDb) => {
        const capability = transactionCapability();
        capability.assertActive(projectName, projectDb);
        const current = projectDb
          .prepare('SELECT id, num, content, data_version FROM chapters WHERE id = ?')
          .get(chapterId);
        if (!current) throw new NoManuscriptMutation({ changes: 0, missing: true, chapter: null });
        const existing = current.content ?? '';
        const currentBodyHash = sha256(existing);
        if (currentBodyHash !== expectedBodyHash) {
          throw new NoManuscriptMutation({
            changes: 0,
            conflict: true,
            currentBodyHash,
            current,
            chapter: null,
          });
        }
        const content = existing ? `${existing}\n\n${appended}` : appended;
        const claim = capability.claim(projectName, projectDb, {
          chapterId,
          chapterNumber: null,
          operation: 'append',
          source,
          volumeId: null,
        });
        capability.appendSourceEvent(
          projectName,
          projectDb,
          claim,
          diagnosticEvent({
            body: content,
            chapterId,
            expectedBodySha256: expectedBodyHash,
            expectedDataVersion: current.data_version ?? null,
            operation: 'append',
            source,
          }),
        );
        const wordCount = content.replace(/\s/g, '').length;
        const changes = projectDb
          .prepare("UPDATE chapters SET content = ?, word_count = ?, status = 'writing', updated_at = datetime('now') WHERE id = ? AND COALESCE(content, '') = ?")
          .run(content, wordCount, chapterId, existing).changes;
        if (changes === 0) {
          const latest = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
          if (!latest) throw new NoManuscriptMutation({ changes, missing: true, chapter: null });
          throw new NoManuscriptMutation({
            changes,
            conflict: true,
            currentBodyHash: sha256(latest.content ?? ''),
            current: latest,
            chapter: null,
          });
        }
        if (usage && (usage.inputTokens || usage.outputTokens)) {
          projectDb
            .prepare('INSERT INTO token_usage (task_name, chapter_num, input_tokens, output_tokens, model) VALUES (?, ?, ?, ?, ?)')
            .run('continue', current.num, usage.inputTokens, usage.outputTokens, usage.model);
        }
        database.updateProjectWordCount(projectDb);
        const chapter = projectDb.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
        return {
          changes,
          chapter,
          chapterId,
          content: chapter.content,
          dataVersion: chapter.data_version,
          wordCount: chapter.word_count,
        };
      });
    } catch (error) {
      if (error instanceof NoManuscriptMutation) return error.result;
      throw error;
    }
  }

  function createChapter(input) {
    const { projectName, fields, source } = input || {};
    validateSource(source);
    validateProjectName(projectName);
    if (!fields || Array.isArray(fields) || typeof fields !== 'object') {
      fail('MANUSCRIPT_CREATE_FIELDS_INVALID', 'Chapter fields must be a plain object');
    }
    const unknown = Object.keys(fields).filter((key) => !CREATE_FIELDS.has(key));
    if (unknown.length > 0) {
      fail('MANUSCRIPT_CREATE_FIELDS_INVALID', `Unsupported chapter field: ${unknown[0]}`);
    }
    const content = fields.content === undefined ? '' : String(fields.content);
    const volumeId = fields.volume_id === undefined ? 1 : fields.volume_id;
    if (!positiveInteger(volumeId)) {
      fail('MANUSCRIPT_CREATE_FIELDS_INVALID', 'Volume identifier must be a positive safe integer');
    }
    if (fields.chapter_num !== undefined && !positiveInteger(fields.chapter_num)) {
      fail('MANUSCRIPT_CREATE_FIELDS_INVALID', 'Chapter number must be a positive safe integer');
    }

    const requestedChapterNumber = fields.chapter_num ?? null;
    return runTransaction(projectName, frozenIntent({
      body: content,
      chapterId: null,
      chapterNumber: requestedChapterNumber,
      operation: 'create',
      source,
      volumeId,
    }), (projectDb) => {
      const capability = transactionCapability();
      capability.assertActive(projectName, projectDb);
      const chapterNumber = fields.chapter_num === undefined
        ? (projectDb.prepare('SELECT MAX(num) AS max_num FROM chapters WHERE volume_id = ?').get(volumeId)?.max_num || 0) + 1
        : fields.chapter_num;
      const claim = capability.claim(projectName, projectDb, {
        chapterId: null,
        chapterNumber,
        operation: 'create',
        source,
        volumeId,
      });
      capability.appendSourceEvent(
        projectName,
        projectDb,
        claim,
        diagnosticEvent({
          body: content,
          chapterNumber,
          operation: 'create',
          source,
          volumeId,
        }),
      );
      projectDb
        .prepare(`INSERT INTO chapters (
          volume_id, num, title, outline, content, word_count, status,
          cognitive_frame, emotional_anchor, world_texture, concrete_mystery,
          interpersonal_tension, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
        .run(
          volumeId,
          chapterNumber,
          fields.title,
          fields.outline || '',
          content,
          content.replace(/\s/g, '').length,
          fields.cognitive_frame || '',
          fields.emotional_anchor || '',
          fields.world_texture || '',
          fields.concrete_mystery || '',
          fields.interpersonal_tension || '',
        );
      database.updateProjectWordCount(projectDb);
      const chapter = projectDb
        .prepare('SELECT * FROM chapters WHERE volume_id = ? AND num = ?')
        .get(volumeId, chapterNumber);
      return {
        chapter,
        chapterId: chapter.id,
        chapterNumber: chapter.num,
        volumeId: chapter.volume_id,
      };
    });
  }

  return Object.freeze({
    appendChapterBody,
    createChapter,
    internals: Object.freeze({ writeChapterBodyInTransaction }),
    isManuscriptPersistenceError: (error) => (
      typeof database.isManuscriptPersistenceError === 'function'
      && database.isManuscriptPersistenceError(error)
    ),
    writeChapterBody,
  });
}

const manuscriptService = createManuscriptService(db);

module.exports = {
  ManuscriptServiceError,
  appendChapterBody: manuscriptService.appendChapterBody,
  createChapter: manuscriptService.createChapter,
  createManuscriptService,
  internals: manuscriptService.internals,
  isManuscriptPersistenceError: manuscriptService.isManuscriptPersistenceError,
  writeChapterBody: manuscriptService.writeChapterBody,
};
