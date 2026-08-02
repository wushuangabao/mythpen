import { ArrowDownUp, Check, ClipboardCopy, RotateCcw, Search, Trash2, Users } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { charactersApi } from '@/lib/api'
import {
  characterSaveKey,
  confirmCharacterChanges,
  discardCharacterDraft,
  type EditableCharacterField,
  enqueueCharacterChange,
  flushAllCharacterChanges,
  flushCharacterChanges,
  flushProjectCharacterChanges,
  getCharacterSaveSnapshot,
  getRecoverableCharacterDrafts,
  type RecoverableCharacterDraft,
  replayPersistedCharacterChanges,
  setCharacterSaveNotifier,
  subscribeCharacterSaveQueue,
} from '@/lib/characterSaveQueue'
import { notifyDataChanged } from '@/lib/dataEvents'
import { useCharacters, useProjectName } from '@/lib/useProjectData'
import { useSidebarStore } from '@/stores/useSidebarStore'
import type { Character, CharacterRole } from '@/types'

setCharacterSaveNotifier((_project, characterId) => notifyDataChanged('character', [characterId]))

type CharacterSortMode = 'default' | 'role' | 'chapterCount' | 'name' | 'ageAscending' | 'ageDescending'

const characterRoleSortOrder: Record<CharacterRole, number> = { major: 0, minor: 1, extra: 2 }
const chineseNameCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', {
  numeric: true,
  sensitivity: 'base',
  ignorePunctuation: true,
})
const englishNameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base', ignorePunctuation: true })

function compareCharacterNames(firstName: string, secondName: string): number {
  const normalizedFirstName = firstName.trim()
  const normalizedSecondName = secondName.trim()
  const firstIsEnglish = /^[A-Za-z]/.test(normalizedFirstName)
  const secondIsEnglish = /^[A-Za-z]/.test(normalizedSecondName)
  if (firstIsEnglish && secondIsEnglish) return englishNameCollator.compare(normalizedFirstName, normalizedSecondName)
  return chineseNameCollator.compare(normalizedFirstName, normalizedSecondName)
}

function parseCharacterAge(age: string | undefined): number | null {
  const value = Number.parseFloat(age?.trim() ?? '')
  return Number.isFinite(value) && value >= 0 ? value : null
}

function compareCharacterAges(first: Character, second: Character, direction: 1 | -1): number {
  const firstAge = parseCharacterAge(first.age)
  const secondAge = parseCharacterAge(second.age)
  if (firstAge === null && secondAge === null) return 0
  if (firstAge === null) return 1
  if (secondAge === null) return -1
  return (firstAge - secondAge) * direction
}

function normalizeCharacterRole(role: unknown): CharacterRole {
  if (role === 'major' || role === 'minor' || role === 'extra') return role
  return 'minor'
}

function hasValidCharacterName(name: string): boolean {
  return name.trim().length > 0
}

export function Characters() {
  const { t } = useT()
  const project = useProjectName()
  const activePage = useSidebarStore((state) => state.activePage)
  const { data: characters, loading, reload } = useCharacters()
  useDataRefresh('character', reload)
  const [selected, setSelected] = useState<Character | null>(null)
  const [selectedProject, setSelectedProject] = useState(project)
  const [showCreate, setShowCreate] = useState(false)
  const [characterSearch, setCharacterSearch] = useState('')
  const [characterSort, setCharacterSort] = useState<CharacterSortMode>('default')
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false)
  const [nameValidationError, setNameValidationError] = useState<string | null>(null)
  const [draftActionError, setDraftActionError] = useState<string | null>(null)
  const [recoveringDraftId, setRecoveringDraftId] = useState<string | null>(null)
  const [createdRoleOverrides, setCreatedRoleOverrides] = useState<Record<string, CharacterRole>>({})
  const characterSaveSnapshot = useSyncExternalStore(
    subscribeCharacterSaveQueue,
    getCharacterSaveSnapshot,
    getCharacterSaveSnapshot,
  )
  const previousProjectRef = useRef(project)
  const previousCharactersRef = useRef(characters)
  const [charactersProject, setCharactersProject] = useState(project)
  const characterListRef = useRef<HTMLDivElement | null>(null)
  const characterListScrollTopRef = useRef(0)
  const sortMenuRef = useRef<HTMLDivElement | null>(null)
  const charactersForProject = charactersProject === project ? characters : null
  const selectedCharacter = selectedProject === project ? selected : null

  useEffect(() => {
    if (characters !== previousCharactersRef.current) {
      previousCharactersRef.current = characters
      if (characters) confirmCharacterChanges(project, characters)
      setCharactersProject(project)
    }
  }, [characters, project])

  const savePendingChanges = useCallback((targetProject: string, characterId: string) => {
    if (characterListRef.current) {
      characterListScrollTopRef.current = characterListRef.current.scrollTop
    }
    void flushCharacterChanges(targetProject, characterId).catch(() => {
      // The durable outbox keeps the edit and the page exposes a retry action.
    })
  }, [])

  useEffect(() => {
    replayPersistedCharacterChanges(project)
    void flushProjectCharacterChanges(project).catch(() => {
      // Replayed edits remain in the durable outbox until a later retry succeeds.
    })
  }, [project])

  const mergeCharacterEdits = useCallback(
    (character: Character): Character => {
      const saveKey = characterSaveKey(project, character.id)
      const edits = characterSaveSnapshot.overlays[saveKey]
      return {
        ...character,
        ...edits,
        role: normalizeCharacterRole(edits?.role ?? createdRoleOverrides[saveKey] ?? character.role),
      }
    },
    [characterSaveSnapshot.overlays, createdRoleOverrides, project],
  )
  const mergeCharacterEditsRef = useRef(mergeCharacterEdits)
  mergeCharacterEditsRef.current = mergeCharacterEdits

  useEffect(() => {
    if (!charactersForProject?.length) {
      setSelected(null)
      return
    }
    setSelected((current) => {
      const currentCharacterId = selectedProject === project ? current?.id : undefined
      const next =
        charactersForProject.find((character) => character.id === currentCharacterId) ?? charactersForProject[0]
      return mergeCharacterEditsRef.current(next)
    })
    setSelectedProject(project)
  }, [charactersForProject, project, selectedProject])

  useEffect(() => {
    if (!charactersForProject?.length) return
    setCreatedRoleOverrides((current) => {
      let changed = false
      const next = { ...current }
      for (const character of charactersForProject) {
        const saveKey = characterSaveKey(project, character.id)
        if (next[saveKey] && character.role === next[saveKey]) {
          delete next[saveKey]
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [charactersForProject, project])

  useLayoutEffect(() => {
    if (!charactersForProject) return
    if (characterListRef.current) {
      characterListRef.current.scrollTop = characterListScrollTopRef.current
    }
  }, [charactersForProject])

  useEffect(() => {
    const previousProject = previousProjectRef.current
    if (previousProject === project) return
    void flushProjectCharacterChanges(previousProject).catch(() => {
      // The durable outbox retains failures across project switches.
    })
    previousProjectRef.current = project
    setSelected(null)
    setSelectedProject(project)
    setNameValidationError(null)
    setDraftActionError(null)
    setRecoveringDraftId(null)
  }, [project])

  useEffect(() => {
    if (activePage !== 'page-characters') {
      void flushAllCharacterChanges().catch(() => {
        // The durable outbox retains failures while the page is hidden.
      })
    }
  }, [activePage])

  useEffect(() => {
    return () => {
      void flushAllCharacterChanges().catch(() => {
        // This is only a best-effort fast path; correctness comes from the outbox.
      })
    }
  }, [])

  useEffect(() => {
    if (!isSortMenuOpen) return
    const closeSortMenu = (event: PointerEvent) => {
      if (!sortMenuRef.current?.contains(event.target as Node)) setIsSortMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSortMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeSortMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeSortMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isSortMenuOpen])

  const updateSelected = (field: EditableCharacterField, value: string) => {
    if (!selectedCharacter) return
    if (field === 'name' && !hasValidCharacterName(value)) {
      setNameValidationError(t('common.requiredField', { label: t('pages.name') }))
      return
    }

    setNameValidationError(null)
    const characterId = selectedCharacter.id
    setSelected((current) => (current?.id === characterId ? ({ ...current, [field]: value } as Character) : current))
    enqueueCharacterChange(project, characterId, field, value)
  }

  const selectCharacter = (character: Character) => {
    if (selectedCharacter) savePendingChanges(project, selectedCharacter.id)
    setNameValidationError(null)
    setSelectedProject(project)
    setSelected(character)
  }

  const retryPendingChanges = () => {
    void flushProjectCharacterChanges(project).catch(() => {
      // Keep displaying the persistent error until a retry succeeds.
    })
  }

  const roleLabel = (role: CharacterRole) => {
    if (role === 'major') return t('pages.roleMajor')
    if (role === 'minor') return t('pages.roleMinor')
    return t('pages.roleExtra')
  }
  const persistentSaveError = characterSaveSnapshot.errors[project] ?? null
  const recoverableDrafts = charactersForProject
    ? getRecoverableCharacterDrafts(
        project,
        charactersForProject.map((character) => character.id),
      )
    : []
  const displayedCharacters = (charactersForProject || []).map(mergeCharacterEdits)
  const sortedCharacters = displayedCharacters
    .map((character, index) => ({ character, index }))
    .sort((first, second) => {
      let comparison = 0
      if (characterSort === 'role') {
        comparison =
          characterRoleSortOrder[normalizeCharacterRole(first.character.role)] -
          characterRoleSortOrder[normalizeCharacterRole(second.character.role)]
      } else if (characterSort === 'chapterCount') {
        const firstCount = first.character.chapterCount ?? first.character.appearances?.length ?? 0
        const secondCount = second.character.chapterCount ?? second.character.appearances?.length ?? 0
        comparison = secondCount - firstCount
      } else if (characterSort === 'name') {
        comparison = compareCharacterNames(first.character.name, second.character.name)
      } else if (characterSort === 'ageAscending') {
        comparison = compareCharacterAges(first.character, second.character, 1)
      } else if (characterSort === 'ageDescending') {
        comparison = compareCharacterAges(first.character, second.character, -1)
      }
      return comparison || first.index - second.index
    })
    .map(({ character }) => character)
  const normalizedSearch = characterSearch.trim().toLocaleLowerCase()
  const visibleCharacters = normalizedSearch
    ? sortedCharacters.filter((character) => character.name.toLocaleLowerCase().includes(normalizedSearch))
    : sortedCharacters

  const updateCharacterSearch = (value: string) => {
    setCharacterSearch(value)
    characterListScrollTopRef.current = 0
    if (characterListRef.current) characterListRef.current.scrollTop = 0
  }

  const selectCharacterSort = (sortMode: CharacterSortMode) => {
    setCharacterSort(sortMode)
    setIsSortMenuOpen(false)
    characterListScrollTopRef.current = 0
    if (characterListRef.current) characterListRef.current.scrollTop = 0
  }

  const copyRecoverableDraft = async (draft: RecoverableCharacterDraft) => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ sourceCharacterId: draft.characterId, ...draft.changes }, null, 2),
      )
      setDraftActionError(null)
    } catch {
      setDraftActionError(t('characters.copyDraftFailed'))
    }
  }

  const recreateRecoverableDraft = async (draft: RecoverableCharacterDraft) => {
    const draftKey = draft.recoveryKey ?? draft.characterId
    setRecoveringDraftId(draftKey)
    setDraftActionError(null)
    try {
      const name = draft.changes.name?.trim() || t('characters.recoveredDraftName')
      const role = normalizeCharacterRole(draft.changes.role)
      const created = await charactersApi.create(project, { ...draft.changes, name, role })
      discardCharacterDraft(project, draft.characterId, draft.recoveryKey)
      if (created?.id) {
        setCreatedRoleOverrides((current) => ({
          ...current,
          [characterSaveKey(project, created.id)]: role,
        }))
      }
      reload()
      notifyDataChanged('character', created?.id ? [created.id] : undefined)
    } catch (error) {
      setDraftActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setRecoveringDraftId(null)
    }
  }

  const discardRecoverableDraft = (draft: RecoverableCharacterDraft) => {
    if (!window.confirm(t('characters.discardDraftConfirm'))) return
    discardCharacterDraft(project, draft.characterId, draft.recoveryKey)
    setDraftActionError(null)
  }

  const characterSortOptions: { value: CharacterSortMode; label: string }[] = [
    { value: 'role', label: t('characters.sortByRole') },
    { value: 'chapterCount', label: t('characters.sortByChapterCount') },
    { value: 'name', label: t('characters.sortBySurname') },
    { value: 'ageAscending', label: t('characters.sortByAgeAscending') },
    { value: 'ageDescending', label: t('characters.sortByAgeDescending') },
    { value: 'default', label: t('characters.sortDefault') },
  ]

  if (loading && !charactersForProject) {
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>
  }

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <Users className="w-5 h-5" /> {t('pages.characters')}
        </h2>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-primary"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => setShowCreate(true)}
          >
            + {t('pages.newCharacter')}
          </button>
        </div>
      </div>

      {persistentSaveError && (
        <div className="mx-4 mt-2 flex shrink-0 items-center gap-2 text-[12px] text-[var(--error)]">
          <span>{persistentSaveError}</span>
          <button type="button" className="underline" onClick={retryPendingChanges}>
            {t('serverStatus.retry')}
          </button>
        </div>
      )}

      {recoverableDrafts.length > 0 && (
        <section className="mx-4 mt-2 max-h-52 shrink-0 overflow-y-auto rounded-[var(--radius-sm)] border border-[var(--warning)] bg-[var(--canvas-card)] p-3 text-[12px] custom-scrollbar">
          <div className="font-medium text-[var(--ink)]">{t('characters.recoverableDrafts')}</div>
          <div className="mt-1 text-[var(--ink-secondary)]">{t('characters.recoverableDraftsDescription')}</div>
          <div className="mt-2 grid gap-2">
            {recoverableDrafts.map((draft) => (
              <div
                key={draft.recoveryKey ?? draft.characterId}
                className="rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] p-2"
              >
                <div className="font-medium text-[var(--ink)]">
                  {draft.changes.name?.trim() || t('characters.unnamedDraft')}
                </div>
                <div className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--ink-secondary)]">
                  {JSON.stringify(draft.changes, null, 2)}
                </div>
                {draft.isolated && (
                  <div className="mt-1 text-[11px] text-[var(--warning)]">{t('characters.isolatedDraft')}</div>
                )}
                {Object.keys(draft.failures).length > 0 && (
                  <div className="mt-1 text-[11px] text-[var(--error)]">
                    {[...new Set(Object.values(draft.failures))].join('；')}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[var(--accent-gold)] underline"
                    onClick={() => void copyRecoverableDraft(draft)}
                  >
                    <ClipboardCopy className="h-3.5 w-3.5" /> {t('characters.copyDraft')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[var(--accent-gold)] underline disabled:opacity-50"
                    disabled={recoveringDraftId !== null}
                    onClick={() => void recreateRecoverableDraft(draft)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {recoveringDraftId === (draft.recoveryKey ?? draft.characterId)
                      ? t('characters.recreatingDraft')
                      : t('characters.recreateDraft')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[var(--error)] underline"
                    onClick={() => discardRecoverableDraft(draft)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> {t('characters.discardDraft')}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {draftActionError && <div className="mt-2 text-[var(--error)]">{draftActionError}</div>}
        </section>
      )}

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.newCharacter')}`}
          fields={[
            { key: 'name', label: t('pages.name'), required: true, placeholder: t('characters.namePlaceholder') },
            {
              key: 'role',
              label: t('pages.role'),
              type: 'select',
              required: true,
              defaultValue: 'minor',
              options: [
                { value: 'major', label: t('pages.roleMajor') },
                { value: 'minor', label: t('pages.roleMinor') },
                { value: 'extra', label: t('pages.roleExtra') },
              ],
            },
            { key: 'age', label: t('pages.age'), placeholder: t('characters.agePlaceholder') },
            { key: 'gender', label: t('pages.gender'), placeholder: t('characters.genderPlaceholder') },
            {
              key: 'appearance',
              label: t('pages.appearance'),
              type: 'textarea',
              placeholder: t('characters.appearancePlaceholder'),
            },
            {
              key: 'personality',
              label: t('pages.personality'),
              type: 'textarea',
              placeholder: t('characters.personalityPlaceholder'),
            },
            {
              key: 'background',
              label: t('pages.background'),
              type: 'textarea',
              placeholder: t('characters.backgroundPlaceholder'),
            },
            {
              key: 'motivation',
              label: t('pages.motivation'),
              type: 'textarea',
              placeholder: t('characters.motivationPlaceholder'),
            },
            { key: 'arc', label: t('pages.arc'), type: 'textarea', placeholder: t('characters.arcPlaceholder') },
          ]}
          onSubmit={async (vals) => {
            const created = await charactersApi.create(project, vals)
            if (created?.id) {
              setCreatedRoleOverrides((current) => ({
                ...current,
                [characterSaveKey(project, created.id)]: normalizeCharacterRole(vals.role),
              }))
            }
            reload()
            notifyDataChanged('character')
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      <div className="flex flex-1 min-h-0">
        <div
          ref={characterListRef}
          className="w-[240px] shrink-0 border-r border-[var(--hairline)] overflow-y-auto py-3 custom-scrollbar"
          onScroll={(event) => {
            characterListScrollTopRef.current = event.currentTarget.scrollTop
          }}
        >
          <div className="sticky top-0 z-10 border-b border-[var(--hairline)] bg-[var(--canvas)] px-3 pb-3">
            <div className="flex gap-2">
              <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-elevated)] px-2.5 focus-within:border-[var(--accent-gold)]">
                <Search className="h-3.5 w-3.5 shrink-0 text-[var(--ink-tertiary)]" />
                <input
                  type="search"
                  value={characterSearch}
                  placeholder={t('characters.searchPlaceholder')}
                  aria-label={t('characters.searchPlaceholder')}
                  className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-tertiary)]"
                  onChange={(event) => updateCharacterSearch(event.target.value)}
                />
              </label>
              <div ref={sortMenuRef} className="relative shrink-0">
                <button
                  type="button"
                  aria-label={t('characters.sort')}
                  aria-expanded={isSortMenuOpen}
                  aria-haspopup="menu"
                  title={t('characters.sort')}
                  className={`flex h-[34px] w-[34px] items-center justify-center rounded-[var(--radius-sm)] border transition-colors ${
                    isSortMenuOpen
                      ? 'border-[var(--accent-gold)] bg-[var(--accent-gold-soft-bg)] text-[var(--accent-gold)]'
                      : 'border-[var(--hairline)] bg-[var(--canvas-elevated)] text-[var(--ink-tertiary)] hover:border-[var(--accent-gold)] hover:text-[var(--ink)]'
                  }`}
                  onClick={() => setIsSortMenuOpen((open) => !open)}
                >
                  <ArrowDownUp className="h-4 w-4" />
                </button>
                {isSortMenuOpen && (
                  <div
                    role="menu"
                    aria-label={t('characters.sort')}
                    className="absolute right-0 top-[calc(100%+6px)] z-20 w-[208px] rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--canvas-card)] p-1 shadow-lg"
                  >
                    {characterSortOptions.map((option) => {
                      const isActive = characterSort === option.value
                      return (
                        <button
                          type="button"
                          key={option.value}
                          role="menuitemradio"
                          aria-checked={isActive}
                          className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[12px] transition-colors ${
                            isActive
                              ? 'bg-[var(--accent-gold-soft-bg)] text-[var(--ink)]'
                              : 'text-[var(--ink-secondary)] hover:bg-[var(--canvas-elevated)] hover:text-[var(--ink)]'
                          }`}
                          onClick={() => selectCharacterSort(option.value)}
                        >
                          {option.label}
                          {isActive && <Check className="h-3.5 w-3.5 text-[var(--accent-gold)]" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
          {visibleCharacters.map((c) => {
            const role = normalizeCharacterRole(c.role)
            const isSelected = selectedCharacter?.id === c.id
            return (
              <button
                type="button"
                key={c.id}
                aria-current={isSelected ? 'true' : undefined}
                className={`flex w-full items-center gap-2.5 border-y-0 border-r-0 border-l-2 bg-transparent px-4 py-2 text-left cursor-pointer transition-colors
                  ${isSelected ? 'font-medium' : ''} hover:bg-[var(--canvas-card)]`}
                style={{
                  borderLeftColor: isSelected ? 'var(--accent-gold)' : 'transparent',
                  backgroundColor: isSelected ? 'var(--accent-gold-soft-bg)' : undefined,
                }}
                onClick={() => selectCharacter(c)}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0
                  ${
                    role === 'major'
                      ? 'bg-[var(--accent-gold)] text-[var(--canvas)]'
                      : role === 'minor'
                        ? 'bg-[var(--accent-mist)] text-[var(--ink)]'
                        : 'bg-[var(--canvas-mid)] text-[var(--ink-tertiary)]'
                  }`}
                >
                  {c.name?.[0] || '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-[var(--ink)] truncate">{c.name}</div>
                  <div className="text-[11px] text-[var(--ink-tertiary)]">
                    {c.age || '?'}
                    {t('characters.ageUnit')} · {roleLabel(role)}
                    {(c.chapterCount ?? 0) > 0 && ` · ${c.chapterCount}${t('characters.chapterAppearances')}`}
                  </div>
                </div>
              </button>
            )
          })}
          {visibleCharacters.length === 0 && (
            <div className="px-4 py-6 text-center text-[12px] text-[var(--ink-tertiary)]">
              {normalizedSearch ? t('characters.noSearchResults') : t('common.noData')}
            </div>
          )}
        </div>

        {selectedCharacter && (
          <div className="flex-1 min-h-0 overflow-y-auto p-6 custom-scrollbar">
            <div className="flex h-full min-h-[560px] flex-col">
              <div className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-4 mb-4 shrink-0">
                <div className="flex items-start gap-5">
                  <div className="shrink-0 text-center">
                    <div className="font-mono text-lg text-[var(--accent-gold)]">
                      {selectedCharacter.chapterCount || 0}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--ink-tertiary)]">{t('chapters')}</div>
                  </div>
                  <div className="min-w-0 flex-1 border-l border-[var(--hairline)] pl-5">
                    <div className="mb-1.5 text-[11px] text-[var(--ink-tertiary)]">
                      {t('characters.appearingChapters')}
                    </div>
                    {selectedCharacter.appearances?.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedCharacter.appearances.map((appearance) => (
                          <span
                            key={appearance.chapter_id}
                            className="flex max-w-full items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--canvas-elevated)] px-2 py-1 text-[12px] text-[var(--ink-secondary)]"
                            title={`${t('characters.chapterReference', { num: appearance.num })} ${appearance.title}`}
                          >
                            <span className="shrink-0 font-mono text-[var(--accent-gold)]">
                              {t('characters.chapterReference', { num: appearance.num })}
                            </span>
                            {appearance.title && <span className="truncate">· {appearance.title}</span>}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[12px] text-[var(--ink-tertiary)]">
                        {t('characters.noChapterAppearances')}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 gap-3 mb-4">
                <FormField label={t('pages.name')} full>
                  <input
                    type="text"
                    value={selectedCharacter.name}
                    className="form-input"
                    required
                    aria-invalid={Boolean(nameValidationError)}
                    onChange={(event) => updateSelected('name', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
                <FormField label={t('pages.age')} full>
                  <input
                    type="text"
                    value={selectedCharacter.age || ''}
                    className="form-input"
                    onChange={(event) => updateSelected('age', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
                <FormField label={t('pages.gender')} full>
                  <input
                    type="text"
                    value={selectedCharacter.gender || ''}
                    className="form-input"
                    onChange={(event) => updateSelected('gender', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
                <FormField label={t('pages.role')} full>
                  <select
                    value={normalizeCharacterRole(selectedCharacter.role)}
                    className="form-input"
                    onChange={(event) => updateSelected('role', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  >
                    <option value="major">{t('pages.roleMajor')}</option>
                    <option value="minor">{t('pages.roleMinor')}</option>
                    <option value="extra">{t('pages.roleExtra')}</option>
                  </select>
                </FormField>
              </div>
              <div
                className="grid flex-1 min-h-[390px] grid-cols-2 gap-3"
                style={{ gridTemplateRows: 'minmax(120px, 0.7fr) minmax(0, 1fr) minmax(0, 1fr)' }}
              >
                <FormField label={t('pages.appearance')} className="col-span-2 flex min-h-0 flex-col">
                  <textarea
                    rows={2}
                    value={selectedCharacter.appearance || ''}
                    className="form-textarea flex-1"
                    style={{ minHeight: 0 }}
                    onChange={(event) => updateSelected('appearance', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
                <FormField label={t('pages.personality')} className="flex min-h-0 flex-col">
                  <textarea
                    rows={2}
                    value={selectedCharacter.personality || ''}
                    className="form-textarea flex-1"
                    style={{ minHeight: 0 }}
                    onChange={(event) => updateSelected('personality', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
                <FormField label={t('pages.background')} className="flex min-h-0 flex-col">
                  <textarea
                    rows={2}
                    value={selectedCharacter.background || ''}
                    className="form-textarea flex-1"
                    style={{ minHeight: 0 }}
                    onChange={(event) => updateSelected('background', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
                <FormField label={t('pages.motivation')} className="flex min-h-0 flex-col">
                  <textarea
                    rows={2}
                    value={selectedCharacter.motivation || ''}
                    className="form-textarea flex-1"
                    style={{ minHeight: 0 }}
                    onChange={(event) => updateSelected('motivation', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
                <FormField label={t('pages.arc')} className="flex min-h-0 flex-col">
                  <textarea
                    rows={2}
                    value={selectedCharacter.arc || ''}
                    className="form-textarea flex-1"
                    style={{ minHeight: 0 }}
                    onChange={(event) => updateSelected('arc', event.target.value)}
                    onBlur={() => savePendingChanges(project, selectedCharacter.id)}
                  />
                </FormField>
              </div>
              {nameValidationError && (
                <div className="mt-2 flex shrink-0 items-center gap-2 text-[12px] text-[var(--error)]">
                  <span>{nameValidationError}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function FormField({
  label,
  children,
  full,
  className,
}: {
  label: string
  children: React.ReactNode
  full?: boolean
  className?: string
}) {
  return (
    <div className={[full ? 'flex-1' : '', className].filter(Boolean).join(' ')}>
      <div className="block shrink-0 text-[11px] font-medium text-[var(--ink-secondary)] tracking-[0.04em] uppercase mb-1">
        {label}
      </div>
      {children}
    </div>
  )
}
