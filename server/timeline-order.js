const NUMERIC_TIMELINE_PATTERN = /^([+-]?\d+)(?:\s*(?:[./-]|年)\s*(\d+)(?:\s*(?:[./-]|月)\s*(\d+))?)?\s*(?:年|月|日)?$/u;
const BCE_PREFIX_PATTERN = /^(?:公元前|BCE|BC)\s*/iu;
const BCE_SUFFIX_PATTERN = /\s*(?:BCE|BC)$/iu;

function parseTimelineSortKey(value) {
  let normalized = String(value ?? '').trim();
  let isBce = false;
  if (BCE_PREFIX_PATTERN.test(normalized)) {
    isBce = true;
    normalized = normalized.replace(BCE_PREFIX_PATTERN, '');
  } else if (BCE_SUFFIX_PATTERN.test(normalized)) {
    isBce = true;
    normalized = normalized.replace(BCE_SUFFIX_PATTERN, '');
  }

  const match = normalized.match(NUMERIC_TIMELINE_PATTERN);
  if (!match) return null;

  const key = [match[1], match[2] ?? '0', match[3] ?? '0'].map(Number);
  if (isBce) key[0] = -Math.abs(key[0]);
  return key.every(Number.isSafeInteger) ? key : null;
}

function compareTimelineEvents(first, second) {
  const firstKey = parseTimelineSortKey(first.year);
  const secondKey = parseTimelineSortKey(second.year);

  if (!firstKey) return secondKey ? 1 : 0;
  if (!secondKey) return -1;

  for (let index = 0; index < firstKey.length; index += 1) {
    if (firstKey[index] !== secondKey[index]) return firstKey[index] - secondKey[index];
  }
  return 0;
}

function orderTimelineEvents(events, mode) {
  return mode === 'auto' ? [...events].sort(compareTimelineEvents) : events;
}

function validateTimelineEventOrder(ids, events) {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    return '年表顺序必须是事件 ID 数组';
  }

  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) return '年表顺序包含重复事件';

  const existingIds = new Set(events.map((event) => event.id));
  if (ids.length !== existingIds.size || ids.some((id) => !existingIds.has(id))) {
    return '年表顺序必须包含全部且仅包含当前事件';
  }

  return null;
}

module.exports = { compareTimelineEvents, orderTimelineEvents, parseTimelineSortKey, validateTimelineEventOrder };
