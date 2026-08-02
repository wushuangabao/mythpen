import { createRequestCommitTracker, type RequestTicket } from './requestCommitTracker.ts'

export type TimelineSortMode = 'auto' | 'manual'

export interface TimelineSortModeSnapshot {
  project: string
  mode: TimelineSortMode
}

export interface TimelineKeyboardMove {
  targetId: string
  insertAfter: boolean
}

/**
 * Maps an ArrowUp/ArrowDown action to the same drop operation used by pointer
 * reordering. Keeping this independent from the DOM makes boundary behaviour
 * deterministic and testable.
 */
export function getTimelineKeyboardMove(
  eventIds: readonly string[],
  eventId: string,
  key: string,
): TimelineKeyboardMove | null {
  const eventIndex = eventIds.indexOf(eventId)
  if (eventIndex === -1) return null

  if (key === 'ArrowUp' && eventIndex > 0) {
    return { targetId: eventIds[eventIndex - 1], insertAfter: false }
  }
  if (key === 'ArrowDown' && eventIndex < eventIds.length - 1) {
    return { targetId: eventIds[eventIndex + 1], insertAfter: true }
  }
  return null
}

export type TimelineSortModeReadTicket = RequestTicket & { reloadGeneration: number }

export function getTimelineSortModeForProject(
  snapshot: TimelineSortModeSnapshot | null,
  project: string,
): TimelineSortMode | null {
  return snapshot?.project === project ? snapshot.mode : null
}

export function isTimelineOrderInteractionDisabled(
  snapshot: TimelineSortModeSnapshot | null,
  project: string,
  mutationInFlight: boolean,
): boolean {
  return mutationInFlight || getTimelineSortModeForProject(snapshot, project) === null
}

function parseTimelineSortMode(value: unknown): TimelineSortMode | null {
  return value === 'auto' || value === 'manual' ? value : null
}

/**
 * Keeps sort-mode reads and mutations in the activation that started them.
 * In particular, an A response cannot become current after A -> B -> A.
 */
export function createTimelineSortModeRequestGuard(initialProject: string) {
  const requests = createRequestCommitTracker(initialProject)
  let activeProject = initialProject
  let currentMutation: RequestTicket | null = null

  const isSameTicket = (first: RequestTicket | null, second: RequestTicket) =>
    first?.key === second.key && first.epoch === second.epoch && first.sequence === second.sequence

  const isCurrentMutation = (ticket: RequestTicket) =>
    activeProject === ticket.key && isSameTicket(currentMutation, ticket)

  return {
    activate(project: string) {
      if (project !== activeProject) {
        activeProject = project
        currentMutation = null
      }
      requests.activate(project)
    },

    deactivate(project: string) {
      if (project !== activeProject) return
      activeProject = ''
      currentMutation = null
      requests.activate('')
    },

    beginRead(project: string, reloadGeneration = 0): TimelineSortModeReadTicket | null {
      const ticket = requests.start(project)
      return ticket ? { ...ticket, reloadGeneration } : null
    },

    commitRead(ticket: RequestTicket, value: unknown): TimelineSortMode | null {
      const mode = parseTimelineSortMode(value)
      return mode && requests.isLatest(ticket) ? mode : null
    },

    isLatest(ticket: RequestTicket): boolean {
      return requests.isLatest(ticket)
    },

    beginMutation(project: string): RequestTicket | null {
      if (project !== activeProject) return null
      requests.invalidate(project)
      const ticket = requests.start(project)
      currentMutation = ticket
      return ticket
    },

    isCurrentMutation(ticket: RequestTicket): boolean {
      return isCurrentMutation(ticket)
    },

    commitMutation(ticket: RequestTicket, mode: TimelineSortMode): TimelineSortMode | null {
      if (!isCurrentMutation(ticket)) return null
      // A read may have started while the write was in flight and observed the
      // pre-write value. The successful write is newer, so permanently reject
      // all such reads before publishing the mutation result.
      requests.invalidate(ticket.key)
      return mode
    },

    finishMutation(ticket: RequestTicket): boolean {
      if (!isCurrentMutation(ticket)) return false
      currentMutation = null
      return true
    },
  }
}
