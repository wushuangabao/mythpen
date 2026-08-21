'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { deriveManuscriptPaths } = require('./paths');
const { createHash } = require('node:crypto');
const { fsyncDirectory } = require('../platform/durability');

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
      const targets = [
        paths.articleRoot,
        path.join(dataRoot, 'control', 'manuscripts', input.projectUid, input.projectInstanceId),
        ...(input.creationId === undefined ? [] : [
          path.join(projectsDir, `${name}.mythpen.db`),
          path.join(dataRoot, 'control', 'project-creation', input.creationId),
        ]),
      ];
      const disposition = targets.some((target) => fs.existsSync(target))
        ? 'collision'
        : 'absent';
      if (disposition === 'absent') {
        selected = Object.freeze({
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
    lifecycleLockPath: `${finalDatabasePath}.lifecycle.lock`,
    projectControlRoot,
    articleRoot: paths.articleRoot,
    fileAssetsRoot: path.join(projectControlRoot, 'file-assets'),
  };
  plan.digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  return Object.freeze(plan);
}

function ensureCreationDirectories({ dataRoot, directoryPlan, projectUid }) {
  const paths = deriveManuscriptPaths({ dataRoot, projectUid });
  if (
    directoryPlan.articleRoot !== paths.articleRoot
    || directoryPlan.projectControlRoot !== path.dirname(directoryPlan.fileAssetsRoot)
  ) throw rootError('Creation directory plan changed before materialization');
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
  return Object.freeze({
    paths,
    projectBinding: Object.freeze({
      articleRootIdentity: physicalIdentity(fs.lstatSync(paths.articleRoot, { bigint: true })),
      projectUid,
    }),
  });
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
  openActivatedProjectRoot,
};
