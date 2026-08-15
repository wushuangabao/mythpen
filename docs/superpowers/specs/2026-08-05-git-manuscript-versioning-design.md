# Git 文章版本管理设计

日期：2026-08-05
状态：**长期目标文档，不再是 V1 范围定义。** V1 的交付范围见 `2026-08-06-manuscript-durability-and-versioning-v1-scope.md`；本文的不变量、状态机与威胁模型在各层实施时逐条引用，其中受前提决策影响而删除或简化的条目见该文档第 9 节。

## 1. 目标与范围

Mythpen 为每个项目提供基于 Git 的文章内容版本管理：作者和 AI 可以查询工作区改动、创建本地存档点、浏览章节历史，以及安全地恢复一个章节的历史**正文**。

第一版提供后端、受信任本地宿主能力和 AI 工具协议；不新增“版本与协作”页面、侧栏入口或专用状态栏。现有聊天必须支持一个通用的内联确认卡，它只是已有消息流中的确认事件，不构成新页面。未接入这个可信宿主的调用方只能查询和预览，不能提交、恢复或解决冲突。

第一版只支持 Mythpen 创建并绑定的本地专用仓库。远端 `fetch`/`push`、分支协作、章节认领、同章节并发编辑和内置三方合并均不在范围内。用户可以在该仓库的工作区直接编辑 Markdown，也可以用标准 Git 在固定 `main` 上提交受控文件；应用会验证这些外部变化，而不会把它们视为 AI 的可执行命令。

## 2. 已确认的产品决策

- 每章正文从一开始就是一个独立 Markdown 文件；Git 是正文、章节元数据和卷结构的版本历史载体。
- Markdown 正文、章节 sidecar 和结构清单构成文章权威层；SQLite 是本机查询投影和非文章数据的存储，不再是正文唯一权威来源。
- Git 管理卷/章节结构、标题、大纲、长期章节状态、摘要、五个叙事维度和正文；项目显示名称、简介、作者、语言、题材、模式、角色、世界观、时间线、AI 会话、AI 待审提案、统计、界面状态、本机操作日志和工作流阶段不进入第一版 Git 格式。
- 自动保存只更新文章工作区文件，绝不自动创建 Git commit。常规存档、恢复、冲突解决和接受 AI 提案均须由真实用户明确触发或确认。
- 模型只能提出**准备类版本操作**，不能签发、伪造、复用确认，也不能在确认后直接执行写入或 Git 操作。由用户明确写作请求触发的普通章节创建/更新，以及作者在共创分卷规划中明确确认后的卷创建/改名，仍可使用受控领域工具，但必须经过文章服务和写入协调器，且绝不能创建 commit、恢复历史、解决同步冲突或接受待审提案。
- 第一版不支持两个人同时编辑同一章节。外部工作区变化与本地草稿并存时，保留草稿并阻断覆盖，不做隐式合并。
- 单章正文与元数据是同一个章节资源域，但一次 commit 只包含实际变更的 `.md`、`.json` 成员；卷顺序、创建、移动、删除和重排属于显式结构操作，不能被悄悄夹带进单章存档。AI 仅可在用户明确创作请求中创建新章节，或在共创分卷规划得到作者明确确认后创建/改名卷，并声明完整结构闭包；删除、移动和重排不作为普通 AI 工具暴露。
- “删除项目”默认是可恢复归档，不是删除 Git 历史；永久清除项目资产是独立、明确且破坏性的本地维护操作。

## 3. 为什么不能复用现有导出

当前 Markdown 导出从 SQLite 读取全书章节，拼成一个展示/发布文件，附带卷标题和统计尾注；它没有反向导入契约。把该导出文件提交到 Git 会让正文、章节结构和 SQLite 状态变成双主。

现有正文还会经人工编辑、REST 章节 CRUD、AI 工具循环、AI 续写和 AI 润色接受等多条路径直接写入 `chapters.content`。迁移后这些路径必须全部经过同一个文章服务，不能在既有 SQL 写入后补一个异步导出步骤。

## 4. 权威文件、身份与本机投影

### 4.1 受控仓库格式

一个已启用项目绑定一个专用仓库。第一版只把根目录的 `.gitattributes`、`.gitignore` 和 `mythpen/` 视为受控路径；应用不读取、暂存或提交其他路径。

~~~text
<repository>/
  .git/
  .gitattributes
  .gitignore
  mythpen/
    manuscript.json
    volumes/
      vol_<volume_uid>/
        index.json
        chapters/
          ch_<chapter_uid>.md
          ch_<chapter_uid>.json
    unassigned/
      index.json
      chapters/
        ch_<chapter_uid>.md
        ch_<chapter_uid>.json
~~~

目录和文件路径只能由校验通过的 UUID 推导；服务绝不信任清单中的任意路径、文件名或目录映射。

- `manuscript.json` 保存格式版本、不可变 `project_uid`、有序 `volume_uid` 列表，以及有序 `unassigned_chapter_uids` 列表。项目显示名称、简介、作者、语言、题材、模式、目标字数、工作流阶段和界面偏好只由本机 `project_meta`/`project_genres` 拥有；`recent_projects` 只是可重建的活动目录索引，不能充当身份或绑定事实来源。
- `vol_<volume_uid>/index.json` 保存该卷的 `volume_uid`、标题、摘要和有序 `chapter_uids`；章节的标题、状态和叙事字段不在这里重复保存。
- `unassigned/index.json` 是固定的“未分卷”集合标记，保存同一份有序 `chapter_uids`；它必须与 `manuscript.json.unassigned_chapter_uids` 完全一致，并与总清单作为一个结构性文件闭包原子校验/发布。它不代表 SQLite 中的一条伪造卷记录。
- `ch_<chapter_uid>.md` 只保存该章节的 Markdown 正文。
- `ch_<chapter_uid>.json` 保存 `chapter_uid`、`volume_uid`（UUID 或 `null`）、`chapter_number`（`1..9007199254740991` 的正安全整数）、标题、大纲、长期章节状态、摘要和五个叙事维度。长期状态只能是 `pending`、`writing`、`review` 或 `accepted`。它**不保存正文哈希**。

每个 `git_ready` 项目的 SQLite 另有 `manuscript_binding`，保存并校验本机 `project_instance_id`、镜像的 `project_uid`、仓库规范真实路径/文件系统身份、文章层状态和格式版本。`project_uid` 必须每次从权威 `manuscript.json` 交叉校验；二者不一致即拒绝服务。`project_instance_id` 永不写入 Git，归档恢复或同名新建都必须生成新的实例 ID。`sqlite_legacy` 在迁移前只有 registry/LegacyControlStore 的 legacy identity，不能伪造 `manuscript_binding`。

本机资产也不得由显示名称寻址。第一版为每个活动的 `git_ready` 项目实例分配服务端生成、调用方不可指定的 UUID `project_storage_key`；项目数据库、封面、项目 ControlStore、暂存目录和恢复副本都只能由该 key 在受管根内推导，文章仓库仍由稳定 `project_uid` 推导。新建 Git 项目同时生成新的 `project_uid`、`project_instance_id` 和 `project_storage_key`；归档恢复保留 `project_uid`，但必须生成新的 instance/key。`display_name`、REST 路由中的项目名和 `restore_project(..., target_name)` 的 `target_name` 都只是显示/唯一性字段，绝不能成为路径片段、文件名或 glob；导出显示文件名也必须由受控生成的 opaque `export_id` 加固定扩展名组成。Git 项目的应用级注册表保存 `{ project_uid, project_instance_id, project_storage_key, display_name, active_state }`，以 UID/key 定位资产；`sqlite_legacy` 的对应记录由第 4.1 节的 `legacy_project_instance_id`/`legacy_asset_manifest` 定位；`recent_projects` 只是两者的可重建 UI 索引。

遗留名称式路径（例如 `<projects>/<name>.mythpen.db`、名称式封面目录和名称式导出记录）只可作为 legacy 注册、迁移或首次生成 `legacy_asset_manifest` 时的受控输入：必须以真实路径验证其位于旧受管根内，拒绝 reparse point、junction、硬链接绕出和重复归属；后续归档、恢复和迁移都只消费已验证 manifest，绝不再从显示名推导路径。迁移目标永远是由新 `project_storage_key` 推导的路径。不能证明安全归属的遗留项目返回 `LEGACY_PROJECT_PATH_UNSAFE`，不移动、不删除、不猜测。

处于 `sqlite_legacy` 的项目也可以在不迁移的前提下归档和恢复，但它绝不因此临时分配 `project_uid`、仓库或 `project_storage_key`。registry 必须为它保存经验证的 `legacy_project_instance_id`、`legacy_project_lease_key` 与受控 `legacy_asset_manifest`；归档/恢复只能使用这些已经登记的物理资产和服务端生成的 opaque 标识，不能再从显示名称反推任何路径。其专用协议见第 6.2 节。

章节资源域由同 UID 的 `.md + .json` 组成，但文件闭包只包含这次实际改变的成员：正文编辑通常只有 `.md`，元数据编辑通常只有 `.json`，同时编辑时才包含两者。创建、删除、移动或重排时，闭包额外包含源/目标卷 `index.json`、作为源/目标时的 `unassigned/index.json` 和必要的 `manuscript.json`。删除一个卷必须在同一结构闭包中移走或删除它的全部活跃章节，不能留下无父卷的活跃章节。预览必须逐项列出精确闭包；共享结构文件的变更若不能完全归入本次显式声明的结构范围，服务返回 `CHECKPOINT_SCOPE_INCOMPLETE`，不暂存任何文件。

`project_uid`、`chapter_uid` 和 `volume_uid` 必须是跨设备、跨克隆稳定的 UUID。SQLite 的 `chapters.id`、`volumes.id` 和本机 `project_instance_id` 仅用于本地 API、外键和识别陈旧请求；它们不是 Git 身份，也不能作为协作身份写入提交 trailer。

所有 JSON 采用稳定键顺序、UTF-8 无 BOM 和 LF 换行；`.gitattributes` 固定文本换行。路径 UID、文件内 UID、卷归属和索引成员必须交叉校验；未知字段、重复 UID、非法 UUID、重复索引成员和孤儿文件一律拒绝，不得静默丢弃或重写。`word_count`、`updated_at` 等可推导或高频变化字段不写入权威文件。受控当前树的 Markdown 单文件上限为 16 MiB，JSON/属性文件单文件上限为 256 KiB，受控文件总量上限为 64 MiB、总条目上限为 10,000；超限返回 `MANUSCRIPT_CONTENT_TOO_LARGE`，不得先完整读入内存再截断。

### 4.2 外部 Markdown 编辑与正文哈希

正文 SHA-256 只是本机派生证据，保存在 SQLite 投影、文件发布 journal 和操作快照中，使用文件的原始字节计算；它绝不进入 Git 版本化 sidecar，也不作为文件集有效性的前置条件。

因此，外部只修改 `ch_<chapter_uid>.md` 是合法输入。下次通过 `ensureReadableProjection()` 的正常读取，或任一写入中的 `ensureProjectionCurrent()`，会重新计算原始字节哈希、验证 UTF-8 和章节归属，并刷新 SQLite 投影；它不得要求外部工具同步修改 `.json`，也不得为了“补哈希”反写权威文件。Mythpen 自己写入正文时采用 UTF-8 无 BOM、LF 的规范形式；外部内容只有在被 Mythpen 的正文写入器实际修改后才可能被规范化。

Markdown 分为两个可明确观察的等级：

- **可视编辑方言**：普通段落、一级/二级标题、`**粗体**`、`*斜体*`、`__下划线__`、行内代码、三反引号围栏代码块和 `---` 分隔线。可视编辑器可结构化编辑这些内容。
- **只读透传 Markdown**：UTF-8 正文中出现该方言之外的构造时，历史、diff、外部 Git 提交和投影仍可保留原始内容；但可视编辑器、AI 续写、AI 提案应用和其他语义性整篇正文写入器必须锁定该正文并返回 `UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE`。元数据读取/写入可以继续，但不得重新序列化正文。第 7.2 节定义的正文原始字节 restore 是唯一例外：它只复制已经校验的历史 blob，不解析、不规范化，也不因此解除该锁定。

这一定义既不要求第三方编辑器理解 Mythpen 方言，也不承诺任意 Markdown 在进入可视编辑器后能字节级往返。

### 4.3 稳定整数 ID、删除与 tombstone

SQLite schema 必须为 `chapters.chapter_uid` 和 `volumes.volume_uid` 建立 `UNIQUE NOT NULL` 约束，并为活跃章节保存派生的容器内 `chapter_position` 与全书 `manuscript_position`。投影重建按 UID 查找并复用既有整数行，禁止把投影重建实现为删表重插或更换既有 `id`，以保持角色关联、伏笔/记忆关联和 `chapter_revisions` 等既有外键关系。

Git 中删除章节或卷意味着从活跃结构中移除相应文件和索引成员；SQLite 投影不得执行会触发级联关系删除的 `DELETE FROM chapters` 或 `DELETE FROM volumes`。它改为写入 `is_present = 0`、`deleted_at` 和最后已知 Git 身份。删除卷时，同一 SQLite 投影事务必须 tombstone 该卷及所有在该结构闭包中被实际删除的直接章节；明确移动到另一活跃卷/未分卷集合的章节则保留活跃身份。相同 UID 以后重新出现时，服务重新激活原来的整数行并恢复其关联；新 UID 才创建新行。

为允许 tombstone 保留历史编号，现有表级 `UNIQUE(volume_id, num)` 必须通过一次受控的 SQLite schema table rebuild 移除，再建立仅约束活跃、已分卷行的部分唯一索引：`UNIQUE(volume_id, num) WHERE is_present = 1 AND volume_id IS NOT NULL`，以及未分卷集合的 `UNIQUE(num) WHERE is_present = 1 AND volume_id IS NULL`。`chapter_position` 另建两个派生位置索引：`UNIQUE(volume_id, chapter_position) WHERE is_present = 1 AND volume_id IS NOT NULL`，以及 `UNIQUE(chapter_position) WHERE is_present = 1 AND volume_id IS NULL`；`manuscript_position` 另建 `UNIQUE(manuscript_position) WHERE is_present = 1`。该 DDL 迁移不是丢弃业务数据：它必须在迁移前备份，逐行保留 `chapters.id`、全部列值和所有外键值，重建引用约束，执行完整性校验与 `foreign_key_check` 后才切换。`chapter_number`/SQLite `num` 是兼容显示字段，不是身份，也不从索引顺序反推；它必须是正安全整数、可以非连续。外部文件若让同一活跃容器出现重复编号，视为无效结构而非静默重编号。

伏笔的“预计回收章节”不再使用裸编号：`foreshadows.expected_resolve_chapter` 必须替换为可空的 `expected_resolve_manuscript_position`，其非空值是正安全整数，并允许大于当前已创建章节数，以表达尚未创建的未来位置。`planted_chapter_id` 和 `resolved_chapter_id` 继续保存为稳定章节外键；未解决且未放弃的伏笔仅在当前最大 `manuscript_position` **严格大于**预期位置时计为 overdue，预期为空时不计逾期。任何 API、工具 schema、PromptAssembler、统计或页面不得再用裸 `num`、`MAX(num)` 或容器内 `chapter_position` 推断这个语义。

有活跃待审 AI 提案的章节不能被 **Mythpen 发起的**恢复、删除、应用冲突草稿或移动；准备操作返回 `PENDING_REVISION_BLOCKS_OPERATION`，用户必须先接受、拒绝或归档提案。外部已经发生的有效 Git/文件变化以第 5.2 节的外部优先规则处理。永久清除本机 tombstone 及其关联是独立、显式、破坏性的维护操作，不属于第一版，也绝不能由外部 Git 删除隐式触发。

### 4.4 顺序、活跃查询与本机 CRUD 身份

`manuscript.json.volume_uids`、每个卷的 `chapter_uids` 和 `unassigned/index.json.chapter_uids` 是唯一的结构顺序权威。投影在同一事务中把它们映射为 `volumes.sort_order`、每个容器内连续的 `chapters.chapter_position`，并按“卷顺序 → 卷内章节顺序 → 未分卷顺序”派生全书连续的 `chapters.manuscript_position = 1..N`。`manuscript_position` 只服务全书进度/统计，绝不写入 Git、充当章节身份或写入定位。重排、移动、tombstone 与同 UID 复活都必须重新写入受影响集合的连续位置。任何产品查询不得用 `num` 推导阅读顺序。

所有正常产品读取都必须先经过 `ManuscriptService.ensureReadableProjection()`，随后只在该次确认新鲜的 generation 上经过 `ActiveManuscriptProjection`：活跃卷满足 `volumes.is_present = 1`；活跃章节满足 `chapters.is_present = 1`，且其 `volume_id IS NULL` 或父卷也活跃。侧栏、REST 列表/详情、导出、统计、角色关联、AI 上下文、模型只读工具和默认直接 ID 查询都必须使用这两个边界；历史、诊断、恢复和明确维护接口才可读取 tombstone。任何入口不得先从 SQLite 读取旧投影、异步刷新后继续返回旧结果。投影触发器/约束还必须拒绝“活跃章节指向 tombstone 卷”以及“仍有活跃子章节时 tombstone 卷”，删除卷必须先 tombstone 被删除的章节再 tombstone 卷。

新 REST/桌面/AI 章节写入以本机稳定 `chapter_id`（Git 工具以 `chapter_uid`）定位，不再以 `volume_id + num` 作为主身份。兼容的旧编号路由只能服务于活跃、已分卷、正安全整数编号的章节，并在歧义时拒绝。未分卷章节必须能被列出、读取、更新、导出和按 `chapter_id` 删除；创建时允许显式 `volume_id = null`，其位置由结构操作确定。

## 5. 服务架构与一致性

~~~text
编辑器 / REST 章节 API / AI 工具 / AI 续写与提案生命周期
                                |
                                v
                       ManuscriptService
                                |
               +----------------+----------------+
                v                v                v
    ManuscriptWriteCoordinator  ManuscriptStore  SQLiteProjectionStore
                |                |                |
                +----------------+----------------+
                                 |
                                 v
       ControlStore / DraftCoordinator / ApprovalService
                                 |
                                 v
                            GitService
~~~

### 5.1 项目级写入协调器

每个已绑定项目的 `project_instance_id` 必须有一个 `ManuscriptWriteCoordinator`。它包含进程内 FIFO 队列，且必须取得位于不随项目归档移动的应用稳定锁根、绑定项目 UID/仓库物理身份的**跨进程 OS writer lease**：使用持续保持句柄的独占文件/字节范围锁（Windows 为 `LockFileEx` 或等价机制），而不是 PID、时间戳或“锁文件存在”判断。lease 元数据可记录进程启动随机 ID、boot ID、PID 和持有时间，但仅供诊断；PID 或 journal nonce 本身不能证明所有者已退出。所有可能写入权威文件、**项目数据库任意表**、ControlStore/journal、Git 元数据，或会因 `ensureReadableProjection()` 判定后执行 `ensureProjectionCurrent()`、初始化和恢复而写入的路径，必须先取得 `OS writer lease → 进程内 FIFO`。lease 获取失败返回 `PROJECT_WRITE_BUSY`，持有句柄失效返回 `WRITER_LEASE_LOST` 并停止后续副作用；进程崩溃由 OS 释放句柄，下一进程取得 lease 后必须先恢复 journal。REST 自动保存、角色/世界观等非文章 CRUD、AI 续写、提案应用、章节/卷结构修改、恢复、冲突解决、投影刷新、初始化/迁移、项目归档和所有 journal 恢复都必须经过它；没有例外的直写 SQL 或直写文件路径。

`sqlite_legacy` 项目尚无 `project_uid`、仓库或 `project_storage_key` 时，必须先在稳定 registry 中持久化 `legacy_project_instance_id`，并以它与已验证的源数据库物理身份组成 `legacy_project_lease_key`。普通遗留打开/读写固定按 `data_root_maintenance_fence` 的**共享 gate → legacy_project_lease_key → FIFO** 取得协调边界；它与 Git 项目的 lease 使用相同失效、恢复和排他规则。`manuscript migrate` 与 legacy 归档/恢复属于生命周期操作，固定按 `registry lease → 共享 fence → legacy_project_lease_key → FIFO` 取得；重新核验源身份后才分配新的 Git `project_uid`、`project_instance_id` 与 `project_storage_key`，并把两组身份写入 `MigrationJournal`。binding 提交后仍不得直接退役 legacy lease：registry rebind CAS 只能把旧实例置为 `retiring`、拒绝普通路由和普通 lease 签发，同时保留仅绑定 `migration_id`、只能取得同一底层排他锁并只允许封存/恢复的 `legacy_sealing_lease`；随后由该 lease 封存 `LegacyControlStore`，再在 `legacy_control_retired` 的最终 CAS 中撤销 sealing lease、退役旧 lease key，使新 ControlStore 成为唯一活动控制面和旧 legacy 请求全部陈旧。

项目级 lease 不能保护跨项目唯一性。应用稳定控制根还必须有 `ApplicationRegistryCoordinator` 和跨进程 `registry lease`，在不随数据根移动的权威 registry/config store 中原子管理 Git 项目的 `project_uid`、`project_instance_id`、`project_storage_key`，以及 legacy 项目的 `legacy_project_instance_id`、`legacy_project_lease_key`、`legacy_asset_manifest`、规范化显示名键、活动数据库/仓库路径、archive ID/路径的分配、保留、激活和退役；`recent_projects` 与归档目录只是该提交后的可重建投影，不能与 registry 分开先后发布。每个活动/归档转换还必须持久化 `lifecycle_routing_state = active | archiving | restoring | retired`、关联 journal ID 与允许的 source/target physical identity：只有 `active` 接受普通打开、读写、导出、AI 上下文、普通 lease 或自动保存；`archiving`/`restoring` 只允许对应 journal 的恢复/继续，其他普通路由一律返回 `PROJECT_LIFECYCLE_BUSY`，项目列表最多显示生命周期状态，不能继续读取其资产。Git 项目的新建、初始化、归档、恢复和同名重建固定按 `registry lease → OS writer lease → FIFO → .git/index.lock`；legacy 生命周期操作固定按 `registry lease → 共享 fence → legacy_project_lease_key → FIFO`；普通文章和非文章写入不取得 registry lease。数据根迁移是唯一取得独占 fence 的流程，固定为 `registry lease → 独占 data_root_maintenance_fence → 每个 legacy_project_lease_key → FIFO`，并从全量 registry 检查持续持有 registry lease 至 registry/config 最终 after-CAS 已耐久，因而所有会分配数据根资产的新建、初始化、迁移、归档和恢复都无法在其中插入。新建尚无项目 lease 时，先在 registry lease 内持久化 UID、instance、storage key 与 provisional project lease key 的 reservation，再取得项目 lease；任何失败只能按 `ProjectCreationJournal` 的 after 谓词前滚或退役 reservation，不能留下可被后来项目复用的半身份。

`.git/index.lock` 是对外部 Git porcelain 的附加排他边界，必须在 OS lease/FIFO 仍持有时取得。它有三种用途：

- checkpoint/baseline 的真实 index 发布锁按第 5.4 节协议使用；把 lock 原子发布为 `.git/index` 的 rename 本身就是标准 Git 锁释放边界，不能声称 rename 后仍持有该锁。
- 创建、删除、移动、重排卷/章节等会暂时暴露**无效受控 tree**的结构性文件发布，在发布首个权威文件前取得带 journal 所有权 marker 的 sentinel。sentinel 不是有效 index，绝不 rename 为 `.git/index`；只有完整结构闭包已发布、重读校验且 `FilePublicationJournal.files_published` 已持久化后才按记录身份删除。崩溃恢复必须先完成或回滚文件集，才能释放 sentinel。单正文或单 sidecar 的独立更新不需要该 sentinel。
- `git_ready` 项目归档/恢复的 `LifecycleGitFence` 按第 6.2 节使用；它同样只是 marker fence，不是有效 index。它只在记录的 source/target repository identity 上取得、随同一文件系统的仓库根 rename 移动，并在完整 archive/restore after predicate 通过后按记录 identity 释放。

OS writer lease 与 FIFO 必须持有到终态 journal 已持久化。应用只能保证遵守标准 index lock 的 Git porcelain 不会在结构半成品窗口提交；直接调用 `commit-tree`、`update-ref` 等绕过 index lock 的外部 plumbing 不在并发保证内。

`mythpen-cli manuscript init/migrate` 不得与运行中的应用直接操作同一项目：若持有者可通过已认证本地 IPC 服务请求，则由持有者执行；否则返回 `PROJECT_BUSY`，要求完全退出应用后由 CLI 依次取得 registry lease（如适用）与 OS lease。应用锁只能串行 Mythpen 自己的写入，不能阻止外部编辑器或外部 Git。

每个写入在 lease 内固定执行以下顺序：

1. 从独立 `ControlStore`、`LegacyControlStore`（如适用）与 `LifecycleControlStore` 读取并恢复未完成的文件、SQLite、Git、创建、迁移、归档或恢复 journal；无法精确恢复时报告 `RECOVERY_REQUIRED`。
2. 重新读取权威文件并执行 `ensureProjectionCurrent()`；如果该过程需要更新 SQLite 投影，也在同一 lease 内完成。
3. 校验项目实例、资源 epoch、`data_version`、投影 generation、草稿同步收据和候选文件的 raw before 哈希。
4. 先持久化并 fsync 文件发布 journal，再原子发布权威文件；随后经 `SQLiteProjectionStore` 发布完整、可校验的投影候选数据库。
5. 对存档操作，再执行独立的 Git checkpoint 事务；只有有关 journal 达到可证明终态后才把 operation 标记为完成。

写入前后都必须重新比较 raw before/after 哈希。最终发布前发现任何外部文件变化，返回 `EXTERNAL_CHANGE_CONFLICT`，不覆盖外部内容。`data_version` 只用于同一设备多窗口的乐观并发控制；它不是 Git 历史，也不能替代工作区哈希检查。

### 5.2 ManuscriptStore、ControlStore、文件发布 journal 与投影同步

ManuscriptStore 负责权威文件的解析、模式校验、稳定序列化、原始字节哈希、原子写入和从文件重建投影。

- 每次读写都验证仓库物理根目录、受控目录包含关系以及所有父级/目标的符号链接、junction、reparse point 风险；此检查不能只放在 GitService。
- 应用发布顺序为“正文文件 → 章节 sidecar → 卷/未分卷索引 → 总清单”。临时文件必须在同一受控目录内创建并原子替换；若该顺序会短暂破坏受控 tree，必须先取得第 5.1 节的结构 sentinel。
- `FilePublicationJournal` 独立于用户确认和 Git checkpoint 记录。它在应用本地恢复目录保存每个受影响文件的 before 副本、候选 after 副本、原始 before/after 哈希、发布进度和目标 SQLite generation，并在发布第一个权威文件前 fsync。
- 无结构 sentinel 的文件发布状态固定为 `prepared → files_published → projection_committed → completed`；需要 snapshot fence 的结构发布则固定为 `prepared → git_snapshot_fence_intent → git_snapshot_fence_acquired → files_published → git_snapshot_fence_release_intent → git_snapshot_fence_released → projection_committed → completed`。`git_snapshot_fence_intent` 只能记录 marker nonce、lock 路径、expected HEAD、初始 index 身份和受影响闭包；以 `CREATE_NEW` 写入并 fsync 完整 marker 后，`git_snapshot_fence_acquired` 才记录实际 lock 物理身份与 marker 摘要。release intent 只能在完整闭包已重读校验后写入，按记录身份删除 marker、fsync `.git` 目录后再记录 released。`projection_committed` 只能在第 5.3 节的候选数据库已完成原子发布和校验后写入。它不复用 `operation` 的审批状态，也不把 Git ref 阶段混进来。

`ControlStore` 位于项目数据库和 Git 工作树之外、由 `project_storage_key` 定位的应用控制目录，是 operation、草稿收据、文件/Git/迁移 journal 的唯一耐久控制面。它采用只追加的不可变事件记录：每个事件包含前一状态摘要、事件序号和 after 谓词，先写同目录临时文件、fsync 后原子发布并 fsync 父目录；同一 OS writer lease 内才可作状态 CAS。不得把它存入 `.mythpen.db`、Git worktree 或 renderer 内存。`ProjectCreationJournal`、`ProjectArchiveJournal`、`ProjectRestoreJournal`、`LegacyProjectArchiveJournal`、`LegacyProjectRestoreJournal`、`DataRootMigrationJournal` 和全局 registry reservation 是例外：它们写入不随数据根、源项目或归档产物移动的应用级 `LifecycleControlStore`（`ArchiveControlStore` 是其归档/恢复 namespace），并采用相同的追加、fsync 和 CAS 规则；registry/project writer lease 都位于稳定应用控制根，而不是可移动的项目控制目录。

`sqlite_legacy` 在尚未分配 storage key 前使用同一稳定控制根内、由 `legacy_project_instance_id` 定位的 `LegacyControlStore`；其事件格式、CAS、`ai_tool_invocation`、草稿收据和数据库 publication journal 与 ControlStore 相同，不能回退为 renderer/SQLite 内存状态。迁移开始时它只进入 `legacy_quiesced_snapshot`：拒绝新的普通遗留操作，但保留恢复证据和既有未终态记录的收敛能力，`MigrationJournal` 记录其身份和必要恢复结果；registry rebind 后旧实例只处于 `retiring`，普通调用不能再路由或取得普通 lease，唯有 journal 绑定的 `legacy_sealing_lease` 能恢复并写入最终 `legacy_control_sealed`。只有该 sealing after 谓词与旧 key/lease 的最终 retirement 均成立后，`legacy_control_retired` 才成立，新 ControlStore 才成为唯一活动控制面，旧 LegacyControlStore 才可封存并拒绝旧 instance/lease 的任何写入。

`SQLiteProjectionStore` 不能把一次内存 SQLite `COMMIT` 或 sql.js 的直接整文件覆盖当成持久提交。sql.js 实现必须作为 `SqlJsAtomicStore`：禁止直接覆盖正式 `.db`，先以独占、无跟随的同目录临时文件写出 `export()` 候选字节，再写入完整字节后 fsync，重新打开执行 `integrity_check` 和 `foreign_key_check`，再由平台原子替换 helper 发布并 fsync 父目录；ControlStore 同时保存 before/after 数据库文件身份、哈希、可恢复 before 副本和候选位置。这里的 fsync 指写入句柄已执行平台持久化 flush（Windows 为 `FlushFileBuffers` 或等价机制）；无法验证替换/目录持久化能力时不得静默报告成功。发布后必须重新打开验证，才可写入 `projection_committed` 或 `binding_committed`。候选、现有库和 journal 不能形成精确组合时，保留现场并进入 `RECOVERY_REQUIRED`，不得仅靠文章投影重建覆盖包含角色、世界观、会话和关联的原项目数据库。

`SqlJsAtomicStore` 是**整个项目数据库**的唯一连接所有者，而不只是文章表的投影器。它为每个项目维护单调 `connection_epoch`；所有读取/写入在开始时取得该 epoch 的受管连接，绝不缓存或暴露可在发布后继续 `export()` 的裸 sql.js 连接。候选发布在项目 writer lease/FIFO 内依次执行：排空全部项目表写入和延迟 flush → 固化 before 快照并构造/验证候选 → 冻结旧 epoch、取消全部定时 flush、拒绝新调用 → 原子发布正式数据库 → 重新打开并验证候选，安装 `connection_epoch + 1` 的唯一活动连接。旧 epoch 的 handle、回调和延迟保存永久返回 `DB_CONNECTION_STALE`，不得在失败后把旧内存库写回磁盘；发布失败或恢复谓词不匹配时也必须 fenced，重新打开由 journal 决定。角色、世界观、时间线、聊天、统计和文章投影都适用这一代际切换，不能通过“非文章直写”绕过它。

`ensureProjectionCurrent()` 比较受控文件的原始哈希、结构版本和 SQLite 最近投影 generation。外部变化形成完整、可校验的文件集时，Git 工作区优先于本机投影：没有未落盘本地草稿便按 UID 重建受影响投影，并只更新本机派生哈希；它不回写 Markdown 或 sidecar。外部正文变化会将该章节的 `pending` AI 提案保留为 `stale` 后再刷新投影；仅移动/重排且正文哈希不变时提案保持原状态；外部删除则先把相关提案转为 `stale`，再写入章节/卷 tombstone。只有外部变化与未落盘本地草稿相遇，或文件集不完整/无效时，才保留现场并进入显式人工处理，不做自动合并。

`ensureReadableProjection()` 是所有正常读取的 freshness gate。在执行任一 SQLite 查询、导出构建或向 PromptAssembler 提供项目数据前，它先以无副作用 probe 比较受控 tree 身份、原始哈希/结构版本和当前 projection generation；未变化时，才在同一受管 `connection_epoch` 上读取。发现变化、尚未初始化，或 probe 不能证明投影对应当前树时，它必须取得项目 writer lease/FIFO，先恢复 journal、重新 probe，并在仍有变化时执行 `ensureProjectionCurrent()` 和完整候选投影发布；之后只能从新 generation/epoch 读取。文件集无效或不完整时返回对应校验错误；与本地草稿相遇时按 `EXTERNAL_DRAFT_CONFLICT` 冻结、备份并阻断，绝不以旧投影成功响应。结果序列化前必须再做同类无副作用 probe；树在读取期间改变则丢弃结果并重试一次，仍持续变化时返回 `WORKTREE_CHANGED_DURING_READ`。读取命中 `DB_CONNECTION_STALE` 也必须重新经过该 gate，不得继续使用旧连接。

### 5.3 SQLite 投影、AI 提案与操作记录

SQLite 可以缓存当前正文，但它始终是 Git 工作区权威文件的派生投影。权威文件发布成功后，ManuscriptService 生成候选投影，刷新正文、字数、UID 映射、`is_present`/`deleted_at`、`chapter_position`、`manuscript_position` 和查询字段，并只经 `SQLiteProjectionStore` 的耐久发布协议对外可见。

`chapters.status`/sidecar 的 `status` 是长期、作者可见且可进入 Git 历史的章节工作流字段。存在待审 AI 提案不是章节 `review` 状态的同义词：创建、拒绝或接受 AI 提案都不得自动把章节状态写为 `review` 或 `accepted`；作者若要改变章节状态，必须执行独立的元数据操作。

`chapter_revisions` 是本机提案表，至少记录稳定 `chapter_id`、`chapter_uid`、服务器分配且按章节单调递增的 `proposal_request_sequence`、`proposal_request_id`、`base_body_sha256`、`base_projection_generation`、提案正文、提案创建时的项目实例、`revision_version` 和提案状态。AI 开始生成时先持久化项目实例、请求序号、预期 active revision 和正文/投影基准；生成结束后，在同一事务中对项目实例、章节活跃状态、正文哈希、projection generation、请求序号和预期 active revision 执行 CAS。任一不匹配时，候选只能保存为 `stale` 或返回结构化 stale，绝不得自动 rebase 到较新正文。每章最多一个 `pending` 提案；较小请求序号的迟到结果不得覆盖、supersede 或取代较大请求序号已创建的 pending 提案。状态至少包括 `pending`、`stale`、`superseded`、`accepted`、`rejected`、`archived`；外部正文变化、外部删除或接受另一提案造成基准不一致时，`pending` 提案转为 `stale`，不得自动接受。Mythpen 发起的 restore、应用草稿、冲突解决、移动和删除会先因 `pending` 提案返回阻断错误，因此它们不依靠“事后转 stale”绕过该保护。提案接受只能在正文基准仍匹配且章节活跃时，经 DraftCoordinator 和 ManuscriptService 写入正文；它只是未存档工作区变化，之后仍须独立创建 checkpoint。

对 `pending` 提案，普通正文写入采用“显式使提案陈旧”规则，而不是自动 rebase：REST 自动保存、普通 AI `update_chapter(content)`、AI 续写和其他正文编辑在创建首个文件发布 intent 前，必须把 `revision_id`、`revision_version`、原始 `base_body_sha256`、当前正文 before 哈希和写入来源固定进同一 ManuscriptService mutation snapshot。最终发布前再次 CAS 这些字段；任一不匹配则整次正文写入返回 `REVISION_STATE_CHANGED`，不发布文件。正文文件成功发布后，对应 SQLite 候选库必须在同一次可恢复投影发布中把该提案转为 `stale`、递增 `revision_version`，并记录 `stale_reason = body_replaced`、`stale_source` 和 `stale_against_body_sha256`；原始 base/proposed content 永久保持不变。只有文件与该候选投影都达到可证明终态后，正文写入才可报告成功。标题、状态和其他不改 `.md` 的元数据写入不改变提案状态。restore、删除、移动、应用冲突草稿和提案接受仍沿用本节及第 4.3 节的阻断/CAS 规则。任何路径都不得把 `pending` 提案自动 rebase 到新正文。

`prepare_apply_revision` 的不可变快照必须包含 `revision_id`、`revision_version`、提案状态、base body 哈希、proposed body 哈希、decisions 版本/摘要和最终 materialized after bytes/hash，合称 `revision_digest`。确认后的执行前再次 CAS `revision_digest` 与正文 before 哈希；提案状态、正文基准、候选内容或 decisions 任一变化时，关联 operation 原子转为终态 `stale`，用户必须发起新的可信宿主同步/预览请求后才会创建新的 operation。接受提案只改变正文和提案状态，绝不自动改变版本化章节工作流状态。

`prepare_apply_revision` 是草稿同步的一项窄例外：在创建 operation、冻结、写入 `draft_backup`、drain 草稿或刷新权威基准**之前**，服务先查询 DraftCoordinator 的全局 dirty-resource registry。目标章节的正文、sidecar 或任一已卸载保存队列存在重叠草稿时，立即返回 `LOCAL_DRAFT_CONFLICT`，零 operation、提案、文件和投影副作用；不得消耗/retire 原草稿、不得把它 drain 到正文，也不得以“即将 stale”替代用户选择。用户必须先在普通编辑流程显式保存、丢弃或 park 草稿，再以新的 interaction 重新准备提案应用。

迁移现有数据时，必须移除“待审提案自动把章节设为 `review`”的旧耦合。历史 `previous_chapter_status` 的非空值本身不是可信来源；只有带有当时捕获 provenance 的记录才可恢复原状态。其余旧记录保留迁移诊断并要求作者明确选择，不得伪造一个长期状态；今后新记录必须保存 `previous_status_provenance = captured`。

用户操作记录与文件/Git journal 分开存储。`operation` 至少保存 `operation_id`、类型、项目 UID/实例、可信调用方/会话、仅 chat origin 才有的可选 `chat_session_id`、`interaction_id`、`ai_model_turn_id`、assistant 消息事件 ID、tool-call ID、配对 tool-result 事件 ID、目标 UID、状态、创建/过期时间、不可变 `preview_digest`、完整快照和终态结果。每个 `prepare_*` 在 `{ project_instance_id, interaction_id, tool_call_id }` 上必须唯一：相同规范化参数只返回同一 operation，相同 tool-call ID 的不同参数返回 `TOOL_CALL_ID_REUSE`，且不创建 `ai_tool_invocation`。`approved` 是审计事件而非可长期停留的状态；可信宿主的 `confirm_and_claim_operation` 在同一个 ControlStore CAS 中记录真实手势、`user_confirmation_id` 并直接把操作从 `awaiting_approval` 领取为 `executing`。通用状态为：

~~~text
waiting_draft_sync → awaiting_approval → executing → completed | failed
waiting_draft_sync → cancelled | expired | stale | failed
awaiting_approval  → cancelled | expired | stale
executing          → stale（仅 `prepare_apply_revision` 在首个 journal/mutation intent 前的最终 revision/body CAS 失败）
executing          → needs_reapproval（仅在崩溃且尚无 journal intent 时）
~~~

`operation` 只表示用户交互/执行状态；文件发布阶段、Git commit/ref/index 阶段和迁移阶段分别只写入 `FilePublicationJournal`、`CheckpointJournal` 和 `MigrationJournal`。`completed`、`failed`、`cancelled`、`expired`、`stale` 和 `needs_reapproval` 都是终态审计记录。执行器必须在首个外部副作用前持久化对应 journal intent；重启时，`executing` 但尚无 intent 的操作转为 `needs_reapproval` 并释放冻结，已有 intent 的操作只能按该 journal 恢复。唯一的 `executing → stale` 例外是 `prepare_apply_revision`：执行器在**首个** journal/mutation intent 前复验 revision/body CAS 失败时原子转 stale 并释放冻结；一旦写入 intent，只能由关联 journal 收敛到 `completed` 或 `failed`，不得事后把已开始的文件事务伪装成 stale。重新同步/预览必须由用户发起新的可信宿主请求，创建一个新的 operation 并以 `replaces_operation_id` 链接旧记录，绝不复活或复用旧确认。不同操作的快照字段不能假装通用：checkpoint 另存 tree、消息、ref 和固定 commit recipe；恢复另存 `source_commit_oid`、`source_body_blob_oid`、before/after 字节哈希；冲突解决另存 `draft_backup_id`、策略和备份保留规则；AI 提案应用另存 `revision_digest`。相同 `operation_id` 的重试只返回持久化结果，绝不重复提交、恢复或覆盖文件。

不需要确认、会直接执行副作用的模型变更调用不复用 `operation`，但必须先在 ControlStore 创建不可变 `ai_tool_invocation`；`prepare_*` 只创建其自身唯一的 `operation`，不得双建 invocation。直接变更 invocation 的唯一键为 `{ project_instance_id, interaction_id, tool_call_id }`，至少记录：服务端 `invocation_id`、可信调用方和仅 chat origin 才有的可选会话、`capability_profile`、规范化工具名与参数摘要、目标资源、write-handle 摘要、项目/资源 epoch、关联 FilePublicationJournal 或 SqlJsAtomicStore mutation intent、状态、完整规范化 tool-result payload、payload digest、provider/tool-call 配对信息、服务端消息事件 ID/顺序和用于索引的终态摘要。状态固定为：

~~~text
received → executing → completed | failed | stale
received → failed | stale | cancelled
~~~

同一唯一键且参数摘要相同的重复投递：若已终态则返回其完整持久化 tool-result payload；若为 `executing` 则附着等待或按已有 intent 恢复到终态后返回；若为尚未领取 handle/写入 intent 的 `received`，重复投递可在同一 invocation 上重新执行静态校验和原子 claim，不得无限等待。绝不伪造未完成结果或重新调领域命令。同一 tool-call ID 携带不同工具名、参数或 handle 时返回 `TOOL_CALL_ID_REUSE`，零副作用。执行器必须在静态绑定/过期/参数检查或动态 precondition 失败时，将 `received` 原子转为 `failed`/`stale` 并写入完整错误 payload；只有有效 handle 才可按第 7.2.2 节把 `received → executing` 与 handle 领取合并为同一个 ControlStore CAS，随后 fsync 首个耐久 mutation intent，才可产生文章文件或项目数据库副作用。重启时，`executing` 且没有任何 intent 的 invocation 终态化为 `failed(INTERRUPTED_BEFORE_INTENT)`，其已领取 handle 同时消费且不得转交另一 invocation；已有 intent 的 invocation 只能恢复该 intent，不能重新调用领域命令。只有关联文件、投影或项目数据库发布达到可证明终态后才写 `completed`。该规则覆盖章节/卷文章写入以及角色、世界观、时间线等所有模型发起的本机领域变更；只读工具不创建 invocation。SSE 在执行后断线时，宿主按 interaction 重新加载 invocation，并以保存的完整 payload 和 provider 配对信息恢复原消息，绝不能重复创建或二次覆盖。

每个受信任本地宿主必须在安装/应用控制根初始化并持久化稳定的 `trusted_caller_id`；每次启动轮换的回环/Tauri 本地认证密钥只证明当前调用者属于该 identity，不能替换 identity 或使未完成工作失联。任何普通聊天、续写、润色、Provider probe 或页面专用 task 的首次网络请求前，宿主都必须在不依赖 renderer 内存的 `ClientAIActionStore` 原子持久化一个 `ClientAIAction`：`client_action_id`、action kind/origin、256 位随机 client key、项目 UID/实例（如适用）、仅 chat origin 才有的可选 `chat_session_id`、稳定 user action ID、规范请求 digest、状态和已绑定的服务端 ID。该 store 属于受信任应用控制面，并只通过同一串行的本地宿主命令向 ChatSessionService 暴露查询，renderer 不能写入或绕过它。状态固定为 `prepared → dispatched → server_bound → terminal_acknowledged`；仅 `prepared` 后可以发请求，收到 interaction/request/turn 或消息事件 ID 后才可进入 `server_bound`，重启时必须枚举所有非终态 action，以原 key 重取/附着既有耐久记录，绝不生成新 key。只有服务端终态已经取得并由宿主确认后才能按保留期清理。client key 仅用于幂等，不能充当认证或扩权凭据。

普通聊天、写作、共创和版本聊天使用该 action 的 `client_interaction_key`。服务以 `{ trusted_caller_id, client_interaction_key }` 原子查询或创建 `AIInteractionRecord`，并固定项目 UID/实例、`interaction_origin = chat`、聊天会话、稳定 user action/服务端用户消息 ID、规范化用户请求 digest、服务端 `interaction_id`、不可变 profile 输入、interaction 状态、最大 turn 数和下一个 turn sequence。相同 key 在相同绑定和 digest 下只返回同一 interaction 的耐久事件序列或当前状态，绝不新建第二个 interaction、派生第二份 profile、双建 operation 或派发未被耐久计划的 provider turn；它只能恢复该 record 已持久化的 turn 或其唯一 successor。相同 key 配不同 digest 返回 `INTERACTION_KEY_REUSE`，跨项目实例、会话或可信调用方复用返回 `INTERACTION_CONTEXT_MISMATCH`。`chat` origin 必须绑定 chat session；页面 task、editor 续写/润色等非 chat origin 的 `chat_session_id = null` 合法，且不得隐式选择“当前会话”。该 record 必须在第一次 provider 请求前 fsync。

每一次实际 provider 请求都必须有独立、耐久的 `AiModelTurn`，不能只依赖 SSE 缓冲或聊天 renderer 状态。它至少记录 `turn_kind`、关联的 interaction ID（普通聊天）、continuation request ID（续写）、polish request ID（润色）、provider-probe request ID（设置连通性探测）或 `AiTaskRequest` ID（页面专用 task）、单调 turn sequence、普通聊天的 `parent_turn_id` 与 canonical transcript/input digest、不可变 `policy_digest`、由实际发送字节计算的 `rendered_prompt_digest`、profile/schema digest、provider/model、request digest、服务端生成且全局唯一的 provider request ID 与 provider response ID（如有）、assistant 消息或续写/润色/探测/task 输出事件 ID（如适用）、完整规范化 assistant payload，以及该回合中**全部**按原顺序排列的 tool-call ID、名称、canonical 参数、配对状态和 tool-result payload/digest/消息事件 ID；续写、润色、探测及无工具页面 task 的 tool-call 集合为空，payload 为完整生成输出及其受限证据。普通聊天必须有 `UNIQUE(interaction_id, turn_sequence)`，续写/润色/探测/task 分别必须对其 request ID 有一对一唯一约束，且所有 turn 的 provider request ID 全局唯一。外发 provider 前先 fsync `provider_dispatch_intent`；收到完整 assistant 响应后，必须先持久化所有调用为 pending 的 `response_persisted`，才可发出 assistant/tool-call SSE 或执行任一调用。每个 tool result 都必须先持久化，才可发出其 SSE 或结束本回合；只有每个 tool-call ID 恰有一个结构化配对结果时才可进入 `tool_results_persisted` 并完成。无 tool call 的完整响应可直接完成。

`ProviderCompletionPolicy` 必须把 provider 返回的原始 `finish_reason`/`stop_reason`（缺失也显式记录）按固定、版本化的规则归一化为 `completion_status = complete_text | complete_tool_calls | truncated | refused | filtered | cancelled | unknown`，并把 policy version/摘要纳入 `policy_digest`。只有 `complete_text` 且无 tool call，或 `complete_tool_calls` 且 tool-call 响应形状完整，才是可持久化完成；缺失/未知原因、截断、拒绝、过滤、取消或 completion 状态与 tool-call 形状不匹配，都不是完整 assistant response。

每个 capability profile 还必须固定 `ToolExecutionBudget`，至少包含 `max_calls_per_turn`、`max_calls_per_interaction`、单 call/整批 canonical 参数 UTF-8 字节上限、单结果/累计 transcript UTF-8 字节上限，以及每 turn/interaction 的 mutating-call 上限；数值、已用计数和策略版本都进入 policy/profile digest，并在 `response_persisted` 与 successor 创建 CAS 中累计。规范化器必须在解析或执行任一 call 前检查整批 ID、参数和预算；任一超限即整批 `failed(PROVIDER_TOOL_BATCH_LIMIT_EXCEEDED)`，零 invocation、零工具 SSE、零领域副作用。工具结果只能由服务端受限输出协议生成；超过结果上限时只持久化该 call 的有界 `TOOL_RESULT_TOO_LARGE` 配对结果，不能把无界对象写入 ControlStore/transcript。预算耗尽时 interaction 终态化为 `INTERACTION_BUDGET_EXHAUSTED`，不得创建 successor 或再次派发 provider。

~~~text
prepared → provider_dispatch_intent → response_persisted
response_persisted（无 tool call）→ completed
response_persisted（有 tool call）→ tool_results_persisted → completed | failed
prepared → failed
provider_dispatch_intent → interrupted | failed
~~~

若 provider 响应格式不完整、无法规范化、`completion_status` 不是上述两个 complete 状态，或 complete 状态与 tool-call 形状不一致，它不得进入 `response_persisted`；即使工具参数 JSON 恰好合法也必须写入 `failed(PROVIDER_COMPLETION_INVALID)`，不发 assistant/tool-call SSE、不执行任一调用。仅在完成状态有效时，规范化器还必须在该状态前拒绝缺失、空白、超限或在当前 interaction 任一已有 turn 中重复的 tool-call ID，写入 `failed(PROVIDER_TOOL_CALL_ID_INVALID)`，不发 assistant/tool-call SSE、不执行任一调用；因此 `{ project_instance_id, interaction_id, tool_call_id }` 的 invocation 唯一键不会被同一 provider response 或跨 turn 重用破坏。一旦 `response_persisted` 含有任一 tool call，取消、领域失败、断线和任何终态都必须先为全部 call 写入恰一个结构化配对结果，随后才可进入 `tool_results_persisted → completed | failed`；不得直接失败、结束 SSE 或呈现卡片而留下未配对调用。全部结果落盘时，普通聊天 interaction 必须在同一 ControlStore CAS 中根据固定策略写入其唯一后继：无 tool call、含 `prepare_*`、达到持久化的 8-turn 上限、预算耗尽或已明确终止时将 interaction 终态化；其余已配对普通工具批次则原子创建 `parent_turn_id` 指向当前 turn 的唯一 `prepared` successor，递增 turn sequence，并固定由原始用户消息、前序 assistant/tool-result 顺序和 canonical bytes 组成的 transcript/input digest。恢复时只可继续这个已存在 successor；在 tool result 后、successor 创建前崩溃没有第三种状态，也不得另造或重派第二个后继。客户端在一个已持久化批次中断开时，已开始的 invocation 只能按其 own journal 恢复；尚未开始的 call 必须在同一 `AiModelTurn` 中写入 `cancelled(CLIENT_DISCONNECTED_BEFORE_EXECUTION)` 配对结果，绝不执行。崩溃时若只有 `provider_dispatch_intent` 而没有完整耐久响应，恢复终态化为 `interrupted(PROVIDER_RESPONSE_UNRECOVERABLE)`，不得盲目重发 provider；同一 `client_interaction_key` 只能回放该结果或已持久化/已计划的 turn，用户需要新的模型请求时必须创建新的 interaction。恢复聊天/SSE 时只能按 `AiModelTurn` 中保存的 assistant/tool-call/tool-result 顺序组装，不能拼接 renderer 临时事件。

### 5.4 GitService 与 checkpoint 事务

GitService 只执行固定、参数化的 Git 操作；AI 永远不获得任意 Git 命令、Git 路径或仓库路径。受信任本地宿主只能通过 Tauri IPC，或回环地址加每次启动随机本地客户端密钥调用管理接口；宽松 CORS、`project_uid` 或 `project_instance_id` 都不能充当身份凭据。

第一版仅接受 Mythpen 创建的普通非裸仓库，且满足以下硬约束：

- `HEAD` 必须指向 `refs/heads/main`，本地 heads 只能有 `main`；拒绝 detached HEAD、其他本地分支、merge/rebase/cherry-pick/bisect 中间态。
- 拒绝 linked worktree、外部 common-dir、submodule、嵌套仓库、shallow repository、alternates、replace refs、grafts、sparse checkout、skip-worktree、assume-unchanged、split-index/`link` extension、任何非常规 index 依赖和任何非受控 tracked 文件。
- 启用前、**每次任何 Git command profile 启动前**以及只读 profile 返回结果前，均以不解析仓库 config/object 的 OS 级 probe 按打开的目录/文件句柄验证 `.git`、`objects`、`refs`、`logs`、`index`、`HEAD`、可选 `packed-refs`、松散 `refs/heads/main`、`logs/HEAD`、`logs/refs/heads/main`、这些对象的相关 `*.lock`、`objects/info/alternates`、config 与应用恢复目录及其父级均为应用拥有、非 reparse point、非硬链接绕出且文件系统身份未变。允许缺席的 `packed-refs`、松散 `refs/heads/main` 和 reflog 也必须连同父目录 identity 明确记录为“缺席”；不得把缺席当作未检查。`main` 的解析同时覆盖 loose 与 packed ref，且两种来源中的全部 `refs/heads/*` 合起来只能得到 `main`。拒绝 alternates、`include`/`includeIf`、`config.worktree`、未知 repository/ref-storage extension 和不在白名单内的仓库配置。只读命令执行前后身份或上述输入 snapshot 不一致时丢弃结果并返回 `REPOSITORY_IDENTITY_CHANGED`，不能把结果交给 REST、聊天或 AI。
- Git 子进程从固定环境白名单启动，清除继承的 `GIT_*`、`SSH_*`、credential、editor、pager、askpass、替换对象和 alternates 变量；设置 `GIT_TERMINAL_PROMPT=0`、`GIT_NO_REPLACE_OBJECTS=1`、`GIT_CONFIG_NOSYSTEM=1`，并将 `GIT_CONFIG_GLOBAL` 指向应用拥有的空配置文件。命令 profile 必须分开：对象/ref/历史只读命令不设置 `GIT_INDEX_FILE` 且不得调用会刷新 index 的命令；持有应用 `.git/index.lock` 后的真实 index 预检仅以规范真实 index、`GIT_OPTIONAL_LOCKS=0` 和无写入命令读取；构树命令只使用 operation 专属私有 index。初始化使用受控空 template。hooks、fsmonitor、split index、GPG 签名、外部 diff/textconv 和 clean/smudge/process filter 一律关闭。
- 启用前必须验证 Git 版本支持覆盖对象、ref/reflog 和 index 的本仓库 fsync 策略；GitService 设置该策略（不支持时返回 `GIT_DURABILITY_UNSUPPORTED`），并在对象、ref、index 发布及其目录耐久前不得推进 journal。
- 服务不读取或保存 Token/SSH 私钥，不自动修改全局 Git 配置。新建/迁移的应用仓库使用仅限该仓库的默认身份 `Mythpen Local <mythpen@local.invalid>`；受信任本地命令可在用户明确设置后改为另一组**仓库本地**身份，绝不后台修改全局身份。

GitService 只能通过版本已验证的 Git 二进制和命名 command profile 启动 `probe`、`worktree_status`、`real_index_inspect`、`blob_write`、`private_index_build`、`commit_create`、`ref_cas`、`candidate_index_build`、`history_tree` 与 `history_diff`；每个 profile 固定子命令、argv 模式、cwd、环境白名单、stdin/stdout/stderr 上限、超时和退出码映射。动态值只能是经校验的 OID、由 UID 推导的路径、固定 ref 或受限消息字节；不得接受调用方传入的 Git 选项、`-c`、ref、路径或 shell 片段。实现使用 argv 接口，不经 shell；禁止 `git add`、`git commit`、`reset`、`checkout`、`restore`、`merge`、`rebase` 等 porcelain/工作区命令。`worktree_status` 必须使用双重身份/哈希快照：读取 HEAD、真实 index 语义和受控文件原始哈希后再复验；任一值改变则重试一次或返回 `WORKTREE_SNAPSHOT_UNSTABLE`，不能把混合时刻的状态作为 checkpoint 预览。

`RepositoryIdentityGuard` 是不调用 Git、不解析仓库可执行配置的 OS 文件系统边界：每个 profile 前后都以打开的目录/文件句柄确认仓库根、`.git`、objects、refs、logs、index、config、alternates 与恢复目录的规范路径、文件系统身份和非 reparse 属性。除不可变基础设施外，它还生成 `RefStorageSnapshot`：`HEAD`、`packed-refs`、loose `refs/heads/main`、`logs/HEAD`、`logs/refs/heads/main` 及相关 lock 的存在状态、physical identity、原始字节长度和流式 SHA-256；缺席项同时绑定父目录 identity。仓库根、`.git` 布局、config/alternates、恢复目录及其父级等不可变基础设施前后必须相同。

只读 profile 的 ref/index/受控工作区输入 snapshot 任一变化都丢弃输出并返回 `REPOSITORY_IDENTITY_CHANGED`。写 profile 中，除 journal 明确列出的 after 谓词外，`HEAD`、`packed-refs`、所有其他 loose ref、`logs/HEAD` 和所有其他 reflog 都必须保持精确不变；`ref_cas` 唯一允许的 ref-storage 变化是解析后的 `main` 从 `expected_old_oid` 变为 `new_commit_oid` 和相应 main reflog 的一条追加。若原 `main` 仅在 `packed-refs` 中，允许创建值精确为 `new_commit_oid` 的 loose `refs/heads/main`，但 `packed-refs` 本身仍必须不变。`ref_update_intent` 保存完整 before RefStorageSnapshot 与允许 after delta，`ref_updated` 保存完整 after snapshot；任何其他前后不一致、受管路径脱离、锁文件身份变化或受限对象根改变同样返回 `REPOSITORY_IDENTITY_CHANGED`。不得把不通过 guard 的只读结果交给 REST、聊天或 AI，也不得继续任何写入事务。

普通 checkpoint 的 Git 阶段必须按以下协议执行：

1. 在取得 `.git/index.lock` 前，先把 `checkpoint_lock_intent` fsync 到独立 `CheckpointJournal`，记录 operation ID、随机 lock nonce、锁路径、预期 HEAD 和真实 index 的初始文件身份。随后以独占方式创建标准 lock，并把完整、固定格式的 nonce marker 写入并 fsync；只有 marker 完整且 `index_lock_acquired` 已持久化实际 lock 文件身份后，才认定为本应用可恢复的 lock。崩溃在 CREATE_NEW、完整 marker 与 `index_lock_acquired` 之间时，归属不可证明：即使 OS writer lease 已接管，也只能保留 lock 并返回 `GIT_INDEX_LOCKED`，不得按 PID、mtime 或 nonce 单独删除。
2. 持锁后，用“真实 index 预检”命令 profile 重新验证 `refs/heads/main`、预期 HEAD、完整受控文件闭包、无未合并条目，以及**整个仓库**真实 index 的 tree、stage 和 flags 逻辑上精确等于预期 HEAD。任意已有暂存内容、非 Mythpen 路径暂存内容、unmerged 或被拒绝的 index 状态均不得直接返回；必须先按本节 abort 子协议持久化并安全释放已归属 lock，随后才以 `USER_INDEX_DIRTY` 终态失败。真实 index 的原始字节哈希只作为 journal 恢复和并发篡改证据，不单独作为“语义脏”的判断；journal 同时保存其规范语义指纹（路径、stage、mode、blob OID 与允许 flags）。
3. 从预期 parent 建立 operation 专属私有 index，只用经校验、无 filter 的精确 blob 更新获批闭包；闭包中的删除路径必须显式从私有 index 移除。新增、修改、删除后的完整 tree 都重新通过受控结构校验，再生成并核对获批 `tree_oid`；未选择的工作区改动不会写入此 index。
4. 在 `commit-tree` 前 fsync `commit_intent`。它固定 parent、tree、规范化消息/trailer、author/committer 名称与邮箱、秒级时间戳、时区、对象格式和固定 ref，因此重试只能生成同一 `new_commit_oid`。创建 commit 后，从该 commit 构造完整候选真实 index，并将候选 index 的**完整字节恢复副本**保存在 `.git` 同一文件系统内的应用恢复目录，fsync 文件和目录。journal 记录 `commit_created → candidate_index_ready`，至少包含 `parent_oid`、`tree_oid`、固定 ref、`expected_old_oid`、`new_commit_oid`、完整闭包的 blob/raw 哈希、真实 index before 原始哈希/语义指纹、候选 index 路径/文件身份/raw 哈希/tree OID/语义指纹；恢复副本在 `completed` 或 `aborted` 前不得删除。abort 只能清理恢复副本，不回收已写入对象，也不得生成第二个 commit。
5. 在 CAS 前 fsync `ref_update_intent`，其中除固定 ref、`expected_old_oid` 与 `new_commit_oid` 外，还必须保存 `RefStorageSnapshot` 和唯一允许的 ref/reflog after 谓词。随后唯一允许的 ref 写入是 `update-ref --no-deref refs/heads/main <new_commit_oid> <expected_old_oid>`。CAS 成功、ref/reflog 已耐久且 after snapshot 精确匹配后才 fsync `ref_updated`；CAS 明确拒绝时必须持久化 `ref_cas_rejected`（含实际观察到的 ref/OID）并进入下述 abort 分支，绝不重试生成新 commit。
6. CAS 成功、ref/reflog 已耐久后，仍持有 `.git/index.lock`。在覆盖 marker 前，必须重新验证 `main == new_commit_oid`、lock 物理身份及 marker 摘要仍精确匹配，并 fsync `index_publish_intent`；该状态记录候选恢复副本身份/raw 哈希/tree OID/语义指纹、原 marker 摘要和同一 lock 的物理身份。随后只能通过该已打开的同一 lock 句柄把已保存且已核验的 candidate index 覆写进去，不得以替换 lock 路径的方式更换其物理身份；fsync lock、复核候选原始哈希和规范 index 语义指纹（路径、stage、mode、blob OID 与允许 flags）后才 fsync `index_publish_ready`。按标准 lock→index 原子替换发布真实 `.git/index`；该 rename 同时完成 index 发布并释放标准 Git 锁。随后以只读 profile 复验：若 `main == new_commit_oid` 且真实 index 语义等于候选，则 fsync `index_synchronized`、`completed`；若 `main` 已是 `new_commit_oid` 的受验证后代且真实 index 语义等于当前 HEAD，则记录 `external_head_advanced_after_checkpoint` 并完成本 checkpoint，绝不覆盖外部 index；其余任何 ref/index 组合均保留现场并进入恢复。候选恢复副本保留至 `completed`。这样未选择的工作区修改保持未暂存，不会夹带进 commit。

`abort_intent → lock_release_intent → lock_released → aborted` 只适用于 candidate 尚未写入 `.git/index.lock` 的可证明失败：`index_lock_acquired` 后真实 index 已确认 dirty；或者在 `index_lock_acquired`（私有 index/tree 构造）、`commit_intent`（`commit-tree`）、`commit_created` 或 `candidate_index_ready`（候选 index/最终 pre-ref 校验）阶段，固定 command profile 返回具有已知“尚未发起 ref 更新”语义的失败码，且 guard 复读证明完整 before `RefStorageSnapshot` 未变、`main == expected_old_oid`、lock 仍是本 journal 的完整 marker、candidate 尚未 materialize 到 lock；或者 `ref_update_intent` 后 CAS 已明确 expected-old 不匹配并经 guard 复读确认 `main != new_commit_oid`。已知 pre-ref 命令失败这一类必须先持久化 `pre_ref_command_failed`，记录原始命令/失败码和上述反证，再进入 abort；已写入但尚未引用的 commit object 可保留，绝不生成第二个 commit。子进程中断、超时、未知退出码或任何无法证明“未写 ref、未 materialize candidate”的结果不得 abort，必须保留当前阶段恢复。执行 abort 时先 fsync `abort_intent`，记录 `abort_reason = index_dirty | pre_ref_command_failed | ref_cas_rejected`、原始失败码/阶段、expected-old 与存在时的 `new_commit_oid`、观察到的完整 ref snapshot、lock 物理身份、marker 摘要、dirty 分支的 observed-dirty index 语义或其余分支的真实 index before 语义、候选恢复副本（如有）；重新验证 lock 仍为同一物理文件且内容仍为完整 marker 后 fsync `lock_release_intent`，再只以 unlink 删除 marker lock、fsync `.git` 目录并记录 `lock_released → aborted`。崩溃恢复中，release intent 遇到仍匹配 marker 可继续 unlink；lock 已消失时必须按 `abort_reason` 复验：`index_dirty` 要求 `main == expected_old_oid`、before RefStorageSnapshot 未变、journal 尚无 `new_commit_oid`/candidate，且真实 index 精确等于记录的 dirty 语义；`pre_ref_command_failed` 要求 before RefStorageSnapshot 未变、`main == expected_old_oid`、真实 index 仍为记录的 clean before 语义且 candidate 从未 materialize；`ref_cas_rejected` 要求持久化的 reject 观察仍证明 `main != new_commit_oid`、真实 index 仍为 before 语义且 candidate 未 materialize。仅这些对应谓词成立才可补记 `aborted`。lock 存在但身份/marker 不匹配返回 `GIT_INDEX_LOCKED`；lock 消失但存在可能 ref/index 发布证据返回 `RECOVERY_REQUIRED`。只有 `aborted` 已耐久后关联 operation 才可转为 `failed(USER_INDEX_DIRTY)`、`failed(REF_ADVANCED_OR_DIVERGED)` 或保留的已知 pre-ref 失败；abort 未收敛时 operation 保持 `executing`，不得释放 writer lease 或伪装成可重试的新 checkpoint。`ref_updated` 后不得 abort 或回退 ref，只能按前滚恢复规则收敛。

`CheckpointJournal` 的状态固定为：

~~~text
checkpoint_lock_intent → index_lock_acquired
  ├→ abort_intent → lock_release_intent → lock_released → aborted（仅 index dirty）
  ├→ pre_ref_command_failed → abort_intent → lock_release_intent → lock_released → aborted（私有 index/tree 构造失败）
  └→ commit_intent
       ├→ pre_ref_command_failed → abort_intent → lock_release_intent → lock_released → aborted（commit-tree 失败）
       └→ commit_created
            ├→ pre_ref_command_failed → abort_intent → lock_release_intent → lock_released → aborted（candidate 构造失败）
            └→ candidate_index_ready
                 ├→ pre_ref_command_failed → abort_intent → lock_release_intent → lock_released → aborted（最终 pre-ref 校验失败）
                 └→ ref_update_intent
                      ├→ ref_cas_rejected → abort_intent → lock_release_intent → lock_released → aborted
                      └→ ref_updated → index_publish_intent → index_publish_ready
                           ├→ index_synchronized → completed
                           └→ external_head_advanced_after_checkpoint → completed
~~~

它与第 5.3 节 operation 状态完全独立；Git 副作用期间 operation 始终为 `executing`，只有成功终态或已证明的 abort 终态才可结束该操作。

应用写出的 commit 可添加服务生成的 `Mythpen-Project`、`Mythpen-Chapters`、`Mythpen-Checkpoint` 和 `Mythpen-Operation` trailers，供展示和查询优化；提交信息限制长度并拒绝 NUL、CR、控制字符和调用方伪造的 `Mythpen-*` trailers。trailer 不是事务恢复依据，也不能单独证明某章节历史有效：历史查询必须以固定 `main`、受控 tree、章节 UID sidecar 和历史路径共同验证，因此也能显示满足仓库约束的外部标准 Git commit。

历史 handle 必须是服务端签发的不可伪造记录，绑定仓库物理身份、签发时的 `main` HEAD（或该 HEAD 的已验证祖先 commit OID）、项目 UID/实例、可信调用方与 origin（仅 chat origin 绑定会话）、目标章节 UID、允许的读取/恢复用途和有效期；不得接受调用方自填 ref、treeish、路径或跨仓库/跨 origin 复用 handle。解引用后必须先只读取对象元数据，再读取内容：目录只能是 `040000`，受控普通文件只能是 `100644`，拒绝 symlink、gitlink、可执行文件和其他 mode；每次历史查询最多检查 200 个 commit、10,000 个 tree 条目、深度 8、单个 Markdown blob 16 MiB、单个 JSON blob 256 KiB、累计对象读取 32 MiB、生成 diff 5 秒。任一限额或对象检查失败即返回结构化错误和 `truncated`，不得先执行无界 `show`/`diff` 再截断文本。

## 6. 项目启用、初始化与迁移

项目文章层对外状态为 `creating`、`sqlite_legacy`、`migrating`、`git_ready`、`creation_failed` 和 `migration_failed`，并受第 5.1 节的 `lifecycle_routing_state` 约束。只有同时为 `git_ready + active` 的实例才暴露 Git 文章工具；其他状态返回结构化原因，`archiving`/`restoring` 不得借旧投影或旧路径继续提供普通读取。新项目通过独立的 `ProjectCreationJournal` 创建，旧项目通过 `MigrationJournal` 迁移；两者在创建 baseline 时复用同一套可恢复 Git checkpoint 子协议，而不是“发现目录非空就一律失败”。

~~~text
sqlite_legacy
  → migration_prepared
  → schema_candidate_ready
  → schema_published
  → repo_staged
  → repo_created
  → files_published
  → baseline_lock_intent
  → baseline_index_lock_acquired
  → baseline_commit_intent
  → baseline_commit_created
  → baseline_candidate_index_ready
  → baseline_ref_update_intent
  → baseline_ref_updated
  → baseline_index_publish_intent
  → baseline_index_publish_ready
  → baseline_index_synchronized
  → binding_committed
  → registry_rebind_intent
  → registry_rebound
  → legacy_control_retired
  → git_ready

任一阶段 —[仅能证明尚未越过安全中止点]→ safe_abort_intent → safe_abort_completed → migration_failed
任一阶段 —[当前阶段或 `next_stage_intent` 的精确 after 谓词匹配]→ 前滚至相应阶段
任一阶段 —[无法证明以上任一组合]→ RECOVERY_REQUIRED
~~~

`MigrationJournal` 必须早于目标仓库、数据库、文件或 ref 写入而持久化并 fsync，至少记录：`migration_id`、`legacy_project_instance_id`、legacy source DB 物理身份/lease key、分配后的项目 UID/实例/storage key、源 SQLite 一致快照的 SHA-256、源快照和备份位置、schema 候选/after 哈希、分配的 UID 映射、章节编号和 position 映射、目标目录的规范真实路径及文件系统身份、repo staging 路径、manifest/tree 哈希、baseline lock nonce/物理身份、baseline commit OID、baseline candidate index 的原始哈希与语义指纹、固定 ref 和当前阶段。每个非幂等阶段副作用前还必须 fsync `next_stage_intent`，其中包含下一阶段的精确 after 谓词（目标数据库/文件/树/OID/ref/index/SQLite binding）和必要的候选文件；对 baseline commit，intent 还固定 parent、tree、身份、时间戳和消息配方，以唯一确定预期 commit。`registry_rebind_intent` 还必须固定 legacy registry record 与 migration reservation 的 before generation/digest、旧 `legacy_project_instance_id`/lease key、journal 专属 `legacy_sealing_lease` 的 capability/底层锁身份、目标活动数据库/仓库/ControlStore 的 physical identity 与 after generation/digest；其 after 谓词同时证明 registry 已用单次 CAS 将 reservation 变为唯一的 `migrating` Git target、旧 legacy record 仅进入 `retiring` 且不再接受普通路由/普通 lease、新 target ControlStore 只接受 migration recovery，而 sealing lease 仍仅可供该 journal 取得同一排他锁并执行封存。随后 `legacy_control_retired` 的 intent 固定 LegacyControlStore 的封存 before/after、sealing lease 和 registry generation；其 after 谓词证明封存事件已耐久，并由最终 registry CAS 同时退役旧 record/key 与 sealing lease、把新 ControlStore 设为唯一活动控制面。副作用成功后才把当前阶段推进为下一阶段。`migration_failed` 只能在 `safe_abort_intent` 已记录且 before-state/未发布谓词证明安全中止完成后写入；一旦发生 ref 更新、binding/rebind、ControlStore sealing 或任何 activation，失败路径只能按 after 谓词前滚或进入 `RECOVERY_REQUIRED`，绝不把已开始的迁移伪装成可重试失败。

- 新建项目必须先在 registry lease 内创建 `ProjectCreationJournal` 和不可复用的 identity reservation，状态固定为：

  ~~~text
  creation_reserved → data_layout_prepared → database_published → repo_staged → repo_created
    → files_published → baseline_lock_intent → baseline_index_lock_acquired
    → baseline_commit_intent → baseline_commit_created → baseline_candidate_index_ready
    → baseline_ref_update_intent → baseline_ref_updated → baseline_index_publish_intent → baseline_index_publish_ready
    → baseline_index_synchronized → binding_committed → registry_activated → git_ready

  任一阶段 —[仅能证明尚未越过安全中止点]→ safe_abort_intent → safe_abort_completed → creation_failed
  任一阶段 —[当前阶段或 `next_stage_intent` 的精确 after 谓词匹配]→ 前滚至相应阶段
  任一阶段 —[无法证明以上任一组合]→ RECOVERY_REQUIRED
  ~~~

  文章仓库只在 `<configured Mythpen data directory>/manuscripts/<project_uid>/` 的同文件系统 staging 目录完整初始化并验证，随后无覆盖地原子发布为应用拥有的目标目录；项目数据库、封面、项目 ControlStore 与暂存/恢复资产分别由 reservation 中的 `project_storage_key` 推导。不得对半成品目标目录重跑 `git init`，也不得在 registry 激活前把项目显示为可打开。生成初始权威文件并以同一 baseline 子协议创建 `main` 基线 commit。项目创建这一明确用户动作构成基线 commit 的授权，因此 `git_ready` 项目不存在 unborn HEAD。
- 已有 SQLite 项目保持 `sqlite_legacy`，直到用户使用受信任本地管理命令显式运行 `mythpen-cli manuscript init` 或 `mythpen-cli manuscript migrate`。迁移先在 registry lease 下取得 `legacy_project_lease_key` 并排空该遗留实例的写入；重新验证 source identity 后才保留新的 Git UID/instance/storage key，并把原名称式数据库/封面/控制资产仅按第 4.1 节的安全迁移规则导入到由 key 推导的新布局；显示名绝不反向参与任何目标路径推导。AI 工具不能初始化、绑定或选择目录；CLI 与运行中应用的互斥规则见第 5.1 节。
- 初始化/迁移开始前，写入协调器冻结全局 dirty-resource registry、暂停自动保存和 AI 写入，要求处理活跃待审提案，并通过 DraftCoordinator 捕获或归档所有本地草稿。随后以第 5.2 节耐久协议取得一致源快照。原 SQLite 文件与迁移前备份必须保留；不得丢弃业务数据或用投影重建替代数据迁移。
- schema-swap 只可针对源快照构造候选数据库：先从 `sqlite_schema`、`foreign_key_list`、`index_list`、触发器和视图建立依赖图，再重建所有受影响表及依赖对象。当前至少覆盖 `volumes`、`chapters`、`chapter_characters`、`foreshadows` 的章节外键、`memories.source_chapter_id`、`clue_board.related_chapter_id`、`chapter_revisions`、所有索引/视图，以及 `chapters_data_version_after_update` 触发器。迁移必须逐列保留业务行、原整数 ID、`sqlite_sequence`、外键动作、索引、触发器和视图，禁止 `CREATE TABLE AS SELECT`；遇到不在迁移白名单且不能安全重建的依赖对象，任何 DDL 前返回 `SCHEMA_SWAP_UNSUPPORTED`。切换前后校验行数/ID 集合、schema 指纹、`integrity_check` 与 `foreign_key_check`，只通过 `SQLiteProjectionStore` 发布候选库。该破坏性 DDL 绝不得由普通 `openProjectDb()` 自动执行。
- 从快照生成的受控文件必须重新解析，校验 UID、成员、顺序、正文原始字节哈希和结构 tree 后才发布。baseline 继承第 5.4 节的 lock marker、固定 commit recipe、候选 index、ref CAS、语义复验和恢复规则，**但在达到 `git_ready` 前不接受 `external_head_advanced_after_checkpoint` 分支**；preflight 仅改为：受支持的 Git profile 已启用、`HEAD` 只能是指向 `refs/heads/main` 的符号引用、`main` 必须尚不存在、真实 index 必须不存在或为空，expected old 为当前对象格式长度的全零 OID，tree 由空私有 index 构造且 commit 没有 parent。baseline 必须依次达到 `baseline_lock_intent → baseline_index_lock_acquired → baseline_commit_intent → baseline_commit_created → baseline_candidate_index_ready → baseline_ref_update_intent → baseline_ref_updated → baseline_index_publish_intent → baseline_index_publish_ready → baseline_index_synchronized`；lock→index 的 rename 是锁释放，不另设“baseline_lock_released”成功状态。`baseline_index_publish_intent` 落盘时同一 lock 必须仍是完整 marker；`baseline_index_publish_ready` 落盘时同一 lock 必须已是完整 candidate。SQLite binding 和 `git_ready` 绝不得早于 `baseline_index_synchronized`。

重试按 journal 当前阶段使用相应的不变式，而不是要求未来阶段的对象已经存在：`migration_prepared` 要求源快照/目标路径身份/UID 映射匹配；`schema_candidate_ready` 要求候选数据库及 schema after 谓词匹配；`schema_published` 要求正式数据库等于候选 after；`repo_staged` 要求 staging 仓库完整、目标尚未出现；`repo_created` 要求仓库身份和 `HEAD → main` 符号引用匹配、`main` 不存在；`files_published` 还要求受控文件 tree 匹配、`main` 不存在；`baseline_lock_intent`/`baseline_index_lock_acquired` 还要求 lock marker 与物理身份分别符合记录；`baseline_commit_intent`/`baseline_commit_created` 还要求固定 recipe 与指定 commit 的 OID/tree/parent 匹配、`main` 不存在；`baseline_candidate_index_ready` 还要求候选 index 完整且语义指纹匹配；`baseline_ref_update_intent`/`baseline_ref_updated` 要求 `main` 分别仍不存在/等于 `baseline_commit_oid`，且后者的 lock 仍为已归属的完整 marker；`baseline_index_publish_intent` 要求 `main == baseline_commit_oid`、真实 index 仍不存在或语义等于 baseline before，且同一 lock 内容只能是记录的完整 marker 或完整 candidate：marker 可继续覆写 candidate，candidate 可补记 ready；`baseline_index_publish_ready` 要求 `main == baseline_commit_oid`、真实 index 仍不存在或语义等于 baseline before、lock 物理身份仍匹配，且 lock 内容的 raw 哈希与语义指纹精确等于 candidate，**不再要求 marker 仍存在**；`baseline_index_synchronized` 要求 lock 因 rename 已消失且真实 index 语义等于 candidate（允许仅 stat-cache 导致 raw 不同）；`binding_committed` 还要求 SQLite binding 记录匹配；`registry_rebind_intent`/`registry_rebound` 还要求 registry before/after generation、唯一 `migrating` target、`retiring` legacy record、仅 journal 可用的 sealing lease 与迁移专用新 ControlStore 的 after 谓词精确匹配；`legacy_control_retired` 还要求 LegacyControlStore 已按 sealing lease 封存只读、旧 record/key/sealing lease 已最终退役且新 ControlStore 成为唯一活动控制面；`git_ready` 还要求同一 target registry record 已原子转为 `git_ready`。后续字段在前期必须明确不存在。

恢复既接受“当前阶段谓词精确匹配”，也接受“本 journal 的 `next_stage_intent` 所证明的下一阶段 after 谓词精确匹配”：后一种情况下，先只把 journal 前滚为下一阶段，再继续后续步骤。由本 journal 创建但未发布的 repo staging 可以按 staging 身份删除或重建；目标目录中出现无法证明归属的半成品 `.git` 时返回 `MIGRATION_STATE_MISMATCH`，不得对其继续 `git init`。baseline 在 `git_ready` 前若 `main != baseline_commit_oid`，或 baseline ref 已更新而真实 index 不满足 before/candidate 的阶段谓词，则返回 `MIGRATION_STATE_MISMATCH` 或 `INDEX_DIVERGED_AFTER_REF`，不得写入 binding 或 `git_ready`。baseline 的 `baseline_index_publish_intent`/`baseline_index_publish_ready` 不满足上述 marker/candidate 谓词时返回 `MIGRATION_STATE_MISMATCH`、`INDEX_DIVERGED_AFTER_REF` 或 `GIT_INDEX_LOCKED`，不得把覆写后的 candidate 误判为未知 lock，也不得重建 baseline。registry rebind 阶段只接受 `retiring` 旧 record 与 journal 专属 sealing lease；rebind 后崩溃必须由该 sealing lease 继续/核验 `legacy_control_sealed`，再执行最终 retirement CAS。其 before/after generation、sealing lease、LegacyControlStore sealing 或最终退役任一不匹配时同样返回 `MIGRATION_STATE_MISMATCH`，不得激活 target 或恢复 legacy 路由。unknown lock 或在 CREATE_NEW、完整 marker、acquired 记录之间遗留的 lock 一律保留并返回 `GIT_INDEX_LOCKED`。其他任一谓词不匹配时，保留 SQLite、仓库和诊断，不覆盖目标，也不创建第二个 baseline commit。

`ProjectCreationJournal` 采用同样的 current/next-stage 谓词和 baseline 恢复规则，并额外把 registry reservation、project storage key、目标数据库/仓库/ControlStore 的物理身份写入每个阶段。只有 `registry_activated` 可把 reservation 转为活动项目；`creation_failed` 只能在 `safe_abort_completed` 或其他可证明尚未发布/激活的 early stage 后、于 registry lease 内退役 reservation，绝不把其 UID、storage key 或显示名键释放给不相关的并发创建请求。数据库发布、baseline ref 更新、binding 或 registry 激活之后遇到异常，只能前滚或 `RECOVERY_REQUIRED`。

遗留数据必须无损映射：卷顺序使用源快照中的 `sort_order ASC, id ASC`；每个已分卷集合和 `volume_id IS NULL` 的未分卷集合分别以 `num ASC, id ASC` 生成索引顺序，并写入连续的 `chapter_position = 1..N`，再按第 4.4 节派生连续的全书 `manuscript_position = 1..N`。迁移 preflight 要求每个 `num` 为 `1..9007199254740991` 内、可无损表示为 JSON 的整数；同一活跃容器重复编号、`NULL`、非整数或超出安全整数范围的值均返回 `LEGACY_CHAPTER_NUMBER_INVALID`，不开始迁移、不自行重编号。通过 preflight 的 `chapters.num` 原样写入 `chapter_number`；顺序由索引中的 UID 列表决定，不把编号当跨设备身份。`volume_id IS NULL` 的章节进入 Git 的顶层 `unassigned` 集合，sidecar 的 `volume_uid` 为 `null`，SQLite 中仍保持 `volume_id IS NULL`，绝不为了迁移创建伪造“未分卷”卷。指向不存在卷行的非空 `volume_id` 是损坏源数据，迁移必须拒绝而不是猜测归属。

`foreshadows` 的 schema candidate 必须把旧 `expected_resolve_chapter` 重建为 `expected_resolve_manuscript_position`。旧值为 `NULL` 或 `0` 时映射为 `NULL`；旧值为正安全整数时，只有源库全部活跃章节的既有 `num` 与按本节定义的 legacy 全书线性位置逐项相等，才可将该值原样映射为新的全书位置。只要存在非空旧预期且这一条件不成立，原数字无法区分“卷内第 N 章”和“全书第 N 章”，迁移 preflight 必须返回 `LEGACY_FORESHADOW_EXPECTED_POSITION_AMBIGUOUS`，零目标副作用；不得静默复制、猜测卷归属或用 `MAX(num)` 改写业务含义。负数、非整数或超安全整数返回 `LEGACY_FORESHADOW_EXPECTED_POSITION_INVALID`。

### 6.1 数据目录迁移边界（V1）

现有 `mythpen-cli data-dir set <path> --migrate` 在第一版只支持**不含 Git 物理身份绑定的纯 SQLite 遗留数据**。它绝不能把“按字节复制目录、切换配置”误当作 Git 仓库迁移：在复制第一个字节前，`ApplicationRegistryCoordinator` 必须在 registry lease 内检查全部活动注册项、归档清单和 `LifecycleControlStore`。只要存在任一 `git_ready` 项目、Git 化归档、非终态的 creation/migration/archive/restore journal，或无法证明资产均为 legacy SQLite 的路径，命令立即返回 `DATA_DIR_GIT_RELOCATION_UNSUPPORTED`；不复制、不切换配置、不重绑定 `manuscript_binding`。

`mythpen-cli data-dir set <path>` 未带 `--migrate` 只能在 registry 中**没有**活动项目、archive record、identity reservation 或任一 lifecycle journal 时改变根配置；否则在创建目标目录、复制任何字节或写入配置前返回 `DATA_DIR_SWITCH_REQUIRES_EMPTY_REGISTRY`。相同规范物理根是幂等 no-op。第一版不维护当前根与备用根，不扫描旧根，也不允许“先写配置、以后再迁移”。

`MYTHPEN_DATA_DIR` 在运行时优先于持久配置。环境变量存在时，任何不同物理根的 `data-dir set`（含 `--migrate`）必须在 registry lease 内返回 `DATA_DIR_ENV_OVERRIDE_ACTIVE`，零复制、零配置变更；操作者必须先移除该 override 并重启到可验证的当前根，再显式执行命令。环境变量不是每进程的数据根迁移通道。

上述根目录绑定检查不仅适用于 `data-dir set`：任何应用宿主或 CLI 的启动、项目列表、打开项目、创建目录、打开项目数据库或 ControlStore 前，都必须先从不随数据根移动的稳定 ApplicationRegistry/LifecycleControlStore bootstrap，解析包含 `MYTHPEN_DATA_DIR` 在内的 effective root，并将其规范物理身份与已注册 data root 比较。环境变量导致的不同根必须在任何目标根 `mkdir`、项目列表读取、数据库/ControlStore 打开或写入前返回 `DATA_DIR_ENV_OVERRIDE_ACTIVE`；不得让普通启动路径绕过该约束。registry 为空时，才可在首次创建任何数据根资产前以同一 bootstrap CAS 原子建立 effective root 绑定；相同物理根为 no-op。

空 registry 的首次绑定也必须是可恢复的无跟随 reservation，而不是假定候选根已存在：既有根以打开目录句柄记录规范真实路径和物理身份；不存在的根先在稳定 bootstrap 中写入 `data_root_binding_reservation`，固定规范绝对目标路径、父目录打开句柄/物理身份和“目标缺席”谓词，再以 `CREATE_NEW`、拒绝 reparse point 的方式创建目标根，fsync 后立即把目标目录物理身份补入同一 reservation，并以 CAS 激活 binding。崩溃恢复只接受“目标仍缺席且父身份不变”或“目标恰为记录身份”两种状态；父/目标发生重解析、身份改变或第三种状态时返回 `DATA_DIR_ROOT_BINDING_MISMATCH`，不得创建、切换或扫描数据资产。

允许路径只迁移尚未获得 `project_storage_key` 的 legacy 项目：`DataRootMigrationJournal` 固定写入 `LifecycleControlStore`，并在持有 registry lease 的整个期间取得全局**独占** `data_root_maintenance_fence`。迁移目标根必须复用上一段的无跟随 reservation 协议：既有根记录打开目录句柄/物理身份；缺席根把规范绝对路径、父目录句柄/身份和缺席谓词固定进 journal 后才以 `CREATE_NEW` 创建；恢复只接受目标缺席且父身份不变，或目标恰为记录身份两态，reparse/身份变化或第三种状态返回 `DATA_DIR_ROOT_BINDING_MISMATCH`，不创建候选布局。journal 在排空前固定 registry before generation/digest、全部 legacy record/manifest 的集合和该目标根 reservation；registry lease 从该全量检查、fence 获取和每个 legacy lease 排空开始，持续持有到 registry/config 的单次最终 after-CAS 与 journal 终态都已耐久，绝不得在复制期间释放后重取。所有 `sqlite_legacy` 的普通打开/读写必须固定按**共享 fence → legacy_project_lease_key → FIFO** 取得；数据根迁移持有独占 fence 后依次取得每个 legacy lease/FIFO，未能排空任一实例则返回 `DATA_ROOT_BUSY`，不复制。由此复制期间不会有遗留数据库继续写入、不会有新 legacy 操作开始，而所有依赖 registry lease 的新建、初始化、迁移、归档或恢复也无法插入新的 Git/归档/lifecycle 身份。

在此纯 legacy、已排空状态下，命令只以已验证的 legacy manifest（`legacy_project_instance_id`、源 DB 物理身份、受控相对资产清单）和服务端生成的临时 `relocation_id` 枚举资产，绝不依赖显示名，也不提前分配 `project_storage_key`。它先在目标根创建无覆盖的候选布局，逐项核验数据库、封面及其他数据根内受控 legacy 资产的身份、字节摘要和归属；稳定根内的 LegacyControlStore 不随数据根复制。随后只可用 journal 固定的 registry before generation/digest、全部 manifest 集合、目标根 reservation/物理身份和候选摘要，执行单次 registry/config after-CAS 更新 legacy source physical identity、`legacy_project_lease_key` 绑定与数据根投影；任一第三方 generation 或资产集合变化均返回 `DATA_ROOT_MIGRATION_STATE_MISMATCH`，不切换配置。源根仅在目标根、registry 和 journal 都达到可证明终态后才可由独立维护命令清理；第一版不负责重新定位 Git worktree、`.git`、Git archive、已有 binding 或任何运行中的生命周期操作。

### 6.2 项目删除与归档

`git_ready` 项目的删除是可恢复的归档事务，不是物理删除。受信任本地宿主在真实用户确认后，按第 5.1 节顺序取得 registry lease 和 writer lease，处理或拒绝未完成 operation/journal，并把由 registry 中 UID/storage key 定位的项目 SQLite、应用拥有的文章仓库、项目拥有的封面和项目控制目录一并归档到由 `project_uid` 与服务端生成 opaque `archive_id` 推导的 `<data>/archives/projects/<project_uid>/<archive_id>/`；导出文件及非本应用拥有的路径不得移动或删除。归档不创建 Git commit、不 reset 工作区，必须保留未存档工作区、历史、草稿备份、提案和操作诊断。

`sqlite_legacy` 的删除同样是可恢复归档，但使用独立的 `LegacyProjectArchiveJournal`/`LegacyProjectRestoreJournal`，均写入稳定的 `ArchiveControlStore`，而不是假装存在 Git binding。归档前 registry 必须以 `legacy_project_instance_id`、`legacy_project_lease_key` 和已验证的 `legacy_asset_manifest` 固定源数据库、封面、LegacyControlStore 审计资产及其 physical identity；归档目标只能由该 instance 与服务端生成 `archive_id` 推导为 `<data>/archives/legacy/<legacy_project_instance_id>/<archive_id>/`。在首个 artifact 变更前，journal 必须先记录 `registry_archiving_intent`，随后以 registry CAS 将路由从 `active` 原子改为 `archiving`，再记录 `registry_archiving`；因此状态固定为 `legacy_archive_prepared → registry_archiving_intent → registry_archiving → artifacts_staged → archive_published → registry_retired → legacy_archived`。只有在尚未发布/移动任何 artifact 且安全中止谓词成立时，才可 CAS 回 `active`；其后只能前滚或 `RECOVERY_REQUIRED`。恢复时宿主先在 registry lease 内保留显示名并生成新的 `legacy_project_instance_id`、新的 `legacy_project_lease_key` 和由 registry 生成的 opaque `legacy_asset_locator`；`target_name` 只参与显示名唯一性，不能构造路径。恢复同样先记录 `registry_restoring_intent` 并把对应 archive route 原子改为 `restoring`，状态为 `legacy_restore_prepared → registry_restoring_intent → registry_restoring → artifacts_staged → artifacts_published → registry_activated → legacy_restored`。恢复后的项目仍为 `sqlite_legacy`，不分配 `project_uid`/`project_storage_key`，旧 instance 的请求一律陈旧；LegacyControlStore 的历史副本只读保留，并为新 instance 新建活动控制面。任一 manifest、source/target identity 或 registry after 谓词不匹配时保留现场并进入 `RECOVERY_REQUIRED`，不得隐式迁移、永久删除或按名称猜测资产。

`ProjectArchiveJournal` 必须在首个移动前由不随项目移动的应用级 `ArchiveControlStore` fsync，记录项目 UID/实例/storage key、源/目标规范路径和文件系统身份、SQLite/仓库/HEAD/ref/index snapshot、每个 artifact 的 before/after 谓词、registry route 的 before/after generation 与活动注册状态。项目原有 ControlStore 在归档开始前必须没有非终态记录，并作为普通 artifact 被保存；归档过程的状态推进只依赖 `ArchiveControlStore`，writer lease 也持续位于稳定应用锁根，不能随项目控制目录移动。归档/恢复中的 lease 只可接受 journal 已记录的 source 或 target 物理身份，遇到第三个身份立即 `RECOVERY_REQUIRED`。

含应用拥有 Git 仓库的归档和恢复都必须使用 `LifecycleGitFence`：它是记录在 ArchiveControlStore 中的 `.git/index.lock` marker fence，不是 index，也绝不 rename 为 `.git/index`。fence intent 记录源/目标仓库根、两端文件系统身份、`RepositoryIdentityGuard` snapshot（HEAD/ref/reflog/index）和 marker nonce；取得后在每次目录移动前重 probe，任何变更返回 `ARCHIVE_GIT_CHANGED` 且不移动。仓库根与目标仓库父目录不在同一文件系统时，归档或恢复在首个 artifact 变更前返回 `GIT_ARCHIVE_CROSS_FILESYSTEM_UNSUPPORTED`；不得复制 `.git`、逐文件搬运 worktree、改变 registry 或移动其他 artifact。只有同一文件系统才可把整个仓库根作为无覆盖原子目录 rename 移动；marker 随仓库根移动，release 也须在记录的 target identity 下完成。外部直接 Git plumbing 绕过 index lock 不在并发保证内，但 fence 的前后 snapshot 不匹配绝不被自动覆盖。

`git_ready` 归档状态为 `archive_prepared → registry_archiving_intent → registry_archiving → git_fence_intent → git_fence_acquired → artifacts_staged → archive_published → git_fence_release_intent → git_fence_released → registry_retired → archived`；所有非 Git artifact 仍可按 journal 复制、校验、fsync 和可恢复切换。`registry_archiving` 必须在首个 fence/artifact 变更前以 CAS 把普通路由变为 `archiving`；只有完整 archive after 谓词成立后，才在**权威 registry** 中原子退役活动实例、写入 archive record 并重建 `recent_projects` 投影。中断或失败不得把项目报告为删除，也不得递归清理现场。

上述 `git_ready` 归档的显式恢复只能由受信任本地宿主调用 `restore_project(archive_id, target_name)`。`target_name` 仅参与显示名唯一性校验，绝不参与目标路径推导。宿主先在 registry lease 内于 `ArchiveControlStore` 创建 `ProjectRestoreJournal`，并校验 archive ID、原项目 UID、目标显示名、活动注册项和由新 `project_storage_key` 推导的规范目标路径均唯一；已有活动项目使用该 UID、名称或目标路径时返回 `RESTORE_TARGET_CONFLICT`，不得覆盖或借同名路径猜测。恢复在首个 artifact/fence 变更前先写 `registry_restoring_intent`，以 CAS 标记 `restoring` 后才继续，状态为 `restore_prepared → registry_restoring_intent → registry_restoring → git_fence_intent → git_fence_acquired → artifacts_staged → artifacts_published → binding_rebound → git_fence_release_intent → git_fence_released → registry_activated → restored`。`artifacts_published` 后，`SQLiteProjectionStore` 必须以候选数据库原子更新 `manuscript_binding` 的新 `project_instance_id`、规范仓库路径/文件系统身份、文章状态和格式版本，并重新核对 Git `project_uid`；随后在新 storage key 下创建新的活动 ControlStore，写入 `restored_from_archive`/rebind 事件并使旧 instance 的 operation、receipt 和确认永不可执行。归档中的旧 ControlStore 仅作为只读审计 artifact 保留，不能被重新激活。只有 binding 与新 ControlStore 均验证后才写活动注册并进入 `registry_activated`。恢复保留原 `project_uid`，但必须分配新的 `project_instance_id` 和新的 `project_storage_key`；同名新建始终产生新的 UID、instance 和 storage key。永久清除归档是第一版之外的独立破坏性维护操作。

## 7. AI 工具、草稿同步与用户确认

所有 AI tool 调用都携带由宿主注入、模型不可伪造的执行上下文：绑定的本机项目实例、可信调用方身份与 action origin；仅 chat origin 携带会话身份。它们不同于 `project_uid`，后者只用于定位文章项目。

### 7.1 DraftCoordinator：可信草稿同步屏障

DraftCoordinator 是桌面端可信宿主与 ManuscriptService/本机领域服务之间的协调层，不是 AI tool。每个打开的编辑器以 `{ project_instance_id, writer_session_id, editor_instance_id, resource_uid }` 注册；正文、章节元数据、结构资源和可离线编辑的角色/世界观等本机实体或表单都可成为 `resource_uid`。它维护项目级的全局 dirty-resource registry，除已挂载编辑器外还必须覆盖已经切页/卸载但仍位于正文队列、标题队列、结构编辑队列、本机表单队列和 `draft_backups` 中的草稿；没有挂载编辑器绝不表示没有本地草稿。

`writer_epoch` 是服务端按 `{ project_instance_id, resource_uid }` 保存的单调 resource epoch。每个保存项入队时固定其 `editor_instance_id`、resource epoch 和本地 sequence。普通写入必须携带当前 epoch；开始同步时服务先原子地把目标资源置为 frozen 并生成一次性 `draft_sync_request_id`。冻结状态下只有绑定该请求的内部捕获批次可以提交，普通 REST 保存和迟到 autosave 一律返回 `EDITOR_FROZEN` 或 `EDITOR_EPOCH_STALE`。

冻结不是无主布尔状态。每个冻结记录必须持久化 `{ project_instance_id, resource_uid, owner_kind, owner_id, owner_token, sync_target_set_digest, state }`；`owner_token` 由服务端生成且 renderer 不可指定。草稿同步以 `draft_sync_request_id` 为 owner，关联 operation 只能引用该 owner，不能在后续偷换成另一 operation。一个 `sync_target_set` 的冻结必须在同一 ControlStore CAS 中完成：先验证集合内全部资源都未冻结，或全部已由相同 owner/token 持有且集合摘要完全一致，再一次性写入整个集合。任一资源被其他非终态 owner 持有时返回 `DRAFT_RESOURCE_BUSY`，不得部分冻结、部分捕获或悄悄扩大原集合；同一 owner 的重试只在 target-set digest 相同时幂等恢复，集合扩大必须先把原流程转为 stale、释放后重新准备。

模型调用 `prepare_*` 时，工具路由器先按规范化参数、当前工作区和操作结构闭包计算初始集合；可信宿主再提交全局 dirty-resource inventory，最终 `sync_target_set` 是两者及其结构依赖的保守并集。若当前会话没有覆盖该集合的有效草稿同步收据，服务持久化 `waiting_draft_sync` operation，发出 `draft_sync_required`，并结束本次模型工具流；模型既看不到也不能在 JSON 参数中提供 receipt/token。

草稿捕获顺序固定为“冻结输入和定时器 → 捕获全部缓冲与队列 → 持久化必要备份 → 按操作策略处理权威文件”。checkpoint 可把捕获批次用 `draft_sync_request_id` drain 到 ManuscriptService；restore 必须先保存捕获草稿的不可变 `draft_backup`，再形成恢复预览；`accept_worktree` 只能保存并退役本地草稿，绝不得把它 drain 回权威正文；`apply_saved_draft` 只能应用已持久化且与冲突快照绑定的 `draft_backup_id`。首次确认 `EXTERNAL_DRAFT_CONFLICT` 时必须创建该不可变备份，不能只把草稿留在 renderer 内存中。第 5.3 节规定的 `prepare_apply_revision` dirty 检查是唯一前置例外：命中时在冻结/capture/operation 之前直接返回 `LOCAL_DRAFT_CONFLICT`，不适用本段的捕获策略。

成功后服务内部持久化 `draft_sync_receipt`，至少绑定同步请求、项目 UID/实例、会话、目标资源集合、参与 editor instance、捕获 generation、已持久化 `data_version`、投影 generation、权威文件原始哈希、每个资源 epoch、创建时间和有效期。收据有效时，宿主调用内部确定性“继续准备”流程；它只使用已持久化的规范化请求和收据计算不可变预览，不恢复旧模型 tool loop。只有完整预览已生成且其 digest、闭包和所有 precondition 仍通过同一 CAS 时，才将 `waiting_draft_sync` 领取为 `awaiting_approval` 并持久化 preview snapshot。用户取消、收据到期、预览基准变陈旧和捕获/保存失败分别将 `waiting_draft_sync` 终态化为 `cancelled`、`expired`、`stale` 或 `failed`；目标集合扩大或最终文件闭包超出同步集合时先转为 `stale`，释放冻结且不执行操作。

冻结从开始捕获持续到关联 operation 的任一终态。终态化、取消、过期、stale、失败和崩溃恢复只能由持有相同 `owner_token` 的流程，以覆盖完整 `sync_target_set` 的同一 ControlStore CAS 释放冻结，并让每个资源 epoch 恰好推进一次；owner/token 不匹配返回 `DRAFT_FREEZE_OWNER_MISMATCH`，不得改变任何较新的冻结或 epoch。恢复器只能使用 ControlStore 持久化的 owner/token，不能按 resource UID 猜测所有者。释放成功后服务向参与编辑器发出 `authoritative_refresh_required`，携带新 generation 与原始哈希；客户端刷新基准并确认后才可取得新 epoch、重新编辑。任何持有旧 epoch 的延迟自动保存不得覆盖 restore 或冲突解决后的正文。

### 7.2 模型可见工具与交互屏障

只读工具：

- `get_manuscript_status(project_uid)`：返回固定分支/HEAD、受控工作区状态、未存档章节、投影 generation、待审提案和阻断冲突。
- `list_changed_chapters(project_uid, cursor, page_size)`：返回章节及结构文件变化、摘要和建议原子闭包。
- `get_chapter_history(project_uid, chapter_uid, cursor, page_size)`：按稳定 UID、受控历史路径和章节 sidecar 查询，返回摘要和有时效、绑定仓库/调用方/origin（仅 chat 时带会话）的 `history_handle`。
- `get_chapter_diff(project_uid, chapter_uid, from_version, to_version)`：版本只能是此前返回的 `history_handle` 或 `WORKTREE`，不能是调用者自填 Git ref。
- `get_chapter_sync_conflict(project_uid, chapter_uid)`、`get_operation_status(operation_id)` 和 `list_pending_operations(project_uid, cursor, page_size)`：返回结构化状态，不清除草稿或操作记录。

#### 7.2.1 可信 capability profile 与完整工具矩阵

每次 AI interaction 都先按第 5.3 节由可信宿主在首次网络请求前创建/重取耐久 `AIInteractionRecord`，再由独立保存的原始用户动作、当前项目/会话、已确认的领域清单和固定 `CapabilityRegistry` 版本派生并持久化不可变 `capability_profile`。它至少包含：registry version/digest、精确 tool allowlist、允许的目标/资源集合、字段 mask、创建/删除数量上限、条件 grant/receipt digest、可选的 bounded `derived_resource_grant`、有效期和 interaction 绑定。renderer 传入的 `mode`、提示词文本、模型输出或后续 tool 参数都不能扩大权限。服务端只从这份 profile 过滤后的注册表生成 provider schema、执行 allowlist 和工具说明，不得再把完整 `TOOLS` 数组无条件传给 writing/collab 两种模式。未注册、越权或已移除的调用必须得到配对的 `TOOL_NOT_ALLOWED` tool result，且零副作用。

第一版现有及新增工具的归属固定如下：

| 类别 | 工具 | 规则 |
| --- | --- | --- |
| 文章/版本只读 | `list_chapters`、`get_chapter`、`list_volumes`、`get_manuscript_status`、`list_changed_chapters`、`get_chapter_history`、`get_chapter_diff`、`get_chapter_sync_conflict`、`get_operation_status`、`list_pending_operations` | 可用于相应 query/writing/collab/version profile；统一经过 `ensureReadableProjection()`、`ActiveManuscriptProjection` 和受限输出协议 |
| 普通文章写入 | `create_chapter`、`update_chapter` | 只在可信宿主记录了明确章节创作/修改请求的 writing 或 collab profile 中注册 |
| 普通卷写入 | `create_volume`、`update_volume` | 只在共创分卷规划已取得作者明确确认、且宿主注入有效 `structure_confirmation_receipt` 时注册；`update_volume` 只能修改标题/摘要 |
| 本机领域只读 | `list_characters`、`get_character`、`list_world`、`list_foreshadows`、`list_relations`、`list_memories`、`list_timeline`、`get_stats`、`list_science`、`list_chapter_characters`、`list_clues`、`get_project_meta` | 不写 Git；涉及章节引用时仍只接受活跃投影中的稳定 ID |
| 本机领域变更 | `create_character`、`update_character`、`delete_character`、`create_world_entry`、`update_world_entry`、`delete_world_entry`、`create_foreshadow`、`update_foreshadow`、`delete_foreshadow`、`create_relation`、`update_relation`、`delete_relation`、`create_memory`、`update_memory`、`delete_memory`、`create_timeline_event`、`update_timeline_event`、`delete_timeline_event`、`create_science_entry`、`delete_science_entry`、`create_clue`、`update_clue`、`delete_clue`、`set_chapter_character`、`remove_chapter_character`、`update_project_phase` | 不写文章文件，但必须经过项目 writer coordinator、`SqlJsAtomicStore` 和 `ai_tool_invocation`；章节外键只可指向活跃章节 |
| 准备类版本操作 | `prepare_checkpoint`、`prepare_restore`、`prepare_resolve_sync_conflict`、`prepare_apply_revision` | 只创建 operation，不直接执行；遵守 DraftCoordinator、确认卡和 interaction barrier |
| 专用宿主 AI 流 | `/api/ai/continue`、`/api/ai/polish`、`/api/ai/task`、`/api/ai/provider-probe` | 不是模型 tools；续写按第 7.2.3 节执行，润色按第 7.2.4 节只创建提案，页面 task 与探测按第 7.2.5 节执行 |
| 不向模型暴露 | `delete_chapter`、`delete_volume`、任何章节/卷移动或重排、任意 Git/shell 命令 | 从 provider schema、提示词和工具映射中全部移除；可信 UI 的相应领域操作另走确定性宿主接口 |

profile 的基线真值表固定如下；表中的“条件 grant”不是动态扩权，而是首个模型调用前已写入当前 profile 的精确 tool/目标/字段集合：

| profile | 无条件 allowlist | 仅凭已持久化条件 grant 可增加 | 禁止 |
| --- | --- | --- | --- |
| `query` | 第 7.2.1 表中的文章/版本只读与本机领域只读 | 无 | 一切变更与 `prepare_*` |
| `writing` | 全部只读工具 | 原始用户动作明确列出的 `create_chapter`/`update_chapter`、本机领域变更及其精确 target/field mask | 卷结构变更、`prepare_*`、删除章节/卷、移动/重排 |
| `collab` | 全部只读工具 | 原始用户动作明确列出的章节/本机领域变更；仅凭 `structure_confirmation_receipt` 增加其 manifest 中的 `create_volume`/`update_volume` | `prepare_*`、删除章节/卷、移动/重排 |
| `version` | 文章/版本只读工具与 `get_operation_status`/`list_pending_operations` | 明确版本动作对应的一个 `prepare_*`；最终执行永不在模型 allowlist 中 | 普通文章/卷/本机领域变更、任意 Git/shell |

`capability_profile` 只能缩小：query 请求不得因处于 writing 页面而获得写工具；writing/collab 请求也不得自动获得版本执行器。每个新的用户动作或作者确认都创建新的 interaction；旧 interaction 不得因后续确认而动态加权。共创中的卷创建/改名还必须使用由可信宿主签发、一次性按 manifest 项消费的 `structure_confirmation_receipt`，绑定项目实例、聊天会话、原始用户确认消息、已展示分卷方案摘要、精确 canonical mutation manifest（标题、摘要、插入点、数量）和有效期；receipt 不进入模型 JSON，模型改变任何 manifest 字段或用不同 tool-call ID 重放时必须重新取得作者确认。

#### 7.2.2 可信 precondition 与原子 handle 领取

模型不得直接填写 epoch、generation、row version 或 raw hash。服务端只在当前 interaction 或页面 task 的 capability profile 允许相应写入时，通过 `WriteHandleStore` 签发短期、一次性、不可伪造且不透明的 handle；每个 handle 还绑定允许的操作类型、目标集合、字段 mask、profile digest、调用方/origin、仅 chat origin 才有的会话、interaction 或 task request 和有效期。工具输入 schema 与服务端参数校验都必须为 closed：未知字段、越出 grant 的 target/字段、额外闭包或模型自造 UID/路径一律返回 `INVALID_TOOL_ARGUMENTS` 或 `TOOL_NOT_ALLOWED`，零副作用。

- `get_chapter` 可返回 `chapter_write_handle`，绑定项目 UID/实例、`chapter_id`/`chapter_uid`、资源 epoch、projection generation、`.md/.json` 当前 raw hashes、pending revision ID/version 和有效期；其字段 mask 只有在正文完整、未截断且属于可写 Markdown 方言时才包含正文。只读透传正文或受限输出可授予元数据-only handle，但绝不授予正文替换 handle。
- `list_chapters`/`list_volumes` 可返回 `structure_write_handle`，绑定当前结构 generation、目标容器与索引/总清单 raw hashes；`list_volumes` 还可为每个活跃卷返回 `volume_write_handle`。所有返回的 handle 只能原样回传，模型不能读取、构造或替换其中的 precondition。
- 本机领域的 `get_*`/`list_*` 在 profile 授权更新/删除时，必须为每一可写实体签发 `entity_write_handle`，绑定稳定实体键、规范行摘要或 row version、`data_version`、connection epoch、允许字段和 interaction；create 使用 `entity_collection_write_handle`，绑定 collection generation、唯一性前提和数量上限。执行时必须 CAS 语义行版本/摘要，而不把 `connection_epoch` 当作行级并发版本。非文章可编辑表单也必须注册为 DraftCoordinator dirty resource；若某入口不支持本地草稿，才可由其“提交即持久化、无本地队列”不变量显式声明为空。
- handle 签发和执行前都必须重新查询 DraftCoordinator 的全局 dirty-resource registry。文章目标正文/sidecar、结构闭包或本机实体与任一已挂载、已卸载或队列中的草稿重叠时，返回 `LOCAL_DRAFT_CONFLICT`，不自动 drain、不创建文件 journal、不修改提案。可信宿主可先显式捕获并保存草稿，再由新的 interaction 重新读取和签发 handle。

创建资源不是对 profile 的动态扩权。profile 中可预先包含有界 `derived_resource_grant`，其内容固定为 parent tool（`create_chapter`、`create_volume` 或一个明确 `create_*`）、数量预算、允许容器/插入范围、初始字段 mask、允许的 follow-up action/field mask、profile digest、interaction、有效期与 creator invocation lineage。成功创建时，服务只能针对**该次** creator invocation 生成的新 server UID/稳定 ID materialize 一个衰减 grant，并以当前 row/raw-hash/epoch/generation 签发相应 `chapter_write_handle`、`volume_write_handle` 或 `entity_write_handle`；它只能在同一 interaction 使用，不能派生创建权、额外目标、额外字段、collection grant 或另一条 derived grant。若 parent profile 没有预声明 follow-up，则成功结果只返回新资源身份和只读结果；不存在、越权、过期或跨 invocation/interaction 的派生 grant 返回 `DERIVED_CAPABILITY_NOT_GRANTED` 或 `WRITE_HANDLE_INVALID`，零副作用。

handle 领取固定在项目 writer lease/FIFO 内，并与 `ai_tool_invocation` 的 `invocation_id` 原子绑定。状态为 `issued → claimed(invocation_id) → consumed | stale | expired`。先创建 invocation 的 `received` record；静态绑定/过期/签名/摘要或参数检查失败时，先将该 invocation 持久化为 `failed` 并写入完整错误 payload；仍为 `issued` 但当前文件/结构/实体 precondition 已变化时，将 handle 与 invocation 持久化为 `stale` 并返回 `WRITE_PRECONDITION_STALE`。只有通过这些检查时，`handle issued → claimed(invocation_id)` 与 `invocation received → executing` 才能在**同一个** ControlStore CAS 中完成，随后再 fsync 首个 mutation intent；不得出现可观察的 `claimed + received + 无 intent` 空档。错误优先级固定为：跨项目/实例/会话/interaction、过期、签名或摘要不匹配返回 `WRITE_HANDLE_INVALID`；已由**同一** invocation 领取时返回该 invocation 的既有状态/最终结果；已由其他 invocation 领取时将新的 invocation 持久化为 `failed(WRITE_HANDLE_ALREADY_USED)`；已领取但 intent 前崩溃的 handle 依第 5.3 节随 invocation 消费，绝不转交。成功或 stale 的领取均不能被另一次 tool-call 复用。成功写入会使所有覆盖旧 epoch/generation/hash 的未领取 handle 失效；同一 AI 工作流的下一次更新必须使用写入结果返回的新 handle，或重新调用读工具。

普通文章工具签名固定为：

~~~text
create_chapter(
  project_uid,
  target_container,
  insert_after_chapter_uid_or_null,
  chapter_number,
  fields,
  structure_write_handle
)

update_chapter(
  project_uid,
  chapter_id,
  patch,
  chapter_write_handle
)

create_volume(
  project_uid,
  insert_after_volume_uid_or_null,
  fields,
  structure_write_handle
)

update_volume(
  project_uid,
  volume_uid,
  patch,
  volume_write_handle
)
~~~

两个 `insert_after_* = null` 都表示追加到目标集合末尾。`create_chapter` 由服务生成新 `chapter_uid`；`fields.title` 必填，正文、摘要、大纲和叙事字段采用规范空值，状态默认 `pending`。它只发布新 `.md/.json`、目标索引，以及目标为 `unassigned` 时同步的 `manuscript.json`。`update_chapter` 只能修改 patch 明示的正文或 sidecar 字段；正文 patch 按第 5.3 节处理 pending proposal，元数据 patch 绝不得重写 `.md`。`create_volume` 由服务生成 `volume_uid`，闭包只能包含新卷 `index.json` 与 `manuscript.json`；`update_volume` 只能修改该卷 `index.json` 中的标题/摘要。模型只能回传读工具给出的既有目标 UID；新 UID、路径、额外闭包和 precondition 内容均由服务决定。

每个无需确认、直接执行的普通文章/卷/本机领域变更调用都必须先创建第 5.3 节的 `ai_tool_invocation`。同一 provider 批次中的多个普通变更不是一个原子事务：服务按模型给出的顺序逐项执行并逐项返回结果；前一项成功后，后续调用若携带已经被其他 invocation 领取的相同 handle 返回 `WRITE_HANDLE_ALREADY_USED`，若携带尚未领取但已因前一项变化而陈旧的 handle 返回 `WRITE_PRECONDITION_STALE`，不得隐式刷新 handle。

#### 7.2.3 AI 续写的生成基准 CAS

AI 续写不是普通模型 tool，也不得在模型生成期间持有 OS writer lease。可信宿主在发出请求**前**通过 `ClientAIActionStore` 生成并持久化 `client_continuation_key` 与规范化请求 digest；它在 `{ project_instance_id, request_origin, optional chat_session_id, user_action_id, client_continuation_key }` 内唯一，其中 `request_origin = chat | editor`，editor 不要求会话且 `chat_session_id = null` 合法。服务必须在冻结任何资源前按该唯一键原子查找/创建耐久 `continuation_request`：相同 key/digest 只返回同一 request，绝不再次冻结、分配 sequence 或调用 provider；相同 key 不同 digest 返回 `CONTINUATION_KEY_REUSE`。若同一章节已经存在另一条非终态 request，不同 key 返回 `CONTINUATION_IN_PROGRESS`，不得抢占、转移或释放对方冻结，也不得调用 provider。

首次创建 continuation request 时，服务先在短 writer lease 内 fsync `waiting_draft_sync` record，分配按章节单调递增的 `continuation_request_sequence`、`continuation_request_id`、项目 UID/实例、章节 ID/UID、模型/请求参数摘要、空工具 schema 的 `prompt_policy_snapshot`/digest、`client_continuation_key`、规范化请求 digest、创建时间和不可伪造的 `freeze_owner_token`；此时尚不填写 base body。record 耐久后，DraftCoordinator 才能以 `{ owner_kind = continuation_request, owner_id = continuation_request_id, freeze_owner_token, draft_sync_request_id }` 原子冻结目标章节、捕获所有 writer session 和已卸载队列中的同资源草稿，并把捕获批次 drain 到 ManuscriptService。只有精确匹配该 owner token 的 request 可以释放冻结或推进 epoch；renderer、其他 request 和迟到回调都不能接管或解冻它。

草稿同步完成后，服务重新取得 writer lease，复验 request 仍为 `waiting_draft_sync` 且 freeze owner token 精确匹配，随后在同一 CAS 中持久化 resource epoch、base body 原始字节及 SHA-256、base projection generation、显式 pending revision expectation（`none` 或 ID/version）、完整同步收据，并从已固定的 `prompt_policy_snapshot`、该 base bytes 和 canonical `project_data` 组装实际 provider 输入，写入 `rendered_prompt_digest` 后创建或领取与该 request 一对一的 `AiModelTurn(turn_kind = continuation)`，再转为 `generating`。存储层必须强制 `UNIQUE(continuation_request_id)` 与 `UNIQUE(provider_request_id)`；request 固定精确 `turn_id`，turn 固定相同 continuation request ID、provider request ID、`turn_kind`、policy/rendered-prompt digest 和无 response 的初始状态。该 turn 与 request 共享服务端生成的 `provider_request_id`，两者构成唯一的 provider dispatch/recovery 单元；外发 provider 前，必须在同一 writer lease 内先把该 turn 的 `provider_dispatch_intent` fsync，之后才释放 lease 并调用 provider。续写没有独立于 `AiModelTurn` 的重试管理器：相同 continuation key 的恢复只能查询这同一个 turn，绝不得再次创建 turn 或二次派发 provider。任一参与者无法确认捕获时，request 终态化为 `failed(DRAFT_SYNC_INCOMPLETE)`，仅在 owner 精确匹配时释放冻结；不得启动 provider。

~~~text
waiting_draft_sync → generating → output_persisted → applying → completed
waiting_draft_sync → cancelled | stale | failed
generating → cancelled | stale | failed
output_persisted → cancelled | stale | failed
applying → completed | stale | failed
~~~

只有 `waiting_draft_sync → generating` 已耐久完成后才释放 OS writer lease；目标资源仍由该 `continuation_request_id`/`freeze_owner_token` 保持 DraftCoordinator frozen。模型提示只能由记录的 base bytes 构造；只读透传 Markdown、空/截断/未确认完成的模型输出在任何文件副作用前失败。provider 完成后，在取得任何文件 journal 前，必须以同一 ControlStore CAS 同时核验 `continuation_request.state == generating`、精确 `freeze_owner_token`、request 固定的 `turn_id`、`turn_kind = continuation`、turn 固定的 continuation request ID、turn 状态为 `provider_dispatch_intent`、request/turn 的唯一 provider request ID 相等、turn 尚无 response，以及回调输出的 canonical bytes/SHA-256 与将要写入 request/turn 的同一值；仅全部匹配时才耐久写入完整 continuation bytes、SHA-256、provider response ID、finish reason、完整性判定和受限输出证据，并把关联 `AiModelTurn` 的完整响应持久化为 `response_persisted → completed`（续写无 tool call），同时把 request 转为 `output_persisted`。不得只在内存或 SSE 缓冲中保留生成结果。任一不匹配的迟到/重复回调只能在既有精确 turn 写入有界、不可执行的诊断，返回 `CONTINUATION_LATE_PROVIDER_RESPONSE`，不得写入输出、改变 request 状态、释放冻结或产生文件/投影副作用。

随后服务重新取得 writer lease，恢复既有 journal，执行 `ensureProjectionCurrent()`，并以 CAS 将 `output_persisted → applying`：校验项目实例、章节仍活跃、freeze owner token 仍精确匹配、resource epoch、base body hash、projection generation 和 pending revision expectation（包含“起始时不存在 pending”）；同一资源至多一条非终态 request 是此前已建立的不变量。任一不匹配时把 request 终态化为 `stale`，将已经持久化的生成文本保留为有界、不可变、可复制的 continuation candidate，但绝不得写入正文。CAS 成功时，after bytes 必须只由记录的 base bytes、固定分隔符和完整已持久化输出构造，绝不能重新读取“最新正文”后追加；在首个文件副作用前 fsync `FilePublicationJournal` intent，再通过 FilePublicationJournal 和 SQLiteProjectionStore 发布 `.md` 与投影。若起始时绑定的 pending proposal 仍匹配，则按第 5.3 节在同一候选投影中将其转为 `stale`。

恢复时先核验 DraftCoordinator freeze owner 与 `continuation_request_id`/`freeze_owner_token`，并核验 `UNIQUE(continuation_request_id)`/`UNIQUE(provider_request_id)`、request 固定 turn ID、turn kind/request ID/provider request ID/dispatch state/response-empty 条件，以及 request/turn 共享 canonical output bytes/SHA-256 的精确 after 谓词。`waiting_draft_sync` 若尚无完整同步收据和 base snapshot，终态化为 `failed(DRAFT_SYNC_INTERRUPTED)` 并仅在 owner 匹配时释放冻结；若收据与 base snapshot 都完整，只可恢复确定性的 `waiting_draft_sync → generating` 交接，绝不在交接前调用 provider。owner 不匹配返回 `CONTINUATION_FREEZE_OWNER_MISMATCH`，保留现场并禁止写入或解冻。`generating` 且没有与关联 turn 同时持久化的完整输出/response 时终态化为 `failed(PROVIDER_INTERRUPTED_NO_OUTPUT)`，仅由匹配 owner 释放冻结且不自动重新调用 provider；若 turn response 与 request output 阶段未形成上述同一 CAS after 谓词，保留现场并返回 `RECOVERY_REQUIRED`，不得猜测前滚或重派 provider。`output_persisted` 或 `applying` 且尚无文件 intent 时只可用保存的输出重新执行上述 CAS；`applying` 且已有 file/projection intent 时只恢复该 journal，绝不再次追加或再调 provider。只有文件、投影、提案状态和 `continuation_request` 结果都达到可证明终态后才发送 `done`。取消、SSE 断开、进程崩溃和携带同一 `client_continuation_key` 的重试均按持久化状态恢复或返回原结果，不能生成第二次追加；终态后仅由匹配 owner 释放冻结并推进资源 epoch。

#### 7.2.4 AI 润色提案的耐久请求

`/api/ai/polish` 不是可绕过聊天协议的直接 `adapter.stream()` 调用。可信宿主必须在首次网络请求前通过 `ClientAIActionStore` 生成并持久化 `client_polish_key` 与规范化请求 digest；服务先以 `{ project_instance_id, request_origin, optional chat_session_id, user_action_id, client_polish_key }` 查找已有 durable request，其中 `request_origin = chat | editor`，editor 不要求会话且 `chat_session_id = null` 合法：相同 key/digest 只返回同一 request/turn，绝不二次调用 provider 或二次创建提案；key/digest 或 context 复用错误分别返回 `POLISH_KEY_REUSE` 或 `POLISH_CONTEXT_MISMATCH`。仅当该 key 尚无 request 时，服务才在短 writer lease 内检查目标正文/sidecar 的全部已挂载、已卸载和队列草稿，以及已有 `pending` proposal；任一存在则在创建 request/turn 或调用 provider 前返回 `LOCAL_DRAFT_CONFLICT` 或 `PENDING_REVISION_EXISTS`。同一 `{ project_instance_id, chapter_uid }` 必须有 partial `UNIQUE` 的非终态 polish request；不同 key 遇到既有 nonterminal request 返回 `POLISH_IN_PROGRESS`，不得并行派发 provider。通过后才由可信 `PromptAssembler` 原子创建 `polish_request`，固定 chapter ID/UID、模型/提示词策略摘要、完整 `prompt_policy_snapshot`（prompt family/version、固定行为指令、空工具 schema、允许的 `project_data` 来源/字段/限额）、不可变 `policy_digest`、请求 sequence、项目实例、正文 base bytes/SHA-256、projection generation、活跃章节与 pending proposal expectation、关联 `AiModelTurn(turn_kind = polish)` 和唯一 provider request ID。

~~~text
prepared → generating → output_persisted → proposal_persisted → completed
prepared → cancelled | stale | failed
generating → cancelled | stale | failed
output_persisted → stale | failed
proposal_persisted → completed
~~~

首次 request 在短 writer lease 内取得一致 base snapshot，并仅由已固定的 `prompt_policy_snapshot`、该 base bytes 与 canonical `project_data` 组装实际 provider 输入；它把实际字节的 `rendered_prompt_digest` 同时写入 request/turn，创建带 `UNIQUE(AiModelTurn.polish_request_id)` 的唯一 polish turn 和全局唯一 provider request ID，并在同一 CAS 把 request 领取为 `generating`。外发前 fsync 该 turn 的 `provider_dispatch_intent`，之后释放 lease 才调用 provider。只有非空、未截断、完成 finish reason 且通过输出规范化/限额校验的响应才可进入 `output_persisted`；其他完整但无效的响应必须在同一 CAS 终态化为 `AiModelTurn.failed(POLISH_OUTPUT_INVALID)` 和 `polish_request.failed(POLISH_OUTPUT_INVALID)`，零 proposal。有效响应时必须以同一 ControlStore CAS 同时核验 `polish_request == generating`、精确 turn ID/`turn_kind = polish`/polish request ID、turn 为 `provider_dispatch_intent`、request/turn 的 provider request ID、policy digest 与 rendered-prompt digest 都精确相等、turn 尚无 response，以及记录的项目实例/章节活跃状态/base hash/projection generation/pending expectation；通过后把相同 canonical output bytes/SHA-256、provider response ID、finish reason 和受限输出证据写入 turn 的 `response_persisted → completed` 与 request 的 `output_persisted`。任一不匹配的迟到/重复回调只能写入既有 turn 的有界、不可执行诊断并返回 `POLISH_LATE_PROVIDER_RESPONSE`，不得写 output、proposal、正文或投影。

`output_persisted → proposal_persisted` 重新取得 writer lease，以 `PolishProposalJournal` 固定 request/turn/output/policy/rendered-prompt digest、章节活跃状态、base body hash、projection generation、pending expectation、proposal request sequence 与 `chapter_revisions` 的 before/after 候选数据库证据；只有这些条件在同一 SQLiteProjectionStore CAS 中仍匹配，才创建该 request 唯一的 `pending` proposal 并发布候选库。任一基准变化或已有 pending proposal 时 request 转为 `stale`，完整润色输出保留为有界、不可变、可复制 candidate，绝不自动 rebase、覆盖或接受。恢复时，若 `generating` 只有该 turn 的 `provider_dispatch_intent` 而无完整有效 response，必须以同一 after 谓词终态化为 `AiModelTurn.interrupted(PROVIDER_RESPONSE_UNRECOVERABLE)` 与 `polish_request.failed(POLISH_PROVIDER_INTERRUPTED)`，绝不得重派 provider；其余崩溃只能按 request、turn 和 `PolishProposalJournal` 的精确 after 谓词完成或终态化。聊天/SSE 恢复只读取持久化 turn 与 request 事件。

#### 7.2.5 旧聊天入口、页面专用 AI task 与 Provider 连通性探测

遗留的 `POST /api/ai/chat` 不再是可直接调用 `adapter.complete()` 的 provider 入口：实现必须删除该直接分支，或无条件返回 `AI_LEGACY_CHAT_ENDPOINT_DISABLED`；任何仍需普通聊天的调用必须迁移到带可信 `client_interaction_key` 的 `/api/ai/chat/stream`。设置页和所有现有非聊天 AI 调用不得继续把任意 `messages`/JSON 送入这个旧路由；它们必须分别迁移到本节的页面 task 或 provider probe，旧路由不得到达 adapter。设置页的 Provider 连通性测试改走受信任的 `/api/ai/provider-probe`：宿主在发起前通过 `ClientAIActionStore` 持久化 `client_probe_key` 与配置版本/规范请求 digest，`ProviderProbeRequest` 以 `{ trusted_caller_id, client_probe_key }` 唯一，保存 provider 配置身份摘要（绝不保存明文密钥）、固定无项目数据/无工具的 `prompt_policy_snapshot`、policy digest、实际 probe bytes 的 rendered-prompt digest、唯一 provider request ID 和关联 `AiModelTurn(turn_kind = provider_probe)`。相同 key/digest 只重放同一耐久结果，context/digest 不同返回 `PROBE_CONTEXT_MISMATCH` 或 `PROBE_KEY_REUSE`；外发前 fsync turn 的 dispatch intent，完整 response、失败与无 response 中断均按第 5.3 节 `AiModelTurn` 状态机持久化。probe 不创建聊天消息、interaction、operation、项目数据或任何写入 handle；SettingsDrawer 只能显示其结构化结果。

#### 7.2.5.1 页面专用 AI task 迁移

禁用旧 chat 后，所有非聊天 AI 入口统一迁移到受信任的 `/api/ai/task`；它不是第二个自由 provider 代理，只接受服务器注册的 `task_kind`、对应 `ClientAIActionStore` action/key，以及该 task closed schema 中允许的目标 ID/用户输入。它拒绝调用方传入 `messages`、system prompt、tools、mode、provider 配置、任意 JSON schema 或任意 `project_data`。`AiTaskRegistry` 为每个 task 固定数据读取器、origin、typed output schema、prompt policy、能力 profile/预算和允许的完成动作；创建 `AiTaskRequest`、`AiModelTurn(turn_kind = page_task | session_title)` 后，仍使用第 5.3 节的 dispatch、completion、预算与恢复契约。

纯分析 task 使用空工具 schema，服务端校验并持久化 typed output，renderer 只能展示该结构化 payload，不能自行解析自由文本后写 REST。需要产生本机/文章变更的 task 只能在原始用户点击所派生的受限 profile 中暴露精确工具，并经 `ai_tool_invocation`、write handle、`ManuscriptService`/`SqlJsAtomicStore` 完成；renderer 不得将模型 JSON 转成 REST create/update/delete。第一版迁移表固定为：`outline_generate` 只允许当前章节的受限 `update_chapter` 字段集；`outline_optimize` 为无工具 typed suggestion；`consistency_deep_check` 为无工具 typed issues；`foreshadow_design` 为有界 `create_foreshadow`；`memory_extract` 为有界 `create_memory`；`relation_organize` 为有界 `create_relation` 且只使用服务端提供的现存 character ID；`session_title_generate` 为有界 typed title，再由 `ChatSessionService` 在同一 durable invocation/`SqlJsAtomicStore` 中仅更新原 placeholder session；SettingsDrawer 使用既有 provider probe。`aiApi.chat`、页面 `extractAIJson* → REST` 链路和旧直接 adapter 分支必须全部删除或封禁，不能只改 URL。

#### 7.2.6 提示词与工具注册同源

`CapabilityRegistry` 是工具 schema、能力标签、参数 closed schema、字段 mask 和面向模型的工具说明的唯一权威来源。服务端 `PromptAssembler` 对普通聊天只从已持久化 interaction/profile 的**过滤后 registry**生成 provider schema、工具说明、prompt family 与项目上下文；续写和润色只从各自 request 固定的 `prompt_policy_snapshot` 生成空工具 schema、专用 prompt family 与项目上下文；页面 task 只从 `AiTaskRegistry` 固定的 policy/profile 取得 schema、prompt family 与已允许的项目数据；provider probe 只使用其固定、无项目数据的空工具 policy。每种路径的 schema、工具说明（如有）、prompt family 与 `project_data` 都必须使用同一 policy digest，并在实际输入组装后记录独立的 rendered-prompt digest。`server/prompts/writing.js`/`server/prompts/collab.js` 只保留不含工具签名的行为指令：writing 指令说明“读取并取得 handle → 写入 → 使用新 handle 或重新读取”，查询不得被包装成强制 `update_chapter`；collab 未有 receipt 时只能讨论分卷方案，有 receipt 时也只允许 registry manifest 中的 `create_volume`/`update_volume`。文章正文、标题、大纲、状态和卷结构统一表述为写入“文章工作区”，不得继续声称 SQLite 是正文权威；角色、世界观等本机领域数据仍可表述为本机数据库数据。

所有项目可编辑文本一律是不可信的 **data-only** 输入：包括 Git/SQLite/本地队列/导入/历史中的 Markdown 正文、标题、大纲、摘要、sidecar/清单任意文本、项目元数据、角色、世界观、伏笔、关系、记忆、时间线、线索、科学条目、diff、Git 日志和提交说明，以及未来新增字段。PromptAssembler 必须先由固定可信代码生成 system/行为指令、prompt family、provider schema 和工具说明，再把这些内容以固定 schema、来源标签、长度限制、规范序列化和显式非指令边界的独立 `project_data` envelope 提供；project data 的 canonical bytes 必须纳入 prompt digest。项目文本不得通过字符串拼接进入 system/developer 指令、工具定义、角色字段、函数名、路由、profile 选择或 capability 参数；其中的“忽略规则”“调用工具”“切换模式”等只能作为待讨论/创作素材。

renderer 的 `mode`、包装提示和用户文本都是不可信输入，不能选择系统策略、prompt family、项目上下文或 allowlist；原始用户文本必须作为独立 user message 保存。中英文 i18n 只提供 UI 文案，不提供模型工具定义。`/api/ai/chat/stream` 必须从服务端 interaction record 取得 profile，`/api/ai/continue`、`/api/ai/polish`、`/api/ai/task` 与 `/api/ai/provider-probe` 必须从各自 durable request 取得 prompt policy snapshot；五者都拒绝 policy digest、rendered-prompt digest、provider schema、`project_data` envelope 或 PromptAssembler 输出不一致的调用。缺少 data-only 边界或其 digest 不匹配时返回 `PROMPT_CONTEXT_POLICY_VIOLATION`，不调用 provider。`src/lib/toolEntityMap.ts`、工具调用 UI 和持久消息恢复只消费服务端 registry 映射与完整 tool-result payload，必须认识 handle、invocation 状态和被移除的文章删除工具。

Git 版本操作的模型可见入口只有 `prepare_checkpoint(project_uid, scope, chapter_uids, message)`、`prepare_restore(project_uid, chapter_uid, history_handle)`、`prepare_resolve_sync_conflict(project_uid, chapter_uid, strategy)` 和 `prepare_apply_revision(project_uid, revision_id)`。`strategy` 仅允许 `accept_worktree` 或 `apply_saved_draft`。AI 可以创建提案，但不能直接接受提案；`prepare_apply_revision` 仅在通过第 5.3 节的前置 dirty 检查后才创建同样受确认卡和写入协调器保护的 operation，最终应用仍只能由可信宿主执行器完成。

第一版 `prepare_restore` 是严格的正文原始字节恢复。其文件闭包只能包含当前活跃章节的 `ch_<chapter_uid>.md`；当前 sidecar、卷/未分卷索引和 `manuscript.json` 均保持不变。恢复快照必须保存 `source_commit_oid`、`source_body_blob_oid`、当前正文 before 哈希和来源正文 after 哈希。来源 commit 中章节不存在、章节当前已被删除，或历史路径/UID/mode 校验失败时返回不可恢复错误，不得借 restore 重新创建章节或改变结构。通过 UTF-8 校验的只读透传 Markdown 可以不经解析/规范化按原始字节恢复；恢复后仍保持 `UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE` 锁定。

`prepare_*` 预检通过后创建不可变 operation：草稿收据和预览均已有效时为 `awaiting_approval`，否则为 `waiting_draft_sync`；两者都不改 Git index、HEAD 或 refs。工具路由器收到完整模型 tool-call 批次后，必须在向客户端发出任何工具执行事件或执行任何工具前完成预检：不含 `prepare_*` 的批次按领域工具规则执行；含一个 `prepare_*` 的批次不得再含其他调用；含多个或混合 `prepare_*` 的批次零副作用。

无论本次请求是否会再次调用模型，关联 `AiModelTurn` 都必须为该 assistant response 中**每个** tool-call ID 耐久写入一个配对 tool result：多个/混合 `prepare_*` 的每个调用写入 `INTERACTION_BARRIER`；合法的单个 `prepare_*` 在 operation 已持久化后写入 `{ status: awaiting_user, operation_id, operation_state, next_step }`；预检失败写入相应结构化错误。任何结果均须在发送 SSE、呈现确认卡或终止流前落盘，不能因“本轮不再重规划”留下未配对 tool call。合法 `prepare_*` 的配对结果和 operation 事件发送后，服务器立即以明确终止事件结束当前 SSE，不再调用模型；确认和确定性执行不恢复旧 conversation/tool loop，后续 AI 推理只能来自新的用户请求。

正文、diff、Git 日志和提交说明只是前段 data-only 边界所涵盖不可信数据的一部分。只读工具必须使用 cursor/page size、单项/总字节上限、结构化摘要和 `truncated` 标志；不得把无界文本直接注入模型上下文。

### 7.3 确认卡与宿主确定性执行

ApprovalService 不在 AI tools 命名空间中。可信宿主从服务端读取不可变 operation record，再渲染通用内联确认卡；卡片不得信任模型复述的文件列表、diff、摘要或风险文案。它至少显示：操作类型、目标章节/结构、完整文件闭包和新增/修改/删除类型、受限 diff/摘要、预期分支/HEAD、规范化提交信息、恢复来源、草稿/提案/冲突影响、风险说明、过期时间和 `preview_digest`。

`AIInteractionRecord` 创建时必须绑定 `interaction_origin` 与原始用户动作；仅 chat origin 绑定聊天会话，页面 task、editor 续写/润色和 provider probe 不得伪造或隐式借用会话。模型 tool-call ID 只有在对应 `AiModelTurn.response_persisted` 后才能关联。由 `prepare_*` 创建的 operation 必须来自 chat interaction，并引用该 turn、assistant 消息事件、tool-call ID 和已经持久化的配对 tool-result 事件；确认卡只根据这些耐久记录和 operation record 渲染，不依赖 renderer 临时状态或模型复述文本。即使 SSE 在 operation 创建后立即断开，重新打开或切回该聊天会话时，宿主也必须按该关联重新加载非终态 operation，并把确认卡恢复到对应消息事件下。

操作快照必须绑定项目 UID/实例、可信调用方/会话、目标 UID、结构范围、关联草稿收据、逐文件 before/after 原始哈希、预期 HEAD/ref、完整闭包、有效期和策略版本；并按操作类型保存第 5.3 节规定的专有字段。checkpoint 的预览 tree 只能由服务计算，不能接受模型提供的 tree 或路径。

用户点击“确认”只能通过 Tauri IPC 或等价本地可信通道提交真实手势。ApprovalService 的 `confirm_and_claim_operation` 以同一个 ControlStore CAS 校验操作仍为 `awaiting_approval`、项目/会话/调用方一致、卡片 digest 未变、草稿收据有效且快照未过期，记录 `user_confirmation_id` 和审计 `approved` 事件，并立即领取为 `executing`。该执行器不是模型可注册工具，也不是普通 REST 参数可调用的 endpoint；不得留下可被 renderer 崩溃永久卡住的 durable `approved` 空档。

用户取消只能将尚未领取的操作原子转为 `cancelled` 并释放冻结；已保存草稿、AI 提案和诊断不被删除。超时或收据先到期时，操作原子转为 `expired` 或 `stale` 并释放冻结。进程中断后，已有 journal intent 的 `executing` operation 依照其精确 snapshot 恢复；尚无 intent 的 `executing` operation 转为终态 `needs_reapproval`，使旧确认和草稿收据失效。用户如需继续，必须从卡片发起新的可信宿主“重新同步并预览”请求，生成以 `replaces_operation_id` 指向旧记录的新 operation 后，才可接受新的用户手势。绝不在重启后静默执行。宿主还必须提供 `cancel_operation`；重复查询/执行同一 operation ID 只返回已记录终态，不能再次产生副作用。

`operation_completed`、失败、取消、过期、`stale` 和 `needs_reapproval` 都必须作为持久化消息事件更新同一张卡。存在与该 `chat_session_id` 直接或间接绑定的未终态 durable AI work（`AIInteractionRecord`、`AiModelTurn`、`AiTaskRequest`、`ai_tool_invocation`、`operation`、`continuation_request`、`polish_request` 及其 journal），或尚未 `terminal_acknowledged` 的 `ClientAIAction` 时，聊天会话不得被静默删除。ChatSessionService 必须在同一项目协调边界先阻断新建会话绑定的 AI action，再原子返回 `SESSION_HAS_PENDING_AI_WORK`，零删除消息/session 行；终态审计记录按保留期保留，`chat_session_id` 是不可变、非 cascade 的历史绑定。editor origin 和 provider probe 无会话，不参与某个 session 的删除阻断。这样无需新增页面，重启、断线和会话切换后仍能在现有聊天消息流中完成确认、取消和重新审批。

## 8. 用户可感知流程（无新页面）

1. 作者或 AI 编辑章节；现有自动保存经 ManuscriptService 写入文章工作区，此时仅表示“已保存到文章文件”。
2. AI 需要存档、恢复或处理冲突时调用一个 `prepare_*`。服务计算目标资源；必要时聊天收到“正在同步草稿”的内联事件，目标编辑器冻结并落盘。
3. 草稿同步完成后，宿主用已持久化请求生成预览，在原聊天消息下展示服务端确认卡：准确文件闭包、受影响结构、差异摘要和风险均来自 operation record。
4. 用户确认后，宿主的确定性执行器完成 checkpoint、恢复或冲突解决，并在聊天中显示 commit ID 或结构化失败原因；模型不会在后台继续旧工具调用。
5. checkpoint 之后，未选择的工作区改动仍保留为未暂存修改。恢复和冲突解决只产生新的未存档工作区变化，之后仍需独立创建 checkpoint；它们绝不运行 `reset`、`checkout --` 或重写历史的命令。

## 9. 崩溃恢复与外部变化

文件、SQLite 和 Git refs 不能组成一个跨资源 ACID 事务，因此恢复依据是独立 journal 中的精确文件字节、OID、ref 和 index 证据，而不是 sidecar 正文哈希或 commit trailer。

- `FilePublicationJournal`：若当前每个文件都精确匹配记录的 before/after 组合，且候选 after 副本完整，优先前滚至完整 after 文件集；候选副本不完整时回滚至完整 before 文件集。任一文件存在第三种字节状态、路径不安全或结构校验失败时，标记 `RECOVERY_REQUIRED`，绝不自动覆盖。结构性发布还必须核对 marker nonce、lock 物理身份和 `git_snapshot_fence_*` 阶段；未知 marker 或 marker 已创建但未被 journal 完整归属时保持 `.git/index.lock` 并返回 `GIT_INDEX_LOCKED`。文件已发布但投影未提交时，从权威文件按 UID 重建候选投影/tombstone，并按 `SQLiteProjectionStore` 的 before/after 证据发布。
- `SQLiteProjectionStore`：正式数据库、候选数据库、before 副本和 ControlStore journal 只能形成精确 before/after 组合之一。正式数据库等于 before 且候选完整时可继续发布；等于 after 且完整性/外键校验通过时可前滚阶段；其余情况 fenced 为 `RECOVERY_REQUIRED`，拒绝连接继续写入。恢复会安装新的 `connection_epoch`，旧 epoch 的连接、timer 或回调必须永久返回 `DB_CONNECTION_STALE`；不得用新的空库、延迟 flush 或只重建章节投影覆盖该现场。
- Git checkpoint journal：若 journal 已持久化 `index_synchronized` 或 `external_head_advanced_after_checkpoint`，本 checkpoint 的副作用已经证明；恢复只核对固定 `new_commit_oid`/commit recipe 后写入 `completed`，绝不再因其后的外部 ref/index 变化判失败或回写，外部状态由下一轮仓库校验单独处理。`abort_intent` 与 `lock_release_intent` 只执行其记录的 abort/release 谓词，绝不回到 CAS 或 index publish；达到 `aborted` 后才完成关联 operation 的失败终态。其余阶段先验证 operation snapshot、writer lease、candidate 完整字节/语义指纹、commit recipe、parent/tree/ref、`RefStorageSnapshot`、受控工作区快照和真实 index 的 before/candidate 语义。原始 index 哈希仅是附加篡改证据，不能把只改变允许 stat-cache 的同语义 index 误判为冲突。若 `main == expected_old_oid`，仅当真实 index 仍满足 journal 的 before 语义、候选 commit/index 均完整且当前闭包 precondition 仍成立时，才在新取得且可证明归属的 lock 下重试同一 CAS；不得生成第二个 commit。若 `main == new_commit_oid`，真实 index 语义等于 candidate 时直接记为已同步；真实 index 语义等于 before 时才可在本应用 lock 下以前述 candidate 前滚；若 `main` 是 `new_commit_oid` 的受验证后代且真实 index 语义等于当前 HEAD，则记录 `external_head_advanced_after_checkpoint` 并完成；任何第三种 ref/index 组合均返回 `INDEX_DIVERGED_AFTER_REF` 或 `REF_ADVANCED_OR_DIVERGED`，绝不覆盖。

  在 `candidate_index_ready`、`ref_update_intent` 与 `ref_updated` 阶段，已归属 lock 必须仍为记录的完整 marker；在 `index_publish_intent` 阶段，同一 lock 的内容只能是完整 marker、完整 candidate 或在已打开同一 handle 上可证明的中断 materialization：前两者可按记录候选覆写/补记 `index_publish_ready`，第三种只可先以候选恢复副本重建同一 lock 后再记录 ready。`index_publish_ready` 阶段，lock 必须是记录的完整 candidate，**不得再要求 marker 摘要匹配**；随后才可 rename 为真实 index。任何第三种 lock 内容、锁物理身份变化、候选不完整或未知 materialization 均保留现场并返回 `GIT_INDEX_LOCKED` 或 `RECOVERY_REQUIRED`。崩溃在 CREATE_NEW、完整 marker 与 `index_lock_acquired` 之间的 lock 永远保留并返回 `GIT_INDEX_LOCKED`；trailer 只用于显示，不能用于判断恢复成功。
- Creation / migration / archive / restore journal：只在第 6 节要求的 registry reservation、数据库、storage key/legacy asset locator 路径、tree、OID、index 与源快照证据匹配时前滚；迁移还必须校验 registry rebind、legacy lease retirement 与 LegacyControlStore sealing 的精确阶段谓词。`creation_failed`/`migration_failed` 只接受已经记录的 `safe_abort_intent → safe_abort_completed` 与精确未发布谓词；一旦已发生数据库发布、ref、binding、registry route/rebind 或 activation，只能前滚或 `RECOVERY_REQUIRED`。归档/恢复还必须校验 source/target identity、生命周期 route、活动注册、binding rebind 和 `LifecycleGitFence` 的当前阶段；Git 仓库 artifact 只接受 journal 记录的同文件系统 source/target 两个身份和完整目录 rename after 谓词，跨文件系统、递归复制痕迹或第三个仓库身份一律 `RECOVERY_REQUIRED`，不得自动复制、删除或重新初始化仓库。其他无法证明的情况保持未完成并进入 `RECOVERY_REQUIRED`，不覆盖用户目录、不递归删除现场。

外部编辑在哈希检查时发现。没有未落盘本地草稿时，完整有效的文件集必须刷新投影：外部正文变化/删除同时把受影响 `pending` 提案标为 `stale`，仅结构移动/重排且正文不变时保留提案；外部删除按 tombstone 规则保留本机关系。存在本地草稿时，DraftCoordinator 必须先冻结相应资源并将全局 dirty-resource registry 中的当前草稿持久化为不可变备份，再记录基准/外部哈希、标记 `EXTERNAL_DRAFT_CONFLICT` 并锁定普通正文写入。第一版只有 `accept_worktree` 和 `apply_saved_draft` 两种内容冲突策略；结构移动/删除与本地草稿冲突时，用户必须先在工作区手工整理成有效结构后再重新同步，应用不做自动 AI 合并。

## 10. 非目标

- 远端 `fetch`/`push`、分支协作、Pull Request、GitHub/GitLab 登录和凭证管理。
- 同章节实时协作、CRDT、内置三方合并器和强制远端锁。
- Git 化角色、世界观、时间线、AI 会话和其他非章节创作数据。
- 自动 commit、任意 shell/Git 命令、对不可信仓库运行 hook 或接管任意已有 Git 仓库。
- 任意第三方 Markdown 的可视化编辑或字节级往返保证。
- 通过“恢复章节版本”回滚全书结构、卷顺序或已删除章节。
- 使用 SQLite 二进制文件或 Git 二进制数据库文件作为正文版本载体。
- 从项目归档中永久清除 Git 历史、正文或本机关联数据。

## 11. 验收与测试边界

- 清单、卷/未分卷索引、章节 sidecar 和 Markdown 的稳定解析/序列化、UTF-8/LF、UUID/路径交叉校验、原始字节哈希、字段枚举和值域、受控文件/历史对象限额都有测试；外部只修改 `.md` 而不修改 sidecar 必须能同步投影。
- 只读透传 Markdown 能被查询、diff、外部提交和 checkpoint 保留；可视编辑器、AI 续写和提案应用不能重写它，元数据写入也不能碰正文；正文原始字节 restore 能恢复它且不会改变 sidecar/结构，并保持正文写入锁定。
- 卷内和未分卷集合覆盖重复编号、`0`/负数/超安全整数、非连续编号、重排不改编号以及 `chapter_position` 连续性；多卷重复/非连续编号、未分卷章节、卷移动和重排下 `manuscript_position` 必须始终连续，伏笔 overdue 只依赖它，`MAX(num)`、裸章节编号和容器内 position 均不得进入该计算。遗留伏笔预期仅在旧全书编号可证明等于线性位置时自动迁移；卷内重复或语义不明的旧编号必须以 `LEGACY_FORESHADOW_EXPECTED_POSITION_AMBIGUOUS` 拒绝迁移并保留源库。所有新 CRUD 以 `chapter_id`/`chapter_uid` 正确访问未分卷章节。
- UID 迁移、投影重建、章节/卷 tombstone、外部结构删除和相同 UID 重现不得改变既有整数 ID 或断开外键；`active_*` 边界必须覆盖侧栏、REST、导出、统计、角色关联、AI 上下文和默认直接 ID 读取，tombstone 卷下章节不得泄漏为活跃数据。
- 外部修改 `.md`、sidecar 或结构清单恰好发生在 REST 读取、导出、统计、角色关联、AI 上下文或只读工具读取之前/期间时，结果要么来自同一最新 projection generation，要么返回定义的冲突/变化错误；不得成功返回旧投影。`DB_CONNECTION_STALE`、持续工作区变化、无效文件集和 `EXTERNAL_DRAFT_CONFLICT` 也必须走对应 gate 分支。
- 显示名、REST 名称、`target_name` 和导出标题包含路径分隔符、保留名、大小写碰撞、Unicode 同形或 glob 时，Git 项目的数据库、封面、ControlStore、暂存/恢复副本和导出实际路径仍只由 UID/storage key/opaque ID 推导；遗留项目的归档/恢复只能使用 registry 固定的 legacy asset manifest/locator 与 opaque archive ID。遗留名称式路径的 reparse point、junction、硬链接绕出、重复归属和不安全迁移均返回 `LEGACY_PROJECT_PATH_UNSAFE` 且零移动。
- REST、AI 领域 CRUD、续写、提案创建/拒绝/接受、删除、移动和导出等所有文章读写路径均经过 ManuscriptService/写入协调器，不再直写 `chapters.content`；普通 AI 创建/更新与 `prepare_*` 版本操作的边界有回归测试。
- 多窗口/多编辑器和已经卸载的全局保存队列同时写入、writer lease 竞争/丢失、外部文件在最终发布前变化、旧 epoch 自动保存、`accept_worktree`、`apply_saved_draft`、草稿同步失败/过期/范围扩大均安全失败或按策略保留草稿；`waiting_draft_sync` 的取消、过期、陈旧和失败都必须进入定义的终态。两个 operation 的 target set 部分重叠、同一 owner 幂等重试、目标集合扩大、旧 operation 迟到终态、错误 owner/token 释放及崩溃恢复都覆盖；断言不会出现部分冻结、旧操作解冻新操作或重复推进 epoch。
- 两个独立进程竞争 registry lease、同名创建/恢复、创建 reservation 后崩溃、registry 激活前打开项目、归档/恢复与创建交叉、legacy 项目打开/写入与 CLI manuscript migration 竞争、以及 `data-dir set <path> --migrate` 遇到 `git_ready` 项目、Git 归档或非终态 lifecycle journal 都有故障注入；纯 legacy 数据根迁移还覆盖共享/独占 `data_root_maintenance_fence`、registry lease 从全量检查到最终 config/registry CAS 的持续持有、每个 legacy lease 排空、迁移期间新建/归档/恢复无法插入、迁移目标根的既有/缺席 reservation、父目录身份或 reparse 变化、CREATE_NEW 后崩溃与两态恢复、`legacy_quiesced_snapshot → retiring + legacy_sealing_lease → legacy_control_sealed + final retirement` 的逐点崩溃恢复、`DataRootMigrationJournal` 断点和 source physical identity/lease key 重绑。不同物理根的未带 `--migrate` `data-dir set` 必须在 `mkdir`、复制和配置写入前返回 `DATA_DIR_SWITCH_REQUIRES_EMPTY_REGISTRY`；已设置 `MYTHPEN_DATA_DIR` 时不同根的 set/migrate，及任一应用宿主/CLI 的普通启动、项目列表或打开项目路径，都必须在 override 根目录 `mkdir`、列表读取、数据库/ControlStore 打开前返回 `DATA_DIR_ENV_OVERRIDE_ACTIVE` 且零复制/配置变更。空 registry 的既有/缺席数据根、父目录身份或 reparse 变化、CREATE_NEW 后崩溃与 `data_root_binding_reservation` 恢复必须只接受记录的两种物理身份状态。测试断言 identity reservation 不泄漏/复用，Git 相关路径一律在复制前返回 `DATA_DIR_GIT_RELOCATION_UNSUPPORTED`。
- lifecycle route 覆盖 `active → archiving/restoring → retired/active` 的 CAS、路由与恢复竞态：registry 标记前不得移动 artifact；标记后普通打开、读取、导出、AI 上下文、自动保存和普通 lease 均返回 `PROJECT_LIFECYCLE_BUSY`，只允许对应 journal 使用已记录的 source/target identity；legacy 普通路径的 `共享 fence → legacy lease → FIFO`、legacy 生命周期的 `registry → 共享 fence → lease → FIFO` 与数据根迁移的 `registry → 独占 fence → all leases → FIFO` 不得形成死锁或插队。
- 创建/迁移在每个阶段注入崩溃：只有可证明尚未越过安全中止点的记录能走 `safe_abort_intent → safe_abort_completed → *_failed`；ref、binding、registry rebind/route 或 activation 之后的故障必须前滚或 `RECOVERY_REQUIRED`，不得报告 `creation_failed`/`migration_failed` 后重新开始第二份副作用。
- AI 无法伪造草稿收据、用户确认、operation ID、跨会话/跨项目操作或最终执行；确认与领取同一 CAS，未写 intent 的 executing 重启后转为终态 `needs_reapproval`，重新同步/预览会创建而非复用一个 operation；`prepare_*` 在相同 `{project_instance_id, interaction_id, tool_call_id}` 下只产生一个 operation、不同摘要返回 `TOOL_CALL_ID_REUSE` 且绝不双建 invocation；包含多个/混合 `prepare_*` 的批次为每个 tool-call ID 返回零副作用 barrier result；断线、会话切换和待操作会话删除均可恢复或安全拒绝。
- 普通聊天覆盖 `ClientAIActionStore` 的 `prepared`/`dispatched`/`server_bound` 任一点崩溃、启动凭据轮换而 stable caller 不变、同 key 重投、首个 SSE 前断线、provider response 已持久化但 tool result 未发出、合法 `prepare_*` 创建 operation 后断线、批次中途断线、tool result 完成与 successor prepared 之间的崩溃、successor dispatch intent 后崩溃和恢复后再次发起聊天：相同 context/digest 不得产生第二个 interaction、profile、operation 或未计划 provider turn，不同 digest 返回 `INTERACTION_KEY_REUSE`，跨 context 复用返回 `INTERACTION_CONTEXT_MISMATCH`；`UNIQUE(interaction_id, turn_sequence)`、parent turn、canonical transcript digest、policy/rendered-prompt digest 和 8-turn 上限均可恢复验证。chat/page_task/editor origin 的 nullable-session 正反例、同 key 不得二次派发也必须覆盖。OpenAI-compatible 与 Claude 的正常、length/截断、拒绝、过滤、取消和未知 finish/stop reason 映射均覆盖；合法 JSON 的截断或 reason/shape 不匹配也必须在 `response_persisted` 前以 `PROVIDER_COMPLETION_INVALID` 零副作用失败。每个已持久化 assistant tool call（包含合法 prepare）都恰有一个可恢复的 provider/tool-call 配对结果，尚未执行的批次成员为 `CLIENT_DISCONNECTED_BEFORE_EXECUTION`；缺失、空白、超限、同 response 重复或跨 turn 重复的 tool-call ID 必须在 `response_persisted` 前以 `PROVIDER_TOOL_CALL_ID_INVALID` 拒绝且零工具副作用。每 turn/interaction 的 calls、参数、结果、transcript 和 mutation 预算边界、批次预检零执行、恢复后计数不重置与 `INTERACTION_BUDGET_EXHAUSTED` 均须覆盖。
- 遗留 `POST /api/ai/chat` 的任何调用都不得到达 adapter；SettingsDrawer 的 provider 探测覆盖相同 `client_probe_key` 重投、dispatch intent 后断线、完整 response、provider 失败和无 response 崩溃恢复，断言每一次实际 probe 都有 `turn_kind = provider_probe`、无项目 `project_data`/工具/`AIInteractionRecord`/operation，且不会二次派发 provider。`/api/ai/task` 必须按迁移表覆盖同 key 重投、dispatch 后断线、typed-output 无工具、越权 task_kind/输入/工具、renderer 伪造 JSON→REST、每个 mutating task 的 invocation/handle/预算；仓库中不得存在实际业务 `aiApi.chat` 调用，旧 `/api/ai/chat` 永不触达 adapter。
- 删除聊天会话分别遇到 pending interaction/turn/invocation/continuation/polish/task/action 或 operation 时，均返回 `SESSION_HAS_PENDING_AI_WORK` 且零消息/session 删除；ChatSessionService 的“阻断新 action + 检查 + 删除”必须在同一协调边界，无竞态空档。所有关联工作终态化且审计记录仍保留后才允许删除；editor origin 和 provider probe 不得错误阻断无关 session。
- AI 提案生成期正文改变、并发迟到结果、revision decisions 改变和确认卡生成后的提案变化均正确触发 CAS/stale；AI 提案创建不改变版本化章节状态，任何路径均不得自动 rebase 或接受。`/api/ai/polish` 另覆盖 chat/editor origin、editor 不提供 `chat_session_id` 仍可恢复、chat origin 提供错误/已删除会话失败、同 key 重取优先于 preflight、不同 key 同章 nonterminal `POLISH_IN_PROGRESS`、dirty/pending preflight、turn dispatch 后断线、空/截断/未完成输出、完整 response 已落盘但 proposal journal/SQLite 发布前崩溃、base/projection/pending/policy/rendered-prompt digest 失配、迟到回调和重启恢复；断言 `polish_request` 与 `turn_kind = polish`/provider request ID 一对一、同一 canonical 输出只产生一个 pending proposal、任何恢复均不重派 provider。
- `prepare_apply_revision` 覆盖正文 dirty、sidecar dirty、已卸载正文队列、确认前 revision 变化、确认后执行前 revision/body CAS 变化和已有 intent 后崩溃：dirty 时必须返回 `LOCAL_DRAFT_CONFLICT` 且零 operation/文件/提案副作用；执行前失配必须走 `executing → stale`，已有 intent 后只能由 journal 收敛，接受提案后绝不自动回写旧草稿。
- 普通文章/卷与本机实体 write handle 覆盖正常签发、伪造、跨项目/实例/会话/interaction 复用、过期、并发原子领取、同 invocation 重投、其他 invocation 复用、领取与 `received → executing` 同 CAS、领取后 intent 前崩溃、写后失效、签发后资源/结构 generation、raw hash 或 row version 改变、字段/target 越权和未知字段；错误优先级及 invalid/stale/used 完整 result 的重复投递均确定，且任一失败零文件/数据库副作用。截断或只读透传章节不得授予正文写权限；正文/标题/本机表单队列已卸载但仍 dirty 时，普通 AI update、entity update/delete 和目标容器结构写入必须返回 `LOCAL_DRAFT_CONFLICT`。
- 章节、卷和每类本机实体创建分别覆盖：无 post-create grant 时只返回新资源身份；有预声明 `derived_resource_grant` 时只能在同一 interaction、同一 creator invocation lineage 内使用衰减后的新资源 handle；伪造新 UID、扩大字段、用 child grant 再创建资源、跨 interaction/session 重放或 parent stale 后使用均返回 `DERIVED_CAPABILITY_NOT_GRANTED` 或 `WRITE_HANDLE_INVALID`，且不产生第二个副作用。
- pending proposal 分别覆盖普通 REST 自动保存、AI `update_chapter(content)`、AI 续写和元数据-only 更新：正文成功时原 base/proposed 内容保持不变、proposal 在候选投影中原子转 `stale` 且 `revision_version` 递增；元数据-only 不改变 proposal；revision CAS 变化时正文不发布；任何路径都不得调用或模拟旧 `rebasePendingRevision`。
- `ai_tool_invocation` 对章节创建、卷创建、章节更新、非文章 update/delete 和至少一个非文章创建工具注入 `received` 后、原子 claim/`executing` CAS 后但 mutation intent 前、文件/数据库发布后但 tool result 前、SSE 断线和进程重启断点；相同唯一键与摘要只能得到一个副作用和逐字节一致的完整 result payload，不同摘要返回 `TOOL_CALL_ID_REUSE`，执行中的重复投递只能等待/恢复，invalid/stale/used 与中断结果不得悬挂，恢复后的聊天能按 provider/tool-call 配对重建 tool result。
- AI 续写覆盖 chat/editor origin、editor 不提供 `chat_session_id` 仍可恢复、request 创建前崩溃、request 已创建但 freeze 前崩溃、freeze 后草稿捕获前崩溃、捕获完成但 `generating` 前崩溃、`AiModelTurn(turn_kind = continuation)` 创建/dispatch intent 后崩溃、多窗口草稿捕获失败、只读透传 Markdown、pending proposal（含起始 `none`）、生成中普通写入、外部 `.md` 修改、不同 key 竞争同一章节、错误 owner 释放、用户取消后 provider 迟到回调、输出截断、首个 SSE 事件前断线、输出已落盘但 applying/intent 前崩溃、intent 后崩溃、文件发布崩溃和 ACK 丢失；测试必须证明 `UNIQUE(continuation_request_id)`/`UNIQUE(provider_request_id)`、request 固定 turn ID、turn kind/request ID/dispatch state/response-empty 条件、固定 policy digest 与在 base/`project_data` 固化后产生的 rendered-prompt digest、以及 request/turn 同 canonical 输出哈希都在同一完成 CAS 中验证，模型生成期间不持有 OS writer lease、不会出现无 owner 的冻结、竞争请求返回 `CONTINUATION_IN_PROGRESS`、迟到回调不能复活 request 或写入输出/文件、失配候选不会追加到最新正文，成功 after bytes 只由固定 base 和保存输出构造，同一 `client_continuation_key` 不会二次追加或重新调用 provider。
- 工具注册表做枚举和 profile 真值表快照测试：`server/tools.js` 中每个现有工具名必须恰好属于一个能力类别；query/writing/collab/version 各 profile 的 provider schema、PromptAssembler 工具说明和执行 allowlist 完全一致；资源/字段越权、receipt 跨 interaction、过期、重放或超额均零副作用；`delete_chapter`/`delete_volume` 和移动/重排工具不出现在模型 schema；未经结构确认不得出现 `create_volume`/`update_volume`。OpenAI-compatible 与 Claude 两种适配器都覆盖越权 tool result 配对，renderer mode/i18n 不得影响 PromptAssembler 的策略选择，提示词中不得包含旧 create/update 参数、模型可执行的文章删除工具或“正文写入 SQLite”表述。
- 对正文、标题、大纲、卷名、项目元数据、角色/世界观等每类项目可编辑文本注入“忽略此前指令”、伪造 tool schema、伪造确认或切换 mode 的内容，验证它们始终只出现在 `project_data` envelope；不得改变 prompt family、provider schema、allowlist、capability profile 或执行路径。固定 policy digest 与实际 canonical `project_data`/transcript/base bytes 生成的 rendered-prompt digest 必须分别可复算，且后者只能在输入冻结后写入 turn。缺少或篡改 data-only envelope 必须返回 `PROMPT_CONTEXT_POLICY_VIOLATION` 且零 provider 调用。
- 注入 sql.js `export`、候选校验、原子替换、正式数据库重开与 ControlStore 阶段落盘失败，覆盖文章与角色/世界观/聊天等全部项目表写入；验证正式数据库始终是完整 before/after 之一，旧 `connection_epoch` 的 handle/timer 不能回写，连接会 fenced 且可 journal 恢复；不得损失非文章业务数据。
- 真实临时 Git 仓库中验证：两个进程竞争 writer lease、结构性多文件发布持有 marker-only snapshot fence、unknown `.git/index.lock` 不被删除、私有 index 不夹带未选择改动、固定 commit recipe 重试不生成第二个 commit、CREATE_NEW/marker/acquired/candidate/CAS/index publish intent/candidate 覆写/ready 每个断点都可恢复；`USER_INDEX_DIRTY`、具有固定失败语义的私有 index/tree、`commit-tree`、candidate 构造或最终 pre-ref 校验失败，以及已确认 CAS old-value mismatch 分别覆盖各自合法来源的 `abort_intent`、`pre_ref_command_failed`、`lock_release_intent`、unlink 前后崩溃，断言仅已归属 marker 被删除、operation 只在 `aborted` 后失败、候选对象不生成第二个 commit；dirty abort 的 lock 已消失恢复不引用不存在的 `new_commit_oid`，而 pre-ref/CAS abort 分别核验其记录的 ref/index/candidate 谓词；超时、未知退出或反证不完整时必须保留现场。CAS 后 before/candidate/同语义 stat-cache/受验证外部后继/第三种真实 index 状态分别按规定恢复或阻断。
- Git 环境白名单、命令 profile、hooks/filter/fsmonitor/split-index、reparse point、子模块、nested repo、linked worktree、alternates、replace refs、grafts、shallow repo、其他分支、非受控 tracked 文件、历史 symlink/gitlink/异常 mode 和历史对象超限均被拒绝或进入安全恢复。
- `RepositoryIdentityGuard` 覆盖 `HEAD`、`packed-refs`、loose `refs/heads/main`、`logs/HEAD`、`logs/refs/heads/main` 和相关 lock 的缺席/替换/内容变化；只读 profile 前后任一变化均丢弃输出并返回 `REPOSITORY_IDENTITY_CHANGED`。另覆盖 main 初始仅在 packed-refs、CAS 生成 loose main、精确 main reflog 追加，以及额外 ref/reflog 变化被 fenced。
- 新建基线及旧项目迁移覆盖 schema candidate、repo staging、baseline lock intent/marker/acquired/commit/ref/index publish intent/candidate 覆写/ready/index 每个阶段崩溃、目标不匹配拒绝、源 SQLite 保留、未知依赖对象拒绝、schema-swap 后整数 ID/序列/外键/触发器/视图保持、稳定 UID/编号/容器和全书 position 映射，以及 `volume_id IS NULL` 的无损映射与遗留伏笔 expected-position 歧义拒绝。SQLite→Git 迁移还在 `binding_committed`、`registry_rebind_intent`、registry CAS、`registry_rebound`、`legacy_control_retired` 和 `git_ready` 之间逐点故障注入：rebind 后旧 record 只能是拒绝普通路由的 `retiring`，仅 journal-bound sealing lease 可恢复封存；`legacy_control_retired` 后旧 key/sealing lease 才同时 retired 且新 ControlStore 唯一活动。任一时刻要么 legacy 可按其当前阶段恢复且 target 未激活，要么只有一个 `migrating`/`git_ready` target；绝不出现双普通路由、sealing lease 外泄或退役 key 复活。
- 项目归档/恢复覆盖每个 journal 阶段崩溃、移动失败、Lifecycle/ArchiveControlStore 与项目 ControlStore 分离、同名重建、目标名称/路径冲突拒绝、显式恢复、binding rebind、新 storage key、导出文件不受影响和旧 `project_instance_id` 请求失效；归档/恢复必须在首个 fence/artifact 变更前已完成 `registry_archiving`/`registry_restoring` CAS，并在该状态下拒绝所有普通路由。只有完整归档后才从权威 registry 退役活动实例并更新活动项目投影。`sqlite_legacy` 归档/恢复另覆盖 manifest/locator 校验、新 legacy instance/lease、旧 instance 陈旧和不分配 Git UID/storage key；`git_ready` 归档/恢复覆盖同文件系统完整目录 rename、fence acquire/release、rename 前后崩溃和第三个仓库身份，并断言跨文件系统返回 `GIT_ARCHIVE_CROSS_FILESYSTEM_UNSUPPORTED` 且零 artifact/registry 副作用，绝不递归复制 `.git`。

## 12. 实施前置条件

用户复审并确认本修订版后，先编写分阶段实施计划，再开始任何代码、数据库迁移或 API 改动。实施计划必须建立“现有入口 → capability 类别 → 新服务方法 → precondition/dirty 策略 → invocation/journal → 回归测试”的逐项迁移矩阵，并至少覆盖：`server/tools.js`、`server/index.js`、`server/routes/api.js`、`server/db.js`、`server/prompts/writing.js`、`server/prompts/collab.js`、`server/prompts/context.js`、`server/ai-continue-save.js`、`server/chapter-revisions.js`，以及前端 `AIPanel`、`EditorToolbar`、`EditorContent`、`Outline`、`Foreshadows`、`Memory`、`Consistency`、`Relations`、`SettingsDrawer`、正文/标题/本机表单保存队列、`api.ts`、revision store、`toolEntityMap.ts` 和中英文 i18n。矩阵还必须建立并覆盖 `CapabilityRegistry`、`ProfileStore`、`WriteHandleStore`、`DerivedCapabilityGrantStore`、`AiToolInvocationStore`、`AIInteractionStore`、`AiModelTurnStore`、`ClientAIActionStore`、`ContinuationRequestStore`、`PolishRequestStore`、`AiTaskRegistry`/`AiTaskRequestStore`、`ProviderCompletionPolicy`、`ToolExecutionBudget`、`PromptAssembler`、provider adapters 与 SSE/message recovery，及现有 REST（含未分卷/稳定 ID 路由）、完整 AI 提案生命周期、编辑器自动保存与全局草稿队列、legacy instance/lease/LegacyControlStore 与 legacy archive/restore 过渡、项目创建/迁移/归档/显式恢复、受限的 `data-dir set <path> [--migrate]`、导出、`ensureReadableProjection()`/`ActiveManuscriptProjection`、`SQLiteProjectionStore`、`manuscript_position` 与伏笔 expected-position DDL、ControlStore/LegacyControlStore/LifecycleControlStore/ArchiveControlStore、应用 registry lease、lifecycle routing state、data-root maintenance fence 与跨进程 writer lease、DraftCoordinator、ChatSessionService 删除 gate、内联确认宿主、`RepositoryIdentityGuard`/`RefStorageSnapshot`/`LifecycleGitFence`，以及文件/Git/创建/迁移/归档/恢复 journal；任何旧工具名、旧提示词、旧直写 SQL、未经注册的 provider schema 或未归类入口都视为迁移未完成，避免形成 SQLite 与 Markdown 双主。

实施矩阵还必须显式列出并验证：普通 interaction 的 successor-turn planner/turn-sequence 唯一约束与 tool-call ID 正规化器，`PolishRequestStore`/`PolishProposalJournal`，`ProviderProbeRequestStore`、`AiTaskRequestStore` 及遗留 `/api/ai/chat` 删除/封禁，所有既有非聊天入口到 `/api/ai/task`/probe 的映射与 renderer JSON→REST 链路删除，continuation/polish/task/probe 的 provider-request 唯一约束、origin/可选会话绑定、policy/rendered-prompt digest、completion/budget 计数与迟到回调诊断，`legacy_sealing_lease` 与 retiring→final-retirement 恢复，`safe_abort_*`、`registry_archiving`/`registry_restoring` 路由恢复，`data_root_binding_reservation`、根目录 bootstrap identity 与持续 registry lease 的数据根迁移协议；这些项目不能被归入“现有 AI/CLI 流程”而遗漏。
