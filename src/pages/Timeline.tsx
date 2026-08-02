import { ArrowDownUp, CalendarDays, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { SimpleCreateDialog } from '@/components/SimpleCreateDialog'
import { useDataRefresh } from '@/hooks/useDataRefresh'
import { useT } from '@/hooks/useT'
import { timelineApi } from '@/lib/api'
import { notifyDataChanged } from '@/lib/dataEvents'
import {
  createTimelineSortModeRequestGuard,
  getTimelineKeyboardMove,
  getTimelineSortModeForProject,
  isTimelineOrderInteractionDisabled,
  type TimelineSortModeSnapshot,
} from '@/lib/timelineSortModeState'
import { useProjectName, useTimelineEvents } from '@/lib/useProjectData'
import type { TimelineEvent } from '@/types'

type DropPosition = { targetId: string; insertAfter: boolean }
type PointerDrag = { eventId: string; pointerId: number; startX: number; startY: number; started: boolean }

export function Timeline() {
  const project = useProjectName()
  if (!project) return null
  return <ProjectTimeline key={project} project={project} />
}

function ProjectTimeline({ project }: { project: string }) {
  const { data: events, loading, reload } = useTimelineEvents()
  const { t } = useT()
  const [showCreate, setShowCreate] = useState(false)
  const [editingEvent, setEditingEvent] = useState<TimelineEvent | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TimelineEvent | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [draggingEventId, setDraggingEventId] = useState<string | null>(null)
  const [dropPosition, setDropPosition] = useState<DropPosition | null>(null)
  const [optimisticEvents, setOptimisticEvents] = useState<TimelineEvent[] | null>(null)
  const [reorderError, setReorderError] = useState('')
  const [orderMutationInFlight, setOrderMutationInFlight] = useState(false)
  const [timelineSortModeSnapshot, setTimelineSortModeSnapshot] = useState<TimelineSortModeSnapshot | null>(null)
  const [sortModeLoadError, setSortModeLoadError] = useState('')
  const [sortModeReloadToken, setSortModeReloadToken] = useState(0)
  const displayedEvents = optimisticEvents || events || []
  const latestEventsRef = useRef(events)
  const sortModeRequestsRef = useRef(createTimelineSortModeRequestGuard(project))
  const eventItemRefs = useRef(new Map<string, HTMLLIElement>())
  const pointerDragRef = useRef<PointerDrag | null>(null)
  const refreshTimelineAuthority = useCallback(() => {
    reload()
    setSortModeReloadToken((token) => token + 1)
  }, [reload])
  useDataRefresh('timeline', refreshTimelineAuthority)
  const timelineSortMode = getTimelineSortModeForProject(timelineSortModeSnapshot, project)
  const isOrderInteractionDisabled = isTimelineOrderInteractionDisabled(
    timelineSortModeSnapshot,
    project,
    orderMutationInFlight,
  )

  useEffect(() => {
    sortModeRequestsRef.current.activate(project)
    return () => sortModeRequestsRef.current.deactivate(project)
  }, [project])

  useEffect(() => {
    if (latestEventsRef.current !== events) {
      latestEventsRef.current = events
      setOptimisticEvents(null)
    }
  }, [events])

  useEffect(() => {
    let cancelled = false
    const request = sortModeRequestsRef.current.beginRead(project, sortModeReloadToken)
    if (!request) return
    setTimelineSortModeSnapshot(null)
    setSortModeLoadError('')
    void timelineApi
      .getOrderMode(project)
      .then((result) => {
        if (cancelled) return
        const mode = sortModeRequestsRef.current.commitRead(request, result.mode)
        if (mode) {
          setTimelineSortModeSnapshot({ project, mode })
        } else if (sortModeRequestsRef.current.isLatest(request)) {
          setSortModeLoadError(t('timeline.reorderFailed'))
        }
      })
      .catch((error) => {
        if (!cancelled && sortModeRequestsRef.current.isLatest(request)) {
          setTimelineSortModeSnapshot(null)
          setSortModeLoadError(error instanceof Error ? error.message : t('timeline.reorderFailed'))
        }
      })
    return () => {
      cancelled = true
    }
  }, [project, sortModeReloadToken, t])

  const closeDeleteDialog = () => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteError('')
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError('')
    try {
      await timelineApi.delete(project, deleteTarget.id)
      reload()
      notifyDataChanged('timeline', [deleteTarget.id])
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t('timeline.deleteFailed'))
    }
    setDeleting(false)
  }

  const handleDrop = async (targetId: string, insertAfter: boolean, draggedId: string) => {
    if (!draggedId || draggedId === targetId || isOrderInteractionDisabled) return

    const nextEvents = [...displayedEvents]
    const draggedIndex = nextEvents.findIndex((event) => event.id === draggedId)
    if (draggedIndex === -1) return

    const [draggedEvent] = nextEvents.splice(draggedIndex, 1)
    const targetIndex = nextEvents.findIndex((event) => event.id === targetId)
    if (!draggedEvent || targetIndex === -1) return
    nextEvents.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedEvent)
    if (nextEvents.every((event, index) => event.id === displayedEvents[index]?.id)) return

    setDraggingEventId(null)
    setDropPosition(null)
    setReorderError('')
    setOptimisticEvents(nextEvents)
    setOrderMutationInFlight(true)
    const sortModeMutation = sortModeRequestsRef.current.beginMutation(project)
    if (!sortModeMutation) {
      setOptimisticEvents(null)
      setOrderMutationInFlight(false)
      return
    }
    try {
      await timelineApi.reorder(
        project,
        nextEvents.map((event) => event.id),
      )
      const mode = sortModeRequestsRef.current.commitMutation(sortModeMutation, 'manual')
      if (mode) setTimelineSortModeSnapshot({ project, mode })
    } catch (error) {
      if (sortModeRequestsRef.current.isCurrentMutation(sortModeMutation)) {
        setOptimisticEvents(null)
        setTimelineSortModeSnapshot(null)
        setReorderError(error instanceof Error ? error.message : t('timeline.reorderFailed'))
      }
    } finally {
      if (sortModeRequestsRef.current.finishMutation(sortModeMutation)) setOrderMutationInFlight(false)
      // Even a rejected HTTP response can follow a committed server write.
      // Broadcasting on every settlement makes a remounted A after A -> B -> A
      // and the current instance both reload the events and order mode.
      notifyDataChanged(
        'timeline',
        nextEvents.map((event) => event.id),
      )
    }
  }

  const findDropPosition = (clientY: number, draggedId: string): DropPosition | null => {
    const candidates = displayedEvents.filter((event) => event.id !== draggedId)
    for (const event of candidates) {
      const element = eventItemRefs.current.get(event.id)
      if (!element) continue
      const rect = element.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return { targetId: event.id, insertAfter: false }
    }

    const lastEvent = candidates[candidates.length - 1]
    return lastEvent ? { targetId: lastEvent.id, insertAfter: true } : null
  }

  const updateDropPosition = (clientY: number, draggedId: string) => {
    const nextPosition = findDropPosition(clientY, draggedId)
    setDropPosition((currentPosition) => {
      if (
        currentPosition?.targetId === nextPosition?.targetId &&
        currentPosition?.insertAfter === nextPosition?.insertAfter
      ) {
        return currentPosition
      }
      return nextPosition
    })
  }

  const clearPointerDrag = () => {
    pointerDragRef.current = null
    setDraggingEventId(null)
    setDropPosition(null)
  }

  const handleDragPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, eventId: string) => {
    if (isOrderInteractionDisabled || !event.isPrimary || event.button !== 0) return

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerDragRef.current = {
      eventId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    }
    setReorderError('')
  }

  const handleDragPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointerDrag = pointerDragRef.current
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return

    if (!pointerDrag.started) {
      const distance = Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY)
      if (distance < 4) return
      pointerDrag.started = true
      setDraggingEventId(pointerDrag.eventId)
    }

    updateDropPosition(event.clientY, pointerDrag.eventId)
  }

  const handleDragPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const pointerDrag = pointerDragRef.current
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return

    const nextPosition = pointerDrag.started ? findDropPosition(event.clientY, pointerDrag.eventId) : null
    pointerDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    setDraggingEventId(null)
    setDropPosition(null)

    if (nextPosition) void handleDrop(nextPosition.targetId, nextPosition.insertAfter, pointerDrag.eventId)
  }

  const handleDragKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, eventId: string) => {
    if (isOrderInteractionDisabled) return
    const move = getTimelineKeyboardMove(
      displayedEvents.map((timelineEvent) => timelineEvent.id),
      eventId,
      event.key,
    )
    if (!move) return

    event.preventDefault()
    void handleDrop(move.targetId, move.insertAfter, eventId)
  }

  const handleRestoreAutoOrder = async () => {
    if (isOrderInteractionDisabled) return

    setOrderMutationInFlight(true)
    setReorderError('')
    const sortModeMutation = sortModeRequestsRef.current.beginMutation(project)
    if (!sortModeMutation) {
      setOrderMutationInFlight(false)
      return
    }
    try {
      await timelineApi.restoreAutoOrder(project)
      const mode = sortModeRequestsRef.current.commitMutation(sortModeMutation, 'auto')
      if (mode) {
        setTimelineSortModeSnapshot({ project, mode })
        setOptimisticEvents(null)
      }
    } catch (error) {
      if (sortModeRequestsRef.current.isCurrentMutation(sortModeMutation)) {
        setTimelineSortModeSnapshot(null)
        setReorderError(error instanceof Error ? error.message : t('timeline.restoreAutoOrderFailed'))
      }
    } finally {
      if (sortModeRequestsRef.current.finishMutation(sortModeMutation)) setOrderMutationInFlight(false)
      notifyDataChanged('timeline')
    }
  }

  if (loading && !events)
    return <div className="flex-1 flex items-center justify-center text-[var(--ink-mute)]">{t('common.loading')}</div>

  return (
    <>
      <div className="page-header">
        <h2 className="flex items-center gap-2">
          <CalendarDays className="w-5 h-5" /> {t('pages.timeline')}
        </h2>
        <div className="page-header-actions">
          {timelineSortMode === 'manual' && (
            <button
              type="button"
              className="btn-secondary flex items-center gap-1"
              style={{ height: 30, padding: '0 14px' }}
              onClick={handleRestoreAutoOrder}
              disabled={isOrderInteractionDisabled}
            >
              <ArrowDownUp className="size-3.5" /> {t('timeline.restoreAutoOrder')}
            </button>
          )}
          <button
            type="button"
            className="btn-primary flex items-center gap-1"
            style={{ height: 30, padding: '0 14px' }}
            onClick={() => setShowCreate(true)}
          >
            <Plus className="w-3.5 h-3.5" /> {t('pages.newEvent')}
          </button>
        </div>
      </div>

      {showCreate && (
        <SimpleCreateDialog
          title={`+ ${t('pages.newEvent')}`}
          fields={[
            { key: 'year', label: t('timeline.yearLabel'), required: true, placeholder: t('timeline.yearPlaceholder') },
            {
              key: 'title',
              label: t('timeline.titleLabel'),
              required: true,
              placeholder: t('timeline.titlePlaceholder'),
            },
            {
              key: 'description',
              label: t('timeline.descriptionLabel'),
              type: 'textarea',
              placeholder: t('timeline.descriptionPlaceholder'),
            },
            {
              key: 'importance',
              label: t('timeline.importanceLabel'),
              type: 'number',
              required: true,
              placeholder: t('timeline.importancePlaceholder'),
              defaultValue: '3',
              min: 1,
              max: 5,
              step: 1,
            },
          ]}
          onSubmit={async (vals) => {
            const created = await timelineApi.create(project, {
              year: vals.year,
              title: vals.title,
              description: vals.description,
              importance: Number(vals.importance),
            })
            reload()
            notifyDataChanged('timeline', created?.id ? [created.id] : undefined)
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {editingEvent && (
        <SimpleCreateDialog
          key={editingEvent.id}
          title={t('timeline.editEvent')}
          submitLabel={t('timeline.saveChanges')}
          submittingLabel={t('common.saving')}
          fields={[
            {
              key: 'year',
              label: t('timeline.yearLabel'),
              required: true,
              placeholder: t('timeline.yearPlaceholder'),
              defaultValue: editingEvent.year,
            },
            {
              key: 'title',
              label: t('timeline.titleLabel'),
              required: true,
              placeholder: t('timeline.titlePlaceholder'),
              defaultValue: editingEvent.title,
            },
            {
              key: 'description',
              label: t('timeline.descriptionLabel'),
              type: 'textarea',
              placeholder: t('timeline.descriptionPlaceholder'),
              defaultValue: editingEvent.description,
            },
            {
              key: 'importance',
              label: t('timeline.importanceLabel'),
              type: 'number',
              placeholder: t('timeline.importancePlaceholder'),
              defaultValue: String(editingEvent.importance),
              required: true,
              min: 1,
              max: 5,
              step: 1,
            },
          ]}
          onSubmit={async (vals) => {
            await timelineApi.update(project, editingEvent.id, {
              year: vals.year,
              title: vals.title,
              description: vals.description,
              importance: Number(vals.importance),
            })
            reload()
            notifyDataChanged('timeline', [editingEvent.id])
          }}
          onClose={() => setEditingEvent(null)}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4" role="presentation">
          <button
            type="button"
            className="absolute inset-0 cursor-default border-none bg-transparent p-0"
            aria-label={t('common.cancel')}
            onClick={closeDeleteDialog}
            disabled={deleting}
          />
          <section
            className="relative z-10 w-[420px] max-w-full rounded-xl border border-[var(--hairline-light)] bg-[var(--canvas-card)] p-6 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-timeline-event-title"
          >
            <h3 id="delete-timeline-event-title" className="font-display text-[20px] font-semibold text-[var(--ink)]">
              {t('timeline.deleteEvent')}
            </h3>
            <p className="mt-3 text-[14px] leading-6 text-[var(--ink-secondary)]">
              {t('timeline.deleteConfirmation', { title: deleteTarget.title })}
            </p>
            {deleteError && (
              <div className="mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-500">
                {deleteError}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-2 border-t border-[var(--hairline)] pt-4">
              <button
                type="button"
                className="h-[32px] rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] px-4 text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--canvas-mid)] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={closeDeleteDialog}
                disabled={deleting}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="h-[32px] rounded-lg border-none bg-red-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? t('common.saving') : t('timeline.deleteEvent')}
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="page-body" style={{ padding: 0 }}>
        {sortModeLoadError && (
          <div
            className="mx-8 mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-500"
            role="alert"
          >
            <span>{sortModeLoadError}</span>
            <button
              type="button"
              className="shrink-0 underline"
              onClick={() => setSortModeReloadToken((token) => token + 1)}
            >
              {t('serverStatus.retry')}
            </button>
          </div>
        )}
        {reorderError && (
          <div
            className="mx-8 mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[13px] text-red-500"
            role="alert"
          >
            {reorderError}
          </div>
        )}
        <ul className="relative list-none px-8 pb-8 pt-6">
          <li aria-hidden="true" className="absolute left-[38px] top-6 bottom-0 w-[2px] bg-[var(--hairline-light)]" />
          {displayedEvents.map((ev, _i) => (
            <li
              key={ev.id}
              ref={(element) => {
                if (element) eventItemRefs.current.set(ev.id, element)
                else eventItemRefs.current.delete(ev.id)
              }}
              className={`relative flex gap-[18px] pb-[18px] transition-opacity ${draggingEventId === ev.id ? 'opacity-50' : ''}`}
            >
              {dropPosition?.targetId === ev.id && !dropPosition.insertAfter && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-[9px] left-[6px] right-0 z-10 h-[3px] rounded-full bg-[var(--accent-gold)] shadow-[0_0_8px_var(--accent-gold-soft-bg)]"
                />
              )}
              <div className="z-[1] mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-[var(--canvas)] bg-[var(--accent-gold)] shadow-[0_0_0_2px_var(--accent-gold-soft-bg)]" />
              <div className="font-display text-lg text-[var(--accent-gold)] w-[90px] shrink-0 text-right">
                {ev.year}
              </div>
              <div className="flex flex-1 items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 text-[15px] text-[var(--ink)]">
                    {ev.title}
                    <span className="ml-2 inline-flex gap-[1px] align-middle">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <span
                          key={star}
                          className="h-2 w-2 rounded-full"
                          style={{ background: star <= ev.importance ? 'var(--accent-gold)' : 'var(--canvas-mid)' }}
                        />
                      ))}
                    </span>
                  </div>
                  <div className="text-[13px] leading-[1.6] text-[var(--ink-tertiary)]">{ev.description}</div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="flex size-7 items-center justify-center rounded-md border border-transparent text-[var(--ink-tertiary)] transition-colors hover:border-[var(--hairline)] hover:bg-[var(--canvas-card)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-gold)]"
                    aria-label={t('timeline.editAction', { title: ev.title })}
                    title={t('timeline.editEvent')}
                    onClick={() => setEditingEvent(ev)}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className="flex size-7 items-center justify-center rounded-md border border-transparent text-[var(--ink-tertiary)] transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                    aria-label={t('timeline.deleteAction', { title: ev.title })}
                    title={t('timeline.deleteEvent')}
                    onClick={() => {
                      setDeleteError('')
                      setDeleteTarget(ev)
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className={`flex size-7 touch-none items-center justify-center rounded-md border border-transparent text-[var(--ink-tertiary)] transition-colors hover:border-[var(--hairline)] hover:bg-[var(--canvas-card)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-gold)] disabled:cursor-not-allowed disabled:opacity-40 ${
                      draggingEventId === ev.id ? 'cursor-grabbing' : 'cursor-grab'
                    }`}
                    aria-label={t('timeline.dragAction', { title: ev.title })}
                    aria-keyshortcuts="ArrowUp ArrowDown"
                    title={t('timeline.dragHint')}
                    disabled={isOrderInteractionDisabled}
                    onKeyDown={(event) => handleDragKeyDown(event, ev.id)}
                    onPointerDown={(event) => handleDragPointerDown(event, ev.id)}
                    onPointerMove={handleDragPointerMove}
                    onPointerUp={handleDragPointerUp}
                    onPointerCancel={clearPointerDrag}
                  >
                    <GripVertical className="size-3.5" />
                  </button>
                </div>
              </div>
              {dropPosition?.targetId === ev.id && dropPosition.insertAfter && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute bottom-[7px] left-[6px] right-0 z-10 h-[3px] rounded-full bg-[var(--accent-gold)] shadow-[0_0_8px_var(--accent-gold-soft-bg)]"
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
