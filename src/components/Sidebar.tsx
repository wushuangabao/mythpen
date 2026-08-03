import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  Download,
  FileText,
  FlaskConical,
  Globe,
  HeartHandshake,
  Info,
  LayoutDashboard,
  Link2,
  PenSquare,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { activateOnKeyDown } from '@/lib/a11y'
import { projectsApi, statsApi } from '@/lib/api'
import { notifyDataChanged, refreshAllData } from '@/lib/dataEvents'
import { initializeProjectCacheValue, projectInstanceCacheKey, setProjectCacheValue } from '@/lib/projectCache'
import { createRequestCommitTracker } from '@/lib/requestCommitTracker'
import { NEXT_STATUS } from '@/lib/status'
import { useStats } from '@/lib/useProjectData'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSidebarStore } from '@/stores/useSidebarStore'
import type { SidebarItem } from '@/types'

type ChapterDeleteTarget = {
  id: number
  volumeId: number
  num: number
  title: string
  project: string
  projectInstanceId: string
}

function isActiveChapterDeleteTarget(target: ChapterDeleteTarget): boolean {
  const state = useProjectStore.getState()
  if (state.currentProject !== target.project) return false
  const currentInstanceId = state.projects.find((project) => project.name === target.project)?.instanceId || ''
  return !!target.projectInstanceId && currentInstanceId === target.projectInstanceId
}

// Map icon string names from backend to Lucide components
const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard,
  Users,
  Globe,
  FlaskConical,
  ScrollText,
  Link2,
  Brain,
  HeartHandshake,
  CalendarDays,
  ShieldCheck,
  Download,
  Info,
}

export function Sidebar() {
  const {
    volumes,
    currentChapter,
    projectName: chapterProject,
    setCurrentChapter,
    loadChapterContent,
    createChapter,
    deleteChapter,
  } = useChapterStore()
  const { activePage, setActivePage } = useSidebarStore()
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectInstanceId = useProjectStore((s) => {
    if (!s.currentProject) return null
    return s.projects.find((project) => project.name === s.currentProject)?.instanceId || null
  })
  const projectLoading = useProjectStore((s) => s.loading)
  const { data: stats, reload: reloadStats } = useStats()
  useDataRefresh('stats', reloadStats)
  const { t } = useT()
  const [sidebarItemsByProject, setSidebarItemsByProject] = useState(() => new Map<string, SidebarItem[]>())
  const [spinKey, setSpinKey] = useState(0)
  const [collapsedVols, setCollapsedVols] = useState<Set<number>>(new Set())
  const [editingTarget, setEditingTarget] = useState(false)
  const [targetInput, setTargetInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ChapterDeleteTarget | null>(null)
  const [deletingChapter, setDeletingChapter] = useState(false)
  const [deleteChapterError, setDeleteChapterError] = useState<string | null>(null)
  const targetInputRef = useRef<HTMLInputElement>(null)
  const targetDraftProjectRef = useRef(currentProject)
  const deleteDialogRef = useRef<HTMLDivElement | null>(null)
  const deleteDialogCancelRef = useRef<HTMLButtonElement | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)
  const chapterRowRefs = useRef(new Map<number, HTMLDivElement>())
  const newChapterButtonRefs = useRef(new Map<number, HTMLButtonElement>())
  const deleteOperationRef = useRef(0)
  const sidebarCacheKey = projectInstanceCacheKey(currentProject, currentProjectInstanceId)
  const sidebarRequestsRef = useRef(createRequestCommitTracker(sidebarCacheKey || ''))
  sidebarRequestsRef.current.activate(sidebarCacheKey || '')
  const sidebarItems = sidebarCacheKey ? sidebarItemsByProject.get(sidebarCacheKey) || [] : []
  const projectOwnsChapters = !!currentProject && chapterProject === currentProject
  const displayedVolumes = projectOwnsChapters ? volumes : []
  const displayedCurrentChapter = projectOwnsChapters ? currentChapter : null

  const beginDeleteOperation = () => {
    deleteOperationRef.current += 1
    return deleteOperationRef.current
  }

  const isCurrentDeleteOperation = (target: ChapterDeleteTarget, operationId: number) =>
    deleteOperationRef.current === operationId && isActiveChapterDeleteTarget(target)

  const handleSaveTargetWords = useCallback(async () => {
    const val = parseInt(targetInput, 10)
    if (!Number.isNaN(val) && val >= 1000 && currentProject && targetDraftProjectRef.current === currentProject) {
      try {
        await statsApi.updateTargetWords(currentProject, val)
        reloadStats()
      } catch {
        /* ignore */
      }
    }
    setEditingTarget(false)
    setTargetInput('')
  }, [targetInput, currentProject, reloadStats])

  const _handleResetTargetWords = useCallback(async () => {
    if (!currentProject) return
    try {
      await statsApi.resetTargetWords(currentProject)
      reloadStats()
    } catch {
      /* ignore */
    }
    setEditingTarget(false)
    setTargetInput('')
  }, [currentProject, reloadStats])

  useEffect(() => {
    if (editingTarget && targetInputRef.current) {
      targetInputRef.current.focus()
      targetInputRef.current.select()
    }
  }, [editingTarget])

  useEffect(() => {
    // A target draft belongs to the project in which editing started. Never
    // carry it into a project whose stats arrive later.
    if (targetDraftProjectRef.current === currentProject) return
    targetDraftProjectRef.current = currentProject
    setEditingTarget(false)
    setTargetInput('')
  }, [currentProject])

  useEffect(() => {
    if (
      !deleteTarget ||
      (deleteTarget.project === currentProject && deleteTarget.projectInstanceId === currentProjectInstanceId)
    )
      return
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
    if (deletingChapter) deleteDialogRef.current?.focus()
    else deleteDialogCancelRef.current?.focus()
  }, [deleteTarget, deletingChapter])

  const toggleVolume = (volId: number) => {
    setCollapsedVols((prev) => {
      const next = new Set(prev)
      if (next.has(volId)) next.delete(volId)
      else next.add(volId)
      return next
    })
  }

  // Load sidebar items filtered by project genre
  const loadSidebarItems = useCallback(async () => {
    if (!currentProject || !sidebarCacheKey) return
    const project = currentProject
    const cacheKey = sidebarCacheKey
    const request = sidebarRequestsRef.current.start(cacheKey)
    if (!request) return
    try {
      const items = await projectsApi.getSidebarItems(project)
      const currentState = useProjectStore.getState()
      const activeInstanceId = currentState.projects.find((candidate) => candidate.name === project)?.instanceId || null
      if (
        currentState.currentProject === project &&
        projectInstanceCacheKey(project, activeInstanceId) === cacheKey &&
        sidebarRequestsRef.current.claimSuccess(request)
      ) {
        setSidebarItemsByProject((current) => {
          return setProjectCacheValue(current, cacheKey, items)
        })
      }
    } catch {
      const currentState = useProjectStore.getState()
      const activeInstanceId = currentState.projects.find((candidate) => candidate.name === project)?.instanceId || null
      if (
        currentState.currentProject === project &&
        projectInstanceCacheKey(project, activeInstanceId) === cacheKey &&
        sidebarRequestsRef.current.isLatest(request)
      ) {
        // A transient refresh failure must not remove a menu that was already
        // loaded successfully for this exact project instance. A same-name
        // replacement gets a different key and therefore starts empty.
        setSidebarItemsByProject((current) => {
          return initializeProjectCacheValue(current, cacheKey, [])
        })
      }
    }
  }, [currentProject, sidebarCacheKey])

  // Load a project-keyed menu once the project metadata is ready.
  useEffect(() => {
    if (!projectLoading) void loadSidebarItems()
  }, [projectLoading, loadSidebarItems])

  const handleNewChapter = async (volumeId: number) => {
    if (!currentProject) return
    await createChapter(currentProject, t('chapter.defaultTitle'), '', volumeId)
    setActivePage('page-writing')
  }

  const restoreDeleteTriggerFocus = (target: ChapterDeleteTarget, operationId: number) => {
    requestAnimationFrame(() => {
      if (!isCurrentDeleteOperation(target, operationId)) return
      if (deleteTriggerRef.current?.isConnected) {
        deleteTriggerRef.current.focus()
        return
      }
      sidebarRef.current?.focus()
    })
  }

  const restoreFocusAfterDeletedChapter = (
    fallbackChapterId: number | null | undefined,
    target: ChapterDeleteTarget,
    operationId: number,
  ) => {
    requestAnimationFrame(() => {
      if (!isCurrentDeleteOperation(target, operationId)) return
      if (fallbackChapterId !== null && fallbackChapterId !== undefined) {
        const fallbackChapterRow = chapterRowRefs.current.get(fallbackChapterId)
        if (fallbackChapterRow?.isConnected) {
          fallbackChapterRow.focus()
          return
        }
      }
      const newChapterButton = newChapterButtonRefs.current.get(target.volumeId)
      if (newChapterButton?.isConnected) {
        newChapterButton.focus()
        return
      }
      sidebarRef.current?.focus()
    })
  }

  const closeDeleteDialog = () => {
    if (deletingChapter || !deleteTarget) return
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

  const handleDeleteChapter = async () => {
    if (!deleteTarget || !isActiveChapterDeleteTarget(deleteTarget)) {
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
      const fallbackChapterId = await deleteChapter(target.project, target, target.projectInstanceId)
      if (!isCurrentDeleteOperation(target, operationId)) return
      notifyDataChanged('chapter', [target.id])
      notifyDataChanged('character')
      notifyDataChanged('memory')
      notifyDataChanged('stats')
      if (!isCurrentDeleteOperation(target, operationId)) return
      setDeleteTarget(null)
      restoreFocusAfterDeletedChapter(fallbackChapterId, target, operationId)
    } catch (error) {
      if (isCurrentDeleteOperation(target, operationId)) {
        setDeleteChapterError(error instanceof Error ? error.message : t('sidebar.deleteChapterFailed'))
      }
    } finally {
      if (isCurrentDeleteOperation(target, operationId)) setDeletingChapter(false)
    }
  }

  const handleRefresh = () => {
    setSpinKey((k) => k + 1)
    refreshAllData(currentProject || undefined).catch(() => {})
  }

  return (
    <aside
      ref={sidebarRef}
      tabIndex={-1}
      className="w-[var(--sidebar-w)] bg-[var(--canvas-soft)] border-r border-[var(--hairline)] shrink-0 flex flex-col"
    >
      {/* Scrollable top section */}
      <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
        {/* Outline Section */}
        <div className="py-3">
          <div className="px-4 pb-2 text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5" />
            {t('sidebar.outline')}
            <button
              type="button"
              className="ml-auto flex items-center gap-1 px-1.5 py-[2px] rounded text-[var(--ink-mute)] cursor-pointer border-none bg-transparent hover:text-[var(--accent-gold)] hover:bg-[var(--accent-gold-soft-bg)] transition-colors"
              onClick={handleRefresh}
              title={t('sidebar.refreshTooltip')}
            >
              <RefreshCw key={spinKey} className="w-3 h-3 animate-spin-once" />
            </button>
          </div>

          {displayedVolumes.map((vol) => (
            <div key={vol.id}>
              {/* biome-ignore lint/a11y/useSemanticElements: this composite row contains a separate navigation action. */}
              <div
                className="flex items-center gap-1.5 px-3 py-1.5 text-[var(--ink)] text-lg font-display font-medium cursor-pointer select-none"
                role="button"
                tabIndex={0}
                onKeyDown={activateOnKeyDown}
                onClick={() => toggleVolume(vol.id)}
              >
                <span
                  className={`text-[10px] text-[var(--ink-mute)] transition-transform duration-200 ${collapsedVols.has(vol.id) ? '-rotate-90' : ''}`}
                >
                  ▼
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: this is the separate navigation action within the composite volume row. */}
                <span
                  className="flex-1"
                  role="button"
                  tabIndex={0}
                  onKeyDown={activateOnKeyDown}
                  onClick={(e) => {
                    e.stopPropagation()
                    setActivePage('page-writing')
                  }}
                >
                  {vol.title.startsWith('第') && vol.title.endsWith('卷')
                    ? vol.title
                    : t('sidebar.volumeTitle', { order: vol.sortOrder, title: vol.title })}
                </span>
              </div>
              {!collapsedVols.has(vol.id) &&
                vol.chapters.map((ch) => (
                  /* biome-ignore lint/a11y/useSemanticElements: the chapter row contains a separate status-cycling action. */
                  <div
                    key={ch.id}
                    ref={(element) => {
                      if (element) chapterRowRefs.current.set(ch.id, element)
                      else chapterRowRefs.current.delete(ch.id)
                    }}
                    className={`group flex items-center gap-1.5 px-4 pl-5 py-1 text-[13px] cursor-pointer relative transition-colors
                  ${displayedCurrentChapter?.id === ch.id && activePage === 'page-writing' ? 'text-[var(--ink)] bg-[var(--canvas-elevated)]' : 'text-[var(--ink-secondary)]'}
                  hover:bg-[var(--canvas-card)]`}
                    role="button"
                    tabIndex={0}
                    onKeyDown={activateOnKeyDown}
                    onClick={() => {
                      setActivePage('page-writing')
                      setCurrentChapter(ch)
                      if (currentProject) loadChapterContent(currentProject, ch.num, ch.volumeId).catch(() => {})
                    }}
                  >
                    {displayedCurrentChapter?.id === ch.id && activePage === 'page-writing' && (
                      <span className="absolute left-0 top-0.5 bottom-0.5 w-[2px] bg-[var(--accent-gold)] rounded-r" />
                    )}
                    <FileText className="w-3.5 h-3.5 shrink-0" />
                    <span className="flex-1 truncate">
                      {ch.title.startsWith('第')
                        ? ch.title
                        : t('sidebar.chapterTitle', { num: ch.num, title: ch.title })}
                    </span>
                    <StatusBadge
                      status={ch.status}
                      t={t}
                      onCycle={() => {
                        if (!currentProject) return
                        const project = currentProject
                        const next = NEXT_STATUS[ch.status] || 'writing'
                        useChapterStore
                          .getState()
                          .updateChapter(project, ch.num, { status: next }, ch.id)
                          .catch(() => {})
                        // Update local state immediately for UI responsiveness
                        ch.status = next
                        useChapterStore
                          .getState()
                          .loadChapters(project)
                          .catch(() => {})
                      }}
                    />
                    <button
                      type="button"
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--ink-mute)] transition-colors hover:bg-[var(--error-soft)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-40"
                      title={t('sidebar.deleteChapter')}
                      aria-label={t('sidebar.deleteChapter')}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (!currentProject || !currentProjectInstanceId) return
                        deleteTriggerRef.current = event.currentTarget
                        beginDeleteOperation()
                        setDeletingChapter(false)
                        setDeleteChapterError(null)
                        setDeleteTarget({
                          id: ch.id,
                          volumeId: ch.volumeId,
                          num: ch.num,
                          title: ch.title,
                          project: currentProject,
                          projectInstanceId: currentProjectInstanceId,
                        })
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      disabled={!currentProjectInstanceId}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              {/* Per-volume new chapter button */}
              <button
                ref={(element) => {
                  if (element) newChapterButtonRefs.current.set(vol.id, element)
                  else newChapterButtonRefs.current.delete(vol.id)
                }}
                type="button"
                className="flex w-full items-center gap-1.5 border-none bg-transparent px-4 py-1 pl-5 text-[13px] text-[var(--accent-gold)] cursor-pointer transition-colors hover:bg-[var(--canvas-card)]"
                onClick={() => handleNewChapter(vol.id)}
              >
                <Plus className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1">{t('editor.newChapter')}</span>
              </button>
            </div>
          ))}
        </div>

        <div className="h-px bg-[var(--hairline)] mx-3" />

        {/* Creative Section — dynamically loaded by project genre */}
        {sidebarItems.length > 0 && (
          <div className="py-3">
            <div className="px-4 pb-2 text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase flex items-center gap-1.5">
              <PenSquare className="w-3.5 h-3.5" />
              {t('sidebar.creative')}
            </div>
            {sidebarItems.map((item) => {
              const Icon = ICON_MAP[item.icon]
              if (!Icon || !item.labelKey) return null
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`relative flex w-full items-center gap-2 border-none bg-transparent px-4 py-1 pl-5 text-[13px] cursor-pointer transition-colors
                  ${activePage === item.route ? 'text-[var(--ink)] bg-[var(--canvas-card)]' : 'text-[var(--ink-secondary)]'}
                  hover:bg-[var(--canvas-mid)] hover:text-[var(--ink)]`}
                  onClick={() => setActivePage(item.route)}
                >
                  {activePage === item.route && (
                    <span className="absolute left-0 top-0.5 bottom-0.5 w-[2px] bg-[var(--accent-gold)] rounded-r" />
                  )}
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{t(item.labelKey)}</span>
                </button>
              )
            })}
          </div>
        )}

        {/* About Section */}
        <div className="h-px bg-[var(--hairline)] mx-3" />
        <div className="py-3">
          <button
            type="button"
            className="flex w-full items-center gap-2 border-none bg-transparent px-4 pb-2 text-left cursor-pointer transition-colors
            text-[var(--ink-secondary)] hover:text-[var(--ink)] hover:bg-[var(--canvas-mid)]"
            onClick={() => setActivePage('page-about')}
          >
            <div className={`flex items-center gap-2 flex-1 ${activePage === 'page-about' ? 'text-[var(--ink)]' : ''}`}>
              <Info className="w-4 h-4 shrink-0" />
              <span className="text-[13px]">{t('sidebar.about')}</span>
            </div>
          </button>
        </div>
      </div>
      {/* end scrollable top */}

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
              aria-labelledby="delete-chapter-dialog-title"
              tabIndex={-1}
              onKeyDown={handleDeleteDialogKeyDown}
            >
              <div className="mb-4 flex items-center justify-between">
                <h2 id="delete-chapter-dialog-title" className="font-display text-lg font-semibold text-[var(--ink)]">
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

      {/* Writing Stats — fixed at bottom, compact */}
      <div className="py-2 px-4 border-t border-[var(--hairline)] bg-[var(--canvas-soft)] shrink-0 text-[12px]">
        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase">
          <BarChart3 className="w-3 h-3" />
          {t('sidebar.stats')}
        </div>

        {/* Compact completion bar */}
        {stats?.targetWords &&
          stats.targetWords > 0 &&
          (() => {
            const pct = Math.min((stats.totalWords / stats.targetWords) * 100, 100)
            const remaining = Math.max(stats.targetWords - stats.totalWords, 0)
            return (
              <div className="mb-2">
                <div className="flex justify-between text-[11px] leading-none mb-1">
                  <span className="text-[var(--ink-tertiary)]">{t('sidebar.completion')}</span>
                  <span className="font-mono text-[var(--ink-mute)]">
                    {stats.totalWords.toLocaleString()} /{' '}
                    {editingTarget ? (
                      <input
                        ref={targetInputRef}
                        type="number"
                        min={1000}
                        className="inline w-[80px] bg-[var(--canvas-card)] border border-[var(--accent-gold)] rounded px-1 py-[1px] text-[11px] font-mono text-[var(--accent-gold)] outline-none"
                        value={targetInput}
                        onChange={(e) => setTargetInput(e.target.value)}
                        onBlur={handleSaveTargetWords}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveTargetWords()
                          if (e.key === 'Escape') {
                            setEditingTarget(false)
                            setTargetInput('')
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="cursor-pointer border-none bg-transparent p-0 font-inherit text-inherit hover:text-[var(--accent-gold)] transition-colors"
                        onClick={() => {
                          setTargetInput(String(stats.targetWords))
                          setEditingTarget(true)
                        }}
                        title={t('sidebar.clickToEditTarget')}
                      >
                        {stats.targetWords.toLocaleString()}
                      </button>
                    )}
                  </span>
                </div>
                <div className="h-[5px] bg-[var(--canvas-mid)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${pct}%`,
                      background: pct >= 75 ? 'var(--success)' : pct >= 40 ? 'var(--accent-gold)' : 'var(--ink-mute)',
                    }}
                  />
                </div>
                {remaining > 0 && (
                  <div className="text-[10px] text-[var(--ink-mute)] mt-[1px]">
                    {t('sidebar.remaining', { n: remaining.toLocaleString() })}
                  </div>
                )}
              </div>
            )
          })()}

        {/* Sparkline — last 7 days */}
        <div className="mb-1.5">
          <div className="flex items-end gap-[1.5px] h-[24px]">
            {(() => {
              const dw = stats?.dailyWords || []
              const mx = Math.max(...dw, 1)
              return dw.map((v: number, i: number) => {
                const date = new Date()
                date.setDate(date.getDate() - (6 - i))
                return (
                  <div
                    key={`daily-word-${date.toISOString()}`}
                    className="flex-1 rounded-[1px] relative group"
                    style={{
                      height: `${Math.max((v / mx) * 22, v > 0 ? 2 : 0)}px`,
                      background: v > 0 ? 'var(--accent-gold)' : 'var(--canvas-mid)',
                      opacity: v > 0 ? 0.55 : 0.25,
                    }}
                  >
                    <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 text-[8px] font-mono text-[var(--ink-mute)] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      {v.toLocaleString()}
                    </span>
                  </div>
                )
              })
            })()}
          </div>
          <div className="flex gap-[1.5px] mt-[2px]">
            {(() => {
              const dw = stats?.dailyWords || []
              const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
              const today = new Date()
              return dw.map((_, i) => {
                const d = new Date(today)
                d.setDate(d.getDate() - (6 - i))
                return (
                  <div
                    key={`daily-label-${d.toISOString()}`}
                    className="flex-1 text-center text-[7px] text-[var(--ink-mute)] leading-none"
                  >
                    {days[d.getDay()].slice(0, 2)}
                  </div>
                )
              })
            })()}
          </div>
        </div>

        {/* Stats rows — compact */}
        <div className="flex justify-between py-[2px]">
          <span className="text-[var(--ink-mute)]">{t('sidebar.currentChapter')}</span>
          <span className="font-mono text-[var(--ink-tertiary)]">
            {displayedCurrentChapter?.wordCount?.toLocaleString() || '0'} {t('editor.words')}
          </span>
        </div>
        <div className="flex justify-between py-[2px]">
          <span className="text-[var(--ink-mute)]">{t('sidebar.totalWords')}</span>
          <span className="font-mono text-[var(--ink-tertiary)]">
            {(stats?.totalWords || 0).toLocaleString()} {t('editor.words')}
          </span>
        </div>
        <div className="flex justify-between py-[2px]">
          <span className="text-[var(--ink-mute)]">{t('sidebar.today')}</span>
          <span className="font-mono text-[var(--ink-tertiary)]">
            {(stats?.dailyWords?.[stats.dailyWords.length - 1] || 0).toLocaleString()} {t('editor.words')}
          </span>
        </div>
      </div>
    </aside>
  )
}

function StatusBadge({
  status,
  t: translate,
  onCycle,
}: {
  status: string
  t: (path: string, params?: Record<string, string | number>) => string
  onCycle?: () => void
}) {
  const colorMap: Record<string, { bg: string; text: string; label: string; dot?: boolean }> = {
    accepted: { bg: 'var(--success-soft)', text: 'var(--success)', label: translate('status.accepted') },
    review: { bg: 'var(--warning-soft)', text: 'var(--warning)', label: translate('status.review'), dot: true },
    writing: { bg: 'var(--info-soft)', text: 'var(--info)', label: translate('status.writing'), dot: true },
    pending: { bg: 'var(--pending-soft)', text: 'var(--pending)', label: translate('status.pending') },
  }
  const c = colorMap[status] || colorMap.pending
  return (
    /* biome-ignore lint/a11y/useSemanticElements: this status action is nested in an interactive chapter row. */
    <span
      className={`text-[10px] font-medium px-[7px] py-[1px] rounded-full font-sans shrink-0 inline-flex items-center gap-1 ${onCycle ? 'cursor-pointer hover:brightness-110' : ''}`}
      style={{ background: c.bg, color: c.text }}
      role="button"
      tabIndex={onCycle ? 0 : -1}
      onKeyDown={activateOnKeyDown}
      onClick={(e) => {
        if (onCycle) {
          e.stopPropagation()
          onCycle()
        }
      }}
      title={
        onCycle
          ? translate('sidebar.switchToStatus', { status: translate(`status.${NEXT_STATUS[status] || 'writing'}`) })
          : undefined
      }
    >
      {status === 'accepted' && <Check className="w-2.5 h-2.5" />}
      {c.dot && (
        <span
          className={`w-[6px] h-[6px] rounded-full ${status === 'writing' ? 'animate-pulse' : ''}`}
          style={{ background: c.text }}
        />
      )}
      {c.label}
    </span>
  )
}
