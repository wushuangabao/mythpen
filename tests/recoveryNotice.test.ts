import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  chooseProjectAfterList,
  createProjectRecoveryController,
  normalizeProjectOpenFields,
  projectSelectionTransition,
  recoveryErrorI18nKey,
  recoveryReasonI18nKey,
  selectReadyFallback,
} from '../src/lib/projectRecovery.ts'
import { createProjectFallbackSummary } from '../src/lib/projectCreationFallback.ts'
import type { ProjectDiagnostics, RecoveryAction } from '../src/types/index.ts'

function diagnostics(overrides: Partial<ProjectDiagnostics> = {}): ProjectDiagnostics {
  return {
    state: 'isolated',
    reasonCode: 'V1_PUBLICATION_FORWARD_RECOVERABLE',
    protocol: 'sqljs-publication-v1',
    backend: 'sqljs-v1',
    schema: 10,
    triggerVersion: null,
    expectedTriggerSetDigest: null,
    projectMetaTriggerSetDigest: null,
    observedTriggerSetDigest: null,
    dbIdentity: { dev: '1', ino: '2' },
    expectedIdentity: { dev: '1', ino: '2' },
    projectInstanceIdSha256: 'd'.repeat(64),
    currentSeq: null,
    expectedSeq: null,
    controlStore: {
      tail: { seq: 1, digest: 'e'.repeat(64) },
      checkpoint: null,
      events: [{ seq: 1, type: 'sqlite.publish.prepared', digest: 'e'.repeat(64), prevDigest: null }],
    },
    integrity: { integrityCheck: 'ok', foreignKeyCheck: 'ok' },
    platformCapabilities: {
      backend: 'win32',
      exclusiveLease: true,
      directoryFsync: true,
      atomicReplace: true,
      verifiedAbsentInstall: true,
    },
    canAutoRecover: true,
    canAdoptIdentity: false,
    recommendedAction: 'recover_v1_publication',
    snapshot: 'a'.repeat(64),
    ...overrides,
  }
}

function readyDiagnostics(snapshot = 'b'.repeat(64)): ProjectDiagnostics {
  return diagnostics({
    state: 'ready',
    reasonCode: null,
    canAutoRecover: false,
    recommendedAction: null,
    snapshot,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

function controllerDependencies(overrides: Partial<{
  getDiagnostics: (name: string) => Promise<ProjectDiagnostics>
  recoverDiagnostics: (name: string, action: RecoveryAction, snapshot: string) => Promise<ProjectDiagnostics>
  exportDiagnostics: (name: string) => Promise<{ filename: string }>
  refreshProjects: (isCurrent: () => boolean) => Promise<void>
  getProjects: () => readonly Array<{ name: string; openState?: unknown }>
  enterReadyProject: (name: string) => void
}> = {}) {
  return {
    getDiagnostics: async () => diagnostics(),
    recoverDiagnostics: async () => readyDiagnostics(),
    exportDiagnostics: async () => ({ filename: '92ecf7ea.mythpen-diagnostics.json' }),
    refreshProjects: async () => {},
    getProjects: () => [{ name: 'novel', openState: 'ready' }],
    enterReadyProject: () => {},
    ...overrides,
  }
}

test('open-state normalization and saved/default selection fail closed', () => {
  assert.deepEqual(normalizeProjectOpenFields({ openState: 'ready', reasonCode: 'ignored' }), {
    openState: 'ready',
    reasonCode: null,
    recommendedAction: null,
  })
  assert.deepEqual(normalizeProjectOpenFields({ openState: 'isolated', reasonCode: 'PROJECT_SCHEMA_TOO_NEW' }), {
    openState: 'isolated',
    reasonCode: 'PROJECT_SCHEMA_TOO_NEW',
    recommendedAction: null,
  })
  for (const openState of [undefined, null, 'unknown', true]) {
    assert.deepEqual(normalizeProjectOpenFields({ openState }), {
      openState: 'isolated',
      reasonCode: 'RECOVERY_REQUIRED',
      recommendedAction: null,
    })
  }

  const projects = [
    { name: 'isolated-saved', openState: 'isolated' },
    { name: 'ready-default', openState: 'ready' },
  ]
  assert.equal(
    chooseProjectAfterList(projects, {
      savedProject: 'isolated-saved',
      currentProject: null,
      recoveryTarget: null,
    }),
    'ready-default',
  )
  assert.equal(
    chooseProjectAfterList([{ name: 'only-isolated' }], {
      savedProject: 'only-isolated',
      currentProject: null,
      recoveryTarget: null,
    }),
    null,
  )
})

test('an active recovery target prevents automatic entry even after its list row becomes ready', () => {
  const projects = [
    { name: 'old-ready', openState: 'ready' },
    { name: 'recovered-target', openState: 'ready' },
  ]
  assert.equal(
    chooseProjectAfterList(projects, {
      savedProject: 'recovered-target',
      currentProject: 'old-ready',
      recoveryTarget: 'recovered-target',
    }),
    'old-ready',
  )
  assert.equal(
    chooseProjectAfterList([{ name: 'recovered-target', openState: 'ready' }], {
      savedProject: 'recovered-target',
      currentProject: null,
      recoveryTarget: 'recovered-target',
    }),
    null,
  )
})

test('ready and isolated clicks produce different workspace transitions', () => {
  assert.deepEqual(projectSelectionTransition({ name: 'ready', openState: 'ready' }, 'old-ready'), {
    kind: 'ready',
    currentProject: 'ready',
    recoveryTarget: null,
    activateWorkspace: true,
  })
  assert.deepEqual(projectSelectionTransition({ name: 'isolated', openState: 'isolated' }, 'old-ready'), {
    kind: 'recovery',
    currentProject: 'old-ready',
    recoveryTarget: 'isolated',
    activateWorkspace: false,
  })
  assert.deepEqual(projectSelectionTransition({ name: 'unknown' }, 'old-ready'), {
    kind: 'recovery',
    currentProject: 'old-ready',
    recoveryTarget: 'unknown',
    activateWorkspace: false,
  })
})

test('deletion fallback selects only a retained ready project', () => {
  assert.equal(
    selectReadyFallback([
      { name: 'isolated-first', openState: 'isolated' },
      { name: 'ready-second', openState: 'ready' },
    ]),
    'ready-second',
  )
  assert.equal(selectReadyFallback([{ name: 'unknown-state' }]), null)
})

test('a successful create response produces an explicitly ready provisional row', () => {
  const project = createProjectFallbackSummary(
    'new-project',
    { name: 'new-project', instanceId: 'new-instance' },
    { mode: 'medium-novel', genres: ['other'] },
    '2026-08-11T00:00:00.000Z',
  )
  assert.equal(project.openState, 'ready')
  assert.equal(project.reasonCode, null)
  assert.equal(project.recommendedAction, null)
})

test('refresh preserves prior diagnostics on failure and blocks concurrent operations', async () => {
  const first = diagnostics()
  const waiting = deferred<ProjectDiagnostics>()
  let diagnosticsCalls = 0
  let recoverCalls = 0
  let exportCalls = 0
  const controller = createProjectRecoveryController(
    'novel',
    controllerDependencies({
      getDiagnostics: async () => {
        diagnosticsCalls++
        if (diagnosticsCalls === 1) return first
        return waiting.promise
      },
      recoverDiagnostics: async () => {
        recoverCalls++
        return readyDiagnostics()
      },
      exportDiagnostics: async () => {
        exportCalls++
        return { filename: 'should-not-run.json' }
      },
    }),
  )

  await controller.refresh()
  const refresh = controller.refresh()
  assert.equal(controller.getState().pending, 'refresh')
  assert.strictEqual(controller.getState().diagnostics, first)
  await controller.refresh()
  await controller.recover()
  await controller.exportDiagnostics()
  assert.equal(diagnosticsCalls, 2)
  assert.equal(recoverCalls, 0)
  assert.equal(exportCalls, 0)

  waiting.reject(Object.assign(new Error('private failure'), { code: 'PROJECT_WRITE_BUSY' }))
  await refresh
  assert.strictEqual(controller.getState().diagnostics, first)
  assert.equal(controller.getState().errorCode, 'PROJECT_WRITE_BUSY')
  assert.equal(controller.getState().pending, null)
})

for (const reasonCode of ['V1_PUBLICATION_FORWARD_RECOVERABLE', 'V1_PUBLICATION_ROLLBACK_RECOVERABLE']) {
  test(`${reasonCode} enters once only after projects and fresh diagnostics are both ready`, async () => {
    const before = diagnostics({ reasonCode })
    const fresh = readyDiagnostics('c'.repeat(64))
    let diagnosticsCalls = 0
    const recoverRequests: Array<{ name: string; action: RecoveryAction; snapshot: string }> = []
    let refreshProjectsCalls = 0
    const entered: string[] = []
    const controller = createProjectRecoveryController(
      'novel',
      controllerDependencies({
        getDiagnostics: async () => (diagnosticsCalls++ === 0 ? before : fresh),
        recoverDiagnostics: async (name, action, snapshot) => {
          recoverRequests.push({ name, action, snapshot })
          return readyDiagnostics()
        },
        refreshProjects: async () => {
          refreshProjectsCalls++
        },
        getProjects: () => [{ name: 'novel', openState: 'ready' }],
        enterReadyProject: (name) => entered.push(name),
      }),
    )

    await controller.refresh()
    await controller.recover()

    assert.deepEqual(recoverRequests, [
      { name: 'novel', action: 'recover_v1_publication', snapshot: before.snapshot },
    ])
    assert.equal(refreshProjectsCalls, 1)
    assert.equal(diagnosticsCalls, 2)
    assert.deepEqual(entered, ['novel'])
    assert.strictEqual(controller.getState().diagnostics, fresh)
    assert.equal(controller.getState().pending, null)
  })
}

test('recover keeps the notice unless project summary and fresh diagnostics are both ready', async () => {
  for (const scene of [
    {
      projects: [{ name: 'novel', openState: 'isolated' }],
      fresh: readyDiagnostics(),
    },
    {
      projects: [{ name: 'novel', openState: 'ready' }],
      fresh: diagnostics({ reasonCode: 'RECOVERY_REQUIRED', canAutoRecover: false, recommendedAction: null }),
    },
    {
      projects: [] as Array<{ name: string; openState: string }>,
      fresh: readyDiagnostics(),
    },
  ]) {
    let diagnosticsCalls = 0
    let enters = 0
    const controller = createProjectRecoveryController(
      'novel',
      controllerDependencies({
        getDiagnostics: async () => (diagnosticsCalls++ === 0 ? diagnostics() : scene.fresh),
        getProjects: () => scene.projects,
        enterReadyProject: () => {
          enters++
        },
      }),
    )
    await controller.refresh()
    await controller.recover()
    assert.equal(enters, 0)
    assert.equal(controller.getState().errorCode, 'RECOVERY_REQUIRED')
    assert.strictEqual(controller.getState().diagnostics, scene.fresh)
  }
})

test('stale recovery is not retried and preserves the previous diagnostics', async () => {
  const before = diagnostics()
  let recoverCalls = 0
  let refreshProjectsCalls = 0
  const controller = createProjectRecoveryController(
    'novel',
    controllerDependencies({
      getDiagnostics: async () => before,
      recoverDiagnostics: async () => {
        recoverCalls++
        throw Object.assign(new Error('private stale evidence'), { code: 'RECOVERY_SNAPSHOT_STALE' })
      },
      refreshProjects: async () => {
        refreshProjectsCalls++
      },
    }),
  )
  await controller.refresh()
  await controller.recover()

  assert.equal(recoverCalls, 1)
  assert.equal(refreshProjectsCalls, 0)
  assert.strictEqual(controller.getState().diagnostics, before)
  assert.equal(controller.getState().errorCode, 'RECOVERY_SNAPSHOT_STALE')
})

test('Stage A refuses non-v1 actions even when diagnostics advertise them', async () => {
  let recoverCalls = 0
  const controller = createProjectRecoveryController(
    'novel',
    controllerDependencies({
      getDiagnostics: async () =>
        diagnostics({
          canAutoRecover: true,
          canAdoptIdentity: true,
          recommendedAction: 'adopt_same_path_identity',
        }),
      recoverDiagnostics: async () => {
        recoverCalls++
        return readyDiagnostics()
      },
    }),
  )
  await controller.refresh()
  await controller.recover()
  assert.equal(recoverCalls, 0)
  assert.equal(controller.getState().errorCode, 'RECOVERY_REQUIRED')
})

test('disposing the controller prevents late recovery work and entry', async () => {
  const waiting = deferred<ProjectDiagnostics>()
  let diagnosticsCalls = 0
  let refreshProjectsCalls = 0
  let enters = 0
  const before = diagnostics()
  const controller = createProjectRecoveryController(
    'novel',
    controllerDependencies({
      getDiagnostics: async () => {
        diagnosticsCalls++
        return before
      },
      recoverDiagnostics: async () => waiting.promise,
      refreshProjects: async () => {
        refreshProjectsCalls++
      },
      enterReadyProject: () => {
        enters++
      },
    }),
  )
  await controller.refresh()
  const recovery = controller.recover()
  controller.dispose()
  waiting.resolve(readyDiagnostics())
  await recovery

  assert.equal(diagnosticsCalls, 1)
  assert.equal(refreshProjectsCalls, 0)
  assert.equal(enters, 0)
  assert.strictEqual(controller.getState().diagnostics, before)
})

test('disposing during project refresh revokes its commit token before list side effects', async () => {
  const refreshStarted = deferred<void>()
  const releaseRefresh = deferred<void>()
  const simulated = {
    currentProject: null as string | null,
    showProjectList: false,
    localStorageWrites: 0,
    phaseCalls: 0,
    chapterCalls: 0,
  }
  let refreshGuardType = 'missing'
  let diagnosticsCalls = 0
  let enters = 0
  const controller = createProjectRecoveryController(
    'novel',
    controllerDependencies({
      getDiagnostics: async () => {
        diagnosticsCalls++
        return diagnosticsCalls === 1 ? diagnostics() : readyDiagnostics()
      },
      recoverDiagnostics: async () => readyDiagnostics(),
      refreshProjects: async (isCurrent) => {
        refreshGuardType = typeof isCurrent
        refreshStarted.resolve(undefined)
        await releaseRefresh.promise
        if (!isCurrent()) return
        simulated.currentProject = 'novel'
        simulated.showProjectList = false
        simulated.localStorageWrites++
        simulated.phaseCalls++
        simulated.chapterCalls++
      },
      enterReadyProject: () => {
        enters++
      },
    }),
  )

  await controller.refresh()
  const recovery = controller.recover()
  await refreshStarted.promise
  controller.dispose()
  simulated.showProjectList = true
  releaseRefresh.resolve(undefined)
  await recovery

  assert.equal(refreshGuardType, 'function')
  assert.equal(simulated.currentProject, null)
  assert.equal(simulated.showProjectList, true)
  assert.equal(simulated.localStorageWrites, 0)
  assert.equal(simulated.phaseCalls, 0)
  assert.equal(simulated.chapterCalls, 0)
  assert.equal(diagnosticsCalls, 1)
  assert.equal(enters, 0)
})

test('diagnostics export stores only the opaque server filename', async () => {
  const controller = createProjectRecoveryController(
    'novel',
    controllerDependencies({
      exportDiagnostics: async (name) => {
        assert.equal(name, 'novel')
        return { filename: '7e632fa2-5d0d.mythpen-diagnostics.json' }
      },
    }),
  )
  await controller.exportDiagnostics()
  assert.equal(controller.getState().exportedFilename, '7e632fa2-5d0d.mythpen-diagnostics.json')
  assert.equal(controller.getState().errorCode, null)
})

test('known reason and error codes map to fixed i18n keys while unknown values use generic fallback', () => {
  assert.equal(recoveryReasonI18nKey('V1_PUBLICATION_FORWARD_RECOVERABLE'), 'recovery.reason.forwardRecoverable')
  assert.equal(recoveryReasonI18nKey('V1_PUBLICATION_ROLLBACK_RECOVERABLE'), 'recovery.reason.rollbackRecoverable')
  assert.equal(recoveryReasonI18nKey('PROJECT_SCHEMA_TOO_NEW'), 'recovery.reason.schemaTooNew')
  assert.equal(recoveryReasonI18nKey('PROJECT_DATABASE_NOT_PROJECT'), 'recovery.reason.notProjectDatabase')
  assert.equal(recoveryReasonI18nKey('unknown-private-code'), 'recovery.reason.generic')
  assert.equal(recoveryErrorI18nKey('PROJECT_WRITE_BUSY'), 'recovery.error.busy')
  assert.equal(recoveryErrorI18nKey('RECOVERY_SNAPSHOT_STALE'), 'recovery.error.stale')
  assert.equal(recoveryErrorI18nKey('unknown-private-code'), 'recovery.error.generic')
})

test('RecoveryNotice exposes accessible safe actions without Stage A adoption controls', () => {
  const source = readFileSync(new URL('../src/components/RecoveryNotice.tsx', import.meta.url), 'utf8')
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /role="alert"/)
  for (const key of ['recovery.refresh', 'recovery.recover', 'recovery.export', 'recovery.back', 'recovery.protect']) {
    assert.ok(source.includes(key), `missing ${key}`)
  }
  assert.ok((source.match(/disabled=\{isPending\}/g) || []).length >= 3)
  for (const forbidden of [
    'adopt_same_path_identity',
    'recover_transaction',
    'canAdoptIdentity',
    'projectInstanceIdSha256',
    'dbIdentity',
    'controlStore',
  ]) {
    assert.equal(source.includes(forbidden), false, `RecoveryNotice must not expose ${forbidden}`)
  }
})

test('App mounts list, recovery notice, and workspace as mutually exclusive branches', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ RecoveryNotice \}/)
  assert.match(source, /const recoveryTarget = useProjectStore/)
  assert.match(source, /showProjectList \? \([\s\S]*?\) : recoveryTarget \? \([\s\S]*?<RecoveryNotice/)
  assert.match(source, /!recoveryTarget && <BottomStatusbar/)
  assert.match(source, /if \(recoveryTarget\) return/)
})

test('ProjectList marks isolated cards and never offers their delete confirmation', () => {
  const source = readFileSync(new URL('../src/pages/ProjectList.tsx', import.meta.url), 'utf8')
  assert.match(source, /recoveryReasonI18nKey/)
  assert.match(source, /p\.openState === 'isolated'/)
  assert.match(source, /p\.openState === 'ready'/)
  assert.match(source, /setCurrentProject\(p\.name\)/)
})

test('project store delegates open-state decisions to the fail-closed helpers', () => {
  const source = readFileSync(new URL('../src/stores/useProjectStore.ts', import.meta.url), 'utf8')
  for (const helper of [
    'normalizeProjectOpenFields',
    'chooseProjectAfterList',
    'projectSelectionTransition',
    'selectReadyFallback',
  ]) {
    assert.ok(source.includes(helper), `store must use ${helper}`)
  }
  assert.match(source, /recoveryTarget: string \| null/)
  assert.match(source, /replaceProjectInstances\(readyProjects\)/)
})

test('Chinese and English recovery messages expose the same required key tree', () => {
  const zh = JSON.parse(readFileSync(new URL('../src/i18n/zh.json', import.meta.url), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(zh.recovery).sort(), Object.keys(en.recovery).sort())
  assert.deepEqual(Object.keys(zh.recovery.reason).sort(), Object.keys(en.recovery.reason).sort())
  assert.deepEqual(Object.keys(zh.recovery.error).sort(), Object.keys(en.recovery.error).sort())
  for (const key of ['title', 'description', 'refresh', 'recover', 'export', 'back', 'protect', 'pending', 'reason', 'error']) {
    assert.ok(key in zh.recovery, `missing recovery.${key}`)
  }
})

test('RecoveryNotice forwards a scoped commit token before project-list state can commit', () => {
  const component = readFileSync(new URL('../src/components/RecoveryNotice.tsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/stores/useProjectStore.ts', import.meta.url), 'utf8')
  assert.match(component, /loadProjects\(\{\s*shouldCommit: isCurrent\s*\}\)/)
  assert.match(store, /loadProjects: async \(options = \{\}\)/)

  const listRead = store.indexOf('await projectsApi.list()')
  const cancelledGuard = store.indexOf('if (options.shouldCommit && !options.shouldCommit())')
  const stateCommit = store.indexOf('projectListRequests.claimSuccess')
  const instanceCommit = store.indexOf('replaceProjectInstances(readyProjects)')
  assert.ok(listRead >= 0 && listRead < cancelledGuard)
  assert.ok(cancelledGuard < stateCommit)
  assert.ok(cancelledGuard < instanceCommit)
})
