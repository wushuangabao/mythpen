'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openControlStore } = require('../../control-store');
const { FilePublicationJournal } = require('../../manuscript/file-publication-journal');
const { FilePublisher } = require('../../manuscript/file-publisher');
const { deriveControlledFileRef } = require('../../manuscript/paths');
const { fsyncDirectory, fsyncFile } = require('../../platform/durability');
const {
  createProductionManuscriptFileBoundary,
} = require('../../platform/manuscript-file-boundary');
const { CRASH_ARTIFACTS_PATH_ENV } = require('../../testing/fault-injection');

const ROOT_ENV = 'MYTHPEN_FILE_PUBLICATION_CRASH_ROOT';
const SCENARIO_ENV = 'MYTHPEN_FILE_PUBLICATION_CRASH_SCENARIO';
const MODE_ENV = 'MYTHPEN_FILE_PUBLICATION_CRASH_MODE';
const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const JOURNAL_ID = '33333333-3333-4333-8333-333333333333';
const CHAPTER_UID = '55555555-5555-4555-8555-555555555555';
const BASIS_DIGEST = 'a'.repeat(64);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function identityFromStat(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function identityFor(filePath) {
  return identityFromStat(fs.statSync(filePath, { bigint: true }));
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function writeDurableJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value));
  fsyncFile(filePath);
  fsyncDirectory(path.dirname(filePath));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function scene(root) {
  const dataRoot = path.join(root, 'data');
  const articleRoot = path.join(dataRoot, 'manuscripts', PROJECT_UID);
  const chaptersRoot = path.join(articleRoot, 'mythpen', 'chapters');
  const controlDir = path.join(
    dataRoot,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
  );
  const recoveryRoot = path.join(controlDir, 'file-assets');
  return {
    root,
    dataRoot,
    articleRoot,
    chaptersRoot,
    recoveryRoot,
    controlDir,
    finalPath: path.join(chaptersRoot, `ch_${CHAPTER_UID}.md`),
    projectionMarker: path.join(root, 'projection-target.json'),
    resultPath: path.join(root, 'recovery-result.json'),
  };
}

function initializeScene(paths) {
  ensureDirectory(paths.chaptersRoot);
  ensureDirectory(path.join(paths.articleRoot, 'mythpen', 'volumes'));
  ensureDirectory(paths.recoveryRoot);
  if (!fs.existsSync(paths.finalPath)) {
    fs.writeFileSync(paths.finalPath, Buffer.from('before'));
    fsyncFile(paths.finalPath);
    fsyncDirectory(path.dirname(paths.finalPath));
  }
}

function createJournal(paths) {
  const controlStore = openControlStore(paths.controlDir);
  const { writerCapability } = createProductionManuscriptFileBoundary();
  const filePublisher = new FilePublisher({ writerCapability });
  const projectionStore = {
    validateTarget(target) {
      if (!Object.isFrozen(target)) throw new TypeError('target must be frozen');
      return target;
    },
    async publish({ target }) {
      writeDurableJson(paths.projectionMarker, target);
    },
  };
  const journal = new FilePublicationJournal({
    controlStore,
    filePublisher,
    projectionStore,
    projectStore: Object.freeze({ kind: 'fixture-project-store' }),
    projectionDisposition: {
      async inspectTarget() {
        return fs.existsSync(paths.projectionMarker) ? 'target' : 'base';
      },
    },
    parentAuthority: {
      async assertReservation() { throw new Error('full fixture has no parent reservation'); },
      async assertPin() { throw new Error('full fixture has no parent pin'); },
      async readRecoveryIntent() { throw new Error('full fixture has no parent intent'); },
      async assertGc() { throw new Error('full fixture has no parent gc authority'); },
    },
    projectBinding: deepFreeze({
      dataRoot: paths.dataRoot,
      projectUid: PROJECT_UID,
      projectInstanceId: PROJECT_INSTANCE_ID,
      controlIncarnationId: controlStore.incarnationId,
      articleRootIdentity: identityFor(paths.articleRoot),
      recoveryRootIdentity: identityFor(paths.recoveryRoot),
    }),
    async assertWriteAuthority() {},
  });
  return { controlStore, journal };
}

function closure(paths) {
  const ref = deriveControlledFileRef({
    role: 'chapter_body',
    projectUid: PROJECT_UID,
    chapterUid: CHAPTER_UID,
  });
  const beforeBytes = Buffer.from('before');
  const afterBytes = Buffer.from('after');
  return deepFreeze([deepFreeze({
    ref,
    parentIdentity: identityFor(path.dirname(paths.finalPath)),
    before: deepFreeze({
      exists: true,
      bytes: beforeBytes,
      byteSize: beforeBytes.length,
      rawSha256: sha256(beforeBytes),
      fileIdentity: identityFor(paths.finalPath),
    }),
    after: deepFreeze({
      exists: true,
      bytes: afterBytes,
      byteSize: afterBytes.length,
      rawSha256: sha256(afterBytes),
    }),
  })]);
}

function projectionTarget(stagedFact) {
  return deepFreeze({
    domain: 'mythpen.test.projection-target',
    version: 1,
    projectUid: PROJECT_UID,
    projectInstanceId: PROJECT_INSTANCE_ID,
    basisDigest: BASIS_DIGEST,
    baseGeneration: 3,
    targetGeneration: 4,
    controlledFiles: [deepFreeze({
      role: stagedFact.ref.role,
      resourceUid: stagedFact.ref.chapterUid,
      byteSize: stagedFact.byteSize,
      rawSha256: stagedFact.rawSha256,
      fileIdentity: stagedFact.fileIdentity,
      parentIdentity: stagedFact.parentIdentity,
    })],
  });
}

async function runInitial(paths) {
  const { journal } = createJournal(paths);
  const staged = await journal.stageAssets({
    journalId: JOURNAL_ID,
    logicalRequestId: 'fixture-logical-request',
    baseGeneration: 3,
    targetGeneration: 4,
    basisDigest: BASIS_DIGEST,
    closure: closure(paths),
    identityReservation: null,
    parent: null,
    parentReservationAuthority: undefined,
  });
  const bound = await journal.bindTarget({
    stagedAssets: staged.stagedAssets,
    projectionTarget: projectionTarget(staged.stagedAfterFacts[0]),
  });
  await journal.prepare({ preparedAssets: bound.preparedAssets });
  await journal.publishFiles(JOURNAL_ID);
  await journal.commitProjection(JOURNAL_ID);
  await journal.complete(JOURNAL_ID);
  await journal.collectAssets(JOURNAL_ID);
  throw new Error('configured crash point was not reached');
}

async function runRecovery(paths, scenario) {
  const { controlStore, journal } = createJournal(paths);
  let recovery;
  try {
    recovery = await journal.recover(JOURNAL_ID);
  } catch (error) {
    const reservation = controlStore.read().find((event) => (
      event.type === 'manuscript.file_publication.assets_reserved'
      && event.payload.record_kind === 'reservation'
    ));
    const member = reservation?.payload.members[0];
    const observations = {};
    for (const [label, filePath] of [
      ['final', member?.final.path],
      ['displaced', member?.displaced.path],
      ['staged', member?.after.assetReservation?.path],
    ]) {
      if (!filePath || !fs.existsSync(filePath)) {
        observations[label] = { exists: false };
        continue;
      }
      const bytes = fs.readFileSync(filePath);
      observations[label] = {
        exists: true,
        identity: identityFor(filePath),
        parentIdentity: identityFor(path.dirname(filePath)),
        byteSize: bytes.length,
        sha256: sha256(bytes),
      };
    }
    error.message += ` scene=${JSON.stringify(observations)}`;
    throw error;
  }
  if (recovery.state === 'completed' || recovery.state === 'rolled_back') {
    recovery = await journal.collectAssets(JOURNAL_ID);
  }
  const events = controlStore.read().filter((event) => (
    event.type.startsWith('manuscript.file_publication.')
    && event.payload.journalId === JOURNAL_ID
  ));
  const residuals = fs.readdirSync(paths.recoveryRoot)
    .filter((name) => name.startsWith(`${JOURNAL_ID}.`))
    .sort();
  writeDurableJson(paths.resultPath, {
    scenario,
    state: recovery.state,
    finalBytes: fs.readFileSync(paths.finalPath, 'utf8'),
    projectionExists: fs.existsSync(paths.projectionMarker),
    residuals,
    eventTypes: events.map((event) => event.type),
  });
}

async function main() {
  const root = process.env[ROOT_ENV];
  const scenario = process.env[SCENARIO_ENV];
  const mode = process.env[MODE_ENV] || 'initial';
  if (!root || !scenario) throw new Error(`${ROOT_ENV} and ${SCENARIO_ENV} are required`);
  const paths = scene(path.resolve(root));
  if (mode === 'recover') {
    await runRecovery(paths, scenario);
    return;
  }
  initializeScene(paths);
  const artifactsPath = process.env[CRASH_ARTIFACTS_PATH_ENV];
  if (!artifactsPath) throw new Error(`${CRASH_ARTIFACTS_PATH_ENV} is required`);
  writeDurableJson(artifactsPath, {
    version: 1,
    scenario,
    root: paths.root,
    controlDir: paths.controlDir,
    finalPath: paths.finalPath,
    recoveryRoot: paths.recoveryRoot,
    projectionMarker: paths.projectionMarker,
    resultPath: paths.resultPath,
  });
  await runInitial(paths);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
