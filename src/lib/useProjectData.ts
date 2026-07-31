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

// ─── Generic fetch hook ───
function useApiData<T>(
  fetcher: () => Promise<T>,
  dependencyKey: string,
): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetcherRef = useRef(fetcher)
  const activeDependencyKeyRef = useRef(dependencyKey)
  fetcherRef.current = fetcher

  const load = useCallback(async (requestDependencyKey: string) => {
    activeDependencyKeyRef.current = requestDependencyKey
    setLoading(true)
    setError(null)
    try {
      const result = await fetcherRef.current()
      if (activeDependencyKeyRef.current === requestDependencyKey) setData(result)
    } catch (e) {
      if (activeDependencyKeyRef.current === requestDependencyKey) setError((e as Error).message)
    } finally {
      if (activeDependencyKeyRef.current === requestDependencyKey) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(dependencyKey)
  }, [dependencyKey, load])

  const reload = useCallback(() => {
    void load(dependencyKey)
  }, [dependencyKey, load])

  return { data, loading, error, reload }
}

// ─── Project-specific hooks ───
export function useProjectName(): string {
  return useProjectStore((s) => s.currentProject || '我的科幻小说')
}

export function useChapters(): { chapters: Chapter[]; loading: boolean } {
  const project = useProjectName()
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!project) return
    setLoading(true)
    chaptersApi
      .list(project)
      .then(setChapters)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [project])

  return { chapters, loading }
}

export function useVolumes(): { data: Volume[] | null; loading: boolean; error: string | null; reload: () => void } {
  const project = useProjectName()
  return useApiData<Volume[]>(() => volumesApi.list(project), project)
}

export function useCharacters(): {
  data: Character[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const project = useProjectName()
  return useApiData<Character[]>(() => charactersApi.list(project), project)
}

export function useWorldEntries(): {
  data: WorldEntry[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const project = useProjectName()
  return useApiData<WorldEntry[]>(() => worldApi.list(project), project)
}

export function useScienceEntries(): {
  data: ScienceEntry[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const project = useProjectName()
  return useApiData<ScienceEntry[]>(() => scienceApi.list(project), project)
}

export function useForeshadows(status?: string): {
  data: Foreshadow[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const project = useProjectName()
  return useApiData<Foreshadow[]>(() => foreshadowsApi.list(project, status), JSON.stringify([project, status]))
}

export function useRelations(): {
  data: CharacterRelation[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const project = useProjectName()
  return useApiData<CharacterRelation[]>(() => relationsApi.list(project), project)
}

export function useMemories(): { data: Memory[] | null; loading: boolean; error: string | null; reload: () => void } {
  const project = useProjectName()
  return useApiData<Memory[]>(() => memoriesApi.list(project), project)
}

export function useTimelineEvents(): {
  data: TimelineEvent[] | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const project = useProjectName()
  return useApiData<TimelineEvent[]>(() => timelineApi.list(project), project)
}

export function useStats(): { data: ProjectStats | null; loading: boolean; error: string | null; reload: () => void } {
  const project = useProjectName()
  return useApiData<ProjectStats>(() => statsApi.get(project), project)
}

export function useSettings() {
  return useApiData(() => settingsApi.get(), 'settings')
}

// ─── Chapter content ───
export function useChapterContent(num: number) {
  const project = useProjectName()
  return useApiData(() => chaptersApi.get(project, num), JSON.stringify([project, num]))
}
