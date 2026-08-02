import { forgetProjectInstance, getProjectInstanceId } from './projectInstanceRegistry.ts'

export class ProjectInstanceChangedDuringDeletionError extends Error {
  readonly project: string
  readonly expectedInstanceId: string
  readonly currentInstanceId?: string

  constructor(project: string, expectedInstanceId: string, currentInstanceId?: string) {
    super(`Project "${project}" changed while waiting to delete it; deletion was cancelled`)
    this.name = 'ProjectInstanceChangedDuringDeletionError'
    this.project = project
    this.expectedInstanceId = expectedInstanceId
    this.currentInstanceId = currentInstanceId
  }
}

/**
 * Drain writes and revalidate the exact immutable instance before issuing the
 * destructive request. The request callback receives the already-captured
 * token and must not read the mutable registry again.
 */
export async function deleteCapturedProjectInstance(
  project: string,
  expectedInstanceId: string,
  waitForInflight: () => Promise<void>,
  requestDelete: (expectedInstanceId: string) => Promise<unknown>,
): Promise<void> {
  if (!expectedInstanceId) throw new Error('Project instance is not loaded')
  await waitForInflight()
  const currentInstanceId = getProjectInstanceId(project)
  if (currentInstanceId !== expectedInstanceId) {
    throw new ProjectInstanceChangedDuringDeletionError(project, expectedInstanceId, currentInstanceId)
  }
  await requestDelete(expectedInstanceId)
}

/**
 * Revalidate again after the DELETE response. A replacement may have appeared
 * while the destructive request was in flight; its token and state must stay.
 */
export function finalizeCapturedProjectDeletion(project: string, expectedInstanceId: string): boolean {
  const currentInstanceId = getProjectInstanceId(project)
  if (currentInstanceId && currentInstanceId !== expectedInstanceId) return false
  if (currentInstanceId === expectedInstanceId) forgetProjectInstance(project, expectedInstanceId)
  return true
}
