export interface EditorSyncState {
  targetChanged: boolean
  editorLocked: boolean
  isEditing: boolean
  chapterDataVersionChanged: boolean
}

/**
 * A persisted chapter version change is authoritative even if React batches
 * the intermediate locked render and the contenteditable still owns focus.
 */
export function shouldSynchronizeEditorDom(state: EditorSyncState): boolean {
  return state.targetChanged || state.editorLocked || state.chapterDataVersionChanged || !state.isEditing
}
