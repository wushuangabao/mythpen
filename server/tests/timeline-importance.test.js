const test = require('node:test');
const assert = require('node:assert/strict');
const { clampTimelineImportance } = require('../timeline-importance');

test('timeline importance is clamped to the supported 1 through 5 range', () => {
  assert.equal(clampTimelineImportance(-1), 1);
  assert.equal(clampTimelineImportance(0), 1);
  assert.equal(clampTimelineImportance(1), 1);
  assert.equal(clampTimelineImportance(3), 3);
  assert.equal(clampTimelineImportance(5), 5);
  assert.equal(clampTimelineImportance(6), 5);
  assert.equal(clampTimelineImportance(1.9), 1);
  assert.equal(clampTimelineImportance(Number.NaN), 3);
});
