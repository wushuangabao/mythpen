import assert from 'node:assert/strict'
import test from 'node:test'

test('world page uses the full loading fallback only before entries have resolved', async () => {
  const worldViewState = (await import('../src/lib/worldViewState.ts').catch(() => ({}))) as {
    shouldShowWorldInitialLoading?: (loading: boolean, hasEntries: boolean) => boolean
  }

  assert.equal(worldViewState.shouldShowWorldInitialLoading?.(true, false), true)
  assert.equal(worldViewState.shouldShowWorldInitialLoading?.(true, true), false)
  assert.equal(worldViewState.shouldShowWorldInitialLoading?.(false, false), false)
})
