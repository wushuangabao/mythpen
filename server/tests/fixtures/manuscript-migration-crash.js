'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { deriveManuscriptLifecycleLockPath } = require('../../manuscript/lifecycle-lock');

const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const MIGRATION_ID = '33333333-3333-4333-8333-333333333333';
const CHILD_JOURNAL_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function clone(value) {
  return structuredClone(value);
}

function createMemoryControlStore(dataRoot, seed = []) {
  const directory = path.join(
    dataRoot,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
  );
  const events = seed.map(clone);
  return {
    directory,
    incarnationId: 'control-incarnation-a',
    compareAndAppend(expectedDigest, event) {
      const tail = events.at(-1) ?? null;
      if ((tail?.digest ?? null) !== expectedDigest) throw new Error('stale tail');
      const appended = Object.freeze({
        seq: events.length,
        type: event.type,
        payload: clone(event.payload),
        prevDigest: tail?.digest ?? null,
        digest: String(events.length + 1).padStart(64, '0'),
      });
      events.push(appended);
      return appended;
    },
    read() {
      return events.map(clone);
    },
    tail() {
      return events.length === 0 ? null : clone(events.at(-1));
    },
    snapshot() {
      return events.map(clone);
    },
  };
}

function projectBinding(dataRoot) {
  return Object.freeze({
    controlIncarnationId: 'control-incarnation-a',
    dataRoot,
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
  });
}

function lifecycleLockPreflight(dataRoot) {
  const plannedControlDirectory = path.join(
    dataRoot,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
  );
  return Object.freeze({
    version: 1,
    disposition: 'absent',
    plannedControlDirectory,
    plannedLifecycleLockPath: deriveManuscriptLifecycleLockPath(plannedControlDirectory),
  });
}

function migrationReservation(dataRoot) {
  return Object.freeze({
    domain: 'mythpen.manuscript.migration-uid-reservation',
    version: 1,
    migrationId: MIGRATION_ID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    sourceBasisDigest: DIGEST_A,
    lifecycleLockPreflight: lifecycleLockPreflight(dataRoot),
    projectReservation: Object.freeze({
      reservationId: 'project-reservation-a',
      uid: PROJECT_UID,
    }),
    localIdentityPlan: Object.freeze([
      Object.freeze({
        assignmentKind: 'bind_legacy',
        objectKind: 'chapter',
        reservationId: 'chapter-reservation-a',
        uid: '55555555-5555-4555-8555-555555555555',
        id: 1,
        num: 1,
      }),
      Object.freeze({
        assignmentKind: 'bind_legacy',
        objectKind: 'volume',
        reservationId: 'volume-reservation-a',
        uid: '66666666-6666-4666-8666-666666666666',
        id: 1,
      }),
    ]),
  });
}

function reserveInput(dataRoot = path.join('E:\\', 'data')) {
  return Object.freeze({
    migrationId: MIGRATION_ID,
    logicalRequestId: 'migration-request-a',
    baseGeneration: 0,
    targetGeneration: 1,
    sourceBasisDigest: DIGEST_A,
    migrationReservation: migrationReservation(dataRoot),
  });
}

function directoryPlan(dataRoot) {
  return Object.freeze({
    digest: DIGEST_B,
    lifecycleLockDerivation: 'canonical-real-control-directory-sibling-sha256-v1',
    projectControlRoot: path.join(
      dataRoot,
      'control',
      'manuscripts',
      PROJECT_UID,
      PROJECT_INSTANCE_ID,
    ),
    directories: Object.freeze([
      Object.freeze({ name: 'project', before: 'absent', after: DIGEST_A }),
      Object.freeze({ name: 'mythpen', before: 'absent', after: DIGEST_B }),
      Object.freeze({ name: 'volumes', before: 'absent', after: DIGEST_C }),
      Object.freeze({ name: 'chapters', before: 'absent', after: DIGEST_A }),
    ]),
    fileAssets: Object.freeze({ before: 'absent', after: DIGEST_C }),
  });
}

function lifecycleLockReceipt(dataRoot) {
  const controlParentDirectoryIdentity = Object.freeze({ dev: '7', ino: '700' });
  const lifecycleLockIdentity = Object.freeze({ dev: '7', ino: '701' });
  return Object.freeze({
    version: 1,
    lifecycleLockBefore: Object.freeze({
      disposition: 'absent',
      parentIdentity: controlParentDirectoryIdentity,
    }),
    lifecycleLockAfter: Object.freeze({
      byteSize: 0,
      fileFsync: true,
      identity: lifecycleLockIdentity,
      parentFsync: true,
      parentIdentity: controlParentDirectoryIdentity,
      sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
    }),
    lifecyclePlatformIdentity: Object.freeze({
      canonicalRealControlDirectory: path.join(
        dataRoot,
        'control',
        'manuscripts',
        PROJECT_UID,
        PROJECT_INSTANCE_ID,
      ),
      controlDirectoryIdentity: Object.freeze({ dev: '7', ino: '702' }),
      controlParentDirectoryIdentity,
      lifecycleLockIdentity,
    }),
  });
}

function sourceSnapshot() {
  return Object.freeze({
    digest: DIGEST_C,
    sourceIdentity: Object.freeze({ dev: '1', ino: '2' }),
    backupIdentity: Object.freeze({ dev: '1', ino: '3' }),
    sourceSha256: DIGEST_A,
    backupSha256: DIGEST_A,
    sourceBasisDigest: DIGEST_A,
  });
}

module.exports = {
  CHILD_JOURNAL_ID,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  MIGRATION_ID,
  PROJECT_INSTANCE_ID,
  PROJECT_UID,
  createMemoryControlStore,
  directoryPlan,
  lifecycleLockReceipt,
  lifecycleLockPreflight,
  migrationReservation,
  projectBinding,
  reserveInput,
  sourceSnapshot,
};
