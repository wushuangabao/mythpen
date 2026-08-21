/**
 * Shared project context builder — extracts current project state
 * from the database and formats it for injection into system prompts.
 */
const db = require('../db');
const { getManuscriptRuntime } = require('../manuscript/runtime');
const { readLegacyPromptContext } = require('../manuscript-service');

const GENRE_LABELS = {
  'sci-fi': '科幻', 'fantasy': '玄幻', 'romance': '言情',
  'history': '历史', 'urban': '都市', 'power-fantasy': '爽文',
  'biography': '传记', 'other': '其他',
};

const MODE_LABELS = {
  'short-story': '短篇（<=3万字）',
  'medium-novel': '中篇（5-10万字）',
  'long-novel': '长篇（20万字+）',
};

const PHASE_LABELS = {
  idea: '选题', setting: '设定', outline: '大纲',
  writing: '写作', review: '审阅', consistency: '一致性', export: '导出',
};

const CHARACTER_ROLE_LABELS = {
  major: '主角',
  minor: '配角',
  extra: '客串',
};

function projectRouteError(route) {
  const error = new Error(`Project manuscript route is not readable: ${route}`);
  error.code = route === 'migrating' ? 'PROJECT_MIGRATION_BUSY' : 'RECOVERY_REQUIRED';
  return error;
}

async function readProjectContext(projectName) {
  const admission = db.inspectProjectManuscriptRoute(projectName);
  if (admission.route === 'files') {
    const result = await getManuscriptRuntime().read(
      Object.freeze({ projectUid: admission.databaseFacts.projectUid }),
      Object.freeze({ kind: 'prompt_context' }),
    );
    return result.value;
  }
  if (admission.route !== 'sqlite') throw projectRouteError(admission.route);
  return readLegacyPromptContext(projectName);
}

async function buildProjectContext(projectName, expectedInstanceId = '') {
  return db.runWithProjectInstance(projectName, expectedInstanceId, async () => {
    const context = await readProjectContext(projectName);
    const meta = context.metadata;
    const genres = context.genres;
    const chars = context.characters;
    const chapters = context.chapters;
    const foreshadows = context.foreshadows;

    const genreStr = genres.map(g => GENRE_LABELS[g] || g).join('、') || '未设定';
    const modeStr = MODE_LABELS[meta.mode] || meta.mode || '中篇';
    const langStr = meta.language === 'en' ? 'English' : '中文';
    const phaseStr = PHASE_LABELS[meta.workflow_phase] || meta.workflow_phase || '选题';

    return `
项目: ${meta.name || projectName}
创作类型: ${genreStr}
篇幅模式: ${modeStr}
写作语言: ${langStr}
当前阶段: ${phaseStr}
当前总字数: ${meta.word_count || '0'}

角色列表:
${chars.map(c => `- [${CHARACTER_ROLE_LABELS[c.role] || '配角'}] ${c.name}（${c.age}岁，${c.gender}）：${c.personality || ''} ${c.background || ''}`).join('\n')}

章节概览:
${chapters.map((chapter) => {
    const chapterIdentity = chapter.chapter_uid
      ? `chapter_uid=${chapter.chapter_uid}`
      : `chapter_id=${chapter.id}`;
    const volumeIdentity = chapter.volume_uid
      ? `volume_uid=${chapter.volume_uid}`
      : `volume_id=${chapter.volume_id}`;
    return `[${chapter.status}] [${chapterIdentity}, ${volumeIdentity}] 第${chapter.num}章 ${chapter.title} - ${chapter.outline || '（暂无大纲）'}`;
  }).join('\n')}

活跃伏笔:
${foreshadows.map(f => `[${f.priority}] ${f.title}：${f.description || ''}`).join('\n')}`;
  });
}

module.exports = { buildProjectContext };
