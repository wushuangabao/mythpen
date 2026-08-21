const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fsyncDirectory } = require('./platform/durability');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const EXPORT_SNAPSHOT_KEYS = Object.freeze([
  'metadata',
  'volumes',
  'chapters',
  'projectionGeneration',
]);
const EXPORT_VOLUME_KEYS = Object.freeze([
  'id',
  'volume_uid',
  'sort_order',
  'title',
  'summary',
  'chapters',
]);
const EXPORT_CHAPTER_KEYS = Object.freeze([
  'id',
  'chapter_uid',
  'data_version',
  'volume_id',
  'num',
  'title',
  'outline',
  'content',
  'summary',
  'word_count',
  'status',
  'cognitive_frame',
  'emotional_anchor',
  'world_texture',
  'concrete_mystery',
  'interpersonal_tension',
  'body_raw_sha256',
  'sidecar_raw_sha256',
  'chapter_position',
  'manuscript_position',
]);

function exportError(code, message) {
  const error = new Error(message);
  error.name = 'ProjectExportError';
  error.code = code;
  return error;
}

function exactExportData(value, keys, code, label, { frozen = false } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw exportError(code, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw exportError(code, `${label} must be a plain object`);
  }
  if (frozen && !Object.isFrozen(value)) {
    throw exportError(code, `${label} must be frozen`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
    || actual.some((key) => {
      const descriptor = descriptors[key];
      return descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value');
    })
  ) throw exportError(code, `${label} has an invalid shape`);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, descriptors[key].value])));
}

function frozenDenseExportArray(value, code, label) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || !Object.isFrozen(value)
  ) throw exportError(code, `${label} must be a frozen plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw exportError(code, `${label} has an invalid length`);
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) throw exportError(code, `${label} must be dense`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string'
      || !/^(?:0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= length
    ) throw exportError(code, `${label} has an invalid array property`);
  }
  return value;
}

function nonNegativeExportInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw exportError(code, `${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveExportInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    throw exportError(code, `${label} must be a positive safe integer`);
  }
  return value;
}

function exportString(value, code, label) {
  if (typeof value !== 'string') throw exportError(code, `${label} must be a string`);
  return value;
}

function exportUuid(value, code, label) {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw exportError(code, `${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function validateExportMetadata(value) {
  const code = 'INVALID_EXPORT_SNAPSHOT';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw exportError(code, 'snapshot.metadata must be a plain object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null)
    || !Object.isFrozen(value)
  ) throw exportError(code, 'snapshot.metadata must be a frozen plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) throw exportError(code, 'snapshot.metadata has an invalid shape');
    const field = descriptor.value;
    if (key === 'genres') {
      const genres = frozenDenseExportArray(field, code, 'snapshot.metadata.genres');
      for (let index = 0; index < genres.length; index += 1) {
        exportString(genres[index], code, `snapshot.metadata.genres[${index}]`);
      }
      continue;
    }
    if (
      field !== null
      && typeof field !== 'string'
      && typeof field !== 'boolean'
      && !(Number.isSafeInteger(field) && !Object.is(field, -0))
    ) throw exportError(code, `snapshot.metadata.${key} is not plain scalar data`);
  }
  for (const key of ['name', 'author_name', 'description']) {
    if (Object.hasOwn(descriptors, key)) exportString(descriptors[key].value, code, `snapshot.metadata.${key}`);
  }
  return value;
}

function validateExportChapter(value, label) {
  const code = 'INVALID_EXPORT_SNAPSHOT';
  const chapter = exactExportData(value, EXPORT_CHAPTER_KEYS, code, label, { frozen: true });
  positiveExportInteger(chapter.id, code, `${label}.id`);
  exportUuid(chapter.chapter_uid, code, `${label}.chapter_uid`);
  nonNegativeExportInteger(chapter.data_version, code, `${label}.data_version`);
  if (chapter.volume_id !== null) positiveExportInteger(chapter.volume_id, code, `${label}.volume_id`);
  positiveExportInteger(chapter.num, code, `${label}.num`);
  for (const key of [
    'title',
    'outline',
    'content',
    'summary',
    'status',
    'cognitive_frame',
    'emotional_anchor',
    'world_texture',
    'concrete_mystery',
    'interpersonal_tension',
  ]) exportString(chapter[key], code, `${label}.${key}`);
  nonNegativeExportInteger(chapter.word_count, code, `${label}.word_count`);
  if (!SHA256_PATTERN.test(chapter.body_raw_sha256)) {
    throw exportError(code, `${label}.body_raw_sha256 is invalid`);
  }
  if (!SHA256_PATTERN.test(chapter.sidecar_raw_sha256)) {
    throw exportError(code, `${label}.sidecar_raw_sha256 is invalid`);
  }
  positiveExportInteger(chapter.chapter_position, code, `${label}.chapter_position`);
  positiveExportInteger(chapter.manuscript_position, code, `${label}.manuscript_position`);
  return chapter;
}

function sameExportChapter(left, right) {
  return EXPORT_CHAPTER_KEYS.every((key) => left[key] === right[key]);
}

function validateExportSnapshot(value) {
  const code = 'INVALID_EXPORT_SNAPSHOT';
  const snapshot = exactExportData(
    value,
    EXPORT_SNAPSHOT_KEYS,
    code,
    'snapshot',
    { frozen: true },
  );
  validateExportMetadata(snapshot.metadata);
  const volumes = frozenDenseExportArray(snapshot.volumes, code, 'snapshot.volumes');
  const chapters = frozenDenseExportArray(snapshot.chapters, code, 'snapshot.chapters');
  nonNegativeExportInteger(snapshot.projectionGeneration, code, 'snapshot.projectionGeneration');

  const chaptersByUid = new Map();
  const chaptersById = new Map();
  let previousManuscriptPosition = 0;
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = validateExportChapter(chapters[index], `snapshot.chapters[${index}]`);
    if (chaptersByUid.has(chapter.chapter_uid) || chaptersById.has(chapter.id)) {
      throw exportError(code, 'snapshot.chapters contains duplicate identities');
    }
    if (chapter.manuscript_position <= previousManuscriptPosition) {
      throw exportError(code, 'snapshot.chapters is not in manuscript order');
    }
    previousManuscriptPosition = chapter.manuscript_position;
    chaptersByUid.set(chapter.chapter_uid, chapter);
    chaptersById.set(chapter.id, chapter);
  }

  const volumeIds = new Set();
  const volumeUids = new Set();
  const assignedChapterUids = new Set();
  let previousVolumePosition = 0;
  for (let index = 0; index < volumes.length; index += 1) {
    const label = `snapshot.volumes[${index}]`;
    const volume = exactExportData(volumes[index], EXPORT_VOLUME_KEYS, code, label, { frozen: true });
    positiveExportInteger(volume.id, code, `${label}.id`);
    exportUuid(volume.volume_uid, code, `${label}.volume_uid`);
    positiveExportInteger(volume.sort_order, code, `${label}.sort_order`);
    exportString(volume.title, code, `${label}.title`);
    exportString(volume.summary, code, `${label}.summary`);
    if (volumeIds.has(volume.id) || volumeUids.has(volume.volume_uid)) {
      throw exportError(code, 'snapshot.volumes contains duplicate identities');
    }
    if (volume.sort_order <= previousVolumePosition) {
      throw exportError(code, 'snapshot.volumes is not in volume order');
    }
    previousVolumePosition = volume.sort_order;
    volumeIds.add(volume.id);
    volumeUids.add(volume.volume_uid);
    const members = frozenDenseExportArray(volume.chapters, code, `${label}.chapters`);
    let previousChapterPosition = 0;
    for (let memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
      const memberLabel = `${label}.chapters[${memberIndex}]`;
      const member = validateExportChapter(members[memberIndex], memberLabel);
      const canonical = chaptersByUid.get(member.chapter_uid);
      if (
        canonical === undefined
        || member.volume_id !== volume.id
        || !sameExportChapter(member, canonical)
        || assignedChapterUids.has(member.chapter_uid)
      ) throw exportError(code, `${memberLabel} does not match the active chapter list`);
      if (member.chapter_position <= previousChapterPosition) {
        throw exportError(code, `${label}.chapters is not in chapter order`);
      }
      previousChapterPosition = member.chapter_position;
      assignedChapterUids.add(member.chapter_uid);
    }
  }
  for (const chapter of chaptersByUid.values()) {
    if (chapter.volume_id === null) continue;
    if (!volumeIds.has(chapter.volume_id) || !assignedChapterUids.has(chapter.chapter_uid)) {
      throw exportError(code, 'snapshot contains a chapter outside its active volume');
    }
  }
  return snapshot;
}

function attachCleanupError(primaryError, cleanupError) {
  if ((typeof primaryError !== 'object' && typeof primaryError !== 'function') || primaryError === null) return;
  try {
    Object.defineProperty(primaryError, 'cleanupError', {
      value: cleanupError,
      configurable: true,
    });
  } catch {
    // Preserve the original generation/CAS error for custom frozen values.
  }
}

function projectIdentityForDiagnosticsExport(identity) {
  if (identity === null) return null;
  return {
    dev: identity.dev,
    ino: identity.ino,
  };
}

function projectControlPointForDiagnosticsExport(point) {
  if (point === null) return null;
  return {
    seq: point.seq,
    digest: point.digest,
  };
}

function projectControlEventForDiagnosticsExport(event) {
  return {
    seq: event.seq,
    type: event.type,
    digest: event.digest,
    prevDigest: event.prevDigest,
  };
}

function projectRecoveryDiagnosticsForExport(diagnostics) {
  return {
    state: diagnostics.state,
    reasonCode: diagnostics.reasonCode,
    protocol: diagnostics.protocol,
    backend: diagnostics.backend,
    schema: diagnostics.schema,
    triggerVersion: diagnostics.triggerVersion,
    expectedTriggerSetDigest: diagnostics.expectedTriggerSetDigest,
    projectMetaTriggerSetDigest: diagnostics.projectMetaTriggerSetDigest,
    observedTriggerSetDigest: diagnostics.observedTriggerSetDigest,
    dbIdentity: projectIdentityForDiagnosticsExport(diagnostics.dbIdentity),
    expectedIdentity: projectIdentityForDiagnosticsExport(diagnostics.expectedIdentity),
    projectInstanceIdSha256: diagnostics.projectInstanceIdSha256,
    currentSeq: diagnostics.currentSeq,
    expectedSeq: diagnostics.expectedSeq,
    controlStore: {
      tail: projectControlPointForDiagnosticsExport(diagnostics.controlStore.tail),
      checkpoint: projectControlPointForDiagnosticsExport(
        diagnostics.controlStore.checkpoint,
      ),
      events: diagnostics.controlStore.events.map(projectControlEventForDiagnosticsExport),
    },
    integrity: {
      integrityCheck: diagnostics.integrity.integrityCheck,
      foreignKeyCheck: diagnostics.integrity.foreignKeyCheck,
    },
    platformCapabilities: {
      backend: diagnostics.platformCapabilities.backend,
      exclusiveLease: diagnostics.platformCapabilities.exclusiveLease,
      directoryFsync: diagnostics.platformCapabilities.directoryFsync,
      atomicReplace: diagnostics.platformCapabilities.atomicReplace,
      verifiedAbsentInstall: diagnostics.platformCapabilities.verifiedAbsentInstall,
    },
    canAutoRecover: diagnostics.canAutoRecover,
    canAdoptIdentity: diagnostics.canAdoptIdentity,
    recommendedAction: diagnostics.recommendedAction,
    snapshot: diagnostics.snapshot,
  };
}

/**
 * Generate a project artifact away from its public filename, then publish it
 * only after the caller proves that the project incarnation is still current.
 */
async function publishGeneratedProjectFile({
  finalPath,
  generate,
  assertCurrent,
  capturePublished,
  fsApi = fs,
  createId = randomUUID,
}) {
  const tempPath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${createId()}.tmp`,
  );
  try {
    await generate(tempPath);
    await assertCurrent();
    fsApi.renameSync(tempPath, finalPath);
    // Capture the caller's response synchronously in the rename critical
    // section. Another concurrent export may reuse finalPath immediately after
    // this stack returns, but it cannot change the bytes already captured here.
    return typeof capturePublished === 'function' ? capturePublished(finalPath) : finalPath;
  } catch (error) {
    try {
      fsApi.unlinkSync(tempPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') attachCleanupError(error, cleanupError);
    }
    throw error;
  }
}

function projectExportRequest(value) {
  const code = 'INVALID_EXPORT_REQUEST';
  const request = exactExportData(
    value,
    ['snapshot', 'exportRoot', 'exportName', 'options', 'assertCurrent'],
    code,
    'project export request',
  );
  const snapshot = validateExportSnapshot(request.snapshot);
  const options = exactExportData(request.options, ['format'], code, 'project export options');
  if (typeof request.assertCurrent !== 'function') {
    throw exportError(code, 'assertCurrent must be a server-owned assertion function');
  }
  if (
    typeof request.exportRoot !== 'string'
    || !path.isAbsolute(request.exportRoot)
    || path.resolve(request.exportRoot) !== request.exportRoot
  ) throw exportError(code, 'exportRoot must be one canonical absolute path');
  if (
    typeof request.exportName !== 'string'
    || request.exportName.length === 0
    || request.exportName.length > 128
    || request.exportName.trim() !== request.exportName
    || path.posix.basename(request.exportName) !== request.exportName
    || path.win32.basename(request.exportName) !== request.exportName
    || path.posix.extname(request.exportName) !== ''
    || path.win32.extname(request.exportName) !== ''
    || /[\u0000-\u001f\u007f]/u.test(request.exportName)
    || /[<>:"/\\|?*]/u.test(request.exportName)
    || /[. ]$/u.test(request.exportName)
    || WINDOWS_RESERVED_NAME_PATTERN.test(request.exportName)
  ) throw exportError(code, 'exportName must be one safe canonical file stem');
  const normalizedFormat = options.format === 'markdown' ? 'md' : options.format;
  if (!['txt', 'md', 'html'].includes(normalizedFormat)) {
    throw exportError(code, 'project export format is unsupported');
  }
  return Object.freeze({
    snapshot,
    exportRoot: request.exportRoot,
    exportName: request.exportName,
    format: normalizedFormat,
    assertCurrent: request.assertCurrent,
  });
}

function ownMetadataString(metadata, key) {
  return Object.hasOwn(metadata, key) ? metadata[key] : '';
}

function projectExportView(snapshot, exportName) {
  const chapters = snapshot.chapters.filter((chapter) => chapter.content !== '');
  const volumesById = new Map(snapshot.volumes.map((volume) => [volume.id, volume]));
  const volumeKeys = new Set(chapters.map((chapter) => chapter.volume_id));
  const showVolumeHeadings = volumeKeys.size > 1;
  const volumeFor = (chapter) => (
    chapter.volume_id === null ? null : volumesById.get(chapter.volume_id) ?? null
  );
  const volumeLabel = (chapter) => volumeFor(chapter)?.title || '未分卷';
  const title = ownMetadataString(snapshot.metadata, 'name') || exportName;
  const author = ownMetadataString(snapshot.metadata, 'author_name') || '佚名';
  const description = ownMetadataString(snapshot.metadata, 'description');
  const wordCount = chapters.reduce(
    (total, chapter) => total + chapter.content.replace(/\s/gu, '').length,
    0,
  );
  return Object.freeze({
    author,
    chapters,
    description,
    showVolumeHeadings,
    title,
    volumeFor,
    volumeLabel,
    wordCount,
  });
}

function renderTextProjectExport(view) {
  let output = `${view.title}\n${'='.repeat(view.title.length || 10)}\n\n`;
  if (view.description) output += `${view.description}\n\n`;
  let previousVolume = Symbol('no-volume');
  for (const chapter of view.chapters) {
    const volumeKey = chapter.volume_id;
    if (view.showVolumeHeadings && previousVolume !== volumeKey) {
      const label = view.volumeLabel(chapter);
      const volume = view.volumeFor(chapter);
      output += `\n${label}\n${'='.repeat(Math.max(label.length, 4))}\n`;
      if (volume?.summary) output += `${volume.summary}\n`;
    }
    previousVolume = volumeKey;
    output += `\n第${chapter.num}章 ${chapter.title}\n${'-'.repeat(20)}\n\n${chapter.content.replace(/^#+/gmu, '').trim()}\n`;
  }
  return `${output}\n\n---\n共 ${view.chapters.length} 章 · ${view.wordCount} 字\n`;
}

function renderMarkdownProjectExport(view) {
  let output = `# ${view.title}\n\n${view.description ? `> ${view.description}\n\n` : ''}`;
  let previousVolume = Symbol('no-volume');
  for (const chapter of view.chapters) {
    const volumeKey = chapter.volume_id;
    if (view.showVolumeHeadings && previousVolume !== volumeKey) {
      const volume = view.volumeFor(chapter);
      output += `\n---\n\n# ${view.volumeLabel(chapter)}\n\n${volume?.summary ? `${volume.summary}\n` : ''}`;
    }
    previousVolume = volumeKey;
    output += `\n---\n\n## 第${chapter.num}章 ${chapter.title}\n\n${chapter.content}\n`;
  }
  return `${output}\n\n---\n共 ${view.chapters.length} 章 · ${view.wordCount} 字\n`;
}

function renderHtmlProjectExport(view) {
  let previousVolume = Symbol('no-volume');
  const htmlChapters = view.chapters.map((chapter) => {
    const volumeKey = chapter.volume_id;
    const volume = view.volumeFor(chapter);
    const volumeHeading = view.showVolumeHeadings && previousVolume !== volumeKey
      ? `<div class="volume"><h1>${view.volumeLabel(chapter)}</h1>${volume?.summary ? `<p>${volume.summary}</p>` : ''}</div>`
      : '';
    previousVolume = volumeKey;
    return `${volumeHeading}<div class="chapter"><h1>第${chapter.num}章 ${chapter.title}</h1>${chapter.content}</div>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${view.title}</title>
<style>
  @page { margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Noto Serif SC', 'Songti SC', serif; color: #333; background: #fff; line-height: 1.8; }
  .toc-page { page-break-after: always; padding: 40px; }
  .toc-page h1 { text-align: center; font-size: 24px; margin-bottom: 30px; }
  .toc-page ul { list-style: none; padding: 0; max-width: 500px; margin: 0 auto; }
  .toc-page li { padding: 8px 0; border-bottom: 1px solid #eee; font-size: 16px; }
  .volume { page-break-after: always; padding: 80px 40px; text-align: center; }
  .volume h1 { font-size: 28px; margin-bottom: 24px; }
  .chapter { page-break-after: always; padding: 40px; max-width: 700px; margin: 0 auto; }
  .chapter h1 { font-size: 22px; text-align: center; margin-bottom: 30px; padding-bottom: 15px; border-bottom: 2px solid #333; }
  .chapter p { text-indent: 2em; margin-bottom: 0.8em; font-size: 16px; }
  .chapter h1, .chapter h2, .chapter h3, .chapter h4 { text-indent: 0; }
</style>
</head>
<body>
<div class="toc-page">
  <h1>${view.title}</h1>
  <p style="text-align:center;color:#999;margin-bottom:30px;">${view.author} 著</p>
  <ul>${view.chapters.map((chapter) => `<li>${view.showVolumeHeadings ? `${view.volumeLabel(chapter)} · ` : ''}第${chapter.num}章 ${chapter.title}</li>`).join('')}</ul>
</div>
${htmlChapters}
</body>
</html>`;
}

function renderProjectExport(snapshot, exportName, format) {
  const view = projectExportView(snapshot, exportName);
  const mime = {
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
  }[format];
  const output = format === 'txt'
    ? renderTextProjectExport(view)
    : format === 'md'
      ? renderMarkdownProjectExport(view)
      : renderHtmlProjectExport(view);
  return Object.freeze({
    bytes: Buffer.from(output, 'utf8'),
    manifest: Object.freeze({
      format,
      mime,
      filename: `${exportName}.${format}`,
      wordCount: view.wordCount,
      chapterCount: view.chapters.length,
      projectionGeneration: snapshot.projectionGeneration,
    }),
  });
}

async function publishProjectExport(value) {
  const request = projectExportRequest(value);
  const rendered = renderProjectExport(request.snapshot, request.exportName, request.format);
  const exportDirectory = path.join(request.exportRoot, request.exportName);
  const finalPath = path.join(exportDirectory, rendered.manifest.filename);
  if (
    path.dirname(exportDirectory) !== request.exportRoot
    || path.dirname(finalPath) !== exportDirectory
  ) throw exportError('INVALID_EXPORT_REQUEST', 'derived export path escaped the export root');
  fs.mkdirSync(exportDirectory, { recursive: true });
  const bytes = await publishGeneratedProjectFile({
    finalPath,
    generate: tempPath => fs.writeFileSync(tempPath, rendered.bytes, { flag: 'wx', mode: 0o600 }),
    async assertCurrent() {
      const result = await request.assertCurrent(Object.freeze({
        projectionGeneration: request.snapshot.projectionGeneration,
      }));
      if (result !== undefined) {
        throw exportError(
          'INVALID_EXPORT_CURRENT_AUTHORITY',
          'assertCurrent must assert by throwing and resolve without a value',
        );
      }
    },
    capturePublished: publishedPath => fs.readFileSync(publishedPath),
  });
  return Object.freeze({
    bytes,
    manifest: rendered.manifest,
    filePath: finalPath,
  });
}

function publishOpaqueDiagnosticsExport({
  exportDir,
  diagnostics,
  currentDatabaseSha256,
  fsApi = fs,
  createId = randomUUID,
  fsyncDirectoryApi = fsyncDirectory,
}) {
  if (typeof exportDir !== 'string' || exportDir.length === 0) {
    throw new TypeError('Diagnostics export directory is required');
  }
  if (
    diagnostics === null
    || typeof diagnostics !== 'object'
    || Array.isArray(diagnostics)
  ) {
    throw new TypeError('Diagnostics export payload is required');
  }
  if (!SHA256_PATTERN.test(currentDatabaseSha256)) {
    throw new TypeError('Current database SHA-256 is invalid');
  }

  const finalId = createId();
  const tempId = createId();
  if (!UUID_V4_PATTERN.test(finalId) || !UUID_V4_PATTERN.test(tempId)) {
    throw new TypeError('Diagnostics export UUID is invalid');
  }
  const filename = `${finalId}.mythpen-diagnostics.json`;
  const finalPath = path.join(exportDir, filename);
  const tempPath = path.join(exportDir, `.${filename}.${tempId}.tmp`);
  const manifest = {
    format: 'mythpen-diagnostics',
    formatVersion: 1,
    diagnostics: projectRecoveryDiagnosticsForExport(diagnostics),
    currentDatabaseSha256,
  };
  const serialized = JSON.stringify(manifest);

  let descriptor = null;
  let tempExists = false;
  try {
    fsApi.mkdirSync(exportDir, { recursive: true });
    descriptor = fsApi.openSync(tempPath, 'wx', 0o600);
    tempExists = true;
    fsApi.writeFileSync(descriptor, serialized, 'utf8');
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = null;
    fsApi.linkSync(tempPath, finalPath);
    fsApi.unlinkSync(tempPath);
    tempExists = false;
    fsyncDirectoryApi(exportDir);
    return { filename };
  } catch (error) {
    if (descriptor !== null) {
      try {
        fsApi.closeSync(descriptor);
      } catch (cleanupError) {
        attachCleanupError(error, cleanupError);
      }
    }
    if (tempExists) {
      try {
        fsApi.unlinkSync(tempPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') attachCleanupError(error, cleanupError);
      }
    }
    throw error;
  }
}

module.exports = {
  publishGeneratedProjectFile,
  publishOpaqueDiagnosticsExport,
  publishProjectExport,
};
