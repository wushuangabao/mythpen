'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { deriveManuscriptPaths } = require('./paths');
const { createHash } = require('node:crypto');
const { fsyncDirectory } = require('../platform/durability');
const {
  MANUSCRIPT_LIFECYCLE_LOCK_DERIVATION,
  assertManuscriptLifecycleLockPreflight,
  createProductionManuscriptLifecycleLockOwner,
  deriveManuscriptLifecycleLockPath,
} = require('./lifecycle-lock');

function rootError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'RECOVERY_REQUIRED';
  return error;
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function physicalIdentity(stats) {
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function pathOccupied(targetPath) {
  try {
    fs.lstatSync(targetPath, { bigint: true });
    return true;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return false;
    throw rootError('Project root occupancy is unknown', cause);
  }
}

function safeProjectName(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || path.basename(value) !== value
    || /[\\/:*?"<>|\0]/u.test(value)
  ) throw new TypeError('project name is not one controlled file stem');
  return value;
}

function createProjectRootProbe({ dataRoot, projectsDir, projectName }) {
  const name = safeProjectName(projectName);
  let selected = null;
  return Object.freeze({
    probe(input) {
      const paths = deriveManuscriptPaths({ dataRoot, projectUid: input.projectUid });
      const projectControlRoot = path.join(
        dataRoot,
        'control',
        'manuscripts',
        input.projectUid,
        input.projectInstanceId,
      );
      const lifecycleLockPath = deriveManuscriptLifecycleLockPath(projectControlRoot);
      const controlPresent = pathOccupied(projectControlRoot);
      const lockPresent = pathOccupied(lifecycleLockPath);
      const targets = [
        paths.articleRoot,
        ...(input.creationId === undefined ? [] : [
          projectControlRoot,
          path.join(projectsDir, `${name}.mythpen.db`),
          path.join(dataRoot, 'control', 'project-creation', input.creationId),
        ]),
      ];
      const lifecycleCollision = input.creationId === undefined
        ? controlPresent !== lockPresent
        : lockPresent;
      const disposition = lifecycleCollision || targets.some(pathOccupied)
        ? 'collision'
        : 'absent';
      if (disposition === 'absent') {
        let lifecycleLockPreflight;
        if (lockPresent) {
          let canonicalRealControlDirectory;
          try {
            canonicalRealControlDirectory = fs.realpathSync.native(projectControlRoot);
            lifecycleLockPreflight = createProductionManuscriptLifecycleLockOwner()
              .inspectExistingPreflight(canonicalRealControlDirectory);
          } catch (cause) {
            throw rootError('Migration preexisting lifecycle lock preflight failed', cause);
          }
        } else {
          lifecycleLockPreflight = Object.freeze({
            version: 1,
            disposition: 'absent',
            plannedControlDirectory: projectControlRoot,
            plannedLifecycleLockPath: lifecycleLockPath,
          });
        }
        selected = Object.freeze({
          lifecycleLockPreflight,
          operationId: input.creationId ?? input.migrationId,
          projectInstanceId: input.projectInstanceId,
          projectUid: input.projectUid,
        });
      }
      return Object.freeze({ disposition });
    },
    selected() {
      if (selected === null) throw rootError('Project root probe has no selected absent binding');
      return selected;
    },
  });
}

function assertDirectoryPlan({ dataRoot, directoryPlan, projectUid }, label) {
  const paths = deriveManuscriptPaths({ dataRoot, projectUid });
  if (
    directoryPlan.articleRoot !== paths.articleRoot
    || directoryPlan.projectControlRoot !== path.dirname(directoryPlan.fileAssetsRoot)
    || directoryPlan.lifecycleLockDerivation !== MANUSCRIPT_LIFECYCLE_LOCK_DERIVATION
  ) throw rootError(`${label} directory plan changed before materialization`);
  return paths;
}

function assertLifecycleLockAbsent(lockPath) {
  try {
    fs.lstatSync(lockPath, { bigint: true });
    throw rootError('Planned absent lifecycle lock target is occupied');
  } catch (cause) {
    if (cause?.code !== 'ENOENT') {
      if (cause?.code === 'RECOVERY_REQUIRED') cause.created = false;
      throw cause;
    }
  }
}

function materializeDirectories({ dataRoot, directoryPlan, paths, projectUid }) {
  const directories = [
    paths.manuscriptsRoot,
    paths.articleRoot,
    paths.mythpenRoot,
    paths.volumesRoot,
    paths.chaptersRoot,
    path.join(dataRoot, 'control', 'manuscripts'),
    path.join(dataRoot, 'control', 'manuscripts', projectUid),
    directoryPlan.projectControlRoot,
    directoryPlan.fileAssetsRoot,
  ];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory);
      fsyncDirectory(path.dirname(directory));
    }
    const stats = fs.lstatSync(directory, { bigint: true });
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || canonicalPath(fs.realpathSync.native(directory)) !== canonicalPath(directory)
    ) throw rootError('Creation directory is not one plain controlled directory');
  }
}

function rootsResult({ lifecycleLockReceipt, paths, projectUid }) {
  return Object.freeze({
    lifecycleLockReceipt,
    lifecyclePlatformIdentity: lifecycleLockReceipt.lifecyclePlatformIdentity,
    paths,
    projectBinding: Object.freeze({
      articleRootIdentity: physicalIdentity(fs.lstatSync(paths.articleRoot, { bigint: true })),
      projectUid,
    }),
  });
}

function createCreationDirectoryPlan({
  dataRoot,
  projectsDir,
  projectName,
  creationReservation,
}) {
  const name = safeProjectName(projectName);
  const projectUid = creationReservation.projectReservation.uid;
  const projectInstanceId = creationReservation.projectInstanceId;
  const paths = deriveManuscriptPaths({ dataRoot, projectUid });
  const finalDatabasePath = path.join(projectsDir, `${name}.mythpen.db`);
  const projectControlRoot = path.join(
    dataRoot,
    'control',
    'manuscripts',
    projectUid,
    projectInstanceId,
  );
  const plan = {
    finalDatabasePath,
    lifecycleLockDerivation: MANUSCRIPT_LIFECYCLE_LOCK_DERIVATION,
    projectControlRoot,
    articleRoot: paths.articleRoot,
    fileAssetsRoot: path.join(projectControlRoot, 'file-assets'),
  };
  plan.digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return Object.freeze(plan);
}

function ensureCreationDirectories({ dataRoot, directoryPlan, projectUid }) {
  const paths = assertDirectoryPlan({ dataRoot, directoryPlan, projectUid }, 'Creation');
  assertLifecycleLockAbsent(deriveManuscriptLifecycleLockPath(directoryPlan.projectControlRoot));
  materializeDirectories({ dataRoot, directoryPlan, paths, projectUid });
  const canonicalRealControlDirectory = fs.realpathSync.native(directoryPlan.projectControlRoot);
  const lifecycleLockReceipt = createProductionManuscriptLifecycleLockOwner()
    .createFresh(canonicalRealControlDirectory);
  return rootsResult({ lifecycleLockReceipt, paths, projectUid });
}

function ensureMigrationDirectories({
  dataRoot,
  directoryPlan,
  lifecycleLockPreflight: preflightValue,
  projectUid,
}) {
  const paths = assertDirectoryPlan({ dataRoot, directoryPlan, projectUid }, 'Migration');
  const preflight = assertManuscriptLifecycleLockPreflight(preflightValue);
  const expectedLockPath = deriveManuscriptLifecycleLockPath(directoryPlan.projectControlRoot);
  let lifecycleLockReceipt;
  if (preflight.disposition === 'absent') {
    if (
      preflight.plannedControlDirectory !== directoryPlan.projectControlRoot
      || preflight.plannedLifecycleLockPath !== expectedLockPath
    ) throw rootError('Migration absent lifecycle preflight is bound to another directory plan');
    assertLifecycleLockAbsent(expectedLockPath);
    materializeDirectories({ dataRoot, directoryPlan, paths, projectUid });
    lifecycleLockReceipt = createProductionManuscriptLifecycleLockOwner().createFresh(
      fs.realpathSync.native(directoryPlan.projectControlRoot),
    );
  } else {
    if (preflight.canonicalRealControlDirectory !== directoryPlan.projectControlRoot) {
      throw rootError('Migration present lifecycle preflight is bound to another directory plan');
    }
    lifecycleLockReceipt = createProductionManuscriptLifecycleLockOwner()
      .durabilizePreexisting(preflight);
    materializeDirectories({ dataRoot, directoryPlan, paths, projectUid });
  }
  return rootsResult({ lifecycleLockReceipt, paths, projectUid });
}

function verifyCreationDirectories({
  dataRoot,
  directoryPlan,
  lifecycleLockReceipt,
  projectUid,
}) {
  const paths = deriveManuscriptPaths({ dataRoot, projectUid });
  if (
    directoryPlan.articleRoot !== paths.articleRoot
    || directoryPlan.projectControlRoot !== path.dirname(directoryPlan.fileAssetsRoot)
    || directoryPlan.lifecycleLockDerivation !== MANUSCRIPT_LIFECYCLE_LOCK_DERIVATION
  ) throw rootError('Creation directory plan changed before lifecycle verification');
  let canonicalRealControlDirectory;
  try {
    canonicalRealControlDirectory = fs.realpathSync.native(directoryPlan.projectControlRoot);
  } catch (cause) {
    throw rootError('Creation ControlStore is unavailable for lifecycle verification', cause);
  }
  if (
    lifecycleLockReceipt?.lifecyclePlatformIdentity?.canonicalRealControlDirectory
      !== canonicalRealControlDirectory
  ) throw rootError('Creation lifecycle receipt is bound to another ControlStore');
  return createProductionManuscriptLifecycleLockOwner().verifyExisting(lifecycleLockReceipt);
}

function openActivatedProjectRoot({ dataRoot, projectUid }) {
  const paths = deriveManuscriptPaths({ dataRoot, projectUid });
  let stats;
  let realPath;
  try {
    stats = fs.lstatSync(paths.articleRoot, { bigint: true });
    realPath = fs.realpathSync.native(paths.articleRoot);
  } catch (cause) {
    throw rootError('Activated manuscript root is not durably reachable', cause);
  }
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || canonicalPath(realPath) !== canonicalPath(paths.articleRoot)
    || !canonicalPath(paths.articleRoot).startsWith(`${canonicalPath(dataRoot)}${path.sep}`)
  ) throw rootError('Activated manuscript root is outside the controlled data root');
  return Object.freeze({
    paths,
    projectBinding: Object.freeze({
      articleRootIdentity: physicalIdentity(stats),
      projectUid,
    }),
  });
}

module.exports = {
  createCreationDirectoryPlan,
  createProjectRootProbe,
  ensureCreationDirectories,
  ensureMigrationDirectories,
  openActivatedProjectRoot,
  verifyCreationDirectories,
};
