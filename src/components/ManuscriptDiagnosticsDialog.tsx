import { useCallback, useEffect, useState } from 'react'
import { useT } from '@/hooks/useT'
import { projectsApi } from '@/lib/api'
import type { ProjectDiagnostics } from '@/types'

const SAFE_DIAGNOSTIC_FIELDS = [
  'state',
  'reasonCode',
  'backend',
  'schema',
  'currentSeq',
  'expectedSeq',
  'canAutoRecover',
] as const

export function ManuscriptDiagnosticsDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const { t } = useT()
  const [diagnostics, setDiagnostics] = useState<ProjectDiagnostics | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setDiagnostics(await projectsApi.getDiagnostics(project))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [project])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const recover = async () => {
    if (!diagnostics?.recommendedAction) return
    setBusy(true)
    try {
      setDiagnostics(await projectsApi.recoverDiagnostics(project, diagnostics.recommendedAction, diagnostics.snapshot))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const exportFacts = async () => {
    setBusy(true)
    try {
      await projectsApi.exportDiagnostics(project)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation">
      <div
        className="w-[520px] rounded-xl border border-[var(--hairline)] bg-[var(--canvas-card)] p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="font-display text-lg font-semibold text-[var(--ink)]">{t('recovery.title')}</h2>
        <dl className="mt-4 grid grid-cols-2 gap-2 text-[12px]">
          {diagnostics &&
            SAFE_DIAGNOSTIC_FIELDS.map((field) => (
              <div key={field} className="rounded-md bg-[var(--canvas-mid)] px-3 py-2">
                <dt className="text-[var(--ink-tertiary)]">{field}</dt>
                <dd className="mt-1 break-all text-[var(--ink)]">{String(diagnostics[field])}</dd>
              </div>
            ))}
        </dl>
        {error && (
          <p className="mt-3 text-[13px] text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary h-[34px] px-3" onClick={onClose}>
            {t('project.cancel')}
          </button>
          <button type="button" className="btn-secondary h-[34px] px-3" onClick={() => void refresh()} disabled={busy}>
            {t('recovery.refresh')}
          </button>
          <button
            type="button"
            className="btn-secondary h-[34px] px-3"
            onClick={() => void exportFacts()}
            disabled={busy}
          >
            {t('recovery.export')}
          </button>
          <button
            type="button"
            className="btn-primary h-[34px] px-3"
            onClick={() => void recover()}
            disabled={busy || !diagnostics?.canAutoRecover}
          >
            {t('recovery.recover')}
          </button>
        </div>
      </div>
    </div>
  )
}
