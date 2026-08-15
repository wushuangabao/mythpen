import type { ProjectDiagnostics, ProjectOpenState, RecoveryAction } from '../types/index.ts'

const RECOVERY_ACTIONS = new Set<RecoveryAction>([
  'recover_transaction',
  'recover_v1_publication',
  'adopt_same_path_identity',
])

interface ProjectOpenInput {
  openState?: unknown
  reasonCode?: unknown
  recommendedAction?: unknown
}

export interface NormalizedProjectOpenFields {
  openState: ProjectOpenState
  reasonCode: string | null
  recommendedAction: RecoveryAction | null
}

export interface RecoveryProjectSummary extends ProjectOpenInput {
  name: string
}

export function normalizeProjectOpenFields(project: ProjectOpenInput): NormalizedProjectOpenFields {
  if (project.openState === 'ready') {
    return { openState: 'ready', reasonCode: null, recommendedAction: null }
  }
  if (project.openState !== 'isolated') {
    return { openState: 'isolated', reasonCode: 'RECOVERY_REQUIRED', recommendedAction: null }
  }
  return {
    openState: 'isolated',
    reasonCode:
      typeof project.reasonCode === 'string' && project.reasonCode.trim() ? project.reasonCode : 'RECOVERY_REQUIRED',
    recommendedAction:
      typeof project.recommendedAction === 'string' && RECOVERY_ACTIONS.has(project.recommendedAction as RecoveryAction)
        ? (project.recommendedAction as RecoveryAction)
        : null,
  }
}

function isReadyProject(project: RecoveryProjectSummary | undefined): boolean {
  return !!project && normalizeProjectOpenFields(project).openState === 'ready'
}

export function chooseProjectAfterList(
  projects: readonly RecoveryProjectSummary[],
  selection: {
    savedProject: string | null
    currentProject: string | null
    recoveryTarget: string | null
  },
): string | null {
  if (selection.recoveryTarget) {
    return isReadyProject(projects.find((project) => project.name === selection.currentProject))
      ? selection.currentProject
      : null
  }
  const saved = projects.find((project) => project.name === selection.savedProject)
  if (isReadyProject(saved)) return saved?.name || null
  return projects.find((project) => isReadyProject(project))?.name || null
}

export type ProjectSelectionTransition =
  | {
      kind: 'ready'
      currentProject: string
      recoveryTarget: null
      activateWorkspace: true
    }
  | {
      kind: 'recovery'
      currentProject: string | null
      recoveryTarget: string
      activateWorkspace: false
    }

export function projectSelectionTransition(
  project: RecoveryProjectSummary,
  currentProject: string | null,
): ProjectSelectionTransition {
  if (isReadyProject(project)) {
    return {
      kind: 'ready',
      currentProject: project.name,
      recoveryTarget: null,
      activateWorkspace: true,
    }
  }
  return {
    kind: 'recovery',
    currentProject,
    recoveryTarget: project.name,
    activateWorkspace: false,
  }
}

export function selectReadyFallback(projects: readonly RecoveryProjectSummary[]): string | null {
  return projects.find((project) => isReadyProject(project))?.name || null
}

const REASON_I18N_KEYS: Readonly<Record<string, string>> = {
  V1_PUBLICATION_FORWARD_RECOVERABLE: 'recovery.reason.forwardRecoverable',
  V1_PUBLICATION_ROLLBACK_RECOVERABLE: 'recovery.reason.rollbackRecoverable',
  RECOVERY_REQUIRED: 'recovery.reason.recoveryRequired',
  PROJECT_SCHEMA_TOO_NEW: 'recovery.reason.schemaTooNew',
  PROJECT_DATABASE_NOT_PROJECT: 'recovery.reason.notProjectDatabase',
  PROJECT_IDENTITY_REBIND_REQUIRED: 'recovery.reason.identityRebind',
  DURABILITY_UNSUPPORTED: 'recovery.reason.durabilityUnsupported',
  STORAGE_UNAVAILABLE: 'recovery.reason.storageUnavailable',
  PROJECT_WRITE_BUSY: 'recovery.reason.busy',
  CONFIG_DATABASE_BUSY: 'recovery.reason.busy',
  RECOVERY_SNAPSHOT_STALE: 'recovery.reason.stale',
  NATIVE_ACTIVATION_DISABLED: 'recovery.reason.activationDisabled',
}

const ERROR_I18N_KEYS: Readonly<Record<string, string>> = {
  PROJECT_WRITE_BUSY: 'recovery.error.busy',
  CONFIG_DATABASE_BUSY: 'recovery.error.busy',
  RECOVERY_SNAPSHOT_STALE: 'recovery.error.stale',
  RECOVERY_REQUIRED: 'recovery.error.recoveryRequired',
  PROJECT_SCHEMA_TOO_NEW: 'recovery.error.schemaTooNew',
  PROJECT_DATABASE_NOT_PROJECT: 'recovery.error.notProjectDatabase',
  PROJECT_IDENTITY_REBIND_REQUIRED: 'recovery.error.identityRebind',
  DURABILITY_UNSUPPORTED: 'recovery.error.durabilityUnsupported',
  STORAGE_UNAVAILABLE: 'recovery.error.storageUnavailable',
  NATIVE_ACTIVATION_DISABLED: 'recovery.error.unavailable',
}

export function recoveryReasonI18nKey(reasonCode: string | null | undefined): string {
  return (reasonCode && REASON_I18N_KEYS[reasonCode]) || 'recovery.reason.generic'
}

export function recoveryErrorI18nKey(errorCode: string | null | undefined): string {
  return (errorCode && ERROR_I18N_KEYS[errorCode]) || 'recovery.error.generic'
}

export type RecoveryPending = 'refresh' | 'recover' | 'export' | null

export interface ProjectRecoveryState {
  diagnostics: ProjectDiagnostics | null
  pending: RecoveryPending
  errorCode: string | null
  exportedFilename: string | null
}

export interface ProjectRecoveryDependencies {
  getDiagnostics: (name: string) => Promise<ProjectDiagnostics>
  recoverDiagnostics: (name: string, action: RecoveryAction, snapshot: string) => Promise<ProjectDiagnostics>
  exportDiagnostics: (name: string) => Promise<{ filename: string }>
  refreshProjects: (isCurrent: () => boolean) => Promise<void>
  getProjects: () => readonly RecoveryProjectSummary[]
  enterReadyProject: (name: string) => void
}

export interface ProjectRecoveryController {
  getState: () => ProjectRecoveryState
  subscribe: (listener: (state: ProjectRecoveryState) => void) => () => void
  refresh: () => Promise<void>
  recover: () => Promise<void>
  exportDiagnostics: () => Promise<void>
  dispose: () => void
}

function stableErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return 'INTERNAL_ERROR'
}

export function createProjectRecoveryController(
  project: string,
  dependencies: ProjectRecoveryDependencies,
): ProjectRecoveryController {
  let state: ProjectRecoveryState = {
    diagnostics: null,
    pending: null,
    errorCode: null,
    exportedFilename: null,
  }
  let disposed = false
  let generation = 0
  const listeners = new Set<(state: ProjectRecoveryState) => void>()

  const update = (patch: Partial<ProjectRecoveryState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  const begin = (pending: Exclude<RecoveryPending, null>): number | null => {
    if (disposed || state.pending) return null
    const operationGeneration = ++generation
    update({ pending, errorCode: null })
    return operationGeneration
  }

  const isCurrent = (operationGeneration: number) => !disposed && generation === operationGeneration

  const refresh = async () => {
    const operationGeneration = begin('refresh')
    if (operationGeneration === null) return
    try {
      const nextDiagnostics = await dependencies.getDiagnostics(project)
      if (!isCurrent(operationGeneration)) return
      update({ diagnostics: nextDiagnostics, pending: null, errorCode: null })
    } catch (error) {
      if (!isCurrent(operationGeneration)) return
      update({ pending: null, errorCode: stableErrorCode(error) })
    }
  }

  const recover = async () => {
    if (disposed || state.pending) return
    const evidence = state.diagnostics
    if (!evidence || evidence.canAutoRecover !== true || evidence.recommendedAction !== 'recover_v1_publication') {
      update({ errorCode: 'RECOVERY_REQUIRED' })
      return
    }
    const operationGeneration = begin('recover')
    if (operationGeneration === null) return
    try {
      const recoveryResult = await dependencies.recoverDiagnostics(project, 'recover_v1_publication', evidence.snapshot)
      if (!isCurrent(operationGeneration)) return
      if (recoveryResult.state !== 'ready') {
        update({
          diagnostics: recoveryResult,
          pending: null,
          errorCode: recoveryResult.reasonCode || 'RECOVERY_REQUIRED',
        })
        return
      }

      await dependencies.refreshProjects(() => isCurrent(operationGeneration))
      if (!isCurrent(operationGeneration)) return
      const freshDiagnostics = await dependencies.getDiagnostics(project)
      if (!isCurrent(operationGeneration)) return
      const projectSummary = dependencies.getProjects().find((candidate) => candidate.name === project)
      const listReady = isReadyProject(projectSummary)
      const diagnosticsReady = freshDiagnostics.state === 'ready'
      if (!listReady || !diagnosticsReady) {
        update({ diagnostics: freshDiagnostics, pending: null, errorCode: 'RECOVERY_REQUIRED' })
        return
      }

      update({ diagnostics: freshDiagnostics, pending: null, errorCode: null })
      dependencies.enterReadyProject(project)
    } catch (error) {
      if (!isCurrent(operationGeneration)) return
      update({ pending: null, errorCode: stableErrorCode(error) })
    }
  }

  const exportDiagnostics = async () => {
    const operationGeneration = begin('export')
    if (operationGeneration === null) return
    try {
      const result = await dependencies.exportDiagnostics(project)
      if (!isCurrent(operationGeneration)) return
      if (!result || typeof result.filename !== 'string' || !result.filename) {
        update({ pending: null, errorCode: 'INTERNAL_ERROR' })
        return
      }
      update({ exportedFilename: result.filename, pending: null, errorCode: null })
    } catch (error) {
      if (!isCurrent(operationGeneration)) return
      update({ pending: null, errorCode: stableErrorCode(error) })
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    recover,
    exportDiagnostics,
    dispose: () => {
      if (disposed) return
      disposed = true
      generation++
      listeners.clear()
    },
  }
}
