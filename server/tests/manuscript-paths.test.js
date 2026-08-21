'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const manuscriptPaths = require('../manuscript/paths');
const {
  assertControlledFileRef,
  classifyTreeEntry,
  createDirectoryNameIndex,
  deriveChapterPaths,
  deriveControlledFileRef,
  deriveManuscriptPaths,
  deriveVolumePath,
  resolveControlledFileRef,
  verifyManuscriptPathIdentity,
} = manuscriptPaths;

const PROJECT_UID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_PROJECT_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VOLUME_UID = '223e4567-e89b-42d3-b456-426614174001';
const CHAPTER_UID = '323e4567-e89b-42d3-8456-426614174002';
const JOURNAL_ID = 'journal-run_01';

function fixturePaths() {
  const dataRoot = path.join(path.parse(process.cwd()).root, 'mythpen-path-contract');
  return {
    dataRoot,
    paths: deriveManuscriptPaths({ dataRoot, projectUid: PROJECT_UID }),
  };
}

function identity(dev, ino) {
  return Object.freeze({ dev: String(dev), ino: String(ino) });
}

function observation({
  targetPath,
  actualName = path.basename(targetPath),
  realPath = targetPath,
  parentRealPath = path.dirname(targetPath),
  targetIdentity = identity('11', '13'),
  parentIdentity = identity('5', '7'),
  kind = 'file',
  reparse = false,
  linkCount = kind === 'file' ? 1 : null,
} = {}) {
  return {
    actualName,
    identity: targetIdentity,
    kind,
    linkCount,
    parentIdentity,
    parentRealPath,
    realPath,
    reparse,
  };
}

function identityBoundary({ before, after = before, actualNames = [before.actualName] }) {
  let inspections = 0;
  const calls = [];
  return {
    calls,
    inspectPath(targetPath) {
      calls.push(['inspectPath', targetPath]);
      inspections += 1;
      return inspections === 1 ? before : after;
    },
    listActualNames(parentPath) {
      calls.push(['listActualNames', parentPath]);
      return actualNames.slice();
    },
  };
}

function assertManuscriptCode(callback, code) {
  assert.throws(callback, (error) => error?.code === code && error.message === code);
}

function generatedChapterUid(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

test('derives the fixed manuscript layout only from an absolute data root and canonical UUIDs', () => {
  const { dataRoot, paths } = fixturePaths();
  const manuscriptsRoot = path.join(dataRoot, 'manuscripts');
  const articleRoot = path.join(manuscriptsRoot, PROJECT_UID);
  const mythpenRoot = path.join(articleRoot, 'mythpen');

  assert.deepEqual(paths, {
    articleRoot,
    chaptersRoot: path.join(mythpenRoot, 'chapters'),
    dataRoot,
    manuscriptPath: path.join(mythpenRoot, 'manuscript.json'),
    manuscriptsRoot,
    mythpenRoot,
    projectUid: PROJECT_UID,
    unassignedPath: path.join(mythpenRoot, 'unassigned.json'),
    volumesRoot: path.join(mythpenRoot, 'volumes'),
  });
  assert.equal(Object.isFrozen(paths), true);
  assert.equal(deriveVolumePath(paths, VOLUME_UID), path.join(mythpenRoot, 'volumes', `vol_${VOLUME_UID}.json`));
  const chapterPaths = deriveChapterPaths(paths, CHAPTER_UID);
  assert.deepEqual(chapterPaths, {
    bodyPath: path.join(mythpenRoot, 'chapters', `ch_${CHAPTER_UID}.md`),
    sidecarPath: path.join(mythpenRoot, 'chapters', `ch_${CHAPTER_UID}.json`),
  });
  assert.equal(Object.isFrozen(chapterPaths), true);

  for (const projectUid of [
    PROJECT_UID.toUpperCase(),
    PROJECT_UID.replace(/^1/, '2').replace('-4', '-1'),
    `../${PROJECT_UID}`,
    PROJECT_UID.replaceAll('-', ''),
  ]) {
    assertManuscriptCode(
      () => deriveManuscriptPaths({ dataRoot, projectUid }),
      'MANUSCRIPT_FILESET_INVALID',
    );
  }
  assert.throws(
    () => deriveManuscriptPaths({ dataRoot: 'relative-root', projectUid: PROJECT_UID }),
    TypeError,
  );
  assert.throws(
    () => deriveManuscriptPaths({
      dataRoot: `${dataRoot}${path.sep}nested${path.sep}..`,
      projectUid: PROJECT_UID,
    }),
    TypeError,
  );
  assert.throws(
    () => deriveVolumePath({ ...paths }, VOLUME_UID),
    TypeError,
  );
  assertManuscriptCode(
    () => deriveChapterPaths(paths, CHAPTER_UID.toUpperCase()),
    'MANUSCRIPT_FILESET_INVALID',
  );
});

test('controlled file refs are frozen branded role and UID records with no caller path channel', () => {
  const { paths } = fixturePaths();
  const valid = [
    [{ role: 'manuscript', projectUid: PROJECT_UID }, paths.manuscriptPath],
    [{ role: 'unassigned', projectUid: PROJECT_UID }, paths.unassignedPath],
    [
      { role: 'volume_index', projectUid: PROJECT_UID, volumeUid: VOLUME_UID },
      deriveVolumePath(paths, VOLUME_UID),
    ],
    [
      { role: 'chapter_body', projectUid: PROJECT_UID, chapterUid: CHAPTER_UID },
      deriveChapterPaths(paths, CHAPTER_UID).bodyPath,
    ],
    [
      { role: 'chapter_sidecar', projectUid: PROJECT_UID, chapterUid: CHAPTER_UID },
      deriveChapterPaths(paths, CHAPTER_UID).sidecarPath,
    ],
  ];

  for (const [input, expectedPath] of valid) {
    const ref = deriveControlledFileRef(input);
    assert.deepEqual(ref, input);
    assert.equal(Object.isFrozen(ref), true);
    assert.equal(assertControlledFileRef(ref), ref);
    assert.equal(resolveControlledFileRef(paths, ref), expectedPath);
    assert.throws(() => assertControlledFileRef({ ...ref }), TypeError);
  }

  for (const extra of [
    { path: 'chapters/escape.md' },
    { filename: `ch_${CHAPTER_UID}.md` },
    { glob: '*.md' },
    { directoryMap: { chapters: 'elsewhere' } },
    { relativePath: `chapters${path.sep}ch_${CHAPTER_UID}.md` },
  ]) {
    assert.throws(
      () => deriveControlledFileRef({ role: 'manuscript', projectUid: PROJECT_UID, ...extra }),
      TypeError,
    );
  }

  for (const input of [
    { role: 'unknown', projectUid: PROJECT_UID },
    { role: 'manuscript', projectUid: PROJECT_UID, volumeUid: VOLUME_UID },
    { role: 'volume_index', projectUid: PROJECT_UID },
    { role: 'volume_index', projectUid: PROJECT_UID, chapterUid: CHAPTER_UID },
    { role: 'chapter_body', projectUid: PROJECT_UID },
    {
      role: 'chapter_body',
      projectUid: PROJECT_UID,
      chapterUid: CHAPTER_UID,
      volumeUid: VOLUME_UID,
    },
    { role: 'chapter_sidecar', projectUid: PROJECT_UID, volumeUid: VOLUME_UID },
  ]) {
    assert.throws(() => deriveControlledFileRef(input), TypeError);
  }

  assertManuscriptCode(
    () => deriveControlledFileRef({
      role: 'chapter_body',
      projectUid: PROJECT_UID,
      chapterUid: `..${path.sep}${CHAPTER_UID}`,
    }),
    'MANUSCRIPT_FILESET_INVALID',
  );
  const foreignRef = deriveControlledFileRef({
    role: 'manuscript',
    projectUid: OTHER_PROJECT_UID,
  });
  assert.throws(() => resolveControlledFileRef(paths, foreignRef), TypeError);
});

test('classifies five canonical shapes, opaque journal candidate shapes, and residue exactly', () => {
  const canonical = [
    ['mythpen', 'manuscript.json', { classification: 'canonical_shape', role: 'manuscript' }],
    ['mythpen', 'unassigned.json', { classification: 'canonical_shape', role: 'unassigned' }],
    [
      'volumes',
      `vol_${VOLUME_UID}.json`,
      { classification: 'canonical_shape', role: 'volume_index', volumeUid: VOLUME_UID },
    ],
    [
      'chapters',
      `ch_${CHAPTER_UID}.md`,
      { chapterUid: CHAPTER_UID, classification: 'canonical_shape', role: 'chapter_body' },
    ],
    [
      'chapters',
      `ch_${CHAPTER_UID}.json`,
      { chapterUid: CHAPTER_UID, classification: 'canonical_shape', role: 'chapter_sidecar' },
    ],
  ];

  for (const [directoryRole, actualName, expected] of canonical) {
    const classified = classifyTreeEntry({ directoryRole, actualName });
    assert.deepEqual(classified, expected);
    assert.equal(Object.isFrozen(classified), true);

    const candidate = classifyTreeEntry({
      directoryRole,
      actualName: `${actualName}.${JOURNAL_ID}.tmp`,
    });
    assert.deepEqual(candidate, {
      ...expected,
      classification: 'journal_candidate_shape',
      journalId: JOURNAL_ID,
      requiresJournalEvidence: true,
    });
    assert.equal(Object.isFrozen(candidate), true);
  }

  for (const [directoryRole, actualName] of [
    ['chapters', `ch_${CHAPTER_UID}.md~`],
    ['chapters', `.ch_${CHAPTER_UID}.md.swp`],
    ['chapters', `ch_${CHAPTER_UID}.md.bak`],
    ['chapters', `ch_${CHAPTER_UID} - 副本.md`],
    ['chapters', `.#ch_${CHAPTER_UID}.md`],
    ['mythpen', 'desktop.ini'],
    ['mythpen', 'Thumbs.db'],
    ['mythpen', '.DS_Store'],
    ['chapters', `ch_${CHAPTER_UID}.md..tmp`],
    ['chapters', `ch_${CHAPTER_UID}.md.journal.part.tmp`],
    ['volumes', `ch_${CHAPTER_UID}.md`],
  ]) {
    assert.deepEqual(
      classifyTreeEntry({ directoryRole, actualName }),
      { classification: 'uncontrolled_residue' },
      actualName,
    );
  }
});

test('classification hard-fails canonical aliases instead of treating them as residue', () => {
  for (const [directoryRole, actualName] of [
    ['mythpen', 'MANUSCRIPT.JSON'],
    ['mythpen', 'manuscript.json.'],
    ['mythpen', 'unassigned.json '],
    ['mythpen', 'ｍａｎｕｓｃｒｉｐｔ．ｊｓｏｎ'],
    ['volumes', `vol_${VOLUME_UID.toUpperCase()}.json`],
    ['chapters', `CH_${CHAPTER_UID}.MD`],
    ['chapters', `ch_${CHAPTER_UID}.json.${JOURNAL_ID}.TMP`],
  ]) {
    assertManuscriptCode(
      () => classifyTreeEntry({ directoryRole, actualName }),
      'MANUSCRIPT_FILESET_INVALID',
    );
  }
  assert.throws(
    () => classifyTreeEntry({ directoryRole: 'elsewhere', actualName: 'manuscript.json' }),
    TypeError,
  );
  assert.throws(
    () => classifyTreeEntry({ directoryRole: 'chapters', actualName: `nested/ch_${CHAPTER_UID}.md` }),
    TypeError,
  );
});

test('directory name index snapshots twenty thousand names once and serves O(1) exact lookups', () => {
  assert.equal(typeof manuscriptPaths.createDirectoryNameIndex, 'function');
  const { paths } = fixturePaths();
  const parentIdentity = identity('101', '103');
  const actualNames = [`ch_${CHAPTER_UID}.md`, `ch_${CHAPTER_UID}.json`];
  for (let index = 0; index < 9_999; index += 1) {
    const chapterUid = generatedChapterUid(index);
    actualNames.push(`ch_${chapterUid}.md`, `ch_${chapterUid}.json`);
  }

  const nameIndex = createDirectoryNameIndex({
    actualNames,
    directoryRole: 'chapters',
    parentIdentity,
    paths,
    scanEpoch: 7,
  });

  assert.deepEqual(nameIndex, {
    entryCount: 20_000,
    foldEvaluations: 20_000,
  });
  assert.equal(Object.isFrozen(nameIndex), true);

  const ref = deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_UID,
  });
  const targetPath = resolveControlledFileRef(paths, ref);
  const targetIdentity = identity('113', '127');
  const before = observation({ targetPath, targetIdentity, parentIdentity });
  const boundary = identityBoundary({ before, actualNames });
  for (let repetition = 0; repetition < 2; repetition += 1) {
    verifyManuscriptPathIdentity({
      controlledFileRef: ref,
      directoryNameIndex: nameIndex,
      expectedIdentity: targetIdentity,
      expectedParentIdentity: parentIdentity,
      identityBoundary: boundary,
      paths,
      scanEpoch: 7,
      targetRole: 'controlled_file',
    });
  }
  assert.deepEqual(boundary.calls, [
    ['inspectPath', targetPath],
    ['inspectPath', targetPath],
    ['inspectPath', targetPath],
    ['inspectPath', targetPath],
  ]);
});

test('directory name index rejects aliases collisions and non-data name arrays while building', () => {
  assert.equal(typeof manuscriptPaths.createDirectoryNameIndex, 'function');
  const { paths } = fixturePaths();
  const parentIdentity = identity('107', '109');
  const canonicalName = `ch_${CHAPTER_UID}.md`;
  const build = (actualNames) => manuscriptPaths.createDirectoryNameIndex({
    actualNames,
    directoryRole: 'chapters',
    parentIdentity,
    paths,
    scanEpoch: 11,
  });

  for (const actualNames of [
    [canonicalName.toUpperCase()],
    [`${canonicalName}.`],
    [canonicalName, canonicalName.toUpperCase()],
    ['README', 'readme'],
  ]) {
    assertManuscriptCode(() => build(actualNames), 'MANUSCRIPT_FILESET_INVALID');
  }

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => build(sparse), TypeError);
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    get() {
      throw new Error('must not invoke caller accessors');
    },
  });
  assert.throws(
    () => build(accessor),
    (error) => error instanceof TypeError && error.message !== 'must not invoke caller accessors',
  );
});

test('opaque journal candidate casing is exact while its folded sibling still collides', () => {
  const { paths } = fixturePaths();
  const parentIdentity = identity('163', '167');
  const targetName = `ch_${CHAPTER_UID}.md`;
  const candidate = `${targetName}.JournalABC.tmp`;
  const foldedSibling = `${targetName}.journalabc.tmp`;
  const build = (actualNames) => createDirectoryNameIndex({
    actualNames,
    directoryRole: 'chapters',
    parentIdentity,
    paths,
    scanEpoch: 31,
  });

  const outcomes = [
    [candidate],
    [candidate, foldedSibling],
  ].map((actualNames) => {
    try {
      return `accepted:${build(actualNames).entryCount}`;
    } catch (error) {
      return error?.code;
    }
  });

  assert.deepEqual(outcomes, ['accepted:1', 'MANUSCRIPT_FILESET_INVALID']);
});

test('identity verification derives targets from branded paths and refs and returns a stable snapshot', () => {
  const { paths } = fixturePaths();
  const ref = deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_UID,
  });
  const targetPath = resolveControlledFileRef(paths, ref);
  const targetIdentity = identity('11', '13');
  const parentIdentity = identity('5', '7');
  const before = observation({ targetPath, targetIdentity, parentIdentity });
  const boundary = identityBoundary({ before });
  const scanEpoch = 17;
  const directoryNameIndex = createDirectoryNameIndex({
    actualNames: [path.basename(targetPath)],
    directoryRole: 'chapters',
    parentIdentity,
    paths,
    scanEpoch,
  });

  const verified = verifyManuscriptPathIdentity({
    controlledFileRef: ref,
    directoryNameIndex,
    expectedIdentity: targetIdentity,
    expectedParentIdentity: parentIdentity,
    identityBoundary: boundary,
    paths,
    scanEpoch,
    targetRole: 'controlled_file',
  });

  assert.deepEqual(verified, {
    identity: targetIdentity,
    kind: 'file',
    parentIdentity,
    path: targetPath,
    realPath: targetPath,
    targetRole: 'controlled_file',
  });
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.identity), true);
  assert.equal(Object.isFrozen(verified.parentIdentity), true);
  assert.deepEqual(boundary.calls, [
    ['inspectPath', targetPath],
    ['inspectPath', targetPath],
  ]);

  const directoryPath = paths.chaptersRoot;
  const directoryIdentity = identity('17', '19');
  const directoryParentIdentity = identity('23', '29');
  const directoryObservation = observation({
    targetPath: directoryPath,
    targetIdentity: directoryIdentity,
    parentIdentity: directoryParentIdentity,
    kind: 'directory',
  });
  const directoryBoundary = identityBoundary({ before: directoryObservation });
  const directoryScanEpoch = 19;
  const mythpenNameIndex = createDirectoryNameIndex({
    actualNames: ['manuscript.json', 'unassigned.json', 'volumes', 'chapters'],
    directoryRole: 'mythpen',
    parentIdentity: directoryParentIdentity,
    paths,
    scanEpoch: directoryScanEpoch,
  });
  assert.deepEqual(
    verifyManuscriptPathIdentity({
      directoryNameIndex: mythpenNameIndex,
      expectedIdentity: directoryIdentity,
      expectedParentIdentity: directoryParentIdentity,
      identityBoundary: directoryBoundary,
      paths,
      scanEpoch: directoryScanEpoch,
      targetRole: 'chapters_directory',
    }),
    {
      identity: directoryIdentity,
      kind: 'directory',
      parentIdentity: directoryParentIdentity,
      path: directoryPath,
      realPath: directoryPath,
      targetRole: 'chapters_directory',
    },
  );

  assert.throws(
    () => verifyManuscriptPathIdentity({
      controlledFileRef: ref,
      expectedIdentity: targetIdentity,
      expectedParentIdentity: parentIdentity,
      identityBoundary: boundary,
      paths,
      targetPath: 'caller-supplied-path',
      targetRole: 'controlled_file',
    }),
    TypeError,
  );
});

test('identity verification rejects cloned or cross-context name indexes before inspection', () => {
  const { dataRoot, paths } = fixturePaths();
  const ref = deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_UID,
  });
  const targetPath = resolveControlledFileRef(paths, ref);
  const expectedName = path.basename(targetPath);
  const targetIdentity = identity('131', '137');
  const parentIdentity = identity('139', '149');
  const scanEpoch = 29;
  const matchingIndex = createDirectoryNameIndex({
    actualNames: [expectedName],
    directoryRole: 'chapters',
    parentIdentity,
    paths,
    scanEpoch,
  });
  const foreignPaths = deriveManuscriptPaths({ dataRoot, projectUid: PROJECT_UID });
  const cases = [
    {
      label: 'plain clone',
      directoryNameIndex: { ...matchingIndex },
      paths,
      scanEpoch,
    },
    {
      label: 'cross directory',
      directoryNameIndex: createDirectoryNameIndex({
        actualNames: [expectedName],
        directoryRole: 'volumes',
        parentIdentity,
        paths,
        scanEpoch,
      }),
      paths,
      scanEpoch,
    },
    {
      label: 'cross epoch',
      directoryNameIndex: matchingIndex,
      paths,
      scanEpoch: scanEpoch + 1,
    },
    {
      label: 'cross paths capability',
      directoryNameIndex: createDirectoryNameIndex({
        actualNames: [expectedName],
        directoryRole: 'chapters',
        parentIdentity,
        paths: foreignPaths,
        scanEpoch,
      }),
      paths,
      scanEpoch,
    },
    {
      label: 'cross parent identity',
      directoryNameIndex: createDirectoryNameIndex({
        actualNames: [expectedName],
        directoryRole: 'chapters',
        parentIdentity: identity('151', '157'),
        paths,
        scanEpoch,
      }),
      paths,
      scanEpoch,
    },
  ];

  const outcomes = cases.map((entry) => {
    const before = observation({ targetPath, targetIdentity, parentIdentity });
    const boundary = identityBoundary({ before });
    let outcome = 'accepted';
    try {
      verifyManuscriptPathIdentity({
        controlledFileRef: ref,
        directoryNameIndex: entry.directoryNameIndex,
        expectedIdentity: targetIdentity,
        expectedParentIdentity: parentIdentity,
        identityBoundary: boundary,
        paths: entry.paths,
        scanEpoch: entry.scanEpoch,
        targetRole: 'controlled_file',
      });
    } catch (error) {
      outcome = error instanceof TypeError ? 'rejected' : `wrong:${error?.code}`;
    }
    return [entry.label, outcome, boundary.calls.length];
  });

  assert.deepEqual(outcomes, cases.map(({ label }) => [label, 'rejected', 0]));
});

test('identity verification rejects aliases collisions reparse links and physical drift', () => {
  const { paths } = fixturePaths();
  const ref = deriveControlledFileRef({
    role: 'chapter_sidecar',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_UID,
  });
  const targetPath = resolveControlledFileRef(paths, ref);
  const targetIdentity = identity('31', '37');
  const parentIdentity = identity('41', '43');
  const baseline = observation({ targetPath, targetIdentity, parentIdentity });
  const scanEpoch = 23;
  const directoryNameIndex = createDirectoryNameIndex({
    actualNames: [path.basename(targetPath)],
    directoryRole: 'chapters',
    parentIdentity,
    paths,
    scanEpoch,
  });

  function verify(boundary, overrides = {}) {
    return verifyManuscriptPathIdentity({
      controlledFileRef: ref,
      directoryNameIndex,
      expectedIdentity: targetIdentity,
      expectedParentIdentity: parentIdentity,
      identityBoundary: boundary,
      paths,
      scanEpoch,
      targetRole: 'controlled_file',
      ...overrides,
    });
  }

  const missingNameIndex = createDirectoryNameIndex({
    actualNames: ['unrelated.txt'],
    directoryRole: 'chapters',
    parentIdentity,
    paths,
    scanEpoch,
  });
  for (const [label, boundary, overrides] of [
    [
      'actual name case alias',
      identityBoundary({
        before: { ...baseline, actualName: baseline.actualName.toUpperCase() },
      }),
    ],
    [
      'missing actual entry',
      identityBoundary({ before: baseline }),
      { directoryNameIndex: missingNameIndex },
    ],
  ]) {
    assertManuscriptCode(
      () => verify(boundary, overrides),
      'MANUSCRIPT_FILESET_INVALID',
      label,
    );
  }

  const unsafe = [
    ['reparse file', { ...baseline, reparse: true }, baseline],
    ['wrong type', { ...baseline, kind: 'directory', linkCount: null }, baseline],
    ['multiple links', { ...baseline, linkCount: 2 }, baseline],
    ['wrong real path', { ...baseline, realPath: `${targetPath}.alias` }, baseline],
    [
      'wrong parent real path',
      { ...baseline, parentRealPath: path.dirname(paths.mythpenRoot) },
      baseline,
    ],
    [
      'target identity drift',
      baseline,
      { ...baseline, identity: identity('47', '53') },
    ],
    [
      'parent identity drift',
      baseline,
      { ...baseline, parentIdentity: identity('59', '61') },
    ],
    [
      'real path drift',
      baseline,
      { ...baseline, realPath: `${targetPath}.replacement` },
    ],
  ];
  for (const [label, before, after] of unsafe) {
    assertManuscriptCode(
      () => verify(identityBoundary({ before, after })),
      'MANUSCRIPT_PATH_UNSAFE',
      label,
    );
  }

  assertManuscriptCode(
    () => verify(identityBoundary({ before: baseline }), {
      expectedIdentity: identity('67', '71'),
    }),
    'MANUSCRIPT_PATH_UNSAFE',
  );
  assertManuscriptCode(
    () => verify(identityBoundary({
      before: { ...baseline, parentIdentity: identity('73', '79') },
    })),
    'MANUSCRIPT_PATH_UNSAFE',
  );
});
