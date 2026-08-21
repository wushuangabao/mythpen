import {
  type MigrationPreflightSmokeCase,
  runFixedMigrationPreflightMatrix,
} from './manuscriptMigrationPreflightSmoke.ts'

type BootstrapBinding = Readonly<{
  runId: string
  projectName: string
  projectInstanceId: string
}>

type MigrationProof = Readonly<{
  migrationId: string
  state: 'activated'
}>

const handledRuns = new Set<string>()

export async function startMigrationPreflightSmokeBootstrap(): Promise<boolean> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')])
  const active = await invoke<boolean>('migration_preflight_smoke_active').catch(() => false)
  if (active !== true) return false
  await listen<Readonly<{ runId: string }>>('mythpen://migration-preflight-smoke', async (event) => {
    const runId = event.payload?.runId
    if (!runId || handledRuns.has(runId)) return
    handledRuns.add(runId)
    try {
      const binding = await invoke<BootstrapBinding>('claim_migration_preflight_smoke', { runId })
      const cases = await runFixedMigrationPreflightMatrix(
        Object.freeze({
          projectName: binding.projectName,
          projectInstanceId: binding.projectInstanceId,
          durableDigest: () => invoke<string>('migration_preflight_smoke_digest', { runId }),
          beginMigration: (request) =>
            invoke<MigrationProof>('migration_preflight_smoke_begin', {
              runId,
              request,
            }),
        }),
      )
      await invoke('complete_migration_preflight_smoke', {
        runId,
        cases: cases as readonly MigrationPreflightSmokeCase[],
      })
    } catch (error) {
      await invoke('fail_migration_preflight_smoke', {
        runId,
        code: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    }
  })
  return true
}
