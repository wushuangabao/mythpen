const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeCharacterName } = require('../character-validation');

test('character names must be non-empty strings and are normalized once for every write path', () => {
  assert.equal(normalizeCharacterName(undefined), null);
  assert.equal(normalizeCharacterName(42), null);
  assert.equal(normalizeCharacterName('   '), null);
  assert.equal(normalizeCharacterName('\t\r\n'), null);
  assert.equal(normalizeCharacterName('  林默  '), '林默');
});
