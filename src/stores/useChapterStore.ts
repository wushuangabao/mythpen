import { create } from 'zustand'
import { t } from '@/i18n'
import { chaptersApi, volumesApi } from '@/lib/api'
import { createChapterDataJournal, shouldApplyChapterDataVersion } from '@/lib/chapterDataJournal'
import { createRequestCommitTracker } from '@/lib/requestCommitTracker'
import { useProjectStore } from '@/stores/useProjectStore'

interface Chapter {
  id: number
  volumeId: number
  num: number
  dataVersion: number
  title: string
  outline: string
  content: string
  wordCount: number
  status: string
  cognitiveFrame?: string
  emotionalAnchor?: string
  worldTexture?: string
  concreteMystery?: string
  interpersonalTension?: string
}

interface ApiChapterRow {
  id: number | string
  volume_id: number | string
  num: number | string
  data_version?: number | string | null
  title: string
  outline?: string | null
  content?: string | null
  word_count?: number | null
  status: string
  cognitive_frame?: string | null
  emotional_anchor?: string | null
  world_texture?: string | null
  concrete_mystery?: string | null
  interpersonal_tension?: string | null
}

interface Volume {
  id: number
  sortOrder: number
  title: string
  chapters: Chapter[]
}

interface ChapterState {
  volumes: Volume[]
  currentChapter: Chapter | null
  loading: boolean
  projectName: string | null
  saveStatus: 'saved' | 'saving' | 'unsaved'
  setSaveStatus: (status: 'saved' | 'saving' | 'unsaved') => void
  activateProject: (project: string | null) => void
  discardProjectState: (project: string) => void
  invalidateChapterStructure: (project: string) => void
  setCurrentChapter: (ch: Chapter | null) => void
  loadChapters: (project: string) => Promise<void>
  loadChapterContent: (project: string, num: number, volumeId?: number) => Promise<boolean>
  applyPersistedChapterContent: (
    project: string,
    chapterId: number,
    content: string,
    wordCount: number,
    status?: string,
    dataVersion?: number,
  ) => boolean
  updateChapter: (
    project: string,
    num: number,
    data: Partial<Chapter>,
    chapterId?: number,
    expectedDataVersion?: number,
  ) => Promise<number | undefined>
  createChapter: (project: string, title?: string, outline?: string, volumeId?: number) => Promise<any>
}

const EMPTY_VOLUMES: Volume[] = []
const CHAPTER_IDENTITY_FIELDS = ['id', 'volumeId', 'num'] as const
const chapterContentRequestSequences = new Map<string, number>()
const chapterListRequests = createRequestCommitTracker('')
const chapterStructureVersions = new Map<string, number>()
const chapterProjectEpochs = new Map<string, number>()
const chapterDataJournal = createChapterDataJournal<Chapter>()

function nextChapterContentRequestSequence(project: string): number {
  const sequence = (chapterContentRequestSequences.get(project) || 0) + 1
  chapterContentRequestSequences.set(project, sequence)
  return sequence
}

function getChapterContentRequestSequence(project: string): number {
  return chapterContentRequestSequences.get(project) || 0
}

function getChapterStructureVersion(project: string): number {
  return chapterStructureVersions.get(project) || 0
}

function markChapterStructureChanged(project: string): void {
  chapterStructureVersions.set(project, getChapterStructureVersion(project) + 1)
}

function getChapterProjectEpoch(project: string): number {
  return chapterProjectEpochs.get(project) || 0
}

function invalidateChapterProject(project: string): void {
  chapterProjectEpochs.set(project, getChapterProjectEpoch(project) + 1)
}

function getKnownChapterDataVersion(
  volumes: readonly Volume[],
  currentChapter: Chapter | null,
  chapterId: number,
): number {
  let latest = currentChapter?.id === chapterId ? currentChapter.dataVersion : -1
  for (const volume of volumes) {
    const chapter = volume.chapters.find((candidate) => candidate.id === chapterId)
    if (chapter) latest = Math.max(latest, chapter.dataVersion)
  }
  return latest
}

function mapApiChapter(chapter: ApiChapterRow): Chapter {
  const parsedDataVersion = Number(chapter.data_version)
  return {
    id: Number(chapter.id),
    volumeId: Number(chapter.volume_id),
    num: Number(chapter.num),
    dataVersion: Number.isSafeInteger(parsedDataVersion) && parsedDataVersion >= 0 ? parsedDataVersion : 0,
    title: chapter.title,
    outline: chapter.outline || '',
    content: chapter.content || '',
    wordCount: chapter.word_count || 0,
    status: chapter.status,
    cognitiveFrame: chapter.cognitive_frame || '',
    emotionalAnchor: chapter.emotional_anchor || '',
    worldTexture: chapter.world_texture || '',
    concreteMystery: chapter.concrete_mystery || '',
    interpersonalTension: chapter.interpersonal_tension || '',
  }
}

export const useChapterStore = create<ChapterState>((set, get) => ({
  volumes: EMPTY_VOLUMES,
  currentChapter: null,
  loading: false,
  projectName: null,
  saveStatus: 'saved',

  setSaveStatus: (status) => set({ saveStatus: status }),

  activateProject: (project) => {
    chapterListRequests.activate(project || '')
    if (get().projectName === project) return
    if (project) nextChapterContentRequestSequence(project)
    set({
      volumes: EMPTY_VOLUMES,
      currentChapter: null,
      loading: Boolean(project),
      projectName: project,
      saveStatus: 'saved',
    })
  },

  discardProjectState: (project) => {
    // Project names are reusable. Advance monotonic guards rather than
    // resetting counters, otherwise a late request from the deleted instance
    // can accidentally have the same sequence as the replacement instance.
    invalidateChapterProject(project)
    chapterDataJournal.clearProject(project)
    nextChapterContentRequestSequence(project)
    markChapterStructureChanged(project)
    chapterListRequests.invalidate(project)
    if (get().projectName !== project) return
    set({
      volumes: EMPTY_VOLUMES,
      currentChapter: null,
      loading: false,
      projectName: null,
      saveStatus: 'saved',
    })
  },

  invalidateChapterStructure: (project) => {
    // AI tools write directly through the server and therefore bypass the
    // store's create/delete methods. Advance both guards before reloading so a
    // pre-mutation list/detail response cannot become a fallback when the
    // post-mutation refresh fails.
    markChapterStructureChanged(project)
    chapterListRequests.invalidate(project)
    nextChapterContentRequestSequence(project)
  },

  setCurrentChapter: (ch) => set({ currentChapter: ch }),

  loadChapters: async (project) => {
    // A create/save from the previous project may still ask for a refresh after
    // navigation. Do not let that stale request touch the active loading state.
    if (useProjectStore.getState().currentProject !== project) return
    chapterListRequests.activate(project)
    const request = chapterListRequests.start(project)
    if (!request) return
    const projectEpochAtStart = getChapterProjectEpoch(project)
    const structureVersionAtStart = getChapterStructureVersion(project)
    // A list started after a detail request represents the newer read. Details
    // started after this point remain valid and are merged field-safely below.
    nextChapterContentRequestSequence(project)
    set((state) => {
      if (useProjectStore.getState().currentProject !== project) return state
      if (state.projectName === project) return { loading: true }

      // Never expose the previous project's chapter identifiers under the new
      // currentProject. Writable consumers render between this call and the
      // response, so retaining the old selection can target the wrong database.
      return {
        loading: true,
        volumes: EMPTY_VOLUMES,
        currentChapter: null,
        projectName: project,
        saveStatus: 'saved',
      }
    })
    try {
      const vols = await volumesApi.list(project)

      // Structural writes invalidate snapshots that started before the write.
      // Ordinary overlapping refreshes do not: an older success is still useful
      // when a newer request failed.
      if (
        getChapterProjectEpoch(project) !== projectEpochAtStart ||
        getChapterStructureVersion(project) !== structureVersionAtStart ||
        useProjectStore.getState().currentProject !== project
      )
        return

      const loadedVolumes: Volume[] = vols.map((v: any) => ({
        id: v.id,
        sortOrder: v.sort_order,
        title: v.title,
        chapters: (v.chapters || []).map(mapApiChapter),
      }))

      set((state) => {
        if (
          getChapterProjectEpoch(project) !== projectEpochAtStart ||
          getChapterStructureVersion(project) !== structureVersionAtStart ||
          useProjectStore.getState().currentProject !== project ||
          !chapterListRequests.claimSuccess(request)
        )
          return state

        // A chapter detail/write may have committed after this list request
        // started. Keep its journalled authoritative values while still
        // accepting the list's structural additions, removals, and ordering.
        const volumes = loadedVolumes.map((volume) => ({
          ...volume,
          chapters: volume.chapters.map((chapter) => {
            // A committed list is also an authoritative full-row snapshot.
            // Journal it before merging so a detail request that read an older
            // database version cannot later roll this list result back.
            chapterDataJournal.recordFull(project, chapter.id, chapter, chapter.dataVersion)
            return chapterDataJournal.mergeSnapshot(
              project,
              chapter.id,
              chapter,
              chapter.dataVersion,
              CHAPTER_IDENTITY_FIELDS,
            )
          }),
        }))

        const previousId = state.projectName === project ? state.currentChapter?.id : undefined
        let currentChapter = previousId
          ? volumes
              .flatMap((volume: Volume) => volume.chapters)
              .find((chapter: Chapter) => chapter.id === previousId) || null
          : null
        // Find current: preserve selection, then first chapter with content,
        // writing chapter, or the first chapter in the project.
        if (!currentChapter) {
          for (const volume of volumes) {
            currentChapter =
              volume.chapters.find((chapter: Chapter) => chapter.content) ||
              volume.chapters.find(
                (chapter: Chapter) => chapter.status === 'writing' || chapter.status === 'pending',
              ) ||
              volume.chapters[0] ||
              null
            if (currentChapter) break
          }
        }

        return { volumes, currentChapter, loading: false, projectName: project }
      })
    } catch (err) {
      console.error('Failed to load chapters:', err)
      if (
        getChapterProjectEpoch(project) === projectEpochAtStart &&
        chapterListRequests.isLatest(request) &&
        useProjectStore.getState().currentProject === project
      )
        set({ loading: false })
    }
  },

  loadChapterContent: async (project, num, volumeId) => {
    if (useProjectStore.getState().currentProject !== project || get().projectName !== project) return false
    const projectEpochAtStart = getChapterProjectEpoch(project)
    const requestSequence = nextChapterContentRequestSequence(project)
    try {
      const ch = await chaptersApi.get(project, num, volumeId)
      const state = get()
      if (
        !ch ||
        getChapterProjectEpoch(project) !== projectEpochAtStart ||
        requestSequence !== getChapterContentRequestSequence(project) ||
        useProjectStore.getState().currentProject !== project ||
        state.projectName !== project ||
        Number(ch.num) !== num ||
        (volumeId !== undefined && Number(ch.volume_id) !== volumeId)
      ) {
        return false
      }

      const loadedChapter = mapApiChapter(ch)
      let applied = false
      set((currentState) => {
        // Recheck inside the state update so a project/list replacement cannot be
        // overwritten by a response that belongs to the previous editor target.
        if (
          getChapterProjectEpoch(project) !== projectEpochAtStart ||
          requestSequence !== getChapterContentRequestSequence(project) ||
          currentState.projectName !== project ||
          useProjectStore.getState().currentProject !== project
        ) {
          return currentState
        }

        const knownDataVersion = getKnownChapterDataVersion(
          currentState.volumes,
          currentState.currentChapter,
          loadedChapter.id,
        )
        if (!shouldApplyChapterDataVersion(loadedChapter.dataVersion, knownDataVersion)) {
          return currentState
        }

        chapterDataJournal.recordFull(project, loadedChapter.id, loadedChapter, loadedChapter.dataVersion)
        const chapter = chapterDataJournal.mergeSnapshot(
          project,
          loadedChapter.id,
          loadedChapter,
          loadedChapter.dataVersion,
          CHAPTER_IDENTITY_FIELDS,
        )
        const volumes = currentState.volumes.map((volume) => ({
          ...volume,
          chapters: volume.chapters.map((existing) =>
            existing.id === chapter.id ? { ...existing, ...chapter } : existing,
          ),
        }))
        applied = true
        return {
          volumes,
          currentChapter: currentState.currentChapter?.id === chapter.id ? chapter : currentState.currentChapter,
          loading: currentState.currentChapter?.id === chapter.id ? false : currentState.loading,
        }
      })
      return applied
    } catch (err) {
      console.error('Failed to load chapter content:', err)
      return false
    }
  },

  applyPersistedChapterContent: (project, chapterId, content, wordCount, status = 'writing', dataVersion) => {
    const persistedPatch = {
      content,
      wordCount,
      status,
      ...(Number.isSafeInteger(dataVersion) ? { dataVersion } : {}),
    }
    if (Number.isSafeInteger(dataVersion)) {
      chapterDataJournal.recordPatch(project, chapterId, persistedPatch, dataVersion as number)
    }
    if (useProjectStore.getState().currentProject !== project || get().projectName !== project) return false
    if (get().currentChapter?.id === chapterId) nextChapterContentRequestSequence(project)

    let applied = false
    set((state) => {
      if (state.projectName !== project || useProjectStore.getState().currentProject !== project) return state
      if (
        !shouldApplyChapterDataVersion(
          dataVersion,
          getKnownChapterDataVersion(state.volumes, state.currentChapter, chapterId),
        )
      ) {
        return state
      }
      const applyContent = (chapter: Chapter): Chapter => {
        if (chapter.id !== chapterId) return chapter
        applied = true
        return { ...chapter, ...persistedPatch }
      }
      return {
        volumes: state.volumes.map((volume) => ({
          ...volume,
          chapters: volume.chapters.map(applyContent),
        })),
        currentChapter: state.currentChapter ? applyContent(state.currentChapter) : null,
        loading: state.currentChapter?.id === chapterId ? false : state.loading,
      }
    })
    return applied
  },

  updateChapter: async (project, num, data, chapterId, expectedDataVersion) => {
    const projectEpochAtStart = getChapterProjectEpoch(project)
    try {
      const apiData: any = {}
      if (data.title !== undefined) apiData.title = data.title
      if (data.content !== undefined) apiData.content = data.content
      if (data.outline !== undefined) apiData.outline = data.outline
      if (data.status !== undefined) apiData.status = data.status
      if (data.cognitiveFrame !== undefined) apiData.cognitive_frame = data.cognitiveFrame
      if (data.emotionalAnchor !== undefined) apiData.emotional_anchor = data.emotionalAnchor
      if (data.worldTexture !== undefined) apiData.world_texture = data.worldTexture
      if (data.concreteMystery !== undefined) apiData.concrete_mystery = data.concreteMystery
      if (data.interpersonalTension !== undefined) apiData.interpersonal_tension = data.interpersonalTension

      const updated = await chaptersApi.update(project, num, apiData, chapterId, expectedDataVersion)
      if (getChapterProjectEpoch(project) !== projectEpochAtStart) return

      // A queue entry owns a stable chapter id even while A -> B -> A navigation
      // has emptied the active store. Record the successful write before any
      // active-project guard so an older in-flight list can merge its real value.
      const returnedChapterId = Number(updated?.id)
      const persistedChapterId = chapterId ?? (Number.isInteger(returnedChapterId) ? returnedChapterId : undefined)
      if (persistedChapterId === undefined) throw new Error('服务器未返回章节标识')
      if (returnedChapterId !== persistedChapterId) throw new Error('服务器返回了错误的章节标识')
      const persistedChapter = mapApiChapter(updated)
      const returnedDataVersion = persistedChapter.dataVersion

      const stateBeforePatch = get()
      if (
        stateBeforePatch.projectName === project &&
        useProjectStore.getState().currentProject === project &&
        stateBeforePatch.currentChapter?.id === persistedChapterId
      ) {
        // Only a save for the visible target may invalidate its pending detail
        // read. A delayed save from chapter A must not cancel chapter B's GET.
        nextChapterContentRequestSequence(project)
      }
      chapterDataJournal.recordFull(project, persistedChapterId, persistedChapter, returnedDataVersion)

      // The PUT response is an authoritative full row at this database version.
      // Applying it also keeps other fields that committed before this response.
      if (useProjectStore.getState().currentProject === project && get().projectName === project) {
        set((state) => {
          if (state.projectName !== project || useProjectStore.getState().currentProject !== project) return state
          if (
            !shouldApplyChapterDataVersion(
              returnedDataVersion,
              getKnownChapterDataVersion(state.volumes, state.currentChapter, persistedChapterId),
            )
          ) {
            return state
          }
          const applyPatch = (chapter: Chapter): Chapter => {
            if (chapter.id !== persistedChapterId) return chapter
            return persistedChapter
          }
          return {
            volumes: state.volumes.map((volume) => ({
              ...volume,
              chapters: volume.chapters.map(applyPatch),
            })),
            currentChapter: state.currentChapter ? applyPatch(state.currentChapter) : null,
            loading: state.currentChapter?.id === persistedChapterId ? false : state.loading,
          }
        })
      }
      return returnedDataVersion
    } catch (err) {
      console.error('Failed to update chapter:', err)
      throw err
    }
  },

  createChapter: async (project, title = t('chapter.defaultTitle'), outline = '', volumeId?: number) => {
    const projectEpochAtStart = getChapterProjectEpoch(project)
    try {
      const created = await chaptersApi.create(project, { title, outline, volume_id: volumeId })
      if (getChapterProjectEpoch(project) !== projectEpochAtStart) return created
      markChapterStructureChanged(project)
      nextChapterContentRequestSequence(project)
      if (useProjectStore.getState().currentProject === project && get().projectName === project) {
        set({ loading: false })
      }
      // Reload chapters to include the new one
      await useChapterStore.getState().loadChapters(project)
      // Set the newly created chapter only if this project still owns the store.
      set((s) => {
        if (useProjectStore.getState().currentProject !== project || s.projectName !== project) return s
        const ch =
          s.volumes
            .flatMap((volume) => volume.chapters)
            .find(
              (chapter) =>
                chapter.id === created.id || (chapter.num === created.num && chapter.volumeId === created.volume_id),
            ) || null
        return { currentChapter: ch }
      })
      return created
    } catch (err) {
      console.error('Failed to create chapter:', err)
      throw err
    }
  },
}))
