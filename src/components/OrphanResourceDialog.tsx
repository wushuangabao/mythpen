import { useState } from 'react'
import { useT } from '@/hooks/useT'
import { type ManuscriptOrphanKind, manuscriptOrphansApi } from '@/lib/api'

export function OrphanResourceDialog({
  project,
  resource,
  ignored,
  onClose,
  onResolved,
}: {
  project: string
  resource: Readonly<{ kind: ManuscriptOrphanKind; uid: string }>
  ignored: boolean
  onClose: () => void
  onResolved: () => void | Promise<void>
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolve = async () => {
    setBusy(true)
    setError(null)
    try {
      if (ignored) await manuscriptOrphansApi.revokeIgnore(project, resource)
      else await manuscriptOrphansApi.ignoreInPlace(project, resource)
      await onResolved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation">
      <div
        className="w-[440px] rounded-xl border border-[var(--hairline)] bg-[var(--canvas-card)] p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="font-display text-lg font-semibold text-[var(--ink)]">{t('manuscriptRecovery.orphanTitle')}</h2>
        <p className="mt-2 text-[13px] text-[var(--ink-secondary)]">
          {resource.kind} · {resource.uid.slice(0, 8)}
        </p>
        {error && (
          <p className="mt-3 text-[13px] text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary h-[34px] px-4" onClick={onClose} disabled={busy}>
            {t('project.cancel')}
          </button>
          <button type="button" className="btn-primary h-[34px] px-4" onClick={() => void resolve()} disabled={busy}>
            {t(ignored ? 'manuscriptRecovery.reactivateOrphan' : 'manuscriptRecovery.keepOrphan')}
          </button>
        </div>
      </div>
    </div>
  )
}
