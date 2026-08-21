'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { openControlStore } = require('../control-store');
const { FilePublicationJournal } = require('./file-publication-journal');
const { FilePublisher } = require('./file-publisher');
const { ProjectCreationJournal, ProjectCreationFilePublicationParentAuthority } = require(
  './project-creation-journal'
);
const { ProjectCreationService } = require('./project-creation-service');
const { SQLiteProjectionStore } = require('./projection-store');
const {
  createCreationDirectoryPlan,
  createProjectRootProbe,
  ensureCreationDirectories,
} = require('./production-project-roots');
const { ProjectCreationRouteStore } = require('./route-store');
const { ManuscriptStore } = require('./store');
const { ManuscriptUidReservation } = require('./uid-reservation');

function recoveryRequired(message) {
  const error = new Error(message);
  error.code = 'RECOVERY_REQUIRED';
  throw error;
}

function creationDisposition() {
  return Object.freeze({
    classify(evidence) {
      if (evidence?.disposition === 'after' || evidence?.state === 'files_published') return 'after';
      if (evidence?.disposition === 'before') return 'before';
      return 'unknown';
    },
    inspect() { recoveryRequired('Creation disposition requires explicit durable evidence'); },
  });
}

function createProductionCreationAdapter({
  dataRoot,
  projectsDir,
  databasePort,
  fileBoundary,
  uidCatalog,
}) {
  return Object.freeze({
    async create(input) {
      const durableReservation = await uidCatalog.reservationSources.lookupCreation({
        logicalRequestId: input.requestId,
      });
      const projectInstanceId = durableReservation?.projectInstanceId ?? randomUUID();
      const childJournalId = randomUUID();
      const state = {
        childJournal: null,
        directoryPlan: null,
        journal: null,
        manuscriptStore: null,
      };
      const rootProbe = createProjectRootProbe({
        dataRoot,
        projectsDir,
        projectName: input.projectMetadata.name,
      });
      const uidReservations = new ManuscriptUidReservation({
        reservationSources: uidCatalog.reservationSources,
        uuidV4: randomUUID,
      });
      const disposition = creationDisposition();

      function requireJournal() {
        if (state.journal === null) recoveryRequired('Creation journal is not open');
        return state.journal;
      }

      function requireChildJournal() {
        if (state.childJournal === null) recoveryRequired('Creation child journal is not ready');
        return state.childJournal;
      }

      function requireStore() {
        if (state.manuscriptStore === null) recoveryRequired('Creation manuscript store is not ready');
        return state.manuscriptStore;
      }

      const service = new ProjectCreationService({
        uidReservations,
        journals: Object.freeze({
          open(creationReservation) {
            if (state.journal !== null) {
              if (state.journal.read()?.creationId !== creationReservation.creationId) {
                recoveryRequired('Creation request tried to switch journals');
              }
              return state.journal;
            }
            const creationId = creationReservation.creationId;
            state.journal = new ProjectCreationJournal({
              childDisposition: disposition,
              clock: Date.now,
              controlStore: openControlStore(path.join(
                dataRoot,
                'control',
                'project-creation',
                creationId,
              )),
              creationId,
              dataRoot,
              databaseDisposition: disposition,
            });
            return state.journal;
          },
        }),
        directories: Object.freeze({
          plan({ creationReservation }) {
            state.directoryPlan = createCreationDirectoryPlan({
              dataRoot,
              projectsDir,
              projectName: input.projectMetadata.name,
              creationReservation,
            });
            return state.directoryPlan;
          },
          async ensure({ creationReservation, directoryPlan }) {
            if (directoryPlan !== state.directoryPlan) {
              recoveryRequired('Creation directory plan lost object identity');
            }
            const roots = ensureCreationDirectories({
              dataRoot,
              directoryPlan,
              projectUid: creationReservation.projectReservation.uid,
            });
            const controlStore = openControlStore(directoryPlan.projectControlRoot);
            const projectBinding = Object.freeze({
              articleRootIdentity: roots.projectBinding.articleRootIdentity,
              controlIncarnationId: controlStore.incarnationId,
              dataRoot,
              projectUid: creationReservation.projectReservation.uid,
              projectInstanceId: creationReservation.projectInstanceId,
              recoveryRootIdentity: Object.freeze((() => {
                const stats = fs.lstatSync(directoryPlan.fileAssetsRoot, { bigint: true });
                return { dev: String(stats.dev), ino: String(stats.ino) };
              })()),
            });
            const projectionStore = new SQLiteProjectionStore();
            const parentAuthority = new ProjectCreationFilePublicationParentAuthority(
              requireJournal(),
            );
            state.childJournal = new FilePublicationJournal({
              controlStore,
              filePublisher: new FilePublisher({
                writerCapability: fileBoundary.writerCapability,
              }),
              projectionStore,
              projectStore: Object.freeze({
                publishProjectionTarget() {
                  recoveryRequired('Creation child journal may not publish SQLite projection directly');
                },
              }),
              projectionDisposition: Object.freeze({
                inspectTarget() {
                  recoveryRequired('Creation child projection is installed only by creation activation');
                },
              }),
              parentAuthority,
              projectBinding,
              assertWriteAuthority() {
                const view = requireJournal().read();
                if (
                  fs.existsSync(directoryPlan.finalDatabasePath)
                  || !['project_control_ready', 'file_publication_started', 'files_published']
                    .includes(view?.state)
                ) recoveryRequired('Creation child write is outside its durable parent state');
              },
            });
            uidCatalog.registerOrdinary(
              creationReservation.projectReservation.uid,
              state.childJournal.reservationSource(),
            );
            state.manuscriptStore = new ManuscriptStore({
              dataRoot,
              fileBoundary: fileBoundary.readCapability,
              journalAuthority: state.childJournal.journalAuthority(),
            });
            return state.manuscriptStore.enumerateAndClassify(roots.projectBinding);
          },
        }),
        store: Object.freeze({
          buildClosure(...args) { return requireStore().buildClosure(...args); },
          finalizeCandidate(...args) { return requireStore().finalizeCandidate(...args); },
        }),
        projection: new SQLiteProjectionStore(),
        childJournal: Object.freeze({
          stageAssets(...args) { return requireChildJournal().stageAssets(...args); },
          bindTarget(...args) { return requireChildJournal().bindTarget(...args); },
          prepare(...args) { return requireChildJournal().prepare(...args); },
          publishFiles(...args) { return requireChildJournal().publishFiles(...args); },
        }),
        database: Object.freeze({
          build(candidateInput) { return databasePort.buildCreationCandidate(candidateInput); },
          activate(activationInput) { return databasePort.activateCreation(activationInput); },
        }),
        route: Object.freeze({
          prepareAbsentInstall(context) {
            return new ProjectCreationRouteStore({
              journalAuthority: requireJournal().authority(),
            }).prepareAbsentInstall(context);
          },
        }),
      });
      return service.create(Object.freeze({
        childJournalId,
        logicalRequestId: input.requestId,
        projectInstanceId,
        projectMetadata: input.projectMetadata,
        projectRootProbe: rootProbe,
        projectedAt: new Date().toISOString(),
      }));
    },
  });
}

module.exports = { createProductionCreationAdapter };
