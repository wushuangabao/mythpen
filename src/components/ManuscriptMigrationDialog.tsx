import { AlertTriangle, X } from 'lucide-react'
import { useT } from '@/hooks/useT'
import type { FilesBetaMigrationPreflight } from '@/lib/manuscriptMigrationPreflight'

export function ManuscriptMigrationDialog({
  project,
  preflight,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  project: string
  preflight: FilesBetaMigrationPreflight
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useT()
  const blocked = !preflight.canMigrate
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="presentation">
      <button
        type="button"
        className="absolute inset-0 cursor-default border-none bg-transparent p-0"
        aria-label={t('project.cancel')}
        onClick={onCancel}
      />
      <div
        className="relative z-10 w-[460px] rounded-xl border border-[var(--hairline)] bg-[var(--canvas-card)] p-6 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="files-beta-migration-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="files-beta-migration-title" className="font-display text-lg font-semibold text-[var(--ink)]">
            {t('project.filesBetaMigrationTitle')}
          </h2>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-tertiary)] hover:bg-[var(--canvas-mid)]"
            onClick={onCancel}
            disabled={busy}
          >
            <X size={16} />
          </button>
        </div>
        <p className="mb-3 text-[14px] leading-relaxed text-[var(--ink-secondary)]">
          {t('project.filesBetaMigrationDescription', { name: project })}
        </p>
        <p className="mb-5 rounded-md bg-[var(--canvas-mid)] px-3 py-2 text-[12px] leading-relaxed text-[var(--ink-tertiary)]">
          {t('project.filesBetaMigrationSafety')}
        </p>
        {blocked && (
          <div
            className="mb-5 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-200"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 shrink-0" size={15} />
            <span>
              {t('project.filesBetaMigrationBlocked', {
                body: preflight.bodyDrafts,
                title: preflight.titleDrafts,
              })}
            </span>
          </div>
        )}
        {error && (
          <div className="mb-5 text-[13px] text-[var(--danger)]" role="alert">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary h-[34px] px-4" onClick={onCancel} disabled={busy}>
            {t('project.cancel')}
          </button>
          <button type="button" className="btn-primary h-[34px] px-4" onClick={onConfirm} disabled={busy || blocked}>
            {busy ? t('project.filesBetaMigrating') : t('project.filesBetaMigrate')}
          </button>
        </div>
      </div>
    </div>
  )
}
