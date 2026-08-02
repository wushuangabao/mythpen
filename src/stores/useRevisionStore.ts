import { create } from 'zustand'
import { type ChapterRevision, chapterRevisionsApi, type RevisionDecision } from '@/lib/api'
import { getProjectInstanceId, isCurrentProjectInstance } from '@/lib/projectInstanceRegistry'
import { createRequestEpoch } from '@/lib/requestEpoch'
import { buildRevisionParts, countPendingRevisions, materializeRevision } from '@/lib/revisionDiff'
import {
  beginPendingRevisionMutation,
  completePendingRevisionMutation,
  hasInFlightRevisionMutation,
  hasPendingRevisionMutation,
  type PendingRevisionMutation,
  resolveSettledRevisionMutations,
  settlePendingRevisionMutation,
} from '@/lib/revisionMutationReconciliation'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'

type EditorLock = { project: string; chapterId: number; owners: readonly string[] }

interface RevisionState {
  revision: ChapterRevision | null
  revisionProject: string | null
  loading: boolean
  saving: boolean
  error: string | null
  editorLocks: readonly EditorLock[]
  loadRevision: (project: string, chapterId: number) => Promise<void>
  setRevision: (project: string, revision: ChapterRevision | null) => void
  clearRevision: () => void
  lockEditor: (project: string, chapterId: number) => string
  unlockEditor: (project: string, chapterId: number, owner: string) => void
  decide: (project: string, revisionId: number, changeId: string, decision: RevisionDecision) => Promise<void>
  finalize: (project: string, revisionId: number) => Promise<void>
  acceptAll: (project: string, revisionId: number) => Promise<void>
  rejectAll: (project: string, revisionId: number) => Promise<void>
}

const revisionLoadEpoch = createRequestEpoch()
let editorLockOwnerSequence = 0

function isCurrentRevision(state: RevisionState, project: string, revisionId: number) {
  return state.revisionProject === project && state.revision?.id === revisionId
}

function findEditorLock(locks: readonly EditorLock[], project: string, chapterId: number): EditorLock | null {
  return locks.find((lock) => lock.project === project && lock.chapterId === chapterId) || null
}

function stillViewing(project: string, chapterId: number) {
  const chapterState = useChapterStore.getState()
  return (
    useProjectStore.getState().currentProject === project &&
    chapterState.projectName === project &&
    chapterState.currentChapter?.id === chapterId
  )
}

function stillViewingInstance(project: string, chapterId: number, projectInstanceId: string | undefined) {
  return stillViewing(project, chapterId) && isCurrentProjectInstance(project, projectInstanceId)
}

function authoritativeChapterAdvanced(project: string, chapterId: number, dataVersion: number | undefined): boolean {
  if (typeof dataVersion !== 'number' || !Number.isSafeInteger(dataVersion) || !stillViewing(project, chapterId)) {
    return false
  }
  const localDataVersion = useChapterStore.getState().currentChapter?.dataVersion
  if (typeof localDataVersion !== 'number' || !Number.isSafeInteger(localDataVersion)) return true
  return dataVersion > localDataVersion
}

function beginRevisionMutation(project: string, chapterId: number): PendingRevisionMutation {
  return beginPendingRevisionMutation(project, getProjectInstanceId(project), chapterId)
}

function canUseMutationResponse(marker: PendingRevisionMutation): boolean {
  return isCurrentProjectInstance(marker.project, marker.projectInstanceId)
}

async function settleDetachedRevisionMutation(marker: PendingRevisionMutation, get: () => RevisionState) {
  if (!settlePendingRevisionMutation(marker)) return
  if (stillViewingInstance(marker.project, marker.chapterId, marker.projectInstanceId)) {
    await get().loadRevision(marker.project, marker.chapterId)
  }
}

function unlockActiveEditor(project: string, chapterId: number) {
  if (typeof document === 'undefined' || !stillViewing(project, chapterId)) return
  const revisionState = useRevisionStore.getState()
  const targetStillLocked = Boolean(findEditorLock(revisionState.editorLocks, project, chapterId))
  const targetUnderReview = revisionState.revisionProject === project && revisionState.revision?.chapterId === chapterId
  // React also derives contentEditable from these gates, but this direct DOM
  // write runs between renders. Never create a transient editable window while
  // a concurrent revision lookup/error/review still protects the target.
  if (targetStillLocked || targetUnderReview || revisionState.loading || revisionState.error) return
  const editor = document.querySelector<HTMLElement>('[contenteditable]')
  if (editor) editor.contentEditable = 'true'
}

async function reloadCurrentChapter(project: string, chapterId: number): Promise<boolean> {
  const current = useChapterStore.getState().currentChapter
  if (stillViewing(project, chapterId) && current) {
    return useChapterStore.getState().loadChapterContent(project, current.num, current.volumeId)
  }
  return false
}

function applyResolvedChapter(
  project: string,
  chapterId: number,
  result: { content?: string; wordCount?: number; status?: string; dataVersion?: number },
  fallbackStatus: string,
): boolean {
  if (typeof result.content !== 'string' || typeof result.wordCount !== 'number') return false
  return useChapterStore
    .getState()
    .applyPersistedChapterContent(
      project,
      chapterId,
      result.content,
      result.wordCount,
      result.status || fallbackStatus,
      result.dataVersion,
    )
}

function hasResolvedChapterPayload(result: { content?: string; wordCount?: number }): boolean {
  return typeof result.content === 'string' && typeof result.wordCount === 'number'
}

/**
 * Stop the editable DOM immediately, then ask EditorContent to persist its current
 * snapshot. The direct DOM lock closes the small React-render window in which a
 * keystroke could otherwise arrive after we decide to switch to review mode.
 */
function flushAndLockActiveEditor(): Promise<void> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return Promise.resolve()

  const editor = document.querySelector<HTMLElement>('[contenteditable]')
  if (!editor) return Promise.resolve()
  editor.contentEditable = 'false'

  return new Promise((resolve, reject) => {
    window.dispatchEvent(new CustomEvent('mythpen:flush-editor', { detail: { lock: true, resolve, reject } }))
  })
}

async function reconcileRevisionAfterMutationFailure(
  project: string,
  revision: ChapterRevision,
  error: unknown,
  set: (partial: Partial<RevisionState>) => void,
  get: () => RevisionState,
  fallbackMessage: string,
) {
  if (!isCurrentRevision(get(), project, revision.id) || !stillViewing(project, revision.chapterId)) return
  const mutationError = error instanceof Error ? error.message : fallbackMessage
  revisionLoadEpoch.invalidate()
  set({ loading: false, saving: false, error: mutationError })

  // The mutation may have committed even when its response was truncated. Ask
  // for the active revision before allowing the stale editor back on screen.
  await get().loadRevision(project, revision.chapterId)
  if (!isCurrentRevision(get(), project, revision.id) || !stillViewing(project, revision.chapterId)) return

  // If the revision still exists, retain the actionable mutation error. A
  // failed reconciliation is appended so the user knows a later retry is still
  // required; loadRevision itself keeps the known revision mounted.
  const reconciliationError = get().error
  set({
    error:
      reconciliationError && reconciliationError !== mutationError
        ? `${mutationError}；重新核对失败：${reconciliationError}`
        : mutationError,
  })
}

async function completeRevision(
  project: string,
  revision: ChapterRevision,
  set: (partial: Partial<RevisionState>) => void,
  get: () => RevisionState,
) {
  const parts = buildRevisionParts(revision.baseContent, revision.proposedContent)
  if (countPendingRevisions(parts, revision.decisions) > 0) {
    if (isCurrentRevision(get(), project, revision.id)) {
      revisionLoadEpoch.invalidate()
      set({ loading: false, saving: false })
    }
    return
  }

  const mutation = beginRevisionMutation(project, revision.chapterId)
  try {
    const content = materializeRevision(parts, revision.decisions)
    const finalized = await chapterRevisionsApi.finalize(
      project,
      revision.id,
      content,
      revision.baseContent,
      revision.decisions,
    )

    if (!canUseMutationResponse(mutation)) {
      completePendingRevisionMutation(mutation)
      return
    }
    if (
      !isCurrentRevision(get(), project, revision.id) ||
      !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
    ) {
      if (hasResolvedChapterPayload(finalized)) {
        applyResolvedChapter(project, revision.chapterId, finalized, 'accepted')
      }
      await settleDetachedRevisionMutation(mutation, get)
      return
    }

    if (finalized.rebased || finalized.conflicted) {
      if (finalized.conflicted && !finalized.rebased && !finalized.revision) {
        throw new Error('修订发生冲突，但服务器未返回可审阅状态')
      }
      if (finalized.rebased && stillViewing(project, revision.chapterId)) {
        const loaded = await reloadCurrentChapter(project, revision.chapterId)
        if (!loaded) throw new Error('修订已重建，但无法刷新权威章节内容')
      }
      revisionLoadEpoch.invalidate()
      set({
        revision: finalized.revision || null,
        revisionProject: finalized.revision ? project : null,
        loading: false,
        saving: false,
      })
      completePendingRevisionMutation(mutation)
      return
    }

    // Apply the authoritative response before exposing EditorContent again. A
    // failed follow-up GET must never reopen the stale pre-revision DOM.
    if (
      stillViewing(project, revision.chapterId) &&
      !applyResolvedChapter(project, revision.chapterId, finalized, 'accepted')
    ) {
      const loaded = await reloadCurrentChapter(project, revision.chapterId)
      if (!loaded) throw new Error('修订已提交，但无法刷新章节内容')
    }
    revisionLoadEpoch.invalidate()
    set({ revision: null, revisionProject: null, loading: false, saving: false, error: null })
    completePendingRevisionMutation(mutation)
  } catch (error) {
    // Keep the fully persisted decisions in state. A retry (or a later reload)
    // can then finalize the same mixed result instead of replacing it with
    // accept-all / reject-all.
    if (!canUseMutationResponse(mutation)) {
      completePendingRevisionMutation(mutation)
      return
    }
    settlePendingRevisionMutation(mutation)
    await reconcileRevisionAfterMutationFailure(project, revision, error, set, get, '提交修订决定失败')
    if (
      !isCurrentRevision(get(), project, revision.id) ||
      !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
    ) {
      await settleDetachedRevisionMutation(mutation, get)
    }
  }
}

export const useRevisionStore = create<RevisionState>((set, get) => ({
  revision: null,
  revisionProject: null,
  loading: false,
  saving: false,
  error: null,
  editorLocks: [],

  loadRevision: async (project, chapterId) => {
    // A background caller for a chapter that is no longer visible must not
    // invalidate the in-flight request for the active editor.
    const projectInstanceId = getProjectInstanceId(project)
    if (!stillViewingInstance(project, chapterId, projectInstanceId)) return
    const current = get()
    const knownRevision =
      current.revisionProject === project && current.revision?.chapterId === chapterId ? current.revision : null
    // Focus/data-change refreshes can fire while a decision or bulk action is
    // in flight. A read for that same revision must not clear `saving`, reopen
    // the buttons, or remove the revision before the mutation response applies.
    if (current.saving && current.revisionProject === project && current.revision?.chapterId === chapterId) {
      return
    }
    const requestSequence = revisionLoadEpoch.begin()
    let loadLockOwner: string | null = null
    let unregisterLoadCleanup: (() => void) | null = null
    const releaseLoadLock = () => {
      unregisterLoadCleanup?.()
      unregisterLoadCleanup = null
      if (!loadLockOwner) return
      const owner = loadLockOwner
      loadLockOwner = null
      get().unlockEditor(project, chapterId, owner)
    }
    set((state) => {
      const keepsCurrentRevision = state.revisionProject === project && state.revision?.chapterId === chapterId
      return {
        loading: true,
        error: null,
        ...(keepsCurrentRevision ? {} : { revision: null, revisionProject: null, saving: false }),
      }
    })

    try {
      let { revision, rebased, chapterDataVersion } = await chapterRevisionsApi.getActive(project, chapterId)
      if (!stillViewingInstance(project, chapterId, projectInstanceId) || !revisionLoadEpoch.isCurrent(requestSequence))
        return
      let protectedRevision = knownRevision

      if (revision) {
        protectedRevision = revision
        // A revision replaces the editor. Persist and lock any in-flight input
        // before changing the rendered surface to RevisionReview.
        loadLockOwner = get().lockEditor(project, chapterId)
        unregisterLoadCleanup = revisionLoadEpoch.registerCleanup(requestSequence, () => {
          if (!loadLockOwner) return
          const owner = loadLockOwner
          loadLockOwner = null
          unregisterLoadCleanup = null
          get().unlockEditor(project, chapterId, owner)
        })
        await flushAndLockActiveEditor()
        if (
          !stillViewingInstance(project, chapterId, projectInstanceId) ||
          !revisionLoadEpoch.isCurrent(requestSequence)
        ) {
          releaseLoadLock()
          return
        }

        // The lookup may have completed while the reader was typing. Fetch once
        // more after the flush so the server can rebase against the just-saved
        // content instead of rendering an obsolete base snapshot.
        const refreshed = await chapterRevisionsApi.getActive(project, chapterId)
        if (
          !stillViewingInstance(project, chapterId, projectInstanceId) ||
          !revisionLoadEpoch.isCurrent(requestSequence)
        ) {
          releaseLoadLock()
          return
        }
        revision = refreshed.revision
        rebased ||= refreshed.rebased
        chapterDataVersion = refreshed.chapterDataVersion ?? chapterDataVersion
      }

      const hasPendingReconciliation = hasPendingRevisionMutation(project, projectInstanceId, chapterId)
      const chapterAuthorityAdvanced = authoritativeChapterAdvanced(project, chapterId, chapterDataVersion)
      if (!revision && (protectedRevision || hasPendingReconciliation || rebased || chapterAuthorityAdvanced)) {
        // A known revision disappearing can mean another window resolved it, or
        // that our own mutation committed but its ACK was lost. The data version
        // also covers a window that never observed the pending revision at all.
        // Keep the editor gated until the authoritative chapter has replaced
        // every stale pre-revision snapshot.
        const loaded = await reloadCurrentChapter(project, chapterId)
        if (
          !stillViewingInstance(project, chapterId, projectInstanceId) ||
          !revisionLoadEpoch.isCurrent(requestSequence)
        ) {
          releaseLoadLock()
          return
        }
        if (!loaded) {
          set({
            revision: protectedRevision,
            revisionProject: protectedRevision ? project : null,
            loading: false,
            saving: hasInFlightRevisionMutation(project, projectInstanceId, chapterId),
            error: '修订状态已变化，但无法刷新权威章节内容',
          })
          releaseLoadLock()
          return
        }
        resolveSettledRevisionMutations(project, projectInstanceId, chapterId)
        if (hasInFlightRevisionMutation(project, projectInstanceId, chapterId)) {
          set({
            revision: protectedRevision,
            revisionProject: protectedRevision ? project : null,
            loading: !protectedRevision,
            saving: Boolean(protectedRevision),
            error: null,
          })
          releaseLoadLock()
          return
        }
      }

      if (revision) resolveSettledRevisionMutations(project, projectInstanceId, chapterId)

      set({
        revision,
        revisionProject: revision ? project : null,
        loading: false,
        saving: revision ? hasInFlightRevisionMutation(project, projectInstanceId, chapterId) : false,
        error: null,
      })
      releaseLoadLock()
      if (rebased) await reloadCurrentChapter(project, chapterId)
    } catch (error) {
      releaseLoadLock()
      if (stillViewingInstance(project, chapterId, projectInstanceId) && revisionLoadEpoch.isCurrent(requestSequence)) {
        set((state) => {
          const keepsKnownRevision = state.revisionProject === project && state.revision?.chapterId === chapterId
          return {
            ...(keepsKnownRevision
              ? { saving: hasInFlightRevisionMutation(project, projectInstanceId, chapterId) }
              : { revision: null, revisionProject: null, saving: false }),
            loading: false,
            error: error instanceof Error ? error.message : '加载修订稿失败',
          }
        })
      }
    }
  },

  setRevision: (project, revision) => {
    if (revision && !stillViewing(project, revision.chapterId)) return
    revisionLoadEpoch.invalidate()
    set({
      revision,
      revisionProject: revision ? project : null,
      loading: false,
      saving: false,
      error: null,
    })
  },

  clearRevision: () => {
    revisionLoadEpoch.invalidate()
    // Clearing review state is not ownership of any editor lock, so preserve
    // every target/owner entry in editorLocks.
    set({
      revision: null,
      revisionProject: null,
      loading: false,
      saving: false,
      error: null,
    })
  },

  lockEditor: (project, chapterId) => {
    const owner = `editor-lock-${++editorLockOwnerSequence}`
    set((state) => {
      const existing = findEditorLock(state.editorLocks, project, chapterId)
      const targetLock = {
        project,
        chapterId,
        owners: existing ? [...existing.owners, owner] : [owner],
      }
      const editorLocks = existing
        ? state.editorLocks.map((lock) => (lock === existing ? targetLock : lock))
        : [...state.editorLocks, targetLock]
      return { editorLocks }
    })
    return owner
  },

  unlockEditor: (project, chapterId, owner) => {
    let releasedLastOwner = false
    set((state) => {
      const existing = findEditorLock(state.editorLocks, project, chapterId)
      if (!existing?.owners.includes(owner)) return state

      const owners = existing.owners.filter((candidate) => candidate !== owner)
      const editorLocks = owners.length
        ? state.editorLocks.map((lock) => (lock === existing ? { project, chapterId, owners } : lock))
        : state.editorLocks.filter((lock) => lock !== existing)
      releasedLastOwner = owners.length === 0
      return { editorLocks }
    })
    if (releasedLastOwner) unlockActiveEditor(project, chapterId)
  },

  decide: async (project, revisionId, changeId, decision) => {
    const revision = get().revision
    if (!revision || !isCurrentRevision(get(), project, revisionId) || get().saving) return

    // PATCH only the decision the user changed. Sending this window's whole
    // snapshot could replay stale values for other hunks over a newer writer.
    const decisions = { [changeId]: decision }
    revisionLoadEpoch.invalidate()
    set({ loading: false, saving: true, error: null })
    const mutation = beginRevisionMutation(project, revision.chapterId)
    try {
      const result = await chapterRevisionsApi.updateDecisions(project, revisionId, decisions, revision.baseContent)
      if (!canUseMutationResponse(mutation)) {
        completePendingRevisionMutation(mutation)
        return
      }
      if (
        !isCurrentRevision(get(), project, revisionId) ||
        !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
      ) {
        await settleDetachedRevisionMutation(mutation, get)
        return
      }
      revisionLoadEpoch.invalidate()

      if (result.rebased) {
        if (stillViewing(project, revision.chapterId)) {
          const loaded = await reloadCurrentChapter(project, revision.chapterId)
          if (!loaded) throw new Error('修订已重建，但无法刷新权威章节内容')
        }
        set({
          revision: result.revision || null,
          revisionProject: result.revision ? project : null,
          loading: false,
          saving: false,
        })
        completePendingRevisionMutation(mutation)
        return
      }

      const savedRevision = result.revision
      if (!savedRevision) throw new Error('待审修订不存在')

      // Persist the server copy before finalizing. If the second request fails,
      // the rendered state remains a recoverable all-decided revision.
      set({ revision: savedRevision, revisionProject: project, loading: false })
      completePendingRevisionMutation(mutation)
      const parts = buildRevisionParts(savedRevision.baseContent, savedRevision.proposedContent)
      if (countPendingRevisions(parts, savedRevision.decisions) > 0) {
        set({ loading: false, saving: false })
        return
      }

      await completeRevision(project, savedRevision, set, get)
    } catch (error) {
      if (!canUseMutationResponse(mutation)) {
        completePendingRevisionMutation(mutation)
        return
      }
      settlePendingRevisionMutation(mutation)
      await reconcileRevisionAfterMutationFailure(project, revision, error, set, get, '保存修订决定失败')
      if (
        !isCurrentRevision(get(), project, revisionId) ||
        !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
      ) {
        await settleDetachedRevisionMutation(mutation, get)
      }
    }
  },

  finalize: async (project, revisionId) => {
    const revision = get().revision
    if (!revision || !isCurrentRevision(get(), project, revisionId) || get().saving) return

    const parts = buildRevisionParts(revision.baseContent, revision.proposedContent)
    if (countPendingRevisions(parts, revision.decisions) > 0) return

    revisionLoadEpoch.invalidate()
    set({ loading: false, saving: true, error: null })
    await completeRevision(project, revision, set, get)
  },

  acceptAll: async (project, revisionId) => {
    const revision = get().revision
    if (!revision || !isCurrentRevision(get(), project, revisionId) || get().saving) return

    revisionLoadEpoch.invalidate()
    set({ loading: false, saving: true, error: null })
    const mutation = beginRevisionMutation(project, revision.chapterId)
    try {
      const result = await chapterRevisionsApi.acceptAll(project, revisionId, revision.baseContent)
      if (!canUseMutationResponse(mutation)) {
        completePendingRevisionMutation(mutation)
        return
      }
      if (
        !isCurrentRevision(get(), project, revisionId) ||
        !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
      ) {
        if (hasResolvedChapterPayload(result)) {
          applyResolvedChapter(project, revision.chapterId, result, 'accepted')
        }
        await settleDetachedRevisionMutation(mutation, get)
        return
      }
      revisionLoadEpoch.invalidate()

      if (result.rebased) {
        if (stillViewing(project, revision.chapterId)) {
          const loaded = await reloadCurrentChapter(project, revision.chapterId)
          if (!loaded) throw new Error('修订已重建，但无法刷新权威章节内容')
        }
        set({
          revision: result.revision || null,
          revisionProject: result.revision ? project : null,
          loading: false,
          saving: false,
        })
        completePendingRevisionMutation(mutation)
        return
      }

      if (
        stillViewing(project, revision.chapterId) &&
        !applyResolvedChapter(project, revision.chapterId, result, 'accepted')
      ) {
        const loaded = await reloadCurrentChapter(project, revision.chapterId)
        if (!loaded) throw new Error('修订已接受，但无法刷新章节内容')
      }
      revisionLoadEpoch.invalidate()
      set({ revision: null, revisionProject: null, loading: false, saving: false, error: null })
      completePendingRevisionMutation(mutation)
    } catch (error) {
      if (!canUseMutationResponse(mutation)) {
        completePendingRevisionMutation(mutation)
        return
      }
      settlePendingRevisionMutation(mutation)
      await reconcileRevisionAfterMutationFailure(project, revision, error, set, get, '接受修订稿失败')
      if (
        !isCurrentRevision(get(), project, revisionId) ||
        !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
      ) {
        await settleDetachedRevisionMutation(mutation, get)
      }
    }
  },

  rejectAll: async (project, revisionId) => {
    const revision = get().revision
    if (!revision || !isCurrentRevision(get(), project, revisionId) || get().saving) return

    revisionLoadEpoch.invalidate()
    set({ loading: false, saving: true, error: null })
    const mutation = beginRevisionMutation(project, revision.chapterId)
    try {
      const result = await chapterRevisionsApi.rejectAll(project, revisionId, revision.baseContent)
      if (!canUseMutationResponse(mutation)) {
        completePendingRevisionMutation(mutation)
        return
      }
      if (
        !isCurrentRevision(get(), project, revisionId) ||
        !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
      ) {
        if (hasResolvedChapterPayload(result)) {
          applyResolvedChapter(project, revision.chapterId, result, revision.previousChapterStatus || 'writing')
        }
        await settleDetachedRevisionMutation(mutation, get)
        return
      }
      revisionLoadEpoch.invalidate()

      if (result.rebased) {
        if (stillViewing(project, revision.chapterId)) {
          const loaded = await reloadCurrentChapter(project, revision.chapterId)
          if (!loaded) throw new Error('修订已重建，但无法刷新权威章节内容')
        }
        set({
          revision: result.revision || null,
          revisionProject: result.revision ? project : null,
          loading: false,
          saving: false,
        })
        completePendingRevisionMutation(mutation)
        return
      }

      if (
        stillViewing(project, revision.chapterId) &&
        !applyResolvedChapter(project, revision.chapterId, result, revision.previousChapterStatus || 'writing')
      ) {
        const loaded = await reloadCurrentChapter(project, revision.chapterId)
        if (!loaded) throw new Error('修订已拒绝，但无法刷新章节状态')
      }
      revisionLoadEpoch.invalidate()
      set({ revision: null, revisionProject: null, loading: false, saving: false, error: null })
      completePendingRevisionMutation(mutation)
    } catch (error) {
      if (!canUseMutationResponse(mutation)) {
        completePendingRevisionMutation(mutation)
        return
      }
      settlePendingRevisionMutation(mutation)
      await reconcileRevisionAfterMutationFailure(project, revision, error, set, get, '拒绝修订稿失败')
      if (
        !isCurrentRevision(get(), project, revisionId) ||
        !stillViewingInstance(project, revision.chapterId, mutation.projectInstanceId)
      ) {
        await settleDetachedRevisionMutation(mutation, get)
      }
    }
  },
}))
