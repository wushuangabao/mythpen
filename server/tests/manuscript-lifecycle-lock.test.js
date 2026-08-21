'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertManuscriptLifecycleLockPreflight,
  assertManuscriptLifecycleLockReceipt,
  createProductionManuscriptLifecycleLockOwner,
  deriveManuscriptLifecycleLockPath,
} = require('../manuscript/lifecycle-lock');
const {
  createCreationDirectoryPlan,
  createProjectRootProbe,
  ensureCreationDirectories,
  ensureMigrationDirectories,
  verifyCreationDirectories,
} = require('../manuscript/production-project-roots');
const {
  createWindowsManuscriptLifecycleLeaseAdapter,
} = require('../platform/windows-manuscript-lifecycle-lease');

const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
    fs.realpathSync.native(os.tmpdir()),
    'mythpen-lifecycle-owner-',
  )));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const controlDirectory = path.join(root, 'project-instance');
  fs.mkdirSync(controlDirectory);
  return Object.freeze({
    canonicalRealControlDirectory: fs.realpathSync.native(controlDirectory),
    root,
  });
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

test('lifecycle lock path is the canonical control-directory sibling hash', () => {
  const canonicalRealControlDirectory = path.resolve('C:\\data\\control\\project-instance');
  const digest = crypto.createHash('sha256')
    .update(Buffer.from(canonicalRealControlDirectory, 'utf8'))
    .digest('hex');

  assert.equal(
    deriveManuscriptLifecycleLockPath(canonicalRealControlDirectory),
    path.join(
      path.dirname(canonicalRealControlDirectory),
      `.manuscript-${digest}.lifecycle.lock`,
    ),
  );
});

test('fresh lifecycle owner creates one exact empty lock and returns its durable receipt', (t) => {
  const current = fixture(t);
  const owner = createProductionManuscriptLifecycleLockOwner();
  const receipt = owner.createFresh(current.canonicalRealControlDirectory);
  const lockPath = deriveManuscriptLifecycleLockPath(current.canonicalRealControlDirectory);

  assert.equal(fs.readFileSync(lockPath).length, 0);
  assert.equal(fs.lstatSync(lockPath, { bigint: true }).nlink, 1n);
  assert.deepEqual(Reflect.ownKeys(receipt), [
    'version',
    'lifecycleLockBefore',
    'lifecycleLockAfter',
    'lifecyclePlatformIdentity',
  ]);
  assert.deepEqual(receipt.lifecycleLockBefore, {
    disposition: 'absent',
    parentIdentity: receipt.lifecyclePlatformIdentity.controlParentDirectoryIdentity,
  });
  assert.deepEqual(receipt.lifecycleLockAfter, {
    byteSize: 0,
    fileFsync: true,
    identity: receipt.lifecyclePlatformIdentity.lifecycleLockIdentity,
    parentFsync: true,
    parentIdentity: receipt.lifecyclePlatformIdentity.controlParentDirectoryIdentity,
    sha256: EMPTY_SHA256,
  });
  assert.equal(
    receipt.lifecyclePlatformIdentity.canonicalRealControlDirectory,
    current.canonicalRealControlDirectory,
  );
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.lifecycleLockBefore));
  assert.ok(Object.isFrozen(receipt.lifecycleLockAfter));
  assert.ok(Object.isFrozen(receipt.lifecyclePlatformIdentity));
});

test('fresh lifecycle owner never adopts an existing lock without a durable ready receipt', (t) => {
  const current = fixture(t);
  const owner = createProductionManuscriptLifecycleLockOwner();
  const first = owner.createFresh(current.canonicalRealControlDirectory);
  const lockPath = deriveManuscriptLifecycleLockPath(current.canonicalRealControlDirectory);
  const before = fs.lstatSync(lockPath, { bigint: true });

  assert.throws(
    () => owner.createFresh(current.canonicalRealControlDirectory),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.created === false,
  );
  const after = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(first.lifecyclePlatformIdentity.lifecycleLockIdentity, {
    dev: String(after.dev),
    ino: String(after.ino),
  });
});

test('migration preflight distinguishes a present lock from its later durable receipt', (t) => {
  const current = fixture(t);
  const owner = createProductionManuscriptLifecycleLockOwner();
  const created = owner.createFresh(current.canonicalRealControlDirectory);

  const preflight = owner.inspectExistingPreflight(current.canonicalRealControlDirectory);

  assert.equal(assertManuscriptLifecycleLockPreflight(preflight), preflight);
  assert.deepEqual(Reflect.ownKeys(preflight), [
    'version',
    'disposition',
    'byteSize',
    'canonicalRealControlDirectory',
    'controlDirectoryIdentity',
    'controlParentDirectoryIdentity',
    'lifecycleLockIdentity',
    'linkCount',
    'reparse',
    'sha256',
  ]);
  assert.equal(Object.hasOwn(preflight, 'fileFsync'), false);
  assert.equal(Object.hasOwn(preflight, 'parentFsync'), false);
  assert.deepEqual(
    preflight.lifecycleLockIdentity,
    created.lifecyclePlatformIdentity.lifecycleLockIdentity,
  );

  const receipt = owner.durabilizePreexisting(preflight);
  assert.equal(receipt.lifecycleLockBefore.disposition, 'present');
  assert.deepEqual(receipt.lifecycleLockBefore.identity, preflight.lifecycleLockIdentity);
  assert.deepEqual(receipt.lifecycleLockAfter.identity, preflight.lifecycleLockIdentity);
  assert.equal(receipt.lifecycleLockAfter.fileFsync, true);
  assert.equal(receipt.lifecycleLockAfter.parentFsync, true);
  assert.equal(owner.verifyExisting(receipt), receipt.lifecyclePlatformIdentity);
});

test('ready lifecycle receipt verifies the existing lock without creating or replacing it', (t) => {
  const current = fixture(t);
  const owner = createProductionManuscriptLifecycleLockOwner();
  const receipt = owner.createFresh(current.canonicalRealControlDirectory);
  const lockPath = deriveManuscriptLifecycleLockPath(current.canonicalRealControlDirectory);
  const before = fs.lstatSync(lockPath, { bigint: true });

  const identity = owner.verifyExisting(receipt);

  assert.equal(identity, receipt.lifecyclePlatformIdentity);
  const after = fs.lstatSync(lockPath, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
});

test('ready lifecycle receipt remains durably verifiable while its shared lifecycle lease is held', {
  skip: process.platform !== 'win32',
}, (t) => {
  const current = fixture(t);
  const owner = createProductionManuscriptLifecycleLockOwner();
  const receipt = owner.createFresh(current.canonicalRealControlDirectory);
  const lease = createWindowsManuscriptLifecycleLeaseAdapter()
    .acquireShared(receipt.lifecyclePlatformIdentity);
  t.after(() => {
    if (lease.state === 'HELD') lease.release();
  });

  assert.equal(owner.verifyExisting(receipt), receipt.lifecyclePlatformIdentity);
  assert.equal(lease.state, 'HELD');
});

test('ready lifecycle verification fails closed when the lock is missing and never backfills it', (t) => {
  const current = fixture(t);
  const owner = createProductionManuscriptLifecycleLockOwner();
  const receipt = owner.createFresh(current.canonicalRealControlDirectory);
  const lockPath = deriveManuscriptLifecycleLockPath(current.canonicalRealControlDirectory);
  fs.unlinkSync(lockPath);

  assert.throws(
    () => owner.verifyExisting(receipt),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.created === false,
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test('durable lifecycle receipt validator preserves the original frozen journal object', (t) => {
  const current = fixture(t);
  const receipt = createProductionManuscriptLifecycleLockOwner()
    .createFresh(current.canonicalRealControlDirectory);
  const durableReceipt = deepFreeze(structuredClone(receipt));

  assert.equal(assertManuscriptLifecycleLockReceipt(durableReceipt), durableReceipt);
  assert.equal(
    assertManuscriptLifecycleLockReceipt(durableReceipt).lifecyclePlatformIdentity,
    durableReceipt.lifecyclePlatformIdentity,
  );
});

test('durable lifecycle receipt validator rejects a frozen non-plain wrapper', (t) => {
  const current = fixture(t);
  const receipt = createProductionManuscriptLifecycleLockOwner()
    .createFresh(current.canonicalRealControlDirectory);
  const foreignPrototype = Object.freeze({ foreign: true });
  const forged = Object.freeze(Object.assign(Object.create(foreignPrototype), receipt));

  assert.throws(
    () => assertManuscriptLifecycleLockReceipt(forged),
    TypeError,
  );
});

test('durable lifecycle receipt validator rejects non-canonical decimal identities', (t) => {
  const current = fixture(t);
  const receipt = structuredClone(createProductionManuscriptLifecycleLockOwner()
    .createFresh(current.canonicalRealControlDirectory));
  receipt.lifecyclePlatformIdentity.controlDirectoryIdentity.dev = '07';
  deepFreeze(receipt);

  assert.throws(
    () => assertManuscriptLifecycleLockReceipt(receipt),
    TypeError,
  );
});

test('production project roots materialize the lifecycle lock from the canonical control directory', (t) => {
  const current = fixture(t);
  const dataRoot = path.join(current.root, 'data');
  const projectsDir = path.join(current.root, 'projects');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(path.join(dataRoot, 'control'));
  fs.mkdirSync(projectsDir);
  const projectUid = '00000000-0000-4000-8000-000000000011';
  const projectInstanceId = '00000000-0000-4000-8000-000000000012';
  const directoryPlan = createCreationDirectoryPlan({
    dataRoot,
    projectsDir,
    projectName: 'Lifecycle Project',
    creationReservation: Object.freeze({
      projectInstanceId,
      projectReservation: Object.freeze({ uid: projectUid }),
    }),
  });

  assert.equal(Object.hasOwn(directoryPlan, 'lifecycleLockPath'), false);
  assert.equal(
    directoryPlan.lifecycleLockDerivation,
    'canonical-real-control-directory-sibling-sha256-v1',
  );
  const roots = ensureCreationDirectories({ dataRoot, directoryPlan, projectUid });
  const identity = roots.lifecycleLockReceipt.lifecyclePlatformIdentity;
  const lockPath = deriveManuscriptLifecycleLockPath(identity.canonicalRealControlDirectory);

  assert.equal(identity.canonicalRealControlDirectory, fs.realpathSync.native(
    directoryPlan.projectControlRoot,
  ));
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(fs.existsSync(`${directoryPlan.finalDatabasePath}.lifecycle.lock`), false);
  assert.equal(roots.lifecyclePlatformIdentity, identity);
  assert.equal(verifyCreationDirectories({
    dataRoot,
    directoryPlan,
    lifecycleLockReceipt: roots.lifecycleLockReceipt,
    projectUid,
  }), identity);
});

test('production project roots reject a changed lock derivation before any target directory', (t) => {
  const current = fixture(t);
  const dataRoot = path.join(current.root, 'data-invalid');
  const projectsDir = path.join(current.root, 'projects-invalid');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(path.join(dataRoot, 'control'));
  fs.mkdirSync(projectsDir);
  const projectUid = '00000000-0000-4000-8000-000000000021';
  const projectInstanceId = '00000000-0000-4000-8000-000000000022';
  const plan = createCreationDirectoryPlan({
    dataRoot,
    projectsDir,
    projectName: 'Invalid Lifecycle Project',
    creationReservation: Object.freeze({
      projectInstanceId,
      projectReservation: Object.freeze({ uid: projectUid }),
    }),
  });
  const changed = Object.freeze({ ...plan, lifecycleLockDerivation: 'foreign' });

  assert.throws(
    () => ensureCreationDirectories({ dataRoot, directoryPlan: changed, projectUid }),
    (error) => error?.code === 'RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(path.join(dataRoot, 'manuscripts')), false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'control', 'manuscripts')), false);
});

test('creation root reservation probe rejects an occupied sibling lock with zero target side effects', (t) => {
  const current = fixture(t);
  const dataRoot = path.join(current.root, 'data-probe');
  const projectsDir = path.join(current.root, 'projects-probe');
  const projectUid = '00000000-0000-4000-8000-000000000031';
  const projectInstanceId = '00000000-0000-4000-8000-000000000032';
  const creationId = '00000000-0000-4000-8000-000000000033';
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(path.join(dataRoot, 'control'));
  fs.mkdirSync(path.join(dataRoot, 'control', 'manuscripts'));
  fs.mkdirSync(path.join(dataRoot, 'control', 'manuscripts', projectUid));
  fs.mkdirSync(projectsDir);
  const plannedControl = path.join(
    dataRoot,
    'control',
    'manuscripts',
    projectUid,
    projectInstanceId,
  );
  const lockPath = deriveManuscriptLifecycleLockPath(plannedControl);
  fs.writeFileSync(lockPath, Buffer.alloc(0), { flag: 'wx' });
  const probe = createProjectRootProbe({
    dataRoot,
    projectsDir,
    projectName: 'Occupied Lifecycle Project',
  });

  assert.deepEqual(probe.probe({ creationId, projectInstanceId, projectUid }), {
    disposition: 'collision',
  });
  assert.equal(fs.existsSync(plannedControl), false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'manuscripts', projectUid)), false);
  assert.equal(fs.existsSync(path.join(projectsDir, 'Occupied Lifecycle Project.mythpen.db')), false);
  assert.equal(fs.existsSync(path.join(dataRoot, 'control', 'project-creation', creationId)), false);
});

test('migration absent preflight rejects a crash-gap lock before creating any target directory', (t) => {
  const current = fixture(t);
  const dataRoot = path.join(current.root, 'data-migration-gap');
  const projectsDir = path.join(current.root, 'projects-migration-gap');
  const projectUid = '00000000-0000-4000-8000-000000000041';
  const projectInstanceId = '00000000-0000-4000-8000-000000000042';
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(path.join(dataRoot, 'control'));
  fs.mkdirSync(path.join(dataRoot, 'control', 'manuscripts'));
  fs.mkdirSync(path.join(dataRoot, 'control', 'manuscripts', projectUid));
  fs.mkdirSync(projectsDir);
  const directoryPlan = createCreationDirectoryPlan({
    dataRoot,
    projectsDir,
    projectName: 'Migration Gap Project',
    creationReservation: Object.freeze({
      projectInstanceId,
      projectReservation: Object.freeze({ uid: projectUid }),
    }),
  });
  const lifecycleLockPreflight = Object.freeze({
    version: 1,
    disposition: 'absent',
    plannedControlDirectory: directoryPlan.projectControlRoot,
    plannedLifecycleLockPath: deriveManuscriptLifecycleLockPath(directoryPlan.projectControlRoot),
  });
  fs.writeFileSync(lifecycleLockPreflight.plannedLifecycleLockPath, Buffer.alloc(0), { flag: 'wx' });

  assert.throws(
    () => ensureMigrationDirectories({
      dataRoot,
      directoryPlan,
      lifecycleLockPreflight,
      projectUid,
    }),
    (error) => error?.code === 'RECOVERY_REQUIRED' && error.created === false,
  );
  assert.equal(fs.existsSync(directoryPlan.projectControlRoot), false);
  assert.equal(fs.existsSync(directoryPlan.articleRoot), false);
  assert.equal(fs.existsSync(directoryPlan.fileAssetsRoot), false);
});

test('migration adopts only the exact preflight-present entity and records before present after same', (t) => {
  const current = fixture(t);
  const dataRoot = path.join(current.root, 'data-migration-present');
  const projectsDir = path.join(current.root, 'projects-migration-present');
  const projectUid = '00000000-0000-4000-8000-000000000051';
  const projectInstanceId = '00000000-0000-4000-8000-000000000052';
  const migrationId = '00000000-0000-4000-8000-000000000053';
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(path.join(dataRoot, 'control'));
  fs.mkdirSync(path.join(dataRoot, 'control', 'manuscripts'));
  fs.mkdirSync(path.join(dataRoot, 'control', 'manuscripts', projectUid));
  const projectControlRoot = path.join(
    dataRoot,
    'control',
    'manuscripts',
    projectUid,
    projectInstanceId,
  );
  fs.mkdirSync(projectControlRoot);
  fs.mkdirSync(projectsDir);
  createProductionManuscriptLifecycleLockOwner().createFresh(
    fs.realpathSync.native(projectControlRoot),
  );
  const probe = createProjectRootProbe({
    dataRoot,
    projectsDir,
    projectName: 'Migration Present Project',
  });

  assert.deepEqual(probe.probe({ migrationId, projectInstanceId, projectUid }), {
    disposition: 'absent',
  });
  const selected = probe.selected();
  assert.equal(selected.lifecycleLockPreflight.disposition, 'present');
  const directoryPlan = createCreationDirectoryPlan({
    dataRoot,
    projectsDir,
    projectName: 'Migration Present Project',
    creationReservation: Object.freeze({
      projectInstanceId,
      projectReservation: Object.freeze({ uid: projectUid }),
    }),
  });
  const before = fs.lstatSync(
    deriveManuscriptLifecycleLockPath(projectControlRoot),
    { bigint: true },
  );

  const roots = ensureMigrationDirectories({
    dataRoot,
    directoryPlan,
    lifecycleLockPreflight: selected.lifecycleLockPreflight,
    projectUid,
  });

  assert.equal(roots.lifecycleLockReceipt.lifecycleLockBefore.disposition, 'present');
  assert.deepEqual(
    roots.lifecycleLockReceipt.lifecycleLockBefore.identity,
    roots.lifecycleLockReceipt.lifecycleLockAfter.identity,
  );
  const after = fs.lstatSync(
    deriveManuscriptLifecycleLockPath(projectControlRoot),
    { bigint: true },
  );
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
});
