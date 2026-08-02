import { useEffect, useLayoutEffect } from 'react'
import { EditorContent } from '@/components/EditorContent'
import { EditorStatusbar } from '@/components/EditorStatusbar'
import { EditorToolbar } from '@/components/EditorToolbar'
import { RevisionReview } from '@/components/RevisionReview'
import { onDataChanged } from '@/lib/dataEvents'
import { useChapterStore } from '@/stores/useChapterStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useRevisionStore } from '@/stores/useRevisionStore'

export function Writing() {
  const currentChapter = useChapterStore((s) => s.currentChapter)
  const chapterProject = useChapterStore((s) => s.projectName)
  const project = useProjectStore((s) => s.currentProject)
  const revision = useRevisionStore((s) => s.revision)
  const revisionProject = useRevisionStore((s) => s.revisionProject)
  const loadRevision = useRevisionStore((s) => s.loadRevision)
  const clearRevision = useRevisionStore((s) => s.clearRevision)
  const chapter = chapterProject === project ? currentChapter : null
  const chapterId = chapter?.id
  const reviewing = revisionProject === project && revision?.chapterId === chapter?.id

  // Writing owns the revision lookup because it remains mounted while
  // EditorContent is replaced by RevisionReview. Keeping this effect in the
  // editor would clear the revision during that intentional child unmount.
  useLayoutEffect(() => {
    if (!project || !chapterId || chapterProject !== project) {
      clearRevision()
      return
    }
    void loadRevision(project, chapterId)
    return () => clearRevision()
  }, [chapterId, chapterProject, clearRevision, loadRevision, project])

  useEffect(() => {
    if (!project || !chapterId || chapterProject !== project) return
    const refresh = () => void loadRevision(project, chapterId)
    const unsubscribe = onDataChanged((event) => {
      if (event.entity === 'chapter' || event.entity === 'all') refresh()
    })
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [chapterId, chapterProject, loadRevision, project])

  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--canvas)]">
      <EditorToolbar />
      {reviewing ? <RevisionReview /> : <EditorContent />}
      <EditorStatusbar />
    </main>
  )
}
