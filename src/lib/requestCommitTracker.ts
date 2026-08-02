export interface RequestTicket {
  key: string
  epoch: number
  sequence: number
}

/**
 * Coordinates overlapping reads without discarding every older success merely
 * because a newer refresh was started. A newer successful response wins, while
 * an older success may still provide current-key data if the newer request
 * failed. Tickets from a previously active key are always rejected.
 */
export function createRequestCommitTracker(initialKey: string) {
  let activeKey = initialKey
  let activeEpoch = 0
  let nextSequence = 0
  let latestStartedSequence = 0
  let latestCommittedSequence = 0

  return {
    activate(key: string) {
      if (key === activeKey) return
      activeKey = key
      activeEpoch++
    },

    invalidate(key: string) {
      if (key !== activeKey) return
      activeEpoch++
    },

    start(key: string): RequestTicket | null {
      if (key !== activeKey) return null
      const ticket = { key, epoch: activeEpoch, sequence: ++nextSequence }
      latestStartedSequence = ticket.sequence
      return ticket
    },

    isActive(ticket: RequestTicket): boolean {
      return ticket.key === activeKey && ticket.epoch === activeEpoch
    },

    isLatest(ticket: RequestTicket): boolean {
      return ticket.key === activeKey && ticket.epoch === activeEpoch && ticket.sequence === latestStartedSequence
    },

    claimSuccess(ticket: RequestTicket): boolean {
      if (ticket.key !== activeKey || ticket.epoch !== activeEpoch || ticket.sequence <= latestCommittedSequence)
        return false
      latestCommittedSequence = ticket.sequence
      return true
    },
  }
}
