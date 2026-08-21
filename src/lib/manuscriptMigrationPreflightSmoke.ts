import { HostMigrationPreflightCoordinator } from './manuscriptWindowCoordinator.ts'

export const MIGRATION_PREFLIGHT_SMOKE_CASE_IDS = Object.freeze([
  'unresolved_body',
  'unresolved_sidecar',
  'unresolved_volume_metadata',
  'unresolved_structure',
  'unloaded_queue',
  'stale_multi_window_epoch',
  'non_responsive_window',
  'all_persisted_or_explicitly_resolved',
] as const)

type SmokeCaseId = (typeof MIGRATION_PREFLIGHT_SMOKE_CASE_IDS)[number]
type DirtyDomain = 'body' | 'sidecar' | 'volume_metadata' | 'structure'

export type MigrationPreflightSmokeCase = Readonly<{
  id: SmokeCaseId
  status: 'PASS' | 'FAIL'
  apiCalls: number
  serviceCalls: number
  beforeDigest: string
  afterDigest: string
}>

export type MigrationPreflightSmokePort = Readonly<{
  projectName: string
  projectInstanceId: string
  durableDigest(): string | Promise<string>
  beginMigration(
    request: Readonly<{
      projectName: string
      projectInstanceId: string
      requestId: string
    }>,
  ): Promise<Readonly<{ migrationId: string; state: 'activated' }>>
}>

const RESOURCE_UIDS = Object.freeze({
  body: '11111111-1111-4111-8111-111111111111',
  sidecar: '22222222-2222-4222-8222-222222222222',
  volume_metadata: '33333333-3333-4333-8333-333333333333',
  structure: '44444444-4444-4444-8444-444444444444',
})

const SNAPSHOT_IDS = Object.freeze([
  '50000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003',
  '50000000-0000-4000-8000-000000000004',
  '50000000-0000-4000-8000-000000000005',
  '50000000-0000-4000-8000-000000000006',
  '50000000-0000-4000-8000-000000000007',
  '50000000-0000-4000-8000-000000000008',
])

function resourceKind(domain: DirtyDomain): 'chapter' | 'volume' | 'manuscript' {
  if (domain === 'volume_metadata') return 'volume'
  if (domain === 'structure') return 'manuscript'
  return 'chapter'
}

function createScene(caseId: SmokeCaseId, projectName: string, projectInstanceId: string) {
  const domains: readonly DirtyDomain[] =
    caseId === 'all_persisted_or_explicitly_resolved'
      ? ['body', 'sidecar', 'volume_metadata', 'structure']
      : caseId.startsWith('unresolved_')
        ? [caseId.slice('unresolved_'.length) as DirtyDomain]
        : ['body']
  const frozenDirty = domains.map((domain, index) =>
    Object.freeze({
      domain,
      loaded: caseId !== 'unloaded_queue',
      resourceKind: resourceKind(domain),
      resourceUid: RESOURCE_UIDS[domain],
      revision: index + 1,
      windowId: 'main',
    }),
  )
  const frozenQueues = domains.map((domain, index) =>
    Object.freeze({
      domain,
      loaded: caseId !== 'unloaded_queue',
      queueId: `main:${domain}`,
      revision: index + 1,
      state: 'active' as const,
      windowId: 'main',
    }),
  )
  const freezeToken = Object.freeze({})
  const drainToken = Object.freeze({})
  let released = false
  let inspected = 0
  const frozen = Object.freeze({
    projectName,
    projectInstanceId,
    windowSetEpoch: 1,
    windows: Object.freeze([
      Object.freeze({
        windowId: 'main',
        revision: domains.length,
        responded: caseId !== 'non_responsive_window',
      }),
    ]),
    dirtyResources: Object.freeze(frozenDirty),
    saveQueues: Object.freeze(frozenQueues),
  })
  const drainedQueues = frozenQueues.map((entry) =>
    Object.freeze({
      ...entry,
      state: caseId === 'unloaded_queue' ? ('active' as const) : ('cancelled_and_drained' as const),
    }),
  )
  const drained = Object.freeze({
    windowSetEpoch: 1,
    dirtyResources: Object.freeze(
      frozenDirty.map((entry) =>
        Object.freeze({
          ...entry,
          disposition:
            caseId.startsWith('unresolved_') ||
            (caseId === 'all_persisted_or_explicitly_resolved' && entry.domain === 'body')
              ? ('unresolved' as const)
              : ('persisted' as const),
        }),
      ),
    ),
    saveQueues: Object.freeze(drainedQueues),
  })
  const inspection = () =>
    Object.freeze({
      windowSetEpoch: caseId === 'stale_multi_window_epoch' ? 2 : 1,
      windows: frozen.windows,
      dirtyResources: frozen.dirtyResources,
      saveQueues: Object.freeze(drainedQueues),
    })
  return Object.freeze({
    hostState: Object.freeze({
      freeze(instanceId: string) {
        if (released || instanceId !== projectInstanceId) throw new TypeError('invalid smoke freeze')
        return freezeToken
      },
      describe(token: object) {
        if (released || token !== freezeToken) throw new TypeError('invalid smoke freeze token')
        return frozen
      },
      cancelAndDrain(token: object) {
        if (released || token !== freezeToken) throw new TypeError('invalid smoke freeze token')
        return drainToken
      },
      describeDrain(token: object) {
        if (released || token !== drainToken) throw new TypeError('invalid smoke drain token')
        return drained
      },
      inspect(token: object) {
        if (released || token !== freezeToken) throw new TypeError('invalid smoke freeze token')
        inspected += 1
        return inspection()
      },
      release(token: object) {
        if (released || token !== freezeToken) throw new TypeError('invalid smoke freeze token')
        released = true
      },
    }),
    explicitResourceKey: JSON.stringify(['chapter', RESOURCE_UIDS.body, 'body', 'main']),
    inspectionCount: () => inspected,
  })
}

function canonicalUuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
}

async function runCase(
  id: SmokeCaseId,
  index: number,
  port: MigrationPreflightSmokePort,
): Promise<MigrationPreflightSmokeCase> {
  const beforeDigest = await port.durableDigest()
  const scene = createScene(id, port.projectName, port.projectInstanceId)
  let apiCalls = 0
  let serviceCalls = 0
  const coordinator = new HostMigrationPreflightCoordinator({
    hostState: scene.hostState,
    migrationApi: Object.freeze({
      async beginMigration(request: object) {
        apiCalls += 1
        const response = await port.beginMigration(request as never)
        if (
          response === null ||
          typeof response !== 'object' ||
          response.state !== 'activated' ||
          !canonicalUuidV4(response.migrationId)
        ) {
          throw new TypeError('migration service did not return exact activated proof')
        }
        serviceCalls += 1
        return response
      },
    }),
    uuidV4: () => SNAPSHOT_IDS[index],
  })

  let passed = false
  try {
    const snapshot = await coordinator.freezeAllWindows(port.projectInstanceId)
    await coordinator.cancelAndDrainSaveQueues(snapshot)
    if (id === 'all_persisted_or_explicitly_resolved') {
      coordinator.recordDraftResolution(snapshot.snapshotId, scene.explicitResourceKey, 'explicitly_resolved')
      await coordinator.confirmAndBeginMigration(snapshot.snapshotId, { projectName: port.projectName })
      passed = apiCalls === 1 && serviceCalls === 1 && scene.inspectionCount() > 0
    } else {
      const canConfirm = coordinator.canConfirm(snapshot.snapshotId)
      try {
        await coordinator.confirmAndBeginMigration(snapshot.snapshotId, { projectName: port.projectName })
      } catch {
        // Every fixed negative case must stop before migration I/O.
      }
      passed = !canConfirm && apiCalls === 0 && serviceCalls === 0
      try {
        await coordinator.cancel(snapshot.snapshotId)
      } catch {
        // A stale snapshot is already invalid and only release behavior matters.
      }
    }
  } catch {
    passed = false
  }
  const afterDigest = await port.durableDigest()
  if (id !== 'all_persisted_or_explicitly_resolved' && beforeDigest !== afterDigest) passed = false
  return Object.freeze({
    id,
    status: passed ? 'PASS' : 'FAIL',
    apiCalls,
    serviceCalls,
    beforeDigest,
    afterDigest,
  })
}

export async function runFixedMigrationPreflightMatrix(
  port: MigrationPreflightSmokePort,
): Promise<readonly MigrationPreflightSmokeCase[]> {
  if (!Object.isFrozen(port) || !port.projectName || !canonicalUuidV4(port.projectInstanceId)) {
    throw new TypeError('migration preflight smoke port is invalid')
  }
  const results: MigrationPreflightSmokeCase[] = []
  for (let index = 0; index < MIGRATION_PREFLIGHT_SMOKE_CASE_IDS.length; index += 1) {
    results.push(await runCase(MIGRATION_PREFLIGHT_SMOKE_CASE_IDS[index], index, port))
  }
  return Object.freeze(results)
}
