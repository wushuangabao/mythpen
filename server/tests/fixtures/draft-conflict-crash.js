'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openControlStore } = require('../../control-store');
const { DraftConflictJournal } = require('../../manuscript/draft-conflict-journal');
const { fsyncDirectory, fsyncFile } = require('../../platform/durability');
const { CRASH_ARTIFACTS_PATH_ENV, faultPoint } = require('../../testing/fault-injection');

const ROOT_ENV = 'MYTHPEN_DRAFT_CONFLICT_CRASH_ROOT';
const MODE_ENV = 'MYTHPEN_DRAFT_CONFLICT_CRASH_MODE';
const SCENARIO_ENV = 'MYTHPEN_DRAFT_CONFLICT_CRASH_SCENARIO';
const PROJECT_UID = '11111111-1111-4111-8111-111111111111';
const PROJECT_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const CONFLICT_ID = '33333333-3333-4333-8333-333333333333';
const CHAPTER_UID = '55555555-5555-4555-8555-555555555555';

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function identityFor(target) {
  const stat = fs.statSync(target, { bigint: true });
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null
    || typeof value !== 'object'
    || Buffer.isBuffer(value)
    || Object.isFrozen(value)
  ) return value;
  if (seen.has(value)) throw new TypeError('cycle');
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  seen.delete(value);
  return Object.freeze(value);
}

function writeNewDurable(filePath, bytes) {
  const handle = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function pathsFor(root) {
  const dataRoot = path.join(root, 'data');
  const controlDir = path.join(
    dataRoot,
    'control',
    'manuscripts',
    PROJECT_UID,
    PROJECT_INSTANCE_ID,
  );
  const backupRoot = path.join(controlDir, 'draft-conflict');
  return {
    dataRoot,
    controlDir,
    backupRoot,
    conflictDirectory: path.join(backupRoot, CONFLICT_ID),
    resultPath: path.join(root, 'draft-conflict-recovery.json'),
  };
}

function receipt(paths, manifest) {
  const directoryIdentity = identityFor(paths.conflictDirectory);
  return deepFreeze({
    status: 'complete',
    projectUid: manifest.projectUid,
    projectInstanceId: manifest.projectInstanceId,
    conflictId: manifest.conflictId,
    layoutDigest: manifest.layoutDigest,
    directoryPath: manifest.conflictDirectoryPath,
    directoryIdentity,
    parentPath: manifest.backupRootPath,
    parentIdentity: identityFor(paths.backupRoot),
    directoryFlushed: true,
    parentFlushed: true,
    files: ['draft.bin', 'external.bin', 'manifest.json'].map((name) => {
      const filePath = path.join(paths.conflictDirectory, name);
      const bytes = fs.readFileSync(filePath);
      return deepFreeze({
        name,
        byteSize: bytes.length,
        rawSha256: sha256(bytes),
        fileIdentity: identityFor(filePath),
        parentIdentity: directoryIdentity,
        flushed: true,
        readback: true,
      });
    }),
  });
}

function backupStorage(paths) {
  return {
    async create({ manifest, draftBytes, externalBytes }) {
      fs.mkdirSync(paths.backupRoot, { recursive: true });
      fs.mkdirSync(paths.conflictDirectory);
      writeNewDurable(path.join(paths.conflictDirectory, 'draft.bin'), draftBytes);
      faultPoint('draft-conflict.after-draft-file-fsync');
      writeNewDurable(path.join(paths.conflictDirectory, 'external.bin'), externalBytes);
      faultPoint('draft-conflict.after-external-file-fsync');
      writeNewDurable(
        path.join(paths.conflictDirectory, 'manifest.json'),
        Buffer.from(canonicalJson(manifest), 'utf8'),
      );
      fsyncDirectory(paths.conflictDirectory);
      fsyncDirectory(paths.backupRoot);
      faultPoint('draft-conflict.after-backup-parent-fsync');
      return receipt(paths, manifest);
    },
    async inspect({ manifest }) {
      if (!fs.existsSync(paths.conflictDirectory)) {
        return deepFreeze({
          status: 'incomplete',
          conflictId: manifest.conflictId,
          owned: true,
          externalContents: false,
        });
      }
      const names = fs.readdirSync(paths.conflictDirectory).sort();
      const expected = ['draft.bin', 'external.bin', 'manifest.json'];
      if (names.join('\0') !== expected.join('\0')) {
        const externalContents = names.some((name) => !expected.includes(name));
        return deepFreeze({
          status: 'incomplete',
          conflictId: manifest.conflictId,
          owned: true,
          externalContents,
        });
      }
      const persisted = JSON.parse(
        fs.readFileSync(path.join(paths.conflictDirectory, 'manifest.json'), 'utf8'),
      );
      if (canonicalJson(persisted) !== canonicalJson(manifest)) {
        return deepFreeze({
          status: 'incomplete',
          conflictId: manifest.conflictId,
          owned: true,
          externalContents: true,
        });
      }
      return receipt(paths, manifest);
    },
    async discardIncomplete({ manifest }) {
      fs.rmSync(paths.conflictDirectory, { recursive: true });
      fsyncDirectory(paths.backupRoot);
      return deepFreeze({ conflictId: manifest.conflictId, removed: true });
    },
  };
}

function inertDisposition() {
  return {
    async inspect() {
      return Object.freeze({});
    },
    classify() {
      return 'other';
    },
  };
}

function createJournal(paths) {
  const controlStore = openControlStore(paths.controlDir);
  const disposition = inertDisposition();
  return {
    controlStore,
    journal: new DraftConflictJournal({
      controlStore,
      projectBinding: deepFreeze({
        dataRoot: paths.dataRoot,
        projectUid: PROJECT_UID,
        projectInstanceId: PROJECT_INSTANCE_ID,
        controlIncarnationId: controlStore.incarnationId,
      }),
      backupStorage: backupStorage(paths),
      childDisposition: disposition,
      projectionDisposition: disposition,
      uuidV4() {
        return CONFLICT_ID;
      },
      clock() {
        return 1_700_000_000_000;
      },
    }),
  };
}

async function initial(paths) {
  const { journal } = createJournal(paths);
  await journal.createConflict({
    resource: deepFreeze({ kind: 'chapter', uid: CHAPTER_UID, domain: 'body' }),
    basis: deepFreeze({ baseGeneration: 4, baseRawSha256: 'a'.repeat(64) }),
    draftBytes: Buffer.from('local draft'),
    externalBytes: Buffer.from('external bytes'),
    fieldMask: deepFreeze(['content']),
    supersedes: null,
  });
  throw new Error('configured crash point was not reached');
}

async function recover(paths) {
  const { journal, controlStore } = createJournal(paths);
  const result = await journal.recover(CONFLICT_ID);
  const eventTypes = controlStore.read()
    .filter((event) => event.type.startsWith('draft_conflict.'))
    .map((event) => event.type);
  fs.writeFileSync(paths.resultPath, JSON.stringify({
    ...result,
    backupExists: fs.existsSync(paths.conflictDirectory),
    eventTypes,
  }));
}

async function main() {
  const root = process.env[ROOT_ENV];
  const mode = process.env[MODE_ENV] || 'initial';
  const scenario = process.env[SCENARIO_ENV];
  if (!root || !scenario) throw new Error('draft conflict crash fixture environment is incomplete');
  const paths = pathsFor(path.resolve(root));
  if (mode === 'recover') {
    await recover(paths);
    return;
  }
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  const artifactsPath = process.env[CRASH_ARTIFACTS_PATH_ENV];
  if (!artifactsPath) throw new Error(`${CRASH_ARTIFACTS_PATH_ENV} is required`);
  fs.writeFileSync(artifactsPath, JSON.stringify({
    version: 1,
    scenario,
    resultPath: paths.resultPath,
  }));
  fsyncFile(artifactsPath);
  await initial(paths);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
