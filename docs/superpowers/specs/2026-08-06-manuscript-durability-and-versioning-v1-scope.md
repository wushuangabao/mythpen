# 文章耐久性与 Git 版本管理：分层交付范围（V1 收敛版）

日期：2026-08-06
状态：待用户确认；确认后按 L1 先写实施计划
上游文档：`2026-08-05-git-manuscript-versioning-design.md`（下称「原设计」）

## 1. 本文定位

原设计在安全模型与崩溃一致性上的结论基本成立，本文不推翻它，而是解决它的交付形态问题：原设计把「最终应该做到的严谨」全部压进了第一版，规模超过现有整个代码库（`src/` + `server/` 约 28,500 行），且存在三个会导致无法交付的前置缺口。

本文把原设计切成四层可独立交付、每层自身可用的纵切，并固定四条前提决策。原设计降级为**长期目标文档**：它的不变量、状态机和威胁模型在各层实施时逐条引用，但它不再是 V1 的范围定义。

各层之间的关系是严格递进的：L1 不需要文件格式，L2 不需要 Git，L3 不需要 AI 侧的耐久化。任何一层单独上线都能给用户带来可见收益，也都能单独回滚。

## 2. 已确认的前提决策

**D1｜Git 由用户自行安装。** 要求 Git ≥ 2.36（`core.fsync` / `core.fsyncMethod` 的最低版本）。检测不到或版本不足时，版本管理功能整体不可用，但应用其余部分必须完全正常。

推论（重要）：**新建项目不得依赖 Git**。原设计 §6 中「项目创建流程包含 baseline commit、`git_ready` 项目不存在 unborn HEAD」的模型作废。Git 版本管理改为项目级的显式开关，创建项目与启用版本管理是两个独立的可恢复操作。这同时消掉了原设计里 `ProjectCreationJournal` 的 baseline 分支和 `creating`/`creation_failed` 状态。

**D2｜允许新增 UI。** 原设计 §1 的「不新增页面、侧栏入口或状态栏」约束解除。存档、查看历史、恢复、冲突处理、诊断与修复都必须有确定性的宿主入口，不得以 AI 工具调用作为唯一路径。AI 工具是这些能力的补充，不是它们的载体。

**D3｜取消 legacy 双轨。** 不为旧项目实现第二套 `LegacyControlStore` / `legacy_project_lease_key` / legacy 归档恢复 journal。改为应用内引导迁移：打开旧项目时提示并执行升级，迁移本身是可恢复的，但迁移完成后只存在一种存储形态。CLI 仍可触发迁移，但不再是唯一入口。

推论：原设计中 `sqlite_legacy`、`legacy_quiesced_snapshot`、`legacy_sealing_lease`、`retiring → legacy_control_retired` 的全部状态与恢复规则删除，`registry_rebind` 简化为单次 CAS。

**D4｜交付顺序按本文四层执行。** 每层完成并稳定后才启动下一层。

## 3. 分层总览

| 层 | 交付内容 | 解决的真实问题 | 依赖 Git | 用户可见变化 |
|---|---|---|---|---|
| L1 | 耐久性地基 | 掉电/崩溃丢数据；多入口直写正文 | 否 | 保存更可靠；新增诊断与修复入口 |
| L2 | 文件权威层 | 正文锁死在二进制 DB 里；无法外部编辑 | 否 | 稿件成为磁盘上的 Markdown；可用外部编辑器 |
| L3 | Git 版本管理 | 无版本、无历史、无法回退 | 是 | 存档点、章节历史、恢复 |
| L4 | AI 耐久化与能力模型 | AI 可越权、重复副作用、断线丢状态 | 否 | AI 行为可审计、断线可恢复 |

优先级理由：L1 修的是**今天就在发生的数据风险**——当前 sql.js 的持久化是「250ms 防抖 + 全量 `writeFileSync`」，无 fsync、无原子替换、无恢复日志，写入过程中断电即损坏整个项目库。这比「没有版本管理」严重得多，也不需要任何新格式或新依赖就能修。

---

## 4. L1：耐久性地基

### 范围内

- **`SqlJsAtomicStore`**：取代现有 `server/db.js` 的直接覆写。候选字节写同目录临时文件 → 持久化 flush → 重开执行 `integrity_check` + `foreign_key_check` → 原子替换 → 重开验证。它是整个项目数据库的唯一连接所有者，维护单调 `connection_epoch`，旧 epoch 的句柄与延迟 flush 永久返回 `DB_CONNECTION_STALE`。
- **`ControlStore`**：项目数据库与工作树之外的只追加事件日志，含前序状态摘要、事件序号和 after 谓词。它是所有 journal 的唯一耐久控制面。
- **跨进程 writer lease**：位于稳定应用锁根，按项目实例绑定，基于持续持有的 OS 独占句柄，不使用 PID、时间戳或锁文件存在性。获取失败返回 `PROJECT_WRITE_BUSY`，句柄失效返回 `WRITER_LEASE_LOST`。进程内配 FIFO 队列。
- **`ManuscriptService` 收口**：当前 `chapters.content` 有 5 条直写路径（`routes/api.js` 的章节 PUT、`tools.js` 的 create/update、`ai-continue-save.js`、`chapter-revisions.js` 的接受提案）。全部改走单一服务方法，不再有例外的直写 SQL。
- **诊断与修复入口**（对应原设计缺失的「出口」）：`RECOVERY_REQUIRED` 必须有对应的用户可见状态、诊断包导出，以及在能证明安全时的一键前滚/回滚。不允许存在只返回错误码、用户无法自救的终态。
- **故障注入测试框架**：可控的进程终止点、可拦截的文件系统、可编排的多进程竞争。这是 L1 的交付物，不是测试的副产品——后续三层的验收全部依赖它。

### 明确不做

文件格式、Git、AI 侧的 interaction/turn/invocation 耐久化、归档与恢复、数据根迁移改造。L1 不改变任何数据模型，只改变「数据怎么落盘」。

### Windows 原语：已验证的实现路径

生产环境的 `mythpen-server` 与 `mythpen-cli` 由 `bun build --compile` 编译，运行时是 **Bun 1.3.14**（`scripts/build-sidecars.mjs`），开发与测试则跑在 Node 24。以下结论来自在本机 Windows 10 上对两个运行时的实测。

**通过 `fs` API 都不可用。** Node 与 Bun 表现完全一致：`fs.constants.O_EXLOCK` 在 Windows 上未定义，同一文件可被重复打开而无任何互斥；`fs.fsyncSync` 作用于目录句柄返回 `EPERM`。也就是说 lease 与目录持久化都无法用标准 `fs` 实现。

**通过 `bun:ffi` 直调 kernel32 都可用，且无需原生插件。**

- *writer lease*：`CreateFileW(path, GENERIC_READ|GENERIC_WRITE, share=0, OPEN_ALWAYS, ...)`。首个句柄成功，竞争者得到 `ERROR_SHARING_VIOLATION (32)`，句柄关闭后立即可再获取。这是 OS 强制的互斥，进程崩溃时由内核释放，完全满足原设计「不得用 PID、时间戳或锁文件存在性判断」的要求。
- *目录持久化*：`CreateFileW(dir, GENERIC_WRITE, share, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS)` 后调用 `FlushFileBuffers`，在 NTFS 上返回成功。注意必须请求 `GENERIC_WRITE`——用 `GENERIC_READ` 或不请求访问权限都会得到 `ERROR_ACCESS_DENIED (5)`。
- *编译后仍然可用*：把 FFI 脚本用 `bun build --compile` 打成单文件 exe 后运行，独占打开与 flush 均正常。因为这里是运行时 `LoadLibrary` 系统 DLL，不是嵌入 `.node` 文件，避开了原生插件与单文件打包的兼容问题。

**因此 L1 采用 `bun:ffi` 方案，不引入 N-API 原生插件。** 平台原语收敛到一个 `platform/durability` 模块，暴露 `acquireExclusiveLease()`、`fsyncFile()`、`fsyncDirectory()`、`atomicReplace()` 四个能力，Windows 走 kernel32，POSIX 走 `flock` + 目录 fd fsync。

### 由此带来的两个连带决定

**测试运行时必须与生产一致。** Node 没有 FFI，若继续用 `node --test`，耐久层的测试跑的就不是即将发布的实现。实测 `bun test` 能直接运行现有的 `node:test` 文件（单文件运行全绿），但整套 37 个文件并行跑时有 20 个失败——原因是 `bun test` 默认在同一进程内并行执行所有文件，而 `node --test` 是每文件独立进程，现有测试依赖 `DB_DIR` 环境变量和 `db.js` 的模块级单例，存在共享状态冲突。所以 L1 需要包含一项测试隔离改造：让测试不依赖进程级全局状态，然后把 server 侧测试切到 `bun test`。这项改造本身也是故障注入框架的前提。

**`atomicReplace` 存在一个必须设计进协议的失败模式。** 实测发现：`rename` 覆盖一个**正被其他句柄打开**的目标文件，在 Node 和 Bun 下都返回 `EPERM`。原因是两个运行时打开文件时都没有设置 `FILE_SHARE_DELETE`。这意味着杀毒软件、Windows 搜索索引器、备份工具或用户自己的数据库查看器只要打开了正式 `.db`，候选发布就会失败。

约束：`SqlJsAtomicStore` 必须保证自己不长期持有正式数据库的文件句柄（sql.js 是整文件读入内存后关闭，天然满足，但要有测试守住这一点），并且必须对第三方句柄实现有上限的重试与退避，把最终失败表述为可恢复状态而不是数据损坏。原设计完全没有覆盖这个场景。

### 对原设计的一处修订

原设计 §5.2 要求「无法验证替换/目录持久化能力时不得静默报告成功」。按上述实测，这一条在 Windows 上可以成立——但前提是走 FFI 路径。若将来某个平台或运行时拿不到这些原语，正确做法是在启动时就明确降级并告知用户，而不是让每次写入各自失败。

### 验收要点

- 在 `export()`、候选校验、原子替换、正式库重开、ControlStore 阶段落盘每一处注入失败：正式数据库始终是完整的 before 或 after 之一，绝不出现第三种字节状态。
- 覆盖全部项目表（角色、世界观、聊天、统计），不只是章节表；不得丢失非文章业务数据。
- 两个进程竞争 writer lease、lease 中途失效、崩溃后由下一进程恢复 journal。
- 现有 281 个测试全绿，且 5 条正文直写路径的回归测试证明它们已收口。

---

## 5. L2：文件权威层

### 范围内

- **权威文件格式**：沿用原设计 §4.1 的目录布局与文件契约（`manuscript.json`、卷 `index.json`、`ch_<uid>.md` / `.json`），UTF-8 无 BOM、LF、稳定键顺序、路径只由校验通过的 UUID 推导。
- **两处简化**（原设计的重复不变量，见第 9 节）：删除 `manuscript.json.unassigned_chapter_uids`，未分卷顺序只由 `unassigned/index.json` 承载；`chapter_number` 不进入权威文件，只保留在本机投影中。
- **文件发布 journal 与投影同步**：`FilePublicationJournal`、`ensureProjectionCurrent()`、`ensureReadableProjection()`、`ActiveManuscriptProjection`。
- **UID / tombstone / position 的 DDL 迁移**：`chapter_uid` / `volume_uid` 唯一约束、`is_present` / `deleted_at`、`chapter_position` / `manuscript_position` 及其部分唯一索引、`foreshadows.expected_resolve_manuscript_position`。逐行保留 `chapters.id` 与全部外键。
- **外部编辑检测**：外部只改 `.md` 是合法输入，重算哈希后刷新投影，不回写权威文件。与本地草稿相遇时冻结并进入 `EXTERNAL_DRAFT_CONFLICT`。
- **引导式迁移**（D3）：打开旧项目时提示升级，迁移可恢复，源库与迁移前备份保留。

### 关键设计决定

**文件落在最终位置。** L2 就把权威文件写到 `<data>/manuscripts/<project_uid>/` 下的最终路径，使 L3 的 `git init` 是原地进行，不涉及任何目录搬迁。这消掉了原设计中 repo staging → 无覆盖原子发布的一整套流程。

**新鲜度 probe 分两级**（解决原设计未回答的读路径开销问题）：

- *快速门*，用于所有正常读取：比对受控目录的 `(path, size, mtime, file_id)` 快照，命中即复用当前投影。
- *完全校验*，用于所有写入前、显式刷新和进程启动：raw SHA-256。

明确记录一条已知弱保证：外部工具若刻意保持 size 与 mtime 不变地修改文件，快速门会漏检，直到下一次写入或显式刷新才纠正。这个弱保证只作用于读新鲜度，不参与任何安全判定。原设计要求每次读取前后都做 raw hash 比对，对一部 3000 章、正文 30 MB 量级的连载不可行。

**上限重新标定。** 原设计的「受控文件总量 64 MiB、总条目 10,000」意味着章节数上限约 4,990，对中文长篇连载偏紧。L2 需要按目标用户核定后重设，并在实施计划中给出依据。

### 明确不做

Git、AI 能力模型、归档与恢复。L2 完成后项目仍然没有版本历史，但稿件已经是磁盘上可被任何编辑器打开的 Markdown。

### 验收要点

- 外部只改 `.md` 不改 sidecar 必须能同步投影；只读透传 Markdown 可查询、可 diff，但可视编辑器与语义性整篇写入被锁定。
- 卷内/未分卷的重复编号、非连续编号、重排、移动、tombstone 与同 UID 复活下，`manuscript_position` 始终连续，伏笔 overdue 只依赖它。
- DDL 迁移后整数 ID、`sqlite_sequence`、外键、触发器、视图全部保持；`foreign_key_check` 通过。注意两个原设计未提及的实现约束：表重建过程中需要临时关闭 `PRAGMA foreign_keys`（当前全局开启），以及位置重排必须两阶段进行，否则会在 `UPDATE` 执行中途撞上部分唯一索引。
- 外部修改恰好发生在读取前/读取期间时，结果要么来自同一最新 generation，要么返回定义的变化错误，绝不成功返回旧投影。

---

## 6. L3：Git 版本管理

### 范围内

- **`GitEnvironmentProbe`**：检测 Git 存在性与版本（D1）。不满足时版本管理入口整体隐藏或禁用并给出明确说明，应用其余功能不受影响。
- **项目级版本开关**：`versioning = off | enabling | on | enable_failed`。启用是显式用户动作，走可恢复的 journal，在既有权威文件目录上原地 `git init` 并创建 baseline commit。
- **`GitService` 与 `RepositoryIdentityGuard`**：沿用原设计 §5.4 的命名 command profile、环境白名单、仓库硬约束、`RefStorageSnapshot` 与只读结果的前后一致性校验。
- **checkpoint 事务**：沿用原设计 §5.4 的完整协议（lock intent → marker → 私有 index 构树 → 固定 commit recipe → ref CAS → candidate index 发布）与 `CheckpointJournal` 状态机，包括 abort 子协议。这部分原设计写得足够精确，直接引用。
- **确定性宿主入口**（D2）：存档按钮、章节历史面板、恢复与冲突处理界面。**版本的创建与查看不得依赖 LLM 可用性。**
- **仓库约束的修复路径**：用户在同一仓库执行 `git checkout -b`、提交非受控文件等操作后，必须有受控的诊断与恢复流程，而不是让项目直接变成不可读状态。这是 L3 的交付物，不是可选项。
- **外部 Git 竞争的退避策略**：外部工具（如 VS Code 的 Git 扩展周期性 `git status`）会短暂占用 `.git/index.lock`。需要定义重试与退避，而不是直接向用户抛 `GIT_INDEX_LOCKED`。

### 明确不做

远端 `fetch`/`push`、分支协作、三方合并、`prepare_*` 之外的 AI 版本工具、项目归档与恢复的 `LifecycleGitFence`。归档恢复整体推迟到 L3 之后单独评估。

### 验收要点

沿用原设计 §11 中关于真实临时 Git 仓库的那一组：两进程竞争、unknown lock 不被删除、私有 index 不夹带未选择改动、固定 commit recipe 重试不生成第二个 commit、CREATE_NEW / marker / acquired / candidate / CAS / index publish 每个断点可恢复。另加 D1 相关：Git 缺失、版本过低、执行中被卸载三种情况下应用不崩溃、不留半成品。

---

## 7. L4：AI 耐久化与能力模型

### 范围内

- `AIInteractionRecord`、`AiModelTurn`、`ai_tool_invocation`、`ClientAIActionStore`、`WriteHandleStore` 及其唯一约束与恢复规则。
- `CapabilityRegistry` 与 capability profile；`PromptAssembler` 的 data-only envelope 与 policy / rendered-prompt digest。
- `/api/ai/continue`、`/api/ai/polish` 的耐久请求化；旧 `/api/ai/chat` 直连 adapter 分支的删除；页面专用 task 与 provider probe 的迁移。
- `prepare_*` 版本操作、DraftCoordinator、确认卡与宿主确定性执行器。

### 必须先解决的设计缺口

**写权限的判定来源。** 原设计反复要求 writing / collab profile 只在「原始用户动作明确列出」时才追加 `create_chapter` / `update_chapter`，同时禁止用模型输出和 renderer 的 `mode` 决定权限——但从未定义究竟由谁、用什么机制从一句自然语言里做出这个判定。这是整个权限模型的支点，必须在 L4 实施前写死。

借助 D2 解除的 UI 约束，本文给出的方案是：**写权限只能来自宿主记录的结构化用户动作，禁止从自然语言推断。** 它有且只有两个产生方式——(a) 用户从具体 UI 上下文发起（在某章节、大纲条目或角色卡上触发「让 AI 写/改」），宿主由此得到动作类型与精确目标集合；(b) 用户在聊天发起时显式选择本轮的写入意图与目标，默认只读。这会改变现有 writing / collab 的交互形态，属于 L4 的 UX 设计任务，需要单独出稿。

**轮次上限。** 原设计固定 8 轮，当前代码是 120 轮（`AGENTS.md` 里的「8 轮上限」已过时，需一并更正）。产品定义的写作工作流是「了解 → 读大纲 → 创作 → 润色 → 审稿 → 定稿」，共创还要做设定共创 → 分卷规划 → 前三章交付，读大纲、读角色、读伏笔、写正文、更新元数据很容易超过 8 轮。上限需要重新标定为可配置值，并定义超限时用户看到什么、如何继续，否则实施后的表现就是「AI 写着写着就停了」。

**续写期间的编辑器冻结。** 原设计要求续写全程 DraftCoordinator 冻结目标章节，普通保存返回 `EDITOR_FROZEN`。当前产品行为是续写内容流式写进编辑器、用户可继续操作。需要明确 UI 上的只读表现，否则用户会认为是卡死。

---

## 8. 跨层的硬性约束

### 性能预算（原设计完全缺失）

原设计的验收标准里没有任何性能指标，而它的读路径（每次读取前后全量哈希）和写路径（每张表的每次写入都触发全库导出 + `integrity_check`）都是需要先测才敢做的设计。以下为初始目标，L1 完成基准测试后校准，并纳入各层验收：

| 场景 | 基准项目 | 初始目标（p95） |
|---|---|---|
| 章节列表 / 侧栏读取 | 3,000 章 | < 150 ms |
| 编辑器自动保存端到端 | 同上 | < 300 ms |
| 全库候选发布（含校验） | 同上 | < 500 ms |
| checkpoint 完整事务 | 单章闭包 | < 1 s |

任一层若无法达标，先改设计再继续，不接受「先实现后优化」。

### 修复路径是每一层的交付物

原设计中 `RECOVERY_REQUIRED` 出现十余次，每次都是「保留现场并进入 `RECOVERY_REQUIRED`」，但从未定义谁来恢复、怎么恢复、用户看到什么。配合「所有读取都经过 `ensureReadableProjection()`」这一约束，用户命中该状态时连正文都读不出来。

约束：任何一层引入的每一个不可自动收敛的终态，都必须同时交付对应的用户可见状态、诊断包导出，以及在能证明安全时的恢复操作。没有出口的安全设计不算完成。

### 环境敏感项

- **云盘目录**：Windows 用户的「文档」目录常被 OneDrive 重定向，会命中 reparse point 拒绝；云盘同步 `.git` 本身也会损坏仓库。需要明确检测与引导，而不是一个错误码。
- **杀毒软件与索引器**：会持有文件句柄，导致原子替换返回 `EPERM`（已实测确认，见第 4 节）。需要有上限的重试与退避，以及明确的降级表述。
- **归档时的目录 rename**（若将来实现）：Windows 上对含有打开句柄的目录做 rename 存在共享冲突风险，须实验验证后再设计。

---

## 9. 与原设计的条目对照

**直接继承，实施时逐条引用**：§4.1 文件格式（除两处简化）、§4.2 Markdown 分级、§4.3 tombstone 与 DDL 规则、§4.4 顺序与活跃查询边界、§5.2 文件发布 journal、§5.4 GitService 与 checkpoint 事务全部、§7.1 DraftCoordinator、§7.2.6 提示词与 data-only 边界、§9 崩溃恢复规则、§10 非目标。

**因前提决策删除**：`sqlite_legacy` 及其全部配套（`LegacyControlStore`、`legacy_project_lease_key`、`legacy_asset_manifest`、legacy 归档恢复 journal、`legacy_sealing_lease`、`retiring → legacy_control_retired`）；`ProjectCreationJournal` 的 baseline commit 分支与 `creating`/`creation_failed`；repo staging 与无覆盖原子发布；§1 的零 UI 约束。

**简化**：`unassigned_chapter_uids` 重复真值源；`chapter_number` 进入权威文件；读路径的全量哈希 probe。

**推迟到 V1 之后**：§6.1 数据目录迁移边界的改造、§6.2 项目归档与恢复（含 `LifecycleGitFence`）、`data_root_maintenance_fence` 与 `lifecycle_routing_state`。这些与「让稿件有版本」无关，且是原设计里体量最大的部分之一。

**需补写**：写权限判定机制、轮次上限策略、性能预算、修复路径、故障注入框架、Windows 原语实现路径。

## 10. 开放问题

1. ~~L1 的 Windows 原语走原生插件还是接受弱保证？~~ 已由实测解决：走 `bun:ffi`，见第 4 节。剩余待定项是 server 测试切到 `bun test` 的隔离改造范围。
2. L2 的受控文件条目/体积上限按什么用户画像标定？
3. L4 的写权限交互形态需要单独的 UX 设计，是否与 L3 的版本 UI 一起出稿？
4. 项目归档与恢复推迟后，现有的项目删除行为在 L2 迁移后是否需要过渡处理？

## 11. 下一步

L1 的分阶段实施计划已写出：`docs/superpowers/plans/2026-08-06-l1-durability-foundation.md`。第 4 节的平台原语已完成验证，该计划按「测试隔离 + 切到 `bun test` → `platform/durability` 模块 → 故障注入框架 → `ControlStore` → `SqlJsAtomicStore` → writer lease → `ManuscriptService` 收口 → 诊断修复入口」的顺序展开，每一步含失败测试先行。L2 及之后的计划在 L1 稳定上线后再写。
