import { FilePenLine, Loader, Pen, RemoveFormatting, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ToastContainer } from '@/components/ToastContainer'
import { useT } from '@/hooks/useT'
import { useToast } from '@/hooks/useToast'
import { aiApi } from '@/lib/api'
import { getProjectInstanceId } from '@/lib/projectInstanceRegistry'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useRevisionStore } from '@/stores/useRevisionStore'

/** Walk from `node` up to `editor`, return first ancestor matching `predicate`. */
function findAncestor(node: Node | null, editor: HTMLElement, predicate: (el: Element) => boolean): Element | null {
  while (node && node !== editor) {
    if ((node as Element).tagName && predicate(node as Element)) return node as Element
    node = node.parentNode
  }
  return null
}

/** Replace a heading element with a `<p>` keeping its children, restore cursor. */
function unwrapToParagraph(el: Element, sel: Selection): void {
  const p = document.createElement('p')
  p.innerHTML = (el as HTMLElement).innerHTML
  el.replaceWith(p)
  const range = document.createRange()
  range.selectNodeContents(p)
  range.collapse()
  sel.removeAllRanges()
  sel.addRange(range)
}

function flushCurrentEditor(lock = false): Promise<void> {
  const editor = document.querySelector<HTMLElement>('[contenteditable]')
  if (!editor) return Promise.resolve()
  if (lock) editor.contentEditable = 'false'

  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent('mythpen:flush-editor', { detail: { lock, resolve, reject } }))
  })
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const value = error as { error?: unknown; message?: unknown }
    if (typeof value.error === 'string') return value.error
    if (typeof value.message === 'string') return value.message
  }
  return String(error || '')
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
}

type ToolbarOperation = {
  token: number
  kind: 'continue' | 'polish'
  project: string
  projectInstanceId: string | undefined
  chapterId: number
  lockOwner: string
  controller: AbortController | null
  settled: boolean
  reconciling: boolean
  retryReconciliation: (() => void) | null
}

type OperationRecovery = { token: number; message: string; retrying: boolean }

function stillViewingOperation(operation: ToolbarOperation): boolean {
  const chapterState = useChapterStore.getState()
  return (
    useProjectStore.getState().currentProject === operation.project &&
    chapterState.projectName === operation.project &&
    chapterState.currentChapter?.id === operation.chapterId
  )
}

export function EditorToolbar() {
  const currentChapter = useChapterStore((s) => s.currentChapter)
  const loadChapterContent = useChapterStore((s) => s.loadChapterContent)
  const applyPersistedChapterContent = useChapterStore((s) => s.applyPersistedChapterContent)
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentProjectInstanceId = useProjectStore((state) => {
    if (!state.currentProject) return undefined
    return state.projects.find((project) => project.name === state.currentProject)?.instanceId
  })
  const revision = useRevisionStore((s) => s.revision)
  const revisionProject = useRevisionStore((s) => s.revisionProject)
  const revisionLoading = useRevisionStore((s) => s.loading)
  const revisionError = useRevisionStore((s) => s.error)
  const editorLocks = useRevisionStore((s) => s.editorLocks)
  const setRevision = useRevisionStore((s) => s.setRevision)
  const loadRevision = useRevisionStore((s) => s.loadRevision)
  const lockEditor = useRevisionStore((s) => s.lockEditor)
  const unlockEditor = useRevisionStore((s) => s.unlockEditor)
  const { t } = useT()
  const { toasts, show: showToast } = useToast()
  const [loading, setLoading] = useState<'continue' | 'polish' | null>(null)
  const [operationRecovery, setOperationRecovery] = useState<OperationRecovery | null>(null)
  const operationSequenceRef = useRef(0)
  const operationRef = useRef<ToolbarOperation | null>(null)
  const mountedRef = useRef(false)
  const [fmt, setFmt] = useState({ bold: false, italic: false, underline: false })

  const isCurrentOperation = useCallback(
    (operation: ToolbarOperation) =>
      !operation.settled &&
      operationRef.current?.token === operation.token &&
      getProjectInstanceId(operation.project) === operation.projectInstanceId,
    [],
  )

  const finishOperation = useCallback(
    (operation: ToolbarOperation): boolean => {
      if (operation.settled) return false
      operation.settled = true
      operation.retryReconciliation = null
      const wasCurrent = operationRef.current?.token === operation.token
      if (wasCurrent) {
        operationRef.current = null
        if (mountedRef.current) {
          setLoading(null)
          setOperationRecovery((recovery) => (recovery?.token === operation.token ? null : recovery))
        }
      }
      unlockEditor(operation.project, operation.chapterId, operation.lockOwner)
      return wasCurrent
    },
    [unlockEditor],
  )

  const beginOperation = useCallback(
    (kind: ToolbarOperation['kind'], project: string, chapterId: number): ToolbarOperation => {
      const operation: ToolbarOperation = {
        token: ++operationSequenceRef.current,
        kind,
        project,
        projectInstanceId: getProjectInstanceId(project),
        chapterId,
        lockOwner: lockEditor(project, chapterId),
        controller: null,
        settled: false,
        reconciling: false,
        retryReconciliation: null,
      }
      operationRef.current = operation
      setLoading(kind)
      setOperationRecovery(null)
      return operation
    },
    [lockEditor],
  )

  const reconcileOperation = useCallback(
    (operation: ToolbarOperation, message: string, reconcile: () => Promise<boolean>, onReconciled?: () => void) => {
      if (!isCurrentOperation(operation) || operation.reconciling) return
      operation.reconciling = true
      if (mountedRef.current) setOperationRecovery({ token: operation.token, message, retrying: true })

      void (async () => {
        let safeToUnlock = false
        try {
          safeToUnlock = await reconcile()
        } catch {
          safeToUnlock = false
        } finally {
          operation.reconciling = false
        }

        if (!isCurrentOperation(operation)) return
        if (!stillViewingOperation(operation)) {
          finishOperation(operation)
          return
        }
        if (!safeToUnlock) {
          if (mountedRef.current) setOperationRecovery({ token: operation.token, message, retrying: false })
          return
        }

        if (finishOperation(operation) && mountedRef.current) onReconciled?.()
      })()
    },
    [finishOperation, isCurrentOperation],
  )

  const queueOperationReconciliation = useCallback(
    (operation: ToolbarOperation, message: string, reconcile: () => Promise<boolean>, onReconciled?: () => void) => {
      const retry = () => reconcileOperation(operation, message, reconcile, onReconciled)
      operation.retryReconciliation = retry
      retry()
    },
    [reconcileOperation],
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const operation = operationRef.current
      if (!operation) return
      const controller = operation.controller
      finishOperation(operation)
      controller?.abort()
    }
  }, [finishOperation])

  // Navigating to another editor retires this toolbar operation. Its late
  // callbacks retain their own token, so they can release only their own lock.
  useEffect(() => {
    const operation = operationRef.current
    if (
      !operation ||
      (operation.project === currentProject &&
        operation.projectInstanceId === currentProjectInstanceId &&
        operation.chapterId === currentChapter?.id)
    ) {
      return
    }
    const controller = operation.controller
    finishOperation(operation)
    controller?.abort()
  }, [currentChapter?.id, currentProject, currentProjectInstanceId, finishOperation])

  useEffect(() => {
    const retry = () => operationRef.current?.retryReconciliation?.()
    window.addEventListener('focus', retry)
    window.addEventListener('online', retry)
    return () => {
      window.removeEventListener('focus', retry)
      window.removeEventListener('online', retry)
    }
  }, [])

  // Track selection formatting state
  useEffect(() => {
    const handler = () => {
      const editor = document.querySelector('[contenteditable]')
      if (editor !== document.activeElement) {
        if (fmt.bold || fmt.italic || fmt.underline) setFmt({ bold: false, italic: false, underline: false })
        return
      }
      try {
        setFmt({
          bold: document.queryCommandState('bold'),
          italic: document.queryCommandState('italic'),
          underline: document.queryCommandState('underline'),
        })
      } catch {}
    }
    document.addEventListener('selectionchange', handler)
    return () => document.removeEventListener('selectionchange', handler)
  }, [fmt.italic, fmt.underline, fmt.bold])

  const exec = useCallback((command: string, value?: string) => {
    document.execCommand(command, false, value)
    const editor = document.querySelector('[contenteditable]')
    if (editor && document.activeElement !== editor) {
      ;(editor as HTMLElement).focus()
    }
  }, [])

  const handleFormat = useCallback(
    (cmd: string, val?: string) => {
      exec(cmd, val)
      const editor = document.querySelector('[contenteditable]')
      if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }))
    },
    [exec],
  )

  const handleBlock = useCallback((tag: string) => {
    const editor = document.querySelector('[contenteditable]') as HTMLElement | null
    if (!editor) return
    if (document.activeElement !== editor) editor.focus()

    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const range = sel.getRangeAt(0)

    // Toggle: if inside same heading type, unwrap to paragraph
    const existing = findAncestor(range.startContainer, editor, (el) => el.tagName.toLowerCase() === tag)
    if (existing) {
      unwrapToParagraph(existing, sel)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }

    // Wrap the current block in the heading tag
    let node: Node | null = range.startContainer
    while (node && node.parentNode !== editor) node = node.parentNode
    if (!node || node === editor) {
      // Fallback: insert a new heading at cursor
      const el = document.createElement(tag)
      el.textContent = ' '
      range.insertNode(el)
      range.setStart(el, 0)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    } else {
      const heading = document.createElement(tag)
      heading.innerHTML = (node as HTMLElement).innerHTML
      ;(node as HTMLElement).replaceWith(heading)
      const newRange = document.createRange()
      newRange.selectNodeContents(heading)
      newRange.collapse()
      sel.removeAllRanges()
      sel.addRange(newRange)
    }

    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }, [])

  const handleInsertQuote = useCallback(() => {
    const editor = document.querySelector('[contenteditable]')
    if (!editor) return
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const range = sel.getRangeAt(0)
    const block = document.createElement('p')
    block.className = 'dialogue'
    block.textContent = sel.toString() || '「」'
    range.deleteContents()
    range.insertNode(block)
    const textNode = block.firstChild
    if (textNode) {
      range.setStart(textNode, 1)
      range.setEnd(textNode, 1)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }, [])

  const handleInsertDivider = useCallback(() => {
    exec('insertHorizontalRule')
  }, [exec])

  const handleInsertCode = useCallback(() => {
    const editor = document.querySelector('[contenteditable]')
    if (!editor) return
    const sel = window.getSelection()
    if (!sel?.rangeCount) return
    const range = sel.getRangeAt(0)
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = sel.toString() || t('editor.codePlaceholder')
    pre.appendChild(code)
    range.deleteContents()
    range.insertNode(pre)
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }, [t])

  // Start AI continue writing
  const handleContinue = useCallback(async () => {
    if (loading || operationRef.current || !currentProject || !currentChapter) return
    const project = currentProject
    const targetChapter = currentChapter
    const operation = beginOperation('continue', project, targetChapter.id)

    try {
      await flushCurrentEditor(true)
    } catch (error) {
      if (finishOperation(operation) && mountedRef.current) {
        showToast(`${t('ai.continueError')}: ${getErrorMessage(error) || t('editor.notSaved')}`, 'error')
      }
      return
    }

    if (!isCurrentOperation(operation)) return

    const ch = useChapterStore.getState().currentChapter
    if (
      !ch ||
      ch.id !== targetChapter.id ||
      useProjectStore.getState().currentProject !== project ||
      useChapterStore.getState().projectName !== project
    ) {
      finishOperation(operation)
      return
    }

    const context = t('editor.continuePrompt', {
      project,
      num: ch.num,
      title: ch.title,
      content: ch.content || '',
    })

    try {
      const controller = aiApi.continueWriting(
        ch.chapterUid || ch.id,
        context,
        project,
        () => {}, // chunk handler — no-op for toolbar (streaming handled server-side)
        (data) => {
          // The SSE helper does not await this callback. Keep every rejection
          // inside the callback and release the operation in a local finally.
          void (async () => {
            let shouldFinish = true
            try {
              if (!isCurrentOperation(operation)) return
              const stillViewingTarget =
                useProjectStore.getState().currentProject === project &&
                useChapterStore.getState().projectName === project &&
                useChapterStore.getState().currentChapter?.id === ch.id
              const appliedSavedContent =
                stillViewingTarget &&
                (data?.chapterId === ch.id || (ch.chapterUid !== undefined && data?.chapterUid === ch.chapterUid)) &&
                typeof data.chapterContent === 'string' &&
                applyPersistedChapterContent(
                  project,
                  ch.id,
                  data.chapterContent,
                  data.wordCount,
                  'writing',
                  data.dataVersion,
                )
              const loaded = stillViewingTarget ? await loadChapterContent(project, ch.num, ch.volumeId) : true
              if (
                isCurrentOperation(operation) &&
                !loaded &&
                !appliedSavedContent &&
                useProjectStore.getState().currentProject === project
              ) {
                shouldFinish = false
                queueOperationReconciliation(
                  operation,
                  `${t('ai.continueError')}：${t('editor.notSaved')}`,
                  async () => stillViewingOperation(operation) && loadChapterContent(project, ch.num, ch.volumeId),
                )
              }
            } catch (error) {
              if (isCurrentOperation(operation) && stillViewingOperation(operation)) {
                shouldFinish = false
                queueOperationReconciliation(
                  operation,
                  `${t('ai.continueError')}: ${getErrorMessage(error) || t('editor.notSaved')}`,
                  async () => stillViewingOperation(operation) && loadChapterContent(project, ch.num, ch.volumeId),
                )
              }
            } finally {
              if (shouldFinish) finishOperation(operation)
            }
          })()
        },
        (error) => {
          if (!isCurrentOperation(operation)) return
          if (isAbortError(error)) {
            finishOperation(operation)
            return
          }

          const message = `${t('ai.continueError')}: ${getErrorMessage(error) || t('editor.notSaved')}`
          queueOperationReconciliation(
            operation,
            message,
            async () => stillViewingOperation(operation) && loadChapterContent(project, ch.num, ch.volumeId),
            () => {
              const authoritative = useChapterStore.getState().currentChapter
              const continuationCommitted =
                authoritative?.id === ch.id &&
                (authoritative.dataVersion > ch.dataVersion || authoritative.content !== ch.content)
              if (!continuationCommitted) showToast(message, 'error')
            },
          )
        },
      )
      operation.controller = controller
      if (!isCurrentOperation(operation)) controller.abort()
    } catch (error) {
      if (finishOperation(operation) && mountedRef.current) {
        showToast(`${t('ai.continueError')}: ${getErrorMessage(error) || t('editor.notSaved')}`, 'error')
      }
    }
  }, [
    loading,
    currentProject,
    currentChapter,
    applyPersistedChapterContent,
    beginOperation,
    finishOperation,
    isCurrentOperation,
    loadChapterContent,
    queueOperationReconciliation,
    showToast,
    t,
  ])

  // Clear formatting on selected text
  const handleClearFormat = useCallback(() => {
    const editor = document.querySelector('[contenteditable]') as HTMLElement | null
    if (!editor) return
    if (document.activeElement !== editor) editor.focus()

    // Unwrap headings (h1/h2/h3) back to paragraphs
    const sel = window.getSelection()
    if (sel?.rangeCount) {
      const heading = findAncestor(sel.getRangeAt(0).startContainer, editor, (el) =>
        ['h1', 'h2', 'h3'].includes(el.tagName.toLowerCase()),
      )
      if (heading) unwrapToParagraph(heading, sel)
    }

    document.execCommand('removeFormat')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  }, [])

  const reportPolishFailure = useCallback(
    (error: unknown) => {
      const detail = error && typeof error === 'object' ? (error as { code?: string }) : null
      if (detail?.code === 'polish_output_limit') {
        showToast(t('editor.polishOutputLimit'), 'error')
        return
      }
      if (detail?.code === 'polish_empty_response') {
        showToast(t('editor.polishNoResult'), 'error')
        return
      }
      showToast(t('editor.polishFailed', { message: getErrorMessage(error) || t('editor.polishNoResult') }), 'error')
    },
    [showToast, t],
  )

  // Start AI polish
  const handlePolish = useCallback(async () => {
    if (loading || operationRef.current || !currentProject || !currentChapter) return
    const project = currentProject
    const targetChapter = currentChapter
    const operation = beginOperation('polish', project, targetChapter.id)
    try {
      await flushCurrentEditor(true)
    } catch (error) {
      if (finishOperation(operation) && mountedRef.current) {
        showToast(t('editor.polishFailed', { message: getErrorMessage(error) || t('editor.notSaved') }), 'error')
      }
      return
    }

    if (!isCurrentOperation(operation)) return

    const ch = useChapterStore.getState().currentChapter
    if (
      !ch ||
      ch.id !== targetChapter.id ||
      useProjectStore.getState().currentProject !== project ||
      useChapterStore.getState().projectName !== project ||
      !ch.content.trim()
    ) {
      if (finishOperation(operation) && mountedRef.current) showToast(t('editor.polishNoContent'), 'info')
      return
    }

    const hasActivePolishRevision = () => {
      const revisionState = useRevisionStore.getState()
      return revisionState.revisionProject === project && revisionState.revision?.chapterId === ch.id
    }
    const reconcilePolishResult = async () => {
      if (!stillViewingOperation(operation)) return false
      await loadRevision(project, ch.id)
      const revisionState = useRevisionStore.getState()
      if (revisionState.loading || revisionState.error) return false
      if (hasActivePolishRevision()) return true
      // A polish revision may already have been resolved in another window
      // between the lost ACK and this lookup. Refresh the chapter in that case.
      return loadChapterContent(project, ch.num, ch.volumeId)
    }

    try {
      const controller = aiApi.polishChapter(
        ch.chapterUid || ch.id,
        project,
        () => {},
        (data) => {
          void (async () => {
            let shouldFinish = true
            try {
              if (!isCurrentOperation(operation)) return
              const active = useChapterStore.getState().currentChapter
              if (
                data?.revision &&
                data.revision.status === 'pending' &&
                active?.id === ch.id &&
                useProjectStore.getState().currentProject === project &&
                useChapterStore.getState().projectName === project
              ) {
                // The done payload is already an authoritative revision. Mount
                // it before the follow-up chapter refresh so an unexpected
                // refresh failure cannot reopen the editable base document.
                setRevision(project, data.revision)
                await loadChapterContent(project, ch.num, ch.volumeId)
                return
              }
              if (!isCurrentOperation(operation)) return
              if (data?.unchanged) {
                showToast(t('editor.polishNoChanges'), 'info')
                return
              }
              showToast(t('editor.polishNoResult'), 'error')
            } catch (error) {
              if (isCurrentOperation(operation) && stillViewingOperation(operation)) {
                shouldFinish = false
                queueOperationReconciliation(
                  operation,
                  t('editor.polishFailed', {
                    message: getErrorMessage(error) || t('editor.polishNoResult'),
                  }),
                  reconcilePolishResult,
                  () => {
                    if (!hasActivePolishRevision()) reportPolishFailure(error)
                  },
                )
              }
            } finally {
              if (shouldFinish) finishOperation(operation)
            }
          })()
        },
        (error) => {
          if (!isCurrentOperation(operation)) return
          if (isAbortError(error)) {
            finishOperation(operation)
            return
          }

          const message = t('editor.polishFailed', {
            message: getErrorMessage(error) || t('editor.polishNoResult'),
          })
          queueOperationReconciliation(operation, message, reconcilePolishResult, () => {
            if (!hasActivePolishRevision()) reportPolishFailure(error)
          })
        },
      )
      operation.controller = controller
      if (!isCurrentOperation(operation)) controller.abort()
    } catch (error) {
      if (finishOperation(operation) && mountedRef.current) {
        reportPolishFailure(error)
      }
    }
  }, [
    loading,
    currentProject,
    currentChapter,
    beginOperation,
    finishOperation,
    isCurrentOperation,
    loadRevision,
    setRevision,
    loadChapterContent,
    queueOperationReconciliation,
    reportPolishFailure,
    showToast,
    t,
  ])

  const reviewing = revisionProject === currentProject && revision?.chapterId === currentChapter?.id
  const editorLocked = editorLocks.some(
    (lock) => lock.project === currentProject && lock.chapterId === currentChapter?.id,
  )
  const toolbarDisabled = !!loading || editorLocked || revisionLoading || Boolean(revisionError)
  const recoveryBanner = operationRecovery && operationRef.current?.token === operationRecovery.token && (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-[var(--danger)]/30 bg-[var(--danger)]/5 px-3 py-1.5 text-[12px] text-[var(--danger)]"
      role="alert"
    >
      <span className="min-w-0 flex-1 truncate">{operationRecovery.message}</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 border-none bg-transparent font-medium text-inherit underline underline-offset-2 disabled:cursor-wait disabled:opacity-60"
        disabled={operationRecovery.retrying}
        onClick={() => operationRef.current?.retryReconciliation?.()}
      >
        {operationRecovery.retrying && <Loader className="h-3 w-3 animate-spin" />}
        {t('serverStatus.retry')}
      </button>
    </div>
  )

  return reviewing ? (
    <>
      <div className="h-[var(--toolbar-h)] bg-[var(--canvas-soft)] border-b border-[var(--hairline)] flex items-center px-3 gap-2 shrink-0 text-[var(--ink-secondary)]">
        <FilePenLine className="w-3.5 h-3.5 text-[var(--accent-gold)]" />
        <span className="text-[12px] font-medium">{t('editor.revisionReview')}</span>
        <span className="text-[11px] text-[var(--ink-tertiary)]">{t('editor.revisionLocked')}</span>
      </div>
      {recoveryBanner}
      <ToastContainer toasts={toasts} />
    </>
  ) : (
    <>
      <div className="h-[var(--toolbar-h)] bg-[var(--canvas-soft)] border-b border-[var(--hairline)] flex items-center px-3 gap-0.5 shrink-0">
        <div className="flex gap-[1px] items-center">
          <ToolBtn disabled={toolbarDisabled} onClick={() => handleBlock('h1')}>
            H1
          </ToolBtn>
          <ToolBtn disabled={toolbarDisabled} onClick={() => handleBlock('h2')}>
            H2
          </ToolBtn>
        </div>
        <span className="w-px h-5 bg-[var(--hairline)] mx-1.5" />
        <div className="flex gap-[1px] items-center">
          <ToolBtn active={fmt.bold} disabled={toolbarDisabled} onClick={() => handleFormat('bold')}>
            <b>B</b>
          </ToolBtn>
          <ToolBtn active={fmt.italic} disabled={toolbarDisabled} onClick={() => handleFormat('italic')}>
            <i>I</i>
          </ToolBtn>
          <ToolBtn active={fmt.underline} disabled={toolbarDisabled} onClick={() => handleFormat('underline')}>
            <u>U</u>
          </ToolBtn>
        </div>
        <span className="w-px h-5 bg-[var(--hairline)] mx-1.5" />
        <div className="flex gap-[1px] items-center">
          <ToolBtn disabled={toolbarDisabled} onClick={handleInsertQuote}>
            "
          </ToolBtn>
          <ToolBtn disabled={toolbarDisabled} onClick={handleInsertDivider}>
            ≡
          </ToolBtn>
          <ToolBtn disabled={toolbarDisabled} onClick={handleInsertCode}>
            &lt;/&gt;
          </ToolBtn>
          <span className="w-px h-5 bg-[var(--hairline)] mx-1.5" />
          <ToolBtn disabled={toolbarDisabled} onClick={handleClearFormat}>
            <RemoveFormatting className="w-3.5 h-3.5" />
          </ToolBtn>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={`tool-btn-ai-pill inline-flex items-center gap-1 ${loading === 'polish' ? 'opacity-60 pointer-events-none' : ''}`}
            onClick={handlePolish}
            disabled={toolbarDisabled}
          >
            {loading === 'polish' ? (
              <Loader className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            <span className="text-[12px]">{loading === 'polish' ? t('editor.polishing') : t('editor.polish')}</span>
          </button>
          <button
            type="button"
            className={`tool-btn-ai-pill inline-flex items-center gap-1 ${loading === 'continue' ? 'opacity-60 pointer-events-none' : ''}`}
            onClick={handleContinue}
            disabled={toolbarDisabled}
          >
            {loading === 'continue' ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Pen className="w-3.5 h-3.5" />}
            <span className="text-[12px]">
              {loading === 'continue' ? t('editor.continuing') : t('editor.continue')}
            </span>
          </button>
        </div>
      </div>
      {recoveryBanner}
      <ToastContainer toasts={toasts} />
    </>
  )
}

function ToolBtn({
  children,
  onClick,
  active,
  disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`w-7 h-7 flex items-center justify-center rounded-[var(--radius-sm)] text-sm transition-colors border-none
        ${active ? 'text-[var(--accent-gold)]' : 'text-[var(--ink-tertiary)]'}
        ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-[var(--canvas-card)] hover:text-[var(--ink)]'}`}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
