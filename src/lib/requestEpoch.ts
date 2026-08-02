export interface RequestEpoch {
  begin: () => number
  invalidate: () => void
  isCurrent: (request: number) => boolean
  registerCleanup: (request: number, cleanup: () => void) => () => void
}

/** A small monotonic guard for async reads that must not overwrite mutations. */
export function createRequestEpoch(): RequestEpoch {
  let epoch = 0
  const cleanups = new Map<number, Set<() => void>>()

  const runCleanups = () => {
    const pending = [...cleanups.values()].flatMap((requestCleanups) => [...requestCleanups])
    cleanups.clear()
    for (const cleanup of pending) {
      try {
        cleanup()
      } catch {
        // Resource cleanup must not prevent the epoch from advancing or block
        // other request owners from releasing their resources.
      }
    }
  }

  return {
    begin: () => {
      epoch++
      runCleanups()
      return epoch
    },
    invalidate: () => {
      epoch++
      runCleanups()
    },
    isCurrent: (request) => request === epoch,
    registerCleanup: (request, cleanup) => {
      if (request !== epoch) {
        cleanup()
        return () => {}
      }

      const requestCleanups = cleanups.get(request) ?? new Set<() => void>()
      requestCleanups.add(cleanup)
      cleanups.set(request, requestCleanups)
      return () => {
        const current = cleanups.get(request)
        if (!current) return
        current.delete(cleanup)
        if (current.size === 0) cleanups.delete(request)
      }
    },
  }
}
