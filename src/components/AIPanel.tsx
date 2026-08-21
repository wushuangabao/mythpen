import { Lightbulb, Loader, MessageSquare, Plus, SendHorizonal, ShieldCheck, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MarkdownContent } from '@/components/MarkdownContent'
import { ToastContainer } from '@/components/ToastContainer'
import { useT } from '@/hooks/useT'
import { useToast } from '@/hooks/useToast'
import { aiApi, chatApi } from '@/lib/api'
import { getModifiedEntities, notifyDataChanged } from '@/lib/dataEvents'
import { enqueueEditorSave } from '@/lib/editorSaveQueue'
import {
  discardRecoverableProjectDraft,
  formatRecoverableProjectDraft,
  getProjectDraftRecoverySnapshot,
  isMatchingProjectDraftTarget,
  type RecoverableProjectDraft,
  subscribeProjectDraftRecovery,
} from '@/lib/projectDraftRecovery'
import { getProjectInstanceId } from '@/lib/projectInstanceRegistry'
import { stageTitleSave } from '@/lib/titleSaveQueue'
import { useProjectInstanceId, useProjectName } from '@/lib/useProjectData'
import { clearAgentTaskAbort, registerAgentTaskAbort, useAgentStore } from '@/stores/useAgentStore'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useUIStore } from '@/stores/useUIStore'

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const abortError = error as { name?: string; code?: string }
  return abortError.name === 'AbortError' || abortError.code === 'ABORT_ERR'
}

export function AIPanel() {
  const {
    messages,
    isRunning,
    loading,
    sessions,
    currentSessionId,
    activateProject,
    setTask,
    addMessageToSession,
    loadSessions,
    createSession,
    switchSession,
    deleteSession,
    updateSessionTitle,
    cancelTask,
  } = useAgentStore()
  const currentChapter = useChapterStore((s) => s.currentChapter)
  const project = useProjectName()
  const projectInstanceId = useProjectInstanceId()
  const [input, setInput] = useState('')
  const [streamText, setStreamText] = useState('')
  const [taskName, setTaskName] = useState('')
  const [genTokens, setGenTokens] = useState(0)
  const [showConsistency, setShowConsistency] = useState(() => !localStorage.getItem('mythpen-hide-consistency'))
  const abortRef = useRef<AbortController | null>(null)
  const msgEndRef = useRef<HTMLDivElement | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef('')
  const runningRef = useRef(false)
  const requestGenerationRef = useRef(0)
  const activeProjectRef = useRef<string | null>(null)
  const activeProjectInstanceRef = useRef<string | null>(null)
  const activeSessionRef = useRef<string | null>(null)
  const msgIdCounter = useRef(0)
  const sessionsLoadedRef = useRef(false)
  const resizingRef = useRef(false)
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth)
  const [mode, setMode] = useState<'writing' | 'collab'>('collab')
  const [toolCalls, setToolCalls] = useState<any[]>([])
  const toolCallsRef = useRef<any[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { toasts, show: showToast } = useToast()
  const { t } = useT()
  const draftRecoverySnapshot = useSyncExternalStore(
    subscribeProjectDraftRecovery,
    getProjectDraftRecoverySnapshot,
    getProjectDraftRecoverySnapshot,
  )
  const recoverableDrafts = draftRecoverySnapshot.entries.filter((draft) => draft.project === project)
  const scrollState = `${messages.map((message) => message.id).join(':')}|${streamText.length}|${toolCalls
    .map((toolCall) => `${toolCall.id}:${toolCall.status}`)
    .join(':')}`

  // Resize handle drag logic
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      resizingRef.current = true
      const startX = e.clientX
      const startWidth =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--right-panel-w')) || 320

      const handleMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return
        const delta = startX - ev.clientX // drag left = widen, drag right = narrow
        const newWidth = startWidth + delta
        setRightPanelWidth(newWidth)
      }

      const handleMouseUp = () => {
        resizingRef.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [setRightPanelWidth],
  )

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

      event.preventDefault()
      const currentWidth =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--right-panel-w')) || 320
      setRightPanelWidth(currentWidth + (event.key === 'ArrowLeft' ? 20 : -20))
    },
    [setRightPanelWidth],
  )

  // Generate AI title for a new session based on first exchange
  const generateAITitle = useCallback(
    async (sessionId: string, userMsg: string, aiResponse?: string) => {
      if (!project) return
      const titleInstanceId = getProjectInstanceId(project)
      if (!titleInstanceId) return
      // Only generate if current title is still a timestamp placeholder
      const currentSession = sessions.find((session) => session.id === sessionId)
      if (!currentSession) return
      const isPlaceholder =
        currentSession.title?.startsWith('对话 ') ||
        currentSession.title?.startsWith('新会话 ') ||
        currentSession.title?.startsWith('New Session ')
      if (!isPlaceholder) return

      try {
        const context = aiResponse ? `用户: ${userMsg}\nAI: ${aiResponse}` : `用户: ${userMsg}`
        const prompt = t('ai.titleGenPrompt', { context })
        const res = await aiApi.chat([{ role: 'user', content: prompt }], project)
        if (getProjectInstanceId(project) !== titleInstanceId) return
        const title = (res.choices?.[0]?.message?.content || '').trim().replace(/["""「」]/g, '')
        if (title && title.length <= 20) {
          await updateSessionTitle(project, sessionId, title)
        }
      } catch {
        // Silently fail — timestamp title stays as fallback
      }
    },
    [project, sessions, updateSessionTitle, t],
  )

  // Unique message ID generator
  const nextMsgId = () => `${Date.now()}-${++msgIdCounter.current}`

  // Persist to the immutable request session, never whichever session happens
  // to be selected when an asynchronous callback eventually runs.
  const saveMsg = (
    targetProject: string,
    sessionId: string,
    data: { role: 'user' | 'ai' | 'system'; content: string },
  ) => {
    return chatApi
      .save(targetProject, { ...data, session_id: sessionId })
      .catch((e) => console.warn('[AIPanel] Failed to save message:', e))
  }

  // Auto-scroll to bottom when messages, streamed text, or tool calls change.
  useEffect(() => {
    if (scrollState === '|0|') return
    if (msgEndRef.current && scrollContainerRef.current) {
      // Use direct scrollTop for reliable scrolling (scrollIntoView can fail in nested scroll contexts)
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
    }
  }, [scrollState])

  // Load sessions and messages when project changes, auto-create session if none exists
  useEffect(() => {
    if (!project || !projectInstanceId) return
    sessionsLoadedRef.current = false
    // Establish ownership before any async store method starts. Every commit
    // below is then scoped to this immutable project instance.
    activateProject(project, projectInstanceId)
    loadSessions(project).then(() => {
      // Guard: ignore stale completions — captured project must match the current real project
      const currentProject = useProjectStore.getState().currentProject
      if (project !== currentProject || getProjectInstanceId(project) !== projectInstanceId) return
      sessionsLoadedRef.current = true
      const state = useAgentStore.getState()
      if (state.project !== project || state.projectInstanceId !== projectInstanceId) return
      if (state.sessions.length === 0) {
        // No sessions exist — create one
        const now = new Date()
        const ts = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
        void createSession(currentProject, t('ai.newSessionTemplate', { ts }))
      } else if (state.messages.length === 0) {
        // Session already selected (by loadSessions) — load messages
        useAgentStore.getState().loadMessages(project)
      }
    })
  }, [project, projectInstanceId, activateProject, loadSessions, t, createSession])

  // Tool type detection for colored indicators
  const getToolType = (name: string): 'read' | 'create' | 'update' | 'delete' => {
    if (name.startsWith('list_') || name.startsWith('get_')) return 'read'
    if (name.startsWith('create_')) return 'create'
    if (name.startsWith('update_')) return 'update'
    if (name.startsWith('delete_')) return 'delete'
    return 'read'
  }
  const toolTypeColor: Record<string, string> = {
    read: 'var(--info)',
    create: 'var(--success)',
    update: 'var(--warning)',
    delete: 'var(--error)',
  }

  // Format tool arguments for compact display
  const formatToolArgs = (args: any) => {
    if (!args || Object.keys(args).length === 0) return t('ai.noParams')
    const entries = Object.entries(args).slice(0, 2)
    return entries
      .map(
        ([k, v]) => `${k}=${typeof v === 'string' ? (v.length > 20 ? `${v.slice(0, 20)}...` : v) : JSON.stringify(v)}`,
      )
      .join(', ')
  }

  const refreshToolMutations = useCallback((calls: Array<{ name: string }>, targetProject: string | null) => {
    const entities = getModifiedEntities(calls.map((toolCall) => toolCall.name))
    for (const entity of entities) notifyDataChanged(entity)

    const reloads: Promise<unknown>[] = []
    if (targetProject && entities.some((entity) => entity === 'chapter' || entity === 'volume' || entity === 'all')) {
      // No chapter data-event subscriber exists. Reload the full list so a
      // deleted current chapter is also removed instead of preserving a stale
      // detail after a 404.
      const chapterStore = useChapterStore.getState()
      chapterStore.invalidateChapterStructure(targetProject)
      reloads.push(chapterStore.loadChapters(targetProject))
    }
    if (entities.some((entity) => entity === 'project' || entity === 'all')) {
      reloads.push(useProjectStore.getState().loadProjects())
    }
    return Promise.allSettled(reloads)
  }, [])

  const done = useCallback(() => {
    clearAgentTaskAbort(activeProjectRef.current || undefined, activeProjectInstanceRef.current || undefined)
    runningRef.current = false
    abortRef.current = null
    activeProjectRef.current = null
    activeProjectInstanceRef.current = null
    activeSessionRef.current = null
    setStreamText('')
    setTaskName('')
    streamRef.current = ''
    setToolCalls([])
    toolCallsRef.current = []
  }, [])

  const stopTask = () => {
    const issuedToolCalls = [...toolCallsRef.current]
    const targetProject = activeProjectRef.current || project
    const targetInstanceId = activeProjectInstanceRef.current
    requestGenerationRef.current += 1
    if (abortRef.current) {
      abortRef.current?.abort()
      abortRef.current = null
    }
    if (targetProject && targetInstanceId && getProjectInstanceId(targetProject) === targetInstanceId) {
      void refreshToolMutations(issuedToolCalls, targetProject)
    }
    cancelTask()
    done()
  }

  useEffect(() => {
    const requestProject = activeProjectRef.current
    const requestInstanceId = activeProjectInstanceRef.current
    const requestSessionId = activeSessionRef.current
    if (
      !runningRef.current ||
      !requestProject ||
      (requestProject === project && requestInstanceId === projectInstanceId && requestSessionId === currentSessionId)
    )
      return

    const issuedToolCalls = [...toolCallsRef.current]
    requestGenerationRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    if (requestInstanceId && getProjectInstanceId(requestProject) === requestInstanceId) {
      void refreshToolMutations(issuedToolCalls, requestProject)
    }
    cancelTask()
    done()
  }, [project, projectInstanceId, currentSessionId, cancelTask, done, refreshToolMutations])

  useEffect(
    () => () => {
      const requestProject = activeProjectRef.current
      const requestInstanceId = activeProjectInstanceRef.current
      if (!runningRef.current || !requestProject) return

      const issuedToolCalls = [...toolCallsRef.current]
      requestGenerationRef.current += 1
      abortRef.current?.abort()
      abortRef.current = null
      if (requestInstanceId && getProjectInstanceId(requestProject) === requestInstanceId) {
        void refreshToolMutations(issuedToolCalls, requestProject)
      }
      cancelTask()
      runningRef.current = false
      activeProjectRef.current = null
      activeProjectInstanceRef.current = null
      activeSessionRef.current = null
      streamRef.current = ''
      toolCallsRef.current = []
    },
    [cancelTask, refreshToolMutations],
  )

  const handleSend = () => {
    if (!project || runningRef.current || !input.trim()) return
    const requestInstanceId = getProjectInstanceId(project)
    if (!requestInstanceId) return
    const agentState = useAgentStore.getState()
    if (loading || agentState.loading) return // wait for messages to finish loading
    const requestSessionId = agentState.currentSessionId
    if (!requestSessionId) return // wait for session to be created
    if (agentState.project !== project || agentState.projectInstanceId !== requestInstanceId) return
    runningRef.current = true
    activeProjectRef.current = project
    activeProjectInstanceRef.current = requestInstanceId
    activeSessionRef.current = requestSessionId
    const requestGeneration = ++requestGenerationRef.current
    const isCurrentRequest = () =>
      requestGeneration === requestGenerationRef.current &&
      useProjectStore.getState().currentProject === project &&
      getProjectInstanceId(project) === requestInstanceId &&
      useAgentStore.getState().currentSessionId === requestSessionId
    const userMsg = input.trim()
    const isChat = mode === 'collab'
    setTaskName(isChat ? t('ai.taskCollab') : t('ai.taskContinue'))
    setTask({ status: 'running' })
    setStreamText('')
    setGenTokens(0)
    streamRef.current = ''

    addMessageToSession(requestSessionId, { id: nextMsgId(), role: 'user', content: userMsg })
    saveMsg(project, requestSessionId, { role: 'user', content: userMsg }).catch(() => {})
    setInput('')
    // Force DOM clear — React 19 batch 处理后 onInput 事件可能恢复旧值
    const el = document.getElementById('ai-chat-input') as HTMLTextAreaElement | null
    if (el) el.value = ''

    const ch = currentChapter

    // Build chat history from stored messages.
    const chatHistory: any[] = messages.map((msg) => ({
      role: msg.role === 'ai' ? 'assistant' : (msg.role as 'user' | 'system'),
      content: msg.content,
    }))

    const context = isChat
      ? t('ai.collabPrompt', { project, num: ch?.num ?? 0, title: ch?.title ?? '', userMsg })
      : t('ai.writingPrompt', { project, num: ch?.num ?? 0, title: ch?.title ?? '', userMsg })

    const controller = aiApi.chatStream(
      [...chatHistory, { role: 'user', content: context }],
      project,
      // onChunk
      (text: string) => {
        if (!isCurrentRequest()) return
        streamRef.current += text
        setStreamText(streamRef.current)
        setGenTokens((prev) => prev + 1)
      },
      // onComplete
      async () => {
        if (!isCurrentRequest()) return
        setTask({ status: 'completed' })
        const fullText = streamRef.current
        const defaultMsg = isChat ? t('ai.dialogComplete') : t('ai.execComplete')
        const completedToolCalls = [...toolCallsRef.current]
        const aiMsg = {
          role: 'ai' as const,
          content: fullText || defaultMsg,
          toolCalls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
        }
        addMessageToSession(requestSessionId, { id: nextMsgId(), ...aiMsg })
        saveMsg(project, requestSessionId, aiMsg).catch(() => {})
        const refreshPromise = refreshToolMutations(completedToolCalls, project)
        requestGenerationRef.current += 1
        done()
        if (fullText) {
          showToast(t('ai.responseComplete'), 'success')
        }
        generateAITitle(requestSessionId, userMsg, fullText || undefined)
        await refreshPromise
      },
      // onError
      (err: any) => {
        if (!isCurrentRequest() || !runningRef.current) return
        const issuedToolCalls = [...toolCallsRef.current]
        void refreshToolMutations(issuedToolCalls, project)
        requestGenerationRef.current += 1
        if (isAbortError(err)) {
          cancelTask()
          done()
          return
        }
        setTask({ status: 'error' })
        if (!isChat) showToast(t('ai.chatError'), 'error')
        const errMsg = { role: 'ai' as const, content: t('ai.errorPrefix', { msg: err.error || err }) }
        addMessageToSession(requestSessionId, { id: nextMsgId(), ...errMsg })
        saveMsg(project, requestSessionId, errMsg).catch(() => {})
        done()
      },
      mode,
      (tc: any) => {
        if (!isCurrentRequest()) return
        const updated = [...toolCallsRef.current, { ...tc, status: 'running' }]
        toolCallsRef.current = updated
        setToolCalls(updated)
      },
      (tr: any) => {
        if (!isCurrentRequest()) return
        const updated = toolCallsRef.current.map((tc) =>
          tc.id === tr.id ? { ...tc, result: tr.result, status: 'done' } : tc,
        )
        toolCallsRef.current = updated
        setToolCalls(updated)
      },
    )
    abortRef.current = controller
    registerAgentTaskAbort(project, requestInstanceId, () => {
      requestGenerationRef.current += 1
      controller.abort()
    })
  }

  const copyRecoverableDraft = async (draft: RecoverableProjectDraft) => {
    try {
      await navigator.clipboard.writeText(formatRecoverableProjectDraft(draft))
      showToast(t('ai.projectDraftCopied'), 'success')
    } catch {
      showToast(t('ai.projectDraftCopyFailed'), 'error')
    }
  }

  const findRecoveryTarget = (draft: RecoverableProjectDraft) =>
    useChapterStore
      .getState()
      .volumes.flatMap((volume) => volume.chapters)
      .find((chapter) => isMatchingProjectDraftTarget(draft, chapter))

  const restoreRecoverableDraft = (draft: RecoverableProjectDraft) => {
    if (!project || !projectInstanceId || getProjectInstanceId(project) !== projectInstanceId) return
    const targetChapter = findRecoveryTarget(draft)
    if (!targetChapter) {
      showToast(t('ai.projectDraftChapterMissing'), 'error')
      return
    }
    if (
      !window.confirm(
        t('ai.projectDraftRestoreConfirm', { chapter: targetChapter.num, title: targetChapter.title || '' }),
      )
    )
      return

    // This is deliberately the only replay path. It stages an unsaved overlay
    // for the current instance; it does not issue a network write by itself.
    if (draft.content !== undefined) {
      enqueueEditorSave(
        project,
        draft.chapterId,
        draft.chapterNum,
        draft.content,
        targetChapter.dataVersion,
        undefined,
        targetChapter.baseWitness,
      )
    }
    if (draft.title !== undefined) {
      stageTitleSave(project, draft.chapterId, draft.chapterNum, draft.title, undefined, targetChapter.baseWitness)
    }
    showToast(t('ai.projectDraftRestored'), 'success')
  }

  const discardRecoverableDraft = (draft: RecoverableProjectDraft) => {
    if (!window.confirm(t('ai.projectDraftDiscardConfirm'))) return
    discardRecoverableProjectDraft(draft.recoveryId)
  }

  return (
    <aside className="w-[var(--right-panel-w)] bg-[var(--canvas-soft)] border-l border-[var(--hairline)] shrink-0 flex flex-col min-h-0 relative">
      {/* Resize handle */}
      <button
        type="button"
        className="absolute left-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 border-0 bg-transparent p-0 transition-colors hover:bg-[var(--accent-gold)] active:bg-[var(--accent-gold)]"
        aria-label="Resize AI panel"
        onMouseDown={handleResizeMouseDown}
        onKeyDown={handleResizeKeyDown}
      />
      {/* Fixed header area */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        {/* Header */}
        <div className="pb-3">
          <div className="flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4" />
            <h3 className="text-[11px] font-medium text-[var(--ink-mute)] tracking-[0.06em] uppercase font-sans">
              {t('ai.assistant')}
            </h3>
            <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-[2px] rounded-full bg-[var(--canvas-card)] border border-[var(--hairline)] text-[10px]">
              <span
                className={`w-[7px] h-[7px] rounded-full shrink-0 inline-block ${
                  isRunning ? 'bg-[var(--warning)] animate-pulse' : 'bg-[var(--success)]'
                }`}
                style={
                  isRunning
                    ? { boxShadow: '0 0 0 2px rgba(212,160,64,0.2)' }
                    : { boxShadow: '0 0 0 2px rgba(76,175,125,0.2)' }
                }
              />
              {isRunning ? t('ai.generating') : project || t('ai.idle')}
            </span>
          </div>
          {/* Mode toggle */}
          <div className="flex mt-2 bg-[var(--canvas-card)] rounded-[var(--radius-sm)] p-[2px] border border-[var(--hairline)]">
            <button
              type="button"
              className={`flex-1 h-[26px] rounded-[4px] text-[12px] font-medium transition-colors cursor-pointer border-none ${
                mode === 'collab'
                  ? 'bg-[var(--accent-gold)] text-[var(--canvas)]'
                  : 'bg-transparent text-[var(--ink-tertiary)] hover:text-[var(--ink)]'
              }`}
              onClick={() => setMode('collab')}
            >
              {t('ai.modeCollab')}
            </button>
            <button
              type="button"
              className={`flex-1 h-[26px] rounded-[4px] text-[12px] font-medium transition-colors cursor-pointer border-none ${
                mode === 'writing'
                  ? 'bg-[var(--accent-gold)] text-[var(--canvas)]'
                  : 'bg-transparent text-[var(--ink-tertiary)] hover:text-[var(--ink)]'
              }`}
              onClick={() => setMode('writing')}
            >
              {t('ai.modeWriting')}
            </button>
          </div>
        </div>

        {/* Session selector */}
        <div className="flex items-center gap-1.5">
          <select
            id="ai-session-select"
            name="ai-session-select"
            className="flex-1 h-[28px] px-2 bg-[var(--canvas-elevated)] border border-[var(--hairline)] rounded-[var(--radius-sm)] text-[var(--ink)] text-[12px] outline-none cursor-pointer focus:border-[var(--accent-gold)]"
            value={currentSessionId || ''}
            disabled={isRunning}
            onChange={(e) => {
              if (!isRunning && e.target.value) void switchSession(project, e.target.value)
            }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--ink)] hover:bg-[var(--canvas-mid)] transition-colors shrink-0"
            disabled={isRunning}
            onClick={() => {
              if (isRunning) return
              const now = new Date()
              const ts = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
              void createSession(project, t('ai.newSessionTemplate', { ts }))
            }}
            title={t('ai.newSession')}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {currentSessionId && sessions.length > 1 && (
            <button
              type="button"
              className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-tertiary)] cursor-pointer hover:text-[var(--error)] hover:bg-[var(--error-soft)] hover:border-[var(--error)] transition-colors shrink-0"
              disabled={isRunning}
              onClick={() => setConfirmDelete(true)}
              title={t('ai.deleteSession')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable messages area */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
        {/* Task runner */}
        {isRunning && (
          <div className="mx-4 mb-2.5 p-3 bg-[var(--accent-gold-soft-bg)] border border-[rgba(201,169,110,0.3)] rounded-lg">
            <div className="flex items-center gap-2.5">
              <span className="w-[7px] h-[7px] rounded-full bg-[var(--warning)] animate-pulse self-start mt-1 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-[var(--ink)] font-medium flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 inline-block mr-1" />
                  {taskName}
                  {currentChapter?.title ? ` · ${currentChapter.title}` : ''}
                </div>
                <div className="text-[11px] text-[var(--ink-tertiary)] mt-0.5 font-mono">
                  {genTokens > 0 ? t('ai.generatedTokens', { count: genTokens }) : t('ai.running')}
                </div>
                <div className="h-[3px] bg-[var(--canvas-mid)] rounded-full mt-1.5 overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent-gold)] rounded-full animate-pulse"
                    style={{ width: `${Math.min(95, genTokens * 2)}%` }}
                  />
                </div>
              </div>
              <button
                type="button"
                className="w-[26px] h-[26px] flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--hairline-light)] text-[var(--ink-tertiary)] text-[13px] cursor-pointer shrink-0 hover:bg-[var(--error-soft)] hover:text-[var(--error)] hover:border-[var(--error)] transition-colors"
                onClick={stopTask}
                title={t('ai.cancel')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {recoverableDrafts.length > 0 && (
          <div className="mx-4 mb-2.5 p-3 bg-[var(--warning-soft)] border border-[var(--warning)] rounded-lg">
            <div className="text-[12px] font-medium text-[var(--ink)]">{t('ai.projectDraftRecoveryTitle')}</div>
            <div className="mt-1 text-[11px] leading-relaxed text-[var(--ink-secondary)]">
              {t('ai.projectDraftRecoveryDescription')}
            </div>
            {draftRecoverySnapshot.persistenceError && (
              <div className="mt-2 text-[11px] font-medium text-[var(--error)]">
                {t('ai.projectDraftPersistenceFailed')}
              </div>
            )}
            <div className="mt-2 space-y-2">
              {recoverableDrafts.map((draft) => {
                const targetChapter = findRecoveryTarget(draft)
                return (
                  <div
                    key={draft.recoveryId}
                    className="rounded-md border border-[var(--hairline)] bg-[var(--canvas-card)] p-2"
                  >
                    <div className="text-[11px] text-[var(--ink)]">
                      {t('ai.projectDraftChapter', { chapter: draft.chapterNum, id: draft.chapterId })}
                    </div>
                    <div className="mt-0.5 text-[10px] text-[var(--ink-mute)]">
                      {new Date(draft.retiredAt).toLocaleString()} · {draft.sourceInstanceId.slice(0, 8)}
                    </div>
                    <details className="mt-2 text-[10px] text-[var(--ink-secondary)]">
                      <summary className="cursor-pointer">{t('ai.projectDraftViewContent')}</summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--canvas-elevated)] p-2 select-text">
                        {formatRecoverableProjectDraft(draft)}
                      </pre>
                    </details>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="btn-secondary h-[26px] px-2 text-[11px]"
                        onClick={() => void copyRecoverableDraft(draft)}
                      >
                        {t('ai.projectDraftCopy')}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary h-[26px] px-2 text-[11px] disabled:opacity-40"
                        disabled={!targetChapter}
                        title={!targetChapter ? t('ai.projectDraftChapterMissing') : t('ai.projectDraftRestoreHint')}
                        onClick={() => restoreRecoverableDraft(draft)}
                      >
                        {t('ai.projectDraftRestore')}
                      </button>
                      <button
                        type="button"
                        className="h-[26px] px-2 text-[11px] border border-[var(--hairline)] rounded bg-transparent text-[var(--error)]"
                        onClick={() => discardRecoverableDraft(draft)}
                      >
                        {t('ai.projectDraftDiscard')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Consistency report */}
        {showConsistency && (
          <div
            className="mx-4 mb-2.5 p-3 bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg border-l-[3px]"
            style={{ borderLeftColor: 'var(--warning)' }}
          >
            <div className="text-[12px] font-medium text-[var(--ink)] mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 inline-block mr-1" />
              {t('ai.consistencyActive')}
              <button
                type="button"
                className="ml-auto text-[10px] text-[var(--ink-mute)] cursor-pointer bg-none border-none hover:text-[var(--ink)]"
                onClick={() => {
                  setShowConsistency(false)
                  localStorage.setItem('mythpen-hide-consistency', '1')
                }}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <div className="text-[11px] text-[var(--ink-secondary)]">{t('ai.autoSaveDesc')}</div>
          </div>
        )}

        {/* Messages */}
        <div className="px-4">
          {messages.length === 0 && !streamText && (
            <div className="text-[13px] text-[var(--ink-tertiary)] leading-[1.6] mb-2 p-3 rounded-lg bg-[var(--canvas-card)]">
              <Lightbulb className="w-3.5 h-3.5 inline-block mr-1" />
              {t('ai.welcomeMessage')}
            </div>
          )}
          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.role === 'user' && (
                <div className="p-2.5 rounded-lg text-[13px] leading-[1.6] mb-2 bg-[var(--canvas-elevated)] text-[var(--ink)]">
                  <MarkdownContent content={msg.content} />
                </div>
              )}
              {msg.role === 'ai' && msg.content && (
                <div
                  className={`p-2.5 rounded-lg text-[13px] leading-[1.6] mb-2 ${msg.content.startsWith('完成') || msg.content.startsWith('错误') ? 'text-[var(--ink-secondary)]' : 'bg-[var(--canvas-card)] text-[var(--ink-secondary)]'}`}
                >
                  {/* Inline tool calls */}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="mb-1.5 space-y-[2px]">
                      {msg.toolCalls.map((tc: any) => (
                        <div
                          key={tc.id}
                          className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] bg-[var(--canvas-mid)]"
                        >
                          <span
                            className="w-[5px] h-[5px] rounded-full shrink-0"
                            style={{ background: toolTypeColor[getToolType(tc.name)] || 'var(--info)' }}
                          />
                          <span className="font-medium text-[var(--ink)]">{tc.name}</span>
                          <span className="text-[var(--ink-tertiary)] truncate">{formatToolArgs(tc.arguments)}</span>
                          {tc.result && !tc.result.error && <span className="ml-auto text-[var(--success)]">✓</span>}
                          {tc.result?.error && <span className="ml-auto text-[var(--error)]">✗</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  <MarkdownContent content={msg.content} />
                </div>
              )}
            </div>
          ))}

          {/* Tool call chain */}
          {toolCalls.length > 0 && (
            <div className="mb-2 space-y-1">
              <div className="text-[10px] text-[var(--ink-mute)] uppercase tracking-[0.05em] mb-1 px-1 font-mono">
                {t('ai.toolCalls')}
              </div>
              {toolCalls.map((tc) => (
                <details
                  key={tc.id}
                  className="group rounded-[var(--radius-sm)] bg-[var(--canvas-card)] border border-[var(--hairline)] overflow-hidden"
                >
                  <summary className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[12px] select-none hover:bg-[var(--canvas-elevated)] transition-colors">
                    <span
                      className={`w-[6px] h-[6px] rounded-full shrink-0 ${
                        tc.status === 'running' ? 'animate-pulse' : ''
                      }`}
                      style={{
                        background:
                          tc.status === 'running'
                            ? toolTypeColor[getToolType(tc.name)] || 'var(--info)'
                            : tc.result?.error
                              ? 'var(--error)'
                              : toolTypeColor[getToolType(tc.name)] || 'var(--info)',
                        opacity: tc.status === 'running' ? 0.6 : 1,
                      }}
                    />
                    <span className="font-medium text-[var(--ink)]">{tc.name}</span>
                    <span className="text-[var(--ink-tertiary)] truncate flex-1 min-w-0">
                      {tc.status === 'running' ? t('ai.executing') : formatToolArgs(tc.arguments)}
                    </span>
                    <span className="text-[var(--ink-mute)] text-[10px] group-open:hidden">▼</span>
                  </summary>
                  <div className="border-t border-[var(--hairline)] px-2.5 py-2 text-[11px] leading-[1.5] font-mono text-[var(--ink-secondary)] bg-[var(--canvas-elevated)] max-h-40 overflow-y-auto custom-scrollbar">
                    <div className="text-[var(--ink-mute)] mb-1">{t('ai.params')}</div>
                    <pre className="whitespace-pre-wrap break-all mb-2">{JSON.stringify(tc.arguments, null, 2)}</pre>
                    {tc.result && (
                      <>
                        <div className={`mb-1 ${tc.result.error ? 'text-[var(--error)]' : 'text-[var(--ink-mute)]'}`}>
                          {tc.result.error ? t('ai.errorLabel') : t('ai.result')}
                        </div>
                        <pre className="whitespace-pre-wrap break-all">{JSON.stringify(tc.result, null, 2)}</pre>
                      </>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}

          {/* Streaming content */}
          {streamText && (
            <div className="p-2.5 rounded-lg text-[13px] leading-[1.6] mb-2 text-[var(--accent-gold-soft)] bg-[var(--accent-gold-soft-bg)]">
              <div className="text-[10px] text-[var(--ink-mute)] mb-1 uppercase font-mono">
                {t('ai.generatingTitle')}
              </div>
              <MarkdownContent content={streamText} />
              <span className="inline-block w-[2px] h-[1em] bg-[var(--accent-gold)] ml-[1px] align-text-bottom animate-pulse" />
            </div>
          )}

          <div ref={msgEndRef} />
        </div>
      </div>

      {/* Chat input */}
      <div className="px-4 pb-4 pt-0 shrink-0">
        <div className="flex items-end gap-2 bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-[6px_8px] transition-colors focus-within:border-[var(--accent-gold)]">
          <textarea
            id="ai-chat-input"
            name="ai-chat-input"
            className="flex-1 bg-transparent border-none outline-none resize-none font-sans text-[13px] text-[var(--ink)] leading-[1.5] max-h-20 min-h-5"
            placeholder={mode === 'collab' ? t('ai.placeholderCollab') : t('ai.placeholderWriting')}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            disabled={isRunning}
          />
          <button
            type="button"
            className="w-7 h-7 rounded-[var(--radius-sm)] border-none bg-[var(--accent-gold)] text-[var(--canvas)] text-sm cursor-pointer flex items-center justify-center shrink-0 hover:bg-[var(--accent-gold-soft)] transition-colors disabled:opacity-40"
            onClick={handleSend}
            disabled={isRunning || !input.trim()}
          >
            {isRunning ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <SendHorizonal className="w-3.5 h-3.5" />}
          </button>
        </div>
        <div className="text-[11px] text-[var(--ink-mute)] mt-1.5 pl-1 font-sans">
          <kbd className="bg-[var(--canvas-mid)] px-[5px] py-[1px] rounded-[3px] font-sans text-[10px] text-[var(--ink-tertiary)]">
            Enter
          </kbd>{' '}
          {t('ai.enterSend')} ·{' '}
          <kbd className="bg-[var(--canvas-mid)] px-[5px] py-[1px] rounded-[3px] font-sans text-[10px] text-[var(--ink-tertiary)]">
            Shift+Enter
          </kbd>{' '}
          {t('ai.enterNewline')}
        </div>
      </div>
      <ToastContainer toasts={toasts} />

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[200]" role="presentation">
          <button
            type="button"
            className="absolute inset-0 cursor-default border-none bg-transparent p-0"
            aria-label={t('ai.cancelAction')}
            onClick={() => setConfirmDelete(false)}
          />
          <div
            className="relative z-10 bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-xl p-6 w-[360px] shadow-2xl"
            role="dialog"
            aria-modal="true"
          >
            <h3 className="text-[16px] font-medium text-[var(--ink)] mb-2">{t('ai.deleteSessionTitle')}</h3>
            <p className="text-[13px] text-[var(--ink-tertiary)] mb-5">{t('ai.deleteSessionConfirm')}</p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="h-[32px] px-4 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer hover:bg-[var(--canvas-mid)]"
                onClick={() => setConfirmDelete(false)}
              >
                {t('ai.cancelAction')}
              </button>
              <button
                type="button"
                className="h-[32px] px-4 rounded-lg bg-[var(--error)] text-white text-[13px] font-medium cursor-pointer border-none hover:brightness-110"
                disabled={isRunning}
                onClick={() => {
                  if (isRunning || !currentSessionId) return
                  void deleteSession(project, currentSessionId)
                  setConfirmDelete(false)
                }}
              >
                {t('ai.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
