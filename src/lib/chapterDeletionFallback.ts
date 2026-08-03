export function getChapterDeletionFallbackId(
  chapters: readonly { id: number }[],
  deletedChapterId: number,
): number | null {
  const deletedIndex = chapters.findIndex((chapter) => chapter.id === deletedChapterId)
  if (deletedIndex < 0) return null
  return chapters[deletedIndex + 1]?.id ?? chapters[deletedIndex - 1]?.id ?? null
}
