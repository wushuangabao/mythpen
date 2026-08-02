export interface PendingRevisionMutation {
  readonly token: number
  readonly project: string
  readonly projectInstanceId: string | undefined
  readonly chapterId: number
}

type PendingEntry = PendingRevisionMutation & { settled: boolean }

const pendingMutations = new Map<number, PendingEntry>()
let mutationSequence = 0

function matchesTarget(
  entry: PendingRevisionMutation,
  project: string,
  projectInstanceId: string | undefined,
  chapterId: number,
): boolean {
  return entry.project === project && entry.projectInstanceId === projectInstanceId && entry.chapterId === chapterId
}

export function beginPendingRevisionMutation(
  project: string,
  projectInstanceId: string | undefined,
  chapterId: number,
): PendingRevisionMutation {
  const marker: PendingEntry = {
    token: ++mutationSequence,
    project,
    projectInstanceId,
    chapterId,
    settled: false,
  }
  pendingMutations.set(marker.token, marker)
  return marker
}

export function settlePendingRevisionMutation(marker: PendingRevisionMutation): boolean {
  const current = pendingMutations.get(marker.token)
  if (!current || !matchesTarget(current, marker.project, marker.projectInstanceId, marker.chapterId)) return false
  current.settled = true
  return true
}

export function completePendingRevisionMutation(marker: PendingRevisionMutation): boolean {
  const current = pendingMutations.get(marker.token)
  if (!current || !matchesTarget(current, marker.project, marker.projectInstanceId, marker.chapterId)) return false
  pendingMutations.delete(marker.token)
  return true
}

export function hasPendingRevisionMutation(
  project: string,
  projectInstanceId: string | undefined,
  chapterId: number,
): boolean {
  return [...pendingMutations.values()].some((entry) => matchesTarget(entry, project, projectInstanceId, chapterId))
}

export function hasInFlightRevisionMutation(
  project: string,
  projectInstanceId: string | undefined,
  chapterId: number,
): boolean {
  return [...pendingMutations.values()].some(
    (entry) => !entry.settled && matchesTarget(entry, project, projectInstanceId, chapterId),
  )
}

export function resolveSettledRevisionMutations(
  project: string,
  projectInstanceId: string | undefined,
  chapterId: number,
): number {
  let resolved = 0
  for (const [token, entry] of pendingMutations) {
    if (entry.settled && matchesTarget(entry, project, projectInstanceId, chapterId)) {
      pendingMutations.delete(token)
      resolved++
    }
  }
  return resolved
}

export function retireProjectRevisionMutations(project: string, projectInstanceId?: string): number {
  let retired = 0
  for (const [token, entry] of pendingMutations) {
    if (
      entry.project === project &&
      (projectInstanceId === undefined || entry.projectInstanceId === projectInstanceId)
    ) {
      pendingMutations.delete(token)
      retired++
    }
  }
  return retired
}
