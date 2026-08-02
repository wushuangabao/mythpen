import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore } from '@/stores/useProjectStore'
import type {
  Chapter,
  Character,
  CharacterRelation,
  Foreshadow,
  Memory,
  ProjectStats,
  ScienceEntry,
  TimelineEvent,
  Volume,
  WorldEntry,
} from '@/types'
import {
  chaptersApi,
  charactersApi,
  foreshadowsApi,
  memoriesApi,
  relationsApi,
  scienceApi,
  settingsApi,
  statsApi,
  timelineApi,
  volumesApi,
  worldApi,
} from './api'
import { createProjectDataFetcher, projectDataDependencyKey } from './projectDataScope'
import { createRequestCommitTracker } from './requestCommitTracker'

// ─── Generic fetch hook ───
function useApiData<T>(
  fetcher: (() => Promise<T>) | null,
  dependencyKey: string,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [dataState, setDataState] = useState<{ key: string; value: T } | null>(null)
  const [requestState, setRequestState] = useState<{ key: string; loading: boolean; error: string | null }>(() => ({
    key: dependencyKey,
    loading: fetcher !== null,
    error: null,
  }))

  const fetcherRef = useRef(fetcher)
  const activeDependencyKeyRef = useRef(dependencyKey)
  const requestTrackerRef = useRef(createRequestCommitTracker(dependencyKey))
  fetcherRef.current = fetcher
  // Invalidate the previous project's response as soon as this render observes
  // a new key, without waiting for the effect that starts the replacement load.
  activeDependencyKeyRef.current = dependencyKey
  requestTrackerRef.current.activate(dependencyKey)

  const load = useCallback(async (requestDependencyKey: string) => {
    // A callback captured by an older render must not restart that old key with
    // the current fetcher or disturb the current loading state.
    if (activeDependencyKeyRef.current !== requestDependencyKey) return
    const activeFetcher = fetcherRef.current
    if (!activeFetcher) return
    const ticket = requestTrackerRef.current.start(requestDependencyKey)
    if (!ticket) return
    setRequestState({ key: requestDependencyKey, loading: true, error: null })
    try {
      const result = await activeFetcher()
      if (requestTrackerRef.current.claimSuccess(ticket)) {
        setDataState({ key: requestDependencyKey, value: result })
        setRequestState((current) => (current.key === requestDependencyKey ? { ...current, error: null } : current))
      }
    } catch (e) {
      if (requestTrackerRef.current.isLatest(ticket)) {
        setRequestState({ key: requestDependencyKey, loading: false, error: (e as Error).message })
      }
    } finally {
      if (requestTrackerRef.current.isLatest(ticket)) {
        setRequestState((current) => (current.key === requestDependencyKey ? { ...current, loading: false } : current))
      }
    }
  }, [])

  useEffect(() => {
    if (!fetcherRef.current) {
      setRequestState({ key: dependencyKey, loading: false, error: null })
      return
    }
    void load(dependencyKey)
  }, [dependencyKey, load])

  const reload = useCallback(() => {
    void load(dependencyKey)
  }, [dependencyKey, load])

  return {
    data: dataState?.key === dependencyKey ? dataState.value : null,
    loading: fetcher ? (requestState.key === dependencyKey ? requestState.loading : true) : false,
    error: fetcher && requestState.key === dependencyKey ? requestState.error : null,
    reload,
  }
}

// ─── Project-specific hooks ───
export function useProjectName(): string {
  // An empty value is an inactive scope, not a real fallback project name.
  // Project data hooks below translate it to a null fetcher and issue no API
  // request until the store owns an actual project again.
  return useProjectStore((s) => s.currentProject || '')
}

export function useProjectInstanceId(): string {
  return useProjectStore((state) => {
    if (!state.currentProject) return ''
    return state.projects.find((project) => project.name === state.currentProject)?.instanceId || ''
  })
}

function useProjectScope(): { project: string; instanceId: string; dependencyKey: string } {
  const project = useProjectName()
  const instanceId = useProjectInstanceId()
  return { project, instanceId, dependencyKey: projectDataDependencyKey(project, instanceId) }
}

export function useChapters(): { chapters: Chapter[]; loading: boolean } {
  const { project, instanceId, dependencyKey } = useProjectScope()
  const { data, loading } = useApiData<Chapter[]>(
    createProjectDataFetcher(project, (activeProject) => chaptersApi.list(activeProject), instanceId),
    dependencyKey,
  )
  return { chapters: data ?? [], loading }
}

export function useVolumes(): { data: Volume[] | null; loading: boolean; error: string | null; reload: () => void } {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<Volume[]>(
    createProjectDataFetcher(project, (activeProject) => volumesApi.list(activeProject), instanceId),
    dependencyKey,
  )
}

export function useCharacters(): {
  data: Character[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<Character[]>(
    createProjectDataFetcher(project, (activeProject) => charactersApi.list(activeProject), instanceId),
    dependencyKey,
  )
}

export function useWorldEntries(): {
  data: WorldEntry[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<WorldEntry[]>(
    createProjectDataFetcher(project, (activeProject) => worldApi.list(activeProject), instanceId),
    dependencyKey,
  )
}

export function useScienceEntries(): {
  data: ScienceEntry[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<ScienceEntry[]>(
    createProjectDataFetcher(project, (activeProject) => scienceApi.list(activeProject), instanceId),
    dependencyKey,
  )
}

export function useForeshadows(status?: string): {
  data: Foreshadow[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const { project, instanceId } = useProjectScope()
  return useApiData<Foreshadow[]>(
    createProjectDataFetcher(project, (activeProject) => foreshadowsApi.list(activeProject, status), instanceId),
    projectDataDependencyKey(project, instanceId, status),
  )
}

export function useRelations(): {
  data: CharacterRelation[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<CharacterRelation[]>(
    createProjectDataFetcher(project, (activeProject) => relationsApi.list(activeProject), instanceId),
    dependencyKey,
  )
}

export function useMemories(): { data: Memory[] | null; loading: boolean; error: string | null; reload: () => void } {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<Memory[]>(
    createProjectDataFetcher(project, (activeProject) => memoriesApi.list(activeProject), instanceId),
    dependencyKey,
  )
}

export function useTimelineEvents(): {
  data: TimelineEvent[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<TimelineEvent[]>(
    createProjectDataFetcher(project, (activeProject) => timelineApi.list(activeProject), instanceId),
    dependencyKey,
  )
}

export function useStats(): { data: ProjectStats | null; loading: boolean; error: string | null; reload: () => void } {
  const { project, instanceId, dependencyKey } = useProjectScope()
  return useApiData<ProjectStats>(
    createProjectDataFetcher(project, (activeProject) => statsApi.get(activeProject), instanceId),
    dependencyKey,
  )
}

export function useSettings() {
  return useApiData(() => settingsApi.get(), 'settings')
}

// ─── Chapter content ───
export function useChapterContent(num: number) {
  const { project, instanceId } = useProjectScope()
  return useApiData(
    createProjectDataFetcher(project, (activeProject) => chaptersApi.get(activeProject, num), instanceId),
    projectDataDependencyKey(project, instanceId, num),
  )
}
