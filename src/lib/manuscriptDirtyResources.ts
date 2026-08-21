import {
  type DirtyResourceIdentity,
  DirtyResourceRegistry,
  type DirtyResourceState,
  type JsonValue,
} from './dirtyResourceRegistry.ts'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const MANUSCRIPT_WINDOW_ID = globalThis.crypto?.randomUUID?.() ?? `window-${Date.now()}`

export type ManuscriptDirtyBindingChapter = Readonly<{
  chapterUid?: string
  manuscriptProjectUid?: string
  projectInstanceId?: string
  baseWitness?: Readonly<{
    raw_sha256: string
    sidecar_raw_sha256: string | null
  }>
}>

export type ManuscriptDirtyBinding = Readonly<{
  identity: DirtyResourceIdentity
  baseRawSha256: string
}>

const registry = new DirtyResourceRegistry()

export function isManuscriptSaveProtected(code: string | null | undefined): boolean {
  return code === 'EXTERNAL_DRAFT_CONFLICT' || code === 'RECOVERY_REQUIRED'
}

export function createManuscriptDirtyBinding(
  chapter: ManuscriptDirtyBindingChapter,
  domain: 'body' | 'sidecar',
): ManuscriptDirtyBinding | undefined {
  const rawSha256 = domain === 'body' ? chapter.baseWitness?.raw_sha256 : chapter.baseWitness?.sidecar_raw_sha256
  if (
    !chapter.chapterUid ||
    !chapter.manuscriptProjectUid ||
    !chapter.projectInstanceId ||
    !UUID_V4_PATTERN.test(chapter.chapterUid) ||
    !UUID_V4_PATTERN.test(chapter.manuscriptProjectUid) ||
    !UUID_V4_PATTERN.test(chapter.projectInstanceId) ||
    typeof rawSha256 !== 'string' ||
    !SHA256_PATTERN.test(rawSha256)
  )
    return undefined
  return {
    identity: {
      projectUid: chapter.manuscriptProjectUid,
      projectInstanceId: chapter.projectInstanceId,
      resourceKind: 'chapter',
      resourceUid: chapter.chapterUid,
      domain,
      windowId: MANUSCRIPT_WINDOW_ID,
    },
    baseRawSha256: rawSha256,
  }
}

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
