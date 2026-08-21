'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ManuscriptStore } = require('../../manuscript/store');
const {
  SQLiteProjectionStore,
  canonicalIgnoredLedgerDigest,
  canonicalProjectionBasisDigest,
} = require('../../manuscript/projection-store');
const {
  PROJECT_UID,
  createManuscriptTreeFixture,
} = require('./manuscript-tree');

const CREATION_ID = '77777777-7777-4777-8777-777777777777';
const PROJECT_INSTANCE_ID = '88888888-8888-4888-8888-888888888888';
const CHILD_JOURNAL_ID = '99999999-9999-4999-8999-999999999999';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function physicalIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function clone(value) {
  return structuredClone(value);
}

function createMemoryControlStore(dataRoot, seed = [], creationId = CREATION_ID) {
  const events = seed.map(clone);
  return {
    directory: path.join(dataRoot, 'control', 'project-creation', creationId),
    incarnationId: `creation-${creationId}`,
    compareAndAppend(expectedDigest, event) {
      const tail = events.at(-1) ?? null;
      if ((tail?.digest ?? null) !== expectedDigest) throw new Error('stale tail');
      const appended = Object.freeze({
        seq: events.length + 1,
        type: event.type,
        payload: clone(event.payload),
        prevDigest: tail?.digest ?? null,
        digest: String(events.length + 1).padStart(64, '0'),
      });
      events.push(appended);
      return appended;
    },
    read() { return events.map(clone); },
    tail() { return events.length === 0 ? null : clone(events.at(-1)); },
    snapshot() { return events.map(clone); },
  };
}

function completeEmptySource() {
  return Object.freeze({
    async enumerate(scope) {
      return Object.freeze({
        complete: true,
        projectUid: scope.projectUid,
        projectInstanceId: scope.projectInstanceId,
        objectKind: scope.objectKind,
        records: Object.freeze([]),
      });
    },
  });
}

function emptyDirectoryPlan(
  dataRoot,
  projectUid = PROJECT_UID,
  projectInstanceId = PROJECT_INSTANCE_ID,
  finalDatabasePath = path.join(dataRoot, 'projects', 'created.mythpen.db'),
) {
  return deepFreeze({
    digest: DIGEST_A,
    finalDatabasePath,
    lifecycleLockDerivation: 'canonical-real-control-directory-sibling-sha256-v1',
    projectControlRoot: path.join(dataRoot, 'control', 'manuscripts', projectUid, projectInstanceId),
    articleRoot: path.join(dataRoot, 'manuscripts', projectUid),
    fileAssetsRoot: path.join(
      dataRoot,
      'control',
      'manuscripts',
      projectUid,
      projectInstanceId,
      'file-assets',
    ),
  });
}

function lifecycleLockReceipt(
  dataRoot,
  projectUid = PROJECT_UID,
  projectInstanceId = PROJECT_INSTANCE_ID,
) {
  const controlParentDirectoryIdentity = Object.freeze({ dev: '7', ino: '700' });
  const lifecycleLockIdentity = Object.freeze({ dev: '7', ino: '701' });
  return deepFreeze({
    version: 1,
    lifecycleLockBefore: {
      disposition: 'absent',
      parentIdentity: controlParentDirectoryIdentity,
    },
    lifecycleLockAfter: {
      byteSize: 0,
      fileFsync: true,
      identity: lifecycleLockIdentity,
      parentFsync: true,
      parentIdentity: controlParentDirectoryIdentity,
      sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    },
    lifecyclePlatformIdentity: {
      canonicalRealControlDirectory: path.join(
        dataRoot,
        'control',
        'manuscripts',
        projectUid,
        projectInstanceId,
      ),
      controlDirectoryIdentity: { dev: '7', ino: '702' },
      controlParentDirectoryIdentity,
      lifecycleLockIdentity,
    },
  });
}

async function createEmptyProjectionTarget({ dataRoot, projectInstanceId = PROJECT_INSTANCE_ID } = {}) {
  const fixture = createManuscriptTreeFixture({ dataRoot });
  for (const ref of Object.values(fixture.refs)) fixture.controls.deleteFile(ref);
  const store = new ManuscriptStore({
    dataRoot: fixture.dataRoot,
    fileBoundary: fixture.fileBoundary,
    journalAuthority: fixture.journalAuthority,
  });
  const enumeration = await store.enumerateAndClassify(fixture.projectBinding);
  const creationIdentity = deepFreeze({
    creationId: CREATION_ID,
    projectUid: PROJECT_UID,
    projectInstanceId,
  });
  const build = await store.buildClosure(
    enumeration,
    deepFreeze({ kind: 'creation.empty_bootstrap' }),
    Object.freeze([]),
    creationIdentity,
  );
  const staged = deepFreeze(build.closure.map((member, index) => ({
    ref: member.ref,
    byteSize: member.after.byteSize,
    rawSha256: member.after.rawSha256,
    fileIdentity: { dev: '1', ino: String(500 + index) },
    parentIdentity: member.parentIdentity,
  })));
  const candidate = store.finalizeCandidate(build, staged);
  const basis = {
    domain: 'mythpen.manuscript.projection-basis',
    version: 1,
    sourceKind: 'empty',
    baseGeneration: 0,
    volumes: [],
    chapters: [],
    sqliteSequence: [
      { name: 'chapters', seq: 0 },
      { name: 'volumes', seq: 0 },
    ],
    ignoredBeforeDigest: canonicalIgnoredLedgerDigest([]),
    pendingProposals: [],
    basisDigest: '0'.repeat(64),
  };
  basis.basisDigest = canonicalProjectionBasisDigest(basis);
  const target = new SQLiteProjectionStore().buildTarget({
    candidate,
    currentProjection: deepFreeze({
      projectUid: PROJECT_UID,
      projectInstanceId,
      basis,
    }),
    targetGeneration: 1,
    projectedAt: '2026-08-18T00:00:00.000Z',
    ignoredLedger: Object.freeze([]),
    localIdentityPlan: Object.freeze([]),
  });
  return { build, candidate, enumeration, fixture, store, target };
}

function creationJournalAuthority(context) {
  const observation = Object.freeze(Object.create(null));
  return Object.freeze({
    readObservation() { return observation; },
    describeObservation(value) {
      if (value !== observation) throw new TypeError('foreign observation');
      return deepFreeze({
        creationId: context.creationId,
        projectUid: context.projectUid,
        projectInstanceId: context.projectInstanceId,
        state: 'activation_intent',
        tailDigest: context.journalTailDigest,
        reservationDigest: context.reservationDigest,
        baseGeneration: context.baseGeneration,
        targetGeneration: context.targetGeneration,
      });
    },
    assertTransitionAllowed(value, transition) {
      if (
        value !== observation
        || transition.expected !== 'absent'
        || transition.next !== 'files'
      ) throw new TypeError('transition denied');
      return Object.freeze(Object.create(null));
    },
    assertCreationContext(value) {
      if (value !== context) throw new TypeError('foreign creation context');
      return value;
    },
  });
}

module.exports = {
  CHILD_JOURNAL_ID,
  CREATION_ID,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  PROJECT_INSTANCE_ID,
  PROJECT_UID,
  completeEmptySource,
  createEmptyProjectionTarget,
  createMemoryControlStore,
  creationJournalAuthority,
  deepFreeze,
  emptyDirectoryPlan,
  lifecycleLockReceipt,
  physicalIdentity,
  sha256File,
};
