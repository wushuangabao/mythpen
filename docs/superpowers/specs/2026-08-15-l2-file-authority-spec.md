# L2 文件权威层规格（第 2.9 版）

日期：2026-08-15

状态：第 2.9 版修订稿。第 17 节产品开放项已清零；第 2.9 版已修正独立复验发现的一个 P1 与一个 P2，但修订后的最终字节尚未完成哈希绑定的再次独立复验。在该定稿门闭合前，本文尚不具备据此编写或启动分阶段实施计划的定稿状态。

修订历史：[第 2 版至第 2.9 版修订、评审与证据记录](./2026-08-15-l2-file-authority-revision-history.md)

上游范围：`2026-08-06-manuscript-durability-and-versioning-v1-scope.md` 第 5 节

L1 基线：`2026-08-10-l1-durability-completion-design.md`

长期目标参考：`2026-08-05-git-manuscript-versioning-design.md` 第 4、5.1–5.3、6、9–11 节

## 1. 文档定位

本文只定义 L2「文件权威层」的产品与技术契约，不是实施计划，也不启动 L3 Git 版本管理或 L4 AI 耐久化。

L2 解决一个独立问题：目前章节正文、章节元数据和卷结构仍只能以 SQLite 为真值，用户无法直接在磁盘上安全编辑 Markdown，也无法在不依赖数据库二进制的情况下检查稿件。

L2 完成后：

- Markdown、章节 sidecar 和卷结构索引是文章域的唯一权威来源；
- SQLite 保留为本机耐久投影和非文章业务数据库，不再拥有文章真值；
- 用户可以用外部编辑器修改章节 `.md`，应用能够检测、验证并刷新投影；
- 任意**被检测到的**受控文件变化都必须被刷新、拒绝或进入冲突状态，绝不允许忽略后继续返回旧投影；未被检测的窗口有第 9.1 节给出的有界声明；
- 项目仍然没有 Git 历史、checkpoint、历史浏览或版本恢复能力；
- 任何迁移后的项目都不得同时把 SQLite 与文件视为可写真值源。

### 1.1 对 L1 的前置门禁

L2 的投影层直接建立在 L1 的原生耐久实现之上。按 L1 收尾设计第 20 节的自述，该实现目前尚未接入生产：`server/db.js` 的 `PROJECT_SCHEMA_VERSION` 仍是 10，schema 11 只由 native 激活路径安装，而 `createNativeProjectStore()` 在生产 module graph 里是返回 `NATIVE_ACTIVATION_DISABLED` 的 stub。

因此以下五条是 L2 的**技术前置门禁**，全部满足后 L2 方可开工：

| 前置门禁 | L2 为何需要 | 当前状态 |
|---|---|---|
| 生产 `db.js` 到 schema 11，native activation = production | schema 12 的 canonical trigger 继承与三方 digest 校验建立在 11 之上 | 未满足 |
| NativeProjectStore 接入生产 open/write 路径 | 第 8.3 节的投影发布依赖它 | 未满足 |
| native transaction p95 达标 | L2 在每次写入之上叠加文件发布，数据库侧超预算则无余量 | 未满足（既有重跑仍超 500/300 ms） |
| 旧版本 DML 负控（v0.0.7–0.0.9 全部拒绝） | 真实用户项目升到 schema 11 后这是数据安全属性 | `DEFERRED` |
| Windows 崩溃矩阵硬重置证据 | 第 15.3 节的 L2 故障注入建立其上 | `DEFERRED` |

以下两条**不是** L2 的前置门禁，属于 L1 发布门禁，与 L2 的发布合并执行：

- Linux 与 macOS 平台证据（Mythpen 先发 Windows，macOS 本就是 capability=false）；
- installer、tag 与 native 版本发布。

这一拆分不改变上游范围 D4 的分层纪律，只是把「完成」定义为技术意义上的完成而非发布意义上的完成。L1 收尾设计第 19 节应按同样的两级重排；该文档第 20 节已经在事实层面把 installer/tag/release 标为「不阻塞 Stage B/C」，本节只是把它写进完成定义。

## 2. 已固定决策

### D1｜L2 不依赖 Git

L2 不探测 Git，不执行 `git init`，不创建 commit，也不读写 `.git`。

权威文件直接落在未来 L3 仓库的最终目录，L3 只能在该目录原地启用版本管理，不能再次搬迁文章文件。

### D2｜权威文章根使用稳定项目 UID，但 L2 不搬迁 L1 资产

每个项目分配不可变、由服务端 CSPRNG 生成的规范 UUIDv4 `project_uid`；具体分配、冻结和碰撞处理见第 12.6 节。

文章根固定为：

```text
<data>/manuscripts/<project_uid>/
```

项目显示名、REST 路由名和文件标题不得参与任何文章路径推导。

`project_uid` 不等于本机 `project_instance_id`，前者标识文章项目，后者标识当前本机实例并继续用于拒绝陈旧请求。

L2 不引入 `project_storage_key` 资产搬迁，也不移动现有数据库、ControlStore、封面、导出或恢复资产。

现有数据库和 ControlStore 继续使用 L1 已验证并登记的规范物理路径和控制身份，文章根及其恢复资产使用 `project_uid + project_instance_id + journal_id` 在既有受管根内定位。

任何数据库、ControlStore、封面或数据根搬迁都必须另有独立的 relocation journal 和评审，不得作为 L2 迁移的隐含副作用。

`recent_projects` 和第 12.1 节的路由缓存索引都只是可重建的本机索引，不得成为项目身份、路由冻结或物理绑定的真值源。

### D3｜文件是文章域单一真值源

迁移完成后，以下内容只由权威文件拥有：

- 卷的 UID、顺序、标题和摘要；
- 章节 UID、卷归属、结构顺序、标题、大纲、长期状态、摘要和五个叙事维度；
- 章节 Markdown 正文。

以下内容继续只由本机 SQLite 拥有：

- `chapters.id`、`volumes.id` 等本机整数 ID；
- `chapters.num` 章节显示编号；
- `word_count`、正文/sidecar 哈希、文件快照和 projection generation；
- `data_version`、时间戳、AI 提案及其他本机操作状态；
- 项目显示信息、角色、世界观、时间线、聊天、统计和界面状态。

`chapters.content` 继续存在，但它是与同一 projection generation 一起发布的 Markdown 派生缓存。

对合法 UTF-8 文件，`chapters.content` 重新编码为 UTF-8 后必须逐字节等于对应 `.md` raw bytes。正文含 `U+0000` 时该等价无法在 TEXT 列上成立，此类文件按第 4.5 节拒绝写入并按只读透传处理。

`chapters.content` 不得被当作文章真值、外部变化判定来源或正常路径下重建 `.md` 的来源。

禁止「先写 SQLite，再异步导出 Markdown」或「文件写失败时回退写 SQLite」。

文章写入必须先形成权威文件 after，再发布匹配的 SQLite 投影。

### D4｜不实现 legacy 双控制面

旧项目在用户明确确认迁移前继续使用现有 L1 SQLite 路径；选择「稍后升级」不创建 MigrationJournal、不分配 UID、不修改路由，也不产生任何文件或数据库候选副作用。

一旦路由已从 `sqlite` 原子切换为 `migrating`，普通读写立即暂停，只能由同一个项目 writer lease 下的迁移或恢复流程推进。

在 L2 尚未达到第 16.1 节的 `DEFAULT_READY` 前，普通新项目继续创建为 L1 `sqlite`，既有项目不主动弹出默认迁移；只有测试环境或用户显式启用的实验入口可以创建或迁移 `files` 项目。实验入口不改变路由协议、耐久门禁或错误处理，只改变功能是否可达。

迁移完成后只存在文件权威形态，不创建 `LegacyControlStore`、legacy lease key 或 legacy 归档 journal。

### D5｜三处格式简化不可回退

- `manuscript.json` 不保存 `unassigned_chapter_uids`，未分卷顺序只由 `unassigned.json` 承载；
- `chapter_number` 不进入任何权威文件，它只保留在本机投影，且不得用于推导结构顺序或跨设备身份；
- **卷归属只由结构索引的 `chapter_uids` 承载**，既不编码进章节文件路径，也不写进章节 sidecar。

第三条是第 2 版新增。它把「一个章节属于哪个卷」从三份真值（目录路径、sidecar 字段、索引成员）收敛为一份，使移动章节退化为纯索引编辑，同时消除删卷时的目录移除失败面。

### D6｜受控树内的对象分四类，只有两类会阻断

受控树内的每个文件系统对象按第 5.1 节的形状白名单精确分类。分类谓词按角色区分，不能对全部形状套用同一条「必须被引用」的规则：

**一类｜受控文件。** 形状规范，且满足其角色对应的引用规则：

| 角色 | 引用规则 |
|---|---|
| `manuscript.json` | 结构根。存在性由格式本身要求，不被任何东西引用 |
| `unassigned.json` | 结构根。同上 |
| `volumes/vol_<uid>.json` | 必须恰好被 `manuscript.json.volume_uids` 引用一次 |
| `chapters/ch_<uid>.md` 与 `.json` | 资源对必须整体恰好被一个卷索引或 `unassigned.json` 引用一次 |

两个结构根缺失时是 `MANUSCRIPT_FILESET_INVALID`，不是孤儿。

**二类｜孤儿资源。** 形状规范的卷索引或章节资源对，但没有任何结构索引引用它。阻断普通读写并返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED`。必须同时提供第 5.1.2 节的出口，不得只给错误码。

**三类｜journal 候选。** 形状为 `<规范文件名>.<journal_id>.tmp`，**且 `journal_id` 能在 ControlStore 中对应到一条真实 journal 记录**。分两种：

- 该 journal 未终结：候选归它拥有，只能由它写入、验证、替换或清理；
- 该 journal 已终结：其终态事件即所有权与可弃性的证据，由恢复流程凭该证据删除。

它不参与投影，也不适用第四类的「不删除」约束。

形状匹配但 `journal_id` 对不上任何 journal 记录的文件**不是**三类，降为四类残留，永不删除，只记诊断。此前的措辞是「无主候选（journal 已终结或不存在）由恢复流程按 journal 证据删除」，但 journal 不存在时恰恰没有任何证据，那条分支等于授权无证据删除外部工具、旧构建或用户手工放置的同形状文件。所有权证据缺失时唯一安全的动作是不动它。

**四类｜非受控残留。** 其余一切文件系统对象。不读、不修改、不删除，记入诊断包并在 UI 上提示，**不阻断**普通读写。

**外部创建的判定与上述分类无关。** 权威文件中出现的 `chapter_uid` 或 `volume_uid`，若在当前投影里既没有活跃行也没有 tombstone 行，就是外部创建，返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED` 并阻断普通读写，**无论它是否已被结构索引正确引用**。

这一条必须独立于孤儿判定，否则外部只要同时补齐两个资源文件并把 UID 写进索引，就会变成合法的一类受控文件被直接投影成新章节，绕过整条限制。限制的理由是本机整数 ID 与 `chapters.num` 的分配授权无法从文件中安全推导，而这一点不因用户顺手改了索引而改变。判据取「活跃行或 tombstone 行」而非只取活跃行，是为了让第 7.2 节的同 UID 复活保持合法。

外部只修改已有章节 `.md` 是 L2 必须自动接受的合法输入。应用不得要求外部编辑器同步修改 sidecar，也不得为了补充哈希或格式化而反写外部正文。

外部修改 sidecar、卷索引、未分卷索引或总清单时，应用必须校验索引引用闭包。对既有 UID 的完整且合法的元数据、移动、重排或删除变化，应用按文件真值刷新投影。

索引引用了但资源缺失、只有 `.md` 没有 `.json`、或者反过来，一律是 `MANUSCRIPT_FILESET_INVALID` 并阻断；这些是真正不安全的现场，不得解释为删除。

第四类的存在是本版的关键让步。外部编辑器和操作系统会在受控目录内稳定制造 `ch_<uid>.md~`、`.ch_<uid>.md.swp`、`ch_<uid>.md.bak`、`desktop.ini`、`Thumbs.db`、云盘冲突副本和「ch_<uid> - 副本.md」；emacs 打开文件时还会创建名为 `.#ch_<uid>.md` 的符号链接。若这些都阻断读写，L2 的核心交付目标就不成立。第 5 节对 `mythpen/` 之外兄弟项已经采取同一立场：L2 只对它认识的形状负责。

但「形状不符即无害」有一个例外，见第 5.1 节的大小写折叠规则：在大小写不敏感的文件系统上，实名与规范名只差大小写的文件不是无害残留，而是同一个文件的别名。

### D7｜路由真值在项目数据库，缓存索引可重建

文章存储路由状态的唯一真值是项目 SQLite `project_meta` 的保留键 `manuscript_route`，键缺失即视为 `sqlite`。

config.db 只保存一份可重建的路由缓存索引，用于项目列表快速渲染；它与真值不一致时以项目数据库为准并重建缓存。

不采用 config.db 建路由表：它至今跑在 sql.js 全库导出加原子替换上（L1 D1 明确决定不重写 config.db），是系统内耐久性最弱的组件，把路由真值放在那里会让单点损坏导致「分不清哪个项目是 SQLite 权威、哪个是文件权威」，正是双主风险本身。

不采用项目 ControlStore 事件作为路由真值：耐久性最好，但 bounded ControlStore 的 checkpoint 会 GC 覆盖历史事件，路由状态必须进入 checkpoint 的 clean basis 摘要，而 L1 收尾设计第 8.2 节把 checkpoint 的 top-level key order 明确冻结，加字段需要把 `controlProtocolEpoch` 提到 3 并写显式迁移。该成本不必由 L2 承担。

放进 `project_meta` 的三个直接后果：

- 路由 CAS 是 native 事务内的一次条件 UPDATE，L1 的 prepared/committed 协议已经证明它唯一收敛到 before 或 after，无需为路由另造原子性论证；
- 第 12.2 节的最终激活不再是「发布投影」加「切换路由」两个需要对齐的 CAS，而是同一个数据库 candidate 的一次原子发布，双主窗口不是被消除的，是根本不存在的；
- `migration_reserved` 仍留在项目 ControlStore，路由留在 `project_meta`，两者按第 12.1 节联合检查。

## 3. 范围

### 3.1 范围内

- 权威目录与文件格式、解析、稳定序列化和安全路径验证；
- `project_uid` 的稳定项目绑定和文章根定位；
- `chapter_uid`、`volume_uid`、tombstone、position 和伏笔位置的 DDL 迁移；
- schema 12 对 L1 native downgrade guard、canonical trigger generator 和三方 digest 校验的继承；
- `project_meta` 路由保留键与 config.db 路由缓存索引；
- `ManuscriptStore`、`FilePublicationJournal`、`SQLiteProjectionStore`；
- 受控树直接变化 feed、`manuscriptChangeNotification` 平台能力与降级新鲜度模式；
- `ensureProjectionCurrent()`、`ensureReadableProjection()`、`ActiveManuscriptProjection`；
- ManuscriptService 对正文、章节元数据、章节/卷结构写入的统一收口；
- 外部文件变化检测、投影刷新和本地草稿冲突处理；
- 孤儿资源与外部创建 UID 的用户确认忽略名单动作；
- 数据根位于云同步目录时的检测与引导；
- 应用内引导式旧项目迁移、迁移恢复和迁移前备份；
- L2 引入状态的诊断包、用户可见提示与安全恢复操作；
- 从章节直达文件的「在资源管理器中显示 / 用外部编辑器打开」入口；
- 对现有 REST、桌面、导出、统计和 AI 只读上下文的活跃投影改造；
- files 项目的非破坏性 retired/重新激活流程。

### 3.2 明确不做

- Git 初始化、checkpoint、历史、diff、恢复、分支、远端同步；
- 项目资产搬迁、归档目录、归档恢复或永久清除；
- 数据根搬迁或重新绑定已迁移项目；
- L4 的 AI interaction/turn/invocation、capability、write handle 耐久化；
- 角色、世界观、时间线、聊天等非文章数据文件化；
- 任意 Markdown 的可视化编辑或字节级往返保证；
- 外部创建新章节/卷所需的自动身份与章节编号分配；
- 自动合并本地草稿与外部内容；
- 为补偿拍平布局而生成带编号和标题的镜像目录——那等于把第二真值源请回来；
- files 项目的物理删除和 tombstone 的永久清除。

## 4. 权威目录与文件格式

L2 不创建 `.git`。

目录保留未来 L3 可直接原地初始化的布局：

```text
<data>/manuscripts/<project_uid>/
  mythpen/
    manuscript.json
    unassigned.json
    volumes/
      vol_<volume_uid>.json
    chapters/
      ch_<chapter_uid>.md
      ch_<chapter_uid>.json
```

卷不是目录，只是 `volumes/` 下的一个索引文件；章节资源全部平铺在 `chapters/` 下。受控树因此固定为三个目录、五种文件形状。

拍平的四个直接后果：

- 移动章节的最小闭包恰好是源索引与目标索引两个文件，`manuscript.json` 不变，正文与 sidecar 一个字节都不动；
- 建卷与删卷不涉及 `mkdir` / `rmdir`，删卷不再有「正文已搬完但目录移除失败」这个中段失败点；
- Linux 的 inotify 不支持递归，需按目录注册；固定三个目录使 watcher 实现从「每卷一个 watch、建删卷时动态增减」变为常量级；
- 单个 `.md` 的绝对路径长度约减少 50 字符，为用户自定义的深数据根留出 Windows `MAX_PATH` 余量。

代价是文件系统侧失去可导航性：3,000 章项目就是一个装着 6,000 个 `ch_<uuid>.md` 的目录。因此从章节直达文件的宿主入口是 L2 的必交付项，不是可选 UI，见第 3.1 节。

### 4.1 `manuscript.json`

规范对象：

```json
{
  "format_version": 1,
  "project_uid": "uuid",
  "volume_uids": ["uuid"]
}
```

`volume_uids` 是卷顺序的唯一权威，未分卷章节不得在此重复列出。

### 4.2 卷索引 `volumes/vol_<volume_uid>.json`

规范对象：

```json
{
  "format_version": 1,
  "volume_uid": "uuid",
  "title": "卷标题",
  "summary": "卷摘要",
  "chapter_uids": ["uuid"]
}
```

`chapter_uids` 是该卷内章节顺序与卷归属的唯一权威，章节标题、状态和叙事字段不得在卷索引中重复。

### 4.3 `unassigned.json`

规范对象：

```json
{
  "format_version": 1,
  "kind": "unassigned",
  "chapter_uids": ["uuid"]
}
```

该文件**始终存在**，没有未分卷章节时 `chapter_uids` 为空数组。不采用「缺失等价于空」，以消除缺失与为空的歧义。

未分卷集合不是 SQLite 中的一条伪造卷记录。

### 4.4 章节 sidecar `chapters/ch_<chapter_uid>.json`

规范对象：

```json
{
  "format_version": 1,
  "chapter_uid": "uuid",
  "title": "章节标题",
  "outline": "章节大纲",
  "status": "pending",
  "summary": "章节摘要",
  "cognitive_frame": "",
  "emotional_anchor": "",
  "world_texture": "",
  "concrete_mystery": "",
  "interpersonal_tension": ""
}
```

`status` 只允许 `pending | writing | review | accepted`。

sidecar 不保存 `volume_uid`（见 D5 第三条）、`chapter_number`、正文哈希、字数、本机整数 ID、时间戳、`data_version` 或 AI 提案状态。

### 4.5 章节 Markdown `chapters/ch_<chapter_uid>.md`

只保存正文原始字节。

Mythpen 自己写入时使用 UTF-8 无 BOM、LF。

读取外部内容时先按原始字节计算 SHA-256，再验证 UTF-8，不因读取而规范化内容。

正文含 `U+0000` 时无法与 SQLite TEXT 列建立 D3 要求的逐字节等价：该章节按只读透传处理，语义性整篇正文写入返回 `UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE`，投影中的 `chapters.content` 置空并标记为不可用，但文件本身仍是合法受控文件。

### 4.6 通用编码与模式规则

- 四种 JSON 文件都必须带 `format_version`，且都是对象的第一个键；
- JSON 使用 UTF-8 无 BOM、LF、两空格缩进、文件末尾单个换行和本文给出的稳定键顺序；
- 文件名 UID 必须等于文件内 UID；引用规则按 D6 一类表格逐角色适用，两个结构根不需要被引用；
- UUID 使用规范小写连字符形式；磁盘实名必须与规范推导名逐字节相同，仅大小写不同也是硬失败（见 5.1.1）；
- 未知字段、重复 UID、重复索引成员、被多个索引引用、缺失成员和非法状态一律拒绝；
- JSON 字符串不得包含非法 Unicode，解析后再序列化必须得到唯一规范字节；
- `word_count` 等派生字段只进入 SQLite 投影，不得回写权威文件。

`format_version` 高于当前构建支持上限时，返回 `MANUSCRIPT_FORMAT_TOO_NEW` 并零修改，让用户看到「需要更新版本」而不是「文件集损坏」。这与 L1 对 `PROJECT_SCHEMA_TOO_NEW` 的处理是同一原则；第 1 版只有 `manuscript.json` 带版本号且未知字段一律拒绝，等于让任何格式演进都表现为数据损坏。

## 5. 路径和文件系统安全

所有受控路径必须由已经校验的 `project_uid`、`volume_uid` 和 `chapter_uid` 推导，调用方不能传入相对路径、文件名、glob 或目录映射。

L2 的受控树边界仅为文章根下的 `mythpen/`。

### 5.1 形状白名单

受控树内只有以下五种精确形状构成受控文件形状，`<uuid>` 必须是规范小写连字符 UUID：

```text
mythpen/manuscript.json
mythpen/unassigned.json
mythpen/volumes/vol_<uuid>.json
mythpen/chapters/ch_<uuid>.md
mythpen/chapters/ch_<uuid>.json
```

另有一种合法但不属于权威内容的形状，即 journal 候选：

```text
<上述任一规范相对路径>.<journal_id>.tmp
```

按 D6 分类：规范形状且满足角色引用规则的是一类；规范形状的卷索引或章节资源对无索引引用的是二类孤儿；journal 候选是三类；其余一切是四类非受控残留。

四类对象不读、不修改、不删除，也不参与任何哈希、快照或校验；直接 feed 事件必须先按形状过滤再进入第 9 节的脏路径集合，否则四类对象的变动会白白触发刷新。它们只出现在诊断包和 UI 提示里。

### 5.1.1 大小写折叠与实名比较

Windows 与 macOS 默认使用大小写不敏感的文件系统，`ch_ABC.md` 与 `ch_abc.md` 在那里是**同一个文件**。因此不能仅凭磁盘实名不是规范小写就把它归入无害残留：那会导致同一个文件既被枚举判成四类「不读不写不删」，又被规范路径成功打开、写入和替换，两种处理同时作用于同一份字节，并且规范路径会写穿到用户重命名过的文件里。

规则固定为：

- 枚举受控目录时，必须把操作系统返回的**实际文件名**与由已校验 UID 推导的规范名做逐字节比较；
- 不一致（包括仅大小写不同、包含 Unicode 兼容等价形式、或带有尾随空格与点）时返回 `MANUSCRIPT_FILESET_INVALID` 硬失败，不得降级为四类残留；
- 完全校验必须额外验证：受控树内不存在大小写折叠后重复的路径或 UID；
- 该检查在大小写敏感与不敏感的文件系统上都执行，行为一致，不按平台分支。

第 1 版第 5 节原有「大小写折叠后不存在重复路径或 UID」一条，第 2 版重写时误删；本节恢复并加强为逐字节实名比较。

### 5.1.2 孤儿与外部创建的出口

孤儿资源与外部创建的 UID 都阻断读写并返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED`。出口是**就地标记**，不移动任何文件。

UI 提供用户确认动作，把该 UID 写入项目数据库的持久忽略名单。此后完全校验跳过对应资源文件的 UTF-8、JSON 模式和业务语义解析，并跳过指向它的索引引用语义，但仍必须枚举其规范形状文件、校验实名与普通文件身份、读取文件大小并纳入第 16.2 节的 UID 数量、文件数量、单文件大小和原始字节总量；被忽略的 UID 不参与 position 派生，项目在全部容量门禁仍满足时恢复正常读写。

忽略名单存放在 SQLite 的独立表中，随投影一起发布，具备与其他投影字段相同的事务性；它不进入任何权威文件。该表的 `ignore_status` 至少区分 `active` 与 `revoked`：只有 `active` 跳过语义解析和保留不透明引用，用户撤销忽略只把记录转为 `revoked`，不能物理删除 UID；对应文件仍存在时，下一次 gate 会重新按外部创建阻断。每个 `active` 记录还必须保存该 UID 的规范成员集合、逐成员存在性、最后验证大小与普通文件身份，并纳入同 generation 的项目容量快照；被忽略的 UID 再次出现在结构索引中不会自动恢复，必须由用户显式撤销忽略；`active` 或 `revoked` 记录及对应文件被删除都不释放该项目已经消耗的生命周期 UID 容量。

active ignored UID 的增量事件不能走无条件跳过。对应任一路径出现 dirty、创建、删除、改名或替换时，`ensureProjectionCurrent()` 必须在 writer lease 与 refresh claim 下重新枚举该 UID 的全部规范成员，验证实名、非 reparse、链接计数、普通文件身份和单文件大小，以旧容量快照为 before 计算文件数与字节增量，并把新成员状态与项目容量快照作为同一 projection generation 发布；无法证明 before、事件语义含糊或 capacity snapshot 不完整时锁存全脏并完全校验。超过上限时保留外部现场和 dirty evidence，返回 `MANUSCRIPT_CONTENT_TOO_LARGE`，不得因内容语义被忽略而继续报告 clean。

当前引用状态至少区分 `indexed` 与 `detached`：`indexed` 必须带当前容器种类及规范身份，并与权威索引中的唯一引用吻合；`detached` 的当前容器为空，适用于原本就是孤儿或经用户显式解除引用的 UID。序列化器只为 `indexed` 条目保留不透明成员，删除容器的保护检查也只按 `indexed` 条目的当前容器判定。

**被忽略但已被索引引用的 UID，其索引成员身份必须在后续所有索引重写中原样保留。** 序列化器把它当作不透明成员写回当前容器，固定追加到该容器 `chapter_uids` 或 `volume_uids` 的末尾；同一容器内多个被忽略成员按 UID 的 UTF-8 字节序稳定排序。因此忽略名单必须记录 UID、当前不透明引用容器和当前引用状态，而不只是 UID 本身。

这一条不可省略：投影里没有被忽略 UID 的行，如果序列化器只从投影重建索引，用户在该容器里做一次普通重排就会把自己亲手写进权威索引的条目无声抹掉，撤销忽略后它还会从「已索引条目」退化成「孤儿」，状态比忽略之前更差。应用可以拒绝解释一份内容，但不能销毁它。

代价是相对位置不保留。固定追加到容器末尾是唯一在任意重排、移动和删除下都稳定的规则，UI 在撤销忽略时必须说明这一点。

这里的「删除」只指删除同一容器内的其他已知章节，**不包括删除原容器本身**。如果一个卷索引仍承载被忽略章节的不透明引用，删除该卷会连同索引一起抹掉唯一引用，因此必须在任何文件副作用前返回 `IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE`。

UI 必须提供两个显式处理动作，二者都取得项目 writer lease，经 FilePublicationJournal 把索引文件 after 与同一目标 generation 的忽略名单 after 作为一个普通写入协议发布。journal 必须绑定忽略条目的 before/after、全部索引成员的 raw SHA-256 CAS 和目标 projection generation，崩溃后按第 10.3 节收敛，不能只提交文件侧或只提交忽略名单侧：

- 「保留并转为未分卷」把不透明章节 UID 从原卷索引移到 `unassigned.json` 末尾，同时把忽略名单中的当前不透明引用容器更新为 `unassigned`，不改动章节资源文件；
- 「解除索引引用」只从原索引删除该 UID，把忽略条目的当前引用状态改为 `detached` 并清空当前容器，章节资源对保留原位并继续由忽略名单保护，成为已忽略孤儿。

「保留并转为未分卷」的文件闭包恰好是原卷索引与 `unassigned.json`，CAS 同时覆盖两者；「解除索引引用」的文件闭包恰好是原卷索引。上述动作成功前不得删除原卷；任一 CAS 失败时整个动作 stale，不得提交本动作的文件 after 或忽略条目 after，并要求重新确认。被忽略的卷 UID 的原容器是不可删除的 `manuscript.json`，因此不存在同类容器删除分支。

不采用「移动到隔离目录」：那是一次跨目录的多文件移动，正是第 10.1 节以协议不支持为由排除的操作，崩溃在两个成员之间会留下半套资源，要做就得为它单独引入一个 journal 和一套恢复规则。就地标记是一次普通的数据库写入，零文件副作用，也更符合「不得自动删除或移动用户文件」这一原则。用户想清理时自行删除文件即可，删除后残留的忽略条目无害。

文章根下 `mythpen/` 以外的兄弟项不属于 L2 文件格式，L2 不读取、不修改、不删除，也不因其存在而拒绝项目。

未来 L3 可以在文章根创建 `.git`、`.gitattributes` 和 `.gitignore`，但不能改变 `mythpen/` 的 L2 校验规则。

### 5.2 每次完整校验和每次写入必须验证

- 文章根与项目绑定中的规范真实路径和物理身份一致；
- 文章根、`mythpen/` 及三个受控目录不是 symlink、junction 或 reparse point；
- 受控普通文件不是 symlink，且**链接计数必须为 1**；
- 按第 5.1.1 节完成实名逐字节比较，且受控树内不存在大小写折叠后重复的路径或 UID；
- 全部三类 journal 候选都能对应到真实 journal 记录，已终结 journal 的候选已凭其终态证据清理；对不上任何 journal 记录的同形状文件按四类保留不动；
- 不跟随未知文件、未知目录或越出文章根的文件系统对象。

链接计数这一条是第 2 版的措辞修正。第 1 版写的是「不得通过硬链接与受控树外文件共享身份」，而从一个文件无法查到它的其它链接指向何处，能查的只有链接计数，原措辞不可实现。

发现路径不安全时返回 `MANUSCRIPT_PATH_UNSAFE`，不得扫描树外内容、创建候选或修改 SQLite。

### 5.3 云同步目录的检测与引导

数据根可由用户通过 `MYTHPEN_DATA_DIR` 或配置指定，把小说放进 OneDrive、iCloud 或同类同步目录是这类用户的典型行为。而云盘的 reparse point、占位文件和按需下载会同时命中 5.2 的路径拒绝和第 9 节直接 feed 的支持包络之外。

因此：在**创建项目、迁移项目和设置数据根**这三个入口，必须检测目标是否位于云同步目录或 reparse point 之下，并给出明确说明与可选的替代位置，而不是等到运行时抛 `MANUSCRIPT_PATH_UNSAFE`。这兑现上游范围第 8 节「需要明确检测与引导，而不是一个错误码」的要求。

## 6. Markdown 支持等级

### 6.1 可视编辑方言

可视编辑器承诺支持普通段落、一级/二级标题、粗体、斜体、下划线、行内代码、三反引号围栏代码块和 `---` 分隔线。

### 6.2 只读透传 Markdown

UTF-8 正文包含上述方言之外的构造时：

- 文件仍然有效，列表、只读查看、复制、导出和未来 diff 可以保留原始字节；
- 可视编辑器进入只读模式；
- AI 续写、提案应用和其他语义性整篇正文写入返回 `UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE`；
- 章节元数据写入仍可继续，但不得重新序列化 `.md`；
- 普通写入不得借格式化、保存或迁移把它转换为可视编辑方言。

## 7. 稳定身份、tombstone 与顺序

### 7.1 SQLite 投影字段与 L1 降级屏障

L2 投影 schema 在 L1 原生耐久 schema 11 之后使用 schema 12。

实施前若 L1 最终生产 schema 号发生变化，只允许顺延，不能复用已有版本号。

至少增加：

- `volumes.volume_uid TEXT UNIQUE NOT NULL`；
- `volumes.is_present`、`volumes.deleted_at`；
- `chapters.chapter_uid TEXT UNIQUE NOT NULL`；
- `chapters.is_present`、`chapters.deleted_at`；
- `chapters.chapter_position`、`chapters.manuscript_position`；
- `chapters.content` 派生缓存及正文/sidecar raw SHA-256；
- `foreshadows.expected_resolve_manuscript_position`；
- 孤儿与外部创建 UID 的持久忽略名单/身份账本表（见 5.1.2），至少记录 UID、`ignore_status = active | revoked`、当前不透明引用容器、当前引用状态，以及 active 记录的规范成员存在性、逐文件大小与最后验证普通文件身份，记录不得物理删除并随投影和项目容量快照一起发布；
- 受控文件快照和当前 projection generation。

`project_meta` 增加以下保留键：

| key | 语义 |
|---|---|
| `manuscript_route` | `sqlite` / `migrating` / `files` / `retired`，键缺失即视为 `sqlite` |
| `manuscript_project_uid` | 该项目的 `project_uid`，`files` 与 `migrating` 下非空 |
| `manuscript_route_journal` | `migrating` 下绑定的 MigrationJournal ID 与摘要 |
| `manuscript_projection_generation` | 当前投影对应的权威文件 generation |

这四个键沿用 L1 对 durability 保留键的同一套规则：只有持有内部文章 capability 的精确语句可以修改，普通 `projectExecute`、业务 SQL、AI 工具和业务 migration 一律不得插入、更新或删除它们。任一键缺失、重复或格式非法时按第 12.1 节的联合检查处理。

现有 `chapters.id`、`volumes.id`、所有业务行和 `sqlite_sequence` 必须逐行保留。

schema 12 必须继承 L1 的 native downgrade guard 和 fail-closed 上界检查：

- schema 12 的全部应用可写表只能来自同一个 production canonical trigger generator；
- 新增或重建的可写表必须在同一 schema 事务中安装 canonical INSERT/UPDATE/DELETE downgrade triggers；
- trigger 集变化时必须提升 `durability_trigger_version` 并重算 `durability_trigger_set_digest`；
- 每次 open、事务 preflight、commit 后验证和 identity adoption 都必须比较代码 expected digest、`project_meta` digest 和 `sqlite_schema` observed digest；
- 任一额外、缺失或语义不同的 trigger 都必须 fail-closed；
- schema 高于当前构建支持上限时，在 migration、recovery、普通读取和 DML 前返回 `PROJECT_SCHEMA_TOO_NEW`，且数据库、文件和 ControlStore 零修改；
- 旧版本 DML 负控必须扩展到 schema 12，不能因表重建而失去 L1 写屏障。

### 7.2 删除与复活

权威结构中删除章节或卷时，SQLite 不执行会级联业务关系的物理 `DELETE`。

- 删除章节写 `is_present = 0`、`deleted_at`，保留原整数 ID 和关联；
- 删除卷时先 tombstone 未被显式移动的活跃子章节，再 tombstone 卷；
- 同一 UID 再次出现在有效结构中时复用原整数 ID 并重新激活；
- 新 UID 才创建新整数行；
- 永久清除 tombstone 不属于 L2。

schema 12 必须把 `chapters.volume_id → volumes.id` 从 `ON DELETE CASCADE` 改为 `ON DELETE RESTRICT`。

章节表和卷表必须安装由 production schema generator 管理的物理删除拒绝约束或 trigger，普通业务 capability 不得执行 `DELETE FROM chapters` 或 `DELETE FROM volumes`。

除上述显式修改和 7.3 节的编号索引改造外，其他外键动作必须逐项保留并校验。

只有从结构索引移除且对应资源文件按同一有效闭包移除，才构成有效删除。删卷在文件侧只是删除一个 `volumes/vol_<uid>.json` 并更新 `manuscript.json`，不涉及目录移除。

索引仍引用但文件缺失、只缺 `.md` 或只缺 sidecar 都是无效文件集，不得解释为删除。

### 7.3 编号与顺序

- `chapters.num` 是本机显示编号，可以非连续，不是身份或顺序来源；
- 每个卷索引的 `chapter_uids` 和 `unassigned.json` 的 `chapter_uids` 派生容器内连续 `chapter_position = 1..N`；
- 按「卷顺序 → 卷内顺序 → 未分卷顺序」派生全书连续 `manuscript_position = 1..N`；
- 重排、移动、tombstone 和复活必须使用两阶段位置更新，避免中途撞部分唯一索引；
- 现有 `UNIQUE(volume_id, num)` 表级约束必须替换为「活跃已分卷」与「活跃未分卷」两个部分唯一编号索引，tombstone 不占用活跃编号；
- 被忽略的 UID 不参与 position 派生，但其索引成员身份在序列化时按 5.1.2 原样保留；
- 所有阅读顺序、进度和伏笔 overdue 逻辑不得使用 `num` 或 `MAX(num)`。

### 7.4 伏笔位置

`expected_resolve_chapter` 迁移为可空的 `expected_resolve_manuscript_position`。

非空值必须是正安全整数，允许大于当前章节数。

当前最大 `manuscript_position` **大于或等于**预期位置时，未解决且未放弃的伏笔即为 overdue。

> **本版判断（可回退）**：第 1 版写的是「严格大于」，即预期在第 10 章解决的伏笔，写完第 10 章却未解决时不提醒，要写到第 11 章才算 overdue。本版改为 `>=`，认为写到预期章节而未解决就应当提醒。这是产品语义，若需回退只改本节与第 15.2 节对应断言。

## 8. 服务边界

### 8.1 ManuscriptService

ManuscriptService 是文章域唯一写入口，负责：

- 章节正文和 sidecar 更新；
- 章节/卷创建、改名、移动、重排和删除；
- 外部变化刷新、冲突解决和迁移写入；
- 生成精确文件闭包、before/after 哈希和候选投影；
- 在同一项目 writer turn 内协调文件与 SQLite 投影发布。

任何 REST、桌面自动保存、AI 工具、AI 续写或提案接受都不得直接更新文章真值列，也不得直接写受控文件。

注意这比 L1 的收口范围大一圈：L1 只把 `chapters.content` 收进 ManuscriptService，而章节标题、大纲、状态、摘要、五个叙事维度和卷结构目前仍由 `routes/api.js` 与 `tools.js` 直写。L2 必须把它们一并收口。

### 8.2 ManuscriptStore

ManuscriptStore 负责：

- 安全路径推导和 `mythpen/` 受控树枚举与形状分类；
- 文件解析、模式验证、稳定序列化和 raw SHA-256；
- 生成受控文件快照与完全校验结果；
- 从完整有效文件集构造投影候选；
- 对单正文、单 sidecar 和结构性多文件闭包提供确定性 before/after。

### 8.3 SQLiteProjectionStore

SQLiteProjectionStore 使用 L1 的 NativeProjectStore 原子发布能力提交候选投影。

一次投影发布必须包含 `chapters.content`、文章元数据、UID、tombstone、positions、派生哈希、ignored 身份账本及其逐成员状态、同 generation 的项目容量快照、`manuscript_projection_generation`，以及因正文或 `status` 改变而需要同步转 stale 的本机 AI 提案状态；这些字段必须在同一 SQLite 事务中作为一个不可拆分的 projection target 发布，任何增量刷新都不得先提交容量或 ignored 状态、再单独提交正文与结构投影。

`chapters.content`、hash、word count 和 sidecar 字段必须来自同一个已校验文件 generation，并在同一数据库事务中可见。

迁移的最终激活额外把 `manuscript_route` 在同一事务内 CAS 为 `files`，见第 12.2 节。

文件已经发布但投影尚未提交时，不得向普通读取返回旧 SQLite 结果。

### 8.4 ActiveManuscriptProjection

所有正常产品查询只能看到：

- `volumes.is_present = 1` 的卷；
- `chapters.is_present = 1`，且父卷为空或父卷活跃的章节。

侧栏、REST 列表/详情、导出、统计、角色关联、AI 上下文、模型只读工具和按 ID 的默认查询全部必须经过该边界。

只有诊断、恢复和明确的维护接口可以读取 tombstone。

兼容的编号路由只能查询活跃章节，编号歧义必须拒绝。

新增和迁移后的主 API 使用稳定本机 `chapter_id`，不能继续以 `volume_id + num` 作为主身份。

未分卷章节必须可完整列出、读取、编辑、导出和按 `chapter_id` 删除。

## 9. 新鲜度与外部变化

第 1 版的两级 probe 模型在成本上不可行：完全校验要求每次写入前读取受控树全部 raw bytes 并计算 SHA-256；快速门要求每次读取前后各扫一遍全树的 `(path, size, mtime, file_id)`。真正贵的不是哈希本身（35 MiB 用上 SHA-NI 约 25 ms），而是 6,000 次文件打开——Windows 上 libuv 的 `stat` 也要开句柄，取 `file_id` 更必须 `GetFileInformationByHandle`；热缓存下约 60–200 ms，实时扫描介入后是秒级。这比第 16 节的 150 ms / 300 ms 目标高一到两个数量级。

本版把「读的新鲜度」和「写的前置条件」拆成两个本来就不同的问题。

### 9.1 变化检测模型

**L2 v1 Windows 默认变化 feed。** 默认实现直接通过 `bun:ffi` 调用 `ReadDirectoryChangesW`，不经过 Bun `fs.watch`。它分别打开 `mythpen/`、`mythpen/volumes/` 和 `mythpen/chapters/` 三个非递归目录句柄，每个句柄独占一组 OVERLAPPED 状态和 1 MiB 的内核通知缓冲区；句柄不共享 delete access，使被监视目录本身不能在覆盖建立后被改名、删除或替换。三个缓冲区彼此隔离，`chapters/` 的突发变化不得挤占根目录或 `volumes/` 的覆盖。L1 已排除网络盘、云同步根和 reparse point，因此 L2 v1 不承担远程文件系统的 64 KiB 缓冲区限制或语义差异。

**完成、同步与重新布防。** 每个目录使用唯一的手动复位 event 和双缓冲，并为当前 handle instance 维护两个从 0 开始、进程内不回绕的 64 位单调计数器 `completionsObserved` 与 `completionsAccounted`。取得一项原生完成状态后，唯一 completion owner 必须先在线性化的 feed-state 临界区内把该 feed 置为 unarmed 并递增 `completionsObserved`，提交并释放临界区后才能用另一块缓冲区重新布防；重新布防成功再把 armed=true 写入 feed-state，随后解析上一块已完成的缓冲区。只有该完成的全部规范路径已与 dirty 原子合并，或者 `coverageLost` 已经原子锁存，才能在同一 feed-state 提交中递增 `completionsAccounted`。同一 feed 至多存在一个未 accounted completion，下一项 completion 不能在上一项 accounted 前被取得，以免重新布防覆盖仍在解析的另一块缓冲区。重新布防会清除 event，但它发生前 `observed > accounted` 已经提交为 freshness gate 可见的状态，因此完成被后台泵取走但尚未解析、解析抛错或线程停顿都不能形成 clean；任何无法继续处理的差值必须由持有 writer lease 的同步排空路径锁存 `coverageLost` 后结清，不能直接改写计数器或丢弃旧缓冲区。

两个计数器、handle instance、armed 状态、脏集合、`refreshInProgress`、不可变 `refreshingDirty` claim、`refreshBaseGeneration` 与 `coverageLost` 构成一个项目级线性化 feed-state，后台事件泵、projection refresher 与 freshness gate 必须通过同一把进程内 mutex 或等价的单写者执行器读写，不能分别读取后拼成快照。不得用从原生线程回调 JavaScript 的方式承接通知。后台事件泵只负责降低延迟，不能成为正确性前提；每次 `ensureProjectionCurrent()` 必须先在 writer lease 内同步排空三个 feed 的已完成 event 与所有 `observed > accounted` 的已取得完成，直到本轮没有更多完成且三个计数差都归零，再检查 `coverageLost`、refresh claim 和脏集合。Windows 会把相邻调用之间的变化保存在该目录句柄关联的内部缓冲区，但实现仍必须用实测覆盖完成到重新布防的边界。任一重新布防失败必须在结清该项 completion 前锁存 `coverageLost`，不得先发布上一批路径后继续报告 clean。

**能力定义。** `manuscriptChangeNotification = true` 要求的不是「系统曾发出通知」，也不是「每个底层事件逐一到达」，而是以下不变量：可信基线建立后，每个相关受控树变化最终都产生一个覆盖该变化的脏路径或脏目录，或者使 `coverageLost` 被显式锁存；一旦对应的原生完成已经可取或已被任一消费者取得，随后开始的 freshness gate 必须同步消费它，观察到 `observed > accounted` 后拒绝 clean，或者转入持有 lease 的结清路径。重复事件、同一路径合并、跨路径乱序和不提供完整原子替换序列都允许；漏掉具体路径也允许，但只能以 `coverageLost` 退化为全脏。这里的 false-clean 精确定义为「freshness gate 的同一线性化快照中三个 event 均未 signaled、三个 feed 均 armed 且 `completionsObserved == completionsAccounted`、脏集合为空、`coverageLost` 未锁存，却仍存在该快照前已经完成或已取得但未被上述任一状态覆盖的相关变化」，不能用“完成已被后台泵取走”把它排除在定义之外。

**脏路径集合。** 内存态，与当前 projection generation 绑定。能力为 true 时，只有三个 feed 全部 armed、三个计数差都为零、`refreshInProgress = false`、`refreshingDirty` 为空、普通 dirty 集合为空且 `coverageLost` 未锁存，当前投影才可证明对应当前文件树。事件按第 5.1 节的规范形状与大小写折叠别名规则归一化后加入普通 dirty 集合；第三类 journal 候选由其 journal 所有者处理，其余第四类残留只记诊断提示。refresher 需要处理一批路径时，必须在一个 feed-state 提交中先置 `refreshInProgress = true`、记录当前 `refreshBaseGeneration`，再把当时的 dirty 原子移动到不可变 `refreshingDirty`；新到事件继续写普通 dirty。claimed 路径只有在已证明是当前 projection after 的自我事件，或匹配 `refreshBaseGeneration` 的目标 projection 已确定提交后才能从 `refreshingDirty` 删除并清除 refresh 标记；失败、取消或 projection commit disposition 不明时必须把 claim 原子合回 dirty，或者保持 refresh 标记并锁存 `coverageLost`，不能先清空证据。用集合而不是单个 epoch 计数器有三个理由：可以按第 9.2 节对消自我事件；第 9.3 节按 UID 刷新时直接知道**哪些** UID 变了，不必靠全量扫描去找；第 11 节判断外部变化是否与本地草稿撞在同一资源域时同样直接可判。completion 计数器只证明“已取得的完成是否已经入账”，不得替代集合、refresh claim 或被拿来对消自我事件；能力为 false 时，这些内存状态都只保留诊断价值，不能独立承担新鲜度证明。

**`coverageLost` 与全脏标记。** 以下任一情况必须在继续解析或返回 clean 前原子地锁存 `coverageLost` 并置全脏：原生调用成功但完成字节数为 0；返回 `ERROR_NOTIFY_ENUM_DIR`；完成、等待、重新布防或句柄操作出现其他无法证明覆盖连续性的错误；目录句柄失效、关闭或重建；通知记录长度、偏移、UTF-16 文件名或边界校验失败；已取得 completion 的缓冲区丢失或无法结清；三个 direct feed 尚未全部建立并 armed；`manuscriptChangeNotification` 能力不是 true；进程启动尚未完成首次完全校验。未知错误可以升级为不可用状态，但不得降格为一条普通诊断后继续报告 clean。handle instance 只能在旧实例关闭且 `coverageLost` 已锁存时更换；新实例使用新 identity 并把两个计数器重置为 0，旧实例的差值不得带入新实例伪造相等。

**完全校验与锁存清除。** 完全校验读取受控树全部 raw bytes、计算 SHA-256、校验 UTF-8、JSON 模式、UID、索引引用闭包和文件集完整性，并按第 16.2 节单独计量被忽略资源。它是唯一能从零重建可信状态的手段，只在五种场合执行：进程启动；全脏标记置位；用户显式刷新；恢复；迁移。扫描开始前必须按上一段建立覆盖全脏状态与当时 dirty 的 refresh claim；扫描产生的 projection target 确定提交，或精确证明扫描结果已经由当前 generation 覆盖后，才能清除该 claim。`coverageLost` 是单调锁存状态，只能由一次成功的完全校验清除；清除前必须在同一 feed-state 临界区确认三个句柄均已重新布防、三个计数差均为零、校验期间没有新的 coverage-loss epoch，并把校验开始后到达的具体路径事件保留在普通 dirty 集合中。数据库 commit 成功到内存 claim 清除之间允许暂时拒绝 clean，反向顺序禁止；失败、取消或 commit disposition 不明的校验不得清除锁存或 refresh claim。

**启动顺序固定为先建立并布防三个 feed、再做完全校验。** 实现记录校验开始时的 coverage-loss epoch、handle instance、`completionsObserved` 与 `completionsAccounted`；校验期间到达的事件照常按 completion 记账进入集合。校验结束后只在 epoch 与 handle instance 未变化、所有 feed 仍为 armed 且三个计数差均为零时发布可信基线，随后继续排空校验窗口内的具体事件；任一条件不满足都保持全脏。顺序颠倒会制造没有原生覆盖也没有扫描覆盖的窗口，禁止实现。

**平台能力与降级模式。** 比照 L1 的两个 native durability capability，`manuscriptChangeNotification` 必须由 Bun 1.3.14 Windows x64 编译产物的实测证据置为 true，不得由 API 存在性或 Microsoft 文档单独推定。第 2.5 版的直接 feed 已通过原生证据矩阵，因此底层 Windows 原语在 L1 限定的本地 Windows x64 支持包络内具备候选能力；生产 `manuscriptChangeNotification` 仍必须默认 false，直到 production adapter 通过第 15.4 节原矩阵、observed/accounted 确定性交错、feed-state 线性化、生命周期拆除和资源预算验收后才可置 true。生产适配器还必须在每次启动时 fail-closed：任一 FFI 符号、目录句柄、OVERLAPPED event、重新布防或能力自检失败都按 false 处理，并让全脏标记常置。于是每次 `ensureProjectionCurrent()` 都走完全校验，读写路径自动落到同一条规则上，本节五个场合仍是完全校验的唯一入口。UI 必须显示降级模式及陈旧窗口说明，不得让每次读取各自去猜。

用常置全脏标记而不是新增触发点，是为了不与 9.5 节「写入本身不触发完全校验」冲突——那条说的是写入不自带触发权，不是说写入路径上永远不会发生完全校验。

**Bun `fs.watch` 与 USN 的位置。** Bun `fs.watch` 已有静默丢失负面证据，L2 v1 只能把它用于非权威诊断或开发提示，不能参与 clean 判定。USN Change Journal 能补足进程未运行期间的增量证据并减少启动全扫，但它涉及卷级能力探测、journal 回绕、FRN 路径过滤和非 NTFS 降级，不进入 L2 v1；以后加入时只能优化启动与离线变化发现，不能移除本节的直接 feed 或完全校验兜底。

**已知保证边界。** 能力成立时，外部变化到可见之间仍存在原生完成与事件泵调度延迟，但该延迟结束时结果只能是具体脏证据或显式 coverage loss；能力不成立时，窗口是两次完全校验之间的间隔。两种情况下都不存在「已经检测到变化却继续返回旧投影」的分支。第 1 节、D6 和第 18 节的表述都以此为准。

**普通会话生命周期屏障。** 每一个进程内至少有一个普通 `files` 会话时，无论该项目是否取得 direct-feed slot，该进程都必须为该项目持有一个跨进程 shared manuscript-lifecycle lease，并在进程内按会话计数复用；普通读取、写入、自动保存、导出和 AI 上下文的整个 admission 与在途请求都受它保护。shared lease 取得后必须重新读取并验证 `manuscript_route = files`、project UID/instance、数据库与文章根物理身份及 projection generation；存在关联 MigrationJournal 或 ProjectCreationJournal 时，它必须已到成功终态，合法 GC 后不存在历史父 journal 不构成失败，但任何非终结父 journal 都阻断普通 admission。任一复核字段变化都释放 shared lease 并拒绝会话，因此没有 feed slot 的完全校验降级会话也不能越过退役屏障。

**Windows manuscript-lifecycle lease adapter。** 规范锁对象固定为 L1 已解析且物理身份已验证的项目 ControlStore **父目录**下空普通文件 `.manuscript-<sha256(canonical-real-control-directory)>.lifecycle.lock`，不能放进 ControlStore 事件目录破坏其严格文件集；迁移在 route-fence 后、文件候选前创建或验证它，新项目在 `project_control_ready` 阶段创建它，均要求实名匹配、非 reparse、链接计数 1、文件 fsync 与父目录 fsync，后续只以 `OPEN_EXISTING` 打开。新项目 reservation 时 ControlStore 尚不存在，expected canonical-real-control-directory 必须由已经验证的真实父目录加冻结的最终目录实名推导；目录创建后立即重新 canonicalize，结果不逐字节相等就进入 `RECOVERY_REQUIRED`，不得改名锁文件或重算 reservation。adapter 通过 `CreateFileW` 以 `GENERIC_READ | GENERIC_WRITE` 和 `FILE_SHARE_READ | FILE_SHARE_WRITE` 打开该规范实体，明确不共享 delete access，使持 lease 期间锁实体不能被改名、删除或替换，再用 `LockFileEx` 锁定 `[0,1)`：不带 `LOCKFILE_EXCLUSIVE_LOCK` 是 shared，带该标志是 exclusive，两者都带 `LOCKFILE_FAIL_IMMEDIATELY` 并使用 offset 为 0 的独立 OVERLAPPED；同一进程/物理项目只保留一个 ref-counted shared lock handle。规范锁键由 canonical real ControlStore directory 推导并在取得锁后复核锁文件与 ControlStore 的父目录及物理身份，路径别名必须汇聚到同一实体，不能按调用字符串另建锁。

`ERROR_LOCK_VIOLATION` 或等价竞争只映射为已有 `PROJECT_WRITE_BUSY`，且发生在路由或文件副作用前；缺符号、锁文件身份异常、其他 acquire 错误或能力自检失败映射为 `MANUSCRIPT_LIFECYCLE_UNAVAILABLE`，不得接纳普通 `files` 会话或执行退役。释放顺序固定为 `UnlockFileEx → CloseHandle`；unlock 失败但 close 已知成功可凭句柄关闭视为已释放，close 失败或 disposition 不明则本进程 session controller fenced，不能报告 lease 已释放，也不能继续退役。Windows 强杀进程后必须由内核释放 handle 与 byte-range lock；adapter 不承诺公平排队，所有 acquire 都是有界非阻塞尝试，产品只允许用户显式重试，不能在持有其他 lease 时无限等待。`manuscriptLifecycleLease` 是独立 native capability，默认 false，只有第 15.4 与 15.6 节的双进程编译产物矩阵通过后才能为 true。

锁序固定为：普通会话 admission 取得 registry/config lifecycle lease，再取得 shared manuscript-lifecycle lease并复核 route/身份，随后释放 registry/config lease；会话内写操作在已持 shared lease 时再取得项目 writer lease。退役先取得 registry/config lifecycle lease，在 session controller 中原子切换为 `retiring`，从而关闭本进程该项目所有普通会话的新请求 admission、使尚未 admission 的请求立即失败，随后释放 registry/config lease；退役在不持 registry/config 或 writer lease 的状态下排空所有已经 admission 的本进程在途请求，本进程 shared manuscript-lifecycle lease 在此期间继续覆盖这些请求。只有本进程在途计数归零后，退役才按顺序重新取得 registry/config lease、复核 controller/route/身份/generation，再取得项目 writer lease、拆除本进程 feed、关闭本进程普通会话并释放 ref-counted shared manuscript-lifecycle lease，然后对 exclusive manuscript-lifecycle lease 做一次非阻塞 acquire；失败即释放 writer 与 registry/config lease、把 controller 从 `retiring` 恢复为可 admission 的 `files` 状态并以 `PROJECT_WRITE_BUSY` 零路由副作用返回，恢复入口前仍须重新复核 route/身份。退役不得在排空本进程在途请求之前持有项目 writer lease，也不得在排空期间持 registry/config lease，否则会与已经 admission 但尚未申请相应 lease 的请求自锁；任何路径不得在持有 exclusive manuscript-lifecycle lease 时回调普通 admission，也不得以不同顺序同时等待这些 lease。

**direct feed 生命周期。** feed owner 是已持 shared manuscript-lifecycle lease 的普通会话子资源，并依次经过 `closed → starting → armed → stopping → closed`；取得预算槽后、打开第一个目录句柄前必须再次复核 route、身份、generation 与“存在则终态”的父 journal 条件。`sqlite`、`migrating`、`retired`、迁移候选、创建候选、恢复中的未终结父 journal 和后台项目列表项一律不得打开 direct feed，因此 `activation_intent` 之前的迁移或创建中止没有 feed 句柄需要删除。

切换预算槽、关闭当前进程内最后一个项目会话、进程正常退出或 feed 失败时，feed owner 必须先阻止该项目的新 freshness gate，原子锁存全脏并进入 `stopping`，调用 `CancelIoEx` 取消每个 pending request，等待每项 completion 进入终态，按 observed/accounted 规则结清或锁存 `coverageLost`，关闭三个目录句柄、event 与用户缓冲区并进入 `closed`；任何一步状态未知都不得报告句柄已经释放。仅切换 slot 或 feed 失败而普通会话仍存在时继续持有 shared manuscript-lifecycle lease并走完全校验降级；关闭最后一个会话时只有 feed 已 closed、在途请求归零后才能释放 shared lease。进程异常终止依赖 Windows 回收该进程的句柄和锁，下一进程仍从首次完全校验开始，不能继承旧进程的 clean。

退役是需要“全部普通会话与 feed owner 已关闭”的生命周期操作：调用进程按上述锁序完成本进程拆除后取得 exclusive manuscript-lifecycle lease；若仍有其他进程的普通会话，即使它没有 feed slot，也会因 shared lock 使退役以 `PROJECT_WRITE_BUSY` 零副作用失败。只有 exclusive lease 证明全部合规普通会话已退出后，才允许执行 `files → retired` CAS；重新激活在 exclusive lease 下执行 `retired → files` CAS，但不得就地复用旧句柄，释放 exclusive lease 后由首个普通会话重新 admission，再走 feed `starting` 与首次完全校验。任何确需删除或重命名受监视目录的协议都必须先取得同一 exclusive lease 并证明 feed 为 `closed`，不得依赖删除失败后再补拆除。

**固定资源预算。** L2 v1 把 `MAX_ARMED_FILE_PROJECTS_PER_PROCESS` 固定为 1；一个槽恰好允许一个活动 `files` 项目持有三个目录句柄、约 3 MiB 的系统内部通知缓冲区和 6 MiB 的用户态双缓冲，名义预算约 9 MiB/进程，操作系统对内部缓冲区的具体池类型不属于本规格承诺。没有取得槽的普通 `files` 会话仍持有 shared manuscript-lifecycle lease，但必须把 `manuscriptChangeNotification` 判为 false 并保持全脏，普通访问只能走用户可见的完全校验降级路径；切换槽必须先完成旧项目的 feed 拆除，再启动新项目并完成首次完全校验，不能同时 armed 两个项目，也不能以 LRU 驱逐正在执行 gate 的项目。多进程各自受同一单槽上限约束，跨进程退役安全由 manuscript-lifecycle lease 保证。

目录句柄不共享 delete access 是有意的身份保护，其用户可见结果是活动项目的 `mythpen/`、`volumes/` 与 `chapters/` 在 Windows 资源管理器或外部工具中不能被改名、删除或替换；项目关闭、切走预算槽或成功退役并完成拆除后才释放本进程的锁定。UI 的项目打开说明、占用错误与诊断包必须披露这一行为，不能把操作系统 sharing violation 映射成未知 I/O 错误。

**既有 `fs.watch` 证据。** 2026-08-15 使用 Bun `1.3.14+0d9b296af` Windows x64 编译产物在本机 NTFS 上完成四项实测：递归 watcher 能收到两级嵌套事件；同一文件连续写入 2,000 次只产生 1 个匹配事件；独立进程高速写入 5,000 个不同路径时，递归 watcher 只收到 1,707 个、三个平铺 watcher 只收到 468 个，两者均无错误、无空文件名且无其他丢失信号；「候选写入 + fsync + 原子替换」连续 20 次都观察到 `rename:<candidate> -> change:<candidate> -> rename:<target>`。配置每个文件至少等待 2 ms 的低速对照中，两种 watcher 均收到全部 1,000 个路径。完整方法、哈希与原始结果见 [L2 Windows watcher 实测证据](../plans/2026-08-15-l2-windows-watcher-evidence.md)。

**第 2.5 版平台原语证据门已通过。** 2026-08-15 使用 Bun `1.3.14+0d9b296af` Windows x64 编译产物在本机 NTFS 上完成八项直接 feed 实测，2026-08-16 又以 probe version 3 重跑同一矩阵并把最终无进展轮显式固化为 `linearizationSnapshot`：三个非递归目录 3/3 可达；低速 1,000/1,000 与高速 5,000/5,000 个不同章节路径完整进入 dirty；512 字节缓冲区下故意积压 20,000 个路径时只保留 1 个具体路径，但 `mythpen` 与 `chapters` 两个 feed 都产生零字节完成，第一次 freshness 同步建立完整线性化快照并得到 `canReportContinuousCoverage=false`，且锁存不被重新布防清除；同路径连续写 2,000 次保持目标 dirty；完成到重新布防的故意空档仍交付 2/2 路径；20 次候选 fsync 与原子替换全部出现目标 `renamed_new_name`；三个目录在句柄覆盖下均无法改名。8/8 用例全部要求并取得 `linearizationSnapshotEstablished=true`，在该探针覆盖的交错中通过且没有 false-clean，完整方法、哈希与原始结果见 [L2 Windows 直接变化 feed 实测证据](../plans/2026-08-15-l2-windows-change-feed-evidence.md)。该探针没有并发执行“后台泵已重新布防但尚未解析”或“dirty 已 claim 但 projection 尚未发布”与读取 gate，因此只解除平台原语前置，不能替代第 2.8 版 observed/accounted、refresh claim 和 generation/epoch 生产适配器验收；生产适配器集成后必须按第 15.4 节重跑原矩阵和新增交错。

### 9.2 自我事件对消

应用自己的文件发布同样会触发直接 feed 事件。若不处理，每次写入都会让刚发布的投影失效并触发全树重扫。

发布成功时 FilePublicationJournal 已经记录了闭包每个成员的 after raw SHA-256 与存在性谓词。排空脏路径集合时，对每个脏路径先与投影记录的 after 值比对：一致即判定为本应用刚刚写入，直接从集合移除，不触发刷新。

不得用时间窗口、事件序号或路径抑制表来做这件事——那些手段在事件延迟、重试或崩溃重入时会漏判。

### 9.3 `ensureProjectionCurrent()`

在持有项目 writer lease/FIFO 时：

1. 恢复未完成 journal；
2. 按第 9.1 节的线性化 feed-state 协议，用零超时同步排空三个直接 feed 的全部已完成 event，并结清已经被后台泵取得的 completion；每一项分别提交 unarmed+observed、重新布防后的 armed、以及 dirty/loss+accounted 三个有序状态，不能把 FFI 重新布防与旧缓冲区解析包在一个让 freshness gate 永远看不到中间态的伪快照里，直到三个 event 均未 signaled 且三个计数差均为零；
3. 全脏标记置位时执行完全校验，并按结果重建集合；
4. 普通 dirty 非空时按第 9.1 节原子建立 `refreshInProgress + refreshingDirty + refreshBaseGeneration` claim，再处理不可变 claim；每个 claimed 路径先按 9.2 验证能否作为已由当前 projection 覆盖的自我事件对消，剩余项按 UID 归类为正文变化、sidecar 变化或结构索引变化，处理期间到达的新事件只进入普通 dirty；
5. 结构索引发生变化时必须重新校验索引引用闭包（读取全部索引并核对被引用资源的存在性与形状），因为结构变化会改变哪些文件属于受控集合，也可能把既有文件变成孤儿；
6. claimed 路径命中 `ignore_status = active` 时按第 5.1.2 节重新验证该 UID 的全部规范成员和容量 before/after；合法且未超限时把 ignored 成员状态与项目容量快照纳入本轮唯一目标 projection，不能直接跳过 dirty或单独提前提交，无法增量证明时转全脏完全校验；
7. 若全部 claimed 路径都被逐项证明为当前 projection after，原子清除 claim；只有此后普通 dirty 仍为空才可返回当前 generation；
8. 对既有 UID 的合法外部变化且无相应本地草稿时，按 UID 构造正文、元数据、结构、tombstone、positions、raw hash、字数和容量快照的目标 projection；仅有第 6 项 ignored 容量变化时也走同一目标 projection，混合批次不得拆成多个 commit。目标 generation 必须从 `refreshBaseGeneration` CAS 发布，commit 已确定成功后才原子清除对应 claim，commit 前后到达的普通 dirty 保持不动；
9. 外部正文变化或删除把匹配章节的 `pending` 提案转为 `stale`；外部 sidecar `status` 变化同样转 `stale`；仅移动、重排或其他元数据变化且正文 hash 不变时保持提案状态；
10. 出现孤儿资源，**或**出现在投影中既无活跃行也无 tombstone 行的 `chapter_uid` / `volume_uid`（无论它是否已被结构索引正确引用），返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED`，保留现场并阻断普通读写，同时提供第 5.1.2 节的忽略出口；只有已按第 6 项完成容量重验的 `ignore_status = active` UID 不触发该分支，`revoked` 记录只保留容量身份，不触发跳过；
11. 文件集无效、路径不安全、不支持或存在冲突时保留现场并返回结构化错误；
12. 该过程不得为了同步而回写权威文件。

成功返回时 `refreshInProgress` 必须为 false、`refreshingDirty` 与普通 dirty 都必须为空；结构化错误返回前必须把未完成 claim 合回普通 dirty，或者保持 refresh 标记并锁存 `coverageLost`。不存在「任一 dirty evidence 已暂时取出但 projection 尚未提交，却向并发 gate 报告 clean」的分支。

> **本版判断（可回退）**：第 9 项中「外部 `status` 变化也转 stale」是新增。理由是 `status` 改成 `accepted` 意味着用户宣告该章定稿，此时把一个基于旧状态生成的 AI 提案直接应用回去需要重新确认。若认为提案有效性只应取决于正文，删去该半句即可。

### 9.4 `ensureReadableProjection()`

每次正常读取：

1. 查询前取得 feed-state 临界区，在该临界区内对三个 direct feed event 做零超时探测并读取同一个线性化快照；只有三个 event 全部未 signaled、三个 feed 全部 armed、每个 feed 都满足 `completionsObserved == completionsAccounted`、`refreshInProgress = false`、`refreshingDirty` 与普通 dirty 都为空且全脏标记未置位时才能直接使用当前投影；
2. 任一 event 已 signaled、任一计数不等、任一 feed 未 armed、存在 refresh claim、任一 dirty 非空或全脏置位时取得项目 writer lease/FIFO，恢复 journal 并调用 `ensureProjectionCurrent()`；
3. 捕获确认新鲜的 projection generation 与 connection epoch，只从该 generation/epoch 读取；
4. 结果序列化完成后再次在 feed-state 临界区内零超时探测三个 event，并读取与第 1 步相同字段的线性化快照；
5. 读取期间任一 event 变为 signaled、任一计数不等、任一 feed 不再 armed、出现 refresh claim、任一 dirty 再次非空、全脏置位，或者当前 projection generation/connection epoch 与第 3 步捕获值不同，均丢弃结果并重试一次；即使一次 refresh 在前后两个 gate 之间完整开始并结束，generation/epoch 变化也必须使旧结果失效，持续变化返回 `MANUSCRIPT_TREE_CHANGED_DURING_READ`；
6. 命中 `DB_CONNECTION_STALE` 时重新经过该 gate，不得继续旧连接。

第 1、4 步在本版都是固定三个句柄的零超时 event 探测加一次线性化内存快照，而不是全树扫描；其成本为常量级，但不得再描述为纯内存或免费。

任何路径都不得先读取旧 SQLite 投影，再在后台异步刷新后仍把旧结果报告为成功。

### 9.5 写入前置条件

文章写入本身**不触发**完全校验。是否需要完全校验由 feed armed 状态、completion 计数差、refresh claim、两组脏路径集合与全脏标记共同决定：`manuscriptChangeNotification` 成立且 direct feed clean 时通常不需要，降级模式下因标记常置而每次都会做。前置条件固定为两步：

1. 通过 `ensureProjectionCurrent()` 把脏路径集合排空，使当前投影可证明对应当前文件树；
2. 对本次闭包 before 集合的每个成员做精确 CAS：读取 raw bytes、计算 SHA-256，与投影记录值逐项比对；创建类成员校验 after-absent 谓词。

CAS 失败且该资源没有本地草稿时返回 `EXTERNAL_CHANGE_CONFLICT`；有本地草稿时进入第 11 节的 `EXTERNAL_DRAFT_CONFLICT`。

第 1 版把「每次写入前完全校验」写成一条独立的无条件要求，本版取消该要求。对章节 X 的正文写入去哈希整棵树，除了把自动保存拖到秒级之外不增加任何保证；真正防止丢失更新的是上面这次闭包 CAS。降级模式下写入路径仍会做完全校验，但那是全脏标记的后果，不是写入自带的触发权——两者不是同一条规则，也不构成例外。

9.1 的职责边界保持不变：脏路径集合用于决定要不要重扫，refresh claim 保护从 evidence 消费到 projection 发布的区间，闭包写入的丢失更新正确性由 CAS 保证；但正常读取能否把空集合当成新鲜度证明取决于直接 feed 能力、armed 状态、completion 计数相等、无 refresh claim 和 generation/epoch 前后相同，CAS 不能替代查询前后的 event 探测、线性化状态快照或 `coverageLost` 锁存。

## 10. 文件发布 journal

### 10.1 最小文件闭包

- 正文编辑只包含发生变化的 `.md`；
- 章节元数据编辑只包含发生变化的 sidecar；
- 同时修改正文与元数据时只包含这两个成员；
- 单纯重排只包含发生变化的卷/未分卷索引和必要的 `manuscript.json`，不得重写任何未变化章节文件；
- **移动章节恰好包含源索引与目标索引两个文件**，`manuscript.json` 不变，正文与 sidecar 一个字节都不动；
- 创建或删除才包含新增/移除的章节资源对及必要结构索引；
- 删除卷包含该卷索引、`manuscript.json`，以及同一闭包中移动或删除的全部活跃子章节；不涉及任何目录创建或移除；
- 删除卷前若该卷索引含被忽略章节的不透明引用，必须先按第 5.1.2 节显式转移或解除引用，否则返回 `IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE` 且闭包为空；
- L2 没有 `.git/index.lock` 或 Git snapshot fence。

拍平布局使全部操作都落在「同目录写候选 → fsync → 原子替换」这一个原语上，不存在跨目录 rename 阶段。第 1 版的嵌套布局下移动章节必须搬运两个文件到另一个目录，而 10.2 的发布协议没有对应阶段，两节互相矛盾。

### 10.2 普通写入状态机

```text
prepared
  → files_published
  → projection_committed
  → completed

任一阶段 ──[精确 before/after 证据可证明]──→ 前滚或回滚
任一阶段 ──[出现第三种状态]──────────────→ RECOVERY_REQUIRED
```

`prepared` 必须在首个文件副作用前写入并 fsync 到项目 ControlStore。

事件至少固定：

- operation/journal ID、project UID/instance 和现有 L1 项目控制身份；
- 创建章节/卷时按第 12.6 节冻结的 UID、创建种类、逻辑请求 identity、本机整数 ID/编号分配和全部目标 after-absent 谓词；非创建操作显式记为无 UID allocation；
- projection before generation 和目标 generation；
- 完整最小文件闭包及发布顺序；
- 每个文件的规范路径、物理父目录身份、before/after 存在性和 raw SHA-256；
- 完整 before 副本和候选 after 副本；
- 目标 SQLite candidate/before 证据和 after 谓词。

**恢复资产根**固定为：

```text
<data>/control/manuscripts/<project_uid>/<project_instance_id>/<journal_id>/
```

它位于文章树之外，与 L1 的 ControlStore 根同级同管，不参与第 5 节的受控树校验，也不随文章根搬迁。第 11.1 节的冲突 backup 有自己的资产根和所有者，不落在本目录下。

ControlStore 事件只记录恢复资产的规范身份、长度、SHA-256 和 fsync 后存在性谓词，不把正文或数据库字节内嵌进事件 JSON。

发布顺序固定为「正文 → sidecar → 卷/未分卷索引 → manuscript.json」。

每个候选在目标同目录写入、fsync、验证后原子替换并 fsync 父目录。

Windows 上替换目标可能被外部编辑器、杀毒软件或索引器持有，所有文件替换必须使用 L1 平台原语提供的有上限重试和退避。

单个目标重试耗尽时返回 `MANUSCRIPT_TARGET_LOCKED`，不得把它误报为数据损坏。

若尚未发布任何成员，操作可以在证明完整 before 后终止为可重试失败。

若已有成员发布，调用必须先按 journal 前滚或回滚到完整文件集，无法证明时进入 `RECOVERY_REQUIRED`，不得留下第三种字节组合。

删除同样必须有可恢复 before 副本和明确的 after-absent 谓词。

### 10.3 普通写入恢复

- 当前文件均为记录的 before/after 组合且候选 after 完整时，优先前滚到完整 after；
- after 不完整但完整 before 可证明时，回滚到完整 before；
- 文件已完整发布而投影未提交时，从权威文件构造并发布同一个目标 generation；
- 任一文件为第三种字节、路径身份改变、候选/备份不完整或结构验证失败时进入 `RECOVERY_REQUIRED`，绝不覆盖；
- 恢复完成必须产生新的 connection epoch，旧句柄永久 stale；
- 恢复完成必须把脏路径集合标记为全脏，强制下一次完全校验；
- journal 终态落盘前不得释放项目 writer turn 或向调用方报告成功。

## 11. 本地草稿与外部冲突

L2 交付 DraftCoordinator 的最小文章子集，不实现 L4 的完整 AI request/turn 能力模型。

上游范围第 7 节把 DraftCoordinator 整体划归 L4；本节把其中的文章草稿子集前移到 L2，属于对上游范围的显式修订，L4 实施时以本节为已交付部分，不得再造第二份 DraftCoordinator 契约。

宿主必须为每个已加载或已卸载资源维护 dirty-resource registry，覆盖：

- 正文编辑器内存、自动保存防抖和已卸载正文保存队列；
- 标题、大纲、状态、摘要和五个叙事字段；
- 卷标题、卷摘要和结构重排队列；
- 多窗口中尚未提交的文章字段。

该 registry 是宿主进程内的状态，服务端无法独立验证；因此它只用于**触发**冲突保护，不用于证明任何耐久性质。宿主崩溃导致 registry 丢失时，下一次完全校验会把外部变化当作无草稿的合法输入直接刷新——这是已接受的取舍，必须在 UI 上说明「未保存的编辑在崩溃后不保证保留」。

外部变化与同一资源域的本地草稿相遇时：

1. 冻结目标资源的普通写入；
2. 取消或排空当前保存定时器；
3. 创建 DraftConflictJournal（见 11.1），把完整本地草稿和字段 mask 持久化为不可变 backup；
4. 记录基准 hash、外部 hash、backup ID 和 projection generation；
5. 进入 `EXTERNAL_DRAFT_CONFLICT`，不得自动合并或覆盖任一版本。

config.db 现有的 `editor_snapshots` 表继续承担正常编辑期的草稿暂存，不承担冲突 backup：前者可丢失、可重建，后者是冲突决策的证据，必须与 journal 同生命周期。两者不得互相替代。

L2 至少提供两个确定性动作：

- `accept_external` 保留外部文件，刷新投影并归档本地 backup；
- `apply_saved_draft` 以记录的外部文件 hash 为 CAS 基准，经新的 FilePublicationJournal 发布已保存草稿。

外部内容在用户决策前再次改变时，旧动作变为 stale，必须重新刷新并创建新的冲突快照。

UI 必须明确显示当前来源、冲突状态、可复制 backup 和「不要手工删除控制文件」提示。

### 11.1 DraftConflictJournal

冲突发生在写入被冻结、尚未发布的时点，此时很可能根本不存在 FilePublicationJournal，因此 backup 不能寄存在它的目录下——第 2 版一度把 backup 定位为「恢复资产根下当前 journal 目录」，那在冲突时点是空指。冲突 backup 必须有自己的所有者、终态和回收规则。

资产根固定为：

```text
<data>/control/manuscripts/<project_uid>/<project_instance_id>/draft-conflict/<conflict_id>/
```

状态机固定为：

```text
conflict_detected
  → backup_durable
  → decision_ready(decision_epoch = 0)
      → resolve_accept_intent(epoch) → resolved_accept_external → archived
      → resolve_apply_intent(epoch)
          → resolved_apply_draft → archived
          → resolve_apply_aborted → decision_ready(epoch + 1)

外部内容在解决副作用开始前再次改变
  backup_durable | decision_ready | resolve_accept_intent（且 projection 仍精确为 before）→ superseded
```

`backup_durable` 必须在向用户呈现冲突之前完成落盘与 fsync。在此之前 UI 不得声称草稿已保留。

`decision_ready` 表示 backup 已耐久且当前没有未终结的解决副作用，只有该状态可以接受新的用户决策。每次从 `resolve_apply_aborted` 回到 `decision_ready` 都必须递增 `decision_epoch`，旧 epoch 的请求和 child journal 永久 stale。

**两个意图态必须在任何副作用之前落盘。** `resolve_apply_intent` 绑定 decision epoch、将要创建的 child FilePublicationJournal ID、基准外部 hash、projection before generation 和目标 generation；`resolve_accept_intent` 绑定 decision epoch、要接受的外部 hash、受影响资源 UID、projection before generation 和目标 generation。accept 的 projection publish 必须对 before generation 做 CAS，并在目标 generation 中保存该资源已接受的 raw hash；没有意图态时，`decision_ready` 与终态之间存在一个崩溃窗口，恢复流程无法判断某个 child journal 或 projection commit 是否属于这次冲突。

**父子完成顺序固定。** child FilePublicationJournal 必须先到达 `completed`，父才可写 `resolved_apply_draft`；父在 child 到达终态之前不得写 `archived`；child 不得写父的任何状态。这与第 12.3 节对 MigrationJournal 与其 child 的规定是同一套所有权规则。

`resolve_apply_intent` **不能直接转为 `superseded`**。外部内容再次变化或用户取消时，必须先恢复绑定 child：只有 child 可证明收敛到完整 files before，父才可追加 `resolve_apply_aborted` 并进入下一 decision epoch；child 若收敛到完整 files after，父必须先写 `resolved_apply_draft`，之后到达的外部变化按新的独立冲突处理；无法证明时进入 `RECOVERY_REQUIRED`。

**`superseded` 是终态。** 它的 backup 必须保留，因为那可能是用户那份草稿的唯一副本。新建的冲突快照记录 `supersedes` 指向旧 `conflict_id`，形成可追溯链。`superseded` 与 `archived` 适用同一条回收规则。

回收规则固定为：保留最近 20 份或 30 天，取较宽者，只对 `archived` 与 `superseded` 生效；其余状态永不回收。

崩溃恢复：

- `conflict_detected` 但 backup 不完整：删除该 conflict，在下一次完全校验中重新检测；
- `backup_durable`：验证 backup 后追加首个 `decision_ready`，恢复流程不得自动选边；
- `decision_ready`：保留现场等待用户决策；
- `resolve_apply_intent` 但 child 未终结：先按 child 自己的 journal 恢复到完整 files before 或 after；before 时追加 `resolve_apply_aborted` 与下一 epoch 的 `decision_ready`，after 时追加 `resolved_apply_draft`；状态不能无事件倒退；
- `resolve_accept_intent`：恢复流程必须先检查 projection，再读取当前外部文件；若当前 projection 精确等于 intent 的目标 generation 且目标资源 raw hash 等于已接受 hash，说明接受副作用已经提交，必须先追加 `resolved_accept_external`，即使文件随后又变化也不得转 `superseded`，后续变化另建冲突；若 projection 仍精确等于 before generation 且当前外部 hash 仍等于 intent hash，则以 before-generation CAS 幂等发布目标 projection 并追加 `resolved_accept_external`；只有 projection 仍精确为 before 且文件已经变为另一 hash 时才可转 `superseded`；其他 generation/hash 组合进入 `RECOVERY_REQUIRED`；
- 任一状态下无法证明精确 before/after：`RECOVERY_REQUIRED`，绝不覆盖 backup。

诊断包只记录 `conflict_id`、`supersedes`、decision epoch、child journal ID、字段 mask、基准/外部 hash 和状态，不含草稿正文。

## 12. 引导式迁移

### 12.1 路由状态与首个冻结 CAS

文章存储路由状态只有：

```text
sqlite | migrating | files | retired
```

真值是项目 SQLite `project_meta.manuscript_route`，键缺失即视为 `sqlite`（见 D7）。config.db 的路由缓存索引只用于列表渲染，不一致时以项目数据库为准并重建。

第 1 版的枚举还包含 `migration_failed`。本版删除它：第 12.4 节规定安全中止的前提就是「证明目标目录、schema 和文件副作用仍不存在」，既然目标零副作用，路由回到 `sqlite` 就是可证明安全的，没有理由把项目留在一个既不能读也不能重试的状态——而第 1 版恰恰没有定义任何离开 `migration_failed` 的转换，本该作为安全出口的中止协议会把用户送进死状态。无法证明零副作用的中止本来就走 `RECOVERY_REQUIRED`。迁移失败降级为一条诊断记录，不再是路由状态。

既有 `sqlite` 项目打开时，升级提示是可延期的产品入口，不是隐式 schema/open hook。用户选择「稍后升级」后本次与后续打开仍走完整 L1 路径，应用可以继续提示但不得自动创建 reservation；用户选择「立即升级」并完成草稿处理、风险说明和迁移前备份确认后，迁移服务才可取得两个 lease 并创建 `migration_reserved`。一旦 route-fence CAS 把路由切到 `migrating`，UI 必须离开普通编辑器并只显示进度、恢复、诊断或协议允许的安全中止，不再提供「稍后升级并继续写作」。

迁移必须先在既有项目 ControlStore 中创建唯一 MigrationJournal，初态为 `migration_reserved`。

该 reservation 只记录迁移身份、源项目身份、目标缺席谓词和预分配 UID，不修改路由、数据库业务行或目标文章根，也不改变普通路由。

在项目 writer lease 与应用 registry/config lifecycle lease 持续持有期间，首个耐久路由或目标副作用必须是单次 CAS：

```text
manuscript_route: 缺失或 sqlite → migrating
```

它在一个 native 事务内完成，同时写入 `manuscript_project_uid` 与 `manuscript_route_journal`，并固定 `migration_id`、源数据库物理身份、ControlStore 身份、project instance、分配的 project UID 和目标文章根路径/缺席谓词。L1 的 prepared/committed 协议已经保证该事务唯一收敛到 before 或 after，不需要为路由另造原子性论证。

该 CAS 完成前不得创建目标目录、候选文件、schema candidate 或恢复资产。

若进程在 reservation 落盘后、CAS 前崩溃，恢复流程必须在证明路由仍为 `sqlite` 且所有目标谓词仍为 absent 后终结该 reservation，再恢复普通 sqlite 路由。

若进程在 CAS 成功后、journal 阶段标记更新前崩溃，`manuscript_route_journal` 中绑定的 journal ID、摘要和 migration ID 是 CAS 已发生的耐久证据，恢复流程必须把 journal 前滚到 `route_fenced`，不得回退为普通 sqlite 路由。

所有普通读取、写入、自动保存、导出、AI 上下文和普通项目打开只接受 `sqlite` 或 `files`。

`migrating` 一律返回 `PROJECT_MIGRATION_BUSY`，只允许绑定同一 `migration_id` 的迁移、恢复和诊断流程。

启动和普通路由必须联合检查 `manuscript_route` 与未终结 MigrationJournal。

唯一允许的过渡组合是 `sqlite + migration_reserved` 和 `migrating + 同一 journal 的 route_fenced 或后续状态`；前者必须先在恢复流程中安全终结 reservation，后者只能继续迁移或恢复。其他不一致组合返回 `MIGRATION_STATE_MISMATCH`，不得猜测 sqlite 路由。

### 12.2 MigrationJournal 状态

```text
migration_reserved
  → route_fenced
  → source_snapshot_ready
  → files_candidate_ready
  → file_publication_started
  → files_published
  → database_candidate_ready
  → activation_intent
  → activated

activation_intent 之前，且 child 可证明收敛到完整 files before
  → migration_abort_intent → migration_aborted

无法证明精确 before/after
  → RECOVERY_REQUIRED
```

`migration_reserved` 只可在路由仍为 `sqlite`、目标缺席谓词成立且两个 lease 均已取得后写入。

`route_fenced` 只可在 `manuscript_route` 已经是绑定同一 journal ID、摘要和 migration ID 的 `migrating` 后写入。

文件必须先于数据库 candidate 发布，这是 D3「先形成权威文件 after，再发布匹配投影」在迁移路径上的体现。

**唯一的数据库 after candidate 同时包含 schema 12、完整文件候选对应的投影、`chapters.content` 缓存、hash、positions、目标 generation 和 `manuscript_route = files`。** 因此 `activated` 就是这个 candidate 的一次原子发布：投影提交与路由切换是同一个事务的同一次可见性变化，不存在两个需要对齐的 CAS，也不存在双主窗口。

不存在路由仍为 `sqlite` 而文件或 schema candidate 已发布的合法状态。

安全中止把 `manuscript_route` CAS 回 `sqlite`、清除 journal 绑定，并写入一条失败诊断记录。

**中止点定义为 `activation_intent` 之前，且 child FilePublicationJournal 可证明已收敛到完整 files before**——目标文章根完全缺席，全部已创建目标均可证明属于本 journal 且已移除。

这比「`files_published` 之前」更精确。文件已发布之后同样可以证明性地回到完全缺席，此时中止是安全的；真正不可逆的边界是 `activation_intent`：数据库 candidate 一旦进入发布意图，就只能前滚完成或进入 `RECOVERY_REQUIRED`。第 2 版把中止点划在 `files_published` 之前，同时又在 12.8 允许文件发布后「按精确证据前滚或回滚」，两处对「回滚之后能不能中止」给出了互相矛盾的答案；本节以 `activation_intent` 为唯一边界消除该歧义。

新项目**不复用**本节的 route-fence 协议，走独立的 ProjectCreationJournal，见第 12.9 节。

### 12.3 MigrationJournal 与 FilePublicationJournal 的唯一所有权

MigrationJournal 是迁移的唯一顶层所有者。

迁移只创建一个数据库 after candidate。迁移不得先发布一个 schema candidate，再由另一个未绑定的数据库 journal 发布第二份投影 candidate。

迁移中的文件发布使用带 `parent_migration_id` 的 FilePublicationJournal 子协议。

子 journal 只负责 `prepared → files_published`，不得自行写 `projection_committed`、`activated` 或 `completed`。

MigrationJournal 固定 child journal ID、文件 tree after digest、数据库 candidate digest 和两者的共同 target generation。

恢复顺序固定为：

1. 恢复 L1 未完成数据库/ControlStore journal；
2. 联合加载 `manuscript_route` 与唯一 MigrationJournal；若为 `sqlite + migration_reserved` 且目标仍完全缺席，安全终结 reservation 后停止恢复；
3. 若路由已为 `migrating`，验证它绑定同一 journal ID、摘要和 migration ID，并在需要时补写 `route_fenced`；
4. 恢复或回滚 child FilePublicationJournal 至完整 files before/after；
5. 依据 child 终态构造或丢弃唯一数据库 after candidate；
6. 验证 files/projection 共同 after；
7. 写 `activation_intent` 并原子发布该 candidate，完成 `activated`。

父子 journal 的 after 谓词不匹配、出现多个 child、数据库 candidate 不唯一或 target generation 不一致时必须进入 `RECOVERY_REQUIRED`。

### 12.4 迁移 preflight

任何目标副作用前必须：

- 取得 registry/config lifecycle lease 和项目 writer lease/FIFO；
- 恢复 L1 journal 并排空全部写入；
- 冻结 dirty-resource registry，要求用户处理或持久化本地草稿；
- 创建唯一 `migration_reserved` journal；
- 通过首个 route-fence CAS 并把 journal 前滚到 `route_fenced`；
- 建立源数据库一致快照和迁移前备份，记录物理身份与 SHA-256；
- 完成 `integrity_check`、`foreign_key_check` 和 schema 依赖图检查；
- 校验所有卷、章节、未分卷归属和章节编号；
- 校验 `migration_reserved` 中已冻结的 project/volume/chapter UID 映射覆盖全部待迁移实体且无重复；preflight **不生成**新映射（见 12.6）；
- 校验目标文章根缺席或恰为本 journal 记录的物理身份；
- 按第 5.3 节检测目标是否位于云同步目录并给出引导；
- 校验伏笔旧编号可以无歧义映射为全书 position。

route-fence CAS 前失败必须在证明路由仍为 `sqlite` 且目标仍完全缺席后终结 reservation；CAS 之后的 preflight 失败只可在证明目标目录、schema 和文件副作用仍不存在时走安全中止协议，中止完成后路由回到 `sqlite`。

安全中止完成前路由保持 `migrating`，不得提前恢复普通 sqlite 路由。

### 12.5 遗留映射

- 卷顺序使用 `sort_order ASC, id ASC`；
- 每个已分卷集合使用 `num ASC, id ASC`；
- 未分卷集合使用 `num ASC, id ASC`；
- `num` 必须是正安全整数，同一活跃容器重复、空、非整数或超限时返回 `LEGACY_CHAPTER_NUMBER_INVALID`，不得自动重编号；现有 `UNIQUE(volume_id, num)` 只约束已分卷容器，未分卷容器（`volume_id IS NULL`）在 SQLite 中不受该约束，重复编号只可能出现在这里；
- `volume_id IS NULL` 保持未分卷，不创建伪造卷；
- 非空 `volume_id` 指向不存在卷时拒绝迁移；
- UID 映射、整数 ID、章节编号和 position 映射必须固定进 MigrationJournal。

旧 `expected_resolve_chapter` 为 `NULL` 或 `0` 时映射为 `NULL`。

只有全部活跃章节的旧编号逐项等于迁移产生的全书线性位置时，正整数旧值才可原样映射。

无法无歧义映射时返回 `LEGACY_FORESHADOW_EXPECTED_POSITION_AMBIGUOUS`。

负数、非整数或超安全整数返回 `LEGACY_FORESHADOW_EXPECTED_POSITION_INVALID`。

### 12.6 UID reservation

project/volume/chapter 的 UID 必须由服务端 CSPRNG 生成规范 UUIDv4；不得使用时间戳、计数器、Math.random、旧整数 ID、项目名或路径派生。迁移映射**在 `migration_reserved` 事件写入时一次性生成，并随该事件冻结**；新项目的 `project_uid` 同样在 `creation_reserved` 写入时冻结。此后包括 preflight、route-fence、崩溃恢复和同一 journal 重试在内的任何路径都不得再生成映射，只能校验和引用。

第 2 版在三处给出了不一致的顺序：12.1 说 reservation 记录「预分配 UID」，12.4 把「生成一次性 UID 映射」排在 route-fence 之后，12.6 又说 journal 创建后不可变。本节以 reservation 时点为唯一答案，12.4 相应改为校验。

reservation 落盘前必须在同一个受保护临界区内完成局部碰撞检查；迁移持有 registry/config lifecycle lease 与项目 writer lease，新建项目尚无 writer lease，因此只在已经持有的 registry/config lifecycle lease 下执行。检查按命名空间分别执行：同一映射内任何 UID 不得重复；chapter/volume UID 不得碰撞源项目现有 active、tombstone、`active | revoked` ignored 身份，也不得碰撞绑定同一 L1 项目控制身份且仍存在的其他 MigrationJournal 中对应种类的 reservation，包括保留期内的成功或中止终态；`project_uid` 不得碰撞当前 registry、所有仍存在的 ProjectCreationJournal 的 project reservation、所有当前注册项目 ControlStore 中仍存在的 MigrationJournal 的 project reservation、已绑定项目数据库或现存文章根。扫描任一当前注册项目 ControlStore 失败或发现无法分类的非终结 migration 状态都以 `RECOVERY_REQUIRED` 阻断 reservation，不能当作“未碰撞”；同源项目的 chapter/volume reservation 无法完整枚举时同样 fail-closed。任何确定碰撞都丢弃本轮随机值并在写 reservation 前重新生成。reservation 落盘后若发现目标路径或持久身份与冻结 UID 冲突，不得重新抽取或改写映射，必须以 `UID_RESERVATION_COLLISION` 零目标副作用失败或进入恢复。

同一 migration ID 或 creation ID 的崩溃恢复和重试必须逐项复用冻结映射。中止时只在原 journal 中把该 reservation 标记为 `aborted`，用于该 journal 的幂等恢复和保留期内的碰撞检查；它不是跨所有项目永久存在的全局 UID 注册表。

L2 v1 明确不维护全局永久 UID 分配表，也不承诺在相关 journal 按保留策略回收后仍能证明历史随机值绝不再次出现。跨无关项目与跨已回收历史的唯一性依赖 CSPRNG UUIDv4 的碰撞概率，当前可见和当前保留证据范围内的碰撞依赖上述确定性检查拒绝；不得在验收、UI 或诊断中宣称“全局永不复用”。

新的 migration ID 或 creation ID 独立生成新的 reservation，不能主动复制另一 journal 的映射；“独立生成”不替代落盘前碰撞检查，同一 journal 的重试也不属于新请求。

MigrationJournal reservation 的 GC 边界固定为：非终结 journal 永不 GC；`migration_aborted` 只有在 route 已为 `sqlite`、target 缺席、全部 child 终结、清理债务归零且无恢复引用后，才可进入 L1 既有 bounded ControlStore GC；`activated` 只有在 route/files identity、数据库绑定与文章根完整 after 已由持久项目状态接管、全部 child 终结且无恢复引用后才可进入 GC。journal 实际存在期间，其 project reservation 参加全局 project UID 碰撞扫描，其 chapter/volume reservation 参加同一 L1 项目控制身份下对应种类的碰撞扫描；合法 GC 后，activated UID 仍由 registry、项目数据库与现存文章根覆盖，aborted UID 则按本节明确退回 CSPRNG 概率保证，不再声称有历史确定性证据。

普通 ManuscriptService 新建章节或卷同样受本节约束，但使用 FilePublicationJournal 而不是 MigrationJournal。流程必须在项目 writer lease 下先完成 `ensureProjectionCurrent()`，再由 CSPRNG 生成规范 UUIDv4，并在 `prepared` 前检查它不碰撞项目 UID、chapter/volume active、tombstone、`active | revoked` ignored 身份、绑定同一项目控制身份且仍存在的 MigrationJournal 对应种类 reservation、任何同形状现存路径或大小写折叠别名；同项目历史 migration reservation 无法完整枚举时必须 fail-closed，碰撞值在 `prepared` 前丢弃并重生成。`prepared` 必须绑定最终 UID、创建种类、规范目标路径、after-absent 谓词、目标本机整数 ID/编号分配和逻辑请求 identity，自此 UID 冻结；崩溃恢复与同一 logical request 重试只恢复或复用该 journal，不能另抽 UID。prepared 后出现路径或身份冲突时，必须凭 journal 收敛到完整 before 或进入 `UID_RESERVATION_COLLISION`/`RECOVERY_REQUIRED`，不得把碰撞解释为 tombstone 复活或 active ignored 接管；显式复活是引用既有 UID 的独立操作，不走新 UID 分配分支。

### 12.7 DDL candidate

DDL 只在源快照的唯一数据库 after candidate 上执行，不由普通项目打开隐式触发。

必须：

- 临时关闭 `PRAGMA foreign_keys` 后按依赖图重建受影响表，再恢复开启；
- 逐列保留业务行、整数 ID、`sqlite_sequence`、外键、索引、触发器和视图；
- 把 `chapters.volume_id` 的删除动作显式改为 RESTRICT，并安装章节/卷物理删除屏障；
- 把 `UNIQUE(volume_id, num)` 替换为活跃已分卷与活跃未分卷两个部分唯一编号索引；
- 通过同一个 production canonical generator 重建全部 downgrade triggers、更新 trigger version 和 triggerSetDigest；
- 禁止 `CREATE TABLE AS SELECT`；
- 使用两阶段 position 写入避免部分唯一索引中途冲突；
- 遇到未知且不能安全重建的依赖对象时返回 `SCHEMA_SWAP_UNSUPPORTED`；
- 切换前后比较行数、ID 集合、schema 指纹、完整性、外键检查和 trigger digest 三方一致；
- 只经 L1 原子数据库发布协议安装 candidate。

### 12.8 迁移发布与恢复

`migration_reserved` 必须早于 route-fence CAS 持久化；除该无目标副作用的 reservation 外，route-fence CAS 必须早于所有其他迁移副作用。

route-fence 成功后、任何文章文件候选前，MigrationJournal 必须在既有项目 ControlStore 父目录创建或验证第 9.1 节的规范 manuscript-lifecycle lock，并记录其路径、物理身份、before 存在性、空文件 after、文件 fsync 与父目录 fsync 谓词。若本 migration 从 absent 创建它，安全中止回到 `sqlite` 时必须在无普通 session/handle 的前提下凭 journal 删除并 fsync 父目录；若 before 已存在则只验证不删除。迁移恢复必须先把该锁对象收敛到 journal 允许的完整 before/after，最终 `files` 普通 admission 不得临时补建未知身份的锁文件。

MigrationJournal 至少记录源快照/备份、UID reservation、唯一数据库 after candidate、child file journal、候选文件 tree、目标身份、路由 before/after 和每一阶段 after 谓词。

- `activation_intent` 之前，若 child journal 可证明已收敛到完整 files before，可把路由 CAS 回 `sqlite`、记录失败诊断并终止为中止；这适用于文件发布前后两种现场；
- 部分发布的文件闭包只能按 journal 的精确证据收敛到完整 before 或完整 after，两者都不构成「重新开始第二次迁移」；同一 migration ID 的任何重试都复用同一组冻结 UID 与同一个 child journal；
- `activation_intent` 之后只能前滚完成或进入 `RECOVERY_REQUIRED`，不得中止；
- 原 SQLite 文件和迁移前备份必须保留，不因迁移成功自动删除；
- 迁移完成后普通入口只读取文件权威项目，旧项目实例请求必须 stale；
- 应用 UI 提供「升级稿件存储」、进度、失败说明、导出诊断和安全重试/恢复入口；
- CLI 可以触发同一服务，但不得实现第二套迁移协议。

### 12.9 新项目创建

新项目不能复用 route-fence 协议：第 12.1 节的 route fence 要求在**既有**项目 ControlStore 中写 journal，并对**既有**项目数据库的 `manuscript_route` 做 CAS，而全新项目这两者都还不存在。新项目走独立的 ProjectCreationJournal，从不经过 `migrating`，路由键出生即为 `files`。

ProjectCreationJournal 的唯一顶层所有者必须位于目标项目之外的应用级创建控制根：

```text
<data>/control/project-creation/<creation_id>/
```

该路径不得位于目标数据库、目标项目 ControlStore、规范 sibling manuscript-lifecycle lock 或文章根之内。它在 registry/config lifecycle lease 下创建和恢复，使中止流程可以删除全部目标对象而不删除自己的唯一证据。

状态机固定为：

```text
creation_reserved
  → project_control_ready
  → files_published
  → database_candidate_ready
  → activation_intent
  → activated
  → listed
  → completed

activation_intent 之前
  → creation_abort_intent → creation_aborted

无法证明精确 before/after
  → RECOVERY_REQUIRED
```

顺序固定为：

1. 取得 registry/config lifecycle lease；
2. 分配 `creation_id`，按第 12.6 节生成并检查 CSPRNG UUIDv4 `project_uid`，推导目标数据库、目标项目 ControlStore、ControlStore 父目录下规范 manuscript-lifecycle lock 和文章根的物理路径，验证四者**均缺席**，然后在应用级创建控制根写入 `creation_reserved`，绑定四者身份、四个缺席谓词和 UID reservation；
3. 创建目标项目 ControlStore、不可变项目身份记录及第 9.1 节的规范 sibling manuscript-lifecycle lock，完成锁文件与各父目录 fsync并由父 journal 追加 `project_control_ready`；
4. 取得项目 writer lease；
5. 创建初始权威文件（`manuscript.json` 与 `unassigned.json`，两个数组均为空），经带 `parent_creation_id` 的 FilePublicationJournal 子协议发布，再由父 journal 追加 `files_published`；
6. 构造唯一数据库 candidate：schema 12、空投影、`manuscript_route = files`、`manuscript_project_uid`、初始 `manuscript_projection_generation`、canonical trigger set 与 digest，再由父 journal 追加 `database_candidate_ready`；
7. 父 journal 先写 `activation_intent`，再原子发布该 candidate；重新验证目标数据库、目标项目 ControlStore、sibling manuscript-lifecycle lock、文章根和全部 child journal 已满足不含列表项的完整 after 后，写 `activated`；
8. 数据库激活成功后才写 config.db 的路由缓存索引与 `recent_projects`，写成后追加 `listed`；
9. 重新验证目标数据库、项目 ControlStore、sibling manuscript-lifecycle lock、文章根、config.db 列表项和全部 child journal 都满足完整 after，追加 `completed`。

第 1 步取得的 registry/config lifecycle lease 必须持有到 `completed`、`creation_aborted` 或受保护的 `RECOVERY_REQUIRED` 已落盘，期间不得并发执行项目列表、路由或数据根变更。应用启动时必须先枚举并恢复应用级创建控制根中的全部非终结父 journal，再开放项目列表和任何创建入口。

与迁移共享四条性质：文件先于数据库 candidate 发布；数据库 candidate 唯一且自带路由；最终激活是一次原子发布；child FilePublicationJournal 不得写父状态。

「在完整 after 谓词成立前不得出现在可打开项目列表中」由第 8 步的顺序保证，不需要额外的路由状态。崩溃发生在 `activated` 与 `listed` 之间时，下一次启动必须从稳定的应用级创建控制根发现父 journal，幂等补写缓存索引和列表项，不得创建第二个项目。

`activation_intent` 之前请求中止时，父 journal 必须先写 `creation_abort_intent`。只有当 journal 能逐项证明目标项目 ControlStore、目标数据库、sibling manuscript-lifecycle lock、文章根和候选文件均由本 `creation_id` 创建，且全部 child journal 已收敛到可删除的完整 before，才可移除这些**目标对象**、fsync 各父目录、把本 journal 的 `project_uid` reservation 标记为 `aborted`，并在应用级父 journal 中追加 `creation_aborted`。中止不得删除、截断或搬移该父 journal 自己的目录；按第 9.1 节，此时尚未达到允许建立普通 `files` session 或 direct feed 的状态，删除前仍必须断言不存在 lifecycle lock handle、feed owner 或目录句柄。

`activation_intent` 之后只能前滚到 `completed` 或进入 `RECOVERY_REQUIRED`，不得中止。`completed` 与 `creation_aborted` 的父 journal 只有在全部 child 终结、目标清理债务归零、config.db 列表项已与终态一致且没有恢复流程或活动请求引用它时才进入 30 天保留期，期满后可回收；在此之前它始终是创建身份、局部碰撞检查与恢复归属的证据。L2 v1 不引入未定义的应用级 UID checkpoint，父 journal 回收也不承担跨永久历史证明 UID 未复用的职责。

新建项目仍不依赖 Git。上游范围 D1 删除的是原设计中 ProjectCreationJournal 的 baseline commit 分支以及 `creating` / `creation_failed` 路由状态，不是创建 journal 本身；本节的 journal 没有 Git 分支，`creation_reserved` 与 `creation_aborted` 也只是 journal 内部状态，不进入第 12.1 节的路由枚举。

## 13. files 项目删除、退役与数据根

L2 关闭原规格中的项目删除开放项。

对 `manuscript_route = files` 的项目，现有物理删除数据库、封面或项目目录的接口必须在任何文件副作用前返回 `PROJECT_PERMANENT_DELETE_UNSUPPORTED`。

files 项目的「删除」在 L2 中固定为非破坏性退役：

```text
files → retired
retired → files
```

退役和重新激活都是 `manuscript_route` 的一次 CAS，必须按第 9.1 节固定锁序使用 registry/config lifecycle lease、项目 writer lease 与 exclusive manuscript-lifecycle lease，绑定同一 project UID、project instance、数据库物理身份、文章根物理身份和 projection generation，并同步刷新 config.db 的路由缓存索引。退役必须在首次持有 registry/config lease 时把本进程 session controller 原子切为 `retiring`，阻止所有普通会话的新请求 admission 后释放该 lease，再在不持 registry/config 或 writer lease 的状态下排空已经 admission 的在途请求；确认在途计数归零后重新取得 registry/config lease 并复核 route/身份/generation，随后才取得项目 writer lease、完成本进程 feed 拆除、关闭普通会话并释放本进程 shared lease。禁止先持 writer 或持续持 registry/config lease 再等待在途归零。其他进程仍有普通会话时，exclusive acquire 以 `PROJECT_WRITE_BUSY` 失败，route 与缓存索引均不改变，并按第 9.1 节恢复本进程 controller。重新激活在 exclusive manuscript-lifecycle lease 下完成 CAS 与缓存更新，随后释放 exclusive lease；首个普通会话必须重新取得 shared lease、复核 route/身份并完成全新 feed 与首次完全校验，不能复用退役前的 clean、计数器、句柄或缓冲区。

`retired` 项目不出现在普通活动列表，不接受普通读取、写入、自动保存、导出或 AI 上下文，不持有 direct feed slot、shared manuscript-lifecycle lease 或目录句柄，但数据库、ControlStore、规范 sibling manuscript-lifecycle lock、文章根、封面和备份全部保留原位。

应用必须提供独立的 retired 项目列表和重新激活入口。

`sqlite` 项目继续沿用现有删除行为。这意味着在迁移全量完成之前，用户会看到两种删除语义并存；UI 必须在项目卡片上明确区分「删除」与「退役」，不得用同一个措辞覆盖两者。

存在 `files`、`migrating` 或 `retired` 项目，或应用级创建控制根存在非终结 ProjectCreationJournal 时，数据根设置与迁移命令必须在修改配置、创建目标目录或复制字节前拒绝，沿用 L1 的 `NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED`。第 3.2 节把数据根搬迁列为不做，而「不做」与「必须在首个副作用前拒绝」是两件事，本节固定后者。

L2 不移动资产、不创建归档包，也不永久删除任何 files 项目资产。

## 14. 错误与用户可见恢复

稳定错误至少包括：

| Code | 含义 |
|---|---|
| `MANUSCRIPT_PATH_UNSAFE` | 文章根或受控路径身份不安全 |
| `MANUSCRIPT_FILESET_INVALID` | 索引引用的资源缺失、残缺，或文件集、UID、归属无效 |
| `MANUSCRIPT_FORMAT_TOO_NEW` | 权威文件 `format_version` 高于当前构建上限 |
| `MANUSCRIPT_CONTENT_TOO_LARGE` | 单文件或受控树超过上限 |
| `MANUSCRIPT_TARGET_LOCKED` | 外部句柄持续占用替换目标 |
| `UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE` | 正文可只读透传但不可语义写入 |
| `EXTERNAL_CHANGE_CONFLICT` | 写入前置的闭包 CAS 失败且该资源无本地草稿 |
| `EXTERNAL_DRAFT_CONFLICT` | 外部文件变化与本地草稿并存 |
| `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED` | 投影中出现全新 UID，或受控树出现规范形状的孤儿资源 |
| `IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE` | 待删除卷仍承载被忽略章节的不透明引用，必须先显式转移或解除引用 |
| `MANUSCRIPT_TREE_CHANGED_DURING_READ` | 读取期间文件持续变化 |
| `PROJECTION_STALE` | 恢复或诊断路径发现当前投影不能证明对应当前文件 generation 且本次调用内无法收敛 |
| `MANUSCRIPT_LIFECYCLE_UNAVAILABLE` | Windows shared/exclusive manuscript-lifecycle lease capability 不可用或锁实体身份异常 |
| `PROJECT_MIGRATION_BUSY` | 项目已进入迁移路由冻结 |
| `LEGACY_CHAPTER_NUMBER_INVALID` | 旧章节编号不能无损迁移 |
| `LEGACY_FORESHADOW_EXPECTED_POSITION_AMBIGUOUS` | 旧伏笔预期语义不明确 |
| `LEGACY_FORESHADOW_EXPECTED_POSITION_INVALID` | 旧伏笔预期数值非法 |
| `SCHEMA_SWAP_UNSUPPORTED` | 遇到不能安全重建的 schema 依赖 |
| `PROJECT_SCHEMA_TOO_NEW` | 项目 schema 高于当前构建上限 |
| `MIGRATION_STATE_MISMATCH` | 路由、父子 journal 或迁移现场不一致 |
| `UID_RESERVATION_COLLISION` | reservation 落盘后发现冻结 UID 与现存目标路径或持久身份冲突，禁止改写映射 |
| `PROJECT_PERMANENT_DELETE_UNSUPPORTED` | files 项目不允许物理删除 |
| `NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED` | 存在 files/migrating/retired 项目时不支持换根 |
| `RECOVERY_REQUIRED` | 不能证明安全前滚或回滚 |

降级新鲜度模式与非受控残留不是错误，是状态：前者必须以持续可见的 UI 状态呈现并说明陈旧窗口，后者进入诊断包与一条可关闭的提示。

任何不能自动收敛的状态都必须同时提供：

- 用户可见状态和受影响项目隔离；
- 不包含正文内容的诊断包，路径使用相对标识，只包含身份、大小、hash、journal 和能力；
- 在能证明安全时的前滚或回滚动作；
- 无法证明时的只读现场保护，不得自动覆盖或删除。

孤儿资源与外部创建 UID 的出口是第 5.1.2 节的就地忽略动作，不是只返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED`。

## 15. 验收标准

### 15.1 格式与安全

- 规范示例逐字节稳定，未知字段、重复 UID、被多个索引引用、非法归属和路径绕出全部拒绝；
- 四种 JSON 都带 `format_version`，高版本返回 `MANUSCRIPT_FORMAT_TOO_NEW` 而非文件集损坏；
- 外部只改 `.md` 不改 sidecar 可刷新投影且不回写文件；
- 合法的既有资源 sidecar/结构变化刷新投影，索引引用资源缺失或残缺阻断普通读写；
- 四分法正向测试：`manuscript.json` 与 `unassigned.json` 作为结构根被判为一类而非孤儿；两者任一缺失返回 `MANUSCRIPT_FILESET_INVALID`；
- 四分法正向测试：未终结 journal 的候选可被其 journal 正常写入、替换与清理；已终结 journal 的候选凭其终态证据被删除；
- 四分法负向测试：形状匹配但 `journal_id` 对不上任何 journal 记录的文件按四类保留，**恢复流程不得删除它**，并出现在诊断包中；
- 四分法负向测试：`ch_<uid>.md~`、`.ch_<uid>.md.swp`、`ch_<uid>.md.bak`、`desktop.ini`、`Thumbs.db`、`.DS_Store`、`ch_<uid> - 副本.md`、emacs 的 `.#ch_<uid>.md` 符号链接，全部归入非受控残留且**不阻断**读写，同时出现在诊断包中；
- 大小写别名负向测试：在 Windows 与 macOS 上把 `ch_<uid>.md` 重命名为大写形式后，返回 `MANUSCRIPT_FILESET_INVALID`，且**不得**出现「按实名判为残留、同时按规范路径成功写入」的双重处理；折叠后重复的路径或 UID 同样硬失败；
- 规范形状孤儿阻断读写，就地忽略动作使项目恢复正常读写，且不移动、不删除任何文件字节；被忽略 UID 不参与 position 派生，其索引引用不再触发缺失成员错误；
- 被忽略 UID 的索引成员身份在重写后仍然存在：忽略一个已被卷索引引用的外部 UID，随后在该卷内执行重排、移动、改名和删章，每次都重读索引断言该 UID 仍在 `chapter_uids` 末尾且字节稳定；撤销忽略后它仍是已索引条目而非孤儿；
- 被忽略 UID 的原容器保护可证明：该卷仍承载不透明引用时删除卷返回 `IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE`，文件闭包为空且全树字节不变；「保留并转为未分卷」的 journal 对源索引与 `unassigned.json` 同时执行 raw-hash CAS，并在每个强杀点唯一收敛到两个索引与同 generation 忽略名单的完整 before 或完整 after，资源对字节不变；「解除索引引用」以同一协议收敛源索引与忽略名单，资源对作为已忽略孤儿保留；两条路径成功后原卷才可删除；
- ignored 容量不可绕过：`active` ignored 资源虽不做语义解析，仍计入 UID、规范文件数、单文件大小和原始字节；撤销忽略只把记录转为 `revoked`，删除资源文件或反复撤销/重新忽略都不减少生命周期 UID 计数，达到 80% 产生 UI 与诊断预警；应用动作越过任一硬上限时忽略状态和权威字节均不变，外部超限变化则原样保留现场、dirty 不清除并阻断普通服务；
- 外部同时创建完整资源对**并**在结构索引中正确引用新 UID 时，仍返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED`；同一测试证明 tombstone UID 重新出现在索引中是合法复活而非外部创建；
- 只读透传 Markdown 可查看/导出，正文写入被确定性锁定；含 `U+0000` 的合法 UTF-8 正文按 4.5 节处理且不破坏文件；
- 候选临时文件、reparse point、junction、symlink、链接计数大于 1 均有负向测试；
- `mythpen/` 外兄弟项不被 L2 读取、修改或误判，未来 `.git` 存在不影响 L2 文件校验；
- 移动章节的实际写入文件集恰好是两个索引，正文与 sidecar 的 mtime 与字节均不变。

### 15.2 DDL 与投影

- 迁移前后所有整数 ID、业务行、`sqlite_sequence`、外键、触发器、索引和视图保持，只有三项已确认变化例外：`chapters.volume_id` 改 RESTRICT、章节/卷物理删除屏障、`UNIQUE(volume_id, num)` 替换为两个部分唯一编号索引；
- `integrity_check` 与 `foreign_key_check` 通过；
- schema 12 canonical trigger generator、`project_meta` digest 和 `sqlite_schema` digest 三方一致；
- 四个 `manuscript_*` 保留键无法被普通业务 DML、AI 工具或业务 migration 修改；
- 旧版本 DML、未知写表、schema too new 和 trigger 漂移全部 fail-closed 且零修改；
- 除第 4.5 节含 `U+0000` 的只读透传例外外，`chapters.content` 与 `.md` raw bytes、hash、word count 和 generation 一致；该例外必须把 `chapters.content` 置空并标记不可用，同时保持 raw hash、word count 和 generation 正确，任何被拒绝的正文写入都不得改变文件；
- 重复/非连续编号、未分卷、移动、重排、tombstone 和同 UID 复活下 positions 始终连续；
- 伏笔 overdue 在「当前最大 position 等于预期位置」时即成立，且只依赖 `manuscript_position`，代码扫描不得再出现相关 `MAX(num)` 语义；
- 侧栏、REST、导出、统计、关联、AI 上下文和工具查询均不泄漏 tombstone 或旧 generation。

### 15.3 发布与崩溃恢复

在以下每个点注入异常和真实进程终止：

- journal prepared 前后；
- 每个文件候选写入、fsync、验证、替换、目标锁重试和目录 fsync 前后；
- 多文件闭包的每个成员之间；
- `files_published`、数据库 candidate、projection publish 和 completed 前后；
- route-fence CAS、source snapshot、files candidate、child file journal、database candidate、activation intent 和最终 candidate 原子发布前后；
- 冲突 backup 落盘前后。

断言：权威文件集和 SQLite 投影只能形成 journal 允许的完整 before 或完整 after，第三种状态绝不被自动覆盖。

下一进程取得 writer lease 后必须先按父子 journal 顺序恢复，再提供普通服务，且恢复完成后脏路径集合被标记为全脏。

### 15.4 外部变化与草稿

- 同步点固定为「直接 feed 的 completion 已递增 observed，并已通过脏路径、脏目录或锁存的 `coverageLost` 完成 accounted」：该点之后任何读取只能来自刷新后的 generation 或返回定义错误，不得再有成功返回旧 generation 的读取；`observed > accounted` 本身就是拒绝 clean 的同步证据；
- 外部修改分别发生在同步点之前、查询进行中和结果序列化前三个位置，均满足上一条；
- **不断言**「外部修改后的下一次读取立即可见」。该断言与 9.1 节承认的事件投递延迟不能同时成立，测试必须以事件到达或显式刷新作为同步点；降级模式下同步点改为完全校验完成；
- 非 ignored 外部正文、sidecar 或结构变化在同步点之后不能命中忽略分支；`ignore_status = active` 只允许命中第 5.1.2 节的成员身份与容量重验分支，不能无条件丢弃 dirty；
- 直接 feed 事件按形状与大小写折叠别名规则过滤，非受控残留的变动不触发投影刷新；
- 在 `manuscriptChangeNotification = true` 的能力路径上，自我事件对消可证明：连续 100 次自动保存不触发任何一次完全校验；能力为 false 的降级路径不适用该性能断言；
- `ReadDirectoryChangesW` 成功零字节完成、`ERROR_NOTIFY_ENUM_DIR`、解析失败、重新布防失败、句柄失效和能力为 false 都先锁存 `coverageLost` 再收敛到完全校验，且降级模式在 UI 上可见；
- 使用可配置小缓冲区和独立高速写入进程强制溢出，断言要么覆盖全部规范路径，要么在任何 clean 观察之前取得零字节完成、`ERROR_NOTIFY_ENUM_DIR` 或更强的失败信号；测试本身必须把 false-clean 判为失败；
- 构造「原生 event 已 signaled、后台事件泵尚未运行、freshness gate 先到达」的用例，断言 gate 自己的零超时同步会消费完成并得到 dirty 或 `coverageLost`，不得依赖定时泵抢先运行；
- 构造「后台泵已取得 completion 并递增 observed、用备用缓冲区重新布防使 event 变为 nonsignaled、旧缓冲区尚未解析」的确定性交错，在该窗口并发执行查询前 gate 与查询后 gate；二者都必须因 `observed > accounted` 拒绝 clean，解析成功并原子写入 dirty 后才能递增 accounted，解析抛错或旧缓冲区丢失则先锁存 `coverageLost`，不得以重置计数器恢复相等；
- 构造「completion 已 accounted、路径已进入普通 dirty；refresher 把 dirty 移入 `refreshingDirty`，但尚未读取文件或提交 projection」的确定性交错，在 claim 后、文件读取后、projection commit 前和 commit 后但 claim 尚未清除四个点分别并发执行查询前后 gate；前三点都必须因 `refreshInProgress` 拒绝 clean，commit 后清除 claim 才可 clean；另构造 refresh 在一次查询的前后 gate 之间完整开始并结束，断言 generation/connection epoch 变化使旧结果丢弃；
- 完成一批通知后，在取得完成状态与下一次 `ReadDirectoryChangesW` 之间制造变化，断言该变化由句柄内部缓冲区在后续完成中交付，或者显式锁存 `coverageLost`；
- Bun 1.3.14 Windows x64 的直接 feed 原生矩阵已通过并把限定支持包络内的能力判为 true；生产适配器集成后必须重跑同一矩阵，Bun `fs.watch` 固定不参与能力判定；
- 启动顺序为先建立并布防三个直接 feed 再完全校验，构造「校验窗口内发生外部修改」与「校验窗口内 coverage loss」两个用例；前者保留脏证据，后者不得清除锁存或发布 false-clean；能力为 false 时断言常置全脏使下一次 gate 再执行完全校验；
- feed-state 并发测试必须证明 event 探测、armed、两个 completion 计数器、`refreshInProgress`、`refreshingDirty`、普通 dirty 与 `coverageLost` 来自同一个线性化快照，后台泵或 refresher 不能在 freshness gate 读取分散字段之间制造拼接出来的 clean；
- 资源预算测试同时打开两个 `files` 项目：两个普通会话都持各自 shared manuscript-lifecycle lease，但每个进程最多只有一个项目持有三组 direct feed，第二个项目保持 capability=false 与全脏；切换时旧项目的三个 pending I/O、句柄、event 和 6 MiB 用户缓冲区全部拆除后，新项目才可 starting，旧项目普通会话未关闭时仍保留 shared lease，且新项目必须完成首次完全校验才可 clean；
- active ignored 增量容量测试在 ignore 成功后由独立进程依次扩展正文到单文件超限、把总量推过 1 GiB、补齐或删除同 UID 配对文件、原子替换为不同文件身份，再触发 gate；每次都必须重新验证完整规范成员与容量 before/after，超限现场原样保留并持续阻断，snapshot 不完整则全脏，不能等到下一次手工完全刷新才发现；
- 写入前置的闭包 CAS 在外部抢先修改同一文件时返回 `EXTERNAL_CHANGE_CONFLICT`，且不发生任何文件副作用；
- 外部变化与已加载、已卸载、定时保存中的正文、标题、sidecar 或卷草稿相遇时均创建不可变 backup 并阻断覆盖；
- DraftConflictJournal 在 `backup_durable` 之前崩溃时该 conflict 被清除并重新检测；`backup_durable` 恢复后只能追加首个 `decision_ready(0)`，之后只有 `decision_ready` 可以接受用户决策，恢复流程不自动选边；
- 两个意图态在任何副作用前落盘：在 `resolve_apply_intent(epoch)` 之后、child `completed` 之前强杀，child 收敛到完整 files before 时父依次追加 `resolve_apply_aborted` 与 `decision_ready(epoch + 1)`，收敛到完整 files after 时父追加 `resolved_apply_draft`，不得无事件倒退或直接转 `superseded`；
- 父子顺序可证明：child 未到 `completed` 时父不得出现 `resolved_apply_draft`，child 未终结时父不得出现 `archived`，child 不得写父状态；
- 每次 apply 中止都递增 decision epoch；旧 epoch 请求、迟到重试和旧 child journal 全部 stale，不能影响新一轮决策；
- 外部再次改变时，`backup_durable`、`decision_ready`，或 projection 仍精确为 before 的 `resolve_accept_intent` 才可转 `superseded`；若 accept 目标 generation 与资源 raw hash 已提交，必须先终结为 `resolved_accept_external`，再为后续文件变化新建 conflict，不得把已生效接受记成 superseded；`resolve_apply_intent` 必须先按上一条恢复 child，backup 保留，新 conflict 的 `supersedes` 指向旧 conflict；只有 `archived` 与 `superseded` 参与回收，其余状态永不回收；
- 在 accept projection commit 已成功但 `resolved_accept_external` 未落盘处强杀，再次外部修改同一文件后恢复；恢复必须先凭目标 generation 与已接受 raw hash 终结旧 accept，再检测新变化，断言审计顺序为 `resolve_accept_intent → resolved_accept_external` 后接新 conflict，而不是旧 conflict 直接 `superseded`；
- 外部 `status` 变化使 pending 提案转 stale，仅移动/重排不转；
- `accept_external` 和 `apply_saved_draft` 的 CAS、重试、stale 和崩溃恢复可证明；
- 两个进程同时刷新/写入时仍由 L1 writer lease 串行，外部编辑器变化触发 hash 冲突。

### 15.5 迁移

- `sqlite` 项目选择「稍后升级」后路由、journal、UID reservation、目标文章根和数据库业务字节均不变，项目立即继续 L1 普通读写；重复延期幂等；
- 用户未显式启用 L2 实验入口且状态不是 `DEFAULT_READY` 时，普通新项目继续创建为 `sqlite`，既有项目不进入主动迁移流程；实验入口创建或迁移的 `files` 项目仍执行全部正式耐久协议；
- 用户确认「立即升级」之前不得创建 `migration_reserved`；确认后先完成草稿处理、风险说明和备份确认，再取得两个 lease 并进入迁移；
- 新项目走 ProjectCreationJournal 而非 route-fence，路由键出生即为 `files`，全程不出现 `migrating`，不依赖 Git；
- 第 12.9 节九个步骤的每个前后都注入强杀：应用级 ProjectCreationJournal 始终位于目标数据库、目标项目 ControlStore、规范 sibling manuscript-lifecycle lock 和文章根之外；`activation_intent` 之前的任意点崩溃后，要么凭该父 journal 证明全部目标属于本 `creation_id`，写 `creation_abort_intent` 后整体移除目标对象并终结为 `creation_aborted`，要么进入 `RECOVERY_REQUIRED`；成功中止后四个目标路径重新缺席、`project_uid` reservation 在原父 journal 中标记为 `aborted`，且中止删除前从未建立普通 `files` session 或 direct feed；
- 崩溃在第 7 步的 `activated` 与第 8 步的 `listed` 之间时，项目已完整可用但不在列表中，下一次启动能从稳定的应用级创建控制根发现父 journal 并补写缓存索引，且不产生第二个项目；`activation_intent` 之后只能前滚到 `completed` 或进入 `RECOVERY_REQUIRED`；
- `migration_reserved` 在 route-fence CAS 前持久化且没有路由或目标副作用，CAS 前崩溃可在验证目标缺席后安全终结 reservation 并继续 sqlite；
- 缺失 `manuscript_route` 键的既有项目被正确视为 `sqlite`；
- route-fence 是任何目标副作用前的首个 CAS；
- route-fence 后、文章候选前在 ControlStore 父目录创建并 fsync 规范 `.manuscript-<hash>.lifecycle.lock`；若 migration 的 before 为 absent，安全中止凭 journal 删除并 fsync 父目录，before 已存在则验证并保留；新建项目在 `project_control_ready` 内创建同一 sibling 文件并把它列为第四个可清理目标；路径别名、reparse、硬链接、错误实名或物理身份变化全部使 capability fail-closed，普通 admission 不临时补建；
- migrating 的所有普通入口都返回 `PROJECT_MIGRATION_BUSY`；
- route-fence CAS 成功后 UI 不再提供「稍后升级」或普通编辑器入口，只提供同一 migration ID 的进度、恢复、诊断和协议允许的安全中止；
- MigrationJournal 是唯一顶层所有者，child FilePublicationJournal 不能独立提交 projection 或路由；
- UID 由可替换的 CSPRNG test seam 生成规范 UUIDv4；负向注入重复值、当前 active/tombstone/`active | revoked` ignored UID、现存 `project_uid`、仍存在的 ProjectCreationJournal project UID、任一未终结或尚未 GC 的 MigrationJournal project UID、同一 L1 项目控制身份下尚未 GC 的成功或中止 MigrationJournal chapter/volume UID 和已存在文章根碰撞，断言各值按对应命名空间在 reservation 落盘前重新生成且同一映射内无重复；任一当前注册项目 ControlStore 或同源 reservation 无法完整扫描时 reservation 零目标副作用阻断；
- UID 映射在 `migration_reserved` 或 `creation_reserved` 落盘时即冻结，preflight、route-fence、崩溃恢复和同一 journal 重试路径均不再生成新映射；构造断言证明同一 migration ID/creation ID 在任意崩溃点重试后 UID 逐项相同，落盘后才发现碰撞则返回 `UID_RESERVATION_COLLISION` 且不得改写 reservation；
- 普通新建章节/卷对 CSPRNG 注入 tombstone、revoked ignored、active ignored、同项目尚未 GC 的 MigrationJournal 对应种类 reservation、现存规范路径和大小写别名碰撞，断言 FilePublicationJournal `prepared` 前重生成；同项目 reservation 枚举失败时零文件副作用阻断；prepared 后 UID、目标整数 ID/编号与 after-absent 谓词冻结，在 prepared 后每个强杀点以同一 logical request 重试都逐项复用，晚到碰撞只能收敛完整 before 或返回 `UID_RESERVATION_COLLISION`/`RECOVERY_REQUIRED`，不能意外复活或接管旧 UID；
- 中止点边界可证明：`files_published` 之后、`activation_intent` 之前，若 child 收敛到完整 files before 则中止成功且路由回到 `sqlite`；`activation_intent` 之后的中止请求被拒绝，只能前滚或 `RECOVERY_REQUIRED`；
- 安全中止把路由 CAS 回 `sqlite` 并留下诊断记录，项目立即可正常读写，不存在无法离开的失败路由；
- 安全中止只把 UID reservation 在原 journal 中标记为 `aborted`，终态父 journal 满足 child 终结、清理债务归零、config.db 一致且无活动引用后进入 30 天保留期；实现不存在全局永久 UID 表或未定义的应用级 UID checkpoint，验收不得声称能证明已回收历史中的 UID 永不复用；
- MigrationJournal 非终结 reservation 永不 GC；分别构造 `migration_aborted` 与 `activated` 的 GC 门禁，只有第 12.6 节谓词满足才进入 L1 bounded GC，实际存在期间 project reservation 继续参加全局碰撞扫描、chapter/volume reservation 继续参加同源项目对应种类扫描，GC 后 activated UID 仍由 registry/数据库/文章根可见，aborted UID 明确只剩 CSPRNG 概率保证；
- 源数据库和迁移前备份始终保留；
- 编号、伏笔位置或 schema 依赖不明确时除 route fence/journal 外零目标副作用；
- 最终激活是**一次** candidate 原子发布，同时使 schema 12 投影与 `manuscript_route = files` 可见；构造断言证明不存在「投影已提交但路由仍为 migrating」或反之的中间可观察状态；
- config.db 路由缓存索引被人为破坏或删除后可从项目数据库完整重建；
- 迁移成功后不存在 SQLite-authoritative 回退或双写路径；
- 应用入口与 CLI 使用同一 migration service 和 journal。

### 15.6 项目退役与数据根

- files 项目调用旧物理删除入口在首个文件副作用前失败；
- `manuscriptLifecycleLease` adapter 在 Bun 1.3.14 Windows x64 编译产物下用两个独立进程验证：同一规范锁实体允许 shared/shared，shared 阻断 exclusive，exclusive 阻断 shared/exclusive，全部 acquire 带 `LOCKFILE_FAIL_IMMEDIATELY` 且竞争稳定映射 `PROJECT_WRITE_BUSY`；真实路径与允许入口别名汇聚到同一物理锁，不能各持一把互不相见的锁；
- 强杀 shared/exclusive owner 后另一进程最终可取得锁；`UnlockFileEx`、`CloseHandle`、符号缺失、锁文件身份变化和 release disposition unknown 逐项故障注入，只有 close 已知成功可证明释放，其余 controller fenced 或 `MANUSCRIPT_LIFECYCLE_UNAVAILABLE`；验证锁序不存在 shared→exclusive 原地升级，也不存在退役持 writer 等待已经 admission 的本进程请求；
- 有 direct-feed slot 与没有 slot 的两个独立进程普通会话都持 shared manuscript-lifecycle lease；`files → retired` 先在 registry/config lease 下把本进程 controller 切为 `retiring` 并阻止新请求 admission，释放该 lease 后无锁排空在途请求，归零后重新取得 registry/config 并复核，再取得 writer、拆除本进程 feed、关闭会话、释放本进程 shared，最后非阻塞取得 exclusive；确定性交错分别把普通请求停在“admission 已成功、registry/config lease 尚未申请”和“admission 已成功、writer lease 尚未申请”处再启动退役，断言请求都能先取得所需 lease 并结束，退役不得持续持有 registry/config 或提前占有 writer 等它；任一其他普通会话仍存活都以 `PROJECT_WRITE_BUSY` 零路由副作用失败，全部会话关闭后 CAS 才可成功，且不改变任何项目资产字节；
- `retired → files` 在 exclusive manuscript-lifecycle lease 下只改变路由与缓存索引，不复用旧 feed 状态；首个普通会话重新取得 shared、复核 route/身份，重新布防并完成首次完全校验后才开放普通读取；
- retired 项目不接受普通路由，不持有 direct feed 资源，但可以在专用列表中重新激活；
- 构造普通 admission/feed 启动与退役 CAS 的跨进程竞态：启动方取得 shared manuscript-lifecycle lease 后必须重读 route、身份，以及“父 journal 存在则成功终态”的条件，不能凭 lease 前的 `files` 快照在 retired 项目上接纳普通请求或打开句柄；已合法 GC 的成功父 journal 不导致降级；退役方取得 exclusive lease 后不能被新的 shared owner 穿入；
- 存在 files/migrating/retired 项目或非终结 ProjectCreationJournal 时，数据根设置与迁移零修改拒绝；
- 云同步目录检测在创建项目、迁移和设置数据根三个入口都给出引导而非运行时错误码；
- 并发打开、写入、迁移和退役由 registry/config lifecycle lease、项目 writer lease 与 shared/exclusive manuscript-lifecycle lease 正确串行；强杀普通 session/feed owner 后由 Windows 释放句柄与锁，下一进程仍不得跳过 route/身份复核与首次完全校验。

### 15.7 回归门禁

- 第 1.1 节的五条 L2 前置门禁全部满足，且状态在验收账本中逐条记账；
- L1 全部 correctness、故障注入、恢复、writer lease、canonical trigger 和 downgrade DML 测试继续通过；
- 服务端、客户端、contracts、TypeScript、lint、构建与 Desktop smoke 全绿；
- 增加静态门禁：文章真值 SQL 直写、受控文件直写、章节/卷物理 DELETE、`manuscript_*` 保留键的业务侧写入、未经过 freshness gate 的活跃文章查询和旧伏笔编号语义均不得新增；
- L1 的 native 性能已在第 1.1 节的前置门禁中实测通过，因此 L2 验收时不存在「L1 已批准延期的性能证据」这一类目；L2 只对本层增量独立记账，不得伪装为 PASS，也不得通过缩小 fixture 或放宽既有阈值关闭。
- `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED` 构建只能通过显式实验入口触达 `files`，普通项目创建与旧项目打开保持 `sqlite`；任何默认路由、默认迁移提示或面向普通用户的完成声明都由第 16.1 节 `DEFAULT_READY` 门禁阻断。

## 16. 性能与容量

### 16.1 目标

基准项目为 3,000 章、约 30–40 MiB 正文：

| 场景 | 目标（p95） |
|---|---:|
| 章节列表 / 侧栏快速读取 | `< 150 ms` |
| 编辑器自动保存端到端 | `< 300 ms` |
| 其中 L2 增量（闭包 CAS + 文件发布 + 投影发布之文件侧） | `< 120 ms` |
| 显式完全刷新 | `DEFAULT_READY` 前按 3,000 章与边界 fixture 校准并以规格补丁固化 |
| 启动完全校验 | `DEFAULT_READY` 前按 3,000 章与边界 fixture 校准并以规格补丁固化 |

自动保存的 300 ms 是端到端预算，其中数据库事务部分继承 L1 的 native 目标。把 L2 增量单独列出，是为了避免出现「L1 超预算、L2 也超预算，但两边都说是对方的问题」这种记账方式。

只有 `manuscriptChangeNotification = true` 时，本版的新鲜度模型才会使正常读取路径退化为查询前后各三个 event 的零超时探测加内存判断，并让 150 ms 实际由 SQLite 查询主导。第 2.5 版选定的 `ReadDirectoryChangesW` 直接 feed 已通过原生证据矩阵，因此平台原语这一项性能前提成立；但生产适配器、完整读取链与容量基准尚未实施，不能把目标模型的数字当成 Windows 已完成的性能验收结论。

普通 `files` 会话还要求 `manuscriptLifecycleLease = true`；该 adapter 的 shared acquire 在 session admission 时发生而非每次查询，但锁竞争、路径/身份校验和 session 切换成本必须单独记账。capability=false 不是性能降级分支，而是普通 `files` admission 的 fail-closed 错误，不能用全量扫描绕过跨进程退役屏障。

完全校验现在是仅有的昂贵路径，且它的成本由文件打开次数而非字节数主导，实时扫描介入时可达秒级。因此启动完全校验必须以用户可见进度呈现，不得表现为无响应；显式刷新必须可取消。

Windows 默认激活路径不得通过每次普通读取或每次写入全量 SHA-256 达成正确性；能力为 false 时的常置全脏只允许作为用户可见的降级模式，不得在没有独立容量与性能批准时伪装成满足本节目标的默认实现。

第 9.1 节的每进程单槽预算意味着性能门禁只对持有 direct-feed slot 的活动项目成立；同一进程内未持槽项目走常置全脏降级，不得把它的完全校验延迟混入默认正常路径样本，也不得借此宣称多项目并发满足 `< 150 ms`。若未来需要同时 armed 多个项目，必须以规格补丁增加显式总字节预算并重跑内存、句柄、切换与压力验收，不能只调大常量。

性能状态固定为两级，不再用一个含糊的“完成”同时表示 correctness 和默认可用：

- `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`：正确性、故障恢复和迁移验收已经通过，但 L2 性能证据可保留为 `DEFERRED/NOT_RUN`；代码可以合并，`files` 只能通过测试环境或用户显式启用的实验入口触达，普通新项目和旧项目继续走 `sqlite`，不得宣称 L2 已默认就绪；
- `DEFAULT_READY`：3,000 章、30–40 MiB 基准下，章节列表/侧栏 `< 150 ms`、自动保存端到端 `< 300 ms`、L2 文件侧增量 `< 120 ms` 三项 p95 必须全部实测通过；不得用缩小 fixture、降低采样、排除慢样本或把成本记到 L1 的方式关闭门禁。

显式完全刷新和启动完全校验在 L2 v1 不预先写死一个未经测量的数值，但 `DEFAULT_READY` 前必须分别在 3,000 章正常基准和第 16.2 节 10,000 章/1 GiB 边界 fixture 上完成校准，记录 p50/p95/max、文件数、字节数、冷/热缓存条件和安全软件状态，并把最终阈值以规格补丁固化。两条路径都必须在 UI 主线程之外执行，启动显示可见进度，显式刷新可取消；未校准、无进度或不可取消均不能达到 `DEFAULT_READY`。

L1 的 native transaction p95 与端到端保存 p95 不适用任何 L2 延期条款。它们是第 1.1 节的开工硬门禁，必须在 L2 启动前实测通过，不存在带着未达标数字开工的选项——L2 在每次写入之上叠加文件发布，数据库侧未达标时上表的 120 ms 增量预算无从校准。

### 16.2 L2 v1 硬安全上限

- 最多 10,000 个不同章节身份，按活跃章节、章节 tombstone 和忽略身份账本中 `active | revoked` 章节 UID 的集合并集计数；
- 最多 2,000 个不同卷身份，按活跃卷、卷 tombstone 和忽略身份账本中 `active | revoked` 卷 UID 的集合并集计数；
- Markdown 单文件 16 MiB；
- JSON 单文件 256 KiB；
- 五种规范受控文件形状的实际文件总数 25,000，其中 `chapters/` 单目录最多 20,000 项；`active` ignored UID 对应的资源文件仍逐个计数；
- 受控树原始字节总量 1 GiB，包含 `active` ignored UID 对应资源文件按文件大小计得的全部字节。

这些数值是正确性与资源安全支持包络，不是所有边界项目都必须满足 3,000 章基准的正常路径 p95。3,000 章、30–40 MiB 仍是第 16.1 节默认激活性能 fixture；10,000 章/1 GiB 用于边界正确性、流式资源控制、启动/刷新校准和超限负向测试。

实现必须在项目打开、完全校验、迁移、忽略/撤销忽略动作、active ignored 文件的每次外部增量变化，以及可能增加计数或字节数的应用写入中流式计数并尽早失败，不得先把超限树完整读入内存。ignored 文件可以跳过内容解析，但不能跳过实名、文件身份、单文件大小、目录项数量、累计字节与身份账本计数；任一维度超过上限都返回 `MANUSCRIPT_CONTENT_TOO_LARGE` 并报告触发维度、实测值和允许值。应用发起的动作必须保持既有权威字节和忽略状态不变；外部工具已经写入的超限现场原样保留、dirty evidence 不清除且普通服务继续阻断，应用不得谎称能撤销外部字节。

章节和卷 tombstone 以及忽略身份账本的 `active | revoked` 记录计入合并上限，意味着该上限约束项目生命周期内保留的身份数量，删除对象、删除 ignored 文件或撤销忽略都不会释放对应 UID 容量。L2 v1 不提供删除 tombstone、物理删除身份账本记录或复用 UID 的出口；达到任一身份上限的 80% 时 UI 必须显示一次可持续查看的容量预警并写入诊断包，达到上限后只能继续编辑既有对象、导出或迁移到未来明确支持更高包络的版本，不能通过清理身份记录绕过。

## 17. 已固定的产品决定

1. **容量画像：** 采用第 16.2 节全部数值作为 L2 v1 硬安全上限，活跃对象、tombstone 与 ignored 身份账本合并计数，ignored 资源文件仍计文件数与原始字节；3,000 章是默认激活性能基准，10,000 章/1 GiB 是边界正确性与全量路径校准 fixture。
2. **迁移延期：** 允许 `sqlite` 项目在用户确认前反复选择「稍后升级」并继续 L1 写作，且延期零副作用；一旦 route-fence CAS 为 `migrating`，普通入口全部阻断，直到迁移前滚、协议化安全中止回到 `sqlite` 或进入 `RECOVERY_REQUIRED`。
3. **性能门禁：** correctness 代码可以以 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED` 合并并进入显式实验路径，但普通新项目与旧项目仍走 `sqlite`；只有三个正常路径 p95 通过且启动/刷新完成边界校准、进度与取消验收后，状态才可变为 `DEFAULT_READY` 并默认启用 `files`。

本版另有两处已按推荐值落笔、可低成本回退的产品判断，见第 7.4 节与第 9.3 节的引用块：伏笔 overdue 由「严格大于」改为「大于或等于」；外部修改 sidecar `status` 也使 pending 提案转 stale。

外部结构变化、未知文件处理、files 项目删除、路由真值归宿、L1 前置门禁、容量画像、迁移延期和性能门禁均不再是开放项，它们已分别由 D6、第 5.1、9、12.1、13、1.1、16.2 和本节固定。第 17 节当前没有待确认产品问题。

## 18. 完成定义

L2 只有在以下条件同时成立时才可宣称完成：

- 第 1.1 节的五条 L2 前置门禁全部满足；
- 新项目和已迁移项目以权威文件为文章域唯一真值源；
- 所有文章写入经 ManuscriptService、FilePublicationJournal 和 SQLiteProjectionStore；
- 所有正常读取经 `ensureReadableProjection()` 和 ActiveManuscriptProjection；
- 任意被检测到的受控文件变化都被刷新、拒绝或进入冲突状态，不存在忽略后返回旧投影；未检测窗口按第 9.1 节有界声明并在降级模式下对用户可见；
- Windows 默认激活所用的 `ReadDirectoryChangesW` 直接 feed 已通过第 9.1 节证据矩阵并把 `manuscriptChangeNotification` 置为 true，production adapter 的 observed/accounted、refresh claim、generation/epoch 线性化竞态测试和每进程单槽资源预算也全部通过；或者产品明确批准能力为 false 的常置全脏模式且该模式通过单独的容量、性能与 UI 验收；Bun `fs.watch` 不参与该判定；
- Windows `LockFileEx` manuscript-lifecycle adapter 已通过 shared/exclusive、路径别名、强杀释放、故障映射和固定锁序的双进程编译产物矩阵并把 `manuscriptLifecycleLease` 置为 true；没有该能力时不得接纳普通 `files` 会话或退役；
- 受控树对象的四分法生效：结构根与 journal 候选各有合法归属，常规编辑器与操作系统临时文件不阻断读写，孤儿资源阻断且有就地忽略出口，大小写别名硬失败；被忽略的索引成员在普通重写中保留，含不透明引用的容器在显式转移或解除引用前不可删除，active ignored 的每次外部增量也重验成员身份与容量，ignored 身份与文件不能绕过任一容量上限；
- 外部创建的判定基于投影新颖性而非孤儿性，索引被同步修改也无法绕过；
- `chapters.content` 除第 4.5 节 `U+0000` 只读透传例外外，是同 generation 的精确派生缓存，不是第二真值源；例外文件的 content 不可用状态与 raw hash、word count、generation 同样可证明；
- 外部变化与全部文章字段草稿冲突都有可恢复出口，DraftConflictJournal 的每个 apply intent 都先恢复 child 再决定父状态，accept projection 已提交时必须终结 accepted 审计后再处理新的外部变化；
- UID 由 CSPRNG UUIDv4 生成，在 reservation/prepared 落盘前按命名空间扫描当前 registry、所有仍存在的 project reservation、同源 MigrationJournal chapter/volume reservation、项目 active/tombstone/ignored 身份与目标路径，并随 MigrationJournal、ProjectCreationJournal 或普通创建的 FilePublicationJournal 冻结，同一 logical request 重试逐项复用；L2 v1 不声称存在全局永久 UID 表；tombstone、positions、伏笔位置、RESTRICT 外键、部分唯一编号索引和 downgrade guard 无损迁移并通过完整性检查；
- 第 16.2 节全部硬安全上限在打开、完全校验、迁移、忽略状态变化、active ignored 外部增量和应用写入上统一执行，3,000 章正常 fixture 与 10,000 章/1 GiB 边界 fixture 的通过条件不混用；应用超限动作零权威副作用，外部超限现场原样保留并持续阻断，二者都稳定返回 `MANUSCRIPT_CONTENT_TOO_LARGE`；
- 路由真值在 `project_meta`，缓存索引可完整重建，最终激活是单次 candidate 原子发布，不存在双主窗口，也不存在无法离开的失败路由；
- MigrationJournal、应用级 ProjectCreationJournal 与各自 child FilePublicationJournal 都只有一个顶层所有者和确定恢复顺序，创建中止不会删除自己的父 journal；
- 迁移、文件发布和投影发布的全部故障点只产生完整 before/after 或受保护的 `RECOVERY_REQUIRED`；
- files 项目只能在全部普通会话（包括无 feed slot 的降级会话）和 direct feed owner 经 exclusive manuscript-lifecycle 屏障退出后非破坏性 retired，retired 项目不持有 session lease 或 feed 资源，旧物理删除路径不能触达项目资产，数据根命令在首个副作用前拒绝；
- 用户可见迁移、冲突、诊断、退役、降级模式与恢复入口完成，含从章节直达文件的宿主入口；
- `sqlite` 项目的「稍后升级」零副作用且可继续 L1，进入 `migrating` 后所有普通入口与延期按钮消失，只保留协议允许的迁移、恢复、诊断和安全中止；
- 不存在 Git 依赖、L1 资产隐式搬迁、SQLite/文件双主、旧正文直写、章节/卷物理 DELETE 或无 freshness gate 的正常文章读取；
- `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED` 只允许显式实验入口且所有未执行证据明确保留为 `DEFERRED/NOT_RUN`；L2 只有在第 16.1 节 `DEFAULT_READY` 全部门禁通过后才能宣称完成并把 `files` 设为默认路由。
