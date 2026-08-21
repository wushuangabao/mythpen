'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { inspectControlStoreEvidence, openControlStore } = require('../control-store');
const { FilePublicationJournal } = require('./file-publication-journal');
const { FilePublisher } = require('./file-publisher');
const {
  MigrationFilePublicationParentAuthority,
  MigrationJournal,
} = require('./migration-journal');
const { MigrationService } = require('./migration-service');
const { SQLiteProjectionStore } = require('./projection-store');
const {
  createCreationDirectoryPlan,
  createProjectRootProbe,
  ensureCreationDirectories,
  openActivatedProjectRoot,
} = require('./production-project-roots');
const { ManuscriptRouteStore } = require('./route-store');
const { ManuscriptStore } = require('./store');
const { ManuscriptUidReservation } = require('./uid-reservation');

function recoveryError(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'RECOVERY_REQUIRED';
  return error;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function physicalIdentity(targetPath) {
  const stats = fs.lstatSync(targetPath, { bigint: true });
  return Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
}

function derivedUuid(label, material) {
  const bytes = createHash('sha256').update(`${label}\0${material}`, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function directoryNames(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function findExistingMigration(dataRoot, migrationId) {
  const root = path.join(dataRoot, 'control', 'manuscripts');
  const found = [];
  for (const projectUid of directoryNames(root)) {
    for (const projectInstanceId of directoryNames(path.join(root, projectUid))) {
      const controlDirectory = path.join(root, projectUid, projectInstanceId);
      const events = inspectControlStoreEvidence(controlDirectory).events;
      const history = events.filter((event) => (
        typeof event?.type === 'string'
        && event.type.startsWith('migration.')
        && event.payload?.migrationId === migrationId
      ));
      if (history.length === 0) continue;
      const sourceEvent = history.find((event) => event.type === 'migration.source_snapshot_ready');
      const fenceEvent = events.find((event) => (
        event.type === 'manuscript.migration.route_fenced'
        && event.payload?.migrationId === migrationId
      ));
      found.push(Object.freeze({
        controlDirectory,
        directoryPlan: fenceEvent?.payload?.directoryPlan ?? null,
        projectInstanceId,
        projectUid,
        sourceSnapshot: sourceEvent?.payload?.data?.sourceSnapshot ?? null,
      }));
    }
  }
  if (found.length > 1) throw recoveryError('Migration ID is present in multiple control roots');
  return found[0] ?? null;
}

function sourceFromDurableSnapshot(projectName, snapshot) {
  return deepFreeze({
    projectInstanceId: snapshot.projectInstanceId,
    projectName,
    sourceBasis: snapshot.currentProjection.basis,
    sourceIdentity: snapshot.sourceIdentity,
    sourcePath: snapshot.sourcePath,
    sourceSha256: snapshot.sourceSha256,
    projectedAt: snapshot.projectedAt,
    volumes: snapshot.volumes,
    chapters: snapshot.chapters,
  });
}

function eventChildState(controlStore, childJournalId) {
  const events = controlStore.read().filter((event) => (
    typeof event?.type === 'string'
    && event.type.startsWith('manuscript.file_publication.')
    && event.payload?.journalId === childJournalId
  ));
  return events.at(-1)?.type.slice('manuscript.file_publication.'.length) ?? null;
}

function createProductionMigrationAdapter({
  dataRoot,
  projectsDir,
  databasePort,
  fileBoundary,
  uidCatalog,
}) {
  return Object.freeze({
    async migrate(input) {
      const projectName = input.projectSelector?.projectName;
      if (typeof projectName !== 'string' || projectName.length === 0) {
        throw new TypeError('Explicit files-Beta migration requires projectSelector.projectName');
      }
      const operationMaterial = JSON.stringify({ projectName, requestId: input.requestId });
      const migrationId = derivedUuid('mythpen.files-beta.migration', operationMaterial);
      const childJournalId = derivedUuid('mythpen.files-beta.migration-child', operationMaterial);
      const existing = findExistingMigration(dataRoot, migrationId);
      const state = {
        childJournal: null,
        controlStore: null,
        directoryPlan: existing?.directoryPlan ?? null,
        journal: null,
        manuscriptStore: null,
        projectedAt: existing?.sourceSnapshot?.projectedAt ?? new Date().toISOString(),
        source: existing?.sourceSnapshot === null || existing === null
          ? databasePort.captureMigrationSource(projectName)
          : sourceFromDurableSnapshot(projectName, existing.sourceSnapshot),
      };

      function classifyEvidence(evidence) {
        if (evidence?.disposition === 'after' || evidence?.state === 'files_published') return 'after';
        if (evidence?.disposition === 'before') return 'before';
        return 'unknown';
      }

      function requireJournal() {
        if (state.journal === null) throw recoveryError('Migration journal is not open');
        return state.journal;
      }

      function requireControlStore() {
        if (state.controlStore === null) throw recoveryError('Migration ControlStore is not open');
        return state.controlStore;
      }

      function bindingFrom(projectUid, projectInstanceId) {
        const controlStore = openControlStore(path.join(
          dataRoot,
          'control',
          'manuscripts',
          projectUid,
          projectInstanceId,
        ));
        return Object.freeze({
          controlStore,
          projectBinding: Object.freeze({
            controlIncarnationId: controlStore.incarnationId,
            dataRoot,
            projectUid,
            projectInstanceId,
          }),
        });
      }

      const routeDisposition = Object.freeze({
        classify: classifyEvidence,
        inspect(context) {
          const reservation = context.reservation;
          const binding = {
            migrationId: context.migrationId,
            projectUid: reservation.projectUid,
            projectInstanceId: reservation.projectInstanceId,
            source: state.source,
          };
          if (context.state === 'migration_reserved') {
            return databasePort.inspectMigrationRouteFence(binding);
          }
          if (context.state === 'activation_intent') {
            return databasePort.inspectMigrationActivation({
              migrationId: context.migrationId,
              projectUid: reservation.projectUid,
              projectInstanceId: reservation.projectInstanceId,
              sourcePath: state.source.sourcePath,
              targetGeneration: reservation.targetGeneration,
            });
          }
          return Object.freeze({ disposition: 'after' });
        },
      });

      const databaseDisposition = Object.freeze({
        classify: classifyEvidence,
        inspect(context) {
          const reservation = context.reservation;
          return databasePort.inspectMigrationActivation({
            migrationId: context.migrationId,
            projectUid: reservation.projectUid,
            projectInstanceId: reservation.projectInstanceId,
            sourcePath: state.source.sourcePath,
            targetGeneration: reservation.targetGeneration,
          });
        },
      });

      const cleanupDisposition = Object.freeze({
        classify: classifyEvidence,
        inspect() { throw recoveryError('Automatic migration cleanup is outside the fast Beta'); },
      });

      function ensureChildJournal(projectUid, projectInstanceId) {
        if (state.childJournal !== null) return state.childJournal;
        const binding = bindingFrom(projectUid, projectInstanceId);
        state.controlStore = state.controlStore ?? binding.controlStore;
        const roots = openActivatedProjectRoot({ dataRoot, projectUid });
        const fileAssetsRoot = path.join(requireControlStore().directory, 'file-assets');
        const projectionStore = new SQLiteProjectionStore();
        state.childJournal = new FilePublicationJournal({
          controlStore: requireControlStore(),
          filePublisher: new FilePublisher({ writerCapability: fileBoundary.writerCapability }),
          projectionStore,
          projectStore: Object.freeze({
            publishProjectionTarget() {
              throw recoveryError('Migration child journal may not publish SQLite projection directly');
            },
          }),
          projectionDisposition: Object.freeze({
            inspectTarget() {
              throw recoveryError('Migration child projection is installed only by database activation');
            },
          }),
          parentAuthority: new MigrationFilePublicationParentAuthority(requireJournal()),
          projectBinding: Object.freeze({
            ...binding.projectBinding,
            articleRootIdentity: roots.projectBinding.articleRootIdentity,
            recoveryRootIdentity: physicalIdentity(fileAssetsRoot),
          }),
          assertWriteAuthority() {
            const view = requireJournal().read(migrationId);
            if (!['files_candidate_ready', 'file_publication_started', 'files_published'].includes(view.state)) {
              throw recoveryError('Migration child write is outside its durable parent state');
            }
            databasePort.verifyMigrationSource(state.source);
          },
        });
        uidCatalog.registerOrdinary(state.childJournal.reservationSource());
        state.manuscriptStore = new ManuscriptStore({
          dataRoot,
          fileBoundary: fileBoundary.readCapability,
          journalAuthority: state.childJournal.journalAuthority(),
        });
        state.roots = roots;
        return state.childJournal;
      }

      const childDisposition = Object.freeze({
        classify: classifyEvidence,
        async inspect(context) {
          const candidate = context.aggregate.history.find((event) => (
            event.state === 'files_candidate_ready'
          ));
          const childId = candidate?.data?.childJournalId;
          if (typeof childId !== 'string') return Object.freeze({ disposition: 'unknown' });
          const reservation = context.reservation;
          const child = ensureChildJournal(reservation.projectUid, reservation.projectInstanceId);
          if (eventChildState(requireControlStore(), childId) !== 'files_published') {
            return Object.freeze({ disposition: 'unknown' });
          }
          const verified = await child.publishFiles(childId);
          return Object.freeze({
            disposition: verified.state === 'files_published' ? 'after' : 'unknown',
          });
        },
      });

      function openJournal(projectUid, projectInstanceId) {
        if (state.journal !== null) return state.journal;
        const binding = bindingFrom(projectUid, projectInstanceId);
        state.controlStore = binding.controlStore;
        state.journal = new MigrationJournal({
          childDisposition,
          cleanupDisposition,
          clock: Date.now,
          controlStore: state.controlStore,
          databaseDisposition,
          projectBinding: binding.projectBinding,
          routeDisposition,
        });
        return state.journal;
      }

      if (existing !== null) openJournal(existing.projectUid, existing.projectInstanceId);

      const lazyAuthority = Object.freeze({
        readObservation(...args) { return requireJournal().authority().readObservation(...args); },
        describeObservation(...args) { return requireJournal().authority().describeObservation(...args); },
        assertTransitionAllowed(...args) { return requireJournal().authority().assertTransitionAllowed(...args); },
        assertMigrationContext(...args) { return requireJournal().authority().assertMigrationContext(...args); },
        readMigrationReserved(id) {
          return state.journal === null ? null : state.journal.authority().readMigrationReserved(id);
        },
        describeMigrationReserved(...args) {
          return requireJournal().authority().describeMigrationReserved(...args);
        },
      });

      const journalFacade = Object.freeze({
        authority() { return lazyAuthority; },
        read(id) {
          if (state.journal === null) {
            const error = recoveryError('migration journal does not exist');
            error.details = { reason: 'migration journal does not exist', migrationId: id };
            throw error;
          }
          return state.journal.read(id);
        },
        reserve(reservation) {
          if (state.journal === null) {
            openJournal(
              reservation.migrationReservation.projectReservation.uid,
              reservation.migrationReservation.projectInstanceId,
            );
          }
          return state.journal.reserve(reservation);
        },
        recordRouteFenced(...args) { return requireJournal().recordRouteFenced(...args); },
        recordSourceSnapshot(...args) { return requireJournal().recordSourceSnapshot(...args); },
        recordFilesCandidate(...args) { return requireJournal().recordFilesCandidate(...args); },
        recordFilePublicationStarted(...args) {
          return requireJournal().recordFilePublicationStarted(...args);
        },
        recordFilesPublished(...args) { return requireJournal().recordFilesPublished(...args); },
        recordDatabaseCandidate(...args) { return requireJournal().recordDatabaseCandidate(...args); },
        beginActivation(...args) { return requireJournal().beginActivation(...args); },
        prepareMigrationContext(...args) { return requireJournal().prepareMigrationContext(...args); },
        recordActivated(...args) { return requireJournal().recordActivated(...args); },
        recover(...args) { return requireJournal().recover(...args); },
      });

      const rootProbe = createProjectRootProbe({ dataRoot, projectsDir, projectName });
      const uidReservations = new ManuscriptUidReservation({
        journalAuthority: lazyAuthority,
        reservationSources: uidCatalog.reservationSources,
        uuidV4: randomUUID,
      });
      const service = new MigrationService({
        journal: journalFacade,
        uidReservations,
        route: Object.freeze({
          abort() { throw recoveryError('Automatic migration rollback is outside the fast Beta'); },
          fence({ migrationId: id, observation, directoryPlan }) {
            lazyAuthority.assertTransitionAllowed(
              observation,
              Object.freeze({ expected: 'sqlite', next: 'migrating' }),
            );
            const selected = rootProbe.selected();
            return databasePort.fenceMigrationSource({
              directoryPlan,
              migrationId: id,
              projectInstanceId: selected.projectInstanceId,
              projectUid: selected.projectUid,
              source: state.source,
            });
          },
          activate({ migrationContext, databaseCandidate }) {
            const { Database } = require('bun:sqlite');
            const candidate = new Database(databaseCandidate.candidatePath, {
              create: false,
              readonly: true,
              strict: true,
            });
            try {
              const routeCas = new ManuscriptRouteStore({ journalAuthority: lazyAuthority })
                .prepareCompareAndSwap(Object.freeze({
                  identity: databaseCandidate.candidateIdentity,
                  prepare(sql) { return candidate.query(sql); },
                }), 'migrating', 'files', migrationContext);
              return Object.freeze({ disposition: 'after', routeCas });
            } finally {
              candidate.clearQueryCache();
              Bun.gc(true);
              candidate.close(true);
            }
          },
        }),
        directories: Object.freeze({
          plan({ migrationId: id }) {
            const selected = rootProbe.selected();
            if (selected.operationId !== id) throw recoveryError('Migration root probe binding changed');
            state.directoryPlan = createCreationDirectoryPlan({
              dataRoot,
              projectsDir,
              projectName,
              creationReservation: Object.freeze({
                projectInstanceId: selected.projectInstanceId,
                projectReservation: Object.freeze({ uid: selected.projectUid }),
              }),
            });
            return state.directoryPlan;
          },
          async ensure({ directoryPlan }) {
            if (directoryPlan !== state.directoryPlan) {
              throw recoveryError('Migration directory plan lost object identity');
            }
            const selected = rootProbe.selected();
            ensureCreationDirectories({
              dataRoot,
              directoryPlan,
              projectUid: selected.projectUid,
            });
            ensureChildJournal(selected.projectUid, selected.projectInstanceId);
            return state.manuscriptStore.enumerateAndClassify(state.roots.projectBinding);
          },
          cleanup() { throw recoveryError('Automatic migration cleanup is outside the fast Beta'); },
        }),
        source: Object.freeze({
          capture({ sourceBasis, migrationReservation, readOnly }) {
            if (
              readOnly !== true
              || sourceBasis !== state.source.sourceBasis
              || migrationReservation.projectInstanceId !== state.source.projectInstanceId
            ) throw recoveryError('Migration source capture binding changed');
            databasePort.verifyMigrationSource(state.source);
            const projectUid = migrationReservation.projectReservation.uid;
            return deepFreeze({
              domain: 'mythpen.manuscript.schema11-source-snapshot',
              version: 1,
              projectUid,
              projectInstanceId: state.source.projectInstanceId,
              sourceBasisDigest: state.source.sourceBasis.basisDigest,
              sourcePath: state.source.sourcePath,
              sourceIdentity: state.source.sourceIdentity,
              sourceSha256: state.source.sourceSha256,
              readOnly: true,
              projectedAt: state.projectedAt,
              currentProjection: {
                projectUid,
                projectInstanceId: state.source.projectInstanceId,
                basis: state.source.sourceBasis,
              },
              ignoredLedger: [],
              volumes: state.source.volumes,
              chapters: state.source.chapters,
            });
          },
        }),
        store: Object.freeze({
          buildClosure(...args) {
            if (state.manuscriptStore === null) throw recoveryError('Migration ManuscriptStore is not ready');
            return state.manuscriptStore.buildClosure(...args);
          },
          finalizeCandidate(...args) {
            if (state.manuscriptStore === null) throw recoveryError('Migration ManuscriptStore is not ready');
            return state.manuscriptStore.finalizeCandidate(...args);
          },
        }),
        projection: new SQLiteProjectionStore(),
        childJournal: Object.freeze({
          stageAssets(...args) { return state.childJournal.stageAssets(...args); },
          bindTarget(...args) { return state.childJournal.bindTarget(...args); },
          prepare(...args) { return state.childJournal.prepare(...args); },
          publishFiles(...args) { return state.childJournal.publishFiles(...args); },
        }),
        database: Object.freeze({
          build(candidateInput) { return databasePort.buildMigrationCandidate(candidateInput); },
          activate(activationInput) {
            return databasePort.activateMigration({
              ...activationInput,
              routeCas: activationInput.routeEvidence.routeCas,
            });
          },
        }),
      });

      return service.migrate(Object.freeze({
        baseGeneration: 0,
        childJournalId,
        logicalRequestId: input.requestId,
        migrationId,
        projectInstanceId: state.source.projectInstanceId,
        projectRootProbe: rootProbe,
        sourceBasis: state.source.sourceBasis,
        targetGeneration: 1,
      }));
    },
    async recover(input) {
      return this.migrate(input);
    },
  });
}

module.exports = { createProductionMigrationAdapter };
