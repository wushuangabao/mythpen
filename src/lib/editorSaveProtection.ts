import { isManuscriptSaveProtected } from './manuscriptDirtyResources.ts'

export type EditorSaveIntent = 'automatic' | 'explicit'

export type EditorSaveProtectionFailure = Readonly<{
  message: string
  code: string | null
}>

export function runEditorSaveWithProtection(
  failure: EditorSaveProtectionFailure | null,
  intent: EditorSaveIntent,
  save: () => Promise<void>,
): Promise<void> {
  if (!failure || !isManuscriptSaveProtected(failure.code)) return save()
  if (intent === 'automatic') return Promise.resolve()
  return Promise.reject(Object.assign(new Error(failure.message), { code: failure.code }))
}
