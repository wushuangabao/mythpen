import { Check, Loader, Pen, Plus, Save, ScrollText, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@/hooks/useT'
import { aiApi, extractAIJsonObject, getAIResponseText } from '@/lib/api'
import { notifyDataChanged } from '@/lib/dataEvents'
import { useProjectInstanceId } from '@/lib/useProjectData'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'
import type { Chapter } from '@/types'

type OutlineDeleteTarget = Pick<Chapter, 'id' | 'volumeId' | 'num' | 'title'> & {
  project: string
  projectInstanceId: string
}

function isActiveOutlineDeleteTarget(target: OutlineDeleteTarget): boolean {
  const state = useProjectStore.getState()
  if (state.currentProject !== target.project) return false
  const currentInstanceId = state.projects.find((project) => project.name === target.project)?.instanceId || ''
  return !!target.projectInstanceId && currentInstanceId === target.projectInstanceId
}

export function Outline() {
  const { t } = useT()
  const { volumes, updateChapter, createChapter, deleteChapter, loadChapters } = useChapterStore()
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectInstanceId = useProjectInstanceId()
  const [activeChapterId, setActiveChapterId] = useState<number | null>(() => volumes[0]?.chapters[0]?.id || null)
  const [collapsedVolumes, setCollapsedVolumes] = useState<Set<number>>(new Set())
  const [outlineText, setOutlineText] = useState('')
  const [dimensions, setDimensions] = useState({
    cognitiveFrame: '',
    emotionalAnchor: '',
    worldTexture: '',
    concreteMystery: '',
    interpersonalTension: '',
  })
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<OutlineDeleteTarget | null>(null)
  const [deletingChapter, setDeletingChapter] = useState(false)
  const [deleteChapterError, setDeleteChapterError] = useState<string | null>(null)
  const deleteDialogRef = useRef<HTMLDivElement | null>(null)
  const deleteDialogCancelRef = useRef<HTMLButtonElement | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const deleteOperationRef = useRef(0)
  const emptyOutlineRef = useRef<HTMLDivElement | null>(null)

  const activeChapter = volumes.flatMap((v) => v.chapters).find((c) => c.id === activeChapterId)

  const beginDeleteOperation = () => {
    deleteOperationRef.current += 1
    return deleteOperationRef.current
  }

  const isCurrentDeleteOperation = (target: OutlineDeleteTarget, operationId: number) =>
    deleteOperationRef.current === operationId && isActiveOutlineDeleteTarget(target)

  // Select first chapter on mount or when volumes change
  useEffect(() => {
    const first = volumes[0]?.chapters[0]?.id || null
    if (!activeChapterId || !volumes.flatMap((v) => v.chapters).find((c) => c.id === activeChapterId)) {
      setActiveChapterId(first)
    }
  }, [volumes, activeChapterId])

  // Sync local state when switching chapters or when volumes reload
  useEffect(() => {
    if (activeChapter) {
      setOutlineText(activeChapter.outline || '')
      setDimensions({
        cognitiveFrame: activeChapter.cognitiveFrame || '',
        emotionalAnchor: activeChapter.emotionalAnchor || '',
        worldTexture: activeChapter.worldTexture || '',
        concreteMystery: activeChapter.concreteMystery || '',
        interpersonalTension: activeChapter.interpersonalTension || '',
      })
      setAiSuggestion('')
    }
  }, [activeChapter?.outline, activeChapter?.cognitiveFrame, activeChapter])

  useEffect(() => {
    if (!deleteTarget) return
    if (currentProject === deleteTarget.project && currentProjectInstanceId === deleteTarget.projectInstanceId) return
    deleteOperationRef.current += 1
    setDeletingChapter(false)
    setDeleteTarget(null)
    setDeleteChapterError(null)
  }, [currentProject, currentProjectInstanceId, deleteTarget])

  useEffect(() => {
    return () => {
      deleteOperationRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!deleteTarget || typeof document === 'undefined') return
    const root = document.getElementById('root')
    if (!root) return
    const previousInert = root.getAttribute('inert')
    const previousAriaHidden = root.getAttribute('aria-hidden')
    root.setAttribute('inert', '')
    root.setAttribute('aria-hidden', 'true')
    return () => {
      if (previousInert === null) root.removeAttribute('inert')
      else root.setAttribute('inert', previousInert)
      if (previousAriaHidden === null) root.removeAttribute('aria-hidden')
      else root.setAttribute('aria-hidden', previousAriaHidden)
    }
  }, [deleteTarget])

  useEffect(() => {
    if (!deleteTarget) return
    if (deletingChapter) {
      deleteDialogRef.current?.focus()
    } else {
      deleteDialogCancelRef.current?.focus()
    }
  }, [deleteTarget, deletingChapter])

  const restoreDeleteTriggerFocus = (target: OutlineDeleteTarget, operationId: number) => {
    requestAnimationFrame(() => {
      if (isCurrentDeleteOperation(target, operationId)) deleteTriggerRef.current?.focus()
    })
  }

  const restoreFocusAfterDelete = (
    fallbackId: number | null | undefined,
    target: OutlineDeleteTarget,
    operationId: number,
  ) => {
    requestAnimationFrame(() => {
      if (!isCurrentDeleteOperation(target, operationId)) return
      if (fallbackId !== null && deleteTriggerRef.current?.isConnected) {
        deleteTriggerRef.current?.focus()
      } else {
        emptyOutlineRef.current?.focus()
      }
    })
  }

  const closeDeleteDialog = () => {
    if (deletingChapter) return
    if (!deleteTarget) return
    const target = deleteTarget
    const operationId = beginDeleteOperation()
    setDeleteTarget(null)
    setDeleteChapterError(null)
    restoreDeleteTriggerFocus(target, operationId)
  }

  const handleDeleteDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDeleteDialog()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      deleteDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || [],
    )
    if (focusable.length === 0) {
      event.preventDefault()
      deleteDialogRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const handleSaveOutline = async () => {
    if (!currentProject || !activeChapter) return
    setSaving(true)
    try {
      await updateChapter(
        currentProject,
        activeChapter.num,
        {
          outline: outlineText,
          ...dimensions,
        },
        activeChapter.id,
      )
      await loadChapters(currentProject)
    } catch (e) {
      console.error('Save failed:', e)
    }
    setSaving(false)
  }

  const toggleVolumeCollapse = (volumeId: number) => {
    setCollapsedVolumes((prev) => {
      const next = new Set(prev)
      if (next.has(volumeId)) {
        next.delete(volumeId)
      } else {
        next.add(volumeId)
      }
      return next
    })
  }

  const handleNewChapter = async (volumeId: number) => {
    if (!currentProject) return
    try {
      const created = await createChapter(currentProject, t('chapter.defaultTitle'), '', volumeId)
      if (created?.num) {
        // Find the new chapter's ID from the reloaded store (match volume + num to avoid cross-volume collisions)
        const ch = volumes.flatMap((v) => v.chapters).find((c) => c.num === created.num && c.volumeId === volumeId)
        if (ch) setActiveChapterId(ch.id)
      }
    } catch (e) {
      console.error('Create chapter failed:', e)
    }
  }

  const handleDeleteChapter = async () => {
    if (!deleteTarget || !isActiveOutlineDeleteTarget(deleteTarget)) {
      beginDeleteOperation()
      setDeletingChapter(false)
      setDeleteTarget(null)
      setDeleteChapterError(null)
      return
    }
    const target = deleteTarget
    const operationId = beginDeleteOperation()
    setDeletingChapter(true)
    setDeleteChapterError(null)
    try {
      const committedFallbackChapterId = await deleteChapter(target.project, target, target.projectInstanceId)
      if (!isCurrentDeleteOperation(target, operationId)) return
      notifyDataChanged('chapter', [target.id])
      notifyDataChanged('character')
      notifyDataChanged('memory')
      notifyDataChanged('stats')
      if (!isCurrentDeleteOperation(target, operationId)) return
      if (committedFallbackChapterId !== undefined) setActiveChapterId(committedFallbackChapterId)
      setDeleteTarget(null)
      restoreFocusAfterDelete(committedFallbackChapterId, target, operationId)
    } catch (error) {
      if (isCurrentDeleteOperation(target, operationId)) {
        setDeleteChapterError(error instanceof Error ? error.message : t('sidebar.deleteChapterFailed'))
      }
    } finally {
      if (isCurrentDeleteOperation(target, operationId)) setDeletingChapter(false)
    }
  }

  const handleGenerateOutline = async () => {
    if (!currentProject || !activeChapter) return
    setGenerating(true)
    setAiSuggestion('')
    try {
      const contentPreview = activeChapter.content?.slice(0, 1000) || t('outline.noContent')
      const res = await aiApi.chat(
        [
          {
            role: 'system',
            content: t('outline.generateSystemPrompt'),
          },
          {
            role: 'user',
            content: t('outline.generateUserPrompt', {
              num: activeChapter.num,
              title: activeChapter.title,
              preview: contentPreview,
            }),
          },
        ],
        currentProject,
      )
      const text = getAIResponseText(res)
      const parsed = extractAIJsonObject(text)
      if (parsed) {
        if (parsed.title && activeChapter.title === '新章节') {
          handleSaveTitle(parsed.title)
        }
        if (parsed.outline) setOutlineText(parsed.outline)
        setDimensions({
          cognitiveFrame: parsed.cognitive_frame || dimensions.cognitiveFrame,
          emotionalAnchor: parsed.emotional_anchor || dimensions.emotionalAnchor,
          worldTexture: parsed.world_texture || dimensions.worldTexture,
          concreteMystery: parsed.concrete_mystery || dimensions.concreteMystery,
          interpersonalTension: parsed.interpersonal_tension || dimensions.interpersonalTension,
        })
        // Auto-save after generation
        setTimeout(() => handleSaveOutline(), 100)
      } else if (text) {
        setOutlineText(text)
      }
    } catch (e) {
      console.error('Generate outline failed:', e)
    }
    setGenerating(false)
  }

  const handleSaveTitle = async (title: string) => {
    if (!currentProject || !activeChapter) return
    try {
      await updateChapter(currentProject, activeChapter.num, { title }, activeChapter.id)
      await loadChapters(currentProject)
    } catch (e) {
      console.error('Save title failed:', e)
    }
  }

  const handleAIOptimize = async () => {
    if (!currentProject || !activeChapter || !outlineText.trim()) return
    setOptimizing(true)
    setAiSuggestion('')
    try {
      const res = await aiApi.chat(
        [
          {
            role: 'system',
            content: t('outline.optimizeSystemPrompt'),
          },
          {
            role: 'user',
            content: t('outline.optimizeUserPrompt', {
              num: activeChapter.num,
              title: activeChapter.title,
              outline: outlineText,
            }),
          },
        ],
        currentProject,
      )
      const suggestion = res.choices?.[0]?.message?.content?.trim() || ''
      if (suggestion) {
        setAiSuggestion(suggestion)
      }
    } catch (e) {
      console.error('AI optimize failed:', e)
    }
    setOptimizing(false)
  }

  const updateDimension = (key: string, value: string) => {
    setDimensions((prev) => ({ ...prev, [key]: value }))
  }

  const statusIcon: Record<string, React.ReactNode> = {
    accepted: <Check className="w-3 h-3" />,
    review: <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--warning)' }} />,
    writing: <span className="w-2 h-2 rounded-full inline-block" style={{ background: 'var(--info)' }} />,
    pending: <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: 'var(--ink-mute)' }} />,
  }

  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="page-header">
          <h2 className="flex items-center gap-2">
            <ScrollText className="w-5 h-5" /> {t('pages.outlineEditor')}
          </h2>
          <div className="page-header-actions">
            <button
              type="button"
              className="btn-primary flex items-center gap-1.5"
              style={{ height: 30, padding: '0 14px', minWidth: 110 }}
              onClick={handleGenerateOutline}
              disabled={!activeChapter || generating}
            >
              {generating ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Pen className="w-3.5 h-3.5" />}
              {generating ? t('common.generating') : t('pages.generateOutline')}
            </button>
          </div>
        </div>
        <div className="flex flex-1 min-h-0">
          {/* Chapter list */}
          <div className="w-[320px] shrink-0 border-r border-[var(--hairline)] overflow-y-auto py-3 custom-scrollbar">
            {volumes.map((vol) => {
              const collapsed = collapsedVolumes.has(vol.id)
              return (
                <div key={vol.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 border-none bg-transparent px-4 pb-2 pt-1 font-display text-sm font-medium text-[var(--ink)] cursor-pointer select-none hover:opacity-80 transition-opacity"
                    onClick={() => toggleVolumeCollapse(vol.id)}
                  >
                    <span
                      className="text-[10px] text-[var(--ink-mute)] transition-transform duration-200 inline-block"
                      style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                    >
                      ▼
                    </span>
                    {vol.title.startsWith('第') && vol.title.endsWith('卷')
                      ? vol.title
                      : t('sidebar.volumeTitle', { order: vol.sortOrder, title: vol.title })}
                    <span className="text-[10px] text-[var(--ink-tertiary)] ml-auto">
                      {t('outline.chapterCount', { n: vol.chapters.length })}
                    </span>
                  </button>
                  {!collapsed && (
                    <>
                      {vol.chapters.map((ch) => (
                        <button
                          type="button"
                          key={ch.id}
                          className={`mx-3 mb-1.5 block w-[calc(100%_-_1.5rem)] rounded-lg border p-3 text-left cursor-pointer transition-colors
                          ${
                            activeChapterId === ch.id
                              ? 'bg-[var(--accent-gold-soft-bg)] border-[var(--accent-gold)]'
                              : 'bg-[var(--canvas-card)] border-[var(--hairline)] hover:border-[var(--hairline-light)] hover:bg-[var(--canvas-elevated)]'
                          }`}
                          onClick={() => setActiveChapterId(ch.id)}
                        >
                          <div className="text-[13px] text-[var(--ink)] flex items-center gap-2">
                            <span
                              className={`text-[10px] font-medium px-[6px] py-[1px] rounded-full
                            ${
                              ch.status === 'accepted'
                                ? 'bg-[var(--success-soft)] text-[var(--success)]'
                                : ch.status === 'review'
                                  ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                                  : ch.status === 'writing'
                                    ? 'bg-[var(--info-soft)] text-[var(--info)]'
                                    : 'bg-[var(--canvas-pop)] text-[var(--ink-mute)]'
                            }`}
                            >
                              {statusIcon[ch.status]}
                            </span>
                            {ch.title.startsWith('第')
                              ? ch.title
                              : t('sidebar.chapterTitle', { num: ch.num, title: ch.title })}
                          </div>
                          <div className="text-[12px] text-[var(--ink-tertiary)] mt-1 line-clamp-2">{ch.outline}</div>
                        </button>
                      ))}
                      {/* Per-volume new chapter */}
                      <button
                        type="button"
                        className="mx-3 mb-2 flex w-[calc(100%_-_1.5rem)] items-center gap-1 rounded-lg border-none bg-transparent px-3 py-1.5 text-[12px] text-[var(--accent-gold)] cursor-pointer transition-colors hover:bg-[var(--canvas-card)]"
                        onClick={() => handleNewChapter(vol.id)}
                      >
                        <Plus className="w-3 h-3" />
                        {t('pages.newChapter')}
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {/* Editor panel */}
          <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
            {activeChapter ? (
              <>
                <div className="mb-1 flex items-start justify-between gap-4">
                  <div className="font-display text-lg font-medium text-[var(--ink)]">
                    {activeChapter.title.startsWith('第')
                      ? activeChapter.title
                      : t('sidebar.chapterTitle', { num: activeChapter.num, title: activeChapter.title })}
                  </div>
                  <button
                    ref={deleteTriggerRef}
                    type="button"
                    className="btn-secondary flex h-[30px] items-center gap-1.5 px-3 !border-[var(--error)] !text-[var(--error)] hover:!bg-[var(--error-soft)]"
                    onClick={(event) => {
                      if (!currentProject || !currentProjectInstanceId) return
                      deleteTriggerRef.current = event.currentTarget
                      beginDeleteOperation()
                      setDeletingChapter(false)
                      setDeleteChapterError(null)
                      setDeleteTarget({
                        id: activeChapter.id,
                        volumeId: activeChapter.volumeId,
                        num: activeChapter.num,
                        title: activeChapter.title,
                        project: currentProject,
                        projectInstanceId: currentProjectInstanceId,
                      })
                    }}
                    disabled={!currentProjectInstanceId}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t('sidebar.deleteChapter')}
                  </button>
                </div>
                <div className="text-[12px] text-[var(--ink-tertiary)] mb-4">
                  <span
                    className={`text-[10px] font-medium px-[6px] py-[1px] rounded-full
                  ${
                    activeChapter.status === 'accepted'
                      ? 'bg-[var(--success-soft)] text-[var(--success)]'
                      : activeChapter.status === 'review'
                        ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                        : activeChapter.status === 'writing'
                          ? 'bg-[var(--info-soft)] text-[var(--info)]'
                          : 'bg-[var(--canvas-pop)] text-[var(--ink-mute)]'
                  }`}
                  >
                    <span className="inline-flex items-center gap-0.5">
                      {activeChapter.status === 'accepted' && <Check className="w-2.5 h-2.5" />}
                      {activeChapter.status === 'accepted'
                        ? t('status.accepted')
                        : activeChapter.status === 'review'
                          ? t('status.review')
                          : activeChapter.status === 'writing'
                            ? t('status.writing')
                            : t('status.pending')}
                    </span>
                  </span>{' '}
                  {t('outline.outlineInfo', { count: volumes.flatMap((v) => v.chapters).length })}
                </div>

                <div className="mb-3">
                  <label
                    htmlFor="outline-overview"
                    className="block text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1"
                  >
                    {t('pages.outlineOverview')}
                  </label>
                  <textarea
                    id="outline-overview"
                    rows={3}
                    className="w-full bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] p-2.5 font-sans text-[13px] text-[var(--ink)] outline-none resize-vertical focus:border-[var(--accent-gold)]"
                    value={outlineText}
                    onChange={(e) => setOutlineText(e.target.value)}
                    placeholder={t('outline.placeholderOutline')}
                  />
                </div>

                <div className="text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-2">
                  {t('outline.lock5D')}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FiveDimField
                    label={t('pages.dimensionFrame')}
                    value={dimensions.cognitiveFrame}
                    onChange={(v) => updateDimension('cognitiveFrame', v)}
                    placeholder={t('outline.placeholderFrame')}
                  />
                  <FiveDimField
                    label={t('pages.dimensionAnchor')}
                    value={dimensions.emotionalAnchor}
                    onChange={(v) => updateDimension('emotionalAnchor', v)}
                    placeholder={t('outline.placeholderAnchor')}
                  />
                  <FiveDimField
                    label={t('pages.dimensionTexture')}
                    value={dimensions.worldTexture}
                    onChange={(v) => updateDimension('worldTexture', v)}
                    placeholder={t('outline.placeholderTexture')}
                  />
                  <FiveDimField
                    label={t('pages.dimensionMystery')}
                    value={dimensions.concreteMystery}
                    onChange={(v) => updateDimension('concreteMystery', v)}
                    placeholder={t('outline.placeholderMystery')}
                  />
                  <FiveDimField
                    label={t('pages.dimensionTension')}
                    value={dimensions.interpersonalTension}
                    onChange={(v) => updateDimension('interpersonalTension', v)}
                    placeholder={t('outline.placeholderTension')}
                  />
                </div>

                {aiSuggestion && (
                  <div className="mt-4 p-3 rounded-lg bg-[var(--accent-gold-soft-bg)] border border-[rgba(201,169,110,0.3)] text-[13px] text-[var(--ink-secondary)] leading-[1.6]">
                    <div className="text-[11px] font-medium text-[var(--accent-gold)] mb-1 uppercase tracking-[0.04em]">
                      {t('pages.outlineAI')}
                    </div>
                    {aiSuggestion}
                  </div>
                )}

                <div className="flex gap-2 mt-5">
                  <button
                    type="button"
                    className="btn-primary flex items-center gap-1.5"
                    style={{ height: 30, padding: '0 16px', minWidth: 110 }}
                    onClick={handleSaveOutline}
                    disabled={saving}
                  >
                    <Save className="w-3.5 h-3.5" /> {saving ? t('common.saving') : t('pages.outlineSave')}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary flex items-center gap-1.5"
                    style={{ height: 30, padding: '0 16px', minWidth: 135 }}
                    onClick={handleAIOptimize}
                    disabled={optimizing || !outlineText.trim()}
                  >
                    {optimizing ? (
                      <Loader className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" />
                    )}
                    {optimizing ? t('outline.optimizing') : t('pages.outlineAI')}
                  </button>
                </div>
              </>
            ) : (
              <div ref={emptyOutlineRef} tabIndex={-1} className="text-center pt-20 text-[var(--ink-tertiary)]">
                {volumes.flatMap((v) => v.chapters).length > 0
                  ? t('outline.selectChapterHint')
                  : t('outline.noChaptersHint')}
              </div>
            )}
          </div>
        </div>
      </div>
      {deleteTarget &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center" role="presentation">
            <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={closeDeleteDialog} />
            <div
              ref={deleteDialogRef}
              className="relative z-10 w-[400px] rounded-xl border border-[var(--hairline)] bg-[var(--canvas-card)] p-6 shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-labelledby="outline-delete-chapter-dialog-title"
              tabIndex={-1}
              onKeyDown={handleDeleteDialogKeyDown}
            >
              <div className="mb-4 flex items-center justify-between">
                <h2
                  id="outline-delete-chapter-dialog-title"
                  className="font-display text-lg font-semibold text-[var(--ink)]"
                >
                  {t('sidebar.deleteChapter')}
                </h2>
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-tertiary)] hover:bg-[var(--canvas-mid)]"
                  onClick={closeDeleteDialog}
                  disabled={deletingChapter}
                  aria-label={t('common.cancel')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mb-2 text-[14px] leading-relaxed text-[var(--ink-secondary)]">
                {t('sidebar.deleteChapterConfirmation', { num: deleteTarget.num, title: deleteTarget.title })}
              </p>
              {deleteChapterError && (
                <p className="mb-4 text-[13px] text-[var(--error)]" role="alert">
                  {deleteChapterError}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  ref={deleteDialogCancelRef}
                  type="button"
                  className="btn-secondary h-[34px] px-4"
                  onClick={closeDeleteDialog}
                  disabled={deletingChapter}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn-primary h-[34px] px-4 !border-red-600 !bg-red-600 hover:!bg-red-700"
                  onClick={handleDeleteChapter}
                  disabled={deletingChapter}
                >
                  {deletingChapter ? t('sidebar.deletingChapter') : t('project.confirmDelete')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function FiveDimField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const fieldId = useId()
  return (
    <div>
      <label
        htmlFor={fieldId}
        className="block text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1"
      >
        {label}
      </label>
      <textarea
        id={fieldId}
        rows={2}
        className="w-full bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] p-2 font-sans text-[13px] text-[var(--ink)] outline-none resize-vertical min-h-[50px] focus:border-[var(--accent-gold)]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}
