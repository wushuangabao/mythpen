import { projectsApi } from './api.ts'
import {
  cancelAndDrainEditorHostQueues,
  freezeEditorHostMigrationState,
  getEditorHostMigrationState,
  releaseEditorHostQueueDrain,
} from './editorSaveQueue.ts'
import { freezeManuscriptSaveAdmission, releaseManuscriptSaveAdmission } from './manuscriptHostSaveAdmission.ts'
import { createManuscriptProductionHostState } from './manuscriptProductionHostState.ts'
import { HostMigrationPreflightCoordinator } from './manuscriptWindowCoordinator.ts'
import {
  cancelAndDrainTitleHostQueues,
  freezeTitleHostMigrationState,
  getTitleHostMigrationState,
  releaseTitleHostQueueDrain,
} from './titleSaveQueue.ts'

export type ProductionMigrationPreflight = Readonly<{
  snapshotId: string
  projectName: string
  projectInstanceId: string
  canMigrate: boolean
  bodyDrafts: number
  titleDrafts: number
  volumeMetadataDrafts: number
  structureDrafts: number
  unloadedQueues: number
}>

const productionHost = createManuscriptProductionHostState()
const projectNamesByInstance = new Map<string, string>()
const activePreflights = new Map<string, ProductionMigrationPreflight>()

function projectName(projectInstanceId: string): string {
  const name = projectNamesByInstance.get(projectInstanceId)
  if (!name) throw new TypeError('project instance is not bound to migration host state')
  return name
}

productionHost.registerWindow(
  Object.freeze({
    windowId: 'main',
    freeze(projectInstanceId: string) {
      const name = projectName(projectInstanceId)
      freezeManuscriptSaveAdmission(name, projectInstanceId)
      freezeEditorHostMigrationState(name)
      freezeTitleHostMigrationState(name)
      return true
    },
    describe(projectInstanceId: string) {
      const name = projectName(projectInstanceId)
      const editor = getEditorHostMigrationState(name)
      const title = getTitleHostMigrationState(name)
      const dirtyResources = Object.freeze([...editor.resources, ...title.resources])
      const saveQueues = Object.freeze([...editor.queues, ...title.queues])
      const windowRevision = [...dirtyResources, ...saveQueues].reduce(
        (highest, entry) => Math.max(highest, entry.revision),
        0,
      )
      return Object.freeze({
        projectName: name,
        projectInstanceId,
        windowRevision,
        dirtyResources,
        saveQueues,
      })
    },
    async cancelAndDrain(projectInstanceId: string) {
      const name = projectName(projectInstanceId)
      const editor = await cancelAndDrainEditorHostQueues(name)
      const title = await cancelAndDrainTitleHostQueues(name)
      return Object.freeze([...editor, ...title])
    },
    release(projectInstanceId: string) {
      const name = projectName(projectInstanceId)
      releaseEditorHostQueueDrain(name)
      releaseTitleHostQueueDrain(name)
      releaseManuscriptSaveAdmission(name, projectInstanceId)
    },
  }),
)

const coordinator = new HostMigrationPreflightCoordinator({
  hostState: productionHost.hostState,
  migrationApi: Object.freeze({
    beginMigration(request) {
      const description = request as unknown as Readonly<{ projectName: string }>
      return projectsApi.migrateFilesBeta(description.projectName)
    },
  }),
  uuidV4() {
    return globalThis.crypto.randomUUID()
  },
})

function summarize(snapshot: Awaited<ReturnType<typeof coordinator.freezeAllWindows>>): ProductionMigrationPreflight {
  const resources = snapshot.resources
  const preflight = Object.freeze({
    snapshotId: snapshot.snapshotId,
    projectName: snapshot.projectName,
    projectInstanceId: snapshot.projectInstanceId,
    canMigrate: coordinator.canConfirm(snapshot.snapshotId),
    bodyDrafts: resources.filter((entry) => entry.domain === 'body').length,
    titleDrafts: resources.filter((entry) => entry.domain === 'sidecar').length,
    volumeMetadataDrafts: resources.filter((entry) => entry.domain === 'volume_metadata').length,
    structureDrafts: resources.filter((entry) => entry.domain === 'structure').length,
    unloadedQueues: resources.filter((entry) => entry.loaded === false).length,
  })
  activePreflights.set(preflight.snapshotId, preflight)
  return preflight
}

export const productionManuscriptMigration = Object.freeze({
  async beginPreflight(input: Readonly<{ projectName: string; projectInstanceId: string }>) {
    if (!input.projectName || !input.projectInstanceId) throw new TypeError('migration project binding is incomplete')
    projectNamesByInstance.set(input.projectInstanceId, input.projectName)
    const snapshot = await coordinator.freezeAllWindows(input.projectInstanceId)
    await coordinator.cancelAndDrainSaveQueues(snapshot)
    return summarize(snapshot)
  },
  async confirm(preflight: ProductionMigrationPreflight) {
    const active = activePreflights.get(preflight.snapshotId)
    if (active !== preflight) throw new TypeError('migration preflight is foreign or inactive')
    activePreflights.delete(preflight.snapshotId)
    try {
      return await coordinator.confirmAndBeginMigration(preflight.snapshotId, {
        projectName: preflight.projectName,
      })
    } finally {
      projectNamesByInstance.delete(preflight.projectInstanceId)
    }
  },
  async cancel(preflight: ProductionMigrationPreflight) {
    const active = activePreflights.get(preflight.snapshotId)
    if (active !== preflight) return
    activePreflights.delete(preflight.snapshotId)
    try {
      await coordinator.cancel(preflight.snapshotId)
    } finally {
      projectNamesByInstance.delete(preflight.projectInstanceId)
    }
  },
})
