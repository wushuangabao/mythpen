'use strict';

const path = require('node:path');

const {
  createTestFileBoundaryCapability,
  createTestJournalAuthorityCapability,
} = require('../../testing/manuscript-capability-mint');
const {
  deriveControlledFileRef,
  deriveManuscriptPaths,
  resolveControlledFileRef,
} = require('../../manuscript/paths');
const { serializeCanonicalJson } = require('../../manuscript/format');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const VOLUME_UID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_UID = '33333333-3333-4333-8333-333333333333';
const UNASSIGNED_CHAPTER_UID = '44444444-4444-4444-8444-444444444444';
const UNKNOWN_CHAPTER_UID = '55555555-5555-4555-8555-555555555555';
const UNKNOWN_VOLUME_UID = '66666666-6666-4666-8666-666666666666';

function identity(ino, dev = 1) {
  return Object.freeze({ dev: String(dev), ino: String(ino) });
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function refKey(ref) {
  if (ref.role === 'manuscript' || ref.role === 'unassigned') return ref.role;
  if (ref.role === 'volume_index') return `${ref.role}:${ref.volumeUid}`;
  return `${ref.role}:${ref.chapterUid}`;
}

function directoryRoleForRef(ref) {
  if (ref.role === 'manuscript' || ref.role === 'unassigned') return 'mythpen';
  if (ref.role === 'volume_index') return 'volumes';
  return 'chapters';
}

function resourceUidForRef(ref) {
  return ref.volumeUid ?? ref.chapterUid ?? null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSidecar(chapterUid, title) {
  return {
    format_version: 1,
    chapter_uid: chapterUid,
    title,
    outline: `${title}大纲`,
    status: 'pending',
    summary: `${title}摘要`,
    cognitive_frame: '',
    emotional_anchor: '',
    world_texture: '',
    concrete_mystery: '',
    interpersonal_tension: '',
  };
}

function defaultValues() {
  return {
    manuscript: {
      format_version: 1,
      project_uid: PROJECT_UID,
      volume_uids: [VOLUME_UID],
    },
    unassigned: {
      format_version: 1,
      kind: 'unassigned',
      chapter_uids: [UNASSIGNED_CHAPTER_UID],
    },
    volume: {
      format_version: 1,
      volume_uid: VOLUME_UID,
      title: '第一卷',
      summary: '卷摘要',
      chapter_uids: [CHAPTER_UID],
    },
    chapter: makeSidecar(CHAPTER_UID, '第一章'),
    unassignedChapter: makeSidecar(UNASSIGNED_CHAPTER_UID, '未分卷章'),
  };
}

function createManuscriptTreeFixture({ dataRoot, largeChapterPairs = 0 } = {}) {
  const root = dataRoot || path.join(path.parse(process.cwd()).root, 'mythpen-store-fixture');
  const paths = deriveManuscriptPaths({ dataRoot: root, projectUid: PROJECT_UID });
  const values = defaultValues();
  const refs = {
    manuscript: deriveControlledFileRef({ role: 'manuscript', projectUid: PROJECT_UID }),
    unassigned: deriveControlledFileRef({ role: 'unassigned', projectUid: PROJECT_UID }),
    volume: deriveControlledFileRef({
      role: 'volume_index',
      projectUid: PROJECT_UID,
      volumeUid: VOLUME_UID,
    }),
    chapterBody: deriveControlledFileRef({
      role: 'chapter_body',
      projectUid: PROJECT_UID,
      chapterUid: CHAPTER_UID,
    }),
    chapterSidecar: deriveControlledFileRef({
      role: 'chapter_sidecar',
      projectUid: PROJECT_UID,
      chapterUid: CHAPTER_UID,
    }),
    unassignedBody: deriveControlledFileRef({
      role: 'chapter_body',
      projectUid: PROJECT_UID,
      chapterUid: UNASSIGNED_CHAPTER_UID,
    }),
    unassignedSidecar: deriveControlledFileRef({
      role: 'chapter_sidecar',
      projectUid: PROJECT_UID,
      chapterUid: UNASSIGNED_CHAPTER_UID,
    }),
  };
  const directoryIdentities = Object.freeze({
    manuscripts: identity(9),
    article_root: identity(10),
    mythpen: identity(11),
    volumes: identity(12),
    chapters: identity(13),
  });
  const directoryParents = Object.freeze({
    article_root: directoryIdentities.manuscripts,
    mythpen: directoryIdentities.article_root,
    volumes: directoryIdentities.mythpen,
    chapters: directoryIdentities.mythpen,
  });
  const files = new Map();
  const pathKeys = new Map();
  const extras = {
    mythpen: [],
    volumes: [],
    chapters: [],
  };
  const ownedCandidates = new Map();
  const unsafeKeys = new Map();
  const readDriftKeys = new Set();
  const inspectDriftKeys = new Set();
  const inspectCounts = new Map();
  const enumerationFailures = new Map();
  const counters = {
    authorityLookups: [],
    contentOpens: 0,
    contentReads: 0,
    directoryInspects: [],
    enumerateCalls: [],
    iteratorNext: { mythpen: 0, volumes: 0, chapters: 0 },
    probes: [],
    inspectPaths: [],
    unexpectedSiblingLists: 0,
  };
  let nextFileIdentity = 100;

  function addFile(ref, bytes) {
    const key = refKey(ref);
    const source = Buffer.from(bytes);
    files.set(key, {
      actualName: path.basename(resolveControlledFileRef(paths, ref)),
      bytes: source,
      identity: identity(nextFileIdentity),
      parentIdentity: directoryIdentities[directoryRoleForRef(ref)],
      ref,
    });
    pathKeys.set(resolveControlledFileRef(paths, ref), key);
    nextFileIdentity += 1;
    return ref;
  }

  function addJson(ref, value) {
    return addFile(ref, serializeCanonicalJson(ref.role, clone(value)));
  }

  addJson(refs.manuscript, values.manuscript);
  addJson(refs.unassigned, values.unassigned);
  addJson(refs.volume, values.volume);
  addFile(refs.chapterBody, Buffer.from('第一章正文', 'utf8'));
  addJson(refs.chapterSidecar, values.chapter);
  addFile(refs.unassignedBody, Buffer.from('未分卷正文', 'utf8'));
  addJson(refs.unassignedSidecar, values.unassignedChapter);

  if (largeChapterPairs > 0) {
    for (const key of [...files.keys()]) {
      if (key.startsWith('chapter_')) files.delete(key);
    }
    values.volume.chapter_uids = [];
    values.unassigned.chapter_uids = [];
    addJson(refs.volume, values.volume);
    addJson(refs.unassigned, values.unassigned);
    for (let index = 0; index < largeChapterPairs; index += 1) {
      const suffix = index.toString(16).padStart(12, '0');
      const chapterUid = `00000000-0000-4000-8000-${suffix}`;
      addFile(deriveControlledFileRef({
        role: 'chapter_body',
        projectUid: PROJECT_UID,
        chapterUid,
      }), Buffer.alloc(0));
      addFile(deriveControlledFileRef({
        role: 'chapter_sidecar',
        projectUid: PROJECT_UID,
        chapterUid,
      }), Buffer.alloc(0));
    }
  }

  function namesFor(directoryRole) {
    const names = [];
    if (directoryRole === 'mythpen') names.push('volumes', 'chapters');
    for (const record of files.values()) {
      if (directoryRoleForRef(record.ref) === directoryRole) names.push(record.actualName);
    }
    names.push(...extras[directoryRole]);
    return names;
  }

  function directoryPath(directoryRole) {
    if (directoryRole === 'article_root') return paths.articleRoot;
    if (directoryRole === 'mythpen') return paths.mythpenRoot;
    if (directoryRole === 'volumes') return paths.volumesRoot;
    if (directoryRole === 'chapters') return paths.chaptersRoot;
    throw new TypeError('unknown fixture directory role');
  }

  function directoryObservation(directoryRole) {
    const targetPath = directoryPath(directoryRole);
    return {
      actualName: path.basename(targetPath),
      identity: directoryIdentities[directoryRole],
      kind: 'directory',
      linkCount: null,
      parentIdentity: directoryParents[directoryRole],
      parentRealPath: path.dirname(targetPath),
      realPath: targetPath,
      reparse: false,
    };
  }

  function findRecordByPath(targetPath) {
    const key = pathKeys.get(targetPath);
    return key === undefined ? null : (files.get(key) || null);
  }

  const fileBoundary = createTestFileBoundaryCapability({
    async inspectDirectory({ directoryRole }) {
      counters.directoryInspects.push(directoryRole);
      const observation = directoryObservation(directoryRole);
      return {
        identity: observation.identity,
        kind: observation.kind,
        parentIdentity: observation.parentIdentity,
        safe: true,
      };
    },
    enumerateDirectory({ directoryRole }) {
      counters.enumerateCalls.push(directoryRole);
      const snapshot = namesFor(directoryRole);
      return {
        async *[Symbol.asyncIterator]() {
          let emitted = 0;
          for (const actualName of snapshot) {
            const failure = enumerationFailures.get(directoryRole);
            if (failure !== undefined && emitted === failure.afterEntries) {
              const error = new Error('fixture enumeration failure');
              error.code = failure.code;
              throw error;
            }
            counters.iteratorNext[directoryRole] += 1;
            yield actualName;
            emitted += 1;
          }
        },
      };
    },
    async probeControlledFile({ controlledFileRef }) {
      const key = refKey(controlledFileRef);
      counters.probes.push(key);
      const record = files.get(key);
      if (record === undefined) {
        const error = new Error('fixture file missing');
        error.code = 'ENOENT';
        throw error;
      }
      const unsafe = unsafeKeys.get(key) || {};
      return {
        actualName: record.actualName,
        byteSize: record.bytes.length,
        identity: record.identity,
        kind: unsafe.kind || 'file',
        linkCount: unsafe.linkCount ?? 1,
        parentIdentity: record.parentIdentity,
        reparse: unsafe.reparse === true,
        safe: unsafe.safe !== false,
      };
    },
    inspectPath(targetPath) {
      counters.inspectPaths.push(targetPath);
      const directoryRole = Object.keys(directoryIdentities).find((role) => (
        role !== 'manuscripts' && directoryPath(role) === targetPath
      ));
      if (directoryRole) return directoryObservation(directoryRole);
      const record = findRecordByPath(targetPath);
      if (record === null) {
        const error = new Error('fixture path missing');
        error.code = 'ENOENT';
        throw error;
      }
      const key = refKey(record.ref);
      const count = (inspectCounts.get(key) || 0) + 1;
      inspectCounts.set(key, count);
      const unsafe = unsafeKeys.get(key) || {};
      const drifted = inspectDriftKeys.has(key) && count % 2 === 0;
      return {
        actualName: record.actualName,
        identity: drifted ? identity(999999) : record.identity,
        kind: unsafe.kind || 'file',
        linkCount: unsafe.linkCount ?? 1,
        parentIdentity: record.parentIdentity,
        parentRealPath: path.dirname(targetPath),
        realPath: targetPath,
        reparse: unsafe.reparse === true,
      };
    },
    listActualNames() {
      counters.unexpectedSiblingLists += 1;
      throw new Error('per-file sibling listing is forbidden');
    },
    async readControlledFile({ controlledFileRef }) {
      const key = refKey(controlledFileRef);
      counters.contentOpens += 1;
      const record = files.get(key);
      if (record === undefined) {
        const error = new Error('fixture file missing during read');
        error.code = 'ENOENT';
        throw error;
      }
      counters.contentReads += 1;
      return {
        byteSize: record.bytes.length,
        bytes: Buffer.from(record.bytes),
        identity: readDriftKeys.has(key) ? identity(888888) : record.identity,
        parentIdentity: record.parentIdentity,
        stable: !readDriftKeys.has(key),
      };
    },
  });

  function candidateKey({ projectUid, journalId, targetRef, actualName }) {
    return `${projectUid}|${journalId}|${refKey(targetRef)}|${actualName}`;
  }

  const journalAuthority = createTestJournalAuthorityCapability({
    async resolveCandidate(input) {
      counters.authorityLookups.push({
        actualName: input.actualName,
        journalId: input.journalId,
        projectUid: input.projectUid,
        targetKey: refKey(input.targetRef),
      });
      return ownedCandidates.get(candidateKey(input)) || null;
    },
  });

  function ref(role, uid) {
    if (role === 'manuscript' || role === 'unassigned') {
      return deriveControlledFileRef({ role, projectUid: PROJECT_UID });
    }
    if (role === 'volume_index') {
      return deriveControlledFileRef({ role, projectUid: PROJECT_UID, volumeUid: uid });
    }
    return deriveControlledFileRef({ role, projectUid: PROJECT_UID, chapterUid: uid });
  }

  const controls = {
    addCandidate(targetRef, journalId, { owned = false, evidenceId = `proof-${journalId}` } = {}) {
      const directoryRole = directoryRoleForRef(targetRef);
      const actualName = `${path.basename(resolveControlledFileRef(paths, targetRef))}.${journalId}.tmp`;
      extras[directoryRole].push(actualName);
      if (owned) {
        ownedCandidates.set(candidateKey({
          projectUid: PROJECT_UID,
          journalId,
          targetRef,
          actualName,
        }), Object.freeze({ evidenceId, state: 'open' }));
      }
      return actualName;
    },
    addChapter(chapterUid, { body = '外部正文', sidecar = makeSidecar(chapterUid, '外部章节') } = {}) {
      const bodyRef = ref('chapter_body', chapterUid);
      const sidecarRef = ref('chapter_sidecar', chapterUid);
      addFile(bodyRef, Buffer.from(body, 'utf8'));
      addJson(sidecarRef, sidecar);
      return { bodyRef, sidecarRef };
    },
    addResidue(directoryRole, actualName) {
      extras[directoryRole].push(actualName);
    },
    addVolume(volumeUid, value = {
      format_version: 1,
      volume_uid: volumeUid,
      title: '外部卷',
      summary: '',
      chapter_uids: [],
    }) {
      const volumeRef = ref('volume_index', volumeUid);
      addJson(volumeRef, value);
      return volumeRef;
    },
    calls() {
      return {
        authorityLookups: counters.authorityLookups.map((entry) => ({ ...entry })),
        contentOpens: counters.contentOpens,
        contentReads: counters.contentReads,
        directoryInspects: [...counters.directoryInspects],
        enumerateCalls: [...counters.enumerateCalls],
        inspectPaths: [...counters.inspectPaths],
        iteratorNext: { ...counters.iteratorNext },
        probes: [...counters.probes],
        unexpectedSiblingLists: counters.unexpectedSiblingLists,
      };
    },
    deleteFile(targetRef) {
      pathKeys.delete(resolveControlledFileRef(paths, targetRef));
      files.delete(refKey(targetRef));
    },
    failEnumerationAfter(directoryRole, afterEntries, code = 'EIO') {
      if (
        !Object.hasOwn(extras, directoryRole)
        || !Number.isSafeInteger(afterEntries)
        || afterEntries < 0
        || typeof code !== 'string'
        || code.length === 0
      ) {
        throw new TypeError('invalid fixture enumeration failure');
      }
      enumerationFailures.set(directoryRole, { afterEntries, code });
    },
    ref,
    setBytes(targetRef, bytes) {
      const record = files.get(refKey(targetRef));
      if (record === undefined) throw new Error('fixture target is missing');
      record.bytes = Buffer.from(bytes);
    },
    setInspectDrift(targetRef, enabled = true) {
      if (enabled) inspectDriftKeys.add(refKey(targetRef));
      else inspectDriftKeys.delete(refKey(targetRef));
    },
    setJson(targetRef, value) {
      this.setBytes(targetRef, serializeCanonicalJson(targetRef.role, clone(value)));
    },
    setReadDrift(targetRef, enabled = true) {
      if (enabled) readDriftKeys.add(refKey(targetRef));
      else readDriftKeys.delete(refKey(targetRef));
    },
    setUnsafe(targetRef, unsafe) {
      unsafeKeys.set(refKey(targetRef), { ...unsafe });
    },
  };

  return {
    controls,
    dataRoot: root,
    fileBoundary,
    ignoredLedger: Object.freeze({ entries: Object.freeze([]) }),
    journalAuthority,
    lifecycleBasis: Object.freeze({
      activeChapterUids: Object.freeze([CHAPTER_UID, UNASSIGNED_CHAPTER_UID]),
      chapterTombstoneUids: Object.freeze([]),
      activeVolumeUids: Object.freeze([VOLUME_UID]),
      volumeTombstoneUids: Object.freeze([]),
    }),
    paths,
    projectBinding: Object.freeze({
      articleRootIdentity: directoryIdentities.article_root,
      projectUid: PROJECT_UID,
    }),
    refs,
    values,
  };
}

module.exports = {
  CHAPTER_UID,
  PROJECT_UID,
  UNASSIGNED_CHAPTER_UID,
  UNKNOWN_CHAPTER_UID,
  UNKNOWN_VOLUME_UID,
  VOLUME_UID,
  createManuscriptTreeFixture,
  identity,
  makeSidecar,
  refKey,
  resourceUidForRef,
  sameIdentity,
};
