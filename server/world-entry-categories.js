const WORLD_ENTRY_CATEGORIES = Object.freeze([
  'location',
  'organization',
  'concept',
  'event',
  'technology',
]);

const WORLD_ENTRY_CATEGORY_SET = new Set(WORLD_ENTRY_CATEGORIES);

function isValidWorldEntryCategory(category) {
  return WORLD_ENTRY_CATEGORY_SET.has(category);
}

function worldEntryCategoryError() {
  return `世界观分类必须是以下值之一：${WORLD_ENTRY_CATEGORIES.join('、')}`;
}

module.exports = {
  WORLD_ENTRY_CATEGORIES,
  isValidWorldEntryCategory,
  worldEntryCategoryError,
};
