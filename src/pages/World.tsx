import { Building2, Calendar, Cog, Globe, Lightbulb, MapPin, Pencil } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { worldApi } from '@/lib/api'
import { notifyDataChanged } from '@/lib/dataEvents'
import { useProjectName, useWorldEntries } from '@/lib/useProjectData'
import { parseWorldTags } from '@/lib/worldTags'
import { shouldShowWorldInitialLoading } from '@/lib/worldViewState'
import type { WorldEntry, WorldEntryInput } from '@/types'

const TABS = ['all', 'location', 'organization', 'concept', 'event', 'technology']
const TAB_ICONS: Record<string, ReactNode> = {
  all: null,
  location: <MapPin className="w-3.5 h-3.5" />,
  organization: <Building2 className="w-3.5 h-3.5" />,
  concept: <Lightbulb className="w-3.5 h-3.5" />,
  event: <Calendar className="w-3.5 h-3.5" />,
  technology: <Cog className="w-3.5 h-3.5" />,
}
const CAT_ICONS: Record<string, ReactNode> = {
  location: <MapPin className="w-3.5 h-3.5" />,
  organization: <Building2 className="w-3.5 h-3.5" />,
  concept: <Lightbulb className="w-3.5 h-3.5" />,
  event: <Calendar className="w-3.5 h-3.5" />,
  technology: <Cog className="w-3.5 h-3.5" />,
}

export function World() {
  const { data: entries, loading, error: refreshError, reload } = useWorldEntries()
  useDataRefresh('world', reload)
  const [activeTab, setActiveTab] = useState('all')
  const [showCreate, setShowCreate] = useState(false)
  const [editingEntry, setEditingEntry] = useState<WorldEntry | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorldEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const deleteDialogRef = useRef<HTMLElement | null>(null)
  const deleteCancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const deleteConfirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const deleteRequestPendingRef = useRef(false)
  const restoreDeleteTriggerFocusRef = useRef(false)
  const newEntryButtonRef = useRef<HTMLButtonElement | null>(null)
  const editDialogRestoreFocusTargetRef = useRef<HTMLElement | null>(null)
  const { t } = useT()
  const project = useProjectName()
  const tabLabels: Record<string, string> = {
    all: t('world.tabAll'),
    location: t('world.categoryLocation'),
    organization: t('world.categoryOrganization'),
    concept: t('world.categoryConcept'),
    event: t('world.categoryEvent'),
    technology: t('world.categoryTechnology'),
  }
  const catLabels: Record<string, string> = {
    location: t('world.categoryLocation'),
    organization: t('world.categoryOrganization'),
    concept: t('world.categoryConcept'),
    event: t('world.categoryEvent'),
    technology: t('world.categoryTechnology'),
  }

  const filtered = activeTab === 'all' ? entries || [] : (entries || []).filter((e) => e.category === activeTab)

  useEffect(() => {
    if (deleteTarget) {
      const activeElement = document.activeElement
      if (activeElement && deleteDialogRef.current?.contains(activeElement)) return
      if (deleteCancelButtonRef.current) deleteCancelButtonRef.current.focus()
      else deleteDialogRef.current?.focus()
      return
    }
    if (restoreDeleteTriggerFocusRef.current) {
      restoreDeleteTriggerFocusRef.current = false
      deleteTriggerRef.current?.focus()
    }
  }, [deleteTarget])

  const closeDeleteDialog = () => {
    if (deleteRequestPendingRef.current) return
    restoreDeleteTriggerFocusRef.current = true
    setDeleteTarget(null)
    setDeleteError('')
  }

  const handleDelete = async () => {
    if (!deleteTarget || deleteRequestPendingRef.current) return
    deleteRequestPendingRef.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      await worldApi.delete(project, deleteTarget.id)
      reload()
      notifyDataChanged('world', [deleteTarget.id])
      restoreDeleteTriggerFocusRef.current = false
      editDialogRestoreFocusTargetRef.current = newEntryButtonRef.current
      setDeleteTarget(null)
      setEditingEntry(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('world.deleteFailed'))
    } finally {
      deleteRequestPendingRef.current = false
      setDeleting(false)
    }
  }

  const handleDeleteDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeDeleteDialog()
      return
    }
    if (event.key !== 'Tab') return

    const cancelButton = deleteCancelButtonRef.current
    const confirmButton = deleteConfirmButtonRef.current
    if (!cancelButton || !confirmButton) {
      event.preventDefault()
      return
    }

    event.preventDefault()
    const isOnCancel = document.activeElement === cancelButton
    const isOnConfirm = document.activeElement === confirmButton
    if (event.shiftKey) {
      if (isOnCancel) confirmButton.focus()
      else cancelButton.focus()
    } else if (isOnConfirm) {
      cancelButton.focus()
    } else {
      confirmButton.focus()
    }
  }

  if (shouldShowWorldInitialLoading(loading, entries !== null))
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>

  return (
    <>
      <div inert={deleteTarget ? true : undefined} aria-hidden={deleteTarget ? true : undefined}>
        <div className="page-header">
          <h2 className="flex items-center gap-2">
            <Globe className="w-5 h-5" /> {t('pages.world')}
          </h2>
          <div className="page-header-actions">
            <button
              ref={newEntryButtonRef}
              type="button"
              className="btn-primary"
              style={{ height: 30, padding: '0 14px' }}
              onClick={() => setShowCreate(true)}
            >
              + {t('pages.newEntry')}
            </button>
          </div>
        </div>

        {refreshError && (
          <div
            className="mx-6 mt-4 flex items-start justify-between gap-4 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-red-500"
            role="alert"
          >
            <div>
              <p className="text-[13px] font-medium">{t('world.refreshFailed')}</p>
              <p className="mt-1 text-[12px] opacity-80">{refreshError}</p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-lg border border-red-500/40 bg-transparent px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-red-500/10"
              onClick={reload}
            >
              {t('world.retryRefresh')}
            </button>
          </div>
        )}

        {showCreate && (
          <SimpleCreateDialog
            title={`+ ${t('pages.newEntry')}`}
            fields={[
              {
                key: 'category',
                label: t('world.category'),
                type: 'select',
                required: true,
                options: [
                  { value: 'location', label: t('world.categoryLocation') },
                  { value: 'organization', label: t('world.categoryOrganization') },
                  { value: 'concept', label: t('world.categoryConcept') },
                  { value: 'event', label: t('world.categoryEvent') },
                  { value: 'technology', label: t('world.categoryTechnology') },
                ],
              },
              { key: 'name', label: t('world.name'), required: true, placeholder: t('world.namePlaceholder') },
              {
                key: 'description',
                label: t('world.description'),
                type: 'textarea',
                placeholder: t('world.descriptionPlaceholder'),
              },
              { key: 'tags', label: t('world.tags'), placeholder: t('world.tagsPlaceholder') },
            ]}
            onSubmit={async (vals) => {
              const entry: WorldEntryInput = {
                category: vals.category,
                name: vals.name,
                description: vals.description || '',
                tags: parseWorldTags(vals.tags),
              }
              const created = await worldApi.create(project, entry)
              reload()
              notifyDataChanged('world', created?.id ? [created.id] : undefined)
            }}
            onClose={() => setShowCreate(false)}
          />
        )}

        <div className="flex gap-0 border-b border-[var(--hairline)] px-6 shrink-0 bg-[var(--canvas-soft)]">
          {TABS.map((t) => (
            <button
              type="button"
              key={t}
              className={`border-x-0 border-t-0 bg-transparent px-4 py-2.5 text-[13px] cursor-pointer border-b-2 transition-colors
              ${activeTab === t ? 'text-[var(--ink)] border-b-2 border-[var(--accent-gold)]' : 'text-[var(--ink-tertiary)] border-b-2 border-transparent hover:text-[var(--ink-secondary)]'}`}
              onClick={() => setActiveTab(t)}
            >
              <span className="flex items-center gap-1">
                {TAB_ICONS[t]} {tabLabels[t] || t}
              </span>
            </button>
          ))}
        </div>
        <div className="page-body" style={{ padding: 0 }}>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-6">
            {filtered.map((entry) => (
              <button
                type="button"
                key={entry.id}
                className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-lg p-4 cursor-pointer text-left transition-colors hover:border-[var(--hairline-light)] hover:bg-[var(--canvas-elevated)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-gold)]"
                onClick={() => {
                  editDialogRestoreFocusTargetRef.current = null
                  setEditingEntry(entry)
                }}
                aria-label={t('world.editAction', { title: entry.name })}
              >
                <span className="text-[10px] px-[6px] py-[1px] rounded-full bg-[var(--canvas-mid)] text-[var(--ink-tertiary)] inline-block mb-1.5">
                  <span className="inline-flex items-center gap-0.5">
                    {CAT_ICONS[entry.category]} {catLabels[entry.category] || entry.category}
                  </span>
                </span>
                <span className="mb-1 flex items-center justify-between gap-2 text-[15px] text-[var(--ink)]">
                  {entry.name}
                  <Pencil className="h-3.5 w-3.5 shrink-0 text-[var(--ink-tertiary)]" aria-hidden="true" />
                </span>
                <span className="text-[13px] text-[var(--ink-tertiary)] line-clamp-2">{entry.description}</span>
                {entry.tags.length > 0 && (
                  <span className="mt-3 flex flex-wrap gap-1.5">
                    {entry.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-[var(--canvas-mid)] px-2 py-0.5 text-[10px] text-[var(--ink-tertiary)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {editingEntry && (
          <SimpleCreateDialog
            key={editingEntry.id}
            title={t('world.editEntry')}
            submitLabel={t('world.saveChanges')}
            submittingLabel={t('common.saving')}
            footerStart={
              <button
                ref={deleteTriggerRef}
                type="button"
                className="h-[32px] rounded-lg border border-red-500/40 bg-red-500/10 px-4 text-[13px] text-red-500 transition-colors hover:bg-red-500/20"
                onClick={() => {
                  setDeleteError('')
                  setDeleteTarget(editingEntry)
                }}
                aria-label={t('world.deleteAction', { title: editingEntry.name })}
              >
                {t('world.deleteEntry')}
              </button>
            }
            fields={[
              {
                key: 'category',
                label: t('world.category'),
                type: 'select',
                required: true,
                defaultValue: editingEntry.category,
                options: [
                  { value: 'location', label: t('world.categoryLocation') },
                  { value: 'organization', label: t('world.categoryOrganization') },
                  { value: 'concept', label: t('world.categoryConcept') },
                  { value: 'event', label: t('world.categoryEvent') },
                  { value: 'technology', label: t('world.categoryTechnology') },
                ],
              },
              {
                key: 'name',
                label: t('world.name'),
                required: true,
                placeholder: t('world.namePlaceholder'),
                defaultValue: editingEntry.name,
              },
              {
                key: 'description',
                label: t('world.description'),
                type: 'textarea',
                placeholder: t('world.descriptionPlaceholder'),
                defaultValue: editingEntry.description,
              },
              {
                key: 'tags',
                label: t('world.tags'),
                placeholder: t('world.tagsPlaceholder'),
                defaultValue: editingEntry.tags.join(', '),
              },
            ]}
            onSubmit={async (vals) => {
              await worldApi.update(project, editingEntry.id, {
                category: vals.category,
                name: vals.name,
                description: vals.description || '',
                tags: parseWorldTags(vals.tags),
              })
              reload()
              notifyDataChanged('world', [editingEntry.id])
            }}
            onClose={() => setEditingEntry(null)}
            restoreFocusTarget={() => editDialogRestoreFocusTargetRef.current}
          />
        )}
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 z-[310] flex items-center justify-center bg-black/60 p-4" role="presentation">
          <button
            type="button"
            className="absolute inset-0 cursor-default border-none bg-transparent p-0"
            aria-label={t('common.cancel')}
            onClick={closeDeleteDialog}
            disabled={deleting}
            tabIndex={-1}
          />
          <section
            ref={deleteDialogRef}
            className="relative z-10 w-[420px] max-w-full rounded-xl border border-[var(--hairline-light)] bg-[var(--canvas-card)] p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-world-entry-title"
            aria-busy={deleting}
            tabIndex={-1}
            onKeyDown={handleDeleteDialogKeyDown}
          >
            <h3 id="delete-world-entry-title" className="font-display text-[20px] font-semibold text-[var(--ink)]">
              {t('world.deleteEntry')}
            </h3>
            <p className="mt-3 text-[14px] leading-6 text-[var(--ink-secondary)]">
              {t('world.deleteConfirmation', { title: deleteTarget.name })}
            </p>
            {deleteError && (
              <div
                className="mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-500"
                role="alert"
              >
                {deleteError}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2 border-t border-[var(--hairline)] pt-4">
              <button
                ref={deleteCancelButtonRef}
                type="button"
                className="h-[32px] rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] px-4 text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--canvas-mid)] aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                onClick={closeDeleteDialog}
                aria-disabled={deleting}
              >
                {t('common.cancel')}
              </button>
              <button
                ref={deleteConfirmButtonRef}
                type="button"
                className="h-[32px] rounded-lg border-none bg-red-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-red-700 aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
                onClick={handleDelete}
                aria-disabled={deleting}
              >
                {t('world.deleteEntry')}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
