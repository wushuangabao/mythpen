'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMITS } = require('../manuscript/contracts');
const {
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('../manuscript/projection-store');
const { ManuscriptUidReservation } = require('../manuscript/uid-reservation');

const ZERO_DIGEST = '0'.repeat(64);
const BODY_DIGEST = '1'.repeat(64);
const DELETED_AT = '2026-08-18T01:02:03.004Z';

function uuid(seed) {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

const PROJECT_UID = uuid(1);
const PROJECT_INSTANCE_ID = uuid(2);
const VOLUME_UID = uuid(10);
const OTHER_VOLUME_UID = uuid(11);
const ACTIVE_CHAPTER_UID = uuid(20);
const TOMBSTONE_CHAPTER_UID = uuid(21);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function volume(overrides = {}) {
  return {
    id: 1,
    uid: VOLUME_UID,
    sortOrder: 1,
    isPresent: 1,
    deletedAt: null,
    ...overrides,
  };
}

function chapter(overrides = {}) {
  return {
    id: 1,
    uid: ACTIVE_CHAPTER_UID,
    volumeId: 1,
    num: 4,
    isPresent: 1,
    deletedAt: null,
    chapterPosition: 1,
    manuscriptPosition: 1,
    bodyRawSha256: BODY_DIGEST,
    status: 'writing',
    ...overrides,
  };
}

function ignoredRow({ kind = 'chapter', resourceUid = uuid(30), status = 'active' } = {}) {
  return {
    resource_kind: kind,
    resource_uid: resourceUid,
    ignore_status: status,
    opaque_container_kind: null,
    opaque_container_uid: null,
    is_currently_referenced: 0,
    member_snapshot_json: '[]',
    projection_generation: 8,
  };
}

function projectionFixture({
  volumes = [volume(), volume({
    id: 2,
    uid: OTHER_VOLUME_UID,
    sortOrder: 2,
  })],
  chapters = [chapter(), chapter({
    id: 2,
    uid: TOMBSTONE_CHAPTER_UID,
    num: 99,
    isPresent: 0,
    deletedAt: DELETED_AT,
    chapterPosition: null,
    manuscriptPosition: null,
    bodyRawSha256: null,
  })],
  sqliteSequence,
  ignoredLedgerBefore = [],
  sourceKind = 'schema12',
} = {}) {
  const safeLedger = clone(ignoredLedgerBefore);
  const maximumVolumeId = volumes.reduce((maximum, row) => Math.max(maximum, row.id), 0);
  const maximumChapterId = chapters.reduce((maximum, row) => Math.max(maximum, row.id), 0);
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind,
    baseGeneration: sourceKind === 'schema12' ? 8 : 0,
    volumes: clone(volumes),
    chapters: clone(chapters),
    sqliteSequence: sqliteSequence || [
      { name: 'chapters', seq: Math.max(9, maximumChapterId) },
      { name: 'volumes', seq: Math.max(7, maximumVolumeId) },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest(safeLedger),
    pendingProposals: [],
    basisDigest: ZERO_DIGEST,
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  return {
    currentProjection: deepFreeze({
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      basis,
    }),
    ignoredLedgerBefore: deepFreeze(safeLedger),
  };
}

function absentPredicates(objectKind, candidateUid) {
  const roles = objectKind === 'chapter'
    ? ['chapter_body', 'chapter_sidecar']
    : ['volume_index'];
  const extensionFor = (role) => role === 'chapter_body' ? 'md' : 'json';
  const parent = objectKind === 'chapter' ? 'chapters' : 'volumes';
  return roles.map((role) => ({
    role,
    canonicalPath: `C:\\mythpen\\${PROJECT_UID}\\${parent}\\${objectKind === 'chapter' ? 'ch_' : 'vol_'}${candidateUid}.${extensionFor(role)}`,
    parentIdentity: { dev: '7', ino: objectKind === 'chapter' ? '11' : '12' },
    disposition: 'absent',
  }));
}

function harness({ uuids = [uuid(100)], records = [], enumerate, probe } = {}) {
  const calls = {
    enumerate: [],
    probe: [],
    uuid: 0,
  };
  const queue = [...uuids];
  const reservationSources = {
    async enumerate(input) {
      calls.enumerate.push(clone(input));
      if (enumerate) return enumerate(input);
      return {
        complete: true,
        projectUid: input.projectUid,
        projectInstanceId: input.projectInstanceId,
        objectKind: input.objectKind,
        records: clone(records),
      };
    },
  };
  const pathProbe = {
    async probe(input) {
      calls.probe.push(clone(input));
      if (probe) return probe(input, calls.probe.length);
      return {
        disposition: 'absent',
        pathPredicates: absentPredicates(input.objectKind, input.uid),
      };
    },
  };
  const service = new ManuscriptUidReservation({
    uuidV4() {
      calls.uuid += 1;
      return queue.shift();
    },
    reservationSources,
  });
  return { calls, pathProbe, service };
}

function chapterRequest(fixture, overrides = {}) {
  return {
    kind: 'chapter',
    logicalRequestId: 'request-create-chapter-1',
    currentProjection: fixture.currentProjection,
    ignoredLedgerBefore: fixture.ignoredLedgerBefore,
    allocation: {
      containerVolumeUid: VOLUME_UID,
      requestedNum: null,
    },
    ...overrides,
  };
}

function volumeRequest(fixture, overrides = {}) {
  return {
    kind: 'volume',
    logicalRequestId: 'request-create-volume-1',
    currentProjection: fixture.currentProjection,
    ignoredLedgerBefore: fixture.ignoredLedgerBefore,
    allocation: {
      containerVolumeUid: null,
      requestedNum: null,
    },
    ...overrides,
  };
}

function assertRecursivelyFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertRecursivelyFrozen(child, seen);
}

test('chapter reservation binds schema-12 basis, ledger, allocation, paths, and opaque authority', async () => {
  const fixture = projectionFixture({
    sqliteSequence: [
      { name: 'chapters', seq: 50 },
      { name: 'volumes', seq: 40 },
    ],
  });
  const candidateUid = uuid(100);
  const { calls, pathProbe, service } = harness({ uuids: [candidateUid] });

  const result = await service.reserveNewIdentity({
    ...chapterRequest(fixture),
    pathProbe,
  });

  assert.deepEqual(result.identityReservation, {
    domain: 'mythpen.manuscript.uid-reservation',
    version: 1,
    assignmentKind: 'reserved_new',
    objectKind: 'chapter',
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    logicalRequestId: 'request-create-chapter-1',
    sourceBasisDigest: fixture.currentProjection.basis.basisDigest,
    reservationId: result.identityReservation.reservationId,
    uid: candidateUid,
    id: 51,
    num: 5,
    containerVolumeUid: VOLUME_UID,
    pathPredicates: absentPredicates('chapter', candidateUid),
  });
  assert.match(result.identityReservation.reservationId, /^[0-9a-f]{64}$/u);
  assertRecursivelyFrozen(result.identityReservation);
  assert.doesNotThrow(() => JSON.stringify(result.identityReservation));
  assert.equal(service.assertReservation(result), result.identityReservation);
  assert.equal(JSON.stringify(result.authority), undefined);
  assert.equal(calls.uuid, 1);
  assert.equal(calls.enumerate.length, 1);
  assert.deepEqual(calls.enumerate[0], {
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    objectKind: 'chapter',
  });
  assert.deepEqual(calls.probe, [{
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    sourceBasisDigest: fixture.currentProjection.basis.basisDigest,
    objectKind: 'chapter',
    uid: candidateUid,
  }]);
});

test('volume reservation uses sqlite_sequence + 1 and the single volume predicate', async () => {
  const fixture = projectionFixture();
  const candidateUid = uuid(101);
  const { pathProbe, service } = harness({ uuids: [candidateUid] });

  const { identityReservation } = await service.reserveNewIdentity({
    ...volumeRequest(fixture),
    pathProbe,
  });

  assert.equal(identityReservation.id, 8);
  assert.equal(identityReservation.uid, candidateUid);
  assert.equal(Object.hasOwn(identityReservation, 'num'), false);
  assert.equal(Object.hasOwn(identityReservation, 'containerVolumeUid'), false);
  assert.deepEqual(identityReservation.pathPredicates, absentPredicates('volume', candidateUid));
});

test('path predicates use the Task 3 canonical ch_ and vol_ basenames', async () => {
  const fixture = projectionFixture();
  const chapterUid = uuid(104);
  const volumeUid = uuid(105);
  const chapterHarness = harness({
    uuids: [chapterUid],
    probe(input) {
      return {
        disposition: 'absent',
        pathPredicates: [
          {
            role: 'chapter_body',
            canonicalPath: `C:\\mythpen\\chapters\\ch_${input.uid}.md`,
            parentIdentity: { dev: '7', ino: '11' },
            disposition: 'absent',
          },
          {
            role: 'chapter_sidecar',
            canonicalPath: `C:\\mythpen\\chapters\\ch_${input.uid}.json`,
            parentIdentity: { dev: '7', ino: '11' },
            disposition: 'absent',
          },
        ],
      };
    },
  });
  const volumeHarness = harness({
    uuids: [volumeUid],
    probe(input) {
      return {
        disposition: 'absent',
        pathPredicates: [{
          role: 'volume_index',
          canonicalPath: `C:\\mythpen\\volumes\\vol_${input.uid}.json`,
          parentIdentity: { dev: '7', ino: '12' },
          disposition: 'absent',
        }],
      };
    },
  });

  const chapterResult = await chapterHarness.service.reserveNewIdentity({
    ...chapterRequest(fixture),
    pathProbe: chapterHarness.pathProbe,
  });
  const volumeResult = await volumeHarness.service.reserveNewIdentity({
    ...volumeRequest(fixture),
    pathProbe: volumeHarness.pathProbe,
  });

  assert.match(chapterResult.identityReservation.pathPredicates[0].canonicalPath, /\\ch_[0-9a-f-]+\.md$/u);
  assert.match(volumeResult.identityReservation.pathPredicates[0].canonicalPath, /\\vol_[0-9a-f-]+\.json$/u);
});

test('chapter numbering ignores tombstones and permits the same number in another volume', async () => {
  const fixture = projectionFixture({
    chapters: [
      chapter({ num: 7 }),
      chapter({
        id: 2,
        uid: uuid(22),
        volumeId: 1,
        num: 100,
        isPresent: 0,
        deletedAt: DELETED_AT,
        chapterPosition: null,
        manuscriptPosition: null,
        bodyRawSha256: null,
      }),
      chapter({
        id: 3,
        uid: uuid(23),
        volumeId: 2,
        num: 8,
        chapterPosition: 1,
        manuscriptPosition: 2,
      }),
    ],
  });
  const { pathProbe, service } = harness({ uuids: [uuid(102), uuid(103)] });

  const automatic = await service.reserveNewIdentity({
    ...chapterRequest(fixture),
    pathProbe,
  });
  const explicitAcrossVolume = await service.reserveNewIdentity({
    ...chapterRequest(fixture, {
      allocation: {
        containerVolumeUid: OTHER_VOLUME_UID,
        requestedNum: 7,
      },
    }),
    pathProbe,
  });

  assert.equal(automatic.identityReservation.num, 8);
  assert.equal(explicitAcrossVolume.identityReservation.num, 7);
  assert.equal(explicitAcrossVolume.identityReservation.containerVolumeUid, OTHER_VOLUME_UID);
});

test('basis and complete ignored-ledger bindings reject before any external port call', async () => {
  const ignoredLedgerBefore = [ignoredRow()];
  const fixture = projectionFixture({ ignoredLedgerBefore });

  for (const [name, mutate] of [
    ['basis member drift', (request) => {
      const currentProjection = clone(request.currentProjection);
      currentProjection.basis.sqliteSequence[0].seq += 1;
      request.currentProjection = deepFreeze(currentProjection);
    }],
    ['ledger digest drift', (request) => {
      request.ignoredLedgerBefore = deepFreeze([]);
    }],
    ['non-schema12 basis', (request) => {
      const legacy = projectionFixture({
        sourceKind: 'schema11',
        volumes: [{ id: 1, sortOrder: 1 }],
        chapters: [{
          id: 1,
          volumeId: 1,
          num: 1,
          bodyRawSha256: BODY_DIGEST,
          status: 'writing',
        }],
      });
      request.currentProjection = legacy.currentProjection;
      request.ignoredLedgerBefore = legacy.ignoredLedgerBefore;
    }],
  ]) {
    const current = harness();
    const request = chapterRequest(fixture, { pathProbe: current.pathProbe });
    mutate(request);
    await assert.rejects(current.service.reserveNewIdentity(request), TypeError, name);
    assert.deepEqual(current.calls, { enumerate: [], probe: [], uuid: 0 }, name);
  }
});

test('a self-consistent ignored digest still rejects a stale ledger generation before ports', async () => {
  const staleRow = ignoredRow();
  staleRow.projection_generation = 7;
  const fixture = projectionFixture({ ignoredLedgerBefore: [staleRow] });
  const current = harness();

  await assert.rejects(
    current.service.reserveNewIdentity({
      ...chapterRequest(fixture),
      pathProbe: current.pathProbe,
    }),
    TypeError,
  );
  assert.deepEqual(current.calls, { enumerate: [], probe: [], uuid: 0 });
});

test('identity capacity is checked before reservation sources, CSPRNG, or paths', async () => {
  const volumes = Array.from({ length: LIMITS.volumeIdentities }, (_, index) => volume({
    id: index + 1,
    uid: uuid(1_000 + index),
    sortOrder: index + 1,
  }));
  const fixture = projectionFixture({ volumes, chapters: [] });
  const current = harness();

  await assert.rejects(
    current.service.reserveNewIdentity({
      ...volumeRequest(fixture),
      pathProbe: current.pathProbe,
    }),
    (error) => (
      error?.code === 'MANUSCRIPT_CONTENT_TOO_LARGE'
      && error.details.dimension === 'volumeIdentities'
      && error.details.observed === LIMITS.volumeIdentities + 1
      && error.details.allowed === LIMITS.volumeIdentities
    ),
  );
  assert.deepEqual(current.calls, { enumerate: [], probe: [], uuid: 0 });
});

test('incomplete, throwing, wrong-scope, malformed, and duplicate source snapshots fail closed', async () => {
  const fixture = projectionFixture();
  const duplicate = {
    ownerKind: 'migration',
    ownerId: 'migration-1',
    reservationId: 'reservation-1',
    uid: uuid(200),
  };
  const cases = [
    ['throw', () => { throw new Error('catalog unavailable'); }],
    ['incomplete', (input) => ({
      complete: false,
      ...input,
      records: [],
    })],
    ['wrong scope', (input) => ({
      complete: true,
      ...input,
      projectInstanceId: uuid(999),
      records: [],
    })],
    ['malformed', (input) => ({
      complete: true,
      ...input,
      records: [{ ownerKind: 'unknown', ownerId: 'x', reservationId: 'y', uid: uuid(201) }],
    })],
    ['duplicate', (input) => ({
      complete: true,
      ...input,
      records: [duplicate, clone(duplicate)],
    })],
  ];

  for (const [name, enumerate] of cases) {
    const current = harness({ enumerate });
    await assert.rejects(
      current.service.reserveNewIdentity({
        ...chapterRequest(fixture),
        pathProbe: current.pathProbe,
      }),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      name,
    );
    assert.equal(current.calls.enumerate.length, 1, name);
    assert.equal(current.calls.uuid, 0, name);
    assert.equal(current.calls.probe.length, 0, name);
  }
});

test('active, tombstone, ignored, project, and all retained catalog records collide', async () => {
  const ignoredActiveUid = uuid(30);
  const ignoredRevokedUid = uuid(31);
  const retainedNonterminalUid = uuid(40);
  const retainedActivatedUid = uuid(41);
  const retainedAbortedUid = uuid(42);
  const fixture = projectionFixture({
    ignoredLedgerBefore: [
      ignoredRow({ resourceUid: ignoredActiveUid }),
      ignoredRow({ resourceUid: ignoredRevokedUid, status: 'revoked' }),
    ],
  });
  const records = [
    { ownerKind: 'migration', ownerId: 'nonterminal', reservationId: 'r-1', uid: retainedNonterminalUid },
    { ownerKind: 'file_publication', ownerId: 'activated', reservationId: 'r-2', uid: retainedActivatedUid },
    { ownerKind: 'migration', ownerId: 'aborted', reservationId: 'r-3', uid: retainedAbortedUid },
  ];
  const winner = VOLUME_UID;
  const current = harness({
    uuids: [
      ACTIVE_CHAPTER_UID,
      TOMBSTONE_CHAPTER_UID,
      ignoredActiveUid,
      ignoredRevokedUid,
      PROJECT_UID,
      retainedNonterminalUid,
      retainedActivatedUid,
      retainedAbortedUid,
      winner,
    ],
    records,
  });

  const result = await current.service.reserveNewIdentity({
    ...chapterRequest(fixture),
    pathProbe: current.pathProbe,
  });

  assert.equal(result.identityReservation.uid, winner);
  assert.equal(current.calls.enumerate.length, 1);
  assert.equal(current.calls.uuid, 9);
  assert.equal(current.calls.probe.length, 1);
});

test('canonical and case-fold path collisions retry before exact chapter absence succeeds', async () => {
  const fixture = projectionFixture();
  const first = uuid(300);
  const second = uuid(301);
  const winner = uuid(302);
  const current = harness({
    uuids: [first, second, winner],
    probe(input, call) {
      if (call < 3) return { disposition: 'collision' };
      return {
        disposition: 'absent',
        pathPredicates: absentPredicates(input.objectKind, input.uid),
      };
    },
  });

  const result = await current.service.reserveNewIdentity({
    ...chapterRequest(fixture),
    pathProbe: current.pathProbe,
  });

  assert.equal(result.identityReservation.uid, winner);
  assert.deepEqual(current.calls.probe.map((entry) => entry.uid), [first, second, winner]);
  assert.equal(current.calls.enumerate.length, 1);
});

test('unknown, malformed, or throwing path probes fail closed instead of claiming absence', async () => {
  const fixture = projectionFixture();
  const cases = [
    ['throw', () => { throw new Error('scan failed'); }],
    ['unknown', () => ({ disposition: 'unknown' })],
    ['missing chapter member', (input) => ({
      disposition: 'absent',
      pathPredicates: absentPredicates(input.objectKind, input.uid).slice(0, 1),
    })],
    ['wrong basename', (input) => {
      const predicates = absentPredicates(input.objectKind, input.uid);
      predicates[0].canonicalPath = 'C:\\mythpen\\chapters\\other.md';
      return { disposition: 'absent', pathPredicates: predicates };
    }],
  ];

  for (const [name, probe] of cases) {
    const current = harness({ uuids: [uuid(400)], probe });
    await assert.rejects(
      current.service.reserveNewIdentity({
        ...chapterRequest(fixture),
        pathProbe: current.pathProbe,
      }),
      (error) => error?.code === 'RECOVERY_REQUIRED',
      name,
    );
    assert.equal(current.calls.enumerate.length, 1, name);
    assert.equal(current.calls.uuid, 1, name);
    assert.equal(current.calls.probe.length, 1, name);
  }
});

test('invalid CSPRNG output rejects before path probing', async () => {
  const fixture = projectionFixture();
  for (const invalid of ['NOT-A-UUID', uuid(500).toUpperCase(), undefined]) {
    const current = harness({ uuids: [invalid] });
    await assert.rejects(
      current.service.reserveNewIdentity({
        ...chapterRequest(fixture),
        pathProbe: current.pathProbe,
      }),
      TypeError,
    );
    assert.equal(current.calls.enumerate.length, 1);
    assert.equal(current.calls.uuid, 1);
    assert.equal(current.calls.probe.length, 0);
  }
});

test('bounded collision exhaustion returns UID_RESERVATION_COLLISION', async () => {
  const fixture = projectionFixture();
  const current = harness({
    uuids: Array.from({ length: 32 }, (_, index) => uuid(600 + index)),
    probe() {
      return { disposition: 'collision' };
    },
  });

  await assert.rejects(
    current.service.reserveNewIdentity({
      ...chapterRequest(fixture),
      pathProbe: current.pathProbe,
    }),
    (error) => error?.code === 'UID_RESERVATION_COLLISION',
  );
  assert.equal(current.calls.enumerate.length, 1);
  assert.equal(current.calls.uuid, 32);
  assert.equal(current.calls.probe.length, 32);
});

test('assertReservation rejects cloned manifests and plain or foreign authorities', async () => {
  const fixture = projectionFixture();
  const first = harness({ uuids: [uuid(700)] });
  const second = harness({ uuids: [uuid(701)] });
  const reservation = await first.service.reserveNewIdentity({
    ...chapterRequest(fixture),
    pathProbe: first.pathProbe,
  });
  const foreign = await second.service.reserveNewIdentity({
    ...chapterRequest(fixture),
    pathProbe: second.pathProbe,
  });

  assert.throws(() => first.service.assertReservation({
    authority: reservation.authority,
    identityReservation: deepFreeze(clone(reservation.identityReservation)),
  }), TypeError);
  assert.throws(() => first.service.assertReservation({
    authority: {},
    identityReservation: reservation.identityReservation,
  }), TypeError);
  assert.throws(() => first.service.assertReservation({
    authority: foreign.authority,
    identityReservation: reservation.identityReservation,
  }), TypeError);
  assert.equal(first.service.assertReservation(reservation), reservation.identityReservation);
});

test('allocation is exact and rejects invalid volume shapes or duplicate chapter numbers', async () => {
  const fixture = projectionFixture();
  const cases = [
    volumeRequest(fixture, { allocation: null }),
    volumeRequest(fixture, { allocation: { containerVolumeUid: null, requestedNum: 1 } }),
    chapterRequest(fixture, {
      allocation: { containerVolumeUid: uuid(999), requestedNum: null },
    }),
    chapterRequest(fixture, {
      allocation: { containerVolumeUid: VOLUME_UID, requestedNum: 4 },
    }),
  ];

  for (const request of cases) {
    const current = harness();
    await assert.rejects(
      current.service.reserveNewIdentity({ ...request, pathProbe: current.pathProbe }),
      TypeError,
    );
    assert.deepEqual(current.calls, { enumerate: [], probe: [], uuid: 0 });
  }
});

test('constructor requires explicit CSPRNG and complete reservation catalog ports', () => {
  assert.throws(() => new ManuscriptUidReservation({
    uuidV4() { return uuid(1); },
  }), TypeError);
  assert.throws(() => new ManuscriptUidReservation({
    reservationSources: { enumerate() {} },
  }), TypeError);
  assert.throws(() => new ManuscriptUidReservation({
    uuidV4() { return uuid(1); },
    reservationSources: [],
  }), TypeError);
});
