import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRevisionParts, materializeRevision } from '../src/lib/revisionDiff.ts'

for (const length of [300, 500, 800, 893]) {
  test(`splits a fully rewritten ${length}-character Chinese chapter into reviewable chunks`, () => {
    const before = '甲'.repeat(length)
    const after = '乙'.repeat(length)
    const parts = buildRevisionParts(before, after)
    const revisions = parts.filter((part) => part.kind === 'revision')

    assert.equal(revisions.length, Math.ceil(length / 160))
    assert.ok(revisions.every((revision) => revision.before.length <= 160 && revision.after.length <= 160))

    const accepted = Object.fromEntries(revisions.map((revision) => [revision.id, 'accepted' as const]))
    assert.equal(materializeRevision(parts, accepted), after)
    assert.equal(materializeRevision(parts, {}), before)
  })
}

test('splits each long replacement around a small common span', () => {
  const before = `${'甲'.repeat(250)}同${'丙'.repeat(250)}`
  const after = `${'乙'.repeat(250)}同${'丁'.repeat(250)}`
  const parts = buildRevisionParts(before, after)
  const revisions = parts.filter((part) => part.kind === 'revision')

  assert.equal(revisions.length, 4)
  assert.ok(revisions.every((revision) => revision.before.length <= 160 && revision.after.length <= 160))

  const accepted = Object.fromEntries(revisions.map((revision) => [revision.id, 'accepted' as const]))
  assert.equal(materializeRevision(parts, accepted), after)
  assert.equal(materializeRevision(parts, {}), before)
})

test('splits long pure insertions and deletions', () => {
  const content = '甲'.repeat(500)

  for (const [before, after] of [
    ['', content],
    [content, ''],
  ]) {
    const parts = buildRevisionParts(before, after)
    const revisions = parts.filter((part) => part.kind === 'revision')
    assert.equal(revisions.length, 4)
    assert.ok(revisions.every((revision) => revision.before.length <= 160 && revision.after.length <= 160))

    const accepted = Object.fromEntries(revisions.map((revision) => [revision.id, 'accepted' as const]))
    assert.equal(materializeRevision(parts, accepted), after)
    assert.equal(materializeRevision(parts, {}), before)
  }
})

test('keeps Unicode code points intact across independently decided chunks', () => {
  const before = `${'甲'.repeat(159)}😀${'甲'.repeat(10)}`
  const after = `${'乙'.repeat(159)}🧑${'乙'.repeat(10)}`
  const parts = buildRevisionParts(before, after)
  const revisions = parts.filter((part) => part.kind === 'revision')

  assert.equal(revisions.length, 2)
  assert.ok(
    revisions.every(
      (revision) => Array.from(revision.before).length <= 160 && Array.from(revision.after).length <= 160,
    ),
  )

  const mixed = materializeRevision(parts, { [revisions[1].id]: 'accepted' })
  assert.equal(mixed, `${'甲'.repeat(159)}😀${'乙'.repeat(10)}`)
})

test('splits an oversized Latin token into bounded review chunks', () => {
  const before = 'a'.repeat(2000)
  const after = 'b'.repeat(2000)
  const parts = buildRevisionParts(before, after)
  const revisions = parts.filter((part) => part.kind === 'revision')

  assert.equal(revisions.length, Math.ceil(2000 / 160))
  assert.ok(
    revisions.every(
      (revision) => Array.from(revision.before).length <= 160 && Array.from(revision.after).length <= 160,
    ),
  )

  const accepted = Object.fromEntries(revisions.map((revision) => [revision.id, 'accepted' as const]))
  assert.equal(materializeRevision(parts, accepted), after)
  assert.equal(materializeRevision(parts, {}), before)
})
