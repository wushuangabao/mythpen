import { useEffect, useState } from 'react'
import { useT } from '@/hooks/useT'
import { projectsApi } from '@/lib/api'

export function RetiredProjectsDialog({ projects, onClose }: { projects: readonly string[]; onClose: () => void }) {
  const { t } = useT()
  const [retired, setRetired] = useState<readonly string[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void Promise.all(projects.map(async (name) => ({ name, status: await projectsApi.getFilesBetaStatus(name) })))
      .then((rows) => {
        if (active) setRetired(rows.filter((row) => row.status.route === 'retired').map((row) => row.name))
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [projects])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation">
      <div
        className="w-[460px] rounded-xl border border-[var(--hairline)] bg-[var(--canvas-card)] p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="font-display text-lg font-semibold text-[var(--ink)]">{t('manuscriptRecovery.retiredTitle')}</h2>
        <p className="mt-2 text-[13px] text-[var(--ink-secondary)]">{t('manuscriptRecovery.retiredDescription')}</p>
        <ul className="mt-4 space-y-2 text-[13px] text-[var(--ink)]">
          {retired.map((name) => (
            <li key={name} className="rounded-md bg-[var(--canvas-mid)] px-3 py-2">
              {name}
            </li>
          ))}
        </ul>
        {error && (
          <p className="mt-3 text-[13px] text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end">
          <button type="button" className="btn-secondary h-[34px] px-4" onClick={onClose}>
            {t('project.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
