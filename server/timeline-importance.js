const MIN_TIMELINE_IMPORTANCE = 1;
const MAX_TIMELINE_IMPORTANCE = 5;
const DEFAULT_TIMELINE_IMPORTANCE = 3;

function clampTimelineImportance(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_TIMELINE_IMPORTANCE;
  return Math.min(MAX_TIMELINE_IMPORTANCE, Math.max(MIN_TIMELINE_IMPORTANCE, Math.trunc(numericValue)));
}

module.exports = {
  DEFAULT_TIMELINE_IMPORTANCE,
  MAX_TIMELINE_IMPORTANCE,
  MIN_TIMELINE_IMPORTANCE,
  clampTimelineImportance,
};
