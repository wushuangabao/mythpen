import { AlertTriangle } from 'lucide-react'
import { useT } from '@/hooks/useT'

export function ManuscriptStatusBanner({ code, message }: { code: string; message?: string }) {
  const { t } = useT()
  const conflict = code === 'EXTERNAL_DRAFT_CONFLICT'
  return (
    <div
      className="mb-5 flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-800 dark:text-amber-200"
      role="alert"
    >
      <AlertTriangle className="mt-0.5 shrink-0" size={16} />
      <div>
        <div className="font-medium">{t(conflict ? 'editor.filesConflictTitle' : 'editor.filesRecoveryTitle')}</div>
        <div className="mt-1 leading-relaxed">
          {t(conflict ? 'editor.filesConflictDescription' : 'editor.filesRecoveryDescription')}
        </div>
        {message && <div className="mt-1 opacity-80">{message}</div>}
      </div>
    </div>
  )
}
