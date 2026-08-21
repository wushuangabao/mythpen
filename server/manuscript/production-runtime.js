'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../db');
const { openControlStore } = require('../control-store');
const {
  createProductionManuscriptFileBoundary,
} = require('../platform/manuscript-file-boundary');
const { FilePublicationJournal } = require('./file-publication-journal');
const { FilePublisher } = require('./file-publisher');
const { IgnoredIdentityLedger } = require('./ignored-ledger');
const { createL2ManuscriptService } = require('./l2-service');
const { deriveControlledFileRef } = require('./paths');
const { SQLiteProjectionStore } = require('./projection-store');
const { openActivatedProjectRoot } = require('./production-project-roots');
const { createProductionCreationAdapter } = require('./production-creation-adapter');
const { createProductionMigrationAdapter } = require('./production-migration-adapter');
const { createManuscriptRuntime } = require('./runtime');
const { ManuscriptStore } = require('./store');
const { ManuscriptUidReservation } = require('./uid-reservation');
const { createUidReservationSources } = require('./uid-reservation-sources');
const { MigrationJournal } = require('./migration-journal');
const { ProjectCreationJournal } = require('./project-creation-journal');

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

function sameWitness(left, right) {
  return left.expectedDataVersion === right.expectedDataVersion
    && left.generation === right.generation
    && left.rawSha256 === right.rawSha256
    && left.sidecarRawSha256 === right.sidecarRawSha256;
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

function directoryNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function createProductionUidCatalog({ dataRoot, databasePort }) {
  const ordinarySources = new Map();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  const disposition = evidenceOnlyDisposition();

  function creationSources() {
    const root = path.join(dataRoot, 'control', 'project-creation');
    return directoryNames(root).map((creationId) => {
      if (!uuidPattern.test(creationId)) {
        throw productionError('RECOVERY_REQUIRED', 'Creation control root has a non-canonical identity');
      }
      const journal = new ProjectCreationJournal({
        childDisposition: disposition,
        clock: Date.now,
        controlStore: openControlStore(path.join(root, creationId)),
        creationId,
        dataRoot,
        databaseDisposition: disposition,
      });
      return journal.reservationSource();
    });
  }

  function migrationSources() {
    const root = path.join(dataRoot, 'control', 'manuscripts');
    const sources = [];
    for (const uid of directoryNames(root)) {
      if (!uuidPattern.test(uid)) {
        throw productionError('RECOVERY_REQUIRED', 'Manuscript control root has a non-canonical project UID');
      }
      for (const instanceId of directoryNames(path.join(root, uid))) {
        if (!uuidPattern.test(instanceId)) {
          throw productionError('RECOVERY_REQUIRED', 'Manuscript control root has a non-canonical instance ID');
        }
        const controlStore = openControlStore(path.join(root, uid, instanceId));
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
        ? directoryNames(path.join(dataRoot, 'manuscripts'))
          .filter((uid) => !registered.has(uid))
          .map((uid) => {
          if (!uuidPattern.test(uid)) {
            throw productionError('RECOVERY_REQUIRED', 'Manuscript root has a non-canonical project UID');
          }
          return Object.freeze({
            ownerKind: 'existing_root',
            ownerId: path.join(dataRoot, 'manuscripts', uid),
            reservationId: sha256(`existing-root:${uid}`),
            uid,
          });
        })
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
  let closed = false;

  function assertOpen() {
    if (closed) throw productionError('RECOVERY_REQUIRED', 'Production files backend is closed');
  }

  function projectUid(admission) {
    return admission.databaseFacts.projectUid;
  }

  function entryFor(admission) {
    assertOpen();
    const uid = projectUid(admission);
    const existing = entries.get(uid);
    if (existing !== undefined) return existing;
    const instanceId = admission.databaseFacts.projectInstanceId;
    const controlDirectory = path.join(dataRoot, 'control', 'manuscripts', uid, instanceId);
    const controlStore = openControlStore(controlDirectory);
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
    const filePublisher = new FilePublisher({ writerCapability: fileBoundary.writerCapability });
    const state = {
      activeTurn: null,
      recovered: false,
      recoveryPromise: null,
      uidPathProbe: null,
    };
    const fileJournal = new FilePublicationJournal({
      controlStore,
      filePublisher,
      projectionStore,
      projectStore: databasePort.projectStore(admission),
      projectionDisposition: Object.freeze({
        inspectTarget(input) {
          return databasePort.inspectProjectionTarget(admission, { target: input.target });
        },
      }),
      parentAuthority: denyParentAuthority(),
      projectBinding,
      assertWriteAuthority() {
        if (state.activeTurn === null) {
          throw productionError('RECOVERY_REQUIRED', 'File publication is outside its database writer turn');
        }
        databasePort.assertWriterTurn(admission, state.activeTurn);
      },
    });
    const manuscriptStore = new ManuscriptStore({
      dataRoot,
      fileBoundary: fileBoundary.readCapability,
      journalAuthority: fileJournal.journalAuthority(),
    });
    const ordinaryReservationSource = fileJournal.reservationSource();
    uidCatalog.registerOrdinary(uid, ordinaryReservationSource);
    const uidReservation = new ManuscriptUidReservation({
      reservationSources: uidCatalog.reservationSources,
      uuidV4: randomUUID,
    });
    const l2 = createL2ManuscriptService({
      manuscriptStore,
      fileJournal,
      projectionStore,
      uidReservation,
      uidPathProbe: Object.freeze({
        async probe(input) {
          if (state.uidPathProbe === null) {
            throw productionError('RECOVERY_REQUIRED', 'UID path probe is outside one admitted full snapshot');
          }
          return state.uidPathProbe.probe(input);
        },
      }),
    });
    const entry = Object.freeze({
      admission,
      fileJournal,
      l2,
      manuscriptStore,
      roots,
      state,
    });
    entries.set(uid, entry);
    return entry;
  }

  async function capture(entry) {
    await ensureRecovered(entry);
    const projection = databasePort.captureProjection(entry.admission);
    const generation = projection.currentProjection.basis.baseGeneration;
    const validationLedger = new IgnoredIdentityLedger().toValidationEntries(
      projection.ignoredLedger,
      generation,
    );
    const fileSnapshot = await entry.manuscriptStore.validateFull(
      entry.roots.projectBinding,
      Object.freeze({
        ignoredLedger: validationLedger,
        lifecycleBasis: activeLifecycleBasis(projection.currentProjection.basis),
      }),
    );
    const candidate = await entry.manuscriptStore.buildProjectionCandidate(fileSnapshot);
    return Object.freeze({
      admission: entry.admission,
      candidate,
      currentProjection: projection.currentProjection,
      fileSnapshot,
      ignoredLedger: projection.ignoredLedger,
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
      || request.kind === 'chapter.replace_body_and_sidecar';
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

  async function ensureRecovered(entry, force = false) {
    if (!force && entry.state.recovered) {
      return Object.freeze({ status: 'clean' });
    }
    if (entry.state.recoveryPromise !== null) return entry.state.recoveryPromise;
    const recoveryPromise = databasePort.withWriterTurn(entry.admission, async (turn) => {
      entry.state.activeTurn = turn;
      try {
        await entry.fileJournal.recoverPendingOrdinary();
        return await databasePort.recover(entry.admission);
      } finally {
        entry.state.activeTurn = null;
      }
    });
    entry.state.recoveryPromise = recoveryPromise;
    try {
      const result = await recoveryPromise;
      entry.state.recovered = true;
      return result;
    } catch (cause) {
      entry.state.recovered = false;
      throw cause;
    } finally {
      if (entry.state.recoveryPromise === recoveryPromise) {
        entry.state.recoveryPromise = null;
      }
    }
  }

  async function snapshotFor(admission, request) {
    const cached = requestSnapshots.get(request);
    if (cached !== undefined) return cached;
    const snapshot = await capture(entryFor(admission));
    requestSnapshots.set(request, snapshot);
    return snapshot;
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

  async function resolveCommand(admission, command) {
    const snapshot = await snapshotFor(admission, command);
    const uid = projectUid(admission);
    if (command.kind === 'chapter.replace_body') {
      const chapter = resolveChapter(snapshot, command);
      return Object.freeze({ kind: command.kind, bodyRef: bodyRef(uid, chapter.chapter_uid), content: command.content });
    }
    if (command.kind === 'chapter.patch_sidecar') {
      const chapter = resolveChapter(snapshot, command);
      return Object.freeze({ kind: command.kind, sidecarRef: sidecarRef(uid, chapter.chapter_uid), patch: command.patch });
    }
    if (command.kind === 'chapter.replace_body_and_sidecar') {
      const chapter = resolveChapter(snapshot, command);
      return Object.freeze({
        kind: command.kind,
        bodyRef: bodyRef(uid, chapter.chapter_uid),
        sidecarRef: sidecarRef(uid, chapter.chapter_uid),
        content: command.content,
        patch: command.patch,
      });
    }
    if (command.kind === 'volume.patch_metadata') {
      const volume = resolveVolume(snapshot, command);
      return Object.freeze({ kind: command.kind, volumeRef: volumeRef(uid, volume.volume_uid), patch: command.patch });
    }
    if (command.kind === 'volume.create') {
      return Object.freeze({
        kind: command.kind,
        title: command.title,
        summary: command.summary ?? '',
      });
    }
    if (command.kind === 'chapter.create') {
      const containerVolumeUid = command.containerVolumeId === null
        ? null
        : resolveVolume(snapshot, command, 'containerVolumeId').volume_uid;
      const sidecar = command.sidecar ?? {};
      return Object.freeze({
        kind: command.kind,
        containerVolumeUid,
        requestedNum: command.requestedNum ?? null,
        content: command.content ?? '',
        sidecar: Object.freeze({
          title: sidecar.title ?? '',
          outline: sidecar.outline ?? '',
          status: sidecar.status ?? 'pending',
          summary: sidecar.summary ?? '',
          cognitive_frame: sidecar.cognitive_frame ?? '',
          emotional_anchor: sidecar.emotional_anchor ?? '',
          world_texture: sidecar.world_texture ?? '',
          concrete_mystery: sidecar.concrete_mystery ?? '',
          interpersonal_tension: sidecar.interpersonal_tension ?? '',
        }),
      });
    }
    if (command.kind === 'chapter.delete') {
      return Object.freeze({ kind: command.kind, chapterUid: resolveChapter(snapshot, command).chapter_uid });
    }
    if (command.kind === 'volume.delete') {
      return Object.freeze({ kind: command.kind, volumeUid: resolveVolume(snapshot, command).volume_uid });
    }
    if (command.kind === 'chapter.move') {
      const chapter = resolveChapter(snapshot, command);
      const targetVolumeUid = command.targetVolumeId === null
        ? null
        : resolveVolume(snapshot, command, 'targetVolumeId').volume_uid;
      return Object.freeze({
        kind: command.kind,
        chapterUid: chapter.chapter_uid,
        targetVolumeUid,
        targetPosition: command.targetPosition,
      });
    }
    if (command.kind === 'chapter.reorder') {
      const containerVolumeUid = command.containerVolumeId === null
        ? null
        : resolveVolume(snapshot, command, 'containerVolumeId').volume_uid;
      const chapterUids = Object.freeze(command.chapterIds.map((chapterId) => (
        resolveChapter(snapshot, { chapterId }).chapter_uid
      )));
      return Object.freeze({ kind: command.kind, containerVolumeUid, chapterUids });
    }
    if (command.kind === 'volume.reorder') {
      return Object.freeze({
        kind: command.kind,
        volumeUids: Object.freeze(command.volumeIds.map((volumeId) => (
          resolveVolume(snapshot, { volumeId }).volume_uid
        ))),
      });
    }
    throw productionError('RECOVERY_REQUIRED', 'Activated files command needs the pending production creation adapter');
  }

  return Object.freeze({
    prime() {
      for (const admission of databasePort.listFilesAdmissions()) entryFor(admission);
    },
    async read(admission, request) {
      const snapshot = await snapshotFor(admission, request);
      if (request.kind === 'chapter') return resolveChapter(snapshot, request);
      if (request.kind === 'chapters') return Object.freeze(chapterRows(snapshot));
      if (request.kind === 'volumes') return Object.freeze(volumeRows(snapshot));
      if (request.kind === 'volume') return resolveVolume(snapshot, request);
      if (request.kind === 'project') return Object.freeze({
        project_uid: projectUid(admission),
        projection_generation: snapshot.currentProjection.basis.baseGeneration,
      });
      throw productionError('INVALID_PARAMS', 'Files read kind is unsupported');
    },
    async snapshotWitness(admission, request) {
      return witnessFor(await snapshotFor(admission, request), request);
    },
    resolveCommand,
    async write(admission, request) {
      const entry = entryFor(admission);
      await ensureRecovered(entry);
      return databasePort.withWriterTurn(admission, async (turn) => {
        entry.state.activeTurn = turn;
        try {
          const snapshot = await capture(entry);
          const currentWitness = witnessFor(snapshot, request.witnessCommand);
          if (!sameWitness(currentWitness, request.baseWitness)) {
            throw productionError('EXTERNAL_DRAFT_CONFLICT', 'The files changed before the writer turn');
          }
          if (request.command.kind === 'chapter.create' || request.command.kind === 'volume.create') {
            entry.state.uidPathProbe = entry.manuscriptStore.createUidPathProbe(
              snapshot.fileSnapshot,
            );
          }
          const intent = entry.l2.bindWriteIntent(request.command);
          try {
            return await entry.l2.execute(intent, Object.freeze({
              journalId: randomUUID(),
              logicalRequestId: request.requestId,
              projectedAt: new Date().toISOString(),
              currentProjection: snapshot.currentProjection,
              fileSnapshot: snapshot.fileSnapshot,
              ignoredLedger: snapshot.ignoredLedger,
            }));
          } catch (cause) {
            entry.state.recovered = false;
            throw cause;
          }
        } finally {
          entry.state.uidPathProbe = null;
          entry.state.activeTurn = null;
        }
      });
    },
    recover(admission) { return ensureRecovered(entryFor(admission), true); },
    close() {
      if (closed) return;
      closed = true;
      entries.clear();
      databasePort.close();
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
  const fileBoundary = createProductionManuscriptFileBoundary();
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
  files.prime();
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
    files,
    creation,
    migration,
  });
}

module.exports = { createProductionManuscriptRuntime };
