const fs = require('node:fs');

function fallbackProject(row) {
  return {
    id: row.id,
    name: row.name,
    iconName: 'BookOpen',
    genres: [],
    wordCount: row.word_count || 0,
    chapterCount: 0,
    lastOpened: row.last_opened,
    mode: 'medium-novel',
    status: '未知',
  };
}

function readRecentProject(row, { fsApi = fs, openProjectDb }) {
  try {
    if (!fsApi.statSync(row.file_path).isFile()) return fallbackProject(row);
  } catch {
    return fallbackProject(row);
  }

  try {
    const db = openProjectDb(row.file_path);
    const meta = {};
    db.prepare('SELECT key, value FROM project_meta').all().forEach((item) => { meta[item.key] = item.value; });
    const chapterCount = db.prepare('SELECT COUNT(*) as c FROM chapters').get().c;
    const genres = db.prepare('SELECT genre FROM project_genres').all().map((item) => item.genre);
    const wordCount = parseInt(meta.word_count || '0');
    const iconMap = { 'sci-fi': 'Rocket', fantasy: 'Wand', romance: 'Heart', history: 'Landmark', urban: 'Building', 'power-fantasy': 'Zap', biography: 'BookOpen', other: 'Scroll' };
    const genreLabels = { 'sci-fi': '科幻', fantasy: '玄幻', romance: '言情', history: '历史', urban: '都市', 'power-fantasy': '爽文', biography: '传记', other: '其他' };
    return {
      id: row.id,
      name: row.name,
      iconName: genres.map((genre) => iconMap[genre] || 'BookOpen').join(' ') || 'BookOpen',
      genres: genres.map((genre) => genreLabels[genre] || genre),
      wordCount,
      chapterCount,
      lastOpened: row.last_opened,
      mode: meta.mode || 'medium-novel',
      status: wordCount > 30000 ? '写作中' : wordCount > 5000 ? '进行中' : '刚起步',
    };
  } catch {
    return fallbackProject(row);
  }
}

module.exports = { readRecentProject };
