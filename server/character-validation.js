function normalizeCharacterName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

module.exports = { normalizeCharacterName };
