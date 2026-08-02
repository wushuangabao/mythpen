interface VersionedValue<T> {
  dataVersion: number
  value: T
}

interface ChapterDataEntry<TChapter extends object> {
  full?: VersionedValue<TChapter>
  fields: Map<keyof TChapter, VersionedValue<TChapter[keyof TChapter]>>
}

/** Legacy responses without a version remain usable, but a versioned response
 * may never replace a chapter snapshot committed later by the database. */
export function shouldApplyChapterDataVersion(
  incomingDataVersion: number | undefined,
  knownDataVersion: number,
): boolean {
  return !Number.isSafeInteger(incomingDataVersion) || (incomingDataVersion as number) >= knownDataVersion
}

/**
 * Records successful chapter reads/writes independently of the currently
 * mounted project store. A list response can then merge changes that completed
 * after that list started, even when navigation temporarily emptied the store.
 */
export function createChapterDataJournal<TChapter extends object>() {
  const projects = new Map<string, Map<number, ChapterDataEntry<TChapter>>>()

  const getEntry = (project: string, chapterId: number): ChapterDataEntry<TChapter> => {
    const chapters = projects.get(project) ?? new Map<number, ChapterDataEntry<TChapter>>()
    const entry = chapters.get(chapterId) ?? { fields: new Map() }
    chapters.set(chapterId, entry)
    projects.set(project, chapters)
    return entry
  }

  return {
    clearProject(project: string): boolean {
      return projects.delete(project)
    },

    recordFull(project: string, chapterId: number, chapter: TChapter, dataVersion: number): void {
      if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) return
      const entry = getEntry(project, chapterId)
      if (!entry.full || dataVersion >= entry.full.dataVersion) {
        entry.full = { dataVersion, value: chapter }
      }
    },

    recordPatch(project: string, chapterId: number, patch: Partial<TChapter>, dataVersion: number): void {
      const fields = Object.keys(patch) as Array<keyof TChapter>
      if (fields.length === 0 || !Number.isSafeInteger(dataVersion) || dataVersion < 0) return
      const entry = getEntry(project, chapterId)
      for (const field of fields) {
        const existing = entry.fields.get(field)
        if (!existing || dataVersion >= existing.dataVersion) {
          entry.fields.set(field, { dataVersion, value: patch[field] as TChapter[keyof TChapter] })
        }
      }
    },

    mergeSnapshot(
      project: string,
      chapterId: number,
      loaded: TChapter,
      loadedDataVersion: number,
      identityFields: readonly (keyof TChapter)[] = [],
    ): TChapter {
      const entry = projects.get(project)?.get(chapterId)
      if (!entry) return loaded

      let merged = { ...loaded }
      let fieldVersionFloor = Number.isSafeInteger(loadedDataVersion) ? loadedDataVersion : -1
      if (entry.full && entry.full.dataVersion > fieldVersionFloor) {
        merged = { ...entry.full.value }
        for (const field of identityFields) {
          Object.assign(merged, { [field]: loaded[field] })
        }
        fieldVersionFloor = entry.full.dataVersion
      }

      for (const [field, change] of entry.fields) {
        if (change.dataVersion > fieldVersionFloor) {
          Object.assign(merged, { [field]: change.value })
        }
      }
      return merged
    },
  }
}
