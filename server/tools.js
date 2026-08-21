// ─── Tool schema definitions (OpenAI function-calling format) ───
const CHARACTER_ROLES = new Set(['major', 'minor', 'extra']);
const { normalizeCharacterName } = require('./character-validation');
const { clampTimelineImportance } = require('./timeline-importance');
const { orderTimelineEvents } = require('./timeline-order');
const { createChapter, writeChapterBody } = require('./manuscript-service');
const { parseWorldTags, serializeWorldTags } = require('./world-tags');
const {
  WORLD_ENTRY_CATEGORIES,
  isValidWorldEntryCategory,
  worldEntryCategoryError,
} = require('./world-entry-categories');

const TOOLS = [
  // ═══ Chapters ═══
  {
    type: 'function',
    function: {
      name: 'list_chapters',
      description: '列出小说的所有章节，返回稳定 chapter_id、卷 ID、章节编号、标题、状态、字数和摘要。后续读写或删除章节时应传回 chapter_id。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_chapter',
      description: '获取指定章节的完整正文内容和详细信息（含大纲、叙事维度等）。优先使用 list_chapters 返回的 chapter_id；也可同时传 volume_id 和 chapter_num。只传 chapter_num 时，若多个卷存在同号章节会返回歧义错误。',
      parameters: {
        type: 'object',
        properties: {
          chapter_uid: { type: 'string', description: '文件稿件路由使用的稳定章节 UID' },
          chapter_id: { type: 'number', description: '稳定章节 ID（推荐）' },
          volume_id: { type: 'number', description: '卷 ID；与 chapter_num 联合定位章节' },
          chapter_num: { type: 'number', description: '章节编号；同号章节存在于多个卷时还必须提供 volume_id 或 chapter_id' },
        },
        anyOf: [
          { required: ['chapter_uid'] },
          { required: ['chapter_id'] },
          { required: ['chapter_num'] },
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_chapter',
      description: '创建新章节。新建后会自动按卷内顺序分配编号。如果需要跨卷续接编号（如第三卷从第9章开始），请传入 chapter_num 参数。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '章节标题' },
          chapter_num: { type: 'number', description: '章节编号（可选）。不传则自动按卷内顺序编号；传入则使用指定编号，适合跨卷续接场景' },
          outline: { type: 'string', description: '章节大纲（可选）' },
          content: { type: 'string', description: '章节正文（可选）' },
          status: { type: 'string', enum: ['pending', 'writing', 'review', 'accepted'], description: '章节状态（可选）' },
          summary: { type: 'string', description: '章节摘要（可选）' },
          volume_uid: { type: 'string', description: '文件稿件路由使用的所属卷 UID' },
          volume_id: { type: 'number', description: '所属卷ID，默认为1' },
          cognitive_frame: { type: 'string', description: '叙事维度 — 认知框架（可选）' },
          emotional_anchor: { type: 'string', description: '叙事维度 — 情感锚点（可选）' },
          world_texture: { type: 'string', description: '叙事维度 — 世界质感（可选）' },
          concrete_mystery: { type: 'string', description: '叙事维度 — 悬念设置（可选）' },
          interpersonal_tension: { type: 'string', description: '叙事维度 — 人际张力（可选）' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_chapter',
      description: '更新章节内容。优先使用 list_chapters 或 create_chapter 返回的 chapter_id；也可同时传 volume_id 和 chapter_num。只传 chapter_num 时，若多个卷存在同号章节会拒绝更新。可以只更新部分内容字段。status 可选值：pending（待写）、writing（写作中）、review（审核中）、accepted（已定稿）。',
      parameters: {
        type: 'object',
        properties: {
          chapter_uid: { type: 'string', description: '文件稿件路由使用的稳定章节 UID' },
          chapter_id: { type: 'number', description: '稳定章节 ID（推荐）' },
          volume_id: { type: 'number', description: '卷 ID；与 chapter_num 联合定位章节' },
          chapter_num: { type: 'number', description: '章节编号；同号章节存在于多个卷时还必须提供 volume_id 或 chapter_id' },
          title: { type: 'string', description: '标题（可选）' },
          content: { type: 'string', description: '正文内容（可选）' },
          outline: { type: 'string', description: '大纲（可选）' },
          status: { type: 'string', enum: ['pending', 'writing', 'review', 'accepted'], description: '状态（可选）' },
          summary: { type: 'string', description: '章节摘要（可选）' },
          cognitive_frame: { type: 'string', description: '叙事维度 — 认知框架：角色的认知变化（可选）' },
          emotional_anchor: { type: 'string', description: '叙事维度 — 情感锚点：章节的情感基调（可选）' },
          world_texture: { type: 'string', description: '叙事维度 — 世界质感：场景氛围与细节（可选）' },
          concrete_mystery: { type: 'string', description: '叙事维度 — 悬念设置：本章要埋下或推进的谜团（可选）' },
          interpersonal_tension: { type: 'string', description: '叙事维度 — 人际张力：角色间的冲突与张力（可选）' },
        },
        anyOf: [
          { required: ['chapter_uid'] },
          { required: ['chapter_id'] },
          { required: ['chapter_num'] },
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_chapter',
      description: '删除指定章节。优先使用 list_chapters 返回的 chapter_id；也可同时传 volume_id 和 chapter_num。只传 chapter_num 时，若多个卷存在同号章节会拒绝删除。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: {
          chapter_uid: { type: 'string', description: '文件稿件路由使用的稳定章节 UID' },
          chapter_id: { type: 'number', description: '稳定章节 ID（推荐）' },
          volume_id: { type: 'number', description: '卷 ID；与 chapter_num 联合定位章节' },
          chapter_num: { type: 'number', description: '章节编号；同号章节存在于多个卷时还必须提供 volume_id 或 chapter_id' },
        },
        anyOf: [
          { required: ['chapter_uid'] },
          { required: ['chapter_id'] },
          { required: ['chapter_num'] },
        ],
      },
    },
  },

  // ═══ Characters ═══
  {
    type: 'function',
    function: {
      name: 'list_characters',
      description: '列出小说所有角色及其基本信息（包括角色定位：major=主角、minor=配角、extra=客串）。角色定位是长期叙事定位，不是章节出场方式。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_character',
      description: '获取指定角色的完整信息，包括角色定位、外貌、性格、背景、动机、角色弧线等。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '角色姓名' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_character',
      description: '创建一个新角色。新增角色时应按其长期叙事定位传 role；这不是章节出场方式。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '姓名' },
          role: { type: 'string', enum: ['major', 'minor', 'extra'], description: '长期叙事定位：major=主角，minor=配角，extra=客串；默认 minor，不是章节出场方式' },
          age: { type: 'string', description: '年龄（可选）' },
          gender: { type: 'string', description: '性别（可选）' },
          appearance: { type: 'string', description: '外貌描述（可选）' },
          personality: { type: 'string', description: '性格描述（可选）' },
          background: { type: 'string', description: '背景故事（可选）' },
          motivation: { type: 'string', description: '动机（可选）' },
          arc: { type: 'string', description: '角色弧线（可选）' },
          notes: { type: 'string', description: '备注（可选）' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_character',
      description: '更新已有角色的信息。只传需要修改的字段；role 是长期叙事定位，不是章节出场方式。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '角色姓名' },
          role: { type: 'string', enum: ['major', 'minor', 'extra'], description: '长期叙事定位：major=主角，minor=配角，extra=客串' },
          age: { type: 'string', description: '年龄' },
          gender: { type: 'string', description: '性别' },
          appearance: { type: 'string', description: '外貌' },
          personality: { type: 'string', description: '性格' },
          background: { type: 'string', description: '背景' },
          motivation: { type: 'string', description: '动机' },
          arc: { type: 'string', description: '角色弧线' },
          notes: { type: 'string', description: '备注' },
        },
        required: ['name'],
      },
    },
  },

  // ═══ World ═══
  {
    type: 'function',
    function: {
      name: 'list_world',
      description: '列出小说的所有世界观设定条目，按类别分组。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_world_entry',
      description: '创建一条世界观设定。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: WORLD_ENTRY_CATEGORIES, description: '类别：location(地点)、organization(组织)、concept(概念)、event(事件)、technology(技术)' },
          name: { type: 'string', description: '条目名称' },
          description: { type: 'string', description: '详细描述' },
          tags: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string' },
            ],
            description: '标签（可选；推荐使用字符串数组，兼容旧版逗号分隔字符串）',
          },
        },
        required: ['category', 'name', 'description'],
      },
    },
  },

  // ═══ Foreshadows ═══
  {
    type: 'function',
    function: {
      name: 'list_foreshadows',
      description: '列出小说的所有伏笔，可按状态筛选。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['planted', 'progressing', 'resolved', 'abandoned'], description: '按状态筛选（可选）' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_foreshadow',
      description: '埋下一个新伏笔。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '伏笔标题' },
          description: { type: 'string', description: '伏笔描述' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '优先级' },
          expected_resolve_chapter: { type: 'number', description: '预计揭晓的章节编号' },
        },
        required: ['title', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_foreshadow',
      description: '更新伏笔状态。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '伏笔标题' },
          status: { type: 'string', enum: ['planted', 'progressing', 'resolved', 'abandoned'], description: '新状态' },
          description: { type: 'string', description: '更新描述（可选）' },
        },
        required: ['title'],
      },
    },
  },

  // ═══ Relations ═══
  {
    type: 'function',
    function: {
      name: 'list_relations',
      description: '列出所有角色之间的关系。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_relation',
      description: '创建两个角色之间的关系。',
      parameters: {
        type: 'object',
        properties: {
          character_a: { type: 'string', description: '角色A的姓名' },
          character_b: { type: 'string', description: '角色B的姓名' },
          relation_type: { type: 'string', description: '关系类型，如：朋友、敌人、恋人、师徒、亲人等' },
          description: { type: 'string', description: '关系描述' },
          intensity: { type: 'number', description: '关系强度 1-5，3为默认' },
        },
        required: ['character_a', 'character_b', 'relation_type'],
      },
    },
  },

  // ═══ Memories ═══
  {
    type: 'function',
    function: {
      name: 'list_memories',
      description: '列出所有创作记忆（关键事件、承诺、伏笔提醒等）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_memory',
      description: '记录一条创作记忆，用于提醒后续章节注意的事项。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['character', 'location', 'item', 'event', 'promise', 'other'], description: '类别' },
          content: { type: 'string', description: '记忆内容' },
          source_chapter_id: { type: 'number', description: '来源章节的稳定 ID（推荐，可选）' },
          source_volume_id: { type: 'number', description: '来源卷 ID；与 source_chapter_num 联合定位章节（可选）' },
          source_chapter_num: { type: 'number', description: '来源章节编号（兼容旧调用；同号章节存在于多个卷时还需提供 source_volume_id）' },
        },
        required: ['category', 'content'],
      },
    },
  },

  // ═══ Timeline ═══
  {
    type: 'function',
    function: {
      name: 'list_timeline',
      description: '按当前年表排序策略列出所有时间线事件。自动排序时会按可识别日期排列；若作者手动调整过顺序，则返回顺序优先于时间字段，必须以返回顺序为准。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_timeline_event',
      description: '创建一条时间线事件。',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'string', description: '时间（如"2048年"或"第一章之前"）' },
          title: { type: 'string', description: '事件标题' },
          description: { type: 'string', description: '事件描述' },
          importance: { type: 'number', description: '重要性 1-5，3为默认' },
        },
        required: ['year', 'title', 'description'],
      },
    },
  },

  // ═══ Stats ═══
  {
    type: 'function',
    function: {
      name: 'get_stats',
      description: '获取小说的统计数据：总字数、章节数、角色数、伏笔数、世界观条目数、Token用量等。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },

  // ═══ Volumes ═══
  {
    type: 'function',
    function: {
      name: 'list_volumes',
      description: '列出小说的所有卷（volume）及其章节结构。用于了解整体分卷和章节布局。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_volume',
      description: '创建一个新卷（volume），用于将小说划分为不同部分。新卷会自动分配排序序号。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '卷名称，如"第二卷"、"风暴"等' },
          summary: { type: 'string', description: '卷简介（可选）' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_volume',
      description: '更新卷的名称或简介。不能修改卷的排序。',
      parameters: {
        type: 'object',
        properties: {
          volume_uid: { type: 'string', description: '文件稿件路由使用的稳定卷 UID' },
          volume_id: { type: 'number', description: '要更新的卷ID' },
          title: { type: 'string', description: '新卷名（可选）' },
          summary: { type: 'string', description: '新卷简介（可选）' },
        },
        anyOf: [
          { required: ['volume_uid'] },
          { required: ['volume_id'] },
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_volume',
      description: '删除指定卷及其下的所有章节。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: {
          volume_uid: { type: 'string', description: '文件稿件路由使用的稳定卷 UID' },
          volume_id: { type: 'number', description: '要删除的卷ID' },
        },
        anyOf: [
          { required: ['volume_uid'] },
          { required: ['volume_id'] },
        ],
      },
    },
  },
  // ═══ Science ═══
  {
    type: 'function',
    function: {
      name: 'list_science',
      description: '列出小说的所有科幻设定条目，按标签（已知/外推/假设）分组。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_science_entry',
      description: '创建一条科幻设定条目。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', enum: ['known', 'extrapolation', 'hypothesis'], description: '分类：已知/外推/假设' },
          name: { type: 'string', description: '条目名称' },
          description: { type: 'string', description: '详细描述' },
          references: { type: 'string', description: '参考文献（可选）' },
        },
        required: ['label', 'name', 'description'],
      },
    },
  },

  // ═══ Update tools ═══
  {
    type: 'function',
    function: {
      name: 'update_world_entry',
      description: '更新已有世界观设定条目的内容。只传需要修改的字段。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目ID' },
          category: { type: 'string', enum: WORLD_ENTRY_CATEGORIES, description: '类别（可选）' },
          name: { type: 'string', description: '条目名称（可选）' },
          description: { type: 'string', description: '详细描述（可选）' },
          tags: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string' },
            ],
            description: '标签（可选；推荐使用字符串数组，兼容旧版逗号分隔字符串）',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_relation',
      description: '更新角色关系。只传需要修改的字段。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '关系ID' },
          relation_type: { type: 'string', description: '关系类型，如：朋友、敌人、恋人等（可选）' },
          description: { type: 'string', description: '关系描述（可选）' },
          intensity: { type: 'number', description: '关系强度 1-5（可选）' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_memory',
      description: '更新创作记忆。只传需要修改的字段。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆ID' },
          category: { type: 'string', enum: ['character', 'location', 'item', 'event', 'promise', 'other'], description: '类别（可选）' },
          content: { type: 'string', description: '记忆内容（可选）' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_timeline_event',
      description: '更新时间线事件。只传需要修改的字段。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '事件ID' },
          year: { type: 'string', description: '时间（如"2048年"）（可选）' },
          title: { type: 'string', description: '事件标题（可选）' },
          description: { type: 'string', description: '事件描述（可选）' },
          importance: { type: 'number', description: '重要性 1-5（可选）' },
        },
        required: ['id'],
      },
    },
  },

  // ═══ Delete tools ═══
  {
    type: 'function',
    function: {
      name: 'delete_science_entry',
      description: '删除指定科幻设定条目。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '条目ID' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_character',
      description: '删除指定角色。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '角色姓名' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_world_entry',
      description: '删除指定世界观条目。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '条目ID' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_foreshadow',
      description: '删除指定伏笔。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: '伏笔标题' } },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_relation',
      description: '删除指定角色关系。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '关系ID' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: '删除指定创作记忆。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '记忆ID' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_timeline_event',
      description: '删除指定时间线事件。此操作不可逆，请谨慎使用。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '事件ID' } },
        required: ['id'],
      },
    },
  },
  // ── Chapter Characters ──
  {
    type: 'function',
    function: {
      name: 'list_chapter_characters',
      description: '查询指定章节或指定角色的出场记录。按章节查询时优先传 chapter_id，也可同时传 volume_id 和 chapter_num；只传 chapter_num 时若多个卷存在同号章节会返回歧义错误。',
      parameters: {
        type: 'object',
        properties: {
          chapter_id: { type: 'number', description: '稳定章节 ID（推荐，可选）' },
          volume_id: { type: 'number', description: '卷 ID；与 chapter_num 联合定位章节（可选）' },
          chapter_num: { type: 'number', description: '章节编号（兼容旧调用；同号章节存在于多个卷时还需提供 volume_id）' },
          character_name: { type: 'string', description: '角色姓名（可选，不传则按章节查）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_chapter_character',
      description: '设置角色在指定章节中的出场角色（appears/speaks/pov/mentioned）。优先传 chapter_id，也可同时传 volume_id 和 chapter_num；只传 chapter_num 时若多个卷存在同号章节会拒绝写入。',
      parameters: {
        type: 'object',
        properties: {
          chapter_id: { type: 'number', description: '稳定章节 ID（推荐）' },
          volume_id: { type: 'number', description: '卷 ID；与 chapter_num 联合定位章节' },
          chapter_num: { type: 'number', description: '章节编号（兼容旧调用；同号章节存在于多个卷时还需提供 volume_id）' },
          character_name: { type: 'string', description: '角色姓名' },
          role: { type: 'string', enum: ['appears', 'speaks', 'pov', 'mentioned'], description: '出场方式' },
        },
        required: ['character_name'],
        anyOf: [
          { required: ['chapter_id'] },
          { required: ['chapter_num'] },
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_chapter_character',
      description: '移除角色在指定章节中的出场记录。优先传 chapter_id，也可同时传 volume_id 和 chapter_num；只传 chapter_num 时若多个卷存在同号章节会拒绝删除。',
      parameters: {
        type: 'object',
        properties: {
          chapter_id: { type: 'number', description: '稳定章节 ID（推荐）' },
          volume_id: { type: 'number', description: '卷 ID；与 chapter_num 联合定位章节' },
          chapter_num: { type: 'number', description: '章节编号（兼容旧调用；同号章节存在于多个卷时还需提供 volume_id）' },
          character_name: { type: 'string', description: '角色姓名' },
        },
        required: ['character_name'],
        anyOf: [
          { required: ['chapter_id'] },
          { required: ['chapter_num'] },
        ],
      },
    },
  },
  // ── Clue Board ──
  {
    type: 'function',
    function: {
      name: 'list_clues',
      description: '查询线索板所有条目。可传 status 过滤未解决/已解决。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['all', 'unresolved', 'resolved'], description: '过滤状态（默认 all）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_clue',
      description: '在线索板上创建新条目。kind 类型：clue（线索）、red-herring（误导）、deduction（推理结论）、question（待解问题）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '线索标题' },
          description: { type: 'string', description: '详细描述' },
          kind: { type: 'string', enum: ['clue', 'red-herring', 'deduction', 'question'], description: '条目类型' },
          related_chapter_id: { type: 'number', description: '关联章节的稳定 ID（推荐，可选）' },
          related_volume_id: { type: 'number', description: '关联卷 ID；与 related_chapter_num 联合定位章节（可选）' },
          related_chapter_num: { type: 'number', description: '关联章节编号（兼容旧调用；同号章节存在于多个卷时还需提供 related_volume_id）' },
        },
        required: ['title', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_clue',
      description: '更新线索板条目。可修改标题、描述、类型，或标记为已解决/未解决。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '线索ID' },
          title: { type: 'string', description: '新标题（可选）' },
          description: { type: 'string', description: '新描述（可选）' },
          kind: { type: 'string', enum: ['clue', 'red-herring', 'deduction', 'question'], description: '新类型（可选）' },
          resolved: { type: 'boolean', description: '是否已解决（可选）' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_clue',
      description: '删除线索板条目。此操作不可逆。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '线索ID' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_meta',
      description: '获取当前项目的完整元信息：名称、创作类型（genres）、篇幅模式、写作语言、当前阶段、总字数等。用于了解项目的基本定位和设定。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_project_phase',
      description: '推进项目创作阶段。阶段流转：选题(idea) → 设定(setting) → 大纲(outline) → 写作(writing) → 审阅(review) → 一致性(consistency) → 导出(export)。当当前阶段的创作要素讨论完成并写入数据库后，调用此工具推进到下一阶段。',
      parameters: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['idea', 'setting', 'outline', 'writing', 'review', 'consistency', 'export'], description: '要推进到的目标阶段' },
        },
        required: ['phase'],
      },
    },
  },
];
const { randomUUID } = require('crypto');

const FILES_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CHAPTER_SIDECAR_FIELDS = Object.freeze([
  'title',
  'outline',
  'status',
  'summary',
  'cognitive_frame',
  'emotional_anchor',
  'world_texture',
  'concrete_mystery',
  'interpersonal_tension',
]);
const CHAPTER_STATUSES = new Set(['pending', 'writing', 'review', 'accepted']);
const FILES_RUNTIME_TOOLS = new Set([
  'list_chapters',
  'get_chapter',
  'create_chapter',
  'update_chapter',
  'delete_chapter',
  'list_volumes',
  'create_volume',
  'update_volume',
  'delete_volume',
  'get_stats',
  'get_project_meta',
]);

function filesToolError(code, message) {
  const error = new Error(message);
  error.name = 'FilesManuscriptToolError';
  error.code = code;
  if (code === 'FILES_TOOL_AUTHORITY_UNAVAILABLE') error.recoverable = true;
  return error;
}

function exactFilesToolArgs(value, allowedKeys, requiredKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (
      typeof key !== 'string'
      || !allowed.has(key)
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label} has an invalid shape`);
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(descriptors, key)) {
      throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label}.${key} is required`);
    }
  }
  const result = {};
  for (const key of allowedKeys) {
    if (Object.hasOwn(descriptors, key)) result[key] = descriptors[key].value;
  }
  return Object.freeze(result);
}

function filesString(value, label, { nonEmpty = false } = {}) {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label} must be ${nonEmpty ? 'a non-empty ' : ''}string`);
  }
  return value;
}

function filesUid(value, label) {
  if (typeof value !== 'string' || !FILES_UUID_PATTERN.test(value)) {
    throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label} must be a canonical lowercase UUIDv4`);
  }
  return value;
}

function filesChapterNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || Object.is(value, -0)) {
    throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label} must be a positive safe integer`);
  }
  return value;
}

function filesChapterPatch(input, label) {
  const patch = {};
  for (const key of CHAPTER_SIDECAR_FIELDS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = filesString(input[key], `${label}.${key}`);
    if (key === 'status' && !CHAPTER_STATUSES.has(value)) {
      throw filesToolError('INVALID_FILES_TOOL_INPUT', `${label}.status is invalid`);
    }
    patch[key] = value;
  }
  return Object.freeze(patch);
}

function filesCreateResult(result, objectKind, title) {
  const uidKey = `${objectKind}_uid`;
  return Object.freeze({
    created: true,
    [uidKey]: result.uid,
    [`${objectKind}_id`]: result.id,
    ...(objectKind === 'chapter' ? { chapter_num: result.num } : {}),
    title,
  });
}

async function executeFilesManuscriptTool(admission, toolName, callerArgs) {
  if (!FILES_RUNTIME_TOOLS.has(toolName)) {
    throw filesToolError(
      'FILES_TOOL_AUTHORITY_UNAVAILABLE',
      `Files manuscript tool has no safe runtime authority: ${toolName}`,
    );
  }
  const runtime = require('./manuscript/runtime').getManuscriptRuntime();
  const projectSelector = Object.freeze({
    projectUid: filesUid(
      admission.databaseFacts?.projectUid,
      'manuscriptRoute.databaseFacts.projectUid',
    ),
  });
  const read = async (request) => runtime.read(projectSelector, Object.freeze(request));
  const writeFrom = async (captured, command) => runtime.write(projectSelector, Object.freeze({
    requestId: randomUUID(),
    baseWitness: captured.baseWitness,
    command: Object.freeze(command),
  }));

  switch (toolName) {
    case 'list_chapters': {
      exactFilesToolArgs(callerArgs, [], [], 'list_chapters args');
      return (await read({ kind: 'chapters' })).value;
    }
    case 'get_chapter': {
      const args = exactFilesToolArgs(callerArgs, ['chapter_uid'], ['chapter_uid'], 'get_chapter args');
      const chapterUid = filesUid(args.chapter_uid, 'get_chapter.chapter_uid');
      return (await read({ kind: 'chapter', chapterUid })).value;
    }
    case 'create_chapter': {
      const args = exactFilesToolArgs(callerArgs, [
        'volume_uid',
        'chapter_num',
        'title',
        'outline',
        'content',
        'status',
        'summary',
        'cognitive_frame',
        'emotional_anchor',
        'world_texture',
        'concrete_mystery',
        'interpersonal_tension',
      ], ['volume_uid', 'title'], 'create_chapter args');
      const title = filesString(args.title, 'create_chapter.title', { nonEmpty: true });
      const sidecarInput = {
        title,
        outline: Object.hasOwn(args, 'outline') ? args.outline : '',
        status: Object.hasOwn(args, 'status') ? args.status : 'pending',
        summary: Object.hasOwn(args, 'summary') ? args.summary : '',
        cognitive_frame: Object.hasOwn(args, 'cognitive_frame') ? args.cognitive_frame : '',
        emotional_anchor: Object.hasOwn(args, 'emotional_anchor') ? args.emotional_anchor : '',
        world_texture: Object.hasOwn(args, 'world_texture') ? args.world_texture : '',
        concrete_mystery: Object.hasOwn(args, 'concrete_mystery') ? args.concrete_mystery : '',
        interpersonal_tension: Object.hasOwn(args, 'interpersonal_tension') ? args.interpersonal_tension : '',
      };
      const command = {
        kind: 'chapter.create',
        containerVolumeUid: filesUid(args.volume_uid, 'create_chapter.volume_uid'),
        requestedNum: Object.hasOwn(args, 'chapter_num')
          ? filesChapterNumber(args.chapter_num, 'create_chapter.chapter_num')
          : null,
        content: Object.hasOwn(args, 'content')
          ? filesString(args.content, 'create_chapter.content')
          : '',
        sidecar: filesChapterPatch(sidecarInput, 'create_chapter'),
      };
      const captured = await read({ kind: 'project' });
      return filesCreateResult(await writeFrom(captured, command), 'chapter', title);
    }
    case 'update_chapter': {
      const args = exactFilesToolArgs(callerArgs, [
        'chapter_uid',
        'content',
        ...CHAPTER_SIDECAR_FIELDS,
      ], ['chapter_uid'], 'update_chapter args');
      const chapterUid = filesUid(args.chapter_uid, 'update_chapter.chapter_uid');
      const patch = filesChapterPatch(args, 'update_chapter');
      const hasContent = Object.hasOwn(args, 'content');
      if (!hasContent && Object.keys(patch).length === 0) {
        throw filesToolError('INVALID_FILES_TOOL_INPUT', 'update_chapter has no changed fields');
      }
      const content = hasContent ? filesString(args.content, 'update_chapter.content') : null;
      const captured = await read({ kind: 'chapter', chapterUid });
      const command = hasContent
        ? (Object.keys(patch).length > 0
          ? { kind: 'chapter.replace_body_and_sidecar', chapterUid, content, patch }
          : { kind: 'chapter.replace_body', chapterUid, content })
        : { kind: 'chapter.patch_sidecar', chapterUid, patch };
      await writeFrom(captured, command);
      return Object.freeze({
        updated: true,
        chapter_uid: chapterUid,
        chapter_id: captured.value?.id ?? null,
        volume_id: captured.value?.volume_id ?? null,
        chapter_num: captured.value?.num ?? null,
        changed_fields: Object.freeze([
          ...(hasContent ? ['content'] : []),
          ...Object.keys(patch),
        ]),
      });
    }
    case 'delete_chapter': {
      const args = exactFilesToolArgs(callerArgs, ['chapter_uid'], ['chapter_uid'], 'delete_chapter args');
      const chapterUid = filesUid(args.chapter_uid, 'delete_chapter.chapter_uid');
      const captured = await read({ kind: 'chapter', chapterUid });
      await writeFrom(captured, { kind: 'chapter.delete', chapterUid });
      return Object.freeze({
        deleted: true,
        chapter_uid: chapterUid,
        chapter_id: captured.value?.id ?? null,
        volume_id: captured.value?.volume_id ?? null,
        chapter_num: captured.value?.num ?? null,
      });
    }
    case 'list_volumes': {
      exactFilesToolArgs(callerArgs, [], [], 'list_volumes args');
      return (await read({ kind: 'volumes' })).value;
    }
    case 'get_stats': {
      exactFilesToolArgs(callerArgs, [], [], 'get_stats args');
      return (await read({ kind: 'stats' })).value;
    }
    case 'get_project_meta': {
      exactFilesToolArgs(callerArgs, [], [], 'get_project_meta args');
      const view = (await read({ kind: 'product_view' })).value;
      const metadata = view.metadata;
      const genres = metadata.genres;
      const phase = metadata.workflow_phase || 'idea';
      const genreLabels = {
        'sci-fi': '科幻',
        fantasy: '玄幻',
        romance: '言情',
        history: '历史',
        urban: '都市',
        'power-fantasy': '爽文',
        biography: '传记',
        other: '其他',
      };
      const phaseLabels = {
        idea: '选题',
        setting: '设定',
        outline: '大纲',
        writing: '写作',
        review: '审阅',
        consistency: '一致性',
        export: '导出',
      };
      return Object.freeze({
        name: metadata.name || '',
        genres,
        genreLabels: Object.freeze(genres.map((genre) => genreLabels[genre] || genre)),
        mode: metadata.mode || 'medium-novel',
        language: metadata.language || 'zh',
        phase,
        phaseLabel: phaseLabels[phase] || '选题',
        wordCount: view.summary.wordCount,
        authorName: metadata.author_name || '',
        description: metadata.description || '',
      });
    }
    case 'create_volume': {
      const args = exactFilesToolArgs(callerArgs, ['title', 'summary'], ['title'], 'create_volume args');
      const title = filesString(args.title, 'create_volume.title', { nonEmpty: true });
      const summary = Object.hasOwn(args, 'summary')
        ? filesString(args.summary, 'create_volume.summary')
        : '';
      const captured = await read({ kind: 'project' });
      const result = await writeFrom(captured, { kind: 'volume.create', title, summary });
      return filesCreateResult(result, 'volume', title);
    }
    case 'update_volume': {
      const args = exactFilesToolArgs(
        callerArgs,
        ['volume_uid', 'title', 'summary'],
        ['volume_uid'],
        'update_volume args',
      );
      const volumeUid = filesUid(args.volume_uid, 'update_volume.volume_uid');
      const patch = {};
      for (const key of ['title', 'summary']) {
        if (Object.hasOwn(args, key)) patch[key] = filesString(args[key], `update_volume.${key}`);
      }
      if (Object.keys(patch).length === 0) {
        throw filesToolError('INVALID_FILES_TOOL_INPUT', 'update_volume has no changed fields');
      }
      const captured = await read({ kind: 'volume', volumeUid });
      await writeFrom(captured, {
        kind: 'volume.patch_metadata',
        volumeUid,
        patch: Object.freeze(patch),
      });
      return Object.freeze({
        updated: true,
        volume_uid: volumeUid,
        volume_id: captured.value?.id ?? null,
      });
    }
    case 'delete_volume': {
      const args = exactFilesToolArgs(callerArgs, ['volume_uid'], ['volume_uid'], 'delete_volume args');
      const volumeUid = filesUid(args.volume_uid, 'delete_volume.volume_uid');
      const captured = await read({ kind: 'volume', volumeUid });
      await writeFrom(captured, { kind: 'volume.delete', volumeUid });
      return Object.freeze({
        deleted: true,
        volume_uid: volumeUid,
        volume_id: captured.value?.id ?? null,
      });
    }
    default:
      throw filesToolError('FILES_TOOL_AUTHORITY_UNAVAILABLE', 'Files manuscript tool is unavailable');
  }
}

function executeTool(projectName, toolName, args) {
  const db = require('./db');
  const manuscriptRoute = db.inspectProjectManuscriptRoute(projectName);
  if (manuscriptRoute.route === 'files') {
    return executeFilesManuscriptTool(manuscriptRoute, toolName, args);
  }
  if (manuscriptRoute.route !== 'sqlite') {
    throw filesToolError(
      'MANUSCRIPT_ROUTE_UNAVAILABLE',
      `Manuscript route is not active: ${manuscriptRoute.route}`,
    );
  }

  return executeLegacySqliteTool(db, projectName, toolName, args);
}

function executeLegacySqliteTool(db, projectName, toolName, args) {
  const bodyToolIdentity = (identity = {}) => {
    const provided = (value) => value !== undefined && value !== null && value !== '';
    const parsedPositive = (value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    };
    const hasId = provided(identity.chapter_id);
    const hasNumber = provided(identity.chapter_num);
    const hasVolume = provided(identity.volume_id);
    if (!hasId && !hasNumber) {
      return { error: '必须提供 chapter_id 或 chapter_num', code: 'INVALID_CHAPTER_IDENTITY' };
    }
    const chapterId = hasId ? parsedPositive(identity.chapter_id) : null;
    const chapterNumber = hasNumber ? parsedPositive(identity.chapter_num) : null;
    const volumeId = hasVolume ? parsedPositive(identity.volume_id) : null;
    if ((hasId && !chapterId) || (hasNumber && !chapterNumber) || (hasVolume && !volumeId)) {
      return { error: '章节身份无效', code: 'INVALID_CHAPTER_IDENTITY' };
    }
    return { identity: { chapterId, chapterNumber, volumeId } };
  };
  const bodyToolIdentityError = (identityError) => ({
    error: identityError.code === 'AMBIGUOUS_CHAPTER'
      ? '多个卷中存在相同章节编号，请提供 chapter_id 或 volume_id'
      : '章节身份不存在或不匹配',
    code: identityError.code,
  });

  if (toolName === 'create_chapter') {
    const created = createChapter({
      projectName,
      source: 'ai_tool',
      fields: {
        volume_id: args.volume_id,
        chapter_num: args.chapter_num,
        title: args.title,
        outline: args.outline,
        content: args.content,
        cognitive_frame: args.cognitive_frame,
        emotional_anchor: args.emotional_anchor,
        world_texture: args.world_texture,
        concrete_mystery: args.concrete_mystery,
        interpersonal_tension: args.interpersonal_tension,
      },
    });
    return {
      created: true,
      chapter_id: created.chapterId,
      volume_id: created.volumeId,
      chapter_num: created.chapterNumber,
      title: args.title,
    };
  }

  if (toolName === 'update_chapter' && args.content !== undefined) {
    const resolvedIdentity = bodyToolIdentity(args);
    if (resolvedIdentity.error) return resolvedIdentity;
    const {
      chapter_id: _chapterId,
      chapter_num: _chapterNumber,
      volume_id: _volumeId,
      ...fields
    } = args;
    const allowed = ['title', 'content', 'outline', 'status', 'summary', 'cognitive_frame', 'emotional_anchor', 'world_texture', 'concrete_mystery', 'interpersonal_tension'];
    const changedFields = Object.keys(fields).filter((key) => allowed.includes(key));
    const patch = {};
    for (const key of allowed) {
      if (key !== 'content' && fields[key] !== undefined) patch[key] = fields[key];
    }
    const updated = writeChapterBody({
      projectName,
      identity: resolvedIdentity.identity,
      content: String(fields.content),
      source: 'ai_tool',
      ...patch,
    });
    if (updated.identityError) return bodyToolIdentityError(updated.identityError);
    if (updated.missing) return { error: '章节不存在', code: 'CHAPTER_NOT_FOUND' };
    return {
      updated: true,
      chapter_id: updated.chapter.id,
      volume_id: updated.chapter.volume_id,
      chapter_num: updated.chapter.num,
      changed_fields: changedFields,
    };
  }

  const pdb = db.getProjectDb(projectName);

  // ─── Shared helpers ───
  function executeLegacySqliteUpdateById(id, table, fields, allowed, addUpdatedAt) {
    const updates = []; const params = [];
    for (const key of allowed) {
      if (fields[key] !== undefined) { updates.push(`${key} = ?`); params.push(fields[key]); }
    }
    if (updates.length === 0) return { error: '没有要更新的字段' };
    if (addUpdatedAt) updates.push("updated_at = datetime('now')");
    params.push(id);
    const info = pdb.prepare(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (info.changes === 0) return { error: `条目 ${id} 不存在` };
    return { updated: true, id };
  }

  function executeLegacySqliteDeleteById(id, table, idField, entityName) {
    const info = pdb.prepare(`DELETE FROM ${table} WHERE ${idField} = ?`).run(id);
    if (info.changes === 0) return { error: `${entityName} ${id} 不存在` };
    return { deleted: true, [idField]: id };
  }

  function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function isProvided(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function hasChapterIdentity(identity = {}) {
    return isProvided(identity.chapter_id)
      || isProvided(identity.volume_id)
      || isProvided(identity.chapter_num);
  }

  function prefixedChapterIdentity(values, prefix) {
    return {
      chapter_id: values[`${prefix}_chapter_id`],
      volume_id: values[`${prefix}_volume_id`],
      chapter_num: values[`${prefix}_chapter_num`],
    };
  }

  function executeLegacySqliteResolveChapter(identity = {}) {
    const hasChapterId = isProvided(identity.chapter_id);
    const hasVolumeId = isProvided(identity.volume_id);
    const hasChapterNum = isProvided(identity.chapter_num);

    if (hasChapterId) {
      const chapterId = positiveInteger(identity.chapter_id);
      if (!chapterId) return { error: '章节 ID 无效', code: 'INVALID_CHAPTER_IDENTITY' };
      const chapter = pdb.prepare('SELECT * FROM chapters WHERE id = ?').get(chapterId);
      if (!chapter) return { error: `章节 ID ${chapterId} 不存在`, code: 'CHAPTER_NOT_FOUND' };

      if (hasChapterNum) {
        const chapterNum = positiveInteger(identity.chapter_num);
        if (!chapterNum) return { error: '章节编号无效', code: 'INVALID_CHAPTER_IDENTITY' };
        if (chapter.num !== chapterNum) {
          return { error: `章节 ID ${chapterId} 与章节编号 ${chapterNum} 不匹配`, code: 'CHAPTER_IDENTITY_MISMATCH' };
        }
      }
      if (hasVolumeId) {
        const volumeId = positiveInteger(identity.volume_id);
        if (!volumeId) return { error: '卷 ID 无效', code: 'INVALID_CHAPTER_IDENTITY' };
        if (chapter.volume_id !== volumeId) {
          return { error: `章节 ID ${chapterId} 不属于卷 ${volumeId}`, code: 'CHAPTER_IDENTITY_MISMATCH' };
        }
      }
      return { chapter };
    }

    if (!hasChapterNum) {
      return { error: '必须提供 chapter_id 或 chapter_num', code: 'INVALID_CHAPTER_IDENTITY' };
    }
    const chapterNum = positiveInteger(identity.chapter_num);
    if (!chapterNum) return { error: '章节编号无效', code: 'INVALID_CHAPTER_IDENTITY' };

    if (hasVolumeId) {
      const volumeId = positiveInteger(identity.volume_id);
      if (!volumeId) return { error: '卷 ID 无效', code: 'INVALID_CHAPTER_IDENTITY' };
      const chapter = pdb.prepare('SELECT * FROM chapters WHERE volume_id = ? AND num = ?').get(volumeId, chapterNum);
      if (!chapter) return { error: `卷 ${volumeId} 中的章节 ${chapterNum} 不存在`, code: 'CHAPTER_NOT_FOUND' };
      return { chapter };
    }

    const candidates = pdb.prepare('SELECT * FROM chapters WHERE num = ? ORDER BY volume_id, id').all(chapterNum);
    if (candidates.length === 0) return { error: `章节 ${chapterNum} 不存在`, code: 'CHAPTER_NOT_FOUND' };
    if (candidates.length > 1) {
      return {
        error: `多个卷中存在第 ${chapterNum} 章，请提供 chapter_id，或同时提供 volume_id 和 chapter_num`,
        code: 'AMBIGUOUS_CHAPTER',
      };
    }
    return { chapter: candidates[0] };
  }

  switch (toolName) {
    // ── Chapters ──
    case 'list_chapters': {
      const rows = pdb.prepare('SELECT id AS chapter_id, num, title, status, word_count, outline, summary, volume_id, created_at, updated_at FROM chapters ORDER BY volume_id, num').all();
      return rows;
    }
    case 'get_chapter': {
      const resolved = executeLegacySqliteResolveChapter(args);
      if (resolved.error) return resolved;
      return resolved.chapter;
    }
    case 'create_chapter': {
      const created = createChapter({
        projectName,
        source: 'ai_tool',
        fields: {
          volume_id: args.volume_id,
          chapter_num: args.chapter_num,
          title: args.title,
          outline: args.outline,
          content: args.content,
          cognitive_frame: args.cognitive_frame,
          emotional_anchor: args.emotional_anchor,
          world_texture: args.world_texture,
          concrete_mystery: args.concrete_mystery,
          interpersonal_tension: args.interpersonal_tension,
        },
      });
      return {
        created: true,
        chapter_id: created.chapterId,
        volume_id: created.volumeId,
        chapter_num: created.chapterNumber,
        title: args.title,
      };
    }
    case 'update_chapter': {
      const resolved = executeLegacySqliteResolveChapter(args);
      if (resolved.error) return resolved;
      const chapter = resolved.chapter;
      const { chapter_id: _chapterId, chapter_num: _chapterNum, volume_id: _volumeId, ...fields } = args;
      const allowed = ['title', 'content', 'outline', 'status', 'summary', 'cognitive_frame', 'emotional_anchor', 'world_texture', 'concrete_mystery', 'interpersonal_tension'];
      const changedFields = Object.keys(fields).filter((key) => allowed.includes(key));
      if (changedFields.length === 0) return { error: '没有要更新的字段' };

      if (fields.content !== undefined) {
        const patch = {};
        for (const key of allowed) {
          if (key !== 'content' && fields[key] !== undefined) patch[key] = fields[key];
        }
        const updated = writeChapterBody({
          projectName,
          chapterId: chapter.id,
          content: String(fields.content),
          source: 'ai_tool',
          ...patch,
        });
        if (updated.missing) {
          return { error: `章节 ID ${chapter.id} 不存在`, code: 'CHAPTER_NOT_FOUND' };
        }
        return {
          updated: true,
          chapter_id: chapter.id,
          volume_id: chapter.volume_id,
          chapter_num: chapter.num,
          changed_fields: changedFields,
        };
      }

      pdb.transaction(() => {
        const fieldValue = (key) => [fields[key] === undefined ? 0 : 1, fields[key] ?? null];
        pdb.prepare(`UPDATE chapters SET
          title = CASE WHEN ? = 1 THEN ? ELSE title END,
          outline = CASE WHEN ? = 1 THEN ? ELSE outline END,
          status = CASE WHEN ? = 1 THEN ? ELSE status END,
          summary = CASE WHEN ? = 1 THEN ? ELSE summary END,
          cognitive_frame = CASE WHEN ? = 1 THEN ? ELSE cognitive_frame END,
          emotional_anchor = CASE WHEN ? = 1 THEN ? ELSE emotional_anchor END,
          world_texture = CASE WHEN ? = 1 THEN ? ELSE world_texture END,
          concrete_mystery = CASE WHEN ? = 1 THEN ? ELSE concrete_mystery END,
          interpersonal_tension = CASE WHEN ? = 1 THEN ? ELSE interpersonal_tension END,
          updated_at = datetime('now')
          WHERE id = ?`).run(
          ...fieldValue('title'),
          ...fieldValue('outline'),
          ...fieldValue('status'),
          ...fieldValue('summary'),
          ...fieldValue('cognitive_frame'),
          ...fieldValue('emotional_anchor'),
          ...fieldValue('world_texture'),
          ...fieldValue('concrete_mystery'),
          ...fieldValue('interpersonal_tension'),
          chapter.id,
        );
        db.updateProjectWordCount(pdb);
      })();
      return {
        updated: true,
        chapter_id: chapter.id,
        volume_id: chapter.volume_id,
        chapter_num: chapter.num,
        changed_fields: changedFields,
      };
    }
    case 'delete_chapter': {
      const resolved = executeLegacySqliteResolveChapter(args);
      if (resolved.error) return resolved;
      const chapter = resolved.chapter;
      pdb.transaction(() => {
        pdb.prepare('DELETE FROM chapter_revisions WHERE chapter_id = ?').run(chapter.id);
        pdb.prepare('DELETE FROM chapters WHERE id = ?').run(chapter.id);
        db.updateProjectWordCount(pdb);
      })();
      return { deleted: true, chapter_id: chapter.id, volume_id: chapter.volume_id, chapter_num: chapter.num };
    }

    // ── Characters ──
    case 'list_characters': {
      return pdb.prepare('SELECT id, name, age, gender, role, personality, background, motivation, arc, notes FROM characters ORDER BY name').all();
    }
    case 'get_character': {
      const row = pdb.prepare('SELECT * FROM characters WHERE name = ?').get(args.name);
      if (!row) return { error: `角色 "${args.name}" 不存在` };
      // Get chapters this character appears in
      const chapters = pdb.prepare(`
        SELECT c.num, c.title FROM chapter_characters cc
        JOIN chapters c ON cc.chapter_id = c.id
        JOIN characters ch ON cc.character_id = ch.id
        WHERE ch.name = ?
      `).all(args.name);
      return { ...row, appears_in: chapters };
    }
    case 'create_character': {
      const name = normalizeCharacterName(args.name);
      if (!name) return { error: '角色名不能为空' };
      const role = args.role === undefined || args.role === '' ? 'minor' : args.role;
      if (!CHARACTER_ROLES.has(role)) return { error: '角色定位必须是 major（主角）、minor（配角）或 extra（客串）' };
      const id = randomUUID();
      pdb.prepare(`INSERT INTO characters (id, name, age, gender, role, appearance, personality, background, motivation, arc, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, name, args.age || '', args.gender || '', role, args.appearance || '', args.personality || '',
          args.background || '', args.motivation || '', args.arc || '', args.notes || '');
      return { created: true, id, name, role };
    }
    case 'update_character': {
      const { name, ...fields } = args;
      const existing = pdb.prepare('SELECT id FROM characters WHERE name = ?').get(name);
      if (!existing) return { error: `角色 "${name}" 不存在` };
      if (fields.role !== undefined && !CHARACTER_ROLES.has(fields.role)) {
        return { error: '角色定位必须是 major（主角）、minor（配角）或 extra（客串）' };
      }
      const allowed = ['role', 'age', 'gender', 'appearance', 'personality', 'background', 'motivation', 'arc', 'notes'];
      const updates = [];
      const params = [];
      for (const key of allowed) {
        if (fields[key] !== undefined) { updates.push(`${key} = ?`); params.push(fields[key]); }
      }
      if (updates.length === 0) return { error: '没有要更新的字段' };
      updates.push("updated_at = datetime('now')");
      params.push(name);
      pdb.prepare(`UPDATE characters SET ${updates.join(', ')} WHERE name = ?`).run(...params);
      return { updated: true, name };
    }

    // ── World ──
    case 'list_world': {
      return pdb.prepare('SELECT id, category, name, description, tags FROM world_entries ORDER BY category, name')
        .all()
        .map((entry) => ({ ...entry, tags: parseWorldTags(entry.tags) }));
    }
    case 'create_world_entry': {
      if (!isValidWorldEntryCategory(args.category)) return { error: worldEntryCategoryError() };
      const id = randomUUID();
      pdb.prepare('INSERT INTO world_entries (id, category, name, description, tags) VALUES (?, ?, ?, ?, ?)')
        .run(id, args.category, args.name, args.description, serializeWorldTags(args.tags));
      return { created: true, id, category: args.category, name: args.name };
    }

    // ── Foreshadows ──
    case 'list_foreshadows': {
      let sql = 'SELECT * FROM foreshadows';
      const params = [];
      if (args.status) { sql += ' WHERE status = ?'; params.push(args.status); }
      sql += ' ORDER BY created_at';
      return pdb.prepare(sql).all(...params);
    }
    case 'create_foreshadow': {
      const id = randomUUID();
      pdb.prepare(`INSERT INTO foreshadows (id, title, description, status, priority, expected_resolve_chapter)
        VALUES (?, ?, ?, 'planted', ?, ?)`)
        .run(id, args.title, args.description, args.priority || 'normal', args.expected_resolve_chapter || 0);
      return { created: true, id, title: args.title };
    }
    case 'update_foreshadow': {
      const f = pdb.prepare('SELECT id FROM foreshadows WHERE title = ?').get(args.title);
      if (!f) return { error: `伏笔 "${args.title}" 不存在` };
      const updates = [];
      const params = [];
      if (args.status) { updates.push('status = ?'); params.push(args.status); }
      if (args.description) { updates.push('description = ?'); params.push(args.description); }
      if (updates.length === 0) return { error: '没有要更新的字段' };
      updates.push("updated_at = datetime('now')");
      params.push(args.title);
      pdb.prepare(`UPDATE foreshadows SET ${updates.join(', ')} WHERE title = ?`).run(...params);
      return { updated: true, title: args.title };
    }

    // ── Relations ──
    case 'list_relations': {
      return pdb.prepare(`
        SELECT cr.*, ca.name as character_a_name, cb.name as character_b_name
        FROM character_relations cr
        JOIN characters ca ON cr.character_a_id = ca.id
        JOIN characters cb ON cr.character_b_id = cb.id
      `).all();
    }
    case 'create_relation': {
      const a = pdb.prepare('SELECT id FROM characters WHERE name = ?').get(args.character_a);
      const b = pdb.prepare('SELECT id FROM characters WHERE name = ?').get(args.character_b);
      if (!a) return { error: `角色 "${args.character_a}" 不存在，请先创建` };
      if (!b) return { error: `角色 "${args.character_b}" 不存在，请先创建` };
      const id = randomUUID();
      pdb.prepare(`INSERT INTO character_relations (id, character_a_id, character_b_id, relation_type, description, intensity)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, a.id, b.id, args.relation_type, args.description || '', args.intensity || 3);
      return { created: true, id, relation: `${args.character_a} → ${args.character_b}: ${args.relation_type}` };
    }

    // ── Memories ──
    case 'list_memories': {
      return pdb.prepare('SELECT * FROM memories ORDER BY created_at DESC').all();
    }
    case 'create_memory': {
      const sourceIdentity = prefixedChapterIdentity(args, 'source');
      let sourceChapter = null;
      if (hasChapterIdentity(sourceIdentity)) {
        const resolved = executeLegacySqliteResolveChapter(sourceIdentity);
        if (resolved.error) return resolved;
        sourceChapter = resolved.chapter;
      }
      const id = randomUUID();
      pdb.prepare('INSERT INTO memories (id, category, content, source_chapter_id) VALUES (?, ?, ?, ?)')
        .run(id, args.category, args.content, sourceChapter?.id ?? null);
      return {
        created: true,
        id,
        category: args.category,
        source_chapter_id: sourceChapter?.id ?? null,
        source_volume_id: sourceChapter?.volume_id ?? null,
        source_chapter_num: sourceChapter?.num ?? null,
      };
    }

    // ── Timeline ──
    case 'list_timeline': {
      const events = pdb.prepare('SELECT * FROM timeline_events ORDER BY sort_order ASC, created_at ASC, id ASC').all();
      const mode = pdb.prepare("SELECT value FROM project_meta WHERE key = 'timeline_sort_mode'").get()?.value;
      return orderTimelineEvents(events, mode === 'auto' ? 'auto' : 'manual');
    }
    case 'create_timeline_event': {
      const importance = clampTimelineImportance(args.importance === undefined ? 3 : args.importance);
      const maxSortOrder = pdb.prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order FROM timeline_events').get();
      const sortOrder = (maxSortOrder?.max_sort_order ?? 0) + 1;
      const id = randomUUID();
      pdb.prepare('INSERT INTO timeline_events (id, year, title, description, importance, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, args.year, args.title, args.description, importance, sortOrder);
      return { created: true, id, year: args.year, title: args.title };
    }

    // ── Stats ──
    case 'get_stats': {
      const totalWords = pdb.prepare('SELECT SUM(word_count) as total FROM chapters').get().total || 0;
      const chCount = pdb.prepare('SELECT COUNT(*) as cnt FROM chapters').get().cnt;
      const charCount = pdb.prepare('SELECT COUNT(*) as cnt FROM characters').get().cnt;
      const foreshadowCount = pdb.prepare('SELECT COUNT(*) as cnt FROM foreshadows').get().cnt;
      const worldCount = pdb.prepare('SELECT COUNT(*) as cnt FROM world_entries').get().cnt;
      const sciCount = pdb.prepare('SELECT COUNT(*) as cnt FROM science_entries').get().cnt;
      const statusBreakdown = {};
      pdb.prepare('SELECT status, COUNT(*) as cnt FROM chapters GROUP BY status').all()
        .forEach(r => statusBreakdown[r.status] = r.cnt);
      return { totalWords, chapterCount: chCount, characterCount: charCount, foreshadowCount, worldCount, sciCount, chapterStatus: statusBreakdown };
    }

    // ── Volumes ──
    case 'list_volumes': {
      const vols = pdb.prepare('SELECT * FROM volumes ORDER BY sort_order').all();
      for (const v of vols) {
        v.chapters = pdb.prepare('SELECT id AS chapter_id, num, title, status, word_count, outline, summary FROM chapters WHERE volume_id = ? ORDER BY num').all(v.id);
      }
      return vols;
    }
    case 'create_volume': {
      const max = pdb.prepare('SELECT COALESCE(MAX(sort_order), 0) as mx FROM volumes').get();
      const sortOrder = (max?.mx || 0) + 1;
      const result = pdb.prepare("INSERT INTO volumes (sort_order, title, summary, created_at) VALUES (?, ?, ?, datetime('now'))")
        .run(sortOrder, args.title, args.summary || '');
      return { created: true, volume_id: result.lastInsertRowid, title: args.title };
    }
    case 'update_volume': {
      const updates = [];
      const params = [];
      if (args.title !== undefined) { updates.push('title = ?'); params.push(args.title); }
      if (args.summary !== undefined) { updates.push('summary = ?'); params.push(args.summary); }
      if (updates.length === 0) return { error: '没有要更新的字段' };
      params.push(args.volume_id);
      pdb.prepare(`UPDATE volumes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return { updated: true, volume_id: args.volume_id };
    }
    case 'delete_volume': {
      const vol = pdb.prepare('SELECT id FROM volumes WHERE id = ?').get(args.volume_id);
      if (!vol) return { error: `卷 ${args.volume_id} 不存在` };
      pdb.transaction(() => {
        pdb.prepare('DELETE FROM chapters WHERE volume_id = ?').run(args.volume_id);
        pdb.prepare('DELETE FROM volumes WHERE id = ?').run(args.volume_id);
        db.updateProjectWordCount(pdb);
      })();
      return { deleted: true, volume_id: args.volume_id };
    }

    // ── Science ──
    case 'list_science': {
      return pdb.prepare('SELECT * FROM science_entries ORDER BY label, name').all();
    }
    case 'create_science_entry': {
      const id = randomUUID();
      pdb.prepare('INSERT INTO science_entries (id, label, name, description, "references") VALUES (?, ?, ?, ?, ?)')
        .run(id, args.label, args.name, args.description, args.references || '');
      return { created: true, id, label: args.label, name: args.name };
    }

    // ── World update/delete ──
    case 'update_world_entry': {
      if (args.category !== undefined && !isValidWorldEntryCategory(args.category)) {
        return { error: worldEntryCategoryError() };
      }
      const fields = args.tags === undefined ? args : { ...args, tags: serializeWorldTags(args.tags) };
      return executeLegacySqliteUpdateById(args.id, 'world_entries', fields, ['category', 'name', 'description', 'tags'], true);
    }
    case 'delete_world_entry': {
      return executeLegacySqliteDeleteById(args.id, 'world_entries', 'id', '条目');
    }

    // ── Relations update/delete ──
    case 'update_relation': {
      return executeLegacySqliteUpdateById(args.id, 'character_relations', args, ['relation_type', 'description', 'intensity'], false);
    }
    case 'delete_relation': {
      return executeLegacySqliteDeleteById(args.id, 'character_relations', 'id', '关系');
    }

    // ── Memories update/delete ──
    case 'update_memory': {
      return executeLegacySqliteUpdateById(args.id, 'memories', args, ['category', 'content'], false);
    }
    case 'delete_memory': {
      return executeLegacySqliteDeleteById(args.id, 'memories', 'id', '记忆');
    }

    // ── Timeline update/delete ──
    case 'update_timeline_event': {
      const fields = args.importance === undefined
        ? args
        : { ...args, importance: clampTimelineImportance(args.importance) };
      return executeLegacySqliteUpdateById(args.id, 'timeline_events', fields, ['year', 'title', 'description', 'importance'], false);
    }
    case 'delete_timeline_event': {
      return executeLegacySqliteDeleteById(args.id, 'timeline_events', 'id', '事件');
    }

    // ── Science delete ──
    case 'delete_science_entry': {
      return executeLegacySqliteDeleteById(args.id, 'science_entries', 'id', '条目');
    }

    // ── Character delete ──
    case 'delete_character': {
      return executeLegacySqliteDeleteById(args.name, 'characters', 'name', '角色');
    }

    // ── Foreshadow delete ──
    case 'delete_foreshadow': {
      return executeLegacySqliteDeleteById(args.title, 'foreshadows', 'title', '伏笔');
    }

    // ── Chapter Characters ──
    case 'list_chapter_characters': {
      const filters = [];
      const params = [];
      if (hasChapterIdentity(args)) {
        const resolved = executeLegacySqliteResolveChapter(args);
        if (resolved.error) return resolved;
        filters.push('c.id = ?');
        params.push(resolved.chapter.id);
      }
      if (args.character_name) {
        filters.push('ch.name = ?');
        params.push(args.character_name);
      }
      const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
      return pdb.prepare(`
        SELECT cc.chapter_id, c.volume_id, c.num as chapter_num, c.title as chapter_title,
               cc.character_id, ch.name as character_name, cc.role
        FROM chapter_characters cc
        JOIN chapters c ON c.id = cc.chapter_id
        JOIN characters ch ON ch.id = cc.character_id
        ${where}
        ORDER BY c.volume_id, c.num, ch.name`).all(...params);
    }
    case 'set_chapter_character': {
      const resolved = executeLegacySqliteResolveChapter(args);
      if (resolved.error) return resolved;
      const chapter = resolved.chapter;
      const char = pdb.prepare('SELECT id FROM characters WHERE name = ?').get(args.character_name);
      if (!char) return { error: `角色 ${args.character_name} 不存在` };
      const role = args.role || 'appears';
      pdb.prepare('INSERT OR REPLACE INTO chapter_characters (chapter_id, character_id, role) VALUES (?, ?, ?)')
        .run(chapter.id, char.id, role);
      return {
        set: true,
        chapter_id: chapter.id,
        volume_id: chapter.volume_id,
        chapter_num: chapter.num,
        character_name: args.character_name,
        role,
      };
    }
    case 'remove_chapter_character': {
      const resolved = executeLegacySqliteResolveChapter(args);
      if (resolved.error) return resolved;
      const chapter = resolved.chapter;
      const char = pdb.prepare('SELECT id FROM characters WHERE name = ?').get(args.character_name);
      if (!char) return { error: `角色 ${args.character_name} 不存在` };
      const info = pdb.prepare('DELETE FROM chapter_characters WHERE chapter_id = ? AND character_id = ?').run(chapter.id, char.id);
      if (info.changes === 0) return { error: `角色 ${args.character_name} 在章节 ${chapter.num} 中没有出场记录` };
      return {
        deleted: true,
        chapter_id: chapter.id,
        volume_id: chapter.volume_id,
        chapter_num: chapter.num,
        character_name: args.character_name,
      };
    }

    // ── Clue Board ──
    case 'list_clues': {
      let sql = 'SELECT * FROM clue_board ORDER BY resolved, created_at DESC';
      if (args.status === 'unresolved') { sql = 'SELECT * FROM clue_board WHERE resolved = 0 ORDER BY created_at DESC'; }
      if (args.status === 'resolved') { sql = 'SELECT * FROM clue_board WHERE resolved = 1 ORDER BY resolved_at DESC'; }
      return pdb.prepare(sql).all();
    }
    case 'create_clue': {
      const relatedIdentity = prefixedChapterIdentity(args, 'related');
      let relatedChapter = null;
      if (hasChapterIdentity(relatedIdentity)) {
        const resolved = executeLegacySqliteResolveChapter(relatedIdentity);
        if (resolved.error) return resolved;
        relatedChapter = resolved.chapter;
      }
      const id = randomUUID();
      pdb.prepare('INSERT INTO clue_board (id, title, description, kind, related_chapter_id, resolved, created_at) VALUES (?, ?, ?, ?, ?, 0, datetime(\'now\'))')
        .run(id, args.title, args.description || '', args.kind, relatedChapter?.id ?? null);
      return {
        created: true,
        id,
        title: args.title,
        kind: args.kind,
        related_chapter_id: relatedChapter?.id ?? null,
        related_volume_id: relatedChapter?.volume_id ?? null,
        related_chapter_num: relatedChapter?.num ?? null,
      };
    }
    case 'update_clue': {
      const existing = pdb.prepare('SELECT * FROM clue_board WHERE id = ?').get(args.id);
      if (!existing) return { error: `线索 ${args.id} 不存在` };
      const updates = []; const params = [];
      if (args.title !== undefined) { updates.push('title = ?'); params.push(args.title); }
      if (args.description !== undefined) { updates.push('description = ?'); params.push(args.description); }
      if (args.kind !== undefined) { updates.push('kind = ?'); params.push(args.kind); }
      if (args.resolved !== undefined) {
        updates.push('resolved = ?');
        params.push(args.resolved ? 1 : 0);
        updates.push(args.resolved ? "resolved_at = datetime('now')" : 'resolved_at = NULL');
      }
      if (updates.length === 0) return { error: '没有要更新的字段' };
      params.push(args.id);
      pdb.prepare(`UPDATE clue_board SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      return { updated: true, id: args.id };
    }
    case 'delete_clue': {
      return executeLegacySqliteDeleteById(args.id, 'clue_board', 'id', '线索');
    }

    // ── Project Meta ──
    case 'get_project_meta': {
      const meta = {};
      pdb.prepare('SELECT key, value FROM project_meta').all().forEach(m => meta[m.key] = m.value);
      const genres = pdb.prepare('SELECT genre FROM project_genres').all().map(g => g.genre);
      const genreLabels = { 'sci-fi': '科幻', 'fantasy': '玄幻', 'romance': '言情', 'history': '历史', 'urban': '都市', 'power-fantasy': '爽文', 'biography': '传记', 'other': '其他' };
      return {
        name: meta.name || '',
        genres: genres,
        genreLabels: genres.map(g => genreLabels[g] || g),
        mode: meta.mode || 'medium-novel',
        language: meta.language || 'zh',
        phase: meta.workflow_phase || 'idea',
        phaseLabel: ({idea:'选题',setting:'设定',outline:'大纲',writing:'写作',review:'审阅',consistency:'一致性',export:'导出'})[meta.workflow_phase] || '选题',
        wordCount: meta.word_count || 0,
        authorName: meta.author_name || '',
        description: meta.description || '',
      };
    }

    // ── Project Phase ──
    case 'update_project_phase': {
      const validPhases = ['idea', 'setting', 'outline', 'writing', 'review', 'consistency', 'export'];
      if (!validPhases.includes(args.phase)) {
        return { error: `无效阶段: ${args.phase}，有效值: ${validPhases.join('、')}` };
      }
      pdb.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('workflow_phase', ?)").run(args.phase);
      return { updated: true, phase: args.phase };
    }

    default:
      return { error: `未知工具: ${toolName}` };
  }
}

module.exports = { TOOLS, executeTool };
