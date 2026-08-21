'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  IGNORED_MEMBER_SNAPSHOT_VERSION,
  IgnoredIdentityLedger,
  normalizeIgnoredLedgerRows,
} = require('../manuscript/ignored-ledger');

const CHAPTER_A = '11111111-1111-4111-8111-111111111111';
const CHAPTER_B = '22222222-2222-4222-8222-222222222222';
const CHAPTER_C = '33333333-3333-4333-8333-333333333333';
const VOLUME_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VOLUME_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function identity(dev, ino) {
  return { dev: String(dev), ino: String(ino) };
}

function absent(role) {
  return { role, present: false };
}

function present(role, byteSize, dev, ino, parentDev, parentIno) {
  return {
    role,
    present: true,
    byteSize,
    fileIdentity: identity(dev, ino),
    parentIdentity: identity(parentDev, parentIno),
  };
}

function memberJson(members) {
  return JSON.stringify({ version: 1, members });
}

function chapterMembers(overrides = {}) {
  return [
    overrides.body ?? present('chapter_body', 12, 1, 2, 3, 4),
    overrides.sidecar ?? present('chapter_sidecar', 34, 5, 6, 3, 4),
  ];
}

function volumeMembers(overrides = {}) {
  return [overrides.index ?? present('volume_index', 56, 7, 8, 9, 10)];
}

function row(overrides = {}) {
  const resourceKind = overrides.resource_kind ?? 'chapter';
  const members = overrides.members
    ?? (resourceKind === 'chapter' ? chapterMembers() : volumeMembers());
  return {
    resource_kind: resourceKind,
    resource_uid: overrides.resource_uid ?? CHAPTER_A,
    ignore_status: overrides.ignore_status ?? 'active',
    opaque_container_kind: Object.hasOwn(overrides, 'opaque_container_kind')
      ? overrides.opaque_container_kind
      : 'unassigned',
    opaque_container_uid: Object.hasOwn(overrides, 'opaque_container_uid')
      ? overrides.opaque_container_uid
      : null,
    is_currently_referenced: overrides.is_currently_referenced ?? 1,
    member_snapshot_json: overrides.member_snapshot_json ?? memberJson(members),
    projection_generation: overrides.projection_generation ?? 7,
  };
}

function volumeRow(overrides = {}) {
  return row({
    resource_kind: 'volume',
    resource_uid: VOLUME_A,
    opaque_container_kind: 'manuscript',
    ...overrides,
  });
}

function reference(state, containerKind = null, containerUid = null) {
  return { state, containerKind, containerUid };
}

function observation(overrides = {}) {
  const kind = overrides.kind ?? 'chapter';
  return {
    kind,
    uid: overrides.uid ?? (kind === 'chapter' ? CHAPTER_A : VOLUME_A),
    status: overrides.status ?? 'active',
    members: overrides.members ?? (kind === 'chapter' ? chapterMembers() : volumeMembers()),
    reference: overrides.reference
      ?? (kind === 'chapter'
        ? reference('indexed', 'unassigned', null)
        : reference('indexed', 'manuscript', null)),
  };
}

function clone(value) {
  return structuredClone(value);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('exports the v1 ledger core and canonicalizes exact SQL rows without mutating callers', () => {
  assert.equal(IGNORED_MEMBER_SNAPSHOT_VERSION, 1);
  assert.equal(typeof IgnoredIdentityLedger, 'function');
  assert.equal(typeof normalizeIgnoredLedgerRows, 'function');

  const input = [volumeRow(), row()];
  const before = clone(input);
  const normalized = normalizeIgnoredLedgerRows(input);

  assert.deepEqual(input, before);
  assert.deepEqual(normalized.map((entry) => entry.resource_kind), ['chapter', 'volume']);
  assert.notEqual(normalized[0], input[1]);
  assert.equal(
    normalized[0].member_snapshot_json,
    '{"version":1,"members":[{"role":"chapter_body","present":true,"byteSize":12,"fileIdentity":{"dev":"1","ino":"2"},"parentIdentity":{"dev":"3","ino":"4"}},{"role":"chapter_sidecar","present":true,"byteSize":34,"fileIdentity":{"dev":"5","ino":"6"},"parentIdentity":{"dev":"3","ino":"4"}}]}',
  );
  assertDeepFrozen(normalized);
});

test('canonical normalized row arrays are branded and reused without a second validation pass', () => {
  const normalized = normalizeIgnoredLedgerRows([volumeRow(), row()]);
  assert.equal(normalizeIgnoredLedgerRows(normalized), normalized);

  const compiled = new IgnoredIdentityLedger().compileAfter({
    beforeRows: normalizeIgnoredLedgerRows([row()]),
    observations: [observation()],
    targetGeneration: 8,
  });
  assert.equal(normalizeIgnoredLedgerRows(compiled), compiled);
  assert.deepEqual(Object.keys(compiled[0]), [
    'resource_kind',
    'resource_uid',
    'ignore_status',
    'opaque_container_kind',
    'opaque_container_uid',
    'is_currently_referenced',
    'member_snapshot_json',
    'projection_generation',
  ]);
});

test('toValidationEntries checks every base generation and emits the exact frozen Store shape', () => {
  const ledger = new IgnoredIdentityLedger();
  const result = ledger.toValidationEntries([
    volumeRow({ ignore_status: 'revoked' }),
    row(),
  ], 7);

  assert.deepEqual(result, {
    entries: [
      { kind: 'chapter', status: 'active', uid: CHAPTER_A },
      { kind: 'volume', status: 'revoked', uid: VOLUME_A },
    ],
  });
  assertDeepFrozen(result);
  assert.throws(
    () => ledger.toValidationEntries([row({ projection_generation: 6 })], 7),
    TypeError,
  );
  assert.throws(() => ledger.toValidationEntries([], -0), TypeError);
});

test('normalizer enforces canonical member bytes, fixed roles, exact facts and decimal identities', () => {
  const canonical = row({
    members: chapterMembers({ sidecar: absent('chapter_sidecar') }),
  });
  assert.equal(normalizeIgnoredLedgerRows([canonical]).length, 1);

  const malformed = [
    row({ member_snapshot_json: ' {"version":1,"members":[]}' }),
    row({ member_snapshot_json: '{"members":[],"version":1}' }),
    row({ member_snapshot_json: '{"version":2,"members":[]}' }),
    row({ member_snapshot_json: memberJson([absent('chapter_sidecar'), absent('chapter_body')]) }),
    row({ member_snapshot_json: memberJson([absent('chapter_body')]) }),
    row({ member_snapshot_json: memberJson([
      { role: 'chapter_body', present: false, extra: true },
      absent('chapter_sidecar'),
    ]) }),
    row({ member_snapshot_json: memberJson([
      { ...present('chapter_body', 1, 1, 2, 3, 4), byteSize: -1 },
      absent('chapter_sidecar'),
    ]) }),
    row({ member_snapshot_json: memberJson([
      present('chapter_body', 1, '1x', 2, 3, 4),
      absent('chapter_sidecar'),
    ]) }),
    volumeRow({ member_snapshot_json: memberJson([absent('chapter_body')]) }),
  ];
  for (const invalid of malformed) {
    assert.throws(() => normalizeIgnoredLedgerRows([invalid]), TypeError);
  }
});

test('canonical identity decimal strings reject leading-zero aliases', () => {
  for (const members of [
    chapterMembers({
      body: present('chapter_body', 1, '01', 2, 3, 4),
    }),
    chapterMembers({
      sidecar: present('chapter_sidecar', 1, 5, '00', 3, 4),
    }),
  ]) {
    assert.throws(() => normalizeIgnoredLedgerRows([row({ members })]), TypeError);
  }
});

test('normalizer rejects inexact descriptors, sparse arrays, invalid scalars and duplicate identities', () => {
  let getterCalls = 0;
  const withAccessor = row();
  Object.defineProperty(withAccessor, 'ignore_status', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'active';
    },
  });
  assert.throws(() => normalizeIgnoredLedgerRows([withAccessor]), TypeError);
  assert.equal(getterCalls, 0);

  const sparse = [];
  sparse.length = 1;
  const invalidRows = [
    [{ ...row(), extra: true }],
    sparse,
    [volumeRow({ resource_uid: VOLUME_A.toUpperCase() })],
    [row({ ignore_status: 'new_active' })],
    [row({ is_currently_referenced: -0 })],
    [row({ projection_generation: -0 })],
    [row(), clone(row())],
  ];
  for (const invalid of invalidRows) {
    assert.throws(() => normalizeIgnoredLedgerRows(invalid), TypeError);
  }
});

test('chapter indexed and detached rows obey the exact unassigned or volume container matrix', () => {
  for (const valid of [
    row(),
    row({ opaque_container_kind: 'volume', opaque_container_uid: VOLUME_A }),
    row({
      opaque_container_kind: null,
      opaque_container_uid: null,
      is_currently_referenced: 0,
    }),
  ]) {
    assert.equal(normalizeIgnoredLedgerRows([valid]).length, 1);
  }

  for (const invalid of [
    row({ opaque_container_kind: 'manuscript' }),
    row({ opaque_container_kind: 'unassigned', opaque_container_uid: VOLUME_A }),
    row({ opaque_container_kind: 'volume', opaque_container_uid: null }),
    row({ opaque_container_kind: null, opaque_container_uid: null }),
    row({
      opaque_container_kind: 'volume',
      opaque_container_uid: VOLUME_A,
      is_currently_referenced: 0,
    }),
  ]) {
    assert.throws(() => normalizeIgnoredLedgerRows([invalid]), TypeError);
  }
});

test('volume indexed and detached rows obey the exact manuscript container matrix', () => {
  for (const valid of [
    volumeRow(),
    volumeRow({
      opaque_container_kind: null,
      opaque_container_uid: null,
      is_currently_referenced: 0,
    }),
  ]) {
    assert.equal(normalizeIgnoredLedgerRows([valid]).length, 1);
  }

  for (const invalid of [
    volumeRow({ opaque_container_kind: 'unassigned' }),
    volumeRow({ opaque_container_kind: 'volume', opaque_container_uid: VOLUME_A }),
    volumeRow({ opaque_container_kind: 'manuscript', opaque_container_uid: VOLUME_A }),
    volumeRow({ opaque_container_kind: null, opaque_container_uid: null }),
  ]) {
    assert.throws(() => normalizeIgnoredLedgerRows([invalid]), TypeError);
  }
});

test('compileAfter rebuilds canonical row bytes from generation-neutral observations', () => {
  const ledger = new IgnoredIdentityLedger();
  const beforeRows = [
    volumeRow({ ignore_status: 'revoked' }),
    row(),
  ];
  const observations = [
    observation({
      members: chapterMembers({ body: absent('chapter_body') }),
      reference: reference('indexed', 'volume', VOLUME_B),
    }),
    observation({
      kind: 'volume',
      status: 'revoked',
      members: volumeMembers({ index: absent('volume_index') }),
      reference: reference('detached', null, null),
    }),
  ];

  const beforeSnapshot = clone(beforeRows);
  const observationSnapshot = clone(observations);
  const compiled = ledger.compileAfter({ beforeRows, observations, targetGeneration: 8 });

  assert.deepEqual(beforeRows, beforeSnapshot);
  assert.deepEqual(observations, observationSnapshot);
  assert.deepEqual(compiled, [
    row({
      opaque_container_kind: 'volume',
      opaque_container_uid: VOLUME_B,
      member_snapshot_json: memberJson(chapterMembers({ body: absent('chapter_body') })),
      projection_generation: 8,
    }),
    volumeRow({
      ignore_status: 'revoked',
      opaque_container_kind: null,
      opaque_container_uid: null,
      is_currently_referenced: 0,
      member_snapshot_json: memberJson(volumeMembers({ index: absent('volume_index') })),
      projection_generation: 8,
    }),
  ]);
  assertDeepFrozen(compiled);
});

test('compileAfter requires a one-to-one same-identity and same-status observation mapping', () => {
  const ledger = new IgnoredIdentityLedger();
  const beforeRows = [row(), row({ resource_uid: CHAPTER_B })];
  const validA = observation();
  const validB = observation({ uid: CHAPTER_B });

  const invalidObservations = [
    [validA],
    [validA, validB, observation({ uid: CHAPTER_C })],
    [validA, clone(validA)],
    [observation({ kind: 'volume', uid: CHAPTER_A }), validB],
    [observation({ status: 'revoked' }), validB],
  ];
  for (const observations of invalidObservations) {
    assert.throws(
      () => ledger.compileAfter({ beforeRows, observations, targetGeneration: 8 }),
      TypeError,
    );
  }
});

test('compileAfter rejects generation mistakes and malformed observation descriptors without invoking getters', () => {
  const ledger = new IgnoredIdentityLedger();
  assert.throws(
    () => ledger.compileAfter({
      beforeRows: [row(), row({ resource_uid: CHAPTER_B, projection_generation: 6 })],
      observations: [observation(), observation({ uid: CHAPTER_B })],
      targetGeneration: 8,
    }),
    TypeError,
  );
  assert.throws(
    () => ledger.compileAfter({
      beforeRows: [row()],
      observations: [observation()],
      targetGeneration: 7,
    }),
    TypeError,
  );

  let getterCalls = 0;
  const hostile = observation();
  Object.defineProperty(hostile, 'reference', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return reference('indexed', 'unassigned', null);
    },
  });
  assert.throws(
    () => ledger.compileAfter({
      beforeRows: [row()],
      observations: [hostile],
      targetGeneration: 8,
    }),
    TypeError,
  );
  assert.equal(getterCalls, 0);
});

test('compileAfter validates present and absent observations plus reference cross constraints', () => {
  const ledger = new IgnoredIdentityLedger();
  const invalid = [
    observation({ members: [absent('chapter_body')] }),
    observation({ members: [absent('chapter_sidecar'), absent('chapter_body')] }),
    observation({
      members: [
        { ...absent('chapter_body'), byteSize: 0 },
        absent('chapter_sidecar'),
      ],
    }),
    observation({
      members: [
        { ...present('chapter_body', 1, 1, 2, 3, 4), extra: true },
        absent('chapter_sidecar'),
      ],
    }),
    observation({ reference: reference('indexed', 'manuscript', null) }),
    observation({ reference: reference('indexed', 'volume', null) }),
    observation({ reference: reference('detached', 'unassigned', null) }),
    observation({
      kind: 'volume',
      reference: reference('indexed', 'volume', VOLUME_B),
    }),
  ];
  for (const current of invalid) {
    const before = current.kind === 'volume' ? volumeRow() : row();
    assert.throws(
      () => ledger.compileAfter({
        beforeRows: [before],
        observations: [current],
        targetGeneration: 8,
      }),
      TypeError,
    );
  }
});

test('resolution transition is original-only while ordinary compileAfter keeps equal-row status rules', () => {
  const ledger = new IgnoredIdentityLedger();
  const beforeRows = normalizeIgnoredLedgerRows([]);
  const preparation = ledger.prepareResolution({
    action: 'ignore_in_place',
    request: { kind: 'chapter', uid: CHAPTER_A },
    beforeRows,
    baseGeneration: 7,
  });
  const candidate = Object.freeze({
    capacitySnapshot: Object.freeze({}),
    chapters: Object.freeze([]),
    controlledFiles: Object.freeze([]),
    diagnostics: Object.freeze({}),
    ignoredLedgerAfter: Object.freeze([Object.freeze(observation({
      reference: reference('detached', null, null),
    }))]),
    projectUid: VOLUME_A,
    volumeOrder: Object.freeze([]),
    volumes: Object.freeze([]),
    warnings: Object.freeze([]),
  });
  const transition = ledger.finalizeResolution({
    preparation,
    candidate,
    targetGeneration: 8,
  });
  const after = ledger.compileResolutionAfter({
    transition,
    beforeRows,
    candidate,
    targetGeneration: 8,
  });

  assert.deepEqual(after, [row({
    opaque_container_kind: null,
    opaque_container_uid: null,
    is_currently_referenced: 0,
    projection_generation: 8,
  })]);
  assert.throws(() => ledger.compileResolutionAfter({
    transition: Object.freeze({ ...transition }),
    beforeRows,
    candidate,
    targetGeneration: 8,
  }), /original.*module-branded/i);
  assert.throws(() => ledger.compileAfter({
    beforeRows,
    observations: candidate.ignoredLedgerAfter,
    targetGeneration: 8,
  }), /cover every before row exactly once/i);
});

test('finalizeResolution never searches normalized observations with indexOf', () => {
  const ledger = new IgnoredIdentityLedger();
  const uids = Array.from({ length: 128 }, (_, index) => (
    `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`
  ));
  const beforeRows = normalizeIgnoredLedgerRows(uids.map((uid) => row({ resource_uid: uid })));
  const preparation = ledger.prepareResolution({
    action: 'ignore_in_place',
    request: { kind: 'chapter', uid: uids[0] },
    beforeRows,
    baseGeneration: 7,
  });
  const candidate = Object.freeze({
    capacitySnapshot: Object.freeze({}),
    chapters: Object.freeze([]),
    controlledFiles: Object.freeze([]),
    diagnostics: Object.freeze({}),
    ignoredLedgerAfter: Object.freeze(uids.map((uid) => observation({ uid }))),
    projectUid: VOLUME_A,
    volumeOrder: Object.freeze([]),
    volumes: Object.freeze([]),
    warnings: Object.freeze([]),
  });
  const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'indexOf');
  let indexOfCalls = 0;
  Object.defineProperty(Array.prototype, 'indexOf', {
    ...originalDescriptor,
    value(...args) {
      indexOfCalls += 1;
      return Reflect.apply(originalDescriptor.value, this, args);
    },
  });
  let transition;
  try {
    transition = ledger.finalizeResolution({
      preparation,
      candidate,
      targetGeneration: 8,
    });
  } finally {
    Object.defineProperty(Array.prototype, 'indexOf', originalDescriptor);
  }

  assert.ok(transition);
  assert.equal(indexOfCalls, 0);
});

test('serializeOpaqueMembers appends only active indexed opaque members in UTF-8 order', () => {
  const ledger = new IgnoredIdentityLedger();
  const rows = [
    row({ resource_uid: CHAPTER_B }),
    row({ resource_uid: CHAPTER_A }),
    row({
      resource_uid: CHAPTER_C,
      opaque_container_kind: null,
      opaque_container_uid: null,
      is_currently_referenced: 0,
    }),
    row({
      resource_uid: '44444444-4444-4444-8444-444444444444',
      ignore_status: 'revoked',
    }),
    volumeRow(),
  ];
  const container = Object.freeze({ kind: 'unassigned', uid: null });
  const knownMembers = Object.freeze([CHAPTER_C]);

  const serialized = ledger.serializeOpaqueMembers({
    container,
    knownMembers,
    rows,
    referenceTransition: null,
  });

  assert.deepEqual(serialized, [CHAPTER_C, CHAPTER_A, CHAPTER_B]);
  assertDeepFrozen(serialized);
  assert.deepEqual(rows.map((current) => current.resource_uid), [
    CHAPTER_B,
    CHAPTER_A,
    CHAPTER_C,
    '44444444-4444-4444-8444-444444444444',
    VOLUME_A,
  ]);
  assert.deepEqual(ledger.serializeOpaqueMembers({
    container: Object.freeze({ kind: 'manuscript', uid: null }),
    knownMembers: Object.freeze([VOLUME_B]),
    rows: normalizeIgnoredLedgerRows([volumeRow()]),
    referenceTransition: null,
  }), [VOLUME_B, VOLUME_A]);
});

test('serializeOpaqueMembers rejects inexact containers, non-canonical known members and fake transitions', () => {
  const ledger = new IgnoredIdentityLedger();
  const base = {
    container: Object.freeze({ kind: 'unassigned', uid: null }),
    knownMembers: Object.freeze([CHAPTER_C]),
    rows: [row()],
    referenceTransition: null,
  };

  assert.throws(() => ledger.serializeOpaqueMembers({
    ...base,
    container: { kind: 'unassigned', uid: null },
  }), TypeError);
  assert.throws(() => ledger.serializeOpaqueMembers({
    ...base,
    container: Object.freeze({ kind: 'volume', uid: null }),
  }), TypeError);
  assert.throws(() => ledger.serializeOpaqueMembers({
    ...base,
    knownMembers: Object.freeze([CHAPTER_A]),
  }), TypeError);
  assert.throws(() => ledger.serializeOpaqueMembers({
    ...base,
    knownMembers: Object.freeze([CHAPTER_C, CHAPTER_C]),
  }), TypeError);
  assert.throws(() => ledger.serializeOpaqueMembers({
    ...base,
    referenceTransition: Object.freeze({
      resourceKind: 'chapter',
      resourceUid: CHAPTER_A,
      fromContainer: Object.freeze({ kind: 'unassigned', uid: null }),
      toContainer: null,
    }),
  }), TypeError);
});

test('createReferenceTransition brands preserve and detach actions for virtual serialization', () => {
  const ledger = new IgnoredIdentityLedger();
  const volumeIndexed = row({
    opaque_container_kind: 'volume',
    opaque_container_uid: VOLUME_A,
  });
  const canonicalRows = normalizeIgnoredLedgerRows([volumeIndexed]);
  const observed = observation({
    reference: reference('indexed', 'volume', VOLUME_A),
  });
  const preserve = ledger.createReferenceTransition({
    rows: canonicalRows,
    observation: observed,
    action: { kind: 'ignored.preserve_move_to_unassigned', chapterUid: CHAPTER_A },
  });

  assert.deepEqual(preserve, {
    resourceKind: 'chapter',
    resourceUid: CHAPTER_A,
    fromContainer: { kind: 'volume', uid: VOLUME_A },
    toContainer: { kind: 'unassigned', uid: null },
  });
  assertDeepFrozen(preserve);
  assert.deepEqual(ledger.serializeOpaqueMembers({
    container: Object.freeze({ kind: 'volume', uid: VOLUME_A }),
    knownMembers: Object.freeze([CHAPTER_C]),
    rows: canonicalRows,
    referenceTransition: preserve,
  }), [CHAPTER_C]);
  assert.deepEqual(ledger.serializeOpaqueMembers({
    container: Object.freeze({ kind: 'unassigned', uid: null }),
    knownMembers: Object.freeze([CHAPTER_B]),
    rows: canonicalRows,
    referenceTransition: preserve,
  }), [CHAPTER_B, CHAPTER_A]);

  const detach = ledger.createReferenceTransition({
    rows: canonicalRows,
    observation: observed,
    action: { kind: 'ignored.detach_reference', chapterUid: CHAPTER_A },
  });
  assert.equal(detach.toContainer, null);
  assert.deepEqual(ledger.serializeOpaqueMembers({
    container: Object.freeze({ kind: 'volume', uid: VOLUME_A }),
    knownMembers: Object.freeze([]),
    rows: canonicalRows,
    referenceTransition: detach,
  }), []);
  assert.throws(() => ledger.serializeOpaqueMembers({
    container: Object.freeze({ kind: 'volume', uid: VOLUME_A }),
    knownMembers: Object.freeze([]),
    rows: normalizeIgnoredLedgerRows([row({
      opaque_container_kind: 'volume',
      opaque_container_uid: VOLUME_A,
      members: chapterMembers({ body: absent('chapter_body') }),
    })]),
    referenceTransition: detach,
  }), TypeError);

  const unassignedRows = normalizeIgnoredLedgerRows([row()]);
  const detachUnassigned = ledger.createReferenceTransition({
    rows: unassignedRows,
    observation: observation(),
    action: { kind: 'ignored.detach_reference', chapterUid: CHAPTER_A },
  });
  assert.deepEqual(ledger.serializeOpaqueMembers({
    container: Object.freeze({ kind: 'unassigned', uid: null }),
    knownMembers: Object.freeze([]),
    rows: unassignedRows,
    referenceTransition: detachUnassigned,
  }), []);
});

test('createReferenceTransition rejects illegal actions and any row-observation mismatch', () => {
  const ledger = new IgnoredIdentityLedger();
  const indexed = row({
    opaque_container_kind: 'volume',
    opaque_container_uid: VOLUME_A,
  });
  const observed = observation({
    reference: reference('indexed', 'volume', VOLUME_A),
  });
  const input = { rows: [indexed], observation: observed };

  assert.throws(() => ledger.createReferenceTransition({
    ...input,
    action: { kind: 'ignored.preserve_move_to_unassigned', chapterUid: CHAPTER_A, extra: true },
  }), TypeError);
  assert.throws(() => ledger.createReferenceTransition({
    ...input,
    action: { kind: 'ignored.unknown', chapterUid: CHAPTER_A },
  }), TypeError);
  assert.throws(() => ledger.createReferenceTransition({
    rows: [row()],
    observation: observation(),
    action: { kind: 'ignored.preserve_move_to_unassigned', chapterUid: CHAPTER_A },
  }), TypeError);
  assert.throws(() => ledger.createReferenceTransition({
    ...input,
    observation: observation({
      members: chapterMembers({ body: absent('chapter_body') }),
      reference: reference('indexed', 'volume', VOLUME_A),
    }),
    action: { kind: 'ignored.detach_reference', chapterUid: CHAPTER_A },
  }), TypeError);
  assert.throws(() => ledger.createReferenceTransition({
    rows: [row({
      ignore_status: 'revoked',
      opaque_container_kind: 'volume',
      opaque_container_uid: VOLUME_A,
    })],
    observation: observation({
      status: 'revoked',
      reference: reference('indexed', 'volume', VOLUME_A),
    }),
    action: { kind: 'ignored.detach_reference', chapterUid: CHAPTER_A },
  }), TypeError);
});
