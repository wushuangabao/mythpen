import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestEpoch } from '../src/lib/requestEpoch.ts'

test('a mutation invalidates an older read before it can publish', async () => {
  const epoch = createRequestEpoch()
  const request = epoch.begin()
  let resolveRead!: (value: string) => void
  const read = new Promise<string>((resolve) => {
    resolveRead = resolve
  })
  let visible = 'initial'

  const publish = read.then((value) => {
    if (epoch.isCurrent(request)) visible = value
  })

  epoch.invalidate()
  visible = 'mutation'
  resolveRead('stale read')
  await publish

  assert.equal(visible, 'mutation')
  assert.equal(epoch.isCurrent(request), false)
})

test('a newer read supersedes an older read', () => {
  const epoch = createRequestEpoch()
  const older = epoch.begin()
  const newer = epoch.begin()

  assert.equal(epoch.isCurrent(older), false)
  assert.equal(epoch.isCurrent(newer), true)
})

test('invalidating or superseding a read releases its registered resources exactly once', () => {
  const epoch = createRequestEpoch()
  const first = epoch.begin()
  let firstReleases = 0
  epoch.registerCleanup(first, () => {
    firstReleases++
  })

  const second = epoch.begin()
  assert.equal(firstReleases, 1)

  let secondReleases = 0
  const unregister = epoch.registerCleanup(second, () => {
    secondReleases++
  })
  unregister()
  epoch.invalidate()

  assert.equal(firstReleases, 1)
  assert.equal(secondReleases, 0)
})

test('registering cleanup for an already stale read releases immediately', () => {
  const epoch = createRequestEpoch()
  const stale = epoch.begin()
  epoch.invalidate()
  let releases = 0

  epoch.registerCleanup(stale, () => {
    releases++
  })

  assert.equal(releases, 1)
})
