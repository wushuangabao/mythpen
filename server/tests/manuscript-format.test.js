'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  inspectMarkdown,
  parseCanonicalJson,
  serializeCanonicalJson,
} = require('../manuscript/format');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const VOLUME_UID = '22222222-2222-4222-8222-222222222222';
const OTHER_VOLUME_UID = '44444444-4444-4444-8444-444444444444';
const CHAPTER_UID = '33333333-3333-4333-8333-333333333333';
const OTHER_CHAPTER_UID = '55555555-5555-4555-8555-555555555555';

const VALUES = Object.freeze({
  manuscript: {
    format_version: 1,
    project_uid: PROJECT_UID,
    volume_uids: [VOLUME_UID],
  },
  unassigned: {
    format_version: 1,
    kind: 'unassigned',
    chapter_uids: [CHAPTER_UID],
  },
  volume_index: {
    format_version: 1,
    volume_uid: VOLUME_UID,
    title: '卷一',
    summary: '卷摘要',
    chapter_uids: [CHAPTER_UID],
  },
  chapter_sidecar: {
    format_version: 1,
    chapter_uid: CHAPTER_UID,
    title: '章节标题',
    outline: '章节大纲',
    status: 'pending',
    summary: '章节摘要',
    cognitive_frame: '',
    emotional_anchor: '',
    world_texture: '',
    concrete_mystery: '',
    interpersonal_tension: '',
  },
});

const EXPECTED_UIDS = Object.freeze({
  manuscript: PROJECT_UID,
  unassigned: undefined,
  volume_index: VOLUME_UID,
  chapter_sidecar: CHAPTER_UID,
});

function clone(value) {
  return structuredClone(value);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test('four authoritative JSON roles serialize to their exact schemas and parse round-trip', () => {
  const expected = {
    manuscript: `{
  "format_version": 1,
  "project_uid": "${PROJECT_UID}",
  "volume_uids": [
    "${VOLUME_UID}"
  ]
}
`,
    unassigned: `{
  "format_version": 1,
  "kind": "unassigned",
  "chapter_uids": [
    "${CHAPTER_UID}"
  ]
}
`,
    volume_index: `{
  "format_version": 1,
  "volume_uid": "${VOLUME_UID}",
  "title": "卷一",
  "summary": "卷摘要",
  "chapter_uids": [
    "${CHAPTER_UID}"
  ]
}
`,
    chapter_sidecar: `{
  "format_version": 1,
  "chapter_uid": "${CHAPTER_UID}",
  "title": "章节标题",
  "outline": "章节大纲",
  "status": "pending",
  "summary": "章节摘要",
  "cognitive_frame": "",
  "emotional_anchor": "",
  "world_texture": "",
  "concrete_mystery": "",
  "interpersonal_tension": ""
}
`,
  };

  for (const role of Object.keys(VALUES)) {
    const bytes = serializeCanonicalJson(role, clone(VALUES[role]));
    assert.equal(Buffer.isBuffer(bytes), true, role);
    assert.equal(bytes.toString('utf8'), expected[role], role);
    assert.equal(bytes.includes(0x0d), false, role);
    assert.deepEqual(
      parseCanonicalJson({ role, bytes, expectedUid: EXPECTED_UIDS[role] }),
      VALUES[role],
      role,
    );
  }
});

test('canonical JSON parser rejects BOM, invalid UTF-8, noncanonical layout and duplicate object keys', () => {
  const canonical = serializeCanonicalJson('manuscript', clone(VALUES.manuscript));
  const cases = [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x80, 0x7d]),
    Buffer.from(JSON.stringify(VALUES.manuscript), 'utf8'),
    Buffer.from(canonical.toString('utf8').replace(/\n/g, '\r\n'), 'utf8'),
    canonical.subarray(0, canonical.length - 1),
    Buffer.concat([canonical, Buffer.from('\n')]),
    Buffer.from(`{\n  "project_uid": "${PROJECT_UID}",\n  "format_version": 1,\n  "volume_uids": [\n    "${VOLUME_UID}"\n  ]\n}\n`),
    Buffer.from(`{\n  "format_version": 1,\n  "format_version": 1,\n  "project_uid": "${PROJECT_UID}",\n  "volume_uids": []\n}\n`),
  ];

  for (const bytes of cases) {
    assertCode(
      () => parseCanonicalJson({ role: 'manuscript', bytes, expectedUid: PROJECT_UID }),
      'MANUSCRIPT_FILESET_INVALID',
    );
  }
});

test('format_version above the supported version has its dedicated error before other schema failures', () => {
  const tooNewWithUnknownData = Buffer.from(`{
  "format_version": 2,
  "future_shape": true
}
`);
  assertCode(
    () => parseCanonicalJson({
      role: 'manuscript',
      bytes: tooNewWithUnknownData,
      expectedUid: PROJECT_UID,
    }),
    'MANUSCRIPT_FORMAT_TOO_NEW',
  );
  assertCode(
    () => serializeCanonicalJson('manuscript', { format_version: 2, future_shape: true }),
    'MANUSCRIPT_FORMAT_TOO_NEW',
  );
});

test('exact schemas reject unknown, missing, wrongly typed and invalid-status fields', () => {
  const unknown = clone(VALUES.volume_index);
  unknown.extra = true;
  const missing = clone(VALUES.chapter_sidecar);
  delete missing.summary;
  const wrongType = clone(VALUES.unassigned);
  wrongType.chapter_uids = CHAPTER_UID;
  const invalidKind = clone(VALUES.unassigned);
  invalidKind.kind = 'volume';
  const invalidStatus = clone(VALUES.chapter_sidecar);
  invalidStatus.status = 'published';

  for (const [role, value] of [
    ['volume_index', unknown],
    ['chapter_sidecar', missing],
    ['unassigned', wrongType],
    ['unassigned', invalidKind],
    ['chapter_sidecar', invalidStatus],
  ]) {
    assertCode(() => serializeCanonicalJson(role, value), 'MANUSCRIPT_FILESET_INVALID');
  }
});

test('canonical UUID identity, expected file identity and duplicate members are rejected', () => {
  const duplicateVolumes = clone(VALUES.manuscript);
  duplicateVolumes.volume_uids = [VOLUME_UID, VOLUME_UID];
  const duplicateVolumeChapters = clone(VALUES.volume_index);
  duplicateVolumeChapters.chapter_uids = [CHAPTER_UID, CHAPTER_UID];
  const duplicateUnassignedChapters = clone(VALUES.unassigned);
  duplicateUnassignedChapters.chapter_uids = [CHAPTER_UID, CHAPTER_UID];
  const invalidIdentity = clone(VALUES.chapter_sidecar);
  invalidIdentity.chapter_uid = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';

  for (const [role, value] of [
    ['manuscript', duplicateVolumes],
    ['volume_index', duplicateVolumeChapters],
    ['unassigned', duplicateUnassignedChapters],
    ['chapter_sidecar', invalidIdentity],
  ]) {
    assertCode(() => serializeCanonicalJson(role, value), 'MANUSCRIPT_FILESET_INVALID');
  }

  assertCode(
    () => parseCanonicalJson({
      role: 'volume_index',
      bytes: serializeCanonicalJson('volume_index', clone(VALUES.volume_index)),
      expectedUid: OTHER_VOLUME_UID,
    }),
    'MANUSCRIPT_FILESET_INVALID',
  );
  assertCode(
    () => parseCanonicalJson({
      role: 'chapter_sidecar',
      bytes: serializeCanonicalJson('chapter_sidecar', clone(VALUES.chapter_sidecar)),
      expectedUid: OTHER_CHAPTER_UID,
    }),
    'MANUSCRIPT_FILESET_INVALID',
  );
  assertCode(
    () => parseCanonicalJson({
      role: 'manuscript',
      bytes: serializeCanonicalJson('manuscript', clone(VALUES.manuscript)),
    }),
    'MANUSCRIPT_FILESET_INVALID',
  );
});

test('D5 duplicate truth and ownership fields are rejected by exact role schemas', () => {
  const manuscript = clone(VALUES.manuscript);
  manuscript.unassigned_chapter_uids = [CHAPTER_UID];
  const sidecarOwner = clone(VALUES.chapter_sidecar);
  sidecarOwner.volume_uid = VOLUME_UID;
  const sidecarNumber = clone(VALUES.chapter_sidecar);
  sidecarNumber.chapter_number = 1;
  const volumeRepeatedMetadata = clone(VALUES.volume_index);
  volumeRepeatedMetadata.chapter_titles = ['not authoritative here'];

  for (const [role, value] of [
    ['manuscript', manuscript],
    ['chapter_sidecar', sidecarOwner],
    ['chapter_sidecar', sidecarNumber],
    ['volume_index', volumeRepeatedMetadata],
  ]) {
    assertCode(() => serializeCanonicalJson(role, value), 'MANUSCRIPT_FILESET_INVALID');
  }
});

test('escaped lone surrogates are invalid Unicode for parse and serialize', () => {
  const invalidBytes = Buffer.from(`{
  "format_version": 1,
  "volume_uid": "${VOLUME_UID}",
  "title": "\\ud800",
  "summary": "",
  "chapter_uids": []
}
`);
  assertCode(
    () => parseCanonicalJson({ role: 'volume_index', bytes: invalidBytes, expectedUid: VOLUME_UID }),
    'MANUSCRIPT_FILESET_INVALID',
  );
  const invalidValue = clone(VALUES.volume_index);
  invalidValue.title = '\ud800';
  assertCode(
    () => serializeCanonicalJson('volume_index', invalidValue),
    'MANUSCRIPT_FILESET_INVALID',
  );
});

test('Markdown inspector accepts every visual-dialect construct without rewriting bytes', () => {
  const content = [
    '# 一级标题',
    '## 二级标题',
    '',
    '普通 paragraph **粗体** *italic* __underline__ `inline code`',
    '',
    '---',
    '',
    '```',
    'const markdown = "# kept as code";',
    '```',
  ].join('\n');
  const bytes = Buffer.from(content, 'utf8');

  assert.deepEqual(inspectMarkdown(bytes), {
    rawSha256: sha256(bytes),
    wordCount: content.replace(/\s/g, '').length,
    mode: 'visual',
    contentAvailable: true,
    content,
  });
});

test('valid UTF-8 Markdown outside the exact visual dialect is read-only passthrough', () => {
  const cases = [
    '### level three',
    '> block quote',
    '- list item',
    '1. ordered item',
    '1.',
    '   1)',
    '[link](https://example.test)',
    '![image](image.png)',
    '~~strike~~',
    '_underscore italic_',
    '<em>raw HTML</em>',
    '```js\nconst x = 1;\n```',
    '```\nunclosed',
    '~~~js\nconst x = 1;\n~~~',
    'setext heading\n===',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    '\\*escaped marker\\*',
  ];

  for (const content of cases) {
    const bytes = Buffer.from(content, 'utf8');
    const result = inspectMarkdown(bytes);
    assert.equal(result.mode, 'read_only_passthrough', content);
    assert.equal(result.contentAvailable, true, content);
    assert.equal(result.content, content, content);
    assert.equal(result.rawSha256, sha256(bytes), content);
    assert.equal(result.wordCount, content.replace(/\s/g, '').length, content);
  }
});

test('common unsupported block spellings cannot enter visual mode', () => {
  const cases = [
    '-',
    '+',
    '*',
    '_ _ _',
    '* * *',
    '- - -',
    '<!DOCTYPE html>',
    '<?processing?>',
  ];

  assert.deepEqual(
    Object.fromEntries(cases.map((content) => [
      content,
      inspectMarkdown(Buffer.from(content, 'utf8')).mode,
    ])),
    Object.fromEntries(cases.map((content) => [content, 'read_only_passthrough'])),
  );
});

test('Markdown word count preserves the existing non-whitespace UTF-16 code-unit semantics', () => {
  const content = '中 文\tEnglish\r\n\ud83d\ude42 alpha_beta_gamma';
  const result = inspectMarkdown(Buffer.from(content, 'utf8'));
  assert.equal(result.mode, 'visual');
  assert.equal(result.wordCount, content.replace(/\s/g, '').length);
  assert.equal(result.wordCount, 27);
});

test('U+0000 remains hashed and counted but has unavailable projection content', () => {
  const source = '中 \u0000 A';
  const bytes = Buffer.from(source, 'utf8');
  assert.deepEqual(inspectMarkdown(bytes), {
    rawSha256: sha256(bytes),
    wordCount: source.replace(/\s/g, '').length,
    mode: 'read_only_passthrough',
    contentAvailable: false,
    content: null,
  });
});

test('invalid Markdown UTF-8 reports the hash computed from raw bytes first', () => {
  const bytes = Buffer.from([0x61, 0x80, 0x62]);
  assert.throws(
    () => inspectMarkdown(bytes),
    (error) => {
      assert.equal(error?.code, 'MANUSCRIPT_FILESET_INVALID');
      assert.equal(error?.details?.role, 'chapter_body');
      assert.equal(error?.details?.rawSha256, sha256(bytes));
      return true;
    },
  );
});
