import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('draft conflict UI resolves only through Task 5 API and EditorContent keeps protection until explicit completion', () => {
  const dialog = source('src/components/DraftConflictDialog.tsx')
  const editor = source('src/components/EditorContent.tsx')
  assert.match(dialog, /manuscriptDraftConflictsApi/u)
  assert.match(dialog, /ManuscriptRecoveryState/u)
  assert.match(dialog, /acceptExternal/u)
  assert.match(dialog, /applySavedDraft/u)
  assert.match(dialog, /copyBackup/u)
  assert.doesNotMatch(dialog, /absolutePath|filePath|draftBytes|externalBytes/u)
  assert.match(editor, /DraftConflictDialog/u)
  assert.match(editor, /discardEditorSave/u)
  assert.match(editor, /discardTitleSave/u)
})

test('orphan, retired, and diagnostics dialogs stay on existing product APIs and diagnostics use a safe field allowlist', () => {
  const orphan = source('src/components/OrphanResourceDialog.tsx')
  const retired = source('src/components/RetiredProjectsDialog.tsx')
  const diagnostics = source('src/components/ManuscriptDiagnosticsDialog.tsx')
  assert.match(orphan, /manuscriptOrphansApi/u)
  assert.doesNotMatch(orphan, /fetch\(|backendFetch|absolutePath|filePath/u)
  assert.match(retired, /projectsApi\.getFilesBetaStatus/u)
  assert.doesNotMatch(retired, /reactivate|retireProject|fetch\(|backendFetch/u)
  assert.match(diagnostics, /projectsApi\.(getDiagnostics|recoverDiagnostics|exportDiagnostics)/u)
  assert.match(diagnostics, /SAFE_DIAGNOSTIC_FIELDS/u)
  assert.doesNotMatch(diagnostics, /JSON\.stringify\(diagnostics\)|absolutePath|filePath|content/u)
})
