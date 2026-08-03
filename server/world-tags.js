function normalize(tags) {
  return [...new Set(tags
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean))];
}

function parseWorldTags(value) {
  if (Array.isArray(value)) return normalize(value);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return normalize(parsed);
  } catch {}
  return normalize(value.split(/[，,]/));
}

function serializeWorldTags(value) {
  return JSON.stringify(parseWorldTags(value));
}

module.exports = { parseWorldTags, serializeWorldTags };
