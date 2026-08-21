'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../db');
const {
  createManuscriptService,
} = require('../manuscript-service');
const { openControlStore } = require('../control-store');
const {
  assertProductionManuscriptFileBoundaryPair,
  createProductionManuscriptFileBoundary,
} = require('../platform/manuscript-file-boundary');
const {
  createWindowsManuscriptChangeFeedAdapter,
} = require('../platform/windows-manuscript-change-feed');
const {
  createWindowsManuscriptLifecycleLeaseAdapter,
} = require('../platform/windows-manuscript-lifecycle-lease');
const { fsyncDirectory } = require('../platform/durability');
const { FilePublicationJournal } = require('./file-publication-journal');
const { FilePublisher } = require('./file-publisher');
const { DraftConflictJournal } = require('./draft-conflict-journal');
const { DraftConflictService } = require('./draft-conflict-service');
const { IgnoredIdentityLedger } = require('./ignored-ledger');
const { OrphanResolutionService } = require('./orphan-resolution-service');
const { createManuscriptProductGates } = require('./product-gates');
const {
  createManuscriptFreshnessLifecycle,
  createProductWriteFreshness,
  ensureProjectionCurrent,
  ensureReadableProjection,
} = require('./freshness');
const { createL2ManuscriptService } = require('./l2-service');
const { createRevisionService } = require('./revision-service');
const { deriveControlledFileRef } = require('./paths');
const {
  SQLiteProjectionStore,
  canonicalSchema12ReuseIdentityPlan,
  currentProjectionAfterTarget,
} = require('./projection-store');
const { openActivatedProjectRoot } = require('./production-project-roots');
const { createProductionCreationAdapter } = require('./production-creation-adapter');
const {
  createProductionDraftConflictStorage,
} = require('./production-draft-conflict-storage');
const {
  decodeDraftConflictCommand,
  encodeDraftConflictBackup,
} = require('./production-draft-conflict-codec');
const { createProductionMigrationAdapter } = require('./production-migration-adapter');
const { createManuscriptRuntime } = require('./runtime');
const { ManuscriptStore } = require('./store');
const { ManuscriptUidReservation } = require('./uid-reservation');
const { createUidReservationSources } = require('./uid-reservation-sources');
const { ManuscriptSessionController } = require('./session-controller');
const {
  assertManuscriptLifecycleLockReceipt,
  createProductionManuscriptLifecycleLockOwner,
  deriveManuscriptLifecycleLockPath,
} = require('./lifecycle-lock');
const { MigrationJournal } = require('./migration-journal');
const { ProjectCreationJournal } = require('./project-creation-journal');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function productionError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function createOpaqueDescriptorBroker(label) {
  const records = new WeakMap();
  const authority = Object.freeze({
    assert(intent) {
      if (this !== authority || !records.has(intent)) {
        throw new TypeError(`${label} is foreign`);
      }
      return intent;
    },
    describe(intent) {
      if (this !== authority) throw new TypeError(`${label} authority receiver is foreign`);
      const descriptor = records.get(intent);
      if (descriptor === undefined) throw new TypeError(`${label} is foreign`);
      return descriptor;
    },
  });
  return Object.freeze({
    authority,
    mint(descriptor) {
      if (!Object.isFrozen(descriptor)) throw new TypeError(`${label} descriptor must be frozen`);
      const intent = Object.freeze({});
      records.set(intent, descriptor);
      return intent;
    },
    register(intent, descriptor) {
      if (
        intent === null
        || typeof intent !== 'object'
        || !Object.isFrozen(intent)
        || !Object.isFrozen(descriptor)
        || records.has(intent)
      ) throw new TypeError(`${label} registration is invalid`);
      records.set(intent, descriptor);
      return intent;
    },
  });
}

function revisionRequestKey(logicalRequestId) {
  return `_mythpen_revision_request:${sha256(logicalRequestId)}`;
}

function sameWitness(left, right) {
  return left.expectedDataVersion === right.expectedDataVersion
    && left.generation === right.generation
    && left.rawSha256 === right.rawSha256
    && left.sidecarRawSha256 === right.sidecarRawSha256;
}

function samePhysicalIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameLifecyclePlatformIdentity(left, right) {
  return left?.canonicalRealControlDirectory === right?.canonicalRealControlDirectory
    && samePhysicalIdentity(left?.controlDirectoryIdentity, right?.controlDirectoryIdentity)
    && samePhysicalIdentity(left?.controlParentDirectoryIdentity, right?.controlParentDirectoryIdentity)
    && samePhysicalIdentity(left?.lifecycleLockIdentity, right?.lifecycleLockIdentity);
}

function exactCommandData(value, variants, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) throw new TypeError(`${label} must contain own enumerable data only`);
  }
  const keys = Object.keys(descriptors).sort();
  const matched = variants.find((variant) => {
    const expected = [...variant].sort();
    return keys.length === expected.length
      && keys.every((key, index) => key === expected[index]);
  });
  if (matched === undefined) throw new TypeError(`${label} has an inexact key set`);
  return Object.freeze(Object.fromEntries(matched.map((key) => [key, descriptors[key].value])));
}

function stableUid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function stableUidArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain dense array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  const result = [];
  const seen = new Set();
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) throw new TypeError(`${label} must be a dense data array`);
    const uid = stableUid(descriptor.value, `${label}[${index}]`);
    if (seen.has(uid)) throw new TypeError(`${label} may not contain duplicates`);
    seen.add(uid);
    result.push(uid);
  }
  if (Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new TypeError(`${label} has an invalid array property`);
  }
  return Object.freeze(result);
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function revisionText(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function revisionDecisions(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = {};
  for (const key of Reflect.ownKeys(descriptors).sort((left, right) => (
    Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'))
  ))) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || key.length === 0
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
      || (descriptor.value !== 'accepted' && descriptor.value !== 'rejected')
    ) throw new TypeError(`${label} contains an invalid decision`);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function activeLifecycleBasis(basis) {
  return Object.freeze({
    activeChapterUids: Object.freeze(basis.chapters
      .filter((row) => row.isPresent === 1)
      .map((row) => row.uid)),
    activeVolumeUids: Object.freeze(basis.volumes
      .filter((row) => row.isPresent === 1)
      .map((row) => row.uid)),
    chapterTombstoneUids: Object.freeze(basis.chapters
      .filter((row) => row.isPresent === 0)
      .map((row) => row.uid)),
    volumeTombstoneUids: Object.freeze(basis.volumes
      .filter((row) => row.isPresent === 0)
      .map((row) => row.uid)),
  });
}

function denyParentAuthority() {
  const deny = () => { throw productionError('RECOVERY_REQUIRED', 'Ordinary publication has no parent journal authority'); };
  return Object.freeze({
    assertReservation: deny,
    assertPin: deny,
    readRecoveryIntent: deny,
    assertGc: deny,
  });
}

function evidenceOnlyDisposition() {
  return Object.freeze({
    classify(evidence) {
      if (evidence?.disposition === 'after' || evidence?.state === 'files_published') return 'after';
      if (evidence?.disposition === 'before') return 'before';
      return 'unknown';
    },
    inspect() {
      throw productionError('RECOVERY_REQUIRED', 'Cold UID catalog may not mutate or recover journal disposition');
    },
  });
}

function exactDirectoryEntries(directory, label) {
  try {
    fs.lstatSync(directory, { bigint: true });
  } catch (cause) {
    if (cause?.code === 'ENOENT') return Object.freeze([]);
    throw productionError('RECOVERY_REQUIRED', `${label} is unavailable`, cause);
  }
  directoryIdentity(directory, label);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    throw productionError('RECOVERY_REQUIRED', `${label} cannot be enumerated`, cause);
  }
  return Object.freeze(entries.map((entry) => {
    const entryPath = path.join(directory, entry.name);
    let stats;
    try {
      stats = fs.lstatSync(entryPath, { bigint: true });
    } catch (cause) {
      throw productionError('RECOVERY_REQUIRED', `${label} entry is unavailable`, cause);
    }
    if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
      throw productionError('RECOVERY_REQUIRED', `${label} contains a reparse entry`);
    }
    const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    return Object.freeze({ kind, name: entry.name, path: entryPath });
  }).sort((left, right) => left.name.localeCompare(right.name)));
}

function directoryIdentity(directory, label) {
  let stats;
  let realPath;
  try {
    stats = fs.lstatSync(directory, { bigint: true });
    realPath = fs.realpathSync.native(directory);
  } catch (cause) {
    throw productionError('RECOVERY_REQUIRED', `${label} is unavailable`, cause);
  }
  const expected = path.resolve(directory);
  const sameCanonicalPath = process.platform === 'win32'
    ? realPath.toLowerCase() === expected.toLowerCase()
    : realPath === expected;
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameCanonicalPath) {
    throw productionError('RECOVERY_REQUIRED', `${label} is not one canonical plain directory`);
  }
  return Object.freeze({
    canonicalRealPath: realPath,
    identity: Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) }),
  });
}

function captureChangeFeedPlatformIdentity(roots) {
  const article = directoryIdentity(roots.paths.articleRoot, 'Article root');
  const mythpen = directoryIdentity(roots.paths.mythpenRoot, 'Mythpen metadata root');
  const volumes = directoryIdentity(roots.paths.volumesRoot, 'Mythpen volumes root');
  const chapters = directoryIdentity(roots.paths.chaptersRoot, 'Mythpen chapters root');
  return Object.freeze({
    canonicalRealMythpenDirectory: mythpen.canonicalRealPath,
    articleRootDirectoryIdentity: article.identity,
    mythpenDirectoryIdentity: mythpen.identity,
    volumesDirectoryIdentity: volumes.identity,
    chaptersDirectoryIdentity: chapters.identity,
  });
}

function readActivatedLifecycleProof({
  admission,
  controlStore,
  dataRoot,
  verifyExisting = true,
}) {
  const facts = admission.databaseFacts;
  const routeJournal = facts.routeJournal;
  const creationDirectory = path.join(dataRoot, 'control', 'project-creation', routeJournal);
  let view;
  if (fs.existsSync(creationDirectory)) {
    view = new ProjectCreationJournal({
      childDisposition: evidenceOnlyDisposition(),
      clock: Date.now,
      controlStore: openControlStore(creationDirectory),
      creationId: routeJournal,
      dataRoot,
      databaseDisposition: evidenceOnlyDisposition(),
    }).read();
  } else {
    const disposition = evidenceOnlyDisposition();
    view = new MigrationJournal({
      childDisposition: disposition,
      cleanupDisposition: disposition,
      clock: Date.now,
      controlStore,
      databaseDisposition: disposition,
      projectBinding: Object.freeze({
        controlIncarnationId: controlStore.incarnationId,
        dataRoot,
        projectUid: facts.projectUid,
        projectInstanceId: facts.projectInstanceId,
      }),
      routeDisposition: disposition,
    }).read(routeJournal);
  }
  if (
    view === null
    || view.state !== 'activated'
    || view.projectUid !== facts.projectUid
    || view.projectInstanceId !== facts.projectInstanceId
    || view.lifecycleLockReceipt === null
    || view.lifecyclePlatformIdentity === null
    || view.lifecyclePlatformIdentity
      !== view.lifecycleLockReceipt.lifecyclePlatformIdentity
  ) throw productionError('RECOVERY_REQUIRED', 'Activated route lacks its durable lifecycle proof');
  const receipt = assertManuscriptLifecycleLockReceipt(view.lifecycleLockReceipt);
  if (verifyExisting) {
    const verified = createProductionManuscriptLifecycleLockOwner().verifyExisting(receipt);
    if (verified !== view.lifecyclePlatformIdentity) {
      throw productionError('RECOVERY_REQUIRED', 'Lifecycle proof verification changed identity authority');
    }
  }
  return Object.freeze({
    lifecycleLockReceipt: receipt,
    lifecyclePlatformIdentity: view.lifecyclePlatformIdentity,
  });
}

function createProductionUidCatalog({ dataRoot, databasePort }) {
  const ordinarySources = new Map();
  const uuidPattern = UUID_PATTERN;
  const disposition = evidenceOnlyDisposition();

  function creationJournals() {
    const root = path.join(dataRoot, 'control', 'project-creation');
    const entries = exactDirectoryEntries(root, 'Project creation control root');
    if (entries.some((entry) => !['directory', 'file'].includes(entry.kind))) {
      throw productionError(
        'RECOVERY_REQUIRED',
        'Project creation control root contains a special entry',
      );
    }
    const directoryEntries = entries.filter((entry) => entry.kind === 'directory');
    const fileEntries = entries.filter((entry) => entry.kind === 'file');
    const allowedFiles = new Set();
    const expectedFiles = new Set();
    const records = directoryEntries.map((entry) => {
      if (entry.kind !== 'directory') {
        throw productionError(
          'RECOVERY_REQUIRED',
          'Project creation control root contains a non-directory entry',
        );
      }
      const creationId = entry.name;
      if (!uuidPattern.test(creationId)) {
        throw productionError('RECOVERY_REQUIRED', 'Creation control root has a non-canonical identity');
      }
      const controlIdentity = directoryIdentity(
        entry.path,
        'Project creation instance control root',
      );
      const controlStoreIdentity = process.platform === 'win32'
        ? controlIdentity.canonicalRealPath.toLowerCase()
        : controlIdentity.canonicalRealPath;
      const controlStoreDigest = sha256(controlStoreIdentity);
      const activeName = `.controlstore-${controlStoreDigest}.active.json`;
      const controlLockName = `.controlstore-${controlStoreDigest}.lifecycle.lock`;
      for (const name of [activeName, controlLockName]) {
        allowedFiles.add(name);
      }
      expectedFiles.add(activeName);
      expectedFiles.add(controlLockName);
      const journal = new ProjectCreationJournal({
        childDisposition: disposition,
        clock: Date.now,
        controlStore: openControlStore(entry.path),
        creationId,
        dataRoot,
        databaseDisposition: disposition,
      });
      return Object.freeze({ journal, source: journal.reservationSource() });
    });
    if (
      fileEntries.some((entry) => !allowedFiles.has(entry.name))
      || fileEntries.length !== expectedFiles.size
      || fileEntries.some((entry) => !expectedFiles.has(entry.name))
    ) throw productionError(
      'RECOVERY_REQUIRED',
      'Project creation control root lifecycle lock catalog is inexact',
    );
    return records;
  }

  function creationSources() {
    return creationJournals().map((record) => record.source);
  }

  function assertLifecycleView(view, controlDirectory, expectedLockPath) {
    if (
      view === null
      || view.lifecycleLockReceipt === null
      || view.lifecyclePlatformIdentity === null
      || view.lifecyclePlatformIdentity
        !== view.lifecycleLockReceipt.lifecyclePlatformIdentity
    ) throw productionError('RECOVERY_REQUIRED', 'Control instance lacks one durable lifecycle receipt');
    let receipt;
    try {
      receipt = assertManuscriptLifecycleLockReceipt(view.lifecycleLockReceipt);
    } catch (cause) {
      throw productionError('RECOVERY_REQUIRED', 'Control instance lifecycle receipt is invalid', cause);
    }
    const canonicalControlDirectory = fs.realpathSync.native(controlDirectory);
    if (
      receipt.lifecyclePlatformIdentity.canonicalRealControlDirectory
        !== canonicalControlDirectory
      || deriveManuscriptLifecycleLockPath(canonicalControlDirectory) !== expectedLockPath
    ) throw productionError('RECOVERY_REQUIRED', 'Control instance lifecycle receipt is foreign');
    let lockStats;
    let lockRealPath;
    let parentStats;
    try {
      lockStats = fs.lstatSync(expectedLockPath, { bigint: true });
      lockRealPath = fs.realpathSync.native(expectedLockPath);
      parentStats = fs.lstatSync(path.dirname(controlDirectory), { bigint: true });
    } catch (cause) {
      throw productionError('RECOVERY_REQUIRED', 'Control instance lifecycle lock is unavailable', cause);
    }
    const controlIdentity = directoryIdentity(
      controlDirectory,
      'Manuscript instance control root',
    );
    const expectedResolvedLock = path.resolve(expectedLockPath);
    const sameCanonicalLock = process.platform === 'win32'
      ? lockRealPath.toLowerCase() === expectedResolvedLock.toLowerCase()
      : lockRealPath === expectedResolvedLock;
    if (
      !lockStats.isFile()
      || lockStats.isSymbolicLink()
      || lockStats.size !== 0n
      || lockStats.nlink !== 1n
      || !sameCanonicalLock
      || !samePhysicalIdentity(
        { dev: String(lockStats.dev), ino: String(lockStats.ino) },
        receipt.lifecyclePlatformIdentity.lifecycleLockIdentity,
      )
      || !samePhysicalIdentity(
        controlIdentity.identity,
        receipt.lifecyclePlatformIdentity.controlDirectoryIdentity,
      )
      || !samePhysicalIdentity(
        { dev: String(parentStats.dev), ino: String(parentStats.ino) },
        receipt.lifecyclePlatformIdentity.controlParentDirectoryIdentity,
      )
    ) throw productionError('RECOVERY_REQUIRED', 'Control instance lifecycle identity changed');
  }

  function lifecycleOwnerViews(controlStore, journal, projectUid, projectInstanceId) {
    const migrationIds = new Set(controlStore.read()
      .filter((event) => typeof event?.type === 'string' && event.type.startsWith('migration.'))
      .map((event) => event.payload?.migrationId));
    const views = [];
    for (const migrationId of migrationIds) {
      if (!uuidPattern.test(migrationId)) {
        throw productionError('RECOVERY_REQUIRED', 'Migration control root has a non-canonical journal ID');
      }
      views.push(journal.read(migrationId));
    }
    for (const record of creationJournals()) {
      const view = record.journal.read();
      if (
        view?.projectUid === projectUid
        && view.projectInstanceId === projectInstanceId
      ) views.push(view);
    }
    if (views.length !== 1) {
      throw productionError('RECOVERY_REQUIRED', 'Control instance lacks one exact lifecycle journal owner');
    }
    return views;
  }

  function migrationSources() {
    const root = path.join(dataRoot, 'control', 'manuscripts');
    const sources = [];
    const uidEntries = exactDirectoryEntries(root, 'Manuscript control root');
    for (const uidEntry of uidEntries) {
      if (uidEntry.kind !== 'directory') {
        throw productionError('RECOVERY_REQUIRED', 'Manuscript control root contains a non-directory entry');
      }
      const uid = uidEntry.name;
      if (!uuidPattern.test(uid)) {
        throw productionError('RECOVERY_REQUIRED', 'Manuscript control root has a non-canonical project UID');
      }
      directoryIdentity(uidEntry.path, 'Manuscript project control root');
      const entries = exactDirectoryEntries(uidEntry.path, 'Manuscript project control root');
      const instanceEntries = entries.filter((entry) => entry.kind === 'directory');
      if (entries.some((entry) => !['directory', 'file'].includes(entry.kind))) {
        throw productionError('RECOVERY_REQUIRED', 'Manuscript project control root contains a special entry');
      }
      const expectedLocks = new Map();
      const expectedFiles = new Set();
      for (const instanceEntry of instanceEntries) {
        const instanceId = instanceEntry.name;
        if (!uuidPattern.test(instanceId)) {
          throw productionError('RECOVERY_REQUIRED', 'Manuscript control root has a non-canonical instance ID');
        }
        const controlIdentity = directoryIdentity(
          instanceEntry.path,
          'Manuscript instance control root',
        );
        const lockPath = deriveManuscriptLifecycleLockPath(controlIdentity.canonicalRealPath);
        expectedLocks.set(path.basename(lockPath), Object.freeze({
          controlDirectory: instanceEntry.path,
          instanceId,
          lockPath,
        }));
        expectedFiles.add(path.basename(lockPath));
        const controlStoreIdentity = process.platform === 'win32'
          ? controlIdentity.canonicalRealPath.toLowerCase()
          : controlIdentity.canonicalRealPath;
        const controlStoreDigest = sha256(controlStoreIdentity);
        expectedFiles.add(`.controlstore-${controlStoreDigest}.active.json`);
        expectedFiles.add(`.controlstore-${controlStoreDigest}.lifecycle.lock`);
      }
      const fileEntries = entries.filter((entry) => entry.kind === 'file');
      if (
        fileEntries.length !== expectedFiles.size
        || fileEntries.some((entry) => !expectedFiles.has(entry.name))
      ) throw productionError(
        'RECOVERY_REQUIRED',
        'Manuscript project control root lifecycle lock catalog is inexact',
      );
      for (const expected of expectedLocks.values()) {
        const { controlDirectory, instanceId, lockPath } = expected;
        const controlStore = openControlStore(controlDirectory);
        const journal = new MigrationJournal({
          childDisposition: disposition,
          cleanupDisposition: disposition,
          clock: Date.now,
          controlStore,
          databaseDisposition: disposition,
          projectBinding: Object.freeze({
            controlIncarnationId: controlStore.incarnationId,
            dataRoot,
            projectUid: uid,
            projectInstanceId: instanceId,
          }),
          routeDisposition: disposition,
        });
        const views = lifecycleOwnerViews(controlStore, journal, uid, instanceId);
        assertLifecycleView(views[0], controlDirectory, lockPath);
        sources.push(journal.reservationSource());
      }
    }
    return sources;
  }

  const registrySource = Object.freeze({
    enumerate(scope) { return databasePort.enumerateUidRecords(scope); },
  });
  const existingRootsSource = Object.freeze({
    async enumerate(scope) {
      const registered = scope.objectKind === 'project'
        ? new Set((await registrySource.enumerate(scope)).records.map((record) => record.uid))
        : new Set();
      if (scope.objectKind === 'project') {
        for (const source of [...migrationSources(), ...creationSources()]) {
          for (const record of (await source.enumerate(scope)).records) registered.add(record.uid);
        }
      }
      const records = scope.objectKind === 'project'
        ? exactDirectoryEntries(
          path.join(dataRoot, 'manuscripts'),
          'Manuscript article root catalog',
        ).map((entry) => {
          if (entry.kind !== 'directory') {
            throw productionError(
              'RECOVERY_REQUIRED',
              'Manuscript article root catalog contains a non-directory entry',
            );
          }
          const uid = entry.name;
          if (!uuidPattern.test(uid)) {
            throw productionError('RECOVERY_REQUIRED', 'Manuscript root has a non-canonical project UID');
          }
          directoryIdentity(entry.path, 'Manuscript article project root');
          if (registered.has(uid)) return null;
          return Object.freeze({
            ownerKind: 'existing_root',
            ownerId: entry.path,
            reservationId: sha256(`existing-root:${uid}`),
            uid,
          });
        }).filter((record) => record !== null)
        : [];
      return Object.freeze({ ...scope, complete: true, records: Object.freeze(records) });
    },
  });
  const migrationAggregate = Object.freeze({
    async enumerate(scope) {
      const records = [];
      for (const source of migrationSources()) {
        records.push(...(await source.enumerate(scope)).records);
      }
      if (scope.objectKind !== 'project') {
        for (const source of ordinarySources.get(scope.projectUid) ?? []) {
          records.push(...(await source.enumerate(scope)).records);
        }
      }
      return Object.freeze({ ...scope, complete: true, records: Object.freeze(records) });
    },
  });
  const creationAggregate = Object.freeze({
    async enumerate(scope) {
      const records = [];
      for (const source of creationSources()) {
        records.push(...(await source.enumerate(scope)).records);
      }
      return Object.freeze({ ...scope, complete: true, records: Object.freeze(records) });
    },
    async lookup(input) {
      const reservations = [];
      for (const source of creationSources()) {
        reservations.push(...(await source.lookup(input)).reservations);
      }
      return Object.freeze({
        complete: true,
        logicalRequestId: input.logicalRequestId,
        reservations: Object.freeze(reservations),
      });
    },
  });
  const reservationSources = createUidReservationSources({
    registrySource,
    existingRootsSource,
    migrationSources: Object.freeze([migrationAggregate]),
    creationSources: Object.freeze([creationAggregate]),
  });
  return Object.freeze({
    reservationSources,
    registerOrdinary(projectUid, source) {
      const sources = ordinarySources.get(projectUid) ?? new Set();
      sources.add(source);
      ordinarySources.set(projectUid, sources);
    },
  });
}

function createFilesBackend({ databasePort, dataRoot, fileBoundary, uidCatalog }) {
  const entries = new Map();
  const requestSnapshots = new WeakMap();
  const chapterDataVersions = new WeakMap();
  const orphanPolicyInputs = new WeakSet();
  const revisionCommandsByIntent = new WeakMap();
  const revisionResolutionPolicyInputs = new WeakMap();
  const draftConflictCommandsByPolicyInput = new WeakMap();
  let closed = false;
  let closePromise = null;

  function assertOpen() {
    if (closed) throw productionError('RECOVERY_REQUIRED', 'Production files backend is closed');
  }

  function projectUid(admission) {
    return admission.databaseFacts.projectUid;
  }

  function assertRevisionWriterTurn(entry) {
    if (entry.state.activeTurn === null) {
      throw productionError(
        'RECOVERY_REQUIRED',
        'Revision resolution is outside its database writer turn',
      );
    }
    databasePort.assertWriterTurn(entry.admission, entry.state.activeTurn);
  }

  function acceptedRevisionResult(row, content, generation, resolvedAt) {
    const revision = serializeRevisionSnapshot(row, row.chapter_uid);
    return Object.freeze({
      disposition: 'after',
      generation,
      state: 'accepted',
      revision: Object.freeze({
        ...revision,
        status: 'accepted',
        updatedAt: resolvedAt,
        resolvedAt,
      }),
      chapter: Object.freeze({
        id: row.chapter_id,
        chapterUid: row.chapter_uid,
        content,
        wordCount: content.replace(/\s/gu, '').length,
        status: 'accepted',
        dataVersion: Number.isSafeInteger(row.data_version) ? row.data_version : 0,
      }),
    });
  }

  function readCommittedRevisionResolution(entry, command, logicalRequestId) {
    assertRevisionWriterTurn(entry);
    const receiptValue = databasePort.read(entry.admission, (database) => (
      database.prepare('SELECT value FROM project_meta WHERE key = ?').get(
        revisionRequestKey(logicalRequestId),
      )?.value ?? null
    ));
    if (receiptValue === null) return null;
    const row = databasePort.read(entry.admission, (database) => database.prepare(`
      SELECT r.id, r.chapter_id, r.base_content, r.proposed_content,
             r.decisions_json, r.status, r.previous_chapter_status,
             r.created_at, r.updated_at, r.resolved_at,
             c.chapter_uid, c.content AS chapter_content,
             c.word_count, c.status AS chapter_status, c.data_version,
             c.body_raw_sha256
      FROM chapter_revisions AS r
      JOIN chapters AS c ON c.id = r.chapter_id
      WHERE r.id = ?
    `).get(command.revisionId) ?? null);
    if (row === null) throw productionError(
      'RECOVERY_REQUIRED',
      'Committed revision resolution lost its revision row',
    );
    let resolution;
    try {
      resolution = parseRevisionResolutionReceipt(receiptValue);
    } catch (cause) {
      if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
      throw productionError(
        'RECOVERY_REQUIRED',
        'Revision logical request is bound to another durable action',
        cause,
      );
    }
    const decisions = revisionDecisionSnapshot(row.decisions_json);
    const acceptedContent = row.chapter_content ?? '';
    if (
      resolution.logicalRequestId !== logicalRequestId
      || resolution.commandKind !== command.kind
      || resolution.commandDigest !== sha256(stableJson(command))
      || resolution.revisionId !== command.revisionId
      || resolution.revisionId !== row.id
      || resolution.chapterId !== row.chapter_id
      || resolution.chapterUid !== row.chapter_uid
      || row.status !== 'accepted'
      || resolution.baseContentSha256 !== sha256(row.base_content)
      || resolution.proposedContentSha256 !== sha256(row.proposed_content)
      || resolution.acceptedContentSha256 !== sha256(acceptedContent)
      || resolution.decisionsSha256 !== sha256(stableJson(decisions))
      || resolution.baseContentSha256 !== sha256(command.expectedBaseContent)
      || (command.kind === 'revision.accept'
        ? resolution.acceptedContentSha256 !== resolution.proposedContentSha256
        : (
          resolution.acceptedContentSha256 !== sha256(command.content)
          || resolution.decisionsSha256 !== sha256(stableJson(command.expectedDecisions))
        ))
    ) throw productionError(
      'RECOVERY_REQUIRED',
      'Revision resolution logical request was rebound',
    );
    const generationRow = databasePort.read(entry.admission, (database) => database.prepare(
      "SELECT value FROM project_meta WHERE key = 'manuscript_projection_generation'",
    ).get());
    const generation = Number(generationRow?.value);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw productionError('RECOVERY_REQUIRED', 'Committed revision generation is invalid');
    }
    return acceptedRevisionResult(row, acceptedContent, generation, row.resolved_at);
  }

  async function publishRevisionResolution(entry, l2, command, turnContext) {
    assertRevisionWriterTurn(entry);
    const committed = readCommittedRevisionResolution(
      entry,
      command,
      turnContext.logicalRequestId,
    );
    if (committed !== null) return committed;
    const row = databasePort.read(entry.admission, (database) => database.prepare(`
      SELECT r.id, r.chapter_id, r.base_content, r.proposed_content,
             r.decisions_json, r.status, r.previous_chapter_status,
             r.created_at, r.updated_at, r.resolved_at,
             c.chapter_uid, c.content AS chapter_content,
             c.word_count, c.status AS chapter_status, c.data_version,
             c.body_raw_sha256
      FROM chapter_revisions AS r
      JOIN chapters AS c ON c.id = r.chapter_id
      WHERE r.id = ?
    `).get(command.revisionId) ?? null);
    const generation = turnContext.currentProjection.basis.baseGeneration;
    if (row === null) return Object.freeze({
      disposition: 'before', generation, state: 'conflict', reason: 'revision_missing',
    });
    const revision = serializeRevisionSnapshot(row, row.chapter_uid);
    const decisions = revisionDecisionSnapshot(row.decisions_json);
    const basisChapter = turnContext.currentProjection.basis.chapters.find((chapter) => (
      chapter.id === row.chapter_id
      && chapter.uid === row.chapter_uid
      && chapter.isPresent === 1
    ));
    if (
      basisChapter === undefined
      || basisChapter.bodyRawSha256 !== row.body_raw_sha256
      || basisChapter.bodyRawSha256 !== sha256(row.chapter_content ?? '')
      || basisChapter.status !== row.chapter_status
    ) throw productionError(
      'RECOVERY_REQUIRED',
      'Revision resolution chapter differs from the admitted exact projection',
    );
    const finalizeNoop = command.kind === 'revision.finalize'
      && command.expectedBaseContent === row.base_content
      && stableJson(command.expectedDecisions) === stableJson(decisions)
      && command.content === (row.chapter_content ?? '')
      && command.content === row.base_content
      && row.chapter_status === 'accepted'
      && basisChapter.status === 'accepted'
      && basisChapter.bodyRawSha256 === sha256(command.content);
    if (finalizeNoop) {
      return databasePort.applyAuxiliaryAction(entry.admission, Object.freeze({
        action: Object.freeze({
          kind: 'revision.finalize_noop',
          revisionId: row.id,
          content: command.content,
          expectedBaseContent: command.expectedBaseContent,
          expectedDecisions: decisions,
        }),
        currentProjection: turnContext.currentProjection,
        logicalRequestId: turnContext.logicalRequestId,
        projectedAt: turnContext.projectedAt,
      }));
    }
    if (row.status === 'stale') {
      return databasePort.applyAuxiliaryAction(entry.admission, Object.freeze({
        action: Object.freeze({ kind: 'revision.mark_stale', revisionId: row.id }),
        currentProjection: turnContext.currentProjection,
        logicalRequestId: turnContext.logicalRequestId,
        projectedAt: turnContext.projectedAt,
      }));
    }
    if (row.status !== 'pending') return Object.freeze({
      disposition: 'before',
      generation,
      state: 'conflict',
      reason: `revision_${row.status}`,
      revision,
    });
    if (!turnContext.currentProjection.basis.pendingProposals.some((proposal) => (
      proposal.revisionId === row.id && proposal.chapterId === row.chapter_id
    ))) throw productionError(
      'RECOVERY_REQUIRED',
      'Revision resolution is absent from the admitted exact projection',
    );
    if (row.base_content !== (row.chapter_content ?? '')) {
      return databasePort.applyAuxiliaryAction(entry.admission, Object.freeze({
        action: Object.freeze({ kind: 'revision.mark_stale', revisionId: row.id }),
        currentProjection: turnContext.currentProjection,
        logicalRequestId: turnContext.logicalRequestId,
        projectedAt: turnContext.projectedAt,
      }));
    }
    if (command.expectedBaseContent !== row.base_content) return Object.freeze({
      disposition: 'before',
      generation,
      state: 'conflict',
      reason: 'expected_base_mismatch',
      revision,
    });
    if (
      command.kind === 'revision.finalize'
      && stableJson(command.expectedDecisions) !== stableJson(decisions)
    ) return Object.freeze({
      disposition: 'before',
      generation,
      state: 'conflict',
      reason: 'expected_decisions_mismatch',
      revision,
    });
    const content = command.kind === 'revision.accept'
      ? row.proposed_content
      : command.content;
    const revisionResolution = Object.freeze({
      revisionId: row.id,
      chapterId: row.chapter_id,
      chapterUid: row.chapter_uid,
      from: 'pending',
      to: 'accepted',
      baseContentSha256: sha256(row.base_content),
      proposedContentSha256: sha256(row.proposed_content),
      acceptedContentSha256: sha256(content),
      decisionsSha256: sha256(stableJson(decisions)),
      logicalRequestId: turnContext.logicalRequestId,
      commandKind: command.kind,
      commandDigest: sha256(stableJson(command)),
    });
    await l2.executeRevisionResolution(Object.freeze({
      command: Object.freeze({
        kind: 'chapter.replace_body_and_sidecar',
        bodyRef: bodyRef(projectUid(entry.admission), row.chapter_uid),
        sidecarRef: sidecarRef(projectUid(entry.admission), row.chapter_uid),
        content,
        patch: Object.freeze({ status: 'accepted' }),
      }),
      revisionResolution,
    }), turnContext);
    const published = readCommittedRevisionResolution(
      entry,
      command,
      turnContext.logicalRequestId,
    );
    if (published === null) {
      throw productionError(
        'RECOVERY_REQUIRED',
        'Revision resolution committed without its durable request receipt',
      );
    }
    return published;
  }

  function resources(entry) {
    const value = entry.state.resources;
    if (value === null) {
      throw productionError(
        'RECOVERY_REQUIRED',
        'Production files authority is unavailable before session admission',
      );
    }
    return value;
  }

  function bootstrapEntry(entry) {
    if (entry.state.resources !== null) return entry.state.resources;
    const uid = projectUid(entry.admission);
    const instanceId = entry.admission.databaseFacts.projectInstanceId;
    const controlDirectory = entry.state.controlDirectory;
    const controlStore = entry.state.controlStore ?? openControlStore(controlDirectory);
    entry.state.controlStore = controlStore;
    const roots = openActivatedProjectRoot({ dataRoot, projectUid: uid });
    const recoveryStats = fs.lstatSync(path.join(controlDirectory, 'file-assets'), { bigint: true });
    const projectBinding = Object.freeze({
      articleRootIdentity: roots.projectBinding.articleRootIdentity,
      controlIncarnationId: controlStore.incarnationId,
      dataRoot,
      projectUid: uid,
      projectInstanceId: instanceId,
      recoveryRootIdentity: Object.freeze({
        dev: String(recoveryStats.dev),
        ino: String(recoveryStats.ino),
      }),
    });
    const projectionStore = new SQLiteProjectionStore();
    const databaseProjectStore = databasePort.projectStore(entry.admission);
    const projectStore = Object.freeze({
      readAll(sql, ...params) {
        return databasePort.read(
          entry.admission,
          (database) => database.prepare(sql).all(...params),
        );
      },
      inspectProjectionTarget(input) {
        return databasePort.inspectProjectionTarget(entry.admission, input);
      },
      publishProjectionTarget(input) {
        return databaseProjectStore.publishProjectionTarget(input);
      },
    });
    const fileJournal = new FilePublicationJournal({
      controlStore,
      filePublisher: new FilePublisher({ writerCapability: fileBoundary.writerCapability }),
      projectionStore,
      projectStore,
      projectionDisposition: Object.freeze({
        inspectTarget(input) {
          return databasePort.inspectProjectionTarget(
            entry.admission,
            { target: input.target },
          );
        },
      }),
      parentAuthority: denyParentAuthority(),
      projectBinding,
      assertWriteAuthority() {
        if (entry.state.activeTurn === null) {
          throw productionError(
            'RECOVERY_REQUIRED',
            'File publication is outside its database writer turn',
          );
        }
        databasePort.assertWriterTurn(entry.admission, entry.state.activeTurn);
      },
    });
    const draftConflictStorage = createProductionDraftConflictStorage({
      controlDirectory,
      projectUid: uid,
      projectInstanceId: instanceId,
    });
    const childEvidence = new WeakMap();
    const projectionEvidence = new WeakMap();
    function mintEvidence(records, descriptor, disposition) {
      const evidence = Object.freeze({});
      records.set(evidence, Object.freeze({
        conflictId: descriptor.conflictId,
        decisionEpoch: descriptor.decisionEpoch,
        descriptorDigest: sha256(stableJson(descriptor)),
        disposition,
      }));
      return evidence;
    }
    function classifyEvidence(records, evidence, descriptor) {
      const observed = records.get(evidence);
      if (
        observed === undefined
        || observed.conflictId !== descriptor.conflictId
        || observed.decisionEpoch !== descriptor.decisionEpoch
        || observed.descriptorDigest !== sha256(stableJson(descriptor))
      ) return 'unknown';
      return observed.disposition;
    }
    async function inspectProjectionDisposition(descriptor) {
      const writerTurn = entry.state.activeTurn;
      const snapshot = writerTurn === null
        ? undefined
        : entry.state.turnSnapshots.get(writerTurn);
      if (snapshot === undefined) {
        return mintEvidence(projectionEvidence, descriptor, 'unknown');
      }
      let disposition = 'unknown';
      try {
        const draftBytes = await draftConflictStorage.readDraftCopy(descriptor.conflictId);
        const command = decodeDraftConflictCommand(draftBytes, uid);
        const currentWitness = witnessFor(snapshot, witnessRequestForResolvedCommand(command));
        const encoded = encodeDraftConflictBackup(command, currentWitness, uid);
        const expectedExternal = descriptor.acceptedRawSha256 ?? descriptor.externalRawSha256;
        if (sha256(encoded.externalBytes) === expectedExternal) {
          const generation = snapshot.currentProjection.basis.baseGeneration;
          if (generation === descriptor.baseGeneration) disposition = 'before';
          if (generation === descriptor.targetGeneration) disposition = 'after';
        }
      } catch {
        disposition = 'unknown';
      }
      return mintEvidence(projectionEvidence, descriptor, disposition);
    }
    const childDisposition = Object.freeze({
      classify(evidence, _intent, descriptor) {
        return classifyEvidence(childEvidence, evidence, descriptor);
      },
      async inspect(_intent, descriptor) {
        const observed = fileJournal.inspectDisposition(Object.freeze({
          journalId: descriptor.childJournalId,
          parent: Object.freeze({ kind: 'draft_conflict', journalId: descriptor.conflictId }),
        }));
        return mintEvidence(childEvidence, descriptor, observed.disposition);
      },
    });
    const projectionDisposition = Object.freeze({
      classify(evidence, _intent, descriptor) {
        return classifyEvidence(projectionEvidence, evidence, descriptor);
      },
      inspect(_intent, descriptor) {
        return inspectProjectionDisposition(descriptor);
      },
    });
    const draftConflictJournal = new DraftConflictJournal({
      backupStorage: draftConflictStorage.journalStorage(),
      childDisposition,
      clock: Date.now,
      controlStore,
      projectBinding: Object.freeze({
        controlIncarnationId: controlStore.incarnationId,
        dataRoot,
        projectInstanceId: instanceId,
        projectUid: uid,
      }),
      projectionDisposition,
      uuidV4: randomUUID,
    });
    const draftReader = draftConflictStorage.bindDraftReader(
      entry.draftConflictJournalIntentAuthority,
    );
    const resolutionPipeline = Object.freeze({
      async acceptExternal(journalIntent, context) {
        const descriptor = entry.draftConflictJournalIntentAuthority.describe(journalIntent);
        const writerTurn = entry.state.activeTurn;
        const snapshot = writerTurn === null
          ? undefined
          : entry.state.turnSnapshots.get(writerTurn);
        if (
          snapshot === undefined
          || snapshot.fileSnapshot !== context.fileSnapshot
          || snapshot.currentProjection.basis.baseGeneration !== descriptor.baseGeneration
          || descriptor.targetGeneration !== descriptor.baseGeneration + 1
        ) throw productionError('RECOVERY_REQUIRED', 'Accept-external lost its admitted conflict basis');
        const beforeEvidence = await inspectProjectionDisposition(descriptor);
        if (projectionDisposition.classify(beforeEvidence, journalIntent, descriptor) !== 'before') {
          throw productionError('RECOVERY_REQUIRED', 'Accept-external projection is not before');
        }
        const target = resources(entry).projectionStore.buildTarget(Object.freeze({
          currentProjection: snapshot.currentProjection,
          candidate: snapshot.candidate,
          targetGeneration: descriptor.targetGeneration,
          projectedAt: context.projectedAt,
          ignoredLedger: snapshot.ignoredLedger,
          localIdentityPlan: canonicalSchema12ReuseIdentityPlan(snapshot.currentProjection),
        }));
        const published = resources(entry).databaseProjectStore.publishProjectionTarget({ target });
        if (
          published?.disposition !== 'after'
          || published.generation !== descriptor.targetGeneration
        ) throw productionError('RECOVERY_REQUIRED', 'Accept-external projection did not commit');
        return mintEvidence(projectionEvidence, descriptor, 'after');
      },
      async applySavedDraft(journalIntent, context) {
        const descriptor = entry.draftConflictJournalIntentAuthority.describe(journalIntent);
        const draftBytes = await draftReader.readDraft(journalIntent);
        const command = decodeDraftConflictCommand(draftBytes, uid);
        const writeIntent = entry.l2.bindWriteIntent(command);
        await entry.l2.executeDraftConflict(writeIntent, context, journalIntent);
        const evidence = await childDisposition.inspect(journalIntent, descriptor);
        if (childDisposition.classify(evidence, journalIntent, descriptor) !== 'after') {
          throw productionError('RECOVERY_REQUIRED', 'Saved draft child publication is not after');
        }
        return evidence;
      },
      intentAuthority() {
        return entry.draftConflictJournalIntentAuthority;
      },
    });
    const draftConflictService = new DraftConflictService({
      contextAuthority: entry.draftConflictContexts.authority,
      intentAuthority: entry.draftConflictIntents.authority,
      journal: entry.draftConflictJournal,
      resolutionPipeline,
    });
    const manuscriptStore = new ManuscriptStore({
      dataRoot,
      fileBoundary: fileBoundary.readCapability,
      journalAuthority: fileJournal.journalAuthority(),
      installedOrphanBaselineAuthority: projectionStore.installedOrphanBaselineAuthority(),
    });
    uidCatalog.registerOrdinary(uid, fileJournal.reservationSource());
    const uidReservation = new ManuscriptUidReservation({
      reservationSources: uidCatalog.reservationSources,
      uuidV4: randomUUID,
    });
    const installed = Object.freeze({
      controlStore,
      databaseProjectStore,
      draftConflictJournal,
      draftConflictService,
      draftConflictStorage,
      fileJournal,
      manuscriptStore,
      projectStore,
      projectionStore,
      roots,
      uidReservation,
    });
    entry.state.resources = installed;
    return installed;
  }

  function entryFor(admission) {
    assertOpen();
    const uid = projectUid(admission);
    const existing = entries.get(uid);
    if (existing !== undefined) {
      if (
        existing.admission.databaseFacts.projectInstanceId
          !== admission.databaseFacts.projectInstanceId
        || existing.admission.databaseFacts.routeJournal
          !== admission.databaseFacts.routeJournal
      ) throw productionError('RECOVERY_REQUIRED', 'Project UID changed its active instance');
      return existing;
    }
    const instanceId = admission.databaseFacts.projectInstanceId;
    const controlDirectory = path.join(dataRoot, 'control', 'manuscripts', uid, instanceId);
    const state = {
      activeTurn: null,
      admissionSnapshots: new WeakMap(),
      connectionEpoch: entries.size + 1,
      controlDirectory,
      controlStore: null,
      knownFreshnessAdmissions: new WeakSet(),
      lastSnapshot: null,
      ordinaryRecoveryTurns: new WeakSet(),
      resources: null,
      sessionOpening: null,
      turnAdmissions: new WeakMap(),
      turnSnapshots: new WeakMap(),
      uidPathProbe: null,
    };
    let entry = null;
    const draftConflictIntents = createOpaqueDescriptorBroker('draft conflict service intent');
    const draftConflictContexts = createOpaqueDescriptorBroker('draft conflict turn context');
    const draftConflictJournalIntentAuthority = Object.freeze({
      assert(intent) {
        return resources(entry).draftConflictJournal.intentAuthority().assert(intent);
      },
      describe(intent) {
        return resources(entry).draftConflictJournal.intentAuthority().describe(intent);
      },
    });
    const draftConflictJournal = Object.freeze({
      archive(...args) { return resources(entry).draftConflictJournal.archive(...args); },
      beginAccept(...args) { return resources(entry).draftConflictJournal.beginAccept(...args); },
      beginApply(...args) { return resources(entry).draftConflictJournal.beginApply(...args); },
      createConflict(...args) { return resources(entry).draftConflictJournal.createConflict(...args); },
      intentAuthority() { return draftConflictJournalIntentAuthority; },
      listConflicts(...args) { return resources(entry).draftConflictJournal.listConflicts(...args); },
      readConflict(...args) { return resources(entry).draftConflictJournal.readConflict(...args); },
      recordAcceptResolved(...args) {
        return resources(entry).draftConflictJournal.recordAcceptResolved(...args);
      },
      recordApplyResolved(...args) {
        return resources(entry).draftConflictJournal.recordApplyResolved(...args);
      },
    });
    const databaseProjectStore = Object.freeze({
      publishProjectionTarget(input) {
        return resources(entry).databaseProjectStore.publishProjectionTarget(input);
      },
    });
    const projectStore = Object.freeze({
      readAll(sql, ...params) {
        return resources(entry).projectStore.readAll(sql, ...params);
      },
      inspectProjectionTarget(input) {
        return resources(entry).projectStore.inspectProjectionTarget(input);
      },
      publishProjectionTarget(input) {
        return resources(entry).projectStore.publishProjectionTarget(input);
      },
    });
    const fileJournal = Object.freeze({
      lookupOrdinaryRequest(...args) {
        return resources(entry).fileJournal.lookupOrdinaryRequest(...args);
      },
      readReservation(...args) { return resources(entry).fileJournal.readReservation(...args); },
      assertReservation(...args) { return resources(entry).fileJournal.assertReservation(...args); },
      stageAssets(...args) { return resources(entry).fileJournal.stageAssets(...args); },
      bindTarget(...args) { return resources(entry).fileJournal.bindTarget(...args); },
      prepare(...args) { return resources(entry).fileJournal.prepare(...args); },
      publishFiles(...args) { return resources(entry).fileJournal.publishFiles(...args); },
      commitProjection(...args) {
        return resources(entry).fileJournal.commitProjection(...args);
      },
      complete(...args) { return resources(entry).fileJournal.complete(...args); },
      recover(...args) { return resources(entry).fileJournal.recover(...args); },
      recoverPendingOrdinary(...args) {
        return resources(entry).fileJournal.recoverPendingOrdinary(...args);
      },
      inspectDisposition(...args) {
        return resources(entry).fileJournal.inspectDisposition(...args);
      },
    });
    const manuscriptStore = Object.freeze({
      buildClosure(...args) { return resources(entry).manuscriptStore.buildClosure(...args); },
      finalizeCandidate(...args) {
        return resources(entry).manuscriptStore.finalizeCandidate(...args);
      },
      createUidPathProbe(...args) {
        return resources(entry).manuscriptStore.createUidPathProbe(...args);
      },
      captureOrphanBaseline(...args) {
        return resources(entry).manuscriptStore.captureOrphanBaseline(...args);
      },
      preflightOrphanResolution(...args) {
        return resources(entry).manuscriptStore.preflightOrphanResolution(...args);
      },
      describeOrphanResolution(...args) {
        return resources(entry).manuscriptStore.describeOrphanResolution(...args);
      },
      validateFull(...args) { return resources(entry).manuscriptStore.validateFull(...args); },
      buildProjectionCandidate(...args) {
        return resources(entry).manuscriptStore.buildProjectionCandidate(...args);
      },
    });
    const projectionStore = Object.freeze({
      buildTarget(...args) { return resources(entry).projectionStore.buildTarget(...args); },
      buildRevisionTarget(...args) {
        return resources(entry).projectionStore.buildRevisionTarget(...args);
      },
      buildResolutionTarget(...args) {
        return resources(entry).projectionStore.buildResolutionTarget(...args);
      },
      publishResolution(...args) {
        return resources(entry).projectionStore.publishResolution(...args);
      },
      verifyResolutionNoop(...args) {
        return resources(entry).projectionStore.verifyResolutionNoop(...args);
      },
    });
    const uidReservation = Object.freeze({
      reserveNewIdentity(...args) {
        return resources(entry).uidReservation.reserveNewIdentity(...args);
      },
      assertReservation(...args) {
        return resources(entry).uidReservation.assertReservation(...args);
      },
    });
    const l2 = createL2ManuscriptService({
      manuscriptStore,
      fileJournal,
      projectionStore,
      uidReservation,
      draftConflictIntentAuthority: draftConflictJournalIntentAuthority,
      uidPathProbe: Object.freeze({
        async probe(input) {
          if (state.uidPathProbe === null) {
            throw productionError('RECOVERY_REQUIRED', 'UID path probe is outside one admitted full snapshot');
          }
          return state.uidPathProbe.probe(input);
        },
      }),
    });
    const revisionService = createRevisionService({
      auxiliaryStore: Object.freeze({
        apply(input) {
          if (entry.state.activeTurn === null) {
            throw productionError(
              'RECOVERY_REQUIRED',
              'Auxiliary revision action is outside its database writer turn',
            );
          }
          databasePort.assertWriterTurn(entry.admission, entry.state.activeTurn);
          return databasePort.applyAuxiliaryAction(entry.admission, input);
        },
      }),
      resolutionPublisher: Object.freeze({
        async publish(command, turnContext) {
          return publishRevisionResolution(entry, l2, command, turnContext);
        },
      }),
    });
    const orphanResolutionOwner = new OrphanResolutionService({
      manuscriptStore,
      projectionStore,
      projectStore,
    });
    const orphanResolutionService = Object.freeze({
      snapshotRequest(request) {
        return orphanResolutionOwner.snapshotRequest(request);
      },
      preflightResolution(action, request, baseline) {
        return orphanResolutionOwner.preflightResolution(action, request, baseline);
      },
      publishResolution(prepared, projectionContext) {
        return orphanResolutionOwner.publishResolution(prepared, projectionContext);
      },
    });
    const productWriteIntentOwner = createManuscriptService(
      Object.freeze({}),
      Object.freeze({ l2Service: l2, orphanResolutionService, revisionService }),
    );
    const productWriteIntents = Object.freeze({
      bindL2Command(command) {
        return productWriteIntentOwner.bindProductL2Command(command);
      },
      bindOrphanAction(action, request) {
        return productWriteIntentOwner.bindProductOrphanAction(action, request);
      },
      bindRevisionCommand(command) {
        return productWriteIntentOwner.bindProductRevisionCommand(command);
      },
      authority() {
        return productWriteIntentOwner.productWriteIntentAuthority();
      },
      execute(intent, turnContext) {
        return productWriteIntentOwner.executeProductWriteIntent(intent, turnContext);
      },
    });
    entry = {
      admission,
      databaseProjectStore,
      draftConflictContexts,
      draftConflictIntents,
      draftConflictJournal,
      draftConflictJournalIntentAuthority,
      fileJournal,
      freshnessLifecycle: null,
      l2,
      manuscriptStore,
      productGates: null,
      productWriteIntents,
      sessionController: null,
      state,
    };
    const projectName = uid;
    const projectSelector = Object.freeze({ name: projectName, expectedInstanceId: instanceId });
    const assertFreshnessTurn = (freshnessAdmission, writerTurn) => {
      databasePort.assertWriterTurn(entry.admission, writerTurn);
      if (entry.state.turnAdmissions.get(writerTurn) !== freshnessAdmission) {
        throw productionError('RECOVERY_REQUIRED', 'Freshness admission does not own the writer turn');
      }
      return true;
    };
    const lifecycleWriterTurns = Object.freeze({
      async withWriterTurn(freshnessAdmission, operation) {
        return databasePort.withWriterTurn(entry.admission, async (writerTurn) => {
          entry.state.activeTurn = writerTurn;
          entry.state.knownFreshnessAdmissions.add(freshnessAdmission);
          entry.state.turnAdmissions.set(writerTurn, freshnessAdmission);
          try {
            return await operation(writerTurn);
          } finally {
            entry.state.uidPathProbe = null;
            entry.state.activeTurn = null;
          }
        });
      },
      assertTurn: assertFreshnessTurn,
    });
    entry.writerTurns = lifecycleWriterTurns;
    const freshnessLifecycle = createManuscriptFreshnessLifecycle({
      preStartVerifier: Object.freeze({
        verifyBeforeFeedStart(exactIdentity) {
          const installed = bootstrapEntry(entry);
          const proof = readActivatedLifecycleProof({
            admission,
            controlStore: installed.controlStore,
            dataRoot,
            verifyExisting: false,
          });
          if (
            exactIdentity.projectUid !== uid
            || exactIdentity.projectInstanceId !== instanceId
            || !sameLifecyclePlatformIdentity(
              exactIdentity.lifecyclePlatformIdentity,
              proof.lifecyclePlatformIdentity,
            )
          ) throw productionError('RECOVERY_REQUIRED', 'Freshness startup identity changed');
          return Object.freeze({
            changeFeedPlatformIdentity: captureChangeFeedPlatformIdentity(installed.roots),
          });
        },
      }),
      feedAdapter: createWindowsManuscriptChangeFeedAdapter(),
      notificationCapability: Object.freeze({ read() { return false; } }),
      writerTurns: lifecycleWriterTurns,
      recovery: Object.freeze({
        async recoverBeforeRefresh(freshnessAdmission, writerTurn) {
          assertFreshnessTurn(freshnessAdmission, writerTurn);
          if (!entry.state.ordinaryRecoveryTurns.has(writerTurn)) {
            await fileJournal.recoverPendingOrdinary();
          }
          return databasePort.recover(entry.admission);
        },
      }),
      fullRefresh: Object.freeze({
        validateAndPublish(input) {
          return validateAndPublishFull(entry, input);
        },
      }),
      projectionAccess: Object.freeze({
        readCurrent(freshnessAdmission, query) {
          if (!entry.state.knownFreshnessAdmissions.has(freshnessAdmission)) {
            throw productionError('RECOVERY_REQUIRED', 'Readable admission has no FULL proof');
          }
          const snapshot = entry.state.admissionSnapshots.get(freshnessAdmission);
          if (snapshot === undefined) {
            throw productionError('RECOVERY_REQUIRED', 'Readable admission has no installed snapshot');
          }
          requestSnapshots.set(query, snapshot);
          return Object.freeze({
            token: snapshot.token,
            value: readSnapshotValue(snapshot, query),
          });
        },
        currentToken(freshnessAdmission) {
          if (!entry.state.knownFreshnessAdmissions.has(freshnessAdmission)) {
            throw productionError('RECOVERY_REQUIRED', 'Projection token admission is unknown');
          }
          return currentProjectionToken(entry);
        },
      }),
    });
    entry.freshnessLifecycle = freshnessLifecycle;
    entry.sessionController = new ManuscriptSessionController({
      freshnessLifecycle,
      lifecycleLeaseAdapter: createWindowsManuscriptLifecycleLeaseAdapter(),
      registryAdmission: Object.freeze({
        async withProjectIdentity(selector, operation) {
          const admitted = await databasePort.admit({ projectUid: uid });
          if (
            selector.name !== projectName
            || selector.expectedInstanceId !== instanceId
            || admitted.route !== 'files'
            || admitted.databaseFacts.projectUid !== uid
            || admitted.databaseFacts.projectInstanceId !== instanceId
            || admitted.databaseFacts.routeJournal !== admission.databaseFacts.routeJournal
          ) throw productionError('RECOVERY_REQUIRED', 'Registry admission changed its project binding');
          const controlStore = openControlStore(controlDirectory);
          entry.state.controlStore = controlStore;
          const proof = readActivatedLifecycleProof({ admission: admitted, controlStore, dataRoot });
          const identity = Object.freeze({
            projectUid: uid,
            projectInstanceId: instanceId,
            lifecyclePlatformIdentity: proof.lifecyclePlatformIdentity,
          });
          return operation(identity);
        },
      }),
      routeAdmissionVerifier: Object.freeze({
        async verifyAfterLease(exactIdentity) {
          const admitted = await databasePort.admit({ projectUid: uid });
          const proof = readActivatedLifecycleProof({
            admission: admitted,
            controlStore: entry.state.controlStore,
            dataRoot,
            verifyExisting: false,
          });
          if (
            admitted.route !== 'files'
            || admitted.databaseFacts.projectUid !== uid
            || admitted.databaseFacts.projectInstanceId !== instanceId
            || admitted.databaseFacts.routeJournal !== admission.databaseFacts.routeJournal
            || exactIdentity.projectUid !== uid
            || exactIdentity.projectInstanceId !== instanceId
            || !sameLifecyclePlatformIdentity(
              exactIdentity.lifecyclePlatformIdentity,
              proof.lifecyclePlatformIdentity,
            )
          ) throw productionError('RECOVERY_REQUIRED', 'Route admission changed after lifecycle lease');
          return exactIdentity;
        },
      }),
    });
    const projectionFreshness = Object.freeze({
      ensureProjectionCurrent(receivedAdmission, writerTurn) {
        return ensureProjectionCurrent(receivedAdmission, writerTurn);
      },
      async ensureReadableProjection(receivedAdmission, query) {
        const result = await ensureReadableProjection(receivedAdmission, query);
        return result.value;
      },
    });
    const freshness = createProductWriteFreshness({
      productWriteIntentAuthority: productWriteIntents.authority(),
      journalRecovery: Object.freeze({
        lookupCommittedRequest(writeIntent, logicalRequestId) {
          const command = revisionCommandsByIntent.get(writeIntent);
          if (
            command === undefined
            || (command.kind !== 'revision.accept' && command.kind !== 'revision.finalize')
          ) return null;
          const committed = readCommittedRevisionResolution(entry, command, logicalRequestId);
          return committed === null ? null : Object.freeze({ disposition: 'after' });
        },
        lookupOrdinaryRequest(logicalRequestId) {
          return fileJournal.lookupOrdinaryRequest(logicalRequestId);
        },
        async recoverPendingOrdinary(...args) {
          if (args.length !== 0) {
            throw new TypeError('product ordinary recovery does not accept arguments');
          }
          const result = await fileJournal.recoverPendingOrdinary();
          if (entry.state.activeTurn === null) {
            throw productionError('RECOVERY_REQUIRED', 'Ordinary recovery lost its writer turn');
          }
          entry.state.ordinaryRecoveryTurns.add(entry.state.activeTurn);
          return result;
        },
      }),
      projectionFreshness,
    });
    const turnContextSource = Object.freeze({
      capture(input) {
        assertFreshnessTurn(input.admission, input.writerTurn);
        const snapshot = entry.state.turnSnapshots.get(input.writerTurn);
        if (snapshot === undefined) {
          throw productionError('RECOVERY_REQUIRED', 'Writer turn has no original FULL snapshot');
        }
        entry.state.uidPathProbe = manuscriptStore.createUidPathProbe(snapshot.fileSnapshot);
        const context = Object.freeze({
          journalId: randomUUID(),
          logicalRequestId: input.logicalRequestId,
          projectedAt: new Date().toISOString(),
          currentProjection: snapshot.currentProjection,
          fileSnapshot: snapshot.fileSnapshot,
          ignoredLedger: snapshot.ignoredLedger,
        });
        draftConflictContexts.register(
          context,
          Object.freeze({ journalId: context.journalId }),
        );
        return context;
      },
      captureOrphanBaseline(input) {
        assertFreshnessTurn(input.admission, input.writerTurn);
        const live = databasePort.captureProjection(entry.admission);
        const installedProjectionBaseline = resources(entry).projectionStore
          .captureInstalledOrphanBaseline(Object.freeze({
            projectStore: resources(entry).projectStore,
            currentProjection: live.currentProjection,
            ignoredLedger: live.ignoredLedger,
          }));
        const baseline = manuscriptStore.captureOrphanBaseline(Object.freeze({
          projectBinding: resources(entry).roots.projectBinding,
          currentProjection: live.currentProjection,
          ignoredLedger: live.ignoredLedger,
          installedProjectionBaseline,
        }));
        return Object.freeze({
          journalId: randomUUID(),
          logicalRequestId: input.logicalRequestId,
          projectedAt: new Date().toISOString(),
          currentProjection: live.currentProjection,
          fileSnapshot: baseline,
          ignoredLedger: live.ignoredLedger,
        });
      },
    });
    entry.turnContextSource = turnContextSource;
    entry.productGates = createManuscriptProductGates({
      projectSessionAdmission: Object.freeze({
        async withAdmission(selector, operation) {
          if (
            selector.name !== projectName
            || selector.expectedInstanceId !== instanceId
          ) throw productionError('RECOVERY_REQUIRED', 'Product selector changed its project binding');
          const session = await ensureSession(entry, projectSelector);
          return entry.sessionController.admit(session, operation);
        },
        async withOrphanAdmission(selector, operation) {
          if (
            selector.name !== projectName
            || selector.expectedInstanceId !== instanceId
          ) throw productionError('RECOVERY_REQUIRED', 'Product selector changed its project binding');
          const session = await ensureSession(entry, projectSelector, true);
          return entry.sessionController.admit(session, operation);
        },
      }),
      writerTurns: Object.freeze({
        async withWriterTurn(receivedAdmission, operation) {
          return lifecycleWriterTurns.withWriterTurn(receivedAdmission, operation);
        },
      }),
      freshness,
      turnContextSource,
      policy: Object.freeze({
        async authorizeWrite(input) {
          if (orphanPolicyInputs.has(input.policyInput)) {
            if (entry.state.turnSnapshots.has(input.writerTurn)) {
              throw productionError(
                'RECOVERY_REQUIRED',
                'Orphan policy unexpectedly received an ordinary FULL snapshot',
              );
            }
            return Object.freeze({ disposition: 'ALLOWED' });
          }
          const snapshot = entry.state.turnSnapshots.get(input.writerTurn);
          if (snapshot === undefined || snapshot.fileSnapshot !== input.turnContext.fileSnapshot) {
            throw productionError('RECOVERY_REQUIRED', 'Policy lost the original writer snapshot');
          }
          const replay = revisionResolutionPolicyInputs.get(input.policyInput);
          if (replay !== undefined) {
            const committed = readCommittedRevisionResolution(
              entry,
              replay.command,
              replay.logicalRequestId,
            );
            if (committed !== null) return Object.freeze({ disposition: 'ALLOWED' });
          }
          const currentWitness = witnessFor(snapshot, input.policyInput.witnessCommand);
          if (!sameWitness(currentWitness, input.policyInput.baseWitness)) {
            const command = draftConflictCommandsByPolicyInput.get(input.policyInput);
            if (command !== undefined) {
              let backup = null;
              try {
                backup = encodeDraftConflictBackup(command, currentWitness, uid);
              } catch (cause) {
                if (!(cause instanceof TypeError) || !/unsupported/u.test(cause.message)) throw cause;
              }
              if (backup !== null) {
                const service = resources(entry).draftConflictService;
                const draftRawSha256 = sha256(backup.draftBytes);
                const externalRawSha256 = sha256(backup.externalBytes);
                const existing = service.listConflicts(input.turnContext).find((conflict) => (
                  conflict.baseGeneration === backup.basis.baseGeneration
                  && conflict.draftRawSha256 === draftRawSha256
                  && conflict.externalRawSha256 === externalRawSha256
                  && stableJson(conflict.resource) === stableJson(backup.resource)
                ));
                if (existing === undefined) {
                  const conflict = Object.freeze({
                    basis: backup.basis,
                    draftBytes: backup.draftBytes,
                    externalBytes: backup.externalBytes,
                    fieldMask: backup.fieldMask,
                    resource: backup.resource,
                    supersedes: null,
                  });
                  const intent = draftConflictIntents.mint(Object.freeze({
                    kind: 'create_backup',
                    conflict,
                  }));
                  await service.createBackup(intent, input.turnContext);
                }
              }
            }
            throw productionError('EXTERNAL_DRAFT_CONFLICT', 'The files changed before the writer turn');
          }
          return Object.freeze({ disposition: 'ALLOWED' });
        },
      }),
      productWriteIntentAuthority: productWriteIntents.authority(),
    });
    Object.freeze(entry);
    entries.set(uid, entry);
    return entry;
  }

  function knownOrphanStartupFailure(error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor !== undefined
      && Object.hasOwn(descriptor, 'value')
      && descriptor.value === 'EXTERNAL_RESOURCE_CREATION_UNSUPPORTED';
  }

  function startSessionOpening(entry, projectSelector, mode, knownFailure = null) {
    let opening;
    if (mode === 'normal') {
      opening = entry.sessionController.openSession(projectSelector);
    } else if (knownFailure === null) {
      opening = entry.sessionController.openOrphanSession(projectSelector);
    } else {
      opening = entry.sessionController.openOrphanSessionAfterKnownFailure(
        projectSelector,
        knownFailure,
      );
    }
    let tracked;
    tracked = Promise.resolve(opening).then(
      (session) => session,
      (error) => {
        if (entry.state.sessionOpening?.promise === tracked) {
          entry.state.sessionOpening = null;
        }
        throw error;
      },
    );
    entry.state.sessionOpening = Object.freeze({ mode, promise: tracked });
    return tracked;
  }

  function ensureSession(entry, projectSelector, orphanStart = false) {
    if (entry.state.sessionOpening === null) {
      return startSessionOpening(
        entry,
        projectSelector,
        orphanStart ? 'orphan' : 'normal',
      );
    }
    const cached = entry.state.sessionOpening;
    if (!orphanStart || cached.mode === 'orphan') return cached.promise;
    return cached.promise.then(
      (session) => session,
      (error) => {
        if (!knownOrphanStartupFailure(error)) throw error;
        if (entry.state.sessionOpening !== null) {
          return ensureSession(entry, projectSelector, true);
        }
        return startSessionOpening(entry, projectSelector, 'orphan', error);
      },
    );
  }

  function currentProjectionToken(entry) {
    const projection = databasePort.captureProjection(entry.admission).currentProjection;
    return Object.freeze({
      generation: projection.basis.baseGeneration,
      connectionEpoch: entry.state.connectionEpoch,
      basisDigest: projection.basis.basisDigest,
    });
  }

  async function captureFullCandidate(entry) {
    const projection = databasePort.captureProjection(entry.admission);
    const generation = projection.currentProjection.basis.baseGeneration;
    const validationLedger = new IgnoredIdentityLedger().toValidationEntries(
      projection.ignoredLedger,
      generation,
    );
    const fileSnapshot = await entry.manuscriptStore.validateFull(
      resources(entry).roots.projectBinding,
      Object.freeze({
        ignoredLedger: validationLedger,
        lifecycleBasis: activeLifecycleBasis(projection.currentProjection.basis),
      }),
    );
    const candidate = await entry.manuscriptStore.buildProjectionCandidate(fileSnapshot);
    const snapshot = Object.freeze({
      admission: entry.admission,
      candidate,
      currentProjection: projection.currentProjection,
      fileSnapshot,
      ignoredLedger: projection.ignoredLedger,
      token: Object.freeze({
        generation: projection.currentProjection.basis.baseGeneration,
        connectionEpoch: entry.state.connectionEpoch,
        basisDigest: projection.currentProjection.basis.basisDigest,
      }),
    });
    return snapshot;
  }

  function installFullSnapshot(entry, snapshot, freshnessAdmission, writerTurn) {
    entry.state.lastSnapshot = snapshot;
    entry.state.admissionSnapshots.set(freshnessAdmission, snapshot);
    entry.state.turnSnapshots.set(writerTurn, snapshot);
  }

  async function validateAndPublishFull(entry, input) {
    const { admission: freshnessAdmission, writerTurn, baseToken } = input;
    const mappedAdmission = entry.state.turnAdmissions.get(writerTurn);
    if (mappedAdmission !== freshnessAdmission) {
      throw productionError('RECOVERY_REQUIRED', 'FULL refresh is outside its freshness writer turn');
    }
    const beforeToken = currentProjectionToken(entry);
    if (
      beforeToken.generation !== baseToken.generation
      || beforeToken.connectionEpoch !== baseToken.connectionEpoch
      || beforeToken.basisDigest !== baseToken.basisDigest
    ) throw productionError('RECOVERY_REQUIRED', 'FULL refresh base token changed before scan');
    const scanned = await captureFullCandidate(entry);
    const baseGeneration = scanned.currentProjection.basis.baseGeneration;
    const target = new SQLiteProjectionStore().buildTarget(Object.freeze({
      currentProjection: scanned.currentProjection,
      candidate: scanned.candidate,
      targetGeneration: baseGeneration + 1,
      projectedAt: new Date().toISOString(),
      ignoredLedger: scanned.ignoredLedger,
      localIdentityPlan: canonicalSchema12ReuseIdentityPlan(scanned.currentProjection),
    }));
    const authority = databasePort.inspectFullRefreshTarget(entry.admission, { target });
    const description = databasePort.describeFullRefreshDisposition(
      entry.admission,
      authority,
    );
    if (description.disposition === 'already_current') {
      if (description.generation !== baseGeneration) {
        throw productionError('RECOVERY_REQUIRED', 'FULL no-op generation changed');
      }
      installFullSnapshot(entry, scanned, freshnessAdmission, writerTurn);
      return Object.freeze({
        disposition: 'ALREADY_CURRENT',
        generation: baseGeneration,
        refreshKind: 'FULL',
      });
    }
    if (description.disposition !== 'target' || description.generation !== baseGeneration) {
      throw productionError('RECOVERY_REQUIRED', 'FULL refresh target is not safely publishable');
    }
    let published;
    try {
      published = entry.databaseProjectStore.publishProjectionTarget({ target });
    } catch (error) {
      let disposition;
      try {
        disposition = databasePort.inspectProjectionTarget(entry.admission, { target });
      } catch {
        throw error;
      }
      if (disposition === 'base') {
        return Object.freeze({
          disposition: 'KNOWN_NOT_COMMITTED',
          generation: baseGeneration,
          refreshKind: 'FULL',
          error,
        });
      }
      throw error;
    }
    if (published?.disposition !== 'after' || published.generation !== baseGeneration + 1) {
      throw productionError('RECOVERY_REQUIRED', 'FULL refresh publication is not proven after');
    }
    const currentProjection = currentProjectionAfterTarget(target);
    if (
      currentProjection.projectUid !== scanned.currentProjection.projectUid
      || currentProjection.projectInstanceId !== scanned.currentProjection.projectInstanceId
      || currentProjection.basis.baseGeneration !== baseGeneration + 1
    ) throw productionError('RECOVERY_REQUIRED', 'FULL refresh target changed project binding');
    const committed = Object.freeze({
      admission: entry.admission,
      candidate: scanned.candidate,
      currentProjection,
      fileSnapshot: scanned.fileSnapshot,
      ignoredLedger: target.ignoredLedger,
      token: Object.freeze({
        generation: currentProjection.basis.baseGeneration,
        connectionEpoch: entry.state.connectionEpoch,
        basisDigest: currentProjection.basis.basisDigest,
      }),
    });
    installFullSnapshot(entry, committed, freshnessAdmission, writerTurn);
    return Object.freeze({
      disposition: 'COMMITTED',
      baseGeneration,
      targetGeneration: baseGeneration + 1,
      refreshKind: 'FULL',
    });
  }

  function basisVolume(snapshot, uid) {
    return snapshot.currentProjection.basis.volumes.find((row) => row.uid === uid) ?? null;
  }

  function basisChapter(snapshot, uid) {
    return snapshot.currentProjection.basis.chapters.find((row) => row.uid === uid) ?? null;
  }

  function dataVersionFor(snapshot, chapterUid) {
    let versions = chapterDataVersions.get(snapshot);
    if (versions === undefined) {
      const rows = databasePort.read(snapshot.admission, (database) => database.prepare(
        'SELECT chapter_uid, data_version FROM chapters',
      ).all());
      versions = new Map(rows.map((row) => [row.chapter_uid, row.data_version]));
      chapterDataVersions.set(snapshot, versions);
    }
    const value = versions.get(chapterUid);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function volumeRows(snapshot) {
    return snapshot.candidate.volumes.map((volume) => {
      const basis = basisVolume(snapshot, volume.volumeUid);
      return Object.freeze({
        id: basis?.id ?? null,
        volume_uid: volume.volumeUid,
        sort_order: volume.volumePosition,
        title: volume.title,
        summary: volume.summary,
        chapters: Object.freeze(snapshot.candidate.chapters
          .filter((chapter) => chapter.volumeUid === volume.volumeUid)
          .map((chapter) => chapterRow(snapshot, chapter))),
      });
    });
  }

  function chapterRow(snapshot, chapter) {
    const basis = basisChapter(snapshot, chapter.chapterUid);
    const volume = chapter.volumeUid === null ? null : basisVolume(snapshot, chapter.volumeUid);
    return Object.freeze({
      id: basis?.id ?? null,
      chapter_uid: chapter.chapterUid,
      data_version: dataVersionFor(snapshot, chapter.chapterUid),
      volume_id: volume?.id ?? null,
      num: basis?.num ?? chapter.manuscriptPosition,
      title: chapter.title,
      outline: chapter.outline,
      content: chapter.content,
      summary: chapter.summary,
      word_count: chapter.wordCount,
      status: chapter.status,
      cognitive_frame: chapter.cognitiveFrame,
      emotional_anchor: chapter.emotionalAnchor,
      world_texture: chapter.worldTexture,
      concrete_mystery: chapter.concreteMystery,
      interpersonal_tension: chapter.interpersonalTension,
      body_raw_sha256: chapter.bodyRawSha256,
      sidecar_raw_sha256: chapter.sidecarRawSha256,
      chapter_position: chapter.chapterPosition,
      manuscript_position: chapter.manuscriptPosition,
    });
  }

  function chapterRows(snapshot) {
    return snapshot.candidate.chapters.map((chapter) => chapterRow(snapshot, chapter));
  }

  function promptContext(snapshot) {
    const auxiliary = databasePort.read(snapshot.admission, (database) => {
      const metadata = Object.create(null);
      for (const row of database.prepare('SELECT key, value FROM project_meta').all()) {
        metadata[row.key] = row.value;
      }
      const genres = database.prepare('SELECT genre FROM project_genres ORDER BY genre').all()
        .map((row) => row.genre);
      const characters = database.prepare(
        'SELECT id, name, age, gender, personality, background, role FROM characters ORDER BY name, id',
      ).all();
      const foreshadows = database.prepare(
        "SELECT id, title, description, status, priority FROM foreshadows WHERE status IN ('planted', 'progressing') ORDER BY created_at, id",
      ).all();
      return Object.freeze({
        metadata: Object.freeze({ ...metadata }),
        genres: Object.freeze([...genres]),
        characters: Object.freeze(characters.map((row) => Object.freeze({ ...row }))),
        foreshadows: Object.freeze(foreshadows.map((row) => Object.freeze({ ...row }))),
      });
    });
    return Object.freeze({
      metadata: auxiliary.metadata,
      genres: auxiliary.genres,
      characters: auxiliary.characters,
      chapters: Object.freeze(chapterRows(snapshot)),
      foreshadows: auxiliary.foreshadows,
    });
  }

  function productView(snapshot) {
    const auxiliary = databasePort.read(snapshot.admission, (database) => {
      const metadata = Object.create(null);
      for (const row of database.prepare('SELECT key, value FROM project_meta').all()) {
        metadata[row.key] = row.value;
      }
      const genres = database.prepare('SELECT genre FROM project_genres ORDER BY genre').all()
        .map((row) => row.genre);
      const sidebarItems = database.prepare(
        'SELECT * FROM sidebar_items WHERE enabled = 1 ORDER BY sort_order',
      ).all().filter((item) => {
        if (item.category === 'universal') return true;
        if (item.category !== 'genre') return false;
        const itemGenres = item.genres
          ? item.genres.split(',').map((entry) => entry.trim())
          : [];
        return genres.some((genre) => itemGenres.includes(genre));
      });
      return Object.freeze({
        metadata: Object.freeze({ ...metadata, genres: Object.freeze([...genres]) }),
        sidebarItems: Object.freeze(sidebarItems.map((row) => Object.freeze({ ...row }))),
      });
    });
    const chapters = chapterRows(snapshot);
    return Object.freeze({
      metadata: auxiliary.metadata,
      sidebarItems: auxiliary.sidebarItems,
      summary: Object.freeze({
        chapterCount: chapters.length,
        volumeCount: snapshot.candidate.volumes.length,
        wordCount: chapters.reduce((sum, chapter) => sum + chapter.word_count, 0),
        currentManuscriptPosition: chapters.reduce(
          (maximum, chapter) => Math.max(maximum, chapter.manuscript_position),
          0,
        ),
      }),
    });
  }

  function characterAssociations(snapshot) {
    const chapters = chapterRows(snapshot);
    const activeChapters = new Map(chapters.map((chapter, index) => [
      chapter.id,
      Object.freeze({ chapter, index }),
    ]));
    const auxiliary = databasePort.read(snapshot.admission, (database) => Object.freeze({
      associations: Object.freeze(database.prepare(
        'SELECT character_id, chapter_id, role FROM chapter_characters',
      ).all().map((row) => Object.freeze({ ...row }))),
      characters: Object.freeze(database.prepare(
        'SELECT * FROM characters ORDER BY name, id',
      ).all().map((row) => Object.freeze({ ...row }))),
    }));
    const appearances = new Map();
    for (const association of auxiliary.associations) {
      const active = activeChapters.get(association.chapter_id);
      if (active === undefined) continue;
      const rows = appearances.get(association.character_id) ?? [];
      rows.push(Object.freeze({
        chapter_id: active.chapter.id,
        volume_id: active.chapter.volume_id,
        num: active.chapter.num,
        title: active.chapter.title,
        role: association.role ?? 'appears',
        order: active.index,
      }));
      appearances.set(association.character_id, rows);
    }
    return Object.freeze(auxiliary.characters.map((character) => {
      const characterAppearances = (appearances.get(character.id) ?? [])
        .sort((left, right) => left.order - right.order)
        .map(({ order: _order, ...appearance }) => Object.freeze(appearance));
      return Object.freeze({
        ...character,
        appearances: Object.freeze(characterAppearances),
        chapterCount: characterAppearances.length,
      });
    }));
  }

  function statsView(snapshot) {
    const chapters = chapterRows(snapshot);
    const volumes = volumeRows(snapshot);
    const currentManuscriptPosition = chapters.reduce(
      (maximum, chapter) => Math.max(maximum, chapter.manuscript_position),
      0,
    );
    const auxiliary = databasePort.read(snapshot.admission, (database) => {
      const count = (table, where = '') => Number(database.prepare(
        `SELECT COUNT(*) AS count FROM ${table}${where}`,
      ).get()?.count ?? 0);
      const meta = Object.create(null);
      for (const row of database.prepare(
        "SELECT key, value FROM project_meta WHERE key IN ('mode', 'target_words')",
      ).all()) meta[row.key] = row.value;
      const foreshadows = database.prepare(
        'SELECT status, expected_resolve_manuscript_position FROM foreshadows',
      ).all();
      const tokenUsage = database.prepare(
        'SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM token_usage',
      ).get() || { input: 0, output: 0 };
      const chapterUpdates = database.prepare(
        'SELECT chapter_uid, updated_at FROM chapters WHERE is_present = 1',
      ).all();
      return Object.freeze({
        characterCount: count('characters'),
        worldCount: count('world_entries'),
        sciCount: count('science_entries'),
        relationCount: count('character_relations'),
        memoryCount: count('memories'),
        timelineCount: count('timeline_events'),
        clueUnresolved: count('clue_board', ' WHERE resolved = 0'),
        clueResolved: count('clue_board', ' WHERE resolved = 1'),
        genres: Object.freeze(database.prepare(
          'SELECT genre FROM project_genres ORDER BY genre',
        ).all().map((row) => row.genre)),
        foreshadows: Object.freeze(foreshadows.map((row) => Object.freeze({ ...row }))),
        mode: meta.mode || 'medium-novel',
        targetWords: meta.target_words || null,
        tokenInput: Number(tokenUsage.input || 0),
        tokenOutput: Number(tokenUsage.output || 0),
        chapterUpdates: Object.freeze(chapterUpdates.map((row) => Object.freeze({ ...row }))),
      });
    });
    const defaultTargetWords = {
      'short-story': 30000,
      'medium-novel': 100000,
      'long-novel': 200000,
    };
    const updateByUid = new Map(auxiliary.chapterUpdates.map((row) => [
      row.chapter_uid,
      row.updated_at,
    ]));
    const dailyMap = new Map();
    const today = new Date();
    for (const chapter of chapters) {
      const updatedAt = updateByUid.get(chapter.chapter_uid);
      if (typeof updatedAt !== 'string') continue;
      const day = updatedAt.slice(0, 10);
      dailyMap.set(day, (dailyMap.get(day) || 0) + chapter.word_count);
    }
    const dailyWords = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setUTCDate(date.getUTCDate() - offset);
      dailyWords.push(dailyMap.get(date.toISOString().slice(0, 10)) || 0);
    }
    const planted = auxiliary.foreshadows.filter((row) => row.status === 'planted');
    return Object.freeze({
      totalWords: chapters.reduce((sum, chapter) => sum + chapter.word_count, 0),
      chapterCount: chapters.length,
      acceptedCount: chapters.filter((chapter) => chapter.status === 'accepted').length,
      characterCount: auxiliary.characterCount,
      foreshadowCount: auxiliary.foreshadows.length,
      resolvedForeshadow: auxiliary.foreshadows.filter((row) => row.status === 'resolved').length,
      overdueForeshadow: planted.filter((row) => (
        Number.isSafeInteger(row.expected_resolve_manuscript_position)
        && currentManuscriptPosition >= row.expected_resolve_manuscript_position
      )).length,
      worldCount: auxiliary.worldCount,
      sciCount: auxiliary.sciCount,
      relationCount: auxiliary.relationCount,
      memoryCount: auxiliary.memoryCount,
      timelineCount: auxiliary.timelineCount,
      volumeCount: volumes.length,
      volumes: Object.freeze(volumes.map((volume) => Object.freeze({
        id: volume.id,
        volume_uid: volume.volume_uid,
        title: volume.title,
        sort_order: volume.sort_order,
        chapter_count: volume.chapters.length,
        word_count: volume.chapters.reduce((sum, chapter) => sum + chapter.word_count, 0),
      }))),
      clueUnresolved: auxiliary.clueUnresolved,
      clueResolved: auxiliary.clueResolved,
      genres: auxiliary.genres,
      tokenInput: auxiliary.tokenInput,
      tokenOutput: auxiliary.tokenOutput,
      targetWords: auxiliary.targetWords === null
        ? (defaultTargetWords[auxiliary.mode] || 100000)
        : Number.parseInt(auxiliary.targetWords, 10),
      currentChapter: chapters.find((chapter) => chapter.status === 'writing') || null,
      chapters: Object.freeze(chapters.map((chapter) => Object.freeze({
        id: chapter.id,
        chapter_uid: chapter.chapter_uid,
        num: chapter.num,
        title: chapter.title,
        word_count: chapter.word_count,
        status: chapter.status,
        manuscript_position: chapter.manuscript_position,
      }))),
      dailyWords: Object.freeze(dailyWords),
    });
  }

  function exportSnapshot(snapshot) {
    const view = productView(snapshot);
    return Object.freeze({
      metadata: view.metadata,
      volumes: Object.freeze(volumeRows(snapshot)),
      chapters: Object.freeze(chapterRows(snapshot)),
      projectionGeneration: snapshot.currentProjection.basis.baseGeneration,
    });
  }

  function revisionDecisionSnapshot(value) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw productionError('RECOVERY_REQUIRED', 'Revision decisions are malformed', cause);
    }
    if (
      parsed === null
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))
    ) throw productionError('RECOVERY_REQUIRED', 'Revision decisions are not plain data');
    const result = {};
    for (const [changeId, decision] of Object.entries(parsed)) {
      if (!changeId || (decision !== 'accepted' && decision !== 'rejected')) {
        throw productionError('RECOVERY_REQUIRED', 'Revision decisions contain an invalid value');
      }
      result[changeId] = decision;
    }
    return Object.freeze(result);
  }

  function serializeRevisionSnapshot(row, chapterUidValue) {
    return Object.freeze({
      id: row.id,
      chapterId: row.chapter_id,
      chapterUid: chapterUidValue,
      baseContent: row.base_content,
      proposedContent: row.proposed_content,
      decisions: revisionDecisionSnapshot(row.decisions_json),
      status: row.status,
      previousChapterStatus: row.previous_chapter_status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
    });
  }

  function parseRevisionResolutionReceipt(value) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (cause) {
      throw productionError('RECOVERY_REQUIRED', 'Revision resolution receipt is malformed', cause);
    }
    const outer = exactCommandData(
      parsed,
      [['version', 'revisionResolution']],
      'revision resolution receipt',
    );
    if (outer.version !== 1) {
      throw productionError('RECOVERY_REQUIRED', 'Revision resolution receipt version is invalid');
    }
    const resolution = exactCommandData(
      outer.revisionResolution,
      [[
        'revisionId', 'chapterId', 'chapterUid', 'from', 'to',
        'baseContentSha256', 'proposedContentSha256', 'acceptedContentSha256',
        'decisionsSha256', 'logicalRequestId', 'commandKind', 'commandDigest',
      ]],
      'revision resolution receipt payload',
    );
    if (
      !Number.isSafeInteger(resolution.revisionId)
      || resolution.revisionId <= 0
      || !Number.isSafeInteger(resolution.chapterId)
      || resolution.chapterId <= 0
      || stableUid(resolution.chapterUid, 'receipt.chapterUid') !== resolution.chapterUid
      || resolution.from !== 'pending'
      || resolution.to !== 'accepted'
      || (resolution.commandKind !== 'revision.accept'
        && resolution.commandKind !== 'revision.finalize')
      || typeof resolution.logicalRequestId !== 'string'
      || resolution.logicalRequestId.length === 0
      || [
        resolution.baseContentSha256,
        resolution.proposedContentSha256,
        resolution.acceptedContentSha256,
        resolution.decisionsSha256,
        resolution.commandDigest,
      ].some((digest) => typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest))
    ) throw productionError('RECOVERY_REQUIRED', 'Revision resolution receipt is invalid');
    return Object.freeze({ ...resolution });
  }

  function revisionSnapshot(snapshot, request) {
    const requestInput = exactCommandData(
      request,
      [['kind', 'chapterUid']],
      'revision_snapshot request',
    );
    const chapterUidValue = stableUid(requestInput.chapterUid, 'request.chapterUid');
    const chapter = resolveChapter(snapshot, {
      kind: 'chapter',
      chapterUid: chapterUidValue,
    });
    const rows = databasePort.read(snapshot.admission, (database) => database.prepare(`
      SELECT id, chapter_id, base_content, proposed_content, decisions_json, status,
             previous_chapter_status, created_at, updated_at, resolved_at
      FROM chapter_revisions
      WHERE chapter_id = ? AND status = 'pending'
      ORDER BY id DESC
    `).all(chapter.id));
    if (rows.length > 1) {
      throw productionError('RECOVERY_REQUIRED', 'Chapter has multiple pending revisions');
    }
    const row = rows[0] ?? null;
    if (row !== null && row.base_content !== chapter.content) {
      throw productionError(
        'RECOVERY_REQUIRED',
        'Pending revision base differs from the admitted ActiveProjection',
      );
    }
    return Object.freeze({
      revision: row === null ? null : serializeRevisionSnapshot(row, chapterUidValue),
      rebased: false,
      chapterDataVersion: chapter.data_version,
    });
  }

  function readSnapshotValue(snapshot, request) {
    if (request.kind === 'chapter') return resolveChapter(snapshot, request);
    if (request.kind === 'chapters') return Object.freeze(chapterRows(snapshot));
    if (request.kind === 'volumes') return Object.freeze(volumeRows(snapshot));
    if (request.kind === 'volume') return resolveVolume(snapshot, request);
    if (request.kind === 'prompt_context') return promptContext(snapshot);
    if (request.kind === 'product_view') return productView(snapshot);
    if (request.kind === 'stats') return statsView(snapshot);
    if (request.kind === 'export_snapshot') return exportSnapshot(snapshot);
    if (request.kind === 'character_associations') return characterAssociations(snapshot);
    if (request.kind === 'revision_snapshot') return revisionSnapshot(snapshot, request);
    if (request.kind === 'project') return Object.freeze({
      project_uid: projectUid(snapshot.admission),
      projection_generation: snapshot.currentProjection.basis.baseGeneration,
    });
    throw productionError('INVALID_PARAMS', 'Files read kind is unsupported');
  }

  function resolveChapter(snapshot, request) {
    const rows = chapterRows(snapshot);
    let matches = rows;
    if (typeof request.chapterUid === 'string') {
      matches = matches.filter((row) => row.chapter_uid === request.chapterUid);
    } else if (Number.isSafeInteger(request.chapterId) && request.chapterId > 0) {
      matches = matches.filter((row) => row.id === request.chapterId);
    } else if (Number.isSafeInteger(request.chapterNum) && request.chapterNum > 0) {
      matches = matches.filter((row) => row.num === request.chapterNum);
      if (Number.isSafeInteger(request.volumeId) && request.volumeId > 0) {
        matches = matches.filter((row) => row.volume_id === request.volumeId);
      }
    } else {
      throw productionError('INVALID_PARAMS', 'A stable chapter identity is required');
    }
    if (matches.length !== 1) {
      throw productionError(matches.length === 0 ? 'DB_NOT_FOUND' : 'INVALID_PARAMS', 'Chapter identity is missing or ambiguous');
    }
    return matches[0];
  }

  function resolveVolume(snapshot, request, field = 'volumeId') {
    const rows = volumeRows(snapshot);
    let matches;
    if (typeof request.volumeUid === 'string') {
      matches = rows.filter((row) => row.volume_uid === request.volumeUid);
    } else if (Number.isSafeInteger(request[field]) && request[field] > 0) {
      matches = rows.filter((row) => row.id === request[field]);
    } else {
      throw productionError('INVALID_PARAMS', 'A stable volume identity is required');
    }
    if (matches.length !== 1) {
      throw productionError(matches.length === 0 ? 'DB_NOT_FOUND' : 'INVALID_PARAMS', 'Volume identity is missing or ambiguous');
    }
    return matches[0];
  }

  function witnessFor(snapshot, request) {
    const generation = snapshot.currentProjection.basis.baseGeneration;
    const chapterResource = request.kind === 'chapter'
      || request.kind === 'chapter.replace_body'
      || request.kind === 'chapter.patch_sidecar'
      || request.kind === 'chapter.replace_body_and_sidecar'
      || request.kind === 'revision.create';
    if (chapterResource) {
      const chapter = resolveChapter(snapshot, request);
      const row = databasePort.read(snapshot.admission, (database) => database.prepare(
        'SELECT data_version FROM chapters WHERE chapter_uid = ?',
      ).get(chapter.chapter_uid));
      return Object.freeze({
        expectedDataVersion: Number.isSafeInteger(row?.data_version) && row.data_version >= 0
          ? row.data_version
          : 0,
        generation,
        rawSha256: chapter.body_raw_sha256,
        sidecarRawSha256: chapter.sidecar_raw_sha256,
      });
    }
    return Object.freeze({
      expectedDataVersion: 0,
      generation,
      rawSha256: sha256(stableJson({
        chapters: chapterRows(snapshot),
        volumes: volumeRows(snapshot).map(({ chapters: _chapters, ...volume }) => volume),
      })),
      sidecarRawSha256: null,
    });
  }

  function witnessRequestForResolvedCommand(command) {
    if (command.kind === 'chapter.replace_body') {
      return Object.freeze({ kind: command.kind, chapterUid: command.bodyRef.chapterUid });
    }
    if (command.kind === 'chapter.patch_sidecar') {
      return Object.freeze({ kind: command.kind, chapterUid: command.sidecarRef.chapterUid });
    }
    if (command.kind === 'chapter.replace_body_and_sidecar') {
      if (command.bodyRef.chapterUid !== command.sidecarRef.chapterUid) {
        throw productionError('RECOVERY_REQUIRED', 'Combined draft command names two chapters');
      }
      return Object.freeze({ kind: command.kind, chapterUid: command.bodyRef.chapterUid });
    }
    return command;
  }

  function bodyRef(projectUidValue, chapterUid) {
    return deriveControlledFileRef({ role: 'chapter_body', projectUid: projectUidValue, chapterUid });
  }

  function sidecarRef(projectUidValue, chapterUid) {
    return deriveControlledFileRef({ role: 'chapter_sidecar', projectUid: projectUidValue, chapterUid });
  }

  function volumeRef(projectUidValue, volumeUid) {
    return deriveControlledFileRef({ role: 'volume_index', projectUid: projectUidValue, volumeUid });
  }

  function resolveCommand(admission, command) {
    const uid = projectUid(admission);
    if (
      command.kind === 'ignored.preserve_move_to_unassigned'
      || command.kind === 'ignored.detach_reference'
    ) {
      const input = exactCommandData(
        command,
        [['kind', 'chapterUid']],
        `${command.kind} command`,
      );
      return Object.freeze({
        kind: command.kind,
        chapterUid: stableUid(input.chapterUid, 'command.chapterUid'),
      });
    }
    if (command.kind === 'revision.create') {
      const input = exactCommandData(
        command,
        [['kind', 'chapterUid', 'baseContent', 'proposedContent']],
        'revision.create command',
      );
      return Object.freeze({
        kind: command.kind,
        chapterUid: stableUid(input.chapterUid, 'command.chapterUid'),
        baseContent: revisionText(input.baseContent, 'command.baseContent'),
        proposedContent: revisionText(input.proposedContent, 'command.proposedContent'),
      });
    }
    if (command.kind === 'revision.update_decisions') {
      const input = exactCommandData(
        command,
        [['kind', 'revisionId', 'decisions', 'expectedBaseContent']],
        'revision.update_decisions command',
      );
      return Object.freeze({
        kind: command.kind,
        revisionId: positiveSafeInteger(input.revisionId, 'command.revisionId'),
        decisions: revisionDecisions(input.decisions, 'command.decisions'),
        expectedBaseContent: revisionText(
          input.expectedBaseContent,
          'command.expectedBaseContent',
        ),
      });
    }
    if (command.kind === 'revision.reject' || command.kind === 'revision.accept') {
      const input = exactCommandData(
        command,
        [['kind', 'revisionId', 'expectedBaseContent']],
        `${command.kind} command`,
      );
      return Object.freeze({
        kind: command.kind,
        revisionId: positiveSafeInteger(input.revisionId, 'command.revisionId'),
        expectedBaseContent: revisionText(
          input.expectedBaseContent,
          'command.expectedBaseContent',
        ),
      });
    }
    if (command.kind === 'revision.finalize') {
      const input = exactCommandData(
        command,
        [[
          'kind', 'revisionId', 'content', 'expectedBaseContent', 'expectedDecisions',
        ]],
        'revision.finalize command',
      );
      return Object.freeze({
        kind: command.kind,
        revisionId: positiveSafeInteger(input.revisionId, 'command.revisionId'),
        content: revisionText(input.content, 'command.content'),
        expectedBaseContent: revisionText(
          input.expectedBaseContent,
          'command.expectedBaseContent',
        ),
        expectedDecisions: revisionDecisions(
          input.expectedDecisions,
          'command.expectedDecisions',
        ),
      });
    }
    if (command.kind === 'chapter.replace_body') {
      const input = exactCommandData(command, [
        ['kind', 'chapterUid', 'expected_data_version', 'content'],
        ['kind', 'chapterUid', 'content'],
      ], 'chapter.replace_body command');
      return Object.freeze({
        kind: command.kind,
        bodyRef: bodyRef(uid, stableUid(input.chapterUid, 'command.chapterUid')),
        content: input.content,
      });
    }
    if (command.kind === 'chapter.patch_sidecar') {
      const input = exactCommandData(command, [
        ['kind', 'chapterUid', 'expected_data_version', 'patch'],
        ['kind', 'chapterUid', 'patch'],
      ], 'chapter.patch_sidecar command');
      return Object.freeze({
        kind: command.kind,
        sidecarRef: sidecarRef(uid, stableUid(input.chapterUid, 'command.chapterUid')),
        patch: input.patch,
      });
    }
    if (command.kind === 'chapter.replace_body_and_sidecar') {
      const input = exactCommandData(command, [
        ['kind', 'chapterUid', 'expected_data_version', 'content', 'patch'],
        ['kind', 'chapterUid', 'content', 'patch'],
      ], 'chapter.replace_body_and_sidecar command');
      const chapterUid = stableUid(input.chapterUid, 'command.chapterUid');
      return Object.freeze({
        kind: command.kind,
        bodyRef: bodyRef(uid, chapterUid),
        sidecarRef: sidecarRef(uid, chapterUid),
        content: input.content,
        patch: input.patch,
      });
    }
    if (command.kind === 'volume.patch_metadata') {
      const input = exactCommandData(
        command,
        [['kind', 'volumeUid', 'patch']],
        'volume.patch_metadata command',
      );
      return Object.freeze({
        kind: command.kind,
        volumeRef: volumeRef(uid, stableUid(input.volumeUid, 'command.volumeUid')),
        patch: input.patch,
      });
    }
    if (command.kind === 'volume.create') {
      const input = exactCommandData(
        command,
        [['kind', 'title', 'summary']],
        'volume.create command',
      );
      return Object.freeze({
        kind: command.kind,
        title: input.title,
        summary: input.summary,
      });
    }
    if (command.kind === 'chapter.create') {
      const input = exactCommandData(command, [[
        'kind', 'containerVolumeUid', 'requestedNum', 'content', 'sidecar',
      ]], 'chapter.create command');
      const containerVolumeUid = input.containerVolumeUid === null
        ? null
        : stableUid(input.containerVolumeUid, 'command.containerVolumeUid');
      return Object.freeze({
        kind: command.kind,
        containerVolumeUid,
        requestedNum: input.requestedNum,
        content: input.content,
        sidecar: input.sidecar,
      });
    }
    if (command.kind === 'chapter.delete') {
      const input = exactCommandData(command, [['kind', 'chapterUid']], 'chapter.delete command');
      return Object.freeze({
        kind: command.kind,
        chapterUid: stableUid(input.chapterUid, 'command.chapterUid'),
      });
    }
    if (command.kind === 'volume.delete') {
      const input = exactCommandData(command, [['kind', 'volumeUid']], 'volume.delete command');
      return Object.freeze({
        kind: command.kind,
        volumeUid: stableUid(input.volumeUid, 'command.volumeUid'),
      });
    }
    if (command.kind === 'chapter.move') {
      const input = exactCommandData(command, [[
        'kind', 'chapterUid', 'targetVolumeUid', 'targetPosition',
      ]], 'chapter.move command');
      const targetVolumeUid = input.targetVolumeUid === null
        ? null
        : stableUid(input.targetVolumeUid, 'command.targetVolumeUid');
      return Object.freeze({
        kind: command.kind,
        chapterUid: stableUid(input.chapterUid, 'command.chapterUid'),
        targetVolumeUid,
        targetPosition: input.targetPosition,
      });
    }
    if (command.kind === 'chapter.reorder') {
      const input = exactCommandData(command, [[
        'kind', 'containerVolumeUid', 'chapterUids',
      ]], 'chapter.reorder command');
      const containerVolumeUid = input.containerVolumeUid === null
        ? null
        : stableUid(input.containerVolumeUid, 'command.containerVolumeUid');
      const chapterUids = stableUidArray(input.chapterUids, 'command.chapterUids');
      return Object.freeze({ kind: command.kind, containerVolumeUid, chapterUids });
    }
    if (command.kind === 'volume.reorder') {
      const input = exactCommandData(command, [['kind', 'volumeUids']], 'volume.reorder command');
      return Object.freeze({
        kind: command.kind,
        volumeUids: stableUidArray(input.volumeUids, 'command.volumeUids'),
      });
    }
    throw productionError('RECOVERY_REQUIRED', 'Activated files command needs the pending production creation adapter');
  }

  function selectorForEntry(entry) {
    return Object.freeze({
      name: projectUid(entry.admission),
      expectedInstanceId: entry.admission.databaseFacts.projectInstanceId,
    });
  }

  async function resolveOrphan(admission, request, action) {
    const entry = entryFor(admission);
    const writeIntent = entry.productWriteIntents.bindOrphanAction(
      action,
      Object.freeze({ kind: request.kind, uid: request.uid }),
    );
    const policyInput = Object.freeze({});
    orphanPolicyInputs.add(policyInput);
    return entry.productGates.withCurrentManuscriptWriteTurn(
      selectorForEntry(entry),
      Object.freeze({
        logicalRequestId: request.requestId,
        policyInput,
        writeIntent,
      }),
      (turnContext) => entry.productWriteIntents.execute(writeIntent, turnContext),
    );
  }

  async function withDraftConflictTurn(admission, logicalRequestId, operation) {
    const entry = entryFor(admission);
    const selector = selectorForEntry(entry);
    const session = await ensureSession(entry, selector);
    return entry.sessionController.admit(session, (freshnessAdmission) => (
      entry.writerTurns.withWriterTurn(freshnessAdmission, async (writerTurn) => {
        await ensureProjectionCurrent(freshnessAdmission, writerTurn);
        const context = entry.turnContextSource.capture(Object.freeze({
          admission: freshnessAdmission,
          writerTurn,
          logicalRequestId,
        }));
        const installed = resources(entry);
        for (const conflict of installed.draftConflictJournal.listConflicts()) {
          await installed.draftConflictJournal.recover(conflict.conflictId);
        }
        return operation(entry, installed, context);
      })
    ));
  }

  function publishDraftConflictCopy(conflictId, bytes) {
    const exportDirectory = db.getExportDir();
    const filename = `${conflictId}-${randomUUID()}.mythpen-draft`;
    const targetPath = path.join(exportDirectory, filename);
    let descriptor = null;
    try {
      fs.mkdirSync(exportDirectory, { recursive: true });
      descriptor = fs.openSync(targetPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fsyncDirectory(exportDirectory);
      if (!fs.readFileSync(targetPath).equals(bytes)) {
        throw productionError('RECOVERY_REQUIRED', 'Draft conflict copy readback differs');
      }
      return Object.freeze({ filename });
    } catch (cause) {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.unlinkSync(targetPath); } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') cause.cleanupError = cleanupError;
      }
      if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
      throw productionError('RECOVERY_REQUIRED', 'Draft conflict copy failed', cause);
    }
  }

  return Object.freeze({
    copyDraftConflictBackup(admission, request) {
      return withDraftConflictTurn(admission, request.requestId, async (_entry, installed, context) => {
        const visible = installed.draftConflictService.listConflicts(context);
        const conflict = visible.find((candidate) => candidate.conflictId === request.conflictId);
        if (conflict === undefined || conflict.backupAvailable !== true) {
          throw productionError('RECOVERY_REQUIRED', 'Draft conflict backup is unavailable');
        }
        const bytes = await installed.draftConflictStorage.readDraftCopy(request.conflictId);
        return publishDraftConflictCopy(request.conflictId, bytes);
      });
    },
    listDraftConflicts(admission) {
      return withDraftConflictTurn(
        admission,
        `draft-conflict-list:${randomUUID()}`,
        (_entry, installed, context) => installed.draftConflictService.listConflicts(context),
      );
    },
    resolveDraftConflict(admission, request) {
      return withDraftConflictTurn(admission, request.requestId, async (entry, installed, context) => {
        const intent = entry.draftConflictIntents.mint(Object.freeze({
          kind: request.action,
          conflictId: request.conflictId,
          decisionEpoch: request.decisionEpoch,
        }));
        if (request.action === 'accept_external') {
          await installed.draftConflictService.acceptExternal(intent, context);
          return Object.freeze({
            conflictId: request.conflictId,
            decisionEpoch: request.decisionEpoch,
            state: 'resolved_accept_external',
          });
        }
        await installed.draftConflictService.applySavedDraft(intent, context);
        return Object.freeze({
          conflictId: request.conflictId,
          decisionEpoch: request.decisionEpoch,
          state: 'resolved_apply_draft',
        });
      });
    },
    async read(admission, request) {
      const entry = entryFor(admission);
      const value = await entry.productGates.withReadableManuscriptProjection(
        selectorForEntry(entry),
        request,
      );
      const snapshot = requestSnapshots.get(request);
      if (snapshot === undefined) {
        throw productionError('RECOVERY_REQUIRED', 'Readable gate did not install its FULL snapshot');
      }
      return Object.freeze({ value, baseWitness: witnessFor(snapshot, request) });
    },
    ignoreInPlace(admission, request) {
      return resolveOrphan(admission, request, 'ignore_in_place');
    },
    async write(admission, request) {
      const entry = entryFor(admission);
      const command = resolveCommand(admission, request.command);
      const writeIntent = command.kind.startsWith('revision.')
        ? entry.productWriteIntents.bindRevisionCommand(command)
        : entry.productWriteIntents.bindL2Command(command);
      if (command.kind.startsWith('revision.')) {
        revisionCommandsByIntent.set(writeIntent, command);
      }
      const policyInput = Object.freeze({
        baseWitness: request.baseWitness,
        witnessCommand: request.witnessCommand,
      });
      if (!command.kind.startsWith('revision.')) {
        draftConflictCommandsByPolicyInput.set(policyInput, command);
      }
      if (command.kind === 'revision.accept' || command.kind === 'revision.finalize') {
        revisionResolutionPolicyInputs.set(policyInput, Object.freeze({
          command,
          logicalRequestId: request.requestId,
        }));
      }
      try {
        return await entry.productGates.withCurrentManuscriptWriteTurn(
          selectorForEntry(entry),
          Object.freeze({
            logicalRequestId: request.requestId,
            policyInput,
            writeIntent,
          }),
          (turnContext) => entry.productWriteIntents.execute(writeIntent, turnContext),
        );
      } catch (cause) { throw cause; }
    },
    async recover(admission) {
      const entry = entryFor(admission);
      const selector = selectorForEntry(entry);
      const session = await ensureSession(entry, selector);
      return entry.sessionController.admit(session, (freshnessAdmission) => (
        databasePort.withWriterTurn(entry.admission, async (writerTurn) => {
          entry.state.activeTurn = writerTurn;
          entry.state.knownFreshnessAdmissions.add(freshnessAdmission);
          entry.state.turnAdmissions.set(writerTurn, freshnessAdmission);
          try {
            await entry.fileJournal.recoverPendingOrdinary();
            return await databasePort.recover(entry.admission);
          } finally {
            entry.state.activeTurn = null;
          }
        })
      ));
    },
    revokeIgnore(admission, request) {
      return resolveOrphan(admission, request, 'revoke_ignore');
    },
    close() {
      if (closePromise !== null) return closePromise;
      closed = true;
      closePromise = (async () => {
        let firstError = null;
        for (const entry of entries.values()) {
          if (entry.state.sessionOpening === null) continue;
          try {
            const session = await entry.state.sessionOpening.promise;
            await entry.sessionController.close(session);
          } catch (error) {
            firstError ||= error;
          }
        }
        entries.clear();
        try {
          await databasePort.close();
        } catch (error) {
          firstError ||= error;
        }
        if (firstError !== null) throw firstError;
      })();
      return closePromise;
    },
  });
}

function createSqliteBackend() {
  function unsupported() {
    throw productionError('SQLITE_RUNTIME_ROUTE_UNSUPPORTED', 'Legacy SQLite requests remain on their existing route owners');
  }
  return Object.freeze({ read: unsupported, write: unsupported, recover: unsupported, close() {} });
}

function createProductionManuscriptRuntime() {
  if (arguments.length !== 0) {
    throw new TypeError('createProductionManuscriptRuntime accepts no arguments');
  }
  const storage = db.getStoragePaths();
  const databasePort = db.createFilesManuscriptDatabasePort();
  const fileBoundary = assertProductionManuscriptFileBoundaryPair(
    createProductionManuscriptFileBoundary(),
  );
  const uidCatalog = createProductionUidCatalog({
    dataRoot: storage.dataDir,
    databasePort,
  });
  const files = createFilesBackend({
    databasePort,
    dataRoot: storage.dataDir,
    fileBoundary,
    uidCatalog,
  });
  const filesRuntimePort = Object.freeze({
    close: files.close,
    copyDraftConflictBackup: files.copyDraftConflictBackup,
    ignoreInPlace: files.ignoreInPlace,
    listDraftConflicts: files.listDraftConflicts,
    read: files.read,
    recover: files.recover,
    resolveDraftConflict: files.resolveDraftConflict,
    revokeIgnore: files.revokeIgnore,
    write: files.write,
  });
  const creation = createProductionCreationAdapter({
    dataRoot: storage.dataDir,
    projectsDir: storage.projectsDir,
    databasePort,
    fileBoundary,
    uidCatalog,
  });
  const migration = createProductionMigrationAdapter({
    dataRoot: storage.dataDir,
    projectsDir: storage.projectsDir,
    databasePort,
    fileBoundary,
    uidCatalog,
  });
  return createManuscriptRuntime({
    routeResolver: databasePort,
    sqlite: createSqliteBackend(),
    files: filesRuntimePort,
    creation,
    migration,
  });
}

module.exports = { createProductionManuscriptRuntime };
