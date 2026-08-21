import { Pen } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ManuscriptStatusBanner } from '@/components/ManuscriptStatusBanner'
import { useT } from '@/hooks/useT'
import { shouldSynchronizeEditorDom } from '@/lib/editorAuthoritySync'
import { type EditorSaveIntent, runEditorSaveWithProtection } from '@/lib/editorSaveProtection'
import {
  editorSaveKey,
  enqueueEditorSave,
  flushEditorSave,
  getEditorSaveDraft,
  getEditorSaveFailure,
  getEditorSaveQueueSnapshot,
  subscribeEditorSaveQueue,
} from '@/lib/editorSaveQueue'
import { createManuscriptDirtyBinding, isManuscriptSaveProtected } from '@/lib/manuscriptDirtyResources'
import {
  discardTitleSave,
  flushTitleSave,
  getTitleSaveDraft,
  getTitleSaveFailure,
  getTitleSaveQueueSnapshot,
  setTitleSaveError,
  stageTitleSave,
  subscribeTitleSaveQueue,
  titleSaveKey,
} from '@/lib/titleSaveQueue'
import { useChapterStore } from '@/stores/useChapterStore'
import { useEditorStore } from '@/stores/useEditorStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useRevisionStore } from '@/stores/useRevisionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSidebarStore } from '@/stores/useSidebarStore'

function inlineToHtml(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
}

function getInlineText(el: HTMLElement): string {
  let result = ''
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent
    } else if (node instanceof HTMLElement) {
      const tag = node.tagName.toLowerCase()
      const inner = getInlineText(node)
      if (tag === 'b' || tag === 'strong') result += `**${inner}**`
      else if (tag === 'i' || tag === 'em') result += `*${inner}*`
      else if (tag === 'u') result += `__${inner}__`
      else if (tag === 'code') result += `\`${inner}\``
      else if (tag === 'br') result += '\n'
      else result += inner
    }
  }
  return result
}

function editorTargetKey(project: string, chapterId: number): string {
  return editorSaveKey(project, chapterId)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '保存失败')
}

export function EditorContent() {
  const { fontSize, fontFamily } = useEditorStore()
  const { currentChapter, volumes, updateChapter, createChapter, setSaveStatus } = useChapterStore()
  const chapterProject = useChapterStore((s) => s.projectName)
  const currentProject = useProjectStore((s) => s.currentProject)
  const loadRevision = useRevisionStore((s) => s.loadRevision)
  const revisionLoading = useRevisionStore((s) => s.loading)
  const revisionError = useRevisionStore((s) => s.error)
  const setActivePage = useSidebarStore((s) => s.setActivePage)
  const { t } = useT()
  const chapter = currentProject && chapterProject === currentProject ? currentChapter : null
  const chapterId = chapter?.id
  const operationLocked = useRevisionStore((state) =>
    state.editorLocks.some((lock) => lock.project === currentProject && lock.chapterId === chapterId),
  )
  // Until the active-revision lookup succeeds, editing would risk saving over
  // a revision that another window has already created or resolved.
  const revisionLocked = operationLocked || revisionLoading || Boolean(revisionError)
  const editorRef = useRef<HTMLDivElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleDraftRef = useRef('')
  const titleTargetRef = useRef<string | null>(null)
  const queuedTitleDraftRef = useRef<string | undefined>(undefined)
  const isEditingRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorTargetRef = useRef<{ project: string | null; chapterId: number | null }>({
    project: null,
    chapterId: null,
  })
  const syncedChapterDataVersionRef = useRef<number | null>(null)
  const savedContentByTargetRef = useRef(new Map<string, string>())
  const [isDirty, setIsDirty] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [actionError, setActionError] = useState<{ project: string; message: string } | null>(null)
  const saveQueueSnapshot = useSyncExternalStore(
    subscribeEditorSaveQueue,
    getEditorSaveQueueSnapshot,
    getEditorSaveQueueSnapshot,
  )
  const titleQueueSnapshot = useSyncExternalStore(
    subscribeTitleSaveQueue,
    getTitleSaveQueueSnapshot,
    getTitleSaveQueueSnapshot,
  )
  const activeTargetKey =
    chapterId && currentProject && chapterProject === currentProject ? editorTargetKey(currentProject, chapterId) : null
  const queuedDraftContent = activeTargetKey ? saveQueueSnapshot.drafts[activeTargetKey] : undefined
  const editorSaveError = activeTargetKey ? saveQueueSnapshot.errors[activeTargetKey] : undefined
  const activeTitleTargetKey =
    chapterId && currentProject && chapterProject === currentProject ? titleSaveKey(currentProject, chapterId) : null
  const queuedTitleDraft = activeTitleTargetKey ? titleQueueSnapshot.drafts[activeTitleTargetKey] : undefined
  const titleSaveError = activeTitleTargetKey ? titleQueueSnapshot.errors[activeTitleTargetKey] : undefined
  const editorSaveFailure = currentProject && chapterId ? getEditorSaveFailure(currentProject, chapterId) : null
  const titleSaveFailure = currentProject && chapterId ? getTitleSaveFailure(currentProject, chapterId) : null
  const manuscriptProtectionCode = [editorSaveFailure?.code, titleSaveFailure?.code].find(isManuscriptSaveProtected)
  const manuscriptProtectionMessage =
    manuscriptProtectionCode === editorSaveFailure?.code ? editorSaveFailure?.message : titleSaveFailure?.message
  const editorLocked = revisionLocked || Boolean(manuscriptProtectionCode)

  const allChapters = chapterProject === currentProject ? volumes.flatMap((v) => v.chapters) : []
  const hasChapters = allChapters.length > 0

  const handleNewChapter = async () => {
    if (!currentProject) return
    const project = currentProject
    setActionError(null)
    try {
      await createChapter(project, t('chapter.defaultTitle'))
      if (useProjectStore.getState().currentProject === project) setActivePage('page-writing')
    } catch (error) {
      if (useProjectStore.getState().currentProject === project) {
        setActionError({ project, message: getErrorMessage(error) })
      }
    }
  }

  // Parse content to HTML for display
  const renderContent = useCallback((content: string | undefined) => {
    if (!content) return ''
    const lines = content.split('\n').filter((l) => l.trim())
    return lines
      .map((line) => {
        if (line.startsWith('# ')) return `<h1>${inlineToHtml(line.slice(2))}</h1>`
        if (line.startsWith('## ')) return `<h2>${inlineToHtml(line.slice(3))}</h2>`
        if (line.startsWith('「') || line.startsWith('"')) {
          return `<p class="dialogue">${inlineToHtml(line)}</p>`
        }
        return `<p>${inlineToHtml(line)}</p>`
      })
      .join('')
  }, [])

  // Extract HTML editor content back to plain text with simple formatting markers
  const extractContent = useCallback((html: string): string => {
    const div = document.createElement('div')
    div.innerHTML = html
    const lines: string[] = []
    for (const child of div.children) {
      const tag = child.tagName.toLowerCase()
      if (tag === 'h1') lines.push(`# ${getInlineText(child as HTMLElement)}`)
      else if (tag === 'h2') lines.push(`## ${getInlineText(child as HTMLElement)}`)
      else if (tag === 'p') {
        const text = getInlineText(child as HTMLElement).trim()
        if (text) lines.push(text)
      } else if (tag === 'pre') {
        lines.push('```')
        lines.push((child as HTMLElement).textContent || '')
        lines.push('```')
      } else if (tag === 'hr') {
        lines.push('---')
      }
    }
    if (lines.length === 0) {
      const text = getInlineText(div).trim()
      if (text) lines.push(text)
    }
    return lines.join('\n')
  }, [])

  // Persist editor content to the process-wide queue. The queue outlives this
  // component, so a failed blur save remains recoverable after navigation.
  const doSave = useCallback(
    (intent: EditorSaveIntent = 'automatic'): Promise<void> => {
      const pn = useProjectStore.getState().currentProject
      const chapterState = useChapterStore.getState()
      const ch = chapterState.currentChapter
      const chNum = ch?.num
      const editorTarget = editorTargetRef.current
      if (
        !pn ||
        !ch ||
        !chNum ||
        !editorRef.current ||
        chapterState.projectName !== pn ||
        editorTarget.project !== pn ||
        editorTarget.chapterId !== ch.id
      ) {
        return Promise.resolve()
      }
      const protectionFailure =
        [getEditorSaveFailure(pn, ch.id), getTitleSaveFailure(pn, ch.id)].find((failure) =>
          isManuscriptSaveProtected(failure?.code),
        ) ?? null
      if (protectionFailure) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        return runEditorSaveWithProtection(protectionFailure, intent, async () => {})
      }

      const html = editorRef.current.innerHTML
      const textContent = editorRef.current.textContent?.trim() || ''
      const markdown = textContent === '' ? '' : extractContent(html)
      const targetKey = editorTargetKey(pn, ch.id)

      const isActiveTarget = () => {
        const activeProject = useProjectStore.getState().currentProject
        const activeChapterState = useChapterStore.getState()
        const activeTarget = editorTargetRef.current
        return (
          activeProject === pn &&
          activeChapterState.projectName === pn &&
          activeChapterState.currentChapter?.id === ch.id &&
          activeTarget.project === pn &&
          activeTarget.chapterId === ch.id
        )
      }

      const readActiveSnapshot = () => {
        if (!isActiveTarget() || !editorRef.current) return null
        const currentText = editorRef.current.textContent?.trim() || ''
        return currentText === '' ? '' : extractContent(editorRef.current.innerHTML)
      }

      const lastSavedContent = savedContentByTargetRef.current.get(targetKey) ?? ch.content ?? ''
      const queuedDraft = getEditorSaveDraft(pn, ch.id)
      if (queuedDraft?.content !== markdown && (queuedDraft || markdown !== lastSavedContent)) {
        enqueueEditorSave(
          pn,
          ch.id,
          chNum,
          markdown,
          ch.dataVersion,
          createManuscriptDirtyBinding(ch, 'body'),
          ch.baseWitness,
        )
      }

      const persistSnapshot = async () => {
        if (getEditorSaveDraft(pn, ch.id)) {
          if (isActiveTarget()) setSaveStatus('saving')
          try {
            await flushEditorSave(pn, ch.id, async (entry) => {
              const persistedDataVersion = await updateChapter(
                entry.project,
                entry.chapterNum,
                { content: entry.content },
                entry.chapterId,
                entry.baseDataVersion,
                entry.baseWitness,
              )
              savedContentByTargetRef.current.set(targetKey, entry.content)
              return persistedDataVersion
            })
          } catch (error) {
            if (isActiveTarget()) {
              setIsDirty(true)
              setSaveStatus('unsaved')
            }
            throw error
          }
        }

        if (isActiveTarget()) {
          const currentSnapshot = readActiveSnapshot()
          const activeChapter = useChapterStore.getState().currentChapter
          const persistedContent = activeChapter?.id === ch.id ? activeChapter.content || '' : null
          const fullySaved =
            !getEditorSaveDraft(pn, ch.id) && currentSnapshot !== null && currentSnapshot === persistedContent
          setIsDirty(!fullySaved)
          setSaveStatus(fullySaved ? 'saved' : 'unsaved')
        }
      }

      return persistSnapshot()
    },
    [updateChapter, setSaveStatus, extractContent],
  ) // no longer depends on chapter/currentProject

  useEffect(() => {
    const flushEditor = (event: Event) => {
      const detail = (event as CustomEvent<{ lock?: boolean; resolve?: () => void; reject?: (error: unknown) => void }>)
        .detail
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      isEditingRef.current = false
      if (detail?.lock && editorRef.current) editorRef.current.contentEditable = 'false'
      void doSave('explicit').then(
        () => detail?.resolve?.(),
        (error) => detail?.reject?.(error),
      )
    }
    window.addEventListener('mythpen:flush-editor', flushEditor)
    return () => window.removeEventListener('mythpen:flush-editor', flushEditor)
  }, [doSave])

  // Debounced auto-save — reads autoSaveInterval from settings
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave

  const scheduleAutosave = useCallback(() => {
    const interval = useSettingsStore.getState().settings.autoSaveInterval
    if (!interval || interval <= 0) return // auto-save disabled
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      void doSaveRef.current().catch(() => {})
    }, interval * 1000)
  }, []) // stable — reads doSave and settings through refs

  useEffect(() => {
    if (!manuscriptProtectionCode || !saveTimerRef.current) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
  }, [manuscriptProtectionCode])

  // Sync editor content from store when chapter changes
  const syncContent = useCallback(() => {
    if (!editorRef.current) return
    if (!chapter) {
      editorRef.current.innerHTML = ''
      editorTargetRef.current = { project: currentProject, chapterId: null }
      syncedChapterDataVersionRef.current = null
      return
    }
    const displayedContent = queuedDraftContent ?? chapter.content ?? ''
    editorRef.current.innerHTML = displayedContent ? renderContent(displayedContent) : ''
    if (editorRef.current.innerHTML) {
      editorRef.current.removeAttribute('data-placeholder')
    } else {
      editorRef.current.setAttribute('data-placeholder', t('editor.startWriting'))
    }
    savedContentByTargetRef.current.set(editorTargetKey(currentProject || '', chapter.id), chapter.content || '')
    editorTargetRef.current = { project: currentProject, chapterId: chapter.id }
    syncedChapterDataVersionRef.current = chapter.dataVersion
  }, [chapter, currentProject, queuedDraftContent, t, renderContent])

  // Watch chapter changes (switching chapters) and external content updates (AI generation)
  useLayoutEffect(() => {
    const previousTarget = editorTargetRef.current
    const targetChanged = previousTarget.project !== currentProject || previousTarget.chapterId !== (chapterId ?? null)
    const chapterDataVersionChanged = syncedChapterDataVersionRef.current !== (chapter?.dataVersion ?? null)
    if (targetChanged) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      isEditingRef.current = false
      if (
        previousTarget.project &&
        previousTarget.chapterId &&
        getEditorSaveDraft(previousTarget.project, previousTarget.chapterId)
      ) {
        const previousKey = editorTargetKey(previousTarget.project, previousTarget.chapterId)
        void flushEditorSave(previousTarget.project, previousTarget.chapterId, async (entry) => {
          const persistedDataVersion = await updateChapter(
            entry.project,
            entry.chapterNum,
            { content: entry.content },
            entry.chapterId,
            entry.baseDataVersion,
            entry.baseWitness,
          )
          savedContentByTargetRef.current.set(previousKey, entry.content)
          return persistedDataVersion
        }).catch(() => {})
      }
    }
    // A revision lookup gates the editor before it may replace a stale chapter
    // snapshot. Force the DOM to follow the store while that gate is held even
    // if the editor still owns focus; otherwise the store can be authoritative
    // while the old focused DOM is saved back after the gate opens. A queued
    // draft remains preferred by syncContent, so this does not discard failed
    // or not-yet-persisted local input.
    if (
      shouldSynchronizeEditorDom({
        targetChanged,
        editorLocked,
        isEditing: isEditingRef.current,
        chapterDataVersionChanged,
      })
    ) {
      syncContent()
      const hasUnsavedDraft =
        queuedDraftContent !== undefined ||
        (chapterId !== undefined && currentProject !== null && getTitleSaveDraft(currentProject, chapterId) !== null)
      setIsDirty(hasUnsavedDraft)
      setSaveStatus(hasUnsavedDraft ? 'unsaved' : 'saved')
    }
  }, [chapter, chapterId, currentProject, editorLocked, queuedDraftContent, syncContent, setSaveStatus, updateChapter])

  useEffect(() => {
    if (!activeTargetKey) return
    const hasRecoverableDraft = queuedDraftContent !== undefined || queuedTitleDraft !== undefined
    setSaveStatus(hasRecoverableDraft ? 'unsaved' : 'saved')
  }, [activeTargetKey, queuedDraftContent, queuedTitleDraft, setSaveStatus])

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    },
    [],
  )

  // Mark unsaved when user starts editing
  useEffect(() => {
    if (isDirty) setSaveStatus('unsaved')
  }, [isDirty, setSaveStatus])

  // Save on blur (immediate, no debounce)
  const handleBlur = useCallback(() => {
    isEditingRef.current = false
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    void doSave().catch(() => {})
  }, [doSave])

  // Schedule auto-save on each keystroke
  const handleInput = useCallback(() => {
    if (editorLocked) return
    isEditingRef.current = true
    setIsDirty(true)
    if (editorRef.current?.hasAttribute('data-placeholder')) {
      editorRef.current.removeAttribute('data-placeholder')
    }
    const pn = useProjectStore.getState().currentProject
    const chapterState = useChapterStore.getState()
    const activeChapter = chapterState.currentChapter
    const editorTarget = editorTargetRef.current
    if (
      pn &&
      activeChapter &&
      editorRef.current &&
      chapterState.projectName === pn &&
      editorTarget.project === pn &&
      editorTarget.chapterId === activeChapter.id
    ) {
      const currentText = editorRef.current.textContent?.trim() || ''
      const content = currentText === '' ? '' : extractContent(editorRef.current.innerHTML)
      enqueueEditorSave(
        pn,
        activeChapter.id,
        activeChapter.num,
        content,
        activeChapter.dataVersion,
        createManuscriptDirtyBinding(activeChapter, 'body'),
        activeChapter.baseWitness,
      )
    }
    scheduleAutosave()
  }, [editorLocked, extractContent, scheduleAutosave])

  // Auto-focus editor when writing page becomes visible
  const activePage = useSidebarStore((s) => s.activePage)
  const retryEditorSave = useCallback(() => {
    if (manuscriptProtectionCode) return
    void doSave().catch(() => {})
  }, [doSave, manuscriptProtectionCode])

  useEffect(() => {
    const retry = () => {
      if (useSidebarStore.getState().activePage === 'page-writing') retryEditorSave()
    }
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    return () => {
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
    }
  }, [retryEditorSave])

  useEffect(() => {
    if (activePage === 'page-writing' && editorSaveError && !manuscriptProtectionCode) retryEditorSave()
  }, [activePage, editorSaveError, manuscriptProtectionCode, retryEditorSave])

  useEffect(() => {
    if (chapter && editorRef.current && activePage === 'page-writing' && !editorLocked) {
      const timer = setTimeout(() => editorRef.current?.focus(), 100)
      return () => clearTimeout(timer)
    }
  }, [chapter?.id, activePage, chapter, editorLocked])

  const handleFocus = useCallback(() => {
    if (editorLocked) return
    isEditingRef.current = true
  }, [editorLocked])

  // Title edit handlers
  const handleTitleClick = useCallback(() => {
    if (editorLocked) return
    const queued = currentProject && chapterId ? getTitleSaveDraft(currentProject, chapterId) : null
    const nextDraft = queued?.title ?? chapter?.title ?? ''
    titleDraftRef.current = nextDraft
    setEditingTitle(true)
    setTitleDraft(nextDraft)
  }, [chapter?.title, chapterId, currentProject, editorLocked])

  useEffect(() => {
    const targetChanged = titleTargetRef.current !== activeTitleTargetKey
    const hadQueuedDraft = queuedTitleDraftRef.current !== undefined
    titleTargetRef.current = activeTitleTargetKey
    queuedTitleDraftRef.current = queuedTitleDraft
    if (!activeTitleTargetKey) {
      setEditingTitle(false)
      titleDraftRef.current = ''
      setTitleDraft('')
      return
    }

    if (queuedTitleDraft !== undefined) {
      titleDraftRef.current = queuedTitleDraft
      setTitleDraft(queuedTitleDraft)
      setEditingTitle(true)
      if (titleSaveError) queueMicrotask(() => titleInputRef.current?.focus())
    } else if (targetChanged || hadQueuedDraft) {
      setEditingTitle(false)
    }
  }, [activeTitleTargetKey, queuedTitleDraft, titleSaveError])

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus()
  }, [editingTitle])

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const nextTitle = e.target.value
      titleDraftRef.current = nextTitle
      setTitleDraft(nextTitle)

      const project = useProjectStore.getState().currentProject
      const chapterState = useChapterStore.getState()
      const activeChapter = chapterState.currentChapter
      if (
        project &&
        activeChapter &&
        chapterState.projectName === project &&
        project === currentProject &&
        activeChapter.id === chapterId
      ) {
        stageTitleSave(
          project,
          activeChapter.id,
          activeChapter.num,
          nextTitle,
          createManuscriptDirtyBinding(activeChapter, 'sidecar'),
          activeChapter.baseWitness,
        )
        setSaveStatus('unsaved')
      }
    },
    [chapterId, currentProject, setSaveStatus],
  )

  const handleTitleSave = useCallback(async () => {
    if (!currentProject || !chapter || chapterProject !== currentProject) return
    const rawTitle = titleDraftRef.current
    const title = rawTitle.trim()
    let entry = getTitleSaveDraft(currentProject, chapter.id)
    const hadQueuedSave = entry !== null
    if (!entry || entry.title !== rawTitle || entry.chapterNum !== chapter.num) {
      entry = stageTitleSave(
        currentProject,
        chapter.id,
        chapter.num,
        rawTitle,
        createManuscriptDirtyBinding(chapter, 'sidecar'),
        chapter.baseWitness,
      )
    }
    if (!title) {
      const error = t('common.requiredField', { label: t('pages.name') })
      setTitleSaveError(currentProject, chapter.id, entry.version, error)
      setEditingTitle(true)
      setSaveStatus('unsaved')
      return
    }
    if (title === chapter.title && !hadQueuedSave) {
      discardTitleSave(currentProject, chapter.id)
      setEditingTitle(false)
      return
    }
    try {
      await flushTitleSave(currentProject, chapter.id, async (save) => {
        await updateChapter(
          save.project,
          save.chapterNum,
          { title: save.title.trim() },
          save.chapterId,
          save.baseWitness?.expected_data_version,
          save.baseWitness,
        )
      })
      const remainingDraft = getTitleSaveDraft(currentProject, chapter.id)
      if (
        !remainingDraft &&
        titleDraftRef.current === rawTitle &&
        useProjectStore.getState().currentProject === currentProject &&
        useChapterStore.getState().projectName === currentProject &&
        useChapterStore.getState().currentChapter?.id === chapter.id
      ) {
        setEditingTitle(false)
      }
    } catch {
      const failedDraft = getTitleSaveDraft(currentProject, chapter.id)
      if (
        failedDraft?.version === entry.version &&
        titleDraftRef.current === entry.title &&
        useProjectStore.getState().currentProject === currentProject &&
        useChapterStore.getState().projectName === currentProject &&
        useChapterStore.getState().currentChapter?.id === chapter.id
      ) {
        setEditingTitle(true)
        setSaveStatus('unsaved')
        queueMicrotask(() => titleInputRef.current?.focus())
      }
    }
  }, [chapter, chapterProject, currentProject, setSaveStatus, t, updateChapter])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        ;(e.target as HTMLInputElement).blur()
      }
      if (e.key === 'Escape') {
        if (currentProject && chapterId) discardTitleSave(currentProject, chapterId)
        setEditingTitle(false)
      }
    },
    [chapterId, currentProject],
  )

  return (
    <div className="flex-1 overflow-y-auto px-16 pb-32 pt-12 flex justify-center custom-scrollbar">
      <div
        className="w-full max-w-[var(--editor-max-w)] leading-[1.9] tracking-[0.01em]"
        style={{ fontFamily, fontSize: `${fontSize}px`, color: 'var(--ink)' }}
      >
        {chapter ? (
          <>
            {editingTitle ? (
              <input
                ref={titleInputRef}
                className="font-display text-[36px] font-semibold leading-[1.25] tracking-[-0.01em] mb-[1.5em] w-full bg-transparent border-none outline-none text-[var(--ink)]"
                style={{ fontFamily }}
                value={titleDraft}
                disabled={editorLocked}
                onChange={handleTitleChange}
                onBlur={handleTitleSave}
                onKeyDown={handleTitleKeyDown}
              />
            ) : (
              <button
                type="button"
                className="font-display text-left text-[36px] font-semibold leading-[1.25] tracking-[-0.01em] mb-[1.5em] cursor-pointer border-none bg-transparent p-0 text-[var(--ink)] hover:text-[var(--accent-gold)] transition-colors"
                onClick={handleTitleClick}
                title={t('editor.clickToEditTitle')}
                disabled={editorLocked}
              >
                {t('sidebar.chapterTitle', { num: chapter.num, title: chapter.title })}
              </button>
            )}
            {manuscriptProtectionCode && (
              <ManuscriptStatusBanner code={manuscriptProtectionCode} message={manuscriptProtectionMessage} />
            )}
            {!manuscriptProtectionCode && (revisionError || titleSaveError || editorSaveError) && (
              <div
                className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-3 py-2 text-[13px] text-[var(--danger)]"
                role="alert"
              >
                <span>{revisionError || titleSaveError || editorSaveError}</span>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer border-none bg-transparent font-medium text-inherit underline underline-offset-2"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (revisionError && currentProject && chapterId) void loadRevision(currentProject, chapterId)
                    else if (titleSaveError) void handleTitleSave()
                    else retryEditorSave()
                  }}
                >
                  {t('serverStatus.retry')}
                </button>
              </div>
            )}
            {revisionLoading && !revisionError && (
              <div
                className="mb-5 rounded-lg border border-[var(--hairline)] bg-[var(--canvas-soft)] px-3 py-2 text-[13px] text-[var(--ink-tertiary)]"
                role="status"
              >
                {t('editor.revisionSaving')}
              </div>
            )}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: contentEditable is the rich text editor control. */}
            <div
              ref={editorRef}
              className="editor-body outline-none cursor-text"
              contentEditable={!editorLocked}
              aria-busy={revisionLoading}
              suppressContentEditableWarning
              onBlur={handleBlur}
              onInput={handleInput}
              onFocus={handleFocus}
            />
          </>
        ) : (
          <div className="text-center pt-20">
            <p className="text-[var(--ink-mute)] mb-4">
              {hasChapters ? t('editor.chooseChapter') : t('editor.noChaptersYet')}
            </p>
            <button
              type="button"
              className="h-[36px] px-6 rounded-lg border-none bg-[var(--accent-gold)] text-[var(--canvas)] font-medium text-[14px] cursor-pointer transition-colors hover:bg-[var(--accent-gold-soft)]"
              onClick={handleNewChapter}
            >
              <span className="inline-flex items-center gap-1.5">
                {hasChapters ? (
                  t('editor.newChapter')
                ) : (
                  <>
                    <Pen className="w-3.5 h-3.5" /> {t('editor.writeFirst')}
                  </>
                )}
              </span>
            </button>
            {actionError?.project === currentProject && (
              <p className="mt-3 text-[13px] text-[var(--danger)]" role="alert">
                {actionError.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
