import { Check, FilePenLine, LoaderCircle, X } from 'lucide-react'
import { type MouseEvent, useEffect, useMemo, useState } from 'react'
import { useT } from '@/hooks/useT'
import { buildRevisionParts, countPendingRevisions, type RevisionPart } from '@/lib/revisionDiff'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useRevisionStore } from '@/stores/useRevisionStore'

type SelectedRevision = {
  signature: string
  id: string
  left: number
  top: number
}
type ChangePart = Extract<RevisionPart, { kind: 'revision' }>

export function RevisionReview() {
  const chapter = useChapterStore((s) => s.currentChapter)
  const project = useProjectStore((s) => s.currentProject)
  const { revision, revisionProject, saving, error, decide, finalize, acceptAll, rejectAll } = useRevisionStore()
  const loadRevision = useRevisionStore((s) => s.loadRevision)
  const { t } = useT()
  const [selectedChange, setSelectedChange] = useState<SelectedRevision | null>(null)
  const chapterId = chapter?.id
  const chapterContent = chapter?.content
  const revisionChapterId = revision?.chapterId
  const revisionBaseContent = revision?.baseContent
  const revisionMatchesProject = revisionProject === project
  const revisionSignature = revision
    ? JSON.stringify([revisionProject, revision.id, revision.baseContent, revision.proposedContent, revision.updatedAt])
    : ''

  useEffect(() => {
    setSelectedChange((selected) => (selected?.signature === revisionSignature ? selected : null))
  }, [revisionSignature])

  useEffect(() => {
    if (
      !project ||
      !chapterId ||
      !revisionMatchesProject ||
      revisionChapterId !== chapterId ||
      chapterContent === revisionBaseContent
    ) {
      return
    }
    void loadRevision(project, chapterId)
  }, [chapterContent, chapterId, loadRevision, project, revisionBaseContent, revisionChapterId, revisionMatchesProject])

  const parts = useMemo(
    () => (revision ? buildRevisionParts(revision.baseContent, revision.proposedContent) : []),
    [revision],
  )
  const pendingCount = revision ? countPendingRevisions(parts, revision.decisions) : 0
  const selected = selectedChange?.signature === revisionSignature ? selectedChange : null
  const selectedPart: ChangePart | undefined = selected
    ? parts.find((part): part is ChangePart => part.kind === 'revision' && part.id === selected.id)
    : undefined
  const selectedDecision = selectedPart && revision ? revision.decisions[selectedPart.id] : undefined

  if (
    !chapter ||
    !project ||
    !revision ||
    revision.status !== 'pending' ||
    !revisionMatchesProject ||
    revision.chapterId !== chapter.id
  )
    return null

  const selectRevision = (event: MouseEvent<HTMLElement>, id: string) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setSelectedChange({
      signature: revisionSignature,
      id,
      left: Math.min(Math.max(rect.left, 12), window.innerWidth - 188),
      top: Math.min(rect.bottom + 8, window.innerHeight - 52),
    })
  }

  const handleDecision = (decision: 'accepted' | 'rejected') => {
    if (!selected || saving) return
    setSelectedChange(null)
    void decide(project, revision.id, selected.id, decision)
  }

  const handleFinalize = () => {
    if (saving) return
    void finalize(project, revision.id)
  }

  return (
    <div className="flex-1 overflow-y-auto px-16 pb-32 pt-8 flex justify-center custom-scrollbar">
      <section
        className="w-full max-w-[var(--editor-max-w)] leading-[1.9] tracking-[0.01em]"
        style={{ fontFamily: 'var(--font-editor)', color: 'var(--ink)' }}
      >
        <div className="mb-8 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--canvas-soft)] p-3 font-sans leading-normal">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink)]">
              <FilePenLine className="h-4 w-4 text-[var(--accent-gold)]" />
              {t('editor.revisionReview')}
            </span>
            <span className="rounded-full bg-[var(--accent-gold-soft-bg)] px-2 py-0.5 text-[11px] text-[var(--accent-gold-soft)]">
              {t('editor.revisionPending', { count: pendingCount })}
            </span>
            <span className="ml-auto text-[11px] text-[var(--ink-tertiary)]">{t('editor.revisionInstructions')}</span>
          </div>
          <div className="mt-3 flex items-center gap-2 border-t border-[var(--hairline)] pt-3">
            {pendingCount === 0 ? (
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--success)] bg-[var(--success-soft)] px-2.5 text-[12px] font-medium text-[var(--success)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleFinalize}
                disabled={saving}
              >
                {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                {t('editor.applyRevisionDecisions')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--success)] bg-[var(--success-soft)] px-2.5 text-[12px] font-medium text-[var(--success)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void acceptAll(project, revision.id)}
                  disabled={saving}
                >
                  {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  {t('editor.acceptAllChanges')}
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--error)] bg-[var(--error-soft)] px-2.5 text-[12px] font-medium text-[var(--error)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void rejectAll(project, revision.id)}
                  disabled={saving}
                >
                  <X className="h-3.5 w-3.5" />
                  {t('editor.rejectAllChanges')}
                </button>
              </>
            )}
            {saving && <span className="text-[11px] text-[var(--ink-tertiary)]">{t('editor.revisionSaving')}</span>}
          </div>
          {error && (
            <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--error)]" role="alert">
              <span className="min-w-0 flex-1">{error}</span>
              <button
                type="button"
                className="shrink-0 border-none bg-transparent font-medium text-inherit underline underline-offset-2 disabled:cursor-wait disabled:opacity-60"
                onClick={() => void loadRevision(project, chapter.id)}
                disabled={saving}
              >
                {t('serverStatus.retry')}
              </button>
            </div>
          )}
        </div>

        <h1 className="font-display mb-[1.5em] text-[36px] font-semibold leading-[1.25] tracking-[-0.01em]">
          {t('sidebar.chapterTitle', { num: chapter.num, title: chapter.title })}
        </h1>

        <article className="revision-review-body whitespace-pre-wrap break-words text-[17px]" aria-live="polite">
          {parts.map((part) => {
            if (part.kind === 'text') return <span key={part.id}>{part.text}</span>

            const decision = revision.decisions[part.id]
            if (decision) {
              return <span key={part.id}>{decision === 'accepted' ? part.after : part.before}</span>
            }

            const isSelected = selected?.id === part.id
            return (
              <button
                type="button"
                key={part.id}
                className={`revision-change ${isSelected ? 'revision-change-selected' : ''}`}
                onClick={(event) => selectRevision(event, part.id)}
                title={t('editor.clickRevisionToReview')}
              >
                {part.before && <del className="revision-deletion">{part.before}</del>}
                {part.after && <ins className="revision-insertion">{part.after}</ins>}
              </button>
            )
          })}
        </article>
      </section>

      {selected && selectedPart && !selectedDecision && (
        <div
          className="revision-action-popover fixed z-50 flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--hairline-light)] bg-[var(--canvas-pop)] p-1 shadow-xl"
          style={{ left: selected.left, top: selected.top }}
          role="toolbar"
          aria-label={t('editor.revisionActions')}
        >
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--success-soft)] px-2 text-[12px] text-[var(--success)] hover:brightness-110 disabled:opacity-60"
            onClick={() => handleDecision('accepted')}
            disabled={saving}
          >
            <Check className="h-3.5 w-3.5" />
            {t('editor.acceptChange')}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-xs)] bg-[var(--error-soft)] px-2 text-[12px] text-[var(--error)] hover:brightness-110 disabled:opacity-60"
            onClick={() => handleDecision('rejected')}
            disabled={saving}
          >
            <X className="h-3.5 w-3.5" />
            {t('editor.rejectChange')}
          </button>
        </div>
      )}
    </div>
  )
}
