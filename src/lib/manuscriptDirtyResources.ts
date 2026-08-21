import {
  DirtyResourceRegistry,
  type DirtyResourceIdentity,
  type DirtyResourceState,
  type JsonValue,
} from './dirtyResourceRegistry.ts'

export type ManuscriptDirtyBinding = Readonly<{
  identity: DirtyResourceIdentity
  baseRawSha256: string
}>

const registry = new DirtyResourceRegistry()

export function markManuscriptResourceDirty(
  binding: ManuscriptDirtyBinding,
  revision: number,
  payload: JsonValue,
): void {
  const fieldMask =
    binding.identity.domain === 'body'
      ? ['content']
      : binding.identity.domain === 'sidecar'
        ? ['title']
        : [binding.identity.domain]
  registry.markDirty(binding.identity, {
    revision,
    baseRawSha256: binding.baseRawSha256,
    fieldMask,
    payload,
  })
}

export function markManuscriptResourceSaving(
  binding: ManuscriptDirtyBinding,
  revision: number,
  requestId: string,
): void {
  registry.markSaving(binding.identity, revision, requestId)
}

export function settleManuscriptResource(
  binding: ManuscriptDirtyBinding,
  revision: number,
  requestId: string,
  result: 'saved' | 'stale' | 'failed',
): void {
  registry.settle(binding.identity, revision, requestId, result)
}

export function discardManuscriptDirtyResource(binding: ManuscriptDirtyBinding): void {
  registry.discard(binding.identity)
}

export function getManuscriptDirtySnapshot(): ReadonlyArray<DirtyResourceState> {
  return registry.snapshot()
}
