import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIGRATION_PREFLIGHT_SMOKE_CASE_IDS,
  runFixedMigrationPreflightMatrix,
} from '../src/lib/manuscriptMigrationPreflightSmoke.ts'

const INSTANCE_ID = '22222222-2222-4222-8222-222222222222'

test('fixed compiled matrix crosses the real coordinator owner only for the all-resolved case', async () => {
  let durableVersion = 0
  let apiCalls = 0
  const result = await runFixedMigrationPreflightMatrix(Object.freeze({
    projectName: 'compiled-preflight-fixture',
    projectInstanceId: INSTANCE_ID,
    durableDigest() {
      return `digest-${durableVersion}`
    },
    async beginMigration(request) {
      apiCalls += 1
      assert.deepEqual(request, {
        projectName: 'compiled-preflight-fixture',
        projectInstanceId: INSTANCE_ID,
        requestId: request.requestId,
      })
      durableVersion += 1
      return Object.freeze({
        migrationId: '99999999-9999-4999-8999-999999999999',
        state: 'activated' as const,
      })
    },
  }))

  assert.deepEqual(result.map((entry) => entry.id), [...MIGRATION_PREFLIGHT_SMOKE_CASE_IDS])
  assert.equal(result.length, 8)
  for (const entry of result.slice(0, -1)) {
    assert.deepEqual(entry, {
      id: entry.id,
      status: 'PASS',
      apiCalls: 0,
      serviceCalls: 0,
      beforeDigest: 'digest-0',
      afterDigest: 'digest-0',
    })
  }
  assert.deepEqual(result.at(-1), {
    id: 'all_persisted_or_explicitly_resolved',
    status: 'PASS',
    apiCalls: 1,
    serviceCalls: 1,
    beforeDigest: 'digest-0',
    afterDigest: 'digest-1',
  })
  assert.equal(apiCalls, 1)
})

test('a positive response without exact activated migration proof fails the case', async () => {
  let digest = 'before'
  const result = await runFixedMigrationPreflightMatrix(Object.freeze({
    projectName: 'compiled-preflight-fixture',
    projectInstanceId: INSTANCE_ID,
    durableDigest: () => digest,
    async beginMigration() {
      digest = 'after'
      return Object.freeze({ state: 'activated' }) as never
    },
  }))
  assert.equal(result.at(-1)?.status, 'FAIL')
  assert.equal(result.at(-1)?.apiCalls, 1)
  assert.equal(result.at(-1)?.serviceCalls, 0)
})
