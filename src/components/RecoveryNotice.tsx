import { AlertTriangle, Download, RefreshCw, ShieldAlert, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/hooks/useT'
import { projectsApi } from '@/lib/api'
import {
  createProjectRecoveryController,
  type ProjectRecoveryController,
  type ProjectRecoveryState,
  recoveryErrorI18nKey,
  recoveryReasonI18nKey,
} from '@/lib/projectRecovery'
import { useProjectStore } from '@/stores/useProjectStore'

interface RecoveryNoticeProps {
  project: string
}

const INITIAL_STATE: ProjectRecoveryState = {
  diagnostics: null,
  pending: null,
  errorCode: null,
  exportedFilename: null,
}

export function RecoveryNotice({ project }: RecoveryNoticeProps) {
  const { t } = useT()
  const showProjectList = useProjectStore((state) => state.showProjectListFn)
  const controllerRef = useRef<ProjectRecoveryController | null>(null)
  const [state, setState] = useState<ProjectRecoveryState>(INITIAL_STATE)

  useEffect(() => {
    const controller = createProjectRecoveryController(project, {
      getDiagnostics: (name) => projectsApi.getDiagnostics(name),
      recoverDiagnostics: (name, action, snapshot) => projectsApi.recoverDiagnostics(name, action, snapshot),
      exportDiagnostics: (name) => projectsApi.exportDiagnostics(name),
      refreshProjects: async (isCurrent) => {
        await useProjectStore.getState().loadProjects({ shouldCommit: isCurrent })
        if (!isCurrent()) return
        if (useProjectStore.getState().error) {
          throw Object.assign(new Error('Project list refresh failed'), { code: 'RECOVERY_REQUIRED' })
        }
      },
      getProjects: () => useProjectStore.getState().projects,
      enterReadyProject: (name) => useProjectStore.getState().completeRecoveredProject(name),
    })
    controllerRef.current = controller
    setState(controller.getState())
    const unsubscribe = controller.subscribe(setState)
    void controller.refresh()
    return () => {
      unsubscribe()
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [project])

  const isPending = state.pending !== null
  const canRecover =
    state.diagnostics?.canAutoRecover === true && state.diagnostics.recommendedAction === 'recover_v1_publication'
  const reasonKey =
    state.diagnostics?.state === 'ready'
      ? 'recovery.reason.ready'
      : recoveryReasonI18nKey(state.diagnostics?.reasonCode)

  const returnToProjectList = () => {
    controllerRef.current?.dispose()
    showProjectList()
  }

  return (
    <main className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
      <section className="w-full max-w-[620px] rounded-xl border border-amber-500/40 bg-[var(--canvas-card)] p-7 shadow-lg">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
            <ShieldAlert size={22} />
          </div>
          <div>
            <h1 className="font-display text-[22px] font-semibold text-[var(--ink)]">{t('recovery.title')}</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-secondary)]">{t('recovery.description')}</p>
            <p className="mt-2 text-[12px] text-[var(--ink-tertiary)]">{t('recovery.currentProject', { project })}</p>
          </div>
        </div>

        <div className="mb-5 rounded-lg border border-[var(--hairline)] bg-[var(--canvas-elevated)] p-4">
          <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-[var(--ink)]">
            <AlertTriangle size={14} className="text-amber-600" />
            {t('recovery.isolated')}
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--ink-secondary)]">{t(reasonKey)}</p>
        </div>

        <div className="mb-5 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary h-[36px] px-4"
            disabled={isPending}
            onClick={() => void controllerRef.current?.refresh()}
          >
            <RefreshCw size={14} />
            {t('recovery.refresh')}
          </button>
          {canRecover && (
            <button
              type="button"
              className="btn-primary h-[36px] px-4"
              disabled={isPending}
              onClick={() => void controllerRef.current?.recover()}
            >
              <Wrench size={14} />
              {t('recovery.recover')}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary h-[36px] px-4"
            disabled={isPending}
            onClick={() => void controllerRef.current?.exportDiagnostics()}
          >
            <Download size={14} />
            {t('recovery.export')}
          </button>
          <button type="button" className="btn-secondary h-[36px] px-4" onClick={returnToProjectList}>
            {t('recovery.back')}
          </button>
        </div>

        <div aria-live="polite" className="min-h-5 text-[12px] text-[var(--ink-secondary)]">
          {state.pending && <p>{t(`recovery.pending.${state.pending}`)}</p>}
          {state.exportedFilename && <p>{t('recovery.exportedFilename', { filename: state.exportedFilename })}</p>}
          {state.errorCode && (
            <p role="alert" className="text-red-600">
              {t(recoveryErrorI18nKey(state.errorCode))}
            </p>
          )}
        </div>

        <div className="mt-5 rounded-lg bg-red-500/10 px-4 py-3 text-[12px] font-medium leading-relaxed text-red-700 dark:text-red-300">
          {t('recovery.protect')}
        </div>
      </section>
    </main>
  )
}
