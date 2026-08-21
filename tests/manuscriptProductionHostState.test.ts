import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createManuscriptProductionHostState,
  type ManuscriptHostWindowParticipant,
} from '../src/lib/manuscriptProductionHostState.ts'

const INSTANCE_ID = '22222222-2222-4222-8222-222222222222'
const BODY_UID = '33333333-3333-4333-8333-333333333333'
const VOLUME_UID = '44444444-4444-4444-8444-444444444444'

function participant(
  windowId: string,
  options: { responded?: boolean; loaded?: boolean; domain?: 'body' | 'sidecar' | 'volume_metadata' | 'structure' } = {},
) {
  let frozen = false
  let revision = 1
  let queueState: 'active' | 'cancelled_and_drained' = 'active'
  const domain = options.domain ?? 'body'
  const resourceUid = domain === 'volume_metadata' ? VOLUME_UID : BODY_UID
  const calls = { freeze: 0, drain: 0, release: 0 }
  const owner: ManuscriptHostWindowParticipant = Object.freeze({
    windowId,
    async freeze(projectInstanceId) {
      calls.freeze += 1
      assert.equal(projectInstanceId, INSTANCE_ID)
      frozen = true
      return options.responded === false ? false : true
    },
    describe(projectInstanceId) {
      assert.equal(projectInstanceId, INSTANCE_ID)
      return Object.freeze({
        projectName: 'legacy-project',
        projectInstanceId: INSTANCE_ID,
        windowRevision: revision,
        dirtyResources: Object.freeze([
          Object.freeze({
            domain,
            loaded: options.loaded ?? true,
            resourceKind: domain === 'volume_metadata' ? 'volume' : domain === 'structure' ? 'manuscript' : 'chapter',
            resourceUid,
            revision,
          }),
        ]),
        saveQueues: Object.freeze([
          Object.freeze({
            domain,
            loaded: options.loaded ?? true,
            queueId: `${windowId}:${domain}`,
            revision,
            state: queueState,
          }),
        ]),
      })
    },
    async cancelAndDrain(projectInstanceId) {
      calls.drain += 1
      assert.equal(projectInstanceId, INSTANCE_ID)
      queueState = 'cancelled_and_drained'
      return Object.freeze([{ resourceUid, domain, disposition: 'unresolved' as const }])
    },
    release(projectInstanceId) {
      calls.release += 1
      assert.equal(projectInstanceId, INSTANCE_ID)
      frozen = false
    },
  })
  return {
    owner,
    calls,
    mutate() {
      revision += 1
    },
    isFrozen() {
      return frozen
    },
  }
}

test('production host state freezes the exact multi-window set and all four dirty domains including unloaded queues', async () => {
  const state = createManuscriptProductionHostState()
  const windows = [
    participant('window-a', { domain: 'body' }),
    participant('window-b', { domain: 'sidecar' }),
    participant('window-c', { domain: 'volume_metadata' }),
    participant('window-d', { domain: 'structure', loaded: false }),
  ]
  const registrations = windows.map(({ owner }) => state.registerWindow(owner))

  const token = await state.hostState.freeze(INSTANCE_ID)
  const frozen = state.hostState.describe(token) as Record<string, unknown>
  assert.deepEqual(
    (frozen.windows as ReadonlyArray<{ windowId: string }>).map((entry) => entry.windowId),
    ['window-a', 'window-b', 'window-c', 'window-d'],
  )
  assert.deepEqual(
    (frozen.dirtyResources as ReadonlyArray<{ domain: string }>).map((entry) => entry.domain),
    ['body', 'sidecar', 'structure', 'volume_metadata'],
  )
  assert.equal(
    (frozen.saveQueues as ReadonlyArray<{ domain: string; loaded: boolean }>).some(
      (entry) => entry.domain === 'structure' && entry.loaded === false,
    ),
    true,
  )
  assert.throws(() => state.assertSaveAdmission(INSTANCE_ID), /frozen/u)

  const drainToken = await state.hostState.cancelAndDrain(token)
  const drained = state.hostState.describeDrain(drainToken) as Record<string, unknown>
  assert.equal(
    (drained.saveQueues as ReadonlyArray<{ state: string }>).every(
      (entry) => entry.state === 'cancelled_and_drained',
    ),
    true,
  )
  await state.hostState.release(token)
  assert.equal(state.assertSaveAdmission(INSTANCE_ID), true)
  assert.equal(windows.every((entry) => !entry.isFrozen()), true)
  registrations.forEach((registration) => registration.unregister())
})

test('late window revision and a non-responsive participant remain visible to coordinator inspection', async () => {
  const state = createManuscriptProductionHostState()
  const responsive = participant('window-a')
  const silent = participant('window-b', { responded: false })
  state.registerWindow(responsive.owner)
  state.registerWindow(silent.owner)

  const token = await state.hostState.freeze(INSTANCE_ID)
  const frozen = state.hostState.describe(token) as Record<string, unknown>
  assert.deepEqual(
    (frozen.windows as ReadonlyArray<{ windowId: string; responded: boolean }>).map((entry) => [
      entry.windowId,
      entry.responded,
    ]),
    [
      ['window-a', true],
      ['window-b', false],
    ],
  )
  responsive.mutate()
  const inspection = state.hostState.inspect(token) as Record<string, unknown>
  assert.equal(
    (inspection.windows as ReadonlyArray<{ windowId: string; revision: number }>).find(
      (entry) => entry.windowId === 'window-a',
    )?.revision,
    2,
  )
  await state.hostState.release(token)
})

test('window identity is exact and cannot be replaced while a freeze owns it', async () => {
  const state = createManuscriptProductionHostState()
  const first = participant('window-a')
  const registration = state.registerWindow(first.owner)
  const token = await state.hostState.freeze(INSTANCE_ID)
  assert.throws(() => state.registerWindow(participant('window-a').owner), /already registered/u)
  registration.unregister()
  assert.throws(() => state.assertSaveAdmission(INSTANCE_ID), /frozen/u)
  await state.hostState.release(token)
  assert.equal(state.assertSaveAdmission(INSTANCE_ID), true)
})
