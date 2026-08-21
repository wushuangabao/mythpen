import { AlertTriangle, Copy, Loader, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/hooks/useT'
import { type ManuscriptDraftConflict, manuscriptDraftConflictsApi } from '@/lib/api'
import { ManuscriptRecoveryState } from '@/lib/manuscriptRecoveryState'

type ConflictAction = 'accept_external' | 'apply_saved_draft'

export function DraftConflictDialog({
  project,
  resourceUid,
  onResolved,
}: {
  project: string
  resourceUid?: string
  onResolved: (conflict: ManuscriptDraftConflict, action: ConflictAction) => void | Promise<void>
}) {
  const { t } = useT()
  const recovery = useRef(new ManuscriptRecoveryState())
  const [conflict, setConflict] = useState<ManuscriptDraftConflict | null>(null)
  const [busy, setBusy] = useState<ConflictAction | 'copy' | 'refresh' | null>('refresh')
  const [error, setError] = useState<string | null>(null)
  const [copyName, setCopyName] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy('refresh')
    setError(null)
    try {
      const conflicts = await manuscriptDraftConflictsApi.list(project)
      const ready = conflicts.find(
        (candidate) =>
          candidate.state === 'decision_ready' &&
          candidate.decisionAvailable &&
          (resourceUid === undefined || candidate.resource.uid === resourceUid),
      )
      if (!ready) throw new Error(t('manuscriptRecovery.conflictUnavailable'))
      recovery.current.observeConflict(
        Object.freeze({
          conflictId: ready.conflictId,
          decisionEpoch: ready.decisionEpoch,
          state: 'decision_ready' as const,
          backupAvailable: ready.backupAvailable,
        }),
      )
      setConflict(ready)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [project, resourceUid, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const resolve = async (action: ConflictAction) => {
    if (!conflict) return
    setBusy(action)
    setError(null)
    try {
      const intent = recovery.current.beginConflictResolution(action)
      const response =
        action === 'accept_external'
          ? await manuscriptDraftConflictsApi.acceptExternal(project, conflict.conflictId, conflict.decisionEpoch)
          : await manuscriptDraftConflictsApi.applySavedDraft(project, conflict.conflictId, conflict.decisionEpoch)
      const result = Object.freeze({
        conflictId: response.conflictId,
        decisionEpoch: response.decisionEpoch,
        state: response.state,
      })
      recovery.current.completeConflictResolution(intent, result)
      await onResolved(conflict, action)
      setConflict(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const copyBackup = async () => {
    if (!conflict) return
    setBusy('copy')
    setError(null)
    try {
      const result = await manuscriptDraftConflictsApi.copyBackup(project, conflict.conflictId)
      setCopyName(result.filename)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45" role="presentation">
      <div
        className="relative w-[500px] rounded-xl border border-[var(--hairline)] bg-[var(--canvas-card)] p-6 shadow-xl"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="draft-conflict-title"
      >
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 shrink-0 text-amber-500" size={20} />
          <div className="min-w-0 flex-1">
            <h2 id="draft-conflict-title" className="font-display text-lg font-semibold text-[var(--ink)]">
              {t('manuscriptRecovery.conflictTitle')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-secondary)]">
              {t('manuscriptRecovery.conflictDescription')}
            </p>
          </div>
          <button type="button" className="h-7 w-7 text-[var(--ink-tertiary)]" onClick={() => void refresh()}>
            <X size={16} aria-label={t('manuscriptRecovery.refresh')} />
          </button>
        </div>
        {conflict && (
          <div className="mb-4 rounded-md bg-[var(--canvas-mid)] px-3 py-2 text-[12px] text-[var(--ink-tertiary)]">
            {conflict.resource.kind} · {conflict.resource.domain} · {conflict.resource.uid.slice(0, 8)}
          </div>
        )}
        {copyName && <p className="mb-4 text-[12px] text-[var(--ink-secondary)]">{copyName}</p>}
        {error && (
          <p className="mb-4 text-[13px] text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn-secondary h-[34px] px-3"
            onClick={() => void copyBackup()}
            disabled={!conflict || busy !== null}
          >
            <Copy size={14} /> {t('manuscriptRecovery.copyBackup')}
          </button>
          <button
            type="button"
            className="btn-secondary h-[34px] px-3"
            onClick={() => void resolve('accept_external')}
            disabled={!conflict || busy !== null}
          >
            {t('manuscriptRecovery.acceptExternal')}
          </button>
          <button
            type="button"
            className="btn-primary h-[34px] px-3"
            onClick={() => void resolve('apply_saved_draft')}
            disabled={!conflict?.backupAvailable || busy !== null}
          >
            {busy === 'apply_saved_draft' && <Loader className="animate-spin" size={14} />}
            {t('manuscriptRecovery.applySavedDraft')}
          </button>
        </div>
      </div>
    </div>
  )
}
